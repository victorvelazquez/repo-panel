'use strict';
// RPC2b-1 (S1, S6, S8), the page: GET /api/rpc/states seeds S.rpc for EVERY repo on startup and on every (re)connect of the event stream (only `state` of an
// entry that already exists), sessionOf reads S.rpc only, the chat reason follows S.rpc, and a room shows no session state. The real public/app.js in a vm
// (fake fetch, a fake event stream, no timers, no network, no pi).
const test = require('node:test');
const { appSource } = require('./pagesrc.js');
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
  vm.runInContext(appSource(), ctx);
  const flush = () => { while (frames.length) frames.shift()(); };
  const tick = async (n = 8) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); flush(); };
  return { get, fetches, tick, run: (code) => vm.runInContext(code, ctx), flush };
}




const ID2 = 'abcdefghij';
const status = (state) => ({ state, pendingDialogs: [], sessionId: 's1' });
const LOCAL = { branch: 'task', detached: false, upstream: 'origin/task', noUpstream: false, ahead: 0, behind: 0, files: [{ path: 'a.txt', status: 'M', untracked: false }], head: 'h1', inProgress: null, base: 'main', stagedCount: 0 };
const NONE = { key: ID, adopted: null, adoptedFound: false, sessions: [], live: { state: 'none', count: 0 } };
const CONFIG = { snoozed: [], dismissed: [], rooms: [], roomIssues: [], groups: [{ name: 'G', repos: [{ id: ID, path: 'p', name: 'demo' }, { id: ID2, path: 'q', name: 'other' }] }] };
const states = (obj) => ({ states: obj });
const reply = (body) => Promise.resolve({ ok: true, json: async () => body });
const fail = (code) => Promise.resolve({ ok: false, status: code, statusText: 'Failed', json: async () => ({ error: 'x' }) });
const urls = (page, prefix) => page.fetches.filter((f) => f.url.startsWith(prefix));
const buttons = (page, id) => page.run(`flowFor({ id: '${id}' }, S.local['${id}'], { prs: [], stale: null }, null)`);

// `withStream: false` leaves /api/events unanswered, so the only read of the states is the one of the startup.
async function startPage({ answers = {}, withStream = true } = {}) {
  const stream = eventStream();
  const page = loadPage({
    ...(withStream ? { '/api/events': () => stream.response() } : {}),
    '/api/config': CONFIG, '/api/rpc/states': states({ [ID]: 'closed', [ID2]: 'busy' }), '/api/rpc/status': status('closed'),
    '/api/sessions': NONE, '/api/chat': { key: ID, sessionId: null, found: false, items: [], truncated: false, updatedAt: null },
    ...answers,
  });
  await page.tick();
  return { page, stream, S: page.run('S') };
}

test('a1: after the states read a repo with no session is closed and its button is enabled; a busy one is disabled', async () => {
  const { page, S } = await startPage();
  S.local[ID] = LOCAL;
  S.local[ID2] = LOCAL;
  assert.equal(S.rpc[ID].state, 'closed');
  assert.equal(page.run(`sessionOf('${ID}')`), 'closed');
  assert.equal(!!buttons(page, ID)[0].disabled, false);
  assert.equal(S.rpc[ID2].state, 'busy');
  assert.equal(page.run(`sessionOf('${ID2}')`), 'busy');
  const [b] = buttons(page, ID2);
  assert.equal(b.disabled, true);
  assert.match(b.reason, /session/);
});

test('a2: the states are read once on startup, with the stream not even open', async () => {
  const { page } = await startPage({ withStream: false });
  assert.equal(urls(page, '/api/rpc/states').length, 1);
});

test('a3: every (re)connect of the event stream reads the states again', async () => {
  const { page, stream } = await startPage();
  assert.equal(stream.opened, 1);
  const before = urls(page, '/api/rpc/states').length;
  page.run('stopEvents(); startEvents()');
  await page.tick();
  assert.equal(stream.opened, 2);
  assert.equal(urls(page, '/api/rpc/states').length, before + 1);
});

test('a4: the read never wipes an entry that exists: only its state changes, streaming text and questions stay', async () => {
  const { page, S } = await startPage({ answers: { '/api/rpc/states': states({ [ID]: 'busy', [ID2]: 'idle' }) } });
  const ask = { requestId: 'r1', method: 'confirm', title: 'Allow?' };
  S.rpc[ID] = { ...S.rpc[ID], state: 'asking', streaming: true, text: 'Streaming words', blocks: ['Streaming words'], asks: [ask], error: 'kept', startedAt: 7 };
  page.run('rpcSeed()');
  await page.tick();
  assert.equal(S.rpc[ID].state, 'busy');
  assert.deepEqual([S.rpc[ID].streaming, S.rpc[ID].text, S.rpc[ID].blocks, S.rpc[ID].asks, S.rpc[ID].error, S.rpc[ID].startedAt], [true, 'Streaming words', ['Streaming words'], [ask], 'kept', 7]);
  assert.equal(S.rpc[ID2].state, 'idle');
});

test('a5: a failed read keeps what the page knew, and a state it does not know is ignored', async () => {
  let answer = () => reply(states({ [ID]: 'asking', [ID2]: 'busy' }));
  const { page, S } = await startPage({ answers: { '/api/rpc/states': () => answer() } });
  assert.deepEqual([S.rpc[ID].state, S.rpc[ID2].state], ['asking', 'busy']);
  for (const next of [() => fail(500), () => Promise.reject(new Error('down')), () => reply({ nope: 1 }), () => reply(states({ [ID]: 'weird', [ID2]: 'idle' }))]) {
    answer = next;
    page.run('rpcSeed()');
    await page.tick();
    assert.equal(S.rpc[ID].state, 'asking');
  }
  assert.equal(S.rpc[ID2].state, 'idle', 'the valid entry of that last answer is taken');
});

test('a6: the actions of the open chat follow S.rpc (idle free; busy, starting, asking and closed not), whatever the live answer of Orca says', async () => {
  const sessions = (live) => ({ ...NONE, adopted: { id: 's1', name: 'n', adoptedAt: 'x' }, adoptedFound: true, live });
  for (const orcaSays of [{ state: 'free', count: 1 }, { state: 'none', count: 0 }]) {
    const { page, S } = await startPage({ answers: { '/api/sessions': sessions(orcaSays), '/api/rpc/states': states({ [ID]: 'idle', [ID2]: 'closed' }) } });
    S.summary = { rows: [{ id: ID, name: 'demo', error: null, next: { id: 'U1', entrega: 'x' }, action: { kind: 'start', label: 'x', pr: null }, session: { state: 'free' } }], generatedAt: 'x' };
    page.run("ACTIONS['chat-open']({ dataset: { id: '" + ID + "' } })");
    await page.tick();
    assert.equal(S.chat.info.live.state, orcaSays.state);
    const set = async (state) => { S.rpc[ID] = { ...S.rpc[ID], state }; page.run('draw()'); await page.tick(); return page.get('#chatActions').html; };
    assert.match(await set('idle'), /data-cmd="flow-next"/, 'idle: ' + orcaSays.state);
    for (const state of ['busy', 'starting', 'asking', 'closed']) assert.doesNotMatch(await set(state), /data-cmd/, state + ': ' + orcaSays.state);
  }
});

test('a7: an rpc state frame still moves S.rpc after the seed', async () => {
  const { page, stream, S } = await startPage();
  stream.push(`event: rpc\ndata: ${JSON.stringify({ id: ID, kind: 'state', state: 'asking' })}\n\n`);
  await page.tick();
  assert.equal(S.rpc[ID].state, 'asking');
});

test('a8: a room block has a gray dot and no session line, only the folder, the last commit and the members', async () => {
  const { page } = await startPage();
  const html = page.run("roomBlock({ name: 'UPEN', path: 'C:/dev/ceo', repos: [], available: true, base: 'main', results: [], summary: { ready: true }, lastCommit: '2026-10-23T18:30:00-05:00' })");
  assert.match(html, /<span class="dot dot-gray"><\/span> UPEN/);
  assert.match(html, /Last commit 2026-10-23/);
  assert.doesNotMatch(html, /Session:|session open|Orca|presence/i);
});
