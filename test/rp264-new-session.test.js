'use strict';
// RP264 (S1, S4-S6), the server: a new session of a live pi with pi's own `new_session`, on the same process. `/new` typed in the chat goes there instead of reaching pi as a
// message (the bug: it stayed working with no answer), the new id becomes the adopted one (a restart comes back to it), and only a free session may do it. No process is started:
// the client is a fake that answers like pi 4.9 did when tried for real (new_session -> { cancelled: false }, then get_state names a new uuid).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'rp264-'));
const REPO = path.join(scratch, 'My Repo');
fs.mkdirSync(REPO);
process.env.REPO_PANEL_CONFIG = path.join(scratch, 'config.json');
test.after(() => fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 5 }));

const lib = require('../lib.js');
const { createServer } = require('../server/http.js');
const { createRpcHost, rpcApi } = require('../server/rpchost.js');
const { replaceAdopted } = require('../server/sessions.js');
const { loadConfig } = require('../server/config.js');
const { createEventHub } = require('../server/events.js');

const ACTIVE = { id: 'gentle-shell', command: 'C:\\L\\gentle-shell.cmd', agentDir: 'C:\\a' };
const NEW_ID = '01a1fffd-dd11-73fa-95de-94be294bd771';
const repoOf = (id) => { if (id !== 'aaa') { const e = new Error('Unknown repository'); e.status = 404; throw e; } return { id, path: 'C:\\repos\\alpha' }; };
const gate = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };

// `answers` maps a request type to its answer (a function may hold it); `state` is what the client says.
function setup({ answers = {}, state = 'idle' } = {}) {
  const made = [];
  const published = [];
  const replaced = [];
  const createClient = (opts) => {
    const c = {
      opts, closed: 0, reqs: [], state: () => c.now, now: state,
      start: async () => ({}),
      close() { c.closed++; return Promise.resolve(); },
      request: async (type, fields) => {
        c.reqs.push(type);
        const a = Object.hasOwn(answers, type) ? answers[type] : type === 'new_session' ? { cancelled: false } : type === 'get_state' ? { sessionId: NEW_ID, sessionFile: 'x.jsonl' } : {};
        return typeof a === 'function' ? a(fields) : a;
      },
      answerDialog: () => false, pendingDialogs: () => [], outcome: () => ({ kind: 'done', at: 1 }),
    };
    made.push(c);
    return c;
  };
  const host = createRpcHost({ resolve: async () => ({ active: ACTIVE }), repoOf, createClient, adoptedOf: () => null, publish: (id, p) => published.push([id, p]), replaceAdopted: (id, sid) => replaced.push([id, sid]), commandsMs: 5 });
  return { host, made, published, replaced };
}
const sent = (c) => c.reqs.filter((t) => t !== 'get_commands');
const renewedEvents = (published) => published.filter(([, p]) => p.kind === 'renewed');

test('s1: renew asks pi for a new session, takes the id pi names, adopts it and tells every tab; the status carries the new id', async () => {
  const { host, made, published, replaced } = setup();
  await host.start('aaa');
  const status = await host.renew('aaa');
  assert.deepEqual(sent(made[0]), ['new_session', 'get_state']);
  assert.equal(status.sessionId, NEW_ID);
  assert.equal((await host.status('aaa')).sessionId, NEW_ID);
  assert.deepEqual(replaced, [['aaa', NEW_ID]]);
  assert.deepEqual(renewedEvents(published), [['aaa', { kind: 'renewed', sessionId: NEW_ID }]]);
  assert.equal(made.length, 1, 'the same pi process: nothing is restarted');
  assert.equal(made[0].closed, 0);
  assert.equal(host.outcomeOf('aaa'), null, 'the outcome of the last task of the old session is not the new one\'s');
});

test('s1 (the bug): /new typed in the chat is a new session, never a message to pi; /newer and "/new x" stay messages', async () => {
  const { host, made, replaced } = setup();
  await host.start('aaa');
  const status = await host.prompt('aaa', '  /new  ');
  assert.deepEqual(sent(made[0]), ['new_session', 'get_state']);
  assert.equal(status.sessionId, NEW_ID);
  assert.deepEqual(replaced, [['aaa', NEW_ID]]);
  made[0].reqs.length = 0;
  await host.prompt('aaa', '/newer');
  await host.prompt('aaa', '/new x');
  assert.deepEqual(sent(made[0]), ['prompt', 'prompt']);
});

for (const [name, prep, message] of [
  ['busy', (s) => { s.made[0].now = 'busy'; }, 'Commands wait until the session is free: send it when the run ends'],
  ['asking', (s) => { s.made[0].now = 'asking'; }, 'Commands wait until the session is free: send it when the run ends'],
  ['compacting', (s) => { s.made[0].opts.onEvent({ kind: 'event', record: { type: 'compaction_start', reason: 'threshold' } }); }, 'The session is compacting its context: wait a moment'],
]) {
  test(`s5: a ${name} session is refused with a fixed message and nothing changes`, async () => {
    const s = setup();
    await s.host.start('aaa');
    prep(s);
    await assert.rejects(s.host.renew('aaa'), { status: 409, message });
    assert.deepEqual(sent(s.made[0]), []);
    assert.deepEqual(s.replaced, []);
    assert.deepEqual(renewedEvents(s.published), []);
    assert.notEqual((await s.host.status('aaa')).sessionId, NEW_ID);
  });
}

test('s5: a shell command running, a repo with no live session and an unknown repo are refused', async () => {
  const held = gate();
  const s = setup({ answers: { bash: () => held.promise } });
  await assert.rejects(s.host.renew('aaa'), { status: 409, message: 'The session is not started' });
  await assert.rejects(s.host.renew('zzz'), { status: 404 });
  await s.host.start('aaa');
  const running = s.host.bash('aaa', '!sleep 1');
  await assert.rejects(s.host.renew('aaa'), { status: 409, message: 'A shell command is running in this session: wait for it to end' });
  held.resolve({ exitCode: 0 });
  await running;
  assert.deepEqual(s.replaced, []);
});

test('s5 (concurrency): two renews at once send ONE new_session; the second is refused', async () => {
  const held = gate();
  const s = setup({ answers: { new_session: () => held.promise } });
  await s.host.start('aaa');
  const first = s.host.renew('aaa');
  await assert.rejects(s.host.renew('aaa'), { status: 409, message: 'The session is already starting a new one' });
  held.resolve({ cancelled: false });
  assert.equal((await first).sessionId, NEW_ID);
  assert.deepEqual(sent(s.made[0]).filter((t) => t === 'new_session'), ['new_session']);
  assert.deepEqual(s.replaced, [['aaa', NEW_ID]]);
  assert.equal((await s.host.renew('aaa')).sessionId, NEW_ID, 'once it ended, the next one runs');
});

test('s6: an extension that cancels the change is told, and nothing changes', async () => {
  const s = setup({ answers: { new_session: { cancelled: true } } });
  await s.host.start('aaa');
  const before = (await s.host.status('aaa')).sessionId;
  await assert.rejects(s.host.renew('aaa'), { status: 409, message: 'The session kept the current conversation: an extension cancelled the new one' });
  assert.deepEqual(sent(s.made[0]), ['new_session']);
  assert.equal((await s.host.status('aaa')).sessionId, before);
  assert.deepEqual(s.replaced, []);
  assert.deepEqual(renewedEvents(s.published), []);
});

test('s4: pi switched but its new id cannot be read: the session is closed (never left showing the old conversation) and nothing is adopted', async () => {
  for (const bad of [{ sessionId: '../x' }, {}, () => { throw new Error('boom'); }]) {
    const s = setup({ answers: { get_state: bad } });
    await s.host.start('aaa');
    await assert.rejects(s.host.renew('aaa'), { status: 502, message: 'The new session started but its id could not be read: the session was closed' });
    assert.equal(s.made[0].closed, 1);
    assert.equal(s.host.stateOf('aaa'), 'closed');
    assert.deepEqual(s.replaced, []);
  }
});

test('s4: a session closed while pi was switching adopts nothing and the renew fails', async () => {
  const held = gate();
  const s = setup({ answers: { new_session: () => held.promise } });
  await s.host.start('aaa');
  const renewing = s.host.renew('aaa');
  await s.host.close('aaa');
  held.resolve({ cancelled: false });
  await assert.rejects(renewing, { status: 409, message: 'The session was closed' });
  assert.deepEqual(s.replaced, []);
  assert.deepEqual(renewedEvents(s.published), []);
});

test('s4: replaceAdopted replaces the adopted session of a repo, also with an id whose file pi has not written yet; an id that is not a session id is never written', () => {
  fs.writeFileSync(process.env.REPO_PANEL_CONFIG, JSON.stringify({ groups: [], sessions: { aaa: { id: 'old-1', name: 'Old', adoptedAt: '2026-01-01T00:00:00.000Z' }, bbb: { id: 'keep', name: 'k', adoptedAt: '2026-01-01T00:00:00.000Z' } } }));
  assert.equal(replaceAdopted('aaa', NEW_ID), true);
  const sessions = loadConfig().sessions;
  assert.equal(sessions.aaa.id, NEW_ID);
  assert.equal(sessions.aaa.name, NEW_ID);
  assert.ok(!Number.isNaN(Date.parse(sessions.aaa.adoptedAt)));
  assert.deepEqual(sessions.bbb, { id: 'keep', name: 'k', adoptedAt: '2026-01-01T00:00:00.000Z' });
  const before = fs.readFileSync(process.env.REPO_PANEL_CONFIG, 'utf8');
  for (const bad of ['../x', '', 'a b', 5, null]) assert.equal(replaceAdopted('aaa', bad), false);
  assert.equal(fs.readFileSync(process.env.REPO_PANEL_CONFIG, 'utf8'), before);
});

// ---------- the route ----------
const freePort = () => new Promise((resolve) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });
const call = (port, method, p, { token, body } = {}) => new Promise((resolve, reject) => {
  const data = body === undefined ? null : JSON.stringify(body);
  const req = http.request({ host: '127.0.0.1', port, path: p, method, headers: { ...(token ? { 'x-token': token } : {}), ...(data ? { 'content-type': 'application/json' } : {}) } }, (res) => {
    let d = ''; res.on('data', (c) => { d += c; }); res.on('end', () => { let json = null; try { json = JSON.parse(d); } catch { /* not json */ } resolve({ status: res.statusCode, body: d, json }); });
  });
  req.on('error', reject);
  req.end(data);
});

test('route: POST /api/rpc/renew needs the token, takes only the repo id, and the adopted session of the repo becomes the new one', async () => {
  const ID = lib.repoId(REPO);
  fs.writeFileSync(process.env.REPO_PANEL_CONFIG, JSON.stringify({ groups: [{ name: 'g', repos: [{ path: REPO }] }] }));
  const made = [];
  const createClient = (opts) => { const c = { opts, start: async () => ({}), close: async () => {}, state: () => 'idle', answerDialog: () => false, pendingDialogs: () => [], request: async (type) => (type === 'get_state' ? { sessionId: NEW_ID } : type === 'new_session' ? { cancelled: false } : {}) }; made.push(c); return c; };
  const port = await freePort();
  const server = createServer(port, { noSummaryStore: true, hub: createEventHub(), rpcResolve: async () => ({ active: ACTIVE }), rpcClient: createClient });
  await new Promise((r) => server.listen(port, '127.0.0.1', r));
  try {
    const token = /name="?token"? content="([0-9a-f]+)"/.exec((await call(port, 'GET', '/')).body)[1];
    assert.equal((await call(port, 'POST', '/api/rpc/renew', { body: { id: ID } })).status, 401);
    assert.equal((await call(port, 'POST', '/api/rpc/start', { token, body: { id: ID } })).status, 200);
    assert.equal(loadConfig().sessions[ID].id, `panel-my-repo-${ID.slice(0, 8)}`);
    assert.equal((await call(port, 'POST', '/api/rpc/renew', { token, body: [] })).status, 400);
    const r = await call(port, 'POST', '/api/rpc/renew', { token, body: { id: ID, command: 'x', cwd: 'C:\\' } });
    assert.equal(r.status, 200);
    assert.equal(r.json.sessionId, NEW_ID);
    assert.equal(loadConfig().sessions[ID].id, NEW_ID);
    assert.equal(made.length, 1);
  } finally { await new Promise((r) => server.close(r)); }
});

test('rpcApi.renew validates the body before the host sees it', () => {
  const calls = [];
  const api = rpcApi({ renew: (id) => { calls.push(id); return { ok: true }; } });
  for (const bad of [null, [], {}, { id: '' }, { id: 5 }, { id: 'x'.repeat(101) }]) assert.throws(() => api.renew(bad), { status: 400 });
  assert.deepEqual(api.renew({ id: 'aaa' }), { ok: true });
  assert.deepEqual(calls, ['aaa']);
});

// ---------- the page (S3) ----------
test('s3: the page hears `renewed`: the live conversation of the old session goes, the history and the context are read again, and the state stays free', () => {
  const V = require('../public/view.js');
  const prev = { ...V.rpcReduce(undefined, { kind: 'state', state: 'idle' }).entry, blocks: ['old answer'], text: 'old answer', ctx: { tokens: 9, percent: 50, window: 18 }, asks: [{ requestId: 'q1' }], bash: { command: 'ls', running: false } };
  const { entry, reload, ctx } = V.rpcReduce(prev, { kind: 'renewed', sessionId: NEW_ID });
  assert.equal(reload, true);
  assert.equal(ctx, true);
  assert.equal(entry.state, 'idle');
  assert.deepEqual([entry.blocks, entry.text, entry.ctx, entry.asks, entry.bash], [[], '', null, [], null]);
});

// Found by the independent verification: while pi switches, nothing else may reach it (a message could land in either conversation).
for (const [name, call] of [['prompt', (h) => h.prompt('aaa', 'hello')], ['steer', (h) => h.steer('aaa', 'hello')], ['bash', (h) => h.bash('aaa', '!ls')], ['compact', (h) => h.compact('aaa')]]) {
  test(`s5 (concurrency): a ${name} while pi is switching to a new session is refused and never reaches pi`, async () => {
    const held = gate();
    const s = setup({ answers: { new_session: () => held.promise } });
    await s.host.start('aaa');
    const renewing = s.host.renew('aaa');
    await assert.rejects(call(s.host), { status: 409, message: 'The session is starting a new conversation: wait a moment' });
    held.resolve({ cancelled: false });
    await renewing;
    assert.deepEqual(sent(s.made[0]), ['new_session', 'get_state']);
  });
}

test('s4 (concurrency): closeAll while pi switches adopts nothing and publishes nothing', async () => {
  const held = gate();
  const s = setup({ answers: { new_session: () => held.promise } });
  await s.host.start('aaa');
  const renewing = s.host.renew('aaa');
  await s.host.closeAll();
  held.resolve({ cancelled: false });
  await assert.rejects(renewing, { status: 409, message: 'The session was closed' });
  assert.deepEqual(s.replaced, []);
  assert.deepEqual(renewedEvents(s.published), []);
});

test('s3 (seen by the person: nothing showed while pi switched): while a new session starts the label reads New session…, animated, and the box sends nothing', () => {
  const R = require('../public/resumen.js');
  const chat = (rpc) => ({ id: 'r1', info: { adopted: { id: 's1' }, adoptedFound: true }, rpc });
  const s = R.sessionState(chat({ state: 'idle', renewing: true }));
  assert.deepEqual([s.key, s.word, s.animate], ['renewing', 'New session…', true]);
  const c = R.composerState(chat({ state: 'idle', renewing: true }), { name: 'demo' });
  assert.deepEqual([c.canSend, c.canSteer, c.reason], [false, false, 'Starting a new session: wait a moment']);
  assert.equal(R.sessionState(chat({ state: 'idle' })).word, 'Idle', 'without the mark nothing changes');
  assert.equal(R.composerState(chat({ state: 'idle' }), { name: 'demo' }).canSend, true);
});
