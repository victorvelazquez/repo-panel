'use strict';
// RP31: a server-side watcher that scans the pi sessions by itself so the passive recorder sees them without the page.
// It only calls `orca terminal list` once per tick and `scan` once per folder; nothing it does is shown to the user.
// These tests use fake timers and fake orca/scan: no real timer, no Orca, no .panel/.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const lf = (text) => text.replace(/\r\n/g, '\n');
const ROOT = path.join(__dirname, '..');
const vigia = require('../server/vigia.js');
const pi = require('../server/pi.js');

// A fake clock: setTimer records, fire() runs the pending callback, unref is observable.
function fakeTimers() {
  const t = { pending: null, set: [], cleared: 0, unrefs: 0 };
  t.setTimer = (fn, ms) => { const h = { fn, ms, unref() { t.unrefs++; return h; } }; t.pending = h; t.set.push(ms); return h; };
  t.clearTimer = (h) => { t.cleared++; if (t.pending === h) t.pending = null; };
  t.fire = async () => { const h = t.pending; t.pending = null; await h.fn(); };
  return t;
}
const make = (over = {}) => {
  const calls = { orca: [], scan: [], log: [] };
  const timers = fakeTimers();
  let clock = 1000;
  const w = vigia.createWatcher({
    listRepoFolders: () => ['C:/a', 'C:/b'],
    orca: async (args) => { calls.orca.push(args.join(' ')); return { terminals: [{ handle: 't1' }] }; },
    scan: async (folder, orca, terminals) => { calls.scan.push([folder, terminals]); return { sessions: [], failed: 0 }; },
    setTimer: timers.setTimer, clearTimer: timers.clearTimer, log: (m) => calls.log.push(m), now: () => clock,
    ...over,
  });
  return { w, calls, timers, advance: (ms) => { clock += ms; } };
};

test('tick: ONE list per tick, each folder scanned once with the already fetched list', async () => {
  const { w, calls } = make({ listRepoFolders: () => ['C:/a', 'C:/b', 'C:/c'] });
  await w.tick();
  assert.deepEqual(calls.orca, ['list']);
  assert.deepEqual(calls.scan.map((c) => c[0]), ['C:/a', 'C:/b', 'C:/c']);
  for (const c of calls.scan) assert.deepEqual(c[1], [{ handle: 't1' }]);
});

test('tick: a folder that appears twice (case, slashes, trailing slash) is scanned once', async () => {
  const { w, calls } = make({ listRepoFolders: () => ['C:\\Dev\\Repo', 'c:/dev/repo/', 'C:/Dev/Other'] });
  await w.tick();
  assert.deepEqual(calls.scan.map((c) => c[0]), ['C:\\Dev\\Repo', 'C:/Dev/Other']);
});

test('tick: an overlapping tick is skipped while the previous one is pending', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const { w, calls } = make({ orca: async (a) => { calls2.push(a.join(' ')); await gate; return { terminals: [] }; } });
  const calls2 = [];
  const first = w.tick();
  await w.tick();
  assert.deepEqual(calls2, ['list']);
  release();
  await first;
  await w.tick();
  assert.equal(calls2.length, 2);
  assert.equal(calls.scan.length, 4);
});

test('tick: a failing list never rejects, scans nothing, and warns at most once per 10 minutes', async () => {
  const { w, calls, advance } = make({ orca: async () => { throw new Error('Orca CLI is unavailable'); } });
  await w.tick();
  await w.tick();
  advance(9 * 60 * 1000);
  await w.tick();
  assert.equal(calls.log.length, 1);
  assert.deepEqual(calls.scan, []);
  advance(2 * 60 * 1000);
  await w.tick();
  assert.equal(calls.log.length, 2);
});

test('tick: a throwing scan or listRepoFolders never rejects, the other folders still get scanned', async () => {
  const seen = [];
  const { w, calls } = make({ scan: async (f) => { seen.push(f); if (f === 'C:/a') throw new Error('boom'); } });
  await w.tick();
  assert.deepEqual(seen, ['C:/a', 'C:/b']);
  assert.equal(calls.log.length, 1);
  const bad = make({ listRepoFolders: () => { throw new Error('bad config'); } });
  await bad.w.tick();
  assert.equal(bad.calls.log.length, 1);
  assert.deepEqual(bad.calls.orca, []);
});

test('tick: folders are read fresh each tick, so a repo added later is scanned on the next tick', async () => {
  let folders = ['C:/a'];
  const { w, calls } = make({ listRepoFolders: () => folders });
  await w.tick();
  folders = ['C:/a', 'C:/new'];
  await w.tick();
  assert.deepEqual(calls.scan.map((c) => c[0]), ['C:/a', 'C:/a', 'C:/new']);
});

test('tick: a list without a terminals array is treated as an Orca failure, not as "no terminals"', async () => {
  const { w, calls } = make({ orca: async () => ({}) });
  await w.tick();
  assert.deepEqual(calls.scan, []);
  assert.equal(calls.log.length, 1);
});

test('start/stop: first tick after firstDelayMs (5000 default), then every intervalMs (60000 default), unref, stop clears', async () => {
  const { w, calls, timers } = make();
  w.start();
  assert.deepEqual(timers.set, [5000]);
  assert.equal(timers.unrefs, 1);
  await timers.fire();
  assert.deepEqual(calls.orca, ['list']);
  assert.deepEqual(timers.set, [5000, 60000]);
  assert.equal(timers.unrefs, 2);
  w.stop();
  assert.equal(timers.cleared, 1);
  assert.equal(timers.pending, null);
});

test('start/stop: custom delays are honoured; start twice does not stack timers; a stopped watcher does not re-arm', async () => {
  const { w, timers } = make({ intervalMs: 15000, firstDelayMs: 100 });
  w.start();
  w.start();
  assert.deepEqual(timers.set, [100]);
  await timers.fire();
  assert.deepEqual(timers.set, [100, 15000]);
  w.stop();
  w.stop();
  assert.equal(timers.pending, null);
});

test('watchInterval: unset gives 60000; 0, off, invalid disable; below 10000 clamps; valid is kept', () => {
  assert.equal(vigia.watchInterval({}), 60000);
  assert.equal(vigia.watchInterval({ REPO_PANEL_WATCH_MS: '0' }), null);
  assert.equal(vigia.watchInterval({ REPO_PANEL_WATCH_MS: 'off' }), null);
  assert.equal(vigia.watchInterval({ REPO_PANEL_WATCH_MS: 'OFF' }), null);
  assert.equal(vigia.watchInterval({ REPO_PANEL_WATCH_MS: 'abc' }), null);
  assert.equal(vigia.watchInterval({ REPO_PANEL_WATCH_MS: '-5' }), null);
  assert.equal(vigia.watchInterval({ REPO_PANEL_WATCH_MS: '' }), null);
  assert.equal(vigia.watchInterval({ REPO_PANEL_WATCH_MS: '500' }), 10000);
  assert.equal(vigia.watchInterval({ REPO_PANEL_WATCH_MS: '10000' }), 10000);
  assert.equal(vigia.watchInterval({ REPO_PANEL_WATCH_MS: '45000' }), 45000);
});

test('folders: every repo of every group plus every room path, from a fresh config', () => {
  const cfg = { groups: [{ name: 'g', repos: [{ path: 'C:/a' }, { path: 'C:/b' }] }, { name: 'h', repos: [{ path: 'C:/c' }] }], rooms: [{ name: 'r', path: 'C:/room', repos: [] }] };
  assert.deepEqual(vigia.foldersOf(cfg), ['C:/a', 'C:/b', 'C:/c', 'C:/room']);
  assert.deepEqual(vigia.foldersOf({ groups: [] }), []);
});

test('the default scan is scanSessions (the same function the page uses)', () => {
  assert.equal(vigia.defaultScan, pi.scanSessions);
});

test('wiring: requiring vigia, pi, http and server starts no timer and installs nothing', () => {
  const real = global.setTimeout;
  const realI = global.setInterval;
  let started = 0;
  global.setTimeout = (...a) => { started++; return real(...a); };
  global.setInterval = (...a) => { started++; return realI(...a); };
  try {
    for (const m of ['../server/vigia.js', '../server/pi.js', '../server/http.js', '../server.js']) require(m);
  } finally { global.setTimeout = real; global.setInterval = realI; }
  assert.equal(started, 0);
  assert.equal(pi.caseRecorderInstalled(), false);
});

test('wiring: only the require.main block of server.js starts the watcher, and only when a recorder was installed', () => {
  const src = lf(fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8'));
  const block = /if \(require\.main === module\) \{[\s\S]*?\n\}\n/.exec(src)[0];
  assert.match(block, /createWatcher\(/);
  assert.match(block, /REPO_PANEL_WATCH_MS|watchInterval\(/);
  assert.equal(src.replace(block, '').includes('createWatcher('), false);
  // the watcher is created inside the `if (cases)` branch that installs the recorder
  const branch = /if \(cases\) \{[\s\S]*?\n  \}\n/.exec(block);
  assert.ok(branch, 'the recorder branch must be a block');
  assert.match(branch[0], /setCaseRecorder\(/);
  assert.match(branch[0], /createWatcher\(/);
  assert.match(branch[0], /\.start\(\)/);
  for (const f of ['server/pi.js', 'server/http.js', 'server/rooms.js', 'lib.js']) {
    assert.doesNotMatch(lf(fs.readFileSync(path.join(ROOT, f), 'utf8')), /createWatcher\(/, f);
  }
});

test('PRESERVE: scanSessions still scans a folder from its own list when none is given, and uses the given one otherwise', async () => {
  const orca = async (args) => {
    if (args[0] === 'list') return { terminals: [{ handle: 'h', connected: true, writable: true, worktreePath: 'C:/r' }] };
    return { terminal: { preview: '' } };
  };
  const own = await pi.scanSessions('C:/r', orca);
  const given = await pi.scanSessions('C:/r', orca, [{ handle: 'h', connected: true, writable: true, worktreePath: 'C:/r' }]);
  assert.deepEqual(own, given);
  assert.deepEqual(await pi.scanSessions('C:/r', orca, []), { sessions: [], failed: 0 });
});
