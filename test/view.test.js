'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { API_VERSION, isOutdated, conformityView } = require('../public/view.js');

test('API_VERSION is a positive integer', () => {
  assert.ok(Number.isInteger(API_VERSION) && API_VERSION > 0);
});

test('isOutdated: a failed request (null) never warns', () => {
  assert.equal(isOutdated(null), false);
  assert.equal(isOutdated(undefined), false);
});

test('isOutdated: a missing or different api means out of date', () => {
  for (const h of [{}, { app: 'repo-panel' }, { api: 0 }, { api: '1' }, { api: API_VERSION + 1 }, 'x', 7]) {
    assert.equal(isOutdated(h), true, JSON.stringify(h));
  }
});

test('isOutdated: the same api is current', () => {
  assert.equal(isOutdated({ app: 'repo-panel', api: API_VERSION }), false);
});

test('conformityView: failed is always the error state, even after a good report', () => {
  const msg = 'Could not compute the report (is the panel server out of date? restart it)';
  const v = conformityView({ loaded: true, failed: true, ok: 3, items: [{}] });
  assert.equal(v.state, 'error');
  assert.equal(v.message, msg);
  assert.equal(conformityView({ loaded: false, failed: true, ok: 0, items: [] }).state, 'error');
});

test('conformityView: not loaded is computing and never claims conformity', () => {
  const v = conformityView({ loaded: false, failed: false, ok: 0, items: [] });
  assert.equal(v.state, 'computing');
  assert.equal(v.message, 'Computing the report…');
});

test('conformityView: items are issues with the summary', () => {
  const v = conformityView({ loaded: true, failed: false, ok: 4, items: [{}, {}] });
  assert.equal(v.state, 'issues');
  assert.equal(v.summary, '4 conform · 2 need attention');
  assert.equal(v.count, 2);
});

const REQ_OK = { prereq: 'loaded', repos: [{ id: 'a', state: 'loaded', ready: true }, { id: 'b', state: 'loaded', ready: true }] };
const reqWith = (...repos) => ({ prereq: 'loaded', repos });
const roadmapOk = { loaded: true, failed: false, ok: 5, items: [] };

test('conformityView: a computed report without items is ok', () => {
  const v = conformityView({ ...roadmapOk, req: REQ_OK });
  assert.equal(v.state, 'ok');
  assert.equal(v.summary, '5 conform');
  assert.equal(v.message, 'All repositories conform.');
});

test('conformityView: without requirement data it never claims conformity', () => {
  assert.equal(conformityView(roadmapOk).state, 'computing');
  assert.equal(conformityView({ ...roadmapOk, req: { prereq: 'loading', repos: [] } }).state, 'computing');
});

test('conformityView: requirements still loading are computing, even when prerequisites are loaded', () => {
  assert.equal(conformityView({ ...roadmapOk, req: reqWith({ id: 'a', state: 'loaded', ready: true }, { id: 'b', state: 'loading' }) }).state, 'computing');
  assert.equal(conformityView({ ...roadmapOk, req: { ...REQ_OK, prereq: 'loading' } }).state, 'computing');
});

test('conformityView: requirements or prerequisites that failed to load are error', () => {
  const failed = conformityView({ ...roadmapOk, req: reqWith({ id: 'a', state: 'failed' }) });
  assert.equal(failed.state, 'error');
  assert.equal(conformityView({ ...roadmapOk, req: { ...REQ_OK, prereq: 'failed' } }).state, 'error');
});

test('conformityView: a repo that is not ready makes issues, counted once with its roadmap problems', () => {
  const req = reqWith({ id: 'a', state: 'loaded', ready: true }, { id: 'b', state: 'loaded', ready: false });
  const v = conformityView({ ...roadmapOk, req });
  assert.equal(v.state, 'issues');
  assert.equal(v.summary, '5 conform · 1 not ready');
  assert.equal(v.count, 1);
  const both = conformityView({ loaded: true, failed: false, ok: 1, items: [{ id: 'b' }], req });
  assert.equal(both.count, 1);
  assert.equal(both.summary, '1 conform · 1 need attention · 1 not ready');
});

test('view.js runs as a plain script with no require or module', () => {
  const ctx = vm.createContext({});
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'public', 'view.js'), 'utf8'), ctx);
  assert.equal(typeof ctx.RepoPanelView.isOutdated, 'function');
  assert.equal(ctx.RepoPanelView.API_VERSION, API_VERSION);
});

const { cardWarning, cardMenu } = require('../public/view.js');
const loaded = (...results) => ({ state: 'loaded', data: { results } });
const rq = (id, status, level = 'required') => ({ id, status, level });

test('cardWarning: shown only when loaded, with a required gap, and not dismissed', () => {
  assert.equal(cardWarning(undefined, false), null);
  assert.equal(cardWarning({ state: 'failed' }, false), null);
  assert.equal(cardWarning({ state: 'loaded' }, false), null);
  assert.equal(cardWarning(loaded(rq('a', 'pass'), rq('b', 'pass', 'recommended')), false), null);
  assert.equal(cardWarning(loaded(rq('a', 'pass'), rq('c', 'fail', 'recommended')), false), null);
  assert.deepEqual(cardWarning(loaded(rq('a', 'fail'), rq('b', 'unavailable'), rq('c', 'outdated', 'recommended'), rq('d', 'pass')), false), { count: 2, ids: ['a', 'b'] });
  assert.equal(cardWarning(loaded(rq('a', 'fail')), true), null);
});

test('cardMenu: put in conditions only with a gap; the warning toggle only with a required gap', () => {
  const put = { act: 'put-in-conditions', label: 'Put in conditions' };
  assert.deepEqual(cardMenu(undefined, false), []);
  assert.deepEqual(cardMenu({ state: 'loading' }, false), []);
  assert.deepEqual(cardMenu(loaded(rq('a', 'pass')), false), []);
  assert.deepEqual(cardMenu(loaded(rq('a', 'fail', 'recommended')), false), [put]);
  assert.deepEqual(cardMenu(loaded(rq('a', 'fail')), false), [put, { act: 'toggle-warning', label: 'Hide warning' }]);
  assert.deepEqual(cardMenu(loaded(rq('a', 'fail')), true), [put, { act: 'toggle-warning', label: 'Show warning' }]);
});

// ---------- rooms ----------
const { roomOfRepo, roomTag, presenceLabel } = require('../public/view.js');
const ROOMS = [{ name: 'UPEN', path: '/r/ceo', repos: ['a', 'b'] }, { name: 'TOOLS', path: '/r/tools', repos: ['c'] }];
const live = (state, extra = {}) => ({ state: 'loaded', data: { rooms: [{ name: 'UPEN', presence: { state, sessions: 1 }, lastCommit: '2026-10-23T18:30:00-05:00', ...extra }] } });

test('roomOfRepo: only repos listed in a room are members', () => {
  assert.equal(roomOfRepo(ROOMS, 'a').name, 'UPEN');
  assert.equal(roomOfRepo(ROOMS, 'c').name, 'TOOLS');
  assert.equal(roomOfRepo(ROOMS, 'z'), null);
  assert.equal(roomOfRepo([], 'a'), null);
  assert.equal(roomOfRepo(undefined, 'a'), null);
});

test('roomTag: no tag outside a room; the dot is green idle, yellow busy and gray otherwise', () => {
  assert.equal(roomTag(ROOMS, 'z', live('idle')), null);
  assert.equal(roomTag([], 'a', live('idle')), null);
  const dot = (state) => roomTag(ROOMS, 'a', live(state)).dot;
  assert.deepEqual(['idle', 'busy', 'closed', 'ambiguous', 'unknown'].map(dot), ['green', 'yellow', 'gray', 'gray', 'gray']);
  assert.equal(roomTag(ROOMS, 'a', live('idle')).name, 'UPEN');
});

test('roomTag: while the rooms load or fail the dot is gray and nothing is claimed about the session', () => {
  for (const entry of [undefined, { state: 'loading' }, { state: 'failed' }, { state: 'loaded', data: { rooms: [] } }]) {
    const t = roomTag(ROOMS, 'a', entry);
    assert.equal(t.dot, 'gray');
    assert.doesNotMatch(t.title, /idle|busy|closed/);
  }
});

test('roomTag: the tooltip explains the state and gives the last commit date', () => {
  assert.equal(roomTag(ROOMS, 'a', live('busy')).title, 'Room UPEN · pi session open, busy · last commit 2026-10-23');
  assert.equal(roomTag(ROOMS, 'a', live('closed', { lastCommit: null })).title, 'Room UPEN · no pi session open in the room folder · last commit unknown');
  assert.equal(presenceLabel({ state: 'ambiguous', sessions: 3 }), '3 pi sessions open: close the extra ones');
  assert.match(presenceLabel({ state: 'unknown', sessions: null }), /Orca unavailable/);
});

const roomsReq = (state, list = []) => ({ prereq: 'loaded', repos: [{ id: 'a', state: 'loaded', ready: true }], rooms: { state, list } });

test('conformityView: never ok while the rooms load or fail, or while a room has a required gap', () => {
  assert.equal(conformityView({ ...roadmapOk, req: roomsReq('loading') }).state, 'computing');
  assert.equal(conformityView({ ...roadmapOk, req: roomsReq('failed') }).state, 'error');
  const notReady = conformityView({ ...roadmapOk, req: roomsReq('loaded', [{ name: 'UPEN', ready: false }, { name: 'T', ready: true }]) });
  assert.equal(notReady.state, 'issues');
  assert.equal(notReady.summary, '5 conform · 1 room not ready');
  assert.equal(notReady.count, 1);
  const ok = conformityView({ ...roadmapOk, req: roomsReq('loaded', [{ name: 'UPEN', ready: true }]) });
  assert.equal(ok.state, 'ok');
  assert.equal(ok.message, 'All repositories conform.');
  assert.equal(conformityView({ ...roadmapOk, req: roomsReq('loaded', []) }).state, 'ok');
});

// ---------- room management ----------
const { roomMenu, roomIssuesNotice } = require('../public/view.js');

test('roomMenu: one item per room with the current one marked, plus "No room"', () => {
  const m = roomMenu(ROOMS, 'a');
  assert.equal(m.title, 'Assign to room');
  assert.deepEqual(m.items.map((i) => [i.act, i.room, i.label, i.current]), [
    ['assign-room', 'UPEN', 'UPEN', true],
    ['assign-room', 'TOOLS', 'TOOLS', false],
    ['assign-room', null, 'No room', false],
  ]);
  assert.deepEqual(roomMenu(ROOMS, 'c').items.map((i) => i.current), [false, true, false]);
});

test('roomMenu: a repo in no room has "No room" marked', () => {
  assert.deepEqual(roomMenu(ROOMS, 'z').items.map((i) => i.current), [false, false, true]);
});

test('roomMenu: with no rooms there is no assign group, only "Create a room…"', () => {
  for (const rooms of [[], undefined, null]) {
    assert.deepEqual(roomMenu(rooms, 'a'), { title: '', items: [{ act: 'room-dialog', label: 'Create a room…', current: false }] });
  }
});

test('roomIssuesNotice: nothing when all entries are fine; otherwise a count and the reasons', () => {
  assert.equal(roomIssuesNotice([]), null);
  assert.equal(roomIssuesNotice(undefined), null);
  assert.deepEqual(roomIssuesNotice(['rooms[2]: path must be absolute']), {
    message: '1 entry in config.json under rooms is invalid and ignored', reasons: ['rooms[2]: path must be absolute'],
  });
  assert.equal(roomIssuesNotice(['rooms[0]: name is empty', 'rooms[1]: path must be absolute']).message, '2 entries in config.json under rooms are invalid and ignored');
  assert.equal(roomIssuesNotice(['rooms: must be a list']).message, 'rooms in config.json is not a list and is ignored');
});

// ---------- RP12a: declared state ----------
const { commitAllowed, stateLine } = require('../public/view.js');
const CLOCK = { now: Date.parse('2026-10-24T12:00:00Z') }; // a fixed clock: a working state expires after 30 minutes
const st = (state, extra = {}) => ({ available: true, state, next: 'Do the thing.', detail: null, at: '2026-10-24T11:59:00Z', stale: false, reason: null, ...extra });

test('commitAllowed: allowed with no usable state or with ready-to-commit; hidden for every other fresh state', () => {
  for (const none of [undefined, null, {}, 'x', { available: false, reason: 'missing' }, { available: false, reason: 'invalid' }, { available: false, reason: 'unsafe' }, { available: false, reason: 'error' }]) {
    assert.equal(commitAllowed(none, CLOCK), true);
  }
  assert.equal(commitAllowed(st('ready-to-commit', { stale: true }), CLOCK), true);
  assert.equal(commitAllowed(st('needs-input', { stale: true }), CLOCK), true);
  assert.equal(commitAllowed(st('mystery'), CLOCK), true);
  assert.equal(commitAllowed(st('ready-to-commit'), CLOCK), true);
  for (const s of ['working', 'needs-input', 'blocked', 'ready-to-pr']) assert.equal(commitAllowed(st(s), CLOCK), false, s);
});

test('stateLine: a fresh state shows its next line with a dot per state and the full text in the tooltip', () => {
  const dots = { working: 'yellow', 'needs-input': 'blue', 'ready-to-commit': 'green', 'ready-to-pr': 'green', blocked: 'red' };
  for (const [s, dot] of Object.entries(dots)) {
    const l = stateLine(st(s, { detail: 'More text.' }), CLOCK);
    assert.deepEqual([l.kind, l.dot, l.text], ['current', dot, 'Do the thing.']);
    assert.equal(l.title, 'Do the thing.\n\nMore text.\n\n2026-10-24T11:59:00Z');
  }
  assert.equal(stateLine(st('working'), CLOCK).title, 'Do the thing.\n\n2026-10-24T11:59:00Z');
});

test('stateLine: a stale state shows only an outdated marker, never the old text; no usable state shows nothing', () => {
  const l = stateLine(st('needs-input', { next: 'OLD SECRET LINE', detail: 'OLD DETAIL', stale: true }));
  assert.deepEqual([l.kind, l.dot, l.text], ['outdated', 'gray', '']);
  assert.match(l.title, /outdated/i);
  assert.equal(l.title.includes('OLD'), false);
  for (const none of [undefined, null, { available: false, reason: 'missing' }, st('mystery')]) assert.equal(stateLine(none), null);
});

// ---------- RP12c: what the "Go work on" strip says ----------
const { queueFlags } = require('../public/view.js');
const NOW = { now: Date.parse('2026-10-24T12:00:00Z') };
const clean = { files: [], branch: 'task', base: 'main', ahead: 0, behind: 0, head: 'h1' };
const fresh = (state, extra = {}) => ({ available: true, state, next: 'Answer the question.', detail: null, at: '2026-10-24T11:59:00Z', stale: false, reason: null, ...extra });

test('API_VERSION is 9: the queue request now carries manual and waiting', () => {
  assert.equal(API_VERSION, 9);
});

test('index.html has an empty data: icon so the browser does not ask for /favicon.ico', () => {
  const html = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'public', 'index.html'), 'utf8');
  assert.ok(html.includes('<link rel="icon" href="data:,">'));
});

test('queueFlags: manual comes from manualAction', () => {
  assert.deepEqual(queueFlags({ ...clean, detached: true }, null, null, NOW), { manual: 'Detached HEAD: switch to a task branch' });
  assert.deepEqual(queueFlags({ ...clean, branch: 'main', ahead: 2 }, null, null, NOW), { manual: 'Commits on main: move them to a task branch' });
  assert.deepEqual(queueFlags({ ...clean, inProgress: 'rebase' }, null, null, NOW), { manual: 'A rebase is in progress: finish or abort it' });
  assert.deepEqual(queueFlags({ ...clean, ahead: 1, behind: 1, upstream: 'origin/task' }, null, null, NOW), { manual: 'Diverged from origin/task: reconcile it by hand' });
});

test('queueFlags: manual comes from an attention verdict and manualAction wins', () => {
  assert.deepEqual(queueFlags(clean, null, { state: 'attention', reason: '2 files still uncommitted after /flow-commit' }, NOW), { manual: '2 files still uncommitted after /flow-commit' });
  assert.deepEqual(queueFlags({ ...clean, detached: true }, null, { state: 'attention', reason: 'r' }, NOW), { manual: 'Detached HEAD: switch to a task branch' });
  for (const v of [null, { state: 'running', reason: 'r' }, { state: 'ok', reason: 'r' }]) assert.deepEqual(queueFlags(clean, null, v, NOW), {});
});

test('queueFlags: waiting only for a fresh usable needs-input or blocked state', () => {
  assert.deepEqual(queueFlags(clean, fresh('needs-input'), null, NOW), { waiting: { state: 'needs-input', next: 'Answer the question.' } });
  assert.deepEqual(queueFlags(clean, fresh('blocked'), null, NOW), { waiting: { state: 'blocked', next: 'Answer the question.' } });
  for (const s of ['working', 'ready-to-commit', 'ready-to-pr']) assert.deepEqual(queueFlags(clean, fresh(s), null, NOW), {});
  for (const bad of [null, undefined, {}, { available: false, reason: 'missing' }, fresh('needs-input', { stale: true }), fresh('nonsense')]) assert.deepEqual(queueFlags(clean, bad, null, NOW), {});
});

test('queueFlags: no waiting when the person chose to show /flow-commit anyway', () => {
  assert.deepEqual(queueFlags(clean, fresh('blocked'), null, { ...NOW, override: true }), {});
  assert.deepEqual(queueFlags({ ...clean, detached: true }, fresh('blocked'), null, { ...NOW, override: true }), { manual: 'Detached HEAD: switch to a task branch' });
});

test('queueFlags: an expired working state is not waiting, and a missing local state flags nothing', () => {
  assert.deepEqual(queueFlags(clean, fresh('working', { at: '2026-10-24T10:00:00Z' }), null, NOW), {});
  assert.deepEqual(queueFlags(undefined, null, null, NOW), {});
  assert.deepEqual(queueFlags({ error: 'x' }, null, null, NOW), {});
});

test('style.css: the roadmap block of a clean row can shrink, so a long Next line is cut with an ellipsis instead of widening the column', () => {
  const css = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'public', 'style.css'), 'utf8');
  const start = css.indexOf('.clean-row .roadmap {');
  assert.ok(start >= 0, 'the .clean-row .roadmap rule exists');
  const rule = css.slice(start, css.indexOf('}', start));
  assert.ok(rule.includes('min-width: 0'), `expected min-width: 0 in: ${rule}`);
});
