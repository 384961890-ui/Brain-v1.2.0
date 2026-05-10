#!/bin/bash
# auto-pre-checkpoint.sh
# 自动触发版预检点
# 集成方式：
#   1. 在 BOOTSTRAP.md 启动序列末尾调用（会话开始时）
#   2. 也可由 proactive-check.sh cron 在检测到新任务时触发
#
# 与 BOOTSTRAP.md 的区别：
#   - BOOTSTRAP 是"会话级"注入，把缓冲区内容注入会话上下文
#   - auto-pre-checkpoint 是"任务级"存档，记录当前任务的计划和进度
#   两个维度互补，不重复

BUFFER_FILE="$HOME/.openclaw/workspace/memory/工作缓冲区.md"
SNAPSHOT_FILE="$HOME/.openclaw/workspace/memory/SNAPSHOT.md"

# 读取当前任务（从缓冲区第一个任务条目）
get_current_task() {
  if [ ! -f "$BUFFER_FILE" ]; then
    echo ""
    return
  fi
  # 提取第一个进行中的任务
  grep -A5 "进行中" "$BUFFER_FILE" 2>/dev/null | grep -m1 "^## " | sed 's/^## //' | sed 's/\[.*\]//g' | xargs
}

# 提取当前任务的计划描述
get_current_plan() {
  if [ ! -f "$BUFFER_FILE" ]; then
    echo ""
    return
  fi
  grep -A10 "进行中" "$BUFFER_FILE" 2>/dev/null | grep -m1 "^### 计划" -A3 | tail -n3 | xargs
}

# 生成唯一ID
generate_id() {
  echo $(date +%s)-$(head /dev/urandom | tr -dc 'a-z0-9' | head -c 4)
}

# 格式化时间（CST）
format_timestamp() {
  date "+%Y-%m-%d %H:%M:%S CST"
}

# 检查是否已有未完成的预检点（避免重复创建）
has_active_checkpoint() {
  if [ ! -f "$BUFFER_FILE" ]; then
    return 1
  fi
  grep -q "预检点.*⏳ 进行中" "$BUFFER_FILE" 2>/dev/null
  return $?
}

# 写入预检点
write_checkpoint() {
  local task="$1"
  local plan="$2"
  local id=$(generate_id)
  local ts=$(format_timestamp)
  
  if [ -z "$task" ]; then
    echo "ℹ️ 无进行中任务，跳过预检点"
    return
  fi
  
  # 检查是否已有活跃预检点
  if has_active_checkpoint; then
    echo "ℹ️ 已有活跃预检点，跳过创建"
    return
  fi
  
  local block="
<!-- PRE-CHECKPOINT ${id} | ${ts} -->
## 🔸 预检点 ${id}（${ts}）

### 任务
${task}

### 计划
${plan:-（未指定）}

### 元信息
| 字段 | 值 |
|:---|:---|
| 置信度 | ⏳ 待评估 |
| 预计步数 | 待定 |
| 并行 | 待定 |
| 状态 | ⏳ 进行中 |

### 进度记录
- [${ts}] 任务开始

"
  
  echo "$block" >> "$BUFFER_FILE"
  echo "✅ 预检点已创建 [${id}]"
  echo "📋 任务：$task"
  
  # 同时更新SNAPSHOT
  if [ -f "$SNAPSHOT_FILE" ]; then
    local ts_short=$(date "+%Y-%m-%d %H:%M")
    sed -i '' "s/# 最后更新时间：.*/# 最后更新时间：${ts_short}/" "$SNAPSHOT_FILE" 2>/dev/null
  fi
}

# 主逻辑
TASK=$(get_current_task)
PLAN=$(get_current_plan)

if [ -n "$TASK" ]; then
  echo "🔍 检测到进行中任务，开始创建预检点..."
  write_checkpoint "$TASK" "$PLAN"
else
  echo "ℹ️ 无进行中任务，跳过预检点"
fi
