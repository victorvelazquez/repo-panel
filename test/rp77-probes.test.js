'use strict';
// RP77, second independent verification: probes that pin the survivors of the mutation round (concurrent starts, a list in flight across two
// orca functions, a clear during a flight, unusable lastOutputAt, a failed read dropping the good entry, the list primed by the warmer, rooms
// staying uncached). Fake Orca only, no real Orca, no waiting.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'rp77p-'));
const repoDir = path.join(scratch, 'Repo');
fs.mkdirSync(repoDir);
fs.mkdirSync(path.join(scratch, 'sessions'));
process.env.REPO_PANEL_CONFIG = path.join(scratch, 'config.json');
process.env.REPO_PANEL_SESSIONS_DIR = path.join(scratch, 'sessions');
process.env.REPO_PANEL_CASES_FILE = 'off';
test.after(() => fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 5 }));

const lib = require('../lib.js');
const S = require('../server/sessions.js');
const { listTerminals, scanSessions, clearLiveCache } = require('../server/pi.js');
const { createWarmer } = require('../server/livewarm.js');
const { roomsState } = require('../server/rooms.js');
fs.writeFileSync(process.env.REPO_PANEL_CONFIG, JSON.stringify({ port: 4310, groups: [{ name: 'G', repos: [{ path: repoDir }] }], rooms: [] }));

const IDLE = '▎ ✿ waiting for input\n▎   type, or / for commands\n▎\n~\\proj (main) • panel:demo\n';
const BUSY = '▎ ✿ working…\n▎\n~\\proj (main) • panel:demo\n';
const tick = () => new Promise((r) => setImmediate(r));
test.beforeEach(() => { clearLiveCache(); });

test('S3: two starts AT THE SAME TIME open ONE terminal (the `starting` guard)', async () => {
  const world = {};
  let creates = 0;
  const orca = async (args) => {
    await tick();
    if (args[0] === 'list') return { terminals: Object.keys(world).map((handle) => ({ handle, worktreePath: repoDir, connected: true, writable: true, lastOutputAt: 1 })) };
    if (args[0] === 'show') return { terminal: { preview: IDLE } };
    if (args[0] === 'create') { creates++; world.t1 = {}; return { terminal: { handle: 't1' } }; }
    throw new Error('unexpected');
  };
  const id = lib.repoId(repoDir);
  const r = await Promise.allSettled([S.startSession(id, orca), S.startSession(id, orca)]);
  assert.equal(creates, 1);
  assert.deepEqual(r.map((x) => x.status).sort(), ['fulfilled', 'rejected']);
  assert.match(r.find((x) => x.status === 'rejected').reason.message, /already being started/);
});

test('A5b: a list in flight for one orca function is not shared with a caller of ANOTHER orca function', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  let a = 0;
  let b = 0;
  const orcaA = async () => { a++; await gate; return { terminals: [{ handle: 'A' }] }; };
  const orcaB = async () => { b++; return { terminals: [{ handle: 'B' }] }; };
  const pa = listTerminals(orcaA);
  const pb = listTerminals(orcaB);
  assert.deepEqual(await pb, [{ handle: 'B' }]);
  release();
  assert.deepEqual(await pa, [{ handle: 'A' }]);
  assert.deepEqual([a, b], [1, 1]);
});

test('A10: clearLiveCache while a list is in flight: the late answer is not stored', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  let calls = 0;
  const orca = async () => { calls++; if (calls === 1) await gate; return { terminals: [{ handle: `n${calls}` }] }; };
  const p = listTerminals(orca);
  clearLiveCache();
  release();
  await p;
  assert.deepEqual(await listTerminals(orca), [{ handle: 'n2' }]);
  assert.equal(calls, 2);
});

test('X20: a terminal with no usable lastOutputAt (missing, NaN, string, null) is read on every scan, never served from the cache', async () => {
  for (const lastOutputAt of [undefined, NaN, '5', null]) {
    clearLiveCache();
    let preview = IDLE;
    let shows = 0;
    const orca = async (args) => { if (args[0] === 'show') { shows++; return { terminal: { preview } }; } throw new Error('unexpected'); };
    const listed = [{ handle: 't', worktreePath: repoDir, connected: true, writable: true, ...(lastOutputAt === undefined ? {} : { lastOutputAt }) }];
    assert.equal((await scanSessions(repoDir, orca, listed, false, true, { cached: true })).sessions[0].state, 'idle');
    preview = BUSY;
    assert.equal((await scanSessions(repoDir, orca, listed, false, true, { cached: true })).sessions[0].state, 'busy', `lastOutputAt=${String(lastOutputAt)}`);
    assert.equal(shows, 2);
  }
});

test('X15: a failed read after a good one drops the good entry (lastOutputAt 5, then 6 failed, then 5 again is read again)', async () => {
  let mode = 'idle';
  let shows = 0;
  const orca = async () => { shows++; if (mode === 'fail') throw new Error('x'); return { terminal: { preview: mode === 'idle' ? IDLE : BUSY } }; };
  const term = (at) => [{ handle: 't', worktreePath: repoDir, connected: true, writable: true, lastOutputAt: at }];
  await scanSessions(repoDir, orca, term(5), false, true, { cached: true });
  mode = 'fail';
  assert.equal((await scanSessions(repoDir, orca, term(6), false, true, { cached: true })).failed, 1);
  mode = 'busy';
  assert.equal((await scanSessions(repoDir, orca, term(5), false, true, { cached: true })).sessions[0].state, 'busy');
  assert.equal(shows, 3);
});

test('X12: the list primed by the warmer is only answered to the orca function that warmed it', async () => {
  let a = 0;
  let b = 0;
  const orcaA = async () => { a++; return { terminals: [{ handle: 'A', worktreePath: repoDir }] }; };
  const orcaB = async () => { b++; return { terminals: [{ handle: 'B' }] }; };
  const w = createWarmer({ listRepoFolders: () => [repoDir], orca: orcaA, scan: async () => ({ sessions: [], failed: 0 }) });
  await w.tick();
  assert.deepEqual(await listTerminals(orcaB), [{ handle: 'B' }]);
  assert.deepEqual([a, b], [1, 1]);
});

test('X18: the presence of a room reads its terminals fresh on every call (rooms never use the cache)', async () => {
  const room = { name: 'UPEN', path: repoDir, repos: [] };
  let shows = 0;
  const orca = async (args) => {
    if (args[0] === 'list') return { terminals: [{ handle: 'h1', worktreePath: repoDir, connected: true, writable: true, lastOutputAt: 5 }] };
    if (args[0] === 'show') { shows++; return { terminal: { preview: IDLE } }; }
    throw new Error('unexpected');
  };
  const git = async () => ({ code: 0, stdout: '2026-10-24T10:00:00-05:00\n', stderr: '' });
  const requirements = async () => ({ available: true, base: 'main', results: [], summary: { ready: true } });
  await roomsState({ rooms: [room], orca, git, requirements });
  await roomsState({ rooms: [room], orca, git, requirements });
  assert.equal(shows, 2, 'the same lastOutputAt twice, and still one screen read per call');
});
