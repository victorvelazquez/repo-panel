'use strict';
// RP63 (S60, S77): the Tasks tab of the right panel, pure part. R.tasksView renders the rows of a repo's ROADMAP (the answer of
// GET /api/roadmap, no new API) grouped by state with the completed ones folded; R.chatHead gains the Chat/Tasks tablist; the
// progress bar of a card opens the tab. No network, no timers, no real clock.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const R = require('../public/resumen.js');

const PUBLIC = path.join(__dirname, '..', 'public');
const read = (f) => fs.readFileSync(path.join(PUBLIC, f), 'utf8').replace(/\r\n/g, '\n');
const FORBIDDEN = /\b[Pp]i (?:sessions?|prompt|screens?|terminals?|orders?)\b|\b(?:to|in|of|with) pi\b|\bpi\b|Gentle Shell/;

const row = (id, estado, over = {}) => ({ id, entrega: `Delivery of ${id}`, resultadoVisible: `See ${id}`, dependsOn: [], estado, notas: '', line: 1, ...over });
const ROWS = [
  row('A1', 'Completada'), row('A2', 'Completada'),
  row('B1', 'En curso'),
  row('C1', 'Pendiente', { dependsOn: ['B1'] }), row('C2', 'Pendiente'), row('C3', 'Pendiente', { dependsOn: ['A1', 'C2'] }),
  row('D1', 'Bloqueada', { notas: 'waits for a decision' }),
  row('E1', 'Pendiente'), row('F1', 'Pendiente'),
];
const DERIVED = { E1: { state: 'En revisión', via: 'pr', pr: 12 }, F1: { state: 'Lista', via: 'branch', branch: 'feat/f1' } };
const rp = (over = {}) => ({ available: true, reason: undefined, rows: ROWS, derived: DERIVED, next: ROWS.find((r) => r.id === 'C2'), ...over });
const view = (p = rp(), ctx = {}) => R.tasksView(p, { filter: '', openDone: false, loading: false, failed: false, ...ctx });
const headings = (html) => Array.from(html.matchAll(/class="task-group[^"]*"[^>]*>\s*<[^>]*>([^<]+)/g)).map((m) => m[1].trim());
const deepFreeze = (o) => { if (o && typeof o === 'object') { Object.values(o).forEach(deepFreeze); Object.freeze(o); } return o; };

// ---------- tasksView: states of the panel ----------
test('tasksView: no answer yet and loading says "Loading tasks…" and nothing else', () => {
  const h = view(null, { loading: true });
  assert.match(h, /Loading tasks…/);
  assert.ok(!/task-group/.test(h));
});

test('tasksView: a failed request with no answer says so, never throws', () => {
  assert.match(view(null, { failed: true }), /Roadmap unavailable/);
  assert.match(R.tasksView(undefined, { failed: true }), /Roadmap unavailable/);
});

test('tasksView: missing ROADMAP names the file; any other reason is "Roadmap unavailable"', () => {
  assert.match(view({ available: false, reason: 'missing' }), /No docs\/ROADMAP\.md in this repo/);
  for (const reason of ['error', 'no-base', 'no-repo', undefined]) assert.match(view({ available: false, reason }), /Roadmap unavailable/, String(reason));
});

test('tasksView: an empty table says there are no tasks', () => {
  assert.match(view(rp({ rows: [], derived: {}, next: null })), /No tasks in the roadmap/);
});

// ---------- tasksView: groups ----------
test('tasksView: groups come in the fixed order with their counts, empty groups omitted', () => {
  assert.deepEqual(headings(view(rp(), { openDone: true })), ['In review (1)', 'Ready (1)', 'In progress (1)', 'Next (1)', 'Pending (2)', 'Blocked (1)', 'Completed (2)']);
  const only = rp({ rows: [row('Z1', 'Completada')], derived: {}, next: null });
  assert.deepEqual(headings(view(only)), ['Completed (1)']);
});

test('tasksView: a row goes to exactly one group (derived state wins over the file state, next is taken out of pending)', () => {
  const h = view(rp(), { openDone: true });
  for (const r of ROWS) assert.equal(h.split(`>${r.id}<`).length - 1, 1, `${r.id} appears once`);
  const grp = (title) => { const i = h.indexOf(title); return h.slice(i, h.indexOf('task-group', i + 10) > 0 ? h.indexOf('task-group', i + 10) : undefined); };
  assert.ok(grp('In review (1)').includes('>E1<'));
  assert.ok(grp('Ready (1)').includes('>F1<'));
  assert.ok(grp('In progress (1)').includes('>B1<'));
  assert.ok(grp('Next (1)').includes('>C2<'));
  assert.ok(!grp('Pending (2)').includes('>C2<'));
});

test('tasksView: an En curso row that also has a derived state (a PR) shows once, in the derived group', () => {
  const p = rp({ rows: [row('G1', 'En curso')], derived: { G1: { state: 'En revisión', via: 'pr', pr: 3 } }, next: null });
  const h = view(p);
  assert.deepEqual(headings(h), ['In review (1)']);
  assert.equal(h.split('>G1<').length - 1, 1);
});

test('tasksView: the next row is highlighted (class task-next and aria-current) and nothing else is', () => {
  const h = view();
  assert.equal((h.match(/task-next/g) || []).length, 1);
  assert.equal((h.match(/aria-current="true"/g) || []).length, 1);
  const i = h.indexOf('task-next');
  assert.ok(h.slice(i, i + 400).includes('>C2<'));
  assert.ok(!/task-next/.test(view(rp({ next: null }))));
});

test('tasksView: a review row shows its PR, a ready row its branch, a pending row what it waits for, a blocked row its notes', () => {
  const h = view();
  assert.match(h, /PR #12/);
  assert.match(h, /feat\/f1/);
  assert.match(h, /waiting: B1/);
  assert.match(h, /waiting: C2/);
  assert.ok(!/waiting: A1/.test(h), 'a completed dependency does not make it wait');
  assert.match(h, /waits for a decision/);
});

test('tasksView: an external dependency (not a row of the table) never makes a row wait', () => {
  const p = rp({ rows: [row('H1', 'Pendiente', { dependsOn: ['OTHER-X1'] })], derived: {}, next: null });
  assert.ok(!/waiting/.test(view(p)));
});

// ---------- tasksView: completed folded ----------
test('tasksView: Completed is folded by default: only its heading button with the count, no rows', () => {
  const h = view();
  assert.match(h, /<button[^>]*data-act="tasks-done"[^>]*aria-expanded="false"[^>]*>[^<]*Completed \(2\)/);
  assert.ok(!h.includes('>A1<') && !h.includes('>A2<'));
});

test('tasksView: openDone shows the completed rows and aria-expanded true', () => {
  const h = view(rp(), { openDone: true });
  assert.match(h, /data-act="tasks-done"[^>]*aria-expanded="true"/);
  assert.ok(h.includes('>A1<') && h.includes('>A2<'));
  assert.match(h, /Delivery of A1/);
});

// ---------- tasksView: filter ----------
test('tasksView: the filter is a case-insensitive substring over id and entrega; counts follow the filtered rows', () => {
  const byId = view(rp(), { filter: 'c1' });
  assert.deepEqual(headings(byId), ['Pending (1)']);
  assert.ok(byId.includes('>C1<') && !byId.includes('>C2<'));
  const byText = view(rp(), { filter: 'DELIVERY OF B1' });
  assert.deepEqual(headings(byText), ['In progress (1)']);
  assert.equal(view(rp(), { filter: '  ' }).includes('>E1<'), true, 'a blank filter filters nothing');
});

test('tasksView: a filter that matches a completed row opens the group so the person sees it', () => {
  const h = view(rp(), { filter: 'A2' });
  assert.deepEqual(headings(h), ['Completed (1)']);
  assert.ok(h.includes('>A2<'));
});

test('tasksView: nothing matches says "No task matches"', () => {
  const h = view(rp(), { filter: 'zzz-nothing' });
  assert.match(h, /No task matches/);
  assert.ok(!/task-group/.test(h));
});

test('tasksView: the filter is text, never markup or a regex (a regex metacharacter and a tag are inert)', () => {
  for (const f of ['.*', '(', '[', '<b>', '\\']) {
    const h = view(rp(), { filter: f });
    assert.match(h, /No task matches/, f);
    assert.ok(!h.includes('<b>'), f);
  }
});

// ---------- tasksView: hostile and missing fields, bounds ----------
test('tasksView: hostile text in entrega, notes, branch and ids comes out escaped', () => {
  const evil = '<img src=x onerror=alert(1)>';
  const p = rp({
    rows: [row('X1', 'Pendiente', { entrega: evil }), row('X2', 'Bloqueada', { notas: evil }), row('X3', 'Pendiente')],
    derived: { X3: { state: 'Lista', via: 'branch', branch: evil } },
    next: null,
  });
  const h = view(p);
  assert.ok(!h.includes('<img'), h);
  assert.match(h, /&lt;img/);
});

test('tasksView: rows with missing fields never print undefined or NaN', () => {
  const p = rp({ rows: [{ id: 'M1', estado: 'Pendiente' }, { id: 'M2', estado: 'Bloqueada' }, { id: 'M3', estado: 'Completada' }], derived: { M1: { state: 'En revisión' } }, next: null });
  const h = view(p, { openDone: true });
  assert.ok(!/undefined|NaN|null/.test(h), h);
  assert.ok(h.includes('>M1<') && h.includes('>M2<') && h.includes('>M3<'));
});

test('tasksView: a row without id or with an unknown state is left out instead of breaking the list', () => {
  const p = rp({ rows: [{ estado: 'Pendiente' }, row('U1', 'Whatever'), row('U2', 'Pendiente')], derived: {}, next: null });
  const h = view(p);
  assert.ok(h.includes('>U2<') && !h.includes('>U1<'));
});

test('tasksView: bounded to 200 rows with a "+N more" line', () => {
  const rows = Array.from({ length: 230 }, (_, i) => row(`T${i + 1}`, 'Pendiente'));
  const h = view(rp({ rows, derived: {}, next: null }));
  assert.equal((h.match(/class="task-row/g) || []).length, 200);
  assert.match(h, /\+30 more/);
  assert.match(h, /Pending \(230\)/);
});

test('tasksView: does not mutate its input and gives the same output twice', () => {
  const p = deepFreeze(JSON.parse(JSON.stringify(rp())));
  assert.equal(view(p), view(p));
});

test('tasksView: no word the person must not read', () => {
  assert.ok(!FORBIDDEN.test(view(rp(), { openDone: true }).replace(/<[^>]*>/g, ' ')));
  assert.ok(!FORBIDDEN.test(view(null, { failed: true })));
});

// ---------- chatHead: the tablist ----------
const HEAD_CTX = { name: 'demo' };
test('chatHead: two tabs Chat and Tasks, Chat selected by default, with the roles and acts', () => {
  const h = R.chatHead({ id: 'abc' }, HEAD_CTX);
  assert.match(h, /role="tablist"/);
  assert.match(h, /<button[^>]*role="tab"[^>]*data-act="chat-tab"[^>]*data-tab="chat"[^>]*aria-selected="true"[^>]*>Chat</);
  assert.match(h, /<button[^>]*role="tab"[^>]*data-act="chat-tab"[^>]*data-tab="tasks"[^>]*aria-selected="false"[^>]*>Tasks</);
});

test('chatHead: c.tab "tasks" flips the selection', () => {
  const h = R.chatHead({ id: 'abc', tab: 'tasks' }, HEAD_CTX);
  assert.match(h, /data-tab="chat"[^>]*aria-selected="false"/);
  assert.match(h, /data-tab="tasks"[^>]*aria-selected="true"/);
  assert.match(R.chatHead({ id: 'abc', tab: 'nonsense' }, HEAD_CTX), /data-tab="chat"[^>]*aria-selected="true"/, 'an unknown tab is the chat');
});

test('chatHead: keeps the name, its tooltip and the close button exactly as before', () => {
  const h = R.chatHead({ id: 'abc', info: { adopted: { id: 's1' } } }, HEAD_CTX);
  assert.match(h, /<b class="ch-name" title="demo · s1">demo<\/b>/);
  assert.match(h, /<button type="button" class="x" data-act="chat-close" aria-label="Close the chat" title="Close the chat \(Esc\)">✕<\/button>/);
});

// ---------- the progress bar of the card ----------
const CARD = { id: 'abc', name: 'demo', group: 'G', branch: 'main', progress: { total: 4, completada: 1, enRevision: 0, bloqueada: 0, pendiente: 3, enCurso: 0 }, session: { state: 'free' }, next: null, action: null, needs: false, rank: 0 };
const NOW = Date.UTC(2026, 9, 31, 12, 0, 0);
const cards = (over = {}, ctx = {}) => R.summaryView({ rows: [{ ...CARD, ...over }] }, { now: NOW, scope: { kind: 'all' }, rooms: [], ...ctx });
test('the progress bar of a repo card opens the tasks (data-act, id, button role, focusable, title)', () => {
  const h = cards();
  assert.match(h, /<div class="rs-prog"[^>]*data-act="tasks-open"[^>]*data-id="abc"/);
  assert.match(h, /<div class="rs-prog"[^>]*role="button"[^>]*tabindex="0"/);
  assert.match(h, /title="1 of 4 completed[^"]*Click to see the tasks"/);
  assert.match(h, /aria-label="1 of 4 completed"/, 'the inner bar keeps its own label');
});

test('a card with no progress data or no units keeps no tasks attribute', () => {
  for (const progress of [null, { total: null }, { total: 0 }]) assert.ok(!/tasks-open/.test(cards({ progress })), JSON.stringify(progress));
});

test('the bar of a room card (a sum of repos) does not open tasks: only a repo has a roadmap', () => {
  const rows = [{ ...CARD, room: 'UPEN' }, { ...CARD, id: 'xyz', name: 'other', room: 'UPEN' }];
  const roomData = { rooms: [{ name: 'UPEN', repos: ['abc', 'xyz'] }] };
  const h = R.summaryView({ rows }, { now: NOW, scope: { kind: 'all' }, rooms: roomData.rooms, roomData });
  assert.ok(/class="rs-room|room-card|rs-card room/.test(h) || h.split('rs-prog').length - 1 === 3, 'precondition: the room card is drawn too');
  assert.equal((h.match(/tasks-open/g) || []).length, 2, 'only the two repo cards');
});

test('the bar markup (segments) is the same as before for a sample, and has no count (RP94)', () => {
  const h = cards({ progress: { total: 4, completada: 2, enRevision: 1, bloqueada: 1, pendiente: 0, enCurso: 0 } });
  assert.ok(h.includes('<i class="rs-seg rs-done" style="width:50%"></i><i class="rs-seg rs-pr" style="width:25%"></i><i class="rs-seg rs-blk" style="width:25%"></i><i class="rs-seg rs-pend" style="width:0%"></i>'), h);
  assert.ok(!h.includes('rs-count'), h);
});

// ---------- the static page ----------
test('style.css has the classes of the tasks view and index.html needs no new element (the body is #chatBody)', () => {
  const css = read('style.css');
  for (const c of ['.task-group', '.task-row', '.task-next']) assert.ok(css.includes(c), c);
  assert.match(read('index.html'), /id="chatBody"/);
});

test('tasksView: the notes of a blocked row are cut to 140 characters', () => {
  const p = rp({ rows: [row('N1', 'Bloqueada', { notas: 'x'.repeat(300) })], derived: {}, next: null });
  const h = view(p);
  assert.ok(h.includes('x'.repeat(140)));
  assert.ok(!h.includes('x'.repeat(141)));
});

// Found in a real browser: the page marks the view tabs (Summary / Work) by selecting every [role=tab][data-tab]; the Chat / Tasks tabs of the
// right panel share those attributes and were set to aria-selected="false" at every redraw. The view tabs are looked up inside .rs-tabs only.
test('app.js marks the view tabs inside .rs-tabs only, so the Chat / Tasks tabs keep their own aria-selected', () => {
  const app = read('app.js');
  assert.ok(app.includes("querySelectorAll('.rs-tabs [role=tab][data-tab]')"));
  assert.ok(!app.includes("querySelectorAll('[role=tab][data-tab]')"));
  assert.match(read('index.html'), /<nav class="rs-tabs"[^>]*role="tablist"/);
});
