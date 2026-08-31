//! 番茄工作法驱动：工作 → 休息 → 工作 循环。
//!
//! 休息结束时验证：整个休息期内键鼠累计活跃不超过 REST_ALLOWED_ACTIVE_SECS 秒。
//! 认真休息 → 随机发一个今日特效奖励（隔天失效，见 rewards.rs）。
//! 配置关闭时完全静默，状态归零（重新开启从工作期开始）。

use std::time::{Duration, Instant};

use tauri::{AppHandle, Emitter};

use crate::configcmd;
use crate::reminddrive;
use crate::rewards::{self, RewardEffect, RewardsEvent};
use crate::sensor;

/// 番茄阶段事件名。前端用通知条/气泡展示。
pub const EVENT_POMODORO: &str = "pet://pomodoro";

#[derive(serde::Serialize, Clone)]
pub struct PomodoroEvent {
    /// work_start / break_start / break_end
    pub phase: String,
    /// 本阶段分钟数（展示用）。
    pub mins: u32,
    /// 直接给前端的展示文案。
    pub text: String,
}

/// 认真休息的判定：休息期间键鼠累计活跃不超过这么多秒。
///
/// 用累计而非「结束时刻恰好静止」：偶发碰一下键鼠不再导致整次休息判负。
const REST_ALLOWED_ACTIVE_SECS: f64 = 60.0;

/// 循环检查间隔。阶段切换精度到分钟级即可，30 秒足够。
const CHECK_INTERVAL: Duration = Duration::from_secs(30);

enum Phase {
    Idle,
    Working { until: Instant },
    /// 休息期：累计键鼠活跃秒数并记录是否有过成功采样（sensor 可能不可用）。
    Break {
        until: Instant,
        active_secs: f64,
        sampled_any: bool,
        last_poll: Instant,
    },
}

/// 休息判定结果。
enum RestVerdict {
    /// 认真休息：发当天特效奖励。
    WellDone,
    /// 确有采样且累计活跃超预算：判负文案。
    NotRested,
    /// 全程没有一次成功采样：无法判定，中性文案，不奖励也不指责。
    Unknown,
}

/// 纯函数判定：按休息期累计活跃秒数与是否有过成功采样给出结论。
fn judge_rest(active_secs: f64, sampled_any: bool) -> RestVerdict {
    if !sampled_any {
        return RestVerdict::Unknown;
    }
    if active_secs <= REST_ALLOWED_ACTIVE_SECS {
        RestVerdict::WellDone
    } else {
        RestVerdict::NotRested
    }
}

pub fn spawn(app: &AppHandle) {
    let app = app.clone();
    std::thread::spawn(move || {
        let mut phase = Phase::Idle;

        loop {
            std::thread::sleep(CHECK_INTERVAL);

            let cfg = configcmd::current();
            if !cfg.pomodoro.enabled {
                phase = Phase::Idle;
                continue;
            }
            let (work, brk) = (cfg.pomodoro.work_mins, cfg.pomodoro.break_mins);
            let now = Instant::now();

            match phase {
                Phase::Idle => {
                    phase = Phase::Working {
                        until: now + Duration::from_secs(work as u64 * 60),
                    };
                    emit(
                        &app,
                        "work_start",
                        work,
                        format!("番茄开始：专注 {work} 分钟，我在旁边盯着你"),
                    );
                }
                Phase::Working { until } => {
                    if now >= until {
                        // 一个工作期完成（进入休息）—— 用量计数
                        crate::usage::bump(crate::usage::Kind::Pomodoro);
                        phase = Phase::Break {
                            until: now + Duration::from_secs(brk as u64 * 60),
                            active_secs: 0.0,
                            sampled_any: false,
                            last_poll: now,
                        };
                        emit(
                            &app,
                            "break_start",
                            brk,
                            format!("番茄时间到！休息 {brk} 分钟：别碰键盘和鼠标，喝口水活动一下"),
                        );
                    }
                }
                Phase::Break {
                    until,
                    active_secs,
                    sampled_any,
                    last_poll,
                } => {
                    let mut active_secs = active_secs;
                    let mut sampled_any = sampled_any;

                    // 每次轮询先累计本窗口的活跃秒数（含结束前的最后一个窗口）。
                    // idle 表示「最后 N 秒没碰」，反推即得窗口内活跃时长；
                    // 首个窗口从休息开始时刻起算，休息前的活动自动排除（idle ≥ 窗口 → 0）。
                    if let Some(s) = sensor::sample() {
                        let window = now.saturating_duration_since(last_poll).as_secs_f64();
                        let idle = s.keyboard_idle_secs.min(s.mouse_idle_secs);
                        active_secs += (window - idle.min(window)).max(0.0);
                        sampled_any = true;
                    }
                    // 采样失败也推进窗口：测不到的时间按未活跃计，不冤枉用户。
                    let last_poll = now;

                    if now >= until {
                        match judge_rest(active_secs, sampled_any) {
                            RestVerdict::WellDone => {
                                // 认真休息 → 随机特效奖励（隔天失效）
                                let today = reminddrive::local_now()
                                    .map(|c| c.date)
                                    .unwrap_or_default();
                                let granted = rewards::grant_random(&app, &today);
                                let text = match granted {
                                    Some(e) => format!(
                                        "休息得很到位，我很高兴！今天获得特效：{}{}（明日失效）",
                                        e.emoji(),
                                        e.label()
                                    ),
                                    None => {
                                        "休息得很到位！今天的特效已经集齐啦".to_string()
                                    }
                                };
                                push_rewards(&app, &today, granted);
                                emit(&app, "break_end", brk, text);
                            }
                            RestVerdict::Unknown => {
                                // 全程测不到键鼠数据：不指责也不发奖励
                                emit(
                                    &app,
                                    "break_end",
                                    brk,
                                    "这轮休息我没测准，认真歇了下次找我要奖励哦".to_string(),
                                );
                            }
                            RestVerdict::NotRested => {
                                emit(
                                    &app,
                                    "break_end",
                                    brk,
                                    "休息期间动得有点多哦 —— 下个休息认真歇，有奖励的".to_string(),
                                );
                            }
                        }
                        phase = Phase::Working {
                            until: now + Duration::from_secs(work as u64 * 60),
                        };
                        emit(
                            &app,
                            "work_start",
                            work,
                            format!("休息结束，回来专注 {work} 分钟"),
                        );
                    } else {
                        // 休息未结束，把累计器写回状态机
                        phase = Phase::Break {
                            until,
                            active_secs,
                            sampled_any,
                            last_poll,
                        };
                    }
                }
            }
        }
    });
}

fn emit(app: &AppHandle, phase: &str, mins: u32, text: String) {
    eprintln!("[pomodoro] {phase}: {text}");
    let _ = app.emit(
        EVENT_POMODORO,
        PomodoroEvent {
            phase: phase.to_string(),
            mins,
            text,
        },
    );
}

/// 推送当前特效状态给前端（发放奖励后立即同步）。
fn push_rewards(app: &AppHandle, today: &str, granted: Option<RewardEffect>) {
    let _ = app.emit(
        rewards::EVENT_REWARDS,
        RewardsEvent {
            effects: rewards::today_effects(today),
            granted,
        },
    );
}

/// 启动时把已有特效推给前端（今天中途重启不丢奖励）。
pub fn push_initial_rewards(app: &AppHandle) {
    let today = reminddrive::local_now()
        .map(|c| c.date)
        .unwrap_or_default();
    push_rewards(app, &today, None);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 累计活跃在预算内判认真休息() {
        assert!(matches!(judge_rest(0.0, true), RestVerdict::WellDone));
        assert!(matches!(
            judge_rest(REST_ALLOWED_ACTIVE_SECS, true),
            RestVerdict::WellDone
        ));
    }

    #[test]
    fn 累计活跃超预算判休息不认真() {
        assert!(matches!(
            judge_rest(REST_ALLOWED_ACTIVE_SECS + 0.1, true),
            RestVerdict::NotRested
        ));
    }

    #[test]
    fn 全程无采样判未知不冤枉() {
        assert!(matches!(judge_rest(0.0, false), RestVerdict::Unknown));
        assert!(matches!(judge_rest(999.0, false), RestVerdict::Unknown));
    }

    #[test]
    fn 预算常量为六十秒() {
        // 产品要求：休息期间累计键鼠活动不超过一分钟
        assert_eq!(REST_ALLOWED_ACTIVE_SECS, 60.0);
    }

    #[test]
    fn 事件文案包含关键信息() {
        let text = format!("番茄时间到！休息 {} 分钟：别碰键盘和鼠标，喝口水活动一下", 5);
        assert!(text.contains("别碰键盘和鼠标"));
        assert!(text.contains("5 分钟"));
    }
}
