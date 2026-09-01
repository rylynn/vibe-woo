#!/bin/sh
# 采样 vibe-pet 相关进程的 CPU 占用，输出一段时间内的均值。
# 用法: scripts/cpu-sample.sh [秒数] [标签]
#   秒数: 采样时长，默认 60
#   标签: 输出前缀，默认 "sample"
#
# 统计口径：vibe-pet 主进程 + 全部 CPU > 0.3% 的 WebKit WebContent/GPU
# XPC 进程（vibe-pet 的 WebKit 子进程 ppid=1，无法靠父子关系精确归属，
# 以非零 CPU 的 WebKit 进程为对照集；其他空闲应用的 WebKit 进程为 0% 不计入）。

set -eu

DURATION="${1:-60}"
LABEL="${2:-sample}"

MAIN_PID=$(pgrep -x "vibe-pet" | head -1)
if [ -z "$MAIN_PID" ]; then
  echo "错误：vibe-pet 未在运行" >&2
  exit 1
fi

echo "[$LABEL] 主进程 pid=$MAIN_PID，采样 ${DURATION}s，间隔 1s ..."

i=0
while [ "$i" -lt "$DURATION" ]; do
  ps -eo pid,%cpu,comm | awk -v main="$MAIN_PID" '
    $1 == main { print $1","$2",vibe-pet(main)"; next }
    /WebKit\.WebContent|WebKit\.GPU/ && $2+0 > 0.3 { print $1","$2","$3 }
  '
  i=$((i + 1))
  sleep 1
done | awk -F, -v label="$LABEL" -v dur="$DURATION" '
  {
    sum[$3] += $2
    cnt[$3] += 1
    pid[$3] = $1
  }
  END {
    print ""
    print "[" label "] ===== " dur "s 平均 CPU ====="
    total = 0
    for (k in sum) {
      avg = sum[k] / cnt[k]
      if (avg > 0.05) {
        printf "  %-28s avg=%.2f%%  (pid=%s)\n", k, avg, pid[k]
        total += avg
      }
    }
    printf "[" label "] 相关进程合计: %.2f%%\n", total
  }
'
