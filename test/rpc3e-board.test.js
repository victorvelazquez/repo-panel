'use strict';
// RPC3e (S3): the board of the page (the cards, the columns, draw and render) lives in public/board.js, between chat.js and app.js. Like the other page files it shares the
// global scope and uses S, V, R, $ and draw only when a function is called. What does not move is what runs at load: the three pointer listeners (pointerdown, pointerup,
// pointercancel) stay in app.js, which loads last; their handlers (pressedAt, releasePress) live in board.js and are only reached when the pointer moves.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { PUBLIC, LIB_FILES, APP_FILES } = require('./pagesrc.js');

const read = (f) => fs.readFileSync(path.join(PUBLIC, f), 'utf8').replace(/\r\n/g, '\n');
const MOVED = ['raf', 'draw', 'PRESS_MAX_MS', 'pressedAt', 'renderWaiting', 'pressHeld', 'releasePress', 'COLUMNS', 'COLUMN_BY_KEY', 'BOARD_KEYS', 'cleanAsColumn', 'boardKeys',
  'isProblem', 'sortPrCards', 'placement', 'verdictOf', 'buildCards', 'snoozedRow', 'snoozedBlock', 'render', 'idleBar', 'setPref', 'GROUP_HUES', 'groupTag',
  'repoName', 'removeItem', 'piBtn', 'moreMenu', 'reqWarn', 'hasRoadmapBlock', 'stateRow', 'roomTag', 'showGroupTag', 'identityHtml', 'branchLabel', 'cardTop', 'roadmapBlock',
  'cleanRow', 'animStyle', 'verdictRow', 'stagedBar', 'COMMIT_CMDS', 'flowFor', 'repoCard', 'checksChip', 'FIX_PR_HINT', 'prCard'];
const esc = (n) => n.replace(/\$/g, '\\$');
const defines = (src, name) => new RegExp(`^(async function ${esc(name)}\\b|function ${esc(name)}\\b|const ${esc(name)} =|let ${esc(name)}\\b)`, 'm').test(src);
const LOAD_TIME = [/^document\.addEventListener\('pointerdown'/m, /^document\.addEventListener\('pointerup', releasePress/m, /^document\.addEventListener\('pointercancel', releasePress/m];

test('board.js defines the board and app.js defines none of it', () => {
  const board = read('board.js');
  for (const n of MOVED) assert.equal(defines(board, n), true, `board.js defines ${n}`);
  const app = read('app.js');
  for (const n of MOVED) assert.equal(defines(app, n), false, `app.js no longer defines ${n}`);
  for (const n of ['S', 'TOKEN', 'paint']) assert.equal(defines(app, n), true, `app.js keeps ${n}`);
  assert.equal(defines(read('chat.js'), 'loadChat'), true, 'chat.js keeps its own chat');
});

test('the pointer listeners that run at load stay in app.js, and board.js has none of them', () => {
  const board = read('board.js');
  const app = read('app.js');
  for (const re of LOAD_TIME) {
    assert.match(app, re, `app.js keeps ${re}`);
    assert.doesNotMatch(board, re, `board.js has no ${re}`);
  }
  assert.ok(app.indexOf("document.addEventListener('pointerdown'") > app.indexOf('const S = {'), 'the listeners are wired after S exists');
});

test('board.js sits between chat.js and app.js, and index.html loads the scripts as listed', () => {
  const at = (f) => APP_FILES.indexOf(f);
  assert.ok(at('chat.js') >= 0 && at('board.js') > at('chat.js') && at('app.js') > at('board.js'), JSON.stringify(APP_FILES));
  assert.equal(APP_FILES[APP_FILES.length - 1], 'app.js');
  const scripts = [...read('index.html').matchAll(/<script src="([^"]+)"><\/script>/g)].map((m) => m[1]);
  assert.deepEqual(scripts, [...LIB_FILES, ...APP_FILES].map((f) => `/${f}`));
});

test('board.js loads after the other four as a separate script and touches no S, V, R or document', () => {
  const ctx = vm.createContext({
    console, window: {}, localStorage: { getItem: () => null },
    document: new Proxy({}, { get: () => { throw new Error('a page script touched the document while loading'); } }),
  });
  ctx.window = ctx;
  for (const f of ['data.js', 'feed.js', 'tabs.js', 'chat.js', 'board.js']) assert.doesNotThrow(() => vm.runInContext(read(f), ctx), f);
  for (const n of ['draw', 'render', 'repoCard', 'prCard', 'buildCards', 'cleanRow', 'releasePress', 'verdictOf', 'piBtn']) assert.equal(vm.runInContext(`typeof ${n}`, ctx), 'function', n);
  assert.equal(vm.runInContext('COLUMNS.length', ctx), 6);
  assert.equal(vm.runInContext('Object.keys(COLUMN_BY_KEY).join()', ctx), 'attention,clean,changes,committed,prs,merged');
  assert.equal(vm.runInContext('BOARD_KEYS.join()', ctx), 'changes,committed,prs,merged');
  assert.equal(vm.runInContext('pressedAt + raf', ctx), 0);
});
