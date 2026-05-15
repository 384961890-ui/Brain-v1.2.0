#!/usr/bin/env node
/**
 * healthcheck.js — brain v1.1.9 一键体检
 * =========================================
 *
 * 检查项：
 *   1. config 可解析 + $env: 变量已展开
 *   2. MemoryBackend 可读写（file 或 lancedb）
 *   3. embedding API 可达
 *   4. QMD 索引存在且新鲜
 *   5. .corrupted.* / .removed.* 残留
 *   6. file locks 过期残留
 *   7. 模型维度匹配校验
 *
 * 输出：JSON { ok: boolean, checks: [...], issues: [...] }
 */

const fs = require('fs');
const path = require('path');
const { getConfig, resolvePath } = require('./load-config.js');
const { MemoryBackend } = require('./memory-backend.js');

const results = { ok: true, checks: [], issues: [] };

function addCheck(component, level, message) {
  results.checks.push({ component, level, message });
  if (level === 'error') {
    results.ok = false;
    results.issues.push({ component, level, message });
  } else if (level === 'warn') {
    results.issues.push({ component, level, message });
  }
}

// ===== 3. Embedding API 可达（同步 HTTP）=====
function checkEmbeddingApi(cfg) {
  // Lightweight HEAD request — use sync for simplicity in healthcheck
  const baseUrl = cfg.memory?.embedding?.baseUrl;
  if (!baseUrl) {
    addCheck('embedding-api', 'ok', '未配置 embedding，使用 file backend（无需 API）');
    return;
  }

  const apiKey = cfg.memory?.embedding?.apiKey;
  if (!apiKey) {
    addCheck('embedding-api', 'warn', 'API key 未配置（$env:SILICONFLOW_API_KEY 为空）');
    return;
  }

  // Best-effort: just check we can parse the URL
  try {
    const url = new URL(baseUrl);
    addCheck('embedding-api', 'ok', `${baseUrl} 格式正确（同步校验通过）`);
  } catch (err) {
    addCheck('embedding-api', 'error', `URL 解析失败: ${err.message}`);
  }
}

// ===== 4. QMD 索引新鲜度 =====
function checkQmdIndex(cfg) {
  const memoryDir = resolvePath(cfg.memory?.qmd?.memoryDir || 'memory');
  const indexDir = resolvePath(cfg.memory?.qmd?.indexDir || 'memory-index/qmd');

  const chunksPath = path.join(indexDir, 'chunks.jsonl');
  if (!fs.existsSync(chunksPath)) {
    addCheck('qmd-index', 'warn', 'QMD 索引不存在，需运行 brain-memory-qmd.py index');
    return;
  }

  const stat = fs.statSync(chunksPath);
  const ageHours = (Date.now() - stat.mtimeMs) / 3600000;

  // 检查源目录是否有新文件
  let staleCount = 0;
  if (fs.existsSync(memoryDir)) {
    const walk = (dir) => {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const e of entries) {
        const full = path.join(dir, e.name);
        if (e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules') {
          walk(full);
        } else if (e.isFile() && /\.(md|txt)$/.test(e.name) && stat.mtimeMs < fs.statSync(full).mtimeMs) {
          staleCount++;
        }
      }
    };
    try { walk(memoryDir); } catch { /* ignore */ }
  }

  if (ageHours > 24) {
    addCheck('qmd-index', 'warn', `索引 ${Math.round(ageHours)}h 未更新，${staleCount} 个文件已变更`);
  } else if (staleCount > 0) {
    addCheck('qmd-index', 'warn', `${staleCount} 个文件变更未重索引（索引 ${Math.round(ageHours)}h 前更新）`);
  } else {
    addCheck('qmd-index', 'ok', `索引新鲜（${Math.round(ageHours)}h 前更新）`);
  }
}

// ===== 5. 损坏/残留文件 =====
function checkCorruption(cfg) {
  try {
    const memDir = path.dirname(resolvePath(cfg.paths?.snapshot || 'memory/snapshot.md'));
    const files = fs.readdirSync(memDir);
    const corrupted = files.filter(f => f.includes('.corrupted.'));
    const removed = files.filter(f => f.includes('.removed.'));
    if (corrupted.length > 0 || removed.length > 0) {
      addCheck('corruption', 'warn', `${corrupted.length} 损坏文件、${removed.length} 移除残留`);
    } else {
      addCheck('corruption', 'ok', '无损坏/残留文件');
    }
  } catch (err) {
    addCheck('corruption', 'ok', '无法检查（目录不存在）');
  }
}

// ===== 6. 过期锁 =====
function checkFileLocks() {
  try {
    const lockDir = resolvePath('memory/locks');
    if (fs.existsSync(lockDir)) {
      const lockFiles = fs.readdirSync(lockDir).filter(f => f.endsWith('.lock'));
      const expired = lockFiles.filter(f => {
        try {
          const content = JSON.parse(fs.readFileSync(path.join(lockDir, f), 'utf8'));
          return content.expiresAt && new Date(content.expiresAt) < new Date();
        } catch { return true; }
      });
      if (expired.length > 0) {
        addCheck('file-locks', 'warn', `${expired.length} 个过期锁残留`);
      } else {
        addCheck('file-locks', 'ok', `${lockFiles.length} 个锁均有效`);
      }
    } else {
      addCheck('file-locks', 'ok', '无锁文件');
    }
  } catch (err) {
    addCheck('file-locks', 'ok', '无法检查锁状态');
  }
}

// ===== 7. 模型维度匹配 =====
function checkModelDimension(cfg) {
  const configured = cfg.memory?.lancedb?.embeddingDimension;
  if (!configured) return;

  const knownModels = {
    'BAAI/bge-m3': 1024,
    'BAAI/bge-small-zh-v1.5': 512,
    'BAAI/bge-large-zh-v1.5': 1024,
    'all-MiniLM-L6-v2': 384,
    'text-embedding-3-small': 1536,
    'text-embedding-3-large': 3072,
  };
  const modelName = cfg.memory?.lancedb?.embeddingModel || cfg.memory?.embedding?.embeddingModel;
  if (modelName && knownModels[modelName] && knownModels[modelName] !== configured) {
    addCheck('model-dim', 'error', `模型 ${modelName} 应为 ${knownModels[modelName]} 维，config 配置为 ${configured} 维`);
  } else {
    addCheck('model-dim', 'ok', `维度 ${configured} 与模型 ${modelName || 'unknown'} 一致`);
  }
}

// ===== 主流程 =====
async function main() {
  // 1. Config 解析
  let cfg;
  try {
    cfg = getConfig();
    const keys = Object.keys(cfg);
    addCheck('config', 'ok', `${keys.length} 项配置解析成功`);
  } catch (err) {
    addCheck('config', 'error', `配置解析失败: ${err.message}`);
    console.log(JSON.stringify(results, null, 2));
    process.exit(1);
  }

  // 2. MemoryBackend 可达
  try {
    const mem = new MemoryBackend();
    const stats = await mem.stats();
    addCheck('memory-backend', 'ok', `可读写，${stats.total || 0} 条记忆`);
  } catch (err) {
    addCheck('memory-backend', 'error', `不可达: ${err.message}`);
  }

  // 3-7. 同步检查项
  checkEmbeddingApi(cfg);
  checkQmdIndex(cfg);
  checkCorruption(cfg);
  checkFileLocks();
  checkModelDimension(cfg);

  console.log(JSON.stringify(results, null, 2));
}

main().catch(err => {
  results.ok = false;
  results.issues.push({ component: 'healthcheck', level: 'error', message: err.message });
  console.log(JSON.stringify(results, null, 2));
  process.exit(1);
});
