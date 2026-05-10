#!/bin/bash
# auto-create-capsule.sh
# 任务成功后自动创建胶囊
# 调用方式: bash auto-create-capsule.sh
# 触发时机: cron 定期扫描或任务完成后调用

set -e

WORKING_BUFFER="$HOME/.openclaw/workspace/memory/工作缓冲区.md"
LOG_FILE="$HOME/.openclaw/workspace/memory/watchdog-log.md"
CAPSULES_DIR="$HOME/.openclaw/workspace/skills/私人胶囊"

log() {
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] [auto-create-capsule] $1" | tee -a "$LOG_FILE"
}

log "检查工作缓冲区是否有待胶囊化的成功任务..."

# 检查工作缓冲区是否存在
if [ ! -f "$WORKING_BUFFER" ]; then
  log "工作缓冲区不存在，跳过"
  exit 0
fi

# 提取已完成的任务（带 ✅ 标记）
DONE_TASKS=$(grep -E "^###.*✅" "$WORKING_BUFFER" 2>/dev/null | head -5)

if [ -z "$DONE_TASKS" ]; then
  log "无已完成任务，跳过胶囊化"
  exit 0
fi

log "发现已完成任务，尝试胶囊化..."

# 获取最后完成的带✅任务
LAST_DONE=$(grep -B5 "✅" "$WORKING_BUFFER" 2>/dev/null | grep -E "^###|^-" | tail -3)

if [ -z "$LAST_DONE" ]; then
  log "无法提取任务详情，跳过"
  exit 0
fi

# 解析任务信息
TASK_TITLE=$(echo "$LAST_DONE" | head -1 | sed 's/^### //' | sed 's/ //')
TASK_FILE=$(grep -A3 "$TASK_TITLE" "$WORKING_BUFFER" 2>/dev/null | grep "文件：" | sed 's/文件：//' | tr -d ' ')

log "任务: $TASK_TITLE"
log "文件: $TASK_FILE"

# 生成胶囊参数
CAP_NAME="自动胶囊-$(date +%m%d%H%M)"
CAP_TYPE="other"

# 根据任务内容推断类型
if echo "$TASK_TITLE" | grep -qE "官网|网站|网页|前端"; then
  CAP_TYPE="automation"
elif echo "$TASK_TITLE" | grep -qE "调研|搜索|调研"; then
  CAP_TYPE="research"
elif echo "$TASK_TITLE" | grep -qE "写|文案|文章|内容"; then
  CAP_TYPE="write"
elif echo "$TASK_TITLE" | grep -qE "代码|开发|调试|bug"; then
  CAP_TYPE="code"
fi

CAP_PATTERN="从工作缓冲区自动提取: $TASK_TITLE"

# 检查胶囊目录是否存在
mkdir -p "$CAPSULES_DIR"

# 调用 create-capsule.sh
bash ~/.openclaw/skills/brain-v1.1.9/scripts/create-capsule.sh \
  "$CAP_NAME" \
  "$CAP_TYPE" \
  "$CAP_PATTERN"

log "胶囊创建完成"