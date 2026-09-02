//! 当日 / 本周统计与成长值持久化（2026-08-31 设计 P2 / 第 7-8 节）。
//!
//! 成长值是 Deep 判定的常规出口（无穷尽，只加不减）—— 不依赖当日特效
//! 池的天花板。本周活跃天数用**加分制而非清零制**：断一天不归零
//!（设计 7.3 明确不做 streak）。

use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;

use tauri::{AppHandle, Manager};

use crate::focus::Grade;

/// 番茄完成（Normal）的成长值。
const BOND_NORMAL: u32 = 3;

/// 番茄完成（Deep）的成长值。
const BOND_DEEP: u32 = 10;

/// Deep 的稀有掉落概率（设计 7.2：可变比率强化）。
const RARE_DROP_CHANCE: f64 = 0.12;

/// 统计状态。跨天归零 pomodoros/deep_count/focus_secs；bond 与
/// active_days 跨天保留（活跃天数跨周滚动重置）。
#[derive(Debug, Default, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct Stats {
    pub date: String,
    pub pomodoros: u32,
    pub deep_count: u32,
    pub focus_secs: f64,
    /// 成长值（亲密度最小版，设计 7.2）：只加不减，无穷尽。
    pub bond: u32,
    /// 本周起点（周一日期），跨周重置 active_days。
    pub week_start: String,
    /// 周一..周日的活跃标记。
    #[serde(default)]
    pub active_days: [bool; 7],
}

static CACHE: Mutex<Option<Stats>> = Mutex::new(None);

fn stats_path(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_config_dir().ok().map(|d| d.join("stats.json"))
}

/// 启动时载入。损坏按空处理 —— 统计丢了不致命。
pub fn init(app: &AppHandle) {
    let s = stats_path(app)
        .and_then(|p| fs::read_to_string(p).ok())
        .and_then(|t| serde_json::from_str::<Stats>(&t).ok())
        .unwrap_or_default();
    if let Ok(mut g) = CACHE.lock() {
        *g = Some(s);
    }
}

fn save(app: &AppHandle, s: &Stats) {
    if let Some(p) = stats_path(app) {
        if let Some(dir) = p.parent() {
            let _ = fs::create_dir_all(dir);
        }
        if let Ok(text) = serde_json::to_string_pretty(s) {
            let _ = fs::write(&p, text);
        }
    }
}

/// 当前周起点（周一，"YYYY-MM-DD"）。取不到时返回空串（按未跨周处理）。
fn week_start_today() -> String {
    #[cfg(unix)]
    unsafe {
        use std::time::{SystemTime, UNIX_EPOCH};
        let Ok(secs) = SystemTime::now().duration_since(UNIX_EPOCH) else {
            return String::new();
        };
        let secs = secs.as_secs() as libc::time_t;
        let mut tm: libc::tm = std::mem::zeroed();
        if libc::localtime_r(&secs, &mut tm).is_null() {
            return String::new();
        }
        // 距本周一的天数（tm_wday: 0=周日..6=周六；周一为一周起点）
        let back = (tm.tm_wday as i32 + 6) % 7;
        tm.tm_mday -= back;
        tm.tm_hour = 0;
        tm.tm_min = 0;
        tm.tm_sec = 0;
        if libc::mktime(&mut tm) == -1 {
            return String::new();
        }
        let y = 1900 + tm.tm_year;
        return format!("{y:04}-{:02}-{:02}", tm.tm_mon + 1, tm.tm_mday);
    }
    #[cfg(not(unix))]
    {
        String::new()
    }
}

/// 当天在 active_days 里的下标（0=周一）。
fn day_index() -> usize {
    #[cfg(unix)]
    unsafe {
        let secs = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs() as libc::time_t)
            .unwrap_or(0);
        let mut tm: libc::tm = std::mem::zeroed();
        if libc::localtime_r(&secs, &mut tm).is_null() {
            return 0;
        }
        ((tm.tm_wday as usize) + 6) % 7
    }
    #[cfg(not(unix))]
    {
        0
    }
}

/// 跨天 / 跨周滚动（纯函数，单测入口）。
fn rollover(s: &mut Stats, today: &str, week_start: &str) {
    if s.date != today {
        s.date = today.to_string();
        s.pomodoros = 0;
        s.deep_count = 0;
        s.focus_secs = 0.0;
    }
    if !week_start.is_empty() && s.week_start != week_start {
        s.week_start = week_start.to_string();
        s.active_days = [false; 7]; // 新的一周，重新集
    }
}

/// 番茄完成：计数、成长值、活跃天数记账。返回本次发放的成长值。
pub fn on_pomodoro(grade: Grade, focus_secs: f64, today: &str, app: &AppHandle) -> u32 {
    let ws = week_start_today();
    let gained = match grade {
        Grade::Deep => BOND_DEEP,
        Grade::Normal => BOND_NORMAL,
    };
    let gained = {
        let Ok(mut g) = CACHE.lock() else { return 0 };
        let s = g.get_or_insert_with(Stats::default);
        rollover(s, today, &ws);
        s.pomodoros += 1;
        if grade == Grade::Deep {
            s.deep_count += 1;
        }
        s.focus_secs += focus_secs;
        s.bond = s.bond.saturating_add(gained);
        s.active_days[day_index().min(6)] = true; // 活跃一天就算，无论深浅
        gained
    };
    if let Ok(g) = CACHE.lock() {
        if let Some(s) = g.as_ref() {
            save(app, s);
        }
    }
    gained
}

/// Deep 的稀有掉落判定（12%）。池满时 grant_random 返回 None，
/// 调用方自然退化为只给成长值。
pub fn rare_drop_rolled(grade: Grade) -> bool {
    grade == Grade::Deep && rand::Rng::gen::<f64>(&mut rand::thread_rng()) < RARE_DROP_CHANCE
}

/// 面板展示用的快照（跨天/跨周先滚动）。
pub fn snapshot(today: &str) -> Stats {
    let ws = week_start_today();
    let Ok(mut g) = CACHE.lock() else { return Stats::default() };
    let s = g.get_or_insert_with(Stats::default);
    rollover(s, today, &ws);
    s.clone()
}

/// 测试辅助：直接设置状态。
#[cfg(test)]
pub(crate) fn set_for_test(s: Stats) {
    if let Ok(mut g) = CACHE.lock() {
        *g = Some(s);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 跨天归零但成长值与活跃天数保留() {
        let mut s = Stats {
            date: "2026-09-01".into(),
            pomodoros: 5,
            deep_count: 3,
            focus_secs: 9000.0,
            bond: 128,
            week_start: "2026-08-31".into(),
            active_days: [true, false, true, false, false, false, false],
        };
        rollover(&mut s, "2026-09-02", "2026-08-31");
        assert_eq!((s.pomodoros, s.deep_count, s.focus_secs as u32), (0, 0, 0));
        assert_eq!(s.bond, 128, "成长值只加不减");
        assert_eq!(s.active_days[0], true, "周内活跃天数保留");
    }

    #[test]
    fn 跨周重置活跃天数() {
        let mut s = Stats {
            date: "2026-09-07".into(),
            week_start: "2026-08-31".into(),
            active_days: [true, true, true, true, true, true, true],
            ..Default::default()
        };
        rollover(&mut s, "2026-09-08", "2026-09-07");
        assert_eq!(s.week_start, "2026-09-07");
        assert_eq!(s.active_days, [false; 7], "新的一周重新集");
    }

    #[test]
    fn 周起点为空时不重置() {
        let mut s = Stats {
            week_start: "2026-08-31".into(),
            active_days: [true, false, false, false, false, false, false],
            ..Default::default()
        };
        rollover(&mut s, "2026-09-09", "");
        assert_eq!(s.active_days[0], true, "取不到周起点就当没跨周");
    }

    #[test]
    fn 记账规则_普通三分深度十分() {
        assert_eq!(BOND_NORMAL, 3);
        assert_eq!(BOND_DEEP, 10);
        assert!((RARE_DROP_CHANCE - 0.12).abs() < f64::EPSILON);
    }

    #[test]
    fn 周起点按周一计算() {
        // 只验证格式与非空；具体日期依赖本机时区，无法离线断言
        let ws = week_start_today();
        assert!(ws.is_empty() || ws.len() == 10, "YYYY-MM-DD 或空串：{ws}");
    }

    #[test]
    fn 稀有掉落只对深度专注() {
        for _ in 0..20 {
            assert!(!rare_drop_rolled(Grade::Normal), "Normal 永不掉落");
        }
    }
}
