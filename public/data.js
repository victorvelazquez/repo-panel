'use strict';
// RPC3a: the data layer of the page: the request pool, the config and the reads of each repo. index.html loads this file BEFORE app.js and both share the
// global scope (like view.js and resumen.js), so what is used from app.js (S, V, $, TOKEN, draw, applyPiState...) is only touched when a function is called,
// never while this file loads (test/rpc3a-data.test.js loads it alone).

// ---------- api + request pool ----------
// RP101: how long the page waits for a session to start: a little longer than the server's cap (START_MS, five minutes), so the server's own answer is the one that arrives.
const START_WAIT_MS = 305000;
// A start that ran out of time, on the page ("Request timed out") or on the server (504), says one plain thing; any other failure is kept as it is.
const startError = (e) => (e && (e.message === 'Request timed out' || e.message === 'The session did not start in time') ? new Error('The session did not start in five minutes') : e);

// RP76: every request has a time limit (S.timeouts) and sends x-priority: user when a click caused it (every POST, or opts.priority).
// opts.signal links an outer AbortSignal: when it aborts, so does the request (the rejection is an AbortError callers can ignore).
async function api(url, body, opts = {}) {
  const ctl = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; ctl.abort(); }, opts.timeoutMs || (body ? S.timeouts.post : S.timeouts.get));
  const outer = opts.signal;
  const onOuter = () => ctl.abort();
  if (outer) { if (outer.aborted) ctl.abort(); else outer.addEventListener('abort', onOuter); }
  const headers = { 'x-token': TOKEN, 'content-type': 'application/json' };
  if (body || opts.priority === 'user') headers['x-priority'] = 'user';
  try {
    const res = await fetch(url, { method: body ? 'POST' : 'GET', headers, body: body ? JSON.stringify(body) : undefined, signal: ctl.signal });
    const data = await res.json().catch(() => ({ error: 'Invalid server response' }));
    if (!res.ok) throw Object.assign(new Error(data.error || res.statusText), { status: res.status });
    S.aliveAt = Date.now();
    return data;
  } catch (e) {
    if (timedOut) throw new Error('Request timed out');
    throw e;
  } finally {
    clearTimeout(timer);
    if (outer) outer.removeEventListener('abort', onOuter);
  }
}

const queue = [];
let running = 0;
function pooled(fn) {
  return new Promise((resolve, reject) => { queue.push({ fn, resolve, reject }); pump(); });
}
function pump() {
  while (running < 6 && queue.length) {
    const j = queue.shift();
    running++;
    j.fn().then(j.resolve, j.reject).finally(() => { running--; pump(); });
  }
}

function toast(msg, kind = '') {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = msg;
  $('#toasts').append(el);
  setTimeout(() => el.remove(), kind === 'bad' ? 7000 : 3500);
}

// ---------- data ----------
const allRepos = () => S.groups.flatMap((g) => g.repos.map((r) => ({ ...r, group: g.name })));

async function loadConfig() {
  const cfg = await api('/api/config');
  S.groups = cfg.groups;
  S.snoozed = new Set();
  S.keepSnoozed = new Set();
  for (const k of cfg.snoozed) {
    const base = k.replace(/:ready$/, '');
    S.snoozed.add(base);
    if (base !== k) S.keepSnoozed.add(base);
  }
  S.dismissed = new Set(cfg.dismissed || []);
  S.rooms = cfg.rooms || [];
  S.roomIssues = cfg.roomIssues || [];
  $('#roomPathList').innerHTML = allRepos().map((r) => `<option value="${esc(r.path)}">`).join('');
  $('#groupList').innerHTML = S.groups.map((g) => `<option value="${esc(g.name)}">`).join('');
  $('#groupFilter').innerHTML = `<option value="">All groups</option>${S.groups.map((g) => `<option ${S.group === g.name ? 'selected' : ''}>${esc(g.name)}</option>`).join('')}`;
}

function track(id, p) {
  S.loading[id] = (S.loading[id] || 0) + 1;
  draw();
  return p.finally(() => { S.loading[id]--; draw(); });
}

// RP86 (S9): the ONE way a fact of a repo that feeds the Summary row (local, prs, roadmap, state) is written, from an answer of the board or of a direct read.
// A CHANGE (not a re-read of the same content) asks for a fresh /api/summary soon, grouped: the row (action, next, progress, needs) is computed on the server
// from these same facts, and waiting for the 20 s tick left the Summary card and the board disagreeing after every action of the person.
const SUMMARY_TOUCH_MS = 1000;
let summaryTouch = 0;
function touchSummary() {
  if (summaryTouch || S.tab !== 'summary' || !S.summary) return; // not before the first load (refreshAll's own), nor for a tab that does not show it
  summaryTouch = setTimeout(() => { summaryTouch = 0; summaryTick(); }, SUMMARY_TOUCH_MS);
}
function setFact(kind, id, value) {
  const before = JSON.stringify(S[kind][id]);
  S[kind][id] = value;
  // The FIRST value of a fact is start-up (the Summary and the board answer together, refreshAll asked for both): only a change of a known one counts.
  if (before !== undefined && before !== JSON.stringify(value)) touchSummary();
}

// `poll: false` leaves the pi session status alone (the status poll itself refreshes the repo when a session finishes).
const loadLocal = (id) => track(id, pooled(() => api(`/api/local?id=${id}`)).then((d) => { setFact('local', id, d); stamp(id, 'local'); }, (e) => { setFact('local', id, { error: e.message }); }));

// The session state the buttons of a repo see (S.sent has its own verdict). RPC2b-1: only the live session (S.rpc) says: idle, busy (a session that is
// starting works), asking or closed (a closed one is not a hold: the click starts it). rpcSeed gives every repo a state, so it is not undefined for long.
const rpcSession = (id) => { const r = S.rpc[id]; return r && r.state ? (r.state === 'starting' ? 'busy' : r.state) : undefined; };
// RP163: the background jobs the server counted for the session of a repo (RP161: `session.jobs` of its row in the Summary): a positive safe integer (at most 99) or 0. A session the page knows is closed has none left, even if
// the row (up to 20 s old) still says so.
function jobsOfRepo(id) {
  if (rpcSession(id) === 'closed') return 0;
  const row = S.summary && Array.isArray(S.summary.rows) ? S.summary.rows.find((x) => x && x.id === id) : null;
  const n = row && row.session && typeof row.session === 'object' ? row.session.jobs : 0;
  return Number.isSafeInteger(n) && n > 0 ? Math.min(n, 99) : 0;
}
// RP159: always the LIVE state of the session. It used to be undefined while a command of this page was being judged (S.sent), which let the delivery buttons come back while the session still worked.
function sessionOf(id) {
  return rpcSession(id);
}
const loadPrs = (id) => track(id, pooled(() => api(`/api/prs?id=${id}`)).then((d) => { setFact('prs', id, d); stamp(id, 'prs'); wakeReady(id, d); releaseMerged(id, d); }, (e) => { setFact('prs', id, { error: e.message }); }));

// A merged PR keeps its Merge button disabled (S.merged: key -> time of the merge) until GitHub no longer lists it, or MERGE_HOLD_MS.
const MERGE_HOLD_MS = 90000;
const mergeHeld = (id, n) => {
  const at = S.merged[`${id}:${n}`];
  if (at !== undefined && Date.now() - at >= MERGE_HOLD_MS) delete S.merged[`${id}:${n}`];
  return S.merged[`${id}:${n}`] !== undefined;
};
function releaseMerged(id, d) {
  if (!Array.isArray(d && d.prs)) return;
  for (const key of Object.keys(S.merged)) if (key.startsWith(`${id}:`) && !d.prs.some((p) => `${id}:${p.number}` === key)) delete S.merged[key];
}
// The busy map the Summary rows see: requests in flight plus the merges still held.
const busyView = () => ({ ...Object.fromEntries(Object.keys(S.merged).filter((k) => mergeHeld(...k.split(/:(?=[^:]*$)/))).map((k) => [k, 'done'])), ...S.busy });

// When each kind of data of a repo was last asked for: the periodic tick (refreshTick) plans from it.
function markAsked(id, now, { prs = true } = {}) {
  const at = S.lastAt[id] || (S.lastAt[id] = {});
  at.local = now;
  if (prs) at.prs = now;
}

// RP80: when the page read a fact of a repo directly (only successes), so a board fact that is not newer never overwrites it.
function stamp(id, kind) { (S.factAt[id] ||= {})[kind] = Date.now(); }

// `catchUp`: the person's own action just ended, so the server's memory is asked to re-read that repo too (the board follows).
// RP86b: and while the board answers (boardLeads) the roadmap (240 KB) and the requirements are not read directly when the page already holds them for that repo (the server answers
// `{ available: false }` for a repo with no roadmap, so a `null` is a failed read, not an answer, and is read again): they arrive by the board. local and prs are what an action changes, and state is the freshest signal after one (the board would be up to 3 s late), so those are still read.
// A fact the page does not hold yet, a board that is down or never answered, and a refresh that is not an action (refreshAll) keep the direct read.
function refreshRepo(id, { poll = true, catchUp = false } = {}) {
  markAsked(id, Date.now());
  if (catchUp && boardWorks()) api('/api/board/refresh', { id }).catch(() => {});
  const byBoard = catchUp && boardLeads();
  const skipRoadmap = byBoard && !!S.roadmap[id];
  const skipReq = byBoard && !!S.req[id] && S.req[id].state === 'loaded';
  return Promise.all([
    loadLocal(id),
    loadPrs(id),
    // The roadmap is optional: a repo without one, or a failed request, simply shows nothing extra.
    skipRoadmap ? Promise.resolve() : track(id, pooled(() => api(`/api/roadmap?id=${id}`)).then((d) => { setFact('roadmap', id, d); stamp(id, 'roadmap'); }, () => { setFact('roadmap', id, null); })),
    skipReq ? Promise.resolve() : loadRequirements(id),
    loadState(id),
    poll ? loadPiStatus(id) : Promise.resolve(),
  ]);
}

// A late answer from an older request never overwrites a newer one. Until one arrives the repo is unverified.
function loadRequirements(id) {
  const seq = S.reqSeq[id] = (S.reqSeq[id] || 0) + 1;
  return track(id, pooled(() => api(`/api/requirements?id=${id}`)).then(
    (d) => { if (seq === S.reqSeq[id]) { S.req[id] = { state: 'loaded', data: d }; stamp(id, 'req'); } },
    () => { if (seq === S.reqSeq[id]) S.req[id] = { state: 'failed' }; },
  ));
}

// The state the agent declared for the repo (.panel/state.json). A late answer from an older request never
// overwrites a newer one, and a failed load just means no declared state: it never breaks the card.
function loadState(id) {
  const seq = S.stateSeq[id] = (S.stateSeq[id] || 0) + 1;
  return track(id, pooled(() => api(`/api/state?id=${id}`)).then(
    (d) => { if (seq === S.stateSeq[id]) { setFact('state', id, d); stamp(id, 'state'); } },
    () => { if (seq === S.stateSeq[id]) setFact('state', id, null); },
  ));
}

// The pi session state (closed | idle | busy | asking | ambiguous | unknown), only for a repo that has a command sent from
// this page (S.sent). A failed request is an unknown session, never a closed one.
function loadPiStatus(id) {
  if (!S.sent[id]) return Promise.resolve();
  const seq = S.pistatusSeq[id] = (S.pistatusSeq[id] || 0) + 1;
  return track(id, pooled(() => api(`/api/pi-status?id=${id}`)).then(
    (d) => (seq === S.pistatusSeq[id] ? applyPiState(id, d.state) : null),
    () => (seq === S.pistatusSeq[id] ? applyPiState(id, 'unknown') : null),
  ));
}
