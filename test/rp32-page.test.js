'use strict';
// RP32 A and C in the real public/app.js (vm with a stubbed DOM): the commit buttons wait for the first live answer
// of the pi session, the live state is asked for at once, and a command being sent disables the repo's flow buttons
// from the click until the answer, however often the card is redrawn.
const test = require('node:test');
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
async function loadPage(routes = {}) {
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
  vm.runInContext(lf(fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8')), ctx);
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
test('A: a repo first seen dirty asks for its live state at once and the commit button waits for the answer', async () => {
  const status = deferred();
  const page = await loadPage({
    '/api/local': () => ({ json: local() }),
    '/api/pi-status': () => status.promise.then((json) => ({ json })),
  });
  const S = setup(page, [R], local());
  delete S.local[R.id];
  page.get('loadLocal')(R.id);
  await flush();
  assert.ok(page.urls().includes(STATUS(R.id)), 'the live state is asked for without waiting for the 10 s tick');
  assert.match(btn(rendered(page), R.id, 'flow-commit'), /title="checking the session…" disabled>/);
  status.resolve({ state: 'busy' });
  await flush();
  assert.match(btn(rendered(page), R.id, 'flow-commit'), /title="the session is still working" disabled>/);
});

test('A: the first answer ends the checking: idle enables the button, and so does a failed request', async () => {
  for (const answer of [{ json: { state: 'idle' } }, null]) {
    const page = await loadPage({
      '/api/local': () => ({ json: local() }),
      '/api/pi-status': () => { if (!answer) throw new Error('boom'); return answer; },
    });
    const S = setup(page);
    delete S.local[R.id];
    page.get('loadLocal')(R.id);
    await flush();
    assert.doesNotMatch(btn(rendered(page), R.id, 'flow-commit'), /disabled/, answer ? 'idle' : 'failed');
    assert.equal(S.liveAnswered[R.id], true);
  }
});

test('A: the checking hold fails open after LIVE_CHECK_MS without an answer, and a clean repo is never checked', async () => {
  const never = deferred();
  const page = await loadPage({ '/api/local': () => ({ json: local() }), '/api/pi-status': () => never.promise });
  const S = setup(page);
  delete S.local[R.id];
  page.get('loadLocal')(R.id);
  await flush();
  assert.match(btn(rendered(page), R.id, 'flow-commit'), /disabled>/);
  S.dirtyAt[R.id] = Date.now() - 21000;
  assert.doesNotMatch(btn(rendered(page), R.id, 'flow-commit'), /disabled/);
  const clean = await loadPage({ '/api/local': () => ({ json: local({ files: [] }) }) });
  setup(clean);
  clean.get('loadLocal')(R.id);
  await flush();
  assert.deepEqual(clean.urls().filter((u) => u.startsWith('/api/pi-status')), []);
});

test('A: the first loadLocal of a dirty repo asks once; a later one does not ask again (pollLive owns the cadence)', async () => {
  const page = await loadPage({ '/api/local': () => ({ json: local() }), '/api/pi-status': () => ({ json: { state: 'idle' } }) });
  const S = setup(page);
  delete S.local[R.id];
  page.get('loadLocal')(R.id);
  await flush();
  page.get('loadLocal')(R.id);
  await flush();
  assert.equal(page.urls().filter((u) => u === STATUS(R.id)).length, 1);
  S.local[R.id] = local({ files: [] });
  page.get('noteLocal')(R.id);
  assert.equal(S.dirtyAt[R.id], undefined, 'clean again: the next dirty spell is checked again');
});

test('A: `Show /flow-commit anyway` lifts the checking hold', async () => {
  const never = deferred();
  const page = await loadPage({ '/api/local': () => ({ json: local() }), '/api/pi-status': () => never.promise });
  const S = setup(page);
  delete S.local[R.id];
  page.get('loadLocal')(R.id);
  await flush();
  S.menu = 'abc|repo'; // the item lives in the card menu
  assert.match(rendered(page), /Show \/flow-commit anyway/);
  S.menu = null;
  S.showCommit.add(R.id);
  const html = rendered(page);
  assert.doesNotMatch(btn(html, R.id, 'flow-commit'), /disabled/);
});

test('A: pollLive keeps the live state while the tab is hidden, and forgets clean repos and repos with a command in flight', async () => {
  const page = await loadPage({ '/api/pi-status': () => ({ json: { state: 'busy' } }) });
  const S = setup(page, [R, R2]);
  S.live[R.id] = 'busy';
  S.live[R2.id] = 'busy';
  page.state.hidden = true;
  page.get('pollLive')();
  await flush();
  assert.deepEqual([S.live[R.id], S.live[R2.id]], ['busy', 'busy'], 'hidden: nothing deleted');
  assert.deepEqual(page.urls(), [], 'hidden: nothing asked');
  page.state.hidden = false;
  S.local[R2.id] = local({ files: [] });
  S.sent[R.id] = { cmd: 'flow-commit', at: Date.now() };
  page.get('pollLive')();
  assert.deepEqual([S.live[R.id], S.live[R2.id]], [undefined, undefined]);
});

test('A: when the tab becomes visible again the live state is asked for at once', async () => {
  const page = await loadPage({ '/api/pi-status': () => ({ json: { state: 'idle' } }) });
  const S = setup(page);
  S.live[R.id] = 'busy';
  page.state.hidden = true;
  page.get('pollLive')();
  page.state.hidden = false;
  for (const fn of page.listeners.visibilitychange || []) fn();
  await flush();
  assert.deepEqual(page.urls(), [STATUS(R.id)]);
  assert.equal(S.live[R.id], 'idle');
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
  S.live[R.id] = 'idle';
  S.liveAnswered[R.id] = true;
  const done = page.get('ACTIONS').pi(el(R.id, 'flow-commit'));
  assert.ok(S.sending[R.id], 'set before any await');
  for (let i = 0; i < 4; i++) {
    const html = rendered(page);
    assert.match(btn(html, R.id, 'flow-commit'), /disabled>/, `redraw ${i}`);
    assert.match(html, /class="verdict-line"[^>]*title="Sending the order to the session"/);
    assert.match(html, /committing<span class="ell"/);
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
  const first = pi(el(R.id, 'flow-commit'));
  const second = pi(el(R.id, 'flow-commit'));
  const third = pi(el(R.id, 'flow-commit'));
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
  const done = page.get('ACTIONS').pi(el(R.id, 'flow-commit'));
  await flush();
  order.resolve({ json: { sent: true, confirmed: true } });
  await done;
  assert.equal(S.sending[R.id], undefined);
  assert.ok(S.sent[R.id], 'startSent recorded the command');
  const html = rendered(page);
  assert.match(btn(html, R.id, 'flow-commit'), /disabled>/, 'still disabled by the real running verdict');
  assert.match(html, /committing<span class="ell"/);
});

test('C: a rejected send clears the flag, enables the button again and allows a new click', async () => {
  const page = await loadPage({ '/api/local': () => ({ json: local() }), '/api/pi': () => ({ status: 409, json: { error: 'The session is busy' } }) });
  const S = setup(page);
  S.live[R.id] = 'idle';
  S.liveAnswered[R.id] = true;
  await page.get('ACTIONS').pi(el(R.id, 'flow-commit'));
  assert.equal(S.sending[R.id], undefined);
  assert.equal(S.sent[R.id], undefined);
  assert.doesNotMatch(btn(rendered(page), R.id, 'flow-commit'), /disabled/);
  await page.get('ACTIONS').pi(el(R.id, 'flow-commit'));
  assert.equal(page.posts().length, 2, 'after a failure the button works again');
});

test('C: a network failure clears the flag too', async () => {
  const page = await loadPage({ '/api/local': () => ({ json: local() }) });
  const S = setup(page);
  await page.get('ACTIONS').pi(el(R.id, 'flow-commit'));
  assert.equal(S.sending[R.id], undefined);
});

test('C: the buttons of OTHER repos are untouched while one repo is sending', async () => {
  const { order, routes } = sendRoutes();
  const page = await loadPage(routes);
  const S = setup(page, [R, R2]);
  for (const r of [R, R2]) { S.live[r.id] = 'idle'; S.liveAnswered[r.id] = true; }
  const done = page.get('ACTIONS').pi(el(R.id, 'flow-commit'));
  const html = rendered(page);
  assert.match(btn(html, R.id, 'flow-commit'), /disabled>/);
  assert.doesNotMatch(btn(html, R2.id, 'flow-commit'), /disabled/);
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
