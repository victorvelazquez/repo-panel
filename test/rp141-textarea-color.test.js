'use strict';
// RP141 (S29): the text of the Notes was dark on a dark box. The base rule of the stylesheet gives `color: var(--text)` to `button, select, input` but not to `textarea`, so a textarea that sets no
// colour of its own (the Notes box, and the editor field of a question of the session) falls back to the browser's black. One base rule for every textarea fixes the class, not the one box; it sets
// ONLY the colour (no background, border or padding, which each box already decides). Plain CSS cannot be run here: how it LOOKS was measured in the real panel (computed colour of the Notes box)
// and is for the person to try; these tests pin the rule, that the boxes do not undo it and that the colours it joins are readable (WCAG AA, 4.5:1).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'style.css'), 'utf8').replace(/\r\n/g, '\n');
// The declarations of the TOP-LEVEL rules whose selector is exactly `sel` (the ones inside @media and @container are indented, so they never match).
function decls(sel) {
  const esc = sel.replace(/[.*+?^${}()|[\]\\#]/g, '\\$&');
  return [...css.matchAll(new RegExp(`(?:^|\\n)${esc} \\{([^}]*)\\}`, 'g'))].map((m) => m[1]);
}
const token = (name) => {
  const m = new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{6})`).exec(css);
  assert.ok(m, `--${name} is a hex colour of :root`);
  return m[1];
};
const lum = (hex) => {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
};
const contrast = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };

test('t1: every textarea gets the colour of the page text from ONE base rule, and that rule sets nothing else', () => {
  const d = decls('textarea');
  assert.equal(d.length, 1, 'one base rule for textarea');
  assert.match(d[0], /color:\s*var\(--text\)/);
  assert.doesNotMatch(d[0], /background|border|padding|font|width|height|resize/, 'only the colour: each box keeps deciding its own look');
});

test('t2: the base rule that already covers the other fields is as it was', () => {
  const d = decls('button, select, input');
  assert.equal(d.length, 1);
  assert.match(d[0], /color:\s*var\(--text\)/);
  assert.match(d[0], /background:\s*var\(--panel2\)/);
  assert.match(d[0], /border:\s*1px solid var\(--line\)/);
});

test('t3: the Notes box and the editor field of a question do not undo it: neither declares a text colour of its own other than the page text', () => {
  for (const sel of ['.notes-box', '.ask-field']) {
    const d = decls(sel);
    assert.equal(d.length, 1, sel);
    for (const m of d[0].matchAll(/(?:^|[;\s])color:\s*([^;]+);?/g)) assert.match(m[1].trim(), /^(var\(--text\)|inherit)$/, `${sel} must not paint its text in another colour`);
  }
  assert.match(decls('.notes-box')[0], /background:\s*var\(--panel\)/, 'the Notes box keeps its background');
});

test('t4: the message box keeps its own look: transparent background, no border, the page text colour', () => {
  const d = decls('.composer textarea');
  assert.equal(d.length, 1);
  assert.match(d[0], /color:\s*var\(--text\)/);
  assert.match(d[0], /background:\s*transparent/);
  assert.match(d[0], /border:\s*0/);
});

test('t5: the text colour reads on every background a textarea sits on (WCAG AA, 4.5:1), and the browser black it replaced did not', () => {
  const text = token('text');
  for (const bg of ['bg', 'panel', 'panel2']) assert.ok(contrast(text, token(bg)) >= 4.5, `--text on --${bg}: ${contrast(text, token(bg)).toFixed(2)}`);
  assert.ok(contrast('#000000', token('panel')) < 2, 'black on the Notes background was unreadable: that is the bug');
});

test('t6: no other rule paints a textarea with a dark text colour', () => {
  const dark = (hex) => lum(hex) < 0.2;
  for (const m of css.matchAll(/([^{}\n]*textarea[^{}\n]*)\{([^}]*)\}/g)) {
    for (const c of m[2].matchAll(/(?:^|[;\s])color:\s*(#[0-9a-fA-F]{6})/g)) assert.ok(!dark(c[1]), `${m[1].trim()} paints text in ${c[1]}`);
  }
});
