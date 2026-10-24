'use strict';
// Pure requirement checks (no I/O): the server reads the facts, this file only decides.
//
// facts = {
//   base:  { status: 'ok' | 'no-repo' | 'no-base', name },
//   files: { <role>: { available, reason, text, path } },  // roles: agents, roadmap, adoption (a repo) or agents,
//                                                           // enlaces, enlacesAlt (a room); the shape is what
//   room:  { name } | null                                  // server/roadmap.js remoteFile returns; the room the
// };                                                        // repo belongs to (null or absent: none)
const lib = require('./lib.js');

const stripBom = (t) => (typeof t === 'string' ? t : '').replace(/^\uFEFF/, '');
const escapeRe = (s) => s.replace(/\W/g, '\\$&');

// A block is `<!-- orquestacion:NAME vN.N -->` ... `<!-- /orquestacion:NAME -->`. `expected` is the version
// the registry asks for; without it any closed block is ok. The unversioned section older repos carry
// (a `## Orquestación` heading or the `orquestacion:bloque` marker) is legacy for registro: outdated, not missing.
function parseBlock(text, name, expected) {
  const t = stripBom(text);
  const open = new RegExp(`<!-- orquestacion:${escapeRe(name)} v(\\d+(?:\\.\\d+)*) -->`).exec(t);
  if (open) {
    const closed = t.indexOf(`<!-- /orquestacion:${name} -->`, open.index + open[0].length) !== -1;
    if (!closed) return { status: 'unclosed', version: open[1] };
    return { status: expected && open[1] !== expected ? 'outdated' : 'ok', version: open[1] };
  }
  // Only the registro block had a legacy form, and a heading next to any versioned block is that block's own title.
  const versioned = /<!-- orquestacion:\w+ v\d/.test(t);
  if (name === 'registro' && !versioned && (/^## Orquestaci[oó]n/m.test(t) || t.includes('orquestacion:bloque'))) return { status: 'legacy', version: null };
  return { status: 'missing', version: null };
}

const HEADER_LINES = ['Dónde está', 'Qué sigue', 'Qué lo bloquea'];

// The three header lines of docs/ROADMAP.md (`**Dónde está:**`, ...) must exist, in that order.
function headerCheck(text) {
  const lines = stripBom(text).replace(/\r\n?/g, '\n').split('\n');
  const at = HEADER_LINES.map((h) => lines.findIndex((l) => l.startsWith(`**${h}:**`)));
  const missing = HEADER_LINES.filter((h, i) => at[i] === -1);
  const ordered = missing.length > 0 || (at[0] < at[1] && at[1] < at[2]);
  return { ok: missing.length === 0 && ordered, missing, ordered };
}

// The text between a block's markers, or null when it is missing or unclosed.
function blockBody(text, name) {
  const t = stripBom(text);
  const open = new RegExp(`<!-- orquestacion:${escapeRe(name)} v\\d+(?:\\.\\d+)* -->`).exec(t);
  if (!open) return null;
  const from = open.index + open[0].length;
  const end = t.indexOf(`<!-- /orquestacion:${name} -->`, from);
  return end === -1 ? null : t.slice(from, end);
}

// Text of the markdown heading lines (`# ...` to `###### ...`).
const headingLines = (text) => stripBom(text).split(/\r?\n/).map((l) => /^#{1,6}\s+(.*?)\s*#*\s*$/.exec(l)).filter(Boolean).map((m) => m[1]);

const BLOCK_DETAIL = {
  outdated: (b) => `version ${b.version} found, ${b.expected} expected`,
  legacy: () => 'unversioned legacy section found; update it',
  unclosed: () => 'opening marker without its closing marker',
  missing: () => 'block not found',
};

const make = (status, detail, reason = null) => ({ status, detail, reason });
const unavailable = (reason) => make('unavailable', `could not be read (${reason})`, reason);

// Reads a file fact: { text } when readable, { fail } when the file is absent, otherwise an unavailable result.
function fileOf(facts, role) {
  if (!facts.base || facts.base.status !== 'ok') return { result: unavailable((facts.base && facts.base.status) || 'no-repo') };
  const f = facts.files && facts.files[role];
  if (!f) return { result: unavailable('not-read') };
  if (f.available === true && typeof f.text === 'string') return { text: f.text, path: f.path };
  if (f.reason === 'missing') return { absent: true, path: f.path };
  return { result: unavailable(f.reason || 'not-read') };
}

// Like fileOf for a file that may live under any of several roles: the first readable one wins. Absence is
// proven only when every role is missing; one unreadable role leaves the answer unavailable.
function fileOfAny(facts, roles) {
  const found = roles.map((role) => fileOf(facts, role));
  const hit = found.find((f) => typeof f.text === 'string');
  if (hit) return hit;
  if (found.every((f) => f.absent)) return { absent: true, path: found.map((f) => f.path).filter(Boolean).join(' or ') };
  return found.find((f) => f.result) || { result: unavailable('not-read') };
}

const rolesOf = (c) => (Array.isArray(c.files) ? c.files : [c.file]);

const TYPES = {
  'base-branch': (c, facts) => {
    const s = facts.base && facts.base.status;
    if (s === 'ok') return make('pass', `origin/${facts.base.name} found`);
    if (s === 'no-base') return make('fail', `origin/${(facts.base && facts.base.name) || 'base'} not found`);
    return unavailable(s || 'no-repo');
  },
  'file-exists': (c, facts) => {
    const f = fileOfAny(facts, rolesOf(c));
    if (f.result) return f.result;
    return f.absent ? make('fail', `${f.path || c.file} not found on the base branch`) : make('pass', `${f.path || c.file} found`);
  },
  // The named block must hold every marker, in order (the SALA region of the ciclo block).
  'block-markers': (c, facts) => {
    const f = fileOf(facts, c.file);
    if (f.result) return f.result;
    if (f.absent) return unavailable('missing');
    const body = blockBody(f.text, c.name);
    if (body === null) return make('fail', `${c.name} block not found or not closed`);
    let from = 0;
    const missing = c.markers.filter((m) => {
      const at = body.indexOf(m, from);
      if (at === -1) return true;
      from = at + m.length;
      return false;
    });
    return missing.length ? make('fail', `missing in the ${c.name} block: ${missing.join(', ')}`) : make('pass', `${c.markers.join(' ... ')} found in the ${c.name} block`);
  },
  // The file needs a markdown heading for each section (case-insensitive match on the heading text).
  headings: (c, facts) => {
    const f = fileOfAny(facts, rolesOf(c));
    if (f.result) return f.result;
    if (f.absent) return unavailable('missing');
    const heads = headingLines(f.text).map((h) => h.toLowerCase());
    const missing = c.sections.filter((s) => !heads.some((h) => h.includes(s.match.toLowerCase())));
    return missing.length ? make('fail', `missing: ${missing.map((s) => s.label).join(', ')}`) : make('pass', `headings found for ${c.sections.map((s) => s.label).join(', ')}`);
  },
  block: (c, facts, registry) => {
    const f = fileOf(facts, c.file);
    if (f.result) return f.result;
    if (f.absent) return unavailable('missing');
    const expected = registry.blocks && registry.blocks[c.name];
    const b = parseBlock(f.text, c.name, expected);
    if (b.status === 'ok') return make('pass', `${c.name} block version ${b.version}`);
    const detail = BLOCK_DETAIL[b.status]({ ...b, expected });
    return make(b.status === 'outdated' || b.status === 'legacy' ? 'outdated' : 'fail', detail);
  },
  'roadmap-header': (c, facts) => {
    const f = fileOf(facts, c.file);
    if (f.result) return f.result;
    if (f.absent) return unavailable('missing');
    const h = headerCheck(f.text);
    if (h.ok) return make('pass', 'three header lines in order');
    return make('fail', h.missing.length ? `missing: ${h.missing.join(', ')}` : 'header lines out of order');
  },
  'roadmap-table': (c, facts) => {
    const f = fileOf(facts, c.file);
    if (f.result) return f.result;
    if (f.absent) return unavailable('missing');
    const errors = lib.parseRoadmap(f.text).problems.filter((p) => p.severity === 'error');
    if (!errors.length) return make('pass', 'no errors in the units table');
    return make('fail', `${errors.length} error${errors.length === 1 ? '' : 's'}: ${errors[0].message}`);
  },
};

// Members of a room may get a stricter level than the rest.
const levelFor = (req, facts) => (facts.room && req.levelInRoom ? req.levelInRoom : req.level);

function evaluateOne(req, facts, registry) {
  let r;
  if (req.category !== 'verificable') r = make('unavailable', 'needs a person to confirm; never reported as passing', 'manual');
  else if (!req.check || !Object.hasOwn(TYPES, req.check.type)) r = make('unavailable', 'unknown check type', 'unknown-check');
  else r = TYPES[req.check.type](req.check, facts, registry);
  return { id: req.id, title: req.title, category: req.category, level: levelFor(req, facts), status: r.status, detail: r.detail, remedy: req.remedy };
}

// `list` names the registry array to evaluate: 'requirements' (a repo) or 'roomRequirements' (a room repo).
// A requirement marked `onlyInRoom` is left out entirely unless facts.room is set.
function evaluate(registry, facts, list = 'requirements') {
  const reg = registry && typeof registry === 'object' ? registry : {};
  const f = facts || {};
  const reqs = (Array.isArray(reg[list]) ? reg[list] : []).filter((req) => f.room || !req.onlyInRoom);
  const results = reqs.map((req) => evaluateOne(req, f, reg));
  const count = (level) => {
    const own = results.filter((r) => r.level === level);
    return { pass: own.filter((r) => r.status === 'pass').length, total: own.length };
  };
  const required = count('required');
  return {
    results,
    summary: { required, recommended: count('recommended'), ready: required.total > 0 && required.pass === required.total },
  };
}

module.exports = { parseBlock, headerCheck, evaluate };
