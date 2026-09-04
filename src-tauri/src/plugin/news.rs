//! 每日资讯插件：RSS 拉取 + 类别过滤 + 当日缓存（设计文档 6.2）。
//!
//! 四条原则：
//! - **增量抓取**：从每天 `fetch_hour` 起每 2 小时拉一轮（只拉选中类别），
//!   只收集 pubDate 为**本地当天**的条目入缓存 —— 一手博客当天下午发的
//!   也能看到；当天没有新内容就静默不出卡，绝不拿昨天的凑数。
//! - 标题与链接永远来自源站（真实 URL，点了必须能开）；LLM 只把当日头条
//!   浓缩成一句 `digest` 附在卡上（当天只在首批内容时生成一次，增量轮不
//!   重复调用，省 token），未配置 LLM 则 digest 为空。
//! - 源失败**静默**（下轮增量自然重试），绝不弹错误气泡 —— 源站挂了
//!   不是用户需要知道的事。
//! - tech 类源聚焦「AI 一手进展 + 互联网广告行业」：大模型官网技术博客
//!   （OpenAI / DeepMind / Google AI / Hugging Face）、业界播客（Latent
//!   Space）、广告行业一手媒体（Adweek / AdExchanger / Modern Retail）、
//!   中文聚合补充（量子位）。「筛选」靠两层实现：源级聚焦 + 仅当天过滤。
//!
//! 网络全部走异步旁路线程（与 words 的 LLM 增强同一模式）—— host 线程
//! 绝不被网络请求阻塞，其他插件不受影响。
//!
//! 内置源清单可用性以 2026-09-04 网络实测为准；机器之心 RSS 已失效
//! （返回 HTML）、Anthropic 官网无 RSS、Marketing Dive 404、麦迪逊邦
//! 不可达、AdExchanger 对非浏览器请求返回反爬页、AdAge 直接拒绝，
//! 均不收录。世界类中文源（BBC 等）同样不可达，暂缺。

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

/// 增量抓取轮次间隔（分钟）：从 fetch_hour 起，每 2 小时拉一轮当天新条目。
const FETCH_INTERVAL_MINS: u64 = 120;

/// 每个源每轮最多取的**当天**条数（控制当日缓存规模；先过滤当天再截断）。
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
    // ---- AI 一手源：大模型官网技术博客与业界播客 ----
    RssSource {
        id: "openai-news",
        name: "OpenAI",
        url: "https://openai.com/news/rss.xml",
        category: "tech",
    },
    RssSource {
        id: "deepmind-blog",
        name: "DeepMind",
        url: "https://deepmind.google/blog/rss.xml",
        category: "tech",
    },
    RssSource {
        id: "google-ai-blog",
        name: "Google AI",
        url: "https://blog.google/technology/ai/rss/",
        category: "tech",
    },
    RssSource {
        id: "hf-blog",
        name: "Hugging Face",
        url: "https://huggingface.co/blog/feed.xml",
        category: "tech",
    },
    RssSource {
        id: "latent-space",
        name: "Latent Space",
        url: "https://www.latent.space/feed",
        category: "tech",
    },
    // ---- 互联网广告行业一手源 ----
    // （AdExchanger 对非浏览器请求返回 HTML 反爬页、AdAge 直接拒绝，
    // 均不稳定，不收录）
    RssSource {
        id: "adweek",
        name: "Adweek",
        url: "https://www.adweek.com/feed/",
        category: "tech",
    },
    RssSource {
        id: "digiday",
        name: "Digiday",
        url: "https://www.digiday.com/feed/",
        category: "tech",
    },
    RssSource {
        id: "modern-retail",
        name: "Modern Retail",
        url: "https://www.modernretail.co/feed/",
        category: "tech",
    },
    // ---- 中文聚合补充（非一手，兼顾中文阅读）----
    RssSource {
        id: "qbitai",
        name: "量子位",
        url: "https://www.qbitai.com/feed",
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
/// tech 已聚焦为「AI·广告」，id 不变 —— 老用户配置无缝兼容。
const CATEGORIES: &[(&str, &str)] = &[
    ("tech", "AI·广告"),
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
    /// 每天从几点开始抓取（0-23，本地时间），之后每 2 小时一轮增量。
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
    /// 下一张卡的游标（当日顺序消费；增量轮追加条目、不重置游标）。
    next_idx: usize,
    /// LLM 当日点评（可空；当天只在首批内容时生成一次）。
    digest: String,
    /// 今天是否已拉取过（拉取中为 false，防止出半截卡）。
    fetched: bool,
    /// 上次出卡时刻（epoch 分钟），频率闸。
    last_card_mins: u64,
    /// 上次拉取时刻（epoch 分钟）。0 = 今天还没拉过（旧缓存缺字段自动补 0，
    /// 到点即触发首轮，无害）。
    #[serde(default)]
    last_fetch_mins: u64,
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

/// RSS 条目 pubDate（RFC2822）转本地日期 `YYYY-MM-DD`；缺失或非法返回 None。
fn pubdate_local(it: &rss::Item) -> Option<String> {
    let raw = it.pub_date()?;
    let dt = chrono::DateTime::parse_from_rfc2822(raw).ok()?;
    Some(dt.with_timezone(&chrono::Local).format("%Y-%m-%d").to_string())
}

/// 从一段 RSS 2.0 文本提取**本地当天**的条目（解析交给 rss crate，这里只做裁剪）。
///
/// 严格「仅当天」：pubDate 缺失、非法、非当天一律丢弃 —— 宁可少一条，
/// 不拿昨天的凑数。先过滤当天再截断，避免源把旧条目排在前面挤掉新内容。
fn collect_from(text: &str, source_name: &str, today: &str) -> Vec<NewsItem> {
    let Ok(ch) = rss::Channel::read_from(text.as_bytes()) else {
        return Vec::new();
    };
    ch.items()
        .iter()
        .filter(|it| pubdate_local(it).as_deref() == Some(today))
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

/// 增量合并：新条目按 url 去重后**追加**（已出过的卡不重复出，游标由调用方维护）。
fn merge_into(existing: &mut Vec<NewsItem>, incoming: Vec<NewsItem>) {
    let mut seen: std::collections::HashSet<String> =
        existing.iter().map(|i| i.url.clone()).collect();
    for it in incoming {
        if seen.insert(it.url.clone()) {
            existing.push(it);
        }
    }
}

fn sources_for(categories: &[String]) -> Vec<&'static RssSource> {
    SOURCES
        .iter()
        .filter(|s| categories.iter().any(|c| c == s.category))
        .collect()
}

/// 是否该拉一轮（纯函数，单测入口）：过了抓取时点，且距上轮 ≥ 2 小时。
/// `last_fetch_mins == 0`（新一天首轮 / 旧缓存）时必然为真。
fn due_fetch(s: &NewsState, mins_of_day: u32, now: u64, fetch_hour: u32) -> bool {
    mins_of_day / 60 >= fetch_hour && now.saturating_sub(s.last_fetch_mins) >= FETCH_INTERVAL_MINS
}

/// 异步拉取选中类别的全部源，**增量合并**进缓存。
///
/// digest 只在「当天首批内容」落位时生成一次：增量轮（items 已有内容）
/// 不再调 LLM —— 当天头条不会翻盘，省 token。
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
                    let items = collect_from(&text, src.name, &today);
                    eprintln!("[plugin:{ID}] {}：当天 {} 条", src.name, items.len());
                    batches.push(items);
                }
                Err(e) => {
                    // 源失败静默：下轮增量（2 小时后）自然重试，不打扰用户
                    eprintln!("[plugin:{ID}] 源 {} 拉取失败（静默重试）：{e}", src.name);
                }
            }
        }

        let incoming: Vec<NewsItem> = batches.into_iter().flatten().collect();
        let (digest_needed, all_items) = with_state(|s| {
            let was_empty = s.items.is_empty();
            merge_into(&mut s.items, incoming);
            s.date = today.clone();
            s.next_idx = s.next_idx.min(s.items.len()); // 防御：游标不越界
            s.fetched = true;
            (was_empty && !s.items.is_empty(), s.items.clone())
        });
        save_state(&app);

        if digest_needed {
            spawn_digest(cfg, all_items, today, app);
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

        // 该拉取了（拉取走异步旁路，tick 只负责触发）：从 fetch_hour 起
        // 每 2 小时一轮增量，只收当天新条目 —— 一手博客下午发的也能看到
        let need_fetch = with_state(|s| {
            rollover(s, &today);
            due_fetch(s, now_ctx.minutes, now, cfg.fetch_hour)
        });
        if need_fetch {
            // 立刻记账，防止 30 秒后的下个 tick 重复触发
            with_state(|s| s.last_fetch_mins = now);
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

    /// 本地今天的 `YYYY-MM-DD`（与 collect_from 的 today 参数同格式）。
    fn today_str() -> String {
        chrono::Local::now().format("%Y-%m-%d").to_string()
    }

    /// 本地现在时刻的 RFC2822 字符串（RSS pubDate 用的格式）。
    fn now_rfc2822() -> String {
        chrono::Local::now().to_rfc2822()
    }

    /// 昨天此刻的 RFC2822 字符串（构造「过期条目」用）。
    fn yesterday_rfc2822() -> String {
        (chrono::Local::now() - chrono::Duration::hours(24)).to_rfc2822()
    }

    fn rss_item(title: &str, link: &str, pubdate: Option<&str>) -> String {
        match pubdate {
            Some(p) => format!(
                "<item><title>{title}</title><link>{link}</link><pubDate>{p}</pubDate></item>"
            ),
            None => format!("<item><title>{title}</title><link>{link}</link></item>"),
        }
    }

    #[test]
    fn 解析样例rss仅保留当天条目() {
        let today = today_str();
        let xml = format!(
            r#"<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel><title>Test</title>
{}{}{}{}
</channel></rss>"#,
            rss_item("今天的 &amp; 细节", "https://example.com/1", Some(&now_rfc2822())),
            rss_item("昨天", "https://example.com/2", Some(&yesterday_rfc2822())),
            rss_item("缺日期", "https://example.com/3", None),
            rss_item("非法日期", "https://example.com/4", Some("not a date")),
        );
        let items = collect_from(&xml, "测试源", &today);
        assert_eq!(items.len(), 1, "仅保留本地当天的条目");
        assert_eq!(items[0].headline, "今天的 & 细节");
        assert_eq!(items[0].url, "https://example.com/1");
        assert_eq!(items[0].source, "测试源");
    }

    #[test]
    fn 当天过滤先截断不受旧条目挤占() {
        // 源把 10 条旧条目排在前面、新条目在最后：先过滤当天再 take，
        // 新条目必须被收进来（若先 take(8) 就会被旧的挤掉）
        let today = today_str();
        let old = (0..10)
            .map(|i| rss_item(&format!("旧{i}"), &format!("https://example.com/old/{i}"), Some(&yesterday_rfc2822())))
            .collect::<String>();
        let xml = format!(
            r#"<rss version="2.0"><channel><title>T</title>{}{}</channel></rss>"#,
            old,
            rss_item("新条目", "https://example.com/new", Some(&now_rfc2822()))
        );
        let items = collect_from(&xml, "s", &today);
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].headline, "新条目");
    }

    #[test]
    fn 解析失败返回空而非panic() {
        let today = today_str();
        assert!(collect_from("not xml at all", "x", &today).is_empty());
        assert!(collect_from("", "x", &today).is_empty());
    }

    #[test]
    fn 增量合并去重追加且不动已有条目() {
        let mut existing = vec![
            NewsItem { headline: "h1".into(), source: "s".into(), url: "https://x/1".into() },
            NewsItem { headline: "h2".into(), source: "s".into(), url: "https://x/2".into() },
        ];
        let incoming = vec![
            NewsItem { headline: "h2-dup".into(), source: "s2".into(), url: "https://x/2".into() },
            NewsItem { headline: "h3".into(), source: "s2".into(), url: "https://x/3".into() },
        ];
        merge_into(&mut existing, incoming);
        assert_eq!(existing.len(), 3, "按 url 去重");
        assert_eq!(existing[0].headline, "h1", "已有条目原位保留");
        assert_eq!(existing[1].headline, "h2", "先到的保留，重复的丢弃");
        assert_eq!(existing[2].headline, "h3", "新条目追加到尾部");
    }

    #[test]
    fn 增量节奏判定() {
        let mk = |last_fetch: u64| NewsState {
            last_fetch_mins: last_fetch,
            ..Default::default()
        };
        // 未到抓取时点：一票否决
        assert!(!due_fetch(&mk(0), 8 * 60, 10_000, 9), "8 点不拉（fetch_hour=9）");
        // 到点 + 今天没拉过（0）：立即拉
        assert!(due_fetch(&mk(0), 9 * 60, 10_000, 9));
        // 距上轮不足 2 小时：不拉
        assert!(!due_fetch(&mk(10_000), 10 * 60, 10_000 + 119, 9));
        // 满 2 小时：拉
        assert!(due_fetch(&mk(10_000), 11 * 60, 10_000 + 120, 9));
        // last_fetch 比当前还大（时钟回拨防御）：不拉
        assert!(!due_fetch(&mk(20_000), 12 * 60, 10_000, 9));
    }

    #[test]
    fn 类别过滤选出对应源() {
        let srcs = sources_for(&["finance".to_string()]);
        assert!(srcs.iter().all(|s| s.category == "finance"));
        assert_eq!(srcs.len(), 2);

        // tech 已聚焦为 AI+广告：5 个 AI 一手 + 3 个广告 + 1 个中文聚合
        let srcs = sources_for(&["tech".to_string()]);
        assert_eq!(srcs.len(), 9);

        let srcs = sources_for(&["tech".to_string(), "design".to_string()]);
        assert_eq!(srcs.len(), 10);
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
            last_fetch_mins: 4242,
        };
        rollover(&mut s, "2026-09-02");
        assert_eq!(s.date, "2026-09-02");
        assert!(s.items.is_empty());
        assert_eq!(s.next_idx, 0);
        assert!(!s.fetched);
        assert!(s.digest.is_empty());
        assert_eq!(s.last_fetch_mins, 0, "跨天后当轮立即重新拉取");

        // 同日不动
        rollover(&mut s, "2026-09-02");
        assert_eq!(s.date, "2026-09-02");
    }

    #[test]
    fn 旧缓存缺last_fetch字段可反序列化() {
        // 旧版 news-cache 没有 last_fetch_mins：serde default 补 0，
        // 到点即触发当天首轮拉取，无需迁移
        let s: NewsState = serde_json::from_str(
            r#"{"date":"2026-09-04","items":[],"next_idx":0,"digest":"","fetched":true,"last_card_mins":42}"#,
        )
        .unwrap();
        assert_eq!(s.last_fetch_mins, 0);
        assert!(s.fetched);
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
