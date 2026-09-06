# 设计：股票 / 新闻 数据时效性

日期：2026-09-06
状态：已与用户逐节确认
版本：**0.9.0**（一次合入，两个特性）

两个特性同属"数据新鲜度"主题，各一次合入、共一个版本号。

| 特性 | 一句话 |
|---|---|
| F1 股票新鲜度 | 非交易时段不显示历史行情，只显示"未开盘/周末休市"，且**不发卡片、不占仲裁器全局间隔** |
| F2 新闻补拉 | 当天该更没更（内容还是昨天的）时启动后立刻补拉；当日存量看完后按 1 小时增量刷新 |

---

## F1 股票新鲜度

### 目标

自然日 T+1 后不使用历史数据。非交易时段面板显示"未开盘"，而不是上一交易日的收盘数字。

### 现状问题（确认）

`rollover` 只按自然日清空缓存，但**拉取不受展示时段限制、2 分钟一次**（`FETCH_GAP_MINS = 2`）。
周二早 8 点拉到的是周一收盘价，会被当成实时行情显示在左键面板里 —— 即"用了历史数据"。
用户原话：「自然日T+1后不要使用历史数据，比如不开盘时间不要展示之前的数据，展示未开盘即可。同时不占用事件」。

### 已确认的决策

| 决策点 | 结论 |
|---|---|
| 新鲜度判定 | **行情时间戳 + 本地自然日 + 周末**，不写死交易时段表（节假日/临时休市自动覆盖，无需维护日历） |
| "不占用事件" | **只进面板，不发卡片** —— 不产 PluginCard、不占仲裁器 `GLOBAL_CARD_GAP` 90s 全局间隔（贴合"不打扰是第一原则"） |
| 美股时区 | 按**标的语义**判时区（`sh`/`sz`/`hk` → UTC+8；`us` → 美东），不按时间戳格式判 |
| 美东夏令时 | 纯算术判定（2007 年起：3 月第二个周日 → 11 月第一个周日为 -4，否则 -5），不引 tz 数据库 |
| 过滤粒度 | **逐条**，不是整盘开关 —— A股已收盘、美股未开盘时，只显示新鲜的那些 |
| 周末拉取 | 周六日降到 30 分钟（休市是确定的，探活无意义）；工作日维持 2 分钟不变 |

### 设计

**`src-tauri/src/plugin/stocks.rs`**

1. **提取时间戳（新函数 `quote_ts_local_date`）**

   腾讯行情的时间戳字段**下标在 A股/港股/美股间会漂移**（实测：A股 `20260902161444` 在第 28 位，美股 `2026-09-01 16:00:01` 在第 30 位）。
   因此**不硬编码下标，扫描全部字段**匹配两种格式：

   | 格式 | 时区 | 样例 |
   |---|---|---|
   | 14 位数字 `YYYYMMDDHHMMSS` | 北京（UTC+8，无夏令时） | `20260902161444` |
   | `YYYY-MM-DD HH:MM:SS` | 美东 | `2026-09-01 16:00:01` |

   时区按 symbol 前缀取。美东夏令时 1 小时误差对"是不是今天"的判定**无影响**（美东收盘 16:00 落在北京 04:00–05:00 或美西…均不跨午夜），故接受固定偏移。

2. **`Quote` 新增 `date: String`**（`#[serde(default)]`）

   换算后的本地日期 `YYYY-MM-DD`。旧缓存缺字段 → 空串 → 判为陈旧（**安全方向正确**）。

3. **市场状态（纯函数 `market_state`）**

   ```
   is_weekend(本地日期)          → Weekend「周末休市」  ← 优先于时间戳
   任一 quote.date == 本地今天    → Live（数字可用）
   否则                          → Closed「未开盘」     ← 含盘前 / 节假日 / 接口滞后
   ```

   周末判定**优先于**时间戳：周六 04:00（北京）= 周五 16:00 美东收盘，时间戳换算过来是"今天"，但确实是休市。

4. **逐条过滤（纯函数 `fresh_quotes`）**

   保留 `quote.date == 本地今天` 的条目；一条都不剩 → 状态非 Live。

5. **`tick` 收口**

   非 Live 直接 `return Vec::new()` —— 不发卡、不进仲裁器、不动 90s 全局间隔。
   **收盘总结卡同样要求 Live**（节假日不会对着昨天的数据发"收盘总结"）。

6. **`meta()` summary 加 `market: "live" | "weekend" | "closed"`**

   非 live 时 `quotes` / `indices` **直接给空数组** —— 收口在 Rust 侧，旧版前端即使没更新也拿不到历史数字。

7. **周末拉取降频**：`FETCH_GAP_MINS` → `fetch_gap_mins(is_weekend)`（工作日 2 / 周末 30）。

   已知代价：本地 00:00 跨过自然日时美股仍在盘中（北京 21:30–05:00 跨午夜），缓存被 rollover 清空后最多 2 分钟（周末后 30 分钟）才恢复显示，期间显示"未开盘"。

**`src/plugins/cards/stock.ts`**

`renderSection` 加 4 行分支：非 live 且 `quotes` 为空 → 按 `market` 显示"未开盘"/"周末休市"（替代现在的"今日还没有行情"）。

---

## F2 新闻启动补拉 + 1 小时刷新

### 目标

错过当天更新时间、内容还是过去的 → 启动后触发更新；当日存量看完后 1 小时刷新一次。

用户原话：「如果错过当天更新时间，信息还是过去的，则在启动后触发更新。同时可以1个小时更新一下信息（如果看过的）」。
"如果看过的" = 缓存里的条目都出完卡了（`next_idx >= items.len()`）。

### 现状问题

`due_fetch` 要求 `mins_of_day/60 >= fetch_hour`；陈旧状态只在 rollover 整体清零时**隐式**保证，不可测、也解释不清。
且 `spawn_fetch` 里失败也照样置 `fetched = true` —— 当天首轮挂掉要等 120 分钟。

### 已确认的决策

| 决策点 | 结论 |
|---|---|
| 补拉触发 | **不看 `fetch_hour`** —— 陈旧状态下最该做的是立刻拉（副作用：`fetch_hour=9` 的用户 8:00 开机也会拉到当天内容，符合"启动后触发更新"） |
| 失败退避 | 0 → 5 → 15 → 30（上限 30）分钟。补拉判定每 30s 跑一次，无退避会在源挂掉时每 30 秒猛打 12 个源 |
| 1 小时 | 只作用于**拉取**间隔（`FETCH_INTERVAL_MINS`）；**卡片间隔 `NEWS_GAP_MINS` 保持 120 分钟不变** —— "信息更新更勤"不等于"卡片弹更勤" |
| 陈旧判定 | 显式字段 `fetch_date`，替代依赖 rollover 的隐式保证 |

### 设计

**`src-tauri/src/plugin/news.rs`**

1. **`NewsState` 新增三字段**（全部 `#[serde(default)]`，旧缓存兼容）

   | 字段 | 含义 |
   |---|---|
   | `fetch_date: String` | 上次**成功**拉取的本地日期；空 = 从未成功 |
   | `fetch_failures: u8` | 连续失败轮次（退避用） |
   | `last_success_mins: u64` | 上次成功时刻（面板"更新于 HH:MM"） |

2. **`due_fetch`（纯函数，改签名加 `today`）**

   ```rust
   fn due_fetch(s: &NewsState, mins_of_day: u32, now: u64, fetch_hour: u32, today: &str) -> bool {
       if s.fetch_date != today {
           // 今天还没成功拉到 → 立即补拉（失败退避）
           return now.saturating_sub(s.last_fetch_mins) >= retry_backoff_mins(s.fetch_failures);
       }
       mins_of_day / 60 >= fetch_hour
           && now.saturating_sub(s.last_fetch_mins) >= fetch_interval_mins(s)
   }
   ```

3. **`fetch_interval_mins`（新纯函数）**

   ```rust
   fn fetch_interval_mins(s: &NewsState) -> u64 {
       if s.next_idx >= s.items.len() { 60 } else { 120 }
   }
   ```

4. **成功/失败记账边界（`spawn_fetch`）**

   - 任一源返回成功（即使当天 0 条新内容）→ `fetch_date = today`、`fetch_failures = 0`、`last_success_mins = now`
   - 全部源失败 → 只 `fetch_failures += 1`，**不写 `fetch_date`**

5. **`meta()` summary 加 `updated`（epoch 分钟）与 `stale: bool`**

**`src/plugins/cards/news.ts`**

`renderSection` 头部显示"AI·广告 · 今日 7 条 · 更新于 14:05"（`updated` 格式化为本地 HH:MM）；`stale` 为 true 时追加"· 更新中"。

---

## 测试清单

**Rust（`stocks.rs`）**：时间戳两种格式换算 / 美东夏令时边界 / 周末判定 / 三态判定 / 逐条过滤 / 无时间戳视为陈旧 / 旧缓存补空串 / 陈旧不发总结。

**Rust（`news.rs`）**：跨天与首次启动立即补拉 / 失败退避不猛打 / 存量看完后间隔 60 / 成功记账当天与时刻 / 旧缓存缺字段视为陈旧。

**前端（`tests/plugin-sections.test.ts` 新）**：股票面板"未开盘"/"周末休市"文案、新闻面板"更新于"。

---

## 影响面

改动集中在 `stocks.rs` / `news.rs` / `stock.ts` / `news.ts` 四个文件。
**不动**仲裁器、宿主、`TimeCtx`、`reminddrive`。
无新依赖（chrono / libc 已在 Cargo.toml）。

## 合入检查

`npx tsc --noEmit` / `cargo check`（src-tauri）/ `npx vitest run` 全绿；
三处版本同步到 0.9.0：`src-tauri/tauri.conf.json`、`src-tauri/Cargo.toml`、`package.json`。
