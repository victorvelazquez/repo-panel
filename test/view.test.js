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
});

test('conformityView: a computed report without items is ok', () => {
  const v = conformityView({ loaded: true, failed: false, ok: 5, items: [] });
  assert.equal(v.state, 'ok');
  assert.equal(v.summary, '5 conform');
  assert.equal(v.message, 'All repositories conform.');
});

test('view.js runs as a plain script with no require or module', () => {
  const ctx = vm.createContext({});
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'public', 'view.js'), 'utf8'), ctx);
  assert.equal(typeof ctx.RepoPanelView.isOutdated, 'function');
  assert.equal(ctx.RepoPanelView.API_VERSION, API_VERSION);
});
