//! 专注判定（2026-08-31 设计 P1）。
//!
//! 原则（设计 2.1）：判定只用于发奖励，绝不用于惩罚。
//! 只有两态 —— Deep 与 Normal，不存在「告知用户你这轮不专注」的出口；
//! 测不准（全程无采样）一律 Normal，不冤枉用户。
//!
//! 数据流：pomodoro 插件在 WorkStart 调 `start()`；sensedrive 慢层
//!（1 秒一轮）持续 `sample()` 喂数（Session 未激活时是空操作）；
//! BreakStart 时 `finish()` 取出判定。跨线程共享走静态 Mutex。

use std::sync::Mutex;

/// 专注段内的「离开」阈值：工作期里走开超过 2 分钟不算在专注
///（25 分钟里消失 8 分钟不该算 Deep）。
const IN_SESSION_AWAY_SECS: f64 = 120.0;

/// Deep 的在任务时长占比门槛。
const DEEP_RATIO: f64 = 0.85;

/// Deep 的应用切换次数上限（注意力残留：切换本身就是成本）。
const DEEP_MAX_SWITCHES: u32 = 2;

/// 判定结果。Normal 与「不奖励」行为一致 —— 砍掉第三档是设计决策
///（设计 4.2），边界条件少一整层。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Grade {
    Deep,
    Normal,
}

/// 一个番茄工作期的累计采样。
#[derive(Debug, Default, Clone, PartialEq)]
pub struct Session {
    pub total_secs: f64,
    /// 产出型应用且键盘活跃（idle < 2 分钟）的时长。
    pub on_task_secs: f64,
    /// bundle id 变更次数（首个不算）。
    pub switches: u32,
    pub last_bundle: Option<String>,
    /// 是否有过成功采样。
    pub sampled_any: bool,
}

/// 纯函数判定（单测入口）。
pub fn judge(s: &Session) -> Grade {
    if !s.sampled_any || s.total_secs <= 0.0 {
        return Grade::Normal; // 测不准不给奖
    }
    let ratio = s.on_task_secs / s.total_secs;
    if ratio >= DEEP_RATIO && s.switches <= DEEP_MAX_SWITCHES {
        Grade::Deep
    } else {
        Grade::Normal
    }
}

static SESSION: Mutex<Option<Session>> = Mutex::new(None);

/// 工作期开始：重置累计器。
pub fn start() {
    if let Ok(mut g) = SESSION.lock() {
        *g = Some(Session::default());
    }
}

/// sensedrive 慢层喂数（Session 未激活时直接返回）。
/// `on_task` = 前台是产出型应用且键盘空闲 < 2 分钟（调用方算好）。
pub fn sample(on_task: bool, bundle: &str, dt_secs: f64) {
    let Ok(mut g) = SESSION.lock() else { return };
    let Some(s) = g.as_mut() else { return };
    if dt_secs <= 0.0 {
        return;
    }
    s.total_secs += dt_secs;
    s.sampled_any = true;
    if on_task {
        s.on_task_secs += dt_secs;
    }
    match &s.last_bundle {
        Some(b) if b != bundle => {
            s.switches += 1;
            s.last_bundle = Some(bundle.to_string());
        }
        None => s.last_bundle = Some(bundle.to_string()),
        _ => {}
    }
}

/// 工作期结束：取出 Session 与判定（未启动过的 Session 判 Normal）。
/// 顺带返回专注累计秒数（供当日统计）。
pub fn finish() -> (Grade, f64) {
    let s = match SESSION.lock() {
        Ok(mut g) => g.take().unwrap_or_default(),
        Err(_) => Session::default(),
    };
    let secs = s.total_secs;
    (judge(&s), secs)
}

/// 喂数条件：产出型应用 + 键盘空闲在专注阈值内（供 sensedrive 调用）。
pub fn on_task_now(is_producing: bool, keyboard_idle_secs: f64) -> bool {
    is_producing && keyboard_idle_secs < IN_SESSION_AWAY_SECS
}

#[cfg(test)]
mod tests {
    use super::*;

    fn session(total: f64, on_task: f64, switches: u32, sampled: bool) -> Session {
        Session {
            total_secs: total,
            on_task_secs: on_task,
            switches,
            last_bundle: Some("x".into()),
            sampled_any: sampled,
        }
    }

    #[test]
    fn 高占比少切换判深度() {
        assert_eq!(judge(&session(1500.0, 1275.0, 2, true)), Grade::Deep);
        assert_eq!(judge(&session(1500.0, 1500.0, 0, true)), Grade::Deep);
    }

    #[test]
    fn 占比边界在零点八五() {
        assert_eq!(
            judge(&session(100.0, 84.9, 0, true)),
            Grade::Normal,
            "0.849 不够"
        );
        assert_eq!(judge(&session(100.0, 85.0, 0, true)), Grade::Deep);
    }

    #[test]
    fn 切换超过两次不给深度() {
        assert_eq!(judge(&session(1500.0, 1500.0, 3, true)), Grade::Normal);
        assert_eq!(judge(&session(1500.0, 1500.0, 2, true)), Grade::Deep);
    }

    #[test]
    fn 全程无采样判普通不冤枉() {
        assert_eq!(judge(&session(1500.0, 1500.0, 0, false)), Grade::Normal);
    }

    #[test]
    fn 零时长不除零() {
        assert_eq!(judge(&session(0.0, 0.0, 0, true)), Grade::Normal);
    }

    #[test]
    fn 喂数累计与切换计数() {
        start();
        // 首个 bundle 建立基线，不算切换
        sample(true, "a", 60.0);
        sample(true, "a", 60.0);
        // 切到 b：+1
        sample(false, "b", 30.0);
        let (grade, secs) = finish();
        assert_eq!(secs, 150.0);
        assert_eq!(grade, Grade::Normal, "on_task 120/150 = 0.8 不足");
    }

    #[test]
    fn 未启动时结束判普通() {
        let (grade, secs) = finish();
        assert_eq!(grade, Grade::Normal);
        assert_eq!(secs, 0.0);
    }

    #[test]
    fn 专注内离开阈值两分钟() {
        assert!(on_task_now(true, 119.9));
        assert!(!on_task_now(true, 120.0), "静默满 2 分钟算离开");
        assert!(!on_task_now(false, 0.0), "非产出型不算");
    }
}
