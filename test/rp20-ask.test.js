'use strict';
// RP20 part B: a pi session that waits for the user's answer to a selection dialog. The panel only shows a notice;
// it never answers the dialog and never sends anything to a session that is asking.
const test = require('node:test');
const assert = require('node:assert/strict');
const lib = require('../lib.js');
const { piStatus, piSend, scanSessions } = require('../server/pi.js');
const { roomsState } = require('../server/rooms.js');

const DIALOG = [
  'rdd running · start',
  '',
  'Review consent',
  'Gentle AI can review this change before you call it done.',
  'Review can help detect execution issues in these changes.',
  '→ 1. Review this change',
  '  2. Skip this time',
  '  3. Review and allow this session',
  '',
  'Effect: Reviews only this change; later medium- or high-risk changes ask again, and delivery needs separate approval.',
  '',
  '↑↓ choose · Enter confirm · Esc cancel · D details',
  '',
].join('\n');
const IDLE_BAR = '▎ ✿ waiting for input\n▎   type, or / for commands\n▎\n';
const WORKING_BAR = '▎ ❁ working…\n▎   type, or / for commands\n▎\n';
const IDLE_PI = IDLE_BAR;
const BUSY_PI = `$ sleep 20\nElapsed 7.2s\n${WORKING_BAR}`;

// ---------- piScreenAsk ----------
test('piScreenAsk: the exact selection dialog is asking, with its last lines as sanitized text', () => {
  const a = lib.piScreenAsk(DIALOG);
  assert.ok(a && typeof a.text === 'string');
  assert.match(a.text, /Review consent/);
  assert.match(a.text, /→ 1\. Review this change/);
  assert.match(a.text, /Enter confirm · Esc cancel/);
  assert.equal(a.text.split('\n').length <= 12, true);
  assert.equal(a.text.length <= 900, true);
});

test('piScreenAsk: the dialog with an idle bar or a working bar below it still asks', () => {
  assert.ok(lib.piScreenAsk(DIALOG + IDLE_BAR));
  assert.ok(lib.piScreenAsk(DIALOG + WORKING_BAR));
});

test('piScreenAsk: ordinary idle and busy screens are not asking', () => {
  assert.equal(lib.piScreenAsk(IDLE_PI), null);
  assert.equal(lib.piScreenAsk(BUSY_PI), null);
});

test('piScreenAsk: an old dialog far above the last 14 non-empty lines is not asking', () => {
  const later = Array.from({ length: 15 }, (_, i) => `output line ${i}`).join('\n');
  assert.equal(lib.piScreenAsk(`${DIALOG}\n${later}\n${IDLE_BAR}`), null);
});

test('piScreenAsk: needs BOTH hints, and garbage, empty and non-strings fail closed', () => {
  assert.equal(lib.piScreenAsk('Enter confirm'), null);
  assert.equal(lib.piScreenAsk('Esc cancel'), null);
  assert.equal(lib.piScreenAsk('Enter confirm\nEsc cancel'), null);
  for (const v of ['', '   \n\n', null, undefined, 7, {}, ['Enter confirm · Esc cancel']]) assert.equal(lib.piScreenAsk(v), null, String(v));
});

test('piScreenAsk: control characters become spaces, each line is capped at 200 and the total at 900', () => {
  const nasty = `a${String.fromCharCode(27)}[31mred${String.fromCharCode(7)}\n${'x'.repeat(500)}\n↑↓ choose · Enter confirm · Esc cancel`;
  const a = lib.piScreenAsk(nasty);
  assert.equal(/[\x00-\x09\x0b-\x1f\x7f-\x9f]/.test(a.text), false);
  assert.ok(a.text.split('\n').every((l) => l.length <= 200));
  const many = Array.from({ length: 13 }, () => 'y'.repeat(200)).slice(0, 12).join('\n');
  assert.equal(lib.piScreenAsk(`${many}\nEnter confirm · Esc cancel`).text.length <= 900, true);
});

test('piScreenState: still null for the dialog alone and busy with a working bar (the panel only adds the asking layer)', () => {
  assert.equal(lib.piScreenState(DIALOG), null);
  assert.equal(lib.piScreenState(DIALOG + WORKING_BAR), 'busy');
  assert.equal(lib.piScreenState(IDLE_PI), 'idle');
});

// ---------- scanSessions / piStatus / piSend ----------
const piTerm = (o = {}) => ({ handle: 'h1', title: 'Terminal 1', worktreePath: 'C:/dev/repo', connected: true, writable: true, ...o });
function fakeOrca({ terminals = [piTerm()], preview = IDLE_PI } = {}) {
  const calls = [];
  const orca = async (args) => {
    calls.push(args);
    if (args[0] === 'list') return { terminals };
    if (args[0] === 'show') return { terminal: { preview } };
    return { send: { accepted: true } };
  };
  return { orca, calls, sends: () => calls.filter((c) => c[0] === 'send') };
}
const REPO = { path: 'C:\\dev\\repo' };
const noWait = async () => {};

test('piStatus: a dialog alone is asking (never closed) and carries the ask text', async () => {
  const s = await piStatus(REPO, fakeOrca({ preview: DIALOG }).orca);
  assert.equal(s.state, 'asking');
  assert.match(s.ask, /Review consent/);
});

test('piStatus: a dialog above a working bar is asking too, and the ask wins over idle', async () => {
  assert.equal((await piStatus(REPO, fakeOrca({ preview: DIALOG + WORKING_BAR }).orca)).state, 'asking');
  assert.equal((await piStatus(REPO, fakeOrca({ preview: DIALOG + IDLE_BAR }).orca)).state, 'asking');
});

test('piStatus: plain busy and plain idle keep their answer, with no ask field', async () => {
  assert.deepEqual(await piStatus(REPO, fakeOrca({ preview: BUSY_PI }).orca), { state: 'busy' });
  assert.deepEqual(await piStatus(REPO, fakeOrca({ preview: IDLE_PI }).orca), { state: 'idle' });
  assert.deepEqual(await piStatus(REPO, fakeOrca({ terminals: [] }).orca), { state: 'closed' });
});

test('piStatus with tail: asking keeps the tail field next to ask', async () => {
  const s = await piStatus(REPO, fakeOrca({ preview: DIALOG + WORKING_BAR }).orca, { tail: true });
  assert.equal(s.state, 'asking');
  assert.equal(typeof s.tail, 'string');
  assert.match(s.ask, /Enter confirm/);
});

test('scanSessions: reports asking only to a caller that asks for it, busy otherwise', async () => {
  const f = fakeOrca({ preview: DIALOG });
  assert.deepEqual((await scanSessions(REPO.path, f.orca, undefined, false, true)).sessions.map((s) => s.state), ['asking']);
  assert.deepEqual((await scanSessions(REPO.path, f.orca)).sessions.map((s) => s.state), ['busy']);
});

test('piSend: refuses a session that is asking with 409 and never sends a key or text', async () => {
  for (const preview of [DIALOG, DIALOG + IDLE_BAR, DIALOG + WORKING_BAR]) {
    for (const key of ['flow-commit', 'flow-pr', 'flow-base']) {
      const f = fakeOrca({ preview });
      await assert.rejects(piSend(REPO, key, f.orca, noWait), (e) => e.status === 409 && e.message === 'The pi session is waiting for your answer to a question');
      assert.equal(f.sends().length, 0);
      assert.equal(f.calls.every((c) => c[0] === 'list' || c[0] === 'show'), true);
    }
  }
});

test('piSend: an idle session still gets its command, a busy one still refuses as before', async () => {
  const f = fakeOrca({ preview: IDLE_PI });
  assert.equal((await piSend(REPO, 'flow-commit', f.orca, noWait)).sent, true);
  assert.equal(f.sends().length, 1);
  const b = fakeOrca({ preview: BUSY_PI });
  await assert.rejects(piSend(REPO, 'flow-commit', b.orca, noWait), (e) => e.status === 409 && /busy or has text typed/.test(e.message));
});

// ---------- rooms presence ----------
test('rooms presence: a session that is asking counts as busy, and idle stays idle', async () => {
  const room = { name: 'UPEN', path: 'C:\\dev\\repo', repos: ['a'] };
  const req = async () => ({ available: true, base: 'main', results: [{ id: 'room-base-branch', status: 'pass' }], summary: { ready: true } });
  const git = async () => ({ code: 0, stdout: '2026-10-24T10:00:00-05:00\n', stderr: '' });
  const presence = async (preview) => {
    const out = await roomsState({ rooms: [room], orca: fakeOrca({ preview }).orca, git, requirements: req });
    return out.rooms[0].presence.state;
  };
  assert.equal(await presence(DIALOG), 'busy');
  assert.equal(await presence(DIALOG + IDLE_BAR), 'busy');
  assert.equal(await presence(IDLE_PI), 'idle');
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
  for (const cmd of ['flow-commit', 'flow-commit-unstage', 'flow-pr', 'flow-base', 'flow-base-stash', 'fix-pr', 'put-in-conditions']) {
    for (const at of [NOW - 5_000, NOW - 40 * 60_000, NOW - 6 * 3_600_000]) {
      const v = view.flowVerdict(sentOf(cmd, { at }), lcl({ files: [{ path: 'a', status: 'M' }] }), 'asking', { prs: [] }, NOW);
      assert.equal(v.state, 'running', cmd);
      assert.equal(v.asking, true);
      assert.equal(v.label, ASKING);
      assert.equal(v.reason, ASKING);
      assert.equal(v.cmd, cmd);
    }
  }
  assert.equal(view.flowVerdict(sentOf('flow-commit'), null, 'asking', { prs: [] }, NOW).asking, true);
});

test('flowVerdict: the other session states keep their rows, with no asking flag', () => {
  const run = (cmd, l, session, now = NOW, o = {}) => view.flowVerdict(sentOf(cmd, o), l, session, { prs: [] }, now);
  const busy = run('flow-pr', lcl({ ahead: 1 }), 'busy');
  assert.deepEqual([busy.state, busy.reason, busy.label, busy.asking], ['running', 'The pi session is working', 'creating pull request…', undefined]);
  assert.equal(run('flow-commit', lcl({ files: [{ path: 'a', status: 'M' }] }), 'idle').state, 'attention');
  assert.equal(run('flow-pr', lcl({ ahead: 1 }), 'closed').state, 'attention');
  assert.equal(run('flow-base', lcl({ branch: 'main' }), undefined).asking, undefined);
  assert.equal(run('flow-base', lcl({ branch: 'task' }), 'unknown', NOW + 16 * 60_000).state, 'attention');
});

test('queueFlags: an asking verdict makes the repo wait for the user, and nothing else changes', () => {
  const asking = view.flowVerdict(sentOf('flow-commit'), lcl(), 'asking', { prs: [] }, NOW);
  assert.deepEqual(view.queueFlags(lcl(), null, asking, { now: NOW }), { waiting: { state: 'needs-input', next: 'Answer the question in the pi session' } });
  const queue = workQueue([{ id: 'a', name: 'demo', dirty: true, unpushed: false, waiting: { state: 'needs-input', next: 'Answer the question in the pi session' } }]);
  assert.deepEqual(queue.map((a) => [a.kind, a.state, a.next]), [['waiting', 'needs-input', 'Answer the question in the pi session']]);
});

test('queueFlags: running without asking, attention, no verdict and a declared state behave as before', () => {
  const running = view.flowVerdict(sentOf('flow-pr'), lcl({ ahead: 1 }), 'busy', { prs: [] }, NOW);
  assert.deepEqual(view.queueFlags(lcl(), null, running, { now: NOW }), {});
  const attn = { state: 'attention', reason: 'No new commit', cmd: 'flow-commit' };
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
    setTimeout: () => 0,
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
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8'), ctx);
  return { get: (name) => vm.runInContext(name, ctx), calls, answers };
}
const R = { id: 'abc', name: 'demo' };
const ASK_TEXT = 'Review consent\n<b onmouseover="x()">1. Review this change</b>\nEnter confirm · Esc cancel';
function asking(page) {
  const S = page.get('S');
  S.local[R.id] = lcl({ files: [{ path: 'a.txt', status: 'M', untracked: false }] });
  S.prs[R.id] = { prs: [], stale: null, repo: { url: 'https://github.com/o/demo' } };
  S.sent[R.id] = sentOf('flow-commit', { at: Date.now() - 40 * 60_000 });
  return S;
}

test('page: polling an asking session keeps the record, stores the ask text and only ever reads', async () => {
  const page = loadPage();
  await new Promise((r) => setImmediate(r));
  page.calls.length = 0;
  const S = asking(page);
  page.answers['/api/pi-status?id=abc'] = { state: 'asking', ask: ASK_TEXT };
  await page.get('loadPiStatus')('abc');
  assert.equal(S.pistatus.abc, 'asking');
  assert.equal(S.piask.abc, ASK_TEXT);
  assert.ok(S.sent.abc, 'the record is kept');
  const v = page.get('verdictOf')(R);
  assert.deepEqual([v.state, v.asking], ['running', true]);
  assert.equal(page.calls.every((c) => c.method === 'GET' && !c.url.startsWith('/api/pi?')), true);
  assert.equal(page.calls.some((c) => c.url === '/api/pi'), false);
  page.answers['/api/pi-status?id=abc'] = { state: 'idle' };
  await page.get('loadPiStatus')('abc');
  assert.equal(S.piask.abc, undefined, 'the ask text goes away with the dialog');
});

test('page: the card of an asking session shows a static highlighted line with the escaped ask text as tooltip', () => {
  const page = loadPage();
  const S = asking(page);
  S.pistatus.abc = 'asking';
  S.piask.abc = ASK_TEXT;
  const v = page.get('verdictOf')(R);
  const row = page.get('verdictRow')(R, v);
  assert.match(row, /^<div class="ask-line" role="status" aria-live="polite" title="[^"<>]*">waiting for your answer in the session<\/div>$/);
  assert.equal(row.includes('<b'), false, 'never HTML');
  assert.ok(row.includes('&lt;b onmouseover=&quot;x()&quot;&gt;'));
  assert.equal(/pulse-dot|class="ell"|animation|committing/.test(row), false);
  const card = page.get('repoCard')(R, false, v);
  assert.ok(card.includes(row));
  assert.equal(card.includes('verdict-line'), false);
  assert.match(card, /<button data-act="pi" data-id="abc" data-cmd="flow-commit"[^>]* disabled>/);
  assert.equal(card.includes('Needs attention'), false);
});

test('page: an asking verdict without ask text still shows the line, with a plain tooltip', () => {
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

test('page: dismissing or restarting a record forgets the ask text', () => {
  const page = loadPage();
  const S = asking(page);
  S.piask.abc = ASK_TEXT;
  page.get('clearSent')('abc');
  assert.equal(S.piask.abc, undefined);
});
