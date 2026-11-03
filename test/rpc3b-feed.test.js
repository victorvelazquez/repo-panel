'use strict';
// RPC3b (S3): the feed of the page (the event stream with its `rpc` frames, the board of RP80, the refresh ticks and the loads that fill the page) lives in
// public/feed.js, between data.js and app.js. Like data.js it shares the global scope and may use S, V, R and draw only when a function is called, never while it
// loads. What moved stays out of app.js. (That the server serves every page script is checked for the whole APP_FILES list in rpc3a-data.test.js.)
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { PUBLIC, APP_FILES } = require('./pagesrc.js');

const read = (f) => fs.readFileSync(path.join(PUBLIC, f), 'utf8').replace(/\r\n/g, '\n');
const MOVED = ['ev', 'applyRpc', 'settled', 'rpcSync', 'rpcSyncAll', 'RPC_STATE_NAMES', 'rpcSeed', 'readEvents', 'stopEvents', 'startEvents', 'pollSkipped', 'quietNow',
  'quietTick', 'applyPiState', 'startSent', 'clearSent', 'loadPrerequisites', 'loadRooms', 'wakeReady', 'checkHealth', 'BOARD_DOWN_AFTER', 'board', 'boardWorks',
  'boardLeads', 'AGED_MS', 'applyBoardRepo', 'loadBoard', 'boardTick', 'scheduleBoard', 'refreshAll', 'refreshTick', 'fetchRepo', 'snoozeKey', 'setSnooze',
  'setDismissed', 'nameOf'];
const defines = (src, name) => new RegExp(`^(async function ${name.replace(/\$/g, '\\$')}\\b|function ${name.replace(/\$/g, '\\$')}\\b|const ${name.replace(/\$/g, '\\$')} =|let ${name.replace(/\$/g, '\\$')}\\b)`, 'm').test(src);

test('feed.js defines the whole feed and app.js defines none of it', () => {
  const feed = read('feed.js');
  for (const n of MOVED) assert.equal(defines(feed, n), true, `feed.js defines ${n}`);
  const app = read('app.js');
  for (const n of MOVED) assert.equal(defines(app, n), false, `app.js no longer defines ${n}`);
  for (const n of ['S', 'TOKEN', 'paint']) assert.equal(defines(app, n), true, `app.js keeps ${n}`);
  assert.equal(defines(read('data.js'), 'refreshRepo'), true, 'data.js keeps its own layer');
});

test('data.js and feed.js come first and app.js last in the page scripts, and index.html loads them as listed', () => {
  assert.deepEqual(APP_FILES.slice(0, 2), ['data.js', 'feed.js']);
  assert.equal(APP_FILES[APP_FILES.length - 1], 'app.js');
  const scripts = [...read('index.html').matchAll(/<script src="([^"]+)"><\/script>/g)].map((m) => m[1]);
  assert.deepEqual(scripts, ['/view.js', '/resumen.js', ...APP_FILES.map((f) => `/${f}`)]);
});

test('feed.js loads after data.js, as a separate script, without touching S, V, R or the DOM', () => {
  const ctx = vm.createContext({ console, window: {}, document: new Proxy({}, { get: () => { throw new Error('a page script touched the document while loading'); } }) });
  ctx.window = ctx;
  assert.doesNotThrow(() => vm.runInContext(read('data.js'), ctx));
  assert.doesNotThrow(() => vm.runInContext(read('feed.js'), ctx));
  for (const n of ['startEvents', 'readEvents', 'loadBoard', 'refreshAll', 'refreshTick', 'applyPiState', 'quietTick']) assert.equal(vm.runInContext(`typeof ${n}`, ctx), 'function', n);
  assert.equal(vm.runInContext('ev.connected', ctx), false);
  assert.equal(vm.runInContext('board.failures', ctx), 0);
});
