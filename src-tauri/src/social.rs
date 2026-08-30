//! 好友度与串门事件。
//!
//! 好友度是「串门」的门槛，也复用为 P3 设计里的数值底座。

use serde::{Deserialize, Serialize};

/// 好友度（0..100）。
///
/// 增长来源刻意「慢热」：
///   - 共同在线：每分钟 +0.02（挂 8 小时约 +10）
///   - 被好友的宠物互动（摸头等）：每次 +3
///   - 收到串门：每次 +2
/// 没有衰减 —— 朋友的感情不该随时间清零。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Affinity {
    pub value: f64,
}

impl Affinity {
    pub fn new() -> Self {
        Self { value: 0.0 }
    }

    pub fn tick_online(&mut self, minutes: f64) {
        self.add(minutes * 0.02);
    }

    pub fn on_interacted(&mut self) {
        self.add(3.0);
    }

    pub fn on_visit(&mut self) {
        self.add(2.0);
    }

    fn add(&mut self, v: f64) {
        self.value = (self.value + v).min(100.0);
    }

    /// 串门门槛。设计文档 7.4：好友度累积到阈值宠物才自己决定出门。
    pub fn can_visit(&self) -> bool {
        self.value >= VISIT_THRESHOLD
    }

    /// 串门消耗好友度，出门一次回吐 8 点 —— 避免连环出门打扰别人。
    pub fn spend_for_visit(&mut self) {
        self.value = (self.value - 8.0).max(0.0);
    }
}

/// 串门门槛。
pub const VISIT_THRESHOLD: f64 = 15.0;

/// 好友间投递的事件。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum SocialEvent {
    /// 我的宠物去对方桌面串门了。
    Visit { from_nick: String },
    /// 对方摸了/点了来访的宠物。
    Interaction { from_nick: String, pats: u32 },
}

/// 事件的最大保留时长（服务端 TTL 的依据）。
#[allow(dead_code)]
pub const EVENT_TTL_SECS: i64 = 7 * 24 * 3600;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 共同在线缓慢增长() {
        let mut a = Affinity::new();
        a.tick_online(8.0 * 60.0); // 8 小时
        assert!((a.value - 9.6).abs() < 0.01, "8 小时约 +9.6，实际 {}", a.value);
        assert!(!a.can_visit(), "一天共同在线不足以串门");
    }

    #[test]
    fn 互动与串门显著增长() {
        let mut a = Affinity::new();
        a.on_interacted();
        a.on_visit();
        assert!((a.value - 5.0).abs() < 0.01);
    }

    #[test]
    fn 好友度有上界() {
        let mut a = Affinity::new();
        for _ in 0..100 {
            a.on_interacted();
        }
        assert_eq!(a.value, 100.0);
    }

    #[test]
    fn 串门消耗好友度避免连环出门() {
        let mut a = Affinity::new();
        a.value = 20.0;
        a.spend_for_visit();
        assert!((a.value - 12.0).abs() < 0.01);
        // 连续消耗不会为负
        for _ in 0..5 {
            a.spend_for_visit();
        }
        assert_eq!(a.value, 0.0);
        assert!(!a.can_visit());
    }

    #[test]
    fn 事件序列化带类型标签() {
        let e = SocialEvent::Visit {
            from_nick: "阿咪".into(),
        };
        let json = serde_json::to_string(&e).unwrap();
        assert!(json.contains("\"visit\""));
        assert!(json.contains("阿咪"));

        let back: SocialEvent = serde_json::from_str(&json).unwrap();
        match back {
            SocialEvent::Visit { from_nick } => assert_eq!(from_nick, "阿咪"),
            _ => panic!("反序列化错误"),
        }
    }

    #[test]
    fn 互动事件往返() {
        let e = SocialEvent::Interaction {
            from_nick: "阿咪".into(),
            pats: 3,
        };
        let json = serde_json::to_string(&e).unwrap();
        let back: SocialEvent = serde_json::from_str(&json).unwrap();
        match back {
            SocialEvent::Interaction { pats, .. } => assert_eq!(pats, 3),
            _ => panic!("反序列化错误"),
        }
    }
}
