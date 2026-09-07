# 股票数据新鲜度 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 非交易时段不展示历史行情 —— 面板显示「未开盘／周末休市」，且**不发卡片、不占仲裁器 90s 全局间隔**。

**Architecture:** 从腾讯行情行里扫描时间戳字段，按标的语义（A股/港股 +8、美股美东）换算成本地日期，逐条过滤出当日行情；市场状态（Live/Weekend/Closed）由一个纯函数推导，`tick` 与 `meta()` 共用它。`meta()` 在非 Live 时直接下发空数组，把「不给历史数字」的收口放在 Rust 侧。

**Tech Stack:** Rust (Tauri 2 插件模块) + TypeScript（无框架，DOM 手写）；`chrono 0.4` 已在 `src-tauri/Cargo.toml`，无新依赖。

## Global Constraints

- 代码注释、commit message、文档**均使用中文**。
- 用户指定：**一次合入 0.9.0**。本计划**不改版本号** —— 版本号由资讯计划（`2026-09-06-news-catchup.md`）统一提到 0.9.0；若本计划先合入，跳过那一步即可。
- 合入前全绿：`npx tsc --noEmit`、`cd src-tauri && cargo check`、`npx vitest run`。
- **纯逻辑优先可测**：状态推导一律写成纯函数并补单测，驱动层（tick/meta）保持薄。
- **不打扰是第一原则**：非 Live 一律静默返回，不发卡。
- Rust 单测函数用中文名；前端单测文件需 `// @vitest-environment happy-dom` 首行注释。
- `docs/` 被 `.gitignore` 忽略 —— 提交文档用 `git add -f`。
- 前端 `stock.ts` 的 TS interface 与 Rust 契约手工对齐，改一处同步另一处。

---

### Task 1: 行情时间戳 → 本地日期（纯函数）

**Files:**
- Modify: `src-tauri/src/plugin/stocks.rs`（在 `parse_hhmm` 之后新增；`use chrono::{NaiveDate, NaiveDateTime};` 加到文件顶部 use 区）

**Interfaces:**
- Produces: `fn quote_ts_local_date(fields: &[&str], symbol: &str) -> String` —— Task 3 的 `parse_line` 调用它。
- 辅助（本 Task 内部 + 单测）：`fn is_us_dst(d: NaiveDate) -> bool`、`fn us_dst_offset(d: NaiveDate) -> i32`、`fn shift_to_beijing(local: NaiveDateTime, local_offset_hours: i32) -> String`。

- [ ] **Step 1: 写失败测试**

在 `stocks.rs` 的 `mod tests` 里追加（既有的 `A_SHARE` / `US_SHARE` 常量已在文件里，直接用）：

```rust
    #[test]
    fn 行情时间戳换算本地日期() {
        // A股：14 位紧凑格式，已是北京时间
        let f: Vec<&str> = A_SHARE.split('~').collect();
        assert_eq!(quote_ts_local_date(&f, "sh600519"), "2026-09-02");
        // 港股同样 +8
        assert_eq!(quote_ts_local_date(&f, "hkHSI"), "2026-09-02");
        // 美股：19 位带空格格式，美东 2026-09-01 16:00 → 北京 2026-09-02 04:00
        let uf: Vec<&str> = US_SHARE.split('~').collect();
        assert_eq!(
            quote_ts_local_date(&uf, "usAAPL"),
            "2026-09-02",
            "美东 9/1 16:00（夏令时 -4）= 北京 9/2 04:00"
        );
        // 扫不到时间戳 → 空串（调用方视为陈旧）
        assert_eq!(quote_ts_local_date(&["1", "名", "0"], "sh600519"), "");
    }

    #[test]
    fn 美东夏令时边界() {
        let d = |m: u32, day: u32| NaiveDate::from_ymd_opt(2026, m, day).unwrap();
        // 2026-03-01 是周日 → 第二个周日是 03-08，夏令时从这天起
        assert!(!is_us_dst(d(3, 7)), "03-07 仍是冬令时");
        assert!(is_us_dst(d(3, 8)), "03-08 起夏令时");
        // 2026-11-01 是周日 → 第一个周日，夏令时到这天结束
        assert!(is_us_dst(d(10, 31)));
        assert!(!is_us_dst(d(11, 1)), "11-01 起冬令时");
        assert!(!is_us_dst(d(1, 15)), "1 月冬令时");
        assert!(is_us_dst(d(7, 15)), "7 月夏令时");
    }
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd src-tauri && cargo test 行情时间戳 2>&1 | tail -5`
Expected: 编译错误 `cannot find function quote_ts_local_date`

- [ ] **Step 3: 写最小实现**

在 `stocks.rs` 的 `parse_hhmm` 函数之后插入；同时在文件顶部 use 区加 `use chrono::{NaiveDate, NaiveDateTime};`：

```rust
/// 美东夏令时判定（纯算术，不引 tz 数据库）：2007 年起为 3 月第二个周日
/// 至 11 月第一个周日。只按**日期**判，不精确到切换那一刻的 02:00 ——
/// 1 小时误差对「时间戳是不是今天」无影响（美东收盘 16:00 落在北京
/// 04:00–05:00，不跨午夜），但差值本身要算对，否则边界日会错一整天。
fn is_us_dst(d: NaiveDate) -> bool {
    let m = d.month();
    if m < 3 || m > 11 {
        return false;
    }
    if m > 3 && m < 11 {
        return true;
    }
    // 某月第 n 个周日的日号（chrono：周一=0 … 周日=6）
    let nth_sunday = |n: u32| -> Option<u32> {
        let first = NaiveDate::from_ymd_opt(d.year(), m, 1)?;
        let to_sunday = (6 - first.weekday().num_days_from_monday() as u32) % 7;
        Some(1 + to_sunday + (n - 1) * 7)
    };
    match (m, nth_sunday(2), nth_sunday(1)) {
        (3, Some(s), _) => d.day() >= s,
        (11, _, Some(e)) => d.day() < e,
        _ => true,
    }
}

/// 美东相对 UTC 的偏移（小时）：夏令时 -4，冬令时 -5。
fn us_dst_offset(d: NaiveDate) -> i32 {
    if is_us_dst(d) { -4 } else { -5 }
}

/// 把一个时区的本地时刻换算成北京日期。
/// `local_offset_hours` 为该时区相对 UTC 的偏移（美东 -5 / -4）。
fn shift_to_beijing(local: NaiveDateTime, local_offset_hours: i32) -> String {
    let utc = local - chrono::Duration::hours(local_offset_hours as i64);
    (utc + chrono::Duration::hours(8)).format("%Y-%m-%d").to_string()
}

/// 从行情字段里扫描时间戳，换算成**本地（北京）日期** `YYYY-MM-DD`；
/// 扫不到返回空串 —— 调用方一律视为陈旧（安全方向：宁可不显示，不显示错的）。
///
/// 时间戳字段**下标在 A股/港股/美股间会漂移**（实测 A股在第 28 位、美股在
/// 第 30 位），所以不认下标，扫描全部字段匹配两种格式；时区按 symbol 前缀
/// 判（比按格式判更稳）。
fn quote_ts_local_date(fields: &[&str], symbol: &str) -> String {
    let eastern = symbol.starts_with("us");
    for raw in fields {
        let t = raw.trim();
        let naive = if t.len() == 14 && t.bytes().all(|b| b.is_ascii_digit()) {
            // 14 位紧凑：20260902161444（A股/港股，已是北京时间）
            NaiveDate::parse_from_str(&t[..8], "%Y%m%d").ok().and_then(|d| {
                d.and_hms_opt(
                    t[8..10].parse().unwrap_or(0),
                    t[10..12].parse().unwrap_or(0),
                    t[12..14].parse().unwrap_or(0),
                )
            })
        } else if t.len() == 19 {
            // 19 位带空格：2026-09-01 16:00:01（美股，美东时间）
            NaiveDateTime::parse_from_str(t, "%Y-%m-%d %H:%M:%S").ok()
        } else {
            None
        };
        let Some(naive) = naive else { continue };
        return if eastern {
            shift_to_beijing(naive, us_dst_offset(naive.date()))
        } else {
            naive.date().format("%Y-%m-%d").to_string()
        };
    }
    String::new()
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd src-tauri && cargo test 行情时间戳 2>&1 | tail -5 && cargo test 美东夏令时 2>&1 | tail -5`
Expected: 两个 `test result: ok. 1 passed`

- [ ] **Step 5: 提交**

```bash
git add src-tauri/src/plugin/stocks.rs
git commit -m "feat(stocks): 行情时间戳按市场时区换算本地日期"
```

---

### Task 2: 市场状态与新鲜度闸门（纯函数）

**Files:**
- Modify: `src-tauri/src/plugin/stocks.rs`（`quote_ts_local_date` 之后；测试在 `mod tests`）

**Interfaces:**
- Produces: `enum MarketState { Live, Weekend, Closed }`、`fn is_weekend(date: &str) -> bool`、`fn fresh_quotes(quotes: &[Quote], today: &str) -> Vec<Quote>`、`fn market_state(today: &str, quotes: &[Quote]) -> MarketState`、`fn card_gate(today: &str, quotes: &[Quote]) -> Option<Vec<Quote>>`
- Task 4 消费 `card_gate`（tick）与 `fresh_quotes` + `market_state`（meta）。

- [ ] **Step 1: 写失败测试**

```rust
    #[test]
    fn 周末判定() {
        assert!(is_weekend("2026-09-05"), "周六");
        assert!(is_weekend("2026-09-06"), "周日");
        assert!(!is_weekend("2026-09-07"), "周一");
        assert!(!is_weekend("乱七八糟"), "解析失败按工作日处理，宁可多拉一次");
    }

    #[test]
    fn 市场状态三态判定() {
        let q = |d: &str| Quote {
            symbol: "sh600519".into(),
            name: "n".into(),
            price: 1.0,
            change_pct: 0.0,
            date: d.into(),
            ..Default::default()
        };
        assert_eq!(market_state("2026-09-07", &[q("2026-09-07")]), MarketState::Live);
        assert_eq!(
            market_state("2026-09-07", &[q("2026-09-04")]),
            MarketState::Closed,
            "上周五的数据不算今天"
        );
        assert_eq!(market_state("2026-09-07", &[q("")]), MarketState::Closed, "没时间戳视为陈旧");
        assert_eq!(market_state("2026-09-07", &[]), MarketState::Closed);
        // 周末优先于时间戳：周六凌晨的美股时间戳换算过来仍是「今天」，但确实休市
        assert_eq!(market_state("2026-09-05", &[q("2026-09-05")]), MarketState::Weekend);
    }

    #[test]
    fn 逐条过滤只留当日行情() {
        let q = |sym: &str, d: &str| Quote {
            symbol: sym.into(),
            name: sym.into(),
            price: 1.0,
            change_pct: 0.0,
            date: d.into(),
            ..Default::default()
        };
        let all = vec![q("sh600519", "2026-09-07"), q("usAAPL", "2026-09-04")];
        let fresh = fresh_quotes(&all, "2026-09-07");
        assert_eq!(fresh.len(), 1);
        assert_eq!(fresh[0].symbol, "sh600519", "A股已收盘/美股未开盘时只显示新鲜的");
    }

    #[test]
    fn 陈旧闸门挡住收盘总结与变动卡() {
        let q = |d: &str| Quote {
            symbol: "s".into(),
            name: "n".into(),
            price: 1.0,
            change_pct: 5.0,
            date: d.into(),
            ..Default::default()
        };
        assert!(card_gate("2026-09-07", &[q("2026-09-07")]).is_some(), "当日行情放行");
        assert!(card_gate("2026-09-07", &[q("2026-09-04")]).is_none(), "历史数据 → 不出卡（含总结）");
        assert!(card_gate("2026-09-07", &[]).is_none());
        assert!(card_gate("2026-09-05", &[q("2026-09-05")]).is_none(), "周末 → 不出卡");
    }
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd src-tauri && cargo test 市场状态 2>&1 | tail -5`
Expected: 编译错误 `cannot find function market_state`

- [ ] **Step 3: 写最小实现**

注意：本 Task 的测试用了 `..Default::default()` 和 `date` 字段，需要本 Task 先落地（`parse_line` 的**接线**留给 Task 3，但字段必须现在就有，否则 Task 3 之前编译不过）。

先在 `Quote` 定义处（第 135 行附近）加 `Default` derive 与 `date` 字段：

```rust
#[derive(Debug, Default, Clone, PartialEq, Serialize, Deserialize)]
pub struct Quote {
    pub symbol: String,
    pub name: String,
    pub price: f64,
    pub change_pct: f64,
    /// 行情时间戳换算出的**本地日期** `YYYY-MM-DD`；空串 = 没能解析出时间戳
    ///（旧缓存缺字段自动补空串 → 一律判为陈旧，安全方向正确）。
    #[serde(default)]
    pub date: String,
}
```

再给 `parse_line` 的返回构造临时补 `date: String::new()`（**仅为了编译通过**，Task 3 会替换成真实值）：

```rust
    Some(Quote {
        symbol,
        name: f[1].trim().to_string(),
        price,
        change_pct,
        date: String::new(), // Task 3 接真实时间戳
    })
```

然后插入新函数：

```rust
/// `YYYY-MM-DD` 是否为周六或周日。解析失败按工作日处理 ——
/// 宁可多拉一次行情，也不要因为日期算错就装死。
fn is_weekend(date: &str) -> bool {
    NaiveDate::parse_from_str(date, "%Y-%m-%d")
        .map(|d| matches!(d.weekday(), chrono::Weekday::Sat | chrono::Weekday::Sun))
        .unwrap_or(false)
}

/// 今天能不能展示行情数字。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum MarketState {
    /// 有当日行情，数字可用。
    Live,
    /// 周末休市。
    Weekend,
    /// 非交易时段 / 节假日 / 接口数据滞后。
    Closed,
}

/// 只保留时间戳落在今天的行情（**逐条**过滤，不是整盘开关）。
fn fresh_quotes(quotes: &[Quote], today: &str) -> Vec<Quote> {
    quotes
        .iter()
        .filter(|q| !q.date.is_empty() && q.date == today)
        .cloned()
        .collect()
}

/// 决定今天能不能展示行情数字。
///
/// 周末判定**优先于**时间戳：周六 04:00（北京）= 周五 16:00 美东收盘，
/// 时间戳换算过来是「今天」，但确实是休市。
fn market_state(today: &str, quotes: &[Quote]) -> MarketState {
    if is_weekend(today) {
        return MarketState::Weekend;
    }
    if quotes.iter().any(|q| !q.date.is_empty() && q.date == today) {
        return MarketState::Live;
    }
    MarketState::Closed
}

/// tick 的闸门（纯函数部分）：非 Live 一律不出卡，**收盘总结也在内** ——
/// 节假日不该对着昨天的数据发「收盘总结」。放行时返回当日行情。
fn card_gate(today: &str, quotes: &[Quote]) -> Option<Vec<Quote>> {
    let fresh = fresh_quotes(quotes, today);
    (market_state(today, &fresh) == MarketState::Live).then_some(fresh)
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd src-tauri && cargo test 周末判定 2>&1 | tail -3 && cargo test 市场状态 2>&1 | tail -3 && cargo test 逐条过滤 2>&1 | tail -3 && cargo test 陈旧闸门 2>&1 | tail -3`
Expected: 四个 `test result: ok. 1 passed`

- [ ] **Step 5: 提交**

```bash
git add src-tauri/src/plugin/stocks.rs
git commit -m "feat(stocks): 市场状态推导与新鲜度闸门（纯函数）"
```

---

### Task 3: `Quote.date` 接进解析，修复既有测试

**Files:**
- Modify: `src-tauri/src/plugin/stocks.rs`（`parse_line` 第 211 行附近的 `Some(Quote { .. })`；Task 2 里临时补的 `date: String::new()` 换成真实值）

**Interfaces:**
- Consumes: Task 1 的 `quote_ts_local_date`、Task 2 的 `MarketState`（用于「旧缓存缺 date」那条断言）。
- Produces: `parse_line` 填充 `date` 字段（Task 4 依赖）。

- [ ] **Step 1: 写失败测试**

```rust
    #[test]
    fn 解析结果带上本地日期() {
        let q = parse_line(A_SHARE).unwrap();
        assert_eq!(q.symbol, "sh600519");
        assert_eq!(q.date, "2026-09-02", "A股 14 位时间戳 → 本地日期");
        let q2 = parse_line(US_SHARE).unwrap();
        assert_eq!(q2.date, "2026-09-02", "美股美东 9/1 16:00 → 北京 9/2");
    }

    #[test]
    fn 旧缓存缺date字段视为陈旧() {
        let q: Quote = serde_json::from_str(
            r#"{"symbol":"sh600519","name":"n","price":1.0,"change_pct":0.0}"#,
        )
        .unwrap();
        assert_eq!(q.date, "", "旧缓存没有 date → 空串");
        assert_eq!(market_state("2026-09-07", &[q]), MarketState::Closed, "→ 判为陈旧");
    }
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd src-tauri && cargo test 解析结果带上 2>&1 | tail -5`
Expected: FAIL（date 为空串）

- [ ] **Step 3: 写最小实现**

改 `parse_line` 的返回构造（`symbol` 会被 move，先算 date）：

```rust
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
    let name = f[1].trim().to_string();
    let date = quote_ts_local_date(&f, &symbol);
    Some(Quote {
        symbol,
        name,
        price,
        change_pct,
        date,
    })
```

（`symbol` 会被 move，所以 `date` 必须在 `Some(Quote { symbol, .. })` 之前算好 —— 这是本步骤唯一容易写错的地方。）

然后给 `mod tests` 里剩下的 `Quote { .. }` 字面量补 `..Default::default()`（`split_views` / `fetch_targets` 测试里的期望值）。先 `grep -n "Quote {" src-tauri/src/plugin/stocks.rs` 定位，排除掉 Task 2 已经用 `..Default::default()` 的那几处和刚改好的 `parse_line`。例如：

```rust
        let cur = vec![Quote {
            symbol: "s".into(),
            name: "n".into(),
            price: 10.0,
            change_pct: 3.0,
            ..Default::default()
        }];
```

```rust
        let q = |s: &str| Quote {
            symbol: s.into(),
            name: s.into(),
            price: 1.0,
            change_pct: 0.0,
            ..Default::default()
        };
```

- [ ] **Step 4: 跑全部 stocks 测试**

Run: `cd src-tauri && cargo test stocks 2>&1 | tail -20`
Expected: 全部 `test result: ok`，无编译错误

- [ ] **Step 5: 提交**

```bash
git add src-tauri/src/plugin/stocks.rs
git commit -m "feat(stocks): 解析结果带本地日期，旧缓存缺字段判为陈旧"
```

---

### Task 4: tick / meta 接线 + 周末降频

**Files:**
- Modify: `src-tauri/src/plugin/stocks.rs`（`FETCH_GAP_MINS` 常量、`tick` 第 400–490 行、`meta` 第 520 行起）

**Interfaces:**
- Consumes: Task 2 的 `card_gate` / `fresh_quotes` / `market_state` / `is_weekend`。
- Produces: `meta()` summary 新增 `market` 字段（Task 5 前端消费）。

- [ ] **Step 1: 改拉取节流常量**

把

```rust
/// 行情拉取节流（分钟）。数据要实时：2 分钟一拉（腾讯行情秒级刷新，
/// 节流只为不自残），且不受展示时段限制 —— 时段只闸门出卡，
/// 面板里的数字任何时候打开都应该是活的。
const FETCH_GAP_MINS: u64 = 2;
```

替换为：

```rust
/// 行情拉取节流（分钟）。数据要实时：工作日 2 分钟一拉（腾讯行情秒级刷新，
/// 节流只为不自残），且不受展示时段限制 —— 时段只闸门出卡，
/// 面板里的数字任何时候打开都应该是活的。
const FETCH_GAP_WEEKDAY_MINS: u64 = 2;

/// 周末休市是确定的，30 分钟探一次活就够 —— 别在休市时白打接口。
const FETCH_GAP_WEEKEND_MINS: u64 = 30;

fn fetch_gap_mins(weekend: bool) -> u64 {
    if weekend {
        FETCH_GAP_WEEKEND_MINS
    } else {
        FETCH_GAP_WEEKDAY_MINS
    }
}
```

- [ ] **Step 2: 改 tick**

替换整个 `fn tick(&mut self, ctx: &mut TickCtx) -> Vec<PluginCard>` 函数体：

```rust
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
        let now_min = now_ctx.minutes;
        let weekend = is_weekend(&today);

        with_state(|s| rollover(s, &today));

        // —— 实时数据：拉取不受展示时段限制（时段只闸门出卡）。
        // 面板与卡片任何时候看到的都该是活行情，不是「窗口内的旧快照」。
        let need_fetch =
            with_state(|s| now.saturating_sub(s.last_fetch_mins) >= fetch_gap_mins(weekend));
        if need_fetch {
            with_state(|s| s.last_fetch_mins = now); // 防重复触发
            spawn_fetch(cfg.clone(), today.clone(), ctx.app.clone());
        }

        // —— 新鲜度闸门：非当日行情一律不出卡，**收盘总结也在内** ——
        // 节假日不该对着昨天的数据发「收盘总结」。不发卡即不进仲裁器，
        // 也就不占 90s 全局间隔（「不占用事件」）。
        let Some(fresh) = with_state(|s| card_gate(&today, &s.quotes)) else {
            return Vec::new();
        };

        // —— 收盘总结：到点、当日快照已就绪、未发过 ——
        // 原「到点还没行情就补拉」分支已删除：拉取在闸门之前无条件进行
        //（每 2 分钟一轮），走到这里时当日行情必然已就绪或本轮刚触发过拉取，
        // 留着只会是死代码。
        if !cfg.summarize_after.is_empty() {
            if let Some(after) = parse_hhmm(&cfg.summarize_after) {
                if now_min >= after {
                    let llm_off = {
                        let llm = crate::configcmd::current().llm;
                        !llm.enabled || llm.api_key.is_empty()
                    };
                    let ready = with_state(|s| {
                        s.summarized_date != today && (llm_off || !s.digest.is_empty())
                    });
                    if ready {
                        let (items, indices, digest) = with_state(|s| {
                            s.summarized_date = today.clone();
                            s.last_card_mins = now;
                            let (primary, secondary) = split_views(&fresh, &cfg.symbols);
                            s.last_card_quotes = primary.clone();
                            (primary, secondary, s.digest.clone())
                        });
                        save_state(ctx.app);
                        return vec![make_card(&items, &indices, &digest, true)];
                    }
                }
            }
        }

        // —— 展示时段内：变动判定出卡（拉取已在时段外持续进行）——
        if !in_windows(now_min, &cfg.windows) {
            return Vec::new(); // 盘中/工作时间不出卡
        }

        let card = with_state(|s| {
            if now.saturating_sub(s.last_card_mins) < STOCKS_GAP_MINS {
                return None;
            }
            let (primary, secondary) = split_views(&fresh, &cfg.symbols);
            let hits = significant_changes(&primary, &s.last_card_quotes, cfg.change_threshold_pct)?;
            s.last_card_mins = now;
            s.last_card_quotes = primary;
            Some((hits, secondary))
        });
        match card {
            Some((hits, indices)) => {
                save_state(ctx.app);
                vec![make_card(&hits, &indices, "", false)]
            }
            None => Vec::new(),
        }
    }
```

- [ ] **Step 3: 改 meta**

替换 `pub fn meta` 的缓存读取段与 summary：

```rust
pub fn meta(app: &tauri::AppHandle) -> PluginMeta {
    let cfg = load_config(app);
    let today = crate::reminddrive::local_now()
        .map(|c| c.date)
        .unwrap_or_default();
    let s = STATE.lock().ok().and_then(|g| g.clone());
    let fresh = match s {
        Some(mut s) if s.date == today => {
            rollover(&mut s, &today);
            fresh_quotes(&s.quotes, &today)
        }
        _ => Vec::new(),
    };
    let market = market_state(&today, &fresh);
    let (primary, indices) = split_views(&fresh, &cfg.symbols);
    PluginMeta {
        id: ID.into(),
        name: "股市投资".into(),
        kind: ID.into(),
        summary: serde_json::json!({
            "enabled": cfg.enabled,
            "symbols": cfg.symbols,
            "market": market,
            // 非 live 时 fresh 本就是空 —— 收口在 Rust 侧：
            // 旧版前端即使没更新也拿不到历史数字
            "quotes": primary,
            "indices": indices,
        }),
    }
}
```

- [ ] **Step 4: cargo check + 全量测试**

Run: `cd src-tauri && cargo check 2>&1 | tail -10 && cargo test 2>&1 | tail -10`
Expected: 无 warning（`cargo check` 输出无 `warning:` 行），全部测试通过

- [ ] **Step 5: 提交**

```bash
git add src-tauri/src/plugin/stocks.rs
git commit -m "feat(stocks): 非当日行情不出卡不占事件，周末拉取降频"
```

---

### Task 5: 前端面板文案

**Files:**
- Modify: `src/plugins/cards/stock.ts`（`Quote` interface、`renderSection`）
- Create: `tests/plugin-sections.test.ts`

**Interfaces:**
- Consumes: Task 4 的 `market` / `quotes` / `indices` 字段。

- [ ] **Step 1: 写失败测试**

新建 `tests/plugin-sections.test.ts`：

```ts
// @vitest-environment happy-dom
// 面板分区要造 DOM 节点；其余测试保持 node 环境零开销。
import { describe, expect, it } from "vitest";
import type { CardHost } from "../src/plugins/registry";
import { stockFrontend } from "../src/plugins/cards/stock";

/** renderSection 只在点击时才用 openUrl，桩即可。 */
const host: CardHost = { openUrl: () => {}, markTerm: () => {} };

describe("股市面板分区", () => {
  const base = {
    enabled: true,
    symbols: [],
    market: "live" as const,
    quotes: [],
    indices: [],
  };

  it("未开盘时显示未开盘而不是历史数字", () => {
    const el = stockFrontend.renderSection!({ ...base, market: "closed" }, host);
    expect(el.textContent).toBe("未开盘");
    expect(el.querySelector(".pet-stock-row")).toBeNull();
  });

  it("周末显示周末休市", () => {
    const el = stockFrontend.renderSection!({ ...base, market: "weekend" }, host);
    expect(el.textContent).toBe("周末休市");
  });

  it("有当日行情时照常显示数字", () => {
    const el = stockFrontend.renderSection!(
      {
        ...base,
        quotes: [
          { symbol: "sh600519", name: "贵州茅台", price: 1297.5, change_pct: -0.16, date: "2026-09-07" },
        ],
      },
      host,
    );
    expect(el.textContent).toContain("贵州茅台");
    expect(el.querySelector(".pet-stock-row")).toBeTruthy();
  });

  it("旧版后端没有 market 字段时退回原有文案", () => {
    const el = stockFrontend.renderSection!({ enabled: true, symbols: [], quotes: [], indices: [] }, host);
    expect(el.textContent).toContain("今日还没有行情");
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/plugin-sections.test.ts 2>&1 | tail -15`
Expected: FAIL —— 「未开盘」用例得到的是「今日还没有行情（默认展示…）」

- [ ] **Step 3: 写最小实现**

`src/plugins/cards/stock.ts`：

1. `Quote` interface 加 `date: string`（与 Rust 对齐）：

```ts
/** 行情条目（与 Rust Quote 契约一致）。 */
interface Quote {
  symbol: string;
  name: string;
  price: number;
  change_pct: number;
  /** 行情时间戳换算出的本地日期 YYYY-MM-DD；空串 = 没能解析出时间戳。 */
  date: string;
}
```

2. `renderSection` 的 `data` 类型加 `market`，并改文案分支：

```ts
  renderSection(data) {
    const s = data as {
      enabled: boolean;
      symbols: string[];
      /** Rust 侧推导的市场状态；旧版后端没有这个字段时为 undefined。 */
      market?: "live" | "weekend" | "closed";
      quotes: Quote[];
      indices: Quote[];
    };
    const el = document.createElement("div");
    el.className = "pet-card-stock-section";
    if (!s.enabled) {
      el.textContent = "未启用";
      return el;
    }
    if (s.quotes.length === 0) {
      // 非 live 时 Rust 已经把 quotes 清空了 —— 这里只负责把状态说清楚。
      // market 缺失（旧版后端）走最后的兜底分支，不会显示历史数字。
      if (s.market === "weekend") {
        el.textContent = "周末休市";
      } else if (s.market === "closed") {
        el.textContent = "未开盘";
      } else {
        el.textContent =
          s.symbols.length > 0
            ? `关注 ${s.symbols.length} 只 · 今日还没有行情`
            : "今日还没有行情（默认展示上证/恒指/纳指）";
      }
      return el;
    }
    el.appendChild(renderRows(s.quotes));
    if (s.indices.length > 0) {
      const head = document.createElement("div");
      head.className = "pet-stock-section-head";
      head.textContent = "指数";
      el.appendChild(head);
      el.appendChild(renderRows(s.indices));
    }
    return el;
  },
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/plugin-sections.test.ts 2>&1 | tail -10`
Expected: `4 passed`

- [ ] **Step 5: 提交**

```bash
git add src/plugins/cards/stock.ts tests/plugin-sections.test.ts
git commit -m "feat(stocks): 面板按市场状态显示未开盘/周末休市"
```

---

### Task 6: 手工验证与全量检查

**Files:**
- 无新改动

- [ ] **Step 1: 全量检查**

Run: `npx tsc --noEmit && cd src-tauri && cargo check 2>&1 | tail -5 && cd .. && npx vitest run 2>&1 | tail -8`
Expected: tsc 无输出；cargo check 无 warning；vitest 全部通过

- [ ] **Step 2: 手工验证（无法自动化）**

Run: `pnpm tauri dev`

按 `docs/superpowers/specs/2026-09-06-data-freshness-design.md` 的 F1 逐条确认：

1. **工作日开盘时段**（如周一 10:30）左键面板 → 股市分区显示行情数字，与上次出卡行为一致。
2. **工作日盘前**（如周一 08:00，且缓存里有上周五数据）→ 面板显示「未开盘」，**不弹任何卡片**（观察 2 分钟以上）。
3. **周末** → 面板显示「周末休市」；`log` 里行情请求约 30 分钟一次，不是 2 分钟一次。
4. **跨午夜**：美股交易时段（北京 21:30–05:00）内，本地 00:00 之后最多 2 分钟面板恢复显示美股数字，期间显示「未开盘」（设计已接受的代价）。
5. 配置「关注标的」后重复 1–3，确认指数二级视图不受影响。

- [ ] **Step 3: 收尾（不改版本号）**

本计划**不动** `tauri.conf.json` / `Cargo.toml` / `package.json` 的版本号 —— 用户指定两个特性一次合入 0.9.0，版本号由资讯计划统一提。确认 `git status` 干净即可。
