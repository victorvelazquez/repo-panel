'use strict';
// RP24 (S21) in the real public/app.js (vm with a stubbed DOM): the page polls the pi session of repos with
// uncommitted changes and no command in flight, and disables the commit button while it is busy or asking.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const stub = () => new Proxy(function stubElement() {}, {
  get: (t, k) => (k === 'content' ? 'token' : k === 'dataset' ? {} : k === 'classList' ? { add() {}, remove() {}, toggle() {} } : k === Symbol.toPrimitive ? () => '' : stub),
  set: () => true,
  apply: () => stub(),
});

async function loadPage({ hidden = false } = {}) {
  const calls = [];
  const answers = {};
  const ctx = vm.createContext({
    console,
    document: new Proxy({}, { get: (t, k) => (k === 'hidden' ? hidden : stub) }),
    localStorage: { getItem: () => null, setItem() {} },
    location: { hash: '' },
    requestAnimationFrame: () => 0,
    setInterval: () => 0,
    setTimeout: () => 0,
    confirm: () => true,
    fetch: async (url, opts) => {
      calls.push(url);
      const answer = typeof answers[url] === 'function' ? await answers[url]() : answers[url];
      if (!answer) throw new Error('offline');
      return { ok: true, json: async () => answer };
    },
  });
  ctx.window = ctx;
  ctx.RepoPanelView = require('../public/view.js');
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8'), ctx);
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r)); // let the startup refresh settle
  calls.length = 0;
  return { get: (name) => vm.runInContext(name, ctx), calls, answers };
}

const R = { id: 'abc', name: 'demo', path: 'x' };
const file = { path: 'a.txt', status: 'M', untracked: false };
const local = (o = {}) => ({ branch: 'task', detached: false, upstream: 'origin/task', noUpstream: false, ahead: 0, behind: 0, files: [file], added: 0, deleted: 0, head: 'h1', inProgress: null, base: 'main', stagedCount: 0, stagedPaths: [], ...o });
const URL_STATUS = `/api/pi-status?id=${R.id}`;
const flush = () => new Promise((r) => setImmediate(r));

function setup(page, l) {
  const S = page.get('S');
  S.groups = [{ name: 'g', repos: [R] }];
  S.local[R.id] = l;
  S.prs[R.id] = { prs: [], stale: null, repo: { url: 'https://github.com/o/demo' } };
  return S;
}
const card = (page) => page.get('repoCard')(R, false, null);
const commitBtn = (html) => /<button data-act="pi" data-id="abc" data-cmd="flow-commit"[^>]*>/.exec(html)[0];

test('page: a dirty repo with a busy session shows /flow-commit disabled with the reason, and enables it when the session is idle', async () => {
  const page = await loadPage();
  const S = setup(page, local());
  page.answers[URL_STATUS] = { state: 'busy' };
  page.get('pollLive')();
  await flush(); await flush();
  assert.deepEqual(page.calls, [URL_STATUS]);
  assert.equal(S.live[R.id], 'busy');
  assert.match(commitBtn(card(page)), /title="the pi session is still working" disabled>/);
  page.answers[URL_STATUS] = { state: 'idle' };
  page.get('pollLive')();
  await flush(); await flush();
  assert.equal(S.live[R.id], 'idle');
  assert.doesNotMatch(commitBtn(card(page)), /disabled/);
});

test('page: asking has its own reason, and a failed request never blocks', async () => {
  const page = await loadPage();
  const S = setup(page, local());
  page.answers[URL_STATUS] = { state: 'asking' };
  page.get('pollLive')();
  await flush(); await flush();
  assert.match(commitBtn(card(page)), /title="waiting for your answer in the session" disabled>/);
  delete page.answers[URL_STATUS];
  page.get('pollLive')();
  await flush(); await flush();
  assert.equal(S.live[R.id], undefined);
  assert.doesNotMatch(commitBtn(card(page)), /disabled/);
});

test('page: clean repos, hidden tabs and repos with a command in flight are not polled', async () => {
  const clean = await loadPage();
  setup(clean, local({ files: [] }));
  clean.get('pollLive')();
  const hiddenTab = await loadPage({ hidden: true });
  setup(hiddenTab, local());
  hiddenTab.get('pollLive')();
  const sent = await loadPage();
  const S = setup(sent, local());
  S.sent[R.id] = { cmd: 'flow-commit', at: Date.now(), head: 'h1', branch: 'task', files: 1, ahead: 0 };
  sent.get('pollLive')();
  await flush();
  assert.deepEqual([clean.calls, hiddenTab.calls, sent.calls], [[], [], []]);
});

test('page: at most one request per repo is in flight, and a repo that turned clean forgets its live state', async () => {
  const page = await loadPage();
  const S = setup(page, local());
  let release;
  page.answers[URL_STATUS] = () => new Promise((r) => { release = () => r({ state: 'busy' }); });
  page.get('pollLive')();
  page.get('pollLive')();
  await flush();
  assert.deepEqual(page.calls, [URL_STATUS]);
  release();
  await flush(); await flush();
  assert.equal(S.live[R.id], 'busy');
  S.local[R.id] = local({ files: [] });
  page.get('pollLive')();
  assert.equal(S.live[R.id], undefined);
});

test('page: pollLive redraws once more when the quiet period has just ended, so the button enables itself', async () => {
  const page = await loadPage();
  const S = setup(page, local({ lastChangeMs: Date.now() - 15000 }));
  page.get('(() => { globalThis.__draws = 0; draw = () => { globalThis.__draws++; }; })()');
  const draws = () => page.get('globalThis.__draws');
  page.get('pollLive')();
  await flush();
  assert.ok(draws() >= 1, 'inside the quiet period the page redraws');
  const before = draws();
  S.local[R.id] = local({ lastChangeMs: Date.now() - 25000 });
  page.get('pollLive')();
  await flush();
  assert.equal(draws(), before + 1, 'the poll that finds the quiet period over redraws once, so the disabled button is replaced');
  page.get('pollLive')();
  await flush();
  assert.equal(draws(), before + 1, 'and it does not keep redrawing after that');
});
