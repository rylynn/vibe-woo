//! 提醒：到点前由宠物气泡或右上角弹窗告知。
//!
//! 触发判断是纯逻辑（可测），驱动循环薄薄一层。

use serde::{Deserialize, Serialize};

/// 一条提醒。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Reminder {
    /// 每天触发的时间，"HH:MM"。
    pub time: String,
    /// 提醒内容。
    pub text: String,
    /// 提前多少分钟开始提醒。
    #[serde(default)]
    pub advance_mins: u32,
    /// 重要提醒用右上角弹窗；普通提醒用宠物气泡。
    #[serde(default)]
    pub important: bool,
}

/// 解析 "HH:MM" 为当天的分钟数。非法输入返回 None。
pub fn parse_hhmm(s: &str) -> Option<u32> {
    let (h, m) = s.trim().split_once(':')?;
    let h: u32 = h.parse().ok()?;
    let m: u32 = m.parse().ok()?;
    if h > 23 || m > 59 {
        return None;
    }
    Some(h * 60 + m)
}

/// 触发判定所需的时间上下文。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TimeCtx {
    /// 当天日期，"YYYY-MM-DD"。
    pub date: String,
    /// 当天已过分钟数。
    pub minutes: u32,
}

impl TimeCtx {
    pub fn new(date: impl Into<String>, minutes: u32) -> Self {
        Self {
            date: date.into(),
            minutes,
        }
    }
}

/// 判断提醒此刻是否应触发。
///
/// 返回 true 的同一 (提醒, 日期) 组合只应触发一次 ——
/// 调用方负责记录已触发的日期，这是防重复的关键。
pub fn should_fire(r: &Reminder, ctx: &TimeCtx, last_fired_date: &str) -> bool {
    if ctx.date == last_fired_date {
        return false;
    }
    let Some(t) = parse_hhmm(&r.time) else {
        return false;
    };
    // 提前量不能把触发时间推到昨天 —— 跨午夜的提前不生效
    let fire_at = t.saturating_sub(r.advance_mins);
    ctx.minutes >= fire_at && ctx.minutes <= t + 15
}

/// 稍后重响：触发后用户没确认，过段时间再提醒一次。
/// 简化处理：触发窗口（fire_at 到 t+15）内每分钟都会重判，
/// 由调用方的去重记录保证只响一次；此处不做 snooze。

#[cfg(test)]
mod tests {
    use super::*;

    fn r(time: &str, advance: u32) -> Reminder {
        Reminder {
            time: time.into(),
            text: "喝水".into(),
            advance_mins: advance,
            important: false,
        }
    }

    #[test]
    fn 解析合法时间() {
        assert_eq!(parse_hhmm("09:30"), Some(570));
        assert_eq!(parse_hhmm("00:00"), Some(0));
        assert_eq!(parse_hhmm("23:59"), Some(23 * 60 + 59));
    }

    #[test]
    fn 解析非法时间() {
        assert_eq!(parse_hhmm("24:00"), None);
        assert_eq!(parse_hhmm("12:60"), None);
        assert_eq!(parse_hhmm("abc"), None);
        assert_eq!(parse_hhmm(""), None);
        // 单位数也接受 —— 手输时少打一个零很常见
        assert_eq!(parse_hhmm("9:5"), Some(545));
    }

    #[test]
    fn 到点触发() {
        let ctx = TimeCtx::new("2026-08-30", 10 * 60);
        assert!(should_fire(&r("10:00", 0), &ctx, ""));
    }

    #[test]
    fn 提前量内触发() {
        let ctx = TimeCtx::new("2026-08-30", 9 * 60 + 45);
        assert!(should_fire(&r("10:00", 20), &ctx, ""), "提前 20 分钟");
    }

    #[test]
    fn 太早不触发() {
        let ctx = TimeCtx::new("2026-08-30", 9 * 60);
        assert!(!should_fire(&r("10:00", 20), &ctx, ""));
    }

    #[test]
    fn 过窗不触发() {
        // 错过了 16 分钟，不再提醒 —— 补提醒只会烦人
        let ctx = TimeCtx::new("2026-08-30", 10 * 60 + 16);
        assert!(!should_fire(&r("10:00", 0), &ctx, ""));
    }

    #[test]
    fn 当天已触发过不再触发() {
        let ctx = TimeCtx::new("2026-08-30", 10 * 60);
        assert!(!should_fire(&r("10:00", 0), &ctx, "2026-08-30"));
    }

    #[test]
    fn 第二天重新触发() {
        let ctx = TimeCtx::new("2026-08-31", 10 * 60);
        assert!(should_fire(&r("10:00", 0), &ctx, "2026-08-30"));
    }

    #[test]
    fn 提前量跨午夜不提前() {
        // 00:10 的提醒提前 30 分钟：saturating_sub 后 fire_at=0，
        // 即当天 00:00 起就满足 minutes >= 0 —— 这会一开机就响，
        // 是错的。正确行为：minutes 在 fire_at..=t+15 窗口内，
        // 而 00:00 时 minutes=0 恰好在窗口内。
        // 真正要防的是「昨天的 23:40」—— 那属于昨天的上下文，
        // 本函数只看当天，因此不存在跨天提前，此测试验证语义边界。
        let ctx = TimeCtx::new("2026-08-30", 0);
        // minutes=0 在窗口 [0, 25] 内，会触发 —— 接受这个行为
        assert!(should_fire(&r("00:10", 30), &ctx, ""));
        // 但 23:59 时早已过窗（t+15=25），不再触发
        let late = TimeCtx::new("2026-08-30", 23 * 60 + 59);
        assert!(!should_fire(&r("00:10", 30), &late, ""));
    }

    #[test]
    fn 非法时间的提醒永不触发() {
        let ctx = TimeCtx::new("2026-08-30", 600);
        assert!(!should_fire(&r("99:99", 0), &ctx, ""));
    }
}
