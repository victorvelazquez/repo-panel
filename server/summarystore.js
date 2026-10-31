'use strict';
// RP78: the Summary kept in memory. Every repo has five facts (local, prs, roadmap, state, last movement), each with its own age and
// interval; a background loop refreshes the due ones, and snapshot() builds the answer from memory without reading anything. A failed
// read keeps the last good value and marks it `stale`; a repo whose facts were not all read yet is a calm `loading` row.
// RP80: a sixth fact, `req` (requirementsFor, slow), is kept for the board only (the Summary never needs it), and every read that changes an
// outcome bumps a revision counter, so board(since) answers from memory, reading nothing, only what moved after `since`.
// The session state is never read here: setSession feeds it (the live warmer, RP77). Nothing is started by creating the store.
const path = require('node:path');
const lib = require('../lib.js');
const exec = require('./exec.js');
const { HttpError } = require('./errors.js');
const { loadConfig } = require('./config.js');
const { localState } = require('./local.js');
const { prState } = require('./github.js');
const { roadmapState } = require('./roadmap.js');
const { readState } = require('./state.js');
const { requirementsFor } = require('./requirements.js');
const view = require('../public/view.js');
const { safeAnalyse, tally, loadingRow, lastMovementOf, pool } = require('./summary.js');

const KINDS = ['local', 'prs', 'roadmap', 'state', 'last', 'req'];
const SUMMARY_KINDS = KINDS.filter((k) => k !== 'req'); // the Summary never shows req, so it is never one of its stale marks
const VALUES = ['local', 'prs', 'roadmap', 'state', 'req']; // the facts board() carries as values (`last` only as a time)
const NEEDED = ['local', 'prs', 'roadmap', 'state']; // a row is real once each of these was read, even in error
const FAST = new Set(['local', 'state']);
// local and state cost about eight Git calls per repo: 15 s keeps a page with 15 repos near the load of the old 20 s rebuild.
const INTERVALS = { fast: 15000, slow: 60000, idleFast: 30000, idleSlow: 300000, hotPrs: 15000, hotLocal: 10000 };
const HOT_KEY = { prs: 'hotPrs', local: 'hotLocal' }; // RP80b: a hot repo (V.isHotRepo) reads these two faster while a client is active
const CATCH_UP_DELAY_MS = 5000;
const READ_TIMEOUT_MS = 90000; // a reader that hangs outside exec must not pin its repo for ever
const SESSION_TTL_MS = 30000; // the warmer publishes every 3 s: a state older than this is no longer being fed (it stopped, or Orca is down)
const STALE_FACTOR = 3;
const IDLE_AFTER_MS = 60000;
const POOL = 3;
const FIRST_DELAY_MS = 100;
const LOOP_MS = 1000;

const READERS = {
  local: (d, repo) => (d.local || localState)(repo),
  prs: (d, repo) => (d.prs || prState)(repo),
  roadmap: (d, repo) => (d.roadmap || roadmapState)(repo),
  state: (d, repo) => (d.state || readState)(repo),
  last: (d, repo) => lastMovementOf(repo, d.git || exec.git),
  req: (d, repo) => (d.requirements || requirementsFor)(repo),
};

// Gives up on a promise after `ms` (the timer is unref-ed and cleared); the late answer is ignored.
function withTimeout(promise, ms) {
  let timer;
  const limit = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`Read timed out after ${ms} ms`)), ms); if (timer.unref) timer.unref(); });
  return Promise.race([promise, limit]).finally(() => clearTimeout(timer));
}

function createSummaryStore({
  deps = {}, now = Date.now, loadCfg = loadConfig, setTimer = setTimeout, clearTimer = clearTimeout, intervals, idleAfterMs = IDLE_AFTER_MS, pool: poolSize = POOL, waitForClient = true, timeout = withTimeout, catchUpDelayMs = CATCH_UP_DELAY_MS,
} = {}) {
  const iv = { ...INTERVALS, ...intervals };
  const facts = new Map(); // repo id -> { [kind]: { value, at (last success), tried (last attempt), failed, error } }
  const revOf = new Map(); // repo id -> the revision of its last changed read
  let rev = 0;
  const sessions = new Map(); // repo id -> pi state, as the warmer publishes it
  const flights = new Map(); // repo id -> the read cycle in flight (ticks and refreshes of one repo coalesce)
  let lastTouch = -Infinity;
  let ticking = null;
  let timer = null;
  let started = false;
  const catching = new Map(); // repo id -> the one pending delayed read of catchUp

  const interval = (kind, idle, hot = false) => (idle ? (FAST.has(kind) ? iv.idleFast : iv.idleSlow) : hot && HOT_KEY[kind] ? iv[HOT_KEY[kind]] : (FAST.has(kind) ? iv.fast : iv.slow));
  // The rule is the page's own, looked up at call time, on the facts held now.
  const isHot = (f) => !!view.isHotRepo({ local: f.local.value, prs: f.prs.value });
  const isIdle = () => now() - lastTouch >= idleAfterMs;
  const touch = () => { lastTouch = now(); };
  // Has any client (a snapshot, a board read or a touch) ever asked? Explicit reads and the loop do not count. The action hooks of the server
  // use it: no client, no work (a server nobody asked must not start reads after an action).
  const awake = () => lastTouch !== -Infinity;

  // The repos of the config at call time, in config order; what belongs to a repo that is gone is dropped.
  function reposOf(cfg = loadCfg()) {
    const roomOf = new Map((cfg.rooms || []).flatMap((r) => r.repos.map((id) => [id, r.name])));
    const repos = cfg.groups.flatMap((g) => g.repos.map((r) => ({ ...r, id: lib.repoId(r.path), group: g.name, room: roomOf.get(lib.repoId(r.path)) || null })));
    const ids = new Set(repos.map((r) => r.id));
    for (const map of [facts, sessions, revOf]) for (const id of map.keys()) if (!ids.has(id)) map.delete(id);
    return repos;
  }
  const factsOf = (id) => {
    if (!facts.has(id)) facts.set(id, Object.fromEntries(KINDS.map((k) => [k, { value: undefined, at: null, tried: null, failed: false, error: null }])));
    return facts.get(id);
  };

  // What a read leaves on a fact, as one string: a different string is a change the board has to tell about (only `at` moving is not).
const outcome = (fact) => JSON.stringify([fact.failed, fact.error, fact.value === undefined ? '\u0000' : fact.value]);

// Never rejects: a failure (throw or { error }) is kept on the fact, with the last good value.
  async function read(repo, fact, kind) {
    const before = outcome(fact);
    let value;
    let error = null;
    try {
      value = await timeout((async () => READERS[kind](deps, repo))(), READ_TIMEOUT_MS);
      if (value && value.error) error = String(value.error);
    } catch (e) { error = (e && e.message) || 'Read failed'; }
    const t = now();
    fact.tried = t;
    fact.failed = error !== null;
    fact.error = error;
    // A git that cannot say keeps the previous movement.
    if (error === null && !(kind === 'last' && value === null && fact.value)) { fact.value = value; fact.at = t; }
    if (outcome(fact) !== before) revOf.set(repo.id, ++rev);
  }

  // One read cycle of a repo: the due facts (all when forced), all at once; a cycle already in flight is joined.
  function cycle(repo, force) {
    if (flights.has(repo.id)) return flights.get(repo.id);
    const f = factsOf(repo.id);
    const idle = isIdle();
    const hot = !idle && isHot(f);
    const kinds = KINDS.filter((k) => force || f[k].tried === null || now() - f[k].tried >= interval(k, idle && !f[k].failed, hot));
    if (!kinds.length) return Promise.resolve();
    const flight = exec.withPriority('background', () => Promise.all(kinds.map((k) => read(repo, f[k], k)))).finally(() => flights.delete(repo.id));
    flights.set(repo.id, flight);
    return flight;
  }

  // The repo list is read inside the promise: a config that cannot be loaded rejects it, never the caller's turn (the loop must survive).
  const run = (force) => Promise.resolve().then(() => pool(reposOf(), poolSize, (repo) => cycle(repo, force)));
  // A forced sweep that is already running is joined: twenty clicks on Refresh are one sweep, not twenty. It is freed when it ends, failed or not.
  let sweeping = null;
  const refreshAll = () => {
    if (!sweeping) sweeping = run(true).then(() => {}, () => {}).finally(() => { sweeping = null; });
    return sweeping;
  };
  async function refreshRepo(id) {
    const repo = reposOf().find((r) => r.id === id);
    if (!repo) throw new HttpError(404, 'Unknown repo');
    await cycle(repo, true);
  }
  // RP80b: after an action of the person, read ALL facts of that repo now and once more catchUpDelayMs later (one pending timer per repo).
  // Not a client (no touch); never rejects; an id that is not a repo is ignored.
  async function catchUp(id) {
    try {
      const repo = reposOf().find((r) => r.id === id);
      if (!repo) return;
      if (!catching.has(id)) {
        const t = setTimer(async () => {
          catching.delete(id);
          try { const again = reposOf().find((r) => r.id === id); if (again) await cycle(again, true); } catch { /* the delayed read is best effort */ }
        }, catchUpDelayMs);
        if (t && typeof t.unref === 'function') t.unref();
        catching.set(id, t);
      }
      await cycle(repo, true);
    } catch { /* never rejects */ }
  }
  // No client, no work: until a page has asked (the first snapshot) the loop reads nothing. A real server started by a test or a second
  // launch stays passive; refreshRepo and refreshAll are explicit and always read.
  function tick() {
    if (waitForClient && lastTouch === -Infinity) return Promise.resolve();
    if (!ticking) ticking = run(false).catch(() => {}).finally(() => { ticking = null; });
    return ticking;
  }

  function setSession(id, state) { sessions.set(id, { state, at: now() }); }

  // Facts that failed their last read, or whose last success is older than 3 times their (active) interval.
  const staleOf = (f, t, kinds = SUMMARY_KINDS) => {
    const hot = isHot(f);
    return kinds.filter((k) => f[k].failed || (f[k].at !== null && t - f[k].at > STALE_FACTOR * interval(k, false, hot)));
  };

  // A page asking is activity; the first one starts the work at once, without waiting for the next beat.
  function wake() {
    const first = lastTouch === -Infinity;
    touch();
    if (first && started && waitForClient) tick();
  }

  // The board, synchronous and from memory: the repos bumped after `since` (all of them for 0 or a value that is not a non-negative integer).
  function board(since) {
    wake();
    const from = Number.isInteger(since) && since > 0 ? since : 0;
    const t = now();
    const repos = {};
    const all = reposOf();
    for (const repo of all) {
      const f = facts.get(repo.id);
      const bumped = revOf.get(repo.id) || 0;
      if (from && bumped <= from) continue;
      const entry = { rev: bumped, at: {}, errors: {}, stale: f ? staleOf(f, t, KINDS) : [] };
      for (const k of f ? KINDS : []) {
        if (f[k].at !== null) entry.at[k] = f[k].at;
        if (f[k].failed) entry.errors[k] = f[k].error;
        if (VALUES.includes(k) && f[k].value !== undefined) entry[k] = structuredClone(f[k].value);
      }
      repos[repo.id] = entry;
    }
    return { rev, repos, refreshing: all.filter((r) => flights.has(r.id)).map((r) => r.id) };
  }

  function snapshot() {
    wake();
    const cfg = loadCfg();
    const t = now();
    const results = reposOf(cfg).map((repo) => {
      const info = { id: repo.id, name: path.basename(repo.path), group: repo.group, room: repo.room };
      const f = facts.get(repo.id);
      if (!f || NEEDED.some((k) => f[k].tried === null)) return { row: loadingRow(info), why: [] };
      const last = f.last.value || null;
      const word = sessions.get(repo.id);
      const session = word && t - word.at < SESSION_TTL_MS ? word.state : 'unknown';
      const broken = NEEDED.find((k) => f[k].value === undefined);
      if (broken) return safeAnalyse({ repo: info, last, session, error: f[broken].error });
      const out = safeAnalyse({ repo: info, snoozed: cfg.snoozed, now: t, local: f.local.value, prs: f.prs.value, roadmap: f.roadmap.value, state: f.state.value, session, last });
      const stale = staleOf(f, t);
      return stale.length && !out.row.error ? { ...out, row: { ...out.row, stale: { facts: stale } } } : out;
    });
    return tally(results, t);
  }

  function arm(ms) {
    timer = setTimer(async () => {
      timer = null;
      await tick();
      if (started) arm(LOOP_MS);
    }, ms);
    if (timer && typeof timer.unref === 'function') timer.unref();
  }
  function start() { if (started) return; started = true; arm(FIRST_DELAY_MS); }
  function stop() { started = false; if (timer) { clearTimer(timer); timer = null; } for (const t of catching.values()) clearTimer(t); catching.clear(); }

  return { snapshot, board, refreshRepo, catchUp, refreshAll, setSession, touch, awake, start, stop, tick };
}

module.exports = { createSummaryStore };
