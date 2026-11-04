'use strict';
// RPC3f (S3): the actions of the page (merge, re-run, add repos, rooms, the ACTIONS table of click handlers and the usage bar) live in public/actions.js, between board.js and
// app.js. Like the other page files it shares the global scope and uses S, V, R, $ and draw only when a function is called. What stays in app.js is the boot, which runs at load:
// the document listeners, the search and group inputs, the setIntervals, loadUsage() and the init function. With this slice app.js is only the boot file.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { PUBLIC, LIB_FILES, APP_FILES } = require('./pagesrc.js');

const read = (f) => fs.readFileSync(path.join(PUBLIC, f), 'utf8').replace(/\r\n/g, '\n');
const MOVED = ['doMerge', 'doRerun', 'addRepos', 'reloadRooms', 'createRoom', 'JUDGED_CMDS', 'ACTIONS', 'loadUsage'];
const esc = (n) => n.replace(/\$/g, '\\$');
const defines = (src, name) => new RegExp(`^(async function ${esc(name)}\\b|function ${esc(name)}\\b|const ${esc(name)} =|let ${esc(name)}\\b)`, 'm').test(src);
const BOOT = [/^document\.addEventListener\('click'/m, /^document\.addEventListener\('submit'/m, /^document\.addEventListener\('keydown'/m, /^document\.addEventListener\('visibilitychange'/m,
  /^\$\('#search'\)\.addEventListener/m, /^setInterval\(summaryTick, 20000\);/m, /^setInterval\(chatTick, CHAT_MS\);/m, /^loadUsage\(\);/m, /^\(async \(\) => \{/m];

test('actions.js defines the actions and the usage bar and app.js defines none of it', () => {
  const actions = read('actions.js');
  for (const n of MOVED) assert.equal(defines(actions, n), true, `actions.js defines ${n}`);
  const app = read('app.js');
  for (const n of MOVED) assert.equal(defines(app, n), false, `app.js no longer defines ${n}`);
  for (const n of ['S', 'TOKEN', 'paint']) assert.equal(defines(app, n), true, `app.js keeps ${n}`);
  assert.equal(defines(read('board.js'), 'render'), true, 'board.js keeps its own board');
});

test('the boot stays in app.js and actions.js has none of it', () => {
  const actions = read('actions.js');
  const app = read('app.js');
  for (const re of BOOT) {
    assert.match(app, re, `app.js keeps ${re}`);
    assert.doesNotMatch(actions, re, `actions.js has no ${re}`);
  }
  assert.doesNotMatch(actions, /^(document|window)\.addEventListener|^setInterval\(/m, 'no listener or timer at the top level of actions.js');
  assert.ok(app.indexOf('loadUsage();') > app.indexOf('const S = {'), 'the boot runs after S exists');
});

test('actions.js sits between board.js and app.js, and index.html loads the scripts as listed', () => {
  const at = (f) => APP_FILES.indexOf(f);
  assert.ok(at('board.js') >= 0 && at('actions.js') > at('board.js') && at('app.js') > at('actions.js'), JSON.stringify(APP_FILES));
  assert.equal(APP_FILES[APP_FILES.length - 1], 'app.js');
  const scripts = [...read('index.html').matchAll(/<script src="([^"]+)"><\/script>/g)].map((m) => m[1]);
  assert.deepEqual(scripts, [...LIB_FILES, ...APP_FILES].map((f) => `/${f}`));
});

test('actions.js loads after the other five as a separate script and touches no S, V, R or document', () => {
  const ctx = vm.createContext({
    console, window: {}, localStorage: { getItem: () => null },
    document: new Proxy({}, { get: () => { throw new Error('a page script touched the document while loading'); } }),
  });
  ctx.window = ctx;
  for (const f of ['data.js', 'feed.js', 'tabs.js', 'chat.js', 'board.js', 'actions.js']) assert.doesNotThrow(() => vm.runInContext(read(f), ctx), f);
  for (const n of ['doMerge', 'doRerun', 'addRepos', 'reloadRooms', 'createRoom', 'loadUsage']) assert.equal(vm.runInContext(`typeof ${n}`, ctx), 'function', n);
  assert.equal(vm.runInContext('typeof ACTIONS', ctx), 'object');
  assert.ok(vm.runInContext('Object.keys(ACTIONS).length', ctx) > 10, 'the table of click handlers is there');
  assert.ok(vm.runInContext('Object.values(ACTIONS).every((h) => typeof h === "function")', ctx), 'every entry is a function');
  assert.equal(vm.runInContext('JUDGED_CMDS.join()', ctx), 'flow-commit,flow-commit-unstage,flow-pr,flow-base,flow-base-stash');
});
