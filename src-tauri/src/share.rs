//! 可上报状态 —— 隐私红线的实现层。
//!
//! 设计文档 7.3（写死，不做成可放宽的配置）：
//!
//! | 上报                     | 绝不上报                     |
//! |--------------------------|------------------------------|
//! | coding/idle/away/offline | 应用名、窗口标题             |
//! | 昵称、形象 id、好友度     | 项目名、文件名、代码内容     |
//! | 最后活跃时间             | 击键内容、任何截屏           |
//!
//! 实现方式是**白名单构造**：不是「从 PetState 里删掉敏感字段」，
//! 而是从零构造只含允许字段的新结构。删字段的方式迟早漏 ——
//! PetState 以后加任何新字段都会自动跟着上报出去。
//!
//! 这层有测试钉死：序列化结果绝不包含敏感词。

use serde::Serialize;

use crate::state::{Doing, PetState};

/// 好友可见的粗粒度状态。只有四档。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ShareState {
    Coding,
    Idle,
    Away,
    /// 客户端超过时限未上报时由服务端判定，本结构不直接产生此值。
    #[allow(dead_code)]
    Offline,
}

/// 上报给同步服务的完整载荷。
#[derive(Debug, Clone, Serialize)]
pub struct SharePayload {
    pub pet_id: String,
    pub nick: String,
    pub state: ShareState,
    /// 好友度 0..100。
    pub affinity: u32,
    /// Unix 秒。
    pub last_seen: i64,
}

/// 从本地状态映射到可上报状态。
///
/// 刻意只看 doing：tempo/mood/activity/kpm 一律不出本机。
/// 好友知道「你在忙」是乐趣；知道「你卡住了/你在摸鱼」
/// 就是监视了。
pub fn share_state_of(s: &PetState) -> ShareState {
    if s.doing == Doing::Away {
        return ShareState::Away;
    }
    // 上报值仍只有 coding/idle/away —— 服务端与旧客户端按这三个值工作。
    // 细分的「在做什么」绝不上报：好友知道你在忙就够了，
    // 知道你是在填表还是在画图就越界了。
    if s.doing.is_producing() {
        ShareState::Coding
    } else {
        ShareState::Idle
    }
}

/// 隐身模式下上报的状态 —— 恒为 Idle，且这是唯一出口。
///
/// 注意：隐身时连「你在忙」都不说。凌晨三点还在忙这件事，
/// 用户应该有权完全不让人看见（设计文档 7.3）。
pub fn share_state_hidden() -> ShareState {
    ShareState::Idle
}

/// 心跳用的状态字符串（隐身在此层生效，不信任调用方）。
///
/// 好友度等其余字段由 socialdrive 直接组包；这个函数只负责
/// 最敏感的部分 ——「你在干什么」的上报口径。
pub fn state_str(s: &PetState, hidden: bool) -> String {
    let st = if hidden {
        share_state_hidden()
    } else {
        share_state_of(s)
    };
    match st {
        ShareState::Coding => "coding".into(),
        ShareState::Idle => "idle".into(),
        ShareState::Away => "away".into(),
        ShareState::Offline => "offline".into(),
    }
}

/// 构造上报载荷（隐身开关在此层生效，不信任调用方）。
pub fn build_payload(
    pet_id: &str,
    nick: &str,
    s: &PetState,
    affinity: u32,
    hidden: bool,
    now_unix: i64,
) -> SharePayload {
    SharePayload {
        pet_id: pet_id.to_string(),
        nick: nick.to_string(),
        state: if hidden {
            share_state_hidden()
        } else {
            share_state_of(s)
        },
        affinity,
        last_seen: now_unix,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::activity::Activity;
    use crate::mood::Mood;
    use crate::state::Tempo;

    fn state(doing: Doing, tempo: Tempo) -> PetState {
        PetState {
            doing,
            tempo,
            late_night: false,
            keystrokes_per_min: 173.0,
            mood: Mood::Frustrated,
            activity: Activity::Slacking,
        }
    }

    #[test]
    fn 状态映射只有三档产出都归忙() {
        // 对外契约：产出型 → coding，消遣型 → idle，离开 → away
        for d in [Doing::Editing, Doing::Writing, Doing::Designing, Doing::Data] {
            assert_eq!(
                share_state_of(&state(d, Tempo::Flow)),
                ShareState::Coding,
                "{d:?}"
            );
        }
        for d in [
            Doing::Messaging,
            Doing::Browsing,
            Doing::Watching,
            Doing::Other,
        ] {
            assert_eq!(
                share_state_of(&state(d, Tempo::Normal)),
                ShareState::Idle,
                "{d:?}"
            );
        }
        assert_eq!(share_state_of(&state(Doing::Away, Tempo::Resting)), ShareState::Away);
    }

    #[test]
    fn 序列化结果绝不包含敏感字段() {
        // 红线测试：把带满敏感数据的 PetState 打进去，
        // 序列化输出里不允许出现任何键位频率/心情/活动痕迹。
        let p = build_payload("pid", "阿咪", &state(Doing::Editing, Tempo::Flow), 42, false, 1770000000);
        let json = serde_json::to_string(&p).unwrap();
        assert!(!json.contains("keystrokes"), "击键频率泄漏：{json}");
        assert!(!json.contains("mood"), "心情泄漏：{json}");
        assert!(!json.contains("activity"), "活动细节泄漏：{json}");
        assert!(!json.contains("tempo"), "节奏泄漏：{json}");
        assert!(!json.contains("bundle"), "应用名泄漏：{json}");
        assert!(json.contains("\"coding\""));
    }

    #[test]
    fn 隐身时恒为idle且不说在忙() {
        let p = build_payload(
            "pid",
            "阿咪",
            &state(Doing::Editing, Tempo::Flow),
            42,
            true,
            1770000000,
        );
        assert_eq!(p.state, ShareState::Idle, "隐身时不得暴露 coding");
    }

    #[test]
    fn PetState_未来加字段也不会自动上报() {
        // 白名单构造的保证：输出结构固定为 SharePayload 的字段，
        // 输入结构加字段不会改变输出。此处用序列化字段数钉死。
        let p = build_payload("p", "n", &state(Doing::Other, Tempo::Normal), 1, false, 0);
        let json: serde_json::Value = serde_json::to_value(&p).unwrap();
        assert_eq!(json.as_object().unwrap().len(), 5, "字段数变化需人工审查红线");
    }
}
