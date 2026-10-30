'use strict';
// RP75 (S68): optimistic UI. After a click the card shows what is happening AT ONCE (same synchronous tick, before any fetch
// resolves): the Summary chip says working, Merge stays disabled until GitHub no longer lists the PR (or 90 s), the chat
// message leaves the box and shows as a pending bubble, and a sent command is polled every 3 s. Every page test checks the DOM
// and the state BEFORE it resolves the fake fetch promises (manual gates). Pure helpers (view.js, resumen.js) plus the real
// public/app.js in a vm (fake fetch, no timers, no network, no Orca, no real config).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const R = require('../public/resumen.js');
const V = require('../public/view.js');
const lib = require('../lib.js');

const PUBLIC = path.join(__dirname, '..', 'public');

// ---------- harness (copied from rp72-state.test.js, with a movable clock) ----------
function element(extra = {}) {
  const el = {
    writes: 0, html: '', hidden: false, dataset: {}, disabled: false, value: '', checked: false, textContent: '', title: '', attrs: {}, listeners: {}, children: [], open: false,
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    style: { setProperty(k, v) { el.style[k] = v; } },
    addEventListener(t, fn) { (el.listeners[t] ||= []).push(fn); }, setAttribute(k, v) { el.attrs[k] = v; }, querySelector: () => null, querySelectorAll: () => [], closest: () => null,
    showModal() {}, close() {}, focus() {}, append(c) { el.children.push(c); },
    get innerHTML() { return el.html; },
    set innerHTML(v) { el.html = String(v); el.writes++; },
    ...extra,
  };
  return el;
}

function loadPage({ answers = {} } = {}) {
  const els = {};
  const frames = [];
  const docL = {};
  const intervals = [];
  const store = {};
  const fetches = [];
  const tabEls = ['summary', 'work', 'conformity'].map((t) => element({ dataset: { tab: t } }));
  const get = (sel) => (els[sel] ||= (sel === 'meta[name=token]' ? element({ content: 'token' }) : element()));
  const doc = {
    hidden: false, querySelector: get, querySelectorAll: (s) => (String(s).includes('data-tab') ? tabEls : []),
    addEventListener(t, fn) { (docL[t] ||= []).push(fn); }, createElement: () => element(), body: element(), activeElement: null,
  };
  const ctx = vm.createContext({
    console, document: doc, location: { hash: '' },
    localStorage: { getItem: (k) => (k in store ? store[k] : null), setItem(k, v) { store[k] = String(v); }, removeItem(k) { delete store[k]; } },
    requestAnimationFrame: (cb) => { frames.push(cb); return frames.length; },
    setInterval: (fn, ms) => { intervals.push({ fn, ms }); return intervals.length; }, setTimeout: () => 0, confirm: () => true,
    fetch: (url, opts = {}) => {
      fetches.push({ url, method: opts.method || 'GET', body: opts.body });
      const a = Object.entries(answers).find(([k]) => url.startsWith(k));
      if (!a) return new Promise(() => {});
      return typeof a[1] === 'function' ? a[1](url, opts) : Promise.resolve({ ok: true, json: async () => a[1] });
    },
  });
  ctx.window = ctx;
  ctx.addEventListener = () => {};
  ctx.RepoPanelView = V;
  ctx.RepoPanelResumen = R;
  vm.runInContext(fs.readFileSync(path.join(PUBLIC, 'app.js'), 'utf8'), ctx);
  // The clock of the page moves only when a test says so: Date.now() inside the page is the real one plus an offset.
  vm.runInContext('globalThis.__offset = 0; { const real = Date.now.bind(Date); Date.now = () => real() + globalThis.__offset; }', ctx);
  const flush = () => { while (frames.length) frames.shift()(); };
  const tick = async (n = 6) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); flush(); };
  return {
    ctx, get, flush, tick, fetches, intervals, run: (code) => vm.runInContext(code, ctx),
    advance: (ms) => vm.runInContext(`globalThis.__offset += ${ms}`, ctx),
  };
}

// ---------- fixtures ----------
const card = (o = {}) => ({
  id: 'r1', name: 'alpha', group: 'G', room: null, branch: 'main', progress: { total: 4, completada: 1, enRevision: 0, bloqueada: 0, pendiente: 3, enCurso: 0 }, session: { state: 'free' },
  next: null, blocking: [], lastMovement: { at: '2026-05-01T11:48:00Z', what: 'x' }, action: null, error: null, needs: false, rank: 9, ...o,
});
const sess = (o = {}) => ({ id: 's1', name: 'panel:alpha', updatedAt: '2026-05-01T11:00:00Z', lastMessage: { role: 'user', text: 'last words' }, ...o });
const ADOPTED = { key: 'abc', adopted: { id: 's1', name: 'panel:demo', adoptedAt: 'x' }, adoptedFound: true, sessions: [sess()], live: { state: 'free', count: 1 } };
const live = (state) => ({ ...ADOPTED, live: { state, count: state === 'none' ? 0 : 1 } });
const userItem = (text) => ({ role: 'user', text, at: null, tools: [] });
const histOf = (...items) => ({ key: 'abc', sessionId: 's1', found: true, items, truncated: false, updatedAt: null });
const HELLO_THERE = userItem('hello there');

const reply = (body) => Promise.resolve({ ok: true, json: async () => body });
const fail = (status, body) => Promise.resolve({ ok: false, status, statusText: 'Failed', json: async () => body });
const gate = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };
const count = (s, sub) => s.split(sub).length - 1;

const R_ABC = { id: 'abc', name: 'demo', path: 'p' };
const localOf = () => ({ branch: 'main', detached: false, upstream: 'origin/main', noUpstream: false, ahead: 0, behind: 0, files: [], added: 0, deleted: 0, head: 'h1', inProgress: null, base: 'main' });
const openPr = (n) => lib.enrichPr({
  number: n, title: `pr ${n}`, url: `https://github.com/o/demo/pull/${n}`, headRefName: `task-${n}`, baseRefName: 'main', headRefOid: 'a'.repeat(40),
  isDraft: false, mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', reviewDecision: null, statusCheckRollup: [], author: { login: 'x' },
});
const prsOf = (prs) => ({ prs, stale: null, repo: { url: 'https://github.com/o/demo' } });

// The fake fetch takes the FIRST key the url starts with, so the longer routes come before their prefixes.
const BASE = {
  '/api/chat/send': { sent: true, delivered: true }, '/api/chat/clear': { cleared: true }, '/api/pi-status': { state: 'busy' }, '/api/pi': { sent: true, confirmed: true },
  '/api/sessions': ADOPTED, '/api/chat': histOf(HELLO_THERE),
};
const answers = (extra = {}) => ({ ...Object.fromEntries(Object.entries(BASE).map(([k, v]) => [k, k in extra ? extra[k] : v])), ...Object.fromEntries(Object.entries(extra).filter(([k]) => !(k in BASE))) });

// Summary tab drawn, two repos (abc, xyz) whose server session state is free.
function seed(page, rows = [card({ id: 'abc', name: 'demo' }), card({ id: 'xyz', name: 'other' })]) {
  const S = page.run('S');
  S.groups = [{ name: 'G', repos: [R_ABC, { id: 'xyz', name: 'other', path: 'q' }] }];
  S.summary = { rows, generatedAt: 'x' };
  S.local.abc = localOf();
  S.local.xyz = localOf();
  S.prs.abc = prsOf([]);
  S.prs.xyz = prsOf([]);
  return S;
}
const START_ROW = () => card({ id: 'abc', name: 'demo', action: { kind: 'start', label: 'x' }, next: { id: 'RP1', title: 't' } });

async function summaryPage(extra = {}, rows) {
  const page = loadPage({ answers: answers(extra) });
  const S = seed(page, rows);
  page.run('draw()');
  await page.tick();
  return { page, S };
}
async function chatPage(extra = {}) {
  const page = loadPage({ answers: answers(extra) });
  const S = seed(page);
  page.run("ACTIONS['chat-open']({ dataset: { id: 'abc' } })");
  await page.tick();
  return { page, S };
}

// The html of the Summary card of one repo.
const cardOf = (page, id) => {
  const html = page.get('#summary').html;
  const at = html.indexOf(`<article class="rs-card`, 0);
  assert.ok(at >= 0, 'the Summary cards are drawn');
  const m = new RegExp(`<article class="rs-card[^"]*" data-id="${id}"[\\s\\S]*?</article>`).exec(html);
  assert.ok(m, `the card of ${id} is drawn`);
  return m[0];
};
const piBtn = (html) => (/<button[^>]*data-act="pi"[^>]*>/.exec(html) || [''])[0];
const mergeBtn = (html, n = 7) => (new RegExp(`<button class="merge" data-act="merge" data-id="abc" data-n="${n}"[^>]*>[^<]*</button>`).exec(html) || [''])[0];
const PI_CLICK = "ACTIONS.pi({ dataset: { id: 'abc', cmd: 'flow-next' }, disabled: false })";

// ====================================================================================================
// A. command buttons: S.sending / S.sent show «working» at once
// ====================================================================================================
test('A1: precondition: a free repo shows the free chip and an enabled /flow-next button', async () => {
  const { page } = await summaryPage({}, [START_ROW(), card({ id: 'xyz', name: 'other' })]);
  assert.match(cardOf(page, 'abc'), /○ free/);
  assert.doesNotMatch(piBtn(cardOf(page, 'abc')), /disabled/);
});

test('A2: a click on /flow-next makes the Summary chip say working BEFORE the POST resolves, and the button is disabled', async () => {
  const post = gate();
  const { page } = await summaryPage({ '/api/pi': () => post.promise }, [START_ROW(), card({ id: 'xyz', name: 'other' })]);
  page.run(PI_CLICK);
  page.flush(); // the rAF flush, nothing else: no fetch has resolved
  const html = cardOf(page, 'abc');
  assert.match(html, /● working/, html);
  assert.doesNotMatch(html, /○ free/, html);
  assert.match(piBtn(html), /disabled/);
  // a repo without a command in flight keeps the server state
  assert.match(cardOf(page, 'xyz'), /○ free/);
  assert.doesNotMatch(cardOf(page, 'xyz'), /● working/);
});

test('A3: the override never changes the server rows: S.summary.rows stays as received', async () => {
  const post = gate();
  const rows = [START_ROW(), card({ id: 'xyz', name: 'other' })];
  const { page } = await summaryPage({ '/api/pi': () => post.promise }, rows);
  const before = JSON.stringify(rows);
  page.run(PI_CLICK);
  page.flush();
  assert.match(cardOf(page, 'abc'), /● working/, 'precondition: the chip is overridden');
  assert.equal(JSON.stringify(page.run('S.summary.rows')), before);
  assert.deepEqual(page.run('S.summary.rows').map((r) => r.session.state), ['free', 'free']);
});

test('A4: with the chat of that repo open, #sessState shows ss-working and ss-anim BEFORE the POST resolves', async () => {
  const post = gate();
  const { page } = await chatPage({ '/api/pi': () => post.promise });
  assert.ok(page.get('#sessState').html.includes('ss-free'), 'precondition: free');
  page.run(PI_CLICK);
  page.flush();
  const html = page.get('#sessState').html;
  assert.ok(html.includes('ss-working') && html.includes('ss-anim'), html);
  assert.ok(!html.includes('ss-free'), html);
});

test('A5: once the POST resolves {sent:true,confirmed:true} the chip is STILL working; when the sent record ends it goes back to the server state', async () => {
  const post = gate();
  const { page } = await summaryPage({ '/api/pi': () => post.promise }, [START_ROW(), card({ id: 'xyz', name: 'other' })]);
  page.run(PI_CLICK);
  post.resolve(reply({ sent: true, confirmed: true }));
  await page.tick();
  assert.ok(page.run('S.sent.abc'), 'precondition: the command is recorded as sent');
  assert.equal(page.run('S.sending.abc'), undefined, 'precondition: no longer sending');
  assert.match(cardOf(page, 'abc'), /● working/, 'the verdict of the sent command is running');
  assert.doesNotMatch(cardOf(page, 'abc'), /○ free/);
  page.run("clearSent('abc'); draw()");
  page.flush();
  assert.match(cardOf(page, 'abc'), /○ free/, 'back to the server state');
  assert.doesNotMatch(cardOf(page, 'abc'), /● working/);
});

test('A6: a failed POST goes back to the server state (free) and the button is enabled again', async () => {
  const post = gate();
  const { page } = await summaryPage({ '/api/pi': () => post.promise }, [START_ROW(), card({ id: 'xyz', name: 'other' })]);
  page.run(PI_CLICK);
  page.flush();
  assert.match(cardOf(page, 'abc'), /● working/, 'precondition');
  post.resolve(fail(500, { error: 'No open session' }));
  await page.tick();
  assert.match(cardOf(page, 'abc'), /○ free/);
  assert.doesNotMatch(piBtn(cardOf(page, 'abc')), /disabled/);
});

test('A7: a repo whose server state is already waiting keeps asking you (the override only lifts free to working)', async () => {
  const post = gate();
  const rows = [{ ...START_ROW(), session: { state: 'waiting' } }, card({ id: 'xyz', name: 'other' })];
  const { page } = await summaryPage({ '/api/pi': () => post.promise }, rows);
  assert.match(cardOf(page, 'abc'), /◐ asking you/, 'precondition');
  page.run(PI_CLICK);
  page.flush();
  assert.match(cardOf(page, 'abc'), /◐ asking you/);
});

// ====================================================================================================
// B. merge
// ====================================================================================================
const mergeAnswers = (state) => ({
  '/api/merge': () => reply({ merged: true, branch: 'deleted' }),
  '/api/local': () => reply(localOf()),
  '/api/prs': () => state.prs(),
  '/api/roadmap': () => fail(500, { error: 'none' }),
  '/api/requirements': () => fail(500, { error: 'none' }),
  '/api/state': () => fail(500, { error: 'none' }),
});
const MERGE_ROW = () => card({ id: 'abc', name: 'demo', action: { kind: 'merge', pr: 7, title: 'pr 7' } });
async function mergePage(state) {
  const page = loadPage({ answers: mergeAnswers(state) });
  const S = seed(page, [MERGE_ROW(), card({ id: 'xyz', name: 'other' })]);
  S.prs.abc = prsOf([openPr(7)]);
  page.run('render()');
  return { page, S };
}
const MERGE_CLICK = "ACTIONS.merge({ dataset: { id: 'abc', n: '7' } })";
const board = (page) => mergeBtn(page.get('#app').html);
const sumRow = (page) => mergeBtn(page.get('#summary').html);
const redraw = (page) => { page.run('render()'); };

test('B1a: precondition: the Merge button is enabled on the board and in the Summary row', async () => {
  const { page } = await mergePage({ prs: () => reply(prsOf([openPr(7)])) });
  assert.ok(board(page), 'board button');
  assert.ok(sumRow(page), 'summary button');
  assert.doesNotMatch(board(page), /disabled/);
  assert.doesNotMatch(sumRow(page), /disabled/);
});

test('B1b: after a good merge, while GitHub still lists the PR, Merge stays disabled and says merged/in progress for 90 s; then it is released', async () => {
  const { page } = await mergePage({ prs: () => reply(prsOf([openPr(7)])) });
  page.run(MERGE_CLICK);
  await page.tick(); // the merge and the whole refresh have answered; the fake /api/prs still lists #7
  redraw(page);
  assert.match(board(page), /disabled/, board(page));
  assert.match(board(page), />[^<]*(Merged|Merging)[^<]*</, 'says merged / in progress');
  assert.match(sumRow(page), /disabled/, sumRow(page));
  page.advance(60 * 1000);
  page.run("refreshRepo('abc')");
  await page.tick();
  redraw(page);
  assert.match(board(page), /disabled/, 'a refresh inside the hold does not release it');
  assert.match(sumRow(page), /disabled/);
  page.advance(29 * 1000); // 89 s after the merge
  redraw(page);
  assert.match(board(page), /disabled/, '89 s: still held');
  assert.match(sumRow(page), /disabled/);
  page.advance(2 * 1000); // 91 s
  redraw(page);
  assert.doesNotMatch(board(page), /disabled/, '91 s: released');
  assert.doesNotMatch(sumRow(page), /disabled/, '91 s: released (Summary)');
});

test('B1c: the hold is released as soon as a refresh no longer lists the PR', async () => {
  let listed = [openPr(7)];
  const { page } = await mergePage({ prs: () => reply(prsOf(listed)) });
  page.run(MERGE_CLICK);
  await page.tick();
  redraw(page);
  assert.match(board(page), /disabled/, 'precondition: held while listed');
  listed = [];
  page.run("refreshRepo('abc')");
  await page.tick();
  listed = [openPr(7)]; // (a PR with that number shows up again; only 5 s have passed)
  page.run("refreshRepo('abc')");
  await page.tick();
  redraw(page);
  assert.doesNotMatch(board(page), /disabled/, 'released after the PR was seen gone');
});

test('B1d: a failed merge releases the button at once (even with the refresh still pending) and shows the error toast', async () => {
  const hang = gate();
  const state = { prs: () => hang.promise };
  const page = loadPage({ answers: { ...mergeAnswers(state), '/api/merge': () => fail(500, { error: 'Merge failed: conflicts' }) } });
  const S = seed(page, [MERGE_ROW(), card({ id: 'xyz', name: 'other' })]);
  S.prs.abc = prsOf([openPr(7)]);
  page.run(MERGE_CLICK);
  await page.tick();
  redraw(page);
  assert.doesNotMatch(board(page), /disabled/);
  assert.doesNotMatch(sumRow(page), /disabled/);
  assert.ok(page.get('#toasts').children.some((t) => /Merge failed: conflicts/.test(t.textContent) && /bad/.test(t.className || '')), 'error toast');
});

test('B1e: a click sends exactly one POST /api/merge, and a second click while it is in flight sends nothing', async () => {
  const post = gate();
  const page = loadPage({ answers: { ...mergeAnswers({ prs: () => reply(prsOf([openPr(7)])) }), '/api/merge': () => post.promise } });
  const S = seed(page, [MERGE_ROW(), card({ id: 'xyz', name: 'other' })]);
  S.prs.abc = prsOf([openPr(7)]);
  page.run(MERGE_CLICK);
  page.run(MERGE_CLICK);
  assert.equal(page.fetches.filter((f) => f.method === 'POST' && f.url === '/api/merge').length, 1);
});

// ---- B2: a merge in flight does not pause the OTHER repos ----
test('B2a: refreshPlan with a merge of A in flight still plans B and not A', () => {
  const plan = V.refreshPlan({ now: 100000, ids: ['A', 'B'], busy: { 'A:7': true } });
  assert.deepEqual(plan, [{ id: 'B', kind: 'local' }]);
});

test('B2b: busy values other than true pause nothing; an empty busy is unchanged', () => {
  const both = [{ id: 'A', kind: 'local' }, { id: 'B', kind: 'local' }];
  assert.deepEqual(V.refreshPlan({ now: 100000, ids: ['A', 'B'], busy: { 'A:7': 'done' } }), both);
  assert.deepEqual(V.refreshPlan({ now: 100000, ids: ['A', 'B'], busy: {} }), both);
  assert.deepEqual(V.refreshPlan({ now: 100000, ids: ['A', 'B'] }), both);
});

test('B2c: a merge of A and a re-run of B in flight pause both; a hidden tab still plans nothing', () => {
  assert.deepEqual(V.refreshPlan({ now: 100000, ids: ['A', 'B', 'C'], busy: { 'A:7': true, 'B:9': true } }), [{ id: 'C', kind: 'local' }]);
  assert.deepEqual(V.refreshPlan({ now: 100000, ids: ['A', 'B'], busy: {}, hidden: true }), []);
});

test('B2d: the 60 s refreshAll timer is not skipped because a merge is in flight', async () => {
  const { page } = await summaryPage();
  const timer = page.intervals.find((i) => i.ms === V.FULL_REFRESH_MS);
  assert.ok(timer, 'the 60 s timer exists');
  page.run("S.busy = { 'abc:7': true }");
  page.fetches.length = 0;
  timer.fn();
  assert.ok(page.fetches.some((f) => f.url === '/health'), 'refreshAll ran (it checks /health first)');
});

test('B2e: PRESERVE: the 60 s timer still refreshes with nothing busy and still does nothing in a hidden tab', async () => {
  const { page } = await summaryPage();
  const timer = page.intervals.find((i) => i.ms === V.FULL_REFRESH_MS);
  page.fetches.length = 0;
  timer.fn();
  assert.ok(page.fetches.some((f) => f.url === '/health'));
  page.ctx.document.hidden = true;
  page.fetches.length = 0;
  timer.fn();
  assert.equal(page.fetches.length, 0);
});

test('B2f: refreshTick during a merge of abc still refreshes xyz and leaves abc alone', async () => {
  const { page } = await summaryPage();
  page.run("S.busy = { 'abc:7': true }");
  page.fetches.length = 0;
  page.run('refreshTick(Date.now() + 100000)');
  assert.ok(page.fetches.some((f) => f.url.startsWith('/api/local?id=xyz')), 'xyz is refreshed');
  assert.ok(!page.fetches.some((f) => f.url.includes('id=abc')), 'abc is not');
});

test('B2g: doRerun keeps working with the same rules: one POST /api/rerun, busy while in flight, released after', async () => {
  const post = gate();
  const { page } = await summaryPage({ '/api/rerun': () => post.promise });
  page.run("ACTIONS.rerun({ dataset: { id: 'abc', n: '7' } })");
  assert.equal(page.fetches.filter((f) => f.method === 'POST' && f.url === '/api/rerun').length, 1);
  assert.equal(page.run("S.busy['abc:7']"), true);
  post.resolve(reply({ rerun: 1 }));
  await page.tick();
  assert.equal(page.run("S.busy['abc:7']"), undefined);
});

// ====================================================================================================
// C. chat message
// ====================================================================================================
const body = (page) => page.get('#chatBody').html;
const typeAndSend = (page, text = 'hello team') => { page.get('#msgBox').value = text; page.run("ACTIONS['chat-send']({})"); };
const sendsOf = (page) => page.fetches.filter((f) => f.method === 'POST' && f.url === '/api/chat/send');

test('C1: sending clears the box, the draft and shows the pending bubble «sending…» after the real messages, all before the POST resolves', async () => {
  const post = gate();
  const { page } = await chatPage({ '/api/chat/send': () => post.promise });
  page.run("S.drafts.abc = 'hello team'");
  assert.ok(!body(page).includes('pending'), 'precondition: no pending bubble');
  typeAndSend(page);
  assert.equal(page.get('#msgBox').value, '', 'cleared in the same tick');
  assert.equal(page.run('S.drafts.abc'), undefined, 'the draft is cleared');
  assert.equal(sendsOf(page).length, 1);
  page.flush();
  const html = body(page);
  assert.match(html, /class="m me pending"/, html);
  assert.ok(html.includes('hello team') && html.includes('sending…'), html);
  assert.equal(count(html, 'hello team'), 1);
  assert.ok(html.indexOf('hello there') >= 0 && html.indexOf('hello there') < html.indexOf('hello team'), 'after the real messages');
  assert.equal(page.get('#msgSend').disabled, true, 'the composer is in its sending state');
});

test('C2: the pending text goes through the same Markdown renderer as the other bubbles, escaped', async () => {
  const post = gate();
  const text = '**bold** <b>raw</b>';
  const { page } = await chatPage({ '/api/chat/send': () => post.promise });
  typeAndSend(page, text);
  page.flush();
  const html = body(page);
  assert.ok(html.includes(R.mdHtml(text)), html);
  assert.ok(!html.includes('<b>raw</b>'), 'escaped');
});

test('C3: {sent:true,delivered:true}: the bubble shows a discreet check (class ok, «✓»), no «sending…», and stays until the history has it', async () => {
  const post = gate();
  const { page } = await chatPage({ '/api/chat/send': () => post.promise });
  typeAndSend(page);
  post.resolve(reply({ sent: true, delivered: true }));
  await page.tick(); // loadChat ran: the history still lacks the message
  const html = body(page);
  assert.ok(html.includes('hello team') && !html.includes('sending…'), html);
  assert.match(html, /<[^>]*class="[^"]*\bok\b[^"]*"[^>]*>✓</, html);
  assert.equal(count(html, 'hello team'), 1);
  assert.equal(page.get('#msgBox').value, '', 'the box stays empty');
});

test('C4: when the next /api/chat answer has the message (count above the one at send time) the pending bubble is removed: exactly one «hello team»', async () => {
  const post = gate();
  let hist = histOf(HELLO_THERE);
  const { page } = await chatPage({ '/api/chat/send': () => post.promise, '/api/chat': () => reply(hist) });
  typeAndSend(page);
  post.resolve(reply({ sent: true, delivered: true }));
  await page.tick();
  assert.match(body(page), /pending|✓/, 'precondition: the pending bubble is still there');
  hist = histOf(HELLO_THERE, userItem('hello team'));
  page.run("loadChat('abc')");
  await page.tick();
  const html = body(page);
  assert.equal(count(html, 'hello team'), 1, html);
  assert.ok(!html.includes('pending') && !html.includes('✓') && !html.includes('sending…'), html);
});

test('C5: a message equal to an OLD one is not taken for the new one: the old copy does not remove the pending bubble', async () => {
  const post = gate();
  const hist = histOf(HELLO_THERE, userItem('hello team'));
  const { page } = await chatPage({ '/api/chat/send': () => post.promise, '/api/chat': () => reply(hist) });
  typeAndSend(page);
  post.resolve(reply({ sent: true, delivered: true }));
  await page.tick();
  assert.equal(count(body(page), 'hello team'), 2, 'the old one plus the pending one');
  assert.match(body(page), /pending|✓/);
});

test('C6: {sent:true,delivered:false}: the bubble shows «not confirmed» and ALSO disappears once the history contains it', async () => {
  const post = gate();
  let hist = histOf(HELLO_THERE);
  const { page } = await chatPage({ '/api/chat/send': () => post.promise, '/api/chat': () => reply(hist) });
  typeAndSend(page);
  post.resolve(reply({ sent: true, delivered: false }));
  await page.tick();
  assert.ok(body(page).includes('not confirmed'), body(page));
  assert.ok(body(page).includes('hello team'));
  hist = histOf(HELLO_THERE, userItem('hello team'));
  page.run("loadChat('abc')");
  await page.tick();
  assert.equal(count(body(page), 'hello team'), 1);
  assert.ok(!body(page).includes('not confirmed'));
});

test('C7: a rejected send (409): the bubble is removed, the text comes back to the empty box and #msgNote shows the server message', async () => {
  const post = gate();
  const { page } = await chatPage({ '/api/chat/send': () => post.promise });
  typeAndSend(page);
  page.flush();
  assert.ok(body(page).includes('sending…'), 'precondition');
  post.resolve(fail(409, { error: 'The session is working; wait until it is free' }));
  await page.tick();
  assert.equal(page.get('#msgBox').value, 'hello team');
  assert.ok(!body(page).includes('hello team') && !body(page).includes('sending…') && !body(page).includes('pending'), body(page));
  assert.ok(page.get('#msgNote').html.includes('The session is working; wait until it is free'), page.get('#msgNote').html);
});

test('C8: a rejected send when the person already typed something new: the old text goes before it, separated by a newline', async () => {
  const post = gate();
  const { page } = await chatPage({ '/api/chat/send': () => post.promise });
  typeAndSend(page);
  page.get('#msgBox').value = 'and also this';
  post.resolve(fail(409, { error: 'The session is working; wait until it is free' }));
  await page.tick();
  assert.equal(page.get('#msgBox').value, 'hello team\nand also this');
});

test('C9: a network failure also removes the bubble and gives the text back', async () => {
  const post = gate();
  const { page } = await chatPage({ '/api/chat/send': () => post.promise });
  typeAndSend(page);
  page.flush();
  assert.ok(body(page).includes('sending…') && page.get('#msgBox').value === '', 'precondition: optimistic state');
  post.resolve(fail(500, { error: 'Orca is not answering' }));
  await page.tick();
  assert.equal(page.get('#msgBox').value, 'hello team');
  assert.ok(!body(page).includes('hello team'));
  assert.ok(page.get('#msgNote').html.includes('Orca is not answering'));
});

test('C10: pending bubbles are kept per repo: another card hides it and coming back shows it again', async () => {
  const post = gate();
  const { page } = await chatPage({ '/api/chat/send': () => post.promise });
  typeAndSend(page);
  page.flush();
  assert.ok(body(page).includes('sending…'), 'precondition');
  page.run("ACTIONS['chat-open']({ dataset: { id: 'xyz' } })");
  await page.tick();
  assert.ok(!body(page).includes('hello team') && !body(page).includes('sending…'), 'hidden on the other card');
  page.run("ACTIONS['chat-open']({ dataset: { id: 'abc' } })");
  await page.tick();
  assert.ok(body(page).includes('hello team') && body(page).includes('sending…'), 'shown again');
});

test('C11: a message the composer refuses (session working) clears nothing and shows no pending bubble; the note keeps the reason', async () => {
  const { page } = await chatPage({ '/api/sessions': live('working') });
  typeAndSend(page);
  page.flush();
  assert.equal(sendsOf(page).length, 0);
  assert.equal(page.get('#msgBox').value, 'hello team');
  assert.ok(!body(page).includes('pending') && !body(page).includes('sending…'));
  assert.ok(page.get('#msgNote').html.includes('The session is working: wait until it is free'), page.get('#msgNote').html);
});

test('C12: PRESERVE: one send per repo at a time (a second dispatch sends nothing), and an empty box sends nothing', async () => {
  const post = gate();
  const { page } = await chatPage({ '/api/chat/send': () => post.promise });
  typeAndSend(page);
  typeAndSend(page, 'second');
  assert.equal(sendsOf(page).length, 1);
  assert.equal(JSON.parse(sendsOf(page)[0].body).text, 'hello team');
  const empty = await chatPage();
  empty.page.get('#msgBox').value = '   ';
  empty.page.run("ACTIONS['chat-send']({})");
  assert.equal(sendsOf(empty.page).length, 0);
});

test('C13: PRESERVE: the draft is per repo (typing in abc, visiting xyz and coming back restores it)', async () => {
  const { page } = await chatPage();
  page.get('#msgBox').value = 'half-typed';
  page.run("ACTIONS['chat-open']({ dataset: { id: 'xyz' } })");
  assert.equal(page.get('#msgBox').value, '');
  page.run("ACTIONS['chat-open']({ dataset: { id: 'abc' } })");
  assert.equal(page.get('#msgBox').value, 'half-typed');
});

// ---- R.chatBody with c.pending (pure) ----
const chatC = (items, pending, over = {}) => ({ id: 'abc', info: ADOPTED, hist: histOf(...items), pending, ...over });
const P = (text, state = 'sending', base = 0) => ({ text, state, base });

test('R.chatBody: a pending entry is a bubble «m me pending» with the text and «sending…», after the items', () => {
  const html = R.chatBody(chatC([HELLO_THERE], [P('hello team')]));
  assert.match(html, /class="m me pending"/, html);
  assert.ok(html.includes('sending…') && html.includes(R.mdHtml('hello team')), html);
  assert.ok(html.indexOf('hello there') < html.indexOf('hello team'));
});

test('R.chatBody: state ok shows the check (class ok, «✓»), unconfirmed shows «not confirmed», neither says «sending…»', () => {
  const ok = R.chatBody(chatC([], [P('hello team', 'ok')]));
  assert.match(ok, /<[^>]*class="[^"]*\bok\b[^"]*"[^>]*>✓</, ok);
  assert.ok(!ok.includes('sending…'));
  const un = R.chatBody(chatC([], [P('hello team', 'unconfirmed')]));
  assert.ok(un.includes('not confirmed') && !un.includes('sending…'), un);
});

test('R.chatBody: an entry is hidden when the user items with the same text outnumber its base', () => {
  const same = userItem('hello team');
  assert.ok(R.chatBody(chatC([same], [P('hello team', 'ok', 0)])).split('hello team').length === 2, 'base 0, one in history: hidden (only the real bubble)');
  assert.ok(!R.chatBody(chatC([same], [P('hello team', 'ok', 0)])).includes('pending'));
  assert.match(R.chatBody(chatC([same], [P('hello team', 'ok', 1)])), /pending|✓/, 'base 1, one in history: shown');
  assert.equal(count(R.chatBody(chatC([same], [P('hello team', 'ok', 1)])), 'hello team'), 2);
  assert.ok(!R.chatBody(chatC([same, same], [P('hello team', 'ok', 1)])).includes('✓'), 'base 1, two in history: hidden');
});

test('R.chatBody: only USER items with the same flattened text count (assistant items and other texts do not)', () => {
  const assistant = { role: 'assistant', text: 'hello team', at: null, tools: [] };
  assert.match(R.chatBody(chatC([assistant], [P('hello team', 'ok', 0)])), /<[^>]*class="[^"]*\bok\b[^"]*"[^>]*>✓</);
  assert.match(R.chatBody(chatC([userItem('hello teammates')], [P('hello team', 'ok', 0)])), /✓/);
  // flattened: runs of whitespace (new lines included) are one space
  assert.ok(!R.chatBody(chatC([userItem('hello team now')], [P('hello  team\nnow', 'ok', 0)])).includes('✓'));
});

test('R.chatBody: several pending entries render in order; none, an empty array or no pending changes nothing', () => {
  const html = R.chatBody(chatC([HELLO_THERE], [P('first one'), P('second one')]));
  assert.ok(html.indexOf('first one') > 0 && html.indexOf('first one') < html.indexOf('second one'));
  const plain = R.chatBody(chatC([HELLO_THERE], undefined));
  assert.equal(R.chatBody(chatC([HELLO_THERE], [])), plain);
  assert.ok(!plain.includes('pending'));
});

test('R.chatBody: pending text is escaped', () => {
  const html = R.chatBody(chatC([], [P('<img src=x onerror=alert(1)>')]));
  assert.match(html, /pending/, 'the entry is drawn');
  assert.ok(!html.includes('<img'), html);
});

test('R.chatBody: pending is never rendered when the chat has no adopted session', () => {
  const none = R.chatBody(chatC([], [P('hello team')], { info: { key: 'abc', adopted: null, adoptedFound: false, sessions: [sess()], live: { state: 'none', count: 0 } } }));
  assert.ok(!none.includes('hello team') && !none.includes('pending'), none);
  const notFound = R.chatBody(chatC([], [P('hello team')], { info: { ...ADOPTED, adoptedFound: false } }));
  assert.ok(!notFound.includes('hello team'), notFound);
});

// ====================================================================================================
// D. faster finish detection: refreshPlan kind 'sent'
// ====================================================================================================
const NOW = 1000000;
const FRESH = { local: NOW, prs: NOW };

test('D1: V.SENT_POLL_MS is 3000', () => {
  assert.equal(V.SENT_POLL_MS, 3000);
});

test('D2: a repo with a sent record whose pistatus is 3 s old (or never asked) gets {id, kind: sent}; a younger one gets nothing', () => {
  const sent = { a: { cmd: 'flow-next' } };
  assert.deepEqual(V.refreshPlan({ now: NOW, ids: ['a'], sent, last: { a: { ...FRESH, pistatus: NOW - 3000 } } }), [{ id: 'a', kind: 'sent' }]);
  assert.deepEqual(V.refreshPlan({ now: NOW, ids: ['a'], sent, last: { a: { ...FRESH, pistatus: NOW - 2999 } } }), []);
  assert.deepEqual(V.refreshPlan({ now: NOW, ids: ['a'], sent, last: { a: { ...FRESH } } }), [{ id: 'a', kind: 'sent' }], 'never asked');
});

test('D3: a repo without a sent record never gets kind sent', () => {
  const plan = V.refreshPlan({ now: NOW, ids: ['a', 'b'], sent: { a: { cmd: 'x' } }, last: { a: FRESH, b: { ...FRESH, pistatus: 0 } } });
  assert.deepEqual(plan, [{ id: 'a', kind: 'sent' }]);
});

test('D4: a repo that is also hot and local-due gets ONE entry, and sent wins', () => {
  const plan = V.refreshPlan({ now: NOW, ids: ['a'], sent: { a: { cmd: 'x' } }, last: { a: { local: 0, prs: 0, pistatus: 0 } } });
  assert.deepEqual(plan, [{ id: 'a', kind: 'sent' }]);
});

test('D5: when the sent poll is not due, the hot refresh of that repo is planned as before', () => {
  const plan = V.refreshPlan({ now: NOW, ids: ['a'], sent: { a: { cmd: 'x' } }, last: { a: { local: 0, prs: 0, pistatus: NOW - 1000 } } });
  assert.deepEqual(plan, [{ id: 'a', kind: 'hot' }]);
});

test('D6: kind sent respects a request in flight and a hidden tab, and a merge of ANOTHER repo does not stop it', () => {
  const sent = { a: { cmd: 'x' } };
  const last = { a: { ...FRESH, pistatus: 0 } };
  assert.deepEqual(V.refreshPlan({ now: NOW, ids: ['a'], sent, last, loading: { a: 1 } }), []);
  assert.deepEqual(V.refreshPlan({ now: NOW, ids: ['a'], sent, last, hidden: true }), []);
  assert.deepEqual(V.refreshPlan({ now: NOW, ids: ['a'], sent, last, busy: { 'z:1': true } }), [{ id: 'a', kind: 'sent' }]);
});

test('D7: PRESERVE: without sent records refreshPlan is as before (hot and local kinds)', () => {
  const local = { a: { branch: 'task', files: [] } };
  const prs = { a: { prs: [{ head: 'task' }] } };
  assert.deepEqual(V.refreshPlan({ now: NOW, ids: ['a', 'b'], local, prs, last: { a: { local: 0, prs: 0 }, b: { local: 0 } } }), [{ id: 'a', kind: 'hot' }, { id: 'b', kind: 'local' }]);
});

test('D8: page: refreshTick on kind sent asks ONLY /api/pi-status for that repo, records the time, and does not ask again inside 3 s', async () => {
  const { page } = await summaryPage();
  const T = Date.now();
  page.run(`S.sent.abc = { cmd: 'flow-next', at: ${T} }; S.lastAt.abc = { local: ${T}, prs: ${T} }; S.lastAt.xyz = { local: ${T}, prs: ${T} }`);
  page.fetches.length = 0;
  page.run(`refreshTick(${T})`);
  const asked = page.fetches.filter((f) => f.url.startsWith('/api/pi-status?id=abc'));
  assert.equal(asked.length, 1, JSON.stringify(page.fetches));
  assert.ok(!page.fetches.some((f) => f.url.startsWith('/api/prs') || f.url.startsWith('/api/local')), 'no /api/prs or /api/local for that entry');
  assert.equal(page.run('S.lastAt.abc.pistatus'), T, 'records the time');
  await page.tick();
  page.fetches.length = 0;
  page.run(`refreshTick(${T + 2500})`);
  assert.equal(page.fetches.length, 0, 'inside 3 s: nothing');
  page.run(`refreshTick(${T + 3000})`);
  assert.equal(page.fetches.filter((f) => f.url.startsWith('/api/pi-status?id=abc')).length, 1, 'after 3 s: asks again');
});

// ====================================================================================================
// E. no regressions
// ====================================================================================================
test('E1: a click on an action sends exactly ONE POST /api/pi; a second dispatch while the first is in flight sends nothing', async () => {
  const post = gate();
  const { page } = await summaryPage({ '/api/pi': () => post.promise }, [START_ROW(), card({ id: 'xyz', name: 'other' })]);
  const pis = () => page.fetches.filter((f) => f.method === 'POST' && f.url === '/api/pi');
  page.run(PI_CLICK);
  page.run(PI_CLICK);
  assert.equal(pis().length, 1);
  assert.deepEqual(JSON.parse(pis()[0].body), { id: 'abc', command: 'flow-next' });
  assert.equal(page.run('S.sending.abc'), 'flow-next');
});

test('E2: a judged command (/flow-commit) also shows working at once, before even its baseline read answers', async () => {
  const baseline = gate();
  const { page } = await summaryPage({ '/api/local': () => baseline.promise }, [{ ...START_ROW(), action: { kind: 'deliver', label: 'x' } }, card({ id: 'xyz', name: 'other' })]);
  page.run("ACTIONS.pi({ dataset: { id: 'abc', cmd: 'flow-commit' }, disabled: false })");
  page.flush();
  assert.match(cardOf(page, 'abc'), /● working/);
});
