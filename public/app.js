'use strict';
const TOKEN = document.querySelector('meta[name=token]').content;
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
// view.js is missing when an old server (which does not serve it) answers: the page must still run.
const V = window.RepoPanelView || null;
// resumen.js (the Summary tab) is optional in the same way: without it the tab simply does not paint.
const R = window.RepoPanelResumen || null;
const store = (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } };

// RP47: a region is written only when its HTML changed. The board was replaced on every redraw (about 150 times a minute at
// rest, because every read of every repo redraws when it starts and when it ends), and a press that spans a replacement
// loses its target: the `click` never fires. Whatever else writes into one of these elements must go through `paint` too, or
// the cache would hide the next identical paint.
const painted = new WeakMap();
function paint(el, html) {
  if (painted.get(el) === html) return false;
  el.innerHTML = html;
  painted.set(el, html);
  return true;
}

const S = {
  groups: [], local: {}, prs: {}, roadmap: {}, rmOpen: {}, loading: {}, busy: {},
  snoozed: new Set(), keepSnoozed: new Set(), snoozedOpen: {}, onlyProblems: false,
  dismissed: new Set(), menu: null, reqPassOpen: {},
  group: '', q: '', queue: [], queueKey: '', queueSeq: 0,
  conf: { items: [], ok: 0, loaded: false, failed: false, key: '', seq: 0 },
  req: {}, reqSeq: {}, state: {}, stateSeq: {}, sent: {}, pistatus: {}, pistatusSeq: {}, sending: {}, merged: {}, pending: {}, finishing: {}, showCommit: new Set(), prereq: { state: 'loading', items: [], seq: 0, pi: null },
  rooms: [], roomIssues: [], roomData: { state: 'loading', data: null }, roomSeq: 0,
  prefs: store('prefs', { method: 'squash', del: true }),
  lastRefresh: 0, lastAt: {}, scan: [],
  boardRev: 0, boardRefreshing: [], factAt: {},
  tab: 'summary', scope: { kind: 'all' }, summary: null, summaryKey: '', summaryFailed: false, sfilter: 'all', collapsed: {},
  timeouts: { get: 25000, post: 70000 },
  tasks: {}, tasksFilter: '', tasksOpenDone: false, changes: {}, files: {}, filesOpen: {}, fileData: {}, pad: {},
  chat: { id: null, seq: 0 }, chatCache: {}, drafts: {}, recall: {}, notes: {}, askBusy: {}, rpc: {},
};
S.tab = S.prefs.tab === 'work' ? 'work' : 'summary';
S.backTab = S.tab; // the tab Conformity returns to (it is never saved as the preference)

// ---------- derived state ----------
// RP86 (S9): the read model of a repo (V.repoModel); info(), the Summary chips and button, the strip and the Files tab all read it.
// The Summary row is given only by who draws a Summary card (summaryShown): the others do not need it, and then the verdict is not looked at.
const modelOf = (id, row = null) => V.repoModel({ local: S.local[id], prs: S.prs[id], roadmap: S.roadmap[id], state: S.state[id], req: S.req[id], row, running: !!row && commandRunning(id) });
function info(r) {
  const m = modelOf(r.id);
  return { l: m.l, p: m.p, prs: m.prs, dirty: m.dirty, unpushed: m.unpushed, ready: m.ready };
}

// The shared filters (text, group, room scope) of both tabs. Without resumen.js the scope degrades to all.
function visibleRepos() {
  const q = S.q.toLowerCase();
  const scope = R ? R.normalizeScope(S.scope, S.rooms) : { kind: 'all' };
  const members = scope.kind === 'room' ? ((S.rooms.find((m) => m.name === scope.name) || {}).repos || []) : [];
  const assigned = scope.kind === 'none' ? new Set(S.rooms.flatMap((m) => m.repos || [])) : null;
  const inScope = (r) => (scope.kind === 'room' ? members.includes(r.id) : assigned ? !assigned.has(r.id) : true);
  return allRepos().filter((r) => (!S.group || r.group === S.group) && (!q || r.name.toLowerCase().includes(q)) && inScope(r));
}

// ---------- go work on ----------
// Per-repo facts for /api/queue, only for repos whose local and PR state have loaded.
function queueItems() {
  return visibleRepos().filter((r) => S.local[r.id] && S.prs[r.id]).map((r) => {
    const m = modelOf(r.id);
    const { p, prs, dirty, unpushed } = m;
    const rm = m.roadmap;
    const s = rm && rm.available ? rm.summary : null;
    const flags = V ? V.queueFlags(S.local[r.id], m.state, verdictOf(r), { override: S.showCommit.has(r.id) }) : {};
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
  paint(el, S.queue.length ? `<strong>Go work on</strong>${S.queue.slice(0, QUEUE_MAX).map((a) => {
    const text = `${a.name} · ${QUEUE_TEXT[a.kind](a)}`;
    const title = QUEUE_TITLE[a.kind] ? `${a.name} · ${QUEUE_TITLE[a.kind](a)}` : text;
    return `<button class="chip chip-btn ${QUEUE_COLOR[a.kind]}" data-act="queue-pick" data-name="${esc(a.name)}" title="${esc(title)}">${esc(text)}</button>`;
  }).join('')}${S.queue.length > QUEUE_MAX ? `<span class="muted">+${S.queue.length - QUEUE_MAX} more</span>` : ''}` : '');
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

// RPC1a: the pi in use, chosen among Auto and the detected runtimes; it only affects sessions started afterwards.
function piSelect(pi) {
  if (!pi) return '';
  const opts = [['auto', 'Auto'], ...pi.candidates.filter((c) => c.available).map((c) => [c.id, c.label])];
  const options = opts.map(([id, label]) => `<option value="${esc(id)}"${id === pi.mode ? ' selected' : ''}>${esc(label)}</option>`).join('');
  return `<div class="conf-line">pi to use: <select data-pi-runtime aria-label="pi to use">${options}</select></div>`;
}

function prereqBlock() {
  const p = S.prereq;
  const lines = p.state === 'loaded'
    ? p.items.map((i) => `<div class="conf-line req-${i.ok ? 'pass' : 'fail'}">${i.ok ? '✓' : '✗'} ${esc(i.id)} · ${esc(i.detail)}</div>`).join('')
    : `<div class="conf-line">${p.state === 'failed' ? 'Could not check the prerequisites' : 'Checking the prerequisites…'}</div>`;
  return `<div class="conf-item"><div class="conf-title">Prerequisites on this machine</div>${lines}${piSelect(p.pi)}</div>`;
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
  // The same action as the card's ⋯ menu (and its protection against a second click): offered while any requirement is open.
  const offered = V && V.cardMenu(e, false).some((i) => i.act === 'put-in-conditions');
  const put = offered ? `<button class="conf-put" data-act="put-in-conditions" data-id="${esc(r.id)}"${S.sending[r.id] ? ' disabled' : ''} title="Asks the session of this repo to apply the requirements that are not passing">Put in conditions</button>` : '';
  return `<div class="conf-item">${name}${put}${reqResults(r.id, e.data)}</div>`;
}

// A room: its folder, its own requirements and the repos assigned to it.
const REASON_OF = { idle: 'free', busy: 'working', starting: 'working', asking: 'waiting', closed: 'none' };
function roomBlock(m) {
  const last = m.lastCommit ? m.lastCommit.slice(0, 10) : 'unknown';
  const members = m.repos.length ? m.repos.map((id) => (allRepos().some((r) => r.id === id) ? nameOf(id) : `${id} (not in the panel)`)).join(', ') : 'none yet';
  return `<div class="conf-item"><div class="conf-title"><span class="dot dot-gray"></span> ${esc(m.name)}<button data-act="remove-room" data-name="${esc(m.name)}" title="Only removes the room from the panel; its folder and repos are not touched">Remove room</button></div>
    <div class="conf-line">${esc(m.path)}</div>
    <div class="conf-line">Last commit ${esc(last)}</div>
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
  if (S.tab !== 'conformity') return;
  const sum = v.summary ? `<div class="conf-sum">${esc(v.summary)}</div>` : '';
  const body = v.state === 'issues' ? S.conf.items.map(confBlock).join('') : `<div class="${v.state === 'error' ? 'conf-error' : 'empty'}">${esc(v.message)}</div>`;
  const reqs = V ? `<div class="conf-heading">Requirements</div>${allRepos().map(reqBlock).join('')}${roomsBlock()}` : '';
  paint($('#conformityView'), sum + prereqBlock() + body + reqs);
}

function openConformity() { setTab('conformity'); }

// ---------- summary ----------
// GET /api/summary on the 60 s cycle and every 20 s while the tab is shown. generatedAt changes on every answer, so it is left
// out of the comparison: the page redraws only when the payload really changed. A failed read keeps the last data.
const SUMMARY_TIMEOUT_MS = 90000;
const SUMMARY_LOADING_MS = 2000;
let summarySeq = 0;
let summaryApplied = 0;
async function loadSummary() {
  const seq = ++summarySeq; // RP86: an answer older than one already applied is dropped (an older one that arrives FIRST still applies: a slow build never starves the Summary)
  try {
    // The whole-board build takes 20 to 30 s on a slow machine until RP78 serves it from memory: a 25 s limit would show a false failure.
    const d = await api('/api/summary', undefined, { timeoutMs: SUMMARY_TIMEOUT_MS });
    if (seq < summaryApplied) return;
    summaryApplied = seq;
    const key = JSON.stringify({ ...d, generatedAt: null });
    const recovered = S.summaryFailed;
    S.summaryFailed = false;
    if (key !== S.summaryKey || recovered) {
      S.summary = d;
      S.summaryKey = key;
      draw();
    }
    // RP78: rows the store has not read yet are `loading`: ask again soon instead of waiting for the 20 s tick.
    if (Array.isArray(d.rows) && d.rows.some((r) => r.loading)) setTimeout(summaryTick, SUMMARY_LOADING_MS);
  } catch {
    if (seq >= summaryApplied && !S.summaryFailed) { S.summaryFailed = true; draw(); }
  }
}
const summaryTick = () => { if (S.tab === 'summary' && !document.hidden) loadSummary(); };

// Tabs only toggle `hidden` (the board keeps its own painting); the view-specific zone of the view bar hides through a body class.
function applyTab() {
  $('#sumLayout').hidden = S.tab !== 'summary'; // the chat lives inside this wrapper: it exists only in Summary (S56)
  $('#work').hidden = S.tab !== 'work';
  $('#conformityView').hidden = S.tab !== 'conformity';
  if (document.body && document.body.classList) for (const t of ['summary', 'work', 'conformity']) document.body.classList.toggle(`tab-${t}`, S.tab === t);
  for (const b of Array.from((document.querySelectorAll && document.querySelectorAll('.rs-tabs [role=tab][data-tab]')) || [])) b.setAttribute('aria-selected', String(b.dataset.tab === S.tab));
}
// Conformity is a tab like the others but never the saved one: a reload comes back to Summary or Work, and a repo picked in it returns there.
function setTab(tab) {
  if (tab === 'conformity' && S.tab !== 'conformity') S.backTab = S.tab;
  S.tab = tab;
  applyTab();
  if (tab === 'conformity') draw(); else setPref('tab', tab);
  if (tab === 'summary') { loadSummary(); if (S.chat.id) loadChat(S.chat.id); }
}

// The "deliver" button of a Summary row is the first button the board's own card would show for that repo.
function summaryFlow(id) {
  const r = allRepos().find((x) => x.id === id);
  const m = modelOf(id);
  if (!r || !m.loaded) return null;
  return flowFor(r, m.l, m.p, verdictOf(r))[0] || null;
}

// The change chips of a Summary card come from the same local state as the board card; null until that repo is loaded.
function summaryChanges(id) {
  return modelOf(id).changes;
}

// RP94c: the open PRs of a repo for the Summary card's chip; the same list the board's PR cards draw (empty while they are not loaded or when the read failed).
function summaryPrs(id) {
  return modelOf(id).prs;
}

// RP94d: when the newest uncommitted change was made (the server's `lastChangeMs`), only for a repo that HAS uncommitted changes; null otherwise.
function summaryIdle(id) {
  const m = modelOf(id);
  return m.dirty && typeof m.l.lastChangeMs === 'number' ? m.l.lastChangeMs : null;
}

// A repo whose command is running (being sent, or sent and not finished) shows the session as working at once; the server
// state shows again when the verdict ends. Copies only: S.summary is never changed.
const commandRunning = (id) => { const v = verdictOf({ id }); return !!v && v.state === 'running'; };
const summaryShown = () => (S.summary && Array.isArray(S.summary.rows)
  ? { ...S.summary, rows: S.summary.rows.map((r) => modelOf(r.id, r).row) }
  : S.summary);
// The chat as the label and the body see it: the pending messages and the live session (S.rpc) of the open repo.
function chatView() {
  const id = S.chat.id;
  return { ...S.chat, pending: S.pending[id], askBusy: S.askBusy, rpc: S.rpc[id] };
}

function drawSummary() {
  applyTab();
  if (!R) return;
  const scope = R.normalizeScope(S.scope, S.rooms);
  const hadFocus = !!(document.activeElement && document.activeElement.dataset && document.activeElement.dataset.act === 'scope');
  if (paint($('#scope'), R.scopeBar(S.rooms, allRepos().length, scope)) && hadFocus) { const on = $('#scope [aria-pressed="true"]'); if (on && on.focus) on.focus(); }
  // The group buttons live inside #summary and the Needs attention toggle in the view bar: keep the focus on the pressed one.
  const ae = document.activeElement;
  const kept = ae && ae.dataset && (ae.dataset.act === 'sfilter' || ae.dataset.act === 'toggle-group') ? { act: ae.dataset.act, filter: ae.dataset.filter, group: ae.dataset.group } : null;
  const box = $('#summary');
  const ctx = {
    now: Date.now(), scope, rooms: S.rooms, q: S.q, group: S.group, roomData: S.roomData.data, filter: S.sfilter, collapsed: S.collapsed, failed: S.summaryFailed,
    flowFor: summaryFlow, changesFor: summaryChanges, prsFor: summaryPrs, idleFor: summaryIdle, sending: S.sending, busy: busyView(), chatId: S.chat.id,
  };
  if (paint($('#summaryTools'), R.summaryTools(S.summary, ctx)) && kept && kept.act === 'sfilter') { const on = $('#summaryTools [data-act="sfilter"]'); if (on && on.focus) on.focus(); }
  const changed = paint(box, R.summaryView(summaryShown(), ctx));
  if (changed && kept && kept.act === 'toggle-group' && box.querySelectorAll) {
    const again = Array.from(box.querySelectorAll('[data-act]')).find((b) => b.dataset && b.dataset.act === kept.act && b.dataset.filter === kept.filter && b.dataset.group === kept.group);
    if (again && again.focus) again.focus();
  }
}

// ---------- chat (RP54) ----------
// One chat for the whole Summary: the repo card that is open. It only READS (GET /api/sessions, GET /api/chat) and runs the
// explicit Adopt and Start session buttons; the panel sends no text to any session from here.
const CHAT_MS = 5000;
const chatUrl = (path, id) => `${path}?id=${encodeURIComponent(id)}`;
let chatShown = null;
// RP89 (S4): the three blocks of the Summary with a repo open (list | chat | column). The saved shares of the LIST and of the COLUMN ({ list, col }); the chat is what is left. The ratio the
// old single divider saved measured another thing and is ignored. Under COLUMN_FROM px of layout the column is out (two blocks, as before).
const LAYOUT_KEY = 'repo-panel.layout';
const COLUMN_FROM = 1100;
let layoutRatios = {};
try {
  const v = JSON.parse(localStorage.getItem(LAYOUT_KEY));
  if (v && typeof v === 'object' && !Array.isArray(v)) for (const k of ['list', 'col']) if (typeof v[k] === 'number' && v[k] > 0 && v[k] < 1) layoutRatios[k] = v[k];
} catch { /* no storage or a broken value: the default widths */ }

// Opening a card reads with priority user and a signal that the next open or close aborts; the periodic poll does neither.
let chatCtl = null;
async function loadChat(id, { user = false, signal } = {}) {
  const seq = ++S.chat.seq;
  const opts = user ? { priority: 'user', signal } : {};
  try {
    // RP79: both reads start at once (the chat answer is dropped when no session is adopted); either failing fails the whole read.
    const [info, chat] = await Promise.all([api(chatUrl('/api/sessions', id), undefined, opts), api(chatUrl('/api/chat', id), undefined, opts)]);
    const hist = info.adopted ? chat : null;
    const key = JSON.stringify([info, hist]);
    if (V) V.chatCachePut(S.chatCache, id, { info, hist, key }); // a good read feeds the cache even when the card was switched meanwhile
    if (seq !== S.chat.seq || S.chat.id !== id) return; // the user switched card or closed the chat meanwhile
    const recovered = S.chat.failed || S.chat.cached; // a fresh answer equal to the cached one must still end the cached state
    S.chat.failed = false;
    S.chat.cached = false;
    if (key === S.chat.key && !recovered) return;
    Object.assign(S.chat, { info, hist, key });
    draw();
  } catch {
    if (signal && signal.aborted) return; // cancelled on purpose: neither a failure nor a toast
    if (seq === S.chat.seq && S.chat.id === id && !S.chat.failed) { S.chat.failed = true; draw(); }
  }
}
function openChat(id, tab) {
  if (!R || !id || S.chat.id === id) return;
  saveDraft();
  flushNotes();
  S.recall = {};
  S.chat = { id, seq: S.chat.seq + 1, ...(V && V.chatFromCache(S.chatCache[id])), ...(tab === 'tasks' && !columnOn() ? { tab } : {}) }; // RP79: cached messages at once, state unknown (no get: opening must not reorder the cache)
  $('#msgBox').value = S.drafts[id] || '';
  draw();
  if (chatCtl) chatCtl.abort();
  chatCtl = new AbortController();
  loadChat(id, { user: true, signal: chatCtl.signal });
  rpcSync(id);
}
function closeChat() {
  if (!S.chat.id) return;
  saveDraft();
  flushNotes();
  S.recall = {};
  if (chatCtl) { chatCtl.abort(); chatCtl = null; }
  S.chat = { id: null, seq: S.chat.seq + 1 };
  chatShown = null;
  draw();
}
const chatTick = () => { if (S.chat.id && (!S.chat.tab || S.chat.tab === 'chat') && S.tab === 'summary' && !document.hidden && !(V && pollSkipped('chat'))) loadChat(S.chat.id); };

// RP63 (S60): the Tasks tab reads /api/roadmap once per chat opening, when the tab is first shown. The last good answer of a repo
// is kept; a failure only shows when there is none. An answer for a repo the person left is stored but never painted for another.
// RP91: the opening is identified by the S.chat OBJECT (openChat and closeChat replace it), not by `seq`: loadChat bumps `seq` on every read and, with the tasks in the column, the chat keeps
// being read while the roadmap is on its way.
async function loadTasks() {
  const chat = S.chat;
  const { id } = chat;
  if (!id || chat.tasksAsked) return;
  chat.tasksAsked = true;
  chat.tasksLoading = true;
  chat.tasksFailed = false;
  try {
    S.tasks[id] = await api(`/api/roadmap?id=${id}`);
  } catch {
    if (S.chat === chat) chat.tasksFailed = true;
  }
  if (S.chat === chat) { chat.tasksLoading = false; draw(); }
}
// RP64 (S62): the Changes tab reads /api/diff each time the person SWITCHES to it (the files change), keeps the last good answer of a repo,
// and only the latest read of a chat opening counts. A read of a repo the person left is stored for that repo and never paints another.
// RP90: the opening is identified by the S.chat OBJECT, not by `seq` (loadChat bumps it on every poll, and the diff tab can be left for the chat while a read is on its way).
async function loadChanges() {
  const chat = S.chat;
  const { id } = chat;
  if (!id) return;
  const req = (chat.changesReq = (chat.changesReq || 0) + 1);
  chat.changesLoading = true;
  chat.changesFailed = false;
  try {
    const d = await api(`/api/diff?id=${id}`);
    if (chat.changesReq === req) S.changes[id] = d;
  } catch {
    if (chat.changesReq === req && S.chat === chat) chat.changesFailed = true;
  }
  if (chat.changesReq === req && S.chat === chat) { chat.changesLoading = false; draw(); }
}
// RP65 (S62): the Files tab reads the tree (/api/files) each time the person SWITCHES to it and the open file again with it; opening a file reads
// /api/file. Only the latest read of each kind counts and a read for a repo the person left is never painted over another. Nothing is written.
async function loadFiles() {
  const chat = S.chat;
  const { id, seq } = chat;
  if (!id) return;
  const req = (chat.filesReq = (chat.filesReq || 0) + 1);
  chat.filesLoading = true;
  chat.filesFailed = false;
  try {
    const d = await api(`/api/files?id=${id}`);
    if (chat.filesReq === req) S.files[id] = d;
  } catch {
    if (chat.filesReq === req && S.chat.seq === seq) chat.filesFailed = true;
  }
  if (chat.filesReq === req && S.chat.seq === seq) { chat.filesLoading = false; draw(); }
  if (chat.filesReq === req && chat.fpath) loadFile(chat.fpath);
}
async function loadFile(p) {
  const chat = S.chat;
  const { id, seq } = chat;
  if (!id) return;
  const req = (chat.fileReq = (chat.fileReq || 0) + 1);
  chat.fpath = p;
  chat.fileLoading = true;
  chat.fileFailed = '';
  draw();
  try {
    const d = await api(`/api/file?id=${id}&path=${encodeURIComponent(p)}`);
    if (chat.fileReq === req) S.fileData[id] = d;
  } catch (e) {
    if (chat.fileReq === req && S.chat.seq === seq) chat.fileFailed = e.message || 'File unavailable';
  }
  if (chat.fileReq === req && S.chat.seq === seq) { chat.fileLoading = false; draw(); }
}
// RP93b (S8): the Notes tab. S.pad[id] = { text, base (the rev last seen, '' when there is no file), savedText, status, error, loaded, saving, again, timer, req, gen }.
// The text lives here, not in the textarea, so it survives leaving the tab or the chat; a read never replaces text that is dirty or being saved, and a conflict never writes.
// Saves of one pad run one at a time: text typed meanwhile sets `again` and goes out, with the new rev, when the one in flight ends. `gen` changes when the text is replaced from outside
// (a read, "Load the version on disk"), which is the only time the textarea is painted again.
const NOTES_MS = 800;
const padOf = (id) => (S.pad[id] ||= { text: '', base: '', savedText: '', status: 'loading', error: '', loaded: false, saving: false, again: false, timer: 0, req: 0, gen: 0 });
const padDirty = (p) => p.text !== p.savedText;
// Reads the notes each time the person SWITCHES to the tab; only the latest read counts and it never replaces unsaved text.
async function loadNotes() {
  const { id } = S.chat;
  if (!id) return;
  const p = padOf(id);
  if (padDirty(p) || p.saving || p.status === 'conflict') return;
  const req = ++p.req;
  if (!p.loaded) { p.status = 'loading'; p.error = ''; }
  try {
    const d = await api(`/api/notes?id=${id}`);
    if (p.req !== req || padDirty(p) || p.saving) return;
    if (d.text !== p.text || !p.loaded) p.gen++;
    Object.assign(p, { text: d.text, savedText: d.text, base: d.rev, loaded: true, status: 'saved', error: '' });
  } catch (e) {
    if (p.req !== req) return;
    if (!p.loaded) { p.status = 'unavailable'; p.error = e.message || ''; }
  }
  draw();
}
async function saveNotes(id) {
  const p = S.pad[id];
  if (!p) return;
  clearTimeout(p.timer);
  p.timer = 0;
  if (!p.loaded || p.status === 'conflict' || !padDirty(p)) return;
  if (p.saving) { p.again = true; return; }
  const sent = p.text;
  p.saving = true;
  p.again = false;
  p.status = 'saving';
  p.req++; // a read still on its way must not land over this text
  try {
    const d = await api('/api/notes', { id, text: sent, base: p.base });
    if (d.conflict) Object.assign(p, { status: 'conflict', error: '', disk: { text: String(d.text ?? ''), rev: String(d.rev ?? '') } });
    else { Object.assign(p, { base: d.rev, savedText: sent, error: '' }); p.status = padDirty(p) ? 'saving' : 'saved'; }
  } catch (e) {
    Object.assign(p, { status: 'error', error: e.message || '' });
  }
  p.saving = false;
  if (p.again && p.status === 'saving') saveNotes(id);
  draw();
}
const flushNotes = (id = S.chat.id) => { if (id && S.pad[id]) saveNotes(id); };
function notesInput(text) {
  const id = S.chat.id;
  if (!id || !S.pad[id]) return;
  const p = S.pad[id];
  p.text = text;
  p.req++;
  if (p.status !== 'conflict') p.status = 'saving';
  clearTimeout(p.timer);
  p.timer = setTimeout(() => saveNotes(id), NOTES_MS);
  draw();
}
function setChatTab(tab) {
  const was = S.chat.tab;
  if (was === 'notes' && tab !== 'notes') flushNotes();
  S.chat.tab = ['tasks', 'changes', 'files', 'notes'].includes(tab) && !((tab === 'tasks' || tab === 'changes') && columnOn()) ? tab : tab === 'diff' && S.chat.dfile ? 'diff' : 'chat'; // RP91, RP92: with the column in, the tasks and the changed files are its cards, not tabs; RP90: the diff tab needs a file
  if (S.chat.tab === 'tasks') loadTasks();
  else if ((S.chat.tab === 'changes' || S.chat.tab === 'diff') && was !== S.chat.tab) loadChanges();
  else if (S.chat.tab === 'files' && was !== 'files') loadFiles();
  else if (S.chat.tab === 'notes' && was !== 'notes') loadNotes();
  draw();
}

// RP91: whether the right column is in (from COLUMN_FROM px of layout): then the tasks are its card and the chat has no Tasks tab.
function columnOn() {
  return ($('#sumLayout').clientWidth || 0) >= COLUMN_FROM;
}
// The widths now: the layout without its separators (the column's separator only counts while the column is in), and the three blocks from the saved shares.
function layoutNow() {
  const width = $('#sumLayout').clientWidth || 0;
  const column = width >= COLUMN_FROM;
  const total = width - ($('#split').offsetWidth || 0) - (column ? ($('#split2').offsetWidth || 0) : 0);
  return total > 0 && R ? { total, column, ...R.blockWidths(total, layoutRatios, { column }) } : null;
}
function applyLayout() {
  const w = layoutNow();
  if (!w) return;
  if ($('#summary').style.setProperty) $('#summary').style.setProperty('--list-w', `${w.list}px`);
  if ($('#col').style.setProperty) $('#col').style.setProperty('--col-w', `${w.col}px`);
  $('#split').setAttribute('aria-valuenow', String(Math.round((w.list / w.total) * 100)));
  $('#split2').setAttribute('aria-valuenow', String(Math.round((w.col / w.total) * 100)));
}
// Sets the list and/or the column to a width in px (the other keeps the one it has), keeps the minimums and saves the shares.
function setBlocks({ list, col }) {
  const w = layoutNow();
  if (!w) return;
  const fixed = R.blockWidths(w.total, { list: (list ?? w.list) / w.total, col: (col ?? w.col) / w.total }, { column: w.column });
  layoutRatios = { list: fixed.list / w.total, col: w.column ? fixed.col / w.total : layoutRatios.col ?? null };
  try { localStorage.setItem(LAYOUT_KEY, JSON.stringify(layoutRatios)); } catch { /* not persisted */ }
  applyLayout();
}
function resetLayout() {
  layoutRatios = {};
  try { localStorage.removeItem(LAYOUT_KEY); } catch { /* nothing stored */ }
  applyLayout();
}

let padShown = null; // the notepad painted in #chatBody: `id:loaded:gen`
function drawChat() {
  const on = !!S.chat.id && !!R;
  $('#chat').hidden = !on;
  $('#split').hidden = !on;
  $('#split2').hidden = !on;
  $('#col').hidden = !on;
  if (document.body && document.body.classList) $('#sumLayout').classList.toggle('chat-open', on);
  if (!on) return;
  applyLayout();
  const column = columnOn();
  // RP91: with the column in, its tasks card is read when the repo OPENS (once per opening); the filter box keeps the focus across redraws.
  if (column) loadTasks();
  const colFocus = column && document.activeElement && document.activeElement.id === 'tasksFilter';
  // RP92: the files card is drawn from the facts the board keeps fresh (S.local), so it reads nothing.
  const facts = S.local[S.chat.id];
  paint($('#colBody'), R.columnView({ name: nameOf(S.chat.id), files: facts && !facts.error && Array.isArray(facts.files) ? facts.files : null, failed: !!(facts && facts.error), selected: S.chat.dfile || '', tasksHtml: column ? R.tasksView(S.tasks[S.chat.id] || null, { filter: S.tasksFilter, openDone: S.tasksOpenDone, loading: !!S.chat.tasksLoading, failed: !!S.chat.tasksFailed }) : '' }));
  const colBox = colFocus ? $('#tasksFilter') : null;
  if (colBox && colBox.focus && document.activeElement !== colBox) { colBox.focus(); if (colBox.setSelectionRange) colBox.setSelectionRange(colBox.value.length, colBox.value.length); }
  paint($('#chatHead'), R.chatHead(S.chat, { name: nameOf(S.chat.id), column }));
  const tasksTab = S.chat.tab === 'tasks' && !column;
  const changesTab = S.chat.tab === 'changes' && !column; // RP92: with the column in, the files card replaces the tab
  const filesTab = S.chat.tab === 'files';
  const notesTab = S.chat.tab === 'notes';
  const diffTab = S.chat.tab === 'diff' && !!S.chat.dfile; // RP90
  $('#composer').hidden = tasksTab || changesTab || filesTab || diffTab || notesTab;
  if (!notesTab) padShown = null;
  if (notesTab) {
    // The textarea is painted once per opening (and when its text is replaced from outside); after that only the status line changes, so the caret and the focus stay.
    const p = padOf(S.chat.id);
    const key = `${S.chat.id}:${p.loaded}:${p.gen}`;
    if (padShown !== key) { paint($('#chatBody'), R.notesView(p)); padShown = key; }
    paint($('#notesStatus'), R.notesStatus(p));
    chatShown = null;
    return;
  }
  if (diffTab) {
    paint($('#chatBody'), R.changesView(S.changes[S.chat.id] || null, { selected: S.chat.dfile, only: true, loading: !!S.chat.changesLoading, failed: !!S.chat.changesFailed }));
    chatShown = null;
    return;
  }
  if (filesTab) {
    const id = S.chat.id;
    const changed = {};
    for (const f of (modelOf(id).l.files || [])) changed[f.path] = f.untracked ? '?' : f.status;
    paint($('#chatBody'), R.filesView(S.files[id] || null, { selected: S.chat.fpath || '', open: S.filesOpen[id] || {}, changed, loading: !!S.chat.filesLoading, failed: !!S.chat.filesFailed, fileLoading: !!S.chat.fileLoading, fileFailed: S.chat.fileFailed || '' }, S.fileData[id] || null));
    chatShown = null;
    return;
  }
  if (changesTab) {
    paint($('#chatBody'), R.changesView(S.changes[S.chat.id] || null, { selected: '', loading: !!S.chat.changesLoading, failed: !!S.chat.changesFailed }));
    chatShown = null;
    return;
  }
  if (tasksTab) {
    const hadFocus = document.activeElement && document.activeElement.id === 'tasksFilter';
    paint($('#chatBody'), R.tasksView(S.tasks[S.chat.id] || null, { filter: S.tasksFilter, openDone: S.tasksOpenDone, loading: !!S.chat.tasksLoading, failed: !!S.chat.tasksFailed }));
    chatShown = null;
    const box = hadFocus ? $('#tasksFilter') : null;
    if (box && box.focus && document.activeElement !== box) { box.focus(); if (box.setSelectionRange) box.setSelectionRange(box.value.length, box.value.length); }
    return;
  }
  prunePending(S.chat.id);
  const shown = chatView();
  paint($('#sessState'), R.sessionLabelHtml(shown));
  const body = $('#chatBody');
  const atBottom = chatShown !== S.chat.id || !(body.scrollHeight > 0) || body.scrollHeight - body.scrollTop - body.clientHeight < 24;
  if (paint(body, R.chatBody(shown, { now: Date.now() })) && atBottom) body.scrollTop = body.scrollHeight;
  chatShown = S.chat.id;
  const id = S.chat.id;
  const cs = composerOf(id);
  $('#msgSend').disabled = !cs.canSend;
  $('#msgSend').title = cs.reason;
  $('#msgBox').placeholder = cs.placeholder;
  $('#msgStop').hidden = !(S.rpc[id] && S.rpc[id].state === 'busy');
  const row = S.summary && Array.isArray(S.summary.rows) ? S.summary.rows.find((r) => r.id === id) : null;
  const live = REASON_OF[S.rpc[id] && S.rpc[id].state] || 'unknown'; // RPC2b-1: the reason follows the session of the RPC host
  paint($('#chatActions'), R.actionButtonsHtml(R.actionMenu(row, { live, changes: summaryChanges(id), flow: summaryFlow(id) }), id, { sending: !!S.sending[id] }));
  paint($('#msgNote'), R.composerNote(S.notes[id] || (S.rpc[id] && S.rpc[id].error ? { text: S.rpc[id].error } : null)));
}

// One separator: drag it with the pointer, move it with the arrows (24 px) and reset all three blocks with Enter or a double click. `onDrag(clientX, rect, half)` and
// `onStep(w, dir)` (dir is +1 for the right arrow, -1 for the left one) say what the separator moves.
function wireSeparator(el, { onDrag, onStep }) {
  if (!el) return;
  let dragging = false;
  el.addEventListener('pointerdown', (e) => { dragging = true; if (el.setPointerCapture) el.setPointerCapture(e.pointerId); });
  el.addEventListener('pointermove', (e) => { if (dragging) onDrag(e.clientX, $('#sumLayout').getBoundingClientRect(), (el.offsetWidth || 0) / 2); });
  const endDrag = (e) => { if (!dragging) return; dragging = false; if (el.releasePointerCapture) el.releasePointerCapture(e.pointerId); };
  el.addEventListener('pointerup', endDrag);
  el.addEventListener('pointercancel', endDrag);
  el.addEventListener('keydown', (e) => {
    const w = layoutNow();
    if (e.key === 'Enter') resetLayout();
    else if (w && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) { e.preventDefault(); onStep(w, e.key === 'ArrowRight' ? 1 : -1); }
  });
  el.addEventListener('dblclick', resetLayout);
}
// The list separator moves the list (its right edge follows the pointer); the column separator moves the column (its left edge follows the pointer, so left grows it).
wireSeparator($('#split'), { onDrag: (x, rect, half) => setBlocks({ list: x - rect.left - half }), onStep: (w, dir) => setBlocks({ list: w.list + dir * 24 }) });
wireSeparator($('#split2'), { onDrag: (x, rect, half) => setBlocks({ col: rect.right - x - half }), onStep: (w, dir) => setBlocks({ col: w.col - dir * 24 }) });
if (window.addEventListener) window.addEventListener('resize', applyLayout);
// ---------- end chat ----------

// ---------- composer (RP68): free text to the adopted session ----------
// The composer nodes are static: the textarea value is written only when switching repo, after a sent message or by Clear, never by the poll.
function saveDraft() {
  const id = S.chat.id;
  if (!id) return;
  const v = $('#msgBox').value;
  if (v) S.drafts[id] = v; else delete S.drafts[id];
}
// A delivered message the history already shows is dropped (the entries still sending stay until their answer).
function prunePending(id) {
  const items = (S.chat.hist && S.chat.hist.items) || [];
  const keep = (S.pending[id] || []).filter((p) => p.state === 'sending' || R.userCount(items, p.text) <= p.base);
  if (keep.length) S.pending[id] = keep; else delete S.pending[id];
}
const sendingNow = (id) => (S.pending[id] || []).some((p) => p.state === 'sending');
const composerOf = (id) => R.composerState({ ...S.chat, rpc: S.rpc[id], sending: sendingNow(id) }, { name: nameOf(id) });
const sayNote = (id, text) => { S.notes[id] = { text, id }; };
const setRpc = (id, patch) => { S.rpc[id] = { ...(S.rpc[id] || V.rpcFromStatus(undefined, null)), ...patch }; };

// A session that is not started is started first (it can take up to two minutes: the label says Starting…); the start also adopts the session id the
// history is read from. A failure leaves the session closed and throws the server's message. The chat Send and the flow buttons share it.
// The callers check rpcNeedsStart first, so a session that is up adds no await (the send goes out in the same tick).
const rpcNeedsStart = (id) => !S.rpc[id] || S.rpc[id].state === 'closed';
async function ensureRpcStarted(id) {
  if (!rpcNeedsStart(id)) return;
  setRpc(id, { state: 'starting', error: '' });
  draw();
  try { S.rpc[id] = V.rpcFromStatus(S.rpc[id], await api('/api/rpc/start', { id }, { timeoutMs: 125000 })); } catch (e) {
    setRpc(id, { state: 'closed' });
    throw e.message === 'Request timed out' ? new Error('The session did not start in two minutes') : e;
  }
  if (S.chat.id === id) loadChat(id);
}

// Send: the session is started first if needed (ensureRpcStarted), then the prompt goes. A failure puts the text back and shows the server's message; the optimistic
// user bubble goes with it.
async function sendChatMessage() {
  const id = S.chat.id;
  if (!R || !id) return;
  const text = $('#msgBox').value;
  if (!text.trim()) return;
  const cs = composerOf(id);
  if (!cs.canSend) { sayNote(id, cs.reason); draw(); return; }
  const entry = { text, state: 'sending', base: R.userCount((S.chat.hist && S.chat.hist.items) || [], text) };
  delete S.notes[id];
  delete S.recall[id];
  $('#msgBox').value = '';
  delete S.drafts[id];
  (S.pending[id] || (S.pending[id] = [])).push(entry);
  setRpc(id, { error: '' });
  draw();
  try {
    if (rpcNeedsStart(id)) await ensureRpcStarted(id);
    await api('/api/rpc/prompt', { id, text });
    entry.state = 'ok';
  } catch (e) {
    S.pending[id] = (S.pending[id] || []).filter((p) => p !== entry);
    const now = S.chat.id === id ? $('#msgBox').value : S.drafts[id] || '';
    const back = now ? `${text}
${now}` : text;
    if (S.chat.id === id) $('#msgBox').value = back; else S.drafts[id] = back;
    sayNote(id, e.message);
  }
  draw();
}

// ---------- board ----------
let raf = 0;
function draw() { if (!raf) raf = requestAnimationFrame(() => { raf = 0; render(); }); }

// RP47: while a press is held (pointerdown until pointerup), a redraw waits for the release and then runs once, so what is
// under the pointer is never replaced between the press and the release. A lost release (the pointer let go outside the
// window, a drag) cannot freeze the page: after PRESS_MAX_MS the redraw runs anyway.
const PRESS_MAX_MS = 1500;
let pressedAt = 0;
let renderWaiting = false;
const pressHeld = () => !!pressedAt && Date.now() - pressedAt < PRESS_MAX_MS;
function releasePress() {
  pressedAt = 0;
  if (renderWaiting) { renderWaiting = false; draw(); }
}
document.addEventListener('pointerdown', () => { pressedAt = Date.now(); }, true);
document.addEventListener('pointerup', releasePress, true);
document.addEventListener('pointercancel', releasePress, true);

const COLUMNS = [
  { key: 'attention', title: 'Needs attention', hint: 'A manual action or a failed /flow-commit: a person has to step in' },
  { key: 'clean', title: 'Clean', hint: 'Nothing to do' },
  { key: 'changes', title: 'Changes', hint: 'Uncommitted files' },
  { key: 'committed', title: 'Committed', hint: 'Commits not pushed yet' },
  { key: 'prs', title: 'Pull requests', hint: 'Open PRs: ready to merge first, then fixes, then checks still running' },
  { key: 'merged', title: 'Merged', hint: 'Merged: run /flow-base' },
];
const COLUMN_BY_KEY = Object.fromEntries(COLUMNS.map((c) => [c.key, c]));
const BOARD_KEYS = ['changes', 'committed', 'prs', 'merged'];

// Clean is a board column unless the person turned it off (saved as exactly false): the saved preferences object is
// kept whole, so one saved before the option existed has no key and gets the column.
const cleanAsColumn = () => S.prefs.cleanAsColumn !== false;

// Which columns the board shows, left to right: Clean first by default, otherwise Needs attention only while it has cards.
const boardKeys = (attentionCount) => (V ? V.boardColumns(cleanAsColumn(), attentionCount)
  : [...(cleanAsColumn() ? ['clean'] : attentionCount > 0 ? ['attention'] : []), ...BOARD_KEYS]);

// A PR that cannot merge because of something the user must fix.
const isProblem = (pr) => (V ? V.isProblem(pr) : !pr.ready && (pr.checks.state === 'failed' || ['DIRTY', 'BEHIND'].includes(pr.mergeStateStatus)));

// The PR cards of the one Pull requests column: ready to merge first, then problems, then the rest.
const sortPrCards = (items) => (V ? V.sortPrCards(items, (x) => x.pr) : items);

// Where the repo's local card goes (view.js decides it from Git state alone); without view.js, by changes, commits
// and the stale mark only.
function placement(l, p, prCount, verdict) {
  if (V) return V.boardPlacement(l, p, prCount, verdict && verdict.state, cleanAsColumn());
  const stale = !!p.stale;
  if (l.error) return { column: 'changes', attn: true, row: false };
  if ((l.files || []).length > 0) return { column: 'changes', attn: stale, row: false };
  if ((l.ahead || 0) > 0) return { column: 'committed', attn: stale, row: false };
  if (stale) return { column: 'merged', attn: true, row: false };
  if (prCount) return { column: null, attn: false, row: false };
  return { column: cleanAsColumn() ? 'clean' : 'idle', attn: false, row: true };
}

// The verdict of the last command sent from this page, or null. It lives in the page only: an ok verdict (or none,
// for fix-pr and put-in-conditions once the session is idle) clears the record and the card simply lives where Git
// puts it. Judged from Git and the session state, never from terminal text; the panel does not judge the quality of
// the commits.
function verdictOf(r) {
  // The order is still on its way to the session: the repo already behaves as if the command were running.
  if (S.sending[r.id] && V) return V.sendingVerdict(S.sending[r.id]);
  const sent = S.sent[r.id];
  if (!sent || !V) return null;
  const v = V.flowVerdict(sent, S.local[r.id], S.pistatus[r.id], S.prs[r.id]);
  if (!v || v.state === 'ok') { clearSent(r.id); return null; }
  return v;
}

// One card per pending thing: a repo can have a local card plus one card per open PR.
function buildCards() {
  const cols = Object.fromEntries(COLUMNS.map((c) => [c.key, []]));
  const parked = Object.fromEntries(COLUMNS.map((c) => [c.key, []]));
  const idle = []; // the compact rows of repos with nothing to do, for the Idle bar
  const prCards = []; // { pr, html } of every open PR, ranked into the Pull requests column after the loop
  let problems = 0;
  // Problem cards go first in their column; with the problems filter on, only they are shown.
  const add = (key, html, attn) => {
    if (key === 'idle') { if (!S.onlyProblems) idle.push(html); return; }
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
      if (S.snoozed.has(snoozeKey(r.id, pr.number))) { if (!S.onlyProblems) parked.prs.push(snoozedRow(r, pr)); continue; }
      const attn = isProblem(pr);
      if (attn) problems++;
      if (attn || !S.onlyProblems) prCards.push({ pr, html: prCard(r, pr, p.repo, verdict && verdict.state === 'running' ? verdict : null) });
    }
  }
  cols.prs = sortPrCards(prCards).map((x) => x.html);
  return { cols, parked, idle, problems };
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
  if (pressHeld()) { renderWaiting = true; return; } // RP47: wait for the release, then draw once
  syncRefreshIcon();
  drawQueue();
  drawConformity();
  drawSummary();
  drawChat();
  if (!allRepos().length) {
    paint($('#app'), '<div class="empty">No repositories yet.<br><br><button class="primary" data-act="add-dialog">+ Add your first repo</button></div>');
    return;
  }
  const { cols, parked, idle, problems } = buildCards();
  const alerts = $('#alerts');
  alerts.hidden = !problems && !S.onlyProblems;
  alerts.textContent = `⚠ ${problems}`;
  alerts.classList.toggle('active', S.onlyProblems);
  paint($('#app'), `<div class="board">${boardKeys(cols.attention.length).map((k) => COLUMN_BY_KEY[k]).map((c) => `
    <section class="col col-${c.key}">
      <div class="col-head" title="${esc(c.hint)}"><h2>${c.title}</h2><span class="n">${cols[c.key].length}</span></div>
      <div class="col-body">${cols[c.key].join('') || (parked[c.key].length ? '' : '<div class="col-empty">—</div>')}${snoozedBlock(c.key, parked[c.key])}</div>
    </section>`).join('')}</div>${idleBar(idle)}`);
}

// The Idle bar under the board: the compact rows of repos with nothing to do, closed by default (a preference, so it
// stays as the person left it). The rows are the same cleanRow markup the Clean column holds, in a container that
// can host actions later. Nothing is drawn without rows, and not at all while Clean is a column.
function idleBar(rows) {
  if (cleanAsColumn() || !rows.length) return '';
  const open = !!S.prefs.idleOpen;
  return `<section class="idle" aria-label="Idle repos">
    <div class="idle-head">
      <button type="button" class="idle-toggle" data-act="toggle-idle" aria-expanded="${open}" aria-controls="idleList"><span class="idle-caret" aria-hidden="true">${open ? '▾' : '▸'}</span> Idle · ${rows.length} repo${rows.length === 1 ? '' : 's'}</button>
      <button type="button" class="idle-column" data-act="clean-as-column" title="Put the Clean column back on the board">Show as column</button>
    </div>
    ${open ? `<div class="idle-list" id="idleList">${rows.join('')}</div>` : ''}
  </section>`;
}

function setPref(key, value) {
  S.prefs[key] = value;
  localStorage.setItem('prefs', JSON.stringify(S.prefs));
  draw();
}

// Well-separated hues, assigned to groups by their position in config.json (wraps after 6 groups).
const GROUP_HUES = [265, 140, 30, 185, 330, 55];

function groupTag(name) {
  const h = GROUP_HUES[Math.max(0, S.groups.findIndex((g) => g.name === name)) % GROUP_HUES.length];
  return `<span class="tag" style="background:hsl(${h} 40% 20%);color:hsl(${h} 70% 78%)">${esc(name)}</span>`;
}

// The only refresh signal: the icon of the top Refresh button spins while any repo is refreshing. Cards show nothing.
function syncRefreshIcon() {
  const on = (V ? V.isRefreshing(S.loading) : Object.values(S.loading).some((n) => n > 0)) || S.boardRefreshing.length > 0;
  $('[data-act="refresh-all"]').classList.toggle('loading', on);
}

// The repo name is the link to the repository on GitHub (plain text when there is no GitHub remote).
const repoName = (r, url) => (url
  ? `<a class="repo-name" href="${esc(url)}" target="_blank" rel="noopener" title="Open ${esc(r.name)} on GitHub">${esc(r.name)}</a>`
  : `<span class="repo-name">${esc(r.name)}</span>`);

// RP94: removing a repo is the last item of its ⋯ menu (it asks before it removes; nothing is deleted from disk or GitHub), not a loose ✕ button.
const removeItem = (r) => `<button role="menuitem" data-act="remove" data-id="${r.id}" title="Remove from panel (deletes nothing)">Remove from panel…</button>`;

// Sends the command to the repo's pi session over RPC; the server refuses when that is not safe.
const piBtn = (r, cmd, label = `/${cmd}`, { title = `Send /${cmd} to the open session of this repo`, pr, disabled = false } = {}) => `<button data-act="pi" data-id="${r.id}" data-cmd="${cmd}"${pr ? ` data-pr="${pr}"` : ''} title="${esc(title)}"${disabled ? ' disabled' : ''}>${esc(label)}</button>`;

// "⋯" menu of a card. Its open state lives in S (the page redraws on every refresh); `slot` tells apart
// the several cards of one repo. Empty while the requirements are not loaded or nothing is left to do.
function moreMenu(r, slot, extra = []) {
  const items = [...(V ? V.cardMenu(S.req[r.id], S.dismissed.has(r.id)) : []), ...extra];
  const rooms = V ? V.roomMenu(S.rooms, r.id) : null;
  const key = `${r.id}|${slot}`;
  const open = S.menu === key;
  const list = items.map((i) => `<button role="menuitem" data-act="${i.act}" data-id="${r.id}">${esc(i.label)}</button>`).join('')
    + (rooms ? `${rooms.title ? `<div class="more-head">${esc(rooms.title)}</div>` : ''}${rooms.items.map((i) => (i.act === 'assign-room'
      ? `<button role="menuitemradio" aria-checked="${i.current}" data-act="assign-room" data-id="${r.id}" data-room="${esc(i.room ?? '')}">${i.current ? '✓ ' : ''}${esc(i.label)}</button>`
      : `<button role="menuitem" data-act="${i.act}">${esc(i.label)}</button>`)).join('')}` : '')
    + removeItem(r);
  return `<span class="more"><button data-act="toggle-menu" data-menu="${esc(key)}" title="More options" aria-haspopup="true" aria-expanded="${open}">⋯</button>${open ? `<div class="more-menu" role="menu">${list}</div>` : ''}</span>`;
}

// Compact warning for a repo that lacks a required requirement; the Conformity tab lists the rest.
function reqWarn(r) {
  const w = V ? V.cardWarning(S.req[r.id], S.dismissed.has(r.id)) : null;
  if (!w) return '';
  // RP94b: one small warning with the number; the way to hide it is the card menu ("Hide warning"), not a button on the card.
  const said = `${w.count} requirement${w.count === 1 ? '' : 's'} missing`;
  return `<div class="req-warn" title="${esc(`${said}: ${w.ids.join(', ')}`)}"><span role="img" aria-label="${said}">⚠ ${w.count}</span></div>`;
}

// The line the agent declared for "what to do now", with a dot per state; a stale state is only a small marker.
// RP94b2: it is left out only where it would repeat the roadmap block (a `working` or outdated state on a card that has the block); see V.stateLineHidden.
const hasRoadmapBlock = (r) => !!(S.roadmap[r.id] && S.roadmap[r.id].available && S.roadmap[r.id].summary);
function stateRow(r) {
  const l = V ? V.stateLine(S.state[r.id]) : null;
  if (!l || V.stateLineHidden(S.state[r.id], l, hasRoadmapBlock(r))) return '';
  if (l.kind === 'outdated') return `<div class="state-line" title="${esc(l.title)}"><span class="dot dot-${l.dot}"></span></div>`;
  return `<div class="state-line" title="${esc(l.title)}"><span class="dot dot-${l.dot}"></span><span class="state-text">${esc(l.text)}</span></div>`;
}

// Room tag with a status dot; only for repos assigned to a room.
function roomTag(r) {
  const t = V ? V.roomTag(S.rooms, r.id, S.roomData) : null;
  if (!t) return '';
  // RP94b2: with ONE room the name tells nothing (every repo of the room carries the same one), so the tag is only its dot; the name and the state stay in the tooltip and the aria-label.
  if (S.rooms.length === 1) return `<span class="tag room-tag room-dot" role="img" title="${esc(t.title)}" aria-label="${esc(t.title)}"><span class="dot dot-${t.dot}"></span></span>`;
  return `<span class="tag room-tag" title="${esc(t.title)}"><span class="dot dot-${t.dot}"></span>${esc(t.name)}</span>`;
}

// RP87: who a card is about (group tag, room tag and the repo name), shared by the board card and the clean row; and its branch text.
// RP94b: the group tag only when several groups are visible (more than one group and the filter on "All groups"); otherwise it repeats what the person already knows.
const showGroupTag = () => S.groups.length > 1 && !S.group;
const identityHtml = (r, url) => `${showGroupTag() ? groupTag(r.group) : ''}${roomTag(r)}${repoName(r, url)}`;
const branchLabel = (l) => l.branch || (l.detached ? '(detached)' : '');

// Repo name + group on the left, more options and remove (with confirmation) pinned to the right.
function cardTop(r, url, slot, extra = []) {
  return `<div class="card-top">${identityHtml(r, url)}${moreMenu(r, slot, extra)}</div>`;
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
    <div class="rm-line"><span class="rm-dot ${esc(s.kind)}"></span><span class="rm-text" title="${esc(text)}">${esc(text)}</span>${badge}</div>
    <div class="rm-bar"><span style="width:${s.pct}%"></span></div>
    ${open ? `<div class="rm-header">${lines.map(([k, v]) => `<div><b>${k}</b> ${esc(v)}</div>`).join('')}</div>` : ''}
  </div>`;
}

// Clean repos have nothing to do, so they collapse to a single line.
function cleanRow(r) {
  const { l, p } = info(r);
  const behind = l.behind ? `<span class="behind" title="${l.behind} commit${l.behind === 1 ? '' : 's'} behind the remote — time to pull">↓${l.behind}</span>` : '';
  const warn = p.error ? `<span class="warn" title="${esc('GitHub: ' + p.error)}">⚠</span>` : '';
  // RP88c: the frame (row element, identity, branch, order of the parts) is V.RepoCard in compact mode; what is specific to the row is built here.
  return V.RepoCard({
    identity: identityHtml(r, p.repo?.url),
    branch: { text: branchLabel(l), title: l.branch || '' },
    tail: `${behind}${warn}`,
    actions: `<span class="row-actions">${moreMenu(r, 'row')}</span>`,
    after: [reqWarn(r), roadmapBlock(r)],
  }, 'compact');
}

// The inline style that keeps a CSS animation continuous although #app is re-rendered on every draw (see view.js).
const animStyle = () => `style="animation-delay:${V ? V.animDelay() : 0}ms"`;

// "committing…", "creating pull request…"… while the last command sent runs; a red bar with the reason, what the session
// last said (informational, escaped) and a way to dismiss it when it went wrong.
function verdictRow(r, verdict) {
  if (!verdict) return '';
  if (verdict.asking) return `<div class="ask-line" role="status" aria-live="polite" title="${esc(verdict.reason)}">${esc(verdict.label)}</div>`;
  if (verdict.state === 'running') {
    const label = verdict.label || 'committing…';
    const dots = label.endsWith('…') ? `${esc(label.slice(0, -1))}<span class="ell" ${animStyle()}>…</span>` : esc(label);
    return `<div class="verdict-line" role="status" aria-live="polite" title="${esc(verdict.reason)}" data-run="${V ? V.runColor(verdict.cmd) : 'gray'}"><span class="pulse-dot" aria-hidden="true" ${animStyle()}></span>${dots}</div>`;
  }
  if (verdict.state !== 'attention') return '';
  return `<div class="attn-bar"><span>⚠ Needs attention: ${esc(verdict.reason)}</span><button data-act="dismiss-sent" data-id="${r.id}" title="Dismiss">✕</button></div>`;
}

// Staged files block /flow-commit (it needs an empty index): say so next to the /flow-commit --unstage button.
function stagedBar(l) {
  const n = l.stagedCount;
  return `<div class="staged-bar" title="${esc((l.stagedPaths || []).join('\n'))}">⚠ ${n} file${n === 1 ? ' is' : 's are'} staged: /flow-commit needs an empty index. The button clears the index (git reset, your changes stay in the working tree) and then continues with the normal commit in the same run.</div>`;
}

const COMMIT_CMDS = ['flow-commit', 'flow-commit-unstage'];

// The flow buttons of a repo come from view.js; without it only /flow-commit is offered, as before. Only a /flow-commit
// verdict hides the delivery buttons; any running command disables the buttons it leaves. The board card and the Summary
// row both read them here.
function flowFor(r, l, p, verdict) {
  const override = S.showCommit.has(r.id);
  const commitVerdict = verdict && COMMIT_CMDS.includes(verdict.cmd) ? verdict.state : null;
  const running = verdict && verdict.state === 'running' ? { cmd: verdict.cmd, label: verdict.label } : null;
  const retry = commitVerdict === 'attention';
  return V ? V.flowButtons(l, p, S.state[r.id], { override, verdict: commitVerdict, running, retry, session: sessionOf(r.id) }) : (l.files || []).length > 0 ? [{ cmd: 'flow-commit', label: '/flow-commit' }] : [];
}

function repoCard(r, attn = false, verdict = null) {
  const { l, p, dirty } = info(r);
  const manual = V ? V.manualAction(l, l.base) : null;
  const override = S.showCommit.has(r.id);
  const flow = flowFor(r, l, p, verdict);
  const overrideItem = !manual && dirty && V ? V.commitOverrideItem(S.state[r.id], { override, stale: !!p.stale, session: sessionOf(r.id) }) : null;
  const chips = [];
  const shared = V ? V.changeChips(modelOf(r.id).changes, r.id) : ''; // RP87: the same chips as the Summary card
  if (shared) chips.push(shared);
  if (p.stale) chips.push(`<span class="chip red" title="${esc(V ? V.staleChipTitle(p.stale, dirty) : p.stale.reason)}">${esc(p.stale.reason)}</span>`);
  else if (l.currentGone) chips.push('<span class="chip gray" title="The remote branch was deleted (merged PR?)">remote branch deleted</span>');
  // RP88b: the frame (top line, branch line, chips block, order of the lines) is V.RepoCard; what is specific to the board card is built here.
  return V.RepoCard({
    attn,
    top: cardTop(r, p.repo?.url, 'repo', overrideItem ? [overrideItem] : []),
    before: [
      manual ? `<div class="manual-bar">⚠ Needs manual action: ${esc(manual)}</div>` : '',
      verdictRow(r, verdict),
      flow.some((b) => b.cmd === 'flow-commit-unstage') ? stagedBar(l) : '',
      reqWarn(r),
    ],
    branch: { text: branchLabel(l), title: l.branch || '' },
    between: [stateRow(r), roadmapBlock(r)],
    chips: chips.join(''),
    after: [
      l.error ? `<div class="err">${esc(l.error)}</div>` : '',
      p.error ? `<div class="err">GitHub: ${esc(p.error)}</div>` : '',
      flow.map((b) => `<div class="actions">${piBtn(r, b.cmd, b.label, { ...(b.reason ? { title: b.reason } : {}), disabled: b.disabled })}</div>`).join(''),
    ],
  }, 'work');
}

function checksChip(c) {
  if (!c || c.state === 'none') return '<span class="chip gray">no checks</span>';
  const tip = esc(c.items.map((i) => `${i.state === 'success' ? '✔' : i.state === 'failed' ? '✘' : '…'} ${i.name}`).join('\n'));
  if (c.state === 'success') return `<span class="chip green" title="${tip}">✔ ${c.passed}/${c.total} checks</span>`;
  if (c.state === 'failed') return `<span class="chip red" title="${tip}">✘ ${c.failed} failed · ${c.passed}/${c.total}</span>`;
  return `<span class="chip yellow chip-verify" title="${tip}"><span class="pulse-dot" aria-hidden="true" ${animStyle()}></span>verifying checks · ${c.pending} running · ${c.passed}/${c.total}</span>`;
}

const FIX_PR_HINT = 'Ask the open session to find out why the checks failed and fix it (it will not commit or push)';

// `running` is the verdict of a command running in this repo's session: it disables every button that would talk to it.
function prCard(r, pr, meta, running = null) {
  const busy = S.busy[`${r.id}:${pr.number}`];
  const held = !busy && mergeHeld(r.id, pr.number);
  const hold = running && V ? V.runningReason({ cmd: running.cmd, label: running.label }) : '';
  const showReason = !pr.ready && pr.blockedReason && pr.checks.state !== 'pending' && pr.checks.state !== 'failed';
  const n = `data-id="${r.id}" data-n="${pr.number}"`;
  return `<div class="card ${isProblem(pr) ? 'attn' : ''} ${pr.ready ? 'ready' : ''}">
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
      <button class="merge" data-act="merge" ${n} ${pr.ready && !busy && !held && !hold ? '' : 'disabled'}
        title="${esc(hold || (pr.ready ? 'Merge into ' + pr.base : pr.blockedReason))}">${held || busy === 'done' ? 'Merged ✓' : busy ? 'Merging…' : `Merge · ${S.prefs.method}`}</button>
      <button data-act="snooze" ${n} title="Park this PR at the bottom of the column until it is ready to merge (stays parked if it is already ready)">💤</button>
    </div>
    ${(pr.checks && pr.checks.failedRuns || []).length ? `<button data-act="rerun" ${n} ${busy || held || hold ? 'disabled' : ''}${hold ? ` title="${esc(hold)}"` : ''}>Re-run failed</button>` : ''}
    ${V && V.fixPrAction(pr).show ? piBtn(r, 'fix-pr', 'Fix CI', { pr: pr.number, title: hold || FIX_PR_HINT, disabled: !!hold }) : ''}
  </div>`;
}

// ---------- actions ----------
async function doMerge(id, n) {
  const pr = (S.prs[id]?.prs || []).find((x) => x.number === n);
  if (!pr || S.busy[`${id}:${n}`]) return;
  const { method, del } = S.prefs;
  const key = `${id}:${n}`;
  S.busy[key] = true; draw();
  try {
    const r = await api('/api/merge', { id, number: n, method, deleteBranch: del });
    // Merged: S.merged keeps the button disabled until GitHub stops listing the PR (or MERGE_HOLD_MS), so it never comes back to life early.
    S.merged[key] = Date.now();
    toast(`#${n} merged${r.branch === 'deleted' ? ' · branch deleted' : r.branch === 'auto' ? ' · branch auto-deleted' : ''}`, 'ok');
  } catch (e) {
    toast(`#${n}: ${e.message}`, 'bad');
  }
  delete S.busy[key];
  draw();
  try { await refreshRepo(id, { catchUp: true }); } finally { draw(); }
}

async function doRerun(id, n) {
  S.busy[`${id}:${n}`] = true; draw();
  try { const r = await api('/api/rerun', { id, number: n }); toast(`Re-running ${r.rerun} workflow run(s)`, 'ok'); }
  catch (e) { toast(e.message, 'bad'); }
  delete S.busy[`${id}:${n}`];
  setTimeout(() => refreshRepo(id, { catchUp: true }), 2500);
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

// Re-reads the rooms after the server changed them; the board and the Conformity tab follow.
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

// The commands whose result is judged from Git: the page reads a fresh baseline of the repo before sending them.
const JUDGED_CMDS = ['flow-commit', 'flow-commit-unstage', 'flow-pr', 'flow-base', 'flow-base-stash'];

const ACTIONS = {
  'refresh-all': () => refreshAll({ force: true }),
  'fetch-all': async () => { toast('Fetching all repos…'); await Promise.all(allRepos().map((r) => fetchRepo(r.id))); toast('Fetch done', 'ok'); },
  // RP64: the chip opens the single viewer, the Changes tab of the right panel; from the Work tab the page goes to the Summary first.
  'diff': (el) => { const id = el.dataset.id; if (S.tab !== 'summary') setTab('summary'); if (S.chat.id !== id) openChat(id); setChatTab('changes'); },
  // RP90: touching a file of the Changes list opens it in the ONE diff tab of the centre (reused for every file); RP92 will open it from the files card.
  'changes-file': (el) => { const p = el.dataset.path || ''; if (p) { S.chat.dfile = p; setChatTab('diff'); } else draw(); },
  'diff-close': () => { S.chat.dfile = ''; if (S.chat.tab === 'diff') S.chat.tab = 'chat'; draw(); },
  'files-open': (el) => loadFile(el.dataset.path || ''),
  // The button says what the person SEES (data-open): the default is open only when a changed file is inside, so toggling flips that.
  'files-dir': (el) => { (S.filesOpen[S.chat.id] ||= {})[el.dataset.path || ''] = el.dataset.open !== 'true'; draw(); },
  'tab': (el) => { if (['summary', 'work', 'conformity'].includes(el.dataset.tab)) setTab(el.dataset.tab); },
  'sfilter': (el) => { S.sfilter = el.dataset.filter === 'attention' ? 'attention' : 'all'; draw(); },
  'toggle-group': (el) => { S.collapsed[el.dataset.group] = !S.collapsed[el.dataset.group]; draw(); },
  'scope': (el) => { S.scope = el.dataset.kind === 'room' ? { kind: 'room', name: el.dataset.name } : { kind: el.dataset.kind === 'none' ? 'none' : 'all' }; draw(); },
  // "Open", "Start" and "⋯" of the Summary: show only this repo on the board.
  'focus-repo': (el) => { S.q = nameOf(el.dataset.id); $('#search').value = S.q; setTab('work'); },
  'chat-open': (el) => openChat(el.dataset.id),
  // RP91: with the column in, setChatTab turns the Tasks tab into the Chat one (the tasks card is already there); without it the chat opens on its Tasks tab as before.
  'tasks-open': (el) => { openChat(el.dataset.id, 'tasks'); if (S.chat.id === el.dataset.id) setChatTab('tasks'); },
  'chat-tab': (el) => setChatTab(el.dataset.tab),
  'notes-retry': () => flushNotes(),
  'notes-disk': () => { const p = S.pad[S.chat.id]; if (p && p.status === 'conflict' && p.disk) { Object.assign(p, { text: p.disk.text, savedText: p.disk.text, base: p.disk.rev, status: 'saved', error: '', gen: p.gen + 1 }); p.req++; draw(); } },
  'notes-mine': () => { const p = S.pad[S.chat.id]; if (p && p.status === 'conflict' && p.disk) { p.base = p.disk.rev; p.status = 'saving'; saveNotes(S.chat.id); draw(); } },
  'tasks-done': () => { S.tasksOpenDone = !S.tasksOpenDone; draw(); },
  'tasks-filter': (el) => { S.tasksFilter = String((el && el.value) || ''); draw(); },
  'chat-close': () => closeChat(),
  'chat-send': () => sendChatMessage(),
  'chat-stop': async () => {
    const id = S.chat.id;
    if (!id) return;
    try { await api('/api/rpc/abort', { id }); } catch (e) { toast(e.message, 'bad'); }
  },
  // RPC2-3: answer a dialog pi is waiting for. The answer is built HERE from the dialog the page holds (S.rpc), never from the text of the button: the
  // click names the request and the kind, the option is the one at that index and the typed text is read from the card's own field. Posted ONCE: the
  // card locks at the click and only a refusal unlocks it; a 409 (the question is gone) resyncs the status, which takes the card away.
  'rpc-answer': async (el) => {
    const { id, request, kind } = el.dataset;
    const ask = id && S.rpc[id] && (S.rpc[id].asks || []).find((d) => d.requestId === request);
    if (!R || !ask || S.askBusy[request]) return;
    let answer = null;
    if (kind === 'cancel') answer = { cancelled: true };
    else if (kind === 'deny' && ask.method === 'confirm') answer = { confirmed: false };
    else if (kind === 'allow' && ask.method === 'confirm' && R.askAllowed(ask)) answer = { confirmed: true };
    else if (kind === 'option' && ask.method === 'select' && R.askAllowed(ask) && typeof ask.options[Number(el.dataset.index)] === 'string') answer = { value: ask.options[Number(el.dataset.index)] };
    else if (kind === 'send' && (ask.method === 'input' || ask.method === 'editor')) {
      const box = typeof el.closest === 'function' ? el.closest('.ch-ask') : null;
      const field = box && box.querySelector('.ask-field');
      if (field && typeof field.value === 'string') answer = { value: field.value };
    }
    if (!answer) return;
    S.askBusy[request] = true;
    draw();
    try {
      await api('/api/rpc/dialog', { id, requestId: request, ...answer });
      await rpcSync(id);
      delete S.askBusy[request];
    } catch (e) {
      delete S.askBusy[request];
      if (e.status === 409) await rpcSync(id); else toast(e.message, 'bad');
    }
    draw();
  },
  'chat-adopt': async (el) => {
    const { id, session } = el.dataset;
    try { await api('/api/sessions/adopt', { id, session }); } catch (e) { toast(e.message, 'bad'); }
    if (S.chat.id === id) loadChat(id);
  },
  'chat-start': async (el) => {
    const { id } = el.dataset;
    if (S.chat.starting) return;
    S.chat.starting = true;
    el.disabled = true;
    draw();
    try { S.rpc[id] = V.rpcFromStatus(S.rpc[id], await api('/api/rpc/start', { id }, { timeoutMs: 125000 })); } catch (e) { toast(e.message, 'bad'); }
    S.chat.starting = false;
    el.disabled = false;
    if (S.chat.id === id) loadChat(id);
    draw();
  },
  'pi': async (el) => {
    const { id, cmd, pr } = el.dataset;
    if (S.sending[id]) return; // a second click while the first order is on its way never sends another
    S.sending[id] = cmd;
    el.disabled = true;
    draw();
    try {
      if (rpcNeedsStart(id)) await ensureRpcStarted(id);
      // The baseline of the verdict is read fresh, right before sending, so a stale card cannot fake "HEAD changed".
      const judged = JUDGED_CMDS.includes(cmd);
      const before = judged ? await api(`/api/local?id=${id}`).catch(() => null) : null;
      const d = await api('/api/pi', pr ? { id, command: cmd, pr: Number(pr) } : { id, command: cmd });
      if (judged && before && !before.error && d.sent) {
        setFact('local', id, before);
        startSent(id, { cmd, at: Date.now(), head: before.head ?? null, branch: before.branch ?? null, files: before.files.length, ahead: before.ahead || 0 });
      } else if (!judged && d.sent) startSent(id, { cmd, at: Date.now() });
      const what = cmd === 'fix-pr' ? `the fix order for #${pr}` : cmd === 'flow-base-stash' ? '/flow-base --stash' : `/${cmd}`;
      toast(d.confirmed ? `Sent ${what} to the session` : `Sent ${what}, not confirmed: check the session`, d.confirmed ? 'ok' : '');
    } catch (e) { toast(e.message, 'bad'); } finally {
      delete S.sending[id];
      el.disabled = false;
      draw();
    }
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
  'dismiss-sent': (el) => { clearSent(el.dataset.id); draw(); },
  'toggle-menu': (el) => { S.menu = S.menu === el.dataset.menu ? null : el.dataset.menu; draw(); },
  'hide-warning': (el) => setDismissed(el.dataset.id, true),
  'toggle-warning': (el) => { S.menu = null; return setDismissed(el.dataset.id, !S.dismissed.has(el.dataset.id)); },
  // The server builds the order from the repo's requirements; `confirmed` only means the prompt left idle.
  'put-in-conditions': async (el) => {
    const id = el.dataset.id;
    S.menu = null;
    if (S.sending[id]) { draw(); return; } // a second click while an order of this repo is on its way never sends another
    S.sending[id] = 'put-in-conditions'; // the repo behaves as if the command were running from the click until the answer
    draw();
    try {
      if (rpcNeedsStart(id)) await ensureRpcStarted(id);
      const d = await api('/api/pi', { id, command: 'put-in-conditions' });
      if (d.sent) startSent(id, { cmd: 'put-in-conditions', at: Date.now() });
      toast(d.confirmed ? 'Sent the put-in-conditions order to the session' : 'Sent the put-in-conditions order, not confirmed: check the session', d.confirmed ? 'ok' : '');
    } catch (e) { toast(e.message, 'bad'); } finally {
      delete S.sending[id];
      draw();
    }
  },
  'merge': (el) => doMerge(el.dataset.id, Number(el.dataset.n)),
  'queue-pick': (el) => {
    if (el.dataset.close) setTab(S.backTab);
    S.q = el.dataset.name; $('#search').value = S.q; draw();
  },
  'toggle-problems': () => { S.onlyProblems = !S.onlyProblems; draw(); },
  'snooze': (el) => setSnooze(el.dataset.id, Number(el.dataset.n), true),
  'unsnooze': (el) => setSnooze(el.dataset.id, Number(el.dataset.n), false),
  'toggle-idle': () => setPref('idleOpen', !S.prefs.idleOpen),
  'clean-as-column': () => { $('#cleanAsColumn').checked = true; setPref('cleanAsColumn', true); },
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

// Escape closes the card menu first; with nothing else open it closes the chat. A focused repo card opens the chat with Enter or
// Space (the buttons inside it have no chat-open act, so they are untouched).
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && S.menu) { S.menu = null; draw(); return; }
  if (e.key === 'Escape') {
    const menu = $('#mergeMenu');
    if (S.chat.id && !(menu && menu.open) && document.activeElement !== $('#usage') && !['#addDialog', '#roomDialog'].some((d) => $(d) && $(d).open)) closeChat();
  } else if ((e.key === 'Enter' || e.key === ' ') && e.target && e.target.dataset && e.target.dataset.act === 'chat-open') { e.preventDefault(); ACTIONS['chat-open'](e.target); }
  else if ((e.key === 'Enter' || e.key === ' ') && e.target && e.target.dataset && e.target.dataset.act === 'tasks-open') { e.preventDefault(); e.stopPropagation(); ACTIONS['tasks-open'](e.target); }
});

// RP83 (S3): in the message box Up recalls what was sent to this session (again Up for the one before) and Down walks forward, giving back
// the draft past the newest. Only on the first (Up) or last (Down) line, never with a modifier or an IME composition; typing or sending ends it.
document.addEventListener('keydown', (e) => {
  const box = e.target;
  if (!R || !box || box.id !== 'msgBox' || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') || e.shiftKey || e.ctrlKey || e.altKey || e.metaKey || e.isComposing || e.keyCode === 229) return;
  const id = S.chat.id;
  const key = e.key === 'ArrowUp' ? 'up' : 'down';
  if (!id || !R.canRecall(key, box.value, box.selectionStart, box.selectionEnd)) return;
  const step = R.historyStep(S.recall[id] || null, key, box.value, R.inputHistory((S.chat.hist && S.chat.hist.items) || [], S.pending[id]));
  if (!step) return;
  e.preventDefault();
  if (step.nav) S.recall[id] = step.nav; else delete S.recall[id];
  box.value = step.text;
  if (box.setSelectionRange) box.setSelectionRange(step.text.length, step.text.length);
});

// Enter in the message box sends it; Shift+Enter is a new line and an IME composition is left alone.
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' || !e.target || e.target.id !== 'msgBox' || e.shiftKey || e.isComposing || e.keyCode === 229) return;
  e.preventDefault();
  sendChatMessage();
});
document.addEventListener('input', (e) => { if (e.target && e.target.id === 'msgBox') { delete S.recall[S.chat.id]; saveDraft(); } else if (e.target && e.target.id === 'tasksFilter') ACTIONS['tasks-filter'](e.target); else if (e.target && e.target.id === 'notesBox') notesInput(e.target.value); });

// The passing list of a repo stays open (or closed) across redraws. `toggle` does not bubble, so capture it.
document.addEventListener('toggle', (e) => {
  if (e.target.matches && e.target.matches('details.req-passing')) S.reqPassOpen[e.target.dataset.id] = e.target.open;
}, true);

document.addEventListener('change', (e) => {
  if (e.target.dataset.piRuntime !== undefined) {
    api('/api/pi-runtime', { runtime: e.target.value }).then(() => loadPrerequisites(), () => loadPrerequisites());
    return;
  }
  const key = e.target.dataset.pref;
  if (!key) return;
  setPref(key, e.target.type === 'checkbox' ? e.target.checked : e.target.value);
});

// The Merge menu is static HTML (never painted by draw()): it closes with Escape and with a click outside.
document.addEventListener('keydown', (e) => {
  const menu = $('#mergeMenu');
  if (e.key === 'Escape' && menu && menu.open) { menu.open = false; const s = menu.querySelector && menu.querySelector('summary'); if (s && s.focus) s.focus(); }
});
document.addEventListener('click', (e) => {
  const menu = $('#mergeMenu');
  if (menu && menu.open && !(menu.contains && menu.contains(e.target))) menu.open = false;
});

$('#search').addEventListener('input', (e) => { S.q = e.target.value; draw(); });
$('#groupFilter').addEventListener('change', (e) => { S.group = e.target.value; draw(); });

// Auto-refresh while the tab is visible: everything every minute, plus the lighter
// refreshes planned by refreshTick in between.
setInterval(() => {
  if (!document.hidden) refreshAll();
}, V ? V.FULL_REFRESH_MS : 60000);
setInterval(() => refreshTick(), 2000);
setInterval(summaryTick, 20000);
setInterval(chatTick, CHAT_MS);
setInterval(quietTick, 10000);
// RP62 (S61, S77): the Claude usage bar. A request that fails, or an answer without a boolean `available` (api() turns a broken body into
// { error }), changes nothing: the last painted value stays, with no toast; before the first good answer the bar stays hidden.
async function loadUsage() {
  let u;
  try { u = await api('/api/usage'); } catch { return; }
  if (!V || !u || typeof u.available !== 'boolean') return;
  const view = V.usageView(u, { now: Date.now() });
  const el = $('#usage');
  paint(el, V.usageHtml(view)); // RP96: meters and popover; a plain message when there is no data
  el.title = view.state === 'none' ? view.title : ''; // the popover replaces the tooltip
  el.hidden = false;
}
setInterval(() => { if (!document.hidden) loadUsage(); }, 30000);
// RP96: Escape on the focused usage element closes its popover (the focus leaves it).
document.addEventListener('keydown', (e) => { const el = $('#usage'); if (e.key === 'Escape' && el && document.activeElement === el && el.blur) el.blur(); });
loadUsage();
if (window.addEventListener) window.addEventListener('pagehide', () => flushNotes());
document.addEventListener('visibilitychange', () => {
  if (document.hidden) { flushNotes(); stopEvents(); return; }
  loadUsage();
  ev.attempt = 0;
  startEvents();
  quietTick();
  if (boardLeads()) loadBoard(); // one request from memory instead of a burst of reads
  else if (Date.now() - S.lastRefresh > 30000) refreshAll();
});

(async () => {
  try { await loadConfig(); } catch (e) { toast(e.message, 'bad'); }
  $('#method').value = S.prefs.method;
  $('#delBranch').checked = S.prefs.del;
  $('#cleanAsColumn').checked = cleanAsColumn();
  draw();
  if (location.hash === '#conformity') openConformity(); // deep link
  refreshAll();
  rpcSeed();
  startEvents();
  if (V) scheduleBoard();
})();
