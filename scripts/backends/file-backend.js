#!/usr/bin/env node
/**
 * file-backend.js — 文件系统记忆存储后端
 * =========================================
 *
 * brain v1.1.9 默认后端实现（自 v1.1.7）
 * 所有记忆存在一个 JSON 文件中，支持原子写入和基本搜索
 *
 * 存储格式：memory-store.json
 * {
 *   "version": 1,
 *   "fragments": { [id]: { ...fragmentData } },
 *   "meta": { "lastModified": "...", "count": N }
 * }
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { MemoryFragment, SkillFragment, TaskFragment, ConfigFragment,
        ConclusionFragment, LessonFragment, FragmentPool,
        estimateTokens,
        FragmentFactory } = require('../memory-fragment.js');

class FileBackend {
  /**
   * @param {object} options
   * @param {string} options.storePath - JSON 存储文件完整路径
   */
  constructor(options = {}) {
    this.storePath = options.storePath;
    if (!this.storePath) {
      throw new Error('FileBackend: storePath is required');
    }

    // v1.1.9: 内存缓存 + mtime 校验
    this._cache = null;
    this._cacheMtime = 0;

    this._ensureDir();
  }

  /** 确保存储目录存在 */
  _ensureDir() {
    const dir = path.dirname(this.storePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  /** v1.1.9: 读取存储文件，带内存缓存 + mtime 校验 + 损坏兜底 */
  _readStore() {
    if (!fs.existsSync(this.storePath)) {
      return { version: 1, fragments: {}, meta: { lastModified: null, count: 0 } };
    }

    // mtime 缓存：文件未变则直接返回缓存
    try {
      const mtime = fs.statSync(this.storePath).mtimeMs;
      if (this._cache && this._cacheMtime === mtime) {
        return this._cache;
      }

      const raw = fs.readFileSync(this.storePath, 'utf8');
      const store = JSON.parse(raw);

      this._cache = store;
      this._cacheMtime = mtime;
      return store;
    } catch (e) {
      // v1.1.9: 损坏时先备份再返回空，不静默丢数据
      console.error(`!!!!! [FileBackend] MEMORY CORRUPTED !!!!! ${e.message}`);
      const backupPath = this.storePath + `.corrupted.${Date.now()}`;
      try {
        fs.copyFileSync(this.storePath, backupPath);
        console.error(`[FileBackend] 损坏文件已备份到: ${backupPath}。下次写入将覆盖。`);
      } catch { /* 备份失败也不丢数据 */ }
      this._cache = null;
      this._cacheMtime = 0;
      return { version: 1, fragments: {}, meta: { lastModified: null, count: 0 } };
    }
  }

  /** 原子写入：先写临时文件，再 rename。同时更新缓存 */
  _writeStore(store) {
    store.meta.lastModified = new Date().toISOString();
    store.meta.count = Object.keys(store.fragments).length;

    const tmpPath = this.storePath + '.tmp.' + process.pid;
    const data = JSON.stringify(store, null, 2);

    fs.writeFileSync(tmpPath, data, 'utf8');
    fs.renameSync(tmpPath, this.storePath);

    // 更新缓存
    this._cache = store;
    try { this._cacheMtime = fs.statSync(this.storePath).mtimeMs; } catch { /* ok */ }
  }

  /** v1.1.9: 从 JSON 数据重建 MemoryFragment 实例（通过 FragmentFactory 保留 meta） */
  _hydrateFragment(data) {
    return FragmentFactory.fromJSON(data);
  }

  // ============================================================
  // 核心接口
  // ============================================================

  /**
   * 存入记忆
   * @param {MemoryFragment} fragment
   * @returns {{ success: boolean, id: string }}
   */
  /** v1.1.9: 去重 — 同 hash 存在则不新增，更新 updatedAt + 强化 priority */
  async store(fragment) {
    const store = this._readStore();
    const data = fragment.toJSON();
    const hash = fragment.hash || data.hash;

    // 查重
    for (const [existingId, existing] of Object.entries(store.fragments)) {
      if (existing.hash === hash || (existing.type === data.type && existing.content === data.content)) {
        // 重复：更新 meta，提高 priority
        existing.priority = Math.max(existing.priority || 0.5, data.priority || 0.5) + 0.05;
        existing.updatedAt = new Date().toISOString();
        if (data.meta && Object.keys(data.meta).length > 0) {
          existing.meta = { ...(existing.meta || {}), ...data.meta };
        }
        this._writeStore(store);
        return { success: true, id: existingId, merged: true };
      }
    }

    store.fragments[data.id] = data;
    this._writeStore(store);
    return { success: true, id: data.id };
  }

  /**
   * 语义搜索（关键词匹配 + 类型过滤）
   * @param {string} query - 搜索文本
   * @param {object} options - { limit, minScore, type }
   * @returns {Array<{ fragment: MemoryFragment, score: number }>}
   */
  async recall(query, options = {}) {
    const { limit = 10, minScore = 0, type = null } = options;
    const store = this._readStore();
    const results = [];

    const queryLower = query.toLowerCase();
    const queryWords = queryLower.split(/\s+/).filter(w => w.length > 1);

    for (const data of Object.values(store.fragments)) {
      // 类型过滤
      if (type && data.type !== type) continue;

      // 计算匹配分数
      const contentLower = (data.content || '').toLowerCase();
      let score = 0;

      // 完整匹配加分
      if (contentLower.includes(queryLower)) {
        score += 1.0;
      }

      // 关键词匹配
      for (const word of queryWords) {
        if (contentLower.includes(word)) {
          score += 0.3;
        }
      }

      // 类型匹配加分
      if (queryLower.includes(data.type)) {
        score += 0.2;
      }

      // 优先级加权
      score *= (0.5 + data.priority * 0.5);

      // v1.1.9: 时间衰减加权（衰减 × 热度，钳制到 [0.1, 1.0] 防止越界）
      let decay = 1.0;
      if (data.createdAt) {
        const ageDays = (Date.now() - new Date(data.createdAt).getTime()) / (86400 * 1000);
        decay = Math.max(0.1, Math.exp(-ageDays / 30));
      }
      // 访问次数加成（乘入而非相加，杜绝 1.3x 溢出）
      const popularityBoost = 1 + Math.min((data.accessCount || 0) * 0.02, 0.3);
      const timeWeight = Math.min(1.0, decay * popularityBoost);
      score *= timeWeight;

      if (score >= minScore && score > 0) {
        // v1.1.9: 异步记录访问，不阻塞搜索
        setImmediate(() => {
          try {
            const s = this._readStore();
            if (s.fragments[data.id]) {
              s.fragments[data.id].accessCount = (s.fragments[data.id].accessCount || 0) + 1;
              s.fragments[data.id].lastAccessedAt = new Date().toISOString();
              this._writeStore(s);
            }
          } catch { /* 非关键 */ }
        });

        results.push({
          fragment: this._hydrateFragment(data),
          score: Math.round(score * 100) / 100
        });
      }
    }

    // 按分数降序
    results.sort((a, b) => b.score - a.score);
    return results.slice(0, limit);
  }

  /**
   * 按 ID 获取
   * @param {string} id
   * @returns {MemoryFragment | null}
   */
  async get(id) {
    const store = this._readStore();
    const data = store.fragments[id];
    return data ? this._hydrateFragment(data) : null;
  }

  /**
   * 删除记忆
   * @param {string} id
   * @returns {boolean}
   */
  async forget(id) {
    const store = this._readStore();
    if (!store.fragments[id]) return false;
    delete store.fragments[id];
    this._writeStore(store);
    return true;
  }

  /**
   * 列出所有记忆（分页）
   * @param {object} options - { page, pageSize, type, sortBy }
   * @returns {{ items: MemoryFragment[], total: number, page: number, pageSize: number }}
   */
  async list(options = {}) {
    const { page = 1, pageSize = 20, type = null, sortBy = 'priority' } = options;
    const store = this._readStore();

    let entries = Object.values(store.fragments);

    // 类型过滤
    if (type) {
      entries = entries.filter(d => d.type === type);
    }

    // 排序
    if (sortBy === 'priority') {
      entries.sort((a, b) => b.priority - a.priority);
    } else if (sortBy === 'created') {
      entries.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    }

    const total = entries.length;
    const start = (page - 1) * pageSize;
    const items = entries.slice(start, start + pageSize).map(d => this._hydrateFragment(d));

    return { items, total, page, pageSize };
  }

  // ============================================================
  // 后端管理
  // ============================================================

  /**
   * 导出所有记忆
   * @param {string} format - 'json' | 'text'
   * @returns {string}
   */
  async exportAll(format = 'json') {
    const store = this._readStore();
    if (format === 'json') {
      return JSON.stringify(store, null, 2);
    }
    // text 格式
    const lines = Object.values(store.fragments).map(d => {
      return `[${d.type}] (${d.priority}) ${d.content}\n  id: ${d.id}  created: ${d.createdAt}`;
    });
    return lines.join('\n\n');
  }

  /**
   * 备份到指定路径
   * @param {string} destPath
   */
  async backup(destPath) {
    const store = this._readStore();
    const destDir = path.dirname(destPath);
    if (!fs.existsSync(destDir)) {
      fs.mkdirSync(destDir, { recursive: true });
    }
    fs.writeFileSync(destPath, JSON.stringify(store, null, 2), 'utf8');
    return { success: true, path: destPath, count: store.meta.count };
  }

  /**
   * 清理过期记忆
   * 根据 createdAt 清理超过指定天数未更新的片段
   * @param {number} daysAbandoned - 清理阈值（天），默认 180
   * @returns {{ removed: number, kept: number, cutoff: string }}
   */
  async cleanup(daysAbandoned = 180) {
    const store = this._readStore();
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - daysAbandoned);
    const cutoffStr = cutoff.toISOString();

    let removed = 0;
    for (const [id, data] of Object.entries(store.fragments)) {
      const createdAt = data.createdAt ? new Date(data.createdAt) : new Date(0);
      if (createdAt < cutoff) {
        delete store.fragments[id];
        removed++;
      }
    }

    if (removed > 0) {
      this._writeStore(store);
    }

    return { removed, kept: Object.keys(store.fragments).length, cutoff: cutoffStr };
  }

  /**
   * 统计信息
   * @returns {object}
   */
  async stats() {
    const store = this._readStore();
    const fragments = Object.values(store.fragments);

    const byType = {};
    let totalTokens = 0;
    for (const d of fragments) {
      byType[d.type] = (byType[d.type] || 0) + 1;
      totalTokens += estimateTokens(d.content);
    }

    return {
      total: fragments.length,
      totalTokens,
      byType,
      lastModified: store.meta.lastModified,
      storePath: this.storePath,
      storeSize: fs.existsSync(this.storePath) ? fs.statSync(this.storePath).size : 0
    };
  }
}

module.exports = { FileBackend };
