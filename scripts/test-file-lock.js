#!/usr/bin/env node
/**
 * test-file-lock.js — Brain v1.1.9 文件写锁验证测试
 * =====================================================
 *
 * 测试覆盖：
 *   1. 基本加锁/解锁
 *   2. 锁冲突检测
 *   3. TTL 过期自动释放
 *   4. 强制释放
 *   5. 路径遍历防护
 *   6. 并发竞争（模拟两个进程同时 acquire）
 *
 * 用法: node test-file-lock.js
 */

const path = require('path');
const os = require('os');
const fs = require('fs');
const fsp = fs.promises;
const { FileLockManager, sanitizePath } = require('./file-lock-manager.js');

// ============================================================
// 测试状态
// ============================================================

let passed = 0;
let failed = 0;
const results = [];

function assert(condition, message) {
  if (condition) {
    passed++;
    results.push(`  ✅ ${message}`);
  } else {
    failed++;
    results.push(`  ❌ ${message}`);
  }
}

function assertEq(actual, expected, message) {
  const ok = actual === expected;
  if (ok) {
    passed++;
    results.push(`  ✅ ${message} (期望: ${expected})`);
  } else {
    failed++;
    results.push(`  ❌ ${message} (期望: ${expected}, 实际: ${actual})`);
  }
}

function assertDeep(actual, expected, message) {
  const actualStr = JSON.stringify(actual);
  const expectedStr = JSON.stringify(expected);
  const ok = actualStr === expectedStr;
  if (ok) {
    passed++;
    results.push(`  ✅ ${message}`);
  } else {
    failed++;
    results.push(`  ❌ ${message}\n     期望: ${expectedStr}\n     实际: ${actualStr}`);
  }
}

// ============================================================
// 测试辅助
// ============================================================

const TMP_DIR = path.join(os.tmpdir(), 'brain-lock-test-' + Date.now());
const TEST_FILES = {
  safe: path.join(TMP_DIR, 'test-file.txt'),
  conflict: path.join(TMP_DIR, 'conflict.txt'),
  ttl: path.join(TMP_DIR, 'ttl-test.txt'),
  force: path.join(TMP_DIR, 'force-test.txt'),
};

async function setup() {
  await fsp.mkdir(TMP_DIR, { recursive: true });
  for (const f of Object.values(TEST_FILES)) {
    await fsp.writeFile(f, '', 'utf8');
  }
}

async function teardown() {
  try {
    await fsp.rm(TMP_DIR, { recursive: true, force: true });
  } catch { /* ignore */ }
}

// ============================================================
// 测试 1: 基本加锁/解锁
// ============================================================

async function testBasic() {
  results.push('\n📦 测试 1: 基本加锁/解锁');
  const manager = new FileLockManager({ lockDir: path.join(TMP_DIR, 'locks') });

  const result = await manager.acquire(TEST_FILES.safe, 'agent-001');
  assert(result.success === true, 'acquire 应成功');

  const status1 = await manager.status(TEST_FILES.safe);
  assertEq(status1.status, 'locked', 'status 应为 locked');
  assertEq(status1.details.lockedBy, 'agent-001', 'lockedBy 应正确');

  const release = await manager.release(TEST_FILES.safe, 'agent-001');
  assert(release.success === true, 'release 应成功');

  const status2 = await manager.status(TEST_FILES.safe);
  assertEq(status2.status, 'free', '释放后 status 应为 free');

  manager.destroy();
}

// ============================================================
// 测试 2: 锁冲突检测
// ============================================================

async function testConflict() {
  results.push('\n📦 测试 2: 锁冲突检测');
  const manager = new FileLockManager({ lockDir: path.join(TMP_DIR, 'locks2') });

  // agent-001 获取锁
  const r1 = await manager.acquire(TEST_FILES.conflict, 'agent-001');
  assert(r1.success === true, 'agent-001 acquire 应成功');

  // agent-002 尝试获取同一文件
  const r2 = await manager.acquire(TEST_FILES.conflict, 'agent-002');
  assert(r2.success === false, 'agent-002 acquire 应失败');
  assertEq(r2.lockedBy, 'agent-001', '返回的 lockedBy 应为 agent-001');

  // 释放后 agent-002 可正常获取
  await manager.release(TEST_FILES.conflict, 'agent-001');
  const r3 = await manager.acquire(TEST_FILES.conflict, 'agent-002');
  assert(r3.success === true, '释放后 agent-002 acquire 应成功');

  // 清理
  await manager.release(TEST_FILES.conflict, 'agent-002');
  manager.destroy();
}

// ============================================================
// 测试 3: TTL 过期自动释放
// ============================================================

async function testTTL() {
  results.push('\n📦 测试 3: TTL 过期自动释放');
  const manager = new FileLockManager({ lockDir: path.join(TMP_DIR, 'locks3') });

  // 非常短的 TTL: 100ms
  const r1 = await manager.acquire(TEST_FILES.ttl, 'agent-ttl', 100);
  assert(r1.success === true, '短 TTL acquire 应成功');

  // 立即检查应是 locked
  const s1 = await manager.status(TEST_FILES.ttl);
  assertEq(s1.status, 'locked', 'TTL 到期前状态应为 locked');

  // 等待 TTL 过期
  await new Promise(resolve => setTimeout(resolve, 200));

  // status 应返回 expired
  const s2 = await manager.status(TEST_FILES.ttl);
  assertEq(s2.status, 'expired', 'TTL 到期后状态应为 expired');

  // 第二个 agent 应能获取（内部自动释放过期锁+重试）
  const r2 = await manager.acquire(TEST_FILES.ttl, 'agent-ttl2', 5000);
  assert(r2.success === true, '过期后其他 agent 应能获取锁');

  // 清理
  await manager.release(TEST_FILES.ttl, 'agent-ttl2');
  manager.destroy();
}

// ============================================================
// 测试 4: 强制释放
// ============================================================

async function testForceRelease() {
  results.push('\n📦 测试 4: 强制释放');
  const manager = new FileLockManager({ lockDir: path.join(TMP_DIR, 'locks4') });

  // agent-001 获取锁
  await manager.acquire(TEST_FILES.force, 'agent-001');
  const s1 = await manager.status(TEST_FILES.force);
  assertEq(s1.status, 'locked', '强制释放前应为 locked');

  // 别的 agent 无法 release
  const failedRelease = await manager.release(TEST_FILES.force, 'agent-002');
  assert(failedRelease.success === false, '非持有者 release 应失败');

  // 强制释放
  const force = await manager.forceRelease(TEST_FILES.force);
  assert(force.success === true, 'forceRelease 应成功');

  // 强制释放后状态应为 free
  const s2 = await manager.status(TEST_FILES.force);
  assertEq(s2.status, 'free', '强制释放后状态应为 free');

  // 强制释放未锁定的文件
  const forceAgain = await manager.forceRelease(TEST_FILES.force);
  assert(forceAgain.success === false, '对未锁定文件 forceRelease 应返回 false');

  manager.destroy();
}

// ============================================================
// 测试 5: 路径遍历防护
// ============================================================

async function testPathTraversal() {
  results.push('\n📦 测试 5: 路径遍历防护');

  const badPaths = [
    '../../../etc/passwd',
    'data/../../secret',
    'foo/../bar',
    '../config',
    '.',
    '..',
    '/etc/passwd\0hack',
    '',
  ];

  let caught = 0;
  for (const bp of badPaths) {
    try {
      sanitizePath(bp);
    } catch (err) {
      if (err.message.includes('路径遍历拒绝') || err.message.includes('不能为空') || err.message.includes('null 字节')) {
        caught++;
      }
    }
  }
  assertEq(caught, badPaths.length, `应捕获 ${badPaths.length} 个非法路径`);

  // 正常路径应通过
  const normal = sanitizePath('/home/user/data/file.txt');
  assert(normal.includes('file.txt'), '正常路径应通过检查');

  const manager = new FileLockManager({ lockDir: path.join(TMP_DIR, 'locks5') });

  // 遍历路径传给 acquire 应抛错
  for (const bp of badPaths) {
    if (!bp) continue; // 空字符串在前面测试了
    try {
      await manager.acquire(bp, 'agent-x');
      assert(false, `非法路径 ${bp} 应抛出错误`);
    } catch (err) {
      if (err.message.includes('路径遍历拒绝') || err.message.includes('null 字节')) {
        assert(true, `合法拒绝: ${err.message}`);
      } else if (err.message.includes('不能为空')) {
        assert(true, '合法拒绝: 空路径');
      } else {
        assert(false, `意外的错误: ${err.message}`);
      }
    }
  }

  manager.destroy();
}

// ============================================================
// 测试 6: 并发竞争（模拟两个进程同时 acquire）
// ============================================================

async function testConcurrent() {
  results.push('\n📦 测试 6: 并发竞争模拟');

  // 注意：这是单进程内的并发模拟，用 Promise.all 模拟近乎同时的请求
  // 真正的多进程并发需要外部编排，这里验证核心的 link O_EXCL 竞争逻辑

  const manager = new FileLockManager({ lockDir: path.join(TMP_DIR, 'locks6') });
  const concurrencyFile = path.join(TMP_DIR, 'concurrent-file.txt');
  await fsp.writeFile(concurrencyFile, '', 'utf8');

  const NUM_AGENTS = 20; // 20 个 agent 同时抢锁
  const results_arr = await Promise.all(
    Array.from({ length: NUM_AGENTS }, (_, i) =>
      manager.acquire(concurrencyFile, `agent-con-${i}`, 500)
    )
  );

  // 只有一个应成功
  const successCount = results_arr.filter(r => r.success).length;
  assertEq(successCount, 1, `20 个并发请求中只有 1 个应成功，实际: ${successCount}`);

  const firstSuccess = results_arr.find(r => r.success);
  assert(firstSuccess !== undefined, '至少有一个 acquire 成功');

  if (firstSuccess) {
    const s = await manager.status(concurrencyFile);
    assertEq(s.details.lockedBy, firstSuccess.file ? firstSuccess.lockedBy || 'agent-con-0' : 'agent-con-0',
      '锁持有者应为最先成功的 agent');
  }

  // 等待所有 TTL 过期
  await new Promise(resolve => setTimeout(resolve, 700));

  // 过期后 cleanup
  const { cleaned } = await manager.cleanup();
  assert(cleaned >= 1, `cleanup 应清理过期锁 (cleaned: ${cleaned})`);

  const sFinal = await manager.status(concurrencyFile);
  assertEq(sFinal.status, 'free', '清理后状态应为 free');

  manager.destroy();
}

// ============================================================
// 测试 7: listActive 和 listByAgent
// ============================================================

async function testListing() {
  results.push('\n📦 测试 7: 列表功能');
  const manager = new FileLockManager({ lockDir: path.join(TMP_DIR, 'locks7') });

  const fileA = path.join(TMP_DIR, 'list-a.txt');
  const fileB = path.join(TMP_DIR, 'list-b.txt');
  const fileC = path.join(TMP_DIR, 'list-c.txt');
  await fsp.writeFile(fileA, '', 'utf8');
  await fsp.writeFile(fileB, '', 'utf8');
  await fsp.writeFile(fileC, '', 'utf8');

  await manager.acquire(fileA, 'agent-list-1', 5000);
  await manager.acquire(fileB, 'agent-list-1', 5000);
  await manager.acquire(fileC, 'agent-list-2', 5000);

  const allLocks = await manager.listActive();
  assertEq(allLocks.length, 3, 'listActive 应返回 3 个锁');

  const agent1Locks = await manager.listByAgent('agent-list-1');
  assertEq(agent1Locks.length, 2, 'agent-list-1 应有 2 个锁');

  const agent2Locks = await manager.listByAgent('agent-list-2');
  assertEq(agent2Locks.length, 1, 'agent-list-2 应有 1 个锁');

  // 清理
  await manager.release(fileA, 'agent-list-1');
  await manager.release(fileB, 'agent-list-1');
  await manager.release(fileC, 'agent-list-2');
  manager.destroy();
}

// ============================================================
// 测试 8: stats 功能
// ============================================================

async function testStats() {
  results.push('\n📦 测试 8: 统计信息');
  const manager = new FileLockManager({ lockDir: path.join(TMP_DIR, 'locks8') });

  const stats = await manager.stats();
  assert(typeof stats.lockDir === 'string', 'stats 应包含 lockDir');
  assert(stats.defaultTtlMs === 300000, '默认 TTL 应为 300000ms');
  assert(typeof stats.activeLocks === 'number', 'stats 应包含 activeLocks');

  const lockDir = manager.getLockDir();
  assert(lockDir.includes('locks8'), 'getLockDir() 应返回正确路径');

  manager.destroy();
}

// ============================================================
// 主函数
// ============================================================

async function main() {
  console.log('🔧 文件写锁验证测试');
  console.log(`   临时目录: ${TMP_DIR}\n`);

  await setup();

  try {
    await testBasic();
    await testConflict();
    await testTTL();
    await testForceRelease();
    await testPathTraversal();
    await testConcurrent();
    await testListing();
    await testStats();
  } catch (err) {
    console.error('💥 测试执行异常:', err);
    failed++;
    results.push(`  💥 异常: ${err.message}`);
  }

  // 输出结果
  console.log(results.join('\n'));

  const total = passed + failed;
  console.log(`\n========================================`);
  console.log(`📊 总计: ${total} 项`);
  console.log(`   ✅ 通过: ${passed}`);
  console.log(`   ❌ 失败: ${failed}`);

  // 清理临时目录
  await teardown();

  process.exit(failed > 0 ? 1 : 0);
}

main();
