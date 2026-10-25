'use strict';
// RP18 server side of POST /api/pi and GET /api/pi-status: the unstage key, the duplicate-send guard, the screen
// tail, and the "keep the index empty" sentence of the orders.
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
const { piSend, piStatus, fixPrOrder, conditionsOrder, sendGuard } = require('../server/pi.js');

test.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 }));

const IDLE_PI = '▎ ✿ waiting for input\n▎   type, or / for commands\n▎\n';
const BUSY_PI = '$ sleep 20 (timeout 30s)\nElapsed 7.2s\n▎ ❁ working…\n▎   type, or / for commands\n▎\n';
const piTerm = (o = {}) => ({ handle: 'h1', title: 'Terminal 1', worktreePath: 'C:/dev/repo', connected: true, writable: true, ...o });
function fakeOrca({ terminals = [piTerm()], previews = [IDLE_PI, IDLE_PI, 'working'] } = {}) {
  const calls = [];
  let n = 0;
  const orca = async (args) => {
    calls.push(args);
    if (args[0] === 'list') return { terminals };
    if (args[0] === 'show') return { terminal: { preview: previews[Math.min(n++, previews.length - 1)] } };
    return { send: { accepted: true } };
  };
  return { orca, calls, sends: () => calls.filter((c) => c[0] === 'send') };
}
const REPO = { path: REPO_PATH };
const noWait = async () => {};
const NEVER = async () => { throw new Error('must not be read'); };
const refuses = (p, status, re) => assert.rejects(p, (e) => e.status === status && re.test(e.message));
const failing = { number: 7, title: 'Fix the thing', head: 'task', base: 'main', checks: { state: 'failed', items: [{ name: 'test', state: 'failed' }] } };
const prs = async () => ({ repo: {}, prs: [failing] });

// ---------- the new fixed command ----------
test('flow-commit-unstage: piSend types exactly /flow-commit --unstage into the one idle session', async () => {
  const f = fakeOrca();
  assert.deepEqual(await piSend(REPO, 'flow-commit-unstage', f.orca, noWait), { sent: true, confirmed: true });
  assert.deepEqual(f.sends(), [['send', '--terminal', 'h1', '--text', '/flow-commit --unstage', '--enter']]);
});

test('flow-commit-unstage: keeps the session safeguards and sends nothing when they refuse', async () => {
  for (const [opts, re] of [
    [{ terminals: [] }, /No open pi session/],
    [{ terminals: [piTerm(), piTerm({ handle: 'h2' })] }, /Several pi sessions/],
    [{ previews: [BUSY_PI] }, /busy or has text typed/],
  ]) {
    const f = fakeOrca(opts);
    await refuses(piSend(REPO, 'flow-commit-unstage', f.orca, noWait), 409, re);
    assert.equal(f.sends().length, 0);
  }
});

test('flow-commit: still types /flow-commit and the near-miss keys stay unknown', async () => {
  const f = fakeOrca();
  await piSend(REPO, 'flow-commit', f.orca, noWait);
  assert.deepEqual(f.sends().map((c) => c[4]), ['/flow-commit']);
  for (const c of ['flow-commit --unstage', 'flow-commit-unstage ', 'FLOW-COMMIT-UNSTAGE', '/flow-commit --unstage', 'flow-commit-unstage2']) {
    await refuses(piSend(REPO, c, fakeOrca().orca, noWait), 400, /Unknown command/);
  }
});

// ---------- the duplicate-send guard ----------
test('guard: the same key for the same repo is refused for 45 s after a confirmed send, other keys are not', async () => {
  let t = 1_000_000;
  const guard = sendGuard(() => t);
  const send = (key, o = fakeOrca(), extra = {}) => piSend(REPO, key, o.orca, noWait, NEVER, { guard, ...extra });
  assert.equal((await send('flow-pr')).sent, true);
  t += 7000;
  const again = fakeOrca();
  await refuses(send('flow-pr', again), 409, /^That command was already sent 7 s ago; wait for it to finish$/);
  assert.equal(again.sends().length, 0);
  assert.equal((await send('flow-commit')).sent, true); // a different key
  assert.equal((await piSend({ path: 'C:\\dev\\other' }, 'flow-pr', fakeOrca({ terminals: [piTerm({ worktreePath: 'C:/dev/other' })] }).orca, noWait, NEVER, { guard })).sent, true); // another repo
  t += 38_000; // 45 s after the first send
  assert.equal((await send('flow-pr')).sent, true);
});

test('guard: fix-pr and put-in-conditions are covered, and an unconfirmed send does not arm it', async () => {
  let t = 5_000_000;
  const guard = sendGuard(() => t);
  const reqs = async () => ({ available: true, results: [{ id: 'a', status: 'fail', level: 'required' }] });
  await piSend(REPO, 'fix-pr', fakeOrca().orca, noWait, NEVER, { guard, pr: 7, prs });
  await refuses(piSend(REPO, 'fix-pr', fakeOrca().orca, noWait, NEVER, { guard, pr: 7, prs }), 409, /already sent/);
  await piSend(REPO, 'put-in-conditions', fakeOrca().orca, noWait, reqs, { guard });
  await refuses(piSend(REPO, 'put-in-conditions', fakeOrca().orca, noWait, reqs, { guard }), 409, /already sent/);
  const unconfirmed = fakeOrca({ previews: [IDLE_PI] });
  assert.equal((await piSend(REPO, 'flow-base', unconfirmed.orca, noWait, NEVER, { guard })).confirmed, false);
  assert.equal((await piSend(REPO, 'flow-base', fakeOrca().orca, noWait, NEVER, { guard })).confirmed, true);
});

test('guard: the busy, typed, missing-session and unknown-key refusals keep their messages and win over it', async () => {
  const guard = sendGuard(() => 9_000_000);
  await piSend(REPO, 'flow-pr', fakeOrca().orca, noWait, NEVER, { guard });
  await refuses(piSend(REPO, 'flow-pr', fakeOrca({ previews: [BUSY_PI] }).orca, noWait, NEVER, { guard }), 409, /^The pi session is busy or has text typed in its prompt$/);
  await refuses(piSend(REPO, 'flow-pr', fakeOrca({ terminals: [] }).orca, noWait, NEVER, { guard }), 409, /^No open pi session found for this repo in Orca$/);
  await refuses(piSend(REPO, 'nope', fakeOrca().orca, noWait, NEVER, { guard }), 400, /^Unknown command$/);
});

test('guard: piSend without a guard behaves as before (repeat sends are not refused)', async () => {
  await piSend(REPO, 'flow-pr', fakeOrca().orca, noWait);
  assert.equal((await piSend(REPO, 'flow-pr', fakeOrca().orca, noWait)).sent, true);
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

test('POST /api/pi: flow-commit-unstage goes through the route, and the second send of a key is refused with 409', async () => {
  let t = 2_000_000;
  let f = fakeOrca();
  await withServer({ orca: (args) => f.orca(args), wait: noWait, requirements: NEVER, prs, guard: sendGuard(() => t) }, async ({ post }) => {
    const ok = await post('/api/pi', { id: ID, command: 'flow-commit-unstage' });
    assert.deepEqual([ok.status, ok.json], [200, { sent: true, confirmed: true }]);
    assert.deepEqual(f.sends(), [['send', '--terminal', 'h1', '--text', '/flow-commit --unstage', '--enter']]);
    f = fakeOrca();
    t += 3000;
    const dup = await post('/api/pi', { id: ID, command: 'flow-commit-unstage' });
    assert.deepEqual([dup.status, dup.json.error], [409, 'That command was already sent 3 s ago; wait for it to finish']);
    assert.equal(f.sends().length, 0);
    assert.equal((await post('/api/pi', { id: ID, command: 'flow-commit-unstage' }, false)).status, 401);
    assert.equal((await post('/api/pi', { id: 'nope', command: 'flow-commit-unstage' })).status, 404);
    assert.equal((await post('/api/pi', { id: ID, command: 'flow-commit --unstage' })).status, 400);
  });
});

test('POST /api/pi: each server keeps its own guard, so a second server starts with a clean slate', async () => {
  for (let i = 0; i < 2; i++) {
    const f = fakeOrca();
    await withServer({ orca: (args) => f.orca(args), wait: noWait, requirements: NEVER, prs }, async ({ post }) => {
      assert.equal((await post('/api/pi', { id: ID, command: 'flow-pr' })).status, 200);
    });
  }
});

// ---------- the screen tail ----------
const screen = (above, bars = IDLE_PI, footer = '  ~/repo  main  42%\n') => `${above}${bars}${footer}`;

test('piStatus: without tail the answer is exactly { state }', async () => {
  assert.deepEqual(await piStatus(REPO, fakeOrca({ previews: [screen('boom\n')] }).orca), { state: 'idle' });
  assert.deepEqual(await piStatus(REPO, fakeOrca({ previews: [screen('boom\n')] }).orca, { tail: false }), { state: 'idle' });
});

test('piStatus tail: the last 6 non-empty lines above the prompt bars, without the bars or the footer', async () => {
  const above = Array.from({ length: 9 }, (_, i) => `line ${i + 1}`).join('\n\n') + '\n\n';
  const s = await piStatus(REPO, fakeOrca({ previews: [screen(above)] }).orca, { tail: true });
  assert.equal(s.state, 'idle');
  assert.equal(s.tail, 'line 4\nline 5\nline 6\nline 7\nline 8\nline 9');
  const busy = await piStatus(REPO, fakeOrca({ previews: [screen('Index is not empty: run git reset\n', BUSY_PI.slice(BUSY_PI.indexOf('▎')))] }).orca, { tail: true });
  assert.equal(busy.state, 'busy');
  assert.equal(busy.tail, 'Index is not empty: run git reset');
});

test('piStatus tail: control characters become spaces, a line is capped at 200 and the whole at 800', async () => {
  const messy = await piStatus(REPO, fakeOrca({ previews: [screen('a\x07b\x1b[31mc\td\n')] }).orca, { tail: true });
  assert.equal(/[\x00-\x1f\x7f]/.test(messy.tail), false);
  assert.equal(messy.tail, 'a b [31mc d');
  const long = await piStatus(REPO, fakeOrca({ previews: [screen(`${'x'.repeat(500)}\n`)] }).orca, { tail: true });
  assert.equal(long.tail.length, 200);
  const many = Array.from({ length: 6 }, (_, i) => `${i}${'y'.repeat(199)}`).join('\n') + '\n';
  const capped = await piStatus(REPO, fakeOrca({ previews: [screen(many)] }).orca, { tail: true });
  assert.equal(capped.tail.length, 800);
});

test('piStatus tail: an unreadable screen, no session or an Orca failure give an empty tail and the usual state', async () => {
  assert.deepEqual(await piStatus(REPO, fakeOrca({ previews: [IDLE_PI] }).orca, { tail: true }), { state: 'idle', tail: '' });
  assert.deepEqual(await piStatus(REPO, fakeOrca({ terminals: [] }).orca, { tail: true }), { state: 'closed', tail: '' });
  assert.deepEqual(await piStatus(REPO, fakeOrca({ terminals: [piTerm(), piTerm({ handle: 'h2' })] }).orca, { tail: true }), { state: 'ambiguous', tail: '' });
  const boom = async () => { throw new Error('Orca CLI is unavailable'); };
  assert.deepEqual(await piStatus(REPO, boom, { tail: true }), { state: 'unknown', tail: '' });
});

test('GET /api/pi-status: tail=1 adds the tail, no flag leaves the answer as before, and the token and 404 still apply', async () => {
  const f = fakeOrca({ previews: [screen('Index is not empty\n')] });
  await withServer({ orca: (args) => f.orca(args) }, async ({ get }) => {
    assert.equal((await get(`/api/pi-status?id=${ID}&tail=1`, false)).status, 401);
    assert.equal((await get('/api/pi-status?id=nope&tail=1')).status, 404);
    assert.equal((await get('/api/pi-status?tail=1')).status, 404);
    assert.equal((await get(`/api/pi-status?id=${ID}`)).raw, '{"state":"idle"}');
    assert.equal((await get(`/api/pi-status?id=${ID}&tail=0`)).raw, '{"state":"idle"}');
    assert.equal((await get(`/api/pi-status?id=${ID}&tail=1`)).raw, '{"state":"idle","tail":"Index is not empty"}');
  });
});

// ---------- the orders keep the index empty ----------
const RULE = 'Never use git mv or git add; keep the git index empty (/flow-commit refuses to start with staged files).';

test('orders: fix-pr and put-in-conditions both ask for an empty index, stay one line and do not start with /', () => {
  const fix = fixPrOrder(failing);
  const put = conditionsOrder([{ id: 'agents-file', status: 'fail', level: 'required' }]);
  for (const text of [fix, put]) {
    assert.ok(text.includes(RULE), text);
    assert.equal(/[\x00-\x1f\x7f]/.test(text), false);
    assert.equal(text.startsWith('/'), false);
  }
  assert.ok(put.startsWith('Put this repo in conditions for repo-panel: read "'));
  assert.match(put, /apply these requirement ids: agents-file\./);
});

test('orders: fix-pr stays under 1500 characters for 5 names and a 120-character title, with the new sentence', () => {
  const big = { ...failing, title: 'T'.repeat(200), head: 'h'.repeat(200), checks: { state: 'failed', items: Array.from({ length: 9 }, (_, i) => ({ name: `job ${i} ${'n'.repeat(70)}`, state: 'failed' })) } };
  const text = fixPrOrder(big);
  assert.ok(text.includes(RULE));
  assert.ok(text.length < 1500, String(text.length));
});
