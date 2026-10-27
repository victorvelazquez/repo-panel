'use strict';
// RP40: ONE mechanism to create and manage tasks, written out for the agent and mandatory. The user decided to abandon
// every other practice, including the instructions an AGENTS.md carries about how to create tasks. The mechanism is the
// panel's `tareas` block (copied into each repo's AGENTS.md) and step 7 of INSTALL.md tells the agent to migrate, not to
// ask which system to keep. The block talks ONLY about tasks: branches, commits and pull requests are the `entrega`
// block (test/rp41-standard.test.js). These tests read the texts the agent reads; what the agent does with them is for
// docs/PRUEBAS-put-in-conditions.md.
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseBlock } = require('../checks.js');
const { read, step } = require('./install-steps.js');

const registry = JSON.parse(read('requirements.json'));
const BLOCK = () => read('requirements', 'blocks', 'tareas.md');

// ---------- the block ----------
test('requirements/blocks/tareas.md is a closed panel:tareas block at the registry version, short enough to read at a glance', () => {
  assert.deepEqual(parseBlock(BLOCK(), 'tareas', registry.blocks.tareas, 'panel'), { status: 'ok', version: registry.blocks.tareas });
  assert.ok(BLOCK().trimEnd().split('\n').length <= 30);
});

test('the block says it is the ONLY mechanism and voids any earlier instruction about creating or managing tasks', () => {
  const b = BLOCK();
  assert.match(b, /ÚNICO mecanismo/);
  assert.match(b, /queda sin efecto/);
  assert.match(b, /no la sigas/);
});

test('the block says where a task lives, how it is created, taken and closed, in the words of the registro states', () => {
  const b = BLOCK();
  assert.match(b, /fila de `docs\/ROADMAP\.md`/);
  for (const needle of ['`ID`', '`Entrega`', '`Resultado visible`', '`Depende de`', '`Notas`', '`Ficha`', '`odd/tasks/<ID>.md`']) assert.ok(b.includes(needle), needle);
  assert.match(b, /`siguiente`/);
  assert.match(b, /Una tarea = un PR/);
  for (const state of ['`Pendiente`', '`En curso`', '`Completada`', '`Bloqueada`']) assert.ok(b.includes(state), state);
  assert.match(b, /`Lista` y `En revisión`[^.]*calcula el panel/);
});

test('the block forbids a parallel system and inventing dependencies', () => {
  const b = BLOCK();
  assert.match(b, /Prohibido/);
  assert.match(b, /carpetas de planificación/);
  assert.match(b, /otro vocabulario de estados/);
  assert.match(b, /nunca las inferas/);
});

test('the block talks ONLY about tasks: nothing about branches, commits or pull requests commands (that is the entrega block)', () => {
  const b = BLOCK();
  assert.doesNotMatch(b, /\/flow-(base|commit|pr)/);
  assert.doesNotMatch(b, /git add|git mv|git commit/);
  assert.doesNotMatch(b, /Ramas, commits y PR/);
  assert.doesNotMatch(b, /una rama = un PR/);
});

// ---------- the registry ----------
test('the registry versions the block and asks for it as a REQUIRED requirement right after registro-block', () => {
  assert.match(registry.blocks.tareas, /^\d+\.\d+$/);
  const ids = registry.requirements.map((r) => r.id);
  assert.equal(ids[ids.indexOf('registro-block') + 1], 'tareas-block');
  const req = registry.requirements.find((r) => r.id === 'tareas-block');
  assert.deepEqual([req.category, req.level], ['verificable', 'required']);
  assert.deepEqual(req.check, { type: 'block', file: 'agents', name: 'tareas', namespace: 'panel' });
  assert.match(req.remedy, /requirements\/blocks\/tareas\.md/);
  assert.match(req.remedy, /remove from AGENTS\.md every instruction about how to create or manage tasks/);
  assert.match(req.remedy, /INSTALL\.md step 7/);
});

test('a repo without the block, or with an old version of it, does not pass', () => {
  const wanted = registry.blocks.tareas;
  assert.equal(parseBlock('# Repo\n', 'tareas', wanted, 'panel').status, 'missing');
  const older = BLOCK().replace(/panel:tareas v\d+\.\d+/, 'panel:tareas v0.1');
  assert.notEqual(older, BLOCK(), 'the marker was really changed');
  assert.equal(parseBlock(older, 'tareas', wanted, 'panel').status, 'outdated');
});

// ---------- the procedure ----------
test('INSTALL step 7 migrates instead of asking: one mechanism, nothing parallel, the old files are kept as fichas', () => {
  const s = step(7);
  assert.match(s, /ONE mechanism/);
  assert.match(s, /every task is a row of `docs\/ROADMAP\.md`/);
  assert.match(s, /do not ask which system to keep/i);
  assert.match(s, /one row per task/i);
  assert.match(s, /keeping its existing ID/i);
  assert.match(s, /Never delete the old task files/);
  assert.match(s, /they become the fichas/i);
  assert.match(s, /one line pointing to `docs\/ROADMAP\.md`/);
});

test('INSTALL step 7 removes the old task instructions from AGENTS.md and keeps every other rule', () => {
  const s = step(7);
  assert.match(s, /Remove from `AGENTS\.md` every instruction about how to create, name, prioritize, track, assign or close tasks/);
  assert.match(s, /Keep every other rule/);
});

test('INSTALL step 7 asks the user only when an ID or a state cannot be derived, and never invents dependencies or units', () => {
  const s = step(7);
  assert.match(s, /STOP and ask the user only when a task's ID or state cannot be derived/);
  assert.match(s, /never infer or invent dependencies/i);
  assert.match(s, /write `—`/);
  assert.match(s, /Do not invent units/);
});

test('what RP35 and RP39 pinned for step 7 is still there: exact columns, header rename, row U0', () => {
  const s = step(7);
  for (const name of ['ID', 'Entrega', 'Depende de', 'Estado', 'Resultado visible', 'Notas', 'Ficha']) assert.ok(s.includes(`\`${name}\``), name);
  assert.match(s, /rename those headers/i);
  assert.match(s, /`U0`/);
  assert.match(s, /Adoptar la Orquestación/);
});

test('the README explains the policy: one mechanism, migrated not asked, the block that states it', () => {
  const readme = read('README.md');
  assert.match(readme, /`tareas` block/);
  assert.match(readme, /one mechanism to create and manage tasks/i);
});
