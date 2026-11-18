'use strict';
// RP18 server side of POST /api/pi: the unstage key, the send lock (RP234 replaced the 45 s duplicate guard), and the
// "keep the index empty" sentence of the orders. RPC2-2: the commands go to the session through the rpc host.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const net = require('node:net');

// The config path is read when the server modules load, so the throwaway config must exist before the requires.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-panel-rp18-'));
const REPO_PATH = 'C:\\dev\\repo';
process.env.REPO_PANEL_CONFIG = path.join(dir, 'config.json');

const test = require('node:test');
const assert = require('node:assert/strict');
const lib = require('../lib.js');
const { createServer } = require('../server/http.js');
const { piSend, fixPrOrder, conditionsOrder, sendLock } = require('../server/pi.js');

test.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 }));

const REPO = { id: 'r1', path: REPO_PATH };
// The rpc host's side of a send: the session state it reports and the prompts it received.
function fakeHost(state = 'idle') {
  const sent = [];
  return { sent, status: async () => ({ state }), prompt: async (id, text) => { sent.push(text); return { disposition: 'started' }; } };
}
const NEVER = async () => { throw new Error('must not be read'); };
const refuses = (p, status, re) => assert.rejects(p, (e) => e.status === status && re.test(e.message));
const failing = { number: 7, title: 'Fix the thing', head: 'task', base: 'main', checks: { state: 'failed', items: [{ name: 'test', state: 'failed' }] } };
const prs = async () => ({ repo: {}, prs: [failing] });

// ---------- the new fixed command ----------
test('flow-commit-unstage: piSend prompts exactly /flow-commit --unstage', async () => {
  const h = fakeHost();
  assert.deepEqual(await piSend(REPO, 'flow-commit-unstage', h), { sent: true, confirmed: true });
  assert.deepEqual(h.sent, ['/flow-commit --unstage']);
});

test('flow-commit-unstage: keeps the session safeguards and sends nothing when they refuse', async () => {
  for (const [state, re] of [['closed', /^The session is not started$/], ['busy', /^The session is busy$/], ['asking', /^The session is waiting for an answer$/]]) {
    const h = fakeHost(state);
    await refuses(piSend(REPO, 'flow-commit-unstage', h), 409, re);
    assert.deepEqual(h.sent, []);
  }
});

test('flow-commit: still sends /flow-commit and the near-miss keys stay unknown', async () => {
  const h = fakeHost();
  await piSend(REPO, 'flow-commit', h);
  assert.deepEqual(h.sent, ['/flow-commit']);
  for (const c of ['flow-commit --unstage', 'flow-commit-unstage ', 'FLOW-COMMIT-UNSTAGE', '/flow-commit --unstage', 'flow-commit-unstage2']) {
    await refuses(piSend(REPO, c, fakeHost()), 400, /Unknown command/);
  }
});

// ---------- the send lock (RP234: no 45 s window; the lock lasts only while an order is on its way) ----------
test('lock: once a send was answered the same key goes again at once, other keys and other repos too', async () => {
  const lock = sendLock();
  const send = (key, h = fakeHost(), repo = REPO, extra = {}) => piSend(repo, key, h, NEVER, { lock, ...extra });
  assert.equal((await send('flow-pr')).sent, true);
  const again = fakeHost();
  assert.equal((await send('flow-pr', again)).sent, true);
  assert.deepEqual(again.sent, ['/flow-pr']);
  assert.equal((await send('flow-commit')).sent, true); // a different key
  assert.equal((await send('flow-pr', fakeHost(), { id: 'r2', path: 'C:\dev\other' })).sent, true); // another repo
});

test('lock: fix-pr and put-in-conditions go through it, and a refused send does not take it', async () => {
  const lock = sendLock();
  const reqs = async () => ({ available: true, results: [{ id: 'a', status: 'fail', level: 'required' }] });
  assert.equal((await piSend(REPO, 'fix-pr', fakeHost(), NEVER, { lock, pr: 7, prs })).sent, true);
  assert.equal((await piSend(REPO, 'fix-pr', fakeHost(), NEVER, { lock, pr: 7, prs })).sent, true);
  assert.equal((await piSend(REPO, 'put-in-conditions', fakeHost(), reqs, { lock })).sent, true);
  await refuses(piSend(REPO, 'flow-base', fakeHost('busy'), NEVER, { lock }), 409, /busy/);
  assert.equal((await piSend(REPO, 'flow-base', fakeHost(), NEVER, { lock })).sent, true);
});

test('lock: the not-started, busy, asking and unknown-key refusals keep their messages', async () => {
  const lock = sendLock();
  await piSend(REPO, 'flow-pr', fakeHost(), NEVER, { lock });
  await refuses(piSend(REPO, 'flow-pr', fakeHost('busy'), NEVER, { lock }), 409, /^The session is busy$/);
  await refuses(piSend(REPO, 'flow-pr', fakeHost('closed'), NEVER, { lock }), 409, /^The session is not started$/);
  await refuses(piSend(REPO, 'flow-pr', fakeHost('asking'), NEVER, { lock }), 409, /^The session is waiting for an answer$/);
  await refuses(piSend(REPO, 'nope', fakeHost(), NEVER, { lock }), 400, /^Unknown command$/);
});

test('lock: piSend without a lock behaves as before (repeat sends are not refused)', async () => {
  await piSend(REPO, 'flow-pr', fakeHost());
  assert.equal((await piSend(REPO, 'flow-pr', fakeHost())).sent, true);
});

// ---------- the real server ----------
const freePort = () => new Promise((resolve) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });

async function withServer(deps, fn) {
  const port = await freePort();
  fs.writeFileSync(process.env.REPO_PANEL_CONFIG, JSON.stringify({ port, groups: [{ name: 'g', repos: [{ path: REPO_PATH }] }] }));
  const server = createServer(port, deps);
  await new Promise((resolve) => { server.listen(port, '127.0.0.1', resolve); });
  try {
    const request = (method, p, body, token) => new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, path: p, method, headers: { ...(token ? { 'x-token': token } : {}), 'content-type': 'application/json' } }, (res) => {
        let d = ''; res.on('data', (c) => { d += c; }); res.on('end', () => resolve({ status: res.statusCode, body: d }));
      });
      req.on('error', reject);
      req.end(body === undefined ? undefined : JSON.stringify(body));
    });
    const token = /name="?token"? content="([0-9a-f]+)"/.exec((await request('GET', '/')).body)[1];
    const post = async (p, body, withToken = true) => { const r = await request('POST', p, body, withToken ? token : null); return { status: r.status, json: JSON.parse(r.body) }; };
    const get = async (p, withToken = true) => { const r = await request('GET', p, undefined, withToken ? token : null); return { status: r.status, raw: r.body, json: JSON.parse(r.body) }; };
    await fn({ post, get });
  } finally { await new Promise((resolve) => { server.close(resolve); }); }
}
const ID = lib.repoId(REPO_PATH);

test('POST /api/pi: flow-commit-unstage goes through the route, and a Retry after the answer goes at once (RP234)', async () => {
  const h = fakeHost();
  await withServer({ rpcHost: { ...h, closeAll() {} }, requirements: NEVER, prs }, async ({ post }) => {
    const ok = await post('/api/pi', { id: ID, command: 'flow-commit-unstage' });
    assert.deepEqual([ok.status, ok.json], [200, { sent: true, confirmed: true }]);
    assert.deepEqual(h.sent, ['/flow-commit --unstage']);
    const retry = await post('/api/pi', { id: ID, command: 'flow-commit-unstage' });
    assert.deepEqual([retry.status, retry.json], [200, { sent: true, confirmed: true }]);
    assert.equal(h.sent.length, 2);
    assert.equal((await post('/api/pi', { id: ID, command: 'flow-commit-unstage' }, false)).status, 401);
    assert.equal((await post('/api/pi', { id: 'nope', command: 'flow-commit-unstage' })).status, 404);
    assert.equal((await post('/api/pi', { id: ID, command: 'flow-commit --unstage' })).status, 400);
  });
});

test('POST /api/pi: each server keeps its own lock, so a second server starts with a clean slate', async () => {
  for (let i = 0; i < 2; i++) {
    await withServer({ rpcHost: { ...fakeHost(), closeAll() {} }, requirements: NEVER, prs }, async ({ post }) => {
      assert.equal((await post('/api/pi', { id: ID, command: 'flow-pr' })).status, 200);
    });
  }
});

// RP234: the route passes the server's lock and its count of background jobs (the number of RP161) to piSend.
test('POST /api/pi: two clicks at once send one order, and a delivery order waits for the background jobs of the session', async () => {
  const h = fakeHost();
  const gates = [];
  const prompt = h.prompt;
  h.prompt = async (...a) => { const r = await prompt(...a); await new Promise((ok) => gates.push(ok)); return r; };
  let jobs = 0;
  await withServer({ rpcHost: { ...h, closeAll() {} }, requirements: NEVER, prs, jobsOf: () => jobs }, async ({ post }) => {
    const first = post('/api/pi', { id: ID, command: 'flow-ship' });
    while (!gates.length) await new Promise((r) => setImmediate(r));
    const second = await post('/api/pi', { id: ID, command: 'flow-ship' });
    assert.deepEqual([second.status, second.json.error], [409, 'Another order is on its way to this session: wait for its answer']);
    gates.splice(0).forEach((ok) => ok());
    assert.equal((await first).status, 200);
    assert.deepEqual(h.sent, ['/flow-ship']);
    jobs = 1;
    const held = await post('/api/pi', { id: ID, command: 'flow-pr' });
    assert.deepEqual([held.status, held.json.error], [409, 'The session still has 1 background job running: wait for it to finish']);
    assert.deepEqual(h.sent, ['/flow-ship']);
  });
});

test('GET /api/pi-status: the token and the 404 still apply, tail is ignored and the answer is { state } from the host (RPC2-2)', async () => {
  const host = { status: async () => ({ state: 'idle' }), closeAll() {} };
  await withServer({ rpcHost: host }, async ({ get }) => {
    assert.equal((await get(`/api/pi-status?id=${ID}&tail=1`, false)).status, 401);
    assert.equal((await get('/api/pi-status?id=nope&tail=1')).status, 404);
    assert.equal((await get('/api/pi-status?tail=1')).status, 404);
    for (const q of ['', '&tail=0', '&tail=1']) assert.equal((await get(`/api/pi-status?id=${ID}${q}`)).raw, '{"state":"idle"}');
  });
});

// ---------- the orders keep the index empty ----------
// RP176: the index rule of the orders names /flow-ship.
const RULE = 'Never use git mv or git add; keep the git index empty (/flow-ship refuses to start with staged files).';

test('orders: fix-pr and put-in-conditions both ask for an empty index, stay one line and do not start with /', () => {
  const fix = fixPrOrder(failing);
  const put = conditionsOrder([{ id: 'agents-file', status: 'fail', level: 'required' }]);
  for (const text of [fix, put]) {
    assert.ok(text.includes(RULE), text);
    assert.equal(/[\x00-\x1f\x7f]/.test(text), false);
    assert.equal(text.startsWith('/'), false);
  }
  assert.match(put, /^Put this repo in conditions for repo-panel \(padrón \d+(\.\d+)*\): read "/);
  assert.match(put, /apply these requirement ids: agents-file\./);
});

test('orders: fix-pr stays under 1500 characters for 5 names and a 120-character title, with the new sentence', () => {
  const big = { ...failing, title: 'T'.repeat(200), head: 'h'.repeat(200), checks: { state: 'failed', items: Array.from({ length: 9 }, (_, i) => ({ name: `job ${i} ${'n'.repeat(70)}`, state: 'failed' })) } };
  const text = fixPrOrder(big);
  assert.ok(text.includes(RULE));
  assert.ok(text.length < 1500, String(text.length));
});
