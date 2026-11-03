'use strict';
// RP77b (S68, S71, S72) probes for the page wiring in the real public/app.js (vm with a stubbed DOM, like rp32-page): pollSkipped / stopEvents / the visibility handler.
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

test('pollSkipped: with the stream connected the chat poller that ran a moment ago is skipped; without it, never; stopEvents disconnects', async () => {
  const page = await loadPage();
  const ev = page.get('ev');
  ev.connected = true;
  ev.ran.chat = Date.now() - 29000;
  assert.equal(page.get('pollSkipped')('chat'), true);
  ev.connected = false;
  ev.ran.chat = Date.now();
  assert.equal(page.get('pollSkipped')('chat'), false, 'not connected: the poller always runs');
  ev.connected = true;
  page.get('stopEvents')();
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
