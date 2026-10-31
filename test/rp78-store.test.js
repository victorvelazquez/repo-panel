'use strict';
// RP78 (S68, S73), points 1-6: server/summarystore.js, the Summary kept in memory. createSummaryStore({ deps, now, loadCfg, setTimer,
// clearTimer, intervals, idleAfterMs, pool }) -> { snapshot, refreshRepo, refreshAll, setSession, touch, start, stop, tick }.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { AsyncLocalStorage } = require('node:async_hooks');

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'rp78s-'));
process.env.REPO_PANEL_CONFIG = path.join(scratch, 'config.json');
process.env.REPO_PANEL_CASES_FILE = 'off';
const { mock } = test;
test.after(() => { mock.restoreAll(); fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 5 }); });

const exec = require('../server/exec.js');
const lib = require('../lib.js');
const { HttpError } = require('../server/errors.js');
const { summarize } = require('../server/summary.js');

// The lane a reader runs in: withPriority is wrapped BEFORE the store is first required (it is required lazily, test by test).
const lane = new AsyncLocalStorage();
const realWithPriority = exec.withPriority;
mock.method(exec, 'withPriority', (priority, fn) => lane.run(priority, () => realWithPriority(priority, fn)));
// waitForClient false: these tests drive tick() directly without a page having asked (the lazy default is pinned in rp78-extra.test.js)
const make = (opts) => require('../server/summarystore.js').createSummaryStore({ waitForClient: false, intervals: { fast: 5000 }, ...opts });

const GOOD = {
  local: { branch: 'main', files: [], ahead: 0, behind: 0, base: 'main' },
  prs: { prs: [{ number: 9, title: 'T', ready: true, checks: { state: 'success' } }], stale: null },
  roadmap: { available: false, reason: 'missing' },
  state: { available: false },
};
const LAST = { at: '2026-10-28T10:00:00Z', what: 'subject' };
const KINDS = ['local', 'prs', 'roadmap', 'state', 'git'];
const flush = async () => { for (let i = 0; i < 25; i++) await new Promise((r) => setImmediate(r)); };
const gate = () => { let open; const p = new Promise((r) => { open = r; }); return { p, open }; };
const pathOf = (name) => `/work/${name}`;
const idOf = (name) => lib.repoId(pathOf(name));

function setup({ repos = ['alpha', 'beta', 'gamma'], ...opts } = {}) {
  const e = { t: 1000000, hooks: {}, lanes: [], timers: [], cleared: [], calls: Object.fromEntries(KINDS.map((k) => [k, []])), gitArgs: [] };
  e.cfg = { groups: [{ name: 'G', repos: repos.map((n) => ({ path: pathOf(n) })) }], rooms: [], snoozed: [] };
  const reader = (kind) => async (repo, args) => {
    const at = kind === 'git' ? repo : repo.path;
    const n = e.calls[kind].filter((p) => p === at).length + 1;
    e.calls[kind].push(at);
    e.lanes.push(lane.getStore());
    if (kind === 'git') e.gitArgs.push(args);
    const hook = e.hooks[`${kind}:${at}`];
    if (hook) return hook(n);
    return kind === 'git' ? { code: 0, stdout: `${LAST.at}\n${LAST.what}\n`, stderr: '' } : GOOD[kind];
  };
  e.deps = Object.fromEntries(KINDS.map((k) => [k, reader(k)]));
  e.setTimer = (fn, ms) => { const timer = { fn, ms, unrefs: 0, unref() { this.unrefs++; } }; e.timers.push(timer); return timer; };
  e.clearTimer = (timer) => { e.cleared.push(timer); };
  e.store = make({ deps: e.deps, now: () => e.t, loadCfg: () => e.cfg, setTimer: e.setTimer, clearTimer: e.clearTimer, ...opts });
  e.hook = (kind, name, fn) => { e.hooks[`${kind}:${pathOf(name)}`] = fn; };
  e.count = (kind, name) => e.calls[kind].filter((p) => p === pathOf(name)).length;
  e.totals = () => Object.fromEntries(KINDS.map((k) => [k, e.calls[k].length]));
  e.expected = (name, over = {}) => summarize({ repo: { id: idOf(name), name, group: 'G', room: null }, ...GOOD, last: LAST, session: 'unknown', snoozed: [], now: e.t, ...over });
  return e;
}
const total = (n) => ({ local: n, prs: n, roadmap: n, state: n, git: n });
const REAL_MAX_RANK = 2 + Math.max(...Object.values(lib.QUEUE_RANK)) + 3;
const LOADING = (name, room = null) => ({
  id: idOf(name), name, group: 'G', room, loading: true, branch: null,
  progress: { total: null, completada: null, enRevision: null, bloqueada: null, pendiente: null, enCurso: null },
  session: { state: 'unknown' }, next: null, blocking: [], lastMovement: { at: null, what: null }, action: null, error: null, needs: false,
});

// ---------- points 1-2: facts and snapshot ----------
test('creating a store reads nothing and arms nothing; it exposes exactly the pinned API', () => {
  const e = setup();
  assert.deepEqual(Object.keys(e.store).sort(), ['board', 'refreshAll', 'refreshRepo', 'setSession', 'snapshot', 'start', 'stop', 'tick', 'touch']); // RP80 added `board`
  assert.deepEqual(e.totals(), total(0));
  assert.equal(e.timers.length, 0);
});

test('a snapshot with no facts yet: one LOADING row per repo in config order, counted idle, zero reader calls', () => {
  const e = setup();
  const snap = e.store.snapshot();
  assert.deepEqual(Object.keys(snap), ['rows', 'counts', 'attention', 'generatedAt']);
  assert.equal(snap.rows.length, 3);
  snap.rows.forEach((row, i) => {
    const { rank, ...rest } = row;
    assert.deepEqual(rest, LOADING(['alpha', 'beta', 'gamma'][i]));
    assert.equal(typeof rank, 'number');
    assert.ok(rank > REAL_MAX_RANK, 'a loading row sorts after every real row');
  });
  assert.deepEqual(snap.counts, { working: 0, waiting: 0, blocked: 0, idle: 3 });
  assert.deepEqual(snap.attention, []);
  assert.equal(snap.generatedAt, new Date(e.t).toISOString());
  assert.deepEqual(e.totals(), total(0));
});

test('after refreshAll the snapshot is exactly what summarize gives, built from memory with zero new reader calls', async () => {
  const e = setup();
  await e.store.refreshAll();
  assert.deepEqual(e.totals(), total(3));
  const before = e.totals();
  const a = e.store.snapshot();
  const b = e.store.snapshot();
  assert.deepEqual(a.rows, ['alpha', 'beta', 'gamma'].map((n) => e.expected(n)));
  assert.deepEqual(a, b);
  assert.deepEqual(a.counts, { working: 0, waiting: 0, blocked: 0, idle: 3 });
  assert.deepEqual(e.totals(), before, 'a snapshot never calls a reader');
});

test('a repo with only SOME facts is still loading; once local, prs, roadmap and state were each read (even in error) it is not', async () => {
  const e = setup({ repos: ['alpha'] });
  const held = gate();
  e.hook('prs', 'alpha', () => held.p);
  const refreshing = e.store.refreshRepo(idOf('alpha'));
  await flush();
  assert.equal(e.count('prs', 'alpha'), 1);
  assert.equal(e.store.snapshot().rows[0].loading, true, 'prs still pending: a reader that never answers cannot block or complete the snapshot');
  held.open(GOOD.prs);
  await refreshing;
  assert.equal('loading' in e.store.snapshot().rows[0], false);

  const f = setup({ repos: ['alpha'] });
  for (const k of ['local', 'prs', 'roadmap', 'state']) f.hook(k, 'alpha', () => { throw new Error(`${k} down`); });
  await f.store.refreshAll();
  const [row] = f.store.snapshot().rows;
  assert.equal('loading' in row, false);
  assert.match(row.error, /down$/);
});

test('repos come from the config at call time: an added repo is loading, a removed one disappears, order is the config order', async () => {
  const e = setup({ repos: ['alpha', 'beta'] });
  await e.store.refreshAll();
  e.cfg = { ...e.cfg, groups: [{ name: 'G', repos: [{ path: pathOf('beta') }, { path: pathOf('delta') }] }] };
  const rows = e.store.snapshot().rows;
  assert.deepEqual(rows.map((r) => r.name), ['beta', 'delta']);
  assert.deepEqual(rows[0], e.expected('beta'));
  assert.equal(rows[1].loading, true);
  assert.deepEqual(e.store.snapshot().counts, { working: 0, waiting: 0, blocked: 0, idle: 2 });
  await e.store.tick();
  assert.equal(e.count('local', 'delta'), 1, 'the new repo is read by the next tick');
  assert.equal(e.count('local', 'beta'), 1);
  assert.equal(e.count('local', 'alpha'), 1, 'a removed repo is no longer refreshed');
});

test('rooms of the config reach the row; the loading row carries the room too', async () => {
  const e = setup({ repos: ['alpha', 'beta'] });
  e.cfg.rooms = [{ name: 'Room 1', path: '/work', repos: [idOf('alpha'), idOf('beta')] }];
  assert.equal(e.store.snapshot().rows[0].room, 'Room 1');
  await e.store.refreshRepo(idOf('alpha'));
  const rows = e.store.snapshot().rows;
  assert.equal(rows[0].room, 'Room 1');
  assert.deepEqual(rows[0], e.expected('alpha', { repo: { id: idOf('alpha'), name: 'alpha', group: 'G', room: 'Room 1' } }));
  assert.deepEqual(rows[1], { ...LOADING('beta', 'Room 1'), rank: rows[1].rank });
});

test('session comes only from setSession: unknown before, the summary mapping after, no reader call, an unknown repo is ignored', async () => {
  const e = setup({ repos: ['alpha', 'beta'] });
  await e.store.refreshAll();
  const before = e.totals();
  assert.deepEqual(e.store.snapshot().rows.map((r) => r.session), [{ state: 'unknown' }, { state: 'unknown' }]);
  const MAP = { closed: 'none', idle: 'free', busy: 'working', asking: 'waiting', ambiguous: 'unknown', unknown: 'unknown' };
  for (const [piState, shown] of Object.entries(MAP)) {
    e.store.setSession(idOf('alpha'), piState);
    assert.deepEqual(e.store.snapshot().rows[0], e.expected('alpha', { session: piState }), piState);
    assert.deepEqual(e.store.snapshot().rows[0].session, { state: shown });
  }
  e.store.setSession(idOf('alpha'), 'asking');
  e.store.setSession('nope000000', 'busy');
  const snap = e.store.snapshot();
  assert.deepEqual(snap.counts, { working: 0, waiting: 1, blocked: 0, idle: 1 });
  assert.deepEqual(snap.attention, [{ id: idOf('alpha'), name: 'alpha', why: 'The session is waiting for an answer' }]);
  assert.equal(snap.rows[0].action.kind, 'answer');
  assert.deepEqual(snap.rows[1], e.expected('beta'), 'another repo is untouched');
  assert.deepEqual(e.totals(), before);
});

test('one repo failing never changes another repo row', async () => {
  const e = setup({ repos: ['alpha', 'beta'] });
  const ok = setup({ repos: ['alpha', 'beta'] });
  e.hook('prs', 'beta', () => { throw new Error('gh exploded'); });
  await e.store.refreshAll();
  await ok.store.refreshAll();
  const [a, b] = e.store.snapshot().rows;
  assert.deepEqual(a, ok.store.snapshot().rows[0]);
  assert.equal(b.error, 'gh exploded');
  assert.deepEqual(e.store.snapshot().counts, { working: 0, waiting: 0, blocked: 0, idle: 1 }, 'an error row is not counted');
});

// ---------- point 3: failures keep the last good value ----------
test('a failing refresh (throw or {error}) keeps the previous value and names the fact in stale; recovery clears it', async () => {
  for (const fail of [() => { throw new Error('gh exploded'); }, () => ({ error: 'rate limited' })]) {
    const e = setup({ repos: ['alpha'] });
    e.hook('prs', 'alpha', (n) => (n === 2 ? fail() : GOOD.prs));
    await e.store.tick();
    e.t += 60000;
    e.store.touch();
    await e.store.tick();
    assert.equal(e.count('prs', 'alpha'), 2);
    const [row] = e.store.snapshot().rows;
    assert.deepEqual(row, { ...e.expected('alpha'), stale: { facts: ['prs'] } });
    assert.equal(row.action.kind, 'merge', 'the last good prs still drive the row');
    e.t += 59999;
    await e.store.tick();
    assert.equal(e.count('prs', 'alpha'), 2, 'a failed attempt is not retried before its interval');
    e.t += 1;
    await e.store.tick();
    assert.equal(e.count('prs', 'alpha'), 3);
    assert.deepEqual(e.store.snapshot().rows[0], e.expected('alpha'));
  }
});

test('a fact that never succeeded gives the error row analyse gives today, with the message', async () => {
  const cases = [
    ['prs', () => { throw new Error('gh exploded'); }, 'gh exploded'],
    ['local', () => ({ error: 'Folder not found' }), 'Folder not found'],
    ['state', () => { throw new Error('state unreadable'); }, 'state unreadable'],
    ['roadmap', () => { throw new Error('roadmap unreadable'); }, 'roadmap unreadable'],
  ];
  for (const [kind, hook, message] of cases) {
    const e = setup({ repos: ['alpha'] });
    e.hook(kind, 'alpha', hook);
    await e.store.refreshAll();
    const [row] = e.store.snapshot().rows;
    assert.equal(row.error, message, kind);
    assert.deepEqual(row, summarize({ repo: { id: idOf('alpha'), name: 'alpha', group: 'G', room: null }, last: LAST, session: 'unknown', error: message }), kind);
  }
});

test('stale also names facts older than 3 times their interval (exactly 3x is not older): local/state 5 s, the others 60 s', async () => {
  const e = setup({ repos: ['alpha'] });
  await e.store.refreshAll();
  e.t += 15000;
  assert.equal('stale' in e.store.snapshot().rows[0], false);
  e.t += 1;
  const stale = e.store.snapshot().rows[0].stale;
  assert.deepEqual([...stale.facts].sort(), ['local', 'state']);
  e.t += 180000 - 15001;
  assert.deepEqual([...e.store.snapshot().rows[0].stale.facts].sort(), ['local', 'state']);
  e.t += 1;
  assert.deepEqual([...e.store.snapshot().rows[0].stale.facts].sort(), ['last', 'local', 'prs', 'roadmap', 'state']);
});

// ---------- point 4: the refresh engine ----------
test('the first tick reads every fact of every repo once, in the background lane, and a second tick right after costs nothing', async () => {
  const e = setup();
  await e.store.tick();
  assert.deepEqual(e.totals(), total(3));
  assert.deepEqual(e.calls.local, [pathOf('alpha'), pathOf('beta'), pathOf('gamma')], 'config order');
  assert.ok(e.lanes.length > 0);
  assert.deepEqual([...new Set(e.lanes)], ['background']);
  await e.store.tick();
  assert.deepEqual(e.totals(), total(3));
});

test('a fact is due at age == interval, not before; never-read is due; fast: local+state, slow: prs+roadmap+last', async () => {
  const e = setup({ repos: ['alpha'] });
  e.store.touch();
  const sample = [];
  const step = async (dt) => { e.t += dt; e.store.touch(); await e.store.tick(); sample.push(e.totals()); };
  await e.store.tick();
  sample.push(e.totals());
  await step(4999);
  await step(1);
  await step(54999);
  await step(1);
  assert.deepEqual(sample, [
    total(1),
    total(1),
    { local: 2, prs: 1, roadmap: 1, state: 2, git: 1 },
    { local: 3, prs: 1, roadmap: 1, state: 3, git: 1 },
    { local: 3, prs: 2, roadmap: 2, state: 3, git: 2 },
  ]);
});

test('with pool 1 a held repo blocks the others; with pool 2 the others proceed and the tick ends only when the held one does', async () => {
  const one = setup({ pool: 1 });
  const held = gate();
  one.hook('local', 'alpha', () => held.p);
  const t1 = one.store.tick();
  await flush();
  assert.equal(one.count('local', 'alpha'), 1);
  assert.equal(one.count('local', 'beta') + one.count('local', 'gamma'), 0);
  held.open(GOOD.local);
  await t1;
  assert.deepEqual(one.totals(), total(3));

  const two = setup({ pool: 2 });
  const held2 = gate();
  let ended = false;
  two.hook('local', 'alpha', () => held2.p);
  const t2 = two.store.tick().then(() => { ended = true; });
  await flush();
  assert.equal(two.count('local', 'beta'), 1);
  assert.equal(two.count('local', 'gamma'), 1, 'gamma starts when beta is done: only 2 repos in flight');
  assert.equal(two.count('prs', 'gamma'), 1);
  assert.equal(ended, false);
  assert.equal(two.store.snapshot().rows[0].loading, true);
  held2.open(GOOD.local);
  await t2;
  assert.equal(two.store.snapshot().rows[0].loading, undefined);
});

test('a tick never overlaps another: a second tick() while one runs adds no reader call and ends with it', async () => {
  const e = setup({ repos: ['alpha'] });
  const held = gate();
  e.hook('local', 'alpha', () => held.p);
  const first = e.store.tick();
  await flush();
  const second = e.store.tick();
  await flush();
  assert.deepEqual(e.totals(), { local: 1, prs: 1, roadmap: 1, state: 1, git: 1 });
  held.open(GOOD.local);
  await Promise.all([first, second]);
  assert.deepEqual(e.totals(), total(1));
  e.t += 60000;
  e.store.touch();
  await e.store.tick();
  assert.equal(e.count('prs', 'alpha'), 2, 'a later tick works again');
});

test('refreshRepo forces ALL facts of that repo now (fresh or not) and nothing of the others; an unknown id is a 404 HttpError', async () => {
  const e = setup();
  await e.store.tick();
  await e.store.refreshRepo(idOf('beta'));
  assert.deepEqual(['alpha', 'beta', 'gamma'].map((n) => KINDS.map((k) => e.count(k, n))), [[1, 1, 1, 1, 1], [2, 2, 2, 2, 2], [1, 1, 1, 1, 1]]);
  const before = e.totals();
  await assert.rejects(e.store.refreshRepo('0000000000'), (err) => err instanceof HttpError && err.status === 404);
  assert.deepEqual(e.totals(), before);
  await e.store.refreshAll();
  assert.deepEqual(e.totals(), { local: 7, prs: 7, roadmap: 7, state: 7, git: 7 }, 'refreshAll forces fresh facts too');
});

test('refreshes of the same repo coalesce: one reader call per fact, also against a tick in flight and across refreshAll', async () => {
  const e = setup({ repos: ['alpha'] });
  const held = gate();
  e.hook('local', 'alpha', () => held.p);
  const ticking = e.store.tick();
  await flush();
  const a = e.store.refreshRepo(idOf('alpha'));
  const b = e.store.refreshAll();
  await flush();
  held.open(GOOD.local);
  await Promise.all([ticking, a, b]);
  assert.deepEqual(e.totals(), total(1));

  const f = setup();
  const held2 = gate();
  f.hook('prs', 'beta', () => held2.p);
  const x = f.store.refreshAll();
  const y = f.store.refreshAll();
  await flush();
  held2.open(GOOD.prs);
  await Promise.all([x, y]);
  assert.deepEqual(f.totals(), total(3));
});

// ---------- point 5: idle ----------
test('never touched counts as idle: intervals 30 s / 300 s; the boundary is age == interval', async () => {
  const e = setup({ repos: ['alpha'] });
  await e.store.tick();
  e.t += 29999;
  await e.store.tick();
  assert.deepEqual(e.totals(), total(1));
  e.t += 1;
  await e.store.tick();
  assert.deepEqual(e.totals(), { local: 2, prs: 1, roadmap: 1, state: 2, git: 1 });
  e.t += 269999;
  await e.store.tick();
  assert.equal(e.count('prs', 'alpha'), 1);
  e.t += 1;
  await e.store.tick();
  assert.deepEqual(e.totals(), { local: 3, prs: 2, roadmap: 2, state: 3, git: 2 });
});

test('idleAfterMs boundary: idle exactly when now - lastTouch >= idleAfterMs', async () => {
  const run = async (readAt, tickAt) => {
    const e = setup({ repos: ['alpha'] });
    const t0 = e.t;
    e.store.touch();
    e.t = t0 + readAt;
    await e.store.refreshAll();
    e.t = t0 + tickAt;
    await e.store.tick();
    return e.count('local', 'alpha');
  };
  assert.equal(await run(54999, 59999), 2, '59999 ms after the touch: still active, local (age 5000) is due');
  assert.equal(await run(55000, 60000), 1, '60000 ms after the touch: idle, local (age 5000) is not due');
});

test('snapshot() touches: after one the store is active again and refreshes at the fast interval', async () => {
  const e = setup({ repos: ['alpha'] });
  await e.store.tick();
  e.t += 5000;
  await e.store.tick();
  assert.equal(e.count('local', 'alpha'), 1, 'idle: 5 s is not due');
  e.store.snapshot();
  await e.store.tick();
  assert.equal(e.count('local', 'alpha'), 2);
});

// ---------- point 6: scheduling ----------
test('start arms one unref-ed timer that runs tick() and re-arms itself 1000 ms after the tick settled; a throwing reader never breaks the loop', async () => {
  const e = setup({ repos: ['alpha'] });
  e.hook('prs', 'alpha', () => { throw new Error('gh exploded'); });
  e.store.start();
  e.store.start();
  assert.equal(e.timers.length, 1, 'start is idempotent');
  assert.equal(e.timers[0].unrefs, 1);
  assert.deepEqual(e.totals(), total(0), 'nothing runs before the timer fires');
  const held = gate();
  e.hook('local', 'alpha', () => held.p);
  const firing = Promise.resolve(e.timers[0].fn());
  await flush();
  assert.equal(e.timers.length, 1, 'not re-armed while the tick runs');
  held.open(GOOD.local);
  await firing;
  await flush();
  assert.equal(e.timers.length, 2);
  assert.equal(e.timers[1].ms, 1000);
  assert.equal(e.timers[1].unrefs, 1);
  assert.deepEqual(e.totals(), total(1));
  await e.timers[1].fn();
  await flush();
  assert.equal(e.timers.length, 3);
  assert.equal(e.timers[2].ms, 1000);
});

test('stop clears the pending timer; a tick in flight finishes without re-arming; stop before start is harmless; start works again after stop', async () => {
  const e = setup({ repos: ['alpha'] });
  assert.doesNotThrow(() => e.store.stop());
  e.store.start();
  e.store.stop();
  assert.deepEqual(e.cleared, [e.timers[0]]);

  const f = setup({ repos: ['alpha'] });
  const held = gate();
  f.hook('local', 'alpha', () => held.p);
  f.store.start();
  const firing = Promise.resolve(f.timers[0].fn());
  await flush();
  f.store.stop();
  held.open(GOOD.local);
  await firing;
  await flush();
  assert.equal(f.timers.length, 1, 'no re-arm after stop');
  assert.equal(f.count('local', 'alpha'), 1);
  f.store.start();
  assert.equal(f.timers.length, 2);
});
