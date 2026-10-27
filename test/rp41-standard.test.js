'use strict';
// RP41: the standard every repo is put in conditions with.
//  - the `entrega` block: branches, commits and pull requests belong to the panel's commands, and nothing commits but /flow-commit;
//  - the padrón: ONE version for the whole set of rules, recorded by each repo in docs/ORQUESTACION.md, cited by the order,
//    so a change of INSTALL.md marks every repo as outdated even when no block changed;
//  - INSTALL.md as short numbered steps with worked examples (requirements/EXAMPLES.md) that these tests RUN, so an example
//    can never drift from what the panel's validator accepts.
// The wording pins are few and only for the rules that must never be lost (never commit, never create a branch, stop
// conditions, production branches kept). What the agent does with the texts is for docs/PRUEBAS-put-in-conditions.md.
const test = require('node:test');
const assert = require('node:assert/strict');
const lib = require('../lib.js');
const { parseBlock, evaluate } = require('../checks.js');
const { conditionsOrder } = require('../server/pi.js');
const { read, installText, steps, step } = require('./install-steps.js');

const registry = JSON.parse(read('requirements.json'));
const ENTREGA = () => read('requirements', 'blocks', 'entrega.md');
const TAREAS = () => read('requirements', 'blocks', 'tareas.md');
const remedyOf = (id) => registry.requirements.find((r) => r.id === id).remedy;
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// ---------- the entrega block ----------
test('requirements/blocks/entrega.md is a closed panel:entrega block at the registry version, short enough to read at a glance', () => {
  assert.deepEqual(parseBlock(ENTREGA(), 'entrega', registry.blocks.entrega, 'panel'), { status: 'ok', version: registry.blocks.entrega });
  assert.ok(ENTREGA().trimEnd().split('\n').length <= 30);
});

test('the entrega block is the ONLY delivery mechanism and voids any other rule about branches, commits or pull requests', () => {
  const b = ENTREGA();
  assert.match(b, /ÚNICO mecanismo de entrega/);
  assert.match(b, /queda sin efecto/);
  assert.match(b, /estrategia de ramas propia/);
});

test('the entrega block says who delivers: the person, with the three commands, and the commands decide names and messages', () => {
  const b = ENTREGA();
  for (const cmd of ['`/flow-base`', '`/flow-commit`', '`/flow-pr`']) assert.ok(b.includes(cmd), cmd);
  assert.match(b, /decid(en|e) el nombre de la rama, el mensaje del commit y el texto del PR/);
});

test('the entrega block forbids EVERY way of committing but /flow-commit, creating branches, pushing and opening or merging PRs', () => {
  const b = ENTREGA();
  assert.match(b, /Commitear por cualquier otro medio que no sea `\/flow-commit`/);
  for (const way of ['`git commit`', 'IDE', 'script', 'en una rama propia']) assert.ok(b.includes(way), way);
  assert.match(b, /crear ni cambiar de rama, hacer push, abrir ni fusionar un PR/);
  assert.match(b, /`git add`/);
  assert.match(b, /índice queda vacío/);
});

test('the registry versions the entrega block and asks for it as a REQUIRED requirement right after tareas-block', () => {
  assert.equal(registry.blocks.entrega, '1.0');
  const ids = registry.requirements.map((r) => r.id);
  assert.equal(ids[ids.indexOf('tareas-block') + 1], 'entrega-block');
  const req = registry.requirements.find((r) => r.id === 'entrega-block');
  assert.deepEqual([req.category, req.level], ['verificable', 'required']);
  assert.deepEqual(req.check, { type: 'block', file: 'agents', name: 'entrega', namespace: 'panel' });
  assert.match(req.remedy, /requirements\/blocks\/entrega\.md/);
  assert.match(req.remedy, /INSTALL\.md step 8/);
});

// ---------- the padrón ----------
test('the padrón is a version of the registry and the title of INSTALL.md carries the same one', () => {
  assert.match(registry.padron, /^\d+(\.\d+)*$/);
  assert.match(installText().split('\n')[0], new RegExp(`\\(padrón ${escapeRe(registry.padron)}\\)`));
});

test('padron-record is a REQUIRED requirement that reads docs/ORQUESTACION.md, and its remedy says what to write and when', () => {
  const req = registry.requirements.find((r) => r.id === 'padron-record');
  assert.deepEqual([req.category, req.level], ['verificable', 'required']);
  assert.deepEqual(req.check, { type: 'padron', file: 'adoption' });
  assert.match(req.remedy, /Padrón del panel/);
  assert.match(req.remedy, /INSTALL\.md step 10/);
});

const padronReg = { padron: '1.0', requirements: [{ id: 'p', title: 'P', category: 'verificable', level: 'required', check: { type: 'padron', file: 'adoption' }, remedy: 'r' }] };
const adoption = (text) => ({ base: { status: 'ok', name: 'main' }, files: { adoption: { available: true, text, path: 'docs/ORQUESTACION.md' } } });
const padron = (text) => evaluate(padronReg, adoption(text)).results[0];

test('the padrón check passes on the current version, however the line is written (bullet or not, v prefix, CRLF, BOM)', () => {
  for (const text of ['- **Padrón del panel:** 1.0\n', '* **Padrón del panel:** 1.0\n', '**Padrón del panel:** v1.0\n', '# A\r\n\r\n- **Padrón del panel:** 1.0\r\nmás\r\n', '\uFEFF- **Padrón del panel:** 1.0']) {
    assert.deepEqual([padron(text).status, padron(text).detail], ['pass', 'padrón 1.0'], JSON.stringify(text));
  }
});

test('the padrón check is outdated on another version, and fails when the line or the file is missing', () => {
  assert.deepEqual([padron('- **Padrón del panel:** 0.9\n').status, padron('- **Padrón del panel:** 0.9\n').detail], ['outdated', 'padrón 0.9 found, 1.0 expected']);
  assert.equal(padron('# Adopción\n\nsin la línea\n').status, 'fail');
  const absent = evaluate(padronReg, { base: { status: 'ok', name: 'main' }, files: { adoption: { available: false, reason: 'missing', path: 'docs/ORQUESTACION.md' } } }).results[0];
  assert.deepEqual([absent.status, absent.detail], ['fail', 'docs/ORQUESTACION.md not found on the base branch']);
  const noBase = evaluate(padronReg, { base: { status: 'no-base', name: 'main' }, files: {} }).results[0];
  assert.equal(noBase.status, 'unavailable');
});

test('the padrón line must be a whole line: a version inside a sentence or a longer version is not accepted', () => {
  assert.equal(padron('Usamos el **Padrón del panel:** 1.0 desde ayer\n').status, 'fail');
  assert.equal(padron('- **Padrón del panel:** 1.0.1\n').status, 'outdated');
});

test('the order names the padrón it applies, so the agent writes the right one and the person can see it', () => {
  const order = conditionsOrder([{ id: 'agents-file', level: 'required', status: 'fail' }]);
  assert.match(order, new RegExp(`for repo-panel \\(padrón ${escapeRe(registry.padron)}\\): read "`));
  assert.equal(order.split('\n').length, 1, 'still one line');
  assert.doesNotMatch(order, /^\//, 'still not a slash command');
});

// ---------- INSTALL.md as short numbered steps ----------
test('INSTALL.md has the steps 1 to 11, in order, and no line is longer than 700 characters (the old step 7 was one line of about 3000)', () => {
  assert.deepEqual(Object.keys(steps()).map(Number), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
  const longest = installText().split('\n').reduce((m, l) => Math.max(m, l.length), 0);
  assert.ok(longest <= 700, `the longest line has ${longest} characters`);
});

test('every step mentioned by a remedy or by INSTALL.md itself exists', () => {
  const have = new Set(Object.keys(steps()).map(Number));
  const mentioned = [];
  for (const r of registry.requirements) for (const m of r.remedy.matchAll(/INSTALL\.md step (\d+)/g)) mentioned.push(Number(m[1]));
  for (const m of installText().matchAll(/\bsteps? ((?:\d+(?:, | and )?)+)/g)) for (const n of m[1].match(/\d+/g)) mentioned.push(Number(n));
  assert.ok(mentioned.length >= 5, 'the cross-references are there');
  for (const n of mentioned) assert.ok(have.has(n), `step ${n} is mentioned but does not exist`);
});

test('step 3 names every block of the registry, and says where they go in AGENTS.md without reordering the repo rules', () => {
  const s = step(3);
  for (const name of Object.keys(registry.blocks)) assert.ok(s.includes(`\`${name}.md\``), `${name}.md`);
  assert.match(s, /right after the title and the one-line description/);
  assert.ok(s.includes('`registro`, `tareas`, `entrega`, `ciclo`, `estado`'));
  assert.match(s, /do not reorder, reword or summarize the repo's technical rules/);
});

test('step 5 makes AGENTS.md the ONLY instruction file and asks for a report of the others, never touching them', () => {
  const s = step(5);
  assert.match(s, /ONLY instruction file/);
  assert.match(s, /do not follow them, do not edit them and do not delete them/);
  assert.match(s, /replace that statement with one line/i);
  assert.match(s, /git log -1 --format=%cs/);
  assert.match(s, /headings it has that `AGENTS\.md` does not/);
  assert.match(s, /Never delete existing rules from `AGENTS\.md`/);
});

test('step 6 still stops on a conflict, except on what the user already decided (tasks, delivery, which file is the authority)', () => {
  const s = step(6);
  assert.match(s, /STOP/);
  assert.match(s, /Do not decide alone/);
  assert.match(s, /never asked: the panel's mechanism wins/);
});

test('step 8: the agent never creates or switches branches, not even installing, and never commits but through /flow-commit', () => {
  const s = step(8);
  assert.match(s, /Never create or switch branches, even during this installation/);
  assert.match(s, /Never commit by any means other than `\/flow-commit`/);
  assert.match(s, /never push or open a pull request/i);
  assert.match(s, /write nothing and tell the person what is missing/);
  assert.doesNotMatch(installText(), /Work on a task branch/, 'the rule that asked for a branch during the installation is gone');
});

test('step 8 removes the repo own branching, commit and PR rules but keeps what a long-lived branch is for', () => {
  const s = step(8);
  assert.match(s, /Remove from `AGENTS\.md` every instruction about branch names or branching strategy for day-to-day work, commit message format, and pull request format or process/);
  assert.match(s, /keep the lines that say what a long-lived branch is for/i);
  assert.match(s, /pipelines may depend on them/);
  assert.match(s, /if you are unsure whether a rule is about branches, commits or pull requests, keep it/i);
});

test('step 9 keeps the index empty; step 10 records the padrón last; step 11 asks for a report and then ONE last line', () => {
  assert.match(step(9), /Never use `git mv` or `git add`/);
  assert.match(step(10), /docs\/ORQUESTACION\.md/);
  assert.match(step(10), /Padrón del panel/);
  assert.match(step(10), /Do it last/);
  assert.match(step(11), /the report/);
  assert.match(step(11), /what you removed from `AGENTS\.md`/);
  assert.match(step(11), /ONE last line, `Siguiente: \.\.\.`/);
});

test('the former contradiction is gone: no step asks for ONE line while others ask for lists', () => {
  assert.doesNotMatch(installText(), /Finish by writing ONE line/);
});

// ---------- the worked examples, executed ----------
const EXAMPLES = () => read('requirements', 'EXAMPLES.md');
const example = (label) => {
  const m = new RegExp('```md ejemplo:' + escapeRe(label) + '\\n([\\s\\S]*?)\\n```').exec(EXAMPLES());
  assert.ok(m, `example ${label} is missing from requirements/EXAMPLES.md`);
  return m[1];
};
const HEADER = '**Dónde está:** a\n**Qué sigue:** b\n**Qué lo bloquea:** c\n\n';
const errorsOf = (table) => lib.parseRoadmap(HEADER + table + '\n').problems.filter((p) => p.severity === 'error').map((p) => p.message);
const FOUR = ['Pendiente', 'En curso', 'Completada', 'Bloqueada'];

test('INSTALL.md sends the agent to the examples, and every example the tests need is there', () => {
  assert.match(installText(), /requirements\/EXAMPLES\.md/);
  for (const label of ['a-antes', 'a-despues', 'b-antes', 'b-despues', 'c-estados', 'd-antes', 'd-despues', 'e-informe']) example(label);
});

test('example A: the table with other column names is what the validator rejects, and the renamed one passes with the same rows', () => {
  assert.deepEqual(errorsOf(example('a-antes')), ['Table is missing required columns: Entrega, Depende de']);
  assert.deepEqual(errorsOf(example('a-despues')), []);
  const rows = (t) => lib.parseRoadmap(HEADER + t + '\n').rows.map((r) => r.id);
  assert.deepEqual(rows(example('a-despues')), ['FS1', 'FS2']);
});

test('example B: the tasks migrated from another system become rows that pass, keep their IDs and their fichas, and only declared dependencies', () => {
  const after = example('b-despues');
  assert.deepEqual(errorsOf(after), []);
  const rows = lib.parseRoadmap(HEADER + after + '\n').rows;
  assert.deepEqual(rows.map((r) => r.id), ['kubernetes-health-probes', 'bullmq-health-indicator']);
  for (const r of rows) assert.ok(FOUR.includes(r.estado), r.id);
  for (const id of rows.map((r) => r.id)) assert.ok(example('b-antes').includes(id), `the ID ${id} comes from the source`);
  for (const r of rows) assert.ok(after.includes(`planning/${r.id}/`), `${r.id} keeps a ficha pointing to its old folder`);
  assert.deepEqual(rows[0].dependsOn, [], 'the source declared none: no invented dependency');
  assert.deepEqual(rows[1].dependsOn, ['kubernetes-health-probes'], 'declared in the source as a blocker');
});

test('example C: every source state word translates to one of the four states, and none translates to a computed one', () => {
  const lines = example('c-estados').split('\n').filter((l) => /^\|/.test(l) && !/^\|\s*-/.test(l)).slice(1);
  assert.ok(lines.length >= 4);
  const targets = new Set();
  for (const l of lines) {
    const [, , write] = l.split('|').map((c) => c.trim());
    assert.ok(FOUR.includes(write), `"${write}" is not one of the four states`);
    targets.add(write);
  }
  assert.deepEqual([...targets].sort(), [...FOUR].sort());
  assert.doesNotMatch(example('c-estados'), /Lista|En revisión/);
});

test('example D: the commit convention and the day-to-day branch naming go; the long-lived branches and the test rule stay', () => {
  const before = example('d-antes');
  const after = example('d-despues');
  assert.match(before, /Commit Convention/);
  assert.match(before, /feature\//);
  assert.doesNotMatch(after, /Commit Convention/);
  assert.doesNotMatch(after, /feature\//);
  for (const kept of ['`master` - Production', '`development` - Development', '`release/1.0.0` - Releases', '`hotfix/XYZ-456-descripcion` - Hotfixes', 'Run `npm test` before every PR.']) assert.ok(after.includes(kept), kept);
});

test('example E: the final report lists what was migrated, what was removed, the other instruction files, and ends with ONE Siguiente line', () => {
  const report = example('e-informe').trim().split('\n');
  assert.match(report.join('\n'), /Migré/);
  assert.match(report.join('\n'), /Quité de AGENTS\.md/);
  assert.match(report.join('\n'), /Otros archivos de instrucciones/);
  assert.match(report.join('\n'), /\d{4}-\d{2}-\d{2}/, 'the date of the last commit of each other file');
  assert.match(report[report.length - 1], /^Siguiente: /);
  assert.equal(report.filter((l) => /^Siguiente:/.test(l)).length, 1);
});

test('tareas does not talk about delivery and entrega does not talk about tasks: each rule has one home', () => {
  assert.doesNotMatch(TAREAS(), /\/flow-commit/);
  assert.doesNotMatch(ENTREGA(), /docs\/ROADMAP\.md|`Pendiente`|`Completada`/);
  assert.match(remedyOf('entrega-block'), /branches, commits and pull requests/);
});
