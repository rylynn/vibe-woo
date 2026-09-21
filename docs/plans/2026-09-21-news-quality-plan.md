# 每日资讯质量优化实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 资讯插件按「互联网/科技/手机前沿公司关心的行业动态 + AI 进展」重构源清单，出卡挑选从「按拉取顺序」升级为「源权重 + 关键词打分（纯函数）+ LLM 策展可选」。

**Architecture:** 全部改动在 `news.rs` 原地升级（方案 A）：打分进缓存、消费按分数、策展写回缓存。新增每源每日配额压聚合源量产文；Atom 源（The Verge / Simon Willison）经 `atom_syndication` 解析。设计文档：`docs/plans/2026-09-21-news-quality-design.md`。

**Tech Stack:** Rust（rss 2 / atom_syndication 0.12 / chrono 0.4 / tokio / reqwest / serde）、TypeScript（无框架 DOM）、vitest + cargo test。

## Global Constraints

- 代码注释、commit message、文档全中文；每个 commit message 末尾带 `版本: 1.6.0`（用户已确认）。
- 源可用性以 2026-09-21 网络实测为准（已烘焙进本计划 Task 2，不需再实测）：
  存活 = OpenAI / DeepMind / Google AI / Hugging Face / Latent Space / 量子位 / TechCrunch / The Verge(Atom) / Ars Technica / Simon Willison(Atom) / Fast Company / Webdesigner News / Smashing Magazine / UX Collective；
  阵亡 = Engadget(403) / NN-g(404) / Sidebar(返回空) / It's Nice That(404) / Creative Review(403) / Design Week(403) / Core77(404) / Dexigner(404)；
  CNBC Tech 可用但未收录（综合源已够三家）。
- 红线：LLM 绝不生成链接 —— 策展只允许挑选池子里已有的 URL，编造的一律丢弃；策展/digest 失败一律静默。
- 不打扰：出卡节奏不变（2h 一张、ttl 20s、Priority::Low、仅当天、静默失败）。
- 纯逻辑写成纯函数并补单测（项目红线 5）；异步旁路线程里只做 IO 与 LLM 调用。
- 所有 `cargo` 命令前先 `export PATH="$HOME/.cargo/bin:$PATH"`；前端命令用 `pnpm`/`npx`（pnpm 10）。
- 合入前全绿：`npx tsc --noEmit`、`src-tauri` 下 `cargo check`、`npx vitest run`、`src-tauri` 下 `cargo test`。
- 版本号三处（`src-tauri/tauri.conf.json` / `src-tauri/Cargo.toml` / `package.json`）在 Task 9 收尾 commit 同步升 1.6.0。
- `docs/` 在 .gitignore 里但历史文件均被追踪，提交本计划文档需 `git add -f`。

---

### Task 1: 打分纯函数（关键词表 + 词界匹配 + score_item）

**Files:**
- Modify: `src-tauri/src/plugin/news.rs`（在「解析与拉取」小节前新增小节；测试加在文件底部 `mod tests`）

**Interfaces:**
- Produces: `fn score_item(weight: u8, headline: &str) -> u32`、`fn hit_en(lower: &str, kw: &str) -> bool`、常量 `KEYWORDS_EN / KEYWORDS_ZH / KW_BONUS / KW_BONUS_CAP`。Task 3 的 `collect_from` 调用 `score_item`。

- [ ] **Step 1: 写失败测试**（加到 `mod tests` 内）

```rust
    #[test]
    fn 关键词英文按词界匹配() {
        assert!(hit_en("openai releases gpt-5 api", "release"));
        assert!(hit_en("eu ban on x", "ban"));
        assert!(!hit_en("bank of america faces lawsuit", "ban"), "bank 不是 ban");
        assert!(!hit_en("urban design week", "ban"), "urban 不含词界 ban");
        assert!(hit_en("new regulations for ai", "regulat*"), "前缀命中 regulations");
        assert!(hit_en("gpt-5 launched", "gpt"));
        assert!(hit_en("an open source release", "open source"), "多词关键词");
    }

    #[test]
    fn 关键词中文子串匹配() {
        // 中文没有词界，走 contains（score_item 内部对 KEYWORDS_ZH 用子串匹配）
        let lower = "阿里开源千亿模型并发布".to_string();
        assert!(KEYWORDS_ZH.iter().filter(|kw| lower.contains(*kw)).count() >= 2);
    }

    #[test]
    fn 打分等于源权重加封顶关键词分() {
        // release + gpt 各 +5
        assert_eq!(score_item(30, "OpenAI releases GPT-5"), 40);
        // 发布 + 开源 各 +5
        assert_eq!(score_item(10, "某公司发布新模型并开源"), 20);
        // 命中再多也封顶 +15
        assert_eq!(
            score_item(20, "release launch announce breakthrough funding 融资 发布 开源 监管"),
            35
        );
        // bank 不命中 ban，只剩 raises +5
        assert_eq!(score_item(20, "Bank raises Series B"), 25);
        // 无命中 = 纯源权重
        assert_eq!(score_item(20, "平平无奇的一条"), 20);
    }
```

- [ ] **Step 2: 跑测试确认失败**

Run: `export PATH="$HOME/.cargo/bin:$PATH" && cd src-tauri && cargo test score_item`
Expected: 编译失败，`cannot find function hit_en / score_item`

- [ ] **Step 3: 实现**（加在 `sources_for` 之后）

```rust
// ---------- 打分（纯函数，零 LLM 依赖） ----------

/// 英文关键词（全小写、按词界匹配；`*` 结尾表示前缀匹配，如 regulat* 命中
/// regulation / regulations / regulators）。词界匹配避免 ban 命中 bank / urban
/// 这类误报 —— 关键词分只做排序微调，但没理由放过已知的误报源。
const KEYWORDS_EN: &[&str] = &[
    "release", "launch", "announce", "open source", "acquire", "acquisition",
    "funding", "raises", "ipo", "ban", "lawsuit", "regulat*", "breakthrough",
    "benchmark", "gpt", "claude", "gemini", "llama", "qwen", "deepseek",
];
/// 中文关键词（子串匹配 —— 中文没有词界）。
const KEYWORDS_ZH: &[&str] = &["发布", "开源", "收购", "融资", "上线", "突破", "监管", "上市"];
/// 每命中一个关键词的加分与封顶。
const KW_BONUS: u32 = 5;
const KW_BONUS_CAP: u32 = 15;

/// 英文词界匹配：keyword 必须前后都是非字母数字（多词关键词中间的空格是
/// 模式的一部分）；`*` 结尾 = 前缀匹配（只要求前面有词界）。hay 须已小写。
fn hit_en(lower: &str, kw: &str) -> bool {
    let (kw, prefix) = match kw.strip_suffix('*') {
        Some(base) => (base, true),
        None => (kw, false),
    };
    let hay: Vec<char> = lower.chars().collect();
    let pat: Vec<char> = kw.chars().collect();
    if pat.is_empty() || hay.len() < pat.len() {
        return false;
    }
    let is_word = |c: char| c.is_alphanumeric();
    (0..=hay.len() - pat.len()).any(|i| {
        hay[i..].starts_with(&pat[..])
            && (i == 0 || !is_word(hay[i - 1]))
            && (prefix || i + pat.len() == hay.len() || !is_word(hay[i + pat.len()]))
    })
}

/// 打分：源权重 + 关键词命中加分（每词 +5，封顶 +15）。
/// 分数入池时算一次就不再变（LLM 策展提档除外，见 apply_curation）。
fn score_item(weight: u8, headline: &str) -> u32 {
    let lower = headline.to_lowercase();
    let hits = KEYWORDS_EN.iter().filter(|kw| hit_en(&lower, kw)).count()
        + KEYWORDS_ZH.iter().filter(|kw| lower.contains(*kw)).count();
    u32::from(weight) + (hits as u32 * KW_BONUS).min(KW_BONUS_CAP)
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd src-tauri && cargo test score_item && cargo test 关键词`
Expected: 3 个测试 PASS

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/plugin/news.rs
git commit -m "feat(news): 打分纯函数——源权重+中英关键词词界匹配

英文关键词按词界匹配（ban 不再命中 bank/urban），regulat* 前缀命中
regulation 系列；中文子串匹配。每命中 +5 封顶 +15，叠加源权重三档
30/20/10。纯函数零 LLM 依赖，为入池打分与排序做准备。

版本: 1.6.0

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 2: 源清单重构（weight/quota 字段 + 2026-09-21 实测清单）

**Files:**
- Modify: `src-tauri/src/plugin/news.rs:1-23`（模块头注释）、`RssSource` 与 `SOURCES`、`CATEGORIES`
- Test: 同文件 `mod tests`

**Interfaces:**
- Produces: `RssSource { id, name, url, category, weight: u8, quota: u8 }`（Task 3 用 `weight`，Task 5 用 `quota`）；tech 源共 10、design 共 4、finance 共 2。

- [ ] **Step 1: 更新失败的清单测试**（改写现有 `类别过滤选出对应源` 与 `内置源全部带合法类别与url`）

```rust
    #[test]
    fn 类别过滤选出对应源() {
        let srcs = sources_for(&["finance".to_string()]);
        assert!(srcs.iter().all(|s| s.category == "finance"));
        assert_eq!(srcs.len(), 2);

        // tech 聚焦为 AI 一手 + 行业动态：6 个 AI 一手/实践者 + 3 个综合 + 1 个中文聚合
        let srcs = sources_for(&["tech".to_string()]);
        assert_eq!(srcs.len(), 10);

        let srcs = sources_for(&["tech".to_string(), "design".to_string()]);
        assert_eq!(srcs.len(), 14);
    }

    #[test]
    fn 内置源全部带合法类别url权重与配额() {
        for s in SOURCES {
            assert!(!s.name.is_empty());
            assert!(s.url.starts_with("https://"), "{} 的 url 必须是 https", s.id);
            assert!(
                CATEGORIES.iter().any(|(c, _)| *c == s.category),
                "{} 类别非法",
                s.id
            );
            assert!([30u8, 20, 10].contains(&s.weight), "{} 权重必须三档", s.id);
            assert!([8u8, 4, 2].contains(&s.quota), "{} 配额必须三档", s.id);
        }
    }
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd src-tauri && cargo test 类别过滤 && cargo test 内置源`
Expected: 编译失败（`RssSource` 没有 `weight`/`quota` 字段）；或断言失败（tech 9 ≠ 10）

- [ ] **Step 3: 替换结构体、清单、标签与模块头注释**

`RssSource` 与 `SOURCES` 整体替换为：

```rust
struct RssSource {
    id: &'static str,
    name: &'static str,
    url: &'static str,
    category: &'static str,
    /// 打分用的源权重三档：一手/策展 30、行业综合 20、中文聚合 10。
    weight: u8,
    /// 每日配额：该源每天最多入池条数（合并时按天截断，见 merge_batch）。
    quota: u8,
}

const SOURCES: &[RssSource] = &[
    // ---- AI 一手：大模型官网技术博客、业界播客与实践者 ----
    RssSource {
        id: "openai-news",
        name: "OpenAI",
        url: "https://openai.com/news/rss.xml",
        category: "tech",
        weight: 30,
        quota: 8,
    },
    RssSource {
        id: "deepmind-blog",
        name: "DeepMind",
        url: "https://deepmind.google/blog/rss.xml",
        category: "tech",
        weight: 30,
        quota: 8,
    },
    RssSource {
        id: "google-ai-blog",
        name: "Google AI",
        url: "https://blog.google/technology/ai/rss/",
        category: "tech",
        weight: 30,
        quota: 8,
    },
    RssSource {
        id: "hf-blog",
        name: "Hugging Face",
        url: "https://huggingface.co/blog/feed.xml",
        category: "tech",
        weight: 30,
        quota: 8,
    },
    RssSource {
        id: "latent-space",
        name: "Latent Space",
        url: "https://www.latent.space/feed",
        category: "tech",
        weight: 30,
        quota: 8,
    },
    // AI 实践者一手视角（Atom 源，经 atom_syndication 解析）
    RssSource {
        id: "simon-willison",
        name: "Simon Willison",
        url: "https://simonwillison.net/atom/everything/",
        category: "tech",
        weight: 30,
        quota: 8,
    },
    // ---- 互联网/科技/手机行业动态：综合媒体自然覆盖手机与消费科技 ----
    RssSource {
        id: "techcrunch",
        name: "TechCrunch",
        url: "https://www.techcrunch.com/feed/",
        category: "tech",
        weight: 20,
        quota: 4,
    },
    // The Verge 已转 Atom
    RssSource {
        id: "the-verge",
        name: "The Verge",
        url: "https://www.theverge.com/rss/index.xml",
        category: "tech",
        weight: 20,
        quota: 4,
    },
    RssSource {
        id: "ars-technica",
        name: "Ars Technica",
        url: "https://feeds.arstechnica.com/arstechnica/index",
        category: "tech",
        weight: 20,
        quota: 4,
    },
    // ---- 中文聚合补充（配额压住量产文）----
    RssSource {
        id: "qbitai",
        name: "量子位",
        url: "https://www.qbitai.com/feed",
        category: "tech",
        weight: 10,
        quota: 2,
    },
    RssSource {
        id: "nyt-biz",
        name: "NYT 商业",
        url: "https://rss.nytimes.com/services/xml/rss/nyt/Business.xml",
        category: "finance",
        weight: 20,
        quota: 4,
    },
    RssSource {
        id: "wsj",
        name: "WSJ 市场",
        url: "https://feeds.a.dj.com/rss/RSSMarketsMain.xml",
        category: "finance",
        weight: 20,
        quota: 4,
    },
    // ---- 设计行业动态（全英文；NN/g、Sidebar、It's Nice That 的 RSS 已死，见头注释）----
    RssSource {
        id: "webdesigner-news",
        name: "Webdesigner News",
        url: "https://www.webdesignernews.com/feed",
        category: "design",
        weight: 30,
        quota: 8,
    },
    RssSource {
        id: "fast-company",
        name: "Fast Company",
        url: "https://www.fastcompany.com/rss",
        category: "design",
        weight: 20,
        quota: 4,
    },
    RssSource {
        id: "smashing",
        name: "Smashing Magazine",
        url: "https://www.smashingmagazine.com/feed/",
        category: "design",
        weight: 20,
        quota: 4,
    },
    RssSource {
        id: "ux-collective",
        name: "UX Collective",
        url: "https://uxdesign.cc/feed",
        category: "design",
        weight: 20,
        quota: 4,
    },
];
```

`CATEGORIES` 改为：

```rust
/// 类别（id，中文名）。用户最多选 3 个。
/// tech 定位「AI 进展 + 互联网/科技行业动态」，id 不变 —— 老用户配置无缝兼容。
const CATEGORIES: &[(&str, &str)] = &[
    ("tech", "科技·AI"),
    ("finance", "财经"),
    ("design", "设计"),
];
```

模块头注释（文件开头 `//!` 块）第 4 条原则段与可用性段替换为：

```rust
//! - tech 类源定位「AI 一手进展 + 互联网/科技/手机行业动态」：大模型官网
//!   技术博客（OpenAI / DeepMind / Google AI / Hugging Face）、业界播客
//!   （Latent Space）、AI 实践者（Simon Willison）、综合行业媒体（TechCrunch /
//!   The Verge / Ars Technica，手机与消费科技由它们自然覆盖）、中文聚合补充
//!   （量子位，每日配额 2 压住量产文）。「筛选」靠四层实现：源级聚焦 +
//!   每源每日配额 + 仅当天过滤 + 打分排序（LLM 策展可选增强）。
//!
//! 网络全部走异步旁路线程（与 words 的 LLM 增强同一模式）—— host 线程
//! 绝不被网络请求阻塞，其他插件不受影响。
//!
//! 内置源清单可用性以 2026-09-21 网络实测为准；The Verge 与 Simon Willison
//! 为 Atom 源（atom_syndication 解析）。已阵亡不收录：机器之心（返回
//! HTML）、Anthropic（无 RSS）、AdExchanger（反爬）、AdAge（拒绝）、
//! Marketing Dive / 麦迪逊邦（0.7.0 结论）、Engadget（403）、NN/g 与
//! It's Nice That（RSS 404）、Sidebar（返回空体）、Creative Review /
//! Design Week（403）、Core77 / Dexigner（404）。CNBC Tech 可用但未收录
//! （综合源已够三家）。世界类中文源（BBC 等）同样不可达，暂缺。
```

（原头注释里「四条原则」的第 1、2、3 条与 120ms/退避等段落保持不动，只替换上面这些段。）

- [ ] **Step 4: 跑全部 news 测试确认通过**（老清单的计数断言已改，其余不受影响）

Run: `cd src-tauri && cargo test news`
Expected: 全部 PASS

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/plugin/news.rs
git commit -m "feat(news): 源清单重构——行业动态+AI 实践者，附权重与每日配额

tech 删广告三源（Adweek/Digiday/Modern Retail），新增 Simon Willison
（AI 实践者，Atom）与 TechCrunch/The Verge/Ars Technica（行业动态，
手机由综合媒体自然覆盖）；design 换行业动态源（Webdesigner News 策展
源/Fast Company/Smashing/UX Collective），优设移除。每源带权重三档
（30/20/10）与每日配额三档（8/4/2）。tech 标签改「科技·AI」，id 不变。
可用性 2026-09-21 实测：NN/g、Sidebar、It's Nice That、Engadget 等阵亡。

版本: 1.6.0

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 3: NewsItem 加 score/reason + collect_from 通用化 + Atom 解析

**Files:**
- Modify: `src-tauri/Cargo.toml`（加依赖）
- Modify: `src-tauri/src/plugin/news.rs`（`NewsItem`、`collect_from`、新 `parse_entries`；`PER_SOURCE_ITEMS` 注释）
- Test: 同文件 `mod tests`

**Interfaces:**
- Consumes: Task 1 的 `score_item`、Task 2 的 `RssSource.weight`。
- Produces: `NewsItem { headline, source, url, score: u32, reason: Option<String> }`（后两个 serde default）；`fn collect_from(text: &str, source_name: &str, weight: u8, today: &str, take_max: usize) -> Vec<NewsItem>`（Task 5 调用）。

- [ ] **Step 1: 写失败测试**（新增两个；并给现有两个 collect_from 测试改签名）

新增：

```rust
    #[test]
    fn 解析atom源仅保留当天条目并带源权重() {
        let today = today_str();
        let now_iso = chrono::Local::now().format("%+").to_string();
        let yesterday_iso = (chrono::Local::now() - chrono::Duration::hours(24))
            .format("%+")
            .to_string();
        let xml = format!(
            r#"<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom"><title>T</title><updated>{now_iso}</updated>
<entry><title>今天的</title><link href="https://example.com/1"/><published>{now_iso}</published><updated>{now_iso}</updated></entry>
<entry><title>昨天的</title><link href="https://example.com/2"/><published>{yesterday_iso}</published><updated>{yesterday_iso}</updated></entry>
<entry><title>没日期的</title><link href="https://example.com/3"/></entry>
</feed>"#
        );
        let items = collect_from(&xml, "测试Atom", 30, &today, 8);
        assert_eq!(items.len(), 1, "仅保留本地当天且必须有日期");
        assert_eq!(items[0].url, "https://example.com/1");
        assert_eq!(items[0].score, 30, "入池即带源权重");
    }

    #[test]
    fn 旧缓存缺score与reason字段可反序列化() {
        let s: NewsState = serde_json::from_str(
            r#"{"date":"2026-09-04","items":[{"headline":"h","source":"s","url":"u"}],"next_idx":0,"digest":"","fetched":true,"last_card_mins":42}"#,
        )
        .unwrap();
        assert_eq!(s.items[0].score, 0, "serde default 补 0");
        assert!(s.items[0].reason.is_none());
    }
```

现有 `解析样例rss仅保留当天条目` 与 `当天过滤先截断不受旧条目挤占` 里所有 `collect_from(&xml, "测试源", &today)` 与 `collect_from(&xml, "s", &today)` 改为 `collect_from(&xml, "测试源", 20, &today, 8)` / `collect_from(&xml, "s", 20, &today, 8)`，并在第一个测试末尾补一行断言：

```rust
        assert_eq!(items[0].score, 20, "入池即带源权重（无关键词命中）");
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd src-tauri && cargo test 解析atom`
Expected: 编译失败（`NewsItem` 无 `score`/`reason`、`collect_from` 参数数量不符）

- [ ] **Step 3: 实现**

`src-tauri/Cargo.toml` 依赖段（`rss = "2"` 下一行）加：

```toml
atom_syndication = "0.12"
```

`NewsItem` 替换为：

```rust
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct NewsItem {
    pub headline: String,
    pub source: String,
    pub url: String,
    /// 规则分：源权重 + 关键词加分（LLM 策展选中再 +CURATE_BONUS）。旧缓存缺字段补 0。
    #[serde(default)]
    pub score: u32,
    /// LLM 策展推荐理由（未策展 / 旧缓存为 None）。
    #[serde(default)]
    pub reason: Option<String>,
}
```

`pubdate_local` 下方新增 `FeedEntry` 与 `parse_entries`，`collect_from` 整体替换：

```rust
/// 统一的扁平条目（RSS 2.0 与 Atom 解析归一后的公共形状）。
struct FeedEntry {
    title: String,
    url: String,
    /// 本地日期 `YYYY-MM-DD`；缺失 / 非法为 None（一律按非当天丢弃）。
    date_local: Option<String>,
}

/// 解析 RSS 2.0 或 Atom（按根元素嗅探），统一成扁平条目。
/// 解析交给 rss / atom_syndication crate，这里只做形状归一，不做过滤。
fn parse_entries(text: &str) -> Vec<FeedEntry> {
    let head: String = text.trim_start().chars().take(200).collect();
    if head.contains("<feed") {
        let Ok(fd) = atom_syndication::Feed::read_from(text.as_bytes()) else {
            return Vec::new();
        };
        fd.entries()
            .iter()
            .map(|e| FeedEntry {
                title: e
                    .title()
                    .map(|t| t.as_str().trim().to_string())
                    .unwrap_or_default(),
                url: e
                    .links()
                    .iter()
                    .find(|l| !l.href().is_empty())
                    .map(|l| l.href().trim().to_string())
                    .unwrap_or_default(),
                // published 优先（发表时刻），缺失退 updated
                date_local: e.published().or(e.updated()).map(|d| {
                    d.with_timezone(&chrono::Local)
                        .format("%Y-%m-%d")
                        .to_string()
                }),
            })
            .collect()
    } else {
        let Ok(ch) = rss::Channel::read_from(text.as_bytes()) else {
            return Vec::new();
        };
        ch.items()
            .iter()
            .map(|it| FeedEntry {
                title: it.title().map(str::trim).to_string(),
                url: it.link().map(str::trim).to_string(),
                date_local: pubdate_local(it),
            })
            .collect()
    }
}

/// 从一段 RSS 2.0 / Atom 文本提取**本地当天**的条目，入池即带打分。
///
/// 严格「仅当天」：日期缺失、非法、非当天一律丢弃 —— 宁可少一条，
/// 不拿昨天的凑数。先过滤当天再截断（take_max 只是单轮抓取上限，每日
/// 配额在合并时按源另算），避免源把旧条目排在前面挤掉新内容。
fn collect_from(
    text: &str,
    source_name: &str,
    weight: u8,
    today: &str,
    take_max: usize,
) -> Vec<NewsItem> {
    parse_entries(text)
        .into_iter()
        .filter(|e| e.date_local.as_deref() == Some(today))
        .take(take_max)
        .filter_map(|e| {
            if e.title.is_empty() || e.url.is_empty() {
                return None;
            }
            let score = score_item(weight, &e.title);
            Some(NewsItem {
                headline: e.title,
                source: source_name.to_string(),
                url: e.url,
                score,
                reason: None,
            })
        })
        .collect()
}
```

`PER_SOURCE_ITEMS` 常量注释改为（数值不变）：

```rust
/// 单轮抓取每源最多取的**当天**条数（只是抓取上限；每日配额由源清单的
/// quota 在合并时按天执行）。先过滤当天再截断。
const PER_SOURCE_ITEMS: usize = 8;
```

同时把 `mod tests` 里其余构造 `NewsItem { headline: …, source: …, url: … }` 字面量的测试（`增量合并去重追加且不动已有条目`、`增量节奏判定`、`陈旧时立即补拉且不看法点`、`看过存量才按1小时刷_否则2小时`、`跨天重置缓存与游标`）每处补上 `score: 0, reason: None` 两个字段（共约 9 处字面量；Task 4/5/7 会再动其中部分）。

- [ ] **Step 4: 跑测试确认通过**

Run: `cd src-tauri && cargo test news`
Expected: 全部 PASS（注意 `spawn_fetch` 里旧的 `collect_from(&text, src.name, &today)` 调用此时编译不过 —— 一并把它改成 `collect_from(&text, src.name, src.weight, &today, PER_SOURCE_ITEMS)`，这是纯签名适配，Task 5 才动其余逻辑）

- [ ] **Step 5: Commit**

```bash
git add src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/src/plugin/news.rs
git commit -m "feat(news): NewsItem 带分与策展理由；解析归一 RSS 2.0 与 Atom

加 atom_syndication 依赖（The Verge/Simon Willison 是 Atom），按根元素
嗅探归一成扁平条目后走同一套「仅当天」过滤；入池即按源权重打分。
score/reason 带 serde default，旧 news-cache 免迁移。

版本: 1.6.0

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 4: 配额合并 merge_batch + 未消费尾巴排序 sort_pending

**Files:**
- Modify: `src-tauri/src/plugin/news.rs`（`merge_into` 旁新增两个纯函数；`merge_into` 暂留，Task 5 接线后删除）
- Test: 同文件 `mod tests`

**Interfaces:**
- Consumes: Task 3 的 `NewsItem.score`。
- Produces: `fn merge_batch(existing: &mut Vec<NewsItem>, incoming: Vec<NewsItem>, quota: u8) -> usize`、`fn sort_pending(items: &mut [NewsItem], next_idx: usize)`（Task 5/7 调用）。

- [ ] **Step 1: 写失败测试**（用下面三个测试替换现有的 `增量合并去重追加且不动已有条目` —— 去重语义已并入第一个；顺带删掉旧测试）

```rust
    #[test]
    fn 配额合并按源截断且去重不占额() {
        let mk = |h: &str, u: &str| NewsItem {
            headline: h.into(),
            source: "量子位".into(),
            url: u.into(),
            score: 10,
            reason: None,
        };
        let mut pool = vec![mk("已有1", "https://x/1")];
        // 第二轮：重复的 x/1 不占额，4 条新里只能再进 1 条（当日配额 2）
        let incoming = vec![
            mk("重复", "https://x/1"),
            mk("新2", "https://x/2"),
            mk("新3", "https://x/3"),
            mk("新4", "https://x/4"),
        ];
        assert_eq!(merge_batch(&mut pool, incoming, 2), 1);
        assert_eq!(pool.len(), 2);
        assert_eq!(pool[1].headline, "新2", "先到的保留，重复的丢弃");
        // 第三轮：配额已满，一律不再进
        assert_eq!(merge_batch(&mut pool, vec![mk("新5", "https://x/5")], 2), 0);
        assert_eq!(pool.len(), 2);
    }

    #[test]
    fn 不同源互不占配额() {
        let a = NewsItem { headline: "a".into(), source: "A".into(), url: "https://a/1".into(), score: 20, reason: None };
        let b = NewsItem { headline: "b".into(), source: "B".into(), url: "https://b/1".into(), score: 30, reason: None };
        let mut pool = vec![a];
        assert_eq!(merge_batch(&mut pool, vec![b], 1), 1, "B 源不受 A 源配额影响");
        assert_eq!(pool.len(), 2);
    }

    #[test]
    fn 未消费尾巴按分数稳定降序且不动头部() {
        let mk = |h: &str, s: u32| NewsItem {
            headline: h.into(),
            source: "s".into(),
            url: format!("https://x/{h}"),
            score: s,
            reason: None,
        };
        let mut items = vec![
            mk("已出1", 5),
            mk("已出2", 3),
            mk("低", 10),
            mk("高", 40),
            mk("同分先", 20),
            mk("同分后", 20),
        ];
        sort_pending(&mut items, 2);
        assert_eq!(items[0].headline, "已出1", "已消费头部不动");
        assert_eq!(items[1].headline, "已出2");
        assert_eq!(items[2].headline, "高");
        assert_eq!(items[3].headline, "同分先", "同分稳定：入池先后保持");
        assert_eq!(items[4].headline, "同分后");
        assert_eq!(items[5].headline, "低");
    }
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd src-tauri && cargo test 配额合并 && cargo test 未消费尾巴`
Expected: 编译失败，`cannot find function merge_batch / sort_pending`

- [ ] **Step 3: 实现**（加在 `merge_into` 之后，`merge_into` 本体暂不动）

```rust
/// 增量合并（带每源每日配额）：按 url 去重后**追加**，同源当天总量不超过
/// quota（按「已入池的同源条数」算，跨轮累计；去重丢弃的不占配额）。
/// 返回实际入池条数（策展触发判定「有没有新条目」用）。
/// quota 只对 incoming 的源生效 —— 不同源互不影响。
fn merge_batch(existing: &mut Vec<NewsItem>, incoming: Vec<NewsItem>, quota: u8) -> usize {
    let src = incoming.first().map(|i| i.source.clone()).unwrap_or_default();
    let mut room = (quota as usize).saturating_sub(
        existing.iter().filter(|i| i.source == src).count(),
    );
    let mut seen: std::collections::HashSet<String> =
        existing.iter().map(|i| i.url.clone()).collect();
    let mut added = 0usize;
    for it in incoming {
        if room == 0 {
            break;
        }
        if seen.insert(it.url.clone()) {
            existing.push(it);
            room -= 1;
            added += 1;
        }
    }
    added
}

/// 未消费尾巴按分数稳定降序（同分保持入池先后）；已消费的头部不动、游标
/// 不回退 —— 「已出过的卡不重复出」不变。增量轮下午入池的重磅发布自然
/// 排到上午普通条目前面。
fn sort_pending(items: &mut [NewsItem], next_idx: usize) {
    items[next_idx.min(items.len())..].sort_by(|a, b| b.score.cmp(&a.score));
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd src-tauri && cargo test news`
Expected: 全部 PASS（`merge_into` 暂时还在被 `spawn_fetch` 使用，无 dead_code 警告）

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/plugin/news.rs
git commit -m "feat(news): 每源每日配额合并与未消费尾巴按分排序

merge_batch 按「同源当天已入池数」截断（跨轮累计、去重不占额），
量子位 2 条/天、综合源 4 条/天压住量产文；sort_pending 只重排
next_idx 之后的尾巴，已出的卡不动、游标不回退。纯函数可单测。

版本: 1.6.0

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 5: spawn_fetch 接线（配额合并 + 排序 + payload 带 reason），删除 merge_into

**Files:**
- Modify: `src-tauri/src/plugin/news.rs`（`spawn_fetch`、`tick` 出卡 payload；删除 `merge_into`）

**Interfaces:**
- Consumes: Task 3 的 `collect_from` 新签名、Task 4 的 `merge_batch` / `sort_pending`。
- Produces: 卡片 payload 新增 `reason` 字段（null 或字符串）—— Task 8 前端消费。

- [ ] **Step 1: 改 `spawn_fetch`**

拉取循环里 `batches` 的类型从 `Vec<Vec<NewsItem>>` 改为带配额的元组，`collect_from` 已在 Task 3 改过签名；合并段整体替换。改动后的完整相关代码：

```rust
        let mut batches: Vec<(Vec<NewsItem>, u8)> = Vec::new();
        let mut any_ok = false;
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
                    let items =
                        collect_from(&text, src.name, src.weight, &today, PER_SOURCE_ITEMS);
                    eprintln!("[plugin:{ID}] {}：当天 {} 条", src.name, items.len());
                    any_ok = true; // 源通了就算成功，哪怕当天 0 条新内容
                    batches.push((items, src.quota));
                }
                Err(e) => {
                    // 源失败静默：下轮按退避自然重试，不打扰用户
                    eprintln!("[plugin:{ID}] 源 {} 拉取失败（静默重试）：{e}", src.name);
                }
            }
        }

        let (digest_needed, all_items) = with_state(|s| {
            let was_empty = s.items.is_empty();
            for (items, quota) in batches {
                merge_batch(&mut s.items, items, quota);
            }
            s.date = today.clone();
            s.next_idx = s.next_idx.min(s.items.len()); // 防御：游标不越界
            s.fetched = true;
            apply_fetch_result(s, &today, any_ok, epoch_mins());
            // 未消费尾巴按分数重排：下午入池的重磅发布排到上午普通条目前面
            sort_pending(&mut s.items, s.next_idx);
            (was_empty && !s.items.is_empty(), s.items.clone())
        });
        save_state(&app);

        if digest_needed {
            spawn_digest(cfg, all_items, today, app);
        }
```

（线程开头 `std::thread::spawn` 到 `let mut batches` 之前与原来完全一致，不动。）

- [ ] **Step 2: `tick` 出卡 payload 加 reason**

`vec![PluginCard { … payload: serde_json::json!({ … }) }]` 里加一行（放在 `"digest"` 之后）：

```rust
                "reason": item.reason,
```

- [ ] **Step 3: 删除 `merge_into` 函数**

Task 4 已用 `配额合并按源截断且去重不占额` 覆盖其去重语义，直接删除函数本体。

- [ ] **Step 4: 全量跑测试确认通过**

Run: `cd src-tauri && cargo test`
Expected: 全部 PASS（本任务是接线，无新纯函数；`spawn_digest` 调用参数不变）

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/plugin/news.rs
git commit -m "feat(news): 拉取接线配额合并与按分排序；卡片 payload 带策展理由

spawn_fetch 每源带 quota 合并入池、合并后重排未消费尾巴；merge_into
删除（去重语义并入 merge_batch）。出卡 payload 新增 reason 字段
（null 或 ≤30 字理由，前端 1.6.0 起消费）。

版本: 1.6.0

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 6: 策展纯函数（parse_picks + apply_curation）

**Files:**
- Modify: `src-tauri/src/plugin/news.rs`（打分小节后新增「LLM 策展」小节）
- Test: 同文件 `mod tests`

**Interfaces:**
- Consumes: Task 3 的 `NewsItem`、Task 4 的排序语义。
- Produces: `struct CuratorPick { url: String, reason: String }`、`fn parse_picks(text: &str) -> Vec<CuratorPick>`、`fn apply_curation(items: &mut [NewsItem], next_idx: usize, picks: &[CuratorPick]) -> usize`、常量 `CURATE_BONUS: u32 = 50` / `MAX_PICKS: usize = 6`（Task 7 调用）。

- [ ] **Step 1: 写失败测试**

```rust
    #[test]
    fn 策展解析容错围栏与非法json() {
        let picks = parse_picks(r#"{"picks":[{"url":"https://x/1","reason":"重要"}]}"#);
        assert_eq!(picks.len(), 1);
        assert_eq!(picks[0].url, "https://x/1");
        // 模型偶尔带 markdown 围栏：取首个 { 到最后一个 } 之间再试一次
        let picks = parse_picks("```json\n{\"picks\":[{\"url\":\"https://x/1\",\"reason\":\"r\"}]}\n```");
        assert_eq!(picks.len(), 1);
        assert!(parse_picks("完全不是 json").is_empty());
        assert!(parse_picks("{\"picks\":[]}").is_empty());
    }

    #[test]
    fn 策展落地只认池内url并提档挂理由() {
        let mk = |u: &str, s: u32| NewsItem {
            headline: format!("h{u}"),
            source: "s".into(),
            url: u.into(),
            score: s,
            reason: None,
        };
        let mut items = vec![mk("https://x/1", 10), mk("https://x/2", 20), mk("https://x/3", 30)];
        let picks = vec![
            CuratorPick { url: "https://x/2".into(), reason: "  行业格局变化  ".into() },
            CuratorPick { url: "https://编造/9".into(), reason: "编造的".into() },
        ];
        assert_eq!(apply_curation(&mut items, 0, &picks), 1, "编造 URL 静默丢弃");
        assert_eq!(items[0].url, "https://x/2", "提档后排最前");
        assert_eq!(items[0].score, 70, "20 + 50");
        assert_eq!(items[0].reason.as_deref(), Some("行业格局变化"), "理由去空白并截 30 字");
        assert!(items.iter().all(|i| i.url != "https://编造/9"), "编造条目绝不入池");
    }

    #[test]
    fn 重策展清旧标记且已消费不动() {
        let mk = |u: &str, s: u32| NewsItem {
            headline: format!("h{u}"),
            source: "s".into(),
            url: u.into(),
            score: s,
            reason: None,
        };
        let mut items = vec![mk("https://x/1", 10), mk("https://x/2", 20), mk("https://x/3", 30)];
        // 首轮策展：x/1 已消费（next_idx=1），只有 x/2 生效
        let picks = vec![
            CuratorPick { url: "https://x/1".into(), reason: "旧理由".into() },
            CuratorPick { url: "https://x/2".into(), reason: "旧理由2".into() },
        ];
        apply_curation(&mut items, 1, &picks);
        assert!(items[0].reason.is_none(), "已消费条目不策展");
        assert_eq!(items[0].score, 10);
        assert_eq!(items[1].score, 70);
        // 重策展不再选 x/2 → 落回规则分、理由清空
        apply_curation(&mut items, 1, &[]);
        assert_eq!(items[1].score, 20, "旧策展分回落");
        assert!(items[1].reason.is_none());
    }

    #[test]
    fn 策展最多六条() {
        let mut items: Vec<NewsItem> = (0..8)
            .map(|i| NewsItem {
                headline: format!("h{i}"),
                source: "s".into(),
                url: format!("https://x/{i}"),
                score: 10,
                reason: None,
            })
            .collect();
        let picks: Vec<CuratorPick> = (0..8)
            .map(|i| CuratorPick { url: format!("https://x/{i}"), reason: "r".into() })
            .collect();
        assert_eq!(apply_curation(&mut items, 0, &picks), 6, "最多 6 条");
        assert_eq!(items.iter().filter(|i| i.reason.is_some()).count(), 6);
    }
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd src-tauri && cargo test 策展`
Expected: 编译失败，`cannot find function parse_picks / apply_curation / CuratorPick`

- [ ] **Step 3: 实现**（加在打分小节之后）

```rust
// ---------- LLM 策展（可选增强：配置了 LLM 才跑；纯函数部分在此） ----------

/// 策展提档加分：压过一切规则分（规则分上限 30 + 15 = 45）。
const CURATE_BONUS: u32 = 50;
/// 单次策展最多选中的条数。
const MAX_PICKS: usize = 6;

/// 策展输出的一条（LLM 只允许挑选输入列表里已有的 url）。
#[derive(Debug, Clone, Deserialize)]
struct CuratorPick {
    url: String,
    reason: String,
}

#[derive(Debug, Deserialize)]
struct PickList {
    picks: Vec<CuratorPick>,
}

/// 解析策展输出 JSON：{"picks":[{"url":"…","reason":"…"}]}。
/// 容错：直接解析失败时取首个 `{` 到最后一个 `}` 之间再试一次
/// （模型偶尔带 markdown 围栏）；仍失败返回空 —— 等于本次没策展。
fn parse_picks(text: &str) -> Vec<CuratorPick> {
    if let Ok(l) = serde_json::from_str::<PickList>(text.trim()) {
        return l.picks;
    }
    let (Some(a), Some(b)) = (text.find('{'), text.rfind('}')) else {
        return Vec::new();
    };
    serde_json::from_str::<PickList>(&text[a..=b])
        .unwrap_or_default()
        .picks
}

/// 策展落池（纯函数）：先清空未消费条目的旧策展标记（分数落回、理由清空），
/// 再按 URL 成员校验应用新 picks（≤MAX_PICKS；编造 URL 静默丢弃，绝不入池），
/// 选中条目 +CURATE_BONUS 并挂 ≤30 字理由，最后重排未消费尾巴。
/// 已消费条目（next_idx 之前）一律不动。返回实际应用条数。
fn apply_curation(items: &mut [NewsItem], next_idx: usize, picks: &[CuratorPick]) -> usize {
    let idx = next_idx.min(items.len());
    // 清旧标记：规则分上限 45 < CURATE_BONUS，分数 ≥ 50 必是策展档
    for it in &mut items[idx..] {
        if it.score >= CURATE_BONUS {
            it.score -= CURATE_BONUS;
        }
        it.reason = None;
    }
    let mut applied = 0usize;
    for p in picks.iter().take(MAX_PICKS) {
        let reason: String = p.reason.trim().chars().take(30).collect();
        if reason.is_empty() {
            continue;
        }
        if let Some(it) = items[idx..].iter_mut().find(|i| i.url == p.url) {
            it.score += CURATE_BONUS;
            it.reason = Some(reason);
            applied += 1;
        }
    }
    items[idx..].sort_by(|a, b| b.score.cmp(&a.score));
    applied
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd src-tauri && cargo test 策展`
Expected: 4 个测试 PASS

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/plugin/news.rs
git commit -m "feat(news): 策展纯函数——解析容错与只认池内 URL 的落池

parse_picks 容错 markdown 围栏；apply_curation 先清旧策展标记再按
URL 成员校验应用（≤6 条、编造 URL 静默丢弃、+50 提档、理由 ≤30 字），
已消费条目不动，落池后重排未消费尾巴。LLM 绝不生成新链接。

版本: 1.6.0

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 7: spawn_curate 异步线程 + 触发接线 + last_curate_mins

**Files:**
- Modify: `src-tauri/src/plugin/news.rs`（`NewsState` 加字段、`spawn_fetch` 加触发、新增 `spawn_curate`；测试补字段）

**Interfaces:**
- Consumes: Task 6 的 `parse_picks` / `apply_curation` / `CuratorPick`；`crate::llm::complete_with` / `crate::llm::CompleteOptions { temperature, max_output_tokens, max_output_chars }`。
- Produces: `NewsState.last_curate_mins: u64`（serde default）；`fn spawn_curate(cfg: NewsConfig, items: Vec<NewsItem>, next_idx: usize, today: String, app: tauri::AppHandle)`。

- [ ] **Step 1: `NewsState` 加字段与测试**

`NewsState` 里 `last_success_mins` 字段后加：

```rust
    /// 上次策展时刻（epoch 分钟）；0 = 今天还没策展过。未配置 LLM 时跳过
    /// 策展**不**记时刻 —— 用户中途配好后下一轮增量即生效。
    #[serde(default)]
    last_curate_mins: u64,
```

现有测试 `跨天重置缓存与游标` 的 `NewsState` 字面量补 `last_curate_mins: 4242,`（与 `last_fetch_mins` 同值即可），并在 rollover 断言里加一行：

```rust
        assert_eq!(s.last_curate_mins, 0, "跨天重置策展时刻");
```

- [ ] **Step 2: 跑受影响测试确认失败**

Run: `cd src-tauri && cargo test 跨天重置`
Expected: 编译失败（字面量缺字段）

- [ ] **Step 3: 实现触发与异步线程**

`spawn_digest` 函数后新增：

```rust
/// 策展轮次的最小间隔（分钟）：增量轮有新条目也要隔 2 小时才重策展
/// （自然上限约 4-5 次/天，每次输入只有标题列表）。
const CURATE_GAP_MINS: u64 = 120;

/// 异步 LLM 策展：从当天未消费池子里按「前沿公司从业者视角」挑 top-N
/// 并写回缓存。失败一律静默 —— 规则分排序兜底，绝不打扰用户。
/// LLM 只挑选输入列表里已有的 URL（apply_curation 做成员校验），
/// 绝不采信编造的链接。
fn spawn_curate(cfg: NewsConfig, items: Vec<NewsItem>, next_idx: usize, today: String, app: tauri::AppHandle) {
    std::thread::spawn(move || {
        let llm = crate::configcmd::current().llm;
        if !llm.enabled || llm.api_key.is_empty() {
            return; // 未配置 LLM：不策展也不记时刻
        }
        let rt = match tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
        {
            Ok(rt) => rt,
            Err(_) => return,
        };
        let from = next_idx.min(items.len());
        // 最新在前、最多 40 条：最旧的存量大概率已过时
        let lines: Vec<String> = items[from..]
            .iter()
            .rev()
            .take(40)
            .map(|i| format!("{}｜{}｜{}｜{}", i.source, i.headline, i.url, i.score))
            .collect();
        if lines.is_empty() {
            return;
        }
        let user = format!(
            "关注类别：{}\n今日池子：\n{}",
            cfg.categories
                .iter()
                .map(|c| category_label(c))
                .collect::<Vec<_>>()
                .join("、"),
            lines.join("\n")
        );
        let system = concat!(
            "你是互联网、科技、手机行业前沿公司的资深行业编辑。从今天的资讯池里",
            "挑出对行业格局、产品决策、AI 进展真正重要的条目，最多 6 条，宁缺毋滥。",
            "只输出 JSON：{\"picks\":[{\"url\":\"原样复制输入中的链接\",",
            "\"reason\":\"30 字内的中文推荐理由\"}]}。",
            "url 只能来自输入列表，绝不编造。"
        );
        let opts = crate::llm::CompleteOptions {
            temperature: 0.2,
            max_output_tokens: Some(1024),
            max_output_chars: 600,
        };
        let Ok(out) = crate::llm::complete_with(&llm, system, &user, true, opts) else {
            return; // 静默：规则分排序兜底
        };
        let picks = parse_picks(&out);
        let hit = with_state(|s| {
            if s.date != today || !s.fetched {
                return false; // 跨天了，别把昨天的策展写到今天
            }
            apply_curation(&mut s.items, s.next_idx, &picks);
            s.last_curate_mins = epoch_mins();
            true
        });
        if hit {
            save_state(&app);
        }
    });
}
```

`spawn_fetch` 的合并段（Task 5 改过的）再改一次 —— 闭包返回值多两个，尾部多一次调用：

```rust
        let (digest_needed, curate_needed, curate_from, all_items) = with_state(|s| {
            let was_empty = s.items.is_empty();
            let mut added = 0usize;
            for (items, quota) in batches {
                added += merge_batch(&mut s.items, items, quota);
            }
            s.date = today.clone();
            s.next_idx = s.next_idx.min(s.items.len()); // 防御：游标不越界
            s.fetched = true;
            apply_fetch_result(s, &today, any_ok, epoch_mins());
            sort_pending(&mut s.items, s.next_idx);
            // 策展触发：当天首批内容策展一次；之后增量有新条目且距上次 ≥2h 重策展
            let first = was_empty && !s.items.is_empty();
            let incremental =
                added > 0 && epoch_mins().saturating_sub(s.last_curate_mins) >= CURATE_GAP_MINS;
            (first, incremental, s.next_idx.min(s.items.len()), s.items.clone())
        });
        save_state(&app);

        if digest_needed {
            spawn_digest(cfg.clone(), all_items.clone(), today.clone(), app.clone());
        }
        if digest_needed || curate_needed {
            spawn_curate(cfg, all_items, curate_from, today, app);
        }
```

- [ ] **Step 4: 全量跑测试确认通过**

Run: `cd src-tauri && cargo test`
Expected: 全部 PASS（异步线程无单测，逻辑全在 Task 6 纯函数里）

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/plugin/news.rs
git commit -m "feat(news): LLM 策展异步旁路——首批策展一次，增量隔 2 小时重策展

低温 JSON 模式调 complete_with（输出 600 字上限），输入只含未消费
池子的源名+标题+URL+分数（最新在前 ≤40 条）；未配置 LLM 跳过且不记
时刻。跨天写回拦截与 digest 同款。失败静默，规则分排序兜底。

版本: 1.6.0

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 8: 前端 reason 行 + 类别标签

**Files:**
- Modify: `src/plugins/cards/news.ts`（payload 类型、renderCard、CATEGORIES 注释）
- Test: `tests/plugin-sections.test.ts`

**Interfaces:**
- Consumes: Task 5 的 payload `reason` 字段（null 或 ≤30 字字符串）。

- [ ] **Step 1: 写失败测试**（`tests/plugin-sections.test.ts` 的「资讯面板分区」describe 里加）

```ts
  it("卡片带策展理由时显示理由行", () => {
    const el = newsFrontend.renderCard(
      {
        plugin_id: "news",
        kind: "news",
        priority: "low",
        ttl_secs: 20,
        payload: {
          headline: "h",
          source: "s",
          url: "https://x",
          digest: null,
          reason: "值得关注的格局变化",
          ai: false,
        },
      } as Parameters<typeof newsFrontend.renderCard>[0],
      host,
    );
    expect(el.textContent).toContain("值得关注的格局变化");
  });

  it("digest 与理由都在时 digest 在前", () => {
    const el = newsFrontend.renderCard(
      {
        plugin_id: "news",
        kind: "news",
        priority: "low",
        ttl_secs: 20,
        payload: {
          headline: "h",
          source: "s",
          url: "https://x",
          digest: "今日总评",
          reason: "单条理由",
          ai: true,
        },
      } as Parameters<typeof newsFrontend.renderCard>[0],
      host,
    );
    const lines = [...el.querySelectorAll(".pet-news-digest")].map(
      (n) => n.textContent,
    );
    expect(lines).toEqual(["今日总评", "单条理由"]);
  });
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/plugin-sections.test.ts`
Expected: FAIL（理由行未渲染，`el.textContent` 不含理由文本）

- [ ] **Step 3: 实现 `src/plugins/cards/news.ts`**

payload 接口加字段（`digest` 之后）：

```ts
interface NewsPayload {
  headline: string;
  source: string;
  url: string;
  digest: string | null;
  /** LLM 策展推荐理由（1.6.0 起有；旧后端无此字段）。 */
  reason?: string | null;
  ai: boolean;
}
```

`renderCard` 里 digest 块之后加：

```ts
    if (p.reason) {
      // 策展理由复用 digest 的小字样式；两者都有时 digest 在前（上面已 append）
      const reason = document.createElement("div");
      reason.className = "pet-news-digest";
      reason.textContent = p.reason;
      el.appendChild(reason);
    }
```

`CATEGORIES` 常量与上方注释改为：

```ts
/** 类别（与 Rust CATEGORIES 清单一致）。tech 定位「AI 进展 + 行业动态」，id 不变保兼容。 */
const CATEGORIES: [string, string][] = [
  ["tech", "科技·AI"],
  ["finance", "财经"],
  ["design", "设计"],
];
```

- [ ] **Step 4: 跑测试与类型检查确认通过**

Run: `npx vitest run tests/plugin-sections.test.ts && npx tsc --noEmit`
Expected: 全部 PASS / 无类型错误

- [ ] **Step 5: Commit**

```bash
git add src/plugins/cards/news.ts tests/plugin-sections.test.ts
git commit -m "feat(news): 卡片显示策展理由行；类别标签同步「科技·AI」

reason 复用 digest 小字样式，两者都有时 digest 在前；CATEGORIES
与 Rust 手工对齐（改一处同步另一处的既有惯例）。

版本: 1.6.0

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 9: 全量检查、版本三处同步、手工验证清单

**Files:**
- Modify: `src-tauri/tauri.conf.json`、`src-tauri/Cargo.toml`、`package.json`（三处 version → 1.6.0）

- [ ] **Step 1: 全量检查**

```bash
export PATH="$HOME/.cargo/bin:$PATH"
npx tsc --noEmit
cd src-tauri && cargo check && cargo test
cd .. && npx vitest run
```

Expected: 四项全绿。

- [ ] **Step 2: 版本三处同步**

`src-tauri/tauri.conf.json` 的 `"version": "1.5.0"` → `"1.6.0"`；
`src-tauri/Cargo.toml` 的 `version = "1.5.0"` → `"1.6.0"`；
`package.json` 的 `"version": "1.5.0"` → `"1.6.0"`。
（`Cargo.lock` 里本包版本随 `cargo check` 自动更新，一并提交。）

- [ ] **Step 3: 收尾 Commit**

```bash
git add src-tauri/tauri.conf.json src-tauri/Cargo.toml src-tauri/Cargo.lock package.json
git commit -m "chore(release): 资讯质量优化收尾，版本 1.6.0

源清单重构（行业动态+AI 实践者）、每源每日配额、打分排序、LLM 策展
可选增强。合入前 tsc/cargo check/vitest/cargo test 全绿。

版本: 1.6.0

Co-Authored-By: Claude <noreply@anthropic.com>"
```

- [ ] **Step 4: 输出手工验证清单给用户**（无法自动化，按设计文档 §10 原样告知）

1. 清掉 `news-cache` 后 `pnpm tauri dev`：当天正常出卡，卡序符合「策展 > 高分 > 入池序」；
2. 未配置 LLM：只按规则分排序，无报错、无 digest；
3. 配置 LLM：首批出卡带理由行，增量轮下午新重磅发布能插到队首；
4. 用升级前的 `news-cache` 启动：无迁移报错（字段补默认值）；
5. 量子位当天多条：仅 2 条入池（面板「今日 N 条」可见）;
6. 断网：静默，面板「更新中」，恢复后按退避补拉。

---

## Self-Review 记录

- 规格覆盖：设计文档 §3 源清单 → Task 2；§4 打分排序 → Task 1/3/4；§5 策展 → Task 6/7；§6 契约 → Task 3/5/8；§7 错误处理 → Task 6/7（静默+成员校验+跨天拦截）；§8 测试 → 各任务 Step 1；§9 不做 → 无对应任务（正确）；§10 手工验证 → Task 9 Step 4。无缺口。
- 占位符扫描：无 TBD / TODO / 「适当处理」类表述；所有代码步骤带完整代码。
- 类型一致性：`score_item(weight: u8, &str) -> u32`（T1 定义 / T3 调用）；`collect_from(&str, &str, u8, &str, usize)`（T3 定义 / T5 调用）；`merge_batch(&mut Vec<NewsItem>, Vec<NewsItem>, u8) -> usize`、`sort_pending(&mut [NewsItem], usize)`（T4 定义 / T5/T7 调用）；`apply_curation(&mut [NewsItem], usize, &[CuratorPick]) -> usize`、`parse_picks(&str) -> Vec<CuratorPick>`（T6 定义 / T7 调用）；payload `reason`（T5 产出 / T8 消费）。一致。
