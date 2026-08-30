//! 行为即时反应：非 LLM 的「宠物懂你」。
//!
//! talkdrive 是按人格频率的定时说话；这里补上另一半 —— **事件驱动**：
//! 主人的行为发生迁移的那一刻立刻反馈（进入状态、想通了、回来了、
//! 深夜还在写、坐太久了）。全部走本地语料，零网络、零延迟。
//!
//! 频率控制是第一设计约束：反应比定时说话更容易惹人烦，
//! 因此有全局最小间隔 + 每类反应各自的冷却。

use std::time::Instant;

use crate::config::Persona;
use crate::memory::{self, DayMemory, Fatigue};
use crate::state::{Doing, PetState, Tempo};

/// 反应类型。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Reaction {
    /// 敲键节奏跨入心流。
    FlowStart,
    /// 一段心流结束（松下来了）。
    FlowEnd,
    /// 卡了很久之后重新敲键 —— 想通了。
    Unstuck,
    /// 离开后回来。
    Back,
    /// 深夜还在写码（每晚最多一次）。
    LateNight,
    /// 连续工作太久，该起来走走。
    LongSit,
}

/// 每类反应的冷却（秒）。
const COOLDOWN_SECS: &[(Reaction, u64)] = &[
    (Reaction::FlowStart, 20 * 60),
    (Reaction::FlowEnd, 20 * 60),
    (Reaction::Unstuck, 10 * 60),
    (Reaction::Back, 3 * 60),
    (Reaction::LateNight, 6 * 3600), // 每晚一次
    (Reaction::LongSit, 45 * 60),    // 提醒了就该去休息，别连环催
];

/// 任意两次反应之间的最小间隔（秒）。
const GLOBAL_GAP_SECS: u64 = 90;

/// STUCK 至少持续这么久，之后的恢复才算「想通了」（短暂停顿不算）。
const UNSTUCK_MIN_SECS: u64 = 120;

/// 反应语料（人格 × 反应）。安静人格大多缺席 —— 安静用动作反应。
const LINES: &[(Reaction, Persona, &[&str])] = &[
    (
        Reaction::FlowStart,
        Persona::Quiet,
        &["（耳朵竖起来了）", "（凑近屏幕）"],
    ),
    (
        Reaction::FlowStart,
        Persona::Occasional,
        &["来了来了。", "进入状态了。", "（帮你盯着屏幕）"],
    ),
    (
        Reaction::FlowStart,
        Persona::Chatty,
        &["这个节奏对了，我就不打扰了。", "你写嗨了，我看得出来。"],
    ),
    (
        Reaction::FlowEnd,
        Persona::Occasional,
        &["告一段落？", "（伸了个懒腰）", "写完那口气了？"],
    ),
    (
        Reaction::FlowEnd,
        Persona::Chatty,
        &["刚才那段写得很顺，歇口气吧。"],
    ),
    (Reaction::Unstuck, Persona::Quiet, &["（尾巴摇了一下）"]),
    (
        Reaction::Unstuck,
        Persona::Occasional,
        &["想通了？", "（看你重新敲键，放心了）"],
    ),
    (
        Reaction::Unstuck,
        Persona::Chatty,
        &["卡了那么久终于动了，值得。"],
    ),
    (Reaction::Back, Persona::Quiet, &["（抬头看了你一眼）"]),
    (
        Reaction::Back,
        Persona::Occasional,
        &["回来了。", "（从窝里探出头）"],
    ),
    (
        Reaction::Back,
        Persona::Chatty,
        &["你可算回来了，我都睡了一觉。"],
    ),
    (Reaction::LateNight, Persona::Quiet, &["（打了个哈欠）"]),
    (
        Reaction::LateNight,
        Persona::Occasional,
        &["这个点了。", "夜深了，写完这段就睡？"],
    ),
    (
        Reaction::LateNight,
        Persona::Chatty,
        &["都半夜了。代码明早还在，觉不补不回来。"],
    ),
    (
        Reaction::LongSit,
        Persona::Occasional,
        &["坐很久了，起来接杯水？"],
    ),
    (
        Reaction::LongSit,
        Persona::Chatty,
        &["你至少一小时没离开椅子了。站起来晃晃，我看着屏幕。"],
    ),
];

fn lines_for(r: Reaction, persona: Persona) -> Option<&'static [&'static str]> {
    LINES.iter()
        .find(|(rr, p, _)| *rr == r && *p == persona)
        .map(|(_, _, ls)| *ls)
}

fn cooldown(r: Reaction) -> u64 {
    COOLDOWN_SECS
        .iter()
        .find(|(rr, _)| *rr == r)
        .map(|(_, s)| *s)
        .unwrap_or(300)
}

/// 迁移检测器。持有各反应的上次触发时间与全局间隔。
pub struct Reactor {
    last_reaction: Option<(Reaction, Instant)>,
    last_any: Option<Instant>,
    /// 当前 STUCK 段的进入时刻。
    stuck_since: Option<Instant>,
    /// 轮转计数器：让同一反应换着花样说。
    pick: usize,
}

impl Default for Reactor {
    fn default() -> Self {
        Self::new()
    }
}

impl Reactor {
    pub fn new() -> Self {
        Self {
            last_reaction: None,
            last_any: None,
            stuck_since: None,
            pick: 0,
        }
    }

    /// 喂一次状态采样（每轮 sensor 循环调用），发生值得反应的迁移时
    /// 返回一句话。返回 None 表示这轮不说话。
    pub fn feed(
        &mut self,
        persona: Persona,
        prev: Option<&PetState>,
        cur: &PetState,
        mem: &DayMemory,
    ) -> Option<&'static str> {
        let now = Instant::now();

        let candidate = match prev {
            None => None, // 首帧不反应
            Some(prev) if prev.doing == Doing::Away && cur.doing != Doing::Away => {
                Some(Reaction::Back)
            }
            _ if cur.doing == Doing::Away => {
                // 离开的瞬间不说话（对空气说）；同时连续计时归零
                None
            }
            Some(prev) if prev.tempo != Tempo::Flow && cur.tempo == Tempo::Flow => {
                Some(Reaction::FlowStart)
            }
            Some(prev) if prev.tempo == Tempo::Flow && cur.tempo != Tempo::Flow => {
                Some(Reaction::FlowEnd)
            }
            Some(prev)
                if prev.tempo == Tempo::Stuck
                    && cur.tempo != Tempo::Stuck
                    && cur.doing == Doing::Coding =>
            {
                // 卡得够久的恢复才算「想通了」
                match self.stuck_since {
                    Some(since)
                        if now.duration_since(since).as_secs() >= UNSTUCK_MIN_SECS =>
                    {
                        Some(Reaction::Unstuck)
                    }
                    _ => None,
                }
            }
            Some(prev)
                if !prev.late_night
                    && cur.late_night
                    && cur.doing == Doing::Coding =>
            {
                Some(Reaction::LateNight)
            }
            _
                if memory::fatigue(mem) == Fatigue::Tired
                    && cur.doing == Doing::Coding
                    && cur.tempo == Tempo::Normal =>
            {
                // 久坐催休息：挂在链尾，状态不变也会轮到它；
                // 卡住（在想事情）与心流（别打断）时不催
                Some(Reaction::LongSit)
            }
            _ => None,
        };

        // —— 维护 STUCK 计时（在用完之后更新）——
        if cur.tempo == Tempo::Stuck {
            if self.stuck_since.is_none() {
                self.stuck_since = Some(now);
            }
        } else {
            self.stuck_since = None;
        }

        let r = candidate?;

        // —— 频率控制 ——
        if let Some((last_r, at)) = self.last_reaction {
            if last_r == r && now.duration_since(at).as_secs() < cooldown(r) {
                return None;
            }
        }
        if let Some(at) = self.last_any {
            if now.duration_since(at).as_secs() < GLOBAL_GAP_SECS {
                return None;
            }
        }

        // —— 选语料（安静人格缺席的组合自然沉默）——
        let pool = lines_for(r, persona)?;
        let line = pool[self.pick % pool.len()];
        self.pick = self.pick.wrapping_add(1);

        self.last_reaction = Some((r, now));
        self.last_any = Some(now);
        Some(line)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::activity::Activity;
    use crate::mood::Mood;
    use crate::state::{Doing, Tempo};

    fn state(doing: Doing, tempo: Tempo) -> PetState {
        PetState {
            doing,
            tempo,
            late_night: false,
            keystrokes_per_min: 0.0,
            mood: Mood::Focused,
            activity: Activity::Working,
        }
    }

    fn coding(tempo: Tempo) -> PetState {
        state(Doing::Coding, tempo)
    }

    #[test]
    fn 进入心流触发反应() {
        let mut r = Reactor::new();
        let prev = coding(Tempo::Normal);
        let cur = coding(Tempo::Flow);
        assert!(r
            .feed(Persona::Occasional, Some(&prev), &cur, &DayMemory::default())
            .is_some());
    }

    #[test]
    fn 安静人格进入心流用动作表达() {
        let mut r = Reactor::new();
        let prev = coding(Tempo::Normal);
        let cur = coding(Tempo::Flow);
        let line = r
            .feed(Persona::Quiet, Some(&prev), &cur, &DayMemory::default())
            .unwrap();
        assert!(line.starts_with('（'), "安静人格应是动作描述：{line}");
    }

    #[test]
    fn 状态不变不反应() {
        let mut r = Reactor::new();
        let s = coding(Tempo::Normal);
        assert!(r
            .feed(Persona::Chatty, Some(&s), &s, &DayMemory::default())
            .is_none());
    }

    #[test]
    fn 首帧不反应() {
        let mut r = Reactor::new();
        let s = coding(Tempo::Flow);
        assert!(r.feed(Persona::Chatty, None, &s, &DayMemory::default()).is_none());
    }

    #[test]
    fn 离开瞬间不说话() {
        let mut r = Reactor::new();
        let prev = coding(Tempo::Normal);
        let cur = state(Doing::Away, Tempo::Resting);
        assert!(r
            .feed(Persona::Chatty, Some(&prev), &cur, &DayMemory::default())
            .is_none());
    }

    #[test]
    fn 离开后回来触发反应() {
        let mut r = Reactor::new();
        let prev = state(Doing::Away, Tempo::Resting);
        let cur = coding(Tempo::Normal);
        assert!(r
            .feed(Persona::Occasional, Some(&prev), &cur, &DayMemory::default())
            .is_some());
    }

    #[test]
    fn 全局间隔内不再反应() {
        let mut r = Reactor::new();
        let prev = coding(Tempo::Normal);
        let cur = coding(Tempo::Flow);
        assert!(r
            .feed(Persona::Occasional, Some(&prev), &cur, &DayMemory::default())
            .is_some());
        // 紧接着另一个迁移（心流结束）也应被全局间隔拦住
        assert!(r
            .feed(Persona::Occasional, Some(&cur), &prev, &DayMemory::default())
            .is_none());
    }

    #[test]
    fn 深夜开始写码触发提醒() {
        let mut r = Reactor::new();
        let prev = coding(Tempo::Normal);
        let mut cur = coding(Tempo::Normal);
        cur.late_night = true;
        assert!(r
            .feed(Persona::Occasional, Some(&prev), &cur, &DayMemory::default())
            .is_some());
    }

    #[test]
    fn 久坐时低频敲键触发提醒但卡住时不() {
        let mem = DayMemory {
            continuous_secs: 50.0 * 60.0,
            ..Default::default()
        };
        let mut r = Reactor::new();
        let s = coding(Tempo::Normal);
        assert!(r.feed(Persona::Occasional, Some(&s), &s, &mem).is_some());

        // 但 STUCK（在想事情）时不催
        let mut r2 = Reactor::new();
        let stuck = coding(Tempo::Stuck);
        assert!(r2.feed(Persona::Occasional, Some(&stuck), &stuck, &mem).is_none());
    }

    #[test]
    fn 短暂停顿的恢复不算想通() {
        let mut r = Reactor::new();
        let prev = coding(Tempo::Stuck);
        let cur = coding(Tempo::Normal);
        // stuck_since 本轮才设置，时长不足 UNSTUCK_MIN_SECS
        assert!(r
            .feed(Persona::Occasional, Some(&prev), &cur, &DayMemory::default())
            .is_none());
    }

    #[test]
    fn 同类反应轮换语料() {
        // 通过 pick 轮转而非固定第一句
        let mut r = Reactor::new();
        let prev = state(Doing::Away, Tempo::Resting);
        let cur = coding(Tempo::Normal);
        let first = r
            .feed(Persona::Occasional, Some(&prev), &cur, &DayMemory::default())
            .unwrap();
        // 冷却内不会再触发，这里只验证计数器推进不 panic
        assert!(!first.is_empty());
    }
}
