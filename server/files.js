'use strict';
// RP65: the file explorer. GET /api/files lists what git knows of a repo (tracked plus untracked-and-not-ignored) and GET /api/file
// reads ONE of those files. The browser sends any string as a path, so the rule is: a path is served only when it is plainly
// repo-relative AND is exactly an entry of that git listing (which never holds `.git`, ignored files or anything outside the repo),
// and the file on disk is a regular file whose real path stays inside the repo (a tracked symlink to the outside is never followed).
// Every failure is an HttpError with a fixed message that never carries file content or says whether a hidden file exists.
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { git } = require('./exec.js');
const { HttpError } = require('./errors.js');

const MAX_FILES = 5000;
const MAX_PATH = 1024;
const MAX_BYTES = 1024 * 1024;
const BINARY_PROBE = 8000;
const NOT_FOUND = 'File not found';

// What git lists as files of the repo, sorted. A folder entry (a nested repository, `dir/`) and any `.git` segment are dropped.
const gitSegment = (p) => p.split('/').some((s) => s.toLowerCase() === '.git');
async function listing(repo, run) {
  const names = (r) => (r.code === 0 ? r.stdout.split('\0').filter((p) => p && !p.endsWith('/') && !gitSegment(p)) : []);
  const [tracked, others] = await Promise.all([
    run(repo.path, ['ls-files', '-z', '--cached']),
    run(repo.path, ['ls-files', '-z', '--others', '--exclude-standard']),
  ]);
  if (tracked.code !== 0 && others.code !== 0) throw new HttpError(404, NOT_FOUND);
  const untracked = new Set(names(others));
  return new Map([...names(tracked).map((p) => [p, false]), ...[...untracked].map((p) => [p, true])]);
}

// Git on Windows follows a folder junction and lists the files behind it. Reading them is refused anyway (readFile checks the real path);
// the tree does not even show their names: a folder whose real path leaves the repo drops everything under it.
async function insideRepo(repo, entries) {
  const root = await fsp.realpath(repo.path).catch(() => null);
  if (!root) return entries;
  const dirs = [...new Set(entries.map(([p]) => p.split('/').slice(0, -1).join('/')).filter(Boolean))];
  const away = new Set();
  await Promise.all(dirs.map(async (d) => {
    const real = await fsp.realpath(path.join(repo.path, ...d.split('/'))).catch(() => root); // a vanished folder is not a link
    if (real !== root && !real.startsWith(root + path.sep)) away.add(d);
  }));
  return entries.filter(([p]) => !away.has(p.split('/').slice(0, -1).join('/')));
}

async function listFiles(repo, { git: run = git } = {}) {
  const all = (await insideRepo(repo, [...(await listing(repo, run))])).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return { files: all.slice(0, MAX_FILES).map(([p, untracked]) => ({ path: p, untracked })), truncated: all.length > MAX_FILES };
}

// A plain relative path with `/` separators: no empty, `.`, `..` or `.git` segment, no backslash, colon (drive letters, streams),
// control character or edge space/dot (Windows aliases), and a sane length.
function cleanPath(p) {
  const ok = typeof p === 'string' && p.length > 0 && p.length <= MAX_PATH && !/[\\:\u0000-\u001f]/.test(p)
    && p.split('/').every((s) => s && s !== '.' && s !== '..' && s.toLowerCase() !== '.git' && !/[ .]$/.test(s) && !/^ /.test(s));
  if (!ok) throw new HttpError(400, 'Invalid path');
  return p;
}

// The line ranges [start, count] of the new file that differ from HEAD, from `git diff -U0` (a pure deletion adds no range).
function hunks(diff) {
  const out = [];
  for (const m of diff.matchAll(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/gm)) {
    const count = m[2] === undefined ? 1 : Number(m[2]);
    if (count > 0) out.push([Number(m[1]), count]);
  }
  return out;
}

const lineCount = (text) => (text ? text.split('\n').length - (text.endsWith('\n') ? 1 : 0) : 0);

async function readFile(repo, rel, { git: run = git } = {}) {
  const file = cleanPath(rel);
  const untracked = (await listing(repo, run)).get(file);
  if (untracked === undefined) throw new HttpError(404, NOT_FOUND);
  const full = path.join(repo.path, ...file.split('/'));
  let st;
  let real;
  let root;
  try {
    st = await fsp.lstat(full);
    [real, root] = await Promise.all([fsp.realpath(full), fsp.realpath(repo.path)]);
  } catch { throw new HttpError(404, NOT_FOUND); }
  if (!st.isFile() || st.isSymbolicLink() || (real !== root && !real.startsWith(root + path.sep))) throw new HttpError(404, NOT_FOUND);
  const base = { path: file, size: st.size, changed: [], binary: false, tooLarge: false };
  if (st.size > MAX_BYTES) return { ...base, tooLarge: true };
  const buf = await fsp.readFile(full).catch(() => { throw new HttpError(404, NOT_FOUND); });
  if (buf.subarray(0, BINARY_PROBE).includes(0)) return { ...base, binary: true };
  const text = buf.toString('utf8');
  let changed = [];
  if (untracked) changed = lineCount(text) ? [[1, lineCount(text)]] : [];
  else {
    let d = await run(repo.path, ['diff', 'HEAD', '-U0', '--no-color', '--no-renames', '--', file]);
    if (d.code !== 0) d = await run(repo.path, ['diff', '-U0', '--no-color', '--no-renames', '--', file]);
    changed = d.code === 0 ? hunks(d.stdout) : [];
  }
  return { ...base, text, changed };
}

module.exports = { listFiles, readFile };
