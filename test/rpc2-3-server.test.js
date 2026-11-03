'use strict';
// RPC2-3 (S1, S6, S8), server side. HIGH RISK: the person answers a PERMISSION that lets the agent run a command. The client (server/rpc.js)
// refuses every answer whose shape does not fit the pending dialog, nothing is written to the agent when it refuses, and the route answers
// a fixed 400. What leaves the server is capped and flagged `truncated`. The agent is an in-process fake child that records every write.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'rpc2-3-server-'));
const REPO = path.join(scratch, 'My Repo');
fs.mkdirSync(REPO);
process.env.REPO_PANEL_CONFIG = path.join(scratch, 'config.json');
test.after(() => fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 5 }));

const lib = require('../lib.js');
const { createRpcClient } = require('../server/rpc.js');
const { createRpcHost } = require('../server/rpchost.js');
const { createServer } = require('../server/http.js');
const { findRepo } = require('../server/config.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 3000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = fn(); if (v) return v; await sleep(5); }
  throw new Error('timed out waiting');
}

// The fake agent: answers get_state by itself, records every line written to it, and raises dialogs on demand.
function fakeChild() {
  const c = new EventEmitter();
  c.pid = 4242;
  c.stdout = new EventEmitter();
  c.writes = [];
  c.stdin = Object.assign(new EventEmitter(), {
    write(s) {
      c.writes.push(s);
      for (const l of s.split('\n').filter(Boolean)) { const m = JSON.parse(l); if (m.type === 'get_state') setImmediate(() => c.said({ id: m.id, type: 'response', command: 'get_state', success: true, data: { isStreaming: false } })); }
      return true;
    },
    end() {},
  });
  c.kill = () => {};
  c.said = (obj) => c.stdout.emit('data', `${JSON.stringify(obj)}\n`);
  c.sent = () => c.writes.join('').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  c.responses = () => c.sent().filter((m) => m.type === 'extension_ui_response');
  return c;
}
const spawnOf = (child) => (file) => (file === 'taskkill' ? new EventEmitter() : child);
async function agent(t, over = {}) {
  const child = fakeChild();
  const events = [];
  const client = createRpcClient({ command: 'C:\\x\\pi.exe', args: [], cwd: scratch, env: {}, spawn: spawnOf(child), platform: 'win32', onEvent: (e) => events.push(e), ...over });
  t.after(() => client.close());
  await client.start();
  return { child, client, events };
}
async function asking(t, dialog, over) {
  const a = await agent(t, over);
  a.child.said({ type: 'extension_ui_request', id: 'q1', ...dialog });
  await until(() => a.client.pendingDialogs().length === 1);
  return a;
}
const CONFIRM = { method: 'confirm', title: 'Allow guarded git push?', message: 'git push origin HEAD', options: [] };
const SELECT = { method: 'select', title: 'Pick one', options: ['Yes', 'No', 'Allow once'] };
const INPUT = { method: 'input', title: 'Enter a value', message: '', options: [] };
const EDITOR = { method: 'editor', title: 'Edit some text', message: '', options: [] };
// Refused: false, nothing written, the dialog still pending.
function refuses(a, id, answers) {
  for (const x of answers) {
    assert.equal(a.client.answerDialog(id, x), false, String(JSON.stringify(x)).slice(0, 80));
    assert.deepEqual(a.child.responses(), [], `nothing is written: ${String(JSON.stringify(x)).slice(0, 60)}`);
    assert.equal(a.client.pendingDialogs().length, 1, 'the dialog stays pending');
  }
}

// ---------- the shape must fit the method ----------
test('a1: a confirm takes exactly {confirmed: boolean} or {cancelled: true}; anything else is refused and writes nothing', async (t) => {
  const a = await asking(t, CONFIRM);
  refuses(a, 'q1', [
    undefined, null, 'true', 5, [], [true], {}, { confirmed: 'true' }, { confirmed: 'yes' }, { confirmed: 1 }, { confirmed: 0 }, { confirmed: null }, { confirmed: [true] },
    { value: 'Yes' }, { value: true }, { confirmed: true, value: 'x' }, { confirmed: true, command: 'calc.exe' }, { confirmed: false, path: 'C:\\x' },
    { confirmed: true, cancelled: true }, { cancelled: false }, { cancelled: 'true' }, { cancelled: 1 }, { cancelled: true, command: 'x' }, { cancelled: true, confirmed: false },
  ]);
  assert.equal(a.client.answerDialog('q1', { confirmed: false }), true);
  await until(() => a.child.responses().length === 1);
  assert.deepEqual(a.child.responses(), [{ type: 'extension_ui_response', id: 'q1', confirmed: false }]);
  assert.equal(a.client.answerDialog('q1', { confirmed: true }), false, 'once only');
  assert.equal(a.child.responses().length, 1);
});

test('a2: a select takes {value} ONLY when it is strictly one of the options; a prefix, another case, a trailing space and __proto__ are refused', async (t) => {
  const a = await asking(t, SELECT);
  refuses(a, 'q1', [
    { value: 'Y' }, { value: 'yes' }, { value: 'YES' }, { value: 'Yes ' }, { value: ' Yes' }, { value: 'Yes\n' }, { value: 'Allow' }, { value: 'Allow once!' }, { value: '' },
    { value: '__proto__' }, { value: 'constructor' }, { value: 'toString' }, { value: 'length' }, { value: '0' }, { value: 0 }, { value: null }, { value: ['Yes'] }, { value: { 0: 'Yes' } }, { value: true },
    { confirmed: true }, { confirmed: false }, { value: 'Yes', confirmed: true }, { value: 'Yes', command: 'x' }, { value: 'Yes', path: 'x' }, { value: 'Yes', cancelled: true }, {}, null, 'Yes', ['Yes'],
  ]);
  assert.equal(a.client.answerDialog('q1', { value: 'No' }), true);
  await until(() => a.child.responses().length === 1);
  assert.deepEqual(a.child.responses(), [{ type: 'extension_ui_response', id: 'q1', value: 'No' }]);
});

test('a3: an input and an editor take {value: string} (LF and TAB allowed, up to 4000) and refuse controls, size, arrays, objects and extra keys', async (t) => {
  for (const dialog of [INPUT, EDITOR]) {
    const a = await asking(t, dialog);
    refuses(a, 'q1', [
      { value: 'a\u0000b' }, { value: 'a\u0007b' }, { value: 'a\u001b[31m' }, { value: 'a\rb' }, { value: 'a\u007fb' }, { value: 'a\u009bb' }, { value: 'x'.repeat(4001) },
      { value: ['x'] }, { value: { a: 1 } }, { value: 5 }, { value: null }, { value: true }, {}, { confirmed: true }, { value: 'ok', confirmed: false }, { value: 'ok', command: 'x' }, { value: 'ok', path: 'x' }, { value: 'ok', cancelled: true },
    ]);
    assert.equal(a.client.answerDialog('q1', { value: 'line1\nline2\ttab' }), true, dialog.method);
    await until(() => a.child.responses().length === 1);
    assert.deepEqual(a.child.responses(), [{ type: 'extension_ui_response', id: 'q1', value: 'line1\nline2\ttab' }]);
  }
  const edge = await asking(t, INPUT);
  assert.equal(edge.client.answerDialog('q1', { value: 'x'.repeat(4000) }), true, '4000 characters is the limit');
});

test('a4: {cancelled: true} is accepted for every method, alone', async (t) => {
  for (const dialog of [CONFIRM, SELECT, INPUT, EDITOR]) {
    const a = await asking(t, dialog);
    assert.equal(a.client.answerDialog('q1', { cancelled: true }), true, dialog.method);
    await until(() => a.child.responses().length === 1);
    assert.deepEqual(a.child.responses(), [{ type: 'extension_ui_response', id: 'q1', cancelled: true }]);
  }
});

test('a5: an id that is not pending, already answered or expired is refused and writes nothing', async (t) => {
  const a = await asking(t, { ...CONFIRM, timeout: 60 });
  assert.equal(a.client.answerDialog('nope', { confirmed: true }), false);
  assert.equal(a.client.answerDialog('__proto__', { confirmed: true }), false);
  assert.equal(a.client.answerDialog(undefined, { confirmed: true }), false);
  await sleep(150);
  assert.equal(a.client.answerDialog('q1', { confirmed: true }), false, 'expired');
  const b = await asking(t, CONFIRM);
  assert.equal(b.client.answerDialog('q1', { confirmed: false }), true);
  assert.equal(b.client.answerDialog('q1', { confirmed: true }), false, 'answered once');
  await sleep(30);
  assert.deepEqual(a.child.responses(), []);
  assert.equal(b.child.responses().length, 1);
});

// ---------- what leaves the server ----------
const KEYS = ['expiresAt', 'message', 'method', 'options', 'requestId', 'title', 'truncated'];
test('c1: an uncut dialog carries exactly requestId, method, title, message, options, expiresAt and truncated:false (event and status)', async (t) => {
  const a = await asking(t, CONFIRM);
  const ev = a.events.find((e) => e.kind === 'dialog');
  const host = createRpcHost({ resolve: async () => ({ active: { id: 'g', command: 'C:\\x\\pi.exe', agentDir: 'C:\\a' } }), repoOf: () => ({ id: 'a', path: scratch }), publish: () => {}, createClient: () => a.client, adoptedOf: () => null });
  await host.start('a');
  const st = (await host.status('a')).pendingDialogs[0];
  assert.deepEqual(Object.keys(st).sort(), KEYS);
  assert.deepEqual(st, { requestId: 'q1', method: 'confirm', title: CONFIRM.title, message: CONFIRM.message, options: [], expiresAt: null, truncated: false });
  assert.equal(ev.truncated, false);
  assert.equal(ev.id, 'q1');
});

test('c2: a title over 300, a message over 4000, more than 20 options or an option over 200 is cut and flagged truncated:true', async (t) => {
  const cases = [
    [{ ...CONFIRM, title: 'T'.repeat(301) }, (d) => d.title.length === 300],
    [{ ...CONFIRM, message: 'M'.repeat(5000) }, (d) => d.message.length === 4000],
    [{ ...SELECT, options: Array.from({ length: 21 }, (_, i) => `o${i}`) }, (d) => d.options.length === 20],
    [{ ...SELECT, options: ['x'.repeat(201), 'ok'] }, (d) => d.options[0].length === 200 && d.options[1] === 'ok'],
  ];
  for (const [dialog, cut] of cases) {
    const a = await asking(t, dialog);
    const [d] = a.client.pendingDialogs();
    assert.equal(d.truncated, true, JSON.stringify(dialog).slice(0, 40));
    assert.ok(cut(d));
    assert.equal(a.events.find((e) => e.kind === 'dialog').truncated, true);
  }
  const exact = await asking(t, { ...CONFIRM, title: 'T'.repeat(300), message: 'M'.repeat(4000) });
  assert.equal(exact.client.pendingDialogs()[0].truncated, false, 'exactly at the caps is not cut');
});

test('c3: an option that was cut is not answerable (the agent would not know the cut text); the uncut ones are', async (t) => {
  const long = 'x'.repeat(250);
  const a = await asking(t, { ...SELECT, options: [long, 'No'] });
  refuses(a, 'q1', [{ value: long }, { value: long.slice(0, 200) }]);
  assert.equal(a.client.answerDialog('q1', { value: 'No' }), true);
});

// ---------- the route ----------
const ID = lib.repoId(REPO);
const freePort = () => new Promise((resolve) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });
const call = (port, method, p, { token, body } = {}) => new Promise((resolve, reject) => {
  const data = body === undefined ? null : JSON.stringify(body);
  const req = http.request({ host: '127.0.0.1', port, path: p, method, headers: { ...(token ? { 'x-token': token } : {}), ...(data ? { 'content-type': 'application/json' } : {}) } }, (res) => {
    let d = ''; res.on('data', (c) => { d += c; }); res.on('end', () => { let json = null; try { json = JSON.parse(d); } catch { /* not json */ } resolve({ status: res.statusCode, body: d, json }); });
  });
  req.on('error', reject);
  req.end(data);
});
async function withRoute(fn) {
  fs.writeFileSync(process.env.REPO_PANEL_CONFIG, JSON.stringify({ groups: [{ name: 'g', repos: [{ path: REPO }] }] }));
  const child = fakeChild();
  const published = [];
  const host = createRpcHost({
    resolve: async () => ({ active: { id: 'g', command: 'C:\\x\\pi.exe', agentDir: 'C:\\a' } }), repoOf: findRepo, publish: (id, p) => published.push(p), adoptedOf: () => null,
    createClient: (o) => createRpcClient({ ...o, spawn: spawnOf(child), platform: 'win32' }),
  });
  const port = await freePort();
  const server = createServer(port, { noSummaryStore: true, rpcHost: host });
  await new Promise((r) => server.listen(port, '127.0.0.1', r));
  try {
    const token = /name="?token"? content="([0-9a-f]+)"/.exec((await call(port, 'GET', '/')).body)[1];
    const post = (p, body, tok = token) => call(port, 'POST', p, { token: tok, body });
    await post('/api/rpc/start', { id: ID });
    return await fn({ port, token, post, child, published, status: () => call(port, 'GET', `/api/rpc/status?id=${ID}`, { token }) });
  } finally { await new Promise((r) => server.close(r)); }
}
const raise = async (child, dialog) => { child.said({ type: 'extension_ui_request', id: 'q1', ...dialog }); await until(() => child.sent().length >= 1); await sleep(10); };

test('r1: through the route, a wrong shape is a fixed 400 that echoes nothing, writes nothing and leaves the dialog pending', async () => {
  await withRoute(async ({ post, child, status }) => {
    await raise(child, CONFIRM);
    const base = { id: ID, requestId: 'q1' };
    const bad = [
      { ...base, value: 'ECHO-ME' }, { ...base, confirmed: 'true' }, { ...base, confirmed: 1 }, { ...base, confirmed: null }, { ...base, confirmed: true, value: 'ECHO-ME' }, { ...base, confirmed: true, cancelled: true },
      { ...base, confirmed: true, command: 'calc.exe' }, { ...base, confirmed: true, path: 'C:\\ECHO-ME' }, { ...base, cancelled: true, command: 'x' }, { ...base }, { ...base, cancelled: 'true' },
    ];
    for (const b of bad) {
      const r = await post('/api/rpc/dialog', b);
      assert.equal(r.status, 400, JSON.stringify(b));
      assert.equal(r.body.includes('ECHO-ME') || r.body.includes('calc'), false, 'the input is not echoed');
    }
    assert.deepEqual(child.responses(), []);
    assert.equal((await status()).json.pendingDialogs.length, 1);
    assert.equal((await post('/api/rpc/dialog', { ...base, confirmed: false })).status, 200);
    assert.deepEqual(child.responses(), [{ type: 'extension_ui_response', id: 'q1', confirmed: false }]);
  });
});

test('r2: through the route, a select value that is not in the options is 400 with the same fixed message as any other refusal', async () => {
  await withRoute(async ({ post, child }) => {
    await raise(child, SELECT);
    const msgs = new Set();
    for (const value of ['Y', 'yes', 'Yes ', '__proto__', 'Allow always', ['Yes'], { a: 1 }, 'a\u0007b']) {
      const r = await post('/api/rpc/dialog', { id: ID, requestId: 'q1', value });
      assert.equal(r.status, 400, JSON.stringify(value));
      msgs.add(r.json.error);
    }
    assert.equal((await post('/api/rpc/dialog', { id: ID, requestId: 'q1', confirmed: true })).status, 400);
    assert.deepEqual(child.responses(), []);
    assert.equal(msgs.size, 1, 'one fixed message');
    assert.equal((await post('/api/rpc/dialog', { id: ID, requestId: 'q1', value: 'Yes' })).status, 200);
  });
});

test('r3: an id that is not pending, answered twice or without a token is refused (409, 409, 401) and writes nothing more', async () => {
  await withRoute(async ({ post, child }) => {
    await raise(child, CONFIRM);
    assert.equal((await post('/api/rpc/dialog', { id: ID, requestId: 'q1', confirmed: false }, null)).status, 401);
    assert.equal((await post('/api/rpc/dialog', { id: ID, requestId: 'ECHO-ME', confirmed: true })).status, 409);
    assert.equal((await post('/api/rpc/dialog', { id: ID, requestId: 'q1', confirmed: false })).status, 200);
    const again = await post('/api/rpc/dialog', { id: ID, requestId: 'q1', confirmed: true });
    assert.equal(again.status, 409);
    assert.equal(again.body.includes('ECHO-ME'), false);
    assert.deepEqual(child.responses(), [{ type: 'extension_ui_response', id: 'q1', confirmed: false }]);
  });
});

test('r4: a 5000-character message reaches the page cut to 4000 with truncated:true, in the SSE payload and in the status', async () => {
  await withRoute(async ({ child, published, status }) => {
    await raise(child, { ...CONFIRM, message: 'M'.repeat(5000) });
    const ev = published.find((p) => p.kind === 'dialog');
    assert.equal(ev.message.length, 4000);
    assert.equal(ev.truncated, true);
    assert.equal(ev.requestId, 'q1');
    const [d] = (await status()).json.pendingDialogs;
    assert.equal(d.message.length, 4000);
    assert.equal(d.truncated, true);
  });
});

// ---------- removal ----------
test('x1: server/dialoganswer.js is gone, POST /api/dialog/answer is 404 and piBusy is not exported; the other routes still answer', async () => {
  assert.equal(fs.existsSync(path.join(__dirname, '..', 'server', 'dialoganswer.js')), false);
  assert.equal('piBusy' in require('../server/pi.js'), false);
  assert.equal('piDialogMovedDown' in lib, false);
  await withRoute(async ({ port, token, post, status }) => {
    assert.equal((await post('/api/dialog/answer', { id: ID, fingerprint: '0123456789abcdef', index: 0 })).status, 404);
    assert.equal((await status()).status, 200);
    assert.equal((await call(port, 'GET', '/api/config', { token })).status, 200);
    assert.equal((await call(port, 'GET', `/api/rpc/status?id=${ID}`, {})).status, 401);
  });
});
