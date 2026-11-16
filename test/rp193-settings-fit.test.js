'use strict';
// RP193 (S24), correction after the person tried the bottom bar on the iPhone: the Settings screen was wider than the phone, so the page grew (the layout viewport was 427 px, measured with a 390 px phone in
// Chromium; the page was 495 px wide with the viewport kept) and the fixed bar stretched with it. Cause: every row of Settings is a grid `1fr auto` and its control (`.st-ctl`) has `min-width: 170px`, so a row
// needed about 465 px. Under 760 px the row stacks (description above, control below), the control has no minimum and wraps, and a long select or chip cannot push the page. Plain CSS cannot be run here: these
// tests read the page as text; the width itself was measured with a headless browser, and how it LOOKS is for the person to try on the phone.
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
const baseAt = raw.indexOf('\n.st-row {');
const fitBlock = blocks.find((b) => /\.st-row\b/.test(b.body));

test('f1: under 760 px a Settings row is ONE column that can shrink (minmax(0, 1fr)): the description above, the control below', () => {
  assert.match(rule(phone, '.st-row'), /grid-template-columns:\s*minmax\(0,\s*1fr\)/);
});

test('f2: the control has no minimum width, wraps and starts at the left under 760 px', () => {
  const r = rule(phone, '.st-ctl');
  assert.match(r, /min-width:\s*0/);
  assert.match(r, /flex-wrap:\s*wrap/);
  assert.match(r, /justify-content:\s*flex-start/);
});

test('f3: a select or an input in a control never goes past the width of its row (max-width: 100%, min-width: 0)', () => {
  for (const sel of ['.st-ctl select', '.st-ctl input']) {
    assert.match(rule(phone, sel), /max-width:\s*100%/, sel);
    assert.match(rule(phone, sel), /min-width:\s*0/, sel);
  }
});

test('f4: the chips that say where a setting is saved can break lines under 760 px (white-space: normal, overflow-wrap: anywhere)', () => {
  const r = rule(phone, '.st-meta .chip');
  assert.match(r, /white-space:\s*normal/);
  assert.match(r, /overflow-wrap:\s*anywhere/);
  assert.match(r, /max-width:\s*100%/);
});

test('f5: those rules come AFTER the base rules of Settings (same specificity: the later one wins), so they are not dead', () => {
  assert.ok(baseAt > 0, 'the base .st-row rule exists');
  assert.ok(fitBlock && fitBlock.at > baseAt, 'the phone block with .st-row comes after the base rule');
  assert.ok(fitBlock.at > raw.indexOf('\n.st-ctl {'), 'and after the base .st-ctl rule');
});

test('f6: desktop and tablet keep the two columns of Settings exactly as before (the base rules are untouched)', () => {
  assert.match(rule(outsidePhone, '.st-row'), /grid-template-columns:\s*1fr auto/);
  assert.match(rule(outsidePhone, '.st-row'), /gap:\s*16px/);
  assert.match(rule(outsidePhone, '.st-ctl'), /min-width:\s*170px/);
  assert.match(rule(outsidePhone, '.st-ctl'), /justify-content:\s*flex-end/);
  assert.ok(!/\.st-ctl select/.test(outsidePhone) && !/\.st-meta \.chip/.test(outsidePhone), 'the new rules live only in the phone block');
});
