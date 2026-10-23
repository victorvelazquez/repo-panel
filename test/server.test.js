'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const net = require('node:net');
const { spawn, spawnSync, execFileSync } = require('node:child_process');

const SERVER = path.join(__dirname, '..', 'server.js');

function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

function configFor(port) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-panel-'));
  const file = path.join(dir, 'config.json');
  fs.writeFileSync(file, JSON.stringify({ port }));
  return file;
}

function launch(port) {
  return spawn(process.execPath, [SERVER], { env: { ...process.env, REPO_PANEL_CONFIG: configFor(port) }, stdio: 'pipe' });
}

const get = (port, p) => new Promise((resolve, reject) => {
  http.get({ host: '127.0.0.1', port, path: p }, (res) => {
    let d = ''; res.on('data', (c) => { d += c; }); res.on('end', () => resolve({ status: res.statusCode, body: d }));
  }).on('error', reject);
});

const waitFor = async (fn) => {
  for (let i = 0; i < 50; i++) { try { return await fn(); } catch { await new Promise((r) => setTimeout(r, 100)); } }
  throw new Error('timeout');
};

test('GET /health identifies the panel without a token', async () => {
  const port = await freePort();
  const child = launch(port);
  try {
    const res = await waitFor(() => get(port, '/health'));
    assert.equal(res.status, 200);
    assert.deepEqual(JSON.parse(res.body), { app: 'repo-panel' });
    assert.equal((await get(port, '/api/config')).status, 401);
  } finally { child.kill(); }
});

test('a second launch exits 0 when the panel already owns the port', async () => {
  const port = await freePort();
  const first = launch(port);
  try {
    await waitFor(() => get(port, '/health'));
    const second = spawnSync(process.execPath, [SERVER], { env: { ...process.env, REPO_PANEL_CONFIG: configFor(port) }, encoding: 'utf8' });
    assert.equal(second.status, 0);
    assert.match(second.stdout, /already running at http:\/\/127\.0\.0\.1:\d+\//);
  } finally { first.kill(); }
});

test('a launch exits 1 and keeps the same port when another program owns it', async () => {
  const port = await freePort();
  const blocker = http.createServer((req, res) => res.end('other app')).listen(port, '127.0.0.1');
  await new Promise((r) => blocker.once('listening', r));
  try {
    const run = spawnSync(process.execPath, [SERVER], { env: { ...process.env, REPO_PANEL_CONFIG: configFor(port) }, encoding: 'utf8' });
    assert.equal(run.status, 1);
    assert.match(run.stderr, new RegExp(`Port ${port} is used by another program`));
  } finally { blocker.close(); }
});

test('per-repo settings survive a config save; plain repos stay plain', async () => {
  const [A, B] = ['/x/a', '/x/b'];
  const port = await freePort();
  const file = configFor(port);
  fs.writeFileSync(file, JSON.stringify({
    port, groups: [{ name: 'g', repos: [{ path: A, base: 'develop', roadmap: 'docs\\PLAN.md' }, { path: B }] }],
  }));
  const child = spawn(process.execPath, [SERVER], { env: { ...process.env, REPO_PANEL_CONFIG: file }, stdio: 'pipe' });
  try {
    const html = (await waitFor(() => get(port, '/'))).body;
    const token = /name="?token"? content="([0-9a-f]+)"/.exec(html)[1];
    const id = require('../lib.js').repoId(A);
    await new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, path: '/api/snooze', method: 'POST', headers: { 'x-token': token, 'content-type': 'application/json' } }, (res) => { res.resume(); res.on('end', resolve); });
      req.on('error', reject);
      req.end(JSON.stringify({ id, number: 3, on: true }));
    });
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.deepEqual(saved.groups[0].repos, [{ path: A, base: 'develop', roadmap: 'docs/PLAN.md' }, { path: B }]);
    assert.equal(saved.snoozed.length, 1);
  } finally { child.kill(); }
});

// ---------- /api/roadmap, against a real origin + clone ----------
const sh = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8', stdio: 'pipe' }).trim();
const rows = (...ids) => `# Plan\n\n| ID | Entrega | Resultado visible | Depende de | Estado | Notas | Ficha |\n| --- | --- | --- | --- | --- | --- | --- |\n${ids.map(([id, st]) => `| ${id} | e | r | — | ${st} | | — |`).join('\n')}\n`;

// Returns { tmp, work, push(file, text) }: a bare origin and a clone whose main already has `files`.
function originAndClone(files) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-panel-git-'));
  const origin = path.join(tmp, 'origin.git');
  const work = path.join(tmp, 'work');
  sh(tmp, 'init', '--bare', '-b', 'main', origin);
  sh(tmp, 'clone', '-q', origin, work);
  sh(work, 'checkout', '-q', '-B', 'main');
  const push = (name, text, msg = 'c') => {
    fs.mkdirSync(path.dirname(path.join(work, name)), { recursive: true });
    fs.writeFileSync(path.join(work, name), text);
    sh(work, 'add', '-A'); sh(work, 'commit', '-q', '-m', msg); sh(work, 'push', '-q', 'origin', 'main');
  };
  for (const [name, text] of Object.entries(files)) push(name, text);
  if (!Object.keys(files).length) push('README.md', 'x\n');
  return { tmp, work, push };
}

async function withRoadmap(repo, fn) {
  const port = await freePort();
  const file = configFor(port);
  fs.writeFileSync(file, JSON.stringify({ port, groups: [{ name: 'g', repos: [{ path: repo.work, base: 'main', ...repo.extra }] }] }));
  const child = spawn(process.execPath, [SERVER], { env: { ...process.env, REPO_PANEL_CONFIG: file }, stdio: 'pipe' });
  try {
    const token = /name="?token"? content="([0-9a-f]+)"/.exec((await waitFor(() => get(port, '/'))).body)[1];
    const id = require('../lib.js').repoId(repo.work);
    const call = (query = `id=${id}`) => new Promise((resolve, reject) => {
      http.get({ host: '127.0.0.1', port, path: `/api/roadmap?${query}`, headers: { 'x-token': token } }, (res) => {
        let d = ''; res.on('data', (c) => { d += c; }); res.on('end', () => resolve({ status: res.statusCode, json: JSON.parse(d) }));
      }).on('error', reject);
    });
    await fn(call);
  } finally { child.kill(); fs.rmSync(repo.tmp, { recursive: true, force: true }); }
}

test('roadmap: the remote base branch wins over a dirty working tree', async () => {
  const repo = originAndClone({ 'docs/ROADMAP.md': rows(['A1', 'Completada'], ['A2', 'Pendiente']) });
  fs.writeFileSync(path.join(repo.work, 'docs', 'ROADMAP.md'), rows(['Z1', 'Completada'], ['Z2', 'Completada']));
  await withRoadmap(repo, async (call) => {
    const r = await call();
    assert.equal(r.status, 200);
    assert.equal(r.json.available, true);
    assert.equal(r.json.base, 'main');
    assert.equal(r.json.path, 'docs/ROADMAP.md');
    assert.equal(r.json.sha, sh(repo.work, 'rev-parse', 'origin/main'));
    assert.deepEqual(r.json.rows.map((x) => x.id), ['A1', 'A2']);
    assert.equal(r.json.next.id, 'A2');
    assert.deepEqual(Object.keys(r.json), ['available', 'base', 'sha', 'path', 'header', 'rows', 'problems', 'current', 'next', 'progress', 'summary', 'derived']);
    assert.deepEqual(r.json.derived, {});
    const s = r.json.summary;
    assert.deepEqual([s.kind, s.id, s.done, s.total, s.pct], ['next', 'A2', 1, 2, 50]);
  });
});

test('roadmap: a new base commit is picked up after fetch', async () => {
  const repo = originAndClone({ 'docs/ROADMAP.md': rows(['A1', 'Pendiente']) });
  await withRoadmap(repo, async (call) => {
    const first = (await call()).json;
    assert.equal(first.next.id, 'A1');
    repo.push('docs/ROADMAP.md', rows(['A1', 'Completada'], ['A2', 'Pendiente']), 'next');
    sh(repo.work, 'fetch', '-q');
    const second = (await call()).json;
    assert.notEqual(second.sha, first.sha);
    assert.equal(second.sha, sh(repo.work, 'rev-parse', 'origin/main'));
    assert.deepEqual(second.rows.map((x) => x.id), ['A1', 'A2']);
    assert.equal(second.next.id, 'A2');
  });
});

test('roadmap: a repo without the file is not an error', async () => {
  const repo = originAndClone({});
  await withRoadmap(repo, async (call) => {
    const r = await call();
    assert.equal(r.status, 200);
    assert.deepEqual(r.json, { available: false, reason: 'missing', base: 'main', path: 'docs/ROADMAP.md' });
    assert.equal((await call('id=nope')).status, 404);
  });
});

test('roadmap: a missing base branch is reported as no-base', async () => {
  const repo = originAndClone({ 'docs/ROADMAP.md': rows(['A1', 'Pendiente']) });
  repo.extra = { base: 'nope' };
  await withRoadmap(repo, async (call) => {
    assert.deepEqual((await call()).json, { available: false, reason: 'no-base', base: 'nope', path: 'docs/ROADMAP.md' });
  });
});

test('roadmap: custom path through config; unsafe paths fall back to the default', async () => {
  const files = { 'docs/PLAN.md': rows(['P1', 'Pendiente']), 'docs/ROADMAP.md': rows(['R1', 'Pendiente']) };
  const custom = originAndClone(files);
  custom.extra = { roadmap: 'docs\\PLAN.md' };
  await withRoadmap(custom, async (call) => {
    const r = (await call()).json;
    assert.equal(r.path, 'docs/PLAN.md');
    assert.deepEqual(r.rows.map((x) => x.id), ['P1']);
  });
  const unsafe = originAndClone(files);
  unsafe.extra = { roadmap: '../x.md' };
  await withRoadmap(unsafe, async (call) => {
    const r = (await call()).json;
    assert.equal(r.path, 'docs/ROADMAP.md');
    assert.deepEqual(r.rows.map((x) => x.id), ['R1']);
  });
});

// ---- derived states: Lista / En curso from Git, gh failures are silent ----
const planP2 = () => rows(['P1', 'Completada'], ['P2', 'Pendiente'], ['P3', 'Pendiente']);
const branchWithCommit = (repo, name) => {
  sh(repo.work, 'checkout', '-q', '-b', name);
  fs.writeFileSync(path.join(repo.work, `${name.replace(/\W/g, '_')}.txt`), 'x\n');
  sh(repo.work, 'add', '-A'); sh(repo.work, 'commit', '-q', '-m', 'work');
};

test('roadmap derived: a local branch with commits over main makes the unit Lista and next skips it', async () => {
  const repo = originAndClone({ 'docs/ROADMAP.md': planP2() });
  branchWithCommit(repo, 'feat/p2-x');
  sh(repo.work, 'checkout', '-q', 'main');
  await withRoadmap(repo, async (call) => {
    const r = await call();
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.derived, { P2: { state: 'Lista', via: 'branch', branch: 'feat/p2-x' } });
    assert.equal(r.json.next.id, 'P3');
    assert.deepEqual([r.json.summary.kind, r.json.summary.id, r.json.summary.extra], ['ready', 'P2', 0]);
  });
});

test('roadmap derived: the current branch with an uncommitted file is Lista; a clean branch-only is En curso', async () => {
  const repo = originAndClone({ 'docs/ROADMAP.md': planP2() });
  sh(repo.work, 'checkout', '-q', '-b', 'feat/p2-x');
  await withRoadmap(repo, async (call) => {
    assert.deepEqual((await call()).json.derived, { P2: { state: 'En curso', via: 'branch', branch: 'feat/p2-x' } });
    fs.writeFileSync(path.join(repo.work, 'new.txt'), 'x\n');
    const dirty = (await call()).json;
    assert.deepEqual(dirty.derived, { P2: { state: 'Lista', via: 'branch', branch: 'feat/p2-x' } });
    assert.equal(dirty.next.id, 'P3');
    fs.rmSync(path.join(repo.work, 'new.txt'));
    const clean = (await call()).json;
    assert.equal(clean.derived.P2.state, 'En curso');
    assert.equal(clean.next.id, 'P3');
    assert.deepEqual(clean.rows.map((x) => x.estado), ['Completada', 'Pendiente', 'Pendiente']);
  });
});

test('roadmap derived: a branch whose remote is gone is ignored', async () => {
  const repo = originAndClone({ 'docs/ROADMAP.md': planP2() });
  branchWithCommit(repo, 'feat/p2-x');
  sh(repo.work, 'push', '-q', '-u', 'origin', 'feat/p2-x');
  sh(repo.work, 'checkout', '-q', 'main');
  sh(repo.work, 'push', '-q', 'origin', '--delete', 'feat/p2-x');
  sh(repo.work, 'fetch', '-q', '--prune');
  await withRoadmap(repo, async (call) => {
    const r = (await call()).json;
    assert.deepEqual(r.derived, {});
    assert.equal(r.next.id, 'P2');
  });
});

test('roadmap derived: a repo without a GitHub remote answers 200 with Git-only states', async () => {
  const repo = originAndClone({ 'docs/ROADMAP.md': planP2() });
  branchWithCommit(repo, 'feat/p3-y');
  await withRoadmap(repo, async (call) => {
    const r = await call();
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.derived, { P3: { state: 'Lista', via: 'branch', branch: 'feat/p3-y' } });
    assert.equal(r.json.next.id, 'P2');
  });
});
