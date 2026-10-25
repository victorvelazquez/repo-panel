'use strict';
// Renders the real public/app.js in a vm with a stubbed DOM, to check the markup of the flow buttons and the
// request the pi buttons send. Nothing here touches the network or a browser.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// An element that accepts any property, call or assignment.
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
      const answer = answers[url];
      if (!answer) throw new Error('offline');
      return { ok: true, json: async () => answer };
    },
  });
  ctx.window = ctx;
  ctx.RepoPanelView = require('../public/view.js');
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8'), ctx);
  const get = (name) => vm.runInContext(name, ctx);
  return { get, calls, answers };
}

const R = { id: 'abc', name: 'demo' };
const file = { path: 'a.txt', status: 'M', untracked: false };
const local = (o = {}) => ({ branch: 'task', detached: false, upstream: 'origin/task', noUpstream: false, ahead: 0, behind: 0, files: [], added: 0, deleted: 0, head: 'h1', inProgress: null, base: 'main', ...o });
const card = (page, l, p, verdict = null) => {
  const S = page.get('S');
  S.local[R.id] = l;
  S.prs[R.id] = { prs: [], stale: null, repo: { url: 'https://github.com/o/demo' }, ...p };
  return page.get('repoCard')(R, false, verdict);
};
const prOf = (checks, o = {}) => ({ number: 7, title: 'T', url: 'https://github.com/o/demo/pull/7', head: 'task', base: 'main', ready: false, blockedReason: 'x', mergeStateStatus: 'BLOCKED', isDraft: false, reviewDecision: null, checks: { total: 1, passed: 0, failed: 1, pending: 0, failedRuns: [], items: [{ name: 'test', state: 'failed' }], ...checks }, ...o });

const button = (cmd, label, title = `Send /${cmd} to the open pi session of this repo`) => `<button data-act="pi" data-id="abc" data-cmd="${cmd}" title="${title}">${label}</button>`;

test('page: the /flow-commit button on a Changes card keeps its markup', () => {
  const html = card(loadPage(), local({ files: [file] }), {});
  assert.ok(html.includes(`<div class="actions">${button('flow-commit', '/flow-commit')}</div>`), html);
  assert.equal(html.includes('flow-pr'), false);
});

test('page: the /flow-pr button on a Committed card keeps its markup, and its update label', () => {
  const page = loadPage();
  const html = card(page, local({ ahead: 1 }), {});
  assert.ok(html.includes(`<div class="actions">${button('flow-pr', '/flow-pr')}</div>`), html);
  const update = card(page, local({ ahead: 1 }), { prs: [prOf({ state: 'failed' })] });
  assert.ok(update.includes(`<div class="actions">${button('flow-pr', '/flow-pr (update PR)')}</div>`), update);
});

test('page: a stale clean card offers /flow-base with a tooltip, and the red chip points at the button', () => {
  const html = card(loadPage(), local({ currentGone: true }), { stale: { via: 'merged', pr: 7, reason: 'Merged: run /flow-base' } });
  const m = /<button data-act="pi" data-id="abc" data-cmd="flow-base" title="([^"]+)">\/flow-base<\/button>/.exec(html);
  assert.ok(m, html);
  assert.match(m[1], /fresh, updated base branch/);
  assert.match(html, /<span class="chip red" title="[^"]*Press the \/flow-base button to start[^"]*">Merged: run \/flow-base<\/span>/);
  assert.equal(/class="chip red" title="[^"]*--stash/.test(html), false);
});

test('page: a stale card with changes offers /flow-base --stash with a tooltip and no /flow-commit', () => {
  const html = card(loadPage(), local({ files: [file] }), { stale: { via: 'merged', pr: 7, reason: 'Merged: run /flow-base' } });
  const m = /<button data-act="pi" data-id="abc" data-cmd="flow-base-stash" title="([^"]+)">\/flow-base --stash<\/button>/.exec(html);
  assert.ok(m, html);
  assert.match(m[1], /refuses and changes nothing/);
  assert.equal(html.includes('data-cmd="flow-commit"'), false);
  assert.equal(html.includes('data-cmd="flow-base"'), false);
  assert.match(html, /<span class="chip red" title="[^"]*Press the \/flow-base --stash button[^"]*uncommitted changes[^"]*">/);
});

test('page: the "Show /flow-commit anyway" menu item is offered on a dirty card, but not on a stale dirty one', () => {
  const page = loadPage();
  const open = (l, p) => { page.get('S').menu = 'abc|repo'; return card(page, l, p); };
  page.get('S').state[R.id] = { available: true, state: 'needs-input', next: 'x', at: new Date().toISOString(), head: 'h1' };
  assert.ok(open(local({ files: [file] }), {}).includes('data-act="show-commit"'));
  assert.equal(open(local({ files: [file] }), { stale: { via: 'merged', pr: 7, reason: 'Merged: run /flow-base' } }).includes('show-commit'), false);
});

test('page: a failed PR shows "Fix with pi" (also with no run to re-run) and "Re-run failed" only when there are runs', () => {
  const page = loadPage();
  const prCard = page.get('prCard');
  const fix = '<button data-act="pi" data-id="abc" data-cmd="fix-pr" data-pr="7" title="Ask the open pi session to find out why the checks failed and fix it (it will not commit or push)">Fix with pi</button>';
  const noRuns = prCard(R, prOf({ state: 'failed' }), {});
  assert.ok(noRuns.includes(fix), noRuns);
  assert.equal(noRuns.includes('Re-run failed'), false);
  const runs = prCard(R, prOf({ state: 'failed', failedRuns: ['123'] }), {});
  assert.ok(runs.includes(fix));
  assert.match(runs, /<button data-act="rerun" data-id="abc" data-n="7"\s*>Re-run failed<\/button>/);
  for (const state of ['pending', 'success']) assert.equal(prCard(R, prOf({ state, failed: 0, failedRuns: [] }), {}).includes('Fix with pi'), false, state);
});

test('page: the pi buttons post the command, and only the fix-pr one carries its pr number', async () => {
  const page = loadPage();
  page.answers['/api/pi'] = { sent: true, confirmed: true };
  page.answers['/api/local?id=abc'] = local({ files: [file] });
  const ACTIONS = page.get('ACTIONS');
  const el = (dataset) => ({ dataset, disabled: false });
  await ACTIONS.pi(el({ id: 'abc', cmd: 'flow-commit' }));
  await ACTIONS.pi(el({ id: 'abc', cmd: 'fix-pr', pr: '7' }));
  const posts = page.calls.filter((c) => c.url === '/api/pi').map((c) => c.body);
  assert.deepEqual(posts, [{ id: 'abc', command: 'flow-commit' }, { id: 'abc', command: 'fix-pr', pr: 7 }]);
});

test('page: the stash button posts only its key, after reading the baseline of its verdict', async () => {
  const page = loadPage();
  page.answers['/api/pi'] = { sent: true, confirmed: true };
  page.answers['/api/local?id=abc'] = local({ files: [file] });
  await page.get('ACTIONS').pi({ dataset: { id: 'abc', cmd: 'flow-base-stash' }, disabled: false });
  assert.deepEqual(page.calls.filter((c) => c.url === '/api/pi' || c.url.startsWith('/api/local')).map((c) => [c.url, c.body]), [['/api/local?id=abc', null], ['/api/pi', { id: 'abc', command: 'flow-base-stash' }]]);
  assert.equal(page.get('S').sent.abc.cmd, 'flow-base-stash');
});
