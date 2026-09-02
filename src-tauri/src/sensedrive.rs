//! 传感器 → 状态机 → 前端 的驱动循环。

use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::{AppHandle, Emitter};

use crate::activity;
use crate::appclass::{self, Overrides};
use crate::configcmd;
use crate::habitmemory;
use crate::memory;
use crate::mood::MoodMeter;
use crate::react::Reactor;
use crate::sensor::{self, KeystrokeRate};
use crate::state::{self, PetState, Snapshot};

/// 快层采样间隔（打字期间）。
///
/// 必须足够密才能靠「空闲秒数归零」检测到单次击键 —— 间隔若大于按键
/// 间隙，快速打字会被漏计。120ms 对应约 8 次/秒的检测上限，配合滑动
/// 窗口足以区分 FLOW 与普通节奏，同时 CPU 开销可忽略。
///
/// 只在键盘活跃期保持此密度（见 IDLE_BACKOFF_INTERVAL）。
const SAMPLE_INTERVAL: Duration = Duration::from_millis(120);

/// 空闲退避间隔。
///
/// 击键检测靠「空闲秒数变小」判定新按键 —— 空闲持续递增时不存在归零
/// 检测需求。空闲超过 IDLE_BACKOFF_AFTER 秒后退避到 500ms；用户回来
/// 后的第一次采样天然重建基线，至多漏掉退避期开头几次击键，对 5 秒
/// 窗口的 kpm 估算无感。
const IDLE_BACKOFF_INTERVAL: Duration = Duration::from_millis(500);

/// 锁屏后退避间隔：人不在，一切信号静止，1 秒足够。
const LOCKED_INTERVAL: Duration = Duration::from_secs(1);

/// 空闲超过此秒数后退避到 IDLE_BACKOFF_INTERVAL。
const IDLE_BACKOFF_AFTER: f64 = 5.0;

/// 慢层间隔：前台应用 / 环境信号 / 记忆推进的采样粒度。
///
/// 应用切换与情绪变化都是秒级现象，1 秒足够。慢层信号缓存后由快层
/// 复用 —— 快层不必每 120ms 付 NSWorkspace / NSCalendar 的 ObjC 成本。
const SLOW_INTERVAL: Duration = Duration::from_secs(1);

/// 击键频率的滑动窗口长度。
///
/// 太短会让律动忽快忽慢，太长则跟不上节奏变化。5 秒是手感折中。
const RATE_WINDOW: Duration = Duration::from_secs(5);

/// 状态变化推送事件名。
pub const EVENT_STATE: &str = "pet://state";

/// 由小时近似推出「当天已过秒数」。用于记忆跨天清零判断 ——
/// 用本地时钟而非 UTC，避免白天出现假跨天。
fn day_secs(hour: u8) -> f64 {
    hour as f64 * 3600.0
}

/// 由键盘空闲与锁屏状态决定下一轮采样间隔（纯函数，可测）。
///
/// 退避的安全性依据：击键检测靠「空闲秒数变小」判定新按键，
/// 空闲持续递增期间不存在该信号；恢复 120ms 后的第一次采样天然重建
/// 基线（首拍只会记一次击键，由滑动窗口平滑）。
fn next_interval(idle_secs: f64, screen_locked: bool) -> Duration {
    if screen_locked {
        LOCKED_INTERVAL
    } else if idle_secs > IDLE_BACKOFF_AFTER {
        IDLE_BACKOFF_INTERVAL
    } else {
        SAMPLE_INTERVAL
    }
}

static LAST_PUSHED: Mutex<Option<PetState>> = Mutex::new(None);

/// 读取最近一次推导出的状态（供说话驱动等模块共享）。
pub fn shared_state() -> Option<PetState> {
    LAST_PUSHED.lock().ok().and_then(|g| *g)
}

/// 启动状态感知循环。
pub fn spawn(app: &AppHandle) {
    let app = app.clone();
    std::thread::spawn(move || {
        let mut rate = KeystrokeRate::new(RATE_WINDOW);
        let mut meter = MoodMeter::default();
        let mut reactor = Reactor::new();
        let mut prev_state: Option<PetState> = None;
        let mut logged_unavailable = false;
        // 保留上一次能识别的前台应用。
        //
        // 取不到时（例如前台恰好是宠物自己、或某个无 bundle 的进程）
        // 若退化成空串就会被分类为 Other，宠物会误判「你没在忙」。
        // 沿用上次的值比凭空归零准确得多。
        let mut last_bundle = String::new();
        let mut last = Instant::now();
        // 配置几乎不变，但采样每 120ms 一轮 —— 每轮都 clone 一次 Config
        // （含三个 Vec<String>）纯属浪费。用版本号只在真正变更时重建。
        let mut cfg_version = u64::MAX; // 强制首轮加载
        let mut overrides = Overrides::default();
        let mut persona = crate::config::Persona::default();

        // 慢层缓存：秒级信号存这里，快层直接复用
        let mut hour: u8 = 0;
        let mut front_pid: Option<i32> = None;
        let mut env = crate::envsense::EnvSignals::default();
        let mut next_slow = Instant::now(); // 首轮立即做一次慢层采集
        let mut slow_acc = 0.0_f64; // 距上次慢层推进累计的秒数

        let mut interval = SAMPLE_INTERVAL;

        loop {
            std::thread::sleep(interval);

            // 快层：只取键盘空闲秒数 —— 单次 C 调用，无 ObjC 无分配。
            // 其余信号全部走慢层缓存，快层不再为整份 RawSample 付费。
            let Some(idle) = sensor::keyboard_idle_secs() else {
                if !logged_unavailable {
                    logged_unavailable = true;
                    eprintln!("[sensor] 采集不可用（当前平台未实现），状态感知已停用");
                }
                continue;
            };

            let now = Instant::now();
            let dt = now.duration_since(last).as_secs_f64();
            last = now;

            let kpm = rate.update(idle, now);

            // 动态间隔：空闲退避 / 锁屏退避。锁屏状态来自慢层缓存
            // （envsense 内部 1 秒刷新），最多滞后一轮。
            interval = next_interval(idle, env.screen_locked);

            // —— 慢层：秒级信号采集 ——
            // 本轮 dt 先记账再判断是否到期，避免慢层触发轮把自己的 dt 丢掉
            slow_acc += dt;
            let slow_due = now >= next_slow;
            let mut slow_dt = 0.0;
            if slow_due {
                next_slow = now + SLOW_INTERVAL;
                slow_dt = slow_acc;
                slow_acc = 0.0;

                if let Some(raw) = sensor::sample() {
                    hour = raw.hour;
                }
                // 前台应用与 pid 一起取：pid 交给 envsense 扫进程树
                if let Some(app) = sensor::frontmost_app() {
                    last_bundle = app.bundle_id;
                    front_pid = Some(app.pid);
                }
                // Tier-0 环境信号（锁屏 / 麦克风 / 视频断言 / 构建 / 专注模式）。
                // 内部按信号轻重节流，这里每轮调用只取缓存。
                env = crate::envsense::poll(front_pid);

                // 配置变了就重读，让用户改完分类规则立刻生效，无需重启
                let v = configcmd::config_version();
                if v != cfg_version {
                    let cfg = configcmd::current();
                    overrides = Overrides {
                        coding: cfg.coding_apps,
                        browsing: cfg.browsing_apps,
                        other: cfg.excluded_apps,
                    };
                    persona = cfg.persona;
                    cfg_version = v;
                }
            }
            let bundle = &last_bundle;

            let snap = Snapshot {
                app: appclass::classify(bundle, &overrides),
                keyboard_idle_secs: idle,
                keystrokes_per_min: kpm,
                hour,
                mic_in_use: env.mic_in_use,
                screen_locked: env.screen_locked,
                display_video: env.display_video,
                build_running: env.build_running,
                dnd_on: env.dnd_on,
            };

            let mood = meter.update(&snap, dt);
            let act = activity::detect(&snap, bundle);
            let next = state::derive_with(snap, mood, act);

            // 记忆推进（慢层节奏）：内部按 dt 累计，1 秒一批与逐轮等价。
            // 当日记忆推进（跨天自动清零）
            if slow_dt > 0.0 {
                memory::update(&next, slow_dt, day_secs(hour));
                // 专注判定喂数（2026-08-31 设计 P1）：番茄工作期才累计，
                // 未激活时是空操作，无番茄的用户零成本。
                crate::focus::sample(
                    crate::focus::on_task_now(
                        snap.app.is_producing(),
                        snap.keyboard_idle_secs,
                    ),
                    bundle,
                    slow_dt,
                );
                // 习惯记忆推进（跨天落盘，滚动保留 14 天）
                if let Some(ctx) = crate::reminddrive::local_now() {
                    habitmemory::observe(
                        &next,
                        snap.app,
                        slow_dt,
                        &ctx.date,
                        (ctx.minutes / 60) as u8,
                    );
                }
            }

            // 行为即时反应（非 LLM）：状态迁移的那一刻冒一句。
            // 宠物不在家（串门中）不说话；专注模式开着也不说 ——
            // 用户已经用系统开关表达了「别打扰」。
            if !crate::socialdrive::is_away() && !next.dnd_on {
                if let Some(line) = reactor.feed(
                    persona,
                    prev_state.as_ref(),
                    &next,
                    &memory::snapshot(),
                ) {
                    // 番茄工作期 / 刚展示过插件卡片：即时反应让位并直接丢弃 ——
                    //「你进入心流了」延迟 25 分钟再说毫无意义（番茄设计 2.2）。
                    // feed 的状态跟踪（stuck 计时等）不受影响，只是不说话。
                    if !crate::plugin::arbiter::allow_ambient() {
                        eprintln!("[react] 仲裁静默期，丢弃：{line}");
                    } else {
                        eprintln!("[react] {line}");
                        let _ = app.emit(
                            crate::talkdrive::EVENT_TALK,
                            crate::talkdrive::Talk {
                                text: line.to_string(),
                                source: crate::talkdrive::TalkSource::Local,
                            },
                        );
                    }
                }
            }
            prev_state = Some(next);

            // 只在状态真正变化时推送。
            // 律动需要连续的 kpm，但那属于高频数据，不该每 120ms 就触发
            // 一次前端状态切换 —— 因此比较时忽略 kpm 的细微波动。
            let should_push = {
                let mut guard = match LAST_PUSHED.lock() {
                    Ok(g) => g,
                    Err(_) => continue,
                };
                let changed = match guard.as_ref() {
                    None => true,
                    Some(prev) => {
                        prev.doing != next.doing
                            || prev.tempo != next.tempo
                            || prev.late_night != next.late_night
                            || prev.mood != next.mood
                            || prev.activity != next.activity
                            || prev.dnd_on != next.dnd_on
                            || (prev.keystrokes_per_min - next.keystrokes_per_min).abs() > 12.0
                    }
                };
                if changed {
                    *guard = Some(next);
                }
                changed
            };

            if should_push {
                // 活跃的环境信号附在日志尾，便于排查「为什么判成开会/等待」
                let mut env_tags = String::new();
                if env.mic_in_use {
                    env_tags.push_str(" mic");
                }
                if env.screen_locked {
                    env_tags.push_str(" lock");
                }
                if env.display_video {
                    env_tags.push_str(" video");
                }
                if env.build_running {
                    env_tags.push_str(" build");
                }
                if env.dnd_on {
                    env_tags.push_str(" dnd");
                }
                eprintln!(
                    "[sensor] {:?} × {:?} mood={:?} act={:?}{} kpm={:.0} app={}{}",
                    next.doing,
                    next.tempo,
                    next.mood,
                    next.activity,
                    if next.late_night { " (late)" } else { "" },
                    next.keystrokes_per_min,
                    if bundle.is_empty() { "?" } else { &bundle },
                    env_tags,
                );
                if let Err(e) = app.emit(EVENT_STATE, next) {
                    eprintln!("[sensor] emit failed: {e:?}");
                }
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 打字期保持密集采样() {
        // 空闲未达阈值：120ms —— 击键归零检测精度不能损失
        assert_eq!(next_interval(0.5, false), SAMPLE_INTERVAL);
        assert_eq!(next_interval(IDLE_BACKOFF_AFTER, false), SAMPLE_INTERVAL);
    }

    #[test]
    fn 空闲退避到慢速档() {
        // 空闲持续递增期间不存在归零检测需求
        assert_eq!(next_interval(IDLE_BACKOFF_AFTER + 0.01, false), IDLE_BACKOFF_INTERVAL);
        assert_eq!(next_interval(600.0, false), IDLE_BACKOFF_INTERVAL);
    }

    #[test]
    fn 锁屏优先退避到最慢档() {
        // 锁屏即人不在，即便键盘空闲值很小（理论上锁屏时不可能小）
        assert_eq!(next_interval(0.0, true), LOCKED_INTERVAL);
        assert_eq!(next_interval(999.0, true), LOCKED_INTERVAL);
    }

    #[test]
    fn 恢复期第一次采样重建基线() {
        // 退避 → 用户回来打字：第一次采样空闲变小即记一次击键，
        // 之后回落 120ms 密集档。这正是 KeystrokeRate 的既有语义。
        let mut r = KeystrokeRate::new(RATE_WINDOW);
        let t0 = Instant::now();
        // 首拍建基线（首拍必记一次，是既有文档行为，与本测试无关）
        r.update(299.0, t0);
        // 退避期：空闲递增，不记击键
        let idle_backoff = r.update(300.5, t0 + IDLE_BACKOFF_INTERVAL);
        assert_eq!(idle_backoff, 12.0, "退避期空闲递增，只剩首拍那一次");
        // 回来打字：空闲骤降，必须被记为新击键
        let resumed = r.update(0.1, t0 + IDLE_BACKOFF_INTERVAL * 2);
        assert!(resumed > 12.0, "恢复期首次采样必须捕捉到击键");
    }
}
