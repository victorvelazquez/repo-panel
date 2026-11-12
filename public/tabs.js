'use strict';
// RPC3c: the derived state of the page, the "go work on" queue and the Conformity and Summary tabs. index.html loads this file after feed.js and BEFORE app.js; they
// share the global scope (like data.js, feed.js, view.js and resumen.js), so what is used from app.js (S, V, R, $, TOKEN, draw, the chat and board renderers...) is only
// touched when a function is called, never while this file loads: its top-level initializers are plain constants and counters (test/rpc3c-tabs.test.js loads it alone).

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
      id: r.id, name: r.name, dirty, unpushed, stale: !!p.stale, hasPrs: (V ? V.taskPrs(prs, S.roadmap[r.id] && S.roadmap[r.id].available === true ? S.roadmap[r.id].rows : null) : prs).length > 0, ...flags, // RP138
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
  $('#tab-conformity').setAttribute('aria-label', V ? V.conformityTabLabel(n) : 'Conformity');
  if (S.tab !== 'conformity') return;
  const sum = v.summary ? `<div class="conf-sum">${esc(v.summary)}</div>` : '';
  const body = v.state === 'issues' ? S.conf.items.map(confBlock).join('') : `<div class="${v.state === 'error' ? 'conf-error' : 'empty'}">${esc(v.message)}</div>`;
  const reqs = V ? `<div class="conf-heading">Requirements</div>${allRepos().map(reqBlock).join('')}${roomsBlock()}` : '';
  paint($('#conformityView'), sum + prereqBlock() + body + reqs);
}

function openConformity() { setTab('conformity'); }

// RP111b: the Settings tab (artboard A). The view is a pure function of this model (R.settingsView); the preferences of the browser are the ones that already exist.
function drawSettings() {
  if (S.tab !== 'settings') return;
  const prefs = { method: S.prefs.method, del: S.prefs.del, clean: cleanAsColumn(), split: !!S.prefs.split };
  paint($('#settingsView'), R.settingsView({ ...S.settings, prefs, pi: S.prereq.pi }));
}

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
  $('#settingsView').hidden = S.tab !== 'settings';
  if (document.body && document.body.classList) for (const t of ['summary', 'work', 'conformity', 'settings']) document.body.classList.toggle(`tab-${t}`, S.tab === t);
  for (const b of Array.from((document.querySelectorAll && document.querySelectorAll('header [role=tab][data-tab]')) || [])) b.setAttribute('aria-selected', String(b.dataset.tab === S.tab));
}
// Conformity is a tab like the others but never the saved one: a reload comes back to Summary or Work, and a repo picked in it returns there.
function setTab(tab) {
  // The way back is Summary or Work, whichever the person was last on (Settings and Conformity are never one: RP111b).
  if (tab === 'conformity' && S.tab !== 'conformity') S.backTab = S.tab === 'summary' || S.tab === 'work' ? S.tab : S.prefs.tab === 'work' ? 'work' : 'summary';
  S.tab = tab;
  applyTab();
  if (tab === 'conformity') draw();
  else if (tab === 'settings') { draw(); loadSettings(); if (!S.prereq.pi) loadPrerequisites(); } // like Conformity, never the saved tab
  else setPref('tab', tab);
  if (tab === 'summary') { loadSummary(); if (S.chat.id) loadChat(S.chat.id); }
}

// The "deliver" button of a Summary row is the first button the board's own card would show for that repo.
// RP159: why the delivery buttons of the card of a repo are held, or ''. The live state of the session wins; when the page does not have it yet (no stream) the row of the server is the witness (working, waiting).
function summaryHold(id) {
  const r = allRepos().find((x) => x.id === id);
  if (!r || !V) return '';
  const v = verdictOf(r);
  const live = sessionOf(id);
  const row = S.summary && Array.isArray(S.summary.rows) ? S.summary.rows.find((x) => x && x.id === id) : null;
  const state = row && row.session ? row.session.state : null;
  const session = live !== undefined ? live : state === 'working' ? 'busy' : state === 'waiting' ? 'asking' : undefined;
  return V.deliveryHold({ sending: S.sending[id], running: v && v.state === 'running' ? { cmd: v.cmd, label: v.label } : null, session });
}
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
  return { ...S.chat, pending: S.pending[id], askBusy: S.askBusy, results: S.chatResults, rpc: S.rpc[id] };
}

// RP121: the header of the repos column (the filters of the Summary): the count, the icons, the strip of active filters and the menu. The state is the shared one; the inputs are
// only set when they differ, so the caret stays while typing, and the bar of Work (#search, #groupFilter) shows the same values the next time it is in view.
function drawListHead(ctx, kept) {
  const count = R.listCount(S.summary, ctx);
  $('#lhCount').textContent = count === null ? '' : String(count);
  const same = (el, v) => { if (el.value !== v) el.value = v; };
  same($('#lhSearch'), S.q);
  same($('#search'), S.q);
  same($('#groupFilter'), S.group);
  const lh = S.lh;
  $('#lhSearchBox').hidden = !lh.search;
  $('#lhTitle').hidden = lh.search;
  $('#lhIcons').hidden = lh.search;
  $('#lhMenu').hidden = !lh.menu;
  $('#lhLegend').hidden = !lh.legend;
  $('#lhInfoBtn').setAttribute('aria-expanded', String(lh.legend));
  paint($('#lhLegendBody'), R.legendHtml()); // only the body is painted: the close button of the block stays
  $('#lhFilterBtn').setAttribute('aria-expanded', String(lh.menu));
  const chips = R.listHeadChips(ctx);
  paint($('#lhActive'), chips);
  $('#lhActive').hidden = !chips;
  $('#lhDot').hidden = !chips;
  if (paint($('#lhAttention'), R.summaryTools(S.summary, { ...ctx, compact: true })) && kept && (kept.act === 'sfilter' || kept.act === 'slive')) { const on = $(`#lhAttention [data-act="${kept.act}"]`); if (on && on.focus) on.focus(); }
  paint($('#lhGroup'), `<option value="">All groups</option>${S.groups.map((g) => `<option ${S.group === g.name ? 'selected' : ''}>${esc(g.name)}</option>`).join('')}`);
  const scopeHad = !!(document.activeElement && document.activeElement.dataset && document.activeElement.dataset.act === 'scope' && lh.menu);
  if (paint($('#lhScope'), R.scopeBar(S.rooms, allRepos().length, ctx.scope)) && scopeHad) { const on = $('#lhScope [aria-pressed="true"]'); if (on && on.focus) on.focus(); }
  if (lh.focus) { lh.focus = false; $('#lhSearch').focus(); }
  if (lh.focusBtn) { lh.focusBtn = false; $('#lhFilterBtn').focus(); }
  if (lh.focusInfo) { lh.focusInfo = false; $('#lhInfoBtn').focus(); }
}

function drawSummary() {
  applyTab();
  if (!R) return;
  const scope = R.normalizeScope(S.scope, S.rooms);
  const hadFocus = !!(document.activeElement && document.activeElement.dataset && document.activeElement.dataset.act === 'scope');
  if (paint($('#scope'), R.scopeBar(S.rooms, allRepos().length, scope)) && hadFocus) { const on = $('#scope [aria-pressed="true"]'); if (on && on.focus) on.focus(); }
  // The group buttons live inside #summary and the Needs attention toggle in the view bar: keep the focus on the pressed one.
  const ae = document.activeElement;
  const kept = ae && ae.dataset && (ae.dataset.act === 'sfilter' || ae.dataset.act === 'slive' || ae.dataset.act === 'toggle-group') ? { act: ae.dataset.act, filter: ae.dataset.filter, group: ae.dataset.group } : null;
  const box = $('#summary');
  const ctx = {
    now: Date.now(), scope, rooms: S.rooms, q: S.q, group: S.group, roomData: S.roomData.data, filter: S.sfilter, live: S.slive, collapsed: S.collapsed, failed: S.summaryFailed,
    flowFor: summaryFlow, holdFor: summaryHold, changesFor: summaryChanges, prsFor: summaryPrs, idleFor: summaryIdle, sending: S.sending, busy: busyView(), chatId: S.chat.id,
  };
  drawListHead(ctx, kept);
  const changed = paint(box, R.summaryView(summaryShown(), ctx));
  if (changed && kept && kept.act === 'toggle-group' && box.querySelectorAll) {
    const again = Array.from(box.querySelectorAll('[data-act]')).find((b) => b.dataset && b.dataset.act === kept.act && b.dataset.filter === kept.filter && b.dataset.group === kept.group);
    if (again && again.focus) again.focus();
  }
}
