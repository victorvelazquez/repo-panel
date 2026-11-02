'use strict';
// RPC1b (S1, S2): server/rpc.js, the JSONL client of `pi --mode rpc`. Two kinds of fake agent, no real pi: test/fixtures/fake-pi-rpc.js (a
// node script driven by FAKE_* variables, for real pipes) and an in-process fake child (to see exactly what is written and when).
const test = require('node:test');
const assert = require('node:assert/strict');
const cp = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { createRpcClient, RpcError } = require('../server/rpc.js');

const FIXTURE = path.join(__dirname, 'fixtures', 'fake-pi-rpc.js');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'rpc1b-client-'));
test.after(() => fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 4000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = fn(); if (v) return v; await sleep(10); }
  throw new Error('timed out waiting');
}
let n = 0;
const logFile = () => path.join(scratch, `log-${++n}.jsonl`);
const logged = (file) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);

// Real process: the fixture. `platform: 'win32'` makes the tree kill go through our `spawn` as a `taskkill` call, which we record and turn into a real kill.
function withFixture(t, fakeEnv = {}, over = {}) {
  const kills = [];
  const events = [];
  const exits = [];
  let child = null;
  const spawn = (file, args, opts) => {
    if (file === 'taskkill') { kills.push(args); try { child.kill('SIGKILL'); } catch { /* gone */ } return new EventEmitter(); }
    child = cp.spawn(file, args, { ...opts, stdio: ['pipe', 'pipe', 'ignore'] });
    return child;
  };
  const client = createRpcClient({ command: process.execPath, args: [FIXTURE], cwd: os.tmpdir(), env: { ...process.env, FAKE_PI: '1', ...fakeEnv }, spawn, platform: 'win32', onEvent: (e) => events.push(e), onExit: (e) => exits.push(e), ...over });
  t.after(() => client.close());
  return { client, kills, events, exits };
}

// In-process child: records every write, lets the test emit stdout by hand.
function fakeChild({ writeOk = () => true } = {}) {
  const c = new EventEmitter();
  c.pid = 4242;
  c.stdout = new EventEmitter();
  c.writes = [];
  c.stdin = Object.assign(new EventEmitter(), { write(s) { c.writes.push(s); return writeOk(s); }, end() {} });
  c.kill = () => {};
  c.said = (obj) => c.stdout.emit('data', `${typeof obj === 'string' ? obj : JSON.stringify(obj)}\n`);
  c.sent = () => c.writes.join('').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  return c;
}
function inProcess(t, child, over = {}) {
  const kills = [];
  const events = [];
  const exits = [];
  const spawn = (file, args) => { if (file === 'taskkill') { kills.push(args); return new EventEmitter(); } return child; };
  const client = createRpcClient({ command: 'C:\\x\\pi.exe', args: [], cwd: scratch, env: {}, spawn, platform: 'win32', onEvent: (e) => events.push(e), onExit: (e) => exits.push(e), ...over });
  t.after(() => client.close());
  return { client, kills, events, exits };
}
// Starts an in-process client and answers its get_state.
async function readyClient(t, over) {
  const child = fakeChild();
  const h = inProcess(t, child, over);
  const started = h.client.start();
  await until(() => child.sent().length >= 1);
  child.said({ id: child.sent()[0].id, type: 'response', command: 'get_state', success: true, data: { isStreaming: false } });
  await started;
  return { child, ...h };
}

// ---------- framing ----------
test('f1: records end ONLY at LF: U+2028 inside a JSON string does not split a record', async (t) => {
  const { client, events } = withFixture(t);
  await client.start();
  await client.request('prompt', { message: 'a\u2028b' });
  await until(() => events.some((e) => e.kind === 'event' && e.record.type === 'message_update'));
  const rec = events.filter((e) => e.kind === 'event' && e.record.type === 'message_update');
  assert.equal(rec.length, 1);
  assert.equal(rec[0].record.text, 'a\u2028b');
});

test('f2: CRLF line ends are accepted', async (t) => {
  const { client, events } = withFixture(t, { FAKE_CRLF: '1' });
  await client.start();
  await client.request('prompt', { message: 'hi' });
  await until(() => events.some((e) => e.kind === 'event' && e.record.type === 'agent_start'));
});

test('f3: a chunk that ends in the middle of a line is completed by the next one', async (t) => {
  const { client, events } = withFixture(t, { FAKE_SPLIT: '1' });
  await client.start();
  await client.request('prompt', { message: 'hi' });
  await until(() => events.some((e) => e.kind === 'event' && e.record.type === 'message_update'));
});

// ---------- startup ----------
test('s1: commands issued before ready are queued: only get_state is written until it is answered, then the rest go in order', async (t) => {
  const child = fakeChild();
  const { client } = inProcess(t, child);
  const started = client.start();
  const a = client.request('abort');
  const b = client.request('steer', { message: 'x' });
  await until(() => child.sent().length >= 1);
  await sleep(30);
  assert.deepEqual(child.sent().map((m) => m.type), ['get_state']);
  child.said({ id: child.sent()[0].id, type: 'response', command: 'get_state', success: true, data: {} });
  await started;
  assert.deepEqual(child.sent().map((m) => m.type), ['get_state', 'abort', 'steer']);
  const [, ca, cb] = child.sent();
  child.said({ id: ca.id, type: 'response', command: 'abort', success: true, data: { x: 1 } });
  child.said({ id: cb.id, type: 'response', command: 'steer', success: true, data: { y: 2 } });
  assert.deepEqual(await a, { x: 1 });
  assert.deepEqual(await b, { y: 2 });
});

test('s2: UI notices before the first answer are ignored and start resolves on the get_state answer', async (t) => {
  const { client, events } = withFixture(t, { FAKE_NOTICES: '1', FAKE_DELAY_MS: '100' });
  await client.start();
  assert.equal(client.state(), 'idle');
  assert.deepEqual(events.filter((e) => e.kind !== 'state'), []);
});

test('s3: the startup timeout rejects start with an RpcError and kills the tree', async (t) => {
  const { client, kills } = withFixture(t, { FAKE_DELAY_MS: '5000' }, { startTimeoutMs: 120 });
  await assert.rejects(client.start(), (e) => e instanceof RpcError);
  assert.equal(kills.length, 1);
  assert.equal(client.state(), 'closed');
});

test('s4: a spawn error rejects start and every pending request, and nothing is left running', async (t) => {
  const child = fakeChild();
  const { client, kills } = inProcess(t, child);
  const started = client.start();
  const pending = client.request('abort');
  child.emit('error', new Error('spawn EPERM C:\\secret'));
  await assert.rejects(started, (e) => e instanceof RpcError && !/secret|EPERM/.test(e.message));
  await assert.rejects(pending, (e) => e instanceof RpcError);
  assert.equal(client.state(), 'closed');
  assert.equal(kills.length, 1);
  const thrown = inProcess(t, null, { spawn: () => { throw new Error('boom'); } });
  await assert.rejects(thrown.client.start(), (e) => e instanceof RpcError);
});

test('s5: an early exit rejects start and the queued requests, calls onExit once and kills the tree', async (t) => {
  const { client, kills, exits } = withFixture(t, { FAKE_DIE: 'early' });
  const started = client.start();
  const queued = client.request('abort');
  await assert.rejects(started, (e) => e instanceof RpcError);
  await assert.rejects(queued, (e) => e instanceof RpcError);
  assert.equal(exits.length, 1);
  assert.equal(kills.length, 1);
  assert.equal(client.state(), 'closed');
});

test('s6: a command that is not allowed is never spawned', async (t) => {
  let spawned = 0;
  const { client } = inProcess(t, null, { command: 'pi; calc', spawn: () => { spawned++; return fakeChild(); } });
  await assert.rejects(client.start(), (e) => e instanceof RpcError);
  assert.equal(spawned, 0);
  const bare = inProcess(t, null, { command: 'pi', env: { PATH: '' }, spawn: () => { spawned++; return fakeChild(); } });
  await assert.rejects(bare.client.start(), (e) => e instanceof RpcError);
  assert.equal(spawned, 0, 'a bare name is looked up on the PATH, never in the repo folder');
});

test('s7: a request before start() is refused', async (t) => {
  const { client } = inProcess(t, fakeChild());
  await assert.rejects(client.request('abort'), (e) => e instanceof RpcError);
});

// ---------- requests ----------
test('r1: a request that is never answered times out with an RpcError, and the client keeps working', async (t) => {
  const { client } = withFixture(t, { FAKE_NO_ANSWER: 'prompt' });
  await client.start();
  await assert.rejects(client.request('prompt', { message: 'x' }, { timeoutMs: 100 }), (e) => e instanceof RpcError);
  assert.equal((await client.request('get_state')).sessionId, 'fake');
});

test('r2: a failed command rejects with a fixed message, never the agent text', async (t) => {
  const { client } = withFixture(t, { FAKE_RUN_MS: '600' });
  await client.start();
  assert.equal((await client.request('prompt', { message: 'a' })).disposition, 'started');
  await assert.rejects(client.request('prompt', { message: 'b' }), (e) => e instanceof RpcError && !/secret|home/.test(e.message) && e.message.length < 80);
  assert.equal((await client.request('prompt', { message: 'c', streamingBehavior: 'steer' })).disposition, 'queued');
});

test('r3: the client chooses the id and the type; the fields cannot override them', async (t) => {
  const { child, client } = await readyClient(t);
  void client.request('abort', { id: 'evil', type: 'prompt', message: 'x' }).catch(() => {});
  const sent = child.sent().at(-1);
  assert.equal(sent.type, 'abort');
  assert.notEqual(sent.id, 'evil');
  assert.equal(sent.message, 'x');
});

test('r4: a response with an unknown id, a broken line and a non-object line never throw', async (t) => {
  const { child, client } = await readyClient(t);
  child.said({ id: 'nobody', type: 'response', command: 'abort', success: true });
  child.said('{"broken');
  child.said('42');
  child.said('null');
  child.said('[1,2]');
  child.said('');
  const p = client.request('get_state');
  child.said({ id: child.sent().at(-1).id, type: 'response', command: 'get_state', success: true, data: { ok: 1 } });
  assert.deepEqual(await p, { ok: 1 });
});

test('r5: a line over 8 MB is dropped (even in many chunks) and the next record still works', async (t) => {
  const { child, client, events } = await readyClient(t);
  for (let i = 0; i < 9; i++) child.stdout.emit('data', 'x'.repeat(1024 * 1024));
  child.stdout.emit('data', '\n');
  child.stdout.emit('data', `${'y'.repeat(8 * 1024 * 1024 + 5)}\n`);
  const p = client.request('get_state');
  child.said({ id: child.sent().at(-1).id, type: 'response', command: 'get_state', success: true, data: { ok: 2 } });
  assert.deepEqual(await p, { ok: 2 });
  assert.deepEqual(events.filter((e) => e.kind === 'event'), []);
});

test('r6: garbage lines and a flood from a real process do not break the session', async (t) => {
  const { client } = withFixture(t, { FAKE_GARBAGE: '1', FAKE_FLOOD: String(8 * 1024 * 1024 + 100) });
  await client.start();
  await client.request('get_state');
  await sleep(300);
  assert.equal((await client.request('get_state')).sessionId, 'fake');
});

test('r7: stdin backpressure: nothing more is written until `drain`', async (t) => {
  let ok = true;
  const child = fakeChild({ writeOk: () => ok });
  const { client } = inProcess(t, child);
  const started = client.start();
  await until(() => child.sent().length >= 1);
  ok = false;
  child.said({ id: child.sent()[0].id, type: 'response', command: 'get_state', success: true, data: {} });
  await started;
  void client.request('abort').catch(() => {});
  void client.request('steer', { message: 'z' }).catch(() => {});
  await sleep(20);
  assert.deepEqual(child.sent().map((m) => m.type), ['get_state', 'abort'], 'the second write waits for drain');
  ok = true;
  child.stdin.emit('drain');
  assert.deepEqual(child.sent().map((m) => m.type), ['get_state', 'abort', 'steer']);
});

// ---------- dialogs ----------
const log = (file) => logged(file).filter((m) => m.type === 'extension_ui_response');
async function withDialog(t, kind, extra = {}) {
  const file = logFile();
  const h = withFixture(t, { FAKE_DIALOG: kind, FAKE_LOG: file, ...extra });
  await h.client.start();
  await h.client.request('prompt', { message: 'go' });
  await until(() => h.client.pendingDialogs().length === 1);
  return { ...h, file };
}

test('d1: a dialog is surfaced and kept pending; fire-and-forget records are dropped', async (t) => {
  const { client, events } = await withDialog(t, 'select');
  const [d] = client.pendingDialogs();
  assert.equal(d.id, 'd1');
  assert.equal(d.method, 'select');
  assert.equal(d.title, 'Allow?');
  assert.deepEqual(d.options, ['Yes', 'No']);
  assert.equal(client.state(), 'asking');
  assert.ok(events.some((e) => e.kind === 'dialog' && e.id === 'd1' && e.method === 'select'));
  assert.equal(events.some((e) => e.kind === 'event' && e.record.type === 'extension_ui_request'), false, 'no UI record goes out as an event');
});

test('d2: answerDialog refuses an id that is not pending, answers a pending one once', async (t) => {
  const { client, file } = await withDialog(t, 'select');
  assert.equal(client.answerDialog('invented', { value: 'Yes' }), false);
  assert.equal(client.answerDialog('n1', { value: 'Yes' }), false, 'a fire-and-forget id is not a dialog');
  await sleep(50);
  assert.deepEqual(log(file), []);
  assert.equal(client.answerDialog('d1', { value: 'Yes' }), true);
  assert.equal(client.answerDialog('d1', { value: 'No' }), false);
  await until(() => log(file).length === 1);
  await sleep(50);
  assert.deepEqual(log(file), [{ type: 'extension_ui_response', id: 'd1', value: 'Yes' }]);
  await until(() => client.state() === 'idle');
  assert.deepEqual(client.pendingDialogs(), []);
});

test('d3: the answer shape must fit the dialog: confirm takes `confirmed`, select takes `value`, any takes `cancelled`', async (t) => {
  const c = await withDialog(t, 'confirm');
  assert.equal(c.client.answerDialog('d1', { value: 'x' }), false);
  assert.equal(c.client.answerDialog('d1', { confirmed: 'yes' }), false);
  assert.equal(c.client.answerDialog('d1', { confirmed: true }), true);
  await until(() => log(c.file).length === 1);
  assert.deepEqual(log(c.file), [{ type: 'extension_ui_response', id: 'd1', confirmed: true }]);
  const s = await withDialog(t, 'select');
  assert.equal(s.client.answerDialog('d1', { confirmed: true }), false);
  assert.equal(s.client.answerDialog('d1', { value: 5 }), false);
  assert.equal(s.client.answerDialog('d1', { cancelled: true }), true);
  await until(() => log(s.file).length === 1);
  assert.deepEqual(log(s.file), [{ type: 'extension_ui_response', id: 'd1', cancelled: true }]);
});

test('d4: a dialog whose timeout passed is no longer pending nor answerable', async (t) => {
  const { client, file, events } = await withDialog(t, 'select', { FAKE_DIALOG_TIMEOUT: '150' });
  assert.ok(client.pendingDialogs()[0].expiresAt > Date.now() - 50);
  await sleep(300);
  assert.deepEqual(client.pendingDialogs(), []);
  assert.equal(client.answerDialog('d1', { value: 'Yes' }), false);
  assert.deepEqual(log(file), []);
  assert.ok(events.some((e) => e.kind === 'dialog-closed' && e.id === 'd1'));
});

test('d5: pending dialogs end with the process', async (t) => {
  const { client } = await withDialog(t, 'select');
  client.close();
  assert.deepEqual(client.pendingDialogs(), []);
  assert.equal(client.answerDialog('d1', { value: 'Yes' }), false);
});

// ---------- state ----------
test('t1: starting, idle, busy and idle again; agent_end makes the client read get_state again', async (t) => {
  const { child, client } = await readyClient(t);
  assert.equal(client.state(), 'idle');
  const p = client.request('prompt', { message: 'go' });
  child.said({ id: child.sent().at(-1).id, type: 'response', command: 'prompt', success: true, data: { disposition: 'started' } });
  await p;
  assert.equal(client.state(), 'busy');
  const before = child.sent().length;
  child.said({ type: 'agent_end' });
  await until(() => child.sent().length === before + 1);
  assert.equal(child.sent().at(-1).type, 'get_state');
  child.said({ id: child.sent().at(-1).id, type: 'response', command: 'get_state', success: true, data: { isStreaming: true } });
  await sleep(10);
  assert.equal(client.state(), 'busy', 'the agent says it still streams');
  child.said({ type: 'agent_settled' });
  await until(() => child.sent().length === before + 2);
  child.said({ id: child.sent().at(-1).id, type: 'response', command: 'get_state', success: true, data: { isStreaming: false } });
  await until(() => client.state() === 'idle');
});

test('t2: an agent_start event makes it busy; a queued prompt does not', async (t) => {
  const { child, client } = await readyClient(t);
  child.said({ type: 'agent_start' });
  assert.equal(client.state(), 'busy');
  const p = client.request('prompt', { message: 'x', streamingBehavior: 'steer' });
  child.said({ id: child.sent().at(-1).id, type: 'response', command: 'prompt', success: true, data: { disposition: 'queued' } });
  await p;
  assert.equal(client.state(), 'busy');
  const idle = await readyClient(t);
  const q = idle.client.request('prompt', { message: 'x' });
  idle.child.said({ id: idle.child.sent().at(-1).id, type: 'response', command: 'prompt', success: true, data: { disposition: 'handled' } });
  await q;
  assert.equal(idle.client.state(), 'idle');
});

test('t3: from a real process: busy while it runs, then idle', async (t) => {
  const { client } = withFixture(t, { FAKE_RUN_MS: '150' });
  await client.start();
  await client.request('prompt', { message: 'go' });
  assert.equal(client.state(), 'busy');
  await until(() => client.state() === 'idle');
});

test('t4: the events of the session go to onEvent as data, in order', async (t) => {
  const { client, events } = withFixture(t, { FAKE_RUN_MS: '50' });
  await client.start();
  await client.request('prompt', { message: 'go' });
  await until(() => events.some((e) => e.kind === 'event' && e.record.type === 'agent_settled'));
  const types = events.filter((e) => e.kind === 'event').map((e) => e.record.type);
  assert.deepEqual(types.slice(0, 2), ['agent_start', 'message_update']);
  assert.ok(types.indexOf('agent_end') < types.indexOf('agent_settled'));
});

// ---------- close ----------
test('x1: close() kills the tree once, rejects pending requests, is idempotent and later writes fail without throwing', async (t) => {
  const { child, client, kills, exits } = await readyClient(t);
  const pending = client.request('abort');
  client.close();
  client.close();
  await assert.rejects(pending, (e) => e instanceof RpcError);
  assert.equal(kills.length, 1);
  assert.equal(kills[0][0], '/PID');
  assert.equal(client.state(), 'closed');
  assert.equal(exits.length, 1);
  await assert.rejects(client.request('abort'), (e) => e instanceof RpcError);
  assert.equal(client.answerDialog('d1', { value: 'x' }), false);
  child.said({ type: 'agent_start' });
  child.emit('exit', 0);
  child.emit('close', 0);
  assert.equal(exits.length, 1);
  assert.equal(kills.length, 1);
});

test('x2: on POSIX the tree is killed through its process group', async (t) => {
  const child = fakeChild();
  const killed = [];
  const { client } = inProcess(t, child, { platform: 'linux', kill: (pid, sig) => killed.push([pid, sig]) });
  const started = client.start();
  await until(() => child.sent().length >= 1);
  child.said({ id: child.sent()[0].id, type: 'response', command: 'get_state', success: true, data: {} });
  await started;
  client.close();
  assert.deepEqual(killed, [[-4242, 'SIGKILL']]);
});
