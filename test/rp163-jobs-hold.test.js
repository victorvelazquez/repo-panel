'use strict';
// RP163 (S53): the page uses the count of background jobs that the server leaves in the row of the Summary (RP161, `session.jobs`). The delivery buttons (/flow-commit, /flow-pr, /flow-base, /flow-next, Fix CI) stay held while a
// session waits for background jobs, with the reason «N background jobs are running» (1: «1 background job is running»), whatever the live state of the session is (it is free between the turn that launched the job and the notice
// that it ended). The rule is the one of RP159 (V.deliveryHold): the number is one more cause, after the order on its way, a command running and the session asking or working. «Show /flow-commit anyway» lifts the hold of
// /flow-commit only, as it does for a busy session. Only a positive safe integer holds; a closed session (the live state of the page says so) holds nothing even if the row, up to 20 s old, still carries the number. The page
// releases by itself when the next row comes without the number. Merge is not held (it does not talk to the session).
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { appSource } = require('./pagesrc.js');
const V = require('../public/view.js');
const R = require('../public/resumen.js');

// ---------- the rule (pure) ----------
test('h1: jobsHold says how many; one is singular; the cap is 99; only a positive safe integer holds', () => {
  assert.equal(V.jobsHold(1), '1 background job is running');
  assert.equal(V.jobsHold(2), '2 background jobs are running');
  assert.equal(V.jobsHold(99), '99 background jobs are running');
  assert.equal(V.jobsHold(100), '99 background jobs are running');
  assert.equal(V.jobsHold(Number.MAX_SAFE_INTEGER), '99 background jobs are running');
  for (const bad of [0, -1, 1.5, NaN, Infinity, -Infinity, '2', null, undefined, {}, [], true, false, 1e21]) assert.equal(V.jobsHold(bad), '', String(bad));
});

test('h2: deliveryHold: the jobs hold comes AFTER the order on its way, a command running, the session asking and the session working (their reason wins), and alone when the session is free', () => {
  assert.equal(V.deliveryHold({ jobs: 2, session: 'idle' }), '2 background jobs are running');
  assert.equal(V.deliveryHold({ jobs: 2 }), '2 background jobs are running');
  assert.equal(V.deliveryHold({ jobs: 2, session: 'closed' }), '2 background jobs are running', 'the closed session is handled where the number is read, not here');
  assert.match(V.deliveryHold({ jobs: 2, session: 'busy' }), /The session is working/);
  assert.match(V.deliveryHold({ jobs: 2, session: 'asking' }), /waiting for your answer/);
  assert.match(V.deliveryHold({ jobs: 2, sending: 'flow-next' }), /Sending the order/);
  assert.match(V.deliveryHold({ jobs: 2, running: { cmd: 'flow-base', label: 'updating base branch…' } }), /Running \/flow-base/);
  for (const jobs of [0, -1, 1.5, NaN, '3', null, undefined, {}, true]) assert.equal(V.deliveryHold({ jobs, session: 'idle' }), '', String(jobs));
});

// ---------- flowButtons ----------
const local = (o = {}) => ({ files: [], stagedCount: 0, branch: 'feat/x', base: 'main', ahead: 1, behind: 0, head: 'abc', noUpstream: false, lastChangeMs: 0, ...o });
const FILES = [{ path: 'a.js', status: 'M', added: 1, deleted: 0 }];
const open = (o = {}) => ({ prs: [], stale: null, ...o });
const one = (arr) => { assert.equal(arr.length, 1, JSON.stringify(arr)); return arr[0]; };

test('b1: with jobs pending and the session free: /flow-commit, /flow-pr, /flow-base and /flow-base --stash are disabled with the jobs reason; with none they are enabled', () => {
  const reason = '2 background jobs are running';
  const commit = one(V.flowButtons(local({ files: FILES }), open(), {}, { session: 'idle', jobs: 2 }));
  assert.equal(commit.cmd, 'flow-commit');
  assert.equal(commit.disabled, true);
  assert.equal(commit.reason, reason);
  const pr = one(V.flowButtons(local(), open(), {}, { session: 'idle', jobs: 2 }));
  assert.equal(pr.cmd, 'flow-pr');
  assert.equal(pr.disabled, true);
  assert.equal(pr.reason, reason);
  const merged = { via: 'merged', pr: 7, reason: 'Merged: run /flow-base' };
  const base = one(V.flowButtons(local({ ahead: 0 }), open({ stale: merged }), {}, { session: 'idle', jobs: 2 }));
  assert.equal(base.cmd, 'flow-base');
  assert.equal(base.disabled, true);
  const stash = one(V.flowButtons(local({ files: FILES }), open({ stale: merged }), {}, { session: 'idle', jobs: 2 }));
  assert.equal(stash.cmd, 'flow-base-stash');
  assert.equal(stash.disabled, true);
  for (const jobs of [0, undefined, null, -3, 1.5, '2']) {
    assert.equal(one(V.flowButtons(local({ files: FILES }), open(), {}, { session: 'idle', jobs })).disabled, undefined, `commit ${String(jobs)}`);
    assert.equal(one(V.flowButtons(local(), open(), {}, { session: 'idle', jobs })).disabled, undefined, `pr ${String(jobs)}`);
  }
});

test('b2: «Show /flow-commit anyway» lifts the hold of /flow-commit only: /flow-pr and /flow-base stay held; and the menu item shows up while the jobs hold it', () => {
  assert.equal(one(V.flowButtons(local({ files: FILES }), open(), {}, { session: 'idle', jobs: 2, override: true })).disabled, undefined);
  assert.equal(one(V.flowButtons(local(), open(), {}, { session: 'idle', jobs: 2, override: true })).disabled, true, '/flow-pr is not lifted');
  assert.deepEqual(V.commitOverrideItem({}, { session: 'idle', jobs: 2 }), { act: 'show-commit', label: 'Show /flow-commit anyway' });
  assert.equal(V.commitOverrideItem({}, { session: 'idle', jobs: 0 }), null);
  assert.equal(V.commitOverrideItem({}, { session: 'idle' }), null);
  assert.equal(V.commitOverrideItem({}, { session: 'idle', jobs: 2, override: true }), null, 'already lifted');
  assert.equal(V.commitOverrideItem({}, { session: 'idle', jobs: 2, stale: true }), null, 'a stale repo offers /flow-base --stash instead');
});

test('b3: the reason of a running command and the reason of a busy session keep winning over the jobs reason', () => {
  const run = { cmd: 'flow-base', label: 'updating base branch…' };
  assert.match(one(V.flowButtons(local(), open(), {}, { running: run, session: 'idle', jobs: 2 })).reason, /Running \/flow-base/);
  assert.equal(one(V.flowButtons(local(), open(), {}, { session: 'busy', jobs: 2 })).reason, 'the session is still working');
});

// ---------- the Summary card ----------
const row = (name, session, action, o = {}) => ({ id: `id-${name}`, name, group: 'G', room: null, branch: 'main', needs: false, rank: 9, progress: { total: null }, next: { id: 'X1', entrega: 'A task' }, blocking: [], lastMovement: {}, session, action, ...o });
const btn = (html, cmd) => { const m = new RegExp(`<button[^>]*data-cmd="${cmd}"[^>]*>`).exec(html); assert.ok(m, `a button for ${cmd}`); return m[0]; };
const card = (r, ctx = {}) => R.summaryView({ rows: [r], generatedAt: 'x' }, ctx);
const START = { kind: 'start', label: 'Start X1', pr: null };
const BRANCH = { kind: 'branch', label: 'Start from a fresh base branch', pr: null };

test('s1: a card whose row carries jobs holds /flow-next and /flow-base with the jobs reason as the title, even when the page gives no hold; the row of always holds nothing', () => {
  for (const [action, cmd] of [[START, 'flow-next'], [BRANCH, 'flow-base']]) {
    const held = btn(card(row('a', { state: 'free', jobs: 3 }, action), {}), cmd);
    assert.match(held, / disabled/, cmd);
    assert.match(held, /title="3 background jobs are running"/, cmd);
    assert.doesNotMatch(btn(card(row('a', { state: 'free' }, action), {}), cmd), / disabled/, `${cmd}: no jobs`);
    for (const jobs of [0, -1, 1.5, '2', null, NaN]) assert.doesNotMatch(btn(card(row('a', { state: 'free', jobs }, action), {}), cmd), / disabled/, `${cmd} ${String(jobs)}`);
  }
});

test('s2: when the page decides (holdFor), the page wins: it already counts the jobs of the row and releases them when the session closed', () => {
  assert.doesNotMatch(btn(card(row('a', { state: 'free', jobs: 3 }, START), { holdFor: () => '' }), 'flow-next'), / disabled/);
  assert.match(btn(card(row('a', { state: 'free', jobs: 3 }, START), { holdFor: () => 'Because the page says so' }), 'flow-next'), /title="Because the page says so"/);
});

// ---------- the page ----------
function element(extra = {}) {
  const el = {
    html: '', hidden: false, dataset: {}, disabled: false, value: '', checked: false, textContent: '', title: '', placeholder: '', attrs: {}, listeners: {}, children: [], open: false,
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    style: { setProperty(k, v) { el.style[k] = v; } },
    addEventListener(t, fn) { (el.listeners[t] ||= []).push(fn); }, setAttribute(k, v) { el.attrs[k] = v; }, querySelector: () => null, querySelectorAll: () => [], closest: () => null,
    showModal() {}, close() {}, focus() {}, append(c) { el.children.push(c); },
    get innerHTML() { return el.html; }, set innerHTML(v) { el.html = String(v); }, ...extra,
  };
  return el;
}
const ID = 'abcdef0123';
async function boot() {
  const els = {};
  const frames = [];
  const tabEls = ['summary', 'work', 'conformity', 'settings'].map((t) => element({ dataset: { tab: t } }));
  const get = (sel) => (els[sel] ||= (sel === 'meta[name=token]' ? element({ content: 'token' }) : element()));
  get('#sumLayout').clientWidth = 1200;
  const doc = { hidden: false, querySelector: get, querySelectorAll: (s) => (String(s).includes('data-tab') ? tabEls : []), addEventListener() {}, createElement: () => element(), body: element(), activeElement: null };
  const sandbox = {
    console, document: doc, TextDecoder, AbortController, confirm: () => true, location: { hash: '', pathname: '/', search: '' }, history: { pushState() {}, replaceState() {}, back() {} },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    requestAnimationFrame: (cb) => { frames.push(cb); return frames.length; }, setInterval: () => 0, setTimeout: () => 0, clearTimeout: () => {}, clearInterval: () => {},
    fetch: (url) => (String(url).startsWith('/api/config') ? Promise.resolve({ ok: true, json: async () => ({ groups: [{ name: 'G', repos: [{ id: ID, name: 'repo-a', path: 'p' }] }], snoozed: [], dismissed: [], rooms: [], roomIssues: [] }) }) : new Promise(() => {})),
  };
  const ctx = vm.createContext(sandbox);
  ctx.window = ctx;
  ctx.addEventListener = () => {};
  ctx.RepoPanelView = V;
  ctx.RepoPanelResumen = R;
  vm.runInContext(appSource(), ctx);
  const flush = () => { while (frames.length) frames.shift()(); };
  const tick = async (n = 10) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); flush(); };
  await tick();
  return {
    get, tick, run: (code) => vm.runInContext(code, ctx),
    summary: async (action, session) => { vm.runInContext(`S.summary = ${JSON.stringify({ rows: [row('repo-a', session, action, { id: ID })], generatedAt: 'x' })}; draw()`, ctx); await tick(); },
    redraw: async () => { vm.runInContext('draw()', ctx); await tick(); },
    html: () => get('#summary').html,
    app: () => get('#app').html,
  };
}

test('p1: THE CASE: the session is FREE (it ended its turn after launching a job) and the row says 2 jobs: /flow-next and /flow-base stay disabled with the reason; the next row with no jobs releases them', async () => {
  const page = await boot();
  page.run(`S.rpc['${ID}'] = { state: 'idle' }`);
  for (const [action, cmd] of [[START, 'flow-next'], [BRANCH, 'flow-base']]) {
    await page.summary(action, { state: 'free', jobs: 2 });
    assert.match(btn(page.html(), cmd), / disabled/, `${cmd} with jobs`);
    assert.match(btn(page.html(), cmd), /title="2 background jobs are running"/, cmd);
    await page.summary(action, { state: 'free' });
    assert.doesNotMatch(btn(page.html(), cmd), / disabled/, `${cmd} released`);
  }
});

test('p2: the live state wins: a session the page knows is closed has no jobs left even if the row (up to 20 s old) still carries the number; a busy session shows ITS reason', async () => {
  const page = await boot();
  await page.summary(START, { state: 'free', jobs: 2 });
  page.run(`S.rpc['${ID}'] = { state: 'closed' }`);
  await page.redraw();
  assert.doesNotMatch(btn(page.html(), 'flow-next'), / disabled/, 'closed: nothing to wait for');
  page.run(`S.rpc['${ID}'] = { state: 'busy' }`);
  await page.redraw();
  assert.match(btn(page.html(), 'flow-next'), /title="The session is working: wait for it to finish"/);
  page.run(`S.rpc['${ID}'] = { state: 'idle' }`);
  await page.redraw();
  assert.match(btn(page.html(), 'flow-next'), /title="2 background jobs are running"/);
});

test('p3: ABUSE: a row with a number that is not a positive integer holds nothing, and a hostile row (no session, session not an object, jobs huge) never throws', async () => {
  const page = await boot();
  page.run(`S.rpc['${ID}'] = { state: 'idle' }`);
  for (const jobs of [0, -4, 2.5, '2', null, true, {}, [], NaN]) { await page.summary(START, { state: 'free', jobs }); assert.doesNotMatch(btn(page.html(), 'flow-next'), / disabled/, JSON.stringify(jobs)); }
  await page.summary(START, { state: 'free', jobs: 1e12 });
  assert.match(btn(page.html(), 'flow-next'), /title="99 background jobs are running"/);
  for (const session of [null, undefined, 5, 'x', [], {}]) await assert.doesNotReject(async () => { await page.summary(START, session); }, String(session));
});

test('p4: the Work tab (the board): a repo with changes shows /flow-commit disabled with the jobs reason while the session is free; «Show /flow-commit anyway» lifts it; with no jobs it is enabled', async () => {
  const page = await boot();
  page.run(`S.rpc['${ID}'] = { state: 'idle' }; S.state['${ID}'] = {}; S.prs['${ID}'] = { prs: [], stale: null }; S.local['${ID}'] = { branch: 'feat/x', base: 'main', files: [{ path: 'a.js', status: 'M', added: 1, deleted: 0 }], ahead: 0, behind: 0, head: 'a', noUpstream: false, stagedCount: 0, lastChangeMs: 0, error: null }`);
  const commit = () => btn(page.app(), 'flow-commit');
  await page.summary(START, { state: 'free', jobs: 2 });
  assert.match(commit(), / disabled/);
  assert.match(commit(), /title="2 background jobs are running"/);
  assert.doesNotMatch(page.app(), /data-act="show-commit"/, 'the menu draws its items only while it is open');
  page.run(`S.menu = '${ID}|repo'`);
  await page.redraw();
  assert.match(page.app(), /<button role="menuitem" data-act="show-commit" data-id="abcdef0123">Show \/flow-commit anyway<\/button>/, 'the menu offers the way out');
  page.run('S.menu = null');
  await page.redraw();
  page.run(`S.showCommit.add('${ID}')`);
  await page.redraw();
  assert.doesNotMatch(commit(), / disabled/, 'lifted by the person');
  page.run(`S.showCommit.delete('${ID}')`);
  await page.summary(START, { state: 'free' });
  assert.doesNotMatch(commit(), / disabled/, 'no jobs');
});

test('p5: Fix CI of a PR card also waits for the jobs; Merge never does', async () => {
  const lib = require('../lib.js');
  const RUN = (name, over = {}) => ({ __typename: 'CheckRun', name, status: 'COMPLETED', conclusion: 'SUCCESS', detailsUrl: `https://github.com/o/r/actions/runs/${name.length}1`, ...over });
  const pr = lib.enrichPr({ number: 7, title: 't', url: 'https://github.com/o/r/pull/7', headRefName: 'feat/x', baseRefName: 'main', headRefOid: 'abc', isDraft: false, isCrossRepository: false, author: { login: 'me' }, reviewDecision: null, mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', statusCheckRollup: [RUN('build'), RUN('test', { conclusion: 'FAILURE' })], additions: 1, deletions: 0, changedFiles: 1 });
  const page = await boot();
  page.run(`S.rpc['${ID}'] = { state: 'idle' }; S.state['${ID}'] = {}; S.local['${ID}'] = { branch: 'feat/x', base: 'main', files: [], ahead: 0, behind: 0, head: 'a', noUpstream: false, stagedCount: 0, lastChangeMs: 0, error: null }; S.prs['${ID}'] = { prs: [${JSON.stringify(pr)}], stale: null }`);
  const fix = () => { const m = /<button[^>]*data-cmd="fix-pr"[^>]*>/.exec(page.app()); assert.ok(m, 'a Fix CI button'); return m[0]; };
  await page.summary(START, { state: 'free', jobs: 2 });
  assert.match(fix(), / disabled/);
  assert.match(fix(), /title="2 background jobs are running"/);
  await page.summary(START, { state: 'free' });
  assert.doesNotMatch(fix(), / disabled/);
});

test('p6: the page reads the number of THE REPO it asks about (not the first row), caps it at 99 and gives 0 for a repo that has none, an unknown repo and a row that is not valid', async () => {
  const page = await boot();
  const rows = (list) => page.run(`S.summary = { rows: ${JSON.stringify(list)}, generatedAt: 'x' }`);
  rows([{ id: 'first', session: { state: 'free' } }, { id: ID, session: { state: 'free', jobs: 2 } }, { id: 'third', session: { state: 'free', jobs: 7 } }]);
  assert.equal(page.run(`jobsOfRepo('${ID}')`), 2);
  assert.equal(page.run("jobsOfRepo('first')"), 0);
  assert.equal(page.run("jobsOfRepo('third')"), 7);
  assert.equal(page.run("jobsOfRepo('nope')"), 0);
  rows([{ id: ID, session: { state: 'free', jobs: 100 } }]);
  assert.equal(page.run(`jobsOfRepo('${ID}')`), 99);
  rows([{ id: ID, session: { state: 'free', jobs: 1e12 } }]);
  assert.equal(page.run(`jobsOfRepo('${ID}')`), 99);
  for (const bad of [null, undefined, 5, 'x', [], [null, 5, 'x', { id: ID }], [{ id: ID }], [{ id: ID, session: null }], [{ id: ID, session: 'free' }]]) {
    page.run(`S.summary = ${bad === undefined ? 'undefined' : JSON.stringify(bad && typeof bad === 'object' && !Array.isArray(bad) ? bad : Array.isArray(bad) ? { rows: bad } : { rows: bad })}`);
    assert.equal(page.run(`jobsOfRepo('${ID}')`), 0, JSON.stringify(bad));
  }
  page.run('S.summary = null');
  assert.equal(page.run(`jobsOfRepo('${ID}')`), 0, 'no summary yet');
});
