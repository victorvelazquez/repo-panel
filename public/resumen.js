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

  const normalizeScope = (scope, rooms) => {
    if (scope && scope.kind === 'none') return { kind: 'none' };
    if (scope && scope.kind === 'room' && (rooms || []).some((r) => r.name === scope.name)) return { kind: 'room', name: scope.name };
    return ALL;
  };
  const filterRows = (rows, scope) => rows.filter((r) => (scope.kind === 'room' ? r.room === scope.name : scope.kind === 'none' ? !r.room : true));
  // The rows the Summary shows: the scope, then the shared text and group filters (empty or "all" is no filter).
  // RP158: with `ctx.live === true` (only the boolean) the repos whose session is NOT started or was closed (`none`) go out; what is not known (unknown, loading, no session, any other value) stays: a session that finished its
  // cycle is `free`, still open, and it must not disappear.
  const isLive = (r) => !r.session || r.session.state !== 'none';
  const visibleRows = (rows, ctx) => {
    const q = String(ctx.q || '').toLowerCase();
    const group = ctx.group && ctx.group !== 'all' ? ctx.group : '';
    return filterRows(rows, normalizeScope(ctx.scope, ctx.rooms)).filter((r) => (!group || r.group === group) && (!q || String(r.name).toLowerCase().includes(q)) && (ctx.live !== true || isLive(r)));
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
  // RP169: the card draws the chip of the chat (sessionLabelHtml) from the LIVE state of the page (ctx.liveFor); only a page with none for the repo falls back to the row of the server.
  const ROW_RPC = { working: 'busy', waiting: 'asking', free: 'idle', none: 'closed' };
  function sessionChip(r, ctx) {
    const live = ctx.liveFor ? ctx.liveFor(r.id) : null;
    const known = (st) => typeof st === 'string' && Object.hasOwn(SESS_OF, st);
    const rowState = r.session && typeof r.session === 'object' ? r.session.state : undefined;
    const rpc = live && typeof live === 'object' && known(live.state) ? live
      : { state: typeof rowState === 'string' && Object.hasOwn(ROW_RPC, rowState) ? ROW_RPC[rowState] : undefined };
    return sessionLabelHtml({ info: true, rpc });
  }

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
    // RP159: the buttons that talk to the session are held while it works, not only while the order is on its way. The page says it (`ctx.holdFor`, from the live session); a page that does not have it asks the row of the server.
    const rowJobs = r.session && Number.isSafeInteger(r.session.jobs) && r.session.jobs > 0 ? `${Math.min(r.session.jobs, 99)} background job${r.session.jobs === 1 ? ' is' : 's are'} running` : ''; // RP163: the number the server left in the row
    const rowWorking = r.session && r.session.state === 'working' ? 'The session is working: wait for it to finish' : rowJobs;
    const held = (ctx.holdFor ? String(ctx.holdFor(r.id) || '') : rowWorking) || (sending ? 'Sending the order to the session' : '');
    const heldAttr = held ? ' disabled' : '';
    if (r.error) return open('Open');
    if (!a) return '';
    if (a.kind === 'merge') return `<button class="merge" data-act="merge" data-id="${id}" data-n="${esc(a.pr)}" title="Merge #${esc(a.pr)}" aria-label="Merge #${esc(a.pr)}"${ctx.busy && ctx.busy[`${r.id}:${a.pr}`] ? ' disabled' : ''}>${esc(clip(`Merge #${a.pr}`, LABEL_MAX))}</button>`;
    if (a.kind === 'branch') return `<button class="primary" data-act="pi" data-id="${id}" data-cmd="flow-base" title="${esc(held || 'Send /flow-base to the open session of this repo')}"${heldAttr}>/flow-base</button>`;
    if (a.kind === 'start') return `<button class="primary" data-act="pi" data-id="${id}" data-cmd="flow-next" title="${esc(held || `Send /flow-next to the open session of this repo (starts ${r.next ? r.next.id : ''})`)}"${heldAttr}>/flow-next</button>`;
    if (a.kind === 'deliver') {
      const f = ctx.flowFor ? ctx.flowFor(r.id) : null;
      return f
        ? `<button class="primary" data-act="pi" data-id="${id}" data-cmd="${esc(f.cmd)}" title="${esc(held || f.reason || `Send /${f.cmd} to the open session of this repo`)}"${f.disabled || held ? ' disabled' : ''}>${esc(f.label)}</button>`
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
      meta: `<span class="rs-sub rs-when" title="${esc(lm.what ?? '')}">${esc(relativeTime(lm.at, ctx.now))}</span>${r.error ? '<span class="chip red">▲ error</span>' : sessionChip(r, ctx)}`,
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
  // RP136: with `list: false` (the duo of 760 to 1100 px, where the list is out of the screen) the list takes no room: the chat and the column share the whole width, the column with its saved share or 40%, and the chat keeps 340.
  function blockWidths(total, ratios, { column = true, list: listIn = true } = {}) {
    if (typeof total !== 'number' || !Number.isFinite(total) || total <= 0) return { list: 0, chat: 0, col: 0 };
    const t = Math.floor(total);
    const r = ratios && typeof ratios === 'object' && !Array.isArray(ratios) ? ratios : {};
    if (!listIn) {
      const col = t < CHAT_MIN + COL_MIN ? Math.floor(t * 0.4) : within(Math.round(t * share(r.col, 0.4)), COL_MIN, t - CHAT_MIN);
      return { list: 0, chat: t - col, col };
    }
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
  // RP128 (S20, S21): the right column is TABS (design D of RP127): Changes and Tasks for now. A tab with nothing to show is not drawn (Status comes with RP129, Files and Notes with RP130).
  // Only the open tab shows its name (the CSS), the others are icons. `tab` is what the page keeps for the opening; anything else reads as Changes. Changes is a TREE by folders of the files with
  // uncommitted changes (`files`, the board's facts: path, status, added, deleted): a chain of single folders is ONE row, folders come first, each has a count and the total is on top; each file is the
  // button that opens it in the diff tab (`selected` marks the one open there) and `fold` ({path: true}) holds the closed folders. Tasks is `tasksHtml`, the compact answer of R.tasksView. Total.
  const COLUMN_TABS = ['tasks', 'changes', 'status', 'files']; // RP148: the order of the cycle (what to do, do it, deliver it) and Files last, as a look-up
  const ROOM_COLUMN_TABS = ['members', 'changes', 'status', 'files']; // RP220: the tabs of the column of a ROOM (the arrows of the keyboard walk this list there): Projects (id members) first, no Tasks (a room carries no roadmap)
  const FILES_MAX = 200;
  const TREE_DEPTH_MAX = 8;
  const svgIcon = (d, s = 14) => `<svg width="${s}" height="${s}" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
  const ICON_TAB = {
    changes: svgIcon('<circle cx="8" cy="8" r="2"/><path d="M8 2v4M8 10v4M2 8h4M10 8h4"/>', 16),
    files: svgIcon('<path d="M2 4.5A1.5 1.5 0 0 1 3.5 3h2.6l1.4 1.5h5A1.5 1.5 0 0 1 14 6v5.5a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 11.5z"/>', 16),
    tasks: svgIcon('<path d="M3 4.5l1.3 1.3L7 3.2M3 10.5l1.3 1.3L7 9.2M9.5 5h3.5M9.5 11h3.5"/>', 16),
    status: svgIcon('<circle cx="4" cy="3.5" r="1.6"/><circle cx="4" cy="12.5" r="1.6"/><circle cx="12" cy="12.5" r="1.6"/><path d="M4 5.1v5.8M12 10.9V7a2 2 0 0 0-2-2H8"/>', 16),
    notes: svgIcon('<path d="M4 2.5h6l2.5 2.5v8.5H4z"/><path d="M10 2.5V5h2.5M6 8h4M6 10.5h4"/>', 16),
    members: svgIcon('<rect x="2.5" y="2.5" width="4.5" height="4.5" rx="1"/><rect x="9" y="2.5" width="4.5" height="4.5" rx="1"/><rect x="2.5" y="9" width="4.5" height="4.5" rx="1"/><rect x="9" y="9" width="4.5" height="4.5" rx="1"/>', 16), // RP220: the Projects tab of a room (its id stays `members`, the word of the model)
  };
  const ICON_DIR = svgIcon('<path fill="currentColor" d="M2 4.5A1.5 1.5 0 0 1 3.5 3h2.6l1.4 1.5h5A1.5 1.5 0 0 1 14 6v5.5a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 11.5z"/>');
  const ICON_FILE = svgIcon('<path d="M4 2h5l3 3v8.5a.5.5 0 0 1-.5.5h-7a.5.5 0 0 1-.5-.5z"/><path d="M9 2v3h3"/>');
  const validFiles = (files) => (Array.isArray(files) ? files.filter((f) => f && typeof f.path === 'string' && f.path) : null);
  const treeByName = (a, b) => {
    const x = a.name.toLowerCase();
    const y = b.name.toLowerCase();
    return x < y ? -1 : x > y ? 1 : a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
  };
  // The files as a tree of folders: { name, path, dirs: Map, files: [{ name, f }], count } (count: the files under it). Either slash groups a path; `f.path` keeps its own text to open the diff.
  function fileTree(files) {
    const root = { name: '', path: '', dirs: new Map(), files: [], count: 0 };
    for (const f of files) {
      const parts = f.path.replace(/\\/g, '/').split('/').filter(Boolean);
      const name = parts.pop();
      if (!name) continue;
      let node = root;
      for (const p of parts) {
        let child = node.dirs.get(p);
        if (!child) { child = { name: p, path: node.path ? `${node.path}/${p}` : p, dirs: new Map(), files: [], count: 0 }; node.dirs.set(p, child); }
        child.count++;
        node = child;
      }
      node.files.push({ name, f });
    }
    return root;
  }
  // A folder with no file of its own and a single folder inside is shown as ONE row ("odd/tasks"): follow the chain to its end.
  const chainOf = (d) => {
    let label = d.name;
    while (!d.files.length && d.dirs.size === 1) { d = d.dirs.values().next().value; label += `/${d.name}`; }
    return { d, label };
  };
  function treeRows(node, depth, c, out) {
    const dd = Math.min(depth, TREE_DEPTH_MAX);
    for (const child of [...node.dirs.values()].sort(treeByName)) {
      const { d, label } = chainOf(child);
      const closed = !!c.fold && Object.hasOwn(c.fold, d.path) && c.fold[d.path] === true;
      out.push(`<button type="button" class="cf-dir cf-d${dd}" data-act="col-folder" data-path="${esc(d.path)}" aria-expanded="${!closed}"><span class="cf-ch" aria-hidden="true">${closed ? '▸' : '▾'}</span><span class="cf-ic" aria-hidden="true">${ICON_DIR}</span><span class="cf-name">${esc(label)}</span><span class="cf-n">${d.count}</span></button>`);
      if (!closed) treeRows(d, depth + 1, c, out);
    }
    for (const { name, f } of node.files.sort(treeByName)) {
      const on = f.path === c.selected;
      const st = String(f.status ?? '');
      const n = f.binary ? 'bin' : `<i class="a">+${Number(f.added) || 0}</i> <i class="d">−${Number(f.deleted) || 0}</i>`;
      out.push(`<button type="button" class="cf-item${on ? ' cf-on' : ''} cf-d${dd}" data-act="changes-file" data-path="${esc(f.path)}" aria-pressed="${on}" title="${esc(f.path)}"><span class="cf-ch" aria-hidden="true"></span><span class="cf-ic" aria-hidden="true">${ICON_FILE}</span><span class="cf-name">${esc(name)}</span><span class="cf-n">${n}</span><span class="cf-st st-${esc(st)}">${esc(st)}</span></button>`);
    }
  }
  // The paths of the folder rows the tree of this list has (the ones a button can fold): the page uses it to ignore a path that is not one of them.
  function treeFolderPaths(files) {
    const valid = validFiles(files);
    const out = [];
    const walk = (node) => { for (const child of node.dirs.values()) { const { d } = chainOf(child); out.push(d.path); walk(d); } };
    if (valid) walk(fileTree(valid.slice(0, FILES_MAX)));
    return out;
  }
  const changesPanel = (c, files) => {
    if (!files) return `<p class="rs-sub" role="status">${c.failed ? 'Files unavailable' : 'Loading files…'}</p>`;
    if (!files.length) return '<p class="rs-sub" role="status">No uncommitted changes</p>';
    const added = files.reduce((a, f) => a + (f.binary ? 0 : Number(f.added) || 0), 0);
    const deleted = files.reduce((a, f) => a + (f.binary ? 0 : Number(f.deleted) || 0), 0);
    const rows = [];
    treeRows(fileTree(files.slice(0, FILES_MAX)), 0, c, rows);
    const more = files.length > FILES_MAX ? `<p class="rs-sub" role="status">and ${files.length - FILES_MAX} more</p>` : '';
    return `<div class="col-sum"><b>${files.length} file${files.length === 1 ? '' : 's'}</b> <span class="a">+${added}</span> <span class="d">−${deleted}</span></div><div class="cf-tree" role="group" aria-label="Files with changes${c.name ? ` of ${esc(c.name)}` : ''}">${rows.join('')}</div>${more}`;
  };
  // RP129 (S20, S21): the FOOTER of the column and its STATUS tab. Both come from `ctx.git` ({ id, branch, ahead, pr, merge, rerun, noPr }), which the page builds: the PR is the open one of THIS branch (never
  // another one), and `merge` and `rerun` are what view.js decides for the two buttons (the ONE rule of the card of the board), so nothing is decided here: the buttons are drawn as they come and they are the
  // same actions of the cards (data-act merge and rerun). Without `git` there is neither footer nor Status tab. Total: nothing the PR or the repo says becomes markup, and only a plain http(s) link is a link.
  const ICON_CK = {
    success: svgIcon('<circle cx="8" cy="8" r="6"/><path d="M5.2 8.2l2 2 3.6-4"/>'),
    pending: svgIcon('<circle cx="8" cy="8" r="6" stroke-dasharray="3 2.2"/>'),
    failed: svgIcon('<circle cx="8" cy="8" r="6"/><path d="M6 6l4 4M10 6l-4 4"/>'),
  };
  const MB_END = { // RP228: how the last task of a free member ended: an icon and a word (colour is never the only signal)
    done: { word: 'Finished', icon: ICON_CK.success, said: 'finished' },
    failed: { word: 'Failed', icon: ICON_CK.failed, said: 'failed' },
    stopped: { word: 'Stopped', icon: svgIcon('<circle cx="8" cy="8" r="6"/><rect x="6" y="6" width="4" height="4" rx="0.5"/>'), said: 'was stopped' },
  };
  const CK_STATES = ['success', 'pending', 'failed'];
  const CK_WORD = { success: 'Successful', pending: 'In progress', failed: 'Failed' };
  const CK_SUM = { pending: 'pending', failed: 'failed', success: 'passed' };
  const CHECKS_MAX = 50;
  const gitOf = (c) => (c.git && typeof c.git === 'object' && !Array.isArray(c.git) ? c.git : null);
  const prOf = (g) => (g.pr && typeof g.pr === 'object' && !Array.isArray(g.pr) && Number.isInteger(g.pr.number) ? g.pr : null);
  const checksOf = (pr) => {
    const k = pr && pr.checks && typeof pr.checks === 'object' ? pr.checks : {};
    return { state: CK_STATES.includes(k.state) ? k.state : 'none', total: num(k.total), passed: num(k.passed), failed: num(k.failed), pending: num(k.pending), items: Array.isArray(k.items) ? k.items : [] };
  };
  const statusPanel = (g) => {
    const pr = prOf(g);
    if (!pr) return `<p class="rs-sub" role="status">${esc(typeof g.noPr === 'string' && g.noPr ? g.noPr : 'No open pull request for this branch')}</p>`;
    const k = checksOf(pr);
    const link = (url, cls, attrs, text) => (MD_URL.test(String(url)) ? `<a class="${cls}" href="${esc(url)}" target="_blank" rel="noopener noreferrer"${attrs}>${text}</a>` : '');
    const number = link(pr.url, 'st-n', '', `#${pr.number}`) || `<span class="st-n">#${pr.number}</span>`;
    const state = pr.isDraft ? '<span class="chip gray">draft</span>' : '<span class="chip green">open</span>';
    const review = pr.reviewDecision === 'REVIEW_REQUIRED' ? '<span class="chip yellow">review required</span>' : pr.reviewDecision === 'CHANGES_REQUESTED' ? '<span class="chip red">changes requested</span>' : '';
    const fin = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0;
    const size = [];
    if (fin(pr.additions) && fin(pr.deletions)) size.push(`+${pr.additions} −${pr.deletions}`);
    if (fin(pr.changedFiles)) size.push(`${pr.changedFiles} file${pr.changedFiles === 1 ? '' : 's'}`);
    const meta = `${esc(pr.head ?? '')} → ${esc(pr.base ?? '')}${size.length ? ` · ${size.join(' · ')}` : ''}`;
    const count = { pending: k.pending, failed: k.failed, success: k.passed };
    const sum = k.total ? `<div class="ck-sum">${['pending', 'failed', 'success'].filter((s) => count[s] > 0).map((s) => `<span class="ck-c ck-${s}" title="${CK_SUM[s]}">${ICON_CK[s]}<b>${count[s]}</b><span class="w"> ${CK_SUM[s]}</span></span>`).join('')}</div>` : '<p class="rs-sub" role="status">No checks</p>';
    const items = k.items.filter((i) => i && typeof i === 'object' && typeof i.name === 'string');
    const rows = items.slice(0, CHECKS_MAX).map((i) => {
      const s = CK_STATES.includes(i.state) ? i.state : 'pending';
      return `<div class="ck-r"><span class="ck-i ck-${s}" aria-hidden="true">${ICON_CK[s]}</span><span class="ck-nm" title="${esc(i.name)}">${esc(i.name)}</span><span class="ck-s">${CK_WORD[s]}</span>${link(i.url, 'ck-l', ` aria-label="Open ${esc(i.name)} on GitHub"`, '↗')}</div>`;
    }).join('');
    const more = items.length > CHECKS_MAX ? `<p class="rs-sub" role="status">and ${items.length - CHECKS_MAX} more</p>` : '';
    const rerun = g.rerun && typeof g.rerun === 'object' && g.rerun.show === true ? `<button type="button" class="ck-rerun" data-act="rerun" data-id="${esc(g.id ?? '')}" data-n="${pr.number}"${g.rerun.enabled === true ? '' : ' disabled'}${g.rerun.title ? ` title="${esc(g.rerun.title)}"` : ''}>Re-run failed</button>` : '';
    const reason = !pr.ready && pr.blockedReason && k.state !== 'pending' && k.state !== 'failed' ? `<p class="rs-sub" role="status">${esc(pr.blockedReason)}</p>` : '';
    return `<div class="st-pr"><div class="st-t">${number}${state}${review}</div><div class="st-ti">${esc(pr.title ?? '')}</div><div class="st-mt">${meta}</div></div>${sum}<div class="ck-list">${rows}</div>${more}${rerun}${reason}`;
  };
  // RP220: the Projects tab (id `members`) of the column of a room: one block per member (a project), a line between one block and the next, with what the page already knows: the state of its session (the live one wins,
  // as in the card of the list), how long ago it moved and its PR with its CI. Read-only. `c.members` is what V.roomMembers answers and `c.now` the clock of the page. Total.
  const membersView = (c) => {
    const x = c && typeof c === 'object' ? c : {};
    const list = (Array.isArray(x.members) ? x.members : []).filter((m) => m && typeof m === 'object' && !Array.isArray(m) && typeof m.id === 'string');
    if (!list.length) return '<p class="rs-sub" role="status">No projects yet. Assign repos to this room from the ⋯ menu of a card.</p>';
    const block = (m) => {
      const name = `<b class="mb-name" title="${esc(m.name)}">${esc(m.name)}</b>`;
      if (m.known === false) return `<div class="mb-row" data-id="${esc(m.id)}"><div class="mb-l1">${name}</div><div class="mb-l2 rs-sub">not in the panel</div></div>`;
      const state = sessionChip({ id: m.id, session: { state: m.state } }, { liveFor: () => m.live });
      const l = m.state === 'free' && m.last && typeof m.last === 'object' && typeof m.last.at === 'string' && Object.hasOwn(MB_END, m.last.kind) ? MB_END[m.last.kind] : null;
      const end = l ? `<span class="mb-end mb-end-${m.last.kind}" title="The last task ${l.said} ${esc(relativeTime(m.last.at, x.now))}">${l.icon} ${l.word}</span>` : '';
      const prs = prChipOf(m.prs);
      const what = typeof m.what === 'string' && m.what.trim() ? `<div class="mb-l3 rs-sub rs-commit" title="${esc(m.what.trim())}">${esc(m.what.trim())}</div>` : '';
      return `<div class="mb-row" data-id="${esc(m.id)}"><div class="mb-l1">${name}${state}${end}</div><div class="mb-l2 rs-sub"><span class="rs-when">${esc(relativeTime(m.at, x.now))}</span>${prs || '<span class="rs-sub">no open PR</span>'}</div>${what}</div>`;
    };
    return `<div class="mb-list" role="list">${list.map(block).join('')}</div>`;
  };
  const columnView = (ctx) => {
    const c = ctx && typeof ctx === 'object' ? ctx : {};
    const g = gitOf(c);
    const room = c.room === true; // RP220: the column of a room opens on Projects and has no Tasks tab
    const tab = room ? (c.tab === 'files' ? 'files' : c.tab === 'notes' && c.notes === true ? 'notes' : c.tab === 'status' && g ? 'status' : c.tab === 'changes' ? 'changes' : 'members') : c.tab === 'tasks' ? 'tasks' : c.tab === 'files' ? 'files' : c.tab === 'notes' && c.notes === true ? 'notes' : c.tab === 'status' && g ? 'status' : 'changes';
    const files = validFiles(c.files);
    const pending = g ? checksOf(prOf(g)).pending : 0;
    const tabBtn = ([id, label]) => `<button type="button" role="tab" class="col-tab" id="coltab-${id}" data-act="col-tab" data-tab="${id}" aria-selected="${id === tab}" aria-controls="colpane" aria-label="${label}" title="${label}">${ICON_TAB[id]}<span class="lb">${label}</span>${id === 'changes' && files ? `<span class="n">${files.length}</span>` : id === 'status' && pending > 0 ? `<span class="n y">${pending}</span>` : ''}</button>`;
    const body = tab === 'members' ? membersView(c) : tab === 'notes' ? '<div id="colNotes" class="col-notes"></div>' : tab === 'tasks' ? (typeof c.tasksHtml === 'string' && c.tasksHtml ? c.tasksHtml : '<p class="rs-sub" role="status">No tasks to show</p>') : tab === 'status' ? statusPanel(g) : tab === 'files' ? treeHtml(c.tree, { selected: c.fselected, open: c.fopen, changed: c.changed, failed: c.filesFailed }).html : changesPanel(c, files);
    const base = g ? [['tasks', 'Tasks'], ['changes', 'Changes'], ['status', 'Status'], ['files', 'Files']] : [['tasks', 'Tasks'], ['changes', 'Changes'], ['files', 'Files']];
    const list = room ? [['members', 'Projects'], ...base.filter(([id]) => id !== 'tasks')] : base;
    if (c.notes === true) list.push(['notes', 'Notes']); // RP196: under 760 px Notes is a tab of the column (the chat of the phone has no tabs of its own)
    // RP157: asked for the Repo screen (`back: true`, under 760 px) it starts with a head: the arrow back to the chat and the title.
    const head = c.back === true ? `<div class="col-head"><button type="button" class="ch-back" data-act="zone-back" aria-label="Back to the chat" title="Back to the chat">${svgIcon('<path d="M10 3L5 8l5 5"/>', 20)}</button><b>Repo</b></div>` : '';
    return `${head}<div class="col-tabs" role="tablist" aria-label="Column views">${list.map(tabBtn).join('')}</div><div class="col-pane" id="colpane" role="tabpanel" aria-labelledby="coltab-${tab}">${body}</div>`;
  };
  // RP196: under 760 px a file or a diff tapped in the column opens HERE, not in the chat: a head with the arrow back to the list of the column and the name of the file (its path is the tooltip), and the viewer under it.
  const columnDetail = (c) => {
    const o = c && typeof c === 'object' ? c : {};
    const title = typeof o.title === 'string' ? o.title : '';
    const name = title.split(/[\\/]/).pop() || title;
    return `<div class="col-head"><button type="button" class="ch-back" data-act="detail-close" aria-label="Back to the list" title="Back to the list">${svgIcon('<path d="M10 3L5 8l5 5"/>', 20)}</button><b class="col-title" title="${esc(title)}">${esc(name)}</b></div><div class="col-detail" id="coldetail">${typeof o.html === 'string' ? o.html : ''}</div>`;
  };
  // The state of the session (RPC2-1), shown inside the composer frame. Icon + word, never colour alone. c = { info, rpc } (rpc: what V.rpcReduce keeps).
  // RP156 (design/panel-chips/, direction A): the icons of the chips of the chat are drawn (the family of the icons of the page: 16 grid, stroke 1.5, currentColor), not text characters that each system draws with another shape. Every state
  // has its own shape, so colour is never the only thing that tells them apart. `svgIcon` marks them aria-hidden: the word is still in the chip.
  const SI = {
    loading: svgIcon('<circle cx="3.5" cy="8" r="1.2" fill="currentColor" stroke="none"/><circle cx="8" cy="8" r="1.2" fill="currentColor" stroke="none"/><circle cx="12.5" cy="8" r="1.2" fill="currentColor" stroke="none"/>'),
    none: svgIcon('<circle cx="8" cy="8" r="5.5" stroke-dasharray="2 2.2"/>'),
    starting: svgIcon('<path d="M8 2.5a5.5 5.5 0 1 1-5.5 5.5"/>'),
    free: svgIcon('<circle cx="8" cy="8" r="5.5"/><path d="M5.6 8.2l1.8 1.8 3-3.4"/>'),
    working: svgIcon('<circle cx="8" cy="8" r="2.6" fill="currentColor"/><circle cx="8" cy="8" r="5.5"/>'),
    compacting: svgIcon('<path d="M3 3l3.6 3.6M6.8 3.6v3.2H3.6M13 13l-3.6-3.6M9.2 12.4V9.2h3.2"/>'),
    waiting: svgIcon('<path d="M3 3.5h10v7H8.6L5.6 13v-2.5H3z"/><path d="M8 5.4v2.2"/><circle cx="8" cy="9" r=".5" fill="currentColor" stroke="none"/>'),
    unknown: svgIcon('<circle cx="8" cy="8" r="5.5"/><path d="M6.4 6.4a1.7 1.7 0 1 1 2.5 1.5c-.6.4-.9.7-.9 1.3"/><circle cx="8" cy="11.2" r=".5" fill="currentColor" stroke="none"/>'),
  };
  const MEMORY_BASE = '<ellipse cx="8" cy="4.2" rx="4.5" ry="1.8"/><path d="M3.5 4.2v7.6c0 1 2 1.8 4.5 1.8s4.5-.8 4.5-1.8V4.2"/><path d="M3.5 8c0 1 2 1.8 4.5 1.8S12.5 9 12.5 8"/>';
  const MEMORY_ICON = {
    ready: svgIcon(MEMORY_BASE),
    offline: svgIcon(`${MEMORY_BASE}<path d="M2 14L14 2" stroke-width="1.6"/>`),
    error: svgIcon(`${MEMORY_BASE}<circle cx="12" cy="12" r="3.2" fill="#2a1213"/><path d="M12 10.6v1.5"/><circle cx="12" cy="13.2" r=".4" fill="currentColor" stroke="none"/>`),
    disabled: svgIcon(`${MEMORY_BASE}<path d="M2.5 8h11" stroke-width="2.2" stroke="#251d08"/><path d="M3 8h10"/>`),
  };
  // The context: an arc as long as the percent under 70, a triangle from 70, a cross from 90, a dashed ring when it is not known. `n` is the rounded percent (a number, never text).
  const ctxIcon = (kind, n) => (kind === 'bad' ? svgIcon('<circle cx="8" cy="8" r="5.5"/><path d="M5.9 5.9l4.2 4.2M10.1 5.9l-4.2 4.2"/>')
    : kind === 'warn' ? svgIcon('<path d="M8 2.6l5.6 10H2.4z"/><path d="M8 6.8v2.6"/><circle cx="8" cy="11.2" r=".5" fill="currentColor" stroke="none"/>')
      : kind === 'unknown' ? svgIcon('<circle cx="8" cy="8" r="5.5" stroke-dasharray="2 2.2"/>')
        : svgIcon(`<circle cx="8" cy="8" r="5.5" opacity=".3"/><circle cx="8" cy="8" r="5.5" pathLength="100" stroke-dasharray="${n} 100" transform="rotate(-90 8 8)"/>`));
  const SUB_ICON = svgIcon('<path d="M4 2.5v6.5a2 2 0 0 0 2 2h6"/><path d="M9.6 8.2l2.6 2.8-2.6 2.8"/>');
  const SESS_TITLE = {
    loading: 'Loading the session', unknown: 'The session state is unknown', none: 'The session is not started: sending a message starts it', starting: 'The session is starting; this can take half a minute',
    free: 'The session is idle: you can write to it', working: 'The session is working', compacting: 'The session is compacting its context: wait a moment', waiting: 'pi is asking something: answer it in the card of the chat',
  };
  const SESS_VIEW = {
    loading: ['gray', SI.loading, 'Loading…'], unknown: ['gray', SI.unknown, 'Unknown'], none: ['gray', SI.none, 'Not started'], starting: ['yellow', SI.starting, 'Starting…'], free: ['gray', SI.free, 'Idle'],
    working: ['green', SI.working, 'Working…'], compacting: ['yellow', SI.compacting, 'Compacting…'], waiting: ['yellow', SI.waiting, 'Asking you something'],
  };
  const SESS_OF = { closed: 'none', starting: 'starting', idle: 'free', busy: 'working', asking: 'waiting' };
  function sessionState(c) {
    const compacting = !!(c.rpc && c.rpc.compacting === true && c.rpc.state !== 'closed' && c.rpc.state !== 'starting'); // RP140: the mark is not a state of the machine; it wins over Idle and Working…
    const key = !c.info ? 'loading' : compacting ? 'compacting' : SESS_OF[c.rpc && c.rpc.state] || 'unknown'; // no rpc entry yet: the status read has not answered
    const [tone, icon, word] = SESS_VIEW[key];
    return { key, tone, icon, word, title: SESS_TITLE[key], animate: key === 'working' || key === 'starting' || key === 'compacting' };
  }
  // RP170: while the session is IDLE and the PR of the current branch has checks running (or failed), the label says the CI instead of «Idle»: `c.ci` is what V.ciOf answers for that PR. Only the words are `ss-word` (a narrow chat hides
  // them); the numbers stay visible. Running turns (the spinner of the CI); failed does not (the person must act). Any other state of the session, or an input that is not a CI, leaves the label as it was.
  const CI_LABEL = {
    running: { tone: 'yellow', icon: ICON_CK.pending, word: 'Verifying Checks', said: 'running', anim: ' ss-anim', title: 'are running' },
    failed: { tone: 'red', icon: ICON_CK.failed, word: 'Checks Failed', said: 'failed', anim: '', title: 'failed' },
  };
  const whole = (v) => (Number.isSafeInteger(v) && v > 0 ? v : 0);
  function ciLabel(ci, opts) {
    if (!ci || typeof ci !== 'object' || !Object.hasOwn(CI_LABEL, ci.kind) || !Number.isSafeInteger(ci.number)) return '';
    const L = CI_LABEL[ci.kind];
    const [count, passed, total] = [ci.kind === 'running' ? ci.pending : ci.failed, ci.passed, ci.total].map(whole);
    const title = `PR #${ci.number}: the checks ${L.title} (${count} ${L.said}, ${passed} of ${total} passed)`;
    if (opts && opts.phone) return `<span class="ss ss-${L.tone} ss-ci${L.anim}" title="${esc(title)}" aria-label="${esc(title)}"><i class="ss-dot" aria-hidden="true">${L.icon}</i><span class="ch-n">${count}</span><span class="ch-w">${L.said}</span></span>`; // RP198: icon, number and a short word the stylesheet may hide
    return `<span class="ss ss-${L.tone} ss-ci${L.anim}"${opts && opts.head ? '' : ' role="status"'} title="${esc(title)}"><i class="ss-dot" aria-hidden="true">${L.icon}</i> <span class="ss-word">${L.word}</span><span class="ss-n"> · ${count} ${L.said} · ${passed}/${total}</span></span>`;
  }
  const sessionLabelHtml = (c) => {
    const s = sessionState(c);
    if (s.key === 'free') { const ci = ciLabel(c.ci); if (ci) return ci; }
    return `<span class="ss ss-${s.tone} ss-${s.key}${s.animate ? ' ss-anim' : ''}" role="status" title="${esc(s.title)}"><i class="ss-dot" aria-hidden="true">${s.icon}</i> <span class="ss-word">${s.word}</span></span>`; // RP156: the word can be hidden in a narrow chat, but stays for the accessible name
  };

  // RP110b: the memory (Engram) of the session, as one chip next to its state. The server sends ONE category of a closed list, never the text of the plugin; the chip says it in words
  // and the tone follows it (ready is quiet, disabled warns, offline and error are in red). Nothing is drawn without a known category or when the session is closed.
  const MEMORY_CHIP = {
    ready: ['mem-ready', 'memory ready', 'The memory of this session is ready'],
    offline: ['mem-bad', 'memory offline', 'The memory of this session cannot be reached'],
    error: ['mem-bad', 'memory error', 'The memory of this session reported an error'],
    disabled: ['mem-warn', 'memory disabled', 'The memory is disabled for this session: it will not remember anything'],
  };
  const memoryChipHtml = (c, opts) => {
    const r = c && c.rpc && typeof c.rpc === 'object' ? c.rpc : null;
    if (!r || r.state === 'closed' || typeof r.memory !== 'string' || !Object.hasOwn(MEMORY_CHIP, r.memory)) return '';
    if (opts && opts.quiet === true && r.memory === 'ready') return ''; // RP197: the head says nothing while the memory is fine
    const [cls, word, title] = MEMORY_CHIP[r.memory];
    if (opts && opts.phone === true) return `<span class="mem ${cls}" title="${esc(title)}" aria-label="${esc(title)}"><i class="mem-ic" aria-hidden="true">${MEMORY_ICON[r.memory]}</i><span class="ch-w">${r.memory === 'disabled' ? 'off' : r.memory}</span></span>`; // RP198: a short word, hidden by the stylesheet when there is no room
    return `<span class="mem ${cls}" title="${esc(title)}"><i class="mem-ic" aria-hidden="true">${MEMORY_ICON[r.memory]}</i> <span class="mem-word">${word}</span></span>`; // RP156: the memory chip gets an icon too
  };

  // RP245c: the permission mode of the session, only when it asks less than normal (auto, yolo, super-yolo): silence in the normal mode, as with the memory.
  const MODE_CHIP = {
    auto: ['mem-warn', 'The session runs in auto mode: it asks fewer permission questions'],
    yolo: ['mem-bad', 'The session runs in yolo mode: only destructive actions still ask'],
    'super-yolo': ['mem-bad', 'The session runs in super-yolo mode: it asks no permission questions'],
  };
  const modeChipHtml = (c) => {
    const r = c && c.rpc && typeof c.rpc === 'object' ? c.rpc : null;
    if (!r || r.state === 'closed' || typeof r.mode !== 'string' || !Object.hasOwn(MODE_CHIP, r.mode)) return '';
    const [cls, title] = MODE_CHIP[r.mode];
    return `<span class="mem mode ${cls}" title="${esc(title)}" aria-label="${esc(title)}"><i class="mem-ic" aria-hidden="true">⚡</i> <span class="mem-word">${r.mode}</span></span>`;
  };

  // RP139: the share of the context window the session uses, as a chip next to the memory one. c.rpc.ctx holds three validated numbers (V.rpcWithContext); unknown (null) reads `ctx —`, never 0.
  // Quiet below 70%, warning from 70%, strong warning from 90%: icon + number + words in the help, never colour alone. Nothing is drawn while the session is closed or starting, or before the first reading.
  const kTokens = (n) => (n >= 1000 ? `${Math.round(n / 1000)}k` : String(n));
  // RP197: what the context says, for the chip and for the icon of the menu: null with nothing to say, { unknown, title } before the first reading, else { p, cls, kind, title }.
  const ctxLevel = (c) => {
    const r = c && c.rpc && typeof c.rpc === 'object' ? c.rpc : null;
    const x = r && r.ctx && typeof r.ctx === 'object' ? r.ctx : null;
    if (!x || r.state === 'closed' || r.state === 'starting') return null;
    const ok = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0;
    if (!ok(x.percent) || !Number.isSafeInteger(x.window) || x.window <= 0) return { unknown: true, title: 'Context usage is unknown until the next answer' };
    const p = Math.min(100, x.percent);
    const [cls, kind, more] = p >= 90 ? ['mem-bad', 'bad', ' (almost full)'] : p >= 70 ? ['mem-warn', 'warn', ' (getting full)'] : ['', 'ok', '']; // RP156: the shape says the level, not only the colour
    const used = ok(x.tokens) ? tokensShort(x.tokens) : `${Math.round(p)}%`;
    return { p: Math.round(p), cls, kind, title: `Context used by this session: ${used} of ${tokensShort(x.window)} tokens${more}` }; // RP239: a 1M window reads «1M», not «1000k»
  };
  // RP239: the totals of the session for the chip, in this order: its tokens (`34k tok`) and its cost (`$0.12`, `<$0.01` under a cent, `$0.00` for exactly 0). A part that is not a clean number is left out.
  // A session can reach millions of tokens: from 1M on they read as M (one decimal under 100M), never as «97428k»; `exact` (the help) gives the whole number with thousands separators.
  function tokensShort(n) { return n >= 999500 ? `${(n / 1e6).toFixed(n >= 1e8 ? 0 : 1).replace(/\.0$/, '')}M` : kTokens(n); }
  const sessionTotals = (x, { exact = false } = {}) => {
    const o = x && typeof x === 'object' ? x : {};
    const out = [];
    if (Number.isSafeInteger(o.sessionTokens) && o.sessionTokens >= 0) out.push(exact ? `${o.sessionTokens.toLocaleString('en-US')} tokens` : `${tokensShort(o.sessionTokens)} tok`);
    if (typeof o.cost === 'number' && Number.isFinite(o.cost) && o.cost >= 0) out.push(o.cost > 0 && o.cost < 0.01 ? '<$0.01' : `$${o.cost.toFixed(2)}`);
    return out;
  };
  // RP239: `totals` (the head of the chat on a wide screen) adds the totals of the session to the chip and its help; the phone row keeps the percentage alone.
  const ctxChipHtml = (c, { totals = false } = {}) => {
    const l = ctxLevel(c);
    if (!l) return '';
    const parts = totals ? sessionTotals(c.rpc.ctx) : [];
    const more = parts.length ? ` · ${parts.join(' · ')}` : '';
    const title = parts.length ? `${l.title}. This session so far: ${sessionTotals(c.rpc.ctx, { exact: true }).join(', ')}` : l.title;
    if (l.unknown) return `<span class="mem ctx" title="${esc(title)}"><i class="mem-ic" aria-hidden="true">${ctxIcon('unknown', 0)}</i> <span class="mem-word">ctx </span>—${esc(more)}</span>`;
    return `<span class="mem ctx${l.cls ? ` ${l.cls}` : ''}" title="${esc(title)}"><i class="mem-ic" aria-hidden="true">${ctxIcon(l.kind, l.p)}</i> <span class="mem-word">ctx </span>${l.p}%${esc(more)}</span>`;
  };
  // RP197: the chips of the head of the chat. Silence when all is well: the context (once read), the memory only when it is not ready, the checks only while they run or fail (ciOf is null on green).
  const headChipsHtml = (c, ci) => modeChipHtml(c) + ctxChipHtml(c, { totals: true }) + memoryChipHtml(c, { quiet: true }) + ciLabel(ci, { head: true }); // RP245c: the mode first, it changes what the session may do
  // RP198: row 2 of the phone head, in a fixed order: ↑N (only when ahead > 0), the context, then the alerts (the memory when it is not ready, the checks while they run or fail). With 4 pieces the row is `ch-tight`:
  // the stylesheet drops the words of the alerts (icon + number stay); with fewer it drops them only when the central block is narrow (a container query). '' when there is nothing to say.
  const aheadChipHtml = (n) => (n > 0 ? `<span class="ch-up" title="${n} ${n === 1 ? 'commit' : 'commits'} ahead" aria-label="${n} ${n === 1 ? 'commit' : 'commits'} ahead">${svgIcon('<path d="M8 13V3M4 7l4-4 4 4"/>', 13)}${n}</span>` : '');
  const phoneInfoHtml = (c, ci, ahead) => {
    const pieces = [aheadChipHtml(ahead), c ? modeChipHtml(c) : '', c ? ctxChipHtml(c) : '', c ? memoryChipHtml(c, { quiet: true, phone: true }) : '', ciLabel(ci, { phone: true })].filter(Boolean);
    return pieces.length ? `<span class="ch-info${pieces.length > 3 ? ' ch-tight' : ''}">${pieces.join('')}</span>` : '';
  };
  // RP197: the states as ICONS with no text, side by side, for the top of the ⋮ menu: the memory (also when it is ready), the context and the checks of the PR. Each has its name (aria-label and tooltip, the same words) and a tone.
  const statusIconsHtml = (c, g) => {
    const r = c && c.rpc && typeof c.rpc === 'object' ? c.rpc : null;
    const out = [];
    const add = (tone, label, icon) => out.push(`<span class="ch-st ch-st-${tone}" role="img" aria-label="${esc(label)}" title="${esc(label)}">${icon}</span>`);
    if (r && r.state !== 'closed' && typeof r.memory === 'string' && Object.hasOwn(MEMORY_CHIP, r.memory)) add(r.memory === 'ready' ? 'ok' : r.memory === 'disabled' ? 'warn' : 'bad', MEMORY_CHIP[r.memory][2], MEMORY_ICON[r.memory]);
    const l = ctxLevel(c);
    if (l) add(l.unknown || l.kind === 'ok' ? 'ok' : l.kind, l.title, l.unknown ? ctxIcon('unknown', 0) : ctxIcon(l.kind, l.p));
    const pr = g && typeof g === 'object' ? prOf(g) : null;
    const k = pr ? checksOf(pr) : null;
    if (k && k.state !== 'none') {
      const said = k.state === 'failed' ? `the checks failed (${k.failed} failed, ${k.passed} of ${k.total} passed)` : k.state === 'pending' ? `the checks are running (${k.pending} running, ${k.passed} of ${k.total} passed)` : `all the checks passed (${k.passed} of ${k.total})`;
      add(k.state === 'failed' ? 'bad' : k.state === 'pending' ? 'warn' : 'ok', `PR #${pr.number}: ${said}`, ICON_CK[k.state]);
    }
    return out.length ? `<div class="ch-status" role="group" aria-label="Status">${out.join('')}</div>` : '';
  };

  // RP140: "Compact" next to the ctx chip. Only a live session (idle or answering) that is not compacting already has it; the title says that an answer in progress is stopped first. The server decides anyway.
  const compactButtonHtml = (c) => {
    const r = c && c.info && c.rpc && typeof c.rpc === 'object' ? c.rpc : null;
    if (!r || r.compacting === true || (r.state !== 'idle' && r.state !== 'busy')) return '';
    return `<button type="button" class="ch-mi" role="menuitem" data-act="compact" title="${r.state === 'busy' ? 'Compact the context of this session. It stops the answer in progress first' : 'Compact the context of this session'}">Compact</button>`;
  };

  // RP98: "Close session" stops the pi process of the repo and releases its adoption (the chat goes back to the list of sessions). It lives next to the session state in the composer frame (RP72 keeps the
  // chat header to the repo name and the ✕, which only hides the chat) and is there while the repo has a session: adopted or live.
  const sessionCloseHtml = (show, closing) => (show ? `<button type="button" class="ch-mi" role="menuitem" data-act="session-close"${closing ? ' disabled' : ''} title="Stop this session and go back to the list of sessions">Close session</button>` : ''); // RP195: an item of the ⋮ menu of the head of the chat (it was a button of the foot)

  // RP118: "Terminal" next to "Close session" shows the line to open this session in a normal terminal. The server writes the line (GET /api/terminal); the page only shows it, escaped, and copies it from its
  // own state: the command is never put in an attribute. `term` is { open, loading | failed | available + command + reason, copied }.
  const sessionTerminalHtml = (show, term) => (show ? `<button type="button" class="ch-mi" role="menuitem" data-act="session-terminal" aria-expanded="${term && term.open ? 'true' : 'false'}" title="Show the command to open this session in a normal terminal">Terminal</button>` : '');
  // RP195: the ⋮ menu of the head of the chat: Compact, Terminal and Close session (they were buttons of the foot), each only under the conditions it had there. `m` = { open, session (the chat view: info and rpc), hasSession, terminal, closing }.
  // With nothing to offer (no session) there is no button at all. The list is in the page only while it is open.
  const chatMenuHtml = (m) => {
    const o = m && typeof m === 'object' ? m : {};
    const items = compactButtonHtml(o.session) + sessionTerminalHtml(!!o.hasSession, o.terminal) + sessionCloseHtml(!!o.hasSession, !!o.closing);
    const status = statusIconsHtml(o.session, o.git); // RP197: the states, as icons, at the top of the list
    if (!items) return '';
    const open = o.open === true;
    const dots = '<svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><circle cx="8" cy="3" r="1.4"/><circle cx="8" cy="8" r="1.4"/><circle cx="8" cy="13" r="1.4"/></svg>';
    return `<span class="ch-menu" id="chMenuWrap"><button type="button" id="chMenuBtn" class="ch-more" data-act="ch-menu" aria-label="Session menu" title="Session menu" aria-haspopup="menu" aria-expanded="${open}" aria-controls="chMenu">${dots}</button>${open ? `<div id="chMenu" class="ch-menu-list" role="menu" aria-label="Session">${status}${items}</div>` : ''}</span>`;
  };
  function terminalBlockHtml(term) {
    if (!term || !term.open) return '';
    const SHELLS = { powershell: ['PowerShell', 'Paste it in PowerShell: cmd reads some characters differently'], posix: ['bash or zsh', 'Paste it in bash or zsh'] };
    const head = (shell) => `<div class="term-head"><b>Open this session in a normal terminal</b>${Object.hasOwn(SHELLS, shell) ? `<span class="term-shell" title="${SHELLS[shell][1]}">${SHELLS[shell][0]}</span>` : ''}<button type="button" class="term-hide" data-act="terminal-hide" aria-label="Hide the command">✕</button></div>`;
    if (term.loading) return `${head()}<p class="term-note">Loading the command…</p>`;
    if (term.failed) return `${head()}<p class="term-note">Could not read the command</p>`;
    if (term.available !== true || typeof term.command !== 'string') return `${head()}<p class="term-note">${esc(typeof term.reason === 'string' && term.reason ? term.reason : 'No command is available for this session')}</p>`;
    return `${head(term.shell)}<code class="term-cmd">${esc(term.command)}</code><div class="term-row"><button type="button" data-act="terminal-copy">${term.copied ? 'Copied' : 'Copy'}</button><span class="term-note">Close the session here first: two programs on the same session mix up its history.</span></div>`;
  }

  // RP137: the sheet that asks before a merge under 760 px. m = { n, base, title, method, del }; anything that is not a valid model gives nothing. Every text is escaped; a method that is not one of the three reads as squash
  // (as the Merge button does).
  function mergeSheetHtml(m) {
    const x = m && typeof m === 'object' && !Array.isArray(m) ? m : null;
    if (!x || !Number.isSafeInteger(x.n) || x.n <= 0 || typeof x.base !== 'string') return '';
    const method = ['squash', 'merge', 'rebase'].includes(x.method) ? x.method : 'squash';
    const title = typeof x.title === 'string' && x.title ? `<p class="ms-sub">${esc(x.title)}</p>` : '';
    return `<div class="ms-back" data-act="merge-cancel"></div><div class="ms-card" role="dialog" aria-modal="true" aria-labelledby="ms-t"><h3 id="ms-t">Merge #${x.n} into ${esc(x.base)}?</h3>${title}<p>Method: <b>${method}</b>. ${x.del === true ? 'The branch will be deleted after the merge.' : 'The branch is kept.'}</p><div class="ms-btns"><button type="button" class="ms-cancel" id="ms-cancel" data-act="merge-cancel">Cancel</button><button type="button" class="primary ms-ok" data-act="merge-confirm">Merge · ${method}</button></div></div>`;
  }
  // RP135: what the head of the chat says about the repo under 760 px. Pure and total. `g` is what columnGit gives (branch, commits ahead, and the open PR of THAT branch, so a PR of another branch never shows here). The checks that
  // are running or failed are said, the passed ones are not; what is not a count is 0. line = the second line of the head, label = the name of the button that opens Repo, pending = the badge of the Repo button.
  const count = (v) => (Number.isSafeInteger(v) && v > 0 ? v : 0);
  function repoStatus(g) {
    const x = g && typeof g === 'object' && !Array.isArray(g) ? g : {};
    const pr = prOf(x);
    const k = pr ? checksOf(pr) : null;
    const ahead = count(x.ahead);
    const pending = k ? count(k.pending) : 0;
    const failed = k ? count(k.failed) : 0;
    const branch = typeof x.branch === 'string' ? x.branch : '';
    const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
    const line = [ahead && `↑${ahead}`, pending && plural(pending, 'check', 'checks'), failed && `${failed} failed`, branch].filter(Boolean).join(' · ');
    const said = [branch && `branch ${branch}`, ahead && plural(ahead, 'commit ahead', 'commits ahead'), pending && `${plural(pending, 'check', 'checks')} running`, failed && `${plural(failed, 'check', 'checks')} failed`].filter(Boolean);
    return { ahead, pending, failed, branch, line, label: said.length ? `Open the repo: ${said.join(', ')}` : 'Open the repo' };
  }
  // The header: the repo name (the session id is only its tooltip) and the close button. RP198: under 760 px (`ctx.narrow === true`) the head is the block of 57 px (the arrow, a central block of two rows that is ONE button that opens Repo, and the actions); the Repo button
  // carries the badge of the checks that are pending (RP135; `ctx.git` is what columnGit gives). From 760 px up the markup is the one of always.
  function chatHead(c, ctx = {}) {
    const adopted = c.info && c.info.adopted;
    const tip = adopted ? `${ctx.name} · ${adopted.id}` : ctx.name;
    // RP91: with the right column in (`ctx.column`) the tasks are its card, so the chat has no Tasks tab; where there is no column (under 1100 px) the tab stays.
    // RP90: ONE diff tab, the last one, named after the file open in it (`c.dfile`), with its own close button; without a file there is no tab and a "diff" tab reads as the chat.
    // RP130: that ONE viewer tab holds a diff (`c.dfile`) or a file (`c.ffile`); the explorer is the column's, so with the column in the chat has no Files tab either.
    const phone = ctx.narrow === true; // RP196: under 760 px Notes and the viewer live in the column, so the chat head has neither the tab nor the chip
    const dfile = !phone && typeof c.dfile === 'string' ? c.dfile : '';
    const ffile = !phone && typeof c.ffile === 'string' ? c.ffile : '';
    const kind = c.tab === 'file' && ffile ? 'file' : dfile ? 'diff' : ffile ? 'file' : '';
    const vfile = kind === 'file' ? ffile : dfile;
    const hidden = (t) => (ctx.column && (t === 'tasks' || t === 'changes' || t === 'files')) || (phone && t === 'notes');
    const cur = kind && c.tab === kind ? kind : ['tasks', 'changes', 'files', 'notes'].includes(c.tab) && !hidden(c.tab) ? c.tab : 'chat';
    const dname = vfile.split(/[\\/]/).pop() || vfile;
    const dtab = kind ? `<span class="ch-dtab"><button type="button" role="tab" class="ch-tab" data-act="chat-tab" data-tab="${kind}" title="${esc(vfile)}" aria-selected="${cur === kind}">${esc(dname)}</button><button type="button" class="ch-dclose" data-act="diff-close" aria-label="Close the ${kind === 'file' ? 'file' : 'diff of'} ${esc(vfile)}" title="Close the ${kind}">✕</button></span>` : '';
    const tabs = [['chat', 'Chat'], ['tasks', 'Tasks'], ['changes', 'Changes'], ['files', 'Files'], ['notes', 'Notes']].filter(([t]) => !hidden(t)).map(([t, label]) => `<button type="button" role="tab" class="ch-tab" data-act="chat-tab" data-tab="${t}" aria-selected="${cur === t}">${label}</button>`).join('');
    // RP134: the arrow that goes back to the list (a button with a name; the stylesheet shows it only under 760 px, where the close button goes out)
    const narrow = ctx.narrow === true;
    const st = repoStatus(ctx.git);
    const nameB = `<b class="ch-name" title="${esc(tip)}">${esc(ctx.name)}</b>`;
    const repoBtn = `<button type="button" class="ch-repo" data-act="zone-set" data-zone="repo" aria-label="${esc(st.pending ? `Repo: ${st.pending} ${st.pending === 1 ? 'check' : 'checks'} pending` : 'Open the repo: tasks, changes, status and files')}" title="Open the repo">${svgIcon('<rect x="2.5" y="3" width="11" height="10" rx="1.5"/><path d="M10 3v10"/>', 20)}${narrow && st.pending ? `<i class="ch-dot" aria-hidden="true">${st.pending > 99 ? '99+' : st.pending}</i>` : ''}</button>`;
    const backBtn = `<button type="button" class="ch-back" data-act="chat-back" aria-label="Back to the list of repos" title="Back to the list">${svgIcon('<path d="M10 3L5 8l5 5"/>', 20)}</button>`;
    const closeBtn = '<button type="button" class="x" data-act="chat-close" aria-label="Close the chat" title="Close the chat (Esc)">✕</button>';
    const tabsHtml = `<div class="ch-tabs" role="tablist" aria-label="Panel">${tabs}${dtab}</div>`;
    if (narrow) {
      // RP198: ONE block of a fixed 57 px: the arrow, the central block (two rows, ONE button that opens Repo) and the actions (the panel button, the ⋮)
      const br = st.branch ? `<span class="ch-br" title="${esc(st.branch)}">${ICON_TAB.status}<span class="ch-brn">${esc(st.branch)}</span></span>` : '';
      const info = phoneInfoHtml(ctx.session, ctx.ci, st.ahead);
      return `<div class="ch-row ch-phone">${backBtn}<button type="button" class="ch-mid" data-act="zone-set" data-zone="repo" aria-label="${esc(st.label)}" title="Open the repo"><span class="ch-l1">${nameB}${br}</span>${info}</button><span class="ch-acts">${repoBtn}${ctx.menu ? chatMenuHtml(ctx.menu) : ''}${closeBtn}</span></div>${tabsHtml}`;
    }
    const chips = ctx.session ? headChipsHtml(ctx.session, ctx.ci) : ''; // RP197: the context, and what is wrong, in the head
    return `<div class="ch-row">${backBtn}${nameB}${chips ? `<span class="ch-chips">${chips}</span>` : ""}${ctx.menu ? chatMenuHtml(ctx.menu) : ""}${repoBtn}${closeBtn}</div>${tabsHtml}`;
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
  // RP128, RP149 (S38, S39): the compact list of the right column, design A2 of design/panel-tareas. A summary (how many are done and in progress, with a thin bar); the groups In review, Ready, In progress,
  // Next, Pending, Blocked and Completed, each only when it has tasks, with ONE icon in its header (the rows have none); flat rows (the id and the title, the extra data at the right of the same line and below it
  // only when it does not fit); Pending shows 5 and `ctx.more` shows all of them, the ones that wait for another task last; Completed is folded behind its header and shows the last completed one; and a freshness
  // line with the refresh button (`ctx.readAt`, `ctx.now`, `ctx.refreshing`, `ctx.refreshFailed`). The same cap of rows as the full list; what does not fit is counted.
  const TK_SEGMENTS = [['done', 'rs-done', 'completed'], ['review', 'rs-pr', 'in review'], ['ready', 'tk-ready', 'ready'], ['progress', 'tk-prog', 'in progress'], ['pending', 'rs-pend', 'pending'], ['blocked', 'rs-blk', 'blocked']];
  const TK_NAME = { review: 'In review', ready: 'Ready', progress: 'In progress', next: 'Next', pending: 'Pending', blocked: 'Blocked', done: 'Completed' };
  const TK_ICON = {
    review: svgIcon('<circle cx="4" cy="3.5" r="1.6"/><circle cx="4" cy="12.5" r="1.6"/><circle cx="12" cy="6" r="1.6"/><path d="M4 5.1v5.8M12 7.6c0 3-4 2.4-8 4"/>', 16),
    ready: svgIcon('<circle cx="8" cy="8" r="6"/><circle cx="8" cy="8" r="2" fill="currentColor"/>', 16),
    progress: svgIcon('<circle cx="8" cy="8" r="6" stroke-dasharray="3 2.2"/>', 16),
    next: svgIcon('<circle cx="8" cy="8" r="6"/><path d="M5.5 8h5M8.6 5.9L10.7 8l-2.1 2.1"/>', 16),
    pending: svgIcon('<circle cx="8" cy="8" r="6"/>', 16),
    blocked: svgIcon('<circle cx="8" cy="8" r="6"/><path d="M5.5 8h5"/>', 16),
    done: svgIcon('<circle cx="8" cy="8" r="6"/><path d="M5.2 8.2l2 2 3.6-4"/>', 16),
  };
  const TK_REFRESH_ICON = svgIcon('<path d="M13 8a5 5 0 1 1-1.6-3.7"/><path d="M13 2.5v3h-3"/>', 16);
  const TK_PENDING_SHOWN = 10;
  const TK_REASON_MAX = 140;
  const TK_OLD_MIN = 15; // minutes after which the read is called old
  function compactTasks({ all, groups, keyOf, derived, byId, ctx }) {
    const counts = {};
    for (const r of all) { const k = keyOf(r); counts[k] = (counts[k] || 0) + 1; }
    const done = counts.done || 0;
    const progress = counts.progress || 0;
    counts.pending = (counts.pending || 0) + (counts.next || 0);
    const segs = TK_SEGMENTS.filter(([k]) => counts[k] > 0);
    const bar = `<div class="tk-bar" role="img" aria-label="${esc(segs.map(([k, , w]) => `${counts[k]} ${w}`).join(', '))}">${segs.map(([k, cls]) => `<i class="${cls}" style="width:${pct(counts[k], all.length)}%"></i>`).join('')}</div>`;
    const now = Number.isFinite(ctx.now) ? ctx.now : Date.now();
    const readAt = ctx.readAt;
    const mins = readAt === undefined ? null : Math.floor((Number.isFinite(readAt) && readAt > 0 && readAt <= now ? now - readAt : 0) / 60000);
    const old = mins !== null && mins >= TK_OLD_MIN;
    const said = ctx.refreshing ? 'Updating…' : ctx.refreshFailed ? 'Could not update. Try again.' : mins === null ? '' : mins < 1 ? 'Read just now' : mins < 60 ? `Read ${mins} min ago` : `Read ${Math.floor(mins / 60)} h ago`;
    const state = ctx.refreshing ? '' : ctx.refreshFailed ? ' bad' : old ? ' stale' : '';
    const ft = said ? `<span class="tk-ft">${said}</span>` : '';
    const button = `<button type="button" class="tk-rf${ctx.refreshing ? ' busy' : ''}" data-act="tasks-refresh" aria-label="Refresh the task list" title="Fetch from GitHub, then read the list again"${ctx.refreshing ? ' disabled aria-busy="true"' : ''}>${TK_REFRESH_ICON}</button>`;
    // RP149: the freshness text and the refresh button live in the summary row, which stays under the tabs when the list scrolls (they were at the end of the list, out of reach).
    const sum = `<div class="tk-sum"><div class="tk-top${state}"><span class="tk-sl"><b>${done} of ${all.length} done</b>${progress ? ` · ${progress} in progress` : ''}</span>${ft}${button}</div>${bar}</div>`;
    const waitsOf = (r) => (Array.isArray(r.dependsOn) ? r.dependsOn : []).filter((x) => byId.has(x) && byId.get(x).estado !== 'Completada');
    const extraOf = (r, key) => {
      const d = derived[r.id] || {};
      if (key === 'review' && Number.isFinite(d.pr)) return `PR #${d.pr}`;
      if (key === 'ready' && d.branch) return String(d.branch);
      if (key === 'pending' && waitsOf(r).length) return `waits for ${waitsOf(r).join(', ')}`;
      if (key === 'blocked' && r.notas) return String(r.notas);
      return '';
    };
    let left = TASK_MAX;
    let cut = 0;
    const rowHtml = (r, key) => {
      const extra = extraOf(r, key);
      const shown = key === 'blocked' && extra.length > TK_REASON_MAX ? `${extra.slice(0, TK_REASON_MAX)}…` : extra;
      const cls = `${key === 'next' ? ' tk-next' : ''}${key === 'pending' && waitsOf(r).length ? ' tk-wait' : ''}${key === 'done' ? ' tk-done' : ''}`;
      return `<div class="tk-row${cls}"${key === 'next' ? ' aria-current="true"' : ''} title="${esc([`${r.id} · ${r.entrega ?? ''}`, extra].filter(Boolean).join(' · '))}"><span class="tk-t"><span class="tk-id mono">${esc(r.id)}</span>${esc(r.entrega ?? '')}</span>${shown ? `<span class="tk-x">${esc(shown)}</span>` : ''}</div>`;
    };
    const take = (list, key) => {
      let html = '';
      for (const r of list) { if (left > 0) { html += rowHtml(r, key); left--; } else cut++; }
      return html;
    };
    const head = (key, count) => `<h3 class="tk-gh tk-g-${key}"><span class="tk-gi">${TK_ICON[key]}</span><span class="tk-gn">${TK_NAME[key]}</span>${count === null ? '' : `<span class="tk-gc">${count}</span>`}</h3>`;
    const parts = [sum];
    for (const key of ['review', 'ready', 'progress', 'next']) {
      const list = groups.get(key);
      if (list.length) parts.push(head(key, key === 'next' ? null : list.length), take(list, key));
    }
    const pending = groups.get('pending');
    if (pending.length) {
      const ordered = [...pending.filter((r) => !waitsOf(r).length), ...pending.filter((r) => waitsOf(r).length)];
      const more = !!ctx.more;
      parts.push(head('pending', pending.length), take(more ? ordered : ordered.slice(0, TK_PENDING_SHOWN), 'pending'));
      if (ordered.length > TK_PENDING_SHOWN) parts.push(`<button type="button" class="tk-fold tk-more" data-act="tasks-more" data-k="more" aria-expanded="${more}"><span class="chev" aria-hidden="true">${more ? '▾' : '▸'}</span>${more ? 'Show fewer' : `+${ordered.length - TK_PENDING_SHOWN} more`}</button>`);
    }
    const blocked = groups.get('blocked');
    if (blocked.length) parts.push(head('blocked', blocked.length), take(blocked, 'blocked'));
    const finished = groups.get('done');
    if (finished.length) {
      const open = !!ctx.open && Object.hasOwn(ctx.open, 'done') && ctx.open.done === true;
      parts.push(`<button type="button" class="tk-gh tk-g-done" data-act="tasks-fold" data-fold="done" aria-expanded="${open}"><span class="tk-gi">${TK_ICON.done}</span><span class="tk-gn">${TK_NAME.done}</span><span class="tk-gc">${finished.length}</span><span class="tk-ch" aria-hidden="true">${open ? '▾' : '▸'}</span></button>`);
      parts.push(take(open ? finished : [], 'done'));
    }
    if (cut) parts.push(`<div class="task-more rs-sub">+${cut} more</div>`);
    return parts.join('');
  }
  function tasksView(rp, ctx = {}) {
    const note = (t) => `<div class="empty" role="status">${t}</div>`;
    if (!rp) return note(ctx.failed ? 'Roadmap unavailable' : 'Loading tasks…');
    if (!rp.available) return note(rp.reason === 'missing' ? 'No docs/ROADMAP.md in this repo' : 'Roadmap unavailable');
    const all = (Array.isArray(rp.rows) ? rp.rows : []).filter((r) => r && typeof r.id === 'string' && r.id && TASK_OF[r.estado]);
    const derived = rp.derived && typeof rp.derived === 'object' ? rp.derived : {};
    const byId = new Map(all.map((r) => [r.id, r]));
    const nextId = rp.next && typeof rp.next.id === 'string' ? rp.next.id : null;
    if (!all.length) return note('No tasks in the roadmap');
    const groups = new Map(TASK_GROUPS.map(([k]) => [k, []]));
    const keyOf = (r) => {
      const d = derived[r.id];
      const key = TASK_OF[d && TASK_OF[d.state] ? d.state : r.estado];
      return key === 'pending' && r.id === nextId ? 'next' : key;
    };
    for (const r of all) {
      groups.get(keyOf(r)).push(r);
    }
    if (ctx.compact) return compactTasks({ all, groups, keyOf, derived, byId, ctx }); // RP128: the column's list
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
        const open = !!ctx.openDone;
        parts.push(`<section class="task-group task-done"><button type="button" class="task-head" data-act="tasks-done" aria-expanded="${open}">${title} (${list.length})<span aria-hidden="true"> ${open ? '▾' : '▸'}</span></button>`);
        if (!open) { parts.push('</section>'); continue; }
      } else parts.push(`<section class="task-group"><h3 class="task-head">${title} (${list.length})</h3>`);
      for (const r of list) { if (left > 0) { parts.push(rowHtml(r, key)); left--; } else cut++; }
      parts.push('</section>');
    }
    if (cut) parts.push(`<div class="task-more rs-sub">+${cut} more</div>`);
    return parts.join('');
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
  // RP130: the tree alone (what the right column shows) and the file alone (what the centre shows); the narrow chat still has both in its Files tab (filesView).
  function treeHtml(tree, ctx = {}) {
    ctx = ctx && typeof ctx === 'object' ? ctx : {};
    const list = tree && Array.isArray(tree.files) ? tree.files.filter((f) => f && typeof f.path === 'string' && f.path) : null;
    if (!list) return { ok: false, html: `<div class="empty" role="status">${ctx.failed ? 'Files unavailable' : 'Loading files…'}</div>` };
    if (!list.length) return { ok: false, html: '<div class="empty" role="status">No files</div>' };
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
        emit(`<button type="button" class="ft-row ft-dir${d.dirty ? ' ft-chg' : ''}" style="--d:${depth}" data-act="files-dir" data-path="${esc(d.path)}" data-open="${open}" aria-expanded="${open}"><span class="cf-ch" aria-hidden="true">${open ? '▾' : '▸'}</span><span class="cf-ic" aria-hidden="true">${ICON_DIR}</span><span class="ft-name">${esc(d.name)}</span></button>`);
        if (open) walk(d, depth + 1);
      }
      for (const f of node.files.sort(byName)) {
        const m = mark(f.path);
        const on = ctx.selected === f.path;
        emit(`<button type="button" class="ft-row ft-file${m ? ' ft-chg' : ''}${on ? ' ft-on' : ''}" style="--d:${depth}" data-act="files-open" data-path="${esc(f.path)}" aria-pressed="${on}" title="${esc(f.path)}"><span class="cf-ch" aria-hidden="true"></span><span class="cf-ic" aria-hidden="true">${ICON_FILE}</span><span class="ft-name">${esc(f.name)}</span>${m ? `<span class="ft-mark">${esc(m)}</span>` : ''}</button>`);
      }
    };
    walk(root, 0);
    const tail = cut ? `<div class="cv-more rs-sub">+${cut} more</div>` : '';
    return { ok: true, html: `<div class="ft-tree" role="group" aria-label="Repository files">${out.join('')}${tail}</div>` };
  }
  const fileView = (file, ctx) => fileSection(file, ctx && typeof ctx === 'object' ? ctx : {});
  function filesView(tree, ctx = {}, file = null) {
    const t = treeHtml(tree, ctx);
    return t.ok ? t.html + fileSection(file, ctx && typeof ctx === 'object' ? ctx : {}) : t.html;
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
  const rpcWait = (c) => (c.rpc && c.rpc.compacting === true && c.rpc.state !== 'closed' ? 'The session is compacting its context: wait a moment' : '') || (c.rpc && COMPOSER_WAIT[c.rpc.state]) || (!c.rpc ? REASON.unknown : '');
  function composerState(c, ctx = {}) {
    // RP99: with no session adopted (the list is in view) nothing can be sent: it would start and adopt a new session without telling. Open one or start a new one first.
    const reason = !c.info ? 'Loading the chat…' : !c.info.adopted ? 'Open a session or start a new one to write' : c.sending ? 'Sending…' : rpcWait(c);
    // RP236: a session that works (not one that starts, asks or compacts) still takes a message: as a correction on the fly or queued for when the run ends. `canSend` keeps its meaning (a new run).
    const canSteer = !!reason && !!c.info && !!c.info.adopted && !c.sending && !!c.rpc && c.rpc.state === 'busy' && c.rpc.compacting !== true;
    const placeholder = canSteer ? 'Correct the agent, or queue a message for later…' : reason ? (c.info && !c.info.adopted ? 'Start a session to write' : '') : 'Message…'; // RP207: quiet; the state line and the title of Send say why it is blocked
    return { canSend: !reason, canSteer, reason, placeholder };
  }
  // RP236: which round buttons the foot shows. While the session works an empty box keeps Stop; with text the box offers Correct (steer) and Queue (followUp).
  function footButtons({ busy, canSteer, hasText } = {}) {
    const writing = !!busy && !!canSteer && !!hasText;
    return { send: !busy, stop: !!busy && !writing, steer: writing, queue: writing };
  }
  // RP236: what a message sent while the session works does: Alt+Enter queues it for the end of the run; Enter (and the Correct button) steers the agent now.
  const busyBehavior = ({ alt } = {}) => (alt ? 'followUp' : 'steer');
  // RP245b: a message that starts with ! (or !!: its output is not sent to the model) is a shell command; null when it is not one or has no command.
  function bashOf(text) {
    const m = typeof text === 'string' ? /^(!!?)([\s\S]*)$/.exec(text.trim()) : null;
    const command = m ? m[2].trim() : '';
    return command ? { command, exclude: m[1] === '!!' } : null;
  }
  const SHELL_WAITS = 'Shell commands wait until the session is free: send it when the run ends';
  // RP245b: the bubble of the shell command, live while it runs; a long finished output is folded to its last SHELL_LINES lines with a button to see all of it.
  const SHELL_LINES = 20;
  function shellHtml(b) {
    if (!b || typeof b !== 'object' || typeof b.command !== 'string') return '';
    const out = String(b.output || '').replace(/\n$/, '');
    const lines = out ? out.split('\n') : [];
    const fold = b.running !== true && lines.length > SHELL_LINES;
    const shown = fold && b.open !== true ? lines.slice(-SHELL_LINES) : lines;
    const stop = b.running === true ? '<button type="button" class="sh-toggle sh-stop" data-act="shell-stop">Stop</button>' : '';
    const key = typeof b.key === 'string' && b.key ? ` data-shell="${esc(b.key)}"` : ''; // RP252: a run of the history names its entry
    const toggle = fold ? `<button type="button" class="sh-toggle" data-act="shell-toggle"${key}>${b.open === true ? `Show the last ${SHELL_LINES} lines` : `Show all ${lines.length} lines`}</button>` : '';
    const end = b.running === true ? 'Running…' : b.cancelled === true ? 'Cancelled' : Number.isInteger(b.exitCode) ? `Exit code ${b.exitCode}` : 'Finished';
    const notes = [end, ...(b.exclude === true ? ['Not sent to the model'] : []), ...(b.truncated === true ? ['The output was cut'] : []), ...(Number.isSafeInteger(b.cut) && b.cut > 0 ? [`${b.cut} earlier characters are not shown`] : [])].join(' · ');
    return `<div class="m shell${b.running === true ? ' running' : ''}"${key ? '' : ' role="status"'}><div class="sh-cmd mono">$ ${esc(b.command)}</div>${shown.length ? `<pre class="sh-out">${esc(shown.join('\n'))}</pre>` : ''}<div class="sh-foot"><span>${notes}</span>${stop}${toggle}</div></div>`;
  }
  // RP236b (B2): while the session works a command (a text that starts with /) is not a correction: pi would run it at once. The reason, or '' when the text may go.
  // RP237: the permission and configuration commands of the runtime stay in the terminal (the server refuses them too); the text stays in the box with the reason.
  const panelRefusal = (text) => (typeof text === 'string' && /^\/gentle:(desktop|mode|yolo)(?::\d+)?(?![\w:-])/i.test(text.trim()) ? 'Permission and configuration commands (/gentle:desktop, /gentle:mode, /gentle:yolo) are not available from the panel: use the terminal' : '');
  const steerRefusal = (text) => (typeof text === 'string' && text.trimStart().startsWith('/') ? 'Commands wait until the session is free: send it when the run ends' : '');
  // RP236: the messages waiting for the session, above the box: each with its kind and its text (escaped, on one line), and Clear queue, which puts them back in the box.
  function queueRowHtml(q) {
    const steering = q && Array.isArray(q.steering) ? q.steering.filter((t) => typeof t === 'string') : [];
    const followUp = q && Array.isArray(q.followUp) ? q.followUp.filter((t) => typeof t === 'string') : [];
    if (!steering.length && !followUp.length) return '';
    const item = (kind, t) => `<li class="q-item" title="${esc(t)}"><span class="q-kind">${kind}</span> <span class="q-text">${esc(t)}</span></li>`;
    return `<div class="q-row" role="status"><span class="q-head">Queued · ${steering.length + followUp.length}</span><ul class="q-list">${steering.map((t) => item('Correction', t)).join('')}${followUp.map((t) => item('After the run', t)).join('')}</ul><button type="button" class="q-clear" data-act="chat-unqueue">Clear queue</button></div>`;
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
  const SLOTS = [['flow-next', '/flow-next'], ['flow-ship', '/flow-ship'], ['flow-pr', '/flow-pr'], ['flow-base', '/flow-base']];
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
      const slot = f.cmd.startsWith('flow-ship') ? 1 : f.cmd.startsWith('flow-pr') ? 2 : f.cmd.startsWith('flow-base') ? 3 : -1;
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
  // RP175: the Merge button of the composer (it left the footer of the column). `g` is what columnGit gives (id, the open PR of THE CURRENT branch, and merge: what V.mergeButton decides plus `why`). It is the same button as the card
  // (data-act="merge"); with no PR nothing is drawn. It is only the button: the reason it is off is not written here (RP191, S22: the PR's reason is the placeholder of the message box, V.mergeNote). Total.
  function composerMergeHtml(g) {
    const c = g && typeof g === 'object' && !Array.isArray(g) ? g : {};
    const pr = c.pr && typeof c.pr === 'object' && !Array.isArray(c.pr) && Number.isInteger(c.pr.number) && c.pr.number > 0 ? c.pr : null;
    if (!pr) return '';
    const m = c.merge && typeof c.merge === 'object' ? c.merge : {};
    const button = `<button type="button" class="c-act merge" data-act="merge" data-id="${esc(c.id ?? '')}" data-n="${pr.number}"${m.enabled === true ? '' : ' disabled'} title="${esc(m.title || 'No open pull request for this branch')}">${esc(m.label || 'Merge · squash')}</button>`;
    return button;
  }
  // The line under the box: a message (a refused send, a failed start).
  const composerNote = (n) => (n && n.text ? `<span>${esc(n.text)}</span>` : '');

  const hhmm = (iso) => { const d = new Date(iso); return iso && !Number.isNaN(d.getTime()) ? `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}` : ''; };
  // RP105: a chip per tool when the server sent `toolInfo` (✓/✗ or … while it runs, the name, the redacted argument, the time); without it, the line of names of before.
  const TOOL_CHIPS = 12;
  const fmtMs = (ms) => (!Number.isFinite(ms) ? '' : ms < 1000 ? `${Math.round(ms)}ms` : ms < 59950 ? `${(ms / 1000).toFixed(1)}s` : `${Math.floor(Math.round(ms / 1000) / 60)}m${String(Math.round(ms / 1000) % 60).padStart(2, '0')}s`);
  // RP106: numbers about the result: «+N −M» for an edit, else the size of a big result. Only whole numbers in range draw anything.
  const nat = (v) => (Number.isInteger(v) && v >= 0 && v <= 1e9 ? v : null);
  const fmtSize = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M chars` : `${(n / 1000).toFixed(1)}k chars`);
  // RP106b: with the flag of the history (config.json, off by default), a chip of a tool that is not `read`, with a call id and something in its result, is a button that asks
  // for the start of that result; what comes back opens under the chips (escaped text, a note while it loads or when it fails). Without any of those it is the span of before.
  const CALL_OK = /^[A-Za-z0-9_.:-]{1,80}$/;
  const canAsk = (c, rx) => !!rx && rx.allow === true && typeof c.id === 'string' && CALL_OK.test(c.id) && String(c.name).toLowerCase() !== 'read' && nat(c.size) > 0;
  const resultPanel = (c, rx) => {
    const r = canAsk(c, rx) && rx.map && Object.hasOwn(rx.map, c.id) ? rx.map[c.id] : null;
    if (!r || typeof r !== 'object') return '';
    if (r.state === 'loading') return '<div class="tresnote">Loading result…</div>';
    if (r.state === 'ok') return `<pre class="tres">${esc(typeof r.text === 'string' ? r.text : '')}</pre>`;
    return r.state === 'error' ? `<div class="tresnote bad">${esc(typeof r.error === 'string' ? r.error : 'Result unavailable')}</div>` : '';
  };
  const chipHtml = (c, rx) => {
    const [cls, mark] = c.ok === true ? ['ok', '✓'] : c.ok === false ? ['bad', '✗'] : ['run', '…'];
    const arg = typeof c.arg === 'string' && c.arg ? ` <i>${esc(c.arg)}</i>` : '';
    const time = fmtMs(c.ms) ? ` <small>${fmtMs(c.ms)}</small>` : '';
    const add = nat(c.add);
    const del = nat(c.del);
    const size = nat(c.size);
    const more = add !== null && del !== null ? ` <small class="chg">+${add} −${del}</small>` : size !== null && size >= 1000 ? ` <small class="sz">${fmtSize(size)}</small>` : '';
    const inner = `${mark} <b>${esc(c.name)}</b>${arg}${time}${more}`;
    return canAsk(c, rx) ? `<button type="button" class="tc ${cls} res" data-act="chat-result" data-id="${esc(rx.id)}" data-call="${esc(c.id)}" title="Show the start of the result">${inner}</button>` : `<span class="tc ${cls}">${inner}</span>`;
  };
  // RP171: a subagent is NOT a chip: while it runs the bubble at the end of the thread says it, and once it ends one result line stays where the chip was (it survives a reload of the history). The name comes from
  // the `arg` of the item of the history (the page already receives it), validated; nothing else of the entry is read. What is not a name is left out: «Subagent working», «Subagent finished».
  const SUB_TOOL = 'subagent_run';
  const SUB_NAME = /^[A-Za-z0-9._-]{1,40}$/;
  const subNameOf = (c) => (c && typeof c.arg === 'string' && SUB_NAME.test(c.arg) ? c.arg : '');
  const subTime = (ms) => { const s = nat(ms) === null ? null : Math.round(ms / 1000); return s === null ? '' : ` · ${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
  const subDoneHtml = (c) => `<div class="m subrun done${c.ok ? '' : ' bad'}" role="status"><i class="sub-dot" aria-hidden="true">${SUB_ICON}</i> <span class="sub-text">Subagent${subNameOf(c) ? ` ${subNameOf(c)}` : ''} ${c.ok ? 'finished' : 'failed'}${subTime(c.ms)}</span></div>`;
  const toolsLine = (t, info, rx) => {
    const all = (Array.isArray(info) ? info : []).filter((c) => c && typeof c === 'object' && typeof c.name === 'string');
    if (!all.length) return toolsLineOld(t);
    const chips = all.filter((c) => c.name !== SUB_TOOL);
    const done = all.filter((c) => c.name === SUB_TOOL && typeof c.ok === 'boolean').map(subDoneHtml).join('');
    return (chips.length ? `<div class="tools tcs">${chips.slice(0, TOOL_CHIPS).map((c) => chipHtml(c, rx)).join('')}${chips.length > TOOL_CHIPS ? `<span class="tcmore">+${chips.length - TOOL_CHIPS}</span>` : ''}</div>${chips.slice(0, TOOL_CHIPS).map((c) => resultPanel(c, rx)).join('')}` : '') + done;
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
  // RP124: a Markdown table is a header line with a bar, then a separator line with the SAME number of cells (`---`, `:---`, `---:`, `:---:`), then body lines that still have a bar.
  // Cells are cut at the bars that are not escaped (`\|` stays a bar), each goes through mdInline (escaped, no HTML), the alignment is a CLASS (no inline style), a row is cut or padded
  // to the width of the head, and the columns and the rows are capped: what is over the cap is not lost, it is drawn after the table as the text it is.
  const TABLE_COLS = 30;
  const TABLE_ROWS = 300;
  function mdCells(line) {
    let t = line.trim();
    if (t.startsWith('|')) t = t.slice(1);
    if (t.endsWith('|') && !t.endsWith('\\|')) t = t.slice(0, -1);
    const cells = [];
    let cur = '';
    for (let i = 0; i < t.length; i++) {
      const c = t[i];
      if (c === '\\' && t[i + 1] === '|') { cur += '|'; i++; } else if (c === '|') { cells.push(cur.trim()); cur = ''; } else cur += c;
    }
    cells.push(cur.trim());
    return cells;
  }
  const mdSepCells = (l) => (l.includes('-') && mdCells(l).every((x) => /^:?-+:?$/.test(x)) ? mdCells(l) : null);
  function mdTableAt(lines, i) {
    if (i + 1 >= lines.length || !lines[i].includes('|')) return null;
    const sep = mdSepCells(lines[i + 1]);
    if (!sep) return null;
    const head = mdCells(lines[i]);
    return head.length === sep.length ? { head, sep } : null;
  }
  const mdAlign = (s) => (s[0] === ':' && s[s.length - 1] === ':' ? ' class="al-c"' : s[s.length - 1] === ':' ? ' class="al-r"' : '');
  function mdTable(lines, i, t) {
    const n = Math.min(t.head.length, TABLE_COLS);
    const al = t.sep.slice(0, n).map(mdAlign);
    const row = (cells, tag) => `<tr>${Array.from({ length: n }, (_, k) => `<${tag}${al[k]}>${mdInline(cells[k] || '', 0)}</${tag}>`).join('')}</tr>`;
    const body = [];
    let j = i + 2;
    for (; j < lines.length && lines[j].trim() && lines[j].includes('|') && body.length < TABLE_ROWS; j++) body.push(row(mdCells(lines[j]), 'td'));
    return { html: `<div class="md-table"><table><thead>${row(t.head, 'th')}</thead><tbody>${body.join('')}</tbody></table></div>`, next: j };
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
      let tb;
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
      } else if ((tb = mdTableAt(lines, i))) {
        const made = mdTable(lines, i, tb);
        out.push(made.html);
        i = made.next;
      } else {
        const para = [l];
        for (i++; i < lines.length && lines[i].trim() && !mdStarts(lines[i], d) && !mdTableAt(lines, i); i++) para.push(lines[i]);
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
  // RP162: a text the history cut says so under its words (`cut` is how many characters were left out; only a positive safe integer counts).
  const cutNote = (it) => (Number.isSafeInteger(it.cut) && it.cut > 0 ? `<div class="m-cut" role="note">Message cut: ${it.cut} more characters, see the rest in the terminal</div>` : '');
  const stopNote = (it) => (Object.hasOwn(STOP_NOTES, it.stop) ? `<div class="m stopnote ${it.stop}">${STOP_NOTES[it.stop]}</div>` : '');
  const bubble = (it, who, rx) => {
    const time = hhmm(it.at);
    if (it.role === 'system' && it.kind === 'shell') return shellHtml({ ...it, running: false, open: rx.open.includes(it.id), ...(typeof it.id === 'string' ? { key: it.id } : {}) }); // RP252: a ! or !! run the session file keeps
    if (it.role === 'system') return it.kind === 'compaction' ? `<div class="sysnote">↻ Context compacted${time ? ` · ${time}` : ''}</div>` : '';
    if (it.role === 'assistant' && !it.text) return `${thoughtLine(it)}${toolsLine(it.tools, it.toolInfo, rx)}${stopNote(it)}`; // RP171: no «working…» here: the tail of the thread is the one place that says the session works
    return `${thoughtLine(it)}${toolsLine(it.tools || [], it.toolInfo, rx)}<div class="m${it.role === 'user' ? ' me' : ''}"><span class="who">${esc(it.role === 'user' ? 'You' : who)}${time ? ` · ${time}` : ''}</span>${mdHtml(it.text)}${cutNote(it)}</div>${stopNote(it)}`;
  };

  // Pending messages of the composer (RP75): shown after the real ones until the history has them. `base` is how many user items
  // had the same flattened text when it was sent; more of them now means the history holds it.
  const flat = (t) => String(t).replace(/\s+/g, ' ').trim();
  const userCount = (items, text) => items.filter((it) => it.role === 'user' && flat(it.text) === flat(text)).length;
  // RP155: the live bubble of the session keeps its text until the run ends, while the history already holds the message that comes before a tool (it is saved as soon as it ends): the same message was drawn twice. The live
  // text counts as already in the history when it says the same as the LAST answer of the assistant with text that comes AFTER the last message of the person (an older run never hides a new message), spaces collapsed like the
  // pending messages do. Total: anything that is not a list of items, or not text, says no.
  const liveIsInHistory = (liveText, items) => {
    const live = typeof liveText === 'string' ? flat(liveText) : '';
    if (!live || !Array.isArray(items)) return false;
    for (let i = items.length - 1; i >= 0; i--) {
      const it = items[i];
      if (!it || typeof it !== 'object') continue;
      if (it.role === 'user') return false;
      // RP162: an item the history CUT is compared by its beginning (the live text is the whole answer)
      if (it.role === 'assistant' && typeof it.text === 'string' && it.text) return Number.isSafeInteger(it.cut) && it.cut > 0 ? live.startsWith(flat(it.text)) : flat(it.text) === live;
    }
    return false;
  };
  const PENDING_WHO = { sending: 'sending…', ok: '<span class="ok">✓</span>' };
  const pendingHtml = (pending, items) => (pending || []).filter((p) => userCount(items, p.text) <= p.base)
    .map((p) => `<div class="m me pending"><span class="who">You · ${PENDING_WHO[p.state] || PENDING_WHO.sending}</span>${mdHtml(p.text)}</div>`).join('');

  // RP166: options the assistant wrote as TEXT on the last line of its message (its selection tool is not available here, so it asks the person to type one). Deliberately strict: ONLY the last non-empty
  // line, which must be exactly [Siguiente:|Next:] verb [filler] 2 to 6 `options` joined by , / o or y and, with nothing else; each option is `[A-Za-z0-9_.:-]{1,40}` and distinct, and ONE bad option rejects
  // the whole line. Not inside a fence (or after an unclosed one), a quote, a list or indented code. Pure and total: anything odd gives [] (never a partial list). Work is capped: a text over 200000 characters, or a last
  // line cut by the 2000-character window, is never read.
  const QR_HEAD = /^(?:(?:siguiente|next):\s*)?(?:respond[eé](?: con)?|contest[aá](?: con)?|eleg[ií](?: una)?|(?:respond|answer|reply) with|choose|pick)(?:\s+(?:una de estas(?: (?:dos|tres|cuatro|cinco|seis))?|one of these|one of))?:?\s*(?=`)/i;
  const QR_SEP = /^(?:\s*\/\s*|\s*,\s*(?:(?:o|or|y|and)\s+)?|\s+(?:o|or|y|and)\s+)/i;
  const QR_OPTION = /^[A-Za-z0-9_.:-]{1,40}$/;
  const QR_HIDDEN = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/;
  function qrLine(text) {
    if (typeof text !== 'string' || text.length > 200000) return '';
    const t = text.replace(/\r\n?/g, '\n').trimEnd();
    if ((t.match(/^ {0,3}(?:`{3,}|~{3,})/gm) || []).length % 2) return ''; // an unclosed fence: the last line may be code
    const lines = t.slice(-2000).split('\n');
    const last = lines[lines.length - 1];
    if (lines.length === 1 && t.length > 2000 && t[t.length - 2001] !== '\n') return ''; // the window cut this line
    if (!last.trim() || QR_HIDDEN.test(last) || /^ {4}/.test(last) || /^\s*>/.test(last) || /^\s*(?:[-*+]|\d{1,9}[.)])\s/.test(last)) return '';
    return last.replace(/^[\s*_~]+|[\s*_~]+$/g, '');
  }
  function quickReplies(text) {
    const l = qrLine(text);
    const head = l ? QR_HEAD.exec(l) : null;
    if (!head) return [];
    let rest = l.slice(head[0].length).replace(/[.:?!]$/, '');
    const out = [];
    for (;;) {
      const m = /^`([^`]*)`/.exec(rest);
      if (!m || !QR_OPTION.test(m[1]) || m[1] === '__proto__' || out.includes(m[1]) || out.length >= 6) return [];
      out.push(m[1]);
      rest = rest.slice(m[0].length);
      if (!rest) return out.length >= 2 ? out : [];
      const sep = QR_SEP.exec(rest);
      if (!sep) return [];
      rest = rest.slice(sep[0].length);
    }
  }
  // RP246: a last line that is a yes/no question (it ends with «?», does not start with an asking word and offers no either-or) gets the two words in its
  // language: Sí/No when it has «¿» or a Spanish word, else Yes/No. An open question or one that offers alternatives keeps only Reply; null when it is not one.
  const QR_OPEN = /^(?:qu[eé]|c[oó]mo|cu[aá]l(?:es)?|cu[aá]ndo|d[oó]nde|ad[oó]nde|por ?qu[eé]|para qu[eé]|qui[eé]n(?:es)?|cu[aá]nt[oa]s?|what|how|which|why|when|where|who(?:m|se)?)(?![\p{L}\p{N}])/iu;
  const QR_EITHER = /\s(?:o|u|or)\s/i;
  const QR_ES = /[¿ñáéíóú]|(?<![\p{L}])(?:que|lo|la|los|las|te|me|se|sigo|quer[eé]s|parece|est[aá]|hago|subo|arreglo|dale|bien|esto|eso|ahora)(?![\p{L}])/iu;
  function yesNoOf(text) {
    const l = qrLine(text);
    if (!l || !/\?$/.test(l)) return null;
    const at = l.lastIndexOf('¿');
    const q = (at >= 0 ? l.slice(at + 1) : l).replace(/^[\s"'«(*_]+/, '');
    if (!q || QR_OPEN.test(q) || QR_EITHER.test(q)) return null;
    return at >= 0 || QR_ES.test(q) ? ['Sí', 'No'] : ['Yes', 'No'];
  }
  // What sits under the LAST message of the chat: { sig, options, reply } or null. Only when that message is the assistant's, whole (never cut), the last item of the chat, and the session is idle with no real dialog and
  // no message of this page pending. `sig` identifies THAT message (its place and a hash of its end): the click compares it with a fresh read, so a message that changed since the draw gets no send.
  function quickOf(c) {
    const items = c && c.hist && Array.isArray(c.hist.items) ? c.hist.items : [];
    const it = items[items.length - 1];
    const r = c && c.rpc && typeof c.rpc === 'object' ? c.rpc : null;
    if (!it || it.role !== 'assistant' || typeof it.text !== 'string' || !it.text || (it.cut !== undefined && it.cut !== null)) return null;
    if (!c.info || !c.info.adoptedFound || !r || r.state !== 'idle' || r.compacting === true || (Array.isArray(r.asks) ? r.asks.length : r.asks) || (Array.isArray(c.pending) ? c.pending.length : c.pending)) return null;
    if (!composerState(c).canSend) return null;
    const listed = quickReplies(it.text);
    const options = listed.length ? listed : yesNoOf(it.text) || []; // RP246: Yes and No for a yes/no question, sent as written
    const reply = !listed.length && /\?$/.test(qrLine(it.text));
    if (!options.length && !reply) return null;
    let h = 5381;
    for (const ch of it.text.slice(-2000)) h = ((h * 33) ^ ch.codePointAt(0)) >>> 0;
    return { sig: `${items.length - 1}:${it.text.length}:${h}`, options, reply };
  }
  const quickRow = (q) => (!q ? '' : `<div class="qr-row" role="group" aria-label="Quick replies">${q.options.map((o, i) => `<button type="button" class="qr" data-act="quick-reply" data-i="${i}">${esc(o)}</button>`).join('')}${q.reply ? '<button type="button" class="qr qr-reply" data-act="quick-focus">Reply</button>' : ''}</div>`);

  // What the live session adds under the history: the answer being written (escaped like every message) and one card per dialog pi waits for (RPC2-3).
  // The card is how the person answers a PERMISSION, so: everything is escaped, the message is shown as the session sends it, Deny comes first, and
  // (RP245, parity with the terminal) a text that may be cut or is not wholly visible is still answerable: the card adds a note instead of refusing (RP81 refused). The confirm has no «Allow always»; an «Allow…» select offers the options the session sends, in its order (RP237: the person chose parity
  // with the terminal). No key answers; every answer is a click.
  // RP245 (parity with the terminal, decided by the person): a cut or hidden text no longer blocks the answer; the card says so and keeps showing hidden characters.
  const CUT_NOTE = 'The text is cut or has hidden characters: it is the same preview the terminal shows';
  // An option the server cut cannot be answered (the session expects its whole text): in a truncated dialog, one at the 200-character cap is taken as cut.
  const OPTION_CUT = 'This option is cut: answer it in the terminal';
  const optionCut = (d, o) => !!d && d.truncated === true && typeof o === 'string' && o.length >= 200;
  // Only what the person can SEE counts: letters, numbers, punctuation, symbols, spaces and spacing marks, plus LF and TAB. Everything else (controls, zero-width,
  // bidi, combining marks and variation selectors, unassigned and private-use characters) is hidden: a whitelist by category, so no list of "bad characters"
  // has to be complete. A hidden character is SHOWN as a marker (⟦U+200B⟧) and a text that has one gets the note: what is read is not exactly what the agent
  // runs. The blank fillers are letters or symbols by category and are listed on their own.
  const HIDDEN = /[^\p{L}\p{N}\p{P}\p{S} \p{Mc}\n\t]|[\u115f\u1160\u3164\uffa0\u2800\u{1d159}\ufffc]/gu;
  const hasHidden = (t) => typeof t === 'string' && t.search(HIDDEN) >= 0;
  const visible = (t) => String(t == null ? '' : t).replace(HIDDEN, (ch) => `⟦U+${ch.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}⟧`);
  // «Allow…» read through invisibles and width (NFKC): a title that only looks different is still a permission.
  const allowTitle = (d) => d.method === 'select' && /^\s*allow/i.test(String(d.title == null ? '' : d.title).normalize('NFKC').replace(HIDDEN, ''));
  // The text is whole when it has something visible, no hidden character, and does not end in an ellipsis or dots (also the lookalikes and spaced dots:
  // «. . .»). A command that really ends in «..» gets the note too.
  function wholeText(m) {
    if (typeof m !== 'string' || hasHidden(m)) return false;
    const t = m.replace(/[\s\p{Mc}]+/gu, '');
    // RP237: a preview can also be cut at its START (Gentle Shell adds a leading «…» when the guarded action is far into the command). Only the ellipsis
    // characters count there: a command that starts with dots (../scripts/x.sh) is legitimate.
    return t !== '' && !/[\u2026\u2025\u22ef\ufe19\u22ee\u205d\u2d48\u1365]$|[.\uff0e\u2024\u3002\u00b7]{2,}$/u.test(t) && !/^[\u2026\u2025\u22ef\ufe19\u22ee\u205d\u2d48\u1365]/u.test(t);
  }
  // RP237: with the interactive variable Gentle Shell asks a guarded command as an «Allow…» select whose title carries the command preview on its second line and has no
  // message. Read that way, the first line is the question and the rest is the command, so the same rules apply as to a confirm's message.
  function askShape(d) {
    if (!d || typeof d !== 'object' || !allowTitle(d) || (typeof d.message === 'string' && d.message !== '') || typeof d.title !== 'string') return d;
    const at = d.title.indexOf('\n');
    return at < 0 ? d : { ...d, title: d.title.slice(0, at), message: d.title.slice(at + 1) };
  }
  // Whether the text is whole and visible (RP245: this only decides the note, it no longer withholds an approval). A confirm needs the server not to have cut it and the whole text. A select that is cut or
  // shows hidden characters gets the note (it is still answerable); an «Allow…» select also needs the whole text for no note; any other select is a plain question.
  function askAllowed(raw) {
    const d = askShape(raw);
    if (!d || typeof d !== 'object') return false;
    if (d.method === 'confirm') return d.truncated !== true && wholeText(d.message);
    if (d.method === 'select') {
      if (d.truncated === true || hasHidden(d.title) || (Array.isArray(d.options) ? d.options : []).some((o) => hasHidden(o))) return false;
      return allowTitle(d) ? wholeText(d.message) : true;
    }
    return true;
  }
  function askCard(raw, repo, busy) {
    const d = askShape(raw);
    const at = `data-act="rpc-answer" data-id="${esc(repo)}" data-request="${esc(d.requestId)}"`;
    const btn = (label, extra, tone, off) => `<button type="button" class="ask-btn ask-${tone}" ${at} ${extra}${off ? ` title="${OPTION_CUT}"` : ''}${busy || off ? ' disabled' : ''}>${esc(label)}</button>`;
    const ok = askAllowed(d);
    const field = d.method === 'editor' ? '<textarea class="ask-field" rows="5" maxlength="4000"></textarea>' : '<input type="text" class="ask-field" maxlength="4000">';
    let controls;
    if (d.method === 'confirm') controls = btn('Deny', 'data-kind="deny"', 'negative') + btn('Allow', 'data-kind="allow"', 'affirmative');
    else if (d.method === 'select') controls = ((Array.isArray(d.options) ? d.options : []).map((o, i) => btn(visible(o), `data-kind="option" data-index="${i}"`, /^\s*deny\s*$/i.test(String(o)) ? 'negative' : 'affirmative', optionCut(d, o))).join('')) + btn('Cancel', 'data-kind="cancel"', 'negative');
    else controls = field + btn('Send', 'data-kind="send"', 'affirmative') + btn('Cancel', 'data-kind="cancel"', 'negative');
    return `<div class="ch-ask" role="alert"><div class="ch-ask-title">${esc(visible(d.title) || 'The session is asking')}</div>${d.message ? `<pre class="ch-ask-text">${esc(visible(d.message))}</pre>` : ''}<div class="ch-ask-btns">${controls}</div>${ok ? '' : `<div class="ch-ask-warn" role="status">${CUT_NOTE}</div>`}</div>`;
  }
  // RP171: «Subagent working · NAME» + the clock, from the live count and start (c.rpc.subs, c.rpc.subSince) and the clock `now`. It says nothing unless the session is busy or asking and both numbers are valid. The
  // name is the one of the pending `subagent_run` item of the history, only when exactly one runs. The icon and the clock are hidden from screen readers: the bubble announces only that it appears and that it ends.
  const subBubbleHtml = (r, items, now) => {
    if ((r.state !== 'busy' && r.state !== 'asking') || !Number.isInteger(r.subs) || r.subs < 1 || !Number.isFinite(r.subSince) || r.subSince <= 0 || !Number.isFinite(now)) return '';
    const v = typeof module === 'object' && module.exports ? require('./view.js') : root.RepoPanelView;
    const open = items.flatMap((it) => (it && Array.isArray(it.toolInfo) ? it.toolInfo : [])).filter((c) => c && c.name === SUB_TOOL && c.ok == null);
    const name = r.subs === 1 && open.length ? subNameOf(open[open.length - 1]) : '';
    const words = r.subs > 1 ? `${r.subs} subagents working` : `Subagent working${name ? ` · ${name}` : ''}`;
    return `<div class="m subrun" role="status"><i class="sub-dot" aria-hidden="true">${SUB_ICON}</i> <span class="sub-text">${words}</span> <b class="sub-time" aria-hidden="true">${v.subClock(now - r.subSince)}</b></div>`;
  };
  function rpcTail(c, who, items = [], now) {
    const r = c.rpc && typeof c.rpc === 'object' ? c.rpc : {};
    // RP105c: while pi retries a failed request the tail says so (the attempt and the wait when they are known), instead of «working…»
    const rt = r.retry && typeof r.retry === 'object' ? r.retry : null;
    const retry = rt ? `<div class="m working">⟳ Retrying${Number.isInteger(rt.attempt) ? ` · attempt ${rt.attempt}${Number.isInteger(rt.max) ? ` of ${rt.max}` : ''}` : ''}${Number.isInteger(rt.delayMs) ? ` · in ${Math.max(1, Math.round(rt.delayMs / 1000))}s` : ''}</div>` : '';
    const hasLive = !!r.text && !liveIsInHistory(r.text, items); // RP155: a copy of what the history already shows is not drawn; the «working…» line takes its place while the run goes on
    const sub = subBubbleHtml(r, items, now); // RP171: while a subagent runs its bubble replaces the generic «working…» (never both)
    const streaming = (hasLive ? `<div class="m streaming"><span class="who">${esc(who)}</span>${mdHtml(r.text)}</div>` : '') + (sub || (!hasLive && r.streaming && !retry ? `<div class="m working">${r.thinking ? 'thinking…' : 'working…'}</div>` : '')) + retry;
    const asks = (Array.isArray(r.asks) ? r.asks : []).filter((d) => d && typeof d.requestId === 'string').map((d) => askCard(d, c.id, !!(c.askBusy && c.askBusy[d.requestId]))).join('');
    return shellHtml(r.bash) + streaming + asks; // RP245b: the shell command the person ran, live
  }

  // RP100 (S5, S7): pi does not lock its session files, so the panel cannot see that a session is open in a terminal. The hint it has is the last write of the session file (`updatedAt`): written to less
  // than 2 minutes ago, either side of now (a clock a little ahead still counts; a date far ahead must not warn forever). A terminal that is open but quiet is not detected: a hint, not a guarantee.
  const RECENT_MS = 2 * 60 * 1000;
  function recentlyActive(s, now) {
    if (!s || typeof s.updatedAt !== 'string' || !Number.isFinite(now)) return false;
    const t = Date.parse(s.updatedAt);
    return Number.isFinite(t) && Math.abs(now - t) < RECENT_MS;
  }

  // RP111b (artboard A, a grouped list): the Settings tab as a pure function of `m` = { state, options, prefs, pi, saved, error }. A row is label and description on the left, the
  // control on the right, and chips that say where it is saved and its default. The options of the PANEL go to the server through `setting-toggle` (and «pi to use» through the
  // route that already exists); the options of THIS BROWSER go through `pref-set`. What is not built yet is shown disabled and marked «Planned». Everything dynamic is escaped.
  const stSwitch = (id, on, attrs, disabled) => `<button type="button" class="st-sw" role="switch" aria-checked="${on === true}" aria-labelledby="${id}" ${attrs}${disabled ? ' disabled' : ''}></button><span class="st-state">${on === true ? 'On' : 'Off'}</span>`;
  const stSeg = (id, pref, current, choices) => `<span class="st-seg" role="group" aria-labelledby="${id}">${choices.map(([value, label]) => `<button type="button" aria-pressed="${String(current) === value}" data-act="pref-set" data-pref="${pref}" data-value="${value}">${label}</button>`).join('')}</span>`;
  // RP212: under 760 px the chips of a row (`.st-meta`) are folded behind a «Details» control (CSS shows it only there). The open rows live in `stOpen` (S.settings.open, so a redraw keeps them); a row is named by the id or `for` of its label.
  let stOpen = new Set();
  const stRow = (what, ctl, planned) => {
    const id = /(?:id|for)="([\w-]+)"/.exec(what);
    const open = !!id && stOpen.has(id[1]);
    const w = id && what.includes('<div class="st-meta">') ? what.replace('<div class="st-meta">', `<button type="button" class="st-fold" data-act="st-fold" data-key="${id[1]}" aria-expanded="${open}">Details</button><div class="st-meta${open ? ' is-open' : ''}">`) : what;
    return `<div class="st-row${planned ? ' is-planned' : ''}"><div class="st-what">${w}</div><div class="st-ctl">${ctl}</div></div>`;
  };
  const stMeta = (...chips) => `<div class="st-meta">${chips.join('')}</div>`;
  const stBrowser = (def) => stMeta('<span class="chip">Saved in this browser</span>', `<span class="chip">Default: ${def}</span>`);
  function settingsView(m) {
    const o = m && typeof m === 'object' ? m : {};
    stOpen = o.open instanceof Set ? o.open : new Set();
    const opts = o.options && typeof o.options === 'object' ? o.options : {};
    const p = o.prefs && typeof o.prefs === 'object' ? o.prefs : {};
    const pi = o.pi && typeof o.pi === 'object' && Array.isArray(o.pi.candidates) ? o.pi : null;
    const ready = o.state === 'ready';
    const runtimes = pi ? pi.candidates.filter((c) => c && typeof c === 'object' && c.available === true && typeof c.id === 'string') : [];
    const piOptions = [['auto', 'Auto'], ...runtimes.map((c) => [c.id, typeof c.label === 'string' ? c.label : c.id])];
    const piSelectHtml = pi
      ? `<select id="st-pi" data-pi-runtime aria-label="pi to use">${piOptions.map(([id, label]) => `<option value="${esc(id)}"${id === pi.mode ? ' selected' : ''}>${esc(label)}</option>`).join('')}</select>`
      : '<select id="st-pi" data-pi-runtime aria-label="pi to use" disabled><option>Loading…</option></select>';
    const detected = runtimes.map((c) => `${typeof c.label === 'string' ? c.label : c.id}${typeof c.version === 'string' && c.version ? ` ${c.version}` : ''}`).join(' · ');
    const panelChip = '<span class="chip blue">Panel</span>';
    const resultsRow = o.state === 'failed'
      ? '<div class="st-note">Settings of the panel are unavailable. Open the tab again to retry.</div>'
      : `<div class="st-rows">${stRow(
        `<label id="st-l-results">Show the result of a tool on click</label><p class="rs-sub">A click on a tool chip shows the first ~300 characters of what that tool returned.</p>
<div class="st-warn" role="note"><b>Privacy.</b> A result is free text and can hold secrets (for example the output of <code>cat .env</code>). It is cleaned, but no filter catches every form. The result of <code>read</code> is never shown.</div>${stMeta('<span class="chip blue">Saved in config.json · chat.showResults</span>', '<span class="chip">Default: off</span>')}`,
        stSwitch('st-l-results', opts['chat.showResults'] === true, 'data-act="setting-toggle" data-key="chat.showResults"', !ready),
      )}</div>`;
    // RP178: the notices of this browser. The switches come from notify.js (the same keys the page reads); a missing library or model leaves the section out.
    const nf = typeof module === 'object' && module.exports ? require('./notify.js') : root.RepoPanelNotify;
    const nv = p.notify && typeof p.notify === 'object' ? p.notify : null;
    const NOTE_ROWS = [['answer', 'The agent asks you a question'], ['ci', 'CI fails'], ['deliver', 'Work is done (ready for /flow-ship)'], ['merge', 'A PR is ready to merge'], ['start', 'A repo is clean (ready for /flow-next)'], ['sound', 'Sound'], ['system', 'System notification']];
    const noteKey = (k) => (nf.PREF[k] || (k === 'sound' ? 'notifySound' : 'notifySystem'));
    const noteHint = { granted: '', default: '<button type="button" data-act="notify-allow">Allow system notifications</button>', denied: '<span class="rs-sub">Blocked: allow notifications for this site in the browser settings.</span>', unsupported: '<span class="rs-sub">This browser has no system notifications.</span>' };
    // RP179: the push of THIS device (the page builds the model: supported, subscribed, permission); a phone must install the app first.
    const pv = p.push && typeof p.push === 'object' ? p.push : null;
    const pushCtl = !pv ? '' : !pv.supported ? '<span class="rs-sub">Not available here. On an iPhone: Share, Add to Home Screen, then open the installed app.</span>' : pv.permission === 'denied' ? '<span class="rs-sub">Blocked: allow notifications for this site in the browser settings.</span>' : pv.subscribed ? '<button type="button" data-act="push-test">Send a test push</button> <button type="button" data-act="push-disable">Disable</button>' : '<button type="button" data-act="push-enable">Enable</button>';
    const pushHtml = pv ? `<h3 class="st-h">Push notifications <span class="chip">This device</span></h3><div class="st-rows">${stRow('<label>Notices with the panel closed</label><p class="rs-sub">Reaches this device even with no page open, through the push service of Apple, Google, Microsoft or Mozilla. On an iPhone it needs the app added with Add to Home Screen.</p>', pushCtl)}</div>
` : '';
    const notifyHtml = nf && nv
      ? `<h3 class="st-h">Notifications <span class="chip">This browser</span></h3><div class="st-rows">${NOTE_ROWS.map(([k, label]) => stRow(`<label id="st-l-n-${k}">${label}</label>${stBrowser('on')}`, stSwitch(`st-l-n-${k}`, nv[k] === true, `data-act="pref-set" data-pref="${noteKey(k)}" data-value="${nv[k] === true ? 'false' : 'true'}"`, false))).join('')}${stRow(`<label>Test</label><p class="rs-sub">Nothing is shown while this panel is in view. A phone only hears it while the page is open.</p>${noteHint[nv.permission] || ''}`, '<button type="button" data-act="notify-test">Send a test notice</button>')}</div>
`
      : '';
    const status = o.error ? `<div class="st-status bad" role="status" aria-live="polite">${esc(String(o.error))}</div>` : `<div class="st-status" role="status" aria-live="polite">${esc(String(o.saved || ''))}</div>`;
    return `<div class="st"><h2>Settings</h2><p class="rs-sub">Each option says where it is saved. «Panel» options live in <code>config.json</code> and apply to every browser; «This browser» options stay in this browser only. A change is saved as soon as you make it.</p>
`
      + `<h3 class="st-h">Chat ${panelChip}</h3>${resultsRow}
`
      + `<h3 class="st-h">Pi ${panelChip}</h3><div class="st-rows">${stRow(`<label for="st-pi">pi to use</label><p class="rs-sub">Which program runs the sessions of each repo. Auto picks the first one that is installed.</p>${stMeta('<span class="chip blue">Saved in config.json · pi.runtime</span>', '<span class="chip">Default: Auto</span>', detected ? `<span class="chip">Detected: ${esc(detected)}</span>` : '')}`, piSelectHtml)}`
      + `${stRow(`<label for="st-env">Variables passed to the sessions</label><p class="rs-sub">The panel removes <code>PI_*</code>, <code>GENTLE_*</code> and <code>ENGRAM_*</code> from the environment of a session. List the ones Engram and your MCP servers need.</p>${stMeta('<span class="chip yellow">Planned · RP110</span>', '<span class="chip">Default: none</span>')}`, '<input id="st-env" value="ENGRAM_PROJECT" disabled aria-label="Variables passed to the sessions">', true)}</div>
`
      + `<h3 class="st-h">Delivery <span class="chip">This browser</span></h3><div class="st-rows">${stRow(`<label id="st-l-method">Merge method</label><p class="rs-sub">How the Merge button joins a pull request.</p>${stBrowser('squash')}`, stSeg('st-l-method', 'method', p.method, [['squash', 'squash'], ['merge', 'merge'], ['rebase', 'rebase']]))}`
      + `${stRow(`<label id="st-l-del">Delete the branch after merging</label>${stBrowser('on')}`, stSwitch('st-l-del', p.del === true, 'data-act="pref-set" data-pref="del" data-value="' + (p.del === true ? 'false' : 'true') + '"', false))}</div>
`
      + notifyHtml
      + pushHtml
      + `<h3 class="st-h">Visual <span class="chip">This browser</span></h3><div class="st-rows">${stRow(`<label id="st-l-diff">Diff view</label><p class="rs-sub">How the Changes tab draws a file.</p>${stBrowser('unified')}`, stSeg('st-l-diff', 'split', p.split === true, [['false', 'unified'], ['true', 'side by side']]))}`
      + `${stRow(`<label id="st-l-clean">Show clean repos as a column</label>${stBrowser('on')}`, stSwitch('st-l-clean', p.clean === true, 'data-act="pref-set" data-pref="cleanAsColumn" data-value="' + (p.clean === true ? 'false' : 'true') + '"', false))}</div>
`
      + `<h3 class="st-h">Director <span class="chip yellow">Planned · RP109</span></h3><div class="st-rows">${stRow(`<label for="st-par">Agents working in parallel</label><p class="rs-sub">How many repo agents the Director may run at once.</p>${stMeta('<span class="chip yellow">Planned · RP109</span>', '<span class="chip">Default: 3</span>')}`, '<select id="st-par" disabled aria-label="Agents working in parallel"><option>3</option></select>', true)}</div>
<h3 class="st-h">Work view</h3><div class="st-rows">${stRow('<p class="rs-sub">An older view of the repos as a board. It is not in the menu any more.</p>', '<button type="button" data-act="tab" data-tab="work">Open Work</button>')}</div>${status}</div>`;
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
    if (!info.adoptedFound) return `${note}<div class="ch-state" role="status"><p>The session is loading. The history appears with its first message.</p></div>${pendingHtml(c.pending, [])}${rpcTail(c, who, [], ctx.now)}`;
    const items = c.hist && Array.isArray(c.hist.items) ? c.hist.items : []; // RP155: a history that is not a list reads as empty
    const rx = { allow: !!c.hist && c.hist.results === true, map: c.results && typeof c.results === 'object' ? c.results : {}, id: c.id, open: c.shellOpen && Array.isArray(c.shellOpen[c.id]) ? c.shellOpen[c.id] : [] };
    const pending = pendingHtml(c.pending, items);
    return `${note}${c.hist && c.hist.truncated ? '<div class="rs-sub ch-older">Older messages are not shown</div>' : ''}${items.map((it) => bubble(it, who, rx)).join('') || (pending ? '' : '<div class="empty">No messages yet.</div>')}${pending}${rpcTail(c, who, items, ctx.now)}`;
  }

  // Pinned room card: the aggregate of its member rows. RP218: its folder is a repo with a session of its own, so when the room has its `id` the card opens that chat and counts the folder when it needs attention.
  function roomCard(room, rows, ctx) {
    const mine = rows.filter((r) => r.room === room.name);
    const folder = room.id ? rows.find((r) => r.id === room.id) : null;
    const sum = { total: null, completada: 0, enRevision: 0, bloqueada: 0, pendiente: 0, enCurso: 0 };
    for (const r of mine) {
      const p = r.progress;
      if (!p || p.total === null || p.total === undefined) continue;
      sum.total = num(sum.total) + num(p.total);
      for (const k of ['completada', 'enRevision', 'bloqueada', 'pendiente', 'enCurso']) sum[k] += num(p[k]);
    }
    const need = mine.filter((r) => r.needs).length + (folder && folder.needs && !mine.includes(folder) ? 1 : 0);
    const open = room.id ? ` data-id="${esc(room.id)}" data-act="chat-open" tabindex="0"${ctx && ctx.chatId === room.id ? ' aria-current="true"' : ''}` : '';
    return `<article class="rs-card rs-room"${open} aria-label="Room ${esc(room.name)}">
      <div class="rs-l1"><b class="rs-name" title="${esc(room.name)}">★ ${esc(room.name)}</b><span class="chip purple">room</span><span class="rs-spacer"></span><span class="rs-sub">last commit ${esc(relativeTime(room.lastCommit, ctx.now))}</span></div>
      <div class="rs-l2">${progressHtml(sum)}<div class="rs-next"><span class="rs-sub">${plural(mine.length, 'project')} · ${need} need attention</span></div></div>
    </article>`;
  }

  // RP121: the legend of the bars is the panel of the info icon in the header of the repos column (it used to sit under the cards behind a "?"): the four keys in two columns and the note about the button, in muted text.
  const legendHtml = () => '<div class="rs-legend-body"><span><i class="rs-key rs-done"></i>Completed</span><span><i class="rs-key rs-pr"></i>In review</span><span><i class="rs-key rs-blk"></i>Blocked</span><span><i class="rs-key rs-pend"></i>Pending</span><p class="rs-legend-note">The button on the right is the best next action</p></div>';

  // The view-specific part of the view bar: the one Needs attention toggle (the button sets the value it is NOT in); it sits next to the scope buttons (RP82).
  // RP121: with `ctx.compact` it is the icon of the repos column header (a flag and the count; the words are the label and the tooltip).
  function summaryTools(payload, ctx = {}) {
    if (!payload || !Array.isArray(payload.rows)) return '';
    const attention = ctx.filter === 'attention';
    const n = visibleRows(payload.rows, ctx).filter((r) => r.needs).length;
    if (ctx.compact) {
      // RP158: the icon of «Working now»: how many repos of the scope, group and text have a live session; the button sets the value it is NOT in. RP189: it is the only tool of the bar (Needs attention left it).
      const live = ctx.live === true;
      const nLive = visibleRows(payload.rows, { ...ctx, live: false }).filter(isLive).length;
      const dot = '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="8" cy="8" r="5.5"/><circle cx="8" cy="8" r="1.8" fill="currentColor"/></svg>';
      return `<button type="button" class="lh-ic lh-live${nLive ? ' on' : ''}" data-act="slive" data-live="${live ? 'off' : 'on'}" aria-pressed="${live}" aria-label="Working now · ${nLive}" title="Working now · ${nLive}">${dot}<small>${nLive}</small></button>`;
    }
    return `<button type="button" data-act="sfilter" data-filter="${attention ? 'all' : 'attention'}" aria-pressed="${attention}">Needs attention · ${n}</button>`;
  }

  // RP121: how many repos the list shows after every filter (the scope, the group, the text and Needs attention); null while there is no data.
  function listCount(payload, ctx = {}) {
    if (!payload || !Array.isArray(payload.rows)) return null;
    const rows = visibleRows(payload.rows, ctx);
    return ctx.filter === 'attention' ? rows.filter((r) => r.needs).length : rows.length;
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
      const rooms = ctx.roomData && Array.isArray(ctx.roomData.rooms) && scope.kind !== 'none' && !ctx.q && !(ctx.group && ctx.group !== 'all') && ctx.live !== true ? ctx.roomData.rooms.filter((m) => scope.kind === 'all' || m.name === scope.name) : [];
      const folders = new Set(rooms.map((m) => m.id).filter(Boolean)); // RP218: the folder of a shown room is that room's card, not a second card
      const groups = new Map();
      for (const r of rows) if (!folders.has(r.id)) groups.set(r.group ?? '', (groups.get(r.group ?? '') || []).concat(r));
      const parts = rooms.map((m) => roomCard(m, payload.rows, ctx));
      for (const [g, list] of groups) {
        const shut = groups.size > 1 && !!(ctx.collapsed && ctx.collapsed[g]);
        if (groups.size > 1) parts.push(`<button type="button" class="rs-group" data-act="toggle-group" data-group="${esc(g)}" aria-expanded="${!shut}"><span aria-hidden="true">${shut ? '▸' : '▾'}</span> ${esc(g)} <span class="mono">${list.length}</span></button>`);
        if (!shut) for (const r of list) parts.push(cardHtml(r, ctx));
      }
      const noLive = ctx.live === true && visibleRows(payload.rows, { ...ctx, live: false }).length > 0; // RP158: there are repos, none has a session
      body = rows.length ? parts.join('') : noLive ? '<div class="empty">No repository has a session open right now.</div>' : '<div class="empty">No repositories in this scope.</div>';
    }
    return `${ctx.failed ? '<div class="rs-note" role="status">⚠ Summary unavailable: showing the last data we have.</div>' : ''}<div class="rs-list">${body}</div>`;
  }

  return { tokensShort, yesNoOf, mergeSheetHtml, repoStatus, esc, mdHtml, settingsView, memoryChipHtml, modeChipHtml, ctxChipHtml, sessionTotals, compactButtonHtml, legendHtml, listCount, blockWidths, columnView, membersView, ROOM_COLUMN_TABS, treeFolderPaths, fileView, COLUMN_TABS, columnDetail, chatMenuHtml, headChipsHtml, statusIconsHtml, composerState, askAllowed, askCard, actionMenu, actionButtonsHtml, composerMergeHtml, composerNote, chatHead, optionCut, footButtons, busyBehavior, bashOf, shellHtml, SHELL_WAITS, steerRefusal, panelRefusal, queueRowHtml, notesView, notesStatus, tasksView, parseDiff, changesView, filesView, inputHistory, historyStep, canRecall, sessionState, sessionLabelHtml, sessionCloseHtml, sessionTerminalHtml, terminalBlockHtml, recentlyActive, chatBody, quickReplies, quickOf, quickRow, userCount, normalizeScope, filterRows, relativeTime, scopeBar, summaryView, summaryTools, visibleRows };
}));
