#!/usr/bin/env node
/**
 * memory-backend.js — 统一记忆接口抽象层
 * =========================================
 *
 * brain v1.1.9 记忆系统统一入口（自 v1.1.7）
 * 支持后端可插拔：当前用文件系统，后续可换 SQLite/LanceDB/Chroma
 *
 * 用法：
 *   const { MemoryBackend } = require('./memory-backend.js');
 *   const backend = new MemoryBackend();  // 使用默认配置
 *   await backend.store(fragment);
 *   const results = await backend.recall('飞书图片');
 */

const path = require('path');
const fs = require('fs');
const { getConfig, resolvePath } = require('./load-config.js');
const { MemoryFragment, SkillFragment, TaskFragment, ConfigFragment,
        ConclusionFragment, LessonFragment, FragmentPool } = require('./memory-fragment.js');

// 后端注册表（懒加载）
const BACKEND_REGISTRY = {
  file: () => require('./backends/file-backend.js').FileBackend,
  lancedb: () => require('./backends/lancedb-backend.js').LanceDBBackend,
};

class MemoryBackend {
  /**
   * @param {object} [options]
   * @param {string} [options.type='file'] - 后端类型
   * @param {string} [options.storePath] - 存储路径（覆盖配置）
   * @param {object} [options.backendOptions] - 传递给后端的额外参数
   */
  constructor(options = {}) {
    const config = getConfig();

    this.backendType = options.type || config.memory?.type || 'file';

    // 解析存储路径
    let storePath;
    if (this.backendType === 'lancedb') {
      storePath = options.storePath
        || (config.memory?.lancedb?.storePath ? resolvePath(config.memory.lancedb.storePath) : null)
        || resolvePath('memory/brain-lancedb');
    } else {
      storePath = options.storePath
        || (config.paths.memory_store ? resolvePath(config.paths.memory_store) : null)
        || resolvePath('memory/memory-store.json');
    }

    // 实例化后端
    const BackendFactory = BACKEND_REGISTRY[this.backendType];
    if (!BackendFactory) {
      throw new Error(`MemoryBackend: 未知后端类型 "${this.backendType}"，可选: ${Object.keys(BACKEND_REGISTRY).join(', ')}`);
    }

    const BackendClass = BackendFactory();

    // 构建后端构造参数
    const backendOptions = { storePath, ...options.backendOptions };

    // lancedb 专用配置
    if (this.backendType === 'lancedb' && config.memory?.lancedb) {
      const lc = config.memory.lancedb;
      if (lc.embeddingDimension) backendOptions.embeddingDimension = lc.embeddingDimension;
      if (lc.embeddingProvider) backendOptions.embeddingProvider = lc.embeddingProvider;
      if (lc.embeddingModel) backendOptions.embeddingModel = lc.embeddingModel;
      if (lc.embeddingApiKey) backendOptions.embeddingApiKey = lc.embeddingApiKey;
      if (lc.embeddingBaseUrl) backendOptions.embeddingBaseUrl = lc.embeddingBaseUrl;
    }

    this._backend = new BackendClass(backendOptions);
  }

  // ============================================================
  // 核心接口（委托给后端）
  // ============================================================

  /**
   * 存入记忆
   * @param {MemoryFragment} fragment
   * @returns {Promise<{ success: boolean, id: string }>}
   */
  async store(fragment) {
    return this._backend.store(fragment);
  }

  /**
   * 语义搜索
   * @param {string} query
   * @param {object} [options] - { limit, minScore, type }
   * @returns {Promise<Array<{ fragment: MemoryFragment, score: number }>>}
   */
  async recall(query, options = {}) {
    return this._backend.recall(query, options);
  }

  /**
   * 按 ID 获取
   * @param {string} id
   * @returns {Promise<MemoryFragment | null>}
   */
  async get(id) {
    return this._backend.get(id);
  }

  /**
   * 删除记忆
   * @param {string} id
   * @returns {Promise<boolean>}
   */
  async forget(id) {
    return this._backend.forget(id);
  }

  /**
   * 列出所有记忆（分页）
   * @param {object} [options] - { page, pageSize, type, sortBy }
   * @returns {Promise<{ items, total, page, pageSize }>}
   */
  async list(options = { page: 1, pageSize: 20 }) {
    return this._backend.list(options);
  }

  // ============================================================
  // 便捷方法
  // ============================================================

  /**
   * 保存技能胶囊
   * @param {string} name
   * @param {string} description
   * @param {string} example
   * @param {number} [priority=0.7]
   */
  async storeSkill(name, description, example, priority = 0.7) {
    const frag = new SkillFragment(name, description, example, priority);
    return this.store(frag);
  }

  /**
   * 保存任务记录
   * @param {string} task
   * @param {string} status
   * @param {string} [note='']
   * @param {number} [priority=0.9]
   */
  async storeTask(task, status, note = '', priority = 0.9) {
    const frag = new TaskFragment(task, status, note, priority);
    return this.store(frag);
  }

  /**
   * 保存配置决策
   * @param {string} configKey
   * @param {string} configValue
   * @param {string} [reason='']
   * @param {number} [priority=0.8]
   */
  async storeDecision(configKey, configValue, reason = '', priority = 0.8) {
    const frag = new ConfigFragment(configKey, configValue, reason, priority);
    return this.store(frag);
  }

  /**
   * 保存结论
   * @param {string} conclusion
   * @param {string} source
   * @param {number} [priority=0.6]
   */
  async storeConclusion(conclusion, source, priority = 0.6) {
    const frag = new ConclusionFragment(conclusion, source, priority);
    return this.store(frag);
  }

  /**
   * 保存经验教训
   * @param {string} lesson
   * @param {string} context
   * @param {number} [priority=0.5]
   */
  async storeLesson(lesson, context, priority = 0.5) {
    const frag = new LessonFragment(lesson, context, priority);
    return this.store(frag);
  }

  /**
   * 获取最近的 N 条结论
   * @param {number} [limit=5]
   */
  async getRecentConclusions(limit = 5) {
    const results = await this.recall('结论', { type: 'conclusion', limit });
    return results.map(r => r.fragment);
  }

  // ============================================================
  // 后端管理
  // ============================================================

  /**
   * 清理过期记忆
   * 委托给后端实现
   * @param {number} [daysAbandoned=180] - 清理阈值（天）
   * @returns {{ removed: number, kept: number, cutoff: string }}
   */
  async cleanup(daysAbandoned = 180) {
    return this._backend.cleanup(daysAbandoned);
  }

  /**
   * 切换后端（热切换，不影响数据）
   * @param {string} type - 'file' | 'sqlite' | 'lancedb'
   * @param {object} [options={}]
   */
  async switchBackend(type, options = {}) {
    const BackendFactory = BACKEND_REGISTRY[type];
    if (!BackendFactory) {
      throw new Error(`MemoryBackend: 未知后端类型 "${type}"，可选: ${Object.keys(BACKEND_REGISTRY).join(', ')}`);
    }

    const config = getConfig();
    let storePath;
    if (type === 'lancedb') {
      storePath = options.storePath
        || (config.memory?.lancedb?.storePath ? resolvePath(config.memory.lancedb.storePath) : null)
        || resolvePath('memory/brain-lancedb');
    } else {
      storePath = options.storePath
        || (config.paths.memory_store ? resolvePath(config.paths.memory_store) : null)
        || resolvePath('memory/memory-store.json');
    }

    const BackendClass = BackendFactory();

    // 构建后端构造参数
    const backendOptions = { storePath, ...options };

    // lancedb 专用配置
    if (type === 'lancedb' && config.memory?.lancedb) {
      const lc = config.memory.lancedb;
      if (lc.embeddingDimension) backendOptions.embeddingDimension = lc.embeddingDimension;
      if (lc.embeddingProvider) backendOptions.embeddingProvider = lc.embeddingProvider;
      if (lc.embeddingModel) backendOptions.embeddingModel = lc.embeddingModel;
      if (lc.embeddingApiKey) backendOptions.embeddingApiKey = lc.embeddingApiKey;
      if (lc.embeddingBaseUrl) backendOptions.embeddingBaseUrl = lc.embeddingBaseUrl;
    }

    this._backend = new BackendClass(backendOptions);
    this.backendType = type;
    return { success: true, type, storePath };
  }

  /**
   * 导出所有记忆
   * @param {string} [format='json']
   */
  async exportAll(format = 'json') {
    if (typeof this._backend.exportAll === 'function') {
      return this._backend.exportAll(format);
    }
    // 降级：用 list 遍历导出
    const all = [];
    let page = 1;
    const pageSize = 100;
    let hasMore = true;
    while (hasMore) {
      const result = await this._backend.list({ page, pageSize });
      all.push(...result.items.map(f => f.toJSON ? f.toJSON() : f));
      hasMore = result.items.length === pageSize;
      page++;
    }
    if (format === 'json') {
      return JSON.stringify({ version: 1, fragments: all, meta: { lastModified: new Date().toISOString(), count: all.length } }, null, 2);
    }
    const lines = all.map(d => {
      return `[${d.type}] (${d.priority}) ${d.content}\n  id: ${d.id}  created: ${d.createdAt}`;
    });
    return lines.join('\n\n');
  }

  /**
   * 备份
   * @param {string} destPath
   */
  async backup(destPath) {
    if (typeof this._backend.backup === 'function') {
      return this._backend.backup(destPath);
    }
    // 降级：exportAll + 写文件
    const json = await this.exportAll('json');
    const destDir = path.dirname(destPath);
    if (!fs.existsSync(destDir)) {
      fs.mkdirSync(destDir, { recursive: true });
    }
    fs.writeFileSync(destPath, json, 'utf8');
    const stats = await this._backend.stats();
    return { success: true, path: destPath, count: stats.total };
  }

  /**
   * 统计
   */
  async stats() {
    return this._backend.stats();
  }
}

// ============================================================
// 注册自定义后端（供未来扩展）
// ============================================================

/**
 * 注册新后端类型
 * @param {string} name
 * @param {Function} BackendClass - 必须实现 store/recall/get/forget/list/stats
 */
function registerBackend(name, BackendClass) {
  BACKEND_REGISTRY[name] = () => BackendClass;
}

module.exports = {
  MemoryBackend,
  registerBackend,
  // 重新导出 fragment 类，方便使用
  MemoryFragment,
  SkillFragment,
  TaskFragment,
  ConfigFragment,
  ConclusionFragment,
  LessonFragment,
  FragmentPool
};
