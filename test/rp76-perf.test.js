'use strict';
// RP76 (S68): server/perf.js keeps the last timings of every route in a bounded ring (nearest-rank percentiles) and warns once per
// route every 10 s about a slow request; the HTTP layer records every answer (also errors), sends Server-Timing, exposes
// GET /api/perf and shares identical in-flight GET requests (single flight). Real Orca, real remotes and the real config are
// never involved: a temp config with one tiny local git repo.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const net = require('node:net');
const { spawnSync } = require('node:child_process');

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'rp76-'));
const repoDir = path.join(scratch, 'repo-one');
fs.mkdirSync(repoDir);
const configFile = path.join(scratch, 'config.json');
process.env.REPO_PANEL_CONFIG = configFile;
process.env.REPO_PANEL_CASES_FILE = 'off';
process.env.REPO_PANEL_MAX_PARALLEL = '2';
test.after(() => fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 5 }));

const lib = require('../lib.js');
const exec = require('../server/exec.js');
const { createServer } = require('../server/http.js');
const { createPerf } = require('../server/perf.js');

const REPO_ID = lib.repoId(repoDir);
fs.writeFileSync(configFile, JSON.stringify({ port: 4310, groups: [{ name: 'G', repos: [{ path: repoDir }] }] }));
spawnSync('git', ['init', '-q'], { cwd: repoDir });

// ---- createPerf (pure) ----
const rec = (route, ms, extra = {}) => ({ route, ms, waitMs: 0, procs: 1, priority: 'background', ...extra });
const quiet = { now: () => 0, warn: () => {}, slowMs: 1e9 };

test('summary: n, p50, p95 (nearest rank), max, waitP50 and procsAvg per route', () => {
  const perf = createPerf(quiet);
  [7, 3, 10, 1, 9, 2, 8, 4, 6, 5].forEach((ms) => perf.record(rec('GET /a', ms)));
  const a = perf.summary()['GET /a'];
  assert.equal(a.n, 10);
  assert.equal(a.p50, 5);
  assert.equal(a.p95, 10);
  assert.equal(a.max, 10);
  const b = createPerf(quiet);
  [40, 10, 30, 20].forEach((ms) => b.record(rec('GET /b', ms)));
  assert.equal(b.summary()['GET /b'].p50, 20);
  assert.equal(b.summary()['GET /b'].p95, 40);
  const one = createPerf(quiet);
  one.record(rec('GET /c', 12));
  assert.deepEqual([one.summary()['GET /c'].p50, one.summary()['GET /c'].p95, one.summary()['GET /c'].max], [12, 12, 12]);
  const w = createPerf(quiet);
  [[300, 3], [0, 1], [200, 2], [0, 3], [100, 1]].forEach(([waitMs, procs]) => w.record(rec('GET /w', 5, { waitMs, procs })));
  assert.equal(w.summary()['GET /w'].waitP50, 100);
  assert.equal(w.summary()['GET /w'].procsAvg, 2);
});

test('summary counts the priorities of the kept records of a route', () => {
  const perf = createPerf(quiet);
  perf.record(rec('GET /p', 1, { priority: 'user' }));
  perf.record(rec('GET /p', 1));
  perf.record(rec('GET /p', 1));
  assert.deepEqual(perf.summary()['GET /p'].priorities, { user: 1, background: 2 });
});

test('the ring forgets old records of a route and does not touch other routes', () => {
  const perf = createPerf({ ...quiet, ringSize: 5 });
  perf.record(rec('GET /r', 9999));
  perf.record(rec('GET /other', 77));
  for (let ms = 1; ms <= 20; ms++) perf.record(rec('GET /r', ms));
  const r = perf.summary()['GET /r'];
  assert.equal(r.n, 5);
  assert.equal(r.max, 20);
  assert.equal(r.p50, 18);
  assert.equal(perf.summary()['GET /other'].n, 1);
});

test('slow log: one single line with route, ms, queue wait and processes; nothing else of the request', () => {
  const lines = [];
  const perf = createPerf({ now: () => 0, slowMs: 1500, warn: (l) => lines.push(l) });
  perf.record(rec('GET /api/local', 1499));
  assert.equal(lines.length, 0, 'a fast request never warns');
  perf.record({ ...rec('GET /api/local', 2000, { waitMs: 731, procs: 4 }), url: '/api/local?id=abc123secret', body: { token: 'tok-987' }, query: { id: 'abc123secret' } });
  assert.equal(lines.length, 1);
  const line = lines[0];
  assert.equal(typeof line, 'string');
  assert.ok(!line.includes('\n'));
  for (const part of ['GET /api/local', '2000', '731', '4']) assert.ok(line.includes(part), `missing ${part} in: ${line}`);
  assert.ok(!line.includes('abc123secret') && !line.includes('tok-987') && !line.includes('?'), line);
});

test('slow log: ms equal to slowMs warns; at most one warning per route every 10 s of the injected clock', () => {
  let t = 0;
  const lines = [];
  const perf = createPerf({ now: () => t, slowMs: 1500, warn: (l) => lines.push(l) });
  perf.record(rec('GET /x', 1500));
  assert.equal(lines.length, 1);
  t = 5000;
  perf.record(rec('GET /x', 3000));
  t = 9999;
  perf.record(rec('GET /x', 3000));
  assert.equal(lines.length, 1);
  perf.record(rec('GET /y', 3000));
  assert.equal(lines.length, 2, 'another route has its own window');
  t = 10000;
  perf.record(rec('GET /x', 3000));
  assert.equal(lines.length, 3);
  assert.equal(perf.summary()['GET /x'].n, 4, 'suppressed warnings are still recorded');
});

test('a warn that throws never breaks record()', () => {
  const perf = createPerf({ now: () => 0, slowMs: 10, warn: () => { throw new Error('console is gone'); } });
  assert.doesNotThrow(() => perf.record(rec('GET /z', 5000)));
  assert.equal(perf.summary()['GET /z'].n, 1);
});

// ---- HTTP ----
const freePort = () => new Promise((resolve) => {
  const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
});

async function withServer(fn) {
  const port = await freePort();
  const server = createServer(port, {});
  await new Promise((r) => server.listen(port, '127.0.0.1', r));
  const call = (method, p, token, body, headers = {}) => new Promise((resolve, reject) => {
    const h = { host: `127.0.0.1:${port}`, ...(token ? { 'x-token': token, 'content-type': 'application/json' } : {}), ...headers };
    const req = http.request({ host: '127.0.0.1', port, path: p, method, headers: h }, (res) => {
      let d = ''; res.on('data', (c) => { d += c; }); res.on('end', () => resolve({ status: res.statusCode, text: d, headers: res.headers }));
    });
    req.on('error', reject);
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
  try {
    const token = /name="?token"? content="([0-9a-f]+)"/.exec((await call('GET', '/')).text)[1];
    const perf = async () => JSON.parse((await call('GET', '/api/perf', token)).text);
    await fn({ call, token, perf });
  } finally { server.close(); server.closeAllConnections(); }
}

// Keeps both process slots busy for `ms` so the next request has to wait for one.
const hold = (ms) => [1, 2].map(() => exec.run(process.execPath, ['-e', `setTimeout(() => {}, ${ms})`]));
const delta = (after, before, route, field) => (after.routes[route]?.[field] || 0) - (before.routes[route]?.[field] || 0);

test('GET /api/perf needs the token and answers routes and the queue', async () => {
  await withServer(async ({ call, token, perf }) => {
    assert.equal((await call('GET', '/api/perf')).status, 401);
    await call('GET', `/api/rooms?id=${REPO_ID}&secret=tok-123`, token);
    const body = await perf();
    assert.deepEqual(Object.keys(body).sort(), ['queue', 'routes']);
    assert.deepEqual(body.queue, { active: 0, max: 2, waitingBackground: 0, waitingUser: 0 });
    assert.ok(body.routes['GET /api/rooms'].n >= 1, 'keyed by the route name, without the query');
    for (const key of Object.keys(body.routes)) assert.ok(!key.includes('?'), key);
    const text = JSON.stringify(body);
    for (const leak of [REPO_ID, 'tok-123', token, repoDir, 'repo-one']) assert.ok(!text.includes(leak), `leaks ${leak}`);
  });
});

test('every JSON answer carries Server-Timing with total and, when it waited for a slot, queue', async () => {
  await withServer(async ({ call, token, perf }) => {
    const quick = await call('GET', '/api/rooms', token);
    assert.match(quick.headers['server-timing'], /total;dur=\d+(\.\d+)?/);
    const missing = await call('GET', '/api/state?id=nonexistent01', token);
    assert.equal(missing.status, 404);
    assert.match(missing.headers['server-timing'], /total;dur=\d+(\.\d+)?/);
    const holders = hold(500);
    await new Promise((r) => setTimeout(r, 60));
    const slow = await call('GET', `/api/local?id=${REPO_ID}`, token);
    assert.equal(slow.status, 200);
    const queue = /queue;dur=(\d+(?:\.\d+)?)/.exec(slow.headers['server-timing']);
    assert.ok(queue, slow.headers['server-timing']);
    assert.ok(Number(queue[1]) >= 250, `queue ${queue[1]}`);
    assert.ok(Number(/total;dur=(\d+(?:\.\d+)?)/.exec(slow.headers['server-timing'])[1]) >= Number(queue[1]));
    await Promise.all(holders);
    assert.ok((await perf()).routes['GET /api/local'].waitP50 >= 250);
  });
});

test('priorities: a POST is recorded as user, a plain GET as background, a GET with x-priority: user as user', async () => {
  await withServer(async ({ call, token, perf }) => {
    const before = await perf();
    await call('POST', '/api/dismiss', token, { id: REPO_ID, on: false });
    await call('GET', '/api/rooms', token);
    await call('GET', '/api/config', token, undefined, { 'x-priority': 'user' });
    const after = await perf();
    const prio = (route, which) => (after.routes[route].priorities[which] || 0) - ((before.routes[route]?.priorities || {})[which] || 0);
    assert.deepEqual([prio('POST /api/dismiss', 'user'), prio('POST /api/dismiss', 'background')], [1, 0]);
    assert.deepEqual([prio('GET /api/rooms', 'user'), prio('GET /api/rooms', 'background')], [0, 1]);
    assert.deepEqual([prio('GET /api/config', 'user'), prio('GET /api/config', 'background')], [1, 0]);
  });
});

test('single flight: two identical concurrent GETs run once; POSTs, other queries and later requests run on their own', async () => {
  await withServer(async ({ call, token, perf }) => {
    const url = `/api/local?id=${REPO_ID}`;
    let before = await perf();
    let holders = hold(500);
    await new Promise((r) => setTimeout(r, 60));
    const [a, b] = await Promise.all([call('GET', url, token), call('GET', url, token)]);
    await Promise.all(holders);
    assert.equal(a.status, 200);
    assert.equal(a.text, b.text, 'the shared answer is the same');
    let after = await perf();
    assert.equal(delta(after, before, 'GET /api/local', 'n'), 2);
    assert.equal(delta(after, before, 'GET /api/local', 'executions'), 1);

    // A different query is not shared.
    before = after;
    holders = hold(500);
    await new Promise((r) => setTimeout(r, 60));
    await Promise.all([call('GET', url, token), call('GET', `${url}&v=2`, token)]);
    await Promise.all(holders);
    after = await perf();
    assert.equal(delta(after, before, 'GET /api/local', 'n'), 2);
    assert.equal(delta(after, before, 'GET /api/local', 'executions'), 2);

    // After the first settled a new request runs again.
    before = after;
    await call('GET', url, token);
    await call('GET', url, token);
    after = await perf();
    assert.equal(delta(after, before, 'GET /api/local', 'executions'), 2);

    // A POST is never shared.
    before = after;
    const body = { id: REPO_ID, on: false };
    await Promise.all([call('POST', '/api/dismiss', token, body), call('POST', '/api/dismiss', token, body)]);
    after = await perf();
    assert.equal(delta(after, before, 'POST /api/dismiss', 'n'), 2);
    assert.equal(delta(after, before, 'POST /api/dismiss', 'executions'), 2);
  });
});

test('the error path is timed too, and a failing request leaves no queue leak', async () => {
  await withServer(async ({ call, token, perf }) => {
    const before = await perf();
    assert.equal((await call('GET', '/api/state?id=nonexistent01', token)).status, 404);
    assert.equal((await call('POST', '/api/dismiss', token, { id: 'nonexistent01', on: true })).status, 404);
    const after = await perf();
    assert.equal(delta(after, before, 'GET /api/state', 'n'), 1);
    assert.ok(after.routes['POST /api/dismiss'].n >= 1);
    assert.deepEqual(after.queue, { active: 0, max: 2, waitingBackground: 0, waitingUser: 0 });
  });
});
