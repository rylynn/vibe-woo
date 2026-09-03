# 设计：自动更新 + 学外语科学性 + 窗口统一拖拽关闭

日期：2026-09-03
状态：已与用户逐节确认

三个相互独立的特性，各一次合入、各带一个版本号。实现顺序：**F3 → F2 → F1**（F3 最小热身；F2 自包含；F1 最重且依赖仓库转公开与密钥生成两项用户侧前置）。

---

## F1 自动更新

### 目标

每天定时检查一次新版本，自动下载安装；更新后宠物用气泡提示一次「更新了什么」（≤50 字核心变更摘要）。

### 已确认的决策

| 决策点 | 结论 |
|---|---|
| 隐私红线冲突 | 更新检查**默认开启**，仅匿名 GET GitHub Releases、不上传任何用户数据；设置可关；README 隐私节与设置文案写明 |
| 托管 | 公开 GitHub 仓库（rylynn/vibe-woo）+ GitHub Releases，Tauri updater 标准流程 |
| 摘要来源 | 仓库内 `src-tauri/version-notes.json` 编译进二进制（`include_str!`），离线可用 |
| 形态 | **独立后台线程**（用户指定），不做插件系统第五插件；另支持设置里手动「立即检查更新」 |

### 设计

**`src-tauri/src/updater.rs`（新）— 独立后台线程**

- `main.rs` setup 里 `updater::spawn(app)`；线程自建 tokio current-thread runtime。
- 节奏：启动后延迟 2 分钟首查（不与开机抢资源）→ 此后每 24 小时一次；`last_check` 时间戳持久化，重启不清零。
- 检查流：tauri-plugin-updater → GET `https://github.com/rylynn/vibe-woo/releases/latest/download/latest.json` → 有新版本则下载 + minisign 验签。
- **安装时机**：下载完成后若用户活跃则**按住不装**，每 5 分钟重试；判据统一为一个：`sensedrive::shared_state()` 的 `tempo == "resting"`（番茄工作期另有 `set_pomodoro_phase` 通道可参考，不满足则同样按住）。满足后才 `install()` + `app.restart()`。更新桌宠不值得打断工作。
- 所有错误静默（eprintln），24 小时后重试。

**配置与设置 UI**

- `config.json` 新增 `auto_update: bool`，默认 `true`。
- 设置「关于」区：自动更新开关、「立即检查更新」按钮、状态行。手动检查走 tauri command，结果经 `pet://update-status` 事件回显：「已是最新 0.4.1」/「已下载 0.4.2，将在你休息时自动重启」/「检查失败：网络错误」。

**`src-tauri/version-notes.json`（新）— 更新摘要**

```json
{"0.4.2": "番茄钟休息验证上线；词卡例句配中文翻译"}
```

- 启动时对比 `config.last_run_version` 与当前版本（`appinfo.rs` 已能读 `tauri.conf.json` 版本）：不同且当前版本有摘要 → 宠物气泡说一句（「我升级到 0.4.2 啦：番茄钟休息验证上线」），约 10 秒消失，**只此一次**；随后回写 `last_run_version`。无摘要则静默回写。
- 每条摘要 ≤50 字，硬性要求；release.sh 强制校验。

**`scripts/release.sh`（新）— 一键发版**

1. 校验三处版本一致（`tauri.conf.json` / `Cargo.toml` / `package.json`，对齐 version-on-merge 规则）；
2. 校验 version-notes.json 有当前版本条目，**没有则拒绝发版**；
3. `pnpm tauri build`（universal binary：aarch64 + x86_64）；
4. 生成 latest.json（version / pub_date / platforms 两架构指向同一 universal 产物 + 签名）；
5. `gh release create vX.Y.Z` 上传 `.app.tar.gz` + `.sig` + latest.json。
- `--check` 模式：只做 1、2，不构建。
- 签名密钥：`pnpm tauri signer generate` 生成 minisign 密钥对；公钥进 `tauri.conf.json`，私钥本地保存**绝不入库**。

**配套改动**

- `tauri.conf.json`：`plugins.updater`（pubkey / endpoint）+ `bundle.createUpdaterArtifacts: true`。
  - minisign 公钥已生成（2026-09-03，key id `E04BD49C1E8D82D7`）：
    `RWTXgo0enNRL4BIgPXVpuj3PWJbXlIMduaFHIpFqivTivSNy8d8mMq+H`；私钥存于用户本机，绝不入库。
- capabilities 加 `updater:default` 权限。
- README 隐私节 + 设置文案：「更新检查仅匿名 GET GitHub Releases，不含用户数据，可关闭」。

**仓库暂不公开的现状（2026-09-03 用户确认）**

- F1 照常实现：release.sh 用 `gh`（带用户鉴权）发布，私有仓库也能创建 Release；
- 私有期间客户端匿名 GET latest.json 得 404 → 走「检查失败」静默路径（设计的错误行为，无害）；
- 仓库转公开后无需改代码，更新能力自动生效。

### 测试

- 纯函数单测：`should_show_note(current, last_run, notes) -> Option<String>`；摘要 ≤50 字断言。
- 全链路无法自动化 → 手工验证清单（docs/plans 下新增，参考 m1 模式）：发 0.0.1-test → 安装 → 发 0.0.2-test → 验证检查 / 下载 / 活跃时按住 / 静默后重启 / 摘要气泡只出现一次。

### 用户侧前置（F1 开工前）

1. 仓库转公开（私有 Releases 匿名 GET 是 404）。
2. 本机生成 minisign 密钥对并妥善保存私钥。

---

## F2 学外语科学性

### 目标

1. 认识的词当天动态让位，**保证每天新词增量**；
2. 最近不认识 / 难的词走复习曲线，作为弹窗补充但**不占增量**；
3. 例句配上中文翻译；词库完整性对齐多邻国等成熟软件的科学性。

### 设计

**SRS 曲线：5 档 → 7 档，拆出「当日强化」区**

```
SRS_STEPS_MINS = [10, 30, 120, 1440, 4320, 10080, 30240]
                  └── 当日强化 ──┘ └───── 跨日曲线 ─────┘
```

- **首见点「认识」**：直接跳到 step=3（明天见）——认识的词当天不再出现，这就是「动态让位保增量」。
- **首见「没印象」**：走当日强化 10min → 30min → 2h，再进跨日曲线。
- 复习中「认识」+1 档（封顶）；「没印象」回 step=0、lapse+1（维持现状）。
- 旧状态迁移：旧 5 档 `[10m,1d,3d,7d,21d]` 按间隔时长等值映射到新 7 档（旧 step 0 → 新 0；旧 step s≥1 → 新 s+2），`serde(default)` 兜底缺失字段。

**配额分离（核心）**

- `daily_limit`（默认 8）**只数新词**：`WordsState` 拆 `served_new_count` / `served_review_count`，跨天都清零。
- 复习卡不占增量配额；独立上限 `2 × daily_limit` 防刷屏。
- 选词优先级（替换现有四档）：

| 序 | 类别 | 说明 |
|---|---|---|
| 1 | 当日强化到期 | 最近「没印象」的词（step<3 区间内到期、有反馈）——「最近不认识」最优先 |
| 2 | 新词 | 增量配额未满且从未见过 |
| 3 | 难词跨日到期 | lapses ≥ 2 |
| 4 | 普通跨日到期 | 有反馈 |
| 5 | 当日已见 / 跨日已读兜底 | 现状语义 |

- 出卡节奏不变：仍共享 15 分钟间隔 + only_resting 时间窗（不打扰原则优先）。
- 左键面板与设置摘要改为分别展示「今日新学 N / 复习 M」。

**难词（leech）**

- lapse ≥ 3：出卡时 hook 永远置顶展示（LLM 增强缓存有则必带）。
- 连续 5 次「没印象」：该词休眠 7 天（due 直接推后，不加新状态字段）。

**例句翻译 + 词库补齐（最重的实现任务）**

- `WordEntry` 新增 `ez` 字段（例句中文翻译，serde rename，default 空）；卡片 payload 加 `example_zh`；前端例句下方渲染翻译行，空则隐藏。
- **离线一次性补齐全部 2255 条**：955 条现有例句配翻译；1300 条 ECDICT 扩展词（`*_x` 词书）写上例句 + 翻译。实现阶段分批（约 8–10 批）写入。
- 词库完整性测试升级：`e` 与 `ez` 全部非空——**删除 `_x` 词书例句豁免**，基线永久抬升。
- LLM 增强同步扩展：prompt 输出 JSON 增加 `example_zh`（将生成例句译为中文）；`Enhanced` 结构与 payload 同步。

### 测试

选词五档优先级、配额分离记账（新词满配额后复习照发、复习超上限停发）、首见认识跳 step=3、难词休眠、旧状态等值迁移、`ez`/`e` 完整性、payload 含 `example_zh`；前端词卡渲染翻译行。

---

## F3 窗口统一拖拽 + 关闭

### 目标

所有持久面板理论都可拖拽、都有关闭按钮；收敛重复代码，新面板自动获得该能力。

### 设计

**`src/overlay/chrome.ts`（新）**

```ts
export function panelChrome(
  panel: HTMLElement,
  title: string,
  onClose: () => void,
  opts?: { closeTitle?: string },
): HTMLHeadingElement
```

- 一次构建「标题栏 + 拖拽 + ×」：内部调既有 `enablePanelDrag(panel, head)`；× 沿用 `pointerdown + stopPropagation` 健壮模式；返回 head。
- 四套 close 类名（`pet-settings-close` / `pet-today-close` / `pet-hub-close` / `pet-avatar-picker-close`）收敛为一个类，旧类名在 CSS 留别名。

**补齐与迁移**

| 窗口 | 现状 | 改动 |
|---|---|---|
| 今日速记 today | 有关无拖 | + 拖拽 |
| 插件面板 hub | 有关无拖 | + 拖拽 |
| 速记输入条 quick-note | 无 × 无拖 | + ×（语义 = `hide()` 丢弃输入，与 Esc 取消一致，**不保存**）+ 拖拽 |
| 提醒大卡片 | 故定右上角 | + 拖拽（默认位置不变，挡住内容时可挪）+ ×（**语义 = 稍后 10 分钟**，与「稍后」按钮同路径 snooze_reminder，绝不误删） |
| settings / about / friends / reminders / avatar-picker | 已齐 | 迁移到 `panelChrome()`，各删 ~15 行重复 |
| 右键菜单、宠物气泡 | — | 不动（瞬态 UI，非面板） |

### 测试

chrome 单元测试（结构、close 回调触发、button/input/select 不触发拖拽）；现有面板测试回归；拖拽阈值逻辑已有测试覆盖。

---

## 非目标（本次不做）

- 🔊 TTS 发音按钮（`say` 命令零网络方案）——未获确认，列为后续候选。
- Windows / Linux 更新通道、增量更新、灰度发布。
- 学外语：多题型（选择/拼写）、连击打卡、听力。
- 面板位置持久化记忆（拖完重开回默认位）。
