'use strict';
// RP144 (S32): the usage bars of the header (5h and 7d) are painted by consumption: green under 70 percent, yellow from 70, red from 90, and grey ONLY when the usage file is old. The fill was grey
// (`var(--muted)`) in the normal state and only changed at the two thresholds of public/view.js, so with a normal use of 16 and 22 percent the person always saw two grey bars. The tone classes already
// exist (`usage-warn`, `usage-error`, `usage-dim`); the fix is the base colour and keeping the old file grey. These tests do not look at one rule alone: they build the real markup for several percents and
// resolve the colour of the fill with the real stylesheet, so a threshold, a class or a rule that drifts shows up. How it LOOKS was measured in the real panel and is for the person to try.
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
const view = (five, seven, extra) => V.usageView({ available: true, five, seven, updatedAt: NOW - MIN, stale: false, ...extra }, { now: NOW, timeZone: 'UTC' });

// The top-level rules of the stylesheet, one entry per selector of a list.
const rules = [...css.matchAll(/(?:^|\n)([^{}\n@/ ][^{}\n]*)\{([^}]*)\}/g)].flatMap((m) => m[1].split(',').map((s) => ({ sel: s.trim().replace(/\s+/g, ' '), body: m[2] })));
const bg = (body) => (/(?:^|[;\s])background:\s*([^;]+)/.exec(body) || [])[1];
// Which colour does the fill get for a meter of this tone? The rules that match are `.um-fill` and, with a tone, `.usage-<tone> .um-fill`; the one with more classes wins.
function fillColour(tone) {
  const hits = rules.filter((r) => r.sel === '.um-fill' || (tone && r.sel === `.usage-${tone} .um-fill`));
  hits.sort((a, b) => (b.sel.match(/\./g) || []).length - (a.sel.match(/\./g) || []).length);
  const winner = hits.map((r) => bg(r.body)).find(Boolean);
  return winner ? winner.trim() : null;
}
const toneOfMeter = (html, win_) => (new RegExp(`<span class="um(?: usage-(warn|error|dim))?" data-win="${win_}"`).exec(html) || [])[1] || '';
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

test('t1: with a normal use the fill is GREEN (it was grey): under the first threshold, from 0 to 69 percent', () => {
  for (const p of [0, 1, 16, 22, 50, 69]) {
    const html = V.usageHtml(view(win(p, NOW + 2 * HOUR), win(p, NOW + DAY)));
    for (const w of ['5h', '7d']) {
      const tone = toneOfMeter(html, w);
      assert.equal(tone, '', `${p}% ${w} has no tone class`);
      assert.equal(fillColour(tone), 'var(--green)', `${p}% ${w}`);
    }
  }
});

test('t2: the thresholds are the ones that were: yellow from 70 to 89 percent, red from 90 to 100', () => {
  for (const p of [70, 72, 89]) assert.equal(fillColour(toneOfMeter(V.usageHtml(view(win(p, NOW + HOUR), win(1, NOW + DAY))), '5h')), 'var(--yellow)', `${p}%`);
  for (const p of [90, 95, 100]) assert.equal(fillColour(toneOfMeter(V.usageHtml(view(win(p, NOW + HOUR), win(1, NOW + DAY))), '5h')), 'var(--red)', `${p}%`);
});

test('t3: an OLD usage file keeps the bars grey and dim, whatever the percent (grey now means: the number may have changed)', () => {
  for (const p of [5, 72, 95]) {
    const html = V.usageHtml(view(win(p, NOW + HOUR), win(p, NOW + DAY), { stale: true, updatedAt: NOW - 20 * MIN }));
    for (const w of ['5h', '7d']) {
      assert.equal(toneOfMeter(html, w), 'dim', `${p}% ${w}`);
      assert.equal(fillColour('dim'), 'var(--gray)');
    }
  }
  assert.ok(rules.some((r) => r.sel === '.usage-dim .um-fill'), 'a rule exists for the dim fill: without it the old file would turn green');
});

test('t4: the bars of the detail that opens on hover get the same colour as the compact ones', () => {
  for (const [p, want] of [[16, 'var(--green)'], [72, 'var(--yellow)'], [95, 'var(--red)']]) {
    const html = V.usageHtml(view(win(p, NOW + 2 * HOUR), win(1, NOW + DAY)));
    const pop = html.slice(html.indexOf('class="usage-pop"'));
    const m = /<div class="up-win(?: usage-(warn|error|dim))?">.*?class="um-bar up-bar"[^>]*><i class="um-fill"/s.exec(pop);
    assert.ok(m, `${p}% the detail has a fill inside an up-win`);
    assert.equal(fillColour(m[1] || ''), want, `${p}% detail`);
    assert.equal(m[1] || '', toneOfMeter(html, '5h'), 'the detail has the tone of its meter');
  }
});

test('t5: a window with no data draws no bar at all (so no green bar for a missing number)', () => {
  const html = V.usageHtml(view(null, win(40, NOW + DAY)));
  const compact = html.slice(0, html.indexOf('class="usage-pop"'));
  assert.equal((compact.match(/class="um-fill"/g) || []).length, 1, 'only the real window has a fill');
  assert.match(compact, /<span class="um usage-dim" data-win="5h"><span class="um-name">5h<\/span><span class="um-pct">–<\/span><\/span>/);
});

test('t6: colour is not the only signal: the number is there, warn and error add the warning mark, and the label says it in words', () => {
  const ok = V.usageHtml(view(win(16, NOW + 2 * HOUR), win(22, NOW + DAY)));
  assert.match(ok, /<span class="um-pct">16%<\/span>/);
  assert.match(ok, /aria-label="5h: 16% used,/);
  assert.doesNotMatch(ok.slice(0, ok.indexOf('class="usage-pop"')), /um-flag/, 'a normal meter has no warning mark');
  const warn = V.usageHtml(view(win(72, NOW + 2 * HOUR), win(1, NOW + DAY)));
  assert.match(warn, /<b class="um-flag" aria-hidden="true">⚠<\/b>72%/);
  const bad = V.usageHtml(view(win(95, NOW + 2 * HOUR), win(1, NOW + DAY)));
  assert.match(bad, /<b class="um-flag" aria-hidden="true">⚠<\/b>95%/);
});

test('t7: every fill colour reads against the track of the bar (a graphic: 3:1 or more on --panel2), and the old grey fill is no longer the base', () => {
  const track = token('panel2');
  for (const name of ['green', 'yellow', 'red', 'gray']) assert.ok(contrast(token(name), track) >= 3, `--${name} on --panel2: ${contrast(token(name), track).toFixed(2)}`);
  assert.notEqual(fillColour(''), 'var(--muted)', 'the base fill is not the grey of a muted text any more');
  assert.equal(fillColour('warn'), 'var(--yellow)');
  assert.equal(fillColour('error'), 'var(--red)');
});

test('t8: nothing else of the meters changed: the pace mark, the track and the text tones keep their rules', () => {
  assert.match(rules.find((r) => r.sel === '.um-pace').body, /background:\s*var\(--text\)/);
  assert.match(rules.find((r) => r.sel === '.um-bar').body, /background:\s*var\(--panel2\)/);
  assert.match(rules.find((r) => r.sel === '.usage-warn').body, /color:\s*var\(--yellow\)/);
  assert.match(rules.find((r) => r.sel === '.usage-error').body, /color:\s*var\(--red\)/);
  assert.match(rules.find((r) => r.sel === '.usage-dim').body, /color:\s*var\(--gray\)/);
});
