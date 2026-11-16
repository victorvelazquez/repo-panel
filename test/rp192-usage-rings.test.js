'use strict';
// RP192 (S3, S18; geometry and name changed by RP211, see rp211-thin-rings.test.js): under 760 px the usage of the header is two rings of 26 px (no name, percent inside, arc in the tone colour, a tick for the
// share of the window already gone). The ring is extra markup: on desktop and tablet it is display:none and the bars stay as they were.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const V = require('../public/view.js');

const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'style.css'), 'utf8').replace(/\r\n/g, '\n');
const MIN = 60000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const NOW = Date.UTC(2026, 4, 1, 12, 0, 0);
const win = (percent, resetAt) => ({ percent, resetAt, expired: false });
const html = (five, seven, extra = {}) => V.usageHtml(V.usageView({ available: true, five, seven, updatedAt: NOW - MIN, stale: false, ...extra }, { now: NOW, timeZone: 'UTC' }));
const meters = (h) => h.split('<div class="usage-pop"')[0];
const ringOf = (h, name) => new RegExp(`data-win="${name}">.*?(<svg class="um-ring"[^>]*>.*?</svg>)`).exec(meters(h))[1];
const attr = (s, a) => (new RegExp(`${a}="([^"]*)"`).exec(s) || [])[1];
const mediaPhone = () => /@media \(max-width: 760px\) \{(.*)\}\n/.exec(css)[1];
// the rules written for one class (outside the media query)
const rule = (sel) => [...css.matchAll(/(?:^|\n)([^{}\n@/ ][^{}\n]*)\{([^}]*)\}/g)].filter((m) => m[1].split(',').map((s) => s.trim()).includes(sel)).map((m) => m[2]).join(' ');

test('a1: each window has ONE ring svg.um-ring with role img and the same aria-label as its bar', () => {
  const h = html(win(22, NOW + 3 * HOUR), win(74, NOW + 3 * DAY));
  assert.equal((meters(h).match(/<svg class="um-ring"/g) || []).length, 2);
  for (const n of ['5h', '7d']) {
    const ring = ringOf(h, n);
    assert.equal(attr(ring, 'role'), 'img');
    const said = new RegExp(`data-win="${n}">.*?class="um-bar" role="img" aria-label="([^"]*)"`).exec(meters(h))[1];
    assert.ok(attr(ring, 'aria-label').startsWith(`${said}, resets in `), 'the ring says the same as the bar and then when it resets');
    assert.match(ring, /width="26" height="26"/);
  }
  assert.equal(attr(ringOf(h, '5h'), 'aria-label'), '5h: 22% used, 40% of the window gone, resets in 3h 0m');
});

test('a2: the arc has pathLength 100 and a dasharray with the clamped percent; the number inside is the percent', () => {
  const h = html(win(22, NOW + 3 * HOUR), win(250, NOW + 3 * DAY));
  const five = ringOf(h, '5h');
  const arc = /<circle class="um-arc"[^>]*>/.exec(five)[0];
  assert.equal(attr(arc, 'pathLength'), '100');
  assert.equal(attr(arc, 'stroke-dasharray'), '22 100');
  assert.match(five, /<text [^>]*>22<\/text>/);
  const seven = ringOf(h, '7d');
  assert.equal(attr(/<circle class="um-arc"[^>]*>/.exec(seven)[0], 'stroke-dasharray'), '100 100');
  assert.match(seven, /<text [^>]*>100<\/text>/);
});

test('a3: the number is 9.5 px, and 8 px from 100', () => {
  const h = html(win(99, NOW + 3 * HOUR), win(100, NOW + 3 * DAY));
  assert.equal(attr(/<text [^>]*>/.exec(ringOf(h, '5h'))[0], 'font-size'), '9.5');
  assert.equal(attr(/<text [^>]*>/.exec(ringOf(h, '7d'))[0], 'font-size'), '8');
});

test('a4: the tick follows elapsed (from the top, clockwise) and is clamped', () => {
  assert.equal(typeof V.ringGeometry, 'function');
  const g = (pct, run) => V.ringGeometry(pct, run);
  const near = (a, b) => assert.ok(Math.abs(a - b) < 0.01, `${a} vs ${b}`);
  const t0 = g(10, 0).tick;
  near(t0.x1, 13); near(t0.y1, 5.5); near(t0.x2, 13); near(t0.y2, 0.5);
  const t25 = g(10, 25).tick;
  near(t25.x1, 20.5); near(t25.y1, 13);
  const t40 = g(22, 40).tick;
  near(t40.x1, 17.41); near(t40.y1, 19.07); near(t40.x2, 20.35); near(t40.y2, 23.11);
  assert.deepEqual(g(10, 400).tick, g(10, 100).tick);
  assert.deepEqual(g(10, -30).tick, g(10, 0).tick);
  assert.deepEqual(g(10, NaN).tick, g(10, 0).tick);
  assert.equal(g(250, 5).dash, 100);
  assert.equal(g(-4, 5).dash, 0);
  assert.equal(g(null, 5).dash, null);
  const h = html(win(22, NOW + 3 * HOUR), win(74, NOW + 3 * DAY));
  const line = /<line class="um-tick"[^>]*>/.exec(ringOf(h, '5h'))[0];
  near(Number(attr(line, 'x1')), 17.41);
  near(Number(attr(line, 'y2')), 23.11);
});

test('a5: a window with no percent shows an empty ring with a dash, gray, and no arc or tick', () => {
  const h = html(win(null, NOW + 3 * HOUR), win(50, NOW + 3 * DAY));
  const m = /data-win="5h">.*?<\/span><\/span>/.exec(meters(h))[0];
  assert.match(m, /^data-win="5h">/);
  assert.ok(m.includes('<svg class="um-ring"'));
  const ring = ringOf(h, '5h');
  assert.match(ring, /<text [^>]*>–<\/text>/);
  assert.doesNotMatch(ring, /um-arc|um-tick/);
  assert.match(ring, /<circle class="um-track"/);
  assert.equal(attr(ring, 'role'), 'img');
  assert.match(meters(h), /class="um usage-dim" data-win="5h"/);
});

test('a6: the tone classes colour the arc through the stylesheet, from the root tokens', () => {
  assert.match(rule('.um-arc'), /stroke:\s*var\(--green\)/);
  assert.match(rule('.usage-warn .um-arc'), /stroke:\s*var\(--yellow\)/);
  assert.match(rule('.usage-error .um-arc'), /stroke:\s*var\(--red\)/);
  assert.match(rule('.usage-dim .um-arc'), /stroke:\s*var\(--gray\)/);
  assert.match(rule('.um-track'), /stroke:\s*var\(--panel2\)/);
  assert.match(rule('.um-tick'), /stroke:\s*var\(--text\)/);
  const h = html(win(80, NOW + 3 * HOUR), win(95, NOW + 3 * DAY));
  assert.match(meters(h), /class="um usage-warn" data-win="5h"/);
  assert.match(meters(h), /class="um usage-error" data-win="7d"/);
  assert.doesNotMatch(ringOf(h, '5h'), /style=|#[0-9a-fA-F]{3,6}/);
});

test('a7: under 760 px the ring shows and the bar, the percent text, the flag, the spaced time left and the name hide; outside it the ring is hidden', () => {
  assert.match(rule('.um-ring'), /display:\s*none/);
  const m = mediaPhone();
  assert.match(m, /\.um-ring\s*\{[^}]*display:\s*(inline-block|block|inline-flex)/);
  const hidden = /([^{}]*)\{[^}]*display:\s*none/.exec(m)[1].split(',').map((s) => s.trim());
  for (const c of ['.um-bar', '.um-left', '.um-pct', '.um-flag', '.um-name']) assert.ok(hidden.includes(c), c);
  assert.match(rule('.um-name'), /color:\s*var\(--muted\)/);
});

test('a8: the markup of text percent, flag, bar and popover stays; the popover is the same as before', () => {
  const h = html(win(80, NOW + 3 * HOUR), win(40, NOW + 3 * DAY));
  const m = meters(h);
  assert.match(m, /<span class="um-pct"><b class="um-flag" aria-hidden="true">⚠<\/b>80%<\/span>/);
  assert.match(m, /<span class="um-bar" role="img" aria-label="5h: 80% used, 40% of the window gone, more than the clock"><i class="um-fill" style="width:80%"><\/i><i class="um-pace" style="left:40%"><\/i><\/span>/);
  const pop = h.slice(h.indexOf('<div class="usage-pop"'));
  assert.doesNotMatch(pop, /um-ring|<svg/);
  assert.match(pop, /<span class="um-bar up-bar" role="img" aria-label="5h: 80% used, 40% of the window gone, more than the clock"><i class="um-fill" style="width:80%"><\/i><i class="um-pace" style="left:40%"><\/i><\/span><div class="up-line"><span>80% used<\/span><span>Resets in 3h 0m<\/span>/);
});

test('a9: the none state is only its text and the old-file dot stays first', () => {
  assert.equal(V.usageHtml({ state: 'none', label: 'Claude usage: no data' }), 'Claude usage: no data');
  const old = html(win(10, NOW + HOUR), win(10, NOW + DAY), { updatedAt: NOW - 20 * MIN, stale: true });
  if (old.startsWith('<span class="um-old"')) assert.match(old, /^<span class="um-old" aria-hidden="true" title="Usage data is [^"]*"><\/span><span class="um/);
});

test('a10: the number inside the ring has the colour of its arc (the approved design), also with a tone, and gray without data', () => {
  assert.match(rule('.um-ring text'), /fill:\s*var\(--green\)/);
  assert.match(rule('.usage-warn .um-ring text'), /fill:\s*var\(--yellow\)/);
  assert.match(rule('.usage-error .um-ring text'), /fill:\s*var\(--red\)/);
  assert.match(rule('.usage-dim .um-ring text'), /fill:\s*var\(--gray\)/);
  assert.doesNotMatch(rule('.um-ring text'), /fill:\s*var\(--text\)/);
});
