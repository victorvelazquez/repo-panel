'use strict';
const test = require('node:test');
const { after } = test;
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const net = require('node:net');
const { spawn, spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const SERVER = path.join(ROOT, 'server.js');
const SCRIPTS = path.join(ROOT, 'scripts');
const TRAY = path.join(SCRIPTS, 'tray.ps1');
const INSTALL = path.join(SCRIPTS, 'install-tray.ps1');
const UNINSTALL = path.join(SCRIPTS, 'uninstall-tray.ps1');
const WIN = process.platform === 'win32';
const opts = { skip: WIN ? false : 'the tray scripts are Windows only (PowerShell + System.Windows.Forms)' };
const PS = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass'];

const children = [];
const dirs = [];
after(() => {
  for (const c of children) { try { process.kill(c.pid); } catch { /* already gone */ } }
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true, maxRetries: 5 });
});

function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

function tempConfig(content) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-panel-tray-'));
  dirs.push(dir);
  const file = path.join(dir, 'config.json');
  if (content !== undefined) fs.writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content));
  return file;
}

const health = (port) => new Promise((resolve) => {
  const req = http.get({ host: '127.0.0.1', port, path: '/health', timeout: 1500 }, (res) => {
    let d = ''; res.on('data', (c) => { d += c; }); res.on('end', () => { try { resolve(JSON.parse(d).app === 'repo-panel'); } catch { resolve(false); } });
  });
  req.on('timeout', () => req.destroy());
  req.on('error', () => resolve(false));
});

async function until(fn, ms = 15000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await fn()) return true; await new Promise((r) => setTimeout(r, 150)); }
  return false;
}

async function startPanel(config) {
  const c = spawn(process.execPath, [SERVER], { env: { ...process.env, REPO_PANEL_CONFIG: config }, stdio: 'ignore' });
  children.push(c);
  const port = JSON.parse(fs.readFileSync(config, 'utf8')).port;
  assert.ok(await until(() => health(port)), 'the throwaway panel never answered /health');
  return c;
}

async function startUnrelated(port) {
  const code = `require('http').createServer((q, r) => r.end('{"app":"other"}')).listen(${port}, '127.0.0.1')`;
  const c = spawn(process.execPath, ['-e', code], { stdio: 'ignore' });
  children.push(c);
  assert.ok(await until(() => new Promise((r) => { const s = net.connect(port, '127.0.0.1', () => { s.destroy(); r(true); }); s.on('error', () => r(false)); })));
  return c;
}

// Runs a script in Windows PowerShell 5.1; REPO_PANEL_CONFIG is always set explicitly so the real config.json is never read.
function ps(file, args, env) {
  const r = spawnSync('powershell.exe', [...PS, '-File', file, ...args], { encoding: 'utf8', env: { ...process.env, ...env }, timeout: 60000 });
  return { code: r.status, out: r.stdout.trim(), err: r.stderr.trim() };
}
const jsonLine = (out) => JSON.parse(out.split(/\r?\n/).filter((l) => l.startsWith('{')).pop());
const selfTest = (config, extra = []) => ps(TRAY, ['-SelfTest', '-ConfigPath', config, ...extra], { REPO_PANEL_CONFIG: config });

test('tray -SelfTest: reads the port from the config and sees the healthy throwaway panel and its owner', opts, async () => {
  const port = await freePort();
  const config = tempConfig({ port });
  const panel = await startPanel(config);
  const r = selfTest(config);
  assert.equal(r.code, 0, r.err);
  const j = jsonLine(r.out);
  assert.equal(j.port, port);
  assert.equal(j.healthy, true);
  assert.ok(j.listeners.includes(panel.pid));
  assert.ok(j.ownedListeners.includes(panel.pid));
  assert.deepEqual(j.menu, ['Open panel', 'Restart panel', 'Start panel', 'Quit tray']);
  assert.equal(typeof j.task, 'boolean');
  assert.equal(r.out.split(/\r?\n/).length, 1, 'exactly one line of output');
});

test('tray -SelfTest: an unused port is not healthy and has no listeners', opts, async () => {
  const port = await freePort();
  const r = selfTest(tempConfig({ port }));
  assert.equal(r.code, 0, r.err);
  const j = jsonLine(r.out);
  assert.equal(j.port, port);
  assert.equal(j.healthy, false);
  assert.deepEqual(j.listeners, []);
  assert.deepEqual(j.ownedListeners, []);
});

test('tray -SelfTest: a missing or invalid config falls back to port 4310 without crashing', opts, () => {
  for (const config of [tempConfig(), tempConfig('{ not json'), tempConfig({ port: 'abc' }), tempConfig({ port: 99999 })]) {
    const r = selfTest(config);
    assert.equal(r.code, 0, r.err);
    assert.equal(jsonLine(r.out).port, 4310);
  }
});

test('tray -SelfTest: an unrelated program on the port is listed but never owned', opts, async () => {
  const port = await freePort();
  const other = await startUnrelated(port);
  const r = selfTest(tempConfig({ port }));
  assert.equal(r.code, 0, r.err);
  const j = jsonLine(r.out);
  assert.ok(j.listeners.includes(other.pid));
  assert.deepEqual(j.ownedListeners, []);
  assert.equal(j.healthy, false);
});

test('tray -SelfTestRestart: ends and relaunches only the owned throwaway server', opts, async () => {
  const port = await freePort();
  const config = tempConfig({ port });
  const panel = await startPanel(config);
  const r = selfTest(config, ['-SelfTestRestart']);
  assert.equal(r.code, 0, r.err);
  const j = jsonLine(r.out);
  assert.equal(j.restarted, true);
  assert.equal(j.oldPid, panel.pid);
  assert.notEqual(j.newPid, panel.pid);
  children.push({ pid: j.newPid });
  assert.ok(await health(port), 'the relaunched server answers /health');
  assert.ok(await until(() => { try { process.kill(panel.pid, 0); return false; } catch { return true; } }, 5000), 'the old process is gone');
});

test('tray -SelfTestRestart: never touches an unrelated program on the port', opts, async () => {
  const port = await freePort();
  const other = await startUnrelated(port);
  const r = selfTest(tempConfig({ port }), ['-SelfTestRestart']);
  assert.equal(r.code, 0, r.err);
  assert.equal(jsonLine(r.out).restarted, false);
  process.kill(other.pid, 0); // throws if it was killed
});

test('tray -SelfTestRestart: refuses to run when the config is outside the temp folder', opts, async () => {
  const port = await freePort();
  const tempCfg = tempConfig({ port });
  const panel = await startPanel(tempCfg);
  // The config really is outside the temp folder, but names the same port as the live throwaway server.
  const outside = path.join(ROOT, 'test', 'fixtures', `tray-outside-${process.pid}.json`);
  fs.writeFileSync(outside, JSON.stringify({ port }));
  try {
    const r = ps(TRAY, ['-SelfTestRestart', '-ConfigPath', outside], { REPO_PANEL_CONFIG: outside });
    assert.notEqual(r.code, 0);
    assert.match(r.err, /temp/i);
    assert.equal(r.out, '');
    process.kill(panel.pid, 0); // still alive
    assert.ok(await health(port));
  } finally { fs.rmSync(outside, { force: true }); }
});

test('install-tray.ps1 -DryRun prints the task and action and registers nothing', opts, () => {
  const r = ps(INSTALL, ['-DryRun'], {});
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /repo-panel-tray/);
  assert.match(r.out, /powershell\.exe/);
  assert.match(r.out, /-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File/);
  assert.ok(r.out.includes(TRAY), 'names the full path of tray.ps1');
  assert.match(r.out, /dry run/i);
  const q = spawnSync('powershell.exe', [...PS, '-Command', "@(Get-ScheduledTask -TaskName 'repo-panel-tray' -ErrorAction SilentlyContinue).Count"], { encoding: 'utf8' });
  assert.equal(q.stdout.trim(), '0');
});

test('uninstall-tray.ps1 -DryRun registers or removes nothing', opts, () => {
  const r = ps(UNINSTALL, ['-DryRun'], {});
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /repo-panel-tray/);
  assert.match(r.out, /dry run/i);
});

test('the three tray scripts parse without errors in Windows PowerShell 5.1 and in PowerShell 7', opts, (t) => {
  const shells = ['powershell.exe', 'pwsh'].filter((s) => spawnSync(s, ['-NoProfile', '-Command', '1'], { encoding: 'utf8' }).status === 0);
  assert.ok(shells.includes('powershell.exe'));
  if (!shells.includes('pwsh')) t.diagnostic('pwsh not found: only Windows PowerShell 5.1 was checked');
  for (const shell of shells) {
    for (const file of [TRAY, INSTALL, UNINSTALL]) {
      const cmd = `$e=$null;$t=$null;[void][System.Management.Automation.Language.Parser]::ParseFile('${file.replace(/'/g, "''")}',[ref]$t,[ref]$e);if($e.Count){$e|ForEach-Object{$_.Message};exit 1}`;
      const r = spawnSync(shell, ['-NoProfile', '-Command', cmd], { encoding: 'utf8' });
      assert.equal(r.status, 0, `${shell} ${path.basename(file)}: ${r.stdout}${r.stderr}`);
    }
  }
});
