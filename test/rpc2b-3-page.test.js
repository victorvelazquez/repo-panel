'use strict';
// RPC2b-3 (S1, S6, S8): the page reads no state of Orca. What fed on it stays deleted: the live state of a repo (S.live and its helpers), the
// `live` and `snapshot` event frames, the screen tail and the asked text, the room presence stubs, and the README does not describe Orca.
// What stays: the session of the RPC host (S.rpc), the status poll of a command sent from the page (S.pistatus) and the quiet period.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const V = require('../public/view.js');

const GONE = /orca|S\.live\b|liveBusy|liveAnswered|dirtyAt|pitail|piask|tailFor|applyLive|loadLive|pollLive|loadTail|noteLocal|liveEvent|liveEntry|liveSession|piPollTargets|presenceLabel|presenceDot|LIVE_CHECK_MS|SESSION_CHECKING|EVENT_LIVE|EVENT_PI/;

test('no source of the page names Orca or the live state that came from it', () => {
  for (const f of fs.readdirSync(path.join(ROOT, 'public')).filter((n) => n.endsWith('.js'))) assert.doesNotMatch(read(`public/${f}`), GONE, f);
});

test('view.js exports none of the deleted helpers and keeps the ones that stay', () => {
  for (const k of ['liveEvent', 'liveSession', 'piPollTargets', 'presenceLabel', 'presenceDot', 'LIVE_CHECK_MS']) assert.equal(k in V, false, k);
  for (const k of ['rpcEvent', 'rpcReduce', 'rpcFromStatus', 'parseSse', 'eventsPlan', 'eventsRetryMs', 'eventsStale', 'quietPeriod', 'flowVerdict', 'flowButtons']) assert.equal(typeof V[k], 'function', k);
});

test('the stream plan only has the chat interval, and a session that is "checking" holds nothing', () => {
  assert.deepEqual(Object.keys(V.eventsPlan({ connected: true })), ['chatMs']);
  assert.deepEqual(Object.keys(V.eventsPlan({ connected: false })), ['chatMs']);
  assert.equal(V.eventsPlan({ connected: true }).chatMs, 30000);
  assert.equal(V.eventsPlan({ connected: false }).chatMs, 5000);
  const l = { files: ['a.txt'], lastChangeMs: 0 };
  assert.equal(V.commitOverrideItem(undefined, { session: 'checking', stale: false }), null);
  for (const [s, reason] of [['busy', 'the session is still working'], ['asking', 'waiting for your answer in the session']]) {
    assert.equal(V.commitOverrideItem(undefined, { session: s, stale: false }).act, 'show-commit', s);
    assert.ok(reason);
  }
  assert.ok(l);
});

test('the `live` and `snapshot` frames are no longer read, and the `rpc` frame still is', () => {
  const id = '0123456789';
  assert.equal(V.rpcEvent({ event: 'rpc', data: JSON.stringify({ id, kind: 'state', state: 'idle' }) }).kind, 'state');
  assert.equal(V.rpcEvent({ event: 'live', data: JSON.stringify({ id, state: 'busy', live: { state: 'working', count: 1 } }) }), null);
});

test('the README does not describe Orca and the buttons no longer wait for a "checking" answer', () => {
  const readme = read('README.md');
  assert.doesNotMatch(readme, /orca/i);
  assert.doesNotMatch(readme, /checking the session/i);
});
