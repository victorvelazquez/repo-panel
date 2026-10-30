'use strict';
// RP23 parts 1 and 2 (S22): a smarter refresh. Local data every ~10 s, GitHub data about every 20 s for "hot" repos and
// every 60 s for all of them; a "no merged PR" answer is cached for 15 s instead of 60 s. Pure decisions live in view.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const view = require('../public/view.js');

const lf = (text) => text.replace(/\r\n/g, '\n');
const APP = lf(fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8'));

const loc = (branch = 'task') => ({ branch, detached: false, files: [], ahead: 0, behind: 0 });
const pr = (head, over = {}) => ({ number: 1, head, isCrossRepository: false, ...over });

// ---------- constants ----------
test('the intervals are exported constants: local 10 s, hot 20 s, full 60 s', () => {
  assert.equal(view.LOCAL_REFRESH_MS, 10000);
  assert.equal(view.HOT_REFRESH_MS, 20000);
  assert.equal(view.FULL_REFRESH_MS, 60000);
});

// ---------- isHotRepo ----------
test('isHotRepo: a repo is hot when its current branch has an open PR', () => {
  assert.equal(view.isHotRepo({ local: loc('task'), prs: { prs: [pr('task')] }, sent: undefined }), true);
});

test('isHotRepo: a PR of another branch does not make the repo hot', () => {
  assert.equal(view.isHotRepo({ local: loc('task'), prs: { prs: [pr('other')] } }), false);
});

test('isHotRepo: a command of the panel in flight makes it hot', () => {
  assert.equal(view.isHotRepo({ local: loc('task'), prs: { prs: [] }, sent: { cmd: 'flow-pr' } }), true);
});

test('isHotRepo: cold with nothing loaded, an error, a detached HEAD or no PRs', () => {
  assert.equal(view.isHotRepo({}), false);
  assert.equal(view.isHotRepo({ local: { error: 'x' }, prs: { error: 'y' } }), false);
  assert.equal(view.isHotRepo({ local: { ...loc(null), detached: true }, prs: { prs: [pr('task')] } }), false);
  assert.equal(view.isHotRepo({ local: loc('task'), prs: { prs: [] } }), false);
  assert.equal(view.isHotRepo({ local: loc('task'), prs: { prs: undefined } }), false);
});

// ---------- refreshPlan ----------
const plan = (over = {}) => view.refreshPlan({
  now: 100000, ids: ['a'], local: { a: loc() }, prs: { a: { prs: [] } }, sent: {}, last: {}, loading: {}, hidden: false, busy: {},
  ...over,
});

test('refreshPlan: a cold repo gets a local refresh once 10 s passed, not before', () => {
  assert.deepEqual(plan({ last: { a: { local: 100000 - 9999, prs: 100000 - 9999 } } }), []);
  assert.deepEqual(plan({ last: { a: { local: 100000 - 10000, prs: 100000 - 10000 } } }), [{ id: 'a', kind: 'local' }]);
});

test('refreshPlan: a cold repo never gets a GitHub refresh from the plan (the 60 s full refresh does that)', () => {
  assert.deepEqual(plan({ last: { a: { local: 100000 - 10000, prs: 0 } } }), [{ id: 'a', kind: 'local' }]);
});

test('refreshPlan: a hot repo gets local + PRs (kind hot) once its PR data is 20 s old', () => {
  const hot = { prs: { a: { prs: [pr('task')] } } };
  assert.deepEqual(plan({ ...hot, last: { a: { local: 100000 - 5000, prs: 100000 - 19999 } } }), []);
  assert.deepEqual(plan({ ...hot, last: { a: { local: 100000 - 5000, prs: 100000 - 20000 } } }), [{ id: 'a', kind: 'hot' }]);
});

test('refreshPlan: a hot repo whose PR data is recent still gets its 10 s local refresh', () => {
  const hot = { prs: { a: { prs: [pr('task')] } } };
  assert.deepEqual(plan({ ...hot, last: { a: { local: 100000 - 10000, prs: 100000 - 3000 } } }), [{ id: 'a', kind: 'local' }]);
});

test('refreshPlan: a command in flight (S.sent) makes the repo hot', () => {
  // A repo with a command in flight is hot; its session state was asked a moment ago (pistatus), so the 3 s sent poll (RP75) is not due.
  assert.deepEqual(plan({ sent: { a: { cmd: 'flow-commit' } }, last: { a: { local: 99000, prs: 100000 - 20000, pistatus: 99000 } } }), [{ id: 'a', kind: 'hot' }]);
});

test('refreshPlan: nothing while the tab is hidden; a merge in flight pauses ONLY its own repo (RP75)', () => {
  const old = { a: { local: 0, prs: 0 }, b: { local: 0, prs: 0 } };
  assert.deepEqual(plan({ hidden: true, last: old }), []);
  const two = { ids: ['a', 'b'], local: { a: loc(), b: loc() }, prs: { a: { prs: [] }, b: { prs: [] } } };
  assert.deepEqual(plan({ ...two, busy: { 'a:1': true }, last: old }).map((e) => e.id), ['b']);
  assert.deepEqual(plan({ ...two, busy: { 'a:1': 'done' }, last: old }).map((e) => e.id), ['a', 'b']);
  assert.deepEqual(plan({ busy: { 'a:1': true }, last: old }), []);
});

test('refreshPlan: a repo whose previous refresh is still in flight is skipped', () => {
  const old = { a: { local: 0, prs: 0 } };
  assert.deepEqual(plan({ loading: { a: 1 }, last: old }), []);
  assert.deepEqual(plan({ loading: { a: 0 }, last: old }), [{ id: 'a', kind: 'local' }]);
});

test('refreshPlan: a repo with no record yet is due; ids are planned independently', () => {
  const out = view.refreshPlan({
    now: 100000, ids: ['a', 'b', 'c'], local: { a: loc(), b: loc('t'), c: loc() }, prs: { b: { prs: [pr('t')] } }, sent: {},
    last: { a: { local: 99000, prs: 99000 }, c: { local: 0, prs: 0 } }, loading: {}, hidden: false, busy: {},
  });
  assert.deepEqual(out, [{ id: 'b', kind: 'hot' }, { id: 'c', kind: 'local' }]);
});

// ---------- the page uses the plan ----------
const stub = () => new Proxy(function stubElement() {}, {
  get: (t, k) => (k === 'content' ? 'token' : k === 'dataset' ? {} : k === 'classList' ? { add() {}, remove() {}, toggle() {} } : k === Symbol.toPrimitive ? () => '' : stub),
  set: () => true,
  apply: () => stub(),
});

async function loadPage() {
  const calls = [];
  const intervals = [];
  const ctx = vm.createContext({
    console,
    document: new Proxy({}, { get: (t, k) => (k === 'hidden' ? false : stub) }),
    localStorage: { getItem: () => null, setItem() {} },
    location: { hash: '' },
    requestAnimationFrame: () => 0,
    setInterval: (fn, ms) => { intervals.push(ms); return 0; },
    setTimeout: () => 0,
    confirm: () => true,
    fetch: async (url) => { calls.push(url); throw new Error('offline'); },
  });
  ctx.window = ctx;
  ctx.RepoPanelView = view;
  vm.runInContext(APP, ctx);
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
  calls.length = 0;
  return { get: (name) => vm.runInContext(name, ctx), run: (code) => vm.runInContext(code, ctx), calls, intervals };
}

const settle = async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r)); };

test('page: refreshTick local refreshes only /api/local and /api/state of a cold repo (no network)', async () => {
  const page = await loadPage();
  const S = page.get('S');
  S.groups = [{ name: 'g', repos: [{ id: 'abc', name: 'demo', path: 'x' }] }];
  S.local.abc = loc();
  S.prs.abc = { prs: [] };
  page.get('refreshTick')(1_000_000);
  await settle();
  assert.deepEqual(page.calls.sort(), ['/api/local?id=abc', '/api/state?id=abc']);
});

test('page: refreshTick hot refreshes /api/local, /api/prs and /api/state, never roadmap or requirements', async () => {
  const page = await loadPage();
  const S = page.get('S');
  S.groups = [{ name: 'g', repos: [{ id: 'abc', name: 'demo', path: 'x' }] }];
  S.local.abc = loc('task');
  S.prs.abc = { prs: [pr('task')] };
  page.get('refreshTick')(1_000_000);
  await settle();
  assert.deepEqual(page.calls.sort(), ['/api/local?id=abc', '/api/prs?id=abc', '/api/state?id=abc']);
});

test('page: refreshTick records the refresh, so the next tick 1 s later does nothing', async () => {
  const page = await loadPage();
  const S = page.get('S');
  S.groups = [{ name: 'g', repos: [{ id: 'abc', name: 'demo', path: 'x' }] }];
  S.local.abc = loc();
  S.prs.abc = { prs: [] };
  const tick = page.get('refreshTick');
  tick(1_000_000);
  await settle();
  page.calls.length = 0;
  tick(1_001_000);
  await settle();
  assert.deepEqual(page.calls, []);
  tick(1_010_000);
  await settle();
  assert.deepEqual(page.calls.sort(), ['/api/local?id=abc', '/api/state?id=abc']);
});

test('page: refreshTick skips a repo that is still loading', async () => {
  const page = await loadPage();
  const S = page.get('S');
  S.groups = [{ name: 'g', repos: [{ id: 'abc', name: 'demo', path: 'x' }] }];
  S.local.abc = loc();
  S.loading.abc = 1;
  page.get('refreshTick')(1_000_000);
  await settle();
  assert.deepEqual(page.calls, []);
});

test('page: the full refresh keeps its 60 s interval and the local tick runs on its own timer', async () => {
  const page = await loadPage();
  assert.ok(page.intervals.includes(60000), 'full refresh every 60 s');
  assert.ok(page.intervals.some((ms) => ms >= 1000 && ms <= 5000), 'a short tick drives the plan');
  assert.match(APP, /V\.FULL_REFRESH_MS/);
});

test('page: refreshAll records that every repo was refreshed in full (local and PRs)', async () => {
  const page = await loadPage();
  const S = page.get('S');
  S.groups = [{ name: 'g', repos: [{ id: 'abc', name: 'demo', path: 'x' }] }];
  S.local.abc = loc();
  page.run('refreshAll()');
  await settle();
  page.calls.length = 0;
  page.get('refreshTick')(Date.now() + 1000);
  await settle();
  assert.deepEqual(page.calls, [], 'a repo refreshed a second ago needs nothing');
});

// ---------- part 2: the merged PR cache ----------
const GH_PATH = require.resolve('../server/exec.js');
const GITHUB_PATH = require.resolve('../server/github.js');

function loadGithub(ghImpl) {
  const exec = require(GH_PATH);
  const realGh = exec.gh;
  exec.gh = ghImpl;
  delete require.cache[GITHUB_PATH];
  const github = require(GITHUB_PATH);
  return { github, restore: () => { exec.gh = realGh; delete require.cache[GITHUB_PATH]; } };
}

function withClock(fn) {
  const real = Date.now;
  let t = 1_000_000;
  Date.now = () => t;
  const done = (v) => { Date.now = real; return v; };
  return Promise.resolve(fn({ tick: (ms) => { t += ms; } })).then(done, (e) => { Date.now = real; throw e; });
}

const repo = { id: 'r1', path: __dirname };

test('mergedPrFor: constants are 15 s for no PR and 60 s for a found one', () => {
  const { github, restore } = loadGithub(async () => ({ code: 1, stdout: '', stderr: '' }));
  try {
    assert.equal(github.MERGED_TTL_NONE, 15000);
    assert.equal(github.MERGED_TTL_FOUND, 60000);
  } finally { restore(); }
});

test('mergedPrFor: a "no merged PR" answer is cached for less than 15 s and asked again at 15 s', async () => {
  let calls = 0;
  let answer = '[]';
  const { github, restore } = loadGithub(async () => { calls++; return { code: 0, stdout: answer, stderr: '' }; });
  try {
    await withClock(async ({ tick }) => {
      assert.equal(await github.mergedPrFor(repo, 'task'), null);
      assert.equal(calls, 1);
      tick(14999);
      assert.equal(await github.mergedPrFor(repo, 'task'), null);
      assert.equal(calls, 1, 'still cached at 14.999 s');
      answer = JSON.stringify([{ number: 7, url: 'u', isCrossRepository: false }]);
      tick(1);
      const pr = await github.mergedPrFor(repo, 'task');
      assert.equal(calls, 2, 'asked again at 15 s');
      assert.equal(pr.number, 7, 'and the merge shows up');
    });
  } finally { restore(); }
});

test('mergedPrFor: a found merged PR is cached for 60 s (a merged PR does not un-merge)', async () => {
  let calls = 0;
  const found = JSON.stringify([{ number: 7, url: 'u', isCrossRepository: false }]);
  const { github, restore } = loadGithub(async () => { calls++; return { code: 0, stdout: found, stderr: '' }; });
  try {
    await withClock(async ({ tick }) => {
      assert.equal((await github.mergedPrFor(repo, 'task')).number, 7);
      tick(59999);
      assert.equal((await github.mergedPrFor(repo, 'task')).number, 7);
      assert.equal(calls, 1);
      tick(1);
      await github.mergedPrFor(repo, 'task');
      assert.equal(calls, 2);
    });
  } finally { restore(); }
});

test('mergedPrFor: a failed gh call is not cached and answers null', async () => {
  let calls = 0;
  const { github, restore } = loadGithub(async () => { calls++; return { code: 1, stdout: '', stderr: 'boom' }; });
  try {
    await withClock(async () => {
      assert.equal(await github.mergedPrFor(repo, 'task'), null);
      assert.equal(await github.mergedPrFor(repo, 'task'), null);
      assert.equal(calls, 2);
    });
  } finally { restore(); }
});

test('mergedPrFor: a cross-repository merged PR is ignored, as before', async () => {
  const { github, restore } = loadGithub(async () => ({ code: 0, stdout: JSON.stringify([{ number: 3, url: 'u', isCrossRepository: true }]), stderr: '' }));
  try {
    await withClock(async () => { assert.equal(await github.mergedPrFor(repo, 'task'), null); });
  } finally { restore(); }
});

test('prState: does not ask for merged PRs of a branch that has an open PR (the answer could not change anything)', async () => {
  const fs2 = require('node:fs');
  const os = require('node:os');
  const { execFileSync } = require('node:child_process');
  const dir = fs2.mkdtempSync(path.join(os.tmpdir(), 'rp23-'));
  try {
    execFileSync('git', ['init', '-q', '-b', 'main', dir]);
    execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'x']);
    execFileSync('git', ['-C', dir, 'checkout', '-q', '-b', 'task']);
    const seen = [];
    const open = [{ number: 5, title: 't', url: 'u', headRefName: 'task', baseRefName: 'main', headRefOid: 'o', isDraft: false, isCrossRepository: false, mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', reviewDecision: '', statusCheckRollup: [], author: { login: 'x' } }];
    const { github, restore } = loadGithub(async (cwd, args) => {
      seen.push(args.join(' '));
      if (args[0] === 'repo') return { code: 0, stdout: JSON.stringify({ nameWithOwner: 'o/r', url: 'https://github.com/o/r', deleteBranchOnMerge: false }), stderr: '' };
      if (args.includes('--state') && args[args.indexOf('--state') + 1] === 'open') return { code: 0, stdout: JSON.stringify(open), stderr: '' };
      return { code: 0, stdout: '[]', stderr: '' };
    });
    try {
      const out = await github.prState({ id: 'rp23-open', path: dir });
      assert.equal(out.prs.length, 1);
      assert.equal(out.stale, null);
      assert.ok(!seen.some((a) => /--state merged/.test(a)), seen.join(' | '));
      // PRESERVE: with no open PR on the branch the merged lookup still happens and a merge makes the branch stale.
      seen.length = 0;
      const merged = JSON.stringify([{ number: 5, url: 'u', isCrossRepository: false }]);
      const { github: g2, restore: r2 } = loadGithub(async (cwd, args) => {
        seen.push(args.join(' '));
        if (args[0] === 'repo') return { code: 0, stdout: JSON.stringify({ nameWithOwner: 'o/r', url: 'u', deleteBranchOnMerge: false }), stderr: '' };
        if (args[args.indexOf('--state') + 1] === 'open') return { code: 0, stdout: '[]', stderr: '' };
        return { code: 0, stdout: merged, stderr: '' };
      });
      try {
        const out2 = await g2.prState({ id: 'rp23-merged', path: dir });
        assert.equal(out2.stale.via, 'merged');
        assert.ok(seen.some((a) => /--state merged/.test(a)));
      } finally { r2(); }
    } finally { restore(); }
  } finally { fs2.rmSync(dir, { recursive: true, force: true }); }
});
