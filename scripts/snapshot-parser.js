/**
 * snapshot-parser.js — brain v1.1.9
 * 统一的 SNAPSHOT.md 解析器，brain-mcp-server.js 和 build-session-injection.js 共用。
 *
 * 解析 SNAPSHOT.md 中的 emoji 标注 section：
 *   📌 信息 → userInfo
 *   📋 当前任务 → currentTasks
 *   🧠 最近结论 → recentConclusions
 *   📝 待办 → todos
 */

/**
 * 从 SNAPSHOT 文本提取关键信息
 * @param {string} snapshot - SNAPSHOT.md 完整文本
 * @returns {{ userInfo: string[], currentTasks: string[], recentConclusions: string[], todos: string[] }}
 */
function parseSnapshot(snapshot) {
  if (!snapshot) return { userInfo: [], currentTasks: [], recentConclusions: [], todos: [] };

  const lines = snapshot.split('\n').filter(l => l.trim());
  const info = { userInfo: [], currentTasks: [], recentConclusions: [], todos: [] };

  const sectionMap = {
    '用户信息': (l) => l.includes('📌') && l.includes('信息'),
    'currentTasks': (l) => l.includes('📋') && (l.includes('当前任务') || l.includes('任务')),
    'recentConclusions': (l) => l.includes('🧠') && (l.includes('最近') || l.includes('结论')),
    'todos': (l) => l.includes('📝') && l.includes('待办'),
  };

  let currentKey = null;
  for (const line of lines) {
    let matched = false;
    for (const [key, test] of Object.entries(sectionMap)) {
      if (test(line)) {
        // 宽松匹配：同样处理无 emoji 的纯文字 section 标题
        currentKey = key === '用户信息' ? 'userInfo' : key;
        matched = true;
        break;
      }
    }
    if (matched) continue;

    // 无 emoji 的纯文字 section 标题回退
    if (!currentKey || line.startsWith('#')) {
      const lower = line.toLowerCase();
      if (lower.includes('用户信息') || lower.includes('user info')) currentKey = 'userInfo';
      else if (lower.includes('当前任务') || lower.includes('current task')) currentKey = 'currentTasks';
      else if (lower.includes('最近结论') || lower.includes('recent')) currentKey = 'recentConclusions';
      else if (lower.includes('待办') || lower.includes('todo')) currentKey = 'todos';
      continue;
    }

    if (line.startsWith('- ') && currentKey) {
      info[currentKey].push(line.slice(2));
    }
  }

  return info;
}

/**
 * 兼容旧接口名，返回的 key 映射到旧中文名
 * @deprecated 用 parseSnapshot 替代
 */
function extractKeyInfo(snapshot) {
  const parsed = parseSnapshot(snapshot);
  return {
    '用户信息': parsed.userInfo,
    '当前任务': parsed.currentTasks,
    '最近结论': parsed.recentConclusions,
    '待办': parsed.todos,
  };
}

module.exports = { parseSnapshot, extractKeyInfo };
