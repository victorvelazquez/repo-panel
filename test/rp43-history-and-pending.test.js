'use strict';
// RP43: an old task system that keeps a checklist inside each change (OpenSpec `tasks.md`, fichas) is history, not a task
// list. Only what is still pending is imported, as ONE row per change that says "sin verificar": the agent cannot tell
// from the code whether pending work is done (an audit can reopen a step on purpose, a gate is a decision), and a wrong
// `Completada` hides work and unblocks rows by mistake. The verification happens when the row is taken, with evidence and
// the person's OK (the `tareas` block). The examples are RUN against the panel's validator.
const test = require('node:test');
const assert = require('node:assert/strict');
const lib = require('../lib.js');
const { parseBlock } = require('../checks.js');
const { read, installText, step } = require('./install-steps.js');

const registry = JSON.parse(read('requirements.json'));
const TAREAS = () => read('requirements', 'blocks', 'tareas.md');
const EXAMPLES = () => read('requirements', 'EXAMPLES.md');
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const atLeast = (version, min) => {
  const a = version.split('.').map(Number);
  const b = min.split('.').map(Number);
  for (let i = 0; i < Math.max(a.length, b.length); i++) if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) > (b[i] || 0);
  return true;
};
// The note every migrated pending row carries, and the marker the tareas block keys on.
const NOTE = 'Migrada; sin verificar si ya se implementó';
const MARK = 'sin verificar';

const example = (label) => {
  const m = new RegExp('```md ejemplo:' + escapeRe(label) + '\\n([\\s\\S]*?)\\n```').exec(EXAMPLES());
  assert.ok(m, `example ${label} is missing from requirements/EXAMPLES.md`);
  return m[1];
};
const HEADER = '**Dónde está:** a\n**Qué sigue:** b\n**Qué lo bloquea:** c\n\n';
const errorsOf = (table) => lib.parseRoadmap(HEADER + table + '\n').problems.filter((p) => p.severity === 'error').map((p) => p.message);

// ---------- versions: a change of what the agents read is a change of version ----------
test('the tareas block and the padrón moved to 1.1 or later, and the block still parses at the registry version', () => {
  assert.ok(atLeast(registry.blocks.tareas, '1.1'), `tareas is ${registry.blocks.tareas}`);
  assert.ok(atLeast(registry.padron, '1.1'), `padron is ${registry.padron}`);
  assert.deepEqual(parseBlock(TAREAS(), 'tareas', registry.blocks.tareas, 'panel'), { status: 'ok', version: registry.blocks.tareas });
  assert.ok(TAREAS().trimEnd().split('\n').length <= 30);
});

test('the remedy of padron-record no longer carries a fixed version number (it would mislead after the next bump)', () => {
  const req = registry.requirements.find((r) => r.id === 'padron-record');
  assert.doesNotMatch(req.remedy, /\b\d+\.\d+\b/);
  assert.match(req.remedy, /Padrón del panel/);
  assert.match(req.remedy, /padrón version of requirements\.json/);
});

// ---------- the tareas block: verify when the row is taken ----------
test('the tareas block says that a row marked "sin verificar" is verified BEFORE it is taken, with evidence and the person OK', () => {
  const b = TAREAS();
  assert.ok(b.includes(`«Migrada; ${MARK}»`), 'the block keys on the marker');
  assert.match(b, /verificá si ya está hecha/);
  for (const proof of ['PR fusionados', 'commits', 'pruebas que pasan', 'recibos']) assert.ok(b.includes(proof), proof);
  assert.match(b, /ya está hecha, si falta o si no se puede saber/);
  assert.match(b, /Nunca la marques `Completada` sin su OK/);
  assert.match(b, /evidencia en `Notas`/);
});

test('the marker the block keys on is exactly the one INSTALL tells the agent to write', () => {
  assert.ok(NOTE.includes(MARK));
  assert.ok(step(7).includes(NOTE), 'INSTALL step 7 writes the standard note');
  assert.ok(TAREAS().includes(MARK));
});

// ---------- INSTALL step 7 ----------
test('step 7: a checklist kept inside each change is history, never one row per checkbox, and only what is pending is imported', () => {
  const s = step(7);
  assert.match(s, /is not a task list/);
  assert.match(s, /leave it where it is, as history/);
  assert.match(s, /never write a row per checkbox/i);
  assert.match(s, /ONE row/);
  assert.match(s, /Changes with every item checked, and archived ones, get no row/);
  assert.match(s, /list those changes in your report/);
});

test('step 7: the agent does NOT verify whether pending work is already implemented, and says why', () => {
  const s = step(7);
  assert.match(s, /Do not check whether the pending work is already implemented/);
  assert.match(s, /reopened on purpose by an audit/);
  assert.match(s, /wrong `Completada` hides work/);
});

test('step 7: a state with a pause is Bloqueada when the source names what blocks it, otherwise Pendiente, and the pause stays in Notas', () => {
  const s = step(7);
  assert.match(s, /Paused/);
  assert.match(s, /`Bloqueada` if the source names what blocks it, otherwise `Pendiente`/);
  assert.match(s, /pause in `Notas`/);
});

test('what earlier units pinned for step 7 is still there: one mechanism, never invent dependencies, ask only when an ID or state cannot be derived', () => {
  const s = step(7);
  assert.match(s, /ONE mechanism/);
  assert.match(s, /never infer or invent dependencies/i);
  assert.match(s, /STOP and ask the user only when a task's ID or state cannot be derived/);
});

// ---------- the examples, executed ----------
test('example C also translates the paused states, and every row still lands on one of the four states', () => {
  const rows = example('c-estados').split('\n').filter((l) => /^\|/.test(l) && !/^\|\s*-/.test(l)).slice(1).map((l) => l.split('|').map((c) => c.trim()));
  const blocked = rows.find(([, from]) => /Paused - Bloqueado por DevOps/.test(from));
  const nice = rows.find(([, from]) => /Paused - Nice-to-have/.test(from));
  assert.equal(blocked && blocked[2], 'Bloqueada');
  assert.equal(nice && nice[2], 'Pendiente');
  for (const [, , to] of rows) assert.ok(['Pendiente', 'En curso', 'Completada', 'Bloqueada'].includes(to), to);
});

test('example F: a per-change checklist becomes ONE pending row, with the standard note counting what was left unchecked', () => {
  const before = example('f-antes');
  const boxes = before.split('\n').filter((l) => /^\s*- \[[ xX]\]/.test(l));
  const open = boxes.filter((l) => /^\s*- \[ \]/.test(l));
  assert.ok(boxes.length >= 4 && open.length >= 1 && open.length < boxes.length, 'a checklist with some steps done and some pending');
  const after = example('f-despues');
  assert.deepEqual(errorsOf(after), []);
  const rows = lib.parseRoadmap(HEADER + after + '\n').rows;
  assert.equal(rows.length, 1, 'ONE row for the whole change, not one per checkbox');
  const [row] = rows;
  assert.equal(row.estado, 'Pendiente');
  assert.ok(before.includes(row.id), 'the ID is the name of the change');
  assert.ok(row.notas.includes(NOTE));
  assert.ok(row.notas.includes(`${open.length} de ${boxes.length} pasos sin marcar`), 'the count matches the checklist');
  assert.equal(row.ficha, `openspec/changes/${row.id}/`, 'the ficha is the folder of the change, which stays untouched');
  assert.deepEqual(row.dependsOn, [], 'no invented dependency');
});

// ---------- where a person will look ----------
test('the manual checklist and the README describe the rule', () => {
  const doc = read('docs', 'PRUEBAS-put-in-conditions.md');
  assert.match(doc, /openspec/i);
  assert.ok(doc.includes(MARK));
  const readme = read('README.md');
  assert.ok(readme.includes(MARK));
  assert.match(readme, /history/i);
});
