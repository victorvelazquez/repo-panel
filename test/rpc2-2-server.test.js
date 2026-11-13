'use strict';
// RPC2-2 (S1, S6, S8), server side: the /flow-* buttons, put-in-conditions and fix-pr go to the session as an RPC `prompt` (POST /api/pi keeps its
// contract), GET /api/pi-status is answered from the host. The host is the real createRpcHost over a fake client.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'rpc2-2-server-'));
const REPO = path.join(scratch, 'My Repo');
fs.mkdirSync(REPO);
process.env.REPO_PANEL_CONFIG = path.join(scratch, 'config.json');
test.after(() => fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 5 }));

const lib = require('../lib.js');
const pi = require('../server/pi.js');
const { createServer } = require('../server/http.js');
const { createRpcHost } = require('../server/rpchost.js');
const { findRepo } = require('../server/config.js');

const ID = lib.repoId(REPO);
const ACTIVE = { id: 'gentle-shell', command: 'C:\\L\\gentle-shell.exe', agentDir: 'C:\\a' };
const writeConfig = () => fs.writeFileSync(process.env.REPO_PANEL_CONFIG, JSON.stringify({ groups: [{ name: 'g', repos: [{ path: REPO }] }] }));
const NEVER = async () => { throw new Error('must not be read'); };
const failing = { number: 7, title: 'Fix the thing', head: 'task', base: 'main', checks: { state: 'failed', items: [{ name: 'test', state: 'failed' }] } };
const prs = async () => ({ repo: {}, prs: [failing] });
const reqs = async () => ({ available: true, results: [{ id: 'agents-file', status: 'fail', level: 'required' }] });

const freePort = () => new Promise((resolve) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });
const call = (port, method, p, { token, body } = {}) => new Promise((resolve, reject) => {
  const data = body === undefined ? null : JSON.stringify(body);
  const req = http.request({ host: '127.0.0.1', port, path: p, method, headers: { ...(token ? { 'x-token': token } : {}), ...(data ? { 'content-type': 'application/json' } : {}) } }, (res) => {
    let d = ''; res.on('data', (c) => { d += c; }); res.on('end', () => { let json = null; try { json = JSON.parse(d); } catch { /* not json */ } resolve({ status: res.statusCode, body: d, json }); });
  });
  req.on('error', reject);
  req.end(data);
});

// `state` is what the fake client reports; `started: false` leaves the session closed.
async function withServer(fn, { state = 'idle', started = true } = {}) {
  writeConfig();
  const made = [];
  const cur = { state };
  const createClient = (opts) => {
    const c = { opts, reqs: [], start: async () => ({}), request: async (type, fields) => { c.reqs.push([type, fields]); return { disposition: 'started' }; }, answerDialog: () => false, pendingDialogs: () => [], state: () => cur.state, close() {} };
    made.push(c);
    return c;
  };
  const host = createRpcHost({ resolve: async () => ({ active: ACTIVE }), repoOf: findRepo, publish() {}, createClient });
  if (started) await host.start(ID);
  const port = await freePort();
  let t = 1_000_000;
  // The providers go through `cfg` so a test can swap them after the server is up.
  const cfg = { requirements: NEVER, prs };
  const deps = { noSummaryStore: true, rpcHost: host, wait: NEVER, requirements: (...a) => cfg.requirements(...a), prs: (...a) => cfg.prs(...a), guard: pi.sendGuard(() => t) };
  const server = createServer(port, deps);
  await new Promise((r) => server.listen(port, '127.0.0.1', r));
  try {
    const token = /name="?token"? content="([0-9a-f]+)"/.exec((await call(port, 'GET', '/')).body)[1];
    const prompts = () => made.flatMap((c) => c.reqs).filter(([type]) => type === 'prompt').map(([, f]) => f.message);
    return await fn({
      post: (p, body, withToken = true) => call(port, 'POST', p, { token: withToken ? token : undefined, body }),
      get: (p) => call(port, 'GET', p, { token }),
      cur, prompts, cfg, host, tick: (ms) => { t += ms; },
    });
  } finally { await new Promise((r) => server.close(r)); }
}
const pre = (post, command, extra = {}) => post('/api/pi', { id: ID, command, ...extra });

// RP176: the ship keys go out like the others; the old commit keys keep going out unchanged.
const TEXTS = { 'flow-ship': '/flow-ship', 'flow-ship-unstage': '/flow-ship --unstage', 'flow-commit': '/flow-commit', 'flow-commit-unstage': '/flow-commit --unstage', 'flow-pr': '/flow-pr', 'flow-base': '/flow-base', 'flow-base-stash': '/flow-base --stash', 'flow-next': '/flow-next' };

test('s1: each fixed key goes to the session as the exact text of its command, through rpcHost.prompt, with the answer the page reads', async () => {
  for (const [key, text] of Object.entries(TEXTS)) {
    await withServer(async ({ post, prompts }) => {
      const r = await pre(post, key);
      assert.deepEqual([r.status, r.json], [200, { sent: true, confirmed: true }], key);
      assert.deepEqual(prompts(), [text], key);
    });
  }
});

test('s2: put-in-conditions sends the order built from the requirements, and fix-pr the order built from its PR', async () => {
  await withServer(async ({ post, prompts, cfg }) => {
    cfg.requirements = reqs;
    assert.equal((await pre(post, 'put-in-conditions')).status, 200);
    assert.equal((await pre(post, 'fix-pr', { pr: 7 })).status, 200);
    assert.deepEqual(prompts(), [pi.conditionsOrder((await reqs()).results), pi.fixPrOrder(failing)]);
  });
});

test('s3: the requirements check and the PR lookup still refuse before anything is sent', async () => {
  await withServer(async ({ post, prompts, cfg }) => {
    cfg.requirements = async () => ({ available: true, results: [{ id: 'a', status: 'pass', level: 'required' }] });
    const none = await pre(post, 'put-in-conditions');
    assert.deepEqual([none.status, /nothing to do/i.test(none.json.error)], [409, true]);
    cfg.prs = async () => ({ repo: {}, prs: [{ ...failing, checks: { state: 'passed', items: [] } }] });
    assert.equal((await pre(post, 'fix-pr', { pr: 7 })).status, 409);
    assert.equal((await pre(post, 'fix-pr')).status, 400);
    assert.deepEqual(prompts(), []);
  });
});

test('s4: the three states that cannot take a command are refused with a fixed message and nothing is sent', async () => {
  const cases = [
    [{ started: false }, 'The session is not started'],
    [{ state: 'busy' }, 'The session is busy'],
    [{ state: 'starting' }, 'The session is busy'],
    [{ state: 'asking' }, 'The session is waiting for an answer'],
  ];
  for (const [opts, message] of cases) {
    await withServer(async ({ post, prompts }) => {
      const r = await pre(post, 'flow-commit');
      assert.deepEqual([r.status, r.json.error], [409, message]);
      assert.deepEqual(prompts(), []);
    }, opts);
  }
});

test('s5: the duplicate guard still refuses the same key for 45 s, other keys go, and a refusal arms nothing', async () => {
  await withServer(async ({ post, prompts, tick, cur }) => {
    assert.equal((await pre(post, 'flow-pr')).status, 200);
    tick(7000);
    const again = await pre(post, 'flow-pr');
    assert.deepEqual([again.status, again.json.error], [409, 'That command was already sent 7 s ago; wait for it to finish']);
    assert.equal((await pre(post, 'flow-commit')).status, 200);
    assert.deepEqual(prompts(), ['/flow-pr', '/flow-commit']);
    cur.state = 'busy';
    tick(60000);
    assert.equal((await pre(post, 'flow-base')).status, 409); // busy: refused, and it did not arm the guard
    cur.state = 'idle';
    assert.equal((await pre(post, 'flow-base')).status, 200);
    tick(46000);
    assert.equal((await pre(post, 'flow-pr')).status, 200);
  });
});

test('s6: an unknown key, a bad body and a bad repo keep their old answers', async () => {
  await withServer(async ({ post, prompts }) => {
    for (const c of ['rm -rf', '/flow-commit', 'constructor', '__proto__', 'flow-commit --unstage']) {
      const r = await pre(post, c);
      assert.deepEqual([r.status, r.json.error], [400, 'Unknown command'], c);
    }
    assert.equal((await post('/api/pi', { id: ID })).status, 400);
    assert.equal((await post('/api/pi', { id: 'nope', command: 'flow-commit' })).status, 404);
    assert.equal((await post('/api/pi', { id: ID, command: 'flow-commit' }, false)).status, 401);
    assert.deepEqual(prompts(), []);
  });
});

test('s7: a failure of the prompt answers a fixed message and does not arm the duplicate guard', async () => {
  await withServer(async ({ post, prompts, host }) => {
    const ok = host.prompt;
    host.prompt = async () => { throw new Error('C:\\secret\\path exploded'); };
    const bad = await pre(post, 'flow-pr');
    assert.equal(bad.status >= 400, true);
    assert.doesNotMatch(bad.body, /secret/);
    host.prompt = ok;
    assert.equal((await pre(post, 'flow-pr')).status, 200);
    assert.deepEqual(prompts(), ['/flow-pr']);
  });
});

test('s8: GET /api/pi-status maps the five session states, ignores tail and fresh', async () => {
  const want = { closed: 'closed', starting: 'busy', idle: 'idle', busy: 'busy', asking: 'asking' };
  for (const [state, answer] of Object.entries(want)) {
    await withServer(async ({ get }) => {
      for (const q of ['', '&tail=1', '&fresh=1', '&tail=1&fresh=1']) {
        const r = await get(`/api/pi-status?id=${ID}${q}`);
        assert.deepEqual([r.status, r.json], [200, { state: answer }], `${state}${q}`);
      }
    }, { state });
  }
  await withServer(async ({ get }) => {
    assert.deepEqual((await get(`/api/pi-status?id=${ID}`)).json, { state: 'closed' });
    assert.equal((await get('/api/pi-status?id=nope')).status, 404);
  }, { started: false });
});

