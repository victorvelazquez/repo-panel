'use strict';
// RP59 (S52, S54, S55): the Summary tab as a list of compact cards. Server side: the `needs` and `rank` fields of every row of
// GET /api/summary. Client side: public/resumen.js (pure: payload in, HTML out) and the wiring in public/app.js (vm, as rp52).
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-panel-rp59-'));
process.env.REPO_PANEL_CONFIG = path.join(dir, 'config.json');
process.env.REPO_PANEL_CASES_FILE = 'off';

const test = require('node:test');
const assert = require('node:assert/strict');
const R = require('../public/resumen.js');
const { summarize } = require('../server/summary.js');

test.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 }));

const PUBLIC = path.join(__dirname, '..', 'public');
const NOW = Date.parse('2026-05-01T12:00:00Z');
const BAD = '<img src=x onerror=alert(1)>';

// ---------- server: needs and rank ----------
const unit = (id, estado) => ({ id, entrega: `deliver ${id}`, resultadoVisible: `see ${id}`, dependsOn: [], externalDeps: [], estado });
const roadmap = (rows, next = null) => ({ available: true, rows, derived: {}, next });
const facts = (over = {}) => ({
  repo: { id: 'r1', name: 'repo-one', group: 'G', room: null },
  local: { branch: 'x', files: [], ahead: 0, behind: 0, base: 'main' },
  prs: { prs: [], stale: null }, roadmap: roadmap([]), state: { available: false }, session: 'closed',
  last: { at: '2026-10-28T10:00:00Z', what: 's' }, now: Date.parse('2026-10-28T12:00:00Z'), ...over,
});
const dirty = { branch: 'x', files: [{ path: 'a' }], ahead: 0, behind: 0, base: 'main' };
const waitingState = { available: true, state: 'needs-input', next: 'Pick one', at: '2026-10-28T11:59:00Z', stale: false };
const failing = { number: 4, title: 't', ready: false, checks: { state: 'failed' } };
const A = [unit('A', 'Pendiente')];

const LEVELS = [
  ['answer (waiting session)', { session: 'asking', local: dirty }, 0, true],
  ['failing CI', { prs: { prs: [failing], stale: null } }, 1, true],
  ['failing CI beats a ready merge', { prs: { prs: [failing, { number: 5, title: 'm', ready: true, checks: { state: 'success' } }], stale: null } }, 1, true],
  ['merge', { prs: { prs: [{ number: 9, title: 'T', ready: true, checks: { state: 'success' } }], stale: null } }, 2, false],
  ['branch', { prs: { prs: [], stale: { branch: 'x' } } }, 3, false],
  ['manual', { local: { ...dirty, detached: true } }, 3, false],
  ['waiting', { local: dirty, state: waitingState }, 4, false],
  ['deliver', { local: dirty }, 5, false],
  ['start', { roadmap: roadmap(A, A[0]) }, 6, false],
  ['session working', { session: 'busy' }, 7, false],
  ['blocked unit', { roadmap: roadmap([unit('B', 'Bloqueada')]) }, 8, true],
  ['everything else', {}, 9, false],
];
for (const [name, over, rank, needs] of LEVELS) {
  test(`rank ${rank} / needs ${needs}: ${name}`, () => {
    const row = summarize(facts(over));
    assert.equal(row.rank, rank);
    assert.equal(row.needs, needs);
  });
}

test('an error row has needs false and rank 9, and the new fields come after the old ones', () => {
  const row = summarize(facts({ error: 'git exploded' }));
  assert.deepEqual([row.needs, row.rank], [false, 9]);
  assert.deepEqual(Object.keys(summarize(facts())).slice(-3), ['error', 'needs', 'rank']);
});

test('lib exports the one QUEUE_RANK the ranking reuses', () => {
  assert.deepEqual(require('../lib.js').QUEUE_RANK, { merge: 0, branch: 1, manual: 1, waiting: 2, deliver: 3, start: 4 });
});

test('rank reuses it: branch and manual tie, every other kind has its own level', () => {
  const kinds = Object.fromEntries(['merge', 'branch', 'manual', 'waiting', 'deliver', 'start'].map((k) => [k, LEVELS.find((l) => l[0] === k)[2]]));
  assert.deepEqual(kinds, { merge: 2, branch: 3, manual: 3, waiting: 4, deliver: 5, start: 6 });
});

// ---------- client fixtures ----------
const progress = (o = {}) => ({ total: 74, completada: 30, enRevision: 1, bloqueada: 0, pendiente: 43, enCurso: 0, ...o });
const NO_PROGRESS = { total: null, completada: null, enRevision: null, bloqueada: null, pendiente: null, enCurso: null };
const row = (o = {}) => ({
  id: 'r1', name: 'alpha', group: 'G1', room: null, branch: 'main', progress: progress(), session: { state: 'free' },
  next: { id: 'B2b', entrega: 'Validate the ownerId', resultadoVisible: 'Photos are rejected' }, blocking: [],
  lastMovement: { at: '2026-05-01T11:48:00Z', what: 'fix: thing' }, action: null, error: null, needs: false, rank: 9, ...o,
});
const payload = (rows) => ({ rows, counts: {}, attention: [], generatedAt: '2026-05-01T12:00:00Z' });
const view = (rows, ctx = {}) => R.summaryView(payload(rows), { now: NOW, scope: { kind: 'all' }, rooms: [], ...ctx });
const ids = (html) => [...html.matchAll(/<article class="rs-card[^"]*"[^>]* data-id="([^"]*)"/g)].map((m) => m[1]);

// ---------- cards: structure ----------
test('the Summary is a list of two-line cards, not a table, and has no KPI counters, attention box or "⋯" button', () => {
  const html = view([row()]);
  assert.match(html, /<article class="rs-card" data-id="r1"[^>]*>\s*<div class="rs-l1">[\s\S]*<\/div>\s*<div class="rs-l2">/);
  assert.doesNotMatch(html, /<table|<tr|rs-kpi|rs-attn|Needs your attention|rs-toolbar|⋯|More actions/);
  assert.match(html, /<b class="rs-name" title="alpha">alpha<\/b>/);
  assert.match(html, /class="mono rs-branch" title="main">main</);
  assert.match(html, /12 min ago/);
});

test('every session state shows an icon and a word, never colour alone', () => {
  const want = { working: /● working/, waiting: /◐ asking you/, free: /○ free/, none: /○ no session/, unknown: /\? unknown/ };
  for (const [state, re] of Object.entries(want)) assert.match(view([row({ session: { state } })]), re, state);
});

test('card variants: yellow left border when asking, red when blocked with no next unit, plain otherwise', () => {
  assert.match(view([row({ session: { state: 'waiting' } })]), /class="rs-card ask"/);
  assert.match(view([row({ next: null, blocking: [{ unit: 'T4', waitsFor: ['T3'], external: [] }] })]), /class="rs-card block"/);
  assert.match(view([row({ blocking: [{ unit: 'T4', waitsFor: ['T3'], external: [] }] })]), /class="rs-card" /);
  assert.match(view([row()]), /class="rs-card" /);
});

// ---------- cards: progress and next ----------
test('the bar has a short count; the full breakdown goes in the title and the aria-label of the bar', () => {
  const html = view([row({ progress: progress({ total: 74, completada: 30, enRevision: 1, bloqueada: 3, pendiente: 40 }) })]);
  assert.match(html, /30\/74/);
  assert.match(html, /title="30 of 74 completed · 1 in review · 3 blocked"/);
  assert.match(html, /role="img" aria-label="30 of 74 completed · 1 in review · 3 blocked"/);
  assert.match(view([row({ progress: progress({ total: 5, completada: 5, enRevision: 0, bloqueada: 0, pendiente: 0 }) })]), /title="5 of 5 completed"/);
});

test('bar widths never exceed 100 for awkward totals', () => {
  for (const total of [3, 7, 9, 13, 74, 1]) {
    const c = Math.floor(total / 3);
    const html = view([row({ progress: { total, completada: c, enRevision: 0, bloqueada: total > 2 ? 1 : 0, pendiente: total - c - (total > 2 ? 1 : 0), enCurso: 0 } })]);
    const sum = [...html.matchAll(/class="rs-seg [a-z-]+" style="width:(\d+(?:\.\d+)?)%"/g)].reduce((a, m) => a + Number(m[1]), 0);
    assert.ok(sum <= 100, `total ${total}: ${sum}`);
  }
});

test('null progress says "no data" without a bar or zeros; a repo with no units says so', () => {
  const html = view([row({ progress: NO_PROGRESS, next: null })]);
  assert.match(html, /no data/);
  assert.doesNotMatch(html, /rs-seg|0\/0|0\/null/);
  assert.match(view([row({ progress: progress({ total: 0, completada: 0, enRevision: 0, bloqueada: 0, pendiente: 0 }) })]), /no units/);
});

test('the next unit is one ellipsis line; the full entrega and the result go in the title', () => {
  const html = view([row()]);
  assert.match(html, /<div class="rs-next" title="B2b — Validate the ownerId\nResult: Photos are rejected"><span class="rs-sub">Next<\/span> · B2b — Validate the ownerId<\/div>/);
  for (const v of ['', '—', '-', ' – ', null]) assert.doesNotMatch(view([row({ next: { id: 'T5', entrega: 'Do five', resultadoVisible: v } })]), /Result:/, JSON.stringify(v));
});

test('no next unit and blocked: "Waiting · T004 → T003" from blocking; no next and not blocked: a dash', () => {
  const blocked = view([row({ next: null, blocking: [{ unit: 'T004', waitsFor: ['T003'], external: ['other repo'] }] })]);
  assert.match(blocked, /Waiting<\/span> · T004 → T003, other repo/);
  assert.match(view([row({ next: null, blocking: [{ unit: 'E3', waitsFor: [], external: [] }] })]), /Waiting<\/span> · E3 is blocked/);
  assert.match(view([row({ next: null })]), /rs-none/);
});

// ---------- cards: the one primary action ----------
test('merge, branch and start actions produce the exact data-act attributes', () => {
  assert.match(view([row({ action: { kind: 'merge', label: 'Merge #7 t', pr: 7 } })]), /<button[^>]*data-act="merge" data-id="r1" data-n="7"/);
  assert.match(view([row({ action: { kind: 'branch', label: 'x', pr: null } })]), /<button[^>]*data-act="pi" data-id="r1" data-cmd="flow-base"/);
  assert.match(view([row({ action: { kind: 'start', label: 'x', pr: null } })]), /<button[^>]*data-act="pi" data-id="r1" data-cmd="flow-next"[^>]*>\/flow-next</);
});

test('deliver uses the flow button the board would show; without local state it is disabled and sends nothing', () => {
  const action = { kind: 'deliver', label: 'Deliver', pr: null };
  assert.match(view([row({ action })], { flowFor: () => ({ cmd: 'flow-pr', label: '/flow-pr' }) }), /data-act="pi" data-id="r1" data-cmd="flow-pr"[^>]*>\/flow-pr</);
  assert.match(view([row({ action })], { flowFor: () => ({ cmd: 'flow-commit', label: '/flow-commit', disabled: true, reason: 'busy' }) }), /data-cmd="flow-commit"[^>]*disabled/);
  const unknown = view([row({ action })], { flowFor: () => null });
  assert.doesNotMatch(unknown, /data-act="pi"/);
  assert.match(unknown, /<button[^>]*disabled[^>]*>Deliver</);
});

test('answer, waiting and manual only offer a non-sending Open button; no action means no button', () => {
  for (const kind of ['answer', 'waiting', 'manual']) {
    const html = view([row({ action: { kind, label: 'L', pr: null } })]);
    assert.match(html, /<button class="primary" data-act="focus-repo" data-id="r1"[^>]*>Open</, kind);
    assert.doesNotMatch(html, /data-act="pi"|data-act="merge"/, kind);
  }
  assert.doesNotMatch(view([row()]).split('<article')[1], /<button/);
});

test('a repo with an order on its way (sending) or a merge in flight (busy) has its button disabled', () => {
  assert.match(view([row({ action: { kind: 'branch', label: 'x', pr: null } })], { sending: { r1: 'flow-base' } }), /data-act="pi"[^>]*disabled/);
  assert.match(view([row({ action: { kind: 'start', label: 'x', pr: null } })], { sending: { r1: 'flow-next' } }), /data-cmd="flow-next"[^>]*disabled>\/flow-next</);
  assert.match(view([row({ action: { kind: 'merge', label: 'm', pr: 3 } })], { busy: { 'r1:3': true } }), /data-act="merge"[^>]*disabled/);
});

test('an error row shows the error text, "no data", no zeros and an Open button', () => {
  const html = view([row({ id: 'e', name: 'broken', error: 'git exploded', progress: NO_PROGRESS, next: null, session: { state: 'unknown' } })]);
  assert.match(html, /git exploded/);
  assert.match(html, /no data/);
  assert.match(html, /data-act="focus-repo" data-id="e"[^>]*>Open</);
  assert.doesNotMatch(html, /rs-seg|\d+\/\d+|data-act="merge"|data-act="diff"/);
});

// ---------- change chips (S55) ----------
const CH = { files: 3, added: 120, deleted: 4, ahead: 1, behind: 2, noUpstream: true };

test('change chips: the diff button, unpushed (+ no upstream) and behind, and nothing when clean or not loaded', () => {
  const html = view([row()], { changesFor: () => CH });
  assert.match(html, /<button class="chip yellow chip-btn" data-act="diff" data-id="r1" title="View diff">● 3 files <span class="add">\+120<\/span> <span class="del">−4<\/span><\/button>/);
  assert.match(html, /<span class="chip blue">↑ 1 unpushed · no upstream<\/span>/);
  assert.match(html, /<span class="chip gray">↓ 2 behind<\/span>/);
  const single = view([row()], { changesFor: () => ({ files: 1, added: 1, deleted: 0, ahead: 2, behind: 0, noUpstream: false }) });
  assert.match(single, /● 1 file </);
  assert.match(single, /↑ 2 unpushed<\/span>/);
  assert.doesNotMatch(single, /behind|no upstream/);
  for (const c of [null, undefined, { files: 0, added: 0, deleted: 0, ahead: 0, behind: 0, noUpstream: false }]) assert.doesNotMatch(view([row()], { changesFor: () => c }), /chip-btn|unpushed|behind/);
  assert.doesNotMatch(view([row()]), /chip-btn/);
});

// ---------- order, filter, groups ----------
const MIX = [
  row({ id: 'a', name: 'idle-one', group: 'G1', rank: 9 }),
  row({ id: 'b', name: 'asking', group: 'G1', session: { state: 'waiting' }, needs: true, rank: 0 }),
  row({ id: 'c', name: 'ci', group: 'G2', needs: true, rank: 1 }),
  row({ id: 'd', name: 'blocked', group: 'G2', needs: true, rank: 8 }),
  row({ id: 'e', name: 'tie-two', group: 'G2', needs: true, rank: 1 }),
  row({ id: 'f', name: 'merge-one', group: 'G2', rank: 2 }),
];

test('the order is stable: payload order, never by state or rank', () => {
  assert.deepEqual(ids(view(MIX)), ['a', 'b', 'c', 'd', 'e', 'f']);
});

const tools = (rows, ctx = {}) => R.summaryTools(payload(rows), { now: NOW, scope: { kind: 'all' }, rooms: [], ...ctx });

test('the filter is ONE aria-pressed toggle with the count of the current scope (RP61: no All button)', () => {
  const html = tools(MIX);
  assert.doesNotMatch(html, /All|data-filter="all"/);
  assert.match(html, /<button type="button" data-act="sfilter" data-filter="attention" aria-pressed="false">Needs attention · 4<\/button>/);
  assert.match(html, /updated 0? ?just now/);
  const g1 = view(MIX, { scope: { kind: 'room', name: 'R' }, rooms: [{ name: 'R', repos: ['a', 'b'] }] });
  assert.equal(ids(g1).length, 0);
  const scoped = view(MIX.map((r) => (r.id === 'a' || r.id === 'b' ? { ...r, room: 'R' } : r)), { scope: { kind: 'room', name: 'R' }, rooms: [{ name: 'R', repos: ['a', 'b'] }] });
  assert.deepEqual(ids(scoped), ['a', 'b']);
  assert.match(tools(MIX.map((r) => (r.id === 'a' || r.id === 'b' ? { ...r, room: 'R' } : r)), { scope: { kind: 'room', name: 'R' }, rooms: [{ name: 'R', repos: ['a', 'b'] }] }), /Needs attention · 1</);
});

test('the "attention" filter shows only the rows that need it, by rank, ties in payload order, without headers or room cards', () => {
  const html = view(MIX, { filter: 'attention', roomData: { rooms: [{ name: 'R', repos: ['a'], presence: { state: 'idle' }, lastCommit: null }] }, rooms: [{ name: 'R', repos: ['a'] }] });
  assert.deepEqual(ids(html), ['b', 'c', 'e', 'd']);
  assert.match(tools(MIX, { filter: 'attention' }), /data-filter="all" aria-pressed="true"/);
  assert.doesNotMatch(html, /toggle-group|rs-room/);
  assert.match(view([row()], { filter: 'attention' }), /Nothing needs your attention/);
});

test('group headers appear only with more than one group; each is a toggle button with aria-expanded and the repo count', () => {
  const html = view(MIX);
  assert.match(html, /<button type="button" class="rs-group" data-act="toggle-group" data-group="G1" aria-expanded="true"><span aria-hidden="true">▾<\/span> G1 <span class="mono">2<\/span><\/button>/);
  assert.match(html, /data-group="G2" aria-expanded="true"[^>]*>[^<]*<span[^>]*>▾<\/span> G2 <span class="mono">4<\/span>/);
  assert.doesNotMatch(view([row(), row({ id: 'z', name: 'zz' })]), /toggle-group/);
});

test('a collapsed group hides its cards and keeps its header', () => {
  const html = view(MIX, { collapsed: { G2: true } });
  assert.deepEqual(ids(html), ['a', 'b']);
  assert.match(html, /data-group="G2" aria-expanded="false"[^>]*>[^<]*<span[^>]*>▸<\/span> G2 <span class="mono">4<\/span>/);
  assert.match(tools(MIX, { collapsed: { G2: true } }), /Needs attention · 4/, 'the counts ignore collapsing');
});

// ---------- scope ----------
test('scope filters the cards and the counts; the scope bar keeps its buttons and aria-pressed', () => {
  const rows = [row({ id: 'a', name: 'in-room', room: 'UPEN' }), row({ id: 'b', name: 'loose', room: null })];
  const upen = view(rows, { scope: { kind: 'room', name: 'UPEN' }, rooms: [{ name: 'UPEN', repos: ['a'] }] });
  assert.deepEqual(ids(upen), ['a']);
  assert.deepEqual(ids(view(rows, { scope: { kind: 'none' } })), ['b']);
  assert.deepEqual(R.filterRows(rows, { kind: 'none' }).map((r) => r.id), ['b']);
  assert.match(R.scopeBar([{ name: 'UPEN', repos: ['a'] }], 2, { kind: 'room', name: 'UPEN' }), /data-kind="room" data-name="UPEN"[^>]*aria-pressed="true"/);
  assert.deepEqual(R.normalizeScope({ kind: 'room', name: 'GONE' }, [{ name: 'UPEN' }]), { kind: 'all' });
});

// ---------- room card ----------
const ROOMS = { rooms: [
  { name: 'UPEN', repos: ['a', 'b', 'c'], presence: { state: 'idle' }, lastCommit: '2026-05-01T09:00:00Z' },
  { name: 'H2O', repos: ['d'], presence: { state: 'busy' }, lastCommit: null },
] };
const RROWS = [
  row({ id: 'a', name: 'ra', room: 'UPEN', progress: progress({ total: 10, completada: 4 }), needs: true, rank: 1 }),
  row({ id: 'b', name: 'rb', room: 'UPEN', progress: progress({ total: 5, completada: 2 }) }),
  row({ id: 'c', name: 'rc', room: 'UPEN', progress: NO_PROGRESS, error: 'boom', next: null }),
  row({ id: 'd', name: 'rd', room: 'H2O', progress: progress({ total: 2, completada: 1 }) }),
  row({ id: 'e', name: 're', room: null }),
];
const roomCtx = { roomData: ROOMS, rooms: [{ name: 'UPEN', repos: ['a', 'b', 'c'] }, { name: 'H2O', repos: ['d'] }] };

test('room cards come first, in config order, with name, room chip, session chip, aggregate bar, counts and last commit; no button', () => {
  const html = view(RROWS, roomCtx);
  const first = html.indexOf('rs-room');
  assert.ok(first > -1 && first < html.indexOf('data-id="a"'));
  assert.ok(html.indexOf('★ UPEN') < html.indexOf('★ H2O'));
  const card = html.slice(html.indexOf('★ UPEN') - 80, html.indexOf('★ H2O'));
  assert.match(card, /<span class="chip purple">room<\/span>/);
  assert.match(card, /○ free/);
  assert.match(card, /6\/15/);
  assert.match(card, /3 projects · 1 need attention/);
  assert.match(card, /3 h ago/);
  assert.doesNotMatch(card, /<button/);
  const h2o = html.slice(html.indexOf('★ H2O'), html.indexOf('data-id="a"') > html.indexOf('★ H2O') ? undefined : html.indexOf('data-id="a"'));
  assert.match(h2o, /● working/);
  assert.match(h2o, /1 project · 0 need attention/);
});

test('room session chip: idle free, busy working, closed no session, anything else unknown', () => {
  const of = (state) => view(RROWS, { ...roomCtx, roomData: { rooms: [{ name: 'UPEN', repos: [], presence: { state }, lastCommit: null }] }, scope: { kind: 'room', name: 'UPEN' } });
  assert.match(of('idle'), /rs-room[\s\S]*○ free/);
  assert.match(of('busy'), /rs-room[\s\S]*● working/);
  assert.match(of('closed'), /rs-room[\s\S]*○ no session/);
  assert.match(of('weird'), /rs-room[\s\S]*\? unknown/);
});

test('room cards: every room in All, only its own in a room scope, none in No room, none without room data', () => {
  const count = (html) => (html.match(/class="rs-card rs-room"/g) || []).length;
  assert.equal(count(view(RROWS, roomCtx)), 2);
  const one = view(RROWS, { ...roomCtx, scope: { kind: 'room', name: 'H2O' } });
  assert.equal(count(one), 1);
  assert.match(one, /★ H2O/);
  assert.equal(count(view(RROWS, { ...roomCtx, scope: { kind: 'none' } })), 0);
  assert.equal(count(view(RROWS, { rooms: roomCtx.rooms })), 0);
  assert.equal(count(view(RROWS, { ...roomCtx, roomData: null })), 0);
});

// ---------- states ----------
test('a failed refresh keeps the cards and adds the note; empty and missing payloads say so', () => {
  const html = view([row()], { failed: true });
  assert.match(html, /⚠ Summary unavailable: showing the last data we have\./);
  assert.match(html, /alpha/);
  assert.match(view([]), /No repositories in this scope/);
  assert.match(R.summaryView(null, { now: NOW }), /Loading summary/);
  assert.match(R.summaryView(null, { now: NOW, failed: true }), /Summary unavailable/);
});

test('the one-line bar legend stays at the bottom', () => {
  const html = view([row()]);
  for (const t of ['Completed', 'In review', 'Blocked', 'Pending']) assert.ok(html.includes(t), t);
  assert.ok(html.lastIndexOf('rs-legend') > html.lastIndexOf('rs-card'));
});

// ---------- escaping ----------
test('every text that comes from data is HTML-escaped, in every field and every view', () => {
  const r = row({
    id: 'id"x', name: BAD, group: BAD, room: BAD, branch: BAD, session: { state: 'waiting' }, needs: true, rank: 0,
    next: { id: BAD, entrega: BAD, resultadoVisible: BAD },
    lastMovement: { at: '2026-05-01T11:00:00Z', what: BAD }, action: { kind: 'manual', label: BAD, pr: null },
  });
  const w = row({ id: 'w"y', name: 'w', group: BAD, room: BAD, next: null, blocking: [{ unit: BAD, waitsFor: [BAD], external: [BAD] }], action: { kind: 'merge', label: BAD, pr: BAD }, needs: true });
  const e = row({ id: 'e1', name: 'broken', group: 'other', error: BAD, progress: NO_PROGRESS, next: null });
  const ctx = {
    rooms: [{ name: BAD, repos: ['id"x'] }], roomData: { rooms: [{ name: BAD, repos: ['id"x'], presence: { state: BAD }, lastCommit: BAD }] },
    changesFor: () => ({ files: BAD, added: BAD, deleted: BAD, ahead: BAD, behind: BAD, noUpstream: true }),
    flowFor: () => ({ cmd: BAD, label: BAD, reason: BAD }),
  };
  for (const filter of ['all', 'attention']) {
    for (const collapsed of [{}, { [BAD]: true }]) {
      const html = view([r, w, e], { ...ctx, filter, collapsed });
      assert.doesNotMatch(html, /<img/, filter);
      assert.doesNotMatch(html, /"id"x"|"w"y"/);
      assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
    }
  }
  assert.doesNotMatch(view([{ ...r, action: { kind: 'deliver', label: BAD, pr: null } }], ctx), /<img/);
  assert.doesNotMatch(R.scopeBar([{ name: BAD, repos: [] }], 3, { kind: 'room', name: BAD }), /<img/);
});

// ---------- page wiring ----------
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

function loadPage({ doc = {} } = {}) {
  const els = {};
  const frames = [];
  const get = (sel) => (els[sel] ||= (sel === 'meta[name=token]' ? { ...element(), content: 'token' } : element()));
  const ctx = vm.createContext({
    console,
    document: { hidden: false, querySelector: get, querySelectorAll: () => [], addEventListener() {}, createElement: () => element(), body: element(), ...doc },
    localStorage: { getItem: () => null, setItem() {} }, location: { hash: '' },
    requestAnimationFrame: (cb) => { frames.push(cb); return frames.length; },
    setInterval: () => 0, setTimeout: () => 0, confirm: () => true, fetch: () => new Promise(() => {}),
  });
  ctx.window = ctx;
  ctx.addEventListener = () => {};
  ctx.RepoPanelView = require('../public/view.js');
  ctx.RepoPanelResumen = R;
  vm.runInContext(fs.readFileSync(path.join(PUBLIC, 'app.js'), 'utf8'), ctx);
  return { ctx, get, frames, run: (code) => vm.runInContext(code, ctx), flush: () => { while (frames.length) frames.shift()(); } };
}

const withRepos = (page) => {
  const S = page.run('S');
  S.groups = [{ name: 'G', repos: [{ id: 'abc', name: 'demo', path: 'p' }] }];
  S.local.abc = { branch: 'feat', detached: false, upstream: null, noUpstream: true, ahead: 2, behind: 1, files: [{ path: 'a', status: 'M' }, { path: 'b', status: 'M' }], added: 10, deleted: 3, head: 'h', inProgress: null, base: 'main', stagedCount: 0 };
  S.prs.abc = { prs: [], stale: null, repo: { url: 'https://github.com/o/demo' } };
  return S;
};

test('the page feeds the cards: change chips from the local state, nothing while it is not loaded', () => {
  const page = loadPage();
  const S = withRepos(page);
  S.summary = payload([row({ id: 'abc', name: 'demo' })]);
  page.run('render()');
  const html = page.get('#summary').html;
  assert.match(html, /data-act="diff" data-id="abc" title="View diff">● 2 files <span class="add">\+10<\/span> <span class="del">−3<\/span>/);
  assert.match(html, /↑ 2 unpushed · no upstream/);
  assert.match(html, /↓ 1 behind/);
  delete S.local.abc;
  page.run('render()');
  assert.doesNotMatch(page.get('#summary').html, /chip-btn|unpushed/);
  S.local.abc = { error: 'boom' };
  page.run('render()');
  assert.doesNotMatch(page.get('#summary').html, /chip-btn|unpushed/);
});

test('the page feeds the room card from the room data, and none while it has not loaded', () => {
  const page = loadPage();
  const S = withRepos(page);
  S.rooms = [{ name: 'UPEN', repos: ['abc'] }];
  S.summary = payload([row({ id: 'abc', name: 'demo', room: 'UPEN' })]);
  page.run('render()');
  assert.doesNotMatch(page.get('#summary').html, /rs-room/);
  S.roomData = { state: 'loaded', data: { rooms: [{ name: 'UPEN', repos: ['abc'], presence: { state: 'idle' }, lastCommit: null }] } };
  page.run('render()');
  assert.match(page.get('#summary').html, /★ UPEN/);
});

test('the filter and group buttons update the state, redraw once and do not loop', () => {
  const page = loadPage();
  const S = withRepos(page);
  S.summary = payload([row({ id: 'abc', name: 'demo', needs: true, rank: 1, group: 'G1' }), row({ id: 'z', name: 'zed', group: 'G2' })]);
  page.run('render()');
  assert.equal(S.sfilter, 'all');
  assert.match(page.get('#summary').html, /data-id="z"/);
  page.run("ACTIONS.sfilter({ dataset: { filter: 'attention' } })");
  assert.equal(page.frames.length, 1, 'one redraw requested');
  page.flush();
  assert.equal(page.frames.length, 0);
  assert.doesNotMatch(page.get('#summary').html, /data-id="z"/);
  assert.match(page.get('#summary').html, /data-id="abc"/);
  const writes = page.get('#summary').writes;
  page.run('render()');
  assert.equal(page.get('#summary').writes, writes, 'an identical redraw writes nothing');
  page.run("ACTIONS.sfilter({ dataset: { filter: 'bogus' } })");
  page.flush();
  assert.equal(S.sfilter, 'all', 'an unknown filter falls back to all');
  page.run("ACTIONS['toggle-group']({ dataset: { group: 'G2' } })");
  page.flush();
  assert.doesNotMatch(page.get('#summary').html, /data-id="z"/);
  assert.match(page.get('#summary').html, /data-group="G2" aria-expanded="false"/);
  page.run("ACTIONS['toggle-group']({ dataset: { group: 'G2' } })");
  page.flush();
  assert.match(page.get('#summary').html, /data-id="z"/);
});

test('the filter and the collapsed groups are kept in memory only, never persisted', () => {
  const src = fs.readFileSync(path.join(PUBLIC, 'app.js'), 'utf8');
  assert.doesNotMatch(src, /setPref\('(sfilter|collapsed)/);
  assert.match(src, /sfilter: 'all', collapsed: \{\}/);
});

test('the page keeps the keyboard focus on a group button (inside #summary) after the redraw', () => {
  const on = { dataset: { act: 'toggle-group', group: 'G1' }, focused: 0, focus() { this.focused++; } };
  const off = { dataset: { act: 'toggle-group', group: 'G2' }, focused: 0, focus() { this.focused++; } };
  const page = loadPage({ doc: { activeElement: on } });
  const S = withRepos(page);
  page.get('#summary').querySelectorAll = () => [off, on];
  S.summary = payload([row({ id: 'abc', name: 'demo' })]);
  page.run('render()');
  assert.equal(on.focused, 1);
  assert.equal(off.focused, 0);
});

test('the page tolerates stubs without dataset, querySelectorAll or activeElement', () => {
  const page = loadPage({ doc: { activeElement: {} } });
  const S = withRepos(page);
  S.summary = payload([row({ id: 'abc', name: 'demo' })]);
  page.get('#summary').querySelectorAll = undefined;
  assert.doesNotThrow(() => page.run('render()'));
});

// ---------- style and contract ----------
test('style: compact card rules, a container query below 520px, no table/KPI rules, focus and reduced motion kept', () => {
  const css = fs.readFileSync(path.join(PUBLIC, 'style.css'), 'utf8');
  assert.match(css, /\.rs-panel\s*\{[^}]*container-type:\s*inline-size/);
  assert.match(css, /@container \(max-width:\s*520px\)/);
  assert.match(css, /\.rs-card\.ask\s*\{[^}]*border-left:[^}]*var\(--yellow\)/);
  assert.match(css, /\.rs-card\.block\s*\{[^}]*border-left:[^}]*var\(--red\)/);
  assert.match(css, /\.rs-card[^{]*:focus-visible|\.rs-panel :focus-visible/);
  assert.doesNotMatch(css, /\.rs-table|\.rs-kpi|\.rs-attn|\.rs-toolbar/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
});

test('API_VERSION is still 15 and the page asks for no new route', () => {
  assert.equal(require('../public/view.js').API_VERSION, 15);
  const src = fs.readFileSync(path.join(PUBLIC, 'app.js'), 'utf8');
  assert.deepEqual([...src.matchAll(/api\('\/api\/summary[^']*'\)/g)].length, 1);
});
