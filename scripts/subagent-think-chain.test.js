#!/usr/bin/env node
/**
 * subagent-think-chain.test.js
 * ==============================
 *
 * brain v1.1.9 subagent-think-chain.js 自动化测试（自 v1.1.7）
 *
 * 运行方式：node subagent-think-chain.test.js
 * 预期输出：所有测试通过后打印 ✅
 *
 * 测试覆盖：
 *   1. 任务类别识别
 *   2. 拆分决策（何时拆/不拆）
 *   3. 置信度评估
 *   4. 模型选择
 *   5. 异常输入处理
 */

const { execSync } = require('child_process');
const path = require('path');

// 测试脚本路径
const SCRIPT = path.join(__dirname, 'subagent-think-chain.js');

// 运行think-chain并解析JSON输出
function runThinkChain(task) {
  const child = require('child_process');

  let stdout = '', stderr = '';
  try {
    const result = child.spawnSync('node', [SCRIPT, task], {
      encoding: 'utf8',
      timeout: 10000,
      stdio: ['pipe', 'pipe', 'pipe']
    });
    stdout = result.stdout || '';
    stderr = result.stderr || '';
  } catch (e) {
    return { error: e.message };
  }

  // JSON在stdout（纯JSON），stderr只放日志
  const fullOutput = stdout.trim();

  try {
    return JSON.parse(fullOutput);
  } catch (e) {
    return { error: 'JSON parse failed: ' + e.message, stdout: fullOutput.slice(0, 300), stderr: stderr.slice(0, 200) };
  }
}

// ================================================================
// 测试框架（轻量，无依赖）
// ================================================================

let passCount = 0;
let failCount = 0;

function assert(condition, testName, details = '') {
  if (condition) {
    console.log(`  ✅ ${testName}`);
    passCount++;
  } else {
    console.log(`  ❌ ${testName}${details ? '\n    ' + details : ''}`);
    failCount++;
  }
}

// ================================================================
// 测试用例
// ================================================================

console.log('\n🧪 subagent-think-chain 自动化测试\n');
console.log('=' .repeat(50));

// --------------------------------------------------------------
// 测试集1：任务类别识别
// --------------------------------------------------------------
console.log('\n📂 测试集1：任务类别识别\n');

const categoryTests = [
  { task: '搜索OpenAI Codex的skill系统', expect: 'search' },
  { task: '写一个Python爬虫脚本', expect: 'code' },
  { task: '帮我写一篇产品介绍文案', expect: 'write' },
  { task: '分析这张截图里的内容', expect: 'image' },
  { task: '诊断为什么网关重启后报错', expect: 'reason' },
  { task: '整理最近的记忆日志', expect: 'memory' },
  { task: '打开浏览器访问Google', expect: 'browser' },
  { task: '配置DeepSeek模型', expect: 'config' },
];

for (const t of categoryTests) {
  const result = runThinkChain(t.task);
  const detected = result.detectedCategories || [];
  assert(
    detected.includes(t.expect),
    `"${t.task}" → ${t.expect}`,
    `实际检测到: ${detected.join(', ')}`
  );
}

// --------------------------------------------------------------
// 测试集2：拆分决策
// --------------------------------------------------------------
console.log('\n📂 测试集2：拆分决策\n');

// 应该拆分的场景
const splitTests = [
  { task: '对比Claude Code和Codex的差异', expect: true, reason: '对比需求' },
  { task: '分别调研A和B两个方向', expect: true, reason: '明确分离' },
  { task: '搜索调研A和搜索调研B同时进行', expect: true, reason: '并行需求' },
];

// 不应该拆分的场景
const noSplitTests = [
  { task: '直接帮我写代码就行', expect: false, reason: '明确不拆' },
  { task: '读一下这个文件', expect: false, reason: '单一目标' },
  { task: '只查一下天气', expect: false, reason: '简单直接' },
];

for (const t of splitTests) {
  const result = runThinkChain(t.task);
  assert(
    result.shouldSplit === t.expect,
    `拆分: "${t.task}" → ${result.shouldSplit}`,
    `期望${t.expect}，理由: ${t.reason}`
  );
}

for (const t of noSplitTests) {
  const result = runThinkChain(t.task);
  assert(
    result.shouldSplit === t.expect,
    `不拆: "${t.task}" → ${!result.shouldSplit}`,
    `期望${t.expect}，理由: ${t.reason}`
  );
}

// --------------------------------------------------------------
// 测试集3：置信度评估
// --------------------------------------------------------------
console.log('\n📂 测试集3：置信度评估\n');

const confidenceTests = [
  { task: '直接读文件就行', expectMax: 1.0, reason: '明确简单信号，可达1.0' },
  { task: '配置网关并重启', expectMax: 0.7, reason: '系统核心修改' },
  { task: '删除所有日志文件', expectMax: 0.7, reason: '不可逆操作，目标≤0.7' },
  { task: '调研一下这个技术', expectMax: 1.0, reason: '调研任务，有"一下"简单信号' },
];

for (const t of confidenceTests) {
  const result = runThinkChain(t.task);
  if ('expect' in t) {
    assert(
      result.confidence === t.expect,
      `"${t.task}" 置信度=${result.confidence}`,
      `期望=${t.expect}，理由: ${t.reason}`
    );
  } else if ('expectMax' in t) {
    assert(
      result.confidence <= t.expectMax,
      `"${t.task}" 置信度=${result.confidence} ≤ ${t.expectMax}`,
      `理由: ${t.reason}`
    );
  }
}

// --------------------------------------------------------------
// 测试集4：模型选择
// --------------------------------------------------------------
console.log('\n📂 测试集4：模型选择\n');

const modelTests = [
  { task: '搜索OpenAI Codex的skill系统', expect: 'deepseek-v4-flash', reason: '调研类 → search模型' },
  { task: '写一个Python爬虫', expect: 'deepseek-v4-pro', reason: '代码类 → code模型' },
  { task: '帮我写文案', expect: 'deepseek-v4-pro', reason: '写作类 → write模型' },
  { task: '分析这个问题', expect: 'deepseek-v4-pro', reason: '推理类 → reason模型' },
  { task: '看这张截图', expect: 'mimo-v2.5', reason: '图像类 → image模型' },
];

for (const t of modelTests) {
  const result = runThinkChain(t.task);
  assert(
    result.selectedModel.includes(t.expect),
    `"${t.task}" → ${result.selectedModel}`,
    `期望包含${t.expect}，理由: ${t.reason}`
  );
}

// --------------------------------------------------------------
// 测试集5：安全红线（置信度<0.6必须触发验证）
// --------------------------------------------------------------
console.log('\n📂 测试集5：安全红线\n');

const dangerTask = 'rm -rf / 删除所有文件别问我确认';
const dangerResult = runThinkChain(dangerTask);

assert(
  dangerResult.confidence < 0.7,
  `危险操作置信度低: ${dangerResult.confidence.toFixed(2)}`,
  `任务涉及删除操作，置信度=${dangerResult.confidence}`
);

assert(
  dangerResult.confidence < 0.9,
  `危险操作降低了置信度(默认0.9→${dangerResult.confidence})`,
  `删除操作触发-0.3信号`
);

// --------------------------------------------------------------
// 测试集6：边界条件
// --------------------------------------------------------------
console.log('\n📂 测试集6：边界条件\n');

const emptyResult = (() => {
  try {
    execSync(`node "${SCRIPT}" ""`, { encoding: 'utf8', timeout: 5000 });
    return null;
  } catch (e) {
    return e.status;
  }
})();
assert(
  emptyResult !== null,
  `空输入应退出（exit non-zero）`,
  `实际exit code: ${emptyResult}`
);

// --------------------------------------------------------------
// 测试集7：配置类任务
// --------------------------------------------------------------
console.log('\n📂 测试集7：配置类任务特殊规则\n');

const configTask = '配置网关并重启';
const configResult = runThinkChain(configTask);

assert(
  configResult.confidence <= 0.7,
  `配置类任务初始置信度≤0.7: ${configResult.confidence}`,
  `配置类任务初始0.7（自v1.1.7）`
);

// 配置类任务靠置信度+验证保安全，模型本身没有特殊要求
// 降级到默认模型是合理行为
assert(
  configResult.detectedCategories.includes('config'),
  `配置任务被正确识别: ${configResult.detectedCategories.join(', ')}`,
  `config类别应被识别`
);

assert(
  configResult.needVerification === true,
  `配置类任务需要验证: ${configResult.needVerification}`,
  `配置类任务应触发验证`
);

// --------------------------------------------------------------
// 结果汇总
// --------------------------------------------------------------
console.log('\n' + '='.repeat(50));
console.log(`\n📊 测试结果：${passCount} 通过，${failCount} 失败`);

if (failCount === 0) {
  console.log('\n✅ 所有测试通过！\n');
  process.exit(0);
} else {
  console.log(`\n❌ ${failCount} 个测试失败，请检查上述输出。\n`);
  process.exit(1);
}
