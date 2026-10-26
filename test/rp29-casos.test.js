'use strict';
// RP29: a passive recorder of question-like pi screens the panel does not recognise. It only observes: nothing the
// user sees changes, and nothing is ever answered. These tests never install the real recorder or touch .panel/.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const lib = require('../lib.js');
const pi = require('../server/pi.js');
const casos = require('../server/casos.js');

const lf = (text) => text.replace(/\r\n/g, '\n');
const ROOT = path.join(__dirname, '..');

// Sample 1: the RP20 dialog. Sample 2: the permission dialog the panel does not recognise.
const DIALOG = [
  'rdd running · start',
  '',
  'Review consent',
  'Gentle AI can review this change before you call it done.',
  '→ 1. Review this change',
  '  2. Skip this time',
  '',
  '↑↓ choose · Enter confirm · Esc cancel · D details',
  '',
].join('\n');
const screen2 = (timer = '18m55s') => [
  '❀ Agents  1 waiting',
  `? gentle-ai-worker  asked: Allow guarded git push?            claude-sonnet-5-5 · medium · 3.8M · ${timer}`,
  '──────────────────────────────────────────────────────────────',
  '❀ Allow guarded git push?',
  "…r && echo l > l.txt && git add . && git commit -qm l && git push -q -u origin late-br && cd $SC && node - <<'EOF' const fs = require('fs'); let s = fs.readFileSync('diff.js','ut…",
  '',
  '→ Yes',
  '  No',
  '',
  '↑↓ navigate  enter select  escape/ctrl+c cancel',
  '',
].join('\n');
const SAMPLE2 = screen2();
const IDLE = '▎ ✿ waiting for input\n▎   type, or / for commands\n▎\n5h 27% ↻14:10 · 7d 31% ↻jue 11:00\n';
const WORKING = '$ sleep 20\nElapsed 7.2s\n▎ ❁ working…\n▎   type, or / for commands\n▎\n';

// ---------- A. piScreenQuestionish ----------
test('piScreenQuestionish: sample 1 (the RP20 dialog) carries the footer signal', () => {
  const q = lib.piScreenQuestionish(DIALOG);
  assert.deepEqual(q.signals, ['footer']);
  assert.ok(q.lines.includes('↑↓ choose · Enter confirm · Esc cancel · D details'));
});

test('piScreenQuestionish: sample 2 carries footer, agents-waiting and asked, with its lines', () => {
  const q = lib.piScreenQuestionish(SAMPLE2);
  assert.deepEqual(q.signals, ['footer', 'agents-waiting', 'asked']);
  assert.ok(q.lines.length <= 14);
  assert.ok(q.lines.includes('❀ Allow guarded git push?'));
  assert.ok(q.lines.includes('↑↓ navigate  enter select  escape/ctrl+c cancel'));
  assert.ok(q.lines.every((l) => l.length <= 200 && l === l.trim() && l !== ''));
});

test('piScreenQuestionish: each signal alone is enough', () => {
  assert.deepEqual(lib.piScreenQuestionish('Agents 3 waiting').signals, ['agents-waiting']);
  assert.deepEqual(lib.piScreenQuestionish('Agent 1 waiting').signals, ['agents-waiting']);
  assert.deepEqual(lib.piScreenQuestionish('bot asked: may I?').signals, ['asked']);
  assert.deepEqual(lib.piScreenQuestionish('Press Return to submit').signals, ['footer']);
  assert.deepEqual(lib.piScreenQuestionish('ESC to cancel').signals, ['footer']);
  assert.deepEqual(lib.piScreenQuestionish('ctrl+c cancel').signals, ['footer']);
});

test('piScreenQuestionish: the key word and the action word must share ONE line', () => {
  assert.equal(lib.piScreenQuestionish('press enter\nthen confirm'), null);
  assert.equal(lib.piScreenQuestionish('Agents waiting'), null);
});

test('piScreenQuestionish: idle, working, usage bars, empty and non-strings are not question-like', () => {
  assert.equal(lib.piScreenQuestionish(IDLE), null);
  assert.equal(lib.piScreenQuestionish(WORKING), null);
  assert.equal(lib.piScreenQuestionish('5h 27% ↻14:10 · 7d 31% ↻jue 11:00'), null);
  assert.equal(lib.piScreenQuestionish('▎ ✿ waiting for input'), null);
  assert.equal(lib.piScreenQuestionish('▎   type, or / for commands'), null);
  assert.equal(lib.piScreenQuestionish('▎ ✿ working…'), null);
  for (const v of ['', '  \n\n', null, undefined, 7, {}, [DIALOG]]) assert.equal(lib.piScreenQuestionish(v), null, String(v));
});

test('piScreenQuestionish: only the last 14 non-empty lines count', () => {
  const later = Array.from({ length: 14 }, (_, i) => `output ${i}`).join('\n');
  assert.equal(lib.piScreenQuestionish(`${SAMPLE2}\n${later}`), null);
  assert.ok(lib.piScreenQuestionish(`${SAMPLE2}\n${later.split('\n').slice(0, 3).join('\n')}`));
});

test('piScreenQuestionish: control characters become a space and lines are capped at 200', () => {
  const q = lib.piScreenQuestionish(`ab\u001b[31mcd\u0007 asked: ${'x'.repeat(400)}`);
  assert.equal(q.lines.length, 1);
  assert.equal(q.lines[0].length, 200);
  assert.doesNotMatch(q.lines[0], /[\x00-\x1f\x7f-\x9f]/);
  assert.match(q.lines[0], /^ab \[31mcd/);
});

test('PRESERVE piScreenAsk / piScreenState: sample 2 is still not recognised and the old results hold', () => {
  assert.equal(lib.piScreenAsk(SAMPLE2), null);
  assert.equal(lib.piScreenState(SAMPLE2), null);
  assert.ok(lib.piScreenAsk(DIALOG));
  assert.equal(lib.piScreenState(IDLE), 'idle');
  assert.equal(lib.piScreenState(WORKING), 'busy');
});

// ---------- B. createRecorder ----------
function scratch() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rp29-'));
  return { dir, file: path.join(dir, 'sub', 'casos.jsonl'), done: () => fs.rmSync(dir, { recursive: true, force: true }) };
}
const clock = (start = Date.UTC(2026, 9, 25, 12, 0, 0)) => { const c = { t: start, now: () => c.t }; return c; };
const rows = (file) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const quiet = () => { const calls = []; const orig = { log: console.log, warn: console.warn, error: console.error }; console.log = console.warn = console.error = (...a) => calls.push(a.join(' ')); return { calls, restore: () => Object.assign(console, orig) }; };

test('recorder: one JSON line with at, folder, handle, state, recognized, signals and lines; creates the folder', async () => {
  const s = scratch();
  try {
    const c = clock();
    const r = casos.createRecorder({ file: s.file, now: c.now });
    assert.equal(r.record({ folder: 'C:/repo', handle: 'h1', state: null, preview: SAMPLE2 }), undefined);
    await r.flush();
    const [row, ...more] = rows(s.file);
    assert.equal(more.length, 0);
    assert.deepEqual(Object.keys(row), ['at', 'folder', 'handle', 'state', 'recognized', 'signals', 'lines']);
    assert.equal(row.at, '2026-10-25T12:00:00.000Z');
    assert.equal(row.folder, 'C:/repo');
    assert.equal(row.handle, 'h1');
    assert.equal(row.state, null);
    assert.equal(row.recognized, false);
    assert.deepEqual(row.signals, ['footer', 'agents-waiting', 'asked']);
    assert.deepEqual(row.lines, lib.piScreenQuestionish(SAMPLE2).lines);
  } finally { s.done(); }
});

test('recorder: a screen the panel already recognises is recorded with recognized true', async () => {
  const s = scratch();
  try {
    const r = casos.createRecorder({ file: s.file, now: clock().now });
    r.record({ folder: 'f', handle: 'h1', state: 'asking', preview: DIALOG });
    await r.flush();
    assert.equal(rows(s.file)[0].recognized, true);
    assert.equal(rows(s.file)[0].state, 'asking');
  } finally { s.done(); }
});

test('recorder: screens that are not question-like write nothing, not even the file', async () => {
  const s = scratch();
  try {
    const r = casos.createRecorder({ file: s.file, now: clock().now });
    for (const preview of [IDLE, WORKING, '', null, undefined, 5]) r.record({ folder: 'f', handle: 'h1', state: 'idle', preview });
    await r.flush();
    assert.equal(fs.existsSync(s.file), false);
  } finally { s.done(); }
});

test('rule 1: the same question with a changed timer or digits is recorded once per handle', async () => {
  const s = scratch();
  try {
    const c = clock();
    const r = casos.createRecorder({ file: s.file, now: c.now, minGapMs: 1000 });
    r.record({ folder: 'f', handle: 'h1', state: null, preview: screen2('18m55s') });
    c.t += 5000;
    r.record({ folder: 'f', handle: 'h1', state: null, preview: screen2('19m01s') });
    c.t += 5000;
    r.record({ folder: 'f', handle: 'h1', state: null, preview: screen2('19m11s') });
    await r.flush();
    assert.equal(rows(s.file).length, 1);
  } finally { s.done(); }
});

test('rule 1: leaving the question clears the memory, so the same question later is recorded again', async () => {
  const s = scratch();
  try {
    const c = clock();
    const r = casos.createRecorder({ file: s.file, now: c.now, minGapMs: 1000 });
    r.record({ folder: 'f', handle: 'h1', state: null, preview: SAMPLE2 });
    c.t += 2000;
    r.record({ folder: 'f', handle: 'h1', state: 'idle', preview: IDLE });
    c.t += 2000;
    r.record({ folder: 'f', handle: 'h1', state: null, preview: SAMPLE2 });
    await r.flush();
    assert.equal(rows(s.file).length, 2);
  } finally { s.done(); }
});

test('rule 1: the memory is per handle', async () => {
  const s = scratch();
  try {
    const r = casos.createRecorder({ file: s.file, now: clock().now });
    r.record({ folder: 'f', handle: 'h1', state: null, preview: SAMPLE2 });
    r.record({ folder: 'f', handle: 'h2', state: null, preview: SAMPLE2 });
    r.record({ folder: 'f', handle: 'h2', state: null, preview: SAMPLE2 });
    await r.flush();
    assert.deepEqual(rows(s.file).map((x) => x.handle), ['h1', 'h2']);
  } finally { s.done(); }
});

test('rule 2: a different text inside the min gap is not recorded; once the gap passes it is', async () => {
  const s = scratch();
  try {
    const c = clock();
    const r = casos.createRecorder({ file: s.file, now: c.now, minGapMs: 30000 });
    const other = SAMPLE2.replace('Allow guarded git push?', 'Delete everything?');
    r.record({ folder: 'f', handle: 'h1', state: null, preview: SAMPLE2 });
    c.t += 10000;
    r.record({ folder: 'f', handle: 'h1', state: null, preview: other });
    await r.flush();
    assert.equal(rows(s.file).length, 1);
    c.t += 25000;
    r.record({ folder: 'f', handle: 'h1', state: null, preview: other });
    await r.flush();
    assert.equal(rows(s.file).length, 2);
    assert.match(rows(s.file)[1].lines.join('\n'), /Delete everything/);
  } finally { s.done(); }
});

test('rule 2: the default gap is 30 s, also across leaving and re-entering the question', async () => {
  const s = scratch();
  try {
    const c = clock();
    const r = casos.createRecorder({ file: s.file, now: c.now });
    r.record({ folder: 'f', handle: 'h1', state: null, preview: SAMPLE2 });
    c.t += 1000;
    r.record({ folder: 'f', handle: 'h1', state: 'idle', preview: IDLE });
    c.t += 1000;
    r.record({ folder: 'f', handle: 'h1', state: null, preview: SAMPLE2 });
    await r.flush();
    assert.equal(rows(s.file).length, 1);
    c.t += 30000;
    r.record({ folder: 'f', handle: 'h1', state: null, preview: SAMPLE2 });
    await r.flush();
    assert.equal(rows(s.file).length, 2);
  } finally { s.done(); }
});

test('rule 3: a file bigger than maxBytes gets nothing more and the console says so ONCE', async () => {
  const s = scratch();
  const out = quiet();
  try {
    fs.mkdirSync(path.dirname(s.file), { recursive: true });
    fs.writeFileSync(s.file, 'x'.repeat(500));
    const c = clock();
    const r = casos.createRecorder({ file: s.file, now: c.now, minGapMs: 0, maxBytes: 100 });
    for (let i = 0; i < 3; i++) { r.record({ folder: 'f', handle: `h${i}`, state: null, preview: SAMPLE2 }); await r.flush(); c.t += 1000; }
    out.restore();
    assert.equal(fs.readFileSync(s.file, 'utf8'), 'x'.repeat(500));
    assert.equal(out.calls.filter((m) => /casos|cases|full|limit/i.test(m)).length, 1);
    assert.equal(out.calls.length, 1);
  } finally { out.restore(); s.done(); }
});

test('rule 3: the default cap is 1 MiB (bigger is refused, exactly that size is not)', async () => {
  const s = scratch();
  const out = quiet();
  try {
    fs.mkdirSync(path.dirname(s.file), { recursive: true });
    fs.writeFileSync(s.file, 'x'.repeat(1024 * 1024 + 1));
    const r = casos.createRecorder({ file: s.file, now: clock().now });
    r.record({ folder: 'f', handle: 'h1', state: null, preview: SAMPLE2 });
    await r.flush();
    assert.equal(fs.statSync(s.file).size, 1024 * 1024 + 1);
    fs.writeFileSync(s.file, 'x'.repeat(1024 * 1024));
    r.record({ folder: 'f', handle: 'h2', state: null, preview: SAMPLE2 });
    await r.flush();
    assert.ok(fs.statSync(s.file).size > 1024 * 1024);
  } finally { out.restore(); s.done(); }
});

test('rule 4: it never throws, whatever fs or the input does, and warns at most once per minute', async () => {
  const out = quiet();
  try {
    const c = clock();
    const boom = async () => { throw new Error('disk on fire'); };
    const r = casos.createRecorder({ file: 'ignored', fs: { mkdir: boom, stat: boom, appendFile: boom }, now: c.now, minGapMs: 0 });
    const bad = [undefined, null, 5, 'x', {}, { handle: {}, preview: SAMPLE2 }, { folder: 1, handle: 1, preview: Symbol.iterator }];
    for (const b of bad) assert.doesNotThrow(() => r.record(b));
    for (let i = 0; i < 5; i++) { assert.doesNotThrow(() => r.record({ folder: 'f', handle: `h${i}`, state: null, preview: SAMPLE2 })); c.t += 1000; }
    await r.flush();
    assert.equal(out.calls.length, 1);
    c.t += 61000;
    r.record({ folder: 'f', handle: 'late', state: null, preview: SAMPLE2 });
    await r.flush();
    assert.equal(out.calls.length, 2);
  } finally { out.restore(); }
});

test('rule 4: record returns at once (it does not wait for the write)', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const slow = { mkdir: async () => gate, stat: async () => ({ size: 0 }), appendFile: async () => {} };
  const r = casos.createRecorder({ file: 'x', fs: slow, now: clock().now });
  const ret = r.record({ folder: 'f', handle: 'h', state: null, preview: SAMPLE2 });
  assert.equal(ret, undefined);
  release();
  await r.flush();
});

test('casesFile: REPO_PANEL_CASES_FILE wins, empty or off disables, default is <root>/.panel/casos-preguntas.jsonl', () => {
  assert.equal(casos.casesFile({}, 'R'), path.join('R', '.panel', 'casos-preguntas.jsonl'));
  assert.equal(casos.casesFile({ REPO_PANEL_CASES_FILE: 'X/y.jsonl' }, 'R'), 'X/y.jsonl');
  assert.equal(casos.casesFile({ REPO_PANEL_CASES_FILE: '' }, 'R'), null);
  assert.equal(casos.casesFile({ REPO_PANEL_CASES_FILE: 'off' }, 'R'), null);
  assert.equal(casos.casesFile({ REPO_PANEL_CASES_FILE: 'OFF' }, 'R'), null);
});

// ---------- C. wiring ----------
const T = (handle) => ({ handle, connected: true, writable: true, orphaned: false, worktreePath: 'C:/r' });
const fakeOrca = (screens) => async (args) => {
  if (args[0] === 'list') return { terminals: Object.keys(screens).map(T) };
  if (args[0] === 'show') { const h = args[2]; if (screens[h] instanceof Error) throw screens[h]; return { terminal: { preview: screens[h] } }; }
  throw new Error(`unexpected orca ${args.join(' ')}`);
};

test('wiring: nothing is installed by default and requiring pi.js, http.js or server.js installs nothing', () => {
  require('../server/http.js');
  require('../server.js');
  assert.equal(pi.caseRecorderInstalled(), false);
  pi.setCaseRecorder(() => {});
  assert.equal(pi.caseRecorderInstalled(), true);
  pi.setCaseRecorder(null);
  assert.equal(pi.caseRecorderInstalled(), false);
});

test('wiring: only the require.main block of server.js installs the real recorder', () => {
  const src = lf(fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8'));
  const block = /if \(require\.main === module\) \{[\s\S]*?\n\}\n/.exec(src)[0];
  assert.match(block, /setCaseRecorder\(/);
  assert.match(block, /REPO_PANEL_CASES_FILE|casesFile\(/);
  assert.equal(src.replace(block, '').includes('setCaseRecorder('), false);
  for (const f of ['server/pi.js', 'server/http.js', 'server/rooms.js', 'lib.js']) {
    assert.doesNotMatch(lf(fs.readFileSync(path.join(ROOT, f), 'utf8')), /createRecorder\(/, f);
  }
});

test('wiring: scanSessions hands every terminal it looked at to the recorder and its result does not change', async () => {
  const screens = { a: IDLE, b: SAMPLE2, c: DIALOG, d: new Error('gone') };
  const orca = fakeOrca(screens);
  const before = await pi.scanSessions('C:/r', orca, undefined, true, true);
  const seen = [];
  pi.setCaseRecorder((x) => seen.push(x));
  try {
    const after = await pi.scanSessions('C:/r', orca, undefined, true, true);
    assert.deepEqual(after, before);
    const by = Object.fromEntries(seen.map((x) => [x.handle, x]));
    assert.deepEqual(Object.keys(by).sort(), ['a', 'b', 'c']);
    assert.deepEqual(by.b, { folder: 'C:/r', handle: 'b', state: null, preview: SAMPLE2 });
    assert.equal(by.a.state, 'idle');
    assert.equal(by.c.state, 'asking');
  } finally { pi.setCaseRecorder(null); }
});

test('wiring: a recorder that throws or returns a rejected promise changes nothing', async () => {
  const orca = fakeOrca({ a: IDLE, b: SAMPLE2 });
  const base = await pi.piStatus({ path: 'C:/r' }, orca, { tail: true });
  for (const bad of [() => { throw new Error('x'); }, async () => { throw new Error('y'); }]) {
    pi.setCaseRecorder(bad);
    try { assert.deepEqual(await pi.piStatus({ path: 'C:/r' }, orca, { tail: true }), base); } finally { pi.setCaseRecorder(null); }
  }
});

test('PRESERVE piStatus: same answers with and without a recorder for idle, busy, asking and unknown screens', async () => {
  const cases = [{ a: IDLE }, { a: WORKING }, { a: DIALOG }, { a: SAMPLE2 }, { a: IDLE, b: IDLE }, { a: new Error('x') }, {}];
  for (const screens of cases) {
    const orca = fakeOrca(screens);
    const plain = [await pi.piStatus({ path: 'C:/r' }, orca), await pi.piStatus({ path: 'C:/r' }, orca, { tail: true })];
    pi.setCaseRecorder(() => {});
    try {
      assert.deepEqual([await pi.piStatus({ path: 'C:/r' }, orca), await pi.piStatus({ path: 'C:/r' }, orca, { tail: true })], plain);
    } finally { pi.setCaseRecorder(null); }
  }
  assert.deepEqual(await pi.piStatus({ path: 'C:/r' }, fakeOrca({ a: SAMPLE2 })), { state: 'closed' });
});

test('wiring: end to end through piStatus, the real recorder writes ONE record for repeated polls', async () => {
  const s = scratch();
  try {
    const r = casos.createRecorder({ file: s.file, now: clock().now });
    pi.setCaseRecorder(r.record);
    try {
      for (const timer of ['18m55s', '19m01s', '19m11s']) await pi.piStatus({ path: 'C:/r' }, fakeOrca({ a: screen2(timer) }));
      await r.flush();
    } finally { pi.setCaseRecorder(null); }
    const got = rows(s.file);
    assert.equal(got.length, 1);
    assert.equal(got[0].folder, 'C:/r');
    assert.equal(got[0].handle, 'a');
    assert.equal(got[0].recognized, false);
  } finally { s.done(); }
});

// The Claude usage widget under the pi screen (`5h 15% ↻lun 01:50 · 7d 37% ↻jue 11:00`) says nothing about a question
// and holds the user's consumption: it is never kept in the recorded lines and never takes one of the 14 slots.
const WIDGETS = ['5h 15% ↻lun 01:50 · 7d 37% ↻jue 11:00', '5h 27% ↻14:10 · 7d 31% ↻jue 11:00'];
const QUESTION = ['❀ Allow guarded git push?', '', '→ Yes', '  No', '', '↑↓ navigate  enter select  escape/ctrl+c cancel'];

test('piScreenQuestionish: the usage widget is left out of the recorded lines', () => {
  for (const w of WIDGETS) {
    const q = lib.piScreenQuestionish([...QUESTION, w].join('\n'));
    assert.ok(q, 'the question is still recognised');
    assert.ok(q.signals.includes('footer'));
    assert.ok(!q.lines.some((l) => /↻/.test(l)), `no usage widget line in ${JSON.stringify(q.lines)}`);
    assert.ok(q.lines.includes('↑↓ navigate  enter select  escape/ctrl+c cancel'));
  }
});

test('piScreenQuestionish: the usage widget does not use up one of the 14 lines', () => {
  const many = Array.from({ length: 13 }, (_, i) => `line ${i + 1}`);
  const q = lib.piScreenQuestionish([...many, '↑↓ navigate  enter select  escape/ctrl+c cancel', WIDGETS[0]].join('\n'));
  assert.equal(q.lines.length, 14, 'fourteen real lines');
  assert.equal(q.lines[0], 'line 1');
});

test('piScreenQuestionish: a screen with only the usage widget is not a question', () => {
  for (const w of WIDGETS) assert.equal(lib.piScreenQuestionish(`▎ ✿ waiting for input\n▎   type, or / for commands\n▎\n${w}`), null);
});
