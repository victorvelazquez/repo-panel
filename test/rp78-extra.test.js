'use strict';
// RP78 (S68, S73), the store tests that did not fit test/rp78-store.test.js: what the readers receive, refreshAll, a throwing reader,
// the `intervals` option ({ fast, slow, idleFast, idleSlow }, milliseconds) and the strict visit order of a pool of one. Fakes only.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'rp78x-'));
process.env.REPO_PANEL_CONFIG = path.join(scratch, 'config.json');
process.env.REPO_PANEL_CASES_FILE = 'off';
test.after(() => fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 5 }));

const lib = require('../lib.js');

const KINDS = ['local', 'prs', 'roadmap', 'state', 'git'];
const GOOD = {
  local: { branch: 'main', files: [], ahead: 0, behind: 0, base: 'main' },
  prs: { prs: [], stale: null },
  roadmap: { available: false, reason: 'missing' },
  state: { available: false },
};
const pathOf = (name) => `/work/${name}`;
const nameOf = (p) => p.split('/').pop();

function setup(opts = {}, { repos = ['alpha', 'beta', 'gamma'], fail = () => false } = {}) {
  const e = { t: 1000000, seen: [], order: [], counts: Object.fromEntries(KINDS.map((k) => [k, 0])) };
  const cfg = { groups: [{ name: 'G', repos: repos.map((n) => ({ path: pathOf(n) })) }], rooms: [], snoozed: [] };
  const reader = (kind) => (repo, args) => {
    const at = kind === 'git' ? repo : repo.path;
    e.counts[kind]++;
    e.order.push(nameOf(at));
    if (kind !== 'git') e.seen.push(repo);
    const how = fail(kind);
    if (how === 'sync') throw new Error(`${kind} sync`);
    if (how === 'async') return Promise.reject(new Error(`${kind} async`));
    return Promise.resolve(kind === 'git' ? { code: 0, stdout: '2026-10-28T10:00:00Z\nsubject\n', stderr: '' } : GOOD[kind]);
  };
  const deps = Object.fromEntries(KINDS.map((k) => [k, reader(k)]));
  const make = require('../server/summarystore.js').createSummaryStore;
  e.store = make({ deps, now: () => e.t, loadCfg: () => cfg, setTimer: () => ({ unref() {} }), clearTimer() {}, waitForClient: false, intervals: { fast: 5000 }, ...opts });
  return e;
}

test('deps.local (and the other repo readers) receive the repo object: path and id', async () => {
  const e = setup({}, { repos: ['alpha'] });
  await e.store.refreshAll();
  assert.equal(e.seen.length, 4);
  for (const repo of e.seen) {
    assert.equal(repo.path, pathOf('alpha'));
    assert.equal(repo.id, lib.repoId(pathOf('alpha')));
  }
});

test('refreshAll forces fresh facts of every repo, fresh or not', async () => {
  const e = setup();
  await e.store.tick();
  assert.deepEqual(e.counts, { local: 3, prs: 3, roadmap: 3, state: 3, git: 3 });
  await e.store.refreshAll();
  assert.deepEqual(e.counts, { local: 6, prs: 6, roadmap: 6, state: 6, git: 6 });
});

test('a reader that throws (sync or async) never rejects tick() and never breaks the loop: it is tried again at its interval', async () => {
  for (const how of ['sync', 'async']) {
    const e = setup({}, { fail: (kind) => (kind === 'prs' || kind === 'local' ? how : false) });
    await assert.doesNotReject(e.store.tick());
    assert.deepEqual(e.counts, { local: 3, prs: 3, roadmap: 3, state: 3, git: 3 }, how);
    assert.equal(e.store.snapshot().rows.length, 3);
    e.t += 60000;
    await assert.doesNotReject(e.store.tick());
    // idle (never touched): the failed facts come back at their active interval, the healthy slow ones wait for the idle one
    assert.deepEqual(e.counts, { local: 6, prs: 6, roadmap: 3, state: 6, git: 3 }, how);
  }
});

test('a custom intervals option is honoured: { fast, slow, idleFast, idleSlow } replace the defaults', async () => {
  const e = setup({ intervals: { fast: 1000, slow: 2000, idleFast: 4000, idleSlow: 8000 } }, { repos: ['alpha'] });
  e.store.touch();
  await e.store.tick();
  const step = async (dt) => { e.t += dt; e.store.touch(); await e.store.tick(); return { ...e.counts }; };
  assert.deepEqual(await step(999), { local: 1, prs: 1, roadmap: 1, state: 1, git: 1 });
  assert.deepEqual(await step(1), { local: 2, prs: 1, roadmap: 1, state: 2, git: 1 });
  assert.deepEqual(await step(1000), { local: 3, prs: 2, roadmap: 2, state: 3, git: 2 });

  const idle = setup({ intervals: { fast: 1000, slow: 2000, idleFast: 4000, idleSlow: 8000 } }, { repos: ['alpha'] });
  await idle.store.tick();
  idle.t += 3999;
  await idle.store.tick();
  assert.equal(idle.counts.local, 1);
  idle.t += 1;
  await idle.store.tick();
  assert.equal(idle.counts.local, 2);
  assert.equal(idle.counts.prs, 1);
  idle.t += 3999;
  await idle.store.tick();
  assert.equal(idle.counts.prs, 1);
  idle.t += 1;
  await idle.store.tick();
  assert.equal(idle.counts.prs, 2);
});

test('with pool 1 the repos are visited strictly one after the other, in config order', async () => {
  const e = setup({ pool: 1 }, { repos: ['alpha', 'beta', 'gamma', 'delta'] });
  await e.store.tick();
  const visits = e.order.filter((n, i) => n !== e.order[i - 1]);
  assert.deepEqual(visits, ['alpha', 'beta', 'gamma', 'delta']);
  assert.equal(e.order.length, 20);
  e.order.length = 0;
  await e.store.refreshAll();
  assert.deepEqual(e.order.filter((n, i) => n !== e.order[i - 1]), ['alpha', 'beta', 'gamma', 'delta']);
});

// ---------- found when the whole suite failed: a real server started by another test must stay passive until a page asks ----------
// `server.test.js` and others spawn the real server.js on a config that points at a temp repo; the store used to read Git there at once, and a
// Git process still running in that folder made the cleanup fail (EBUSY). No client, no work: tick() reads nothing until the first snapshot().
test('a store nobody has asked reads nothing on tick(); the first snapshot() makes the next tick read; explicit refreshes always work', async () => {
  const e = setup({ waitForClient: true }, { repos: ['alpha'] });
  await e.store.tick();
  await e.store.tick();
  assert.deepEqual(Object.values(e.counts), [0, 0, 0, 0, 0], 'nobody asked: nothing is read');
  e.store.snapshot(); // a page asks
  await e.store.tick();
  assert.deepEqual(Object.values(e.counts), [1, 1, 1, 1, 1]);
  const f = setup({ waitForClient: true }, { repos: ['alpha'] });
  await f.store.refreshAll();
  assert.deepEqual(Object.values(f.counts), [1, 1, 1, 1, 1], 'refreshAll does not need a prior snapshot');
  const g = setup({ waitForClient: true }, { repos: ['alpha'] });
  await g.store.refreshRepo(lib.repoId(pathOf('alpha')));
  assert.deepEqual(Object.values(g.counts), [1, 1, 1, 1, 1], 'refreshRepo does not either');
});

test('a started store that nobody asked arms its timer but reads nothing; asking starts the work at once', async () => {
  const timers = [];
  const e = setup({ waitForClient: true, setTimer: (fn, ms) => { const t = { fn, ms, unref() {} }; timers.push(t); return t; } }, { repos: ['alpha'] });
  e.store.start();
  assert.equal(timers.length, 1);
  await timers[0].fn();
  assert.deepEqual(Object.values(e.counts), [0, 0, 0, 0, 0]);
  e.store.snapshot();
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(Object.values(e.counts), [1, 1, 1, 1, 1], 'the first snapshot kicks a tick without waiting for the next beat');
  e.store.stop();
});

// ---------- verification findings: defaults, a session that stops being fed, a reader that hangs ----------
test('the default intervals: local and state are due after 15 s, prs, roadmap and last after 60 s (an active store)', async () => {
  const e = setup({ intervals: undefined }, { repos: ['alpha'] });
  e.store.touch();
  await e.store.refreshAll();
  e.t += 14999;
  await e.store.tick();
  assert.equal(e.counts.local, 1, '14999 ms: not due');
  e.t += 1;
  await e.store.tick();
  assert.deepEqual([e.counts.local, e.counts.state, e.counts.prs, e.counts.roadmap, e.counts.git], [2, 2, 1, 1, 1], '15000 ms: only local and state');
  e.t += 45000;
  e.store.touch();
  await e.store.tick();
  assert.deepEqual([e.counts.prs, e.counts.roadmap, e.counts.git], [2, 2, 2], '60000 ms: the slow facts');
});

test('a session state nobody has refreshed for 30000 ms or more is unknown (the warmer stopped, Orca is down); 29999 ms is still believed', async () => {
  const e = setup({}, { repos: ['alpha'] });
  await e.store.refreshAll();
  const id = lib.repoId(pathOf('alpha'));
  e.store.setSession(id, 'asking');
  e.t += 29999;
  assert.equal(e.store.snapshot().rows[0].session.state, 'waiting');
  e.t += 1;
  assert.equal(e.store.snapshot().rows[0].session.state, 'unknown');
  e.store.setSession(id, 'busy');
  assert.equal(e.store.snapshot().rows[0].session.state, 'working', 'a new word makes it fresh again');
});

test('a read that the injected timeout gives up on is a failed fact, keeps the last good value and frees the repo', async () => {
  let hang = false;
  const e = setup({ timeout: (p) => (hang ? Promise.reject(new Error('Read timed out after 90000 ms')) : p) }, { repos: ['alpha'] });
  await e.store.refreshAll();
  hang = true;
  e.t += 100000;
  await e.store.refreshAll();
  const row = e.store.snapshot().rows[0];
  assert.deepEqual([...row.stale.facts].sort(), ['last', 'local', 'prs', 'roadmap', 'state']);
  hang = false;
  e.t += 1;
  await e.store.refreshAll();
  assert.equal('stale' in e.store.snapshot().rows[0], false, 'the repo was freed and recovers');
});
