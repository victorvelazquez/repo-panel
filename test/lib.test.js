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


// ---- roadmapSummary ----
test('roadmapSummary sample A: next unit, progress, problems and header', () => {
  const s = lib.roadmapSummary({ available: true, ...lib.parseRoadmap(fixture('roadmap-a.md')) });
  assert.equal(s.kind, 'next');
  assert.equal(s.id, 'P2');
  assert.equal(s.entrega, 'Cabecera');
  assert.deepEqual(s.waiting, []);
  assert.deepEqual([s.done, s.total, s.pct], [2, 5, 40]);
  assert.deepEqual(s.problems, { total: 1, error: 0, warn: 0, info: 1 });
  assert.deepEqual(s.header, { dondeEsta: 'esqueleto hecho.', queSigue: 'P2.', queLoBloquea: 'nada.' });
});

test('roadmapSummary prefers the unit in progress and lists its external dependencies', () => {
  const s = lib.roadmapSummary(lib.parseRoadmap(`${HEAD}| T1 | one | — | Completada |\n| T6 | six | X9, Y1 | En curso |\n| T7 | seven | T1 | Pendiente |\n`));
  assert.equal(s.kind, 'current');
  assert.equal(s.id, 'T6');
  assert.equal(s.entrega, 'six');
  assert.deepEqual(s.waiting, ['X9', 'Y1']);
});

test('roadmapSummary kind is none without current or next; empty table gives pct 0', () => {
  const done = lib.roadmapSummary(lib.parseRoadmap(`${HEAD}| A | a | — | Completada |\n`));
  assert.deepEqual([done.kind, done.id, done.entrega, done.pct], ['none', null, null, 100]);
  const empty = lib.roadmapSummary(lib.parseRoadmap(`${HEAD}`));
  assert.deepEqual([empty.kind, empty.total, empty.pct], ['none', 0, 0]);
});

test('roadmapSummary counts problems by severity and ignores unavailable payloads', () => {
  const s = lib.roadmapSummary(lib.parseRoadmap(`${HEAD}| A | a | — | Hecho |\n| B | b | Q | Lista |\n`));
  assert.deepEqual(s.problems, { total: 3, error: 1, warn: 1, info: 1 });
  assert.equal(lib.roadmapSummary({ available: false, reason: 'missing' }), null);
  assert.equal(lib.roadmapSummary(null), null);
  assert.equal(lib.roadmapSummary(undefined), null);
});

// ---- matchesUnitId ----
test('matchesUnitId matches the ID as a complete token, case-insensitive', () => {
  const yes = [['p2', 'p2-cabecera'], ['p2', 'feat/p2_x'], ['p2', 'P2: cabecera'], ['p2', 'docs/p2'], ['P2', 'feat/p2-x'],
    ['a-1', 'feat/a-1-x'], ['p2.1', 'feat/p2.1-x'], ['p2', 'p2'], ['p2', 'fix p2.'], ['rp3b', 'rp3b-x']];
  for (const [id, text] of yes) assert.equal(lib.matchesUnitId(text, id), true, `${id} in ${text}`);
  const no = [['p2', 'p20-x'], ['p2', 'xp2'], ['rp3', 'rp3b-x'], ['rp3b', 'rp3-x'], ['p2', 'p2.1-x'], ['p2', 'p3-x'], ['a.b', 'axb']];
  for (const [id, text] of no) assert.equal(lib.matchesUnitId(text, id), false, `${id} in ${text}`);
});

test('matchesUnitId finds a later occurrence and treats empty or regex-like input safely', () => {
  assert.equal(lib.matchesUnitId('xp2 p2', 'p2'), true);
  assert.equal(lib.matchesUnitId('', 'p2'), false);
  assert.equal(lib.matchesUnitId('p2', ''), false);
  assert.equal(lib.matchesUnitId(undefined, 'p2'), false);
  assert.equal(lib.matchesUnitId('anything', '.*'), false);
});

// ---- deriveUnitStates / nextUnit ----
const FACTS = { current: null, dirty: false, aheadCurrent: 0, branches: [], localBranches: [], prs: [] };
const rowsOf = (...pairs) => lib.parseRoadmap(`${HEAD}${pairs.map(([id, st, dep = '—']) => `| ${id} | e-${id} | ${dep} | ${st} |`).join('\n')}\n`).rows;
const derive = (rows, facts) => lib.deriveUnitStates(rows, { ...FACTS, ...facts });

test('deriveUnitStates: an open PR by title or by head branch means En revisión', () => {
  const rows = rowsOf(['P2', 'Pendiente'], ['P3', 'Pendiente']);
  const d = derive(rows, { prs: [{ number: 7, title: 'P2: header', head: 'x' }, { number: 8, title: 'other', head: 'feat/p3-y' }] });
  assert.deepEqual(d, { P2: { state: 'En revisión', via: 'pr', pr: 7 }, P3: { state: 'En revisión', via: 'pr', pr: 8 } });
});

test('deriveUnitStates: current branch with changes or commits is Lista; clean and not ahead is En curso', () => {
  const rows = rowsOf(['P2', 'Pendiente']);
  const cur = { current: 'feat/p2-x', localBranches: ['main', 'feat/p2-x'] };
  assert.deepEqual(derive(rows, { ...cur, dirty: true }), { P2: { state: 'Lista', via: 'branch', branch: 'feat/p2-x' } });
  assert.deepEqual(derive(rows, { ...cur, aheadCurrent: 2 }), { P2: { state: 'Lista', via: 'branch', branch: 'feat/p2-x' } });
  assert.deepEqual(derive(rows, cur), { P2: { state: 'En curso', via: 'branch', branch: 'feat/p2-x' } });
});

test('deriveUnitStates: another branch ahead of the base is Lista; a branch alone is En curso', () => {
  const rows = rowsOf(['P2', 'Pendiente'], ['P3', 'Pendiente']);
  const d = derive(rows, { current: 'main', dirty: true, branches: ['feat/p2-x'], localBranches: ['main', 'feat/p2-x', 'feat/p3-y'] });
  assert.deepEqual(d, {
    P2: { state: 'Lista', via: 'branch', branch: 'feat/p2-x' },
    P3: { state: 'En curso', via: 'branch', branch: 'feat/p3-y' },
  });
});

test('deriveUnitStates: precedence, untouched states, token matching and duplicate IDs', () => {
  const rows = rowsOf(['P2', 'Pendiente'], ['P3', 'Completada'], ['P4', 'Bloqueada'], ['RP3', 'Pendiente'], ['RP3b', 'En curso']);
  const d = derive(rows, {
    current: 'feat/p2-x', dirty: true, localBranches: ['feat/p2-x', 'feat/p3-x', 'feat/p4-x', 'feat/rp3b-x'],
    prs: [{ number: 1, title: 'P2 done', head: 'feat/p2-x' }, { number: 2, title: 'P3', head: 'feat/p3-x' }],
  });
  assert.deepEqual(d, { P2: { state: 'En revisión', via: 'pr', pr: 1 } });
  const d2 = derive(rows, { localBranches: ['feat/rp3b-x'], branches: ['feat/rp3b-x'] });
  assert.deepEqual(d2, { RP3b: { state: 'Lista', via: 'branch', branch: 'feat/rp3b-x' } });
  const dup = derive(rowsOf(['P2', 'Pendiente'], ['P2', 'Pendiente']), { prs: [{ number: 4, title: 'P2', head: 'h' }] });
  assert.deepEqual(Object.keys(dup), ['P2']);
});

test('deriveUnitStates: an En curso row stays En curso when only a branch exists', () => {
  assert.deepEqual(derive(rowsOf(['P2', 'En curso']), { localBranches: ['feat/p2-x'] }), {});
});

test('nextUnit equals parseRoadmap next without derived and skips derived units', () => {
  for (const f of ['roadmap-a.md', 'roadmap-b.md']) {
    const r = lib.parseRoadmap(fixture(f));
    assert.equal(lib.nextUnit(r.rows, {}), r.next, f);
  }
  const rows = rowsOf(['A', 'Completada'], ['B', 'Pendiente', 'A'], ['C', 'Pendiente', 'A']);
  assert.equal(lib.nextUnit(rows, {}).id, 'B');
  assert.equal(lib.nextUnit(rows, { B: { state: 'Lista' } }).id, 'C');
  assert.equal(lib.nextUnit(rows, { B: { state: 'Lista' }, C: { state: 'En curso' } }), null);
  const cyc = rowsOf(['A', 'Pendiente', 'B'], ['B', 'Completada', 'A']);
  assert.equal(lib.nextUnit(cyc, {}), null);
});

test('roadmapSummary: kinds review, ready, current, next and none with pr and extra', () => {
  const rp = lib.parseRoadmap(`${HEAD}| A | a | — | Completada |\n| B | b | A | Pendiente |\n| C | c | A | Pendiente |\n| D | d | A | En curso |\n| E | e | A | Pendiente |\n`);
  const sum = (derived) => lib.roadmapSummary({ available: true, ...rp, derived });
  const review = sum({ C: { state: 'En revisión', via: 'pr', pr: 9 }, B: { state: 'Lista', via: 'branch', branch: 'b' } });
  assert.deepEqual([review.kind, review.state, review.id, review.pr, review.extra], ['review', 'En revisión', 'C', 9, 2]);
  const ready = sum({ B: { state: 'Lista', via: 'branch', branch: 'b' } });
  assert.deepEqual([ready.kind, ready.state, ready.id, ready.pr, ready.extra], ['ready', 'Lista', 'B', null, 1]);
  const current = sum({});
  assert.deepEqual([current.kind, current.state, current.id, current.pr, current.extra], ['current', 'En curso', 'D', null, 0]);
  const nxt = lib.roadmapSummary(lib.parseRoadmap(`${HEAD}| A | a | — | Completada |\n| B | b | A | Pendiente |\n`));
  assert.deepEqual([nxt.kind, nxt.state, nxt.id, nxt.pr, nxt.extra], ['next', null, 'B', null, 0]);
  const none = lib.roadmapSummary({ available: true, ...lib.parseRoadmap(`${HEAD}| A | a | — | Pendiente |\n`), derived: { A: { state: 'En revisión', pr: 1 } } });
  assert.equal(none.kind, 'review');
  const idle = lib.roadmapSummary(lib.parseRoadmap(`${HEAD}| A | a | — | Completada |\n`));
  assert.deepEqual([idle.kind, idle.state, idle.pr, idle.extra], ['none', null, null, 0]);
});

// ---------- workQueue ----------
const repo = (name, extra = {}) => ({ id: `id-${name}`, name, ready: [], stale: false, dirty: false, unpushed: false, hasPrs: false, next: null, ...extra });
const NEXT = { id: 'RP9', entrega: 'Next thing' };
const kinds = (q) => q.map((a) => `${a.name}:${a.kind}`);

test('workQueue orders by kind: merge, branch, deliver, start, then board order', () => {
  const q = lib.workQueue([
    repo('a', { next: NEXT }),
    repo('b', { dirty: true }),
    repo('c', { stale: true }),
    repo('d', { ready: [{ number: 4, title: 'T' }], hasPrs: true }),
    repo('e', { unpushed: true }),
  ]);
  assert.deepEqual(kinds(q), ['d:merge', 'c:branch', 'b:deliver', 'e:deliver', 'a:start']);
});

test('workQueue builds each action from the right facts', () => {
  const q = lib.workQueue([
    repo('m', { ready: [{ number: 7, title: 'Fix it' }], hasPrs: true }),
    repo('s', { stale: true }),
    repo('d', { dirty: true }),
    repo('n', { next: NEXT }),
  ]);
  assert.deepEqual(q, [
    { repoId: 'id-m', name: 'm', kind: 'merge', pr: 7, title: 'Fix it' },
    { repoId: 'id-s', name: 's', kind: 'branch' },
    { repoId: 'id-d', name: 'd', kind: 'deliver' },
    { repoId: 'id-n', name: 'n', kind: 'start', unit: { id: 'RP9', entrega: 'Next thing' } },
  ]);
});

test('workQueue starts a unit only for a clean repo without PRs', () => {
  const q = lib.workQueue([
    repo('stale', { stale: true, next: NEXT }),
    repo('dirty', { dirty: true, next: NEXT }),
    repo('ahead', { unpushed: true, next: NEXT }),
    repo('prs', { hasPrs: true, next: NEXT }),
    repo('clean', { next: NEXT }),
    repo('nothing'),
  ]);
  assert.deepEqual(kinds(q), ['stale:branch', 'dirty:deliver', 'ahead:deliver', 'clean:start']);
});

test('workQueue gives one repo several actions, merges first', () => {
  const q = lib.workQueue([repo('a', { dirty: true, stale: true, ready: [{ number: 2, title: 'x' }, { number: 1, title: 'y' }] })]);
  assert.deepEqual(q.map((a) => [a.kind, a.pr]), [['merge', 2], ['merge', 1], ['branch', undefined], ['deliver', undefined]]);
});

test('workQueue puts priority repos first, case-insensitively, ignoring unknown names and duplicates', () => {
  const items = [repo('a', { ready: [{ number: 1, title: 'x' }] }), repo('B', { dirty: true }), repo('c', { stale: true, dirty: true })];
  assert.deepEqual(kinds(lib.workQueue(items, ['b', 'ghost', 'B', ' C '])), ['B:deliver', 'c:branch', 'c:deliver', 'a:merge']);
  assert.deepEqual(kinds(lib.workQueue(items, ['c'])), ['c:branch', 'c:deliver', 'a:merge', 'B:deliver']);
});

test('workQueue ignores a priority that is not a list of strings', () => {
  const items = [repo('a', { dirty: true }), repo('b', { stale: true })];
  const auto = kinds(lib.workQueue(items));
  for (const bad of [undefined, null, 'a', { 0: 'a' }, 5]) assert.deepEqual(kinds(lib.workQueue(items, bad)), auto);
  assert.deepEqual(kinds(lib.workQueue(items, [3, null, 'a'])), ['a:deliver', 'b:branch']);
});

test('workQueue is stable for equal rank', () => {
  const q = lib.workQueue(['z', 'y', 'x'].map((n) => repo(n, { dirty: true })));
  assert.deepEqual(kinds(q), ['z:deliver', 'y:deliver', 'x:deliver']);
});

test('workQueue survives empty and malformed input', () => {
  for (const bad of [undefined, null, 'x', 3, {}]) assert.deepEqual(lib.workQueue(bad), []);
  assert.deepEqual(lib.workQueue([]), []);
  const q = lib.workQueue([null, 5, 'x', { name: 1, dirty: true }, repo('ok', { dirty: true, ready: [null, { number: 'x' }, 'y'], next: { entrega: 'no id' } })]);
  assert.deepEqual(kinds(q), ['ok:deliver']);
});

// ---------- conformityReport ----------
const CH = '| ID | Entrega | Resultado visible | Depende de | Estado | Notas | Ficha |\n|---|---|---|---|---|---|---|\n';
const rm = (rows) => ({ available: true, ...lib.parseRoadmap(CH + rows) });
const GOOD = rm('| A | a | r | — | Pendiente | | — |\n');
const ent = (name, roadmap) => ({ id: `id-${name}`, name, roadmap });

test('conformityReport counts conforming repos and lists none', () => {
  assert.deepEqual(lib.conformityReport([ent('a', GOOD), ent('b', GOOD)]), { ok: 2, items: [] });
});

test('conformityReport maps unavailable roadmaps to a status', () => {
  const r = lib.conformityReport([
    ent('a', { available: false, reason: 'missing' }),
    ent('b', { available: false, reason: 'no-base' }),
    ent('c', { available: false, reason: 'no-repo' }),
    ent('d', { available: false, reason: 'weird' }),
    ent('e', { available: false }),
  ]);
  assert.equal(r.ok, 0);
  assert.deepEqual(r.items.map((i) => [i.name, i.status, i.id, i.problems]),
    [['a', 'missing', 'id-a', []], ['b', 'no-base', 'id-b', []], ['c', 'no-repo', 'id-c', []], ['d', 'unavailable', 'id-d', []], ['e', 'unavailable', 'id-e', []]]);
});

test('conformityReport skips repos whose roadmap has not loaded or is malformed', () => {
  const r = lib.conformityReport([ent('a', null), ent('b', undefined), ent('c', 'x'), ent('d', {}), ent('f', GOOD)]);
  assert.deepEqual(r, { ok: 1, items: [] });
});

test('conformityReport lists only error and warn problems, sorted by line', () => {
  const bad = rm('| A | a | r | — | Pendiente | | — |\n| A | dup | r | X-1 | Pendiente (hoy) | | — |\n| B | b | r | — | Raro | | — |\n');
  const r = lib.conformityReport([ent('a', bad)]);
  assert.equal(r.ok, 0);
  assert.equal(r.items[0].status, 'problems');
  const p = r.items[0].problems;
  assert.ok(p.length >= 3);
  assert.ok(p.every((x) => x.severity === 'error' || x.severity === 'warn'));
  assert.ok(!p.some((x) => x.code === 'missing-dependency'));
  assert.deepEqual(p.map((x) => x.line), [...p.map((x) => x.line)].sort((a, b) => a - b));
  assert.deepEqual(Object.keys(p[0]).sort(), ['code', 'line', 'message', 'severity']);
  assert.ok(p.some((x) => x.code === 'duplicate-id' && x.line === 4));
});

test('conformityReport reports a missing column as a problem', () => {
  const r = lib.conformityReport([ent('a', { available: true, ...lib.parseRoadmap('| ID | Entrega |\n|---|---|\n| A | a |\n') })]);
  assert.equal(r.items[0].status, 'problems');
  assert.equal(r.items[0].problems[0].code, 'missing-column');
});

test('conformityReport counts info-only problems as conforming', () => {
  const info = rm('| A | a | r | OTHER-1 | Pendiente | | — |\n');
  assert.ok(info.problems.length > 0 && info.problems.every((p) => p.severity === 'info'));
  assert.deepEqual(lib.conformityReport([ent('a', info)]), { ok: 1, items: [] });
});

test('conformityReport keeps input order across repos', () => {
  const bad = rm('| A | a | r | — | Raro | | — |\n');
  const r = lib.conformityReport([ent('z', bad), ent('y', GOOD), ent('x', { available: false, reason: 'missing' }), ent('w', bad)]);
  assert.equal(r.ok, 1);
  assert.deepEqual(r.items.map((i) => i.name), ['z', 'x', 'w']);
});

test('conformityReport is defensive about its input', () => {
  assert.deepEqual(lib.conformityReport(null), { ok: 0, items: [] });
  assert.deepEqual(lib.conformityReport('x'), { ok: 0, items: [] });
  assert.deepEqual(lib.conformityReport([null, 5, 'a', { roadmap: GOOD }, { id: 'i', name: 3, roadmap: GOOD }]), { ok: 0, items: [] });
});

const IDLE = 'earlier output\n▎ ✿ waiting for input\n▎   type, or / for commands\n▎\n5h 78% ↻12:40';
const term = (o = {}) => ({ handle: 'h1', title: 'π - repo', worktreePath: 'C:/dev/repo', connected: true, writable: true, orphaned: false, ...o });

test('normPath ignores separator style, trailing slash and case', () => {
  assert.equal(lib.normPath('C:\\Dev\\Repo\\'), 'c:/dev/repo');
  assert.equal(lib.normPath('C:/dev/repo'), 'c:/dev/repo');
});

test('terminalsOfWorktree keeps the live, writable terminals of exactly that worktree, whatever their title', () => {
  const list = [
    term(), term({ handle: 'h2', worktreePath: 'C:\\DEV\\repo\\' }), term({ handle: 'other', worktreePath: 'C:/dev/repo2' }),
    term({ handle: 'plain', title: 'Terminal 1' }), term({ handle: 'untitled', title: undefined }), term({ handle: 'dead', connected: false }),
    term({ handle: 'ro', writable: false }), term({ handle: 'orphan', orphaned: true }), null, { title: 'π' },
  ];
  assert.deepEqual(lib.terminalsOfWorktree(list, 'c:\\dev\\repo').map((t) => t.handle), ['h1', 'h2', 'plain', 'untitled']);
  assert.deepEqual(lib.terminalsOfWorktree('x', 'C:/dev/repo'), []);
  assert.equal(lib.piTerminalsFor, undefined);
});

const BUSY = '$ sleep 20 (timeout 30s)\nElapsed 7.2s\n▎ ❁ working…\n▎   type, or / for commands\n▎\nfooter';

test('piScreenState reads a Gentle Shell pi screen: idle, busy with either glyph, or typed', () => {
  assert.equal(lib.piScreenState(IDLE), 'idle');
  assert.equal(lib.piScreenState(BUSY), 'busy');
  assert.equal(lib.piScreenState(BUSY.replace('❁', '✿')), 'busy');
  assert.equal(lib.piScreenState(IDLE.replace('✿', '★')), 'idle');
  assert.equal(lib.piScreenState(IDLE.replace('type, or / for commands', 'half a sentence')), 'typed');
  assert.equal(lib.piScreenState('▎ ✿ waiting for input\n'), 'typed');
});

test('piScreenState is null for anything that is not a pi screen', () => {
  assert.equal(lib.piScreenState('PS C:\\Users\\victor> git status\nnothing to commit'), null);
  assert.equal(lib.piScreenState('waiting for input'), null);
  for (const v of ['', '\n\n', 'garbage ▎', null, undefined, 7, {}]) assert.equal(lib.piScreenState(v), null);
});

test('piScreenState still sees the prompt below long output and ignores one scrolled far above', () => {
  const long = Array.from({ length: 200 }, (_, i) => `output ${i}`).join('\n');
  assert.equal(lib.piScreenState(`${long}\n${IDLE}`), 'idle');
  assert.equal(lib.piScreenState(`${IDLE}\n${long}`), null);
});

test('piPromptState is idle only for an empty prompt and fails closed otherwise', () => {
  assert.equal(lib.piPromptState(IDLE), 'idle');
  assert.equal(lib.piPromptState(IDLE.replace('type, or / for commands', 'half a sentence')), 'typed');
  assert.equal(lib.piPromptState('thinking…\n▎ working'), 'busy');
  assert.equal(lib.piPromptState(`${IDLE}\nnew output`.replace('waiting for input', 'busy')), 'busy');
  for (const v of ['', null, undefined, 7]) assert.equal(lib.piPromptState(v), 'busy');
});

test('PI_COMMANDS only offers the flow commands', () => {
  assert.deepEqual(lib.PI_COMMANDS, { 'flow-commit': '/flow-commit', 'flow-pr': '/flow-pr', 'flow-branch': '/flow-branch' });
});

// ---------- RP12c: manual and waiting actions ----------
test('workQueue: manual emits a manual action and suppresses deliver and start', () => {
  const q = lib.workQueue([
    repo('a', { dirty: true, unpushed: true, manual: 'Detached HEAD: switch to a task branch' }),
    repo('b', { next: NEXT, manual: '  Diverged  ' }),
  ]);
  assert.deepEqual(q, [
    { repoId: 'id-a', name: 'a', kind: 'manual', reason: 'Detached HEAD: switch to a task branch' },
    { repoId: 'id-b', name: 'b', kind: 'manual', reason: 'Diverged' },
  ]);
});

test('workQueue: waiting emits a waiting action and suppresses deliver and start', () => {
  const q = lib.workQueue([
    repo('a', { dirty: true, unpushed: true, waiting: { state: 'needs-input', next: ' Pick the schema. ' } }),
    repo('b', { next: NEXT, waiting: { state: 'blocked', next: 'Fix the token.' } }),
  ]);
  assert.deepEqual(q, [
    { repoId: 'id-a', name: 'a', kind: 'waiting', state: 'needs-input', next: 'Pick the schema.' },
    { repoId: 'id-b', name: 'b', kind: 'waiting', state: 'blocked', next: 'Fix the token.' },
  ]);
});

test('workQueue: manual wins over waiting, and neither hides merge or branch', () => {
  const q = lib.workQueue([repo('a', { dirty: true, stale: true, ready: [{ number: 2, title: 'x' }], manual: 'm', waiting: { state: 'blocked', next: 'n' } })]);
  assert.deepEqual(kinds(q), ['a:merge', 'a:branch', 'a:manual']);
});

test('workQueue ranks: merge, branch and manual, waiting, deliver, start', () => {
  const q = lib.workQueue([
    repo('s', { next: NEXT }),
    repo('d', { dirty: true }),
    repo('w', { waiting: { state: 'needs-input', next: 'n' } }),
    repo('m', { manual: 'm' }),
    repo('b', { stale: true }),
    repo('p', { ready: [{ number: 1, title: 't' }], hasPrs: true }),
  ]);
  assert.deepEqual(kinds(q), ['p:merge', 'm:manual', 'b:branch', 'w:waiting', 'd:deliver', 's:start']);
});

test('workQueue: priority still puts named repos first with the new kinds', () => {
  const items = [repo('a', { dirty: true }), repo('b', { manual: 'm' }), repo('c', { waiting: { state: 'blocked', next: 'n' } })];
  assert.deepEqual(kinds(lib.workQueue(items, ['c', 'a'])), ['c:waiting', 'a:deliver', 'b:manual']);
});

test('workQueue ignores bad manual and waiting values and clips long text', () => {
  const plain = kinds(lib.workQueue([repo('a', { dirty: true })]));
  for (const manual of [undefined, null, '', '   ', 5, true, {}, ['x']]) {
    assert.deepEqual(kinds(lib.workQueue([repo('a', { dirty: true, manual })])), plain);
  }
  for (const waiting of [undefined, null, 'blocked', 7, {}, { state: 'working', next: 'n' }, { state: 'ready-to-commit', next: 'n' }, { next: 'n' }, { state: 'blocked' }, { state: 'blocked', next: 5 }]) {
    const k = kinds(lib.workQueue([repo('a', { dirty: true, waiting })]));
    assert.ok(k.length === 1 && (k[0] === 'a:deliver' || k[0] === 'a:waiting'), JSON.stringify(waiting));
  }
  for (const waiting of [{ state: 'working', next: 'n' }, { next: 'n' }, 'blocked', {}]) {
    assert.deepEqual(kinds(lib.workQueue([repo('a', { dirty: true, waiting })])), plain);
  }
  const [m] = lib.workQueue([repo('a', { manual: 'x'.repeat(500) })]);
  assert.equal(m.reason.length, 200);
  const [w] = lib.workQueue([repo('a', { waiting: { state: 'blocked', next: 'y'.repeat(500) } })]);
  assert.equal(w.next.length, 200);
});

test('workQueue without manual or waiting is unchanged: deliver, stale branch, start and merge', () => {
  const q = lib.workQueue([
    repo('a', { dirty: true, unpushed: true }),
    repo('b', { stale: true }),
    repo('c', { next: NEXT }),
    repo('d', { ready: [{ number: 4, title: 'T' }], hasPrs: true }),
  ]);
  assert.deepEqual(q, [
    { repoId: 'id-d', name: 'd', kind: 'merge', pr: 4, title: 'T' },
    { repoId: 'id-b', name: 'b', kind: 'branch' },
    { repoId: 'id-a', name: 'a', kind: 'deliver' },
    { repoId: 'id-c', name: 'c', kind: 'start', unit: { id: 'RP9', entrega: 'Next thing' } },
  ]);
});
