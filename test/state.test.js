'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { readState } = require('../server/state.js');
const { requirementsFor } = require('../server/requirements.js');

const sh = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8', stdio: 'pipe' }).trim();

// Every folder is removed when the file's tests finish, so a run leaves nothing in the temp dir.
const dirs = [];
test.after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true, maxRetries: 5 }); });
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-panel-state-')); dirs.push(d); return d; };

const NOW = '2026-10-24T12:00:00.000Z';
const GOOD = { state: 'needs-input', next: 'Decide which database to use, then tell the agent.', detail: 'Two options.', at: '2026-10-24T11:59:00Z' };
const NO_GIT = async () => ({ code: 128, stdout: '', stderr: 'not a repo' });
const opts = (extra = {}) => ({ git: NO_GIT, now: () => Date.parse(NOW), ...extra });

// A plain folder with .panel/state.json holding `content` (an object is stringified).
function repoWith(content) {
  const dir = tmp();
  if (content !== undefined) {
    fs.mkdirSync(path.join(dir, '.panel'));
    fs.writeFileSync(path.join(dir, '.panel', 'state.json'), typeof content === 'string' ? content : JSON.stringify(content));
  }
  return { id: 'x', path: dir };
}
const bad = (r, reason) => assert.deepEqual(r, { available: false, state: null, next: null, detail: null, at: null, stale: false, reason });
const plainFs = (extra = {}) => ({
  lstat: async () => ({ isSymbolicLink: () => false, isFile: () => true, isDirectory: () => false, size: 10, mtimeMs: 0 }),
  readFile: async () => JSON.stringify(GOOD),
  ...extra,
});

test('readState: no file, or no .panel folder, is missing', async () => {
  bad(await readState(repoWith(undefined), opts()), 'missing');
  const empty = repoWith(undefined);
  fs.mkdirSync(path.join(empty.path, '.panel'));
  bad(await readState(empty, opts()), 'missing');
  bad(await readState({ id: 'x', path: path.join(tmp(), 'nope') }, opts()), 'missing');
});

test('readState: a valid file is returned with all its fields and is not stale when git has no activity to compare', async () => {
  assert.deepEqual(await readState(repoWith(GOOD), opts()), { available: true, state: 'needs-input', next: GOOD.next, detail: 'Two options.', at: GOOD.at, stale: false, reason: null });
});

test('readState: detail is optional and every one of the five states is accepted', async () => {
  const { detail, ...noDetail } = GOOD;
  assert.equal((await readState(repoWith(noDetail), opts())).detail, null);
  for (const state of ['working', 'needs-input', 'ready-to-commit', 'ready-to-pr', 'blocked']) {
    assert.equal((await readState(repoWith({ ...GOOD, state }), opts())).state, state);
  }
});

test('readState: every invalid shape is invalid, with nothing else exposed', async () => {
  const cases = [
    'not json{', '', '[]', 'null', '"text"', '7',
    { ...GOOD, state: 'done' }, { ...GOOD, state: undefined }, { ...GOOD, state: 3 },
    { ...GOOD, next: 5 }, { ...GOOD, next: undefined }, { ...GOOD, next: 'x'.repeat(301) },
    { ...GOOD, detail: 'x'.repeat(4001) }, { ...GOOD, detail: 4 },
    { ...GOOD, at: 'yesterday' }, { ...GOOD, at: undefined }, { ...GOOD, at: 1729760000 }, { ...GOOD, at: '2026-13-45T99:00:00Z' },
    { ...GOOD, at: '2026-10-24T12:05:01Z' },
  ];
  for (const c of cases) bad(await readState(repoWith(c), opts()), 'invalid');
});

test('readState: the limits are inclusive (300-char next, 4000-char detail, 5 minutes ahead)', async () => {
  const edge = { ...GOOD, next: 'x'.repeat(300), detail: 'y'.repeat(4000), at: '2026-10-24T12:05:00Z' };
  assert.equal((await readState(repoWith(edge), opts())).available, true);
});

test('readState: a file over 64 KB is unsafe and is never parsed', async () => {
  const big = JSON.stringify({ ...GOOD, detail: 'z'.repeat(70 * 1024) });
  bad(await readState(repoWith(big), opts()), 'unsafe');
  bad(await readState(repoWith(' '.repeat(64 * 1024 + 1)), opts()), 'unsafe');
  assert.equal((await readState(repoWith(JSON.stringify(GOOD).padEnd(64 * 1024, ' ')), opts())).available, true);
});

test('readState: the state file being a folder is unsafe', async () => {
  const r = repoWith(undefined);
  fs.mkdirSync(path.join(r.path, '.panel', 'state.json'), { recursive: true });
  bad(await readState(r, opts()), 'unsafe');
});

// Creating a symlink may need privileges on Windows: when the OS forbids it the test is skipped, not passed.
function trySymlink(target, link, type) {
  try { fs.symlinkSync(target, link, type); return true; } catch (e) { return e.code; }
}

test('readState: a symlinked state file is unsafe and is never followed', async (t) => {
  const outside = tmp();
  fs.writeFileSync(path.join(outside, 'real.json'), JSON.stringify(GOOD));
  const file = repoWith(undefined);
  fs.mkdirSync(path.join(file.path, '.panel'));
  const a = trySymlink(path.join(outside, 'real.json'), path.join(file.path, '.panel', 'state.json'), 'file');
  if (a !== true) return t.skip(`this OS does not allow creating a symlink here (${a}); symlink rule not exercised`);
  bad(await readState(file, opts()), 'unsafe');
});

test('readState: a linked .panel folder is unsafe and is never followed', async (t) => {
  const outside = tmp();
  const folder = repoWith(undefined);
  fs.mkdirSync(path.join(outside, 'dir'));
  fs.writeFileSync(path.join(outside, 'dir', 'state.json'), JSON.stringify(GOOD));
  const b = trySymlink(path.join(outside, 'dir'), path.join(folder.path, '.panel'), 'junction');
  if (b !== true) return t.skip(`this OS does not allow creating a folder link here (${b}); folder link rule not exercised`);
  bad(await readState(folder, opts()), 'unsafe');
});

test('readState: a symlink (file or folder) is detected by lstat before any read (injected fs)', async () => {
  for (const link of ['state.json', '.panel']) {
    let reads = 0;
    const fsApi = plainFs({
      lstat: async (p) => ({ isSymbolicLink: () => p.endsWith(link), isFile: () => true, isDirectory: () => false, size: 10 }),
      readFile: async () => { reads++; return JSON.stringify(GOOD); },
    });
    bad(await readState({ id: 'x', path: '/r' }, opts({ fs: fsApi })), 'unsafe');
    assert.equal(reads, 0);
  }
});

test('readState: any other read failure is error and never throws', async () => {
  const busy = Object.assign(new Error('busy'), { code: 'EBUSY' });
  bad(await readState({ id: 'x', path: '/r' }, opts({ fs: plainFs({ readFile: async () => { throw busy; } }) })), 'error');
  const denied = plainFs({ lstat: async () => { throw Object.assign(new Error('denied'), { code: 'EACCES' }); } });
  bad(await readState({ id: 'x', path: '/r' }, opts({ fs: denied })), 'error');
  bad(await readState({ id: 'x', path: '/r' }, opts({ fs: plainFs({ lstat: () => { throw new Error('sync boom'); } }) })), 'error');
  const gitBoom = await readState({ id: 'x', path: '/r' }, opts({ fs: plainFs(), git: () => { throw new Error('git boom'); } }));
  assert.deepEqual([gitBoom.available, gitBoom.stale], [true, false]);
});

// ---------- staleness, against a real git repo ----------
function gitRepo(commitIso) {
  const dir = tmp();
  sh(dir, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'a\n');
  sh(dir, 'add', '-A');
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'c'], { cwd: dir, stdio: 'pipe', env: { ...process.env, GIT_COMMITTER_DATE: commitIso, GIT_AUTHOR_DATE: commitIso } });
  return { id: 'x', path: dir };
}
const writeState = (repo, o) => { fs.mkdirSync(path.join(repo.path, '.panel'), { recursive: true }); fs.writeFileSync(path.join(repo.path, '.panel', 'state.json'), JSON.stringify(o)); };
const realGit = { now: () => Date.parse('2026-10-24T12:00:00Z') };

test('readState: a state older than the HEAD commit is stale, a newer one is fresh', async () => {
  const repo = gitRepo('2026-10-24T11:00:00Z');
  writeState(repo, { ...GOOD, at: '2026-10-24T10:59:00Z' });
  const old = await readState(repo, realGit);
  assert.deepEqual([old.available, old.stale, old.state], [true, true, 'needs-input']);
  writeState(repo, { ...GOOD, at: '2026-10-24T11:01:00Z' });
  assert.equal((await readState(repo, realGit)).stale, false);
});

test('readState: a file modified or created after the state makes it stale, and the state file itself never counts', async () => {
  const repo = gitRepo('2026-10-24T08:00:00Z');
  writeState(repo, { ...GOOD, at: '2026-10-24T11:59:00Z' });
  const mtime = (f, iso) => fs.utimesSync(path.join(repo.path, f), new Date(iso), new Date(iso));
  mtime('a.txt', '2026-10-24T09:00:00Z');
  mtime('.panel/state.json', '2026-10-24T11:59:30Z'); // .panel/ is not ignored in this repo, so git lists it as untracked
  assert.equal((await readState(repo, realGit)).stale, false);
  fs.writeFileSync(path.join(repo.path, 'a.txt'), 'changed\n');
  mtime('a.txt', '2026-10-24T11:59:30Z');
  assert.equal((await readState(repo, realGit)).stale, true, 'modified tracked file');
  sh(repo.path, 'checkout', '--', 'a.txt');
  assert.equal((await readState(repo, realGit)).stale, false);
  fs.writeFileSync(path.join(repo.path, 'new.txt'), 'n\n');
  mtime('new.txt', '2026-10-24T11:59:45Z');
  assert.equal((await readState(repo, realGit)).stale, true, 'untracked file');
});

test('readState: a file touched in the same second the state was written does not make it stale', async () => {
  const repo = gitRepo('2026-10-24T08:00:00Z');
  writeState(repo, { ...GOOD, at: '2026-10-24T11:59:00Z' });
  fs.writeFileSync(path.join(repo.path, 'a.txt'), 'changed\n');
  fs.utimesSync(path.join(repo.path, 'a.txt'), new Date('2026-10-24T11:59:00.800Z'), new Date('2026-10-24T11:59:00.800Z'));
  assert.equal((await readState(repo, realGit)).stale, false);
});

test('readState: at most 200 changed files are looked at, and git failing leaves the state fresh', async () => {
  const lines = Array.from({ length: 250 }, (_, i) => `? f${i}.txt`).join('\n');
  const seen = [];
  const fsApi = plainFs({ lstat: async (p) => { seen.push(p); return { isSymbolicLink: () => false, isFile: () => true, isDirectory: () => false, size: 10, mtimeMs: 0 }; } });
  const gitRun = async (cwd, args) => (args.includes('status') ? { code: 0, stdout: lines, stderr: '' } : { code: 0, stdout: '2026-10-24T00:00:00+00:00\n', stderr: '' });
  const r = await readState({ id: 'x', path: '/r' }, opts({ fs: fsApi, git: gitRun }));
  assert.equal(r.available, true);
  assert.equal(seen.filter((p) => /f\d+\.txt$/.test(p)).length, 200);
  assert.equal((await readState(repoWith(GOOD), opts())).stale, false);
});

// ---------- the panel-ignored fact of requirementsFor (injected git runner) ----------
test('requirementsFor: panel-ignored comes from git check-ignore: 0 pass, 1 fail, anything else unavailable', async () => {
  const dir = tmp();
  const ask = async (code, throws) => {
    const calls = [];
    const git = async (cwd, args) => { calls.push({ cwd, args }); if (throws) throw new Error('boom'); return { code, stdout: '', stderr: '' }; };
    const out = await requirementsFor({ id: 'r', path: dir }, null, { git });
    return { status: out.results.find((x) => x.id === 'panel-ignored').status, calls };
  };
  const ok = await ask(0);
  assert.equal(ok.status, 'pass');
  assert.deepEqual(ok.calls[0], { cwd: dir, args: ['check-ignore', '-q', '.panel/state.json'] });
  assert.equal((await ask(1)).status, 'fail');
  assert.equal((await ask(128)).status, 'unavailable');
  assert.equal((await ask(-1)).status, 'unavailable');
  assert.equal((await ask(0, true)).status, 'unavailable');
});
