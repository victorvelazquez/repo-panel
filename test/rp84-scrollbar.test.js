'use strict';
// RP84 (S7): thin, dark scrollbars with the theme's colors for every scroller of the page. This is only CSS, so these tests pin the rules
// and the colors (dark, and still distinguishable from the background); how it looks is judged by the person looking at the page.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'style.css'), 'utf8').replace(/\r\n/g, '\n');
const varOf = (name) => { const m = new RegExp(`${name}:\\s*(#[0-9a-fA-F]{6})\\b`).exec(css); return m ? m[1] : null; };
// WCAG relative luminance and contrast ratio.
const lum = (hex) => { const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)); return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; };
const contrast = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
// The body of the block that follows `head` (balanced braces), or null.
function block(head) {
  const i = css.indexOf(head);
  if (i < 0) return null;
  let depth = 0;
  for (let j = css.indexOf('{', i); j < css.length; j++) {
    if (css[j] === '{') depth++;
    else if (css[j] === '}' && --depth === 0) return css.slice(css.indexOf('{', i) + 1, j);
  }
  return null;
}

test('s1: every element gets the standard thin scrollbar in the theme colors', () => {
  const rule = block('* { scrollbar-width') || block('*{scrollbar-width') || '';
  assert.match(css, /^\* \{[^}]*scrollbar-width:\s*thin;[^}]*\}/m);
  assert.match(css, /^\* \{[^}]*scrollbar-color:\s*var\(--scroll-thumb\) transparent;[^}]*\}/m);
  assert.equal(typeof rule, 'string');
});

test('s2: the thumb colors are in :root, dark, visible against the page background and lighter on hover', () => {
  const bg = varOf('--bg');
  const panel = varOf('--panel');
  const thumb = varOf('--scroll-thumb');
  const hover = varOf('--scroll-thumb-hover');
  assert.ok(bg && panel && thumb && hover, 'all four colors exist as 6-digit hex');
  assert.ok(css.indexOf('--scroll-thumb') < css.indexOf('* { box-sizing'), 'defined in :root, before the rules that use them');
  assert.ok(lum(thumb) < 0.12 && lum(hover) < 0.2, 'dark, not the bright browser default');
  assert.ok(contrast(thumb, bg) >= 1.3 && contrast(thumb, panel) >= 1.2, 'still visible on both surfaces');
  assert.ok(lum(hover) > lum(thumb), 'hover is lighter');
});

test('s3: no rule hides the scrollbar or makes it invisible', () => {
  assert.doesNotMatch(css, /scrollbar-width:\s*none/);
  assert.doesNotMatch(css, /scrollbar-color:\s*(transparent|auto)\s+(transparent)/);
  assert.doesNotMatch(css, /::-webkit-scrollbar[^{]*\{[^}]*display:\s*none/);
});

test('s4: older browsers get the WebKit rules, but only where the standard property is not supported', () => {
  const fallback = block('@supports not (scrollbar-color: auto)');
  assert.ok(fallback, 'the fallback lives under @supports not');
  assert.match(fallback, /::-webkit-scrollbar\s*\{[^}]*width:\s*8px;[^}]*height:\s*8px/);
  assert.match(fallback, /::-webkit-scrollbar-track\s*\{[^}]*background:\s*transparent/);
  assert.match(fallback, /::-webkit-scrollbar-thumb\s*\{[^}]*background:\s*var\(--scroll-thumb\)[^}]*border-radius:\s*8px/);
  assert.match(fallback, /::-webkit-scrollbar-thumb:hover\s*\{[^}]*background:\s*var\(--scroll-thumb-hover\)/);
  assert.match(fallback, /::-webkit-scrollbar-corner\s*\{[^}]*background:\s*transparent/);
  assert.equal(css.split('::-webkit-scrollbar {').length - 1 + css.split('::-webkit-scrollbar{').length - 1, 1, 'the WebKit rules exist only once, inside the fallback');
});

test('s5: no element overrides the thin scrollbar with a wide one', () => {
  assert.doesNotMatch(css, /scrollbar-width:\s*(auto|thick)/);
});
