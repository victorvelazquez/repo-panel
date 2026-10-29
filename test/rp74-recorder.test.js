'use strict';
// RP74 (S67): the passive recorder keeps the WHOLE dialog screen, not only the last 14 lines, so a list of options can be studied (and
// later answered, RP73) from real screens. It still only observes: it never answers and never presses a key. Temp dirs only.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const lib = require('../lib.js');
const casos = require('../server/casos.js');

const FOOTER = '↑↓ navigate  enter select  escape/ctrl+c cancel';
const options = (n, prefix = 'Option') => Array.from({ length: n }, (_, i) => `${i === 2 ? '→ ' : '  '}${prefix} ${i + 1} description`);
const screenOf = ({ title = 'Which one do you want?', n = 30, prefix, footer = FOOTER, after = ['──────────────────────'] } = {}) => [title, ...options(n, prefix), footer, ...after].join('\n');

const scratch = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rp74-'));
  return { file: path.join(dir, 'sub', 'casos.jsonl'), done: () => fs.rmSync(dir, { recursive: true, force: true }) };
};
const clock = (start = Date.UTC(2026, 9, 29, 12, 0, 0)) => { const c = { t: start, now: () => c.t }; return c; };
const rows = (file) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);

test('lib.piScreenTail: the last N non-empty lines, cleaned, without the usage widget; [] for a non-string', () => {
  assert.equal(typeof lib.piScreenTail, 'function');
  assert.deepEqual(lib.piScreenTail(undefined), []);
  assert.deepEqual(lib.piScreenTail(42), []);
  const preview = ['one', '', 'two\x1b[31m', 'x'.repeat(300), '5h 15% ↻lun 01:50 · 7d 37% ↻jue 11:00', 'last'].join('\n');
  const tail = lib.piScreenTail(preview, 40);
  assert.deepEqual(tail, ['one', 'two [31m', 'x'.repeat(200), 'last']);
  assert.deepEqual(lib.piScreenTail(preview, 2), ['x'.repeat(200), 'last']);
  assert.equal(lib.piScreenTail(Array.from({ length: 100 }, (_, i) => `l${i}`).join('\n')).length, 40);
});

test('recorder: a row carries screen, the last 40 cleaned lines, beyond the 14 of lines; lines is unchanged', async () => {
  const s = scratch();
  try {
    const r = casos.createRecorder({ file: s.file, now: clock().now });
    const preview = screenOf({ n: 30 });
    r.record({ folder: 'f', handle: 'h1', state: 'asking', preview });
    await r.flush();
    const [row] = rows(s.file);
    assert.ok(Array.isArray(row.screen), 'screen is an array');
    assert.deepEqual(row.screen, lib.piScreenTail(preview, 40));
    assert.equal(row.lines.length, 14);
    assert.ok(row.screen.length > row.lines.length);
    assert.ok(row.screen.some((l) => /Option 3 description/.test(l) && l.startsWith('→')), 'the highlighted option of the top of the list is kept');
    assert.deepEqual(row.lines, lib.piScreenQuestionish(preview).lines);
  } finally { s.done(); }
});

test('recorder: a screen with an unrecognised footer is recorded with its full screen too', async () => {
  const s = scratch();
  try {
    const r = casos.createRecorder({ file: s.file, now: clock().now });
    r.record({ folder: 'f', handle: 'h1', state: null, preview: screenOf({ n: 25, footer: '↑↓ navigate  enter pick  escape/ctrl+c exit  (choose one)' }) });
    await r.flush();
    const [row] = rows(s.file);
    assert.equal(row.recognized, false);
    assert.ok(row.screen.length >= 25);
  } finally { s.done(); }
});

test('recorder: the same last 14 lines with a different top of the list is a NEW case (the screen is part of the key)', async () => {
  const s = scratch();
  try {
    const c = clock();
    const r = casos.createRecorder({ file: s.file, now: c.now });
    r.record({ folder: 'f', handle: 'h1', state: 'asking', preview: screenOf({ n: 30, title: 'First question?' }) });
    c.t += 60 * 1000;
    r.record({ folder: 'f', handle: 'h1', state: 'asking', preview: screenOf({ n: 30, title: 'Second question?' }) });
    c.t += 60 * 1000;
    r.record({ folder: 'f', handle: 'h1', state: 'asking', preview: screenOf({ n: 30, title: 'Second question?' }) });
    await r.flush();
    assert.equal(rows(s.file).length, 2, 'two different questions, the repeat is not recorded again');
  } finally { s.done(); }
});

test('recorder: control characters and the usage widget never reach the file; each line is at most 200 characters', async () => {
  const s = scratch();
  try {
    const r = casos.createRecorder({ file: s.file, now: clock().now });
    const preview = ['Question\x1b[2J?', '→ Yes', 'No', 'y'.repeat(500), FOOTER, '5h 15% ↻lun 01:50 · 7d 37% ↻jue 11:00'].join('\n');
    r.record({ folder: 'f', handle: 'h1', state: 'asking', preview });
    await r.flush();
    const [row] = rows(s.file);
    assert.ok(row.screen.every((l) => l.length <= 200 && !/[\x00-\x1f\x7f-\x9f]/.test(l)));
    assert.ok(!row.screen.some((l) => /↻/.test(l)));
  } finally { s.done(); }
});

test('safety: the recorder and the new helper never send anything', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server', 'casos.js'), 'utf8');
  assert.ok(!/\b(orca|send)\b/i.test(src.replace(/\/\/.*$/gm, '')), 'casos.js has no send or orca call');
  assert.ok(!/send|orca|\\x1b/i.test(String(lib.piScreenTail)));
});
