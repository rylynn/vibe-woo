//! 宠物状态机。
//!
//! 纯逻辑、无平台依赖，因此可完整单测。这里是「宠物懂不懂你」的核心：
//! 状态判错，宠物的所有表现都会显得莫名其妙。
//!
//! 设计要点（详见设计文档 4.1）：状态不是扁平列表，而是两个正交维度
//! 相乘 —— 「在干什么」× 「什么节奏」，再叠时间修饰符。扁平列表会
//! 产生大量互相冲突的状态。

use serde::Serialize;

use crate::activity::Activity;
use crate::mood::Mood;

/// 前台应用的类别 —— 回答「主人正在做哪一类**事**」。
///
/// 刻意不按职业划分：分类的是事，不是人。用编辑器写小说的人不是程序员，
/// 用表格做预算的人和做数据建模的人也是两回事 —— 这里只认前台工具
/// 属于哪一类场景，至于主人是干什么的，只有他自己填了才知道。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum AppKind {
    /// 编辑器 / IDE / 终端。
    Editing,
    /// 文档、笔记、写作。
    Writing,
    /// 设计、绘图、剪辑。
    Designing,
    /// 表格、数据。
    Data,
    /// 沟通协作：聊天、邮件、会议。
    Messaging,
    /// 阅读浏览：浏览器、PDF、电子书。
    Browsing,
    /// 影音娱乐：音乐、视频。
    Watching,
    /// 其他。
    Other,
}

impl AppKind {
    /// 是否属于「专注产出」。
    ///
    /// 这是「在产出 / 在消遣」的分界 —— 在这类工具里停下来是在思考，
    /// 在别的地方停下来只是歇着。STUCK 判定、宠物是否留守、当日专注
    /// 时长都基于它，与具体工种无关。
    pub fn is_producing(self) -> bool {
        matches!(
            self,
            Self::Editing | Self::Writing | Self::Designing | Self::Data
        )
    }
}

/// 维度一：用户在干什么。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Doing {
    Editing,
    Writing,
    Designing,
    Data,
    Messaging,
    Browsing,
    Watching,
    Other,
    /// 长时间无任何输入，人已离开。
    Away,
}

impl Doing {
    /// 是否属于「专注产出」。语义与 `AppKind::is_producing` 一致。
    pub fn is_producing(self) -> bool {
        matches!(
            self,
            Self::Editing | Self::Writing | Self::Designing | Self::Data
        )
    }
}

/// 维度二：用户的节奏。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Tempo {
    /// 高频连续输入，进入状态。
    Flow,
    Normal,
    /// 在编辑器里但长时间没敲键 —— 在思考，或在等 AI 跑完。
    /// 这是 vibe coding 场景独有的信号，普通桌宠感知不到。
    Stuck,
    /// 长时间无输入。
    Resting,
}

/// 传感器采样快照。所有字段都不含任何隐私内容 ——
/// 只有「距上次按键多少秒」，绝不涉及键位本身。
#[derive(Debug, Clone, Copy)]
pub struct Snapshot {
    pub app: AppKind,
    /// 距上次键盘事件的秒数。
    pub keyboard_idle_secs: f64,
    /// 每分钟击键次数，用于律动同步。
    pub keystrokes_per_min: f64,
    /// 本地小时（0–23），用于判断深夜。
    pub hour: u8,
}

/// 推导出的宠物状态。
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
pub struct PetState {
    pub doing: Doing,
    pub tempo: Tempo,
    /// 深夜修饰符：宠物会加黑眼圈、律动放缓。
    pub late_night: bool,
    /// 透传给前端做律动同步。
    pub keystrokes_per_min: f64,
    /// 当前心情。
    pub mood: Mood,
    /// 更细的活动场景。
    pub activity: Activity,
}

/// 无输入超过此时长即判定人已离开（宠物睡觉）。
const AWAY_SECS: f64 = 600.0;

/// 在编辑器里但键盘静默超过此时长 → STUCK。
/// 90 秒足够区分「短暂停顿」与「真的在想事情 / 在等 AI」。
const STUCK_SECS: f64 = 90.0;

/// 达到此击键频率视为进入 FLOW。
/// 120 次/分 ≈ 每秒 2 键，是持续编码的典型下限。
const FLOW_KPM: f64 = 120.0;

/// 深夜时段起点（含）。
const LATE_NIGHT_FROM: u8 = 23;
/// 深夜时段终点（不含）。
const LATE_NIGHT_TO: u8 = 5;

/// 仅供不依赖心情与活动的纯状态测试使用。
#[cfg(test)]
pub fn derive(s: Snapshot) -> PetState {
    derive_with(s, crate::mood::Mood::Focused, crate::activity::Activity::Working)
}

/// 完整推导，包含心情与活动。
///
/// derive() 保留给不依赖这两个维度的纯状态测试。
pub fn derive_with(s: Snapshot, mood: Mood, activity: Activity) -> PetState {
    let doing = if s.keyboard_idle_secs >= AWAY_SECS {
        Doing::Away
    } else {
        match s.app {
            AppKind::Editing => Doing::Editing,
            AppKind::Writing => Doing::Writing,
            AppKind::Designing => Doing::Designing,
            AppKind::Data => Doing::Data,
            AppKind::Messaging => Doing::Messaging,
            AppKind::Browsing => Doing::Browsing,
            AppKind::Watching => Doing::Watching,
            AppKind::Other => Doing::Other,
        }
    };

    let tempo = if s.keyboard_idle_secs >= AWAY_SECS {
        Tempo::Resting
    } else if s.keyboard_idle_secs >= STUCK_SECS {
        // STUCK 专指「在产出型工具里发呆」。不在产出时，静默只是普通歇着，
        // 宠物应该自娱自乐而不是陪你盯屏幕。
        if s.app.is_producing() {
            Tempo::Stuck
        } else {
            Tempo::Resting
        }
    } else if s.keystrokes_per_min >= FLOW_KPM {
        Tempo::Flow
    } else {
        Tempo::Normal
    };

    PetState {
        doing,
        tempo,
        late_night: s.hour >= LATE_NIGHT_FROM || s.hour < LATE_NIGHT_TO,
        keystrokes_per_min: s.keystrokes_per_min,
        mood,
        activity,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn editing() -> Snapshot {
        Snapshot {
            app: AppKind::Editing,
            keyboard_idle_secs: 1.0,
            keystrokes_per_min: 30.0,
            hour: 14,
        }
    }

    #[test]
    fn 编辑器内正常敲键为_editing_normal() {
        let st = derive(editing());
        assert_eq!(st.doing, Doing::Editing);
        assert_eq!(st.tempo, Tempo::Normal);
    }

    #[test]
    fn 高频击键进入_flow() {
        let st = derive(Snapshot {
            keystrokes_per_min: 200.0,
            ..editing()
        });
        assert_eq!(st.tempo, Tempo::Flow);
    }

    #[test]
    fn 编辑器内键盘静默九十秒进入_stuck() {
        let st = derive(Snapshot {
            keyboard_idle_secs: 95.0,
            keystrokes_per_min: 0.0,
            ..editing()
        });
        assert_eq!(st.doing, Doing::Editing);
        assert_eq!(
            st.tempo,
            Tempo::Stuck,
            "在产出型工具里发呆是在想事情，宠物应陪你盯屏幕"
        );
    }

    #[test]
    fn 任何产出型工具里发呆都算_stuck() {
        // 不只是写代码 —— 写方案、画设计稿、对表格时停下来同样是在想
        for app in [
            AppKind::Editing,
            AppKind::Writing,
            AppKind::Designing,
            AppKind::Data,
        ] {
            let st = derive(Snapshot {
                app,
                keyboard_idle_secs: 120.0,
                keystrokes_per_min: 0.0,
                ..editing()
            });
            assert_eq!(st.tempo, Tempo::Stuck, "{app:?} 里发呆应判为在思考");
        }
    }

    #[test]
    fn 非产出型工具静默只是歇着而非_stuck() {
        for app in [
            AppKind::Browsing,
            AppKind::Messaging,
            AppKind::Watching,
            AppKind::Other,
        ] {
            let st = derive(Snapshot {
                app,
                keyboard_idle_secs: 95.0,
                keystrokes_per_min: 0.0,
                ..editing()
            });
            assert_eq!(
                st.tempo,
                Tempo::Resting,
                "{app:?} 不该触发 STUCK，宠物应自娱自乐"
            );
        }
    }

    #[test]
    fn 静默未满阈值仍是_normal() {
        let st = derive(Snapshot {
            keyboard_idle_secs: STUCK_SECS - 1.0,
            keystrokes_per_min: 0.0,
            ..editing()
        });
        assert_eq!(st.tempo, Tempo::Normal, "短暂停顿不应误判为卡住");
    }

    #[test]
    fn 超过十分钟无输入判定离开() {
        let st = derive(Snapshot {
            keyboard_idle_secs: AWAY_SECS + 1.0,
            keystrokes_per_min: 0.0,
            ..editing()
        });
        assert_eq!(st.doing, Doing::Away, "人已离开，宠物该睡觉");
        assert_eq!(st.tempo, Tempo::Resting);
    }

    #[test]
    fn 离开判定优先于应用类别() {
        // 即便前台还停在编辑器，十分钟没动就是离开了，不该是 STUCK
        let st = derive(Snapshot {
            app: AppKind::Editing,
            keyboard_idle_secs: AWAY_SECS + 100.0,
            keystrokes_per_min: 0.0,
            ..editing()
        });
        assert_eq!(st.doing, Doing::Away);
        assert_ne!(st.tempo, Tempo::Stuck);
    }

    #[test]
    fn 深夜修饰符在凌晨与午夜后生效() {
        for h in [23, 0, 3, 4] {
            let st = derive(Snapshot { hour: h, ..editing() });
            assert!(st.late_night, "{h} 点应属深夜");
        }
    }

    #[test]
    fn 白天不触发深夜修饰符() {
        for h in [5, 9, 14, 22] {
            let st = derive(Snapshot { hour: h, ..editing() });
            assert!(!st.late_night, "{h} 点不应属深夜");
        }
    }

    #[test]
    fn 击键频率原样透传供律动同步() {
        let st = derive(Snapshot {
            keystrokes_per_min: 173.5,
            ..editing()
        });
        assert_eq!(st.keystrokes_per_min, 173.5);
    }

    #[test]
    fn 产出与消遣的分界与工种无关() {
        for app in [
            AppKind::Editing,
            AppKind::Writing,
            AppKind::Designing,
            AppKind::Data,
        ] {
            assert!(app.is_producing(), "{app:?} 应算专注产出");
        }
        for app in [
            AppKind::Messaging,
            AppKind::Browsing,
            AppKind::Watching,
            AppKind::Other,
        ] {
            assert!(!app.is_producing(), "{app:?} 不该算专注产出");
        }
        // Doing 侧与 AppKind 侧判定必须一致，否则状态机会自相矛盾
        for (app, doing) in [
            (AppKind::Editing, Doing::Editing),
            (AppKind::Writing, Doing::Writing),
            (AppKind::Designing, Doing::Designing),
            (AppKind::Data, Doing::Data),
            (AppKind::Messaging, Doing::Messaging),
            (AppKind::Browsing, Doing::Browsing),
            (AppKind::Watching, Doing::Watching),
            (AppKind::Other, Doing::Other),
        ] {
            assert_eq!(app.is_producing(), doing.is_producing(), "{app:?}");
        }
        assert!(!Doing::Away.is_producing());
    }
}
