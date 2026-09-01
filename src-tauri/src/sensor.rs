//! 系统状态采集。
//!
//! 隐私原则（不可妥协）：只采集「距上次按键多少秒」与「前台应用是谁」，
//! **绝不接触任何键位内容、窗口标题、文件名**。
//! 因此 macOS 上无需任何辅助功能授权，装上即用、无弹窗。

use std::collections::VecDeque;
use std::time::{Duration, Instant};

/// 采集到的原始系统状态。
#[derive(Debug, Clone, Copy)]
pub struct RawSample {
    /// 距上次键盘事件的秒数。
    pub keyboard_idle_secs: f64,
    /// 距上次鼠标移动的秒数。番茄休息验证用。
    pub mouse_idle_secs: f64,
    /// 本地小时（0–23）。
    pub hour: u8,
}

/// 击键频率估算器。
///
/// **为什么不直接监听键盘**：那需要辅助功能授权，且天然能读到键位内容 ——
/// 对一个桌宠来说是不可接受的隐私成本。
///
/// 做法：高频轮询「距上次按键秒数」。该值一旦变小，说明这期间发生了新的
/// 按键。只记录发生时刻，永远不知道按了什么。用滑动窗口换算成每分钟次数。
pub struct KeystrokeRate {
    last_idle: f64,
    /// 近期检测到的按键时刻。
    hits: VecDeque<Instant>,
    window: Duration,
}

impl KeystrokeRate {
    pub fn new(window: Duration) -> Self {
        Self {
            last_idle: f64::MAX,
            hits: VecDeque::new(),
            window,
        }
    }

    /// 喂入一次采样，返回当前每分钟击键次数估算值。
    pub fn update(&mut self, idle_secs: f64, now: Instant) -> f64 {
        // 空闲秒数变小 = 期间有新按键。首次采样时 last_idle 为 MAX，
        // 会被判为有按键，这没关系 —— 单次误差会很快被窗口冲掉。
        if idle_secs < self.last_idle {
            self.hits.push_back(now);
        }
        self.last_idle = idle_secs;

        while let Some(&front) = self.hits.front() {
            if now.duration_since(front) > self.window {
                self.hits.pop_front();
            } else {
                break;
            }
        }

        let secs = self.window.as_secs_f64();
        self.hits.len() as f64 * 60.0 / secs
    }
}

#[cfg(target_os = "macos")]
mod platform {
    use super::RawSample;

    /// 采集当前系统状态。返回 None 表示采集失败。
    pub fn sample() -> Option<RawSample> {
        Some(RawSample {
            keyboard_idle_secs: keyboard_idle()?,
            mouse_idle_secs: mouse_idle().unwrap_or(f64::MAX),
            hour: local_hour(),
        })
    }

    /// 快层采集：仅键盘空闲秒数（单次 CGEventSource C 调用，无 ObjC、无分配）。
    ///
    /// 击键检测需要 120ms 粒度，但 hour / mouse_idle 属于慢层信号 ——
    /// 把最便宜的采集拆出来，让快层不必为整份 RawSample 付 NSCalendar 的钱。
    pub fn keyboard_idle_secs() -> Option<f64> {
        keyboard_idle()
    }

    /// 距上次键盘按下事件的秒数。
    ///
    /// 用 CGEventSourceSecondsSinceLastEventType —— 它只返回时间间隔，
    /// 不返回任何事件内容，**无需辅助功能授权**。
    fn keyboard_idle() -> Option<f64> {
        idle_secs_since(EVENT_KEY_DOWN)
    }

    /// 距上次鼠标移动的秒数。
    ///
    /// 同样只取时间间隔，不含位置或按键信息。取不到时按「很久没动」处理，
    /// 避免平台异常误伤用户的休息奖励。
    fn mouse_idle() -> Option<f64> {
        idle_secs_since(EVENT_MOUSE_MOVED)
    }

    // kCGEventKeyDown = 10
    const EVENT_KEY_DOWN: u32 = 10;
    // kCGEventMouseMoved = 5
    const EVENT_MOUSE_MOVED: u32 = 5;

    fn idle_secs_since(event_type: u32) -> Option<f64> {
        // kCGEventSourceStateCombinedSessionState = 0
        const COMBINED_SESSION_STATE: u32 = 0;

        extern "C" {
            fn CGEventSourceSecondsSinceLastEventType(
                state_id: u32,
                event_type: u32,
            ) -> f64;
        }

        let secs = unsafe {
            CGEventSourceSecondsSinceLastEventType(COMBINED_SESSION_STATE, event_type)
        };
        if secs.is_finite() && secs >= 0.0 {
            Some(secs)
        } else {
            None
        }
    }

    /// 前台应用信息。
    pub struct FrontmostApp {
        /// bundle id，供分类。
        pub bundle_id: String,
        /// 主进程 pid，供 envsense 扫进程树。
        pub pid: i32,
    }

    /// 前台应用（bundle id + pid）。
    ///
    /// 用 NSWorkspace.frontmostApplication —— 只拿标识符与进程号，
    /// **不读窗口标题**（那会泄漏文件名与项目名），无需授权。
    ///
    /// 用 objc2-app-kit 的类型安全绑定而非裸 msg_send!：后者对返回
    /// retained 对象的方法容易拿到无效指针（实测得到空 bundle id）。
    pub fn frontmost_app() -> Option<FrontmostApp> {
        use objc2_app_kit::NSWorkspace;

        // objc2 0.6 中这些方法均为安全接口，无需 unsafe
        let workspace = NSWorkspace::sharedWorkspace();
        let app = workspace.frontmostApplication()?;

        // 忽略自己 —— 宠物窗口虽然设了 nonactivating，但在某些时机
        // （如刚点过宠物、或以裸二进制运行无 bundle 时）仍可能被报为前台。
        // 把自己算作「用户在用的应用」会让状态判断彻底失真。
        let pid: i32 = app.processIdentifier();
        if pid == std::process::id() as i32 {
            return None;
        }

        match app.bundleIdentifier() {
            None => {
                // 无 bundle 的进程（裸二进制、某些命令行工具）无法分类
                diag_once("前台应用没有 bundle id，按未知处理");
                None
            }
            Some(b) => Some(FrontmostApp {
                bundle_id: b.to_string(),
                pid,
            }),
        }
    }

    /// 同一原因只报一次，避免每 120ms 刷屏。
    fn diag_once(reason: &str) {
        use std::sync::OnceLock;
        static SEEN: OnceLock<()> = OnceLock::new();
        if SEEN.set(()).is_ok() {
            eprintln!("[sensor] {reason}");
        }
    }

    fn local_hour() -> u8 {
        use objc2_foundation::{NSCalendar, NSCalendarUnit, NSDate};

        let cal = NSCalendar::currentCalendar();
        let now = NSDate::now();
        let hour = cal.component_fromDate(NSCalendarUnit::Hour, &now);
        hour.clamp(0, 23) as u8
    }
}

#[cfg(not(target_os = "macos"))]
mod platform {
    use super::RawSample;

    pub fn sample() -> Option<RawSample> {
        None
    }

    pub fn keyboard_idle_secs() -> Option<f64> {
        None
    }

    pub fn frontmost_app() -> Option<super::FrontmostApp> {
        None
    }
}

pub use platform::{frontmost_app, keyboard_idle_secs, sample};

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 空闲秒数持续增大说明没有按键() {
        let mut r = KeystrokeRate::new(Duration::from_secs(10));
        let t0 = Instant::now();
        // 首次采样会记一次（last_idle 初值为 MAX），之后递增不应再记
        r.update(1.0, t0);
        let kpm = r.update(2.0, t0 + Duration::from_millis(100));
        let kpm2 = r.update(3.0, t0 + Duration::from_millis(200));
        assert_eq!(kpm, kpm2, "空闲递增期间不应新增击键");
    }

    #[test]
    fn 空闲秒数归零说明有新按键() {
        let mut r = KeystrokeRate::new(Duration::from_secs(60));
        let t0 = Instant::now();
        r.update(5.0, t0);
        let before = r.update(6.0, t0 + Duration::from_millis(100));
        let after = r.update(0.01, t0 + Duration::from_millis(200));
        assert!(after > before, "空闲归零必须被记为一次击键");
    }

    #[test]
    fn 滑动窗口会淘汰过期击键() {
        let window = Duration::from_secs(2);
        let mut r = KeystrokeRate::new(window);
        let t0 = Instant::now();
        // 连打三次
        r.update(0.01, t0);
        r.update(0.01, t0);
        let peak = r.update(0.005, t0 + Duration::from_millis(10));
        assert!(peak > 0.0);

        // 窗口过后不再有新按键，频率应回落到 0
        let later = r.update(9.0, t0 + window + Duration::from_secs(1));
        assert_eq!(later, 0.0, "过期击键必须被淘汰，否则宠物会一直以为你在敲");
    }

    #[test]
    fn 频率按窗口长度正确归一化() {
        let mut r = KeystrokeRate::new(Duration::from_secs(60));
        let t0 = Instant::now();
        // 首帧计入一次，再制造两次归零，共 3 次
        r.update(1.0, t0);
        r.update(0.5, t0);
        let kpm = r.update(0.1, t0);
        // 60 秒窗口内 3 次 → 3 次/分
        assert!((kpm - 3.0).abs() < 1e-9, "kpm={kpm}");
    }
}
