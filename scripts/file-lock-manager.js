#!/usr/bin/env node
/**
 * file-lock-manager.js — Brain v1.1.9 文件写锁管理器
 * =====================================================
 *
 * 提供基于文件系统的分布式写锁，用于防止多个子 agent
 * 同时写入同一文件导致数据损坏。
 *
 * 核心策略：
 *   - 用 SHA256 哈希文件路径 → 锁文件名
 *   - 临时文件 + fs.link() 原子获取（O_EXCL 语义）
 *   - TTL 过期自动清理
 *   - 锁存储为 JSON：{ file, agentId, acquiredAt, expiresAt, status }
 *
 * 使用方式：
 *   const { FileLockManager } = require('./file-lock-manager.js');
 *   const locks = new FileLockManager();
 *   await locks.acquire('/path/to/file.txt', 'agent-123');
 *   // ... 写文件 ...
 *   await locks.release('/path/to/file.txt', 'agent-123');
 */

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const os = require('os');

// ============================================================
// 常量
// ============================================================

const LOCK_DIR = path.join(os.homedir(), '.brain', 'locks');
const DEFAULT_TTL_MS = 300000; // 5 分钟
const CLEANUP_INTERVAL_MS = 60000; // 每分钟清理一次
const ACQUIRE_RETRIES = 3; // 获取锁的最大重试次数
const LOCK_STATUS = {
  LOCKED: 'locked',
  FREE: 'free',
  EXPIRED: 'expired',
};

/**
 * 路径遍历防护 — 拒绝含 .. 的路径
 * @param {string} inputPath - 用户输入的路径
 * @returns {string} 解析后的绝对路径
 * @throws {Error} 如果路径包含遍历攻击
 */
function sanitizePath(inputPath) {
  if (typeof inputPath !== 'string' || inputPath.trim().length === 0) {
    throw new Error('文件路径不能为空');
  }

  // 检查路径中是否包含目录遍历字符
  const parts = inputPath.split(path.sep);
  for (const part of parts) {
    if (part === '..' || part === '.') {
      throw new Error(
        `路径遍历拒绝: 路径中不允许出现 "${part}" (${inputPath})`
      );
    }
  }

  // 确保不包含 null 字节
  if (inputPath.includes('\0')) {
    throw new Error('路径包含 null 字节，拒绝');
  }

  return path.resolve(inputPath);
}

/**
 * 给一个锁文件路径，生成唯一的临时文件名
 * 加入随机后缀确保毫秒内并发调用仍唯一
 * @param {string} lockFilePath
 * @returns {string}
 */
function tmpPathFor(lockFilePath) {
  return lockFilePath + '.tmp.' + process.pid + '.' + Date.now() + '.' +
    Math.random().toString(36).slice(2, 8);
}

// ============================================================
// FileLockManager 类
// ============================================================

class FileLockManager {
  constructor(options = {}) {
    this._lockDir = options.lockDir || LOCK_DIR;
    this._defaultTtlMs = options.defaultTtlMs || DEFAULT_TTL_MS;
    this._cleanupTimer = null;
    this._destroyed = false;

    // 同步创建锁目录，确保构造函数返回时目录已存在
    try {
      fs.mkdirSync(this._lockDir, { recursive: true });
    } catch (err) {
      console.error('[file-lock-manager] 创建锁目录失败:', err.message);
    }

    this._startCleanupTimer();
  }

  // ---- 内部方法 ----

  /**
   * 将文件路径映射到锁文件路径
   * @param {string} resolvedPath
   * @returns {string} 锁文件的绝对路径
   */
  _getLockFilePath(resolvedPath) {
    const hash = crypto
      .createHash('sha256')
      .update(resolvedPath)
      .digest('hex');
    return path.join(this._lockDir, hash + '.lock.json');
  }

  /**
   * 读取并解析锁文件
   * @param {string} lockFilePath
   * @returns {object|null}
   */
  async _readLock(lockFilePath) {
    try {
      const raw = await fsp.readFile(lockFilePath, 'utf8');
      return JSON.parse(raw);
    } catch (err) {
      if (err.code === 'ENOENT') return null;
      // 损坏的锁文件，视为不存在
      if (err instanceof SyntaxError) return null;
      throw err;
    }
  }

  /**
   * 原子方式写入锁数据（内部用临时文件 + rename）
   * @param {string} lockFilePath
   * @param {object} lockData
   */
  async _writeLock(lockFilePath, lockData) {
    const tmp = tmpPathFor(lockFilePath);
    await fsp.writeFile(tmp, JSON.stringify(lockData), 'utf8');
    // rename 在同一个文件系统上是原子操作
    await fsp.rename(tmp, lockFilePath);
  }

  /**
   * 原子方式删除锁文件（rename 到临时名再 unlink）
   * @param {string} lockFilePath
   */
  async _removeLock(lockFilePath) {
    const backup = lockFilePath + '.removed.' + Date.now();
    try {
      await fsp.rename(lockFilePath, backup);
      await fsp.unlink(backup).catch(() => {});
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
  }

  /**
   * 检查锁是否过期
   * @param {object} lockData
   * @returns {boolean}
   */
  _isExpired(lockData) {
    return Date.now() >= lockData.expiresAt;
  }

  // ---- 公共 API ----

  /**
   * 获取文件写锁
   *
   * 用 fs.link() 实现原子 O_EXCL 语义，确保不会出现
   * 两个进程同时获得同一文件的写锁。
   *
   * @param {string} filePath - 要锁定的文件路径
   * @param {string} agentId - 申请锁的 agent 标识
   * @param {number} [ttlMs=300000] - 锁有效期（毫秒）
   * @returns {Promise<{success: boolean, lockedBy?: string,
   *          acquiredAt?: number, expiresAt?: number}>}
   */
  async acquire(filePath, agentId, ttlMs = this._defaultTtlMs) {
    const resolvedPath = sanitizePath(filePath);
    if (!agentId || typeof agentId !== 'string') {
      throw new Error('agentId 不能为空');
    }

    const lockFilePath = this._getLockFilePath(resolvedPath);
    const now = Date.now();
    const lockData = {
      file: resolvedPath,
      agentId,
      acquiredAt: now,
      expiresAt: now + ttlMs,
      status: LOCK_STATUS.LOCKED,
    };

    // 用临时文件 + link 实现原子获取
    // link 在目标已存在时会抛 EEXIST（原子 test-and-set）
    const tmp = tmpPathFor(lockFilePath);

    for (let retry = 0; retry < ACQUIRE_RETRIES; retry++) {
      try {
        await fsp.writeFile(tmp, JSON.stringify(lockData), 'utf8');
        await fsp.link(tmp, lockFilePath);
        // 成功获取锁
        await fsp.unlink(tmp).catch(() => {});
        return {
          success: true,
          file: resolvedPath,
          acquiredAt: lockData.acquiredAt,
          expiresAt: lockData.expiresAt,
        };
      } catch (err) {
        await fsp.unlink(tmp).catch(() => {});

        if (err.code === 'EEXIST') {
          const existing = await this._readLock(lockFilePath);
          if (existing) {
            if (this._isExpired(existing)) {
              // 原锁已过期，尝试强制释放后重试
              await this._removeLock(lockFilePath);
              continue;
            }
            // 锁被他人持有，返回冲突信息
            return {
              success: false,
              lockedBy: existing.agentId,
              acquiredAt: existing.acquiredAt,
              expiresAt: existing.expiresAt,
              message: `文件已被 ${existing.agentId} 锁定，` +
                `到期时间: ${new Date(existing.expiresAt).toISOString()}`,
            };
          }
          // 锁文件存在但无法解析（损坏），删除后重试
          await this._removeLock(lockFilePath);
          continue;
        }

        throw err;
      }
    }

    // 重试耗尽
    return {
      success: false,
      message: `获取锁失败: 重试 ${ACQUIRE_RETRIES} 次后仍无法获取`,
    };
  }

  /**
   * 释放文件写锁
   * @param {string} filePath - 要释放的文件路径
   * @param {string} agentId - 申请释放的 agent 标识
   * @returns {Promise<{success: boolean, message?: string}>}
   */
  async release(filePath, agentId) {
    const resolvedPath = sanitizePath(filePath);
    if (!agentId || typeof agentId !== 'string') {
      throw new Error('agentId 不能为空');
    }

    const lockFilePath = this._getLockFilePath(resolvedPath);
    const existing = await this._readLock(lockFilePath);

    if (!existing) {
      return { success: false, message: '文件未被锁定，无需释放' };
    }

    if (existing.agentId !== agentId) {
      return {
        success: false,
        message: `无法释放: 文件被 ${existing.agentId} 锁定，` +
          `当前 agent (${agentId}) 无权释放`,
      };
    }

    await this._removeLock(lockFilePath);
    return { success: true, message: '锁已释放' };
  }

  /**
   * 强制释放锁（管理员操作）
   * @param {string} filePath
   * @returns {Promise<{success: boolean, message?: string}>}
   */
  async forceRelease(filePath) {
    const resolvedPath = sanitizePath(filePath);
    const lockFilePath = this._getLockFilePath(resolvedPath);
    const existing = await this._readLock(lockFilePath);

    if (!existing) {
      return { success: false, message: '文件未被锁定' };
    }

    await this._removeLock(lockFilePath);
    return {
      success: true,
      message: `已强制释放 ${existing.agentId} 的锁，原锁到期: ` +
        `${new Date(existing.expiresAt).toISOString()}`,
    };
  }

  /**
   * 查询锁状态
   * @param {string} filePath
   * @returns {Promise<{status: string, details?: object}>}
   */
  async status(filePath) {
    const resolvedPath = sanitizePath(filePath);
    const lockFilePath = this._getLockFilePath(resolvedPath);
    const existing = await this._readLock(lockFilePath);

    if (!existing) {
      return { status: LOCK_STATUS.FREE };
    }

    if (this._isExpired(existing)) {
      return {
        status: LOCK_STATUS.EXPIRED,
        details: {
          file: existing.file,
          lockedBy: existing.agentId,
          acquiredAt: existing.acquiredAt,
          expiresAt: existing.expiresAt,
        },
      };
    }

    return {
      status: LOCK_STATUS.LOCKED,
      details: {
        file: existing.file,
        lockedBy: existing.agentId,
        acquiredAt: existing.acquiredAt,
        expiresAt: existing.expiresAt,
        remainingMs: existing.expiresAt - Date.now(),
      },
    };
  }

  /**
   * 列出所有活跃锁
   * @returns {Promise<Array<object>>}
   */
  async listActive() {
    const results = [];
    let files;

    try {
      files = await fsp.readdir(this._lockDir);
    } catch (err) {
      if (err.code === 'ENOENT') return [];
      throw err;
    }

    const lockFiles = files.filter(f => f.endsWith('.lock.json'));

    for (const lockFile of lockFiles) {
      const lockFilePath = path.join(this._lockDir, lockFile);
      const data = await this._readLock(lockFilePath);
      if (data && !this._isExpired(data)) {
        results.push({
          file: data.file,
          lockFile,
          lockedBy: data.agentId,
          acquiredAt: data.acquiredAt,
          expiresAt: data.expiresAt,
          remainingMs: data.expiresAt - Date.now(),
        });
      }
    }

    return results;
  }

  /**
   * 列出某个 agent 的所有锁
   * @param {string} agentId
   * @returns {Promise<Array<object>>}
   */
  async listByAgent(agentId) {
    if (!agentId || typeof agentId !== 'string') {
      throw new Error('agentId 不能为空');
    }

    const active = await this.listActive();
    return active.filter(l => l.lockedBy === agentId);
  }

  /**
   * 清理所有过期锁
   * @returns {Promise<{cleaned: number}>}
   */
  async cleanup() {
    let cleaned = 0;
    let files;

    try {
      files = await fsp.readdir(this._lockDir);
    } catch (err) {
      if (err.code === 'ENOENT') return { cleaned: 0 };
      throw err;
    }

    const lockFiles = files.filter(f => f.endsWith('.lock.json'));

    for (const lockFile of lockFiles) {
      const lockFilePath = path.join(this._lockDir, lockFile);
      try {
        const data = await this._readLock(lockFilePath);
        if (data && this._isExpired(data)) {
          await this._removeLock(lockFilePath);
          cleaned++;
        }
      } catch (err) {
        // 跳过无法读取的锁文件
        continue;
      }
    }

    return { cleaned };
  }

  /**
   * 返回锁存储目录路径
   * @returns {string}
   */
  getLockDir() {
    return this._lockDir;
  }

  /**
   * 获取全局统计信息
   * @returns {Promise<object>}
   */
  async stats() {
    const active = await this.listActive();
    let total = 0;

    try {
      const files = await fsp.readdir(this._lockDir);
      total = files.filter(f => f.endsWith('.lock.json')).length;
    } catch {
      // noop
    }

    return {
      lockDir: this._lockDir,
      totalLockFiles: total,
      activeLocks: active.length,
      defaultTtlMs: this._defaultTtlMs,
    };
  }

  // ---- 定时清理 ----

  _startCleanupTimer() {
    if (this._cleanupTimer) return;
    this._cleanupTimer = setInterval(() => {
      this.cleanup().catch(err => {
        console.error('[file-lock-manager] 定时清理失败:', err.message);
      });
    }, CLEANUP_INTERVAL_MS);
    // 允许 Node 在事件循环空闲时退出
    if (this._cleanupTimer.unref) {
      this._cleanupTimer.unref();
    }
  }

  // ---- 销毁 ----

  /**
   * 销毁锁管理器，停止定时清理
   */
  destroy() {
    if (this._cleanupTimer) {
      clearInterval(this._cleanupTimer);
      this._cleanupTimer = null;
    }
    this._destroyed = true;
  }
}

// ============================================================
// 导出
// ============================================================

module.exports = {
  FileLockManager,
  sanitizePath,
  LOCK_DIR,
  DEFAULT_TTL_MS,
  LOCK_STATUS,
};
