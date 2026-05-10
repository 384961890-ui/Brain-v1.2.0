/**
 * load-config.js — brain v1.1.9 统一配置加载器
 *
 * 从 brain.config.json 读取配置，展开 ~ 为真实 HOME 路径，展开 $env: 为环境变量。
 *
 * 用法:
 *   const { getConfig, resolvePath } = require('./load-config.js');
 *   const config = getConfig();
 *   const fullPath = resolvePath('memory/watchdog-log.md');
 */

const fs = require('fs');
const path = require('path');

const CONFIG_PATH = process.env.BRAIN_CONFIG_PATH
  || path.join(__dirname, '..', 'config', 'brain.config.json');

function expandHome(p) {
  if (typeof p === 'string' && p.startsWith('~')) {
    return path.join(process.env.HOME, p.slice(1));
  }
  return p;
}

/**
 * 递归遍历 config 对象，将 "$env:VAR_NAME" 替换为 process.env[VAR_NAME]
 * 如果环境变量未设置，输出 warning 并返回空字符串
 */
function expandEnvVars(obj) {
  if (obj === null || obj === undefined) return obj;
  if (typeof obj === 'string') {
    if (obj.startsWith('$env:')) {
      const varName = obj.slice(5);
      if (process.env[varName] !== undefined) {
        return process.env[varName];
      }
      console.error(`[brain] WARNING: env var "${varName}" is not set. Config key expects it.`);
      return '';
    }
    return obj;
  }
  if (Array.isArray(obj)) {
    return obj.map(expandEnvVars);
  }
  if (typeof obj === 'object') {
    const result = {};
    for (const [key, value] of Object.entries(obj)) {
      result[key] = expandEnvVars(value);
    }
    return result;
  }
  return obj;
}

/**
 * 读取并返回 brain 配置对象
 * 路径中的 ~ 会被展开为 HOME
 * skills_dirs 中的 ~ 也会被展开
 * "$env:VAR" 格式的值会被替换为环境变量
 */
function getConfig() {
  const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
  const config = JSON.parse(raw);

  // 展开 $env: 环境变量引用
  const resolved = expandEnvVars(config);

  // 展开 workspace 中的 ~
  if (resolved.workspace) {
    resolved.workspace = expandHome(resolved.workspace);
  }

  // 展开 skills_dirs 中的 ~
  if (Array.isArray(resolved.skills_dirs)) {
    resolved.skills_dirs = resolved.skills_dirs.map(expandHome);
  }

  return resolved;
}

/**
 * 基于 workspace 解析完整路径
 * resolvePath('memory/watchdog-log.md') → /Users/xxx/.openclaw/workspace/memory/watchdog-log.md
 */
function resolvePath(relativePath) {
  // 已经是绝对路径？直接返回
  if (path.isAbsolute(relativePath)) return relativePath;
  const config = getConfig();
  return path.join(config.workspace, relativePath);
}

/**
 * 获取 SessionStore 单例
 * 用于会话持久化存储（SQLite风格，当前用JSON文件实现）
 * @param {string} [dbPath] - 自定义数据库路径，默认从配置读取
 * @returns {SessionStore}
 */
let _sessionStore = null;
function getSessionStore(dbPath) {
  if (!_sessionStore || dbPath) {
    const { SessionStore } = require('./session-store.js');
    const resolved = dbPath || resolvePath('memory/sessions.db');
    _sessionStore = new SessionStore(resolved);
  }
  return _sessionStore;
}

module.exports = { getConfig, resolvePath, getSessionStore };
