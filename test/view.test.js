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
