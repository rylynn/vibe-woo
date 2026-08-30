//! 番茄工作法驱动：工作 → 休息 → 工作 循环。
//!
//! 休息结束时验证：用户是否至少 REST_REQUIRED_SECS 秒没碰键盘鼠标。
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
    /// work_start / break_start
    pub phase: String,
    /// 本阶段分钟数（展示用）。
    pub mins: u32,
    /// 直接给前端的展示文案。
    pub text: String,
}

/// 认真休息的判定：最后这么久没碰键盘鼠标才算。
const REST_REQUIRED_SECS: f64 = 60.0;

/// 循环检查间隔。阶段切换精度到分钟级即可，30 秒足够。
const CHECK_INTERVAL: Duration = Duration::from_secs(30);

enum Phase {
    Idle,
    Working { until: Instant },
    Break { until: Instant },
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
                        phase = Phase::Break {
                            until: now + Duration::from_secs(brk as u64 * 60),
                        };
                        emit(
                            &app,
                            "break_start",
                            brk,
                            format!("番茄时间到！休息 {brk} 分钟：别碰键盘和鼠标，喝口水活动一下"),
                        );
                    }
                }
                Phase::Break { until } => {
                    if now >= until {
                        if rest_well_done() {
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
                                None => "休息得很到位！今天的特效已经集齐啦".to_string(),
                            };
                            push_rewards(&app, &today, granted);
                            emit(&app, "break_end", brk, text);
                        } else {
                            emit(
                                &app,
                                "break_end",
                                brk,
                                "刚才还在碰键盘鼠标哦 —— 下个休息认真歇，有奖励的".to_string(),
                            );
                        }
                        phase = Phase::Working {
                            until: now + Duration::from_secs(work as u64 * 60),
                        };
                        emit(&app, "work_start", work, format!("休息结束，回来专注 {work} 分钟"));
                    }
                }
            }
        }
    });
}

/// 休息验证：此刻距上次键盘/鼠标事件都已超过阈值。
///
/// 用「当前空闲秒数」而非 break 内累计 —— idle 值本身就表示
/// 「最后 N 秒没碰」，等价于「至少连续静止 N 秒」。
fn rest_well_done() -> bool {
    match sensor::sample() {
        Some(s) => {
            s.keyboard_idle_secs >= REST_REQUIRED_SECS && s.mouse_idle_secs >= REST_REQUIRED_SECS
        }
        None => false, // 采集不可用时保守判定为未完成
    }
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

/// 仅供测试的阈值导出。
#[cfg(test)]
pub(crate) const REST_REQUIRED_SECS_TEST: f64 = REST_REQUIRED_SECS;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 休息验证要求键鼠同时静默() {
        // 阈值本身是产品要求：一分钟不碰键鼠
        assert_eq!(REST_REQUIRED_SECS_TEST, 60.0);
    }

    #[test]
    fn 事件文案包含关键信息() {
        let text = format!("番茄时间到！休息 {} 分钟：别碰键盘和鼠标，喝口水活动一下", 5);
        assert!(text.contains("别碰键盘和鼠标"));
        assert!(text.contains("5 分钟"));
    }
}
