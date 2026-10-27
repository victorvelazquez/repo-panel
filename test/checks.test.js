'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseBlock, headerCheck, evaluate } = require('../checks.js');

const HEAD = '**Dónde está:** a\n**Qué sigue:** b\n**Qué lo bloquea:** c\n';
const TABLE = '| ID | Entrega | Resultado visible | Depende de | Estado | Notas | Ficha |\n| --- | --- | --- | --- | --- | --- | --- |\n| A1 | e | r | — | Pendiente | | — |\n';
const block = (v, name = 'registro') => `# R\n<!-- orquestacion:${name} v${v} -->\nrules\n<!-- /orquestacion:${name} -->\n`;
// The required panel block of RP40: a repo that meets everything carries it next to registro.
const TAREAS = '<!-- panel:tareas v1.0 -->\nrules\n<!-- /panel:tareas -->\n';
const ENTREGA = '<!-- panel:entrega v1.0 -->\nrules\n<!-- /panel:entrega -->\n';
// RP41: the adoption record of a repo that meets everything carries the padrón line.
const ADOPTION = '# Adopción\n\n- **Padrón del panel:** 1.0\n';

test('parseBlock: a closed block is ok, with or without an expected version', () => {
  assert.deepEqual(parseBlock(block('1.0'), 'registro'), { status: 'ok', version: '1.0' });
  assert.deepEqual(parseBlock(block('1.0'), 'registro', '1.0'), { status: 'ok', version: '1.0' });
});

test('parseBlock: a closed block with another version is outdated', () => {
  assert.deepEqual(parseBlock(block('0.9'), 'registro', '1.0'), { status: 'outdated', version: '0.9' });
});

test('parseBlock: an open marker without its close is unclosed', () => {
  assert.equal(parseBlock('<!-- orquestacion:registro v1.0 -->\nrules\n', 'registro', '1.0').status, 'unclosed');
});

test('parseBlock: the legacy heading or the old marker is legacy, not missing', () => {
  assert.equal(parseBlock('# A\n\n## Orquestación\n\nold rules\n', 'registro', '1.0').status, 'legacy');
  assert.equal(parseBlock('<!-- orquestacion:bloque -->\nold\n<!-- /orquestacion:bloque -->', 'registro', '1.0').status, 'legacy');
});

test('parseBlock: the legacy form only applies to registro and never next to a versioned block', () => {
  assert.equal(parseBlock('## Orquestación\nold\n', 'ciclo', '1.0').status, 'missing');
  assert.equal(parseBlock(`## Orquestación: registro de trabajo\n${block('1.0')}`, 'ciclo', '1.0').status, 'missing');
});

test('parseBlock: no marker and no legacy heading is missing; another block name does not count', () => {
  assert.deepEqual(parseBlock('# A\nnothing\n', 'registro', '1.0'), { status: 'missing', version: null });
  assert.equal(parseBlock(block('1.0', 'ciclo'), 'registro', '1.0').status, 'missing');
  assert.equal(parseBlock(undefined, 'registro', '1.0').status, 'missing');
});

test('parseBlock: a UTF-8 BOM before the marker is ignored', () => {
  assert.equal(parseBlock(`\uFEFF${block('1.0')}`, 'registro', '1.0').status, 'ok');
});

test('headerCheck: three lines in order pass; a missing line or a wrong order fails', () => {
  assert.equal(headerCheck(`# T\n\n${HEAD}`).ok, true);
  assert.equal(headerCheck(`\uFEFF${HEAD.replace(/\n/g, '\r\n')}`).ok, true);
  const missing = headerCheck('**Dónde está:** a\n**Qué lo bloquea:** c\n');
  assert.equal(missing.ok, false);
  assert.deepEqual(missing.missing, ['Qué sigue']);
  const order = headerCheck('**Qué sigue:** b\n**Dónde está:** a\n**Qué lo bloquea:** c\n');
  assert.equal(order.ok, false);
  assert.deepEqual(order.missing, []);
});

const REG = {
  version: 1,
  blocks: { registro: '1.0', ciclo: '1.0' },
  requirements: [
    { id: 'base', title: 'Base', category: 'verificable', level: 'required', check: { type: 'base-branch' }, remedy: 'r1' },
    { id: 'agents', title: 'Agents', category: 'verificable', level: 'required', check: { type: 'file-exists', file: 'agents' }, remedy: 'r2' },
    { id: 'reg', title: 'Registro', category: 'verificable', level: 'required', check: { type: 'block', file: 'agents', name: 'registro' }, remedy: 'r3' },
    { id: 'head', title: 'Header', category: 'verificable', level: 'required', check: { type: 'roadmap-header', file: 'roadmap' }, remedy: 'r4' },
    { id: 'table', title: 'Table', category: 'verificable', level: 'required', check: { type: 'roadmap-table', file: 'roadmap' }, remedy: 'r5' },
    { id: 'cic', title: 'Ciclo', category: 'verificable', level: 'recommended', check: { type: 'block', file: 'agents', name: 'ciclo' }, remedy: 'r6' },
  ],
};
const file = (text) => ({ available: true, text, path: 'x' });
const GOOD = { base: { status: 'ok', name: 'main' }, files: { agents: file(block('1.0') + TAREAS + ENTREGA), roadmap: file(HEAD + TABLE), adoption: file(ADOPTION) } };
const by = (out, id) => out.results.find((r) => r.id === id);

test('evaluate: everything required passing makes it ready; a failing recommended one does not matter', () => {
  const out = evaluate(REG, GOOD);
  assert.equal(by(out, 'cic').status, 'fail');
  assert.deepEqual(out.summary, { required: { pass: 5, total: 5 }, recommended: { pass: 0, total: 1 }, ready: true });
  assert.deepEqual(Object.keys(by(out, 'reg')).sort(), ['category', 'detail', 'id', 'level', 'remedy', 'status', 'title']);
  assert.equal(by(out, 'reg').remedy, 'r3');
});

test('evaluate: one failing required requirement means not ready', () => {
  const out = evaluate(REG, { ...GOOD, files: { agents: file('# nothing\n'), roadmap: GOOD.files.roadmap } });
  assert.equal(by(out, 'reg').status, 'fail');
  assert.equal(out.summary.ready, false);
  assert.equal(out.summary.required.pass, 4);
});

test('evaluate: a different or legacy block version is outdated, not pass', () => {
  const old = evaluate(REG, { ...GOOD, files: { ...GOOD.files, agents: file(block('0.9')) } });
  assert.equal(by(old, 'reg').status, 'outdated');
  assert.equal(old.summary.ready, false);
  const legacy = evaluate(REG, { ...GOOD, files: { ...GOOD.files, agents: file('## Orquestación\nold\n') } });
  assert.equal(by(legacy, 'reg').status, 'outdated');
});

test('evaluate: roadmap table errors fail, header lines are checked', () => {
  const out = evaluate(REG, { ...GOOD, files: { ...GOOD.files, roadmap: file('# no table\n') } });
  assert.equal(by(out, 'table').status, 'fail');
  assert.equal(by(out, 'head').status, 'fail');
});

test('evaluate: without a usable base, dependent checks are unavailable with the reason, never fail', () => {
  for (const status of ['no-repo', 'no-base']) {
    const out = evaluate(REG, { base: { status }, files: {} });
    for (const id of ['agents', 'reg', 'head', 'table', 'cic']) {
      assert.equal(by(out, id).status, 'unavailable', `${status} ${id}`);
      assert.match(by(out, id).detail, new RegExp(status));
    }
    assert.equal(by(out, 'base').status, status === 'no-base' ? 'fail' : 'unavailable');
    assert.equal(out.summary.ready, false);
  }
});

test('evaluate: a missing file fails an exists check and leaves content checks unavailable', () => {
  const gone = { available: false, reason: 'missing', path: 'x' };
  const out = evaluate(REG, { ...GOOD, files: { agents: gone, roadmap: gone } });
  assert.equal(by(out, 'agents').status, 'fail');
  assert.equal(by(out, 'reg').status, 'unavailable');
  assert.equal(by(out, 'head').status, 'unavailable');
});

test('evaluate: parcial and criterio never pass and cannot make ready true', () => {
  for (const category of ['parcial', 'criterio']) {
    const reg = { ...REG, requirements: [{ id: 'm', title: 'M', category, level: 'required', check: { type: 'base-branch' }, remedy: 'r' }] };
    const out = evaluate(reg, GOOD);
    assert.notEqual(by(out, 'm').status, 'pass');
    assert.equal(out.summary.ready, false);
  }
});

test('evaluate: an unknown check type is unavailable; an empty registry is not ready', () => {
  const reg = { ...REG, requirements: [{ id: 'u', title: 'U', category: 'verificable', level: 'required', check: { type: 'nope' }, remedy: 'r' }] };
  const out = evaluate(reg, GOOD);
  assert.equal(by(out, 'u').status, 'unavailable');
  assert.equal(out.summary.ready, false);
  assert.equal(evaluate({ requirements: [] }, GOOD).summary.ready, false);
  assert.deepEqual(evaluate(null, GOOD).results, []);
});

// ---------- rooms: member-only requirements and the room's own requirements ----------
const REAL = require('../requirements.json');
const SALA_REGION = '<!-- SALA -->\nthe room line\n<!-- /SALA -->\n';
const ciclo = (inner) => `<!-- orquestacion:ciclo v1.0 -->\nrules\n${inner}<!-- /orquestacion:ciclo -->\n`;
const registro = block('1.0') + TAREAS + ENTREGA;
const memberFacts = (agents, room = { name: 'UPEN' }) => ({ ...GOOD, room, files: { ...GOOD.files, agents: file(agents) } });
const ids = (out) => out.results.map((r) => r.id);

test('onlyInRoom: a requirement marked for members is omitted outside a room and present inside one', () => {
  const outside = evaluate(REAL, memberFacts(registro + ciclo(SALA_REGION), null));
  assert.equal(ids(outside).includes('sala-region'), false);
  assert.equal(ids(evaluate(REAL, memberFacts(registro + ciclo(SALA_REGION)))).includes('sala-region'), true);
});

test('levelInRoom: ciclo-block is recommended outside a room and required for members only', () => {
  const agents = registro; // no ciclo block
  const outside = evaluate(REAL, memberFacts(agents, null));
  assert.equal(by(outside, 'ciclo-block').level, 'recommended');
  assert.equal(by(outside, 'ciclo-block').status, 'fail');
  assert.equal(outside.summary.ready, true);
  const member = evaluate(REAL, memberFacts(agents));
  assert.equal(by(member, 'ciclo-block').level, 'required');
  assert.equal(member.summary.ready, false);
  assert.equal(evaluate(REAL, memberFacts(registro + ciclo(SALA_REGION))).summary.ready, true);
});

test('sala-region: passes only when the ciclo block holds both SALA markers', () => {
  const status = (agents) => by(evaluate(REAL, memberFacts(agents)), 'sala-region').status;
  assert.equal(status(registro + ciclo(SALA_REGION)), 'pass');
  assert.equal(status(registro + ciclo('')), 'fail');
  assert.equal(status(registro + ciclo('<!-- SALA -->\nonly open\n')), 'fail');
  assert.equal(status(registro + ciclo('<!-- /SALA -->\n<!-- SALA -->\nswapped\n')), 'fail');
  assert.equal(status(`${registro}<!-- SALA -->\n<!-- /SALA -->\n`), 'fail'); // markers outside the ciclo block do not count
  assert.equal(status(registro), 'fail');
  const gone = evaluate(REAL, { ...memberFacts(''), files: { ...GOOD.files, agents: { available: false, reason: 'missing', path: 'AGENTS.md' } } });
  assert.equal(by(gone, 'sala-region').status, 'unavailable');
});

const ENLACES = '# Enlaces\n\n## 1. Proyectos\n- a\n## 2. Contratos\n## 3. Dependencias entre unidades\n## 4. Cola de órdenes\n## 5. Último barrido\n';
const roomFacts = (files) => ({ base: { status: 'ok', name: 'main' }, files: { agents: file('# Room\n'), ...files } });
const gone = { available: false, reason: 'missing', path: 'x' };
const roomOut = (facts) => evaluate(REAL, facts, 'roomRequirements');

test('room requirements: the registry lists the five checks, all required and verifiable', () => {
  assert.deepEqual(REAL.roomRequirements.map((r) => r.id), ['room-base-branch', 'room-agents-file', 'room-enlaces-file', 'room-enlaces-sections']);
  assert.ok(REAL.roomRequirements.every((r) => r.level === 'required' && r.category === 'verificable' && r.remedy));
});

test('room requirements: ENLACES.md is accepted at the root or under estrategia/, otherwise it fails', () => {
  const at = (files) => by(roomOut(roomFacts(files)), 'room-enlaces-file');
  assert.equal(at({ enlaces: file(ENLACES), enlacesAlt: gone }).status, 'pass');
  assert.equal(at({ enlaces: gone, enlacesAlt: file(ENLACES) }).status, 'pass');
  assert.equal(at({ enlaces: gone, enlacesAlt: gone }).status, 'fail');
  assert.equal(at({ enlaces: gone, enlacesAlt: { available: false, reason: 'error' } }).status, 'unavailable');
  assert.equal(by(roomOut(roomFacts({ enlaces: gone, enlacesAlt: gone })), 'room-agents-file').status, 'pass');
});

test('room requirements: the link map needs headings for projects, contracts, dependencies, queue and sweep', () => {
  const sections = (text) => by(roomOut(roomFacts({ enlaces: gone, enlacesAlt: file(text) })), 'room-enlaces-sections');
  assert.equal(sections(ENLACES).status, 'pass');
  assert.equal(sections(ENLACES.toUpperCase()).status, 'pass'); // case-insensitive
  const missing = sections('## Proyectos\n## Contratos\ntext about dependencias, cola and barrido but not as headings\n');
  assert.equal(missing.status, 'fail');
  assert.match(missing.detail, /missing: .*dependencies.*queue.*sweep/);
  assert.doesNotMatch(missing.detail, /projects|contracts/);
  const none = by(roomOut(roomFacts({ enlaces: gone, enlacesAlt: gone })), 'room-enlaces-sections');
  assert.equal(none.status, 'unavailable');
  assert.equal(roomOut(roomFacts({ enlaces: file(ENLACES), enlacesAlt: gone })).summary.ready, true);
  assert.equal(roomOut(roomFacts({ enlaces: gone, enlacesAlt: gone })).summary.ready, false);
});

test('room requirements: a room without a base branch is unavailable or failed, never ready', () => {
  const out = roomOut({ base: { status: 'no-base', name: 'main' }, files: {} });
  assert.equal(by(out, 'room-base-branch').status, 'fail');
  assert.equal(by(out, 'room-agents-file').status, 'unavailable');
  assert.equal(out.summary.ready, false);
});

// ---------- RP12a: namespaces, estado-block and panel-ignored ----------
const pblock = (v) => `# A\n<!-- panel:estado v${v} -->\nrules\n<!-- /panel:estado -->\n`;

test('parseBlock: the namespace defaults to orquestacion and a panel block is only seen with namespace panel', () => {
  assert.equal(parseBlock(pblock('1.0'), 'estado', '1.0').status, 'missing');
  assert.equal(parseBlock(block('1.0', 'estado'), 'estado', '1.0', 'orquestacion').status, 'ok');
  assert.deepEqual(parseBlock(pblock('1.0'), 'estado', '1.0', 'panel'), { status: 'ok', version: '1.0' });
  assert.equal(parseBlock(block('1.0', 'estado'), 'estado', '1.0', 'panel').status, 'missing');
});

test('parseBlock: a panel block can be outdated or unclosed, and never legacy', () => {
  assert.deepEqual(parseBlock(pblock('0.9'), 'estado', '1.0', 'panel'), { status: 'outdated', version: '0.9' });
  assert.equal(parseBlock('<!-- panel:estado v1.0 -->\nrules\n', 'estado', '1.0', 'panel').status, 'unclosed');
  assert.equal(parseBlock('## Orquestación\nold\n', 'estado', '1.0', 'panel').status, 'missing');
});

test('estado-block: the registry asks for a closed panel:estado block at version 1.0, recommended', () => {
  const req = REAL.requirements.find((r) => r.id === 'estado-block');
  assert.equal(REAL.blocks.estado, '1.0');
  assert.deepEqual([req.category, req.level], ['verificable', 'recommended']);
  const status = (agents) => by(evaluate(REAL, { ...GOOD, files: { ...GOOD.files, agents: file(agents) } }), 'estado-block').status;
  assert.equal(status(pblock('1.0')), 'pass');
  assert.equal(status(pblock('0.9')), 'outdated');
  assert.equal(status(block('1.0')), 'fail');
  assert.equal(status('<!-- panel:estado v1.0 -->\nrules\n'), 'fail');
  assert.match(by(evaluate(REAL, { ...GOOD, files: { ...GOOD.files, agents: file('<!-- panel:estado v1.0 -->\nx') } }), 'estado-block').detail, /closing marker/);
});

const ignored = (v) => ({ ...GOOD, local: { panelIgnored: v } });

test('panel-ignored: passes when ignored, fails when not, unavailable when git could not say', () => {
  const req = REAL.requirements.find((r) => r.id === 'panel-ignored');
  assert.deepEqual([req.category, req.level], ['verificable', 'recommended']);
  const res = (v) => by(evaluate(REAL, ignored(v)), 'panel-ignored');
  assert.equal(res({ available: true, ignored: true }).status, 'pass');
  assert.equal(res({ available: true, ignored: false }).status, 'fail');
  const gone = res({ available: false, reason: 'error' });
  assert.deepEqual([gone.status, gone.detail], ['unavailable', 'could not be read (error)']);
  assert.equal(by(evaluate(REAL, GOOD), 'panel-ignored').status, 'unavailable');
  assert.equal(by(evaluate(REAL, { base: { status: 'no-repo' }, files: {}, local: { panelIgnored: { available: true, ignored: true } } }), 'panel-ignored').status, 'pass');
});

test('the two panel requirements are recommended: failing them never makes a ready repo not ready', () => {
  const out = evaluate(REAL, { ...GOOD, files: { ...GOOD.files, agents: file(block('1.0') + TAREAS + ENTREGA) }, local: { panelIgnored: { available: true, ignored: false } } });
  assert.equal(by(out, 'estado-block').status, 'fail');
  assert.equal(by(out, 'panel-ignored').status, 'fail');
  assert.equal(out.summary.ready, true);
  assert.deepEqual(out.summary.recommended.total, REAL.requirements.filter((r) => r.level === 'recommended').length);
});

test('panel-ignored is not part of the room requirements; an unknown check type is still unavailable', () => {
  assert.equal(REAL.roomRequirements.some((r) => r.id === 'panel-ignored' || r.id === 'estado-block'), false);
  const reg = { ...REG, requirements: [{ id: 'u', title: 'U', category: 'verificable', level: 'required', check: { type: 'git-ignored-nope' }, remedy: 'r' }] };
  assert.equal(by(evaluate(reg, GOOD), 'u').detail, 'unknown check type');
});

test('requirements/blocks/estado.md is a closed panel:estado block at the registry version and names the file, the states and the closing line', () => {
  const text = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'requirements', 'blocks', 'estado.md'), 'utf8');
  assert.deepEqual(parseBlock(text, 'estado', REAL.blocks.estado, 'panel'), { status: 'ok', version: '1.0' });
  assert.ok(text.trimEnd().split('\n').length <= 25);
  for (const needle of ['.panel/state.json', '.git/info/exclude', 'Siguiente:', 'working', 'needs-input', 'ready-to-commit', 'ready-to-pr', 'blocked']) assert.ok(text.includes(needle), needle);
});
