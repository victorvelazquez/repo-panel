'use strict';
// RP80b (S68, S76), design point 2: store.catchUp(id) reads ALL facts of that repo now (joined with a cycle already in flight) and schedules
// exactly ONE more forced read `catchUpDelayMs` later (default 5000) through the injected setTimer. One pending timer per repo: a new catchUp reads
// now again but neither stacks nor rearms it. The delayed read swallows every error; stop() clears it; ids that are not repos are ignored.
// Injected readers, a fake clock and fake timers (fired by hand): no sleeps, nothing of the real config, Orca, git or gh.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { AsyncLocalStorage } = require('node:async_hooks');

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'rp80bc-'));
process.env.REPO_PANEL_CONFIG = path.join(scratch, 'config.json');
process.env.REPO_PANEL_CASES_FILE = 'off';
const { mock } = test;
test.after(() => { mock.restoreAll(); fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 5 }); });

const exec = require('../server/exec.js');
const lib = require('../lib.js');
const lane = new AsyncLocalStorage();
const realWithPriority = exec.withPriority;
mock.method(exec, 'withPriority', (priority, fn) => lane.run(priority, () => realWithPriority(priority, fn)));
const { createSummaryStore } = require('../server/summarystore.js');

const GOOD = {
  local: { branch: 'main', files: [], ahead: 0, behind: 0, base: 'main' },
  prs: { prs: [], stale: null },
  roadmap: { available: false, reason: 'missing' },
  state: { available: false },
  req: { available: true, base: 'main', results: [], summary: { ok: 0, total: 0 } },
};
const KINDS = ['local', 'prs', 'roadmap', 'state', 'git', 'req'];
const DEP = { local: 'local', prs: 'prs', roadmap: 'roadmap', state: 'state', git: 'git', req: 'requirements' };
const flush = async () => { for (let i = 0; i < 25; i++) await new Promise((r) => setImmediate(r)); };
const gate = () => { let open; const p = new Promise((r) => { open = r; }); return { p, open }; };
const pathOf = (name) => `/work/${name}`;
const idOf = (name) => lib.repoId(pathOf(name));

// The injected timers: each one is recorded and fired by hand. `unref` is a method of the timer unless `plain`.
function timers({ plain = false } = {}) {
  const list = [];
  return {
    list,
    setTimer(fn, ms) {
      const t = { fn, ms, cleared: false, fired: false, unrefs: 0 };
      if (!plain) t.unref = () => { t.unrefs++; };
      list.push(t);
      return t;
    },
    clearTimer(t) { t.cleared = true; },
    pending: () => list.filter((t) => !t.cleared && !t.fired),
    fire: async (t) => { t.fired = true; await t.fn(); await flush(); },
  };
}

function setup({ repos = ['alpha', 'beta'], timer = timers(), ...opts } = {}) {
  const e = { t: 7000000, hooks: {}, lanes: [], timer, calls: Object.fromEntries(KINDS.map((k) => [k, []])) };
  e.cfg = { groups: [{ name: 'G', repos: repos.map((n) => ({ path: pathOf(n) })) }], rooms: [{ name: 'UPEN', repos: [] }], snoozed: [] };
  const reader = (kind) => async (repo) => {
    const at = kind === 'git' ? repo : repo.path;
    const n = e.calls[kind].filter((p) => p === at).length + 1;
    e.calls[kind].push(at);
    e.lanes.push(lane.getStore());
    const hook = e.hooks[`${kind}:${at}`];
    if (hook) return hook(n);
    return kind === 'git' ? { code: 0, stdout: '2026-10-28T10:00:00Z\nsubject\n', stderr: '' } : structuredClone(GOOD[kind]);
  };
  e.deps = Object.fromEntries(KINDS.map((k) => [DEP[k], reader(k)]));
  e.store = createSummaryStore({ deps: e.deps, now: () => e.t, loadCfg: () => e.cfg, setTimer: timer.setTimer, clearTimer: timer.clearTimer, ...opts });
  e.hook = (kind, name, fn) => { e.hooks[`${kind}:${pathOf(name)}`] = fn; };
  e.count = (kind, name) => e.calls[kind].filter((p) => p === pathOf(name)).length;
  e.of = (name) => Object.fromEntries(KINDS.map((k) => [k, e.count(k, name)]));
  return e;
}
const all = (n) => Object.fromEntries(KINDS.map((k) => [k, n]));

test('catchUp returns a promise that resolves after ALL six facts of that repo were read once, in the background lane, and no other repo is read', async () => {
  const e = setup();
  const p = e.store.catchUp(idOf('alpha'));
  assert.equal(typeof p.then, 'function');
  assert.equal(await p, undefined);
  assert.deepEqual(e.of('alpha'), all(1));
  assert.deepEqual(e.of('beta'), all(0));
  assert.deepEqual([...new Set(e.lanes)], ['background']);
});

test('catchUp forces the read even when every fact is fresh (a refreshAll just before does not make it a no-op)', async () => {
  const e = setup();
  await e.store.refreshAll();
  await e.store.catchUp(idOf('alpha'));
  assert.deepEqual(e.of('alpha'), all(2));
  assert.deepEqual(e.of('beta'), all(1));
});

test('catchUp arms exactly one timer of 5000 ms by default (unref-ed) and reads nothing more until it fires; firing reads all facts again and arms nothing', async () => {
  const e = setup();
  await e.store.catchUp(idOf('alpha'));
  const [t] = e.timer.list;
  assert.equal(e.timer.list.length, 1);
  assert.equal(t.ms, 5000);
  assert.equal(t.unrefs, 1);
  await flush();
  assert.deepEqual(e.of('alpha'), all(1), 'nothing is read before the delay');
  await e.timer.fire(t);
  assert.deepEqual(e.of('alpha'), all(2), 'one more forced read of the repo');
  assert.deepEqual(e.of('beta'), all(0));
  assert.equal(e.timer.list.length, 1, 'the delayed read arms no further timer');
  assert.deepEqual(e.timer.pending(), []);
  assert.equal(t.cleared, false);
});

test('catchUpDelayMs is an option, and a timer without unref (a plain handle) works', async () => {
  const e = setup({ catchUpDelayMs: 1234, timer: timers({ plain: true }) });
  await e.store.catchUp(idOf('alpha'));
  assert.deepEqual(e.timer.list.map((t) => t.ms), [1234]);
  await e.timer.fire(e.timer.list[0]);
  assert.deepEqual(e.of('alpha'), all(2));
});

test('two catchUps within the delay read now twice but keep ONE pending timer, the original one, not rearmed; three read three times; firing reads once more', async () => {
  const e = setup();
  await e.store.catchUp(idOf('alpha'));
  const [t] = e.timer.list;
  await e.store.catchUp(idOf('alpha'));
  assert.deepEqual(e.of('alpha'), all(2));
  assert.deepEqual(e.timer.list, [t], 'no second timer');
  assert.equal(t.cleared, false, 'not rearmed (never cleared)');
  assert.equal(t.ms, 5000);
  await e.store.catchUp(idOf('alpha'));
  assert.deepEqual(e.of('alpha'), all(3));
  assert.deepEqual([e.timer.list.length, e.timer.pending().length], [1, 1]);
  await e.timer.fire(t);
  assert.deepEqual(e.of('alpha'), all(4), 'exactly ONE delayed read for three catchUps');
  assert.deepEqual(e.timer.pending(), []);
});

test('after the delayed read fired, a new catchUp reads now and arms a new timer again', async () => {
  const e = setup();
  await e.store.catchUp(idOf('alpha'));
  await e.timer.fire(e.timer.list[0]);
  await e.store.catchUp(idOf('alpha'));
  assert.deepEqual(e.of('alpha'), all(3));
  assert.deepEqual(e.timer.list.map((t) => [t.ms, t.fired]), [[5000, true], [5000, false]]);
});

test('the pending timer is per repo: two repos arm two timers, and each fires its own repo only', async () => {
  const e = setup();
  await e.store.catchUp(idOf('alpha'));
  await e.store.catchUp(idOf('beta'));
  await e.store.catchUp(idOf('alpha'));
  assert.equal(e.timer.list.length, 2);
  await e.timer.fire(e.timer.list[1]);
  assert.deepEqual([e.of('alpha'), e.of('beta')], [all(2), all(2)]);
  await e.timer.fire(e.timer.list[0]);
  assert.deepEqual([e.of('alpha'), e.of('beta')], [all(3), all(2)]);
});

test('a catchUp during a running cycle joins it (no second read of that repo) and still arms its delayed read once', async () => {
  const e = setup();
  const held = gate();
  e.hook('local', 'alpha', () => held.p.then(() => GOOD.local));
  const running = e.store.refreshRepo(idOf('alpha'));
  await flush();
  assert.equal(e.count('local', 'alpha'), 1);
  let joined = false;
  const catching = e.store.catchUp(idOf('alpha')).then(() => { joined = true; });
  await flush();
  assert.equal(joined, false, 'it waits for the cycle in flight');
  assert.deepEqual(e.of('alpha'), all(1), 'no extra read while the cycle runs');
  held.open();
  await Promise.all([running, catching]);
  assert.deepEqual(e.of('alpha'), all(1));
  assert.deepEqual(e.timer.list.map((t) => t.ms), [5000], 'one delayed read armed');
  await e.timer.fire(e.timer.list[0]);
  assert.deepEqual(e.of('alpha'), all(2));
});

test('a catchUp joins a refreshAll sweep in flight too', async () => {
  const e = setup();
  const held = gate();
  e.hook('prs', 'alpha', () => held.p.then(() => GOOD.prs));
  const sweep = e.store.refreshAll();
  await flush();
  const catching = e.store.catchUp(idOf('alpha'));
  await flush();
  held.open();
  await Promise.all([sweep, catching]);
  assert.deepEqual([e.of('alpha'), e.of('beta')], [all(1), all(1)]);
  assert.equal(e.timer.list.length, 1);
});

test('an id that is not a repo of the config (a room, unknown, not a string) is ignored: it resolves, reads nothing, arms nothing, never rejects', async () => {
  const e = setup();
  for (const id of ['room:UPEN', 'unknown', '', 42, null, undefined, {}, ['x'], true]) {
    assert.equal(await e.store.catchUp(id), undefined, String(id));
  }
  await flush();
  assert.deepEqual([e.of('alpha'), e.of('beta')], [all(0), all(0)]);
  assert.deepEqual(e.timer.list, []);
});

test('the delayed read swallows every error: readers that throw, a repo gone from the config, a config that cannot be loaded; no unhandled rejection', async () => {
  const seen = [];
  const onRejection = (err) => seen.push(err);
  process.on('unhandledRejection', onRejection);
  try {
    const down = setup();
    for (const k of ['local', 'prs', 'roadmap', 'state', 'req']) down.hook(k, 'alpha', (n) => { if (n > 1) throw new Error(`${k} down`); return GOOD[k]; });
    await down.store.catchUp(idOf('alpha'));
    await assert.doesNotReject(down.timer.fire(down.timer.list[0]));
    assert.deepEqual(down.of('alpha'), all(2), 'the delayed read ran, its failures stayed on the facts');

    const gone = setup();
    await gone.store.catchUp(idOf('alpha'));
    gone.cfg = { ...gone.cfg, groups: [{ name: 'G', repos: [{ path: pathOf('beta') }] }] };
    await assert.doesNotReject(gone.timer.fire(gone.timer.list[0]));
    assert.deepEqual([gone.of('alpha'), gone.of('beta')], [all(1), all(0)], 'the repo is gone: nothing is read');

    const broken = setup();
    await broken.store.catchUp(idOf('alpha'));
    broken.cfg = null; // loadCfg() then throws on `.groups`
    await assert.doesNotReject(broken.timer.fire(broken.timer.list[0]));
    await flush();
    assert.deepEqual(seen, []);
  } finally { process.off('unhandledRejection', onRejection); }
});

test('stop() before the delay clears the pending timer, and no delayed read happens; stop() with nothing pending is harmless', async () => {
  const e = setup();
  e.store.stop();
  await e.store.catchUp(idOf('alpha'));
  await e.store.catchUp(idOf('beta'));
  assert.equal(e.timer.pending().length, 2);
  e.store.stop();
  assert.deepEqual(e.timer.pending(), []);
  assert.deepEqual(e.timer.list.map((t) => t.cleared), [true, true]);
  await flush();
  assert.deepEqual([e.of('alpha'), e.of('beta')], [all(1), all(1)]);
  assert.doesNotThrow(() => e.store.stop());
});

test('catchUp is not a client: it does not touch(), works with waitForClient true, and the loop stays passive and idle afterwards', async () => {
  const e = setup({ waitForClient: true });
  await e.store.tick();
  assert.deepEqual(e.of('alpha'), all(0), 'control: no client, no work');
  await e.store.catchUp(idOf('alpha'));
  assert.deepEqual(e.of('alpha'), all(1), 'explicit like refreshRepo: it reads with waitForClient true');
  e.t += 60000;
  await e.store.tick();
  assert.deepEqual([e.of('alpha'), e.of('beta')], [all(1), all(0)], 'it did not make the store active: the loop still reads nothing');
  await e.timer.fire(e.timer.list[0]);
  assert.deepEqual(e.of('alpha'), all(2), 'the delayed read also runs with waitForClient true');
});

test('catchUp does not end the idle mode: 15000 ms later an idle store reads nothing (an active one would read local and state)', async () => {
  const e = setup({ waitForClient: false });
  e.store.touch();
  e.t += 60000; // idle: 60000 ms without a client
  await e.store.catchUp(idOf('alpha'));
  assert.deepEqual(e.of('alpha'), all(1));
  e.t += 15000;
  await e.store.tick();
  assert.deepEqual(e.of('alpha'), all(1), 'still idle (idleFast is 30000)');
  e.t += 15000;
  await e.store.tick();
  assert.equal(e.count('local', 'alpha'), 2, 'the idle interval of 30000 is what moved it');
});

// ---------- verification mutation: the immediate read must not reject either when the config cannot be loaded ----------
test('catchUp resolves, arms nothing and reads nothing when the config cannot be loaded right now', async () => {
  const e = setup();
  e.cfg = null; // loadCfg() throws on `.groups`
  await assert.doesNotReject(e.store.catchUp(idOf('alpha')));
  assert.deepEqual(e.timer.pending(), []);
  assert.deepEqual([e.of('alpha'), e.of('beta')], [all(0), all(0)]);
});

// ---------- light verification: a removed repo is never read as a ghost; stop() then start() arms the delayed read again ----------
const totalCalls = (e) => KINDS.reduce((n, k) => n + e.calls[k].length, 0);

test('the delayed read of a repo removed from the config reads NOTHING at all (not even a ghost repo) and leaves no facts behind', async () => {
  const e = setup();
  await e.store.catchUp(idOf('alpha'));
  const reads = totalCalls(e);
  e.cfg = { ...e.cfg, groups: [{ name: 'G', repos: [{ path: pathOf('beta') }] }] };
  await e.timer.fire(e.timer.list[0]);
  assert.equal(totalCalls(e), reads, 'no reader was called by anyone');
  assert.deepEqual(Object.keys(e.store.board(0).repos), [idOf('beta')], 'and the removed repo has no entry');
});

test('after stop() and start() a catchUp arms its delayed read again (stop() forgets the pending ones, not only clears their timers)', async () => {
  const e = setup();
  await e.store.catchUp(idOf('alpha'));
  assert.equal(e.timer.pending().length, 1);
  e.store.stop();
  assert.deepEqual(e.timer.pending(), []);
  e.store.start();
  const before = e.timer.list.length;
  await e.store.catchUp(idOf('alpha'));
  const armed = e.timer.list.slice(before).filter((t) => t.ms === 5000 && !t.cleared);
  assert.equal(armed.length, 1, 'one delayed read is armed again');
});

// ---------- found by the full suite: no client, no work (a server nobody has asked must not start reads after an action) ----------
test('awake(): false for a store nobody has asked; snapshot(), board() and touch() wake it; catchUp, refreshRepo, refreshAll and tick do not', async () => {
  const fresh = () => setup({ repos: ['alpha'], waitForClient: true });
  assert.equal(typeof fresh().store.awake, 'function');
  assert.equal(fresh().store.awake(), false);
  for (const wake of ['snapshot', 'board', 'touch']) {
    const e = fresh();
    e.store[wake]();
    assert.equal(e.store.awake(), true, wake);
  }
  const e = fresh();
  await e.store.catchUp(idOf('alpha'));
  await e.store.refreshRepo(idOf('alpha'));
  await e.store.refreshAll();
  await e.store.tick();
  assert.equal(e.store.awake(), false, 'explicit reads and the loop are not a client');
});
