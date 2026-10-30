'use strict';
// RP78 (S68, S73), point 7: GET /api/summary answers from the store. summaryFor(deps, query) keeps its signature: with deps.summaryStore it
// answers deps.summaryStore.snapshot() at once (?fresh=1 first awaits refreshAll()); without it nothing changes. createServer builds a store
// per server unless one is injected or deps.noSummaryStore is true; server.js starts it (pinned by its text). Fakes and a temp config only.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'rp78h-'));
const repoDir = path.join(scratch, 'RepoOne');
fs.mkdirSync(repoDir);
const configFile = path.join(scratch, 'config.json');
process.env.REPO_PANEL_CONFIG = configFile;
process.env.REPO_PANEL_CASES_FILE = 'off';
fs.writeFileSync(configFile, JSON.stringify({ port: 4310, groups: [{ name: 'G', repos: [{ path: repoDir }] }], rooms: [] }));
test.after(() => fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 5 }));

const { summaryFor } = require('../server/summary.js');
const { createServer } = require('../server/http.js');

const SNAP = { rows: [{ id: 'r1', name: 'one' }], counts: { working: 0, waiting: 0, blocked: 0, idle: 1 }, attention: [], generatedAt: '2026-10-28T12:00:00.000Z' };
const flush = async () => { for (let i = 0; i < 25; i++) await new Promise((r) => setImmediate(r)); };
const gate = () => { let open; const p = new Promise((r) => { open = r; }); return { p, open }; };

function fakeStore() {
  const log = [];
  return { log, snapshot: () => { log.push('snapshot'); return SNAP; }, refreshAll: async () => { log.push('refreshAll'); }, refreshRepo: async () => {}, setSession() {}, touch() {}, start() { log.push('start'); }, stop() {}, tick: async () => {} };
}

// Fake readers that count their calls: nothing of the real Orca, git or gh is ever used.
function fakeDeps() {
  const calls = [];
  const note = (name, value) => async () => { calls.push(name); return value; };
  return {
    calls,
    orca: async (args) => { calls.push(`orca ${args[0]}`); throw new Error('orca must not be called'); },
    local: note('local', { branch: 'main', files: [], ahead: 0, behind: 0, base: 'main' }),
    prs: note('prs', { prs: [], stale: null }),
    roadmap: note('roadmap', { available: false, reason: 'missing' }),
    state: note('state', { available: false }),
    git: async () => { calls.push('git'); return { code: 0, stdout: '2026-10-28T10:00:00Z\nsubject\n', stderr: '' }; },
  };
}

// ---------- summaryFor ----------
test('summaryFor with a store answers its snapshot at once: no refresh, no Orca, no reader, no 10 s cache', async () => {
  const store = fakeStore();
  const deps = { ...fakeDeps(), summaryStore: store };
  assert.deepEqual(await summaryFor(deps, {}), SNAP);
  assert.deepEqual(await summaryFor(deps, { fresh: '0' }), SNAP);
  assert.deepEqual(store.log, ['snapshot', 'snapshot']);
  assert.deepEqual(deps.calls, []);
});

test('summaryFor with ?fresh=1 awaits refreshAll() first and then answers the snapshot', async () => {
  const store = fakeStore();
  const held = gate();
  store.refreshAll = async () => { store.log.push('refreshAll'); await held.p; store.log.push('refreshed'); };
  const answer = summaryFor({ summaryStore: store }, { fresh: '1' });
  await flush();
  assert.deepEqual(store.log, ['refreshAll'], 'the snapshot waits for the refresh');
  held.open();
  assert.deepEqual(await answer, SNAP);
  assert.deepEqual(store.log, ['refreshAll', 'refreshed', 'snapshot']);
});

test('summaryFor without a store keeps today behaviour: Orca listed once, rows built from the readers, cached per deps', async () => {
  const deps = fakeDeps();
  deps.orca = async (args) => { deps.calls.push(`orca ${args[0]}`); return { terminals: [] }; };
  const a = await summaryFor(deps, {});
  assert.deepEqual(Object.keys(a), ['rows', 'counts', 'attention', 'generatedAt']);
  assert.equal(a.rows.length, 1);
  assert.equal(a.rows[0].loading, undefined);
  assert.deepEqual(a.rows[0].session, { state: 'none' });
  assert.equal(deps.calls.filter((c) => c === 'orca list').length, 1);
  assert.equal(await summaryFor(deps, {}), a, 'the cache of the old path is untouched');
});

// ---------- createServer ----------
test('createServer builds one store per server, keeps an injected one, and builds none with noSummaryStore', () => {
  const a = createServer(1, fakeDeps());
  const b = createServer(1, fakeDeps());
  for (const s of [a, b]) for (const m of ['snapshot', 'refreshRepo', 'refreshAll', 'setSession', 'touch', 'start', 'stop', 'tick']) assert.equal(typeof s.summaryStore[m], 'function', m);
  assert.notEqual(a.summaryStore, b.summaryStore);
  const mine = fakeStore();
  assert.equal(createServer(1, { summaryStore: mine }).summaryStore, mine);
  assert.equal(createServer(1, { noSummaryStore: true }).summaryStore, undefined);
});

test('creating a server does not start its store: no timer, no reader call, no Orca call', async () => {
  const deps = fakeDeps();
  createServer(1, deps);
  await flush();
  assert.deepEqual(deps.calls, []);
});

const freePort = () => new Promise((resolve) => {
  const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
});
const get = (port, p, headers = {}) => new Promise((resolve, reject) => {
  http.get({ host: '127.0.0.1', port, path: p, headers: { host: `127.0.0.1:${port}`, ...headers }, agent: false }, (res) => {
    let body = '';
    res.setEncoding('utf8');
    res.on('data', (c) => { body += c; });
    res.on('end', () => resolve({ status: res.statusCode, body }));
  }).on('error', reject);
});
async function withServer(deps, fn) {
  const port = await freePort();
  const server = createServer(port, deps);
  await new Promise((r) => server.listen(port, '127.0.0.1', r));
  try {
    const token = /name="?token"? content="([0-9a-f]+)"/.exec((await get(port, '/')).body)[1];
    await fn({ api: async (p) => ({ ...(await get(port, p, { 'x-token': token })) }), server, port });
  } finally { server.close(); server.closeAllConnections(); }
}

test('GET /api/summary through the server answers the injected store snapshot (token still required); ?fresh=1 refreshes first', async () => {
  const store = fakeStore();
  await withServer({ ...fakeDeps(), summaryStore: store }, async ({ api, port }) => {
    assert.equal((await get(port, '/api/summary')).status, 401);
    assert.deepEqual(store.log, []);
    const r = await api('/api/summary');
    assert.equal(r.status, 200);
    assert.deepEqual(JSON.parse(r.body), SNAP);
    assert.deepEqual(store.log, ['snapshot']);
    await api('/api/summary?fresh=1');
    assert.deepEqual(store.log, ['snapshot', 'refreshAll', 'snapshot']);
  });
});

test('the default store: the first answer is the loading rows with zero reader calls; ?fresh=1 then returns the real rows', async () => {
  const deps = fakeDeps();
  await withServer(deps, async ({ api }) => {
    const first = JSON.parse((await api('/api/summary')).body);
    assert.deepEqual(Object.keys(first), ['rows', 'counts', 'attention', 'generatedAt']);
    assert.equal(first.rows.length, 1);
    assert.equal(first.rows[0].loading, true);
    assert.equal(first.rows[0].name, 'RepoOne');
    assert.deepEqual(first.counts, { working: 0, waiting: 0, blocked: 0, idle: 1 });
    assert.deepEqual(deps.calls, [], 'the request reads nothing and never lists Orca');
    const fresh = JSON.parse((await api('/api/summary?fresh=1')).body);
    assert.equal(fresh.rows[0].loading, undefined);
    assert.equal(fresh.rows[0].error, null);
    assert.equal(fresh.rows[0].branch, 'main');
    assert.deepEqual(fresh.rows[0].session, { state: 'unknown' }, 'the session comes only from the warmer');
    assert.deepEqual(fresh.rows[0].lastMovement, { at: '2026-10-28T10:00:00Z', what: 'subject' });
    assert.deepEqual([...deps.calls].sort(), ['git', 'local', 'prs', 'roadmap', 'state']);
  });
});

test('a server with noSummaryStore keeps the old path: Orca is listed and the rows are built per request', async () => {
  const deps = fakeDeps();
  deps.orca = async (args) => { deps.calls.push(`orca ${args[0]}`); return { terminals: [] }; };
  await withServer({ ...deps, noSummaryStore: true }, async ({ api }) => {
    const out = JSON.parse((await api('/api/summary?fresh=1')).body);
    assert.equal(out.rows[0].loading, undefined);
    assert.deepEqual(out.rows[0].session, { state: 'none' });
    assert.equal(deps.calls.filter((c) => c === 'orca list').length, 1);
  });
});

// ---------- server.js wiring (it only runs as a program, so it is pinned by its text, as rp77b-warm does) ----------
test('server.js starts the store and feeds it the session state the warmer publishes, next to the hub', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.match(src, /server\.summaryStore\.start\(\)/);
  assert.match(src, /server\.summaryStore\.setSession\(id, (?:payload\.)?state\)/);
  assert.match(src, /server\.hub\.publish\(id, payload\)/, 'the hub still gets the payload');
  assert.doesNotMatch(src, /noSummaryStore/);
});
