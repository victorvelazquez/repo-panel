'use strict';
// RP164: what the subagents of the ADOPTED session of a repo are doing, from the presence Gentle Pi publishes in <agentDir>/gentle-agents/presence/ (the same agent folder the sessions folder comes from).
// A session leaves <sha256 of its id>.<uuid of the incarnation>.{header,activity,discovery}.json there. Only a SMALL SUMMARY comes out of here: { signal, list: [{ name, state, minutes, idle }] }, at most MAX_SUBAGENTS entries.
// Nothing else leaves: no label, id, hash, digest, model, path, thread, prompt or result, and `discovery` (paths and ids of the disk) is never opened. The folder is only listed and read, never written.
// A file that is too big, cut or corrupt is skipped without inventing a state; a header older than STALE_MS says «no signal» and then NO subagent is listed (an old header still says running after its process died).
// Presence only SHOWS: nothing here holds or releases a button. Total: it never throws, the answer is null when there is nothing to show.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { loadConfig } = require('./config.js');
const S = require('./sessions.js');

const MAX_SUBAGENTS = 5;
const FILE_MAX = 64 * 1024;
const STALE_MS = 15 * 1000; // a header older than this has no signal (and one this far in the future is not a heartbeat either)
const SLOW_MS = 2 * 60 * 1000;
const STUCK_MS = 5 * 60 * 1000;
const MINUTES_MAX = 9999;
const TASKS_SCANNED = 200;
const INCARNATIONS_MAX = 64;
const STATES = ['working', 'slow', 'stuck']; // the closed list that travels
const RUNNING = 'running'; // the only status of a task that counts as a live subagent
const NAME = /^[A-Za-z0-9._-]{1,40}$/;
const UUID = '([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})';

const isObject = (x) => !!x && typeof x === 'object' && !Array.isArray(x);
const num = (x) => (typeof x === 'number' && Number.isFinite(x) ? x : null);
const nameOf = (x) => (typeof x === 'string' && NAME.test(x) ? x : null);
const minutesOf = (ms) => Math.min(MINUTES_MAX, Math.floor(Math.max(0, ms) / 60000));
const presenceDirFor = (base) => path.join(path.dirname(base), 'gentle-agents', 'presence');

// The only gate before the row: the closed shape or null. Extra keys are dropped, an entry out of the closed list or with a number that is not a safe integer is dropped, a name that is not valid is null,
// and with no signal nothing is listed. Nothing to show (no signal and no list is still something; a live signal with no entry is nothing) gives null.
function sanitize(x) {
  if (!isObject(x) || typeof x.signal !== 'boolean' || !Array.isArray(x.list)) return null;
  if (!x.signal) return { signal: false, list: [] };
  const list = [];
  for (const e of x.list) {
    if (list.length >= MAX_SUBAGENTS) break;
    if (!isObject(e) || !STATES.includes(e.state) || !Number.isSafeInteger(e.minutes) || e.minutes < 0 || !Number.isSafeInteger(e.idle) || e.idle < 0) continue;
    list.push({ name: nameOf(e.name), state: e.state, minutes: Math.min(e.minutes, MINUTES_MAX), idle: Math.min(e.idle, MINUTES_MAX) });
  }
  return list.length ? { signal: true, list } : null;
}

// One presence file as an object, or null: only a regular file of at most FILE_MAX bytes, JSON that is an object.
function readJson(file) {
  let fd;
  try {
    if (!fs.lstatSync(file).isFile()) return null; // a symlink named like a valid file is not followed
    fd = fs.openSync(file, 'r');
    const st = fs.fstatSync(fd);
    if (!st.isFile() || st.size > FILE_MAX) return null;
    const buf = Buffer.alloc(st.size);
    const n = fs.readSync(fd, buf, 0, st.size, 0);
    const v = JSON.parse(buf.toString('utf8', 0, n));
    return isObject(v) ? v : null;
  } catch { return null; } finally { if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* nothing to close */ } } }
}

// A header counts only with a heartbeat that is a plausible time (a number, after 0, not in the far future).
const heartbeatOf = (h, now) => { const t = num(h.heartbeat); return t !== null && t > 0 && t <= now + STALE_MS ? t : null; };
const claimsWork = (h) => isObject(h.counts) && ['running', 'queued', 'waiting'].some((k) => num(h.counts[k]) > 0);

function stateOf(idleMs) {
  return idleMs >= STUCK_MS ? 'stuck' : idleMs >= SLOW_MS ? 'slow' : 'working';
}

// The live subagents of an activity file: a task counts when it is `running` and both times are plausible; the oldest first, at most MAX_SUBAGENTS.
function subagentsFrom(act, now) {
  const tasks = isObject(act) && isObject(act.activity) && Array.isArray(act.activity.tasks) ? act.activity.tasks.slice(0, TASKS_SCANNED) : [];
  const out = [];
  for (const t of tasks) {
    const s = isObject(t) && isObject(t.summary) ? t.summary : null;
    if (!s || s.status !== RUNNING) continue;
    const started = num(s.startedAt), last = num(s.lastActivityAt);
    if (started === null || last === null || started <= 0 || last <= 0 || started > now + STALE_MS || last > now + STALE_MS) continue;
    out.push({ started, entry: { name: nameOf(s.agent), state: stateOf(now - last), minutes: minutesOf(now - started), idle: minutesOf(now - last) } });
  }
  return out.sort((a, b) => a.started - b.started).slice(0, MAX_SUBAGENTS).map((e) => e.entry);
}

// The answer for one session hash: the incarnation with the newest header heartbeat decides. Only names of the exact pattern of this hash are looked at; no path is ever built from the text of a file.
function fromFolder(dir, hash, now) {
  const re = new RegExp(`^${hash}\\.${UUID}\\.(header|activity)\\.json$`);
  const kinds = new Map(); // incarnation -> { header, activity } (the names found)
  for (const name of fs.readdirSync(dir).sort()) {
    const m = re.exec(name);
    if (!m) continue;
    if (!kinds.has(m[1]) && kinds.size >= INCARNATIONS_MAX) continue;
    kinds.set(m[1], { ...kinds.get(m[1]), [m[2]]: name });
  }
  let best = null;
  for (const [u, names] of kinds) {
    const h = names.header ? readJson(path.join(dir, names.header)) : null;
    const beat = h ? heartbeatOf(h, now) : null;
    if (beat !== null && (!best || beat > best.beat)) best = { u, h, beat, names };
  }
  if (!best) return null;
  if (now - best.beat > STALE_MS) return claimsWork(best.h) ? { signal: false, list: [] } : null;
  const list = best.names.activity ? subagentsFrom(readJson(path.join(dir, best.names.activity)), now) : [];
  return { signal: true, list };
}

// The answer is kept a few seconds per folder and session (one listing of a folder with hundreds of files per repo per snapshot is the cost, and the heartbeat is renewed every few seconds); only with the real clock.
const CACHE_MS = 3000;
const CACHE_MAX = 50;
const cache = new Map(); // `${dir}|${hash}` -> { at, value }
const clearCache = () => cache.clear();

// The summary of the ADOPTED session of a repo (the one the chat shows). `opts`: { dir, base, now } for tests; by default the folder is next to the sessions folder. Never throws.
function subagentsOf(id, opts) {
  try {
    const o = isObject(opts) ? opts : {};
    const dir = o.dir !== undefined ? o.dir : presenceDirFor(typeof o.base === 'string' && o.base ? o.base : S.baseDir());
    if (typeof dir !== 'string' || !dir || dir.includes('\0')) return null;
    const { key } = S.sessionKeyFor(id);
    const stored = (loadConfig().sessions || {})[key];
    const sid = stored && typeof stored.id === 'string' && S.SESSION_ID.test(stored.id) ? stored.id : null;
    if (!sid) return null;
    const hash = crypto.createHash('sha256').update(sid).digest('hex');
    const injected = Number.isFinite(o.now);
    const at = injected ? o.now : typeof o.clock === 'function' ? o.clock() : Date.now(); // `clock`: a fake real clock for tests
    const ck = `${dir}|${hash}`;
    const hit = injected ? null : cache.get(ck);
    if (hit && at - hit.at >= 0 && at - hit.at < CACHE_MS) return hit.value;
    const value = sanitize(fromFolder(dir, hash, at));
    if (!injected) { if (cache.size >= CACHE_MAX && !cache.has(ck)) cache.delete(cache.keys().next().value); cache.set(ck, { at, value }); }
    return value;
  } catch { return null; }
}

module.exports = { MAX_SUBAGENTS, FILE_MAX, STALE_MS, SLOW_MS, STUCK_MS, sanitize, presenceDirFor, subagentsOf, clearCache };
