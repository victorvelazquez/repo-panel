'use strict';
// RPC2b-2 (S1, S6, S8): the server reads no terminal and no screen. What was deleted stays deleted: the three modules, the screen parsers of
// lib.js, the scan of pi.js and the live helpers of sessions.js, and the server sources never name the program they used to call.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

test('the warmer, the watcher and the case recorder modules are gone', () => {
  for (const f of ['livewarm.js', 'vigia.js', 'casos.js']) assert.equal(fs.existsSync(path.join(ROOT, 'server', f)), false, f);
});

test('lib.js keeps PI_COMMANDS and none of the screen parsers', () => {
  const lib = require('../lib.js');
  assert.equal(typeof lib.PI_COMMANDS, 'object');
  for (const k of ['normPath', 'terminalsOfWorktree', 'piScreenState', 'piScreenAsk', 'piScreenDialog', 'piDialogChoices', 'piScreenTail', 'piScreenQuestionish', 'piPromptState']) assert.equal(k in lib, false, k);
});

test('pi.js exports only what stays and sessions.js has no live scan', () => {
  assert.deepEqual(Object.keys(require('../server/pi.js')).sort(), ['conditionsOrder', 'fixPrOrder', 'piSend', 'rpcPiStatus', 'sendGuard']);
  const S = require('../server/sessions.js');
  for (const k of ['liveFromSessions', 'liveOf']) assert.equal(k in S, false, k);
  assert.deepEqual(Object.keys(require('../server.js')).sort(), ['createServer', 'piSend']);
});

test('no server source names the old program or reads a screen', () => {
  const files = ['../server.js', '../lib.js', ...fs.readdirSync(path.join(ROOT, 'server')).map((n) => `../server/${n}`)];
  for (const f of files) assert.doesNotMatch(fs.readFileSync(path.join(__dirname, f), 'utf8'), new RegExp('or' + 'ca|scanSessions|readScreen|piScreen', 'i'), f);
});
