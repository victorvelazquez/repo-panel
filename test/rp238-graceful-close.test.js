'use strict';
// RP238: an orderly close. Closing a session (or the panel) ends pi's stdin and gives it a grace period (20 s by default, injectable) to save its session file and exit by
// itself; only a pi still alive after it is killed with its tree. A new start of the same repo waits until the previous pi is gone, so two pi never write one session file.
// Fake children only (and the node fixture of RPC1b for a real pipe): no pi is started.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const cp = require('node:child_process');
const { EventEmitter } = require('node:events');

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'rp238-'));
process.env.REPO_PANEL_CONFIG = path.join(scratch, 'config.json');
fs.writeFileSync(process.env.REPO_PANEL_CONFIG, JSON.stringify({ groups: [] }));
test.after(() => fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));

const { createRpcClient, RpcError } = require('../server/rpc.js');
const { createRpcHost } = require('../server/rpchost.js');

const FIXTURE = path.join(__dirname, 'fixtures', 'fake-pi-rpc.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 3000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = fn(); if (v) return v; await sleep(5); }
  throw new Error('timed out waiting');
}

// A world of fake pi children. `log` keeps the order of what happened: spawn (with how many children were alive just before), end of stdin, kill, exit.
// `exitAfterEndMs` null is a pi that never exits by itself; `answers` are the commands the fake answers (the others never get an answer).
// `exitAfterKillMs` 0 is a kill that ends the child at once, a number ends it that much later (taskkill takes a moment), null never reports its exit.
function world({ exitAfterEndMs = 30, exitAfterKillMs = 0, answers = ['get_state', 'get_commands'] } = {}) {
  const log = [];
  const children = [];
  let pid = 5000;
  const alive = () => children.filter((c) => c.alive);
  function child() {
    const c = new EventEmitter();
    c.pid = ++pid;
    c.alive = true;
    c.stdout = new EventEmitter();
    c.writes = [];
    c.die = (code) => { if (!c.alive) return; c.alive = false; log.push(['exit', c.pid]); c.emit('exit', code); c.emit('close', code); };
    c.said = (obj) => c.stdout.emit('data', `${JSON.stringify(obj)}\n`);
    c.stdin = Object.assign(new EventEmitter(), {
      write(s) {
        c.writes.push(s);
        for (const line of s.split('\n').filter(Boolean)) {
          const cmd = JSON.parse(line);
          if (answers.includes(cmd.type)) setImmediate(() => { if (c.alive) c.said({ id: cmd.id, type: 'response', command: cmd.type, success: true, data: cmd.type === 'get_state' ? { isStreaming: false } : {} }); });
        }
        return true;
      },
      end() { log.push(['end', c.pid]); if (exitAfterEndMs !== null) setTimeout(() => c.die(0), exitAfterEndMs); },
    });
    c.kill = () => c.die(null);
    return c;
  }
  // taskkill (win32) and the group kill (others) both end the child at once, like /F and SIGKILL.
  const spawn = (file, args) => {
    if (file === 'taskkill') { const target = Number(args[1]); log.push(['kill', target, args.join(' ')]); const c = children.find((x) => x.pid === target); if (c) killed(c, 1); return new EventEmitter(); }
    const c = child();
    log.push(['spawn', c.pid, alive().length]);
    children.push(c);
    return c;
  };
  const kill = (target, sig) => { log.push(['kill', -target, sig]); const c = children.find((x) => x.pid === -target); if (c) killed(c, null); };
  function killed(c, code) {
    if (exitAfterKillMs === 0) c.die(code);
    else if (exitAfterKillMs !== null) setTimeout(() => c.die(code), exitAfterKillMs);
  }
  const of = (kind) => log.filter((e) => e[0] === kind);
  return { log, children, alive, spawn, kill, of };
}

function client(t, w, over = {}) {
  const exits = [];
  const c = createRpcClient({ command: 'C:\\x\\pi.exe', args: [], cwd: scratch, env: {}, spawn: w.spawn, kill: w.kill, platform: 'win32', graceMs: 1000, onExit: (e) => exits.push(e), ...over });
  t.after(() => c.close());
  return { c, exits };
}
async function ready(t, w, over) {
  const h = client(t, w, over);
  await h.c.start();
  return h;
}

// ---------- the client ----------
test('a: close ends stdin first, waits for pi to exit by itself and never kills it; onExit once, pending requests rejected, close() resolves on the exit', async (t) => {
  const w = world({ exitAfterEndMs: 80 });
  const { c, exits } = await ready(t, w);
  const pid = w.children[0].pid;
  const pending = c.request('abort');
  let gone = false;
  const closing = c.close();
  assert.equal(typeof (closing && closing.then), 'function', 'close() gives a promise');
  closing.then(() => { gone = true; });
  assert.deepEqual(w.log.slice(1), [['end', pid]], 'stdin is ended at once and nothing is killed');
  assert.deepEqual(exits, [{ reason: 'closed' }]);
  assert.equal(c.state(), 'closed');
  await assert.rejects(pending, (e) => e instanceof RpcError);
  await sleep(30);
  assert.equal(gone, false, 'close() waits for the exit');
  await closing;
  assert.deepEqual(w.log.slice(1), [['end', pid], ['exit', pid]]);
  await sleep(150);
  assert.deepEqual(w.of('kill'), [], 'a pi that exited by itself is never killed');
  assert.equal(exits.length, 1);
  await c.close();
  assert.equal(w.of('end').length, 1, 'a second close does not end stdin again');
});

test('a: through a real pipe (the fixture exits when its stdin ends): no taskkill', async (t) => {
  const kills = [];
  let child = null;
  const spawn = (file, args, opts) => {
    if (file === 'taskkill') { kills.push(args); try { child.kill('SIGKILL'); } catch { /* gone */ } return new EventEmitter(); }
    child = cp.spawn(file, args, { ...opts, stdio: ['pipe', 'pipe', 'ignore'] });
    return child;
  };
  const c = createRpcClient({ command: process.execPath, args: [FIXTURE], cwd: os.tmpdir(), env: { ...process.env, FAKE_PI: '1' }, spawn, platform: 'win32', graceMs: 5000 });
  t.after(() => c.close());
  await c.start();
  await c.close();
  assert.deepEqual(kills, []);
  assert.notEqual(child.exitCode === null && child.signalCode === null, true, 'the process exited');
  assert.equal(child.exitCode, 0);
});

test('b: a pi that does not exit within the grace is killed with its tree, exactly once, and only after the grace (win32)', async (t) => {
  const w = world({ exitAfterEndMs: null });
  const { c } = await ready(t, w, { graceMs: 150 });
  const pid = w.children[0].pid;
  const t0 = Date.now();
  const closing = c.close();
  await sleep(70);
  assert.deepEqual(w.of('kill'), [], 'no kill before the grace');
  await closing;
  assert.ok(Date.now() - t0 >= 140, 'close() resolves at the grace limit');
  assert.deepEqual(w.of('kill'), [['kill', pid, `/PID ${pid} /T /F`]]);
  assert.deepEqual(w.log.slice(1).map((e) => e[0]), ['end', 'kill', 'exit']);
  c.close();
  await sleep(200);
  assert.equal(w.of('kill').length, 1, 'killed once');
});

test('b: on POSIX the group is killed after the grace, once', async (t) => {
  const w = world({ exitAfterEndMs: null });
  const { c } = await ready(t, w, { graceMs: 100, platform: 'linux' });
  const pid = w.children[0].pid;
  const closing = c.close();
  await sleep(40);
  assert.deepEqual(w.of('kill'), []);
  await closing;
  assert.deepEqual(w.of('kill'), [['kill', pid, 'SIGKILL']]);
  await sleep(150);
  assert.equal(w.of('kill').length, 1);
});

test('b: a pi that exited by itself is never killed (its PID may already be another process)', async (t) => {
  const w = world();
  const { c, exits } = await ready(t, w, { graceMs: 60 });
  w.children[0].die(0);
  assert.deepEqual(exits, [{ reason: 'exit' }]);
  await c.close();
  await sleep(120);
  assert.deepEqual(w.of('kill'), []);
  assert.equal(exits.length, 1);
});

test('b: a child that says only exit (its stdio still held, no close yet) is never killed either', async (t) => {
  const w = world();
  const { c, exits } = await ready(t, w, { graceMs: 60 });
  const old = w.children[0];
  old.alive = false;
  old.emit('exit', 0);
  assert.deepEqual(exits, [{ reason: 'exit' }]);
  await c.close();
  await sleep(120);
  assert.deepEqual(w.of('kill'), []);
  assert.deepEqual(w.of('end'), [], 'nothing is written to a child that is gone');
});

// ---------- start timeout and errors ----------
test('e: a start that runs out of time ends stdin; a pi that then exits is not killed, one that hangs is killed at the grace; close() resolves when it is gone', async (t) => {
  const clean = world({ exitAfterEndMs: 20, answers: [] });
  const a = client(t, clean, { startTimeoutMs: 40, graceMs: 2000 });
  await assert.rejects(a.c.start(), (e) => e instanceof RpcError && e.message === 'The session did not start in time');
  assert.deepEqual(clean.of('end').length, 1);
  await a.c.close();
  assert.equal(clean.alive().length, 0);
  assert.deepEqual(clean.of('kill'), []);

  const hung = world({ exitAfterEndMs: null, answers: [] });
  const b = client(t, hung, { startTimeoutMs: 40, graceMs: 100 });
  await assert.rejects(b.c.start(), (e) => e instanceof RpcError);
  assert.deepEqual(hung.of('kill'), []);
  await b.c.close();
  assert.equal(hung.alive().length, 0);
  assert.equal(hung.of('kill').length, 1);
});

test('e: a child error ends it the same way: stdin, then the kill at the grace', async (t) => {
  const w = world({ exitAfterEndMs: null, answers: [] });
  const { c, exits } = client(t, w, { graceMs: 80 });
  const started = c.start();
  w.children[0].emit('error', new Error('EPIPE'));
  await assert.rejects(started, (e) => e instanceof RpcError);
  assert.deepEqual(exits, [{ reason: 'error' }]);
  assert.deepEqual(w.log.slice(1).map((e) => e[0]), ['end'], 'stdin first, no kill before the grace');
  await c.close();
  assert.equal(w.alive().length, 0);
  assert.equal(w.of('kill').length, 1);
});

// ---------- the host ----------
const ACTIVE = { id: 'pi', command: 'C:\\x\\pi.exe' };
const repoOf = (id) => ({ id, path: path.join(scratch, id) });
function host(t, w, clientOver = {}, hostOver = {}) {
  const h = createRpcHost({
    resolve: async () => ({ active: ACTIVE }), repoOf, publish() {}, adoptedOf: () => null, adopt() {}, env: {}, commandsMs: 20,
    createClient: (opts) => createRpcClient({ ...opts, spawn: w.spawn, kill: w.kill, platform: 'win32', graceMs: 1000, ...clientOver }),
    ...hostOver,
  });
  t.after(() => h.closeAll());
  return h;
}
const neverTwo = (w) => assert.deepEqual(w.of('spawn').map((e) => e[2]), w.of('spawn').map(() => 0), 'no pi was spawned while another one was alive');

test('c ABUSE: closing a repo and starting it again at once never runs two pi for it: the new one is spawned after the old one exited', async (t) => {
  const w = world({ exitAfterEndMs: 120 });
  const h = host(t, w);
  await h.start('r1');
  const old = w.children[0].pid;
  const t0 = Date.now();
  assert.equal((await h.close('r1')).state, 'closed');
  assert.ok(Date.now() - t0 < 60, 'the close answers at once');
  assert.equal(w.children[0].alive, true, 'the old pi is still closing');
  const again = h.start('r1');
  await sleep(60);
  assert.equal(w.of('spawn').length, 1, 'nothing spawned while the old pi is alive');
  assert.equal(h.stateOf('r1'), 'starting');
  await again;
  assert.equal(w.of('spawn').length, 2);
  const at = (kind, pid) => w.log.findIndex((e) => e[0] === kind && e[1] === pid);
  assert.ok(at('exit', old) < at('spawn', w.children[1].pid), 'the new pi starts after the old one exited');
  neverTwo(w);
  assert.equal(h.stateOf('r1'), 'idle');
});

test('c ABUSE: a pi that hangs on close is killed at the grace before the new one starts; a burst of close and start never overlaps two', async (t) => {
  const w = world({ exitAfterEndMs: null });
  const h = host(t, w, { graceMs: 120 });
  await h.start('r1');
  await h.close('r1');
  const second = h.start('r1');
  await sleep(50);
  assert.equal(w.of('spawn').length, 1);
  await second;
  assert.deepEqual(w.log.map((e) => e[0]), ['spawn', 'end', 'kill', 'exit', 'spawn']);
  await h.close('r1');
  const lost = h.start('r1').catch((e) => e);
  await h.close('r1');
  const third = h.start('r1');
  assert.equal((await lost).status, 409, 'the start closed while it waited fails like any closed start');
  await third;
  neverTwo(w);
  assert.equal(w.alive().length, 1);
});

test('c ABUSE: a start that timed out leaves its pi closing; the next start waits for it', async (t) => {
  const w = world({ exitAfterEndMs: 100, answers: [] });
  const h = host(t, w, { startTimeoutMs: 40 });
  await assert.rejects(h.start('r1'), (e) => e.status === 504);
  const late = h.start('r1');
  await sleep(30);
  assert.equal(w.of('spawn').length, 1, 'the timed-out pi is still closing');
  const c2 = await until(() => w.children[1] && w.children[1].writes.length && w.children[1]);
  const get = JSON.parse(c2.writes[0]);
  c2.said({ id: get.id, type: 'response', command: 'get_state', success: true, data: {} });
  await late;
  neverTwo(w);
});

test('c ABUSE: a live session that ends on its own (a child error) still holds the next start of the repo until its pi is gone', async (t) => {
  const w = world({ exitAfterEndMs: null });
  const h = host(t, w, { graceMs: 120 });
  await h.start('r1');
  w.children[0].emit('error', new Error('EPIPE'));
  await until(() => h.stateOf('r1') === 'closed');
  const again = h.start('r1');
  await sleep(50);
  assert.equal(w.of('spawn').length, 1, 'nothing spawned while the old pi is alive');
  await again;
  assert.deepEqual(w.log.map((e) => e[0]), ['spawn', 'end', 'kill', 'exit', 'spawn']);
  neverTwo(w);
});

test('c: other repos are not held by a repo that is closing', async (t) => {
  const w = world({ exitAfterEndMs: 300 });
  const h = host(t, w);
  await h.start('r1');
  await h.close('r1');
  const t0 = Date.now();
  await h.start('r2');
  assert.ok(Date.now() - t0 < 200);
});

test('d: closeAll waits for every pi in parallel, bounded by the grace; the one that hangs is killed at the limit, the clean one never', async (t) => {
  const w = world({ exitAfterEndMs: 60 });
  const h = host(t, w, { graceMs: 250 });
  await h.start('r1');
  await h.start('r2');
  w.children[1].stdin.end = () => { w.log.push(['end', w.children[1].pid]); }; // r2's pi never exits
  const t0 = Date.now();
  let done = false;
  const all = h.closeAll();
  assert.equal(typeof (all && all.then), 'function');
  all.then(() => { done = true; });
  await sleep(120);
  assert.equal(done, false, 'still waiting for the pi that hangs');
  assert.equal(w.children[0].alive, false, 'the clean pi exited by itself');
  await all;
  const took = Date.now() - t0;
  assert.ok(took >= 240 && took < 1000, `parallel and bounded (${took} ms)`);
  assert.equal(w.alive().length, 0);
  assert.deepEqual(w.of('kill').map((e) => e[1]), [w.children[1].pid]);
});

test('d: closeAll also waits for a session closed just before it', async (t) => {
  const w = world({ exitAfterEndMs: 100 });
  const h = host(t, w);
  await h.start('r1');
  await h.close('r1');
  await h.closeAll();
  assert.equal(w.alive().length, 0);
});

test('N2: after the grace, close() resolves when the killed child is gone, not when taskkill is spawned', async (t) => {
  const w = world({ exitAfterEndMs: null, exitAfterKillMs: 40 });
  const { c } = await ready(t, w, { graceMs: 60, killWaitMs: 1000 });
  const pid = w.children[0].pid;
  await c.close().then(() => w.log.push(['resolved']));
  assert.deepEqual(w.log.slice(1).map((e) => e[0]), ['end', 'kill', 'exit', 'resolved']);
  assert.equal(w.of('exit')[0][1], pid);
});

test('N2: a killed child that never reports its exit does not hang close(): it resolves at the cap', async (t) => {
  const w = world({ exitAfterEndMs: null, exitAfterKillMs: null });
  const { c } = await ready(t, w, { graceMs: 60, killWaitMs: 150 });
  const t0 = Date.now();
  let gone = false;
  const closing = c.close().then(() => { gone = true; });
  await sleep(130);
  assert.equal(w.of('kill').length, 1, 'killed at the grace');
  assert.equal(gone, false, 'still waiting for the exit');
  await closing;
  const took = Date.now() - t0;
  assert.ok(took >= 200 && took < 1000, `grace plus cap (${took} ms)`);
  assert.equal(w.of('kill').length, 1, 'killed once');
});

test('N2 ABUSE: a start queued behind a pi that hangs on close spawns only after taskkill really ended it', async (t) => {
  const w = world({ exitAfterEndMs: null, exitAfterKillMs: 60 });
  const h = host(t, w, { graceMs: 50, killWaitMs: 1000 });
  await h.start('r1');
  await h.close('r1');
  await h.start('r1');
  assert.deepEqual(w.log.map((e) => e[0]), ['spawn', 'end', 'kill', 'exit', 'spawn']);
  neverTwo(w);
});

test('N1 ABUSE: once the panel shuts down, a new start is refused with 503 and spawns nothing; the exit comes with no pi alive', async (t) => {
  const { shutdown } = require('../server/rpchost.js');
  const w = world({ exitAfterEndMs: 80 });
  const h = host(t, w);
  await h.start('r1');
  let exited = 0;
  const p = shutdown(h, () => { exited++; w.log.push(['panel-exit', w.alive().length]); })();
  await sleep(10);
  await assert.rejects(h.start('r1'), (e) => e.status === 503 && e.message === 'The panel is shutting down');
  await assert.rejects(h.start('r2'), (e) => e.status === 503 && e.message === 'The panel is shutting down');
  await assert.rejects(h.start('r2', { fresh: true }), (e) => e.status === 503);
  assert.equal(w.of('spawn').length, 1, 'nothing spawned after the shutdown began');
  assert.equal(exited, 0);
  await p;
  assert.deepEqual(w.of('panel-exit'), [['panel-exit', 0]], 'the panel exits once, with no pi alive');
  await assert.rejects(h.start('r1'), (e) => e.status === 503);
  assert.equal(w.of('spawn').length, 1);
});

test('d: the panel shutdown exits only after the sessions are gone, once, on any number of signals', async () => {
  const { shutdown } = require('../server/rpchost.js');
  let release;
  let calls = 0;
  const fakeHost = { closeAll: () => { calls++; return new Promise((r) => { release = r; }); } };
  const exits = [];
  const onSignal = shutdown(fakeHost, (code) => exits.push(code));
  onSignal();
  onSignal();
  await sleep(30);
  assert.deepEqual(exits, []);
  assert.equal(calls, 1);
  release();
  await until(() => exits.length);
  assert.deepEqual(exits, [0]);
});

test('d: server.close calls back only after the sessions are gone', async () => {
  const { createServer } = require('../server/http.js');
  let release;
  const fakeHost = { closeAll: () => new Promise((r) => { release = r; }), stateOf: () => 'closed' };
  const port = await new Promise((resolve) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
  const server = createServer(port, { rpcHost: fakeHost, noSummaryStore: true });
  await new Promise((r) => server.listen(port, '127.0.0.1', r));
  let closed = false;
  const done = new Promise((r) => server.close(() => { closed = true; r(); }));
  await sleep(50);
  assert.equal(closed, false);
  release();
  await done;
});
