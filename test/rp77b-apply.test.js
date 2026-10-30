'use strict';
// RP77b (S68, S71, S72) probes for the page wiring in the real public/app.js (vm with a stubbed DOM, like rp32-page): applyLive never touches a repo
// with a command in flight, keeps the answer rules of loadChat, only feeds repos the view polls; pollSkipped / stopEvents / the visibility handler.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const view = require('../public/view.js');

const stub = () => new Proxy(function stubElement() {}, {
  get: (t, k) => (k === 'content' ? 'token' : k === 'dataset' ? {} : k === 'classList' ? { add() {}, remove() {}, toggle() {} } : k === Symbol.toPrimitive ? () => '' : stub),
  set: () => true,
  apply: () => stub(),
});

// `fetchImpl(url, opts)` answers /api/events only; every other request is "offline".
async function loadPage({ fetchImpl } = {}) {
  const calls = [];
  const state = { hidden: false };
  const listeners = {};
  const timeouts = [];
  const ctx = vm.createContext({
    console,
    document: new Proxy({}, {
      get: (t, k) => (k === 'hidden' ? state.hidden : k === 'querySelector' ? (sel) => (sel === '#app' ? { innerHTML: '' } : stub())
        : k === 'addEventListener' ? (type, fn) => { (listeners[type] = listeners[type] || []).push(fn); } : stub),
    }),
    localStorage: { getItem: () => null, setItem() {} },
    location: { hash: '' },
    requestAnimationFrame: () => 1,
    setInterval: () => 0,
    setTimeout: (fn, ms) => { timeouts.push({ fn, ms }); return timeouts.length; }, clearTimeout: () => {}, AbortController, TextDecoder,
    confirm: () => true,
    fetch: async (url, opts) => { calls.push({ url, opts }); if (!fetchImpl || url !== '/api/events') throw new Error('offline'); return fetchImpl(url, opts); },
  });
  ctx.window = ctx;
  ctx.RepoPanelView = view;
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8').replace(/\r\n/g, '\n'), ctx);
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
  return { get: (n) => vm.runInContext(n, ctx), calls, state, listeners, timeouts };
}
const flush = async () => { for (let i = 0; i < 8; i++) await new Promise((r) => setImmediate(r)); };

const R = { id: '0123456789', name: 'demo', path: 'x', group: 'g' };
const file = { path: 'a.txt', status: 'M', untracked: false };
const dirty = { branch: 't', detached: false, upstream: 'origin/t', noUpstream: false, ahead: 0, behind: 0, files: [file], added: 1, deleted: 0, head: 'h', inProgress: null, base: 'main', stagedCount: 0, stagedPaths: [] };
const ASK = { state: 'waiting', count: 1, dialog: { lines: ['ok?'], selected: 0, choices: { fingerprint: 'f1', complete: true, options: [{ label: 'Yes', tone: 'affirmative' }] } } };
const NONE = { state: 'none', count: 0 };

function setup(page) {
  const S = page.get('S');
  S.groups = [{ name: 'g', repos: [R] }];
  S.local[R.id] = dirty;
  S.prs[R.id] = { prs: [], stale: null, repo: { url: 'https://github.com/o/demo' } };
  S.chat = { id: R.id, seq: 1, info: { adopted: { id: 's' }, adoptedFound: true, live: ASK }, hist: null };
  S.chat.key = JSON.stringify([S.chat.info, S.chat.hist]);
  return S;
}
const applyLive = (page, live, state = 'idle') => page.get('applyLive')([{ id: R.id, state, live }]);

test('applyLive feeds S.live of a polled repo (control for the probes below)', async () => {
  const page = await loadPage();
  const S = setup(page);
  applyLive(page, NONE, 'busy');
  assert.equal(S.live[R.id], 'busy');
  assert.deepEqual(S.chat.info.live, NONE);
});

test('applyLive does nothing for a repo with a command in flight (S.sent): neither S.live nor the chat card', async () => {
  const page = await loadPage();
  const S = setup(page);
  S.live[R.id] = 'busy';
  S.sent[R.id] = { busySeen: false };
  applyLive(page, NONE, 'idle');
  assert.equal(S.live[R.id], 'busy');
  assert.deepEqual(S.chat.info.live, ASK, 'the question card is left to the poller of that repo');
  assert.deepEqual(JSON.parse(JSON.stringify(page.get('ev').last[R.id].live)), NONE, 'but the last word is remembered');
});

test('applyLive does not set S.live for a repo the view does not poll (clean tree), yet still updates its chat card', async () => {
  const page = await loadPage();
  const S = setup(page);
  S.local[R.id] = { ...dirty, files: [] };
  applyLive(page, NONE, 'busy');
  assert.equal(S.live[R.id], undefined);
  assert.equal(S.liveAnswered[R.id], undefined);
  assert.deepEqual(S.chat.info.live, NONE);
});

test('applyLive: an answered question is forgotten when the dialog goes away or changes, kept for the same fingerprint, and never while sending', async () => {
  for (const [answer, live, kept] of [
    [{ fp: 'f1', state: 'ok', text: 'Yes' }, NONE, false],
    [{ fp: 'f1', state: 'ok', text: 'Yes' }, { ...ASK, dialog: { ...ASK.dialog, choices: { ...ASK.dialog.choices, fingerprint: 'f2' } } }, false],
    [{ fp: 'f1', state: 'ok', text: 'Yes' }, { ...ASK, count: 1, dialog: { ...ASK.dialog, lines: ['ok? (again)'] } }, true],
    [{ fp: 'f1', state: 'sending' }, NONE, true],
  ]) {
    const page = await loadPage();
    const S = setup(page);
    S.answer[R.id] = answer;
    applyLive(page, live);
    assert.equal(!!S.answer[R.id], kept, JSON.stringify([answer, live.state]));
  }
});

test('pollSkipped: with the stream connected a poller that ran a moment ago is skipped; without it, never; stopEvents forgets the last words', async () => {
  const page = await loadPage();
  const ev = page.get('ev');
  ev.connected = true;
  ev.ran.live = Date.now();
  assert.equal(page.get('pollSkipped')('live'), true);
  ev.ran.live = Date.now() - 61000;
  assert.equal(page.get('pollSkipped')('live'), false, 'the safety net runs after 60 s');
  ev.ran.chat = Date.now() - 29000;
  assert.equal(page.get('pollSkipped')('chat'), true);
  ev.connected = false;
  ev.ran.live = Date.now();
  assert.equal(page.get('pollSkipped')('live'), false, 'not connected: the poller always runs');
  ev.last = { a: 1 };
  ev.connected = true;
  page.get('stopEvents')();
  assert.deepEqual(Object.keys(ev.last), []);
  assert.equal(ev.connected, false);
});

test('the tab going hidden closes the stream; coming back reopens it with the token header and a fresh backoff', async () => {
  const page = await loadPage({ fetchImpl: () => new Promise(() => {}) }); // an open stream that never answers
  const ev = page.get('ev');
  await flush();
  assert.ok(ev.ctl, 'opened at load');
  const open = page.calls.find((c) => c.url === '/api/events');
  assert.equal(open.opts.headers['x-token'], 'token');
  const ctl = ev.ctl;
  page.state.hidden = true;
  page.listeners.visibilitychange.forEach((f) => f());
  assert.equal(ctl.signal.aborted, true);
  assert.equal(ev.ctl, null);
  ev.attempt = 5;
  page.state.hidden = false;
  page.listeners.visibilitychange.forEach((f) => f());
  assert.equal(ev.attempt, 0);
  assert.ok(ev.ctl && ev.ctl !== ctl);
});

test('a stream that delivers bytes resets the backoff and marks the page connected; a refused stream retries with backoff and stays disconnected', async () => {
  const chunk = new TextEncoder().encode('retry: 3000\n\n');
  const page = await loadPage({ fetchImpl: () => { let sent = false; return { ok: true, body: { getReader: () => ({ read: async () => (sent ? new Promise(() => {}) : (sent = true, { done: false, value: chunk })) }) } }; } });
  const ev = page.get('ev');
  ev.attempt = 3;
  page.get('stopEvents')();
  page.get('startEvents')();
  await flush();
  assert.equal(ev.connected, true);
  assert.equal(ev.attempt, 0);
  const refused = await loadPage({ fetchImpl: () => ({ ok: false, status: 503 }) });
  await flush();
  assert.equal(refused.get('ev').connected, false);
  assert.ok(refused.timeouts.some((t) => t.ms === 1000), 'retry in 1 s, then 2 s…');
});
