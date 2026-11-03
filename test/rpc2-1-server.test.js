'use strict';
// RPC2-1 (S1, S6, S8), server side: what the host publishes to the page (a per-type whitelist, never the system prompt), the dialog id as
// `requestId` in the status, the adoption of the session id by `rpc/start`, and the routes and the file this unit removes.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'rpc2-1-server-'));
const REPO = path.join(scratch, 'My Repo');
fs.mkdirSync(REPO);
process.env.REPO_PANEL_CONFIG = path.join(scratch, 'config.json');
test.after(() => fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 5 }));

const lib = require('../lib.js');
const { createServer } = require('../server/http.js');
const { createRpcHost } = require('../server/rpchost.js');
const { adoptIfNone } = require('../server/sessions.js');
const { loadConfig } = require('../server/config.js');
const { createEventHub } = require('../server/events.js');

const ID = lib.repoId(REPO);
const ACTIVE = { id: 'gentle-shell', command: 'C:\\L\\gentle-shell.exe', agentDir: 'C:\\a' };
const writeConfig = (extra = {}) => fs.writeFileSync(process.env.REPO_PANEL_CONFIG, JSON.stringify({ groups: [{ name: 'g', repos: [{ path: REPO }] }], ...extra }));
const repoOf = (id) => ({ id, path: 'C:\\repos\\alpha' });

function fakeFactory(over = {}) {
  const made = [];
  const createClient = (opts) => {
    const c = { opts, closed: 0, start: async () => ({}), request: async () => ({}), answerDialog: () => false, pendingDialogs: () => [], state: () => 'idle', close: () => { c.closed++; }, ...over };
    made.push(c);
    return c;
  };
  return { made, createClient };
}
async function hostWith(over = {}, client = {}) {
  const f = fakeFactory(client);
  const published = [];
  const host = createRpcHost({ resolve: async () => ({ active: ACTIVE }), repoOf, publish: (id, p) => published.push(p), createClient: f.createClient, adoptedOf: () => null, ...over });
  await host.start('aaa');
  return { host, published, made: f.made, emit: (e) => f.made[0].opts.onEvent(e) };
}
const events = (published) => published.filter((p) => p.kind === 'event').map((p) => p.record);

// ---------- the whitelist ----------
const SYSTEM = 'S'.repeat(200 * 1024);

test('w1: a record that carries the system prompt never reaches the hub with it (message_start, message_end, agent_end, sections)', async () => {
  const { published, emit } = await hostWith();
  emit({ kind: 'event', record: { type: 'message_start', message: { role: 'system', content: [{ type: 'text', text: SYSTEM }] }, sections: [SYSTEM] } });
  emit({ kind: 'event', record: { type: 'message_end', message: { role: 'system', content: SYSTEM } } });
  emit({ kind: 'event', record: { type: 'agent_end', messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: 'hi' }] } });
  assert.deepEqual(events(published), [{ type: 'message_start' }, { type: 'message_end' }, { type: 'agent_end' }]);
  assert.ok(JSON.stringify(published).length < 1000);
});

test('w2: tool_execution_* keep only the name, the error flag and the duration; no args and no result', async () => {
  const { published, emit } = await hostWith();
  emit({ kind: 'event', record: { type: 'tool_execution_start', toolName: 'read', args: { path: 'C:\\secret' }, toolCallId: 't1' } });
  emit({ kind: 'event', record: { type: 'tool_execution_end', toolName: 'read', isError: false, durationMs: 12, result: { content: 'r'.repeat(300000) }, extra: 1 } });
  assert.deepEqual(events(published), [{ type: 'tool_execution_start', toolName: 'read' }, { type: 'tool_execution_end', toolName: 'read', isError: false, durationMs: 12 }]);
});

test('w3: the streaming text and the end of a run do reach the hub', async () => {
  const { published, emit } = await hostWith();
  emit({ kind: 'event', record: { type: 'agent_start' } });
  emit({ kind: 'event', record: { type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 1, delta: 'Hel', partial: { big: SYSTEM } }, message: { content: SYSTEM } } });
  emit({ kind: 'event', record: { type: 'message_update', assistantMessageEvent: { type: 'text_end', contentIndex: 1, content: 'Hello' } } });
  emit({ kind: 'event', record: { type: 'message_update', assistantMessageEvent: { type: 'text_end', contentIndex: 2, content: 'x'.repeat(9000) } } });
  emit({ kind: 'event', record: { type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', contentIndex: 0, delta: 'hmm' } } });
  emit({ kind: 'event', record: { type: 'turn_end', stopReason: 'stop', message: { role: 'assistant', content: [{ type: 'text', text: 'Hello' }, { type: 'toolCall', arguments: SYSTEM }] }, toolResults: [SYSTEM] } });
  emit({ kind: 'event', record: { type: 'agent_settled', aborted: false, junk: 1 } });
  assert.deepEqual(events(published), [
    { type: 'agent_start' },
    { type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 1, delta: 'Hel' } },
    { type: 'message_update', assistantMessageEvent: { type: 'text_end', contentIndex: 1, content: 'Hello' } },
    { type: 'message_update', assistantMessageEvent: { type: 'text_end', contentIndex: 2 } },
    { type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', contentIndex: 0 } }, // only the text blocks keep their words (t4 of rpc2-1-resilience)
    { type: 'turn_end', stopReason: 'stop', text: 'Hello' },
    { type: 'agent_settled', aborted: false },
  ]);
});

test('w4: an unknown type, a record without a type and a non-object become {type} or nothing', async () => {
  const { published, emit } = await hostWith();
  emit({ kind: 'event', record: { type: 'queue_update', steering: [SYSTEM] } });
  emit({ kind: 'event', record: { type: 'huge', text: 'z'.repeat(400000) } });
  emit({ kind: 'event', record: { nothing: SYSTEM } });
  emit({ kind: 'event', record: 'text' });
  emit({ kind: 'event', record: null });
  assert.deepEqual(events(published), [{ type: 'queue_update' }, { type: 'huge' }, {}, {}, {}]);
});

test('w5: state, dialog and exit still pass as they were (the dialog id travels as requestId)', async () => {
  const { published, emit } = await hostWith();
  emit({ kind: 'state', state: 'busy' });
  emit({ kind: 'dialog', id: 'd1', method: 'confirm', title: 'T' });
  emit({ kind: 'dialog-closed', id: 'd1', reason: 'answered' });
  assert.deepEqual(published.filter((p) => p.kind !== 'exit'), [{ kind: 'state', state: 'busy' }, { kind: 'dialog', requestId: 'd1', method: 'confirm', title: 'T' }, { kind: 'dialog-closed', requestId: 'd1', reason: 'answered' }]);
});

// ---------- status ----------
test('s1: the status names a pending dialog by requestId, like the SSE dialog event', async () => {
  const { host } = await hostWith({}, { pendingDialogs: () => [{ id: 'd9', method: 'select', title: 'T', options: ['a'] }], state: () => 'asking' });
  assert.deepEqual(await host.status('aaa'), { state: 'asking', pendingDialogs: [{ requestId: 'd9', method: 'select', title: 'T', options: ['a'] }], sessionId: 'panel-alpha' });
});

// ---------- adoption ----------
test('a1: adoptIfNone writes the id once, never overwrites and never writes an invalid id', () => {
  writeConfig();
  assert.equal(adoptIfNone(ID, 'panel-my-repo'), true);
  const stored = loadConfig().sessions[ID];
  assert.equal(stored.id, 'panel-my-repo');
  assert.equal(stored.name, 'panel-my-repo');
  assert.ok(!Number.isNaN(Date.parse(stored.adoptedAt)));
  assert.equal(adoptIfNone(ID, 'panel-my-repo'), false, 'idempotent');
  assert.equal(adoptIfNone(ID, 'other-id'), false, 'never overwrites');
  assert.equal(loadConfig().sessions[ID].id, 'panel-my-repo');
  writeConfig();
  for (const bad of ['', '../x', 'a b', 'x'.repeat(81), null, undefined, 5, { id: 'a' }]) assert.equal(adoptIfNone(ID, bad), false);
  assert.equal(loadConfig().sessions, undefined);
});

test('a2: a start that creates the session adopts the id it used; a failed start adopts nothing', async () => {
  const calls = [];
  const { host } = await hostWith({ adopt: (id, sid) => calls.push([id, sid]) });
  assert.deepEqual(calls, [['aaa', 'panel-alpha']]);
  await host.start('aaa');
  assert.equal(calls.length, 1, 'the second start returns the live one and adopts nothing more');
  const failing = [];
  const f = fakeFactory({ start: async () => { throw new Error('boom'); } });
  const h2 = createRpcHost({ resolve: async () => ({ active: ACTIVE }), repoOf, publish: () => {}, createClient: f.createClient, adoptedOf: () => null, adopt: (id, sid) => failing.push([id, sid]) });
  await assert.rejects(h2.start('aaa'), (e) => e.status === 502);
  assert.deepEqual(failing, []);
});

test('a3: a failing adoption never fails the start', async () => {
  const { host } = await hostWith({ adopt: () => { throw new Error('disk full'); } });
  assert.equal((await host.status('aaa')).state, 'idle');
});

const freePort = () => new Promise((resolve) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });
const call = (port, method, p, { token, body } = {}) => new Promise((resolve, reject) => {
  const data = body === undefined ? null : JSON.stringify(body);
  const req = http.request({ host: '127.0.0.1', port, path: p, method, headers: { ...(token ? { 'x-token': token } : {}), ...(data ? { 'content-type': 'application/json' } : {}) } }, (res) => {
    let d = ''; res.on('data', (c) => { d += c; }); res.on('end', () => { let json = null; try { json = JSON.parse(d); } catch { /* not json */ } resolve({ status: res.statusCode, body: d, json }); });
  });
  req.on('error', reject);
  req.end(data);
});
async function withServer(fn) {
  const f = fakeFactory();
  const port = await freePort();
  const server = createServer(port, { noSummaryStore: true, hub: createEventHub(), rpcResolve: async () => ({ active: ACTIVE }), rpcClient: f.createClient });
  await new Promise((r) => server.listen(port, '127.0.0.1', r));
  try {
    const token = /name="?token"? content="([0-9a-f]+)"/.exec((await call(port, 'GET', '/')).body)[1];
    return await fn({ port, token, post: (p, body) => call(port, 'POST', p, { token, body }) });
  } finally { await new Promise((r) => server.close(r)); }
}

test('a4: POST /api/rpc/start adopts the session id of a repo with none; with one adopted it leaves it alone', async () => {
  writeConfig();
  await withServer(async ({ post }) => {
    assert.equal((await post('/api/rpc/start', { id: ID })).status, 200);
    assert.equal(loadConfig().sessions[ID].id, 'panel-my-repo');
  });
  writeConfig({ sessions: { [ID]: { id: 'mine-1', name: 'Mine', adoptedAt: '2026-01-01T00:00:00.000Z' } } });
  await withServer(async ({ post }) => {
    assert.equal((await post('/api/rpc/start', { id: ID })).status, 200);
    assert.deepEqual(loadConfig().sessions[ID], { id: 'mine-1', name: 'Mine', adoptedAt: '2026-01-01T00:00:00.000Z' });
  });
});

// ---------- removed ----------
test('r1: the old send routes and the session start are gone (404) and chatsend.js no longer exists', async () => {
  writeConfig();
  assert.equal(fs.existsSync(path.join(__dirname, '..', 'server', 'chatsend.js')), false);
  assert.equal(typeof require('../server/sessions.js').startSession, 'undefined');
  await withServer(async ({ post }) => {
    for (const p of ['/api/chat/send', '/api/chat/clear', '/api/sessions/start']) assert.equal((await post(p, { id: ID, text: 'x' })).status, 404, p);
  });
});

test('r2: what stays still works: GET /api/chat reads the history of the adopted session; adopt and release answer', async () => {
  const base = path.join(scratch, 'sessions');
  const dir = path.join(base, `--${REPO.replace(/[:\\/]/g, '-')}--`);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '2026-01-01T00-00-00-000Z_mine-1.jsonl'), [
    JSON.stringify({ type: 'session', id: 'mine-1', timestamp: '2026-01-01T00:00:00.000Z', cwd: REPO }),
    JSON.stringify({ type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'hello' }] } }),
    JSON.stringify({ type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: 'hi there' }] } }),
  ].join('\n'));
  writeConfig();
  const prev = process.env.REPO_PANEL_SESSIONS_DIR;
  process.env.REPO_PANEL_SESSIONS_DIR = base;
  try {
    await withServer(async ({ port, token, post }) => {
      assert.equal((await post('/api/sessions/adopt', { id: ID, session: 'mine-1' })).status, 200);
      const chat = await call(port, 'GET', `/api/chat?id=${ID}`, { token });
      assert.deepEqual(chat.json.items.map((i) => [i.role, i.text]), [['user', 'hello'], ['assistant', 'hi there']]);
      assert.equal((await post('/api/sessions/release', { id: ID })).status, 200);
    });
  } finally { if (prev === undefined) delete process.env.REPO_PANEL_SESSIONS_DIR; else process.env.REPO_PANEL_SESSIONS_DIR = prev; }
});
