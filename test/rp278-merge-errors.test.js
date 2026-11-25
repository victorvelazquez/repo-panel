'use strict';
// RP278: a merge while GitHub is degraded answers a clear fixed message, never a raw SyntaxError or a 500; every gh call of the merge
// carries its own short bound; an unclear PUT failure re-reads the PR a few times; the wait for a process slot of the merge is bounded
// (503) while every other caller waits as before. gh is injected, never real; the slot tests run only quick local node children.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.REPO_PANEL_MAX_PARALLEL = '1';
const EXEC_PATH = require.resolve('../server/exec.js');
const GITHUB_PATH = require.resolve('../server/github.js');
const exec = require(EXEC_PATH);
const { HttpError } = require('../server/errors.js');

const NO_ANSWER = 'GitHub did not answer in time: check the PR on GitHub before retrying';
const NOT_CONFIRMED = 'GitHub did not confirm the merge: check the PR on GitHub before retrying';
const BUSY = 'The panel is busy with other GitHub and Git work: try the merge again in a minute';
const READ = { timeout: 20000, waitMs: 20000 };
const PUT = { timeout: 30000, waitMs: 20000 };

function loadGithub(ghImpl) {
  const realGh = exec.gh;
  exec.gh = ghImpl;
  delete require.cache[GITHUB_PATH];
  const github = require(GITHUB_PATH);
  return { github, restore: () => { exec.gh = realGh; delete require.cache[GITHUB_PATH]; } };
}

const OPEN = {
  number: 7, title: 't', url: 'u', headRefName: 'task', baseRefName: 'main', headRefOid: 'a'.repeat(40), isDraft: false,
  isCrossRepository: false, mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', reviewDecision: null, statusCheckRollup: [], author: { login: 'x' },
};
const ok = (stdout) => ({ code: 0, stdout, stderr: '' });
const META = ok(JSON.stringify({ nameWithOwner: 'o/r', url: 'https://github.com/o/r', deleteBranchOnMerge: false }));
const prView = (state) => ok(JSON.stringify({ ...OPEN, state }));

// A fake gh: each handler answers one kind of call; `views` is the sequence of `gh pr view` answers (the last one repeats).
function fakeGh({ meta = META, views = [prView('OPEN')], put = ok('{}'), del = ok('') } = {}) {
  const calls = [];
  let v = 0;
  const impl = async (cwd, args, opts) => {
    calls.push({ args: args.join(' '), opts });
    const [a, b] = args;
    const pick = (h) => (typeof h === 'function' ? h() : h);
    if (a === 'repo' && b === 'view') return pick(meta);
    if (a === 'pr' && b === 'view') return pick(views[Math.min(v++, views.length - 1)]);
    if (a === 'api' && args.includes('PUT')) return pick(put);
    if (a === 'api' && args.includes('DELETE')) return pick(del);
    return { code: 1, stdout: '', stderr: `unexpected ${args.join(' ')}` };
  };
  return { impl, calls, kinds: () => calls.map((c) => c.args.split(' ').slice(0, 3).join(' ')) };
}

let n = 0;
async function merge(spec, deleteBranch = false) {
  const g = fakeGh(spec);
  const { github, restore } = loadGithub(g.impl);
  const sleeps = [];
  github.mergeTiming.sleep = async (ms) => { sleeps.push(ms); };
  try {
    const out = await github.mergePr({ id: `rp278-${n++}`, path: __dirname }, 7, 'squash', deleteBranch).then((r) => ({ r }), (e) => ({ e }));
    return { ...out, g, sleeps };
  } finally { restore(); }
}
const rejects = (out, status, message) => {
  assert.equal(out.r, undefined, 'the merge must fail');
  assert.ok(out.e instanceof HttpError, `an HttpError, got ${out.e && out.e.name}: ${out.e && out.e.message}`);
  assert.equal(out.e.status, status);
  assert.equal(out.e.message, message);
};
const PRE = ['repo view --json', 'pr view 7'];
const PUT_KIND = 'api -X PUT';

test('S1: the pre-check pr view exits 0 with empty stdout: 502 with the clear message and no PUT', async () => {
  const out = await merge({ views: [ok('')] });
  rejects(out, 502, NO_ANSWER);
  assert.deepEqual(out.g.kinds(), PRE);
});

test('S1: the pre-check pr view exits non-zero with the Go error: 502 with the clear message and no PUT', async () => {
  const out = await merge({ views: [{ code: 1, stdout: '', stderr: 'unexpected end of JSON input\n' }] });
  rejects(out, 502, NO_ANSWER);
  assert.deepEqual(out.g.kinds(), PRE);
});

test('S1: repo view exits 0 with empty stdout: 502 with the clear message, not a SyntaxError and not a 500', async () => {
  const out = await merge({ meta: ok('') });
  rejects(out, 502, NO_ANSWER);
  assert.deepEqual(out.g.kinds(), ['repo view --json']);
});

test('S1: repo view answers a 5xx of GitHub: 502 with the clear message', async () => {
  const out = await merge({ meta: { code: 1, stdout: '', stderr: 'HTTP 503: Service Unavailable (https://api.github.com/graphql)\n' } });
  rejects(out, 502, NO_ANSWER);
});

test('S1+S3: the PUT answers "Server Error" and the PR stays OPEN: 502 with the clear message after 3 bounded re-reads', async () => {
  const out = await merge({ views: [prView('OPEN')], put: { code: 1, stdout: '{"message":"Server Error"}', stderr: 'gh: Server Error (HTTP 500)\n' } });
  rejects(out, 502, NO_ANSWER);
  assert.deepEqual(out.g.kinds(), [...PRE, PUT_KIND, 'pr view 7', 'pr view 7', 'pr view 7']);
  assert.deepEqual(out.sleeps, [2000, 2000]);
});

test('S1+S3: the PUT killed by its timeout and the re-read sees MERGED on the 2nd try: the usual success', async () => {
  const out = await merge({ views: [prView('OPEN'), { code: -1, stdout: '', stderr: '' }, prView('MERGED')], put: { code: -1, stdout: '', stderr: '' } });
  assert.equal(out.e, undefined, out.e && out.e.message);
  assert.deepEqual(out.r, { merged: true, branch: 'kept' });
  assert.deepEqual(out.g.kinds(), [...PRE, PUT_KIND, 'pr view 7', 'pr view 7']);
  assert.deepEqual(out.sleeps, [2000]);
});

test('S3: the re-read fails every time: 502 "did not confirm" and the gh calls stop (no endless retry)', async () => {
  const out = await merge({ views: [prView('OPEN'), { code: 1, stdout: '', stderr: 'unexpected end of JSON input' }], put: { code: -1, stdout: '', stderr: '' } });
  rejects(out, 502, NOT_CONFIRMED);
  assert.equal(out.g.calls.length, 6, out.g.kinds().join(' | '));
  assert.deepEqual(out.sleeps, [2000, 2000]);
});

test('S3: a re-read that cannot get a slot (503) counts as unreadable', async () => {
  const views = [prView('OPEN'), () => { throw new HttpError(503, BUSY); }];
  const out = await merge({ views, put: { code: -1, stdout: '', stderr: '' } });
  rejects(out, 502, NOT_CONFIRMED);
  assert.equal(out.g.calls.length, 6);
});

test('S1 PRESERVE: a clear refusal (405) still shows its real first line, with the single re-read of today and no wait', async () => {
  const out = await merge({ put: { code: 1, stdout: '{"message":"Head branch was modified. Review and try the merge again.","status":"405"}', stderr: 'gh: Head branch was modified. Review and try the merge again. (HTTP 405)\n' } });
  rejects(out, 502, 'Head branch was modified. Review and try the merge again.');
  assert.deepEqual(out.g.kinds(), [...PRE, PUT_KIND, 'pr view 7']);
  assert.deepEqual(out.sleeps, []);
});

test('S2: every gh call of the merge path carries its own short bound (20 s reads and DELETE, 30 s PUT, 20 s slot wait)', async () => {
  const out = await merge({ views: [prView('OPEN'), { code: 1, stdout: '', stderr: 'HTTP 502' }, prView('MERGED')], put: { code: 1, stdout: '{"message":"Server Error"}', stderr: '' } }, true);
  assert.deepEqual(out.r, { merged: true, branch: 'deleted' });
  assert.deepEqual(out.g.calls.map((c) => [c.args.split(' ').slice(0, 3).join(' '), c.opts]), [
    ['repo view --json', READ], ['pr view 7', READ], [PUT_KIND, PUT], ['pr view 7', READ], ['pr view 7', READ], ['api -X DELETE', READ],
  ]);
});

test('S4: a PUT that cannot get a slot answers 503 with the busy message; a DELETE that cannot keeps the branch and the merge succeeds', async () => {
  const busy = () => { throw new HttpError(503, BUSY); };
  rejects(await merge({ put: busy }), 503, BUSY);
  const out = await merge({ put: () => ok('{}'), views: [prView('OPEN')], del: busy }, true);
  assert.deepEqual(out.r, { merged: true, branch: 'kept' });
});

test('S5: a normal merge makes exactly the same gh calls as before and answers the same', async () => {
  const out = await merge({}, true);
  assert.deepEqual(out.r, { merged: true, branch: 'deleted' });
  assert.deepEqual(out.g.calls.map((c) => c.args), [
    'repo view --json nameWithOwner,url,deleteBranchOnMerge,mergeCommitAllowed,squashMergeAllowed,rebaseMergeAllowed',
    'pr view 7 --json number,title,url,headRefName,baseRefName,headRefOid,isDraft,isCrossRepository,mergeable,mergeStateStatus,reviewDecision,statusCheckRollup,author,additions,deletions,changedFiles,state',
    `api -X PUT repos/o/r/pulls/7/merge -f merge_method=squash -f sha=${'a'.repeat(40)}`,
    'api -X DELETE repos/o/r/git/refs/heads/task',
  ]);
  assert.deepEqual(out.sleeps, []);
});

test('S4 PRESERVE: the PR list and the re-run of failed checks call gh without a slot bound, as before', async () => {
  const g = fakeGh();
  const list = async (cwd, args, opts) => (args[0] === 'pr' && args[1] === 'list' ? (g.calls.push({ args: args.join(' '), opts }), ok('[]')) : g.impl(cwd, args, opts));
  const { github, restore } = loadGithub(list);
  try {
    const r = await github.prState({ id: `rp278-${n++}`, path: __dirname });
    assert.deepEqual(r.prs, []);
    await assert.rejects(github.rerunFailed({ id: `rp278-${n++}`, path: __dirname }, 7), (e) => e.status === 409);
    assert.ok(g.calls.length >= 3);
    for (const c of g.calls) assert.equal(c.opts, undefined, c.args);
  } finally { restore(); }
});

// The slot wait of server/exec.js (one place: REPO_PANEL_MAX_PARALLEL=1; background lane, nothing over the cap).
const node = process.execPath;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rp278-'));
test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
const holdFor = (ms) => exec.run(node, ['-e', `setTimeout(() => {}, ${ms})`], { timeout: 30000 });
const marker = (name) => path.join(dir, name);
const writeMarker = (name) => ['-e', `require('fs').writeFileSync(${JSON.stringify(marker(name))}, '1')`];

test('S4: with every slot busy, a call with waitMs gives up at the bound with 503, leaves the queue and never runs afterwards', async () => {
  const holder = holdFor(800);
  assert.equal(exec.stats().active, 1);
  const t0 = Date.now();
  const late = exec.run(node, writeMarker('late'), { waitMs: 150 });
  assert.equal(exec.stats().waitingBackground, 1);
  await assert.rejects(late, (e) => e instanceof HttpError && e.status === 503 && e.message === BUSY);
  const took = Date.now() - t0;
  assert.ok(took >= 140 && took < 700, `gave up after ${took} ms`);
  assert.equal(exec.stats().waitingBackground, 0, 'it left the queue');
  assert.equal((await holder).code, 0);
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(fs.existsSync(marker('late')), false, 'it never ran');
  assert.deepEqual(exec.stats(), { active: 0, max: 1, waitingBackground: 0, waitingUser: 0 });
});

test('S4 differential: a call without waitMs still waits for a slot as long as it takes, as before', async () => {
  const holder = holdFor(600);
  const t0 = Date.now();
  const r = await exec.run(node, writeMarker('patient'));
  assert.equal(r.code, 0);
  assert.ok(Date.now() - t0 >= 400, 'it waited for the holder');
  assert.equal(fs.existsSync(marker('patient')), true);
  await holder;
});

test('S4: a call that gets a slot before its bound runs normally', async () => {
  const holder = holdFor(200);
  const r = await exec.run(node, writeMarker('inTime'), { waitMs: 10000 });
  assert.equal(r.code, 0);
  assert.equal(fs.existsSync(marker('inTime')), true);
  await holder;
  assert.deepEqual(exec.stats(), { active: 0, max: 1, waitingBackground: 0, waitingUser: 0 });
});
