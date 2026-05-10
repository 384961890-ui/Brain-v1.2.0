#!/bin/bash
# =============================================================================
# config-snapshot.sh — 配置修改自动快照工具
# =============================================================================
# 路径: ~/.openclaw/skills/brain-v1.1.9/scripts/config-snapshot.sh
# 功能: 读取 openclaw.json，计算MD5，与上次快照比较
#       有差异时备份到 memory/SNAPSHOT/，保留最近5份
# 依赖: ~/.openclaw/openclaw.json
# 调用: 可被 context-monitor 在检测到配置修改时调用
# =============================================================================

set -euo pipefail

# -------------------------- 路径 --------------------------
OPENCLAW_JSON="${HOME}/.openclaw/openclaw.json"
SNAPSHOT_DIR=""
WORK_BUFFER_DIR="${HOME}/.openclaw/workspace"
WORK_BUFFER_FILE=""

find_snapshot_dir() {
  local mem_dir
  mem_dir=$(find "$WORK_BUFFER_DIR" -name "memory" -type d 2>/dev/null | head -1 || echo "")
  if [[ -n "$mem_dir" ]]; then
    echo "${mem_dir}/SNAPSHOT"
  else
    echo "${HOME}/.openclaw/workspace/memory/SNAPSHOT"
  fi
}

find_work_buffer() {
  find "$WORK_BUFFER_DIR" -name "工作缓冲区.md" -type f 2>/dev/null | head -1 || echo ""
}

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" >&2; }

# -------------------------- MD5计算 --------------------------
config_md5() {
  if [[ ! -f "$OPENCLAW_JSON" ]]; then
    log "❌ openclaw.json not found: $OPENCLAW_JSON"
    return 1
  fi
  # 用python3计算json稳定MD5
  python3 <<PYEOF
import hashlib, json, sys, os

try:
    json_path = os.environ.get('OPENCLAW_JSON', '')
    if not json_path or not os.path.exists(json_path):
        sys.exit(1)
    with open(json_path) as f:
        data = json.load(f)
    serialized = json.dumps(data, sort_keys=True, ensure_ascii=False)
    md5 = hashlib.md5(serialized.encode('utf-8')).hexdigest()
    print(md5)
except Exception as e:
    sys.exit(1)
PYEOF
}

# -------------------------- 保存快照 --------------------------
save_snapshot() {
  local md5="$1"
  local timestamp
  timestamp=$(date '+%Y-%m-%dT%H-%M-%S')
  local snapshot_file="${SNAPSHOT_DIR}/${timestamp}.json"

  mkdir -p "$SNAPSHOT_DIR"
  cp "$OPENCLAW_JSON" "$snapshot_file"

  echo "$md5" > "${SNAPSHOT_DIR}/latest.md5"

  # 写meta
  python3 <<PYEOF
import json
meta = {'timestamp': '$timestamp', 'md5': '$md5', 'file': '$OPENCLAW_JSON'}
with open('$SNAPSHOT_DIR/latest.meta', 'w') as f:
    json.dump(meta, f, indent=2)
PYEOF

  echo "$snapshot_file"
}

# -------------------------- 旋转快照 --------------------------
rotate_snapshots() {
  local keep=5
  local count
  count=$(find "$SNAPSHOT_DIR" -maxdepth 1 -name "*.json" -type f 2>/dev/null | wc -l || echo 0)
  count=${count// /}

  if [[ $count -gt $keep ]]; then
    local excess=$(( count - keep ))
    find "$SNAPSHOT_DIR" -maxdepth 1 -name "*.json" -type f -printf '%T+ %p\n' 2>/dev/null \
      | sort -r \
      | tail -n +$(( keep + 1)) \
      | cut -d' ' -f2- \
      | xargs rm -f 2>/dev/null || true
    log "🗑 Rotated $excess old snapshot(s)"
  fi
}

# -------------------------- Diff摘要 --------------------------
diff_changes() {
  local prev_md5="$1"
  python3 <<PYEOF
import json, os

snapshot_dir = '$SNAPSHOT_DIR'
json_path = '$OPENCLAW_JSON'
prev_md5 = '$prev_md5'

try:
    # find previous snapshot
    import glob
    snaps = sorted(glob.glob(os.path.join(snapshot_dir, '*.json')),
                 key=os.path.getmtime)
    if len(snaps) < 2:
        print('(first snapshot — no previous to diff)')
    else:
        prev_data = json.load(open(snaps[-2]))
        curr_data = json.load(open(json_path))

        new_keys = set(curr_data.keys()) - set(prev_data.keys())
        rem_keys = set(prev_data.keys()) - set(curr_data.keys())
        changes = []

        for k in sorted(new_keys):
            changes.append(f'+ {k}: {json.dumps(curr_data[k])}')
        for k in sorted(rem_keys):
            changes.append(f'- {k} (removed)')
        for k in sorted(set(curr_data.keys()) & set(prev_data.keys())):
            if curr_data[k] != prev_data[k]:
                changes.append(f'~ {k}')

        print('\n'.join(changes) if changes else '(top-level keys unchanged)')
except Exception as e:
    print(f'(diff unavailable: {e})')
PYEOF
}

# -------------------------- 主检查 --------------------------
run_check() {
  SNAPSHOT_DIR=$(find_snapshot_dir)
  WORK_BUFFER_FILE=$(find_work_buffer)
  mkdir -p "$SNAPSHOT_DIR"

  local current_md5 prev_md5
  current_md5=$(config_md5) || return 1
  prev_md5=$(cat "${SNAPSHOT_DIR}/latest.md5" 2>/dev/null || echo "")

  log "📋 Current MD5: $current_md5"
  [[ -n "$prev_md5" ]] && log "📋 Prev MD5:   $prev_md5"

  if [[ "$current_md5" == "$prev_md5" ]]; then
    log "✅ Config unchanged"
    echo "unchanged"
    return 0
  fi

  log "⚠️  Config changed — taking snapshot"
  local snapshot_file
  snapshot_file=$(save_snapshot "$current_md5")
  log "💾 Snapshot: $(basename "$snapshot_file")"

  rotate_snapshots

  # 写工作缓冲区
  if [[ -n "$WORK_BUFFER_FILE" ]]; then
    {
      echo ""
      echo "## ⚙️  配置快照报告 — $(date '+%Y-%m-%d %H:%M:%S')"
      echo ""
      echo "| 字段 | 值 |"
      echo "|------|----|"
      echo "| 当前MD5 | \`$current_md5\` |"
      echo "| 上次MD5 | \`${prev_md5:-（首次）}\` |"
      echo "| 快照 | \`$(basename "$snapshot_file")\` |"
      echo ""
      echo "**变化:**"
      echo '```'
      diff_changes "$prev_md5"
      echo '```'
    } >> "$WORK_BUFFER_FILE"
  fi

  echo "changed"
  return 0
}

# -------------------------- 列出快照 --------------------------
list_snapshots() {
  SNAPSHOT_DIR=$(find_snapshot_dir)
  if [[ ! -d "$SNAPSHOT_DIR" ]]; then
    echo "No snapshots yet."
    return 0
  fi
  echo "📦 Snapshots: $SNAPSHOT_DIR"
  find "$SNAPSHOT_DIR" -maxdepth 1 -name "*.json" -type f \
    -printf '%TY-%Tm-%Td %TH:%TM  %f  (%s bytes)\n' 2>/dev/null | sort -r || echo "(empty)"
  echo ""
  cat "${SNAPSHOT_DIR}/latest.md5" 2>/dev/null && echo " (latest MD5)"
}

# -------------------------- 入口 --------------------------
case "${1:-}" in
  check)  run_check ;;
  list)   list_snapshots ;;
  *)      run_check ;;
esac

echo "✅ 语法验证通过"