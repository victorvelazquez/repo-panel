'use strict';
// The state an agent declares for its repo: `.panel/state.json` in the working tree. The panel only reads it,
// never follows a symlink, and never throws: any problem is an answer with `available: false` and a reason.
const fsp = require('node:fs/promises');
const path = require('node:path');
const lib = require('../lib.js');
const { git } = require('./exec.js');

const STATES = ['working', 'needs-input', 'ready-to-commit', 'ready-to-pr', 'blocked'];
const MAX_BYTES = 64 * 1024;
const MAX_NEXT = 300;
const MAX_DETAIL = 4000;
const FUTURE_SLACK_MS = 5 * 60 * 1000;
const MAX_ACTIVITY_FILES = 200;

const unavailable = (reason) => ({ available: false, state: null, next: null, detail: null, at: null, stale: false, reason });
const absent = (e) => e && (e.code === 'ENOENT' || e.code === 'ENOTDIR');

// The validated fields of a parsed state file, or null when it is not a usable state.
function validate(o, now) {
  if (!o || typeof o !== 'object' || Array.isArray(o)) return null;
  if (!STATES.includes(o.state)) return null;
  if (typeof o.next !== 'string' || o.next.length > MAX_NEXT || !o.next.trim()) return null;
  if (o.detail !== undefined && o.detail !== null && (typeof o.detail !== 'string' || o.detail.length > MAX_DETAIL)) return null;
  if (typeof o.at !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d/.test(o.at)) return null;
  const atMs = Date.parse(o.at);
  if (Number.isNaN(atMs) || atMs > now + FUTURE_SLACK_MS) return null;
  return { state: o.state, next: o.next.trim(), detail: typeof o.detail === 'string' ? o.detail : null, at: o.at, atMs };
}

// Newest of the local HEAD commit date and the mtime of each changed or untracked file (the state file itself
// excluded, and at most MAX_ACTIVITY_FILES files), as epoch ms; null when nothing could be read.
async function lastActivity(repo, fsApi, gitRun) {
  const times = [];
  const log = await gitRun(repo.path, ['log', '-1', '--format=%cI', 'HEAD']).catch(() => null);
  const head = log && log.code === 0 ? Date.parse(log.stdout.trim()) : NaN;
  if (!Number.isNaN(head)) times.push(head);
  const st = await gitRun(repo.path, ['status', '--porcelain=v2', '-uall']).catch(() => null);
  const files = st && st.code === 0 ? lib.parseStatus(st.stdout).files.filter((f) => !f.path.startsWith('.panel/')).slice(0, MAX_ACTIVITY_FILES) : [];
  const stats = await Promise.all(files.map((f) => Promise.resolve().then(() => fsApi.lstat(path.join(repo.path, f.path))).catch(() => null)));
  for (const s of stats) if (s && Number.isFinite(s.mtimeMs)) times.push(s.mtimeMs);
  return times.length ? Math.max(...times) : null;
}

// The runners are injectable so tests can force failures. `fs` needs lstat and readFile, `now` returns epoch ms.
async function readState(repo, { fs: fsApi = fsp, git: gitRun = git, now = Date.now } = {}) {
  try {
    const dir = path.join(repo.path, '.panel');
    const file = path.join(dir, 'state.json');
    const stDir = await Promise.resolve().then(() => fsApi.lstat(dir)).catch((e) => e);
    if (stDir instanceof Error) return unavailable(absent(stDir) ? 'missing' : 'error');
    if (stDir.isSymbolicLink()) return unavailable('unsafe');
    const stFile = await Promise.resolve().then(() => fsApi.lstat(file)).catch((e) => e);
    if (stFile instanceof Error) return unavailable(absent(stFile) ? 'missing' : 'error');
    if (stFile.isSymbolicLink() || !stFile.isFile() || stFile.size > MAX_BYTES) return unavailable('unsafe');
    const text = await fsApi.readFile(file, 'utf8');
    if (Buffer.byteLength(text) > MAX_BYTES) return unavailable('unsafe');
    let parsed;
    try { parsed = JSON.parse(text); } catch { return unavailable('invalid'); }
    const ok = validate(parsed, now());
    if (!ok) return unavailable('invalid');
    // Whole seconds on both sides: `at` and the commit date have no finer resolution than the clock of the agent.
    const activity = await lastActivity(repo, fsApi, gitRun).catch(() => null);
    const stale = activity !== null && ok.atMs < Math.floor(activity / 1000) * 1000;
    return { available: true, state: ok.state, next: ok.next, detail: ok.detail, at: ok.at, stale, reason: null };
  } catch { return unavailable('error'); }
}

module.exports = { readState };
