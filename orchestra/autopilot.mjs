// 自動駕駛狀態：儀表板的專案開關寫入這裡，排程任務每次喚醒先讀它決定要不要工作、做哪些專案。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const FILE = path.join(ROOT, 'autopilot.json');
export const RULES_DIR = path.join(path.dirname(ROOT), 'autopilot');
const TEMPLATE = path.join(RULES_DIR, '_template.md');

// 一輪標記為執行中超過這麼久，視為上一輪已中斷（例如 Claude 額度用完）
export const STALE_MS = 2 * 60 * 60 * 1000;
export const PUBLISH = { auto: '測試通過自動發佈', commit: '只 commit 不發佈' };

const DEFAULTS = {
  intervalHours: 3,
  running: false,
  startedAt: null,
  round: 0,
  lastRunAt: null,
  lastResult: null,
  projects: [],
  // 用量守護：Claude 每週用量達 weeklyLimit% 就暫停到每週額度重置
  guard: { weeklyLimit: 80, pausedUntil: null, trippedAt: null, lastUsage: null },
};

// 每次排程執行回報 Claude 的方案用量；達到門檻就暫停到每週重置時間。回傳 { tripped, state }
export function reportUsage({ weekly, weeklyResetsAt, fiveHour }) {
  const s = readAutopilot();
  const lastUsage = { weekly, weeklyResetsAt, fiveHour, at: Date.now() };
  const tripped = weekly >= s.guard.weeklyLimit;
  const guard = { ...s.guard, lastUsage,
    ...(tripped ? { pausedUntil: weeklyResetsAt || Date.now() + 24 * 36e5, trippedAt: Date.now() } : {}) };
  return { tripped, state: writeAutopilot({ guard }) };
}

export const guardPaused = (s = readAutopilot()) => (s.guard.pausedUntil && s.guard.pausedUntil > Date.now() ? s.guard.pausedUntil : null);

export function readAutopilot() {
  let s;
  try { s = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { s = {}; }
  const merged = { ...DEFAULTS, ...s };
  merged.guard = { ...DEFAULTS.guard, ...(s.guard || {}) };
  return merged;
}

export function writeAutopilot(patch) {
  const next = { ...readAutopilot(), ...patch };
  fs.writeFileSync(FILE + '.tmp', JSON.stringify(next, null, 2));
  fs.renameSync(FILE + '.tmp', FILE);
  return next;
}

export const enabledProjects = (s = readAutopilot()) => s.projects.filter((p) => p.enabled);

export function updateProject(id, patch) {
  const s = readAutopilot();
  const projects = s.projects.map((p) => (p.id === id ? { ...p, ...patch } : p));
  if (!projects.some((p) => p.id === id)) throw new Error(`找不到專案 ${id}`);
  return writeAutopilot({ projects });
}

export function removeProject(id) {
  const s = readAutopilot();
  return writeAutopilot({ projects: s.projects.filter((p) => p.id !== id) });
}

// 新增專案：資料夾必須存在且在家目錄底下；規則檔從範本建立（已有就沿用）
export function addProject({ name, path: dir, publish = 'commit', site = '' }) {
  const abs = path.resolve(String(dir || '').replace(/^~(?=\/|$)/, os.homedir()));
  if (!abs.startsWith(os.homedir() + path.sep)) throw new Error('專案資料夾必須在家目錄底下');
  if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) throw new Error(`找不到資料夾：${abs}`);
  if (!PUBLISH[publish]) throw new Error('發佈方式只能是 auto 或 commit');
  const s = readAutopilot();
  if (s.projects.some((p) => p.path === abs)) throw new Error('這個資料夾已經在清單裡');
  const label = String(name || '').trim() || path.basename(abs);
  let id = label.toLowerCase().replace(/[^a-z0-9一-鿿]+/g, '-').replace(/^-|-$/g, '') || 'project';
  while (s.projects.some((p) => p.id === id)) id += '-2';
  const rules = path.join(RULES_DIR, `${id}.md`);
  if (!fs.existsSync(rules)) {
    const tpl = fs.readFileSync(TEMPLATE, 'utf8');
    fs.writeFileSync(rules, tpl.replaceAll('{{name}}', label).replaceAll('{{path}}', abs).replaceAll('{{site}}', site || '（未設定）'));
  }
  const project = { id, name: label, path: abs, rules, site, publish, enabled: false, addedAt: Date.now() };
  writeAutopilot({ projects: [...s.projects, project] });
  return project;
}

// 下一次排程喚醒的時間（每 intervalHours 小時整點，排程本身另有幾分鐘的延遲）
export function nextWake(state, now = new Date()) {
  const d = new Date(now); d.setMinutes(0, 0, 0);
  do d.setHours(d.getHours() + 1); while (d.getHours() % state.intervalHours !== 0);
  return d.getTime();
}
