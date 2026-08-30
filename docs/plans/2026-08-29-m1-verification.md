## 11. M1 验证结果

日期：2026-08-29

### 四条硬风险验证（人工实测）

| # | 验证项 | 结果 | 说明 |
|---|---|---|---|
| ① | 点宠物不抢编辑器焦点 | **通过** | 点宠物后立即敲字，字符正常进入 Cursor，文本光标未丢失 |
| ② | 宠物外的透明区域点击穿透 | **通过** | 可正常点选下层编辑器的代码与按钮 |
| ③ | 辉光不形成隐形墙 | **通过** | 穿透改由窗口层按包围盒控制，辉光位于包围盒外，天然穿透 |
| ④ | 空闲 CPU < 1% | **未通过** | release 待机实测约 9–12%，详见设计文档 5.2.1 |

其他：拖动跟手、松手停住、单实例、右键菜单退出，均通过。

**结论**：架构层面的三个硬风险（透明窗口、不抢焦点、穿透）全部成立，方案无需重新设计。CPU 指标未达标，作为已知问题遗留至 M2 优先处理。

### 过程中发现并修复的严重缺陷

**1. 桌面点击被完全锁死（最严重）**

症状：点击宠物后，整个桌面的点击全部失效，且托盘无法退出，用户只能重启电脑。

根因（诊断日志确认）：webview 漏收 `pointerup`（macOS nonactivating panel 的行为），前端 `dragging` 永久卡住 → `lock` 永久为 true → 窗口永久接管鼠标。

修复采用四层防御，任一层失效都不会锁死桌面：
- 前端 `pointermove` 检测 `buttons === 0` 自动结束拖动，不依赖 `pointerup`
- Rust 用系统 `NSEvent.pressedMouseButtons` 否决前端 lock
- Rust 对 lock 施加 8 秒硬超时
- canvas 设 `pointer-events: none`，避免 webview 先吞掉点击

决策逻辑已提取至 `passthrough` 模块，8 个单元测试覆盖。

**2. 「alpha=0 自动穿透」是错误认知**

曾据一篇博客的说法删除原有穿透方案，导致上述锁死。该说法对 WKWebView 不成立：hit-test 只看 DOM 元素矩形，不看绘制内容 alpha。**教训：不应用二手资料推翻已验证的设计决策。**

**3. 退出通道单点故障**

托盘图标未设置却被判断为「M1 可接受」，而窗口 `closable:false` 且不在 Dock/Cmd+Tab，托盘是唯一图形出口。现有四重退出通道，详见 3.1.2。

**4. 测试存在重大盲区**

代码审查通过注入 `globalAlpha=0.02` 与 `shadowBlur` 两个 mutation，发现当时 35 个测试全部通过 —— 即设计文档花整节禁止的失败模式毫无防护。已补齐，并实测两个 mutation 均能被捕获。

### 环境相关记录

- Rust 工具链：本机已有 rustup 但未配置默认 toolchain，`rustup default stable` 即可
- cargo 不在默认 PATH，需 `export PATH="$HOME/.cargo/bin:$PATH"`
- pnpm 11 需在 `pnpm-workspace.yaml` 中用 `allowBuilds: {esbuild: true}` 放行构建脚本
- `tauri-nspanel` v2.1 的 API 签名与计划一致；`setAutorecalculatesTouchBar:` 在无 Touch Bar 的机器上不存在，需先 `respondsToSelector:` 探测
- 诊断时必须确保 vite 在运行，否则 webview 白屏、前端 JS 完全不执行，会得出错误结论
