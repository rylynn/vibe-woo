#!/usr/bin/env bash
# Vibe Pet 一键安装脚本（macOS）。
#
# 做三件事：补齐依赖（Xcode CLT / Rust / Node / pnpm）→ 构建打包 → 装入 /Applications。
# 幂等设计：已就绪的依赖直接跳过，可以安全地重复运行。
#
# 为什么需要 Rust：宠物后端是 Tauri（Rust）。首次编译较慢（5–15 分钟），
# 之后增量构建很快 —— 脚本会提示进度，不是卡住了。
#
# 用法：
#   bash scripts/install.sh                    # 安装依赖 → 构建 → 装入 /Applications
#   bash scripts/install.sh --build-only       # 只构建出 .app，不安装
#   bash scripts/install.sh --dev              # 只起开发模式（不打包）
#   bash scripts/install.sh --clone <git-url>  # 克隆到 ~/vibe-pet 后再安装
#   bash scripts/install.sh --skip-tests       # 跳过单元测试
#   bash scripts/install.sh --uninstall        # 从 /Applications 卸载
#   bash scripts/install.sh --uninstall --purge # 连配置与数据一起删除
#   bash scripts/install.sh --help

set -euo pipefail

# ---------- 参数 ----------
MODE="install"      # install | build-only | dev | uninstall
CLONE_URL=""
SKIP_TESTS=0
PURGE=0

# ---------- 输出 ----------
if [[ -t 1 ]]; then
  C_RESET=$'\033[0m'; C_DIM=$'\033[2m'; C_OK=$'\033[32m'
  C_WARN=$'\033[33m'; C_ERR=$'\033[31m'; C_BOLD=$'\033[1m'
else
  C_RESET=""; C_DIM=""; C_OK=""; C_WARN=""; C_ERR=""; C_BOLD=""
fi

say()  { printf '%s\n' "$*"; }
step() { printf '%s==>%s %s%s\n' "$C_BOLD" "$C_RESET" "$*"; }
ok()   { printf '  %s✓%s %s\n' "$C_OK" "$C_RESET" "$*"; }
warn() { printf '  %s!%s %s\n' "$C_WARN" "$C_RESET" "$*"; }
err()  { printf '%s✗%s %s\n' "$C_ERR" "$C_RESET" "$*" >&2; }
die()  { err "$*"; exit 1; }

usage() {
  # 打印文件头的注释块，遇到第一个非注释行即停（不用维护行号）
  awk 'NR == 1 { next } /^#/ { sub(/^# ?/, ""); print; next } { exit }' "$0"
  exit 0
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --build-only) MODE="build-only"; shift ;;
    --dev)        MODE="dev"; shift ;;
    --clone)      CLONE_URL="${2:-}"; [[ -n "$CLONE_URL" ]] || die "--clone 需要 git 仓库地址"; shift 2 ;;
    --skip-tests) SKIP_TESTS=1; shift ;;
    --uninstall)  MODE="uninstall"; shift ;;
    --purge)      PURGE=1; shift ;;
    -h|--help)    usage ;;
    *)            die "未知参数：$1（用 --help 查看用法）" ;;
  esac
done

# ---------- 版本比较：version_ge a b  →  a >= b ----------
version_ge() {
  local IFS=.
  local -a a=($1) b=($2)
  local i ai bi
  for i in 0 1 2; do
    ai=${a[$i]:-0}; bi=${b[$i]:-0}
    (( 10#$ai > 10#$bi )) && return 0
    (( 10#$ai < 10#$bi )) && return 1
  done
  return 0
}

# ---------- 0. 平台 ----------
[[ "$(uname -s)" == "Darwin" ]] || die "Vibe Pet 目前只支持 macOS（透明置顶窗依赖 macOS 私有 API 与 NSPanel）。"
ARCH="$(uname -m)"
case "$ARCH" in
  arm64|x86_64) ;;
  *) warn "未验证的架构：$ARCH，构建可能失败" ;;
esac

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# ---------- 1. 定位项目根目录 ----------
resolve_root() {
  local root
  root="$(dirname "$SCRIPT_DIR")"
  if [[ -f "$root/src-tauri/tauri.conf.json" && -f "$root/package.json" ]]; then
    printf '%s' "$root"
  fi
}

ROOT=""
if [[ -n "$CLONE_URL" ]]; then
  TARGET="$HOME/vibe-pet"
  step "克隆仓库到 $TARGET"
  command -v git >/dev/null 2>&1 || die "缺少 git，请先安装 Xcode 命令行工具"
  if [[ -d "$TARGET/.git" ]]; then
    ok "目录已存在，拉取最新代码"
    git -C "$TARGET" pull --ff-only || warn "拉取失败，沿用现有代码"
  else
    git clone "$CLONE_URL" "$TARGET"
  fi
  ROOT="$TARGET"
else
  ROOT="$(resolve_root || true)"
fi
[[ -n "$ROOT" && -d "$ROOT" ]] || die "找不到项目根目录：请在 Vibe Pet 仓库内运行本脚本，或使用 --clone <git-url>"
cd "$ROOT"
ok "项目目录：$ROOT"

# 从 tauri.conf.json 读 productName（.app 的名字）
APP_NAME="$(grep -m1 '"productName"' src-tauri/tauri.conf.json 2>/dev/null \
  | sed -E 's/.*"productName"[[:space:]]*:[[:space:]]*"([^"]+)".*/\1/' || true)"
[[ -n "$APP_NAME" ]] || APP_NAME="vibe-pet"
INSTALLED_APP="/Applications/${APP_NAME}.app"
CONFIG_DIR="$HOME/Library/Application Support/dev.vibepet.app"

# ---------- 卸载 ----------
uninstall() {
  step "卸载 Vibe Pet"
  if [[ -f "$ROOT/scripts/stop-pet.sh" ]]; then
    bash "$ROOT/scripts/stop-pet.sh" >/dev/null 2>&1 || true
  else
    pkill -f 'vibe-pet' >/dev/null 2>&1 || true
  fi
  if [[ -d "$INSTALLED_APP" ]]; then
    rm -rf "$INSTALLED_APP" && ok "已删除 $INSTALLED_APP"
  else
    warn "/Applications 中没有 $APP_NAME"
  fi
  if [[ $PURGE -eq 1 ]]; then
    rm -rf "$CONFIG_DIR" && ok "已删除配置与数据：$CONFIG_DIR"
  else
    say "  ${C_DIM}配置保留在：$CONFIG_DIR（加 --purge 可一起删除）${C_RESET}"
  fi
  ok "卸载完成"
  exit 0
}
[[ "$MODE" == "uninstall" ]] && uninstall

# ---------- 2. Xcode 命令行工具 ----------
step "检查 Xcode 命令行工具"
if ! xcode-select -p >/dev/null 2>&1; then
  warn "未安装，正在触发系统安装（会弹窗，点「安装」后等待）"
  xcode-select --install >/dev/null 2>&1 || true
  for _ in $(seq 1 60); do
    if xcode-select -p >/dev/null 2>&1; then break; fi
    sleep 5
  done
  xcode-select -p >/dev/null 2>&1 || die "Xcode 命令行工具未安装完成，请安装后重跑本脚本"
fi
ok "已就绪：$(xcode-select -p)"

# ---------- 3. Rust ----------
step "检查 Rust 工具链"
export PATH="$HOME/.cargo/bin:$PATH"
MIN_RUST="1.77"   # src-tauri/Cargo.toml: rust-version
if ! command -v cargo >/dev/null 2>&1; then
  warn "未安装，正在用 rustup 安装（约 1–2 分钟）"
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
  export PATH="$HOME/.cargo/bin:$PATH"
fi
if [[ -f "$HOME/.cargo/env" ]]; then
  # shellcheck disable=SC1091
  source "$HOME/.cargo/env"
fi
command -v cargo >/dev/null 2>&1 || die "Rust 安装后仍找不到 cargo，请重开终端再跑一次"
RUST_V="$(cargo --version | awk '{print $2}')"
if version_ge "$RUST_V" "$MIN_RUST"; then
  ok "cargo $RUST_V（要求 ≥ $MIN_RUST）"
else
  die "Rust 版本过低：$RUST_V（需要 ≥ $MIN_RUST）。请运行：rustup update"
fi

# ---------- 4. Node 与 pnpm ----------
step "检查 Node 与 pnpm"
MIN_NODE="18.0.0"
if ! command -v node >/dev/null 2>&1; then
  die "缺少 Node.js（需要 ≥ 18）。安装方式：
    brew install node        # 有 Homebrew 时
    或访问 https://nodejs.org 下载 LTS 版"
fi
NODE_V="$(node -v | sed 's/^v//')"
version_ge "$NODE_V" "$MIN_NODE" || die "Node 版本过低：v$NODE_V（需要 ≥ 18）"
ok "node v$NODE_V"

if ! command -v pnpm >/dev/null 2>&1; then
  warn "未安装 pnpm，正在安装"
  if command -v corepack >/dev/null 2>&1; then
    corepack enable >/dev/null 2>&1 || true
    corepack prepare pnpm@latest --activate >/dev/null 2>&1 || true
  fi
  if ! command -v pnpm >/dev/null 2>&1; then
    npm install -g pnpm >/dev/null 2>&1 || die "pnpm 安装失败，请手动执行：npm i -g pnpm"
  fi
fi
PNPM_V="$(pnpm -v)"
ok "pnpm $PNPM_V"

# ---------- 5. 前端依赖 ----------
step "安装前端依赖"
pnpm install
ok "依赖就绪"

# ---------- 6. 单元测试 ----------
if [[ $SKIP_TESTS -eq 1 ]]; then
  step "跳过单元测试（--skip-tests）"
else
  step "运行单元测试"
  pnpm test
  ok "测试通过"
fi

# ---------- 7. 开发模式 ----------
if [[ "$MODE" == "dev" ]]; then
  step "启动开发模式（Ctrl+C 结束）"
  say "  ${C_DIM}退出宠物：Ctrl+Alt+Cmd+Q，或另开终端跑 pnpm stop${C_RESET}"
  exec pnpm tauri dev
fi

# ---------- 8. 构建打包 ----------
step "构建并打包（首次编译 Rust 较慢，约 5–15 分钟，请耐心等待）"
pnpm tauri build
ok "构建完成"

APP_PATH="$(find src-tauri/target/release/bundle/macos -maxdepth 1 -name '*.app' -print -quit 2>/dev/null || true)"
[[ -n "$APP_PATH" && -d "$APP_PATH" ]] || die "没找到打包产物（src-tauri/target/release/bundle/macos/*.app）"
ok "产物：$(basename "$APP_PATH")"

# ---------- 9. 安装到 /Applications ----------
if [[ "$MODE" == "build-only" ]]; then
  step "--build-only：不安装"
  say "  应用已生成，可手动拷贝："
  say "    cp -R \"$(pwd)/$APP_PATH\" /Applications/"
  exit 0
fi

step "安装到 /Applications"
# 先停掉正在跑的宠物，否则旧进程会占着 .app，覆盖失败
if [[ -f "$ROOT/scripts/stop-pet.sh" ]]; then
  bash "$ROOT/scripts/stop-pet.sh" >/dev/null 2>&1 || true
else
  pkill -f 'vibe-pet' >/dev/null 2>&1 || true
fi

# ad-hoc 签名：未签名的自建应用会被 Gatekeeper 拦成「已损坏」
codesign --force --deep --sign - "$APP_PATH" >/dev/null 2>&1 \
  && ok "已 ad-hoc 签名（避免系统提示「已损坏」）" \
  || warn "签名失败，若打不开请右键应用 → 打开"

rm -rf "$INSTALLED_APP"
cp -R "$APP_PATH" "$INSTALLED_APP"
ok "已安装：$INSTALLED_APP"

# ---------- 完成 ----------
cat <<EOF

${C_OK}安装完成！${C_RESET}

  启动：      open -a "$APP_NAME"        ${C_DIM}（也可在「启动台」里点）${C_RESET}
  停止/退出： Ctrl+Alt+Cmd+Q            ${C_DIM}或托盘菜单 → 退出${C_RESET}
  强制停止：  pkill -9 -f vibe-pet      ${C_DIM}桌面点击异常时的最后手段${C_RESET}
  卸载：      bash scripts/install.sh --uninstall

  配置文件：  $CONFIG_DIR/config.json
  奖励数据：  $CONFIG_DIR/rewards.json  ${C_DIM}当日特效，隔天失效${C_RESET}

  常用操作：
    右键宠物      功能菜单（速记 / 每日提醒 / 好友 / 今日速记 / 设置 / 退出）
    Alt+Space     随时记一笔
    设置面板      人格、提醒、番茄工作法、AI 接入

  ${C_DIM}首次启动若被系统拦下：系统设置 → 隐私与安全性 → 仍要打开。${C_RESET}
EOF
