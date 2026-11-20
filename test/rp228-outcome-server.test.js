'use strict';
// RP228: how the last task of a session ended (finished, failed, stopped), from the events of the host. The client keeps it (`outcome()`), the host reads it (`outcomeOf`),
// and the row of the Summary carries `session.last = { kind, at }` for a free session, for 15 minutes after the task ended. A row with no outcome is the row of always.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const net = require('node:net');
const { EventEmitter } = require('node:events');

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'rp228s-'));
process.env.REPO_PANEL_CONFIG = path.join(scratch, 'config.json');
test.after(() => fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 5 }));

const lib = require('../lib.js');
const { createRpcClient } = require('../server/rpc.js');
const { createRpcHost } = require('../server/rpchost.js');
const { summarize, summaryFor } = require('../server/summary.js');
const { createSummaryStore } = require('../server/summarystore.js');
const { createServer } = require('../server/http.js');
const { findRepo } = require('../server/config.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 2000) => { const end = Date.now() + ms; while (Date.now() < end) { const v = fn(); if (v) return v; await sleep(5); } throw new Error('timed out waiting'); };

// ---------- the client ----------
function fakeChild() {
  const c = new EventEmitter();
  c.pid = 4242;
  c.stdout = new EventEmitter();
  c.writes = [];
  c.stdin = Object.assign(new EventEmitter(), { write(s) { c.writes.push(s); return true; }, end() {} });
  c.kill = () => {};
  c.said = (obj) => c.stdout.emit('data', `${JSON.stringify(obj)}\n`);
  c.sent = () => c.writes.join('').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  return c;
}
async function ready(t) {
  const child = fakeChild();
  const spawn = (file) => (file === 'taskkill' ? new EventEmitter() : child);
  const client = createRpcClient({ command: 'C:\\x\\pi.exe', args: [], cwd: scratch, env: {}, spawn, platform: 'win32', graceMs: 50, killWaitMs: 50 }); // RP238: a short grace, the fake never exits by itself
  t.after(() => client.close());
  const started = client.start();
  await until(() => child.sent().length >= 1);
  child.said({ id: child.sent()[0].id, type: 'response', command: 'get_state', success: true, data: { isStreaming: false } });
  await started;
  return { child, client };
}
// One whole task: its start, the given records and its end. Resolves once the client shows the outcome of THIS task (`at` moves on each call).
async function task(child, client, mid, end = { type: 'agent_end' }) {
  child.said({ type: 'agent_start' });
  for (const m of mid) child.said(m);
  await sleep(2); // the clock moves, so each task has its own `at`
  child.said(end);
  return until(() => client.outcome());
}

test('client: no task yet is no outcome', async (t) => {
  const { client } = await ready(t);
  assert.equal(client.outcome(), null);
});

test('client: a task that ends well is done, with the time it ended', async (t) => {
  const { child, client } = await ready(t);
  const before = Date.now();
  const o = await task(child, client, [{ type: 'turn_end', stopReason: 'stop' }]);
  assert.equal(o.kind, 'done');
  assert.ok(Number.isFinite(o.at) && o.at >= before && o.at <= Date.now());
  assert.deepEqual(Object.keys(o).sort(), ['at', 'kind']);
});

test('client: a task with no turn_end at all is done', async (t) => {
  const { child, client } = await ready(t);
  assert.equal((await task(child, client, [])).kind, 'done');
});

test('client: a last turn that ended in error is failed, at the top level and inside the message', async (t) => {
  const { child, client } = await ready(t);
  assert.equal((await task(child, client, [{ type: 'turn_end', stopReason: 'error' }])).kind, 'failed');
  child.said({ type: 'agent_start' });
  assert.equal(client.outcome(), null);
  child.said({ type: 'turn_end', message: { stopReason: 'error' } });
  child.said({ type: 'agent_end' });
  assert.equal((await until(() => client.outcome())).kind, 'failed');
});

test('client: a stop reason that is not a string is ignored (the task is done)', async (t) => {
  const { child, client } = await ready(t);
  assert.equal((await task(child, client, [{ type: 'turn_end', stopReason: 5, message: { stopReason: { x: 1 } } }])).kind, 'done');
});

test('client: a retry that later succeeds ends done, and a failure after a success ends failed: only the last turn counts', async (t) => {
  const { child, client } = await ready(t);
  assert.equal((await task(child, client, [{ type: 'turn_end', stopReason: 'error' }, { type: 'turn_end', stopReason: 'stop' }])).kind, 'done');
  assert.equal((await task(child, client, [{ type: 'turn_end', stopReason: 'stop' }, { type: 'turn_end', stopReason: 'error' }])).kind, 'failed');
});

test('client: a task stopped by hand is stopped: the aborted flag of agent_end, and the aborted stop reason at both levels', async (t) => {
  const { child, client } = await ready(t);
  assert.equal((await task(child, client, [{ type: 'turn_end', stopReason: 'stop' }], { type: 'agent_end', aborted: true })).kind, 'stopped');
  assert.equal((await task(child, client, [{ type: 'turn_end', stopReason: 'aborted' }])).kind, 'stopped');
  assert.equal((await task(child, client, [{ type: 'turn_end', message: { stopReason: 'aborted' } }])).kind, 'stopped');
  assert.equal((await task(child, client, [{ type: 'turn_end', stopReason: 'error' }], { type: 'agent_end', aborted: true })).kind, 'stopped', 'the person stopped it: not a failure');
});

test('client: agent_start clears the outcome at once, and the run state with it', async (t) => {
  const { child, client } = await ready(t);
  assert.equal((await task(child, client, [{ type: 'turn_end', stopReason: 'error' }])).kind, 'failed');
  child.said({ type: 'agent_start' });
  await until(() => client.outcome() === null);
  child.said({ type: 'agent_end' }); // no turn_end this time: not the failure of the task before
  assert.equal((await until(() => client.outcome())).kind, 'done');
});

test('client: a stop reason from before agent_start does not leak into the next task', async (t) => {
  const { child, client } = await ready(t);
  child.said({ type: 'turn_end', stopReason: 'error' });
  assert.equal((await task(child, client, [])).kind, 'done');
});

test('client: agent_settled neither creates nor overwrites the outcome', async (t) => {
  const { child, client } = await ready(t);
  child.said({ type: 'agent_settled' });
  await sleep(20);
  assert.equal(client.outcome(), null);
  const first = await task(child, client, [{ type: 'turn_end', stopReason: 'error' }]);
  child.said({ type: 'turn_end', stopReason: 'stop' });
  child.said({ type: 'agent_settled', aborted: true });
  await sleep(20);
  assert.deepEqual(client.outcome(), first);
});

test('client: outcome() answers a fresh copy, and a closed client has none', async (t) => {
  const { child, client } = await ready(t);
  const o = await task(child, client, []);
  o.kind = 'failed';
  assert.equal(client.outcome().kind, 'done');
  client.close();
  assert.equal(client.outcome(), null);
});

// ---------- the host ----------
const ACTIVE = { id: 'gentle-shell', command: 'C:\\L\\gentle-shell.cmd', agentDir: 'C:\\Users\\u\\.gentle-shell\\agent' };
function hostWith(clientOver = {}) {
  const repo = { id: 'aaa', path: 'C:\\repos\\alpha' };
  const createClient = () => {
    const c = { start: () => Promise.resolve({}), request: () => Promise.resolve({}), answerDialog: () => false, pendingDialogs: () => [], state: () => 'idle', close() { c.closed = true; }, ...clientOver };
    return c;
  };
  const repoOf = (id) => { if (id !== repo.id) { const e = new Error('Unknown repository'); e.status = 404; throw e; } return repo; };
  return createRpcHost({ resolve: async () => ({ active: ACTIVE }), repoOf, publish: () => {}, createClient, adoptedOf: () => null });
}

test('host: outcomeOf is the outcome of the live client, a fresh value each time', async () => {
  const host = hostWith({ outcome: () => ({ kind: 'failed', at: 1234 }) });
  await host.start('aaa');
  assert.deepEqual(host.outcomeOf('aaa'), { kind: 'failed', at: 1234 });
  assert.notEqual(host.outcomeOf('aaa'), host.outcomeOf('aaa'));
});

test('host: outcomeOf is total: null with no live entry, while starting, closed, with no outcome on the client or a malformed one', async () => {
  assert.equal(hostWith().outcomeOf('aaa'), null, 'no live entry');
  assert.equal(hostWith().outcomeOf('nobody'), null);
  for (const id of [undefined, null, 5, {}, '']) assert.equal(hostWith().outcomeOf(id), null);
  const starting = hostWith({ start: () => new Promise(() => {}), outcome: () => ({ kind: 'done', at: 1 }) });
  starting.start('aaa');
  await new Promise((r) => setImmediate(r));
  assert.equal(starting.outcomeOf('aaa'), null, 'not up yet');
  const bad = [['no outcome on the client', undefined], ['throws', () => { throw new Error('x'); }], ['null', () => null], ['a string', () => 'done'], ['an array', () => []], ['no kind', () => ({ at: 1 })], ['kind not a string', () => ({ kind: 5, at: 1 })], ['at not finite', () => ({ kind: 'done', at: NaN })], ['at a string', () => ({ kind: 'done', at: '1' })]];
  for (const [name, outcome] of bad) {
    const host = hostWith({ outcome });
    await host.start('aaa');
    assert.equal(host.outcomeOf('aaa'), null, name);
  }
  const host = hostWith({ outcome: () => ({ kind: 'done', at: 1 }) });
  await host.start('aaa');
  await host.close('aaa');
  assert.equal(host.outcomeOf('aaa'), null, 'closed');
});

// ---------- the row of the Summary ----------
const NOW = Date.parse('2026-11-17T12:00:00Z');
const MIN = 60 * 1000;
const facts = (over = {}) => ({
  repo: { id: 'r1', name: 'x', group: 'G', room: null }, local: { branch: 'main', files: [], ahead: 0, behind: 0, base: 'main' }, prs: { prs: [], stale: null },
  roadmap: { available: true, rows: [], derived: {}, next: null }, state: { available: false }, session: 'idle', last: { at: null }, snoozed: [], now: NOW, ...over,
});
const out = (kind, ago = 0) => ({ kind, at: NOW - ago });

test('row: a free session with a recent outcome says how its last task ended, with the time as an ISO string', () => {
  for (const kind of ['done', 'failed', 'stopped']) {
    const row = summarize(facts({ outcome: out(kind, 3 * MIN) }));
    assert.deepEqual(row.session, { state: 'free', last: { kind, at: new Date(NOW - 3 * MIN).toISOString() } }, kind);
  }
});

test('row: exactly 15 minutes is kept, one millisecond more is dropped, a time in the future is dropped, and now itself is kept', () => {
  assert.equal(summarize(facts({ outcome: out('done', 15 * MIN) })).session.last.kind, 'done');
  assert.deepEqual(summarize(facts({ outcome: out('done', 15 * MIN + 1) })).session, { state: 'free' });
  assert.deepEqual(summarize(facts({ outcome: { kind: 'done', at: NOW + 1 } })).session, { state: 'free' });
  assert.equal(summarize(facts({ outcome: out('failed', 0) })).session.last.kind, 'failed');
});

test('row: only a free session carries it: working, waiting, closed, starting and unknown never do', () => {
  for (const session of ['busy', 'asking', 'closed', 'starting', 'unknown', undefined]) {
    const row = summarize(facts({ session, outcome: out('failed', MIN) }));
    assert.ok(!('last' in row.session), String(session));
  }
});

test('row: an unknown kind, a non-finite or non-number time and a malformed outcome are dropped', () => {
  const bad = [{ kind: 'weird', at: NOW }, { kind: 'running', at: NOW }, { kind: 5, at: NOW }, { at: NOW }, { kind: 'done' }, { kind: 'done', at: NaN }, { kind: 'done', at: Infinity }, { kind: 'done', at: String(NOW) }, { kind: 'done', at: null }, null, 'done', 5, [], undefined];
  for (const o of bad) assert.deepEqual(summarize(facts({ outcome: o })).session, { state: 'free' }, JSON.stringify(o));
});

test('row: a row with no outcome is exactly the row of always, and the outcome sits beside the jobs', () => {
  const plain = summarize(facts());
  assert.deepEqual(plain.session, { state: 'free' });
  assert.deepEqual(summarize(facts({ outcome: undefined })), plain);
  assert.deepEqual(summarize(facts({ jobs: 2, outcome: out('done', MIN) })).session, { state: 'free', jobs: 2, last: { kind: 'done', at: new Date(NOW - MIN).toISOString() } });
  const rest = { ...summarize(facts({ outcome: out('done', MIN) })) };
  const base = { ...plain };
  delete rest.session;
  delete base.session;
  assert.deepEqual(rest, base, 'nothing else in the row changes');
});

// summaryFor with injected deps: the outcome is read through deps.outcomeOf, only for a raw idle session.
function summaryDeps(over = {}) {
  const dir = path.join(scratch, 'repo');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(process.env.REPO_PANEL_CONFIG, JSON.stringify({ port: 4310, groups: [{ name: 'G', repos: [{ path: dir }] }], rooms: [] }));
  const calls = [];
  const deps = {
    now: () => NOW,
    local: async () => ({ branch: 'main', files: [], ahead: 0, behind: 0, base: 'main' }), prs: async () => ({ prs: [], stale: null }), roadmap: async () => ({ available: false, reason: 'missing' }), state: async () => ({ available: false }),
    git: async () => ({ code: 0, stdout: '2026-10-28T10:00:00Z\nsubject\n', stderr: '' }),
    sessionOf: () => 'idle', outcomeOf: (rid) => { calls.push(rid); return out('done', 2 * MIN); }, ...over,
  };
  return { deps, id: lib.repoId(dir), calls };
}

test('summaryFor: reads deps.outcomeOf for an idle session and the row carries it', async () => {
  const { deps, id, calls } = summaryDeps();
  const res = await summaryFor(deps, { fresh: '1' });
  assert.deepEqual(res.rows[0].session, { state: 'free', last: { kind: 'done', at: new Date(NOW - 2 * MIN).toISOString() } });
  assert.deepEqual(calls, [id]);
});

test('summaryFor: a session that is not idle never asks for the outcome, and a getter that throws or is missing is no outcome', async () => {
  const busy = summaryDeps({ sessionOf: () => 'busy' });
  assert.deepEqual((await summaryFor(busy.deps, { fresh: '1' })).rows[0].session, { state: 'working' });
  assert.deepEqual(busy.calls, []);
  const boom = summaryDeps({ outcomeOf: () => { throw new Error('host down'); } });
  assert.deepEqual((await summaryFor(boom.deps, { fresh: '1' })).rows[0].session, { state: 'free' });
  const none = summaryDeps({ outcomeOf: undefined });
  assert.deepEqual((await summaryFor(none.deps, { fresh: '1' })).rows[0].session, { state: 'free' });
});

// ---------- the store snapshot ----------
async function storeFor(over = {}, opts = {}) {
  const { deps } = summaryDeps(over);
  const cfg = JSON.parse(fs.readFileSync(process.env.REPO_PANEL_CONFIG, 'utf8'));
  let t = NOW;
  const store = createSummaryStore({ deps: { ...deps, fetch: async () => ({ skipped: 'no-remote' }) }, now: () => t, loadCfg: () => ({ ...cfg, snoozed: [] }), setTimer: () => ({ unref() {} }), clearTimer() {}, waitForClient: false, sessionOf: deps.sessionOf, ...opts });
  await store.refreshAll();
  return { store, at: (v) => { t = v; } };
}

test('store: the snapshot row carries the outcome of a free session, read now through outcomeOf', async () => {
  const { store } = await storeFor({}, { outcomeOf: () => out('failed', MIN) });
  assert.deepEqual(store.snapshot().rows[0].session, { state: 'free', last: { kind: 'failed', at: new Date(NOW - MIN).toISOString() } });
});

test('store: it fades with the clock of the store; a session that is not idle, no getter or a throwing getter leave the row of always', async () => {
  const s = await storeFor({}, { outcomeOf: () => out('done', 0) });
  assert.equal(s.store.snapshot().rows[0].session.last.kind, 'done');
  s.at(NOW + 15 * MIN);
  assert.equal(s.store.snapshot().rows[0].session.last.kind, 'done', 'exactly 15 min');
  s.at(NOW + 15 * MIN + 1);
  assert.deepEqual(s.store.snapshot().rows[0].session, { state: 'free' });
  let asked = 0;
  const busy = await storeFor({ sessionOf: () => 'busy' }, { sessionOf: () => 'busy', outcomeOf: () => { asked++; return out('done', 0); } });
  assert.deepEqual(busy.store.snapshot().rows[0].session, { state: 'working' });
  assert.equal(asked, 0);
  assert.deepEqual((await storeFor({}, {})).store.snapshot().rows[0].session, { state: 'free' });
  assert.deepEqual((await storeFor({}, { outcomeOf: () => { throw new Error('x'); } })).store.snapshot().rows[0].session, { state: 'free' });
});

test('store: a repo whose reads failed still carries the outcome of its free session', async () => {
  const { store } = await storeFor({ local: async () => { throw new Error('git broke'); } }, { outcomeOf: () => out('stopped', MIN) });
  const row = store.snapshot().rows[0];
  assert.ok(row.error);
  assert.equal(row.session.last.kind, 'stopped');
});

// ---------- the route ----------
const call = (port, p, token) => new Promise((resolve, reject) => {
  http.get({ host: '127.0.0.1', port, path: p, headers: token ? { 'x-token': token } : {} }, (res) => {
    let d = ''; res.on('data', (c) => { d += c; }); res.on('end', () => resolve({ body: d, json: (() => { try { return JSON.parse(d); } catch { return null; } })() }));
  }).on('error', reject);
});
const freePort = () => new Promise((resolve) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });

test('http: END TO END, with and without the store of production: the Summary route carries session.last from the host, and the row of always for a host that has none', async () => {
  const { deps } = summaryDeps();
  const { now, sessionOf, outcomeOf, ...OK } = deps;
  const mk = (outcome) => createRpcHost({
    resolve: async () => ({ active: ACTIVE }), repoOf: findRepo, publish() {}, adoptedOf: () => null,
    createClient: () => ({ start: async () => ({}), request: async () => ({}), answerDialog: () => false, pendingDialogs: () => [], state: () => 'idle', close() {}, ...(outcome ? { outcome } : {}) }),
  });
  const id = lib.repoId(path.join(scratch, 'repo'));
  for (const viaStore of [false, true]) for (const [outcome, expected] of [[() => ({ kind: 'failed', at: Date.now() - 1000 }), 'failed'], [null, undefined]]) {
    const host = mk(outcome);
    const port = await freePort();
    const server = createServer(port, { rpcHost: host, ...OK, fetch: async () => ({ skipped: 'no-remote' }), ...(viaStore ? {} : { noSummaryStore: true }) }); // viaStore: the store createServer builds, the one the real server answers from
    await new Promise((r) => server.listen(port, '127.0.0.1', r));
    try {
      const token = /name="?token"? content="([0-9a-f]+)"/.exec((await call(port, '/')).body)[1];
      const row = async () => (await call(port, '/api/summary?fresh=1', token)).json.rows.find((x) => x.id === id);
      assert.deepEqual((await row()).session, { state: 'none' }, 'not started: closed, nothing read');
      await host.start(id);
      const live = (await row()).session;
      assert.equal(live.state, 'free');
      assert.equal(live.last && live.last.kind, expected);
      if (!expected) assert.deepEqual(live, { state: 'free' });
    } finally { host.closeAll(); await new Promise((r) => server.close(r)); }
  }
});
