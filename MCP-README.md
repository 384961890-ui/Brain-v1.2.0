# Brain MCP Server

将 brain v1.1.9 的核心能力通过 MCP 协议暴露给 Claude Code / Codex / Cline 等工具。

## 快速配置

### Claude Desktop

编辑 `~/Library/Application Support/Claude/claude_desktop_config.json`：

```json
{
  "mcpServers": {
    "brain": {
      "command": "node",
      "args": ["~/.openclaw/skills/brain-v1.1.9/scripts/brain-mcp-server.js"]
    }
  }
}
```

### Claude Code (CLI)

```bash
claude mcp add brain -- node ~/.openclaw/skills/brain-v1.1.9/scripts/brain-mcp-server.js
```

### Cline (VSCode)

在 VSCode 的 Cline 设置中添加 MCP Server：
- Name: `brain`
- Command: `node`
- Args: `~/.openclaw/skills/brain-v1.1.9/scripts/brain-mcp-server.js`

## 可用工具

| 工具名 | 描述 | 参数 |
|--------|------|------|
| `brain_recall` | 搜索记忆 | `query: string`, `limit?: number`, `type?: string` |
| `brain_confidence_check` | 置信度评估 | `task: string` |
| `brain_task_status` | 查询任务状态 | 无 |
| `brain_save_decision` | 记录决策 | `topic: string`, `content: string`, `source?: string` |
| `brain_get_latest_snapshot` | 最新会话快照 | 无 |

## 依赖

需要 `@modelcontextprotocol/sdk` 包。如未安装：

```bash
cd ~/.openclaw/skills/brain-v1.1.9
npm install @modelcontextprotocol/sdk
```

## 手动测试

```bash
# 语法检查
node -c ~/.openclaw/skills/brain-v1.1.9/scripts/brain-mcp-server.js

# 启动（stdio 模式，Ctrl+C 退出）
node ~/.openclaw/skills/brain-v1.1.9/scripts/brain-mcp-server.js
```
