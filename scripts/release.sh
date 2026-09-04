#!/usr/bin/env bash
# Vibe Pet 一键发版（GitHub Release）。
#
# 把发版多步骤合并成一个脚本，版本号以 package.json 为准（真源）：
#   1. 校验：三处版本一致 / 工作区干净 / tag 未被占用 / gh 已登录
#   2. 测试：tsc + vitest + cargo test
#   3. 构建：pnpm tauri build（产出 .app）
#   4. 签名：ad-hoc 签名（避免下载后提示「已损坏」）
#   5. 打包：hdiutil 打成 .dmg（文件名带版本与架构）
#   6. 发布：gh release create vX.Y.Z 上传 .dmg
#
# 用法：
#   bash scripts/release.sh                完整发版
#   bash scripts/release.sh --check        只做校验，不构建不发布
#   bash scripts/release.sh --skip-tests   跳过测试（不建议）
#
# 依赖：git、gh（已登录）、pnpm、cargo、python3。
# 注意：发的是当前 HEAD —— 跑之前先 commit + push，工作区有未提交改动会被拒绝。
set -euo pipefail

cd "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/.."

# macOS 自带 bash 3.2 的 UTF-8 陷阱：变量后面紧跟中文/全角字符时一律写 ${VAR}
if [[ -t 1 ]]; then
  C_RESET=$'\033[0m'; C_OK=$'\033[32m'; C_WARN=$'\033[33m'; C_ERR=$'\033[31m'; C_BOLD=$'\033[1m'
else
  C_RESET=""; C_OK=""; C_WARN=""; C_ERR=""; C_BOLD=""
fi
step() { printf '%s==>%s %s\n' "$C_BOLD" "$C_RESET" "$*"; }
ok()   { printf '  %s✓%s %s\n' "$C_OK" "$C_RESET" "$*"; }
warn() { printf '  %s!%s %s\n' "$C_WARN" "$C_RESET" "$*"; }
die()  { printf '%s✗%s %s\n' "$C_ERR" "$C_RESET" "$*" >&2; exit 1; }

CHECK_ONLY=0
SKIP_TESTS=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --check)      CHECK_ONLY=1; shift ;;
    --skip-tests) SKIP_TESTS=1; shift ;;
    -h|--help)    awk 'NR == 1 { next } /^#/ { sub(/^# ?/, ""); print; next } { exit }' "$0"; exit 0 ;;
    *)            die "未知参数：$1（用 --help 查看用法）" ;;
  esac
done

# ---------- 1. 版本：package.json 为真源，三处必须一致 ----------
V=$(python3 -c "import json;print(json.load(open('package.json'))['version'])") \
  || die "读不到 package.json 的 version"
V_CONF=$(python3 -c "import json;print(json.load(open('src-tauri/tauri.conf.json'))['version'])")
V_CARGO=$(sed -n 's/^version *= *"\(.*\)"/\1/p' src-tauri/Cargo.toml | head -1)
if [[ "$V" != "$V_CONF" || "$V" != "$V_CARGO" ]]; then
  die "三处版本不一致：package=${V} tauri.conf=${V_CONF} cargo=${V_CARGO}（合入规则：三处一起改）"
fi
ok "版本 ${V}（package.json 为真源，三处一致）"
TAG="v${V}"

# ---------- 2. 工作区与 tag ----------
if [[ -n "$(git status --porcelain --untracked-files=no)" ]]; then
  die "工作区有未提交改动 —— 发版必须基于干净的提交，先 commit 再跑"
fi
if [[ -n "$(git status --porcelain | grep '^??')" ]]; then
  warn "存在未跟踪文件（不影响构建，但请确认不需要提交）："
  git status --porcelain | grep '^??' | sed 's/^/      /'
fi
if git rev-parse -q --verify "refs/tags/${TAG}" >/dev/null; then
  die "tag ${TAG} 已存在 —— 这个版本发过了？改版本号再跑"
fi
BRANCH=$(git rev-parse --abbrev-ref HEAD)
if ! git rev-parse -q --verify '@{upstream}' >/dev/null 2>&1; then
  die "当前分支 ${BRANCH} 没有对应的远程分支，先 git push -u origin ${BRANCH}"
fi
AHEAD=$(git rev-list --count '@{upstream}..HEAD')
if [[ "$AHEAD" != "0" ]]; then
  die "当前分支领先远程 ${AHEAD} 个提交 —— Release 必须指向远程存在的提交，先 git push"
fi
ok "工作区干净，${BRANCH} 已与远程同步，${TAG} 未被占用"

# ---------- 3. gh 可用 ----------
command -v gh >/dev/null 2>&1 || die "缺 gh 命令：brew install gh && gh auth login"
gh auth status >/dev/null 2>&1 || die "gh 未登录：gh auth login"
ok "gh 已登录（$(gh repo view --json nameWithOwner -q .nameWithOwner 2>/dev/null || echo '当前仓库')）"

# ---------- --check 到此为止 ----------
if [[ $CHECK_ONLY -eq 1 ]]; then
  ok "校验通过（--check 模式，不构建不发布）"
  exit 0
fi

# ---------- 4. 测试 ----------
export PATH="$HOME/.cargo/bin:$PATH"
if [[ $SKIP_TESTS -eq 1 ]]; then
  warn "跳过测试（--skip-tests）"
else
  step "运行测试（tsc / vitest / cargo test）"
  pnpm build >/dev/null 2>&1   # tsc --noEmit && vite build，构建链路一并验证
  ok "tsc + 前端构建通过"
  pnpm test >/dev/null 2>&1
  ok "vitest 通过"
  (cd src-tauri && cargo test --quiet) >/dev/null 2>&1
  ok "cargo test 通过"
fi

# ---------- 5. 构建 ----------
step "构建 .app（首次编译较慢，约 5–15 分钟）"
pnpm tauri build >/dev/null 2>&1
APP_PATH="$(find src-tauri/target/release/bundle/macos -maxdepth 1 -name '*.app' -print -quit)"
[[ -n "$APP_PATH" && -d "$APP_PATH" ]] || die "没找到构建产物（src-tauri/target/release/bundle/macos/*.app）"
ok "构建完成：$(basename "$APP_PATH")"

# ---------- 6. ad-hoc 签名 + 打 dmg ----------
codesign --force --deep --sign - "$APP_PATH" >/dev/null 2>&1 \
  && ok "已 ad-hoc 签名（避免下载后提示「已损坏」）" \
  || warn "签名失败，下载者首次打开需右键 → 打开"
ARCH=$(uname -m)
DMG="dist/vibe-pet_${V}_${ARCH}.dmg"
mkdir -p dist
rm -f "$DMG"
hdiutil create -volname "Vibe Pet" -srcfolder "$APP_PATH" -ov -format UDZO "$DMG" >/dev/null
ok "打包完成：${DMG}（$(du -h "$DMG" | cut -f1)）"

# ---------- 7. 发布 GitHub Release ----------
step "发布 ${TAG}"
gh release create "$TAG" "$DMG#$(basename "$DMG")" \
  --title "$TAG" --generate-notes
ok "已发布：$(gh release view "$TAG" --json url -q .url)"
printf '  %s提示%s：下载者首次打开若被拦，右键应用 → 打开（自建应用未公证，属正常现象）。\n' "$C_WARN" "$C_RESET"
