'use strict';
// RP18 in the real public/app.js (vm with a stubbed DOM): the in-progress state of every command, the disabled
// buttons, the staging bar, the retry label, the escaped tail, and the refresh when a session finishes.
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
      const body = opts && opts.body ? JSON.parse(opts.body) : null;
      calls.push({ url, body });
      const answer = typeof answers[url] === 'function' ? await answers[url]() : answers[url];
      if (!answer) throw new Error('offline');
      return { ok: true, json: async () => answer };
    },
  });
  ctx.window = ctx;
  ctx.RepoPanelView = require('../public/view.js');
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8'), ctx);
  return { get: (name) => vm.runInContext(name, ctx), calls, answers };
}

const R = { id: 'abc', name: 'demo' };
const file = { path: 'a.txt', status: 'M', untracked: false };
const local = (o = {}) => ({ branch: 'task', detached: false, upstream: 'origin/task', noUpstream: false, ahead: 0, behind: 0, files: [], added: 0, deleted: 0, head: 'h1', inProgress: null, base: 'main', stagedCount: 0, stagedPaths: [], ...o });
const prOf = (o = {}) => ({ number: 7, title: 'T', url: 'https://github.com/o/demo/pull/7', head: 'task', base: 'main', ready: true, blockedReason: '', mergeStateStatus: 'CLEAN', isDraft: false, reviewDecision: null, checks: { state: 'failed', total: 1, passed: 0, failed: 1, pending: 0, failedRuns: ['123'], items: [{ name: 'test', state: 'failed' }] }, ...o });

// The page's verdict of the repo, set up the way a send leaves it.
function setup(page, l, { prs = [], stale = null, sent = null, session } = {}) {
  const S = page.get('S');
  S.local[R.id] = l;
  S.prs[R.id] = { prs, stale, repo: { url: 'https://github.com/o/demo' } };
  if (sent) S.sent[R.id] = { at: Date.now() - 60_000, head: 'h1', branch: 'task', files: 0, ahead: 0, ...sent };
  if (session) S.pistatus[R.id] = session;
  return S;
}
const cardOf = (page) => page.get('repoCard')(R, false, page.get('verdictOf')(R));
const btn = (cmd, label, title, disabled = false) => `<button data-act="pi" data-id="abc" data-cmd="${cmd}" title="${title}"${disabled ? ' disabled' : ''}>${label}</button>`;

// ---------- in progress: every command ----------
test('page: while /flow-pr runs the COMMITTED card says "creating pull request…" and its button is disabled with a reason', () => {
  const page = loadPage();
  setup(page, local({ ahead: 1 }), { sent: { cmd: 'flow-pr', ahead: 1 }, session: 'busy' });
  const html = cardOf(page);
  // RP20 wraps the dot and the ellipsis in animated spans; the plain text is unchanged.
  assert.match(html.replace(/<span class="(?:pulse-dot|ell)"[^>]*>(…)?<\/span>/g, '$1'), /<div class="verdict-line" role="status" aria-live="polite" title="[^"]*">creating pull request…<\/div>/);
  assert.ok(html.includes(btn('flow-pr', '/flow-pr', 'Running /flow-pr (creating pull request…): wait for it to finish', true)), html);
});

test('page: the status line names each running command and the buttons of a dirty card are disabled', () => {
  const lines = { 'flow-commit': 'committing…', 'flow-base-stash': 'updating base branch…', 'fix-pr': 'fixing pull request…', 'put-in-conditions': 'putting repo in conditions…' };
  for (const [cmd, text] of Object.entries(lines)) {
    const page = loadPage();
    setup(page, local({ files: [file] }), { sent: { cmd }, session: 'busy' });
    const html = cardOf(page);
    assert.ok(html.replace(/<span class="(?:pulse-dot|ell)"[^>]*>(…)?<\/span>/g, '$1').includes(`>${text}</div>`), `${cmd}: ${html}`);
    assert.match(html, /data-cmd="flow-commit"[^>]* disabled>/, cmd);
  }
});

test('page: the Merge, Re-run failed and Fix with pi buttons of a PR card are disabled while a command of the repo runs', () => {
  const page = loadPage();
  const prCard = page.get('prCard');
  const running = { state: 'running', reason: 'x', label: 'creating pull request…', cmd: 'flow-pr' };
  const html = prCard(R, prOf(), {}, running);
  assert.match(html, /<button class="merge" data-act="merge" [^>]*disabled\s*title="Running \/flow-pr \(creating pull request…\): wait for it to finish">|<button class="merge" data-act="merge"[^>]*disabled[^>]*title="Running \/flow-pr/);
  assert.match(html, /data-act="rerun"[^>]*disabled[^>]*title="Running \/flow-pr/);
  assert.match(html, /data-cmd="fix-pr" data-pr="7" title="Running \/flow-pr \(creating pull request…\): wait for it to finish" disabled>Fix with pi<\/button>/);
});

test('page: nothing running keeps the PR card and the enabled buttons exactly as before', () => {
  const page = loadPage();
  const html = page.get('prCard')(R, prOf(), {});
  assert.match(html, /<button class="merge" data-act="merge" data-id="abc" data-n="7"\s+title="Merge into main">Merge · /);
  assert.match(html, /<button data-act="rerun" data-id="abc" data-n="7"\s*>Re-run failed<\/button>/);
  assert.ok(html.includes('<button data-act="pi" data-id="abc" data-cmd="fix-pr" data-pr="7" title="Ask the open pi session to find out why the checks failed and fix it (it will not commit or push)">Fix with pi</button>'));
  const page2 = loadPage();
  setup(page2, local({ files: [file] }));
  assert.ok(cardOf(page2).includes(btn('flow-commit', '/flow-commit', 'Send /flow-commit to the open pi session of this repo')));
});

// ---------- staged files ----------
test('page: staged files on a dirty card show the bar and /flow-commit --unstage instead of /flow-commit', () => {
  const page = loadPage();
  setup(page, local({ files: [file, file, file], stagedCount: 3, stagedPaths: ['a.txt', 'b.txt', 'c.txt'] }));
  const html = cardOf(page);
  assert.ok(html.includes('3 files are staged: /flow-commit needs an empty index. The button clears the index (git reset, your changes stay in the working tree) and then continues with the normal commit in the same run.'), html);
  assert.ok(!html.includes('then you run /flow-commit'), 'the button does not ask for a second /flow-commit run');
  assert.match(html, /<div class="staged-bar" title="a\.txt\nb\.txt\nc\.txt">/);
  assert.match(html, /data-cmd="flow-commit-unstage" title="[^"]*">\/flow-commit --unstage<\/button>/);
  assert.equal(html.includes('data-cmd="flow-commit"'), false);
  const one = loadPage();
  setup(one, local({ files: [file], stagedCount: 1, stagedPaths: ['a.txt'] }));
  assert.ok(cardOf(one).includes('1 file is staged: /flow-commit needs an empty index.'));
});

test('page: no staging bar for an empty index, a clean card or a card that needs manual action', () => {
  for (const l of [local({ files: [file] }), local({ ahead: 1, stagedCount: 2, stagedPaths: ['a', 'b'] }), local({ files: [file], stagedCount: 1, stagedPaths: ['a'], inProgress: 'merge' })]) {
    const page = loadPage();
    setup(page, l);
    assert.equal(cardOf(page).includes('staged-bar'), false);
  }
});

// ---------- attention: retry and why ----------
test('page: a failed /flow-commit labels the button "Retry /flow-commit" and shows the reason; staged files give "Retry … --unstage"', () => {
  const page = loadPage();
  const S = setup(page, local({ files: [file, file] }), { sent: { cmd: 'flow-commit', files: 2 }, session: 'idle' });
  const html = cardOf(page);
  assert.match(html, /Needs attention: 2 files still uncommitted after \/flow-commit/);
  assert.ok(html.includes('>Retry /flow-commit</button>'), html);
  S.local[R.id] = local({ files: [file, file], stagedCount: 2, stagedPaths: ['a', 'b'] });
  assert.ok(cardOf(page).includes('>Retry /flow-commit --unstage</button>'));
});

test('page: the tail of the session screen is shown escaped, small, with the full text as a tooltip', () => {
  const page = loadPage();
  const S = setup(page, local({ files: [file] }), { sent: { cmd: 'flow-commit', files: 1 }, session: 'idle' });
  S.pitail[R.id] = 'Index is not empty <img src=x onerror="alert(1)">\nrun "git reset"';
  const html = cardOf(page);
  assert.equal(html.includes('<img'), false);
  assert.match(html, /<div class="attn-tail" title="Index is not empty &lt;img src=x onerror=&quot;alert\(1\)&quot;&gt;\nrun &quot;git reset&quot;">Index is not empty &lt;img src=x onerror=&quot;alert\(1\)&quot;&gt;\nrun &quot;git reset&quot;<\/div>/);
  S.pitail[R.id] = '';
  assert.equal(cardOf(page).includes('attn-tail'), false);
});

test('page: a failed /flow-pr or /flow-base shows its reason and keeps its normal button (no Retry label)', () => {
  const page = loadPage();
  setup(page, local({ ahead: 1 }), { sent: { cmd: 'flow-pr', ahead: 1 }, session: 'idle' });
  const html = cardOf(page);
  assert.match(html, /Needs attention: No open pull request for task after \/flow-pr/);
  assert.ok(html.includes(btn('flow-pr', '/flow-pr', 'Send /flow-pr to the open pi session of this repo')), html);
});

// ---------- recording what was sent ----------
const ok = { sent: true, confirmed: true };
const el = (dataset) => ({ dataset, disabled: false });

test('page: every flow command records { cmd, at, head, branch, files, ahead } from a fresh /api/local read', async () => {
  for (const cmd of ['flow-commit', 'flow-commit-unstage', 'flow-pr', 'flow-base', 'flow-base-stash']) {
    const page = loadPage();
    page.answers['/api/pi'] = ok;
    page.answers['/api/local?id=abc'] = local({ files: [file, file], ahead: 3, head: 'h9' });
    await page.get('ACTIONS').pi(el({ id: 'abc', cmd }));
    const rec = page.get('S').sent.abc;
    assert.deepEqual([rec.cmd, rec.head, rec.branch, rec.files, rec.ahead], [cmd, 'h9', 'task', 2, 3], cmd);
    assert.equal(typeof rec.at, 'number');
    const order = page.calls.map((c) => c.url);
    assert.ok(order.indexOf('/api/local?id=abc') < order.indexOf('/api/pi'), `${cmd}: baseline before sending`);
    assert.deepEqual(page.calls.find((c) => c.url === '/api/pi').body, { id: 'abc', command: cmd });
  }
});

test('page: fix-pr and put-in-conditions record only { cmd, at } and read no baseline; nothing is recorded when the send fails', async () => {
  const page = loadPage();
  await quiet(page);
  page.answers['/api/pi'] = ok;
  await page.get('ACTIONS').pi(el({ id: 'abc', cmd: 'fix-pr', pr: '7' }));
  assert.deepEqual(Object.keys(page.get('S').sent.abc).sort(), ['at', 'cmd']);
  assert.equal(page.calls.some((c) => c.url.startsWith('/api/local')), false);
  const other = loadPage();
  other.answers['/api/pi'] = ok;
  await other.get('ACTIONS')['put-in-conditions'](el({ id: 'abc' }));
  assert.deepEqual(Object.keys(other.get('S').sent.abc).sort(), ['at', 'cmd']);
  assert.equal(other.get('S').sent.abc.cmd, 'put-in-conditions');
  const failed = loadPage(); // no /api/pi answer: the request fails
  failed.answers['/api/local?id=abc'] = local();
  await failed.get('ACTIONS').pi(el({ id: 'abc', cmd: 'flow-pr' }));
  assert.deepEqual(Object.keys(failed.get('S').sent), []);
});

test('page: dismissing an attention bar clears the record, the session state and the tail', () => {
  const page = loadPage();
  const S = setup(page, local({ files: [file] }), { sent: { cmd: 'flow-commit' }, session: 'idle' });
  S.pitail[R.id] = 'x';
  page.get('ACTIONS')['dismiss-sent']({ dataset: { id: 'abc' } });
  assert.deepEqual([S.sent.abc, S.pistatus.abc, S.pitail.abc], [undefined, undefined, undefined]);
});

// ---------- when the session finishes ----------
const refreshAnswers = (page, l) => {
  page.answers['/api/local?id=abc'] = l;
  page.answers['/api/prs?id=abc'] = { prs: [], stale: null, repo: { url: 'https://github.com/o/demo' } };
  page.answers['/api/roadmap?id=abc'] = null;
};
const urls = (page) => page.calls.map((c) => c.url);
// The page starts requests of its own when it loads: let them settle and forget them.
const quiet = async (page) => { await new Promise((r) => setImmediate(r)); page.calls.length = 0; };

test('page: a session going from busy to idle refreshes the repo at once, and a flow-pr that worked drops its record', async () => {
  const page = loadPage();
  await quiet(page);
  const S = setup(page, local({ ahead: 1 }), { sent: { cmd: 'flow-pr', ahead: 1 }, session: 'busy' });
  refreshAnswers(page, local());
  page.answers['/api/prs?id=abc'] = { prs: [prOf({ ready: false })], stale: null, repo: { url: 'https://github.com/o/demo' } };
  page.answers['/api/pi-status?id=abc'] = { state: 'idle' };
  await page.get('loadPiStatus')('abc');
  assert.ok(urls(page).includes('/api/local?id=abc'));
  assert.ok(urls(page).includes('/api/prs?id=abc'));
  assert.equal(page.get('verdictOf')(R), null);
  assert.equal(S.sent.abc, undefined); // ok: the record is gone
});

test('page: the card keeps saying it is running until the refreshed data arrives (no false attention in between)', async () => {
  const page = loadPage();
  const S = setup(page, local({ ahead: 1 }), { sent: { cmd: 'flow-pr', ahead: 1 }, session: 'busy' });
  refreshAnswers(page, local());
  let during = null;
  let stateDuring = null;
  page.answers['/api/prs?id=abc'] = async () => { during = page.get('verdictOf')(R); stateDuring = S.pistatus.abc; return { prs: [], stale: null, repo: {} }; };
  page.answers['/api/pi-status?id=abc'] = { state: 'idle' };
  await page.get('loadPiStatus')('abc');
  assert.equal(stateDuring, 'busy');
  assert.equal(during.state, 'running');
  assert.equal(S.pistatus.abc, 'idle');
});

test('page: a session that stays idle, or was never busy, triggers no refresh', async () => {
  const page = loadPage();
  await quiet(page);
  setup(page, local({ ahead: 1 }), { sent: { cmd: 'flow-pr', ahead: 1, at: Date.now() }, session: 'idle' });
  page.answers['/api/pi-status?id=abc'] = { state: 'idle' };
  await page.get('loadPiStatus')('abc');
  assert.deepEqual(urls(page), ['/api/pi-status?id=abc']);
});

test('page: the status is polled only for repos that have a record', async () => {
  const page = loadPage();
  await quiet(page);
  await page.get('loadPiStatus')('abc');
  assert.deepEqual(page.calls, []);
});

test('page: fix-pr is dropped once its session is idle after the refresh, with no verdict', async () => {
  const page = loadPage();
  await quiet(page);
  const S = setup(page, local(), { sent: { cmd: 'fix-pr' }, session: 'busy' });
  refreshAnswers(page, local({ files: [file] }));
  page.answers['/api/pi-status?id=abc'] = { state: 'idle' };
  await page.get('loadPiStatus')('abc');
  assert.equal(page.get('verdictOf')(R), null);
  assert.equal(S.sent.abc, undefined);
});

test('page: the screen tail is fetched once, and only when the verdict is attention', async () => {
  const page = loadPage();
  await quiet(page);
  const S = setup(page, local({ files: [file] }), { sent: { cmd: 'flow-commit', files: 1 }, session: 'idle' });
  page.answers['/api/pi-status?id=abc'] = { state: 'idle' };
  page.answers['/api/pi-status?id=abc&tail=1'] = { state: 'idle', tail: 'Index is not empty' };
  await page.get('loadPiStatus')('abc');
  assert.equal(S.pitail.abc, 'Index is not empty');
  await page.get('loadPiStatus')('abc');
  assert.equal(urls(page).filter((u) => u.endsWith('tail=1')).length, 1);
  const calm = loadPage();
  await quiet(calm);
  setup(calm, local({ files: [file] }), { sent: { cmd: 'flow-commit', files: 1, at: Date.now() }, session: 'idle' });
  calm.answers['/api/pi-status?id=abc'] = { state: 'busy' };
  await calm.get('loadPiStatus')('abc');
  assert.equal(urls(calm).some((u) => u.endsWith('tail=1')), false); // running: nothing to explain
});
