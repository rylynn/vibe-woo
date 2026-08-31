//! 传感器 → 状态机 → 前端 的驱动循环。

use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::{AppHandle, Emitter};

use crate::activity;
use crate::appclass::{self, Overrides};
use crate::configcmd;
use crate::memory;
use crate::mood::MoodMeter;
use crate::react::Reactor;
use crate::sensor::{self, KeystrokeRate};
use crate::state::{self, PetState, Snapshot};

/// 采样间隔。
///
/// 必须足够密才能靠「空闲秒数归零」检测到单次击键 —— 间隔若大于按键
/// 间隙，快速打字会被漏计。120ms 对应约 8 次/秒的检测上限，配合滑动
/// 窗口足以区分 FLOW 与普通节奏，同时 CPU 开销可忽略。
const SAMPLE_INTERVAL: Duration = Duration::from_millis(120);

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

        loop {
            std::thread::sleep(SAMPLE_INTERVAL);

            let Some(raw) = sensor::sample() else {
                if !logged_unavailable {
                    logged_unavailable = true;
                    eprintln!("[sensor] 采集不可用（当前平台未实现），状态感知已停用");
                }
                continue;
            };

            let now = Instant::now();
            let dt = now.duration_since(last).as_secs_f64();
            last = now;

            let kpm = rate.update(raw.keyboard_idle_secs, now);
            if let Some(b) = sensor::frontmost_bundle_id() {
                last_bundle = b;
            }
            let bundle = &last_bundle;

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

            let snap = Snapshot {
                app: appclass::classify(bundle, &overrides),
                keyboard_idle_secs: raw.keyboard_idle_secs,
                keystrokes_per_min: kpm,
                hour: raw.hour,
            };

            let mood = meter.update(&snap, dt);
            let act = activity::detect(&snap, bundle);
            let next = state::derive_with(snap, mood, act);

            // 当日记忆推进（跨天自动清零）
            memory::update(&next, dt, day_secs(raw.hour));

            // 行为即时反应（非 LLM）：状态迁移的那一刻冒一句。
            // 宠物不在家（串门中）不说话 —— 家里没人听。
            if !crate::socialdrive::is_away() {
                if let Some(line) = reactor.feed(
                    persona,
                    prev_state.as_ref(),
                    &next,
                    &memory::snapshot(),
                ) {
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
                            || (prev.keystrokes_per_min - next.keystrokes_per_min).abs() > 12.0
                    }
                };
                if changed {
                    *guard = Some(next);
                }
                changed
            };

            if should_push {
                eprintln!(
                    "[sensor] {:?} × {:?} mood={:?} act={:?}{} kpm={:.0} app={}",
                    next.doing,
                    next.tempo,
                    next.mood,
                    next.activity,
                    if next.late_night { " (late)" } else { "" },
                    next.keystrokes_per_min,
                    if bundle.is_empty() { "?" } else { &bundle },
                );
                if let Err(e) = app.emit(EVENT_STATE, next) {
                    eprintln!("[sensor] emit failed: {e:?}");
                }
            }
        }
    });
}
