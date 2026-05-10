#!/bin/bash
# =============================================================================
# context-monitor.sh — token使用率监控 + 自动压缩触发器
# =============================================================================
# 路径: ~/.openclaw/skills/brain-v1.1.9/scripts/context-monitor.sh
# 功能: 监控当前会话token使用率，≥THRESHOLD%时自动触发context-compressor.js
#       并将压缩结果摘要写入工作缓冲区
# 依赖: ~/.openclaw/workspace/context-compressor.js
#       ~/.openclaw/workspace/memory/工作缓冲区.md
# =============================================================================

set -euo pipefail

# -------------------------- 配置 --------------------------
THRESHOLD="${CONTEXT_THRESHOLD:-80}"
INTERVAL="${CONTEXT_INTERVAL:-300}"
CONTEXT_WINDOW="${CONTEXT_WINDOW:-200000}"
COMPRESSOR="${COMPRESSOR:-${HOME}/.openclaw/workspace/context-compressor.js}"
SESSION_INDEX="${HOME}/.openclaw/agents/main/sessions/sessions.json"
SESSION_DIR="${HOME}/.openclaw/agents/main/sessions"
WORK_BUFFER_DIR="${HOME}/.openclaw/workspace"

# -------------------------- 日志 --------------------------
log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" >&2; }

# -------------------------- token估算（python，跨平台） --------------------------
estimate_tokens() {
  python3 -c "
import sys
text = sys.stdin.read()
chinese = sum(1 for c in text if '\u4e00' <= c <= '\u9fff')
english = len(text) - chinese
print(chinese * 2 + int(english * 1.3))
" <<EOF
$1
EOF
}

# -------------------------- 获取当前会话文件 --------------------------
get_current_session_file() {
  if [[ ! -f "$SESSION_INDEX" ]]; then
    return 1
  fi
  python3 -c "
import json, sys
try:
    d = json.load(open('$SESSION_INDEX'))
    vals = list(d.values())
    for v in vals:
        if isinstance(v, dict) and 'sessionFile' in v:
            print(v['sessionFile'])
            sys.exit(0)
    print(list(vals[0].values())[0] if vals else '')
except Exception:
    sys.exit(1)
" 2>/dev/null || echo ""
}

# -------------------------- 扫描会话总token --------------------------
scan_session_tokens() {
  local session_file="$1"
  if [[ ! -f "$session_file" ]]; then
    echo 0
    return
  fi
  python3 -c "
import json, sys, os

text_blocks = []
with open('$session_file') as f:
    for line in f:
        line = line.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
            content = msg.get('content') or ''
            text_blocks.append(content)
        except Exception:
            pass

all_text = '\n'.join(text_blocks)
chinese = sum(1 for c in all_text if '\u4e00' <= c <= '\u9fff')
english = len(all_text) - chinese
print(chinese * 2 + int(english * 1.3))
" 2>/dev/null || echo 0
}

# -------------------------- 计算使用率 --------------------------
calc_usage() {
  local tokens=$1
  python3 -c "print(int($tokens * 100 / $CONTEXT_WINDOW))"
}

# -------------------------- 工作缓冲区路径 --------------------------
get_work_buffer() {
  find "$WORK_BUFFER_DIR" -name "工作缓冲区.md" -type f 2>/dev/null | head -1 || echo ""
}

# -------------------------- 触发压缩 --------------------------
trigger_compress() {
  local session_file="$1"
  local session_id
  session_id=$(basename "$session_file" '.jsonl')

  log "⚡ Triggering compressor for session: ${session_id:0:8}"

  local result original_tokens compressed_tokens saved_tokens
  result=$(node "$COMPRESSOR" compress "$session_id" 2>&1) || {
    log "❌ Compressor failed: $result"
    return 1
  }

  # 提取数字
  original_tokens=$(echo "$result" | grep -oP '^\d+' | head -1 || echo "")
  compressed_tokens=$(echo "$result" | grep -oP '(?<=→ )\d+' | head -1 || echo "")
  saved_tokens=$(( original_tokens - compressed_tokens ))

  local buffer
  buffer=$(get_work_buffer)
  if [[ -n "$buffer" ]]; then
    {
      echo ""
      echo "## 🔬 上下文压缩报告 — $(date '+%Y-%m-%d %H:%M:%S')"
      echo ""
      echo "| 指标 | 值 |"
      echo "|------|----|"
      echo "| Session | \`${session_id:0:8}\` |"
      echo "| 压缩前 | ~${original_tokens} tokens |"
      echo "| 压缩后 | ~${compressed_tokens} tokens |"
      echo "| 节省 | ~${saved_tokens} tokens |"
      echo ""
      echo "```"
      echo "$result"
      echo "```"
    } >> "$buffer"
  fi

  log "✅ Compression done — saved ~${saved_tokens} tokens"
  return 0
}

# -------------------------- 状态输出 --------------------------
status() {
  local session_file
  session_file=$(get_current_session_file)
  if [[ -z "$session_file" ]]; then
    log "No active session"
    return
  fi

  local tokens usage
  tokens=$(scan_session_tokens "$session_file")
  usage=$(calc_usage "$tokens")
  local sid
  sid=$(basename "$session_file" '.jsonl')

  log "📊 Session: ${sid:0:8}"
  log "📊 Tokens: ~$tokens / $CONTEXT_WINDOW"
  log "📊 Usage:  ${usage}% (threshold: ${THRESHOLD}%)"

  if [[ $usage -ge $THRESHOLD ]]; then
    log "🚨 ${usage}% ≥ ${THRESHOLD}% — ACTION NEEDED"
  else
    log "✅ ${usage}% < ${THRESHOLD}% — OK"
  fi
}

# -------------------------- 主循环 --------------------------
monitor() {
  log "🚀 Context Monitor started (threshold=${THRESHOLD}%, interval=${INTERVAL}s, window=${CONTEXT_WINDOW})"

  # 单次模式
  if [[ "${1:-}" == "once" ]]; then
    local session_file
    session_file=$(get_current_session_file)
    if [[ -z "$session_file" ]]; then
      log "❌ No active session found"
      exit 1
    fi

    local tokens usage_pct
    tokens=$(scan_session_tokens "$session_file")
    usage_pct=$(calc_usage "$tokens")
    local sid
    sid=$(basename "$session_file" '.jsonl')
    log "📊 Session ${sid:0:8}: ~${tokens} tokens, ${usage_pct}% used"

    if [[ $usage_pct -ge $THRESHOLD ]]; then
      log "🚨 ${usage_pct}% ≥ ${THRESHOLD}% threshold — triggering compression"
      trigger_compress "$session_file"
    else
      log "✅ ${usage_pct}% < ${THRESHOLD}% — no action needed"
    fi
    exit 0
  fi

  # 持续监控模式
  while true; do
    local session_file
    session_file=$(get_current_session_file)
    if [[ -n "$session_file" && -f "$session_file" ]]; then
      local tokens usage_pct
      tokens=$(scan_session_tokens "$session_file")
      usage_pct=$(calc_usage "$tokens")

      if [[ $usage_pct -ge $THRESHOLD ]]; then
        log "🚨 ${usage_pct}% ≥ ${THRESHOLD}% — triggering compression"
        trigger_compress "$session_file"
        log "⏳ Cooldown 60s..."
        sleep 60
      fi
    fi
    sleep "$INTERVAL"
  done
}

# -------------------------- 入口 --------------------------
case "${1:-}" in
  once)  monitor once ;;
  status) status ;;
  *)    monitor "$@" ;;
esac

echo "✅ 语法验证通过"