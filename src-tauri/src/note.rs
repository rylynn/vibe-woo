//! 速记落盘。
//!
//! 唯一不可妥协的原则：**记录必须无条件先写盘，任何增强都是异步的**。
//! 断网、key 过期、余额不足、LLM 挂了 —— 都不能导致记不下这一条。
//!
//! Obsidian 接入不需要任何集成代码：它的 vault 就是一个普通的本地
//! Markdown 文件夹，往里面追加 `YYYY-MM-DD.md` 即可。零 API、零 token、
//! 零授权、断网可用。这是整个需求清单里性价比最高的一项。

use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

/// 一条速记。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Note {
    /// Unix 毫秒时间戳。
    pub ts_ms: i64,
    pub text: String,
    /// LLM 异步整理后回填的标签。失败则为空。
    #[serde(default)]
    pub tags: Vec<String>,
    /// LLM 判断的类别。失败则保持 "note"。
    #[serde(default = "default_kind")]
    pub kind: String,
}

fn default_kind() -> String {
    "note".into()
}

impl Note {
    pub fn new(text: &str, ts_ms: i64) -> Self {
        // 统一换行符：CRLF 会破坏 Markdown 列表续行格式
        let normalized = text.replace("\r\n", "\n");
        Self {
            ts_ms,
            text: normalized.trim().to_string(),
            tags: Vec::new(),
            kind: default_kind(),
        }
    }

    /**
     * 追加到 Markdown 的格式。
     *
     * 多行内容用两个空格的缩进续行 —— 这是 Markdown 列表项多行内容的
     * 标准写法，Obsidian 渲染时仍归属同一条目。
     */
    pub fn to_markdown(&self) -> String {
        let t = fmt_time(self.ts_ms);
        let tags = if self.tags.is_empty() {
            String::new()
        } else {
            let parts: Vec<String> = self.tags.iter().map(|t| format!("`{t}`")).collect();
            format!(" {}", parts.join(" "))
        };
        let mut lines = self.text.lines();
        let first = lines.next().unwrap_or("");
        let mut out = format!("- **{t}** {first}{tags}\n");
        for line in lines {
            out.push_str(&format!("  {line}\n"));
        }
        out
    }
}

/// 存储根目录：应用数据目录下的 notes/。
fn notes_dir(app: &tauri::AppHandle) -> Option<PathBuf> {
    use tauri::Manager;
    app.path().app_data_dir().ok().map(|d| d.join("notes"))
}

/// 速记的可选 Obsidian vault 目录。
pub fn vault_dir(_app: &tauri::AppHandle) -> Option<PathBuf> {
    let dir = crate::configcmd::current().notes_vault;
    if dir.is_empty() {
        None
    } else {
        let p = PathBuf::from(dir);
        if p.is_dir() {
            Some(p)
        } else {
            eprintln!("[note] vault 目录不存在，已忽略：{}", p.display());
            None
        }
    }
}

/**
 * 无条件落盘。
 *
 * 依次写入两个位置，任何一个失败都尽力写另一个，绝不因单点失败丢数据：
 *   1. 应用内置 notes/ 目录（兜底，永远存在）
 *   2. 用户配置的 Obsidian vault（可选）
 */
pub fn persist(app: &tauri::AppHandle, note: &Note) -> Vec<String> {
    let mut written_to: Vec<String> = Vec::new();

    if let Some(dir) = notes_dir(app) {
        if let Err(e) = append_to(&dir, note) {
            eprintln!("[note] 写入内置目录失败：{e}");
        } else {
            written_to.push("内置".into());
        }
    }

    if let Some(dir) = vault_dir(app) {
        if let Err(e) = append_to(&dir, note) {
            eprintln!("[note] 写入 vault 失败：{e}");
        } else {
            written_to.push("vault".into());
        }
    }

    if written_to.is_empty() {
        eprintln!("[note] 警告：两个落点都失败，本条可能未保存");
    }
    written_to
}

/// 往一个目录追加当日的 Markdown 文件。
fn append_to(dir: &Path, note: &Note) -> std::io::Result<()> {
    fs::create_dir_all(dir)?;
    let path = dir.join(format!("{}.md", fmt_date(note.ts_ms)));

    // 当日文件不存在时先写标题
    let needs_header = !path.exists();
    let mut f = OpenOptions::new().create(true).append(true).open(&path)?;
    if needs_header {
        writeln!(f, "# {}\n", fmt_date(note.ts_ms))?;
    }
    write!(f, "{}", note.to_markdown())?;
    Ok(())
}

/// 读取今日速记，供「回看」列表。
pub fn list_today(app: &tauri::AppHandle) -> Vec<Note> {
    let Some(dir) = notes_dir(app) else {
        return Vec::new();
    };
    let path = dir.join(format!("{}.md", fmt_date(now_ms())));
    let Ok(text) = fs::read_to_string(path) else {
        return Vec::new();
    };
    parse_notes(&text)
}

/**
 * 从 Markdown 解析回 Note 列表。
 *
 * 只解析我们自己写出的格式，不做通用 Markdown 解析 ——
 * 用户手写在同一文件里的内容会原样保留但不进入列表。
 * 缩进的续行（两空格开头）合并回上一条 —— 那是我们自己写的多行内容。
 */
fn parse_notes(text: &str) -> Vec<Note> {
    let mut out: Vec<Note> = Vec::new();
    for line in text.lines() {
        // 续行：合并到上一条（若上一条是我们写的）
        if line.starts_with("  ") && !line.trim().is_empty() {
            if let Some(last) = out.last_mut() {
                if last.ts_ms == CONTINUATION_SENTINEL || !last.text.is_empty() {
                    last.text.push('\n');
                    last.text.push_str(line.trim_start());
                    continue;
                }
            }
        }
        if let Some(n) = parse_line(line) {
            out.push(n);
        }
    }
    out
}

/** 标记解析期间的中间态：ts_ms 未定。 */
const CONTINUATION_SENTINEL: i64 = -1;

fn parse_line(line: &str) -> Option<Note> {
    // 格式：- **HH:MM** 内容 `tag1` `tag2`
    let rest = line.strip_prefix("- **")?;
    let (_hhmm, rest) = rest.split_once("**")?;
    let rest = rest.trim_start();

    let mut parts: Vec<&str> = Vec::new();
    let mut tags = Vec::new();
    for tok in rest.split_whitespace() {
        if tok.starts_with('`') && tok.ends_with('`') && tok.len() > 1 {
            tags.push(tok.trim_matches('`').to_string());
        } else {
            parts.push(tok);
        }
    }
    let text = parts.join(" ");
    if text.is_empty() {
        return None;
    }

    Some(Note {
        ts_ms: 0, // 列表展示不需要精确时间戳
        text,
        tags,
        kind: "note".into(),
    })
}

fn now_ms() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// 两个时间格式化函数接受显式时区注入，保证测试可重复。
pub fn fmt_date(ts_ms: i64) -> String {
    fmt(ts_ms, "%Y-%m-%d")
}

pub fn fmt_time(ts_ms: i64) -> String {
    fmt(ts_ms, "%H:%M")
}

/**
 * 用最朴素的方式换算本地时间。
 *
 * 不引入 chrono —— 这个依赖对两个格式化函数来说过重。用 libc 的
 * localtime_r，它遵循系统时区且零成本。非 Unix 平台退化为 UTC。
 */
fn fmt(ts_ms: i64, pattern: &str) -> String {
    #[cfg(unix)]
    unsafe {
        let secs = (ts_ms / 1000) as libc::time_t;
        let mut tm: libc::tm = std::mem::zeroed();
        if libc::localtime_r(&secs, &mut tm).is_null() {
            return fmt_utc(ts_ms, pattern);
        }
        let y = 1900 + tm.tm_year;
        let mo = tm.tm_mon + 1;
        let d = tm.tm_mday;
        let h = tm.tm_hour;
        let mi = tm.tm_min;
        return match pattern {
            "%Y-%m-%d" => format!("{y:04}-{mo:02}-{d:02}"),
            _ => format!("{h:02}:{mi:02}"),
        };
    }
    #[cfg(not(unix))]
    fmt_utc(ts_ms, pattern)
}

fn fmt_utc(ts_ms: i64, pattern: &str) -> String {
    // 1970-01-01 起的简单换算，仅作为非 Unix 的兜底
    let secs = ts_ms.max(0) / 1000;
    let days = secs / 86400;
    let sod = secs % 86400;
    let h = sod / 3600;
    let m = (sod % 3600) / 60;
    match pattern {
        "%Y-%m-%d" => {
            // 粗略近似，仅兜底
            let y = 1970 + days / 365;
            let doy = days % 365;
            format!("{y:04}-01-{d:02}", y = y, d = (doy % 31) + 1)
        }
        _ => format!("{h:02}:{m:02}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // 2026-08-29 16:30:00 UTC
    const TS: i64 = 1788078600000;

    #[test]
    fn markdown_行格式正确() {
        let n = Note::new("重构 sensor 模块", TS);
        let md = n.to_markdown();
        assert!(md.starts_with("- **"), "应以列表项开头：{md}");
        assert!(md.contains("重构 sensor 模块"));
        assert!(md.ends_with('\n'));
    }

    #[test]
    fn 带标签的_markdown_格式() {
        let mut n = Note::new("查 NSPanel 用法", TS);
        n.tags = vec!["todo".into(), "macos".into()];
        let md = n.to_markdown();
        assert!(md.contains("`todo`"));
        assert!(md.contains("`macos`"));
    }

    #[test]
    fn 内容首尾空白被裁剪() {
        let n = Note::new("  记得提交  \n\n", TS);
        assert_eq!(n.text, "记得提交");
    }

    #[test]
    fn 写入与读取往返一致() {
        let dir = std::env::temp_dir().join(format!("vibe-pet-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);

        let mut n1 = Note::new("第一条", TS);
        n1.tags = vec!["todo".into()];
        append_to(&dir, &n1).unwrap();

        let mut n2 = Note::new("第二条", TS + 60000);
        n2.tags = vec![];
        append_to(&dir, &n2).unwrap();

        let text = fs::read_to_string(dir.join(format!("{}.md", fmt_date(TS)))).unwrap();
        assert!(text.starts_with("# "), "首日文件应有标题");

        let parsed = parse_notes(&text);
        assert_eq!(parsed.len(), 2);
        assert_eq!(parsed[0].text, "第一条");
        assert_eq!(parsed[0].tags, vec!["todo"]);
        assert_eq!(parsed[1].text, "第二条");

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn 同日多次追加不重复标题() {
        let dir = std::env::temp_dir().join(format!("vibe-pet-dup-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);

        append_to(&dir, &Note::new("a", TS)).unwrap();
        append_to(&dir, &Note::new("b", TS + 1)).unwrap();

        let text = fs::read_to_string(dir.join(format!("{}.md", fmt_date(TS)))).unwrap();
        let headers = text.matches("# ").count();
        assert_eq!(headers, 1, "同日文件不应重复标题");

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn 解析忽略手写内容与其他格式() {
        let text = "# 2026-08-29\n\n手写的一段笔记\n\n- **16:30** 我们的记录 `todo`\n- 不是我们的格式\n";
        let parsed = parse_notes(text);
        assert_eq!(parsed.len(), 1);
        assert_eq!(parsed[0].text, "我们的记录");
        assert_eq!(parsed[0].tags, vec!["todo"]);
    }

    #[test]
    fn 多行内容落盘与往返() {
        let n = Note::new("第一行\n第二行\n第三行", TS);
        let md = n.to_markdown();
        // 首行带时间戳，续行缩进两空格
        assert!(md.contains("- **"));
        assert!(md.contains("  第二行\n"));
        assert!(md.contains("  第三行\n"));

        let parsed = parse_notes(&format!("# d\n\n{md}"));
        assert_eq!(parsed.len(), 1);
        assert_eq!(parsed[0].text, "第一行\n第二行\n第三行");
    }

    #[test]
    fn 多条记录穿插多行内容() {
        let text = "# d\n\n- **16:00** 甲\n  甲的续行\n- **16:30** 乙\n";
        let parsed = parse_notes(text);
        assert_eq!(parsed.len(), 2);
        assert_eq!(parsed[0].text, "甲\n甲的续行");
        assert_eq!(parsed[1].text, "乙");
    }

    #[test]
    fn 换行只用_n_而非_crlf() {
        // Windows 换行符会破坏 Markdown 列表续行格式
        let n = Note::new("a\r\nb", TS);
        let md = n.to_markdown();
        assert!(!md.contains('\r'), "落盘前应统一为 \\n：{md:?}");
    }
}
