#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const [major] = process.versions.node.split('.').map(Number);
if (major < 18) {
  console.error(`✗ Node.js ${process.version} 太舊，需要 18 以上 / Node.js 18+ is required`);
  process.exit(1);
}

const skillDir = path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'skills', 'team');
const skillPath = path.join(skillDir, 'SKILL.md');
fs.mkdirSync(skillDir, { recursive: true });
if (fs.existsSync(skillPath)) {
  fs.copyFileSync(skillPath, `${skillPath}.bak`);
  console.log(`• 已備份原本的 /team skill / Backed up existing skill → ${skillPath}.bak`);
}

const orchestraHome = process.platform === 'win32' ? ROOT.replace(/\\/g, '/') : ROOT;
const source = fs.readFileSync(path.join(ROOT, 'skill', 'team', 'SKILL.md'), 'utf8');
fs.writeFileSync(skillPath, source.replaceAll('{{ORCHESTRA_HOME}}', orchestraHome));
console.log(`✓ 已安裝 /team skill / Installed /team skill → ${skillPath}`);
console.log();

spawnSync(process.execPath, [path.join(ROOT, 'orchestra', 'dispatch.mjs'), 'doctor'], { stdio: 'inherit', windowsHide: true });

console.log(`
下一步 / Next steps
  1. 在 Claude Code 開新對話，輸入 /team 加上任務，例如：/team 幫我把這個專案的測試補齊
     Open a new Claude Code session and type /team followed by a task.
  2. 儀表板 / Dashboard:  node "${path.join(ROOT, 'orchestra', 'server.mjs')}"  →  http://localhost:4747
  3. 自動駕駛（選用）/ Autopilot (optional):  /team 設定自動駕駛
`);
