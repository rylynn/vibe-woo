//! 学外语插件：内置词库为主 + SRS 记忆调度 + LLM 增强（设计文档 6.1，2026-09-02 修订）。
//!
//! 三条原则：
//! - **词与中文释义永远来自内置词库**（真实、可控、离线可用），LLM 只生成
//!   例句（按 goal 定制场景）与记忆钩子（词根/谐音/联想）—— 未配置 LLM
//!   时用词库自带例句，卡片照常工作。
//! - **SRS 是简化间隔重复**：艾宾浩斯梯度 10min → 1d → 3d → 7d → 21d。
//!   选词优先级：有反馈的到期复习 > 新词 > 当日已见重见 > 跨日已读词
//!  （2026-09-03 两轮修订：复习卡重置 + 已读词霸屏导致「当天词汇全重复」）；
//!   领域打散（连续两卡不同 domain）；水平过滤允许挑战高一级。
//! - **反馈闭环**：词卡带「认识 / 没印象」。没印象 10 分钟后重见（lapse+1）；
//!   认识则梯度推进；20 秒无人理 = 已读，interval 不变（不惩罚不互动）。
//!
//! LLM 增强在独立线程异步做并写入缓存 —— host 线程绝不被网络请求阻塞
//!（番茄等其他插件共享这条线程）。第一次见词用词库例句，复习时的卡
//! 带上增强内容 —— 复习卡更丰富，语义上反而更好。
//!
//! 频率自管（不依赖仲裁器的每插件间隔）：15 分钟一张 + daily_limit 上限 +
//! only_resting 时间窗（tempo=Resting / doing=Browsing 才出卡）。

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use serde::{Deserialize, Serialize};

use super::store;
use super::{Plugin, PluginCard, PluginMeta, Priority, ScheduleCtx, TickCtx};

/// 插件 id（配置文件名 / 前端渲染器 key）。
pub const ID: &str = "words";

/// 学习状态文件名（与配置分开：配置是用户域，状态是程序域）。
const STATE_FILE: &str = "words-srs";

/// 「休息时」的键盘静默阈值（秒）。
/// 一个信号统一表达「手离开键盘了」：走开、歇着、刷网页、盯着屏幕
/// 想事情 —— 比多状态判定（Resting/Browsing/Away）更准也更简单。
const REST_IDLE_SECS: f64 = 60.0;

/// 「休息时」判定（纯函数，单测入口）。采样不可用（None）视为不休息
/// —— 测不准就别打扰，与 pomodoro 的 Unknown 原则一致。
fn idle_is_resting(idle_secs: Option<f64>) -> bool {
    idle_secs.is_some_and(|i| i >= REST_IDLE_SECS)
}

/// 预览接下来要学的词（面板展示用）：连续 pick，已选的标记远期防止重复。
/// 在 SRS 副本上操作，不污染真实学习状态。
fn preview(
    pool: &[WordEntry],
    srs: &HashMap<String, SrsEntry>,
    now: u64,
    user_rank: u8,
    last_domain: &str,
    count: usize,
) -> Vec<WordEntry> {
    let mut srs = srs.clone();
    let mut last = last_domain.to_string();
    let mut out = Vec::new();
    for _ in 0..count {
        let Some(w) = pick(&pool, &srs, now, user_rank, &last) else {
            break;
        };
        last = w.domain.clone();
        srs.insert(
            w.term.clone(),
            SrsEntry {
                due_mins: u64::MAX / 2,
                step: 0,
                reps: 0,
                lapses: 0,
                first_mins: now,
            },
        );
        out.push(w);
    }
    out
}

/// 内置词库（编译进二进制）。
const DICT_JSON: &str = include_str!("words-dict.json");

/// 两张词卡之间的最小间隔（分钟）。
const WORD_GAP_MINS: u64 = 15;

/// SRS 艾宾浩斯梯度（分钟）：10min → 1d → 3d → 7d → 21d。
const SRS_STEPS_MINS: [u64; 5] = [10, 24 * 60, 3 * 24 * 60, 7 * 24 * 60, 21 * 24 * 60];

/// 轻量轮询间隔：读配置感知开关（只读本地文件，无网络无副作用）。
const CHECK_INTERVAL: Duration = Duration::from_secs(30);

// ---------- 配置 ----------

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct WordsConfig {
    pub enabled: bool,
    /// "english" | "japanese"
    pub language: String,
    /// "beginner" | "intermediate" | "advanced"
    pub level: String,
    /// 学习目标（自由文本，LLM 例句场景用），空 = 通用场景
    pub goal: String,
    /// 每日弹卡上限（新学 + 复习合计）
    pub daily_limit: u32,
    /// 只在休息节奏（Resting / Browsing）出卡
    pub only_resting: bool,
    /// 选中的词书 id；空 = 该语言全部词书
    pub books: Vec<String>,
}

impl Default for WordsConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            language: "english".into(),
            level: "intermediate".into(),
            goal: String::new(),
            daily_limit: 8,
            only_resting: true,
            books: Vec::new(),
        }
    }
}

fn clamp_cfg(mut c: WordsConfig) -> WordsConfig {
    if !matches!(c.language.as_str(), "english" | "japanese") {
        c.language = "english".into();
    }
    if !matches!(c.level.as_str(), "beginner" | "intermediate" | "advanced") {
        c.level = "intermediate".into();
    }
    c.daily_limit = c.daily_limit.clamp(1, 50);
    c
}

pub fn load_config(app: &tauri::AppHandle) -> WordsConfig {
    clamp_cfg(store::load(app, ID))
}

// ---------- 词库 ----------

#[derive(Debug, Clone, Deserialize)]
pub struct WordEntry {
    #[serde(rename = "t")]
    pub term: String,
    #[serde(rename = "r")]
    pub reading: String,
    #[serde(rename = "m")]
    pub meaning: String,
    #[serde(rename = "e")]
    pub example: String,
    #[serde(rename = "d")]
    pub domain: String,
    #[serde(rename = "l")]
    pub level: String,
}

#[derive(Debug, Deserialize)]
struct Book {
    name: String,
    words: Vec<WordEntry>,
}

#[derive(Debug, Deserialize)]
struct Dict {
    english: HashMap<String, Book>,
    japanese: HashMap<String, Book>,
}

fn dict() -> &'static Dict {
    static D: OnceLock<Dict> = OnceLock::new();
    D.get_or_init(|| {
        serde_json::from_str(DICT_JSON).unwrap_or_else(|e| {
            eprintln!("[plugin:{ID}] 词库解析失败（不该发生，编译期资产）：{e}");
            Dict {
                english: HashMap::new(),
                japanese: HashMap::new(),
            }
        })
    })
}

fn level_rank(l: &str) -> u8 {
    match l {
        "beginner" => 0,
        "intermediate" => 1,
        _ => 2,
    }
}

/// 组装选词池：该语言选中词书的全部词条（books 空 = 全部词书）。
fn pool_for(language: &str, books: &[String]) -> Vec<WordEntry> {
    let d = dict();
    let map = match language {
        "japanese" => &d.japanese,
        _ => &d.english,
    };
    let mut out = Vec::new();
    for (id, book) in map {
        if books.is_empty() || books.iter().any(|b| b == id) {
            out.extend(book.words.iter().cloned());
        }
    }
    out
}

// ---------- SRS（纯逻辑，单测入口） ----------

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SrsEntry {
    /// 到期时刻（epoch 分钟）。存整数分钟：精度足够且免时区问题。
    pub due_mins: u64,
    /// 当前梯度下标（0..=4）。
    pub step: u32,
    pub reps: u32,
    pub lapses: u32,
    /// 首见时刻（epoch 分钟）。区分「隔天老词的复习」（SRS 本意，
    /// 优先级最高）与「当日刚学词的重见」（让位新词，避免霸屏）。
    /// 旧状态文件缺该字段时按 0 处理（视为老词，行为与历史一致）。
    #[serde(default)]
    pub first_mins: u64,
}

/// 「老词」判定窗口：首见超过一天才算跨日复习。
const DAY_MINS: u64 = 24 * 60;

fn now_epoch_mins() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() / 60)
        .unwrap_or(0)
}

/// 反馈：认识 → 梯度推进（封顶）；没印象 → 回起点 10 分钟后重见。
fn on_feedback(e: &mut SrsEntry, known: bool, now: u64) {
    e.reps += 1;
    if known {
        e.step = (e.step + 1).min(SRS_STEPS_MINS.len() as u32 - 1);
    } else {
        e.step = 0;
        e.lapses += 1;
    }
    e.due_mins = now + SRS_STEPS_MINS[e.step as usize];
}

/// 选词优先级（2026-09-03 两轮修订，修复「当天词汇全重复」）：
/// 1. **有反馈的到期复习**（SRS 本意）：用户点过「认识 / 没印象」的词
///    （reps ≥ 2）——「没印象 10 分钟后重见」与跨日复习都属此类；
/// 2. **新词** —— 旧逻辑里复习永远优先，而第一步梯度只有 10 分钟、
///    比出卡间隔还短，用户一旦不理卡，同一个词就永远霸屏、新词饿死；
/// 3. **当日已见词的到期重见**（无反馈）；
/// 4. **跨日已读词**（无反馈）—— 昨天没人理的词今天也排队等新词，
///    否则每天一开机全是「昨天的词」，用户感受还是「全重复」。
/// 水平过滤（允许挑战高一级）；领域打散（避开 last_domain，有替代才避开）。
/// 返回 owned 词条（调用侧的 pool 多为局部变量）。
fn pick(
    pool: &[WordEntry],
    srs: &HashMap<String, SrsEntry>,
    now: u64,
    user_rank: u8,
    last_domain: &str,
) -> Option<WordEntry> {
    let eligible: Vec<&WordEntry> = pool
        .iter()
        .filter(|w| level_rank(&w.level) <= user_rank + 1)
        .collect();

    // 到期词按 due 升序；按「有无反馈」与「是否跨日」分档
    let mut due: Vec<(&WordEntry, u64)> = eligible
        .iter()
        .filter_map(|w| {
            let e = srs.get(&w.term)?;
            (e.due_mins <= now).then_some((*w, e.due_mins))
        })
        .collect();
    due.sort_by_key(|(_, due_at)| *due_at);
    // 点过「认识 / 没印象」才算用户认这个词 —— reps 在首见时为 1，
    // 每次反馈 +1（见 on_feedback）。已读未理 = 没有学习承诺，不该霸屏。
    let has_feedback = |t: &str| srs[t].reps >= 2;
    let is_old = |t: &str| now.saturating_sub(srs[t].first_mins) >= DAY_MINS;
    let from = |candidates: &[(&WordEntry, u64)]| {
        candidates
            .iter()
            .find(|(w, _)| w.domain != last_domain)
            .or_else(|| candidates.first())
            .map(|(w, _)| (*w).clone())
    };

    // 1. 有反馈的到期复习（当日「没印象」重见与跨日复习）
    let review: Vec<_> = due.iter().copied().filter(|(w, _)| has_feedback(&w.term)).collect();
    if !review.is_empty() {
        return from(&review);
    }

    // 2. 新词：从未见过的
    if let Some(w) = eligible
        .iter()
        .find(|w| !srs.contains_key(&w.term) && w.domain != last_domain)
        .or_else(|| eligible.iter().find(|w| !srs.contains_key(&w.term)))
    {
        return Some((*w).clone());
    }

    // 3. 当日已见的到期重见（无反馈）
    let today_due: Vec<_> = due
        .iter()
        .copied()
        .filter(|(w, _)| !is_old(&w.term))
        .collect();
    if !today_due.is_empty() {
        return from(&today_due);
    }

    // 4. 跨日已读词（无反馈）：排队等新词学完
    from(&due)
}

/// 无反馈重见的再排期（复习卡被展示但没等到反馈时调用）：
/// 不奖不罚 —— 梯度、次数都不动，只把到期时刻推后。保底至少隔两张卡
/// （2 × 出卡间隔），否则复习间隔可能比出卡间隔还短，同一词连续霸屏。
fn reschedule_seen(e: &mut SrsEntry, now: u64) {
    e.due_mins = now + SRS_STEPS_MINS[e.step as usize].max(2 * WORD_GAP_MINS);
}

// ---------- 学习状态（跨线程共享：host tick 与反馈命令都写） ----------

#[derive(Debug, Default, Clone, Serialize, Deserialize)]
struct WordsState {
    srs: HashMap<String, SrsEntry>,
    /// 当日已发卡数（跨天清零）。
    served_date: String,
    served_count: u32,
    /// 当日已发词条（面板展示用，只留最近 20 条）。
    served_terms: Vec<String>,
    /// 上次发卡时刻（epoch 分钟），频率闸。
    last_card_mins: u64,
    /// 上一张卡的领域（打散用）。
    last_domain: String,
}

static STATE: Mutex<Option<WordsState>> = Mutex::new(None);

fn with_state<R>(f: impl FnOnce(&mut WordsState) -> R) -> R {
    let mut g = STATE.lock().expect("words state poisoned");
    let s = g.get_or_insert_with(WordsState::default);
    f(s)
}

fn save_state(app: &tauri::AppHandle) {
    let s = with_state(|s| s.clone());
    if let Err(e) = store::save(app, STATE_FILE, &s) {
        eprintln!("[plugin:{ID}] 学习状态落盘失败（内存继续用）：{e}");
    }
}

fn load_state(app: &tauri::AppHandle) {
    let s: WordsState = store::load(app, STATE_FILE);
    with_state(|g| *g = s);
}

/// 跨天清零（纯函数，单测入口）。
fn rollover(s: &mut WordsState, today: &str) {
    if s.served_date != today {
        s.served_date = today.to_string();
        s.served_count = 0;
        s.served_terms.clear();
    }
}

// ---------- LLM 增强缓存（异步线程写，tick 读） ----------

#[derive(Debug, Clone, Serialize)]
struct Enhanced {
    example: String,
    hook: Option<String>,
}

static ENHANCED: Mutex<Option<HashMap<String, Enhanced>>> = Mutex::new(None);

/// 异步为词条生成增强内容，写入缓存。失败静默（词库例句兜底）。
fn spawn_enhance(cfg: &WordsConfig, w: &WordEntry) {
    let cfg = cfg.clone();
    let w = w.clone();
    std::thread::spawn(move || {
        let llm = crate::configcmd::current().llm;
        if !llm.enabled || llm.api_key.is_empty() {
            return;
        }
        let rt = match tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
        {
            Ok(rt) => rt,
            Err(_) => return,
        };
        let goal = if cfg.goal.is_empty() {
            "日常通用".to_string()
        } else {
            cfg.goal.clone()
        };
        let system = concat!(
            "你为外语单词生成学习卡增强内容，只输出 JSON，不要任何其他文字：",
            "{\"example\":\"一句使用该词的例句（与用户目标场景贴合）\",",
            "\"hook\":\"一个中文记忆钩子：词根拆解、谐音或联想，三选一，25字内\"}。",
            "例句语言：英语单词用英文句子，日语单词用日文句子。例句要自然、略高于课本感。"
        );
        let user = format!(
            "学习目标：{goal}\n单词：{}\n释义：{}\n词库自带例句（可参考风格，别照抄）：{}",
            w.term, w.meaning, w.example
        );
        let Ok(out) = rt.block_on(crate::llm::complete(&llm, system, &user, true)) else {
            return;
        };
        let Ok(v) = serde_json::from_str::<serde_json::Value>(out.trim()) else {
            eprintln!("[plugin:{ID}] LLM 增强输出不是 JSON，丢弃");
            return;
        };
        let enhanced = Enhanced {
            example: v["example"].as_str().unwrap_or_default().to_string(),
            hook: v["hook"].as_str().map(str::to_string),
        };
        if enhanced.example.is_empty() {
            return;
        }
        if let Ok(mut g) = ENHANCED.lock() {
            g.get_or_insert_with(HashMap::new).insert(w.term.clone(), enhanced);
        }
    });
}

// ---------- 插件本体 ----------

pub struct WordsPlugin;

impl WordsPlugin {
    pub fn new(app: &tauri::AppHandle) -> Self {
        load_state(app);
        Self
    }
}

impl Plugin for WordsPlugin {
    fn id(&self) -> &'static str {
        ID
    }

    fn name(&self) -> &'static str {
        "学外语"
    }

    fn next_tick(&self, _ctx: &ScheduleCtx) -> Option<Duration> {
        Some(CHECK_INTERVAL)
    }

    fn tick(&mut self, ctx: &mut TickCtx) -> Vec<PluginCard> {
        let cfg = load_config(ctx.app);
        if !cfg.enabled {
            return Vec::new();
        }
        let now = now_epoch_mins();
        let today = crate::reminddrive::local_now()
            .map(|c| c.date)
            .unwrap_or_default();

        let Some(word) = with_state(|s| {
            rollover(s, &today);
            if s.served_count >= cfg.daily_limit {
                return None;
            }
            if now.saturating_sub(s.last_card_mins) < WORD_GAP_MINS {
                return None;
            }
            // 首卡不设防：启用后当日第一张立即出现 —— 开了插件却什么都
            // 看不到是最差的默认体验，先让用户确认它在工作，再进入
            // 「键盘静默 1 分钟才弹」的节奏（时间窗是插件业务，不进仲裁器）。
            if cfg.only_resting && s.served_count > 0 {
                let idle = crate::sensor::keyboard_idle_secs();
                if !idle_is_resting(idle) {
                    return None;
                }
            }
            let pool = pool_for(&cfg.language, &cfg.books);
            let word = pick(
                &pool,
                &s.srs,
                now,
                level_rank(&cfg.level),
                &s.last_domain,
            )?;
            // 记账：今日配额、频率闸、领域；SRS 分新词首见与复习重见两条路。
            // 修复：旧逻辑对复习词也按新词整条重置（step 归 0、10 分钟后
            // 再到期），到期时刻永远追着出卡间隔跑 —— 当天全在重复同一个词。
            s.served_count += 1;
            s.served_terms.push(word.term.clone());
            s.last_card_mins = now;
            s.last_domain = word.domain.clone();
            match s.srs.get_mut(&word.term) {
                Some(e) => reschedule_seen(e, now),
                None => {
                    s.srs.insert(
                        word.term.clone(),
                        SrsEntry {
                            due_mins: now + SRS_STEPS_MINS[0],
                            step: 0,
                            reps: 1,
                            lapses: 0,
                            first_mins: now,
                        },
                    );
                }
            }
            Some(word)
        }) else {
            return Vec::new();
        };

        save_state(ctx.app);

        // LLM 增强：缓存命中则用，未命中发词库版并异步补
        let enhanced = ENHANCED
            .lock()
            .ok()
            .and_then(|g| g.as_ref().and_then(|m| m.get(&word.term).cloned()));
        if enhanced.is_none() {
            spawn_enhance(&cfg, &word);
        }

        vec![make_card(&word, enhanced.as_ref())]
    }
}

fn make_card(w: &WordEntry, enhanced: Option<&Enhanced>) -> PluginCard {
    let example = enhanced.map(|e| e.example.as_str()).unwrap_or(w.example.as_str());
    PluginCard {
        plugin_id: ID.into(),
        kind: ID.into(),
        priority: Priority::Normal,
        ttl_secs: 20,
        payload: serde_json::json!({
            "term": w.term,
            "reading": w.reading,
            "meaning": w.meaning,
            "example": example,
            "hook": enhanced.and_then(|e| e.hook.clone()),
            "ai": enhanced.is_some(),
        }),
    }
}

/// 左键面板 / 设置用元信息：当天全部学习信息 ——
/// 已学列表 + 接下来要学的预览（due 复习词优先，再补新词）。
pub fn meta(app: &tauri::AppHandle) -> PluginMeta {
    let cfg = load_config(app);
    let s = STATE.lock().ok().and_then(|g| g.clone());
    let today = crate::reminddrive::local_now()
        .map(|c| c.date)
        .unwrap_or_default();
    let (count, terms, srs, last_domain) = match s {
        Some(mut s) => {
            rollover(&mut s, &today);
            (
                s.served_count,
                s.served_terms.clone(),
                s.srs.clone(),
                s.last_domain.clone(),
            )
        }
        None => (0, Vec::new(), HashMap::new(), String::new()),
    };
    let pool = pool_for(&cfg.language, &[]);
    let look_up = |t: &str| {
        pool.iter()
            .find(|w| w.term == t)
            .map(|w| serde_json::json!({ "term": w.term, "meaning": w.meaning }))
    };
    // 今日已学（全量，最新的在前；同一词多次重见只显示一次 ——
    // 历史遗留/复习重见不该把「已学」刷成同一词的一屏）
    let mut seen = std::collections::HashSet::new();
    let learned: Vec<serde_json::Value> = terms
        .iter()
        .rev()
        .filter(|t| seen.insert((*t).clone()))
        .filter_map(|t| look_up(t))
        .collect();
    // 接下来要学的（剩余配额的预览，最多 8 个）
    let remaining = cfg.daily_limit.saturating_sub(count).min(8) as usize;
    let upcoming: Vec<serde_json::Value> = preview(
        &pool,
        &srs,
        now_epoch_mins(),
        level_rank(&cfg.level),
        &last_domain,
        remaining,
    )
    .iter()
    .map(|w| serde_json::json!({ "term": w.term, "meaning": w.meaning }))
    .collect();
    PluginMeta {
        id: ID.into(),
        name: "学外语".into(),
        kind: ID.into(),
        summary: serde_json::json!({
            "enabled": cfg.enabled,
            "language": cfg.language,
            "today_count": count,
            "daily_limit": cfg.daily_limit,
            "learned": learned,
            "upcoming": upcoming,
        }),
    }
}

/// 词卡反馈（前端「认识 / 没印象」按钮）。未记录的词静默忽略。
#[tauri::command]
pub fn words_feedback(app: tauri::AppHandle, term: String, known: bool) -> Result<(), String> {
    let now = now_epoch_mins();
    let hit = with_state(|s| {
        if let Some(e) = s.srs.get_mut(&term) {
            on_feedback(e, known, now);
            true
        } else {
            false
        }
    });
    if hit {
        save_state(&app);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn word(term: &str, domain: &str, level: &str) -> WordEntry {
        WordEntry {
            term: term.into(),
            reading: String::new(),
            meaning: String::new(),
            example: String::new(),
            domain: domain.into(),
            level: level.into(),
        }
    }

    fn entry(due: u64, step: u32) -> SrsEntry {
        SrsEntry {
            due_mins: due,
            step,
            reps: 1,
            lapses: 0,
            first_mins: 0,
        }
    }

    /// 当日首见的条目（相对 now 往前推 seen_ago 分钟）。
    fn entry_today(due: u64, now: u64, seen_ago: u64) -> SrsEntry {
        SrsEntry {
            due_mins: due,
            step: 0,
            reps: 1,
            lapses: 0,
            first_mins: now - seen_ago,
        }
    }

    // ---- SRS ----

    #[test]
    fn 认识推进梯度并封顶() {
        let mut e = entry(0, 0);
        on_feedback(&mut e, true, 1000);
        assert_eq!((e.step, e.due_mins), (1, 1000 + SRS_STEPS_MINS[1]));
        e.step = 4;
        on_feedback(&mut e, true, 1000);
        assert_eq!(e.step, 4, "最高档封顶");
    }

    #[test]
    fn 没印象回起点十分钟后重见() {
        let mut e = entry(0, 3);
        on_feedback(&mut e, false, 1000);
        assert_eq!((e.step, e.due_mins, e.lapses), (0, 1000 + SRS_STEPS_MINS[0], 1));
    }

    #[test]
    fn 梯度符合艾宾浩斯设计() {
        assert_eq!(SRS_STEPS_MINS, [10, 1440, 4320, 10080, 30240]);
    }

    // ---- 选词 ----

    /// 有反馈的条目（用户点过「认识 / 没印象」，reps ≥ 2）。
    fn entry_reviewed(due: u64, step: u32) -> SrsEntry {
        SrsEntry {
            reps: 2,
            ..entry(due, step)
        }
    }

    #[test]
    fn 有反馈的到期复习词优先于新词() {
        let pool = vec![word("new1", "life", "beginner"), word("old1", "life", "beginner")];
        let mut srs = HashMap::new();
        srs.insert("old1".into(), entry_reviewed(0, 1)); // 用户认过，已到期
        let w = pick(&pool, &srs, 10_000, 0, "").unwrap();
        assert_eq!(w.term, "old1");
    }

    #[test]
    fn 旧版遗留的锁死状态立刻转向新词() {
        // 回归（2026-09-03 面板截图：今日 12/12 张全是 eagle）：
        // 旧 bug 写出来的状态是「同一词反复发卡、reps=1、first_mins 缺省为 0」。
        // 新逻辑面对这样的状态必须立刻转向没见过的词。
        let pool = vec![
            word("eagle", "animal", "beginner"),
            word("tiger", "animal", "beginner"),
            word("apple", "food", "beginner"),
        ];
        let mut srs = HashMap::new();
        srs.insert("eagle".into(), entry(0, 0)); // 早已到期、从未有反馈
        let w = pick(&pool, &srs, 10_000, 0, "").unwrap();
        assert_ne!(w.term, "eagle", "已读词不该再被选中");
    }

    #[test]
    fn 跨日已读词让位新词_防隔天还是老面孔() {
        // 回归：昨天发了卡但没人理的词，今天到期却排在所有新词前面，
        // 用户感受就是「每天的词都一样」—— 已读词必须排队等新词。
        let pool = vec![word("stale", "life", "beginner"), word("fresh", "food", "beginner")];
        let mut srs = HashMap::new();
        srs.insert("stale".into(), entry(0, 0)); // 昨天已读（reps=1），今天到期
        let w = pick(&pool, &srs, 10_000, 0, "").unwrap();
        assert_eq!(w.term, "fresh", "没人理过的词不该抢在新词前面");
        // 新词学完了它才兜底
        let w2 = pick(&pool[..1], &srs, 10_000, 0, "").unwrap();
        assert_eq!(w2.term, "stale");
    }

    #[test]
    fn 当日已见词让位新词_防同词霸屏() {
        // 回归：复习第一步（10min）比出卡间隔（15min）还短，
        // 且 tick 曾把复习词整条重置 —— 当天全在重复同一个词。
        // 现在当日重见必须让位新词。
        let pool = vec![word("a", "life", "beginner"), word("b", "food", "beginner")];
        let mut srs = HashMap::new();
        srs.insert("a".into(), entry_today(9_940, 10_000, 60)); // 一小时前学的，已到期
        let w = pick(&pool, &srs, 10_000, 0, "").unwrap();
        assert_eq!(w.term, "b", "当日已见词不该抢在没见过的新词前面");
    }

    #[test]
    fn 池子学完后才轮到当日重见() {
        let pool = vec![word("a", "life", "beginner")];
        let mut srs = HashMap::new();
        srs.insert("a".into(), entry_today(9_940, 10_000, 60));
        let w = pick(&pool, &srs, 10_000, 0, "").unwrap();
        assert_eq!(w.term, "a", "没有新词时当日到期词仍应兜底");
    }

    #[test]
    fn 无反馈重见不重置梯度且至少隔两张卡() {
        let mut e = entry(9_940, 0);
        reschedule_seen(&mut e, 10_000);
        assert_eq!(e.step, 0, "无反馈不推进也不惩罚");
        assert_eq!(e.reps, 1);
        assert_eq!(e.due_mins, 10_000 + 2 * WORD_GAP_MINS, "第一步梯度(10min)比出卡间隔短，保底隔两张卡");

        let mut e = entry(0, 1);
        reschedule_seen(&mut e, 10_000);
        assert_eq!(e.due_mins, 10_000 + SRS_STEPS_MINS[1], "梯度高于保底时按原梯度");
    }

    #[test]
    fn 无到期词时选新词() {
        let pool = vec![word("new1", "life", "beginner")];
        let mut srs = HashMap::new();
        srs.insert("new1".into(), entry(999999, 0)); // 没到期
        // 没有「未见过的」词，也没有到期词 → None
        assert!(pick(&pool, &srs, 10_000, 0, "").is_none());

        let pool2 = vec![word("new1", "life", "beginner"), word("new2", "food", "beginner")];
        let w = pick(&pool2, &srs, 10_000, 0, "").unwrap();
        assert_eq!(w.term, "new2");
    }

    #[test]
    fn 水平过滤允许挑战高一级() {
        let pool = vec![
            word("easy", "life", "beginner"),
            word("mid", "life", "intermediate"),
            word("hard", "life", "advanced"),
        ];
        // beginner(0)：可学 beginner+intermediate，advanced 被滤掉
        let mut srs = HashMap::new();
        srs.insert("easy".into(), entry(999999, 0));
        srs.insert("mid".into(), entry(999999, 0));
        assert!(pick(&pool, &srs, 10_000, 0, "").is_none(), "advanced 不该入选");
    }

    #[test]
    fn 领域打散避开上一张卡的领域() {
        let pool = vec![
            word("a", "life", "beginner"),
            word("b", "food", "beginner"),
        ];
        let mut srs = HashMap::new();
        srs.insert("a".into(), entry(0, 1)); // a、b 都到期
        srs.insert("b".into(), entry(0, 1));
        let w = pick(&pool, &srs, 10_000, 0, "life").unwrap();
        assert_eq!(w.term, "b", "应避开刚出过的 life 领域");
    }

    #[test]
    fn 领域无替代时不死锁() {
        let pool = vec![word("a", "life", "beginner"), word("b", "life", "beginner")];
        let mut srs = HashMap::new();
        srs.insert("a".into(), entry(0, 1));
        srs.insert("b".into(), entry(0, 1));
        assert!(pick(&pool, &srs, 10_000, 0, "life").is_some());
    }

    // ---- 状态 ----

    #[test]
    fn 跨天清零当日计数() {
        let mut s = WordsState {
            served_date: "2026-09-01".into(),
            served_count: 5,
            served_terms: vec!["a".into()],
            ..Default::default()
        };
        rollover(&mut s, "2026-09-02");
        assert_eq!(s.served_count, 0);
        assert!(s.served_terms.is_empty());
        assert_eq!(s.served_date, "2026-09-02");
        // 同日不清
        rollover(&mut s, "2026-09-02");
        assert_eq!(s.served_count, 0);
    }

    // ---- 配置 ----

    #[test]
    fn 配置钳制非法语言与水平() {
        let c = clamp_cfg(WordsConfig {
            language: "klingon".into(),
            level: "native".into(),
            daily_limit: 999,
            ..Default::default()
        });
        assert_eq!(c.language, "english");
        assert_eq!(c.level, "intermediate");
        assert_eq!(c.daily_limit, 50);
    }

    #[test]
    fn 旧配置缺字段补默认值() {
        let c: WordsConfig = serde_json::from_str(r#"{"enabled":true}"#).unwrap();
        assert!(c.enabled);
        assert_eq!(c.language, "english");
        assert!(c.only_resting);
        assert_eq!(c.daily_limit, 8);
    }

    // ---- 内置词库 ----

    #[test]
    fn 词库可解析且词条完整() {
        let d = dict();
        for (lang, map) in [("english", &d.english), ("japanese", &d.japanese)] {
            assert!(!map.is_empty(), "{lang} 词书不能为空");
            for (id, book) in map {
                assert!(!book.words.is_empty(), "{lang}/{id} 词条不能为空");
                for w in &book.words {
                    assert!(!w.term.is_empty(), "term 为空：{lang}/{id}");
                    assert!(!w.meaning.is_empty(), "释义为空：{}", w.term);
                    assert!(!w.domain.is_empty(), "领域为空：{}", w.term);
                    // 例句与音标允许为空：ECDICT 扩展词书（*_x）无例句，
                    // 例句由 LLM 异步增强补；音标缺失的词照常出卡。
                    assert!(
                        !w.example.is_empty() || id.ends_with("_x"),
                        "例句为空且非扩展词书：{}（{lang}/{id}）",
                        w.term
                    );
                    assert!(
                        matches!(w.level.as_str(), "beginner" | "intermediate" | "advanced"),
                        "水平非法：{} -> {}",
                        w.term,
                        w.level
                    );
                }
            }
        }
    }

    #[test]
    fn 词库各语言总量与领域多样性达标() {
        let d = dict();
        let en: usize = d.english.values().map(|b| b.words.len()).sum();
        let ja: usize = d.japanese.values().map(|b| b.words.len()).sum();
        // 2026-09-02 扩容基线：手写英 474 / 日 481 + ECDICT 扩展 1300
        assert!(en >= 1700, "英语词量 {en} 应不少于 1700");
        assert!(ja >= 450, "日语词量 {ja} 应不少于 450");

        let daily = &d.english["daily"];
        let domains: std::collections::HashSet<&str> =
            daily.words.iter().map(|w| w.domain.as_str()).collect();
        assert!(domains.len() >= 4, "日常词书应覆盖生活/食物/职场/旅行多领域");
    }

    #[test]
    fn 休息判定以键盘静默一分钟为准() {
        assert!(idle_is_resting(Some(60.0)), "静默满 1 分钟算休息");
        assert!(idle_is_resting(Some(600.0)), "走开（长时间静默）算休息");
        assert!(!idle_is_resting(Some(59.9)), "差一秒都不算");
        assert!(!idle_is_resting(Some(0.0)), "正在敲键盘不算");
        assert!(!idle_is_resting(None), "采样不可用视为不休息 —— 测不准就别打扰");
    }

    #[test]
    fn 预览不重复且有反馈到期词优先_不污染真实srs() {
        let pool = vec![
            word("a", "life", "beginner"),
            word("b", "food", "beginner"),
            word("c", "life", "beginner"),
        ];
        let mut srs = HashMap::new();
        srs.insert("a".into(), entry_reviewed(0, 1)); // a 到期且有反馈
        let out = preview(&pool, &srs, 10_000, 0, "", 3);
        let terms: Vec<&str> = out.iter().map(|w| w.term.as_str()).collect();
        assert_eq!(terms, vec!["a", "b", "c"], "到期词优先、不重复、按序给满");
        // 预览只动副本：真实 SRS 不被改写
        assert_eq!(srs.get("a").unwrap().due_mins, 0);
    }

    #[test]
    fn 卡片payload词与释义来自词库() {
        let w = word("test", "life", "beginner");
        let c = make_card(&w, None);
        assert_eq!(c.payload["term"], "test");
        assert_eq!(c.payload["ai"], false, "无增强时 ai=false");
        let e = Enhanced {
            example: "LLM 例句".into(),
            hook: Some("钩子".into()),
        };
        let c2 = make_card(&w, Some(&e));
        assert_eq!(c2.payload["example"], "LLM 例句");
        assert_eq!(c2.payload["hook"], "钩子");
        assert_eq!(c2.payload["ai"], true);
    }
}
