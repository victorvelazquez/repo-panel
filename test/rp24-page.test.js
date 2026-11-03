'use strict';
// RP24 (S21) in the real public/app.js (vm with a stubbed DOM): the commit button is disabled while the RPC session
// of the repo is busy or asking, and the quiet tick only redraws.
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
    setTimeout: () => 0, clearTimeout: () => {}, AbortController,
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

// RPC2b-1: the buttons follow S.rpc (the live session of the host); nothing else holds it.
test('page: a dirty repo with a busy session shows /flow-commit disabled with the reason, and enables it when the session is idle', async () => {
  const page = await loadPage();
  const S = setup(page, local());
  S.rpc[R.id] = { state: 'busy' };
  assert.match(commitBtn(card(page)), /title="the session is still working" disabled>/);
  S.rpc[R.id] = { state: 'idle' };
  assert.doesNotMatch(commitBtn(card(page)), /disabled/);
});

test('page: asking has its own reason, and a repo with no session state never blocks', async () => {
  const page = await loadPage();
  const S = setup(page, local());
  S.rpc[R.id] = { state: 'asking' };
  assert.match(commitBtn(card(page)), /title="waiting for your answer in the session" disabled>/);
  delete S.rpc[R.id];
  assert.doesNotMatch(commitBtn(card(page)), /disabled/);
});

test('page: the quiet tick requests nothing, whatever the repo (clean, hidden tab, command in flight or dirty)', async () => {
  const clean = await loadPage();
  setup(clean, local({ files: [] }));
  clean.get('quietTick')();
  const hiddenTab = await loadPage({ hidden: true });
  setup(hiddenTab, local());
  hiddenTab.get('quietTick')();
  const dirty = await loadPage();
  setup(dirty, local());
  dirty.get('quietTick')();
  const sent = await loadPage();
  const S = setup(sent, local());
  S.sent[R.id] = { cmd: 'flow-commit', at: Date.now(), head: 'h1', branch: 'task', files: 1, ahead: 0 };
  sent.get('quietTick')();
  await flush();
  assert.deepEqual([clean.calls, hiddenTab.calls, dirty.calls, sent.calls], [[], [], [], []]);
});

test('page: quietTick redraws once more when the quiet period has just ended, so the button enables itself', async () => {
  const page = await loadPage();
  const S = setup(page, local({ lastChangeMs: Date.now() - 15000 }));
  page.get('(() => { globalThis.__draws = 0; draw = () => { globalThis.__draws++; }; })()');
  const draws = () => page.get('globalThis.__draws');
  page.get('quietTick')();
  await flush();
  assert.ok(draws() >= 1, 'inside the quiet period the page redraws');
  const before = draws();
  S.local[R.id] = local({ lastChangeMs: Date.now() - 25000 });
  page.get('quietTick')();
  await flush();
  assert.equal(draws(), before + 1, 'the poll that finds the quiet period over redraws once, so the disabled button is replaced');
  page.get('quietTick')();
  await flush();
  assert.equal(draws(), before + 1, 'and it does not keep redrawing after that');
});
