'use strict';
// RP37: "Put in conditions" end to end up to the agent's door, on real Git (a bare origin and a clone in a temporary
// folder): the files on the base branch decide which requirements fail, and those ids are what the order sent to the
// agent names. Nothing here talks to Orca or to a pi session, and nothing reads the real config. What the agent does
// once it has the order cannot be tested here: docs/PRUEBAS-put-in-conditions.md is the checklist for that part.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { sh } = require('./git-helper');
const lib = require('../lib.js');
const { requirementsFor } = require('../server/requirements.js');
const { conditionsOrder } = require('../server/pi.js');

const ROOT = path.join(__dirname, '..');
const lf = (text) => text.replace(/\r\n/g, '\n');
const block = (name) => lf(fs.readFileSync(path.join(ROOT, 'requirements', 'blocks', `${name}.md`), 'utf8'));

const ROADMAP = '# Roadmap\n\n**Dónde está:** a\n**Qué sigue:** b\n**Qué lo bloquea:** c\n\n| ID | Entrega | Depende de | Estado |\n| --- | --- | --- | --- |\n| U1 | x | - | Pendiente |\n';
const CICLO_WITHOUT_SALA = '<!-- orquestacion:ciclo v1.0 -->\nx\n<!-- /orquestacion:ciclo -->\n';
const agents = (...blocks) => `# Repo\n\n${blocks.join('\n')}`;
// A repo that meets every requirement: the three blocks copied verbatim, the roadmap in the panel's format, the adoption record.
const CONFORMING = {
  'AGENTS.md': agents(block('registro'), block('ciclo'), block('estado')),
  'docs/ROADMAP.md': ROADMAP,
  'docs/ORQUESTACION.md': '# Orquestación\n',
};

const made = [];
test.after(() => { for (const dir of made) fs.rmSync(dir, { recursive: true, force: true }); });

// A bare origin plus a clone whose main already holds `files`. `ignored` adds .panel/ to .git/info/exclude, as the agent does.
function makeRepo(files, { ignored = true } = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rp37-'));
  made.push(tmp);
  const origin = path.join(tmp, 'origin.git');
  const work = path.join(tmp, 'work');
  sh(tmp, 'init', '--bare', '-b', 'main', origin);
  sh(tmp, 'clone', '-q', origin, work);
  sh(work, 'checkout', '-q', '-B', 'main');
  const push = (more) => {
    for (const [name, text] of Object.entries(more)) {
      fs.mkdirSync(path.dirname(path.join(work, name)), { recursive: true });
      fs.writeFileSync(path.join(work, name), text);
    }
    sh(work, 'add', '-A'); sh(work, 'commit', '-q', '-m', 'c'); sh(work, 'push', '-q', 'origin', 'main');
  };
  push(files);
  if (ignored) fs.appendFileSync(path.join(work, '.git', 'info', 'exclude'), '.panel/\n');
  return { work, push, repo: { id: lib.repoId(work), path: work } };
}

const statusOf = (out) => Object.fromEntries(out.results.map((r) => [r.id, r.status]));
const failing = (out) => out.results.filter((r) => r.status !== 'pass').map((r) => r.id);
// The ids the order names, in order, as the agent reads them.
const orderIds = (results) => /requirement ids: (.+?)\. Never use git mv/.exec(conditionsOrder(results))[1].split(', ');
const refusesNothingToDo = (results) => assert.throws(() => conditionsOrder(results), (e) => e.status === 409 && /Every requirement already passes/.test(e.message));

test('a repo with nothing but a README: the required gaps come first in the order, then the recommended ones', async () => {
  const r = makeRepo({ 'README.md': 'x\n' }, { ignored: false });
  const out = await requirementsFor(r.repo, null);
  assert.equal(out.available, true);
  assert.equal(out.summary.ready, false);
  assert.deepEqual(orderIds(out.results), ['agents-file', 'registro-block', 'roadmap-file', 'roadmap-header', 'roadmap-table', 'ciclo-block', 'adoption-record', 'estado-block', 'panel-ignored']);
  assert.equal(statusOf(out)['base-branch'], 'pass', 'what already passes is never named');
});

test('a repo that meets everything: the blocks the agent is told to copy pass as they are, and the order is refused with 409', async () => {
  const out = await requirementsFor(makeRepo(CONFORMING).repo, null);
  assert.deepEqual(failing(out), []);
  assert.deepEqual([out.summary.ready, out.summary.required, out.summary.recommended], [true, { pass: 6, total: 6 }, { pass: 4, total: 4 }]);
  refusesNothingToDo(out.results);
});

test('only panel-ignored is missing: the order names it alone, and it is recommended so the repo is still ready', async () => {
  const out = await requirementsFor(makeRepo(CONFORMING, { ignored: false }).repo, null);
  assert.deepEqual(orderIds(out.results), ['panel-ignored']);
  assert.equal(out.summary.ready, true);
});

test('a block with an old version is outdated, and the order names only that block', async () => {
  const old = CONFORMING['AGENTS.md'].replace('orquestacion:registro v1.0', 'orquestacion:registro v0.9');
  const out = await requirementsFor(makeRepo({ ...CONFORMING, 'AGENTS.md': old }).repo, null);
  assert.equal(statusOf(out)['registro-block'], 'outdated');
  assert.deepEqual(orderIds(out.results), ['registro-block']);
  assert.equal(out.summary.ready, false, 'registro is required');
});

test('a roadmap table with other column names fails alone: the validator is what the instructions now spell out', async () => {
  const wrong = ROADMAP.replace('Entrega', 'Unidad').replace('Depende de', 'Dependencias');
  const out = await requirementsFor(makeRepo({ ...CONFORMING, 'docs/ROADMAP.md': wrong }).repo, null);
  assert.deepEqual(orderIds(out.results), ['roadmap-table']);
  assert.match(out.results.find((r) => r.id === 'roadmap-table').detail, /missing required columns: Entrega, Depende de/);
});

test('a repo of a room needs the SALA region of the ciclo block; outside a room the same repo is fine', async () => {
  const files = { ...CONFORMING, 'AGENTS.md': agents(block('registro'), CICLO_WITHOUT_SALA, block('estado')) };
  const r = makeRepo(files);
  const outside = await requirementsFor(r.repo, null);
  assert.deepEqual(failing(outside), []);
  assert.equal(outside.results.some((x) => x.id === 'sala-region'), false, 'the member-only requirement is not even listed');
  const inside = await requirementsFor(r.repo, { name: 'Sala' });
  assert.deepEqual(orderIds(inside.results), ['sala-region']);
  assert.equal(inside.summary.ready, false);
});

test('a repo of a room that meets everything is refused with 409 as well', async () => {
  const out = await requirementsFor(makeRepo(CONFORMING).repo, { name: 'Sala' });
  assert.deepEqual(failing(out), []);
  assert.equal(out.results.find((x) => x.id === 'sala-region').status, 'pass');
  refusesNothingToDo(out.results);
});

test('the updater loop: after the agent applies the fix and it reaches the base branch, the gap and the order disappear', async () => {
  const old = CONFORMING['AGENTS.md'].replace('orquestacion:registro v1.0', 'orquestacion:registro v0.9');
  const r = makeRepo({ ...CONFORMING, 'AGENTS.md': old });
  const before = await requirementsFor(r.repo, null);
  assert.deepEqual(orderIds(before.results), ['registro-block']);
  r.push({ 'AGENTS.md': CONFORMING['AGENTS.md'] });
  const after = await requirementsFor(r.repo, null);
  assert.deepEqual(failing(after), []);
  refusesNothingToDo(after.results);
});

test('the order carries ids from the registry, never text taken from the repo', async () => {
  const hostile = CONFORMING['AGENTS.md'].replace('orquestacion:registro v1.0', 'orquestacion:registro v0.9') + '\n"; rm -rf / #\n';
  const out = await requirementsFor(makeRepo({ ...CONFORMING, 'AGENTS.md': hostile, 'docs/ROADMAP.md': `${ROADMAP}| "; calc | x | - | Pendiente |\n` }).repo, null);
  const order = conditionsOrder(out.results);
  assert.doesNotMatch(order, /rm -rf|calc/);
  assert.equal(order.split('\n').length, 1, 'one line');
  assert.doesNotMatch(order, /^\//, 'never a slash command');
});

test('a repo whose base branch is not on the remote is unavailable, not a list of failures', async () => {
  const r = makeRepo(CONFORMING);
  sh(r.work, 'update-ref', '-d', 'refs/remotes/origin/main');
  const out = await requirementsFor(r.repo, null);
  assert.equal(out.available, false);
});
