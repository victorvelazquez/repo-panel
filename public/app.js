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
// RPC3e: the three pointer listeners run at load, so they stay here; pressedAt and releasePress (their handlers) live in board.js and are only reached when the pointer moves.
document.addEventListener('pointerdown', () => { pressedAt = Date.now(); }, true);
document.addEventListener('pointerup', releasePress, true);
document.addEventListener('pointercancel', releasePress, true);

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
