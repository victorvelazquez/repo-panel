'use strict';
// RP220 (step 1 of the members board): the right column of a ROOM has a first tab, Members: one block per member, a line between blocks, with what the page already knows (the state of
// the session, how long ago it moved, its PR and its CI). A room hides the Tasks tab (it carries no roadmap) and opens on Members. A repo that is not a room keeps its tabs exactly as before.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const R = require('../public/resumen.js');
const V = require('../public/view.js');

const PUBLIC = path.join(__dirname, '..', 'public');
const read = (f) => fs.readFileSync(path.join(PUBLIC, f), 'utf8').replace(/\r\n/g, '\n');
const NOW = Date.parse('2026-11-17T12:00:00Z');
const tabs = (html) => [...html.matchAll(/class="col-tab" id="coltab-(\w+)"/g)].map((m) => m[1]);
const selected = (html) => [...html.matchAll(/id="coltab-(\w+)" data-act="col-tab" data-tab="\w+" aria-selected="true"/g)].map((m) => m[1]);
const blocks = (html) => html.split('class="mb-row"').length - 1;

const member = (o = {}) => ({ id: 'a1', name: 'upen-erp', known: true, state: 'free', at: '2026-11-17T11:00:00Z', what: 'docs: plan', prs: null, live: undefined, ...o });
const PR = [{ number: 12, title: 'feat: x', head: 'x', base: 'main', ready: true, checks: { state: 'success', total: 3, passed: 3, failed: 0, pending: 0, items: [] } }];

// ---------- the pure pieces of view.js ----------
test('roomOfFolder: the room whose folder id is the open chat, else null; garbage gives null', () => {
  const rooms = [{ name: 'U', id: 'r9', repos: [] }, { name: 'T', id: null }, null, 'x'];
  assert.equal(V.roomOfFolder(rooms, 'r9').name, 'U');
  for (const bad of [[undefined, 'r9'], [rooms, 'zz'], [rooms, ''], [rooms, null], [rooms, 5], [[], 'r9'], ['no list', 'r9']]) assert.equal(V.roomOfFolder(...bad), null, JSON.stringify(bad));
  assert.equal(V.roomOfFolder([{ name: 'T', id: null }], null), null);
});

test('roomMembers: one entry per member id, in the order of the room, with what the page already has', () => {
  const room = { name: 'U', id: 'r9', repos: ['a1', 'zz', 'b2'] };
  const rows = [
    { id: 'b2', name: 'upen-web', session: { state: 'working' }, lastMovement: { at: '2026-11-17T10:00:00Z', what: 'fix: y' } },
    { id: 'a1', name: 'upen-erp', session: { state: 'free' }, lastMovement: { at: '2026-11-17T11:00:00Z', what: 'docs: plan' } },
  ];
  const out = V.roomMembers(room, { repos: [{ id: 'a1', name: 'upen-erp' }, { id: 'b2', name: 'upen-web' }], rows, prsFor: (id) => (id === 'a1' ? PR : null), liveFor: (id) => (id === 'b2' ? { state: 'busy' } : undefined) });
  assert.deepEqual(out.map((m) => [m.id, m.name, m.known, m.state]), [['a1', 'upen-erp', true, 'free'], ['zz', 'zz', false, undefined], ['b2', 'upen-web', true, 'working']]);
  assert.deepEqual(out[0].prs, PR);
  assert.equal(out[0].at, '2026-11-17T11:00:00Z');
  assert.equal(out[0].what, 'docs: plan');
  assert.deepEqual(out[2].live, { state: 'busy' });
  assert.equal(out[1].prs, null);
});

test('roomMembers: total: a room without a list, no rows and getters that throw give an empty list or empty facts', () => {
  assert.deepEqual(V.roomMembers(null, {}), []);
  assert.deepEqual(V.roomMembers({ repos: 'x' }, {}), []);
  const out = V.roomMembers({ repos: ['a1'] }, { repos: [{ id: 'a1', name: 'n' }], rows: null, prsFor: () => { throw new Error('x'); }, liveFor: () => { throw new Error('y'); } });
  assert.deepEqual(out.map((m) => [m.id, m.name, m.known, m.state, m.at, m.prs, m.live]), [['a1', 'n', true, undefined, null, null, undefined]]);
});

test('columnTabOf: which tab of the column is open: a room defaults to Members and keeps the one it chose; a repo that is not a room is as it always was', () => {
  const room = { room: true };
  const phone = { room: true, phone: true };
  assert.equal(V.columnTabOf(undefined, room), 'members');
  assert.equal(V.columnTabOf('', room), 'members');
  assert.equal(V.columnTabOf('members', room), 'members');
  for (const t of ['status', 'files', 'changes']) assert.equal(V.columnTabOf(t, room), t, t);
  assert.equal(V.columnTabOf('tasks', room), 'changes');
  assert.equal(V.columnTabOf('notes', room), 'changes');
  assert.equal(V.columnTabOf('notes', phone), 'notes');
  // not a room: the same answers as before RP220
  for (const t of ['tasks', 'status', 'files']) assert.equal(V.columnTabOf(t, {}), t, t);
  for (const t of [undefined, '', 'members', 'zzz', 'changes', 'notes']) assert.equal(V.columnTabOf(t, {}), 'changes', String(t));
  assert.equal(V.columnTabOf('notes', { phone: true }), 'notes');
  assert.equal(V.columnTabOf('members', { phone: true }), 'changes');
  for (const bad of [undefined, null, 5, 'x']) assert.equal(V.columnTabOf('tasks', bad), 'tasks', String(bad));
});

// ---------- membersView ----------
test('membersView: one separate block per member, each with its name, the state of its session, how long ago and its PR', () => {
  const html = R.membersView({ now: NOW, members: [member({ prs: PR }), member({ id: 'b2', name: 'upen-web', state: 'working' })] });
  assert.equal(blocks(html), 2);
  assert.match(html, /upen-erp/);
  assert.match(html, /upen-web/);
  assert.match(html, /ss-working/);
  assert.match(html, /1 h ago/);
  assert.match(html, /#12/);
  assert.match(html, /no open PR/);
});

test('membersView: the live state of the session wins over the one the summary row had, like the card of the list', () => {
  const html = R.membersView({ now: NOW, members: [member({ state: 'free', live: { state: 'busy' } })] });
  assert.match(html, /ss-working/);
  assert.doesNotMatch(html, /ss-free/);
});

test('membersView: a member that is not in the panel says so and draws no state; names and subjects are escaped', () => {
  const html = R.membersView({ now: NOW, members: [member({ id: 'zz', name: 'zz', known: false }), member({ name: '<b>bad</b>', what: '<i>x</i>' })] });
  assert.match(html, /not in the panel/);
  assert.doesNotMatch(html, /<b>bad<\/b>|<i>x<\/i>/);
  assert.match(html, /&lt;b&gt;bad&lt;\/b&gt;/);
});

test('membersView: no members says how to add one; garbage never throws', () => {
  assert.match(R.membersView({ now: NOW, members: [] }), /No projects yet/);
  assert.doesNotMatch(R.membersView({ now: NOW, members: [] }), /members/i);
  for (const bad of [undefined, null, {}, { members: 'x' }, { members: [null, 5, 'x'] }]) assert.doesNotThrow(() => R.membersView(bad), JSON.stringify(bad));
  assert.equal(blocks(R.membersView({ members: [null, 5, member()] })), 1);
});

// ---------- the column of a room ----------
test('the column of a room: Members first, Tasks hidden, Changes, Status (with git) and Files kept, and it opens on Members', () => {
  const input = { room: true, members: [member()], now: NOW, files: [] };
  assert.deepEqual(tabs(R.columnView({ ...input, git: {} })), ['members', 'changes', 'status', 'files']);
  assert.deepEqual(tabs(R.columnView(input)), ['members', 'changes', 'files']);
  assert.deepEqual(tabs(R.columnView({ ...input, notes: true })), ['members', 'changes', 'files', 'notes']);
  for (const tab of [undefined, 'tasks', 'members', 'zzz']) assert.deepEqual(selected(R.columnView({ ...input, tab })), ['members'], String(tab));
  assert.match(R.columnView({ ...input, tab: 'members' }), /class="mb-row"/);
  assert.deepEqual(selected(R.columnView({ ...input, tab: 'files' })), ['files']);
  assert.deepEqual(selected(R.columnView({ ...input, tab: 'changes' })), ['changes']);
});

test('the tab is called Projects (what a room holds are projects: the card of the room says so), with its id still members', () => {
  const html = R.columnView({ room: true, members: [member()], now: NOW, files: [], git: {} });
  assert.match(html, /data-tab="members" aria-selected="true" aria-controls="colpane" aria-label="Projects" title="Projects"/);
  assert.doesNotMatch(html, /aria-label="Members"|title="Members"/);
});

test('the Projects tab has its own icon, a grid of four squares: not people and not the icon of any other tab', () => {
  const html = R.columnView({ room: true, members: [], git: {}, files: [], notes: true });
  const icon = (id) => (html.match(new RegExp(`data-tab="${id}"[^>]*>(<svg.*?</svg>)`)) || [])[1] || '';
  assert.equal((icon('members').match(/<rect /g) || []).length, 4);
  assert.doesNotMatch(icon('members'), /<circle/);
  const all = ['members', 'changes', 'status', 'files', 'notes'].map(icon);
  assert.ok(all.every(Boolean), 'every tab has an icon');
  assert.equal(new Set(all).size, all.length);
});

test('a repo that is not a room keeps its column as it was: Tasks, Changes, (Status), Files; no Members', () => {
  assert.deepEqual(tabs(R.columnView({ files: [] })), ['tasks', 'changes', 'files']);
  assert.deepEqual(tabs(R.columnView({ files: [], git: {} })), ['tasks', 'changes', 'status', 'files']);
  assert.deepEqual(tabs(R.columnView({ files: [], room: false, members: [member()] })), ['tasks', 'changes', 'files']);
  assert.deepEqual(selected(R.columnView({ files: [], tab: 'members' })), ['changes']);
  assert.deepEqual(R.COLUMN_TABS, ['tasks', 'changes', 'status', 'files']);
  assert.deepEqual(R.ROOM_COLUMN_TABS, ['members', 'changes', 'status', 'files']);
});

// ---------- the page: wiring, line by line ----------
test('the page wires the room column: the room of the open chat, its members, the tab it opens on, the click and the arrows', () => {
  const tabsJs = read('tabs.js');
  const chat = read('chat.js');
  const actions = read('actions.js');
  const app = read('app.js');
  assert.match(tabsJs, /const roomByFolder = \(id\) => \(V \? V\.roomOfFolder\(roomList\(\), id\) : null\);/);
  assert.match(chat, /const room = roomByFolder\(S\.chat\.id\);/);
  assert.match(chat, /members: room \? V\.roomMembers\(room, \{/);
  // the call that draws the column gets the room and its members (its own `room: !!room` is not the one of the line of the tab)
  assert.match(chat, /tab: colTab, room: !!room, members: room \? V\.roomMembers\(room, \{/);
  // the tab is chosen once per opening and does not wait for /api/rooms: the room of the open chat is known from the configuration of the page (A27)
  assert.match(chat, /if \(column && !S\.chat\.colTab && V\) \{/);
  assert.match(chat, /if \(room\) S\.chat\.colTab = 'members';/);
  assert.match(chat, /const colTab = V \? V\.columnTabOf\(S\.chat\.colTab, \{ room: !!room, phone \}\) : 'changes';/);
  assert.match(actions, /\(el\.dataset\.tab === 'members' && !!roomByFolder\(S\.chat\.id\)\)/);
  assert.match(app, /const tabs = roomByFolder\(S\.chat\.id\) \? R\.ROOM_COLUMN_TABS : R\.COLUMN_TABS;/);
});

test('the style: every member block has room to breathe and a line separates one member from the next', () => {
  const css = read('style.css');
  assert.match(css, /\.mb-row \+ \.mb-row \{[^}]*border-top: 1px solid var\(--line\)/);
  assert.match(css, /\.mb-row \{[^}]*padding:/);
});

test('the README says what the Members tab is and that a room hides Tasks', () => {
  const readme = fs.readFileSync(path.join(__dirname, '..', 'README.md'), 'utf8').replace(/\r\n/g, '\n');
  assert.match(readme, /\*\*Projects tab \(RP220\)\.\*\*/);
  assert.match(readme, /hides the Tasks tab/);
});
