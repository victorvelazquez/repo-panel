'use strict';
// GET /api/summary: one read-only row per configured repo (progress, session, next unit, what blocks it, last movement and
// the one main action). It only reuses what the other routes already read; Orca is listed once and only shown (never sent
// to). A repo whose git or gh read fails gets an error row and the others are unaffected.
const path = require('node:path');
const lib = require('../lib.js');
const V = require('../public/view.js');
const { git } = require('./exec.js');
const { loadConfig } = require('./config.js');
const { localState } = require('./local.js');
const { prState } = require('./github.js');
const { roadmapState } = require('./roadmap.js');
const { readState } = require('./state.js');
const { orcaTerminal, scanSessions } = require('./pi.js');

const POOL = 6;
const CACHE_MS = 10 * 1000;
const MAX_BLOCKING = 3;
const SESSION_OF = { closed: 'none', idle: 'free', busy: 'working', asking: 'waiting' };
const ANSWER = 'Answer the question in the pi session';
// Urgency for the filter, lower is more urgent: a session asking you 0, failing CI 1, then the workQueue kinds in their own order
// (lib.QUEUE_RANK plus 2), then a working session, a blocked unit and everything else.
const QUEUE_BASE = 2;
const WORKING = QUEUE_BASE + Math.max(...Object.values(lib.QUEUE_RANK)) + 1;

const caches = new WeakMap();

const sessionOf = (s) => ({ state: SESSION_OF[s] || 'unknown' });
const noProgress = { total: null, completada: null, enRevision: null, bloqueada: null, pendiente: null, enCurso: null };

// Every row counts once: Completada and Bloqueada as written, then the derived En revisión, then En curso (derived or
// written), then Pendiente (a derived Lista stays here). A row with an unknown state only counts in `total`.
function progressOf(rm) {
  if (!rm || rm.available !== true || !Array.isArray(rm.rows)) return noProgress;
  const derived = rm.derived || {};
  const out = { total: rm.rows.length, completada: 0, enRevision: 0, bloqueada: 0, pendiente: 0, enCurso: 0 };
  for (const r of rm.rows) {
    const d = derived[r.id] && derived[r.id].state;
    if (r.estado === 'Completada') out.completada++;
    else if (r.estado === 'Bloqueada') out.bloqueada++;
    else if (d === 'En revisión') out.enRevision++;
    else if (d === 'En curso' || r.estado === 'En curso') out.enCurso++;
    else if (r.estado === 'Pendiente') out.pendiente++;
  }
  return out;
}

const waitsOf = (r) => ({ unit: r.id, waitsFor: r.dependsOn.slice(), external: r.externalDeps.slice() });

// Bloqueada rows, then, when nothing can be taken, the first Pendiente row with unmet table dependencies.
function blockingOf(rm) {
  if (!rm || rm.available !== true || !Array.isArray(rm.rows)) return [];
  const done = new Set(rm.rows.filter((r) => r.estado === 'Completada').map((r) => r.id));
  const out = rm.rows.filter((r) => r.estado === 'Bloqueada').map(waitsOf);
  if (!rm.next) {
    const stuck = rm.rows.find((r) => r.estado === 'Pendiente' && r.dependsOn.some((id) => !done.has(id)));
    if (stuck) out.push({ ...waitsOf(stuck), waitsFor: stuck.dependsOn.filter((id) => !done.has(id)) });
  }
  return out.slice(0, MAX_BLOCKING);
}

const LABELS = {
  merge: (a) => `Merge #${a.pr}${a.title ? ` ${a.title}` : ''}`,
  branch: () => 'Start from a fresh base branch (/flow-base)',
  manual: (a) => a.reason,
  waiting: (a) => (a.next ? `Waiting: ${a.next}` : `Waiting: ${a.state}`),
  deliver: () => 'Deliver the changes (/flow-commit, /flow-pr)',
  start: (a) => `Start ${a.unit.id}${a.unit.entrega ? `: ${a.unit.entrega}` : ''}`,
};

// The first entry of lib.workQueue for this repo; a session waiting for an answer comes before all of it.
function actionOf(f, session, next) {
  if (session.state === 'waiting') return { kind: 'answer', label: ANSWER, pr: null };
  const prs = (f.prs && f.prs.prs) || [];
  const snoozed = new Set(f.snoozed || []);
  const flags = V.queueFlags(f.local, f.state, null, { now: f.now });
  const [a] = lib.workQueue([{
    id: f.repo.id, name: f.repo.name, ...flags,
    ready: prs.filter((p) => p.ready && !snoozed.has(`${f.repo.id}:${p.number}`)).map((p) => ({ number: p.number, title: p.title })),
    stale: !!(f.prs && f.prs.stale), dirty: f.local.files.length > 0, unpushed: (f.local.ahead || 0) > 0, hasPrs: prs.length > 0,
    next: next ? { id: next.id, entrega: next.entrega } : null,
  }]);
  return a ? { kind: a.kind, label: LABELS[a.kind](a), pr: a.kind === 'merge' ? a.pr : null } : null;
}

function rankOf(session, failingCi, action, blocking) {
  if (session.state === 'waiting') return 0;
  if (failingCi) return 1;
  if (action && action.kind in lib.QUEUE_RANK) return QUEUE_BASE + lib.QUEUE_RANK[action.kind];
  if (session.state === 'working') return WORKING;
  return blocking.length ? WORKING + 1 : WORKING + 2;
}

// The row of one repo and why it needs attention (a list of reasons, empty when it does not).
function analyse(f) {
  const { id, name, group, room } = f.repo;
  const session = sessionOf(f.session);
  const error = f.error || (f.local && f.local.error) || (f.prs && f.prs.error) || null;
  const last = f.last && f.last.at ? { at: f.last.at, what: f.last.what ?? null } : { at: null, what: null };
  if (error || !f.local || !f.prs) {
    return { row: { id, name, group, room: room ?? null, branch: null, progress: noProgress, session, next: null, blocking: [], lastMovement: last, action: null, error: String(error || 'No data'), needs: false, rank: WORKING + 2 }, why: [] };
  }
  const rm = f.roadmap;
  const nx = rm && rm.available === true ? rm.next : null;
  const next = nx ? { id: nx.id, entrega: nx.entrega, resultadoVisible: nx.resultadoVisible } : null;
  const blocking = blockingOf(rm);
  const why = [];
  if (session.state === 'waiting') why.push('The pi session is waiting for an answer');
  const failingCi = (f.prs.prs || []).filter((p) => p.checks && p.checks.state === 'failed');
  for (const p of failingCi) why.push(`PR #${p.number} has failing checks`);
  if (rm && rm.available === true && rm.rows.some((r) => r.estado === 'Bloqueada')) why.push(`Blocked: ${blocking.filter((b) => rm.rows.find((r) => r.id === b.unit && r.estado === 'Bloqueada')).map((b) => b.unit).join(', ')}`);
  const action = actionOf(f, session, nx);
  const row = {
    id, name, group, room: room ?? null, branch: f.local.branch ?? null, progress: progressOf(rm), session, next, blocking,
    lastMovement: last, action, error: null, needs: why.length > 0, rank: rankOf(session, failingCi.length > 0, action, blocking),
  };
  return { row, why };
}

const summarize = (facts) => analyse(facts).row;

// analyse runs outside the per-repo isolation of gather: an exception in it is that repo's error row, never the summary's.
function safeAnalyse(f) {
  try { return analyse(f); } catch (e) { return analyse({ repo: f.repo, last: f.last, session: f.session, error: e.message || 'Analysis failed' }); }
}

// The pi state of a repo (closed | idle | busy | asking | ambiguous | unknown) from the one `list` already fetched; null
// terminals (Orca could not be listed) is unknown, never closed. Same reading as piStatus.
async function sessionState(repoPath, orca, terminals) {
  if (!terminals) return 'unknown';
  try {
    const { sessions, failed } = await scanSessions(repoPath, orca, terminals, false, true);
    if (!sessions.length) return failed ? 'unknown' : 'closed';
    if (sessions.length > 1) return 'ambiguous';
    return sessions[0].state === 'idle' || sessions[0].state === 'typed' ? 'idle' : sessions[0].state;
  } catch { return 'unknown'; }
}

async function lastMovementOf(repo, gitRun) {
  const r = await gitRun(repo.path, ['log', '-1', '--format=%cI%n%s', 'HEAD']).catch(() => null);
  if (!r || r.code !== 0) return null;
  const [at, ...subject] = r.stdout.split('\n');
  return /^\d{4}-\d\d-\d\dT/.test(at) ? { at: at.trim(), what: subject.join(' ').trim() } : null;
}

async function gather(repo, ctx) {
  const { deps, terminals, cfg } = ctx;
  const f = { repo: { id: repo.id, name: path.basename(repo.path), group: repo.group, room: ctx.roomOf.get(repo.id) || null }, snoozed: cfg.snoozed, now: ctx.now };
  try {
    const [local, prs, roadmap, state, session, last] = await Promise.all([
      (deps.local || localState)(repo), (deps.prs || prState)(repo), (deps.roadmap || roadmapState)(repo),
      (deps.state || readState)(repo), sessionState(repo.path, ctx.orca, terminals), lastMovementOf(repo, deps.git || git),
    ]);
    return { ...f, local, prs, roadmap, state, session, last };
  } catch (e) {
    return { ...f, error: e.message || 'Read failed', session: 'unknown' };
  }
}

// At most `size` tasks in flight; results keep the order of `items`.
async function pool(items, size, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, async () => {
    while (i < items.length) { const at = i++; out[at] = await fn(items[at]); }
  }));
  return out;
}

async function build(deps) {
  const cfg = loadConfig();
  const orca = deps.orca || orcaTerminal;
  const now = (deps.now || Date.now)();
  let terminals = null;
  try { const listed = (await orca(['list'])).terminals; if (Array.isArray(listed)) terminals = listed; } catch { /* unknown, not none */ }
  const roomOf = new Map((cfg.rooms || []).flatMap((r) => r.repos.map((id) => [id, r.name])));
  const repos = cfg.groups.flatMap((g) => g.repos.map((r) => ({ ...r, id: lib.repoId(r.path), group: g.name })));
  const results = await pool(repos, POOL, async (repo) => safeAnalyse(await gather(repo, { deps, terminals, orca, cfg, roomOf, now })));
  const counts = { working: 0, waiting: 0, blocked: 0, idle: 0 };
  for (const { row } of results) {
    if (row.error) continue;
    if (row.session.state === 'waiting') counts.waiting++;
    else if (row.session.state === 'working') counts.working++;
    else if (row.blocking.length) counts.blocked++;
    else counts.idle++;
  }
  return {
    rows: results.map((r) => r.row), counts,
    attention: results.filter((r) => r.why.length).map(({ row, why }) => ({ id: row.id, name: row.name, why: why.join('; ') })),
    generatedAt: new Date(now).toISOString(),
  };
}

// `deps` replaces what the route talks to ({ orca, prs, local, roadmap, state, git, now }); the cache lives with `deps`.
function summaryFor(deps = {}, query = {}) {
  const now = (deps.now || Date.now)();
  const hit = caches.get(deps);
  // t stays null while the build runs (that promise is shared) and is the time it FINISHED once it resolves.
  if (hit && query.fresh !== '1' && (hit.t === null || now - hit.t < CACHE_MS)) return hit.p;
  const p = build(deps);
  const entry = { t: null, p };
  caches.set(deps, entry);
  p.then(() => { entry.t = (deps.now || Date.now)(); }, () => { if (caches.get(deps) === entry) caches.delete(deps); });
  return p;
}

module.exports = { summarize, summaryFor };
