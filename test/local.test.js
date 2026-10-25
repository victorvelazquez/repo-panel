'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { localState } = require('../server/local.js');

const sh = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'core.editor=true', ...args], { cwd, encoding: 'utf8', stdio: 'pipe' }).trim();
const tryGit = (cwd, ...args) => { try { sh(cwd, ...args); } catch { /* a conflict makes git exit non-zero: that is the scenario */ } };

// Every folder is removed when the file's tests finish, so a run leaves nothing in the temp dir.
const dirs = [];
test.after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true, maxRetries: 5 }); });
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-panel-local-')); dirs.push(d); return d; };

function repo() {
  const dir = tmp();
  sh(dir, 'init', '-q', '-b', 'main');
  return dir;
}
function commit(dir, name, text, msg = 'c') {
  fs.writeFileSync(path.join(dir, name), text);
  sh(dir, 'add', '-A');
  sh(dir, 'commit', '-q', '-m', msg);
}
const at = (dir) => localState({ path: dir });

test('localState: a clean repo reports the full HEAD sha, no operation in progress and the base branch', async () => {
  const dir = repo();
  commit(dir, 'a.txt', 'a\n');
  const l = await at(dir);
  assert.equal(l.head, sh(dir, 'rev-parse', 'HEAD'));
  assert.match(l.head, /^[0-9a-f]{40,64}$/);
  assert.equal(l.inProgress, null);
  assert.equal(l.base, 'main');
});

test('localState: the configured base wins for the base field', async () => {
  const dir = repo();
  commit(dir, 'a.txt', 'a\n');
  assert.equal((await localState({ path: dir, base: 'develop' })).base, 'develop');
});

test('localState: an unborn branch has head null and no operation in progress', async () => {
  const dir = repo();
  const l = await at(dir);
  assert.equal(l.head, null);
  assert.equal(l.inProgress, null);
  assert.equal(l.error, undefined);
});

test('localState: a real merge conflict reports inProgress merge', async () => {
  const dir = repo();
  commit(dir, 'a.txt', 'base\n');
  sh(dir, 'checkout', '-q', '-b', 'topic');
  commit(dir, 'a.txt', 'topic\n');
  sh(dir, 'checkout', '-q', 'main');
  commit(dir, 'a.txt', 'main\n');
  tryGit(dir, 'merge', 'topic');
  const l = await at(dir);
  assert.equal(l.inProgress, 'merge');
  assert.ok(l.files.some((f) => f.conflict));
});

test('localState: a real rebase conflict reports inProgress rebase', async () => {
  const dir = repo();
  commit(dir, 'a.txt', 'base\n');
  sh(dir, 'checkout', '-q', '-b', 'topic');
  commit(dir, 'a.txt', 'topic\n');
  sh(dir, 'checkout', '-q', 'main');
  commit(dir, 'a.txt', 'main\n');
  sh(dir, 'checkout', '-q', 'topic');
  tryGit(dir, 'rebase', 'main');
  const l = await at(dir);
  assert.equal(l.inProgress, 'rebase');
  assert.equal(l.detached, true);
});

test('localState: a real cherry-pick conflict reports inProgress cherry-pick', async () => {
  const dir = repo();
  commit(dir, 'a.txt', 'base\n');
  sh(dir, 'checkout', '-q', '-b', 'topic');
  commit(dir, 'a.txt', 'topic\n');
  const pick = sh(dir, 'rev-parse', 'HEAD');
  sh(dir, 'checkout', '-q', 'main');
  commit(dir, 'a.txt', 'main\n');
  tryGit(dir, 'cherry-pick', pick);
  assert.equal((await at(dir)).inProgress, 'cherry-pick');
});

test('localState: a linked worktree resolves its own git dir', async () => {
  const dir = repo();
  commit(dir, 'a.txt', 'base\n');
  sh(dir, 'checkout', '-q', '-b', 'topic');
  commit(dir, 'a.txt', 'topic\n');
  sh(dir, 'checkout', '-q', 'main');
  commit(dir, 'a.txt', 'main\n');
  const wt = path.join(tmp(), 'wt');
  sh(dir, 'worktree', 'add', '-q', '-b', 'wt-branch', wt, 'main');
  tryGit(wt, 'merge', 'topic');
  assert.equal((await at(wt)).inProgress, 'merge');
  assert.equal((await at(dir)).inProgress, null);
});

test('localState: failing git for the new facts never throws and leaves the rest of the answer alone', async () => {
  const dir = repo();
  commit(dir, 'a.txt', 'a\n');
  const real = await at(dir);
  const { git } = require('../server/exec.js');
  const flaky = async (cwd, args) => {
    if (args[0] === 'rev-parse') throw new Error('boom');
    return git(cwd, args);
  };
  const l = await localState({ path: dir }, { git: flaky });
  assert.equal(l.head, null);
  assert.equal(l.inProgress, null);
  const { head, inProgress, base, ...rest } = l;
  const { head: h2, inProgress: i2, base: b2, ...realRest } = real;
  assert.deepEqual(rest, realRest);
});

test('localState: the existing fields keep their shape (branch, files, ahead, behind, upstream)', async () => {
  const dir = repo();
  commit(dir, 'a.txt', 'a\n');
  fs.writeFileSync(path.join(dir, 'new.txt'), 'x\ny\n');
  const l = await at(dir);
  assert.equal(l.branch, 'main');
  assert.equal(l.detached, false);
  assert.equal(l.noUpstream, true);
  assert.deepEqual(l.files.map((f) => [f.path, f.untracked, f.added]), [['new.txt', true, 2]]);
  assert.deepEqual(Object.keys(l).sort(), ['added', 'ahead', 'base', 'behind', 'branch', 'currentGone', 'deleted', 'detached', 'files', 'goneBranches', 'head', 'inProgress', 'noUpstream', 'stagedCount', 'stagedPaths', 'upstream'].sort());
  assert.deepEqual(await localState({ path: path.join(dir, 'missing') }), { error: 'Folder not found' });
});

// ---------- RP18: files staged in the index ----------
test('localState: staged renames and edits count once each; untracked and unstaged edits do not', async () => {
  const dir = repo();
  commit(dir, 'a.txt', 'a\n'.repeat(5));
  commit(dir, 'b.txt', 'b\n');
  commit(dir, 'c.txt', 'c\n');
  const clean = await at(dir);
  assert.deepEqual([clean.stagedCount, clean.stagedPaths], [0, []]);
  sh(dir, 'mv', 'a.txt', 'z.txt'); // a rename in the index
  fs.writeFileSync(path.join(dir, 'b.txt'), 'b2\n'); // edited, not staged
  fs.writeFileSync(path.join(dir, 'new.txt'), 'n\n'); // untracked
  const l = await at(dir);
  assert.equal(l.stagedCount, 1);
  assert.deepEqual(l.stagedPaths, ['z.txt']);
  assert.equal(l.files.length, 3);
  fs.writeFileSync(path.join(dir, 'c.txt'), 'c2\n');
  sh(dir, 'add', 'c.txt');
  fs.writeFileSync(path.join(dir, 'c.txt'), 'c3\n'); // staged and then edited again: still one path
  const both = await at(dir);
  assert.equal(both.stagedCount, 2);
  assert.deepEqual(both.stagedPaths, ['c.txt', 'z.txt']);
});

test('localState: stagedPaths is sorted and capped at 20 while stagedCount counts them all', async () => {
  const dir = repo();
  commit(dir, 'seed.txt', 's\n');
  for (let i = 25; i >= 1; i--) fs.writeFileSync(path.join(dir, `f${String(i).padStart(2, '0')}.txt`), `${i}\n`);
  sh(dir, 'add', '-A');
  const l = await at(dir);
  assert.equal(l.stagedCount, 25);
  assert.equal(l.stagedPaths.length, 20);
  assert.deepEqual(l.stagedPaths, [...l.stagedPaths].sort());
  assert.equal(l.stagedPaths[0], 'f01.txt');
});

test('localState: a git status failure still answers the same error, and a failing diff never hides the staged facts', async () => {
  const dir = repo();
  commit(dir, 'a.txt', 'a\n');
  const { git } = require('../server/exec.js');
  const noStatus = async (cwd, args) => (args[0] === 'status' ? { code: 128, stdout: '', stderr: 'fatal: nope\n' } : git(cwd, args));
  assert.deepEqual(await localState({ path: dir }, { git: noStatus }), { error: 'fatal: nope' });
  sh(dir, 'mv', 'a.txt', 'b.txt');
  const noDiff = async (cwd, args) => (args[0] === 'diff' ? { code: 129, stdout: '', stderr: 'boom' } : git(cwd, args));
  const l = await localState({ path: dir }, { git: noDiff });
  assert.deepEqual([l.stagedCount, l.stagedPaths], [1, ['b.txt']]);
});
