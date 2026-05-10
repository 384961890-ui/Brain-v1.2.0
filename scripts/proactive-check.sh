#!/bin/bash
# 主动预判检查脚本
# 检查待办事项并输出

echo "🔮 主动性检查..."

# 使用 HOME 变量，兼容所有路径
WORKING_BUFFER="$HOME/.openclaw/workspace/memory/工作缓冲区.md"
SNAPSHOT="$HOME/.openclaw/workspace/memory/SNAPSHOT.md"

TODAY_TODO=""

# 检查工作缓冲区
if [ -f "$WORKING_BUFFER" ]; then
  TODO_LIST=$(grep -A 20 "## 📋 长期待办" "$WORKING_BUFFER" 2>/dev/null | grep -E "^\- \[ \]|^- \[x]" | head -10)
  if [ -n "$TODO_LIST" ]; then
    TODAY_TODO="$TODAY_TODO\n📋 待办事项：\n$TODO_LIST"
  fi
fi

# 检查进行中任务
if [ -f "$SNAPSHOT" ]; then
  IN_PROGRESS=$(grep -A 10 "### 进行中" "$SNAPSHOT" 2>/dev/null | grep -E "^\- |^\* " | head -5)
  if [ -n "$IN_PROGRESS" ]; then
    TODAY_TODO="$TODAY_TODO\n🚀 进行中：\n$IN_PROGRESS"
  fi
fi

if [ -n "$TODAY_TODO" ]; then
  echo "$TODAY_TODO"
  echo "---"
  echo "✅ 检查完成：发现待办"
else
  echo "📭 无待办事项"
  echo "✅ 检查完成：无"
fi
