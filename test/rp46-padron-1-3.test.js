'use strict';
// RP46: padrón 1.3. What the test rounds taught (Tecnomyl, PushNotifications), pinned through what the agent reads and what the
// panel judges:
//  A. Migrating never writes `En curso`: nobody is working on what comes from an old system. «In progress» without evidence is
//     `Pendiente` with Notas that START with «Migrada; sin verificar» (22 rows `En curso` at once froze `/flow-next`).
//  B. A registry with its own way of being executed (technical debt, audits) is not part of the task standard: it stays where it is
//     and is only mentioned in the report.
//  C. `.panel/` is ignored in EVERY repo: `panel-ignored` is required, so a repo is not ready without it.
//  D. An obsolete instruction file with technical rules AGENTS.md lacks: compare by CONTENT, move what is missing verbatim, never copy
//     its authority hierarchy, rewrite the pointers and the rows that call it authority, record it, and ask only on a contradiction.
const test = require('node:test');
const assert = require('node:assert/strict');
const lib = require('../lib.js');
const { evaluate } = require('../checks.js');
const { read, step, installText } = require('./install-steps.js');

const registry = JSON.parse(read('requirements.json'));
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

test('the padrón moved to 1.3 or later and INSTALL.md carries it in its title', () => {
  assert.ok(atLeast(registry.padron, '1.3'), `padron is ${registry.padron}`);
  assert.match(installText().split('\n')[0], new RegExp(`\\(padrón ${registry.padron.replace('.', '\\.')}\\)`));
});

// ---------- A. never `En curso` when migrating ----------
test('A: the state table of example C writes Pendiente for «in progress», never En curso', () => {
  const table = example('c-estados');
  const rows = table.split('\n').filter((l) => /^\|/.test(l) && !/^\| ---/.test(l)).slice(1).map((l) => l.split('|').map((c) => c.trim()).filter(Boolean));
  const inProgress = rows.find((r) => /in progress/i.test(r[0]));
  assert.ok(inProgress, 'the «in progress» row exists');
  assert.equal(inProgress[1], 'Pendiente');
  assert.ok(!rows.some((r) => r[1] === 'En curso'), 'no source state is translated to En curso');
});

test('A: step 7 says a migrated row is never En curso and its Notas START with the marker', () => {
  const s = step(7);
  assert.match(s, /Never write `En curso` when you migrate/);
  assert.match(s, /nobody is working on what comes from an old system/);
  assert.match(s, /`Notas` that START with `Migrada; sin verificar si ya se implementó`/);
});

test('A: the migrated rows of an «in progress» source pass the validator as Pendiente', () => {
  const head = '**Dónde está:** a\n**Qué sigue:** b\n**Qué lo bloquea:** c\n\n| ID | Entrega | Depende de | Estado | Notas |\n| --- | --- | --- | --- | --- |\n';
  const rows = '| T1 | one | — | Pendiente | Migrada; sin verificar si ya se implementó. Estado original: En progreso |\n';
  const p = lib.parseRoadmap(head + rows);
  assert.deepEqual(p.problems.filter((x) => x.severity === 'error'), []);
  assert.equal(p.rows[0].estado, 'Pendiente');
  assert.ok(p.rows[0].notas.startsWith('Migrada; sin verificar'));
});

// ---------- B. a registry with its own flow is not migrated ----------
test('B: step 7 leaves a registry with its own execution flow where it is and only reports it', () => {
  const s = step(7);
  assert.match(s, /own way of being executed/);
  assert.match(s, /technical debt/);
  assert.match(s, /leave it where it is/);
  assert.match(s, /do not migrate it, do not edit it and do not delete it/);
  assert.match(s, /mention it in your report/);
});

// ---------- C. .panel/ is ignored in every repo ----------
const ignored = registry.requirements.find((r) => r.id === 'panel-ignored');
const REGISTRO = '<!-- orquestacion:registro v1.0 -->\nrules\n<!-- /orquestacion:registro -->\n';
const file = (text) => ({ available: true, text, path: 'x' });
const everything = () => {
  const b = (ns, n) => `<!-- ${ns}:${n} v${registry.blocks[n]} -->\nrules\n<!-- /${ns}:${n} -->\n`;
  return b('orquestacion', 'registro') + b('panel', 'tareas') + b('panel', 'entrega') + b('orquestacion', 'ciclo') + b('panel', 'estado');
};
const HEAD = '**Dónde está:** a\n**Qué sigue:** b\n**Qué lo bloquea:** c\n\n| ID | Entrega | Depende de | Estado |\n| --- | --- | --- | --- |\n| A1 | e | — | Pendiente |\n';
const facts = (ignoredFlag) => ({
  base: { status: 'ok', name: 'main' }, room: null,
  files: { agents: file(everything()), roadmap: file(HEAD), adoption: file(`# Adopción\n\n- **Padrón del panel:** ${registry.padron}\n`) },
  local: { panelIgnored: { available: true, ignored: ignoredFlag } },
});

test('C: panel-ignored is required, with no per-room override, and a repo without it is not ready', () => {
  assert.equal(ignored.level, 'required');
  assert.equal(ignored.levelInRoom, undefined);
  const without = evaluate(registry, facts(false));
  assert.equal(without.results.find((r) => r.id === 'panel-ignored').level, 'required');
  assert.equal(without.results.find((r) => r.id === 'panel-ignored').status, 'fail');
  assert.equal(without.summary.ready, false);
  const withIt = evaluate(registry, facts(true));
  assert.equal(withIt.summary.ready, true, JSON.stringify(withIt.results.filter((r) => r.status !== 'pass')));
});

test('C: the remedy and step 4 say it is for every repo, local to the clone and never in .gitignore', () => {
  assert.match(ignored.remedy, /every repo/i);
  assert.match(ignored.remedy, /never add it to \.gitignore/);
  assert.match(step(4), /EVERY repo/);
});

// ---------- D. obsolete instruction files ----------
test('D: step 5 compares by CONTENT and moves what AGENTS.md lacks, verbatim, leaving the old file untouched', () => {
  const s = step(5);
  assert.match(s, /Compare by CONTENT, never by headings/);
  assert.match(s, /move it into `AGENTS\.md` verbatim/);
  assert.match(s, /do not summarize/);
  assert.match(s, /leave the old file untouched/);
  assert.doesNotMatch(s, /so the person decides what to move into `AGENTS\.md` before removing it/);
});

test('D: step 5 never copies the authority hierarchy and rewrites the pointers and rows that call the old file an authority', () => {
  const s = step(5);
  assert.match(s, /Never copy its authority hierarchy/);
  assert.match(s, /Rewrite every pointer to it and every row that calls it an authority/);
  assert.match(s, /legacy file kept for another tool/);
});

test('D: step 5 records what was moved and stops only when two rules contradict', () => {
  const s = step(5);
  assert.match(s, /record in `docs\/ORQUESTACION\.md`/);
  assert.match(s, /STOP and ask only when two rules contradict each other/);
  assert.match(s, /not for each section you move/);
});

test('D: example G shows the move, the rewritten authority row and the record', () => {
  const g = example('g-archivo-obsoleto');
  assert.match(g, /Antes|Before/);
  assert.match(g, /Primary architectural/);
  assert.match(g, /legacy file kept for another tool/i);
  assert.match(g, /ORQUESTACION/);
});

test('the manual checklist covers the new cases so the person checks them on a real repo', () => {
  const t = read('docs', 'PRUEBAS-put-in-conditions.md');
  assert.match(t, /nunca escribe `En curso`/);
  assert.match(t, /registro aparte/i);
  assert.match(t, /compara por \*\*contenido\*\*/);
});
