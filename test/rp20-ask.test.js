'use strict';
// RP176: the /flow-commit button is now /flow-ship everywhere it is offered; each assertion here keeps holding, now for /flow-ship.
// RP20 part B: a pi session that waits for the user's answer to a dialog. The panel only shows a notice;
// it never sends anything to a session that is asking (the state comes from the RPC host).
const test = require('node:test');
const { appSource } = require('./pagesrc.js');
const assert = require('node:assert/strict');
const lib = require('../lib.js');
const { piSend } = require('../server/pi.js');

const REPO = { path: 'C:\\dev\\repo' };

// RPC2-2: piSend asks the rpc host, so an asking session is refused from its state.
const fakeHost = (state) => { const sent = []; return { sent, status: async () => ({ state }), prompt: async (id, text) => { sent.push(text); return {}; } }; };

test('piSend: refuses a session that is asking with 409 and never sends text', async () => {
  for (const key of ['flow-ship', 'flow-pr', 'flow-base']) {
    const h = fakeHost('asking');
    await assert.rejects(piSend({ id: 'r1', ...REPO }, key, h), (e) => e.status === 409 && e.message === 'The session is waiting for an answer');
    assert.deepEqual(h.sent, []);
  }
});

test('piSend: an idle session still gets its command, a busy one still refuses', async () => {
  const h = fakeHost('idle');
  assert.equal((await piSend({ id: 'r1', ...REPO }, 'flow-ship', h)).sent, true);
  assert.deepEqual(h.sent, ['/flow-ship']);
  const b = fakeHost('busy');
  await assert.rejects(piSend({ id: 'r1', ...REPO }, 'flow-ship', b), (e) => e.status === 409 && e.message === 'The session is busy');
  assert.deepEqual(b.sent, []);
});


// ---------- verdict, strip, API version ----------
const view = require('../public/view.js');
const { workQueue } = lib;
const NOW = 10_000_000;
const lcl = (o = {}) => ({ branch: 'task', detached: false, upstream: 'origin/task', noUpstream: false, ahead: 0, behind: 0, files: [], head: 'h1', inProgress: null, base: 'main', stagedCount: 0, stagedPaths: [], ...o });
const sentOf = (cmd, o = {}) => ({ cmd, at: NOW - 60_000, head: 'h1', branch: 'task', files: 0, ahead: 0, ...o });
const ASKING = 'waiting for your answer in the session';

test('API_VERSION is at least the one that added the asking state and the ask field of pi-status (now 15)', () => {
  assert.equal(view.API_VERSION, 15);
});

test('flowVerdict: an asking session keeps the command running with a distinct label, a flag and no timeout', () => {
  for (const cmd of ['flow-ship', 'flow-ship-unstage', 'flow-pr', 'flow-base', 'flow-base-stash', 'fix-pr', 'put-in-conditions']) {
    for (const at of [NOW - 5_000, NOW - 40 * 60_000, NOW - 6 * 3_600_000]) {
      const v = view.flowVerdict(sentOf(cmd, { at }), lcl({ files: [{ path: 'a', status: 'M' }] }), 'asking', { prs: [] }, NOW);
      assert.equal(v.state, 'running', cmd);
      assert.equal(v.asking, true);
      assert.equal(v.label, ASKING);
      assert.equal(v.reason, ASKING);
      assert.equal(v.cmd, cmd);
    }
  }
  assert.equal(view.flowVerdict(sentOf('flow-ship'), null, 'asking', { prs: [] }, NOW).asking, true);
});

test('flowVerdict: the other session states keep their rows, with no asking flag', () => {
  const run = (cmd, l, session, now = NOW, o = {}) => view.flowVerdict(sentOf(cmd, o), l, session, { prs: [] }, now);
  const busy = run('flow-pr', lcl({ ahead: 1 }), 'busy');
  assert.deepEqual([busy.state, busy.reason, busy.label, busy.asking], ['running', 'The session is working', 'creating pull request…', undefined]);
  assert.equal(run('flow-ship', lcl({ files: [{ path: 'a', status: 'M' }] }), 'idle').state, 'attention');
  assert.equal(run('flow-pr', lcl({ ahead: 1 }), 'closed').state, 'attention');
  assert.equal(run('flow-base', lcl({ branch: 'main' }), undefined).asking, undefined);
  assert.equal(run('flow-base', lcl({ branch: 'task' }), 'unknown', NOW + 16 * 60_000).state, 'attention');
});

test('queueFlags: an asking verdict makes the repo wait for the user, and nothing else changes', () => {
  const asking = view.flowVerdict(sentOf('flow-ship'), lcl(), 'asking', { prs: [] }, NOW);
  assert.deepEqual(view.queueFlags(lcl(), null, asking, { now: NOW }), { waiting: { state: 'needs-input', next: 'Answer the question in the session' } });
  const queue = workQueue([{ id: 'a', name: 'demo', dirty: true, unpushed: false, waiting: { state: 'needs-input', next: 'Answer the question in the session' } }]);
  assert.deepEqual(queue.map((a) => [a.kind, a.state, a.next]), [['waiting', 'needs-input', 'Answer the question in the session']]);
});

test('queueFlags: running without asking, attention, no verdict and a declared state behave as before', () => {
  const running = view.flowVerdict(sentOf('flow-pr'), lcl({ ahead: 1 }), 'busy', { prs: [] }, NOW);
  assert.deepEqual(view.queueFlags(lcl(), null, running, { now: NOW }), {});
  const attn = { state: 'attention', reason: 'No new commit', cmd: 'flow-ship' };
  assert.deepEqual(view.queueFlags(lcl(), null, attn, { now: NOW }), { manual: 'No new commit' });
  assert.deepEqual(view.queueFlags(lcl(), null, null, { now: NOW }), {});
  const declared = { available: true, state: 'blocked', next: 'Fix the key', at: new Date(NOW).toISOString() };
  assert.deepEqual(view.queueFlags(lcl(), declared, null, { now: NOW }), { waiting: { state: 'blocked', next: 'Fix the key' } });
});

// ---------- the page: the card and the polling ----------
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const stub = () => new Proxy(function stubElement() {}, {
  get: (t, k) => (k === 'content' ? 'token' : k === 'dataset' ? {} : k === 'classList' ? { add() {}, remove() {}, toggle() {} } : k === Symbol.toPrimitive ? () => '' : stub),
  set: () => true,
  apply: () => stub(),
});
function loadPage() {
  const calls = [];
  const answers = {};
  const ctx = vm.createContext({
    console,
    document: new Proxy({}, { get: (t, k) => (k === 'hidden' ? false : stub) }),
    localStorage: { getItem: () => null, setItem() {} },
    location: { hash: '' },
    requestAnimationFrame: () => 0,
    setInterval: () => 0,
    setTimeout: () => 0, clearTimeout: () => {}, AbortController,
    confirm: () => true,
    fetch: async (url, opts) => {
      calls.push({ url, method: (opts && opts.method) || 'GET', body: opts && opts.body ? JSON.parse(opts.body) : null });
      const answer = answers[url];
      if (!answer) throw new Error('offline');
      return { ok: true, json: async () => answer };
    },
  });
  ctx.window = ctx;
  ctx.RepoPanelView = view;
  vm.runInContext(appSource(), ctx);
  return { get: (name) => vm.runInContext(name, ctx), calls, answers };
}
const R = { id: 'abc', name: 'demo' };
function asking(page) {
  const S = page.get('S');
  S.local[R.id] = lcl({ files: [{ path: 'a.txt', status: 'M', untracked: false }] });
  S.prs[R.id] = { prs: [], stale: null, repo: { url: 'https://github.com/o/demo' } };
  S.sent[R.id] = sentOf('flow-ship', { at: Date.now() - 40 * 60_000 });
  return S;
}

test('page: polling an asking session keeps the record and only ever reads', async () => {
  const page = loadPage();
  await new Promise((r) => setImmediate(r));
  page.calls.length = 0;
  const S = asking(page);
  page.answers['/api/pi-status?id=abc'] = { state: 'asking' };
  await page.get('loadPiStatus')('abc');
  assert.equal(S.pistatus.abc, 'asking');
  assert.ok(S.sent.abc, 'the record is kept');
  const v = page.get('verdictOf')(R);
  assert.deepEqual([v.state, v.asking], ['running', true]);
  assert.equal(page.calls.every((c) => c.method === 'GET' && !c.url.startsWith('/api/pi?')), true);
  assert.equal(page.calls.some((c) => c.url === '/api/pi'), false);
  page.answers['/api/pi-status?id=abc'] = { state: 'idle' };
  await page.get('loadPiStatus')('abc');
  assert.equal(S.pistatus.abc, 'idle');
});

test('page: the card of an asking session shows a static highlighted line whose tooltip is the verdict reason', () => {
  const page = loadPage();
  const S = asking(page);
  S.pistatus.abc = 'asking';
  const v = page.get('verdictOf')(R);
  const row = page.get('verdictRow')(R, v);
  assert.equal(row, `<div class="ask-line" role="status" aria-live="polite" title="${v.reason}">waiting for your answer in the session</div>`);
  assert.equal(/pulse-dot|class="ell"|animation|committing/.test(row), false);
  const card = page.get('repoCard')(R, false, v);
  assert.ok(card.includes(row));
  assert.equal(card.includes('verdict-line'), false);
  assert.match(card, /<button data-act="pi" data-id="abc" data-cmd="flow-ship"[^>]* disabled>/);
  assert.equal(card.includes('Needs attention'), false);
});

test('page: an asking verdict shows the static line', () => {
  const page = loadPage();
  asking(page);
  const row = page.get('verdictRow')(R, view.flowVerdict(sentOf('flow-pr'), lcl(), 'asking', { prs: [] }, NOW));
  assert.match(row, /^<div class="ask-line"[^>]*>waiting for your answer in the session<\/div>$/);
});

test('page: a normal busy verdict is still the animated running line, not the asking line', () => {
  const page = loadPage();
  asking(page);
  const row = page.get('verdictRow')(R, view.flowVerdict(sentOf('flow-pr'), lcl({ ahead: 1 }), 'busy', { prs: [] }, NOW));
  assert.match(row, /class="verdict-line"/);
  assert.equal(row.includes('ask-line'), false);
});
