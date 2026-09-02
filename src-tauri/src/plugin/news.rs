//! 每日资讯插件：RSS 拉取 + 类别过滤 + 当日缓存（设计文档 6.2）。
//!
//! 三条原则：
//! - 每天 `fetch_hour` **拉一次**（只拉选中类别），结果落盘缓存；当日后续
//!   tick 只从缓存出卡，不再请求网络 —— 资讯不需要实时性。
//! - 标题与链接永远来自源站（真实 URL，点了必须能开）；LLM 只把当日头条
//!   浓缩成一句 `digest` 附在卡上，未配置 LLM 则 digest 为空。
//! - 源失败**静默**（下个 fetch 周期再试），绝不弹错误气泡 —— 源站挂了
//!   不是用户需要知道的事。
//!
//! 网络全部走异步旁路线程（与 words 的 LLM 增强同一模式）—— host 线程
//! 绝不被网络请求阻塞，其他插件不受影响。
//!
//! 内置源清单可用性以 2026-09-02 网络实测为准；世界类中文源（BBC 等）
//! 在目标网络不可达，暂缺 —— 见设计文档「明确不做」的诚实记录。

use std::sync::Mutex;
use std::time::Duration;

use serde::{Deserialize, Serialize};

use super::store;
use super::{Plugin, PluginCard, PluginMeta, Priority, ScheduleCtx, TickCtx};

/// 插件 id（配置文件名 / 前端渲染器 key）。
pub const ID: &str = "news";

/// 缓存文件名（拉取结果 + 游标，程序域）。
const STATE_FILE: &str = "news-cache";

/// 两张资讯卡之间的最小间隔（分钟）。设计 5.1：资讯 2h。
const NEWS_GAP_MINS: u64 = 120;

/// 每个源最多取的条数（控制当日缓存规模）。
const PER_SOURCE_ITEMS: usize = 8;

/// 轻量轮询间隔：读配置感知开关（只读本地文件）。
const CHECK_INTERVAL: Duration = Duration::from_secs(30);

// ---------- 内置源清单 ----------

struct RssSource {
    id: &'static str,
    name: &'static str,
    url: &'static str,
    category: &'static str,
}

const SOURCES: &[RssSource] = &[
    RssSource {
        id: "sspai",
        name: "少数派",
        url: "https://sspai.com/feed",
        category: "tech",
    },
    RssSource {
        id: "36kr",
        name: "36氪",
        url: "https://36kr.com/feed",
        category: "tech",
    },
    RssSource {
        id: "ithome",
        name: "IT之家",
        url: "https://www.ithome.com/rss/",
        category: "tech",
    },
    RssSource {
        id: "solidot",
        name: "奇客",
        url: "https://www.solidot.org/index.rss",
        category: "tech",
    },
    RssSource {
        id: "nyt-biz",
        name: "NYT 商业",
        url: "https://rss.nytimes.com/services/xml/rss/nyt/Business.xml",
        category: "finance",
    },
    RssSource {
        id: "wsj",
        name: "WSJ 市场",
        url: "https://feeds.a.dj.com/rss/RSSMarketsMain.xml",
        category: "finance",
    },
    RssSource {
        id: "uisdc",
        name: "优设",
        url: "https://www.uisdc.com/feed",
        category: "design",
    },
];

/// 类别（id，中文名）。用户最多选 3 个。
const CATEGORIES: &[(&str, &str)] = &[
    ("tech", "科技"),
    ("finance", "财经"),
    ("design", "设计"),
];

pub fn category_label(id: &str) -> &'static str {
    CATEGORIES
        .iter()
        .find(|(c, _)| *c == id)
        .map(|(_, name)| *name)
        .unwrap_or("资讯")
}

// ---------- 配置 ----------

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct NewsConfig {
    pub enabled: bool,
    /// 关注类别（≤3，内置清单里选）。
    pub categories: Vec<String>,
    /// 每天几点拉取（0-23，本地时间）。
    pub fetch_hour: u32,
}

impl Default for NewsConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            categories: vec!["tech".into()],
            fetch_hour: 9,
        }
    }
}

fn clamp_cfg(mut c: NewsConfig) -> NewsConfig {
    c.categories.retain(|x| CATEGORIES.iter().any(|(id, _)| id == x));
    c.categories.truncate(3);
    if c.categories.is_empty() {
        c.categories = vec!["tech".into()];
    }
    c.fetch_hour = c.fetch_hour.min(23);
    c
}

pub fn load_config(app: &tauri::AppHandle) -> NewsConfig {
    clamp_cfg(store::load(app, ID))
}

// ---------- 当日缓存 ----------

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct NewsItem {
    pub headline: String,
    pub source: String,
    pub url: String,
}

#[derive(Debug, Default, Clone, Serialize, Deserialize)]
struct NewsState {
    /// 缓存属于哪天（跨天重置）。
    date: String,
    items: Vec<NewsItem>,
    /// 下一张卡的游标（当日顺序消费）。
    next_idx: usize,
    /// LLM 当日点评（可空）。
    digest: String,
    /// 今天是否已拉取。
    fetched: bool,
    /// 上次出卡时刻（epoch 分钟），频率闸。
    last_card_mins: u64,
}

static STATE: Mutex<Option<NewsState>> = Mutex::new(None);

fn with_state<R>(f: impl FnOnce(&mut NewsState) -> R) -> R {
    let mut g = STATE.lock().expect("news state poisoned");
    let s = g.get_or_insert_with(NewsState::default);
    f(s)
}

fn save_state(app: &tauri::AppHandle) {
    let s = with_state(|s| s.clone());
    if let Err(e) = store::save(app, STATE_FILE, &s) {
        eprintln!("[plugin:{ID}] 缓存落盘失败（内存继续用）：{e}");
    }
}

fn load_state(app: &tauri::AppHandle) {
    let s: NewsState = store::load(app, STATE_FILE);
    with_state(|g| *g = s);
}

/// 跨天重置缓存（纯函数，单测入口）。
fn rollover(s: &mut NewsState, today: &str) {
    if s.date != today {
        *s = NewsState {
            date: today.to_string(),
            ..Default::default()
        };
    }
}

// ---------- 解析与拉取（纯函数 + 异步旁路） ----------

/// 从一段 RSS 2.0 文本提取条目（解析交给 rss crate，这里只做裁剪）。
fn collect_from(text: &str, source_name: &str) -> Vec<NewsItem> {
    let Ok(ch) = rss::Channel::read_from(text.as_bytes()) else {
        return Vec::new();
    };
    ch.items()
        .iter()
        .take(PER_SOURCE_ITEMS)
        .filter_map(|it| {
            let headline = it.title()?.trim().to_string();
            let url = it.link()?.trim().to_string();
            if headline.is_empty() || url.is_empty() {
                return None;
            }
            Some(NewsItem {
                headline,
                source: source_name.to_string(),
                url,
            })
        })
        .collect()
}

/// 合并多源条目并按链接去重（先到先得）。
fn merge_dedup(batches: Vec<Vec<NewsItem>>) -> Vec<NewsItem> {
    let mut seen = std::collections::HashSet::new();
    let mut out = Vec::new();
    for item in batches.into_iter().flatten() {
        if seen.insert(item.url.clone()) {
            out.push(item);
        }
    }
    out
}

fn sources_for(categories: &[String]) -> Vec<&'static RssSource> {
    SOURCES
        .iter()
        .filter(|s| categories.iter().any(|c| c == s.category))
        .collect()
}

/// 异步拉取选中类别的全部源并写入缓存；成功后顺手让 LLM 浓缩当日点评。
fn spawn_fetch(cfg: NewsConfig, today: String, app: tauri::AppHandle) {
    std::thread::spawn(move || {
        let rt = match tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
        {
            Ok(rt) => rt,
            Err(_) => return,
        };
        let mut batches = Vec::new();
        for src in sources_for(&cfg.categories) {
            // 部分源要求 UA；超时 15s —— 单源挂了不拖死整轮
            let req = reqwest::Client::builder()
                .timeout(Duration::from_secs(15))
                .user_agent("Mozilla/5.0 (vibe-pet)")
                .build();
            let Ok(client) = req else { continue };
            let fetched: Result<String, reqwest::Error> = rt.block_on(async {
                let resp = client.get(src.url).send().await?;
                let resp = resp.error_for_status()?;
                let bytes = resp.bytes().await?;
                Ok(String::from_utf8_lossy(&bytes).into_owned())
            });
            match fetched {
                Ok(text) => {
                    let items = collect_from(&text, src.name);
                    eprintln!("[plugin:{ID}] {}：{} 条", src.name, items.len());
                    batches.push(items);
                }
                Err(e) => {
                    // 源失败静默：下个 fetch 周期再试，不打扰用户
                    eprintln!("[plugin:{ID}] 源 {} 拉取失败（静默重试）：{e}", src.name);
                }
            }
        }

        let items = merge_dedup(batches);
        with_state(|s| {
            s.date = today.clone();
            s.items = items.clone();
            s.next_idx = 0;
            s.digest = String::new();
            s.fetched = true;
        });
        save_state(&app);

        if !items.is_empty() {
            spawn_digest(cfg, items, today, app);
        }
    });
}

/// 异步生成当日一句点评，写入缓存。
fn spawn_digest(cfg: NewsConfig, items: Vec<NewsItem>, today: String, app: tauri::AppHandle) {
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
        let heads: Vec<String> = items
            .iter()
            .take(5)
            .map(|i| format!("{}：{}", i.source, i.headline))
            .collect();
        let user = format!(
            "关注类别：{}\n今日头条：\n{}",
            cfg.categories
                .iter()
                .map(|c| category_label(c))
                .collect::<Vec<_>>()
                .join("、"),
            heads.join("\n")
        );
        let system = concat!(
            "你把几条资讯标题浓缩成一句 35 字内的中文点评，",
            "点出共同主题或最值得注意的一条。只输出这句话本身，不要任何前后缀。"
        );
        let Ok(out) = rt.block_on(crate::llm::complete(&llm, system, &user, false)) else {
            return;
        };
        let digest: String = out.chars().take(60).collect();
        let hit = with_state(|s| {
            if s.date == today && s.fetched {
                s.digest = digest.clone();
                true
            } else {
                false // 跨天了，别把昨天的点评写到今天
            }
        });
        if hit {
            save_state(&app);
        }
    });
}

// ---------- 插件本体 ----------

pub struct NewsPlugin;

impl NewsPlugin {
    pub fn new(app: &tauri::AppHandle) -> Self {
        load_state(app);
        Self
    }
}

impl Plugin for NewsPlugin {
    fn id(&self) -> &'static str {
        ID
    }

    fn name(&self) -> &'static str {
        "每日资讯"
    }

    fn next_tick(&self, _ctx: &ScheduleCtx) -> Option<Duration> {
        Some(CHECK_INTERVAL)
    }

    fn tick(&mut self, ctx: &mut TickCtx) -> Vec<PluginCard> {
        let cfg = load_config(ctx.app);
        if !cfg.enabled {
            return Vec::new();
        }
        let Some(now_ctx) = crate::reminddrive::local_now() else {
            return Vec::new();
        };
        let today = now_ctx.date.clone();
        let now = epoch_mins();

        // 该拉取了（拉取走异步旁路，tick 只负责触发）
        let need_fetch = with_state(|s| {
            rollover(s, &today);
            !s.fetched && (now_ctx.minutes / 60) >= cfg.fetch_hour
        });
        if need_fetch {
            with_state(|s| s.fetched = true); // 防止下个 tick 重复触发
            spawn_fetch(cfg.clone(), today.clone(), ctx.app.clone());
        }

        // 出卡：有缓存、有剩余、间隔已过
        let card = with_state(|s| {
            if !s.fetched || s.next_idx >= s.items.len() {
                return None;
            }
            if now.saturating_sub(s.last_card_mins) < NEWS_GAP_MINS {
                return None;
            }
            let item = s.items[s.next_idx].clone();
            s.next_idx += 1;
            s.last_card_mins = now;
            let digest = if s.digest.is_empty() {
                None
            } else {
                Some(s.digest.clone())
            };
            Some((item, digest))
        });
        let Some((item, digest)) = card else {
            return Vec::new();
        };
        save_state(ctx.app);

        vec![PluginCard {
            plugin_id: ID.into(),
            kind: ID.into(),
            priority: Priority::Low,
            ttl_secs: 20,
            payload: serde_json::json!({
                "headline": item.headline,
                "source": item.source,
                "url": item.url,
                "digest": digest,
                "ai": digest.is_some(),
            }),
        }]
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
    let (total, remaining, latest) = match s {
        Some(mut s) => {
            rollover(&mut s, &today);
            let remaining = s.items.len().saturating_sub(s.next_idx);
            let latest: Vec<serde_json::Value> = s
                .items
                .iter()
                .rev()
                .take(5)
                .map(|i| {
                    serde_json::json!({ "headline": i.headline, "source": i.source, "url": i.url })
                })
                .collect();
            (s.items.len(), remaining, latest)
        }
        None => (0, 0, Vec::new()),
    };
    PluginMeta {
        id: ID.into(),
        name: "每日资讯".into(),
        kind: ID.into(),
        summary: serde_json::json!({
            "enabled": cfg.enabled,
            "categories": cfg.categories,
            "today_count": total,
            "remaining": remaining,
            "latest": latest,
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE_RSS: &str = r#"<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel>
<title>Test</title>
<item><title>第一条 &amp; 细节</title><link>https://example.com/1</link></item>
<item><title>第二条</title><link>https://example.com/2</link></item>
<item><title>无链接</title></item>
</channel></rss>"#;

    #[test]
    fn 解析样例rss并跳过缺链接条目() {
        let items = collect_from(SAMPLE_RSS, "测试源");
        assert_eq!(items.len(), 2);
        assert_eq!(items[0].headline, "第一条 & 细节");
        assert_eq!(items[0].url, "https://example.com/1");
        assert_eq!(items[0].source, "测试源");
    }

    #[test]
    fn 解析失败返回空而非panic() {
        assert!(collect_from("not xml at all", "x").is_empty());
        assert!(collect_from("", "x").is_empty());
    }

    #[test]
    fn 合并去重按链接先到先得() {
        let a = vec![
            NewsItem { headline: "h1".into(), source: "s".into(), url: "https://x/1".into() },
            NewsItem { headline: "h2".into(), source: "s".into(), url: "https://x/2".into() },
        ];
        let b = vec![
            NewsItem { headline: "h1-dup".into(), source: "s2".into(), url: "https://x/1".into() },
            NewsItem { headline: "h3".into(), source: "s2".into(), url: "https://x/3".into() },
        ];
        let merged = merge_dedup(vec![a, b]);
        assert_eq!(merged.len(), 3);
        assert_eq!(merged[0].headline, "h1", "先到的保留");
    }

    #[test]
    fn 类别过滤选出对应源() {
        let srcs = sources_for(&["finance".to_string()]);
        assert!(srcs.iter().all(|s| s.category == "finance"));
        assert_eq!(srcs.len(), 2);

        let srcs = sources_for(&["tech".to_string(), "design".to_string()]);
        assert_eq!(srcs.len(), 5);
    }

    #[test]
    fn 配置钳制类别数量与合法性() {
        let c = clamp_cfg(NewsConfig {
            enabled: true,
            categories: vec!["tech".into(), "finance".into(), "design".into(), "tech".into()],
            fetch_hour: 99,
        });
        assert_eq!(c.categories.len(), 3, "最多三个类别");
        assert_eq!(c.fetch_hour, 23);

        let c = clamp_cfg(NewsConfig {
            categories: vec!["world".into()],
            ..Default::default()
        });
        assert_eq!(c.categories, vec!["tech".to_string()], "非法类别回退默认");
    }

    #[test]
    fn 跨天重置缓存与游标() {
        let mut s = NewsState {
            date: "2026-09-01".into(),
            items: vec![NewsItem {
                headline: "x".into(),
                source: "s".into(),
                url: "u".into(),
            }],
            next_idx: 1,
            digest: "昨日点评".into(),
            fetched: true,
            last_card_mins: 42,
        };
        rollover(&mut s, "2026-09-02");
        assert_eq!(s.date, "2026-09-02");
        assert!(s.items.is_empty());
        assert_eq!(s.next_idx, 0);
        assert!(!s.fetched);
        assert!(s.digest.is_empty());

        // 同日不动
        rollover(&mut s, "2026-09-02");
        assert_eq!(s.date, "2026-09-02");
    }

    #[test]
    fn 旧配置缺字段补默认值() {
        let c: NewsConfig = serde_json::from_str(r#"{"enabled":true}"#).unwrap();
        assert!(c.enabled);
        assert_eq!(c.categories, vec!["tech".to_string()]);
        assert_eq!(c.fetch_hour, 9);
    }

    #[test]
    fn 内置源全部带合法类别与url() {
        for s in SOURCES {
            assert!(!s.name.is_empty());
            assert!(s.url.starts_with("https://"), "{} 的 url 必须是 https", s.id);
            assert!(
                CATEGORIES.iter().any(|(c, _)| *c == s.category),
                "{} 类别非法",
                s.id
            );
        }
    }
}
