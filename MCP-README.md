# Brain MCP Server v1.2.0

将 brain v1.2.0 的核心能力通过 MCP 协议暴露给 Claude Code / Codex / Cline 等工具。

## 快速配置

### Claude Desktop

编辑 `~/Library/Application Support/Claude/claude_desktop_config.json`：

```json
{
  "mcpServers": {
    "brain": {
      "command": "node",
      "args": ["~/.openclaw/skills/brain-v1.2.0/scripts/brain-mcp-server.js"]
    }
  }
}
```

### Claude Code (CLI)

```bash
claude mcp add brain -- node ~/.openclaw/skills/brain-v1.2.0/scripts/brain-mcp-server.js
```

### Cline (VSCode)

在 VSCode 的 Cline 设置中添加 MCP Server：
- Name: `brain`
- Command: `node`
- Args: `~/.openclaw/skills/brain-v1.2.0/scripts/brain-mcp-server.js`

## 可用工具（18个）

### 记忆检索

| 工具名 | 描述 | 关键参数 |
|--------|------|------|
| `brain_search` | ★融合搜索（关键词+语义并行合并） | `query`, `limit?`, `type?` |
| `brain_recall` | 关键词记忆搜索 | `query`, `limit?`, `type?` |
| `brain_semantic_recall` | QMD语义搜索（bge-small-zh-v1.5） | `query`, `top_k?` |
| `brain_list` | 列出全部记忆（分页） | `page?`, `pageSize?`, `type?`, `sortBy?` |

### 上下文注入

| 工具名 | 描述 | 关键参数 |
|--------|------|------|
| `brain_inject` | 跨会话上下文注入（含状态栏） | `includeSessionStore?` |

### 记忆管理

| 工具名 | 描述 | 关键参数 |
|--------|------|------|
| `brain_save_decision` | 记录决策（双写） | `topic`, `content`, `source?` |
| `brain_forget` | 删除记忆 | `id` |
| `brain_cleanup` | 清理过期数据 | `daysToKeep?`, `mode?` |

### 诊断

| 工具名 | 描述 | 关键参数 |
|--------|------|------|
| `brain_healthcheck` | 一键体检（7项检查） | 无 |
| `brain_memory_stats` | 记忆库完整统计面板 | 无 |
| `brain_get_latest_snapshot` | 最新会话快照 | 无 |
| `brain_confidence_check` | 置信度评估 | `task` |
| `brain_task_status` | 查询任务状态 | 无 |

### 文件锁

| 工具名 | 描述 |
|--------|------|
| `brain_lock_acquire` | 获取文件写锁 |
| `brain_lock_release` | 释放文件写锁 |
| `brain_lock_status` | 查询锁状态 |
| `brain_lock_list` | 列出所有锁 |
| `brain_lock_force_release` | 强制释放锁 |

## 推荐启动序列

```
1. brain_inject        → 获取会话状态 + 状态栏
2. brain_search        → 融合搜索相关记忆
3. (根据结果决定下一步)
```

## 依赖

```bash
cd ~/.openclaw/skills/brain-v1.2.0
npm install
```

## 手动测试

```bash
# 语法检查
node -c ~/.openclaw/skills/brain-v1.2.0/scripts/brain-mcp-server.js

# 启动（stdio 模式，Ctrl+C 退出）
node ~/.openclaw/skills/brain-v1.2.0/scripts/brain-mcp-server.js
```
