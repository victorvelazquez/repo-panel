'use strict';
// RP36: changing the text of a versioned block (requirements/blocks/*.md) must bump its version. The panel marks a repo
// `outdated` only when its block version differs from the registry's, so an edit without a bump would leave every repo
// on the old rule without any warning. requirements/blocks.lock.json holds the version and a hash of each block's text;
// this test fails when the text changed and the version did not. The same lock covers the padrón (RP41): the version of
// the whole set of rules, hashed over INSTALL.md and EXAMPLES.md, so a change of the procedure marks every repo too.
// Refresh the lock after a deliberate change with:
//   UPDATE_BLOCK_LOCK=1 node --test test/rp36-block-versions.test.js
// The refresh REFUSES a text change under the same version (it would defeat the guard it feeds); for a block nobody has
// installed yet, UPDATE_BLOCK_LOCK=force accepts it.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { parseBlock } = require('../checks.js');

const ROOT = path.join(__dirname, '..');
const lf = (text) => text.replace(/\r\n/g, '\n');
const REGISTRY = JSON.parse(lf(fs.readFileSync(path.join(ROOT, 'requirements.json'), 'utf8')));
const LOCK_PATH = path.join(ROOT, 'requirements', 'blocks.lock.json');
const NAMESPACE = { estado: 'panel', tareas: 'panel', entrega: 'panel' }; // every other block lives in the orquestacion namespace

const blockText = (name) => lf(fs.readFileSync(path.join(ROOT, 'requirements', 'blocks', `${name}.md`), 'utf8'));
// The padrón covers the procedure the agent reads: INSTALL.md and its worked examples.
const padronText = () => ['INSTALL.md', 'EXAMPLES.md'].map((f) => lf(fs.readFileSync(path.join(ROOT, 'requirements', f), 'utf8'))).join('\n--- EXAMPLES.md ---\n');
const readAny = (name) => (name === 'padron' ? padronText() : blockText(name));
const sha = (text) => crypto.createHash('sha256').update(text).digest('hex');
function current(registry = REGISTRY, read = readAny) {
  const out = Object.fromEntries(Object.keys(registry.blocks).map((n) => [n, { version: registry.blocks[n], sha256: sha(read(n)) }]));
  if (registry.padron) out.padron = { version: registry.padron, sha256: sha(read('padron')) };
  return out;
}
const where = (name) => (name === 'padron' ? 'the title of requirements/INSTALL.md and "padron" of requirements.json' : `the marker of requirements/blocks/${name}.md and in "blocks" of requirements.json`);

// What a refresh of the lock must refuse: an entry whose text changed while its version did not.
const refreshRefusals = (oldLock, now) => Object.keys(now).filter((n) => oldLock[n] && oldLock[n].version === now[n].version && oldLock[n].sha256 !== now[n].sha256);

// The lock is a single source of truth about "what each version of each block said". Returns the problems, [] when fine.
function lockProblems(now, lock) {
  const out = [];
  for (const name of Object.keys(now)) {
    const was = lock[name];
    if (!was) { out.push(`${name}: not in blocks.lock.json (run the refresh command after a deliberate change)`); continue; }
    if (was.sha256 === now[name].sha256 && was.version === now[name].version) continue;
    if (was.version === now[name].version) out.push(`${name}: the text changed but the version is still ${now[name].version}; bump it in ${where(name)}, then refresh the lock`);
    else out.push(`${name}: the version went from ${was.version} to ${now[name].version}; refresh blocks.lock.json so it records the new text`);
  }
  for (const name of Object.keys(lock)) if (!now[name]) out.push(`${name}: in blocks.lock.json but not in "blocks" of requirements.json`);
  return out;
}

// ---------- the real blocks ----------
test('every block file carries the version the registry asks for, in its own namespace', () => {
  for (const name of Object.keys(REGISTRY.blocks)) {
    const r = parseBlock(blockText(name), name, REGISTRY.blocks[name], NAMESPACE[name] || 'orquestacion');
    assert.deepEqual(r, { status: 'ok', version: REGISTRY.blocks[name] }, `${name}.md`);
  }
});

test('the registry and the block files list the same blocks', () => {
  const files = fs.readdirSync(path.join(ROOT, 'requirements', 'blocks')).filter((f) => f.endsWith('.md')).map((f) => f.slice(0, -3)).sort();
  assert.deepEqual(Object.keys(REGISTRY.blocks).sort(), files);
});

test('requirements/blocks.lock.json matches the blocks and the padrón as they are now', () => {
  const mode = process.env.UPDATE_BLOCK_LOCK;
  if (mode === '1' || mode === 'force') {
    const old = fs.existsSync(LOCK_PATH) ? JSON.parse(lf(fs.readFileSync(LOCK_PATH, 'utf8'))) : {};
    const refused = mode === 'force' ? [] : refreshRefusals(old, current());
    assert.deepEqual(refused, [], `refresh refused: the text of ${refused.join(', ')} changed but its version did not; bump the version first (UPDATE_BLOCK_LOCK=force only for a block nobody has installed yet)`);
    fs.writeFileSync(LOCK_PATH, `${JSON.stringify(current(), null, 2)}\n`);
  }
  assert.ok(fs.existsSync(LOCK_PATH), 'requirements/blocks.lock.json is missing (UPDATE_BLOCK_LOCK=1 creates it)');
  assert.deepEqual(lockProblems(current(), JSON.parse(lf(fs.readFileSync(LOCK_PATH, 'utf8')))), []);
});

test('the rule is written where the person editing a block will read it', () => {
  const readme = lf(fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8'));
  assert.match(readme, /blocks\.lock\.json/);
  assert.match(readme, /changing the text of a block means bumping its version/i);
  assert.match(readme, /UPDATE_BLOCK_LOCK=1/);
  assert.match(readme, /UPDATE_BLOCK_LOCK=force/);
  assert.match(readme, /padrón/i);
});

test('the lock holds the padrón too, at the registry version, and INSTALL.md carries that version in its title', () => {
  const lock = JSON.parse(lf(fs.readFileSync(LOCK_PATH, 'utf8')));
  assert.equal(lock.padron.version, REGISTRY.padron);
  assert.match(lf(fs.readFileSync(path.join(ROOT, 'requirements', 'INSTALL.md'), 'utf8')).split('\n')[0], new RegExp(`\\(padrón ${REGISTRY.padron.replace(/\./g, '\\.')}\\)`));
});

// ---------- the comparison, on a made-up registry (bumping a real block must never break these) ----------
const FAKE = { blocks: { registro: '1.0', ciclo: '1.0', estado: '1.0' } };
const FAKE_TEXT = { registro: 'registro rules\n', ciclo: 'ciclo rules\n', estado: 'estado rules\n' };
const fakeNow = (registry = FAKE, texts = FAKE_TEXT) => current(registry, (n) => texts[n]);

test('a block whose text did not change passes, and so does an unchanged lock', () => {
  const now = fakeNow();
  assert.deepEqual(lockProblems(now, JSON.parse(JSON.stringify(now))), []);
});

test('the text changed and the version did not: the message tells to bump it in both places', () => {
  const problems = lockProblems(fakeNow(FAKE, { ...FAKE_TEXT, registro: `${FAKE_TEXT.registro}extra rule\n` }), fakeNow());
  assert.equal(problems.length, 1);
  assert.match(problems[0], /^registro: the text changed but the version is still 1\.0; bump it in the marker of requirements\/blocks\/registro\.md and in "blocks" of requirements\.json/);
});

test('the text changed and the version was bumped: only a stale lock is left to refresh', () => {
  const bumped = { blocks: { ...FAKE.blocks, ciclo: '1.1' } };
  const problems = lockProblems(fakeNow(bumped, { ...FAKE_TEXT, ciclo: `${FAKE_TEXT.ciclo}more\n` }), fakeNow());
  assert.deepEqual(problems, ['ciclo: the version went from 1.0 to 1.1; refresh blocks.lock.json so it records the new text']);
});

test('a version bump without a text change is also a stale lock', () => {
  const problems = lockProblems(fakeNow({ blocks: { ...FAKE.blocks, estado: '2.0' } }), fakeNow());
  assert.deepEqual(problems, ['estado: the version went from 1.0 to 2.0; refresh blocks.lock.json so it records the new text']);
});

test('a block missing from the lock, or left in the lock after leaving the registry, is reported', () => {
  const lock = fakeNow();
  delete lock.estado;
  assert.match(lockProblems(fakeNow(), lock).join('\n'), /estado: not in blocks\.lock\.json/);
  const extra = { ...fakeNow(), viejo: { version: '1.0', sha256: 'x' } };
  assert.match(lockProblems(fakeNow(), extra).join('\n'), /viejo: in blocks\.lock\.json but not in "blocks"/);
});

// ---------- the padrón and the refresh, on made-up data ----------
const FAKE_P = { padron: '1.0', blocks: FAKE.blocks };
const FAKE_P_TEXT = { ...FAKE_TEXT, padron: 'install steps\n' };

test('the padrón is part of the lock: changing the procedure under the same padrón is reported with where to bump it', () => {
  const lock = current(FAKE_P, (n) => FAKE_P_TEXT[n]);
  assert.deepEqual(Object.keys(lock).sort(), ['ciclo', 'estado', 'padron', 'registro']);
  const edited = current(FAKE_P, (n) => (n === 'padron' ? 'install steps\nmore\n' : FAKE_P_TEXT[n]));
  const problems = lockProblems(edited, lock);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /^padron: the text changed but the version is still 1\.0; bump it in the title of requirements\/INSTALL\.md and "padron" of requirements\.json/);
});

test('a refresh REFUSES a text change under the same version, so refreshing cannot defeat the guard', () => {
  const lock = current(FAKE_P, (n) => FAKE_P_TEXT[n]);
  const edited = current(FAKE_P, (n) => (n === 'registro' ? 'registro rules, edited\n' : FAKE_P_TEXT[n]));
  assert.deepEqual(refreshRefusals(lock, edited), ['registro']);
});

test('a refresh accepts what is legitimate: a version bump with its new text, a new entry, and no change at all', () => {
  const lock = current(FAKE_P, (n) => FAKE_P_TEXT[n]);
  const bumped = current({ padron: '1.1', blocks: { ...FAKE.blocks, ciclo: '1.1' } }, (n) => (n === 'ciclo' ? 'ciclo edited\n' : FAKE_P_TEXT[n]));
  assert.deepEqual(refreshRefusals(lock, bumped), []);
  const grown = current({ padron: '1.0', blocks: { ...FAKE.blocks, entrega: '1.0' } }, (n) => ({ ...FAKE_P_TEXT, entrega: 'new block\n' })[n]);
  assert.deepEqual(refreshRefusals(lock, grown), []);
  assert.deepEqual(refreshRefusals(lock, lock), []);
});

test('line endings do not change the hash (Windows checks files out with CRLF)', () => {
  assert.equal(sha(lf('a\r\nb\r\n')), sha('a\nb\n'));
});
