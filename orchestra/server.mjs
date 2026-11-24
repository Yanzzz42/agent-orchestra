#!/usr/bin/env node
// 儀表板伺服器：提供 index.html，並用 SSE 即時推送 runs/events.jsonl 的新事件。
import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readQueue, markLaunched, usageReport } from './quota.mjs';
import { readAutopilot, writeAutopilot, updateProject, addProject, removeProject, nextWake, PUBLISH } from './autopilot.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const RUNS = path.join(ROOT, 'runs');
const LOG = path.join(RUNS, 'events.jsonl');
const PORT = Number(process.env.PORT || 4747);
fs.mkdirSync(RUNS, { recursive: true });
if (!fs.existsSync(LOG)) fs.writeFileSync(LOG, '');

const clients = new Set();
let offset = 0;

function readNew() {
  const size = fs.statSync(LOG).size;
  if (size < offset) offset = 0; // 檔案被清空
  if (size === offset) return [];
  const fd = fs.openSync(LOG, 'r');
  const buf = Buffer.alloc(size - offset);
  fs.readSync(fd, buf, 0, buf.length, offset);
  fs.closeSync(fd);
  const text = buf.toString('utf8');
  const lastNl = text.lastIndexOf('\n');
  if (lastNl < 0) return [];
  offset += Buffer.byteLength(text.slice(0, lastNl + 1));
  return text.slice(0, lastNl).split('\n').filter(Boolean);
}

// 額度重置後自動接續佇列裡等待的任務
const RESUME_LOG = path.join(RUNS, 'resume.log');
setInterval(() => {
  for (const e of readQueue()) {
    if (e.until > Date.now() || e.launchedAt) continue;
    markLaunched(e.id);
    const out = fs.openSync(RESUME_LOG, 'a');
    spawn(process.execPath, [path.join(ROOT, 'dispatch.mjs'), 'resume', e.id],
      { cwd: e.opts?.cwd || ROOT, stdio: ['ignore', out, out], detached: true }).unref();
    fs.closeSync(out);
    console.log(`額度已重置，接續任務 ${e.id}（${e.agent}）`);
  }
}, 15000);

readNew(); // 起始 offset 移到檔尾，歷史事件在連線時另外送
setInterval(() => {
  const lines = readNew();
  for (const line of lines) for (const res of clients) res.write(`data: ${line}\n\n`);
}, 400);

http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/events') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    const history = fs.readFileSync(LOG, 'utf8').slice(0, offset).split('\n').filter(Boolean);
    for (const line of history) res.write(`data: ${line}\n\n`);
    clients.add(res);
    req.on('close', () => clients.delete(res));
    return;
  }
  if (url.pathname === '/quota') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify(usageReport(['codex', 'opus', 'gemini', 'flash', 'copilot'])));
  }
  if (url.pathname === '/autopilot') {
    const send = (s) => { res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify({ ...s, nextWake: nextWake(s) })); };
    if (req.method !== 'POST') return send(readAutopilot());
    // 只接受本機儀表板頁面送來的開關（擋掉其他網站從瀏覽器偷偷觸發）
    if (req.headers['content-type'] !== 'application/json' || !/^http:\/\/(localhost|127\.0\.0\.1):\d+$/.test(req.headers.origin || '')) {
      res.writeHead(403).end(); return;
    }
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      const note = (text) => fs.appendFileSync(LOG, JSON.stringify({ ts: Date.now(), type: 'note', agent: 'claude', text: `🤖 ${text}` }) + '\n');
      try {
        const b = JSON.parse(body);
        const name = () => readAutopilot().projects.find((p) => p.id === b.id)?.name ?? b.id;
        if (b.action === 'toggle' && typeof b.enabled === 'boolean') {
          updateProject(b.id, { enabled: b.enabled });
          note(`你在儀表板${b.enabled ? '開啟' : '關閉'}了「${name()}」的自動駕駛`);
        } else if (b.action === 'publish' && PUBLISH[b.publish]) {
          updateProject(b.id, { publish: b.publish });
          note(`「${name()}」的發佈方式改為：${PUBLISH[b.publish]}`);
        } else if (b.action === 'add') {
          const p = addProject({ name: b.name, path: b.path, publish: b.publish, site: b.site });
          note(`自動駕駛新增專案「${p.name}」（${PUBLISH[p.publish]}，預設關閉）`);
        } else if (b.action === 'guard' && Number.isInteger(b.weeklyLimit) && b.weeklyLimit >= 1 && b.weeklyLimit <= 100) {
          const s = readAutopilot();
          writeAutopilot({ guard: { ...s.guard, weeklyLimit: b.weeklyLimit } });
          note(`用量守護門檻改為：Claude 每週用量 ${b.weeklyLimit}%`);
        } else if (b.action === 'resume') {
          const s = readAutopilot();
          writeAutopilot({ guard: { ...s.guard, pausedUntil: null } });
          note('你在儀表板解除了用量守護的暫停');
        } else if (b.action === 'remove') {
          const n = name(); removeProject(b.id); note(`自動駕駛移除專案「${n}」`);
        } else throw new Error('不支援的操作');
        send(readAutopilot());
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }
  const m = url.pathname.match(/^\/output\/([\w-]+)$/);
  if (m) {
    const f = path.join(RUNS, `${m[1]}.md`);
    res.writeHead(fs.existsSync(f) ? 200 : 404, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end(fs.existsSync(f) ? fs.readFileSync(f) : '（尚無輸出）');
  }
  if (url.pathname === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(fs.readFileSync(path.join(ROOT, 'index.html')));
  }
  res.writeHead(404).end();
}).listen(PORT, '127.0.0.1', () => console.log(`儀表板：http://localhost:${PORT}`)); // 只開給本機，開關能觸發自動發佈
