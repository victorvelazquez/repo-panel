'use strict';
// RP87 (S9): what the board card (Work) and the Summary card used to build twice is built once. The change chips (`● N files +A −D`, `↑ N unpushed`,
// `↓ N behind`) live in view.js (V.changeChips) and both cards use them; who a card is about (group tag, room tag, repo name) is one function
// (identityHtml) for the board card and the clean row; the branch text is one (branchLabel). No visible change: the HTML comes out the same. What stays
// different on purpose (the Summary header, the PR card body, the compact clean row) is not touched. No network, no real clock.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const V = require('../public/view.js');
const R = require('../public/resumen.js');

const read = (f) => fs.readFileSync(path.join(__dirname, '..', 'public', f), 'utf8').replace(/\r\n/g, '\n');
const C = (o = {}) => ({ files: 0, added: 0, deleted: 0, ahead: 0, behind: 0, noUpstream: false, ...o });

// ---------- pure: the shared chips ----------
test('c1: with nothing changed there are no chips, and with no local state (null) neither', () => {
  assert.equal(V.changeChips(null, 'abc'), '');
  assert.equal(V.changeChips(undefined, 'abc'), '');
  assert.equal(V.changeChips(C(), 'abc'), '');
});

test('c2: the files chip is a button that opens the diff, with singular and plural, and the added and deleted counts', () => {
  assert.equal(V.changeChips(C({ files: 1, added: 3, deleted: 1 }), 'abc'),
    '<button class="chip yellow chip-btn" data-act="diff" data-id="abc" title="View diff">● 1 file <span class="add">+3</span> <span class="del">−1</span></button>');
  assert.equal(V.changeChips(C({ files: 2, added: 0, deleted: 7 }), 'abc'),
    '<button class="chip yellow chip-btn" data-act="diff" data-id="abc" title="View diff">● 2 files <span class="add">+0</span> <span class="del">−7</span></button>');
});

test('c3: unpushed is a plain chip, "no upstream" only on unpushed, there is no behind chip (RP94); the order is files, then unpushed', () => {
  assert.equal(V.changeChips(C({ ahead: 2 }), 'abc'), '<span class="chip blue">↑ 2 unpushed</span>');
  assert.equal(V.changeChips(C({ ahead: 1, noUpstream: true }), 'abc'), '<span class="chip blue">↑ 1 unpushed · no upstream</span>');
  assert.equal(V.changeChips(C({ behind: 3 }), 'abc'), '', 'RP94: behind alone says nothing');
  assert.equal(V.changeChips(C({ noUpstream: true }), 'abc'), '', 'no upstream without commits ahead says nothing');
  const all = V.changeChips(C({ files: 1, added: 1, deleted: 0, ahead: 1, behind: 1 }), 'abc');
  assert.ok(all.indexOf('chip yellow') < all.indexOf('chip blue'));
  assert.doesNotMatch(all, /chip gray|behind/);
});

test('c4: the repo id is escaped, and numbers that are not counts read as 0 (never NaN or a string)', () => {
  assert.match(V.changeChips(C({ files: 1 }), 'a"b<c'), /data-id="a&quot;b&lt;c"/);
  const h = V.changeChips({ files: 1, added: 'x', deleted: NaN, ahead: '2', behind: -4, noUpstream: 1 }, 'abc');
  assert.match(h, /\+0<\/span> <span class="del">−0</);
  assert.doesNotMatch(h, /NaN|undefined|chip blue|chip gray/);
  assert.equal(typeof V.changeChips(5, 'abc'), 'string');
});

// ---------- the pages ----------
function element(extra = {}) {
  const el = {
    writes: 0, html: '', hidden: false, dataset: {}, value: '', textContent: '', attrs: {}, listeners: {},
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false }, style: { setProperty() {} },
    addEventListener() {}, setAttribute(k, v) { el.attrs[k] = v; }, querySelector: () => null, querySelectorAll: () => [], closest: () => null, focus() {},
    get innerHTML() { return el.html; },
    set innerHTML(v) { el.html = String(v); el.writes++; },
    ...extra,
  };
  return el;
}
function loadPage() {
  const els = {};
  const get = (sel) => (els[sel] ||= (sel === 'meta[name=token]' ? element({ content: 'token' }) : element()));
  const ctx = vm.createContext({
    console, document: { hidden: false, querySelector: get, querySelectorAll: () => [], addEventListener() {}, createElement: () => element(), body: element(), activeElement: null },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} }, location: { hash: '' },
    requestAnimationFrame: () => 1, setInterval: () => 0, setTimeout: () => 0, clearTimeout: () => {}, AbortController, confirm: () => true,
    fetch: () => new Promise(() => {}),
  });
  ctx.window = ctx;
  ctx.addEventListener = () => {};
  ctx.RepoPanelView = V;
  ctx.RepoPanelResumen = R;
  vm.runInContext(read('app.js'), ctx);
  return { run: (c) => vm.runInContext(c, ctx) };
}
const REPO = '{ id: "abc", path: "p", name: "demo", group: "Personal" }';
const seed = (page, local, prs = { prs: [] }) => page.run(`S.groups = [{ name: 'Personal', repos: [${REPO}] }]; S.local.abc = ${JSON.stringify(local)}; S.prs.abc = ${JSON.stringify(prs)};`);
const LOCAL = { branch: 'feat/x', files: [{ path: 'a.js', status: 'M' }, { path: 'b.js', status: 'A' }], added: 5, deleted: 2, ahead: 1, behind: 3, noUpstream: true };

test('p1: the board card and the Summary card show the SAME change chips for the same repo', () => {
  const page = loadPage();
  seed(page, LOCAL);
  const chips = V.changeChips(C({ files: 2, added: 5, deleted: 2, ahead: 1, behind: 3, noUpstream: true }), 'abc');
  const work = page.run(`repoCard(${REPO})`);
  assert.ok(work.includes(chips), 'the board card holds exactly the shared chips');
  const row = { id: 'abc', name: 'demo', group: 'Personal', room: null, branch: 'feat/x', needs: false, rank: 9, progress: { total: null }, next: null, blocking: [], lastMovement: {}, session: { state: 'free' }, action: null };
  const summary = R.summaryView({ rows: [row], generatedAt: 't' }, { now: Date.now(), scope: { kind: 'all' }, rooms: [], changesFor: () => C({ files: 2, added: 5, deleted: 2, ahead: 1, behind: 3, noUpstream: true }) });
  assert.ok(summary.includes(chips), 'the Summary card holds exactly the shared chips');
});

test('p2: a clean repo shows no change chips on either card', () => {
  const page = loadPage();
  seed(page, { branch: 'main', files: [], ahead: 0, behind: 0 });
  assert.doesNotMatch(page.run(`repoCard(${REPO})`), /chip yellow|chip blue|↓ \d+ behind/);
});

test('p3: the board card keeps its other chips after the shared ones (stale, branch gone); the "no GitHub remote" chip is gone (RP94)', () => {
  const page = loadPage();
  seed(page, { ...LOCAL }, { prs: [], noRemote: true });
  const html = page.run(`repoCard(${REPO})`);
  assert.match(html, /chip yellow/);
  assert.doesNotMatch(html, /no GitHub remote/);
});

test('p4: branchLabel is the branch, then "(detached)", then nothing', () => {
  const page = loadPage();
  assert.equal(page.run('branchLabel({ branch: "feat/x" })'), 'feat/x');
  assert.equal(page.run('branchLabel({ detached: true })'), '(detached)');
  assert.equal(page.run('branchLabel({ branch: "", detached: true })'), '(detached)');
  assert.equal(page.run('branchLabel({})'), '');
});

test('p5: identityHtml is group tag, room tag and repo name, and both the board card top and the clean row use it (for a repo in a room too; RP94b: the group tag shows with several groups)', () => {
  const page = loadPage();
  seed(page, { branch: 'main', files: [], ahead: 0, behind: 0 });
  page.run("S.groups.push({ name: 'Work', repos: [] }); S.group = '';");
  for (const room of [false, true]) {
    if (room) page.run("S.rooms = [{ name: 'UPEN', repos: ['abc'] }];");
    const id = page.run(`identityHtml(${REPO}, 'https://github.com/o/r')`);
    assert.equal(id, page.run(`groupTag("Personal") + roomTag(${REPO}) + repoName(${REPO}, 'https://github.com/o/r')`));
    assert.match(id, /class="tag"[^>]*>Personal</);
    assert.ok(id.includes('<a class="repo-name" href="https://github.com/o/r"'), 'the repo name is the link to GitHub');
    assert.equal(/room-tag/.test(id), room, room ? 'a repo in a room carries its room tag' : 'no room, no room tag');
    assert.ok(page.run(`cardTop(${REPO}, 'https://github.com/o/r', 'repo')`).includes(id), 'the board card top');
    assert.ok(page.run(`cleanRow(${REPO})`).includes(page.run(`identityHtml(${REPO}, undefined)`)), 'the clean row');
  }
});

// ---------- the code ----------
test('s1: the chip markup exists once in the page code (view.js) and resumen.js uses it from there', () => {
  const marks = ['view.js', 'resumen.js', 'app.js'].map((f) => [f, (read(f).match(/chip yellow chip-btn/g) || []).length]);
  assert.deepEqual(marks, [['view.js', 1], ['resumen.js', 0], ['app.js', 0]]);
  assert.doesNotMatch(read('resumen.js'), /function changeChips/);
  assert.match(read('resumen.js'), /changeChips/);
});

test('s2: the Summary still renders its chips when resumen.js is loaded on its own in Node (it finds view.js itself)', () => {
  const row = { id: 'abc', name: 'demo', group: 'g', room: null, branch: 'b', needs: false, rank: 9, progress: { total: null }, next: null, blocking: [], lastMovement: {}, session: { state: 'free' }, action: null };
  const html = R.summaryView({ rows: [row], generatedAt: 't' }, { now: 0, scope: { kind: 'all' }, rooms: [], changesFor: () => C({ behind: 4 }) });
  assert.match(html, /<span class="chip red">▲ manual action<\/span>|rs-card/, 'the card is still drawn');
  assert.doesNotMatch(html, /behind/, 'RP94: no behind chip');
});

test('s3: a Summary card without a changes provider draws no chips and does not fail', () => {
  const row = { id: 'abc', name: 'demo', group: 'g', room: null, branch: 'b', needs: false, rank: 9, progress: { total: null }, next: null, blocking: [], lastMovement: {}, session: { state: 'free' }, action: null };
  const html = R.summaryView({ rows: [row], generatedAt: 't' }, { now: 0, scope: { kind: 'all' }, rooms: [] });
  assert.doesNotMatch(html, /chip yellow|chip blue|↑ d|↓ d/, 'the session chip is also gray: only the change chips are checked');
});
