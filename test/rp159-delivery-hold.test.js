'use strict';
// RP159 (S26, S50): the delivery buttons (/flow-commit, /flow-pr, /flow-base, /flow-next, and Fix CI of a PR card) stay disabled for as long as the session of the repo is working or asking, whatever else the page believes.
// The bug the person reported: after pressing /flow-base or /flow-next the card went to «working» and the button came back. The cause is that the buttons of the Summary card for /flow-base and /flow-next were held ONLY while the
// order was on its way (S.sending); the server decides that action from Git alone (a clean repo on main with a next unit always offers /flow-next), so as soon as the answer «sent» arrived the button was enabled again with the
// session still working. And /flow-pr and /flow-base of the board never looked at the session, only /flow-commit did. The rule now is ONE: V.deliveryHold({ sending, running, session }) gives the reason a delivery button is held (or
// '') and every one of those buttons asks it. The live state of the session (the one pushed by the stream) counts even while a command of this page is being judged. Merge is NOT held by the session: it does not talk to it.
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { appSource } = require('./pagesrc.js');
const V = require('../public/view.js');
const R = require('../public/resumen.js');

// ---------- the one rule (pure) ----------
test('h1: nothing holds a button when nothing is sending, running or working; each cause holds it with its own reason, in this order: sending, running command, asking, working', () => {
  assert.equal(V.deliveryHold({}), '');
  assert.equal(V.deliveryHold({ session: 'idle' }), '');
  assert.equal(V.deliveryHold({ session: 'closed' }), '');
  assert.equal(V.deliveryHold({ session: 'none' }), '');
  assert.equal(V.deliveryHold({ session: undefined }), '');
  assert.match(V.deliveryHold({ sending: 'flow-next' }), /Sending the order to the session/);
  assert.match(V.deliveryHold({ running: { cmd: 'flow-base', label: 'updating base branch…' } }), /Running \/flow-base \(updating base branch…\): wait for it to finish/);
  assert.match(V.deliveryHold({ session: 'busy' }), /The session is working: wait for it to finish/);
  assert.match(V.deliveryHold({ session: 'asking' }), /The session is waiting for your answer/);
  assert.match(V.deliveryHold({ sending: 'x', running: { cmd: 'flow-base', label: 'l' }, session: 'busy' }), /Sending the order/);
  assert.match(V.deliveryHold({ running: { cmd: 'flow-base', label: 'l' }, session: 'busy' }), /Running \/flow-base/);
  assert.match(V.deliveryHold({ session: 'asking', running: null }), /waiting for your answer/);
});

test('h2: it is total: anything that is not what it expects holds nothing and never throws; only the exact words of the session states hold', () => {
  for (const bad of [null, undefined, 5, 'x', [], true]) assert.equal(V.deliveryHold(bad), '', String(bad));
  for (const session of ['Busy', 'BUSY', 'working', 'waiting', 'starting', 5, null, {}, [], true, ' busy']) assert.equal(V.deliveryHold({ session }), '', String(session));
  for (const sending of ['', 0, null, undefined, false]) assert.equal(V.deliveryHold({ sending }), '', String(sending));
  for (const running of [null, undefined, 5, 'x', [], {}, { cmd: 5 }, { label: 'l' }]) assert.doesNotThrow(() => V.deliveryHold({ running }));
});

// ---------- flowButtons ----------
const local = (o = {}) => ({ files: [], stagedCount: 0, branch: 'feat/x', base: 'main', ahead: 1, behind: 0, head: 'abc', noUpstream: false, lastChangeMs: 0, ...o });
const FILES = [{ path: 'a.js', status: 'M', added: 1, deleted: 0 }];
const open = (o = {}) => ({ prs: [], stale: null, ...o });
const one = (arr) => { assert.equal(arr.length, 1, JSON.stringify(arr)); return arr[0]; };

test('b1: /flow-pr and /flow-base follow the session like /flow-commit: disabled with the reason of the session while it is busy or asking, enabled when it is idle, closed or unknown', () => {
  for (const session of ['busy', 'asking']) {
    const pr = one(V.flowButtons(local(), open(), {}, { session }));
    assert.equal(pr.cmd, 'flow-pr');
    assert.equal(pr.disabled, true, `flow-pr ${session}`);
    assert.match(pr.reason, session === 'busy' ? /still working/ : /waiting for your answer/);
    const base = one(V.flowButtons(local({ ahead: 0 }), open({ stale: { via: 'merged', pr: 4 } }), {}, { session }));
    assert.equal(base.cmd, 'flow-base');
    assert.equal(base.disabled, true, `flow-base ${session}`);
    const stash = one(V.flowButtons(local({ files: FILES }), open({ stale: { via: 'merged', pr: 4 } }), {}, { session }));
    assert.equal(stash.cmd, 'flow-base-stash');
    assert.equal(stash.disabled, true, `flow-base --stash ${session}`);
  }
  for (const session of ['idle', 'closed', undefined, null, 'unknown']) {
    assert.equal(one(V.flowButtons(local(), open(), {}, { session })).disabled, undefined, `flow-pr ${session}`);
    assert.equal(one(V.flowButtons(local({ ahead: 0 }), open({ stale: { via: 'merged', pr: 4 } }), {}, { session })).disabled, undefined, `flow-base ${session}`);
  }
});

test('b2: /flow-commit keeps its rule (held while busy or asking, and the override of the person lifts it) and the override does NOT lift the hold of the other buttons', () => {
  const dirty = local({ files: FILES, lastChangeMs: 0 });
  const held = one(V.flowButtons(dirty, open(), { declared: 'ready-to-commit' }, { session: 'busy' }));
  assert.equal(held.cmd, 'flow-commit');
  assert.equal(held.disabled, true);
  assert.equal(one(V.flowButtons(dirty, open(), {}, { session: 'idle', override: true })).disabled, undefined);
  assert.equal(one(V.flowButtons(local(), open(), {}, { session: 'busy', override: true })).disabled, true, 'the override is for /flow-commit only');
});

test('b3: with a command running the buttons are all held with ITS reason (as before), and the live session does not change that', () => {
  const run = { cmd: 'flow-base', label: 'updating base branch…' };
  const b = one(V.flowButtons(local(), open(), {}, { running: run, session: 'busy' }));
  assert.equal(b.disabled, true);
  assert.match(b.reason, /Running \/flow-base/);
});

// ---------- the Summary card ----------
const row = (name, session, action, o = {}) => ({ id: `id-${name}`, name, group: 'G', room: null, branch: 'main', needs: false, rank: 9, progress: { total: null }, next: { id: 'X1', entrega: 'A task' }, blocking: [], lastMovement: {}, session, action, ...o });
const btn = (html, cmd) => { const m = new RegExp(`<button[^>]*data-cmd="${cmd}"[^>]*>`).exec(html); assert.ok(m, `a button for ${cmd}`); return m[0]; };
const card = (r, ctx = {}) => R.summaryView({ rows: [r], generatedAt: 'x' }, ctx);
const START = { kind: 'start', label: 'Start X1', pr: null };
const BRANCH = { kind: 'branch', label: 'Start from a fresh base branch', pr: null };

test('s1: the buttons /flow-next and /flow-base of the card are held by the hold of the page, with its reason as the title, and enabled when nothing holds', () => {
  const holdFor = (reason) => () => reason;
  for (const [action, cmd] of [[START, 'flow-next'], [BRANCH, 'flow-base']]) {
    const held = btn(card(row('a', { state: 'free' }, action), { holdFor: holdFor('The session is working: wait for it to finish') }), cmd);
    assert.match(held, / disabled/, cmd);
    assert.match(held, /title="The session is working: wait for it to finish"/, cmd);
    assert.doesNotMatch(btn(card(row('a', { state: 'free' }, action), { holdFor: holdFor('') }), cmd), / disabled/, cmd);
    assert.doesNotMatch(btn(card(row('a', { state: 'free' }, action), {}), cmd), / disabled/, `${cmd}: a page with no hold`);
  }
});

test('s2: the row of the server says the session works: the buttons are held even when the page holds nothing (the summary is the second witness)', () => {
  for (const [action, cmd] of [[START, 'flow-next'], [BRANCH, 'flow-base']]) {
    assert.match(btn(card(row('a', { state: 'working' }, action), {}), cmd), / disabled/, `${cmd} working`);
    for (const state of ['free', 'none', 'unknown']) assert.doesNotMatch(btn(card(row('a', { state }, action), {}), cmd), / disabled/, `${cmd} ${state}`);
  }
});

test('s3: the sending of the old rule still holds, and a card that has no such button is not touched (the answer, the merge and the open buttons)', () => {
  assert.match(btn(card(row('a', { state: 'free' }, START), { sending: { 'id-a': 'flow-next' } }), 'flow-next'), / disabled/);
  const merge = card(row('a', { state: 'working' }, { kind: 'merge', pr: 7, label: 'Merge #7' }), { holdFor: () => 'The session is working: wait for it to finish' });
  assert.doesNotMatch(/<button class="merge"[^>]*>/.exec(merge)[0], / disabled/, 'Merge does not talk to the session');
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
    show: async (action, session = { state: 'free' }) => { vm.runInContext(`S.summary = ${JSON.stringify({ rows: [row('repo-a', session, action, { id: ID })], generatedAt: 'x' })}; draw()`, ctx); await tick(); },
    redraw: async () => { vm.runInContext('draw()', ctx); await tick(); },
    html: () => get('#summary').html,
  };
}

test('p1: THE BUG: the answer «sent» arrives, the order is no longer on its way, the card is still /flow-next by Git, and the session is working: the button stays disabled, and it is enabled again only when the session is free', async () => {
  const page = await boot();
  await page.show(START);
  assert.doesNotMatch(btn(page.html(), 'flow-next'), / disabled/, 'nothing is happening: enabled');
  page.run(`S.rpc['${ID}'] = { state: 'busy' }`);
  await page.redraw();
  assert.match(btn(page.html(), 'flow-next'), / disabled/, 'the session works: held, with no S.sending at all');
  page.run(`S.rpc['${ID}'] = { state: 'idle' }`);
  await page.redraw();
  assert.doesNotMatch(btn(page.html(), 'flow-next'), / disabled/, 'the session finished: enabled');
});

test('p2: the same for /flow-base, and for a session that is asking you; a session that is starting counts as working', async () => {
  const page = await boot();
  await page.show(BRANCH);
  for (const [state, held] of [['busy', true], ['asking', true], ['starting', true], ['idle', false], ['closed', false]]) {
    page.run(`S.rpc['${ID}'] = { state: '${state}' }`);
    await page.redraw();
    assert.equal(/ disabled/.test(btn(page.html(), 'flow-base')), held, state);
  }
});

test('p3: the order is held while it is on its way (as before), and also while a command sent from this page is judged running even if the live session says nothing yet', async () => {
  const page = await boot();
  await page.show(START);
  page.run(`S.sending['${ID}'] = 'flow-next'`);
  await page.redraw();
  assert.match(btn(page.html(), 'flow-next'), / disabled/);
  page.run(`delete S.sending['${ID}']`);
  await page.redraw();
  assert.doesNotMatch(btn(page.html(), 'flow-next'), / disabled/);
});

test('p4: the row of the server that says working holds it as well, and the answer button («Open» for a session that asks) is untouched', async () => {
  const page = await boot();
  await page.show(START, { state: 'working' });
  assert.match(btn(page.html(), 'flow-next'), / disabled/);
  await page.show({ kind: 'answer', label: 'Answer the session', pr: null }, { state: 'waiting' });
  assert.match(page.html(), /data-act="focus-repo"/);
});

test('s4: the deliver button (/flow-commit, /flow-pr) of the card is held by the hold of the page too, with its reason as the title, even when the flow button itself is enabled', () => {
  const r = row('a', { state: 'free' }, { kind: 'deliver', label: 'Deliver', pr: null });
  const flowFor = () => ({ cmd: 'flow-commit', label: '/flow-commit' });
  const held = btn(card(r, { flowFor, holdFor: () => 'The session is working: wait for it to finish' }), 'flow-commit');
  assert.match(held, / disabled/);
  assert.match(held, /title="The session is working: wait for it to finish"/);
  assert.doesNotMatch(btn(card(r, { flowFor, holdFor: () => '' }), 'flow-commit'), / disabled/);
  assert.match(btn(card(r, { flowFor: () => ({ cmd: 'flow-pr', label: '/flow-pr', disabled: true, reason: 'x' }), holdFor: () => '' }), 'flow-pr'), / disabled/, 'a button the flow already disables stays disabled');
});

test('p5: ABUSE of the old rule: a session that the page asks about while a command of this page is being judged still counts (sessionOf is the LIVE state even with a command in S.sent)', async () => {
  const page = await boot();
  page.run(`S.sent['${ID}'] = { cmd: 'flow-base', at: Date.now() }; S.rpc['${ID}'] = { state: 'busy' }`);
  assert.equal(page.run(`sessionOf('${ID}')`), 'busy');
  page.run(`S.rpc['${ID}'] = { state: 'idle' }`);
  assert.equal(page.run(`sessionOf('${ID}')`), 'idle');
  page.run(`delete S.rpc['${ID}']`);
  assert.equal(page.run(`sessionOf('${ID}')`), undefined);
});

test('p6: a command sent from this page that is judged running holds the buttons of the card with ITS reason, even when the live session says nothing', async () => {
  const page = await boot();
  await page.show(START);
  page.run(`S.sent['${ID}'] = { cmd: 'flow-next', at: Date.now() }`);
  await page.redraw();
  const b = btn(page.html(), 'flow-next');
  assert.match(b, / disabled/);
  assert.match(b, /title="Running \/flow-next \(starting the next task…\): wait for it to finish"/);
});

// ---------- Fix CI of a PR card (the board) ----------
const lib = require('../lib.js');
const RUN = (name, over = {}) => ({ __typename: 'CheckRun', name, status: 'COMPLETED', conclusion: 'SUCCESS', detailsUrl: `https://github.com/o/r/actions/runs/${name.length}1`, ...over });
const FAILED_PR = () => lib.enrichPr({ number: 7, title: 't', url: 'https://github.com/o/r/pull/7', headRefName: 'feat/x', baseRefName: 'main', headRefOid: 'abc', isDraft: false, isCrossRepository: false, author: { login: 'me' }, reviewDecision: null, mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', statusCheckRollup: [RUN('build'), RUN('test', { conclusion: 'FAILURE' })], additions: 1, deletions: 0, changedFiles: 1 });

test('p7: Fix CI talks to the session, so it waits for it: held while the session works or asks, enabled when it is free or closed', async () => {
  const page = await boot();
  page.run(`S.local['${ID}'] = { branch: 'feat/x', base: 'main', files: [], ahead: 0, behind: 0, head: 'a', noUpstream: false, stagedCount: 0, lastChangeMs: 0, error: null }; S.prs['${ID}'] = { prs: [${JSON.stringify(FAILED_PR())}], stale: null }; S.state['${ID}'] = {}`);
  const fix = () => { const m = /<button[^>]*data-cmd="fix-pr"[^>]*>/.exec(page.get('#app').html); assert.ok(m, 'a Fix CI button'); return m[0]; };
  for (const [state, held] of [['busy', true], ['asking', true], ['idle', false], ['closed', false]]) {
    page.run(`S.rpc['${ID}'] = { state: '${state}' }`);
    await page.redraw();
    assert.equal(/ disabled/.test(fix()), held, state);
    if (held) assert.match(fix(), /title="The session is (working|waiting)/, state);
  }
});
