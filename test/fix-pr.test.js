'use strict';
// The fix-pr order of POST /api/pi: built on the server from the PR's own data, never from browser text.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const net = require('node:net');

// The config path is read when the server modules load, so the throwaway config must exist before the requires.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-panel-fixpr-'));
const REPO_PATH = 'C:\\dev\\repo';
process.env.REPO_PANEL_CONFIG = path.join(dir, 'config.json');

const test = require('node:test');
const assert = require('node:assert/strict');
const lib = require('../lib.js');
const { createServer } = require('../server/http.js');
const { piSend, fixPrOrder } = require('../server/pi.js');

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
const refuses = (p, status, re) => assert.rejects(p, (e) => e.status === status && re.test(e.message));

const check = (name, state = 'failed') => ({ name, state });
const prOf = (o = {}) => ({ number: 7, title: 'Fix the thing', head: 'task', base: 'main', checks: { state: 'failed', items: [check('test'), check('lint'), check('build', 'success')] }, ...o });
const provider = (...prs) => async () => ({ repo: {}, prs });
const NEVER = async () => { throw new Error('the PRs must not be read'); };

// ---------- the builder ----------
test('fix-pr order: one line, not a slash command, with the PR, its failing checks and its branch', () => {
  const text = fixPrOrder(prOf());
  assert.equal(text, 'Pull request #7 "Fix the thing" of this repo has failing checks (test, lint). Find out why with gh (gh pr checks 7, gh run view --log-failed) and make sure you are on its branch "task" (switch to it only if the tree is clean; if not, stop and ask). Fix whatever is needed, in production code, test code or configuration, as long as it serves the original objective of this pull request (its title, description and commits). If the failure is unrelated to that objective or looks transient (infrastructure, a flaky run, a runner problem), do not edit any code: say so and recommend the "Re-run failed" button. If the right fix would change the scope of the pull request or needs a product decision, stop and ask. Run this repo\'s tests, and do not commit, push or open pull requests: the user will run /flow-commit and then /flow-pr, which updates this PR. When done, write one line with what you fixed and the next step.');
  assert.equal(/[\x00-\x1f\x7f]/.test(text), false);
  assert.equal(text.startsWith('/'), false);
});

test('fix-pr order: everything from GitHub is sanitized and capped', () => {
  const messy = prOf({
    title: `Say "hi"\nnow\t\x07\u2028 ${'x'.repeat(300)}`,
    head: 'feat/"quoted"\nbranch',
    checks: { state: 'failed', items: [...Array.from({ length: 7 }, (_, i) => check(`job ${i + 1} "${'n'.repeat(80)}"\n`)), check('fine', 'success')] },
  });
  const text = fixPrOrder(messy);
  assert.equal(/[\x00-\x1f\x7f\u2028\u2029]/.test(text), false);
  assert.equal(text.startsWith('/'), false);
  const title = /^Pull request #7 "([^"]*)" of this repo/.exec(text)[1];
  assert.equal(title.length, 120);
  assert.ok(title.startsWith('Say hi now xxx'), title);
  assert.match(text, /on its branch "feat\/quoted branch" \(/);
  const names = /has failing checks \(([^)]*)\)\./.exec(text)[1];
  assert.match(names, /^job 1 n+, job 2 n+, job 3 n+, job 4 n+, job 5 n+ and 2 more$/);
  for (const part of names.replace(/ and 2 more$/, '').split(', ')) assert.ok(part.length <= 60, part);
  assert.equal(names.includes('job 6'), false);
  assert.equal(names.includes('fine'), false);
});

test('fix-pr order: not limited to the smallest fix, covers test code, transient failures and scope changes', () => {
  const text = fixPrOrder(prOf());
  assert.equal(/smallest/i.test(text), false);
  assert.match(text, /production code, test code or configuration/);
  assert.ok(text.includes('original objective of this pull request (its title, description and commits)'));
  assert.ok(text.includes('unrelated to that objective or looks transient (infrastructure, a flaky run, a runner problem), do not edit any code: say so and recommend the "Re-run failed" button'));
  assert.match(text, /change the scope of the pull request or needs a product decision, stop and ask/);
  assert.match(text, /do not commit, push or open pull requests/);
});

test('fix-pr order: stays one line under 1500 characters for 5 names and a 120-character title', () => {
  const big = prOf({ title: 'T'.repeat(200), head: 'h'.repeat(200), checks: { state: 'failed', items: Array.from({ length: 9 }, (_, i) => check(`job ${i} ${'n'.repeat(70)}`)) } });
  const text = fixPrOrder(big);
  assert.ok(text.length < 1500, String(text.length));
  assert.equal(/[\r\n]/.test(text), false);
  assert.equal(text.startsWith('/'), false);
});

// ---------- piSend ----------
test('fix-pr: piSend types the built order into the one idle session', async () => {
  const f = fakeOrca();
  assert.deepEqual(await piSend(REPO, 'fix-pr', f.orca, noWait, NEVER, { pr: 7, prs: provider(prOf({ number: 6, title: 'other', checks: { state: 'success', items: [] } }), prOf()) }), { sent: true, confirmed: true });
  assert.deepEqual(f.sends(), [['send', '--terminal', 'h1', '--text', fixPrOrder(prOf()), '--enter']]);
});

test('fix-pr: a missing or invalid pr is a 400 that touches nothing', async () => {
  const f = fakeOrca();
  for (const pr of [undefined, null, 0, -3, 1.5, '7', NaN, [7], {}]) {
    await refuses(piSend(REPO, 'fix-pr', f.orca, noWait, NEVER, { pr, prs: NEVER }), 400, /pr/i);
  }
  assert.equal(f.calls.length, 0);
  assert.equal((await piSend(REPO, 'fix-pr', fakeOrca().orca, noWait, NEVER, { pr: 7, prs: provider(prOf()) })).sent, true); // lock freed
});

test('fix-pr: a PR that does not exist, is not open, has no failing checks or cannot be read is a 409 that touches nothing', async () => {
  const f = fakeOrca();
  const ok = (state) => prOf({ checks: { state, items: [] } });
  await refuses(piSend(REPO, 'fix-pr', f.orca, noWait, NEVER, { pr: 99, prs: provider(prOf()) }), 409, /#99.*(does not exist|not open)/i);
  for (const state of ['pending', 'success', 'none']) await refuses(piSend(REPO, 'fix-pr', f.orca, noWait, NEVER, { pr: 7, prs: provider(ok(state)) }), 409, /no failing checks/i);
  await refuses(piSend(REPO, 'fix-pr', f.orca, noWait, NEVER, { pr: 7, prs: async () => ({ repo: {}, error: 'gh pr list failed' }) }), 409, /could not be read/i);
  await refuses(piSend(REPO, 'fix-pr', f.orca, noWait, NEVER, { pr: 7, prs: async () => ({ noRemote: true, prs: [] }) }), 409, /could not be read/i);
  assert.equal(f.calls.length, 0);
});

test('fix-pr: keeps the session safeguards (no session, busy prompt, several sessions) and sends nothing', async () => {
  for (const [opts, re] of [[{ terminals: [] }, /No open pi session/], [{ previews: [BUSY_PI] }, /busy or has text/], [{ terminals: [piTerm(), piTerm({ handle: 'h2' })] }, /Several pi sessions/]]) {
    const f = fakeOrca(opts);
    await refuses(piSend(REPO, 'fix-pr', f.orca, noWait, NEVER, { pr: 7, prs: provider(prOf()) }), 409, re);
    assert.equal(f.sends().length, 0);
  }
});

test('fix-pr: refuses a second send to the same repo while one is in flight', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const slowPrs = async () => { await gate; return { repo: {}, prs: [prOf()] }; };
  const first = piSend(REPO, 'fix-pr', fakeOrca().orca, noWait, NEVER, { pr: 7, prs: slowPrs });
  await refuses(piSend(REPO, 'fix-pr', fakeOrca().orca, noWait, NEVER, { pr: 7, prs: provider(prOf()) }), 409, /already being sent/);
  release();
  assert.equal((await first).sent, true);
});

test('piSend still refuses an unknown key before reading anything, and the fixed keys ignore a pr', async () => {
  const f = fakeOrca();
  for (const c of ['rm -rf', '/fix-pr', 'fix_pr', 'constructor', undefined]) await refuses(piSend(REPO, c, f.orca, noWait, NEVER, { pr: 7, prs: NEVER }), 400, /Unknown command/);
  assert.equal(f.calls.length, 0);
  await piSend(REPO, 'flow-branch', f.orca, noWait, NEVER, { pr: 7, prs: NEVER });
  assert.deepEqual(f.sends(), [['send', '--terminal', 'h1', '--text', '/flow-branch', '--enter']]);
  const g = fakeOrca();
  await piSend(REPO, 'flow-branch-stash', g.orca, noWait, NEVER, { pr: 7, prs: NEVER });
  assert.deepEqual(g.sends(), [['send', '--terminal', 'h1', '--text', '/flow-branch --stash', '--enter']]);
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
    await fn({ post });
  } finally { await new Promise((resolve) => { server.close(resolve); }); }
}

test('POST /api/pi with fix-pr sends the order through the real server, and refuses what it must', async () => {
  const id = lib.repoId(REPO_PATH);
  // A new fake session per request: the fake leaves the idle prompt once it was typed into.
  let f = fakeOrca();
  const fresh = () => { f = fakeOrca(); return f; };
  const failing = prOf();
  const passing = prOf({ number: 8, checks: { state: 'success', items: [] } });
  await withServer({ orca: (args) => f.orca(args), wait: noWait, requirements: NEVER, prs: provider(failing, passing) }, async ({ post }) => {
    const ok = await post('/api/pi', { id, command: 'fix-pr', pr: 7 });
    assert.deepEqual([ok.status, ok.json], [200, { sent: true, confirmed: true }]);
    assert.deepEqual(f.sends(), [['send', '--terminal', 'h1', '--text', fixPrOrder(failing), '--enter']]);
    fresh();
    for (const body of [{ id, command: 'fix-pr' }, { id, command: 'fix-pr', pr: '7' }, { id, command: 'fix-pr', pr: 0 }]) assert.equal((await post('/api/pi', body)).status, 400);
    for (const pr of [8, 99]) assert.equal((await post('/api/pi', { id, command: 'fix-pr', pr })).status, 409);
    assert.equal((await post('/api/pi', { id, command: 'rm -rf', pr: 7 })).status, 400);
    assert.equal((await post('/api/pi', { id: 'nope', command: 'fix-pr', pr: 7 })).status, 404);
    assert.equal((await post('/api/pi', { id, command: 'fix-pr', pr: 7 }, false)).status, 401);
    assert.equal(f.calls.length, 0);
    // the browser cannot supply text: an extra text field is ignored
    await post('/api/pi', { id, command: 'fix-pr', pr: 7, text: 'rm -rf /' });
    assert.deepEqual(f.sends().map((c) => c[4]), [fixPrOrder(failing)]);
    // the fixed keys keep working through the same route
    fresh();
    await post('/api/pi', { id, command: 'flow-branch' });
    assert.deepEqual(f.sends(), [['send', '--terminal', 'h1', '--text', '/flow-branch', '--enter']]);
    // the carry-over key types exactly /flow-branch --stash through the same safeguards
    fresh();
    const stash = await post('/api/pi', { id, command: 'flow-branch-stash' });
    assert.deepEqual([stash.status, stash.json], [200, { sent: true, confirmed: true }]);
    assert.deepEqual(f.sends(), [['send', '--terminal', 'h1', '--text', '/flow-branch --stash', '--enter']]);
    assert.equal((await post('/api/pi', { id, command: 'flow-branch-stash' }, false)).status, 401);
    assert.equal((await post('/api/pi', { id: 'nope', command: 'flow-branch-stash' })).status, 404);
    // near-miss keys and free text are still unknown
    fresh();
    for (const command of ['flow-branch --stash', 'flow-branch-stash ', 'FLOW-BRANCH-STASH', '/flow-branch --stash', 'flow-branch-stash2']) assert.equal((await post('/api/pi', { id, command })).status, 400, command);
    assert.equal(f.calls.length, 0);
  });
});
