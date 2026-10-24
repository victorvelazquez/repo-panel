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
