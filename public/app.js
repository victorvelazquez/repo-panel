'use strict';
const TOKEN = document.querySelector('meta[name=token]').content;
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const store = (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } };

const S = {
  groups: [], local: {}, prs: {}, loading: {}, busy: {},
  snoozed: new Set(), keepSnoozed: new Set(), snoozedOpen: {}, onlyProblems: false,
  group: '', q: '',
  prefs: store('prefs', { method: 'squash', del: true }),
  lastRefresh: 0, scan: [],
};

// ---------- api + request pool ----------
async function api(url, body) {
  const res = await fetch(url, {
    method: body ? 'POST' : 'GET',
    headers: { 'x-token': TOKEN, 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({ error: 'Invalid server response' }));
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

const queue = [];
let running = 0;
function pooled(fn) {
  return new Promise((resolve, reject) => { queue.push({ fn, resolve, reject }); pump(); });
}
function pump() {
  while (running < 6 && queue.length) {
    const j = queue.shift();
    running++;
    j.fn().then(j.resolve, j.reject).finally(() => { running--; pump(); });
  }
}

function toast(msg, kind = '') {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = msg;
  $('#toasts').append(el);
  setTimeout(() => el.remove(), kind === 'bad' ? 7000 : 3500);
}

// ---------- data ----------
const allRepos = () => S.groups.flatMap((g) => g.repos.map((r) => ({ ...r, group: g.name })));

async function loadConfig() {
  const cfg = await api('/api/config');
  S.groups = cfg.groups;
  S.snoozed = new Set();
  S.keepSnoozed = new Set();
  for (const k of cfg.snoozed) {
    const base = k.replace(/:ready$/, '');
    S.snoozed.add(base);
    if (base !== k) S.keepSnoozed.add(base);
  }
  $('#groupList').innerHTML = S.groups.map((g) => `<option value="${esc(g.name)}">`).join('');
  $('#groupFilter').innerHTML = `<option value="">All groups</option>${S.groups.map((g) => `<option ${S.group === g.name ? 'selected' : ''}>${esc(g.name)}</option>`).join('')}`;
}

function track(id, p) {
  S.loading[id] = (S.loading[id] || 0) + 1;
  draw();
  return p.finally(() => { S.loading[id]--; draw(); });
}

function refreshRepo(id) {
  return Promise.all([
    track(id, pooled(() => api(`/api/local?id=${id}`)).then((d) => { S.local[id] = d; }, (e) => { S.local[id] = { error: e.message }; })),
    track(id, pooled(() => api(`/api/prs?id=${id}`)).then((d) => { S.prs[id] = d; wakeReady(id, d); }, (e) => { S.prs[id] = { error: e.message }; })),
  ]);
}

// A PR snoozed while still blocked is woken up when it becomes ready to merge. One snoozed while
// already ready was parked on purpose, so it stays parked until the user brings it back.
function wakeReady(id, d) {
  for (const pr of d.prs || []) {
    if (pr.ready && S.snoozed.has(snoozeKey(id, pr.number)) && !S.keepSnoozed.has(snoozeKey(id, pr.number))) setSnooze(id, pr.number, false, true);
  }
}

async function refreshAll() {
  S.lastRefresh = Date.now();
  await Promise.all(allRepos().map((r) => refreshRepo(r.id)));
}

async function fetchRepo(id) {
  try { await track(id, pooled(() => api('/api/fetch', { id }))); } catch (e) { toast(`${nameOf(id)}: ${e.message}`, 'bad'); }
  await refreshRepo(id);
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

const nameOf = (id) => allRepos().find((r) => r.id === id)?.name || id;

// ---------- derived state ----------
function info(r) {
  const l = S.local[r.id] || {};
  const p = S.prs[r.id] || {};
  const prs = p.prs || [];
  return {
    l, p, prs,
    dirty: (l.files || []).length > 0,
    unpushed: (l.ahead || 0) > 0,
    ready: prs.filter((x) => x.ready).length,
  };
}

function visibleRepos() {
  const q = S.q.toLowerCase();
  return allRepos().filter((r) => (!S.group || r.group === S.group) && (!q || r.name.toLowerCase().includes(q)));
}

// ---------- board ----------
let raf = 0;
function draw() { if (!raf) raf = requestAnimationFrame(() => { raf = 0; render(); }); }

const COLUMNS = [
  { key: 'clean', title: 'Clean', hint: 'Nothing to do' },
  { key: 'changes', title: 'Changes', hint: 'Uncommitted files' },
  { key: 'committed', title: 'Committed', hint: 'Commits not pushed yet' },
  { key: 'progress', title: 'Open PRs', hint: 'Checks running, waiting for review or needing a fix (red = needs attention)' },
  { key: 'ready', title: 'Ready to merge', hint: 'All checks passed' },
];

// A PR that cannot merge because of something the user must fix.
const isProblem = (pr) => !pr.ready && (pr.checks.state === 'failed' || ['DIRTY', 'BEHIND'].includes(pr.mergeStateStatus));

const prColumn = (pr) => (pr.ready ? 'ready' : 'progress');

// One card per pending thing: a repo can have a local card plus one card per open PR.
function buildCards() {
  const cols = Object.fromEntries(COLUMNS.map((c) => [c.key, []]));
  const parked = Object.fromEntries(COLUMNS.map((c) => [c.key, []]));
  let problems = 0;
  // Problem cards go first in their column; with the problems filter on, only they are shown.
  const add = (key, html, attn) => {
    if (attn) { problems++; cols[key].unshift(html); } else if (!S.onlyProblems) cols[key].push(html);
  };
  for (const r of visibleRepos()) {
    if (!S.local[r.id] || !S.prs[r.id]) continue; // first load still running
    const { l, p, prs, dirty, unpushed } = info(r);
    if (l.error) add('changes', repoCard(r, true), true);
    else if (dirty) add('changes', repoCard(r), false);
    else if (unpushed) add('committed', repoCard(r), false);
    else if (!prs.length) add('clean', cleanRow(r), false);
    for (const pr of prs) {
      const key = prColumn(pr);
      if (S.snoozed.has(snoozeKey(r.id, pr.number))) { if (!S.onlyProblems) parked[key].push(snoozedRow(r, pr)); }
      else add(key, prCard(r, pr, p.repo), isProblem(pr));
    }
  }
  return { cols, parked, problems };
}

function snoozedRow(r, pr) {
  return `<div class="snoozed-row">
    <a href="${esc(pr.url)}" target="_blank" rel="noopener" title="${esc(`${r.name} · ${pr.title}`)}"><span class="muted">${esc(r.name)}</span> #${pr.number} ${esc(pr.title)}</a>
    <button data-act="unsnooze" data-id="${r.id}" data-n="${pr.number}" title="Bring back to the board">⏰</button>
  </div>`;
}

function snoozedBlock(key, rows) {
  if (!rows.length) return '';
  const open = !!S.snoozedOpen[key];
  return `<div class="snoozed">
    <div class="snoozed-head" data-act="toggle-snoozed" data-col="${key}"><span>${open ? '▾' : '▸'}</span> Snoozed (${rows.length})</div>
    ${open ? rows.join('') : ''}
  </div>`;
}

function render() {
  if (!allRepos().length) {
    $('#app').innerHTML = '<div class="empty">No repositories yet.<br><br><button class="primary" data-act="add-dialog">+ Add your first repo</button></div>';
    return;
  }
  const { cols, parked, problems } = buildCards();
  const alerts = $('#alerts');
  alerts.hidden = !problems && !S.onlyProblems;
  alerts.textContent = `⚠ ${problems}`;
  alerts.classList.toggle('active', S.onlyProblems);
  $('#app').innerHTML = `<div class="board">${COLUMNS.map((c) => `
    <section class="col col-${c.key}">
      <div class="col-head" title="${esc(c.hint)}"><h2>${c.title}</h2><span class="n">${cols[c.key].length}</span></div>
      <div class="col-body">${cols[c.key].join('') || (parked[c.key].length ? '' : '<div class="col-empty">—</div>')}${snoozedBlock(c.key, parked[c.key])}</div>
    </section>`).join('')}</div>`;
}

// Well-separated hues, assigned to groups by their position in config.json (wraps after 6 groups).
const GROUP_HUES = [265, 140, 30, 185, 330, 55];

function groupTag(name) {
  const h = GROUP_HUES[Math.max(0, S.groups.findIndex((g) => g.name === name)) % GROUP_HUES.length];
  return `<span class="tag" style="background:hsl(${h} 40% 20%);color:hsl(${h} 70% 78%)">${esc(name)}</span>`;
}

const spinner = (r) => (S.loading[r.id] > 0 ? '<span class="spin" title="Refreshing…">↻</span>' : '');

// The repo name is the link to the repository on GitHub (plain text when there is no GitHub remote).
const repoName = (r, url) => (url
  ? `<a class="repo-name" href="${esc(url)}" target="_blank" rel="noopener" title="Open ${esc(r.name)} on GitHub">${esc(r.name)}</a>`
  : `<span class="repo-name">${esc(r.name)}</span>`);

const removeBtn = (r) => `<button class="x" data-act="remove" data-id="${r.id}" title="Remove from panel (deletes nothing)">✕</button>`;
const editorBtn = (r) => `<button data-act="editor" data-id="${r.id}" title="Open in editor">&lt;/&gt;</button>`;

// Repo name + group on the left, remove (with confirmation) pinned to the right.
function cardTop(r, url) {
  return `<div class="card-top">${groupTag(r.group)}${repoName(r, url)}${spinner(r)}${removeBtn(r)}</div>`;
}

// Clean repos have nothing to do, so they collapse to a single line.
function cleanRow(r) {
  const { l, p } = info(r);
  const behind = l.behind ? `<span class="behind" title="${l.behind} commit${l.behind === 1 ? '' : 's'} behind the remote — time to pull">↓${l.behind}</span>` : '';
  const warn = p.error ? `<span class="warn" title="${esc('GitHub: ' + p.error)}">⚠</span>` : '';
  return `<div class="clean-row">
    ${groupTag(r.group)}${repoName(r, p.repo?.url)}
    <span class="branch" title="${esc(l.branch || '')}">${esc(l.branch || (l.detached ? '(detached)' : ''))}</span>${behind}${warn}${spinner(r)}
    <span class="row-actions">${editorBtn(r)}${removeBtn(r)}</span>
  </div>`;
}

function repoCard(r, attn = false) {
  const { l, p, dirty, unpushed } = info(r);
  const chips = [];
  if (dirty) chips.push(`<button class="chip yellow chip-btn" data-act="diff" data-id="${r.id}" title="View diff">● ${l.files.length} file${l.files.length === 1 ? '' : 's'} <span class="add">+${l.added}</span> <span class="del">−${l.deleted}</span></button>`);
  if (unpushed) chips.push(`<span class="chip blue">↑ ${l.ahead} unpushed${l.noUpstream ? ' · no upstream' : ''}</span>`);
  if (l.behind) chips.push(`<span class="chip gray">↓ ${l.behind} behind</span>`);
  if (l.currentGone) chips.push('<span class="chip gray" title="The remote branch was deleted (merged PR?)">remote branch deleted</span>');
  if (p.noRemote) chips.push('<span class="chip gray">no GitHub remote</span>');
  return `<div class="card ${attn ? 'attn' : ''}">
    ${cardTop(r, p.repo?.url)}
    <div class="branch one-line" title="${esc(l.branch || '')}">${esc(l.branch || (l.detached ? '(detached)' : ''))}</div>
    ${chips.length ? `<div class="chips">${chips.join('')}</div>` : ''}
    ${l.error ? `<div class="err">${esc(l.error)}</div>` : ''}
    ${p.error ? `<div class="err">GitHub: ${esc(p.error)}</div>` : ''}
    <div class="actions">${editorBtn(r)}</div>
  </div>`;
}

function checksChip(c) {
  if (c.state === 'none') return '<span class="chip gray">no checks</span>';
  const tip = esc(c.items.map((i) => `${i.state === 'success' ? '✔' : i.state === 'failed' ? '✘' : '…'} ${i.name}`).join('\n'));
  if (c.state === 'success') return `<span class="chip green" title="${tip}">✔ ${c.passed}/${c.total} checks</span>`;
  if (c.state === 'failed') return `<span class="chip red" title="${tip}">✘ ${c.failed} failed · ${c.passed}/${c.total}</span>`;
  return `<span class="chip yellow" title="${tip}">… ${c.pending} running · ${c.passed}/${c.total}</span>`;
}

function prCard(r, pr, meta) {
  const busy = S.busy[`${r.id}:${pr.number}`];
  const showReason = !pr.ready && pr.blockedReason && pr.checks.state !== 'pending' && pr.checks.state !== 'failed';
  const n = `data-id="${r.id}" data-n="${pr.number}"`;
  return `<div class="card ${isProblem(pr) ? 'attn' : ''}">
    ${cardTop(r, meta?.url)}
    <a class="pr-title" href="${esc(pr.url)}" target="_blank" rel="noopener" title="${esc(pr.title)}">#${pr.number} ${esc(pr.title)}</a>
    <div class="branch one-line" title="${esc(pr.head + ' → ' + pr.base)}">${esc(pr.head)} → ${esc(pr.base)}</div>
    <div class="chips">
      ${checksChip(pr.checks)}
      ${pr.isDraft ? '<span class="chip gray">draft</span>' : ''}
      ${pr.reviewDecision === 'REVIEW_REQUIRED' ? '<span class="chip yellow">review required</span>' : ''}
      ${pr.reviewDecision === 'CHANGES_REQUESTED' ? '<span class="chip red">changes requested</span>' : ''}
      ${showReason ? `<span class="chip ${pr.mergeStateStatus === 'DIRTY' || pr.mergeStateStatus === 'BEHIND' ? 'red' : 'gray'}">${esc(pr.blockedReason)}</span>` : ''}
    </div>
    <div class="merge-row">
      <button class="merge" data-act="merge" ${n} ${pr.ready && !busy ? '' : 'disabled'}
        title="${esc(pr.ready ? 'Merge into ' + pr.base : pr.blockedReason)}">${busy ? 'Merging…' : `Merge · ${S.prefs.method}`}</button>
      <button data-act="snooze" ${n} title="Park this PR at the bottom of the column until it is ready to merge (stays parked if it is already ready)">💤</button>
      ${editorBtn(r)}
    </div>
    ${pr.checks.failedRuns.length ? `<button data-act="rerun" ${n} ${busy ? 'disabled' : ''}>Re-run failed</button>` : ''}
  </div>`;
}

// ---------- diff drawer ----------
function renderDiff(text) {
  const parts = text.split(/^diff --git /m).filter((x) => x.trim());
  if (!parts.length) return '<div class="empty">No diff available.</div>';
  return parts.map((part, i) => {
    const lines = part.split('\n');
    const m = /^a\/(.+?) b\/(.+)$/.exec(lines[0]);
    const title = m ? m[2] : lines[0];
    const body = lines.slice(1).map((ln) => {
      const cls = ln.startsWith('@@') ? 'h' : ln.startsWith('+') && !ln.startsWith('+++') ? 'a'
        : ln.startsWith('-') && !ln.startsWith('---') ? 'd'
          : /^(index |new file|deleted file|similarity|rename|old mode|new mode|\+\+\+|---|Binary)/.test(ln) ? 'm' : '';
      return `<div class="${cls}">${esc(ln) || ' '}</div>`;
    }).join('');
    return `<details class="file" ${parts.length <= 15 || i === 0 ? 'open' : ''}><summary>${esc(title)}</summary><div class="diff">${body}</div></details>`;
  }).join('');
}

async function openDiff(id) {
  const l = S.local[id] || {};
  $('#drawerTitle').textContent = `${nameOf(id)} · ${l.branch || ''}`;
  $('#drawerBody').innerHTML = '<div class="empty">Loading diff…</div>';
  $('#drawer').hidden = false;
  try {
    const d = await api(`/api/diff?id=${id}`);
    const list = (l.files || []).map((f) => `<div><span class="st">${esc(f.status)}</span><span>${esc(f.path)}</span>
      <span class="add">${f.binary ? 'bin' : '+' + f.added}</span><span class="del">${f.binary ? '' : '−' + f.deleted}</span></div>`).join('');
    $('#drawerBody').innerHTML = `<div class="filelist">${list}</div>${d.truncated ? '<div class="err">Diff truncated (too large).</div>' : ''}${renderDiff(d.diff)}`;
  } catch (e) { $('#drawerBody').innerHTML = `<div class="err">${esc(e.message)}</div>`; }
}

// ---------- actions ----------
async function doMerge(id, n) {
  const pr = (S.prs[id]?.prs || []).find((x) => x.number === n);
  if (!pr || S.busy[`${id}:${n}`]) return;
  const { method, del } = S.prefs;
  S.busy[`${id}:${n}`] = true; draw();
  try {
    const r = await api('/api/merge', { id, number: n, method, deleteBranch: del });
    toast(`#${n} merged${r.branch === 'deleted' ? ' · branch deleted' : r.branch === 'auto' ? ' · branch auto-deleted' : ''}`, 'ok');
  } catch (e) { toast(`#${n}: ${e.message}`, 'bad'); }
  delete S.busy[`${id}:${n}`];
  await refreshRepo(id);
}

async function doRerun(id, n) {
  S.busy[`${id}:${n}`] = true; draw();
  try { const r = await api('/api/rerun', { id, number: n }); toast(`Re-running ${r.rerun} workflow run(s)`, 'ok'); }
  catch (e) { toast(e.message, 'bad'); }
  delete S.busy[`${id}:${n}`];
  setTimeout(() => refreshRepo(id), 2500);
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

const ACTIONS = {
  'refresh-all': () => refreshAll(),
  'fetch-all': async () => { toast('Fetching all repos…'); await Promise.all(allRepos().map((r) => fetchRepo(r.id))); toast('Fetch done', 'ok'); },
  'diff': (el) => openDiff(el.dataset.id),
  'close-drawer': () => { $('#drawer').hidden = true; },
  'editor': (el) => api('/api/editor', { id: el.dataset.id }).catch((e) => toast(e.message, 'bad')),
  'merge': (el) => doMerge(el.dataset.id, Number(el.dataset.n)),
  'toggle-problems': () => { S.onlyProblems = !S.onlyProblems; draw(); },
  'snooze': (el) => setSnooze(el.dataset.id, Number(el.dataset.n), true),
  'unsnooze': (el) => setSnooze(el.dataset.id, Number(el.dataset.n), false),
  'toggle-snoozed': (el) => { S.snoozedOpen[el.dataset.col] = !S.snoozedOpen[el.dataset.col]; draw(); },
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
  const el = e.target.closest('[data-act]');
  if (!el || el.disabled) return;
  if (el.tagName === 'A') return;
  ACTIONS[el.dataset.act]?.(el);
});

document.addEventListener('change', (e) => {
  const key = e.target.dataset.pref;
  if (!key) return;
  S.prefs[key] = e.target.type === 'checkbox' ? e.target.checked : e.target.value;
  localStorage.setItem('prefs', JSON.stringify(S.prefs));
  draw();
});

$('#search').addEventListener('input', (e) => { S.q = e.target.value; draw(); });
$('#groupFilter').addEventListener('change', (e) => { S.group = e.target.value; draw(); });

// Auto-refresh while the tab is visible and nothing is being merged.
setInterval(() => {
  if (!document.hidden && !Object.keys(S.busy).length) refreshAll();
}, 60000);
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && Date.now() - S.lastRefresh > 30000) refreshAll();
});

(async () => {
  try { await loadConfig(); } catch (e) { toast(e.message, 'bad'); }
  $('#method').value = S.prefs.method;
  $('#delBranch').checked = S.prefs.del;
  draw();
  refreshAll();
})();
