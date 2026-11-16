'use strict';
// RP212 (S25): Settings on the phone, mobile first. Under 760 px only: (1) a switch sits on the same line as the name of its setting, (2) the chips that say where a setting is saved are folded behind a
// «Details» control, (3) selects and inputs take the full width of their row, (4) every button of Settings and Conformity is 44 px tall and the 22 px switch has a 44 px touch target without changing its look.
// Plain CSS cannot be run here: these tests read the page as text and call the pure view; how it LOOKS is for the person to try on the phone.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const R = require('../public/resumen.js');

const read = (f) => fs.readFileSync(path.join(__dirname, '..', 'public', f), 'utf8').replace(/\r\n/g, '\n');
const raw = read('style.css').replace(/\/\*[\s\S]*?\*\//g, '');
const MOBILE = '(max-width: 759.98px)';
const blocks = [...raw.matchAll(/@media ([^{]*)\{((?:[^{}]*\{[^}]*\})*)\s*\}/g)].filter((m) => m[1].trim() === MOBILE).map((m) => ({ at: m.index, body: m[2] }));
const phone = blocks.map((b) => b.body).join('\n');
const outsidePhone = blocks.reduce((s, b) => s.replace(b.body, ''), raw);
const rule = (src, sel) => [...src.matchAll(/(?:^|\n|\})\s*([^{}@]+)\{([^}]*)\}/g)].filter((m) => m[1].split(',').some((s) => s.trim().replace(/\s+/g, ' ') === sel)).map((m) => m[2]).join(';');
const actionsJs = read('actions.js');
const view = (open) => R.settingsView({ state: 'ready', options: {}, prefs: { method: 'squash', del: true, clean: true, split: false, notify: { answer: true, ci: true, deliver: true, merge: true, start: true, sound: true, system: true, permission: 'granted' } }, pi: null, open });
const FOLD = /<button type="button" class="st-fold"[^>]*>[^<]*<\/button>/g;

test('s1: under 760 px a row with a switch is two columns (name | switch) while every other row stays one column', () => {
  assert.match(rule(phone, '.st-row:has(.st-sw)'), /grid-template-columns:\s*minmax\(0,\s*1fr\)\s*auto/);
  assert.match(rule(phone, '.st-row'), /grid-template-columns:\s*minmax\(0,\s*1fr\)\s*;/);
});

test('s2: the chips are hidden under 760 px until their row is open, and the fold control exists only there', () => {
  assert.match(rule(phone, '.st-meta:not(.is-open)'), /display:\s*none/);
  assert.match(rule(outsidePhone, '.st-fold'), /display:\s*none/);
  // block level on purpose: an inline control follows the text of a label that has no description under it («CI fails Details», seen in a capture at 390 px) and pulls the title off the switch
  assert.match(rule(phone, '.st-row .st-fold'), /display:\s*flex/);
  assert.doesNotMatch(rule(phone, '.st-row .st-fold'), /display:\s*inline/);
  assert.match(rule(phone, '.st-row .st-fold'), /width:\s*fit-content/);
});

test('s3: stRow draws, in every row that has chips, a fold control with a visible word, aria-expanded and the key of the row; the chips div keeps its markup', () => {
  const html = view();
  const buttons = html.match(FOLD) || [];
  const metas = html.match(/<div class="st-meta">/g) || [];
  assert.ok(buttons.length >= 10, 'one control per row with chips');
  assert.equal(buttons.length, metas.length);
  for (const b of buttons) {
    assert.match(b, /data-act="st-fold"/);
    assert.match(b, /data-key="[\w-]+"/);
    assert.match(b, /aria-expanded="false"/);
    assert.match(b, />Details</);
  }
  assert.equal(new Set(buttons.map((b) => /data-key="([^"]+)"/.exec(b)[1])).size, buttons.length, 'keys are unique');
  assert.ok(!html.replace(FOLD, '').includes('st-meta is-open'), 'closed rows have no is-open');
});

test('s4: the open state survives a redraw: a key in `open` draws that row with is-open and aria-expanded="true", the others stay closed', () => {
  const key = /data-key="([^"]+)"/.exec(view().match(FOLD)[0])[1];
  const html = view(new Set([key]));
  assert.equal((html.match(/st-meta is-open/g) || []).length, 1);
  assert.equal((html.match(/aria-expanded="true"/g) || []).length, 1);
  assert.match(html, new RegExp(`class="st-fold"[^>]*data-key="${key}"[^>]*aria-expanded="true"|aria-expanded="true"[^>]*data-key="${key}"`));
  assert.equal(view(undefined).replace(FOLD, ''), view(new Set()).replace(FOLD, ''), 'no state = all closed');
});

test('s5: the st-fold action flips the key in S.settings.open and redraws the settings', () => {
  const m = /'st-fold':\s*\(el\)\s*=>\s*\{([^\n]*)\}/.exec(actionsJs);
  assert.ok(m, 'the action exists');
  assert.match(m[1], /S\.settings\.open/);
  assert.match(m[1], /el\.dataset\.key/);
  assert.match(m[1], /drawSettings\(\)/);
});

// found by mutation: nothing pinned that a second tap CLOSES the row, that the focus returns to the control after the redraw, or that S.settings starts with its Set (without it the action throws)
test('s5b: a second tap closes the row, the focus returns to the control after the redraw and S.settings starts with an empty open Set', () => {
  const m = /'st-fold':\s*\(el\)\s*=>\s*\{([^\n]*)\}/.exec(actionsJs);
  assert.ok(m, 'the action exists');
  assert.match(m[1], /if \(o\.has\(k\)\) o\.delete\(k\); else o\.add\(k\)/);
  assert.match(m[1], /\.focus\(\)/);
  assert.match(read('app.js'), /settings: \{ state: 'idle'[^\n]*open: new Set\(\) \}/);
});

// found by mutation: the switch must stay on the RIGHT of its line and the fold arrow must flip when the row is open
test('s1b: the switch of a row stays at the right of its line and the Details arrow points up when the row is open', () => {
  assert.match(rule(phone, '.st-row:has(.st-sw) .st-ctl'), /justify-content:\s*flex-end/);
  assert.match(rule(phone, '.st-row .st-fold::after'), /content:\s*"\\25BE"/);
  assert.match(rule(phone, '.st-row .st-fold[aria-expanded="true"]::after'), /content:\s*"\\25B4"/);
});

test('s6: selects and inputs of a control take the full width of the row under 760 px; desktop is untouched', () => {
  for (const sel of ['.st-ctl select', '.st-ctl input']) assert.match(rule(phone, sel), /(^|;|\s)width:\s*100%/, sel);
  assert.ok(!/\.st-ctl (select|input)/.test(outsidePhone));
});

test('s7: every button of Settings and Conformity is at least 44 px tall under 760 px, except the switch, which keeps its look', () => {
  for (const sel of ['.st-row button:not(.st-sw)', '.conf-item button']) assert.match(rule(phone, sel), /min-height:\s*44px/, sel);
  assert.match(rule(phone, '.conf-title button'), /min-height:\s*44px/);
  assert.ok(!/min-height/.test(rule(phone, '.st-sw')), 'the switch itself is not made taller');
});

// measured in a mobile Chromium at 390 px: the selects and the text field of Settings were 33 px tall and the select of Conformity 31 px, so «buttons of 44 px» also covers the controls that are touched
test('s7b: the selects and the text field of Settings and the select of Conformity are at least 44 px tall under 760 px; desktop is untouched', () => {
  for (const sel of ['.st-ctl select', '.st-ctl input', '.conf-item select']) assert.match(rule(phone, sel), /min-height:\s*44px/, sel);
  assert.ok(!/min-height:\s*44px/.test(rule(outsidePhone, '.st-ctl select') + rule(outsidePhone, '.conf-item select')), 'desktop keeps its sizes');
});

test('s8: the switch has a 44 px touch target through a ::before hit area (22 px + 11 px above and below); the box and the knob do not change', () => {
  const r = rule(phone, '.st-sw::before');
  assert.match(r, /content:\s*""/);
  assert.match(r, /position:\s*absolute/);
  assert.match(r, /(top|inset):\s*-11px/);
  assert.match(rule(outsidePhone, '.st-sw'), /width:\s*40px;\s*height:\s*22px/);
  assert.ok(!/\.st-sw::before/.test(outsidePhone), 'desktop has no hit area');
});

test('s9: the new rules come AFTER the base rules of Settings (or they would be dead) and the palette has no solid button (RP67)', () => {
  const at = Math.min(...blocks.filter((b) => /\.st-fold/.test(b.body)).map((b) => b.at));
  for (const base of ['\n.st-row {', '\n.st-ctl {', '\n.st-sw {', '\n.st-fold {']) assert.ok(raw.indexOf(base) > 0 && at > raw.indexOf(base), base);
  assert.ok(!/background:\s*var\(--(blue|green|red)\)/.test(rule(phone, '.st-row .st-fold')));
});
