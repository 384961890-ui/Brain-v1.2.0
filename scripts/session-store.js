#!/usr/bin/env node
/**
 * SessionStore — brain 会话持久化存储
 * 
 * 底层使用 JSON 文件模拟 SQLite 风格接口。
 * 后续安装 better-sqlite3 后可无缝切换。
 * 
 * 使用方式：
 *   const { SessionStore } = require('./session-store');
 *   const store = new SessionStore('/path/to/sessions.db');
 *   // sessions.db 实际会被拆成 sessions/sessions.json 等文件
 */

const fs = require('fs');
const path = require('path');

class SessionStore {
  /**
   * @param {string} dbPath - 数据库路径（JSON模式下为目录前缀）
   */
  constructor(dbPath) {
    this.dbPath = dbPath;
    this.dir = path.dirname(dbPath);
    this.baseName = path.basename(dbPath, path.extname(dbPath));
    
    // JSON 文件路径
    this._files = {
      sessions: path.join(this.dir, `${this.baseName}_sessions.json`),
      decisions: path.join(this.dir, `${this.baseName}_decisions.json`),
      tasks: path.join(this.dir, `${this.baseName}_tasks.json`),
    };

    this._ensureDir();
    this._loadAll();
  }

  // ============ 内部方法 ============

  _ensureDir() {
    if (!fs.existsSync(this.dir)) {
      fs.mkdirSync(this.dir, { recursive: true });
    }
  }

  _loadAll() {
    this._sessions = this._loadFile(this._files.sessions);
    this._decisions = this._loadFile(this._files.decisions);
    this._tasks = this._loadFile(this._files.tasks);

    // v1.1.9: 单调递增 decision ID 计数器，避免 Math.max(...ids) 栈溢出 + 删记录后 ID 撞车
    const existingIds = Object.keys(this._decisions).map(Number).filter(n => !isNaN(n));
    this._lastDecisionId = existingIds.length > 0 ? Math.max(...existingIds) : 0;
  }

  _loadFile(filePath) {
    try {
      if (fs.existsSync(filePath)) {
        const raw = fs.readFileSync(filePath, 'utf8');
        return JSON.parse(raw);
      }
    } catch (e) {
      // 文件损坏时返回空
      console.error(`[SessionStore] 文件读取失败: ${filePath}`, e.message);
    }
    return {};
  }

  _saveFile(filePath, data) {
    const tmp = filePath + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
    fs.renameSync(tmp, filePath);  // 原子写入
  }

  _saveSessions() { this._saveFile(this._files.sessions, this._sessions); }
  _saveDecisions() { this._saveFile(this._files.decisions, this._decisions); }
  _saveTasks() { this._saveFile(this._files.tasks, this._tasks); }

  _now() {
    return new Date().toISOString().replace('T', ' ').slice(0, 19);
  }

  // ============ Sessions ============

  /**
   * 保存会话快照
   * @param {string} sessionKey - 唯一标识（如日期+时间戳）
   * @param {object} data - { task, progress, decisions, subagents, notes }
   */
  async saveSnapshot(sessionKey, data) {
    const now = this._now();
    const existing = this._sessions[sessionKey];
    
    this._sessions[sessionKey] = {
      session_key: sessionKey,
      timestamp: now,
      task: data.task || null,
      progress: data.progress || null,
      decisions: data.decisions || [],
      subagents: data.subagents || [],
      notes: data.notes || null,
      created_at: existing?.created_at || now,
    };

    this._saveSessions();

    // 同步保存 decisions 到独立表
    if (data.decisions && Array.isArray(data.decisions)) {
      for (const d of data.decisions) {
        if (d.topic && d.content) {
          const decId = this._nextDecisionId();
          this._decisions[decId] = {
            id: Number(decId),
            topic: d.topic,
            content: d.content,
            source: d.source || sessionKey,
            session_key: sessionKey,
            created_at: now,
          };
        }
      }
      this._saveDecisions();
    }

    return { ok: true, sessionKey };
  }

  /**
   * 获取最新快照
   * @returns {object|null}
   */
  async getLatestSnapshot() {
    const keys = Object.keys(this._sessions).sort().reverse();
    if (keys.length === 0) return null;
    return this._sessions[keys[0]];
  }

  /**
   * 按日期获取会话列表
   * @param {string} date - 日期字符串 YYYY-MM-DD
   * @returns {Array<{sessionKey, timestamp, task, progress}>}
   */
  async listSessions(date) {
    const results = [];
    for (const [key, session] of Object.entries(this._sessions)) {
      if (!date || session.timestamp.startsWith(date)) {
        results.push({
          sessionKey: session.session_key,
          timestamp: session.timestamp,
          task: session.task,
          progress: session.progress,
        });
      }
    }
    return results.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  }

  /**
   * 获取特定会话的完整数据
   * @param {string} sessionKey
   * @returns {object|null}
   */
  async getSession(sessionKey) {
    return this._sessions[sessionKey] || null;
  }

  // ============ Decisions ============

  _nextDecisionId() {
    return String(++this._lastDecisionId);
  }

  /**
   * 保存关键决策
   * @param {string} topic
   * @param {string} content
   * @param {string} [source]
   */
  async saveDecision(topic, content, source) {
    const id = this._nextDecisionId();
    this._decisions[id] = {
      id: Number(id),
      topic,
      content,
      source: source || null,
      session_key: null,
      created_at: this._now(),
    };
    this._saveDecisions();
    return { ok: true, id: Number(id) };
  }

  /**
   * 检索决策历史
   * @param {{ topic?: string, limit?: number }} options
   * @returns {Array}
   */
  async searchDecisions(options = {}) {
    let results = Object.values(this._decisions);

    if (options.topic) {
      const q = options.topic.toLowerCase();
      results = results.filter(d => 
        d.topic.toLowerCase().includes(q) || 
        d.content.toLowerCase().includes(q)
      );
    }

    results.sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''));

    if (options.limit) {
      results = results.slice(0, options.limit);
    }

    return results;
  }

  // ============ Tasks ============

  /**
   * 保存任务状态
   * @param {string} taskId
   * @param {string} status - pending/in_progress/completed/failed
   * @param {string} [progress]
   * @param {string} [details]
   */
  async saveTask(taskId, status, progress, details) {
    const now = this._now();
    const existing = this._tasks[taskId];

    this._tasks[taskId] = {
      task_id: taskId,
      status,
      progress: progress || null,
      details: details || null,
      created_at: existing?.created_at || now,
      updated_at: now,
    };

    this._saveTasks();
    return { ok: true, taskId };
  }

  /**
   * 获取所有未完成的任务
   * @returns {Array}
   */
  async getPendingTasks() {
    return Object.values(this._tasks).filter(
      t => t.status === 'pending' || t.status === 'in_progress'
    );
  }

  /**
   * 更新任务状态
   * @param {string} taskId
   * @param {string} status
   * @param {string} [progress]
   */
  async updateTask(taskId, status, progress) {
    if (!this._tasks[taskId]) {
      return { ok: false, error: 'task not found' };
    }

    this._tasks[taskId].status = status;
    if (progress !== undefined) {
      this._tasks[taskId].progress = progress;
    }
    this._tasks[taskId].updated_at = this._now();

    this._saveTasks();
    return { ok: true, taskId };
  }

  // ============ 维护 ============

  /**
   * 清理过期会话数据（删除而非归档）
   * 删除超过指定天数未更新的 session/decision/task 数据
   * @param {number} daysToKeep - 保留最近 N 天，默认 180
   * @returns {{ removed: number, sessions: number, decisions: number }}
   */
  async cleanup(daysToKeep = 180) {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - daysToKeep);
    const cutoffStr = cutoff.toISOString().replace('T', ' ').slice(0, 19);

    let sessionsRemoved = 0;
    let decisionsRemoved = 0;

    for (const [key, session] of Object.entries(this._sessions)) {
      if (session.timestamp < cutoffStr) {
        delete this._sessions[key];
        sessionsRemoved++;
      }
    }
    this._saveSessions();

    for (const [id, decision] of Object.entries(this._decisions)) {
      if (decision.created_at && decision.created_at < cutoffStr) {
        delete this._decisions[id];
        decisionsRemoved++;
      }
    }
    this._saveDecisions();

    return {
      removed: sessionsRemoved + decisionsRemoved,
      sessions: sessionsRemoved,
      decisions: decisionsRemoved,
    };
  }

  /**
   * 压缩/清理旧数据（保留最近N天，更早的归档）
   * @param {number} daysToKeep - 默认30天
   * @returns {{ archived: number, kept: number }}
   */
  async archive(daysToKeep = 30) {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - daysToKeep);
    const cutoffStr = cutoff.toISOString().replace('T', ' ').slice(0, 19);

    let archived = 0;
    let kept = 0;
    const archivedSessions = {};
    const keptSessions = {};

    for (const [key, session] of Object.entries(this._sessions)) {
      if (session.timestamp < cutoffStr) {
        archivedSessions[key] = session;
        archived++;
      } else {
        keptSessions[key] = session;
        kept++;
      }
    }

    // 保存归档文件
    if (archived > 0) {
      const archivePath = path.join(
        this.dir, 
        `${this.baseName}_archive_${new Date().toISOString().slice(0, 10)}.json`
      );
      this._saveFile(archivePath, archivedSessions);
      this._sessions = keptSessions;
      this._saveSessions();
    }

    return { archived, kept };
  }

  /**
   * 导出所有数据
   * @returns {{ sessions, decisions, tasks }}
   */
  async exportAll() {
    return {
      sessions: { ...this._sessions },
      decisions: { ...this._decisions },
      tasks: { ...this._tasks },
    };
  }

  /**
   * 统计数据
   * @returns {{ sessions, decisions, tasks, pendingTasks }}
   */
  async stats() {
    const pending = Object.values(this._tasks).filter(
      t => t.status === 'pending' || t.status === 'in_progress'
    );
    return {
      sessions: Object.keys(this._sessions).length,
      decisions: Object.keys(this._decisions).length,
      tasks: Object.keys(this._tasks).length,
      pendingTasks: pending.length,
    };
  }
}

module.exports = { SessionStore };
