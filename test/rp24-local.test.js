'use strict';
// RP24 (B2): /api/local carries `lastChangeMs`, the newest mtime of the changed or untracked files (null when unknown).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { localState } = require('../server/local.js');

const sh = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8', stdio: 'pipe' }).trim();

const dirs = [];
test.after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true, maxRetries: 5 }); });
function repo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-panel-rp24-'));
  dirs.push(dir);
  sh(dir, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'a\n');
  sh(dir, 'add', '-A');
  sh(dir, 'commit', '-q', '-m', 'c');
  return dir;
}
const touch = (file, ms) => fs.utimesSync(file, new Date(ms), new Date(ms));

test('localState: lastChangeMs is the newest mtime of the changed and untracked files', async () => {
  const dir = repo();
  const now = Date.now();
  fs.writeFileSync(path.join(dir, 'a.txt'), 'changed\n');
  fs.writeFileSync(path.join(dir, 'new.txt'), 'new\n');
  touch(path.join(dir, 'a.txt'), now - 60_000);
  touch(path.join(dir, 'new.txt'), now - 2_000);
  const l = await localState({ path: dir });
  assert.equal(l.files.length, 2);
  assert.ok(Math.abs(l.lastChangeMs - (now - 2_000)) < 1500, `got ${l.lastChangeMs}`);
});

test('localState: a file written a minute ago gives a lastChangeMs a minute old', async () => {
  const dir = repo();
  const now = Date.now();
  fs.writeFileSync(path.join(dir, 'a.txt'), 'changed\n');
  touch(path.join(dir, 'a.txt'), now - 60_000);
  const l = await localState({ path: dir });
  assert.ok(now - l.lastChangeMs >= 59_000 && now - l.lastChangeMs < 65_000, `got ${now - l.lastChangeMs}`);
});

test('localState: lastChangeMs is null on a clean repo, and a deleted file is ignored', async () => {
  const dir = repo();
  assert.equal((await localState({ path: dir })).lastChangeMs, null);
  fs.rmSync(path.join(dir, 'a.txt'));
  const l = await localState({ path: dir });
  assert.equal(l.files.length, 1);
  assert.equal(l.lastChangeMs, null);
});

test('localState: PRESERVE the other fields of a dirty repo', async () => {
  const dir = repo();
  fs.writeFileSync(path.join(dir, 'a.txt'), 'changed\nmore\n');
  const l = await localState({ path: dir });
  assert.equal(l.branch, 'main');
  assert.deepEqual(l.files.map((f) => [f.path, f.status, f.added, f.deleted]), [['a.txt', 'M', 2, 1]]);
  assert.equal(l.stagedCount, 0);
  assert.equal(l.base, 'main');
  assert.match(l.head, /^[0-9a-f]{40}$/);
});

test('localState: PRESERVE a missing folder is still just an error answer without the field', async () => {
  const l = await localState({ path: path.join(os.tmpdir(), 'repo-panel-rp24-does-not-exist') });
  assert.deepEqual(l, { error: 'Folder not found' });
});
