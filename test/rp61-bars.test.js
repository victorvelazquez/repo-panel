'use strict';
// RP61 (S58): three fixed levels (global bar, tabs, view bar), the shared filters apply to Summary and Work, one
// "Needs attention" toggle, the Merge menu, and the server rule "a Blocked unit counts only when nothing can be taken".
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-panel-rp61-'));
process.env.REPO_PANEL_CONFIG = path.join(dir, 'config.json');
process.env.REPO_PANEL_CASES_FILE = 'off';

const test = require('node:test');
const assert = require('node:assert/strict');
const R = require('../public/resumen.js');
const { summarize } = require('../server/summary.js');

test.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 }));

const PUBLIC = path.join(__dirname, '..', 'public');
const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const NOW = Date.parse('2026-05-01T12:00:00Z');

// ---------- server: Blocked counts only when nothing can be taken ----------
const unit = (id, estado) => ({ id, entrega: `deliver ${id}`, resultadoVisible: `see ${id}`, dependsOn: [], externalDeps: [], estado });
const facts = (rm) => ({
  repo: { id: 'r1', name: 'repo-one', group: 'G', room: null },
  local: { branch: 'x', files: [], ahead: 0, behind: 0, base: 'main' },
  prs: { prs: [], stale: null }, roadmap: rm, state: { available: false }, session: 'closed',
  last: { at: '2026-10-28T10:00:00Z', what: 's' }, now: Date.parse('2026-10-28T12:00:00Z'),
});
const roadmap = (rows, next = null) => ({ available: true, rows, derived: {}, next });

test('a Blocked unit with no takeable next unit still needs attention', () => {
  const row = summarize(facts(roadmap([unit('B', 'Bloqueada')])));
  assert.equal(row.needs, true);
  assert.equal(row.rank, 8);
});

test('a Blocked unit AND a takeable next unit does not need attention, but keeps blocking, counts and rank', () => {
  const rows = [unit('B', 'Bloqueada'), unit('A', 'Pendiente')];
  const f = facts(roadmap(rows, rows[1]));
  const row = summarize(f);
  assert.equal(row.needs, false);
  assert.deepEqual(row.blocking.map((b) => b.unit), ['B']);
  assert.equal(row.next.id, 'A');
  assert.equal(row.rank, 6, 'rank is still the start action');
});

test('a failing CI still needs attention when a next unit exists', () => {
  const rows = [unit('B', 'Bloqueada'), unit('A', 'Pendiente')];
  const f = facts(roadmap(rows, rows[1]));
  f.prs = { prs: [{ number: 4, title: 't', ready: false, checks: { state: 'failed' } }], stale: null };
  assert.equal(summarize(f).needs, true);
});

// ---------- pure: the shared filters on the Summary cards ----------
const row = (o = {}) => ({
  id: 'r1', name: 'alpha', group: 'G1', room: null, branch: 'main', progress: { total: 2, completada: 1, enRevision: 0, bloqueada: 0, pendiente: 1, enCurso: 0 },
  session: { state: 'free' }, next: null, blocking: [], lastMovement: { at: '2026-05-01T11:48:00Z', what: 'x' }, action: null, error: null, needs: false, rank: 9, ...o,
});
const payload = (rows) => ({ rows, counts: {}, attention: [], generatedAt: '2026-05-01T12:00:00Z' });
const ctxOf = (ctx = {}) => ({ now: NOW, scope: { kind: 'all' }, rooms: [], ...ctx });
const view = (rows, ctx) => R.summaryView(payload(rows), ctxOf(ctx));
const ids = (html) => [...html.matchAll(/<article class="rs-card[^"]*"[^>]* data-id="([^"]*)"/g)].map((m) => m[1]);
const ROWS = [
  row({ id: 'a', name: 'Alpha-App', group: 'G1', needs: true }),
  row({ id: 'b', name: 'beta-api', group: 'G1' }),
  row({ id: 'c', name: 'alphabet', group: 'G2', needs: true }),
  row({ id: 'd', name: 'delta', group: 'G2' }),
];

test('q filters by name, case-insensitive; empty means no filter', () => {
  assert.deepEqual(ids(view(ROWS, { q: 'ALPHA' })), ['a', 'c']);
  assert.deepEqual(ids(view(ROWS, { q: 'api' })), ['b']);
  assert.deepEqual(ids(view(ROWS, { q: '' })), ['a', 'b', 'c', 'd']);
  assert.deepEqual(ids(view(ROWS, {})), ['a', 'b', 'c', 'd']);
  assert.match(view(ROWS, { q: 'zzz' }), /No repositories in this scope/);
});

test('group filters by equality; empty and "all" mean no filter', () => {
  assert.deepEqual(ids(view(ROWS, { group: 'G2' })), ['c', 'd']);
  assert.deepEqual(ids(view(ROWS, { group: '' })), ['a', 'b', 'c', 'd']);
  assert.deepEqual(ids(view(ROWS, { group: 'all' })), ['a', 'b', 'c', 'd']);
});

test('q, group and scope combine; the group header appears only when more than one group is visible', () => {
  const html = view(ROWS, { q: 'alpha' });
  assert.match(html, /data-act="toggle-group"/);
  assert.doesNotMatch(view(ROWS, { q: 'alpha', group: 'G1' }), /toggle-group/);
  const scoped = ROWS.map((r) => (r.id === 'a' || r.id === 'b' ? { ...r, room: 'R' } : r));
  const rooms = [{ name: 'R', repos: ['a', 'b'] }];
  assert.deepEqual(ids(view(scoped, { scope: { kind: 'room', name: 'R' }, rooms, q: 'beta' })), ['b']);
});

test('the attention view honours q and group too', () => {
  assert.deepEqual(ids(view(ROWS, { filter: 'attention', q: 'alphab' })), ['c']);
  assert.deepEqual(ids(view(ROWS, { filter: 'attention', group: 'G1' })), ['a']);
});

test('room cards are not pinned while a text or group filter is active', () => {
  const ctx = { rooms: [{ name: 'R', repos: ['a'] }], roomData: { rooms: [{ name: 'R', repos: ['a'], presence: { state: 'idle' }, lastCommit: null }] } };
  assert.match(view(ROWS, ctx), /rs-room/);
  assert.doesNotMatch(view(ROWS, { ...ctx, q: 'alpha' }), /rs-room/);
  assert.doesNotMatch(view(ROWS, { ...ctx, group: 'G1' }), /rs-room/);
});

// ---------- pure: the view-bar tools of the Summary ----------
test('summaryTools: ONE toggle with aria-pressed and the count of the filtered rows, and no "updated" text (RP82)', () => {
  const off = R.summaryTools(payload(ROWS), ctxOf());
  assert.match(off, /<button type="button" data-act="sfilter" data-filter="attention" aria-pressed="false">Needs attention · 2<\/button>/);
  assert.doesNotMatch(off, /All|data-filter="all"/);
  assert.doesNotMatch(off, /updated|just now| ago/, 'RP82: the age of the data is gone from the bar');
  assert.doesNotMatch(R.summaryTools({ ...payload(ROWS), generatedAt: '2026-05-01T11:57:00Z' }, ctxOf()), /updated|min ago/);
  const on = R.summaryTools(payload(ROWS), ctxOf({ filter: 'attention' }));
  assert.match(on, /data-filter="all" aria-pressed="true">Needs attention · 2</);
  assert.equal((on.match(/<button/g) || []).length, 1);
});

test('summaryTools counts after scope, q and group; it is empty without a payload', () => {
  assert.match(R.summaryTools(payload(ROWS), ctxOf({ q: 'alphab' })), /Needs attention · 1</);
  assert.match(R.summaryTools(payload(ROWS), ctxOf({ group: 'G1' })), /Needs attention · 1</);
  assert.equal(R.summaryTools(null, ctxOf()), '');
  assert.equal(R.summaryTools({}, ctxOf()), '');
});

test('summaryView no longer paints the filter head inside #summary', () => {
  const html = view(ROWS);
  assert.doesNotMatch(html, /rs-filters|data-act="sfilter"|updated /);
});

// ---------- index.html: three levels ----------
test('index.html (RP82): Needs attention sits right after the scope buttons, before the spacer that pushes the Work tools right', () => {
  const html = read('public/index.html');
  const bar = html.slice(html.indexOf('id="viewbar"'), html.indexOf('<section id="summary"'));
  const at = (s) => bar.indexOf(s);
  assert.ok(at('id="search"') < at('id="groupFilter"') && at('id="groupFilter"') < at('id="scope"'));
  assert.ok(at('id="scope"') < at('id="summaryTools"'), 'the toggle comes after the scope buttons');
  assert.ok(at('id="summaryTools"') < at('class="spacer"'), 'and before the spacer, so it stays next to them');
  assert.ok(at('class="spacer"') < at('id="workTools"'), 'the Work tools stay at the right end');
  assert.equal((bar.match(/class="spacer"/g) || []).length, 1);
});

test('index.html: header, tabs and view bar in that order; shared controls in the view bar, Merge menu in the header', () => {
  const html = read('public/index.html');
  const at = (s) => html.indexOf(s);
  assert.ok(at('<header>') < at('<nav class="rs-tabs"') && at('<nav class="rs-tabs"') < at('id="viewbar"') && at('id="viewbar"') < at('<section id="summary"'));
  const header = html.slice(at('<header>'), at('</header>'));
  const bar = html.slice(at('id="viewbar"'), at('<section id="summary"'));
  for (const id of ['search', 'groupFilter', 'scope']) { assert.match(bar, new RegExp(`id="${id}"`)); assert.doesNotMatch(header, new RegExp(`id="${id}"`)); }
  for (const id of ['alerts', 'cleanAsColumn']) { assert.match(bar, new RegExp(`id="${id}"`)); assert.doesNotMatch(header, new RegExp(`id="${id}"`)); }
  assert.match(header, /<details class="pop" id="mergeMenu"><summary aria-label="Merge settings">⚙ Merge<\/summary><div class="pop-body">/);
  assert.match(header, /id="method"[^>]*data-pref="method"|data-pref="method"[^>]*id="method"/);
  assert.match(header, /id="delBranch"[^>]*data-pref="del"|data-pref="del"[^>]*id="delBranch"/);
  assert.match(header, /Used by the Merge buttons of Summary and Work/);
  assert.doesNotMatch(header, /id="conformity"|confBadge/, 'RP60: the duplicate Conformity button is gone from the header');
  assert.match(html, /id="tab-conformity"[^>]*>Conformity <span id="confBadge"/);
  assert.match(header, /data-act="refresh-all"[^>]*><span class="ico">↻<\/span> Refresh<\/button>/);
  assert.match(bar, /id="summaryTools"/);
  assert.match(bar, /<input id="cleanAsColumn" type="checkbox" data-pref="cleanAsColumn">/);
});

test('style: the view-specific zones hide by body class; the shared controls are never hidden', () => {
  const css = read('public/style.css');
  assert.match(css, /body\.tab-summary[^{]*#workTools[^{]*\{[^}]*display:\s*none/);
  assert.match(css, /body\.tab-work[^{]*#summaryTools[^{]*\{[^}]*display:\s*none/);
  assert.doesNotMatch(css, /body\.tab-summary[^{]*#(search|groupFilter|alerts)/);
  assert.doesNotMatch(css, /body\.tab-work #scope/);
  assert.match(css, /\.viewbar\s*\{/);
  assert.match(css, /details\.pop[^{]*\{/);
  assert.match(css, /\.pop-body\s*\{/);
  assert.match(css, /details\.pop > summary:focus-visible|\.pop summary:focus-visible/);
});

// ---------- page ----------
function element() {
  const el = {
    writes: 0, html: '', hidden: false, dataset: {}, disabled: false, value: '', checked: false, textContent: '', title: '', attrs: {},
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    style: {}, addEventListener() {}, setAttribute(k, v) { el.attrs[k] = v; }, querySelector: () => null, querySelectorAll: () => [], closest: () => null, showModal() {}, close() {}, focus() {},
    get innerHTML() { return el.html; },
    set innerHTML(v) { el.html = String(v); el.writes++; },
  };
  return el;
}

function loadPage({ resumen = true } = {}) {
  const els = {};
  const frames = [];
  const handlers = {};
  const get = (sel) => (els[sel] ||= (sel === 'meta[name=token]' ? { ...element(), content: 'token' } : element()));
  const ctx = vm.createContext({
    console,
    document: {
      hidden: false, querySelector: get, querySelectorAll: () => [], createElement: () => element(), body: element(),
      addEventListener(type, fn) { (handlers[type] ||= []).push(fn); },
    },
    localStorage: { getItem: () => null, setItem() {} },
    location: { hash: '' },
    requestAnimationFrame: (cb) => { frames.push(cb); return frames.length; },
    setInterval: () => 0,
    setTimeout: () => 0, clearTimeout: () => {}, AbortController,
    confirm: () => true,
    fetch: () => new Promise(() => {}),
  });
  ctx.window = ctx;
  ctx.addEventListener = () => {};
  ctx.RepoPanelView = require('../public/view.js');
  if (resumen) ctx.RepoPanelResumen = R;
  vm.runInContext(read('public/app.js'), ctx);
  return { ctx, get, handlers, frames, flush: () => { while (frames.length) frames.shift()(); }, run: (code) => vm.runInContext(code, ctx) };
}

const withRepos = (page) => {
  const S = page.run('S');
  S.groups = [{ name: 'G1', repos: [{ id: 'a', name: 'Alpha-App', path: 'pa' }, { id: 'b', name: 'beta-api', path: 'pb' }] }, { name: 'G2', repos: [{ id: 'c', name: 'gamma', path: 'pc' }] }];
  S.rooms = [{ name: 'R', repos: ['a', 'c'] }];
  return S;
};
const names = (page) => page.run('visibleRepos()').map((r) => r.name);

test('visibleRepos honours the room scope: all, a room, and no room', () => {
  const page = loadPage();
  const S = withRepos(page);
  assert.deepEqual(names(page), ['Alpha-App', 'beta-api', 'gamma']);
  S.scope = { kind: 'room', name: 'R' };
  assert.deepEqual(names(page), ['Alpha-App', 'gamma']);
  S.scope = { kind: 'none' };
  assert.deepEqual(names(page), ['beta-api']);
  S.scope = { kind: 'room', name: 'ghost' };
  assert.deepEqual(names(page), ['Alpha-App', 'beta-api', 'gamma'], 'an unknown room degrades to all');
});

test('visibleRepos combines scope with the text and group filters', () => {
  const page = loadPage();
  const S = withRepos(page);
  S.scope = { kind: 'room', name: 'R' };
  S.q = 'ALPHA';
  assert.deepEqual(names(page), ['Alpha-App']);
  S.q = '';
  S.group = 'G2';
  assert.deepEqual(names(page), ['gamma']);
});

test('without resumen.js the scope degrades to all instead of throwing', () => {
  const page = loadPage({ resumen: false });
  const S = withRepos(page);
  S.scope = { kind: 'none' };
  assert.deepEqual(names(page), ['Alpha-App', 'beta-api', 'gamma']);
});

test('the Go work on strip (queueItems) follows the scope', () => {
  const page = loadPage();
  const S = withRepos(page);
  for (const id of ['a', 'b', 'c']) {
    S.local[id] = { branch: 'main', files: [], ahead: 0, behind: 0, base: 'main', head: 'h' };
    S.prs[id] = { prs: [], stale: null, repo: { url: 'u' } };
  }
  S.scope = { kind: 'none' };
  assert.deepEqual(page.run('queueItems()').map((i) => i.id), ['b']);
});

test('the Summary cards honour S.q and S.group, and the tools are painted outside #summary', () => {
  const page = loadPage();
  const S = withRepos(page);
  S.summary = payload(ROWS.map((r, i) => ({ ...r, id: ['a', 'b', 'c', 'd'][i] })));
  page.run('render()');
  assert.deepEqual(ids(page.get('#summary').html), ['a', 'b', 'c', 'd']);
  S.q = 'alphab';
  page.run('render()');
  assert.deepEqual(ids(page.get('#summary').html), ['c']);
  assert.match(page.get('#summaryTools').html, /Needs attention · 1</);
  assert.doesNotMatch(page.get('#summary').html, /sfilter/);
  S.q = '';
  S.group = 'G2';
  page.run('render()');
  assert.deepEqual(ids(page.get('#summary').html), ['c', 'd']);
});

test('the shared inputs are never repainted by render()', () => {
  const page = loadPage();
  withRepos(page);
  page.run('render()');
  for (const sel of ['#search', '#groupFilter']) assert.equal(page.get(sel).writes, 0, sel);
});

test('the sfilter action toggles between attention and all and the button carries the value it would set', () => {
  const page = loadPage();
  const S = withRepos(page);
  S.summary = payload(ROWS.map((r, i) => ({ ...r, id: ['a', 'b', 'c', 'd'][i] })));
  page.run('render()');
  assert.match(page.get('#summaryTools').html, /data-filter="attention" aria-pressed="false"/);
  page.run("ACTIONS.sfilter({ dataset: { filter: 'attention' } })");
  page.flush();
  assert.equal(S.sfilter, 'attention');
  assert.match(page.get('#summaryTools').html, /data-filter="all" aria-pressed="true"/);
  page.run("ACTIONS.sfilter({ dataset: { filter: 'all' } })");
  page.flush();
  assert.equal(S.sfilter, 'all');
});

test('the keyboard focus stays on the Needs attention button after the redraw', () => {
  const btn = { dataset: { act: 'sfilter', filter: 'attention' }, focused: 0, focus() { this.focused++; } };
  const page = loadPage();
  const S = withRepos(page);
  page.ctx.document.activeElement = btn;
  const found = page.get('#summaryTools [data-act="sfilter"]');
  found.focus = () => btn.focus();
  S.summary = payload(ROWS);
  page.run('render()');
  assert.equal(btn.focused, 1);
});

// ---------- the Merge menu ----------
test('the Merge menu closes with Escape and with a click outside, and stays open for a click inside', () => {
  const page = loadPage();
  const menu = page.get('#mergeMenu');
  menu.open = true;
  const target = (id) => ({ id, closest: () => null });
  const inside = target('inside');
  menu.contains = (t) => t === inside;
  const fire = (type, e) => (page.handlers[type] || []).forEach((fn) => fn(e));
  fire('click', { target: inside });
  assert.equal(menu.open, true);
  fire('click', { target: target('outside') });
  assert.equal(menu.open, false);
  menu.open = true;
  fire('keydown', { key: 'Enter' });
  assert.equal(menu.open, true);
  fire('keydown', { key: 'Escape' });
  assert.equal(menu.open, false);
});

test('the Merge menu handlers tolerate a closed menu and stubs without contains', () => {
  const page = loadPage();
  const menu = page.get('#mergeMenu');
  menu.open = false;
  const fire = (type, e) => (page.handlers[type] || []).forEach((fn) => fn(e));
  assert.doesNotThrow(() => { fire('click', { target: { closest: () => null } }); fire('keydown', { key: 'Escape' }); });
  menu.open = true;
  assert.doesNotThrow(() => fire('click', { target: { closest: () => null } }));
});

test('the method and delete-branch controls keep their ids and prefs (change listener and load values)', () => {
  const src = read('public/app.js');
  assert.match(src, /\$\('#method'\)\.value = S\.prefs\.method/);
  assert.match(src, /\$\('#delBranch'\)\.checked = S\.prefs\.del/);
  assert.match(src, /\$\('#cleanAsColumn'\)\.checked = cleanAsColumn\(\)/);
});

test('API_VERSION is still 15', () => {
  assert.equal(require('../public/view.js').API_VERSION, 15);
});
