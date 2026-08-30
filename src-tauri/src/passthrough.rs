//! 穿透决策逻辑。
//!
//! 单独成模块且不依赖 Tauri，因为这段逻辑决定「桌面点击会不会被锁死」——
//! 曾因它出错导致只能重启电脑，必须有单元测试覆盖。

use std::time::Duration;

/// 决策输入。全部为纯数据，便于测试。
#[derive(Debug, Clone, Copy)]
pub struct Decision {
    /// 前端上报是否新鲜（未失联）。
    pub fresh: bool,
    /// 前端请求保持鼠标接管（拖动中 / 菜单打开）。
    pub lock_requested: bool,
    /// 光标是否落在任一可点击区域内。
    pub inside: bool,
    /// 系统层面是否有鼠标键被按下。None 表示无法探测。
    pub buttons_pressed: Option<bool>,
    /// lock 已持续多久。None 表示当前未处于 lock。
    pub lock_age: Option<Duration>,
}

/// lock 的最长容忍时长。
///
/// 没有人会按住鼠标拖宠物超过这么久。若 lock 持续更长时间，
/// 一定是前端状态卡住了，必须强制解除。
pub const MAX_LOCK: Duration = Duration::from_secs(8);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Outcome {
    /// true 表示应穿透（不拦截鼠标）。
    pub ignore: bool,
    /// 前端的 lock 请求是否被否决。
    pub lock_vetoed: bool,
}

/// 判断是否应让鼠标穿透。
///
/// fail-safe 优先级（从高到低）：
///   1. 前端失联 → 必须穿透。哪怕它上报过 lock —— 若前端在拖动中崩溃，
///      lock 会永远为 true，绝不能因此永久锁死桌面。
///   2. lock 被否决（系统无按键 / 超时）→ 退回按位置判定。
///   3. lock 有效 → 接管鼠标，避免快速拖动时光标甩出包围盒导致脱手。
///   4. 默认 → 仅当光标落在可点击区域内才接管。
pub fn decide(d: Decision) -> Outcome {
    if !d.fresh {
        return Outcome {
            ignore: true,
            lock_vetoed: false,
        };
    }

    let vetoed_by_buttons = matches!(d.buttons_pressed, Some(false));
    let vetoed_by_timeout = d.lock_age.map(|a| a > MAX_LOCK).unwrap_or(false);
    let lock_vetoed = d.lock_requested && (vetoed_by_buttons || vetoed_by_timeout);
    let lock = d.lock_requested && !lock_vetoed;

    Outcome {
        ignore: if lock { false } else { !d.inside },
        lock_vetoed,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn base() -> Decision {
        Decision {
            fresh: true,
            lock_requested: false,
            inside: false,
            buttons_pressed: Some(false),
            lock_age: None,
        }
    }

    #[test]
    fn 默认穿透() {
        assert!(decide(base()).ignore);
    }

    #[test]
    fn 光标在宠物上则接管() {
        let d = Decision {
            inside: true,
            ..base()
        };
        assert!(!decide(d).ignore);
    }

    #[test]
    fn 前端失联时无条件穿透() {
        let d = Decision {
            fresh: false,
            lock_requested: true,
            inside: true,
            buttons_pressed: Some(true),
            lock_age: Some(Duration::from_millis(10)),
        };
        assert!(
            decide(d).ignore,
            "前端失联必须穿透，否则前端崩溃会永久锁死桌面"
        );
    }

    #[test]
    fn 按键按下时的拖动锁定生效() {
        let d = Decision {
            lock_requested: true,
            inside: false,
            buttons_pressed: Some(true),
            lock_age: Some(Duration::from_millis(100)),
            ..base()
        };
        let o = decide(d);
        assert!(!o.ignore, "拖动中光标甩出包围盒也不能放手");
        assert!(!o.lock_vetoed);
    }

    #[test]
    fn 无按键按下时否决拖动锁定() {
        let d = Decision {
            lock_requested: true,
            inside: false,
            buttons_pressed: Some(false),
            lock_age: Some(Duration::from_millis(100)),
            ..base()
        };
        let o = decide(d);
        assert!(
            o.ignore,
            "系统层面没有按键按下就不可能在拖动，必须否决前端的卡死状态"
        );
        assert!(o.lock_vetoed);
    }

    #[test]
    fn 拖动锁定超时后被否决() {
        let d = Decision {
            lock_requested: true,
            inside: false,
            // 无法探测按键状态时不能靠按键否决，只能靠超时
            buttons_pressed: None,
            lock_age: Some(MAX_LOCK + Duration::from_secs(1)),
            ..base()
        };
        let o = decide(d);
        assert!(o.ignore, "lock 持续过久一定是前端卡死，必须强制解除");
        assert!(o.lock_vetoed);
    }

    #[test]
    fn 无法探测按键时短时锁定仍然有效() {
        let d = Decision {
            lock_requested: true,
            inside: false,
            buttons_pressed: None,
            lock_age: Some(Duration::from_millis(200)),
            ..base()
        };
        let o = decide(d);
        assert!(!o.ignore, "探测不到按键状态时不应误伤正常拖动");
        assert!(!o.lock_vetoed);
    }

    #[test]
    fn 否决后仍按位置判定而非一律穿透() {
        let d = Decision {
            lock_requested: true,
            inside: true,
            buttons_pressed: Some(false),
            lock_age: Some(Duration::from_millis(100)),
            ..base()
        };
        let o = decide(d);
        assert!(!o.ignore, "lock 被否决后，光标确实在宠物上仍应接管");
        assert!(o.lock_vetoed);
    }
}
