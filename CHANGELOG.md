# brain 更新日志

---

## v1.1.7（2026-04-23）— 接线版 + 死循环修复

> **核心主题：把悬在空中的功能真正接进执行链**

v1.1.6 的架构设计是对的，问题不在于设计烂，在于装了没接线。就像买了一套完整的音响，喇叭/功放/音源全有，但功放到喇叭那根线没插。不是设备坏了，是线没接。

v1.1.7 不是推翻重来，是把那几根线接上。

---

### 🔴 2026-04-23 紧急修复：subagent 死循环

**症状：** 派发 subagent 后持续堆积工具调用，Web UI 显示重复的 Tool call 堆栈

**根本原因：**
1. **激进拆分** — `SPLIT_SIGNALS` 包含 `多|几个|分别|并行|同时` 等极其通用的词汇，任何任务只要包含这些字就被视为需拆分
2. **硬编码 2 个 agent** — `shouldSplit=true` 时总是派恰好 2 个 subagent（方向A、方向B），不考虑任务复杂度
3. **持续脚本错误** — 双保险逻辑尝试调用不存在的 `pre-checkpoint.js`，错误但继续重试，导致日志爆炸

**v1.1.7 修复：**

| 问题 | 修复 |
|------|------|
| 激进拆分规则 | 降低 `SPLIT_SIGNALS` 激进度：只有**明确的**对比/分离/并行需求才拆分，普通任务保持单向；提升 `NO_SPLIT_SIGNALS` 优先级 |
| 硬编码数量 | 新增 `generateSubagents()` 函数：根据拆分需求动态生成 1-3 个 agent，而非固定 2 个 |
| 脚本错误循环 | 移除双保险的脚本调用，改为直接输出关键决策到控制台，由用户人工确认（而非脚本自动判断） |

---

---

### 10 项修复对照表

| # | v1.1.6 问题 | v1.1.7 修复 | 优先级 |
|---|------------|------------|--------|
| 1 | `build-session-injection.js` 从未被调用 | 加入 `bootstrapExtraFiles` 配置 + BOOTSTRAP 启动序列 | 🔴 高 |
| 2 | QMD 有 742-chunk 索引，从不自动触发 | BOOTSTRAP 第一轮消息后自动调用 QMD 搜索 | 🔴 高 |
| 3 | `capsule-auto-suggest.sh` 从未被自动调用 | 任务完成闭环规则，强制检查胶囊 | 🔴 高 |
| 4 | 置信度评估是口头表演，从不真正运行脚本 | 派 subagent 前必须实际运行 `subagent-think-chain.js` | 🔴 高 |
| 5 | 主动预判系统：0 次触发记录 | 修正触发时间 + 加入上下文触发 + 会话中主动说出 | 🟡 中 |
| 6 | 配置操作双保险缺失（删配置无验证） | 新增「配置操作保险」体系，操作前必须验证路径存在 | 🔴 高 |
| 7 | 模型双重定义盲区（说删了没删） | 写进认知层铁律：操作前确认两个来源都处理 | 🔴 高 |
| 8 | 感知皮层是空目录，没有实际实现 | 简化为可操作的「任务分类5步」 | 🟡 中 |
| 9 | 脚本路径三处不统一，文档互相矛盾 | 唯一权威路径：`~/.openclaw/skills/brain-v1.1.9/scripts/` | 🟡 中 |
| 10 | 胶囊成熟度字段空着，没人维护 | `capsules.md` 加成熟度列，每次用完必须更新 | 🟡 中 |

---

### v1.1.7 新增配置（需手动应用）

在 `openclaw.json` 的 `agents.defaults` 下加入：

```json
{
  "bootstrapExtraFiles": [
    "memory/SNAPSHOT.md",
    "memory/工作缓冲区.md"
  ]
}
```

---

### v1.1.7 新增规则（需写入 BOOTSTRAP.md / SNAPSHOT.md）

**启动序列（第一件事）：**
```
0. node ~/.openclaw/skills/brain-v1.1.9/scripts/build-session-injection.js
   → 组装会话注入（SNAPSHOT + 工作缓冲区摘要）
   
1. 根据用户第一条消息，自动运行 QMD 搜索（任务类消息时触发）：
   python3 ~/.openclaw/skills/brain-memory-qmd/brain-memory-qmd.py search "<主题>" --top-k 3
```

**任务完成闭环（每次完成明显任务单元后）：**
```
bash ~/.openclaw/skills/brain-v1.1.9/scripts/capsule-auto-suggest.sh "<结果摘要>" "<任务描述>"
→ 建议创建 → 在 skills/私人胶囊/ 下创建 CAP-xxx.md
→ 更新 skills/brain-power-up/capsules/capsules.md 成熟度列
```

**配置操作保险（新铁律）：**
```
执行 openclaw config set/unset 前：先 openclaw config get <path>
修改 models 配置前：先 openclaw models list
重启 gateway 前：先备份
  cp ~/.openclaw/openclaw.json ~/.openclaw/openclaw.json.bak-$(date +%Y%m%d-%H%M%S)
```

**模型双重定义铁律（新）：**
```
models 有两个来源（mode=merge 时两个都生效）：
  来源A：agents.defaults.models（直接维护）
  来源B：models.providers（供应商定义，含 apiKey/baseUrl，删掉会断供应商）

删模型时必须确认两个来源都处理。验证：删除后立刻 openclaw models list。
```

---

## v1.1.6（2026-04-19）— 架构版

新增功能：QMD 语义记忆搜索（基于 sentence-transformers 本地嵌入）

**技术规格：**
- 模型：all-MiniLM-L6-v2（首次自动下载，约90MB）
- 索引路径：`~/.openclaw/memory-index/qmd/`
- 中文处理：纯语义嵌入（BM25对中文无效，自动降级）
- 增量索引：自动识别新增/变更文件

---

## v1.1.5（2026-04-11）— 胶囊扩充版

- 胶囊 CAP-001~008 全部建立
- 成熟度三级体系正式定义
- subagent 路由规则 v2

---

## v1.1.0（2026-03-15）— 初版

- 6层神经网络架构初版
- 置信度评估体系
- 双保险机制
- 会话注入脚本链路
