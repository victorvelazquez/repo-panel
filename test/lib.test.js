'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const lib = require('../lib.js');

test('parseStatus reads branch, upstream, ahead/behind and files', () => {
  const out = [
    '# branch.oid abc', '# branch.head feat/x', '# branch.upstream origin/feat/x', '# branch.ab +2 -1',
    '1 .M N... 100644 100644 100644 a b src/a.js',
    '1 A. N... 000000 100644 100644 a b my file.txt',
    '2 R. N... 100644 100644 100644 a b R100 new.js\told.js',
    '? untracked.txt',
  ].join('\n');
  const s = lib.parseStatus(out);
  assert.equal(s.branch, 'feat/x');
  assert.equal(s.upstream, 'origin/feat/x');
  assert.deepEqual([s.ahead, s.behind, s.hasAb], [2, 1, true]);
  assert.deepEqual(s.files.map((f) => f.path), ['src/a.js', 'my file.txt', 'new.js', 'untracked.txt']);
});

test('parseStatus without upstream has no ahead/behind info', () => {
  const s = lib.parseStatus('# branch.oid abc\n# branch.head main\n');
  assert.equal(s.upstream, null);
  assert.equal(s.hasAb, false);
  assert.equal(s.files.length, 0);
});

test('parseNumstat handles text and binary files', () => {
  const m = lib.parseNumstat('3\t1\ta.js\n-\t-\timg.png\n');
  assert.deepEqual(m.get('a.js'), { added: 3, deleted: 1, binary: false });
  assert.deepEqual(m.get('img.png'), { added: 0, deleted: 0, binary: true });
});

test('parseGoneBranches only returns branches whose upstream is gone', () => {
  const out = 'main\t\nfeat-a\t[gone]\nfeat-b\t[ahead 1]\n';
  assert.deepEqual(lib.parseGoneBranches(out), ['feat-a']);
});

test('summarizeChecks: all green, pending, failed, none', () => {
  const ok = { __typename: 'CheckRun', name: 'ci', status: 'COMPLETED', conclusion: 'SUCCESS' };
  const skipped = { __typename: 'CheckRun', name: 's', status: 'COMPLETED', conclusion: 'SKIPPED' };
  const running = { __typename: 'CheckRun', name: 'r', status: 'IN_PROGRESS', conclusion: '' };
  const bad = { __typename: 'CheckRun', name: 'b', status: 'COMPLETED', conclusion: 'FAILURE', detailsUrl: 'https://github.com/o/r/actions/runs/123/job/9' };
  assert.equal(lib.summarizeChecks([ok, skipped]).state, 'success');
  assert.equal(lib.summarizeChecks([ok, running]).state, 'pending');
  const failed = lib.summarizeChecks([ok, running, bad]);
  assert.equal(failed.state, 'failed');
  assert.deepEqual(failed.failedRuns, ['123']);
  assert.equal(lib.summarizeChecks([]).state, 'none');
});

test('summarizeChecks understands legacy status contexts', () => {
  assert.equal(lib.summarizeChecks([{ __typename: 'StatusContext', context: 'x', state: 'SUCCESS' }]).state, 'success');
  assert.equal(lib.summarizeChecks([{ __typename: 'StatusContext', context: 'x', state: 'PENDING' }]).state, 'pending');
  assert.equal(lib.summarizeChecks([{ __typename: 'StatusContext', context: 'x', state: 'ERROR' }]).state, 'failed');
});

test('blockedReason: ready only when green, clean and not draft', () => {
  const green = { state: 'success' };
  const base = { isDraft: false, mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN' };
  assert.equal(lib.blockedReason(base, green), null);
  assert.equal(lib.blockedReason(base, { state: 'none' }), null);
  assert.ok(lib.blockedReason({ ...base, isDraft: true }, green));
  assert.ok(lib.blockedReason(base, { state: 'pending' }));
  assert.ok(lib.blockedReason(base, { state: 'failed' }));
  assert.ok(lib.blockedReason({ ...base, mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY' }, green));
  assert.ok(lib.blockedReason({ ...base, mergeStateStatus: 'BEHIND' }, green));
  assert.ok(lib.blockedReason({ ...base, mergeStateStatus: 'BLOCKED' }, green));
  assert.ok(lib.blockedReason({ ...base, mergeable: 'UNKNOWN', mergeStateStatus: 'UNKNOWN' }, green));
});

test('encodeRef keeps slashes and encodes the rest', () => {
  assert.equal(lib.encodeRef('feat/a b#1'), 'feat/a%20b%231');
});

test('repoId is stable and case-insensitive', () => {
  assert.equal(lib.repoId('C:\\Dev\\A'), lib.repoId('c:\\dev\\a'));
  assert.equal(lib.repoId('x').length, 10);
});

test('parseBaseBranch reads origin/HEAD and falls back to main', () => {
  assert.equal(lib.parseBaseBranch('refs/remotes/origin/develop\n'), 'develop');
  assert.equal(lib.parseBaseBranch('refs/remotes/origin/release/1.x\n'), 'release/1.x');
  assert.equal(lib.parseBaseBranch(''), 'main');
  assert.equal(lib.parseBaseBranch('garbage'), 'main');
});

test('staleBranch flags a working branch whose work was already merged', () => {
  const merged = { number: 12, url: 'u' };
  const gone = lib.staleBranch({ branch: 'docs/x', base: 'main', gone: true });
  assert.deepEqual(gone, { reason: 'Merged: run /flow-branch', via: 'gone', pr: null });
  const viaPr = lib.staleBranch({ branch: 'docs/x', base: 'main', mergedPr: merged });
  assert.deepEqual(viaPr, { reason: 'Merged: run /flow-branch', via: 'merged', pr: 12 });
});

test('staleBranch stays quiet when there is nothing to start over from', () => {
  const merged = { number: 12 };
  assert.equal(lib.staleBranch({ branch: 'main', base: 'main', gone: true, mergedPr: merged }), null);
  assert.equal(lib.staleBranch({ branch: null, base: 'main', gone: true }), null);
  assert.equal(lib.staleBranch({ branch: 'docs/x', base: 'main' }), null);
  // The branch name was reused for a new, still open PR.
  assert.equal(lib.staleBranch({ branch: 'docs/x', base: 'main', mergedPr: merged, openPrs: [{ head: 'docs/x' }] }), null);
  assert.notEqual(lib.staleBranch({ branch: 'docs/x', base: 'main', mergedPr: merged, openPrs: [{ head: 'other' }] }), null);
});

// ---- parseRoadmap ----
const fs = require('node:fs');
const path = require('node:path');
// A Windows checkout may rewrite fixtures to CRLF; tests start from LF and add CRLF themselves.
const fixture = (n) => fs.readFileSync(path.join(__dirname, 'fixtures', n), 'utf8').replace(/\r\n/g, '\n');
const HEAD = '| ID | Entrega | Depende de | Estado |\n| --- | --- | --- | --- |\n';
const codes = (r) => r.problems.map((p) => p.code);
const problem = (r, code) => r.problems.find((p) => p.code === code);

test('parseRoadmap sample A: next, progress, header and external dependency', () => {
  const r = lib.parseRoadmap(fixture('roadmap-a.md'));
  assert.deepEqual(r.header, { dondeEsta: 'esqueleto hecho.', queSigue: 'P2.', queLoBloquea: 'nada.' });
  assert.deepEqual(r.current, []);
  assert.equal(r.next.id, 'P2');
  assert.deepEqual(r.progress, {
    total: 5, completada: 2, pendiente: 2, enCurso: 0, bloqueada: 1, lista: 0, enRevision: 0, desconocido: 0,
  });
  const p4 = r.rows[4];
  assert.deepEqual([p4.id, p4.dependsOn, p4.externalDeps, p4.line], ['P4', ['P2'], ['X9'], 13]);
  assert.equal(r.rows[0].notas, 'PR 5');
  assert.equal(r.rows[0].resultadoVisible, 'Documentos');
  assert.deepEqual(r.problems, [
    { line: 13, severity: 'info', code: 'missing-dependency', message: r.problems[0].message },
  ]);
});

test('parseRoadmap sample B: state detail, external deps, null header', () => {
  const r = lib.parseRoadmap(fixture('roadmap-b.md'));
  assert.deepEqual(r.header, { dondeEsta: null, queSigue: null, queLoBloquea: null });
  assert.equal(r.next.id, 'T5');
  const [t4, t5, t6] = r.rows;
  assert.deepEqual(t4.externalDeps, ['T3']);
  assert.deepEqual([t5.estado, t5.estadoDetalle], ['Pendiente', 'siguiente']);
  assert.equal(problem(r, 'state-detail').line, 4);
  assert.equal(problem(r, 'state-detail').severity, 'warn');
  assert.deepEqual([t6.dependsOn, t6.externalDeps], [[], ['T2', 'Z0', 'Runtime 22']]);
  assert.equal(t5.ficha, '[C](x.md)');
});

test('parseRoadmap empty file reports no-table at line 1', () => {
  for (const input of ['', '\n\n']) {
    const r = lib.parseRoadmap(input);
    assert.deepEqual(r.rows, []);
    assert.deepEqual([problem(r, 'no-table').line, problem(r, 'no-table').severity], [1, 'error']);
    assert.equal(r.next, null);
  }
});

test('parseRoadmap file without table reports no-table', () => {
  const r = lib.parseRoadmap('# Title\n\nJust text | with a pipe\n');
  assert.deepEqual(codes(r), ['no-table']);
});

test('parseRoadmap table missing a required column reports missing-column', () => {
  const r = lib.parseRoadmap('intro\n| ID | Entrega | Depende de |\n| --- | --- | --- |\n| A | x | — |\n');
  assert.deepEqual(r.rows, []);
  assert.equal(r.problems.length, 1);
  const p = r.problems[0];
  assert.deepEqual([p.code, p.severity, p.line], ['missing-column', 'error', 2]);
  assert.match(p.message, /Estado/);
});

test('parseRoadmap finds columns by name in any order, with extra columns', () => {
  const r = lib.parseRoadmap(
    '| Estado | Extra | Notas | Depende de | Entrega | ID |\n| - | - | - | - | - | - |\n'
    + '| Completada | z | n1 | — | Uno | A |\n| Pendiente | z | n2 | A | Dos | B |\n');
  assert.deepEqual(r.rows.map((x) => [x.id, x.entrega, x.estado, x.notas, x.dependsOn]), [
    ['A', 'Uno', 'Completada', 'n1', []], ['B', 'Dos', 'Pendiente', 'n2', ['A']],
  ]);
  assert.equal(r.next.id, 'B');
  assert.deepEqual(r.problems, []);
});

test('parseRoadmap duplicate ID is reported and the first row wins for dependencies', () => {
  const r = lib.parseRoadmap(`${HEAD}| A | one | — | Completada |\n| A | two | — | Pendiente |\n| B | b | A | Pendiente |\n`);
  assert.equal(problem(r, 'duplicate-id').line, 4);
  assert.equal(problem(r, 'duplicate-id').severity, 'error');
  assert.equal(r.next.id, 'A');
  assert.equal(r.next.entrega, 'two');
  const r2 = lib.parseRoadmap(`${HEAD}| A | one | — | Completada |\n| A | two | — | Pendiente |\n| B | b | A | Pendiente |\n`
    .replace('| A | two | — | Pendiente |', '| A | two | — | Completada |'));
  assert.equal(r2.next.id, 'B');
});

test('parseRoadmap unknown state has estado null and is counted', () => {
  const r = lib.parseRoadmap(`${HEAD}| A | a | — | Hecho |\n`);
  assert.equal(r.rows[0].estado, null);
  assert.equal(problem(r, 'unknown-state').line, 3);
  assert.equal(r.progress.desconocido, 1);
  assert.equal(r.next, null);
});

test('parseRoadmap ignores emphasis and accents in labels, headers and states', () => {
  const r = lib.parseRoadmap(
    '**DÓNDE ESTÁ:** `algo`\n**Qué sigue:** B\n\n'
    + '| id | ENTREGA | depende DE | Estado |\n|---|---|---|---|\n'
    + '| A | a | — | COMPLETADA |\n| B | b | A | en curso |\n| C | c | B | Pendiente |\n');
  assert.deepEqual(r.header, { dondeEsta: 'algo', queSigue: 'B', queLoBloquea: null });
  assert.deepEqual(r.rows.map((x) => x.estado), ['Completada', 'En curso', 'Pendiente']);
  assert.deepEqual(r.current.map((x) => x.id), ['B']);
  assert.equal(r.progress.enCurso, 1);
  assert.deepEqual(r.problems, []);
});

test('parseRoadmap takes the first recognized state word and keeps the rest as detail', () => {
  const r = lib.parseRoadmap(
    `${HEAD}| A | a | — | Completada (PR 44) |\n| B | b | — | **Pendiente**, adelantada |\n| C | c | — | en curso (hoy) |\n`);
  assert.deepEqual(r.rows.map((x) => [x.estado, x.estadoDetalle]), [
    ['Completada', 'PR 44'], ['Pendiente', 'adelantada'], ['En curso', 'hoy'],
  ]);
  assert.deepEqual(codes(r), ['state-detail', 'state-detail', 'state-detail']);
});

test('parseRoadmap CRLF input gives the same result as LF', () => {
  const lf = fixture('roadmap-a.md');
  assert.deepEqual(lib.parseRoadmap(lf.replace(/\n/g, '\r\n')), lib.parseRoadmap(lf));
});

test('parseRoadmap strips a leading BOM', () => {
  const r = lib.parseRoadmap(`\uFEFF${HEAD}| A | a | — | Pendiente |\n`);
  assert.equal(r.rows[0].id, 'A');
  assert.equal(r.rows[0].line, 3);
  assert.deepEqual(r.problems, []);
});

test('parseRoadmap empty and dash dependencies mean no dependency', () => {
  const r = lib.parseRoadmap(`${HEAD}| A | a | — | Pendiente |\n| B | b |  | Pendiente |\n| C | c | - | Pendiente |\n| D | d | A; B | Pendiente |\n`);
  assert.deepEqual(r.rows.map((x) => [x.dependsOn, x.externalDeps]), [[[], []], [[], []], [[], []], [['A', 'B'], []]]);
  assert.deepEqual(r.problems, []);
});

test('parseRoadmap circular dependencies are reported once and skipped by next', () => {
  const r = lib.parseRoadmap(`${HEAD}| A | a | B | Pendiente |\n| B | b | A | Pendiente |\n| C | c | C | Pendiente |\n| D | d | — | Pendiente |\n`);
  const cycles = r.problems.filter((p) => p.code === 'circular-dependency');
  assert.equal(cycles.length, 2);
  assert.match(cycles[0].message, /A/);
  assert.match(cycles[0].message, /B/);
  assert.equal(cycles[0].line, 3);
  assert.match(cycles[1].message, /C/);
  assert.equal(cycles[1].line, 5);
  assert.equal(r.next.id, 'D');
});

test('parseRoadmap next skips a row that sits in a cycle even if its dependency is done', () => {
  const r = lib.parseRoadmap(`${HEAD}| A | a | B | Completada |\n| B | b | A | Pendiente |\n`);
  assert.equal(codes(r).includes('circular-dependency'), true);
  assert.equal(r.next, null);
});

test('parseRoadmap next skips Bloqueada and rows with unfinished dependencies', () => {
  const r = lib.parseRoadmap(`${HEAD}| A | a | — | Bloqueada |\n| B | b | A | Pendiente |\n| C | c | — | Pendiente |\n`);
  assert.equal(r.next.id, 'C');
});

test('parseRoadmap skips rows whose cells are all empty', () => {
  const r = lib.parseRoadmap(`${HEAD}| A | a | — | Pendiente |\n| | | | |\n|  |  |  |  |\n| B | b | A | Pendiente |\n`);
  assert.deepEqual(r.rows.map((x) => [x.id, x.line]), [['A', 3], ['B', 6]]);
  assert.deepEqual(r.problems, []);
});

test('parseRoadmap accepts tables without final pipe or final newline', () => {
  const r = lib.parseRoadmap('ID | Entrega | Depende de | Estado'.replace(/^/, '| ')
    + '\n| --- | --- | --- | ---\n| A | a | — | Pendiente\n| B | b | A | Completada');
  assert.deepEqual(r.rows.map((x) => [x.id, x.estado, x.dependsOn]), [['A', 'Pendiente', []], ['B', 'Completada', ['A']]]);
  assert.deepEqual(r.problems, []);
});

test('parseRoadmap uses the first table with the required columns', () => {
  const r = lib.parseRoadmap(`| Foo | Bar |\n| --- | --- |\n| 1 | 2 |\n\ntext\n\n${HEAD}| A | a | — | Pendiente |\n\n${HEAD}| Z | z | — | Pendiente |\n`);
  assert.deepEqual(r.rows.map((x) => x.id), ['A']);
  assert.equal(r.rows[0].line, 9);
  assert.deepEqual(r.problems, []);
});

test('parseRoadmap comments count as blank lines and keep line numbers', () => {
  const r = lib.parseRoadmap(`<!-- a\n b\n c -->\n${HEAD}| A | a | — | Pendiente |\n<!-- x -->\n| B | b | — | Pendiente |\n`);
  assert.equal(r.rows[0].line, 6);
  assert.deepEqual(r.rows.map((x) => x.id), ['A']);
  assert.deepEqual(r.problems.map((p) => [p.code, p.line]), [['row-after-blank', 8]]);
});

test('parseRoadmap hand-written Lista and En revisión are accepted and flagged', () => {
  const r = lib.parseRoadmap(`${HEAD}| A | a | — | Lista |\n| B | b | — | En revisión |\n| C | c | — | Pendiente |\n`);
  assert.deepEqual(r.rows.map((x) => [x.estado, x.declaredByHand]), [['Lista', true], ['En revisión', true], ['Pendiente', false]]);
  assert.deepEqual(r.problems.map((p) => [p.code, p.line, p.severity]), [['hand-state', 3, 'warn'], ['hand-state', 4, 'warn']]);
  assert.deepEqual([r.progress.lista, r.progress.enRevision], [1, 1]);
  assert.equal(r.next.id, 'C');
});

test('parseRoadmap unescaped pipe in a cell is reported, escaped pipe is literal', () => {
  const bad = lib.parseRoadmap(`${HEAD}| A | a | b | — | Pendiente |\n`);
  assert.equal(problem(bad, 'pipe-in-cell').line, 3);
  assert.equal(bad.rows[0].entrega, 'a');
  assert.equal(bad.rows[0].estado, null);
  const ok = lib.parseRoadmap(`${HEAD}| A | a \\| b | — | Pendiente |\n`);
  assert.equal(ok.rows[0].entrega, 'a | b');
  assert.deepEqual(ok.problems, []);
});

test('parseRoadmap fewer cells than columns are padded with empty strings', () => {
  const r = lib.parseRoadmap(`${HEAD}| A | a |\n`);
  assert.deepEqual([r.rows[0].dependsOn, r.rows[0].estado], [[], null]);
  assert.deepEqual(codes(r), ['unknown-state']);
});

test('parseRoadmap row after a blank line is reported and ignored', () => {
  const r = lib.parseRoadmap(`${HEAD}| A | a | — | Pendiente |\n\n| B | b | — | Pendiente |\n`);
  assert.deepEqual(r.rows.map((x) => x.id), ['A']);
  assert.deepEqual(r.problems.map((p) => [p.code, p.line]), [['row-after-blank', 5]]);
});

test('parseRoadmap malformed IDs are reported', () => {
  const r = lib.parseRoadmap(`${HEAD}| 1x | a | — | Pendiente |\n| a b | b | — | Pendiente |\n| ok.1_a-b | c | — | Pendiente |\n`);
  assert.deepEqual(r.problems.map((p) => [p.code, p.line, p.severity]), [['bad-id', 3, 'error'], ['bad-id', 4, 'error']]);
  assert.equal(r.rows.length, 3);
});

test('parseRoadmap never throws on non-string input', () => {
  for (const input of [undefined, null, 42, {}, []]) {
    const r = lib.parseRoadmap(input);
    assert.deepEqual(codes(r), ['no-table']);
    assert.deepEqual(r.rows, []);
  }
});

