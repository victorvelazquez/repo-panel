'use strict';
// RPC2b-1 (S1, S6, S8), server side: the session state of a repo comes from the RPC host (`stateOf`), from nothing else. It feeds GET /api/rpc/states,
// the Summary rows (with and without the store), GET /api/sessions `live` and the rooms (which lose `presence`). The host is the real createRpcHost
// over a fake client.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'rpc2b-1-server-'));
const REPO = path.join(scratch, 'My Repo');
const OTHER = path.join(scratch, 'Other');
const ROOM = path.join(scratch, 'Room');
for (const d of [REPO, OTHER, ROOM]) fs.mkdirSync(d);
process.env.REPO_PANEL_CONFIG = path.join(scratch, 'config.json');
process.env.REPO_PANEL_SESSIONS_DIR = path.join(scratch, 'sessions');
test.after(() => fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 5 }));

const lib = require('../lib.js');
const { createServer } = require('../server/http.js');
const { createRpcHost } = require('../server/rpchost.js');
const { createSummaryStore } = require('../server/summarystore.js');
const { summaryFor } = require('../server/summary.js');
const { sessionsState, adoptSession, releaseSession } = require('../server/sessions.js');
const { roomsState } = require('../server/rooms.js');
const { findRepo } = require('../server/config.js');

const ID = lib.repoId(REPO);
const OTHER_ID = lib.repoId(OTHER);
const ACTIVE = { id: 'gentle-shell', command: 'C:\\L\\gentle-shell.exe', agentDir: 'C:\\a' };
const writeConfig = () => fs.writeFileSync(process.env.REPO_PANEL_CONFIG, JSON.stringify({ groups: [{ name: 'g', repos: [{ path: REPO }, { path: OTHER }] }], rooms: [{ name: 'Room', path: ROOM, repos: [ID] }] }));
const GOOD = {
  local: async () => ({ branch: 'main', files: [], ahead: 0, behind: 0, base: 'main' }),
  prs: async () => ({ prs: [], stale: null }),
  roadmap: async () => ({ available: false, reason: 'missing' }),
  state: async () => ({ available: false }),
  git: async () => ({ code: 0, stdout: '2026-10-28T10:00:00Z\nsubject\n', stderr: '' }),
};

// A host over a fake client; `cur.state` is what the client reports. `gate` holds the start so the session stays `starting`.
function hostWith(cur = { state: 'idle' }, over = {}) {
  const createClient = () => ({ start: over.start || (async () => ({})), request: async () => ({}), answerDialog: () => false, pendingDialogs: () => [], state: () => cur.state, close() {} });
  return createRpcHost({ resolve: async () => ({ active: ACTIVE }), repoOf: findRepo, publish() {}, createClient, adoptedOf: () => null });
}

const freePort = () => new Promise((resolve) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });
const call = (port, p, token) => new Promise((resolve, reject) => {
  http.get({ host: '127.0.0.1', port, path: p, headers: token ? { 'x-token': token } : {} }, (res) => {
    let d = ''; res.on('data', (c) => { d += c; }); res.on('end', () => { let json = null; try { json = JSON.parse(d); } catch { /* not json */ } resolve({ status: res.statusCode, body: d, json }); });
  }).on('error', reject);
});
async function withServer(fn, { deps = {}, host = hostWith() } = {}) {
  writeConfig();
  const port = await freePort();
  const server = createServer(port, { rpcHost: host, ...GOOD, noSummaryStore: true, ...deps });
  await new Promise((r) => server.listen(port, '127.0.0.1', r));
  try {
    const token = /name="?token"? content="([0-9a-f]+)"/.exec((await call(port, '/')).body)[1];
    return await fn({ get: (p) => call(port, p, token), raw: (p) => call(port, p), host, server });
  } finally { await new Promise((r) => server.close(r)); }
}

// ---------- stateOf ----------
test('s1: stateOf is closed for a repo with no session and for an id the host does not know, and never throws', () => {
  const host = hostWith();
  assert.equal(host.stateOf(ID), 'closed');
  assert.equal(host.stateOf('nope'), 'closed');
  for (const bad of [undefined, null, 5, {}, '__proto__', 'constructor']) assert.equal(host.stateOf(bad), 'closed');
});

test('s2: stateOf answers idle, busy and asking from the live client, synchronously', async () => {
  writeConfig();
  const cur = { state: 'idle' };
  const host = hostWith(cur);
  await host.start(ID);
  for (const state of ['idle', 'busy', 'asking']) {
    cur.state = state;
    const got = host.stateOf(ID);
    assert.equal(typeof got, 'string', 'not a promise');
    assert.equal(got, state);
  }
  assert.equal(host.stateOf(OTHER_ID), 'closed');
});

test('s3: stateOf is starting while the client is still starting, and closed again after closeAll', async () => {
  writeConfig();
  let open;
  const host = hostWith({ state: 'idle' }, { start: () => new Promise((r) => { open = r; }) });
  const starting = host.start(ID);
  await new Promise((r) => setImmediate(r));
  assert.equal(host.stateOf(ID), 'starting');
  open({});
  await starting;
  assert.equal(host.stateOf(ID), 'idle');
  host.closeAll();
  assert.equal(host.stateOf(ID), 'closed');
});

test('s4: stateOf never throws even when the client does, and only ever returns one of the five states', async () => {
  writeConfig();
  const cur = { state: 'idle' };
  const host = createRpcHost({ resolve: async () => ({ active: ACTIVE }), repoOf: findRepo, publish() {}, adoptedOf: () => null, createClient: () => ({ start: async () => ({}), pendingDialogs: () => [], state() { if (cur.state === 'throw') throw new Error('boom'); return cur.state; }, close() {} }) });
  await host.start(ID);
  for (const state of ['throw', 'weird', undefined, 42]) {
    cur.state = state;
    assert.ok(['closed', 'starting', 'idle', 'busy', 'asking'].includes(host.stateOf(ID)), String(state));
  }
});

// ---------- GET /api/rpc/states ----------
test('r1: GET /api/rpc/states needs the token', async () => {
  await withServer(async ({ raw }) => {
    const r = await raw('/api/rpc/states');
    assert.equal(r.status, 401);
  });
});

test('r2: every configured repo is there as closed by default, with no process started', async () => {
  await withServer(async ({ get }) => {
    const r = await get('/api/rpc/states');
    assert.equal(r.status, 200);
    assert.deepEqual(r.json, { states: { [ID]: 'closed', [OTHER_ID]: 'closed' } });
  });
});

test('r3: a live fake session shows its state and the others stay closed', async () => {
  writeConfig();
  const cur = { state: 'busy' };
  const host = hostWith(cur);
  await host.start(ID);
  await withServer(async ({ get }) => {
    assert.deepEqual((await get('/api/rpc/states')).json.states, { [ID]: 'busy', [OTHER_ID]: 'closed' });
    cur.state = 'asking';
    assert.deepEqual((await get('/api/rpc/states')).json.states, { [ID]: 'asking', [OTHER_ID]: 'closed' });
  }, { host });
});

// ---------- the Summary row ----------
const ROW_SESSION = { closed: 'none', idle: 'free', busy: 'working', asking: 'waiting', starting: 'working' };
const cfgOf = () => ({ groups: [{ name: 'G', repos: [{ path: REPO }, { path: OTHER }] }], rooms: [], snoozed: [] });

test('m1: the store row session follows sessionOf for every state, starting is working', async () => {
  const cur = {};
  const store = createSummaryStore({ deps: { ...GOOD }, waitForClient: false, loadCfg: cfgOf, sessionOf: (id) => cur[id] });
  await store.refreshAll();
  for (const [state, word] of Object.entries(ROW_SESSION)) {
    cur[ID] = state;
    assert.equal(store.snapshot().rows.find((r) => r.id === ID).session.state, word, state);
  }
  cur[ID] = undefined;
  assert.equal(store.snapshot().rows.find((r) => r.id === ID).session.state, 'unknown', 'a state the vocabulary does not know');
});

test('m2: without a sessionOf the store row session is unknown, whatever else is read', async () => {
  const store = createSummaryStore({ deps: GOOD, waitForClient: false, loadCfg: cfgOf });
  await store.refreshAll();
  assert.equal(store.snapshot().rows.find((r) => r.id === ID).session.state, 'unknown');
  assert.equal('setSession' in store, false);
});

test('m4: summaryFor without a store reads the session from deps.sessionOf for every state', async () => {
  writeConfig();
  const cur = {};
  const deps = { ...GOOD, sessionOf: (id) => cur[id] };
  for (const [state, word] of Object.entries(ROW_SESSION)) {
    cur[ID] = state;
    const out = await summaryFor({ ...deps }, { fresh: '1' });
    assert.equal(out.rows.find((r) => r.id === ID).session.state, word, state);
    assert.equal(out.rows.find((r) => r.id === OTHER_ID).session.state, 'unknown');
  }
});

test('m5: summaryFor without a sessionOf gives an unknown session to every row', async () => {
  writeConfig();
  const out = await summaryFor({ ...GOOD }, { fresh: '1' });
  assert.deepEqual(out.rows.map((r) => r.session.state), ['unknown', 'unknown']);
});

test('m6: the real server builds its store over the host: GET /api/summary shows the live state', async () => {
  writeConfig();
  const cur = { state: 'asking' };
  const host = hostWith(cur);
  await host.start(ID);
  await withServer(async ({ get }) => {
    const out = (await get('/api/summary?fresh=1')).json;
    assert.equal(out.rows.find((r) => r.id === ID).session.state, 'waiting');
    assert.equal(out.rows.find((r) => r.id === OTHER_ID).session.state, 'none');
  }, { host, deps: { noSummaryStore: false } });
});

// ---------- GET /api/sessions ----------
const NONE = { state: 'none', count: 0 };
const LIVE = { closed: NONE, idle: { state: 'free', count: 1 }, busy: { state: 'working', count: 1 }, starting: { state: 'working', count: 1 }, asking: { state: 'waiting', count: 1 } };

test('l1: sessionsState live comes from the host getter for every state', async () => {
  writeConfig();
  for (const [state, live] of Object.entries(LIVE)) {
    const out = await sessionsState(ID, path.join(scratch, 'sessions'), () => state);
    assert.deepEqual(out.live, live, state);
    assert.deepEqual(Object.keys(out).sort(), ['adopted', 'adoptedFound', 'key', 'live', 'sessions']);
  }
});

test('l2: a room key has no session: live is none even when the getter says busy', async () => {
  writeConfig();
  const out = await sessionsState('room:Room', path.join(scratch, 'sessions'), () => 'busy');
  assert.deepEqual(out.live, NONE);
  assert.equal(out.key, 'room:Room');
});

test('l3: GET /api/sessions answers from the host and adopt/release keep working', async () => {
  writeConfig();
  const cur = { state: 'busy' };
  const host = hostWith(cur);
  await host.start(ID);
  await withServer(async ({ get }) => {
    assert.deepEqual((await get(`/api/sessions?id=${ID}`)).json.live, LIVE.busy);
    assert.deepEqual((await get(`/api/sessions?id=${OTHER_ID}`)).json.live, NONE);
  }, { host });
});

test('l4: without a getter sessionsState says none, and adopt/release still answer', async () => {
  writeConfig();
  const base = path.join(scratch, 'sessions');
  assert.deepEqual((await sessionsState(ID, base)).live, NONE);
  assert.deepEqual((await releaseSession(ID, base)).adopted, null);
  await assert.rejects(() => adoptSession(ID, 'missing', base), (e) => e.status === 400);
});

// ---------- rooms ----------
test('o1: roomsState has no presence', async () => {
  const requirements = async () => ({ available: true, base: 'main', results: [], summary: { ready: true } });
  const git = async () => ({ code: 0, stdout: '2026-10-24T10:00:00-05:00\n', stderr: '' });
  const out = await roomsState({ rooms: [{ name: 'R', path: ROOM, repos: ['a'] }], git, requirements });
  assert.deepEqual(Object.keys(out.rooms[0]).sort(), ['available', 'base', 'lastCommit', 'name', 'path', 'repos', 'results', 'summary']);
  assert.equal(out.rooms[0].lastCommit, '2026-10-24T10:00:00-05:00');
});

test('o2: GET /api/rooms answers without presence', async () => {
  await withServer(async ({ get }) => {
    const r = await get('/api/rooms');
    assert.equal(r.status, 200);
    assert.equal(r.json.rooms.length, 1);
    assert.equal('presence' in r.json.rooms[0], false);
    assert.deepEqual([r.json.rooms[0].name, r.json.rooms[0].repos], ['Room', [ID]]);
  });
});
