'use strict';
// RPC3b: the feed of the page: the event stream (the `rpc` frames), the board of RP80, the refresh ticks and the loads that fill the page. index.html loads this file
// after data.js and BEFORE app.js; they share the global scope (like view.js and resumen.js), so what is used from app.js (S, V, R, $, TOKEN, draw, the renderers...)
// is only touched when a function is called, never while this file loads (test/rpc3b-feed.test.js loads it alone).

// ---------- event stream (RP77b) ----------
// GET /api/events pushes what each pi session does (the `rpc` frames, applied by applyRpc). While it is open the chat poll only runs as a slow safety net.
const ev = { ctl: null, timer: null, attempt: 0, connected: false, lastByteAt: 0, ran: { chat: 0 } };

// RPC2-1: the live session of each repo (S.rpc[id], kept by V.rpcReduce). `rpc` frames feed it; the status read puts it right on open and on every (re)connect.
function applyRpc(p) {
  const { entry, reload, ctx } = V.rpcReduce(S.rpc[p.id], p, Date.now());
  S.rpc[p.id] = entry;
  if (ctx) loadContext(p.id);
  // RPC2-2: the verdict of a command sent from this page follows the session at once (the poll of /api/pi-status stays as the fallback).
  if (S.sent[p.id]) {
    const seen = p.kind === 'exit' ? 'closed' : p.kind === 'state' && entry.state !== 'starting' ? entry.state : null;
    if (seen) applyPiState(p.id, seen);
  }
  if (reload && S.chat.id === p.id) settled(p.id);
  else if (reload) Object.assign(entry, { blocks: [], text: '' }); // nobody is looking: the history will have it
  draw();
}
// A run ended: the persisted messages (read ONCE) replace the streaming bubble, and the pending ones the history has now go with it.
async function settled(id) {
  await loadChat(id);
  const e = S.rpc[id];
  if (e && !e.streaming) Object.assign(e, { blocks: [], text: '' });
  S.pending[id] = (S.pending[id] || []).filter((p) => p.state === 'sending');
  draw();
}
// RP139: the context of the OPEN chat's session, read when the chat opens (after its status), when a run ends and when a compaction ends; never on a timer and never while the session is closed or
// starting. An answer that arrives after the person left the repo is dropped; a failed read is `unknown`, never the old number. A read that is already on its way is repeated once, not stacked.
const ctxRun = Object.create(null);
const ctxLive = (id) => { const e = S.rpc[id]; return !!id && S.chat.id === id && !!e && e.state !== 'closed' && e.state !== 'starting'; };
async function loadContext(id) {
  if (!ctxLive(id) || String(id).startsWith('room:')) return;
  if (ctxRun[id]) { ctxRun[id] = 'again'; return; }
  ctxRun[id] = 'busy';
  let answer = null;
  try { answer = await api(`/api/rpc/context?id=${encodeURIComponent(id)}`); } catch { /* unknown */ }
  const again = ctxRun[id] === 'again';
  delete ctxRun[id];
  if (ctxLive(id)) { S.rpc[id] = V.rpcWithContext(S.rpc[id], answer); draw(); }
  if (again) loadContext(id);
}
async function rpcSync(id) {
  try { S.rpc[id] = V.rpcFromStatus(S.rpc[id], await api(`/api/rpc/status?id=${encodeURIComponent(id)}`)); draw(); loadContext(id); } catch { if (!S.rpc[id]) S.rpc[id] = V.rpcFromStatus(undefined, null); } // the stream keeps it up to date; with no answer at all it reads as not started, never stuck on unknown
}
// The open chat and the repos that have something going on; a closed one has nothing to read (rpcSeed already tells it).
const rpcSyncAll = () => new Set([S.chat.id, ...Object.keys(S.rpc).filter((id) => S.rpc[id].state !== 'closed')].filter((id) => id && !String(id).startsWith('room:'))).forEach(rpcSync);
// RPC2b-1: the state of EVERY repo in one read, on startup and on every (re)connect. An entry that exists only takes the new `state` (its streaming text and
// questions are the stream's); a new one starts blank. A failed read keeps what the page knew.
const RPC_STATE_NAMES = ['starting', 'idle', 'busy', 'asking', 'closed'];
async function rpcSeed() {
  let r;
  try { r = await api('/api/rpc/states'); } catch { return; }
  if (!r || !r.states || typeof r.states !== 'object') return;
  for (const [id, state] of Object.entries(r.states)) {
    if (!RPC_STATE_NAMES.includes(state)) continue;
    S.rpc[id] = S.rpc[id] ? { ...S.rpc[id], state } : V.rpcFromStatus(undefined, { state, pendingDialogs: [] });
  }
  draw();
}

// RP178: one notice from the server. N.plan decides what to show (nothing while this panel is in view); this only does it.
let audio = null;
function beep(kind) {
  try {
    audio = audio || new (window.AudioContext || window.webkitAudioContext)();
    if (audio.state === 'suspended') audio.resume();
    const notes = kind === 'answer' || kind === 'ci' ? [880, 660] : [660, 880]; // a falling pair asks for you, a rising one says something is ready
    notes.forEach((hz, i) => {
      const o = audio.createOscillator();
      const g = audio.createGain();
      const t = audio.currentTime + i * 0.16;
      o.frequency.value = hz;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.2, t + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.14);
      o.connect(g); g.connect(audio.destination);
      o.start(t); o.stop(t + 0.15);
    });
  } catch { /* no audio (a browser that has not been touched yet): the notice still shows */ }
}
function applyNotice(n, force = false) {
  const permission = typeof Notification === 'undefined' ? 'unsupported' : Notification.permission;
  const p = N.plan(n, { visible: document.visibilityState === 'visible', focused: document.hasFocus(), permission, prefs: S.prefs }, force);
  if (!p) return;
  if (p.toast) toast(`${n.title}: ${n.body}`, 'ok');
  if (p.sound) beep(n.kind);
  if (!p.system) return;
  try {
    const x = new Notification(n.title, { body: n.body, tag: `rp-${n.id}-${n.kind}`, icon: '/icon.svg' });
    x.onclick = () => { window.focus(); location.hash = V.addressOf(n.id, 'chat'); x.close(); };
  } catch { /* a browser that refuses to build one (a phone) keeps the notice and the sound */ }
}

async function readEvents(ctl) {
  const res = await fetch('/api/events', { headers: { 'x-token': TOKEN }, signal: ctl.signal });
  if (!res.ok || !res.body) throw new Error('No event stream');
  rpcSeed(); // every repo gets its state; what happened while the stream was down is read from the status
  rpcSyncAll();
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let rest = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return;
    ev.connected = true; // the preamble counts: the stream is open and talking
    ev.lastByteAt = Date.now();
    S.aliveAt = ev.lastByteAt;
    ev.attempt = 0;
    const parsed = V.parseSse(rest + decoder.decode(value, { stream: true }));
    rest = parsed.rest;
    if (rest.length > 1e6) throw new Error('Event frame too large');
    for (const frame of parsed.events) {
      const rpc = V.rpcEvent(frame);
      if (rpc) applyRpc(rpc);
      const note = N ? N.parse(frame) : null;
      if (note) applyNotice(note);
    }
  }
}

function stopEvents() {
  clearTimeout(ev.timer);
  ev.timer = null;
  ev.connected = false;
  const ctl = ev.ctl;
  ev.ctl = null;
  if (ctl) ctl.abort();
}

// Silent when the server has no stream (an old one, a 404, the 8-client cap): it retries slowly and the pollers keep working as before.
function startEvents() {
  if (!V || ev.ctl || ev.timer || document.hidden) return;
  const ctl = new AbortController();
  ev.ctl = ctl;
  readEvents(ctl).catch(() => {}).then(() => {
    if (ev.ctl !== ctl) return; // stopped on purpose
    stopEvents();
    ev.timer = setTimeout(() => { ev.timer = null; startEvents(); }, V.eventsRetryMs(ev.attempt++));
  });
}

// True when the stream is open and this poller ran less than its safety-net interval ago; otherwise it runs and notes the time.
function pollSkipped(which) {
  const now = Date.now();
  const plan = V.eventsPlan({ connected: ev.connected, lastEventAt: ev.ran[which], now });
  if (ev.connected && now - ev.ran[which] < plan.chatMs) return true;
  ev.ran[which] = now;
  return false;
}

// Every few seconds, while the tab is visible: restarts a silent event stream and redraws while a repo with changes is inside the
// quiet period, so the button enables itself once that ends.
let quietNow = {}; // which watched repos were inside the quiet period at the last tick
function quietTick() {
  if (document.hidden) return;
  const ids = V ? V.dirtyRepos({ ids: allRepos().map((r) => r.id), local: S.local, sent: S.sent, hidden: document.hidden }) : [];
  if (V && V.eventsStale({ connected: ev.connected, lastByteAt: ev.lastByteAt, now: Date.now() })) { stopEvents(); startEvents(); } // a silent stream is a dead one
  // Redraw while a repo is inside the quiet period and once more on the tick that finds it over, or the disabled button stays.
  const quiet = {};
  for (const id of ids) quiet[id] = V.quietPeriod(S.local[id].lastChangeMs);
  const redraw = ids.some((id) => quiet[id] || quietNow[id]);
  quietNow = quiet;
  if (redraw) draw();
}

// Applies a polled session state. A session that stops being busy has just finished its command: the repo's data is
// refreshed first (local, prs and state are read directly, so the card moves column at once and never judges the result on
// stale data; RP86b: the roadmap and the requirements come by the board, up to about 3 s later), and only then is the new state applied.
async function applyPiState(id, state) {
  const sent = S.sent[id];
  if (!sent) return;
  if (state === 'busy' || state === 'asking') sent.busySeen = true; // a dialog means the session is working on it
  if (S.pistatus[id] === 'busy' && state !== 'busy' && !S.finishing[id]) {
    S.finishing[id] = true;
    try { await refreshRepo(id, { poll: false, catchUp: true }); } finally { delete S.finishing[id]; }
  }
  if (S.sent[id] !== sent) return; // dismissed or sent again meanwhile
  S.pistatus[id] = state;
  draw();
}

// Starts (or restarts) the in-progress record of a command the session just received.
function startSent(id, record) {
  clearSent(id);
  S.sent[id] = record;
  draw();
  loadPiStatus(id);
}

function clearSent(id) {
  delete S.sent[id]; delete S.pistatus[id]; delete S.finishing[id];
}

function loadPrerequisites() {
  const seq = ++S.prereq.seq;
  // RPC1a: the pi runtimes (for the selector) are read apart; if that read fails the list still shows.
  const runtimes = api('/api/pi-runtime').catch(() => null); // not pooled: it must not take a slot from the repo reads
  return Promise.all([pooled(() => api('/api/prerequisites')), runtimes]).then(
    ([d, pi]) => { if (seq === S.prereq.seq) { S.prereq.state = 'loaded'; S.prereq.items = d.items || []; S.prereq.pi = pi; draw(); } },
    () => { if (seq === S.prereq.seq) { S.prereq.state = 'failed'; draw(); } },
  );
}

// RP111b: the options of the panel the page may change (the closed list of the server), read each time the Settings tab opens.
function loadSettings() {
  const seq = ++S.settings.seq;
  if (S.settings.state !== 'ready') S.settings.state = 'loading';
  return api('/api/settings').then(
    (d) => { if (seq === S.settings.seq) { S.settings.state = 'ready'; S.settings.options = settingsMap(d); draw(); } },
    () => { if (seq === S.settings.seq) { S.settings.state = 'failed'; draw(); } },
  );
}
const settingsMap = (d) => Object.fromEntries(((d && Array.isArray(d.options)) ? d.options : []).filter((o) => o && typeof o.key === 'string' && typeof o.value === 'boolean').map((o) => [o.key, o.value]));

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

// ---------- board (RP80) ----------
// GET /api/board answers from the server's memory what changed after S.boardRev. While it answers, the page paints from it and makes no
// per-repo request; a 404 (an old server) or three failures in a row send the page back to the old routes, and it keeps trying slowly.
const BOARD_DOWN_AFTER = 3;
const board = { failures: 0, seq: 0, applied: 0 };
const boardWorks = () => !!V && board.failures < BOARD_DOWN_AFTER;
// The old polling only stands down once the board has answered at least once: a page that never heard from it keeps reading as before.
const boardLeads = () => boardWorks() && board.applied > 0;

// An error with no value never replaces what the page already holds (a direct read may be good); the same failure values as the old loaders otherwise.
// A fact that keeps failing keeps its old value for 2 minutes; after that the error shows, as the old route did (a folder that went away).
const AGED_MS = 120000;
// `at` is the raw board entry's per-fact success times (boardApply keeps its own output shape without them).
function applyBoardRepo(id, f, at = {}) {
  const err = f.errors || {};
  const aged = (k) => !!err[k] && Number.isFinite(at[k]) && Date.now() - at[k] >= AGED_MS;
  if (f.local && !aged('local')) { setFact('local', id, f.local); } else if (err.local && (aged('local') || !S.local[id] || S.local[id].error)) setFact('local', id, { error: err.local });
  if (f.prs && !aged('prs')) { setFact('prs', id, f.prs); wakeReady(id, f.prs); releaseMerged(id, f.prs); } else if (err.prs && (aged('prs') || !S.prs[id] || S.prs[id].error)) setFact('prs', id, { error: err.prs });
  if (f.roadmap && !aged('roadmap')) setFact('roadmap', id, f.roadmap); else if (err.roadmap && (aged('roadmap') || !S.roadmap[id])) setFact('roadmap', id, null);
  if (f.state && !aged('state')) setFact('state', id, f.state); else if (err.state && (aged('state') || !S.state[id])) setFact('state', id, null);
  if (f.req && !aged('req')) S.req[id] = { state: 'loaded', data: f.req }; else if (err.req && (aged('req') || !(S.req[id] && S.req[id].state === 'loaded'))) S.req[id] = { state: 'failed' };
}

// Resolves to the ids that came without their facts (to read with the old loaders), or null when the board did not answer.
async function loadBoard() {
  if (!V) return null;
  const seq = ++board.seq;
  let b;
  try { b = await api(`/api/board?since=${S.boardRev}`); } catch (e) {
    board.failures = e.status === 404 ? BOARD_DOWN_AFTER : board.failures + 1;
    if (!boardWorks() && S.boardRefreshing.length) { S.boardRefreshing = []; draw(); }
    return null;
  }
  if (seq < board.applied) return []; // a newer answer was applied while this one travelled
  board.applied = seq;
  board.failures = 0;
  const out = V.boardApply(b, { lastAt: S.factAt });
  for (const [id, f] of Object.entries(out.set)) applyBoardRepo(id, f, (b.repos && b.repos[id] && b.repos[id].at) || {});
  const changed = Object.values(out.set).some((f) => Object.keys(f).length) || out.refreshing.join() !== S.boardRefreshing.join();
  S.boardRev = out.rev; // a LOWER rev is a restarted server: its repos were all applied above and its numbering is the one to follow now
  S.boardRefreshing = out.refreshing;
  if (changed) draw();
  return out.missing;
}

const boardTick = () => loadBoard();
function scheduleBoard() {
  setTimeout(async () => {
    // One answer that throws while it is applied must not end the chain: the old polling has stood down and the page would freeze.
    try { if (!document.hidden) await boardTick(); } catch { /* the next beat tries again */ } finally { scheduleBoard(); }
  }, V.boardWait({ ok: board.failures === 0, failures: board.failures }));
}

// `force` (the Refresh button): paints from memory first, then asks the server to re-read everything in the background.
async function refreshAll({ force = false } = {}) {
  checkHealth();
  if (S.conf.failed) S.conf.key = ''; // ask again once per refresh, never on every redraw
  S.lastRefresh = Date.now();
  const others = [loadPrerequisites(), loadRooms(), loadSummary()];
  const missing = await loadBoard();
  if (force && missing) api('/api/board/refresh', {}).catch(() => {});
  // A repo whose card holds a failed read (a direct read that timed out, say) is read again here: the board does not resend a fact that did not change.
  const broken = (id) => [S.local[id], S.prs[id]].some((x) => x && x.error);
  const ask = missing ? [...new Set([...missing, ...allRepos().map((r) => r.id).filter(broken)])] : allRepos().map((r) => r.id);
  await Promise.all([...others, ...ask.map((id) => refreshRepo(id))]);
  quietTick();
}

// Every few seconds, while the tab is visible and nothing is being merged: git-only data (local + declared state) of
// every repo about every 10 s, and local + PRs of the "hot" repos about every 20 s (view.js decides). No GitHub traffic
// for a cold repo: the 60 s full refresh covers it.
function refreshTick(now = Date.now()) {
  if (!V) return;
  const ids = allRepos().map((r) => r.id);
  const fromBoard = boardLeads(); // the board brings local, prs and state: only the session state of a sent command is still polled here
  for (const { id, kind } of V.refreshPlan({ now, ids, local: S.local, prs: S.prs, sent: S.sent, last: S.lastAt, loading: S.loading, hidden: document.hidden, busy: S.busy })) {
    const at = S.lastAt[id] || {};
    let hot = kind === 'hot';
    let due = true;
    if (fromBoard && kind !== 'sent') continue;
    if (kind === 'sent') { // the session state every 3 s, plus the hot or local work if it is due, so a PR still shows up fast
      loadPiStatus(id);
      (S.lastAt[id] || (S.lastAt[id] = {})).pistatus = now;
      if (fromBoard) continue;
      hot = V.isHotRepo({ local: S.local[id], prs: S.prs[id], sent: S.sent[id] }) && now - (at.prs || 0) >= V.HOT_REFRESH_MS;
      due = hot || now - (at.local || 0) >= V.LOCAL_REFRESH_MS;
    }
    if (!due) continue;
    markAsked(id, now, { prs: hot });
    if (hot) Promise.all([loadLocal(id), loadPrs(id), loadState(id)]);
    else Promise.all([loadLocal(id), loadState(id)]);
  }
}

async function fetchRepo(id) {
  try { await track(id, pooled(() => api('/api/fetch', { id }))); } catch (e) { toast(`${nameOf(id)}: ${e.message}`, 'bad'); }
  await refreshRepo(id, { catchUp: true });
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
