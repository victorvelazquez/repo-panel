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

  // Same classification as the server: each row once, error rows not counted.
  function countersOf(rows) {
    const c = { working: 0, waiting: 0, blocked: 0, idle: 0 };
    for (const r of rows) {
      if (r.error) continue;
      const s = r.session && r.session.state;
      if (s === 'waiting') c.waiting++;
      else if (s === 'working') c.working++;
      else if ((r.blocking || []).length) c.blocked++;
      else c.idle++;
    }
    return c;
  }

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

  function progressCell(p) {
    if (!p || p.total === null || p.total === undefined) return noData;
    if (!p.total) return '<span class="rs-sub">no units</span>';
    const pending = (p.pendiente || 0) + (p.enCurso || 0);
    const seg = (cls, n) => `<i class="rs-seg ${cls}" style="width:${pct(n, p.total)}%"></i>`;
    const label = `${p.completada} completed, ${p.enRevision} in review, ${p.bloqueada} blocked, ${pending} pending`;
    const more = (p.enRevision ? ` · ${p.enRevision} in review` : '') + (p.bloqueada ? ` · ${p.bloqueada} blocked` : '');
    return `<div class="rs-bar" role="img" aria-label="${label}">${seg('rs-done', p.completada)}${seg('rs-pr', p.enRevision)}${seg('rs-blk', p.bloqueada)}${seg('rs-pend', pending)}</div><span class="rs-sub">${p.completada} / ${p.total}${more}</span>`;
  }

  function nowCell(r) {
    if (r.error) return `<span class="chip red">▲ error</span><div class="rs-sub">${esc(r.error)}</div>`;
    const [color, text] = SESSION[r.session && r.session.state] || SESSION.unknown;
    const a = r.action;
    const note = a && ['answer', 'waiting', 'manual'].includes(a.kind) ? a.label : r.session && r.session.state === 'working' && r.next ? r.next.id : '';
    return `${a && a.kind === 'manual' ? '<span class="chip red">▲ manual action</span> ' : ''}<span class="chip ${color}">${text}</span>${note ? `<div class="rs-sub">${esc(clip(note, 90))}</div>` : ''}`;
  }

  const nextCell = (r) => (r.error || !r.next ? dash
    : `${esc(r.next.id)} — ${esc(clip(r.next.entrega ?? '', 80))}${/[^\s—–-]/.test(r.next.resultadoVisible ?? '') ? `<div class="rs-sub">Result: ${esc(clip(r.next.resultadoVisible, 80))}</div>` : ''}`);

  function blockedCell(r) {
    if (!(r.blocking || []).length) return dash;
    return r.blocking.map((b) => {
      const waits = [...(b.waitsFor || []), ...(b.external || [])];
      return `<div><span class="chip red">■ ${esc(b.unit)} ${waits.length ? `waits for ${esc(waits.join(', '))}` : 'is blocked'}</span></div>`;
    }).join('');
  }

  // ONE primary button reusing the page's own data-act machinery, plus "⋯" (which for now focuses the repo in Work).
  function actionCell(r, ctx) {
    const id = esc(r.id);
    const a = r.error ? null : r.action;
    // The visible label is clipped; the full text stays in title and aria-label.
    const open = (text, cls = '') => `<button${cls ? ` class="${cls}"` : ''} data-act="focus-repo" data-id="${id}" title="${esc(text)}" aria-label="${esc(text)}">${esc(clip(text, LABEL_MAX))}</button>`;
    let main = r.error ? open('Open') : '';
    const sending = ctx.sending && ctx.sending[r.id] ? ' disabled' : '';
    if (a && a.kind === 'merge') main = `<button class="merge" data-act="merge" data-id="${id}" data-n="${esc(a.pr)}" title="Merge #${esc(a.pr)}" aria-label="Merge #${esc(a.pr)}"${ctx.busy && ctx.busy[`${r.id}:${a.pr}`] ? ' disabled' : ''}>${esc(clip(`Merge #${a.pr}`, LABEL_MAX))}</button>`;
    else if (a && a.kind === 'branch') main = `<button class="primary" data-act="pi" data-id="${id}" data-cmd="flow-base" title="Send /flow-base to the open pi session of this repo"${sending}>/flow-base</button>`;
    else if (a && a.kind === 'deliver') {
      const f = ctx.flowFor ? ctx.flowFor(r.id) : null;
      main = f
        ? `<button class="primary" data-act="pi" data-id="${id}" data-cmd="${esc(f.cmd)}" title="${esc(f.reason || `Send /${f.cmd} to the open pi session of this repo`)}"${f.disabled || sending ? ' disabled' : ''}>${esc(f.label)}</button>`
        : '<button class="primary" disabled title="This repo\'s local state is not loaded yet">Deliver</button>';
    } else if (a && a.kind === 'start') main = open(`Start ${r.next ? r.next.id : ''}`.trim(), 'primary');
    else if (a) main = open('Open', 'primary');
    return `<div class="rs-act">${main}<button data-act="focus-repo" data-id="${id}" aria-label="More actions for ${esc(r.name)}" title="Show this repo in the Work tab">⋯</button></div>`;
  }

  function rowHtml(r, ctx) {
    const lm = r.lastMovement || {};
    return `<tr class="rs-row">
      <td class="rs-proj"><div class="rs-name" title="${esc(r.name)}">${esc(r.name)}</div><div class="rs-sub mono rs-branch" title="${esc(r.branch ?? '')}">${esc(r.branch ?? '')}</div></td>
      <td>${r.error ? noData : progressCell(r.progress)}</td>
      <td>${nowCell(r)}</td>
      <td>${nextCell(r)}</td>
      <td>${r.error ? dash : blockedCell(r)}</td>
      <td class="rs-sub">${esc(relativeTime(lm.at, ctx.now))}${lm.what ? `<br>${esc(clip(lm.what, 60))}` : ''}</td>
      <td>${actionCell(r, ctx)}</td>
    </tr>`;
  }

  function tableHtml(rows, ctx) {
    const body = [];
    let group;
    for (const r of rows) {
      if (r.group !== group) { group = r.group; body.push(`<tr class="rs-group"><td colspan="7">${esc(group ?? '')}</td></tr>`); }
      body.push(rowHtml(r, ctx));
    }
    return `<table class="rs-table"><thead><tr><th scope="col">Project</th><th scope="col">Progress</th><th scope="col">Now</th><th scope="col">Next</th><th scope="col">Blocked by</th><th scope="col">Last movement</th><th scope="col" class="rs-right">Action</th></tr></thead><tbody>${body.join('')}</tbody></table>`;
  }

  const LEGEND = '<div class="rs-legend" aria-label="Bar legend"><span><i class="rs-key rs-done"></i>Completed</span><span><i class="rs-key rs-pr"></i>In review</span><span><i class="rs-key rs-blk"></i>Blocked</span><span><i class="rs-key rs-pend"></i>Pending</span><span>The main button is the best next action; ⋯ shows the repo in Work</span></div>';

  // ctx: { now, scope, rooms, failed, flowFor(id), sending, busy }
  function summaryView(payload, ctx = {}) {
    if (!payload || !Array.isArray(payload.rows)) {
      return `<div class="empty" role="status">${ctx.failed ? 'Summary unavailable. Is the panel server up to date? Try Refresh.' : 'Loading summary…'}</div>`;
    }
    const scope = normalizeScope(ctx.scope, ctx.rooms);
    const rows = filterRows(payload.rows, scope);
    const ids = new Set(rows.map((r) => r.id));
    const att = (payload.attention || []).filter((a) => ids.has(a.id));
    const c = countersOf(rows);
    const kpi = (cls, n, label) => `<div class="rs-kpi ${cls}"><b>${n}</b><span>${label}</span></div>`;
    const list = att.length
      ? `<ul>${att.map((a) => `<li>▲ <button type="button" class="rs-link" data-act="focus-repo" data-id="${esc(a.id)}">${esc(a.name)}</button> — ${esc(a.why)}</li>`).join('')}</ul>`
      : '<p class="rs-sub">Nothing needs you right now.</p>';
    return `${ctx.failed ? '<div class="rs-note" role="status">⚠ Summary unavailable: showing the last data we have.</div>' : ''}
      <section class="rs-kpis" aria-label="State of the projects">${kpi('go', c.working, '● working')}${kpi('wait', c.waiting, '◐ waiting for you')}${kpi('block', c.blocked, '■ blocked')}${kpi('idle', c.idle, '○ idle')}
      <div class="rs-attn"><h2>Needs your attention (${att.length})</h2>${list}</div></section>
      <div class="rs-toolbar"><span class="rs-sub">${rows.length} repo${rows.length === 1 ? '' : 's'} · updated ${esc(relativeTime(payload.generatedAt, ctx.now))}</span></div>
      ${rows.length ? tableHtml(rows, ctx) + LEGEND : '<div class="empty">No repositories in this scope.</div>'}`;
  }

  return { esc, normalizeScope, filterRows, countersOf, relativeTime, scopeBar, summaryView };
}));
