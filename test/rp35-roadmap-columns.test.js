'use strict';
// RP35: the instructions the agent reads must name the roadmap columns the validator requires, so a repo put in
// conditions gets a table that passes. The validator's own list (lib.RM_REQUIRED) is the single source: if it changes,
// these tests fail until the instructions are updated.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const lib = require('../lib.js');

const ROOT = path.join(__dirname, '..');
const lf = (text) => text.replace(/\r\n/g, '\n');
const read = (...p) => lf(fs.readFileSync(path.join(ROOT, ...p), 'utf8'));
const registry = JSON.parse(read('requirements.json'));
const remedyOf = (id) => registry.requirements.find((r) => r.id === id).remedy;
const { step: installStep } = require('./install-steps.js');

test('the validator exports the list of required columns', () => {
  assert.deepEqual(lib.RM_REQUIRED, ['ID', 'Entrega', 'Depende de', 'Estado']);
});

test('the remedy of roadmap-file names every required column, exactly as the validator spells it', () => {
  for (const name of lib.RM_REQUIRED) assert.ok(remedyOf('roadmap-file').includes(`\`${name}\``), `roadmap-file remedy lacks \`${name}\``);
});

test('the remedy of roadmap-table names every required column too, and says to rename a wrong header', () => {
  for (const name of lib.RM_REQUIRED) assert.ok(remedyOf('roadmap-table').includes(`\`${name}\``), `roadmap-table remedy lacks \`${name}\``);
  assert.match(remedyOf('roadmap-table'), /rename/i);
});

test('INSTALL.md step 7 names every required column and the optional ones the panel reads', () => {
  const step = installStep(7);
  for (const name of [...lib.RM_REQUIRED, 'Resultado visible', 'Notas', 'Ficha']) assert.ok(step.includes(`\`${name}\``), `INSTALL.md step 7 lacks \`${name}\``);
});

test('the remedy of roadmap-file no longer points to registro.md for the table: that block does not define the columns', () => {
  assert.doesNotMatch(remedyOf('roadmap-file'), /described in requirements\/blocks\/registro\.md/);
  assert.doesNotMatch(read('requirements', 'blocks', 'registro.md'), /Depende de/, 'the registro block is copied verbatim into other repos and stays untouched');
});

test('a table written with exactly the names of the instructions passes the validator', () => {
  const head = `| ${lib.RM_REQUIRED.join(' | ')} | Notas |\n| ${[...lib.RM_REQUIRED, 'Notas'].map(() => '---').join(' | ')} |\n`;
  const out = lib.parseRoadmap(`**Dónde está:** a\n**Qué sigue:** b\n**Qué lo bloquea:** c\n\n${head}| U1 | algo | - | Pendiente | x |\n`);
  assert.deepEqual(out.problems.filter((p) => p.severity === 'error'), []);
});

test('the wrong header the agent produced in flow-skills is reported as before (the validator did not change)', () => {
  const out = lib.parseRoadmap('| ID | Unidad | Dependencias | Estado | Notas |\n| --- | --- | --- | --- | --- |\n| FS1 | x | - | Completada | PR |\n');
  const msg = out.problems.map((p) => p.message).join(' ');
  assert.match(msg, /Table is missing required columns: Entrega, Depende de/);
});
