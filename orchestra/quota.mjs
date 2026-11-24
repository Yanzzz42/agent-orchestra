// 額度管理：偵測「用量不足」、記錄各 agent 的冷卻時間、等待重置的任務佇列、用量報表。
// dispatch.mjs 與 server.mjs 共用。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
export const RUNS = path.join(ROOT, 'runs');
export const LOG = path.join(RUNS, 'events.jsonl');
const COOLING = path.join(RUNS, 'quota.json');
const QUEUE = path.join(RUNS, 'queue.json');
fs.mkdirSync(RUNS, { recursive: true });

// 不知道重置時間時，先冷卻這麼久，之後再試
const DEFAULT_COOLDOWN_MS = 60 * 60 * 1000;
import { COPILOT_CREDITS } from './config.mjs';
export { COPILOT_CREDITS };

const readJson = (f, fallback) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return fallback; } };
const writeJson = (f, v) => { fs.writeFileSync(f + '.tmp', JSON.stringify(v, null, 2)); fs.renameSync(f + '.tmp', f); };

// ---- 偵測 ----

const QUOTA_RE = /usage limit|quota|rate[ -]?limit|resource[_ ]exhausted|too many requests|\b429\b|out of (?:premium )?(?:credits|requests)|insufficient credits|limit (?:has been )?reached|spend control/i;

// 只在任務失敗時檢查錯誤訊息，成功的回覆內容裡出現 quota 字樣不算
export function detectQuota(errorText) {
  if (!errorText || !QUOTA_RE.test(errorText)) return null;
  return { until: parseReset(errorText) ?? Date.now() + DEFAULT_COOLDOWN_MS, known: parseReset(errorText) != null };
}

export function parseReset(text, now = new Date()) {
  // Codex：try again at Nov 24th, 2026 1:59 AM
  let m = text.match(/try again at ([A-Z][a-z]{2,8}) (\d{1,2})(?:st|nd|rd|th)?,? (\d{4}),? (\d{1,2}:\d{2} ?[AP]M)/i);
  if (m) { const t = Date.parse(`${m[1]} ${m[2]}, ${m[3]} ${m[4]}`); if (!isNaN(t)) return t; }
  // Codex：try again at 8:37 PM（今天，已過就是明天）
  m = text.match(/try again at (\d{1,2}):(\d{2}) ?([AP]M)/i);
  if (m) {
    const d = new Date(now);
    d.setHours((+m[1] % 12) + (m[3].toUpperCase() === 'PM' ? 12 : 0), +m[2], 0, 0);
    if (d <= now) d.setDate(d.getDate() + 1);
    return d.getTime();
  }
  // retry after 30 seconds / resets in 2 hours / try again in 15m
  m = text.match(/(?:retry|try again|reset[s]?)\s+(?:after|in)\s+(\d+(?:\.\d+)?)\s*(s|sec|secs|seconds?|m|mins?|minutes?|h|hrs?|hours?|d|days?)\b/i);
  if (m) {
    const unit = { s: 1e3, m: 6e4, h: 36e5, d: 864e5 }[m[2][0].toLowerCase()];
    return now.getTime() + Number(m[1]) * unit;
  }
  // resets at 2026-11-24T01:59:00Z
  m = text.match(/reset[s]? at (\d{4}-\d{2}-\d{2}T[\d:.]+(?:Z|[+-]\d{2}:?\d{2})?)/i);
  if (m) { const t = Date.parse(m[1]); if (!isNaN(t)) return t; }
  return null;
}

// ---- 冷卻狀態 ----

export function coolingState() {
  const all = readJson(COOLING, {});
  const now = Date.now(), live = {};
  for (const [k, v] of Object.entries(all)) if (v.until > now) live[k] = v;
  return live;
}
export const coolingUntil = (agent) => coolingState()[agent]?.until ?? null;
export function setCooling(agent, until, reason) {
  const all = readJson(COOLING, {});
  all[agent] = { until, since: Date.now(), reason: String(reason || '').slice(0, 300) };
  writeJson(COOLING, all);
}

// ---- 等待重置的佇列 ----

export const readQueue = () => readJson(QUEUE, []);
export function enqueue(entry) { const q = readQueue(); q.push(entry); writeJson(QUEUE, q); }
// 取出一筆（server 到時間後呼叫 dispatch resume）
export function takeFromQueue(id) {
  const q = readQueue(), i = q.findIndex((e) => e.id === id);
  if (i < 0) return null;
  const [e] = q.splice(i, 1); writeJson(QUEUE, q); return e;
}
export function markLaunched(id) {
  const q = readQueue(), e = q.find((x) => x.id === id);
  if (e) { e.launchedAt = Date.now(); writeJson(QUEUE, q); }
}

// ---- 用量報表 ----

// Codex 自己的紀錄裡有 5 小時與每週視窗的使用百分比
function codexRateLimits() {
  const dir = path.join(os.homedir(), '.codex/sessions');
  const files = [];
  const walk = (d, depth) => {
    let entries; try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory() && depth < 3) walk(p, depth + 1);
      else if (e.name.endsWith('.jsonl')) files.push(p);
    }
  };
  walk(dir, 0);
  files.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  for (const f of files.slice(0, 15)) {
    const lines = fs.readFileSync(f, 'utf8').split('\n').reverse();
    for (const line of lines) {
      if (!line.includes('"rate_limits"')) continue;
      try {
        const find = (o) => o && typeof o === 'object' ? (o.rate_limits ?? Object.values(o).map(find).find(Boolean)) : null;
        const rl = find(JSON.parse(line));
        if (rl?.primary || rl?.secondary) {
          const w = (x) => x && { usedPercent: x.used_percent, windowMinutes: x.window_minutes, resetsAt: x.resets_at * 1000 };
          return { primary: w(rl.primary), secondary: w(rl.secondary), plan: rl.plan_type ?? null, observedAt: fs.statSync(f).mtimeMs };
        }
      } catch {}
    }
  }
  return null;
}

export function usageReport(agents) {
  const events = fs.existsSync(LOG) ? fs.readFileSync(LOG, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean) : [];
  const starts = new Map(events.filter((e) => e.type === 'start').map((e) => [e.id, e]));
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const monthStart = new Date(today.getFullYear(), today.getMonth(), 1).getTime();
  const cooling = coolingState();
  const report = {};
  for (const agent of agents) {
    const ends = events.filter((e) => e.type === 'end' && starts.get(e.id)?.agent === agent);
    const sum = (from) => ends.filter((e) => e.ts >= from).reduce((n, e) => n + (e.usage?.total ?? 0), 0);
    const lastQuota = ends.filter((e) => e.status === 'quota' || e.status === 'waiting').at(-1);
    report[agent] = {
      available: !cooling[agent],
      cooling: cooling[agent] ?? null,
      tokensToday: sum(today.getTime()),
      tokens7d: sum(Date.now() - 7 * 864e5),
      tasksToday: ends.filter((e) => e.ts >= today.getTime()).length,
      lastQuotaAt: lastQuota?.ts ?? null,
    };
  }
  if (report.codex) report.codex.rateLimits = codexRateLimits();
  if (report.copilot) {
    const used = events.filter((e) => e.type === 'end' && starts.get(e.id)?.agent === 'copilot' && e.ts >= monthStart)
      .reduce((n, e) => n + (e.usage?.credits ?? 0), 0);
    report.copilot.credits = { usedThisMonth: used, budget: COPILOT_CREDITS };
  }
  report.queue = readQueue();
  return report;
}
