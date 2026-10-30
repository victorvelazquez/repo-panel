'use strict';
// RP76 (S68): the process queue of server/exec.js has two lanes. A job started inside withPriority('user', ...) goes before every
// waiting background job and may use up to URGENT_EXTRA processes over MAX_PARALLEL; background jobs keep their FIFO order.
// withContext(ctx, fn) collects ctx.procs and ctx.waitMs of every run() inside it; singleFlight shares one in-flight call per key.
// Only quick local child processes (process.execPath -e) run here: no git, no gh, no Orca.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

process.env.REPO_PANEL_MAX_PARALLEL = '2';
const EXEC_PATH = path.join(__dirname, '..', 'server', 'exec.js');
const exec = require(EXEC_PATH);

const node = process.execPath;
const sleepArgs = (ms) => ['-e', `setTimeout(() => {}, ${ms})`];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const IDLE = { active: 0, waitingBackground: 0, waitingUser: 0, max: 2 };

// Starts one run of `ms` milliseconds in the given lane with its own context.
function job(priority, ms, opts) {
  const ctx = { procs: 0, waitMs: 0 };
  const p = exec.withContext(ctx, () => exec.withPriority(priority, () => exec.run(node, sleepArgs(ms), opts)));
  return { ctx, p };
}

test('exec exports withPriority, withContext, singleFlight, URGENT_EXTRA and stats', () => {
  assert.equal(typeof exec.withPriority, 'function');
  assert.equal(typeof exec.withContext, 'function');
  assert.equal(typeof exec.singleFlight, 'function');
  assert.equal(exec.URGENT_EXTRA, 2);
  assert.deepEqual(exec.stats(), IDLE);
});

test('MAX_PARALLEL comes from REPO_PANEL_MAX_PARALLEL; absent or invalid values fall back to 8', () => {
  const maxIn = (value) => {
    const env = { ...process.env };
    delete env.REPO_PANEL_MAX_PARALLEL;
    if (value !== undefined) env.REPO_PANEL_MAX_PARALLEL = value;
    const r = spawnSync(node, ['-e', 'console.log(JSON.stringify(require(process.argv[1]).stats()))', EXEC_PATH], { env, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    return JSON.parse(r.stdout).max;
  };
  assert.equal(maxIn(undefined), 8);
  assert.equal(maxIn('abc'), 8);
  assert.equal(maxIn('0'), 8);
  assert.equal(maxIn('-3'), 8);
  assert.equal(maxIn('3'), 3);
});

test('a user job starts at once while the slots are busy; waiting background jobs start only after a slot frees', async () => {
  const busy = [job('background', 400), job('background', 400)];
  const waiting = [1, 2, 3, 4].map(() => job('background', 400));
  await sleep(40);
  // The user job awaits before it runs: the lane must survive the await.
  const ctx = { procs: 0, waitMs: 0 };
  const user = exec.withContext(ctx, () => exec.withPriority('user', async () => { await sleep(5); return exec.run(node, sleepArgs(200)); }));
  await sleep(60);
  const during = exec.stats();
  assert.equal(during.active, 3, 'two background plus the urgent one');
  assert.equal(during.waitingBackground, 4, 'no waiting background job started');
  assert.equal(during.waitingUser, 0);
  assert.equal((await user).code, 0);
  await Promise.all([...busy, ...waiting].map((j) => j.p));
  assert.ok(ctx.waitMs < 150, `the user job waited ${ctx.waitMs} ms`);
  for (const w of waiting) assert.ok(w.ctx.waitMs >= 250, `a background job waited only ${w.ctx.waitMs} ms`);
  assert.deepEqual(exec.stats(), IDLE);
});

test('among waiting jobs the user ones go first (FIFO inside each class)', async () => {
  // Fill the 2 slots and the 2 urgent places with jobs that end at different times, then queue five jobs of 120 ms.
  const holders = [job('background', 200), job('background', 400), job('user', 600), job('user', 800)];
  await sleep(120);
  assert.equal(exec.stats().active, 4);
  const queued = ['bg1', 'bg2', 'user1', 'bg3', 'user2'].map((name) => ({ name, ...job(name.startsWith('user') ? 'user' : 'background', 120) }));
  assert.deepEqual({ ...exec.stats(), active: 4 }, { active: 4, max: 2, waitingBackground: 3, waitingUser: 2 });
  await Promise.all([...holders, ...queued].map((j) => j.p));
  const startOrder = queued.slice().sort((a, b) => a.ctx.waitMs - b.ctx.waitMs).map((j) => j.name);
  assert.deepEqual(startOrder, ['user1', 'user2', 'bg1', 'bg2', 'bg3']);
  assert.deepEqual(exec.stats(), IDLE);
});

test('the urgent allowance is bounded: a fifth process never starts', async () => {
  const bg = [job('background', 300), job('background', 300)];
  const urgent = [1, 2, 3, 4, 5].map(() => job('user', 300));
  await sleep(60);
  assert.deepEqual(exec.stats(), { active: 2 + exec.URGENT_EXTRA, max: 2, waitingBackground: 0, waitingUser: 3 });
  await Promise.all([...bg, ...urgent].map((j) => j.p));
  assert.deepEqual(exec.stats(), IDLE);
});

test('a burst of 10 urgent and 10 background jobs never has more than MAX_PARALLEL + URGENT_EXTRA children alive', async () => {
  let peak = 0;
  const poll = setInterval(() => { peak = Math.max(peak, exec.stats().active); }, 3);
  const all = [];
  for (let i = 0; i < 10; i++) { all.push(job('user', 60).p); all.push(job('background', 60).p); }
  const results = await Promise.all(all);
  clearInterval(poll);
  assert.ok(results.every((r) => r.code === 0));
  assert.ok(peak <= 2 + exec.URGENT_EXTRA, `peak ${peak}`);
  assert.ok(peak > 2, `the urgent lane never used its extra places (peak ${peak})`);
  assert.deepEqual(exec.stats(), IDLE);
});

test('nothing leaks: failing commands, a missing program and a timeout release their slot and resolve with a non-zero code', async () => {
  const bad = (args) => exec.run(node, args);
  const settled = await Promise.all([
    bad(['-e', 'process.exit(1)']), bad(['-e', 'process.exit(1)']), bad(['-e', 'process.exit(1)']),
    exec.run('rp76-no-such-program', []), exec.run('rp76-no-such-program', []),
    exec.withPriority('user', () => exec.run(node, sleepArgs(5000), { timeout: 150 })),
  ]);
  assert.deepEqual(settled.slice(0, 3).map((r) => r.code), [1, 1, 1]);
  assert.ok(settled[3].code !== 0 && settled[4].code !== 0);
  assert.ok(settled[5].code !== 0, 'the timeout kills the child');
  assert.deepEqual(exec.stats(), IDLE);
});

test('run() resolves with { code, stdout, stderr } as before, also with an exit code', async () => {
  assert.deepEqual(await exec.run(node, ['-e', "console.log('out'); console.error('err')"]), { code: 0, stdout: 'out\n', stderr: 'err\n' });
  assert.deepEqual(await exec.run(node, ['-e', "process.stdout.write('x'); process.exit(3)"]), { code: 3, stdout: 'x', stderr: '' });
});

test('the timeout option still works', async () => {
  const t0 = Date.now();
  const r = await exec.run(node, sleepArgs(5000), { timeout: 200 });
  assert.ok(r.code !== 0);
  assert.equal(r.stdout, '');
  assert.ok(Date.now() - t0 < 3000);
});

test('withContext counts the processes and the wait for a slot of every run() inside it', async () => {
  const ctx = { procs: 0, waitMs: 0 };
  await exec.withContext(ctx, async () => { await exec.run(node, ['-e', '0']); await exec.run(node, ['-e', '0']); });
  assert.equal(ctx.procs, 2);
  assert.ok(ctx.waitMs >= 0 && ctx.waitMs < 50, `free slots should not wait: ${ctx.waitMs}`);
  // Outside any context run() still works.
  assert.equal((await exec.run(node, ['-e', '0'])).code, 0);
});

test('withContext: a job behind a busy slot reports the wait; two contexts at once do not mix', async () => {
  const holders = [job('background', 400), job('background', 400)];
  await sleep(40);
  const a = { procs: 0, waitMs: 0 };
  const b = { procs: 0, waitMs: 0 };
  const queued = exec.withContext(a, () => exec.run(node, ['-e', '0']));
  const other = exec.withContext(b, async () => { await exec.run(node, ['-e', '0']); await exec.run(node, ['-e', '0']); });
  await Promise.all([queued, other, ...holders.map((h) => h.p)]);
  assert.equal(a.procs, 1);
  assert.equal(b.procs, 2);
  assert.ok(a.waitMs >= 300, `waited ${a.waitMs} ms`);
  assert.ok(b.waitMs >= 300, `waited ${b.waitMs} ms`);
  assert.deepEqual(exec.stats(), IDLE);
});

test('singleFlight: calls with the same key in flight share ONE promise; the key is freed after it settles', async () => {
  const map = new Map();
  let calls = 0;
  let release;
  const fn = () => { calls++; return new Promise((r) => { release = r; }); };
  const p1 = exec.singleFlight(map, 'k', fn);
  const p2 = exec.singleFlight(map, 'k', fn);
  assert.equal(p1, p2);
  assert.equal(calls, 1);
  const other = exec.singleFlight(map, 'other', () => Promise.resolve('o'));
  assert.notEqual(other, p1);
  assert.equal(await other, 'o');
  release('done');
  assert.equal(await p1, 'done');
  assert.equal(map.size, 0, 'the key is removed after it resolved');
  const p3 = exec.singleFlight(map, 'k', () => { calls++; return Promise.resolve('again'); });
  assert.notEqual(p3, p1);
  assert.equal(await p3, 'again');
  assert.equal(calls, 2);
});

test('singleFlight: a rejection reaches every waiter, frees the key and does not poison the next call', async () => {
  const map = new Map();
  let calls = 0;
  const failing = () => { calls++; return Promise.reject(new Error('boom')); };
  const p1 = exec.singleFlight(map, 'k', failing);
  const p2 = exec.singleFlight(map, 'k', failing);
  assert.equal(calls, 1);
  await assert.rejects(p1, /boom/);
  await assert.rejects(p2, /boom/);
  assert.equal(map.size, 0);
  assert.equal(await exec.singleFlight(map, 'k', async () => 'fine'), 'fine');
  assert.equal(map.size, 0);
});
