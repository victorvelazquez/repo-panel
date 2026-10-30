'use strict';
// RP73 (S70), the parser: lib.piDialogChoices(screenText) reads the WHOLE screen of an asking session and returns the options a person
// could pick ({ fingerprint, options: [{ label, tone }], complete, markerRow, questionRows }) or null when the dialog is not one of the
// shapes the panel dares to answer. Pure: no Orca, no files, no clock. Fixtures follow the real screens measured in S70.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const lib = require('../lib.js');

const NAV = '↑↓ navigate  enter select  escape/ctrl+c cancel';
const SEP = '─'.repeat(30);
const WIDGET = `${' '.repeat(40)}5h 14% ↻11:20 · 7d 6% ↻jue 11:00`;
const TITLE = 'Allow guarded git push?';
const CMD = 'cd C:/proj && git add . && git commit -qm demo && git push -q origin demo-branch';

// The expected fingerprint, computed here from the spec and not through the code under test.
const fpOf = (questionRows, labels) => crypto.createHash('sha256').update(JSON.stringify([questionRows, labels])).digest('hex').slice(0, 16);

// A screen as rows. The marker sits on option `marker`; every other option row is indented two spaces under it.
function rows({ talk = [], question = [TITLE, CMD], labels = ['Yes', 'No'], marker = 0, pad = '', glyph = '→', footer = NAV, tail = [SEP, WIDGET] } = {}) {
  const opts = labels.map((l, i) => (i === marker ? `${pad}${glyph} ${l}` : `${pad}  ${l}`));
  return [...talk, ...question.map((q) => pad + q), ...opts, pad + footer, ...tail];
}
const text = (o) => rows(o).join('\n');
const parse = (o) => lib.piDialogChoices(text(o));
const labelsOf = (c) => c.options.map((x) => x.label);

test('piDialogChoices is exported', () => {
  assert.equal(typeof lib.piDialogChoices, 'function');
});

test('Yes/No: the full result, with the marker row counted in the rows of the screen', () => {
  const talk = ['some earlier conversation', '', 'more of it', ''];
  const got = lib.piDialogChoices(text({ talk }));
  assert.deepEqual(got, {
    fingerprint: fpOf([TITLE, CMD], ['Yes', 'No']),
    options: [{ label: 'Yes', tone: 'affirmative' }, { label: 'No', tone: 'negative' }],
    complete: true,
    markerRow: talk.length + 2,
    questionRows: [TITLE, CMD],
  });
});

test('Allow once / Allow for this session / Deny with the marker on the first row', () => {
  const got = parse({ question: ['Run a guarded command?'], labels: ['Allow once', 'Allow for this session', 'Deny'] });
  assert.deepEqual(got.options, [{ label: 'Allow once', tone: 'affirmative' }, { label: 'Allow for this session', tone: 'affirmative' }, { label: 'Deny', tone: 'negative' }]);
  assert.equal(got.complete, true);
  assert.equal(got.markerRow, 1);
});

// RP73 phase 2 (parent decision): the row of the previous option sits right above the marker, so by the literal rule it is a question row
// and questionRows grow by one. The step is verified by the BLOCK (question rows down to the footer, marker glyph neutralised), not by questionRows.
test('the marker on the second row gives a shorter list; the same block (the glyph aside), the fingerprint changes (documented)', () => {
  const labels = ['Allow once', 'Allow for this session', 'Always allow in this repo', 'Deny'];
  const first = parse({ labels, marker: 0 });
  const second = parse({ labels, marker: 1 });
  assert.deepEqual(labelsOf(second), labels.slice(1));
  assert.deepEqual(second.questionRows, [...first.questionRows, labels[0]], 'the option row above the marker reads as a question row');
  assert.equal(second.markerRow, first.markerRow + 1);
  assert.notEqual(second.fingerprint, first.fingerprint);
  assert.equal(second.fingerprint, fpOf(second.questionRows, labels.slice(1)));
  assert.equal(second.footerRow, first.footerRow);
  assert.equal(second.blockStart, first.blockStart);
  assert.deepEqual(second.block, first.block, 'the same block row by row, the marker glyph being neutralised');
  assert.equal(first.block[first.markerRow - first.blockStart], '  Allow once');
});

test('the marker on the last option leaves a single option: null by default, one option with allowSingle (and a label of 1 to 80 characters)', () => {
  assert.equal(parse({ labels: ['Yes', 'No'], marker: 1 }), null);
  const one = lib.piDialogChoices(text({ labels: ['Yes', 'No'], marker: 1 }), { allowSingle: true });
  assert.deepEqual(one.options, [{ label: 'No', tone: 'negative' }]);
  assert.equal(lib.piDialogChoices(text({ labels: ['Yes', 'a'.repeat(81)], marker: 1 }), { allowSingle: true }), null);
  assert.equal(parse({ labels: ['Yes', 'No'], marker: 1, tail: [] }), null);
  assert.equal(lib.piDialogChoices(text({ labels: ['Yes'] }), { allowSingle: true }).options.length, 1);
  assert.equal(lib.piDialogChoices(text({ labels: ['Yes'] }), { allowSingle: false }), null);
});

// ---------- piDialogMovedDown(first, now, steps = 1): the closed-loop check after each down arrow ----------
const FOURL = ['Allow once', 'Allow for this session', 'Always allow in this repo', 'Deny'];
const read = (o, allowSingle = true) => lib.piDialogChoices(text(o), { allowSingle });
const moved = (before, after, steps) => lib.piDialogMovedDown(read(before, false), read(after), steps);

test('piDialogMovedDown: moved exactly one row is true; the timer above and the widget below the dialog do not count', () => {
  assert.equal(typeof lib.piDialogMovedDown, 'function');
  assert.equal(moved({ labels: FOURL, marker: 0 }, { labels: FOURL, marker: 1 }), true);
  assert.equal(moved({ labels: FOURL, marker: 0 }, { labels: FOURL, marker: 1 }, 1), true);
  assert.equal(moved({ labels: FOURL, marker: 0 }, { labels: FOURL, marker: 3 }, 3), true, 'steps counts the arrows sent');
  const talk = ['earlier', 'elapsed 00:01', ''];
  const tail = [SEP, `${' '.repeat(40)}5h 14% ↻11:20 · 7d 6% ↻jue 11:00`, 'tokens 100'];
  assert.equal(moved({ talk, labels: FOURL, marker: 0, tail }, { talk: ['earlier', 'elapsed 00:02', ''], labels: FOURL, marker: 1, tail: [SEP, WIDGET, 'tokens 7000'] }), true);
});

test('piDialogMovedDown: moved two rows, did not move, or moved back is false', () => {
  assert.equal(moved({ labels: FOURL, marker: 0 }, { labels: FOURL, marker: 2 }), false);
  assert.equal(moved({ labels: FOURL, marker: 0 }, { labels: FOURL, marker: 0 }), false);
  assert.equal(moved({ labels: FOURL, marker: 1 }, { labels: FOURL, marker: 0 }), false);
  assert.equal(moved({ labels: FOURL, marker: 0 }, { labels: FOURL, marker: 1 }, 2), false, 'one arrow seen, two expected');
});

test('piDialogMovedDown: a changed question, footer row, label or option count is false', () => {
  const base = { labels: FOURL, marker: 0 };
  const after = { labels: FOURL, marker: 1 };
  assert.equal(moved(base, { ...after, question: [TITLE, CMD.replace('demo-branch', 'other-branch')] }), false, 'question text changed');
  assert.equal(moved(base, { ...after, question: ['Run another guarded command?', 'rm x'] }), false);
  assert.equal(moved(base, { ...after, question: [TITLE] }), false, 'a question row less moves the block');
  assert.equal(moved(base, { ...after, talk: ['one more row'] }), false, 'the dialog sits one row lower: a different footer row');
  assert.equal(moved(base, { ...after, labels: ['Allow once', 'Allow for this session', 'Always allow in this repo', 'Deny'].map((l, i) => (i === 2 ? 'Always allow everywhere' : l)) }), false, 'a label below the marker changed');
  assert.equal(moved(base, { ...after, labels: ['Allow one', ...FOURL.slice(1)] }), false, 'the label of the option the marker left changed');
  assert.equal(moved(base, { ...after, labels: FOURL.slice(0, 3) }), false, 'an option disappeared');
  assert.equal(moved(base, { ...after, footer: 'enter select  escape cancel' }), false, 'the footer row changed');
});

test('piDialogMovedDown: nulls and other values are false, never a throw', () => {
  const ok = read({ labels: FOURL, marker: 0 }, false);
  for (const bad of [null, undefined, {}, 5, 'x']) {
    assert.equal(lib.piDialogMovedDown(bad, ok), false);
    assert.equal(lib.piDialogMovedDown(ok, bad), false);
  }
});

test('piDialogMovedDown: the block of a 12-row question (the cap) is still compared over the rows of the first read', () => {
  const question = Array.from({ length: 12 }, (_, i) => `question row ${i}`);
  assert.equal(moved({ question, labels: FOURL, marker: 0 }, { question, labels: FOURL, marker: 1 }), true);
  const changed = question.map((q, i) => (i === 0 ? 'question row X' : q));
  assert.equal(moved({ question, labels: FOURL, marker: 0 }, { question: changed, labels: FOURL, marker: 1 }), false, 'the first row of the block changed');
});

test('the block and the extras are not enumerable: the result keeps its five keys and JSON does not carry them', () => {
  const got = parse({});
  assert.deepEqual(Object.keys(got), ['fingerprint', 'options', 'complete', 'markerRow', 'questionRows']);
  assert.equal(JSON.stringify(got).includes('block'), false);
  assert.equal(got.footerRow, 4);
});

test('a command cut by the terminal with an ellipsis is incomplete, with either spelling', () => {
  for (const cut of ['…', '...']) {
    const got = parse({ question: [TITLE, `cd C:/proj && git add . && git push -q origin demo-bra${cut}`] });
    assert.equal(got.complete, false, cut);
    assert.deepEqual(labelsOf(got), ['Yes', 'No']);
  }
});

test('a label that ends with an ellipsis also makes the question incomplete', () => {
  assert.equal(parse({ labels: ['Yes, and do not ask again for this very long comm…', 'No'] }).complete, false);
});

test('no question rows above the marker: still an object, never complete', () => {
  const got = parse({ question: [] });
  assert.equal(got.complete, false);
  assert.deepEqual(got.questionRows, []);
  assert.deepEqual(labelsOf(got), ['Yes', 'No']);
});

test('a command that wraps on three rows keeps all the question rows and is complete', () => {
  const question = [TITLE, 'git -C C:/proj push origin feature/rp73-answer', '--force-with-lease=feature/rp73-answer:abc1234', '&& git log --oneline -3 | head -n 3'];
  const got = parse({ question });
  assert.deepEqual(got.questionRows, question);
  assert.equal(got.complete, true);
});

test('only 12 question rows and 200 characters per row are kept', () => {
  const question = Array.from({ length: 15 }, (_, i) => `question row ${i}`);
  question[14] = 'z'.repeat(250);
  const got = parse({ question });
  assert.equal(got.questionRows.length, 12);
  assert.equal(got.questionRows[0], 'question row 3');
  assert.equal(got.questionRows[11], 'z'.repeat(200));
});

test('a description layout (title line and indented description line per option) is not recognised', () => {
  const screenRows = [TITLE, '→ Review this change', '    Look at the diff before anything is applied', '  Skip it', '    Leave the change for later', NAV, SEP, WIDGET];
  assert.equal(lib.piDialogChoices(screenRows.join('\n')), null);
});

test('between 2 and 8 options: 2 and 8 work, 1 and 9 are null', () => {
  const many = (n) => Array.from({ length: n }, (_, i) => `Option number ${i}`);
  assert.equal(parse({ labels: many(2) }).options.length, 2);
  assert.equal(parse({ labels: many(8) }).options.length, 8);
  assert.equal(parse({ labels: many(1) }), null);
  assert.equal(parse({ labels: many(9) }), null);
});

test('a blank row between options, or between the last option and the footer, is null', () => {
  assert.equal(lib.piDialogChoices([TITLE, '→ Yes', '', '  No', NAV].join('\n')), null);
  assert.equal(lib.piDialogChoices([TITLE, '→ Yes', '  No', '', NAV].join('\n')), null);
});

test('a label of 80 characters is fine, one of 81 is null', () => {
  assert.equal(parse({ labels: ['a'.repeat(80), 'No'] }).options[0].label, 'a'.repeat(80));
  assert.equal(parse({ labels: ['a'.repeat(81), 'No'] }), null);
});

test('control characters become spaces and never reach a label or a question row', () => {
  const got = lib.piDialogChoices([`${TITLE}\x1b[31m`, 'git\tpush\x07', '→ Al\tlow once\x00', '  Deny\r', NAV].join('\n'));
  assert.deepEqual(labelsOf(got), ['Al low once', 'Deny']);
  assert.deepEqual(got.questionRows, ['Allow guarded git push? [31m', 'git push']);
  for (const r of got.questionRows) assert.doesNotMatch(r, /[\x00-\x1f\x7f-\x9f]/);
});

test('rows after the footer are ignored: the separator, the usage widget and an arrow row below it', () => {
  const a = lib.piDialogChoices(text({ tail: [] }));
  const b = lib.piDialogChoices(text({ tail: [SEP, WIDGET, '', '→ something else', ''] }));
  assert.deepEqual(b, a);
  assert.equal(b.markerRow, 2);
});

test('the footer must be within the last 14 non-blank rows', () => {
  const junk = (n) => Array.from({ length: n }, (_, i) => `junk ${i}`);
  assert.notEqual(parse({ tail: junk(13) }), null);
  assert.equal(parse({ tail: junk(14) }), null);
});

test('no footer, or a footer without a marker row, is null', () => {
  assert.equal(lib.piDialogChoices([TITLE, '→ Yes', '  No', 'Something else entirely'].join('\n')), null);
  assert.equal(lib.piDialogChoices([TITLE, 'Yes', 'No', NAV].join('\n')), null);
  assert.equal(lib.piDialogChoices(''), null);
});

test('the marker is the LAST arrow row above the footer, and a quoted ">" row above it is only part of the question', () => {
  const got = lib.piDialogChoices(['> quoted by the session', TITLE, '→ Yes', '  No', NAV].join('\n'));
  assert.deepEqual(got.questionRows, [TITLE], 'the question starts at the title row: the quoted row above it is conversation');
  assert.deepEqual(labelsOf(got), ['Yes', 'No']);
});

test('the ">" marker works like the arrow', () => {
  const got = parse({ glyph: '>' });
  assert.deepEqual(labelsOf(got), ['Yes', 'No']);
  assert.equal(got.fingerprint, parse({}).fingerprint);
});

test('indentation variants give the same result as no indentation', () => {
  const base = parse({});
  for (const pad of ['  ', '    ', '\t']) {
    const got = parse({ pad });
    assert.deepEqual(got, base, JSON.stringify(pad));
  }
});

test('fingerprint: 16 hex characters, independent of the conversation above and of what is below the footer', () => {
  const a = parse({});
  assert.match(a.fingerprint, /^[0-9a-f]{16}$/);
  const b = parse({ talk: ['an earlier turn', 'and another', ''], tail: [] });
  assert.equal(b.fingerprint, a.fingerprint);
  assert.notEqual(b.markerRow, a.markerRow);
});

test('fingerprint: changes with one character of the command, with a label and with the title', () => {
  const base = parse({}).fingerprint;
  assert.notEqual(parse({ question: [TITLE, CMD.replace('demo-branch', 'demo-branci')] }).fingerprint, base);
  assert.notEqual(parse({ labels: ['Yes', 'Nope'] }).fingerprint, base);
  assert.notEqual(parse({ question: ['Allow guarded git pull?', CMD] }).fingerprint, base);
});

test('tone: negative words at the start of a label, with a word boundary', () => {
  const tone = (label) => parse({ labels: [label, 'Zzz something'] }).options[0].tone;
  for (const l of ['No', 'Deny', 'Cancel', 'Skip this time', 'Decline', 'Reject', 'Never', 'Stop', 'no', 'DENY']) assert.equal(tone(l), 'negative', l);
  for (const l of ['Yes', 'Allow once', 'Allow for this session', 'Review this change', 'Nope', 'Notify me', 'Cancelled by me']) assert.equal(tone(l), 'affirmative', l);
});

test('anything that is not a string is null', () => {
  for (const v of [undefined, null, 5, {}, [], true, Buffer.from('x')]) assert.equal(lib.piDialogChoices(v), null);
});

test('it is pure: the same screen gives equal results and nothing is shared between them', () => {
  const t = text({});
  const a = lib.piDialogChoices(t);
  const b = lib.piDialogChoices(t);
  assert.deepEqual(a, b);
  assert.notEqual(a.options, b.options);
  a.options.push({ label: 'x', tone: 'affirmative' });
  assert.equal(lib.piDialogChoices(t).options.length, 2);
});

// A tiny deterministic generator (mulberry32): the fuzz is the same on every machine and every run.
function prng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test('fuzz: 2000 random screens never throw; the result is null or has between 2 and 8 options and a 16-hex fingerprint', () => {
  const rnd = prng(73);
  const pick = (a) => a[Math.floor(rnd() * a.length)];
  const frags = ['→ Yes', '> No', '→ ', '>', '  No', '  Deny', '→ Allow once', TITLE, CMD, NAV, 'enter select', 'escape cancel', '…', '...', '', '', '   ', '\t', '\x1b[B', '\x00', 'x'.repeat(90), SEP, WIDGET, '→ Review', '    description', 'a'.repeat(81), '↑↓', '  '];
  let objects = 0;
  for (let n = 0; n < 2000; n++) {
    let s;
    if (rnd() < 0.4) {
      const labels = Array.from({ length: 1 + Math.floor(rnd() * 10) }, () => pick(['Yes', 'No', 'Deny', 'Allow once', 'a'.repeat(1 + Math.floor(rnd() * 90)), 'cut…', '', '  ']));
      const body = rows({ question: [pick(frags), pick(frags)], labels, marker: Math.floor(rnd() * labels.length), pad: pick(['', ' ', '\t']), glyph: pick(['→', '>']), tail: [pick(frags), pick(frags)] });
      if (rnd() < 0.3) body.splice(Math.floor(rnd() * body.length), 0, pick(frags));
      s = body.join(pick(['\n', '\n', '\r\n']));
    } else {
      s = Array.from({ length: Math.floor(rnd() * 40) }, () => pick(frags)).join(pick(['\n', '\n', '']));
    }
    let got;
    assert.doesNotThrow(() => { got = lib.piDialogChoices(s); }, JSON.stringify(s));
    if (got === null) continue;
    objects++;
    assert.equal(typeof got, 'object');
    assert.ok(got.options.length >= 2 && got.options.length <= 8, JSON.stringify(s));
    assert.match(got.fingerprint, /^[0-9a-f]{16}$/);
    for (const o of got.options) assert.ok(o.label.length >= 1 && o.label.length <= 80 && (o.tone === 'affirmative' || o.tone === 'negative'), JSON.stringify(o));
  }
  assert.ok(objects > 50, `the fuzz must reach the parsed branch (got ${objects})`);
});

// ---------- found by the parent reading the first implementation (hardening of "complete") ----------
test('a command cut on the LEFT (a leading ellipsis, as the real terminal does) or with an ellipsis in the middle is incomplete', () => {
  for (const cut of ['…r && echo l > l.txt && git add . && git push -q origin late-br', 'cd C:/proj && git add . && …push -q origin late-br && cd C:/x']) {
    assert.equal(parse({ question: [TITLE, cut] }).complete, false, cut);
  }
  assert.equal(parse({ question: [TITLE, '...cut on the left and nothing at the end'] }).complete, false, 'leading ASCII dots');
  // A few dots inside ordinary text are not a cut.
  assert.equal(parse({ question: [TITLE, 'echo "wait... what" && git status'] }).complete, true);
});

test('a question whose title is more than 8 rows above the marker cannot be seen whole: never complete', () => {
  const rowsOf = (n) => [TITLE, ...Array.from({ length: n - 1 }, (_, i) => `command part ${i}`)];
  assert.equal(parse({ question: rowsOf(9) }).complete, false);
  assert.equal(parse({ question: rowsOf(8) }).complete, true, 'a title exactly 8 rows above is still seen');
});

test('a long label that merely STARTS with a negative word is not a negative answer: it needs a complete question', () => {
  const tone = (label) => parse({ labels: [label, 'Zzz something'] }).options[0].tone;
  assert.equal(tone('Skip confirmation and run the command now'), 'affirmative');
  assert.equal(tone('Never ask again and allow every command'), 'affirmative');
  assert.equal(tone('No, and tell the agent why'), 'affirmative', 'only a plain refusal is negative: an explanation could hide anything');
  for (const l of ['No', 'Deny', 'Cancel', 'Skip this time', 'Decline', 'Reject', 'Never', 'Stop']) assert.equal(tone(l), 'negative', l);
});

// ---------- found with the REAL Orca (RP73 e2e): `read --screen` DROPS the blank rows ----------
// The conversation, the title and the command arrive as one run of rows, so a blank row can no longer tell where the question starts:
// it starts at the topmost row (within the 12 rows above the marker) that ends with '?'. No such row means the title is not visible.
const flat = (extra = {}) => lib.piDialogChoices([...Array.from({ length: 20 }, (_, i) => `conversation line ${i + 1} of an earlier answer`), TITLE, CMD, '→ Yes', '  No', NAV, ...(extra.below || [])].join('\n'));

test('real shape: no blank rows between the conversation and the dialog; the question starts at the title row', () => {
  const got = flat();
  assert.deepEqual(got.questionRows, [TITLE, CMD]);
  assert.equal(got.complete, true);
  assert.equal(got.fingerprint, fpOf([TITLE, CMD], ['Yes', 'No']));
});

test('real shape: a conversation row with an ellipsis above the title is not part of the question', () => {
  const got = lib.piDialogChoices([`${'x'.repeat(20)} thinking…`, ...Array.from({ length: 12 }, (_, i) => `more conversation ${i}`), TITLE, CMD, '→ Yes', '  No', NAV].join('\n'));
  assert.deepEqual(got.questionRows, [TITLE, CMD]);
  assert.equal(got.complete, true);
});

test('real shape: no row ending with a question mark within 12 rows above the marker means the title is not visible: not complete', () => {
  const got = lib.piDialogChoices([...Array.from({ length: 20 }, (_, i) => `conversation line ${i}`), 'cd C:/proj && git add . && git push -q origin demo-branch', '→ Yes', '  No', NAV].join('\n'));
  assert.equal(got.complete, false);
  assert.equal(got.questionRows.length, 12);
  assert.deepEqual(labelsOf(got), ['Yes', 'No']);
});

test('real shape: a command so long that the title is more than 12 rows above the marker is not complete', () => {
  const command = Array.from({ length: 13 }, (_, i) => `command part ${i}`);
  const got = lib.piDialogChoices([...Array.from({ length: 5 }, (_, i) => `conversation ${i}`), TITLE, ...command, '→ Yes', '  No', NAV].join('\n'));
  assert.equal(got.complete, false);
  const ok = lib.piDialogChoices([TITLE, ...command.slice(0, 7), '→ Yes', '  No', NAV].join('\n'));
  assert.equal(ok.complete, true, 'the title 8 rows above is still seen');
});

test('real shape: the topmost question-mark row wins, so a question mark inside a long command never hides the title', () => {
  const got = lib.piDialogChoices([TITLE, 'node -e "x ? 1 : 2; console.log(a?)"', 'continues here', '→ Yes', '  No', NAV].join('\n'));
  assert.deepEqual(got.questionRows, [TITLE, 'node -e "x ? 1 : 2; console.log(a?)"', 'continues here']);
  assert.equal(got.complete, true);
});

test('real shape: moving down one row keeps the same block (movedDown) when the rows have no blank row either', () => {
  const screen = (marker) => [...Array.from({ length: 20 }, (_, i) => `conversation line ${i + 1}`), TITLE, CMD, marker === 0 ? '→ Yes' : '  Yes', marker === 1 ? '→ No' : '  No', NAV].join('\n');
  const a = lib.piDialogChoices(screen(0));
  const b = lib.piDialogChoices(screen(1), { allowSingle: true });
  assert.equal(lib.piDialogMovedDown(a, b, 1), true);
  assert.equal(lib.piDialogMovedDown(a, a, 1), false);
});

// ---------- hardening after the independent verification of RP73 ----------
const NAV2 = '↑↓ navigate  enter select  escape/ctrl+c cancel';
const toneOf = (l) => lib.piDialogChoices(['Allow guarded git push?', 'git push -q origin demo', `→ ${l}`, '  Other', NAV2].join('\n')).options[0].tone;

test('tone: only a short, plain refusal is negative; anything that could also approve is affirmative (needs a whole question)', () => {
  for (const l of ['No', 'Deny', 'Cancel', 'Skip', 'Skip this time', 'Deny once', 'Decline', 'Reject', 'Never', 'Stop', 'no.', 'DENY']) assert.equal(toneOf(l), 'negative', l);
  for (const l of ['No, and tell the agent what to do differently instead', 'Skip confirmation and run it', 'No problem, go ahead', 'Stop asking me and do it',
    'Cancel and push', 'Skip all permission checks', 'No, allow once', 'Never ask again', 'Deny and allow the next one']) assert.equal(toneOf(l), 'affirmative', l);
});

test('complete: a title row must be near the marker (8 rows), and a cut row anywhere in the 12 rows above counts, title or not', () => {
  const start = lib.piDialogChoices(['…', 'x = 1?', 'y', '→ Yes', '  No', NAV2].join('\n'));
  assert.equal(start.complete, false, 'a screen that starts mid-dialog with an ellipsis row above the first question mark');
  const far = (n) => lib.piDialogChoices([TITLE, ...Array.from({ length: n }, (_, i) => `command part ${i}`), '→ Yes', '  No', NAV2].join('\n'));
  assert.equal(far(7).complete, true, 'title 8 rows above the marker');
  assert.equal(far(8).complete, false, 'title 9 rows above the marker');
  const above = lib.piDialogChoices(['conversation…', TITLE, 'git push -q origin demo', '→ Yes', '  No', NAV2].join('\n'));
  assert.equal(above.complete, false, 'an ellipsis row inside the 12 rows above the marker, even above the title, makes the question not complete');
});

test('invisible and bidirectional control marks never reach a label or a question row', () => {
  const got = lib.piDialogChoices(['Allow guarded git push?', 'git push -q origin demo', '→ Ye\u202es', '  N\u200bo', NAV2].join('\n'));
  assert.deepEqual(labelsOf(got), ['Yes', 'No']);
  assert.equal(got.fingerprint, fpOf(['Allow guarded git push?', 'git push -q origin demo'], ['Yes', 'No']));
});
