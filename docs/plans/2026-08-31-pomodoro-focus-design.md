# 番茄专注：专注判定 / 免打扰 / 激励 设计文档

日期：2026-08-31
状态：设计已确认，待实施

## 1. 背景

当前番茄功能（`src-tauri/src/pomodorodrive.rs`）只做了三件事：计时、休息期键鼠活跃
判定、认真休息发特效奖励。**工作期完全没有专注判定** —— `Phase::Working` 分支里除
了到点切换状态什么都没做（`pomodorodrive.rs:99-116`）。

同时排查发现，番茄运行期间用户实际会被 talk / react / social / remind 四个模块打断，
其中定时说话在安静人格下 4–5 分钟一次（`talkdrive.rs:34-38`），一个 25 分钟番茄里会响
5–6 次 —— 与"番茄钟帮助用户专注"的目标直接冲突。

本文档解决三件事：怎么判定专注、番茄期间怎么减少打扰、怎么激励。

## 2. 四条核心原则

这四条是所有细节决策的依据，冲突时以此为准。

### 2.1 判定只用于发奖励，绝不用于惩罚

零权限约束下只能测到"有没有产生输入"和"输入发生在哪类应用"，测不到"输入内容有没
有价值"。因此任何判定都是概率性的、可错的。

> **测不准的时候必须站在用户这边。**

具体含义：判定结果只有"给奖励"和"什么都不做"两种出口。不存在第三种"告知用户你这
一轮不专注"。用户选择：**A. 完全沉默** —— 负面状态永不外显。

### 2.2 打扰预算是延迟，不是删除

被闸门拦下的消息分三类处理，区别对待：

| 类别 | 处理 | 理由 |
|---|---|---|
| 即时反应（`react.rs`） | **丢弃** | "你进入心流了"延迟 25 分钟再说毫无意义 |
| 重要提醒（`important: true`） | **降级立即呈现** | 吃药没资格被番茄钟拦 |
| 普通提醒 / 社交互访 | **排队，休息期合并补发** | 静默丢弃会让用户焦虑"错过了什么" |
| 定时说话（`talkdrive`） | **跳过，不排队** | 本来就是闲聊，不积压 |

### 2.3 不打扰优先于有存在感

宠物本身就是打扰源 —— 漫游、跳动都在争夺视觉注意力。番茄工作期宠物自动降档，既是
减少打扰，也是"我在陪你专注"最直观的表达（比任何文案都有效）。

### 2.4 激励不能变成 KPI

一旦"完成 N 个番茄"成为目标，它就不再是深度工作的好代理（Goodhart's Law）—— 用户会
刷番茄数。因此**永远只展示"已经做了什么"，不展示"应该做几个"**。

## 3. 现状诊断

### 3.1 打扰源清单

| 来源 | 频率 | 番茄期严重性 |
|---|---|---|
| `pet://talk` 定时说话 | Quiet 4–5 分钟（`talkdrive.rs:34-38`） | **致命**，25 分钟响 5–6 次 |
| `react.rs` 即时反应 | 全局最小间隔 90 秒（`react.rs:44`） | **高** |
| `pet://social` 好友来访 | 随机，气泡停留 30 秒 | **高**，最久的气泡 |
| `pet://reminder` 每日提醒 | 到点触发 | **最高**，带三按钮的操作卡片 |
| `LongSit` 久坐催休息 | 45 分钟（`react.rs:40`） | 中，且与番茄功能重叠 |

**核心矛盾**：项目已有完整的专注感知（FLOW / STUCK / `is_producing`），但这些感知
没有反哺到"该不该闭嘴"上。目前只有 `react.rs:212-220` 一条"心流/卡住时不催久坐"的
孤例规则 —— 本次把它提升为全局机制，那处特例随之删除。

### 3.2 激励的两个结构性缺陷

**缺陷一：奖励挂在"休息质量"上，而非"专注"上。** 这是因果倒置 —— 用户要的是专注的
激励，但现在只有"认真休息"才有奖励，等于告诉用户"我们真正在乎的是你别碰鼠标"。

**缺陷二：当天会断供。**

```31:33:src-tauri/src/rewards.rs
    pub fn all() -> [RewardEffect; 3] {
        [RewardEffect::Tomato, RewardEffect::Bubbles, RewardEffect::Sparkle]
    }
```

只有 3 种特效，集齐后 `grant_random` 返回 `None` —— 第 4 个番茄开始，做得再好也什么都
没有。且隔天清零，每天从零开始，没有累积感。

## 4. 架构：两个新模块

职责不同，不合并。

```
src-tauri/src/quiet.rs   打扰闸门（无状态查询，被四个模块调用）
src-tauri/src/focus.rs   专注判定（有状态累加，由 sensedrive 喂数）
src-tauri/src/stats.rs   当日/本周统计与成长值持久化
```

### 4.1 `quiet.rs`

```rust
pub enum Phase { Idle, Working, Break }

/// 现在能不能弹 UI。只有两档 —— 第三档 Degraded 是 YAGNI，
/// 提醒的降级形态由 reminddrive 自己决定，不需要闸门参与。
pub enum Verdict { Silent, Now }

pub fn set_phase(p: Phase)              // pomodorodrive 调
pub fn set_flow(on: bool)               // sensedrive 调
pub fn set_muted_until(t: Instant)      // 托盘「静音 1 小时」
pub fn gate() -> Verdict

pub enum DeferKind { Reminder, Social }
pub fn defer(kind: DeferKind, text: String)
pub fn drain() -> Vec<Deferred>         // break_start 时调用
```

**闸门规则**（自上而下短路）：手动静音 → `Working` 期 → `Flow 且 producing` → 其余 `Now`。

`Flow 且 producing` 一条在番茄关闭时同样生效 —— 这是行为变更，已与用户确认接受。

**合并策略**：`drain()` 时同类多条合并。"刚才有 3 位朋友来过" 而不是三条气泡轮播。

### 4.2 `focus.rs`

```rust
pub struct Session {
    total_secs: f64,
    on_task_secs: f64,   // producing 且 keyboard_idle < AWAY_IN_SESSION_SECS
    switches: u32,       // bundle id 变更次数
    last_bundle: Option<String>,
    sampled_any: bool,
}

/// 只有两档。Normal 与原本设想的 Off 行为完全一致（不奖励、不外显），
/// 砍掉一档即砍掉一整层边界条件。
pub enum Grade { Deep, Normal }
```

喂数点：`sensedrive.rs:101-110` 之后，即 `snap` 与 `bundle` 都就绪处。

## 5. P0 番茄期零打扰

### 5.1 接入点

| 文件 | 位置 | 改动 |
|---|---|---|
| `talkdrive.rs` | `56-71` 之后 | `gate() == Silent` → 跳过，**不推进间隔** |
| `sensedrive.rs` | `117-133` | `gate() == Silent` → 不调用 `reactor.feed` |
| `reminddrive.rs` | 触发处 | Silent 时重要提醒降级、普通提醒入队 |
| `socialdrive.rs` | `298-315` | Silent 时入队，不直接 emit |
| `react.rs` | `212-220` | 删除特例（已由全局闸门覆盖） |

`talkdrive` 跳过时**不推进 `next_at`**（现有逻辑已如此，`talkdrive.rs:115-121` 只在真正
说出话后才推进完整间隔），因此休息期只会补一句，不会连珠炮 —— 此处无需改动。

### 5.2 宠物视觉降档

`work_start` → `pet.setFocusMode(true)`；`break_start` → `false`。

实现要点：**不要调用 `setScope()`**。那是持久化到 config 的用户设置，会因番茄开关被
静默改写。改为在 `pet.ts` 加一个独立的 `focusMode` 布尔，在行为决策处覆盖：

```ts
const scope = this.focusMode ? "still" : this.scope;
```

`RoamScope` 已有 `still` 档（`src/anim/behavior.ts:53-55`），零新代码。同时帧率降到
idle 档，顺带省电 —— 对 5.2.1 遗留的 CPU 超标问题有正向作用。

### 5.3 逃生口

托盘菜单加「静音 1 小时」，独立于番茄开关。用户开会、面试、投屏时不该被迫去关番茄钟。

## 6. P1 专注判定

### 6.1 信号与阈值

| 信号 | 来源 | 说明 |
|---|---|---|
| `on_task_secs` | `snap.app.is_producing()` && `keyboard_idle < 120s` | 主指标 |
| `switches` | bundle id 变更次数 | **目前完全没有采集，这是最大缺口** |
| `sampled_any` | `sensor::sample()` 是否成功过 | 测不准的兜底 |

`switches` 是最值得补的单一指标：只记 bundle id 变更，零新权限、零隐私风险，且比击键
频率更能代表专注 —— 注意力残留（attention residue）研究的核心结论是**切换本身就是成本，
不需要知道切去了哪里**。

番茄期内"离开"阈值用 **120 秒**，而非全局的 600 秒（`state.rs:124`）—— 25 分钟里走开
8 分钟不该算专注。

### 6.2 判定规则

```
sampled_any == false                            → Normal（测不准不给奖）
on_task / total >= 0.85 && switches <= 2       → Deep
其余                                            → Normal
```

`sampled_any` 的处理与 `pomodorodrive.rs:159-167` 的 `RestVerdict::Unknown` 是同一原则：
**不冤枉用户**。

阈值常数全部 `pub const`，单测风格对齐 `pomodorodrive.rs:232-271`。

### 6.3 已知待修的既有问题

`state.rs:132` 的 `FLOW_KPM = 120.0` 是按"写代码"调的。画图、做设计、看方案的人击键
频率天然低，永远进不了 FLOW。应按 `AppKind` 分档（Editing / Writing / Designing / Data
各自阈值），而非一刀切。此项不阻塞 P1，但会削弱 `Flow` 信号的准确性，建议同期修。

### 6.4 奖励出口（关键解耦）

`Deep` 的常规奖励发给**成长值**（无穷尽），不给特效。

这样 P1 不依赖 P2 的特效池扩容即可独立交付 —— 否则第 4 个番茄就撞上 `rewards.rs:31`
只有 3 个特效的天花板。

## 7. P2 激励

### 7.1 三层

**即时反馈（零成本）**：番茄期间宠物静止陪伴（5.2 节），结束时伸懒腰。这个"陪你熬过
来了"的共苦感比发徽章更打动人。复用已有的 `celebrate` 动作帧（设计文档 4.3）。

**进度可见（天级）**：暴露 `memory.rs` 已有的 `focus_secs`，加当日番茄计数。

**稀缺惊喜（长期）**：`Deep` 番茄约 12% 概率额外掉一个未拥有的特效。可变比率强化
（variable ratio reinforcement）是行为学上维持效果最强的机制。

### 7.2 成长值与发放规则

| 事件 | 成长值 | 说明 |
|---|---|---|
| 番茄完成（Normal） | +3 | 完成即有价值，不是全有全无 |
| 番茄完成（Deep） | +10 | |
| Deep 且命中 12% | +稀有特效 | 池子已满则只给成长值 |

设计文档 5.4 提到的亲密度尚未实现（仓库中只有 social 的好友度），此处一并落地最小版本。

### 7.3 本周活跃天数替代 streak

`active_days: [bool; 7]` + `week_start`。**加分制而非清零制** —— 断一天不归零。

⚠️ 明确不做跨天连击（streak）。研究上副作用明确：streak anxiety（用户生病也强行工
作）、断连后 "what the hell effect" 导致放弃率飙升，且与"无负担"定位直接冲突。

### 7.4 特效池扩容

从 3 个扩到 10 个。新增 7 个，均为少量 `fillRect` 可完成、符合像素风：

`leaf` 头顶小芽 / `halo` 光环 / `crown` 小王冠 / `music` 音符 / `heart` 爱心 /
`fire` 燃 / `glasses` 眼镜

渲染位置沿用 `pet.ts:424-460` 的模式：无状态、由 `nowMs` 确定性驱动，无粒子系统。

## 8. 持久化

新增 `stats.json`，复用 `rewards.rs:73-87` 的读写模式（文件损坏即视为空，不致命）。

```jsonc
{
  "date": "2026-08-31",
  "pomodoros": 6,
  "deep_count": 4,
  "focus_secs": 9000.0,
  "bond": 128,
  "week_start": "2026-08-31",
  "active_days": [true, false, true, true, true, false, false]
}
```

`focus_secs` 不在此重复计算 —— 读 `memory.rs` 的 `focus_secs` 后写入，避免两套真值。

## 9. 测试策略

沿用现有风格：Rust 侧阈值常量断言 + 纯函数边界。

- `focus.rs`：ratio 边界（0.849 / 0.85）、switches 边界（2 / 3）、`sampled_any=false`
  不给 Deep、`total_secs=0` 不除零
- `quiet.rs`：闸门优先级（静音 > Working > Flow）、静音到期、阶段切换后 gate 恢复
- 延迟队列：同类合并条数、drain 后清空、空队列 drain 返回空
- `stats.rs`：跨天归零、周起点滚动、断一天 `active_days` 不归零
- 前端：`focusMode` 覆盖 `scope` 且不写回 `this.scope`

## 10. 落地顺序与验收

| 优先级 | 内容 | 验收 |
|---|---|---|
| **P0** | 番茄期零打扰（闸门 + 提醒降级 + 宠物降档 + 托盘静音） | 25 分钟内零弹窗（重要提醒降级除外）；宠物静止；休息期补发队列 |
| **P1** | 专注判定（两态 + 成长值出口） | 全程 VSCode 无切换 → Deep；刷 20 分钟网页 → 无任何反馈、无指责 |
| **P2** | 激励（当日计数 + 本周活跃天数 + 特效池扩容 + 稀有掉落） | 连用 7 天计数正确；断一天不归零 |

P0 最先做 —— 几乎全是"少做点事"，不需要任何新权限、新依赖，且用户能立刻感知到
"它知道我在专注"。

P1 依赖 P0 的 `quiet.rs` 吗？不依赖，两者可并行。但 P1 的奖励出口需要 P2 的成长值存储，
因此 **P1 与 P2 的 `stats.rs` 需同期落地**。

## 11. 明确不做

- 跨天连击（streak）—— 7.3 节已述理由
- 番茄数排行榜 —— 好友间比多少会把休闲变竞争，杀死内在动机。可以做"都在专注"的状态
  共存，不能比数量
- 今日目标线 —— 2.4 节已述理由
- near-miss（"差一点就得到"）—— 赌场手法
- 读窗口标题 —— 隐私红线，与 `sensor.rs:3-5` 的原则冲突
- 应用级屏蔽（blocklist）—— 那是"电子脚镣"，与产品气质冲突，且需要辅助功能授权
