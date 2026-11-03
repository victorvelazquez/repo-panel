'use strict';
// The event hub. server/events.js exports createEventHub({ maxClients = 8, heartbeatMs = 15000, maxBuffer, setTimer, clearTimer })
// -> { add(res), size(), emit(event, id, payload), closeAll() }. It stores nothing: add writes only the preamble. A client is a ServerResponse-like object; the tests use a fake that
// records every byte written. Injected timers: no real waiting, no wall clock, no network.
const test = require('node:test');
const assert = require('node:assert/strict');

const hubModule = () => require('../server/events.js');
const createEventHub = (...a) => hubModule().createEventHub(...a);

const PREAMBLE = 'retry: 3000\n\n';

// A fake ServerResponse: `failWith` makes write throw; `closed()` simulates the peer going away.
function fakeRes({ failWith = null } = {}) {
  const handlers = {};
  const res = {
    writes: [], ended: 0, writableEnded: false, destroyed: false,
    write(chunk) { if (res.failWith) throw res.failWith; res.writes.push(String(chunk)); return true; },
    end(chunk) { if (chunk !== undefined) res.writes.push(String(chunk)); res.ended++; res.writableEnded = true; },
    on(ev, fn) { (handlers[ev] = handlers[ev] || []).push(fn); return res; },
    once(ev, fn) { return res.on(ev, fn); },
    closed() { res.destroyed = true; (handlers.close || []).forEach((f) => f()); },
    failWith,
  };
  res.text = () => res.writes.join('');
  res.clear = () => { res.writes.length = 0; };
  return res;
}

function fakeTimers() {
  const t = { pending: null, set: [], cleared: 0, unrefs: 0 };
  t.setTimer = (fn, ms) => { const h = { fn, ms, unref() { t.unrefs++; return h; } }; t.pending = h; t.set.push(ms); return h; };
  t.clearTimer = (h) => { t.cleared++; if (t.pending === h) t.pending = null; };
  t.fire = () => { const h = t.pending; t.pending = null; h.fn(); };
  return t;
}
const hubWith = (over = {}) => { const timers = fakeTimers(); return { timers, hub: createEventHub({ setTimer: timers.setTimer, clearTimer: timers.clearTimer, ...over }) }; };
const frame = (id, payload) => `event: rpc\ndata: ${JSON.stringify({ ...payload, id })}\n\n`;

test('exports: createEventHub returns exactly add, size, emit and closeAll', () => {
  const { hub } = hubWith();
  assert.deepEqual(Object.keys(hub).sort(), ['add', 'closeAll', 'emit', 'size']);
  for (const k of Object.keys(hub)) assert.equal(typeof hub[k], 'function', k);
  assert.equal(hub.size(), 0);
});

test('add: writes the SSE preamble and nothing else (no snapshot); returns true and counts the client', () => {
  const { hub } = hubWith();
  const res = fakeRes();
  assert.equal(hub.add(res), true);
  assert.equal(res.text(), PREAMBLE);
  assert.equal(res.ended, 0);
  assert.equal(hub.size(), 1);
});

test('maxClients: exactly the limit is accepted, one more is refused with nothing written and the count unchanged', () => {
  const { hub } = hubWith({ maxClients: 2 });
  const a = fakeRes();
  const b = fakeRes();
  const c = fakeRes();
  assert.equal(hub.add(a), true);
  assert.equal(hub.add(b), true);
  assert.equal(hub.add(c), false);
  assert.equal(c.writes.length, 0);
  assert.equal(c.ended, 0, 'the caller answers the refused client, the hub does not end it');
  assert.equal(hub.size(), 2);
  hub.emit('rpc', '0123456789', { state: 'idle', live: { state: 'free', count: 1 } });
  assert.equal(c.writes.length, 0, 'a refused client never receives events');
});

test('maxClients defaults to 8: the 8th is accepted, the 9th refused', () => {
  const { hub } = hubWith();
  for (let i = 0; i < 8; i++) assert.equal(hub.add(fakeRes()), true, `client ${i + 1}`);
  const ninth = fakeRes();
  assert.equal(hub.add(ninth), false);
  assert.equal(ninth.writes.length, 0);
  assert.equal(hub.size(), 8);
});

test('a client that closes is removed, gets nothing more, and frees its slot', () => {
  const { hub } = hubWith({ maxClients: 1 });
  const a = fakeRes();
  hub.add(a);
  a.clear();
  a.closed();
  assert.equal(hub.size(), 0);
  hub.emit('rpc', '0123456789', { state: 'idle', live: { state: 'free', count: 1 } });
  assert.equal(a.writes.length, 0);
  const b = fakeRes();
  assert.equal(hub.add(b), true, 'the slot is free again');
  assert.equal(hub.size(), 1);
});

test('a client whose write throws in the middle of an emit is dropped and ended; the others still get the frame', () => {
  const { hub } = hubWith();
  const a = fakeRes();
  const bad = fakeRes();
  const c = fakeRes();
  [a, bad, c].forEach((r) => hub.add(r));
  [a, bad, c].forEach((r) => r.clear());
  bad.failWith = new Error('EPIPE');
  const p = { state: 'busy', live: { state: 'working', count: 1 } };
  assert.doesNotThrow(() => hub.emit('rpc', '0123456789', p));
  assert.equal(a.text(), frame('0123456789', p));
  assert.equal(c.text(), frame('0123456789', p));
  assert.equal(bad.ended, 1);
  assert.equal(hub.size(), 2);
  a.clear(); c.clear();
  hub.emit('rpc', '0123456789', { ...p, state: 'idle' });
  assert.equal(bad.ended, 1, 'a dropped client is not touched again');
  assert.equal(a.writes.length, 1);
  assert.equal(c.writes.length, 1);
});

test('a payload with LF, CRLF and U+2028 inside a string is ONE data line: JSON escapes them', () => {
  const { hub } = hubWith();
  const res = fakeRes();
  hub.add(res);
  res.clear();
  const ask = 'one\ntwo\r\nthree\u2028four\rfive';
  hub.emit('rpc', '0123456789', { state: 'asking', ask, live: { state: 'waiting', count: 1 } });
  const out = res.text();
  assert.ok(out.startsWith('event: rpc\ndata: ') && out.endsWith('}\n\n'));
  assert.deepEqual(out.split('\n'), ['event: rpc', out.split('\n')[1], '', '']);
  assert.ok(!out.includes('\r') && !out.includes('\u2028'));
  assert.equal(JSON.parse(out.split('\n')[1].slice('data: '.length)).ask, ask);
});

test('heartbeat: no timer with 0 clients; ONE unref\'d timer of heartbeatMs with 1 and with 2 clients', () => {
  const { hub, timers } = hubWith();
  hub.emit('rpc', '0123456789', { state: 'idle', live: { state: 'free', count: 1 } });
  assert.deepEqual(timers.set, [], '0 clients, no timer');
  hub.add(fakeRes());
  assert.deepEqual(timers.set, [15000]);
  assert.equal(timers.unrefs, 1);
  hub.add(fakeRes());
  assert.deepEqual(timers.set, [15000], 'the second client does not arm another timer');
});

test('heartbeat: every firing writes `: ping` to ALL clients and re-arms; heartbeatMs is injectable', () => {
  const { hub, timers } = hubWith({ heartbeatMs: 5000 });
  const a = fakeRes();
  const b = fakeRes();
  hub.add(a);
  hub.add(b);
  [a, b].forEach((r) => r.clear());
  assert.deepEqual(timers.set, [5000]);
  timers.fire();
  assert.equal(a.text(), ': ping\n\n');
  assert.equal(b.text(), ': ping\n\n');
  assert.deepEqual(timers.set, [5000, 5000], 're-armed');
  timers.fire();
  assert.equal(a.text(), ': ping\n\n: ping\n\n');
});

test('heartbeat: the timer is cleared when the last client leaves and armed again for the next one; a timer without unref is fine', () => {
  const timers = fakeTimers();
  const hub = createEventHub({ setTimer: (fn, ms) => { timers.set.push(ms); timers.pending = { fn }; return 7; }, clearTimer: (h) => { timers.cleared++; timers.cleared_h = h; } });
  const a = fakeRes();
  const b = fakeRes();
  hub.add(a);
  hub.add(b);
  a.closed();
  assert.equal(timers.cleared, 0, 'one client is still here');
  b.closed();
  assert.equal(timers.cleared, 1);
  assert.equal(timers.cleared_h, 7);
  hub.add(fakeRes());
  assert.deepEqual(timers.set, [15000, 15000]);
});

test('heartbeat: a client whose ping throws is dropped and ended; the other still gets the ping', () => {
  const { hub, timers } = hubWith();
  const good = fakeRes();
  const bad = fakeRes();
  hub.add(good);
  hub.add(bad);
  good.clear();
  bad.failWith = new Error('EPIPE');
  assert.doesNotThrow(() => timers.fire());
  assert.equal(good.text(), ': ping\n\n');
  assert.equal(bad.ended, 1);
  assert.equal(hub.size(), 1);
});

test('closeAll: ends every client once, empties the hub, clears the timer and later emits write nothing', () => {
  const { hub, timers } = hubWith();
  const a = fakeRes();
  const b = fakeRes();
  hub.add(a);
  hub.add(b);
  [a, b].forEach((r) => r.clear());
  hub.closeAll();
  assert.equal(a.ended, 1);
  assert.equal(b.ended, 1);
  assert.equal(hub.size(), 0);
  assert.equal(timers.cleared, 1);
  assert.equal(timers.pending, null);
  hub.emit('rpc', '0123456789', { state: 'idle', live: { state: 'free', count: 1 } });
  assert.equal(a.writes.length + b.writes.length, 0);
  assert.doesNotThrow(() => hub.closeAll(), 'closing an empty hub is fine');
});

test('closeAll then a close event of an ended client does not break the count', () => {
  const { hub } = hubWith();
  const a = fakeRes();
  hub.add(a);
  hub.closeAll();
  a.closed();
  assert.equal(hub.size(), 0);
  assert.equal(hub.add(fakeRes()), true);
  assert.equal(hub.size(), 1);
});

// ---------- verification finding: a client that never reads must not grow the server's memory for ever ----------
test('a client whose socket buffer is over the cap is dropped and ended, on an emit and when it is added; the others keep receiving', () => {
  const hub = createEventHub({ maxBuffer: 1024 });
  const slow = fakeRes();
  slow.writableLength = 0;
  const fine = fakeRes();
  assert.equal(hub.add(slow), true);
  assert.equal(hub.add(fine), true);
  hub.emit('rpc', 'aaaaaaaaaa', { state: 'busy', live: { state: 'working', count: 1 } });
  assert.equal(hub.size(), 2, 'a buffer under the cap is fine');
  slow.writableLength = 1025;
  hub.emit('rpc', 'aaaaaaaaaa', { state: 'idle', live: { state: 'free', count: 1 } });
  assert.equal(hub.size(), 1);
  assert.equal(slow.ended, 1);
  assert.equal(fine.ended, 0);
  assert.match(fine.writes.join(''), /"state":"idle"/);
  const late = fakeRes();
  late.writableLength = 2048;
  assert.equal(hub.add(late), false, 'a client that arrives already over the cap is refused');
  assert.equal(late.ended, 1);
  assert.equal(hub.size(), 1);
});

test('the default cap is 1 MiB: exactly 1048576 bytes buffered stays, one more drops', () => {
  const hub = createEventHub();
  const res = fakeRes();
  res.writableLength = 1048576;
  hub.add(res);
  hub.emit('rpc', 'bbbbbbbbbb', { state: 'busy', live: { state: 'working', count: 1 } });
  assert.equal(hub.size(), 1);
  res.writableLength = 1048577;
  hub.emit('rpc', 'bbbbbbbbbb', { state: 'idle', live: { state: 'free', count: 1 } });
  assert.equal(hub.size(), 0);
});
