'use strict';
// Pure requirement checks (no I/O): the server reads the facts, this file only decides.
//
// facts = {
//   base:  { status: 'ok' | 'no-repo' | 'no-base', name },
//   files: { <role>: { available, reason, text, path } }   // roles: agents, roadmap, adoption; the shape
// };                                                        // is what server/roadmap.js remoteFile returns
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

const TYPES = {
  'base-branch': (c, facts) => {
    const s = facts.base && facts.base.status;
    if (s === 'ok') return make('pass', `origin/${facts.base.name} found`);
    if (s === 'no-base') return make('fail', `origin/${(facts.base && facts.base.name) || 'base'} not found`);
    return unavailable(s || 'no-repo');
  },
  'file-exists': (c, facts) => {
    const f = fileOf(facts, c.file);
    if (f.result) return f.result;
    return f.absent ? make('fail', `${f.path || c.file} not found on the base branch`) : make('pass', `${f.path || c.file} found`);
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

function evaluateOne(req, facts, registry) {
  let r;
  if (req.category !== 'verificable') r = make('unavailable', 'needs a person to confirm; never reported as passing', 'manual');
  else if (!req.check || !Object.hasOwn(TYPES, req.check.type)) r = make('unavailable', 'unknown check type', 'unknown-check');
  else r = TYPES[req.check.type](req.check, facts, registry);
  return { id: req.id, title: req.title, category: req.category, level: req.level, status: r.status, detail: r.detail, remedy: req.remedy };
}

function evaluate(registry, facts) {
  const reg = registry && typeof registry === 'object' ? registry : {};
  const reqs = Array.isArray(reg.requirements) ? reg.requirements : [];
  const results = reqs.map((req) => evaluateOne(req, facts || {}, reg));
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
