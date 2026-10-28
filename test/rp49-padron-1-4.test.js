'use strict';
// RP49: padrón 1.4. What the second round of real repos taught (UPEN, BackofficeFront, Tecnomyl), pinned through what the agent reads:
//  1. A manual section that restates what a block already says (the "Orquestación" section of pages, web and chat) is replaced WHOLE;
//     only the lines the block does not say stay, in a short section of the repo; if two versions differ the block wins.
//  2. A paragraph that mixes the task mechanism with other rules (upen-erp) is split: only the task part goes.
//  3. A ficha only receives the one line that points to the roadmap; the agent never changes a checkbox or a state inside it, and never
//     changes the state of a row that already exists (it reports it instead).
//  4. The ficha of a new row goes where the repo already keeps its fichas, never in a folder Git ignores (upen-core ignores odd/).
//  5. A repo that chose between classes of rows with a text rule (product slice vs UX item): the table is ordered, `siguiente` takes the
//     first Pendiente; and a skill or script of its own that executes "the next task" stays and is reported.
//  6. A table that only lists tools of an obsolete instruction file is not "rules": it is reported, not moved.
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseBlock } = require('../checks.js');
const { read, step, installText } = require('./install-steps.js');

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
const example = (label) => {
  const m = new RegExp('```md ejemplo:' + escapeRe(label) + '\\n([\\s\\S]*?)\\n```').exec(EXAMPLES());
  assert.ok(m, `example ${label} is missing from requirements/EXAMPLES.md`);
  return m[1];
};

test('the padrón moved to 1.4 and the tareas block to 1.3; the block still parses at the registry version', () => {
  assert.ok(atLeast(registry.padron, '1.4'), `padron is ${registry.padron}`);
  assert.ok(atLeast(registry.blocks.tareas, '1.3'), `tareas is ${registry.blocks.tareas}`);
  assert.deepEqual(parseBlock(TAREAS(), 'tareas', registry.blocks.tareas, 'panel'), { status: 'ok', version: registry.blocks.tareas });
  assert.match(installText().split('\n')[0], new RegExp(`\\(padrón ${registry.padron.replace('.', '\\.')}\\)`));
  assert.ok(TAREAS().trimEnd().split('\n').length <= 30);
});

// ---------- 1. a manual section covered by a block is replaced whole ----------
test('step 3: a manual section that restates a block is replaced WHOLE, only the repo own lines stay, and the block wins', () => {
  const s = step(3);
  assert.match(s, /restates what a block already says/);
  assert.match(s, /replace the WHOLE section/);
  assert.match(s, /keep only the lines the block does not say/);
  assert.match(s, /if two versions differ, the block wins/);
  assert.match(s, /\/flow-branch/);
  assert.match(s, /record in `docs\/ORQUESTACION\.md`/);
});

test('step 5: the exception to «never delete rules» now names both cases: steps 7 and 8, and the sections a block replaces', () => {
  const s = step(5);
  assert.doesNotMatch(s, /with ONE exception/);
  assert.match(s, /with TWO exceptions/);
  assert.match(s, /the sections that step 3 says a block replaces/);
});

test('example H shows a manual section replaced whole, with the repo own line kept in a short section', () => {
  const h = example('h-seccion-manual');
  assert.match(h, /Antes/);
  assert.match(h, /Puerta/);
  assert.match(h, /\/flow-branch/);
  assert.match(h, /Después/);
  assert.match(h, /npm run verificar/);
  assert.doesNotMatch(h.split('Después')[1], /\/flow-branch/, 'the old command name does not survive');
});

// ---------- 2. mixed paragraphs ----------
test('step 7: a paragraph that mixes the task mechanism with other rules is split; only the task part goes, and it is recorded', () => {
  const s = step(7);
  assert.match(s, /mixes how to choose or run tasks with other rules/);
  assert.match(s, /split it/);
  assert.match(s, /remove only the task part/);
  assert.match(s, /scope or authority rule/);
});

// ---------- 3. fichas and existing rows are not edited ----------
test('step 7: a ficha only receives the pointer line; the agent never changes a checkbox or a state inside it or in an existing row', () => {
  const s = step(7);
  assert.match(s, /only receives the one line that points to `docs\/ROADMAP\.md`/);
  assert.match(s, /never change a checkbox or a state inside a ficha/);
  assert.match(s, /never change the state of a row that already exists/);
  assert.match(s, /say it in your report/);
});

// ---------- 4. where the ficha lives ----------
test('the tareas block 1.3 puts a new ficha where the repo already keeps its fichas, never in a folder Git ignores', () => {
  const b = TAREAS();
  assert.match(b, /donde este repositorio ya guarda sus fichas/);
  assert.match(b, /`odd\/tasks\/<ID>\.md`/);
  assert.match(b, /nunca en una carpeta que Git ignore/);
  assert.ok(b.includes('Si necesita más detalle'), 'the rest of the Crear paragraph is intact');
});

test('step 7 tells the agent the same about the ficha folder, and to report it', () => {
  const s = step(7);
  assert.match(s, /where the repo already keeps its fichas/);
  assert.match(s, /ignored by Git/);
});

// ---------- 5. classes of rows and executors of its own ----------
test('step 7: a text rule that chose between classes of rows becomes the order of the table, and is reported', () => {
  const s = step(7);
  assert.match(s, /chose between classes of tasks/);
  assert.match(s, /`siguiente` takes the first `Pendiente` row in table order/);
  assert.match(s, /put the class the repo preferred first/);
});

test('step 7: a skill or script of the repo that executes «the next task» stays where it is and is reported as competing with siguiente', () => {
  const s = step(7);
  assert.match(s, /skill or script of its own that executes the next task/);
  assert.match(s, /competes with `siguiente`/);
  assert.match(s, /leave the decision to the person/);
});

// ---------- 6. tool tables ----------
test('step 5: a table that only lists tools or skills of an obsolete file is reported, not moved', () => {
  const s = step(5);
  assert.match(s, /only lists tools or skills/);
  assert.match(s, /is not a rule: report it, do not move it/);
});

test('the manual checklist covers the new cases', () => {
  const t = read('docs', 'PRUEBAS-put-in-conditions.md');
  assert.match(t, /sección manual de «Orquestación»/);
  assert.match(t, /párrafo que mezcla/);
  assert.match(t, /solo recibe la línea/);
  assert.match(t, /carpeta que Git ignora/);
  assert.match(t, /dos clases de filas/);
});
