'use strict';
// RP180: a steady screen on a phone. iOS zooms into any field under 16 px and never zooms back, and 100dvh does not shrink when the keyboard
// opens, so Safari scrolls the whole page to show the box. The fix: 16 px fields on touch screens, the zone sized to the VISIBLE height
// (public/viewport.js sets --vvh from visualViewport) and a page that does not stretch. Static checks on the page files plus the script with a fake window.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(root, ...p), 'utf8');
const html = read('public', 'index.html');
const css = read('public', 'style.css');

test('the viewport covers the notch but keeps pinch zoom (no maximum-scale, no user-scalable=no)', () => {
  const meta = /<meta name="viewport" content="([^"]*)"/.exec(html);
  assert.ok(meta, 'viewport meta');
  assert.match(meta[1], /width=device-width/);
  assert.match(meta[1], /initial-scale=1/);
  assert.match(meta[1], /viewport-fit=cover/);
  assert.doesNotMatch(meta[1], /maximum-scale|user-scalable/);
});

test('the page loads viewport.js before app.js and the server serves it', () => {
  const a = html.indexOf('/viewport.js');
  const b = html.indexOf('/app.js');
  assert.ok(a > -1 && b > -1 && a < b, 'viewport.js before app.js');
  assert.match(read('server', 'http.js'), /'\/viewport\.js': \['viewport\.js', 'text\/javascript; charset=utf-8'\]/);
});

test('touch screens get 16 px fields, even the chat box that sets its own font', () => {
  const m = /@media \(pointer: coarse\), \(max-width: 760px\) \{([^}]*)\}/.exec(css);
  assert.ok(m, 'a (pointer: coarse), (max-width: 760px) block');
  assert.match(m[1], /input/);
  assert.match(m[1], /select/);
  assert.match(m[1], /textarea/);
  assert.match(m[1], /\.composer textarea/);
  assert.match(m[1], /font-size: 16px !important/);
});

test('the one-zone layout follows the visible height, with the dynamic unit as the fallback', () => {
  const rule = css.split('\n').find((l) => l.startsWith('#sumLayout[data-screen] {'));
  assert.ok(rule);
  assert.match(rule, /height: calc\(var\(--vvh, 100dvh\) - var\(--sum-top, 98px\)\)/);
});

test('the page does not rubber-band and iOS does not inflate the text', () => {
  assert.match(css, /html\s*\{[^}]*-webkit-text-size-adjust: 100%/);
  assert.match(css, /html, body\s*\{[^}]*overscroll-behavior: none/);
});

function fakeWindow({ coarse = true, hasVv = true, scale = 1, height = 700, scrollY = 0, active = null } = {}) {
  const listeners = {};
  const props = {};
  const scrolls = [];
  const win = {
    scrollY,
    scrollTo: (x, y) => { scrolls.push([x, y]); win.scrollY = y; },
    matchMedia: (q) => ({ matches: coarse && q === '(pointer: coarse)' }),
    document: { activeElement: active, documentElement: { style: { setProperty: (k, v) => { props[k] = v; } } } },
    visualViewport: hasVv ? { height, scale, addEventListener: (t, f) => { listeners[t] = f; } } : undefined,
  };
  return { win, listeners, props, scrolls };
}

test('viewport.js: sets --vvh now and on every resize, and brings a shifted page back to the top while a field has the focus (RP182: only then)', () => {
  const { fitViewport } = require('../public/viewport.js');
  const f = fakeWindow({ height: 700.4, scrollY: 120, active: { tagName: 'TEXTAREA', isContentEditable: false } });
  assert.equal(fitViewport(f.win), true);
  assert.equal(f.props['--vvh'], '700px');
  assert.deepEqual(f.scrolls, [[0, 0]]);
  f.win.visualViewport.height = 420; // the keyboard opened
  f.win.scrollY = 60; // Safari scrolled to show the box
  f.listeners.resize();
  assert.equal(f.props['--vvh'], '420px');
  assert.deepEqual(f.scrolls, [[0, 0], [0, 0]]);
  assert.ok(f.listeners.scroll, 'also follows the visual viewport scroll');
});

test('viewport.js: does not touch a page that is at the top, and leaves a pinch-zoomed page alone', () => {
  const { fitViewport } = require('../public/viewport.js');
  const top = fakeWindow({ scrollY: 0 });
  fitViewport(top.win);
  assert.deepEqual(top.scrolls, []);
  const zoomed = fakeWindow({ scale: 2, scrollY: 80 });
  fitViewport(zoomed.win);
  zoomed.win.visualViewport.height = 300;
  zoomed.listeners.resize();
  assert.equal(zoomed.props['--vvh'], undefined, 'zoomed in: the visible height is not the layout height');
  assert.deepEqual(zoomed.scrolls, []);
});

test('viewport.js: nothing happens on a mouse device or without visualViewport', () => {
  const { fitViewport } = require('../public/viewport.js');
  const mouse = fakeWindow({ coarse: false });
  assert.equal(fitViewport(mouse.win), false);
  assert.deepEqual(mouse.props, {});
  assert.equal(fitViewport(fakeWindow({ hasVv: false }).win), false);
  assert.equal(fitViewport(null), false);
});
