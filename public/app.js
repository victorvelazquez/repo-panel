'use strict';
const TOKEN = document.querySelector('meta[name=token]').content;
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
// view.js is missing when an old server (which does not serve it) answers: the page must still run.
const V = window.RepoPanelView || null;
const store = (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } };

const S = {
  groups: [], local: {}, prs: {}, roadmap: {}, rmOpen: {}, loading: {}, busy: {},
  snoozed: new Set(), keepSnoozed: new Set(), snoozedOpen: {}, onlyProblems: false,
  dismissed: new Set(), menu: null, reqPassOpen: {},
  group: '', q: '', queue: [], queueKey: '', queueSeq: 0,
  conf: { items: [], ok: 0, loaded: false, failed: false, key: '', seq: 0 }, confOpen: false,
  req: {}, reqSeq: {}, state: {}, stateSeq: {}, sent: {}, pistatus: {}, pistatusSeq: {}, showCommit: new Set(), prereq: { state: 'loading', items: [], seq: 0 },
  rooms: [], roomIssues: [], roomData: { state: 'loading', data: null }, roomSeq: 0,
  prefs: store('prefs', { method: 'squash', del: true }),
  lastRefresh: 0, scan: [],
};

// ---------- api + request pool ----------
async function api(url, body) {
  const res = await fetch(url, {
    method: body ? 'POST' : 'GET',
    headers: { 'x-token': TOKEN, 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({ error: 'Invalid server response' }));
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
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

function refreshRepo(id) {
  return Promise.all([
    track(id, pooled(() => api(`/api/local?id=${id}`)).then((d) => { S.local[id] = d; }, (e) => { S.local[id] = { error: e.message }; })),
    track(id, pooled(() => api(`/api/prs?id=${id}`)).then((d) => { S.prs[id] = d; wakeReady(id, d); }, (e) => { S.prs[id] = { error: e.message }; })),
    // The roadmap is optional: a repo without one, or a failed request, simply shows nothing extra.
    track(id, pooled(() => api(`/api/roadmap?id=${id}`)).then((d) => { S.roadmap[id] = d; }, () => { S.roadmap[id] = null; })),
    loadRequirements(id),
    loadState(id),
    loadPiStatus(id),
  ]);
}

// A late answer from an older request never overwrites a newer one. Until one arrives the repo is unverified.
function loadRequirements(id) {
  const seq = S.reqSeq[id] = (S.reqSeq[id] || 0) + 1;
  return track(id, pooled(() => api(`/api/requirements?id=${id}`)).then(
    (d) => { if (seq === S.reqSeq[id]) S.req[id] = { state: 'loaded', data: d }; },
    () => { if (seq === S.reqSeq[id]) S.req[id] = { state: 'failed' }; },
  ));
}

// The state the agent declared for the repo (.panel/state.json). A late answer from an older request never
// overwrites a newer one, and a failed load just means no declared state: it never breaks the card.
function loadState(id) {
  const seq = S.stateSeq[id] = (S.stateSeq[id] || 0) + 1;
  return track(id, pooled(() => api(`/api/state?id=${id}`)).then(
    (d) => { if (seq === S.stateSeq[id]) S.state[id] = d; },
    () => { if (seq === S.stateSeq[id]) S.state[id] = null; },
  ));
}

// The pi session state (closed | idle | busy | ambiguous | unknown), only for a repo that has a /flow-commit sent
// from this page (S.sent). A failed request is an unknown session, never a closed one.
function loadPiStatus(id) {
  if (!S.sent[id]) return Promise.resolve();
  const seq = S.pistatusSeq[id] = (S.pistatusSeq[id] || 0) + 1;
  return track(id, pooled(() => api(`/api/pi-status?id=${id}`)).then(
    (d) => { if (seq === S.pistatusSeq[id]) S.pistatus[id] = d.state; },
    () => { if (seq === S.pistatusSeq[id]) S.pistatus[id] = 'unknown'; },
  ));
}

function loadPrerequisites() {
  const seq = ++S.prereq.seq;
  return pooled(() => api('/api/prerequisites')).then(
    (d) => { if (seq === S.prereq.seq) { S.prereq.state = 'loaded'; S.prereq.items = d.items || []; draw(); } },
    () => { if (seq === S.prereq.seq) { S.prereq.state = 'failed'; draw(); } },
  );
}

// With no rooms there is nothing to ask. The room list itself (S.rooms) comes from /api/config.
function loadRooms() {
  const seq = ++S.roomSeq;
  if (!S.rooms.length) { S.roomData = { state: 'loaded', data: { rooms: [] } }; return Promise.resolve(); }
  return pooled(() => api('/api/rooms')).then(
    (d) => { if (seq === S.roomSeq) { S.roomData = { state: 'loaded', data: d }; draw(); } },
    () => { if (seq === S.roomSeq) { S.roomData = { state: 'failed', data: null }; draw(); } },
  );
}

// A PR snoozed while still blocked is woken up when it becomes ready to merge. One snoozed while
// already ready was parked on purpose, so it stays parked until the user brings it back.
function wakeReady(id, d) {
  for (const pr of d.prs || []) {
    if (pr.ready && S.snoozed.has(snoozeKey(id, pr.number)) && !S.keepSnoozed.has(snoozeKey(id, pr.number))) setSnooze(id, pr.number, false, true);
  }
}

// /health is public and tokenless. A failed request shows nothing; an answer from an old server warns.
async function checkHealth() {
  let health = null;
  try { health = await (await fetch('/health')).json(); } catch { /* unreachable: nothing to compare */ }
  $('#outdated').hidden = V ? !V.isOutdated(health) : false; // no view.js: the server cannot be current
}

async function refreshAll() {
  checkHealth();
  if (S.conf.failed) S.conf.key = ''; // ask again once per refresh, never on every redraw
  S.lastRefresh = Date.now();
  await Promise.all([loadPrerequisites(), loadRooms(), ...allRepos().map((r) => refreshRepo(r.id))]);
}

async function fetchRepo(id) {
  try { await track(id, pooled(() => api('/api/fetch', { id }))); } catch (e) { toast(`${nameOf(id)}: ${e.message}`, 'bad'); }
  await refreshRepo(id);
}

const snoozeKey = (id, n) => `${id}:${n}`;

async function setSnooze(id, n, on, auto = false) {
  const key = snoozeKey(id, n);
  const wasReady = on && !!(S.prs[id]?.prs || []).find((x) => x.number === n)?.ready;
  if (on) { S.snoozed.add(key); if (wasReady) S.keepSnoozed.add(key); } else { S.snoozed.delete(key); S.keepSnoozed.delete(key); }
  draw();
  try {
    await api('/api/snooze', { id, number: n, on, wasReady });
    if (auto) toast(`#${n} (${nameOf(id)}) is ready to merge — back on the board`, 'ok');
  } catch (e) {
    if (on) { S.snoozed.delete(key); S.keepSnoozed.delete(key); } else S.snoozed.add(key);
    draw();
    toast(e.message, 'bad');
  }
}

// Hides or shows again the "requirements missing" warning of a repo; the choice is kept in config.json.
async function setDismissed(id, on) {
  if (on) S.dismissed.add(id); else S.dismissed.delete(id);
  draw();
  try { await api('/api/dismiss', { id, on }); } catch (e) {
    if (on) S.dismissed.delete(id); else S.dismissed.add(id);
    draw();
    toast(e.message, 'bad');
  }
}

const nameOf = (id) => allRepos().find((r) => r.id === id)?.name || id;

// ---------- derived state ----------
function info(r) {
  const l = S.local[r.id] || {};
  const p = S.prs[r.id] || {};
  const prs = p.prs || [];
  return {
    l, p, prs,
    dirty: (l.files || []).length > 0,
    unpushed: (l.ahead || 0) > 0,
    ready: prs.filter((x) => x.ready).length,
  };
}

function visibleRepos() {
  const q = S.q.toLowerCase();
  return allRepos().filter((r) => (!S.group || r.group === S.group) && (!q || r.name.toLowerCase().includes(q)));
}

// ---------- go work on ----------
// Per-repo facts for /api/queue, only for repos whose local and PR state have loaded.
function queueItems() {
  return visibleRepos().filter((r) => S.local[r.id] && S.prs[r.id]).map((r) => {
    const { p, prs, dirty, unpushed } = info(r);
    const rm = S.roadmap[r.id];
    const s = rm && rm.available ? rm.summary : null;
    const flags = V ? V.queueFlags(S.local[r.id], S.state[r.id], verdictOf(r), { override: S.showCommit.has(r.id) }) : {};
    return {
      id: r.id, name: r.name, dirty, unpushed, stale: !!p.stale, hasPrs: prs.length > 0, ...flags,
      ready: prs.filter((x) => x.ready && !S.snoozed.has(snoozeKey(r.id, x.number))).map((x) => ({ number: x.number, title: x.title })),
      next: s && s.kind === 'next' ? { id: s.id, entrega: s.entrega } : null,
    };
  });
}

// Asks the server only when the facts changed, so the frequent redraws never loop on requests.
function refreshQueue() {
  const items = queueItems();
  const key = JSON.stringify(items);
  if (key === S.queueKey) return;
  S.queueKey = key;
  const seq = ++S.queueSeq;
  api('/api/queue', { items }).then((d) => {
    if (seq !== S.queueSeq) return;
    S.queue = d.queue || [];
    draw();
  }, () => { /* keep the previous queue */ });
}

const QUEUE_MAX = 8;
const QUEUE_CLIP = 80;
const clip = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const QUEUE_TEXT = {
  merge: (a) => `Merge #${a.pr} ${a.title}`,
  branch: () => '/flow-base',
  deliver: () => 'Deliver changes',
  start: (a) => `Start ${a.unit.id} ${a.unit.entrega}`,
  manual: (a) => `Manual action: ${clip(a.reason, QUEUE_CLIP)}`,
  waiting: (a) => `Waiting for you: ${clip(a.next || (a.state === 'blocked' ? 'blocked' : 'needs input'), QUEUE_CLIP)}`,
};
// The tooltip keeps the full text of the kinds that clip theirs.
const QUEUE_TITLE = {
  manual: (a) => `Manual action: ${a.reason}`,
  waiting: (a) => `Waiting for you: ${a.next || a.state}`,
};
const QUEUE_COLOR = { merge: 'green', branch: 'red', deliver: 'yellow', start: 'blue', manual: 'red', waiting: 'blue' };

function drawQueue() {
  refreshQueue();
  const el = $('#queue');
  el.hidden = !S.queue.length;
  el.innerHTML = S.queue.length ? `<strong>Go work on</strong>${S.queue.slice(0, QUEUE_MAX).map((a) => {
    const text = `${a.name} · ${QUEUE_TEXT[a.kind](a)}`;
    const title = QUEUE_TITLE[a.kind] ? `${a.name} · ${QUEUE_TITLE[a.kind](a)}` : text;
    return `<button class="chip chip-btn ${QUEUE_COLOR[a.kind]}" data-act="queue-pick" data-name="${esc(a.name)}" title="${esc(title)}">${esc(text)}</button>`;
  }).join('')}${S.queue.length > QUEUE_MAX ? `<span class="muted">+${S.queue.length - QUEUE_MAX} more</span>` : ''}` : '';
}

// ---------- conformity ----------
// Audits every repo (filters do not apply). Asks the server only when the roadmap facts changed.
function refreshConformity() {
  const entries = allRepos().map((r) => {
    const rp = S.roadmap[r.id];
    return { id: r.id, name: r.name, roadmap: rp ? { available: rp.available, reason: rp.reason, problems: rp.problems } : null };
  });
  const key = JSON.stringify(entries);
  if (key === S.conf.key) return;
  S.conf.key = key;
  const seq = ++S.conf.seq;
  api('/api/conformity', { entries }).then((d) => {
    if (seq !== S.conf.seq) return;
    S.conf.items = d.items || [];
    S.conf.ok = d.ok || 0;
    S.conf.loaded = true;
    S.conf.failed = false;
    draw();
  }, () => {
    if (seq !== S.conf.seq) return;
    S.conf.failed = true;
    draw();
  });
}

const CONF_STATUS = {
  missing: 'No docs/ROADMAP.md on the base branch',
  'no-base': 'Base branch not found',
  'no-repo': 'Folder or repository not found',
  unavailable: 'Roadmap unavailable',
};

function confBlock(it) {
  const status = it.status === 'problems' ? `${it.problems.length} problem${it.problems.length === 1 ? '' : 's'}` : CONF_STATUS[it.status];
  return `<div class="conf-item">
    <button class="repo-name" data-act="queue-pick" data-close="1" data-name="${esc(it.name)}" title="Filter the board to this repo">${esc(it.name)}</button>
    <div class="conf-status">${esc(status)}</div>
    ${it.problems.map((p) => `<div class="conf-line">line ${esc(p.line)} · ${esc(p.severity)} · ${esc(p.message)}</div>`).join('')}
  </div>`;
}

const REQ_CATEGORY = { verificable: 'verifiable', parcial: 'partial', criterio: 'judgment' };
const REQ_MARK = { pass: '✓', fail: '✗', outdated: '↻', unavailable: '?' };

// What the conformity view knows about requirements: a repo that has not answered yet is "loading", never ready.
// Rooms are the same: until /api/rooms answered they are "loading".
const reqSummary = () => ({
  prereq: S.prereq.state,
  rooms: {
    state: S.roomData.state,
    list: ((S.roomData.data && S.roomData.data.rooms) || []).map((m) => ({ name: m.name, ready: !!(m.summary && m.summary.ready) })),
  },
  repos: allRepos().map((r) => {
    const e = S.req[r.id];
    return { id: r.id, state: e ? e.state : 'loading', ready: !!(e && e.data && e.data.summary && e.data.summary.ready) };
  }),
});

function prereqBlock() {
  const p = S.prereq;
  const lines = p.state === 'loaded'
    ? p.items.map((i) => `<div class="conf-line req-${i.ok ? 'pass' : 'fail'}">${i.ok ? '✓' : '✗'} ${esc(i.id)} · ${esc(i.detail)}</div>`).join('')
    : `<div class="conf-line">${p.state === 'failed' ? 'Could not check the prerequisites' : 'Checking the prerequisites…'}</div>`;
  return `<div class="conf-item"><div class="conf-title">Prerequisites on this machine</div>${lines}</div>`;
}

// The remedy is the instruction an AI agent applies in the repo; the panel only shows it.
function reqLine(x) {
  return `<div class="conf-line req-${esc(x.status)}" title="${esc(x.remedy)}">${REQ_MARK[x.status] || '?'} ${esc(x.title)} · ${esc(x.level)} · ${esc(REQ_CATEGORY[x.category] || x.category)} · ${esc(x.status)} (${esc(x.detail)})<div class="req-remedy">${esc(x.remedy)}</div></div>`;
}

// The status line, the requirements that are not passing (with their remedy) and the collapsed passing list.
// `key` identifies the list in S.reqPassOpen, so it stays open or closed across redraws.
function reqResults(key, { results, summary }) {
  const bad = results.filter((x) => x.status !== 'pass');
  const good = results.filter((x) => x.status === 'pass');
  const status = summary.ready ? 'Ready' : `Not ready · required ${summary.required.pass}/${summary.required.total}`;
  const passing = good.length ? `<details class="req-passing" data-id="${esc(key)}"${S.reqPassOpen[key] ? ' open' : ''}><summary>${good.length} passing</summary>${good.map((x) => `<div class="conf-line req-pass">✓ ${esc(x.title)} · ${esc(x.level)}</div>`).join('')}</details>` : '';
  return `<div class="conf-status">${esc(status)}</div>${bad.map(reqLine).join('')}${passing}`;
}

function reqBlock(r) {
  const e = S.req[r.id];
  const name = `<button class="repo-name" data-act="queue-pick" data-close="1" data-name="${esc(r.name)}" title="Filter the board to this repo">${esc(r.name)}</button>`;
  if (!e || e.state !== 'loaded') return `<div class="conf-item">${name}<div class="conf-line">${e ? 'Could not read the requirements' : 'Checking the requirements…'}</div></div>`;
  return `<div class="conf-item">${name}${reqResults(r.id, e.data)}</div>`;
}

// A room: its folder, whether a pi session is open there, its own requirements and the repos assigned to it.
function roomBlock(m) {
  const last = m.lastCommit ? m.lastCommit.slice(0, 10) : 'unknown';
  const members = m.repos.length ? m.repos.map((id) => (allRepos().some((r) => r.id === id) ? nameOf(id) : `${id} (not in the panel)`)).join(', ') : 'none yet';
  return `<div class="conf-item"><div class="conf-title"><span class="dot dot-${V.presenceDot(m.presence)}"></span> ${esc(m.name)}<button data-act="remove-room" data-name="${esc(m.name)}" title="Only removes the room from the panel; its folder and repos are not touched">Remove room</button></div>
    <div class="conf-line">${esc(m.path)}</div>
    <div class="conf-line">Session: ${esc(V.presenceLabel(m.presence))} · last commit ${esc(last)}</div>
    ${m.available ? '' : '<div class="conf-line">The room folder is not a repository with a base branch</div>'}
    ${reqResults(`room:${m.name}`, m)}
    <div class="conf-line">Members: ${esc(members)}</div></div>`;
}

// The config.json entries under rooms that the panel ignores (it keeps them in the file untouched).
function roomIssuesBlock() {
  const n = V ? V.roomIssuesNotice(S.roomIssues) : null;
  return n ? `<div class="conf-item"><div class="conf-error">${esc(n.message)}</div>${n.reasons.map((x) => `<div class="conf-line">${esc(x)}</div>`).join('')}</div>` : '';
}

function roomsBlock() {
  const issues = roomIssuesBlock();
  if (!S.rooms.length) return issues ? `<div class="conf-heading">Rooms</div>${issues}` : '';
  const e = S.roomData;
  const body = e.state === 'loaded' ? e.data.rooms.map(roomBlock).join('') : `<div class="conf-item"><div class="conf-line">${e.state === 'failed' ? 'Could not read the rooms' : 'Checking the rooms…'}</div></div>`;
  return `<div class="conf-heading">Rooms</div>${issues}${body}`;
}

function drawConformity() {
  refreshConformity();
  const v = V ? V.conformityView({ ...S.conf, req: reqSummary() }) : { state: 'error', summary: '', message: 'Could not compute the report (is the panel server out of date? restart it)', count: 0 };
  const n = v.count;
  $('#confBadge').hidden = !n;
  $('#confBadge').textContent = n;
  if (!S.confOpen) return;
  const sum = v.summary ? `<div class="conf-sum">${esc(v.summary)}</div>` : '';
  const body = v.state === 'issues' ? S.conf.items.map(confBlock).join('') : `<div class="${v.state === 'error' ? 'conf-error' : 'empty'}">${esc(v.message)}</div>`;
  const reqs = V ? `<div class="conf-heading">Requirements</div>${allRepos().map(reqBlock).join('')}${roomsBlock()}` : '';
  $('#drawerBody').innerHTML = sum + prereqBlock() + body + reqs;
}

function openConformity() {
  S.confOpen = true;
  $('#drawerTitle').textContent = 'Roadmap conformity';
  $('#drawer').hidden = false;
  drawConformity();
}

// ---------- board ----------
let raf = 0;
function draw() { if (!raf) raf = requestAnimationFrame(() => { raf = 0; render(); }); }

const COLUMNS = [
  { key: 'clean', title: 'Clean', hint: 'Nothing to do' },
  { key: 'changes', title: 'Changes', hint: 'Uncommitted files' },
  { key: 'committed', title: 'Committed', hint: 'Commits not pushed yet' },
  { key: 'progress', title: 'Open PRs', hint: 'Checks running, waiting for review or needing a fix (red = needs attention)' },
  { key: 'ready', title: 'Ready to merge', hint: 'All checks passed' },
];

// A PR that cannot merge because of something the user must fix.
const isProblem = (pr) => (V ? V.isProblem(pr) : !pr.ready && (pr.checks.state === 'failed' || ['DIRTY', 'BEHIND'].includes(pr.mergeStateStatus)));

const prColumn = (pr) => (V ? V.prColumn(pr) : pr.ready ? 'ready' : 'progress');

// Where the repo's local card goes (view.js decides it from Git state alone); without view.js, by changes, commits
// and the stale mark only.
function placement(l, p, prCount, verdict) {
  if (V) return V.localPlacement(l, p, prCount, verdict && verdict.state);
  const stale = !!p.stale;
  if (l.error) return { column: 'changes', attn: true, row: false };
  if ((l.files || []).length > 0) return { column: 'changes', attn: stale, row: false };
  if ((l.ahead || 0) > 0) return { column: 'committed', attn: stale, row: false };
  return stale ? { column: 'clean', attn: true, row: false } : { column: prCount ? null : 'clean', attn: false, row: !prCount };
}

// The verdict of the last /flow-commit sent from this page, or null. It lives in the page only: an ok verdict
// clears the record and the card simply lives in COMMITTED. Judged from Git and the session state, never from
// terminal text; the panel does not judge the quality of the commits.
function verdictOf(r) {
  const sent = S.sent[r.id];
  if (!sent || !V) return null;
  const v = V.commitVerdict(sent, S.local[r.id], S.pistatus[r.id]);
  if (v && v.state === 'ok') { delete S.sent[r.id]; delete S.pistatus[r.id]; return null; }
  return v;
}

// One card per pending thing: a repo can have a local card plus one card per open PR.
function buildCards() {
  const cols = Object.fromEntries(COLUMNS.map((c) => [c.key, []]));
  const parked = Object.fromEntries(COLUMNS.map((c) => [c.key, []]));
  let problems = 0;
  // Problem cards go first in their column; with the problems filter on, only they are shown.
  const add = (key, html, attn) => {
    if (attn) { problems++; cols[key].unshift(html); } else if (!S.onlyProblems) cols[key].push(html);
  };
  for (const r of visibleRepos()) {
    if (!S.local[r.id] || !S.prs[r.id]) continue; // first load still running
    const { l, p, prs } = info(r);
    // A stale branch, something that needs manual action and a failed /flow-commit all need a person.
    const verdict = verdictOf(r);
    const place = placement(l, p, prs.length, verdict);
    if (place.column) add(place.column, place.row ? cleanRow(r) : l.error ? repoCard(r, true) : repoCard(r, place.attn, verdict), place.attn);
    for (const pr of prs) {
      const key = prColumn(pr);
      if (S.snoozed.has(snoozeKey(r.id, pr.number))) { if (!S.onlyProblems) parked[key].push(snoozedRow(r, pr)); }
      else add(key, prCard(r, pr, p.repo), isProblem(pr));
    }
  }
  return { cols, parked, problems };
}

function snoozedRow(r, pr) {
  return `<div class="snoozed-row">
    <a href="${esc(pr.url)}" target="_blank" rel="noopener" title="${esc(`${r.name} · ${pr.title}`)}"><span class="muted">${esc(r.name)}</span> #${pr.number} ${esc(pr.title)}</a>
    <button data-act="unsnooze" data-id="${r.id}" data-n="${pr.number}" title="Bring back to the board">⏰</button>
  </div>`;
}

function snoozedBlock(key, rows) {
  if (!rows.length) return '';
  const open = !!S.snoozedOpen[key];
  return `<div class="snoozed">
    <div class="snoozed-head" data-act="toggle-snoozed" data-col="${key}"><span>${open ? '▾' : '▸'}</span> Snoozed (${rows.length})</div>
    ${open ? rows.join('') : ''}
  </div>`;
}

function render() {
  drawQueue();
  drawConformity();
  if (!allRepos().length) {
    $('#app').innerHTML = '<div class="empty">No repositories yet.<br><br><button class="primary" data-act="add-dialog">+ Add your first repo</button></div>';
    return;
  }
  const { cols, parked, problems } = buildCards();
  const alerts = $('#alerts');
  alerts.hidden = !problems && !S.onlyProblems;
  alerts.textContent = `⚠ ${problems}`;
  alerts.classList.toggle('active', S.onlyProblems);
  $('#app').innerHTML = `<div class="board">${COLUMNS.map((c) => `
    <section class="col col-${c.key}">
      <div class="col-head" title="${esc(c.hint)}"><h2>${c.title}</h2><span class="n">${cols[c.key].length}</span></div>
      <div class="col-body">${cols[c.key].join('') || (parked[c.key].length ? '' : '<div class="col-empty">—</div>')}${snoozedBlock(c.key, parked[c.key])}</div>
    </section>`).join('')}</div>`;
}

// Well-separated hues, assigned to groups by their position in config.json (wraps after 6 groups).
const GROUP_HUES = [265, 140, 30, 185, 330, 55];

function groupTag(name) {
  const h = GROUP_HUES[Math.max(0, S.groups.findIndex((g) => g.name === name)) % GROUP_HUES.length];
  return `<span class="tag" style="background:hsl(${h} 40% 20%);color:hsl(${h} 70% 78%)">${esc(name)}</span>`;
}

const spinner = (r) => (S.loading[r.id] > 0 ? '<span class="spin" title="Refreshing…">↻</span>' : '');

// The repo name is the link to the repository on GitHub (plain text when there is no GitHub remote).
const repoName = (r, url) => (url
  ? `<a class="repo-name" href="${esc(url)}" target="_blank" rel="noopener" title="Open ${esc(r.name)} on GitHub">${esc(r.name)}</a>`
  : `<span class="repo-name">${esc(r.name)}</span>`);

const removeBtn = (r) => `<button class="x" data-act="remove" data-id="${r.id}" title="Remove from panel (deletes nothing)">✕</button>`;

// Types the command into the repo's open pi session (through Orca); the server refuses when that is not safe.
const piBtn = (r, cmd, label = `/${cmd}`, { title = `Send /${cmd} to the open pi session of this repo`, pr } = {}) => `<button data-act="pi" data-id="${r.id}" data-cmd="${cmd}"${pr ? ` data-pr="${pr}"` : ''} title="${esc(title)}">${esc(label)}</button>`;

// "⋯" menu of a card. Its open state lives in S (the page redraws on every refresh); `slot` tells apart
// the several cards of one repo. Empty while the requirements are not loaded or nothing is left to do.
function moreMenu(r, slot, extra = []) {
  const items = [...(V ? V.cardMenu(S.req[r.id], S.dismissed.has(r.id)) : []), ...extra];
  const rooms = V ? V.roomMenu(S.rooms, r.id) : null;
  if (!items.length && !rooms) return '';
  const key = `${r.id}|${slot}`;
  const open = S.menu === key;
  const list = items.map((i) => `<button role="menuitem" data-act="${i.act}" data-id="${r.id}">${esc(i.label)}</button>`).join('')
    + (rooms ? `${rooms.title ? `<div class="more-head">${esc(rooms.title)}</div>` : ''}${rooms.items.map((i) => (i.act === 'assign-room'
      ? `<button role="menuitemradio" aria-checked="${i.current}" data-act="assign-room" data-id="${r.id}" data-room="${esc(i.room ?? '')}">${i.current ? '✓ ' : ''}${esc(i.label)}</button>`
      : `<button role="menuitem" data-act="${i.act}">${esc(i.label)}</button>`)).join('')}` : '');
  return `<span class="more"><button data-act="toggle-menu" data-menu="${esc(key)}" title="More options" aria-haspopup="true" aria-expanded="${open}">⋯</button>${open ? `<div class="more-menu" role="menu">${list}</div>` : ''}</span>`;
}

// Compact warning for a repo that lacks a required requirement; the drawer lists the rest.
function reqWarn(r) {
  const w = V ? V.cardWarning(S.req[r.id], S.dismissed.has(r.id)) : null;
  if (!w) return '';
  return `<div class="req-warn" title="${esc(w.ids.join(', '))}"><span>⚠ ${w.count} requirement${w.count === 1 ? '' : 's'} missing</span><button data-act="hide-warning" data-id="${r.id}" title="Hide this warning (more options → Show warning)">✕</button></div>`;
}

// The line the agent declared for "what to do now", with a dot per state; a stale state is only a small marker.
function stateRow(r) {
  const l = V ? V.stateLine(S.state[r.id]) : null;
  if (!l) return '';
  if (l.kind === 'outdated') return `<div class="state-line" title="${esc(l.title)}"><span class="dot dot-${l.dot}"></span></div>`;
  return `<div class="state-line" title="${esc(l.title)}"><span class="dot dot-${l.dot}"></span><span class="state-text">${esc(l.text)}</span></div>`;
}

// Room tag with a status dot; only for repos assigned to a room.
function roomTag(r) {
  const t = V ? V.roomTag(S.rooms, r.id, S.roomData) : null;
  return t ? `<span class="tag room-tag" title="${esc(t.title)}"><span class="dot dot-${t.dot}"></span>${esc(t.name)}</span>` : '';
}

// Repo name + group on the left, more options and remove (with confirmation) pinned to the right.
function cardTop(r, url, slot, extra = []) {
  return `<div class="card-top">${groupTag(r.group)}${roomTag(r)}${repoName(r, url)}${spinner(r)}${moreMenu(r, slot, extra)}${removeBtn(r)}</div>`;
}

// What the project is working on, from the remote roadmap. Empty when the repo has no usable one.
function roadmapBlock(r) {
  const rp = S.roadmap[r.id];
  const s = rp && rp.available ? rp.summary : null;
  if (!s) return '';
  const label = { review: 'In review', ready: 'Ready', current: 'In progress', next: 'Next' }[s.kind] || '';
  const text = label ? `${label}: ${s.id} ${s.entrega}${s.pr ? ` · PR #${s.pr}` : ''}${s.waiting.length ? ` · waiting: ${s.waiting.join(', ')}` : ''}${s.extra > 0 ? ` · +${s.extra} more` : ''}` : '';
  const p = s.problems;
  const tip = (rp.problems || []).map((x) => `line ${x.line}: ${x.message}`).join('\n');
  const badge = p.total > 0 ? `<span class="rm-badge ${p.error ? 'red' : p.warn ? 'yellow' : 'gray'}" title="${esc(tip)}">⚠ ${p.total}</span>` : '';
  const open = !!S.rmOpen[r.id];
  const h = s.header;
  const lines = [['Where it stands:', h.dondeEsta], ['What is next:', h.queSigue], ['What blocks it:', h.queLoBloquea]].filter(([, v]) => v);
  return `<div class="roadmap" data-act="toggle-roadmap" data-id="${r.id}" title="Click to show the roadmap header">
    <div class="rm-line"><span class="rm-dot ${esc(s.kind)}"></span><span class="rm-text" title="${esc(text)}">${esc(text)}</span>${badge}<span class="rm-count">${s.done}/${s.total}</span></div>
    <div class="rm-bar"><span style="width:${s.pct}%"></span></div>
    ${open ? `<div class="rm-header">${lines.map(([k, v]) => `<div><b>${k}</b> ${esc(v)}</div>`).join('')}</div>` : ''}
  </div>`;
}

// Clean repos have nothing to do, so they collapse to a single line.
function cleanRow(r) {
  const { l, p } = info(r);
  const behind = l.behind ? `<span class="behind" title="${l.behind} commit${l.behind === 1 ? '' : 's'} behind the remote — time to pull">↓${l.behind}</span>` : '';
  const warn = p.error ? `<span class="warn" title="${esc('GitHub: ' + p.error)}">⚠</span>` : '';
  return `<div class="clean-row">
    ${groupTag(r.group)}${roomTag(r)}${repoName(r, p.repo?.url)}
    <span class="branch" title="${esc(l.branch || '')}">${esc(l.branch || (l.detached ? '(detached)' : ''))}</span>${behind}${warn}${spinner(r)}
    <span class="row-actions">${moreMenu(r, 'row')}${removeBtn(r)}</span>
    ${reqWarn(r)}
    ${roadmapBlock(r)}
  </div>`;
}

// "committing…" while the last /flow-commit runs; a red bar with the reason (and a way to dismiss it) when it went wrong.
function verdictRow(r, verdict) {
  if (!verdict) return '';
  if (verdict.state === 'running') return `<div class="verdict-line" title="${esc(verdict.reason)}">committing…</div>`;
  if (verdict.state !== 'attention') return '';
  return `<div class="attn-bar"><span>⚠ Needs attention: ${esc(verdict.reason)}</span><button data-act="dismiss-sent" data-id="${r.id}" title="Dismiss">✕</button></div>`;
}

function repoCard(r, attn = false, verdict = null) {
  const { l, p, dirty, unpushed } = info(r);
  const manual = V ? V.manualAction(l, l.base) : null;
  const override = S.showCommit.has(r.id);
  // The flow buttons come from view.js; without it only /flow-commit is offered, as before.
  const flow = V ? V.flowButtons(l, p, S.state[r.id], { override, verdict: verdict && verdict.state }) : dirty ? [{ cmd: 'flow-commit', label: '/flow-commit' }] : [];
  const overrideItem = !manual && dirty && V ? V.commitOverrideItem(S.state[r.id], { override, stale: !!p.stale }) : null;
  const chips = [];
  if (dirty) chips.push(`<button class="chip yellow chip-btn" data-act="diff" data-id="${r.id}" title="View diff">● ${l.files.length} file${l.files.length === 1 ? '' : 's'} <span class="add">+${l.added}</span> <span class="del">−${l.deleted}</span></button>`);
  if (unpushed) chips.push(`<span class="chip blue">↑ ${l.ahead} unpushed${l.noUpstream ? ' · no upstream' : ''}</span>`);
  if (l.behind) chips.push(`<span class="chip gray">↓ ${l.behind} behind</span>`);
  if (p.stale) chips.push(`<span class="chip red" title="${esc(V ? V.staleChipTitle(p.stale, dirty) : p.stale.reason)}">${esc(p.stale.reason)}</span>`);
  else if (l.currentGone) chips.push('<span class="chip gray" title="The remote branch was deleted (merged PR?)">remote branch deleted</span>');
  if (p.noRemote) chips.push('<span class="chip gray">no GitHub remote</span>');
  return `<div class="card ${attn ? 'attn' : ''}">
    ${cardTop(r, p.repo?.url, 'repo', overrideItem ? [overrideItem] : [])}
    ${manual ? `<div class="manual-bar">⚠ Needs manual action: ${esc(manual)}</div>` : ''}
    ${verdictRow(r, verdict)}
    ${reqWarn(r)}
    <div class="branch one-line" title="${esc(l.branch || '')}">${esc(l.branch || (l.detached ? '(detached)' : ''))}</div>
    ${stateRow(r)}
    ${roadmapBlock(r)}
    ${chips.length ? `<div class="chips">${chips.join('')}</div>` : ''}
    ${l.error ? `<div class="err">${esc(l.error)}</div>` : ''}
    ${p.error ? `<div class="err">GitHub: ${esc(p.error)}</div>` : ''}
    ${flow.map((b) => `<div class="actions">${piBtn(r, b.cmd, b.label, b.reason ? { title: b.reason } : {})}</div>`).join('')}
  </div>`;
}

function checksChip(c) {
  if (c.state === 'none') return '<span class="chip gray">no checks</span>';
  const tip = esc(c.items.map((i) => `${i.state === 'success' ? '✔' : i.state === 'failed' ? '✘' : '…'} ${i.name}`).join('\n'));
  if (c.state === 'success') return `<span class="chip green" title="${tip}">✔ ${c.passed}/${c.total} checks</span>`;
  if (c.state === 'failed') return `<span class="chip red" title="${tip}">✘ ${c.failed} failed · ${c.passed}/${c.total}</span>`;
  return `<span class="chip yellow" title="${tip}">… ${c.pending} running · ${c.passed}/${c.total}</span>`;
}

const FIX_PR_HINT = 'Ask the open pi session to find out why the checks failed and fix it (it will not commit or push)';

function prCard(r, pr, meta) {
  const busy = S.busy[`${r.id}:${pr.number}`];
  const showReason = !pr.ready && pr.blockedReason && pr.checks.state !== 'pending' && pr.checks.state !== 'failed';
  const n = `data-id="${r.id}" data-n="${pr.number}"`;
  return `<div class="card ${isProblem(pr) ? 'attn' : ''}">
    ${cardTop(r, meta?.url, `pr${pr.number}`)}
    ${reqWarn(r)}
    <a class="pr-title" href="${esc(pr.url)}" target="_blank" rel="noopener" title="${esc(pr.title)}">#${pr.number} ${esc(pr.title)}</a>
    <div class="branch one-line" title="${esc(pr.head + ' → ' + pr.base)}">${esc(pr.head)} → ${esc(pr.base)}</div>
    <div class="chips">
      ${checksChip(pr.checks)}
      ${pr.isDraft ? '<span class="chip gray">draft</span>' : ''}
      ${pr.reviewDecision === 'REVIEW_REQUIRED' ? '<span class="chip yellow">review required</span>' : ''}
      ${pr.reviewDecision === 'CHANGES_REQUESTED' ? '<span class="chip red">changes requested</span>' : ''}
      ${showReason ? `<span class="chip ${pr.mergeStateStatus === 'DIRTY' || pr.mergeStateStatus === 'BEHIND' ? 'red' : 'gray'}">${esc(pr.blockedReason)}</span>` : ''}
    </div>
    <div class="merge-row">
      <button class="merge" data-act="merge" ${n} ${pr.ready && !busy ? '' : 'disabled'}
        title="${esc(pr.ready ? 'Merge into ' + pr.base : pr.blockedReason)}">${busy ? 'Merging…' : `Merge · ${S.prefs.method}`}</button>
      <button data-act="snooze" ${n} title="Park this PR at the bottom of the column until it is ready to merge (stays parked if it is already ready)">💤</button>
    </div>
    ${pr.checks.failedRuns.length ? `<button data-act="rerun" ${n} ${busy ? 'disabled' : ''}>Re-run failed</button>` : ''}
    ${V && V.fixPrAction(pr).show ? piBtn(r, 'fix-pr', 'Fix with pi', { pr: pr.number, title: FIX_PR_HINT }) : ''}
  </div>`;
}

// ---------- diff drawer ----------
function renderDiff(text) {
  const parts = text.split(/^diff --git /m).filter((x) => x.trim());
  if (!parts.length) return '<div class="empty">No diff available.</div>';
  return parts.map((part, i) => {
    const lines = part.split('\n');
    const m = /^a\/(.+?) b\/(.+)$/.exec(lines[0]);
    const title = m ? m[2] : lines[0];
    const body = lines.slice(1).map((ln) => {
      const cls = ln.startsWith('@@') ? 'h' : ln.startsWith('+') && !ln.startsWith('+++') ? 'a'
        : ln.startsWith('-') && !ln.startsWith('---') ? 'd'
          : /^(index |new file|deleted file|similarity|rename|old mode|new mode|\+\+\+|---|Binary)/.test(ln) ? 'm' : '';
      return `<div class="${cls}">${esc(ln) || ' '}</div>`;
    }).join('');
    return `<details class="file" ${parts.length <= 15 || i === 0 ? 'open' : ''}><summary>${esc(title)}</summary><div class="diff">${body}</div></details>`;
  }).join('');
}

async function openDiff(id) {
  S.confOpen = false;
  const l = S.local[id] || {};
  $('#drawerTitle').textContent = `${nameOf(id)} · ${l.branch || ''}`;
  $('#drawerBody').innerHTML = '<div class="empty">Loading diff…</div>';
  $('#drawer').hidden = false;
  try {
    const d = await api(`/api/diff?id=${id}`);
    const list = (l.files || []).map((f) => `<div><span class="st">${esc(f.status)}</span><span>${esc(f.path)}</span>
      <span class="add">${f.binary ? 'bin' : '+' + f.added}</span><span class="del">${f.binary ? '' : '−' + f.deleted}</span></div>`).join('');
    $('#drawerBody').innerHTML = `<div class="filelist">${list}</div>${d.truncated ? '<div class="err">Diff truncated (too large).</div>' : ''}${renderDiff(d.diff)}`;
  } catch (e) { $('#drawerBody').innerHTML = `<div class="err">${esc(e.message)}</div>`; }
}

// ---------- actions ----------
async function doMerge(id, n) {
  const pr = (S.prs[id]?.prs || []).find((x) => x.number === n);
  if (!pr || S.busy[`${id}:${n}`]) return;
  const { method, del } = S.prefs;
  S.busy[`${id}:${n}`] = true; draw();
  try {
    const r = await api('/api/merge', { id, number: n, method, deleteBranch: del });
    toast(`#${n} merged${r.branch === 'deleted' ? ' · branch deleted' : r.branch === 'auto' ? ' · branch auto-deleted' : ''}`, 'ok');
  } catch (e) { toast(`#${n}: ${e.message}`, 'bad'); }
  delete S.busy[`${id}:${n}`];
  await refreshRepo(id);
}

async function doRerun(id, n) {
  S.busy[`${id}:${n}`] = true; draw();
  try { const r = await api('/api/rerun', { id, number: n }); toast(`Re-running ${r.rerun} workflow run(s)`, 'ok'); }
  catch (e) { toast(e.message, 'bad'); }
  delete S.busy[`${id}:${n}`];
  setTimeout(() => refreshRepo(id), 2500);
}

async function addRepos(paths) {
  const group = $('#addGroup').value.trim();
  if (!group) { toast('Pick or type a group first', 'bad'); return; }
  let ok = 0;
  for (const path of paths) {
    try { await api('/api/repos', { path, group }); ok++; } catch (e) { toast(`${path}: ${e.message}`, 'bad'); }
  }
  if (!ok) return;
  toast(`${ok} repo(s) added`, 'ok');
  await loadConfig();
  draw();
  refreshAll();
}

// Re-reads the rooms after the server changed them; the board and the drawer follow.
async function reloadRooms() {
  await loadConfig();
  draw();
  loadRooms();
}

async function createRoom() {
  const err = $('#roomError');
  const btn = $('#roomSubmit');
  err.hidden = true;
  btn.disabled = true;
  try {
    await api('/api/rooms/create', { name: $('#roomName').value, path: $('#roomPath').value.trim() });
    $('#roomDialog').close();
    toast('Room added', 'ok');
    await reloadRooms();
  } catch (e) { err.textContent = e.message; err.hidden = false; }
  btn.disabled = false;
}

const ACTIONS = {
  'refresh-all': () => refreshAll(),
  'fetch-all': async () => { toast('Fetching all repos…'); await Promise.all(allRepos().map((r) => fetchRepo(r.id))); toast('Fetch done', 'ok'); },
  'diff': (el) => openDiff(el.dataset.id),
  'close-drawer': () => { S.confOpen = false; $('#drawer').hidden = true; },
  'conformity': () => openConformity(),
  'pi': async (el) => {
    const { id, cmd, pr } = el.dataset;
    el.disabled = true;
    try {
      // The baseline of the verdict is read fresh, right before sending, so a stale card cannot fake "HEAD changed".
      const before = cmd === 'flow-commit' ? await api(`/api/local?id=${id}`).catch(() => null) : null;
      const d = await api('/api/pi', pr ? { id, command: cmd, pr: Number(pr) } : { id, command: cmd });
      if (before && !before.error && d.sent) {
        S.local[id] = before;
        S.sent[id] = { at: Date.now(), head: before.head ?? null, files: before.files.length };
        delete S.pistatus[id];
        draw();
        loadPiStatus(id);
      }
      const what = cmd === 'fix-pr' ? `the fix order for #${pr}` : cmd === 'flow-base-stash' ? '/flow-base --stash' : `/${cmd}`;
      toast(d.confirmed ? `Sent ${what} to pi` : `Sent ${what}, not confirmed: check the pi session`, d.confirmed ? 'ok' : '');
    } catch (e) { toast(e.message, 'bad'); }
    el.disabled = false;
  },
  'room-dialog': () => {
    S.menu = null;
    draw();
    $('#roomForm').reset();
    $('#roomError').hidden = true;
    $('#roomDialog').showModal();
    $('#roomName').focus();
  },
  'close-room-dialog': () => $('#roomDialog').close(),
  'assign-room': async (el) => {
    S.menu = null;
    draw();
    try {
      await api('/api/rooms/assign', { id: el.dataset.id, room: el.dataset.room || null });
      await reloadRooms();
    } catch (e) { toast(e.message, 'bad'); }
  },
  'remove-room': async (el) => {
    const name = el.dataset.name;
    if (!confirm(`Remove the room "${name}" from the panel?\nThis only removes its registration: the room folder and the repos are not touched, and its members become unassigned.`)) return;
    try {
      await api('/api/rooms/remove', { name });
      await reloadRooms();
    } catch (e) { toast(e.message, 'bad'); }
  },
  // Page session only (never persisted): lifts the declared-state gating of the /flow-commit button for this repo.
  'show-commit': (el) => { S.menu = null; S.showCommit.add(el.dataset.id); draw(); },
  'dismiss-sent': (el) => { delete S.sent[el.dataset.id]; delete S.pistatus[el.dataset.id]; draw(); },
  'toggle-menu': (el) => { S.menu = S.menu === el.dataset.menu ? null : el.dataset.menu; draw(); },
  'hide-warning': (el) => setDismissed(el.dataset.id, true),
  'toggle-warning': (el) => { S.menu = null; return setDismissed(el.dataset.id, !S.dismissed.has(el.dataset.id)); },
  // The server builds the order from the repo's requirements; `confirmed` only means the prompt left idle.
  'put-in-conditions': async (el) => {
    S.menu = null;
    draw();
    try {
      const d = await api('/api/pi', { id: el.dataset.id, command: 'put-in-conditions' });
      toast(d.confirmed ? 'Sent the put-in-conditions order to pi' : 'Sent the put-in-conditions order, not confirmed: check the pi session', d.confirmed ? 'ok' : '');
    } catch (e) { toast(e.message, 'bad'); }
  },
  'merge': (el) => doMerge(el.dataset.id, Number(el.dataset.n)),
  'queue-pick': (el) => {
    if (el.dataset.close) ACTIONS['close-drawer']();
    S.q = el.dataset.name; $('#search').value = S.q; draw();
  },
  'toggle-problems': () => { S.onlyProblems = !S.onlyProblems; draw(); },
  'snooze': (el) => setSnooze(el.dataset.id, Number(el.dataset.n), true),
  'unsnooze': (el) => setSnooze(el.dataset.id, Number(el.dataset.n), false),
  'toggle-snoozed': (el) => { S.snoozedOpen[el.dataset.col] = !S.snoozedOpen[el.dataset.col]; draw(); },
  'toggle-roadmap': (el) => { S.rmOpen[el.dataset.id] = !S.rmOpen[el.dataset.id]; draw(); },
  'rerun': (el) => doRerun(el.dataset.id, Number(el.dataset.n)),
  'remove': async (el) => {
    const id = el.dataset.id;
    if (!confirm(`Remove "${nameOf(id)}" from the panel?\n(Nothing is deleted from disk or GitHub.)`)) return;
    await api('/api/repos/remove', { id }).catch((e) => toast(e.message, 'bad'));
    await loadConfig(); draw();
  },
  'add-dialog': () => { $('#scanResults').innerHTML = ''; $('#addSelected').hidden = true; $('#addDialog').showModal(); },
  'close-dialog': () => $('#addDialog').close(),
  'add-one': async () => { const p = $('#addPath').value.trim(); if (p) { await addRepos([p]); $('#addPath').value = ''; } },
  'scan': async () => {
    const dir = $('#addPath').value.trim();
    try {
      S.scan = (await api(`/api/scan?dir=${encodeURIComponent(dir)}`)).repos;
      $('#scanResults').innerHTML = S.scan.length ? S.scan.map((s, i) => `<label class="${s.added ? 'done' : ''}">
        <input type="checkbox" data-scan="${i}" ${s.added ? 'disabled' : 'checked'}> ${esc(s.path)} ${s.added ? '(already added)' : ''}</label>`).join('') : '<div class="done">No git repositories found.</div>';
      $('#addSelected').hidden = !S.scan.some((s) => !s.added);
    } catch (e) { toast(e.message, 'bad'); }
  },
  'add-selected': async () => {
    const picked = [...document.querySelectorAll('[data-scan]:checked')].map((c) => S.scan[Number(c.dataset.scan)].path);
    if (picked.length) { await addRepos(picked); $('#addDialog').close(); }
  },
};

document.addEventListener('click', (e) => {
  if (S.menu && !e.target.closest('.more')) { S.menu = null; draw(); }
  const el = e.target.closest('[data-act]');
  if (!el || el.disabled) return;
  if (el.tagName === 'A') return;
  ACTIONS[el.dataset.act]?.(el);
});

// Enter in the room form adds the room (the form is not a method=dialog form, which would just close it).
document.addEventListener('submit', (e) => {
  if (e.target.id !== 'roomForm') return;
  e.preventDefault();
  createRoom();
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && S.menu) { S.menu = null; draw(); }
});

// The passing list of a repo stays open (or closed) across redraws. `toggle` does not bubble, so capture it.
document.addEventListener('toggle', (e) => {
  if (e.target.matches && e.target.matches('details.req-passing')) S.reqPassOpen[e.target.dataset.id] = e.target.open;
}, true);

document.addEventListener('change', (e) => {
  const key = e.target.dataset.pref;
  if (!key) return;
  S.prefs[key] = e.target.type === 'checkbox' ? e.target.checked : e.target.value;
  localStorage.setItem('prefs', JSON.stringify(S.prefs));
  draw();
});

$('#search').addEventListener('input', (e) => { S.q = e.target.value; draw(); });
$('#groupFilter').addEventListener('change', (e) => { S.group = e.target.value; draw(); });

// Auto-refresh while the tab is visible and nothing is being merged.
setInterval(() => {
  if (!document.hidden && !Object.keys(S.busy).length) refreshAll();
}, 60000);
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && Date.now() - S.lastRefresh > 30000) refreshAll();
});

(async () => {
  try { await loadConfig(); } catch (e) { toast(e.message, 'bad'); }
  $('#method').value = S.prefs.method;
  $('#delBranch').checked = S.prefs.del;
  draw();
  if (location.hash === '#conformity') openConformity(); // deep link
  refreshAll();
})();
