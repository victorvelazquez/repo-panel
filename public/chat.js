'use strict';
// RPC3d: the chat of the page (the open card, its tabs, the notes pad, the three-block layout) and its composer. index.html loads this file after tabs.js and BEFORE app.js;
// they share the global scope (like data.js, feed.js, tabs.js, view.js and resumen.js), so what is used from app.js (S, V, R, $, TOKEN, draw...) is only touched when a function
// is called, never while this file loads. The block that reads the saved layout only needs localStorage and has a catch. What runs at load and needs $ (the separators and the
// resize listener) stays in app.js, which loads last (test/rpc3d-chat.test.js loads this file alone).

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
  const fromList = !S.chat.id; // RP134: with no repo open before, the entry the address writes comes right after the list
  saveDraft();
  flushNotes();
  S.recall = {};
  S.chatResults = Object.create(null);
  S.chat = { id, seq: S.chat.seq + 1, zone: 'chat', ...(V && V.chatFromCache(S.chatCache[id])), ...(tab === 'tasks' && !columnOn() ? { tab } : {}) }; // RP79: cached messages at once, state unknown (no get: opening must not reorder the cache)
  $('#msgBox').value = S.drafts[id] || '';
  draw();
  if (chatCtl) chatCtl.abort();
  chatCtl = new AbortController();
  loadChat(id, { user: true, signal: chatCtl.signal });
  rpcSync(id);
  if (addressWrite() && fromList) S.chat.fromList = true; // RP134: the page itself opened this chat from the list and wrote its entry: the arrow can use the Back of the browser
}
// RP133 (S26): the address of the page follows the open repo and its zone, so Back and Forward walk the screens and a link reopens the same place. It is WRITTEN with history.pushState (it fires no event: no loop) and READ
// by addressApply, which never writes. Everything is guarded: most suites run the page with no history or no location at all.
const addr = { applying: false };
const addressNow = () => (typeof location === 'object' && location && typeof location.hash === 'string' ? location.hash : '');
function addressWrite(replace = false) { // true when it wrote an entry or replaced one
  if (addr.applying || !V || typeof history !== 'object' || !history || typeof location !== 'object' || !location) return false;
  const act = replace ? history.replaceState : history.pushState;
  if (typeof act !== 'function') return false;
  const id = S.chat.id;
  const want = id ? V.addressOf(id, S.chat.zone) : '';
  if (id && !want) return false; // a chat with no address (a room): the address bar is left alone
  const now = addressNow();
  if (!replace && (want === now || (want === '' && (now === '#' || now === '#/')))) return false;
  act.call(history, null, '', `${location.pathname || ''}${location.search || ''}${want}`);
  return true;
}
// RP134: the arrow of the chat head (visible under 760 px). A chat the page opened from the list has its own entry in the history, so the arrow uses the Back of the browser (the Back of the phone then does not return to the chat that
// was just closed) and the answer of the browser, the address changing, closes the chat. Any other chat is closed as always. A second tap while the first Back is on its way does nothing; if the browser never answers it closes anyway.
function chatBack() {
  if (!S.chat.id || S.chat.backing) return;
  if (S.chat.fromList && typeof history === 'object' && history && typeof history.back === 'function') {
    const chat = S.chat;
    chat.backing = true;
    history.back();
    setTimeout(() => { if (S.chat === chat) closeChat(); }, 1000);
    return;
  }
  closeChat();
}
// RP134: which screen is on. The mark only exists under 760 px, and a layout that measures nothing (hidden in another tab) is not guessed narrow.
function applyScreen() {
  const layout = $('#sumLayout');
  if (!V || !layout || !layout.dataset) return;
  const screen = V.screenOf(layout.clientWidth, S.chat.id, S.chat.zone);
  if (screen) layout.dataset.screen = screen; else delete layout.dataset.screen;
  // RP157, RP136: crossing a cut (a resize) changes what the chat head and the column hold (the tabs, the arrow of Repo), so it repaints once; lastBand is set before, so the repaint cannot loop.
  const band = V.bandOf(layout.clientWidth);
  const crossed = lastBand !== null && lastBand !== band;
  lastBand = band;
  if (crossed && S.chat.id) draw();
}
let lastBand = null;
function setZone(zone) {
  if (!S.chat.id || !V || !V.ADDRESS_ZONES.includes(zone) || S.chat.zone === zone) return;
  const from = S.chat.zone;
  S.chat.zone = zone;
  draw();
  const wrote = addressWrite();
  S.chat.zoneFromChat = wrote && from === 'chat' && zone === 'repo'; // RP157: the page itself wrote the entry that Repo sits on, so the arrow of Repo can use the Back of the browser
}
// RP157: the arrow of the Repo screen. Same rule as the arrow of the chat (chatBack): the Back of the browser when the page wrote the entry, else the chat zone; a second tap while it is on its way does nothing.
function zoneBack() {
  if (!S.chat.id || S.chat.zone !== 'repo' || S.chat.zoneBacking) return;
  if (S.chat.zoneFromChat && typeof history === 'object' && history && typeof history.back === 'function') {
    const chat = S.chat;
    chat.zoneBacking = true;
    history.back();
    setTimeout(() => { if (S.chat === chat && chat.zone === 'repo') { chat.zoneBacking = false; setZone('chat'); } }, 1000);
    return;
  }
  setZone('chat');
}
// RP157: under 760 px a file or a diff opens in the chat, where the viewer tab is: leave the Repo screen for it.
function leaveRepo() {
  if (narrowOn() && S.chat.zone === 'repo') setZone('chat');
}
// Applies an address of the page (a link, Back, Forward, a hash typed by hand). Junk is ignored and the address bar goes back to what is open (replaceState: no new entry). Nothing happens before the list of repos is
// known (a valid address would look like junk). Applying never writes, and it does nothing that is already so: a burst of events cannot loop.
function addressApply(hash) {
  if (!V || allRepos().length === 0) return;
  const to = V.parseAddress(hash, allRepos().map((r) => r.id));
  if (!to) { if (typeof hash === 'string') addressWrite(true); return; }
  addr.applying = true;
  try {
    if (to.kind === 'conformity') openConformity();
    else if (to.kind === 'list') { if (S.chat.id) closeChat(); }
    else {
      if (S.tab !== 'summary') setTab('summary');
      if (S.chat.id !== to.id) openChat(to.id);
      if (S.chat.id === to.id && S.chat.zone !== to.zone) { S.chat.zone = to.zone; S.chat.zoneBacking = false; S.chat.zoneFromChat = false; draw(); }
    }
  } finally { addr.applying = false; }
}
function closeChat() {
  if (!S.chat.id) return;
  saveDraft();
  flushNotes();
  S.recall = {};
  S.chatResults = Object.create(null);
  if (chatCtl) { chatCtl.abort(); chatCtl = null; }
  S.chat = { id: null, seq: S.chat.seq + 1 };
  chatShown = null;
  draw();
  addressWrite(); // RP133
}
// RP152: the counter of «Subagent working» moves by itself, once a second, and only while the open chat has one on and the page is visible (nothing is repainted otherwise).
function subTick() {
  if (document.hidden || !S.chat.id) return;
  const e = S.rpc[S.chat.id];
  if (e && Number.isInteger(e.subs) && e.subs > 0) draw();
}
const chatTick = () => { if (S.chat.id && (!S.chat.tab || S.chat.tab === 'chat') && S.tab === 'summary' && !document.hidden && !(V && pollSkipped('chat'))) loadChat(S.chat.id); };

// RP63 (S60): the Tasks tab reads /api/roadmap once per chat opening, when the tab is first shown. The last good answer of a repo
// is kept; a failure only shows when there is none. An answer for a repo the person left is stored but never painted for another.
// RP91: the opening is identified by the S.chat OBJECT (openChat and closeChat replace it), not by `seq`: loadChat bumps `seq` on every read and, with the tasks in the column, the chat keeps
// being read while the roadmap is on its way.
// RP149: it is also read again when the Tasks tab is entered and by the refresh button (`force`); a read already on its way is the one that answers, and a failed read keeps the last good list.
function loadTasks(opts = {}) {
  const chat = S.chat;
  const { id } = chat;
  if (!id || (chat.tasksAsked && !opts.force)) return undefined;
  if (chat.tasksReading) return chat.tasksReading;
  chat.tasksAsked = true;
  chat.tasksTriedAt = Date.now(); // RP151: a failed try counts too
  chat.tasksLoading = true;
  chat.tasksFailed = false;
  chat.tasksReading = (async () => {
    try {
      S.tasks[id] = await api(`/api/roadmap?id=${id}`);
      chat.tasksAt = Date.now();
    } catch {
      if (S.chat === chat) chat.tasksFailed = true;
    }
    chat.tasksReading = null;
    if (S.chat === chat) { chat.tasksLoading = false; draw(); }
  })();
  return chat.tasksReading;
}
// RP151: the clock of the Tasks tab of the column: it only READS (the force read of RP149), once a minute from the last try, and V.tasksPollDue says when. A read on its way is the one that answers, a failed one keeps the last
// good list on screen, and what is read for a repo the person left is stored for that repo and never painted (loadTasks).
function tasksTick() {
  const chat = S.chat;
  if (!V || !chat.id || !V.tasksPollDue({ chatId: chat.id, column: columnOn(), colTab: chat.colTab, hidden: document.hidden, narrow: narrowOn(), zone: chat.zone, reading: !!chat.tasksReading, at: chat.tasksTriedAt, now: Date.now() })) return;
  loadTasks({ force: true });
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
  const again = chat.ffile || chat.fpath; // RP130: the file open in the centre is read again with the tree
  if (chat.filesReq === req && again) loadFile(again);
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
  S.chat.tab = ['tasks', 'changes', 'files', 'notes'].includes(tab) && !((tab === 'tasks' || tab === 'changes' || tab === 'files') && columnOn()) ? tab : tab === 'diff' && S.chat.dfile ? 'diff' : tab === 'file' && S.chat.ffile ? 'file' : 'chat'; // RP91, RP92: with the column in, the tasks and the changed files are its cards, not tabs; RP90: the diff tab needs a file
  if (S.chat.tab === 'tasks') loadTasks();
  else if ((S.chat.tab === 'changes' || S.chat.tab === 'diff') && was !== S.chat.tab) loadChanges();
  else if (S.chat.tab === 'files' && was !== 'files') loadFiles();
  else if (S.chat.tab === 'notes' && was !== 'notes') loadNotes();
  draw();
}

// The status letter of every changed file of a repo (from the board facts), to mark them in the tree.
function changedOf(id) {
  const changed = {};
  for (const f of (modelOf(id).l.files || [])) changed[f.path] = f.untracked ? '?' : f.status;
  return changed;
}
// RP91: whether the right column is in (from COLUMN_FROM px of layout): then the tasks are its card and the chat has no Tasks tab.
// RP157: also under 760 px, where the column's content is the Repo screen and the chat keeps only Chat and Notes.
function narrowOn() {
  return !!V && V.bandOf($('#sumLayout').clientWidth) === 'narrow';
}
// RP136: and from 760 to 1100 px (the duo: the chat and the column side by side). Only the phone keeps what is its own: the Repo screen's arrow, the Repo button and the second line of the head.
// RP136: the duo is on in the mid band with a repo open (the screen the stylesheet follows).
function duoOn() {
  return !!V && !!S.chat.id && V.bandOf($('#sumLayout').clientWidth) === 'mid';
}
function columnOn() {
  const width = $('#sumLayout').clientWidth || 0;
  return width >= COLUMN_FROM || (!!V && V.bandOf(width) !== null);
}
// The widths now: the layout without its separators (the column's separator only counts while the column is in), and the three blocks from the saved shares.
function layoutNow() {
  const width = $('#sumLayout').clientWidth || 0;
  const column = columnOn();
  const listOn = !duoOn(); // RP136: in the duo the list is out of the screen, so the chat and the column share the width
  const total = width - (listOn ? ($('#split').offsetWidth || 0) : 0) - (column ? ($('#split2').offsetWidth || 0) : 0);
  return total > 0 && R ? { total, column, listOn, ...R.blockWidths(total, layoutRatios, { column, list: listOn }) } : null;
}
// RP129: what the Status tab of the column, the head of the chat and the Merge button of the composer need. The branch and the commits ahead are the board's facts; the PR is the open one of THAT branch and never another (on the base branch, on a
// detached HEAD, or with nothing loaded there is none); and the two buttons (Merge in the composer, Re-run in the Status tab) are what view.js decides with the ONE rule of the card of the board: the same busy, held and running-command facts the card reads.
// What is not known yet (loading, a failed read, no remote) is never read as a PR that is ready: it keeps the button off and says so.
function columnGit(id, facts) {
  const prs = S.prs[id];
  const branch = facts && !facts.error && typeof facts.branch === 'string' ? facts.branch : '';
  const known = !prs ? 'loading' : prs.error ? 'failed' : prs.noRemote ? 'noRemote' : 'ok';
  const pr = known === 'ok' && branch && Array.isArray(prs.prs) ? prs.prs.find((p) => p && p.head === branch) || null : null;
  const noPr = { loading: 'Loading pull requests…', failed: 'Pull requests unavailable', noRemote: 'This repository has no GitHub remote', ok: 'No open pull request for this branch' }[known];
  const ctx = { ...mergeCtxOf(id, pr ? pr.number : 0), noPr }; // RP137: the facts of the ONE rule, asked the same way by the sheet that confirms a merge
  return {
    id, branch, ahead: facts && Number.isInteger(facts.ahead) ? facts.ahead : 0, pr, noPr,
    merge: V ? (() => { const b = V.mergeButton(pr, ctx); return { ...b, why: V.mergeWhy(b) }; })() : { enabled: false, label: `Merge · ${S.prefs.method}`, title: 'view.js did not load' },
    rerun: V ? V.rerunButton(pr, ctx) : { show: false, enabled: false, title: '' },
  };
}
// RP137: the facts the ONE rule of the Merge button (V.mergeButton) reads for a PR: the method, a merge in flight, a merge already held, and a command running in the session. The Merge button of the composer and the sheet that confirms a merge
// ask the rule with the same facts.
function mergeCtxOf(id, n) {
  const busy = S.busy[`${id}:${n}`];
  const held = !busy && mergeHeld(id, n);
  const verdict = verdictOf({ id });
  const hold = verdict && verdict.state === 'running' && V ? V.runningReason({ cmd: verdict.cmd, label: verdict.label }) : '';
  return { method: S.prefs.method, busy, held, hold };
}
const prOfId = (id, n) => ((S.prs[id] && Array.isArray(S.prs[id].prs) ? S.prs[id].prs : []).find((p) => p && p.number === n)) || null;
// RP137: is this a phone? The width of the layout when it is measured; the Work tab hides the layout (it measures 0), so then the width of the window. A width that is not known is not a phone (today's behaviour).
function phoneNow() {
  const layout = $('#sumLayout').clientWidth || 0;
  const width = layout > 0 ? layout : typeof window === 'object' && window && typeof window.innerWidth === 'number' ? window.innerWidth : 0;
  return !!V && V.bandOf(width) === 'narrow';
}
// RP137: the sheet that asks before a merge. It is drawn from S.mergeSheet = { id, n, chatId } and the live data, and it closes by itself when the PR is not there, is not ready any more, or the open repo is not the one it was opened in.
let sheetShown = false;
function mergeSheetModel() {
  const sh = S.mergeSheet;
  if (!sh || !V || !R) return null;
  const pr = prOfId(sh.id, sh.n);
  if (!pr || (S.chat.id || null) !== sh.chatId || pr.head !== sh.head || pr.title !== sh.title || V.mergeButton(pr, mergeCtxOf(sh.id, sh.n)).enabled !== true) return null;
  return { n: pr.number, base: pr.base, title: pr.title, method: S.prefs.method, del: S.prefs.del === true };
}
function drawMergeSheet() {
  const model = mergeSheetModel();
  if (!model) S.mergeSheet = null;
  const el = $('#mergeSheet');
  if (!el) return;
  el.hidden = !model;
  paint(el, model ? R.mergeSheetHtml(model) : '');
  if (model && !sheetShown) { const b = $('#ms-cancel'); if (b && b.focus) b.focus(); }
  sheetShown = !!model;
}
function applyLayout() {
  applyScreen(); // RP134
  // RP126: how much sits above the layout (0 while it is hidden in another tab: then the last good value stays; a page without the measure sets nothing).
  const top = $('#sumLayout').offsetTop;
  if (Number.isFinite(top) && top > 0 && $('#sumLayout').style.setProperty) $('#sumLayout').style.setProperty('--sum-top', `${Math.round(top)}px`);
  const w = layoutNow();
  if (!w) return;
  if ($('#listCol').style.setProperty) $('#listCol').style.setProperty('--list-w', `${w.list}px`); // RP121: the width is the repos column's (its header and its list)
  if ($('#col').style.setProperty) $('#col').style.setProperty('--col-w', `${w.col}px`);
  $('#split').setAttribute('aria-valuenow', String(Math.round((w.list / w.total) * 100)));
  $('#split2').setAttribute('aria-valuenow', String(Math.round((w.col / w.total) * 100)));
}
// Sets the list and/or the column to a width in px (the other keeps the one it has), keeps the minimums and saves the shares.
function setBlocks({ list, col }) {
  const w = layoutNow();
  if (!w) return;
  const fixed = R.blockWidths(w.total, { list: (list ?? w.list) / w.total, col: (col ?? w.col) / w.total }, { column: w.column, list: w.listOn });
  layoutRatios = { list: w.listOn ? fixed.list / w.total : layoutRatios.list ?? null, col: w.column ? fixed.col / w.total : layoutRatios.col ?? null };
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
  // RP120: the three blocks (list, chat, column) and their two separators are ALWAYS in, with a repo open or not: the list takes its share of the window from the first start instead
  // of all of it, and the person can size the three before choosing a repo. With no repo the chat and the column say what to do and the composer is out (no session to write to).
  for (const id of ['#chat', '#split', '#split2', '#col']) $(id).hidden = false;
  if (document.body && document.body.classList) $('#sumLayout').classList.toggle('chat-open', true);
  applyLayout();
  if (!on) {
    paint($('#chatHead'), '');
    paint($('#chatBody'), '<p class="rs-sub rs-empty" role="status">Pick a repo to see its chat</p>');
    paint($('#colBody'), '<p class="rs-sub rs-empty" role="status">Pick a repo to see its tasks and files</p>');
    $('#composer').hidden = true;
    padShown = null;
    chatShown = null;
    return;
  }
  const column = columnOn();
  // RP91: with the column in, its tasks card is read when the repo OPENS (once per opening).
  if (column) loadTasks();
  // RP92: the files card is drawn from the facts the board keeps fresh (S.local), so it reads nothing.
  const facts = S.local[S.chat.id];
  // RP148: the tab the column opens on follows the situation of the repo. It is decided ONCE per opening, as soon as the facts are known: never over a tab the person chose, never again when the situation changes.
  if (column && !S.chat.colTab && V) {
    const pr = !!columnGit(S.chat.id, facts).pr;
    const pick = V.columnTabFor({ files: facts && !facts.error ? facts.files : null, ahead: facts ? facts.ahead : undefined, hasPr: pr, prsKnown: !!S.prs[S.chat.id] });
    if (pick) S.chat.colTab = pick;
  }
  // RP128: the column is tabs (Changes, Tasks). The open one belongs to the opening (S.chat.colTab, Changes by default), the closed folders too (S.chat.colFold); with no column nothing is painted.
  const colTab = ['tasks', 'status', 'files'].includes(S.chat.colTab) ? S.chat.colTab : 'changes';
  paint($('#colBody'), !column ? '' : R.columnView({ back: narrowOn(), name: nameOf(S.chat.id), tab: colTab, fold: S.chat.colFold, git: columnGit(S.chat.id, facts), files: facts && !facts.error && Array.isArray(facts.files) ? facts.files : null, failed: !!(facts && facts.error), selected: S.chat.dfile || '', tree: colTab === 'files' ? S.files[S.chat.id] || null : null, changed: colTab === 'files' ? changedOf(S.chat.id) : null, fselected: S.chat.ffile || '', fopen: S.filesOpen[S.chat.id] || {}, filesFailed: !!S.chat.filesFailed, tasksHtml: colTab === 'tasks' ? R.tasksView(S.tasks[S.chat.id] || null, { compact: true, open: S.tasksFold, more: S.tasksMore, readAt: S.chat.tasksAt, now: Date.now(), refreshing: !!S.chat.tasksRefreshing, refreshFailed: !!S.chat.tasksRefreshFailed, loading: !!S.chat.tasksLoading, failed: !!S.chat.tasksFailed }) : '' }));
  // What the person touched in the column keeps the focus across the repaint: a tab by its id, a folder or a fold by its button.
  const want = S.chat.colFocus;
  if (want) {
    S.chat.colFocus = null;
    const el = want.id ? $(`#${want.id}`) : Array.from(document.querySelectorAll(`#colBody [data-act="${want.act}"]`)).find((b) => b.dataset && b.dataset[want.key] === want.val);
    if (el && el.focus) el.focus();
  }
  // RP149: the summary row of the Tasks list sticks right under the tab bar, whatever the height of the bar is: the page measures it (the CSS has a default until then).
  const tabsBar = column ? $('#colBody .col-tabs') : null;
  if (tabsBar && tabsBar.offsetHeight > 0 && $('#col').style.setProperty) $('#col').style.setProperty('--col-tabs-h', `${tabsBar.offsetHeight}px`);
  paint($('#chatHead'), R.chatHead(S.chat, { name: nameOf(S.chat.id), column, narrow: narrowOn(), git: columnGit(S.chat.id, facts) }));
  const tasksTab = S.chat.tab === 'tasks' && !column;
  const changesTab = S.chat.tab === 'changes' && !column; // RP92: with the column in, the files card replaces the tab
  const filesTab = S.chat.tab === 'files' && !column; // RP130: the explorer is the column's; only without it the chat keeps its Files tab
  const fileTab = S.chat.tab === 'file' && !!S.chat.ffile;
  const notesTab = S.chat.tab === 'notes';
  const diffTab = S.chat.tab === 'diff' && !!S.chat.dfile; // RP90
  $('#composer').hidden = tasksTab || changesTab || filesTab || diffTab || fileTab || notesTab;
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
    paint($('#chatBody'), R.changesView(S.changes[S.chat.id] || null, { selected: S.chat.dfile, only: true, split: !!S.prefs.split, loading: !!S.chat.changesLoading, failed: !!S.chat.changesFailed }));
    chatShown = null;
    return;
  }
  if (fileTab) {
    paint($('#chatBody'), R.fileView(S.fileData[S.chat.id] || null, { selected: S.chat.ffile, fileLoading: !!S.chat.fileLoading, fileFailed: S.chat.fileFailed || '' }));
    chatShown = null;
    return;
  }
  if (filesTab) {
    const id = S.chat.id;
    const changed = changedOf(id);
    paint($('#chatBody'), R.filesView(S.files[id] || null, { selected: S.chat.fpath || '', open: S.filesOpen[id] || {}, changed, loading: !!S.chat.filesLoading, failed: !!S.chat.filesFailed, fileLoading: !!S.chat.fileLoading, fileFailed: S.chat.fileFailed || '' }, S.fileData[id] || null));
    chatShown = null;
    return;
  }
  if (changesTab) {
    paint($('#chatBody'), R.changesView(S.changes[S.chat.id] || null, { selected: '', split: !!S.prefs.split, loading: !!S.chat.changesLoading, failed: !!S.chat.changesFailed }));
    chatShown = null;
    return;
  }
  if (tasksTab) {
    paint($('#chatBody'), R.tasksView(S.tasks[S.chat.id] || null, { openDone: S.tasksOpenDone, loading: !!S.chat.tasksLoading, failed: !!S.chat.tasksFailed }));
    chatShown = null;
    return;
  }
  prunePending(S.chat.id);
  const shown = chatView();
  const hasSession = !!(S.chat.info && S.chat.info.adopted) || !!(S.rpc[S.chat.id] && S.rpc[S.chat.id].state !== 'closed'); // RP98: a session to close
  paint($('#sessState'), R.sessionLabelHtml(shown) + R.subagentChipHtml(shown, Date.now()) + R.memoryChipHtml(shown) + R.ctxChipHtml(shown) + R.compactButtonHtml(shown) + R.sessionTerminalHtml(hasSession, S.chat.terminal) + R.sessionCloseHtml(hasSession, S.chat.closing));
  paint($('#termBlock'), R.terminalBlockHtml(hasSession ? S.chat.terminal : null)); // RP118: the line for a normal terminal, only while the button is open
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
  const live = (S.rpc[id] && S.rpc[id].compacting ? 'working' : REASON_OF[S.rpc[id] && S.rpc[id].state]) || 'unknown'; // RP140: a compacting session takes no order either; RPC2b-1: the reason follows the session of the RPC host
  paint($('#chatActions'), R.actionButtonsHtml(R.actionMenu(row, { live, changes: summaryChanges(id), flow: summaryFlow(id) }), id, { sending: !!S.sending[id] }) + R.composerMergeHtml(columnGit(id, S.local[id]))); // RP175: Merge is not an item of the session menu: it does not wait for the session
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

// A session that is not started is started first (it can take up to five minutes: the label says Starting…); the start also adopts the session id the
// history is read from. A failure leaves the session closed and throws the server's message. The chat Send and the flow buttons share it.
// The callers check rpcNeedsStart first, so a session that is up adds no await (the send goes out in the same tick).
const rpcNeedsStart = (id) => !S.rpc[id] || S.rpc[id].state === 'closed';
async function ensureRpcStarted(id) {
  if (!rpcNeedsStart(id)) return;
  setRpc(id, { state: 'starting', error: '' });
  draw();
  try { S.rpc[id] = V.rpcFromStatus(S.rpc[id], await api('/api/rpc/start', { id }, { timeoutMs: START_WAIT_MS })); } catch (e) {
    setRpc(id, { state: 'closed' });
    throw startError(e);
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
