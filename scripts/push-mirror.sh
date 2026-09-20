#!/usr/bin/env bash
# 推送更新镜像：把更新包字节与 latest.json 发布到同步服务的镜像端点。
#
# 为什么：很多网络到不了 GitHub，客户端 updater 是「镜像优先、GitHub 兜底」。
# GitHub Releases 仍是真源 —— 本脚本只是搬运工：release.sh 发版后自动调用，
# 镜像当时不可用时也可事后单独补推（服务端只保留最新一版，覆盖式存储）。
#
# 用法：
#   bash scripts/push-mirror.sh                     推 GitHub 最新 release（gh 下载制品）
#   bash scripts/push-mirror.sh 1.5.0               推指定版本
#   bash scripts/push-mirror.sh 1.5.0 --artifact <tar.gz> --manifest <latest.json>
#                                                    直接用本地文件（release.sh 复用此路径）
#   bash scripts/push-mirror.sh --skip-verify …     跳过回读校验（不建议）
#
# 凭据（环境变量优先，其次 ~/.vibe-pet/ 下文件首行；绝不入库、不回显）：
#   MIRROR_BASE_URL    ~/.vibe-pet/mirror.txt             镜像 base（含 /api，如 http://1.2.3.4:8787/api）
#   MIRROR_ADMIN_USER  ~/.vibe-pet/mirror-admin-user.txt  admin 账号（同步服务 ADMIN_USER）
#   MIRROR_ADMIN_PASS  ~/.vibe-pet/mirror-admin-pass.txt  admin 口令（同步服务 ADMIN_PASS）
#
# 顺序纪律：先传包字节、后发 manifest —— 服务端强校验（客户端下载阶段不做
# endpoint 回退，清单里承诺的版本必须当下就能下载到），脚本与服务端保持同序。
set -euo pipefail

cd "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/.."

if [[ -t 1 ]]; then
  C_RESET=$'\033[0m'; C_OK=$'\033[32m'; C_WARN=$'\033[33m'; C_ERR=$'\033[31m'; C_BOLD=$'\033[1m'
else
  C_RESET=""; C_OK=""; C_WARN=""; C_ERR=""; C_BOLD=""
fi
step() { printf '%s==>%s %s\n' "$C_BOLD" "$C_RESET" "$*"; }
ok()   { printf '  %s✓%s %s\n' "$C_OK" "$C_RESET" "$*"; }
warn() { printf '  %s!%s %s\n' "$C_WARN" "$C_RESET" "$*"; }
die()  { printf '%s✗%s %s\n' "$C_ERR" "$C_RESET" "$*" >&2; exit 1; }

# 环境变量优先，其次 ~/.vibe-pet/ 下文件首行（与 release.sh 的 read_secret 同惯例）
read_secret() {  # read_secret <环境变量当前值> <fallback文件>
  local val="$1" file_path="$2"
  if [[ -n "$val" ]]; then printf '%s' "$val"
  elif [[ -f "$file_path" ]]; then head -n 1 "$file_path"
  fi
}

V=""
ART=""
MANIFEST=""
SKIP_VERIFY=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --artifact)  ART="$2"; shift 2 ;;
    --manifest)  MANIFEST="$2"; shift 2 ;;
    --skip-verify) SKIP_VERIFY=1; shift ;;
    -h|--help)   awk 'NR == 1 { next } /^#/ { sub(/^# ?/, ""); print; next } { exit }' "$0"; exit 0 ;;
    *)           V="$1"; shift ;;
  esac
done

# ---------- 凭据 ----------
MIRROR_BASE_URL="$(read_secret "${MIRROR_BASE_URL:-}" "${HOME}/.vibe-pet/mirror.txt")"
MIRROR_ADMIN_USER="$(read_secret "${MIRROR_ADMIN_USER:-}" "${HOME}/.vibe-pet/mirror-admin-user.txt")"
MIRROR_ADMIN_PASS="$(read_secret "${MIRROR_ADMIN_PASS:-}" "${HOME}/.vibe-pet/mirror-admin-pass.txt")"
[[ -n "$MIRROR_BASE_URL" && -n "$MIRROR_ADMIN_USER" && -n "$MIRROR_ADMIN_PASS" ]] \
  || die "镜像凭据不全：需要 MIRROR_BASE_URL / MIRROR_ADMIN_USER / MIRROR_ADMIN_PASS（环境变量或 ~/.vibe-pet/mirror*.txt）"
MIRROR_BASE_URL="${MIRROR_BASE_URL%/}"
ok "镜像目标：${MIRROR_BASE_URL}（凭据不回显）"

# ---------- 版本与制品 ----------
TMPDIR_DL=""
if [[ -z "$V" ]]; then
  command -v gh >/dev/null 2>&1 || die "缺 gh 命令，无法确定最新版本；显式传版本号：bash scripts/push-mirror.sh X.Y.Z"
  V="$(gh release view --json tagName -q .tagName | sed 's/^v//')" || die "读不到最新 release（gh release view）"
fi
[[ "$V" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "版本号需为 X.Y.Z 三段数字：${V}"

if [[ -z "$ART" || -z "$MANIFEST" ]]; then
  command -v gh >/dev/null 2>&1 || die "缺 gh 命令且未指定 --artifact/--manifest"
  TMPDIR_DL="$(mktemp -d)"
  step "从 GitHub release v${V} 下载制品"
  gh release download "v${V}" -p "vibe-pet.app.tar.gz" -p "latest.json" -D "$TMPDIR_DL" \
    || die "下载失败：确认 v${V} 已发布且含 vibe-pet.app.tar.gz 与 latest.json"
  ART="${ART:-${TMPDIR_DL}/vibe-pet.app.tar.gz}"
  MANIFEST="${MANIFEST:-${TMPDIR_DL}/latest.json}"
fi
[[ -f "$ART" && -f "$MANIFEST" ]] || die "制品缺失：${ART} / ${MANIFEST}"
[[ "$(python3 -c "import json;print(json.load(open('$MANIFEST'))['version'])")" == "$V" ]] \
  || die "manifest 版本与目标版本不一致（先核对 latest.json）"
ok "制品就绪：$(basename "$ART")（$(du -h "$ART" | cut -f1)）+ latest.json（v${V}）"

# ---------- admin 登录 ----------
LOGIN_BODY="$(python3 -c 'import json,sys;print(json.dumps({"user":sys.argv[1],"pass":sys.argv[2]}))' \
  "$MIRROR_ADMIN_USER" "$MIRROR_ADMIN_PASS")"
TOKEN="$(curl -sf -X POST "${MIRROR_BASE_URL}/admin/login" \
  -H "Content-Type: application/json" --max-time 15 -d "$LOGIN_BODY" \
  | python3 -c 'import json,sys;print(json.load(sys.stdin).get("token",""))' 2>/dev/null)" \
  || die "镜像 admin 登录失败（检查 MIRROR_ADMIN_USER/PASS 与服务端 ADMIN_* 是否一致）"
[[ -n "$TOKEN" ]] || die "镜像 admin 登录失败（未拿到 token；服务端可能未配置 ADMIN_*）"
ok "admin 登录成功"

# ---------- 先包后单 ----------
step "上传更新包字节（v${V}）"
curl -sf -X POST "${MIRROR_BASE_URL}/admin/update/pkg?v=${V}" \
  -H "Authorization: Bearer ${TOKEN}" \
  -H "Content-Type: application/octet-stream" \
  --data-binary @"$ART" --max-time 600 --retry 2 -o /dev/null \
  || die "包上传失败（服务端单包上限 24MB；自托管检查磁盘空间）"
ok "包已上传"

step "发布 manifest（v${V}）"
curl -sf -X POST "${MIRROR_BASE_URL}/admin/update/manifest" \
  -H "Authorization: Bearer ${TOKEN}" \
  -H "Content-Type: application/json" \
  --data-binary @"$MANIFEST" --max-time 30 -o /dev/null \
  || die "manifest 发布失败"
ok "manifest 已发布"

# ---------- 回读校验（默认必做：字节级确认，源站自下载秒级完成） ----------
if [[ $SKIP_VERIFY -eq 1 ]]; then
  warn "已跳过回读校验（--skip-verify）"
else
  step "回读校验"
  python3 - "$V" "${MIRROR_BASE_URL}/update/latest" <<'PY' 2>/dev/null \
    || die "回读校验失败：latest 版本或下载地址不对"
import json, sys, urllib.request
v, url = sys.argv[1], sys.argv[2]
m = json.load(urllib.request.urlopen(url, timeout=15))
assert m["version"] == v, f"latest 版本 {m['version']} != {v}"
for name, p in m["platforms"].items():
    assert f"/update/pkg?v={v}" in p["url"], f"{name} 的下载地址未重写：{p['url']}"
print(f"latest v{v} 双平台地址均已重写为本服务")
PY
  LOCAL_SHA="$(shasum -a 256 "$ART" | cut -d' ' -f1)"
  REMOTE_SHA="$(curl -sf "${MIRROR_BASE_URL}/update/pkg?v=${V}" --max-time 600 | shasum -a 256 | cut -d' ' -f1)"
  [[ "$LOCAL_SHA" == "$REMOTE_SHA" ]] || die "包字节不一致（本地 ${LOCAL_SHA:0:12}… 远端 ${REMOTE_SHA:0:12}…），镜像可能损坏，请重推"
  ok "sha256 字节级一致（${LOCAL_SHA:0:12}…）"
fi

[[ -n "$TMPDIR_DL" ]] && rm -rf "$TMPDIR_DL"
ok "镜像同步完成：${MIRROR_BASE_URL}/update/latest"
