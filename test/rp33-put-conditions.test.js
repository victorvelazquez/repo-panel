'use strict';
// RP33: the "Put in conditions" button (its own click handler) behaves like the /flow-* buttons since RP32: from the
// click until the server answers the repo is marked as sending, a second click is ignored, and nothing is left behind.
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
    setTimeout: () => 0,
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

function setup(page, repos = [R], l = local()) {
  const S = page.get('S');
  S.groups = [{ name: 'g', repos }];
  for (const r of repos) {
    S.local[r.id] = l;
    S.prs[r.id] = { prs: [], stale: null, repo: { url: 'https://github.com/o/demo' } };
    S.live[r.id] = 'idle';
    S.liveAnswered[r.id] = true;
  }
  return S;
}
const rendered = (page) => { page.get('render')(); return page.app.innerHTML; };
const btn = (html, id, cmd) => new RegExp(`<button data-act="pi" data-id="${id}" data-cmd="${cmd}"[^>]*>`).exec(html)[0];
const el = (id) => ({ dataset: { id }, disabled: false });
const CMD = 'put-in-conditions';

function sendRoutes(t) {
  const order = deferred();
  t.after(() => order.resolve({ json: { sent: true, confirmed: true } })); // a failed assertion must not leave the order pending
  return { order, routes: { '/api/local': () => ({ json: local() }), '/api/pi': () => order.promise } };
}

test('the click marks the repo as sending before any await, and it survives redraws', async (t) => {
  const { order, routes } = sendRoutes(t);
  const page = await loadPage(routes);
  const S = setup(page);
  const done = page.get('ACTIONS')[CMD](el(R.id));
  assert.equal(S.sending[R.id], CMD, 'set before any await');
  for (let i = 0; i < 4; i++) {
    const html = rendered(page);
    assert.match(btn(html, R.id, 'flow-commit'), /disabled>/, `redraw ${i}: the flow buttons of the repo are disabled`);
    assert.match(html, /class="verdict-line"[^>]*title="Sending the order to the pi session"/);
    assert.match(html, /putting repo in conditions<span class="ell"/);
    await flush();
  }
  order.resolve({ json: { sent: true, confirmed: true } });
  await done;
});

test('a second and third click send the order once only', async (t) => {
  const { order, routes } = sendRoutes(t);
  const page = await loadPage(routes);
  setup(page);
  const act = page.get('ACTIONS')[CMD];
  const first = act(el(R.id));
  const second = act(el(R.id));
  const third = act(el(R.id));
  await flush();
  assert.equal(page.posts().length, 1);
  order.resolve({ json: { sent: true, confirmed: true } });
  await Promise.all([first, second, third]);
  assert.equal(page.posts().length, 1);
});

test('a click while another command of the repo is being sent is ignored', async (t) => {
  const { order, routes } = sendRoutes(t);
  const page = await loadPage(routes);
  const S = setup(page);
  const flow = page.get('ACTIONS').pi({ dataset: { id: R.id, cmd: 'flow-commit' }, disabled: false });
  const other = page.get('ACTIONS')[CMD](el(R.id));
  await flush();
  assert.equal(page.posts().length, 1, 'only the order that was already on its way');
  assert.equal(S.sending[R.id], 'flow-commit');
  order.resolve({ json: { sent: true, confirmed: true } });
  await Promise.all([flow, other]);
});

test('on success the real verdict takes over and the sending flag is cleared', async (t) => {
  const { order, routes } = sendRoutes(t);
  const page = await loadPage(routes);
  const S = setup(page);
  const done = page.get('ACTIONS')[CMD](el(R.id));
  await flush();
  order.resolve({ json: { sent: true, confirmed: true } });
  await done;
  assert.equal(S.sending[R.id], undefined);
  assert.equal(S.sent[R.id].cmd, CMD, 'startSent recorded the command');
  const html = rendered(page);
  assert.match(btn(html, R.id, 'flow-commit'), /disabled>/, 'still disabled by the real running verdict');
  assert.match(html, /putting repo in conditions<span class="ell"/);
});

test('a rejected send clears the flag and allows a new click', async () => {
  const page = await loadPage({ '/api/local': () => ({ json: local() }), '/api/pi': () => ({ status: 409, json: { error: 'The pi session is busy' } }) });
  const S = setup(page);
  await page.get('ACTIONS')[CMD](el(R.id));
  assert.equal(S.sending[R.id], undefined);
  assert.equal(S.sent[R.id], undefined);
  assert.doesNotMatch(btn(rendered(page), R.id, 'flow-commit'), /disabled/);
  await page.get('ACTIONS')[CMD](el(R.id));
  assert.equal(page.posts().length, 2, 'after a failure the button works again');
});

test('a network failure clears the flag too', async () => {
  const page = await loadPage({ '/api/local': () => ({ json: local() }) });
  const S = setup(page);
  await page.get('ACTIONS')[CMD](el(R.id));
  assert.equal(S.sending[R.id], undefined);
});

test('only the repo being sent is marked; the others keep their buttons', async (t) => {
  const { order, routes } = sendRoutes(t);
  const page = await loadPage(routes);
  const S = setup(page, [R, R2]);
  const done = page.get('ACTIONS')[CMD](el(R.id));
  assert.equal(S.sending[R2.id], undefined);
  const html = rendered(page);
  assert.match(btn(html, R.id, 'flow-commit'), /disabled>/);
  assert.doesNotMatch(btn(html, R2.id, 'flow-commit'), /disabled/);
  order.resolve({ json: { sent: true, confirmed: true } });
  await done;
});

test('the click closes the menu it came from', async (t) => {
  const { order, routes } = sendRoutes(t);
  const page = await loadPage(routes);
  const S = setup(page);
  S.menu = `more-${R.id}`;
  const done = page.get('ACTIONS')[CMD](el(R.id));
  assert.equal(S.menu, null);
  order.resolve({ json: { sent: true, confirmed: true } });
  await done;
});
