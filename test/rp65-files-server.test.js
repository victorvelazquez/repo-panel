'use strict';
// RP65: GET /api/files (the tree) and GET /api/file (one file). The person asked for "un explorador y lectura de archivos del repo"
// and decided that files that look like secrets ARE shown (S62), but only inside the repo and never `.git/`. These tests are the abuse
// cases of that rule: the browser sends any string as a path, so every one of them must end in an error with NO content, and a
// rejected request must change nothing on disk. Real git repos in a temp folder; the real config and repos are never touched.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { sh } = require('./git-helper.js');

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'rp65-'));
const repoDir = path.join(scratch, 'Repo');
const outside = path.join(scratch, 'outside.txt');
const outsideDir = path.join(scratch, 'outdir');
fs.mkdirSync(repoDir);
process.env.REPO_PANEL_CONFIG = path.join(scratch, 'config.json');
process.env.REPO_PANEL_CASES_FILE = 'off';
fs.writeFileSync(process.env.REPO_PANEL_CONFIG, JSON.stringify({ port: 4312, groups: [{ name: 'G', repos: [{ path: repoDir }] }], rooms: [] }));
test.after(() => fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 5 }));

const { listFiles, readFile } = require('../server/files.js');
const { createServer } = require('../server/http.js');
const lib = require('../lib.js');

const repo = { path: repoDir, id: lib.repoId(repoDir), name: 'Repo' };
const put = (rel, data) => { const f = path.join(repoDir, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, data); };

// A committed repo with: a file we then modify, secret-looking files (committed), an ignored .env, a binary, a big file, an untracked
// file, a file whose name starts with "-" and a tracked symlink to a file OUTSIDE the repo (when the system allows creating one).
let symlinked = false;
let junctioned = false;
test.before(() => {
  sh(repoDir, 'init', '-q', '-b', 'main');
  fs.writeFileSync(outside, 'OUTSIDE-SECRET\n');
  put('.gitignore', '.env\n');
  put('src/a.js', 'one\ntwo\nthree\n');
  put('README.md', '# hi\n');
  put('secret.key', 'PRIVATE-KEY-MATERIAL\n');
  put('-dash.txt', 'dash\n');
  put('bin.dat', Buffer.from([1, 2, 0, 3]));
  put('big.txt', 'x'.repeat(1024 * 1024 + 10));
  put('gone.txt', 'soon gone\n');
  try { fs.symlinkSync(outside, path.join(repoDir, 'link.txt')); symlinked = true; } catch { /* no permission to make symlinks */ }
  sh(repoDir, 'add', '-A');
  sh(repoDir, 'commit', '-q', '-m', 'init');
  // A folder junction needs no privilege on Windows, and git FOLLOWS it: it lists jdir/secret.txt, a file that lives outside the repo.
  fs.mkdirSync(outsideDir);
  fs.writeFileSync(path.join(outsideDir, 'secret.txt'), 'OUTSIDE-SECRET' + String.fromCharCode(10));
  try { fs.symlinkSync(outsideDir, path.join(repoDir, 'jdir'), 'junction'); junctioned = true; } catch { /* not supported here */ }
  put('.env', 'API_TOKEN=abc\n'); // ignored: exists on disk but git does not list it
  put('src/a.js', 'one\nTWO\nthree\nfour\n'); // modified: lines 2 and 4 changed
  put('-dash.txt', 'dash2\n'); // modified: a name that starts with "-" must still get its changed lines (the diff call has to separate the path with --)
  put('new.txt', 'n1\nn2\n'); // untracked
  fs.rmSync(path.join(repoDir, 'gone.txt')); // tracked but deleted from the working tree
});

const fails = async (p, status) => {
  await assert.rejects(Promise.resolve().then(() => readFile(repo, p)), (e) => {
    assert.equal(e.status, status, `${JSON.stringify(p)} -> ${e.status} ${e.message}`);
    assert.ok(!/OUTSIDE-SECRET|PRIVATE-KEY|API_TOKEN/.test(e.message), 'the error never carries content');
    return true;
  });
};

// ---------- the tree ----------
test('a1: the tree lists tracked and untracked files, flags the untracked ones, and never lists ignored files or .git', async () => {
  const t = await listFiles(repo);
  const paths = t.files.map((f) => f.path);
  for (const p of ['src/a.js', 'README.md', 'secret.key', '.gitignore', 'new.txt', 'bin.dat', '-dash.txt']) assert.ok(paths.includes(p), p);
  assert.ok(!paths.includes('.env'), 'an ignored file is not listed');
  assert.ok(!paths.some((p) => p === '.git' || p.startsWith('.git/') || p.includes('/.git/')));
  assert.deepEqual(t.files.find((f) => f.path === 'new.txt'), { path: 'new.txt', untracked: true });
  assert.deepEqual(t.files.find((f) => f.path === 'README.md'), { path: 'README.md', untracked: false });
  assert.deepEqual(paths, [...paths].sort(), 'sorted');
  assert.equal(t.truncated, false);
});

// ---------- reading ----------
test('b1: a modified tracked file comes back with its text and the ranges of the changed lines', async () => {
  const f = await readFile(repo, 'src/a.js');
  assert.equal(f.text, 'one\nTWO\nthree\nfour\n');
  assert.deepEqual(f.changed, [[2, 1], [4, 1]]);
  assert.equal(f.binary, false);
  assert.equal(f.tooLarge, false);
});

test('b2: an untracked file is changed on every line, an unchanged file on none', async () => {
  assert.deepEqual((await readFile(repo, 'new.txt')).changed, [[1, 2]]);
  assert.deepEqual((await readFile(repo, 'README.md')).changed, []);
});

test('b3: files that look like secrets are shown, as the person decided (S62)', async () => {
  assert.equal((await readFile(repo, 'secret.key')).text, 'PRIVATE-KEY-MATERIAL\n');
  assert.equal((await readFile(repo, '.gitignore')).text, '.env\n', 'a name that merely starts with .git is not .git');
});

test('b4: a binary file and a file over 1 MiB give a flag and no text', async () => {
  const b = await readFile(repo, 'bin.dat');
  assert.equal(b.binary, true);
  assert.equal(b.text, undefined);
  const big = await readFile(repo, 'big.txt');
  assert.equal(big.tooLarge, true);
  assert.equal(big.text, undefined);
  assert.ok(big.size > 1024 * 1024);
});

// ---------- the abuse ----------
test('c1: a path that is not a plain repo-relative path is a 400 with no content', async () => {
  const bad = ['', '../outside.txt', 'src/../../outside.txt', 'src/../README.md', './README.md', '/etc/passwd', `/${outside}`, outside, 'C:/Windows/win.ini', 'C:\\Windows\\win.ini',
    'src\\a.js', 'src//a.js', 'README.md/', 'src/a.js\0', 'README.md:stream', 'a'.repeat(2000), ' README.md', 'README.md '];
  for (const p of bad) await fails(p, 400);
  for (const p of [undefined, null, 5, ['README.md'], { a: 1 }, true]) await fails(p, 400);
});

test('c1b: a colon (drive letters, alternate streams) or a backslash is a 400 even when the rest names a listed file', async () => {
  for (const p of ['README.md:s', 'README.md::$DATA', 'src\\a.js', 'src/a.js\\', 'C:README.md', 'src\\..\\README.md']) await fails(p, 400);
});

test('c2: every .git segment is refused, whatever its case or depth', async () => {
  for (const p of ['.git', '.git/config', '.git/HEAD', '.GIT/config', '.Git/config', 'sub/.git/config', 'src/.git']) await fails(p, 400);
});

test('c3: a file that exists but git does not list (ignored, unknown, a folder, deleted) is a 404, all alike', async () => {
  assert.ok(fs.existsSync(path.join(repoDir, '.env')));
  const msgs = new Set();
  for (const p of ['.env', 'nope.txt', 'src', 'gone.txt', 'src/missing.js']) {
    await assert.rejects(Promise.resolve().then(() => readFile(repo, p)), (e) => { assert.equal(e.status, 404, p); msgs.add(e.message); return true; });
  }
  assert.equal(msgs.size, 1, 'one message: no way to tell "exists but hidden" from "does not exist"');
});

test('c4: a tracked symlink to a file outside the repo is never followed', async (t) => {
  if (!symlinked) return t.skip('this system does not allow creating symlinks');
  assert.ok(lib && (await listFiles(repo)).files.some((f) => f.path === 'link.txt'), 'git does list the link');
  await assert.rejects(Promise.resolve().then(() => readFile(repo, 'link.txt')), (e) => { assert.ok([403, 404].includes(e.status)); assert.ok(!/OUTSIDE/.test(e.message)); return true; });
});

test('c4b: a file reached through a folder link that leaves the repo is refused even when git lists it', async (t) => {
  if (!junctioned) return t.skip('this system does not allow creating folder links');
  assert.ok(!(await listFiles(repo)).files.some((f) => f.path.startsWith('jdir/')), 'the tree does not even show the names behind the link');
  await assert.rejects(Promise.resolve().then(() => readFile(repo, 'jdir/secret.txt')), (e) => { assert.ok([403, 404].includes(e.status)); assert.ok(!/OUTSIDE/.test(e.message)); return true; });
});

test('c5: a path that looks like a git option is just a path: a file called -dash.txt reads, and --output cannot write anything', async () => {
  const dash = await readFile(repo, '-dash.txt');
  assert.equal(dash.text, 'dash2\n');
  assert.deepEqual(dash.changed, [[1, 1]], 'git diff got the path after --, not as an option');
  const target = path.join(repoDir, 'evil.txt');
  for (const p of ['--output=evil.txt', '-U0', '--no-index', '-- ']) await assert.rejects(Promise.resolve().then(() => readFile(repo, p)));
  assert.ok(!fs.existsSync(target), 'nothing was written');
});

test('c6: a rejected request changes nothing on disk or in the index', async () => {
  const before = sh(repoDir, 'status', '--porcelain=v1', '-uall');
  for (const p of ['../outside.txt', '.git/config', '.env', '--output=x']) await assert.rejects(Promise.resolve().then(() => readFile(repo, p)));
  assert.equal(sh(repoDir, 'status', '--porcelain=v1', '-uall'), before);
  assert.equal(fs.readFileSync(outside, 'utf8'), 'OUTSIDE-SECRET\n');
});

// ---------- the HTTP layer ----------
const request = (port, p, headers = {}) => new Promise((resolve, reject) => {
  http.get({ host: '127.0.0.1', port, path: p, headers }, (res) => {
    let d = ''; res.on('data', (c) => { d += c; }); res.on('end', () => { let json = null; try { json = JSON.parse(d); } catch { /* html */ } resolve({ status: res.statusCode, body: d, json }); });
  }).on('error', reject);
});
const freePort = () => new Promise((resolve) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });

test('d1: both routes need the token, take the repo only from the config by id, and answer JSON', async () => {
  const port = await freePort();
  const server = createServer(port, { noSummaryStore: true });
  await new Promise((r) => server.listen(port, '127.0.0.1', r));
  try {
    const token = /name="?token"? content="([0-9a-f]+)"/.exec((await request(port, '/')).body)[1];
    const h = { 'x-token': token };
    const id = encodeURIComponent(repo.id);
    assert.equal((await request(port, `/api/files?id=${id}`)).status, 401);
    assert.equal((await request(port, `/api/file?id=${id}&path=README.md`)).status, 401);
    const tree = await request(port, `/api/files?id=${id}`, h);
    assert.equal(tree.status, 200);
    assert.ok(tree.json.files.some((f) => f.path === 'README.md'));
    const file = await request(port, `/api/file?id=${id}&path=src/a.js`, h);
    assert.equal(file.status, 200);
    assert.equal(file.json.text, 'one\nTWO\nthree\nfour\n');
    assert.equal((await request(port, `/api/file?id=${id}&path=..%2Foutside.txt`, h)).status, 400);
    assert.equal((await request(port, `/api/file?id=${id}&path=.git%2Fconfig`, h)).status, 400);
    assert.equal((await request(port, `/api/file?id=nope&path=README.md`, h)).status, 404);
    assert.equal((await request(port, `/api/file?id=${id}`, h)).status, 400, 'a missing path');
    assert.equal((await request(port, `/api/files?id=${encodeURIComponent(outside)}`, h)).status, 404, 'a folder is not a repo id');
  } finally { await new Promise((r) => server.close(r)); }
});
