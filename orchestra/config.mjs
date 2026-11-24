// 設定：找出各 CLI 的位置、預設模型與 Copilot credits 上限。
// 想改設定就複製 config.example.json 成 config.json 再修改；環境變數 CODEX_BIN / AGY_BIN / COPILOT_BIN 優先。
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const home = os.homedir();

let user = {};
try { user = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8')); } catch {}

// 常見的安裝位置（PATH 找不到時才用）
const KNOWN = {
  codex: [
    '/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex',
    '/Applications/Codex.app/Contents/Resources/codex',
    '/opt/homebrew/bin/codex', '/usr/local/bin/codex', `${home}/.local/bin/codex`,
  ],
  agy: [
    '/Applications/Gemini.app/Contents/Helpers/agy',
    '/Applications/Antigravity.app/Contents/Resources/app/bin/agy',
    '/opt/homebrew/bin/agy', '/usr/local/bin/agy', `${home}/.local/bin/agy`,
  ],
  copilot: ['/opt/homebrew/bin/copilot', '/usr/local/bin/copilot', `${home}/.local/bin/copilot`],
};

const ENV = { codex: 'CODEX_BIN', agy: 'AGY_BIN', copilot: 'COPILOT_BIN' };

function onPath(name) {
  try { return execFileSync('/usr/bin/env', ['which', name], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null; } catch { return null; }
}

const cache = {};
// 回傳 CLI 的完整路徑，找不到就是 null
export function binPath(bin) {
  if (bin in cache) return cache[bin];
  const candidates = [process.env[ENV[bin]], user.bins?.[bin], onPath(bin), ...KNOWN[bin]].filter(Boolean);
  return (cache[bin] = candidates.find((p) => { try { fs.accessSync(p, fs.constants.X_OK); return true; } catch { return false; } }) ?? null);
}

export const MODELS = {
  gemini: 'gemini-4-neon-xhigh',
  flash: 'gemini-3.8-flash-high',
  opus: 'claude-opus-5-5-high',
  copilot: 'auto',
  ...user.models,
};

// Copilot 每期可用的 AI credits（例如學生方案 200）；用來在儀表板顯示用了多少
export const COPILOT_CREDITS = user.copilotCredits ?? 300;
