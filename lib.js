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

  const byId = new Map();
  for (const r of rows) if (!byId.has(r.id)) byId.set(r.id, r);
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

  // Cycles among table dependencies (DFS with colors; each cycle is reported once).
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
        add(dep.line, 'error', 'circular-dependency', `Circular dependency: ${[...cycle, dep].map((r) => r.id).join(' -> ')}`);
      } else if (!color.has(dep)) visit(dep, path);
    }
    path.pop();
    color.set(row, 2);
  };
  for (const row of byId.values()) if (!color.has(row)) visit(row, []);

  // A table separated from the chosen one by a blank line must itself be a valid table.
  let k = table.end;
  if (k < lines.length && lines[k].trim() === '') {
    while (k < lines.length && lines[k].trim() === '') k++;
    const stray = blocks.find((b) => b.start === k && !b.valid);
    if (stray) add(k + 1, 'error', 'row-after-blank', 'Table row after a blank line is ignored; remove the blank line');
  }

  const next = rows.find((r) => r.estado === 'Pendiente' && !cyclic.has(r)
    && r.dependsOn.every((id) => byId.get(id).estado === 'Completada')) || null;
  return result(rows, next);
}

// What the repo card shows about a parsed roadmap; null when there is nothing usable to show.
function roadmapSummary(rp) {
  if (!rp || rp.available === false || !rp.progress) return null;
  const unit = (rp.current && rp.current[0]) || rp.next || null;
  const { total, completada } = rp.progress;
  const count = (s) => (rp.problems || []).filter((p) => p.severity === s).length;
  return {
    kind: !unit ? 'none' : rp.current && rp.current.length ? 'current' : 'next',
    id: unit ? unit.id : null,
    entrega: unit ? unit.entrega : null,
    waiting: unit ? unit.externalDeps : [],
    done: completada, total, pct: total ? Math.round((completada / total) * 100) : 0,
    problems: { total: (rp.problems || []).length, error: count('error'), warn: count('warn'), info: count('info') },
    header: rp.header,
  };
}

module.exports = {
  repoId, parseStatus, parseNumstat, parseGoneBranches, parseBaseBranch, staleBranch, statusLetter,
  summarizeChecks, blockedReason, enrichPr, encodeRef, parseRoadmap, safeRelPath, roadmapSummary,
};
