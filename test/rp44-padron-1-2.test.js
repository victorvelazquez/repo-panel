'use strict';
// RP44: padrón 1.2. Three decisions of the person, pinned through what the agent reads and what the panel judges:
//  1. The `ciclo` block is required for EVERY repo, not only for members of a room.
//  2. A row is "migrated, unverified" only when its Notas START with «Migrada; sin verificar»: the words "sin verificar"
//     inside ordinary prose (a note about a JSONL schema) must not make the agent verify a task that is not migrated.
//  3. Old indexes that repeated statuses are replaced by one pointer line, but what they said that is NOT a status
//     (requester, points, recommended phases) moves to the fichas first; a row that points to an instruction file the
//     repo no longer follows stays, and the file is only reported.
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseBlock, evaluate } = require('../checks.js');
const { read, step, installText } = require('./install-steps.js');

const registry = JSON.parse(read('requirements.json'));
const TAREAS = () => read('requirements', 'blocks', 'tareas.md');
const atLeast = (version, min) => {
  const a = version.split('.').map(Number);
  const b = min.split('.').map(Number);
  for (let i = 0; i < Math.max(a.length, b.length); i++) if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) > (b[i] || 0);
  return true;
};

test('the padrón and the tareas block moved to 1.2 or later; the ciclo block text did not change, so it keeps its version', () => {
  assert.ok(atLeast(registry.padron, '1.2'), `padron is ${registry.padron}`);
  assert.ok(atLeast(registry.blocks.tareas, '1.2'), `tareas is ${registry.blocks.tareas}`);
  assert.deepEqual(parseBlock(TAREAS(), 'tareas', registry.blocks.tareas, 'panel'), { status: 'ok', version: registry.blocks.tareas });
  assert.match(installText().split('\n')[0], new RegExp(`\\(padrón ${registry.padron.replace('.', '\\.')}\\)`));
});

// ---------- 1. ciclo is required for every repo ----------
const ciclo = registry.requirements.find((r) => r.id === 'ciclo-block');
const REGISTRO = '<!-- orquestacion:registro v1.0 -->\nrules\n<!-- /orquestacion:registro -->\n';
const CICLO = `<!-- orquestacion:ciclo v${registry.blocks.ciclo} -->\nrules\n<!-- /orquestacion:ciclo -->\n`;
const file = (text) => ({ available: true, text, path: 'x' });
const facts = (agents, room) => ({ base: { status: 'ok', name: 'main' }, room, files: { agents: file(agents), roadmap: file('# none\n'), adoption: file('# none\n') } });
const levelOf = (out) => out.results.find((r) => r.id === 'ciclo-block');

test('ciclo-block is required for a repo that belongs to no room, and the repo is not ready without it', () => {
  assert.equal(ciclo.level, 'required');
  assert.equal(ciclo.levelInRoom, undefined, 'one level for everybody: no per-room override is left on it');
  const without = evaluate(registry, facts(REGISTRO, null));
  assert.equal(levelOf(without).level, 'required');
  assert.equal(levelOf(without).status, 'fail');
  assert.equal(without.summary.ready, false);
  const withIt = evaluate(registry, facts(REGISTRO + CICLO, null));
  assert.equal(levelOf(withIt).status, 'pass');
});

test('ciclo-block is required in a room too, and the SALA region is still asked only there', () => {
  const inRoom = evaluate(registry, facts(REGISTRO, { name: 'UPEN' }));
  assert.equal(levelOf(inRoom).level, 'required');
  const ids = (out) => out.results.map((r) => r.id);
  assert.ok(ids(inRoom).includes('sala-region'));
  assert.ok(!ids(evaluate(registry, facts(REGISTRO, null))).includes('sala-region'));
});

test('the ciclo remedy says it is required and the INSTALL order still installs it', () => {
  assert.doesNotMatch(ciclo.remedy, /recommended/i);
  assert.ok(step(3).includes('`ciclo`'));
});

// ---------- 2. the marker is the START of Notas ----------
test('the tareas block keys the verification on Notas that START with «Migrada; sin verificar», not on the words anywhere', () => {
  const b = TAREAS();
  assert.ok(b.includes('«Migrada; sin verificar»'));
  assert.match(b, /empiezan con «Migrada; sin verificar»/);
  assert.doesNotMatch(b, /`Notas` dicen «sin verificar»/);
  assert.match(b, /en cualquier otro lugar de `Notas`, esas palabras no cuentan/);
  assert.ok(b.trimEnd().split('\n').length <= 30);
});

test('the note INSTALL tells the agent to write starts with the marker the block keys on', () => {
  const s = step(7);
  assert.ok(s.includes('`Migrada; sin verificar si ya se implementó (N de M pasos sin marcar)`'));
  assert.match(s, /start with/i);
});

// ---------- 3. old indexes and the pointer to an obsolete instruction file ----------
test('step 7: an old index becomes ONE pointer line, but what it said that is not a status moves to the fichas first', () => {
  const s = step(7);
  assert.match(s, /with one line pointing to `docs\/ROADMAP\.md`/);
  assert.match(s, /requester, priority, points, recommended phases/);
  assert.match(s, /move it into the ficha of the task it describes BEFORE you replace the index/);
  assert.match(s, /If it belongs to no task, STOP and ask/);
});

test('step 5: a row or link that points to an instruction file the repo no longer follows stays; the file is only reported', () => {
  const s = step(5);
  assert.match(s, /Do not remove a table row or a link that points to such a file/);
  assert.match(s, /The file stays and is reported/);
});

test('the PRUEBAS manual checklist mentions the new rules so the person checks them on a real repo', () => {
  const t = read('docs', 'PRUEBAS-put-in-conditions.md');
  assert.match(t, /empiezan con «Migrada; sin verificar»/);
  assert.match(t, /requester|solicitante/i);
});
