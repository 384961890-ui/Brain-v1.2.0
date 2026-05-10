# brain v1.1.9 快速上手指南

> 5 分钟跑起来，不用读完 762 行 SKILL.md。

---

## 这是什么？

brain 是一个类大脑 Agent 架构，给你的 AI 助手加上：
- 🧠 **长期记忆** — 跨会话记住事情
- 🎯 **置信度评估** — 任务执行前自动判断风险
- 📦 **胶囊系统** — 成功经验自动封装复用
- 🔍 **语义搜索** — 用自然语言搜记忆（sentence-transformers）
- 📊 **会话追踪** — 决策记录、任务状态全留存

两种形态：
- **Skill 形态** — OpenClaw Agent 内置认知核心
- **MCP 形态** — Claude Code / Cline / Codex 开箱即用

---

## 30 秒安装

```bash
# 进入 brain 目录
cd ~/.openclaw/skills/brain-v1.1.9

# 安装依赖
npm install

# 验证
node -c scripts/brain-mcp-server.js && echo "✅ 安装成功"
```

---

## 形态 A：MCP 接入（给 Claude Code / Cline 用）

**Claude Desktop：** 编辑 `~/Library/Application Support/Claude/claude_desktop_config.json`

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

**Claude Code (CLI)：**

```bash
claude mcp add brain -- node ~/.openclaw/skills/brain-v1.1.9/scripts/brain-mcp-server.js
```

**验证连接：**

```bash
bash run-mcp.sh  # 启动后 Ctrl+C 退出即可
```

连接成功后你将获得 **9 个工具**：

| 工具 | 用途 |
|:---|:---|
| `brain_recall` | 关键词记忆搜索 |
| `brain_semantic_recall` | **语义搜索（sentence-transformers）** |
| `brain_list` | 浏览全部记忆 |
| `brain_forget` | 删除指定记忆 |
| `brain_inject` | 跨会话上下文注入 |
| `brain_save_decision` | 记录决策 |
| `brain_confidence_check` | 置信度评估 |
| `brain_task_status` | 查询任务状态 |
| `brain_cleanup` | 清理过期数据 |

---

## 形态 B：Skill 认知形态（给 OpenClaw Agent 用）

brain 已作为 OpenClaw Skill 安装在 `~/.openclaw/skills/brain-v1.1.9/`。

OpenClaw 会自动加载 SKILL.md 中的认知规则。启动时：
1. 自动读取 SNAPSHOT.md + 工作缓冲区
2. 任务进来 → 自动评估置信度
3. 完成后 → 自动建议创建胶囊

---

## 配置

编辑 `config/brain.config.json`：

```json
{
  "workspace": "~/.openclaw/workspace",
  "limits": {
    "injection_max_tokens": 10000,
    "days_abandoned": 180
  },
  "models": {
    "default": "your-preferred-model"
  }
}
```

---

## 常见问题

**Q：MCP 连不上？**
A：检查 Node.js 版本 ≥ 18，运行 `node -c scripts/brain-mcp-server.js` 看有没有语法错误。

**Q：语义搜索没结果？**
A：先建索引：`python3 brain-memory-qmd/brain-memory-qmd.py index --dir ~/.openclaw/workspace/memory`

**Q：怎么查看记忆？**
A：MCP 里调 `brain_list`，或直接看 `~/.openclaw/workspace/memory/memory-store.json`

---

*完整文档：SKILL.md（762行）*
*问题反馈：wangtianrui1999521@gmail.com*
