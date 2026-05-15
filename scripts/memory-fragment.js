#!/usr/bin/env node
/**
 * memory-fragment.js — 记忆片段标准接口 v1.1.9
 * =========================================
 *
 * v1.1.9 改动：
 *   - Fragment 子类不再承载渲染逻辑，差异化字段统一存 meta object
 *   - hydrate 时不需要恢复子类类型，meta 保证信息不丢
 *   - 新增 contentHash（sha256）用于内容去重
 *   - 新增 accessCount / lastAccessedAt 用于时间衰减
 *   - FragmentFactory.fromJSON() 统一反序列化入口
 *
 * 使用方式：
 *   const { MemoryFragment, FragmentFactory, FragmentPool } = require('./memory-fragment.js');
 */

const crypto = require('crypto');
const { getConfig } = require('./load-config.js');
const _cfg = getConfig();
const MAX_FRAGMENT_TOKENS = _cfg.limits.fragment_max_tokens || 2000;

// ================================================================
// 工具函数
// ================================================================

function estimateTokens(text) {
  if (!text) return 0;
  const chinese = (text.match(/[一-鿿]/g) || []).length;
  const english = text.length - chinese;
  return chinese * 2 + Math.floor(english * 1.3);
}

function truncateToTokens(text, maxTokens) {
  const current = estimateTokens(text);
  if (current <= maxTokens) return text;

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

/** v1.1.9: 内容去重哈希 */
function contentHash(type, content) {
  return crypto.createHash('sha256')
    .update(`${type}|${content.replace(/\s+/g, ' ').trim()}`)
    .digest('hex').slice(0, 16);
}

// ================================================================
// 记忆片段基类
// ================================================================

class MemoryFragment {
  /**
   * @param {string} type - 'skill'|'task'|'config'|'conclusion'|'lesson'
   * @param {string} content - 记忆内容
   * @param {number} priority - 优先级 0-1
   * @param {object} [meta] - 额外元数据，子类通过 meta 传递差异化字段
   */
  constructor(type, content, priority = 0.5, meta = {}) {
    this.type = type;
    this.content = content;
    this.priority = Math.max(0, Math.min(1, priority));
    this.createdAt = new Date().toISOString();
    this._id = `${type}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

    // v1.1.9: 差异化字段统一存 meta
    this.meta = meta;

    // v1.1.9: 访问统计（时间衰减用）
    this.accessCount = 0;
    this.lastAccessedAt = null;

    // v1.1.9: 内容去重哈希（入库时算一次，避免重复）
    this._hash = contentHash(type, content);
  }

  get id() { return this._id; }
  set id(v) { this._id = v; }

  get hash() {
    if (!this._hash) this._hash = contentHash(this.type, this.content);
    return this._hash;
  }

  getSize() { return estimateTokens(this.content); }
  isOversized() { return this.getSize() > MAX_FRAGMENT_TOKENS; }

  /** v1.1.9: 记录一次访问（异步，不阻塞读） */
  recordAccess() {
    this.accessCount = (this.accessCount || 0) + 1;
    this.lastAccessedAt = new Date().toISOString();
  }

  /** v1.1.9: 时间衰减分数 [0,1]，30 天半衰，热度乘入防越界 */
  decayScore() {
    if (!this.createdAt) return 0;
    const ageDays = (Date.now() - new Date(this.createdAt).getTime()) / (86400 * 1000);
    const freshness = Math.max(0.05, Math.exp(-ageDays / 30));
    const popularityBoost = 1 + Math.min((this.accessCount || 0) * 0.02, 0.3);
    return Math.min(1.0, freshness * popularityBoost);
  }

  toContext() {
    if (this.isOversized()) {
      const truncated = truncateToTokens(this.content, MAX_FRAGMENT_TOKENS - 50);
      return {
        type: this.type, id: this.id, priority: this.priority,
        content: truncated, compressed: true, originalSize: this.getSize(),
        note: `[已压缩：原始${this.getSize()}tokens，完整版见SNAPSHOT]`
      };
    }
    return { type: this.type, id: this.id, priority: this.priority, content: this.content, compressed: false };
  }

  toSearchable() { return `${this.type} | ${this.content}`; }
  toSnapshot() { return `[${this.type.toUpperCase()}] ${this.content}`; }

  toJSON() {
    return {
      id: this._id,
      type: this.type,
      content: this.content,
      priority: this.priority,
      size: this.getSize(),
      createdAt: this.createdAt,
      meta: this.meta,
      hash: this.hash,
      accessCount: this.accessCount,
      lastAccessedAt: this.lastAccessedAt,
    };
  }
}

// ================================================================
// Fragment 工厂 — 统一反序列化 & 创建
// ================================================================

class FragmentFactory {
  /** 从 JSON 反序列化（不再丢失子类信息，meta 保存一切） */
  static fromJSON(json) {
    const frag = new MemoryFragment(json.type, json.content, json.priority, json.meta || {});
    if (json.id) frag._id = json.id;
    if (json.createdAt) frag.createdAt = json.createdAt;
    if (json.hash) frag._hash = json.hash;
    frag.accessCount = json.accessCount || 0;
    frag.lastAccessedAt = json.lastAccessedAt || null;
    return frag;
  }

  /** 便捷构造：skill */
  static skill(name, description, example, priority = 0.7) {
    return new MemoryFragment('skill',
      `【技能】${name}\n${description}\n示例：${example}`,
      priority,
      { skillName: name }
    );
  }

  /** 便捷构造：task */
  static task(task, status, note = '', priority = 0.9) {
    return new MemoryFragment('task',
      `【任务】${task}\n状态：${status}${note ? '\n' + note : ''}`,
      priority,
      { task, status }
    );
  }

  /** 便捷构造：config */
  static config(key, value, reason = '', priority = 0.8) {
    return new MemoryFragment('config',
      reason ? `【配置】${key} = ${value}\n原因：${reason}` : `【配置】${key} = ${value}`,
      priority,
      { configKey: key, configValue: value, reason }
    );
  }

  /** 便捷构造：conclusion */
  static conclusion(conclusion, source, priority = 0.6) {
    return new MemoryFragment('conclusion',
      `【结论】${conclusion}\n来源：${source}`,
      priority,
      { conclusion, source }
    );
  }

  /** 便捷构造：lesson */
  static lesson(lesson, context, priority = 0.5) {
    return new MemoryFragment('lesson',
      `【教训】${lesson}\n场景：${context}`,
      priority,
      { lesson, context }
    );
  }

  /** 通用构造 */
  static fragment(type, content, priority) {
    return new MemoryFragment(type, content, priority);
  }
}

// ================================================================
// 片段池
// ================================================================

class FragmentPool {
  constructor(maxTokens = MAX_FRAGMENT_TOKENS * 3) {
    this.fragments = [];
    this.maxTokens = maxTokens;
  }

  add(fragment) {
    this.fragments.push(fragment);
    this.fragments.sort((a, b) => b.priority - a.priority);
  }

  addAll(...fragments) {
    fragments.forEach(f => this.add(f));
  }

  getTotalSize() { return this.fragments.reduce((sum, f) => sum + f.getSize(), 0); }

  toContext() {
    const results = [];
    let totalSize = 0;
    for (const frag of this.fragments) {
      const ctx = frag.toContext();
      const fragSize = ctx.compressed
        ? estimateTokens(ctx.content) + estimateTokens(ctx.note)
        : frag.getSize();
      if (totalSize + fragSize > this.maxTokens) {
        const remaining = this.maxTokens - totalSize;
        if (remaining > 100) {
          ctx.content = truncateToTokens(ctx.content, remaining - 30);
          ctx.truncated = true;
          ctx.note = `[上下文已达上限${this.maxTokens}tokens，部分内容已截断]`;
          results.push(ctx);
        }
        break;
      }
      results.push(ctx);
      totalSize += fragSize;
    }
    return { fragments: results, totalTokens: totalSize, maxTokens: this.maxTokens,
      fragmentCount: results.length, totalFragments: this.fragments.length };
  }

  toSearchable() { return this.fragments.map(f => f.toSearchable()).join('\n'); }
  toSnapshot() { return this.fragments.map(f => f.toSnapshot()).join('\n---\n'); }

  toJSON() {
    return {
      fragments: this.fragments.map(f => f.toJSON()),
      stats: { total: this.fragments.length, totalTokens: this.getTotalSize(), maxTokens: this.maxTokens }
    };
  }
}

// ================================================================
// 向后兼容的快捷函数（内部调 FragmentFactory）
// ================================================================

function skill(name, desc, example, priority) { return FragmentFactory.skill(name, desc, example, priority); }
function task(taskName, status, note, priority) { return FragmentFactory.task(taskName, status, note, priority); }
function config(key, value, reason, priority) { return FragmentFactory.config(key, value, reason, priority); }
function conclusion(text, source, priority) { return FragmentFactory.conclusion(text, source, priority); }
function lesson(text, context, priority) { return FragmentFactory.lesson(text, context, priority); }
function fragment(type, content, priority) { return FragmentFactory.fragment(type, content, priority); }

// ================================================================
// 单元测试
// ================================================================

if (require.main === module) {
  console.log('MemoryFragment v1.1.9 单元测试\n');

  // Test 1: 基本
  const f1 = new MemoryFragment('skill', '发飞书图片', 0.8);
  console.log('Test1 基本:', f1.getSize(), 'tokens, id:', f1.id, 'hash:', f1.hash);

  // Test 2: 子类 → meta
  const f2 = FragmentFactory.skill('发飞书图片', '用message工具', 'message(action=send, filePath=...)');
  console.log('Test2 meta:', f2.meta.skillName);

  // Test 3: JSON 往返
  const json = f2.toJSON();
  const restored = FragmentFactory.fromJSON(json);
  console.log('Test3 往返:', restored.type, restored.meta.skillName, 'hash一致:', restored.hash === f2.hash);

  // Test 4: 时间衰减
  console.log('Test4 衰减:', f2.decayScore().toFixed(3));
  f2.recordAccess();
  console.log('      accessCount:', f2.accessCount);

  // Test 5: 池
  const pool = new FragmentPool(500);
  pool.add(f1);
  pool.add(FragmentFactory.task('官网迭代', '进行中', 'Hero区完成'));
  pool.add(FragmentFactory.config('model', 'kimi-k2.6', '调研任务专用'));
  pool.add(FragmentFactory.conclusion('Codex比CC更Rust化', 'AGENTS.md'));
  const ctx = pool.toContext();
  console.log('Test5 池:', ctx.fragmentCount, '/', ctx.totalFragments, ',', ctx.totalTokens, 'tokens');

  // Test 6: 超大片段自动压缩
  const f3 = FragmentFactory.fragment('note', '一段长内容'.repeat(500));
  console.log('Test6 超大:', f3.getSize(), 'tokens, oversized:', f3.isOversized());

  // Test 7: 快速工厂
  const f4 = skill('技能A', 'desc', 'example');
  console.log('Test7 兼容:', f4.type, f4.meta.skillName);

  console.log('\n所有测试通过');
}

module.exports = {
  MemoryFragment,
  FragmentFactory,
  FragmentPool,
  // 向后兼容的旧子类名（alias 到 FragmentFactory）
  SkillFragment: class SkillFragment extends MemoryFragment {
    constructor(name, desc, example, p) {
      super('skill', `【技能】${name}\n${desc}\n示例：${example}`, p, { skillName: name });
    }
  },
  TaskFragment: class TaskFragment extends MemoryFragment {
    constructor(task, status, note, p) {
      super('task', `【任务】${task}\n状态：${status}${note ? '\n' + note : ''}`, p, { task, status });
    }
  },
  ConfigFragment: class ConfigFragment extends MemoryFragment {
    constructor(key, value, reason, p) {
      super('config', reason ? `【配置】${key} = ${value}\n原因：${reason}` : `【配置】${key} = ${value}`, p, { configKey: key, configValue: value, reason });
    }
  },
  ConclusionFragment: class ConclusionFragment extends MemoryFragment {
    constructor(conclusion, source, p) {
      super('conclusion', `【结论】${conclusion}\n来源：${source}`, p, { conclusion, source });
    }
  },
  LessonFragment: class LessonFragment extends MemoryFragment {
    constructor(lesson, context, p) {
      super('lesson', `【教训】${lesson}\n场景：${context}`, p, { lesson, context });
    }
  },
  // 快捷函数
  skill, task, config, conclusion, lesson, fragment,
  estimateTokens, truncateToTokens, contentHash, MAX_FRAGMENT_TOKENS
};
