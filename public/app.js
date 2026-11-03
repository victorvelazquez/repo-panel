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

// The list separator moves the list (its right edge follows the pointer); the column separator moves the column (its left edge follows the pointer, so left grows it).
wireSeparator($('#split'), { onDrag: (x, rect, half) => setBlocks({ list: x - rect.left - half }), onStep: (w, dir) => setBlocks({ list: w.list + dir * 24 }) });
wireSeparator($('#split2'), { onDrag: (x, rect, half) => setBlocks({ col: rect.right - x - half }), onStep: (w, dir) => setBlocks({ col: w.col - dir * 24 }) });
if (window.addEventListener) window.addEventListener('resize', applyLayout);

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
