'use strict';
// RP28 point 1A/1C: the Merge button stays disabled («Merged ✓») from the merge answer until the refresh of the repo
// has finished, so it never comes back to life for a second before the card moves. Real public/app.js in a vm.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const view = require('../public/view.js');
const lib = require('../lib.js');

const lf = (text) => text.replace(/\r\n/g, '\n');
const stub = () => new Proxy(function stubElement() {}, {
  get: (t, k) => (k === 'content' ? 'token' : k === 'dataset' ? {} : k === 'classList' ? { add() {}, remove() {}, toggle() {} } : k === Symbol.toPrimitive ? () => '' : stub),
  set: () => true,
  apply: () => stub(),
});

// `routes` maps a url (no query) to a function (body) => { status, json } or a promise of it.
async function loadPage(routes) {
  const app = { innerHTML: '' };
  const calls = [];
  const ctx = vm.createContext({
    console,
    document: new Proxy({}, { get: (t, k) => (k === 'hidden' ? false : k === 'querySelector' ? (sel) => (sel === '#app' ? app : stub()) : stub) }),
    localStorage: { getItem: () => null, setItem() {} },
    location: { hash: '' },
    requestAnimationFrame: () => 1,
    setInterval: () => 0,
    setTimeout: () => 0, clearTimeout: () => {}, AbortController,
    confirm: () => true,
    fetch: async (url, opts) => {
      calls.push(url);
      const route = routes[url.split('?')[0]];
      if (!route) throw new Error('offline');
      const a = await route(opts && opts.body ? JSON.parse(opts.body) : null);
      return { ok: a.status === undefined || a.status < 400, status: a.status || 200, statusText: 'x', json: async () => a.json };
    },
  });
  ctx.window = ctx;
  ctx.RepoPanelView = view;
  vm.runInContext(lf(fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8')), ctx);
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
  calls.length = 0;
  return { get: (name) => vm.runInContext(name, ctx), app, calls };
}

const flush = async () => { for (let i = 0; i < 6; i++) await new Promise((r) => setImmediate(r)); };
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };

const R = { id: 'abc', name: 'demo', path: 'x', group: 'g' };
const open = (n) => lib.enrichPr({
  number: n, title: `pr ${n}`, url: `https://github.com/o/demo/pull/${n}`, headRefName: `task-${n}`, baseRefName: 'main', headRefOid: 'a'.repeat(40),
  isDraft: false, mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', reviewDecision: null, statusCheckRollup: [], author: { login: 'x' },
});
const local = () => ({ branch: 'main', detached: false, upstream: 'origin/main', noUpstream: false, ahead: 0, behind: 0, files: [], added: 0, deleted: 0, head: 'h1', inProgress: null, base: 'main' });

function setup(page, prs) {
  const S = page.get('S');
  S.groups = [{ name: 'g', repos: [R] }];
  S.local[R.id] = local();
  S.prs[R.id] = { prs, stale: null, repo: { url: 'https://github.com/o/demo' } };
  return S;
}
const mergeBtn = (page, n) => new RegExp(`<button class="merge" data-act="merge" data-id="abc" data-n="${n}"[^>]*>[^<]*</button>`).exec(page.get('prCard')(R, page.get('S').prs[R.id].prs.find((p) => p.number === n), { url: 'u' }))[0];
const drawnBtn = (page, n) => {
  page.get('render')();
  return new RegExp(`<button class="merge" data-act="merge" data-id="abc" data-n="${n}"[^>]*>[^<]*</button>`).exec(page.app.innerHTML)[0];
};

test('page: after a good merge the button stays disabled and says Merged ✓ while the PR is listed, then the hold ends with the PR (RP75: S.merged, not S.busy)', async () => {
  const merge = deferred();
  const prsAnswer = deferred();
  const page = await loadPage({
    '/api/merge': () => merge.promise,
    '/api/local': () => ({ json: local() }),
    '/api/prs': () => prsAnswer.promise,
  });
  const S = setup(page, [open(7)]);
  assert.doesNotMatch(drawnBtn(page, 7), /disabled/, 'precondition: enabled before the click');

  const done = page.get('doMerge')(R.id, 7);
  await flush();
  assert.match(drawnBtn(page, 7), /disabled[^>]*>Merging…</, 'in flight: disabled, Merging…');

  merge.resolve({ json: { merged: true, branch: 'kept' } });
  await flush();
  assert.ok(page.calls.includes('/api/prs?id=abc'), 'precondition: the refresh has started and waits for /api/prs');
  const mid = drawnBtn(page, 7);
  assert.match(mid, /disabled/, 'between the merge answer and the end of the refresh the button is still disabled');
  assert.match(mid, />Merged ✓</, 'and says it is done');
  assert.doesNotMatch(mid, /Merging…/);
  assert.ok(S.merged['abc:7'] !== undefined, 'the merged hold is kept through the refresh (S.busy only means a request in flight)');
  assert.equal(S.busy['abc:7'], undefined);

  prsAnswer.resolve({ json: { prs: [], stale: null, repo: { url: 'https://github.com/o/demo' } } });
  await done;
  assert.deepEqual(Object.keys(S.busy), [], 'no busy entry is left behind');
  assert.deepEqual(Object.keys(S.merged), [], 'the PR is no longer listed: the hold ended');
  page.get('render')();
  assert.doesNotMatch(page.app.innerHTML, /data-act="merge"/, 'the card moved away');
});

test('page: a failed merge clears busy at once (the refresh is not awaited) and the button is usable again', async () => {
  const prsAnswer = deferred();
  const page = await loadPage({
    '/api/merge': () => ({ status: 409, json: { error: 'Not ready to merge' } }),
    '/api/local': () => ({ json: local() }),
    '/api/prs': () => prsAnswer.promise,
  });
  const S = setup(page, [open(7)]);
  const done = page.get('doMerge')(R.id, 7);
  await flush();
  assert.deepEqual(Object.keys(S.busy), [], 'busy is cleared while the refresh is still pending');
  const btn = drawnBtn(page, 7);
  assert.doesNotMatch(btn, /disabled/);
  assert.match(btn, />Merge · squash</);
  prsAnswer.resolve({ json: { prs: [open(7)], stale: null, repo: { url: 'u' } } });
  await done;
  assert.deepEqual(Object.keys(S.busy), []);
});

test('page: even if the refresh throws, the busy entry never stays behind', async () => {
  const page = await loadPage({
    '/api/merge': () => ({ json: { merged: true, branch: 'kept' } }),
    '/api/local': () => ({ json: local() }),
    '/api/prs': () => ({ json: { prs: [], stale: null, repo: {} } }),
  });
  const S = setup(page, [open(7)]);
  page.get('(() => { refreshRepo = () => Promise.reject(new Error("boom")); })()');
  await page.get('doMerge')(R.id, 7).catch(() => {});
  assert.deepEqual(Object.keys(S.busy), []);
});

test('page: a merge in flight does not block merging another PR', async () => {
  const merge7 = deferred();
  const merges = [];
  const page = await loadPage({
    '/api/merge': (body) => { merges.push(body.number); return body.number === 7 ? merge7.promise : { json: { merged: true, branch: 'kept' } }; },
    '/api/local': () => ({ json: local() }),
    '/api/prs': () => ({ json: { prs: [], stale: null, repo: {} } }),
  });
  const S = setup(page, [open(7), open(8)]);
  const first = page.get('doMerge')(R.id, 7);
  await flush();
  assert.doesNotMatch(drawnBtn(page, 8), /disabled/, 'the other PR keeps its enabled button');
  const second = page.get('doMerge')(R.id, 8);
  await flush();
  assert.deepEqual(merges, [7, 8]);
  merge7.resolve({ json: { merged: true, branch: 'kept' } });
  await Promise.all([first, second]);
  assert.deepEqual(Object.keys(S.busy), []);
});

test('page: PRESERVE a second click on a PR that is already merging is ignored', async () => {
  const merge = deferred();
  const merges = [];
  const page = await loadPage({
    '/api/merge': (body) => { merges.push(body.number); return merge.promise; },
    '/api/local': () => ({ json: local() }),
    '/api/prs': () => ({ json: { prs: [], stale: null, repo: {} } }),
  });
  setup(page, [open(7)]);
  const a = page.get('doMerge')(R.id, 7);
  const b = page.get('doMerge')(R.id, 7);
  await flush();
  merge.resolve({ json: { merged: true, branch: 'kept' } });
  await Promise.all([a, b]);
  assert.deepEqual(merges, [7]);
});

test('page: PRESERVE the idle button label; a finished merge reads Merged ✓ and stays disabled', async () => {
  const merge = deferred();
  const page = await loadPage({ '/api/merge': () => merge.promise, '/api/local': () => ({ json: local() }), '/api/prs': () => ({ json: { prs: [], stale: null, repo: {} } }) });
  const S = setup(page, [open(7)]);
  assert.match(mergeBtn(page, 7), />Merge · squash</);
  S.busy['abc:7'] = 'done';
  assert.match(mergeBtn(page, 7), /disabled[^>]*>Merged ✓</);
  delete S.busy['abc:7'];
});
