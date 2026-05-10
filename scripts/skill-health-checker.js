#!/usr/bin/env node
/**
 * skill-health-checker.js — 技能健康检查器
 * 扫描技能目录，检测低频/废弃/异常技能
 * 判断依据：skill-usage.json 实际使用记录（不是文件时间戳）
 *
 * 用法: node skill-health-checker.js
 * 输出: 写入 memory/skill-health-report.md
 */

const fs = require('fs');
const path = require('path');
const { getConfig, resolvePath } = require('./load-config.js');

const _cfg = getConfig();
const SKILLS_DIRS = _cfg.skills_dirs;
const REPORT_PATH = resolvePath(_cfg.paths.report);
const USAGE_PATH = resolvePath(_cfg.paths.usage);
const DAYS_LOW_FREQ = _cfg.limits.days_low_frequency;
const DAYS_ABANDONED = _cfg.limits.days_abandoned;

function findSkills() {
  const skills = [];
  for (const dir of SKILLS_DIRS) {
    if (!fs.existsSync(dir)) continue;
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        const skillPath = path.join(dir, entry.name);
        const skillMd = path.join(skillPath, 'SKILL.md');
        if (fs.existsSync(skillMd)) {
          skills.push({
            name: entry.name,
            path: skillPath,
            hasSkillMd: true,
          });
        }
      }
    }
  }
  return skills;
}

function loadUsage() {
  try {
    return JSON.parse(fs.readFileSync(USAGE_PATH, 'utf8'));
  } catch {
    return {};
  }
}

function categorizeSkills(skills) {
  const usage = loadUsage();
  const healthy = [];
  const lowFreq = [];
  const abandoned = [];
  const needsRepair = [];

  for (const skill of skills) {
    const record = usage[skill.name] || {};
    const useCount = record.use_count || 0;
    const errorCount = record.error_count || 0;
    const lastUsed = record.last_used ? new Date(record.last_used) : null;
    const daysSinceUsed = lastUsed
      ? Math.floor((Date.now() - lastUsed.getTime()) / (1000 * 60 * 60 * 24))
      : null;

    const item = { ...skill, useCount, errorCount, daysSinceUsed };

    // 优先判断：需要修补（只看错误次数，不看文档）
    if (errorCount > 0) {
      needsRepair.push({ ...item, reason: `错误次数: ${errorCount}` });
      continue;
    }

    // 废弃：use_count=0 且 超过180天未使用
    if (useCount === 0 && daysSinceUsed !== null && daysSinceUsed > DAYS_ABANDONED) {
      abandoned.push(item);
      continue;
    }

    // 低频：use_count=0 且 超过30天未使用
    if (useCount === 0 && daysSinceUsed !== null && daysSinceUsed > DAYS_LOW_FREQ) {
      lowFreq.push(item);
      continue;
    }

    // 活跃或新skill（至少被用过 or 30天内）
    healthy.push(item);
  }

  return { healthy, lowFreq, abandoned, needsRepair };
}

function generateReport(categorized, total) {
  const { healthy, lowFreq, abandoned, needsRepair } = categorized;
  const now = new Date().toISOString();

  let report = `# 技能健康检查报告\n\n`;
  report += `生成时间: ${now}\n`;
  report += `技能总数: ${total}\n\n`;

  report += `## 摘要\n\n`;
  report += `- 健康: ${healthy.length}\n`;
  report += `- 低频（>${DAYS_LOW_FREQ}天未使用）: ${lowFreq.length}\n`;
  report += `- 废弃（>${DAYS_ABANDONED}天未使用）: ${abandoned.length}\n`;
  report += `- 需要修补（错误>0）: ${needsRepair.length}\n\n`;

  if (needsRepair.length > 0) {
    report += `## 需要修补\n\n`;
    report += `| 技能名 | 使用次数 | 错误次数 | 原因 |\n`;
    report += `|--------|---------|---------|------|\n`;
    for (const s of needsRepair) {
      report += `| ${s.name} | ${s.useCount} | ${s.errorCount} | ${s.reason} |\n`;
    }
    report += `\n`;
  }

  if (lowFreq.length > 0) {
    report += `## 低频技能\n\n`;
    report += `| 技能名 | 使用次数 | 末次使用（天前） |\n`;
    report += `|--------|---------|---------------|\n`;
    for (const s of lowFreq) {
      report += `| ${s.name} | ${s.useCount} | ${s.daysSinceUsed}天 |\n`;
    }
    report += `\n`;
  }

  if (abandoned.length > 0) {
    report += `## 废弃技能\n\n`;
    report += `| 技能名 | 使用次数 | 末次使用（天前） |\n`;
    report += `|--------|---------|---------------|\n`;
    for (const s of abandoned) {
      report += `| ${s.name} | ${s.useCount} | ${s.daysSinceUsed}天 |\n`;
    }
    report += `\n`;
  }

  return report;
}

function main() {
  const skills = findSkills();
  const categorized = categorizeSkills(skills);
  const report = generateReport(categorized, skills.length);

  const dir = path.dirname(REPORT_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(REPORT_PATH, report);

  console.log(JSON.stringify({
    status: 'ok',
    total: skills.length,
    healthy: categorized.healthy.length,
    lowFreq: categorized.lowFreq.length,
    abandoned: categorized.abandoned.length,
    needsRepair: categorized.needsRepair.length,
    reportPath: REPORT_PATH,
  }));
}

main();
