'use strict';
// RP77b (S72), found when reading the page code: a stream whose server went away without closing it would leave the page "connected" and the
// pollers slowed down for good. The server sends a heartbeat every 15 s, so three missed beats (45 s without a byte) mean the stream is dead:
// `eventsStale({ connected, lastByteAt, now })` tells the page to drop it and reconnect. Pure: no DOM, no network, no timers.
const test = require('node:test');
const assert = require('node:assert/strict');

const V = require('../public/view.js');

test('eventsStale is a function of the view module', () => {
  assert.equal(typeof V.eventsStale, 'function');
});

test('a connected stream is stale from 45000 ms without a byte, not before', () => {
  const at = 1000000;
  assert.equal(V.eventsStale({ connected: true, lastByteAt: at, now: at }), false);
  assert.equal(V.eventsStale({ connected: true, lastByteAt: at, now: at + 44999 }), false);
  assert.equal(V.eventsStale({ connected: true, lastByteAt: at, now: at + 45000 }), true);
  assert.equal(V.eventsStale({ connected: true, lastByteAt: at, now: at + 600000 }), true);
});

test('a stream that is not connected is never stale (it is already being retried)', () => {
  assert.equal(V.eventsStale({ connected: false, lastByteAt: 0, now: 1e12 }), false);
});

test('unusable times are not stale: a stream with no byte time or a clock that went backwards is left alone', () => {
  for (const lastByteAt of [undefined, null, NaN, '5', Infinity]) {
    assert.equal(V.eventsStale({ connected: true, lastByteAt, now: 1e12 }), false, String(lastByteAt));
  }
  assert.equal(V.eventsStale({ connected: true, lastByteAt: 1e12, now: 5 }), false);
  assert.equal(V.eventsStale({ connected: true, lastByteAt: 5, now: NaN }), false);
});

test('eventsPlan and eventsRetryMs are unchanged', () => {
  assert.deepEqual(V.eventsPlan({ connected: true }), { pollLiveMs: 60000, chatMs: 30000 });
  assert.deepEqual(V.eventsPlan({ connected: false }), { pollLiveMs: 10000, chatMs: 5000 });
  assert.equal(V.eventsRetryMs(0), 1000);
  assert.equal(V.eventsRetryMs(10), 30000);
});
