'use strict';
// RP182: the scroll of the phone does not jump to the top. RP180 sent the page to the top on EVERY event of visualViewport, and on iOS the bounce at the
// end of a page fires them; the page of Settings, Work and Conformity scrolls as a page, so it went back up each time. Now the page goes back to the top
// only while a text field has the focus (the keyboard case it was written for), and the inner scrollers do not pass the scroll on to the page.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { fitViewport } = require('../public/viewport.js');
const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'style.css'), 'utf8').replace(/\r\n/g, '\n');

function fakeWindow({ active = null, scrollY = 0, offsetTop = 0, height = 700, scale = 1 } = {}) {
  const listeners = {};
  const props = {};
  const scrolls = [];
  const win = {
    scrollY,
    scrollTo: (x, y) => { scrolls.push([x, y]); win.scrollY = y; },
    matchMedia: (q) => ({ matches: q === '(pointer: coarse)' }),
    document: { activeElement: active, documentElement: { style: { setProperty: (k, v) => { props[k] = v; } } } },
    visualViewport: { height, scale, offsetTop, addEventListener: (t, f) => { listeners[t] = f; } },
  };
  return { win, listeners, props, scrolls };
}
const field = (tagName, extra = {}) => ({ tagName, isContentEditable: false, ...extra });

test('no field has the focus: scrolling, the bounce at the end and a resize never move the page', () => {
  const f = fakeWindow({ scrollY: 1200 });
  fitViewport(f.win);
  f.win.scrollY = 1350; // the person scrolled to the end of the page
  f.listeners.scroll();
  f.listeners.resize();
  f.win.visualViewport.height = 640; // the bar of the browser moved
  f.listeners.resize();
  assert.deepEqual(f.scrolls, []);
  assert.equal(f.props['--vvh'], '640px', 'the visible height still follows');
});

test('the body or a button focused is not a field: the page is left alone', () => {
  for (const active of [null, undefined, field('BODY'), field('BUTTON'), field('A'), field('DIV')]) {
    const f = fakeWindow({ active, scrollY: 300 });
    fitViewport(f.win);
    f.listeners.resize();
    assert.deepEqual(f.scrolls, [], String(active && active.tagName));
  }
});

test('a text field has the focus (the keyboard is open): a page the browser shifted goes back to the top, as before', () => {
  for (const active of [field('INPUT'), field('TEXTAREA'), field('SELECT'), field('DIV', { isContentEditable: true })]) {
    const f = fakeWindow({ active, scrollY: 120 });
    fitViewport(f.win);
    assert.deepEqual(f.scrolls, [[0, 0]], `${active.tagName}: at install`);
    f.win.scrollY = 60;
    f.listeners.resize();
    assert.deepEqual(f.scrolls, [[0, 0], [0, 0]], `${active.tagName}: on resize`);
    f.win.scrollY = 30;
    f.listeners.scroll();
    assert.equal(f.scrolls.length, 3, `${active.tagName}: on scroll`);
  }
});

test('a text field has the focus but the page is at the top: nothing to undo; and a pinch-zoomed page is never touched', () => {
  const top = fakeWindow({ active: field('TEXTAREA'), scrollY: 0 });
  fitViewport(top.win);
  top.listeners.resize();
  assert.deepEqual(top.scrolls, []);
  const zoomed = fakeWindow({ active: field('TEXTAREA'), scrollY: 80, scale: 2 });
  fitViewport(zoomed.win);
  zoomed.listeners.resize();
  assert.deepEqual(zoomed.scrolls, []);
  assert.equal(zoomed.props['--vvh'], undefined);
});

test('--vvh is still set at install and follows every resize', () => {
  const f = fakeWindow({ height: 700.4 });
  assert.equal(fitViewport(f.win), true);
  assert.equal(f.props['--vvh'], '700px');
  f.win.visualViewport.height = 420;
  f.listeners.resize();
  assert.equal(f.props['--vvh'], '420px');
});

// ---------- the inner scrollers do not chain to the page ----------
const ruleOf = (selector) => css.split('\n').find((l) => l.startsWith(`${selector} {`));
for (const selector of ['.ch-body', '#col', '.chatlayout.chat-open #summary', '.ft-tree', '.ch-picks']) {
  test(`${selector} scrolls on its own and keeps the scroll to itself (overscroll-behavior: contain)`, () => {
    const rule = ruleOf(selector);
    assert.ok(rule, `a rule for ${selector}`);
    assert.match(rule, /overflow(-y)?: auto/);
    assert.match(rule, /overscroll-behavior: contain/);
  });
}

test('the page itself still has no rubber band (RP180 stays)', () => {
  assert.match(css, /html, body\s*\{[^}]*overscroll-behavior: none/);
});

test('README says the page goes back to the top only while a field has the focus', () => {
  const readme = fs.readFileSync(path.join(__dirname, '..', 'README.md'), 'utf8');
  const line = readme.split('\n').find((l) => l.startsWith('- `public/viewport.js`'));
  assert.ok(line);
  assert.match(line, /only while a (text )?field has the focus/);
});
