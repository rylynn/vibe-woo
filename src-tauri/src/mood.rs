//! 心情推导。
//!
//! 从传感器信号推导出宠物当前的情绪。纯逻辑，可完整单测。
//!
//! 设计原则：心情必须是**连续变化的累积量**，不是某个瞬时信号的映射。
//! 否则你刚打开编辑器它就欢呼、切到微信它立刻难过 —— 那是神经质，不是情绪。

use serde::Serialize;

use crate::state::{AppKind, Snapshot};

/// 宠物的当前心情。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Mood {
    /// 心满意足：在编辑器里持续进入状态。
    Content,
    /// 专注：正在干活，但不亢奋。
    Focused,
    /// 无聊：长时间无事可做或只是在刷东西。
    Bored,
    /// 沮丧：卡了很久，或者深夜还在写。
    Frustrated,
}

/// 心情推导的累积状态。
///
/// 用积分器而非瞬时映射：进入状态会累积「满足感」，卡住会累积「烦躁感」，
/// 无聊会累积「空虚感」。取三者最大值决定当前心情，让情绪有惯性、
/// 不会来回跳变。
#[derive(Debug, Default)]
pub struct MoodMeter {
    /// 满足感，0..100。
    content: f64,
    /// 烦躁感，0..100。
    frustrated: f64,
    /// 空虚感，0..100。
    bored: f64,
}

/// 各情绪的累积/衰减速率（每秒）。
///
/// 刻意不对称：满足感涨得慢退得快（心流被打断很可惜），
/// 烦躁感涨得快退得慢（卡住的感觉会停留），
/// 这是真实情绪的粗糙近似。
const CONTENT_RATE: f64 = 0.6;
/// 满足感消退要慢，否则「查个文档就翻情绪」会显得神经质。
const CONTENT_DECAY: f64 = 0.55;
const FRUSTRATED_RATE: f64 = 1.4;
const FRUSTRATED_DECAY: f64 = 0.5;
/// 无聊感涨速要慢于满足感消退速度的感知：短暂切走不应立刻翻转。
const BORED_RATE: f64 = 0.45;
const BORED_DECAY: f64 = 0.8;

/// 各心情的显现阈值。低于阈值时归入 Focused（默认、最平静的情绪）。
const SHOW_THRESHOLD: f64 = 18.0;

impl MoodMeter {
    /// 喂入一次采样，返回当前心情。
    pub fn update(&mut self, s: &Snapshot, dt: f64) -> Mood {
        let in_flow = s.app == AppKind::Coding && s.keystrokes_per_min >= 120.0;
        let stuck = s.app == AppKind::Coding && s.keyboard_idle_secs >= 90.0;
        let browsing = s.app == AppKind::Browsing;
        let idle_long = s.keyboard_idle_secs >= 300.0;
        let late = s.hour >= 23 || s.hour < 5;

        self.content = clamp(
            self.content
                + if in_flow {
                    CONTENT_RATE
                } else {
                    -CONTENT_DECAY
                } * dt,
        );
        self.frustrated = clamp(
            self.frustrated
                + if stuck || (in_flow && late) {
                    FRUSTRATED_RATE
                } else {
                    -FRUSTRATED_DECAY
                } * dt,
        );
        self.bored = clamp(
            self.bored
                + if browsing || (idle_long && !in_flow) {
                    BORED_RATE
                } else {
                    -BORED_DECAY
                } * dt,
        );

        self.current()
    }

    fn current(&self) -> Mood {
        let max = self
            .content
            .max(self.frustrated)
            .max(self.bored);
        if max < SHOW_THRESHOLD {
            return Mood::Focused;
        }
        if self.frustrated == max {
            return Mood::Frustrated;
        }
        if self.bored == max {
            return Mood::Bored;
        }
        Mood::Content
    }
}

fn clamp(v: f64) -> f64 {
    v.clamp(0.0, 100.0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn snap(app: AppKind, kpm: f64, idle: f64, hour: u8) -> Snapshot {
        Snapshot {
            app,
            keystrokes_per_min: kpm,
            keyboard_idle_secs: idle,
            hour,
        }
    }

    fn run(meter: &mut MoodMeter, s: &Snapshot, seconds: usize) -> Mood {
        let mut m = Mood::Focused;
        for _ in 0..seconds {
            m = meter.update(s, 1.0);
        }
        m
    }

    #[test]
    fn 初始为平静专注() {
        let mut m = MoodMeter::default();
        assert_eq!(m.update(&snap(AppKind::Coding, 50.0, 2.0, 14), 1.0), Mood::Focused);
    }

    #[test]
    fn 持续进入状态后心满意足() {
        let mut m = MoodMeter::default();
        let m0 = run(&mut m, &snap(AppKind::Coding, 180.0, 1.0, 14), 45);
        assert_eq!(m0, Mood::Content);
    }

    #[test]
    fn 进入状态几分钟才有满足感_不会一开编辑器就欢呼() {
        let mut m = MoodMeter::default();
        let m0 = run(&mut m, &snap(AppKind::Coding, 180.0, 1.0, 14), 8);
        assert_eq!(m0, Mood::Focused, "情绪需要时间累积，不应瞬时切换");
    }

    #[test]
    fn 卡住一段时间后沮丧() {
        let mut m = MoodMeter::default();
        let m0 = run(&mut m, &snap(AppKind::Coding, 0.0, 120.0, 14), 20);
        assert_eq!(m0, Mood::Frustrated);
    }

    #[test]
    fn 深夜还在写也容易沮丧() {
        let mut m = MoodMeter::default();
        let m0 = run(&mut m, &snap(AppKind::Coding, 150.0, 1.0, 2), 25);
        assert_eq!(m0, Mood::Frustrated);
    }

    #[test]
    fn 一直刷东西会无聊() {
        let mut m = MoodMeter::default();
        // 无聊感涨速慢，需约 40 秒才显现 —— 这是刻意的，
        // 刷两分钟网页不该立刻让宠物垮掉
        let m0 = run(&mut m, &snap(AppKind::Browsing, 0.0, 5.0, 14), 50);
        assert_eq!(m0, Mood::Bored);
    }

    #[test]
    fn 情绪有惯性_不会来回跳变() {
        let mut m = MoodMeter::default();
        // 先满足
        run(&mut m, &snap(AppKind::Coding, 180.0, 1.0, 14), 45);
        // 短暂切走（比如去查个文档），不应立刻变无聊
        let m0 = run(&mut m, &snap(AppKind::Browsing, 0.0, 5.0, 14), 10);
        assert_eq!(m0, Mood::Content, "短暂切走不应立刻翻转情绪");
    }

    #[test]
    fn 满足感涨得慢退得快() {
        let mut m = MoodMeter::default();
        run(&mut m, &snap(AppKind::Coding, 180.0, 1.0, 14), 45);
        assert_eq!(m.current(), Mood::Content);
        // 停止进入状态 30 秒就退回去
        let m0 = run(&mut m, &snap(AppKind::Coding, 30.0, 1.0, 14), 30);
        assert_ne!(m0, Mood::Content, "心流被打断很可惜，满足感应较快消退");
    }

    #[test]
    fn 各情绪量有界_不会无限累积() {
        let mut m = MoodMeter::default();
        run(&mut m, &snap(AppKind::Coding, 180.0, 1.0, 14), 10000);
        assert!(m.content <= 100.0);
        assert!(m.frustrated <= 100.0);
        assert!(m.bored <= 100.0);
    }
}
