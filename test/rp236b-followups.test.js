'use strict';
// RP236b: the fixes the independent verification of RP236 found. B1: Clear queue gives every text back whole (the 4000-character cap is only for what is drawn).
// B2: while the session works, a text that starts with `/` is not sent as a correction or queued (pi would run an extension command at once): it stays in the box.
// S2: a free session empties the drawn queue. S3 (page tests in rp75-optimistic C11e-C11g): Stop asks clear_queue before abort.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'rp236b-'));
process.env.REPO_PANEL_CONFIG = path.join(scratch, 'config.json');
test.after(() => fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 5 }));

const { createRpcHost, rpcApi, toPanel } = require('../server/rpchost.js');
const V = require('../public/view.js');
const R = require('../public/resumen.js');

const ACTIVE = { id: 'gentle-shell', command: 'C:\\L\\gentle-shell.exe', agentDir: 'C:\\a' };
async function hostWith(answer = {}) {
  const made = [];
  const createClient = (opts) => { const c = { opts, reqs: [], start: async () => ({}), request: async (type, fields) => { c.reqs.push([type, fields]); return type === 'clear_queue' ? answer : {}; }, answerDialog: () => false, pendingDialogs: () => [], state: () => 'busy', close() {} }; made.push(c); return c; };
  const host = createRpcHost({ resolve: async () => ({ active: ACTIVE }), repoOf: (id) => ({ id, path: 'C:\\repos\\alpha' }), publish() {}, createClient, adoptedOf: () => null });
  await host.start('aaa');
  return { host, reqs: () => made[0].reqs.filter(([t]) => t !== 'get_commands') };
}

// ---------- B1 ----------
test('B1: Clear queue gives back a long queued text whole, and every one of a long queue', async () => {
  const long = 'y'.repeat(12000);
  const many = Array.from({ length: 25 }, (_, i) => `m${i}`);
  const { host } = await hostWith({ steering: many, followUp: [long, 7, null] });
  assert.deepEqual(await rpcApi(host).clearQueue({ id: 'aaa' }), { steering: many, followUp: [long] });
});

test('B1: the queue that is drawn keeps its caps (20 per list, 4000 characters each)', () => {
  const q = toPanel({ type: 'queue_update', steering: Array.from({ length: 25 }, () => 'z'.repeat(5000)), followUp: [] });
  assert.deepEqual([q.steering.length, q.steering[0].length], [20, 4000]);
});

// ---------- B2 ----------
test('B2: the server refuses a command (a text that starts with /) sent as a correction or queued, and sends nothing', async () => {
  const { host, reqs } = await hostWith();
  for (const behavior of ['steer', 'followUp']) {
    for (const text of ['/flow-ship', '  /flow-pr --x', '\n/skill:foo']) {
      await assert.rejects(rpcApi(host).prompt({ id: 'aaa', text, behavior }), (e) => e.status === 409 && e.message === 'Commands wait until the session is free: send it when the run ends', `${behavior} ${JSON.stringify(text)}`);
    }
  }
  assert.deepEqual(reqs(), []);
});

test('B2: a command without a behavior (a new run) and a text with / inside still go as before', async () => {
  const { host, reqs } = await hostWith();
  await rpcApi(host).prompt({ id: 'aaa', text: '/flow-next' });
  await rpcApi(host).prompt({ id: 'aaa', text: 'use a/b and /tmp', behavior: 'steer' });
  assert.deepEqual(reqs(), [['prompt', { message: '/flow-next' }], ['prompt', { message: 'use a/b and /tmp', streamingBehavior: 'steer' }]]);
});

test('B2: the page names the same reason, and only for a text that starts with /', () => {
  assert.equal(R.steerRefusal('/flow-ship'), 'Commands wait until the session is free: send it when the run ends');
  assert.equal(R.steerRefusal('   /x'), 'Commands wait until the session is free: send it when the run ends');
  for (const t of ['fix it', 'a /b', '', null, undefined]) assert.equal(R.steerRefusal(t), '', String(t));
});

// ---------- S2 ----------
const queued = () => V.rpcReduce(V.rpcFromStatus(undefined, { state: 'busy', pendingDialogs: [] }), { kind: 'event', record: { type: 'queue', steering: ['a'], followUp: ['b'] } }).entry;
const NONE = { steering: [], followUp: [] };
test('S2: an idle or closed status or state empties the queue; busy and asking keep it', () => {
  const e = queued();
  assert.deepEqual(V.rpcFromStatus(e, { state: 'idle', pendingDialogs: [] }).queue, NONE);
  assert.deepEqual(V.rpcReduce(e, { kind: 'state', state: 'idle' }).entry.queue, NONE);
  assert.deepEqual(V.rpcReduce(e, { kind: 'state', state: 'closed' }).entry.queue, NONE);
  assert.deepEqual(V.rpcReduce(e, { kind: 'state', state: 'busy' }).entry.queue, { steering: ['a'], followUp: ['b'] });
  assert.deepEqual(V.rpcReduce(e, { kind: 'state', state: 'asking' }).entry.queue, { steering: ['a'], followUp: ['b'] });
  assert.deepEqual(V.rpcFromStatus(e, { state: 'asking', pendingDialogs: [] }).queue, { steering: ['a'], followUp: ['b'] });
});

// PRESERVE (found by the full suite): emptying the queue of an idle status must not skip what RP233 reads from the same status.
test('S2: an idle status that empties the queue still keeps the missing commands of RP233', () => {
  const st = V.rpcFromStatus(queued(), { state: 'idle', pendingDialogs: [], missing: ['flow-ship'] });
  assert.deepEqual([st.queue, st.missing], [NONE, ['flow-ship']]);
});
