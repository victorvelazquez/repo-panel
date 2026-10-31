'use strict';
// RP80 (S68, S75), design point 4: GET /api/board?since=N answers deps.summaryStore.board(since) (token and host checks, 400 for a bad since,
// 404 without a store, no Orca/git/gh call) and POST /api/board/refresh answers { started: true } at once and starts refreshRepo(id) or refreshAll()
// in the background (errors swallowed). Fake stores and fake readers on a temp config only; the real config, Orca, git and gh are never used.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { AsyncLocalStorage } = require('node:async_hooks');

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'rp80h-'));
const repoDir = path.join(scratch, 'RepoOne');
fs.mkdirSync(repoDir);
process.env.REPO_PANEL_CONFIG = path.join(scratch, 'config.json');
process.env.REPO_PANEL_CASES_FILE = 'off';
fs.writeFileSync(process.env.REPO_PANEL_CONFIG, JSON.stringify({ port: 4310, groups: [{ name: 'G', repos: [{ path: repoDir }] }], rooms: [] }));
const { mock } = test;
test.after(() => { mock.restoreAll(); fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 5 }); });

const exec = require('../server/exec.js');
const lib = require('../lib.js');
// The lane a handler or a reader runs in: wrapped BEFORE http.js is required (it takes withPriority when loaded).
const lane = new AsyncLocalStorage();
const realWithPriority = exec.withPriority;
mock.method(exec, 'withPriority', (priority, fn) => lane.run(priority, () => realWithPriority(priority, fn)));
const { createServer } = require('../server/http.js');
const { HttpError } = require('../server/errors.js');

const ID = lib.repoId(repoDir);
const BOARD = { rev: 7, repos: { r1: { rev: 7, at: { local: 5 }, local: { branch: 'main' }, errors: {}, stale: [] } }, refreshing: ['r1'] };
const flush = async () => { for (let i = 0; i < 25; i++) await new Promise((r) => setImmediate(r)); };
const gate = () => { let open; const p = new Promise((r) => { open = r; }); return { p, open }; };

function fakeStore() {
  const s = {
    log: [], lanes: [], held: null, failWith: null,
    board(since) { s.log.push(['board', since]); return BOARD; },
    snapshot: () => ({ rows: [], counts: {}, attention: [], generatedAt: 'x' }),
    setSession() {}, touch() {}, start() {}, stop() {}, tick: async () => {},
  };
  for (const m of ['refreshAll', 'refreshRepo']) {
    s[m] = async (...args) => {
      s.log.push([m, ...args]);
      s.lanes.push(lane.getStore());
      if (s.held) await s.held.p;
      if (s.failWith) throw s.failWith;
    };
  }
  return s;
}

// Fake readers that count their calls and the lane they ran in: nothing of the real Orca, git or gh is ever used.
function fakeDeps() {
  const calls = [];
  const lanes = [];
  const note = (name, value) => async () => { calls.push(name); lanes.push(lane.getStore()); return value; };
  return {
    calls, lanes,
    orca: async (args) => { calls.push(`orca ${args[0]}`); throw new Error('orca must not be called'); },
    local: note('local', { branch: 'main', files: [], ahead: 0, behind: 0, base: 'main' }),
    prs: note('prs', { prs: [], stale: null }),
    roadmap: note('roadmap', { available: false, reason: 'missing' }),
    state: note('state', { available: false }),
    requirements: note('requirements', { available: true, results: [], summary: { ok: 1, total: 1 } }),
    git: async () => { calls.push('git'); lanes.push(lane.getStore()); return { code: 0, stdout: '2026-10-28T10:00:00Z\nsubject\n', stderr: '' }; },
  };
}

const freePort = () => new Promise((resolve) => {
  const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
});
const call = (port, method, p, { headers = {}, body } = {}) => new Promise((resolve, reject) => {
  const data = body === undefined ? null : JSON.stringify(body);
  const req = http.request({ host: '127.0.0.1', port, path: p, method, agent: false, headers: { host: `127.0.0.1:${port}`, ...(data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {}), ...headers } }, (res) => {
    let text = '';
    res.setEncoding('utf8');
    res.on('data', (c) => { text += c; });
    res.on('end', () => resolve({ status: res.statusCode, body: text, json: () => JSON.parse(text) }));
  });
  req.on('error', reject);
  req.end(data);
});
async function withServer(deps, fn) {
  const port = await freePort();
  const server = createServer(port, deps);
  await new Promise((r) => server.listen(port, '127.0.0.1', r));
  try {
    const token = /name="?token"? content="([0-9a-f]+)"/.exec((await call(port, 'GET', '/')).body)[1];
    await fn({
      port, server,
      get: (p, headers = {}) => call(port, 'GET', p, { headers: { 'x-token': token, ...headers } }),
      post: (p, body = {}) => call(port, 'POST', p, { headers: { 'x-token': token }, body }),
    });
  } finally { server.close(); server.closeAllConnections(); }
}

// ---------- GET /api/board ----------
test('GET /api/board needs the token and our own host, and touches the store only after both', async () => {
  const store = fakeStore();
  await withServer({ ...fakeDeps(), summaryStore: store }, async ({ port, get }) => {
    const noToken = await call(port, 'GET', '/api/board?since=0');
    assert.equal(noToken.status, 401);
    assert.deepEqual(noToken.json(), { error: 'Invalid token' });
    assert.equal((await get('/api/board?since=0', { host: 'evil.example:80' })).status, 403);
    assert.deepEqual(store.log, []);
  });
});

test('GET /api/board?since=N answers exactly what store.board(N) answers, with N as a number, once per request', async () => {
  const store = fakeStore();
  const deps = { ...fakeDeps(), summaryStore: store };
  await withServer(deps, async ({ get }) => {
    for (const [q, since] of [['0', 0], ['5', 5], ['123456', 123456]]) {
      const r = await get(`/api/board?since=${q}`);
      assert.equal(r.status, 200, q);
      assert.deepEqual(r.json(), BOARD);
      assert.deepEqual(store.log.at(-1), ['board', since], q);
    }
    assert.equal(store.log.length, 3);
    assert.deepEqual(deps.calls, [], 'no Orca, git, gh or reader call');
  });
});

test('GET /api/board with a since that is not an integer >= 0 is a 400 with an error, and the store is not asked', async () => {
  const store = fakeStore();
  await withServer({ ...fakeDeps(), summaryStore: store }, async ({ get }) => {
    for (const bad of ['-1', '1.5', 'abc', 'NaN', 'Infinity', '1,2', '5abc']) {
      const r = await get(`/api/board?since=${encodeURIComponent(bad)}`);
      assert.equal(r.status, 400, JSON.stringify(bad));
      assert.equal(typeof r.json().error, 'string', JSON.stringify(bad));
    }
    assert.deepEqual(store.log, []);
  });
});

test('GET /api/board without a store (noSummaryStore) is a 404 with an error so the page falls back, and calls nothing', async () => {
  const deps = fakeDeps();
  await withServer({ ...deps, noSummaryStore: true }, async ({ port, get }) => {
    assert.equal((await call(port, 'GET', '/api/board?since=0')).status, 401, 'the token is still checked first');
    const r = await get('/api/board?since=0');
    assert.equal(r.status, 404);
    assert.equal(typeof r.json().error, 'string');
    assert.deepEqual(deps.calls, []);
  });
});

test('with the real store the first board is every repo with no fact and reads nothing; refresh then fills it, in the background lane', async () => {
  const deps = fakeDeps();
  await withServer(deps, async ({ get, post }) => {
    const first = (await get('/api/board?since=0')).json();
    assert.deepEqual(first, { rev: 0, repos: { [ID]: { rev: 0, at: {}, errors: {}, stale: [] } }, refreshing: [] });
    assert.deepEqual(deps.calls, [], 'the request reads nothing');
    assert.deepEqual((await post('/api/board/refresh', {})).json(), { started: true });
    for (let i = 0; i < 40 && deps.calls.length < 6; i++) await flush();
    assert.deepEqual([...deps.calls].sort(), ['git', 'local', 'prs', 'requirements', 'roadmap', 'state']);
    assert.deepEqual([...new Set(deps.lanes)], ['background'], 'the person asked, the reads run in the background lane');
    await flush();
    const b = (await get('/api/board?since=0')).json();
    assert.equal(b.rev, 6);
    assert.deepEqual(Object.keys(b.repos[ID]).sort(), ['at', 'errors', 'local', 'prs', 'req', 'rev', 'roadmap', 'stale', 'state']);
    assert.deepEqual(b.repos[ID].req, { available: true, results: [], summary: { ok: 1, total: 1 } });
    assert.deepEqual((await get('/api/board?since=6')).json(), { rev: 6, repos: {}, refreshing: [] });
    assert.equal(deps.calls.filter((c) => c.startsWith('orca')).length, 0);
  });
});

// ---------- POST /api/board/refresh ----------
test('POST /api/board/refresh needs the token and our own host, and starts nothing without them', async () => {
  const store = fakeStore();
  await withServer({ ...fakeDeps(), summaryStore: store }, async ({ port }) => {
    assert.equal((await call(port, 'POST', '/api/board/refresh', { body: {} })).status, 401);
    assert.equal((await call(port, 'POST', '/api/board/refresh', { body: {}, headers: { host: 'evil.example:80', 'x-token': 'x' } })).status, 403);
    assert.deepEqual(store.log, []);
  });
});

test('POST without id answers { started: true } BEFORE the reads end and starts refreshAll() in the person lane', async () => {
  const store = fakeStore();
  store.held = gate();
  await withServer({ ...fakeDeps(), summaryStore: store }, async ({ post }) => {
    const r = await post('/api/board/refresh', {});
    assert.equal(r.status, 200);
    assert.deepEqual(r.json(), { started: true });
    assert.deepEqual(store.log, [['refreshAll']], 'one call, no arguments, while the read is still held');
    assert.deepEqual(store.lanes, ['user'], 'the POST is an action of the person (interactive lane)');
    store.held.open();
    await flush();
  });
});

test('POST with a known id starts refreshRepo(id) only, and answers at once', async () => {
  const store = fakeStore();
  store.held = gate();
  await withServer({ ...fakeDeps(), summaryStore: store }, async ({ post }) => {
    const r = await post('/api/board/refresh', { id: ID });
    assert.equal(r.status, 200);
    assert.deepEqual(r.json(), { started: true });
    assert.deepEqual(store.log, [['refreshRepo', ID]]);
    store.held.open();
    await flush();
  });
});

test('POST with an unknown id is a 404, with a bad id type a 400; nothing is started', async () => {
  const store = fakeStore();
  await withServer({ ...fakeDeps(), summaryStore: store }, async ({ post }) => {
    const unknown = await post('/api/board/refresh', { id: 'nope' });
    assert.equal(unknown.status, 404);
    assert.equal(typeof unknown.json().error, 'string');
    for (const id of [123, ['x'], {}, true, 0]) {
      const r = await post('/api/board/refresh', { id });
      assert.equal(r.status, 400, JSON.stringify(id));
      assert.equal(typeof r.json().error, 'string');
    }
    assert.deepEqual(store.log, []);
  });
});

test('a background read that fails (an HttpError, any error) is swallowed: still { started: true }, never an unhandled rejection', async () => {
  const seen = [];
  const onRejection = (e) => seen.push(e);
  process.on('unhandledRejection', onRejection);
  try {
    for (const failWith of [new HttpError(404, 'Unknown repo'), new Error('boom')]) {
      const store = fakeStore();
      store.failWith = failWith;
      await withServer({ ...fakeDeps(), summaryStore: store }, async ({ post }) => {
        for (const body of [{}, { id: ID }]) {
          const r = await post('/api/board/refresh', body);
          assert.equal(r.status, 200);
          assert.deepEqual(r.json(), { started: true });
        }
        await flush();
        assert.deepEqual(store.log, [['refreshAll'], ['refreshRepo', ID]]);
      });
    }
    await flush();
    assert.deepEqual(seen, []);
  } finally { process.off('unhandledRejection', onRejection); }
});

// ---------- the old routes stay as they were ----------
test('the old per-repo routes still answer 404 for an unknown repo, as before, and never read the store', async () => {
  const store = fakeStore();
  await withServer({ ...fakeDeps(), summaryStore: store }, async ({ get }) => {
    for (const route of ['local', 'prs', 'roadmap', 'requirements', 'state']) {
      const r = await get(`/api/${route}?id=nope`);
      assert.equal(r.status, 404, route);
      assert.equal(r.body, JSON.stringify({ error: 'Unknown repository' }), route);
    }
    assert.deepEqual(store.log, []);
  });
});
