'use strict';
// RP110b: the chat says whether the MEMORY (Engram) of a session is ready, offline, disabled or in error. The plugin tells it with a UI notice `setStatus("engram", text)`; the RPC client
// used to drop every notice. Now the client keeps ONLY the one of the key `engram`, the host reduces its text to ONE category of a closed list and remembers the last one per session, and
// the page draws a chip. The text of the notice (it can hold the name of the project or an error message) never leaves the server. Fake children and fake fetch only: no pi is started.
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { appSource } = require('./pagesrc.js');

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'rp110b-'));
process.env.REPO_PANEL_CONFIG = path.join(scratch, 'config.json');
test.after(() => fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 5 }));

const { createRpcClient } = require('../server/rpc.js');
const { createRpcHost, memoryOf, MEMORY } = require('../server/rpchost.js');
const V = require('../public/view.js');
const R = require('../public/resumen.js');

// ---------- the RPC client ----------
function fakeChild() {
  const c = new EventEmitter();
  c.pid = 4242;
  c.stdout = new EventEmitter();
  c.writes = [];
  c.stdin = Object.assign(new EventEmitter(), { write(s) { c.writes.push(s); return true; }, end() {} });
  c.kill = () => {};
  c.said = (obj) => c.stdout.emit('data', `${typeof obj === 'string' ? obj : JSON.stringify(obj)}\n`);
  c.sent = () => c.writes.join('').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  return c;
}
const until = async (fn, ms = 1000) => { const end = Date.now() + ms; while (Date.now() < end) { const v = fn(); if (v) return v; await new Promise((r) => setTimeout(r, 5)); } throw new Error('timed out waiting'); };
async function readyClient(t) {
  const child = fakeChild();
  const events = [];
  const spawn = (file) => (file === 'taskkill' ? new EventEmitter() : child);
  const client = createRpcClient({ command: 'C:\\x\\pi.exe', args: [], cwd: scratch, env: {}, spawn, platform: 'win32', onEvent: (e) => events.push(e), onExit: () => {} });
  t.after(() => client.close());
  const started = client.start();
  await until(() => child.sent().length >= 1);
  child.said({ id: child.sent()[0].id, type: 'response', command: 'get_state', success: true, data: { isStreaming: false } });
  await started;
  return { child, client, events };
}
const notice = (key, text, extra = {}) => ({ type: 'extension_ui_request', id: `u-${Math.random()}`, method: 'setStatus', statusKey: key, statusText: text, ...extra });

test('client: the notice of the key engram is kept as { kind: status, key, text }, cut to 200 characters', async (t) => {
  const { child, events } = await readyClient(t);
  child.said(notice('engram', '🧠 repo · ready'));
  child.said(notice('engram', 'x'.repeat(5000)));
  child.said(notice('engram', undefined));
  child.said(notice('engram', 42));
  const st = events.filter((e) => e.kind === 'status');
  assert.deepEqual(st.map((e) => [e.key, e.text.length]), [['engram', 15], ['engram', 200], ['engram', 0], ['engram', 0]]);
  assert.equal(st[0].text, '🧠 repo · ready');
});

test('client: every other notice is still dropped (another key, another method, a key that only looks like it), and none changes the state', async (t) => {
  const { child, client, events } = await readyClient(t);
  for (const k of ['x', 'Engram', 'ENGRAM', 'engram ', 'engram2', '__proto__', 'constructor', '', null, 7, ['engram']]) child.said(notice(k, 'text'));
  child.said({ type: 'extension_ui_request', id: 'w1', method: 'setWidget', widgetKey: 'engram', widgetLines: ['a'] });
  child.said({ type: 'extension_ui_request', id: 'n1', method: 'notify', message: 'engram', notifyType: 'info' });
  child.said({ type: 'extension_ui_request', id: 't1', method: 'setTitle', title: 'engram' });
  assert.equal(events.filter((e) => e.kind === 'status').length, 0);
  assert.equal(client.state(), 'idle');
  assert.deepEqual(client.pendingDialogs(), []);
});

test('client: a status notice is not a dialog and does not move the state (a record with the key engram and a dialog method is still only a dialog)', async (t) => {
  const { child, client, events } = await readyClient(t);
  child.said(notice('engram', '🧠 repo · offline'));
  assert.equal(client.state(), 'idle');
  assert.deepEqual(client.pendingDialogs(), []);
  child.said({ type: 'extension_ui_request', id: 'd1', method: 'confirm', title: 'T', message: 'M', statusKey: 'engram', statusText: 'sneaky' });
  assert.equal(events.filter((e) => e.kind === 'status').length, 1);
  assert.equal(client.pendingDialogs().length, 1);
});

// ---------- the classification ----------
test('memoryOf: the text of the plugin becomes ONE category of a closed list; a transient or unknown text is null (no change)', () => {
  assert.deepEqual(MEMORY, ['ready', 'offline', 'disabled', 'error']);
  const cases = [
    ['🧠 repo-panel · ready', 'ready'], ['🧠 x · offline', 'offline'], ['🧠 memory disabled', 'disabled'], ['🧠 x · error', 'error'], ['🧠 x · ambiguous project', 'error'],
    ['  🧠 x · ready  ', 'ready'], ['🧠 x · READY', 'ready'], ['🧠 memory disabled ', 'disabled'],
    ['🧠 x · saving…', null], ['🧠 x · searching memories…', null], ['🧠 x · saved 3 observations', null], ['', null], ['   ', null], ['ready', null], ['offline', null], ['🧠 x · ready for more', null],
    ['🧠 x · offline · ready', 'ready'], ['🧠 memory disabled · ready', 'ready'],
  ];
  for (const [text, want] of cases) assert.equal(memoryOf(text), want, JSON.stringify(text));
  for (const bad of [undefined, null, 5, {}, [], true]) assert.equal(memoryOf(bad), null);
  assert.equal(memoryOf(`🧠 ${'a'.repeat(1e5)} · ready`), 'ready');
});

// ---------- the host ----------
const ACTIVE = { id: 'gentle-shell', command: 'C:\\L\\gentle-shell.exe', agentDir: 'C:\\a' };
async function hostWith() {
  const made = [];
  const published = [];
  const createClient = (opts) => {
    const c = { opts, start: async () => ({}), request: async () => ({}), answerDialog: () => false, pendingDialogs: () => [], state: () => 'idle', close() {} };
    made.push(c);
    return c;
  };
  const host = createRpcHost({ resolve: async () => ({ active: ACTIVE }), repoOf: (id) => ({ id, path: 'C:\\repos\\alpha' }), publish: (id, p) => published.push(p), createClient, adoptedOf: () => null });
  const first = await host.start('aaa');
  return { host, published, made, first, emit: (e, n = made.length - 1) => made[n].opts.onEvent(e) };
}
const status = (text) => ({ kind: 'status', key: 'engram', text });

test('host: the status is published as { kind: memory, memory } and the text is NOT; a transient or unknown text publishes nothing', async () => {
  const { published, emit } = await hostWith();
  emit(status('🧠 SECRET-PROJECT · offline'));
  emit(status('🧠 SECRET-PROJECT · saving…'));
  emit(status('🧠 SECRET-PROJECT · saved 3 observations'));
  emit(status('🧠 SECRET-PROJECT · ready'));
  assert.deepEqual(published.filter((p) => p.kind === 'memory' || p.kind === 'status'), [{ kind: 'memory', memory: 'offline' }, { kind: 'memory', memory: 'ready' }]);
  assert.doesNotMatch(JSON.stringify(published), /SECRET|saving|saved/);
});

test('host: a category that has not changed is not published again', async () => {
  const { published, emit } = await hostWith();
  for (let i = 0; i < 4; i++) emit(status('🧠 x · ready'));
  emit(status('🧠 x · offline'));
  emit(status('🧠 x · offline'));
  assert.deepEqual(published.filter((p) => p.kind === 'memory').map((p) => p.memory), ['ready', 'offline']);
});

test('host: a raw status record never reaches the page, whatever its key', async () => {
  const { published, emit } = await hostWith();
  emit(status('SECRET'));
  emit({ kind: 'status', key: 'other', text: 'SECRET-OTHER' });
  emit({ kind: 'status', text: 'SECRET-NOKEY' });
  emit({ kind: 'memory', memory: 'SECRET-FORGED' });
  assert.doesNotMatch(JSON.stringify(published), /SECRET/);
  assert.equal(published.filter((p) => p.kind === 'status').length, 0);
});

test('host: the status of the session carries memory only once it is known, and a new session of the same repo starts without it', async () => {
  const { host, first, emit, made } = await hostWith();
  assert.equal('memory' in first, false, 'no notice yet: the shape is the old one');
  emit(status('🧠 memory disabled'));
  assert.equal((await host.start('aaa')).memory, 'disabled');
  assert.deepEqual(Object.keys(await host.start('aaa')).sort(), ['memory', 'pendingDialogs', 'sessionId', 'state']);
  await host.close('aaa');
  const again = await host.start('aaa');
  assert.equal('memory' in again, false);
  assert.equal(made.length, 2);
});

test('host: the notice of an OLD client does not set the memory of the new session', async () => {
  const { host, emit, made } = await hostWith();
  await host.close('aaa');
  await host.start('aaa');
  emit(status('🧠 x · ready'), 0);
  assert.equal('memory' in (await host.start('aaa')), false);
  emit(status('🧠 x · ready'), 1);
  assert.equal((await host.start('aaa')).memory, 'ready');
  assert.equal(made.length, 2);
});

// ---------- the page: reducer, status and chip ----------
const rec = (payload) => ({ kind: 'event', id: '0123456789', ...payload });

test('page: a memory frame sets the category of the entry; a value that is not on the list is ignored; an exit clears it', () => {
  let e = V.rpcReduce(null, { kind: 'memory', memory: 'offline' }).entry;
  assert.equal(e.memory, 'offline');
  for (const bad of ['SECRET', '', null, 7, ['ready'], { a: 1 }, 'READY', 'ready ']) e = V.rpcReduce(e, { kind: 'memory', memory: bad }).entry;
  assert.equal(e.memory, 'offline');
  e = V.rpcReduce(e, { kind: 'memory', memory: 'ready' }).entry;
  assert.equal(e.memory, 'ready');
  assert.equal(V.rpcReduce(e, { kind: 'exit' }).entry.memory, null);
  assert.equal(V.rpcReduce(null, { kind: 'state', state: 'idle' }).entry.memory, null);
  assert.equal(typeof rec, 'function');
});

test('page: the status of the session sets or keeps the category, and a closed session has none', () => {
  assert.equal(V.rpcFromStatus(null, { state: 'idle', pendingDialogs: [], memory: 'disabled' }).memory, 'disabled');
  assert.equal(V.rpcFromStatus({ memory: 'ready' }, { state: 'idle', pendingDialogs: [] }).memory, 'ready');
  assert.equal(V.rpcFromStatus({ memory: 'ready' }, { state: 'idle', pendingDialogs: [], memory: 'nonsense' }).memory, 'ready');
  assert.equal(V.rpcFromStatus({ memory: 'ready' }, { state: 'closed', pendingDialogs: [] }).memory, null);
});

test('page: the chip says the category in words, with a tone; nothing is drawn without a known category or when the session is closed', () => {
  const chip = (memory, state = 'idle') => R.memoryChipHtml({ rpc: { state, memory } });
  assert.match(chip('ready'), /^<span class="mem mem-ready" title="[^"]+">memory ready<\/span>$/);
  assert.match(chip('offline'), /class="mem mem-bad" title="[^"]+">memory offline</);
  assert.match(chip('error'), /class="mem mem-bad" title="[^"]+">memory error</);
  assert.match(chip('disabled'), /class="mem mem-warn" title="[^"]+">memory disabled</);
  for (const c of [{}, { rpc: null }, { rpc: {} }, { rpc: { memory: 'SECRET' } }, { rpc: { memory: '<img src=x>' } }, { rpc: { state: 'closed', memory: 'ready' } }, null, undefined]) {
    assert.equal(R.memoryChipHtml(c), '', JSON.stringify(c));
  }
  assert.doesNotMatch(chip('ready'), /undefined|NaN|\[object/);
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
function loadPage(answers) {
  const els = {};
  const frames = [];
  const tabEls = ['summary', 'work', 'conformity', 'settings'].map((t) => element({ dataset: { tab: t } }));
  const get = (sel) => (els[sel] ||= (sel === 'meta[name=token]' ? element({ content: 'token' }) : element()));
  const doc = { hidden: false, querySelector: get, querySelectorAll: (s) => (String(s).includes('data-tab') ? tabEls : []), addEventListener() {}, createElement: () => element(), body: element(), activeElement: null };
  const store = {};
  const ctx = vm.createContext({
    console, document: doc, location: { hash: '' }, TextDecoder, AbortController, confirm: () => true,
    localStorage: { getItem: (k) => (k in store ? store[k] : null), setItem(k, v) { store[k] = String(v); }, removeItem(k) { delete store[k]; } },
    requestAnimationFrame: (cb) => { frames.push(cb); return frames.length; }, setInterval: () => 0, setTimeout: () => 0, clearTimeout: () => {},
    fetch: (url) => { const a = Object.entries(answers).find(([k]) => url.startsWith(k)); return a ? Promise.resolve({ ok: true, json: async () => a[1] }) : new Promise(() => {}); },
  });
  ctx.window = ctx;
  ctx.addEventListener = () => {};
  ctx.RepoPanelView = V;
  ctx.RepoPanelResumen = R;
  vm.runInContext(appSource(), ctx);
  const flush = () => { while (frames.length) frames.shift()(); };
  const tick = async (n = 8) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); flush(); };
  return { get, tick, run: (code) => vm.runInContext(code, ctx) };
}
const ID = '0123456789';
const ADOPTED = { key: ID, adopted: { id: 's1', name: 'panel-demo', adoptedAt: 'x' }, adoptedFound: true, sessions: [], live: { state: 'none', count: 0 } };
async function chatPage(rpcStatus) {
  const page = loadPage({ '/api/events': () => new Promise(() => {}), '/api/rpc/status': rpcStatus, '/api/sessions': ADOPTED, '/api/chat': { key: ID, sessionId: 's1', found: true, items: [], truncated: false, updatedAt: null } });
  const st = page.run('S');
  st.groups = [{ name: 'G', repos: [{ id: ID, name: 'demo', path: 'p' }] }];
  st.summary = { rows: [], generatedAt: 'x' };
  page.run(`ACTIONS['chat-open']({ dataset: { id: '${ID}' } })`);
  await page.tick();
  return page;
}

test('page (real): opening a chat whose status says offline draws the chip next to the state of the session; with no memory in the status there is no chip', async () => {
  const bad = await chatPage({ state: 'idle', pendingDialogs: [], sessionId: 's1', memory: 'offline' });
  assert.match(bad.get('#sessState').html, /class="mem mem-bad"[^>]*>memory offline</);
  assert.match(bad.get('#sessState').html, /class="ss /);
  const none = await chatPage({ state: 'idle', pendingDialogs: [], sessionId: 's1' });
  assert.doesNotMatch(none.get('#sessState').html, /class="mem /);
  assert.match(none.get('#sessState').html, /class="ss /);
});
