#!/bin/bash
# auto-match-capsule.sh
# 会话开始时自动匹配胶囊
# 调用方式: bash auto-match-capsule.sh "<任务描述>"
# 触发时机: BOOTSTRAP.md 启动序列中调用

set -e

TASK="${1:-}"
LOG_FILE="$HOME/.openclaw/workspace/memory/watchdog-log.md"

log() {
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] [auto-match-capsule] $1" >> "$LOG_FILE"
}

if [ -z "$TASK" ]; then
  # 无任务参数时，尝试从工作缓冲区获取当前任务
  WORKING_BUFFER="$HOME/.openclaw/workspace/memory/工作缓冲区.md"
  if [ -f "$WORKING_BUFFER" ]; then
    TASK=$(grep -A5 "## 📋 当前进行中" "$WORKING_BUFFER" 2>/dev/null | grep "###" | head -1 | sed 's/^### //')
    if [ -z "$TASK" ]; then
      log "无法从工作缓冲区获取任务，跳过匹配"
      exit 0
    fi
  else
    log "无任务描述且工作缓冲区不存在，跳过匹配"
    exit 0
  fi
fi

log "开始胶囊匹配，任务: $TASK"

# 调用 match-capsule.sh
bash ~/.openclaw/skills/brain-v1.1.9/scripts/match-capsule.sh "$TASK"

log "胶囊匹配完成"