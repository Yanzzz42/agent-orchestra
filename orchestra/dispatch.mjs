#!/usr/bin/env node
// 派工腳本：Claude（決策者）用它把子任務交給 Codex / Gemini（經 Antigravity CLI）/ Copilot CLI，
// 每次派工都寫入 runs/events.jsonl，儀表板即時讀取。
//
// 用法：
//   node orchestra/dispatch.mjs <codex|gemini|flash|copilot> [--write] [--model M] [--cwd DIR] [--title T]
//        [--fallback a,b | --fallback none] [--wait] "prompt"
//   echo "prompt" | node orchestra/dispatch.mjs codex --title "寫測試"
//   node orchestra/dispatch.mjs note "決策說明"        # 記錄決策者的分工理由
//   node orchestra/dispatch.mjs claude start [--cwd DIR] --title T "要做什麼"   # Claude 自己接的工作，印出任務 id
//   node orchestra/dispatch.mjs claude end <id> [--fail] "結果摘要"
//   node orchestra/dispatch.mjs usage [--json]       # 各 agent 的額度與用量
//   node orchestra/dispatch.mjs resume <id>          # 由 server 在額度重置後呼叫，接續等待中的任務
//   node orchestra/dispatch.mjs autopilot check [專案id] | begin | end "摘要" | status   # 自動駕駛（排程任務用）
//   node orchestra/dispatch.mjs autopilot add <資料夾> [--title 名稱] [--publish auto|commit] [--site URL]
//   node orchestra/dispatch.mjs autopilot on|off|remove <專案id>
//
// 用量不足時（不算失敗）：
//   - 預設：交給備援鏈中下一個有額度的 agent 接手，最後一棒是 Claude 自己。
//   - --wait 或 --fallback none：排進佇列，等該 agent 額度重置後由 server 自動接續原本的對話。
// 結束碼：0 完成、1 失敗、3 等待重置、4 交給 Claude 接手。

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RUNS, LOG, detectQuota, coolingUntil, setCooling, enqueue, takeFromQueue, usageReport } from './quota.mjs';
import { readAutopilot, writeAutopilot, enabledProjects, addProject, removeProject, updateProject, reportUsage, guardPaused, PUBLISH, STALE_MS } from './autopilot.mjs';
import { binPath, MODELS, spawnable } from './config.mjs';

const BIN = new Proxy({}, { get: (_, bin) => binPath(bin) });

const AGENTS = {
  codex: { bin: 'codex', label: 'Codex', defaultModel: null },
  gemini: { bin: 'agy', label: 'Gemini', defaultModel: MODELS.gemini },
  flash: { bin: 'agy', label: 'Gemini Flash', defaultModel: MODELS.flash },
  // 經 Antigravity 呼叫 Claude Opus：算 Google AI Pro 的「Claude and GPT models」額度，不扣 Claude 訂閱用量
  opus: { bin: 'agy', label: 'Opus（Antigravity）', defaultModel: MODELS.opus },
  // 每次呼叫扣 Copilot 的 AI credits；auto 由 Copilot 自選模型
  copilot: { bin: 'copilot', label: 'Copilot', defaultModel: MODELS.copilot },
};
const installed = (agent) => agent === 'claude' || !!binPath(AGENTS[agent]?.bin);
const LABEL = { ...Object.fromEntries(Object.entries(AGENTS).map(([k, v]) => [k, v.label])), claude: 'Claude' };

// 用量不足時的接手順序；claude 是最後一棒（由這個對話裡的 Claude 自己做）
// agy 系列（opus / gemini / flash）能改檔但不能跑指令，測試由 Claude 跑。
// 先用 Antigravity 裡額度充裕的池子，Copilot（扣 credits）排後面；Gemini 4 全系列與 Flash 共用同一個額度池。
const FALLBACK = {
  codex: ['opus', 'gemini', 'copilot', 'claude'],
  opus: ['codex', 'flash', 'claude'],
  copilot: ['codex', 'opus', 'claude'],
  gemini: ['opus', 'flash', 'claude'],
  flash: ['opus', 'gemini', 'claude'],
};

const RESUME_PROMPT = '你先前的工作因為額度用完被中斷了。請先檢查目前檔案與進度，從中斷的地方繼續完成原本的任務，最後完整回報結果。';

const emit = (ev) => fs.appendFileSync(LOG, JSON.stringify({ ts: Date.now(), ...ev }) + '\n');
const newId = () => new Date().toISOString().replace(/[-:T]/g, '').slice(4, 14) + '-' + Math.random().toString(36).slice(2, 6);
const fmtTime = (t) => new Date(t).toLocaleString('zh-TW', { hour12: false, month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });

function parseArgs(argv) {
  const opts = { write: false, model: null, cwd: process.cwd(), title: null, fallback: null, wait: false, fail: false, json: false, rest: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--write') opts.write = true;
    else if (a === '--model') opts.model = argv[++i];
    else if (a === '--cwd') opts.cwd = path.resolve(argv[++i]);
    else if (a === '--title') opts.title = argv[++i];
    else if (a === '--fallback') opts.fallback = argv[++i];
    else if (a === '--wait') opts.wait = true;
    else if (a === '--fail') opts.fail = true;
    else if (a === '--json') opts.json = true;
    else if (a === '--publish') opts.publish = argv[++i];
    else if (a === '--site') opts.site = argv[++i];
    else opts.rest.push(a);
  }
  return opts;
}

// 有 prompt 參數時只等管線一下：沒有資料就不再等（呼叫端沒關 stdin 也不會卡住，Windows 不必加 </dev/null）
function readStdin(hasArgs) {
  if (process.stdin.isTTY) return Promise.resolve('');
  return new Promise((resolve) => {
    let s = '';
    const done = () => { clearTimeout(timer); process.stdin.pause(); resolve(s); };
    const timer = hasArgs ? setTimeout(() => { if (!s) done(); }, 300) : null;
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (d) => (s += d)).on('end', done).on('error', done);
  });
}

// session：要接續的對話 id（resume 時才有）
function buildCommand(agentKey, prompt, opts, outFile, session) {
  const agent = AGENTS[agentKey];
  const model = opts.model || agent.defaultModel;
  if (agent.bin === 'codex') {
    const sandbox = opts.write ? 'workspace-write' : 'read-only';
    const args = session
      ? ['exec', 'resume', session, '--skip-git-repo-check', '--json', '-o', outFile, '-c', `sandbox_mode="${sandbox}"`]
      : ['exec', '--skip-git-repo-check', '--json', '-o', outFile, '-s', sandbox, '-C', opts.cwd];
    if (model) args.push('-m', model);
    args.push(prompt);
    return { cmd: BIN.codex, args, model: model || 'codex 預設' };
  }
  if (agent.bin === 'copilot') {
    // 唯讀：拿掉 write / shell，只剩讀檔與搜尋工具；--write：允許所有工具，路徑仍限於 cwd
    // 先指定 session id，之後才能用 --resume 接續
    const sessionId = session || randomUUID();
    const args = ['-p', prompt, '--output-format', 'json', '--no-ask-user', '--no-auto-update',
      '--model', model, '--allow-all-tools', ...(session ? ['--resume', session] : ['--session-id', sessionId])];
    if (!opts.write) args.push('--deny-tool', 'write', '--deny-tool', 'shell');
    return { cmd: BIN.copilot, args, model, session: sessionId };
  }
  // 不用 --mode plan：plan 模式會把內容寫進計畫文件、回覆常常是空的，而且慢又耗 token。
  // print 模式沒人能核准終端指令，agy 一跑指令就會中斷整個任務，所以事先禁止。
  const rules = opts.write
    ? '【規則】可以讀寫檔案，但不要執行任何終端指令（這個模式下會被拒絕並中斷任務）。完成後在最後的回覆中摘要你改了什麼。'
    : '【規則】唯讀任務：只用搜尋與讀檔工具，不要執行終端指令、不要建立或修改任何檔案。把完整結果直接寫在最後的回覆裡，不要另存成文件。';
  const args = ['-p', `${rules}\n\n${prompt}`, '--output-format', 'json', '--model', model, '--print-timeout', '0'];
  if (opts.write) args.push('--mode', 'accept-edits');
  if (session) args.push('--conversation', session);
  return { cmd: BIN.agy, args, model };
}

// agy 回覆是空的時候，到它的對話紀錄找原因：中途被拒的工具呼叫，或另存的文件
function agyFallback(conversationId) {
  const dir = path.join(os.homedir(), '.gemini/antigravity-cli/brain', conversationId || '');
  if (!conversationId || !fs.existsSync(dir)) return { text: '', error: null };
  const docs = fs.readdirSync(dir).filter((f) => f.endsWith('.md'))
    .map((f) => `<!-- ${f} -->\n` + fs.readFileSync(path.join(dir, f), 'utf8'));
  let error = null, lastText = '';
  const log = path.join(dir, '.system_generated/logs/transcript_full.jsonl');
  if (fs.existsSync(log)) {
    for (const line of fs.readFileSync(log, 'utf8').split('\n')) {
      try {
        const s = JSON.parse(line);
        if (s.status === 'ERROR') error = s.error || '工具呼叫失敗';
        if (s.type === 'PLANNER_RESPONSE' && s.content) lastText = s.content;
      } catch {}
    }
  }
  return { text: docs.join('\n\n') || lastText, error };
}

// 從 codex --json 的 JSONL 中找最後一筆 usage、對話 id 與錯誤訊息
function codexResult(stdout) {
  let usage = null, session = null; const errors = [];
  for (const line of stdout.split('\n')) {
    try {
      const o = JSON.parse(line);
      const u = o.usage || o.msg?.usage || o.info?.total_token_usage;
      if (u) usage = u;
      session = o.thread_id || o.session_id || session;
      const err = o.type === 'error' ? o.message : o.error?.message;
      if (err) errors.push(err);
    } catch {}
  }
  if (usage) {
    const input = usage.input_tokens ?? 0, output = usage.output_tokens ?? 0;
    usage = { input, output, cached: usage.cached_input_tokens ?? 0, total: usage.total_tokens ?? input + output };
  }
  return { usage, session, error: errors.at(-1) ?? null };
}

// 從 copilot --output-format json 的 JSONL 取最後的回覆與用量
function copilotResult(stdout) {
  let response = '', usage = null, ok = false, error = null;
  for (const line of stdout.split('\n')) {
    try {
      const o = JSON.parse(line);
      if (o.type === 'assistant.message' && o.data?.content) response = o.data.content;
      else if (o.type === 'result') ok = o.exitCode === 0;
      else if (/error/i.test(o.type || '')) error = o.data?.message || o.message || JSON.stringify(o.data ?? o);
      else if (o.type === 'session.usage_checkpoint') {
        const metrics = Object.values(o.data?.accountingSnapshot?.modelMetrics || {});
        const sum = (k) => metrics.reduce((n, m) => n + (m.usage?.[k] ?? 0), 0);
        const input = sum('inputTokens'), output = sum('outputTokens');
        usage = { input, output, cached: sum('cacheReadTokens'), total: input + output,
          credits: o.data.totalPremiumRequests };
      }
    } catch {}
  }
  return { response, usage, ok, error };
}

// 測試用：DISPATCH_FAKE_QUOTA=flash:60 讓 flash 假裝用量不足，60 秒後重置
function fakeQuota(agentKey) {
  const [agent, secs] = (process.env.DISPATCH_FAKE_QUOTA || '').split(':');
  if (agent !== agentKey) return null;
  const until = Date.now() + Number(secs || 60) * 1000;
  return { ok: false, response: '', usage: null, session: null,
    error: `（模擬）You've hit your usage limit. Try again in ${secs || 60} seconds.`, quota: { until, known: true } };
}

// 執行一次 CLI，回傳 { ok, response, usage, session, error, quota }
async function execAgent(agentKey, prompt, opts, outFile, session) {
  const faked = fakeQuota(agentKey);
  if (faked) return faked;
  const built = buildCommand(agentKey, prompt, opts, outFile, session);
  const command = spawnable(built.cmd, built.args);
  const child = spawn(command.cmd, command.args, {
    cwd: opts.cwd, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, ...(command.shell ? { shell: true } : {}),
  });
  let stdout = '', stderr = '';
  child.stdout.on('data', (d) => (stdout += d));
  child.stderr.on('data', (d) => (stderr += d));
  const code = await new Promise((r) => child.on('close', r));

  let response = '', usage = null, ok = code === 0, error = null, newSession = built.session ?? session ?? null;
  const bin = AGENTS[agentKey].bin;
  if (bin === 'codex') {
    response = fs.existsSync(outFile) ? fs.readFileSync(outFile, 'utf8') : '';
    const r = codexResult(stdout);
    usage = r.usage; newSession = r.session ?? newSession; error = r.error;
  } else if (bin === 'copilot') {
    const r = copilotResult(stdout);
    response = r.response; usage = r.usage; ok = ok && r.ok; error = r.error;
  } else {
    try {
      const j = JSON.parse(stdout.slice(stdout.indexOf('{')));
      response = j.response ?? '';
      newSession = j.conversation_id ?? newSession;
      ok = ok && j.status === 'SUCCESS';
      if (!ok) error = j.error || j.message || j.status;
      if (j.usage) usage = { input: j.usage.input_tokens, output: j.usage.output_tokens,
        cached: j.usage.cache_read_tokens, total: j.usage.total_tokens };
      if (!response.trim()) {
        // agy 中途中斷時仍回報 SUCCESS，只是回覆是空的；這種情況不算完成
        const fb = agyFallback(j.conversation_id);
        ok = false;
        error = fb.error || error;
        response = [fb.error && `錯誤：agy 中途停止（${fb.error.slice(0, 300)}）`,
          fb.text && `以下是它停止前留下的內容：\n\n${fb.text}`].filter(Boolean).join('\n\n')
          || `錯誤：agy 回報成功但回覆是空的（對話 ${j.conversation_id}）`;
      }
    } catch { response = stdout; }
  }
  // 額度用完只看失敗時的錯誤訊息（成功的回覆裡出現 quota 字樣不算）
  const quota = ok ? null : detectQuota([error, stderr.slice(-3000), ok ? '' : response.slice(0, 2000)].filter(Boolean).join('\n'));
  if (!ok && !response) response = error ? '錯誤：' + error : (stderr || stdout).slice(-4000);
  return { ok, response, usage, session: newSession, error, quota };
}

function handoffPrompt(fromAgent, prompt, partial) {
  return [
    `【接手說明】這個任務原本交給 ${LABEL[fromAgent]}，它做到一半時額度用完了。`,
    '它可能已經改過部分檔案：請先檢查目前的檔案狀態與進度，再接續完成，不要從頭重做已經完成的部分。',
    partial?.trim() ? `它中斷前留下的內容：\n${partial.trim().slice(0, 4000)}` : '',
    '---- 原本的任務 ----',
    prompt,
  ].filter(Boolean).join('\n\n');
}

function claudeHandoffMessage(id, fromAgent, prompt, cwd) {
  return [
    `>>> 交給 Claude 接手（任務 ${id}，原本是 ${LABEL[fromAgent]}，其他備援都沒有額度）`,
    `>>> 工作目錄：${cwd}`,
    `>>> 做完後執行：node ${path.join(path.dirname(RUNS), 'dispatch.mjs')} claude end ${id} "結果摘要"`,
    '',
    prompt,
  ].join('\n');
}

// 執行一個任務；用量不足時交給下一棒或排進佇列。回傳結束碼。
async function runTask({ agent, prompt, opts, title, fromId = null, resume = null }) {
  const id = newId();
  const outFile = path.join(RUNS, `${id}.md`);
  const model = opts.model || AGENTS[agent].defaultModel || `${agent} 預設`;
  const start = Date.now();
  emit({ type: 'start', id, agent, model, title, prompt: resume ? `${RESUME_PROMPT}\n\n（接續任務 ${resume.fromId}）\n\n${prompt}` : prompt,
    write: opts.write, cwd: opts.cwd, fromId, resumeOf: resume?.fromId ?? null });

  // 已知還在冷卻中就不浪費一次呼叫
  const cooling = resume ? null : coolingUntil(agent);
  const r = cooling
    ? { ok: false, response: '', usage: null, session: null, error: `額度用完，${fmtTime(cooling)} 重置`, quota: { until: cooling, known: true }, skipped: true }
    // 有舊對話就接續它；沒有（一開始就被擋）就帶著原任務重新開始
    : await execAgent(agent, resume?.session ? RESUME_PROMPT : resume ? `${RESUME_PROMPT}\n\n${prompt}` : prompt, opts, outFile, resume?.session);
  const duration = (Date.now() - start) / 1000;

  if (r.ok) {
    fs.writeFileSync(outFile, r.response);
    emit({ type: 'end', id, agent, status: 'done', duration, usage: r.usage, session: r.session });
    process.stdout.write(r.response.endsWith('\n') ? r.response : r.response + '\n');
    return 0;
  }

  if (!r.quota) {
    fs.writeFileSync(outFile, r.response);
    emit({ type: 'end', id, agent, status: 'failed', duration, usage: r.usage, session: r.session });
    process.stdout.write(r.response + '\n');
    return 1;
  }

  // ---- 用量不足 ----
  if (!r.skipped) setCooling(agent, r.quota.until, r.error);
  const chain = opts.fallback === 'none' ? [] : (opts.fallback ? opts.fallback.split(',') : FALLBACK[agent] ?? ['claude']);
  const next = opts.wait ? null : chain.find((a) => a !== agent && (a === 'claude' || (AGENTS[a] && installed(a) && !coolingUntil(a))));
  const reason = `${r.skipped ? '仍在冷卻中' : '用量不足'}：${(r.error || '').slice(0, 300)}`;

  if (!next) {
    // 等額度重置後，由 server 呼叫 dispatch resume 接續同一個對話
    fs.writeFileSync(outFile, `${reason}\n\n等待 ${LABEL[agent]} 額度在 ${fmtTime(r.quota.until)} 重置後自動接續。\n\n${r.response}`);
    enqueue({ id, agent, until: r.quota.until, session: r.session, prompt, title, opts: { ...opts, rest: [] } });
    emit({ type: 'end', id, agent, status: 'waiting', duration, usage: r.usage, until: r.quota.until, session: r.session });
    console.log(`[用量不足] ${LABEL[agent]} 額度用完，任務 ${id} 已排隊，${fmtTime(r.quota.until)} 重置後自動接續（需要儀表板伺服器在執行）。`);
    return 3;
  }

  fs.writeFileSync(outFile, `${reason}\n\n已交給 ${LABEL[next]} 接手。\n\n${r.response}`);
  const nextTitle = `${title}（接手 ${LABEL[agent]}）`;
  const nextPrompt = handoffPrompt(agent, prompt, r.skipped ? '' : r.response);
  if (next === 'claude') {
    const cid = newId();
    emit({ type: 'end', id, agent, status: 'quota', duration, usage: r.usage, until: r.quota.until, handoffTo: 'claude', nextId: cid });
    emit({ type: 'start', id: cid, agent: 'claude', model: 'Claude（本對話）', title: nextTitle, prompt: nextPrompt, write: opts.write, cwd: opts.cwd, fromId: id });
    console.log(`[用量不足] ${LABEL[agent]} 額度用完（${fmtTime(r.quota.until)} 重置）。`);
    console.log(claudeHandoffMessage(cid, agent, nextPrompt, opts.cwd));
    return 4;
  }
  emit({ type: 'end', id, agent, status: 'quota', duration, usage: r.usage, until: r.quota.until, handoffTo: next });
  console.error(`[用量不足] ${LABEL[agent]} 額度用完（${fmtTime(r.quota.until)} 重置），改交給 ${LABEL[next]} 接手。`);
  // 接手者若也用量不足，繼續往下傳，但不回頭
  const rest = chain.slice(chain.indexOf(next) + 1).join(',') || 'none';
  return runTask({ agent: next, prompt: nextPrompt, opts: { ...opts, model: null, fallback: opts.fallback === 'none' ? 'none' : rest }, title: nextTitle, fromId: id });
}

// ---- 子指令 ----

function claudeCommand(sub, opts) {
  if (sub === 'start') {
    const what = opts.rest.join(' ').trim();
    const id = newId();
    emit({ type: 'start', id, agent: 'claude', model: 'Claude（本對話）', title: opts.title || what.split('\n')[0].slice(0, 60) || 'Claude 的工作',
      prompt: what, write: true, cwd: opts.cwd });
    console.log(id);
    return 0;
  }
  if (sub === 'end') {
    const [id, ...summary] = opts.rest;
    const startEv = fs.readFileSync(LOG, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
      .find((e) => e.type === 'start' && e.id === id);
    if (!startEv) { console.error(`找不到任務 ${id}`); return 2; }
    fs.writeFileSync(path.join(RUNS, `${id}.md`), summary.join(' '));
    emit({ type: 'end', id, agent: 'claude', status: opts.fail ? 'failed' : 'done', duration: (Date.now() - startEv.ts) / 1000, usage: null });
    return 0;
  }
  console.error('用法：dispatch.mjs claude start --title T "要做什麼" ／ dispatch.mjs claude end <id> [--fail] "摘要"');
  return 2;
}

// 檢查哪些 CLI 找得到，給第一次安裝的人看
function doctorCommand() {
  const [major] = process.versions.node.split('.').map(Number);
  console.log(`Node.js ${process.versions.node} ${major >= 18 ? '✓' : '✗（需要 18 以上）'}`);
  const hint = {
    codex: 'Codex CLI：https://github.com/openai/codex（ChatGPT 桌面版也內建；Windows：npm i -g @openai/codex）',
    agy: 'Antigravity CLI（agy）：安裝 Google Antigravity 或 Gemini 桌面版（Windows：使用 Antigravity 安裝程式）',
    copilot: 'GitHub Copilot CLI：https://github.com/github/copilot-cli（Windows：npm i -g @github/copilot 或 winget）',
  };
  for (const bin of ['codex', 'agy', 'copilot']) {
    const p = binPath(bin);
    const agents = Object.entries(AGENTS).filter(([, a]) => a.bin === bin).map(([k]) => k).join(' / ');
    console.log(`${p ? '✓' : '✗'} ${agents.padEnd(22)} ${p ?? `找不到 — ${hint[bin]}`}`);
  }
  console.log('\n找不到的 CLI 不影響其他 agent；接手順序會自動跳過它。路徑不對可以設在 orchestra/config.json 或環境變數 CODEX_BIN / AGY_BIN / COPILOT_BIN。');
  return Object.keys(AGENTS).some(installed) ? 0 : 1;
}

function usageCommand(opts) {
  const report = usageReport(Object.keys(AGENTS));
  if (opts.json) { console.log(JSON.stringify(report, null, 2)); return 0; }
  const k = (n) => n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'k' : String(n);
  console.log('Agent         狀態                         今天 token   7 天 token');
  for (const [agent, r] of Object.entries(report)) {
    if (agent === 'queue') continue;
    const state = r.available ? '可用' : `用量不足，${fmtTime(r.cooling.until)} 重置`;
    console.log(`${LABEL[agent].padEnd(13)} ${state.padEnd(28)} ${k(r.tokensToday).padStart(10)} ${k(r.tokens7d).padStart(12)}`);
  }
  const rl = report.codex.rateLimits;
  if (rl) {
    const w = (x, name) => x ? `${name} 已用 ${x.usedPercent}%（${fmtTime(x.resetsAt)} 重置）` : '';
    console.log(`\nCodex 官方額度（${fmtTime(rl.observedAt)} 的紀錄）：${[w(rl.primary, '5 小時'), w(rl.secondary, '每週')].filter(Boolean).join('；')}`);
  }
  const c = report.copilot.credits;
  console.log(`Copilot 本月經由派工用掉 ${c.usedThisMonth} / ${c.budget} credits（不含你直接在 Copilot 裡用的）`);
  console.log('Gemini / Flash：Antigravity 沒有提供查詢剩餘額度的方式，只能在用完時偵測。');
  if (report.queue.length) {
    console.log('\n等待額度重置的任務：');
    for (const e of report.queue) console.log(`  ${e.id}  ${LABEL[e.agent]}  ${fmtTime(e.until)}  ${e.title}`);
  }
  return 0;
}

// 排程任務用：check 決定這次要不要工作、做哪些專案；begin / end 標記一輪的開始與結果
function autopilotCommand(sub, opts) {
  const s = readAutopilot();
  const on = enabledProjects(s);
  if (sub === 'check') {
    // check <id>：做完一項後確認這個專案是否還開著
    const id = opts.rest[0];
    if (id) {
      const p = on.find((x) => x.id === id);
      if (p && guardPaused(s)) { console.log(`PAUSED：用量守護暫停中，${fmtTime(guardPaused(s))} 恢復`); return 12; }
      console.log(p ? `ENABLED ${id}` : `DISABLED ${id}：這個專案的自動駕駛已關閉`);
      return p ? 0 : 10;
    }
    if (!on.length) { console.log('DISABLED：沒有開啟自動駕駛的專案，這次不工作。'); return 10; }
    const paused = guardPaused(s);
    if (paused) { console.log(`PAUSED：用量守護暫停中（Claude 每週用量達 ${s.guard.weeklyLimit}%），${fmtTime(paused)} 每週額度重置後恢復。`); return 12; }
    if (s.running && Date.now() - s.startedAt < STALE_MS) { console.log(`RUNNING：第 ${s.round} 輪還在進行中，這次不重複啟動。`); return 11; }
    console.log(`ENABLED：${on.length} 個專案輪流做`);
    for (const p of on) console.log(JSON.stringify({ id: p.id, name: p.name, path: p.path, rules: p.rules, publish: p.publish, publishLabel: PUBLISH[p.publish], site: p.site || null }));
    return 0;
  }
  if (sub === 'begin') {
    const round = s.round + 1;
    writeAutopilot({ running: true, startedAt: Date.now(), round });
    emit({ type: 'note', agent: 'claude', text: `🤖 自動駕駛第 ${round} 輪開始（${on.map((p) => p.name).join('、')}）` });
    console.log(round);
    return 0;
  }
  if (sub === 'add') {
    try {
      const p = addProject({ name: opts.title, path: opts.rest[0], publish: opts.publish || 'commit', site: opts.site || '' });
      console.log(`已加入 ${p.name}（${p.id}），預設關閉；規則檔 ${p.rules}`);
      return 0;
    } catch (e) { console.error(e.message); return 2; }
  }
  if (sub === 'remove') { removeProject(opts.rest[0]); console.log(`已移除 ${opts.rest[0]}`); return 0; }
  if (sub === 'guard') {
    // autopilot guard <每週已用%> <每週重置時間 ISO> [5 小時已用%]
    const [weekly, resetsAt, fiveHour] = opts.rest;
    const w = Number(weekly), reset = Date.parse(resetsAt);
    if (!Number.isFinite(w) || isNaN(reset)) { console.error('用法：autopilot guard <每週已用%> <每週重置時間 ISO> [5 小時已用%]'); return 2; }
    const { tripped, state } = reportUsage({ weekly: w, weeklyResetsAt: reset, fiveHour: fiveHour == null ? null : Number(fiveHour) });
    if (tripped) {
      emit({ type: 'note', agent: 'claude', text: `🛡️ 用量守護：Claude 每週用量 ${w}% 已達門檻 ${state.guard.weeklyLimit}%，自動駕駛暫停到 ${fmtTime(state.guard.pausedUntil)}` });
      console.log(`TRIPPED：每週用量 ${w}% ≥ ${state.guard.weeklyLimit}%，暫停到 ${fmtTime(state.guard.pausedUntil)}。立刻收尾。`);
      return 12;
    }
    console.log(`OK：每週用量 ${w}%，門檻 ${state.guard.weeklyLimit}%`);
    return 0;
  }
  if (sub === 'end') {
    const summary = opts.rest.join(' ').trim() || '（沒有摘要）';
    writeAutopilot({ running: false, lastRunAt: Date.now(), lastResult: summary });
    emit({ type: 'note', agent: 'claude', text: `🤖 自動駕駛第 ${s.round} 輪結束：${summary}` });
    return 0;
  }
  if (sub === 'on' || sub === 'off') {
    try { updateProject(opts.rest[0], { enabled: sub === 'on' }); } catch (e) { console.error(e.message); return 2; }
    console.log(`${opts.rest[0]} 的自動駕駛已${sub === 'on' ? '開啟' : '關閉'}`);
    return 0;
  }
  console.log(JSON.stringify(s, null, 2));
  return 0;
}

async function resumeCommand(id) {
  const entry = takeFromQueue(id);
  if (!entry) { console.error(`佇列裡沒有任務 ${id}`); return 2; }
  return runTask({ agent: entry.agent, prompt: entry.prompt, opts: entry.opts, title: `${entry.title}（重置後接續）`,
    resume: { fromId: id, session: entry.session } });
}

async function main() {
  const [cmd, ...argv] = process.argv.slice(2);
  const opts = parseArgs(argv);

  if (cmd === 'note') { emit({ type: 'note', agent: 'claude', text: opts.rest.join(' ') }); return 0; }
  if (cmd === 'claude') return claudeCommand(opts.rest.shift(), opts);
  if (cmd === 'usage') return usageCommand(opts);
  if (cmd === 'resume') return resumeCommand(opts.rest[0]);
  if (cmd === 'autopilot') return autopilotCommand(opts.rest.shift(), opts);
  if (cmd === 'doctor') return doctorCommand();
  if (!AGENTS[cmd]) {
    console.error(`未知的指令：${cmd}。可用：${Object.keys(AGENTS).join(', ')}, note, claude, usage, resume, autopilot, doctor`);
    return 2;
  }
  if (!installed(cmd)) {
    const ok = Object.keys(AGENTS).filter(installed);
    console.error(`找不到 ${LABEL[cmd]} 的 CLI（${AGENTS[cmd].bin}）。執行 doctor 看安裝狀態；目前可用：${ok.join(', ') || '無'}`);
    return 2;
  }

  const prompt = (opts.rest.join(' ') + '\n' + (await readStdin(opts.rest.length > 0))).trim();
  if (!prompt) { console.error('缺少 prompt'); return 2; }
  return runTask({ agent: cmd, prompt, opts, title: opts.title || prompt.split('\n')[0].slice(0, 60) });
}

main().then((code) => process.exit(code ?? 0));
