---
name: brain
version: 1.1.9
description: brain v1.1.9 — 类大脑Agent架构 · Skill认知核心 + MCP开箱即用。v1.1.8审计优化版：去重/衰减/缓存/中文模型/安全/结构化错误。
---

# brain v1.1.9 — 审计优化版

**类大脑Agent架构 · Skill认知核心 + MCP开箱即用**

> v1.1.9 是 v1.1.8 的深度审计优化版。不增功能，强化已有：更好用、更省钱、记忆更好。

> 让任何 AI 工具都拥有一个结构化的大脑：记忆持久化、置信度评估、会话追踪、决策存档。一个 SKILL.md + 一个 MCP Server，开箱即用。

---

## 双形态架构全景

```
                    ┌─────────────────────────────────────────────────────┐
                    │                  认知层 (SKILL.md)                  │
                    │  感知皮层 → 全局意识 → 认知皮层 → 记忆皮层          │
                    │  → 执行皮层 → 输出与学习皮层                       │
                    │  ▲ 告诉AI"怎么思考"                               │
                    └──────────────────┬──────────────────────────────────┘
                                       │
                    ┌──────────────────▼──────────────────────────────────┐
                    │                  操作层 (CLI)                       │
                    │  brain recall / brain list / brain inject           │
                    │  brain forget / brain status / brain cleanup        │
                    │  ▲ 用户和AI都能直接操作                            │
                    └──────────────────┬──────────────────────────────────┘
                                       │
            ┌──────────────────────────┼──────────────────────────┐
            │                          │                          │
   ┌────────▼────────┐       ┌────────▼────────┐       ┌────────▼────────┐
   │ 接入层 (MCP)    │       │ 接入层 (MCP)    │       │ 接入层 (MCP)    │
   │ OpenClaw    │       │ Claude Code    │       │ Cline / Codex   │
   │ 内置SKILL形态    │       │ stdio MCP      │       │ stdio MCP       │
   └─────────────────┘       └─────────────────┘       └─────────────────┘
                                       │
                    ┌──────────────────▼──────────────────────────────────┐
                    │                执行层 (scripts/)                    │
                    │  brain-mcp-server.js   ▶ MCP Server 入口          │
                    │  memory-backend.js      ▶ 统一记忆接口             │
                    │  session-store.js       ▶ 会话持久化存储           │
                    │  load-config.js         ▶ 配置中心化加载           │
                    │  backends/file-backend.js ▶ 文件系统存储后端       │
                    │  subagent-think-chain.js  ▶ 思考链引擎             │
                    │  ... 18+ 个脚本                                     │
                    └─────────────────────────────────────────────────────┘
```

### 双形态怎么配合

| 维度 | Skill 认知形态 | MCP 接入形态 |
|:---|:---|:---|
| 目标用户 | Agent 本身（OpenClaw 内执行） | 外部工具（Claude Code / Cline / Codex） |
| 能力 | 完整 6 层认知架构 + 全量脚本 | 15 个工具：记忆检索/管理/决策/置信度/文件锁 |
| 接入方式 | `bootstrapExtraFiles` 注入 SKILL.md | `node brain-mcp-server.js` stdio |
| 数据共享 | 同一套 memory-store.json + sessions.db | 同一套 memory-store.json + sessions.db |
| 启动时机 | Agent 每次会话自动加载 | 用户手动配置 → 工具自动连接 |

---

## 快速开始

### 安装

```bash
# 1. 安装 MCP SDK 依赖
cd ~/.openclaw/skills/brain-v1.1.9
npm install

# 2. 验证所有脚本可用
node -c scripts/brain-mcp-server.js
node -c scripts/memory-backend.js
node -c scripts/load-config.js

# 3. 确认配置文件存在
cat config/brain.config.json
```

### 形态 A：Skill 认知形态（推荐给 OpenClaw Agent 使用）

已在 AGENTS.md / BOOTSTRAP.md 中引用 SKILL.md 即可自动加载 6 层认知逻辑。

启动验证：
```bash
# 检查 memory-store.json 是否已初始化
ls -la ~/.openclaw/workspace/memory/memory-store.json
```

### 形态 B：MCP 接入形态（推荐给外部 AI 工具使用）

**Claude Desktop：**
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

**Cline (VSCode)：**
- Name: `brain`
- Command: `node`
- Args: `~/.openclaw/skills/brain-v1.1.9/scripts/brain-mcp-server.js`

验证连接：
```bash
# 手动启动 MCP Server（stdio 模式），Ctrl+C 退出
bash run-mcp.sh
```

---

## 认知层（Skill）SOP

> 6 层架构是 brain 的"思考方式"——告诉 Agent 怎么感知、怎么推理、怎么记忆、怎么执行、怎么学习。
> MCP 是接入层，Skill 是认知核心。

### 第一层：感知皮层

**每次收到任务时，先完成这 5 步判断：**

```
1. 任务类型？
   执行类 / 调研类 / 创作类 / 聊天类 / 配置类

2. 用户情绪状态？
   急 → 减少解释，直接给结果
   正常 → 标准流程
   随意 → 可以展开讨论

3. 和当前进行中的任务有关系吗？
   有 → 先关联上下文再回答
   无 → 独立处理

4. 是「配置类」任务吗？
   是 → 触发配置操作保险（见认知皮层铁律）

5. 有匹配的胶囊吗？
   有 stable 胶囊 → 直接复用
   有 tested 胶囊 → 建议复用，确认后执行
   无 → 走常规流程
```

### 第二层：认知皮层

#### 置信度评估（v1.1.8 强制执行 + MCP 可调用）

**初始置信度：** 0.9（配置类 0.7）

**判断规则：**
```
>0.8：直接执行
0.6~0.8：执行+记录
≤0.6：双保险（先写快照再执行）+ 强制对抗验证
```

**信号表：**
| 信号类型 | 影响 | 原因 |
|:---|:---:|:---|
| 不可逆操作（删除/销毁） | -0.3 | 风险高 |
| 对外操作（发布/上线） | -0.2 | 后果严重 |
| 系统核心修改 | -0.2 | 牵一发动全身 |
| 安全相关（密码/密钥） | -0.2 | 安全第一 |
| 任务复杂（子agent>2） | -0.1 | 链路长易漂移 |
| 首次遇到此类任务 | -0.2 | 无先例可循 |
| 历史成功率高 | +0.1 | 有参考 |
| 任务明确简单 | +0.1 | 把握大 |

**强制规则：**
- 派 subagent 前，必须实际运行脚本：`node subagent-think-chain.js "<任务描述>"`
- 按 JSON 输出执行，不口头覆盖
- 危险操作（rm/删除/发布）必须触发对抗验证
- 外部工具可通过 MCP 工具 `brain_confidence_check` 获得相同评估（简化版基于关键词）

#### 配置操作保险

```
执行 openclaw config set/unset 前：
  先：openclaw config get <path>
  确认路径存在才执行

修改 models 配置前：
  先：openclaw models list

重启 gateway 前：
  先备份配置

执行完后必须输出验证结果
```

#### 模型双重定义铁律

```
⚠️ models 配置有两个来源，mode="merge" 时两个都生效：
  来源A：agents.defaults.models（你直接维护）
  来源B：models.providers（供应商定义，含 apiKey/baseUrl）

⚠️ 删除供应商模型时，必须先确认它在 A 还是 B，避免断掉该供应商所有模型
```

### 第三层：记忆皮层

**六个存储区 + MemoryBackend 统一接口：**
| 存储区 | 内容 | 特性 |
|:---|:---|:---|
| 短期记忆 | 当前会话上下文 | 会话结束清除 |
| 习惯记忆 | 反复成功的行为模式 | 长期保留 |
| 性格记忆 | Agent的人格设定 | 核心层，基本不变 |
| 偏好记忆 | 用户的偏好 | 持续更新 |
| 知识索引 | 信息存放位置 | 按标签索引 |
| 经验库 | 持久化的成功模式 | 胶囊化存储 |

**MemoryBackend（v1.1.8 统一记忆接口）：**

统一入口，后端可插拔（文件系统 → SQLite → LanceDB）。
```
              ┌────────────────────────────────────┐
              │         MemoryBackend              │
              │   store() / recall() / list()      │
              │   get() / forget() / stats()       │
              └──────────┬─────────────────────────┘
                         │
              ┌──────────▼──────────────┐
              │   FileBackend (默认)    │
              │   JSON 文件存储          │
              │   原子写入 · 支持热切换   │
              └─────────────────────────┘
```

**10K token 硬上限：**
- 单片段注入上限：≤10K tokens
- 超过自动压缩+标注"完整版见SNAPSHOT"
- 分段注入：用户信息→当前任务→待办→结论→工作缓冲

**记忆 Fragment 标准接口（5 种类型）：**
- `SkillFragment` — 技能用法和示例
- `TaskFragment` — 任务执行记录
- `ConfigFragment` — 配置变更决策
- `ConclusionFragment` — 分析结论
- `LessonFragment` — 经验教训

统一方法：`getSize()` / `toContext()` / `toSearchable()` / `toSnapshot()`

### 第四层：执行皮层

#### ⚡ 报错停顿（工具调用异常时强制触发）

**工具返回报错时，停下，过这三问：**

```
Q1：这错误我见过吗？
    → lancedb recall "类似的xxx报错"（不是翻文件！）
    → 有 → 照上次解法修
    → 无 → Q2

Q2：我跳过了什么基础步骤？
    → 自查执行路径
    → 例：read图片失败 → 真的不能看还是截图本身就是空的？
    → 例：API调用失败 → 参数对了？权限够？

Q3：修还是绕？
    → 根因明确 → 从源头修
    → 根因不明确 → 换方式验证（不是换方案凑合！），确认根因后决定
    → 真走投无路 → 升级（问爸爸）
```

**前置条件（三问之前）：**
- 读懂报错内容，不要跳过
- 拿不准的先 `memory_recall` 搜一下有没有相关经验
- 确信绕过比修好（即对方API限制/system limitation）才能换路

---

**脚本链路（完整执行链）：**

```
新会话启动（bootstrapExtraFiles 触发）
    ↓
build-session-injection.js
    读取 SNAPSHOT.md + 工作缓冲区.md
    组装上下文（10K硬上限+分段压缩）
    ↓
[前3轮消息，任务类词出现]
    ↓
QMD 语义搜索  →  相关记忆召回
    ↓
任务进来 → subagent-think-chain.js "<任务>"（必须实际运行）
    → 置信度评估 → 模型选择 → 拆分决策
    ↓
[置信度≤0.6 或 危险操作]
    → pre-checkpoint.js → 快照 → 执行
    ↓
subagent-budget.js   → 复杂度→预算→模型
    ↓
[工具调用]
    → 成功？→ 继续
    → 报错？→ ⚡ 报错停顿（三问）
    ↓
subagent-watchdog.js → 超时重试+失败兜底
    ↓
任务完成 → capsule-auto-suggest.sh（必须运行）
    → 检查是否值得创建新胶囊
    → 打包 → 经验库 → 更新成熟度
```

### 第五层：输出与学习皮层

**任务完成闭环（必须执行）：**
```bash
bash capsule-auto-suggest.sh "<结果摘要>" "<任务描述>"
```

**胶囊成熟度三级：**
| 级别 | 条件 | 触发 |
|:---|:---|:---|
| raw | 首次成功 | 手动确认后用 |
| tested | 连续成功2次 | 匹配时建议 |
| stable | 连续成功5次 | 匹配时默认 |

---

## 接入层（MCP）SOP

> 15 个 MCP 工具（10 个核心 + 5 个文件锁），供 Claude Code / Cline / Codex 等外部工具开箱即用。
> 所有工具通过 stdio MCP 协议通信，无需 HTTP 服务器。

### 工具总览

| # | 工具名 | 功能 | 调用频率 |
|---|---|---|---|
| 1 | `brain_recall` | 关键词记忆搜索 | ★★★ 高频 |
| 2 | `brain_semantic_recall` | **语义搜索（sentence-transformers）** | ★★★ 高频 |
| 3 | `brain_list` | 列出全部记忆 | ★★☆ 中频 |
| 4 | `brain_forget` | 删除记忆 | ★☆☆ 低频 |
| 5 | `brain_inject` | 跨会话上下文注入 | ★★★ 高频 |
| 6 | `brain_save_decision` | 记录决策 | ★★★ 高频 |
| 7 | `brain_get_latest_snapshot` | 获取最新会话快照 | ★★☆ 中频 |
| 8 | `brain_confidence_check` | 置信度评估 | ★★☆ 中频 |
| 9 | `brain_task_status` | 查询任务状态 | ★★☆ 中频 |
| 10 | `brain_cleanup` | 清理过期数据 | ★☆☆ 低频 |
| **11** | `brain_lock_acquire` | 获取文件写锁 | ★★☆ 中频 |
| **12** | `brain_lock_release` | 释放文件写锁 | ★★☆ 中频 |
| **13** | `brain_lock_status` | 查询锁状态 | ★☆☆ 低频 |
| **14** | `brain_lock_list` | 列出所有锁 | ★☆☆ 低频 |
| **15** | `brain_lock_force_release` | 强制释放锁（超时） | ★☆☆ 低频 |

---

### 工具 1：brain_recall

**什么场景用：** 每次启动、任务开始前、提到"记得/之前/那次"时

**参数：**
| 参数 | 类型 | 必填 | 默认 | 说明 |
|:---|:---|:---:|:---:|:---|
| `query` | string | ✅ | — | 搜索关键词（支持中文语义匹配） |
| `limit` | number | ❌ | 10 | 返回结果数量上限（1-50） |
| `type` | string | ❌ | null | 记忆类型过滤：skill/task/config/conclusion/lesson |

**返回值：**
```json
{
  "results": [
    {
      "type": "skill",
      "content": "发飞书图片：用message(action=send, filePath=...)",
      "score": 0.95,
      "priority": 0.7,
      "id": "frag-a1b2c3",
      "createdAt": "2026-04-15T10:30:00.000Z"
    }
  ],
  "total": 5
}
```

**错误处理：**
- 查询为空 → 返回 `"没有找到匹配的记忆。"`
- 后端不可用 → 返回 `isError: true` + 错误信息

**使用示例（Agent Prompt 中）：**
```
在回答用户问题前，先调用 brain_recall 搜索相关记忆
```

---

### 工具 2：brain_semantic_recall

**什么场景用：** 用自然语言搜索记忆，比 brain_recall 更智能。支持中文语义匹配。

**参数：**
| 参数 | 类型 | 必填 | 默认 | 说明 |
|:---|:---|:---:|:---:|:---|
| `query` | string | ✅ | — | 搜索查询（自然语言） |
| `top_k` | number | ❌ | 5 | 返回结果数量（1-20） |

**技术原理：** 基于 sentence-transformers（all-MiniLM-L6-v2）本地嵌入，将查询和记忆片段编码为向量后计算相似度。纯本地运行，不调用外部 API。

**返回值：**
```json
{
  "results": [
    {
      "content": "记忆内容",
      "score": 0.85,
      "source": "file_path_or_memory_id"
    }
  ],
  "total": 3,
  "query": "搜索词"
}
```

**与 brain_recall 的区别：**
| | brain_recall | brain_semantic_recall |
|:---|:---|:---|
| 搜索方式 | 关键词匹配 | 语义向量相似度 |
| 中文支持 | 精确匹配 | 语义理解 |
| 速度 | 快 | 稍慢（需编码向量） |
| 适用场景 | 精确查找 | 模糊搜索 |

---

### 工具 3：brain_list

**什么场景用：** 需要浏览全部记忆库、调试记忆内容、审计记忆健康度

**参数：**
| 参数 | 类型 | 必填 | 默认 | 说明 |
|:---|:---|:---:|:---:|:---|
| `page` | number | ❌ | 1 | 分页页码 |
| `pageSize` | number | ❌ | 20 | 每页条数（1-100） |
| `type` | string | ❌ | null | 按类型过滤：skill/task/config/conclusion/lesson |
| `sortBy` | string | ❌ | priority | 排序字段：priority / created |

**返回值：**
```json
{
  "items": [
    { "id": "frag-xxx", "type": "skill", "content": "...", "priority": 0.9 }
  ],
  "total": 42,
  "page": 1,
  "pageSize": 20
}
```

---

### 工具 4：brain_forget

**什么场景用：** 记忆错误需要清理、隐私信息需要删除、记忆过时

**参数：**
| 参数 | 类型 | 必填 | 默认 | 说明 |
|:---|:---|:---:|:---:|:---|
| `id` | string | ✅ | — | 要删除的记忆片段 ID（从 brain_list 或 brain_recall 结果的 id 字段获取） |

**返回值：**
```json
{
  "success": true,
  "id": "frag-a1b2c3"
}
```

**错误处理：**
- ID 不存在 → `{ "success": false, "error": "记忆不存在" }`

---

### 工具 5：brain_inject

**什么场景用：** 外部工具（Claude Code / Codex / Cline）启动时获取 brain 的完整会话上下文。每次新对话都该先调这个。

**参数：** 无（自动读取 SNAPSHOT.md + 工作缓冲区.md）

**返回值：**
```json
{
  "injection": "【当前会话上下文】\n\n【用户】xxx\n【进行中】brain v1.1.9开发\n【待办】MCP升级\n【最近关键结论】\n- xxx\n【工作缓冲】\nxxx",
  "meta": {
    "timestamp": "2026-05-02T12:00:00.000Z",
    "estimatedTokens": 850,
    "hardLimitTokens": 10000,
    "sources": { "snapshot": true, "buffer": true }
  }
}
```

**这是 brain MCP 的入口工具。** 它自动读取 SNAPSHOT.md 中的用户信息、当前任务、待办、最近结论，加上工作缓冲区，组装成一个 AI 可直接理解的上下文注入字符串。外部工具用它就能知道"brain 现在在做什么"。

**错误处理：**
- SNAPSHOT.md 不存在 → `"未找到会话快照（SNAPSHOT.md）。请先运行一次 brain 确保快照已生成。"`
- 读取失败 → `isError: true` + 错误信息

---

### 工具 6：brain_save_decision

**什么场景用：** 每次做出重要决策时，自动存档（如配置变更、技术选型、业务规则确认）

**参数：**
| 参数 | 类型 | 必填 | 默认 | 说明 |
|:---|:---|:---:|:---:|:---|
| `topic` | string | ✅ | — | 决策主题（简短标题） |
| `content` | string | ✅ | — | 决策内容（做了什么、为什么、结果） |
| `source` | string | ❌ | "mcp" | 决策来源（如 claude-code/cline/brain-skill） |

**返回值：**
```json
{
  "success": true,
  "sessionId": "decision-42",
  "memoryId": "frag-config-xyz",
  "topic": "切换默认模型为 deepseek-v4-flash"
}
```

**与 SessionStore 的关系：** 决策同时写入 MemoryBackend（持久记忆）和 SessionStore（会话追踪），双写保证。

---

### 工具 7：brain_get_latest_snapshot

**什么场景用：** 需要查看当前 brain 记录的最新会话状态、确认数据是否正常写入

**参数：** 无

**返回值：** SessionStore 中最新会话快照的 JSON，包含 sessionId/timestamp/userInfo/currentTasks/recentDecisions/pendingTodos

**错误处理：**
- 无快照数据 → `"没有找到任何会话快照。"`

---

### 工具 8：brain_confidence_check

**什么场景用：** 不确定任务可行性时检测、高风险操作前验证、分配资源前评估

**参数：**
| 参数 | 类型 | 必填 | 默认 | 说明 |
|:---|:---|:---:|:---:|:---|
| `task` | string | ✅ | — | 要评估的任务描述 |

**返回值：**
```json
{
  "confidence": 0.65,
  "level": "medium",
  "signals": [
    "包含不确定性关键词: '试试'",
    "包含复杂度关键词: '重构'",
    "任务描述较长，可能复杂"
  ],
  "recommendation": "建议拆解后分步执行"
}
```

**评估逻辑（内联于 MCP Server，基于关键词+长度分析）：**
- 初始分 0.8
- 不确定性关键词（试试/可能/看看）→ -0.1
- 复杂度关键词（重构/迁移/并行）→ -0.05
- 任务长度 > 200 字符 → -0.1
- 外部操作关键词（发/邮件/推特）→ -0.15
- 钳制到 [0, 1] 后分级：≥0.7=high / ≥0.4=medium / <0.4=low

**注意：** 这是 server-side 的轻量版评估（关键词分析），与 Skill 层 `subagent-think-chain.js` 的完整版评估（脚本执行+语义分析）相比精度较低，但速度更快、无 bash 依赖。

---

### 工具 9：brain_task_status

**什么场景用：** 检查是否有中断的任务需要处理、开始新任务前确认当前负载

**参数：** 无

**返回值：**
```json
{
  "pendingCount": 2,
  "tasks": [
    {
      "taskId": "task-abc",
      "status": "in_progress",
      "progress": "分析完成，等待执行",
      "updatedAt": "2026-05-01 14:30:00"
    }
  ],
  "stats": {
    "sessions": 15,
    "decisions": 8,
    "tasks": 12,
    "pendingTasks": 2
  }
}
```

**使用场景示例：**
```
Agent 启动时，先调用 brain_task_status → 发现有待恢复的任务 → 询问用户是否继续
```

---

### 工具 10：brain_cleanup

**什么场景用：** 定期维护（每日/每周）、记忆库膨胀时清理、下线前归档

**参数：**
| 参数 | 类型 | 必填 | 默认 | 说明 |
|:---|:---|:---:|:---:|:---|
| `daysToKeep` | number | ❌ | 30 | 保留最近多少天的会话记录 |
| `mode` | string | ❌ | "archive" | 清理模式：archive（归档旧数据）/ purge（彻底删除） |

**返回值：**
```json
{
  "success": true,
  "archived": 10,
  "kept": 25,
  "archivePath": "/path/to/sessions_archive_2026-05-01.json"
}
```

**清理策略（配置中心化的 days_abandoned: 180 天）：**
- 最近 daysToKeep 天 → 保留
- 更早的数据 → 归档到独立 JSON 文件（不丢数据）
- purge 模式 → 直接删除过期记录（不可恢复）

---

## v1.1.7 → v1.1.8 增量说明

### 架构升级

| 维度 | v1.1.7 | v1.1.8 |
|:---|:---|:---|
| 形态 | 单形态 Skill | **双形态：Skill + MCP** |
| 架构 | 6 层认知架构 | **4 层执行架构：SKILL(认知) → CLI(操作) → MCP(接入) → scripts(执行)** |
| 接入方式 | 仅 OpenClaw Agent 内使用 | **+ Claude Code / Cline / Codex 等外部工具** |
| 文档 | 仅 SKILL.md | **SKILL.md + MCP-README.md 双文档** |

### 新增能力

| 能力 | v1.1.7 | v1.1.8 |
|:---|:---:|:---:|
| MCP Server | ❌ | ✅ **Node.js stdio MCP Server** |
| MCP 工具数量 | 0 | **15 个（10 核心 + 5 文件锁）** |
| MemoryBackend 统一接口 | ❌（记忆直写文件） | ✅ **抽象层：store/recall/get/forget/list/stats** |
| SessionStore 会话存储 | ❌ | ✅ **会话持久化 + 任务追踪 + 决策日志** |
| 后端可插拔 | ❌ | ✅ **文件系统（默认）→ SQLite → LanceDB 热切换** |
| 原子写入 | ❌（直接写入） | ✅ **写临时文件 → rename 原子提交** |
| 配置中心化 | ❌ | ✅ **brain.config.json 统一加载** |
| ConfigLoader | ❌ | ✅ **load-config.js：路径展开 + 统一配置入口** |
| FileBackend | ❌ | ✅ **文件存储后端实现 + 记忆分页/搜索/统计/备份** |
| 数据恢复（文件损坏） | ❌ | ✅ **自动重置 + 错误日志** |

### 安全加固

| 安全措施 | v1.1.7 | v1.1.8 |
|:---|:---:|:---:|
| 原子写入（防数据损坏） | ❌ | ✅ 临时文件 → rename |
| 文件损坏自动恢复 | ❌ | ✅ 重置为空结构不崩溃 |
| MCP 错误捕获 | ❌ | ✅ 全部工具 try-catch |
| 参数校验 (Zod) | ❌ | ✅ 输入参数类型+边界校验 |
| 决策双写保证 | ❌ | ✅ 同时写 MemoryBackend + SessionStore |

### 新增脚本

| 脚本 | v1.1.7 | v1.1.8 | 功能 |
|:---|:---:|:---:|:---|
| `brain-mcp-server.js` | ❌ | ✅ | MCP Server 入口（15 个工具） |
| `memory-backend.js` | ❌ | ✅ | 统一记忆接口抽象层 |
| `session-store.js` | ❌ | ✅ | 会话持久化（JSON 文件） |
| `load-config.js` | ❌ | ✅ | 配置中心化加载 |
| `backends/file-backend.js` | ❌ | ✅ | 文件系统存储后端 |

### 保留但未修改

- 6 层认知架构（感知/认知/记忆/执行/输出）— 架构不变，现在是"认知核心"
- 10K token 硬上限 — 不变
- Fragment 标准接口（5 种类型）— 不变，MemoryBackend 包装了它
- 30+ 自动化测试（subagent-think-chain.test.js）— 不变
- 胶囊管理系统— 不变
- 配置操作保险 + 模型双重定义铁律 — 不变
- 所有 auto-* 脚本 — 不变

---

## 配置指南

### brain.config.json 完整结构

```json
**配置文件（single source of truth）：** `config/brain.config.json`

不要照抄配置内容到此处——配置会随版本变化，文档会漂移。始终 Read `config/brain.config.json` 获取最新配置。

**配置加载流程（load-config.js）：**
```
brain.config.json → JSON.parse → expandEnvVars($env:VAR) → expandHome(~) → getConfig()
```

**关键字段速查（以实际 config 为准，此处仅示意结构）：**

| 顶层字段 | 说明 |
|:---|:---|
| `workspace` | Agent 工作根目录，paths 基于此解析 |
| `memory` | 记忆后端配置（type/lancedb 参数/embedding 配置） |
| `limits` | fragment_max_tokens / injection_max_tokens / 超时 / 阈值 |
| `paths` | 运行时文件路径（snapshot/buffer/decision_log 等） |
| `models` | 各任务类型模型路由 |
| `skills_dirs` | 技能目录列表 |

**API keys 规则：** 用 `$env:VAR_NAME` 占位，load-config 启动时从环境变量读取。不在 config 里写明文 key。

**路径展开规则：**
- `~` 自动展开为 `process.env.HOME`
- 所有 `paths.*` 路径通过 `resolvePath()` 拼接 `workspace` 得到绝对路径
- `skills_dirs` 中的 `~` 同样自动展开

---

## 完整脚本清单（v1.1.9）

```
scripts/
├── brain-mcp-server.js              # [NEW] MCP Server 入口（15 个工具）
├── memory-backend.js                 # [NEW] 统一记忆接口抽象层
├── session-store.js                  # [NEW] 会话持久化存储
├── load-config.js                    # [NEW] 配置中心化加载
├── backends/
│   └── file-backend.js               # [NEW] 文件系统存储后端
├── build-session-injection.js       # 会话启动自动组装（10K硬上限+分段压缩）
├── subagent-think-chain.js          # 任务分类+置信度+模型选择（6-Section架构）
├── subagent-think-chain.test.js     # 30+自动化测试用例
├── subagent-budget.js               # 任务复杂度→预算+模型分配
├── subagent-watchdog.js             # 超时重试+失败兜底
├── pre-checkpoint.js                # 复杂任务前主动落盘
├── memory-fragment.js               # 记忆片段标准接口（5种类型）
├── capsule-auto-suggest.sh          # 任务完成后自动建议创建胶囊
├── create-capsule.sh                # 手动创建胶囊
├── match-capsule.sh                 # 匹配已有胶囊
├── auto-confidence-trigger.sh       # 置信度自动触发器
├── auto-create-capsule.sh           # 胶囊自动创建
├── auto-match-capsule.sh            # 胶囊自动匹配
├── auto-pre-checkpoint.sh           # 预检点自动触发
├── config-snapshot.sh               # 配置变更快照
├── context-monitor.sh               # 实时上下文监控（80%阈值）
├── proactive-check.sh               # 主动预判检查
├── skill-health-checker.js          # 技能健康检查
├── conversation-counter.js          # 对话轮次计数器
└── auto-review-trigger.js           # 自动审查触发器
```

---

## 关于作者

一个中国开发者。

最初只是想让自己的 Agent 别那么健忘、省点 token，结果越搞越上头，一不小心整出了一套类大脑神经网络架构 + MCP 接入层。

pete 说过："你很难和一个只想玩的人做对手"

如果您觉得有意思，欢迎联系交流。

---

## v1.1.9 审计优化日志 (2026-05-07)

> 通过 DeepClaude 混合工作流（opus 审计 + pro 执行）完成。不改功能，只强化。

### 更好用
- **文档一致**：工具数量 10→15，编号重排，以代码为准
- **配置安全**：API key 环境变量化（`$env:SILICONFLOW_API_KEY`），load-config 自动展开
- **错误结构化**：空结果返回 `{ empty, hint, nextAction }` AI 自动走下一步
- **SNAPSHOT parser 抽库**：`snapshot-parser.js`，brain-mcp-server 和 build-session-injection 共享
- **配置指引**：SKILL.md 不抄 config，指引读实际文件
- **工具描述**：brain_recall/semantic 加 WHEN TO USE / WHEN NOT

### 更省钱
- **busy-wait 修复**：subagent-watchdog CPU 空转 → `await setTimeout`
- **FileBackend 缓存**：mtime 校验，文件未变不重复 JSON.parse
- **LanceDB 原生距离**：`_distance` 直接算分，跳过手动 cosine 循环
- **confidence 短路**：高置信简单任务跳过历史回溯
- **stdout 净化**：think-chain 提醒走 stderr

### 记忆更好
- **内容去重**：store 前 sha256 比对，重复→合并+强化 priority
- **时间衰减**：recall 融入 `exp(-age_days/30)` + 访问次数加成
- **Fragment 重构**：子类→meta object，`FragmentFactory.fromJSON()` 往返不丢信息
- **QMD 中文模型**：`all-MiniLM-L6-v2`→`BAAI/bge-small-zh-v1.5`，模型变更自动重建索引
- **损坏兜底**：JSON 损坏先备份 `.corrupted.<ts>` 再恢复，不静默丢数据
- **SessionStore ID**：单调计数器替代 `Math.max(...ids)`，防栈溢出+ID 撞车
- **双写一致性**：save_decision 先写 session，MemoryBackend 失败则回滚

您的意见与反馈，是进步的源动力。

---

## 订阅完整版

**订阅费用：** $6/月
**订阅方式：** 发送邮件至 `wangtianrui1999521@gmail.com`，标题注明"订阅brain完整版"
**增值服务：** 若有升级/内测版本，会第一时间通过 Gmail 通知您

---

*brain v1.1.9 双形态完整版*
*Skill 认知核心 · MCP 开箱即用 · 记忆持久化 · 置信度评估 · 会话追踪 · 决策存档*
