//! 股市投资插件：公开行情接口拉取 + 时段过滤 + 变动摘要（设计文档 6.3）。
//!
//! 三条原则：
//! - **数字永远来自接口**，LLM 只把收盘总结的数字翻译成一句人话 ——
//!   模型编不出可信行情，幻觉数字等于害人。
//! - **盘中/工作时间不出卡**：先查展示时段（默认午休 + 收盘后），
//!   在时段内才拉行情；与上次出卡快照比较，全部在阈值内就不出卡
//!  （频率控制第一道闸；第二道是出卡间隔 45 分钟）。
//! - 每天收盘后出一次「收盘总结」卡（`summarized_after` 时刻，
//!   `summarized_date` 防重启重复发）。
//!
//! 网络走异步旁路线程（words/news 同一模式）—— host 线程零阻塞。
//! 内置端点为腾讯行情（qt.gtimg.cn，GBK 编码，A 股/港股/美股字段一致：
//! 1=名称 3=现价 32=涨跌幅%）；`endpoint` 可配置是长期后路 ——
//! 内置端点会变、会被限流，收敛成一处配置出问题用户自己就能改。

use std::sync::Mutex;
use std::time::Duration;

use serde::{Deserialize, Serialize};

use super::store;
use super::{Plugin, PluginCard, PluginMeta, Priority, ScheduleCtx, TickCtx};

/// 插件 id（配置文件名 / 前端渲染器 key）。
pub const ID: &str = "stocks";

/// 缓存文件名（快照与防重，程序域）。
const STATE_FILE: &str = "stocks-cache";

/// 两张股票卡之间的最小间隔（分钟）。设计 5.1：股票 45min。
const STOCKS_GAP_MINS: u64 = 45;

/// 行情拉取节流（分钟）。
const FETCH_GAP_MINS: u64 = 10;

/// 最多关注的标的数（防配置里粘一整屏代码）。
const MAX_SYMBOLS: usize = 10;

/// 轻量轮询间隔：读配置感知开关（只读本地文件）。
const CHECK_INTERVAL: Duration = Duration::from_secs(30);

// ---------- 配置 ----------

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct StocksConfig {
    pub enabled: bool,
    /// 关注标的（腾讯格式：sh600519 / hk00700 / usAAPL）。
    pub symbols: Vec<String>,
    /// 行情端点前缀（symbol 以逗号拼接在后）。可改，是接口失效时的后路。
    pub endpoint: String,
    /// 展示时段（["HH:MM","HH:MM"]，本地时间）。盘中/工作时间不出卡。
    pub windows: Vec<[String; 2]>,
    /// 变动阈值（百分点）：与上次出卡快照比较，超过才算「值得说」。
    pub change_threshold_pct: f64,
    /// 收盘总结时刻（"HH:MM"）。空串 = 关闭收盘总结。
    pub summarize_after: String,
}

impl Default for StocksConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            symbols: Vec::new(),
            endpoint: "https://qt.gtimg.cn/q=".into(),
            windows: vec![
                ["12:00".into(), "13:30".into()],
                ["15:30".into(), "18:00".into()],
            ],
            change_threshold_pct: 2.0,
            summarize_after: "15:05".into(),
        }
    }
}

fn clamp_cfg(mut c: StocksConfig) -> StocksConfig {
    c.symbols.retain(|s| !s.trim().is_empty());
    c.symbols.truncate(MAX_SYMBOLS);
    if c.endpoint.is_empty() {
        c.endpoint = StocksConfig::default().endpoint;
    }
    c.windows.retain(|w| parse_hhmm(&w[0]).is_some() && parse_hhmm(&w[1]).is_some());
    if c.windows.is_empty() {
        c.windows = StocksConfig::default().windows;
    }
    if !(0.1..=20.0).contains(&c.change_threshold_pct) || c.change_threshold_pct.is_nan() {
        c.change_threshold_pct = 2.0;
    }
    if !c.summarize_after.is_empty() && parse_hhmm(&c.summarize_after).is_none() {
        c.summarize_after = "15:05".into();
    }
    c
}

pub fn load_config(app: &tauri::AppHandle) -> StocksConfig {
    clamp_cfg(store::load(app, ID))
}

/// "HH:MM" → 当日分钟数。
fn parse_hhmm(s: &str) -> Option<u32> {
    let (h, m) = s.trim().split_once(':')?;
    let h: u32 = h.parse().ok()?;
    let m: u32 = m.parse().ok()?;
    if h > 23 || m > 59 {
        return None;
    }
    Some(h * 60 + m)
}

/// 当前分钟是否落在任一展示时段内（含起点，不含终点）。
fn in_windows(minutes: u32, windows: &[[String; 2]]) -> bool {
    windows.iter().any(|w| {
        match (parse_hhmm(&w[0]), parse_hhmm(&w[1])) {
            (Some(a), Some(b)) if a <= b => minutes >= a && minutes < b,
            // 跨午夜窗口（如 22:00-02:00）：两段分别判断
            (Some(a), Some(b)) => minutes >= a || minutes < b,
            _ => false,
        }
    })
}

// ---------- 行情与缓存 ----------

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Quote {
    pub symbol: String,
    pub name: String,
    pub price: f64,
    pub change_pct: f64,
}

#[derive(Debug, Default, Clone, Serialize, Deserialize)]
struct StocksState {
    date: String,
    /// 最近一次成功拉取的快照（当日有效）。
    quotes: Vec<Quote>,
    /// 上次出卡时的快照（变动比较基准；空 = 尚未建立基准）。
    last_card_quotes: Vec<Quote>,
    last_fetch_mins: u64,
    last_card_mins: u64,
    /// 收盘总结已发到哪天（防重启重复发）。
    summarized_date: String,
    /// 总结卡的 LLM 点评（fetch 旁路生成）。
    digest: String,
}

static STATE: Mutex<Option<StocksState>> = Mutex::new(None);

fn with_state<R>(f: impl FnOnce(&mut StocksState) -> R) -> R {
    let mut g = STATE.lock().expect("stocks state poisoned");
    let s = g.get_or_insert_with(StocksState::default);
    f(s)
}

fn save_state(app: &tauri::AppHandle) {
    let s = with_state(|s| s.clone());
    if let Err(e) = store::save(app, STATE_FILE, &s) {
        eprintln!("[plugin:{ID}] 缓存落盘失败（内存继续用）：{e}");
    }
}

fn load_state(app: &tauri::AppHandle) {
    let s: StocksState = store::load(app, STATE_FILE);
    with_state(|g| *g = s);
}

/// 跨天重置（纯函数，单测入口）。
fn rollover(s: &mut StocksState, today: &str) {
    if s.date != today {
        *s = StocksState {
            date: today.to_string(),
            ..Default::default()
        };
    }
}

/// 解析腾讯行情的一行（输入须已转 UTF-8）：
/// `v_sh600519="1~贵州茅台~600519~1297.50~1299.56~..."`。
///
/// 涨跌幅字段的下标在 A 股/港股/美股间不稳定（实测不一致），但
/// `1=名称 3=现价 4=昨收` 三市场全部稳定 —— 因此涨跌幅**用昨收计算**，
/// 不依赖任何尾部字段下标。
fn parse_line(line: &str) -> Option<Quote> {
    let eq = line.find('=')?;
    let symbol = line[..eq].trim_start_matches("v_").trim().to_string();
    if symbol.is_empty() {
        return None;
    }
    let rest = line[eq + 1..].trim();
    let rest = rest.trim_end_matches(';').trim_matches('"');
    let f: Vec<&str> = rest.split('~').collect();
    if f.len() < 5 {
        return None;
    }
    let price: f64 = f[3].trim().parse().ok()?;
    let prev_close: f64 = f[4].trim().parse().ok()?;
    if price <= 0.0 || prev_close <= 0.0 {
        return None;
    }
    let change_pct = (price - prev_close) / prev_close * 100.0;
    Some(Quote {
        symbol,
        name: f[1].trim().to_string(),
        price,
        change_pct,
    })
}

/// 与上次出卡快照比较，返回值得说的变动（涨跌幅变化 ≥ 阈值）。
/// 基准为空表示尚未建立（首拉取，只建基准不出卡）。
fn significant_changes(cur: &[Quote], baseline: &[Quote], threshold: f64) -> Option<Vec<Quote>> {
    if baseline.is_empty() {
        return None;
    }
    let hits: Vec<Quote> = cur
        .iter()
        .filter(|q| {
            baseline
                .iter()
                .find(|b| b.symbol == q.symbol)
                .map(|b| (q.change_pct - b.change_pct).abs() >= threshold)
                .unwrap_or(false)
        })
        .cloned()
        .collect();
    (!hits.is_empty()).then_some(hits)
}

/// 异步拉取全部标的并写入快照；到总结时刻且未总结时顺手生成 LLM 点评。
fn spawn_fetch(cfg: StocksConfig, today: String, app: tauri::AppHandle) {
    std::thread::spawn(move || {
        let rt = match tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
        {
            Ok(rt) => rt,
            Err(_) => return,
        };
        let Ok(client) = reqwest::Client::builder()
            .timeout(Duration::from_secs(10))
            .user_agent("Mozilla/5.0 (vibe-pet)")
            .build()
        else {
            return;
        };
        let url = format!("{}{}", cfg.endpoint, cfg.symbols.join(","));
        let fetched: Result<Vec<u8>, reqwest::Error> = rt.block_on(async {
            let resp = client.get(&url).send().await?.error_for_status()?;
            Ok(resp.bytes().await?.to_vec())
        });
        let bytes = match fetched {
            Ok(bytes) => bytes,
            Err(e) => {
                // 行情失败静默：下个窗口再试，不打扰用户
                eprintln!("[plugin:{ID}] 行情拉取失败（静默重试）：{e}");
                return;
            }
        };
        let (text, _, _) = encoding_rs::GBK.decode(&bytes);
        let quotes: Vec<Quote> = text
            .lines()
            .filter_map(parse_line)
            .filter(|q| cfg.symbols.iter().any(|s| s == &q.symbol))
            .collect();
        if quotes.is_empty() {
            eprintln!("[plugin:{ID}] 行情解析为空（symbols 或接口格式可能有变）");
            return;
        }
        let digest_needed = {
            let now_min = crate::reminddrive::local_now().map(|c| c.minutes).unwrap_or(0);
            let after = parse_hhmm(&cfg.summarize_after);
            with_state(|s| {
                s.date = today.clone();
                s.quotes = quotes.clone();
                s.last_fetch_mins = epoch_mins();
                // 基准为空则建立基准（首拉取不出卡）
                if s.last_card_quotes.is_empty() {
                    s.last_card_quotes = quotes.clone();
                }
                !cfg.summarize_after.is_empty()
                    && after.is_some_and(|a| now_min >= a)
                    && s.summarized_date != today
            })
        };
        save_state(&app);
        if digest_needed {
            spawn_digest(quotes, today, app);
        }
    });
}

/// 异步生成收盘总结的一句点评。
fn spawn_digest(quotes: Vec<Quote>, today: String, app: tauri::AppHandle) {
    std::thread::spawn(move || {
        let llm = crate::configcmd::current().llm;
        if !llm.enabled || llm.api_key.is_empty() {
            return; // 未配置 LLM：总结卡只显示数字
        }
        let rt = match tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
        {
            Ok(rt) => rt,
            Err(_) => return,
        };
        let user = quotes
            .iter()
            .map(|q| format!("{}（{}）：{:.2}，{:+.2}%", q.name, q.symbol, q.price, q.change_pct))
            .collect::<Vec<_>>()
            .join("；");
        let system = concat!(
            "你把一组收盘行情数字浓缩成一句 35 字内的中文点评，",
            "点出领涨领跌与整体情绪。只输出这句话本身。禁止编造任何数字。"
        );
        let Ok(out) = rt.block_on(crate::llm::complete(&llm, system, &user, false)) else {
            return;
        };
        let hit = with_state(|s| {
            if s.date == today {
                s.digest = out.chars().take(60).collect();
                true
            } else {
                false // 跨天了，别写
            }
        });
        if hit {
            save_state(&app);
        }
    });
}

// ---------- 插件本体 ----------

pub struct StocksPlugin;

impl StocksPlugin {
    pub fn new(app: &tauri::AppHandle) -> Self {
        load_state(app);
        Self
    }
}

impl Plugin for StocksPlugin {
    fn id(&self) -> &'static str {
        ID
    }

    fn name(&self) -> &'static str {
        "股市投资"
    }

    fn next_tick(&self, _ctx: &ScheduleCtx) -> Option<Duration> {
        Some(CHECK_INTERVAL)
    }

    fn tick(&mut self, ctx: &mut TickCtx) -> Vec<PluginCard> {
        let cfg = load_config(ctx.app);
        if !cfg.enabled || cfg.symbols.is_empty() {
            return Vec::new();
        }
        let Some(now_ctx) = crate::reminddrive::local_now() else {
            return Vec::new();
        };
        let today = now_ctx.date.clone();
        let now = epoch_mins();
        let now_min = now_ctx.minutes;

        with_state(|s| rollover(s, &today));

        // —— 收盘总结：到点、有当日快照、未发过 ——
        if !cfg.summarize_after.is_empty() {
            if let Some(after) = parse_hhmm(&cfg.summarize_after) {
                let llm_off = {
                    let llm = crate::configcmd::current().llm;
                    !llm.enabled || llm.api_key.is_empty()
                };
                let ready = with_state(|s| {
                    s.date == today
                        && !s.quotes.is_empty()
                        && s.summarized_date != today
                        && (llm_off || !s.digest.is_empty())
                });
                if now_min >= after && ready {
                    let (items, digest) = with_state(|s| {
                        s.summarized_date = today.clone();
                        s.last_card_mins = now;
                        s.last_card_quotes = s.quotes.clone();
                        (s.quotes.clone(), s.digest.clone())
                    });
                    save_state(ctx.app);
                    return vec![make_card(&items, &digest, true)];
                }
            }
        }

        // —— 展示时段内：拉取节流 + 变动判定 ——
        if !in_windows(now_min, &cfg.windows) {
            return Vec::new(); // 盘中/工作时间不出卡也不拉取
        }

        let need_fetch = with_state(|s| {
            s.date == today && now.saturating_sub(s.last_fetch_mins) >= FETCH_GAP_MINS
        });
        if need_fetch {
            with_state(|s| s.last_fetch_mins = now); // 防重复触发
            spawn_fetch(cfg.clone(), today.clone(), ctx.app.clone());
        }

        let card = with_state(|s| {
            if s.date != today || s.quotes.is_empty() {
                return None;
            }
            if now.saturating_sub(s.last_card_mins) < STOCKS_GAP_MINS {
                return None;
            }
            let hits = significant_changes(&s.quotes, &s.last_card_quotes, cfg.change_threshold_pct)?;
            s.last_card_mins = now;
            s.last_card_quotes = s.quotes.clone();
            Some(hits)
        });
        match card {
            Some(hits) => {
                save_state(ctx.app);
                vec![make_card(&hits, "", false)]
            }
            None => Vec::new(),
        }
    }
}

fn make_card(items: &[Quote], digest: &str, summary: bool) -> PluginCard {
    PluginCard {
        plugin_id: ID.into(),
        kind: ID.into(),
        priority: Priority::Normal,
        ttl_secs: 25,
        payload: serde_json::json!({
            "summary": summary,
            "items": items,
            "digest": if digest.is_empty() { None } else { Some(digest) },
            "ai": !digest.is_empty(),
        }),
    }
}

fn epoch_mins() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() / 60)
        .unwrap_or(0)
}

/// 左键面板 / 设置用元信息。
pub fn meta(app: &tauri::AppHandle) -> PluginMeta {
    let cfg = load_config(app);
    let today = crate::reminddrive::local_now()
        .map(|c| c.date)
        .unwrap_or_default();
    let s = STATE.lock().ok().and_then(|g| g.clone());
    let quotes = match s {
        Some(mut s) if s.date == today => {
            rollover(&mut s, &today);
            s.quotes.clone()
        }
        _ => Vec::new(),
    };
    PluginMeta {
        id: ID.into(),
        name: "股市投资".into(),
        kind: ID.into(),
        summary: serde_json::json!({
            "enabled": cfg.enabled,
            "symbols": cfg.symbols,
            "quotes": quotes,
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const A_SHARE: &str = r#"v_sh600519="1~贵州茅台~600519~1297.50~1299.56~1302.80~20308~10081~10227~1297.50~7~1297.40~8~1297.37~1~1297.33~1~1297.20~1~1297.54~3~1297.55~2~1297.60~1~1297.66~1~~20260902161444~-2.06~-0.16~1303.00~1291.20~1297.50/20308/2634084231~20308~263408~0.16~19.92~~1303.00~1291.20~0.91~16219.81~16219.81~6.46~1429.52~11.50~0.00~0.00";"#;
    const US_SHARE: &str =
        "v_usAAPL=\"200~苹果~AAPL.OQ~325.13~316.85~316.98~53167388~0~0~325.13~480~0~0~0~0~0~0~0~0~325.15~40~0~0~0~0~0~0~0~0~~2026-09-01 16:00:01~8.28~2.61~327.30~314.73~USD~53167388~17233056050~0.36~37.29~~43\";";

    #[test]
    fn 解析a股与美股样例行() {
        let q = parse_line(A_SHARE).unwrap();
        assert_eq!(q.symbol, "sh600519");
        assert_eq!(q.name, "贵州茅台");
        assert_eq!(q.price, 1297.50);
        // (1297.50 - 1299.56) / 1299.56 ≈ -0.16%
        assert!((q.change_pct - (-0.16)).abs() < 0.01);

        let q = parse_line(US_SHARE).unwrap();
        assert_eq!(q.symbol, "usAAPL");
        assert_eq!(q.name, "苹果");
        assert_eq!(q.price, 325.13);
        assert!((q.change_pct - 2.61).abs() < 0.01);
    }

    #[test]
    fn 解析失败返回None而非panic() {
        assert!(parse_line("").is_none());
        assert!(parse_line("garbage").is_none());
        // 字段数不足
        assert!(parse_line(r#"v_x="1~太短~code""#).is_none());
        // 价格为 0（停牌/脏数据）
        assert!(parse_line(&format!("v_x=\"{}\"", {
            let mut f = vec!["0"; 40];
            f[1] = "名";
            f[3] = "0.00";
            f[32] = "0.00";
            f.join("~")
        })).is_none());
    }

    #[test]
    fn 时段判定含起点不含终点_支持跨午夜() {
        let w = [["12:00".to_string(), "13:30".to_string()]];
        assert!(in_windows(12 * 60, &w));
        assert!(in_windows(13 * 60 + 29, &w));
        assert!(!in_windows(13 * 60 + 30, &w), "终点不含");
        assert!(!in_windows(9 * 60, &w), "盘中不出");

        let night = [["22:00".to_string(), "02:00".to_string()]];
        assert!(in_windows(23 * 60, &night));
        assert!(in_windows(1 * 60, &night), "跨午夜窗口的后半段");
        assert!(!in_windows(12 * 60, &night));
    }

    #[test]
    fn 变动判定_基准为空不出卡_超阈值才出() {
        let cur = vec![Quote {
            symbol: "s".into(),
            name: "n".into(),
            price: 10.0,
            change_pct: 3.0,
        }];
        // 基准为空：只建基准不出卡
        assert!(significant_changes(&cur, &[], 2.0).is_none());

        let base = vec![Quote {
            symbol: "s".into(),
            name: "n".into(),
            price: 10.0,
            change_pct: 1.0,
        }];
        // 变化 2.0 个百分点 = 阈值 → 出
        let hits = significant_changes(&cur, &base, 2.0).unwrap();
        assert_eq!(hits.len(), 1);

        // 变化不足阈值 → 不出
        let base2 = vec![Quote {
            symbol: "s".into(),
            name: "n".into(),
            price: 10.0,
            change_pct: 2.5,
        }];
        assert!(significant_changes(&cur, &base2, 2.0).is_none());
    }

    #[test]
    fn 配置钳制标的数与非法字段() {
        let c = clamp_cfg(StocksConfig {
            symbols: (0..20).map(|i| format!("s{i}")).collect(),
            endpoint: String::new(),
            windows: vec![["9:99".into(), "10:00".into()]],
            change_threshold_pct: 999.0,
            summarize_after: "25:00".into(),
            ..Default::default()
        });
        assert_eq!(c.symbols.len(), MAX_SYMBOLS);
        assert!(!c.endpoint.is_empty(), "空端点回退默认");
        assert_eq!(c.windows.len(), 2, "非法窗口回退默认");
        assert_eq!(c.change_threshold_pct, 2.0);
        assert_eq!(c.summarize_after, "15:05");
    }

    #[test]
    fn 跨天重置快照与总结防重标记() {
        let mut s = StocksState {
            date: "2026-09-01".into(),
            quotes: vec![Quote {
                symbol: "s".into(),
                name: "n".into(),
                price: 1.0,
                change_pct: 1.0,
            }],
            summarized_date: "2026-09-01".into(),
            digest: "旧点评".into(),
            ..Default::default()
        };
        rollover(&mut s, "2026-09-02");
        assert_eq!(s.date, "2026-09-02");
        assert!(s.quotes.is_empty());
        assert_eq!(s.summarized_date, "", "新的一天允许再发总结");
        assert!(s.digest.is_empty());
    }

    #[test]
    fn 旧配置缺字段补默认值() {
        let c: StocksConfig = serde_json::from_str(r#"{"enabled":true,"symbols":["sh600519"]}"#).unwrap();
        assert!(c.enabled);
        assert_eq!(c.symbols, vec!["sh600519".to_string()]);
        assert!(c.endpoint.starts_with("https://"));
        assert_eq!(c.windows.len(), 2);
        assert_eq!(c.summarize_after, "15:05");
    }

    #[test]
    fn 卡片payload带数字与点评标记() {
        let items = vec![Quote {
            symbol: "sh600519".into(),
            name: "贵州茅台".into(),
            price: 1297.5,
            change_pct: -0.16,
        }];
        let c = make_card(&items, "白酒走弱", true);
        assert_eq!(c.payload["summary"], true);
        assert_eq!(c.payload["ai"], true);
        assert_eq!(c.payload["items"][0]["symbol"], "sh600519");

        let c2 = make_card(&items, "", false);
        assert_eq!(c2.payload["ai"], false);
        assert!(c2.payload["digest"].is_null(), "无点评时 digest 为 null");
    }
}
