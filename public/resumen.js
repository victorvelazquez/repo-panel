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
  // The small marker of a row served from memory while a fact is being refreshed (RP78); the title names the facts.
  const staleMark = (r) => (r.stale && Array.isArray(r.stale.facts) && r.stale.facts.length
    ? `<span class="rs-sub rs-stale" title="Updating: ${r.stale.facts.map(esc).join(', ')}">Updating…</span>` : '');

  // Two lines: name, branch, change chips, time, session; then bar, next unit, the action.
  function cardHtml(r, ctx) {
    const id = esc(r.id);
    if (r.loading) return loadingCard(r, id);
    const lm = r.lastMovement || {};
    const a = r.error ? null : r.action;
    const cls = r.session && r.session.state === 'waiting' ? ' ask' : !r.error && !r.next && (r.blocking || []).length ? ' block' : '';
    const chips = r.error ? '' : changeChips(ctx.changesFor ? ctx.changesFor(r.id) : null, id) + (a && a.kind === 'manual' ? '<span class="chip red">▲ manual action</span>' : '');
    return `<article class="rs-card${cls}" data-id="${id}" data-act="chat-open" tabindex="0"${ctx.chatId === r.id ? ' aria-current="true"' : ''} aria-label="${esc(r.name)}">
      <div class="rs-l1"><b class="rs-name" title="${esc(r.name)}">${esc(r.name)}</b><span class="mono rs-branch" title="${esc(r.branch ?? '')}">${esc(r.branch ?? '')}</span>${chips}<span class="rs-spacer"></span><span class="rs-sub rs-when" title="${esc(lm.what ?? '')}">${esc(relativeTime(lm.at, ctx.now))}</span>${r.error ? '<span class="chip red">▲ error</span>' : sessionChip(r.session && r.session.state)}${r.error ? '' : staleMark(r)}</div>
      <div class="rs-l2">${r.error ? noData : progressHtml(r.progress)}${nextHtml(r)}${actionButton(r, ctx)}</div>
    </article>`;
  }

  // The chat panel (RP54, S48/S53). Pure like the rest: the page passes S.chat ({ id, info, hist, failed, starting }).
  const CHAT_MIN = 340;
  const CARDS_MIN = 360;
  // Width of the chat for a layout of `total` px: the stored ratio, or 40% (50% under 1100 px), never under 340 and never leaving the cards under 360.
  const chatWidth = (total, ratio) => {
    const r = ratio > 0 ? Math.min(0.9, Math.max(0.1, ratio)) : (total < 1100 ? 0.5 : 0.4);
    return Math.max(CHAT_MIN, Math.min(Math.round(total * r), total - CARDS_MIN));
  };
  const liveOf = (c) => (c.info && c.info.live && c.info.live.state) || 'unknown';
  // The state of the adopted session, shown inside the composer frame (RP72). Icon + word, never colour alone.
  const SESS_TITLE = {
    loading: 'Loading the session', none: 'No session adopted for this repo', closed: 'The adopted session is not open any more',
    free: 'The session is free: you can write to it', working: 'The session is working', waiting: 'Answer it in its terminal: the panel does not answer yet.',
    unknown: 'The session state is unknown',
  };
  const SESS_VIEW = {
    loading: ['gray', '○', 'loading…'], none: ['gray', '○', 'no session'], closed: ['gray', '○', 'session closed'], free: ['gray', '○', 'free'],
    working: ['green', '●', 'working…'], waiting: ['yellow', '◐', 'asking you something'], unknown: ['gray', '?', 'unknown'],
  };
  function sessionState(c) {
    const info = c.info;
    let key;
    if (!info) key = 'loading';
    else if (!info.adopted) key = 'none';
    else if (!info.adoptedFound) key = 'loading';
    else key = { none: 'closed', free: 'free', working: 'working', waiting: 'waiting' }[liveOf(c)] || 'unknown';
    const [tone, icon, word] = SESS_VIEW[key];
    return { key, tone, icon, word: info && info.adopted && key === 'loading' ? `session ${word}` : word, title: SESS_TITLE[key], animate: key === 'working' };
  }
  const sessionLabelHtml = (c) => {
    const s = sessionState(c);
    return `<span class="ss ss-${s.tone} ss-${s.key}${s.animate ? ' ss-anim' : ''}" role="status" title="${esc(s.title)}"><i class="ss-dot" aria-hidden="true">${s.icon}</i> ${s.word}</span>`;
  };

  // The header: the repo name (the session id is only its tooltip) and the close button.
  function chatHead(c, ctx = {}) {
    const adopted = c.info && c.info.adopted;
    const tip = adopted ? `${ctx.name} · ${adopted.id}` : ctx.name;
    return `<div class="ch-row"><b class="ch-name" title="${esc(tip)}">${esc(ctx.name)}</b><button type="button" class="x" data-act="chat-close" aria-label="Close the chat" title="Close the chat (Esc)">✕</button></div>`;
  }

  // The composer (RP68, S49): can the person send free text now, and if not, why. c = { id, info, sending }.
  const REASON = {
    working: 'The session is working: wait until it is free', waiting: 'The session is asking you something: answer it in its terminal',
    none: 'No open session of this repo', unknown: 'The session state is unknown',
  };
  function composerState(c, ctx = {}) {
    const info = c.info;
    let reason = '';
    if (!info) reason = 'Loading the chat…';
    else if (!info.adopted) reason = 'Adopt or start a session first';
    else if (!info.adoptedFound) reason = 'The session is loading';
    else if (c.sending) reason = 'Sending…';
    else if (liveOf(c) !== 'free') reason = REASON[liveOf(c)] || REASON.unknown;
    return { canSend: !reason, reason, placeholder: reason || `Message the session of ${ctx.name ?? 'this repo'}` };
  }

  // The "/ Actions" menu: always the four flow commands in a fixed order, each available or not with the reason. A deliver or
  // branch flow button (unstage, stash, disabled with a reason) takes the slot of its command. ctx = { live, changes, flow }.
  const SLOTS = [['flow-next', '/flow-next'], ['flow-commit', '/flow-commit'], ['flow-pr', '/flow-pr'], ['flow-base', '/flow-base']];
  function actionMenu(row, ctx = {}) {
    const items = SLOTS.map(([cmd, label]) => ({ cmd, label, available: false, why: '' }));
    const live = ctx.live || 'unknown';
    if (live !== 'free') {
      const why = composerState({ info: { adopted: true, adoptedFound: true, live: { state: live } } }).reason;
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
  function actionMenuHtml(menu, id) {
    const item = (i) => (i.available
      ? `<button type="button" class="opt" role="menuitem" data-act="pi" data-id="${esc(id)}" data-cmd="${esc(i.cmd)}"><code>${esc(i.label)}</code><span class="why">${esc(i.why)}</span></button>`
      : `<button type="button" class="opt" role="menuitem" disabled data-cmd="${esc(i.cmd)}"><code>${esc(i.label)}</code><span class="why">${esc(i.why)}</span></button>`);
    const yes = menu.items.filter((i) => i.available);
    const no = menu.items.filter((i) => !i.available);
    return `<h4>Available now</h4>${yes.map(item).join('') || '<div class="why">Nothing to run right now</div>'}${no.length ? `<h4>Not available</h4>${no.map(item).join('')}` : ''}`;
  }
  // The line under the box: a message, plus the Clear button when text stayed in the prompt box of pi.
  const composerNote = (n) => (n && n.text ? `<span>${esc(n.text)}</span>${n.clear ? ` <button type="button" data-act="chat-clear" data-id="${esc(n.id)}">Clear the box</button>` : ''}` : '');

  const hhmm = (iso) => { const d = new Date(iso); return iso && !Number.isNaN(d.getTime()) ? `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}` : ''; };
  const toolsLine = (t) => (t.length ? `<div class="tools">▸ ${plural(t.length, 'tool')} · ${esc(t.slice(0, 3).join(', '))}${t.length > 3 ? ` (+${t.length - 3})` : ''}</div>` : '');
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

  const bubble = (it, who) => {
    const time = hhmm(it.at);
    if (it.role === 'assistant' && !it.text) return `${toolsLine(it.tools)}<div class="m working">working…</div>`;
    return `${toolsLine(it.tools || [])}<div class="m${it.role === 'user' ? ' me' : ''}"><span class="who">${esc(it.role === 'user' ? 'You' : who)}${time ? ` · ${time}` : ''}</span>${mdHtml(it.text)}</div>`;
  };

  // Pending messages of the composer (RP75): shown after the real ones until the history has them. `base` is how many user items
  // had the same flattened text when it was sent; more of them now means the history holds it.
  const flat = (t) => String(t).replace(/\s+/g, ' ').trim();
  const userCount = (items, text) => items.filter((it) => it.role === 'user' && flat(it.text) === flat(text)).length;
  const PENDING_WHO = { sending: 'sending…', ok: '<span class="ok">✓</span>', unconfirmed: '<span class="warn">⚠</span> not confirmed' };
  const pendingHtml = (pending, items) => (pending || []).filter((p) => userCount(items, p.text) <= p.base)
    .map((p) => `<div class="m me pending"><span class="who">You · ${PENDING_WHO[p.state] || PENDING_WHO.sending}</span>${mdHtml(p.text)}</div>`).join('');

  function chatBody(c, ctx = {}) {
    const info = c.info;
    if (!info) return `<div class="empty" role="status">${c.failed ? 'Chat unavailable. Try again in a moment.' : 'Loading chat…'}</div>`;
    const note = c.failed ? '<div class="rs-note" role="status">⚠ Chat unavailable: showing the last data we have.</div>' : '';
    const id = esc(c.id);
    if (!info.adopted) {
      const rows = (info.sessions || []).slice(0, 5).map((s) => `<div class="ch-pick"><div class="ch-pick-l1"><span class="mono ch-sname" title="${esc(s.id)}">${esc(s.name || s.id)}</span><span class="rs-sub">${esc(relativeTime(s.updatedAt, ctx.now))}</span><button type="button" data-act="chat-adopt" data-id="${id}" data-session="${esc(s.id)}">Adopt</button></div>${s.lastMessage ? `<div class="rs-sub ch-last">${esc(clip(s.lastMessage.text, 90))}</div>` : ''}</div>`).join('');
      return `${note}<div class="ch-state"><p>No session is adopted for this folder.${rows ? ' Adopt one, or start a new one.' : ''}</p>${rows}<button type="button" data-act="chat-start" data-id="${id}"${c.starting ? ' disabled' : ''}>Start panel session</button></div>`;
    }
    if (!info.adoptedFound) return `${note}<div class="ch-state" role="status"><p>The session is loading. The history appears with its first message.</p></div>`;
    const who = info.adopted.name || info.adopted.id;
    const items = (c.hist && c.hist.items) || [];
    // The question the session shows on its screen, pinned after the bubbles; read-only.
    const d = info.live && info.live.state === 'waiting' ? info.live.dialog || {} : null;
    const shown = d && Array.isArray(d.lines) ? d.lines.map((l, i) => (i === d.selected ? `<mark class="ask-sel">${esc(l)}</mark>` : esc(l))).join('\n') : '';
    const card = d ? `<div class="ch-ask" role="alert"><div class="ch-ask-title">The session is asking</div>${shown ? `<pre class="ch-ask-text">${shown}</pre>` : ''}${askAnswers(d.choices, c.answer)}</div>` : '';
    const pending = pendingHtml(c.pending, items);
    return `${note}${c.hist && c.hist.truncated ? '<div class="rs-sub ch-older">Older messages are not shown</div>' : ''}${items.map((it) => bubble(it, who)).join('') || (pending ? '' : '<div class="empty">No messages yet.</div>')}${pending}${card}`;
  }

  // The answer buttons of the pinned question (RP73): one per option the server could read (dialog.choices), or the old note when there
  // is none. `answer` is what this page did with the question ({ fp, state: sending | ok | error, text }) and counts only for the same fingerprint.
  // An affirmative option of a cut-off question is disabled; every label and the fingerprint go through esc.
  function askAnswers(ch, answer) {
    if (!ch || !Array.isArray(ch.options) || !ch.options.length) return '<div class="ch-ask-note">Answer it in the terminal of the session: the panel does not answer yet.</div>';
    const mine = answer && answer.fp === ch.fingerprint ? answer : null;
    const locked = !!mine && mine.state !== 'error';
    const buttons = ch.options.map((o, i) => {
      const cut = !ch.complete && o.tone !== 'negative';
      const title = cut ? ' title="The question is cut off, so the panel will not approve it: use the terminal"' : '';
      return `<button type="button" class="ask-btn ${o.tone === 'negative' ? 'ask-negative' : 'ask-affirmative'}" data-act="dialog-answer" data-index="${i}" data-fp="${esc(ch.fingerprint)}"${locked || cut ? ' disabled' : ''}${title}>${esc(o.label)}</button>`;
    }).join('');
    const status = !mine ? '' : mine.state === 'sending' ? '<div class="ch-ask-sending" role="status">Sending the answer…</div>'
      : mine.state === 'ok' ? `<div class="ch-ask-done" role="status">Answered: ${esc(mine.text)}</div>` : `<div class="ch-ask-error" role="status">${esc(mine.text)}</div>`;
    const warn = ch.options.some((o) => !ch.complete && o.tone !== 'negative') ? '<div class="ch-ask-warn" role="status">The question is cut off, so only the answers that refuse are offered. To approve it, use the terminal.</div>' : '';
    return `<div class="ch-ask-btns">${buttons}</div>${warn}<div class="ch-ask-note">Pick an answer, or answer it in the terminal.</div>${status}`;
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

  return { esc, mdHtml, sessionChip, chatWidth, composerState, actionMenu, actionMenuHtml, composerNote, chatHead, sessionState, sessionLabelHtml, chatBody, userCount, normalizeScope, filterRows, relativeTime, scopeBar, summaryView, summaryTools, visibleRows };
}));
