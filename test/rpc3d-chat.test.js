'use strict';
// RPC3d (S3): the chat of the page and its composer live in public/chat.js, between tabs.js and app.js. Like the other page files it shares the global scope and uses
// S, V, R, $ and draw only when a function is called. The ONE thing that does not move is what runs at load and needs $ from app.js: the two wireSeparator calls and the
// resize listener stay in app.js (which loads last). The block that reads the saved layout from localStorage moves with its constant: it only needs localStorage and has a catch.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { PUBLIC, APP_FILES } = require('./pagesrc.js');

const read = (f) => fs.readFileSync(path.join(PUBLIC, f), 'utf8').replace(/\r\n/g, '\n');
const MOVED = ['CHAT_MS', 'chatUrl', 'chatShown', 'LAYOUT_KEY', 'COLUMN_FROM', 'layoutRatios', 'chatCtl', 'loadChat', 'openChat', 'closeChat', 'chatTick', 'loadTasks', 'loadChanges',
  'loadFiles', 'loadFile', 'NOTES_MS', 'padOf', 'padDirty', 'loadNotes', 'saveNotes', 'flushNotes', 'notesInput', 'setChatTab', 'columnOn', 'layoutNow', 'applyLayout', 'setBlocks',
  'resetLayout', 'padShown', 'drawChat', 'wireSeparator', 'saveDraft', 'prunePending', 'sendingNow', 'composerOf', 'sayNote', 'setRpc', 'rpcNeedsStart', 'ensureRpcStarted',
  'sendChatMessage'];
const esc = (n) => n.replace(/\$/g, '\\$');
const defines = (src, name) => new RegExp(`^(async function ${esc(name)}\\b|function ${esc(name)}\\b|const ${esc(name)} =|let ${esc(name)}\\b)`, 'm').test(src);
const LOAD_TIME = [/^wireSeparator\(\$\('#split'\)/m, /^wireSeparator\(\$\('#split2'\)/m, /^if \(window\.addEventListener\) window\.addEventListener\('resize', applyLayout\);/m];

test('chat.js defines the chat and the composer and app.js defines none of it', () => {
  const chat = read('chat.js');
  for (const n of MOVED) assert.equal(defines(chat, n), true, `chat.js defines ${n}`);
  const app = read('app.js');
  for (const n of MOVED) assert.equal(defines(app, n), false, `app.js no longer defines ${n}`);
  for (const n of ['S', 'TOKEN', 'paint', 'draw']) assert.equal(defines(app, n), true, `app.js keeps ${n}`);
});

test('what runs at load and needs $ stays in app.js, and chat.js has none of it', () => {
  const chat = read('chat.js');
  const app = read('app.js');
  for (const re of LOAD_TIME) {
    assert.match(app, re, `app.js keeps ${re}`);
    assert.doesNotMatch(chat, re, `chat.js has no ${re}`);
  }
  assert.ok(app.indexOf('wireSeparator($(\'#split\')') > app.indexOf('const S = {'), 'the separators are wired after S exists');
});

test('chat.js sits between tabs.js and app.js, and index.html loads the scripts as listed', () => {
  const at = (f) => APP_FILES.indexOf(f);
  assert.ok(at('tabs.js') >= 0 && at('chat.js') > at('tabs.js') && at('app.js') > at('chat.js'), JSON.stringify(APP_FILES));
  assert.equal(APP_FILES[APP_FILES.length - 1], 'app.js');
  const scripts = [...read('index.html').matchAll(/<script src="([^"]+)"><\/script>/g)].map((m) => m[1]);
  assert.deepEqual(scripts, ['/view.js', '/resumen.js', ...APP_FILES.map((f) => `/${f}`)]);
});

test('chat.js loads after data.js, feed.js and tabs.js as a separate script, reads the saved layout and touches no S, V, R or document', () => {
  const ctx = vm.createContext({
    console, window: {},
    localStorage: { getItem: (k) => (k === 'repo-panel.layout' ? '{"list":0.3,"col":0.2,"junk":5}' : null) },
    document: new Proxy({}, { get: () => { throw new Error('a page script touched the document while loading'); } }),
  });
  ctx.window = ctx;
  for (const f of ['data.js', 'feed.js', 'tabs.js', 'chat.js']) assert.doesNotThrow(() => vm.runInContext(read(f), ctx), f);
  for (const n of ['loadChat', 'openChat', 'drawChat', 'sendChatMessage', 'ensureRpcStarted', 'applyLayout', 'setBlocks', 'wireSeparator', 'loadNotes']) assert.equal(vm.runInContext(`typeof ${n}`, ctx), 'function', n);
  assert.deepEqual(JSON.parse(vm.runInContext('JSON.stringify(layoutRatios)', ctx)), { list: 0.3, col: 0.2 });
  assert.equal(vm.runInContext('CHAT_MS', ctx), 5000);
  assert.equal(vm.runInContext('chatShown', ctx), null);
});
