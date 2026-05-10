#!/usr/bin/env bash
set -euo pipefail

# match-capsule.sh
# 泡咪能力胶囊匹配脚本
# 用法: bash match-capsule.sh "<任务描述>"

TASK="${1:-}"
CAPSULES="$HOME/.openclaw/workspace/memory/capsules.md"
LOG_FILE="$HOME/.openclaw/workspace/memory/watchdog-log.md"

log() {
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] [match-capsule] $1" >> "$LOG_FILE"
}

if [ -z "$TASK" ]; then
  echo "用法: bash match-capsule.sh \"<任务描述>\""
  exit 1
fi

log "任务: $TASK"

# 提取关键词
TASK_LOWER=$(echo "$TASK" | tr '[:upper:]' '[:lower:]')

# 从capsules.md读取胶囊列表
# 简单实现：grep trigger pattern，命中则输出对应胶囊
echo "=== 胶囊匹配结果 ==="
echo ""
echo "任务: $TASK"
echo ""

# CAP-001: 多文件归档整理
if echo "$TASK_LOWER" | grep -Eq "整理|瘦身|归档|收口|phase"; then
  echo "✅ 命中胶囊: CAP-001（多文件归档整理）"
  echo "   类型: refactor"
  echo "   成功率: 100%"
  echo "   pattern: 盘点表 → 分类 → 确定主归宿 → 归档 + 索引更新"
  MATCHED=1
else
  echo "❌ 未命中 CAP-001"
fi

# CAP-002: 文案并行产出
if echo "$TASK_LOWER" | grep -Eq "文案|写稿|抖音|小红书|知乎|多平台|内容"; then
  echo "✅ 命中胶囊: CAP-002（文案并行产出）"
  echo "   类型: write"
  echo "   成功率: 80%"
  echo "   pattern: 并行初稿 → 验证agent挑刺 → 80分门槛 → 打回重写 → 最终输出"
  MATCHED=1
else
  echo "❌ 未命中 CAP-002"
fi

# CAP-003: 调研任务路由
if echo "$TASK_LOWER" | grep -Eq "调研|搜索|搜|查找|市场|竞品|推特|twitter"; then
  echo "✅ 命中胶囊: CAP-003（调研任务路由）"
  echo "   类型: research"
  echo "   成功率: 90%"
  echo "   pattern: think-chain判断 → 拆分 → researcher并行 → 汇总 → 验证（如需）"
  MATCHED=1
else
  echo "❌ 未命中 CAP-003"
fi

if [ -z "${MATCHED:-}" ]; then
  echo "⚠️ 未命中任何已知胶囊"
  echo "   建议: 使用 subagent-think-chain.js 做路由判断"
fi

log "匹配完成"
