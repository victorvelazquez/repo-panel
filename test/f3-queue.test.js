'use strict';
// F3: the queue of a session survives «Restart panel» (Stop-Process -Force). Critical zone (the host's concurrency, pi sessions, saved data): the abuse case comes first.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'rp-f3-'));
process.env.REPO_PANEL_CONFIG = path.join(scratch, 'config.json');
test.after(() => fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 5 }));

const lib = require('../lib.js');
const { HttpError } = require('../server/errors.js');
const { createServer } = require('../server/http.js');
const { createRpcHost } = require('../server/rpchost.js');
const { RpcError } = require('../server/rpc.js');
const { createQueueStore } = require('../server/queuestore.js');
const { buildAttention } = require('../server/attention.js');

const A = path.join(scratch, 'alpha');
fs.mkdirSync(A);
const IA = lib.repoId(A);
fs.writeFileSync(process.env.REPO_PANEL_CONFIG, JSON.stringify({ groups: [{ name: 'g', repos: [{ path: A }] }] }));
const H = 3600000;
const ACTIVE = { id: 'x', command: 'pi', args: [] };
const tick = async (n = 10) => { for (let i = 0; i < n; i += 1) await new Promise((r) => setImmediate(r)); };
let dirs = 0;
const fileIn = () => { const d = path.join(scratch, `q${dirs += 1}`); fs.mkdirSync(d); return path.join(d, 'queues.json'); };
const saved = (file) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };
const textsIn = (file) => { const q = ((saved(file) || {}).queues || {})[IA]; return q ? { steering: q.steering.map((m) => m.text), followUp: q.followUp.map((m) => m.text) } : null; };
const fixture = (file, steering, followUp, extra = {}) => fs.writeFileSync(file, JSON.stringify({ version: 1, queues: { [IA]: { steering, followUp, ...extra } } }));
const lostOf = (host) => (host.attentionOf(IA).queued || []).map((m) => m.text);

// A fake pi with a real queue: a prompt on a free session starts a run, one while it works needs a streamingBehavior (else it fails, like pi) and is queued with a queue_update.
// `hold`: every request waits in c.pend until step(c) answers it; a close or a death fails every pending request first, as server/rpc.js does. `commandsDelay`: get_commands answers late.
function fakePi({ hold = false, commandsDelay = 0 } = {}) {
  const made = [];
  const createClient = (opts) => {
    let gone = false;
    const failAll = () => { for (const p of c.pend.splice(0)) p.fail(new Error('The session ended')); };
    const answer = (type, f) => {
      if (type === 'prompt' && f.message.startsWith('/')) return { disposition: 'handled' }; // pi runs an extension command at once: no run starts
      if (type === 'prompt') {
        if (c.st !== 'busy') { c.st = 'busy'; return {}; }
        if (!f.streamingBehavior) throw new Error('Agent is already processing');
        c.q[f.streamingBehavior === 'steer' ? 'steering' : 'followUp'].push(f.message);
        c.emit({ type: 'queue_update', ...c.q });
      }
      if (type === 'clear_queue') { const out = c.q; c.q = { steering: [], followUp: [] }; c.emit({ type: 'queue_update', ...c.q }); return out; }
      if (type === 'new_session') return c.newSession;
      if (type === 'get_state') return { sessionId: 'panel-alpha-new' };
      return {};
    };
    const c = {
      reqs: [], pend: [], st: 'idle', q: { steering: [], followUp: [] }, newSession: {},
      emit: (record) => opts.onEvent({ kind: 'event', record }),
      start: async () => ({}),
      async request(type, f = {}) {
        if (type === 'get_commands') { if (commandsDelay) await new Promise((r) => setTimeout(r, commandsDelay)); return {}; }
        c.reqs.push(type === 'prompt' ? [type, f.message, f.streamingBehavior || null] : [type]);
        if (!hold) return answer(type, f);
        return new Promise((go, fail) => c.pend.push({ go: () => { try { go(answer(type, f)); } catch (e) { fail(e); } }, fail }));
      },
      die: () => { gone = true; failAll(); opts.onExit({ reason: 'exit' }); }, // pi ended by itself (a crash), not closed by anyone
      settle() { c.st = 'idle'; c.q = { steering: [], followUp: [] }; c.emit({ type: 'queue_update', ...c.q }); c.emit({ type: 'agent_settled' }); opts.onEvent({ kind: 'state', state: 'idle' }); },
      state: () => c.st, pendingDialogs: () => [], answerDialog: () => false,
      close: async () => { failAll(); if (!gone) { gone = true; setImmediate(() => opts.onExit({ reason: 'closed' })); } },
    };
    made.push(c);
    return c;
  };
  return { made, createClient };
}
// Answers the oldest pending request of a held fake pi.
const step = async (c) => { c.pend.shift().go(); await tick(); };
const fresh = (...texts) => texts.map((text) => ({ text, at: Date.now() }));
const repoOf = (id) => { if (id !== IA) throw new HttpError(404, 'Unknown repository'); return { id, path: A }; };
const hostOn = (file, pi) => createRpcHost({ resolve: async () => ({ active: ACTIVE }), repoOf, publish: () => {}, createClient: pi.createClient, adoptedOf: () => null, queues: createQueueStore({ file }) });

test('f3-a (abuse): killed with a full queue, a new host delivers it once, in order, only when someone starts the session; a new message goes behind', async () => {
  const file = fileIn();
  const pi1 = fakePi();
  const h1 = hostOn(file, pi1);
  await h1.start(IA);
  pi1.made[0].st = 'busy';
  pi1.made[0].emit({ type: 'queue_update', steering: ['s1'], followUp: ['f1', 'f2'] });
  // Stop-Process -Force: h1 is dropped, no close and no closeAll run.
  const pi2 = fakePi();
  const h2 = hostOn(file, pi2);
  await tick();
  assert.equal(pi2.made.length, 0); // the host never starts a session by itself
  assert.deepEqual(lostOf(h2), ['s1', 'f1', 'f2']);
  await h2.start(IA);
  await h2.prompt(IA, 'new');
  await tick();
  const c2 = pi2.made[0];
  assert.deepEqual(c2.reqs, [['prompt', 's1', null], ['prompt', 'f1', 'followUp'], ['prompt', 'f2', 'followUp'], ['prompt', 'new', 'followUp']]);
  assert.deepEqual(lostOf(h2), []);
  assert.deepEqual(textsIn(file), { steering: [], followUp: ['f1', 'f2', 'new'] }); // s1 left pi's queue: it is running
  c2.settle();
  assert.equal(textsIn(file), null);
  const pi3 = fakePi();
  const h3 = hostOn(file, pi3);
  await h3.start(IA);
  await tick();
  assert.deepEqual(pi3.made[0].reqs, []); // nothing is delivered twice
  await Promise.all([h1.closeAll(), h2.closeAll(), h3.closeAll()]);
});

test('f3-b (abuse): killed again before pi ran the delivered queue, only what pi still held comes back, once', async () => {
  const file = fileIn();
  fixture(file, [{ text: 's1', at: Date.now() }], [{ text: 'f1', at: Date.now() }]);
  const pi2 = fakePi();
  const h2 = hostOn(file, pi2);
  await h2.start(IA);
  await tick();
  assert.deepEqual(pi2.made[0].reqs, [['prompt', 's1', null], ['prompt', 'f1', 'followUp']]);
  const pi3 = fakePi();
  const h3 = hostOn(file, pi3); // h2 dropped without close
  assert.deepEqual(lostOf(h3), ['f1']);
  await h3.start(IA);
  await tick();
  assert.deepEqual(pi3.made[0].reqs, [['prompt', 'f1', null]]);
  await Promise.all([h2.closeAll(), h3.closeAll()]);
});

test('f3-c: every queue_update saves the whole queue at once (texts only, capped, with when each entered), mode 0600; an empty one removes it', async () => {
  const file = fileIn();
  const pi = fakePi();
  const host = hostOn(file, pi);
  await host.start(IA);
  const c = pi.made[0];
  c.st = 'busy';
  const t0 = Date.now();
  c.emit({ type: 'queue_update', steering: ['s1', 7], followUp: ['f1', 'y'.repeat(5000), ...Array(25).fill('z')] });
  const q = saved(file).queues[IA];
  assert.deepEqual(q.steering.map((m) => m.text), ['s1']);
  assert.equal(q.followUp.length, 20);
  assert.equal(q.followUp[1].text.length, 4000);
  assert.ok([...q.steering, ...q.followUp].every((m) => m.at >= t0 && m.at <= Date.now()));
  if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.ok(!fs.existsSync(`${file}.tmp`));
  assert.deepEqual(lostOf(host), []); // pi holds it: not lost
  await new Promise((r) => setTimeout(r, 5));
  c.emit({ type: 'queue_update', steering: ['s1'], followUp: ['f2'] });
  assert.equal(saved(file).queues[IA].steering[0].at, q.steering[0].at);
  c.emit({ type: 'queue_update', steering: [], followUp: [] });
  assert.equal(textsIn(file), null);
  await host.closeAll();
});

test('f3-d: the copy is emptied by clear_queue, renew and a close by the person; agent_settled keeps what pi still holds; a panel shutdown keeps it', async () => {
  const file = fileIn();
  const pi = fakePi();
  const host = hostOn(file, pi);
  await host.start(IA);
  const c = pi.made[0];
  c.st = 'busy';
  c.q = { steering: ['a'], followUp: [] };
  c.emit({ type: 'queue_update', ...c.q });
  assert.deepEqual(await host.clearQueue(IA), { steering: ['a'], followUp: [] });
  assert.equal(textsIn(file), null);
  c.emit({ type: 'queue_update', steering: [], followUp: ['b'] });
  c.st = 'idle';
  await host.renew(IA);
  assert.equal(textsIn(file), null);
  c.emit({ type: 'queue_update', steering: [], followUp: ['c'] });
  c.emit({ type: 'agent_settled' });
  assert.deepEqual(textsIn(file), { steering: [], followUp: ['c'] });
  await host.close(IA);
  assert.equal(textsIn(file), null);
  await host.start(IA);
  pi.made[1].emit({ type: 'queue_update', steering: [], followUp: ['d'] });
  await host.closeAll(); // Ctrl+C: not a close by the person
  assert.deepEqual(textsIn(file), { steering: [], followUp: ['d'] });
  assert.deepEqual(lostOf(host), ['d']);
});

test('f3-e: a message older than 12 h waits for queue-confirm; confirmed while closed, it is delivered when the session starts', async () => {
  const file = fileIn();
  fixture(file, [], [{ text: 'old', at: Date.now() - 13 * H }]);
  const pi = fakePi();
  const host = hostOn(file, pi);
  await host.start(IA);
  await tick();
  assert.deepEqual(pi.made[0].reqs, []);
  await host.close(IA); // closing by the person empties the copy, also an unconfirmed one
  assert.deepEqual(lostOf(host), []);
  fixture(file, [], [{ text: 'old', at: Date.now() - 13 * H }]);
  const pi2 = fakePi();
  const h2 = hostOn(file, pi2);
  const before = fs.readFileSync(file, 'utf8');
  await assert.rejects(h2.queueConfirm('nope'), (e) => e.status === 404);
  assert.equal(fs.readFileSync(file, 'utf8'), before);
  assert.deepEqual(await h2.queueConfirm(IA), { confirmed: true, count: 1, refused: [] });
  assert.equal(pi2.made.length, 0);
  await h2.start(IA);
  await tick();
  assert.deepEqual(pi2.made[0].reqs, [['prompt', 'old', null]]);
  await assert.rejects(h2.queueConfirm(IA), (e) => e.status === 409);
  await Promise.all([host.closeAll(), h2.closeAll()]);
});

test('f3-f: a broken, unreadable or odd queues.json is empty and throws nothing; a failed write keeps the session going and is retried on the next change', async () => {
  for (const body of ['{not json', '[]', 'null', JSON.stringify({ version: 1, queues: { [IA]: { steering: 'x', followUp: [{ text: 5, at: 'y' }] } } })]) {
    const file = fileIn();
    fs.writeFileSync(file, body);
    const pi = fakePi();
    const host = hostOn(file, pi);
    assert.deepEqual(lostOf(host), [], body);
    await host.start(IA);
    await tick();
    assert.deepEqual(pi.made[0].reqs, [], body);
    await host.closeAll();
  }
  const file = fileIn();
  fs.mkdirSync(file); // unreadable, and every write to it fails
  const pi = fakePi();
  const host = hostOn(file, pi);
  assert.deepEqual(lostOf(host), []);
  await host.start(IA);
  const c = pi.made[0];
  c.st = 'busy';
  assert.doesNotThrow(() => c.emit({ type: 'queue_update', steering: [], followUp: ['x'] }));
  assert.deepEqual(await host.prompt(IA, 'y', { behavior: 'followUp' }), {});
  fs.rmSync(file, { recursive: true, force: true });
  c.emit({ type: 'queue_update', steering: [], followUp: ['x', 'y', 'z'] });
  assert.deepEqual(textsIn(file), { steering: [], followUp: ['x', 'y', 'z'] });
  await host.closeAll();
});

test('f3-g: queue-lost comes right after asking, with the count and the first line of each message, cut, redacted and scrubbed; old ones say old', () => {
  const NOW = Date.parse('2026-11-25T12:00:00Z');
  const secret = 'ghp_' + 'a'.repeat(36);
  const quiet = { state: 'closed', since: null, mode: null, ended: null, dialogs: [] };
  const out = buildAttention({
    repos: [{ id: IA, name: 'alpha', branch: 'main' }, { id: 'b', name: 'beta', branch: 'x' }],
    sessions: { [IA]: { ...quiet, queued: [{ text: `use TOK ${secret}\nsecond line`, at: NOW - 13 * H }, { text: 'w'.repeat(300), at: NOW - H }, { text: '  /flow-ship', at: NOW }, { text: '!ls', at: NOW - 13 * H }] }, b: { ...quiet, state: 'asking', dialogs: [{ requestId: 'r', method: 'confirm', title: 't', options: [] }] } },
    prs: { b: [{ number: 1, title: 'p', url: 'u', head: 'x', ready: true, checks: {} }] }, last: {}, now: NOW, scrub: (s) => s.split('TOK').join('[token]'),
  });
  assert.deepEqual(out.items.map((i) => i.kind), ['asking', 'queue-lost', 'pr-green']);
  const lost = out.items[1];
  assert.deepEqual([lost.id, lost.name, lost.count, lost.lines.length], [IA, 'alpha', 4, 4]);
  assert.ok(lost.lines[0].text.startsWith('use [token] ') && !lost.lines[0].text.includes('second') && !JSON.stringify(out).includes(secret));
  assert.equal(lost.lines[0].old, true);
  assert.deepEqual(lost.lines[1], { text: 'w'.repeat(200) });
  assert.deepEqual(lost.lines.slice(2), [{ text: '  /flow-ship', command: true }, { text: '!ls', old: true, command: true }]);
});

test('f3-j (abuse): a saved command never goes by itself and never skips the guards of a prompt; queue-confirm sends only what a prompt would take', async () => {
  const file = fileIn();
  const now = Date.now();
  fixture(file, [], ['/gentle:mode super-yolo', 'fix the test', '/flow-ship', '!rm -rf x', 'then summarize'].map((text) => ({ text, at: now })));
  const pi = fakePi();
  const host = hostOn(file, pi);
  await host.start(IA);
  await tick();
  assert.deepEqual(pi.made[0].reqs, []); // the commands lead: the whole queue waits, in its order
  assert.deepEqual(lostOf(host), ['/gentle:mode super-yolo', 'fix the test', '/flow-ship', '!rm -rf x', 'then summarize']);
  await host.prompt(IA, 'new one'); // a new message still goes, and nothing saved goes with it
  pi.made[0].settle();
  await tick();
  assert.deepEqual(pi.made[0].reqs, [['prompt', 'new one', null]]);
  pi.made[0].reqs.length = 0;
  // /gentle:mode is NOT_HERE, /flow-ship would go as a followUp (COMMAND_WAITS), !rm runs a shell (cleanText refuses it): none of them reaches pi.
  assert.deepEqual(await host.queueConfirm(IA), { confirmed: true, count: 2, refused: ['/gentle:mode super-yolo', '/flow-ship', '!rm -rf x'] });
  await tick();
  assert.deepEqual(pi.made[0].reqs, [['prompt', 'fix the test', null], ['prompt', 'then summarize', 'followUp']]);
  const raw = fs.readFileSync(file, 'utf8');
  assert.ok(!raw.includes('gentle:mode') && !raw.includes('rm -rf') && !raw.includes('flow-ship'));
  assert.deepEqual(textsIn(file), { steering: [], followUp: ['then summarize'] });
  assert.deepEqual(lostOf(host), []);
  await host.closeAll();
});

test('f3-l: a fresh saved text the prompt guards refuse (only spaces, not a command) is dropped from the copy and never reaches pi; the others go', async () => {
  const file = fileIn();
  const now = Date.now();
  fixture(file, [], ['fix the test', '   ', 'then summarize'].map((text) => ({ text, at: now })));
  const pi = fakePi();
  const host = hostOn(file, pi);
  assert.deepEqual(lostOf(host), ['fix the test', '   ', 'then summarize']); // not old, not a command: nothing waits for confirm
  await host.start(IA);
  await tick();
  assert.deepEqual(pi.made[0].reqs, [['prompt', 'fix the test', null], ['prompt', 'then summarize', 'followUp']]);
  assert.deepEqual(textsIn(file), { steering: [], followUp: ['then summarize'] });
  assert.deepEqual(lostOf(host), []);
  await host.closeAll();
});

test('f3-m: a session that dies by itself keeps its pi queue saved, shown as queue-lost, and the next start delivers it once', async () => {
  const file = fileIn();
  const pi = fakePi();
  const host = hostOn(file, pi);
  await host.start(IA);
  const c = pi.made[0];
  c.st = 'busy';
  c.emit({ type: 'queue_update', steering: [], followUp: ['a', 'b'] });
  c.die();
  await tick();
  assert.equal(host.stateOf(IA), 'closed');
  assert.deepEqual(textsIn(file), { steering: [], followUp: ['a', 'b'] });
  assert.deepEqual(lostOf(host), ['a', 'b']);
  await host.start(IA);
  await tick();
  assert.deepEqual(pi.made[1].reqs, [['prompt', 'a', null], ['prompt', 'b', 'followUp']]);
  assert.deepEqual(lostOf(host), []);
  pi.made[1].settle();
  assert.equal(textsIn(file), null);
  await host.start(IA);
  await tick();
  assert.deepEqual(pi.made[1].reqs, [['prompt', 'a', null], ['prompt', 'b', 'followUp']]); // not again
  await host.closeAll();
});

test('f3-n: queues.json is written with mode 0600', async (t) => {
  if (process.platform === 'win32') { t.skip('Windows does not keep POSIX file modes'); return; }
  const file = fileIn();
  createQueueStore({ file }).put(IA, { steering: [], followUp: [{ text: 'x', at: Date.now() }] });
  assert.deepEqual(textsIn(file), { steering: [], followUp: ['x'] });
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

test('f3-p1 (B1): a close by the person during a delivery ends it for good: nothing comes back, the copy stays empty, the next start sends nothing', async () => {
  const file = fileIn();
  fixture(file, [], fresh('a', 'b', 'c'));
  const pi = fakePi({ hold: true });
  const host = hostOn(file, pi);
  await host.start(IA);
  const c = pi.made[0];
  await step(c); // a starts the run; b is now on its way
  assert.deepEqual(c.reqs, [['prompt', 'a', null], ['prompt', 'b', 'followUp']]);
  await host.close(IA);
  await tick();
  assert.equal(textsIn(file), null);
  assert.deepEqual(lostOf(host), []);
  await host.start(IA);
  await tick();
  assert.deepEqual(pi.made[1].reqs, []);
  assert.equal(textsIn(file), null);
  await host.closeAll();
});

// b is queued in pi, c is on its way, d is still saved: the remaining order is b, c, d.
async function midDelivery() {
  const file = fileIn();
  fixture(file, [], fresh('a', 'b', 'c', 'd'));
  const pi = fakePi({ hold: true });
  const host = hostOn(file, pi);
  await host.start(IA);
  const c = pi.made[0];
  await step(c);
  await step(c);
  assert.deepEqual(c.reqs, [['prompt', 'a', null], ['prompt', 'b', 'followUp'], ['prompt', 'c', 'followUp']]);
  return { file, host, c };
}

test('f3-p2 (B2): pi dying during a delivery keeps the remaining order, in memory and in the file at once', async () => {
  const { file, host, c } = await midDelivery();
  c.die();
  assert.deepEqual(textsIn(file), { steering: [], followUp: ['b', 'c', 'd'] }); // a Stop-Process right now loses nothing
  await tick();
  assert.deepEqual(lostOf(host), ['b', 'c', 'd']);
  assert.deepEqual(textsIn(file), { steering: [], followUp: ['b', 'c', 'd'] });
  const pi2 = fakePi();
  const h2 = hostOn(file, pi2);
  await h2.start(IA);
  await tick();
  assert.deepEqual(pi2.made[0].reqs, [['prompt', 'b', null], ['prompt', 'c', 'followUp'], ['prompt', 'd', 'followUp']]);
  await Promise.all([host.closeAll(), h2.closeAll()]);
});

test('f3-p3 (B3): a shutdown of the panel during a delivery keeps the remaining order, in memory and in the file', async () => {
  const { file, host } = await midDelivery();
  const done = host.closeAll();
  assert.deepEqual(textsIn(file), { steering: [], followUp: ['b', 'c', 'd'] });
  await done;
  await tick();
  assert.deepEqual(lostOf(host), ['b', 'c', 'd']);
  assert.deepEqual(textsIn(file), { steering: [], followUp: ['b', 'c', 'd'] });
});

test('f3-p4 (B4): a saved queue whose texts are all refused leaves the session as it was: a / command and a new session work at once', async () => {
  const file = fileIn();
  fixture(file, [], fresh('   ', '  '));
  const pi = fakePi();
  const host = hostOn(file, pi);
  await host.start(IA);
  await tick();
  assert.deepEqual(pi.made[0].reqs, []);
  assert.equal(textsIn(file), null);
  await host.renew(IA);
  assert.deepEqual(await host.prompt(IA, '/flow-ship'), { disposition: 'handled' });
  assert.deepEqual(pi.made[0].reqs, [['new_session'], ['get_state'], ['prompt', '/flow-ship', null]]);
  await host.closeAll();
});

test('f3-p5 (M1): a message sent while the session is still loading its commands goes behind the saved queue', async () => {
  const file = fileIn();
  fixture(file, [], fresh('s1', 'f1'));
  const pi = fakePi({ commandsDelay: 80 });
  const host = hostOn(file, pi);
  const started = host.start(IA);
  while (host.stateOf(IA) !== 'idle') await new Promise((r) => setTimeout(r, 2));
  await host.prompt(IA, 'new');
  await started;
  await tick();
  assert.deepEqual(pi.made[0].reqs, [['prompt', 's1', null], ['prompt', 'f1', 'followUp'], ['prompt', 'new', 'followUp']]);
  await host.closeAll();
});

test('f3-p6 (M2): while the session starts a new conversation, queue-confirm sends nothing; it delivers once the session is free again', async () => {
  const file = fileIn();
  fixture(file, [], [{ text: 'old', at: Date.now() - 13 * H }]);
  const pi = fakePi({ hold: true });
  const host = hostOn(file, pi);
  await host.start(IA);
  const c = pi.made[0];
  c.newSession = { cancelled: true }; // an extension keeps the conversation: the saved queue stays
  const renewing = host.renew(IA).catch((e) => e);
  await tick();
  assert.deepEqual(await host.queueConfirm(IA), { confirmed: true, count: 1, refused: [] });
  await tick();
  assert.deepEqual(c.reqs, [['new_session']]);
  await step(c);
  assert.equal((await renewing).status, 409);
  await tick();
  assert.deepEqual(c.reqs, [['new_session'], ['prompt', 'old', null]]);
  await host.closeAll();
});

test('f3-p7 (M3): the clear-queue answer never carries the panel token', async () => {
  await withServer(async ({ token, post }) => {
    fixture(QFILE, [], [{ text: `paste ${token}`, at: Date.now() }]); // written after the start: the store reads it on first use
    const r = await post('/api/rpc/clear-queue', { id: IA });
    assert.deepEqual([r.status, r.json], [200, { steering: [], followUp: ['paste [token]'] }]);
    assert.ok(!r.body.includes(token));
  });
});

test('f3-p8 (A1): clear-queue during a delivery stops it: nothing more is sent after clear_queue', async () => {
  const file = fileIn();
  fixture(file, [], fresh('a', 'b', 'c'));
  const pi = fakePi({ hold: true });
  const host = hostOn(file, pi);
  await host.start(IA);
  const c = pi.made[0];
  await step(c); // b is on its way
  const cleared = host.clearQueue(IA);
  await step(c); // pi takes b
  await step(c); // and answers clear_queue
  assert.deepEqual(await cleared, { steering: [], followUp: ['b', 'c'] });
  await tick();
  assert.deepEqual(c.reqs, [['prompt', 'a', null], ['prompt', 'b', 'followUp'], ['clear_queue']]);
  assert.equal(textsIn(file), null);
  assert.deepEqual(lostOf(host), []);
  await host.closeAll();
});

test('f3-p9 (A2): a / or ! after spaces or invisible format characters is still a command: it waits for queue-confirm and says command', async () => {
  const file = fileIn();
  fixture(file, [], fresh('\u200b/flow-ship', '\u2060 !ls', 'plain'));
  const pi = fakePi();
  const host = hostOn(file, pi);
  await host.start(IA);
  await tick();
  assert.deepEqual(pi.made[0].reqs, []);
  const lines = buildAttention({ repos: [{ id: IA, name: 'alpha', branch: 'main' }], sessions: { [IA]: host.attentionOf(IA) }, prs: {}, last: {}, now: Date.now() }).items[0].lines;
  assert.deepEqual(lines.map((l) => l.command === true), [true, true, false]);
  await host.closeAll();
});

test('f3-q1 (G1): two saved messages with the same text: while the first runs, the file holds only the queued one', async () => {
  const file = fileIn();
  fixture(file, [], fresh('sigue', 'sigue'));
  const pi = fakePi({ hold: true });
  const host = hostOn(file, pi);
  await host.start(IA);
  const c = pi.made[0];
  await step(c); // the first runs
  await step(c); // the second is in pi's queue
  assert.deepEqual(c.reqs, [['prompt', 'sigue', null], ['prompt', 'sigue', 'followUp']]);
  assert.deepEqual(textsIn(file), { steering: [], followUp: ['sigue'] });
  await host.closeAll();
});

test('f3-q2 (D4): a delivered command that pi handles without a run leaves the session free: a / command and a new session go at once', async () => {
  const file = fileIn();
  fixture(file, [], fresh('/flow-next'));
  const pi = fakePi();
  const host = hostOn(file, pi);
  await host.start(IA);
  await host.queueConfirm(IA);
  await tick();
  assert.deepEqual(await host.prompt(IA, '/flow-ship'), { disposition: 'handled' });
  await host.renew(IA);
  assert.deepEqual(pi.made[0].reqs, [['prompt', '/flow-next', null], ['prompt', '/flow-ship', null], ['new_session'], ['get_state']]);
  assert.equal(textsIn(file), null);
  await host.closeAll();
});

test('f3-q3 (D3): a delivered prompt that times out is not sent again: pi may have taken it', async () => {
  const file = fileIn();
  fixture(file, [], fresh('a'));
  const pi = fakePi({ hold: true });
  const host = hostOn(file, pi);
  await host.start(IA);
  const c = pi.made[0];
  c.st = 'busy'; // pi took it, the answer never came
  c.pend.shift().fail(new RpcError('The agent did not answer in time'));
  await tick();
  assert.deepEqual(textsIn(file), { steering: [], followUp: ['a'] }); // still saved until a run ends
  c.settle();
  await tick();
  assert.equal(c.reqs.filter(([t, m]) => t === 'prompt' && m === 'a').length, 1);
  assert.equal(textsIn(file), null);
  await host.closeAll();
});

test('f3-q4 (E1): a delivered follow-up pi refuses during a clear-queue comes back in its answer, in order', async () => {
  const file = fileIn();
  fixture(file, [], fresh('a', 'b', 'c'));
  const pi = fakePi({ hold: true });
  const host = hostOn(file, pi);
  await host.start(IA);
  const c = pi.made[0];
  await step(c); // a runs, b is on its way
  const cleared = host.clearQueue(IA);
  c.pend.shift().fail(new RpcError('The agent refused the request'));
  await step(c); // clear_queue
  assert.deepEqual(await cleared, { steering: [], followUp: ['b', 'c'] });
  assert.deepEqual(c.reqs, [['prompt', 'a', null], ['prompt', 'b', 'followUp'], ['clear_queue']]);
  assert.equal(textsIn(file), null);
  await host.closeAll();
});

// ---- The routes, through the real server and its default host (queues.json next to config.json) ----

const freePort = () => new Promise((resolve) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });
const call = (port, method, p, { token, body } = {}) => new Promise((resolve, reject) => {
  const payload = body === undefined ? undefined : JSON.stringify(body);
  const req = http.request({ agent: false, host: '127.0.0.1', port, path: p, method, headers: { ...(token ? { 'x-token': token } : {}), ...(payload !== undefined ? { 'content-type': 'application/json' } : {}) } }, (res) => {
    let d = ''; res.on('data', (c) => { d += c; }); res.on('end', () => { let json = null; try { json = JSON.parse(d); } catch { /* html */ } resolve({ status: res.statusCode, body: d, json }); });
  });
  req.on('error', reject);
  if (payload !== undefined) req.write(payload);
  req.end();
});
const QFILE = path.join(scratch, 'queues.json');
async function withServer(fn) {
  const pi = fakePi();
  const port = await freePort();
  const server = createServer(port, { noSummaryStore: true, rpcClient: pi.createClient, rpcResolve: async () => ({ active: ACTIVE }), sessionsDir: path.join(scratch, 'sessions') });
  await new Promise((r) => server.listen(port, '127.0.0.1', r));
  try {
    const token = /name="?token"? content="([0-9a-f]+)"/.exec((await call(port, 'GET', '/')).body)[1];
    await fn({ pi, token, get: (p) => call(port, 'GET', p, { token }), post: (p, body) => call(port, 'POST', p, { token, body }) });
  } finally { await new Promise((r) => server.close(r)); }
}

test('f3-h: a saved queue of a closed repo is queue-lost; queue-confirm delivers it to the live, free session; unknown ids are 404 and write nothing', async () => {
  fixture(QFILE, [], [{ text: 'old one\nmore', at: Date.now() - 13 * H }, { text: 'fresh', at: Date.now() }]);
  await withServer(async ({ pi, get, post }) => {
    const items = (await get('/api/attention')).json.items;
    assert.deepEqual(items, [{ kind: 'queue-lost', id: IA, name: 'alpha', count: 2, lines: [{ text: 'old one', old: true }, { text: 'fresh' }] }]);
    assert.equal((await post('/api/rpc/start', { id: IA })).status, 200);
    await tick();
    assert.deepEqual(pi.made[0].reqs, []); // one message is older than 12 h: nothing goes by itself
    const before = fs.readFileSync(QFILE, 'utf8');
    assert.equal((await post('/api/rpc/queue-confirm', { id: 'nope' })).status, 404);
    assert.equal((await post('/api/rpc/queue-confirm', {})).status, 400);
    assert.equal(fs.readFileSync(QFILE, 'utf8'), before);
    const ok = await post('/api/rpc/queue-confirm', { id: IA });
    assert.deepEqual([ok.status, ok.json], [200, { confirmed: true, count: 2, refused: [] }]);
    await tick();
    assert.deepEqual(pi.made[0].reqs, [['prompt', 'old one\nmore', null], ['prompt', 'fresh', 'followUp']]);
    assert.deepEqual((await get('/api/attention')).json.items.filter((i) => i.kind === 'queue-lost'), []);
    await post('/api/rpc/close', { id: IA });
  });
});

test('f3-i: clear-queue of a closed repo empties only the saved copy and answers what it removed; with nothing saved it is 409 as before; unknown is 404', async () => {
  fixture(QFILE, [{ text: 's', at: Date.now() }], [{ text: 'f', at: Date.now() }]);
  await withServer(async ({ pi, get, post }) => {
    const before = fs.readFileSync(QFILE, 'utf8');
    assert.equal((await post('/api/rpc/clear-queue', { id: 'nope' })).status, 404);
    assert.equal(fs.readFileSync(QFILE, 'utf8'), before);
    const r = await post('/api/rpc/clear-queue', { id: IA });
    assert.deepEqual([r.status, r.json], [200, { steering: ['s'], followUp: ['f'] }]);
    assert.equal(textsIn(QFILE), null);
    assert.deepEqual((await get('/api/attention')).json.items, []);
    const again = await post('/api/rpc/clear-queue', { id: IA });
    assert.deepEqual([again.status, again.json], [409, { error: 'The session is not started' }]);
    assert.equal(pi.made.length, 0); // nothing was started to clear it
  });
});

test('f3-k: the queue-confirm answer never carries the panel token, even in a refused text', async () => {
  await withServer(async ({ token, post }) => {
    fixture(QFILE, [], [{ text: `/gentle:mode ${token}`, at: Date.now() }]); // written after the start: the store reads it on first use
    assert.equal((await post('/api/rpc/start', { id: IA })).status, 200);
    await tick();
    const r = await post('/api/rpc/queue-confirm', { id: IA });
    assert.equal(r.status, 200);
    assert.equal(r.json.refused.length, 1);
    assert.ok(!r.body.includes(token));
    await post('/api/rpc/close', { id: IA });
  });
});
