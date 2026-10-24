'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseBlock, headerCheck, evaluate } = require('../checks.js');

const HEAD = '**Dónde está:** a\n**Qué sigue:** b\n**Qué lo bloquea:** c\n';
const TABLE = '| ID | Entrega | Resultado visible | Depende de | Estado | Notas | Ficha |\n| --- | --- | --- | --- | --- | --- | --- |\n| A1 | e | r | — | Pendiente | | — |\n';
const block = (v, name = 'registro') => `# R\n<!-- orquestacion:${name} v${v} -->\nrules\n<!-- /orquestacion:${name} -->\n`;

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
const GOOD = { base: { status: 'ok', name: 'main' }, files: { agents: file(block('1.0')), roadmap: file(HEAD + TABLE) } };
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
