#!/bin/bash
# auto-confidence-trigger.sh
# 自动触发版置信度检查
# 集成方式：在每次工具执行前由泡咪主动调用
# 也可在 BOOTSTRAP.md 启动序列中自动调用

# 接收任务描述作为参数
TASK="${1:-}"

# 如果没有参数，尝试从工作缓冲区读取当前任务
if [ -z "$TASK" ]; then
  BUFFER_FILE="$HOME/.openclaw/workspace/memory/工作缓冲区.md"
  if [ -f "$BUFFER_FILE" ]; then
    # 读取最新任务（第一个 ## 开头的标题）
    TASK=$(grep -m1 "^## " "$BUFFER_FILE" | sed 's/^## //' | sed 's/\[.*\]//g' | xargs)
  fi
fi

if [ -z "$TASK" ]; then
  echo "ℹ️ 无当前任务，跳过置信度检查"
  exit 0
fi

CONFIDENCE=0.9
SIGNALS=""

# 信号检测函数
check_signal() {
  local label="$1"
  local penalty="$2"
  if echo "$TASK" | grep -qiE "$3"; then
    SIGNALS="$SIGNALS\n  ⚠️ $label：-$penalty"
    CONFIDENCE=$(echo "$CONFIDENCE - $penalty" | bc)
  fi
}

check_signal "不可逆操作" 0.3 "删除|销毁|rm |trash|drop"
check_signal "对外操作" 0.2 "发布|上线|公开|发送|POST|公开"
check_signal "系统核心" 0.2 "gateway|config|系统|核心|系统级"
check_signal "安全相关" 0.2 "密码|密钥|key|secret|password|api.?key"
check_signal "任务复杂" 0.1 "复杂|多个|并行|子agent|拆解"
check_signal "首次遇到" 0.2 ""

# 简单任务加分
if echo "$TASK" | grep -qiE "读|查看|检查|验证|确认"; then
  CONFIDENCE=$(echo "$CONFIDENCE + 0.1" | bc)
fi

# 限制范围
CONFIDENCE=$(echo "$CONFIDENCE" | bc | awk '{if($1>1) print 1; else if($1<0) print 0; else print $1}')

# 格式化输出
echo ""
echo "📊 置信度评估"
echo "━━━━━━━━━━━━━━━━━━━━"
echo "任务：$TASK"
echo ""
echo "信号："
if [ -n "$SIGNALS" ]; then
  echo -e "$SIGNALS"
else
  echo "  （无风险信号）"
fi
echo ""
echo "📈 置信度：$CONFIDENCE"

# 根据结果输出建议
if (( $(echo "$CONFIDENCE >= 0.7" | bc -l) )); then
  echo "✅ 结论：直接执行"
  exit 0
elif (( $(echo "$CONFIDENCE >= 0.6" | bc -l) )); then
  echo "⚠️ 结论：执行+记录"
  exit 0
else
  echo "🔴 结论：低置信度 → 触发双保险"
  echo ""
  echo "建议执行以下操作："
  echo "  1. 先写快照：node pre-checkpoint.js"
  echo "  2. 执行中保持检查点"
  echo "  3. 完成后立即记录"
  exit 1
fi
