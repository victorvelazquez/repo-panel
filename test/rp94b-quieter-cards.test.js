'use strict';
// RP94 part b (S9): four more things that were shown without need. The requirements notice is one small warning with the number (the hide button is already in the
// card menu); the colour legend sits behind a "?" (a native <details>, no script); the "Updating…" text is gone (its tooltip stays on the card and the card says it is
// busy); the group tag appears only when several groups are visible. The room tag and the status line that repeats the roadmap wait for RP94b2. How it LOOKS is for the
// person to approve by looking; these tests pin the structure, the rules and what is still shown. No network, no real clock.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const V = require('../public/view.js');
const R = require('../public/resumen.js');

const read = (f) => fs.readFileSync(path.join(__dirname, '..', 'public', f), 'utf8').replace(/\r\n/g, '\n');
const css = read('style.css');
const NOW = Date.UTC(2026, 4, 1, 12, 0, 0);
const row = (o = {}) => ({
  id: 'r1', name: 'alpha', group: 'g', room: null, branch: 'b', needs: false, rank: 9,
  progress: { total: 12, completada: 5, enRevision: 0, bloqueada: 0, pendiente: 7, enCurso: 0 }, next: null, blocking: [],
  lastMovement: {}, session: { state: 'free' }, action: null, ...o,
});
const view = (rows, ctx = {}) => R.summaryView({ rows, generatedAt: 't' }, { now: NOW, scope: { kind: 'all' }, rooms: [], changesFor: () => null, ...ctx });

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
const ONE = "S.groups = [{ name: 'Personal', repos: [" + REPO + '] }];';
const TWO = "S.groups = [{ name: 'Personal', repos: [" + REPO + "] }, { name: 'Work', repos: [] }];";
const seed = (page, groups = ONE, local = { branch: 'main', files: [], ahead: 0, behind: 0 }) => page.run(`${groups} S.group = ''; S.local.abc = ${JSON.stringify(local)}; S.prs.abc = { prs: [] }; S.menu = null;`);
const needs = (n) => `S.req.abc = { state: 'loaded', data: { results: [${Array.from({ length: n }, (_, i) => `{ id: 'R${i + 1}', level: 'required', status: 'fail' }`).join(', ')}] } };`;

// ---------- the group tag ----------
test('g1: with ONE group the cards carry no group tag (the board card and the clean row)', () => {
  const page = loadPage();
  seed(page, ONE);
  assert.doesNotMatch(page.run(`cleanRow(${REPO})`), /class="tag"/);
  assert.doesNotMatch(page.run(`repoCard(${REPO})`), /class="tag"/);
  assert.equal(page.run(`identityHtml(${REPO}, undefined)`), page.run(`roomTag(${REPO}) + repoName(${REPO}, undefined)`));
});

test('g2: with several groups and the filter on "All groups" the tag shows, in the board card and in the clean row', () => {
  const page = loadPage();
  seed(page, TWO);
  assert.match(page.run(`cleanRow(${REPO})`), /<span class="tag" style="[^"]*">Personal<\/span>/);
  assert.match(page.run(`repoCard(${REPO})`), /<span class="tag" style="[^"]*">Personal<\/span>/);
});

test('g3: with several groups but ONE chosen in the filter the tag is hidden (it would repeat the filter)', () => {
  const page = loadPage();
  seed(page, TWO);
  page.run("S.group = 'Personal';");
  assert.doesNotMatch(page.run(`cleanRow(${REPO})`), /class="tag"/);
  assert.doesNotMatch(page.run(`repoCard(${REPO})`), /class="tag"/);
  page.run("S.group = '';");
  assert.match(page.run(`cleanRow(${REPO})`), /class="tag"/, 'back on All groups the tag is back');
});

test('g4: the room tag and the repo name are not affected (the room tag waits for RP94b2)', () => {
  const page = loadPage();
  seed(page, ONE);
  page.run("S.rooms = [{ name: 'UPEN', repos: ['abc'] }];");
  const h = page.run(`cleanRow(${REPO})`);
  assert.match(h, /room-tag/);
  assert.match(h, /class="repo-name"/);
});

// ---------- the requirements notice ----------
test('r1: the notice is one small warning with the number: no long text, no hide button, and the count is in the title and the aria-label', () => {
  const page = loadPage();
  seed(page);
  page.run(needs(2));
  const h = page.run(`reqWarn(${REPO})`);
  assert.match(h, /^<div class="req-warn" title="2 requirements missing: R1, R2">/);
  assert.match(h, /<span role="img" aria-label="2 requirements missing">⚠ 2<\/span>/);
  assert.doesNotMatch(h, /<button|✕|requirements missing<\/span>/);
});

test('r2: one requirement reads in the singular, and a hidden or absent notice draws nothing', () => {
  const page = loadPage();
  seed(page);
  page.run(needs(1));
  assert.match(page.run(`reqWarn(${REPO})`), /aria-label="1 requirement missing"/);
  page.run("S.dismissed.add('abc');");
  assert.equal(page.run(`reqWarn(${REPO})`), '');
  page.run("S.dismissed.delete('abc'); S.req.abc = { state: 'loaded', data: { results: [{ id: 'R1', level: 'recommended', status: 'fail' }] } };");
  assert.equal(page.run(`reqWarn(${REPO})`), '', 'a recommended gap shows nothing');
});

test('r3: the way to hide the notice is still in the card menu', () => {
  const page = loadPage();
  seed(page);
  page.run(`${needs(1)} S.menu = 'abc|repo';`);
  assert.match(page.run(`repoCard(${REPO})`), /data-act="toggle-warning" data-id="abc">Hide warning</);
});

test('r4: the notice stays where it was on the cards: after the top line and before the branch, and in the clean row after the actions', () => {
  const page = loadPage();
  seed(page, ONE, { branch: 'feat/x', files: [{ path: 'a.js', status: 'M' }], added: 1, deleted: 0, ahead: 0, behind: 0 });
  page.run(needs(1));
  const h = page.run(`repoCard(${REPO})`);
  assert.ok(h.indexOf('class="card-top"') < h.indexOf('class="req-warn"') && h.indexOf('class="req-warn"') < h.indexOf('class="branch one-line"'));
  seed(page);
  page.run(needs(1));
  const c = page.run(`cleanRow(${REPO})`);
  assert.ok(c.indexOf('class="row-actions"') < c.indexOf('class="req-warn"'));
});

// ---------- the legend ----------
test('l1: the legend is a closed <details> behind a "?", with the four bar keys and the note about the button inside it', () => {
  const html = view([row()]);
  const m = /<details class="rs-legend">([\s\S]*?)<\/details>/.exec(html);
  assert.ok(m, 'a details element');
  assert.match(m[1], /^<summary title="Bar legend" aria-label="Bar legend">\?<\/summary>/);
  for (const k of ['rs-done', 'rs-pr', 'rs-blk', 'rs-pend']) assert.match(m[1], new RegExp(`<i class="rs-key ${k}"></i>`));
  for (const w of ['Completed', 'In review', 'Blocked', 'Pending', 'The button on the right is the best next action']) assert.ok(m[1].includes(w), w);
  assert.doesNotMatch(html, /<details[^>]* open/, 'closed by default');
});

test('l2: the legend comes after the list, and an empty scope has none', () => {
  const html = view([row()]);
  assert.ok(html.lastIndexOf('rs-legend') > html.lastIndexOf('rs-card'));
  assert.doesNotMatch(view([]), /rs-legend/);
});

test('l3: the styles: the "?" is a pointer with a visible keyboard focus, and the body keeps the legend layout', () => {
  assert.match(css, /\.rs-legend summary\s*\{[^}]*cursor:\s*pointer/);
  assert.match(css, /\.rs-legend summary:focus-visible/);
  assert.match(css, /\.rs-legend-body\s*\{[^}]*display:\s*flex[^}]*flex-wrap:\s*wrap/);
});

// ---------- Updating… ----------
test('u1: a stale row has no "Updating…" text; the card says it is busy and its tooltip names the facts being refreshed', () => {
  const html = view([row({ stale: { facts: ['prs', 'local'] } })]);
  assert.doesNotMatch(html, /Updating…<\/span>|rs-stale/);
  assert.match(html, /<article class="rs-card" data-id="r1" data-act="chat-open" tabindex="0" aria-label="alpha" title="Updating: prs, local" aria-busy="true">/);
});

test('u2: no stale, or an empty list of facts, leaves the card as it was (no title, no aria-busy); a loading card is untouched', () => {
  for (const r of [row(), row({ stale: { facts: [] } }), row({ stale: {} })]) assert.doesNotMatch(view([r]), /aria-busy|Updating/);
  const loading = view([{ id: 'l1', name: 'loady', loading: true, stale: { facts: ['prs'] } }]);
  assert.match(loading, /aria-busy="true" aria-label="loady"/);
  assert.doesNotMatch(loading, /Updating/);
});

test('u3: the facts in the tooltip are escaped', () => {
  assert.match(view([row({ stale: { facts: ['a"b', '<x>'] } })]), /title="Updating: a&quot;b, &lt;x&gt;"/);
});

test('u4: RepoCard draws the title and aria-busy only when asked, escaped, and not on the other modes', () => {
  assert.match(V.RepoCard({ id: 'r', label: 'n', title: 'T"1', busy: true }, 'summary'), /aria-label="n" title="T&quot;1" aria-busy="true">/);
  assert.doesNotMatch(V.RepoCard({ id: 'r', label: 'n' }, 'summary'), /aria-label="n" title=|aria-busy/);
  assert.doesNotMatch(V.RepoCard({ id: 'r', label: 'n', title: 'T', busy: true, top: '<p>T</p>', branch: { text: 'b', title: 'b' } }, 'work'), /aria-busy/);
});
