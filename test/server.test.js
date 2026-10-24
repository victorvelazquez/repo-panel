'use strict';
const test = require('node:test');
const { after } = test;
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const net = require('node:net');
const { spawn, spawnSync, execFileSync } = require('node:child_process');

const vm = require('node:vm');

const SERVER = path.join(__dirname, '..', 'server.js');
const PUBLIC = path.join(__dirname, '..', 'public');
const { API_VERSION } = require('../public/view.js');

function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

// Every config folder is removed when the file's tests finish, so a run leaves nothing in the temp dir.
const configDirs = [];
after(() => {
  for (const d of configDirs) fs.rmSync(d, { recursive: true, force: true, maxRetries: 5 });
});

function configFor(port) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-panel-'));
  configDirs.push(dir);
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
    assert.deepEqual(JSON.parse(res.body), { app: 'repo-panel', api: API_VERSION });
    assert.equal((await get(port, '/api/config')).status, 401);
  } finally { child.kill(); }
});

test('GET /view.js is served and /health reports the api of that same file', async () => {
  const port = await freePort();
  const child = launch(port);
  try {
    const health = JSON.parse((await waitFor(() => get(port, '/health'))).body);
    const res = await get(port, '/view.js');
    assert.equal(res.status, 200);
    const ctx = vm.createContext({});
    vm.runInContext(res.body, ctx);
    assert.equal(health.api, ctx.RepoPanelView.API_VERSION);
    assert.equal(res.body, fs.readFileSync(path.join(PUBLIC, 'view.js'), 'utf8'));
  } finally { child.kill(); }
});

test('the page loads view.js before app.js and has the outdated banner', async () => {
  const port = await freePort();
  const child = launch(port);
  try {
    const html = (await waitFor(() => get(port, '/'))).body;
    assert.ok(html.indexOf('<script src="/view.js">') > -1);
    assert.ok(html.indexOf('/view.js') < html.indexOf('/app.js'));
    assert.match(html, /id="outdated"[^>]*hidden/);
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

// ---------- /api/queue ----------
async function withPanel(config, fn) {
  const port = await freePort();
  const file = configFor(port);
  fs.writeFileSync(file, JSON.stringify({ port, ...config }));
  const child = spawn(process.execPath, [SERVER], { env: { ...process.env, REPO_PANEL_CONFIG: file }, stdio: 'pipe' });
  try {
    const token = /name="?token"? content="([0-9a-f]+)"/.exec((await waitFor(() => get(port, '/'))).body)[1];
    const post = (p, body, raw) => new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, path: p, method: 'POST', headers: { 'x-token': token, 'content-type': 'application/json' } }, (res) => {
        let d = ''; res.on('data', (c) => { d += c; }); res.on('end', () => resolve({ status: res.statusCode, json: JSON.parse(d) }));
      });
      req.on('error', reject);
      req.end(raw === undefined ? JSON.stringify(body) : raw);
    });
    await fn({ post, file, port });
  } finally { child.kill(); }
}

const qitem = (name, extra = {}) => ({ id: name, name, ready: [], stale: false, dirty: false, unpushed: false, hasPrs: false, next: null, ...extra });

test('POST /api/queue needs the token and orders the actions', async () => {
  await withPanel({}, async ({ post, port }) => {
    const bare = await new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, path: '/api/queue', method: 'POST' }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
      req.on('error', reject); req.end('{}');
    });
    assert.equal(bare, 401);
    const r = await post('/api/queue', { items: [qitem('a', { dirty: true }), qitem('b', { ready: [{ number: 3, title: 'T' }], hasPrs: true })] });
    assert.equal(r.status, 200);
    assert.deepEqual(r.json, { queue: [
      { repoId: 'b', name: 'b', kind: 'merge', pr: 3, title: 'T' },
      { repoId: 'a', name: 'a', kind: 'deliver' },
    ] });
  });
});

test('POST /api/queue applies the priority from the config', async () => {
  await withPanel({ priority: ['A'] }, async ({ post }) => {
    const r = await post('/api/queue', { items: [qitem('b', { stale: true }), qitem('a', { dirty: true })] });
    assert.deepEqual(r.json.queue.map((x) => x.name), ['a', 'b']);
  });
});

test('POST /api/queue answers an empty queue for a bad body', async () => {
  await withPanel({}, async ({ post }) => {
    for (const body of [null, [], 'x', {}, { items: 'x' }, { items: {} }]) {
      const r = await post('/api/queue', body);
      assert.equal(r.status, 200);
      assert.deepEqual(r.json, { queue: [] });
    }
  });
});

test('POST /api/queue sanitizes the items', async () => {
  await withPanel({}, async ({ post }) => {
    const many = Array.from({ length: 250 }, (_, i) => qitem(`r${i}`, { dirty: true }));
    assert.equal((await post('/api/queue', { items: many })).json.queue.length, 200);
    const r = await post('/api/queue', { items: [
      qitem('ok', { dirty: 1, ready: [{ number: 5.7, title: 'x'.repeat(500), extra: 1 }, { number: 'a', title: 't' }, { number: 6, title: 7 }] }),
      { id: 'n', name: 42, dirty: true },
      { id: 9, name: 'noid', dirty: true },
      'junk', null,
    ] });
    const [m, ...rest] = r.json.queue;
    assert.deepEqual([m.kind, m.pr, m.title.length], ['merge', 5, 200]);
    assert.deepEqual(rest.map((a) => [a.name, a.kind, a.pr, a.title]), [['ok', 'merge', 6, ''], ['ok', 'deliver', undefined, undefined]]);
    assert.equal(Object.keys(m).sort().join(), 'kind,name,pr,repoId,title');
  });
});

test('POST /api/conformity needs the token and lists the repos that do not conform', async () => {
  await withPanel({}, async ({ post, port }) => {
    const bare = await new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, path: '/api/conformity', method: 'POST' }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
      req.on('error', reject); req.end('{}');
    });
    assert.equal(bare, 401);
    const bad = { available: true, problems: [{ line: 4, severity: 'error', code: 'bad-id', message: 'm' }, { line: 2, severity: 'info', code: 'x', message: 'i' }] };
    const r = await post('/api/conformity', { entries: [
      { id: 'a', name: 'a', roadmap: { available: true, problems: [] } },
      { id: 'b', name: 'b', roadmap: { available: false, reason: 'missing' } },
      { id: 'c', name: 'c', roadmap: bad },
      { id: 'd', name: 'd', roadmap: null },
    ] });
    assert.equal(r.status, 200);
    assert.deepEqual(r.json, { ok: 1, items: [
      { id: 'b', name: 'b', status: 'missing', problems: [] },
      { id: 'c', name: 'c', status: 'problems', problems: [{ line: 4, severity: 'error', code: 'bad-id', message: 'm' }] },
    ] });
  });
});

test('POST /api/conformity answers an empty report for a bad body', async () => {
  await withPanel({}, async ({ post }) => {
    for (const body of [null, [], 'x', {}, { entries: 'x' }, { entries: {} }]) {
      const r = await post('/api/conformity', body);
      assert.equal(r.status, 200);
      assert.deepEqual(r.json, { ok: 0, items: [] });
    }
  });
});

test('a top-level priority survives a config save; without it none is written', async () => {
  const body = { groups: [{ name: 'g', repos: [{ path: '/x/a' }] }] };
  const id = require('../lib.js').repoId('/x/a');
  await withPanel({ ...body, priority: [' b ', 'B', 7, '', 'a'] }, async ({ post, file }) => {
    await post('/api/snooze', { id, number: 3, on: true });
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).priority, ['b', 'a']);
  });
  await withPanel(body, async ({ post, file }) => {
    await post('/api/snooze', { id, number: 3, on: true });
    assert.equal('priority' in JSON.parse(fs.readFileSync(file, 'utf8')), false);
  });
});

// ---------- pi sessions ----------
const { piSend } = require('../server.js');
const IDLE_PI = '▎ ✿ waiting for input\n▎   type, or / for commands\n▎\n';
const piTerm = (o = {}) => ({ handle: 'h1', title: 'π - repo', worktreePath: 'C:/dev/repo', connected: true, writable: true, ...o });

// A fake Orca: `terminals` is what `list` returns, `previews` the successive `show` previews (the last one repeats).
function fakeOrca({ terminals = [piTerm()], previews = [IDLE_PI, IDLE_PI, 'working'] } = {}) {
  const calls = [];
  let n = 0;
  const orca = async (args) => {
    calls.push(args);
    if (args[0] === 'list') return { terminals };
    if (args[0] === 'show') return { terminal: { preview: previews[Math.min(n++, previews.length - 1)] } };
    return { send: { accepted: true } };
  };
  return { orca, calls, sends: () => calls.filter((c) => c[0] === 'send') };
}
const REPO = { path: 'C:\\dev\\repo' };
const noWait = async () => {};
const refuses = (p, status, re) => assert.rejects(p, (e) => e.status === status && re.test(e.message));

test('piSend types the fixed command and Enter into the one idle pi session and confirms it started', async () => {
  const f = fakeOrca();
  assert.deepEqual(await piSend(REPO, 'flow-commit', f.orca, noWait), { sent: true, confirmed: true });
  assert.deepEqual(f.sends(), [['send', '--terminal', 'h1', '--text', '/flow-commit', '--enter']]);
});

test('piSend says not confirmed when the session never leaves the idle prompt', async () => {
  const f = fakeOrca({ previews: [IDLE_PI] });
  assert.deepEqual(await piSend(REPO, 'flow-pr', f.orca, noWait), { sent: true, confirmed: false });
  assert.equal(f.sends().length, 1);
});

test('piSend refuses an unknown command before touching Orca', async () => {
  const f = fakeOrca();
  for (const c of ['rm -rf', '/flow-commit', 'constructor', '__proto__', undefined]) await refuses(piSend(REPO, c, f.orca, noWait), 400, /Unknown command/);
  assert.equal(f.calls.length, 0);
});

test('piSend refuses, and sends nothing, with no session, several sessions, a busy prompt or typed text', async () => {
  const cases = [
    [{ terminals: [] }, /No open pi session/],
    [{ terminals: [piTerm({ worktreePath: 'C:/dev/elsewhere' })] }, /No open pi session/],
    [{ terminals: [piTerm(), piTerm({ handle: 'h2' })] }, /Several pi sessions/],
    [{ previews: ['thinking…'] }, /busy or has text/],
    [{ previews: [IDLE_PI.replace('type, or / for commands', 'half typed')] }, /busy or has text/],
  ];
  for (const [opts, re] of cases) {
    const f = fakeOrca(opts);
    await refuses(piSend(REPO, 'flow-commit', f.orca, noWait), 409, re);
    assert.equal(f.sends().length, 0);
  }
});

test('piSend refuses a second send to the same repo while one is in flight, then frees the repo', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const f = fakeOrca();
  const slow = async (args) => { if (args[0] === 'send') await gate; return f.orca(args); };
  const first = piSend(REPO, 'flow-commit', slow, noWait);
  await new Promise((r) => setImmediate(r));
  await refuses(piSend(REPO, 'flow-commit', f.orca, noWait), 409, /already being sent/);
  release();
  await first;
  assert.equal((await piSend(REPO, 'flow-commit', fakeOrca().orca, noWait)).sent, true);
});

test('piSend frees the repo when Orca fails', async () => {
  const boom = async () => { throw Object.assign(new Error('Orca CLI is unavailable'), { status: 503 }); };
  await refuses(piSend(REPO, 'flow-commit', boom, noWait), 503, /Orca/);
  assert.equal((await piSend(REPO, 'flow-commit', fakeOrca().orca, noWait)).sent, true);
});

test('POST /api/pi needs the token and rejects an unknown command or repo', async () => {
  await withPanel({ groups: [{ name: 'g', repos: [{ path: '/x/a' }] }] }, async ({ post, port }) => {
    const id = require('../lib.js').repoId('/x/a');
    assert.equal((await post('/api/pi', { id, command: 'rm -rf' })).status, 400);
    assert.notEqual((await post('/api/pi', { id: 'nope', command: 'flow-commit' })).status, 200);
    const raw = await new Promise((resolve) => {
      const req = http.request({ host: '127.0.0.1', port, path: '/api/pi', method: 'POST' }, (res) => { res.resume(); resolve(res.statusCode); });
      req.end('{}');
    });
    assert.equal(raw, 401);
  });
});
