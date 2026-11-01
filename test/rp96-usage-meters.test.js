'use strict';
// RP96 (S12, S13): the Claude usage in the header as two compact meters (5h and 7d) with a fill bar, the percent and a countdown, a pace mark
// that shows how much of the window already ran, and a popover with the detail. usageView keeps everything it returned (RP62) and adds the data
// for that; usageHtml / usageRemaining are pure. Only the 5h and 7d windows exist in the data: no monthly and no per-model. No network, no clock.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const V = require('../public/view.js');

const read = (f) => fs.readFileSync(path.join(__dirname, '..', 'public', f), 'utf8').replace(/\r\n/g, '\n');
const MIN = 60000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const NOW = Date.UTC(2026, 4, 1, 12, 0, 0);
const UTC = { now: NOW, timeZone: 'UTC' };
const win = (percent, resetAt, expired = false) => ({ percent, resetAt, expired });
const usage = (five, seven, extra = {}) => ({ available: true, five, seven, updatedAt: NOW - MIN, stale: false, ...extra });
const view = (five, seven, extra) => V.usageView(usage(five, seven, extra), UTC);
const plain = (html) => html.replace(/<[^>]*>/g, '');

// ---------- pure: the countdown ----------
test('r1: usageRemaining reads "<1m", minutes, "Xh Ym" under a day and "Xd Yh" from a day', () => {
  const t = (ms) => V.usageRemaining(ms);
  assert.deepEqual([t(0), t(59999), t(MIN), t(59 * MIN), t(HOUR), t(2 * HOUR + 29 * MIN), t(23 * HOUR + 59 * MIN), t(DAY), t(4 * DAY + 14 * HOUR + 59 * MIN)],
    ['<1m', '<1m', '1m', '59m', '1h 0m', '2h 29m', '23h 59m', '1d 0h', '4d 14h']);
  for (const bad of [NaN, -5, undefined, null, 'x', Infinity]) assert.equal(typeof V.usageRemaining(bad), 'string');
});

// ---------- pure: what usageView adds ----------
test('r2: each window carries its percent, the time left, the share of the window already run, the reset and whether it runs ahead of the clock', () => {
  const v = view(win(80, NOW + 2 * HOUR), win(40, NOW + 3.5 * DAY));
  assert.equal(v.five.percent, 80);
  assert.equal(v.five.left, '2h 0m');
  assert.equal(v.five.elapsed, 0.6, '5h window with 2 h left: 3 h of 5 gone');
  assert.equal(v.five.reset, '14:00');
  assert.equal(v.five.ahead, true, '80% used with 60% of the time gone');
  assert.equal(v.seven.left, '3d 12h');
  assert.equal(v.seven.elapsed, 0.5);
  assert.equal(v.seven.ahead, false, '40% used with 50% of the time gone');
});

test('r3: "ahead" needs more than 5 points over the clock; exactly 5 is on pace', () => {
  const ahead = (pct) => view(win(pct, NOW + 2 * HOUR), win(1, NOW + DAY)).five.ahead;
  assert.equal(ahead(65), false);
  assert.equal(ahead(66), true);
  assert.equal(ahead(10), false);
});

test('r4: a window that is a dash (null or reset) has no percent, time, share or pace, and an old file is never "ahead"', () => {
  const v = view(null, win(null, NOW - 1, true));
  for (const w of [v.five, v.seven]) assert.deepEqual([w.percent, w.left, w.elapsed, w.ahead], [null, null, null, false]);
  const old = view(win(95, NOW + HOUR), win(50, NOW + DAY), { stale: true, updatedAt: NOW - 20 * MIN });
  assert.equal(old.five.ahead, false);
  assert.equal(old.age, '20 min ago');
  assert.equal(view(win(5, NOW + HOUR), win(5, NOW + HOUR)).age, null, 'only an old file shows its age in the bar');
  assert.equal(view(win(5, NOW + HOUR), win(5, NOW + HOUR)).updated, '1 min ago', 'the popover always has the age of the data');
});

test('r5: everything usageView returned before is unchanged', () => {
  const v = view(win(72, NOW + HOUR + 30 * MIN), win(10, NOW + 5 * DAY));
  assert.equal(v.state, 'ok');
  assert.equal(v.five.text, '5h 72% ↻13:30');
  assert.equal(v.five.tone, 'warn');
  assert.equal(v.label, '5h 72% ↻13:30 · 7d 10% ↻Wed 12:00');
  assert.match(v.title, /^Claude usage: share of the 5-hour and 7-day limits used/);
});

// ---------- pure: the compact meters ----------
test('r6: the compact element has one meter per window: name, bar with fill and pace mark, percent and the countdown', () => {
  const html = V.usageHtml(view(win(72, NOW + 2 * HOUR), win(10, NOW + 3.5 * DAY)));
  assert.equal((html.match(/data-win=/g) || []).length, 2, 'one meter per window');
  assert.match(html, /<span class="um-name">5h<\/span>/);
  assert.match(html, /<span class="um-name">7d<\/span>/);
  assert.match(html, /<i class="um-fill" style="width:72%"><\/i><i class="um-pace" style="left:60%"><\/i>/);
  assert.match(html, /<i class="um-fill" style="width:10%"><\/i><i class="um-pace" style="left:50%"><\/i>/);
  assert.match(html, /<span class="um-left">2h 0m<\/span>/);
  assert.match(html, /<span class="um-left">3d 12h<\/span>/);
  assert.match(html, /role="img" aria-label="5h: 72% used, 60% of the window gone, more than the clock"/);
});

test('r7: warn and error add the tone class AND a warning mark that is not colour (⚠); a normal meter has neither', () => {
  const html = (p) => V.usageHtml(view(win(p, NOW + 2 * HOUR), win(1, NOW + DAY)));
  assert.match(html(72), /<span class="um usage-warn"[^>]*>[\s\S]*<span class="um-pct"><b class="um-flag" aria-hidden="true">⚠<\/b>72%<\/span>/);
  assert.match(html(95), /<span class="um usage-error"/);
  assert.match(html(95), /⚠<\/b>95%/);
  assert.doesNotMatch(html(30).split('7d')[0], /usage-(warn|error)|um-flag/);
  assert.match(html(95), /aria-label="5h: 95% used, 60% of the window gone, more than the clock"/, 'the label says it in words too');
});

test('r8: a dash window is a dim "–" with no bar; an old file dims both and shows its age', () => {
  const dash = V.usageHtml(view(null, win(40, NOW + DAY)));
  assert.match(dash, /<span class="um usage-dim"[^>]*><span class="um-name">5h<\/span><span class="um-pct">–<\/span><\/span>/);
  assert.equal((dash.slice(0, dash.indexOf('class="usage-pop"')).match(/<i class="um-fill"/g) || []).length, 1, 'only the real window has a bar in the compact row');
  const old = V.usageHtml(view(win(95, NOW + HOUR), win(50, NOW + DAY), { stale: true, updatedAt: NOW - 20 * MIN }));
  assert.equal((old.match(/class="um usage-dim"/g) || []).length, 2);
  assert.doesNotMatch(old, /usage-error|um-flag/);
  assert.match(old, /<span class="um-age">20 min ago<\/span>/);
});

test('r9: with no data it is only the message: no bars and no popover', () => {
  const html = V.usageHtml(V.usageView({ available: false }, UTC));
  assert.equal(html, 'Claude usage: no data');
  assert.equal(V.usageHtml(V.usageView(usage(null, null), UTC)), 'Claude usage: no data');
});

// ---------- pure: the popover ----------
test('r10: the popover has, for each window, its name, a wide bar, "N% used", "Resets in …", the exact time and how much of the window ran', () => {
  const html = V.usageHtml(view(win(72, NOW + 2 * HOUR), win(10, NOW + 3.5 * DAY)));
  const pop = html.slice(html.indexOf('class="usage-pop"'));
  assert.match(pop, /role="group" aria-label="Claude usage details"/);
  assert.match(pop, /Session \(5 h\)/);
  assert.match(pop, /Weekly \(7 d\)/);
  assert.match(pop, /72% used/);
  assert.match(pop, /Resets in 2h 0m/);
  assert.match(pop, /Resets in 3d 12h/);
  assert.match(pop, /14:00/);
  assert.match(pop, /Sun 00:00|Fri 00:00|Thu 00:00|Mon 00:00|Tue 00:00|Wed 00:00|Sat 00:00/);
  assert.match(pop, /60% of the window gone/);
  assert.match(pop, /Updated 1 min ago/);
  assert.equal((pop.match(/class="um-bar up-bar"/g) || []).length, 2);
});

test('r11: the "faster than the clock" warning is written out, and only for the window that runs ahead', () => {
  const html = V.usageHtml(view(win(80, NOW + 2 * HOUR), win(40, NOW + 3.5 * DAY)));
  const pop = html.slice(html.indexOf('class="usage-pop"'));
  assert.equal((pop.match(/Using it faster than the clock/g) || []).length, 1);
  assert.ok(pop.indexOf('Using it faster than the clock') < pop.indexOf('Weekly (7 d)'), 'it belongs to the 5 h window');
});

test('r12: a dash window in the popover says there is no data, and an old file says so', () => {
  const pop = (v) => { const h = V.usageHtml(v); return h.slice(h.indexOf('class="usage-pop"')); };
  assert.match(pop(view(null, win(40, NOW + DAY))), /Session \(5 h\)[\s\S]*No data: the window reset or is not reported/);
  assert.match(pop(view(win(95, NOW + HOUR), win(50, NOW + DAY), { stale: true, updatedAt: NOW - 20 * MIN })), /The usage file is old: the numbers may have changed/);
});

test('r13: any input gives a string, and a percent outside 0 to 100 or not a number never reaches the style attribute', () => {
  for (const v of [undefined, null, {}, { state: 'ok' }, { state: 'ok', five: 5, seven: 'x' }, { state: 'ok', five: { percent: 'x', elapsed: {} }, seven: { percent: NaN } }]) assert.equal(typeof V.usageHtml(v), 'string');
  const evil = { state: 'ok', five: { text: 'x', tone: '" onmouseover="alert(1)', percent: 1e9, elapsed: -4, left: '<b>', reset: '<i>', ahead: true }, seven: { text: 'x', tone: '', percent: '9"><script>', elapsed: 'x', left: null, reset: null, ahead: false }, label: 'l' };
  const html = V.usageHtml(evil);
  assert.doesNotMatch(html, /<script|<b>|<i>x|onmouseover="alert|<i>(?!<\/i>)/);
  assert.ok([...html.matchAll(/style="(width|left):([^"]*)"/g)].every((m) => /^\d{1,3}%$/.test(m[2]) && Number.parseInt(m[2], 10) <= 100), html);
});

// ---------- index.html, style.css and Escape ----------
test('r14: #usage can take the focus so the keyboard opens the popover, and it is still the one hidden status element of the header', () => {
  const tag = (read('index.html').match(/<[a-z0-9]+\b[^>]*\bid="usage"[^>]*>/g) || [])[0] || '';
  assert.match(tag, /\btabindex="0"/);
  assert.match(tag, /\brole="status"/);
  assert.match(tag, /(\s|^)hidden(\s|=|>|\/)/);
});

test('r15: style.css: the popover is hidden until hover or focus, hidden still works, the narrow header keeps only the percents, and the tones colour the fill', () => {
  const css = read('style.css');
  assert.match(css, /\.usage-pop\s*\{[^}]*display:\s*none/);
  assert.match(css, /\.usage:hover \.usage-pop[^{]*\{[^}]*display:\s*block/);
  assert.match(css, /\.usage:focus[^{]*\.usage-pop[^{]*\{[^}]*display:\s*block|\.usage:focus-within \.usage-pop/);
  assert.match(css, /\.usage\[hidden\]\s*\{[^}]*display:\s*none/);
  assert.match(css, /@media \(max-width:\s*\d+px\)\s*\{[^}]*\.um-bar[^}]*\.um-left[^}]*display:\s*none|@media \(max-width:\s*\d+px\)\s*\{[^}]*\.um-left[^}]*\.um-bar[^}]*display:\s*none/);
  for (const c of ['.um-fill', '.um-pace', '.um-bar', '.usage-warn .um-fill', '.usage-error .um-fill', '.usage:focus-visible']) assert.ok(css.includes(c), c);
});

function loadPage() {
  const listeners = [];
  const usageEl = { hidden: true, html: '', title: '', dataset: {}, blurred: 0, blur() { this.blurred++; }, classList: { add() {}, remove() {}, toggle() {}, contains: () => false }, style: {}, attrs: {}, setAttribute(k, v) { this.attrs[k] = v; }, addEventListener() {}, querySelector: () => null, querySelectorAll: () => [], closest: () => null, focus() {}, get innerHTML() { return this.html; }, set innerHTML(v) { this.html = String(v); } };
  const stub = () => ({ ...usageEl, html: '', blur() {} });
  const els = { '#usage': usageEl };
  const doc = { hidden: false, activeElement: null, querySelector: (s) => (els[s] ||= (s === 'meta[name=token]' ? { ...stub(), content: 'token' } : stub())), querySelectorAll: () => [], addEventListener: (type, fn) => listeners.push({ type, fn }), createElement: stub, body: stub() };
  const ctx = vm.createContext({ console, document: doc, location: { hash: '' }, localStorage: { getItem: () => null, setItem() {}, removeItem() {} }, requestAnimationFrame: () => 1, setInterval: () => 0, setTimeout: () => 0, clearTimeout: () => {}, AbortController, confirm: () => true, fetch: () => new Promise(() => {}) });
  ctx.window = ctx;
  ctx.addEventListener = () => {};
  ctx.RepoPanelView = V;
  ctx.RepoPanelResumen = require('../public/resumen.js');
  vm.runInContext(read('app.js'), ctx);
  const esc = (activeIsUsage) => { doc.activeElement = activeIsUsage ? usageEl : null; for (const l of listeners.filter((x) => x.type === 'keydown')) l.fn({ type: 'keydown', key: 'Escape', target: usageEl, preventDefault() {}, stopPropagation() {} }); };
  return { usageEl, esc };
}

test('r16: Escape with the focus on the usage element takes the focus off it (the popover closes); otherwise it does nothing to it', () => {
  const page = loadPage();
  page.esc(false);
  assert.equal(page.usageEl.blurred, 0);
  page.esc(true);
  assert.equal(page.usageEl.blurred, 1);
});
