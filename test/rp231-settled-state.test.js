'use strict';
// RP231: the session is free only when pi is really done. `agent_end` closes one low-level run, but a retry, an overflow recovery or queued work can follow;
// `agent_settled` says pi will not continue by itself (pi docs, json.md "Event sequence"). So: an `agent_end` with `willRetry: true` keeps the session busy and
// fixes no outcome; any `agent_end` keeps it busy until `agent_settled` (or a fallback timer, for a pi that never sends it); and a `get_state` that fails is asked
// again instead of leaving the last value for ever.
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createRpcClient } = require('../server/rpc.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 2000) => { const end = Date.now() + ms; while (Date.now() < end) { const v = fn(); if (v) return v; await sleep(5); } throw new Error('timed out waiting'); };

function fakeChild() {
  const c = new EventEmitter();
  c.pid = 4243;
  c.stdout = new EventEmitter();
  c.writes = [];
  c.stdin = Object.assign(new EventEmitter(), { write(s) { c.writes.push(s); return true; }, end() {} });
  c.kill = () => {};
  c.said = (obj) => c.stdout.emit('data', `${JSON.stringify(obj)}\n`);
  c.sent = () => c.writes.join('').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  c.stateAsks = () => c.sent().filter((m) => m.type === 'get_state');
  return c;
}
async function ready(t, opts = {}) {
  const child = fakeChild();
  const spawn = (file) => (file === 'taskkill' ? new EventEmitter() : child);
  const client = createRpcClient({ command: 'C:\\x\\pi.exe', args: [], cwd: '.', env: {}, spawn, platform: 'win32', graceMs: 50, killWaitMs: 50, ...opts }); // RP238: a short grace, the fake never exits by itself
  t.after(() => client.close());
  const started = client.start();
  await until(() => child.sent().length >= 1);
  child.said({ id: child.sent()[0].id, type: 'response', command: 'get_state', success: true, data: { isStreaming: false } });
  await started;
  return { child, client };
}
// Answers the newest get_state the client sent, once it is sent.
async function answerState(child, isStreaming, n) {
  await until(() => child.stateAsks().length >= n);
  const ask = child.stateAsks()[n - 1];
  child.said({ id: ask.id, type: 'response', command: 'get_state', success: true, data: { isStreaming } });
}

test('s1: an agent_end that will retry keeps the session busy, asks nothing and fixes no outcome', async (t) => {
  const { child, client } = await ready(t);
  child.said({ type: 'agent_start' });
  child.said({ type: 'turn_end', stopReason: 'error' });
  child.said({ type: 'agent_end', willRetry: true });
  await sleep(30);
  assert.equal(client.state(), 'busy');
  assert.equal(child.stateAsks().length, 1, 'only the get_state of the start: a run that retries is not over');
  assert.equal(client.outcome(), null, 'a failed attempt that pi retries is not a failed task');
});

test('s2: a retry that succeeds ends done, and the session is free only after agent_settled', async (t) => {
  const { child, client } = await ready(t);
  child.said({ type: 'agent_start' });
  child.said({ type: 'turn_end', stopReason: 'error' });
  child.said({ type: 'agent_end', willRetry: true });
  child.said({ type: 'auto_retry_start', attempt: 1, maxAttempts: 3, delayMs: 10 });
  child.said({ type: 'agent_start' });
  child.said({ type: 'turn_end', stopReason: 'stop' });
  child.said({ type: 'agent_end', willRetry: false });
  await answerState(child, false, 2);
  await sleep(30);
  assert.equal(client.state(), 'busy', 'pi has not settled yet: get_state saying not streaming is not enough');
  child.said({ type: 'agent_settled', aborted: false });
  await answerState(child, false, 3);
  await until(() => client.state() === 'idle');
  assert.equal(client.outcome().kind, 'done');
});

test('s3: a plain agent_end (no willRetry field) still waits for agent_settled', async (t) => {
  const { child, client } = await ready(t);
  child.said({ type: 'agent_start' });
  child.said({ type: 'agent_end' });
  await answerState(child, false, 2);
  await sleep(30);
  assert.equal(client.state(), 'busy');
  child.said({ type: 'agent_settled' });
  await answerState(child, false, 3);
  await until(() => client.state() === 'idle');
});

test('s4: a pi that never sends agent_settled is freed by the fallback timer', async (t) => {
  const { child, client } = await ready(t, { settleMs: 60 });
  child.said({ type: 'agent_start' });
  child.said({ type: 'agent_end' });
  await answerState(child, false, 2);
  assert.equal(client.state(), 'busy');
  await until(() => client.state() === 'idle', 1000);
});

test('s5: a run that will retry gets a much longer fallback than a plain end, so a retry delay never frees it', async (t) => {
  const { child, client } = await ready(t, { settleMs: 40 });
  child.said({ type: 'agent_start' });
  child.said({ type: 'agent_end', willRetry: true });
  await sleep(100);
  assert.equal(client.state(), 'busy', 'past the plain fallback, still waiting for the retry');
  assert.equal(child.stateAsks().length, 1, 'the retry fallback has not run out: nothing was read again');
});

test('s5b: a retry that never comes back (no agent_start, no agent_settled) is freed by its long fallback, not busy for ever', async (t) => {
  const { child, client } = await ready(t, { settleMs: 40 });
  child.said({ type: 'agent_start' });
  child.said({ type: 'agent_end', willRetry: true });
  await until(() => child.stateAsks().length >= 2, 2000);
  child.said({ id: child.stateAsks()[1].id, type: 'response', command: 'get_state', success: true, data: { isStreaming: false } });
  await until(() => client.state() === 'idle', 2000);
});

test('s5c: the retry delay pi announces stretches the fallback', async (t) => {
  const { child, client } = await ready(t, { settleMs: 20 });
  child.said({ type: 'agent_start' });
  child.said({ type: 'agent_end', willRetry: true });
  child.said({ type: 'auto_retry_start', attempt: 1, maxAttempts: 3, delayMs: 300 });
  await sleep(200);
  assert.equal(client.state(), 'busy', 'the announced delay has not passed yet');
  assert.equal(child.stateAsks().length, 1);
});

test('s13: the fallback does not free a session while pi is compacting after a run', async (t) => {
  const { child, client } = await ready(t, { settleMs: 40 });
  child.said({ type: 'agent_start' });
  child.said({ type: 'agent_end', willRetry: false });
  child.said({ type: 'compaction_start', reason: 'threshold' });
  await answerState(child, false, 2);
  await sleep(150);
  assert.equal(client.state(), 'busy', 'still compacting: pi has more work for this run');
  child.said({ type: 'compaction_end', reason: 'threshold' });
  await until(() => child.stateAsks().length >= 3, 1000);
  child.said({ id: child.stateAsks()[2].id, type: 'response', command: 'get_state', success: true, data: { isStreaming: false } });
  await until(() => client.state() === 'idle', 1000);
});

test('s14: a client that starts while pi is already working keeps it busy until agent_settled', async (t) => {
  const child = fakeChild();
  const spawn = (file) => (file === 'taskkill' ? new EventEmitter() : child);
  const client = createRpcClient({ command: 'C:\\x\\pi.exe', args: [], cwd: '.', env: {}, spawn, platform: 'win32', graceMs: 50, killWaitMs: 50 });
  t.after(() => client.close());
  const started = client.start();
  await until(() => child.sent().length >= 1);
  child.said({ id: child.sent()[0].id, type: 'response', command: 'get_state', success: true, data: { isStreaming: true } });
  await started;
  child.said({ type: 'turn_end', stopReason: 'error' });
  child.said({ type: 'agent_end', willRetry: true });
  child.said({ type: 'agent_settled', aborted: false });
  await answerState(child, false, 2);
  await until(() => client.state() === 'idle');
  assert.equal(client.outcome().kind, 'failed', 'the run it joined counts as a run');
});

test('s15: no timer reads the state after the client is closed', async (t) => {
  const { child, client } = await ready(t, { settleMs: 20, refreshRetryMs: 10 });
  child.said({ type: 'agent_start' });
  child.said({ type: 'agent_end' });
  await until(() => child.stateAsks().length >= 2);
  client.close();
  const n = child.sent().length;
  await sleep(120);
  assert.equal(child.sent().length, n);
});

test('s6: an outcome that agent_end already fixed is not overwritten by agent_settled (the rule of RP228)', async (t) => {
  const { child, client } = await ready(t);
  child.said({ type: 'agent_start' });
  child.said({ type: 'turn_end', stopReason: 'stop' });
  child.said({ type: 'agent_end', willRetry: false });
  await until(() => client.outcome());
  const first = client.outcome();
  child.said({ type: 'agent_settled', aborted: true });
  await sleep(20);
  assert.deepEqual(client.outcome(), first);
});

test('s6b: a settled with no run before it creates no outcome', async (t) => {
  const { child, client } = await ready(t);
  child.said({ type: 'agent_settled', aborted: true });
  await sleep(20);
  assert.equal(client.outcome(), null);
});

test('s7: a retry that is stopped by hand ends stopped', async (t) => {
  const { child, client } = await ready(t);
  child.said({ type: 'agent_start' });
  child.said({ type: 'turn_end', stopReason: 'error' });
  child.said({ type: 'agent_end', willRetry: true });
  child.said({ type: 'agent_settled', aborted: true });
  await until(() => client.outcome() && client.outcome().kind === 'stopped');
});

test('s8: a retry that gives up ends failed', async (t) => {
  const { child, client } = await ready(t);
  child.said({ type: 'agent_start' });
  child.said({ type: 'turn_end', stopReason: 'error' });
  child.said({ type: 'agent_end', willRetry: true });
  child.said({ type: 'auto_retry_end', attempt: 3, success: false });
  child.said({ type: 'agent_settled', aborted: false });
  await until(() => client.outcome() && client.outcome().kind === 'failed');
});

test('s9: a get_state that fails after the run settled is asked again, and the session ends free', async (t) => {
  const { child, client } = await ready(t, { refreshRetryMs: 10 });
  child.said({ type: 'agent_start' });
  child.said({ type: 'agent_settled' });
  await until(() => child.stateAsks().length >= 2);
  child.said({ id: child.stateAsks()[1].id, type: 'response', command: 'get_state', success: false, error: 'boom' });
  await answerState(child, false, 3);
  await until(() => client.state() === 'idle');
});

test('s10: when every get_state after agent_settled fails, the session still ends free (pi said it is done)', async (t) => {
  const { child, client } = await ready(t, { refreshRetryMs: 10, refreshRetries: 2 });
  child.said({ type: 'agent_start' });
  child.said({ type: 'agent_settled' });
  for (let n = 2; n <= 4; n++) {
    await until(() => child.stateAsks().length >= n);
    child.said({ id: child.stateAsks()[n - 1].id, type: 'response', command: 'get_state', success: false, error: 'boom' });
  }
  await until(() => client.state() === 'idle');
  await sleep(40);
  assert.equal(child.stateAsks().length, 4, 'one ask and two retries, then it stops asking');
});

test('s11: a failed get_state while pi still works does not free the session', async (t) => {
  const { child, client } = await ready(t, { refreshRetryMs: 10, refreshRetries: 1 });
  child.said({ type: 'agent_start' });
  child.said({ type: 'agent_end', willRetry: false });
  for (let n = 2; n <= 3; n++) {
    await until(() => child.stateAsks().length >= n);
    child.said({ id: child.stateAsks()[n - 1].id, type: 'response', command: 'get_state', success: false, error: 'boom' });
  }
  await sleep(40);
  assert.equal(client.state(), 'busy', 'not settled yet, so a failed read keeps it busy');
});

test('s12: a new run after a settled one is busy again and clears the old outcome', async (t) => {
  const { child, client } = await ready(t);
  child.said({ type: 'agent_start' });
  child.said({ type: 'agent_end' });
  await answerState(child, false, 2);
  child.said({ type: 'agent_settled' });
  await answerState(child, false, 3);
  await until(() => client.state() === 'idle');
  child.said({ type: 'agent_start' });
  assert.equal(client.state(), 'busy');
  assert.equal(client.outcome(), null);
});
