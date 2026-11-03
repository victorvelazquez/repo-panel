'use strict';
// RP77b (S68, S71, S72), the page's pure helpers in public/view.js (loaded as V, like the other page tests): parseSse(buffer) -> { events, rest },
// eventsPlan({ connected, lastEventAt, now }) and
// eventsRetryMs(attempt). Pure: no DOM, no network, no timers.
const test = require('node:test');
const assert = require('node:assert/strict');

const V = require('../public/view.js');


test('exports: the three helpers are functions of the view module', () => {
  for (const k of ['parseSse', 'eventsPlan', 'eventsRetryMs']) assert.equal(typeof V[k], 'function', k);
});

// ---------- parseSse ----------
test('parseSse: one frame, then nothing left', () => {
  assert.deepEqual(V.parseSse('event: live\ndata: {"a":1}\n\n'), { events: [{ event: 'live', data: '{"a":1}' }], rest: '' });
  assert.deepEqual(V.parseSse(''), { events: [], rest: '' });
});

test('parseSse: frames split by CRLF blank lines too, and two frames in one buffer keep their order', () => {
  assert.deepEqual(V.parseSse('event: live\r\ndata: 1\r\n\r\nevent: snapshot\r\ndata: 2\r\n\r\n'), { events: [{ event: 'live', data: '1' }, { event: 'snapshot', data: '2' }], rest: '' });
  assert.deepEqual(V.parseSse('event: a\ndata: 1\n\nevent: b\ndata: 2\n\n').events.map((e) => e.event), ['a', 'b']);
});

test('parseSse: an incomplete trailing frame stays in rest, byte for byte', () => {
  assert.deepEqual(V.parseSse('event: a\ndata: 1\n\nevent: b\ndata: 2'), { events: [{ event: 'a', data: '1' }], rest: 'event: b\ndata: 2' });
  assert.deepEqual(V.parseSse('event: a\ndata: 1\n'), { events: [], rest: 'event: a\ndata: 1\n' });
  assert.deepEqual(V.parseSse('event: a\ndata: 1\r\n\r'), { events: [], rest: 'event: a\ndata: 1\r\n\r' });
});

test('parseSse: feeding the buffer in two pieces at EVERY split point gives the same events', () => {
  const whole = ': ping\n\nevent: live\r\ndata: {"id":"x"}\r\n\r\nretry: 3000\n\nevent: snapshot\ndata: a\ndata: b\n\n';
  const want = V.parseSse(whole);
  assert.equal(want.events.length, 2);
  for (let i = 0; i <= whole.length; i++) {
    const first = V.parseSse(whole.slice(0, i));
    const second = V.parseSse(first.rest + whole.slice(i));
    assert.deepEqual([...first.events, ...second.events], want.events, `split at ${i}`);
    assert.equal(second.rest, '', `split at ${i}`);
  }
});

test('parseSse: comment lines (heartbeat) are ignored, alone or inside a frame; a retry-only frame gives no event', () => {
  assert.deepEqual(V.parseSse(': ping\n\n'), { events: [], rest: '' });
  assert.deepEqual(V.parseSse('retry: 3000\n\n'), { events: [], rest: '' });
  assert.deepEqual(V.parseSse('event: live\n: a comment\ndata: 1\n\n').events, [{ event: 'live', data: '1' }]);
});

test('parseSse: multi-line data is joined with LF; only ONE space after the colon is dropped', () => {
  assert.deepEqual(V.parseSse('event: x\ndata: a\ndata: b\ndata: c\n\n').events, [{ event: 'x', data: 'a\nb\nc' }]);
  assert.deepEqual(V.parseSse('event: x\ndata:tight\n\n').events[0].data, 'tight');
  assert.deepEqual(V.parseSse('event: x\ndata:  two\n\n').events[0].data, ' two');
  assert.deepEqual(V.parseSse('event: x\ndata: a\ndata:\n\n').events[0].data, 'a\n');
});

test('parseSse: a frame with no data gives no event (event line alone); a data frame without event is named `message`', () => {
  assert.deepEqual(V.parseSse('event: live\n\n'), { events: [], rest: '' });
  assert.deepEqual(V.parseSse('data: 1\n\n').events, [{ event: 'message', data: '1' }]);
});

// ---------- eventsPlan / eventsRetryMs ----------
test('eventsPlan: connected is a slow safety net for the chat (30 s); not connected polls it every 5 s', () => {
  assert.deepEqual(V.eventsPlan({ connected: true, lastEventAt: 1000, now: 1000 }), { chatMs: 30000 });
  assert.deepEqual(V.eventsPlan({ connected: false, lastEventAt: 1000, now: 1000 }), { chatMs: 5000 });
  assert.deepEqual(V.eventsPlan({ connected: false, lastEventAt: 0, now: 9e12 }), { chatMs: 5000 });
  assert.deepEqual(V.eventsPlan({ connected: false, lastEventAt: null, now: 5 }), { chatMs: 5000 });
});

test('eventsRetryMs: 1000 * 2^attempt, capped at 30000; attempt 0 gives 1000', () => {
  assert.deepEqual([0, 1, 2, 3, 4].map(V.eventsRetryMs), [1000, 2000, 4000, 8000, 16000]);
  assert.deepEqual([5, 6, 10, 50, 1000].map(V.eventsRetryMs), [30000, 30000, 30000, 30000, 30000]);
});
