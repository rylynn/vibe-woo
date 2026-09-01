//! 用户行为习惯记忆。
//!
//! 三层结构：
//!   1. 观测：感知主循环每 120ms 累计当天的**行为事实**（各时段活跃秒数、
//!      各类应用时长、专注段、当天触发的提醒与速记条数），跨天落盘为
//!      按天 JSON，滚动保留 14 天。
//!   2. 归纳：`habitdrive` 每 12 小时把最近 7 天的事实交给 LLM，拿到结构化
//!      结论（作息规律 / 生活习惯 / 应用风格）写进缓存。
//!   3. 使用：缓存里的结论转成一段中文叙述，作为宠物说话的 prompt 物料。
//!
//! 与 `memory`（当日记忆）的分工：那个讲「今天」，跨天清零；这个讲
//! 「平时」，是长期慢变量 —— 所以必须落盘，也必须容忍数据稀疏。
//!
//! 隐私红线：这里只有时段、时长与应用**类别** —— 没有窗口标题、没有文件名、
//! 没有按键内容。提醒文本先截断再送出，结论只落本地，绝不参与任何上报。

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

use crate::state::{AppKind, Doing, PetState, Tempo};

/// 日志滚动保留天数。规律要跨周看，但不必留历史 —— 两周足够。
const KEEP_DAYS: usize = 14;
/// 每次分析取最近几天的日志。
///
/// 取满 14 天（与 `KEEP_DAYS` 一致）：作息规律要看两周才稳 —— 一周里只要
/// 有一天出差或休假，7 天窗口的「工作日规律」就会被拉偏。
pub const WINDOW_DAYS: usize = 14;
/// 少于这个天数就不分析 —— 一天的数据谈不上「规律」，硬归纳只会瞎编。
pub const MIN_DAYS: usize = 2;
/// 提醒内容送给 LLM 前的截断长度。
const REMINDER_CHARS: usize = 60;
/// 置信度低于此值不进 prompt —— 宁可不说，也别让宠物拿猜测当了解。
const MIN_CONFIDENCE: f32 = 0.3;
/// 自动落盘间隔。崩溃最多丢这几分钟，不必每轮都写。
const FLUSH_INTERVAL: Duration = Duration::from_secs(300);
/// 单次采样允许计入的最大秒数（休眠唤醒后的大跳变不算数）。
const MAX_SAMPLE_SECS: f64 = 60.0;

/// 单个字段的最大字符数：LLM 可能写出长篇大论，而它要进 system prompt。
const PATTERN_CHARS: usize = 60;
const HABIT_CHARS: usize = 30;
const TAG_CHARS: usize = 12;
const MAX_HABITS: usize = 5;
const MAX_TAGS: usize = 4;

static LOG_DIR: OnceLock<PathBuf> = OnceLock::new();
static CURRENT: Mutex<Option<DayStats>> = Mutex::new(None);
static INSIGHT: Mutex<Option<HabitInsight>> = Mutex::new(None);
static LAST_FLUSH: Mutex<Option<Instant>> = Mutex::new(None);

/// 各类应用的当日时长（秒）。字段与 `AppKind` 一一对应。
///
/// 用命名字段而非数组：落盘后是人能读懂的，也可能被拿去别处消费。
#[derive(Debug, Clone, Copy, Default, PartialEq, Serialize, Deserialize)]
pub struct KindSecs {
    pub editing: u32,
    pub writing: u32,
    pub designing: u32,
    pub data: u32,
    pub messaging: u32,
    pub browsing: u32,
    pub watching: u32,
    pub other: u32,
}

impl KindSecs {
    fn add(&mut self, k: AppKind, secs: u32) {
        let slot = match k {
            AppKind::Editing => &mut self.editing,
            AppKind::Writing => &mut self.writing,
            AppKind::Designing => &mut self.designing,
            AppKind::Data => &mut self.data,
            AppKind::Messaging => &mut self.messaging,
            AppKind::Browsing => &mut self.browsing,
            AppKind::Watching => &mut self.watching,
            AppKind::Other => &mut self.other,
        };
        *slot += secs;
    }
}

/// 一次触发的提醒。文本已截断 —— 提醒内容可能带隐私，只留够归纳习惯的长度。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ReminderHit {
    /// "HH:MM"。
    pub time: String,
    /// 截断到 `REMINDER_CHARS` 的提醒文本。
    pub text: String,
}

/// 某一天的行为事实。全部是可复算的**量**，不含任何判断。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DayStats {
    /// "YYYY-MM-DD"。
    pub date: String,
    /// 1=周一 … 7=周日。由日期算出，供 LLM 区分工作日与周末。
    pub weekday: u8,
    /// 专注产出类前台的累计秒数。
    pub work_secs: u32,
    /// 其中处于心流的秒数。
    pub flow_secs: u32,
    /// 各小时的活跃秒数（含摸鱼与沟通 —— 作息规律看的是「人在不在」）。
    pub hourly_secs: [u32; 24],
    /// 各类应用的累计秒数。
    pub kind_secs: KindSecs,
    /// 完成的专注段数。
    pub focus_runs: u32,
    /// 最长一段专注的秒数。
    pub longest_focus_secs: u32,
    /// 当天触发过的提醒。
    pub reminders_fired: Vec<ReminderHit>,
    /// 当天记的速记条数。
    pub note_count: u32,
    /// 当前这段连续专注已持续的秒数。仅内存用。
    #[serde(skip)]
    cur_run_secs: u32,
    /// 不足 1 秒的采样余量。120ms 一轮，直接取整会全丢。
    #[serde(skip)]
    frac: f64,
}

impl DayStats {
    fn new(date: &str) -> Self {
        Self {
            date: date.to_string(),
            weekday: weekday_of(date).unwrap_or(0),
            work_secs: 0,
            flow_secs: 0,
            hourly_secs: [0; 24],
            kind_secs: KindSecs::default(),
            focus_runs: 0,
            longest_focus_secs: 0,
            reminders_fired: Vec::new(),
            note_count: 0,
            cur_run_secs: 0,
            frac: 0.0,
        }
    }
}

/// LLM 归纳出的习惯结论。缓存下来，作为宠物说话的物料。
///
/// 全部字段 `#[serde(default)]`：模型漏字段、多字段、字段类型不对都不该
/// 让整份结论作废 —— 少一块料不影响说话。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct HabitInsight {
    /// 工作日作息规律。
    pub workday_pattern: String,
    /// 周末作息规律。
    pub weekend_pattern: String,
    /// 典型开始时间 "HH:MM"。
    pub typical_work_start: String,
    /// 典型结束时间 "HH:MM"。
    pub typical_work_end: String,
    /// 日均工作小时数。
    pub daily_work_hours: f32,
    /// 从提醒内容归纳的生活习惯短句。
    pub reminder_habits: Vec<String>,
    /// 应用使用风格。
    pub app_style: String,
    /// 风格标签。
    pub style_tags: Vec<String>,
    /// 数据充分度 0~1。低于 `MIN_CONFIDENCE` 不进 prompt。
    pub confidence: f32,
    /// 上次更新的日期 "YYYY-MM-DD"。
    pub updated_at: String,
}

impl Default for HabitInsight {
    fn default() -> Self {
        Self {
            workday_pattern: String::new(),
            weekend_pattern: String::new(),
            typical_work_start: String::new(),
            typical_work_end: String::new(),
            daily_work_hours: 0.0,
            reminder_habits: Vec::new(),
            app_style: String::new(),
            style_tags: Vec::new(),
            confidence: 0.0,
            updated_at: String::new(),
        }
    }
}

impl HabitInsight {
    /// 收敛到安全范围：模型可能写超长、写负数、把数组塞满。
    fn sanitize(&mut self) {
        self.workday_pattern = clip(&self.workday_pattern, PATTERN_CHARS);
        self.weekend_pattern = clip(&self.weekend_pattern, PATTERN_CHARS);
        self.app_style = clip(&self.app_style, PATTERN_CHARS);
        self.typical_work_start = clip(&self.typical_work_start, 5);
        self.typical_work_end = clip(&self.typical_work_end, 5);
        self.daily_work_hours = if self.daily_work_hours.is_finite() {
            self.daily_work_hours.clamp(0.0, 24.0)
        } else {
            0.0
        };
        self.confidence = if self.confidence.is_finite() {
            self.confidence.clamp(0.0, 1.0)
        } else {
            0.0
        };
        self.reminder_habits = clip_all(&self.reminder_habits, MAX_HABITS, HABIT_CHARS);
        self.style_tags = clip_all(&self.style_tags, MAX_TAGS, TAG_CHARS);
    }

    /// 喂给 system prompt 的叙述。置信度不足或空结论返回 None。
    ///
    /// 刻意只拼 LLM 写好的短句，不在这里再加工 —— 二次加工容易加工出
    /// 职业判断（「他是个程序员」），那是红线。
    pub fn narration(&self) -> Option<String> {
        if self.confidence < MIN_CONFIDENCE {
            return None;
        }
        let mut parts: Vec<String> = Vec::new();
        for s in [
            &self.workday_pattern,
            &self.weekend_pattern,
            &self.app_style,
        ] {
            if !s.trim().is_empty() {
                parts.push(s.trim().to_string());
            }
        }
        // 生活习惯最多带两条：物料是配菜，不是主体
        for h in self.reminder_habits.iter().take(2) {
            if !h.trim().is_empty() {
                parts.push(h.trim().to_string());
            }
        }
        if parts.is_empty() {
            return None;
        }
        Some(parts.join("；"))
    }
}

fn clip(s: &str, max: usize) -> String {
    s.trim().chars().take(max).collect()
}

fn clip_all(v: &[String], max_items: usize, max_chars: usize) -> Vec<String> {
    v.iter()
        .map(|s| clip(s, max_chars))
        .filter(|s| !s.is_empty())
        .take(max_items)
        .collect()
}

// ---------- 观测 ----------

/// 采样推进。dt 为距上次采样的秒数，date 为本地日期，hour 为本地小时。
///
/// 频率是 120ms 一轮 —— 这里只做几次整数加法，不做 IO（换天时才落盘）。
pub fn observe(s: &PetState, kind: AppKind, dt: f64, date: &str, hour: u8) {
    if date.is_empty() {
        return;
    }

    // 换天时把昨天那份取出来，出了锁再写盘
    let stale = {
        let Ok(mut g) = CURRENT.lock() else {
            return;
        };
        step(&mut g, s, kind, dt, date, hour)
    };

    let Some(dir) = LOG_DIR.get() else {
        return;
    };
    if let Some(old) = stale {
        write_day_in(dir, &old);
        prune_in(dir);
        return;
    }

    // 定时落盘：崩了也只丢几分钟
    let due = LAST_FLUSH
        .lock()
        .ok()
        .and_then(|g| g.map(|t| t.elapsed() >= FLUSH_INTERVAL))
        .unwrap_or(true);
    if due {
        if let Ok(mut f) = LAST_FLUSH.lock() {
            *f = Some(Instant::now());
        }
        flush();
    }
}

/// 一次采样的状态推进，纯内存操作。
///
/// 返回需要落盘的旧数据（仅换天时非 None）。单独抽出来是为了能在测试里
/// 直接喂一份本地状态 —— 静态量在并行测试里会互相踩。
fn step(
    cur: &mut Option<DayStats>,
    s: &PetState,
    kind: AppKind,
    dt: f64,
    date: &str,
    hour: u8,
) -> Option<DayStats> {
    match cur.as_mut() {
        Some(m) if m.date == date => {
            accumulate(m, s, kind, dt, hour);
            None
        }
        Some(m) => {
            let old = m.clone();
            *m = DayStats::new(date);
            Some(old)
        }
        None => {
            *cur = Some(DayStats::new(date));
            None
        }
    }
}

fn accumulate(m: &mut DayStats, s: &PetState, kind: AppKind, dt: f64, hour: u8) {
    if s.doing == Doing::Away {
        // 人不在：连续专注断掉，且不计时
        m.cur_run_secs = 0;
        return;
    }

    m.frac += dt.clamp(0.0, MAX_SAMPLE_SECS);
    if m.frac < 1.0 {
        return; // 攒够整秒再记，避免逐轮截断成 0
    }
    let secs = m.frac as u32;
    m.frac -= secs as f64;

    let h = (hour as usize).min(23);
    m.hourly_secs[h] += secs;
    m.kind_secs.add(kind, secs);

    if s.doing.is_producing() {
        m.work_secs += secs;
        if s.tempo == Tempo::Flow {
            m.flow_secs += secs;
        }
        m.cur_run_secs += secs;
        if m.cur_run_secs > m.longest_focus_secs {
            m.longest_focus_secs = m.cur_run_secs;
        }
    } else if m.cur_run_secs > 0 {
        // 一段专注结束了
        m.focus_runs += 1;
        m.cur_run_secs = 0;
    }
}

/// 一条速记落盘时调用。
pub fn note_added() {
    if let Ok(mut g) = CURRENT.lock() {
        if let Some(m) = g.as_mut() {
            bump_note(m);
        }
    }
}

fn bump_note(m: &mut DayStats) {
    m.note_count += 1;
}

/// 提醒触发时调用。文本在这里截断 —— 提醒内容可能含隐私，只留够归纳的片段。
pub fn reminder_fired(time: &str, text: &str) {
    if let Ok(mut g) = CURRENT.lock() {
        if let Some(m) = g.as_mut() {
            push_reminder(m, time, text);
        }
    }
}

fn push_reminder(m: &mut DayStats, time: &str, text: &str) {
    m.reminders_fired.push(ReminderHit {
        time: time.to_string(),
        text: text.chars().take(REMINDER_CHARS).collect(),
    });
}

/// 当前累计中的那一份（含今天未落盘的部分）。
pub fn today() -> Option<DayStats> {
    CURRENT.lock().ok().and_then(|g| g.clone())
}

// ---------- 持久化 ----------

/// 启动初始化：确定目录、载入今天的日志与已缓存的结论。
pub fn init(app: &tauri::AppHandle) {
    use tauri::Manager;
    let dir = app
        .path()
        .app_data_dir()
        .ok()
        .map(|d| d.join("habit_log"));
    let Some(dir) = dir else { return };
    let _ = LOG_DIR.set(dir);
    let Some(dir) = LOG_DIR.get() else { return };
    let _ = fs::create_dir_all(dir);

    if let Some(date) = local_date() {
        if let Some(day) = read_day_in(dir, &date) {
            if let Ok(mut g) = CURRENT.lock() {
                *g = Some(day);
            }
        }
    }
    if let Some(ins) = read_cache_in(cache_dir(dir)) {
        if let Ok(mut g) = INSIGHT.lock() {
            *g = Some(ins);
        }
    }
}

/// 把当前累计中的那天写盘（供分析前刷新与退出前兜底）。
pub fn flush() {
    let Some(dir) = LOG_DIR.get() else { return };
    if let Some(day) = today() {
        write_day_in(dir, &day);
        prune_in(dir);
    }
}

/// 取最近 n 天的日志，按日期升序。
pub fn load_days(n: usize) -> Vec<DayStats> {
    let Some(dir) = LOG_DIR.get() else {
        return Vec::new();
    };
    list_days_in(dir, n)
}

fn cache_dir(log_dir: &Path) -> PathBuf {
    // habit_log/ 的上一级就是应用数据目录
    match log_dir.parent() {
        Some(p) => p.join("habit_memory.json"),
        None => PathBuf::from("habit_memory.json"),
    }
}

fn day_path(dir: &Path, date: &str) -> PathBuf {
    dir.join(format!("{date}.json"))
}

fn write_day_in(dir: &Path, day: &DayStats) {
    if let Err(e) = fs::create_dir_all(dir) {
        eprintln!("[habit] 创建日志目录失败：{e}");
        return;
    }
    match serde_json::to_string_pretty(day) {
        Ok(text) => {
            if let Err(e) = fs::write(day_path(dir, &day.date), text) {
                eprintln!("[habit] 写入 {} 失败：{e}", day.date);
            }
        }
        Err(e) => eprintln!("[habit] 序列化 {} 失败：{e}", day.date),
    }
}

/// 读取某一天。文件损坏就删掉重建 —— 一份坏日志不该拖累整个功能。
fn read_day_in(dir: &Path, date: &str) -> Option<DayStats> {
    let path = day_path(dir, date);
    let text = fs::read_to_string(&path).ok()?;
    match serde_json::from_str::<DayStats>(&text) {
        Ok(d) => Some(d),
        Err(e) => {
            eprintln!("[habit] {} 日志损坏，已删除：{e}", date);
            let _ = fs::remove_file(&path);
            None
        }
    }
}

/// 滚动清理：只留最近 `KEEP_DAYS` 天。
fn prune_in(dir: &Path) {
    let Ok(rd) = fs::read_dir(dir) else { return };
    let mut names: Vec<String> = rd
        .filter_map(|e| e.ok())
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .filter(|n| n.len() == 15 && n.ends_with(".json"))
        .collect();
    names.sort();
    let excess = names.len().saturating_sub(KEEP_DAYS);
    for name in names.into_iter().take(excess) {
        let _ = fs::remove_file(dir.join(name));
    }
}

fn list_days_in(dir: &Path, n: usize) -> Vec<DayStats> {
    let Ok(rd) = fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut names: Vec<String> = rd
        .filter_map(|e| e.ok())
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .filter(|n| n.len() == 15 && n.ends_with(".json"))
        .collect();
    names.sort();
    let start = names.len().saturating_sub(n);
    names
        .into_iter()
        .skip(start)
        .filter_map(|n| read_day_in(dir, &n[..10]))
        .collect()
}

fn write_cache_in(path: &Path, ins: &HabitInsight) {
    if let Some(p) = path.parent() {
        let _ = fs::create_dir_all(p);
    }
    match serde_json::to_string_pretty(ins) {
        Ok(text) => {
            if let Err(e) = fs::write(path, text) {
                eprintln!("[habit] 写入结论缓存失败：{e}");
            }
        }
        Err(e) => eprintln!("[habit] 序列化结论失败：{e}"),
    }
}

fn read_cache_in(path: PathBuf) -> Option<HabitInsight> {
    let text = fs::read_to_string(&path).ok()?;
    serde_json::from_str::<HabitInsight>(&text).ok()
}

// ---------- 结论 ----------

/// 供 prompt 使用的习惯叙述。无结论或置信度不足时返回 None。
pub fn summary() -> Option<String> {
    INSIGHT.lock().ok().and_then(|g| {
        let it = g.as_ref()?;
        it.narration()
    })
}

/// 更新结论：进内存 + 落盘。
pub fn save_insight(ins: &HabitInsight) {
    if let Ok(mut g) = INSIGHT.lock() {
        *g = Some(ins.clone());
    }
    if let Some(dir) = LOG_DIR.get() {
        write_cache_in(&cache_dir(dir), ins);
    }
}

/// 解析 LLM 输出。非 JSON 返回 None —— 调用方据此保留旧结论。
pub fn parse_insight(raw: &str) -> Option<HabitInsight> {
    // 模型偶尔会在 JSON 外面裹一层代码块，剥掉
    let s = raw.trim();
    let s = s
        .strip_prefix("```json")
        .or_else(|| s.strip_prefix("```"))
        .unwrap_or(s);
    let s = s.strip_suffix("```").unwrap_or(s).trim();
    let mut ins: HabitInsight = serde_json::from_str(s).ok()?;
    ins.sanitize();
    Some(ins)
}

/// 组装送给 LLM 的分析输入。
///
/// 直接把结构化事实序列化成 JSON：不手写排版，也就没有手写出隐私的余地。
pub fn prompt_input(days: &[DayStats]) -> String {
    let json = serde_json::to_string_pretty(days).unwrap_or_default();
    format!(
        "以下是最近 {} 天的电脑使用统计（只有日期、星期、各时段活跃秒数、\
         应用类别时长、专注段与当天触发的提醒；不含任何窗口标题、文件名与输入内容）：\n\n\
         {}\n\n请归纳并只输出要求的 JSON。",
        days.len(),
        json
    )
}

// ---------- 工具 ----------

fn local_date() -> Option<String> {
    crate::reminddrive::local_now().map(|c| c.date)
}

/// "YYYY-MM-DD" → 周几（1=周一 … 7=周日）。纯函数，非法输入返回 None。
pub fn weekday_of(date: &str) -> Option<u8> {
    let b = date.as_bytes();
    if b.len() != 10 || b[4] != b'-' || b[7] != b'-' {
        return None;
    }
    let y: i64 = date[0..4].parse().ok()?;
    let m: u32 = date[5..7].parse().ok()?;
    let d: u32 = date[8..10].parse().ok()?;
    if !(1..=12).contains(&m) || !(1..=31).contains(&d) {
        return None;
    }
    // 1970-01-01（第 0 天）是周四 → (days + 3) % 7 + 1
    let days = days_from_civil(y, m, d);
    Some(((days.rem_euclid(7) + 3) % 7 + 1) as u8)
}

/// 把公历日期转成距 1970-01-01 的天数（Howard Hinnant 的算法）。
fn days_from_civil(y: i64, m: u32, d: u32) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let mp = if m > 2 { m as i64 - 3 } else { m as i64 + 9 };
    let doy = (153 * mp + 2) / 5 + d as i64 - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146097 + doe - 719468
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::activity::Activity;
    use crate::mood::Mood;

    fn st(doing: Doing, tempo: Tempo) -> PetState {
        PetState {
            doing,
            tempo,
            late_night: false,
            keystrokes_per_min: 0.0,
            mood: Mood::Focused,
            activity: Activity::Working,
            dnd_on: false,
        }
    }

    fn tmp(name: &str) -> PathBuf {
        let p = std::env::temp_dir().join(format!("habit-{}-{}", std::process::id(), name));
        let _ = fs::remove_dir_all(&p);
        fs::create_dir_all(&p).unwrap();
        p
    }

    fn day(date: &str) -> DayStats {
        DayStats::new(date)
    }

    // —— 观测 ——

    #[test]
    fn 累计工作时长与时段的直方图() {
        let m = &mut day("2026-09-01");
        accumulate(m, &st(Doing::Editing, Tempo::Flow), AppKind::Editing, 1.0, 9);
        accumulate(m, &st(Doing::Editing, Tempo::Flow), AppKind::Editing, 1.0, 9);
        accumulate(m, &st(Doing::Browsing, Tempo::Normal), AppKind::Browsing, 1.0, 9);
        assert_eq!(m.work_secs, 2);
        assert_eq!(m.flow_secs, 2);
        assert_eq!(m.hourly_secs[9], 3);
        assert_eq!(m.kind_secs.editing, 2);
        assert_eq!(m.kind_secs.browsing, 1);
    }

    #[test]
    fn 不足一秒的采样攒够才计入() {
        // 120ms 一轮：直接取整会全部丢成 0
        let m = &mut day("2026-09-01");
        for _ in 0..8 {
            accumulate(m, &st(Doing::Editing, Tempo::Normal), AppKind::Editing, 0.12, 9);
        }
        assert_eq!(m.work_secs, 0, "不到 1 秒不该计");
        accumulate(m, &st(Doing::Editing, Tempo::Normal), AppKind::Editing, 0.12, 9);
        assert_eq!(m.work_secs, 1);
    }

    #[test]
    fn 休眠唤醒的大跳变被钳住() {
        let m = &mut day("2026-09-01");
        accumulate(m, &st(Doing::Editing, Tempo::Normal), AppKind::Editing, 3600.0, 9);
        assert_eq!(m.work_secs, MAX_SAMPLE_SECS as u32);
    }

    #[test]
    fn 人不在时不计时且打断连续专注() {
        let m = &mut day("2026-09-01");
        accumulate(m, &st(Doing::Editing, Tempo::Normal), AppKind::Editing, 600.0, 9);
        assert_eq!(m.work_secs, 60);
        assert_eq!(m.cur_run_secs, 60);
        accumulate(m, &st(Doing::Away, Tempo::Resting), AppKind::Other, 1.0, 9);
        assert_eq!(m.cur_run_secs, 0);
        assert_eq!(m.hourly_secs[9], 60, "离开的秒数不该计入活跃时段");
    }

    #[test]
    fn 专注段数与最长段() {
        let m = &mut day("2026-09-01");
        accumulate(m, &st(Doing::Editing, Tempo::Normal), AppKind::Editing, 100.0, 9);
        accumulate(m, &st(Doing::Messaging, Tempo::Normal), AppKind::Messaging, 10.0, 9);
        accumulate(m, &st(Doing::Writing, Tempo::Normal), AppKind::Writing, 30.0, 9);
        assert_eq!(m.focus_runs, 1, "只完成了一段");
        assert_eq!(m.longest_focus_secs, 60, "单段被 MAX_SAMPLE_SECS 钳住");
    }

    #[test]
    fn 提醒文本截断后才入库() {
        let m = &mut day("2026-09-01");
        push_reminder(m, "09:00", &"长".repeat(200));
        assert_eq!(m.reminders_fired.len(), 1);
        assert_eq!(m.reminders_fired[0].text.chars().count(), REMINDER_CHARS);
        assert_eq!(m.reminders_fired[0].time, "09:00");
    }

    #[test]
    fn 速记条数累加() {
        let m = &mut day("2026-09-01");
        bump_note(m);
        bump_note(m);
        assert_eq!(m.note_count, 2);
    }

    #[test]
    fn 换天时交出旧数据且内存换新() {
        let mut cur: Option<DayStats> = Some(day("2026-09-01"));
        assert!(step(
            &mut cur,
            &st(Doing::Editing, Tempo::Normal),
            AppKind::Editing,
            10.0,
            "2026-09-01",
            9
        )
        .is_none());
        assert_eq!(cur.as_ref().unwrap().work_secs, 10);

        // 换天：交出昨天那份，内存里已经是新的一天
        let stale = step(
            &mut cur,
            &st(Doing::Editing, Tempo::Normal),
            AppKind::Editing,
            5.0,
            "2026-09-02",
            9,
        )
        .expect("换天应交出旧数据");
        assert_eq!(stale.date, "2026-09-01");
        assert_eq!(stale.work_secs, 10);
        assert_eq!(cur.as_ref().unwrap().date, "2026-09-02");
        assert_eq!(cur.as_ref().unwrap().work_secs, 0, "新的一天从零开始");
    }

    #[test]
    fn 首次采样自动建立当天记录() {
        let mut cur: Option<DayStats> = None;
        assert!(step(
            &mut cur,
            &st(Doing::Editing, Tempo::Normal),
            AppKind::Editing,
            1.0,
            "2026-09-01",
            9
        )
        .is_none());
        let m = cur.expect("应已建立");
        assert_eq!(m.date, "2026-09-01");
        assert_eq!(m.weekday, 2);
    }

    #[test]
    fn 交出的旧数据能被写盘读回() {
        let dir = tmp("rollover");
        let mut cur: Option<DayStats> = Some(day("2026-09-01"));
        step(
            &mut cur,
            &st(Doing::Editing, Tempo::Normal),
            AppKind::Editing,
            10.0,
            "2026-09-01",
            9,
        );
        let stale = step(
            &mut cur,
            &st(Doing::Editing, Tempo::Normal),
            AppKind::Editing,
            1.0,
            "2026-09-02",
            9,
        )
        .unwrap();
        write_day_in(&dir, &stale);
        assert_eq!(read_day_in(&dir, "2026-09-01").unwrap().work_secs, 10);
    }

    // —— 持久化 ——

    #[test]
    fn 写入与读回往返() {
        let dir = tmp("roundtrip");
        let mut m = day("2026-09-01");
        accumulate(&mut m, &st(Doing::Editing, Tempo::Flow), AppKind::Editing, 120.0, 14);
        m.note_count = 3;
        write_day_in(&dir, &m);
        let back = read_day_in(&dir, "2026-09-01").unwrap();
        // cur_run_secs / frac 是内存态，不落盘（落了也没意义：重启后不算连续）
        m.cur_run_secs = 0;
        assert_eq!(back, m);
        assert_eq!(back.weekday, 2, "2026-09-01 是周二");
    }

    #[test]
    fn 损坏的日志被删除且返回空() {
        let dir = tmp("corrupt");
        fs::write(day_path(&dir, "2026-09-01"), "{ 不是 JSON").unwrap();
        assert!(read_day_in(&dir, "2026-09-01").is_none());
        assert!(!day_path(&dir, "2026-09-01").exists(), "坏文件应被清掉");
    }

    #[test]
    fn 只保留最近十四天() {
        let dir = tmp("prune");
        for d in 1..=20u32 {
            write_day_in(&dir, &day(&format!("2026-09-{d:02}")));
        }
        prune_in(&dir);
        let left: Vec<String> = fs::read_dir(&dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(left.len(), KEEP_DAYS);
        assert!(!day_path(&dir, "2026-09-01").exists(), "最早的应被清掉");
        assert!(day_path(&dir, "2026-09-20").exists());
    }

    #[test]
    fn 分析窗口不超过保留天数() {
        // 取比留存还多的天数是自相矛盾的：读到的永远是 KEEP_DAYS 天
        assert!(
            WINDOW_DAYS <= KEEP_DAYS,
            "窗口 {WINDOW_DAYS} 天超过了留存 {KEEP_DAYS} 天"
        );
    }

    #[test]
    fn 取最近若干天按日期升序() {
        let dir = tmp("window");
        for d in 1..=10u32 {
            write_day_in(&dir, &day(&format!("2026-09-{d:02}")));
        }
        let days = list_days_in(&dir, 7);
        assert_eq!(days.len(), 7);
        assert_eq!(days[0].date, "2026-09-04");
        assert_eq!(days[6].date, "2026-09-10");
    }

    #[test]
    fn 结论缓存读写往返() {
        let dir = tmp("cache");
        let ins = HabitInsight {
            workday_pattern: "工作日9点开忙".into(),
            confidence: 0.7,
            ..Default::default()
        };
        write_cache_in(&cache_dir(&dir), &ins);
        assert_eq!(read_cache_in(cache_dir(&dir)), Some(ins));
    }

    // —— 结论解析 ——

    #[test]
    fn 解析完整的JSON结论() {
        let raw = r#"{"workday_pattern":"工作日约9:30开忙","weekend_pattern":"周末基本不工作",
            "typical_work_start":"09:30","typical_work_end":"18:00","daily_work_hours":6.5,
            "reminder_habits":["周三下午固定复盘"],"app_style":"以编辑器为主",
            "style_tags":["深度工作","工具重度"],"confidence":0.8,"updated_at":"2026-09-01"}"#;
        let ins = parse_insight(raw).unwrap();
        assert_eq!(ins.daily_work_hours, 6.5);
        assert_eq!(ins.confidence, 0.8);
        assert_eq!(ins.style_tags.len(), 2);
    }

    #[test]
    fn 非JSON返回空以保留旧结论() {
        assert!(parse_insight("我觉得这个人很努力。").is_none());
    }

    #[test]
    fn 代码块包裹的JSON也能解析() {
        let raw = "```json\n{\"confidence\":0.5,\"app_style\":\"爱用浏览器\"}\n```";
        assert_eq!(parse_insight(raw).unwrap().app_style, "爱用浏览器");
    }

    #[test]
    fn 缺字段用默认值兜底() {
        let ins = parse_insight(r#"{"workday_pattern":"早睡早起"}"#).unwrap();
        assert_eq!(ins.workday_pattern, "早睡早起");
        assert_eq!(ins.confidence, 0.0);
        assert!(ins.reminder_habits.is_empty());
    }

    #[test]
    fn 超长与越界字段被收敛() {
        let raw = format!(
            r#"{{"workday_pattern":"{}","daily_work_hours":99,"confidence":9,
               "reminder_habits":["{}","{}","{}","{}","{}","{}"],
               "style_tags":["{}","{}","{}","{}","{}"]}}"#,
            "长".repeat(200),
            "一",
            "二",
            "三",
            "四",
            "五",
            "六",
            "标签".repeat(50),
            "b",
            "c",
            "d",
            "e",
        );
        let ins = parse_insight(&raw).unwrap();
        assert_eq!(ins.workday_pattern.chars().count(), PATTERN_CHARS);
        assert_eq!(ins.daily_work_hours, 24.0);
        assert_eq!(ins.confidence, 1.0);
        assert_eq!(ins.reminder_habits.len(), MAX_HABITS);
        assert_eq!(ins.style_tags.len(), MAX_TAGS);
        assert_eq!(ins.style_tags[0].chars().count(), TAG_CHARS);
    }

    #[test]
    fn 置信度不足不进prompt() {
        let ins = HabitInsight {
            workday_pattern: "工作日很规律".into(),
            confidence: 0.2,
            ..Default::default()
        };
        assert!(ins.narration().is_none());
    }

    #[test]
    fn 叙述拼接非空字段() {
        let ins = HabitInsight {
            workday_pattern: "工作日9点开忙".into(),
            weekend_pattern: "周末基本不工作".into(),
            app_style: "以编辑器为主".into(),
            reminder_habits: vec!["周三下午复盘".into(), "每天喝水提醒".into()],
            confidence: 0.8,
            ..Default::default()
        };
        let s = ins.narration().unwrap();
        assert!(s.contains("工作日9点开忙"));
        assert!(s.contains("周末基本不工作"));
        assert!(s.contains("以编辑器为主"));
        assert!(s.contains("周三下午复盘"));
    }

    #[test]
    fn 空结论没有叙述() {
        assert!(HabitInsight::default().narration().is_none());
    }

    #[test]
    fn 分析输入不含任何敏感内容() {
        // 红线：外发的只有时段、时长、类别与截断后的提醒文本
        let m = &mut day("2026-09-01");
        accumulate(m, &st(Doing::Editing, Tempo::Flow), AppKind::Editing, 60.0, 14);
        m.reminders_fired.push(ReminderHit {
            time: "15:00".into(),
            text: "复盘".into(),
        });
        let input = prompt_input(std::slice::from_ref(m));

        for bad in ["com.", "bundle", "/Users", "http", "@"] {
            assert!(!input.contains(bad), "分析输入出现了敏感内容：{bad}");
        }
        // 字段白名单之外的键不该出现
        let v: serde_json::Value = serde_json::to_value(&*m).unwrap();
        let keys: Vec<&str> = v.as_object().unwrap().keys().map(|k| k.as_str()).collect();
        for k in keys {
            assert!(
                [
                    "date",
                    "weekday",
                    "work_secs",
                    "flow_secs",
                    "hourly_secs",
                    "kind_secs",
                    "focus_runs",
                    "longest_focus_secs",
                    "reminders_fired",
                    "note_count",
                ]
                .contains(&k),
                "出现了白名单外的字段：{k}"
            );
        }
    }

    // —— 日期 ——

    #[test]
    fn 日期换算周几() {
        assert_eq!(weekday_of("2026-09-01"), Some(2), "周二");
        assert_eq!(weekday_of("2026-09-06"), Some(7), "周日");
        assert_eq!(weekday_of("1970-01-01"), Some(4), "周四");
    }

    #[test]
    fn 非法日期不崩() {
        assert!(weekday_of("").is_none());
        assert!(weekday_of("2026-9-1").is_none());
        assert!(weekday_of("abcd-ef-gh").is_none());
        assert!(weekday_of("2026-13-01").is_none());
    }
}
