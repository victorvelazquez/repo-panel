'use strict';
// Pure helpers: parsing git/gh output and deciding PR readiness. No I/O here.
const crypto = require('node:crypto');

function repoId(p) {
  return crypto.createHash('sha1').update(String(p).toLowerCase()).digest('hex').slice(0, 10);
}

// Parses `git status --porcelain=v2 -b` output.
function parseStatus(out) {
  const r = { branch: null, detached: false, upstream: null, hasAb: false, ahead: 0, behind: 0, files: [] };
  for (const line of out.split('\n')) {
    if (!line) continue;
    if (line.startsWith('# branch.head ')) {
      const h = line.slice('# branch.head '.length).trim();
      if (h === '(detached)') r.detached = true;
      else r.branch = h;
    } else if (line.startsWith('# branch.upstream ')) {
      r.upstream = line.slice('# branch.upstream '.length).trim();
    } else if (line.startsWith('# branch.ab ')) {
      const m = /\+(\d+) -(\d+)/.exec(line);
      if (m) { r.hasAb = true; r.ahead = +m[1]; r.behind = +m[2]; }
    } else if (line[0] === '1') {
      const p = line.split(' ');
      r.files.push({ xy: p[1], path: p.slice(8).join(' ') });
    } else if (line[0] === '2') {
      const p = line.split(' ');
      r.files.push({ xy: p[1], path: p.slice(9).join(' ').split('\t')[0] });
    } else if (line[0] === 'u') {
      const p = line.split(' ');
      r.files.push({ xy: p[1], path: p.slice(10).join(' '), conflict: true });
    } else if (line[0] === '?') {
      r.files.push({ xy: '??', path: line.slice(2) });
    }
  }
  return r;
}

// Parses `git diff --numstat` output into a path -> {added, deleted, binary} map.
function parseNumstat(out) {
  const map = new Map();
  for (const line of out.split('\n')) {
    if (!line) continue;
    const [a, d, ...rest] = line.split('\t');
    const binary = a === '-' && d === '-';
    map.set(rest.join('\t'), { added: binary ? 0 : +a, deleted: binary ? 0 : +d, binary });
  }
  return map;
}

// Names of local branches whose remote branch no longer exists.
// Input format: `%(refname:short)%09%(upstream:track)`.
function parseGoneBranches(out) {
  return out.split('\n')
    .map((l) => l.split('\t'))
    .filter(([, track]) => track && track.includes('gone'))
    .map(([name]) => name);
}

// Base branch name from `git symbolic-ref refs/remotes/origin/HEAD`; falls back to main.
function parseBaseBranch(out) {
  const m = /^refs\/remotes\/[^/]+\/(.+)$/.exec((out || '').trim());
  return m ? m[1] : 'main';
}

const STALE_REASON = 'Merged: run /flow-branch';

// A working branch whose work already landed: its remote is gone, or a merged PR came from it.
// The branch name may have been reused by a new open PR, which is live work and not stale.
function staleBranch({ branch, base, gone, mergedPr, openPrs }) {
  if (!branch || branch === base) return null;
  if (gone) return { reason: STALE_REASON, via: 'gone', pr: null };
  if (mergedPr && !(openPrs || []).some((p) => p.head === branch)) {
    return { reason: STALE_REASON, via: 'merged', pr: mergedPr.number };
  }
  return null;
}

function statusLetter(xy) {
  if (xy === '??') return '?';
  const x = xy[0] !== '.' ? xy[0] : xy[1];
  return x || 'M';
}

const OK_CONCLUSIONS = ['SUCCESS', 'NEUTRAL', 'SKIPPED'];

// Reduces a statusCheckRollup array to one overall state.
function summarizeChecks(rollup) {
  const items = [];
  const failedRuns = new Set();
  for (const c of rollup || []) {
    let name; let url; let state;
    if (c.__typename === 'StatusContext' || (c.status === undefined && c.state !== undefined)) {
      name = c.context; url = c.targetUrl;
      state = c.state === 'SUCCESS' ? 'success' : (c.state === 'PENDING' || c.state === 'EXPECTED') ? 'pending' : 'failed';
    } else {
      name = c.name; url = c.detailsUrl;
      if (c.status !== 'COMPLETED') state = 'pending';
      else state = OK_CONCLUSIONS.includes(c.conclusion) ? 'success' : 'failed';
    }
    if (state === 'failed') {
      const m = /\/actions\/runs\/(\d+)/.exec(url || '');
      if (m) failedRuns.add(m[1]);
    }
    items.push({ name, state, url });
  }
  const count = (s) => items.filter((i) => i.state === s).length;
  const failed = count('failed');
  const pending = count('pending');
  const passed = count('success');
  const state = !items.length ? 'none' : failed ? 'failed' : pending ? 'pending' : 'success';
  return { state, total: items.length, passed, failed, pending, failedRuns: [...failedRuns], items };
}

// Returns why a PR cannot be merged right now, or null when it can.
function blockedReason(pr, checks) {
  if (pr.isDraft) return 'Draft pull request';
  if (checks.state === 'failed') return 'Some checks failed';
  if (checks.state === 'pending') return 'Checks still running';
  if (pr.mergeable === 'CONFLICTING' || pr.mergeStateStatus === 'DIRTY') return 'Merge conflicts with the base branch';
  if (pr.mergeable === 'UNKNOWN' || pr.mergeStateStatus === 'UNKNOWN') return 'GitHub is still computing mergeability';
  if (pr.mergeStateStatus === 'BEHIND') return 'Branch is behind the base branch';
  if (pr.mergeStateStatus === 'BLOCKED') return 'Blocked by repository rules (required reviews or other protections)';
  if (pr.mergeStateStatus !== 'CLEAN' && pr.mergeStateStatus !== 'HAS_HOOKS') return `Merge state: ${pr.mergeStateStatus}`;
  return null;
}

function enrichPr(pr) {
  const checks = summarizeChecks(pr.statusCheckRollup);
  const blocked = blockedReason(pr, checks);
  return {
    number: pr.number, title: pr.title, url: pr.url,
    head: pr.headRefName, base: pr.baseRefName, headOid: pr.headRefOid,
    isDraft: !!pr.isDraft, isCrossRepository: !!pr.isCrossRepository,
    author: pr.author && pr.author.login, reviewDecision: pr.reviewDecision || null,
    mergeStateStatus: pr.mergeStateStatus, checks, ready: blocked === null, blockedReason: blocked,
  };
}

// Percent-encodes each segment of a git ref path, keeping the slashes.
function encodeRef(ref) {
  return ref.split('/').map(encodeURIComponent).join('/');
}

// ---- ROADMAP.md parsing ----
const RM_STATES = ['Pendiente', 'En curso', 'Completada', 'Bloqueada', 'Lista', 'En revisión'];
const RM_REQUIRED = ['ID', 'Entrega', 'Depende de', 'Estado'];
const RM_HEADER = { 'donde esta': 'dondeEsta', 'que sigue': 'queSigue', 'que lo bloquea': 'queLoBloquea' };
const RM_STATE_RE = /(?<!\p{L})(en curso|pendiente|completada|bloqueada|lista|en revisi[oó]n)(?!\p{L})/iu;
const rmNorm = (s) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
const rmPlain = (s) => s.replace(/\*\*|`/g, '').trim();

// Cells of a table line; `\|` is a literal pipe, outer pipes are optional.
function rmCells(line) {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1);
  const cells = [''];
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\' && s[i + 1] === '|') { cells[cells.length - 1] += '|'; i++; }
    else if (s[i] === '|') cells.push('');
    else cells[cells.length - 1] += s[i];
  }
  return cells.map((c) => c.trim());
}

// Runs of consecutive `|` lines; `valid` when the second line is a separator row.
function rmBlocks(lines) {
  const blocks = [];
  for (let i = 0; i < lines.length;) {
    if (!lines[i].trim().startsWith('|')) { i++; continue; }
    let j = i;
    while (j < lines.length && lines[j].trim().startsWith('|')) j++;
    const valid = j - i >= 2 && rmCells(lines[i + 1]).every((c) => /^:?-+:?$/.test(c));
    blocks.push({ start: i, end: j, valid });
    i = j;
  }
  return blocks;
}

function rmState(raw) {
  const m = RM_STATE_RE.exec(raw);
  if (!m) return { estado: null, detalle: '' };
  const estado = RM_STATES.find((s) => rmNorm(s) === rmNorm(m[1]));
  let detalle = (raw.slice(0, m.index) + ' ' + raw.slice(m.index + m[0].length)).trim()
    .replace(/^[\s,;:.\-–—]+|[\s,;:.\-–—]+$/g, '');
  if (detalle.startsWith('(') && detalle.endsWith(')')) detalle = detalle.slice(1, -1).trim();
  return { estado, detalle };
}

// A repo-relative file path from config, with "/" separators; null when absent or unsafe.
function safeRelPath(p) {
  if (typeof p !== 'string') return null;
  const s = p.trim().replace(/\\/g, '/');
  if (!s || s.startsWith('-') || s.startsWith('/') || /^[a-z]:/i.test(s)) return null;
  return s.split('/').includes('..') ? null : s;
}

// Rows in a dependency cycle (DFS with colors); `report(dep, cycle)` is called once per cycle found.
function rmFindCycles(byId, report) {
  const cyclic = new Set();
  const color = new Map();
  const visit = (row, path) => {
    color.set(row, 1);
    path.push(row);
    for (const id of row.dependsOn) {
      const dep = byId.get(id);
      if (color.get(dep) === 1) {
        const cycle = path.slice(path.indexOf(dep));
        cycle.forEach((r) => cyclic.add(r));
        report(dep, cycle);
      } else if (!color.has(dep)) visit(dep, path);
    }
    path.pop();
    color.set(row, 2);
  };
  for (const row of byId.values()) if (!color.has(row)) visit(row, []);
  return cyclic;
}

// First Pendiente row whose table dependencies are all Completada, skipping cycles and `skip` IDs.
function rmNext(rows, byId, cyclic, skip) {
  return rows.find((r) => r.estado === 'Pendiente' && !cyclic.has(r) && !skip[r.id]
    && r.dependsOn.every((id) => byId.get(id).estado === 'Completada')) || null;
}

const rmById = (rows) => {
  const byId = new Map();
  for (const r of rows) if (!byId.has(r.id)) byId.set(r.id, r);
  return byId;
};

// Parses the docs/ROADMAP.md contract: header lines plus the units table. Never throws.
function parseRoadmap(markdown) {
  const lines = (typeof markdown === 'string' ? markdown : '').replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n')
    .replace(/<!--[\s\S]*?-->/g, (c) => c.replace(/[^\n]/g, '')).split('\n');
  const problems = [];
  const add = (line, severity, code, message) => problems.push({ line, severity, code, message });
  const header = { dondeEsta: null, queSigue: null, queLoBloquea: null };
  for (const l of lines) {
    const m = /^([^:|]+):\s*(.*)$/.exec(rmPlain(l));
    const key = m && RM_HEADER[rmNorm(m[1])];
    if (key && header[key] === null) header[key] = m[2].trim();
  }

  const blocks = rmBlocks(lines);
  const colsOf = (b) => new Map(rmCells(lines[b.start]).map((c, i) => [rmNorm(c), i]).reverse());
  const tables = blocks.filter((b) => b.valid);
  const table = tables.find((b) => RM_REQUIRED.every((n) => colsOf(b).has(rmNorm(n))));
  const result = (rows, next) => {
    const count = (s) => rows.filter((r) => r.estado === s).length;
    return {
      header, rows, problems: problems.sort((a, b) => a.line - b.line),
      current: rows.filter((r) => r.estado === 'En curso'), next,
      progress: {
        total: rows.length, completada: count('Completada'), pendiente: count('Pendiente'),
        enCurso: count('En curso'), bloqueada: count('Bloqueada'), lista: count('Lista'),
        enRevision: count('En revisión'), desconocido: count(null),
      },
    };
  };
  if (!table) {
    if (!tables.length) add(1, 'error', 'no-table', 'No table found');
    else {
      const missing = RM_REQUIRED.filter((n) => !colsOf(tables[0]).has(rmNorm(n)));
      add(tables[0].start + 1, 'error', 'missing-column', `Table is missing required columns: ${missing.join(', ')}`);
    }
    return result([], null);
  }

  const cols = colsOf(table);
  const ncols = rmCells(lines[table.start]).length;
  const col = (name) => cols.get(rmNorm(name));
  const rows = [];
  const pending = [];
  for (let n = table.start + 2; n < table.end; n++) {
    let cells = rmCells(lines[n]);
    if (cells.every((c) => c === '')) continue;
    if (cells.length > ncols) {
      add(n + 1, 'error', 'pipe-in-cell', 'More cells than columns; escape a literal pipe as \\|');
    }
    cells = cells.slice(0, ncols);
    const get = (name) => rmPlain(cells[col(name)] || '');
    const { estado, detalle } = rmState(get('Estado'));
    const row = {
      id: get('ID'), entrega: get('Entrega'), resultadoVisible: get('Resultado visible'),
      dependsOn: [], externalDeps: [], estado, estadoDetalle: detalle, declaredByHand: false,
      notas: get('Notas'), ficha: get('Ficha'), line: n + 1,
    };
    if (!/^[A-Za-z][A-Za-z0-9._-]*$/.test(row.id)) add(row.line, 'error', 'bad-id', `Invalid ID "${row.id}"`);
    else if (rows.some((r) => r.id === row.id)) add(row.line, 'error', 'duplicate-id', `Duplicate ID ${row.id}`);
    if (estado === null) add(row.line, 'error', 'unknown-state', `Unknown state "${get('Estado')}"`);
    if (detalle) add(row.line, 'warn', 'state-detail', `State has extra detail "${detalle}"; move it to Notas`);
    if (estado === 'Lista' || estado === 'En revisión') {
      row.declaredByHand = true;
      add(row.line, 'warn', 'hand-state', `"${estado}" is computed by the panel; do not write it by hand`);
    }
    pending.push(get('Depende de'));
    rows.push(row);
  }

  const byId = rmById(rows);
  rows.forEach((row, i) => {
    for (const tok of pending[i].split(/[,;]/).map((t) => t.trim())) {
      if (!tok || /^[—–-]$/.test(tok)) continue;
      if (byId.has(tok)) row.dependsOn.push(tok);
      else {
        row.externalDeps.push(tok);
        add(row.line, 'info', 'missing-dependency', `Dependency "${tok}" is not a row of this table`);
      }
    }
  });

  const cyclic = rmFindCycles(byId, (dep, cycle) => {
    add(dep.line, 'error', 'circular-dependency', `Circular dependency: ${[...cycle, dep].map((r) => r.id).join(' -> ')}`);
  });

  // A table separated from the chosen one by a blank line must itself be a valid table.
  let k = table.end;
  if (k < lines.length && lines[k].trim() === '') {
    while (k < lines.length && lines[k].trim() === '') k++;
    const stray = blocks.find((b) => b.start === k && !b.valid);
    if (stray) add(k + 1, 'error', 'row-after-blank', 'Table row after a blank line is ignored; remove the blank line');
  }

  return result(rows, rmNext(rows, byId, cyclic, {}));
}

// True when `id` appears in `text` as a complete token, case-insensitive. Letters and digits are
// token characters; a "." followed by one is too, so "p2" does not match "p2.1-x".
function matchesUnitId(text, id) {
  if (!text || !id) return false;
  const t = String(text).toLowerCase();
  const needle = String(id).toLowerCase();
  const alnum = (c) => c !== undefined && /[\p{L}\p{N}]/u.test(c);
  const joins = (c, other) => alnum(c) || (c === '.' && alnum(other));
  for (let i = t.indexOf(needle); i !== -1; i = t.indexOf(needle, i + 1)) {
    const end = i + needle.length;
    if (!joins(t[i - 1], t[i - 2]) && !joins(t[end], t[end + 1])) return true;
  }
  return false;
}

const DERIVED_ORDER = ['En revisión', 'Lista', 'En curso'];

// States computed from Git and GitHub, never written in the file. Precedence per unit:
// En revisión (open PR) > Lista (work on a branch) > En curso (only a branch). Completada and
// Bloqueada rows are never touched; with duplicate IDs the first row wins.
function deriveUnitStates(rows, facts) {
  const { current, dirty, aheadCurrent, branches = [], localBranches = [], prs = [] } = facts || {};
  const out = {};
  for (const [id, row] of rmById(rows || [])) {
    if (row.estado === 'Completada' || row.estado === 'Bloqueada') continue;
    const has = (name) => matchesUnitId(name, id);
    const pr = prs.find((p) => has(p.title) || has(p.head));
    if (pr) { out[id] = { state: 'En revisión', via: 'pr', pr: pr.number }; continue; }
    const ready = current && has(current) && (dirty || aheadCurrent > 0) ? current : branches.find(has);
    if (ready) { out[id] = { state: 'Lista', via: 'branch', branch: ready }; continue; }
    const only = [current, ...localBranches].find((n) => n && has(n));
    if (only && row.estado !== 'En curso') out[id] = { state: 'En curso', via: 'branch', branch: only };
  }
  return out;
}

// Same rule as parseRoadmap's `next`, also skipping units with a derived state.
function nextUnit(rows, derived) {
  const byId = rmById(rows);
  return rmNext(rows, byId, rmFindCycles(byId, () => {}), derived || {});
}

// What the repo card shows about a parsed roadmap; null when there is nothing usable to show.
// Unit shown: the first active one (derived state or En curso in the file) by precedence, else `next`.
function roadmapSummary(rp) {
  if (!rp || rp.available === false || !rp.progress) return null;
  const derived = rp.derived || {};
  const rows = rp.rows || [];
  const stateOf = (r) => (derived[r.id] && derived[r.id].state) || (r.estado === 'En curso' ? 'En curso' : null);
  const seen = new Set();
  const active = rows.filter((r) => !seen.has(r.id) && seen.add(r.id) && stateOf(r))
    .sort((a, b) => DERIVED_ORDER.indexOf(stateOf(a)) - DERIVED_ORDER.indexOf(stateOf(b)));
  const unit = active[0] || (rows.length || !rp.next ? nextUnit(rows, derived) : rp.next);
  const state = active[0] ? stateOf(unit) : null;
  const { total, completada } = rp.progress;
  const count = (s) => (rp.problems || []).filter((p) => p.severity === s).length;
  const kinds = { 'En revisión': 'review', Lista: 'ready', 'En curso': 'current' };
  return {
    kind: !unit ? 'none' : state ? kinds[state] : 'next',
    state,
    id: unit ? unit.id : null,
    entrega: unit ? unit.entrega : null,
    waiting: unit ? unit.externalDeps : [],
    pr: state && derived[unit.id] && derived[unit.id].pr !== undefined ? derived[unit.id].pr : null,
    extra: Math.max(0, active.length - (active[0] ? 1 : 0)),
    done: completada, total, pct: total ? Math.round((completada / total) * 100) : 0,
    problems: { total: (rp.problems || []).length, error: count('error'), warn: count('warn'), info: count('info') },
    header: rp.header,
  };
}

const QUEUE_RANK = { merge: 0, branch: 1, manual: 1, waiting: 2, deliver: 3, start: 4 };
const WAITING_STATES = ['needs-input', 'blocked'];

// The ordered "go work on" actions for repos given in board order. Per repo: one `merge` per ready PR,
// `branch` when stale, `deliver` when it has local changes, `start` when clean with a next unit. A repo flagged
// `manual` (a reason string) gets a `manual` action and a repo with `waiting` ({ state, next }) a `waiting` one:
// neither is told to deliver or start. Both fields are optional and ignored when absent or malformed.
// Repos named in `priority` (case-insensitive, in that order) come first; ties keep board order.
function workQueue(items, priority) {
  if (!Array.isArray(items)) return [];
  const rankOf = new Map();
  for (const n of Array.isArray(priority) ? priority : []) {
    const k = typeof n === 'string' ? n.trim().toLowerCase() : '';
    if (k && !rankOf.has(k)) rankOf.set(k, rankOf.size);
  }
  const out = [];
  for (const it of items) {
    if (!it || typeof it !== 'object' || typeof it.name !== 'string') continue;
    const base = { repoId: it.id, name: it.name };
    const group = rankOf.has(it.name.trim().toLowerCase()) ? rankOf.get(it.name.trim().toLowerCase()) : Infinity;
    const add = (a) => out.push({ a, group, rank: QUEUE_RANK[a.kind], seq: out.length });
    for (const pr of Array.isArray(it.ready) ? it.ready : []) {
      if (pr && Number.isInteger(pr.number)) add({ ...base, kind: 'merge', pr: pr.number, title: String(pr.title ?? '') });
    }
    if (it.stale) add({ ...base, kind: 'branch' });
    const manual = typeof it.manual === 'string' ? it.manual.trim().slice(0, 200) : '';
    const w = it.waiting;
    const waiting = !manual && w && typeof w === 'object' && WAITING_STATES.includes(w.state)
      ? { state: w.state, next: typeof w.next === 'string' ? w.next.trim().slice(0, 200) : '' } : null;
    if (manual) add({ ...base, kind: 'manual', reason: manual });
    else if (waiting) add({ ...base, kind: 'waiting', ...waiting });
    else if (it.dirty || it.unpushed) add({ ...base, kind: 'deliver' });
    const n = it.next;
    if (!manual && !waiting && !it.dirty && !it.unpushed && !it.stale && !it.hasPrs && n && typeof n.id === 'string') {
      add({ ...base, kind: 'start', unit: { id: n.id, entrega: String(n.entrega ?? '') } });
    }
  }
  const cmp = (x, y) => (x === y ? 0 : x < y ? -1 : 1);
  return out.sort((x, y) => cmp(x.group, y.group) || cmp(x.rank, y.rank) || cmp(x.seq, y.seq)).map((e) => e.a);
}

// Which repos do not have a usable roadmap. `entries` are { id, name, roadmap } in board order, with the
// /api/roadmap payload (null while unknown, which skips the repo). Only error and warn problems count.
function conformityReport(entries) {
  const out = { ok: 0, items: [] };
  if (!Array.isArray(entries)) return out;
  const REASONS = ['missing', 'no-base', 'no-repo'];
  for (const e of entries) {
    if (!e || typeof e !== 'object' || typeof e.id !== 'string' || typeof e.name !== 'string') continue;
    const rp = e.roadmap;
    if (!rp || typeof rp !== 'object') continue;
    const item = (status, problems = []) => out.items.push({ id: e.id, name: e.name, status, problems });
    if (rp.available === false) { item(REASONS.includes(rp.reason) ? rp.reason : 'unavailable'); continue; }
    if (rp.available !== true || !Array.isArray(rp.problems)) continue;
    const bad = rp.problems.filter((p) => p && (p.severity === 'error' || p.severity === 'warn'))
      .map(({ line, severity, code, message }) => ({ line, severity, code, message })).sort((a, b) => a.line - b.line);
    if (bad.length) item('problems', bad); else out.ok++;
  }
  return out;
}

// ---------- pi sessions in Orca terminals ----------
// The only texts the browser can ask the panel to type into a pi session (it sends the key, never the text).
const PI_COMMANDS = { 'flow-commit': '/flow-commit', 'flow-pr': '/flow-pr', 'flow-branch': '/flow-branch' };

// Orca reports the same folder as C:/x or C:\\x; compare them without caring about separators or case.
const normPath = (p) => String(p || '').replace(/[\\/]+/g, '/').replace(/\/$/, '').toLowerCase();

// Live, writable pi terminals whose worktree is exactly this repo.
function piTerminalsFor(terminals, repoPath) {
  const want = normPath(repoPath);
  return (Array.isArray(terminals) ? terminals : []).filter((t) => t && typeof t.handle === 'string'
    && typeof t.title === 'string' && t.title.startsWith('π') && t.connected === true && t.writable === true
    && t.orphaned !== true && normPath(t.worktreePath) === want);
}

// Reads the end of a terminal preview: 'idle' (waiting with an empty prompt), 'typed' (waiting but the prompt
// holds text) or 'busy' (anything else, including a screen this does not recognise: it fails closed).
function piPromptState(preview) {
  const lines = String(preview || '').split('\n').map((l) => l.trim()).filter(Boolean).slice(-8);
  const at = lines.map((l) => /waiting for input/i.test(l)).lastIndexOf(true);
  if (at < 0) return 'busy';
  return /^▎\s*type, or \/ for commands/.test(lines[at + 1] || '') ? 'idle' : 'typed';
}

module.exports = {
  PI_COMMANDS, normPath, piTerminalsFor, piPromptState,
  repoId, parseStatus, parseNumstat, parseGoneBranches, parseBaseBranch, staleBranch, statusLetter,
  summarizeChecks, blockedReason, enrichPr, encodeRef, parseRoadmap, safeRelPath, roadmapSummary,
  matchesUnitId, deriveUnitStates, nextUnit, workQueue, conformityReport,
};
