'use strict';
// RP139 (S28): the chat shows the percentage of the CONTEXT WINDOW the session uses, next to the state of the session and the memory chip. Read-only: it changes no setting of pi.
// The server asks the session for `get_session_stats` and answers ONLY { tokens, percent, window } (finite non-negative numbers or null); the page asks when a chat opens, when a run
// ends and when a compaction ends, never on a timer. Fake clients and a fake fetch, plus the fake pi of test/fixtures/fake-pi-rpc.js for the real client.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { appSource } = require('./pagesrc.js');

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'rp139-'));
const REPO = path.join(scratch, 'repo');
fs.mkdirSync(REPO);
process.env.REPO_PANEL_CONFIG = path.join(scratch, 'config.json');
// The fake pi runs with the repo as its folder: on Windows the folder is busy until the killed process is gone.
// `maxRetries` of fs.rmSync only covers ENOTEMPTY, EEXIST and EPERM inside a folder: an EBUSY on the folder itself (the fake pi has it as its working folder on Windows) is thrown at once, so the retry is made here.
test.after(async () => {
  await new Promise((r) => setTimeout(r, 1000));
  for (let i = 1; ; i += 1) {
    try { fs.rmSync(scratch, { recursive: true, force: true }); return; } catch (e) {
      if (!['EBUSY', 'EPERM', 'ENOTEMPTY'].includes(e.code) || i >= 100) throw e;
      await new Promise((r) => setTimeout(r, 200));
    }
  }
});

const lib = require('../lib.js');
const { createServer } = require('../server/http.js');
const { createRpcHost } = require('../server/rpchost.js');
const { createRpcClient, RpcError } = require('../server/rpc.js');
const { findRepo } = require('../server/config.js');
const { createEventHub } = require('../server/events.js');
const V = require('../public/view.js');
const R = require('../public/resumen.js');

const ID = lib.repoId(REPO);
const ACTIVE = { id: 'gentle-shell', command: 'C:\\L\\gentle-shell.exe', agentDir: 'C:\\a' };
const FIXTURE = path.join(__dirname, 'fixtures', 'fake-pi-rpc.js');
const NONE = { tokens: null, window: null, percent: null };
const writeConfig = () => fs.writeFileSync(process.env.REPO_PANEL_CONFIG, JSON.stringify({ groups: [{ name: 'g', repos: [{ path: REPO }] }] }));
const until = async (fn, ms = 4000) => { const end = Date.now() + ms; while (Date.now() < end) { const v = fn(); if (v) return v; await new Promise((r) => setTimeout(r, 10)); } throw new Error('timed out waiting'); };

// A fake client: `answer` is what request('get_session_stats') gives (a value, or a function that returns or throws).
function fakeFactory(answer) {
  const made = [];
  const createClient = (opts) => {
    const c = { opts, reqs: [], start: async () => ({}), request: async (type, fields) => { c.reqs.push([type, fields]); return typeof answer === 'function' ? answer() : answer; }, pendingDialogs: () => [], state: () => 'idle', close() {} };
    made.push(c);
    return c;
  };
  return { made, createClient };
}
async function hostWith(answer, over = {}) {
  writeConfig();
  const f = fakeFactory(answer);
  const published = [];
  const host = createRpcHost({ resolve: async () => ({ active: ACTIVE }), repoOf: findRepo, publish: (id, p) => published.push([id, p]), createClient: f.createClient, adoptedOf: () => null, ...over });
  return { host, published, ...f };
}
const stats = (contextUsage, extra = {}) => ({ contextUsage, ...extra });

// ---------- abuse first: what a hostile or broken session says never reaches the page as anything but the three clean numbers ----------
const HOSTILE = [
  ['strings', stats({ tokens: '124000', contextWindow: '200000', percent: '62' }), NONE],
  ['a string window with good numbers', stats({ tokens: 10, contextWindow: '200000', percent: 5 }), NONE],
  ['a negative window', stats({ tokens: 10, contextWindow: -200000, percent: 5 }), NONE],
  ['a zero window', stats({ tokens: 10, contextWindow: 0, percent: 0 }), NONE],
  ['a fractional window', stats({ tokens: 10, contextWindow: 1000.5, percent: 5 }), NONE],
  ['a huge window', stats({ tokens: 10, contextWindow: 1e300, percent: 5 }), NONE],
  ['an infinite window', stats({ tokens: 10, contextWindow: Infinity, percent: 5 }), NONE],
  ['a nested window', stats({ tokens: 10, contextWindow: { n: 1 }, percent: 5 }), NONE],
  ['contextUsage missing', { tokens: { total: 999999 } }, NONE],
  ['contextUsage null', stats(null), NONE],
  ['contextUsage a string', stats('62%'), NONE],
  ['contextUsage an array', stats([1, 2, 3]), NONE],
  ['no data at all', null, NONE],
  ['data a string', 'hello', NONE],
  ['negative tokens', stats({ tokens: -5, contextWindow: 200, percent: 10 }), { tokens: null, window: 200, percent: 10 }],
  ['negative percent', stats({ tokens: 5, contextWindow: 200, percent: -10 }), { tokens: 5, window: 200, percent: null }],
  ['percent above 100 is clamped', stats({ tokens: 500, contextWindow: 200, percent: 250 }), { tokens: 500, window: 200, percent: 100 }],
  ['NaN and Infinity numbers', stats({ tokens: NaN, contextWindow: 200, percent: Infinity }), { tokens: null, window: 200, percent: null }],
  ['null tokens and percent stay null (after a compaction)', stats({ tokens: null, contextWindow: 200000, percent: null }), { tokens: null, window: 200000, percent: null }],
  ['a nested tokens', stats({ tokens: { total: 5 }, contextWindow: 200, percent: [1] }), { tokens: null, window: 200, percent: null }],
  ['extra fields are dropped', stats({ tokens: 10, contextWindow: 200, percent: 5, model: 'secret-model', note: '/home/secret' }, { sessionFile: '/home/secret/s.jsonl', tokens: { total: 1 } }), { tokens: 10, window: 200, percent: 5 }],
  ['a good answer', stats({ tokens: 124000, contextWindow: 200000, percent: 62 }), { tokens: 124000, window: 200000, percent: 62 }],
];
for (const [name, answer, want] of HOSTILE) {
  test(`abuse: ${name}`, async () => {
    const { host } = await hostWith(answer);
    await host.start(ID);
    const got = await host.context(ID);
    assert.deepEqual(got, want);
    assert.deepEqual(Object.keys(got).sort(), ['percent', 'tokens', 'window']);
    for (const v of Object.values(got)) assert.ok(v === null || (typeof v === 'number' && Number.isFinite(v) && v >= 0));
  });
}

test('abuse: no text of the agent is forwarded, whatever it puts in the answer', async () => {
  const { host } = await hostWith(stats({ tokens: 1, contextWindow: 10, percent: 10, text: 'SECRET-A' }, { error: 'SECRET-B', message: 'SECRET-C', 'SECRET-KEY': 'SECRET-D' }));
  await host.start(ID);
  assert.doesNotMatch(JSON.stringify(await host.context(ID)), /SECRET/);
});

test('abuse: a refused or failed command is the all-null answer and its text is not forwarded (the timeout is tested with the fake pi)', async () => {
  for (const boom of [() => { throw new RpcError('stats failed: /home/SECRET/file.txt'); }, () => { throw new Error('/home/SECRET'); }]) {
    const { host } = await hostWith(boom);
    await host.start(ID);
    const got = await host.context(ID);
    assert.deepEqual(got, NONE);
    assert.doesNotMatch(JSON.stringify(got), /SECRET/);
  }
});

test('abuse: no session is 409 and an unknown repo is 404, with fixed messages', async () => {
  const { host, made } = await hostWith(stats({ tokens: 1, contextWindow: 10, percent: 10 }));
  await assert.rejects(host.context(ID), (e) => e.status === 409);
  await assert.rejects(host.context('ECHOME-unknown'), (e) => e.status === 404 && !String(e.message).includes('ECHOME'));
  assert.equal(made.length, 0);
});

test('the host asks get_session_stats with no argument and nothing else', async () => {
  const { host, made } = await hostWith(stats({ tokens: 1, contextWindow: 10, percent: 10 }));
  await host.start(ID);
  await host.context(ID);
  assert.deepEqual(made[0].reqs, [['get_session_stats', {}]]);
});

// ---------- the real client against the fake pi ----------
async function realHost(fakeEnv = {}, over = {}) {
  const clients = [];
  const createClient = (o) => { const c = createRpcClient({ ...o, command: process.execPath, args: [FIXTURE], env: { ...process.env, FAKE_PI: '1', ...fakeEnv } }); clients.push(c); return c; };
  return { ...(await hostWith(null, { ...over, createClient })), clients };
}
test('fake pi: the default answer is read as three numbers', async (t) => {
  const { host } = await realHost();
  t.after(() => host.closeAll());
  await host.start(ID);
  assert.deepEqual(await host.context(ID), { tokens: 124000, percent: 62, window: 200000 });
});
test('fake pi: a hostile contextUsage, success false and a command that never answers all end clean', async (t) => {
  const cases = [
    [{ FAKE_STATS: JSON.stringify({ contextUsage: { tokens: 'x', contextWindow: -1, percent: 999, extra: { a: 1 } } }) }, NONE],
    [{ FAKE_STATS: JSON.stringify({ contextUsage: { tokens: 5, contextWindow: 100, percent: 999 } }) }, { tokens: 5, percent: 100, window: 100 }],
    [{ FAKE_STATS_FAIL: '1' }, NONE],
    [{ FAKE_NO_ANSWER: 'get_session_stats' }, NONE],
  ];
  for (const [env, want] of cases) {
    const { host } = await realHost(env, { contextMs: 300 });
    t.after(() => host.closeAll());
    await host.start(ID);
    const got = await host.context(ID);
    assert.deepEqual(got, want, JSON.stringify(env));
    assert.doesNotMatch(JSON.stringify(got), /secret/i);
  }
});
test('fake pi: compaction events keep only their reason, from a closed list', async (t) => {
  const { host, published, clients } = await realHost();
  t.after(() => host.closeAll());
  await host.start(ID);
  const records = [
    { type: 'compaction_start', reason: 'threshold', extra: 'SECRET' },
    { type: 'compaction_end', reason: 'manual', result: { summary: 'SECRET-SUMMARY' }, aborted: false, willRetry: false, errorMessage: 'SECRET-ERR' },
    { type: 'compaction_end', reason: '<img src=x>' },
    { type: 'compaction_end', reason: { a: 1 } },
  ];
  for (const record of records) await clients[0].request('fake_emit', { record });
  await until(() => published.filter(([, p]) => p.kind === 'event' && /^compaction/.test(p.record.type)).length >= 4);
  const got = published.filter(([, p]) => p.kind === 'event' && /^compaction/.test(p.record.type)).map(([, p]) => p.record);
  assert.deepEqual(got, [{ type: 'compaction_start', reason: 'threshold' }, { type: 'compaction_end', reason: 'manual' }, { type: 'compaction_end' }, { type: 'compaction_end' }]);
  assert.doesNotMatch(JSON.stringify(published), /SECRET|img/);
});

// ---------- the HTTP route ----------
const freePort = () => new Promise((resolve) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });
const call = (port, p, { token, host } = {}) => new Promise((resolve, reject) => {
  const req = http.request({ host: '127.0.0.1', port, path: p, method: 'GET', headers: { ...(token ? { 'x-token': token } : {}), ...(host ? { host } : {}) } }, (res) => {
    let d = ''; res.on('data', (c) => { d += c; }); res.on('end', () => { let json = null; try { json = JSON.parse(d); } catch { /* not json */ } resolve({ status: res.statusCode, body: d, json }); });
  });
  req.on('error', reject);
  req.end();
});
async function withServer(answer, fn) {
  const { host, made } = await hostWith(answer);
  const port = await freePort();
  const hub = createEventHub();
  const server = createServer(port, { noSummaryStore: true, hub, rpcHost: host });
  await new Promise((r) => server.listen(port, '127.0.0.1', r));
  try {
    const token = /name="?token"? content="([0-9a-f]+)"/.exec((await call(port, '/')).body)[1];
    return await fn({ port, token, made, host, get: (p, o = {}) => call(port, p, { token, ...o }) });
  } finally { await new Promise((r) => server.close(r)); }
}
const URL_OF = (id) => `/api/rpc/context?id=${encodeURIComponent(id)}`;

test('http: the route needs the token and the host check, and does nothing without them', async () => {
  await withServer(stats({ tokens: 1, contextWindow: 10, percent: 10 }), async ({ port, token, made, host }) => {
    await host.start(ID);
    assert.equal((await call(port, URL_OF(ID))).status, 401);
    assert.equal((await call(port, URL_OF(ID), { token: 'wrong' })).status, 401);
    assert.equal((await call(port, URL_OF(ID), { token, host: 'evil.example:80' })).status, 403);
    assert.deepEqual(made[0].reqs, [], 'nothing was asked of the session');
  });
});
test('http: an id that is missing, empty or longer than 100 characters is 400; an unknown repo is 404; no session is 409', async () => {
  await withServer(stats({ tokens: 1, contextWindow: 10, percent: 10 }), async ({ get }) => {
    for (const p of ['/api/rpc/context', '/api/rpc/context?id=', URL_OF('x'.repeat(101))]) {
      const r = await get(p);
      assert.equal(r.status, 400, p);
    }
    const unknown = await get(URL_OF('ECHOME-unknown'));
    assert.equal(unknown.status, 404);
    assert.equal(unknown.body.includes('ECHOME'), false);
    assert.equal((await get(URL_OF(ID))).status, 409);
  });
});
test('http: a live session answers exactly the three numbers', async () => {
  await withServer(stats({ tokens: 124000, contextWindow: 200000, percent: 62, secret: 'x' }, { more: 1 }), async ({ get, host }) => {
    await host.start(ID);
    const r = await get(URL_OF(ID));
    assert.equal(r.status, 200);
    assert.deepEqual(r.json, { tokens: 124000, percent: 62, window: 200000 });
  });
});

// ---------- the pure parts of the page ----------
const chip = (ctx, state = 'idle') => R.ctxChipHtml({ rpc: { state, ctx } });
const text = (html) => html.replace(/<[^>]*>/g, '').replace(/&amp;|&lt;|&gt;/g, '').trim();
const titleOf = (html) => (/title="([^"]*)"/.exec(html) || [])[1];

test('chip: 62 percent reads ctx 62% with the tokens and the window in the help', () => {
  const html = chip({ tokens: 124000, percent: 62, window: 200000 });
  assert.match(text(html), /ctx 62%$/);
  assert.equal(titleOf(html), 'Context used by this session: 124k of 200k tokens');
  assert.match(html, /<i [^>]*aria-hidden="true"/);
});
test('chip: unknown (nulls) reads ctx — with its own help, never 0', () => {
  const html = chip({ tokens: null, percent: null, window: null });
  assert.match(text(html), /ctx —$/);
  assert.equal(titleOf(html), 'Context usage is unknown until the next answer');
  assert.doesNotMatch(html, /0%/);
  assert.match(text(chip({ tokens: null, percent: null, window: 200000 })), /ctx —$/);
});
test('chip: three tones, below 70, from 70 and from 90, each with an icon and words in the help', () => {
  const at = (p) => chip({ tokens: p * 10, percent: p, window: 1000 });
  assert.doesNotMatch(at(69), /mem-warn|mem-bad/);
  assert.match(at(70), /mem-warn/);
  assert.match(at(89), /mem-warn/);
  assert.match(at(90), /mem-bad/);
  assert.match(at(100), /mem-bad/);
  const icons = [at(10), at(75), at(95)].map((h) => /<i [^>]*aria-hidden="true">([^<]+)<\/i>/.exec(h)[1]);
  assert.equal(new Set(icons).size, 3, 'a different icon per tone, so colour is never alone');
  assert.match(titleOf(at(75)), /^Context used by this session: .* \(.*getting full.*\)$/);
  assert.match(titleOf(at(95)), /^Context used by this session: .* \(.*almost full.*\)$/);
  assert.match(text(at(75)), /ctx 75%$/);
});
test('chip: nothing when the session is closed or starting, has no record or no reading; garbage is never drawn', () => {
  const ok = { tokens: 1, percent: 5, window: 10 };
  assert.equal(chip(ok, 'closed'), '');
  assert.equal(chip(ok, 'starting'), '');
  for (const c of [null, undefined, {}, { rpc: null }, { rpc: {} }, { rpc: { state: 'idle' } }, { rpc: { state: 'idle', ctx: null } }, { rpc: { state: 'idle', ctx: 'x' } }]) assert.equal(R.ctxChipHtml(c), '', JSON.stringify(c));
  for (const ctx of [{ percent: '<img src=x>', tokens: 1, window: 2 }, { percent: NaN, tokens: 1, window: 2 }, { percent: {}, tokens: [], window: 2 }]) {
    const html = chip(ctx);
    assert.doesNotMatch(html, /<img|NaN|undefined|\[object/, JSON.stringify(ctx));
  }
});
test('chip: the percent is rounded and clamped, and what is drawn is escaped', () => {
  assert.match(text(chip({ tokens: 1, percent: 61.6, window: 10 })), /ctx 62%$/);
  assert.match(text(chip({ tokens: 1, percent: 500, window: 10 })), /ctx 100%$/);
  assert.match(titleOf(chip({ tokens: 1500, percent: 1, window: 1000000 })), /2k of 1000k tokens|1k of 1000k tokens/);
});

test('reducer: a run that ends and a compaction that ends ask for a new reading; nothing else does', () => {
  const ev = (record) => V.rpcReduce({ state: 'idle' }, { kind: 'event', record }, 1).ctx;
  assert.equal(ev({ type: 'agent_end' }), true);
  assert.equal(ev({ type: 'agent_settled' }), true);
  assert.equal(ev({ type: 'compaction_end', reason: 'manual' }), true);
  for (const type of ['agent_start', 'compaction_start', 'message_update', 'turn_end', 'auto_retry_start']) assert.equal(ev({ type }), false, type);
  assert.equal(V.rpcReduce({ state: 'idle' }, { kind: 'state', state: 'idle' }, 1).ctx, false);
});
test('record: the context is three validated numbers, reset when the session closes', () => {
  const e = V.rpcWithContext({ state: 'idle' }, { tokens: 5, percent: 250, window: 100, text: 'SECRET', x: { a: 1 } });
  assert.deepEqual(e.ctx, { tokens: 5, percent: 100, window: 100 });
  assert.deepEqual(V.rpcWithContext({ state: 'idle' }, { tokens: -1, percent: 'a', window: 0 }).ctx, NONE);
  assert.deepEqual(V.rpcWithContext({ state: 'idle' }, null).ctx, NONE);
  assert.equal(V.rpcFromStatus({ state: 'idle', ctx: e.ctx }, { state: 'closed', pendingDialogs: [] }).ctx, null);
  assert.equal(V.rpcReduce({ state: 'idle', ctx: e.ctx }, { kind: 'exit' }, 1).entry.ctx, null);
  assert.deepEqual(V.rpcFromStatus({ state: 'idle', ctx: e.ctx }, { state: 'idle', pendingDialogs: [] }).ctx, e.ctx);
});

// ---------- the real page, in a vm ----------
function element(extra = {}) {
  const el = {
    html: '', hidden: false, dataset: {}, disabled: false, value: '', checked: false, textContent: '', title: '', placeholder: '', attrs: {}, listeners: {}, children: [], open: false,
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    style: { setProperty(k, v) { el.style[k] = v; } },
    addEventListener(t, fn) { (el.listeners[t] ||= []).push(fn); }, setAttribute(k, v) { el.attrs[k] = v; }, querySelector: () => null, querySelectorAll: () => [], closest: () => null,
    showModal() {}, close() {}, focus() {}, append(c) { el.children.push(c); },
    get innerHTML() { return el.html; }, set innerHTML(v) { el.html = String(v); }, ...extra,
  };
  return el;
}
// `answers`: url prefix -> value or function(url) returning a value or a promise. Every request is recorded in `calls`; timers are collected, never run by themselves.
function loadPage(answers) {
  const els = {};
  const frames = [];
  const calls = [];
  const timers = [];
  const tabEls = ['summary', 'work', 'conformity', 'settings'].map((t) => element({ dataset: { tab: t } }));
  const get = (sel) => (els[sel] ||= (sel === 'meta[name=token]' ? element({ content: 'token' }) : element()));
  const doc = { hidden: false, querySelector: get, querySelectorAll: (s) => (String(s).includes('data-tab') ? tabEls : []), addEventListener() {}, createElement: () => element(), body: element(), activeElement: null };
  const store = {};
  const ctx = vm.createContext({
    console, document: doc, location: { hash: '' }, TextDecoder, AbortController, confirm: () => true,
    localStorage: { getItem: (k) => (k in store ? store[k] : null), setItem(k, v) { store[k] = String(v); }, removeItem(k) { delete store[k]; } },
    requestAnimationFrame: (cb) => { frames.push(cb); return frames.length; }, setInterval: (fn) => { timers.push(fn); return timers.length; }, setTimeout: (fn) => { timers.push(fn); return timers.length; }, clearTimeout: () => {}, clearInterval: () => {},
    fetch: (url) => {
      calls.push(url);
      const a = Object.entries(answers).find(([k]) => url.startsWith(k));
      if (!a) return new Promise(() => {});
      const v = typeof a[1] === 'function' ? a[1](url) : a[1];
      return Promise.resolve(v).then((json) => ({ ok: true, json: async () => json }));
    },
  });
  ctx.window = ctx;
  ctx.addEventListener = () => {};
  ctx.RepoPanelView = V;
  ctx.RepoPanelResumen = R;
  vm.runInContext(appSource(), ctx);
  const flush = () => { while (frames.length) frames.shift()(); };
  const tick = async (n = 8) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); flush(); };
  return { get, tick, calls, timers, run: (code) => vm.runInContext(code, ctx), ctxCalls: () => calls.filter((u) => u.startsWith('/api/rpc/context')) };
}
const ID2 = 'abcdefghij';
const ADOPTED = { key: ID, adopted: { id: 's1', name: 'demo', adoptedAt: 'x' }, adoptedFound: true, sessions: [], live: { state: 'none', count: 0 } };
const STATUS = (state) => ({ state, pendingDialogs: [], sessionId: 's1' });
async function chatPage({ state = 'idle', context = { tokens: 124000, percent: 62, window: 200000 } } = {}) {
  const page = loadPage({
    '/api/events': () => new Promise(() => {}), '/api/rpc/status': STATUS(state), '/api/rpc/context': context, '/api/sessions': ADOPTED,
    '/api/chat': { key: ID, sessionId: 's1', found: true, items: [], truncated: false, updatedAt: null },
  });
  const st = page.run('S');
  st.groups = [{ name: 'G', repos: [{ id: ID, name: 'demo', path: 'p' }, { id: ID2, name: 'other', path: 'q' }] }];
  st.summary = { rows: [], generatedAt: 'x' };
  page.open = async (id = ID) => { page.run(`ACTIONS['chat-open']({ dataset: { id: '${id}' } })`); await page.tick(); };
  page.rpc = async (id, kind, record) => { page.run(`applyRpc(${JSON.stringify({ id, kind, ...(record ? { record } : {}) })})`); await page.tick(); };
  return page;
}

test('page (real): opening a chat asks once and draws ctx 62% next to the state of the session', async () => {
  const page = await chatPage();
  await page.open();
  assert.equal(page.ctxCalls().length, 1);
  assert.equal(page.ctxCalls()[0], `/api/rpc/context?id=${ID}`);
  const html = page.get('#sessState').html;
  assert.match(html, /class="ss /);
  assert.match(html, /ctx 62%/);
  assert.match(html, /title="Context used by this session: 124k of 200k tokens"/);
});
test('page (real): a closed session asks nothing and draws nothing', async () => {
  const page = await chatPage({ state: 'closed' });
  await page.open();
  assert.equal(page.ctxCalls().length, 0);
  assert.doesNotMatch(page.get('#sessState').html, /ctx/);
});
test('page (real): unknown after a compaction reads ctx — and is never 0', async () => {
  const page = await chatPage({ context: { tokens: null, percent: null, window: null } });
  await page.open();
  assert.match(page.get('#sessState').html, /ctx —/);
  assert.doesNotMatch(page.get('#sessState').html, /ctx 0/);
});
test('page (real): it asks again after agent_end, agent_settled and compaction_end, and for nothing else', async () => {
  const page = await chatPage();
  await page.open();
  const base = page.ctxCalls().length;
  const record = (type, extra) => page.rpc(ID, 'event', { type, ...extra });
  await record('agent_start');
  await record('message_update');
  await record('compaction_start', { reason: 'threshold' });
  await record('turn_end');
  assert.equal(page.ctxCalls().length, base, 'nothing is asked while it works or while a compaction starts');
  await record('agent_end');
  assert.equal(page.ctxCalls().length, base + 1);
  await record('agent_settled');
  assert.equal(page.ctxCalls().length, base + 2);
  await record('compaction_end', { reason: 'threshold' });
  assert.equal(page.ctxCalls().length, base + 3);
});
test('page (real): the state alone and a timer never ask', async () => {
  const page = await chatPage();
  await page.open();
  const base = page.ctxCalls().length;
  page.run(`applyRpc({ id: '${ID}', kind: 'state', state: 'busy' })`);
  await page.tick();
  for (const fn of page.timers.splice(0)) { try { fn(); } catch { /* a timer of the page */ } }
  await page.tick();
  assert.equal(page.ctxCalls().length, base);
  assert.doesNotMatch(fs.readFileSync(path.join(__dirname, '..', 'public', 'feed.js'), 'utf8').split('\n').filter((l) => /loadContext/.test(l)).join('\n'), /setInterval|setTimeout/);
});
test('page (real): a run that ends in a repo that is not open asks nothing; a session that is closing or starting is not asked', async () => {
  const page = await chatPage();
  await page.open();
  const base = page.ctxCalls().length;
  await page.rpc(ID2, 'event', { type: 'agent_settled' });
  await page.rpc(ID, 'exit');
  await page.rpc(ID, 'event', { type: 'compaction_end', reason: 'manual' });
  assert.equal(page.ctxCalls().length, base, 'closed after an exit');
  assert.doesNotMatch(page.get('#sessState').html, /ctx/);
  page.run(`S.rpc['${ID}'] = { ...S.rpc['${ID}'], state: 'starting' }; loadContext('${ID}')`);
  await page.tick();
  assert.equal(page.ctxCalls().length, base, 'starting');
});
test('page (real): a late answer for a repo the person already left is never painted over another repo', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const page = await chatPage({ context: (url) => (url.endsWith(ID) ? gate : { tokens: 11, percent: 11, window: 100 }) });
  page.run('S').groups = [{ name: 'G', repos: [{ id: ID, name: 'demo', path: 'p' }, { id: ID2, name: 'other', path: 'q' }] }];
  await page.open(ID);
  assert.equal(page.ctxCalls().length, 1, 'the read of the first repo is waiting');
  page.run('closeChat()');
  await page.open(ID2);
  release({ tokens: 10, percent: 99, window: 100 });
  await page.tick();
  assert.doesNotMatch(page.get('#sessState').html, /ctx 99%/);
  assert.match(page.get('#sessState').html, /ctx 11%/, 'the open repo shows its own reading');
  assert.equal(page.run(`S.rpc['${ID}'] && S.rpc['${ID}'].ctx`) || null, null, 'the repo that was left keeps no reading either');
});
test('page (real): a failed read draws ctx — instead of an old number', async () => {
  const page = await chatPage({ context: () => Promise.reject(new Error('down')) });
  await page.open();
  assert.match(page.get('#sessState').html, /ctx —/);
});

// ---------- wording and the closing of the unit ----------
test('wording: the files of this unit never show pi session, pi screen or Gentle Shell as visible text', () => {
  for (const f of ['public/resumen.js', 'public/view.js', 'public/feed.js']) {
    const src = fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
    for (const line of src.split('\n').filter((l) => /RP139|ctxChip|Context used|Context usage/.test(l))) assert.doesNotMatch(line, /pi session|pi screen|Gentle Shell/i, f);
  }
});
test('README describes the meter', () => {
  const readme = fs.readFileSync(path.join(__dirname, '..', 'README.md'), 'utf8');
  assert.match(readme, /ctx 62%/);
});
