# 新闻启动补拉 + 1 小时刷新 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 当天该更没更（内容还是昨天的）时启动后立即补拉并带失败退避；当日存量看完后按 1 小时增量刷新（卡片间隔仍 120 分钟不变）。

**Architecture:** 把「内容是不是今天的」从依赖 `rollover` 的隐式保证改成显式字段 `fetch_date`；`due_fetch` 据此分两条路径 —— 陈旧走补拉（不看 `fetch_hour`，带 0/5/15/30 分钟退避），新鲜走原节奏（看过存量的按 60 分钟、否则 120 分钟）。成功／失败的记账边界收口在 `spawn_fetch`。

**Tech Stack:** Rust (Tauri 2 插件模块) + TypeScript（无框架，DOM 手写）；无新依赖。

## Global Constraints

- 代码注释、commit message、文档**均使用中文**。
- 用户指定：**一次合入 0.9.0**。
- 合入前全绿：`npx tsc --noEmit`、`cd src-tauri && cargo check`、`npx vitest run`。
- **纯逻辑优先可测**：拉取判定写成纯函数并补单测，驱动层（tick/spawn_fetch）保持薄。
- **不打扰是第一原则**：**卡片间隔 `NEWS_GAP_MINS` 保持 120 分钟不变** —— 1 小时是刷新缓存，不是刷新打扰。
- **隐私红线不可放宽**。
- Rust 单测函数用中文名；前端单测文件需 `// @vitest-environment happy-dom` 首行注释。
- `docs/` 被 `.gitignore` 忽略 —— 提交文档用 `git add -f`。
- 前端 `news.ts` 的 TS interface 与 Rust 契约手工对齐，改一处同步另一处。
- 若 `2026-09-06-stocks-freshness.md` 已合入，本计划**只做版本号提升**（那边的计划刻意没碰版本）；若那边还没合入，本计划承担 0.9.0 的版本同步。

---

### Task 1: 陈旧状态字段 + 退避与间隔（纯函数）

**Files:**
- Modify: `src-tauri/src/plugin/news.rs`（`NewsState` 第 202 行起；`FETCH_INTERVAL_MINS` 常量第 43 行；`due_fetch` 第 306 行）

**Interfaces:**
- Produces: `fn retry_backoff_mins(failures: u8) -> u64`、`fn fetch_interval_mins(s: &NewsState) -> u64`、改签名后的 `fn due_fetch(s, mins_of_day, now, fetch_hour, today) -> bool`、字段 `NewsState::fetch_date` / `fetch_failures` / `last_success_mins`
- Task 2 消费 `due_fetch` 新签名；Task 3 消费三个新字段。

- [ ] **Step 1: 写失败测试**

在 `news.rs` 的 `mod tests` 里追加（`mk` 闭包在既有的 `增量节奏判定` 测试里定义过，这里重新定义一份）：

```rust
    #[test]
    fn 陈旧时立即补拉且不看法点() {
        let mk = |fetch_date: &str, last_fetch: u64| NewsState {
            fetch_date: fetch_date.into(),
            last_fetch_mins: last_fetch,
            ..Default::default()
        };
        // 今天还没成功拉到 → 立即补拉（8 点也拉，不受 fetch_hour=9 闸门限制）
        assert!(due_fetch(&mk("", 0), 8 * 60, 10_000, 9, "2026-09-07"));
        assert!(due_fetch(&mk("2026-09-04", 0), 8 * 60, 10_000, 9, "2026-09-07"), "内容是上上周五的");
        assert!(due_fetch(&mk("2026-09-04", 0), 23 * 60, 10_000, 9, "2026-09-07"));
        // 当天已成功拉到 → 回到原节奏（看过存量按 60 分钟）
        let mut fresh = mk("2026-09-07", 10_000);
        fresh.items = vec![NewsItem {
            headline: "h".into(),
            source: "s".into(),
            url: "u".into(),
        }];
        fresh.next_idx = 1; // 存量看完
        assert!(!due_fetch(&fresh, 10 * 60, 10_000 + 59, 9, "2026-09-07"));
        assert!(due_fetch(&fresh, 10 * 60, 10_000 + 60, 9, "2026-09-07"), "存量看完 → 60 分钟");
    }

    #[test]
    fn 旧缓存没有fetchDate按陈旧补拉() {
        // 存量 disk 上只有旧字段，没有 fetch_date。今天不是缓存里的那天 →
        // 陈旧路径：不看 fetch_hour、不看 last_fetch_mins，立即拉
        let s: NewsState = serde_json::from_str(
            r#"{"date":"2026-09-04","items":[],"next_idx":0,"digest":"","fetched":true,"last_card_mins":42}"#,
        )
        .unwrap();
        assert_eq!(s.fetch_date, "", "旧缓存缺字段 → serde default 补空串");
        assert!(due_fetch(&s, 8 * 60, 10_000, 9, "2026-09-07"), "→ 8 点也补拉");
    }

    #[test]
    fn 飞行中不重复起拉取线程() {
        let mut s = NewsState::default(); // fetch_date="" → 陈旧路径，退避 0 分钟
        s.last_fetch_mins = 10_000;
        s.fetch_inflight = true;
        // 刚起来 1 分钟：不放行 —— 否则判定每 30s 过一次会叠并发请求
        assert!(!due_fetch(&s, 9 * 60, 10_000 + 1, 9, "2026-09-07"));
        assert!(!due_fetch(&s, 9 * 60, 10_000 + 9, 9, "2026-09-07"));
        // 飞了 10 分钟还没收尾（线程 panic / 网络卡死）→ 放行，不能永久卡死
        assert!(due_fetch(&s, 9 * 60, 10_000 + 10, 9, "2026-09-07"), "兜底放行");
        // 收尾后（fetch_inflight=false）且已失败一次 → 走 5 分钟退避
        s.fetch_inflight = false;
        s.fetch_failures = 1;
        assert!(!due_fetch(&s, 9 * 60, 10_000 + 4, 9, "2026-09-07"));
        assert!(due_fetch(&s, 9 * 60, 10_000 + 5, 9, "2026-09-07"), "5 分钟后重试");
    }

    #[test]
    fn 失败退避逐级放大到30分钟封顶() {
        assert_eq!(retry_backoff_mins(0), 0);
        assert_eq!(retry_backoff_mins(1), 5);
        assert_eq!(retry_backoff_mins(2), 15);
        assert_eq!(retry_backoff_mins(3), 30);
        assert_eq!(retry_backoff_mins(99), 30, "封顶 30 分钟");
    }

    #[test]
    fn 看过存量才按1小时刷_否则2小时() {
        let mut s = NewsState::default();
        s.items = vec![NewsItem {
            headline: "h".into(),
            source: "s".into(),
            url: "u".into(),
        }];
        assert_eq!(fetch_interval_mins(&s), 120, "还有没看的存量 → 120 分钟");
        s.next_idx = 1;
        assert_eq!(fetch_interval_mins(&s), 60, "存量看完 → 60 分钟");
        s.next_idx = 5; // 防御：游标越界也按看完处理
        assert_eq!(fetch_interval_mins(&s), 60);
    }
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd src-tauri && cargo test 失败退避 2>&1 | tail -5`
Expected: 编译错误 `cannot find function retry_backoff_mins`

- [ ] **Step 3: 写最小实现**

1. 常量：把

```rust
const FETCH_INTERVAL_MINS: u64 = 120;
```

改为

```rust
/// 增量拉取间隔：**存量还没看完**时用（还有没出过卡的条目，不急着刷新）。
const FETCH_INTERVAL_MINS: u64 = 120;

/// 增量拉取间隔：**存量已看完**时用 —— 用户明确要的 1 小时一刷。
/// 注意这**只影响拉取**，卡片间隔 `NEWS_GAP_MINS` 保持 120 分钟不变：
/// 信息更新更勤 ≠ 卡片弹更勤。
const FETCH_INTERVAL_IDLE_MINS: u64 = 60;

/// 补拉退避档位（分钟）：连续失败时逐级放大，上限 30。
/// 补拉判定每 30 秒跑一次，没有退避会在源挂掉时每 30 秒猛打 12 个源。
const RETRY_BACKOFF_MINS: [u64; 4] = [0, 5, 15, 30];

/// 单轮拉取最长允许的飞行时间（分钟）：12 个源 × 15s 超时的理论上限约 3 分钟，
/// 给到 10 分钟兜底 —— 异步线程 panic 时不能把补拉永久卡死。
const FETCH_INFLIGHT_MAX_MINS: u64 = 10;
```

2. `NewsState` 加三字段（全部 `#[serde(default)]` 保旧缓存兼容）：

```rust
    /// 上次拉取时刻（epoch 分钟）。0 = 今天还没拉过（旧缓存缺字段自动补 0，
    /// 到点即触发首轮，无害）。
    #[serde(default)]
    last_fetch_mins: u64,
    /// 上次**成功**拉取的本地日期 `YYYY-MM-DD`；空串 = 从未成功。
    /// 「内容是不是今天的」由它显式判定 —— 不再依赖 rollover 的隐式清空。
    #[serde(default)]
    fetch_date: String,
    /// 连续失败轮次（补拉退避用，成功即清零）。
    #[serde(default)]
    fetch_failures: u8,
    /// 上次成功拉取的时刻（epoch 分钟），面板「更新于 HH:MM」用。
    #[serde(default)]
    last_success_mins: u64,
    /// 是否有拉取在飞行中（线程起来时置 true，收尾时置 false）。
    /// 飞行中不再重复起线程 —— 否则异步线程还在跑、判定每 30s 过一次，
    /// 会在源挂掉时叠出十几个并发请求。**不落盘**：新的一天从 false 起。
    #[serde(skip)]
    fetch_inflight: bool,
```

3. 新函数 + `due_fetch` 改签名（`due_fetch` 放在 `retry_backoff_mins` 之后）：

```rust
/// 补拉退避：连续失败第 n 次后要等多久再试（0 → 5 → 15 → 30 封顶）。
fn retry_backoff_mins(failures: u8) -> u64 {
    RETRY_BACKOFF_MINS[usize::from(failures).min(RETRY_BACKOFF_MINS.len() - 1)]
}

/// 增量拉取间隔：存量看完 → 1 小时；还有没看的 → 2 小时。
/// 「如果看过的」= 缓存里的条目都出过卡了（next_idx 走到尾）。
fn fetch_interval_mins(s: &NewsState) -> u64 {
    if s.next_idx >= s.items.len() {
        FETCH_INTERVAL_IDLE_MINS
    } else {
        FETCH_INTERVAL_MINS
    }
}

/// 是否该拉一轮（纯函数，单测入口）：当天还没成功拉到 → 立即补拉（按失败退避）；
/// 否则过了抓取时点且距上轮够久才拉。
fn due_fetch(s: &NewsState, mins_of_day: u32, now: u64, fetch_hour: u32, today: &str) -> bool {
    // 飞行中不重复起线程：退避档位 0 会让判定每 30s 放行一次，而异步线程
    // 最长要跑几分钟，没有这道闸会叠出十几个并发请求猛打源。
    // 兜底：飞过 FETCH_INFLIGHT_MAX_MINS 分钟仍没收尾（线程 panic）→ 放行，
    // 宁可多拉一次也不能把补拉永久卡死。
    if s.fetch_inflight
        && now.saturating_sub(s.last_fetch_mins) < FETCH_INFLIGHT_MAX_MINS
    {
        return false;
    }
    if s.fetch_date != today {
        // 今天还没成功拉到内容 → 最该做的就是立刻拉，不看 fetch_hour。
        // 副作用：fetch_hour=9 的用户 8 点开机也会拉到当天内容 ——
        // 符合「错过更新时间就在启动后触发更新」的诉求。
        return now.saturating_sub(s.last_fetch_mins) >= retry_backoff_mins(s.fetch_failures);
    }
    mins_of_day / 60 >= fetch_hour
        && now.saturating_sub(s.last_fetch_mins) >= fetch_interval_mins(s)
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd src-tauri && cargo test 陈旧时立即补拉 2>&1 | tail -3 && cargo test 旧缓存没有fetchDate 2>&1 | tail -3 && cargo test 飞行中 2>&1 | tail -3 && cargo test 失败退避 2>&1 | tail -3 && cargo test 看过存量 2>&1 | tail -3`
Expected: 五个 `test result: ok. 1 passed`

- [ ] **Step 5: 提交**

```bash
git add src-tauri/src/plugin/news.rs
git commit -m "feat(news): 陈旧状态显式化与补拉/增量间隔（纯函数）"
```

---

### Task 2: tick 接线 + 修复既有测试

**Files:**
- Modify: `src-tauri/src/plugin/news.rs`（`tick` 第 441 行起；`mod tests` 的 `增量节奏判定` / `跨天重置缓存与游标` 测试字面量）

**Interfaces:**
- Consumes: Task 1 的 `due_fetch` 新签名。

- [ ] **Step 1: 更新既有 `增量节奏判定` 测试到新签名**

既有测试用 4 参数调用，编译会挂。整体替换为：

```rust
    #[test]
    fn 增量节奏判定() {
        let mk = |last_fetch: u64, fetch_date: &str| NewsState {
            fetch_date: fetch_date.into(),
            last_fetch_mins: last_fetch,
            ..Default::default()
        };
        let today = "2026-09-07";
        // 当天已成功拉到：未到抓取时点 → 一票否决
        assert!(!due_fetch(&mk(0, today), 8 * 60, 10_000, 9, today), "8 点不拉（fetch_hour=9）");
        // 到点 + 今天没拉过（0）：立即拉
        assert!(due_fetch(&mk(0, today), 9 * 60, 10_000, 9, today));
        // 距上轮不足 2 小时：不拉（还没看过存量，按 120 分钟）
        assert!(!due_fetch(&mk(10_000, today), 10 * 60, 10_000 + 119, 9, today));
        // 满 2 小时：拉
        assert!(due_fetch(&mk(10_000, today), 11 * 60, 10_000 + 120, 9, today));
        // last_fetch 比当前还大（时钟回拨防御）：不拉
        // —— 陈旧路径用 saturating_sub，回拨时差值为 0，退避档位 0 会放行，
        // 所以这里只测新鲜路径的回拨防御
        assert!(!due_fetch(&mk(20_000, today), 12 * 60, 10_000, 9, today));
    }
```

- [ ] **Step 2: 补 `跨天重置缓存与游标` 的新字段断言**

既有测试用完整字段字面量构造 `NewsState`，加了新字段后编译会挂。在字面量里补（顺序与 struct 定义一致，`last_fetch_mins: 4242` 已在原测试里，别重复；`fetch_inflight` 是 `#[serde(skip)]` 但仍要写进字面量）：

```rust
            last_fetch_mins: 4242,
            fetch_date: "2026-09-01".into(),
            fetch_failures: 0,
            last_success_mins: 4242,
            fetch_inflight: false,
        };
```

并在 `rollover` 断言之后追加：

```rust
        assert_eq!(s.fetch_date, "", "跨天后内容视为陈旧，触发补拉");
```

- [ ] **Step 3: tick 接线**

替换 `tick` 里 `due_fetch` 的调用点（第 450–452 行）：

```rust
        let need_fetch = with_state(|s| {
            rollover(s, &today);
            due_fetch(s, now_ctx.minutes, now, cfg.fetch_hour, &today)
        });
        if need_fetch {
            // 立刻记账 + 标记飞行中，防止 30 秒后的下个 tick 重复起线程
            // （退避档位 0 时判定会每 30s 放行一次）
            with_state(|s| {
                s.last_fetch_mins = now;
                s.fetch_inflight = true;
            });
            spawn_fetch(cfg.clone(), today.clone(), ctx.app.clone());
        }
```

（`if need_fetch { ... }` 块里其余两行原样保留，只把 `with_state(|s| s.last_fetch_mins = now);` 换成上面那个带 `fetch_inflight` 的版本。）

- [ ] **Step 4: 跑测试确认通过**

Run: `cd src-tauri && cargo test news 2>&1 | tail -20`
Expected: 全部 `test result: ok`，无编译错误

- [ ] **Step 5: 提交**

```bash
git add src-tauri/src/plugin/news.rs
git commit -m "feat(news): tick 按陈旧状态触发补拉"
```

---

### Task 3: 成功／失败记账边界

**Files:**
- Modify: `src-tauri/src/plugin/news.rs`（`spawn_fetch` 第 314 行起）

**Interfaces:**
- Produces: `spawn_fetch` 写 `fetch_date` / `fetch_failures` / `last_success_mins`（Task 4 的 `meta` 消费）。

- [ ] **Step 1: 写失败测试**

`apply_fetch_result` 是纯函数，`spawn_fetch` 里那段（`Ok` 分支置 `any_ok` + `with_state` 记账）靠本 Task 的代码审查 + Task 6 手工验证兜底。在 `mod tests` 里追加：

```rust
    #[test]
    fn 失败记账不写成功标记_成功清零计数() {
        let mut s = NewsState::default();
        s.fetch_inflight = true;
        // 全源失败：只累加计数，fetch_date 保持空 → 下轮按退避补拉
        apply_fetch_result(&mut s, "2026-09-07", false, 10_000);
        assert!(!s.fetch_inflight, "失败也要收飞行标志，否则永远不再重试");
        assert_eq!(s.fetch_failures, 1);
        assert_eq!(s.fetch_date, "", "失败当天不能算拉到过");
        assert_eq!(s.last_success_mins, 0, "失败不刷新面板的更新时间");
        // 连续失败累加到封顶（u8 溢出用 saturating）
        apply_fetch_result(&mut s, "2026-09-07", false, 10_000);
        assert_eq!(s.fetch_failures, 2);
        // 成功：记日期、清零计数、记时刻，并收飞行标志
        apply_fetch_result(&mut s, "2026-09-07", true, 10_100);
        assert_eq!(s.fetch_date, "2026-09-07");
        assert_eq!(s.fetch_failures, 0, "成功即清零");
        assert_eq!(s.last_success_mins, 10_100);
        assert!(!s.fetch_inflight, "收尾必须收飞行标志，否则补拉被卡 10 分钟");
    }
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd src-tauri && cargo test 失败记账 2>&1 | tail -5`
Expected: 编译错误 `cannot find function apply_fetch_result`

> `spawn_fetch` 结尾那段（网络 + 落盘）没法单测，正确性靠代码审查 + Task 6 手工验证兜底 —— 审查时重点看两处：一是 `any_ok` 只在 `Ok(text)` 分支置位，二是 `s.fetched = true` 留在 `if` 外面。

- [ ] **Step 3: 写最小实现**

在 `due_fetch` 之后加纯函数（`NewsState` 是私有 struct，函数也放模块内，不导出）：

```rust
/// 一轮拉取的结果记账（纯函数，单测入口）：成功 → 内容算当天的、失败计数清零；
/// 全失败 → 只累加失败计数，**不写 fetch_date**。两种都要收飞行标志。
fn apply_fetch_result(s: &mut NewsState, today: &str, any_ok: bool, now: u64) {
    s.fetch_inflight = false;
    if any_ok {
        s.fetch_date = today.to_string();
        s.fetch_failures = 0;
        s.last_success_mins = now;
    } else {
        s.fetch_failures = s.fetch_failures.saturating_add(1);
    }
}
```

改 `spawn_fetch`：先加成功标志 —— 在 `let mut batches = Vec::new();` 后加 `let mut any_ok = false;`，并在 `Ok(text)` 分支里置位（`源通了就算成功，哪怕当天 0 条新内容`）：

```rust
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
                    let items = collect_from(&text, src.name, &today);
                    eprintln!("[plugin:{ID}] {}：当天 {} 条", src.name, items.len());
                    any_ok = true; // 源通了就算成功，哪怕当天 0 条新内容
                    batches.push(items);
                }
                Err(e) => {
                    // 源失败静默：下轮增量自然重试，不打扰用户
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
            apply_fetch_result(s, &today, any_ok, epoch_mins());
            (was_empty && !s.items.is_empty(), s.items.clone())
        });
        save_state(&app);
```

注意 `s.fetched = true` **保留在 `if` 外面**：全源失败时没有新内容可出，仍然不该出卡，所以出卡闸门照旧；变的是 `fetch_date` 不被写脏，下一轮能按退避补拉。

- [ ] **Step 4: 跑测试确认通过**

Run: `cd src-tauri && cargo check 2>&1 | tail -10 && cargo test 2>&1 | tail -10`
Expected: 无 warning，全部测试通过

- [ ] **Step 5: 提交**

```bash
git add src-tauri/src/plugin/news.rs
git commit -m "feat(news): 失败不写成功标记，按退避重试"
```

---

### Task 4: meta 暴露更新时间与陈旧标记

**Files:**
- Modify: `src-tauri/src/plugin/news.rs`（`meta` 第 509 行起）

**Interfaces:**
- Produces: summary 新增 `updated: u64`（epoch 分钟）与 `stale: bool`（Task 5 前端消费）。

- [ ] **Step 1: 改 meta**

替换 `meta` 里 `let s = STATE.lock()...` 到 summary 结束的段落：

```rust
    let s = STATE.lock().ok().and_then(|g| g.clone());
    let (total, remaining, latest, updated, stale) = match s {
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
            (
                s.items.len(),
                remaining,
                latest,
                s.last_success_mins,
                s.fetch_date != today,
            )
        }
        None => (0, 0, Vec::new(), 0, true),
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
            // 上次成功拉取时刻（epoch 分钟），前端格式化成本地 HH:MM
            "updated": updated,
            // 今天还没成功拉到内容（面板显示「更新中」）
            "stale": stale,
        }),
    }
```

- [ ] **Step 2: cargo check**

Run: `cd src-tauri && cargo check 2>&1 | tail -5`
Expected: 无 warning

- [ ] **Step 3: 提交**

```bash
git add src-tauri/src/plugin/news.rs
git commit -m "feat(news): 面板元信息带更新时间与陈旧标记"
```

---

### Task 5: 前端面板「更新于 HH:MM」

**Files:**
- Modify: `src/plugins/cards/news.ts`（`renderSection` 第 67 行起）
- Modify: `tests/plugin-sections.test.ts`（追加新闻用例；若 `2026-09-06-stocks-freshness.md` 未合入则本 Task 新建该文件）

**Interfaces:**
- Consumes: Task 4 的 `updated` / `stale` 字段。

- [ ] **Step 1: 写失败测试**

在 `tests/plugin-sections.test.ts` 追加（`stockFrontend` 的 import 已存在；若文件不存在，先按 stocks 计划 Task 5 的 Step 1 建它，import 段补 `newsFrontend`）：

```ts
import { newsFrontend } from "../src/plugins/cards/news";

/** epoch 分钟 → 本地 HH:MM，与被测代码同一套格式化。 */
function hhmm(mins: number): string {
  const d = new Date(mins * 60_000);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

describe("资讯面板分区", () => {
  const base = {
    enabled: true,
    categories: ["tech"],
    today_count: 7,
    remaining: 3,
    latest: [],
    updated: 0,
    stale: false,
  };

  it("显示更新时刻", () => {
    // 本地 14:05 对应的 epoch 分钟
    const d = new Date();
    d.setHours(14, 5, 0, 0);
    const el = newsFrontend.renderSection!(
      { ...base, updated: Math.floor(d.getTime() / 60_000) },
      host,
    );
    expect(el.textContent).toContain("今日 7 条");
    expect(el.textContent).toContain("更新于 14:05");
  });

  it("陈旧时追加更新中", () => {
    const d = new Date();
    d.setHours(9, 30, 0, 0);
    const el = newsFrontend.renderSection!(
      { ...base, updated: Math.floor(d.getTime() / 60_000), stale: true },
      host,
    );
    expect(el.textContent).toContain("更新于 09:30");
    expect(el.textContent).toContain("更新中");
  });

  it("从未成功拉过时不显示更新时间", () => {
    const el = newsFrontend.renderSection!({ ...base, updated: 0 }, host);
    expect(el.textContent).not.toContain("更新于");
  });

  it("旧版后端没有 updated 字段时退回原头部", () => {
    const el = newsFrontend.renderSection!(
      { enabled: true, categories: ["tech"], today_count: 7, remaining: 3, latest: [] },
      host,
    );
    expect(el.textContent).toContain("今日 7 条");
    expect(el.textContent).not.toContain("更新于");
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/plugin-sections.test.ts 2>&1 | tail -15`
Expected: FAIL —— 「更新于 14:05」用例找不到该文本

- [ ] **Step 3: 写最小实现**

`src/plugins/cards/news.ts` 的 `renderSection`：

```ts
  renderSection(data, host) {
    const s = data as {
      enabled: boolean;
      categories: string[];
      today_count: number;
      remaining: number;
      latest: { headline: string; source: string; url: string }[];
      /** 上次成功拉取时刻（epoch 分钟）；0 = 从未成功。旧版后端无此字段。 */
      updated?: number;
      /** 今天还没成功拉到内容。旧版后端无此字段。 */
      stale?: boolean;
    };
    const el = document.createElement("div");
    el.className = "pet-card-news-section";
    if (!s.enabled) {
      el.textContent = "未启用";
      return el;
    }
    const cats = s.categories
      .map((c) => CATEGORIES.find(([id]) => id === c)?.[1] ?? c)
      .join("、");
    const head = document.createElement("div");
    head.className = "pet-news-section-head";
    let text = `${cats} · 今日 ${s.today_count} 条`;
    if (s.updated) {
      const d = new Date(s.updated * 60_000);
      const hh = String(d.getHours()).padStart(2, "0");
      const mm = String(d.getMinutes()).padStart(2, "0");
      text += ` · 更新于 ${hh}:${mm}`;
    }
    if (s.stale) {
      text += " · 更新中";
    }
    head.textContent = text;
    el.appendChild(head);

    for (const item of s.latest) {
      const row = document.createElement("div");
      row.className = "pet-news-row";
      row.textContent = item.headline;
      row.title = `${item.source} · 点击打开原文`;
      row.addEventListener("pointerdown", (e) => {
        e.stopPropagation();
        host.openUrl(item.url);
      });
      el.appendChild(row);
    }
    return el;
  },
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/plugin-sections.test.ts 2>&1 | tail -10`
Expected: 全部 passed

- [ ] **Step 5: 提交**

```bash
git add src/plugins/cards/news.ts tests/plugin-sections.test.ts
git commit -m "feat(news): 面板显示更新于时刻与更新中标记"
```

---

### Task 6: 版本号同步到 0.9.0 + 手工验证

**Files:**
- Modify: `src-tauri/tauri.conf.json`、`src-tauri/Cargo.toml`、`package.json`

**Interfaces:**
- 前提：用户已确认「一次合入 0.9.0」。若 `2026-09-06-stocks-freshness.md` 已单独合入并提过版本，本 Task 跳到 Step 4 只做验证。

- [ ] **Step 1: 三处版本同步**

三处 `0.8.0` → `0.9.0`：
- `src-tauri/tauri.conf.json` 的 `version`
- `src-tauri/Cargo.toml` 的 `[package] version`
- `package.json` 的 `version`

- [ ] **Step 2: 校验三处一致**

Run: `grep -n '"version"' src-tauri/tauri.conf.json package.json; grep -n '^version' src-tauri/Cargo.toml`
Expected: 三处均为 `0.9.0`

- [ ] **Step 3: 全量检查**

Run: `npx tsc --noEmit && cd src-tauri && cargo check 2>&1 | tail -5 && cd .. && npx vitest run 2>&1 | tail -8`
Expected: tsc 无输出；cargo check 无 warning；vitest 全部通过

- [ ] **Step 4: 手工验证（无法自动化）**

Run: `pnpm tauri dev`

按 `docs/superpowers/specs/2026-09-06-data-freshness-design.md` 的 F2 逐条确认：

1. **首次启动补拉**：清掉 `~/Library/Application Support/dev.vibepet.app/plugins/news-cache`（或改日期让内容过期）→ 启动 → 应在数十秒内拉取，面板很快从「更新中」变成「更新于 HH:MM」。
2. **错过更新时间**：把 `fetch_hour` 设成比当前小时大的值（如现在 10 点设成 20）并让缓存内容过期 → 启动 → 仍会立即补拉（不看 `fetch_hour`）。
3. **失败退避**：断网 → 观察 stderr 日志，请求间隔应约 5 → 15 → 30 分钟递增，不是每 30 秒一次。
4. **1 小时刷新**：让当日条目全部出过卡（`next_idx` 走到底）→ 观察拉取间隔从 120 分钟变成 60 分钟。
5. **卡片间隔未变**：确认卡片仍是约 120 分钟一张（`NEWS_GAP_MINS` 未改）。
6. **面板文案**：左键面板资讯分区显示「AI·广告 · 今日 N 条 · 更新于 HH:MM」，陈旧时追加「· 更新中」。

- [ ] **Step 5: 提交版本号**

```bash
git add src-tauri/tauri.conf.json src-tauri/Cargo.toml package.json
git commit -m "chore: 版本 0.9.0（股票/新闻 数据时效性）"
```
