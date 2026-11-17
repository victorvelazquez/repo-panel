'use strict';
// RP220 (A27): the card of a room, the opening of its chat and its Projects tab do NOT depend on the slow read GET /api/rooms (median 14 s, 5% slowest 35 s; the page gives up at 25 s).
// The page builds the room from what it already has instantly (S.rooms from /api/config and the repos), keeps the last good data of that read when it fails, and lets that read only complete
// what needs git (requirements, last commit). Page only: no server change.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const assert = require('node:assert/strict');
const { appSource } = require('./pagesrc.js');
const R = require('../public/resumen.js');
const V = require('../public/view.js');

const read = (f) => fs.readFileSync(path.join(__dirname, '..', 'public', f), 'utf8').replace(/\r\n/g, '\n');
const freeze = (o) => { if (o && typeof o === 'object') { Object.values(o).forEach(freeze); Object.freeze(o); } return o; };

// ---------- the pure function ----------
const CFG = () => [{ name: 'UPEN', path: 'C:\\Users\\x\\Room', repos: ['m1', 'm2'] }];
const REPOS = () => [{ id: 'f1', path: 'c:/users/x/room/', name: 'room' }, { id: 'm1', path: 'C:\\x\\erp', name: 'erp' }];

test('mergeRooms: from the configuration alone the room has its name, path, members and the id of its folder (the repo with that path, slashes and case ignored)', () => {
  assert.deepEqual(V.mergeRooms(CFG(), REPOS(), null), [{ name: 'UPEN', path: 'C:\\Users\\x\\Room', repos: ['m1', 'm2'], id: 'f1' }]);
  for (const p of ['C:\\Users\\x\\Room\\', 'c:/USERS/x/room', 'C:/Users/x/Room//']) {
    assert.equal(V.mergeRooms([{ name: 'U', path: p, repos: [] }], REPOS(), undefined)[0].id, 'f1', p);
  }
  assert.equal(V.mergeRooms([{ name: 'U', path: 'C:\\Users\\x\\Room2', repos: [] }], REPOS(), null)[0].id, null);
  assert.equal(V.mergeRooms([{ name: 'U', repos: [] }], REPOS(), null)[0].id, null);
});

test('mergeRooms: the data of /api/rooms completes the room (last commit, requirements, its id) and the configuration wins for name, path and members', () => {
  const data = [{ name: 'UPEN', id: 'zz9', path: 'old', repos: ['old'], lastCommit: '2026-11-17T10:00:00Z', results: [1], summary: { ready: true }, available: true, base: 'main' }];
  const out = V.mergeRooms(CFG(), REPOS(), data);
  assert.deepEqual(out, [{ name: 'UPEN', id: 'zz9', path: 'C:\\Users\\x\\Room', repos: ['m1', 'm2'], lastCommit: '2026-11-17T10:00:00Z', results: [1], summary: { ready: true }, available: true, base: 'main' }]);
  // an id that is not a non-empty text is ignored and the one of the folder is used
  for (const id of [5, '', null, undefined]) assert.equal(V.mergeRooms(CFG(), REPOS(), [{ name: 'UPEN', id }])[0].id, 'f1', String(id));
});

test('mergeRooms: a room that exists only in the data is kept after the configured ones (old pages seeded only that), and a configured room missing in the data is still there', () => {
  const out = V.mergeRooms(CFG(), REPOS(), [{ name: 'OTHER', id: 'o1', repos: ['x'], lastCommit: null }]);
  assert.deepEqual(out.map((m) => [m.name, m.id]), [['UPEN', 'f1'], ['OTHER', 'o1']]);
  assert.deepEqual(out[1].repos, ['x']);
  assert.deepEqual(V.mergeRooms([], REPOS(), [{ name: 'OTHER', id: 'o1', repos: [] }]).map((m) => m.name), ['OTHER']);
});

test('mergeRooms: an empty path never matches a repo (the room has no folder to find), and the names are compared exactly, not by case', () => {
  assert.equal(V.mergeRooms([{ name: 'U', path: '', repos: [] }], [{ id: 'x', path: '' }, { id: 'f1', path: 'c:/users/x/room' }], null)[0].id, null);
  const out = V.mergeRooms(CFG(), REPOS(), [{ name: 'upen', id: 'zz9', lastCommit: 'x' }]);
  assert.deepEqual(out.map((m) => [m.name, m.id]), [['UPEN', 'f1'], ['upen', 'zz9']]);
  assert.equal(out[0].lastCommit, undefined);
});

test('mergeRooms: total and pure: garbage gives an empty list or skips the entry, and it never changes what it is given', () => {
  for (const bad of [[undefined, undefined, undefined], [null, null, null], ['x', 5, {}], [{}, [], 'x']]) assert.deepEqual(V.mergeRooms(...bad), [], JSON.stringify(bad));
  assert.deepEqual(V.mergeRooms([null, 5, 'x', { name: 7 }, { name: 'ok', repos: 'no' }], [null, 5, { id: 'f1' }], [null, 'x', { name: 'ok' }]).map((m) => m.name), ['ok']);
  const cfg = freeze(CFG());
  const repos = freeze(REPOS());
  const data = freeze([{ name: 'UPEN', id: 'zz9', lastCommit: 'x' }, { name: 'OTHER', id: 'o1' }]);
  assert.doesNotThrow(() => V.mergeRooms(cfg, repos, data));
  assert.deepEqual(cfg, CFG());
});

// ---------- the wiring of the page, line by line ----------
test('the page builds the room list from the configuration, keeps the last good data and does not wait for /api/rooms to choose the tab', () => {
  const tabs = read('tabs.js');
  const feed = read('feed.js');
  const chat = read('chat.js');
  assert.match(tabs, /const roomList = \(\) => \(V \? V\.mergeRooms\(S\.rooms, allRepos\(\), S\.roomData\.data && S\.roomData\.data\.rooms\) : \(S\.roomData\.data && S\.roomData\.data\.rooms\) \|\| \[\]\);/);
  assert.match(tabs, /roomData: \{ rooms: roomList\(\) \},/);
  assert.doesNotMatch(tabs, /roomData: S\.roomData\.data,/);
  assert.match(feed, /\(\) => \{ if \(seq === S\.roomSeq\) \{ S\.roomData = \{ state: 'failed', data: S\.roomData\.data \}; draw\(\); \} \},/);
  assert.match(chat, /if \(column && !S\.chat\.colTab && V\) \{/);
  assert.doesNotMatch(chat, /S\.roomData\.state !== 'loading'/);
});

// ---------- the REAL page in a vm ----------
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
function loadPage() {
  const els = {};
  const frames = [];
  const get = (sel) => (els[sel] ||= (sel === 'meta[name=token]' ? { ...element(), content: 'token' } : element()));
  const ctx = vm.createContext({
    console,
    document: { hidden: false, querySelector: get, querySelectorAll: () => [], addEventListener() {}, createElement: () => element(), body: element() },
    localStorage: { getItem: () => null, setItem() {} }, location: { hash: '' },
    requestAnimationFrame: (cb) => { frames.push(cb); return frames.length; },
    setInterval: () => 0, setTimeout: () => 0, clearTimeout: () => {}, AbortController, confirm: () => true, fetch: () => new Promise(() => {}),
  });
  ctx.window = ctx;
  ctx.addEventListener = () => {};
  ctx.RepoPanelView = V;
  ctx.RepoPanelResumen = R;
  vm.runInContext(appSource(), ctx);
  return { ctx, get, run: (code) => vm.runInContext(code, ctx) };
}
const progress = { total: 4, completada: 1, enRevision: 0, bloqueada: 0, pendiente: 3, enCurso: 0 };
const row = (o = {}) => ({
  id: 'm1', name: 'erp', group: 'G', room: null, branch: 'main', progress, session: { state: 'free' }, next: null, blocking: [],
  lastMovement: { at: '2026-11-17T11:00:00Z', what: 'x' }, action: null, error: null, needs: false, rank: 9, ...o,
});
const seed = (page, roomData) => {
  const S = page.run('S');
  S.groups = [{ name: 'G', repos: [{ id: 'f1', name: 'upen-ceo', path: 'C:\\x\\upen-ceo' }, { id: 'm1', name: 'erp', path: 'C:\\x\\erp' }] }];
  S.rooms = [{ name: 'UPEN', path: 'C:\\x\\upen-ceo', repos: ['m1'] }];
  S.summary = { rows: [row({ id: 'f1', name: 'upen-ceo' }), row({ id: 'm1', name: 'erp', room: 'UPEN' })], counts: {}, attention: [], generatedAt: '2026-11-17T12:00:00Z' };
  S.roomData = roomData;
  return S;
};
const articles = (html) => html.split('<article').slice(1);
const withId = (html, id) => articles(html).filter((c) => c.includes(`data-id="${id}"`));

test('with /api/rooms still loading, failed or never answered, the Summary draws the room card from the configuration, and it opens the chat of its folder', () => {
  for (const roomData of [{ state: 'loading', data: null }, { state: 'failed', data: null }]) {
    const page = loadPage();
    seed(page, roomData);
    page.run('render()');
    const html = page.get('#summary').html;
    const folder = withId(html, 'f1');
    assert.equal(folder.length, 1, roomData.state);
    assert.match(folder[0], /rs-room/, roomData.state);
    assert.match(folder[0], /data-act="chat-open" tabindex="0"/, roomData.state);
    assert.match(html, /★ UPEN/, roomData.state);
    assert.equal(withId(html, 'm1').length, 1, roomData.state);
    // no second card for the folder, and nothing printed from a last commit that is not there yet
    assert.doesNotMatch(folder[0], /undefined|NaN|Invalid/, roomData.state);
  }
});

test('when the read answers the same card gains its last commit; the folder is still ONE card', () => {
  const page = loadPage();
  seed(page, { state: 'loaded', data: { rooms: [{ name: 'UPEN', id: 'f1', repos: ['m1'], lastCommit: '2026-11-17T10:00:00Z' }] } });
  page.run('render()');
  const html = page.get('#summary').html;
  assert.equal(withId(html, 'f1').length, 1);
  assert.match(withId(html, 'f1')[0], /last commit/);
  assert.doesNotMatch(withId(html, 'f1')[0], /undefined|NaN|Invalid/);
});

test('a failed read keeps the last good data (the state says failed); with nothing before it leaves none', async () => {
  const good = { rooms: [{ name: 'UPEN', id: 'f1', repos: ['m1'], lastCommit: '2026-11-17T10:00:00Z' }] };
  const page = loadPage();
  const S = seed(page, { state: 'loaded', data: good });
  page.run("api = () => Promise.reject(new Error('timeout'))");
  await Promise.race([page.run('loadRooms()'), new Promise((_, rej) => setTimeout(() => rej(new Error('loadRooms hung')), 3000))]);
  assert.equal(S.roomData.state, 'failed');
  assert.deepEqual(S.roomData.data, good);
  S.roomData = { state: 'loading', data: null };
  await Promise.race([page.run('loadRooms()'), new Promise((_, rej) => setTimeout(() => rej(new Error('loadRooms hung')), 3000))]);
  assert.equal(S.roomData.state, 'failed');
  assert.equal(S.roomData.data, null);
});

test('the Projects column and the folder as a room do not wait either: the room of the open chat is known from the configuration, and Conformity leaves the folder out', () => {
  const page = loadPage();
  seed(page, { state: 'failed', data: null });
  assert.equal(page.run("roomByFolder('f1') && roomByFolder('f1').name"), 'UPEN');
  assert.equal(page.run("roomByFolder('m1')"), null);
  assert.deepEqual(JSON.parse(page.run('JSON.stringify(projectRepos().map((r) => r.id))')), ['m1']);
});

test('a repo that is not a room, with no rooms configured, is untouched: no room list, no card', () => {
  const page = loadPage();
  const S = seed(page, { state: 'loading', data: null });
  S.rooms = [];
  S.summary = { rows: [row({ id: 'm1', name: 'erp' })], counts: {}, attention: [], generatedAt: '2026-11-17T12:00:00Z' };
  assert.deepEqual(JSON.parse(page.run('JSON.stringify(roomList())')), []);
  page.run('render()');
  assert.doesNotMatch(page.get('#summary').html, /rs-room/);
  assert.equal(page.run("roomByFolder('f1')"), null);
});
