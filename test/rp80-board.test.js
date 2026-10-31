'use strict';
// RP80 (S68, S75), design points 1-3: server/summarystore.js keeps a sixth fact (`req`, requirementsFor, slow, not needed by the Summary),
// a revision counter (`rev`, `revOf[id]`, bumped only when a read outcome differs) and store.board(since) -> { rev, repos, refreshing },
// a SYNCHRONOUS answer built from memory that reads nothing. Injected fakes, a fake clock and gates only: no timers, no sleeps, no real git/gh/Orca.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { AsyncLocalStorage } = require('node:async_hooks');

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'rp80b-'));
process.env.REPO_PANEL_CONFIG = path.join(scratch, 'config.json');
process.env.REPO_PANEL_CASES_FILE = 'off';
const { mock } = test;
test.after(() => { mock.restoreAll(); fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 5 }); });

const exec = require('../server/exec.js');
const lib = require('../lib.js');
const { summarize } = require('../server/summary.js');

const lane = new AsyncLocalStorage();
const realWithPriority = exec.withPriority;
mock.method(exec, 'withPriority', (priority, fn) => lane.run(priority, () => realWithPriority(priority, fn)));
const make = (opts) => require('../server/summarystore.js').createSummaryStore({ waitForClient: false, intervals: { fast: 5000 }, ...opts });

const GOOD = {
  local: { branch: 'main', files: [], ahead: 0, behind: 0, base: 'main' },
  prs: { prs: [{ number: 9, title: 'T', ready: true, checks: { state: 'success' } }], stale: null },
  roadmap: { available: false, reason: 'missing' },
  state: { available: false },
  req: { available: true, base: 'main', results: [{ id: 'agents', ok: true }], summary: { ok: 1, total: 1 } },
};
const LAST = { at: '2026-10-28T10:00:00Z', what: 'subject' };
const KINDS = ['local', 'prs', 'roadmap', 'state', 'git', 'req'];
const DEP = { local: 'local', prs: 'prs', roadmap: 'roadmap', state: 'state', git: 'git', req: 'requirements' };
const ORDER = ['local', 'prs', 'roadmap', 'state', 'last', 'req'];
const FIVE = ['local', 'prs', 'roadmap', 'state', 'req']; // `last` cannot fail: a git that cannot say is a null movement
const flush = async () => { for (let i = 0; i < 25; i++) await new Promise((r) => setImmediate(r)); };
const gate = () => { let open; const p = new Promise((r) => { open = r; }); return { p, open }; };
const pathOf = (name) => `/work/${name}`;
const idOf = (name) => lib.repoId(pathOf(name));

function setup({ repos = ['alpha'], ...opts } = {}) {
  const e = { t: 1000000, hooks: {}, lanes: [], calls: Object.fromEntries(KINDS.map((k) => [k, []])), seen: [] };
  e.cfg = { groups: [{ name: 'G', repos: repos.map((n) => ({ path: pathOf(n) })) }], rooms: [], snoozed: [] };
  const reader = (kind) => async (repo, args) => {
    const at = kind === 'git' ? repo : repo.path;
    const n = e.calls[kind].filter((p) => p === at).length + 1;
    e.calls[kind].push(at);
    e.lanes.push(lane.getStore());
    if (kind === 'req') e.seen.push(repo);
    const hook = e.hooks[`${kind}:${at}`];
    if (hook) return hook(n);
    return kind === 'git' ? { code: 0, stdout: `${LAST.at}\n${LAST.what}\n`, stderr: '' } : structuredClone(GOOD[kind]);
  };
  e.deps = Object.fromEntries(KINDS.map((k) => [DEP[k], reader(k)]));
  e.store = make({ deps: e.deps, now: () => e.t, loadCfg: () => e.cfg, setTimer: () => ({ unref() {} }), clearTimer() {}, ...opts });
  e.hook = (kind, name, fn) => { e.hooks[`${kind}:${pathOf(name)}`] = fn; };
  e.count = (kind, name) => e.calls[kind].filter((p) => p === pathOf(name)).length;
  e.totals = () => Object.fromEntries(KINDS.map((k) => [k, e.calls[k].length]));
  e.expected = (name) => summarize({ repo: { id: idOf(name), name, group: 'G', room: null }, ...GOOD, last: LAST, session: 'unknown', snoozed: [], now: e.t });
  e.entry = (name, since = 0) => e.store.board(since).repos[idOf(name)];
  return e;
}
const total = (n) => Object.fromEntries(KINDS.map((k) => [k, n]));
const ids = (names) => names.map(idOf);

// ---------- point 1: the sixth fact ----------
test('req is read by deps.requirements, once per repo and refresh, with the repo object, in the background lane', async () => {
  const e = setup({ repos: ['alpha', 'beta'] });
  await e.store.refreshAll();
  assert.deepEqual(e.calls.req, [pathOf('alpha'), pathOf('beta')]);
  assert.deepEqual(e.totals(), total(2));
  assert.deepEqual(e.seen.map((r) => [r.path, r.id]), [[pathOf('alpha'), idOf('alpha')], [pathOf('beta'), idOf('beta')]]);
  assert.deepEqual([...new Set(e.lanes)], ['background']);
});

test('req is NOT needed: a repo is a real row without it, and the snapshot never carries it (hanging, throwing or answering)', async () => {
  const e = setup();
  const held = gate();
  e.hook('req', 'alpha', () => held.p);
  const refreshing = e.store.refreshRepo(idOf('alpha'));
  await flush();
  assert.equal(e.count('req', 'alpha'), 1);
  assert.deepEqual(e.store.snapshot().rows, [e.expected('alpha')], 'a real row while req is still pending');
  held.open({ marker: 'REQ-SENTINEL' });
  await refreshing;
  const snap = e.store.snapshot();
  assert.deepEqual(snap.rows, [e.expected('alpha')]);
  assert.ok(!JSON.stringify(snap).includes('REQ-SENTINEL'));
  assert.deepEqual(Object.keys(snap), ['rows', 'counts', 'attention', 'generatedAt']);

  const f = setup();
  f.hook('req', 'alpha', () => { throw new Error('req down'); });
  await f.store.refreshAll();
  assert.deepEqual(f.store.snapshot().rows, [f.expected('alpha')], 'a failed req is no stale mark and no error of the row');
});

test('req is SLOW like prs: 60 s active, 300 s idle (the defaults), and it follows prs under custom intervals', async () => {
  const e = setup();
  e.store.touch();
  await e.store.tick();
  for (const [dt, want] of [[59999, 1], [1, 2]]) { e.t += dt; e.store.touch(); await e.store.tick(); assert.deepEqual([e.count('req', 'alpha'), e.count('prs', 'alpha')], [want, want], `+${dt}`); }
  const idle = setup();
  await idle.store.tick();
  for (const [dt, want] of [[299999, 1], [1, 2]]) { idle.t += dt; await idle.store.tick(); assert.deepEqual([idle.count('req', 'alpha'), idle.count('prs', 'alpha')], [want, want], `idle +${dt}`); }

  const c = setup({ intervals: { fast: 1000, slow: 2000, idleFast: 4000, idleSlow: 8000 } });
  c.store.touch();
  await c.store.tick();
  for (const [dt, want] of [[1999, 1], [1, 2]]) { c.t += dt; c.store.touch(); await c.store.tick(); assert.deepEqual([c.count('req', 'alpha'), c.count('prs', 'alpha')], [want, want], `custom +${dt}`); }
});

test('stale and at are reported in the order local, prs, roadmap, state, last, req; a fact is stale only strictly OVER 3 times its interval', async () => {
  const e = setup();
  await e.store.refreshAll();
  const t0 = e.t;
  assert.deepEqual(Object.keys(e.entry('alpha').at), ORDER);
  assert.deepEqual(e.entry('alpha').stale, []);
  e.t = t0 + 15000; // fast: 3 x 5000
  assert.deepEqual(e.entry('alpha').stale, []);
  e.t = t0 + 15001;
  assert.deepEqual(e.entry('alpha').stale, ['local', 'state']);
  e.t = t0 + 180000; // slow: 3 x 60000
  assert.deepEqual(e.entry('alpha').stale, ['local', 'state']);
  e.t = t0 + 180001;
  assert.deepEqual(e.entry('alpha').stale, ORDER);

  const f = setup();
  for (const k of FIVE) f.hook(k, 'alpha', () => { throw new Error(`${k} down`); });
  await f.store.refreshAll();
  assert.deepEqual(f.entry('alpha').stale, FIVE, 'a failed last attempt is stale at once, in the same order');
});

// ---------- point 3: what board() answers ----------
test('a never-read store answers every repo of the config, with no fact: rev 0, empty at, errors and stale, and reads nothing', () => {
  const e = setup({ repos: ['alpha', 'beta', 'gamma'] });
  const out = e.store.board(0);
  assert.deepEqual(out, { rev: 0, repos: Object.fromEntries(['alpha', 'beta', 'gamma'].map((n) => [idOf(n), { rev: 0, at: {}, errors: {}, stale: [] }])), refreshing: [] });
  assert.deepEqual(e.store.board(), out, 'a missing since is 0');
  assert.deepEqual(e.totals(), total(0));
});

test('board() is synchronous and reads nothing, however often it is asked', async () => {
  const e = setup({ repos: ['alpha', 'beta'] });
  await e.store.refreshAll();
  const before = e.totals();
  const out = e.store.board(0);
  assert.equal(typeof out.then, 'undefined', 'not a promise');
  assert.deepEqual(Object.keys(out).sort(), ['refreshing', 'repos', 'rev']);
  for (let i = 0; i < 5; i++) e.store.board(i);
  assert.deepEqual(e.totals(), before);
});

test('a read repo: the five values are exactly what the readers returned, at is the time of the last success, nothing else is added', async () => {
  const e = setup();
  await e.store.refreshAll();
  const entry = e.entry('alpha');
  assert.deepEqual(Object.keys(entry).sort(), ['at', 'errors', 'local', 'prs', 'req', 'rev', 'roadmap', 'stale', 'state']);
  for (const k of FIVE) assert.deepEqual(entry[k], GOOD[k], k);
  assert.deepEqual(entry.at, Object.fromEntries(ORDER.map((k) => [k, e.t])));
  assert.deepEqual(entry.errors, {});
  assert.deepEqual(entry.stale, []);
});

test('a fact that has not answered yet has no key and no at; the others are there', async () => {
  const e = setup();
  const held = gate();
  e.hook('prs', 'alpha', () => held.p);
  const refreshing = e.store.refreshRepo(idOf('alpha'));
  await flush();
  const entry = e.entry('alpha');
  assert.equal('prs' in entry, false);
  assert.equal('prs' in entry.at, false);
  assert.deepEqual(entry.local, GOOD.local);
  assert.deepEqual(Object.keys(entry.at), ['local', 'roadmap', 'state', 'last', 'req']);
  held.open(GOOD.prs);
  await refreshing;
  assert.deepEqual(e.entry('alpha').prs, GOOD.prs);
});

test('a failed fact: with no older value it has no key (message in errors); with one the old value stays with its old at; recovery clears the error', async () => {
  const e = setup({ repos: ['alpha', 'beta', 'gamma'] });
  e.hook('prs', 'alpha', () => { throw new Error('gh down'); });
  e.hook('prs', 'beta', (n) => (n === 1 ? GOOD.prs : { error: 'rate limited' }));
  e.hook('prs', 'gamma', (n) => ({ error: n === 1 ? 'first' : 'second' }));
  await e.store.refreshAll();
  const t0 = e.t;
  assert.equal('prs' in e.entry('alpha'), false);
  assert.deepEqual([e.entry('alpha').errors, e.entry('alpha').stale.includes('prs'), 'prs' in e.entry('alpha').at], [{ prs: 'gh down' }, true, false]);
  assert.deepEqual(e.entry('gamma').errors, { prs: 'first' }, 'a { error } answer is a failure too');
  e.t += 1000;
  await e.store.refreshAll();
  const beta = e.entry('beta');
  assert.deepEqual(beta.prs, GOOD.prs, 'the older good value stays');
  assert.equal(beta.at.prs, t0, 'at is the last SUCCESS, not the last attempt');
  assert.equal(beta.at.local, t0 + 1000);
  assert.deepEqual([beta.errors, beta.stale], [{ prs: 'rate limited' }, ['prs']]);
  assert.deepEqual(e.entry('gamma').errors, { prs: 'second' }, 'the message of the LAST attempt');
  e.hook('prs', 'beta', () => GOOD.prs);
  e.t += 1000;
  await e.store.refreshAll();
  assert.deepEqual([e.entry('beta').errors, e.entry('beta').stale, e.entry('beta').at.prs], [{}, [], e.t]);
});

test('the values are copies: changing what board() returned changes neither the next answer, the snapshot nor the store', async () => {
  const e = setup();
  await e.store.refreshAll();
  const a = e.store.board(0).repos[idOf('alpha')];
  const b = e.store.board(0).repos[idOf('alpha')];
  for (const k of FIVE) { assert.deepEqual(a[k], b[k]); assert.notEqual(a[k], b[k], `${k} is a fresh copy per answer`); }
  a.local.files.push({ path: 'x' });
  a.local.branch = 'hacked';
  a.prs.prs.length = 0;
  a.req.results.push('junk');
  a.at.local = 0;
  a.stale.push('local');
  const c = e.entry('alpha');
  for (const k of FIVE) assert.deepEqual(c[k], GOOD[k], k);
  assert.deepEqual([c.at.local, c.stale], [e.t, []]);
  assert.deepEqual(e.store.snapshot().rows, [e.expected('alpha')]);
});

test('board() touches the store: it is active, not idle (a store that was not started does not kick)', async () => {
  const active = setup({ idleAfterMs: 120000 });
  active.store.board(0);
  await active.store.tick();
  active.t += 60000;
  await active.store.tick();
  assert.equal(active.count('prs', 'alpha'), 2, 'touched at t0: the slow facts are due at 60 s');
  const idle = setup({ idleAfterMs: 120000 });
  await idle.store.tick();
  idle.t += 60000;
  await idle.store.tick();
  assert.equal(idle.count('prs', 'alpha'), 1, 'control: never touched, idle: the slow facts wait for 300 s');

  const e = setup({ waitForClient: true, setTimer: () => ({ unref() {} }) });
  e.store.board(0);
  await flush();
  assert.deepEqual(e.totals(), total(0), 'a store that was not started does not kick');
});

test('a started store that nobody had asked: the first board() kicks a tick without waiting for the beat; later ones do not re-read', async () => {
  const e = setup({ waitForClient: true, setTimer: () => ({ unref() {} }) });
  e.store.start();
  assert.deepEqual(e.totals(), total(0));
  e.store.board(0);
  await flush();
  assert.deepEqual(e.totals(), total(1));
  e.store.board(0);
  await flush();
  assert.deepEqual(e.totals(), total(1));
  e.store.stop();
});

test('refreshing lists the repos with a read cycle in flight now, and is empty before and after', async () => {
  const e = setup({ repos: ['alpha', 'beta', 'gamma'] });
  assert.deepEqual(e.store.board(0).refreshing, []);
  const a = gate();
  const b = gate();
  e.hook('prs', 'alpha', () => a.p);
  e.hook('prs', 'gamma', () => b.p);
  const all = e.store.refreshAll();
  await flush();
  assert.deepEqual([...e.store.board(0).refreshing].sort(), ids(['alpha', 'gamma']).sort());
  a.open(GOOD.prs);
  await flush();
  assert.deepEqual(e.store.board(0).refreshing, ids(['gamma']));
  b.open(GOOD.prs);
  await all;
  assert.deepEqual(e.store.board(0).refreshing, []);
});

// ---------- point 2: the revision counter ----------
test('rev counts the facts that changed: 6 per repo on the first read, in pool order; revOf is the last bump of the repo', async () => {
  const e = setup({ repos: ['alpha', 'beta', 'gamma'], pool: 1 });
  assert.equal(e.store.board(0).rev, 0);
  await e.store.refreshAll();
  const out = e.store.board(0);
  assert.equal(out.rev, 18);
  assert.deepEqual(Object.fromEntries(Object.entries(out.repos).map(([id, r]) => [id, r.rev])), { [idOf('alpha')]: 6, [idOf('beta')]: 12, [idOf('gamma')]: 18 });
});

test('an identical read changes nothing: rev, revOf and the since polls stay put (only at moves)', async () => {
  const e = setup({ repos: ['alpha', 'beta', 'gamma'], pool: 1 });
  await e.store.refreshAll();
  e.t += 5000;
  await e.store.refreshAll();
  assert.deepEqual(e.totals(), total(6));
  const out = e.store.board(0);
  assert.equal(out.rev, 18);
  assert.deepEqual(Object.values(out.repos).map((r) => r.rev), [6, 12, 18]);
  assert.deepEqual(e.store.board(18), { rev: 18, repos: {}, refreshing: [] });
  assert.equal(out.repos[idOf('alpha')].at.local, e.t, 'the answer still carries the newer success time');
});

test('a changed value bumps rev by one and only its repo; a failure, a repeated failure, a new message and a recovery are each judged', async () => {
  const e = setup({ repos: ['alpha', 'beta', 'gamma'], pool: 1 });
  await e.store.refreshAll();
  e.hook('local', 'beta', (n) => (n === 1 ? GOOD.local : { ...GOOD.local, branch: 'dev' }));
  await e.store.refreshAll();
  const revs = () => Object.values(e.store.board(0).repos).map((r) => r.rev);
  assert.deepEqual([e.store.board(0).rev, revs()], [19, [6, 19, 18]]);

  const f = setup();
  const outcomes = [GOOD.prs, () => { throw new Error('boom'); }, () => { throw new Error('boom'); }, () => { throw new Error('bang'); }, GOOD.prs];
  f.hook('prs', 'alpha', (n) => (typeof outcomes[n - 1] === 'function' ? outcomes[n - 1]() : structuredClone(outcomes[n - 1])));
  const seen = [];
  for (let i = 0; i < 5; i++) { await f.store.refreshAll(); seen.push([f.store.board(0).rev, f.entry('alpha').rev]); }
  assert.deepEqual(seen, [[6, 6], [7, 7], [7, 7], [8, 8], [9, 9]], 'ok, failed, same failure, other message, same value again but not failed');
});

test('a failed fact whose message and old value are the same does not bump, and an { error } answer counts as a failure', async () => {
  const e = setup();
  e.hook('roadmap', 'alpha', (n) => (n === 1 ? GOOD.roadmap : { error: 'no roadmap' }));
  await e.store.refreshAll();
  await e.store.refreshAll();
  const rev = e.store.board(0).rev;
  assert.equal(rev, 7);
  await e.store.refreshAll();
  assert.equal(e.store.board(0).rev, rev);
});

test('since: rev itself and above answer no repo, below answers the repos bumped after it, 0 and a missing value answer all', async () => {
  const e = setup({ repos: ['alpha', 'beta', 'gamma'], pool: 1 });
  await e.store.refreshAll(); // alpha 6, beta 12, gamma 18
  const only = (since) => Object.keys(e.store.board(since).repos);
  assert.deepEqual(only(18), []);
  assert.deepEqual(only(19), []);
  assert.deepEqual(only(1000), []);
  assert.deepEqual(only(17), ids(['gamma']));
  assert.deepEqual(only(12), ids(['gamma']));
  assert.deepEqual(only(11), ids(['beta', 'gamma']));
  assert.deepEqual(only(6), ids(['beta', 'gamma']));
  assert.deepEqual(only(5), ids(['alpha', 'beta', 'gamma']));
  assert.deepEqual(only(0), ids(['alpha', 'beta', 'gamma']));
  assert.deepEqual(only(), ids(['alpha', 'beta', 'gamma']));
  assert.equal(e.store.board(1000).rev, 18, 'rev is the current one whatever the since');
});

test('a since that is not a finite non-negative integer is treated as 0', async () => {
  const e = setup({ repos: ['alpha', 'beta'], pool: 1 });
  await e.store.refreshAll();
  const all = ids(['alpha', 'beta']);
  for (const bad of [-1, 1.5, NaN, Infinity, -Infinity, '3', '12', null, undefined, {}, [], 'x', true]) {
    assert.deepEqual(Object.keys(e.store.board(bad).repos), all, String(bad));
  }
});

test('a repo removed from the config is not answered (even for since 0) and is forgotten: back it is never-read, and reading it bumps again', async () => {
  const e = setup({ repos: ['alpha', 'beta', 'gamma'], pool: 1 });
  await e.store.refreshAll();
  const full = e.cfg.groups[0].repos;
  e.cfg = { ...e.cfg, groups: [{ name: 'G', repos: full.filter((r) => r.path !== pathOf('beta')) }] };
  assert.deepEqual(Object.keys(e.store.board(0).repos), ids(['alpha', 'gamma']));
  assert.deepEqual(Object.keys(e.store.board(11).repos), ids(['gamma']));
  e.cfg = { ...e.cfg, groups: [{ name: 'G', repos: full }] };
  assert.deepEqual(e.entry('beta'), { rev: 0, at: {}, errors: {}, stale: [] });
  assert.deepEqual(e.store.board(0).refreshing, []);
  await e.store.refreshAll();
  assert.equal(e.store.board(0).rev, 24, 'only the forgotten repo changed: 6 facts');
  assert.equal(e.entry('beta').rev, 24);
  assert.deepEqual([e.entry('alpha').rev, e.entry('gamma').rev], [6, 18]);
});

// ---------- verification finding W3: a forced refresh that arrives while one is running joins it ----------
test('W3 refreshAll while a forced sweep is running joins it: one read per fact, not one sweep per click; the next sweep starts after it ends', async () => {
  const e = setup({ repos: ['alpha', 'beta'] });
  const held = gate();
  e.hook('local', 'alpha', async () => { await held.p; return structuredClone(GOOD.local); });
  const first = e.store.refreshAll();
  await flush();
  const second = e.store.refreshAll();
  const third = e.store.refreshAll();
  await flush();
  held.open();
  await Promise.all([first, second, third]);
  assert.equal(e.count('local', 'alpha'), 1, 'three clicks, one read');
  assert.equal(e.count('local', 'beta'), 1);
  e.hook('local', 'alpha', null);
  await e.store.refreshAll();
  assert.equal(e.count('local', 'alpha'), 2, 'once the sweep ended a new click reads again');
});

test('W3 a forced sweep that fails still frees the next one', async () => {
  const e = setup({ repos: ['alpha'] });
  e.hook('local', 'alpha', async () => { throw new Error('boom'); });
  await e.store.refreshAll();
  await e.store.refreshAll();
  assert.equal(e.count('local', 'alpha'), 2);
});
