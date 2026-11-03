'use strict';
// RPC2-1 (S1, S6, S8), the pure part of the page: V.rpcEvent parses a frame of the `rpc` SSE event (total, 64 KB), V.rpcReduce
// keeps what the chat shows of one session, V.rpcFromStatus reads GET /api/rpc/status.
const test = require('node:test');
const assert = require('node:assert/strict');
const V = require('../public/view.js');

const ID = '0123456789';
const frame = (payload, event = 'rpc') => ({ event, data: JSON.stringify(payload) });
const ev = (record) => ({ id: ID, kind: 'event', record });
const delta = (contentIndex, text) => ev({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex, delta: text } });
const run = (payloads, start) => payloads.reduce((acc, p) => { const r = V.rpcReduce(acc.entry, p, 1000); return { entry: r.entry, reloads: acc.reloads + (r.reload ? 1 : 0) }; }, { entry: start, reloads: 0 });

test('e1: rpcEvent returns the payload of a valid rpc frame, for every known kind', () => {
  for (const kind of ['event', 'state', 'dialog', 'dialog-closed', 'exit']) {
    const p = { id: ID, kind, state: 'idle' };
    assert.deepEqual(V.rpcEvent(frame(p)), p, kind);
  }
});

test('e2: rpcEvent is total: other events, garbage, bad ids and unknown kinds are null', () => {
  const bad = [
    null, undefined, 5, 'x', [], {}, { event: 'rpc' }, { event: 'rpc', data: 5 }, { event: 'rpc', data: '{' }, { event: 'rpc', data: 'null' },
    { event: 'rpc', data: '[]' }, { event: 'rpc', data: '"x"' }, frame({ kind: 'event' }), frame({ id: 5, kind: 'event' }), frame({ id: '', kind: 'event' }),
    frame({ id: '__proto__', kind: 'event' }), frame({ id: 'abc', kind: 'event' }), frame({ id: ID, kind: 'nope' }), frame({ id: ID }), frame({ id: ID, kind: 5 }),
    frame({ id: ID, kind: 'state' }, 'live'), frame({ id: ID, kind: 'state' }, 'snapshot'), frame({ id: ID, kind: 'state' }, 'message'),
  ];
  for (const f of bad) assert.equal(V.rpcEvent(f), null, JSON.stringify(f));
});

test('e3: rpcEvent respects the 64 KB limit', () => {
  const pad = (n) => frame({ id: ID, kind: 'event', record: { type: 'x', pad: 'p'.repeat(n) } });
  assert.notEqual(V.rpcEvent(pad(60 * 1024)), null);
  assert.equal(V.rpcEvent(pad(65 * 1024)), null);
});

test('e4: rpcEvent does not read a `live` frame', () => {
  assert.equal(V.rpcEvent({ event: 'live', data: JSON.stringify({ id: ID, state: 'idle', live: { state: 'free' } }) }), null);
});

test('r1: text_delta appends to the block of its contentIndex; two blocks read in order, separated by a blank line', () => {
  const out = run([ev({ type: 'agent_start' }), delta(0, 'Hel'), delta(0, 'lo'), delta(1, 'Second')]);
  assert.deepEqual(out.entry.blocks, ['Hello', 'Second']);
  assert.equal(out.entry.text, 'Hello\n\nSecond');
  assert.equal(out.entry.streaming, true);
  assert.equal(out.entry.startedAt, 1000);
});

test('r2: a thinking block that holds an earlier index does not leave a gap in the text', () => {
  const out = run([ev({ type: 'agent_start' }), ev({ type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', contentIndex: 0, delta: 'hmm' } }), delta(1, 'Answer')]);
  assert.equal(out.entry.text, 'Answer');
});

test('r3: text_end replaces its block with the authoritative content', () => {
  const out = run([ev({ type: 'agent_start' }), delta(0, 'Hel'), ev({ type: 'message_update', assistantMessageEvent: { type: 'text_end', contentIndex: 0, content: 'Hello world' } })]);
  assert.deepEqual(out.entry.blocks, ['Hello world']);
  assert.equal(out.entry.text, 'Hello world');
});

test('r4: agent_start clears the streaming text of the run before', () => {
  const out = run([ev({ type: 'agent_start' }), delta(0, 'old'), ev({ type: 'agent_start' }), delta(0, 'new')]);
  assert.equal(out.entry.text, 'new');
});

test('r5: agent_settled stops streaming and asks for ONE reload; the text stays until the page has the history', () => {
  const out = run([ev({ type: 'agent_start' }), delta(0, 'Hi'), ev({ type: 'agent_settled', aborted: false })]);
  assert.equal(out.reloads, 1);
  assert.equal(out.entry.streaming, false);
  assert.equal(out.entry.text, 'Hi');
  assert.equal(V.rpcReduce(out.entry, ev({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'x' } })).reload, false);
});

test('r6: state sets the state, busy marks the run as streaming; exit closes and drops the text', () => {
  let r = V.rpcReduce(undefined, { id: ID, kind: 'state', state: 'busy' });
  assert.equal(r.entry.state, 'busy');
  assert.equal(r.entry.streaming, true);
  r = V.rpcReduce(r.entry, { id: ID, kind: 'state', state: 'idle' });
  assert.equal(r.entry.state, 'idle');
  r = V.rpcReduce(r.entry, { id: ID, kind: 'state', state: 'bogus' });
  assert.equal(r.entry.state, 'idle', 'an unknown state is ignored');
  r = V.rpcReduce(run([ev({ type: 'agent_start' }), delta(0, 'x')]).entry, { id: ID, kind: 'exit' });
  assert.deepEqual([r.entry.state, r.entry.text, r.entry.streaming, r.reload], ['closed', '', false, false]);
});

test('r7: dialogs add and remove their requestId; the state of an unknown entry starts closed', () => {
  let r = V.rpcReduce(undefined, { id: ID, kind: 'dialog', requestId: 'd1', method: 'confirm' });
  r = V.rpcReduce(r.entry, { id: ID, kind: 'dialog', requestId: 'd2', method: 'select' });
  assert.deepEqual(r.entry.asks.map((a) => a.requestId), ['d1', 'd2']); // RPC2-3: the entries are dialog objects (see rpc2-3-view.test.js)
  r = V.rpcReduce(r.entry, { id: ID, kind: 'dialog-closed', requestId: 'd1' });
  assert.deepEqual(r.entry.asks.map((a) => a.requestId), ['d2']);
  assert.equal(V.rpcReduce(undefined, ev({ type: 'agent_end' })).entry.state, 'closed');
});

test('r8: the reducer is total and never mutates its input; bad indexes and sizes are ignored', () => {
  const start = V.rpcReduce(undefined, ev({ type: 'agent_start' })).entry;
  const copy = JSON.parse(JSON.stringify(start));
  for (const p of [null, 5, {}, { kind: 'event' }, ev(null), ev({}), ev({ type: 'message_update' }), ev({ type: 'message_update', assistantMessageEvent: null }), delta(-1, 'x'), delta(1.5, 'x'), delta(1e9, 'x'), delta('0', 'x'), delta(0, 5)]) {
    const r = V.rpcReduce(start, p);
    assert.equal(r.entry.text, '', JSON.stringify(p));
  }
  assert.deepEqual(start, copy);
  const huge = V.rpcReduce(start, delta(0, 'z'.repeat(300000))).entry;
  assert.ok(huge.text.length <= 200000);
});

test('s1: rpcFromStatus takes the state and the pending dialogs (requestId) of a status answer; a bad answer changes nothing', () => {
  const e = V.rpcFromStatus(undefined, { state: 'asking', pendingDialogs: [{ requestId: 'd1', method: 'confirm' }, { id: 'old' }, null], sessionId: 'panel-x' });
  assert.equal(e.state, 'asking');
  assert.deepEqual(e.asks.map((a) => a.requestId), ['d1']);
  const busy = V.rpcFromStatus(e, { state: 'busy', pendingDialogs: [] });
  assert.deepEqual([busy.state, busy.streaming, busy.asks], ['busy', true, []]);
  const idle = V.rpcFromStatus({ ...busy, text: 'x', blocks: ['x'] }, { state: 'idle', pendingDialogs: [] });
  assert.deepEqual([idle.state, idle.streaming, idle.text], ['idle', false, '']);
  for (const bad of [null, 5, {}, { state: 'nope' }]) assert.equal(V.rpcFromStatus(idle, bad).state, 'idle');
});
