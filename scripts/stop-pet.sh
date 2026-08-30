#!/usr/bin/env bash
# 强制停止 vibe-pet 及其开发服务器。
#
# 存在理由：宠物是全屏透明置顶窗口。如果穿透逻辑出问题导致桌面点击被拦截，
# 托盘也可能点不到。此脚本是不依赖任何 GUI 的最后手段 —— 曾经因为缺少它，
# 一次故障导致只能重启电脑。
#
# 同时清理占用 1420 端口的 vite：残留的 vite 会让 pnpm tauri dev 直接
# 失败于 "Port 1420 is already in use"。
#
# 用法：
#   pnpm stop

set -uo pipefail

killed_any=0

# --- 1. 宠物进程 ---
if pgrep -f 'vibe-pet' > /dev/null; then
  echo "停止 vibe-pet："
  pgrep -lf 'vibe-pet'
  pkill -f 'vibe-pet' || true
  sleep 1
  if pgrep -f 'vibe-pet' > /dev/null; then
    echo "  常规终止无效，强制 kill -9"
    pkill -9 -f 'vibe-pet' || true
    sleep 1
  fi
  killed_any=1
else
  echo "没有正在运行的 vibe-pet"
fi

# --- 2. 占用 1420 端口的 vite ---
port_pids=$(lsof -ti:1420 2>/dev/null || true)
if [[ -n "$port_pids" ]]; then
  echo "释放 1420 端口（PID: $(echo "$port_pids" | tr '\n' ' ')）"
  # shellcheck disable=SC2086
  kill $port_pids 2>/dev/null || true
  sleep 1
  port_pids=$(lsof -ti:1420 2>/dev/null || true)
  if [[ -n "$port_pids" ]]; then
    # shellcheck disable=SC2086
    kill -9 $port_pids 2>/dev/null || true
    sleep 1
  fi
  killed_any=1
else
  echo "1420 端口空闲"
fi

# --- 3. 结果校验 ---
fail=0
if pgrep -f 'vibe-pet' > /dev/null; then
  echo "错误：仍有 vibe-pet 存活，请手动执行 pkill -9 -f vibe-pet"
  fail=1
fi
if lsof -ti:1420 > /dev/null 2>&1; then
  echo "错误：1420 仍被占用，请手动执行 lsof -ti:1420 | xargs kill -9"
  fail=1
fi
[[ $fail -eq 1 ]] && exit 1

if [[ $killed_any -eq 1 ]]; then
  echo "已全部停止，可以运行 pnpm tauri dev"
else
  echo "环境本来就是干净的"
fi
