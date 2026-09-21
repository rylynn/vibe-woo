# 每日资讯质量优化设计（news.rs 原地升级）

日期：2026-09-21。前置文档：`2026-09-02-plugin-system-design.md`（插件系统与资讯插件 6.2）。

## 1. 背景与问题

资讯插件的现状（0.7.0 起）：tech 类刻意聚焦「AI 一手 + 互联网广告行业」，
design 类只有优设（中文教程站），出卡时**没有任何挑选** —— 当天条目按拉取
顺序依次出卡，聚合源的量产文与重磅发布同等待遇。

用户反馈：新闻资讯质量相对较差，要求按「互联网、科技类、手机类前沿公司
需要关心的行业动态 + 最新 AI 进展」的标准重新定位 tech 类，design 类同步换
成行业动态源。

## 2. 已确认的关键决策

| 决策项 | 结论 | 备注 |
|---|---|---|
| 广告行业源 | **删除**（Adweek / Digiday / Modern Retail） | tech 类重新聚焦行业动态 + AI |
| 语言配比 | 英文为主，中文聚合限流补充 | 量子位保留，每日配额压住量产文 |
| 手机动态 | 综合科技媒体自然覆盖 | 不加手机垂直源（9to5Mac 等偏发布传闻） |
| 挑选机制 | **规则打分基线 + LLM 策展可选** | 未配置 LLM = 纯规则，功能完整 |
| 架构 | **方案 A 原地升级**：打分进缓存、消费按分数、策展写回缓存 | 否决旁路策展层（状态分两处）与 HN 信号（留作将来） |
| design 定位 | 设计行业动态（NN/g、Sidebar、It's Nice That、Co.Design） | 优设（教程类）移除，全英文 |
| digest | 现有每日 35 字点评**不动** | 与策展两条独立小调用，不耦合 |
| 出卡节奏 | 不变：2h 一张、ttl 20s、Low 优先级、仅当天、静默失败 | 不打扰原则优先 |

## 3. 源清单重构

类别 id 全部不变（老配置无缝兼容）；tech 标签从「AI·广告」改为「科技·AI」。

### 3.1 tech 类（~10 源）

| 分组 | 源 | 权重 | 每日配额 |
|---|---|---|---|
| AI 一手（保留） | OpenAI / DeepMind / Google AI / Hugging Face | 30 | 8 |
| AI 一手（保留） | Latent Space | 30 | 8 |
| AI 补充（新增候选） | Simon Willison 博客（simonwillison.net/atom/everything/） | 30 | 8 |
| 行业动态（新增候选） | TechCrunch（techcrunch.com/feed/） | 20 | 4 |
| 行业动态（新增候选） | The Verge（www.theverge.com/rss/index.xml） | 20 | 4 |
| 行业动态（新增候选） | Ars Technica（feeds.arstechnica.com/arstechnica/index） | 20 | 4 |
| 行业动态（备选池） | CNBC Tech / Engadget | 20 | 4 |
| 中文（保留） | 量子位 | 10 | 2 |

删除：Adweek / Digiday / Modern Retail。

### 3.2 design 类（4-5 源，全英文）

| 源 | 权重 | 每日配额 |
|---|---|---|
| Nielsen Norman Group（nngroup.com/feed/articles/） | 30 | 8 |
| Sidebar（sidebar.io/feed，本身是策展源，信噪比高） | 30 | 8 |
| It's Nice That（itsnicethat.com/rss） | 20 | 4 |
| Fast Company / Co.Design | 20 | 4 |
| 备选池：Smashing Magazine、UX Collective | 20 | 4 |

移除：优设。finance 类（NYT / WSJ）本次不动。

### 3.3 源可用性实测（实现阶段第一步）

所有候选逐一 `curl` 实测：RSS 2.0 / Atom 可被 rss crate 解析、pubDate 可读、
无反爬（返回 HTML 反爬页的一律不收录），不可达的从备选池补位。实测结论写进
实现 commit message（与 0.7.0「2026-09-04 网络实测」惯例一致）。已知历史：
机器之心 RSS 失效、Anthropic 无 RSS、AdExchanger 反爬、AdAge 拒绝。

## 4. 打分与排序（纯函数，零 LLM 依赖）

入池时给每条 `NewsItem` 算一次 `score`，之后不再变（策展提档除外）：

```
score = 源权重 + 关键词加分（每命中 +5，封顶 +15）
```

- **源权重**三档静态标注在源清单：AI 一手/策展源 30、行业综合 20、中文聚合 10。
- **关键词表**中英双语、大小写不敏感，初始清单定稿如下（后续增删走「改表 +
  改测试」成对提交）：事件动词 `release / launch / announce / open source /
  acquire / acquisition / funding / raises / IPO / ban / lawsuit / regulat* /
  breakthrough / benchmark`，主体名 `GPT / Claude / Gemini / Llama / Qwen /
  DeepSeek`，中文 `发布 / 开源 / 收购 / 融资 / 上线 / 突破 / 监管 / 上市`。

排序：每轮拉取合并入池后，对**未消费尾巴** `items[next_idx..]` 按 score 稳定
降序排（同分保持入池先后）。已消费部分不动、游标不回退 ——「已出过的卡不
重复出」不变。增量轮下午入池的重磅发布自然排到上午普通条目之前。

## 5. LLM 策展（可选增强）

配置了 LLM（`llm.enabled` 且有 key）才跑，与 digest 同款异步旁路线程。

**触发时机**：
- 当天首批内容落位（`was_empty && !items.is_empty()`）→ 策展一次；
- 此后每轮增量抓取若池子有新条目且距上次策展 ≥2h → 重策展
  （自然上限约 4-5 次/天，每次输入仅标题列表，token 开销极小）。

**输入**：未消费条目的 `源名 + 标题 + URL + score` 列表。

**输出**（json_mode，低温）：`{"picks":[{"url":"…","reason":"≤30字"}]}`，
≤6 条；system prompt 要求按「互联网/科技/手机前沿公司从业者视角，挑对行业
格局、产品决策、AI 进展真正重要的条目」。

**落地规则（红线）**：
- **只接受池子里已有的 URL**（成员校验，LLM 编造的一律丢弃）；reason 挂到
  对应条目上 —— LLM 绝不生成新链接，只挑选已有链接。
- 被选中条目 score 提到「策展档」（+50，压过一切规则分）。
- 重策展先清空全部未消费条目的策展标记与 reason，再应用新 picks（上次的
  pick 若未被消费，落回规则分；已消费的条目不受影响）。
- 写回前检查 `s.date == today`（跨天防御，与 digest 同款）。
- 失败（网络/解析/全部 pick 无效）一律静默 —— 规则分排序兜底，绝不弹错。
- 跳过（未配置 LLM）不更新 `last_curate_mins`，用户中途配好 LLM 后下一轮
  增量即生效。

## 6. 数据结构与契约变更

全部新增字段带 `serde(default)`，旧 `news-cache` / 旧配置免迁移。

**Rust（news.rs）**：

```rust
struct RssSource {
    id: &'static str, name: &'static str, url: &'static str,
    category: &'static str,
    weight: u8,   // 30 / 20 / 10
    quota: u8,    // 每日配额：8 / 4 / 2
}

pub struct NewsItem {
    headline: String, source: String, url: String,
    score: u32,               // default 0
    reason: Option<String>,   // default None（策展理由）
}

struct NewsState {
    …现有字段不变…,
    last_curate_mins: u64,    // default 0
}
```

- 统一的 `PER_SOURCE_ITEMS = 8`（每轮）改为**每源每日配额**：合并入池时按
  「该源当天已入池条数」截断，跨轮累计；按 URL 去重掉的不占配额。

**前端（src/plugins/cards/news.ts）**：
- payload 增加 `reason?: string | null`，有则在 digest 行的位置显示一行小字
  （有 digest 显示 digest，有 reason 显示 reason，两者都有时 digest 在前）。
- `CATEGORIES` 标签同步改「科技·AI」—— 与 Rust 手工对齐的既有惯例。

**meta / 面板**：`summary` 结构不变（latest 仍为标题/源/URL）。

## 7. 错误处理

| 场景 | 行为 |
|---|---|
| 单源拉取失败 | 静默，下轮按退避重试（不变） |
| 策展调用失败 / JSON 解析失败 | 静默，规则分排序兜底 |
| pick 里含编造 URL | 逐条校验：无效的丢弃、有效的照常应用 |
| 旧缓存缺新字段 | serde default 补默认值，免迁移 |
| 时钟回拨 / 跨天 | 沿用现有 saturating_sub 与 date 校验防御 |

## 8. 测试

**Rust 纯函数单测（tests 内嵌 news.rs）**：
- 打分：源权重叠加、关键词中英文/大小写命中、命中封顶 +15；
- 排序：稳定降序、已消费条目不动、游标不回退、增量高分插到未消费队首；
- 配额：按天跨轮累计截断（量子位 2 条、综合 4 条）、去重不占配额；
- 策展落地：编造 URL 丢弃、+50 提档、重策展清旧标记、跨天写回拦截；
- 兼容：旧 `news-cache` JSON（缺 score / reason / last_curate_mins）反序列化；
- 源清单完整性：每源带合法 weight / quota，类别合法，https。

**前端（tests/plugin-sections.test.ts 顺带补）**：reason 行渲染断言。

**合入前**：`npx tsc --noEmit`、`cargo check`（src-tauri）、`npx vitest run`、
`cargo test` 全绿。

## 9. 明确不做（YAGNI）

- Hacker News Algolia 信号融合 —— 留作将来扩展（引入非 RSS 解析路径，且 HN
  口味偏工程师社区）；
- 标题相似度交叉验证（多源报道同一事件加分）—— LLM 策展天然覆盖；
- 用户自定义 RSS 源 / 源管理 UI；
- digest 与策展合并成一次调用；
- 出卡节奏、仲裁优先级、面板结构的任何调整。

## 10. 手工验证清单（实现后）

1. 清掉 `news-cache` 后启动：当天正常出卡，卡序符合「策展 > 高分 > 入池序」；
2. 未配置 LLM：只按规则分排序，无报错、无 digest；
3. 配置 LLM：首批出卡带 reason 行，增量轮下午新重磅发布能插到队首；
4. 老缓存（升级前 `news-cache`）启动：无迁移报错，字段补默认值；
5. 量子位当天多条：仅 2 条入池；
6. 源挂掉（断网）：静默，面板「更新中」，恢复后按退避补拉。
