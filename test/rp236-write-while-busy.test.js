'use strict';
// RP236: writing while the session works. With the session busy the box stays open: Enter (or the Correct button) steers the agent on the fly (`steer`), Alt+Enter
// (or the Queue button) leaves the message for when the run ends (`followUp`). pi tells the whole queue with `queue_update`, which the server translates to the panel's
// `queue`; the queue is shown above the box and Clear queue (`clear_queue`) takes it back into the box.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'rp236-'));
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

// ---------- the server ----------
test('server: queue_update becomes queue with the two lists of texts, capped; anything that is not a text is dropped', () => {
  assert.deepEqual(toPanel({ type: 'queue_update', steering: ['Stop and fix the test'], followUp: ['Then summarize'] }), { type: 'queue', steering: ['Stop and fix the test'], followUp: ['Then summarize'] });
  assert.deepEqual(toPanel({ type: 'queue_update' }), { type: 'queue', steering: [], followUp: [] });
  assert.deepEqual(toPanel({ type: 'queue_update', steering: 'x', followUp: [7, null, { a: 1 }, 'ok'] }), { type: 'queue', steering: [], followUp: ['ok'] });
  const many = toPanel({ type: 'queue_update', steering: Array.from({ length: 30 }, (_, i) => `m${i}`), followUp: ['y'.repeat(5000)] });
  assert.equal(many.steering.length, 20);
  assert.equal(many.followUp[0].length, 4000);
});

test('server: Clear queue asks pi clear_queue once and answers the texts it gave back, cleaned the same way', async () => {
  const { host, reqs } = await hostWith({ steering: ['a', 3], followUp: ['b'], extra: 'SECRET' });
  assert.deepEqual(await rpcApi(host).clearQueue({ id: 'aaa', junk: 1 }), { steering: ['a'], followUp: ['b'] });
  assert.deepEqual(reqs(), [['clear_queue', {}]]);
  const empty = await hostWith(null);
  assert.deepEqual(await rpcApi(empty.host).clearQueue({ id: 'aaa' }), { steering: [], followUp: [] });
});

test('server: Clear queue of a repo with no live session is refused', async () => {
  const { host } = await hostWith();
  await assert.rejects(rpcApi(host).clearQueue({ id: 'bbb' }), (e) => e.status === 409 && /not started/.test(e.message));
});

test('server: a message while the session works goes as a prompt with its behavior (steer or followUp)', async () => {
  const { host, reqs } = await hostWith();
  await rpcApi(host).prompt({ id: 'aaa', text: 'fix it', behavior: 'steer' });
  await rpcApi(host).prompt({ id: 'aaa', text: 'later', behavior: 'followUp' });
  assert.deepEqual(reqs(), [['prompt', { message: 'fix it', streamingBehavior: 'steer' }], ['prompt', { message: 'later', streamingBehavior: 'followUp' }]]);
});

// ---------- the page ----------
const adopted = { info: { adopted: 'p-1' } };
test('page: with the session working the box can correct or queue; starting, asking, compacting, not adopted and sending cannot', () => {
  const busy = R.composerState({ ...adopted, rpc: { state: 'busy' } });
  assert.deepEqual([busy.canSend, busy.canSteer, busy.placeholder], [false, true, 'Correct the agent, or queue a message for later…']);
  for (const c of [{ ...adopted, rpc: { state: 'busy', compacting: true } }, { ...adopted, rpc: { state: 'asking' } }, { ...adopted, rpc: { state: 'starting' } },
    { info: { adopted: null }, rpc: { state: 'busy' } }, { ...adopted, rpc: { state: 'busy' }, sending: true }, { info: null, rpc: { state: 'busy' } }]) {
    assert.equal(R.composerState(c).canSteer, false, JSON.stringify(c));
  }
  const idle = R.composerState({ ...adopted, rpc: { state: 'idle' } });
  assert.deepEqual([idle.canSend, idle.canSteer], [true, false]);
});

test('page: the buttons of the foot: Stop with an empty box, Correct and Queue with text, Send when free', () => {
  assert.deepEqual(R.footButtons({ busy: true, canSteer: true, hasText: false }), { send: false, stop: true, steer: false, queue: false });
  assert.deepEqual(R.footButtons({ busy: true, canSteer: true, hasText: true }), { send: false, stop: false, steer: true, queue: true });
  assert.deepEqual(R.footButtons({ busy: true, canSteer: false, hasText: true }), { send: false, stop: true, steer: false, queue: false });
  assert.deepEqual(R.footButtons({ busy: false, canSteer: false, hasText: true }), { send: true, stop: false, steer: false, queue: false });
});

test('page: Alt+Enter queues, Enter corrects; the rule of Enter for sending at all is unchanged', () => {
  assert.equal(R.busyBehavior({ alt: true }), 'followUp');
  assert.equal(R.busyBehavior({ alt: false }), 'steer');
  assert.equal(R.busyBehavior({}), 'steer');
});

const rec = (record) => ({ kind: 'event', id: '0123456789', record: toPanel(record) });
test('page: the queue follows queue events, and a run that settles, an exit or a closed status empties it', () => {
  let e = V.rpcReduce(null, rec({ type: 'agent_start' }), 1).entry;
  assert.deepEqual(e.queue, { steering: [], followUp: [] });
  e = V.rpcReduce(e, rec({ type: 'queue_update', steering: ['fix'], followUp: ['then'] })).entry;
  assert.deepEqual(e.queue, { steering: ['fix'], followUp: ['then'] });
  assert.deepEqual(V.rpcReduce(e, rec({ type: 'agent_settled' })).entry.queue, { steering: [], followUp: [] });
  assert.deepEqual(V.rpcReduce(e, { kind: 'exit' }).entry.queue, { steering: [], followUp: [] });
  assert.deepEqual(V.rpcFromStatus(e, { state: 'closed', pendingDialogs: [] }).queue, { steering: [], followUp: [] });
  assert.deepEqual(V.rpcFromStatus(e, { state: 'busy', pendingDialogs: [] }).queue, { steering: ['fix'], followUp: ['then'] });
  assert.deepEqual(V.rpcReduce(e, { kind: 'event', record: { type: 'queue', steering: 'x', followUp: [1, 'ok'] } }).entry.queue, { steering: [], followUp: ['ok'] });
});

test('page: the queue row lists each message with its kind, escaped, and offers Clear queue; an empty queue draws nothing', () => {
  assert.equal(R.queueRowHtml(null), '');
  assert.equal(R.queueRowHtml({ steering: [], followUp: [] }), '');
  const html = R.queueRowHtml({ steering: ['<b>fix</b>'], followUp: ['then summarize'] });
  assert.match(html, /Queued · 2/);
  assert.match(html, /Correction[\s\S]*&lt;b&gt;fix&lt;\/b&gt;/);
  assert.match(html, /After the run[\s\S]*then summarize/);
  assert.match(html, /data-act="chat-unqueue"[^>]*>Clear queue</);
  assert.doesNotMatch(html, /<b>fix/);
});
