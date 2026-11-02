'use strict';
// RP93 (S8, S11), part a: GET and POST /api/notes, the server of the notes tab. The notes are the person's own text, which nothing can
// rebuild, in ONE fixed file, `.panel/notas.md` of a repo that the config knows by id; the browser never sends a path. They must stay out of
// Git (the panel adds `.panel/` to `.git/info/exclude` when it is missing: the person's OK, S11), must never be lost to a stale save (a file
// changed outside answers `conflict` and nothing is written), must be written whole or not at all, and must never leave the repo. These tests
// are the abuse cases of that. Real git repos in a temp folder; the real config and repos are never touched.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { sh } = require('./git-helper.js');

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'rp93-'));
process.env.REPO_PANEL_CONFIG = path.join(scratch, 'config.json');
process.env.REPO_PANEL_CASES_FILE = 'off';
const mk = (name) => {
  const dir = path.join(scratch, name);
  fs.mkdirSync(dir);
  sh(dir, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(dir, 'README.md'), 'hi\n');
  sh(dir, 'add', 'README.md');
  sh(dir, 'commit', '-q', '-m', 'init');
  return { path: dir, name, id: lib.repoId(dir) };
};
const lib = require('../lib.js');
const webRepo = (() => { const dir = path.join(scratch, 'web'); fs.mkdirSync(dir); return dir; })();
fs.writeFileSync(process.env.REPO_PANEL_CONFIG, JSON.stringify({ port: 4313, groups: [{ name: 'G', repos: [{ path: webRepo }] }], rooms: [] }));
test.after(() => fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 5 }));

const { readNotes, saveNotes, MAX_BYTES } = require('../server/notes.js');
const { createServer } = require('../server/http.js');

const FILE = (repo) => path.join(repo.path, '.panel', 'notas.md');
const exclude = (repo) => { try { return fs.readFileSync(path.join(repo.path, '.git', 'info', 'exclude'), 'utf8'); } catch { return ''; } };
const status = (repo) => sh(repo.path, 'status', '--porcelain', '--untracked-files=all');
const reject = async (fn, status, msg) => {
  await assert.rejects(fn, (e) => { assert.equal(e.status, status, e.message); if (msg) assert.equal(e.message, msg); return true; });
};

test('n1: reading a repo without notes answers an empty text and the empty rev, and creates nothing', async () => {
  const repo = mk('n1');
  assert.deepEqual(await readNotes(repo), { text: '', rev: '', exists: false });
  assert.ok(!fs.existsSync(path.join(repo.path, '.panel')), 'a read never writes');
  assert.equal(exclude(repo).includes('.panel'), false);
});

test('n2: the first save writes the file, adds `.panel/` to .git/info/exclude and git status stays clean', async () => {
  const repo = mk('n2');
  const r = await saveNotes(repo, { text: 'buy milk\n', base: '' });
  assert.equal(r.ok, true);
  assert.match(r.rev, /^[0-9a-f]{16,64}$/);
  assert.equal(fs.readFileSync(FILE(repo), 'utf8'), 'buy milk\n');
  assert.equal(status(repo), '', 'the notes are not in git status');
  assert.equal(sh(repo.path, 'check-ignore', '-q', '.panel/notas.md') === '', true);
  assert.equal(exclude(repo).split('\n').filter((l) => l.trim() === '.panel/').length, 1);
  assert.deepEqual(fs.readdirSync(path.join(repo.path, '.panel')), ['notas.md'], 'no temp file is left behind');
});

test('n3: the text is stored exactly: CRLF, unicode, trailing spaces, an empty note; and a read returns it with the same rev', async () => {
  const repo = mk('n3');
  let base = '';
  for (const text of ['a\r\nb  \r\n\tc', 'ñandú ✓ 日本語 😀\n', '', 'x']) {
    const r = await saveNotes(repo, { text, base });
    assert.equal(r.ok, true);
    assert.equal(fs.readFileSync(FILE(repo), 'utf8'), text);
    const got = await readNotes(repo);
    assert.deepEqual(got, { text, rev: r.rev, exists: true });
    base = r.rev;
  }
});

test('n4: a save based on an old rev (the file changed outside) answers conflict with what is on disk and writes NOTHING; with the new rev it saves', async () => {
  const repo = mk('n4');
  const first = await saveNotes(repo, { text: 'mine v1', base: '' });
  fs.writeFileSync(FILE(repo), 'edited in Notepad', 'utf8');
  const r = await saveNotes(repo, { text: 'mine v2', base: first.rev });
  assert.equal(r.conflict, true);
  assert.equal(r.text, 'edited in Notepad');
  assert.notEqual(r.rev, first.rev);
  assert.equal(r.ok, undefined);
  assert.equal(fs.readFileSync(FILE(repo), 'utf8'), 'edited in Notepad', 'the outside edit is untouched');
  const again = await saveNotes(repo, { text: 'merged', base: r.rev });
  assert.equal(again.ok, true);
  assert.equal(fs.readFileSync(FILE(repo), 'utf8'), 'merged');
});

test('n5: a note created outside while the page thought there was none (base "") is a conflict too, and a file deleted outside is one', async () => {
  const repo = mk('n5');
  fs.mkdirSync(path.join(repo.path, '.panel'));
  fs.writeFileSync(FILE(repo), 'already here');
  const r = await saveNotes(repo, { text: 'overwrite?', base: '' });
  assert.equal(r.conflict, true);
  assert.equal(r.text, 'already here');
  assert.equal(fs.readFileSync(FILE(repo), 'utf8'), 'already here');
  fs.unlinkSync(FILE(repo));
  const gone = await saveNotes(repo, { text: 'x', base: r.rev });
  assert.equal(gone.conflict, true, 'it was there, now it is not: the page must be told');
  assert.equal(gone.text, '');
  assert.equal(gone.rev, '');
  assert.ok(!fs.existsSync(FILE(repo)));
});

test('n6: a bad body is a 400 and writes nothing: text not a string, base missing or not a string, a body that is not an object', async () => {
  const repo = mk('n6');
  const bad = [{ text: 5, base: '' }, { text: null, base: '' }, { text: ['x'], base: '' }, { text: {}, base: '' }, { base: '' }, { text: 'x' }, { text: 'x', base: 3 }, { text: 'x', base: null },
    { text: 'x', base: 'a'.repeat(200) }, null, 'x', 7, [], undefined];
  for (const body of bad) await reject(() => saveNotes(repo, body), 400, 'Invalid notes');
  assert.ok(!fs.existsSync(path.join(repo.path, '.panel')), 'nothing was created');
  assert.equal(exclude(repo).includes('.panel'), false, 'and git was not touched');
});

test('n7: the size limit counts BYTES: the limit exactly is saved, one byte more is a 413 and nothing changes', async () => {
  const repo = mk('n7');
  assert.equal(MAX_BYTES, 256 * 1024);
  const ok = await saveNotes(repo, { text: 'a'.repeat(MAX_BYTES), base: '' });
  assert.equal(ok.ok, true);
  await reject(() => saveNotes(repo, { text: 'a'.repeat(MAX_BYTES + 1), base: ok.rev }), 413, 'Notes too large');
  await reject(() => saveNotes(repo, { text: 'é'.repeat(MAX_BYTES / 2 + 1), base: ok.rev }), 413, 'Notes too large');
  assert.equal(fs.readFileSync(FILE(repo), 'utf8'), 'a'.repeat(MAX_BYTES), 'the old note survives');
  fs.writeFileSync(FILE(repo), 'b'.repeat(MAX_BYTES + 10));
  await reject(() => readNotes(repo), 413, 'Notes too large');
});

test('n8: the exclude line is added once, never twice, and a repo that already ignores `.panel` is not touched', async () => {
  const repo = mk('n8');
  const a = await saveNotes(repo, { text: '1', base: '' });
  const b = await saveNotes(repo, { text: '2', base: a.rev });
  await saveNotes(repo, { text: '3', base: b.rev });
  assert.equal(exclude(repo).split('\n').filter((l) => l.trim() === '.panel/').length, 1);
  const other = mk('n8b');
  fs.writeFileSync(path.join(other.path, '.git', 'info', 'exclude'), '# mine\n.panel\n');
  await saveNotes(other, { text: 'x', base: '' });
  assert.equal(exclude(other), '# mine\n.panel\n', 'already ignored by the person: left exactly as it was');
  const third = mk('n8c');
  fs.writeFileSync(path.join(third.path, '.gitignore'), '.panel/\n');
  sh(third.path, 'add', '.gitignore');
  sh(third.path, 'commit', '-q', '-m', 'ignore');
  await saveNotes(third, { text: 'x', base: '' });
  assert.equal(exclude(third).includes('.panel'), false, 'ignored through .gitignore: exclude not touched');
});

test('n9: an exclude file that ends without a newline keeps its last line intact', async () => {
  const repo = mk('n9');
  fs.writeFileSync(path.join(repo.path, '.git', 'info', 'exclude'), '*.log');
  await saveNotes(repo, { text: 'x', base: '' });
  assert.equal(exclude(repo), '*.log\n.panel/\n');
});

test('n10: a notes file that Git TRACKS is never written (it would end up in a commit): 409, nothing changes', async () => {
  const repo = mk('n10');
  fs.mkdirSync(path.join(repo.path, '.panel'));
  fs.writeFileSync(FILE(repo), 'tracked secret');
  sh(repo.path, 'add', '-f', '.panel/notas.md');
  sh(repo.path, 'commit', '-q', '-m', 'oops');
  const before = exclude(repo);
  const got = await readNotes(repo);
  await reject(() => saveNotes(repo, { text: 'new', base: got.rev }), 409, 'The notes file is tracked by Git');
  assert.equal(fs.readFileSync(FILE(repo), 'utf8'), 'tracked secret');
  assert.equal(exclude(repo), before, 'and the exclude was not edited for nothing');
});

test('n11: a failure while writing leaves the old note whole and no temp file behind, with a fixed message', async () => {
  const repo = mk('n11');
  const a = await saveNotes(repo, { text: 'precious', base: '' });
  const failing = { rename: async () => { throw Object.assign(new Error(`EPERM: ${repo.path} secret detail`), { code: 'EPERM' }); } };
  await assert.rejects(() => saveNotes(repo, { text: 'half', base: a.rev }, failing), (e) => {
    assert.equal(e.status, 500);
    assert.equal(e.message, 'Could not save the notes');
    assert.ok(!e.message.includes(repo.path));
    return true;
  });
  assert.equal(fs.readFileSync(FILE(repo), 'utf8'), 'precious');
  assert.deepEqual(fs.readdirSync(path.join(repo.path, '.panel')), ['notas.md']);
});

test('n12: two saves at once on the same base: ONE wins and the other gets the conflict (they are serialized per repo)', async () => {
  const repo = mk('n12');
  const a = await saveNotes(repo, { text: 'start', base: '' });
  const results = await Promise.all([saveNotes(repo, { text: 'A', base: a.rev }), saveNotes(repo, { text: 'B', base: a.rev }), saveNotes(repo, { text: 'C', base: a.rev })]);
  assert.equal(results.filter((r) => r.ok).length, 1);
  assert.equal(results.filter((r) => r.conflict).length, 2);
  const winner = results.findIndex((r) => r.ok);
  assert.equal(fs.readFileSync(FILE(repo), 'utf8'), ['A', 'B', 'C'][winner]);
  for (const r of results.filter((x) => x.conflict)) assert.equal(r.text, ['A', 'B', 'C'][winner]);
});

test('n13: a folder that is not a git repo gets a 400 and nothing is created in it', async () => {
  const dir = path.join(scratch, 'plain');
  fs.mkdirSync(dir);
  const repo = { path: dir, name: 'plain', id: lib.repoId(dir) };
  await reject(() => saveNotes(repo, { text: 'x', base: '' }), 400, 'Notes unavailable');
  assert.deepEqual(fs.readdirSync(dir), [], 'no .panel, nothing');
});

// A junction (Windows) or a symlink (elsewhere) that makes `.panel` lead OUTSIDE the repo: a write through it would put the note, and the
// exclude edit, somewhere the person never chose. Skipped where the system does not allow creating one.
const link = (target, at) => { try { fs.symlinkSync(target, at, process.platform === 'win32' ? 'junction' : 'dir'); return true; } catch { return false; } };
test('n14: `.panel` that is a link to a folder outside the repo is refused for reading and writing, and the outside folder gets nothing', async (t) => {
  const repo = mk('n14');
  const outside = path.join(scratch, 'n14-outside');
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'notas.md'), 'OUTSIDE-SECRET');
  if (!link(outside, path.join(repo.path, '.panel'))) return t.skip('cannot create a link here');
  await reject(() => readNotes(repo), 400, 'Notes unavailable');
  await reject(() => saveNotes(repo, { text: 'x', base: '' }), 400, 'Notes unavailable');
  assert.equal(fs.readFileSync(path.join(outside, 'notas.md'), 'utf8'), 'OUTSIDE-SECRET');
  assert.deepEqual(fs.readdirSync(outside), ['notas.md']);
});

test('n15: `notas.md` that is a link to a file outside, or a folder, is refused and the outside file is not read or changed', async (t) => {
  const repo = mk('n15');
  fs.mkdirSync(path.join(repo.path, '.panel'));
  const outside = path.join(scratch, 'n15-outside.txt');
  fs.writeFileSync(outside, 'OUTSIDE-SECRET');
  let linked = true;
  try { fs.symlinkSync(outside, FILE(repo), 'file'); } catch { linked = false; }
  if (linked) {
    await assert.rejects(() => readNotes(repo), (e) => { assert.equal(e.status, 400); assert.ok(!/OUTSIDE-SECRET/.test(e.message)); return true; });
    await reject(() => saveNotes(repo, { text: 'x', base: '' }), 400, 'Notes unavailable');
    assert.equal(fs.readFileSync(outside, 'utf8'), 'OUTSIDE-SECRET');
    fs.unlinkSync(FILE(repo));
  } else t.diagnostic('file symlink not allowed here: that half is skipped');
  fs.mkdirSync(FILE(repo));
  await reject(() => readNotes(repo), 400, 'Notes unavailable');
  await reject(() => saveNotes(repo, { text: 'x', base: '' }), 400, 'Notes unavailable');
});

// ---------- the routes ----------
const call = (port, method, p, { headers = {}, body } = {}) => new Promise((resolve, reject2) => {
  const data = body === undefined ? null : typeof body === 'string' ? body : JSON.stringify(body);
  const req = http.request({ host: '127.0.0.1', port, path: p, method, headers: { ...headers, ...(data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {}) } }, (res) => {
    let d = '';
    res.on('data', (c) => { d += c; });
    res.on('end', () => { let json = null; try { json = JSON.parse(d); } catch { /* html */ } resolve({ status: res.statusCode, body: d, json }); });
  });
  req.on('error', reject2);
  if (data) req.write(data);
  req.end();
});
const freePort = () => new Promise((resolve) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });

test('h1: both routes need the token, take the repo only from the config by id, ignore any path in the body, and answer JSON', async () => {
  sh(webRepo, 'init', '-q', '-b', 'main');
  const port = await freePort();
  const server = createServer(port, { noSummaryStore: true });
  await new Promise((r) => server.listen(port, '127.0.0.1', r));
  try {
    const page = await call(port, 'GET', '/');
    const token = /name="?token"? content="([0-9a-f]+)"/.exec(page.body)[1];
    const h = { 'x-token': token };
    const id = lib.repoId(webRepo);
    const q = `/api/notes?id=${encodeURIComponent(id)}`;
    assert.equal((await call(port, 'GET', q)).status, 401);
    assert.equal((await call(port, 'POST', '/api/notes', { body: { id, text: 'x', base: '' } })).status, 401);
    const empty = await call(port, 'GET', q, { headers: h });
    assert.equal(empty.status, 200);
    assert.deepEqual(empty.json, { text: '', rev: '', exists: false });
    const saved = await call(port, 'POST', '/api/notes', { headers: h, body: { id, text: 'hello', base: '', path: '../escape.md', file: 'README.md' } });
    assert.equal(saved.status, 200);
    assert.equal(saved.json.ok, true);
    assert.equal(fs.readFileSync(path.join(webRepo, '.panel', 'notas.md'), 'utf8'), 'hello');
    assert.ok(!fs.existsSync(path.join(scratch, 'escape.md')) && !fs.existsSync(path.join(webRepo, 'README.md')), 'the path of the body is ignored');
    assert.deepEqual((await call(port, 'GET', q, { headers: h })).json, { text: 'hello', rev: saved.json.rev, exists: true });
    const stale = await call(port, 'POST', '/api/notes', { headers: h, body: { id, text: 'late', base: '' } });
    assert.equal(stale.status, 200);
    assert.deepEqual(stale.json, { conflict: true, text: 'hello', rev: saved.json.rev });
    assert.equal((await call(port, 'GET', '/api/notes?id=nope', { headers: h })).status, 404);
    assert.equal((await call(port, 'POST', '/api/notes', { headers: h, body: { id: 'nope', text: 'x', base: '' } })).status, 404);
    assert.equal((await call(port, 'GET', `/api/notes?id=${encodeURIComponent(scratch)}`, { headers: h })).status, 404, 'a folder is not a repo id');
    assert.equal((await call(port, 'GET', '/api/notes', { headers: h })).status, 404, 'no id');
    for (const bad of ['{not json', '[]', 'null', '"x"', '7']) {
      const r = await call(port, 'POST', '/api/notes', { headers: h, body: bad });
      assert.ok(r.status === 400 || r.status === 404, `${bad} -> ${r.status}`);
    }
    assert.equal(fs.readFileSync(path.join(webRepo, '.panel', 'notas.md'), 'utf8'), 'hello', 'every rejected request left the note alone');
    // A body past the server cap (1 MB) is cut by the server: a 413 or, when it destroys the connection first, a reset. Either way nothing is written.
    const huge = await call(port, 'POST', '/api/notes', { headers: h, body: { id, text: 'a'.repeat(1.2e6), base: saved.json.rev } }).catch((e) => ({ status: e.code }));
    assert.ok(huge.status === 413 || huge.status === 'ECONNRESET' || huge.status === 'EPIPE', String(huge.status));
    assert.equal((await call(port, 'POST', '/api/notes', { headers: h, body: { id, text: 'a'.repeat(300 * 1024), base: saved.json.rev } })).status, 413, 'a note past the note cap');
    assert.equal(fs.readFileSync(path.join(webRepo, '.panel', 'notas.md'), 'utf8'), 'hello');
  } finally { await new Promise((r) => server.close(r)); }
});

test('n16: when adding `.panel/` to the exclude does NOT make Git ignore the file, nothing is written (400)', async () => {
  const repo = mk('n16');
  const { git } = require('../server/exec.js');
  const stubborn = async (cwd, args) => (args[0] === 'check-ignore' ? { code: 1, stdout: '', stderr: '' } : git(cwd, args));
  await reject(() => saveNotes(repo, { text: 'x', base: '' }, { git: stubborn }), 400, 'Notes unavailable');
  assert.ok(!fs.existsSync(FILE(repo)), 'the note was not written where Git would see it');
});

test('n17: a rejected save changes NOTHING, the exclude included: a conflict, or an exclude that could not hide the file, leave it exactly as it was', async () => {
  const repo = mk('n17');
  const before = exclude(repo);
  const r = await saveNotes(repo, { text: 'x', base: 'zzz' });
  assert.equal(r.conflict, true);
  assert.equal(exclude(repo), before, 'a conflict on a repo with no notes does not edit the exclude');
  assert.ok(!fs.existsSync(path.join(repo.path, '.panel')));
  const { git } = require('../server/exec.js');
  const stubborn = async (cwd, args) => (args[0] === 'check-ignore' ? { code: 1, stdout: '', stderr: '' } : git(cwd, args));
  await reject(() => saveNotes(repo, { text: 'x', base: '' }, { git: stubborn }), 400, 'Notes unavailable');
  assert.equal(exclude(repo), before, 'the exclude went back exactly as it was');
  const bare = mk('n17b');
  fs.rmSync(path.join(bare.path, '.git', 'info', 'exclude'), { force: true });
  await reject(() => saveNotes(bare, { text: 'x', base: '' }, { git: stubborn }), 400, 'Notes unavailable');
  assert.ok(!fs.existsSync(path.join(bare.path, '.git', 'info', 'exclude')), 'an exclude file that did not exist is not left behind');
});
