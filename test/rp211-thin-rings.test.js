'use strict';
// RP211 (S23): under 760 px the rings of the usage are thinner (26 px, stroke 2.5), without the name, and show the time left (compact, «2h29m») next to each.
// Desktop and tablet keep the name, the bar, the percent and the spaced time left exactly as before.
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
const html = (five, seven) => V.usageHtml(V.usageView({ available: true, five, seven, updatedAt: NOW - MIN, stale: false }, { now: NOW, timeZone: 'UTC' }));
const meters = (h) => h.split('<div class="usage-pop"')[0];
const meterOf = (h, name) => new RegExp(`<span class="um[^"]*" data-win="${name}">.*?(?=<span class="um[ "]|$)`).exec(meters(h))[0];
const ringOf = (h, name) => /<svg class="um-ring"[^>]*>.*?<\/svg>/.exec(meterOf(h, name))[0];
const attr = (s, a) => (new RegExp(`${a}="([^"]*)"`).exec(s) || [])[1];
const near = (a, b) => assert.ok(Math.abs(a - b) < 0.01, `${a} vs ${b}`);
const phoneRules = () => /@media \(max-width: 760px\) \{(.*)\}\n/.exec(css)[1];
const phoneRule = (sel) => [...phoneRules().matchAll(/([^{}]*)\{([^}]*)\}/g)].filter((m) => m[1].split(',').map((s) => s.trim()).includes(sel)).map((m) => m[2]).join(' ');
const rule = (sel) => [...css.matchAll(/(?:^|\n)([^{}\n@/ ][^{}\n]*)\{([^}]*)\}/g)].filter((m) => m[1].split(',').map((s) => s.trim()).includes(sel)).map((m) => m[2]).join(' ');

const H = html(win(22, NOW + 2 * HOUR + 29 * MIN), win(74, NOW + 4 * DAY + 14 * HOUR));

test('b1: the ring is 26 px (viewBox 0 0 26 26), radius 10.5, stroke 2.5 on the track and the arc, rotated around 13 13', () => {
  const ring = ringOf(H, '5h');
  assert.match(ring, /^<svg class="um-ring" width="26" height="26" viewBox="0 0 26 26" role="img"/);
  const track = /<circle class="um-track"[^>]*>/.exec(ring)[0];
  const arc = /<circle class="um-arc"[^>]*>/.exec(ring)[0];
  for (const c of [track, arc]) {
    assert.equal(attr(c, 'cx'), '13');
    assert.equal(attr(c, 'cy'), '13');
    assert.equal(attr(c, 'r'), '10.5');
    assert.equal(attr(c, 'stroke-width'), '2.5');
  }
  assert.equal(attr(arc, 'pathLength'), '100');
  assert.equal(attr(arc, 'stroke-dasharray'), '22 100');
  assert.equal(attr(arc, 'transform'), 'rotate(-90 13 13)');
  assert.equal(attr(/<line class="um-tick"[^>]*>/.exec(ring)[0], 'stroke-width'), '1.4');
});

test('b2: ringGeometry has the new centre, radii and font, and keeps its clamps', () => {
  const g = (p, r) => V.ringGeometry(p, r);
  const t0 = g(10, 0).tick;
  near(t0.x1, 13); near(t0.y1, 5.5); near(t0.x2, 13); near(t0.y2, 0.5);
  const t25 = g(10, 25).tick;
  near(t25.x1, 20.5); near(t25.y1, 13); near(t25.x2, 25.5); near(t25.y2, 13);
  const t40 = g(22, 40).tick;
  near(t40.x1, 17.41); near(t40.y1, 19.07); near(t40.x2, 20.35); near(t40.y2, 23.11);
  assert.equal(g(99, 5).font, 9.5);
  assert.equal(g(100, 5).font, 8);
  assert.equal(g(250, 5).font, 8);
  assert.deepEqual(g(10, 400).tick, g(10, 100).tick);
  assert.deepEqual(g(10, -30).tick, g(10, 0).tick);
  assert.deepEqual(g(10, NaN).tick, g(10, 0).tick);
  assert.equal(g(250, 5).dash, 100);
  assert.equal(g(-4, 5).dash, 0);
  assert.equal(g(null, 5).dash, null);
});

test('b3: the markup uses that geometry: the tick, and the number centred at 13 with font 9.5 (8 from 100)', () => {
  const ring = ringOf(H, '5h');
  const line = /<line class="um-tick"[^>]*>/.exec(ring)[0];
  assert.equal(attr(line, 'x1'), '13');
  assert.equal(attr(line, 'y1'), '20.5');
  assert.equal(attr(line, 'x2'), '13');
  assert.equal(attr(line, 'y2'), '25.5');
  assert.equal(ring.match(/<text [^>]*>.*?<\/text>/)[0], '<text x="13" y="16.42" text-anchor="middle" font-size="9.5" font-weight="600">22</text>');
  const full = ringOf(html(win(100, NOW + HOUR), win(5, NOW + DAY)), '5h');
  assert.equal(attr(/<text [^>]*>/.exec(full)[0], 'font-size'), '8');
});

test('b4: the no-data ring has the same geometry, an empty track, a dash, and no um-time', () => {
  const h = html(win(null, NOW + 3 * HOUR), win(50, NOW + 3 * DAY));
  const m = meterOf(h, '5h');
  assert.equal(ringOf(h, '5h'), '<svg class="um-ring" width="26" height="26" viewBox="0 0 26 26" role="img" aria-label="5h: no data"><circle class="um-track" cx="13" cy="13" r="10.5" fill="none" stroke-width="2.5"/><text x="13" y="16.42" text-anchor="middle" font-size="9.5" font-weight="600">–</text></svg>');
  assert.doesNotMatch(m, /um-time|um-left/);
});

test('b5: each window with data has an aria-hidden um-time with the compact text right after the ring; the ring says when it resets', () => {
  const five = meterOf(H, '5h');
  const seven = meterOf(H, '7d');
  assert.ok(five.includes('</svg><span class="um-time" aria-hidden="true">2h29m</span><span class="um-bar"'));
  assert.ok(seven.includes('</svg><span class="um-time" aria-hidden="true">4d14h</span><span class="um-bar"'));
  assert.equal(attr(ringOf(H, '5h'), 'aria-label'), '5h: 22% used, 50% of the window gone, resets in 2h 29m');
  assert.equal(attr(ringOf(H, '7d'), 'aria-label'), '7d: 74% used, 35% of the window gone, more than the clock, resets in 4d 14h');
  assert.equal((meters(H).match(/class="um-time"/g) || []).length, 2);
});

test('b6: the bar keeps its own aria-label (no «resets in») and the compact text is escaped; an empty time left adds nothing', () => {
  assert.match(meterOf(H, '5h'), /<span class="um-bar" role="img" aria-label="5h: 22% used, 50% of the window gone">/);
  const evil = (left) => V.usageHtml({ state: 'ok', five: { percent: 10, elapsed: 0.1, left, reset: 'x' }, seven: { percent: 10, elapsed: 0.1, left: '1d 2h', reset: 'x' } });
  const h = evil('<i>1h 2m</i>');
  assert.ok(meterOf(h, '5h').includes('<span class="um-time" aria-hidden="true">&lt;i&gt;1h2m&lt;/i&gt;</span>'));
  assert.ok(!meters(h).includes('<i>'));
  assert.ok(attr(ringOf(h, '5h'), 'aria-label').endsWith(', resets in &lt;i&gt;1h 2m&lt;/i&gt;'));
  for (const empty of ['', '   ', undefined, null, 5]) {
    const m = meterOf(evil(empty), '5h');
    assert.doesNotMatch(m, /um-time|resets in/);
  }
});

test('b7: the desktop pieces are byte-identical to RP192 for the same input', () => {
  const five = meterOf(H, '5h');
  assert.ok(five.includes('<span class="um-name">5h</span>'));
  assert.ok(five.includes('<span class="um-bar" role="img" aria-label="5h: 22% used, 50% of the window gone"><i class="um-fill" style="width:22%"></i><i class="um-pace" style="left:50%"></i></span><span class="um-pct">22%</span><span class="um-left">2h 29m</span></span>'));
  const seven = meterOf(H, '7d');
  assert.ok(seven.startsWith('<span class="um usage-warn" data-win="7d"><span class="um-name">7d</span><svg class="um-ring"'));
  assert.ok(seven.includes('<span class="um-bar" role="img" aria-label="7d: 74% used, 35% of the window gone, more than the clock"><i class="um-fill" style="width:74%"></i><i class="um-pace" style="left:35%"></i></span><span class="um-pct"><b class="um-flag" aria-hidden="true">⚠</b>74%</span><span class="um-left">4d 14h</span></span>'));
  const pop = H.slice(H.indexOf('<div class="usage-pop"'));
  assert.doesNotMatch(pop, /um-time|um-ring|<svg/);
  assert.match(pop, /<span>Resets in 2h 29m<\/span>/);
  assert.equal(V.usageHtml({ state: 'none', label: 'Claude usage: no data' }), 'Claude usage: no data');
});

test('b8: under 760 px the name hides, the time shows (11 px, muted, tabular, no wrap), um-left stays hidden; outside it um-time is hidden', () => {
  assert.match(phoneRule('.um-name'), /display:\s*none/);
  assert.match(phoneRule('.um-time'), /display:\s*inline(-block)?/);
  assert.doesNotMatch(phoneRule('.um-time'), /display:\s*none/);
  const t = phoneRule('.um-time');
  assert.match(t, /font-size:\s*11px/);
  assert.match(t, /color:\s*var\(--muted\)/);
  assert.match(t, /font-variant-numeric:\s*tabular-nums/);
  assert.match(t, /white-space:\s*nowrap/);
  const hidden = /([^{}]*)\{[^}]*display:\s*none/.exec(phoneRules())[1].split(',').map((s) => s.trim());
  for (const c of ['.um-bar', '.um-left', '.um-pct', '.um-flag']) assert.ok(hidden.includes(c), c);
  assert.ok(!hidden.includes('.um-time'));
  assert.match(rule('.um-time'), /display:\s*none/);
  assert.match(phoneRule('.um-ring'), /display:\s*inline-block/);
});

test('b9: the new rules use tokens only (no hex colours)', () => {
  assert.doesNotMatch(rule('.um-time') + phoneRule('.um-time') + phoneRule('.um-name'), /#[0-9a-fA-F]{3,8}\b/);
});
