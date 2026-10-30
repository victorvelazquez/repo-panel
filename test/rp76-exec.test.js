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


// Deterministic holders: a child stays alive until the test opens its gate FILE (no clock decides the order). A held job also has a
// 30 s timeout so a failing test can never leave a child behind. Slot bookkeeping is synchronous: stats() right after a job was started
// already counts it, so no sleep is needed to look at the queue.
const fs = require('node:fs');
const os = require('node:os');
const gateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rp76-gate-'));
const opened = [];
let gateN = 0;
const gate = () => { const g = { file: path.join(gateDir, 'g' + (++gateN)), open() { fs.writeFileSync(g.file, '1'); } }; opened.push(g); return g; };
test.after(() => { for (const g of opened) { try { g.open(); } catch { /* gone */ } } fs.rmSync(gateDir, { recursive: true, force: true }); });
const NL = 'String.fromCharCode(10)';
function held(priority, g, name, log) {
  const script = "const fs = require('fs');" + (log ? "fs.appendFileSync(" + JSON.stringify(log) + ", " + JSON.stringify(name) + " + " + NL + ");" : '')
    + "const t = setInterval(() => { if (fs.existsSync(" + JSON.stringify(g.file) + ")) { clearInterval(t); } }, 10);";
  const ctx = { procs: 0, waitMs: 0 };
  const p = exec.withContext(ctx, () => exec.withPriority(priority, () => exec.run(node, ['-e', script], { timeout: 30000 })));
  return { name, ctx, p };
}
const until = async (fn, what, ms = 15000) => { const t0 = Date.now(); while (!fn()) { if (Date.now() - t0 > ms) throw new Error('timed out waiting for ' + what); await sleep(10); } };
const readLog = (log) => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split(String.fromCharCode(10)).filter(Boolean) : []);

test('a user job starts at once while the slots are busy; waiting background jobs start only after a slot frees', async () => {
  const gBusy = gate();
  const busy = [held('background', gBusy, 'b1'), held('background', gBusy, 'b2')];
  const waitingGate = gate();
  const waiting = [1, 2, 3, 4].map((i) => held('background', waitingGate, 'w' + i));
  assert.deepEqual(exec.stats(), { active: 2, max: 2, waitingBackground: 4, waitingUser: 0 });
  // The user job awaits before it runs: the lane must survive the await.
  const gUser = gate();
  const ctx = { procs: 0, waitMs: 0 };
  const user = exec.withContext(ctx, () => exec.withPriority('user', async () => { await sleep(5); return exec.run(node, ['-e', "const fs = require('fs'); const t = setInterval(() => { if (fs.existsSync(" + JSON.stringify(gUser.file) + ")) clearInterval(t); }, 10);"], { timeout: 30000 }); }));
  await until(() => exec.stats().active === 3, 'the urgent job to take its extra place');
  const during = exec.stats();
  assert.equal(during.active, 3, 'two background plus the urgent one');
  assert.equal(during.waitingBackground, 4, 'no waiting background job started');
  assert.equal(during.waitingUser, 0);
  const releasedAt = Date.now();
  gUser.open();
  assert.equal((await user).code, 0);
  assert.equal(exec.stats().waitingBackground, 4, 'finishing the urgent job does not free a normal place: the cap is still full');
  gBusy.open();
  waitingGate.open();
  await Promise.all([...busy, ...waiting].map((j) => j.p));
  assert.ok(ctx.waitMs < 200, 'the user job waited ' + ctx.waitMs + ' ms');
  for (const w of waiting) assert.ok(w.ctx.waitMs >= Date.now() - releasedAt - 5000 && w.ctx.waitMs > ctx.waitMs, 'a background job waited only ' + w.ctx.waitMs + ' ms');
  assert.deepEqual(exec.stats(), IDLE);
});

test('among waiting jobs the user ones go first (FIFO inside each class)', async () => {
  const log = path.join(gateDir, 'order.log');
  // Fill the 2 normal places and the 2 urgent places, then queue five jobs: their start order is read from a log the jobs write.
  const gH1 = gate(); const gH2 = gate(); const gU1 = gate(); const gU2 = gate();
  const holders = [held('background', gH1, 'H1'), held('background', gH2, 'H2'), held('user', gU1, 'U1'), held('user', gU2, 'U2')];
  const q = { bg1: gate(), bg2: gate(), user1: gate(), bg3: gate(), user2: gate() };
  const queued = ['bg1', 'bg2', 'user1', 'bg3', 'user2'].map((name) => held(name.startsWith('user') ? 'user' : 'background', q[name], name, log));
  assert.deepEqual(exec.stats(), { active: 4, max: 2, waitingBackground: 3, waitingUser: 2 });
  // One place frees at a time and exactly one job takes it: the order of the log is the order of the queue.
  const started = (n) => until(() => readLog(log).length >= n, n + ' queued job(s) to start');
  gH1.open();  await started(1);
  gU1.open();  await started(2);
  gH2.open(); gU2.open();
  q.user1.open(); await started(3);
  q.user2.open(); await started(4);
  q.bg1.open();  await started(5);
  q.bg2.open(); q.bg3.open();
  await Promise.all([...holders, ...queued].map((j) => j.p));
  assert.deepEqual(readLog(log), ['user1', 'user2', 'bg1', 'bg2', 'bg3']);
  assert.deepEqual(exec.stats(), IDLE);
});

test('the urgent allowance is bounded: a fifth process never starts', async () => {
  const gate1 = gate();
  const bg = [held('background', gate1, 'b1'), held('background', gate1, 'b2')];
  const urgent = [1, 2, 3, 4, 5].map((i) => held('user', gate1, 'u' + i));
  assert.deepEqual(exec.stats(), { active: 2 + exec.URGENT_EXTRA, max: 2, waitingBackground: 0, waitingUser: 3 });
  await sleep(150); // nothing can start meanwhile: every place is held by a gated child
  assert.deepEqual(exec.stats(), { active: 2 + exec.URGENT_EXTRA, max: 2, waitingBackground: 0, waitingUser: 3 });
  gate1.open();
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
  const g = gate();
  const holders = [held('background', g, 'h1'), held('background', g, 'h2')];
  const a = { procs: 0, waitMs: 0 };
  const b = { procs: 0, waitMs: 0 };
  const queued = exec.withContext(a, () => exec.run(node, ['-e', '0']));
  const other = exec.withContext(b, async () => { await exec.run(node, ['-e', '0']); await exec.run(node, ['-e', '0']); });
  const heldFor = 250; // the test itself decides how long the places stay busy
  await sleep(heldFor);
  g.open();
  await Promise.all([queued, other, ...holders.map((h) => h.p)]);
  assert.equal(a.procs, 1);
  assert.equal(b.procs, 2);
  assert.ok(a.waitMs >= heldFor - 20, 'waited ' + a.waitMs + ' ms');
  assert.ok(b.waitMs >= heldFor - 20, 'waited ' + b.waitMs + ' ms');
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
