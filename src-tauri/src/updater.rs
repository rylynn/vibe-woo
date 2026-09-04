//! 自动更新：独立后台线程，24 小时一查，下载后等用户休息再装。
//!
//! 设计（docs/superpowers/specs/2026-09-03-auto-update-words-srs-panel-chrome-design.md F1）：
//! - 独立线程而非插件系统第五插件：更新是系统能力不是桌宠行为；
//! - 匿名 GET GitHub Releases，不上传任何用户数据，设置可关；
//! - 安装时机只认一个判据：键盘节奏 Resting 且不在番茄工作期 ——
//!   更新桌宠不值得打断工作；
//! - 仓库私有期间匿名 GET 得 404，走静默失败路径；转公开后自动生效。

/// 版本摘要表，编译进二进制：离线可用，检查更新时不额外发请求。
pub const VERSION_NOTES: &str = include_str!("../version-notes.json");

/// 更新摘要的硬性字数上限（用户需求：50 字以内）。
const NOTE_MAX_CHARS: usize = 50;

/// 升级后要不要说一句（纯函数）。
///
/// 返回气泡文案当且仅当：上次运行版本非空（首次安装不打扰）、
/// 与当前版本不同、且当前版本有非空摘要。回写由调用方负责，只此一次。
pub fn should_show_note(current: &str, last_run: &str, notes: &str) -> Option<String> {
    if last_run.is_empty() || current == last_run {
        return None;
    }
    let note = note_for(notes, current)?;
    Some(format!("我升级到 {current} 啦：{note}"))
}

/// 从摘要表 JSON 里取指定版本的摘要（空串视为没有）。
fn note_for(notes: &str, version: &str) -> Option<String> {
    let map: std::collections::BTreeMap<String, String> = serde_json::from_str(notes).ok()?;
    let n = map.get(version)?.trim().to_string();
    if n.is_empty() { None } else { Some(n) }
}

/// 摘要是否超字数（release.sh 在 bash 侧做同一校验，这里供单测兜底）。
pub fn note_too_long(note: &str) -> bool {
    note.chars().count() > NOTE_MAX_CHARS
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOTES: &str = r#"{"0.4.1":"词卡复习兜底与资讯跳转优化","0.5.0":"番茄钟休息验证上线；词卡例句配中文翻译"}"#;

    #[test]
    fn 升级且有摘要时给出气泡文案() {
        let s = should_show_note("0.5.0", "0.4.1", NOTES).unwrap();
        assert_eq!(s, "我升级到 0.5.0 啦：番茄钟休息验证上线；词卡例句配中文翻译");
    }

    #[test]
    fn 首次安装不说_空last_run() {
        assert_eq!(should_show_note("0.5.0", "", NOTES), None);
    }

    #[test]
    fn 版本未变不说() {
        assert_eq!(should_show_note("0.5.0", "0.5.0", NOTES), None);
    }

    #[test]
    fn 当前版本没有摘要则静默() {
        assert_eq!(should_show_note("0.9.9", "0.4.1", NOTES), None);
    }

    #[test]
    fn 编译进二进制的摘要表全部合规() {
        let map: std::collections::BTreeMap<String, String> =
            serde_json::from_str(VERSION_NOTES).unwrap();
        assert!(!map.is_empty(), "摘要表不该为空");
        for (v, n) in &map {
            assert!(!n.trim().is_empty(), "{v} 摘要为空串");
            assert!(!note_too_long(n), "{v} 摘要超 50 字：{n}");
        }
    }

    #[test]
    fn 字数按字符计() {
        assert!(!note_too_long("一二三四五"));
        assert!(note_too_long(&"字".repeat(51)));
    }
}
