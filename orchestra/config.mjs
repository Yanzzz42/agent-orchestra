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
  codex: process.platform === 'darwin' ? [
    '/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex',
    '/Applications/Codex.app/Contents/Resources/codex',
    '/opt/homebrew/bin/codex', '/usr/local/bin/codex', `${home}/.local/bin/codex`,
  ] : [],
  agy: process.platform === 'darwin' ? [
    '/Applications/Gemini.app/Contents/Helpers/agy',
    '/Applications/Antigravity.app/Contents/Resources/app/bin/agy',
    '/opt/homebrew/bin/agy', '/usr/local/bin/agy', `${home}/.local/bin/agy`,
  ] : [],
  copilot: process.platform === 'darwin' ? ['/opt/homebrew/bin/copilot', '/usr/local/bin/copilot', `${home}/.local/bin/copilot`] : [],
};

const ENV = { codex: 'CODEX_BIN', agy: 'AGY_BIN', copilot: 'COPILOT_BIN' };

function onPath(name) {
  try {
    if (process.platform === 'win32') {
      const results = execFileSync('where.exe', [name], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
        .split(/\r?\n/).map((p) => p.trim()).filter(Boolean);
      return results.find((p) => /\.exe$/i.test(p)) || results.find((p) => /\.cmd$/i.test(p)) || results[0] || null;
    }
    return execFileSync('/usr/bin/env', ['which', name], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null;
  } catch { return null; }
}

if (process.platform === 'win32') {
  const { APPDATA, LOCALAPPDATA, ProgramFiles } = process.env;
  if (APPDATA) {
    KNOWN.codex.push(path.join(APPDATA, 'npm', 'codex.cmd'));
    KNOWN.copilot.push(path.join(APPDATA, 'npm', 'copilot.cmd'));
  }
  if (LOCALAPPDATA) {
    KNOWN.agy.push(
      path.join(LOCALAPPDATA, 'Programs', 'Antigravity', 'resources', 'app', 'bin', 'agy.exe'),
      path.join(LOCALAPPDATA, 'Programs', 'Antigravity', 'resources', 'app', 'bin', 'agy.cmd'),
    );
    KNOWN.copilot.push(path.join(LOCALAPPDATA, 'Microsoft', 'WinGet', 'Links', 'copilot.exe'));
  }
  if (ProgramFiles) {
    KNOWN.agy.push(path.join(ProgramFiles, 'Antigravity', 'resources', 'app', 'bin', 'agy.exe'));
  }
} else if (process.platform !== 'darwin') {
  KNOWN.codex = [`${home}/.local/bin/codex`];
  KNOWN.agy = [`${home}/.local/bin/agy`];
  KNOWN.copilot = [`${home}/.local/bin/copilot`];
}

const cache = {};
// 回傳 CLI 的完整路徑，找不到就是 null
export function binPath(bin) {
  if (bin in cache) return cache[bin];
  const candidates = [process.env[ENV[bin]], user.bins?.[bin], onPath(bin), ...KNOWN[bin]].filter(Boolean);
  const access = process.platform === 'win32' ? fs.constants.F_OK : fs.constants.X_OK;
  return (cache[bin] = candidates.find((p) => { try { fs.accessSync(p, access); return true; } catch { return false; } }) ?? null);
}

export function spawnable(cmd, args) {
  if (process.platform !== 'win32' || !/\.(?:cmd|bat)$/i.test(cmd)) return { cmd, args };
  try {
    const shim = fs.readFileSync(cmd, 'utf8');
    const match = shim.match(/["']?((?:%~?dp0%?|%~?dp0)[\\/][^"'\r\n]*?\.js)["']?/i);
    if (match) {
      const relative = match[1].replace(/%~?dp0%?/i, '').replace(/^[\\/]+/, '').replace(/[\\/]/g, path.sep);
      const jsPath = path.resolve(path.dirname(cmd), relative);
      if (fs.existsSync(jsPath)) return { cmd: process.execPath, args: [jsPath, ...args] };
    }
  } catch {}
  // If the shim format is unknown, shell:true is the fallback; prompt quoting may be limited on Windows.
  return { cmd, args, shell: true };
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
