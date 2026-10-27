'use strict';
// RP39: what the agent reads when the repo already has a roadmap. In the first real runs the agent moved a 1235-line
// ROADMAP.md from the root to docs/, restructured its tables, invented a dependency chain and edited two other files,
// all without asking: nothing in INSTALL.md said to stop. These tests pin the instructions that close that gap. They
// read the texts the agent reads; what the agent does with them is for docs/PRUEBAS-put-in-conditions.md.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const lf = (text) => text.replace(/\r\n/g, '\n');
const read = (...p) => lf(fs.readFileSync(path.join(ROOT, ...p), 'utf8'));
const registry = JSON.parse(read('requirements.json'));
const remedyOf = (id) => registry.requirements.find((r) => r.id === id).remedy;
// A step of INSTALL.md is its own line, from "N. " to the next numbered line.
const { step } = require('./install-steps.js');

// RP39 first told the agent to STOP before touching a roadmap that already exists and to offer three options. The user then
// decided to abandon every other way of managing tasks (RP40), so step 7 now migrates by default: those two tests moved to
// test/rp40-task-mechanism.test.js, which pins the new policy. What stays here is what RP39 added and RP40 keeps.

test('step 7 forbids inventing dependencies: a unit without one gets a dash', () => {
  const s = step(7);
  assert.match(s, /never infer or invent dependencies/i);
  assert.match(s, /write `—`/);
});

test('step 7 keeps writing the single row U0 for a project with no plan yet, and nothing else', () => {
  const s = step(7);
  assert.match(s, /`U0`/);
  assert.match(s, /Adoptar la Orquestación/);
  assert.match(s, /only row/i);
  assert.match(s, /ask the user for the plan/i);
});

test('the remedies of roadmap-file and roadmap-table point to the migration rule, so the agent meets it from the order too', () => {
  for (const id of ['roadmap-file', 'roadmap-table']) {
    assert.match(remedyOf(id), /already tracks tasks/i, id);
    assert.match(remedyOf(id), /migrate them/i, id);
    assert.match(remedyOf(id), /INSTALL\.md step 7/, id);
    assert.doesNotMatch(remedyOf(id), /stop and ask/i, id);
  }
});

test('the remedy of adoption-record asks for the date, the profile, the block versions and what was left out', () => {
  const r = remedyOf('adoption-record');
  for (const word of ['date', 'profile', 'version of each block', 'SALA', 'not adopted']) assert.match(r, new RegExp(word, 'i'), word);
});

test('what RP35 pinned is still there: the exact column names and the rename rule in step 7', () => {
  const s = step(7);
  for (const name of ['ID', 'Entrega', 'Depende de', 'Estado', 'Resultado visible', 'Notas', 'Ficha']) assert.ok(s.includes(`\`${name}\``), name);
  assert.match(s, /rename those headers/i);
  assert.match(s, /Do not invent units/);
});

test('the other steps keep their core: step 6 still stops on a conflict that is not about tasks and step 8 still forbids commits', () => {
  assert.match(step(6), /STOP/);
  assert.match(step(8), /Never commit by any means other than `\/flow-commit`/);
});

test('the manual checklist no longer says the ciclo block is copied as is: it names the SALA region rule', () => {
  const doc = read('docs', 'PRUEBAS-put-in-conditions.md');
  assert.doesNotMatch(doc, /tres bloques[^.]*copiados \*\*tal cual\*\*/);
  assert.match(doc, /regiones `SALA`/);
  assert.match(doc, /otro sistema de tareas/i);
  assert.match(doc, /migra/);
});
