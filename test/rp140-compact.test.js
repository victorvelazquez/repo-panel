'use strict';
// RP140 (S28): compact the context of the session BY HAND from the chat. Nothing global: the panel never calls set_auto_compaction, never writes a pi setting and never shows or changes the automatic
// compaction. The server ALONE decides what is allowed (the page is not trusted): it sends `compact` only to a session that is running and idle (busy needs force === true, a strict boolean); asking, starting,
// closed and an already compacting session send NOTHING. `customInstructions` is never forwarded, the answer is a small fixed shape and no text of the session ever reaches the page.
// Abuse first, against the fake pi of test/fixtures/fake-pi-rpc.js (it records every command it receives); then the page, in a vm with a fake fetch.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { appSource } = require('./pagesrc.js');

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'rp140-'));
const REPO = path.join(scratch, 'repo');
fs.mkdirSync(REPO);
process.env.REPO_PANEL_CONFIG = path.join(scratch, 'config.json');
// The fake pi runs with the repo as its folder: on Windows the folder is busy until the killed process is gone. `maxRetries` of fs.rmSync only covers ENOTEMPTY, EEXIST and EPERM inside a folder: an EBUSY on the
// folder itself is thrown at once, so the retry is made here (about 20 s at most, and a folder that never frees up is still an error).
test.after(async () => {
  await new Promise((r) => setTimeout(r, 1000));
  for (let i = 1; ; i += 1) {
    try { fs.rmSync(scratch, { recursive: true, force: true }); return; } catch (e) {
      if (!['EBUSY', 'EPERM', 'ENOTEMPTY'].includes(e.code) || i >= 100) throw e;
      await new Promise((r) => setTimeout(r, 200));
    }
  }
});

const lib = require('../lib.js');
const { createServer } = require('../server/http.js');
const { createRpcHost } = require('../server/rpchost.js');
const { createRpcClient } = require('../server/rpc.js');
const { findRepo } = require('../server/config.js');
const { createEventHub } = require('../server/events.js');
const V = require('../public/view.js');
const R = require('../public/resumen.js');

const ID = lib.repoId(REPO);
const ACTIVE = { id: 'gentle-shell', command: 'C:\\L\\gentle-shell.exe', agentDir: 'C:\\a' };
const FIXTURE = path.join(__dirname, 'fixtures', 'fake-pi-rpc.js');
const until = async (fn, ms = 5000) => { const end = Date.now() + ms; while (Date.now() < end) { const v = await fn(); if (v) return v; await new Promise((r) => setTimeout(r, 10)); } throw new Error('timed out waiting'); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let logN = 0;
const newLog = () => path.join(scratch, `pi-${++logN}.log`);
const received = (log) => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const sent = (log, type) => received(log).filter((m) => m.type === type);
// A secret-looking string, built by parts so no file holds it whole.
const SECRET_PARTS = ['sk', 'live', 'ABC123'];

// ---------- the real host and the real server over the fake pi ----------
const freePort = () => new Promise((resolve) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });
const call = (port, method, p, { token, host, body, raw } = {}) => new Promise((resolve, reject) => {
  const payload = raw !== undefined ? raw : body === undefined ? undefined : JSON.stringify(body);
  // agent: false = a new connection per call: the default agent reuses sockets and the server closes an idle one after 5 s, so a test that stalls on a loaded machine got ECONNRESET on the reused socket.
  const req = http.request({ agent: false, host: '127.0.0.1', port, path: p, method, headers: { ...(token ? { 'x-token': token } : {}), ...(host ? { host } : {}), ...(payload !== undefined ? { 'content-type': 'application/json' } : {}) } }, (res) => {
    let d = ''; res.on('data', (c) => { d += c; }); res.on('end', () => { let json = null; try { json = JSON.parse(d); } catch { /* not json */ } resolve({ status: res.statusCode, body: d, json }); });
  });
  req.on('error', reject);
  if (payload !== undefined) req.write(payload);
  req.end();
});
// `fakeEnv` goes to the fake pi; `over` to the host (for example compactMs). Everything the fake pi receives is in `log`.
async function rig(fakeEnv = {}, over = {}) {
  fs.writeFileSync(process.env.REPO_PANEL_CONFIG, JSON.stringify({ groups: [{ name: 'g', repos: [{ path: REPO }] }] }));
  const log = newLog();
  const published = [];
  const createClient = (o) => createRpcClient({ ...o, command: process.execPath, args: [FIXTURE], env: { ...process.env, FAKE_PI: '1', FAKE_LOG: log, ...fakeEnv } });
  const host = createRpcHost({ resolve: async () => ({ active: ACTIVE }), repoOf: findRepo, publish: (id, p) => published.push([id, p]), createClient, adoptedOf: () => null, ...over });
  const port = await freePort();
  const server = createServer(port, { noSummaryStore: true, hub: createEventHub(), rpcHost: host });
  await new Promise((r) => server.listen(port, '127.0.0.1', r));
  const token = /name="?token"? content="([0-9a-f]+)"/.exec((await call(port, 'GET', '/')).body)[1];
  const post = (body, o = {}) => call(port, 'POST', '/api/rpc/compact', { token, body, ...o });
  const status = () => call(port, 'GET', `/api/rpc/status?id=${encodeURIComponent(ID)}`, { token });
  const close = async () => { host.closeAll(); await new Promise((r) => server.close(r)); };
  return { host, server, port, token, log, published, post, status, close };
}
async function withRig(fakeEnv, over, fn) {
  const r = await rig(fakeEnv, over);
  try { return await fn(r); } finally { await r.close(); }
}
const busyRig = (fakeEnv, over, fn) => withRig({ FAKE_RUN_MS: '5000', ...fakeEnv }, over, async (r) => {
  await r.host.start(ID);
  await r.host.prompt(ID, 'work');
  await until(() => r.host.stateOf(ID) === 'busy');
  return fn(r);
});
const FIXED = /^[A-Za-z0-9 ,.:'-]+$/; // a fixed English sentence: no paths, no ids, no model text

// ---------- abuse first: the ids and the guards ----------
// The helper of every wait below: a condition that is an async function returns a promise (always truthy), so a `until` that did not await it returned at once and the wait was a no-op; on a slow machine
// (the CI) the event it waited for had not been handled yet and the next step raced it.
test('helper: until really waits for an async condition', async () => {
  let n = 0;
  const t0 = Date.now();
  await until(async () => { await sleep(30); n += 1; return n >= 3; });
  assert.ok(n >= 3, `the condition was asked ${n} times`);
  assert.ok(Date.now() - t0 >= 60, 'it waited for the slow condition');
  await assert.rejects(until(async () => false, 80), /timed out waiting/, 'and it still gives up');
});
test('abuse: a missing, empty, non-string or too long id is 400 like the other routes, and nothing is sent', async () => {
  await withRig({}, {}, async ({ host, post, log }) => {
    await host.start(ID);
    for (const body of [{}, { id: '' }, { id: 5 }, { id: null }, { id: ['x'] }, { id: { a: 1 } }, { id: 'x'.repeat(101) }]) {
      const r = await post(body);
      assert.equal(r.status, 400, JSON.stringify(body));
      assert.equal(r.json.error, 'Invalid request');
    }
    for (const raw of ['[]', '"text"', '5', 'null']) assert.equal((await post(undefined, { raw })).status, 400, raw);
    assert.deepEqual(sent(log, 'compact'), []);
  });
});
test('abuse: the route needs the token and the host check, and does nothing without them', async () => {
  await withRig({}, {}, async ({ host, port, token, log }) => {
    await host.start(ID);
    const body = { id: ID };
    assert.equal((await call(port, 'POST', '/api/rpc/compact', { body })).status, 401);
    assert.equal((await call(port, 'POST', '/api/rpc/compact', { token: 'wrong', body })).status, 401);
    assert.equal((await call(port, 'POST', '/api/rpc/compact', { token, host: 'evil.example:80', body })).status, 403);
    assert.deepEqual(sent(log, 'compact'), []);
  });
});
test('abuse: an unknown repo is 404 without echoing it; no session is 409; both send nothing', async () => {
  await withRig({}, {}, async ({ post, log }) => {
    const unknown = await post({ id: 'ECHOME-unknown' });
    assert.equal(unknown.status, 404);
    assert.equal(unknown.body.includes('ECHOME'), false);
    const none = await post({ id: ID });
    assert.equal(none.status, 409);
    assert.equal(none.json.error, 'The session is not started');
    assert.deepEqual(sent(log, 'compact'), []);
  });
});

// ---------- abuse: what the server allows ----------
test('abuse: force as the string true, 1, yes, an object or an array is NOT a force: a busy session gets nothing', async () => {
  await busyRig({}, {}, async ({ post, log, host }) => {
    for (const force of ['true', 1, 'yes', {}, [], [true], null, 0, false]) {
      const r = await post({ id: ID, force });
      assert.equal(r.status, 409, JSON.stringify(force));
      assert.match(r.json.error, FIXED);
    }
    assert.equal((await post({ id: ID })).status, 409);
    assert.deepEqual(sent(log, 'compact'), []);
    assert.equal(host.stateOf(ID), 'busy', 'the answer in progress was not cut');
  });
});
test('a busy session with force true gets exactly one compact, and the answer is only { compacted: true }', async () => {
  await busyRig({}, {}, async ({ post, log }) => {
    const r = await post({ id: ID, force: true });
    assert.equal(r.status, 200);
    assert.deepEqual(r.json, { compacted: true });
    assert.equal(sent(log, 'compact').length, 1);
  });
});
test('abuse: asking sends nothing (aborting would drop the dialog)', async () => {
  await withRig({ FAKE_DIALOG: 'select', FAKE_DIALOG_TIMEOUT: '5000' }, {}, async ({ host, post, log }) => {
    await host.start(ID);
    await host.prompt(ID, 'work');
    await until(() => host.stateOf(ID) === 'asking');
    for (const force of [undefined, true]) {
      const r = await post({ id: ID, ...(force === undefined ? {} : { force }) });
      assert.equal(r.status, 409);
      assert.match(r.json.error, FIXED);
      assert.equal(r.json.error, 'A question is waiting for your answer: answer it before compacting', 'its own message, not the generic one below it');
    }
    assert.deepEqual(sent(log, 'compact'), []);
    assert.equal(host.stateOf(ID), 'asking');
  });
});
test('abuse: starting and closed send nothing, with or without force', async () => {
  await withRig({ FAKE_DELAY_MS: '400' }, {}, async ({ host, post, log }) => {
    const starting = host.start(ID);
    await until(() => host.stateOf(ID) === 'starting');
    for (const force of [undefined, true]) {
      const r = await post({ id: ID, ...(force === undefined ? {} : { force }) });
      assert.equal(r.status, 409);
      assert.equal(r.json.error, 'The session is still starting', 'its own message, not the generic one below it');
    }
    await starting;
    await host.close(ID);
    for (const force of [undefined, true]) assert.equal((await post({ id: ID, ...(force === undefined ? {} : { force }) })).status, 409);
    assert.deepEqual(sent(log, 'compact'), []);
  });
});
test('abuse: two simultaneous calls reach the session exactly once and the second is a fixed 409', async () => {
  await withRig({ FAKE_COMPACT: 'slow' }, {}, async ({ host, post, log }) => {
    await host.start(ID);
    const all = await Promise.all([post({ id: ID }), post({ id: ID }), post({ id: ID, force: true })]);
    assert.deepEqual(all.map((r) => r.status).sort(), [200, 409, 409]);
    for (const r of all.filter((x) => x.status === 409)) { assert.match(r.json.error, FIXED); assert.equal(r.json.error, 'The session is already compacting its context'); }
    assert.equal(sent(log, 'compact').length, 1);
  });
});
test('abuse: customInstructions (and any other field) in the body is never forwarded', async () => {
  await withRig({}, {}, async ({ host, post, log }) => {
    await host.start(ID);
    const r = await post({ id: ID, customInstructions: 'KEEP-THE-SECRETS', instructions: 'x', command: 'rm', cwd: '/', args: ['a'], force: false });
    assert.equal(r.status, 200);
    const got = sent(log, 'compact');
    assert.equal(got.length, 1);
    assert.deepEqual(Object.keys(got[0]).sort(), ['id', 'type'], 'the command carries nothing the page chose');
    assert.doesNotMatch(fs.readFileSync(log, 'utf8'), /KEEP-THE-SECRETS/);
  });
});

// ---------- abuse: what the session says never reaches the page ----------
test('abuse: a failure carrying a secret-looking text is a fixed message that holds none of it', async () => {
  await withRig({ FAKE_COMPACT: 'fail' }, {}, async ({ host, post, published }) => {
    await host.start(ID);
    const r = await post({ id: ID });
    assert.notEqual(r.status, 200);
    assert.equal(r.json.error, 'The compaction failed');
    for (const text of [r.body, JSON.stringify(published)]) {
      assert.equal(text.includes(SECRET_PARTS.join('-')), false);
      assert.doesNotMatch(text, /sk-|provider|home\/secret|Compaction failed:/);
    }
  });
});
test('the known refusals have their own fixed messages: Already compacted and Nothing to compact', async () => {
  for (const [mode, message] of [['already', 'The context is already compacted'], ['nothing', 'There is nothing to compact yet: the session is too small']]) {
    await withRig({ FAKE_COMPACT: mode }, {}, async ({ host, post }) => {
      await host.start(ID);
      const r = await post({ id: ID });
      assert.equal(r.status, 409, mode);
      assert.equal(r.json.error, message);
      assert.deepEqual(Object.keys(r.json), ['error']);
    });
  }
});
test('the answer of success never carries the summary or any text of the session', async () => {
  await withRig({}, {}, async ({ host, post, published }) => {
    await host.start(ID);
    const r = await post({ id: ID });
    assert.deepEqual(r.json, { compacted: true });
    assert.doesNotMatch(r.body + JSON.stringify(published), /SECRET-SUMMARY|firstKept|tokensBefore/);
  });
});
test('abuse: a compaction that runs out of time while the session no longer reports compacting is a fixed failure and clears the in-progress mark', async () => {
  await withRig({ FAKE_COMPACT: 'lost' }, { compactMs: 150 }, async ({ host, post, status, published }) => {
    await host.start(ID);
    const r = await post({ id: ID });
    assert.equal(r.status, 504);
    assert.equal(r.json.error, 'The compaction did not finish in time');
    assert.equal((await status()).json.compacting, undefined, 'the mark is clear');
    // the page is told too (the same event its own path already reads), so it does not stay on Compacting…
    assert.equal(published.some(([, p]) => p.kind === 'event' && p.record.type === 'compaction_end'), true);
  });
});

const untilAsync = async (fn, ms = 6000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return true; await sleep(25); } return false; };
test('abuse: a compaction that runs out of time while the session STILL compacts keeps the mark, refuses a second one (one compact reaches the session) and clears at the real end', async () => {
  await withRig({ FAKE_COMPACT: 'slow', FAKE_COMPACT_MS: '1200' }, { compactMs: 150 }, async ({ host, post, status, log, published }) => {
    await host.start(ID);
    const first = await post({ id: ID });
    assert.equal(first.status, 504);
    assert.equal(first.json.error, 'The compaction did not finish in time');
    assert.equal((await status()).json.compacting, true, 'the session still says it compacts: the mark stays');
    assert.equal(published.some(([, p]) => p.kind === 'event' && p.record.type === 'compaction_end'), false, 'no end is invented while it runs');
    const second = await post({ id: ID });
    assert.equal(second.status, 409);
    assert.equal(second.json.error, 'The session is already compacting its context');
    assert.equal(sent(log, 'compact').length, 1, 'exactly one compact reached the session');
    assert.equal(await untilAsync(async () => (await status()).json.compacting === undefined), true, 'the real end event clears the mark');
    assert.equal(sent(log, 'compact').length, 1);
  });
});
test('after a compaction ends a second one on the same session is accepted (the in-flight mark does not stay set)', async () => {
  await withRig({}, {}, async ({ host, post, log }) => {
    await host.start(ID);
    assert.equal((await post({ id: ID })).status, 200);
    assert.equal((await post({ id: ID })).status, 200);
    assert.equal(sent(log, 'compact').length, 2);
  });
});
test('a compaction_end that arrives BEFORE the answer of compact does not open a window for a second compact', async () => {
  const clients = [];
  fs.writeFileSync(process.env.REPO_PANEL_CONFIG, JSON.stringify({ groups: [{ name: 'g', repos: [{ path: REPO }] }] }));
  const log = newLog();
  const createClient = (o) => { const c = createRpcClient({ ...o, command: process.execPath, args: [FIXTURE], env: { ...process.env, FAKE_PI: '1', FAKE_LOG: log, FAKE_COMPACT: 'slow', FAKE_COMPACT_MS: '600' } }); clients.push(c); return c; };
  const host = createRpcHost({ resolve: async () => ({ active: ACTIVE }), repoOf: findRepo, publish: () => {}, createClient, adoptedOf: () => null });
  try {
    await host.start(ID);
    const first = host.compact(ID);
    await until(() => sent(log, 'compact').length === 1);
    await clients[0].request('fake_emit', { record: { type: 'compaction_end', reason: 'manual', aborted: false } });
    assert.equal(await untilAsync(async () => (await host.status(ID)).compacting === undefined), true, 'the end event cleared the mark');
    await assert.rejects(host.compact(ID, { force: true }), (e) => e.status === 409);
    assert.equal(sent(log, 'compact').length, 1, 'the request in flight still closes the window');
    await first;
  } finally { host.closeAll(); }
});

// ---------- the in-progress mark: status, stream, and the events of the session itself ----------
test('the mark is in the status and the stream while it lasts, and goes when it ends', async () => {
  await withRig({ FAKE_COMPACT: 'slow' }, {}, async ({ host, post, status, published }) => {
    await host.start(ID);
    assert.equal((await status()).json.compacting, undefined);
    const call1 = post({ id: ID });
    await until(() => published.some(([, p]) => p.kind === 'event' && p.record.type === 'compaction_start'));
    const during = (await status()).json;
    assert.equal(during.compacting, true);
    assert.ok(['idle', 'busy', 'asking', 'starting', 'closed'].includes(during.state), 'no new value in the closed state machine');
    assert.equal((await call1).status, 200);
    assert.equal((await status()).json.compacting, undefined);
    assert.ok(['idle', 'busy', 'asking', 'starting', 'closed'].includes(host.stateOf(ID)));
  });
});
test('the session own compaction (threshold) shows the mark, refuses a compact and a prompt with nothing sent, and clears at its end', async () => {
  const clients = [];
  fs.writeFileSync(process.env.REPO_PANEL_CONFIG, JSON.stringify({ groups: [{ name: 'g', repos: [{ path: REPO }] }] }));
  const log = newLog();
  const createClient = (o) => { const c = createRpcClient({ ...o, command: process.execPath, args: [FIXTURE], env: { ...process.env, FAKE_PI: '1', FAKE_LOG: log } }); clients.push(c); return c; };
  const host = createRpcHost({ resolve: async () => ({ active: ACTIVE }), repoOf: findRepo, publish: () => {}, createClient, adoptedOf: () => null });
  try {
    await host.start(ID);
    await clients[0].request('fake_emit', { record: { type: 'compaction_start', reason: 'threshold' } });
    await until(async () => (await host.status(ID)).compacting === true);
    await assert.rejects(host.compact(ID, { force: true }), (e) => e.status === 409 && e.message === 'The session is already compacting its context');
    await assert.rejects(host.prompt(ID, 'hello'), (e) => e.status === 409 && e.message === 'The session is compacting its context: wait a moment');
    assert.deepEqual(sent(log, 'compact'), []);
    assert.deepEqual(sent(log, 'prompt'), []);
    await clients[0].request('fake_emit', { record: { type: 'compaction_end', reason: 'threshold', aborted: false } });
    await until(async () => (await host.status(ID)).compacting === undefined);
    assert.equal((await host.compact(ID)).compacted, true);
  } finally { host.closeAll(); }
});
test('a prompt while a manual compaction runs is refused by the server with a fixed message and never reaches the session', async () => {
  await withRig({ FAKE_COMPACT: 'slow' }, {}, async ({ host, post, log, published }) => {
    await host.start(ID);
    const pending = post({ id: ID });
    await until(() => published.some(([, p]) => p.kind === 'event' && p.record.type === 'compaction_start'));
    await assert.rejects(host.prompt(ID, 'hello'), (e) => e.status === 409 && e.message === 'The session is compacting its context: wait a moment');
    assert.deepEqual(sent(log, 'prompt'), []);
    await pending;
  });
});
test('the fake pi itself refuses a prompt while compacting with the real text (so the page guard is not the only one)', async () => {
  const c = createRpcClient({ command: process.execPath, args: [FIXTURE], cwd: REPO, env: { ...process.env, FAKE_PI: '1', FAKE_COMPACT: 'slow' } });
  try {
    await c.start();
    const running = c.request('compact', {});
    await sleep(80);
    const st = await c.request('get_state', {});
    assert.equal(st.isCompacting, true);
    await assert.rejects(c.request('prompt', { message: 'x' }), /rejected/);
    await running;
    assert.equal((await c.request('get_state', {})).isCompacting, false);
  } finally { c.close(); }
});

// ---------- nothing global ----------
test('nothing global: no file of the unit calls set_auto_compaction, writes a pi setting or mentions the automatic compaction setting', () => {
  for (const f of ['server/rpchost.js', 'server/rpc.js', 'server/http.js', 'public/view.js', 'public/feed.js', 'public/resumen.js', 'public/chat.js', 'public/actions.js']) {
    const src = fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
    assert.doesNotMatch(src, /set_auto_compaction|setAutoCompaction|autoCompaction|settings\.json/, f);
  }
});

// ---------- the pure parts of the page ----------
const base = (rpc, extra = {}) => ({ id: 'r1', info: { adopted: { id: 's1' } }, rpc, ...extra });
const button = (c) => R.compactButtonHtml(c);

test('button: drawn only for idle and busy, with the title that says what it does', () => {
  const idle = button(base({ state: 'idle' }));
  assert.match(idle, /<button type="button"[^>]*data-act="compact"[^>]*>Compact<\/button>/);
  assert.match(idle, /title="Compact the context of this session"/);
  const busy = button(base({ state: 'busy' }));
  assert.match(busy, /data-act="compact"/);
  assert.match(busy, /title="Compact the context of this session\. It stops the answer in progress first"/);
});
test('button: not drawn when closed, starting, asking or compacting, nor without a session record or before the chat loaded', () => {
  for (const rpc of [{ state: 'closed' }, { state: 'starting' }, { state: 'asking' }, { state: 'idle', compacting: true }, { state: 'busy', compacting: true }, null, undefined, 'x', { state: 'weird' }]) assert.equal(button(base(rpc)), '', JSON.stringify(rpc));
  assert.equal(button({ id: 'r1', info: null, rpc: { state: 'idle' } }), '');
  assert.equal(button(null), '');
});
test('label: compacting reads Compacting… with icon and words instead of Idle or Working…; a closed session never does', () => {
  for (const state of ['idle', 'busy']) {
    const s = R.sessionState(base({ state, compacting: true }));
    assert.equal(s.word, 'Compacting…');
    assert.ok(s.icon && s.title.length > 10);
    assert.equal(s.animate, true);
    assert.match(R.sessionLabelHtml(base({ state, compacting: true })), /Compacting…/);
    assert.doesNotMatch(R.sessionLabelHtml(base({ state, compacting: true })), /Idle|Working/);
  }
  assert.equal(R.sessionState(base({ state: 'closed', compacting: true })).word, 'Not started');
  assert.equal(R.sessionState(base({ state: 'idle' })).word, 'Idle');
});
test('composer: sending is refused while compacting, with the reason', () => {
  const c = R.composerState(base({ state: 'idle', compacting: true }), { name: 'demo' });
  assert.equal(c.canSend, false);
  assert.equal(c.reason, 'The session is compacting its context: wait a moment');
  assert.equal(R.composerState(base({ state: 'idle' }), { name: 'demo' }).canSend, true);
});
test('record: the reducer follows compaction_start and compaction_end; the status carries the mark; an exit and a closed status clear it', () => {
  let { entry } = V.rpcReduce(undefined, { kind: 'event', record: { type: 'compaction_start', reason: 'threshold' } });
  assert.equal(entry.compacting, true);
  ({ entry } = V.rpcReduce(entry, { kind: 'state', state: 'idle' }));
  assert.equal(entry.compacting, true, 'a state change does not end it');
  const end = V.rpcReduce(entry, { kind: 'event', record: { type: 'compaction_end', reason: 'threshold' } });
  assert.equal(end.entry.compacting, false);
  assert.equal(end.ctx, true, 'RP139 already asks for the context at the end');
  assert.equal(V.rpcReduce(entry, { kind: 'exit' }).entry.compacting, false);
  assert.equal(V.rpcFromStatus(undefined, { state: 'idle', compacting: true, pendingDialogs: [] }).compacting, true);
  assert.equal(V.rpcFromStatus(undefined, { state: 'idle', compacting: 'yes', pendingDialogs: [] }).compacting, false);
  assert.equal(V.rpcFromStatus(entry, { state: 'idle', pendingDialogs: [] }).compacting, false);
  assert.equal(V.rpcFromStatus(entry, { state: 'closed', compacting: true, pendingDialogs: [] }).compacting, false);
});

// ---------- the real page, in a vm ----------
function element(extra = {}) {
  const el = {
    html: '', hidden: false, dataset: {}, disabled: false, value: '', checked: false, textContent: '', title: '', placeholder: '', attrs: {}, listeners: {}, children: [], open: false,
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    style: { setProperty(k, v) { el.style[k] = v; } },
    addEventListener(t, fn) { (el.listeners[t] ||= []).push(fn); }, setAttribute(k, v) { el.attrs[k] = v; }, querySelector: () => null, querySelectorAll: () => [], closest: () => null,
    showModal() {}, close() {}, focus() {}, append(c) { el.children.push(c); },
    get innerHTML() { return el.html; }, set innerHTML(v) { el.html = String(v); }, ...extra,
  };
  return el;
}
// `answers`: url prefix -> value, function(url, opts) or promise. A { __status, json } value is an HTTP error. Every request is recorded in `calls` with its method and body.
function loadPage(answers) {
  const els = {};
  const frames = [];
  const calls = [];
  const confirms = [];
  const ui = { confirm: true };
  const tabEls = ['summary', 'work', 'conformity', 'settings'].map((t) => element({ dataset: { tab: t } }));
  const get = (sel) => (els[sel] ||= (sel === 'meta[name=token]' ? element({ content: 'token' }) : element()));
  const doc = { hidden: false, querySelector: get, querySelectorAll: (s) => (String(s).includes('data-tab') ? tabEls : []), addEventListener() {}, createElement: () => element(), body: element(), activeElement: null };
  const store = {};
  const ctx = vm.createContext({
    console, document: doc, location: { hash: '' }, TextDecoder, AbortController, confirm: (m) => { confirms.push(m); return ui.confirm; },
    localStorage: { getItem: (k) => (k in store ? store[k] : null), setItem(k, v) { store[k] = String(v); }, removeItem(k) { delete store[k]; } },
    requestAnimationFrame: (cb) => { frames.push(cb); return frames.length; }, setInterval: () => 1, setTimeout: () => 1, clearTimeout: () => {}, clearInterval: () => {},
    fetch: (url, opts = {}) => {
      calls.push({ url, method: opts.method || 'GET', body: opts.body ? JSON.parse(opts.body) : null });
      const a = Object.entries(answers).find(([k]) => url.startsWith(k));
      if (!a) return new Promise(() => {});
      const v = typeof a[1] === 'function' ? a[1](url, opts) : a[1];
      return Promise.resolve(v).then((json) => (json && json.__status ? { ok: false, status: json.__status, statusText: 'x', json: async () => json.json } : { ok: true, json: async () => json }));
    },
  });
  ctx.window = ctx;
  ctx.addEventListener = () => {};
  ctx.RepoPanelView = V;
  ctx.RepoPanelResumen = R;
  vm.runInContext(appSource(), ctx);
  const flush = () => { while (frames.length) frames.shift()(); };
  const tick = async (n = 8) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); flush(); };
  const urls = (prefix) => calls.filter((c) => c.url.startsWith(prefix));
  return { get, tick, calls, confirms, ui, urls, run: (code) => vm.runInContext(code, ctx), compactPosts: () => calls.filter((c) => c.method === 'POST' && c.url === '/api/rpc/compact') };
}
const ID2 = 'abcdefghij';
const ADOPTED = { key: ID, adopted: { id: 's1', name: 'demo', adoptedAt: 'x' }, adoptedFound: true, sessions: [], live: { state: 'none', count: 0 } };
const STATUS = (state, extra = {}) => ({ state, pendingDialogs: [], sessionId: 's1', ...extra });
async function chatPage({ state = 'idle', status, compact = { compacted: true }, context = { tokens: 124000, percent: 62, window: 200000 } } = {}) {
  const page = loadPage({
    '/api/events': () => new Promise(() => {}), '/api/rpc/status': status || STATUS(state), '/api/rpc/context': context, '/api/sessions': ADOPTED, '/api/rpc/compact': compact,
    '/api/chat': { key: ID, sessionId: 's1', found: true, items: [], truncated: false, updatedAt: null },
  });
  const st = page.run('S');
  st.groups = [{ name: 'G', repos: [{ id: ID, name: 'demo', path: 'p' }, { id: ID2, name: 'other', path: 'q' }] }];
  st.summary = { rows: [], generatedAt: 'x' };
  page.open = async (id = ID) => { page.run(`ACTIONS['chat-open']({ dataset: { id: '${id}' } })`); await page.tick(); };
  page.rpc = async (id, kind, record) => { page.run(`applyRpc(${JSON.stringify({ id, kind, ...(record ? { record } : {}) })})`); await page.tick(); };
  page.click = async () => { page.run("ACTIONS['compact']({ dataset: {} })"); await page.tick(); };
  page.bar = () => page.get('#sessState').html;
  return page;
}

test('page (real): an idle session draws the button next to the ctx chip, and one click posts once with no force', async () => {
  const page = await chatPage();
  await page.open();
  assert.match(page.bar(), /ctx <\/span>62%/); // RP156: the word «ctx» is in its own span
  assert.match(page.bar(), /data-act="compact"/);
  assert.ok(page.bar().indexOf('ctx </span>62%') < page.bar().indexOf('data-act="compact"'));
  await page.click();
  assert.deepEqual(page.compactPosts().map((c) => c.body), [{ id: ID }]);
  assert.deepEqual(page.confirms, [], 'an idle session asks nothing');
});
test('page (real): a busy session asks first; declining posts nothing, accepting posts force true once', async () => {
  const page = await chatPage({ state: 'busy' });
  await page.open();
  assert.match(page.bar(), /data-act="compact"/);
  page.ui.confirm = false;
  await page.click();
  assert.equal(page.confirms.length, 1);
  assert.equal(page.confirms[0], 'The session is answering. Compacting stops that answer first. Compact anyway?');
  assert.deepEqual(page.compactPosts(), []);
  assert.doesNotMatch(page.bar(), /Compacting…/);
  page.ui.confirm = true;
  await page.click();
  assert.equal(page.confirms.length, 2);
  assert.deepEqual(page.compactPosts().map((c) => c.body), [{ id: ID, force: true }]);
});
test('page (real): from the click until the answer there is no second send and the state reads Compacting…', async () => {
  let release;
  const page = await chatPage({ compact: () => new Promise((r) => { release = () => r({ compacted: true }); }) });
  await page.open();
  await page.click();
  assert.equal(page.compactPosts().length, 1);
  assert.match(page.bar(), /Compacting…/);
  assert.doesNotMatch(page.bar(), /data-act="compact"/);
  await page.click();
  await page.click();
  assert.equal(page.compactPosts().length, 1, 'no double send');
  release();
  await page.tick();
  assert.doesNotMatch(page.bar(), /Compacting…/);
  assert.match(page.bar(), /data-act="compact"/);
});
test('page (real): while compacting the message cannot be sent, also when the session started it by itself (events)', async () => {
  const page = await chatPage();
  await page.open();
  await page.rpc(ID, 'event', { type: 'compaction_start', reason: 'threshold' });
  assert.match(page.bar(), /Compacting…/);
  assert.doesNotMatch(page.bar(), /data-act="compact"/);
  assert.equal(page.get('#msgSend').disabled, true);
  assert.equal(page.get('#msgSend').title, 'The session is compacting its context: wait a moment');
  page.get('#msgBox').value = 'hello';
  await page.run('sendChatMessage()');
  await page.tick();
  assert.deepEqual(page.urls('/api/rpc/prompt'), []);
  assert.match(page.get('#msgNote').html, /The session is compacting its context: wait a moment/);
  assert.equal(page.get('#msgBox').value, 'hello', 'the draft stays');
  await page.rpc(ID, 'event', { type: 'compaction_end', reason: 'threshold' });
  assert.doesNotMatch(page.bar(), /Compacting…/);
  assert.match(page.bar(), /data-act="compact"/);
});
test('page (real): the status of a session that is compacting (a reload in the middle) shows Compacting… too', async () => {
  const page = await chatPage({ status: STATUS('idle', { compacting: true }) });
  await page.open();
  assert.match(page.bar(), /Compacting…/);
  assert.doesNotMatch(page.bar(), /data-act="compact"/);
});
test('page (real): after success the history is read again and the context once more, and the chip reads ctx — while unknown', async () => {
  const page = await chatPage();
  await page.open();
  const before = { chat: page.urls('/api/chat').length, ctx: page.urls('/api/rpc/context').length };
  await page.click();
  assert.equal(page.urls('/api/chat').length, before.chat + 1, 'the history is read again (the Context compacted marker)');
  // the session says it ended (the path of RP139): one more reading, and only one
  await page.rpc(ID, 'event', { type: 'compaction_end', reason: 'manual' });
  assert.equal(page.urls('/api/rpc/context').length, before.ctx + 1, 'the context is read once after the end, not twice');
});
test('page (real): right after a compaction the chip still reads ctx — and never 0', async () => {
  const page = await chatPage({ context: { tokens: null, percent: null, window: 200000 } });
  await page.open();
  await page.click();
  await page.rpc(ID, 'event', { type: 'compaction_end', reason: 'manual' });
  assert.match(page.bar(), /ctx <\/span>—/); // RP156
  assert.doesNotMatch(page.bar(), /ctx <\/span>0/);
});
test('page (real): a refusal or a failure shows the fixed message under the box and the state comes back from the status', async () => {
  const page = await chatPage({ compact: { __status: 409, json: { error: 'The context is already compacted' } } });
  await page.open();
  await page.click();
  assert.match(page.get('#msgNote').html, /The context is already compacted/);
  assert.doesNotMatch(page.bar(), /Compacting…/);
  assert.match(page.bar(), /data-act="compact"/);
  assert.equal(page.compactPosts().length, 1);
  assert.equal(page.urls('/api/chat').length, 1, 'a failure does not reload the history');
});
test('page (real): a closed, starting or asking session shows no button', async () => {
  for (const state of ['closed', 'starting', 'asking']) {
    const page = await chatPage({ state });
    await page.open();
    assert.doesNotMatch(page.bar(), /data-act="compact"/, state);
  }
});
test('page (real): the button is for the open chat only, and a click with no open chat posts nothing', async () => {
  const page = await chatPage();
  await page.click();
  assert.deepEqual(page.compactPosts(), []);
});

// ---------- wording and the closing of the unit ----------
test('wording: the files of this unit never show pi session, pi screen or Gentle Shell as visible text', () => {
  for (const f of ['public/resumen.js', 'public/view.js', 'public/feed.js', 'public/actions.js', 'public/chat.js']) {
    const src = fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
    for (const line of src.split('\n').filter((l) => /RP140|compact/i.test(l))) assert.doesNotMatch(line, /pi session|pi screen|Gentle Shell/i, f);
  }
});
test('README describes the button, the confirmation and that auto-compaction is left alone', () => {
  const readme = fs.readFileSync(path.join(__dirname, '..', 'README.md'), 'utf8');
  assert.match(readme, /Compact/);
  assert.match(readme, /auto-compaction/i);
  assert.match(readme, /Compacting…/);
});
