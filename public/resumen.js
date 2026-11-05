'use strict';
// Pure helpers of the Summary tab (plain <script>, global RepoPanelResumen; CommonJS in tests). They take the payload of
// GET /api/summary and return HTML strings; no DOM, no network. Every text that comes from data goes through `esc`.
(function (root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.RepoPanelResumen = api;
}(typeof self !== 'undefined' ? self : this, (root) => {
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const clip = (s, n) => (String(s).length > n ? `${String(s).slice(0, n - 1)}…` : String(s));
  const ALL = { kind: 'all' };
  const LABEL_MAX = 24;
  // State = icon + word, never colour alone.
  const SESSION = {
    working: ['green', '● working'], waiting: ['yellow', '◐ asking you'], free: ['gray', '○ free'],
    none: ['gray', '○ no session'], unknown: ['gray', '? unknown'],
  };

  const normalizeScope = (scope, rooms) => {
    if (scope && scope.kind === 'none') return { kind: 'none' };
    if (scope && scope.kind === 'room' && (rooms || []).some((r) => r.name === scope.name)) return { kind: 'room', name: scope.name };
    return ALL;
  };
  const filterRows = (rows, scope) => rows.filter((r) => (scope.kind === 'room' ? r.room === scope.name : scope.kind === 'none' ? !r.room : true));
  // The rows the Summary shows: the scope, then the shared text and group filters (empty or "all" is no filter).
  const visibleRows = (rows, ctx) => {
    const q = String(ctx.q || '').toLowerCase();
    const group = ctx.group && ctx.group !== 'all' ? ctx.group : '';
    return filterRows(rows, normalizeScope(ctx.scope, ctx.rooms)).filter((r) => (!group || r.group === group) && (!q || String(r.name).toLowerCase().includes(q)));
  };

  function relativeTime(iso, now = Date.now()) {
    const t = Date.parse(iso);
    if (!iso || Number.isNaN(t)) return '—';
    const s = Math.max(0, Math.round((now - t) / 1000));
    if (s < 60) return 'just now';
    if (s < 3600) return `${Math.floor(s / 60)} min ago`;
    if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
    return `${Math.floor(s / 86400)} d ago`;
  }

  function scopeBar(rooms, total, scope) {
    const cur = normalizeScope(scope, rooms);
    const assigned = new Set((rooms || []).flatMap((r) => r.repos || []));
    const btn = (attrs, on, label, n) => `<button type="button" data-act="scope" ${attrs} aria-pressed="${on}">${esc(label)} <span class="mono">${n}</span></button>`;
    return [btn('data-kind="all"', cur.kind === 'all', 'All', total)]
      .concat((rooms || []).map((r) => btn(`data-kind="room" data-name="${esc(r.name)}"`, cur.kind === 'room' && cur.name === r.name, r.name, (r.repos || []).length)))
      .concat(btn('data-kind="none"', cur.kind === 'none', 'No room', Math.max(0, total - assigned.size))).join('');
  }

  const noData = '<span class="rs-sub rs-none">no data</span>';
  const dash = '<span class="rs-sub rs-none">—</span>';
  const pct = (n, total) => Math.floor((n * 1000) / total) / 10; // rounded down: the four never add up to more than 100
  const num = (v) => Math.max(0, Math.floor(Number(v)) || 0);
  const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
  const sessionChip = (state) => { const [color, text] = SESSION[state] || SESSION.unknown; return `<span class="chip ${color}">${text}</span>`; };

  // Segmented bar plus a SHORT count; the full breakdown is the title and the aria-label. `p` is a row's progress or a sum of them.
  // With `id` (a repo card, never a room sum) the whole bar is a button that opens the tasks of that repo (RP63).
  function progressHtml(p, id) {
    if (!p || p.total === null || p.total === undefined) return noData;
    if (!p.total) return '<span class="rs-sub">no units</span>';
    const pending = num(p.pendiente) + num(p.enCurso);
    const seg = (cls, n) => `<i class="rs-seg ${cls}" style="width:${pct(num(n), num(p.total))}%"></i>`;
    const text = `${num(p.completada)} of ${num(p.total)} completed${p.enRevision ? ` · ${num(p.enRevision)} in review` : ''}${p.bloqueada ? ` · ${num(p.bloqueada)} blocked` : ''}`;
    const open = id ? ` data-act="tasks-open" data-id="${esc(id)}" role="button" tabindex="0"` : '';
    return `<div class="rs-prog"${open} title="${text}${id ? ' · Click to see the tasks' : ''}"><div class="rs-bar" role="img" aria-label="${text}">${seg('rs-done', p.completada)}${seg('rs-pr', p.enRevision)}${seg('rs-blk', p.bloqueada)}${seg('rs-pend', pending)}</div></div>`;
  }

  // RP87: the change chips are the board card's too, so they live in view.js (a global in the page, a module in Node) and are looked up when used.
  // RP94c: the chip of the open pull request(s) with the state of their checks (view.js), looked up the same way.
  const prChipOf = (prs) => { const v = typeof module === 'object' && module.exports ? require('./view.js') : root.RepoPanelView; return v && v.prChip ? v.prChip(prs) : ''; };
  // RP94d: the chips that say how long the changes have sat, that a PR conflicts and that a PR is large (all in view.js, looked up the same way).
  const viewChip = (name, ...args) => { const v = typeof module === 'object' && module.exports ? require('./view.js') : root.RepoPanelView; return v && v[name] ? v[name](...args) : ''; };
  const chipsOf = (c, id) => { const v = typeof module === 'object' && module.exports ? require('./view.js') : root.RepoPanelView; return v && v.changeChips ? v.changeChips(c, id) : ''; };

  // ONE line: the next unit (full entrega and result in the title), or what a blocked repo waits for.
  function nextHtml(r) {
    if (r.error) return `<div class="rs-next rs-err" title="${esc(r.error)}">${esc(r.error)}</div>`;
    if (r.next) {
      const line = `${r.next.id} — ${r.next.entrega ?? ''}`;
      const result = /[^\s—–-]/.test(r.next.resultadoVisible ?? '') ? `\nResult: ${r.next.resultadoVisible}` : '';
      return `<div class="rs-next" title="${esc(line + result)}"><span class="rs-sub">Next</span> · ${esc(line)}</div>`;
    }
    const waits = (b) => [...(b.waitsFor || []), ...(b.external || [])];
    const text = (b) => (waits(b).length ? `${b.unit} → ${waits(b).join(', ')}` : `${b.unit} is blocked`);
    if ((r.blocking || []).length) return `<div class="rs-next" title="${esc(r.blocking.map(text).join('\n'))}"><span class="rs-sub">Waiting</span> · ${esc(text(r.blocking[0]))}</div>`;
    return `<div class="rs-next">${dash}</div>`;
  }

  // ONE primary button reusing the page's own data-act machinery.
  function actionButton(r, ctx) {
    const id = esc(r.id);
    const a = r.error ? null : r.action;
    // The visible label is short; the full text stays in title and aria-label.
    const open = (title, cls = '', kind = '') => `<button${cls ? ` class="${cls}"` : ''} data-act="focus-repo" data-id="${id}"${kind ? ` data-kind="${kind}"` : ''} title="${esc(title)}" aria-label="${esc(title)}">Open</button>`;
    const sending = ctx.sending && ctx.sending[r.id] ? ' disabled' : '';
    if (r.error) return open('Open');
    if (!a) return '';
    if (a.kind === 'merge') return `<button class="merge" data-act="merge" data-id="${id}" data-n="${esc(a.pr)}" title="Merge #${esc(a.pr)}" aria-label="Merge #${esc(a.pr)}"${ctx.busy && ctx.busy[`${r.id}:${a.pr}`] ? ' disabled' : ''}>${esc(clip(`Merge #${a.pr}`, LABEL_MAX))}</button>`;
    if (a.kind === 'branch') return `<button class="primary" data-act="pi" data-id="${id}" data-cmd="flow-base" title="Send /flow-base to the open session of this repo"${sending}>/flow-base</button>`;
    if (a.kind === 'start') return `<button class="primary" data-act="pi" data-id="${id}" data-cmd="flow-next" title="Send /flow-next to the open session of this repo (starts ${esc(r.next ? r.next.id : '')})"${sending}>/flow-next</button>`;
    if (a.kind === 'deliver') {
      const f = ctx.flowFor ? ctx.flowFor(r.id) : null;
      return f
        ? `<button class="primary" data-act="pi" data-id="${id}" data-cmd="${esc(f.cmd)}" title="${esc(f.reason || `Send /${f.cmd} to the open session of this repo`)}"${f.disabled || sending ? ' disabled' : ''}>${esc(f.label)}</button>`
        : '<button class="primary" disabled title="This repo\'s local state is not loaded yet">Deliver</button>';
    }
    // answer and waiting get data-kind so the stylesheet can colour them amber; manual stays neutral.
    return open(`Open · ${a.label ?? ''}`, 'primary', a.kind === 'answer' || a.kind === 'waiting' ? a.kind : '');
  }

  // RP78: a repo whose facts are still being read is a calm placeholder: no button, no action, not clickable, never an error look.
  const loadingCard = (r, id) => `<article class="rs-card rs-loading" data-id="${id}" aria-busy="true" aria-label="${esc(r.name)}">
      <div class="rs-l1"><b class="rs-name" title="${esc(r.name)}">${esc(r.name)}</b><span class="rs-spacer"></span><span class="rs-sub" role="status">Loading…</span></div>
    </article>`;
  // A row served from memory while a fact is being refreshed (RP78): RP94b dropped the "Updating…" text; the card itself is marked busy and its tooltip names the facts.
  const staleFacts = (r) => (r.stale && Array.isArray(r.stale.facts) && r.stale.facts.length ? r.stale.facts : null);

  // Two lines: name, branch, change chips, time, session; then bar, next unit, the action.
  function cardHtml(r, ctx) {
    const id = esc(r.id);
    if (r.loading) return loadingCard(r, id);
    const lm = r.lastMovement || {};
    const a = r.error ? null : r.action;
    const cls = r.session && r.session.state === 'waiting' ? ' ask' : !r.error && !r.next && (r.blocking || []).length ? ' block' : '';
    const prs = !r.error && ctx.prsFor ? ctx.prsFor(r.id) : null;
    const chips = r.error ? '' : chipsOf(ctx.changesFor ? ctx.changesFor(r.id) : null, r.id) + viewChip('idleChip', ctx.idleFor ? ctx.idleFor(r.id) : null, ctx.now) + prChipOf(prs) + viewChip('conflictChip', prs) + viewChip('sizeChip', prs) + (a && a.kind === 'manual' ? '<span class="chip red">▲ manual action</span>' : '');
    // RP88b: the frame is V.RepoCard (view.js), shared with the board card; what is specific to the Summary card is built here.
    const view = typeof module === 'object' && module.exports ? require('./view.js') : root.RepoPanelView;
    return view.RepoCard({
      id: r.id, label: r.name, cls, current: ctx.chatId === r.id,
      ...(!r.error && staleFacts(r) ? { title: `Updating: ${staleFacts(r).join(', ')}`, busy: true } : {}),
      identity: `<b class="rs-name" title="${esc(r.name)}">${esc(r.name)}</b>`,
      branch: { text: r.branch ?? '', title: r.branch ?? '' }, chips,
      // RP94c: the subject of the last commit (the row already had it as the tooltip of the time), on its own small line.
      commit: !r.error && typeof lm.what === 'string' && lm.what.trim() ? `<span class="rs-sub rs-commit" title="${esc(lm.what.trim())}">${esc(lm.what.trim())}</span>` : '',
      meta: `<span class="rs-sub rs-when" title="${esc(lm.what ?? '')}">${esc(relativeTime(lm.at, ctx.now))}</span>${r.error ? '<span class="chip red">▲ error</span>' : sessionChip(r.session && r.session.state)}`,
      body: `${r.error ? noData : progressHtml(r.progress, r.id)}${nextHtml(r)}${actionButton(r, ctx)}`,
    }, 'summary');
  }

  // The chat panel (RP54, S48/S53). Pure like the rest: the page passes S.chat ({ id, info, hist, failed, starting }).
  const CHAT_MIN = 340;
  const LIST_MIN = 260;
  const COL_MIN = 220;
  // RP89 (S4, S10): the widths of the three blocks (list | chat | column) of the Summary with a repo open, for `total` px (the layout without its separators). `ratios` are the saved
  // shares of the LIST and the COLUMN ({ list, col }, each a number between 0 and 1, else its default: 25% each, the chat is what is left, so 25 | 50 | 25). Minimums: list 260 (what
  // the narrow card of RP88 needs), chat 340, column 220; when they cannot all fit the list goes first and the column takes what the chat leaves. With `column: false` (under 1100 px)
  // there are two blocks and the list is half by default, as before. Total: a width that is not a positive number gives zeros; a width too small for the minimums is split 25 | 50 | 25.
  const share = (v, dflt) => (typeof v === 'number' && Number.isFinite(v) && v > 0 && v < 1 ? v : dflt);
  const within = (v, lo, hi) => Math.max(lo, Math.min(v, Math.max(lo, hi)));
  function blockWidths(total, ratios, { column = true } = {}) {
    if (typeof total !== 'number' || !Number.isFinite(total) || total <= 0) return { list: 0, chat: 0, col: 0 };
    const t = Math.floor(total);
    const r = ratios && typeof ratios === 'object' && !Array.isArray(ratios) ? ratios : {};
    if (!column) {
      if (t < LIST_MIN + CHAT_MIN) { const list = Math.floor(t / 2); return { list, chat: t - list, col: 0 }; }
      const list = within(Math.round(t * share(r.list, 0.5)), LIST_MIN, t - CHAT_MIN);
      return { list, chat: t - list, col: 0 };
    }
    if (t < LIST_MIN + CHAT_MIN + COL_MIN) { const list = Math.floor(t * 0.25); const col = Math.floor(t * 0.25); return { list, chat: t - list - col, col }; }
    const list = within(Math.round(t * share(r.list, 0.25)), LIST_MIN, t - CHAT_MIN - COL_MIN);
    const col = within(Math.round(t * share(r.col, 0.25)), COL_MIN, t - CHAT_MIN - list);
    return { list, chat: t - list - col, col };
  }
  // RP91 (S4, S5), RP92 (S6): what the right column holds: the TASKS card of the open repo (`tasksHtml` is R.tasksView's answer, drawn by the page; left out when empty) and the FILES card:
  // the files with uncommitted changes (`files`, the board's facts: path, status, added, deleted), each a button that opens it in the diff tab (`selected` marks the one open there). Total.
  const FILES_MAX = 200;
  const filesCard = (c) => {
    const label = `Files with changes${c.name ? ` of ${esc(c.name)}` : ''}`;
    const frame = (n, body) => `<section class="col-card col-files" aria-label="${label}"><h3 class="col-title">Files${n === null ? '' : ` <span class="col-n">${n}</span>`}</h3>${body}</section>`;
    if (!Array.isArray(c.files)) return frame(null, `<p class="rs-sub" role="status">${c.failed ? 'Files unavailable' : 'Loading files…'}</p>`);
    const files = c.files.filter((f) => f && typeof f.path === 'string' && f.path);
    if (!files.length) return frame(0, '<p class="rs-sub" role="status">No uncommitted changes</p>');
    const item = (f) => {
      const on = f.path === c.selected;
      const name = f.path.split(/[\\/]/).pop() || f.path;
      const n = f.binary ? 'bin' : `<i class="a">+${Number(f.added) || 0}</i> <i class="d">−${Number(f.deleted) || 0}</i>`;
      return `<button type="button" class="cf-item${on ? ' cf-on' : ''}" data-act="changes-file" data-path="${esc(f.path)}" aria-pressed="${on}" title="${esc(f.path)}"><span class="cv-st">${esc(f.status ?? '')}</span><span class="cf-name">${esc(name)}</span><span class="cf-n">${n}</span></button>`;
    };
    const more = files.length > FILES_MAX ? `<p class="rs-sub" role="status">and ${files.length - FILES_MAX} more</p>` : '';
    return frame(files.length, `<div class="cf-list" role="group" aria-label="Changed files">${files.slice(0, FILES_MAX).map(item).join('')}</div>${more}`);
  };
  const columnView = (ctx) => {
    const c = ctx && typeof ctx === 'object' ? ctx : {};
    const tasks = typeof c.tasksHtml === 'string' && c.tasksHtml ? `<section class="col-card col-tasks" aria-label="Tasks${c.name ? ` of ${esc(c.name)}` : ''}"><h3 class="col-title">Tasks</h3>${c.tasksHtml}</section>` : '';
    return `${tasks}${filesCard(c)}`;
  };
  // The state of the session (RPC2-1), shown inside the composer frame. Icon + word, never colour alone. c = { info, rpc } (rpc: what V.rpcReduce keeps).
  const SESS_TITLE = {
    loading: 'Loading the session', unknown: 'The session state is unknown', none: 'The session is not started: sending a message starts it', starting: 'The session is starting; this can take half a minute',
    free: 'The session is idle: you can write to it', working: 'The session is working', waiting: 'pi is asking something: answer it in the card of the chat',
  };
  const SESS_VIEW = {
    loading: ['gray', '○', 'Loading…'], unknown: ['gray', '?', 'Unknown'], none: ['gray', '○', 'Not started'], starting: ['yellow', '◌', 'Starting…'], free: ['gray', '○', 'Idle'],
    working: ['green', '●', 'Working…'], waiting: ['yellow', '◐', 'Asking you something'],
  };
  const SESS_OF = { closed: 'none', starting: 'starting', idle: 'free', busy: 'working', asking: 'waiting' };
  function sessionState(c) {
    const key = !c.info ? 'loading' : SESS_OF[c.rpc && c.rpc.state] || 'unknown'; // no rpc entry yet: the status read has not answered
    const [tone, icon, word] = SESS_VIEW[key];
    return { key, tone, icon, word, title: SESS_TITLE[key], animate: key === 'working' || key === 'starting' };
  }
  const sessionLabelHtml = (c) => {
    const s = sessionState(c);
    return `<span class="ss ss-${s.tone} ss-${s.key}${s.animate ? ' ss-anim' : ''}" role="status" title="${esc(s.title)}"><i class="ss-dot" aria-hidden="true">${s.icon}</i> ${s.word}</span>`;
  };

  // RP98: "Close session" stops the pi process of the repo and releases its adoption (the chat goes back to the list of sessions). It lives next to the session state in the composer frame (RP72 keeps the
  // chat header to the repo name and the ✕, which only hides the chat) and is there while the repo has a session: adopted or live.
  const sessionCloseHtml = (show, closing) => (show ? `<button type="button" class="ss-close" data-act="session-close"${closing ? ' disabled' : ''} title="Stop this session and go back to the list of sessions">Close session</button>` : '');

  // The header: the repo name (the session id is only its tooltip) and the close button.
  function chatHead(c, ctx = {}) {
    const adopted = c.info && c.info.adopted;
    const tip = adopted ? `${ctx.name} · ${adopted.id}` : ctx.name;
    // RP91: with the right column in (`ctx.column`) the tasks are its card, so the chat has no Tasks tab; where there is no column (under 1100 px) the tab stays.
    // RP90: ONE diff tab, the last one, named after the file open in it (`c.dfile`), with its own close button; without a file there is no tab and a "diff" tab reads as the chat.
    const dfile = typeof c.dfile === 'string' ? c.dfile : '';
    // RP92: with the column in, the files card replaces the Changes tab as well.
    const cur = dfile && c.tab === 'diff' ? 'diff' : ['tasks', 'changes', 'files', 'notes'].includes(c.tab) && !(ctx.column && (c.tab === 'tasks' || c.tab === 'changes')) ? c.tab : 'chat';
    const dname = dfile.split(/[\\/]/).pop() || dfile;
    const dtab = dfile ? `<span class="ch-dtab"><button type="button" role="tab" class="ch-tab" data-act="chat-tab" data-tab="diff" title="${esc(dfile)}" aria-selected="${cur === 'diff'}">${esc(dname)}</button><button type="button" class="ch-dclose" data-act="diff-close" aria-label="Close the diff of ${esc(dfile)}" title="Close the diff">✕</button></span>` : '';
    const tabs = [['chat', 'Chat'], ['tasks', 'Tasks'], ['changes', 'Changes'], ['files', 'Files'], ['notes', 'Notes']].filter(([t]) => !(ctx.column && (t === 'tasks' || t === 'changes'))).map(([t, label]) => `<button type="button" role="tab" class="ch-tab" data-act="chat-tab" data-tab="${t}" aria-selected="${cur === t}">${label}</button>`).join('');
    return `<div class="ch-row"><b class="ch-name" title="${esc(tip)}">${esc(ctx.name)}</b><button type="button" class="x" data-act="chat-close" aria-label="Close the chat" title="Close the chat (Esc)">✕</button></div><div class="ch-tabs" role="tablist" aria-label="Panel">${tabs}${dtab}</div>`;
  }

  // The Notes tab (RP93b, S8): the notepad of a repo (`.panel/notas.md`), one textarea and a status line apart so the page can repaint the status without touching the text.
  // Pure and total. n = { text, status: loading | unavailable | saved | saving | error | conflict, error, loaded }; no n reads as loading.
  const NOTES_STATUS = { saved: 'Saved', saving: 'Saving…' };
  function notesStatus(n) {
    const st = n && typeof n === 'object' ? n.status : '';
    const why = n && typeof n.error === 'string' && n.error ? ` (${esc(n.error)})` : '';
    if (st === 'error') return `Not saved${why} <button type="button" class="btn-sm" data-act="notes-retry">Retry</button>`;
    if (st === 'conflict') return 'The notes file changed outside the panel. <button type="button" class="btn-sm" data-act="notes-disk">Load the version on disk</button> <button type="button" class="btn-sm" data-act="notes-mine">Keep mine</button>';
    return NOTES_STATUS[st] || 'Saved';
  }
  function notesView(n) {
    const o = n && typeof n === 'object' && !Array.isArray(n) ? n : {};
    if (!o.loaded) {
      if (o.status === 'unavailable') return `<div class="empty" role="status">${esc(typeof o.error === 'string' && o.error ? o.error : 'Notes unavailable')}</div>`;
      return '<div class="empty" role="status">Loading notes…</div>';
    }
    return `<div class="notes"><textarea id="notesBox" class="notes-box" aria-label="Notes" spellcheck="false">${esc(o.text)}</textarea><div id="notesStatus" class="notes-status" role="status">${notesStatus(o)}</div></div>`;
  }

  // The Tasks tab (RP63, S60): the rows of the repo's ROADMAP (the /api/roadmap answer) grouped by state, the completed ones folded.
  // Pure and total: any shape of answer gives a string. ctx = { filter, openDone, loading, failed }.
  const TASK_MAX = 200;
  const TASK_GROUPS = [['review', 'In review'], ['ready', 'Ready'], ['progress', 'In progress'], ['next', 'Next'], ['pending', 'Pending'], ['blocked', 'Blocked'], ['done', 'Completed']];
  const TASK_OF = { 'En revisión': 'review', Lista: 'ready', 'En curso': 'progress', Pendiente: 'pending', Bloqueada: 'blocked', Completada: 'done' };
  function tasksView(rp, ctx = {}) {
    const note = (t) => `<div class="empty" role="status">${t}</div>`;
    if (!rp) return note(ctx.failed ? 'Roadmap unavailable' : 'Loading tasks…');
    if (!rp.available) return note(rp.reason === 'missing' ? 'No docs/ROADMAP.md in this repo' : 'Roadmap unavailable');
    const all = (Array.isArray(rp.rows) ? rp.rows : []).filter((r) => r && typeof r.id === 'string' && r.id && TASK_OF[r.estado]);
    const derived = rp.derived && typeof rp.derived === 'object' ? rp.derived : {};
    const byId = new Map(all.map((r) => [r.id, r]));
    const nextId = rp.next && typeof rp.next.id === 'string' ? rp.next.id : null;
    const q = String(ctx.filter ?? '').trim().toLowerCase();
    const box = `<input id="tasksFilter" type="search" class="task-filter" aria-label="Filter tasks" placeholder="Filter tasks…" value="${esc(ctx.filter ?? '')}">`;
    if (!all.length) return note('No tasks in the roadmap');
    const groups = new Map(TASK_GROUPS.map(([k]) => [k, []]));
    for (const r of all) {
      if (q && !`${r.id} ${r.entrega ?? ''}`.toLowerCase().includes(q)) continue;
      const d = derived[r.id];
      let key = TASK_OF[d && TASK_OF[d.state] ? d.state : r.estado];
      if (key === 'pending' && r.id === nextId) key = 'next';
      groups.get(key).push(r);
    }
    if (![...groups.values()].some((g) => g.length)) return `${box}${note('No task matches')}`;
    let left = TASK_MAX;
    let cut = 0;
    const rowHtml = (r, key) => {
      const d = derived[r.id] || {};
      const waits = (Array.isArray(r.dependsOn) ? r.dependsOn : []).filter((x) => byId.has(x) && byId.get(x).estado !== 'Completada');
      const bits = [];
      if (key === 'review' && Number.isFinite(d.pr)) bits.push(`PR #${d.pr}`);
      if (key === 'ready' && d.branch) bits.push(esc(d.branch));
      if (key === 'pending' && waits.length) bits.push(`waiting: ${waits.map(esc).join(', ')}`);
      if (key === 'blocked' && r.notas) bits.push(esc(String(r.notas).slice(0, 140)));
      const next = key === 'next';
      return `<div class="task-row${next ? ' task-next' : ''}"${next ? ' aria-current="true"' : ''}><span class="task-id mono">${esc(r.id)}</span><span class="task-text">${esc(r.entrega ?? '')}</span>${bits.length ? `<span class="task-bit">${bits.map((b) => `<span>${b}</span>`).join('')}</span>` : ''}</div>`;
    };
    const parts = [];
    for (const [key, title] of TASK_GROUPS) {
      const list = groups.get(key);
      if (!list.length) continue;
      if (key === 'done') {
        const open = !!ctx.openDone || !!q;
        parts.push(`<section class="task-group task-done"><button type="button" class="task-head" data-act="tasks-done" aria-expanded="${open}">${title} (${list.length})<span aria-hidden="true"> ${open ? '▾' : '▸'}</span></button>`);
        if (!open) { parts.push('</section>'); continue; }
      } else parts.push(`<section class="task-group"><h3 class="task-head">${title} (${list.length})</h3>`);
      for (const r of list) { if (left > 0) { parts.push(rowHtml(r, key)); left--; } else cut++; }
      parts.push('</section>');
    }
    if (cut) parts.push(`<div class="task-more rs-sub">+${cut} more</div>`);
    return `${box}${parts.join('')}`;
  }

  // The single code viewer (RP64, S62): the text of GET /api/diff as files with numbered lines. Pure and total: any input gives a list.
  // A row is { kind: 'c' context | 'a' added | 'd' deleted | 'h' hunk header | 'm' marker, old, new, text } (old and new are line numbers or null).
  function parseDiff(text) {
    if (typeof text !== 'string' || !text.trim()) return [];
    const files = [];
    let f = null;
    let inHunk = false;
    let o = 0;
    let n = 0;
    for (const ln of text.split('\n')) {
      if (ln.startsWith('diff --git ')) {
        const rest = ln.slice(11);
        const half = Math.floor((rest.length - 4) / 2);
        const same = rest.startsWith('a/') && rest.slice(2, 2 + half) === rest.slice(2 + half + 3) && rest.slice(2 + half, 2 + half + 3) === ' b/';
        const m = /^a\/(.+) b\/(.+)$/.exec(rest);
        f = { path: same ? rest.slice(2, 2 + half) : (m ? m[2] : rest), status: 'M', added: 0, deleted: 0, binary: false, note: '', lines: [] };
        files.push(f);
        inHunk = false;
        continue;
      }
      if (!f) continue;
      const h = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(ln);
      if (h && (!inHunk || ln.startsWith('@@ '))) { inHunk = true; o = Number(h[1]); n = Number(h[2]); f.lines.push({ kind: 'h', old: null, new: null, text: ln }); continue; }
      if (!inHunk) {
        if (ln.startsWith('new file')) f.status = 'A';
        else if (ln.startsWith('deleted file')) f.status = 'D';
        else if (/^Binary/.test(ln) || ln.startsWith('Binary or large')) { f.binary = true; f.note = ln; }
        continue;
      }
      const c = ln[0];
      if (c === ' ') f.lines.push({ kind: 'c', old: o++, new: n++, text: ln.slice(1) });
      else if (c === '-') { f.deleted++; f.lines.push({ kind: 'd', old: o++, new: null, text: ln.slice(1) }); }
      else if (c === '+') { f.added++; f.lines.push({ kind: 'a', old: null, new: n++, text: ln.slice(1) }); }
      else if (c === '\\') f.lines.push({ kind: 'm', old: null, new: null, text: ln });
    }
    return files;
  }

  // The Changes tab: the file list (a button per file) and the code with two number gutters. ctx = { selected, loading, failed }.
  const CODE_MAX = 2000;
  // RP66b: the syntax highlighter (highlight.js: a global in the page, a module in Node), looked up like view.js. Without it every row is painted as plain escaped text.
  const highlighter = () => { const h = typeof module === 'object' && module.exports ? require('./highlight.js') : root.RepoPanelHighlight; return h && h.languageOf && h.highlightLines ? h : null; };
  // The highlighted HTML of every row of one changed file, by index of `x.lines` (null: paint that row as plain text). The new side (context and added lines) and the old side (context and
  // deleted lines) are two separate streams per hunk, so a deleted `/*` never turns the added lines into a comment, and nothing carries over from one hunk to the next.
  function highlightDiff(x) {
    const h = highlighter();
    const lang = h ? h.languageOf(x.path) : null;
    if (!lang) return [];
    const out = [];
    let side = { n: [], o: [] };
    const flush = () => {
      for (const k of ['n', 'o']) {
        const html = h.highlightLines(side[k].map(([, t]) => t), lang);
        if (html) side[k].forEach(([i], j) => { if (k === 'n' || x.lines[i].kind === 'd') out[i] = html[j]; });
      }
      side = { n: [], o: [] };
    };
    x.lines.forEach((r, i) => {
      if (r.kind === 'h') flush();
      else if (r.kind === 'c') { side.n.push([i, r.text]); side.o.push([i, r.text]); }
      else if (r.kind === 'a') side.n.push([i, r.text]);
      else if (r.kind === 'd') side.o.push([i, r.text]);
    });
    flush();
    return out;
  }
  function changesView(data, ctx = {}) {
    const note = (t) => `<div class="empty" role="status">${t}</div>`;
    if (!data) return note(ctx.failed ? 'Changes unavailable' : 'Loading changes…');
    const files = parseDiff(data.diff);
    if (!files.length) return note('No uncommitted changes');
    const one = ctx.selected ? files.find((x) => x.path === ctx.selected) : null;
    // RP90: single-file mode (the diff tab): just that file, no list; a file that is not in the diff any more says so instead of showing the others.
    if (ctx.only && !one) return note(`${esc(ctx.selected ?? '')} has no uncommitted changes`);
    const shown = one ? [one] : files;
    const item = (x) => `<button type="button" class="cv-item${x === one ? ' cv-on' : ''}" data-act="changes-file" data-path="${esc(x.path)}" aria-pressed="${x === one}" title="${esc(x.path)}"><span class="cv-st">${x.status}</span><span class="cv-path">${esc(x.path)}</span>${x.binary ? '<span class="add">bin</span>' : `<span class="add">+${x.added}</span><span class="del">−${x.deleted}</span>`}</button>`;
    const list = ctx.only ? '' : `<div class="cv-list" role="group" aria-label="Changed files">${one ? '<button type="button" class="cv-all" data-act="changes-file" data-path="">All files</button>' : ''}${files.map(item).join('')}</div>`;
    let left = CODE_MAX;
    let cut = 0;
    const SIGN = { c: ' ', a: '+', d: '-', h: '', m: '' };
    const uni = (r, html) => `<div class="cv-l ${r.kind}"><span class="cv-n">${r.old ?? ''}</span><span class="cv-n">${r.new ?? ''}</span><span class="cv-t">${SIGN[r.kind]}${html}</span></div>`;
    // RP66c: one half of a side-by-side row (kind c context, d deleted, a added, e empty); the old number on the left, the new one on the right.
    const half = (side, kind, n, html) => `<div class="cv-half cv-h${side} ${kind}"><span class="cv-n">${n ?? ''}</span><span class="cv-t">${html}</span></div>`;
    const pair = (d, a, html) => `<div class="cv-s">${d ? half('l', 'd', d[1].old, SIGN.d + html(...d)) : half('l', 'e', '', '')}${a ? half('r', 'a', a[1].new, SIGN.a + html(...a)) : half('r', 'e', '', '')}</div>`;
    // Pairs the lines of each hunk: context on both sides; a group of deleted lines next to a group of added ones one by one, the rest alone; headers and markers stay full width.
    const sideBySide = (vis, html) => {
      const out = [];
      let dels = [];
      let adds = [];
      const flush = () => { for (let k = 0; k < Math.max(dels.length, adds.length); k++) out.push(pair(dels[k], adds[k], html)); dels = []; adds = []; };
      for (const e of vis) {
        const [i, r] = e;
        if (r.kind === 'd') dels.push(e);
        else if (r.kind === 'a') adds.push(e);
        else {
          flush();
          out.push(r.kind === 'c' ? `<div class="cv-s">${half('l', 'c', r.old, SIGN.c + html(i, r))}${half('r', 'c', r.new, SIGN.c + html(i, r))}</div>` : uni(r, esc(r.text)));
        }
      }
      flush();
      return out;
    };
    const sections = shown.map((x) => {
      const colored = highlightDiff(x);
      const html = (i, r) => colored[i] ?? esc(r.text);
      const vis = [];
      for (const [i, r] of x.lines.entries()) {
        if (left <= 0) { if (r.kind !== 'h') cut++; continue; }
        if (r.kind !== 'h') left--;
        vis.push([i, r]);
      }
      const rows = ctx.split ? sideBySide(vis, html) : vis.map(([i, r]) => uni(r, html(i, r)));
      return `<section class="cv-file"><h3 class="cv-title" title="${esc(x.path)}">${esc(x.path)}</h3>${x.note ? `<div class="cv-note rs-sub">${esc(x.note)}</div>` : ''}${rows.length ? `<div class="cv-code${ctx.split ? ' cv-split' : ''}">${rows.join('')}</div>` : ''}</section>`;
    }).join('');
    const bar = `<div class="cv-bar"><button type="button" class="cv-split-btn" data-act="diff-split" aria-pressed="${!!ctx.split}">Side by side</button></div>`;
    return `${bar}${list}${data.truncated ? '<div class="err">Diff truncated (too large).</div>' : ''}${sections}${cut ? `<div class="cv-more rs-sub">+${cut} more lines</div>` : ''}`;
  }

  // The Files tab (RP65, S62): the tree of files of the repo (GET /api/files) and the file read (GET /api/file) in the numbered-lines look of
  // the Changes viewer. ctx = { selected, open: { dir: bool }, changed: { path: letter }, loading, failed, fileLoading, fileFailed }; `file` is the
  // /api/file answer. A folder is open by default only when a changed file is inside it. Pure and total; every name and text goes through `esc`.
  const TREE_MAX = 1500;
  const MB = 1024 * 1024;
  const byName = (a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  function fileSection(file, ctx) {
    const note = (t) => `<div class="empty" role="status">${t}</div>`;
    const sel = ctx.selected;
    if (!sel) return note('Pick a file');
    if (ctx.fileFailed) return note(typeof ctx.fileFailed === 'string' ? esc(ctx.fileFailed) : 'File unavailable');
    if (!file || ctx.fileLoading || file.path !== sel) return note('Loading file…');
    const head = `<h3 class="cv-title" title="${esc(sel)}">${esc(sel)}</h3>`;
    const wrap = (inner) => `<section class="cv-file">${head}${inner}</section>`;
    if (file.binary) return wrap('<div class="cv-note rs-sub">Binary file, not shown</div>');
    if (file.tooLarge) return wrap(`<div class="cv-note rs-sub">File too large to show (${(num(file.size) / MB).toFixed(1)} MB)</div>`);
    if (typeof file.text !== 'string') return note('File unavailable');
    const lines = file.text.split('\n');
    if (lines[lines.length - 1] === '') lines.pop();
    if (!lines.length) return wrap('<div class="cv-note rs-sub">Empty file</div>');
    const marks = (Array.isArray(file.changed) ? file.changed : []).filter(Array.isArray).map(([s, n]) => [Math.floor(Number(s)), Math.floor(Number(n))]).filter(([s, n]) => s >= 1 && n >= 1);
    const hit = (i) => marks.some(([s, n]) => i >= s && i < s + n);
    const text = lines.map((ln) => ln.replace(/\r$/, ''));
    const h = highlighter();
    const colored = h && h.languageOf(sel) ? h.highlightLines(text, h.languageOf(sel)) : null;
    const rows = text.slice(0, CODE_MAX).map((ln, i) => `<div class="cv-l${hit(i + 1) ? ' e' : ''}"><span class="cv-n">${i + 1}</span><span class="cv-t">${colored ? colored[i] : esc(ln)}</span></div>`);
    return wrap(`<div class="cv-code">${rows.join('')}</div>${lines.length > CODE_MAX ? `<div class="cv-more rs-sub">+${lines.length - CODE_MAX} more lines</div>` : ''}`);
  }
  function filesView(tree, ctx = {}, file = null) {
    ctx = ctx && typeof ctx === 'object' ? ctx : {};
    const list = tree && Array.isArray(tree.files) ? tree.files.filter((f) => f && typeof f.path === 'string' && f.path) : null;
    if (!list) return `<div class="empty" role="status">${ctx.failed ? 'Files unavailable' : 'Loading files…'}</div>`;
    if (!list.length) return '<div class="empty" role="status">No files</div>';
    const changed = ctx.changed && typeof ctx.changed === 'object' ? ctx.changed : {};
    const folded = ctx.open && typeof ctx.open === 'object' ? ctx.open : {};
    const mark = (p) => (Object.hasOwn(changed, p) && typeof changed[p] === 'string' ? changed[p] : '');
    const root = { dirs: new Map(), files: [] };
    for (const f of list) {
      const parts = f.path.split('/');
      const name = parts.pop();
      const dirty = !!mark(f.path);
      let node = root;
      let at = '';
      for (const part of parts) {
        at = at ? `${at}/${part}` : part;
        if (!node.dirs.has(part)) node.dirs.set(part, { name: part, path: at, dirs: new Map(), files: [], dirty: false });
        node = node.dirs.get(part);
        if (dirty) node.dirty = true;
      }
      node.files.push({ name, path: f.path });
    }
    const out = [];
    let cut = 0;
    const emit = (html) => { if (out.length < TREE_MAX) out.push(html); else cut++; };
    const walk = (node, depth) => {
      for (const d of [...node.dirs.values()].sort(byName)) {
        const open = folded[d.path] === undefined ? d.dirty : folded[d.path] === true;
        emit(`<button type="button" class="ft-row ft-dir${d.dirty ? ' ft-chg' : ''}" style="--d:${depth}" data-act="files-dir" data-path="${esc(d.path)}" data-open="${open}" aria-expanded="${open}"><span aria-hidden="true">${open ? '▾' : '▸'}</span> ${esc(d.name)}</button>`);
        if (open) walk(d, depth + 1);
      }
      for (const f of node.files.sort(byName)) {
        const m = mark(f.path);
        const on = ctx.selected === f.path;
        emit(`<button type="button" class="ft-row ft-file${m ? ' ft-chg' : ''}${on ? ' ft-on' : ''}" style="--d:${depth}" data-act="files-open" data-path="${esc(f.path)}" aria-pressed="${on}" title="${esc(f.path)}"><span class="ft-name">${esc(f.name)}</span>${m ? `<span class="ft-mark">${esc(m)}</span>` : ''}</button>`);
      }
    };
    walk(root, 0);
    const tail = cut ? `<div class="cv-more rs-sub">+${cut} more</div>` : '';
    return `<div class="ft-tree" role="group" aria-label="Repository files">${out.join('')}${tail}</div>${fileSection(file, ctx)}`;
  }

  // The composer: can the person send free text now, and if not, why. c = { info, rpc, sending }. A session that is not started can be written to
  // (sending starts it); one that is starting, working or asking cannot. REASON words the same cases for the command menu (actionMenu).
  const REASON = {
    working: 'The session is working: wait until it is free', waiting: 'The session is asking you something: answer it in the card of the chat',
    none: 'No open session of this repo', unknown: 'The session state is unknown',
  };
  const COMPOSER_WAIT = {
    starting: 'The session is starting…', busy: 'The session is working: wait until it is idle, or press Stop',
    asking: 'pi is asking something: answer it in the card of the chat',
  };
  const rpcWait = (c) => (c.rpc && COMPOSER_WAIT[c.rpc.state]) || (!c.rpc ? REASON.unknown : '');
  function composerState(c, ctx = {}) {
    // RP99: with no session adopted (the list is in view) nothing can be sent: it would start and adopt a new session without telling. Open one or start a new one first.
    const reason = !c.info ? 'Loading the chat…' : !c.info.adopted ? 'Open a session or start a new one to write' : c.sending ? 'Sending…' : rpcWait(c);
    return { canSend: !reason, reason, placeholder: reason || `Message the session of ${ctx.name ?? 'this repo'}` };
  }

  // The message-box history (RP83, S3), like the prompt of pi: the texts the person sent to the session (the chat's own messages, then the
  // ones still pending), oldest first, without empty entries or one repeated right after itself. Pure and total.
  function inputHistory(items, pending) {
    const sent = [...(Array.isArray(items) ? items : []).filter((it) => it && it.role === 'user').map((it) => it.text), ...(Array.isArray(pending) ? pending : []).map((p) => p && p.text)];
    const out = [];
    for (const t of sent) if (typeof t === 'string' && t.trim() && out[out.length - 1] !== t) out.push(t);
    return out;
  }
  // One arrow key. `nav` is null when the person is not browsing, or { i, stash }: the position in `history` and the draft to give back.
  // Returns { nav, text } (the new position, null past the newest, and the text for the box) or null when the key has nothing to do.
  function historyStep(nav, key, current, history) {
    const h = Array.isArray(history) ? history : [];
    if (key === 'up') {
      if (!h.length) return null;
      if (!nav) return { nav: { i: h.length - 1, stash: String(current ?? '') }, text: h[h.length - 1] };
      const i = Math.max(0, Math.min(nav.i, h.length - 1) - 1);
      return { nav: { i, stash: nav.stash }, text: h[i] };
    }
    if (key === 'down' && nav) {
      const i = Math.min(nav.i, h.length - 1) + 1;
      return i < h.length ? { nav: { i, stash: nav.stash }, text: h[i] } : { nav: null, text: nav.stash };
    }
    return null;
  }
  // Up only acts on the first line of the box and Down on the last, with no selection: in the middle of a multi-line message the arrows move the cursor.
  const canRecall = (key, value, start, end) => typeof value === 'string' && Number.isInteger(start) && start === end
    && (key === 'up' ? !value.slice(0, start).includes('\n') : key === 'down' ? !value.slice(end).includes('\n') : false);

  // The "/ Actions" menu: always the four flow commands in a fixed order, each available or not with the reason. A deliver or
  // branch flow button (unstage, stash, disabled with a reason) takes the slot of its command. ctx = { live, changes, flow }.
  const SLOTS = [['flow-next', '/flow-next'], ['flow-commit', '/flow-commit'], ['flow-pr', '/flow-pr'], ['flow-base', '/flow-base']];
  function actionMenu(row, ctx = {}) {
    const items = SLOTS.map(([cmd, label]) => ({ cmd, label, available: false, why: '' }));
    const live = ctx.live || 'unknown';
    if (live !== 'free') {
      const why = REASON[live] || REASON.unknown;
      return { items: items.map((i) => ({ ...i, why })) };
    }
    if (!row || row.error) return { items: items.map((i) => ({ ...i, why: 'No data for this repo' })) };
    const kind = row.action ? row.action.kind : '';
    const ch = ctx.changes || {};
    const dirty = num(ch.files) > 0 || num(ch.ahead) > 0;
    items[0].available = kind === 'start' && !dirty;
    items[0].why = items[0].available ? `${row.next.id} — ${row.next.entrega ?? ''}` : kind === 'deliver' || dirty ? 'Deliver the current changes first' : !row.next ? 'No next unit to take' : 'Finish what is in progress first';
    items[1].why = 'No changes to commit';
    items[2].why = num(ch.files) > 0 ? 'Commit the changes first' : 'Nothing committed yet';
    items[3].why = 'The branch has not been merged yet';
    const f = ctx.flow;
    if (kind === 'branch' && !f) Object.assign(items[3], { available: true, why: 'Start a new cycle' });
    else if ((kind === 'deliver' || kind === 'branch') && f) {
      const slot = f.cmd.startsWith('flow-commit') ? 1 : f.cmd.startsWith('flow-pr') ? 2 : f.cmd.startsWith('flow-base') ? 3 : -1;
      if (slot >= 0) items[slot] = { cmd: f.cmd, label: f.label, available: !f.disabled, why: f.disabled ? f.reason || 'Not available right now' : '' };
    }
    return { items };
  }
  // RP85: the chat shows the commands that are available right now as direct buttons (the list the "/ Actions" menu used to hold, from
  // actionMenu). Nothing available draws nothing: the session state above the box already says why. `ctx.sending` disables them while an order is on its way.
  function actionButtonsHtml(menu, id, ctx = {}) {
    const items = menu && Array.isArray(menu.items) ? menu.items : [];
    return items.filter((i) => i && i.available).map((i) => `<button type="button" class="c-act" data-act="pi" data-id="${esc(id)}" data-cmd="${esc(i.cmd)}" title="${esc(i.why || `Send ${i.label} to the open session of this repo`)}"${ctx.sending ? ' disabled' : ''}>${esc(i.label)}</button>`).join('');
  }
  // The line under the box: a message (a refused send, a failed start).
  const composerNote = (n) => (n && n.text ? `<span>${esc(n.text)}</span>` : '');

  const hhmm = (iso) => { const d = new Date(iso); return iso && !Number.isNaN(d.getTime()) ? `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}` : ''; };
  // RP105: a chip per tool when the server sent `toolInfo` (✓/✗ or … while it runs, the name, the redacted argument, the time); without it, the line of names of before.
  const TOOL_CHIPS = 12;
  const fmtMs = (ms) => (!Number.isFinite(ms) ? '' : ms < 1000 ? `${Math.round(ms)}ms` : ms < 59950 ? `${(ms / 1000).toFixed(1)}s` : `${Math.floor(Math.round(ms / 1000) / 60)}m${String(Math.round(ms / 1000) % 60).padStart(2, '0')}s`);
  const chipHtml = (c) => {
    const [cls, mark] = c.ok === true ? ['ok', '✓'] : c.ok === false ? ['bad', '✗'] : ['run', '…'];
    const arg = typeof c.arg === 'string' && c.arg ? ` <i>${esc(c.arg)}</i>` : '';
    const time = fmtMs(c.ms) ? ` <small>${fmtMs(c.ms)}</small>` : '';
    return `<span class="tc ${cls}">${mark} <b>${esc(c.name)}</b>${arg}${time}</span>`;
  };
  const toolsLine = (t, info) => {
    const chips = (Array.isArray(info) ? info : []).filter((c) => c && typeof c === 'object' && typeof c.name === 'string');
    if (chips.length) return `<div class="tools tcs">${chips.slice(0, TOOL_CHIPS).map(chipHtml).join('')}${chips.length > TOOL_CHIPS ? `<span class="tcmore">+${chips.length - TOOL_CHIPS}</span>` : ''}</div>`;
    return toolsLineOld(t);
  };
  const toolsLineOld = (t) => (t.length ? `<div class="tools">▸ ${plural(t.length, 'tool')} · ${esc(t.slice(0, 3).join(', '))}${t.length > 3 ? ` (+${t.length - 3})` : ''}</div>` : '');
  // One chat message as safe HTML: escape first, then a small Markdown subset. Only the tags built here reach the output,
  // every scan is a single pass with indexOf (no backtracking regular expression), and unclosed markers stay plain text.
  const MD_URL = /^https?:\/\/[^\s"'<>`]+$/i;
  const MD_ITEM = /^(?:([-*])|\d+\.) (.*)$/;
  function mdClose(s, i, c, n) {
    const next = s[i + n];
    if (next === undefined || /\s/.test(next) || (n === 1 && next === c) || (c === '_' && /\w/.test(s[i - 1] || ''))) return -1;
    const m = c.repeat(n);
    for (let j = s.indexOf(m, i + n + 1); j > 0; j = s.indexOf(m, j + 1)) {
      if (/\s/.test(s[j - 1]) || (n === 1 && (s[j - 1] === c || s[j + 1] === c)) || (c === '_' && /\w/.test(s[j + 1] || ''))) continue;
      return j;
    }
    return -1;
  }
  function mdInline(s, d) {
    if (d > 3) return esc(s);
    let out = '';
    let i = 0;
    while (i < s.length) {
      const c = s[i];
      if (c === '`') {
        const j = s.indexOf('`', i + 1);
        if (j > i + 1) { out += `<code>${esc(s.slice(i + 1, j))}</code>`; i = j + 1; continue; }
      } else if (c === '*' || c === '_') {
        const n = c === '*' && s[i + 1] === '*' ? 2 : 1;
        const j = mdClose(s, i, c, n);
        if (j > 0) {
          const tag = n === 2 ? 'strong' : 'em';
          out += `<${tag}>${mdInline(s.slice(i + n, j), d + 1)}</${tag}>`;
          i = j + n;
        } else { out += esc(c.repeat(n)); i += n; }
        continue;
      } else if (c === '[') {
        const e = s.indexOf(']', i + 1);
        const k = e > i + 1 && s[e + 1] === '(' ? s.indexOf(')', e + 2) : -1;
        const url = k > 0 ? s.slice(e + 2, k) : '';
        if (MD_URL.test(url)) { out += `<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">${esc(s.slice(i + 1, e))}</a>`; i = k + 1; continue; }
      }
      out += esc(c);
      i++;
    }
    return out;
  }
  const mdFence = (l) => /^\s*```/.test(l);
  const mdQuote = (l, d) => d < 3 && (l === '>' || l.startsWith('> '));
  const mdStarts = (l, d) => mdFence(l) || /^#{1,6} /.test(l) || mdQuote(l, d) || MD_ITEM.test(l);
  function mdBlocks(text, d) {
    const lines = text.split('\n');
    const out = [];
    let i = 0;
    while (i < lines.length) {
      const l = lines[i];
      let m;
      if (!l.trim()) { i++; continue; }
      if (mdFence(l)) {
        const code = [];
        for (i++; i < lines.length && !mdFence(lines[i]); i++) code.push(lines[i]);
        i++;
        out.push(`<pre><code>${esc(code.join('\n'))}</code></pre>`);
      } else if ((m = /^(#{1,6}) (.*)$/.exec(l))) {
        const h = Math.min(m[1].length + 2, 5);
        out.push(`<h${h}>${mdInline(m[2], 0)}</h${h}>`);
        i++;
      } else if (mdQuote(l, d)) {
        const inner = [];
        for (; i < lines.length && mdQuote(lines[i], d); i++) inner.push(lines[i].slice(2));
        out.push(`<blockquote>${mdBlocks(inner.join('\n'), d + 1)}</blockquote>`);
      } else if ((m = MD_ITEM.exec(l))) {
        const tag = m[1] ? 'ul' : 'ol';
        const items = [];
        for (; i < lines.length && (m = MD_ITEM.exec(lines[i])) && (m[1] ? 'ul' : 'ol') === tag; i++) items.push(`<li>${mdInline(m[2], 0)}</li>`);
        out.push(`<${tag}>${items.join('')}</${tag}>`);
      } else {
        const para = [l];
        for (i++; i < lines.length && lines[i].trim() && !mdStarts(lines[i], d); i++) para.push(lines[i]);
        out.push(`<p>${para.map((x) => mdInline(x, 0)).join('<br>')}</p>`);
      }
    }
    return out.join('');
  }
  const mdHtml = (text) => (typeof text === 'string' ? mdBlocks(text.replace(/\r\n?/g, '\n'), 0) : '');

  // RP104: where the model reasoned the history shows «thinking…» (never the reasoning); an item that did not has no such line.
  const thoughtLine = (it) => (it.thinking === true ? '<div class="tools thought">▸ thinking…</div>' : '');
  // RP105b: a note after a turn that stopped or failed (only the two known categories draw), and a quiet line where the context was compacted.
  const STOP_NOTES = { aborted: '⏹ Turn stopped', error: '⚠ Turn failed' };
  const stopNote = (it) => (Object.hasOwn(STOP_NOTES, it.stop) ? `<div class="m stopnote ${it.stop}">${STOP_NOTES[it.stop]}</div>` : '');
  const bubble = (it, who) => {
    const time = hhmm(it.at);
    if (it.role === 'system') return it.kind === 'compaction' ? `<div class="sysnote">↻ Context compacted${time ? ` · ${time}` : ''}</div>` : '';
    if (it.role === 'assistant' && !it.text) return `${thoughtLine(it)}${toolsLine(it.tools, it.toolInfo)}${stopNote(it) || '<div class="m working">working…</div>'}`;
    return `${thoughtLine(it)}${toolsLine(it.tools || [], it.toolInfo)}<div class="m${it.role === 'user' ? ' me' : ''}"><span class="who">${esc(it.role === 'user' ? 'You' : who)}${time ? ` · ${time}` : ''}</span>${mdHtml(it.text)}</div>${stopNote(it)}`;
  };

  // Pending messages of the composer (RP75): shown after the real ones until the history has them. `base` is how many user items
  // had the same flattened text when it was sent; more of them now means the history holds it.
  const flat = (t) => String(t).replace(/\s+/g, ' ').trim();
  const userCount = (items, text) => items.filter((it) => it.role === 'user' && flat(it.text) === flat(text)).length;
  const PENDING_WHO = { sending: 'sending…', ok: '<span class="ok">✓</span>' };
  const pendingHtml = (pending, items) => (pending || []).filter((p) => userCount(items, p.text) <= p.base)
    .map((p) => `<div class="m me pending"><span class="who">You · ${PENDING_WHO[p.state] || PENDING_WHO.sending}</span>${mdHtml(p.text)}</div>`).join('');

  // What the live session adds under the history: the answer being written (escaped like every message) and one card per dialog pi waits for (RPC2-3).
  // The card is how the person answers a PERMISSION, so: everything is escaped, the message (the FULL command) is shown whole, Deny comes first, and
  // the Allow of a confirm (or an option of an «Allow…» select) is NOT offered when the text may be cut or is not shown (RP81): then only the
  // refusing answers remain. There is no «Allow always» and no key that answers; every answer is a click.
  const CUT_NOTE = 'The command is cut or not shown: answer it in the terminal';
  // Only what the person can SEE counts: letters, numbers, punctuation, symbols, spaces and spacing marks, plus LF and TAB. Everything else (controls, zero-width,
  // bidi, combining marks and variation selectors, unassigned and private-use characters) is hidden: a whitelist by category, so no list of "bad characters"
  // has to be complete. A hidden character is SHOWN as a marker (⟦U+200B⟧) and a text that has one is never approved: what is read is not what the agent
  // runs. The blank fillers are letters or symbols by category and are listed on their own.
  const HIDDEN = /[^\p{L}\p{N}\p{P}\p{S} \p{Mc}\n\t]|[\u115f\u1160\u3164\uffa0\u2800\u{1d159}\ufffc]/gu;
  const hasHidden = (t) => typeof t === 'string' && t.search(HIDDEN) >= 0;
  const visible = (t) => String(t == null ? '' : t).replace(HIDDEN, (ch) => `⟦U+${ch.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}⟧`);
  // «Allow…» read through invisibles and width (NFKC): a title that only looks different is still a permission.
  const allowTitle = (d) => d.method === 'select' && /^\s*allow/i.test(String(d.title == null ? '' : d.title).normalize('NFKC').replace(HIDDEN, ''));
  // The text is whole when it has something visible, no hidden character, and does not end in an ellipsis or dots (also the lookalikes and spaced dots:
  // «. . .»). A command that really ends in «..» is refused too: the safe answer is to read it in the terminal.
  function wholeText(m) {
    if (typeof m !== 'string' || hasHidden(m)) return false;
    const t = m.replace(/[\s\p{Mc}]+/gu, '');
    return t !== '' && !/[\u2026\u2025\u22ef\ufe19\u22ee\u205d\u2d48\u1365]$|[.\uff0e\u2024\u3002\u00b7]{2,}$/u.test(t);
  }
  // Whether the card may offer an approval. A confirm needs the server not to have cut it and the whole text. A select is never answerable when it is cut or
  // shows hidden characters; an «Allow…» select also needs the whole text; any other select is a plain question.
  function askAllowed(d) {
    if (!d || typeof d !== 'object') return false;
    if (d.method === 'confirm') return d.truncated !== true && wholeText(d.message);
    if (d.method === 'select') {
      if (d.truncated === true || hasHidden(d.title) || (Array.isArray(d.options) ? d.options : []).some((o) => hasHidden(o))) return false;
      return allowTitle(d) ? wholeText(d.message) : true;
    }
    return true;
  }
  function askCard(d, repo, busy) {
    const at = `data-act="rpc-answer" data-id="${esc(repo)}" data-request="${esc(d.requestId)}"`;
    const btn = (label, extra, tone) => `<button type="button" class="ask-btn ask-${tone}" ${at} ${extra}${busy ? ' disabled' : ''}>${esc(label)}</button>`;
    const ok = askAllowed(d);
    const field = d.method === 'editor' ? '<textarea class="ask-field" rows="5" maxlength="4000"></textarea>' : '<input type="text" class="ask-field" maxlength="4000">';
    let controls;
    if (d.method === 'confirm') controls = btn('Deny', 'data-kind="deny"', 'negative') + (ok ? btn('Allow', 'data-kind="allow"', 'affirmative') : '');
    else if (d.method === 'select') controls = (ok ? (Array.isArray(d.options) ? d.options : []).map((o, i) => btn(visible(o), `data-kind="option" data-index="${i}"`, 'affirmative')).join('') : '') + btn('Cancel', 'data-kind="cancel"', 'negative');
    else controls = field + btn('Send', 'data-kind="send"', 'affirmative') + btn('Cancel', 'data-kind="cancel"', 'negative');
    return `<div class="ch-ask" role="alert"><div class="ch-ask-title">${esc(visible(d.title) || 'The session is asking')}</div>${d.message ? `<pre class="ch-ask-text">${esc(visible(d.message))}</pre>` : ''}<div class="ch-ask-btns">${controls}</div>${ok ? '' : `<div class="ch-ask-warn" role="status">${CUT_NOTE}</div>`}</div>`;
  }
  function rpcTail(c, who) {
    const r = c.rpc && typeof c.rpc === 'object' ? c.rpc : {};
    const streaming = r.text ? `<div class="m streaming"><span class="who">${esc(who)}</span>${mdHtml(r.text)}</div>` : r.streaming ? `<div class="m working">${r.thinking ? 'thinking…' : 'working…'}</div>` : '';
    const asks = (Array.isArray(r.asks) ? r.asks : []).filter((d) => d && typeof d.requestId === 'string').map((d) => askCard(d, c.id, !!(c.askBusy && c.askBusy[d.requestId]))).join('');
    return streaming + asks;
  }

  // RP100 (S5, S7): pi does not lock its session files, so the panel cannot see that a session is open in a terminal. The hint it has is the last write of the session file (`updatedAt`): written to less
  // than 2 minutes ago, either side of now (a clock a little ahead still counts; a date far ahead must not warn forever). A terminal that is open but quiet is not detected: a hint, not a guarantee.
  const RECENT_MS = 2 * 60 * 1000;
  function recentlyActive(s, now) {
    if (!s || typeof s.updatedAt !== 'string' || !Number.isFinite(now)) return false;
    const t = Date.parse(s.updatedAt);
    return Number.isFinite(t) && Math.abs(now - t) < RECENT_MS;
  }

  function chatBody(c, ctx = {}) {
    const info = c.info;
    if (!info) return `<div class="empty" role="status">${c.failed ? 'Chat unavailable. Try again in a moment.' : 'Loading chat…'}</div>`;
    const note = c.failed ? '<div class="rs-note" role="status">⚠ Chat unavailable: showing the last data we have.</div>' : '';
    const id = esc(c.id);
    if (!info.adopted) {
      const rows = (Array.isArray(info.sessions) ? info.sessions : []).slice(0, 20).map((s) => `<div class="ch-pick"><div class="ch-pick-l1"><span class="mono ch-sname" title="${esc(s.id)}">${esc(s.name || s.id)}</span><span class="rs-sub">${esc(relativeTime(s.updatedAt, ctx.now))}</span>${recentlyActive(s, ctx.now) ? '<span class="ch-busy" title="This session was written to less than 2 minutes ago">Active a moment ago, it may be open in a terminal</span>' : ''}<button type="button" data-act="chat-adopt" data-id="${id}" data-session="${esc(s.id)}"${recentlyActive(s, ctx.now) ? ' data-recent="1"' : ''}${c.starting ? ' disabled' : ''}>Open</button></div>${s.lastMessage ? `<div class="rs-sub ch-last">${esc(clip(s.lastMessage.text, 90))}</div>` : ''}</div>`).join('');
      return `${note}<div class="ch-state"><p>No session is adopted for this folder.${rows ? ' Open one, or start a new one.' : ''}</p>${rows ? `<div class="ch-picks">${rows}</div>` : ''}<button type="button" data-act="chat-start" data-id="${id}"${c.starting ? ' disabled' : ''}>New session</button></div>`;
    }
    const who = info.adopted.name || info.adopted.id;
    if (!info.adoptedFound) return `${note}<div class="ch-state" role="status"><p>The session is loading. The history appears with its first message.</p></div>${pendingHtml(c.pending, [])}${rpcTail(c, who)}`;
    const items = (c.hist && c.hist.items) || [];
    const pending = pendingHtml(c.pending, items);
    return `${note}${c.hist && c.hist.truncated ? '<div class="rs-sub ch-older">Older messages are not shown</div>' : ''}${items.map((it) => bubble(it, who)).join('') || (pending ? '' : '<div class="empty">No messages yet.</div>')}${pending}${rpcTail(c, who)}`;
  }

  // Pinned room card (not clickable yet): the aggregate of its member rows (a room has no session state any more).
  function roomCard(room, rows, ctx) {
    const mine = rows.filter((r) => r.room === room.name);
    const sum = { total: null, completada: 0, enRevision: 0, bloqueada: 0, pendiente: 0, enCurso: 0 };
    for (const r of mine) {
      const p = r.progress;
      if (!p || p.total === null || p.total === undefined) continue;
      sum.total = num(sum.total) + num(p.total);
      for (const k of ['completada', 'enRevision', 'bloqueada', 'pendiente', 'enCurso']) sum[k] += num(p[k]);
    }
    const need = mine.filter((r) => r.needs).length;
    return `<article class="rs-card rs-room" aria-label="Room ${esc(room.name)}">
      <div class="rs-l1"><b class="rs-name" title="${esc(room.name)}">★ ${esc(room.name)}</b><span class="chip purple">room</span><span class="rs-spacer"></span><span class="rs-sub">last commit ${esc(relativeTime(room.lastCommit, ctx.now))}</span></div>
      <div class="rs-l2">${progressHtml(sum)}<div class="rs-next"><span class="rs-sub">${plural(mine.length, 'project')} · ${need} need attention</span></div></div>
    </article>`;
  }

  // RP94b: the legend is behind a "?" (a native details element: no script, it opens with the keyboard too).
  const LEGEND = '<details class="rs-legend"><summary title="Bar legend" aria-label="Bar legend">?</summary><div class="rs-legend-body"><span><i class="rs-key rs-done"></i>Completed</span><span><i class="rs-key rs-pr"></i>In review</span><span><i class="rs-key rs-blk"></i>Blocked</span><span><i class="rs-key rs-pend"></i>Pending</span><span>The button on the right is the best next action</span></div></details>';

  // The view-specific part of the view bar: the one Needs attention toggle (the button sets the value it is NOT in); it sits next to the scope buttons (RP82).
  function summaryTools(payload, ctx = {}) {
    if (!payload || !Array.isArray(payload.rows)) return '';
    const attention = ctx.filter === 'attention';
    const n = visibleRows(payload.rows, ctx).filter((r) => r.needs).length;
    return `<button type="button" data-act="sfilter" data-filter="${attention ? 'all' : 'attention'}" aria-pressed="${attention}">Needs attention · ${n}</button>`;
  }

  // ctx: { now, scope, rooms, q, group, roomData, filter, collapsed, failed, flowFor(id), changesFor(id), sending, busy }
  function summaryView(payload, ctx = {}) {
    if (!payload || !Array.isArray(payload.rows)) {
      return `<div class="empty" role="status">${ctx.failed ? 'Summary unavailable. Is the panel server up to date? Try Refresh.' : 'Loading summary…'}</div>`;
    }
    const scope = normalizeScope(ctx.scope, ctx.rooms);
    const rows = visibleRows(payload.rows, ctx);
    const needing = rows.filter((r) => r.needs);
    const attention = ctx.filter === 'attention';
    let body;
    if (attention) {
      // Most urgent first; Array#sort is stable, so ties keep the payload order.
      body = needing.length ? needing.slice().sort((x, y) => num(x.rank) - num(y.rank)).map((r) => cardHtml(r, ctx)).join('') : '<div class="empty">Nothing needs your attention right now.</div>';
    } else {
      const rooms = ctx.roomData && Array.isArray(ctx.roomData.rooms) && scope.kind !== 'none' && !ctx.q && !(ctx.group && ctx.group !== 'all') ? ctx.roomData.rooms.filter((m) => scope.kind === 'all' || m.name === scope.name) : [];
      const groups = new Map();
      for (const r of rows) groups.set(r.group ?? '', (groups.get(r.group ?? '') || []).concat(r));
      const parts = rooms.map((m) => roomCard(m, payload.rows, ctx));
      for (const [g, list] of groups) {
        const shut = groups.size > 1 && !!(ctx.collapsed && ctx.collapsed[g]);
        if (groups.size > 1) parts.push(`<button type="button" class="rs-group" data-act="toggle-group" data-group="${esc(g)}" aria-expanded="${!shut}"><span aria-hidden="true">${shut ? '▸' : '▾'}</span> ${esc(g)} <span class="mono">${list.length}</span></button>`);
        if (!shut) for (const r of list) parts.push(cardHtml(r, ctx));
      }
      body = rows.length ? parts.join('') : '<div class="empty">No repositories in this scope.</div>';
    }
    return `${ctx.failed ? '<div class="rs-note" role="status">⚠ Summary unavailable: showing the last data we have.</div>' : ''}<div class="rs-list">${body}</div>${rows.length ? LEGEND : ''}`;
  }

  return { esc, mdHtml, sessionChip, blockWidths, columnView, composerState, askAllowed, actionMenu, actionButtonsHtml, composerNote, chatHead, notesView, notesStatus, tasksView, parseDiff, changesView, filesView, inputHistory, historyStep, canRecall, sessionState, sessionLabelHtml, sessionCloseHtml, recentlyActive, chatBody, userCount, normalizeScope, filterRows, relativeTime, scopeBar, summaryView, summaryTools, visibleRows };
}));
