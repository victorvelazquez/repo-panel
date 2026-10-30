'use strict';
// RP77b (S68, S71, S72), the page's pure helpers in public/view.js (loaded as V, like the other page tests): parseSse(buffer) -> { events, rest },
// liveEvent(event) -> { id, state, ask, live } | null (a `snapshot` frame gives an array of those), eventsPlan({ connected, lastEventAt, now }) and
// eventsRetryMs(attempt). Pure: no DOM, no network, no timers.
const test = require('node:test');
const assert = require('node:assert/strict');

const V = require('../public/view.js');

const ID = '0123456789';
const LIVE = { state: 'working', count: 1 };
const ev = (data, event = 'live') => ({ event, data: typeof data === 'string' ? data : JSON.stringify(data) });
const good = (over = {}) => ({ id: ID, state: 'busy', live: LIVE, ...over });

test('exports: the four helpers are functions of the view module', () => {
  for (const k of ['parseSse', 'liveEvent', 'eventsPlan', 'eventsRetryMs']) assert.equal(typeof V[k], 'function', k);
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

// ---------- liveEvent ----------
test('liveEvent: a good frame becomes { id, state, ask, live }, the live object untouched (dialog included)', () => {
  const out = V.liveEvent(ev(good()));
  assert.equal(out.id, ID);
  assert.equal(out.state, 'busy');
  assert.ok(out.ask === undefined || out.ask === null);
  assert.deepEqual(out.live, LIVE);
  const dialog = { kind: 'select', title: 'Allow?', choices: ['Yes', 'No'] };
  const asking = V.liveEvent(ev(good({ state: 'asking', ask: 'Allow?', live: { state: 'waiting', count: 1, dialog } })));
  assert.equal(asking.state, 'asking');
  assert.equal(asking.ask, 'Allow?');
  assert.deepEqual(asking.live, { state: 'waiting', count: 1, dialog });
});

test('liveEvent: every piStatus state and every live state is accepted; any other word is not', () => {
  for (const state of ['closed', 'idle', 'busy', 'asking', 'ambiguous', 'unknown']) assert.equal(V.liveEvent(ev(good({ state }))).state, state, state);
  for (const state of ['typed', 'working', 'free', '', 'BUSY', null, 5, undefined]) assert.equal(V.liveEvent(ev(good({ state }))), null, String(state));
  for (const state of ['none', 'free', 'working', 'waiting', 'unknown']) assert.equal(V.liveEvent(ev(good({ live: { state, count: 0 } }))).live.state, state, state);
  for (const state of ['busy', 'idle', 'asking', '', null, 5, undefined]) assert.equal(V.liveEvent(ev(good({ live: { state, count: 0 } }))), null, String(state));
});

test('liveEvent: the id is exactly 10 hex characters', () => {
  for (const id of ['abcdef0123', '0000000000', 'ffffffffff']) assert.equal(V.liveEvent(ev(good({ id }))).id, id);
  for (const id of ['012345678', '01234567890', 'ghijklmnop', '012345678 ', '', null, 1234567890, undefined, ['0123456789']]) assert.equal(V.liveEvent(ev(good({ id }))), null, JSON.stringify(id));
});

test('liveEvent: malformed frames are null (not JSON, not an object, missing live, wrong event name, no frame)', () => {
  for (const data of ['not json', '', '{"id":', '[]', 'null', '5', '"text"', JSON.stringify({ id: ID, state: 'busy' }), JSON.stringify({ id: ID, state: 'busy', live: null }), JSON.stringify({ id: ID, state: 'busy', live: 'free' })]) assert.equal(V.liveEvent(ev(data)), null, data);
  assert.equal(V.liveEvent(ev(good(), 'ping')), null);
  assert.equal(V.liveEvent(ev(good(), 'message')), null);
  assert.equal(V.liveEvent(null), null);
  assert.equal(V.liveEvent(undefined), null);
  assert.equal(V.liveEvent({ event: 'live' }), null);
  assert.equal(V.liveEvent({ event: 'live', data: 42 }), null);
});

test('liveEvent: data of exactly 64 KB is read, one character more is null', () => {
  const sized = (n) => { const base = JSON.stringify(good({ pad: '' })); return JSON.stringify(good({ pad: 'x'.repeat(n - base.length) })); };
  const ok = sized(65536);
  const big = sized(65537);
  assert.equal(ok.length, 65536);
  assert.equal(big.length, 65537);
  assert.equal(V.liveEvent(ev(ok)).id, ID);
  assert.equal(V.liveEvent(ev(big)), null);
});

test('liveEvent on a snapshot frame: an array of the good entries, the malformed ones dropped; not an array is null', () => {
  const a = good({ id: 'aaaaaaaaaa' });
  const b = good({ id: 'bbbbbbbbbb', state: 'idle', live: { state: 'free', count: 1 } });
  const out = V.liveEvent(ev([a, { id: 'zz', state: 'busy', live: LIVE }, b, 'junk', null], 'snapshot'));
  assert.ok(Array.isArray(out));
  assert.deepEqual(out.map((x) => [x.id, x.state, x.live.state]), [['aaaaaaaaaa', 'busy', 'working'], ['bbbbbbbbbb', 'idle', 'free']]);
  assert.deepEqual(V.liveEvent(ev([], 'snapshot')), []);
  for (const data of ['{}', 'null', 'nope', '5']) assert.equal(V.liveEvent(ev(data, 'snapshot')), null, data);
  assert.equal(V.liveEvent(ev(`[${'0,'.repeat(40000)}0]`, 'snapshot')), null, 'a snapshot over 64 KB is refused');
});

test('liveEvent and parseSse together: the exact bytes the hub writes are understood', () => {
  const bytes = `retry: 3000\n\nevent: snapshot\ndata: ${JSON.stringify([good()])}\n\n: ping\n\nevent: live\ndata: ${JSON.stringify(good({ state: 'idle', live: { state: 'free', count: 1 } }))}\n\n`;
  const { events, rest } = V.parseSse(bytes);
  assert.equal(rest, '');
  assert.deepEqual(events.map((e) => e.event), ['snapshot', 'live']);
  assert.equal(V.liveEvent(events[0])[0].id, ID);
  assert.equal(V.liveEvent(events[1]).state, 'idle');
});

// ---------- eventsPlan / eventsRetryMs ----------
test('eventsPlan: connected is a slow safety net (60 s live, 30 s chat); not connected keeps today\'s 10 s and 5 s', () => {
  assert.deepEqual(V.eventsPlan({ connected: true, lastEventAt: 1000, now: 1000 }), { pollLiveMs: 60000, chatMs: 30000 });
  assert.deepEqual(V.eventsPlan({ connected: false, lastEventAt: 1000, now: 1000 }), { pollLiveMs: 10000, chatMs: 5000 });
  assert.deepEqual(V.eventsPlan({ connected: false, lastEventAt: 0, now: 9e12 }), { pollLiveMs: 10000, chatMs: 5000 });
  assert.deepEqual(V.eventsPlan({ connected: false, lastEventAt: null, now: 5 }), { pollLiveMs: 10000, chatMs: 5000 });
});

test('eventsRetryMs: 1000 * 2^attempt, capped at 30000; attempt 0 gives 1000', () => {
  assert.deepEqual([0, 1, 2, 3, 4].map(V.eventsRetryMs), [1000, 2000, 4000, 8000, 16000]);
  assert.deepEqual([5, 6, 10, 50, 1000].map(V.eventsRetryMs), [30000, 30000, 30000, 30000, 30000]);
});
