'use strict';
// RP52 (S46): the Summary tab. public/resumen.js is pure (payload of /api/summary in, HTML out); the page tests load the
// real public/app.js in a vm with a recording DOM (same approach as rp47) and check the tabs, the scope and the painting.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const R = require('../public/resumen.js');

const PUBLIC = path.join(__dirname, '..', 'public');
const NOW = Date.parse('2026-05-01T12:00:00Z');
const progress = (o = {}) => ({ total: 10, completada: 4, enRevision: 1, bloqueada: 1, pendiente: 3, enCurso: 1, ...o });
const row = (o = {}) => ({
  id: 'r1', name: 'alpha', group: 'G1', room: null, branch: 'main', progress: progress(), session: { state: 'free' },
  next: { id: 'T5', entrega: 'Do five', resultadoVisible: 'See five' }, blocking: [],
  lastMovement: { at: '2026-05-01T11:48:00Z', what: 'fix: thing' }, action: null, error: null, ...o,
});
const payload = (rows, extra = {}) => ({ rows, counts: { working: 0, waiting: 0, blocked: 0, idle: 0 }, attention: [], generatedAt: '2026-05-01T12:00:00Z', ...extra });
const view = (rows, ctx = {}, extra = {}) => R.summaryView(payload(rows, extra), { now: NOW, scope: { kind: 'all' }, rooms: [], ...ctx });
const BAD = '<img src=x onerror=alert(1)>';

// ---------- pure: session chips ----------
test('every session state shows an icon and a word, never colour alone', () => {
  const want = { working: /● working/, waiting: /◐ asking you/, free: /○ free/, none: /○ no session/, unknown: /\? unknown/ };
  for (const [state, re] of Object.entries(want)) {
    const html = view([row({ session: { state } })]);
    assert.match(html, re, state);
  }
});

// ---------- pure: the primary button reuses the page's data-act machinery ----------
test('merge, branch and start actions produce the exact data-act attributes', () => {
  const merge = view([row({ action: { kind: 'merge', label: 'Merge #7 t', pr: 7 } })]);
  assert.match(merge, /<button[^>]*data-act="merge" data-id="r1" data-n="7"/);
  const branch = view([row({ action: { kind: 'branch', label: 'x', pr: null } })]);
  assert.match(branch, /<button[^>]*data-act="pi" data-id="r1" data-cmd="flow-base"/);
  const start = view([row({ action: { kind: 'start', label: 'Start T5: Do five', pr: null } })]);
  assert.match(start, /<button[^>]*data-act="pi" data-id="r1" data-cmd="flow-next"[^>]*>\/flow-next</);
});

test('deliver uses the flow button the board would show; without local state it is disabled and sends nothing', () => {
  const action = { kind: 'deliver', label: 'Deliver', pr: null };
  const pr = view([row({ action })], { flowFor: () => ({ cmd: 'flow-pr', label: '/flow-pr' }) });
  assert.match(pr, /<button[^>]*data-act="pi" data-id="r1" data-cmd="flow-pr"[^>]*>\/flow-pr</);
  const commit = view([row({ action })], { flowFor: () => ({ cmd: 'flow-commit', label: '/flow-commit' }) });
  assert.match(commit, /data-cmd="flow-commit"/);
  const held = view([row({ action })], { flowFor: () => ({ cmd: 'flow-commit', label: '/flow-commit', disabled: true, reason: 'busy' }) });
  assert.match(held, /data-cmd="flow-commit"[^>]*disabled/);
  const unknown = view([row({ action })], { flowFor: () => null });
  assert.doesNotMatch(unknown, /data-act="pi"/);
  assert.match(unknown, /<button[^>]*disabled[^>]*>Deliver</);
});

test('answer, waiting and manual only offer a non-sending Open button', () => {
  for (const kind of ['answer', 'waiting', 'manual']) {
    const html = view([row({ action: { kind, label: 'L', pr: null } })]);
    assert.match(html, /<button[^>]*data-act="focus-repo" data-id="r1"[^>]*>Open</, kind);
    assert.doesNotMatch(html, /data-act="pi"|data-act="merge"/, kind);
  }
});

test('a repo with an order on its way (sending) has its pi button disabled', () => {
  const html = view([row({ action: { kind: 'branch', label: 'x', pr: null } })], { sending: { r1: 'flow-base' } });
  assert.match(html, /data-act="pi"[^>]*disabled/);
  const merge = view([row({ action: { kind: 'merge', label: 'm', pr: 3 } })], { busy: { 'r1:3': true } });
  assert.match(merge, /data-act="merge"[^>]*disabled/);
});

test('a card has no "⋯" button (RP59) and no action means no primary button', () => {
  const html = view([row()]);
  assert.doesNotMatch(html, /⋯|More actions/);
  assert.doesNotMatch(html, /class="primary"|class="merge"/);
});

// ---------- pure: escaping ----------
test('every text that comes from data is HTML-escaped', () => {
  const r = row({
    id: 'id"x', name: BAD, group: BAD, room: BAD, branch: BAD, session: { state: 'waiting' },
    next: { id: BAD, entrega: BAD, resultadoVisible: BAD },
    blocking: [{ unit: BAD, waitsFor: [BAD], external: [BAD] }],
    lastMovement: { at: '2026-05-01T11:00:00Z', what: BAD },
    action: { kind: 'manual', label: BAD, pr: null },
  });
  const e = row({ id: 'e1', name: 'broken', group: BAD, error: BAD, progress: { total: null, completada: null, enRevision: null, bloqueada: null, pendiente: null, enCurso: null }, next: null, action: null });
  const html = R.summaryView(payload([r, e], { attention: [{ id: 'id"x', name: BAD, why: BAD }] }), {
    now: NOW, scope: { kind: 'all' }, rooms: [{ name: BAD, repos: ['id"x'] }], total: 2, failed: false,
  });
  assert.doesNotMatch(html, /<img/);
  assert.doesNotMatch(html, /data-id="id"x"/);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.doesNotMatch(R.scopeBar([{ name: BAD, repos: [] }], 3, { kind: 'room', name: BAD }), /<img/);
});

// ---------- pure: progress ----------
test('the segmented bar has an aria-label and the short n/total text, and its widths never exceed 100', () => {
  const html = view([row({ progress: progress({ total: 7, completada: 3, enRevision: 1, bloqueada: 1, pendiente: 1, enCurso: 1 }) })]);
  assert.match(html, /role="img" aria-label="3 of 7 completed · 1 in review · 1 blocked"/);
  assert.match(html, />3\/7</);
  const widths = [...html.matchAll(/class="rs-seg [a-z-]+" style="width:(\d+(?:\.\d+)?)%"/g)].map((m) => Number(m[1]));
  assert.equal(widths.length, 4);
  assert.ok(widths.reduce((a, b) => a + b, 0) <= 100);
});

test('widths stay within 100 for awkward totals', () => {
  for (const total of [3, 7, 9, 13, 74, 1]) {
    const html = view([row({ progress: { total, completada: Math.floor(total / 3), enRevision: 0, bloqueada: total > 2 ? 1 : 0, pendiente: total - Math.floor(total / 3) - (total > 2 ? 1 : 0), enCurso: 0 } })]);
    const sum = [...html.matchAll(/class="rs-seg [a-z-]+" style="width:(\d+(?:\.\d+)?)%"/g)].reduce((a, m) => a + Number(m[1]), 0);
    assert.ok(sum <= 100, `total ${total}: ${sum}`);
  }
});

test('null progress says "no data" and shows no zeros or bar', () => {
  const html = view([row({ progress: { total: null, completada: null, enRevision: null, bloqueada: null, pendiente: null, enCurso: null }, next: null })]);
  assert.match(html, /no data/);
  assert.doesNotMatch(html, /rs-seg|\b0 \/ 0|0 \/ null/);
});

test('an error row shows the error text, "no data" and no zeros', () => {
  const html = view([row({ id: 'e', name: 'broken', error: 'git exploded', progress: { total: null, completada: null, enRevision: null, bloqueada: null, pendiente: null, enCurso: null }, next: null, session: { state: 'unknown' } })]);
  assert.match(html, /git exploded/);
  assert.match(html, /no data/);
  assert.doesNotMatch(html, /rs-seg|\b0 \/ |data-act="merge"/);
});

test('the next unit shows id and entrega with "Result: ..." in the title; with no next unit a blocked repo shows what it waits for', () => {
  const html = view([row()]);
  assert.match(html, /T5 — Do five/);
  assert.match(html, /title="T5 — Do five\nResult: See five"/);
  const blocked = view([row({ next: null, blocking: [{ unit: 'E3', waitsFor: ['E1', 'E2'], external: ['other repo'] }] })]);
  assert.match(blocked, /Waiting<\/span> · E3 → E1, E2, other repo/);
  assert.match(view([row({ next: null })]), /rs-none/);
});

// ---------- pure: time ----------
test('relativeTime: now, minutes, hours, days, unknown', () => {
  const at = (ms) => new Date(NOW - ms).toISOString();
  assert.equal(R.relativeTime(at(5 * 1000), NOW), 'just now');
  assert.equal(R.relativeTime(at(12 * 60 * 1000), NOW), '12 min ago');
  assert.equal(R.relativeTime(at(3 * 3600 * 1000), NOW), '3 h ago');
  assert.equal(R.relativeTime(at(2 * 86400 * 1000), NOW), '2 d ago');
  assert.equal(R.relativeTime(null, NOW), '—');
  assert.equal(R.relativeTime('garbage', NOW), '—');
  assert.match(view([row()]), /12 min ago/);
});

// ---------- pure: scope, counters, groups ----------
const SCOPE_ROWS = [
  row({ id: 'a', name: 'in-room', room: 'UPEN', session: { state: 'working' }, group: 'G1' }),
  row({ id: 'b', name: 'also-room', room: 'UPEN', session: { state: 'waiting' }, group: 'G1' }),
  row({ id: 'c', name: 'loose-one', room: null, session: { state: 'free' }, blocking: [{ unit: 'X', waitsFor: ['Y'], external: [] }], group: 'G2' }),
  row({ id: 'd', name: 'loose-two', room: null, session: { state: 'none' }, group: 'G2' }),
  row({ id: 'e', name: 'broken', room: null, error: 'nope', group: 'G2', progress: { total: null, completada: null, enRevision: null, bloqueada: null, pendiente: null, enCurso: null }, next: null }),
];
const attention = [{ id: 'b', name: 'also-room', why: 'asks' }, { id: 'c', name: 'loose-one', why: 'blocked' }];

test('the filter counts are computed from the rows in the current scope (the KPI counters are gone)', () => {
  const rows = SCOPE_ROWS.map((r) => ({ ...r, needs: r.id === 'b' || r.id === 'c' }));
  const html = view(rows);
  const tools = R.summaryTools(payload(rows), { now: NOW, scope: { kind: 'all' }, rooms: [] });
  assert.doesNotMatch(tools, /All/, 'RP61: the All button is gone, the toggle is the only one');
  assert.match(tools, /Needs attention · 2/);
  assert.doesNotMatch(html, /rs-kpi|waiting for you|data-act="sfilter"/);
});

test('scope filters the cards and the filter counts', () => {
  const ids = (html) => [...html.matchAll(/<article class="rs-card[^"]*" data-id="([^"]*)"/g)].map((m) => m[1]);
  const rows = SCOPE_ROWS.map((r) => ({ ...r, needs: r.id === 'b' || r.id === 'c' }));
  const upen = R.summaryView(payload(rows), { now: NOW, scope: { kind: 'room', name: 'UPEN' }, rooms: [{ name: 'UPEN', repos: ['a', 'b'] }] });
  assert.deepEqual(ids(upen), ['a', 'b']);
  assert.match(R.summaryTools(payload(rows), { now: NOW, scope: { kind: 'room', name: 'UPEN' }, rooms: [{ name: 'UPEN', repos: ['a', 'b'] }] }), /Needs attention · 1</);
  const none = R.summaryView(payload(rows), { now: NOW, scope: { kind: 'none' }, rooms: [] });
  assert.deepEqual(ids(none), ['c', 'd', 'e']);
  assert.match(R.summaryTools(payload(rows), { now: NOW, scope: { kind: 'none' }, rooms: [] }), /Needs attention · 1</);
  const all = R.summaryView(payload(rows), { now: NOW, scope: { kind: 'all' }, rooms: [] });
  assert.match(R.summaryTools(payload(rows), { now: NOW, scope: { kind: 'all' }, rooms: [] }), /Needs attention · 2</);
  assert.deepEqual(ids(all), ['a', 'b', 'c', 'd', 'e']);
  assert.deepEqual(R.filterRows(SCOPE_ROWS, { kind: 'room', name: 'UPEN' }).map((r) => r.id), ['a', 'b']);
  assert.deepEqual(R.filterRows(SCOPE_ROWS, { kind: 'none' }).map((r) => r.id), ['c', 'd', 'e']);
  assert.equal(R.filterRows(SCOPE_ROWS, { kind: 'all' }).length, 5);
});

test('rows are grouped by repo group, in order of appearance, one header per group', () => {
  const html = view(SCOPE_ROWS);
  assert.equal([...html.matchAll(/class="rs-group"/g)].length, 2);
  assert.ok(html.indexOf('G1') < html.indexOf('G2'));
});

test('the scope bar lists All, each room with its repo count, and No room, with aria-pressed', () => {
  const html = R.scopeBar([{ name: 'UPEN', repos: ['a', 'b'] }, { name: 'H2O', repos: ['c'] }], 5, { kind: 'room', name: 'UPEN' });
  assert.match(html, /<button[^>]*data-act="scope" data-kind="all"[^>]*aria-pressed="false"[^>]*>All <span class="mono">5<\/span>/);
  assert.match(html, /data-kind="room" data-name="UPEN"[^>]*aria-pressed="true"[^>]*>UPEN <span class="mono">2<\/span>/);
  assert.match(html, /data-kind="room" data-name="H2O"[^>]*aria-pressed="false"[^>]*>H2O <span class="mono">1<\/span>/);
  assert.match(html, /data-kind="none"[^>]*aria-pressed="false"[^>]*>No room <span class="mono">2<\/span>/);
  assert.match(R.scopeBar([], 3, { kind: 'all' }), /data-kind="all"[^>]*aria-pressed="true"/);
});

test('a scope that points to a room that no longer exists falls back to All', () => {
  assert.deepEqual(R.normalizeScope({ kind: 'room', name: 'GONE' }, [{ name: 'UPEN' }]), { kind: 'all' });
  assert.deepEqual(R.normalizeScope({ kind: 'room', name: 'UPEN' }, [{ name: 'UPEN' }]), { kind: 'room', name: 'UPEN' });
  assert.deepEqual(R.normalizeScope(undefined, []), { kind: 'all' });
});

// ---------- pure: empty and unavailable ----------
test('an empty payload and a missing payload say so instead of drawing empty cards', () => {
  assert.match(view([]), /No repositories in this scope/);
  assert.doesNotMatch(view([]), /<table/);
  assert.match(R.summaryView(null, { now: NOW, scope: { kind: 'all' }, rooms: [] }), /Loading summary/);
  assert.match(R.summaryView(null, { now: NOW, scope: { kind: 'all' }, rooms: [], failed: true }), /Summary unavailable/);
});

test('a failed refresh keeps the cards and adds a small note', () => {
  const html = view([row()], { failed: true });
  assert.match(html, /summary unavailable/i);
  assert.match(html, /alpha/);
});

test('the one-line bar legend is drawn', () => {
  const html = view(SCOPE_ROWS);
  for (const t of ['Completed', 'In review', 'Blocked', 'Pending']) assert.ok(html.includes(t), t);
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
  const tabEls = ['summary', 'work', 'conformity'].map((t) => ({ ...element(), dataset: { tab: t } }));
  const get = (sel) => (els[sel] ||= (sel === 'meta[name=token]' ? { ...element(), content: 'token' } : element()));
  const ctx = vm.createContext({
    console,
    document: { hidden: false, querySelector: get, querySelectorAll: (s) => (String(s).includes('data-tab') ? tabEls : []), addEventListener() {}, createElement: () => element(), body: element() },
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
  vm.runInContext(fs.readFileSync(path.join(PUBLIC, 'app.js'), 'utf8'), ctx);
  const calls = [];
  // Only /api/summary is answered; every other read (queue, config...) stays pending like in the other page tests.
  const only = (fn) => (url) => (url === '/api/summary' ? (calls.push(url), fn()) : new Promise(() => {}));
  const answer = (body) => { ctx.fetch = only(() => Promise.resolve({ ok: true, json: async () => body })); };
  const fail = () => { ctx.fetch = only(() => Promise.reject(new Error('down'))); };
  return { ctx, get, tabEls, calls, answer, fail, flush: () => { while (frames.length) frames.shift()(); }, run: (code) => vm.runInContext(code, ctx), frames };
}

const withRepos = (page) => {
  const S = page.run('S');
  S.groups = [{ name: 'G', repos: [{ id: 'abc', name: 'demo', path: 'p' }] }];
  S.local.abc = { branch: 'main', detached: false, upstream: 'origin/main', noUpstream: false, ahead: 0, behind: 0, files: [], added: 0, deleted: 0, head: 'h', inProgress: null, base: 'main', stagedCount: 0 };
  S.prs.abc = { prs: [], stale: null, repo: { url: 'https://github.com/o/demo' } };
  return S;
};

test('the page opens on the Summary tab: summary visible, board hidden, summary painted', () => {
  const page = loadPage();
  const S = withRepos(page);
  S.summary = payload([row({ id: 'abc', name: 'demo' })]);
  page.run('render()');
  assert.equal(S.tab, 'summary');
  assert.equal(page.get('#sumLayout').hidden, false);
  assert.equal(page.get('#work').hidden, true);
  assert.match(page.get('#summary').html, /demo/);
  assert.equal(page.tabEls.find((t) => t.dataset.tab === 'summary').attrs['aria-selected'], 'true');
  assert.equal(page.tabEls.find((t) => t.dataset.tab === 'work').attrs['aria-selected'], 'false');
  assert.match(page.get('#app').html, /demo/, 'the board is still drawn underneath');
});

test('switching tabs only toggles hidden: #app and #queue are not rewritten', () => {
  const page = loadPage();
  const S = withRepos(page);
  page.run('render()');
  const app = page.get('#app').writes;
  const queue = page.get('#queue').writes;
  page.run("ACTIONS.tab({ dataset: { tab: 'work' } })");
  page.flush();
  assert.equal(S.tab, 'work');
  assert.equal(page.get('#work').hidden, false);
  assert.equal(page.get('#sumLayout').hidden, true); // RP54: the tab toggles the wrapper that holds the Summary and the chat
  assert.equal(page.tabEls.find((t) => t.dataset.tab === 'work').attrs['aria-selected'], 'true');
  page.run("ACTIONS.tab({ dataset: { tab: 'summary' } })");
  page.flush();
  assert.equal(S.tab, 'summary');
  assert.equal(page.get('#app').writes, app);
  assert.equal(page.get('#queue').writes, queue);
});

test('the Conformity tab opens the drawer and keeps the current tab', () => {
  const page = loadPage();
  const S = withRepos(page);
  page.run("ACTIONS.tab({ dataset: { tab: 'conformity' } })");
  assert.equal(page.get('#drawer').hidden, false);
  assert.equal(S.tab, 'summary');
});

test('the scope action filters the painted summary', () => {
  const page = loadPage();
  const S = withRepos(page);
  S.rooms = [{ name: 'UPEN', repos: ['a'] }];
  S.summary = payload([row({ id: 'a', name: 'in-room', room: 'UPEN' }), row({ id: 'b', name: 'loose', room: null })]);
  page.run('render()');
  assert.match(page.get('#summary').html, /in-room/);
  assert.match(page.get('#summary').html, /loose/);
  page.run("ACTIONS.scope({ dataset: { kind: 'room', name: 'UPEN' } })");
  page.flush();
  assert.deepEqual(JSON.parse(JSON.stringify(S.scope)), { kind: 'room', name: 'UPEN' });
  assert.match(page.get('#summary').html, /in-room/);
  assert.doesNotMatch(page.get('#summary').html, /loose/);
  assert.match(page.get('#scope').html, /data-name="UPEN"[^>]*aria-pressed="true"/);
});

test('focus-repo filters the board to the repo and opens the Work tab', () => {
  const page = loadPage();
  const S = withRepos(page);
  page.run("ACTIONS['focus-repo']({ dataset: { id: 'abc' } })");
  assert.equal(S.q, 'demo');
  assert.equal(S.tab, 'work');
  assert.equal(page.get('#search').value, 'demo');
});

test('an unchanged payload (only generatedAt differs) does not rewrite #summary or ask for a redraw', async () => {
  const page = loadPage();
  withRepos(page);
  page.answer(payload([row({ id: 'abc', name: 'demo' })]));
  await page.run('loadSummary()');
  page.flush();
  const writes = page.get('#summary').writes;
  assert.ok(writes >= 1);
  assert.equal(page.calls[0], '/api/summary');
  page.answer(payload([row({ id: 'abc', name: 'demo' })], { generatedAt: '2026-05-01T12:00:20Z' }));
  await page.run('loadSummary()');
  assert.equal(page.frames.length, 0, 'no redraw was requested');
  page.flush();
  assert.equal(page.get('#summary').writes, writes);
  page.answer(payload([row({ id: 'abc', name: 'demo', branch: 'other' })]));
  await page.run('loadSummary()');
  page.flush();
  assert.match(page.get('#summary').html, /other/);
});

test('a failed fetch keeps the last data and shows a small note instead of blanking the cards', async () => {
  const page = loadPage();
  withRepos(page);
  page.answer(payload([row({ id: 'abc', name: 'demo' })]));
  await page.run('loadSummary()');
  page.flush();
  page.fail();
  await page.run('loadSummary()');
  page.flush();
  assert.match(page.get('#summary').html, /demo/);
  assert.match(page.get('#summary').html, /summary unavailable/i);
  page.answer(payload([row({ id: 'abc', name: 'demo' })]));
  await page.run('loadSummary()');
  page.flush();
  assert.doesNotMatch(page.get('#summary').html, /summary unavailable/i);
});

test('the 20 s tick asks only while the Summary tab is shown and the document is visible', async () => {
  const page = loadPage();
  withRepos(page);
  page.answer(payload([]));
  page.ctx.document.hidden = true;
  page.run('summaryTick()');
  assert.equal(page.calls.length, 0);
  page.ctx.document.hidden = false;
  page.run("S.tab = 'work'; summaryTick()");
  assert.equal(page.calls.length, 0);
  page.run("S.tab = 'summary'; summaryTick()");
  assert.deepEqual(page.calls, ['/api/summary']);
});

test('refreshAll loads the summary too (source check of the 60 s cycle)', () => {
  const src = fs.readFileSync(path.join(PUBLIC, 'app.js'), 'utf8');
  assert.match(src, /async function refreshAll\([^)]*\)[\s\S]*?loadSummary\(\)/); // RP80: refreshAll({ force }) takes an option now
  assert.match(src, /setInterval\([^)]*summaryTick/);
});

test('without resumen.js the Summary tab simply does not paint (and nothing throws)', () => {
  const page = loadPage({ resumen: false });
  withRepos(page);
  page.run('render()');
  assert.equal(page.get('#summary').writes, 0);
  assert.match(page.get('#app').html, /demo/);
});

test('the deliver button on the page is disabled until the repo local state is loaded, then follows the board', () => {
  const page = loadPage();
  const S = withRepos(page);
  S.summary = payload([row({ id: 'abc', name: 'demo', action: { kind: 'deliver', label: 'Deliver', pr: null } })]);
  delete S.local.abc;
  page.run('render()');
  assert.doesNotMatch(page.get('#summary').html, /data-act="pi"/);
  S.local.abc = { branch: 'feat', detached: false, upstream: 'origin/feat', noUpstream: false, ahead: 0, behind: 0, files: [{ path: 'a.txt', status: 'M', untracked: false }], added: 1, deleted: 0, head: 'h', inProgress: null, base: 'main', stagedCount: 0 };
  S.state.abc = { state: 'ready-to-commit', next: 'x', at: new Date().toISOString() };
  S.live.abc = 'idle';
  S.liveAnswered.abc = true;
  page.run('render()');
  assert.match(page.get('#summary').html, /data-act="pi" data-id="abc" data-cmd="flow-commit"/);
});

// ---------- index.html and server ----------
test('index.html: tab bar, scope container, summary and work wrappers, no Activity tab, script order', () => {
  const html = fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8');
  assert.match(html, /role="tablist"/);
  for (const t of ['summary', 'work', 'conformity']) assert.match(html, new RegExp(`role="tab"[^>]*data-act="tab" data-tab="${t}"`));
  assert.doesNotMatch(html, /Activity/);
  assert.match(html, /id="scope"/);
  assert.match(html, /<section id="summary"[^>]*role="tabpanel"/);
  assert.match(html, /<div id="work"[^>]*>[\s\S]*id="queue"[\s\S]*<main id="app">/);
  for (const id of ['search', 'groupFilter', 'alerts', 'method', 'delBranch', 'cleanAsColumn']) assert.match(html, new RegExp(`id="${id}"`));
  assert.ok(html.indexOf('/view.js') < html.indexOf('/resumen.js') && html.indexOf('/resumen.js') < html.indexOf('/app.js'));
});

test('style: only the view-specific zones hide by tab (RP61) and the tabs have a visible focus style', () => {
  const css = fs.readFileSync(path.join(PUBLIC, 'style.css'), 'utf8');
  assert.match(css, /body\.tab-summary[^{]*#workTools/);
  assert.match(css, /body\.tab-work[^{]*#summaryTools/);
  assert.match(css, /\.rs-tabs button:focus-visible|:focus-visible/);
  assert.match(css, /prefers-reduced-motion/);
});

test('API_VERSION is still 15: the page needs no new route', () => {
  assert.equal(require('../public/view.js').API_VERSION, 15);
});

// ---------- visual review of RP52 (real data) ----------
test('the project name and branch stay on one clipped line with the full text in title', () => {
  const html = view([row({ name: 'CROSS.BackofficeFront', branch: 'feat/a-very-long-branch-name' })]);
  assert.match(html, /<b class="rs-name" title="CROSS.BackofficeFront">CROSS.BackofficeFront<\/b>/);
  assert.match(html, /class="mono rs-branch" title="feat\/a-very-long-branch-name"/);
  const css = fs.readFileSync(path.join(PUBLIC, 'style.css'), 'utf8');
  assert.match(css, /\.rs-branch[^{]*\{[^}]*white-space:\s*nowrap[^}]*text-overflow:\s*ellipsis/);
  assert.match(css, /\.rs-next\s*\{[^}]*white-space:\s*nowrap[^}]*text-overflow:\s*ellipsis/);
});

test('the start button keeps a fixed /flow-next label however long the unit id is, with the id escaped in the title', () => {
  const id = 'standardize-cross-api-errors-push-producer-x'.padEnd(60, 'z');
  assert.equal(id.length, 60);
  const html = view([row({ next: { id, entrega: 'e', resultadoVisible: 'r' }, action: { kind: 'start', label: 'x', pr: null } })]);
  const m = html.match(/<button class="primary" data-act="pi" data-id="r1" data-cmd="flow-next"([^>]*)>([^<]*)<\/button>/);
  assert.ok(m, 'start button');
  assert.equal(m[2], '/flow-next');
  assert.ok(m[1].includes(`(starts ${id})`));
  const bad = view([row({ next: { id: BAD, entrega: 'e', resultadoVisible: 'r' }, action: { kind: 'start', label: 'x', pr: null } })]);
  assert.doesNotMatch(bad, /<img/);
  const merge = view([row({ action: { kind: 'merge', label: 'm', pr: 123456789012345678901234567890 } })]);
  assert.match(merge, /data-act="merge"[^>]*aria-label="Merge #/);
});

test('an empty or dash-only resultadoVisible renders no Result line', () => {
  for (const v of ['', '—', '-', ' – ', null]) {
    const html = view([row({ next: { id: 'T5', entrega: 'Do five', resultadoVisible: v } })]);
    assert.doesNotMatch(html, /Result:/, JSON.stringify(v));
    assert.match(html, /Do five/);
  }
  assert.match(view([row()]), /Result: See five/);
});
