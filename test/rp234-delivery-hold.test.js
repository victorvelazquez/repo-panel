'use strict';
// RP234: the 45 s window against repeated orders is gone. Two orders that arrive together are held apart by a lock that lasts only while one is on its way to
// pi (sendLock), and a delivery order (/flow-ship, /flow-pr, /flow-base, /flow-next and their variants) is refused while the session still has background jobs,
// counted with the same number as the page (RP161). With the session free and no jobs, a Retry goes at once. Put in conditions and Fix PR take only the lock.
const test = require('node:test');
const assert = require('node:assert/strict');

const lib = require('../lib.js');
const { piSend, sendLock } = require('../server/pi.js');

const REPO = { id: 'r1', path: 'C:\\dev\\repo' };
const OTHER = { id: 'r2', path: 'C:\\dev\\other' };
const refuses = (p, status, re) => assert.rejects(p, (e) => e.status === status && re.test(e.message));

// The rpc host's side of a send. `gate` keeps a prompt on its way until `release()`; `fail` makes the next prompt throw.
function fakeHost({ state = 'idle' } = {}) {
  const sent = [];
  const h = { sent, state, fail: false, gates: [] };
  h.status = async () => ({ state: h.state });
  h.prompt = async (id, text) => {
    sent.push(text);
    if (h.fail) { h.fail = false; throw new Error('boom'); }
    if (h.gated) await new Promise((r) => h.gates.push(r));
    return { disposition: 'started' };
  };
  h.release = () => { for (const r of h.gates.splice(0)) r(); };
  return h;
}
const tick = () => new Promise((r) => setImmediate(r));
const requirements = async () => ({ available: true, results: [{ id: 'roadmap', status: 'fail', level: 'required' }] });
const failing = { number: 7, title: 'Fix it', head: 'task', base: 'main', checks: { state: 'failed', items: [{ name: 'test', state: 'failed' }] } };
const prs = async () => ({ repo: {}, prs: [failing] });

// ---------- the lock while an order is on its way ----------
test('lock: a second order to the same repo while the first is on its way is refused, whatever its key, and nothing more is prompted', async () => {
  const lock = sendLock();
  const h = fakeHost();
  h.gated = true;
  const first = piSend(REPO, 'flow-ship', h, undefined, { lock });
  await tick();
  await refuses(piSend(REPO, 'flow-ship', h, undefined, { lock }), 409, /^Another order is on its way to this session: wait for its answer$/);
  await refuses(piSend(REPO, 'flow-pr', h, undefined, { lock }), 409, /^Another order is on its way/);
  await refuses(piSend(REPO, 'put-in-conditions', h, requirements, { lock }), 409, /^Another order is on its way/);
  h.release();
  assert.deepEqual(await first, { sent: true, confirmed: true });
  assert.deepEqual(h.sent, ['/flow-ship']);
});

test('lock: another repo is not held by it', async () => {
  const lock = sendLock();
  const h = fakeHost();
  h.gated = true;
  const first = piSend(REPO, 'flow-ship', h, undefined, { lock });
  await tick();
  h.gated = false;
  assert.deepEqual(await piSend(OTHER, 'flow-ship', h, undefined, { lock }), { sent: true, confirmed: true });
  h.release();
  await first;
  assert.deepEqual(h.sent, ['/flow-ship', '/flow-ship']);
});

test('lock: once pi answered, the same order goes again at once (no 45 s window)', async () => {
  const lock = sendLock();
  const h = fakeHost();
  assert.deepEqual(await piSend(REPO, 'flow-pr', h, undefined, { lock }), { sent: true, confirmed: true });
  assert.deepEqual(await piSend(REPO, 'flow-pr', h, undefined, { lock }), { sent: true, confirmed: true });
  assert.deepEqual(h.sent, ['/flow-pr', '/flow-pr']);
});

test('lock: a prompt that failed frees it, so Retry goes at once', async () => {
  const lock = sendLock();
  const h = fakeHost();
  h.fail = true;
  await refuses(piSend(REPO, 'flow-ship', h, undefined, { lock }), 500, /^The session failed$/);
  assert.deepEqual(await piSend(REPO, 'flow-ship', h, undefined, { lock }), { sent: true, confirmed: true });
  assert.deepEqual(h.sent, ['/flow-ship', '/flow-ship']);
});

test('lock: a refusal before the prompt (busy, not loaded) never takes it', async () => {
  const lock = sendLock();
  const h = fakeHost({ state: 'busy' });
  await refuses(piSend(REPO, 'flow-ship', h, undefined, { lock }), 409, /^The session is busy$/);
  h.state = 'idle';
  h.commandsOf = () => ['flow-pr'];
  await refuses(piSend(REPO, 'flow-ship', h, undefined, { lock }), 409, /is not loaded/);
  assert.deepEqual(await piSend(REPO, 'flow-pr', h, undefined, { lock }), { sent: true, confirmed: true });
  assert.deepEqual(h.sent, ['/flow-pr']);
});

test('lock: without one (an old caller) nothing is refused as a repeat', async () => {
  const h = fakeHost();
  h.gated = true;
  const a = piSend(REPO, 'flow-ship', h);
  const b = piSend(REPO, 'flow-ship', h);
  await tick();
  h.release();
  assert.deepEqual(await Promise.all([a, b]), [{ sent: true, confirmed: true }, { sent: true, confirmed: true }]);
});

// ---------- the refusal while background jobs run ----------
test('jobs: every delivery key is refused while the session has background jobs, with the count, and nothing is prompted', async () => {
  const lock = sendLock();
  const h = fakeHost();
  for (const key of Object.keys(lib.PI_COMMANDS)) {
    await refuses(piSend(REPO, key, h, undefined, { lock, jobs: () => 2 }), 409, /^The session still has 2 background jobs running: wait for them to finish$/);
  }
  await refuses(piSend(REPO, 'flow-ship', h, undefined, { lock, jobs: () => 1 }), 409, /^The session still has 1 background job running: wait for it to finish$/);
  assert.deepEqual(h.sent, []);
  assert.deepEqual(await piSend(REPO, 'flow-ship', h, undefined, { lock, jobs: () => 0 }), { sent: true, confirmed: true });
});

test('jobs: the count is asked for the repo of the order', async () => {
  const asked = [];
  await piSend(REPO, 'flow-pr', fakeHost(), undefined, { jobs: (id) => { asked.push(id); return 0; } });
  assert.deepEqual(asked, ['r1']);
});

test('jobs: put-in-conditions and fix-pr are not delivery orders and go with jobs running', async () => {
  const h = fakeHost();
  assert.deepEqual(await piSend(REPO, 'put-in-conditions', h, requirements, { jobs: () => 3 }), { sent: true, confirmed: true });
  assert.deepEqual(await piSend(REPO, 'fix-pr', h, undefined, { pr: 7, prs, jobs: () => 3 }), { sent: true, confirmed: true });
  assert.equal(h.sent.length, 2);
});

test('jobs: a count that cannot be read (throws, not a positive integer) blocks nothing', async () => {
  for (const jobs of [() => { throw new Error('unreadable'); }, () => NaN, () => -1, () => '2', () => null, () => 1.5, undefined]) {
    const h = fakeHost();
    assert.deepEqual(await piSend(REPO, 'flow-ship', h, undefined, { jobs }), { sent: true, confirmed: true }, String(jobs));
  }
});

test('order: a session that is not free is refused for that, before the jobs and the lock', async () => {
  const lock = sendLock();
  const h = fakeHost({ state: 'asking' });
  await refuses(piSend(REPO, 'flow-ship', h, undefined, { lock, jobs: () => 2 }), 409, /^The session is waiting for an answer$/);
});
