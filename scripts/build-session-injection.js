#!/usr/bin/env node
/**
 * 会话注入构建器 v1.1
 * 会话开始前自动组装上下文注入
 *
 * 分层设计：
 * - SNAPSHOT：完整无损（故障恢复用）
 * - 运行时注入：≤10K/token，硬上限（API稳定性用）
 *
 * 用法: node build-session-injection.js
 * 输出: 注入内容文本（JSON格式）
 */

const fs = require('fs');
const path = require('path');
const { getConfig, resolvePath } = require('./load-config.js');

const _cfg = getConfig();
const WORKSPACE = _cfg.workspace;
const SNAPSHOT_PATH = resolvePath(_cfg.paths.snapshot);
const BUFFER_PATH = resolvePath(_cfg.paths.buffer);

// 10K token硬上限（约10KB文本）
const INJECTION_MAX_TOKENS = _cfg.limits.injection_max_tokens;
const INJECTION_MAX_CHARS = INJECTION_MAX_TOKENS * 2; // 中英混排宽松估算

function readFile(p) {
  try { return fs.readFileSync(p, 'utf8'); } catch { return null; }
}

function readTurns() {
  try {
    const data = JSON.parse(fs.readFileSync(path.join(process.env.HOME, '.openclaw/workspace/memory/conversation-turns.json'), 'utf8'));
    return data;
  } catch { return { turns: 0, should_review: false }; }
}

function getSkillHealthSummary() {
  try {
    const reportPath = path.join(process.env.HOME, '.openclaw/workspace/memory/skill-health-report.md');
    if (!fs.existsSync(reportPath)) return null;
    const content = fs.readFileSync(reportPath, 'utf8');
    return extractSummary(content);
  } catch { return null; }
}

function extractSummary(content) {
  const lines = content.split('\n');
  const summary = [];
  for (const line of lines) {
    if (line.startsWith('- ')) summary.push(line.slice(2));
    if (summary.length >= 4) break;
  }
  return summary.join(' | ') || null;
}

/**
 * 估算token数（中英混排）
 * 中文2 token/字，英文1.3 token/字符
 */
function estimateTokens(text) {
  const chinese = (text.match(/[\u4e00-\u9fff]/g) || []).length;
  const english = text.length - chinese;
  return chinese * 2 + Math.floor(english * 1.3);
}

/**
 * 截断到指定token数，保留头部
 */
function truncateToTokens(text, maxTokens) {
  const currentTokens = estimateTokens(text);
  if (currentTokens <= maxTokens) return text;

  // 粗暴二分截断，找到刚好≤maxTokens的位置
  let low = 0, high = text.length;
  while (low + 100 < high) {
    const mid = Math.floor((low + high) / 2);
    if (estimateTokens(text.slice(0, mid)) <= maxTokens) {
      low = mid;
    } else {
      high = mid;
    }
  }
  return text.slice(0, low);
}

/**
 * 压缩单条记忆片段
 * 超过10K → 截断 + 加标注
 */
function safeInjectMemory(label, content, maxTokens) {
  if (!content) return null;

  const originalTokens = estimateTokens(content);
  const originalChars = content.length;

  let safeContent = content;
  let compressed = false;
  let note = '';

  if (originalTokens > maxTokens) {
    safeContent = truncateToTokens(content, maxTokens - 50); // 留空间给标注
    compressed = true;
    note = `\n\n[📌 ${label}已压缩：原始${originalTokens}tokens，完整版见SNAPSHOT]`;
  }

  return {
    label,
    originalTokens,
    injectedTokens: estimateTokens(safeContent),
    compressed,
    note,
    safeContent
  };
}

const { extractKeyInfo } = require("./snapshot-parser.js");

function buildInjection() {
  const snapshot = readFile(SNAPSHOT_PATH);
  const buffer = readFile(BUFFER_PATH);

  if (!snapshot) {
    console.log(JSON.stringify({ error: 'SNAPSHOT not found', injection: '' }));
    return;
  }

  const info = extractKeyInfo(snapshot);

  // 构建各注入片段
  const fragments = [];

  // 片段1：用户信息（优先级最高，尽量完整）
  const userInfo = `【用户】${info.用户信息.join(' | ') || '未知'}`;
  fragments.push(safeInjectMemory('用户信息', userInfo, INJECTION_MAX_TOKENS));

  // 片段2：当前任务
  const currentTask = `【进行中】${info.当前任务.join(', ') || '无'}`;
  fragments.push(safeInjectMemory('当前任务', currentTask, INJECTION_MAX_TOKENS));

  // 片段3：待办
  const todo = `【待办】${info.待办.join(', ') || '无'}`;
  fragments.push(safeInjectMemory('待办', todo, INJECTION_MAX_TOKENS));

  // 片段4：最近关键结论（最多5条）
  const recentConclusions = `【最近关键结论】\n${info.最近结论.slice(0, 5).join('\n')}`;
  fragments.push(safeInjectMemory('最近结论', recentConclusions, INJECTION_MAX_TOKENS));

  // 片段5：工作缓冲（如果存在）
  let bufferResult = null;
  if (buffer) {
    const bufferText = `【工作缓冲】\n${buffer.slice(0, 2000)}`;
    bufferResult = safeInjectMemory('工作缓冲', bufferText, INJECTION_MAX_TOKENS);
    fragments.push(bufferResult);
  }

  // 过滤null，组装最终注入内容
  const validFragments = fragments.filter(Boolean);

  // 计算总token
  const totalTokens = validFragments.reduce((sum, f) => sum + f.injectedTokens, 0);

  const injectionLines = validFragments.map(f => {
    let lines = f.safeContent.split('\n');
    // 不压缩的片段正常输出
    // 压缩过的片段末尾加标注
    if (f.note) {
      lines = lines.concat(['', f.note]);
    }
    return lines.join('\n');
  });

  const injection = `【当前会话上下文】\n\n${injectionLines.join('\n\n')}`;

  const result = {
    injection: injection.trim(),
    meta: {
      timestamp: new Date().toISOString(),
      totalInjectedTokens: totalTokens,
      hardLimitTokens: INJECTION_MAX_TOKENS,
      fragmentCount: validFragments.length,
      compressedFragments: validFragments.filter(f => f.compressed).map(f => f.label),
      sources: { snapshot: !!snapshot, buffer: !!buffer },
      conversationTurns: readTurns(),
      skillHealthStatus: getSkillHealthSummary()
    }
  };

  console.log(JSON.stringify(result, null, 2));
}

buildInjection();
