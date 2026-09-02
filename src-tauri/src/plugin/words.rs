//! 学外语插件：内置词库为主 + SRS 记忆调度 + LLM 增强（设计文档 6.1，2026-09-02 修订）。
//!
//! 三条原则：
//! - **词与中文释义永远来自内置词库**（真实、可控、离线可用），LLM 只生成
//!   例句（按 goal 定制场景）与记忆钩子（词根/谐音/联想）—— 未配置 LLM
//!   时用词库自带例句，卡片照常工作。
//! - **SRS 是简化间隔重复**：艾宾浩斯梯度 10min → 1d → 3d → 7d → 21d。
//!   到期复习词优先于新词；领域打散（连续两卡不同 domain）；
//!   水平过滤允许挑战高一级。
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

/// 「休息时」判定（纯函数，单测入口）：歇着、走开、或在前台刷网页。
/// 首版只认 Resting/Browsing —— 实测人走开时 tempo 未必到 Resting，
/// 把 Away 也算上，否则「走开等词卡」永远等不到。
fn is_resting(s: &crate::state::PetState) -> bool {
    s.tempo == crate::state::Tempo::Resting
        || s.doing == crate::state::Doing::Browsing
        || s.doing == crate::state::Doing::Away
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
}

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

/// 选词：到期复习词优先（按 due 最早），不够再选新词；
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

    // 到期复习词：按 due 升序
    let mut due: Vec<(&WordEntry, u64)> = eligible
        .iter()
        .filter_map(|w| {
            let e = srs.get(&w.term)?;
            (e.due_mins <= now).then_some((*w, e.due_mins))
        })
        .collect();
    due.sort_by_key(|(_, due_at)| *due_at);
    if let Some((w, _)) = due.iter().find(|(w, _)| w.domain != last_domain).or(due.first()) {
        return Some((*w).clone());
    }

    // 新词：从未见过的
    eligible
        .iter()
        .find(|w| !srs.contains_key(&w.term) && w.domain != last_domain)
        .or_else(|| eligible.iter().find(|w| !srs.contains_key(&w.term)))
        .map(|w| (*w).clone())
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
            // 「只在休息时弹」的节奏（时间窗是插件业务，不进仲裁器）。
            if cfg.only_resting && s.served_count > 0 {
                let Some(st) = ctx.state() else {
                    return None;
                };
                if !is_resting(&st) {
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
            // 记账：今日配额、频率闸、领域、SRS 首见（10 分钟后复习）
            s.served_count += 1;
            s.served_terms.push(word.term.clone());
            s.last_card_mins = now;
            s.last_domain = word.domain.clone();
            s.srs.insert(
                word.term.clone(),
                SrsEntry {
                    due_mins: now + SRS_STEPS_MINS[0],
                    step: 0,
                    reps: 1,
                    lapses: 0,
                },
            );
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
    // 今日已学（全量，最新的在前）
    let learned: Vec<serde_json::Value> = terms
        .iter()
        .rev()
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

    #[test]
    fn 到期复习词优先于新词() {
        let pool = vec![word("new1", "life", "beginner"), word("old1", "life", "beginner")];
        let mut srs = HashMap::new();
        srs.insert("old1".into(), entry(0, 1)); // 已到期
        let w = pick(&pool, &srs, 1000, 0, "").unwrap();
        assert_eq!(w.term, "old1");
    }

    #[test]
    fn 无到期词时选新词() {
        let pool = vec![word("new1", "life", "beginner")];
        let mut srs = HashMap::new();
        srs.insert("new1".into(), entry(999999, 0)); // 没到期
        // 没有「未见过的」词，也没有到期词 → None
        assert!(pick(&pool, &srs, 1000, 0, "").is_none());

        let pool2 = vec![word("new1", "life", "beginner"), word("new2", "food", "beginner")];
        let w = pick(&pool2, &srs, 1000, 0, "").unwrap();
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
        assert!(pick(&pool, &srs, 1000, 0, "").is_none(), "advanced 不该入选");
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
        let w = pick(&pool, &srs, 1000, 0, "life").unwrap();
        assert_eq!(w.term, "b", "应避开刚出过的 life 领域");
    }

    #[test]
    fn 领域无替代时不死锁() {
        let pool = vec![word("a", "life", "beginner"), word("b", "life", "beginner")];
        let mut srs = HashMap::new();
        srs.insert("a".into(), entry(0, 1));
        srs.insert("b".into(), entry(0, 1));
        assert!(pick(&pool, &srs, 1000, 0, "life").is_some());
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
                    assert!(!w.example.is_empty(), "例句为空：{}", w.term);
                    assert!(!w.domain.is_empty(), "领域为空：{}", w.term);
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
        assert!(en >= 100, "英语词量 {en} 应不少于 100");
        assert!(ja >= 90, "日语词量 {ja} 应不少于 90");

        let daily = &d.english["daily"];
        let domains: std::collections::HashSet<&str> =
            daily.words.iter().map(|w| w.domain.as_str()).collect();
        assert!(domains.len() >= 4, "日常词书应覆盖生活/食物/职场/旅行多领域");
    }

    #[test]
    fn 休息判定覆盖歇着走开与刷网页() {
        use crate::state::{Doing, Tempo};
        let pstate = |doing, tempo| crate::state::PetState {
            doing,
            tempo,
            late_night: false,
            keystrokes_per_min: 0.0,
            mood: crate::mood::Mood::Focused,
            activity: crate::activity::Activity::Working,
            dnd_on: false,
        };
        assert!(is_resting(&pstate(Doing::Browsing, Tempo::Normal)), "刷网页算休息");
        assert!(is_resting(&pstate(Doing::Away, Tempo::Normal)), "走开算休息");
        assert!(is_resting(&pstate(Doing::Other, Tempo::Resting)), "歇着算休息");
        assert!(!is_resting(&pstate(Doing::Editing, Tempo::Flow)), "心流中不打扰");
        assert!(!is_resting(&pstate(Doing::Editing, Tempo::Normal)), "干活时不打扰");
    }

    #[test]
    fn 预览不重复且到期词优先_不污染真实srs() {
        let pool = vec![
            word("a", "life", "beginner"),
            word("b", "food", "beginner"),
            word("c", "life", "beginner"),
        ];
        let mut srs = HashMap::new();
        srs.insert("a".into(), entry(0, 1)); // a 到期
        let out = preview(&pool, &srs, 1000, 0, "", 3);
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
