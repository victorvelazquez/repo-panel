'use strict';
// RP267: a lone carriage return inside a row is cell text, not a line break, so the table is read whole; a table cut
// by a line that is not a row is reported instead of silently dropping the rows after it.
const test = require('node:test');
const assert = require('node:assert/strict');
const lib = require('../lib.js');

const HEAD = '| ID | Entrega | Depende de | Estado | Notas |\n| --- | --- | --- | --- | --- |\n';
const ROWS = [
  '| A | a | — | Completada | uno |',
  '| B | b | A | Pendiente | antes\rdespués |',
  '| C | c | — | Pendiente | tres |',
];
const shape = (r) => ({
  rows: r.rows.map((x) => [x.id, x.estado, x.notas, x.line]),
  next: r.next && r.next.id,
  problems: r.problems.map((p) => [p.code, p.line, p.severity]),
});

test('a lone CR inside a row is cell text and every row is read', () => {
  const r = lib.parseRoadmap(`${HEAD}${ROWS.join('\n')}\n`);
  assert.deepEqual(r.rows.map((x) => x.id), ['A', 'B', 'C']);
  assert.equal(r.next.id, 'B');
  assert.match(r.rows[1].notas, /^antes\s+después$/);
  assert.equal(r.rows[2].line, 5);
  assert.deepEqual(r.problems, []);
});

test('CRLF line endings still parse exactly like LF', () => {
  const lf = lib.parseRoadmap(`${HEAD}${ROWS.join('\n')}\n`);
  const crlf = lib.parseRoadmap(`${HEAD}${ROWS.join('\n')}\n`.replace(/\n/g, '\r\n'));
  assert.deepEqual(shape(crlf), shape(lf));
});

test('a table cut by a line that is not a row is reported with the ignored rows', () => {
  const md = `${HEAD}| A | a | — | Completada | uno |\n| B | b | A | Pendiente | antes\ndespués |\n| C | c | — | Pendiente | tres |\n| D | d | — | Pendiente | cuatro |\n`;
  const r = lib.parseRoadmap(md);
  assert.deepEqual(r.rows.map((x) => x.id), ['A', 'B']);
  const cut = r.problems.filter((p) => p.code === 'table-cut');
  assert.deepEqual(cut.map((p) => [p.line, p.severity]), [[5, 'error']]);
  assert.match(cut[0].message, /not a row/);
  assert.match(cut[0].message, /\b2 rows after it are ignored/);
});
