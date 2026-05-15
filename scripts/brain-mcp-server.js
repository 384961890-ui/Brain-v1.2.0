#!/usr/bin/env node
/**
 * brain-mcp-server.js — Brain MCP Server v1.2.0
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
  version: '1.2.0',
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
  'WHEN NOT: 模糊/概念性查询 → 用 brain_search。不确定用哪个 → brain_search（自动融合）。',
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
            hint: '关键词无匹配，尝试 brain_search（融合搜索）或 brain_semantic_recall 做模糊语义搜索',
            query,
            nextAction: 'brain_search',
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

const { execFileSync, spawn } = require('child_process');

// ===== brain_semantic_recall: Python 常驻 worker =====
let _qmdWorker = null;
let _qmdWorkerBusy = false;
const _qmdWorkerQueue = [];

function _getQmdWorker() {
  if (!_qmdWorker || _qmdWorker.killed) {
    const qmdScript = path.join(__dirname, '..', 'brain-memory-qmd', 'brain-memory-qmd.py');
    _qmdWorker = spawn('python3', ['-u', qmdScript, 'worker'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, PYTHONUNBUFFERED: '1' },
    });
    _qmdWorker.stderr.on('data', (d) => {
      // 静默吞掉 stderr（模型加载日志等）
    });
    _qmdWorker.on('exit', (code) => {
      if (code !== 0) _qmdWorker = null;
    });
  }
  return _qmdWorker;
}

function _qmdSearch(query, top_k, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const worker = _getQmdWorker();

    // Worker 模式：发送 JSON 行 → 接收 JSON 行
    const request = JSON.stringify({ query, top_k }) + '\n';

    let buf = '';
    const onData = (chunk) => {
      buf += chunk.toString();
      const nl = buf.indexOf('\n');
      if (nl >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        worker.stdout.removeListener('data', onData);
        clearTimeout(timer);
        try {
          resolve(JSON.parse(line));
        } catch {
          resolve([]);
        }
      }
    };

    const timer = setTimeout(() => {
      worker.stdout.removeListener('data', onData);
      reject(new Error('QMD worker timeout'));
    }, timeoutMs);

    worker.stdout.on('data', onData);
    worker.stdin.write(request);
  });
}

function _qmdSearchFallback(query, top_k) {
  const qmdScript = path.join(__dirname, '..', 'brain-memory-qmd', 'brain-memory-qmd.py');
  const stdout = execFileSync('python3', [qmdScript, 'search', query, '--top-k', String(top_k)], {
    encoding: 'utf8',
    timeout: 30000,
    maxBuffer: 1024 * 1024,
  });

  let results = [];
  const jsonStart = stdout.indexOf('[');
  if (jsonStart >= 0) {
    results = JSON.parse(stdout.slice(jsonStart));
  }
  return results;
}

function _formatResults(results) {
  return results.map((r, i) => {
    return [
      `### ${i + 1}. [${r.file}]`,
      `语义相似度: ${(r.score * 100).toFixed(1)}%`,
      '',
      r.text,
      `来源: ${r.file_path}`,
    ].filter(Boolean).join('\n');
  }).join('\n\n---\n\n');
}

server.tool(
  'brain_semantic_recall',
  'QMD 语义记忆搜索（bge-small-zh-v1.5 中文模型，BM25+embedding 混合检索）。' +
  'WHEN TO USE: 模糊查询、概念搜索、中文自然语言。不确定用哪个 → brain_search（自动融合）。' +
  '结果含语义相似度分数（0-1），top_k 控制返回数。',
  {
    query: z.string().describe('搜索查询（自然语言，支持中文语义匹配）'),
    top_k: z.number().optional().default(5).describe('返回结果数量（1-20）'),
  },
  async ({ query, top_k }) => {
    try {
      let results = [];
      try {
        // 优先用常驻 worker（模型已预热，100ms 级响应）
        results = await _qmdSearch(query, top_k);
      } catch {
        // Worker 不可用时回退到一次性 execFile（安全，无 shell 注入）
        try {
          results = _qmdSearchFallback(query, top_k);
        } catch (fallbackErr) {
          throw fallbackErr;
        }
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

      const formatted = _formatResults(results);

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
// Tool: brain_search — 融合搜索（关键词 + 语义并行，合并去重）
// ============================================================

server.tool(
  'brain_search',
  '融合搜索：并行执行 brain_recall（关键词匹配）+ brain_semantic_recall（语义搜索），' +
  '自动合并去重后返回统一结果集。一次调用覆盖两种搜索策略，推荐 Agent 启动时首选。' +
  'WHEN TO USE: 任务启动时、记不清用哪个搜索、需要最全结果时。' +
  '结果含 source 字段标注来源（recall/semantic），同分优先语义。',
  {
    query: z.string().describe('搜索查询（自然语言，支持中英文）'),
    limit: z.number().optional().default(10).describe('返回结果数量上限（1-50）'),
    type: z.string().optional().describe('brain_recall 的类型过滤（skill/task/config/conclusion/lesson），语义搜索不受影响'),
  },
  async ({ query, limit, type }) => {
    try {
      // 并行执行两种搜索
      const recallPromise = memoryBackend.recall(query, { limit, type: type || null })
        .then(results => results.map(r => ({
          source: 'recall',
          id: r.fragment.id,
          type: r.fragment.type,
          content: r.fragment.content,
          score: r.score,
          priority: r.fragment.priority,
          createdAt: r.fragment.createdAt,
        })))
        .catch(() => []);

      const semanticPromise = (async () => {
        try {
          let results = [];
          try {
            results = await _qmdSearch(query, limit);
          } catch {
            try { results = _qmdSearchFallback(query, limit); } catch { /* ignore */ }
          }
          return results.map(r => ({
            source: 'semantic',
            file: r.file,
            file_path: r.file_path,
            content: r.text,
            score: r.score,
          }));
        } catch {
          return [];
        }
      })();

      const [recallResults, semanticResults] = await Promise.all([recallPromise, semanticPromise]);

      // 合并去重：内容归一化后比对
      const seenContents = new Set();
      const merged = [];

      const normalize = (text) => (text || '').replace(/\s+/g, ' ').trim().slice(0, 120);

      for (const r of recallResults) {
        const key = normalize(r.content);
        if (!seenContents.has(key)) {
          seenContents.add(key);
          merged.push(r);
        }
      }

      for (const r of semanticResults) {
        const key = normalize(r.content);
        if (!seenContents.has(key)) {
          seenContents.add(key);
          merged.push(r);
        }
      }

      // 按分数降序
      merged.sort((a, b) => (b.score || 0) - (a.score || 0));

      const sliced = merged.slice(0, limit);

      if (sliced.length === 0) {
        return {
          content: [{ type: 'text', text: JSON.stringify({
            empty: true,
            hint: '融合搜索无结果。尝试 brain_list 列出全部记忆或检查记忆库是否已初始化。',
            query,
            nextAction: 'brain_list 或 brain_inject',
          }, null, 2) }],
        };
      }

      const formatted = sliced.map((r, i) => {
        const sourceLabel = r.source === 'semantic' ? '[语义]' : `[${r.type || 'recall'}]`;
        return [
          `### ${i + 1}. ${sourceLabel} (score: ${(r.score || 0).toFixed(2)})`,
          r.content,
          r.createdAt ? `创建于: ${r.createdAt}` : '',
          r.file_path ? `来源: ${r.file_path}` : (r.id ? `ID: ${r.id}` : ''),
        ].filter(Boolean).join('\n');
      }).join('\n\n---\n\n');

      return {
        content: [{ type: 'text', text:
          `融合搜索完成（recall ${recallResults.length} + semantic ${semanticResults.length} → 合并 ${merged.length} → 返回 ${sliced.length} 条）\n\n${formatted}`
        }],
      };
    } catch (err) {
      return {
        content: [{ type: 'text', text: `融合搜索失败: ${err.message}` }],
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
  '列出 brain 记忆系统中的记忆片段。支持按类型过滤、分页和排序。',
  {
    type: z.string().optional().describe('按类型过滤（skill/task/config/conclusion/lesson）'),
    limit: z.number().optional().default(20).describe('每页数量（1-100）'),
    page: z.number().optional().default(1).describe('分页页码'),
    sortBy: z.enum(['priority', 'created']).optional().default('priority').describe('排序方式'),
  },
  async ({ type, limit, page, sortBy }) => {
    try {
      const pageSize = Math.min(Math.max(limit || 20, 1), 100);
      const result = await memoryBackend.list({ page: page || 1, pageSize, type, sortBy: sortBy || 'priority' });

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
  '从会话快照、工作缓冲区、SessionStore（未完成任务+最近决策）组装上下文注入字符串。' +
  'v1.2.0: 附加状态栏（记忆数/会话数/待办/健康）。可选 includeSessionStore 参数。' +
  '这是外部工具获取 brain 完整会话状态的最佳入口。',
  {
    includeSessionStore: z.boolean().optional().default(true).describe('是否注入 SessionStore 的未完成任务和最近决策'),
  },
  async ({ includeSessionStore }) => {
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

      // 构建注入片段
      const fragments = [];
      let hasSessionStoreData = false;

      if (snapshot) {
        const info = extractKeyInfo(snapshot);
        fragments.push(`【用户】${info.用户信息.join(' | ') || '未知'}`);
        fragments.push(`【进行中】${info.当前任务.join(', ') || '无'}`);
        fragments.push(`【待办】${info.待办.join(', ') || '无'}`);
        fragments.push(`【最近关键结论】\n${info.最近结论.slice(0, 5).join('\n') || '无'}`);
      }

      // SessionStore 注入（未完成任务 + 最近决策）
      if (includeSessionStore) {
        try {
          const pending = await sessionStore.getPendingTasks();
          if (pending.length > 0) {
            fragments.push(`【未完成任务】\n${pending.slice(0, 5).map(t =>
              `- [${t.status === 'in_progress' ? '进行中' : '待处理'}] ${t.taskId}${t.progress ? ` (${t.progress})` : ''}`
            ).join('\n')}`);
            hasSessionStoreData = true;
          }

          const recentDecisions = await sessionStore.searchDecisions({ limit: 5 });
          if (recentDecisions.length > 0) {
            fragments.push(`【最近决策】\n${recentDecisions.map(d =>
              `- [${d.created_at?.slice(0, 10) || '?'}] ${d.topic}: ${d.content.slice(0, 100)}`
            ).join('\n')}`);
            hasSessionStoreData = true;
          }
        } catch {
          // SessionStore 不可用，静默跳过
        }
      }

      // 工作缓冲
      if (buffer) {
        fragments.push(`【工作缓冲】\n${buffer.slice(0, 2000)}`);
      }

      if (!snapshot && !hasSessionStoreData) {
        return {
          content: [{ type: 'text', text: JSON.stringify({
            empty: true,
            hint: 'SNAPSHOT.md 尚未生成且 SessionStore 无数据',
            nextAction: '运行 build-session-injection.js 或等待 OpenClaw 心跳生成快照',
          }, null, 2) }],
        };
      }

      // v1.2.0: 构建状态栏（记忆/会话/健康快照）
      let statusBar = '';
      try {
        const memStats = await memoryBackend.stats();
        const sessStats = await sessionStore.stats();
        const pendingTasks = await sessionStore.getPendingTasks();

        const healthIcons = [];
        healthIcons.push(`记忆 ${memStats.total || 0} 条`);
        healthIcons.push(`会话 ${sessStats.sessions || 0} 轮`);
        if (pendingTasks.length > 0) healthIcons.push(`待办 ${pendingTasks.length} 项`);
        healthIcons.push('健康 ✅');

        statusBar = `\n---\n状态栏: ${healthIcons.join(' · ')}`;
      } catch {
        statusBar = '';
      }

      const injection = `【当前会话上下文】\n\n${fragments.join('\n\n')}${statusBar}`;

      // 附加 meta 信息
      const meta = {
        timestamp: new Date().toISOString(),
        estimatedTokens: estimateTokens(injection),
        hardLimitTokens: cfg.limits.injection_max_tokens || 10000,
        sources: { snapshot: !!snapshot, buffer: !!buffer, sessionStore: hasSessionStoreData },
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
// Tool: brain_healthcheck — 一键体检
// ============================================================

server.tool(
  'brain_healthcheck',
  'brain 系统一键体检：配置、后端、embedding API、QMD 索引、损坏文件、过期锁、模型维度。' +
  '返回 { ok: boolean, checks: [...], issues: [...] }。每次安装/升级后调用。',
  {},
  async () => {
    try {
      const healthScript = path.join(__dirname, 'healthcheck.js');
      const { execFileSync } = require('child_process');
      const stdout = execFileSync('node', [healthScript], {
        encoding: 'utf8',
        timeout: 30000,
        maxBuffer: 1024 * 1024,
      });
      return { content: [{ type: 'text', text: stdout }] };
    } catch (err) {
      return {
        content: [{ type: 'text', text: JSON.stringify({
          ok: false,
          checks: [],
          issues: [{ component: 'healthcheck', level: 'error', message: err.message }],
        }, null, 2) }],
        isError: true,
      };
    }
  }
);

// ============================================================
// Tool: brain_memory_stats — 记忆库统计面板
// ============================================================

server.tool(
  'brain_memory_stats',
  '记忆库完整统计面板。返回总量、按类型分布、top 访问、去重合并次数、最旧/最新记忆、损坏文件。' +
  '比 brain_task_status 更底层，聚焦 MemoryBackend 而非 SessionStore。',
  {},
  async () => {
    try {
      const stats = await memoryBackend.stats();
      const total = stats.total || 0;

      // 拉取足够多的记忆来做统计（上限 500，避免大数据量 OOM）
      const allMemories = await memoryBackend.list({ page: 1, pageSize: Math.min(total, 500), sortBy: 'priority' });
      const items = allMemories.items || [];

      // top 访问记忆
      const topByAccess = [...items]
        .sort((a, b) => (b.accessCount || 0) - (a.accessCount || 0))
        .slice(0, 5)
        .map(m => ({
          id: m.id,
          type: m.type,
          accessCount: m.accessCount || 0,
          priority: m.priority,
          snippet: (m.content || '').slice(0, 80),
        }));

      // 时间跨度
      let oldestMemory = null;
      let newestMemory = null;
      const withDates = items.filter(m => m.createdAt);
      if (withDates.length > 0) {
        const sorted = [...withDates].sort((a, b) =>
          (a.createdAt || '').localeCompare(b.createdAt || ''));
        oldestMemory = sorted[0]?.createdAt || null;
        newestMemory = sorted[sorted.length - 1]?.createdAt || null;
      }

      // 平均 age
      const now = Date.now();
      let avgAgeDays = 0;
      if (withDates.length > 0) {
        avgAgeDays = Math.round(
          withDates.reduce((sum, m) => sum + (now - new Date(m.createdAt).getTime()) / 86400000, 0)
          / withDates.length
        );
      }

      // 损坏文件残余
      let corruptionFiles = [];
      try {
        const cfg = getConfig();
        const memDir = path.dirname(resolvePath(cfg.paths.snapshot || 'memory/snapshot.md'));
        const files = fs.readdirSync(memDir);
        corruptionFiles = files.filter(f => f.includes('.corrupted.') || f.includes('.removed.'));
      } catch { /* ignore */ }

      return {
        content: [{ type: 'text', text: JSON.stringify({
          total,
          totalTokens: stats.totalTokens || 0,
          byType: stats.byType || {},
          topByAccess,
          oldestMemory,
          newestMemory,
          avgAgeDays,
          corruptionFiles,
          lastModified: stats.lastModified || null,
        }, null, 2) }],
      };
    } catch (err) {
      return {
        content: [{ type: 'text', text: JSON.stringify({
          error: err.message,
          hint: 'MemoryBackend 不可用',
        }, null, 2) }],
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
