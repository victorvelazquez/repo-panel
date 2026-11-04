'use strict';
// RP98 (S2, S3), the host: host.close(id) stops the pi process of ONE repo and forgets it, also while it is still starting (the races of the unit: a start that was waiting for the runtime, a start whose
// client was created, two starts joined on the same entry, an old exit arriving after a new start), and a closed start never adopts the session. No process is started: the client is a fake that, like the
// real one, fails a pending start when it is closed.
const test = require('node:test');
const assert = require('node:assert/strict');

const { createRpcHost } = require('../server/rpchost.js');

const ACTIVE = { id: 'gentle-shell', command: 'C:\\L\\gentle-shell.cmd', agentDir: 'C:\\Users\\u\\.gentle-shell\\agent' };
const REPOS = { aaa: { id: 'aaa', path: 'C:\\repos\\alpha' }, bbb: { id: 'bbb', path: 'C:\\repos\\beta' }, ccc: { id: 'ccc', path: 'C:\\repos\\gamma' } };
const repoOf = (id) => { if (!REPOS[id]) { const e = new Error('Unknown repository'); e.status = 404; throw e; } return REPOS[id]; };
const gate = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };

function setup({ hold = false, resolveGate = null, max, closeInTheGap = false } = {}) {
  const made = [];
  let hostRef = null;
  const published = [];
  const adopted = [];
  const createClient = (opts) => {
    const g = gate();
    let rejectStart;
    const startP = new Promise((res, rej) => { g.resolve = res; rejectStart = rej; });
    startP.catch(() => {}); // a start nobody waits for (hold: false) must not become an unhandled rejection when the client is closed
    const c = {
      opts, closed: 0, reqs: [], release: () => g.resolve({}),
      // closeInTheGap: the client answers and the repo is closed right after the host's own continuation ran (a thenable queues the close behind it): the start already finished inside the host
      // but `start` has not gone on to adopt yet, which is the gap the second guard covers (a close queued before it would be caught by the first one).
      start: () => (closeInTheGap ? { then(res) { res({}); queueMicrotask(() => { hostRef.close('aaa'); }); } } : hold ? startP : Promise.resolve({})),
      close() { c.closed++; rejectStart(new Error('The session is closed')); },
      request: async (type, fields) => { c.reqs.push([type, fields]); return {}; },
      answerDialog: () => false, pendingDialogs: () => [], state: () => 'idle',
    };
    made.push(c);
    return c;
  };
  const host = createRpcHost({
    resolve: () => (resolveGate ? resolveGate.promise : Promise.resolve({ active: ACTIVE })), repoOf, createClient, adoptedOf: () => null,
    publish: (id, p) => published.push([id, p]), adopt: (id, sid) => adopted.push([id, sid]), ...(max ? { max } : {}),
  });
  hostRef = host;
  return { host, made, published, adopted };
}
const exits = (published, id) => published.filter(([i, p]) => i === id && p.kind === 'exit').length;
const CLOSED = { state: 'closed', pendingDialogs: [], sessionId: null };

test('close stops the pi process of that repo once, forgets it, and answers the closed status', async () => {
  const { host, made } = setup();
  await host.start('aaa');
  assert.equal(host.stateOf('aaa'), 'idle');
  assert.deepEqual(await host.close('aaa'), CLOSED);
  assert.equal(made[0].closed, 1);
  assert.equal(host.stateOf('aaa'), 'closed');
  assert.deepEqual(await host.status('aaa'), CLOSED);
});

test('closing is idempotent: a repo with no live session answers closed, closes nothing and throws nothing; an unknown repo is 404 before anything else', async () => {
  const { host, made } = setup();
  assert.deepEqual(await host.close('aaa'), CLOSED);
  await host.start('aaa');
  await host.close('aaa');
  assert.deepEqual(await host.close('aaa'), CLOSED);
  assert.equal(made[0].closed, 1, 'the second close does not touch the client again');
  await assert.rejects(() => host.close('nope'), (e) => e.status === 404);
});

test('close touches only that repo: the other live sessions keep running', async () => {
  const { host, made } = setup();
  await host.start('aaa');
  await host.start('bbb');
  await host.close('aaa');
  assert.deepEqual([made[0].closed, made[1].closed], [1, 0]);
  assert.deepEqual([host.stateOf('aaa'), host.stateOf('bbb')], ['closed', 'idle']);
});

test('closing frees the slot: with at most one live session another repo can start, and the closed repo can start again with a NEW client', async () => {
  const { host, made } = setup({ max: 1 });
  await host.start('aaa');
  await assert.rejects(() => host.start('bbb'), (e) => e.status === 409);
  await host.close('aaa');
  await host.start('bbb');
  await host.close('bbb');
  await host.start('aaa');
  assert.equal(made.length, 3);
  assert.equal(host.stateOf('aaa'), 'idle');
});

test('closing while the session is still starting: the start fails with a clear 409 (not the generic 502), the client is closed once, nothing is adopted and the repo can start again', async () => {
  const { host, made, adopted } = setup({ hold: true });
  const starting = host.start('aaa');
  await new Promise((r) => setImmediate(r));
  assert.equal(host.stateOf('aaa'), 'starting');
  await host.close('aaa');
  await assert.rejects(starting, (e) => e.status === 409 && /closed/i.test(e.message));
  assert.equal(made[0].closed >= 1, true);
  assert.deepEqual(adopted, []);
  assert.equal(host.stateOf('aaa'), 'closed');
  const again = setup();
  await again.host.start('aaa');
  assert.equal(again.host.stateOf('aaa'), 'idle');
});

test('closing while the host waits for the runtime: the start fails with 409 and no client is ever created for it', async () => {
  const resolveGate = gate();
  const { host, made, adopted } = setup({ resolveGate });
  const starting = host.start('aaa');
  await new Promise((r) => setImmediate(r));
  assert.equal(host.stateOf('aaa'), 'starting');
  await host.close('aaa');
  resolveGate.resolve({ active: ACTIVE });
  await assert.rejects(starting, (e) => e.status === 409);
  assert.equal(made.length, 0, 'no orphan client');
  assert.deepEqual(adopted, []);
  assert.equal(host.stateOf('aaa'), 'closed');
});

test('two starts joined on the same entry both fail with 409 when it is closed; a start that comes after is a fresh session', async () => {
  const resolveGate = gate();
  const { host, made } = setup({ resolveGate });
  const first = host.start('aaa');
  const second = host.start('aaa');
  await new Promise((r) => setImmediate(r));
  await host.close('aaa');
  resolveGate.resolve({ active: ACTIVE });
  await assert.rejects(first, (e) => e.status === 409);
  await assert.rejects(second, (e) => e.status === 409);
  assert.equal(made.length, 0);
  const third = host.start('aaa');
  await third;
  assert.equal(made.length, 1);
  assert.equal(host.stateOf('aaa'), 'idle');
});

test('a start that joins a session that already finished and is closed before it continues fails with 409 like the others, not with a 200 closed status (found by the independent verification)', async () => {
  const { host, adopted } = setup();
  await host.start('aaa');
  const before = adopted.length;
  const joined = host.start('aaa'); // joins the live entry, whose start already finished
  await host.close('aaa'); // and the close lands before the joiner continues
  await assert.rejects(joined, (e) => e.status === 409 && /closed/i.test(e.message));
  assert.equal(adopted.length, before, 'nothing adopted by the joiner');
  assert.equal(host.stateOf('aaa'), 'closed');
});

test('a start that finished is adopted, one that was closed is not: closing right after the client started does not readopt the session', async () => {
  const a = setup();
  await a.host.start('aaa');
  assert.equal(a.adopted.length, 1, 'a normal start adopts');
  const b = setup({ hold: true });
  const starting = b.host.start('aaa');
  await new Promise((r) => setImmediate(r));
  b.made[0].release();
  await b.host.close('aaa'); // the client answered, the close arrives before the start continues
  await assert.rejects(starting, (e) => e.status === 409);
  assert.equal(b.host.stateOf('aaa'), 'closed');
  assert.deepEqual(b.adopted, [], 'a session that was closed is never adopted, so the chat does not come back to it');
});

test('a close that lands in the gap between "the start finished" and "the start adopts" still stops the adoption: the start fails with 409 and nothing is adopted', async () => {
  const { host, adopted } = setup({ closeInTheGap: true });
  await assert.rejects(host.start('aaa'), (e) => e.status === 409);
  assert.deepEqual(adopted, []);
  assert.equal(host.stateOf('aaa'), 'closed');
});

test('the exit of an OLD client never marks a NEW session of the same repo as closed, and with no new session it is published once', async () => {
  const { host, made, published } = setup();
  await host.start('aaa');
  await host.close('aaa');
  made[0].opts.onExit();
  assert.equal(exits(published, 'aaa'), 1, 'the page learns the session ended');
  await host.start('aaa');
  const before = exits(published, 'aaa');
  made[0].opts.onExit(); // the old process reports its exit again, late
  assert.equal(exits(published, 'aaa'), before, 'no exit for the new session');
  assert.equal(host.stateOf('aaa'), 'idle');
});

test('closeAll still closes everything and a later start works', async () => {
  const { host, made } = setup();
  await host.start('aaa');
  await host.start('bbb');
  host.closeAll();
  assert.deepEqual(made.map((c) => c.closed), [1, 1]);
  await host.start('aaa');
  assert.equal(host.stateOf('aaa'), 'idle');
});
