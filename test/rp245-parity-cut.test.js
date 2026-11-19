'use strict';
// RP245 (part 1 of the parity with the terminal, decided by the person): a permission or a question card can be answered with all its options even when the text is
// cut (an ellipsis at the end or at the start, or cut by the server) or has hidden characters, as in the terminal, which shows the same preview. The card says so with a
// note and still shows hidden characters as markers. askAllowed keeps telling whether the text is whole and visible: it now only decides the note.
const test = require('node:test');
const assert = require('node:assert/strict');
const R = require('../public/resumen.js');

const NOTE = 'The text is cut or has hidden characters: it is the same preview the terminal shows';
const confirm = (over = {}) => ({ requestId: 'd1', method: 'confirm', title: 'Allow guarded command?', message: 'rm -rf build', options: [], expiresAt: null, truncated: false, ...over });
const select = (over = {}) => ({ requestId: 'd2', method: 'select', title: 'Allow guarded git push?\ngit push origin HEAD', message: '', options: ['Allow once', 'Allow for this session', 'Always allow git push', 'Deny'], expiresAt: null, truncated: false, ...over });
const labels = (html) => [...html.matchAll(/<button[^>]*data-kind="(\w+)"[^>]*>([^<]*)</g)].map((m) => m[2]);

const CUT_TEXTS = ['rm -rf /c/Users/x/AppData/Local/Temp/a /c/Users/x/AppData/Local/Temp/b\u2026', '\u2026 && git branch -D old-branch', 'ls \u200bfoo', 'git push origin ...', '   ', ''];

test('a cut, hidden or empty confirm offers Deny and Allow, with the note', () => {
  for (const message of CUT_TEXTS) {
    const html = R.askCard(confirm({ message }), 'abc', false);
    assert.deepEqual(labels(html), ['Deny', 'Allow'], JSON.stringify(message));
    assert.ok(html.includes(NOTE), JSON.stringify(message));
  }
  const html = R.askCard(confirm({ truncated: true }), 'abc', false);
  assert.deepEqual(labels(html), ['Deny', 'Allow']);
  assert.ok(html.includes(NOTE));
});

test('a cut or hidden Allow select offers every option in its order, with the note', () => {
  for (const cmd of ['git push origin HEAD \u2026', '\u2026cd /a/very/long/path && git push origin HEAD', 'git push\u200b origin HEAD']) {
    const html = R.askCard(select({ title: `Allow guarded git push?\n${cmd}` }), 'abc', false);
    assert.deepEqual(labels(html), ['Allow once', 'Allow for this session', 'Always allow git push', 'Deny', 'Cancel'], cmd);
    assert.ok(html.includes(NOTE), cmd);
  }
  const truncated = R.askCard(select({ truncated: true }), 'abc', false);
  assert.deepEqual(labels(truncated), ['Allow once', 'Allow for this session', 'Always allow git push', 'Deny', 'Cancel']);
  assert.ok(truncated.includes(NOTE));
});

test('hidden characters are still shown as markers, never rendered, and the option keeps its place', () => {
  const html = R.askCard(select({ title: 'Pick\u202e one', options: ['Y\u200bes', 'No'] }), 'abc', false);
  assert.equal(/[\u202e\u200b]/.test(html), false);
  assert.match(html, /\u27e6U\+202E\u27e7/);
  assert.deepEqual(labels(html), ['Y\u27e6U+200B\u27e7es', 'No', 'Cancel']);
  assert.ok(html.includes(NOTE));
});

test('a whole, visible text has no note, and askAllowed still tells whether the text is whole', () => {
  assert.equal(R.askCard(confirm(), 'abc', false).includes(NOTE), false);
  assert.equal(R.askCard(select(), 'abc', false).includes(NOTE), false);
  assert.equal(R.askAllowed(confirm()), true);
  for (const message of CUT_TEXTS) assert.equal(R.askAllowed(confirm({ message })), false, JSON.stringify(message));
});

// Found by the independent verification: an option the server cut (a truncated select, an option exactly at the 200-character cap) cannot be answered (the session
// expects the whole text), so it is drawn disabled with the reason instead of failing with a bare «Invalid answer».
test('an option the server cut is drawn disabled with the reason; the other options stay usable', () => {
  const html = R.askCard(select({ title: 'Pick one', truncated: true, options: ['A'.repeat(200), 'No'] }), 'abc', false);
  assert.match(html, /<button[^>]*data-kind="option" data-index="0"[^>]*title="This option is cut: answer it in the terminal"[^>]*disabled/);
  assert.doesNotMatch(html, /<button[^>]*data-index="1"[^>]*disabled/);
  const whole = R.askCard(select({ title: 'Pick one', truncated: false, options: ['A'.repeat(200), 'No'] }), 'abc', false);
  assert.doesNotMatch(whole, /disabled/, 'an option of exactly 200 characters in a dialog that was not cut is a normal option');
});

test('everything new on the card stays escaped', () => {
  for (const evil of ['<img src=x onerror=alert(1)>', '</pre><script>x</script>', '"><svg onload=1>', 'a‮b', 'c⁦d']) {
    for (const d of [confirm({ message: evil }), select({ title: `Allow guarded git push?\n${evil}` }), select({ title: 'Pick', options: [evil, 'No'], truncated: true })]) {
      assert.doesNotMatch(R.askCard(d, 'abc', false), /<img|<script|<svg|[‮⁦]/, evil);
    }
  }
});

test('the note never names the runtime (wording rule)', () => {
  assert.doesNotMatch(NOTE, /\bpi\b|Gentle Shell/);
});
