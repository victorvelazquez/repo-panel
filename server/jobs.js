'use strict';
// RP161: how many background jobs the session of a repo still waits for. The pi session keeps a file (the one the chat already reads); a job or a background subagent leaves its START there (the answer of the tool that launched
// it) and its END (a notice, or the answer of job_stop). The panel never sees the live stream of those, so it counts them from the file: a start with no end after it is a pending job.
// Only a NUMBER comes out of here: the paths, the labels and the words of the file stay in the server. What the code cannot understand counts as no job (the buttons behave as they do today); a start older than the 512 KB window
// is not seen (it counts less, the safe side); only the starts written after the session was started by the panel count (the jobs of an older process are gone).
const fs = require('node:fs');
const path = require('node:path');
const { loadConfig } = require('./config.js');
const S = require('./sessions.js');

const MAX_JOBS = 99;
const ID_MAX = 1000; // an outputPath or a taskId longer than this is not one
const CACHE_MAX = 200;
const cache = new Map(); // `${file}|${since}|${size}|${mtimeMs}` -> the count (the file is read again only when it changed)

const isObject = (x) => !!x && typeof x === 'object' && !Array.isArray(x);
const idOf = (v) => (typeof v === 'string' && v.length > 0 && v.length <= ID_MAX ? v : null);
// The time of an entry: a number of milliseconds or an ISO text; anything else is no time.
const timeOf = (t) => (typeof t === 'number' ? t : typeof t === 'string' ? Date.parse(t) : NaN);
const sinceOf = (opts) => (isObject(opts) && typeof opts.since === 'number' && Number.isFinite(opts.since) ? opts.since : null);

function step(e, since, pending) {
  if (!isObject(e)) return;
  if (e.type === 'message' && isObject(e.message) && e.message.role === 'toolResult') {
    const tool = e.message.toolName;
    const d = e.message.details;
    if (!isObject(d)) return;
    if (tool === 'bash_background' || tool === 'monitor') {
      const j = d.gentleJobs;
      const id = isObject(j) && j.status === 'running' ? idOf(j.outputPath) : null;
      const at = timeOf(e.timestamp);
      if (id && Number.isFinite(at) && at >= since) pending.add(`job:${id}`);
    } else if (tool === 'job_stop') {
      const j = d.gentleJobs;
      const id = isObject(j) && (j.status === 'stopped' || j.status === 'exited') ? idOf(j.outputPath) : null;
      if (id) pending.delete(`job:${id}`);
    } else if (tool === 'subagent_run') {
      const a = d.gentleAgents;
      const id = isObject(a) && a.mode === 'background' && (a.status === 'queued' || a.status === 'running') ? idOf(a.taskId) : null;
      const at = timeOf(e.timestamp);
      if (id && Number.isFinite(at) && at >= since) pending.add(`agent:${id}`);
    }
  } else if (e.type === 'custom_message' && isObject(e.details)) {
    if (e.customType === 'gentle-jobs.notice') {
      const j = e.details.gentleJobs;
      const id = isObject(j) && typeof j.status === 'string' && j.status !== '' && j.status !== 'running' ? idOf(j.outputPath) : null; // a monitor tells many times while it runs (status running): that is not an end; any other status is (a state pi adds later must not pin the buttons)
      if (id) pending.delete(`job:${id}`);
    } else if (e.customType === 'gentle-agents.result') {
      const a = e.details.gentleAgents;
      const id = isObject(a) && typeof a.status === 'string' && a.status !== 'queued' && a.status !== 'running' ? idOf(a.taskId) : null;
      if (id) pending.delete(`agent:${id}`);
    }
  }
}

// The pending jobs of a list of parsed entries, in file order. `since` (ms) is when the panel started the session: with none, nothing counts. Total: always a safe integer from 0 to MAX_JOBS.
function countPending(entries, opts) {
  const since = sinceOf(opts);
  if (since === null || !Array.isArray(entries)) return 0;
  const pending = new Set();
  for (const e of entries) { try { step(e, since, pending); } catch { /* an entry nobody can read counts for nothing */ } }
  return Math.min(pending.size, MAX_JOBS);
}

const parse = (line) => { try { return JSON.parse(line); } catch { return null; } };

// The same from a session file: only the last 512 KB (the window of the chat) are read, the first line of the window may be partial and is dropped, a last line cut in half does not parse and is skipped.
function pendingFromFile(file, opts) {
  const since = sinceOf(opts);
  if (since === null || typeof file !== 'string' || !file) return 0;
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const st = fs.fstatSync(fd);
    if (!st.isFile()) return 0;
    const key = `${file}|${since}|${st.size}|${st.mtimeMs}`;
    if (cache.has(key)) return cache.get(key);
    const start = Math.max(0, st.size - S.CHAT_WINDOW);
    const entries = S.linesOf(S.readChunk(fd, start, st.size - start), start > 0, false).map(parse);
    const n = countPending(entries, { since });
    if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
    cache.set(key, n);
    return n;
  } catch { return 0; } finally { if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* nothing to close */ } } }
}

// The jobs of the ADOPTED session of a repo (the one the chat shows). `since` is when the panel started that session; with none (not hosted, closed, unknown) nothing counts. Never throws.
function jobsOf(id, since, base = S.baseDir()) {
  try {
    if (typeof since !== 'number' || !Number.isFinite(since)) return 0;
    const { key, folder } = S.sessionKeyFor(id);
    const stored = (loadConfig().sessions || {})[key];
    const sid = stored && typeof stored.id === 'string' && S.SESSION_ID.test(stored.id) ? stored.id : null;
    if (!sid) return 0;
    const dir = S.sessionsDirFor(folder, base);
    const name = fs.readdirSync(dir).sort().find((n) => S.isSessionFile(n, sid));
    return name ? pendingFromFile(path.join(dir, name), { since }) : 0;
  } catch { return 0; }
}

module.exports = { MAX_JOBS, countPending, pendingFromFile, jobsOf, cacheSize: () => cache.size };
