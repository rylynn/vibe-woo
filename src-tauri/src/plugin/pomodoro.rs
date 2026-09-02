//! 番茄工作法插件（自 `pomodorodrive.rs` 迁入，2026-09-02 P2）。
//!
//! 对照迁移前的四处变化（设计文档 6.4）：
//! - 配置从 `config.json` 的 pomodoro 段搬到 `plugins/pomodoro.json`（单向迁移）
//! - 阶段通知从 `pet://pomodoro` 事件改为 PluginCard；`break_start` 标 High 直通
//! - 阶段切换经 `TickCtx::set_pomodoro_phase` 通知仲裁器（插件→仲裁器的
//!   全系统唯一特例）：工作期其他插件卡片静默，休息期补发
//! - `break_end` 与随后的 `work_start` 合并为一张卡（气泡是单实例，
//!   连发两张只会互相覆盖，合并反而保住两条信息）
//!
//! 原样平移：认真休息判定、rewards 发放、usage 打点。
//!
//! 一处有意偏离设计的说明：禁用态不返回 `None` 而保持 30s 轻量 tick ——
//! `next_tick` 是纯查询拿不到 app 读不了配置，靠 tick 内重读配置感知
//! 开关变化（只读本地文件，无网络无副作用，不违背「禁用不取数」）。

use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

use super::store;
use super::{Plugin, PluginCard, PluginMeta, Priority, ScheduleCtx, TickCtx};

/// 插件 id（同时是配置文件名与前端渲染器 key）。
pub const ID: &str = "pomodoro";

/// 循环检查间隔。阶段切换精度到分钟级即可，30 秒足够（沿袭原实现）。
const CHECK_INTERVAL: Duration = Duration::from_secs(30);

/// 认真休息的判定：休息期间键鼠累计活跃不超过这么多秒。
const REST_ALLOWED_ACTIVE_SECS: f64 = 60.0;

/// 番茄配置。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct PomodoroConfig {
    /// 总开关。关闭即完全静默，状态归零（重新开启从工作期开始）。
    pub enabled: bool,
    pub work_mins: u32,
    pub break_mins: u32,
}

impl Default for PomodoroConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            work_mins: 25,
            break_mins: 5,
        }
    }
}

/// 钳制到合理区间（太短失去意义，太长形同虚设；沿袭原 update_config 的边界）。
fn clamp_cfg(c: PomodoroConfig) -> PomodoroConfig {
    PomodoroConfig {
        enabled: c.enabled,
        work_mins: c.work_mins.clamp(1, 120),
        break_mins: c.break_mins.clamp(1, 60),
    }
}

/// 读配置（带钳制，手改文件也兜得住）。
pub fn load_config(app: &tauri::AppHandle) -> PomodoroConfig {
    clamp_cfg(store::load(app, ID))
}

// ---------- 状态机（纯逻辑，单测入口） ----------

/// 休息判定结果。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum RestVerdict {
    /// 认真休息：发当天特效奖励。
    WellDone,
    /// 确有采样且累计活跃超预算：判负文案。
    NotRested,
    /// 全程没有一次成功采样：无法判定，中性文案，不奖励也不指责。
    Unknown,
}

/// 纯函数判定（原样平移自 pomodorodrive.rs）。
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

/// 一次阶段迁移（纯数据；副作用与文案在 tick 里做）。
#[derive(Debug, Clone, PartialEq, Eq)]
enum Transition {
    WorkStart { mins: u32 },
    BreakStart { mins: u32 },
    /// 休息结束：判定结果 + 随即回到的工作期时长。
    BreakEnd { verdict: RestVerdict, mins: u32 },
}

enum Phase {
    Idle,
    Working { until: Instant },
    /// 休息期：累计键鼠活跃秒数并记录是否有过成功采样。
    Break {
        until: Instant,
        active_secs: f64,
        sampled_any: bool,
        last_poll: Instant,
    },
}

/// 番茄状态机。
struct PomodoroState {
    phase: Phase,
}

fn mins(m: u32) -> Duration {
    Duration::from_secs(m as u64 * 60)
}

impl PomodoroState {
    fn new() -> Self {
        Self {
            phase: Phase::Idle,
        }
    }

    /// 推进一轮。`sample` = (键盘空闲秒, 鼠标空闲秒)，None 表示本轮采样失败
    ///（失败也推进窗口：测不到的时间按未活跃计，不冤枉用户）。
    fn step(
        &mut self,
        cfg: &PomodoroConfig,
        now: Instant,
        sample: Option<(f64, f64)>,
    ) -> Vec<Transition> {
        if !cfg.enabled {
            // 关闭即状态归零，重新开启从工作期开始（原语义）
            self.phase = Phase::Idle;
            return Vec::new();
        }
        let (work, brk) = (cfg.work_mins, cfg.break_mins);
        match std::mem::replace(&mut self.phase, Phase::Idle) {
            Phase::Idle => {
                self.phase = Phase::Working {
                    until: now + mins(work),
                };
                vec![Transition::WorkStart { mins: work }]
            }
            Phase::Working { until } => {
                if now >= until {
                    self.phase = Phase::Break {
                        until: now + mins(brk),
                        active_secs: 0.0,
                        sampled_any: false,
                        last_poll: now,
                    };
                    vec![Transition::BreakStart { mins: brk }]
                } else {
                    self.phase = Phase::Working { until };
                    Vec::new()
                }
            }
            Phase::Break {
                until,
                mut active_secs,
                mut sampled_any,
                last_poll,
            } => {
                // 累计本窗口的活跃秒数：idle 表示「最后 N 秒没碰」，
                // 反推即得窗口内活跃时长；首个窗口从休息开始时刻起算。
                if let Some((kb, mouse)) = sample {
                    let window = now.saturating_duration_since(last_poll).as_secs_f64();
                    let idle = kb.min(mouse);
                    active_secs += (window - idle.min(window)).max(0.0);
                    sampled_any = true;
                }
                if now >= until {
                    let verdict = judge_rest(active_secs, sampled_any);
                    self.phase = Phase::Working {
                        until: now + mins(work),
                    };
                    vec![Transition::BreakEnd { verdict, mins: work }]
                } else {
                    self.phase = Phase::Break {
                        until,
                        active_secs,
                        sampled_any,
                        last_poll: now,
                    };
                    Vec::new()
                }
            }
        }
    }

    fn is_working(&self) -> bool {
        matches!(self.phase, Phase::Working { .. })
    }

    fn phase_kind(&self) -> &'static str {
        match self.phase {
            Phase::Idle => "idle",
            Phase::Working { .. } => "working",
            Phase::Break { .. } => "break",
        }
    }
}

// ---------- 插件本体 ----------

/// 左键面板摘要（跨线程共享：宿主线程写，plugin_summary 命令读）。
#[derive(Debug, Clone, Serialize)]
struct SummaryView {
    enabled: bool,
    phase: &'static str,
    pomodoros_today: u32,
}

static SUMMARY: Mutex<Option<SummaryView>> = Mutex::new(None);

pub struct PomodoroPlugin {
    state: PomodoroState,
    /// 仲裁器上次已知的工作期状态（边沿触发，避免重复 drain）。
    arbiter_working: bool,
}

impl PomodoroPlugin {
    pub fn new(app: &tauri::AppHandle) -> Self {
        migrate_legacy(app);
        // 启动时把今天已有的特效推给前端（今天中途重启不丢奖励，原语义）
        let today = crate::reminddrive::local_now()
            .map(|c| c.date)
            .unwrap_or_default();
        push_rewards(app, &today, None);
        Self {
            state: PomodoroState::new(),
            arbiter_working: false,
        }
    }
}

impl Plugin for PomodoroPlugin {
    fn id(&self) -> &'static str {
        ID
    }

    fn name(&self) -> &'static str {
        "番茄工作法"
    }

    fn next_tick(&self, _ctx: &ScheduleCtx) -> Option<Duration> {
        // 禁用态也保持轻量 tick（见模块注释）
        Some(CHECK_INTERVAL)
    }

    fn tick(&mut self, ctx: &mut TickCtx) -> Vec<PluginCard> {
        let cfg = load_config(ctx.app);
        let now = Instant::now();
        let sample = crate::sensor::sample()
            .map(|s| (s.keyboard_idle_secs, s.mouse_idle_secs));
        let transitions = self.state.step(&cfg, now, sample);

        let mut cards = Vec::new();
        for t in transitions {
            match t {
                // 阶段切换卡全部 High：番茄的每个相位迁移都是用户显式开启的、
                // 必须立刻送达的时刻。尤其 work_start —— tick 里刚置位「工作期」，
                // host 随后才 offer 卡，Normal 会被自己设的闸门吞到休息期才补发。
                Transition::WorkStart { mins } => {
                    // 专注判定开始累计（sensedrive 持续喂数，见 focus.rs）
                    crate::focus::start();
                    cards.push(make_card(
                        "work_start",
                        mins,
                        format!("番茄开始：专注 {mins} 分钟，我在旁边盯着你"),
                        Priority::High,
                        8,
                    ))
                }
                Transition::BreakStart { mins } => {
                    // 一个工作期完成（进入休息）—— 用量计数（原语义）
                    crate::usage::bump(crate::usage::Kind::Pomodoro);
                    // 专注判定出口（2026-08-31 设计 P1/P2）：Deep 发成长值
                    //（无穷尽），Normal 只计数 —— 判定只用于发奖励，绝不惩罚。
                    let (grade, focus_secs) = crate::focus::finish();
                    let today = crate::reminddrive::local_now()
                        .map(|c| c.date)
                        .unwrap_or_default();
                    let gained =
                        crate::stats::on_pomodoro(grade, focus_secs, &today, ctx.app);
                    // Deep 的 12% 稀有掉落：额外掉一个未拥有的特效
                    //（池满时 grant_random 返回 None，自然退化为只给成长值）
                    let rare = if crate::stats::rare_drop_rolled(grade) {
                        crate::rewards::grant_random(ctx.app, &today)
                    } else {
                        None
                    };
                    if rare.is_some() {
                        push_rewards(ctx.app, &today, rare);
                    }
                    let deep_note = match grade {
                        crate::focus::Grade::Deep => {
                            format!("这轮专注得很深！成长值 +{gained}\n")
                        }
                        crate::focus::Grade::Normal => String::new(),
                    };
                    // 停留 10 分钟：休息开始是必须被看见的时刻，
                    // 无人互动也别提前消失（原通知条语义）
                    cards.push(make_card(
                        "break_start",
                        mins,
                        format!("{deep_note}番茄时间到！休息 {mins} 分钟：别碰键盘和鼠标，喝口水活动一下"),
                        Priority::High,
                        600,
                    ));
                }
                Transition::BreakEnd { verdict, mins } => {
                    let today = crate::reminddrive::local_now()
                        .map(|c| c.date)
                        .unwrap_or_default();
                    let granted = match verdict {
                        RestVerdict::WellDone => {
                            crate::rewards::grant_random(ctx.app, &today)
                        }
                        _ => None,
                    };
                    push_rewards(ctx.app, &today, granted);
                    let text = format!(
                        "{}\n休息结束，回来专注 {mins} 分钟",
                        break_end_text(verdict, granted)
                    );
                    cards.push(make_card("break_end", mins, text, Priority::High, 8));
                }
            }
        }

        // 仲裁器同步（边沿触发）：进入/退出工作期，以及中途关掉番茄
        let working = self.state.is_working();
        if working != self.arbiter_working {
            self.arbiter_working = working;
            ctx.set_pomodoro_phase(working);
        }

        let summary = SummaryView {
            enabled: cfg.enabled,
            phase: self.state.phase_kind(),
            pomodoros_today: crate::usage::snapshot()
                .map(|s| s.pomodoros)
                .unwrap_or(0),
        };
        if let Ok(mut g) = SUMMARY.lock() {
            *g = Some(summary);
        }

        cards
    }
}

fn break_end_text(verdict: RestVerdict, granted: Option<crate::rewards::RewardEffect>) -> String {
    match verdict {
        RestVerdict::WellDone => match granted {
            Some(e) => format!(
                "休息得很到位，我很高兴！今天获得特效：{}{}（明日失效）",
                e.emoji(),
                e.label()
            ),
            None => "休息得很到位！今天的特效已经集齐啦".to_string(),
        },
        RestVerdict::Unknown => {
            "这轮休息我没测准，认真歇了下次找我要奖励哦".to_string()
        }
        RestVerdict::NotRested => {
            "休息期间动得有点多哦 —— 下个休息认真歇，有奖励的".to_string()
        }
    }
}

fn make_card(
    phase: &str,
    mins: u32,
    text: String,
    priority: Priority,
    ttl_secs: u32,
) -> PluginCard {
    PluginCard {
        plugin_id: ID.into(),
        kind: ID.into(),
        priority,
        ttl_secs,
        payload: serde_json::json!({ "phase": phase, "mins": mins, "text": text }),
    }
}

/// 推送当前特效状态给前端（发放奖励后立即同步）。
fn push_rewards(app: &tauri::AppHandle, today: &str, granted: Option<crate::rewards::RewardEffect>) {
    use tauri::Emitter;
    let _ = app.emit(
        crate::rewards::EVENT_REWARDS,
        crate::rewards::RewardsEvent {
            effects: crate::rewards::today_effects(today),
            granted,
        },
    );
}

/// 左键面板 / 设置用的元信息。
pub fn meta(app: &tauri::AppHandle) -> PluginMeta {
    let cfg = load_config(app);
    let s = SUMMARY.lock().ok().and_then(|g| g.clone());
    let (phase, pomodoros) = match s {
        Some(v) => (v.phase, v.pomodoros_today),
        None => ("idle", 0),
    };
    let today = crate::reminddrive::local_now()
        .map(|c| c.date)
        .unwrap_or_default();
    let st = crate::stats::snapshot(&today);
    PluginMeta {
        id: ID.into(),
        name: "番茄工作法".into(),
        kind: ID.into(),
        summary: serde_json::json!({
            "enabled": cfg.enabled,
            "phase": phase,
            "pomodoros_today": pomodoros,
            "deep_count": st.deep_count,
            "bond": st.bond,
            "focus_secs": st.focus_secs,
            "week_active": st.active_days.iter().filter(|d| **d).count(),
        }),
    }
}

// ---------- 配置迁移 ----------

/// 从 config.json 原文里取出 pomodoro 段（并从原文移除）。无段返回 None。
fn extract_legacy(v: &mut serde_json::Value) -> Option<PomodoroConfig> {
    let section = v.get("pomodoro").cloned()?;
    if let Some(obj) = v.as_object_mut() {
        obj.remove("pomodoro");
    }
    serde_json::from_value(section).ok()
}

/// 一次性迁移：把 config.json 的 pomodoro 段搬进 plugins/pomodoro.json。
/// 只要旧段存在就搬（含默认值 —— 搬完删段，保持单向不回写）；
/// 新文件已存在时视为用户已在新家改过，旧段直接丢弃。
fn migrate_legacy(app: &tauri::AppHandle) {
    use tauri::Manager;
    let Ok(dir) = app.path().app_config_dir() else {
        return;
    };
    let cfg_path = dir.join("config.json");
    let Ok(text) = std::fs::read_to_string(&cfg_path) else {
        return;
    };
    let Ok(mut v) = serde_json::from_str::<serde_json::Value>(&text) else {
        return;
    };
    let Some(cfg) = extract_legacy(&mut v) else {
        return;
    };
    if !store::exists(app, ID) {
        let _ = store::save(app, ID, &cfg);
        eprintln!("[plugin:{ID}] 已迁移旧番茄配置：enabled={}", cfg.enabled);
    }
    // 从主配置删除该段并回写（serde 忽略未知字段，旧版本读新文件也不炸）
    if let Ok(text) = serde_json::to_string_pretty(&v) {
        let _ = std::fs::write(&cfg_path, text);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cfg(enabled: bool, work: u32, brk: u32) -> PomodoroConfig {
        PomodoroConfig {
            enabled,
            work_mins: work,
            break_mins: brk,
        }
    }

    // ---- judge_rest（原样平移的测试） ----

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

    // ---- 状态机 ----

    #[test]
    fn 开启后从工作期开始() {
        let mut st = PomodoroState::new();
        let t0 = Instant::now();
        let ts = st.step(&cfg(true, 25, 5), t0, None);
        assert_eq!(ts, vec![Transition::WorkStart { mins: 25 }]);
        assert!(st.is_working());
    }

    #[test]
    fn 工作期未到点不动() {
        let mut st = PomodoroState::new();
        let t0 = Instant::now();
        st.step(&cfg(true, 25, 5), t0, None);
        assert!(st.step(&cfg(true, 25, 5), t0 + Duration::from_secs(24 * 60), None).is_empty());
        assert!(st.is_working());
    }

    #[test]
    fn 工作期到点进入休息() {
        let mut st = PomodoroState::new();
        let t0 = Instant::now();
        st.step(&cfg(true, 25, 5), t0, None);
        let ts = st.step(&cfg(true, 25, 5), t0 + mins(25), None);
        assert_eq!(ts, vec![Transition::BreakStart { mins: 5 }]);
        assert!(!st.is_working());
    }

    #[test]
    fn 休息期累计活跃_全程未采样判未知() {
        let mut st = PomodoroState::new();
        let t0 = Instant::now();
        st.step(&cfg(true, 25, 5), t0, None);
        st.step(&cfg(true, 25, 5), t0 + mins(25), None);
        // 休息 5 分钟全程无采样 → Unknown（不冤枉）
        let ts = st.step(&cfg(true, 25, 5), t0 + mins(30), None);
        assert_eq!(
            ts,
            vec![Transition::BreakEnd {
                verdict: RestVerdict::Unknown,
                mins: 25
            }]
        );
        assert!(st.is_working(), "休息结束回到工作期");
    }

    #[test]
    fn 休息期认真不动判达标_动多了判负() {
        // 认真休息：窗口内一直没碰键鼠
        let mut st = PomodoroState::new();
        let t0 = Instant::now();
        st.step(&cfg(true, 25, 5), t0, None);
        let brk_at = t0 + mins(25);
        st.step(&cfg(true, 25, 5), brk_at, None);
        let ts = st.step(&cfg(true, 25, 5), brk_at + mins(5), Some((999.0, 999.0)));
        assert_eq!(
            ts,
            vec![Transition::BreakEnd {
                verdict: RestVerdict::WellDone,
                mins: 25
            }]
        );

        // 休息期间狂动键鼠 → 判负
        let mut st2 = PomodoroState::new();
        st2.step(&cfg(true, 25, 5), t0, None);
        st2.step(&cfg(true, 25, 5), brk_at, None);
        // 首个窗口 idle=0 → 整窗都算活跃（5 分钟 = 300s > 60s）
        let ts2 = st2.step(&cfg(true, 25, 5), brk_at + mins(5), Some((0.0, 0.0)));
        assert_eq!(
            ts2,
            vec![Transition::BreakEnd {
                verdict: RestVerdict::NotRested,
                mins: 25
            }]
        );
    }

    #[test]
    fn 休息未到点保持休息并累计() {
        let mut st = PomodoroState::new();
        let t0 = Instant::now();
        st.step(&cfg(true, 25, 5), t0, None);
        let brk_at = t0 + mins(25);
        st.step(&cfg(true, 25, 5), brk_at, None);
        // 休息中途一轮：无迁移
        let ts = st.step(&cfg(true, 25, 5), brk_at + Duration::from_secs(60), Some((0.0, 0.0)));
        assert!(ts.is_empty());
        assert_eq!(st.phase_kind(), "break");
    }

    #[test]
    fn 中途关闭状态归零_重新开启从头开始() {
        let mut st = PomodoroState::new();
        let t0 = Instant::now();
        st.step(&cfg(true, 25, 5), t0, None);
        // 中途关掉
        assert!(st.step(&cfg(false, 25, 5), t0 + mins(10), None).is_empty());
        assert_eq!(st.phase_kind(), "idle");
        // 重新开启：从工作期重新开始，不续旧进度
        let ts = st.step(&cfg(true, 25, 5), t0 + mins(11), None);
        assert_eq!(ts, vec![Transition::WorkStart { mins: 25 }]);
    }

    // ---- 配置 ----

    #[test]
    fn 配置分钟数钳制() {
        let c = clamp_cfg(cfg(true, 0, 999));
        assert_eq!((c.work_mins, c.break_mins), (1, 60));
        let c = clamp_cfg(cfg(true, 25, 5));
        assert_eq!((c.work_mins, c.break_mins), (25, 5));
    }

    #[test]
    fn 旧配置缺字段补默认值() {
        let c: PomodoroConfig = serde_json::from_str(r#"{"enabled":true}"#).unwrap();
        assert!(c.enabled);
        assert_eq!((c.work_mins, c.break_mins), (25, 5));
    }

    #[test]
    fn 迁移提取旧段并从原文移除() {
        let mut v: serde_json::Value = serde_json::from_str(
            r#"{"size_index":1,"pomodoro":{"enabled":true,"work_mins":30,"break_mins":10}}"#,
        )
        .unwrap();
        let c = extract_legacy(&mut v).unwrap();
        assert!(c.enabled);
        assert_eq!((c.work_mins, c.break_mins), (30, 10));
        assert!(v.get("pomodoro").is_none(), "旧段必须移除");
        assert_eq!(v["size_index"], 1, "其余字段不受影响");
    }

    #[test]
    fn 无旧段时提取返回None() {
        let mut v: serde_json::Value = serde_json::from_str(r#"{"size_index":1}"#).unwrap();
        assert!(extract_legacy(&mut v).is_none());
    }

    #[test]
    fn 卡片payload带阶段与文案() {
        let c = make_card(
            "break_start",
            5,
            "休息".into(),
            Priority::High,
            600,
        );
        assert_eq!(c.plugin_id, ID);
        assert_eq!(c.priority, Priority::High);
        assert_eq!(c.payload["phase"], "break_start");
        assert_eq!(c.payload["mins"], 5);
    }
}
