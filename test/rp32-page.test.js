'use strict';
// RP176: the /flow-commit button is now /flow-ship everywhere it is offered; each assertion here keeps holding, now for /flow-ship.
// RP32 A and C in the real public/app.js (vm with a stubbed DOM): the commit buttons follow the RPC session of the repo
// (S.rpc), and a command being sent disables the repo's flow buttons
// from the click until the answer, however often the card is redrawn.
const test = require('node:test');
const { appSource } = require('./pagesrc.js');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const view = require('../public/view.js');

const lf = (text) => text.replace(/\r\n/g, '\n');
const stub = () => new Proxy(function stubElement() {}, {
  get: (t, k) => (k === 'content' ? 'token' : k === 'dataset' ? {} : k === 'classList' ? { add() {}, remove() {}, toggle() {} } : k === Symbol.toPrimitive ? () => '' : stub),
  set: () => true,
  apply: () => stub(),
});

// `routes` maps a url (no query) to (body, url) => { status, json } or a promise of it. A missing route is "offline".
async function loadPage(extraRoutes = {}) {
  // RPC2-2: a click starts the session first (a session of unknown state counts as not started).
  const routes = { '/api/rpc/start': () => ({ json: { state: 'idle', pendingDialogs: [], sessionId: 's1' } }), ...extraRoutes };
  const app = { innerHTML: '' };
  const calls = [];
  const state = { hidden: false };
  const listeners = {};
  const ctx = vm.createContext({
    console,
    document: new Proxy({}, {
      get: (t, k) => (k === 'hidden' ? state.hidden : k === 'querySelector' ? (sel) => (sel === '#app' ? app : stub())
        : k === 'addEventListener' ? (type, fn) => { (listeners[type] = listeners[type] || []).push(fn); } : stub),
    }),
    localStorage: { getItem: () => null, setItem() {} },
    location: { hash: '' },
    requestAnimationFrame: () => 1,
    setInterval: () => 0,
    setTimeout: () => 0, clearTimeout: () => {}, AbortController,
    confirm: () => true,
    fetch: async (url, opts) => {
      calls.push({ url, method: (opts && opts.method) || 'GET' });
      const route = routes[url.split('?')[0]];
      if (!route) throw new Error('offline');
      const a = await route(opts && opts.body ? JSON.parse(opts.body) : null, url);
      return { ok: a.status === undefined || a.status < 400, status: a.status || 200, statusText: 'x', json: async () => a.json };
    },
  });
  ctx.window = ctx;
  ctx.RepoPanelView = view;
  vm.runInContext(lf(appSource()), ctx);
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
  calls.length = 0;
  return {
    get: (name) => vm.runInContext(name, ctx), app, calls, routes, state, listeners,
    urls: () => calls.map((c) => c.url),
    posts: () => calls.filter((c) => c.method === 'POST' && c.url === '/api/pi'),
  };
}

const flush = async () => { for (let i = 0; i < 8; i++) await new Promise((r) => setImmediate(r)); };
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };

const R = { id: 'abc', name: 'demo', path: 'x', group: 'g' };
const R2 = { id: 'def', name: 'other', path: 'y', group: 'g' };
const file = { path: 'a.txt', status: 'M', untracked: false };
const local = (o = {}) => ({ branch: 'task', detached: false, upstream: 'origin/task', noUpstream: false, ahead: 0, behind: 0, files: [file], added: 3, deleted: 0, head: 'h1', inProgress: null, base: 'main', stagedCount: 0, stagedPaths: [], ...o });
const STATUS = (id) => `/api/pi-status?id=${id}`;

function setup(page, repos = [R], l = local()) {
  const S = page.get('S');
  S.groups = [{ name: 'g', repos }];
  for (const r of repos) {
    S.local[r.id] = l;
    S.prs[r.id] = { prs: [], stale: null, repo: { url: 'https://github.com/o/demo' } };
  }
  return S;
}
const rendered = (page) => { page.get('render')(); return page.app.innerHTML; };
const btn = (html, id, cmd) => new RegExp(`<button data-act="pi" data-id="${id}" data-cmd="${cmd}"[^>]*>`).exec(html)[0];
const el = (id, cmd, pr) => ({ dataset: { id, cmd, ...(pr ? { pr } : {}) }, disabled: false });

// ---------- A ----------
test('A: a repo first seen dirty asks no pi-status, and the commit button follows S.rpc only (RPC2b-1)', async () => {
  const status = deferred();
  const page = await loadPage({
    '/api/local': () => ({ json: local() }),
    '/api/pi-status': () => status.promise.then((json) => ({ json })),
  });
  const S = setup(page, [R], local());
  delete S.local[R.id];
  page.get('loadLocal')(R.id);
  await flush();
  assert.equal(page.urls().includes(STATUS(R.id)), false, 'no session state is asked for');
  assert.doesNotMatch(btn(rendered(page), R.id, 'flow-ship'), /disabled/);
  S.rpc[R.id] = { state: 'busy' };
  assert.match(btn(rendered(page), R.id, 'flow-ship'), /title="the session is still working" disabled>/);
});

test('A: there is no checking hold any more, and a clean repo is never checked', async () => {
  const never = deferred();
  const page = await loadPage({ '/api/local': () => ({ json: local() }), '/api/pi-status': () => never.promise });
  const S = setup(page);
  delete S.local[R.id];
  page.get('loadLocal')(R.id);
  await flush();
  assert.doesNotMatch(btn(rendered(page), R.id, 'flow-ship'), /disabled/);
  const clean = await loadPage({ '/api/local': () => ({ json: local({ files: [] }) }) });
  setup(clean);
  clean.get('loadLocal')(R.id);
  await flush();
  assert.deepEqual(clean.urls().filter((u) => u.startsWith('/api/pi-status')), []);
});

test('A: `Show /flow-ship anyway` lifts the hold of a working session', async () => {
  const never = deferred();
  const page = await loadPage({ '/api/local': () => ({ json: local() }), '/api/pi-status': () => never.promise });
  const S = setup(page);
  delete S.local[R.id];
  page.get('loadLocal')(R.id);
  await flush();
  S.rpc[R.id] = { state: 'busy' };
  S.menu = 'abc|repo'; // the item lives in the card menu
  assert.match(rendered(page), /Show \/flow-ship anyway/);
  S.menu = null;
  S.showCommit.add(R.id);
  const html = rendered(page);
  assert.doesNotMatch(btn(html, R.id, 'flow-ship'), /disabled/);
});

// ---------- C ----------
function sendRoutes(extra = {}) {
  const order = deferred();
  const routes = {
    '/api/local': () => ({ json: local() }),
    '/api/pi': () => order.promise,
    ...extra,
  };
  return { order, routes };
}

test('C: the click disables the repo at once, shows the progress line, and survives redraws', async () => {
  const { order, routes } = sendRoutes();
  const page = await loadPage(routes);
  const S = setup(page);
  const done = page.get('ACTIONS').pi(el(R.id, 'flow-ship'));
  assert.ok(S.sending[R.id], 'set before any await');
  for (let i = 0; i < 4; i++) {
    const html = rendered(page);
    assert.match(btn(html, R.id, 'flow-ship'), /disabled>/, `redraw ${i}`);
    assert.match(html, /class="verdict-line"[^>]*title="Sending the order to the session"/);
    assert.match(html, /shipping<span class="ell"/);
    await flush();
  }
  order.resolve({ json: { sent: true, confirmed: true } });
  await done;
});

test('C: a second and third click send the order once only', async () => {
  const { order, routes } = sendRoutes();
  const page = await loadPage(routes);
  setup(page);
  const pi = page.get('ACTIONS').pi;
  const first = pi(el(R.id, 'flow-ship'));
  const second = pi(el(R.id, 'flow-ship'));
  const third = pi(el(R.id, 'flow-ship'));
  await flush();
  assert.equal(page.posts().length, 1);
  order.resolve({ json: { sent: true, confirmed: true } });
  await Promise.all([first, second, third]);
  assert.equal(page.posts().length, 1);
});

test('C: on success the real verdict takes over and the sending flag is cleared', async () => {
  const { order, routes } = sendRoutes();
  const page = await loadPage(routes);
  const S = setup(page);
  const done = page.get('ACTIONS').pi(el(R.id, 'flow-ship'));
  await flush();
  order.resolve({ json: { sent: true, confirmed: true } });
  await done;
  assert.equal(S.sending[R.id], undefined);
  assert.ok(S.sent[R.id], 'startSent recorded the command');
  const html = rendered(page);
  assert.match(btn(html, R.id, 'flow-ship'), /disabled>/, 'still disabled by the real running verdict');
  assert.match(html, /shipping<span class="ell"/);
});

test('C: a rejected send clears the flag, enables the button again and allows a new click', async () => {
  const page = await loadPage({ '/api/local': () => ({ json: local() }), '/api/pi': () => ({ status: 409, json: { error: 'The session is busy' } }) });
  const S = setup(page);
  await page.get('ACTIONS').pi(el(R.id, 'flow-ship'));
  assert.equal(S.sending[R.id], undefined);
  assert.equal(S.sent[R.id], undefined);
  assert.doesNotMatch(btn(rendered(page), R.id, 'flow-ship'), /disabled/);
  await page.get('ACTIONS').pi(el(R.id, 'flow-ship'));
  assert.equal(page.posts().length, 2, 'after a failure the button works again');
});

test('C: a network failure clears the flag too', async () => {
  const page = await loadPage({ '/api/local': () => ({ json: local() }) });
  const S = setup(page);
  await page.get('ACTIONS').pi(el(R.id, 'flow-ship'));
  assert.equal(S.sending[R.id], undefined);
});

test('C: the buttons of OTHER repos are untouched while one repo is sending', async () => {
  const { order, routes } = sendRoutes();
  const page = await loadPage(routes);
  const S = setup(page, [R, R2]);
  const done = page.get('ACTIONS').pi(el(R.id, 'flow-ship'));
  const html = rendered(page);
  assert.match(btn(html, R.id, 'flow-ship'), /disabled>/);
  assert.doesNotMatch(btn(html, R2.id, 'flow-ship'), /disabled/);
  order.resolve({ json: { sent: true, confirmed: true } });
  await done;
});

test('C: previous behaviour: a command of another kind sent from the card still reaches /api/pi with its body', async () => {
  const bodies = [];
  const page = await loadPage({ '/api/local': () => ({ json: local() }), '/api/pi': (body) => { bodies.push(body); return { json: { sent: true, confirmed: true } }; } });
  setup(page);
  await page.get('ACTIONS').pi(el(R.id, 'fix-pr', '7'));
  assert.deepEqual(bodies, [{ id: R.id, command: 'fix-pr', pr: 7 }]);
});
