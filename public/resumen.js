'use strict';
// Pure helpers of the Summary tab (plain <script>, global RepoPanelResumen; CommonJS in tests). They take the payload of
// GET /api/summary and return HTML strings; no DOM, no network. Every text that comes from data goes through `esc`.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.RepoPanelResumen = api;
}(typeof self !== 'undefined' ? self : this, () => {
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
  function progressHtml(p) {
    if (!p || p.total === null || p.total === undefined) return noData;
    if (!p.total) return '<span class="rs-sub">no units</span>';
    const pending = num(p.pendiente) + num(p.enCurso);
    const seg = (cls, n) => `<i class="rs-seg ${cls}" style="width:${pct(num(n), num(p.total))}%"></i>`;
    const text = `${num(p.completada)} of ${num(p.total)} completed${p.enRevision ? ` · ${num(p.enRevision)} in review` : ''}${p.bloqueada ? ` · ${num(p.bloqueada)} blocked` : ''}`;
    return `<div class="rs-prog" title="${text}"><div class="rs-bar" role="img" aria-label="${text}">${seg('rs-done', p.completada)}${seg('rs-pr', p.enRevision)}${seg('rs-blk', p.bloqueada)}${seg('rs-pend', pending)}</div><span class="rs-sub rs-count">${num(p.completada)}/${num(p.total)}</span></div>`;
  }

  // The change chips of the board card (S55): `c` is { files, added, deleted, ahead, behind, noUpstream } or null (not loaded).
  function changeChips(c, id) {
    if (!c) return '';
    const files = num(c.files);
    return (files ? `<button class="chip yellow chip-btn" data-act="diff" data-id="${id}" title="View diff">● ${plural(files, 'file')} <span class="add">+${num(c.added)}</span> <span class="del">−${num(c.deleted)}</span></button>` : '')
      + (num(c.ahead) ? `<span class="chip blue">↑ ${num(c.ahead)} unpushed${c.noUpstream ? ' · no upstream' : ''}</span>` : '')
      + (num(c.behind) ? `<span class="chip gray">↓ ${num(c.behind)} behind</span>` : '');
  }

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
    if (a.kind === 'branch') return `<button class="primary" data-act="pi" data-id="${id}" data-cmd="flow-base" title="Send /flow-base to the open pi session of this repo"${sending}>/flow-base</button>`;
    if (a.kind === 'start') return `<button class="primary" data-act="pi" data-id="${id}" data-cmd="flow-next" title="Send /flow-next to the open pi session of this repo (starts ${esc(r.next ? r.next.id : '')})"${sending}>/flow-next</button>`;
    if (a.kind === 'deliver') {
      const f = ctx.flowFor ? ctx.flowFor(r.id) : null;
      return f
        ? `<button class="primary" data-act="pi" data-id="${id}" data-cmd="${esc(f.cmd)}" title="${esc(f.reason || `Send /${f.cmd} to the open pi session of this repo`)}"${f.disabled || sending ? ' disabled' : ''}>${esc(f.label)}</button>`
        : '<button class="primary" disabled title="This repo\'s local state is not loaded yet">Deliver</button>';
    }
    // answer and waiting get data-kind so the stylesheet can colour them amber; manual stays neutral.
    return open(`Open · ${a.label ?? ''}`, 'primary', a.kind === 'answer' || a.kind === 'waiting' ? a.kind : '');
  }

  // Two lines: name, branch, change chips, time, session; then bar, next unit, the action.
  function cardHtml(r, ctx) {
    const id = esc(r.id);
    const lm = r.lastMovement || {};
    const a = r.error ? null : r.action;
    const cls = r.session && r.session.state === 'waiting' ? ' ask' : !r.error && !r.next && (r.blocking || []).length ? ' block' : '';
    const chips = r.error ? '' : changeChips(ctx.changesFor ? ctx.changesFor(r.id) : null, id) + (a && a.kind === 'manual' ? '<span class="chip red">▲ manual action</span>' : '');
    return `<article class="rs-card${cls}" data-id="${id}" aria-label="${esc(r.name)}">
      <div class="rs-l1"><b class="rs-name" title="${esc(r.name)}">${esc(r.name)}</b><span class="mono rs-branch" title="${esc(r.branch ?? '')}">${esc(r.branch ?? '')}</span>${chips}<span class="rs-spacer"></span><span class="rs-sub rs-when" title="${esc(lm.what ?? '')}">${esc(relativeTime(lm.at, ctx.now))}</span>${r.error ? '<span class="chip red">▲ error</span>' : sessionChip(r.session && r.session.state)}</div>
      <div class="rs-l2">${r.error ? noData : progressHtml(r.progress)}${nextHtml(r)}${actionButton(r, ctx)}</div>
    </article>`;
  }

  // Pinned room card (not clickable yet): the aggregate of its member rows and the room session.
  const ROOM_SESSION = { idle: 'free', busy: 'working', closed: 'none' };
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
      <div class="rs-l1"><b class="rs-name" title="${esc(room.name)}">★ ${esc(room.name)}</b><span class="chip purple">room</span><span class="rs-spacer"></span><span class="rs-sub">last commit ${esc(relativeTime(room.lastCommit, ctx.now))}</span>${sessionChip(ROOM_SESSION[room.presence && room.presence.state] || 'unknown')}</div>
      <div class="rs-l2">${progressHtml(sum)}<div class="rs-next"><span class="rs-sub">${plural(mine.length, 'project')} · ${need} need attention</span></div></div>
    </article>`;
  }

  const LEGEND = '<div class="rs-legend" aria-label="Bar legend"><span><i class="rs-key rs-done"></i>Completed</span><span><i class="rs-key rs-pr"></i>In review</span><span><i class="rs-key rs-blk"></i>Blocked</span><span><i class="rs-key rs-pend"></i>Pending</span><span>The button on the right is the best next action</span></div>';

  // The view-specific part of the view bar: the one Needs attention toggle (the button sets the value it is NOT in) and the age.
  function summaryTools(payload, ctx = {}) {
    if (!payload || !Array.isArray(payload.rows)) return '';
    const attention = ctx.filter === 'attention';
    const n = visibleRows(payload.rows, ctx).filter((r) => r.needs).length;
    return `<button type="button" data-act="sfilter" data-filter="${attention ? 'all' : 'attention'}" aria-pressed="${attention}">Needs attention · ${n}</button><span class="rs-sub">updated ${esc(relativeTime(payload.generatedAt, ctx.now))}</span>`;
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

  return { esc, normalizeScope, filterRows, relativeTime, scopeBar, summaryView, summaryTools, visibleRows };
}));
