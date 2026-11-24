#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-orchestra-smoke-'));
const runs = path.join(temp, 'runs');
const node = process.execPath;

function run(args, env = {}) {
  return spawnSync(node, args, {
    cwd: ROOT,
    env: { ...process.env, ORCHESTRA_RUNS_DIR: runs, ...env },
    encoding: 'utf8',
    timeout: 30000,
    windowsHide: true,
  });
}

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

async function waitForServer(child, port, getOutput) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`server exited early: ${getOutput()}`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/`);
      if (response.status === 200) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`server did not start: ${getOutput()}`);
}

try {
  const shimDir = path.join(temp, 'fake');
  const jsPath = path.join(shimDir, 'node_modules', 'fake', 'bin', 'fake.js');
  fs.mkdirSync(path.dirname(jsPath), { recursive: true });
  fs.writeFileSync(jsPath, `
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.writeFileSync(process.env.FAKE_ARGS_FILE, JSON.stringify(args));
const outIndex = args.indexOf('-o');
if (outIndex !== -1) fs.writeFileSync(args[outIndex + 1], 'fake codex response');
console.log(JSON.stringify({ type: 'thread.started', thread_id: 'smoke-test' }));
`);

  let fakeBin;
  if (process.platform === 'win32') {
    fakeBin = path.join(shimDir, 'fake.cmd');
    // npm（cmd-shim）實際產生的格式
    fs.writeFileSync(fakeBin, [
      '@ECHO off', 'GOTO start', ':find_dp0', 'SET dp0=%~dp0', 'EXIT /b', ':start', 'SETLOCAL', 'CALL :find_dp0',
      'IF EXIST "%dp0%\\node.exe" (', '  SET "_prog=%dp0%\\node.exe"', ') ELSE (', '  SET "_prog=node"', '  SET PATHEXT=%PATHEXT:;.JS;=;%', ')',
      'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\fake\\bin\\fake.js" %*', '',
    ].join('\r\n'));
  } else {
    fakeBin = path.join(shimDir, 'fake');
    fs.writeFileSync(fakeBin, `#!/usr/bin/env node\nrequire(${JSON.stringify(jsPath)});\n`);
    fs.chmodSync(fakeBin, 0o755);
  }

  const argsFile = path.join(temp, 'args.json');
  const prompt = 'hello "quoted" prompt';
  const dispatched = run(['orchestra/dispatch.mjs', 'codex', prompt], {
    CODEX_BIN: fakeBin,
    FAKE_ARGS_FILE: argsFile,
  });
  assert.equal(dispatched.status, 0, `dispatch failed:\n${dispatched.stdout}\n${dispatched.stderr}`);
  const received = JSON.parse(fs.readFileSync(argsFile, 'utf8'));
  assert.equal(received.at(-1), prompt, `fake CLI received altered prompt: ${JSON.stringify(received)}`);
  assert.match(dispatched.stdout, /fake codex response/);

  const doctor = run(['orchestra/dispatch.mjs', 'doctor']);
  assert.equal(doctor.error, undefined, `doctor could not start: ${doctor.error?.message}`);
  assert.doesNotMatch(`${doctor.stdout}\n${doctor.stderr}`, /^\s+at .+:\d+:\d+/m, 'doctor printed a stack trace');

  const configDir = path.join(temp, 'claude-config');
  const installed = run(['install.mjs'], { CLAUDE_CONFIG_DIR: configDir });
  assert.equal(installed.status, 0, `installer failed:\n${installed.stdout}\n${installed.stderr}`);
  const skill = fs.readFileSync(path.join(configDir, 'skills', 'team', 'SKILL.md'), 'utf8');
  assert.ok(skill.length > 0, 'installer did not write SKILL.md');
  assert.ok(!skill.includes('{{ORCHESTRA_HOME}}'), 'installer left an unresolved path placeholder');

  const port = await freePort();
  let output = '';
  const server = spawn(node, [path.join(ROOT, 'orchestra', 'server.mjs')], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port), ORCHESTRA_RUNS_DIR: runs },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  server.stdout.setEncoding('utf8').on('data', (text) => { output += text; });
  server.stderr.setEncoding('utf8').on('data', (text) => { output += text; });
  try {
    await waitForServer(server, port, () => output);
    for (const route of ['/', '/autopilot']) {
      const response = await fetch(`http://127.0.0.1:${port}${route}`);
      assert.equal(response.status, 200, `${route} returned ${response.status}`);
    }
  } finally {
    server.kill();
    if (server.exitCode === null) await new Promise((resolve) => server.once('exit', resolve));
  }

  console.log('Smoke test passed: dispatch prompt, doctor, installer, and server routes.');
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
