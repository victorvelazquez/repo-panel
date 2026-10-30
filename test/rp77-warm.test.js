'use strict';
// RP77 (S68, S71), the warmer and the counters. server/livewarm.js exports createWarmer({ listRepoFolders, orca, scan, intervalMs = 3000,
// setTimer, clearTimer, log, now }) -> { start, stop, tick } (modelled on server/vigia.js createWatcher) and warmInterval(env): every tick
// lists Orca once and then scans every configured folder with the cache on (`scan(folder, orca, terminals, false, true, { cached: true })`), so
// the read-only callers find the screens already read. GET /api/perf also answers `liveCache: { hits, misses, size }` (cumulative since start,
// clearLiveCache resets them). Fake timers, a fake clock and a fake Orca: no real waiting, no wall-clock window, no real Orca, no real config.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'rp77w-'));
const repoDir = path.join(scratch, 'repo-one');
const otherDir = path.join(scratch, 'repo-two');
fs.mkdirSync(repoDir);
fs.mkdirSync(otherDir);
const configFile = path.join(scratch, 'config.json');
process.env.REPO_PANEL_CONFIG = configFile;
process.env.REPO_PANEL_CASES_FILE = 'off';
process.env.REPO_PANEL_MAX_PARALLEL = '2';
fs.writeFileSync(configFile, JSON.stringify({ port: 4310, groups: [{ name: 'G', repos: [{ path: repoDir }] }], rooms: [] }));
test.after(() => fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 5 }));

const P = require('../server/pi.js');
const { createServer } = require('../server/http.js');
const { scanSessions, clearLiveCache, piStatus } = P;
const livewarm = () => require('../server/livewarm.js');
const createWarmer = (...a) => livewarm().createWarmer(...a);

// Tolerant on purpose: before RP77 exists the hook must not fail every test for one reason.
test.beforeEach(() => { if (typeof clearLiveCache === 'function') clearLiveCache(); });

const IDLE = '▎ ✿ waiting for input\n▎   type, or / for commands\n▎\n~\\proj (main) • panel:demo\n';
const WORKING = '▎ ❁ working…\n▎   type, or / for commands\n▎\n~\\proj (main) • panel:demo\n';

// ---------- warmInterval ----------
test('warmInterval: unset gives 3000; 0, off, empty and invalid disable; below 1000 is raised to 1000; a valid value is kept', () => {
  const w = (v) => livewarm().warmInterval(v === undefined ? {} : { REPO_PANEL_WARM_MS: v });
  assert.equal(w(undefined), 3000);
  assert.equal(livewarm().warmInterval({ REPO_PANEL_WARM_MS: undefined }), 3000);
  for (const off of ['0', '00', 'off', 'OFF', 'Off', '', '   ', 'abc', '-5', '-0', '1.5', '1e3', '3s', 'Infinity', 'NaN', '0x10']) assert.equal(w(off), null, JSON.stringify(off));
  for (const [raw, want] of [['1', 1000], ['500', 1000], ['999', 1000], ['1000', 1000], ['1001', 1001], ['3000', 3000], ['2500', 2500], [' 2500 ', 2500], ['60000', 60000]]) assert.equal(w(raw), want, raw);
});

// ---------- the warmer ----------
function fakeTimers() {
  const t = { pending: null, set: [], cleared: 0, unrefs: 0 };
  t.setTimer = (fn, ms) => { const h = { fn, ms, unref() { t.unrefs++; return h; } }; t.pending = h; t.set.push(ms); return h; };
  t.clearTimer = (h) => { t.cleared++; if (t.pending === h) t.pending = null; };
  t.fire = async () => { const h = t.pending; t.pending = null; await h.fn(); };
  return t;
}
const TERMINALS = [{ handle: 't1' }, { handle: 't2' }];
const make = (over = {}) => {
  const calls = { orca: [], scan: [], log: [] };
  const timers = fakeTimers();
  let clock = 1000;
  const w = createWarmer({
    listRepoFolders: () => ['C:/a', 'C:/b'],
    orca: async (args) => { calls.orca.push(args.join(' ')); return { terminals: TERMINALS }; },
    scan: async (...args) => { calls.scan.push(args); return { sessions: [], failed: 0 }; },
    setTimer: timers.setTimer, clearTimer: timers.clearTimer, log: (m) => calls.log.push(m), now: () => clock,
    ...over,
  });
  return { w, calls, timers, advance: (ms) => { clock += ms; } };
};

test('exports: createWarmer returns start, stop and tick', () => {
  const { w } = make();
  assert.deepEqual(Object.keys(w).sort(), ['start', 'stop', 'tick']);
  for (const k of Object.keys(w)) assert.equal(typeof w[k], 'function', k);
});

test('tick: ONE list, then every folder scanned once with that list, no preview, ask-aware and the cache on', async () => {
  const { w, calls } = make({ listRepoFolders: () => ['C:/a', 'C:/b', 'C:/c'] });
  await w.tick();
  assert.deepEqual(calls.orca, ['list']);
  assert.deepEqual(calls.scan.map((c) => c.slice(0, 1)), [['C:/a'], ['C:/b'], ['C:/c']]);
  for (const c of calls.scan) {
    assert.equal(c.length, 6);
    assert.equal(typeof c[1], 'function', 'the same orca');
    assert.equal(c[2], TERMINALS, 'the list already fetched, not a copy');
    assert.deepEqual(c.slice(3), [false, true, { cached: true }]);
  }
  assert.deepEqual(calls.log, []);
});

test('tick: the orca handed to the scan is the one given to the warmer', async () => {
  const seen = [];
  const orca = async () => ({ terminals: [] });
  const w = createWarmer({ listRepoFolders: () => ['C:/a'], orca, scan: async (f, o) => { seen.push(o); }, setTimer: () => ({}), clearTimer: () => {}, log: () => {}, now: () => 0 });
  await w.tick();
  assert.deepEqual(seen, [orca]);
});

test('tick: a folder that appears twice (repo and room, case, slashes, trailing slash) is scanned once, in order', async () => {
  const { w, calls } = make({ listRepoFolders: () => ['C:\\Dev\\Repo', 'c:/dev/repo/', 'C:/Dev/Other', 'C:/DEV/other'] });
  await w.tick();
  assert.deepEqual(calls.scan.map((c) => c[0]), ['C:\\Dev\\Repo', 'C:/Dev/Other']);
});

test('tick: folders are read fresh each tick, so a repo added later is scanned on the next tick', async () => {
  let folders = ['C:/a'];
  const { w, calls } = make({ listRepoFolders: () => folders });
  await w.tick();
  folders = ['C:/a', 'C:/new'];
  await w.tick();
  assert.deepEqual(calls.scan.map((c) => c[0]), ['C:/a', 'C:/a', 'C:/new']);
  assert.deepEqual(calls.orca, ['list', 'list']);
});

test('tick: a tick never overlaps another: while one is pending the next returns at once, and the following one runs', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const orcaCalls = [];
  const { w, calls } = make({ orca: async (a) => { orcaCalls.push(a.join(' ')); await gate; return { terminals: [] }; } });
  const first = w.tick();
  await w.tick();
  await w.tick();
  assert.deepEqual(orcaCalls, ['list']);
  release();
  await first;
  assert.equal(calls.scan.length, 2);
  await w.tick();
  assert.equal(orcaCalls.length, 2);
  assert.equal(calls.scan.length, 4);
});

test('tick: a scan that is still running also blocks the next tick', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const { w, calls } = make({ scan: async (...a) => { calls.scan.push(a); await gate; } });
  const first = w.tick();
  await new Promise((r) => setImmediate(r));
  await w.tick();
  assert.deepEqual(calls.orca, ['list']);
  release();
  await first;
});

test('tick: a failing list never rejects, scans nothing, and logs at most once per 10 minutes (9:59.999 no, 10:00.000 yes)', async () => {
  const { w, calls, advance } = make({ orca: async () => { throw new Error('Orca CLI is unavailable'); } });
  await assert.doesNotReject(w.tick());
  await w.tick();
  assert.equal(calls.log.length, 1);
  advance(10 * 60 * 1000 - 1);
  await w.tick();
  assert.equal(calls.log.length, 1);
  advance(1);
  await w.tick();
  assert.equal(calls.log.length, 2);
  assert.deepEqual(calls.scan, []);
  assert.equal(typeof calls.log[0], 'string');
});

test('tick: a list without a terminals array is a failure, not "no terminals": nothing is scanned and one line is logged', async () => {
  for (const answer of [{}, { terminals: null }, { terminals: 'x' }, null]) {
    const { w, calls } = make({ orca: async () => answer });
    await assert.doesNotReject(w.tick());
    assert.deepEqual(calls.scan, []);
    assert.equal(calls.log.length, 1);
  }
});

test('tick: a failing scan never rejects and the other folders are still scanned; many failures log one line per 10 minutes', async () => {
  const seen = [];
  const { w, calls, advance } = make({
    listRepoFolders: () => ['C:/a', 'C:/b', 'C:/c'],
    scan: async (f) => { seen.push(f); if (f !== 'C:/c') throw new Error(`boom ${f}`); },
  });
  await assert.doesNotReject(w.tick());
  assert.deepEqual(seen, ['C:/a', 'C:/b', 'C:/c']);
  assert.equal(calls.log.length, 1);
  advance(10 * 60 * 1000);
  await w.tick();
  assert.equal(calls.log.length, 2);
});

test('tick: a throwing listRepoFolders is swallowed (one line) and Orca is not listed', async () => {
  const { w, calls } = make({ listRepoFolders: () => { throw new Error('bad config'); } });
  await assert.doesNotReject(w.tick());
  assert.equal(calls.log.length, 1);
  assert.deepEqual(calls.orca, []);
  assert.deepEqual(calls.scan, []);
});

test('tick: a throwing log never breaks the warmer', async () => {
  const { w, calls } = make({ orca: async () => { throw new Error('down'); }, log: () => { throw new Error('console is gone'); } });
  await assert.doesNotReject(w.tick());
  await assert.doesNotReject(w.tick());
  assert.deepEqual(calls.scan, []);
});

test('tick: after a failure the next tick works again', async () => {
  let fail = true;
  const { w, calls } = make({ orca: async (a) => { calls.orca.push(a.join(' ')); if (fail) throw new Error('down'); return { terminals: TERMINALS }; } });
  await w.tick();
  fail = false;
  await w.tick();
  assert.equal(calls.scan.length, 2);
});

// ---------- start / stop ----------
test('start: arms ONE timer, unref\'d, and does not scan before it fires; start twice does not stack timers', async () => {
  const { w, calls, timers } = make();
  w.start();
  w.start();
  assert.equal(timers.set.length, 1);
  assert.equal(timers.unrefs, 1);
  assert.deepEqual(calls.orca, []);
  assert.deepEqual(calls.scan, []);
});

test('start: when the timer fires a tick runs and the next timer is armed with intervalMs (default 3000), unref\'d again', async () => {
  const { w, calls, timers } = make();
  w.start();
  await timers.fire();
  assert.deepEqual(calls.orca, ['list']);
  assert.equal(calls.scan.length, 2);
  assert.equal(timers.set.length, 2);
  assert.equal(timers.set[1], 3000);
  assert.equal(timers.unrefs, 2);
  await timers.fire();
  assert.deepEqual(timers.set.slice(1), [3000, 3000]);
  w.stop();
});

test('start: a custom intervalMs is used for every re-arm', async () => {
  const { w, timers } = make({ intervalMs: 1500 });
  w.start();
  await timers.fire();
  await timers.fire();
  assert.deepEqual(timers.set.slice(1), [1500, 1500]);
  w.stop();
});

test('start: a failing tick still re-arms the timer', async () => {
  const { w, timers } = make({ orca: async () => { throw new Error('down'); } });
  w.start();
  await assert.doesNotReject(timers.fire());
  assert.equal(timers.set.length, 2);
  assert.notEqual(timers.pending, null);
});

test('stop: clears the pending timer once, nothing is armed afterwards, and stop twice is harmless', async () => {
  const { w, timers } = make();
  w.start();
  w.stop();
  assert.equal(timers.cleared, 1);
  assert.equal(timers.pending, null);
  assert.doesNotThrow(() => w.stop());
  assert.equal(timers.cleared, 1);
  assert.equal(timers.set.length, 1);
});

test('stop during a running tick: the tick ends and no new timer is armed', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const { w, timers } = make({ orca: async () => { await gate; return { terminals: [] }; } });
  w.start();
  const firing = timers.fire();
  await new Promise((r) => setImmediate(r));
  w.stop();
  release();
  await firing;
  assert.equal(timers.set.length, 1);
  assert.equal(timers.pending, null);
});

test('start after stop arms a new timer', async () => {
  const { w, timers } = make();
  w.start();
  w.stop();
  w.start();
  assert.equal(timers.set.length, 2);
  assert.notEqual(timers.pending, null);
  w.stop();
});

// ---------- the point of it all: the read-only callers find the screens already read ----------
function liveWorld() {
  const calls = [];
  const t = { handle: 't1', worktreePath: repoDir, connected: true, writable: true, lastOutputAt: 5, preview: IDLE };
  const orca = async (args) => {
    calls.push(args);
    if (args[0] === 'list') return { terminals: [{ handle: t.handle, worktreePath: t.worktreePath, connected: true, writable: true, lastOutputAt: t.lastOutputAt }] };
    if (args[0] === 'show') return { terminal: { preview: t.preview } };
    throw new Error(`unexpected ${args[0]}`);
  };
  return { t, orca, calls, shows: () => calls.filter((c) => c[0] === 'show').length };
}

test('with the real scan: a warm tick reads each screen once; the next tick and a read-only caller make no show at all', async () => {
  const world = liveWorld();
  const w = createWarmer({ listRepoFolders: () => [repoDir, otherDir], orca: world.orca, scan: scanSessions, setTimer: () => ({}), clearTimer: () => {}, log: () => {} });
  await w.tick();
  assert.equal(world.shows(), 1);
  await w.tick();
  assert.equal(world.shows(), 1);
  assert.equal(world.calls.filter((c) => c[0] === 'list').length, 2);
  assert.deepEqual(await piStatus({ path: repoDir }, world.orca), { state: 'idle' });
  assert.equal(world.shows(), 1, 'the status page found it warm');
  world.t.lastOutputAt = 6; world.t.preview = WORKING;
  await w.tick();
  assert.equal(world.shows(), 2);
  assert.deepEqual(await piStatus({ path: repoDir }, world.orca), { state: 'busy' });
  assert.equal(world.shows(), 2);
});

// ---------- GET /api/perf: liveCache ----------
const freePort = () => new Promise((resolve) => {
  const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
});

async function withServer(fn) {
  const port = await freePort();
  const server = createServer(port, {});
  await new Promise((r) => server.listen(port, '127.0.0.1', r));
  const call = (method, p, token) => new Promise((resolve, reject) => {
    const h = { host: `127.0.0.1:${port}`, ...(token ? { 'x-token': token } : {}) };
    const req = http.request({ host: '127.0.0.1', port, path: p, method, headers: h }, (res) => {
      let d = ''; res.on('data', (c) => { d += c; }); res.on('end', () => resolve({ status: res.statusCode, text: d }));
    });
    req.on('error', reject);
    req.end();
  });
  try {
    const token = /name="?token"? content="([0-9a-f]+)"/.exec((await call('GET', '/')).text)[1];
    const perf = async () => JSON.parse((await call('GET', '/api/perf', token)).text);
    // Only the terminal counters: the shared-list ones (listHits, listMisses) are pinned in rp77-list.test.js.
    await fn({ call, token, perf, liveCache: async () => { const { hits, misses, size } = (await perf()).liveCache; return { hits, misses, size }; } });
  } finally { server.close(); server.closeAllConnections(); }
}

const lo = (handle, at, dir = repoDir) => ({ handle, worktreePath: dir, connected: true, writable: true, lastOutputAt: at });
const orcaFor = (screens, fail = new Set()) => async (args) => {
  if (args[0] === 'show') { if (fail.has(args[2])) throw new Error('show failed'); return { terminal: { preview: screens[args[2]] } }; }
  throw new Error(`unexpected ${args[0]}`);
};

test('GET /api/perf answers routes, queue and liveCache { hits, misses, size, listHits, listMisses } (integers), still behind the token', async () => {
  await withServer(async ({ call, token, perf }) => {
    assert.equal((await call('GET', '/api/perf')).status, 401);
    const body = await perf();
    assert.deepEqual(Object.keys(body).sort(), ['liveCache', 'queue', 'routes']);
    assert.deepEqual(Object.keys(body.liveCache).sort(), ['hits', 'listHits', 'listMisses', 'misses', 'size']);
    assert.deepEqual(body.liveCache, { hits: 0, misses: 0, size: 0, listHits: 0, listMisses: 0 });
    assert.deepEqual(body.queue, { active: 0, max: 2, waitingBackground: 0, waitingUser: 0 });
    assert.ok(token);
  });
});

test('liveCache counts terminals: a first cached read is a miss, a served one is a hit, size is the entries stored', async () => {
  await withServer(async ({ liveCache }) => {
    const orca = orcaFor({ a: IDLE, b: WORKING });
    const listed = [lo('a', 1), lo('b', 2)];
    await scanSessions(repoDir, orca, listed, false, true, { cached: true });
    assert.deepEqual(await liveCache(), { hits: 0, misses: 2, size: 2 });
    await scanSessions(repoDir, orca, listed, false, true, { cached: true });
    assert.deepEqual(await liveCache(), { hits: 2, misses: 2, size: 2 });
    await scanSessions(repoDir, orca, [lo('a', 1), lo('b', 3)], false, true, { cached: true });
    assert.deepEqual(await liveCache(), { hits: 3, misses: 3, size: 2 }, 'b changed: one hit (a), one miss (b)');
  });
});

test('liveCache counts nothing for uncached scans, nor for a cached scan without a listed array', async () => {
  await withServer(async ({ liveCache }) => {
    const calls = [];
    const orca = async (args) => { calls.push(args[0]); return args[0] === 'list' ? { terminals: [lo('a', 1)] } : { terminal: { preview: IDLE } }; };
    await scanSessions(repoDir, orca, [lo('a', 1)], false, true);
    await scanSessions(repoDir, orca, [lo('a', 1)], false, true, { cached: false });
    await scanSessions(repoDir, orca, undefined, false, true, { cached: true });
    assert.deepEqual(await liveCache(), { hits: 0, misses: 0, size: 0 });
  });
});

test('liveCache: an expired entry is a miss, a failed read is a miss that is not stored, a dropped terminal leaves the size', async () => {
  await withServer(async ({ liveCache }) => {
    let clock = 0;
    const opts = { cached: true, now: () => clock };
    const orca = orcaFor({ a: IDLE, b: IDLE });
    await scanSessions(repoDir, orca, [lo('a', 1)], false, true, opts);
    clock = 29999;
    await scanSessions(repoDir, orca, [lo('a', 1)], false, true, opts);
    assert.deepEqual(await liveCache(), { hits: 1, misses: 1, size: 1 });
    clock = 30000;
    await scanSessions(repoDir, orca, [lo('a', 1)], false, true, opts);
    assert.deepEqual(await liveCache(), { hits: 1, misses: 2, size: 1 });
    await scanSessions(repoDir, orcaFor({ a: IDLE, b: IDLE }, new Set(['b'])), [lo('a', 1), lo('b', 9)], false, true, opts);
    assert.deepEqual(await liveCache(), { hits: 2, misses: 3, size: 1 }, 'b failed: counted as a miss, not stored');
    await scanSessions(repoDir, orca, [lo('b', 9)], false, true, opts);
    assert.deepEqual(await liveCache(), { hits: 2, misses: 4, size: 1 }, 'a dropped, b stored');
  });
});

test('liveCache: the counters are cumulative across scans and requests; clearLiveCache resets all three', async () => {
  await withServer(async ({ perf, liveCache }) => {
    const orca = orcaFor({ a: IDLE });
    for (let i = 0; i < 4; i++) await scanSessions(repoDir, orca, [lo('a', 1)], false, true, { cached: true });
    assert.deepEqual(await liveCache(), { hits: 3, misses: 1, size: 1 });
    await perf();
    assert.deepEqual(await liveCache(), { hits: 3, misses: 1, size: 1 }, 'reading the counters changes nothing');
    clearLiveCache();
    assert.deepEqual(await liveCache(), { hits: 0, misses: 0, size: 0 });
    await scanSessions(repoDir, orca, [lo('a', 1)], false, true, { cached: true });
    assert.deepEqual(await liveCache(), { hits: 0, misses: 1, size: 1 });
  });
});

test('liveCache does not leak handles, paths or screens into the payload', async () => {
  await withServer(async ({ perf, token }) => {
    await scanSessions(repoDir, orcaFor({ 'term-secret-9': IDLE }), [lo('term-secret-9', 1)], false, true, { cached: true });
    const text = JSON.stringify(await perf());
    for (const leak of ['term-secret-9', repoDir, 'repo-one', 'waiting for input', token]) assert.ok(!text.includes(leak), `leaks ${leak}`);
  });
});
