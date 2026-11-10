'use strict';
// RPC3f: the actions of the page: merge, re-run, add repos, rooms, the ACTIONS table of click handlers (data-act) and the usage bar. index.html loads this file after board.js and
// BEFORE app.js; they share the global scope (like data.js, feed.js, tabs.js, chat.js, board.js, view.js and resumen.js), so what is used from app.js (S, V, R, $, TOKEN...) is only
// touched when a function is called, never while this file loads. The boot that runs at load (the document listeners, the setIntervals, loadUsage() and the init function) stays
// in app.js, which is only the boot file now (test/rpc3f-actions.test.js loads this file alone).

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

// RP140: how long the page waits for a compaction (it calls the model): a little more than the server's ten minutes.
const COMPACT_WAIT_MS = 605000;
const ACTIONS = {
  'refresh-all': () => refreshAll({ force: true }),
  'fetch-all': async () => { toast('Fetching all repos…'); await Promise.all(allRepos().map((r) => fetchRepo(r.id))); toast('Fetch done', 'ok'); },
  // RP64: the chip opens the single viewer, the Changes tab of the right panel; from the Work tab the page goes to the Summary first.
  'diff': (el) => { const id = el.dataset.id; if (S.tab !== 'summary') setTab('summary'); if (S.chat.id !== id) openChat(id); setChatTab('changes'); },
  // RP90: touching a file of the Changes list opens it in the ONE diff tab of the centre (reused for every file); RP92 will open it from the files card.
  'changes-file': (el) => { const p = el.dataset.path || ''; if (p) { S.chat.dfile = p; S.chat.ffile = ''; setChatTab('diff'); } else draw(); }, // RP130: the viewer tab is ONE, a diff or a file
  'diff-split': () => setPref('split', !S.prefs.split), // RP66c: the side-by-side diff on or off, kept with the other preferences
  'diff-close': () => { S.chat.dfile = ''; S.chat.ffile = ''; if (S.chat.tab === 'diff' || S.chat.tab === 'file') S.chat.tab = 'chat'; draw(); },
  // RP130: with the column in, a file of its explorer opens in the viewer tab of the centre; without it the chat's own Files tab reads it as before.
  'files-open': (el) => { const p = el.dataset.path || ''; if (!p) return; if (columnOn()) { S.chat.ffile = p; S.chat.dfile = ''; setChatTab('file'); } loadFile(p); },
  // The button says what the person SEES (data-open): the default is open only when a changed file is inside, so toggling flips that.
  'files-dir': (el) => { (S.filesOpen[S.chat.id] ||= {})[el.dataset.path || ''] = el.dataset.open !== 'true'; if (columnOn()) S.chat.colFocus = { act: 'files-dir', key: 'path', val: el.dataset.path || '' }; draw(); },
  'tab': (el) => { if (['summary', 'work', 'conformity', 'settings'].includes(el.dataset.tab)) setTab(el.dataset.tab); },
  // RP111b: an option of the PANEL. The key must be one the page knows (it is checked again by the server against its closed list); the new value is the opposite of the one read.
  'setting-toggle': async (el) => {
    const key = el.dataset && el.dataset.key;
    if (typeof key !== 'string' || !Object.hasOwn(S.settings.options, key) || typeof S.settings.options[key] !== 'boolean') return;
    try {
      const d = await api('/api/settings', { key, value: !S.settings.options[key] });
      Object.assign(S.settings, { options: settingsMap(d), saved: 'Saved to config.json', error: '' });
    } catch (e) { Object.assign(S.settings, { saved: '', error: String((e && e.message) || 'Could not save').slice(0, 200) }); }
    draw();
  },
  // An option of THIS BROWSER: the preference that already exists, from a closed list with the type each one has. Nothing goes to the server.
  'pref-set': (el) => {
    const { pref, value } = (el && el.dataset) || {};
    const v = value === 'true' ? true : value === 'false' ? false : value;
    const ok = (pref === 'method' && ['squash', 'merge', 'rebase'].includes(v)) || (['del', 'cleanAsColumn', 'split'].includes(pref) && typeof v === 'boolean');
    if (!ok) return;
    Object.assign(S.settings, { saved: 'Saved in this browser', error: '' });
    setPref(pref, v);
    syncPrefControls();
  },
  // RP121: the header of the repos column. Search and menu are page-only state (S.lh); the clears undo the shared filters.
  'lh-search-open': () => { S.lh.search = true; S.lh.legend = false; S.lh.focus = true; draw(); },
  'lh-search-close': () => { S.lh.search = false; draw(); },
  'lh-filters': () => { S.lh.menu = !S.lh.menu; S.lh.legend = false; draw(); },
  'lh-legend-close': () => { S.lh.legend = false; S.lh.focusInfo = true; draw(); }, // RP125: the close button of the legend: only closes it and gives the focus back to the info icon
  'lh-menu-close': () => { S.lh.menu = false; S.lh.focusBtn = true; draw(); }, // the close button of the filter menu: only closes it (the filters stay) and gives the focus back to the funnel
  'lh-legend': () => { S.lh.legend = !S.lh.legend; S.lh.menu = false; draw(); }, // RP121: the legend of the bars; it and the filter menu never show together
  'lh-clear-q': () => { S.q = ''; draw(); },
  'lh-clear-group': () => { S.group = ''; draw(); },
  'lh-clear': () => { S.q = ''; S.group = ''; S.scope = { kind: 'all' }; S.sfilter = 'all'; draw(); },
  'sfilter': (el) => { S.sfilter = el.dataset.filter === 'attention' ? 'attention' : 'all'; draw(); },
  'toggle-group': (el) => { S.collapsed[el.dataset.group] = !S.collapsed[el.dataset.group]; draw(); },
  'scope': (el) => { S.scope = el.dataset.kind === 'room' ? { kind: 'room', name: el.dataset.name } : { kind: el.dataset.kind === 'none' ? 'none' : 'all' }; draw(); },
  // "Open", "Start" and "⋯" of the Summary: show only this repo on the board.
  'focus-repo': (el) => { S.q = nameOf(el.dataset.id); $('#search').value = S.q; setTab('work'); },
  'chat-open': (el) => openChat(el.dataset.id),
  // RP91: with the column in, setChatTab turns the Tasks tab into the Chat one (the tasks card is already there); without it the chat opens on its Tasks tab as before.
  'tasks-open': (el) => { openChat(el.dataset.id, 'tasks'); if (S.chat.id === el.dataset.id) { if (columnOn()) S.chat.colTab = 'tasks'; setChatTab('tasks'); } }, // RP128: with the column in, the tasks are ITS tab
  'chat-tab': (el) => setChatTab(el.dataset.tab),
  'notes-retry': () => flushNotes(),
  'notes-disk': () => { const p = S.pad[S.chat.id]; if (p && p.status === 'conflict' && p.disk) { Object.assign(p, { text: p.disk.text, savedText: p.disk.text, base: p.disk.rev, status: 'saved', error: '', gen: p.gen + 1 }); p.req++; draw(); } },
  'notes-mine': () => { const p = S.pad[S.chat.id]; if (p && p.status === 'conflict' && p.disk) { p.base = p.disk.rev; p.status = 'saving'; saveNotes(S.chat.id); draw(); } },
  'tasks-done': () => { S.tasksOpenDone = !S.tasksOpenDone; draw(); },
  // RP128: the right column. The tab and the folded folders belong to the opening (S.chat is replaced when another repo opens); a tab that does not exist reads as Changes.
  'col-tab': (el) => { const t = el && el.dataset && ['tasks', 'status', 'files'].includes(el.dataset.tab) ? el.dataset.tab : 'changes'; S.chat.colTab = t; S.chat.colFocus = { id: `coltab-${t}` }; if (t === 'files') loadFiles(); if (t === 'tasks') loadTasks({ force: true }); draw(); },
  'col-folder': (el) => {
    const p = el && el.dataset && el.dataset.path;
    const facts = S.local[S.chat.id];
    if (typeof p !== 'string' || !p || !facts || !R.treeFolderPaths(facts.files).includes(p)) return; // only a folder of the tree on screen
    const fold = Object.assign(Object.create(null), S.chat.colFold);
    if (fold[p]) delete fold[p]; else fold[p] = true;
    S.chat.colFold = fold;
    S.chat.colFocus = { act: 'col-folder', key: 'path', val: p };
    draw();
  },
  // RP149: "+N more" of Pending opens and closes in place; the refresh button fetches the repo and then reads the list again (a failed fetch still reads what is on this machine and says so).
  'tasks-more': () => { S.tasksMore = !S.tasksMore; S.chat.colFocus = { act: 'tasks-more', key: 'k', val: 'more' }; draw(); },
  'tasks-refresh': async () => {
    const chat = S.chat;
    const { id } = chat;
    if (!id || chat.tasksRefreshing) return;
    chat.tasksRefreshing = true;
    chat.tasksRefreshFailed = false;
    draw();
    try { await api('/api/fetch', { id }); } catch { chat.tasksRefreshFailed = true; }
    if (S.chat === chat) await loadTasks({ force: true });
    chat.tasksRefreshing = false;
    if (S.chat === chat) draw();
  },
  'tasks-fold': (el) => {
    const k = el && el.dataset && el.dataset.fold;
    if (k !== 'done') return; // RP149: Pending and Blocked are open lists now; only Completed folds
    S.tasksFold = { ...S.tasksFold, [k]: !S.tasksFold[k] };
    S.chat.colFocus = { act: 'tasks-fold', key: 'fold', val: k };
    draw();
  },
  'chat-close': () => closeChat(),
  'chat-send': () => sendChatMessage(),
  // RP106b: the start of the text of one tool result, on request. The chip names the call; a second click folds it. An answer that arrives after the chat changed is dropped (the bag is replaced when a chat opens or closes).
  'chat-result': async (el) => {
    const { call } = el.dataset;
    const id = S.chat.id;
    if (!id || !call || !/^[A-Za-z0-9_.:-]{1,80}$/.test(call)) return;
    const bag = S.chatResults;
    const cur = Object.hasOwn(bag, call) ? bag[call] : null;
    if (cur && cur.state === 'loading') return;
    if (cur && cur.state === 'ok') { delete bag[call]; draw(); return; }
    bag[call] = { state: 'loading' };
    draw();
    try {
      const r = await api(`/api/chat/result?id=${encodeURIComponent(id)}&call=${encodeURIComponent(call)}`);
      if (S.chatResults !== bag) return;
      bag[call] = { state: 'ok', text: typeof r.text === 'string' ? r.text.slice(0, 2000) : '' };
    } catch (e) {
      if (S.chatResults !== bag) return;
      bag[call] = { state: 'error', error: String((e && e.message) || 'Result unavailable').slice(0, 200) };
    }
    draw();
  },
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
    if (S.chat.starting) return; // RP99: a new session is starting: the server would refuse (409) and the list is disabled
    // RP100: pi does not lock its session files; a session written to a moment ago may be open in a terminal, and two programs on the same session mix up its history.
    if (el.dataset.recent === '1' && !confirm('This session was written to a moment ago, so it may be open in a terminal. Two programs on the same session mix up its history. Open it here anyway?')) return;
    if (S.chat.terminal) { S.chat.terminal = null; draw(); } // RP118: another session is adopted: the line of the old one must not stay (repainted here: loadChat only redraws when what it read changed)
    try { await api('/api/sessions/adopt', { id, session }); } catch (e) { toast(e.message, 'bad'); }
    if (S.chat.id === id) loadChat(id);
  },
  'chat-start': async (el) => {
    const { id } = el.dataset;
    if (S.chat.starting) return;
    S.chat.starting = true;
    S.chat.terminal = null; // RP118: a NEW session has its own id
    el.disabled = true;
    setRpc(id, { state: 'starting', error: '' }); // RP99: the composer waits and the list is disabled until it answers
    draw();
    try { S.rpc[id] = V.rpcFromStatus(S.rpc[id], await api('/api/rpc/start', { id, new: true }, { timeoutMs: START_WAIT_MS })); } catch (e) { setRpc(id, { state: 'closed' }); toast(startError(e).message, 'bad'); } // RP99: a NEW session with its own id
    S.chat.starting = false;
    el.disabled = false;
    if (S.chat.id === id) loadChat(id);
    draw();
  },
  // RP118: shows (or hides) the line to open the session of the open chat in a normal terminal. The line is read when the button is clicked, never when a chat opens; the server writes it. An answer that
  // arrives after another chat was opened, or after the block was hidden, is dropped; a failure says one fixed thing and never the raw error.
  'session-terminal': async () => {
    const id = S.chat.id;
    if (!id) return;
    if (S.chat.terminal) { S.chat.terminal = null; draw(); return; }
    const seq = S.chat.seq;
    const mine = { open: true, loading: true };
    S.chat.terminal = mine;
    draw();
    let next;
    try {
      const r = await api(`/api/terminal?id=${encodeURIComponent(id)}`);
      next = r && r.available === true && typeof r.command === 'string' ? { open: true, available: true, cwd: r.cwd, command: r.command, sessionId: r.sessionId, shell: r.shell } : { open: true, available: false, reason: r && typeof r.reason === 'string' ? r.reason : '' };
    } catch (e) { next = { open: true, failed: true }; }
    if (S.chat.id !== id || S.chat.seq !== seq || S.chat.terminal !== mine) return;
    S.chat.terminal = next;
    draw();
  },
  // Copies the command kept in the page state (never text read back from the screen).
  'terminal-copy': async () => {
    const t = S.chat.terminal;
    if (!t || typeof t.command !== 'string') return;
    try { await navigator.clipboard.writeText(t.command); } catch (e) { toast('Could not copy: select the command and copy it by hand', 'bad'); return; }
    if (S.chat.terminal === t) { t.copied = true; draw(); }
  },
  'terminal-hide': () => { S.chat.terminal = null; draw(); },
  // RP98: stops the session of the open chat and releases its adoption, so the chat comes back to the list of sessions. A session that is working or asking is confirmed first (closing stops what it is doing).
  'session-close': async () => {
    const id = S.chat.id;
    if (!id || S.chat.closing) return;
    const st = S.rpc[id] && S.rpc[id].state;
    if ((st === 'busy' || st === 'asking') && !confirm('This session is working. Close it anyway? What it is doing is stopped.')) return;
    S.chat.terminal = null; // RP118: the line of a session that is going away is never shown again
    S.chat.closing = true;
    draw();
    try {
      await api('/api/rpc/close', { id });
      S.rpc[id] = V.rpcFromStatus(S.rpc[id], { state: 'closed', pendingDialogs: [], sessionId: null });
    } catch (e) { toast(e.message, 'bad'); }
    S.chat.closing = false;
    if (S.chat.id === id) loadChat(id);
    draw();
  },
  // RP140 (S28): compacts the context of the open chat's session by hand. An answer in progress is stopped by compacting, so a busy session is confirmed first and only then sent with force; the server decides anyway.
  // The mark goes on at the click (no second send, `Compacting…`); the verdict of the server comes back as a fixed message, and the status gives the true mark back. A success reads the history again (the
  // `Context compacted` marker); the context is read by the end event of the session (RP139), not here.
  'compact': async () => {
    const id = S.chat.id;
    const cur = id && S.rpc[id];
    if (!cur || cur.compacting || (cur.state !== 'idle' && cur.state !== 'busy')) return;
    const busy = cur.state === 'busy';
    if (busy && !confirm('The session is answering. Compacting stops that answer first. Compact anyway?')) return;
    delete S.notes[id];
    setRpc(id, { compacting: true, error: '' });
    draw();
    try {
      await api('/api/rpc/compact', busy ? { id, force: true } : { id }, { timeoutMs: COMPACT_WAIT_MS });
      setRpc(id, { compacting: false });
      if (S.chat.id === id) loadChat(id);
    } catch (e) {
      sayNote(id, e.message);
      await rpcSync(id);
    }
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
