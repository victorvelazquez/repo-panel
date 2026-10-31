'use strict';
// RP80b (S68, S76), design point 1: the store refreshes a HOT repo (its current branch, not detached, has an open PR whose head is that branch,
// judged by V.isHotRepo of public/view.js on the facts held NOW) faster while a client is active: prs every `hotPrs` (15000 ms) and local every
// `hotLocal` (10000 ms). Every other repo and fact keeps today's intervals; idle mode is unchanged; `stale` follows the hot interval.
// Injected readers, a fake clock and no timers: nothing of the real config, Orca, git or gh is used.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'rp80bh-'));
process.env.REPO_PANEL_CONFIG = path.join(scratch, 'config.json');
process.env.REPO_PANEL_CASES_FILE = 'off';
const { mock } = test;
test.after(() => { mock.restoreAll(); fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 5 }); });

const lib = require('../lib.js');
const V = require('../public/view.js');
const { createSummaryStore } = require('../server/summarystore.js');

const KINDS = ['local', 'prs', 'roadmap', 'state', 'git', 'req'];
const DEP = { local: 'local', prs: 'prs', roadmap: 'roadmap', state: 'state', git: 'git', req: 'requirements' };
const LAST = { at: '2026-10-28T10:00:00Z', what: 'subject' };
const PLAIN = {
  local: { branch: 'main', detached: false, files: [], ahead: 0, behind: 0, base: 'main' },
  prs: { prs: [{ number: 9, title: 'T', head: 'other', ready: true, checks: { state: 'success' } }], stale: null },
  roadmap: { available: false, reason: 'missing' },
  state: { available: false },
  req: { available: true, base: 'main', results: [], summary: { ok: 0, total: 0 } },
};
const onFeat = (over = {}) => ({ ...PLAIN.local, branch: 'feat', ...over });
const feat = () => ({ prs: [{ number: 3, title: 'T', head: 'feat', ready: true, checks: { state: 'success' } }], stale: null });
const pathOf = (name) => `/work/${name}`;
const idOf = (name) => lib.repoId(pathOf(name));

function setup({ repos = ['alpha', 'beta'], ...opts } = {}) {
  const e = { t: 5000000, hooks: {}, calls: Object.fromEntries(KINDS.map((k) => [k, []])) };
  e.cfg = { groups: [{ name: 'G', repos: repos.map((n) => ({ path: pathOf(n) })) }], rooms: [], snoozed: [] };
  const reader = (kind) => async (repo) => {
    const at = kind === 'git' ? repo : repo.path;
    const n = e.calls[kind].filter((p) => p === at).length + 1;
    e.calls[kind].push(at);
    const hook = e.hooks[`${kind}:${at}`];
    if (hook) return hook(n);
    return kind === 'git' ? { code: 0, stdout: `${LAST.at}\n${LAST.what}\n`, stderr: '' } : structuredClone(PLAIN[kind]);
  };
  e.deps = Object.fromEntries(KINDS.map((k) => [DEP[k], reader(k)]));
  e.store = createSummaryStore({ waitForClient: false, deps: e.deps, now: () => e.t, loadCfg: () => e.cfg, setTimer: () => ({ unref() {} }), clearTimer() {}, ...opts });
  e.hook = (kind, name, fn) => { e.hooks[`${kind}:${pathOf(name)}`] = fn; };
  e.count = (kind, name) => e.calls[kind].filter((p) => p === pathOf(name)).length;
  e.of = (name) => Object.fromEntries(KINDS.map((k) => [k, e.count(k, name)]));
  e.hot = (name, branch = 'feat') => { e.hook('local', name, () => onFeat({ branch })); e.hook('prs', name, feat); };
  e.t0 = e.t;
  // A client is active at `ms` after the first read: touch, then one beat of the loop.
  e.at = async (ms) => { e.t = e.t0 + ms; e.store.touch(); await e.store.tick(); };
  e.first = async () => { e.store.touch(); await e.store.tick(); };
  return e;
}
const want = (local, prs, state, roadmap = 1, git = 1, req = 1) => ({ local, prs, roadmap, state, git, req });

test('a hot repo reads local every 10000 ms and prs every 15000 ms (active client), exactly at the boundary, the rest at the usual 15 s / 60 s', async () => {
  const e = setup();
  e.hot('alpha');
  await e.first();
  assert.deepEqual(e.of('alpha'), want(1, 1, 1));
  for (const [ms, local, prs, state] of [[9999, 1, 1, 1], [10000, 2, 1, 1], [14999, 2, 1, 1], [15000, 2, 2, 2], [19999, 2, 2, 2], [20000, 3, 2, 2]]) {
    await e.at(ms);
    assert.deepEqual(e.of('alpha'), want(local, prs, state), `alpha +${ms}`);
  }
});

test('a cold repo beside a hot one keeps today\'s intervals: local and state 15000, prs 60000, roadmap, last and req 60000', async () => {
  const e = setup();
  e.hot('alpha');
  await e.first();
  for (const [ms, local, prs, state, slow] of [[9999, 1, 1, 1, 1], [10000, 1, 1, 1, 1], [14999, 1, 1, 1, 1], [15000, 2, 1, 2, 1], [59999, 3, 1, 3, 1], [60000, 3, 2, 3, 2]]) {
    await e.at(ms);
    assert.deepEqual(e.of('beta'), want(local, prs, state, slow, slow, slow), `beta +${ms}`);
  }
});

test('the hot prs interval is 15000 and the cold one 60000, side by side at 14999, 15000, 59999 and 60000', async () => {
  const e = setup();
  e.hot('alpha');
  await e.first();
  for (const [ms, hot, cold] of [[14999, 1, 1], [15000, 2, 1], [29999, 2, 1], [30000, 3, 1], [59999, 4, 1], [60000, 4, 2]]) {
    await e.at(ms);
    assert.deepEqual([e.count('prs', 'alpha'), e.count('prs', 'beta')], [hot, cold], `+${ms}`);
  }
});

test('hot intervals are options: intervals { hotPrs, hotLocal } are merged with the others and nothing else moves', async () => {
  const e = setup({ intervals: { hotPrs: 20000, hotLocal: 5000 } });
  e.hot('alpha');
  await e.first();
  for (const [ms, local, prs] of [[4999, 1, 1], [5000, 2, 1], [19999, 3, 1], [20000, 3, 2]]) {
    await e.at(ms);
    assert.deepEqual([e.count('local', 'alpha'), e.count('prs', 'alpha')], [local, prs], `custom +${ms}`);
  }
  assert.deepEqual(e.of('beta'), want(2, 1, 2), 'the cold repo is unchanged by the hot options');
});

test('a repo becomes hot when its branch gets a PR, and cold again when the PR disappears', async () => {
  const e = setup();
  e.hook('prs', 'alpha', (n) => (n === 2 ? feat() : n === 3 ? { prs: [], stale: null } : structuredClone(PLAIN.prs)));
  e.hook('local', 'alpha', () => onFeat());
  await e.first();
  for (const ms of [15000, 30000, 45000]) await e.at(ms); // cold: local every 15 s, prs not due
  assert.deepEqual([e.count('local', 'alpha'), e.count('prs', 'alpha')], [4, 1]);
  await e.at(60000); // prs read: the PR of `feat` appears
  assert.deepEqual([e.count('local', 'alpha'), e.count('prs', 'alpha')], [5, 2]);
  await e.at(69999);
  assert.equal(e.count('local', 'alpha'), 5);
  await e.at(70000);
  assert.equal(e.count('local', 'alpha'), 6, 'hot: 10000 after the last local');
  await e.at(74999);
  assert.equal(e.count('prs', 'alpha'), 2);
  await e.at(75000); // hot prs read: the PR is gone
  assert.deepEqual([e.count('local', 'alpha'), e.count('prs', 'alpha')], [6, 3]);
  await e.at(80000);
  assert.equal(e.count('local', 'alpha'), 6, 'cold again: 10000 is no longer enough');
  await e.at(84999);
  assert.equal(e.count('local', 'alpha'), 6);
  await e.at(85000);
  assert.equal(e.count('local', 'alpha'), 7, 'cold again: 15000 after the last local');
  await e.at(134999);
  assert.equal(e.count('prs', 'alpha'), 3, 'cold again: prs back to 60000');
  await e.at(135000);
  assert.equal(e.count('prs', 'alpha'), 4);
});

test('not hot: a PR of another branch, a detached head, a branch without PR, a failed or never-read local or prs fact', async () => {
  const cases = {
    other: [() => onFeat({ branch: 'dev' }), feat],
    detached: [() => onFeat({ detached: true }), feat],
    noPr: [() => onFeat(), () => ({ prs: [], stale: null })],
    localDown: [() => { throw new Error('git down'); }, feat],
    prsDown: [() => onFeat(), () => { throw new Error('gh down'); }],
    prsError: [() => onFeat(), () => ({ error: 'gh down' })],
  };
  for (const [name, [local, prs]] of Object.entries(cases)) {
    const e = setup({ repos: ['alpha'] });
    e.hook('local', 'alpha', local);
    e.hook('prs', 'alpha', prs);
    await e.first();
    await e.at(10000);
    assert.equal(e.count('local', 'alpha'), 1, `${name}: local at 10000`);
    await e.at(14999);
    assert.deepEqual([e.count('local', 'alpha'), e.count('prs', 'alpha')], [1, 1], `${name}: +14999`);
  }
  const hot = setup({ repos: ['alpha'] });
  hot.hot('alpha');
  await hot.first();
  await hot.at(10000);
  assert.equal(hot.count('local', 'alpha'), 2, 'control: the same repo with a good local and a matching PR is hot');
});

test('the rule is V.isHotRepo of the page, called with the held local and prs values (never a copy of the rule)', async () => {
  const seen = [];
  const yes = mock.method(V, 'isHotRepo', (arg) => { seen.push(structuredClone(arg)); return true; });
  try {
    const e = setup({ repos: ['alpha'] });
    await e.first();
    await e.at(10000);
    assert.equal(e.count('local', 'alpha'), 2, 'the function says hot, so local is read every 10000 ms');
    assert.ok(seen.length > 0);
    assert.deepEqual(seen.at(-1), { local: PLAIN.local, prs: PLAIN.prs });
  } finally { yes.mock.restore(); }
  const no = mock.method(V, 'isHotRepo', () => false);
  try {
    const e = setup({ repos: ['alpha'] });
    e.hot('alpha');
    await e.first();
    await e.at(10000);
    assert.equal(e.count('local', 'alpha'), 1, 'the function says cold, so the repo is cold whatever its facts');
  } finally { no.mock.restore(); }
});

test('in idle mode a hot repo uses the idle intervals like everyone: 30000 for local, 300000 for prs', async () => {
  const e = setup();
  e.hot('alpha');
  await e.store.tick(); // never touched: idle
  const at = async (ms) => { e.t = e.t0 + ms; await e.store.tick(); };
  for (const [ms, local, prs] of [[10000, 1, 1], [15000, 1, 1], [29999, 1, 1], [30000, 2, 1], [299999, 3, 1], [300000, 3, 2]]) {
    await at(ms);
    assert.deepEqual([e.count('local', 'alpha'), e.count('prs', 'alpha')], [local, prs], `idle +${ms}`);
  }
  assert.deepEqual([e.count('local', 'beta'), e.count('prs', 'beta')], [3, 2], 'the cold repo beside it does the same');
});

test('stale marking of a hot repo uses its hot interval: local after 3 x 10000, prs after 3 x 15000; the cold one keeps 45000 / 180000', async () => {
  const e = setup();
  e.hot('alpha');
  await e.store.refreshAll();
  const stale = (name) => e.store.board(0).repos[idOf(name)].stale;
  for (const [ms, hot, cold] of [[30000, [], []], [30001, ['local'], []], [45000, ['local'], []], [45001, ['local', 'prs', 'state'], ['local', 'state']], [180000, ['local', 'prs', 'state'], ['local', 'state']], [180001, ['local', 'prs', 'roadmap', 'state', 'last', 'req'], ['local', 'prs', 'roadmap', 'state', 'last', 'req']]]) {
    e.t = e.t0 + ms;
    assert.deepEqual([stale('alpha'), stale('beta')], [hot, cold], `+${ms}`);
  }
  const row = (name) => e.store.snapshot().rows.find((r) => r.id === idOf(name));
  e.t = e.t0 + 30001;
  assert.deepEqual(row('alpha').stale, { facts: ['local'] }, 'the Summary row follows the same rule');
  assert.equal(row('beta').stale, undefined);
});
