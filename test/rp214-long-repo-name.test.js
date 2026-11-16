'use strict';
// RP214: in Conformity on the phone a very long repo name does not widen the page. The name is a <button class="repo-name"> inside `.conf-item`, and a button keeps the white-space of the browser
// (it does not wrap) and has no minimum width of zero, so a long name pushed the page: measured in a real WebKit (Playwright, not iOS), 50 characters at 320 px left the page at 386 px and 86
// characters at 390 px at 513 px, and the fixed bottom bar stretched with it (the same kind of defect as Settings in RP193). Under 760 px the name wraps inside its block. Plain CSS cannot be run
// here: these tests read the page as text; the width itself was measured with a browser, and how it LOOKS is for the person to try on the phone.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const raw = fs.readFileSync(path.join(__dirname, '..', 'public', 'style.css'), 'utf8').replace(/\r\n/g, '\n').replace(/\/\*[\s\S]*?\*\//g, '');
const MOBILE = '(max-width: 759.98px)';
const blocks = [...raw.matchAll(/@media ([^{]*)\{((?:[^{}]*\{[^}]*\})*)\s*\}/g)].filter((m) => m[1].trim() === MOBILE).map((m) => ({ at: m.index, body: m[2] }));
const phone = blocks.map((b) => b.body).join('\n');
const outsidePhone = blocks.reduce((s, b) => s.replace(b.body, ''), raw);
const rule = (src, sel) => [...src.matchAll(/(?:^|\n|\})\s*([^{}@]+)\{([^}]*)\}/g)].filter((m) => m[1].split(',').some((s) => s.trim().replace(/\s+/g, ' ') === sel)).map((m) => m[2]).join(';');
const SEL = '.conf-item .repo-name';

test('n1: under 760 px the name of a repo in Conformity wraps inside its block (white-space: normal, overflow-wrap: anywhere) and can shrink (min-width: 0, max-width: 100%)', () => {
  const r = rule(phone, SEL);
  assert.match(r, /white-space:\s*normal/);
  assert.match(r, /overflow-wrap:\s*anywhere/);
  assert.match(r, /min-width:\s*0/);
  assert.match(r, /max-width:\s*100%/);
});

test('n2: the wrapped name stays aligned to the left, like the name does today', () => {
  assert.match(rule(phone, SEL), /text-align:\s*left/);
});

test('n3: the rule comes AFTER the base rule of the name (same specificity: the later one wins), so it is not dead', () => {
  const base = raw.indexOf('\n.conf-item .repo-name {');
  assert.ok(base > 0, 'the base rule exists');
  const at = Math.min(...blocks.filter((b) => b.body.includes(SEL + ' {')).map((b) => b.at));
  assert.ok(Number.isFinite(at) && at > base, 'the phone block with the rule comes after the base rule');
});

test('n4: desktop and tablet keep the name as it is: the base rule is untouched and the wrapping lives only in the phone block', () => {
  const base = rule(outsidePhone, SEL);
  assert.match(base, /background:\s*none/);
  assert.match(base, /border:\s*0/);
  assert.match(base, /padding:\s*0/);
  assert.match(base, /cursor:\s*pointer/);
  assert.ok(!/white-space|overflow-wrap|max-width|min-width|text-align/.test(base), 'the base rule has no wrapping');
});

test('n5: only Conformity changes: the names of the board and of the clean rows keep their single line with an ellipsis, and no global .repo-name rule is added to the phone block', () => {
  assert.match(rule(raw, '.card-top .repo-name'), /white-space:\s*nowrap/);
  assert.match(rule(raw, '.card-top .repo-name'), /text-overflow:\s*ellipsis/);
  assert.match(rule(raw, '.clean-row .repo-name'), /white-space:\s*nowrap/);
  assert.equal(rule(phone, '.repo-name'), '', 'no rule for every .repo-name under 760 px');
});
