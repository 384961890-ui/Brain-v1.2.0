#!/usr/bin/env node
/**
 * auto-review-trigger.js — 对话轮次复盘触发器
 * brain心跳时调用，检查是否需要复盘
 *
 * 用法: node auto-review-trigger.js
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { getConfig, resolvePath } = require('./load-config.js');

const _cfg = getConfig();
const COUNTER_PATH = resolvePath(_cfg.paths.counter);
const SCRIPTS_DIR = path.dirname(__filename);

function getCounter() {
  try {
    return JSON.parse(fs.readFileSync(COUNTER_PATH, 'utf8'));
  } catch {
    return { turns: 0, last_review_turn: 0, should_review: false };
  }
}

function updateCounter(turns) {
  const data = {
    turns,
    last_review_turn: turns,
    should_review: false,
    lastReviewAt: new Date().toISOString(),
  };
  const dir = path.dirname(COUNTER_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(COUNTER_PATH, JSON.stringify(data, null, 2));
}

function runSkillHealthCheck() {
  try {
    const output = execSync(
      `node "${path.join(SCRIPTS_DIR, 'skill-health-checker.js')}"`,
      { encoding: 'utf8', timeout: 30000 }
    );
    return JSON.parse(output);
  } catch (e) {
    return { error: e.message };
  }
}

function getSkillSummary() {
  try {
    const reportPath = resolvePath(_cfg.paths.report);
    if (!fs.existsSync(reportPath)) return '无报告';
    const content = fs.readFileSync(reportPath, 'utf8');
    // 提取摘要行
    const lines = content.split('\n');
    const summary = [];
    for (const line of lines) {
      if (line.startsWith('- ')) summary.push(line);
      if (line.startsWith('## 摘要')) continue;
      if (summary.length >= 4) break;
    }
    return summary.join(' | ') || '报告已生成';
  } catch {
    return '读取失败';
  }
}

function main() {
  const counter = getCounter();

  if (!counter.should_review) {
    process.exit(0);
  }

  // 执行健康检查
  const healthResult = runSkillHealthCheck();
  const summary = getSkillSummary();

  // 输出复盘提示
  console.log(`🔄 对话已达${counter.turns}轮，建议复盘`);
  console.log(`技能健康状态：${summary}`);

  // 更新计数器
  updateCounter(counter.turns);

  // 输出结构化结果
  console.log(JSON.stringify({
    triggered: true,
    turns: counter.turns,
    healthCheck: healthResult,
    summary,
  }));
}

main();
