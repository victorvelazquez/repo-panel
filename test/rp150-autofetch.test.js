'use strict';
// RP150: the server fetches from the remote on its own. server/fetcher.js runs ONE `git fetch` per repo at a time (an automatic call joins what is
// in flight; a manual one, with --prune, waits for an automatic one and runs after it), at most 2 automatic fetches at once across repos, with no
// --prune, a 30 s timeout and no prompts; it skips (no process, no failure) a repo with no remote or with a git lock taken. The store runs it as a
// `fetch` kind (1 min hot, 5 min the others, doubling after failures up to 15 min), detached from the repo cycle, and re-reads the roadmap after it.
// Real git on real repos in temp directories (a local bare repo is the origin, no network); a recording `git` is injected only to count processes.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const net = require('node:net');
const { AsyncLocalStorage } = require('node:async_hooks');

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'rp150-'));
process.env.REPO_PANEL_CONFIG = path.join(scratch, 'config.json');
const { mock } = test;
test.after(() => {
  mock.restoreAll();
  try { fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch { /* an EBUSY on Windows must not fail a test */ }
});

const exec = require('../server/exec.js');
const lib = require('../lib.js');
const { sh } = require('./git-helper.js');
const { createSummaryStore } = require('../server/summarystore.js');
const { roadmapState } = require('../server/roadmap.js');
const fetcher = () => require('../server/fetcher.js'); // lazy: a missing module fails each test, not the whole file

const lane = new AsyncLocalStorage();
const realWithPriority = exec.withPriority;
mock.method(exec, 'withPriority', (priority, fn) => lane.run(priority, () => realWithPriority(priority, fn)));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const flush = async () => { for (let i = 0; i < 25; i++) await new Promise((r) => setImmediate(r)); };
const gate = () => { let open; const p = new Promise((r) => { open = r; }); return { p, open }; };
async function until(cond, ms = 8000) {
  const t0 = Date.now();
  while (!cond()) { if (Date.now() - t0 > ms) throw new Error('until: timed out'); await sleep(10); }
}
let n = 0;
const tmp = (name) => { const d = path.join(scratch, `${name}${++n}`); fs.mkdirSync(d, { recursive: true }); return d; };

const ROADMAP = (state) => `# Roadmap\n\n| ID | Entrega | Resultado visible | Depende de | Estado | Notas | Ficha |\n|---|---|---|---|---|---|---|\n| A1 | x | y | — | ${state} | n | |\n`;

// A bare origin with `main` (a roadmap and two files) and a seed clone to push new commits from.
function origin() {
  const root = tmp('o');
  const bare = path.join(root, 'origin.git');
  const seed = path.join(root, 'seed');
  sh(root, 'init', '-q', '--bare', '-b', 'main', bare);
  sh(root, 'init', '-q', '-b', 'main', seed);
  sh(seed, 'remote', 'add', 'origin', bare);
  fs.mkdirSync(path.join(seed, 'docs'));
  fs.writeFileSync(path.join(seed, 'docs', 'ROADMAP.md'), ROADMAP('Pendiente'));
  fs.writeFileSync(path.join(seed, 'a.txt'), 'a\n');
  fs.writeFileSync(path.join(seed, 'b.txt'), 'b\n');
  sh(seed, 'add', '-A');
  sh(seed, 'commit', '-q', '-m', 'seed');
  sh(seed, 'push', '-q', 'origin', 'main');
  const o = { root, bare, seed };
  o.push = (text) => {
    fs.writeFileSync(path.join(seed, 'docs', 'ROADMAP.md'), text);
    sh(seed, 'commit', '-q', '-am', 'move');
    sh(seed, 'push', '-q', 'origin', 'main');
    return sh(seed, 'rev-parse', 'HEAD');
  };
  o.clone = () => { const dir = path.join(tmp('c'), 'work'); sh(root, 'clone', '-q', bare, dir); return { id: lib.repoId(dir), path: dir }; };
  return o;
}
// A repo with a remote that is never fetched until the test asks (cheap: no clone).
const bareRepo = (remote) => { const dir = tmp('r'); sh(dir, 'init', '-q', '-b', 'main'); if (remote) sh(dir, 'remote', 'add', 'origin', remote); return { id: lib.repoId(dir), path: dir }; };

// A recording git: it runs the real one and notes every call (args, options, lane), how many fetches ran at once, and in total per repo.
function recorder() {
  const r = { calls: [], pending: [], running: 0, max: 0, perRepo: new Map(), perRepoMax: 0, hold: null, delay: 0, onFetchDone: null };
  r.git = (cwd, args, opts) => {
    r.calls.push({ cwd, args, opts, lane: lane.getStore() });
    const isFetch = args.includes('fetch');
    const p = (async () => {
      if (!isFetch) return exec.git(cwd, args, opts);
      r.running++;
      r.max = Math.max(r.max, r.running);
      const here = (r.perRepo.get(cwd) || 0) + 1;
      r.perRepo.set(cwd, here);
      r.perRepoMax = Math.max(r.perRepoMax, here);
      try {
        if (r.hold) await r.hold;
        if (r.delay) await sleep(r.delay);
        return await exec.git(cwd, args, opts);
      } finally { r.running--; r.perRepo.set(cwd, r.perRepo.get(cwd) - 1); if (r.onFetchDone) r.onFetchDone(); }
    })();
    r.pending.push(p);
    return p;
  };
  r.fetches = () => r.calls.filter((c) => c.args.includes('fetch'));
  r.named = (name) => r.calls.filter((c) => c.args[0] === name);
  r.settle = async () => { let seen; do { seen = r.pending.length; await Promise.allSettled(r.pending); await flush(); } while (r.pending.length !== seen); };
  return r;
}
const deps = (rec) => ({ git: rec.git });
const remoteRef = (repo, ref) => { try { return sh(repo.path, 'rev-parse', '--verify', '-q', ref); } catch { return null; } };

// ---------- the fetcher ----------

test('1. two and twenty simultaneous automatic calls for one repo are ONE fetch process, and the entry is freed afterwards', async () => {
  const { fetchRepo } = fetcher();
  const repo = origin().clone();
  for (const count of [2, 20]) {
    const rec = recorder();
    const g = gate();
    rec.hold = g.p;
    const calls = Array.from({ length: count }, () => fetchRepo(repo, { deps: deps(rec) }));
    await until(() => rec.fetches().length === 1);
    await sleep(50);
    g.open();
    const results = await Promise.all(calls);
    assert.equal(rec.fetches().length, 1, `${count} calls`);
    assert.equal(rec.perRepoMax, 1);
    assert.ok(results.every((x) => x === results[0] && x.code === 0), 'all calls share the one answer');
    await fetchRepo(repo, { deps: deps(rec) });
    assert.equal(rec.fetches().length, 2, 'a later call runs a new fetch: the entry was freed');
  }
});

test('2. a manual call waits for an automatic one and runs its own prune fetch after it; many manual clicks are one extra fetch; never two at once', async () => {
  const { fetchRepo } = fetcher();
  const repo = origin().clone();
  const rec = recorder();
  const g = gate();
  rec.hold = g.p;
  const auto = fetchRepo(repo, { deps: deps(rec) });
  await until(() => rec.fetches().length === 1);
  const manual = Array.from({ length: 10 }, () => fetchRepo(repo, { prune: true, lane: 'user', deps: deps(rec) }));
  await sleep(100);
  assert.equal(rec.fetches().length, 1, 'the manual fetch waits: it did not start while the automatic one is in flight');
  g.open();
  const results = await Promise.all([auto, ...manual]);
  assert.equal(rec.fetches().length, 2, 'one automatic and ONE manual for ten clicks');
  assert.ok(!rec.fetches()[0].args.includes('--prune'));
  assert.deepEqual(rec.fetches()[1].args, ['fetch', '--prune', '--quiet']);
  assert.equal(rec.perRepoMax, 1, 'never two fetches of one repo at once');
  assert.ok(manual.every((_, i) => results[i + 1] === results[1]), 'the ten clicks share one answer');
});

test('2b. ten manual calls with nothing in flight are ONE fetch; an automatic call during a manual one joins it', async () => {
  const { fetchRepo } = fetcher();
  const repo = origin().clone();
  const rec = recorder();
  const g = gate();
  rec.hold = g.p;
  const calls = Array.from({ length: 10 }, () => fetchRepo(repo, { prune: true, lane: 'user', deps: deps(rec) }));
  await until(() => rec.fetches().length === 1);
  const auto = fetchRepo(repo, { deps: deps(rec) });
  await sleep(50);
  g.open();
  await Promise.all([...calls, auto]);
  assert.equal(rec.fetches().length, 1);
  assert.deepEqual(rec.fetches()[0].args, ['fetch', '--prune', '--quiet']);
  assert.equal(rec.perRepoMax, 1);
});

test('3. a repo without a remote: no fetch process, { skipped: "no-remote" }', async () => {
  const { fetchRepo } = fetcher();
  const repo = bareRepo(null);
  const rec = recorder();
  assert.deepEqual(await fetchRepo(repo, { deps: deps(rec) }), { skipped: 'no-remote' });
  assert.equal(rec.fetches().length, 0);
});

test('5. a taken index.lock skips the round (no fetch) and a removed one lets the next fetch run; a linked worktree has its own lock', async () => {
  const { fetchRepo } = fetcher();
  const repo = origin().clone();
  const rec = recorder();
  const lock = path.join(repo.path, '.git', 'index.lock');
  fs.writeFileSync(lock, '');
  assert.deepEqual(await fetchRepo(repo, { deps: deps(rec) }), { skipped: 'locked' });
  assert.equal(rec.fetches().length, 0);
  // The worktree has its own index: the lock of the main one does not skip it, and its own lock does.
  sh(repo.path, 'worktree', 'add', '-q', '-b', 'wtb', path.join(path.dirname(repo.path), 'wt'));
  const wt = { id: 'wt', path: path.join(path.dirname(repo.path), 'wt') };
  assert.equal((await fetchRepo(wt, { deps: deps(rec) })).code, 0, 'the lock of the main worktree does not block the linked one');
  assert.equal(rec.fetches().length, 1);
  fs.rmSync(lock);
  const wtGit = path.resolve(wt.path, sh(wt.path, 'rev-parse', '--git-dir'));
  assert.notEqual(path.resolve(wtGit), path.resolve(repo.path, '.git'), 'precondition: the worktree has its own git dir');
  fs.writeFileSync(path.join(wtGit, 'index.lock'), '');
  assert.deepEqual(await fetchRepo(wt, { deps: deps(rec) }), { skipped: 'locked' });
  assert.equal((await fetchRepo(repo, { deps: deps(rec) })).code, 0, 'the main repo is free again');
  assert.equal(rec.fetches().length, 2);
});

test('6. twelve repos at once: never more than 2 automatic fetches in flight, and every repo is fetched once', async () => {
  const { fetchRepo } = fetcher();
  const o = origin();
  const repos = Array.from({ length: 12 }, () => bareRepo(o.bare));
  const rec = recorder();
  const g = gate();
  rec.hold = g.p;
  const all = repos.map((repo) => fetchRepo(repo, { deps: deps(rec) }));
  await until(() => rec.fetches().length === 2);
  await sleep(200);
  assert.equal(rec.fetches().length, 2, 'the others wait for a place');
  assert.equal(rec.running, 2);
  g.open();
  const results = await Promise.all(all);
  assert.ok(results.every((x) => x.code === 0));
  assert.equal(rec.fetches().length, 12);
  assert.equal(rec.max, 2, 'two ran together, never three');
  assert.equal(rec.calls.length, 48, 'four processes per repo: the git dir key, remote, the lock path and the fetch');
});

test('8. a branch deleted on the remote keeps its remote-tracking ref after an automatic fetch and loses it to the manual one', async () => {
  const { fetchRepo } = fetcher();
  const o = origin();
  sh(o.seed, 'push', '-q', 'origin', 'main:refs/heads/gone');
  const repo = o.clone();
  assert.ok(remoteRef(repo, 'refs/remotes/origin/gone'), 'precondition');
  sh(o.seed, 'push', '-q', 'origin', '--delete', 'gone');
  assert.equal((await fetchRepo(repo)).code, 0);
  assert.ok(remoteRef(repo, 'refs/remotes/origin/gone'), 'the automatic fetch deletes nothing');
  assert.equal((await fetchRepo(repo, { prune: true, lane: 'user' })).code, 0);
  assert.equal(remoteRef(repo, 'refs/remotes/origin/gone'), null, 'the manual one prunes it');
});

test('9. a fetch that never ends is cut at its own limit and freed; git is asked for a 30 s timeout; the next call runs', async () => {
  const { fetchRepo } = fetcher();
  const repo = origin().clone();
  const timers = [];
  const fake = { setTimer: (fn, ms) => { const t = { fn, ms, cleared: false, unref() {} }; timers.push(t); return t; }, clearTimer: (t) => { t.cleared = true; } };
  const seen = [];
  const hang = (cwd, args, opts) => { if (args.includes('fetch')) { seen.push(opts); return new Promise(() => {}); } return exec.git(cwd, args, opts); };
  const first = fetchRepo(repo, { deps: { git: hang, ...fake } });
  const joined = fetchRepo(repo, { deps: { git: hang, ...fake } });
  await until(() => timers.length === 1);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].timeout, 30000);
  assert.ok(timers[0].ms > 30000 && timers[0].ms <= 40000, 'the guard sits just after the process timeout');
  timers[0].fn();
  await assert.rejects(first, /timed out/);
  await assert.rejects(joined, /timed out/);
  const rec = recorder();
  assert.equal((await fetchRepo(repo, { deps: deps(rec) })).code, 0, 'the in-flight entry was freed');
  assert.equal(rec.fetches().length, 1);
});

test('10. the automatic fetch has gc.auto=0, maintenance.auto=false, no --prune, no prompts, 30 s and the background lane; the manual one is exactly as before', async () => {
  const { fetchRepo } = fetcher();
  const repo = origin().clone();
  const rec = recorder();
  await fetchRepo(repo, { deps: deps(rec) });
  await fetchRepo(repo, { prune: true, lane: 'user', deps: deps(rec) });
  const [auto, manual] = rec.fetches();
  assert.deepEqual(auto.args, ['-c', 'gc.auto=0', '-c', 'maintenance.auto=false', 'fetch', '--no-prune', '--quiet']);
  assert.ok(!auto.args.includes('--prune'));
  assert.deepEqual(auto.opts.env, { GCM_INTERACTIVE: 'never', GIT_TERMINAL_PROMPT: '0' });
  assert.equal(auto.opts.timeout, 30000);
  assert.equal(auto.lane, 'background');
  assert.deepEqual(manual.args, ['fetch', '--prune', '--quiet']);
  assert.equal(manual.opts, undefined, 'the manual fetch passes no options: the base env and the default timeout');
  assert.equal(manual.lane, 'user');
});

// ---------- exec ----------

test('12. run() merges an optional env over the base env and changes nothing without it', async () => {
  process.env.RP150_BASE = 'keep';
  try {
    const probe = ['-e', 'process.stdout.write(JSON.stringify([process.env.RP150_X || null, process.env.GIT_TERMINAL_PROMPT, process.env.RP150_BASE]))'];
    const out = async (opts) => JSON.parse((await exec.run(process.execPath, probe, opts)).stdout);
    assert.deepEqual(await out(undefined), [null, '0', 'keep']);
    assert.deepEqual(await out({}), [null, '0', 'keep']);
    assert.deepEqual(await out({ env: { RP150_X: '1' } }), ['1', '0', 'keep']);
    assert.deepEqual(await out({ env: { GIT_TERMINAL_PROMPT: '1' } }), [null, '1', 'keep'], 'the given env wins over the defaults of run()');
  } finally { delete process.env.RP150_BASE; }
});

// ---------- the store ----------

const STUB = {
  local: { branch: 'main', detached: false, files: [], ahead: 0, behind: 0, base: 'main' },
  prs: { prs: [], stale: null },
  state: { available: false },
  requirements: { available: true, base: 'main', results: [], summary: { ok: 0, total: 0 } },
};
const HOT = {
  local: { ...STUB.local, branch: 'feat' },
  prs: { prs: [{ number: 3, title: 'T', head: 'feat', ready: true, checks: { state: 'success' } }], stale: null },
};

function storeOf(repos, { rec = recorder(), stubs = {}, hot = false, waitForClient = false, ...opts } = {}) {
  const e = { t: 9000000, rec, repos };
  e.t0 = e.t;
  const cfg = { groups: [{ name: 'G', repos: repos.map((r) => ({ path: r.path })) }], rooms: [], snoozed: [] };
  const base = { local: async () => structuredClone(hot ? HOT.local : STUB.local), prs: async () => structuredClone(hot ? HOT.prs : STUB.prs), state: async () => STUB.state, requirements: async () => STUB.requirements };
  e.store = createSummaryStore({ waitForClient, deps: { git: rec.git, ...base, ...stubs }, now: () => e.t, loadCfg: () => cfg, setTimer: () => ({ unref() {} }), clearTimer() {}, ...opts });
  // A client active at `ms` after the start: touch, one beat of the loop, and wait for the detached fetch to finish.
  e.at = async (ms) => { e.t = e.t0 + ms; e.store.touch(); await e.store.tick(); await rec.settle(); };
  return e;
}

test('3b. a repo with no remote is a skipped round: no fetch process, no backoff (it is asked again at the normal interval)', async () => {
  const repo = bareRepo(null);
  const e = storeOf([repo]);
  await e.at(0);
  assert.equal(e.rec.named('remote').length, 1);
  for (const [ms, want] of [[299999, 1], [300000, 2], [599999, 2], [600000, 3]]) { await e.at(ms); assert.equal(e.rec.named('remote').length, want, `+${ms}`); }
  assert.equal(e.rec.fetches().length, 0);
});

test('4. a broken remote: the fetch fails quietly, the interval doubles up to 15 min, a success resets it, and nothing reaches the Summary or the board', async () => {
  const o = origin();
  const repo = o.clone();
  sh(repo.path, 'remote', 'set-url', 'origin', path.join(o.root, 'does-not-exist.git'));
  const e = storeOf([repo], { hot: true });
  const count = () => e.rec.fetches().length;
  await e.at(0);
  assert.equal(count(), 1);
  // hot: 60 s base; after 1, 2, 3 and 4 failures the wait is 120, 240, 480 s and then the 900 s cap.
  const rounds = [[119999, 1], [120000, 2], [359999, 2], [360000, 3], [839999, 3], [840000, 4], [1739999, 4], [1740000, 5], [2639999, 5]];
  for (const [ms, want] of rounds) { await e.at(ms); assert.equal(count(), want, `+${ms}`); }
  const row = e.store.snapshot().rows[0];
  assert.equal(row.stale, undefined, 'a failed fetch is no stale mark');
  assert.ok(!row.error);
  const entry = e.store.board(0).repos[repo.id];
  assert.deepEqual(entry.stale, []);
  assert.ok(!('fetch' in entry.errors) && !('fetch' in entry.at) && !('fetch' in entry));
  sh(repo.path, 'remote', 'set-url', 'origin', o.bare);
  await e.at(2640000);
  assert.equal(count(), 6, 'the capped round runs and succeeds');
  for (const [ms, want] of [[2699999, 6], [2700000, 7]]) { await e.at(ms); assert.equal(count(), want, `reset +${ms}`); }
});

test('4b. a fetch that throws never throws out of the loop and backs off the same way', async () => {
  const repo = bareRepo(null);
  let calls = 0;
  const e = storeOf([repo], { hot: true, stubs: { fetch: async () => { calls++; throw new Error('boom'); } } });
  await e.at(0);
  for (const [ms, want] of [[119999, 1], [120000, 2], [359999, 2], [360000, 3]]) { await e.at(ms); assert.equal(calls, want, `+${ms}`); }
  assert.equal(e.store.snapshot().rows[0].stale, undefined);
});

test('4c. a fetch outcome (ok, failed) never moves the board revision: the page has nothing new to hear', async () => {
  const repo = bareRepo(null);
  let answer = async () => ({ skipped: 'no-remote' });
  const e = storeOf([repo], { stubs: { fetch: () => answer() } });
  await e.at(0);
  const rev = e.store.board(0).rev;
  assert.ok(rev > 0, 'precondition: the first reads moved it');
  answer = async () => { throw new Error('down'); };
  await e.at(300000);
  answer = async () => ({ code: 0 });
  await e.at(900000);
  assert.equal(e.store.board(0).rev, rev);
});

test('5b. a locked repo is a skipped round, not a failure: the next round (normal interval) fetches once the lock is gone', async () => {
  const repo = origin().clone();
  const lock = path.join(repo.path, '.git', 'index.lock');
  fs.writeFileSync(lock, '');
  const e = storeOf([repo]);
  await e.at(0);
  assert.equal(e.rec.fetches().length, 0);
  fs.rmSync(lock);
  await e.at(299999);
  assert.equal(e.rec.fetches().length, 0);
  await e.at(300000);
  assert.equal(e.rec.fetches().length, 1, 'a failure would have doubled the wait to 600 s');
});

test('7. a push to the remote moves origin/<base> and the roadmap is re-read AFTER the fetch, while the local branch, HEAD, index and working tree stay byte for byte', async () => {
  const o = origin();
  const repo = o.clone();
  const log = [];
  const rec = recorder();
  rec.onFetchDone = () => log.push('fetch');
  const e = storeOf([repo], { rec, stubs: { roadmap: async (r) => { log.push('roadmap'); return roadmapState(r); } } });
  await e.at(0);
  const first = e.store.board(0).repos[repo.id].roadmap;
  assert.equal(first.available, true);
  // The person's work in progress: a modified file, a staged one and an untracked one.
  fs.writeFileSync(path.join(repo.path, 'a.txt'), 'edited\n');
  fs.writeFileSync(path.join(repo.path, 'b.txt'), 'staged\n');
  sh(repo.path, 'add', 'b.txt');
  fs.writeFileSync(path.join(repo.path, 'u.txt'), 'untracked\n');
  const local = () => ({
    head: sh(repo.path, 'rev-parse', 'HEAD'), branch: sh(repo.path, 'rev-parse', 'main'), status: sh(repo.path, 'status', '--porcelain'),
    index: fs.readFileSync(path.join(repo.path, '.git', 'index')).toString('hex'),
    files: ['a.txt', 'b.txt', 'u.txt', 'docs/ROADMAP.md'].map((f) => fs.readFileSync(path.join(repo.path, f), 'utf8')),
  });
  const before = local();
  const moved = o.push(ROADMAP('Completada'));
  assert.notEqual(remoteRef(repo, 'origin/main'), moved, 'precondition: the clone does not know the new commit');
  log.length = 0;
  await e.at(300000);
  assert.equal(remoteRef(repo, 'origin/main'), moved, 'origin/main moved');
  assert.deepEqual(local(), before, 'nothing of the person\'s work moved');
  await e.at(300000); // the next beat of the loop
  const after = e.store.board(0).repos[repo.id].roadmap;
  assert.equal(after.sha, moved, 'the roadmap fact carries the new base commit');
  assert.ok(log.indexOf('fetch') !== -1 && log.lastIndexOf('roadmap') > log.indexOf('fetch'), `a roadmap read came after the fetch: ${log}`);
  assert.deepEqual(local(), before);
});

test('11. a hot repo is fetched every 60 s, the others every 300 s; a quiet client (idle mode) gets 300 s for both', async () => {
  const o = origin();
  const [hot, cold] = [o.clone(), o.clone()];
  const e = storeOf([hot, cold], { stubs: { local: async (r) => structuredClone(r.path === hot.path ? HOT.local : STUB.local), prs: async (r) => structuredClone(r.path === hot.path ? HOT.prs : STUB.prs) } });
  const of = (r) => e.rec.fetches().filter((c) => c.cwd === r.path).length;
  await e.at(0);
  const rounds = [[59999, 1, 1], [60000, 2, 1], [119999, 2, 1], [120000, 3, 1], [179999, 3, 1], [180000, 4, 1], [239999, 4, 1], [240000, 5, 1], [299999, 5, 1], [300000, 6, 2]];
  for (const [ms, h, c] of rounds) {
    await e.at(ms);
    assert.deepEqual([of(hot), of(cold)], [h, c], `+${ms}`);
  }
  // No client touches from here on: after 60 s of silence the store is idle and the hot repo waits 300 s too.
  for (const [dt, h, c] of [[299999, 6, 2], [300000, 7, 3]]) {
    e.t = e.t0 + 300000 + dt;
    await e.store.tick();
    await e.rec.settle();
    assert.deepEqual([of(hot), of(cold)], [h, c], `idle +${dt}`);
  }
});

test('11b. a store that waits for a client fetches nothing until a page asks', async () => {
  const repo = origin().clone();
  const e = storeOf([repo], { waitForClient: true });
  await e.store.tick();
  await e.rec.settle();
  assert.equal(e.rec.calls.length, 0, 'no client, no process of any kind');
  await e.at(0);
  assert.equal(e.rec.fetches().length, 1);
});

test('11c. a slow fetch does not hold the other reads of its repo, and forcing a refresh does not fetch', async () => {
  const repo = origin().clone();
  const rec = recorder();
  const g = gate();
  rec.hold = g.p;
  let reads = 0;
  const e = storeOf([repo], { rec, stubs: { local: async () => { reads++; return STUB.local; } } });
  const beat = async (ms) => { e.t = e.t0 + ms; e.store.touch(); await e.store.tick(); };
  await beat(0);
  await until(() => rec.fetches().length === 1);
  await beat(15000);
  assert.equal(reads, 2, 'local was read again while the fetch is still in flight');
  assert.equal(rec.fetches().length, 1, 'and the fetch in flight is not started twice');
  g.open();
  await rec.settle();
  await e.store.refreshRepo(repo.id);
  await e.store.refreshAll();
  await rec.settle();
  assert.equal(reads, 4, 'both forced reads read the repo');
  assert.equal(rec.fetches().length, 1, 'but neither fetched');
});

// ---------- independent verification: D1-D4 and the surviving mutations ----------

test('D1. the automatic fetch never prunes, even with fetch.prune or remote.origin.prune set; the manual one still does', async () => {
  const { fetchRepo } = fetcher();
  for (const key of ['fetch.prune', 'remote.origin.prune']) {
    const o = origin();
    sh(o.seed, 'push', '-q', 'origin', 'main:refs/heads/gone');
    const repo = o.clone();
    sh(repo.path, 'config', key, 'true');
    sh(o.seed, 'push', '-q', 'origin', '--delete', 'gone');
    assert.equal((await fetchRepo(repo)).code, 0);
    assert.ok(remoteRef(repo, 'refs/remotes/origin/gone'), `${key}: the automatic fetch deleted a ref`);
    assert.equal((await fetchRepo(repo, { prune: true, lane: 'user' })).code, 0);
    assert.equal(remoteRef(repo, 'refs/remotes/origin/gone'), null, `${key}: the manual one prunes`);
  }
});

// A git whose fetches wait for a gate per repo and kind; it records the order they started and how many ran at once per repo.
function gated() {
  const g = { started: [], running: new Map(), perRepoMax: 0, gates: new Map() };
  g.gate = (cwd, kind) => { const k = `${cwd}|${kind}`; if (!g.gates.has(k)) g.gates.set(k, gate()); return g.gates.get(k); };
  g.done = []; // the probes (every git call that is not a fetch) that have ANSWERED, as `<repo>|<first two words>`: what tells that a call reached the queue for a place
  g.probed = (r) => g.done.includes(`${path.basename(path.dirname(r.path))}|rev-parse --git-path`);
  g.git = async (cwd, args, opts) => {
    if (!args.includes('fetch')) { const answer = await exec.git(cwd, args, opts); g.done.push(`${path.basename(path.dirname(cwd))}|${args.slice(0, 2).join(' ')}`); return answer; }
    const kind = args.includes('--prune') ? 'manual' : 'auto';
    g.started.push(`${path.basename(path.dirname(cwd))}|${kind}`);
    const here = (g.running.get(cwd) || 0) + 1;
    g.running.set(cwd, here);
    g.perRepoMax = Math.max(g.perRepoMax, here);
    try { await g.gate(cwd, kind).p; return await exec.git(cwd, args, opts); } finally { g.running.set(cwd, g.running.get(cwd) - 1); }
  };
  return g;
}

test('D2. a manual click does not wait for automatic fetches that have not started; a queued automatic one joins the manual fetch instead of running its own', async () => {
  const { fetchRepo } = fetcher();
  const o = origin();
  const repos = Array.from({ length: 4 }, () => o.clone());
  const names = repos.map((r) => path.basename(path.dirname(r.path)));
  const g = gated();
  const d = { git: g.git };
  const autos = repos.map((r) => fetchRepo(r, { deps: d }));
  const results = [];
  try {
    await until(() => g.started.length === 2);
    await sleep(100);
    // Which two got the places depends on whose probes answered first: the rest of the test does not assume it.
    const running = repos.filter((r, i) => g.started.includes(`${names[i]}|auto`));
    const queued = repos.filter((r) => !running.includes(r));
    assert.equal(running.length, 2, 'the semaphore is full: the other two are queued');
    const [other, target] = queued;
    const targetName = names[repos.indexOf(target)];
    const manual = fetchRepo(target, { prune: true, lane: 'user', deps: d });
    await until(() => g.started.length === 3);
    assert.equal(g.started[2], `${targetName}|manual`, 'the manual fetch started at once, behind nobody');
    g.gate(running[0].path, 'auto').open();
    await until(() => g.started.length === 4);
    assert.equal(g.started[3], `${names[repos.indexOf(other)]}|auto`);
    for (const r of [other, running[1]]) g.gate(r.path, 'auto').open();
    await sleep(150);
    assert.equal(g.started.length, 4, 'the queued automatic fetch of the clicked repo started nothing: it joined the manual one');
    g.gate(target.path, 'manual').open();
    results.push(...await Promise.all([manual, ...autos]));
    assert.equal(results[1 + repos.indexOf(target)], results[0], 'the queued automatic call of the clicked repo got the manual answer');
  } finally {
    // A failed run must not leave its places of the shared semaphore taken for the tests that follow.
    for (const r of repos) for (const kind of ['auto', 'manual']) g.gate(r.path, kind).open();
  }
  assert.ok(results.every((x) => x.code === 0));
  assert.equal(g.perRepoMax, 1);
  // The place it gave back is free again.
  const rec = recorder();
  assert.equal((await fetchRepo(repos[0], { deps: deps(rec) })).code, 0);
});

test('D2b. an automatic call that joins a manual fetch gives its place back at once: the next one in the queue starts while the manual fetch is still running', async () => {
  const { fetchRepo } = fetcher();
  const o = origin();
  const [a, b, t, c] = Array.from({ length: 4 }, () => o.clone());
  const g = gated();
  const d = { git: g.git };
  const name = (r) => path.basename(path.dirname(r.path));
  try {
    // Staggered by WAITING FOR EACH STEP (never by a fixed pause: a slow runner needs more than 100 ms per git call), so the queue order is a, b | t, c.
    const calls = [fetchRepo(a, { deps: d })];
    await until(() => g.started.length === 1); // a holds a place
    calls.push(fetchRepo(b, { deps: d }));
    await until(() => g.started.length === 2); // b holds the other: the semaphore is full
    calls.push(fetchRepo(t, { deps: d }));
    await until(() => g.probed(t)); // t finished its probes: it is queued for a place
    calls.push(fetchRepo(c, { deps: d }));
    await until(() => g.probed(c));
    assert.deepEqual(g.started, [`${name(a)}|auto`, `${name(b)}|auto`]);
    calls.push(fetchRepo(t, { prune: true, lane: 'user', deps: d }));
    await until(() => g.started.length === 3);
    g.gate(a.path, 'auto').open();
    await until(() => g.started.length === 4);
    assert.equal(g.started[3], `${name(c)}|auto`, 'c took the place t gave back, with the manual fetch of t still in flight');
    assert.equal(g.running.get(t.path), 1, 'only the manual fetch of t runs');
    for (const r of [b, c]) g.gate(r.path, 'auto').open();
    g.gate(t.path, 'manual').open();
    assert.ok((await Promise.all(calls)).every((x) => x.code === 0));
  } finally {
    for (const r of [a, b, t, c]) for (const kind of ['auto', 'manual']) g.gate(r.path, kind).open();
  }
  assert.equal(g.perRepoMax, 1);
});

test('D3. a forced cycle never fetches: refreshAll, refreshRepo and catchUp make no fetch, before or after the first natural round', async () => {
  const repo = origin().clone();
  const e = storeOf([repo], { waitForClient: true });
  const count = () => e.rec.fetches().length;
  await e.store.tick();
  await e.store.refreshAll();
  await e.store.refreshRepo(repo.id);
  await e.store.catchUp(repo.id);
  await e.rec.settle();
  assert.equal(count(), 0, 'forced reads at the first look');
  await e.at(0);
  assert.equal(count(), 1, 'the natural round fetches');
  await e.store.refreshAll();
  await e.store.refreshRepo(repo.id);
  await e.store.catchUp(repo.id);
  await e.rec.settle();
  assert.equal(count(), 1);
});

test('D4. a main clone and its linked worktree share refs: fetched together they never overlap and neither fails', async () => {
  const { fetchRepo } = fetcher();
  for (const [mainPrune, wtPrune] of [[false, false], [false, true], [true, false], [true, true]]) {
    const main = origin().clone();
    const wtPath = path.join(path.dirname(main.path), 'wt');
    sh(main.path, 'worktree', 'add', '-q', '-b', 'wtb', wtPath);
    const wt = { id: 'wt', path: wtPath };
    const rec = recorder();
    rec.delay = 250;
    const results = await Promise.all([
      fetchRepo(main, { prune: mainPrune, lane: mainPrune ? 'user' : 'background', deps: deps(rec) }),
      fetchRepo(wt, { prune: wtPrune, lane: wtPrune ? 'user' : 'background', deps: deps(rec) }),
    ]);
    assert.equal(rec.max, 1, `prune ${mainPrune}/${wtPrune}: two fetch processes of one repository at once`);
    assert.ok(results.every((r) => r.code === 0), JSON.stringify(results));
  }
});

test('D4b. the same repository reached through two spellings of its path (a junction or a link here, an 8.3 short name on a Windows runner) is ONE key: never two fetch processes at once', async () => {
  const { fetchRepo } = fetcher();
  const main = origin().clone();
  const link = path.join(path.dirname(main.path), 'via-link');
  fs.symlinkSync(main.path, link, 'junction'); // a junction on Windows (no administrator needed), a plain directory link elsewhere
  for (const [firstPrune, secondPrune] of [[false, false], [false, true], [true, true]]) {
    const rec = recorder();
    rec.delay = 250;
    const results = await Promise.all([
      fetchRepo(main, { prune: firstPrune, lane: firstPrune ? 'user' : 'background', deps: deps(rec) }),
      fetchRepo({ id: 'link', path: link }, { prune: secondPrune, lane: secondPrune ? 'user' : 'background', deps: deps(rec) }),
    ]);
    assert.equal(rec.max, 1, `prune ${firstPrune}/${secondPrune}: two fetch processes of one repository at once`);
    assert.ok(results.every((r) => r.code === 0), JSON.stringify(results));
  }
});

test('M17. a semaphore place is given back when git rejects: after two rejections three other repos still fetch', { timeout: 20000 }, async () => {
  const { fetchRepo } = fetcher();
  const o = origin();
  const repos = Array.from({ length: 5 }, () => bareRepo(o.bare));
  const broken = (cwd, args, opts) => (args.includes('fetch') ? Promise.reject(new Error('git vanished')) : exec.git(cwd, args, opts));
  await assert.rejects(fetchRepo(repos[0], { deps: { git: broken } }), /vanished/);
  await assert.rejects(fetchRepo(repos[1], { deps: { git: broken } }), /vanished/);
  const rec = recorder();
  const results = await Promise.all(repos.slice(2).map((r) => fetchRepo(r, { deps: deps(rec) })));
  assert.ok(results.every((r) => r.code === 0));
  assert.equal(rec.fetches().length, 3);
});

// ---------- the route ----------

test('13. POST /api/fetch is unchanged: { ok: true }, a 502 with the first line of stderr, and the unknown-id error', async () => {
  const { createServer } = require('../server/http.js');
  const o = origin();
  sh(o.seed, 'push', '-q', 'origin', 'main:refs/heads/gone');
  const good = o.clone();
  const bad = o.clone();
  const missing = path.join(o.root, 'does-not-exist.git');
  sh(bad.path, 'remote', 'set-url', 'origin', missing);
  fs.writeFileSync(process.env.REPO_PANEL_CONFIG, JSON.stringify({ port: 4311, groups: [{ name: 'G', repos: [{ path: good.path }, { path: bad.path }] }], rooms: [], snoozed: [] }));
  let expected = '';
  try { sh(bad.path, 'fetch', '--prune', '--quiet'); } catch (e) { expected = String(e.cause.stderr).trim().split('\n').find(Boolean); }
  assert.ok(expected, 'precondition: the broken remote fails');
  const port = await new Promise((resolve) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const { port: p } = s.address(); s.close(() => resolve(p)); }); });
  const server = createServer(port, { noSummaryStore: true });
  await new Promise((r) => server.listen(port, '127.0.0.1', r));
  const call = (method, p, token, body) => new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const req = http.request({ host: '127.0.0.1', port, path: p, method, headers: { host: `127.0.0.1:${port}`, ...(token ? { 'x-token': token } : {}), ...(payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {}) } }, (res) => {
      let d = ''; res.on('data', (c) => { d += c; }); res.on('end', () => resolve({ status: res.statusCode, text: d }));
    });
    req.on('error', reject); if (payload) req.write(payload); req.end();
  });
  try {
    const token = /name="?token"? content="([0-9a-f]+)"/.exec((await call('GET', '/')).text)[1];
    const post = (id) => call('POST', '/api/fetch', token, { id });
    sh(o.seed, 'push', '-q', 'origin', '--delete', 'gone');
    assert.ok(remoteRef(good, 'refs/remotes/origin/gone'), 'precondition');
    assert.deepEqual(await post(good.id), { status: 200, text: '{"ok":true}' });
    assert.equal(remoteRef(good, 'refs/remotes/origin/gone'), null, 'the manual route still prunes');
    assert.deepEqual(await post(bad.id), { status: 502, text: JSON.stringify({ error: expected }) });
    assert.deepEqual(await post('nope'), { status: 404, text: '{"error":"Unknown repository"}' });
  } finally { server.close(); server.closeAllConnections(); }
});

// A panel with the given repos in its config; `post(id)` answers { status, text }.
async function serve(repos, fn) {
  const { createServer } = require('../server/http.js');
  fs.writeFileSync(process.env.REPO_PANEL_CONFIG, JSON.stringify({ port: 4311, groups: [{ name: 'G', repos: repos.map((r) => ({ path: r.path })) }], rooms: [], snoozed: [] }));
  const port = await new Promise((resolve) => { const sv = net.createServer().listen(0, '127.0.0.1', () => { const { port: p } = sv.address(); sv.close(() => resolve(p)); }); });
  const server = createServer(port, { noSummaryStore: true });
  await new Promise((r) => server.listen(port, '127.0.0.1', r));
  const call = (method, p, token, body) => new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const req = http.request({ host: '127.0.0.1', port, path: p, method, headers: { host: `127.0.0.1:${port}`, ...(token ? { 'x-token': token } : {}), ...(payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {}) } }, (res) => {
      let d = ''; res.on('data', (c) => { d += c; }); res.on('end', () => resolve({ status: res.statusCode, text: d }));
    });
    req.on('error', reject); if (payload) req.write(payload); req.end();
  });
  try {
    const token = /name="?token"? content="([0-9a-f]+)"/.exec((await call('GET', '/')).text)[1];
    await fn((id) => call('POST', '/api/fetch', token, { id }));
  } finally { server.close(); server.closeAllConnections(); }
}

test('M22. the route runs the manual fetch in the user lane, with --prune', async () => {
  const repo = origin().clone();
  const seen = [];
  const realGit = exec.git;
  const spy = mock.method(exec, 'git', (cwd, args, opts) => { if (args.includes('fetch')) seen.push({ args, lane: lane.getStore() }); return realGit(cwd, args, opts); });
  try { await serve([repo], async (post) => { assert.equal((await post(repo.id)).status, 200); }); } finally { spy.mock.restore(); }
  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0].args, ['fetch', '--prune', '--quiet']);
  assert.equal(seen[0].lane, 'user');
});

test('M28. the route answers 502 "git fetch failed" when git fails and prints nothing', async () => {
  const repo = origin().clone();
  const realGit = exec.git;
  const spy = mock.method(exec, 'git', (cwd, args, opts) => (args.includes('fetch') ? Promise.resolve({ code: 1, stdout: '', stderr: '' }) : realGit(cwd, args, opts)));
  try { await serve([repo], async (post) => { assert.deepEqual(await post(repo.id), { status: 502, text: '{"error":"git fetch failed"}' }); }); } finally { spy.mock.restore(); }
});
