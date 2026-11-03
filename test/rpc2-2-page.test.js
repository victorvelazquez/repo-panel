'use strict';
// RPC2-2 (S1, S6, S8), the page: the /flow-* buttons, put-in-conditions and fix-pr start the session first when it is closed and then post /api/pi,
// the buttons follow S.rpc (idle free, busy working, asking waiting, closed enabled), and the verdict runs from the `rpc` state events with no poll.
// The real public/app.js in a vm (fake fetch, a fake event stream, no timers, no network, no pi).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const R = require('../public/resumen.js');
const V = require('../public/view.js');

const PUBLIC = path.join(__dirname, '..', 'public');
const ID = '0123456789';

function element(extra = {}) {
  const el = {
    html: '', hidden: false, dataset: {}, disabled: false, value: '', checked: false, textContent: '', title: '', placeholder: '', attrs: {}, listeners: {}, children: [], open: false,
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    style: { setProperty(k, v) { el.style[k] = v; } },
    addEventListener(t, fn) { (el.listeners[t] ||= []).push(fn); }, setAttribute(k, v) { el.attrs[k] = v; }, querySelector: () => null, querySelectorAll: () => [], closest: () => null,
    showModal() {}, close() {}, focus() {}, append(c) { el.children.push(c); },
    get innerHTML() { return el.html; },
    set innerHTML(v) { el.html = String(v); },
    ...extra,
  };
  return el;
}

// A stream the test feeds by hand: `push(text)` is read by the page as the next chunk of GET /api/events.
function eventStream() {
  const queue = [];
  let wake = null;
  const enc = new TextEncoder();
  return {
    opened: 0,
    push(text) { queue.push(enc.encode(text)); if (wake) { wake(); wake = null; } },
    response() {
      this.opened++;
      const read = async () => { while (!queue.length) await new Promise((r) => { wake = r; }); return { done: false, value: queue.shift() }; };
      return Promise.resolve({ ok: true, body: { getReader: () => ({ read }) } });
    },
  };
}

function loadPage(answers) {
  const els = {};
  const frames = [];
  const fetches = [];
  const tabEls = ['summary', 'work', 'conformity'].map((t) => element({ dataset: { tab: t } }));
  const get = (sel) => (els[sel] ||= (sel === 'meta[name=token]' ? element({ content: 'token' }) : element()));
  const doc = { hidden: false, querySelector: get, querySelectorAll: (s) => (String(s).includes('data-tab') ? tabEls : []), addEventListener() {}, createElement: () => element(), body: element(), activeElement: null };
  const store = {};
  const ctx = vm.createContext({
    console, document: doc, location: { hash: '' }, TextDecoder, AbortController, confirm: () => true,
    localStorage: { getItem: (k) => (k in store ? store[k] : null), setItem(k, v) { store[k] = String(v); }, removeItem(k) { delete store[k]; } },
    requestAnimationFrame: (cb) => { frames.push(cb); return frames.length; }, setInterval: () => 0, setTimeout: () => 0, clearTimeout: () => {},
    fetch: (url, opts = {}) => {
      fetches.push({ url, method: opts.method || 'GET', body: opts.body });
      const a = Object.entries(answers).find(([k]) => url.startsWith(k));
      if (!a) return new Promise(() => {});
      return typeof a[1] === 'function' ? a[1](url, opts) : Promise.resolve({ ok: true, json: async () => a[1] });
    },
  });
  ctx.window = ctx;
  ctx.addEventListener = () => {};
  ctx.RepoPanelView = V;
  ctx.RepoPanelResumen = R;
  vm.runInContext(fs.readFileSync(path.join(PUBLIC, 'app.js'), 'utf8'), ctx);
  const flush = () => { while (frames.length) frames.shift()(); };
  const tick = async (n = 8) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); flush(); };
  return { get, fetches, tick, run: (code) => vm.runInContext(code, ctx), flush };
}


const fail = (status, body) => Promise.resolve({ ok: false, status, statusText: 'Failed', json: async () => body });
const status = (state, pendingDialogs = []) => ({ state, pendingDialogs, sessionId: 's1' });
const LOCAL = { branch: 'task', detached: false, upstream: 'origin/task', noUpstream: false, ahead: 0, behind: 0, files: [{ path: 'a.txt', status: 'M', untracked: false }], head: 'h1', inProgress: null, base: 'main', stagedCount: 0 };
const CLEAN = { ...LOCAL, files: [], ahead: 1, head: 'h2' };

// `rpcState` is what the first GET /api/rpc/status answers; the repo is dirty, so the commit button is the one under test.
async function pagePlus(extra = {}, rpcState = 'closed') {
  const stream = eventStream();
  const answers = {
    '/api/events': () => stream.response(),
    '/api/rpc/status': status(rpcState), '/api/rpc/start': status('idle'),
    '/api/pi-status': { state: 'idle' }, '/api/pi': { sent: true, confirmed: true },
    '/api/local': LOCAL, '/api/prs': { prs: [], stale: null }, '/api/roadmap': {}, '/api/requirements': { available: false, results: [] }, '/api/state': { available: false },
    '/api/sessions': { key: ID, adopted: null, adoptedFound: false, sessions: [], live: { state: 'none', count: 0 } }, '/api/chat': { key: ID, sessionId: null, found: false, items: [], truncated: false, updatedAt: null },
    ...extra,
  };
  const page = loadPage(answers);
  const S = page.run('S');
  S.groups = [{ name: 'G', repos: [{ id: ID, name: 'demo', path: 'p' }] }];
  S.summary = { rows: [], generatedAt: 'x' };
  S.local[ID] = LOCAL;
  page.run("ACTIONS['chat-open']({ dataset: { id: '" + ID + "' } })");
  page.run('startEvents()');
  await page.tick();
  return { page, S, stream };
}
const urls = (page, prefix, method) => page.fetches.filter((f) => f.url.startsWith(prefix) && (!method || f.method === method));
const posts = (page, from = 0) => page.fetches.slice(from).filter((f) => f.method === 'POST').map((f) => [f.url, JSON.parse(f.body)]);
const click = async (page, cmd, extra = {}) => {
  await page.run("ACTIONS['pi']")({ dataset: { id: ID, cmd, ...extra }, disabled: false });
  await page.tick();
};
const putInConditions = async (page) => { await page.run("ACTIONS['put-in-conditions']")({ dataset: { id: ID } }); await page.tick(); };
const setRpc = (page, state) => page.run(`S.rpc['${ID}'] = { ...V.rpcFromStatus(undefined, null), state: '${state}' }`);
const buttons = (page) => page.run(`flowFor({ id: '${ID}' }, S.local['${ID}'], { prs: [], stale: null }, null)`);
const toasts = (page) => page.get('#toasts').children.map((c) => c.textContent);
const frame = (payload) => `event: rpc\ndata: ${JSON.stringify({ id: ID, ...payload })}\n\n`;
const feed = async (page, stream, ...payloads) => { for (const p of payloads) stream.push(frame(p)); await page.tick(); };

test('g1: sessionOf comes from S.rpc: idle free, busy and starting working, asking waiting, closed as closed', async () => {
  const { page } = await pagePlus();
  for (const [state, want] of [['idle', 'idle'], ['busy', 'busy'], ['starting', 'busy'], ['asking', 'asking'], ['closed', 'closed']]) {
    setRpc(page, state);
    assert.equal(page.run(`sessionOf('${ID}')`), want, state);
  }
});

test('g2: the commit button is enabled with an idle or a closed session and disabled, with a reason, while busy or asking', async () => {
  const { page } = await pagePlus();
  for (const [state, disabled] of [['idle', false], ['closed', false], ['busy', true], ['starting', true], ['asking', true]]) {
    setRpc(page, state);
    const [b] = buttons(page);
    assert.equal(b.cmd, 'flow-commit', state);
    assert.equal(!!b.disabled, disabled, state);
    if (disabled) assert.match(b.reason, /session|answer/, state);
  }
});

test('g3: with S.rpc unknown the old checking window is kept, then the live answer rules', async () => {
  const { page } = await pagePlus();
  page.run(`delete S.rpc['${ID}']; S.dirtyAt['${ID}'] = Date.now(); delete S.liveAnswered['${ID}']`);
  assert.equal(page.run(`sessionOf('${ID}')`), 'checking');
  page.run(`S.liveAnswered['${ID}'] = true; S.live['${ID}'] = 'busy'`);
  assert.equal(page.run(`sessionOf('${ID}')`), 'busy');
});

test('g4: S.rpc takes precedence over the live (Orca) state of the warmer', async () => {
  const { page } = await pagePlus({}, 'idle');
  page.run(`S.liveAnswered['${ID}'] = true; S.live['${ID}'] = 'busy'`);
  assert.equal(page.run(`sessionOf('${ID}')`), 'idle');
  assert.equal(!!buttons(page)[0].disabled, false);
});

test('g5: a click with the session closed starts it FIRST, then posts /api/pi with the same body as before', async () => {
  const { page, S } = await pagePlus({}, 'closed');
  const before = page.fetches.length;
  await click(page, 'flow-commit');
  assert.deepEqual(posts(page, before), [['/api/rpc/start', { id: ID }], ['/api/pi', { id: ID, command: 'flow-commit' }]]);
  assert.equal(S.rpc[ID].state, 'idle');
  assert.equal(S.sent[ID].cmd, 'flow-commit');
});

test('g6: a click with an idle session posts /api/pi and never starts anything', async () => {
  const { page, S } = await pagePlus({}, 'idle');
  const before = page.fetches.length;
  await click(page, 'flow-pr');
  assert.deepEqual(posts(page, before), [['/api/pi', { id: ID, command: 'flow-pr' }]]);
  assert.equal(S.sent[ID].cmd, 'flow-pr');
});

test('g7: fix-pr and put-in-conditions go through the same start-first flow, and fix-pr keeps its pr', async () => {
  const { page } = await pagePlus({}, 'closed');
  const before = page.fetches.length;
  await click(page, 'fix-pr', { pr: '7' });
  setRpc(page, 'closed');
  await putInConditions(page);
  assert.deepEqual(posts(page, before), [
    ['/api/rpc/start', { id: ID }], ['/api/pi', { id: ID, command: 'fix-pr', pr: 7 }],
    ['/api/rpc/start', { id: ID }], ['/api/pi', { id: ID, command: 'put-in-conditions' }],
  ]);
});

test('g8: when the session cannot start nothing is sent, the server message is shown and the card is not marked as sent', async () => {
  const { page, S } = await pagePlus({ '/api/rpc/start': () => fail(502, { error: 'The session could not be started' }) }, 'closed');
  const before = page.fetches.length;
  await click(page, 'flow-commit');
  assert.deepEqual(posts(page, before), [['/api/rpc/start', { id: ID }]]);
  assert.ok(toasts(page).includes('The session could not be started'), toasts(page).join('|'));
  assert.equal(S.sent[ID], undefined);
  assert.equal(S.rpc[ID].state, 'closed');
  assert.equal(S.sending[ID], undefined);
  await putInConditions(page);
  assert.equal(urls(page, '/api/pi', 'POST').length, 0);
});

test('g9: the verdict follows the rpc state events with no poll: busy is running, idle after busy is judged', async () => {
  const { page, S, stream } = await pagePlus({}, 'idle');
  await click(page, 'flow-commit');
  assert.equal(S.sent[ID].cmd, 'flow-commit');
  await page.tick();
  const polls = () => urls(page, '/api/pi-status').length;
  const base = polls();
  await feed(page, stream, { kind: 'state', state: 'busy' });
  assert.equal(S.pistatus[ID], 'busy');
  assert.equal(page.run(`verdictOf({ id: '${ID}' })`).state, 'running');
  assert.equal(S.sent[ID].busySeen, true);
  await feed(page, stream, { kind: 'state', state: 'idle' });
  await page.tick(12);
  assert.equal(S.pistatus[ID], 'idle');
  assert.equal(polls(), base, 'no /api/pi-status request: it came from the events');
});

test('g10: an asking state event shows the waiting verdict and an exit event reads as closed, still with no poll', async () => {
  const { page, S, stream } = await pagePlus({}, 'idle');
  await click(page, 'flow-commit');
  await page.tick();
  const base = urls(page, '/api/pi-status').length;
  await feed(page, stream, { kind: 'state', state: 'busy' }, { kind: 'state', state: 'asking' });
  assert.equal(S.pistatus[ID], 'asking');
  assert.equal(page.run(`verdictOf({ id: '${ID}' })`).asking, true);
  await feed(page, stream, { kind: 'exit' });
  assert.equal(S.pistatus[ID], 'closed');
  assert.equal(urls(page, '/api/pi-status').length, base);
});

test('g11: state events of a repo with no command sent change nothing but S.rpc', async () => {
  const { page, S, stream } = await pagePlus({}, 'idle');
  await feed(page, stream, { kind: 'state', state: 'busy' }, { kind: 'state', state: 'idle' });
  assert.equal(S.rpc[ID].state, 'idle');
  assert.equal(S.sent[ID], undefined);
  assert.equal(S.pistatus[ID], undefined);
});

test('g12: the chat Send and the flow buttons share one start helper (the explicit Start button keeps its own call)', () => {
  const app = fs.readFileSync(path.join(PUBLIC, 'app.js'), 'utf8');
  assert.match(app, /async function ensureRpcStarted\(/);
  assert.equal((app.match(/await ensureRpcStarted\(/g) || []).length, 3, 'chat Send, flow button, put-in-conditions');
  assert.equal((app.match(/api\('\/api\/rpc\/start'/g) || []).length, 2, 'the helper and the Start button');
});
