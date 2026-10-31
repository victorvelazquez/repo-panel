'use strict';
// RP80b (S68, S76), design points 3 and 4: after POST /api/merge, /rerun, /fetch, /pi and /chat/send end (success or failure of the action) the
// server calls deps.summaryStore.catchUp(body.id) fire-and-forget, never changing the reply; POST /api/board/refresh with an id uses catchUp(id);
// chat/clear and every GET do not; and the page's doRerun asks the server to catch up too. A fake store, fake gh/git/Orca (mocked before
// http.js loads) and a temp config only: the real config, Orca, git and gh are never used. The page runs in a vm with a stubbed DOM and fetch.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'rp80bt-'));
const repoDir = path.join(scratch, 'RepoOne');
fs.mkdirSync(repoDir);
process.env.REPO_PANEL_CONFIG = path.join(scratch, 'config.json');
process.env.REPO_PANEL_CASES_FILE = 'off';
// The repo has an adopted (unnamed) session, so a chat message can reach the fake Orca.
fs.writeFileSync(process.env.REPO_PANEL_CONFIG, JSON.stringify({ port: 4311, groups: [{ name: 'G', repos: [{ path: repoDir }] }], rooms: [], sessions: { [require('../lib.js').repoId(repoDir)]: { id: 's1', name: 's1', adoptedAt: '2026-10-28T10:00:00.000Z' } } }));
const { mock } = test;
test.after(() => { mock.restoreAll(); fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 5 }); });

const exec = require('../server/exec.js');
const lib = require('../lib.js');
const R = require('../public/resumen.js');
const V = require('../public/view.js');

// gh and git are replaced BEFORE http.js (and github.js) take them: the routes run against these fakes, in this order of events.
const events = [];
const world = {};
const resetWorld = () => Object.assign(world, { fetchCode: 0, pr: {}, rollup: [], terminals: [], shows: 0 });
const prView = () => ({ code: 0, stderr: '', stdout: JSON.stringify({ number: 5, title: 'T', url: 'u', headRefName: 'feat', baseRefName: 'main', headRefOid: 'abc', isDraft: false, isCrossRepository: false, mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', reviewDecision: null, statusCheckRollup: world.rollup, author: { login: 'x' }, state: 'OPEN', ...world.pr }) });
mock.method(exec, 'gh', async (cwd, args) => {
  events.push(`gh ${args.slice(0, 2).join(' ')}`);
  if (args[0] === 'repo') return { code: 0, stderr: '', stdout: JSON.stringify({ nameWithOwner: 'o/r', url: 'u', deleteBranchOnMerge: true }) };
  if (args[0] === 'pr' && args[1] === 'view') return prView();
  if (args[0] === 'api' || args[0] === 'run') return { code: 0, stderr: '', stdout: '{}' };
  throw new Error(`unexpected gh ${args.join(' ')}`);
});
mock.method(exec, 'git', async (cwd, args) => {
  events.push(`git ${args[0]}`);
  return world.fetchCode === 0 ? { code: 0, stdout: '', stderr: '' } : { code: 1, stdout: '', stderr: 'boom\nsecond line' };
});
const { createServer } = require('../server/http.js');

const ID = lib.repoId(repoDir);
const flush = async () => { for (let i = 0; i < 25; i++) await new Promise((r) => setImmediate(r)); };
const gate = () => { let open; const p = new Promise((r) => { open = r; }); return { p, open }; };

function fakeStore() {
  const s = {
    log: [], held: null, failWith: null, throwSync: null,
    board: () => ({ rev: 0, repos: {}, refreshing: [] }),
    snapshot: () => ({ rows: [], counts: {}, attention: [], generatedAt: 'x' }),
    setSession() {}, touch() {}, start() {}, stop() {}, tick: async () => {},
    catchUp(...args) {
      s.log.push(['catchUp', ...args]);
      events.push('catchUp');
      if (s.throwSync) throw s.throwSync;
      return (async () => { if (s.held) await s.held.p; if (s.failWith) throw s.failWith; })();
    },
  };
  for (const m of ['refreshAll', 'refreshRepo']) s[m] = async (...args) => { s.log.push([m, ...args]); };
  return s;
}

const IDLE_PI = '▎ ✿ waiting for input\n▎   type, or / for commands\n▎\n';
const fakeOrca = () => async (args) => {
  events.push(`orca ${args[0]}`);
  if (args[0] === 'list') return { terminals: world.terminals };
  if (args[0] === 'show') return { terminal: { preview: [IDLE_PI, IDLE_PI, 'working'][Math.min(world.shows++, 2)] } };
  return { send: { accepted: true } };
};
// A clock that moves 10 s per read: the duplicate-message guard of the chat never refuses the same text twice.
let clock = 0;
const baseDeps = () => ({ now: () => (clock += 10000), orca: fakeOrca(), wait: async () => {}, sessionsDir: path.join(scratch, 'sessions'), requirements: async () => ({ available: false }) });
const withTerminal = () => { world.terminals = [{ handle: 'h1', title: 'T1', worktreePath: repoDir.replace(/\\/g, '/'), connected: true, writable: true }]; };

const freePort = () => new Promise((resolve) => {
  const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
});
const call = (port, method, p, { headers = {}, body, raw } = {}) => new Promise((resolve, reject) => {
  const data = raw !== undefined ? raw : body === undefined ? null : JSON.stringify(body);
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
  const server = createServer(port, { ...baseDeps(), ...deps });
  await new Promise((r) => server.listen(port, '127.0.0.1', r));
  try {
    const token = /name="?token"? content="([0-9a-f]+)"/.exec((await call(port, 'GET', '/')).body)[1];
    await fn({
      port, server,
      get: (p) => call(port, 'GET', p, { headers: { 'x-token': token } }),
      post: (p, body = {}) => call(port, 'POST', p, { headers: { 'x-token': token }, body }),
      raw: (p, raw) => call(port, 'POST', p, { headers: { 'x-token': token }, raw }),
      anon: (p, body = {}) => call(port, 'POST', p, { body }),
    });
  } finally { server.close(); server.closeAllConnections(); }
}

// The five actions: how to make each one succeed and fail with the fakes, and what the reply is TODAY (it must stay byte-identical).
const ACTIONS = {
  fetch: { path: '/api/fetch', body: {}, good: () => {}, ok: { ok: true }, bad: () => { world.fetchCode = 1; }, fail: [502, { error: 'boom' }] },
  merge: { path: '/api/merge', body: { number: 5, method: 'squash', deleteBranch: false }, good: () => {}, ok: { merged: true, branch: 'auto' }, bad: () => { world.pr = { state: 'CLOSED' }; }, fail: [409, { error: 'PR is CLOSED' }] },
  rerun: { path: '/api/rerun', body: { number: 5 }, good: () => { world.rollup = [{ name: 'ci', status: 'COMPLETED', conclusion: 'FAILURE', detailsUrl: 'https://x/actions/runs/123/job/1' }]; }, ok: { rerun: 1 }, bad: () => {}, fail: [409, { error: 'No failed GitHub Actions runs to re-run' }] },
  pi: { path: '/api/pi', body: { command: 'flow-commit-unstage' }, good: withTerminal, ok: { sent: true, confirmed: true }, bad: () => {}, fail: [400, { error: 'Unknown command' }], failBody: { command: 'rm -rf' } },
  chat: { path: '/api/chat/send', body: { text: 'hola' }, good: withTerminal, ok: { sent: true, delivered: false, leftInBox: false }, bad: () => {}, fail: [409, { error: 'No open session found for this repo in Orca' }] },
};
const names = Object.keys(ACTIONS);

test('after each action ends in SUCCESS the store catches up for body.id, once, AFTER the action; the reply is the same as today', async () => {
  for (const name of names) {
    const a = ACTIONS[name];
    resetWorld(); events.length = 0;
    a.good();
    const store = fakeStore();
    await withServer({ summaryStore: store }, async ({ post }) => {
      const r = await post(a.path, { id: ID, ...a.body });
      assert.equal(r.status, 200, name);
      assert.equal(r.body, JSON.stringify(a.ok), `${name}: byte-identical reply`);
      await flush();
      assert.deepEqual(store.log, [['catchUp', ID]], name);
      assert.equal(events.at(-1), 'catchUp', `${name}: it runs after the action, not before (${events.join(' > ')})`);
    });
  }
});

test('after each action ends in FAILURE (the action itself fails) the store still catches up for body.id, once; status and body are the same as today', async () => {
  for (const name of names) {
    const a = ACTIONS[name];
    resetWorld(); events.length = 0;
    a.bad();
    const store = fakeStore();
    await withServer({ summaryStore: store }, async ({ post }) => {
      const r = await post(a.path, { id: ID, ...(a.failBody || a.body) });
      assert.equal(r.status, a.fail[0], `${name}: ${r.body}`);
      assert.equal(r.body, JSON.stringify(a.fail[1]), name);
      await flush();
      assert.deepEqual(store.log, [['catchUp', ID]], name);
    });
  }
});

test('an unknown repo id is a failure of the action like any other: same 404 as before, and catchUp gets that id (the store ignores it)', async () => {
  for (const name of names) {
    const a = ACTIONS[name];
    resetWorld();
    const store = fakeStore();
    const plain = { ...baseDeps(), noSummaryStore: true };
    let before;
    await withServer(plain, async ({ post }) => { before = await post(a.path, { id: 'nope', ...a.body }); });
    await withServer({ summaryStore: store }, async ({ post }) => {
      const r = await post(a.path, { id: 'nope', ...a.body });
      assert.equal(r.status, 404, name);
      assert.equal(r.body, before.body, `${name}: byte-identical to the reply without a store`);
      await flush();
      assert.deepEqual(store.log, [['catchUp', 'nope']], name);
    });
  }
});

test('catchUp is fire-and-forget: a store that never answers, rejects or throws changes neither the reply nor the process (no unhandled rejection)', async () => {
  const seen = [];
  const onRejection = (e) => seen.push(e);
  process.on('unhandledRejection', onRejection);
  try {
    for (const mode of ['held', 'rejects', 'throws']) {
      for (const name of names) {
        const a = ACTIONS[name];
        resetWorld();
        a.good();
        const store = fakeStore();
        if (mode === 'held') store.held = gate();
        if (mode === 'rejects') store.failWith = new Error('boom');
        if (mode === 'throws') store.throwSync = new Error('sync boom');
        await withServer({ summaryStore: store }, async ({ post }) => {
          const r = await post(a.path, { id: ID, ...a.body });
          assert.equal(r.status, 200, `${mode} ${name}`);
          assert.equal(r.body, JSON.stringify(a.ok), `${mode} ${name}`);
          await flush();
          assert.deepEqual(store.log, [['catchUp', ID]], `${mode} ${name}`);
          if (store.held) store.held.open();
        });
      }
    }
    await flush();
    assert.deepEqual(seen, []);
  } finally { process.off('unhandledRejection', onRejection); }
});

test('without a store (noSummaryStore) the five actions answer exactly as before and nothing breaks', async () => {
  for (const name of names) {
    const a = ACTIONS[name];
    resetWorld();
    a.good();
    await withServer({ noSummaryStore: true }, async ({ post }) => {
      const ok = await post(a.path, { id: ID, ...a.body });
      assert.deepEqual([ok.status, ok.body], [200, JSON.stringify(a.ok)], name);
    });
    resetWorld();
    a.bad();
    await withServer({ noSummaryStore: true }, async ({ post }) => {
      const r = await post(a.path, { id: ID, ...(a.failBody || a.body) });
      assert.deepEqual([r.status, r.body], [a.fail[0], JSON.stringify(a.fail[1])], name);
    });
  }
});

test('no handler ran, no catch-up: a missing token, a foreign host and a body that is not JSON', async () => {
  const store = fakeStore();
  resetWorld();
  await withServer({ summaryStore: store }, async ({ port, post, raw, anon }) => {
    for (const name of names) {
      const a = ACTIONS[name];
      assert.equal((await anon(a.path, { id: ID, ...a.body })).status, 401, name);
      assert.equal((await call(port, 'POST', a.path, { body: { id: ID }, headers: { host: 'evil.example:80', 'x-token': 'x' } })).status, 403, name);
      const bad = await raw(a.path, '{not json');
      assert.equal(bad.status, 400, name);
      assert.deepEqual(bad.json(), { error: 'Invalid JSON' });
    }
    assert.equal((await post('/api/fetch', { id: ID })).status, 200);
  });
  assert.deepEqual(store.log, [['catchUp', ID]], 'only the one valid request');
});

test('chat/clear, the other POSTs and the GETs do NOT catch up', async () => {
  resetWorld();
  withTerminal();
  const store = fakeStore();
  await withServer({ summaryStore: store }, async ({ get, post }) => {
    await post('/api/chat/clear', { id: ID });
    await post('/api/snooze', { id: ID, number: 1, on: true });
    await post('/api/dismiss', { id: ID, on: false });
    await post('/api/board/refresh', {});
    for (const p of ['/api/config', '/api/board?since=0', '/api/summary', '/api/prs?id=nope', '/api/local?id=nope', '/api/rooms']) await get(p);
    await flush();
  });
  assert.deepEqual(store.log.filter((l) => l[0] === 'catchUp'), []);
});

// ---------- POST /api/board/refresh ----------
test('board/refresh with an id calls catchUp(id) (not refreshRepo), answers { started: true } at once while it is still running, nothing else is started', async () => {
  const store = fakeStore();
  store.held = gate();
  await withServer({ summaryStore: store }, async ({ post }) => {
    const r = await post('/api/board/refresh', { id: ID });
    assert.deepEqual([r.status, r.body], [200, JSON.stringify({ started: true })]);
    await flush();
    assert.deepEqual(store.log, [['catchUp', ID]]);
    store.held.open();
    await flush();
  });
});

test('board/refresh with no id is still refreshAll(); unknown id is still a 404 and a bad id type a 400, with nothing called', async () => {
  const store = fakeStore();
  await withServer({ summaryStore: store }, async ({ post }) => {
    assert.deepEqual((await post('/api/board/refresh', {})).json(), { started: true });
    await flush();
    assert.deepEqual(store.log, [['refreshAll']]);
    store.log.length = 0;
    const unknown = await post('/api/board/refresh', { id: 'nope' });
    assert.equal(unknown.status, 404);
    assert.equal(unknown.body, JSON.stringify({ error: 'Unknown repository' }));
    for (const id of [123, ['x'], {}, true, 0]) {
      const r = await post('/api/board/refresh', { id });
      assert.equal(r.status, 400, JSON.stringify(id));
      assert.equal(r.body, JSON.stringify({ error: 'id must be a string' }));
    }
    await flush();
    assert.deepEqual(store.log, []);
  });
});

test('board/refresh: a catchUp that rejects or throws is swallowed: still { started: true }, no unhandled rejection', async () => {
  const seen = [];
  const onRejection = (e) => seen.push(e);
  process.on('unhandledRejection', onRejection);
  try {
    for (const mode of ['failWith', 'throwSync']) {
      const store = fakeStore();
      store[mode] = new Error('boom');
      await withServer({ summaryStore: store }, async ({ post }) => {
        const r = await post('/api/board/refresh', { id: ID });
        assert.deepEqual([r.status, r.body], [200, JSON.stringify({ started: true })], mode);
        await flush();
        assert.deepEqual(store.log, [['catchUp', ID]], mode);
      });
    }
    await flush();
    assert.deepEqual(seen, []);
  } finally { process.off('unhandledRejection', onRejection); }
});

// ---------- point 4: the page (public/app.js in a vm, harness of rp80-page.test.js with the timers captured) ----------
const PUBLIC = path.join(__dirname, '..', 'public');
const BASE = 1000000;
function element(extra = {}) {
  const el = {
    html: '', hidden: false, dataset: {}, disabled: false, value: '', checked: false, textContent: '', title: '', attrs: {}, listeners: {}, children: [], open: false,
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    style: { setProperty(k, v) { el.style[k] = v; } },
    addEventListener(t, fn) { (el.listeners[t] ||= []).push(fn); }, setAttribute(k, v) { el.attrs[k] = v; }, querySelector: () => null, querySelectorAll: () => [], closest: () => null,
    showModal() {}, close() {}, focus() {}, append(c) { el.children.push(c); }, remove() {},
    get innerHTML() { return el.html; },
    set innerHTML(v) { el.html = String(v); },
    ...extra,
  };
  return el;
}
const ok = (body) => ({ ok: true, json: async () => body });
const fail = (status, error) => ({ ok: false, status, statusText: 'Failed', json: async () => ({ error }) });
const facts = {
  local: { branch: 'feat', detached: false, upstream: 'origin/feat', noUpstream: false, ahead: 0, behind: 0, files: [], added: 0, deleted: 0, head: 'h1', inProgress: null, base: 'main', stagedCount: 0, stagedPaths: [] },
  prs: { prs: [], stale: null, repo: { url: 'https://github.com/o/a' } },
  roadmap: { available: false, reason: 'x' },
  state: { available: false },
  requirements: { available: true, base: 'main', results: [], summary: { ok: 1, total: 1 } },
};

function loadPage() {
  const frames = [];
  const fetches = [];
  const timeouts = [];
  const routes = {};
  const els = {};
  const get = (sel) => (els[sel] ||= (sel === 'meta[name=token]' ? element({ content: 'token' }) : element()));
  const tabEls = ['summary', 'work', 'conformity'].map((t) => element({ dataset: { tab: t } }));
  const doc = { hidden: false, querySelector: get, querySelectorAll: (s) => (String(s).includes('data-tab') ? tabEls : []), addEventListener() {}, createElement: () => element(), body: element(), activeElement: null };
  class FakeDate extends Date { constructor(...a) { super(...(a.length ? a : [BASE])); } static now() { return BASE; } }
  const respond = (url, opts) => {
    if (routes[url]) return routes[url](url, opts);
    if (url.startsWith('/api/board?')) return new Promise(() => {});
    if (url === '/api/board/refresh') return Promise.resolve(ok({ started: true }));
    const kind = Object.keys(facts).find((k) => url.startsWith(`/api/${k}?`));
    return kind ? Promise.resolve(ok(facts[kind])) : new Promise(() => {});
  };
  const ctx = vm.createContext({
    console, document: doc, location: { hash: '' }, Date: FakeDate,
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    requestAnimationFrame: (cb) => { frames.push(cb); return frames.length; },
    setInterval: () => 0, setTimeout: (fn, ms) => { timeouts.push({ fn, ms }); return timeouts.length; }, clearTimeout: () => {}, AbortController, confirm: () => true,
    fetch: (url, opts = {}) => { fetches.push({ url, method: opts.method || 'GET', headers: opts.headers || {}, body: opts.body }); return respond(url, opts); },
  });
  ctx.window = ctx;
  ctx.addEventListener = () => {};
  ctx.RepoPanelView = V;
  ctx.RepoPanelResumen = R;
  vm.runInContext(fs.readFileSync(path.join(PUBLIC, 'app.js'), 'utf8'), ctx);
  const run = (code) => vm.runInContext(code, ctx);
  const tick = async () => { for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r)); while (frames.length) frames.shift()(); };
  // The short timers of the action (a delay of the person's own re-run): fired by hand, the long ones (request limits, toasts, redraws) are left alone.
  const fireShort = async () => {
    for (const t of timeouts.splice(0).filter((x) => x.ms >= 1000 && x.ms <= 5000 && x.ms !== 3500)) { try { await t.fn(); } catch { /* a page timer of its own */ } }
    await tick();
  };
  const S = run('S');
  S.groups = [{ name: 'G', repos: [{ id: 'abc', name: 'alpha', path: 'p' }, { id: 'xyz', name: 'beta', path: 'q' }] }];
  return { ctx, S, run, tick, fireShort, fetches, routes };
}
const refreshPosts = (page) => page.fetches.filter((f) => f.url === '/api/board/refresh');
const readsOf = (page, id) => page.fetches.filter((f) => f.method === 'GET' && /^\/api\/(local|prs|roadmap|requirements|state)\?/.test(f.url) && f.url.endsWith(`id=${id}`)).map((f) => f.url);

test('doRerun asks the server to catch up once: POST /api/board/refresh with that repo id and the user priority, whether the re-run worked or failed', async () => {
  for (const [label, route] of [['works', () => Promise.resolve(ok({ rerun: 2 }))], ['fails', () => Promise.resolve(fail(409, 'No failed GitHub Actions runs to re-run'))]]) {
    const page = loadPage();
    page.S.prs.abc = { prs: [{ number: 1, title: 'P', head: 'feat', ready: true, isCrossRepository: false }], stale: null };
    page.routes['/api/rerun'] = route;
    await page.run("doRerun('abc', 1)");
    await page.tick();
    await page.fireShort();
    await page.tick();
    assert.equal(page.fetches.filter((f) => f.url === '/api/rerun').length, 1, label);
    const posts = refreshPosts(page);
    assert.equal(posts.length, 1, `${label}: exactly one catch-up request`);
    assert.equal(posts[0].method, 'POST');
    assert.deepEqual(JSON.parse(posts[0].body), { id: 'abc' }, label);
    assert.equal(posts[0].headers['x-priority'], 'user', label);
    assert.deepEqual(readsOf(page, 'abc').map((u) => u.split('?')[0]).sort(), ['/api/local', '/api/prs', '/api/requirements', '/api/roadmap', '/api/state'], `${label}: the repo is re-read directly once`);
    assert.deepEqual(readsOf(page, 'xyz'), [], `${label}: no other repo`);
  }
});

test('doMerge and fetchRepo keep asking for the catch-up once, as before', async () => {
  for (const act of ["doMerge('abc', 1)", "fetchRepo('abc')"]) {
    const page = loadPage();
    page.S.prs.abc = { prs: [{ number: 1, title: 'P', head: 'feat', ready: true, isCrossRepository: false }], stale: null };
    page.routes['/api/merge'] = () => Promise.resolve(ok({ branch: 'kept' }));
    page.routes['/api/fetch'] = () => Promise.resolve(ok({ ok: true }));
    await page.run(act);
    await page.tick();
    await page.fireShort();
    const posts = refreshPosts(page);
    assert.equal(posts.length, 1, act);
    assert.deepEqual(JSON.parse(posts[0].body), { id: 'abc' }, act);
  }
});

// ---------- found by the full suite: no client, no work ----------
// A real server whose store nobody has asked (no page ever polled the board) must not start reads after an action: the tests that spawn a server
// on a temp repo used to get a stray Git process there and the cleanup failed with EBUSY. A fake store without awake() keeps being called as before.
test('the hook skips a store that says it is not awake, and calls one that is (a store with no awake() is always called)', async () => {
  for (const [awake, expected] of [[() => false, 0], [() => true, 1], [undefined, 1]]) {
    const store = fakeStore();
    if (awake) store.awake = awake;
    await withServer({ summaryStore: store }, async ({ post }) => {
      resetWorld();
      withTerminal();
      await post('/api/chat/send', { id: ID, text: `hello ${expected}${String(awake)}` });
      await flush();
      assert.equal(store.log.filter((l) => l[0] === 'catchUp').length, expected, String(awake));
    });
  }
});

test('POST /api/board/refresh with an id still catches up even when the store says it is not awake (the page asked)', async () => {
  const store = fakeStore();
  store.awake = () => false;
  await withServer({ summaryStore: store }, async ({ post }) => {
    const r = await post('/api/board/refresh', { id: ID });
    assert.equal(r.status, 200);
    await flush();
    assert.deepEqual(store.log.filter((l) => l[0] === 'catchUp'), [['catchUp', ID]]);
  });
});

test('a real server with a real store nobody has asked reads NOTHING after a chat message; after a page asks the board, it does', async () => {
  const calls = [];
  const readers = Object.fromEntries(['local', 'prs', 'roadmap', 'state', 'requirements'].map((k) => [k, async () => { calls.push(k); return { error: 'fake' }; }]));
  const deps = { ...readers, git: async () => { calls.push('git'); return { code: 1, stdout: '', stderr: 'fake' }; } };
  await withServer(deps, async ({ post, get }) => {
    resetWorld();
    withTerminal();
    await post('/api/chat/send', { id: ID, text: 'first message' });
    await flush();
    assert.deepEqual(calls, [], 'nobody asked: no read of any kind');
    await get('/api/board?since=0'); // a page asks
    await post('/api/chat/send', { id: ID, text: 'second message' });
    await flush();
    assert.ok(calls.length > 0, 'a page is there: the repo is read');
  });
});
