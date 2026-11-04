'use strict';
// RPC3c (S3): the derived state of the page, the "go work on" queue and the Conformity and Summary tabs live in public/tabs.js, between feed.js and app.js.
// Like data.js and feed.js it shares the global scope and may use S, V, R and draw only when a function is called, never while it loads: its top-level
// initializers are plain constants and counters. What moved stays out of app.js. (That the server serves every page script is checked for the whole
// APP_FILES list in rpc3a-data.test.js.)
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { PUBLIC, LIB_FILES, APP_FILES } = require('./pagesrc.js');

const read = (f) => fs.readFileSync(path.join(PUBLIC, f), 'utf8').replace(/\r\n/g, '\n');
const MOVED = ['modelOf', 'info', 'visibleRepos', 'queueItems', 'refreshQueue', 'QUEUE_MAX', 'QUEUE_CLIP', 'clip', 'QUEUE_TEXT', 'QUEUE_TITLE', 'QUEUE_COLOR', 'drawQueue',
  'refreshConformity', 'CONF_STATUS', 'confBlock', 'REQ_CATEGORY', 'REQ_MARK', 'reqSummary', 'piSelect', 'prereqBlock', 'reqLine', 'reqResults', 'reqBlock',
  'REASON_OF', 'roomBlock', 'roomIssuesBlock', 'roomsBlock', 'drawConformity', 'openConformity', 'SUMMARY_TIMEOUT_MS', 'SUMMARY_LOADING_MS', 'summarySeq',
  'summaryApplied', 'loadSummary', 'summaryTick', 'applyTab', 'setTab', 'summaryFlow', 'summaryChanges', 'summaryPrs', 'summaryIdle', 'commandRunning',
  'summaryShown', 'chatView', 'drawSummary'];
const esc = (n) => n.replace(/\$/g, '\\$');
const defines = (src, name) => new RegExp(`^(async function ${esc(name)}\\b|function ${esc(name)}\\b|const ${esc(name)} =|let ${esc(name)}\\b)`, 'm').test(src);

test('tabs.js defines the derived state, the queue and the two tabs, and app.js defines none of it', () => {
  const tabs = read('tabs.js');
  for (const n of MOVED) assert.equal(defines(tabs, n), true, `tabs.js defines ${n}`);
  const app = read('app.js');
  for (const n of MOVED) assert.equal(defines(app, n), false, `app.js no longer defines ${n}`);
  for (const n of ['S', 'TOKEN', 'paint']) assert.equal(defines(app, n), true, `app.js keeps ${n}`);
  assert.equal(defines(read('data.js'), 'api'), true, 'data.js keeps its own layer');
  assert.equal(defines(read('feed.js'), 'loadBoard'), true, 'feed.js keeps its own feed');
});

test('the page scripts keep data.js, feed.js and tabs.js before app.js, and index.html loads them as listed', () => {
  assert.deepEqual(APP_FILES.slice(0, 3), ['data.js', 'feed.js', 'tabs.js']);
  assert.equal(APP_FILES[APP_FILES.length - 1], 'app.js');
  const scripts = [...read('index.html').matchAll(/<script src="([^"]+)"><\/script>/g)].map((m) => m[1]);
  assert.deepEqual(scripts, [...LIB_FILES, ...APP_FILES].map((f) => `/${f}`));
});

test('tabs.js loads after data.js and feed.js, as a separate script, without touching S, V, R or the DOM', () => {
  const ctx = vm.createContext({ console, window: {}, document: new Proxy({}, { get: () => { throw new Error('a page script touched the document while loading'); } }) });
  ctx.window = ctx;
  for (const f of ['data.js', 'feed.js', 'tabs.js']) assert.doesNotThrow(() => vm.runInContext(read(f), ctx), f);
  for (const n of ['loadSummary', 'drawSummary', 'setTab', 'applyTab', 'openConformity', 'drawConformity', 'queueItems', 'visibleRepos', 'modelOf']) assert.equal(vm.runInContext(`typeof ${n}`, ctx), 'function', n);
  assert.equal(vm.runInContext('REASON_OF.idle', ctx), 'free');
  assert.equal(vm.runInContext('summarySeq', ctx), 0);
  assert.equal(vm.runInContext('QUEUE_MAX', ctx), 8);
});
