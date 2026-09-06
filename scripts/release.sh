#!/usr/bin/env bash
# Vibe Pet 一键发版（GitHub Release + 自动更新产物）。
#
# 把发版多步骤合并成一个脚本，版本号以 package.json 为准（真源）：
#   1. 校验：三处版本一致 / 当前版本有 ≤50 字更新摘要 / 工作区干净 / tag 未被占用 / gh 已登录
#   2. 私钥：minisign 更新签名私钥（环境变量或 ~/.vibe-pet/updater.key）
#   3. 测试：tsc + vitest + cargo test
#   4. 构建：pnpm tauri build --target universal-apple-darwin（aarch64 + x86_64 双架构）
#   5. 签名：ad-hoc 签名（避免下载后提示「已损坏」）；tauri 同时产出 minisign 更新签名（.sig）
#   6. 打包：hdiutil 打成 .dmg；生成 latest.json（updater 清单，发版期生成物，不入库）
#   7. 发布：gh release create vX.Y.Z 上传 .tar.gz / .sig / latest.json / .dmg
#
# 用法：
#   bash scripts/release.sh                完整发版
#   bash scripts/release.sh --check        只做校验，不构建不发布
#   bash scripts/release.sh --skip-tests   跳过测试（不建议）
#
# 依赖：git、gh（已登录）、pnpm、cargo、python3。
# 私钥绝不入库：放 ~/.vibe-pet/updater.key 或导出 TAURI_SIGNING_PRIVATE_KEY，
# 脚本只把它 cat 进环境变量，绝不回显内容。
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

# ---------- 2. 更新摘要：当前版本必须在 version-notes.json 里有 ≤50 字的非空摘要 ----------
# 这是升级气泡的文案源（升级后宠物只说这一句），缺了或太长都拒绝发版
python3 - "$V" <<'PY'
import json, sys
v = sys.argv[1]
notes = json.load(open('src-tauri/version-notes.json'))
if v not in notes or not notes[v].strip():
    print(f"✗ version-notes.json 缺 {v} 的非空摘要", file=sys.stderr)
    sys.exit(1)
n = notes[v].strip()
if len(n) > 50:
    print(f"✗ {v} 摘要超 50 字（{len(n)}）：{n}", file=sys.stderr)
    sys.exit(1)
print(f"✓ 摘要就绪：{n}")
PY

# ---------- 3. 工作区与 tag ----------
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

# ---------- 4. gh 可用 ----------
command -v gh >/dev/null 2>&1 || die "缺 gh 命令：brew install gh && gh auth login"
gh auth status >/dev/null 2>&1 || die "gh 未登录：gh auth login"
ok "gh 已登录（$(gh repo view --json nameWithOwner -q .nameWithOwner 2>/dev/null || echo '当前仓库')）"

# ---------- --check 到此为止 ----------
if [[ $CHECK_ONLY -eq 1 ]]; then
  ok "校验通过（--check 模式，不构建不发布）"
  exit 0
fi

# ---------- 5. 更新签名私钥（minisign，环境变量或本机文件，二选一） ----------
# 只 cat 进环境变量，绝不 echo / 落日志；若私钥带口令，还需自行导出 TAURI_SIGNING_PRIVATE_KEY_PASSWORD
if [[ -z "${TAURI_SIGNING_PRIVATE_KEY:-}" && -f "${HOME}/.vibe-pet/updater.key" ]]; then
  TAURI_SIGNING_PRIVATE_KEY="$(cat "${HOME}/.vibe-pet/updater.key")"
  export TAURI_SIGNING_PRIVATE_KEY
fi
if [[ -z "${TAURI_SIGNING_PRIVATE_KEY:-}" ]]; then
  die "缺更新签名私钥：导出 TAURI_SIGNING_PRIVATE_KEY 或把私钥放到 ~/.vibe-pet/updater.key"
fi
ok "更新签名私钥已就绪（内容不回显）"

# ---------- 6. 测试 ----------
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

# ---------- 7. universal 构建（aarch64 + x86_64 双架构，含 minisign 更新签名产物） ----------
# universal 需要两个架构的 Rust std，缺了 cargo 会在编译期报「can't find crate」
if ! rustup target list --installed 2>/dev/null | grep -q x86_64-apple-darwin; then
  warn "缺 x86_64-apple-darwin 目标：先跑 rustup target add x86_64-apple-darwin，否则 universal 构建会失败"
fi
step "构建 universal .app（双架构，首次编译较慢，约 5–15 分钟）"
pnpm tauri build --target universal-apple-darwin >/dev/null 2>&1
APP_PATH="$(find src-tauri/target/universal-apple-darwin/release/bundle/macos -maxdepth 1 -name '*.app' -print -quit)"
[[ -n "$APP_PATH" && -d "$APP_PATH" ]] || die "没找到构建产物（src-tauri/target/universal-apple-darwin/release/bundle/macos/*.app）"
ok "构建完成：$(basename "$APP_PATH")"

# 更新产物：.app.tar.gz + .sig 必须成对出现（bundle.createUpdaterArtifacts 的产出）
ART="src-tauri/target/universal-apple-darwin/release/bundle/macos/vibe-pet.app.tar.gz"
SIG="${ART}.sig"
if [[ ! -f "$ART" || ! -f "$SIG" ]]; then
  die "缺更新产物或 minisign 签名（bundle.createUpdaterArtifacts 未生效？）：${ART} / ${SIG}"
fi
ok "更新产物就绪：$(basename "$ART")（含 .sig）"

# ---------- 8. ad-hoc 签名 + 打 dmg ----------
codesign --force --deep --sign - "$APP_PATH" >/dev/null 2>&1 \
  && ok "已 ad-hoc 签名（避免下载后提示「已损坏」）" \
  || warn "签名失败，下载者首次打开需右键 → 打开"
DMG="dist/vibe-pet_${V}_universal.dmg"   # universal 包双架构通用，文件名不再区分本机架构
mkdir -p dist
rm -f "$DMG"
hdiutil create -volname "Vibe Pet" -srcfolder "$APP_PATH" -ov -format UDZO "$DMG" >/dev/null
ok "打包完成：${DMG}（$(du -h "$DMG" | cut -f1)）"

# ---------- 9. latest.json（updater 清单：两个 darwin 平台指向同一 universal 直链） ----------
# 发版期生成物，不提交仓库；URL 是匿名直链（仓库私有期匿名 404，公开后自动生效）
NOW=$(python3 -c "import datetime;print(datetime.datetime.now(datetime.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'))")
python3 - "$V" "$NOW" "$SIG" <<'PY'
import json, sys
v, now, sig_path = sys.argv[1:4]
sig = open(sig_path).read().strip()
url = "https://github.com/rylynn/vibe-woo/releases/latest/download/vibe-pet.app.tar.gz"
latest = {
    "version": v,
    "pub_date": now,
    "platforms": {
        "darwin-aarch64": {"signature": sig, "url": url},
        "darwin-x86_64": {"signature": sig, "url": url},
    },
}
open("latest.json", "w").write(json.dumps(latest, indent=2))
print("✓ latest.json 已生成（发版期生成物，不提交仓库）")
PY

# ---------- 10. 发布 GitHub Release（四件：更新包 + 签名 + 清单 + dmg） ----------
step "发布 ${TAG}"
# --target 钉在当前分支 HEAD：产物由此构建，tag 必须指向同一提交
gh release create "$TAG" --target "$BRANCH" \
  "$ART#vibe-pet.app.tar.gz" \
  "$SIG#vibe-pet.app.tar.gz.sig" \
  "latest.json#latest.json" \
  "$DMG#$(basename "$DMG")" \
  --title "$TAG" --generate-notes
ok "已发布：$(gh release view "$TAG" --json url -q .url)"
printf '  %s提示%s：仓库公开后自动更新检查才生效（私有期匿名检查 404 静默失败）；下载者首次打开若被拦，右键应用 → 打开（自建应用未公证，属正常现象）。\n' "$C_WARN" "$C_RESET"
