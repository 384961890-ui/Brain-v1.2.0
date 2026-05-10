#!/usr/bin/env node
/**
 * brain-mcp-server.js — Brain MCP Server v1.1.9
 * ===============================================
 *
 * 将 brain v1.1.9 的核心能力包装成 MCP 协议服务端，
 * 让 Claude Code / Codex / Cline 等工具通过 MCP 调用 brain 记忆系统。
 *
 * 使用方式：
 *   node brain-mcp-server.js          # stdio 模式（默认）
 *
 * Claude Desktop 配置：
 *   {
 *     "mcpServers": {
 *       "brain": {
 *         "command": "node",
 *         "args": ["~/.openclaw/skills/brain-v1.1.9/scripts/brain-mcp-server.js"]
 *       }
 *     }
 *   }
 */

const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { z } = require('zod');
const fs = require('fs');
const path = require('path');

// brain 内部模块
const { getConfig, resolvePath } = require('./load-config.js');
const { MemoryBackend } = require('./memory-backend.js');
const { SessionStore } = require('./session-store.js');
const { FileLockManager } = require('./file-lock-manager.js');

// ============================================================
// 初始化 brain 后端
// ============================================================

const config = getConfig();

const memoryBackend = new MemoryBackend();

const sessionDbPath = config.paths.session_db
  ? resolvePath(config.paths.session_db)
  : resolvePath('memory/sessions.db');
const sessionStore = new SessionStore(sessionDbPath);

// 文件写锁管理器
const fileLockManager = new FileLockManager();

// ============================================================
// 创建 MCP Server
// ============================================================

const server = new McpServer({
  name: 'brain-mcp',
  version: '1.1.9',
});

// ============================================================
// 辅助函数
// ============================================================

const { extractKeyInfo } = require('./snapshot-parser.js');

/**
 * 估算 token 数（中英混排）
 */
function estimateTokens(text) {
  if (!text) return 0;
  const chinese = (text.match(/[\u4e00-\u9fff]/g) || []).length;
  const english = text.length - chinese;
  return chinese * 2 + Math.floor(english * 1.3);
}

// ============================================================
// Tool: brain_recall — 从记忆系统搜索信息
// ============================================================

server.tool(
  'brain_recall',
  '从 brain 记忆系统搜索信息。精确关键词匹配（快速，O(N) 扫描）。' +
  'WHEN TO USE: 知道确切关键词/术语时。例："latex header"、"docker compose"。' +
  'WHEN NOT: 模糊/概念性查询 → 用 brain_semantic_recall。',
  {
    query: z.string().describe('搜索关键词'),
    limit: z.number().optional().default(10).describe('返回结果数量上限'),
    type: z.string().optional().describe('按记忆类型过滤（skill/task/config/conclusion/lesson）'),
  },
  async ({ query, limit, type }) => {
    try {
      const options = { limit };
      if (type) options.type = type;
      const results = await memoryBackend.recall(query, options);

      if (results.length === 0) {
        return {
          content: [{ type: 'text', text: JSON.stringify({
            empty: true,
            hint: '关键词无匹配，尝试 brain_semantic_recall 做模糊语义搜索',
            query,
            nextAction: 'brain_semantic_recall',
          }, null, 2) }],
        };
      }

      const formatted = results.map((r, i) => {
        const f = r.fragment;
        return [
          `### ${i + 1}. [${f.type}] (score: ${r.score}, priority: ${f.priority})`,
          f.content,
          f.createdAt ? `创建于: ${f.createdAt}` : '',
          `ID: ${f.id}`,
        ].filter(Boolean).join('\n');
      }).join('\n\n---\n\n');

      return {
        content: [{ type: 'text', text: `找到 ${results.length} 条匹配记忆：\n\n${formatted}` }],
      };
    } catch (err) {
      return {
        content: [{ type: 'text', text: `搜索失败: ${err.message}` }],
        isError: true,
      };
    }
  }
);

// ============================================================
// Tool: brain_semantic_recall — QMD 语义记忆搜索
// ============================================================

const { execSync } = require('child_process');

server.tool(
  'brain_semantic_recall',
  'QMD 语义记忆搜索（bge-small-zh-v1.5 中文模型）。' +
  'WHEN TO USE: 模糊查询、概念搜索、中文自然语言。brain_recall 无结果时回退至此。' +
  '结果含语义相似度分数（0-1），top_k 控制返回数。',
  {
    query: z.string().describe('搜索查询（自然语言，支持中文语义匹配）'),
    top_k: z.number().optional().default(5).describe('返回结果数量（1-20）'),
  },
  async ({ query, top_k }) => {
    try {
      const qmdScript = path.join(__dirname, '..', 'brain-memory-qmd', 'brain-memory-qmd.py');
      const command = `python3 "${qmdScript}" search "${query}" --top-k ${top_k}`;

      const stdout = execSync(command, {
        encoding: 'utf8',
        timeout: 30000, // 30 秒超时
        maxBuffer: 1024 * 1024, // 1MB
      });

      // 解析 JSON 输出
      let results = [];
      const jsonStart = stdout.indexOf('[');
      if (jsonStart >= 0) {
        results = JSON.parse(stdout.slice(jsonStart));
      }

      if (!results || results.length === 0) {
        return {
          content: [{ type: 'text', text: JSON.stringify({
            empty: true,
            hint: '语义搜索无结果。可尝试：brain_recall（关键词匹配，更宽泛）或 brain_list（列出全部筛选）',
            nextAction: 'brain_recall 或 brain_list',
          }, null, 2) }],
        };
      }

      const formatted = results.map((r, i) => {
        return [
          `### ${i + 1}. [${r.file}]`,
          `语义相似度: ${(r.score * 100).toFixed(1)}%`,
          '',
          r.text,
          `来源: ${r.file_path}`,
        ].filter(Boolean).join('\n');
      }).join('\n\n---\n\n');

      return {
        content: [{ type: 'text', text: `找到 ${results.length} 条语义匹配记忆：\n\n${formatted}` }],
      };
    } catch (err) {
      let errorMessage = `语义搜索失败: ${err.message}`;

      // 检查是否因为缺少 HF_TOKEN 或模型下载问题
      if (err.stderr && err.stderr.includes('HF_TOKEN')) {
        errorMessage += '\n提示: 需设置 HF_TOKEN 环境变量以加速 sentence-transformers 模型下载。';
      }

      return {
        content: [{ type: 'text', text: errorMessage }],
        isError: true,
      };
    }
  }
);

// ============================================================
// Tool: brain_confidence_check — 置信度评估（增强版）
// ============================================================

server.tool(
  'brain_confidence_check',
  '评估一个任务的置信度和风险等级。关键词分析 + 历史决策回溯双重评估。（⚠️ 暂用关键词 + 历史搜索方式，非真正AI推理）',
  {
    task: z.string().describe('要评估的任务描述'),
  },
  async ({ task }) => {
    try {
      const taskLower = task.toLowerCase();
      const signals = [];
      let confidence = 0.8; // 默认高置信度

      // === 第一阶段：关键词分析（快速信号） ===
      const lowConfidenceKeywords = ['不确定', '可能', '试试', '看看', '也许', '探索', '调研'];
      const highConfidenceKeywords = ['确认', '明确', '已知', '固定', '标准', '按'];
      const complexKeywords = ['重构', '迁移', '架构', '多', '并行', '同时', '系统'];

      for (const kw of lowConfidenceKeywords) {
        if (taskLower.includes(kw)) {
          confidence -= 0.1;
          signals.push(`不确定性关键词: "${kw}"`);
        }
      }

      for (const kw of highConfidenceKeywords) {
        if (taskLower.includes(kw)) {
          confidence += 0.05;
          signals.push(`确定性关键词: "${kw}"`);
        }
      }

      for (const kw of complexKeywords) {
        if (taskLower.includes(kw)) {
          confidence -= 0.05;
          signals.push(`复杂度关键词: "${kw}"`);
        }
      }

      // v1.1.9: 短路优化 — 关键词阶段已明确为简单/明确任务，跳过历史回溯
      const skipHistory = confidence >= 0.85 && !complexKeywords.some(k => taskLower.includes(k));

      // === 第二阶段：历史决策回溯（真实记忆查询） ===
      if (!skipHistory) {
      try {
        const historicalResults = await memoryBackend.recall(taskLower, { limit: 5 });
        if (historicalResults.length > 0) {
          const highScoreHits = historicalResults.filter(r => r.score > 0.5);
          if (highScoreHits.length > 0) {
            confidence += 0.1;
            signals.push(
              `历史记忆支持: 找到 ${highScoreHits.length} 条相关记录` +
              `（最高分 ${Math.max(...highScoreHits.map(r => r.score))}）`
            );
          }

          // 检测历史失败/错误记录
          const failures = historicalResults.filter(r =>
            (r.fragment.content || '').toLowerCase().includes('失败') ||
            (r.fragment.content || '').toLowerCase().includes('错误') ||
            (r.fragment.content || '').toLowerCase().includes('failed')
          );
          if (failures.length > 0) {
            confidence -= 0.1;
            signals.push(`历史警示信号: 找到 ${failures.length} 条失败/错误记录`);
          }
        } else {
          signals.push('未找到相关历史记忆（首次任务？）');
        }
      } catch (e) {
        signals.push(`历史查询暂不可用: ${e.message}`);
      }
      } else {
        signals.push('关键词阶段高置信度，跳过历史回溯');
      }

      // === 第三阶段：任务复杂度评估 ===
      if (task.length > 200) {
        confidence -= 0.1;
        signals.push('任务描述较长（>200字符），可能复杂');
      }

      if (taskLower.includes('发') || taskLower.includes('邮件') ||
          taskLower.includes('推特') || taskLower.includes('twitter')) {
        confidence -= 0.15;
        signals.push('涉及外部操作，需谨慎');
      }

      // 钳制到 [0, 1]
      confidence = Math.max(0, Math.min(1, confidence));
      confidence = Math.round(confidence * 100) / 100;

      const level = confidence >= 0.7 ? 'high' : confidence >= 0.4 ? 'medium' : 'low';

      const recommendation = level === 'high'
        ? '可以直接执行'
        : level === 'medium'
        ? '建议拆解后分步执行'
        : '建议先调研确认再执行';

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            confidence,
            level,
            signals,
            recommendation,
            _limitation: '关键词 + 历史搜索评估，非真正 AI 推理。' +
              '计划升级为 LLM 语义分析（见 AGENTS.md #置信度评估）。',
          }, null, 2),
        }],
      };
    } catch (err) {
      return {
        content: [{ type: 'text', text: `置信度评估失败: ${err.message}` }],
        isError: true,
      };
    }
  }
);

// ============================================================
// Tool: brain_task_status — 查询任务状态
// ============================================================

server.tool(
  'brain_task_status',
  '查询当前进行中的任务列表。返回所有 pending 和 in_progress 的任务。',
  {},
  async () => {
    try {
      const pendingTasks = await sessionStore.getPendingTasks();
      const stats = await sessionStore.stats();

      if (pendingTasks.length === 0) {
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              message: '当前没有进行中的任务。',
              stats,
            }, null, 2),
          }],
        };
      }

      const formatted = pendingTasks.map((t, i) => ({
        index: i + 1,
        taskId: t.task_id,
        status: t.status,
        progress: t.progress,
        details: t.details,
        updatedAt: t.updated_at,
      }));

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            pendingCount: pendingTasks.length,
            tasks: formatted,
            stats,
          }, null, 2),
        }],
      };
    } catch (err) {
      return {
        content: [{ type: 'text', text: `查询任务状态失败: ${err.message}` }],
        isError: true,
      };
    }
  }
);

// ============================================================
// Tool: brain_save_decision — 记录决策
// ============================================================

server.tool(
  'brain_save_decision',
  '记录一个决策到 brain 记忆系统。同时写入 SessionStore 和 MemoryBackend。',
  {
    topic: z.string().describe('决策主题'),
    content: z.string().describe('决策内容'),
    source: z.string().optional().describe('来源标识'),
  },
  async ({ topic, content, source }) => {
    try {
      // v1.1.9: 先写 SessionStore，失败立刻抛；再写 MemoryBackend，失败回滚 SessionStore
      const sessionResult = await sessionStore.saveDecision(topic, content, source);

      let memResult = { id: null };
      try {
        // 用 ConclusionFragment 传参，字段正确对齐
        const { ConclusionFragment } = require('./backends/../memory-fragment.js');
        const frag = new ConclusionFragment(content, source || 'mcp');
        memResult = await memoryBackend.store(frag);
      } catch (memErr) {
        // MemoryBackend 写入失败 → 回滚 SessionStore
        console.error(`[brain_save_decision] MemoryBackend 写入失败，回滚 SessionStore: ${memErr.message}`);
        try { await sessionStore.deleteDecision?.(sessionResult.id); } catch { /* best effort */ }
        return {
          content: [{ type: 'text', text: JSON.stringify({
            success: false,
            error: 'MemoryBackend 写入失败，已回滚 SessionStore',
            detail: memErr.message,
          }, null, 2) }],
          isError: true,
        };
      }

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            success: true,
            sessionId: sessionResult.id,
            memoryId: memResult.id,
            topic,
          }, null, 2),
        }],
      };
    } catch (err) {
      return {
        content: [{ type: 'text', text: `保存决策失败: ${err.message}` }],
        isError: true,
      };
    }
  }
);

// ============================================================
// Tool: brain_get_latest_snapshot — 最新会话快照
// ============================================================

server.tool(
  'brain_get_latest_snapshot',
  '获取 brain 中最新的会话快照数据。',
  {},
  async () => {
    try {
      const snapshot = await sessionStore.getLatestSnapshot();

      if (!snapshot) {
        return {
          content: [{ type: 'text', text: '没有找到任何会话快照。' }],
        };
      }

      return {
        content: [{
          type: 'text',
          text: JSON.stringify(snapshot, null, 2),
        }],
      };
    } catch (err) {
      return {
        content: [{ type: 'text', text: `获取快照失败: ${err.message}` }],
        isError: true,
      };
    }
  }
);

// ============================================================
// Tool: brain_list — 列出记忆
// ============================================================

server.tool(
  'brain_list',
  '列出 brain 记忆系统中的记忆片段。支持按类型过滤和分页。',
  {
    type: z.string().optional().describe('按类型过滤（skill/task/config/conclusion/lesson）'),
    limit: z.number().optional().default(20).describe('返回数量上限（1-100）'),
  },
  async ({ type, limit }) => {
    try {
      const pageSize = Math.min(Math.max(limit || 20, 1), 100);
      const result = await memoryBackend.list({ page: 1, pageSize, type, sortBy: 'priority' });

      if (result.items.length === 0) {
        return {
          content: [{ type: 'text', text: '没有找到记忆片段。' }],
        };
      }

      const formatted = result.items.map((f, i) => {
        return [
          `### ${i + 1}. [${f.type}] (priority: ${f.priority})`,
          f.content,
          f.createdAt ? `创建于: ${f.createdAt}` : '',
          `ID: ${f.id}`,
        ].filter(Boolean).join('\n');
      }).join('\n\n---\n\n');

      return {
        content: [{
          type: 'text',
          text: `共 ${result.total} 条记忆，显示前 ${result.items.length} 条：\n\n${formatted}`,
        }],
      };
    } catch (err) {
      return {
        content: [{ type: 'text', text: `列出记忆失败: ${err.message}` }],
        isError: true,
      };
    }
  }
);

// ============================================================
// Tool: brain_forget — 删除记忆
// ============================================================

server.tool(
  'brain_forget',
  '从 brain 记忆系统中删除一条记忆片段。',
  {
    id: z.string().describe('要删除的记忆片段 ID'),
  },
  async ({ id }) => {
    try {
      const success = await memoryBackend.forget(id);

      if (success) {
        return {
          content: [{ type: 'text', text: `✅ 已删除记忆: ${id}` }],
        };
      } else {
        return {
          content: [{ type: 'text', text: `未找到记忆: ${id}` }],
          isError: true,
        };
      }
    } catch (err) {
      return {
        content: [{ type: 'text', text: `删除记忆失败: ${err.message}` }],
        isError: true,
      };
    }
  }
);

// ============================================================
// Tool: brain_inject — 构建上下文注入（最重要的工具！）
// ============================================================

server.tool(
  'brain_inject',
  '从会话快照和工作缓冲区组装上下文注入字符串。返回可直接喂给 AI 的上下文摘要。' +
  '这是外部工具（Claude Code / Codex）获取 brain 完整会话状态的最佳入口。',
  {},
  async () => {
    try {
      const cfg = getConfig();
      const snapshotPath = resolvePath(cfg.paths.snapshot);
      const bufferPath = resolvePath(cfg.paths.buffer);

      // 读取 SNAPSHOT
      let snapshot = null;
      try {
        snapshot = fs.readFileSync(snapshotPath, 'utf8');
      } catch {
        // not found
      }

      // 读取工作缓冲区
      let buffer = null;
      try {
        buffer = fs.readFileSync(bufferPath, 'utf8');
      } catch {
        // not found
      }

      if (!snapshot) {
        return {
          content: [{ type: 'text', text: JSON.stringify({
            empty: true,
            hint: 'SNAPSHOT.md 尚未生成',
            nextAction: '运行 build-session-injection.js 或等待 OpenClaw 心跳生成快照',
          }, null, 2) }],
        };
      }

      const info = extractKeyInfo(snapshot);

      // 构造注入片段
      const fragments = [];

      // 用户信息
      fragments.push(`【用户】${info.用户信息.join(' | ') || '未知'}`);

      // 当前任务
      fragments.push(`【进行中】${info.当前任务.join(', ') || '无'}`);

      // 待办
      fragments.push(`【待办】${info.待办.join(', ') || '无'}`);

      // 最近关键结论
      fragments.push(`【最近关键结论】\n${info.最近结论.slice(0, 5).join('\n') || '无'}`);

      // 工作缓冲
      if (buffer) {
        fragments.push(`【工作缓冲】\n${buffer.slice(0, 2000)}`);
      }

      const injection = `【当前会话上下文】\n\n${fragments.join('\n\n')}`;

      // 附加 meta 信息
      const meta = {
        timestamp: new Date().toISOString(),
        estimatedTokens: estimateTokens(injection),
        hardLimitTokens: cfg.limits.injection_max_tokens || 10000,
        sources: { snapshot: !!snapshot, buffer: !!buffer },
      };

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            injection,
            meta,
          }, null, 2),
        }],
      };
    } catch (err) {
      return {
        content: [{ type: 'text', text: `注入构建失败: ${err.message}` }],
        isError: true,
      };
    }
  }
);

// ============================================================
// Tool: brain_cleanup — 清理过期记忆
// ============================================================

server.tool(
  'brain_cleanup',
  '清理 brain 中超过配置天数（默认 180 天）未访问的旧记忆和数据。' +
  '清理范围：MemoryBackend（记忆片段）+ SessionStore（会话/决策/任务）。' +
  '⚠️ 不可逆操作，删除的数据无法恢复。',
  {
    dryRun: z.boolean().optional().default(false).describe('设为 true 只统计不删除，预览清理结果'),
  },
  async ({ dryRun }) => {
    try {
      const cfg = getConfig();
      const daysAbandoned = cfg.limits.days_abandoned || 180;

      // 检查记忆库
      const memStats = await memoryBackend.stats();
      const memCleanResult = dryRun
        ? { removed: 0, kept: memStats.total, cutoff: 'dry-run', note: '预览模式，未执行删除' }
        : await memoryBackend.cleanup(daysAbandoned);

      // 检查会话库
      const sessStats = await sessionStore.stats();
      const sessCleanResult = dryRun
        ? { removed: 0, sessions: sessStats.sessions, note: '预览模式，未执行删除' }
        : await sessionStore.cleanup(daysAbandoned);

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            dryRun,
            config: { daysAbandoned },
            memory: {
              before: memStats,
              after: memCleanResult,
            },
            sessionStore: {
              before: sessStats,
              after: sessCleanResult,
            },
            note: dryRun
              ? '预览模式，未删除任何数据。移除 dryRun 参数执行清理。'
              : `已清理超过 ${daysAbandoned} 天的旧数据。` +
                 '（清理依据：记忆片段的 createdAt 时间，非最后访问时间）',
          }, null, 2),
        }],
      };
    } catch (err) {
      return {
        content: [{ type: 'text', text: `记忆清理失败: ${err.message}` }],
        isError: true,
      };
    }
  }
);

// ============================================================
// Tool: brain_lock_acquire — 获取文件写锁
// ============================================================

server.tool(
  'brain_lock_acquire',
  '获取一个文件的写锁，防止多个子 agent 同时写入导致数据损坏。' +
  '成功返回 { success: true, file, acquiredAt, expiresAt }；' +
  '文件被他人持锁时返回 { success: false, lockedBy, expiresAt }。',
  {
    filePath: z.string().describe('要锁定的文件路径（绝对或相对路径）'),
    agentId: z.string().describe('调用方 agent 标识'),
    ttlMs: z.number().optional().default(300000)
      .describe('锁有效期（毫秒），默认 5 分钟'),
  },
  async ({ filePath, agentId, ttlMs }) => {
    try {
      const result = await fileLockManager.acquire(filePath, agentId, ttlMs);
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      };
    } catch (err) {
      return {
        content: [{ type: 'text', text: `获取写锁失败: ${err.message}` }],
        isError: true,
      };
    }
  }
);

// ============================================================
// Tool: brain_lock_release — 释放文件写锁
// ============================================================

server.tool(
  'brain_lock_release',
  '释放一个文件的写锁。需提供与加锁时相同的 agentId 才能释放。',
  {
    filePath: z.string().describe('要释放的文件路径'),
    agentId: z.string().describe('调用方 agent 标识（需与加锁时一致）'),
  },
  async ({ filePath, agentId }) => {
    try {
      const result = await fileLockManager.release(filePath, agentId);
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      };
    } catch (err) {
      return {
        content: [{ type: 'text', text: `释放写锁失败: ${err.message}` }],
        isError: true,
      };
    }
  }
);

// ============================================================
// Tool: brain_lock_status — 查询锁状态
// ============================================================

server.tool(
  'brain_lock_status',
  '查询一个文件的锁状态。返回 locked / free / expired 三种状态。' +
  'locked 状态还包含持有者和到期时间。',
  {
    filePath: z.string().describe('要查询的文件路径'),
  },
  async ({ filePath }) => {
    try {
      const result = await fileLockManager.status(filePath);
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      };
    } catch (err) {
      return {
        content: [{ type: 'text', text: `查询锁状态失败: ${err.message}` }],
        isError: true,
      };
    }
  }
);

// ============================================================
// Tool: brain_lock_list — 列出活跃锁
// ============================================================

server.tool(
  'brain_lock_list',
  '列出所有活跃（未过期）的文件写锁。可选按 agentId 筛选。',
  {
    agentId: z.string().optional()
      .describe('按 agent 标识筛选（为空时列出全部）'),
  },
  async ({ agentId }) => {
    try {
      const result = agentId
        ? await fileLockManager.listByAgent(agentId)
        : await fileLockManager.listActive();
      return {
        content: [{
          type: 'text',
          text: result.length === 0
            ? JSON.stringify({ locks: [], count: 0 }, null, 2)
            : JSON.stringify({ locks: result, count: result.length }, null, 2),
        }],
      };
    } catch (err) {
      return {
        content: [{ type: 'text', text: `列出锁失败: ${err.message}` }],
        isError: true,
      };
    }
  }
);

// ============================================================
// Tool: brain_lock_force_release — 强制释放锁
// ============================================================

server.tool(
  'brain_lock_force_release',
  '⚠️ 管理员工具：强制释放一个文件写锁，无论锁由谁持有。' +
  '通常在锁持有者异常终止时使用。',
  {
    filePath: z.string().describe('要强制释放锁的文件路径'),
  },
  async ({ filePath }) => {
    try {
      const result = await fileLockManager.forceRelease(filePath);
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      };
    } catch (err) {
      return {
        content: [{ type: 'text', text: `强制释放锁失败: ${err.message}` }],
        isError: true,
      };
    }
  }
);

// ============================================================
// 启动服务
// ============================================================

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // MCP server 通过 stdio 通信，无需 console.log（会干扰协议）
}

main().catch((err) => {
  process.stderr.write(`[brain-mcp] 启动失败: ${err.message}\n`);
  process.exit(1);
});
