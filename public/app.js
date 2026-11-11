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
  req: {}, reqSeq: {}, state: {}, stateSeq: {}, sent: {}, pistatus: {}, pistatusSeq: {}, sending: {}, merged: {}, pending: {}, finishing: {}, showCommit: new Set(), settings: { state: 'idle', seq: 0, options: {}, saved: '', error: '' }, prereq: { state: 'loading', items: [], seq: 0, pi: null },
  rooms: [], roomIssues: [], roomData: { state: 'loading', data: null }, roomSeq: 0,
  prefs: store('prefs', { method: 'squash', del: true }),
  lastRefresh: 0, lastAt: {}, scan: [],
  boardRev: 0, boardRefreshing: [], factAt: {},
  tab: 'summary', scope: { kind: 'all' }, summary: null, summaryKey: '', summaryFailed: false, sfilter: 'all', collapsed: {},
  timeouts: { get: 25000, post: 70000 },
  tasks: {}, tasksOpenDone: false, tasksMore: false, tasksFold: {}, changes: {}, files: {}, filesOpen: {}, fileData: {}, pad: {},
  lh: { search: false, menu: false, legend: false, focus: false }, // RP121: the header of the repos column (search box open, filter menu open, focus the box on the next draw)
  chat: { id: null, seq: 0 }, chatCache: {}, drafts: {}, recall: {}, notes: {}, askBusy: {}, chatResults: Object.create(null), rpc: {},
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

document.addEventListener('click', (e) => {
  if (S.menu && !e.target.closest('.more')) { S.menu = null; draw(); }
  if ((S.lh.menu || S.lh.legend) && !e.target.closest('#listHead')) { S.lh.menu = false; S.lh.legend = false; draw(); } // RP121: a click outside the header closes the filter menu
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
  if (e.key === 'Escape' && (S.lh.menu || S.lh.search || S.lh.legend)) { S.lh.menu = false; S.lh.search = false; S.lh.legend = false; draw(); return; } // RP121: the bar of the repos column first
  if (e.key === 'Escape' && S.menu) { S.menu = null; draw(); return; }
  if (e.key === 'Escape') {
    const menu = $('#addMenu');
    if (S.chat.id && !(menu && menu.open) && document.activeElement !== $('#usage') && !['#addDialog', '#roomDialog'].some((d) => $(d) && $(d).open)) closeChat();
  } else if ((e.key === 'Enter' || e.key === ' ') && e.target && e.target.dataset && e.target.dataset.act === 'chat-open') { e.preventDefault(); ACTIONS['chat-open'](e.target); }
  else if ((e.key === 'Enter' || e.key === ' ') && e.target && e.target.dataset && e.target.dataset.act === 'tasks-open') { e.preventDefault(); e.stopPropagation(); ACTIONS['tasks-open'](e.target); }
});

// RP128: the arrows, Home and End move between the tabs of the right column (the tab pattern) and the one reached takes the focus; nothing else is touched.
document.addEventListener('keydown', (e) => {
  const t = e.target;
  if (!R || !t || !t.dataset || t.dataset.act !== 'col-tab' || e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
  const tabs = R.COLUMN_TABS;
  const i = tabs.indexOf(t.dataset.tab);
  const to = e.key === 'ArrowRight' ? tabs[(i + 1) % tabs.length] : e.key === 'ArrowLeft' ? tabs[(i + tabs.length - 1) % tabs.length] : e.key === 'Home' ? tabs[0] : e.key === 'End' ? tabs[tabs.length - 1] : null;
  if (!to) return;
  e.preventDefault();
  ACTIONS['col-tab']({ dataset: { tab: to } });
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
document.addEventListener('input', (e) => { if (e.target && e.target.id === 'msgBox') { delete S.recall[S.chat.id]; saveDraft(); } else if (e.target && e.target.id === 'notesBox') notesInput(e.target.value); });

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

// The Add menu is static HTML (never painted by draw()): it closes with Escape, with a click outside and with a click on one of its items.
document.addEventListener('keydown', (e) => {
  const menu = $('#addMenu');
  if (e.key === 'Escape' && menu && menu.open) { menu.open = false; const s = menu.querySelector && menu.querySelector('summary'); if (s && s.focus) s.focus(); }
});
document.addEventListener('click', (e) => {
  const menu = $('#addMenu');
  if (menu && menu.open && (!(menu.contains && menu.contains(e.target)) || (e.target && e.target.closest && e.target.closest('[data-act]')))) menu.open = false;
});

$('#search').addEventListener('input', (e) => { S.q = e.target.value; draw(); });
$('#lhSearch').addEventListener('input', (e) => { S.q = e.target.value; draw(); });
$('#lhGroup').addEventListener('change', (e) => { S.group = e.target.value; draw(); });
// RP121: the key / opens the search of the repos column from anywhere in Summary, unless a field has the focus (the message box keeps its slashes), a dialog is open or a modifier is down.
document.addEventListener('keydown', (e) => {
  if (e.key !== '/' || e.ctrlKey || e.metaKey || e.altKey || e.isComposing || S.tab !== 'summary') return;
  const t = e.target || {};
  if (['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName) || t.isContentEditable || ['#addDialog', '#roomDialog'].some((d) => $(d) && $(d).open)) return;
  e.preventDefault();
  ACTIONS['lh-search-open']();
});
$('#groupFilter').addEventListener('change', (e) => { S.group = e.target.value; draw(); });

// Auto-refresh while the tab is visible: everything every minute, plus the lighter
// refreshes planned by refreshTick in between.
setInterval(() => {
  if (!document.hidden) refreshAll();
}, V ? V.FULL_REFRESH_MS : 60000);
setInterval(() => refreshTick(), 2000);
setInterval(summaryTick, 20000);
setInterval(chatTick, CHAT_MS);
setInterval(subTick, 1000); // RP152
setInterval(quietTick, 10000);
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
  $('#cleanAsColumn').checked = cleanAsColumn();
  draw();
  if (location.hash === '#conformity') openConformity(); // deep link
  refreshAll();
  rpcSeed();
  startEvents();
  if (V) scheduleBoard();
})();
