'use strict';
// RP78: the Summary kept in memory. Every repo has five facts (local, prs, roadmap, state, last movement), each with its own age and
// interval; a background loop refreshes the due ones, and snapshot() builds the answer from memory without reading anything. A failed
// read keeps the last good value and marks it `stale`; a repo whose facts were not all read yet is a calm `loading` row.
// RP80: a sixth fact, `req` (requirementsFor, slow), is kept for the board only (the Summary never needs it), and every read that changes an
// outcome bumps a revision counter, so board(since) answers from memory, reading nothing, only what moved after `since`.
// RP150: a seventh kind, `fetch` (git fetch of the remote, never the Summary's business), runs detached from the repo cycle so a slow fetch holds none of the other reads.
// The session state is read from `sessionOf` (the RPC host) at snapshot time. Nothing is started by creating the store.
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
const { fetchRepo } = require('./fetcher.js');
const view = require('../public/view.js');
const { stateFrom, jobsFrom, subagentsFrom, LIVE_RAW, safeAnalyse, tally, loadingRow, lastMovementOf, pool } = require('./summary.js');

const KINDS = ['local', 'prs', 'roadmap', 'state', 'last', 'req', 'fetch'];
const SUMMARY_KINDS = KINDS.filter((k) => k !== 'req' && k !== 'fetch'); // the Summary never shows req or fetch, so they are never one of its stale marks
const BOARD_KINDS = KINDS.filter((k) => k !== 'fetch'); // fetch is bookkeeping: the board neither carries nor marks it
const VALUES = ['local', 'prs', 'roadmap', 'state', 'req']; // the facts board() carries as values (`last` only as a time)
const NEEDED = ['local', 'prs', 'roadmap', 'state']; // a row is real once each of these was read, even in error
const FAST = new Set(['local', 'state']);
// local and state cost about eight Git calls per repo: 15 s keeps a page with 15 repos near the load of the old 20 s rebuild.
const INTERVALS = { fast: 15000, slow: 60000, idleFast: 30000, idleSlow: 300000, hotPrs: 15000, hotLocal: 10000, fetch: 300000, hotFetch: 60000 };
const FETCH_MAX_MS = 15 * 60 * 1000; // the longest wait after failed fetches (the interval doubles per failure)
const HOT_KEY = { prs: 'hotPrs', local: 'hotLocal' }; // RP80b: a hot repo (V.isHotRepo) reads these two faster while a client is active
const CATCH_UP_DELAY_MS = 5000;
const READ_TIMEOUT_MS = 90000; // a reader that hangs outside exec must not pin its repo for ever
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
  // A skipped round (no remote, git locked) is no failure; anything else but a clean exit is.
  fetch: async (d, repo) => {
    const r = await (d.fetch || fetchRepo)(repo, { deps: { git: d.git } });
    return r.skipped || r.code === 0 ? r : { error: exec.firstLine(r.stderr) || 'git fetch failed' };
  },
};

// Gives up on a promise after `ms` (the timer is unref-ed and cleared); the late answer is ignored.
function withTimeout(promise, ms) {
  let timer;
  const limit = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`Read timed out after ${ms} ms`)), ms); if (timer.unref) timer.unref(); });
  return Promise.race([promise, limit]).finally(() => clearTimeout(timer));
}

function createSummaryStore({
  deps = {}, now = Date.now, loadCfg = loadConfig, setTimer = setTimeout, clearTimer = clearTimeout, intervals, idleAfterMs = IDLE_AFTER_MS, pool: poolSize = POOL, waitForClient = true, timeout = withTimeout, catchUpDelayMs = CATCH_UP_DELAY_MS, sessionOf, jobsOf, subagentsOf,
} = {}) {
  const iv = { ...INTERVALS, ...intervals };
  const facts = new Map(); // repo id -> { [kind]: { value, at (last success), tried (last attempt), failed, error } }
  const revOf = new Map(); // repo id -> the revision of its last changed read
  let rev = 0;
  const flights = new Map(); // repo id -> the read cycle in flight (ticks and refreshes of one repo coalesce)
  let lastTouch = -Infinity;
  let ticking = null;
  let timer = null;
  let started = false;
  const catching = new Map(); // repo id -> the one pending delayed read of catchUp
  const fetching = new Map(); // repo id -> the fetch round in flight
  const roadmapAgain = new Set(); // repo ids whose roadmap is due now, because a fetch brought something

  const interval = (kind, idle, hot = false) => (idle ? (FAST.has(kind) ? iv.idleFast : iv.idleSlow) : hot && HOT_KEY[kind] ? iv[HOT_KEY[kind]] : (FAST.has(kind) ? iv.fast : iv.slow));
  // The rule is the page's own, looked up at call time, on the facts held now.
  // A fetch every `fetch` ms (`hotFetch` for a hot repo, the slow interval when idle), doubled per failure in a row up to FETCH_MAX_MS.
  const fetchEvery = (f, idle, hot) => Math.min(FETCH_MAX_MS, (idle ? iv.idleSlow : hot ? iv.hotFetch : iv.fetch) * 2 ** f.fetch.fails);
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
    for (const map of [facts, revOf]) for (const id of map.keys()) if (!ids.has(id)) map.delete(id);
    for (const id of roadmapAgain) if (!ids.has(id)) roadmapAgain.delete(id);
    return repos;
  }
  const factsOf = (id) => {
    if (!facts.has(id)) facts.set(id, Object.fromEntries(KINDS.map((k) => [k, { value: undefined, at: null, tried: null, failed: false, error: null, fails: 0 }])));
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
    if (kind !== 'fetch' && outcome(fact) !== before) revOf.set(repo.id, ++rev);
  }

  // One fetch round: never rejects. A failure counts toward the backoff; a fetch that really ran makes the roadmap due again.
  async function fetchRound(repo, f) {
    await read(repo, f.fetch, 'fetch');
    f.fetch.fails = f.fetch.failed ? f.fetch.fails + 1 : 0;
    if (!f.fetch.failed && !f.fetch.value.skipped) roadmapAgain.add(repo.id);
  }

  // One read cycle of a repo: the due facts (all when forced), all at once; a cycle already in flight is joined.
  function cycle(repo, force) {
    if (flights.has(repo.id)) return flights.get(repo.id);
    const f = factsOf(repo.id);
    const idle = isIdle();
    const hot = !idle && isHot(f);
    // A forced cycle never fetches (the network is not the business of a refresh); fetch is due on its own interval, or at the first look.
    const due = (k) => (k === 'fetch' ? !force && (f.fetch.tried === null || now() - f.fetch.tried >= fetchEvery(f, idle, hot)) : force || f[k].tried === null || now() - f[k].tried >= interval(k, idle && !f[k].failed, hot));
    if (due('fetch') && !fetching.has(repo.id)) {
      fetching.set(repo.id, exec.withPriority('background', () => fetchRound(repo, f)).finally(() => fetching.delete(repo.id)));
    }
    const kinds = KINDS.filter((k) => k !== 'fetch' && (due(k) || (k === 'roadmap' && roadmapAgain.has(repo.id))));
    if (kinds.includes('roadmap')) roadmapAgain.delete(repo.id);
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
      const entry = { rev: bumped, at: {}, errors: {}, stale: f ? staleOf(f, t, BOARD_KINDS) : [] };
      for (const k of f ? BOARD_KINDS : []) {
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
      // The session is the RPC host's live state, read now; without a getter it is unknown.
      const session = sessionOf ? stateFrom(sessionOf, repo.id) : 'unknown';
      // RP161: how many background jobs that session waits for, read now like its state (only a live session can wait for one).
      const jobs = jobsOf && LIVE_RAW.includes(session) ? jobsFrom(jobsOf, repo.id) : 0;
      // RP164: what its subagents do, read now like the jobs (shown only, never a hold).
      const subagents = subagentsOf && LIVE_RAW.includes(session) ? subagentsFrom(subagentsOf, repo.id) : null;
      const broken = NEEDED.find((k) => f[k].value === undefined);
      if (broken) return safeAnalyse({ repo: info, last, session, jobs, subagents, error: f[broken].error });
      const out = safeAnalyse({ repo: info, snoozed: cfg.snoozed, now: t, local: f.local.value, prs: f.prs.value, roadmap: f.roadmap.value, state: f.state.value, session, jobs, subagents, last });
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

  return { snapshot, board, refreshRepo, catchUp, refreshAll, touch, awake, start, stop, tick };
}

module.exports = { createSummaryStore };
