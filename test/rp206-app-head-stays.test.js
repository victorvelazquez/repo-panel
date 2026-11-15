'use strict';
// RP206 (S17): the app header (logo, tabs, usage) STAYS on the phone while the chat or the Repo screen is open. RP204 had hidden it; on an iPhone with iOS 27.0.1 what sits at the very top without that header is drawn under a
// frosted glass of the system, and only lowering it by about 30 px more than the safe area made it sharp (measured with a test bench on the phone: +16 px still blurred, +32 px sharp). The person chose the logo header over
// a lowered head. These tests pin that the hiding mechanism of RP204 is gone, so it does not come back by accident; how it LOOKS on the iPhone is for the person to try.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const V = require('../public/view.js');

const read = (f) => fs.readFileSync(path.join(__dirname, '..', 'public', f), 'utf8').replace(/\r\n/g, '\n');
const css = read('style.css');
const cssNoComments = css.replace(/\/\*[\s\S]*?\*\//g, '');
const chat = read('chat.js');
const view = read('view.js');
const html = read('index.html');
const ruleIn = (src, sel) => [...src.matchAll(/(?:^|\n|\})\s*([^{}@]+)\{([^}]*)\}/g)].filter((m) => m[1].split(',').some((s) => s.trim().replace(/\s+/g, ' ') === sel)).map((m) => m[2]).join(';');

test('h1: no rule of the stylesheet hides or collapses the app header under a mark of the page', () => {
  assert.doesNotMatch(cssNoComments, /data-app-head/);
  const rules = [...cssNoComments.matchAll(/([^{}@]*\bheader\b[^{}@]*)\{([^}]*)\}/g)].filter((m) => /display:\s*none/.test(m[2]) && !/rs-tabs|\.tab-|h1|\.rm-header|\.ch-head|col-head/.test(m[1]));
  assert.deepEqual(rules.map((m) => m[1].trim()), [], 'nothing hides the <header>');
});

test('h2: the page does not put a mark on the body for the phone screens, and the helper of RP204 is gone', () => {
  assert.doesNotMatch(chat, /appHead|app-head/);
  assert.doesNotMatch(view, /hidesAppHead|appHead|app-head/);
  assert.equal(V.hidesAppHead, undefined);
});

test('h3: the app header is still the sticky bar of the page that the list uses', () => {
  const r = ruleIn(cssNoComments, 'header');
  assert.match(r, /position:\s*sticky/);
  assert.match(r, /top:\s*0/);
  assert.match(html, /<header>\s*<h1>/);
});

test('h4: --sum-top is measured as it was before RP204: only a value above 0 is accepted (RP126, a layout hidden in another tab measures 0)', () => {
  assert.match(chat, /Number\.isFinite\(top\) && top > 0 && \$\('#sumLayout'\)\.style\.setProperty/);
  assert.doesNotMatch(chat, /top === 0/);
});

test('h5: nothing of the test bench of RP205 or of its safe-area padding is left in the page', () => {
  assert.doesNotMatch(html, /iosLab|iosProbe|ilTab/);
  assert.doesNotMatch(cssNoComments, /safe-area-inset-top/);
  assert.match(html, /viewport-fit=cover/, 'the viewport is the one of always');
});
