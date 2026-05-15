# brain v1.2.0 快速上手指南

> 5 分钟跑起来，不用读完 SKILL.md。

---

## 这是什么？

brain 是一个类大脑 Agent 架构，给你的 AI 助手加上：
- 🧠 **长期记忆** — 跨会话记住事情
- 🎯 **置信度评估** — 任务执行前自动判断风险
- 📦 **胶囊系统** — 成功经验自动封装复用
- 🔍 **融合搜索** — 关键词+语义双路并行，自动合并去重
- 📊 **会话追踪** — 决策记录、任务状态全留存
- 🩺 **健康检查** — 一键体检记忆库全貌

两种形态：
- **Skill 形态** — OpenClaw Agent 内置认知核心
- **MCP 形态** — Claude Code / Cline / Codex 开箱即用

---

## 30 秒安装

```bash
# 进入 brain 目录
cd ~/.openclaw/skills/brain-v1.2.0

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
      "args": ["~/.openclaw/skills/brain-v1.2.0/scripts/brain-mcp-server.js"]
    }
  }
}
```

**Claude Code (CLI)：**

```bash
claude mcp add brain -- node ~/.openclaw/skills/brain-v1.2.0/scripts/brain-mcp-server.js
```

**验证连接：**

```bash
bash run-mcp.sh  # 启动后 Ctrl+C 退出即可
```

连接成功后你将获得 **18 个工具**：

| 工具 | 用途 |
|:---|:---|
| `brain_search` | ★融合搜索（关键词+语义并行合并） |
| `brain_recall` | 关键词记忆搜索 |
| `brain_semantic_recall` | 语义搜索（bge-small-zh-v1.5） |
| `brain_list` | 浏览全部记忆（分页） |
| `brain_forget` | 删除指定记忆 |
| `brain_inject` | 跨会话上下文注入（含状态栏） |
| `brain_save_decision` | 记录决策 |
| `brain_confidence_check` | 置信度评估 |
| `brain_task_status` | 查询任务状态 |
| `brain_cleanup` | 清理过期数据 |
| `brain_healthcheck` | 一键体检（7项检查） |
| `brain_memory_stats` | 记忆库完整统计面板 |
| `brain_get_latest_snapshot` | 最新会话快照 |
| `brain_lock_acquire` | 获取文件写锁 |
| `brain_lock_release` | 释放文件写锁 |
| `brain_lock_status` | 查询锁状态 |
| `brain_lock_list` | 列出所有锁 |
| `brain_lock_force_release` | 强制释放锁 |

**推荐启动序列：**
```
brain_inject → brain_search → 根据结果决定下一步
```

---

## 形态 B：Skill 认知形态（给 OpenClaw Agent 用）

brain 已作为 OpenClaw Skill 安装在 `~/.openclaw/skills/brain-v1.2.0/`。

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

**Q：记忆库出问题了怎么办？**
A：跑 `brain_healthcheck` 看诊断结果，再根据提示修复。

---

*完整文档：SKILL.md*
*问题反馈：wangtianrui1999521@gmail.com*
