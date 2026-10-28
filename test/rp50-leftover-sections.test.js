'use strict';
// RP50: `manual-leftovers`. "Put in conditions" only names the ids that fail, so a repo whose AGENTS.md keeps a manual
// section restating what the installed blocks say (and the old /flow-branch) was never asked to clean it. The check
// removes every block region and looks at what is left. Hermetic: pure facts, no config, no network, no git.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { evaluate } = require('../checks.js');

const registry = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'requirements.json'), 'utf8'));
const REQ = registry.requirements.find((r) => r.id === 'manual-leftovers');

const file = (text) => ({ available: true, text, path: 'AGENTS.md' });
const factsFor = (agents) => ({ base: { status: 'ok', name: 'main' }, room: null, files: { agents } });
const run = (text) => evaluate({ requirements: [REQ], blocks: registry.blocks }, factsFor(file(text))).results[0];
const b = (ns, n, body = 'rules') => `<!-- ${ns}:${n} v1.0 -->\n${body}\n<!-- /${ns}:${n} -->\n`;
const BLOCKS = b('orquestacion', 'registro') + b('panel', 'tareas') + b('panel', 'entrega') + b('orquestacion', 'ciclo') + b('panel', 'estado');
const OWN = '# Repo\n\n## Stack\n\nNode 20.\n\n';

const LEFTOVER = `## Orquestación

### Puerta: antes del primer archivo de una unidad nueva
Verificar con git.

### Avisos a Dirección
Avisar.

### Tamaño
450 líneas.

### Verificación según el riesgo
Siempre pruebas.

### Contratos entre proyectos
Ninguno.
`;

test('registry: manual-leftovers is a required verificable check placed right after ciclo-block, not a room requirement', () => {
  assert.ok(REQ, 'the requirement exists');
  assert.equal(REQ.category, 'verificable');
  assert.equal(REQ.level, 'required');
  assert.equal(REQ.title, 'No manual section that a block replaces in AGENTS.md');
  assert.deepEqual(REQ.check, { type: 'leftover-sections', file: 'agents' });
  assert.equal(REQ.levelInRoom, undefined);
  assert.equal(REQ.onlyInRoom, undefined);
  const ids = registry.requirements.map((r) => r.id);
  assert.equal(ids.indexOf('manual-leftovers'), ids.indexOf('ciclo-block') + 1);
  assert.ok(!registry.roomRequirements.some((r) => r.id === 'manual-leftovers'));
  assert.match(REQ.remedy, /INSTALL\.md step 3/);
  assert.match(REQ.remedy, /\/flow-branch/);
  assert.match(REQ.remedy, /ORQUESTACION\.md/);
});

test('registry: the padrón did not change with this unit', () => {
  assert.equal(registry.padron, '1.4');
});

test('pass: only the five blocks plus the repo\'s own sections', () => {
  const r = run(OWN + BLOCKS);
  assert.equal(r.status, 'pass');
});

test('fail: a manual Orquestación section next to the blocks lists its headings', () => {
  const r = run(OWN + BLOCKS + LEFTOVER);
  assert.equal(r.status, 'fail');
  for (const h of ['Orquestación', 'Puerta: antes del primer archivo de una unidad nueva', 'Avisos a Dirección']) assert.ok(r.detail.includes(h), `${h} in: ${r.detail}`);
});

test('fail: /flow-branch outside the blocks; pass when the same words are only inside a block', () => {
  const out = run(OWN + BLOCKS + 'Use /flow-branch to start.\n');
  assert.equal(out.status, 'fail');
  assert.ok(out.detail.includes('/flow-branch'));
  const inside = run(OWN + b('orquestacion', 'ciclo', 'old name /flow-branch') + BLOCKS);
  assert.equal(inside.status, 'pass');
});

test('a heading with the block names INSIDE a block region is ignored', () => {
  const body = '## Orquestación: ciclo de entrega\n### Tamaño\n### Puerta: antes del primer archivo\n### Estados\n';
  assert.equal(run(OWN + b('orquestacion', 'ciclo', body) + b('panel', 'estado', '### Memoria')).status, 'pass');
});

test('headings are normalized: level 2 to 4, case, backticks and trailing punctuation; level 1 and 5 are not looked at', () => {
  assert.equal(run(OWN + '#### `Memoria`:\n').status, 'fail');
  assert.equal(run(OWN + '## ESTADOS.\n').status, 'fail');
  assert.equal(run(OWN + '### Antes de escribir el primer archivo de una unidad\n').status, 'fail');
  assert.equal(run(OWN + '# Tamaño\n').status, 'pass');
  assert.equal(run(OWN + '##### Tamaño\n').status, 'pass');
  assert.equal(run(OWN + '## Tamaño del bundle\n').status, 'pass', 'only an exact title counts');
  assert.equal(run(OWN + '## Orquestación y más\n').status, 'pass', 'orquestación has no suffix');
});

test('every listed title is recognized', () => {
  const titles = ['Estados', 'Comando siguiente', 'Al terminar una unidad', 'Memoria', 'Avisos a Dirección', 'Órdenes de Dirección', 'Órdenes y pases de Dirección', 'Tamaño', 'Verificación según el riesgo', 'Contratos entre proyectos', 'Comandos del propietario', 'Comandos de la persona', 'Informar en pantalla', 'Reporte de unidad', 'Orquestación'];
  for (const t of titles) assert.equal(run(`${OWN}### ${t}\n`).status, 'fail', t);
});

test('the cleaned version, with a short own section, passes', () => {
  const clean = OWN + BLOCKS + '## Propio de esta web\n\nCorrer `npm run verificar` antes de entregar.\n';
  assert.equal(run(clean).status, 'pass');
});

test('unavailable when the AGENTS.md file is unavailable, like the neighbouring checks', () => {
  const read = (agents) => evaluate({ requirements: [REQ] }, factsFor(agents)).results[0];
  assert.equal(read({ available: false, reason: 'timeout' }).status, 'unavailable');
  assert.equal(read({ available: false, reason: 'missing' }).status, 'unavailable');
  assert.equal(evaluate({ requirements: [REQ] }, { base: { status: 'no-repo' }, files: {} }).results[0].status, 'unavailable');
});

test('through evaluate(): a repo that meets everything but this one is not ready and the open ids are exactly [manual-leftovers]', () => {
  const blocks = ['registro', 'ciclo'].map((n) => b('orquestacion', n)).concat(['tareas', 'entrega', 'estado'].map((n) => b('panel', n))).join('');
  const versioned = blocks.replace(/ v1\.0 -->/g, (m, off, s) => {
    const name = /:(\w+) v1\.0 -->$/.exec(s.slice(0, off + m.length))[1];
    return ` v${registry.blocks[name]} -->`;
  });
  const HEAD = '**Dónde está:** a\n**Qué sigue:** b\n**Qué lo bloquea:** c\n\n| ID | Entrega | Depende de | Estado |\n| --- | --- | --- | --- |\n| A1 | e | — | Pendiente |\n';
  const facts = (agents) => ({
    base: { status: 'ok', name: 'main' }, room: null,
    files: { agents: file(agents), roadmap: file(HEAD), adoption: file(`# Adopción\n\n- **Padrón del panel:** ${registry.padron}\n`) },
    local: { panelIgnored: { available: true, ignored: true } },
  });
  const good = evaluate(registry, facts(OWN + versioned));
  assert.equal(good.summary.ready, true, JSON.stringify(good.results.filter((r) => r.status !== 'pass')));
  const bad = evaluate(registry, facts(OWN + versioned + LEFTOVER));
  assert.equal(bad.summary.ready, false);
  assert.deepEqual(bad.results.filter((r) => r.status !== 'pass').map((r) => r.id), ['manual-leftovers']);
});

test('the detail lists at most 5 findings', () => {
  const many = ['Estados', 'Memoria', 'Tamaño', 'Reporte de unidad', 'Informar en pantalla', 'Orquestación', 'Comandos de la persona'].map((t) => `## ${t}\n`).join('') + '/flow-branch\n';
  const r = run(OWN + many);
  assert.equal(r.status, 'fail');
  assert.equal(r.detail.split(';').length <= 5 || r.detail.split(', ').length <= 5, true, r.detail);
  assert.ok(!r.detail.includes('Comandos de la persona'), 'the sixth finding is cut');
  assert.ok(!r.detail.includes('/flow-branch'), 'the eighth finding is cut');
});
