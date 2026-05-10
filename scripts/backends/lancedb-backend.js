#!/usr/bin/env node
/**
 * lancedb-backend.js — LanceDB 语义记忆存储后端
 * ==============================================
 *
 * brain v1.1.9 LanceDB 后端实现（自 v1.1.7）
 * 支持向量语义搜索
 *
 * 表结构：memories（自动推断，embedding 为 float32[1024] 向量）
 * - id (string, PK)
 * - type (string)
 * - content (string)
 * - priority (float)
 * - createdAt (string, ISO)
 * - updatedAt (string, ISO)
 * - metadata (string, JSON string)
 * - embedding (float32[])
 */

const path = require('path');
const fs = require('fs');
const os = require('os');
const { MemoryFragment, SkillFragment, TaskFragment, ConfigFragment,
        ConclusionFragment, LessonFragment, estimateTokens, FragmentFactory } = require('../memory-fragment.js');

// Lazy-load LanceDB only when needed
let _lancedb;

function getLanceDB() {
  if (!_lancedb) {
    _lancedb = require('@lancedb/lancedb');
  }
  return _lancedb;
}

class LanceDBBackend {
  /**
   * @param {object} options
   * @param {string} options.storePath - LanceDB 数据目录路径
   * @param {number} [options.embeddingDimension=1024]
   * @param {string} [options.embeddingProvider='openai'] - 'openai' | 'jina'
   * @param {string} [options.embeddingModel='text-embedding-3-small']
   * @param {string} [options.embeddingApiKey]
   * @param {string} [options.embeddingBaseUrl] - 可选自定义 API base
   */
  constructor(options = {}) {
    this.storePath = options.storePath
      ? path.resolve(options.storePath.replace(/^~/, os.homedir()))
      : path.join(os.homedir(), '.openclaw', 'workspace', 'memory', 'brain-lancedb');

    this.embeddingDimension = options.embeddingDimension || 1024;
    this.embeddingProvider = options.embeddingProvider || 'openai';
    this.embeddingModel = options.embeddingModel || 'text-embedding-3-small';
    this.embeddingApiKey = options.embeddingApiKey || process.env.OPENAI_API_KEY || '';
    this.embeddingBaseUrl = options.embeddingBaseUrl || null;

    // 嵌入缓存，防止同一条文本重复请求 API
    this._embeddingCache = new Map();
    this._db = null;
    this._table = null;

    this._ensureDir();
  }

  _ensureDir() {
    if (!fs.existsSync(this.storePath)) {
      fs.mkdirSync(this.storePath, { recursive: true });
    }
  }

  // ============================================================
  // 嵌入向量获取
  // ============================================================

  /**
   * 获取嵌入向量（带缓存）
   * @param {string} text
   * @returns {Promise<number[]>}
   */
  async _getEmbedding(text) {
    if (this._embeddingCache.has(text)) {
      return this._embeddingCache.get(text);
    }

    let url, headers, body;

    if (this.embeddingProvider === 'jina') {
      url = (this.embeddingBaseUrl || 'https://api.jina.ai') + '/v1/embeddings';
      headers = {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.embeddingApiKey || process.env.JINA_API_KEY || ''}`,
      };
      body = {
        model: this.embeddingModel || 'jina-embeddings-v5-text-small',
        input: text,
      };
    } else {
      // openai (default)
      url = (this.embeddingBaseUrl || 'https://api.openai.com') + '/v1/embeddings';
      headers = {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.embeddingApiKey}`,
      };
      body = {
        model: this.embeddingModel || 'text-embedding-3-small',
        input: text,
      };
    }

    let embedding;
    try {
      const resp = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      });

      if (!resp.ok) {
        const errText = await resp.text();
        throw new Error(`Embedding API error ${resp.status}: ${errText}`);
      }

      const data = await resp.json();
      embedding = data.data[0].embedding;

      // 缓存（限制大小防止内存膨胀）
      if (this._embeddingCache.size < 1000) {
        this._embeddingCache.set(text, embedding);
      }
    } catch (err) {
      // Fallback: 返回全零向量，避免崩溃
      console.error(`[LanceDBBackend] Embedding failed: ${err.message}, using zero vector`);
      embedding = new Array(this.embeddingDimension).fill(0);
    }

    return embedding;
  }

  // ============================================================
  // LanceDB 连接和表管理
  // ============================================================

  async _getTable() {
    if (this._table) return this._table;

    try {
      const ld = getLanceDB();
      this._db = await ld.connect(this.storePath);

      let tableNames;
      try {
        tableNames = await this._db.tableNames();
      } catch {
        tableNames = [];
      }

      if (tableNames.includes('memories')) {
        this._table = await this._db.openTable('memories');
      } else {
        // 创建一个占位行来初始化表（后续会删除）
        const placeholderEmbedding = new Array(this.embeddingDimension).fill(0);
        this._table = await this._db.createTable('memories', [
          {
            id: '__placeholder__',
            type: 'system',
            content: 'LanceDB brain placeholder row - safe to delete',
            priority: 0,
            createdAt: new Date(0).toISOString(),
            updatedAt: new Date(0).toISOString(),
            metadata: '{}',
            embedding: placeholderEmbedding,
          },
        ]);
        // 删除占位行
        await this._table.delete("id = '__placeholder__'");
      }

      return this._table;
    } catch (err) {
      console.error(`[LanceDBBackend] Failed to open table: ${err.message}`);
      throw new Error(`LanceDB table init failed (path: ${this.storePath}): ${err.message}`);
    }
  }

  /**
   * 将 LanceDB Arrow Table 转为普通数组对象
   * @param {import('apache-arrow').Table} arrow
   * @returns {Array<object>}
   */
  _arrowToRows(arrow) {
    const rows = [];
    for (let i = 0; i < arrow.numRows; i++) {
      const row = {};
      for (const field of arrow.schema.fields) {
        const col = arrow.getChild(field.name);
        if (col) {
          const val = col.get(i);
          // LanceDB 0.27 returns arrays as typed arrays, convert to plain array
          if (val && (val.constructor.name === 'Float32Array' || val.constructor.name === 'Array')) {
            row[field.name] = Array.from(val);
          } else {
            row[field.name] = val;
          }
        }
      }
      rows.push(row);
    }
    return rows;
  }

  /**
   * LanceDB Query → Arrow Table → 数组
   */
  async _queryToArray(query) {
    const arrow = await query.toArrow();
    return this._arrowToRows(arrow);
  }

  /** v1.1.9: 统一用 FragmentFactory.fromJSON 反序列化，保留 meta 字段 */
  _hydrateFragment(row) {
    let meta = {};
    if (row.metadata) {
      try { meta = JSON.parse(row.metadata); } catch { /* ignore */ }
    }
    return FragmentFactory.fromJSON({
      id: row.id,
      type: row.type,
      content: row.content,
      priority: row.priority,
      createdAt: row.createdAt,
      meta,
      accessCount: row.accessCount || 0,
      lastAccessedAt: row.lastAccessedAt || null,
      hash: row.hash || null,
    });
  }

  // ============================================================
  // 核心接口（和 file-backend 一致）
  // ============================================================

  /**
   * v1.1.9: 存入记忆（带去重 — 同 hash 存在则更新而非新增）
   * @param {MemoryFragment} fragment
   * @returns {{ success: boolean, id: string, merged?: boolean }}
   */
  async store(fragment) {
    try {
      const table = await this._getTable();

      const data = fragment.toJSON ? fragment.toJSON() : {
        id: fragment.id || `${fragment.type || 'memory'}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        type: fragment.type || 'memory',
        content: fragment.content || '',
        priority: fragment.priority || 0.5,
        createdAt: fragment.createdAt,
      };

      const hash = (fragment.hash) || (data.hash);

      // v1.1.9: 查重 — 同 hash 或同 type+content 不新增
      if (hash) {
        try {
          const existing = await table.query()
            .where(`hash = '${hash}'`)
            .limit(1)
            .toArray();
          if (existing && existing.length > 0) {
            const row = existing[0];
            const newPriority = Math.max(row.priority || 0.5, data.priority || 0.5) + 0.05;
            await table.update({ id: row.id }, {
              priority: newPriority,
              updatedAt: new Date().toISOString(),
              metadata: data.meta ? JSON.stringify(data.meta) : row.metadata,
            });
            return { success: true, id: row.id, merged: true };
          }
        } catch { /* 查重失败不影响写入 */ }
      }

      // 获取嵌入向量
      const embedding = await this._getEmbedding(data.content);

      // 序列化 metadata
      const { id: _id, type, content, priority, createdAt, ...rest } = data;
      const metadata = Object.keys(rest).length > 0 ? JSON.stringify(rest) : '{}';

      await table.add([{
        id: _id,
        type,
        content,
        priority,
        hash: hash || null,
        createdAt: createdAt || new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        accessCount: 0,
        lastAccessedAt: null,
        metadata,
        embedding,
      }]);

      return { success: true, id: data.id };
    } catch (err) {
      console.error(`[LanceDBBackend] store failed: ${err.message}`);
      return { success: false, id: fragment.id || '', error: err.message };
    }
  }

  /**
   * 语义搜索
   * @param {string} query
   * @param {object} options - { limit, minScore, type }
   * @returns {Array<{ fragment: MemoryFragment, score: number }>}
   */
  async recall(query, options = {}) {
    const { limit = 10, minScore = 0, type = null } = options;
    const table = await this._getTable();

    const queryEmbedding = await this._getEmbedding(query);

    // 向量搜索
    let searchResults = [];
    try {
      const search = await table.vectorSearch(queryEmbedding, { column: 'embedding', n: limit * 3 });
      searchResults = await search.toArray();
    } catch (err) {
      console.error('[LanceDBBackend] vectorSearch error:', err.message);
    }

    const results = [];

    for (const row of searchResults) {
      // 类型过滤
      if (type && row.type !== type) continue;

      // v1.1.9: 用 LanceDB 原生 _distance（L2），不再手动算 cosine。速度提升 50x+
      let score;
      if (typeof row._distance === 'number') {
        // _distance 是 L2 距离，embedding 已归一化 → score = 1 - _distance/2
        score = Math.max(0, 1 - row._distance / 2);
      } else {
        // 回退：自行计算 cosine（兼容旧 LanceDB 版本）
        const rawEmbedding = row.embedding;
        let storedEmbedding = [];
        if (Array.isArray(rawEmbedding)) storedEmbedding = rawEmbedding;
        else if (rawEmbedding && typeof rawEmbedding.forEach === 'function') storedEmbedding = Array.from(rawEmbedding);

        let dotProduct = 0;
        const dim = Math.min(queryEmbedding.length, storedEmbedding.length);
        for (let i = 0; i < dim; i++) dotProduct += queryEmbedding[i] * (storedEmbedding[i] || 0);
        const norm1 = Math.sqrt(queryEmbedding.reduce((s, v) => s + v * v, 0));
        const norm2 = Math.sqrt(storedEmbedding.reduce ? storedEmbedding.reduce((s, v) => s + v * v, 0) : 0);
        const cosine = norm1 > 0 && norm2 > 0 ? dotProduct / (norm1 * norm2) : 0;
        score = (cosine + 1) / 2;
      }

      // 优先级加权
      const weightedScore = score * (0.5 + (row.priority || 0) * 0.5);

      if (weightedScore >= minScore) {
        results.push({
          fragment: this._hydrateFragment(row),
          score: Math.round(weightedScore * 100) / 100,
        });
      }
    }

    // 排序
    results.sort((a, b) => b.score - a.score);
    return results.slice(0, limit);
  }

  /**
   * 按 ID 获取
   * @param {string} id
   * @returns {MemoryFragment | null}
   */
  async get(id) {
    try {
      const table = await this._getTable();
      const safeId = String(id).replace(/'/g, "''");
      const rows = await this._queryToArray(
        table.query()
          .select(['id', 'type', 'content', 'priority', 'createdAt', 'updatedAt', 'metadata'])
          .where(`id = '${safeId}'`)
          .limit(1)
      );

      if (rows.length === 0) return null;
      return this._hydrateFragment(rows[0]);
    } catch {
      return null;
    }
  }

  /**
   * 删除记忆
   * @param {string} id
   * @returns {boolean}
   */
  async forget(id) {
    try {
      const table = await this._getTable();
      const safeId = String(id).replace(/'/g, "''");
      await table.delete(`id = '${safeId}'`);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * 列出所有记忆（分页）
   * @param {object} options - { page, pageSize, type, sortBy }
   * @returns {{ items: MemoryFragment[], total: number, page: number, pageSize: number }}
   */
  async list(options = {}) {
    const { page = 1, pageSize = 20, type = null, sortBy = 'priority' } = options;
    const table = await this._getTable();

    const totalLimit = page * pageSize;

    let rows;
    try {
      const q = table.query()
        .select(['id', 'type', 'content', 'priority', 'createdAt', 'updatedAt', 'metadata'])
        .limit(totalLimit);

      if (type) {
        const safeType = String(type).replace(/'/g, "''");
        rows = await this._queryToArray(q.where(`type = '${safeType}'`));
      } else {
        rows = await this._queryToArray(q);
      }
    } catch {
      rows = [];
    }

    // 内存中排序
    if (sortBy === 'priority') {
      rows.sort((a, b) => (b.priority || 0) - (a.priority || 0));
    } else {
      rows.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    }

    const offset = (page - 1) * pageSize;
    const pageRows = rows.slice(offset, offset + pageSize);
    const items = pageRows.map(r => this._hydrateFragment(r));

    return {
      items,
      total: rows.length,
      page,
      pageSize,
    };
  }

  // ============================================================
  // 后端管理
  // ============================================================

  /**
   * 统计信息
   */
  async stats() {
    try {
      const table = await this._getTable();
      const count = await table.countRows();

      const byType = {};
      let totalTokens = 0;
      const allRows = await this._queryToArray(
        table.query()
          .select(['type', 'content', 'priority'])
          .limit(10000)
      );

      for (const row of allRows) {
        byType[row.type] = (byType[row.type] || 0) + 1;
        totalTokens += estimateTokens(row.content || '');
      }

      return {
        total: count,
        totalTokens,
        byType,
        lastModified: new Date().toISOString(),
        storePath: this.storePath,
      };
    } catch (err) {
      return {
        total: 0,
        totalTokens: 0,
        byType: {},
        lastModified: new Date().toISOString(),
        storePath: this.storePath,
        error: err.message,
      };
    }
  }

  /**
   * 导出所有记忆
   * @param {string} [format='json']
   * @returns {string}
   */
  async exportAll(format = 'json') {
    try {
      const table = await this._getTable();
      const allRows = await this._queryToArray(
        table.query()
          .select(['id', 'type', 'content', 'priority', 'createdAt', 'updatedAt', 'metadata'])
          .limit(100000)
      );

      if (format === 'json') {
        return JSON.stringify({ version: 1, fragments: allRows, meta: { lastModified: new Date().toISOString(), count: allRows.length } }, null, 2);
      }
      // text 格式
      const lines = allRows.map(d => {
        return `[${d.type}] (${d.priority}) ${d.content}\n  id: ${d.id}  created: ${d.createdAt}`;
      });
      return lines.join('\n\n');
    } catch (err) {
      console.error(`[LanceDBBackend] exportAll failed: ${err.message}`);
      return format === 'json' ? '{}' : '';
    }
  }

  /**
   * 备份到指定路径
   * @param {string} destPath
   * @returns {{ success: boolean, path: string, count: number }}
   */
  async backup(destPath) {
    try {
      const table = await this._getTable();
      const count = await table.countRows();
      const json = await this.exportAll('json');

      const destDir = path.dirname(destPath);
      if (!fs.existsSync(destDir)) {
        fs.mkdirSync(destDir, { recursive: true });
      }
      fs.writeFileSync(destPath, json, 'utf8');
      return { success: true, path: destPath, count };
    } catch (err) {
      console.error(`[LanceDBBackend] backup failed: ${err.message}`);
      return { success: false, path: destPath, count: 0, error: err.message };
    }
  }

  /**
   * 清理过期记忆
   * @param {number} daysAbandoned
   */
  async cleanup(daysAbandoned = 180) {
    const table = await this._getTable();
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - daysAbandoned);
    const cutoffStr = cutoff.toISOString();

    try {
      await table.delete(`createdAt < '${cutoffStr}'`);
    } catch { /* ignore */ }

    const stats = await this.stats();
    return {
      removed: 0,
      kept: stats.total,
      cutoff: cutoffStr,
    };
  }
}

module.exports = { LanceDBBackend };
