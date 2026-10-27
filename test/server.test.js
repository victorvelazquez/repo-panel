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
const { sh, runGit } = require('./git-helper');

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
    const getApi = (p, withToken = true) => new Promise((resolve, reject) => {
      http.get({ host: '127.0.0.1', port, path: p, headers: withToken ? { 'x-token': token } : {} }, (res) => {
        let d = ''; res.on('data', (c) => { d += c; }); res.on('end', () => resolve({ status: res.statusCode, json: JSON.parse(d) }));
      }).on('error', reject);
    });
    await fn({ post, getApi, file, port });
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
const { piSessions } = require('../server/pi.js');
const IDLE_PI = '▎ ✿ waiting for input\n▎   type, or / for commands\n▎\n';
const BUSY_PI = '$ sleep 20 (timeout 30s)\nElapsed 7.2s\n▎ ❁ working…\n▎   type, or / for commands\n▎\n';
const PLAIN_PS = 'PS C:\\dev\\repo> git status\nnothing to commit, working tree clean\nPS C:\\dev\\repo> ';
// The title of the same live session changes (`pi`, `Terminal 1`, `π - x`...): the panel must not care.
const piTerm = (o = {}) => ({ handle: 'h1', title: 'Terminal 1', worktreePath: 'C:/dev/repo', connected: true, writable: true, ...o });

// A fake Orca: `terminals` is what `list` returns, `previews` the successive `show` previews (the last one repeats).
// `screens` answers a `show` by handle instead (a string, or a list whose last entry repeats); a handle in
// `failShow` makes its `show` throw.
function fakeOrca({ terminals = [piTerm()], previews = [IDLE_PI, IDLE_PI, 'working'], screens = null, failShow = [] } = {}) {
  const calls = [];
  let n = 0;
  const seen = {};
  const orca = async (args) => {
    calls.push(args);
    if (args[0] === 'list') return { terminals };
    if (args[0] === 'show' && failShow.includes(args[2])) throw new Error('Orca could not show that terminal');
    if (args[0] === 'show' && screens) {
      const s = [].concat(screens[args[2]] ?? '');
      return { terminal: { preview: s[Math.min(seen[args[2]] = (seen[args[2]] ?? -1) + 1, s.length - 1)] } };
    }
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

test('piSend finds the session by its screen: a title of Terminal 1 works, a π title over a plain PowerShell does not', async () => {
  for (const title of ['Terminal 1', 'pi', 'Windows PowerShell', 'π - panel-e2e', undefined]) {
    const f = fakeOrca({ terminals: [piTerm({ title })] });
    assert.deepEqual(await piSend(REPO, 'flow-commit', f.orca, noWait), { sent: true, confirmed: true });
    assert.equal(f.sends().length, 1);
  }
  const f = fakeOrca({ terminals: [piTerm({ title: 'π - x' })], screens: { h1: PLAIN_PS } });
  await refuses(piSend(REPO, 'flow-commit', f.orca, noWait), 409, /No open pi session found for this repo in Orca/);
  assert.equal(f.sends().length, 0);
});

test('piSend uses the one pi screen among several terminals and ignores a terminal whose show fails', async () => {
  const terminals = [piTerm({ handle: 'ps' }), piTerm({ handle: 'broken' }), piTerm({ handle: 'pi' })];
  const f = fakeOrca({ terminals, screens: { ps: PLAIN_PS, pi: [IDLE_PI, 'working'] }, failShow: ['broken'] });
  assert.deepEqual(await piSend(REPO, 'flow-commit', f.orca, noWait), { sent: true, confirmed: true });
  assert.deepEqual(f.sends(), [['send', '--terminal', 'pi', '--text', '/flow-commit', '--enter']]);
  const none = fakeOrca({ terminals: [piTerm({ handle: 'broken' })], failShow: ['broken'] });
  await refuses(piSend(REPO, 'flow-commit', none.orca, noWait), 409, /No open pi session/);
  assert.equal(none.sends().length, 0);
});

test('piSessions lists only the terminals of the worktree whose screen is a pi screen, with their state', async () => {
  const terminals = [piTerm({ handle: 'a' }), piTerm({ handle: 'b' }), piTerm({ handle: 'c' }), piTerm({ handle: 'd' }), piTerm({ handle: 'e', worktreePath: 'C:/dev/else' })];
  const f = fakeOrca({ terminals, screens: { a: IDLE_PI, b: BUSY_PI, c: PLAIN_PS, d: IDLE_PI.replace('type, or / for commands', 'half typed'), e: IDLE_PI } });
  assert.deepEqual(await piSessions(REPO, f.orca), [{ handle: 'a', state: 'idle' }, { handle: 'b', state: 'busy' }, { handle: 'd', state: 'typed' }]);
  assert.deepEqual(f.calls.map((c) => c.join(' ')).sort(), ['list', 'show --terminal a', 'show --terminal b', 'show --terminal c', 'show --terminal d']);
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
    [{ terminals: [piTerm(), piTerm({ handle: 'h2' })], screens: { h1: BUSY_PI, h2: IDLE_PI } }, /Several pi sessions/],
    [{ previews: [BUSY_PI] }, /busy or has text/],
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

// ---------- RP12b: GET /api/pi-status ----------
const { piStatus } = require('../server/pi.js');

test('piStatus: closed with no pi terminal in the repo folder, from a list only', async () => {
  for (const terminals of [[], [piTerm({ worktreePath: 'C:/dev/elsewhere' })]]) {
    const f = fakeOrca({ terminals });
    assert.deepEqual(await piStatus(REPO, f.orca), { state: 'closed' });
    assert.deepEqual(f.calls, [['list']]);
  }
});

test('piStatus: idle, busy (a fresh show of the one session) and ambiguous with several sessions', async () => {
  const idle = fakeOrca({ previews: [IDLE_PI] });
  assert.deepEqual(await piStatus(REPO, idle.orca), { state: 'idle' });
  assert.deepEqual(idle.calls, [['list'], ['show', '--terminal', 'h1']]);
  assert.deepEqual(await piStatus(REPO, fakeOrca({ previews: [BUSY_PI] }).orca), { state: 'busy' });
  assert.deepEqual(await piStatus(REPO, fakeOrca({ previews: [IDLE_PI.replace('type, or / for commands', 'half typed')] }).orca), { state: 'idle' });
  const two = fakeOrca({ terminals: [piTerm(), piTerm({ handle: 'h2' })] });
  assert.deepEqual(await piStatus(REPO, two.orca), { state: 'ambiguous' });
  assert.deepEqual(two.calls.map((c) => c.join(' ')).sort(), ['list', 'show --terminal h1', 'show --terminal h2']);
});

test('piStatus reads the screen, not the title: Terminal 1 is a session, a π title over PowerShell is closed', async () => {
  assert.deepEqual(await piStatus(REPO, fakeOrca({ terminals: [piTerm({ title: 'Terminal 1' })], previews: [IDLE_PI] }).orca), { state: 'idle' });
  assert.deepEqual(await piStatus(REPO, fakeOrca({ terminals: [piTerm({ title: 'π - x' })], previews: [PLAIN_PS] }).orca), { state: 'closed' });
  const mixed = fakeOrca({ terminals: [piTerm({ handle: 'ps' }), piTerm({ handle: 'pi' })], screens: { ps: PLAIN_PS, pi: BUSY_PI } });
  assert.deepEqual(await piStatus(REPO, mixed.orca), { state: 'busy' });
  const partial = fakeOrca({ terminals: [piTerm({ handle: 'bad' }), piTerm({ handle: 'pi' })], screens: { pi: IDLE_PI }, failShow: ['bad'] });
  assert.deepEqual(await piStatus(REPO, partial.orca), { state: 'idle' });
  const twoPi = fakeOrca({ terminals: [piTerm({ handle: 'a' }), piTerm({ handle: 'b' })], screens: { a: IDLE_PI, b: BUSY_PI } });
  assert.deepEqual(await piStatus(REPO, twoPi.orca), { state: 'ambiguous' });
});

test('piStatus: an Orca failure is unknown, never closed, and nothing is ever sent', async () => {
  const boom = async () => { throw new Error('Orca CLI is unavailable'); };
  assert.deepEqual(await piStatus(REPO, boom), { state: 'unknown' });
  const oneFailsNoPi = fakeOrca({ terminals: [piTerm({ handle: 'bad' }), piTerm({ handle: 'ps' })], screens: { ps: PLAIN_PS }, failShow: ['bad'] });
  assert.deepEqual(await piStatus(REPO, oneFailsNoPi.orca), { state: 'unknown' }); // a failed show could hide the session
  const showFails = async (args) => { if (args[0] === 'show') throw new Error('nope'); return { terminals: [piTerm()] }; };
  assert.deepEqual(await piStatus(REPO, showFails), { state: 'unknown' });
  assert.deepEqual(await piStatus(REPO, async () => ({})), { state: 'unknown' });
  const f = fakeOrca();
  await piStatus(REPO, f.orca);
  assert.equal(f.sends().length, 0);
});

test('GET /api/pi-status needs the token, answers 404 for an unknown repo and one of the known states otherwise', async () => {
  const repo = originAndClone({});
  await withRepoPanel(repo, async ({ getApi, id }) => {
    assert.equal((await getApi(`/api/pi-status?id=${id}`, false)).status, 401);
    assert.equal((await getApi('/api/pi-status?id=nope')).status, 404);
    assert.equal((await getApi('/api/pi-status')).status, 404);
    const ok = await getApi(`/api/pi-status?id=${id}`);
    assert.equal(ok.status, 200);
    assert.deepEqual(Object.keys(ok.json), ['state']);
    assert.ok(['closed', 'idle', 'busy', 'ambiguous', 'unknown'].includes(ok.json.state), ok.json.state);
  });
});

test('GET /api/local carries head, inProgress and base next to the unchanged fields', async () => {
  const repo = originAndClone({});
  await withRepoPanel(repo, async ({ getApi, id }) => {
    const l = (await getApi(`/api/local?id=${id}`)).json;
    assert.equal(l.head, execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo.work, encoding: 'utf8' }).trim());
    assert.equal(l.inProgress, null);
    assert.equal(l.base, 'main');
    assert.equal(l.branch, 'main');
    assert.equal(l.ahead, 0);
    assert.deepEqual(l.files, []);
  });
});

test('GET /api/local reports the staged files next to the unchanged fields, and nothing else moves', async () => {
  const repo = originAndClone({ 'a.txt': 'a\n' });
  await withRepoPanel(repo, async ({ getApi, id }) => {
    const clean = (await getApi(`/api/local?id=${id}`)).json;
    assert.deepEqual([clean.stagedCount, clean.stagedPaths], [0, []]);
    execFileSync('git', ['mv', 'a.txt', 'b.txt'], { cwd: repo.work });
    fs.writeFileSync(path.join(repo.work, 'untracked.txt'), 'u\n');
    const l = (await getApi(`/api/local?id=${id}`)).json;
    assert.deepEqual([l.stagedCount, l.stagedPaths], [1, ['b.txt']]);
    const { stagedCount, stagedPaths, files, added, deleted, lastChangeMs, ...rest } = l;
    const { stagedCount: c2, stagedPaths: p2, files: f2, added: a2, deleted: d2, lastChangeMs: m2, ...cleanRest } = clean;
    assert.ok(Number.isFinite(lastChangeMs) && m2 === null);
    assert.deepEqual(rest, cleanRest);
    assert.equal(files.length, 2);
  });
});

// ---------- /api/requirements and /api/prerequisites ----------
const CURRENT_RULES = require('../requirements.json'); // the versions come from the registry, never written by hand
const REG_BLOCK = `# Rules\n<!-- orquestacion:registro v${CURRENT_RULES.blocks.registro} -->\nrules\n<!-- /orquestacion:registro -->\n<!-- panel:tareas v${CURRENT_RULES.blocks.tareas} -->\nrules\n<!-- /panel:tareas -->\n<!-- panel:entrega v${CURRENT_RULES.blocks.entrega} -->\nrules\n<!-- /panel:entrega -->\n`;
// RP41: the adoption record of a repo that meets everything names the padrón of the panel.
const ORQ = `# Adopción\n\n- **Padrón del panel:** ${CURRENT_RULES.padron}\n`;
const HEADER = '**Dónde está:** a\n**Qué sigue:** b\n**Qué lo bloquea:** c\n\n';
const statuses = (json) => Object.fromEntries(json.results.map((r) => [r.id, r.status]));

async function withRepoPanel(repo, fn) {
  const repoId = require('../lib.js').repoId(repo.work);
  await withPanel({ groups: [{ name: 'g', repos: [{ path: repo.work, base: 'main', ...repo.extra }] }] }, async (ctx) => {
    try { await fn({ ...ctx, id: repoId }); } finally { fs.rmSync(repo.tmp, { recursive: true, force: true }); }
  });
}

test('GET /api/requirements needs the token and answers 404 for an unknown repo', async () => {
  const repo = originAndClone({});
  await withRepoPanel(repo, async ({ getApi, id }) => {
    assert.equal((await getApi(`/api/requirements?id=${id}`, false)).status, 401);
    assert.equal((await getApi('/api/requirements?id=nope')).status, 404);
  });
});

test('GET /api/requirements: a conforming base branch passes the required ones; recommended gaps do not block', async () => {
  const repo = originAndClone({ 'AGENTS.md': REG_BLOCK, 'docs/ROADMAP.md': HEADER + rows(['A1', 'Pendiente']), 'docs/ORQUESTACION.md': ORQ });
  await withRepoPanel(repo, async ({ getApi, id }) => {
    const r = await getApi(`/api/requirements?id=${id}`);
    assert.equal(r.status, 200);
    assert.equal(r.json.available, true);
    assert.equal(r.json.base, 'main');
    assert.deepEqual(statuses(r.json), {
      'base-branch': 'pass', 'agents-file': 'pass', 'registro-block': 'pass', 'tareas-block': 'pass', 'entrega-block': 'pass', 'roadmap-file': 'pass',
      'roadmap-header': 'pass', 'roadmap-table': 'pass', 'ciclo-block': 'fail', 'adoption-record': 'pass', 'padron-record': 'pass',
      'estado-block': 'fail', 'panel-ignored': 'fail',
    });
    assert.deepEqual(r.json.summary, { required: { pass: 9, total: 10 }, recommended: { pass: 1, total: 3 }, ready: false });
    assert.ok(r.json.results.every((x) => typeof x.remedy === 'string' && x.remedy));
  });
});

test('GET /api/state needs the token and answers 404 for an unknown repo', async () => {
  const repo = originAndClone({});
  await withRepoPanel(repo, async ({ getApi, id }) => {
    assert.equal((await getApi(`/api/state?id=${id}`, false)).status, 401);
    assert.equal((await getApi('/api/state?id=nope')).status, 404);
    assert.equal((await getApi('/api/state')).status, 404);
  });
});

test('GET /api/state: missing, then a valid file, then an invalid one; /api/local does not change', async () => {
  const repo = originAndClone({});
  await withRepoPanel(repo, async ({ getApi, id }) => {
    const none = await getApi(`/api/state?id=${id}`);
    assert.equal(none.status, 200);
    assert.deepEqual(none.json, { available: false, state: null, next: null, detail: null, at: null, stale: false, reason: 'missing' });
    const local = (await getApi(`/api/local?id=${id}`)).json;
    fs.mkdirSync(path.join(repo.work, '.panel'));
    fs.appendFileSync(path.join(repo.work, '.git', 'info', 'exclude'), '\n.panel/\n');
    const at = new Date(Date.now() + 60 * 1000).toISOString();
    fs.writeFileSync(path.join(repo.work, '.panel', 'state.json'), JSON.stringify({ state: 'ready-to-commit', next: 'Run /flow-commit.', at }));
    const ok = (await getApi(`/api/state?id=${id}`)).json;
    assert.deepEqual(ok, { available: true, state: 'ready-to-commit', next: 'Run /flow-commit.', detail: null, at, stale: false, reason: null });
    fs.writeFileSync(path.join(repo.work, '.panel', 'state.json'), '{nope');
    assert.equal((await getApi(`/api/state?id=${id}`)).json.reason, 'invalid');
    assert.deepEqual((await getApi(`/api/local?id=${id}`)).json, local);
  });
});

test('GET /api/requirements: estado-block reads the panel block from the base branch, panel-ignored asks the local Git', async () => {
  const PANEL = '# Rules\n<!-- panel:estado v1.0 -->\nrules\n<!-- /panel:estado -->\n<!-- orquestacion:ciclo v1.0 -->\nrules\n<!-- /orquestacion:ciclo -->\n';
  const repo = originAndClone({ 'AGENTS.md': REG_BLOCK + PANEL, 'docs/ROADMAP.md': HEADER + rows(['A1', 'Pendiente']), 'docs/ORQUESTACION.md': ORQ });
  await withRepoPanel(repo, async ({ getApi, id }) => {
    const before = statuses((await getApi(`/api/requirements?id=${id}`)).json);
    assert.equal(before['estado-block'], 'pass');
    assert.equal(before['panel-ignored'], 'fail');
    fs.appendFileSync(path.join(repo.work, '.git', 'info', 'exclude'), '\n.panel/\n');
    const after = (await getApi(`/api/requirements?id=${id}`)).json;
    assert.equal(statuses(after)['panel-ignored'], 'pass');
    assert.equal(after.summary.ready, true);
    assert.equal(sh(repo.work, 'status', '--porcelain'), '');
  });
});

test('GET /api/requirements: a repo folder that vanished leaves panel-ignored unavailable, never failed', async () => {
  const repo = originAndClone({ 'AGENTS.md': REG_BLOCK });
  await withRepoPanel(repo, async ({ getApi, id }) => {
    const hidden = repo.work + '-gone';
    fs.renameSync(repo.work, hidden);
    try {
      const r = (await getApi(`/api/requirements?id=${id}`)).json;
      assert.equal(statuses(r)['panel-ignored'], 'unavailable');
    } finally { fs.renameSync(hidden, repo.work); }
  });
});

test('GET /api/requirements: reads the remote base branch, flags legacy and a roadmap without header', async () => {
  const repo = originAndClone({ 'AGENTS.md': '# A\n\n## Orquestación\nold\n', 'docs/ROADMAP.md': rows(['A1', 'Pendiente']) });
  fs.writeFileSync(path.join(repo.work, 'AGENTS.md'), REG_BLOCK); // a dirty working tree must not count
  await withRepoPanel(repo, async ({ getApi, id }) => {
    const r = await getApi(`/api/requirements?id=${id}`);
    assert.equal(statuses(r.json)['registro-block'], 'outdated');
    assert.equal(statuses(r.json)['roadmap-header'], 'fail');
    assert.equal(statuses(r.json)['roadmap-table'], 'pass');
    assert.equal(r.json.summary.ready, false);
  });
});

test('GET /api/requirements: files missing on the base branch fail or leave content checks unavailable', async () => {
  const repo = originAndClone({});
  await withRepoPanel(repo, async ({ getApi, id }) => {
    const s = statuses((await getApi(`/api/requirements?id=${id}`)).json);
    assert.equal(s['agents-file'], 'fail');
    assert.equal(s['roadmap-file'], 'fail');
    assert.equal(s['registro-block'], 'unavailable');
    assert.equal(s['roadmap-header'], 'unavailable');
  });
});

test('GET /api/requirements: an unknown base branch makes the dependent checks unavailable, not failed', async () => {
  const repo = originAndClone({ 'AGENTS.md': REG_BLOCK });
  repo.extra = { base: 'nope' };
  await withRepoPanel(repo, async ({ getApi, id }) => {
    const r = await getApi(`/api/requirements?id=${id}`);
    assert.equal(r.json.available, false);
    const s = statuses(r.json);
    assert.equal(s['base-branch'], 'fail');
    for (const k of ['agents-file', 'registro-block', 'roadmap-file', 'roadmap-header', 'roadmap-table']) assert.equal(s[k], 'unavailable', k);
    assert.equal(r.json.summary.ready, false);
  });
});

test('GET /api/prerequisites needs the token and answers git, gh and orca without failing', async () => {
  await withPanel({}, async ({ getApi }) => {
    assert.equal((await getApi('/api/prerequisites', false)).status, 401);
    const r = await getApi('/api/prerequisites');
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.items.map((i) => i.id), ['git', 'gh', 'orca']);
    for (const i of r.json.items) { assert.equal(typeof i.ok, 'boolean'); assert.equal(typeof i.detail, 'string'); }
  });
});

test('prerequisites: runs the three fixed commands; a missing tool is ok false, never a throw', async () => {
  const { prerequisites } = require('../server/requirements.js');
  const calls = [];
  const runner = async (cmd, args) => {
    calls.push([cmd, ...args].join(' '));
    if (cmd === 'git') return { code: 0, stdout: 'git version 2.50.0\n', stderr: '' };
    if (cmd === 'gh') return { code: 1, stdout: '', stderr: 'You are not logged into any GitHub hosts.\n' };
    return { code: -1, stdout: '', stderr: '' };
  };
  const { items } = await prerequisites(runner);
  assert.deepEqual(calls, ['git --version', 'gh auth status', 'orca --version']);
  assert.deepEqual(items, [
    { id: 'git', ok: true, detail: 'git version 2.50.0' },
    { id: 'gh', ok: false, detail: 'You are not logged into any GitHub hosts.' },
    { id: 'orca', ok: false, detail: 'not available' },
  ]);
});

// ---------- put-in-conditions order ----------
const { conditionsOrder } = require('../server/pi.js');
const INSTALL = path.join(__dirname, '..', 'requirements', 'INSTALL.md');
const res = (id, status, level = 'required') => ({ id, status, level });
const reqsOf = (...results) => async () => ({ available: true, results });
const MIXED = [res('base-branch', 'pass'), res('ciclo-block', 'fail', 'recommended'), res('agents-file', 'fail'), res('roadmap-header', 'unavailable'), res('registro-block', 'outdated'), res('adoption-record', 'pass', 'recommended')];

test('put-in-conditions: the order is one line, not a slash command, with the quoted INSTALL.md path and only the non-pass ids, required first', () => {
  const text = conditionsOrder(MIXED);
  assert.equal(/[\x00-\x1f\x7f]/.test(text), false);
  assert.equal(text.startsWith('/'), false);
  assert.ok(text.includes(`"${INSTALL}"`), text);
  assert.match(text, /user authorizes reading that one file outside this repo/);
  assert.match(text, /ids: agents-file, roadmap-header, registro-block, ciclo-block\. Never use git mv or git add; keep the git index empty \(\/flow-commit refuses to start with staged files\)\.$/);
  for (const id of ['base-branch', 'adoption-record']) assert.equal(text.includes(id), false, id);
});

test('put-in-conditions: refuses a path with a double quote or a control character', () => {
  for (const bad of ['C:\\x"y\\INSTALL.md', 'C:\\x\ny\\INSTALL.md', 'C:\\x\ty\\INSTALL.md']) {
    assert.throws(() => conditionsOrder(MIXED, bad), (e) => e.status === 500 && /path/i.test(e.message));
  }
});

test('put-in-conditions: piSend types the built order into the one idle session', async () => {
  const f = fakeOrca();
  assert.deepEqual(await piSend(REPO, 'put-in-conditions', f.orca, noWait, reqsOf(...MIXED)), { sent: true, confirmed: true });
  assert.deepEqual(f.sends(), [['send', '--terminal', 'h1', '--text', conditionsOrder(MIXED), '--enter']]);
});

test('put-in-conditions: refuses with 409, touching nothing, when everything passes or the requirements are unavailable', async () => {
  const f = fakeOrca();
  await refuses(piSend(REPO, 'put-in-conditions', f.orca, noWait, reqsOf(res('a', 'pass'), res('b', 'pass', 'recommended'))), 409, /nothing to do/i);
  await refuses(piSend(REPO, 'put-in-conditions', f.orca, noWait, async () => ({ available: false, results: [res('a', 'unavailable')] })), 409, /could not be (read|evaluated)/i);
  assert.equal(f.calls.length, 0);
  assert.equal((await piSend(REPO, 'put-in-conditions', fakeOrca().orca, noWait, reqsOf(res('a', 'fail')))).sent, true); // lock freed
});

test('put-in-conditions: keeps the session safeguards (busy prompt, several sessions) and sends nothing', async () => {
  for (const [opts, re] of [[{ previews: [BUSY_PI] }, /busy or has text/], [{ terminals: [piTerm(), piTerm({ handle: 'h2' })] }, /Several pi sessions/]]) {
    const f = fakeOrca(opts);
    await refuses(piSend(REPO, 'put-in-conditions', f.orca, noWait, reqsOf(res('a', 'fail'))), 409, re);
    assert.equal(f.sends().length, 0);
  }
});

test('piSend still types each fixed command as before', async () => {
  for (const [key, text] of [['flow-commit', '/flow-commit'], ['flow-pr', '/flow-pr'], ['flow-base', '/flow-base'], ['flow-base-stash', '/flow-base --stash']]) {
    const f = fakeOrca();
    await piSend(REPO, key, f.orca, noWait, async () => { throw new Error('requirements must not be read'); });
    assert.deepEqual(f.sends(), [['send', '--terminal', 'h1', '--text', text, '--enter']]);
  }
});

// ---------- dismissed warning ----------
test('dismissed: validated on load, exposed by /api/config, saved by POST /api/dismiss and kept across other saves', async () => {
  const groups = [{ name: 'g', repos: [{ path: '/x/a' }, { path: '/x/b' }] }];
  const [a, b] = ['/x/a', '/x/b'].map((p) => require('../lib.js').repoId(p));
  await withPanel({ groups, dismissed: [a, a, 7, '', b] }, async ({ post, getApi, file }) => {
    assert.deepEqual((await getApi('/api/config')).json.dismissed, [a, b]);
    assert.deepEqual((await post('/api/dismiss', { id: a, on: false })).json, { dismissed: [b] });
    assert.deepEqual((await post('/api/dismiss', { id: a, on: true })).json, { dismissed: [b, a] });
    assert.deepEqual((await post('/api/dismiss', { id: a, on: true })).json, { dismissed: [b, a] });
    await post('/api/snooze', { id: a, number: 3, on: true });
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).dismissed, [b, a]);
    await post('/api/repos/remove', { id: b });
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).dismissed, [a]);
  });
  await withPanel({ groups, dismissed: 'x' }, async ({ getApi }) => {
    assert.deepEqual((await getApi('/api/config')).json.dismissed, []);
  });
  await withPanel({ groups }, async ({ post, getApi, file }) => {
    assert.deepEqual((await getApi('/api/config')).json.dismissed, []);
    await post('/api/snooze', { id: a, number: 3, on: true });
    assert.equal('dismissed' in JSON.parse(fs.readFileSync(file, 'utf8')), false);
  });
});

test('POST /api/dismiss needs the token and rejects an unknown repo', async () => {
  await withPanel({ groups: [{ name: 'g', repos: [{ path: '/x/a' }] }] }, async ({ post, port }) => {
    assert.equal((await post('/api/dismiss', { id: 'nope', on: true })).status, 404);
    const raw = await new Promise((resolve) => {
      const req = http.request({ host: '127.0.0.1', port, path: '/api/dismiss', method: 'POST' }, (r) => { r.resume(); resolve(r.statusCode); });
      req.end('{}');
    });
    assert.equal(raw, 401);
  });
});

// ---------- remoteFile: missing is not the same as a failed read ----------
const { remoteFile } = require('../server/roadmap.js');
const looseObject = (repo, ref) => {
  const sha = sh(repo.work, 'rev-parse', ref);
  return path.join(repo.work, '.git', 'objects', sha.slice(0, 2), sha.slice(2));
};

test('remoteFile: a file absent from the base branch is missing; an unreadable one is error and is not cached', async () => {
  const repo = originAndClone({ 'docs/ROADMAP.md': rows(['A1', 'Pendiente']) });
  const r = { id: 'rf', path: repo.work, base: 'main' };
  try {
    const miss = await remoteFile(r, 'nope.md');
    assert.deepEqual([miss.available, miss.reason, miss.base], [false, 'missing', 'main']);
    assert.equal((await remoteFile(r, 'docs/ROADMAP.md')).available, true);
    repo.push('docs/PLAN.md', rows(['P1', 'Pendiente']), 'plan');
    sh(repo.work, 'fetch', '-q');
    const obj = looseObject(repo, 'origin/main:docs/PLAN.md');
    const saved = fs.readFileSync(obj);
    fs.rmSync(obj);
    const bad = await remoteFile(r, 'docs/PLAN.md');
    assert.deepEqual([bad.available, bad.reason, bad.base], [false, 'error', 'main']);
    fs.writeFileSync(obj, saved);
    const good = await remoteFile(r, 'docs/PLAN.md');
    assert.equal(good.available, true);
    assert.match(good.text, /P1/);
  } finally { fs.rmSync(repo.tmp, { recursive: true, force: true }); }
});

test('an unreadable roadmap is reported as error, never cached, and requirements/conformity treat it as unavailable', async () => {
  const repo = originAndClone({ 'AGENTS.md': REG_BLOCK, 'docs/ROADMAP.md': HEADER + rows(['A1', 'Pendiente']) });
  const obj = looseObject(repo, 'origin/main:docs/ROADMAP.md');
  const saved = fs.readFileSync(obj);
  await withRepoPanel(repo, async ({ getApi, post, id }) => {
    fs.rmSync(obj);
    assert.deepEqual((await getApi(`/api/roadmap?id=${id}`)).json, { available: false, reason: 'error', base: 'main', path: 'docs/ROADMAP.md' });
    const s = statuses((await getApi(`/api/requirements?id=${id}`)).json);
    assert.equal(s['roadmap-file'], 'unavailable');
    assert.equal(s['roadmap-header'], 'unavailable');
    assert.equal(s['roadmap-table'], 'unavailable');
    assert.equal(s['agents-file'], 'pass');
    const conf = await post('/api/conformity', { entries: [{ id, name: 'a', roadmap: { available: false, reason: 'error' } }] });
    assert.deepEqual(conf.json.items.map((i) => i.status), ['unavailable']);
    fs.writeFileSync(obj, saved);
    const again = (await getApi(`/api/roadmap?id=${id}`)).json;
    assert.equal(again.available, true);
    assert.equal(statuses((await getApi(`/api/requirements?id=${id}`)).json)['roadmap-header'], 'pass');
  });
});

// ---------- rooms: config, /api/config, /api/rooms and member requirements ----------
const ABS = (n) => path.join(os.tmpdir(), 'rp-room', n);
const ROOMS_IN = [
  { name: ' UPEN ', path: ABS('ceo'), repos: ['a', 'a', 7, '', 'b'] },
  { name: 'upen', path: ABS('other'), repos: ['c'] },
  { name: 'REL', path: 'rel/dir', repos: [] },
  { name: '   ', path: ABS('blank'), repos: [] },
  { name: 'x'.repeat(61), path: ABS('long'), repos: [] },
  'junk',
  { name: 'H2O', path: ABS('h2o'), repos: ['b', 'd'] },
  { name: 'NoRepos', path: ABS('none') },
];
const ROOMS_OUT = [
  { name: 'UPEN', path: ABS('ceo'), repos: ['a', 'b'] },
  { name: 'H2O', path: ABS('h2o'), repos: ['d'] },
  { name: 'NoRepos', path: ABS('none'), repos: [] },
];

test('rooms config: bad entries are dropped, names trimmed and unique, a repo keeps only its first room; exposed by /api/config', async () => {
  await withPanel({ rooms: ROOMS_IN }, async ({ getApi }) => {
    assert.deepEqual((await getApi('/api/config')).json.rooms, ROOMS_OUT);
  });
  await withPanel({ rooms: 'x' }, async ({ getApi }) => {
    assert.deepEqual((await getApi('/api/config')).json.rooms, []);
  });
  await withPanel({}, async ({ getApi }) => {
    assert.deepEqual((await getApi('/api/config')).json.rooms, []);
  });
});

test('rooms config survives a config save (valid rooms cleaned, ignored entries kept in place); without it none is written', async () => {
  const groups = [{ name: 'g', repos: [{ path: '/x/a' }] }];
  const id = require('../lib.js').repoId('/x/a');
  await withPanel({ groups, rooms: ROOMS_IN }, async ({ post, file }) => {
    await post('/api/snooze', { id, number: 3, on: true });
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).rooms, [ROOMS_OUT[0], ...ROOMS_IN.slice(1, 6), ROOMS_OUT[1], ROOMS_OUT[2]]);
  });
  await withPanel({ groups }, async ({ post, file }) => {
    await post('/api/snooze', { id, number: 3, on: true });
    assert.equal('rooms' in JSON.parse(fs.readFileSync(file, 'utf8')), false);
  });
});

test('GET /api/rooms needs the token and answers an empty list when no room is configured', async () => {
  await withPanel({}, async ({ getApi }) => {
    assert.equal((await getApi('/api/rooms', false)).status, 401);
    const r = await getApi('/api/rooms');
    assert.equal(r.status, 200);
    assert.deepEqual(r.json, { rooms: [] });
  });
});

const ENLACES_MD = '# Enlaces\n## Proyectos\n## Contratos\n## Dependencias\n## Cola de órdenes\n## Último barrido\n';
const CICLO_SALA = '<!-- orquestacion:ciclo v1.0 -->\nx\n<!-- SALA -->\ny\n<!-- /SALA -->\n<!-- /orquestacion:ciclo -->\n';

test('roomRequirementsFor: reads AGENTS.md and ENLACES.md (root or estrategia/) from the room base branch', async () => {
  const { roomRequirementsFor } = require('../server/requirements.js');
  const under = originAndClone({ 'AGENTS.md': '# Room\n', 'estrategia/ENLACES.md': ENLACES_MD });
  const bare = originAndClone({ 'AGENTS.md': '# Room\n' });
  const root = originAndClone({ 'AGENTS.md': '# Room\n', 'ENLACES.md': '# Enlaces\n## Proyectos\n' });
  try {
    const ok = await roomRequirementsFor({ id: 'r1', path: under.work });
    assert.deepEqual([ok.available, ok.base, ok.summary.ready], [true, 'main', true]);
    assert.deepEqual(Object.fromEntries(ok.results.map((x) => [x.id, x.status])), {
      'room-base-branch': 'pass', 'room-agents-file': 'pass', 'room-enlaces-file': 'pass', 'room-enlaces-sections': 'pass',
    });
    const none = await roomRequirementsFor({ id: 'r2', path: bare.work });
    assert.equal(none.results.find((x) => x.id === 'room-enlaces-file').status, 'fail');
    assert.equal(none.summary.ready, false);
    const part = await roomRequirementsFor({ id: 'r3', path: root.work });
    assert.equal(part.results.find((x) => x.id === 'room-enlaces-file').status, 'pass');
    assert.match(part.results.find((x) => x.id === 'room-enlaces-sections').detail, /missing: contracts/);
    const lost = await roomRequirementsFor({ id: 'r4', path: path.join(under.tmp, 'nope') });
    assert.deepEqual([lost.available, lost.base], [false, null]);
    assert.equal(lost.results.find((x) => x.id === 'room-base-branch').status, 'unavailable');
  } finally { for (const r of [under, bare, root]) fs.rmSync(r.tmp, { recursive: true, force: true }); }
});

test('GET /api/requirements: a room member also gets the member-only results and its room; others are unchanged', async () => {
  const lib = require('../lib.js');
  const member = originAndClone({ 'AGENTS.md': REG_BLOCK, 'docs/ROADMAP.md': HEADER + rows(['A1', 'Pendiente']) });
  const outside = originAndClone({ 'AGENTS.md': REG_BLOCK + CICLO_SALA, 'docs/ROADMAP.md': HEADER + rows(['A1', 'Pendiente']), 'docs/ORQUESTACION.md': ORQ });
  const config = {
    groups: [{ name: 'g', repos: [{ path: member.work, base: 'main' }, { path: outside.work, base: 'main' }] }],
    rooms: [{ name: 'UPEN', path: ABS('ceo'), repos: [lib.repoId(member.work)] }],
  };
  try {
    await withPanel(config, async ({ getApi }) => {
      const m = (await getApi(`/api/requirements?id=${lib.repoId(member.work)}`)).json;
      assert.deepEqual(m.room, { name: 'UPEN' });
      const s = statuses(m);
      assert.equal(s['sala-region'], 'fail');
      assert.equal(s['ciclo-block'], 'fail');
      assert.equal(m.results.find((x) => x.id === 'ciclo-block').level, 'required');
      assert.equal(m.summary.ready, false);
      // A repo outside every room: same keys, same results (no sala-region; ciclo-block is required for everybody since RP44), no room field.
      const o = (await getApi(`/api/requirements?id=${lib.repoId(outside.work)}`)).json;
      assert.deepEqual(Object.keys(o), ['available', 'base', 'results', 'summary']);
      assert.deepEqual(o.results.map((x) => x.id), ['base-branch', 'agents-file', 'registro-block', 'tareas-block', 'entrega-block', 'roadmap-file', 'roadmap-header', 'roadmap-table', 'ciclo-block', 'adoption-record', 'padron-record', 'estado-block', 'panel-ignored']);
      assert.equal(o.results.find((x) => x.id === 'ciclo-block').level, 'required');
      assert.deepEqual(o.summary, { required: { pass: 10, total: 10 }, recommended: { pass: 1, total: 3 }, ready: true });
    });
  } finally { for (const r of [member, outside]) fs.rmSync(r.tmp, { recursive: true, force: true }); }
});

// ---------- RP12c: manual and waiting on /api/queue ----------
test('POST /api/queue needs the token for the new fields too', async () => {
  await withPanel({}, async ({ port }) => {
    const status = await new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, path: '/api/queue', method: 'POST' }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
      req.on('error', reject); req.end(JSON.stringify({ items: [qitem('a', { manual: 'm' })] }));
    });
    assert.equal(status, 401);
  });
});

test('POST /api/queue cleans manual and waiting and drops deliver and start for them', async () => {
  await withPanel({}, async ({ post }) => {
    const r = await post('/api/queue', { items: [
      qitem('m', { dirty: true, manual: `  ${'x'.repeat(500)}  ` }),
      qitem('w', { dirty: true, waiting: { state: 'needs-input', next: ` ${'y'.repeat(500)} `, extra: 1 } }),
      qitem('s', { next: { id: 'RP1', entrega: 'e' }, manual: 7, waiting: { state: 'working', next: 'n' } }),
      qitem('d', { dirty: true, waiting: 'blocked' }),
    ] });
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.queue.map((a) => `${a.name}:${a.kind}`), ['m:manual', 'w:waiting', 'd:deliver', 's:start']);
    assert.equal(r.json.queue[0].reason, 'x'.repeat(200));
    assert.deepEqual(r.json.queue[1], { repoId: 'w', name: 'w', kind: 'waiting', state: 'needs-input', next: 'y'.repeat(200) });
  });
});

test('POST /api/queue keeps the exact answer for an old-shape body', async () => {
  await withPanel({}, async ({ post }) => {
    const r = await post('/api/queue', { items: [qitem('a', { dirty: true }), qitem('b', { stale: true }), qitem('c', { next: { id: 'RP9', entrega: 'E' } }), qitem('d', { ready: [{ number: 3, title: 'T' }], hasPrs: true })] });
    assert.deepEqual(r.json, { queue: [
      { repoId: 'd', name: 'd', kind: 'merge', pr: 3, title: 'T' },
      { repoId: 'b', name: 'b', kind: 'branch' },
      { repoId: 'a', name: 'a', kind: 'deliver' },
      { repoId: 'c', name: 'c', kind: 'start', unit: { id: 'RP9', entrega: 'E' } },
    ] });
  });
});

// ---------- test/git-helper.js: failures name the command, and only Windows retries the setup commands ----------
const gitFail = (status, stderr = '', stdout = '') => Object.assign(new Error('Command failed'), { status, signal: null, stderr, stdout });
// An injectable runner: each call takes the next outcome (an Error to throw, anything else to return).
function fakeGit(...outcomes) {
  const calls = [];
  const exec = (cmd, argv) => { calls.push([cmd, ...argv]); const o = outcomes[Math.min(calls.length, outcomes.length) - 1]; if (o instanceof Error) throw o; return o; };
  return { calls, exec };
}

test('sh: a failing git command throws an error with the command, the exit status and git\'s own output', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-panel-sh-'));
  try {
    sh(tmp, 'init', '-q', '-b', 'main');
    let caught;
    try { sh(tmp, 'rev-parse', '--verify', 'nope'); } catch (e) { caught = e; }
    assert.ok(caught instanceof Error, 'it throws');
    assert.match(caught.message, /git .*rev-parse --verify nope/);
    assert.match(caught.message, /status 128/);
    assert.match(caught.message, /signal/);
    assert.match(caught.message, /^stderr: \S/m, 'git\'s own stderr is included, whatever its language');
    assert.ok(caught.cause instanceof Error, 'the original error is kept as cause');
    assert.equal(caught.cause.status, 128);
    assert.ok(!/after 1 retry/.test(caught.message), 'a command that was not retried does not claim a retry');
  } finally { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5 }); }
});

test('sh: a successful command still returns the trimmed stdout', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-panel-sh-'));
  try {
    sh(tmp, 'init', '-q', '-b', 'main');
    assert.equal(sh(tmp, 'symbolic-ref', '--short', 'HEAD'), 'main');
  } finally { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5 }); }
});

test('runGit: on win32 a failing push is retried once after 300 ms and then reported with the retry', () => {
  const { calls, exec } = fakeGit(gitFail(1, 'first err', 'first out'), gitFail(1, 'file is locked', 'some out'));
  const waits = [];
  assert.throws(() => runGit('/w', ['push', '-q', 'origin', 'main'], { exec, platform: 'win32', sleep: (ms) => waits.push(ms) }), (e) => {
    assert.match(e.message, /push -q origin main/);
    assert.match(e.message, /status 1/);
    assert.match(e.message, /after 1 retry/);
    assert.match(e.message, /file is locked/);
    assert.match(e.message, /some out/);
    assert.equal(e.cause.stderr, 'file is locked');
    return true;
  });
  assert.equal(calls.length, 2);
  assert.deepEqual(waits, [300]);
});

test('runGit: on win32 clone and fetch are retried too, commit and other commands are not', () => {
  for (const cmd of ['clone', 'fetch']) {
    const { calls, exec } = fakeGit(gitFail(1));
    assert.throws(() => runGit('/w', [cmd, 'x'], { exec, platform: 'win32', sleep() {} }), /after 1 retry/);
    assert.equal(calls.length, 2, cmd);
  }
  for (const cmd of ['commit', 'checkout', 'rev-parse']) {
    const { calls, exec } = fakeGit(gitFail(1));
    const waits = [];
    assert.throws(() => runGit('/w', [cmd, 'x'], { exec, platform: 'win32', sleep: (ms) => waits.push(ms) }), (e) => !/after 1 retry/.test(e.message));
    assert.equal(calls.length, 1, cmd);
    assert.deepEqual(waits, []);
  }
});

test('runGit: outside win32 a failing push is not retried', () => {
  for (const platform of ['linux', 'darwin']) {
    const { calls, exec } = fakeGit(gitFail(1, 'rejected'));
    const waits = [];
    assert.throws(() => runGit('/w', ['push', 'origin', 'main'], { exec, platform, sleep: (ms) => waits.push(ms) }), (e) => /rejected/.test(e.message) && !/after 1 retry/.test(e.message));
    assert.equal(calls.length, 1, platform);
    assert.deepEqual(waits, []);
  }
});

test('runGit: a push that fails once on win32 and then succeeds returns the second result', () => {
  const { calls, exec } = fakeGit(gitFail(1, 'locked'), `  pushed  ${String.fromCharCode(10)}`);
  assert.equal(runGit('/w', ['push', 'origin', 'main'], { exec, platform: 'win32', sleep() {} }), 'pushed');
  assert.equal(calls.length, 2);
});

test('runGit: secrets in a URL argument never reach the error message', () => {
  const { exec } = fakeGit(gitFail(1, 'denied'));
  assert.throws(() => runGit('/w', ['clone', 'https://user:s3cret@example.com/r.git'], { exec, platform: 'linux' }), (e) => e.message.includes('example.com') && !/s3cret/.test(e.message));
});

test('runGit: GitHub tokens and Authorization header values never reach the error message, wherever they appear', () => {
  const classic = 'ghp_' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8';
  const fine = 'github_pat_' + '11ABCDEFG0abcdefghij_KLMNOPQRSTUVWXYZ0123456789abcdefghijklmnop';
  const oauth = 'gho_' + 'Z9y8X7w6V5u4T3s2R1q0P9o8N7m6L5k4J3i2';
  const { exec } = fakeGit(gitFail(1, `remote: bad credentials ${classic}\nAuthorization: Bearer abc123SECRET`, `echo ${fine} and ${oauth}`));
  assert.throws(() => runGit('/w', ['-c', 'http.extraheader=AUTHORIZATION: basic dXNlcjpwYXNz', 'fetch', 'origin'], { exec, platform: 'linux' }), (e) => {
    for (const secret of [classic, fine, oauth, 'abc123SECRET', 'dXNlcjpwYXNz']) assert.ok(!e.message.includes(secret), `${secret} is hidden`);
    assert.match(e.message, /remote: bad credentials \*\*\*/);
    assert.match(e.message, /Authorization: Bearer \*\*\*/);
    assert.match(e.message, /AUTHORIZATION: basic \*\*\*/);
    assert.match(e.message, /stdout: echo \*\*\* and \*\*\*/);
    return true;
  });
});

test('runGit: text that only looks like a token or a header is left as it was', () => {
  const text = 'ghp_short, ghost_town, github_pat_x, an authorization was requested, see ghp_ docs';
  const { exec } = fakeGit(gitFail(1, text));
  assert.throws(() => runGit('/w', ['fetch'], { exec, platform: 'linux' }), (e) => e.message.includes(`stderr: ${text}`));
});
