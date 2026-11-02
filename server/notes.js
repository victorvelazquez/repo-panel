'use strict';
// RP93: the notes of a repo (the notes tab, RP93b). GET /api/notes reads and POST /api/notes saves ONE fixed file, `.panel/notas.md` of a repo
// the config knows by id: the browser never sends a path. They are the person's own text and nothing can rebuild it, so:
//   - the file stays out of Git: when `git check-ignore` says it is not ignored, `.panel/` is added to `.git/info/exclude` (the person's OK, S11);
//     a notes file that Git TRACKS is never written (it would end up in a commit);
//   - a save carries the `rev` (a hash of the content) the page last saw; if the file changed outside since, nothing is written and the answer is
//     `{ conflict: true, text, rev }` with what is on disk (a 200: server errors only carry a message);
//   - the write is whole or not at all (a temp file in the same folder, then a rename) and saves of one repo run one at a time;
//   - `.panel` or the file being a link, or the file not being a regular file, is refused: a note never goes (or is read from) outside the repo.
// Every failure is an HttpError with a fixed message that never carries file content or a path.
const fsp = require('node:fs/promises');
const crypto = require('node:crypto');
const path = require('node:path');
const { git } = require('./exec.js');
const { HttpError } = require('./errors.js');

const MAX_BYTES = 256 * 1024;
const DIR = '.panel';
const REL = '.panel/notas.md';
const UNAVAILABLE = 'Notes unavailable';
const TOO_LARGE = 'Notes too large';

const revOf = (buf) => crypto.createHash('sha256').update(buf).digest('hex').slice(0, 32);
const unavailable = () => new HttpError(400, UNAVAILABLE);

// A missing folder or file is "no notes yet"; anything else odd (a link, a folder where the file should be) is refused.
async function lstatOrNull(p) {
  try { return await fsp.lstat(p); } catch (e) { if (e && (e.code === 'ENOENT' || e.code === 'ENOTDIR')) return null; throw unavailable(); }
}
async function locate(repo) {
  const dir = path.join(repo.path, DIR);
  const file = path.join(dir, 'notas.md');
  const d = await lstatOrNull(dir);
  if (!d) return { dir, file, dirExists: false, fileStat: null };
  if (d.isSymbolicLink() || !d.isDirectory()) throw unavailable();
  const [realRepo, realDir] = await Promise.all([fsp.realpath(repo.path), fsp.realpath(dir)]).catch(() => { throw unavailable(); });
  if (path.dirname(realDir) !== realRepo) throw unavailable();
  const f = await lstatOrNull(file);
  if (f && (f.isSymbolicLink() || !f.isFile())) throw unavailable();
  return { dir, file, dirExists: true, fileStat: f };
}

async function current(where) {
  if (!where.fileStat) return { text: '', rev: '', exists: false };
  if (where.fileStat.size > MAX_BYTES) throw new HttpError(413, TOO_LARGE);
  let buf;
  try { buf = await fsp.readFile(where.file); } catch { throw unavailable(); }
  if (buf.length > MAX_BYTES) throw new HttpError(413, TOO_LARGE);
  return { text: buf.toString('utf8'), rev: revOf(buf), exists: true };
}

async function readNotes(repo) {
  return current(await locate(repo));
}

// A notes file that Git TRACKS is never written (it would end up in a commit). Checked first: it changes nothing.
async function refuseTracked(repo, run) {
  if ((await run(repo.path, ['ls-files', '--error-unmatch', '--', REL])).code === 0) throw new HttpError(409, 'The notes file is tracked by Git');
}

// Makes sure Git will never see the file: adds `.panel/` to .git/info/exclude when it is not ignored yet. If that still does not hide the file,
// the exclude goes back exactly as it was and the save is refused.
async function hideFromGit(repo, run) {
  const ignored = () => run(repo.path, ['check-ignore', '-q', '--', REL]);
  const first = await ignored();
  if (first.code === 0) return;
  if (first.code !== 1) throw unavailable(); // not a git repo (or git failed)
  const where = await run(repo.path, ['rev-parse', '--git-path', 'info/exclude']);
  if (where.code !== 0 || !where.stdout.trim()) throw unavailable();
  const file = path.resolve(repo.path, where.stdout.trim());
  let old = null;
  try { old = await fsp.readFile(file, 'utf8'); } catch (e) { if (!e || e.code !== 'ENOENT') throw unavailable(); }
  try {
    await fsp.mkdir(path.dirname(file), { recursive: true });
    await fsp.appendFile(file, `${old && !old.endsWith('\n') ? '\n' : ''}${DIR}/\n`);
  } catch { throw unavailable(); }
  if ((await ignored()).code !== 0) {
    await (old === null ? fsp.unlink(file) : fsp.writeFile(file, old)).catch(() => {});
    throw unavailable();
  }
}

const tails = new Map();
// Saves of one repo run one at a time: two at once on the same base cannot both pass the check.
function serial(key, fn) {
  const tail = tails.get(key) || Promise.resolve();
  const run = tail.then(fn, fn);
  const next = run.catch(() => {});
  tails.set(key, next);
  next.then(() => { if (tails.get(key) === next) tails.delete(key); });
  return run;
}

// body = { text, base }: `base` is the rev the page last saw ('' when it saw no file). `ops` and `run` are injectable for tests.
async function saveNotes(repo, body, { rename = fsp.rename, git: run = git } = {}) {
  const ok = body && typeof body === 'object' && !Array.isArray(body) && typeof body.text === 'string' && typeof body.base === 'string' && body.base.length <= 64;
  if (!ok) throw new HttpError(400, 'Invalid notes');
  if (Buffer.byteLength(body.text, 'utf8') > MAX_BYTES) throw new HttpError(413, TOO_LARGE);
  const { text, base } = body;
  return serial(repo.path, async () => {
    let where = await locate(repo);
    await refuseTracked(repo, run);
    const now = await current(where);
    if (now.rev !== base) return { conflict: true, text: now.text, rev: now.rev };
    await hideFromGit(repo, run);
    if (!where.dirExists) {
      try { await fsp.mkdir(where.dir, { recursive: true }); } catch { throw unavailable(); }
      where = await locate(repo); // the folder is ours now: it must still be a plain folder inside the repo
    }
    const tmp = path.join(where.dir, `.notas-${process.pid}-${crypto.randomBytes(6).toString('hex')}.tmp`);
    try {
      await fsp.writeFile(tmp, text, { encoding: 'utf8', flag: 'wx' });
      await rename(tmp, where.file);
    } catch {
      await fsp.unlink(tmp).catch(() => {});
      throw new HttpError(500, 'Could not save the notes');
    }
    return { ok: true, rev: revOf(Buffer.from(text, 'utf8')) };
  });
}

module.exports = { readNotes, saveNotes, MAX_BYTES };
