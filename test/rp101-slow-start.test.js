'use strict';
// RP101: a slow start of pi no longer ends in a mute error. The person saw "New session" answer 504 twice in a row on a real machine: the server gave up after
// two minutes and the page said "Request timed out". The cap is now five minutes (the page waits a little longer than the server, so the server's answer is the
// one the person sees), and both ways of running out of time say the same plain thing.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { PUBLIC } = require('./pagesrc.js');
const { START_MS } = require('../server/rpc.js');

const read = (f) => fs.readFileSync(path.join(PUBLIC, f), 'utf8').replace(/\r\n/g, '\n');
const dataCtx = () => {
  const ctx = vm.createContext({ console, window: {}, document: new Proxy({}, { get: () => { throw new Error('data.js touched the document while loading'); } }) });
  ctx.window = ctx;
  vm.runInContext(read('data.js'), ctx);
  return ctx;
};

test('t1: the server waits five minutes for pi to start', () => {
  assert.equal(START_MS, 300000);
});

test('t2: the page waits a little longer than the server, so the server answers first (never more than ten seconds longer)', () => {
  const wait = vm.runInContext('START_WAIT_MS', dataCtx());
  assert.ok(wait > START_MS, `the page wait (${wait}) is longer than the server cap (${START_MS})`);
  assert.ok(wait - START_MS <= 10000, 'and not by much');
});

test('t3: both starts (the first message and New session) use that one wait, and no copy of the old 125000 is left', () => {
  for (const f of ['chat.js', 'actions.js']) {
    const src = read(f);
    assert.doesNotMatch(src, /125000/, `${f} keeps no copy of the old wait`);
    const calls = src.match(/api\('\/api\/rpc\/start'[^\n]*/g) || [];
    assert.ok(calls.length >= 1, `${f} starts a session`);
    for (const c of calls) assert.match(c, /timeoutMs: START_WAIT_MS/, `${f}: ${c.slice(0, 60)}`);
  }
});

test('t4: running out of time, on the page or on the server, says the same plain thing; any other failure is kept as it is', () => {
  const ctx = dataCtx();
  const msg = (message) => vm.runInContext(`startError(new Error(${JSON.stringify(message)})).message`, ctx);
  assert.equal(msg('Request timed out'), 'The session did not start in five minutes');
  assert.equal(msg('The session did not start in time'), 'The session did not start in five minutes');
  assert.equal(msg('The session could not be started'), 'The session could not be started');
  assert.equal(msg('This repo already has a session: close it first'), 'This repo already has a session: close it first');
  assert.equal(vm.runInContext('startError(undefined)', ctx), undefined);
});

test('t5: both starts show that message when they fail', () => {
  assert.match(read('chat.js'), /throw startError\(e\)/);
  assert.match(read('actions.js'), /toast\(startError\(e\)\.message, 'bad'\)/);
});

test('t6: nothing in the page or the server still says the start takes up to two minutes', () => {
  for (const f of ['chat.js', 'actions.js']) assert.doesNotMatch(read(f), /two minutes/i, f);
  assert.doesNotMatch(fs.readFileSync(path.join(PUBLIC, '..', 'server', 'rpc.js'), 'utf8'), /Two minutes|two minutes/);
});

test('t7: the README says five minutes', () => {
  const readme = fs.readFileSync(path.join(PUBLIC, '..', 'README.md'), 'utf8');
  assert.match(readme, /five minutes/);
  assert.doesNotMatch(readme, /up to two minutes/);
});
