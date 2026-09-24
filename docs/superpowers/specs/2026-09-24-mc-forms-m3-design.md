# MC 形态 M3（素材 + 设置）设计稿

接续 `2026-09-22-minecraft-forms-design.md`（总规格）与 M2（动画 + 表情，1.8.0 已合入并经手工验证）。M3 把 MC 形态从开发切换入口升级为正式功能：玩家皮肤库（导入/管理/持久化）、猫/狗形态（自定义骨架 + 全动作对齐 + 尾摆）、形象弹窗统一入口，并移除 `Ctrl+Alt+M` 开发入口。

## 1. 目标与非目标

**目标**
- MC 形态可持久化：重启/升级后保持，进 `config.json` 的 avatar 字段。
- 玩家皮肤库：导入本地 PNG（64×64 / 64×32，≤64KB），命名、删除、上限 16 张。
- 猫/狗形态：内置模型与贴图，动作集与玩家对齐（呼吸/走/小跳/伸懒腰/张望/抱起/睡眠）+ 尾巴量化摆动。
- 形象弹窗成为唯一切换入口（参数形象 | MC 形态两页签）；首次领养弹窗同样双页签。
- 移除 dev-toggle（shortcut.rs / dev-toggle.ts 全链路）。

**非目标**
- 猫/狗不接受皮肤导入（原版 entity 贴图与玩家 UV 不兼容，UI 明示「皮肤仅对玩家形态生效」）。
- 皮肤编辑器、皮肤市场、网络下载——一律不做。
- 访客皮肤同步——M4（本设计的 sha256 寻址即为其地基）。

## 2. 配置持久化

### 2.1 AvatarConfig 枚举化

`config.rs` 的 `AvatarConfig` 从平铺结构体改为 `#[serde(untagged)]` 枚举：

```rust
#[serde(untagged)]
pub enum AvatarConfig {
    /// 参数形象（原 9 字段原样内联；在前——旧配置无 kind，只能匹配它）
    Parametric(ParametricAvatarConfig),
    /// MC 形态
    Minecraft(McAvatarConfig),
}

pub struct McAvatarConfig {
    pub form: McFormConfig,      // "player" | "cat" | "dog"（lowercase 枚举）
    pub skin_id: String,         // "builtin:default" 或 sha256 hex
}
```

兼容性论证（测试锁死）：
- 旧参数配置：无 `kind`、无 `form`/`skin_id`，但 `Parametric` 分支的必填字段（shape 等）都在 → 只匹配 Parametric。
- MC 配置 `{form, skin_id}` 缺 shape 等必填 → Parametric 落空 → 匹配 Minecraft。
- 序列化输出保持平铺（untagged 序列化内联变体），`ConfigView.avatar` / `ConfigPatch.avatar` 直通不变；snake_case 契约测试（`形象字段名为snake_case…`）继续成立，另补 MC 分支字段名测试（`form`/`skin_id`）。
- `apply_patch` 的「只能设不能清」语义不变——形态切换永远是 Some→Some，`avatar: None`（首次未领养）逻辑不动。
- 前端 `AvatarConfigView` 镜像为判别联合：`kind === "minecraft"` → `{ form, skinId }`，否则参数形象（`avatarToView`/`avatarFromView` 各加一分支，`skinId ↔ skin_id` 转换）。

### 2.2 皮肤库（新模块 `src-tauri/src/mcskin.rs`）

目录：`app_config_dir()/skins/`，文件 `<sha256hex>.png` + `index.json`（`{ skins: [{ id, name, imported_at }] }`）。index 走 tmp+rename 原子写（照 `plugin/store.rs` 惯例）；png 文件写入也原子（先写 `<id>.png.tmp` 再 rename）。

四个 Tauri 命令：

| 命令 | 行为 | 失败（脱敏枚举） |
|---|---|---|
| `mc_import_skin(name, bytes)` | 校验（下述）→ sha256 为 id → 内容去重（同 id 只更新名字与时间）→ 上限 16 张 → 落盘 + 更新 index → 返回 `SkinMeta` | `too-large` / `not-png` / `bad-size` / `limit-reached` / `write-failed` |
| `mc_list_skins()` | 读 index（缺失 → 空表；损坏 → 重建为空并扫描目录恢复可恢复项） | 不失败 |
| `mc_delete_skin(id)` | 删文件 + index 条目；**当前 `config.avatar` 为 MC 且 `skin_id == id` 时拒绝** | `in-use` / `not-found` |
| `mc_get_skin(id)` | 返回文件字节 | `not-found` / `bad-id` |

校验规则（与前端 `src/mc/skin.ts` 同值，Rust 侧独立实现最小 PNG 头解析：签名 + IHDR 宽高）：PNG 魔数、宽 64、高 64 或 32、总字节 ≤ `64 * 1024`、`id` 必须匹配 `[a-f0-9]{64}`（防路径穿越）。

日志只记阶段、id、错误类别；不记皮肤内容。内置皮肤 `builtin:default` 不落目录（前端资产，M1 已有），删除命令对它天然不可达（`bad-id` 不匹配 hex 格式）。

### 2.3 移除 dev-toggle

删 `shortcut.rs` 的 `EVENT_MC_DEV_TOGGLE` / `mc_dev_toggle()` / `handle()` 内 debug 分支 / `mc_dev_toggle_is_ctrl_alt_m` 测试，删 `main.rs` 的注册行，删前端 `src/mc/dev-toggle.ts` 与 `main.ts` 的装配。`builtin:default` 的加载移到启动引导（§4）。

## 3. 猫/狗模型与动画

### 3.1 骨架（模型空间同玩家：x 右、y 上、z 朝观察者；面向观察者站立，身体长轴沿 z）

约束：所有盒坐标/尺寸偶数（整数顶点）；**头正面 8×8**（眼部表情系统零改动复用）；无 overlay 层（内置贴图单层）；boxes 顺序 = painter 同深度平手序。

参考盒表（猫；狗同构、躯干略长、耳贴图表达下垂、尾一节）——实施时允许观感微调，约束不可破：

| 盒 | min | size | 备注 |
|---|---|---|---|
| 右前腿 | [-6, 0, 4] | [2, 6, 2] | |
| 左前腿 | [4, 0, 4] | [2, 6, 2] | |
| 右后腿 | [-6, 0, -6] | [2, 6, 2] | |
| 左后腿 | [4, 0, -6] | [2, 6, 2] | |
| 躯干 | [-4, 6, -8] | [8, 6, 16] | 横置，长轴 z |
| 头 | [-4, 12, 4] | [8, 8, 8] | 正面 8×8；z 4..12 前伸超出躯干前端 |
| 右耳 | [-4, 20, 6] | [2, 2, 2] | 猫竖耳；狗无耳盒（贴图表达） |
| 左耳 | [2, 20, 6] | [2, 2, 2] | |
| 尾节 1 | [-2, 12, -10] | [2,2,2] | 猫两节竖直上翘贴躯干后壁；狗一节 |
| 尾节 2 | [-2, 14, -10] | [2, 2, 2] | |

总高（猫）22 单位（耳顶）× 1.5m = 33m px，四足天然矮于玩家的 48m——同档位下物种体型差异，接受。面数：猫 10 盒 × 3 = 30、狗 8 盒 × 3 = 24，均 ≤ 36 预算。

偶数约束的两个已知代价（接受，不做特殊处理）：2 宽小件（尾/耳）无法关于 x=0 完全居中——耳取对称双件抵消，尾取 x∈[-2,0]（顶视图轻微偏左 ~3px）；狗比猫少耳盒与尾节 2。

UV：64×64 自定义简化布局（各面矩形不重叠即可）；头正面固定 (8,8) 起 8×8（与玩家一致，生成脚本与眼部覆盖都省事）。贴图由 `scripts/gen-mc-skin.mjs` 扩展生成（`default-cat.png` / `default-dog.png`），入库为前端资产。

### 3.2 姿态扩展

- `McForm = "player" | "cat" | "dog"`；`modelForForm` 三路。
- `McPose` 加 `tailPhase: number`（0..7，玩家恒 0）；`McPoseInput` 加 `form: McForm`。
- `mcPose` 按 form 分派动作语义：
  - **walk**：对角小跑——右前+左后同相 `swing(limbPhase)`，左前+右后反相（+4），复用 SWING 表与 75ms/相位。
  - **hop**：四肢收拢（腿 dy −2 上收）+ 尾竖直（tailPhase 视为最高档）。
  - **stretch**：play bow——前腿前伸（dz +2）+ 头低（头 dy −2）+ 后半身翘（后腿/躯干后端抬，用后腿 dy +2 近似）+ actPhase (0.15, 0.85) 缓冲同玩家。
  - **lookaround**：头 yaw 扫视同玩家；尾随相位轻摆。
  - **held**：四肢下垂慢摆（250ms/相位同玩家）+ 尾巴下垂（尾盒 dy −2）。
  - **sleep**：侧蜷——新躺平分支（区别玩家仰躺 PT），全部用盒平移（dy/dz），绝不旋转：躯干 dy −6 贴地，头 dy −12 落地（正脸仍朝观察者），前腿 dz −2 / 后腿 dz +2 向躯干下方收拢，尾 dy 下垂贴地；呼吸只朝一个方向（头 dz +2，同「只抬不沉」原则），闭眼。
  - **idle**：呼吸 3 档（头 dy ±2）+ 尾摆。
- **尾摆**：`tailPhase = floor(nowMs / 600) % 8`，尾盒 dx 取 4 档摆幅（`2·round(sin(2πp/8))` 同 SWING，猫 600ms/相位、狗 400ms/相位）。尾摆进帧指纹（`tailPhase` 字段），静止档跳帧不受影响。
- 盒偏移仍按盒名查表（`offs[b.name] ?? ZERO` 兜底已在），猫狗各自偏移表。

### 3.3 脏矩形与帧指纹

- `mcDirtyBounds(ox, oy, m, pose)` → 加第 5 参 `form: McForm`，内部 `modelForForm(form)`（玩家/猫/狗各按自己模型推导，M2 预留的 M3 约束兑现）；`pet.ts` 传 `avatar.form`。
- `mcFrameKey` 字段表追加 `form` 与 `pose.tailPhase`（M2 的 §3.3 描述同步更新）。
- tint 三画布、tired 眼袋、镜像翻转、still 档冻结呼吸——全部原样生效，无新机制。

## 4. 启动与数据流

```
启动：getConfig()
  ├─ avatar 为参数/None → 原逻辑
  └─ avatar 为 MC：
      1. 确保 builtin:default 注册（内嵌资产 fetch，必成功）
      2. skin_id 为 sha256 → mc_get_skin → loadAndRegisterSkin
         失败（手删文件等）→ 回退 builtin:default + 记类别日志
      3. 完成/回退后才 pet.setAvatar（加载期间保持上一形象，不留空白帧）

导入：弹窗「+」格 → file input(accept=image/png) → arrayBuffer
  → mc_import_skin(文件名去扩展名, bytes)
  → 失败：格区行内中文提示（脱敏枚举映射）
  → 成功：mc_get_skin → loadAndRegisterSkin → 刷格子并选中

选择：格子点击 = 本地选中态（预览即切换）；确认 → onConfirm(PetAvatar)
  → pet.setAvatar（即时生效）+ updateConfig({ avatar: avatarToView(a) })

删除：格子 ×（使用中/内置禁用）→ 二次确认 → mc_delete_skin → 刷格子
```

`avatarToView/FromView` 承担联合转换后，`main.ts` 的 `onConfirm` 不再 `asParametric` 折叠 MC。

## 5. 形象弹窗 UI

- 顶部页签「参数形象 | MC 形态」（DOM 按钮，沿用弹窗现有样式）；参数页现状不动；默认页签 = 参数形象（首次领养同样）。
- MC 页：形态行（玩家/猫/狗，选中高亮）→ 皮肤格子区（48px 预览 `drawAvatarStill`；仅玩家形态可选，猫/狗显示一行说明「猫/狗使用内置形象」）→「+」导入格（隐藏 file input，两处既有先例）。
- 预览动画区直接复用 M2 的 `drawPreview` MC 分支（`mcPose` 驱动 hop/stretch/lookaround）。
- 打开弹窗时若当前是 MC 形象 → 直接落在 MC 页并选中当前形态/皮肤。
- 设置面板「形象」区块不动：预览与「换一批」对 MC 天然兼容（换一批 = 打开弹窗，落在 MC 页）。

## 6. 性能与红线

继承总规格 §6 与 M2 全部渲染红线（零半透明、整数矩形、0.5 网格、drawImage ≤36、眼部 fillRect ≤30、绝不整屏 clearRect）。新增量：
- 猫 30 面 / 狗 24 面（无 overlay），≤36 预算内。
- 尾摆进指纹：静止时尾摆档不变则跳帧，不产生逐帧重绘；`mc-idle-budget` 测试加猫/狗用例（walk 与 idle 两档）。
- 皮肤加载全部在启动/导入时一次完成，绘制帧只查注册表（不变）。
- Rust 侧 `mc_*` 命令全部同步短路径（<1ms 级），不进感知/插件循环。

## 7. 错误处理

- 导入失败只回脱敏枚举，UI 映射中文（「文件太大（上限 64KB）」「不是有效的 PNG」「尺寸不对（需要 64×64 或 64×32）」「皮肤库已满（16 张）」）。
- 启动皮肤缺失 → 回退 builtin:default，宠物不空白不崩溃。
- index.json 损坏 → 重建（目录扫描恢复），删不掉的孤儿 png 随 delete 清理。
- `mc_get_skin` 路径穿越尝试 → `bad-id` 拒绝。
- 旧版本配置 / 手改 config.json 的非法 MC 字段（form 拼错等）→ serde 失败 → 整体 config 回默认（现有 load 失败回退行为，不新增迁移代码）。

## 8. 测试策略

- **Rust**：枚举三向序列化（旧参数 JSON → Parametric；MC JSON → Minecraft；字段名 snake_case 锁）；mcskin 纯函数（PNG 头解析、sha256、去重、上限、index 原子写、路径穿越拒绝、in-use 删除拒绝）；命令层薄壳不单测。
- **前端**：`avatarToView/FromView` 联合往返；猫/狗 `mcPose` 动作档位（对角步相位、play bow 区间、侧蜷、尾摆档）；`projectModel` 猫/狗黄金坐标（锚点/偶数顶点/镜像平行）；`mcDirtyBounds` 含尾摆外接盒；`mcFrameKey` 含 form/tailPhase 敏感性；跳帧预算（猫/狗 idle + walk）。
- **手工清单**（新建 `docs/plans/<日期>-mc-forms-m3-verification.md`）：导入/删除/重启持久化、删除在用被拒、猫狗动作观感（对角步/play bow/侧蜷/尾摆节奏）、奇数档眼部边缘、三档 CPU、首次领养双页签、`Ctrl+Alt+M` 无残留、旧 config 升级打开不丢形象。

## 9. 版本与 M4 衔接

- 版本预估 **1.9.0**（minor；执行第一个 commit 前与用户确认）。
- M4 衔接：`skin_id` 的 sha256 即同步内容键；`PUT /api/skin` 直接 PUT 现有 `<sha256>.png`；账号资料 `mc: { form, skinHash }` 由 `McAvatarConfig` 直接映射。本设计不为同步多做任何事。

## 10. 风险与缓解

- **untagged 枚举的静默错配**（MC JSON 意外匹配 Parametric）→ MC 分支必填字段与 Parametric 必填字段不相交，三向序列化测试锁死。
- **猫狗侧蜷/painter 穿模** → 盒偏移不旋转（只平移），同深度平手序维持 boxes 插入序；手工清单专项。
- **四足矮身材在 48 档位下偏小** → 接受物种差异；若观感差，档位微调在实施期评估（只调模型数值不动档位体系）。
- **皮肤库写坏** → index/png 双原子写 + 启动回退 builtin。
