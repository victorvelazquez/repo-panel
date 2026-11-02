'use strict';
// RPC2-1 (S1), found by running the REAL pi through the panel: starting a session took from 4 s to more than 60 s with no pattern, so the cap
// grows to two minutes and a start that ran out of time says so (504) instead of looking like a failure to launch (502). The stream also stops
// publishing the thinking and tool-call deltas, which the page does not use.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createRpcHost } = require('../server/rpchost.js');
const { RpcError, START_MS } = require('../server/rpc.js');

const ACTIVE = { id: 'gentle-shell', command: 'C:\\L\\gentle-shell.exe', agentDir: 'C:\\a' };
const repoOf = (id) => ({ id, path: 'C:\\repos\\alpha' });
function hostWith(client = {}) {
  const made = [];
  const published = [];
  const createClient = (opts) => {
    const c = { opts, start: async () => ({}), request: async () => ({}), answerDialog: () => false, pendingDialogs: () => [], state: () => 'idle', close() {}, ...client };
    made.push(c);
    return c;
  };
  const host = createRpcHost({ resolve: async () => ({ active: ACTIVE }), repoOf, publish: (id, p) => published.push(p), createClient, adoptedOf: () => null });
  return { host, made, published };
}

test('t1: the default start cap is two minutes (the real pi took 4 s to over 60 s to start)', () => {
  assert.equal(START_MS, 120000);
});

test('t2: a start that ran out of time answers 504 with a fixed message; any other failure stays 502 and never echoes the raw error', async () => {
  const slow = hostWith({ start: async () => { throw new RpcError('The session did not start in time'); } });
  await assert.rejects(slow.host.start('aaa'), (e) => e.status === 504 && e.message === 'The session did not start in time');
  const broken = hostWith({ start: async () => { throw new Error('C:\\secret\\path exploded'); } });
  await assert.rejects(broken.host.start('aaa'), (e) => e.status === 502 && e.message === 'The session could not be started' && !/secret/.test(e.message));
  const exited = hostWith({ start: async () => { throw new RpcError('The session ended'); } });
  await assert.rejects(exited.host.start('aaa'), (e) => e.status === 502 && e.message === 'The session could not be started');
});

test('t3: a session that failed to start leaves no live client, so the next start launches again', async () => {
  let fail = true;
  const h = hostWith({ start: async () => { if (fail) throw new RpcError('The session did not start in time'); return {}; } });
  await assert.rejects(h.host.start('aaa'));
  fail = false;
  await h.host.start('aaa');
  assert.equal(h.made.length, 2, 'a second client was created');
});

test('t4: thinking and tool-call deltas are not published (only the text blocks carry their delta and content)', async () => {
  const h = hostWith();
  await h.host.start('aaa');
  const emit = (a) => h.made[0].opts.onEvent({ kind: 'event', record: { type: 'message_update', assistantMessageEvent: a } });
  emit({ type: 'thinking_delta', contentIndex: 0, delta: 'private reasoning' });
  emit({ type: 'toolcall_delta', contentIndex: 1, delta: '{"path":"C:\\\\secret.txt","content":"big"}' });
  emit({ type: 'toolcall_end', contentIndex: 1, toolCall: { id: 'x', name: 'write', arguments: { content: 'big' } } });
  emit({ type: 'text_delta', contentIndex: 2, delta: 'OK' });
  emit({ type: 'text_end', contentIndex: 2, content: 'OK' });
  const got = h.published.filter((p) => p.kind === 'event').map((p) => p.record.assistantMessageEvent);
  assert.deepEqual(got, [
    { type: 'thinking_delta', contentIndex: 0 },
    { type: 'toolcall_delta', contentIndex: 1 },
    { type: 'toolcall_end', contentIndex: 1 },
    { type: 'text_delta', contentIndex: 2, delta: 'OK' },
    { type: 'text_end', contentIndex: 2, content: 'OK' },
  ]);
  assert.equal(JSON.stringify(h.published).includes('private reasoning'), false);
  assert.equal(JSON.stringify(h.published).includes('secret.txt'), false);
});
