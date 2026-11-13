'use strict';
// RPC3e: the board of the page: the cards, the columns, draw and render. index.html loads this file after chat.js and BEFORE app.js; they share the global scope (like data.js,
// feed.js, tabs.js, chat.js, view.js and resumen.js), so what is used from app.js (S, V, R, $, TOKEN...) is only touched when a function is called, never while this file loads.
// The three pointer listeners that wire pressedAt and releasePress run at load, so they stay in app.js, which loads last (test/rpc3e-board.test.js loads this file alone).

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

const COLUMNS = [
  { key: 'attention', title: 'Needs attention', hint: 'A manual action or a failed /flow-ship: a person has to step in' },
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
    // A stale branch, something that needs manual action and a failed /flow-ship all need a person.
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
  drawSettings();
  drawSummary();
  drawChat();
  drawMergeSheet(); // RP137
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
// RP111b: the controls of the bar are set once when the page starts; a preference changed from Settings puts them in step.
function syncPrefControls() {
  $('#cleanAsColumn').checked = cleanAsColumn();
}

// Well-separated hues, assigned to groups by their position in config.json (wraps after 6 groups).
const GROUP_HUES = [265, 140, 30, 185, 330, 55];

function groupTag(name) {
  const h = GROUP_HUES[Math.max(0, S.groups.findIndex((g) => g.name === name)) % GROUP_HUES.length];
  return `<span class="tag" style="background:hsl(${h} 40% 20%);color:hsl(${h} 70% 78%)">${esc(name)}</span>`;
}

// The only refresh signal: the small Updating indicator of the header shows and spins while any repo is refreshing. Cards show nothing.
function syncRefreshIcon() {
  const on = (V ? V.isRefreshing(S.loading) : Object.values(S.loading).some((n) => n > 0)) || S.boardRefreshing.length > 0;
  $('#syncState').classList.toggle('loading', on);
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

// Staged files block /flow-ship (it needs an empty index): say so next to the /flow-ship --unstage button.
function stagedBar(l) {
  const n = l.stagedCount;
  return `<div class="staged-bar" title="${esc((l.stagedPaths || []).join('\n'))}">⚠ ${n} file${n === 1 ? ' is' : 's are'} staged: /flow-ship needs an empty index. The button clears the index (git reset, your changes stay in the working tree) and then continues with the normal commit in the same run.</div>`;
}

const COMMIT_CMDS = ['flow-ship', 'flow-ship-unstage', 'flow-commit', 'flow-commit-unstage'];

// The flow buttons of a repo come from view.js; without it only /flow-ship is offered. Only a /flow-ship
// verdict hides the delivery buttons; any running command disables the buttons it leaves. The board card and the Summary
// row both read them here.
function flowFor(r, l, p, verdict) {
  const override = S.showCommit.has(r.id);
  const commitVerdict = verdict && COMMIT_CMDS.includes(verdict.cmd) ? verdict.state : null;
  // RP176: a /flow-ship that stopped after its commit leaves a clean tree with commits ahead: the /flow-pr button must still show, so the attention verdict does not hide the delivery buttons.
  const hides = commitVerdict === 'attention' && verdict.cmd.startsWith('flow-ship') ? null : commitVerdict;
  const running = verdict && verdict.state === 'running' ? { cmd: verdict.cmd, label: verdict.label } : null;
  const retry = commitVerdict === 'attention';
  return V ? V.flowButtons(l, p, S.state[r.id], { override, verdict: hides, running, retry, session: sessionOf(r.id), jobs: jobsOfRepo(r.id) }) : (l.files || []).length > 0 ? [{ cmd: 'flow-ship', label: '/flow-ship' }] : [];
}

function repoCard(r, attn = false, verdict = null) {
  const { l, p, dirty } = info(r);
  const manual = V ? V.manualAction(l, l.base) : null;
  const override = S.showCommit.has(r.id);
  const flow = flowFor(r, l, p, verdict);
  const overrideItem = !manual && dirty && V ? V.commitOverrideItem(S.state[r.id], { override, stale: !!p.stale, session: sessionOf(r.id), jobs: jobsOfRepo(r.id) }) : null;
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
      flow.some((b) => b.cmd === 'flow-ship-unstage') ? stagedBar(l) : '',
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
  const fixHold = hold || (V ? V.deliveryHold({ session: sessionOf(r.id), jobs: jobsOfRepo(r.id) }) : ''); // RP159: Fix CI talks to the session, so it waits for it; Merge and Re-run do not
  const showReason = !pr.ready && pr.blockedReason && pr.checks.state !== 'pending' && pr.checks.state !== 'failed';
  const n = `data-id="${r.id}" data-n="${pr.number}"`;
  // RP129: the Merge and Re-run buttons follow the ONE rule of view.js (the footer of the right column asks it too); without view.js neither is ever offered.
  const m = V ? V.mergeButton(pr, { method: S.prefs.method, busy, held, hold }) : { enabled: false, label: `Merge · ${S.prefs.method}`, title: 'view.js did not load' };
  const rr = V ? V.rerunButton(pr, { busy, held, hold }) : { show: false, enabled: false, title: '' };
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
      <button class="merge" data-act="merge" ${n} ${m.enabled ? '' : 'disabled'}
        title="${esc(m.title)}">${esc(m.label)}</button>
      <button data-act="snooze" ${n} title="Park this PR at the bottom of the column until it is ready to merge (stays parked if it is already ready)">💤</button>
    </div>
    ${rr.show ? `<button data-act="rerun" ${n} ${rr.enabled ? '' : 'disabled'}${rr.title ? ` title="${esc(rr.title)}"` : ''}>Re-run failed</button>` : ''}
    ${V && V.fixPrAction(pr).show ? piBtn(r, 'fix-pr', 'Fix CI', { pr: pr.number, title: fixHold || FIX_PR_HINT, disabled: !!fixHold }) : ''}
  </div>`;
}
