#!/usr/bin/env node
/**
 * conversation-counter.js — 对话轮次计数器
 * 追踪对话轮次，判断是否达到复盘阈值
 *
 * 用法:
 *   node conversation-counter.js        # 返回当前状态
 *   node conversation-counter.js --inc  # 递增并返回
 *   node conversation-counter.js --reset # 重置
 */

const fs = require('fs');
const path = require('path');
const { getConfig, resolvePath } = require('./load-config.js');

const _cfg = getConfig();
const COUNTER_PATH = resolvePath(_cfg.paths.counter);
const REVIEW_THRESHOLD = _cfg.limits.conversation_review_threshold; // 每20轮建议复盘

function readCounter() {
  try {
    const data = JSON.parse(fs.readFileSync(COUNTER_PATH, 'utf8'));
    return {
      turns: data.turns || 0,
      last_review_turn: data.last_review_turn || 0,
      should_review: false,
    };
  } catch {
    return { turns: 0, last_review_turn: 0, should_review: false };
  }
}

function writeCounter(counter) {
  const dir = path.dirname(COUNTER_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(COUNTER_PATH, JSON.stringify(counter, null, 2));
}

function calculateShouldReview(counter) {
  const sinceLastReview = counter.turns - (counter.last_review_turn || 0);
  return sinceLastReview >= REVIEW_THRESHOLD;
}

// 主逻辑
const args = process.argv.slice(2);
let counter = readCounter();

if (args.includes('--reset')) {
  counter = { turns: 0, last_review_turn: 0, should_review: false };
  writeCounter(counter);
  console.log(JSON.stringify(counter));
} else if (args.includes('--inc')) {
  counter.turns++;
  counter.should_review = calculateShouldReview(counter);
  writeCounter(counter);
  console.log(JSON.stringify(counter));
} else {
  // 只读取，不修改
  counter.should_review = calculateShouldReview(counter);
  console.log(JSON.stringify(counter));
}
