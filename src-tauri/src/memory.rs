//! 当日工作记忆。
//!
//! 设计文档 4.x「简单 memory」的最小可行实现：不做对话历史、不做向量化，
//! 只累计当天的**行为事实**（写了多久、进入状态多久、连续没休息多久、
//! 记了几条速记），据此推断疲劳程度，喂给 system prompt 与即时反应。
//!
//! 这是「宠物记得你今天干了什么」的全部来源 —— 足够小，绝不会出错，
//! 也不会越攒越占内存（跨天自动清零）。

use std::sync::Mutex;

use crate::state::{Doing, PetState, Tempo};

/// 连续工作超过此秒数（45 分钟）→ 久坐，该起来走走。
const LONG_SIT_SECS: f64 = 45.0 * 60.0;
/// 当日编码超过此秒数（5 小时）→ 过劳。
const OVERWORK_SECS: f64 = 5.0 * 3600.0;
/// 连续心流超过此秒数（50 分钟）→ 高强度输出，也累。
const LONG_FLOW_SECS: f64 = 50.0 * 60.0;

/// 当日记忆快照。全部为「事实量」，不掺判断。
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct DayMemory {
    /// 当天 0 点起的秒数，用于跨天清零判断。
    pub day_secs: f64,
    /// 编码类前台累计秒数（含思考/卡住的时间 —— 盯屏幕也是耗神）。
    pub coding_secs: f64,
    /// 其中处于心流（高频输出）的累计秒数。
    pub flow_secs: f64,
    /// 自上次「离开」以来的连续秒数。回来即重新计时。
    pub continuous_secs: f64,
    /// 今日速记条数。
    pub notes: u32,
}

/// 疲劳等级（由事实量推断，非瞬时状态 —— 累是攒出来的）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Fatigue {
    /// 没什么可说的。
    None,
    /// 有点累了：久坐 或 高强度连续输出。
    Tired,
    /// 今天干得太多了：累计编码远超正常一天。
    Overworked,
}

static MEMORY: Mutex<Option<DayMemory>> = Mutex::new(None);

/// 采样推进。dt 为距上次采样的秒数；day_secs 由调用方给（当天已过秒数）。
///
/// 跨天（day_secs 变小）自动清零重计。
pub fn update(s: &PetState, dt: f64, day_secs: f64) {
    if let Ok(mut g) = MEMORY.lock() {
        let mem = g.get_or_insert_with(DayMemory::default);
        if day_secs < mem.day_secs {
            // 跨天了：清零，但保留速记计数没有意义（新的一天），全清
            *mem = DayMemory::default();
        }
        mem.day_secs = day_secs;

        if s.doing == Doing::Away {
            mem.continuous_secs = 0.0; // 人离开了，连续工作断掉
        } else {
            mem.continuous_secs += dt;
            if s.doing == Doing::Coding {
                mem.coding_secs += dt;
                if s.tempo == Tempo::Flow {
                    mem.flow_secs += dt;
                }
            }
        }
    }
}

/// 速记落盘时调用。
pub fn note_added() {
    if let Ok(mut g) = MEMORY.lock() {
        g.get_or_insert_with(DayMemory::default).notes += 1;
    }
}

/// 当前记忆快照。
pub fn snapshot() -> DayMemory {
    MEMORY.lock().ok().and_then(|g| *g).unwrap_or_default()
}

/// 由事实量推断疲劳等级。纯函数。
pub fn fatigue(m: &DayMemory) -> Fatigue {
    if m.coding_secs >= OVERWORK_SECS {
        return Fatigue::Overworked;
    }
    if m.continuous_secs >= LONG_SIT_SECS || m.flow_secs >= LONG_FLOW_SECS {
        return Fatigue::Tired;
    }
    Fatigue::None
}

fn hours(secs: f64) -> f64 {
    (secs / 3600.0 * 10.0).round() / 10.0
}

fn minutes(secs: f64) -> u32 {
    (secs / 60.0).round() as u32
}

/// 生成喂给 system prompt 的「今天」叙述。空记忆返回 None。
///
/// 原则：只陈述可观察事实 + 一句克制的推断，绝不写成汇报。
pub fn summary(m: &DayMemory) -> Option<String> {
    let mut parts: Vec<String> = Vec::new();

    if m.coding_secs >= 15.0 * 60.0 {
        parts.push(format!("今天写码约{}小时", hours(m.coding_secs)));
        if m.flow_secs >= 5.0 * 60.0 {
            parts.push(format!("其中进入状态约{}分钟", minutes(m.flow_secs)));
        }
    }
    if m.continuous_secs >= LONG_SIT_SECS {
        parts.push(format!("已连续{}分钟没休息", minutes(m.continuous_secs)));
    }
    match m.notes {
        0 => {}
        1 => parts.push("记了1条速记".into()),
        n => parts.push(format!("记了{n}条速记")),
    }

    if parts.is_empty() {
        return None;
    }

    let mood = match fatigue(m) {
        Fatigue::Overworked => "。看起来今天干得够多了",
        Fatigue::Tired => "。看起来有点累了",
        Fatigue::None => "",
    };
    Some(format!("{}{mood}", parts.join("，")))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 空记忆无摘要() {
        assert!(summary(&DayMemory::default()).is_none());
    }

    #[test]
    fn 少量编码不出摘要_避免刚坐下就被总结() {
        let m = DayMemory {
            coding_secs: 5.0 * 60.0,
            ..Default::default()
        };
        assert!(summary(&m).is_none());
    }

    #[test]
    fn 累计编码进入摘要() {
        let m = DayMemory {
            coding_secs: 2.0 * 3600.0,
            flow_secs: 30.0 * 60.0,
            notes: 3,
            ..Default::default()
        };
        let s = summary(&m).unwrap();
        assert!(s.contains("2小时"), "{s}");
        assert!(s.contains("30分钟"), "{s}");
        assert!(s.contains("3条速记"), "{s}");
    }

    #[test]
    fn 久坐推断为累() {
        let m = DayMemory {
            continuous_secs: 50.0 * 60.0,
            ..Default::default()
        };
        assert_eq!(fatigue(&m), Fatigue::Tired);
        assert!(summary(&m).unwrap().contains("有点累"));
    }

    #[test]
    fn 累计五小时过劳优先于久坐() {
        let m = DayMemory {
            coding_secs: 5.5 * 3600.0,
            continuous_secs: 50.0 * 60.0,
            ..Default::default()
        };
        assert_eq!(fatigue(&m), Fatigue::Overworked);
        assert!(summary(&m).unwrap().contains("够多"));
    }

    #[test]
    fn 长心流也算累() {
        let m = DayMemory {
            flow_secs: 55.0 * 60.0,
            ..Default::default()
        };
        assert_eq!(fatigue(&m), Fatigue::Tired);
    }
}
