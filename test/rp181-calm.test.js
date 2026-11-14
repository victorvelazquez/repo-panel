'use strict';
// RP181: a calmer panel. The spinning "Updating" indicator of the header is gone (it was on all the time, so it told nothing); a quiet notice shows only
// when the page has had no answer from the server for 90 s while it is visible, and goes away by itself; coming back to the app (visibility, pageshow, online)
// asks for the Summary and the chat at once. The "Updating..." of the Tasks tab stays: it answers a button the person pressed.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8').replace(/\r\n/g, '\n');
const V = require('../public/view.js');
const { appSource } = require('./pagesrc.js');
const vm = require('node:vm');

test('S1: the header has no Updating indicator, no CSS for it and no code that drives it', () => {
  const html = read('public', 'index.html');
  assert.doesNotMatch(html, /id="syncState"/);
  assert.doesNotMatch(html, /↻ Updating|> Updating</);
  const css = read('public', 'style.css');
  assert.doesNotMatch(css, /\.sync\b/);
  assert.doesNotMatch(appSource(), /syncRefreshIcon|syncState/);
});

test('S1: the Updating line of the Tasks tab (an answer to its own button) is still there', () => {
  assert.match(read('public', 'resumen.js'), /ctx\.refreshing \? 'Updating…'/);
});

test('S2: the page has a quiet, hidden-by-default notice with role status, and it is not the red "outdated" banner', () => {
  const html = read('public', 'index.html');
  const m = /<div id="stalled"([^>]*)>([^<]+)<\/div>/.exec(html);
  assert.ok(m, 'a #stalled element');
  assert.match(m[1], /class="stalled"/);
  assert.match(m[1], /role="status"/);
  assert.match(m[1], /\bhidden\b/);
  assert.match(m[2], /not updating/i);
  const css = read('public', 'style.css');
  assert.match(css, /\.stalled\s*\{/);
  assert.match(css, /\.stalled\[hidden\]\s*\{\s*display:\s*none/);
});

test('stalledNow: true only when the page is visible and 90 s have passed since the later of the last answer and the moment it became visible', () => {
  assert.equal(V.STALLED_MS, 90000);
  const base = { now: 1_000_000, aliveAt: 1_000_000 - 91_000, visibleAt: 0, hidden: false };
  assert.equal(V.stalledNow(base), true);
  assert.equal(V.stalledNow({ ...base, aliveAt: 1_000_000 - 90_000 }), false, 'exactly 90 s is not yet');
  assert.equal(V.stalledNow({ ...base, aliveAt: 1_000_000 - 89_999 }), false);
  assert.equal(V.stalledNow({ ...base, hidden: true }), false, 'a page nobody sees says nothing');
  assert.equal(V.stalledNow({ ...base, visibleAt: 1_000_000 - 5_000 }), false, 'it just woke up: the 90 s count from then, so no flash');
  assert.equal(V.stalledNow({ ...base, visibleAt: 1_000_000 - 91_000 }), true);
});

test('stalledNow: a value that is not a time never raises the notice', () => {
  for (const bad of [undefined, null, NaN, 'x', {}]) {
    assert.equal(V.stalledNow({ now: 1_000_000, aliveAt: bad, visibleAt: 0, hidden: false }), false, String(bad));
    assert.equal(V.stalledNow({ now: bad, aliveAt: 0, visibleAt: 0, hidden: false }), false, String(bad));
  }
  assert.equal(V.stalledNow(null), false);
  assert.equal(V.stalledNow(), false);
});

test('S2: every good answer of the server, and every byte of the event stream, counts as alive', () => {
  const data = read('public', 'data.js');
  const api = /async function api\([\s\S]*?\n\}\n/.exec(data)[0];
  assert.match(api, /S\.aliveAt = Date\.now\(\)/);
  assert.ok(api.indexOf('S.aliveAt') > api.indexOf('if (!res.ok)'), 'only after a good answer');
  assert.match(read('public', 'feed.js'), /ev\.lastByteAt = Date\.now\(\);\s*S\.aliveAt = ev\.lastByteAt;|S\.aliveAt = Date\.now\(\)/);
  assert.match(read('public', 'app.js'), /aliveAt: Date\.now\(\)/);
});

test('S2: a timer toggles the notice from the pure rule, and it never touches anything else', () => {
  const src = appSource();
  assert.match(src, /V\.stalledNow\(/);
  assert.match(src, /\$\('#stalled'\)\.hidden = /);
  assert.match(src, /setInterval\(stalledTick, \d+\)/);
});

test('S3: coming back asks for the Summary and the chat at once, on visibility, pageshow and online', () => {
  const app = read('public', 'app.js');
  const fn = /function comeBack\(\)[\s\S]*?\n\}\n/.exec(app);
  assert.ok(fn, 'comeBack()');
  assert.match(fn[0], /S\.visibleAt = Date\.now\(\)/);
  assert.match(fn[0], /summaryTick\(\)/);
  assert.match(fn[0], /chatTick\(\)/);
  assert.match(fn[0], /stalledTick\(\)/);
  assert.match(app, /addEventListener\('pageshow', \(e\) => \{ if \(e\.persisted\) comeBack\(\); \}\)/);
  assert.match(app, /addEventListener\('online', comeBack\)/);
  const vis = /document\.addEventListener\('visibilitychange', \(\) => \{[\s\S]*?\n\}\);/.exec(app)[0];
  assert.match(vis, /comeBack\(\)/);
  assert.ok(vis.indexOf('if (document.hidden)') < vis.indexOf('comeBack()'), 'only when it becomes visible, never when it hides');
});

test('S3: what the old visibility handler did is still there (events, usage, the board)', () => {
  const vis = /document\.addEventListener\('visibilitychange', \(\) => \{[\s\S]*?\n\}\);/.exec(read('public', 'app.js'))[0];
  for (const k of ['flushNotes()', 'stopEvents()', 'loadUsage()', 'startEvents()', 'quietTick()', 'loadBoard()', 'refreshAll()']) assert.ok(vis.includes(k), k);
});

test('S4: there is no pull-to-refresh (no drag handler, no pull gesture; a passive touchstart that only marks the chat for the keyboard, RP183, is not one)', () => {
  assert.doesNotMatch(appSource(), /touchmove|touchend|pull-to-refresh|pullToRefresh/i);
});

// The real stalledTick, taken from app.js and run against a fake element: what the person would see.
function stalledRig({ aliveAgo, visibleAgo = 1_000_000, hidden = false }) {
  const NOW = 10_000_000;
  const el = { hidden: true };
  const src = /function stalledTick\(\) \{[^\n]*\n/.exec(read('public', 'app.js'));
  assert.ok(src, 'stalledTick() in app.js');
  const ctx = { $: (sel) => (sel === '#stalled' ? el : null), V, S: { aliveAt: NOW - aliveAgo, visibleAt: NOW - visibleAgo }, document: { hidden }, Date: { now: () => NOW } };
  vm.runInNewContext(`${src[0]}\nstalledTick();`, ctx);
  return el;
}

test('stalledTick: the notice shows when the server has been silent for more than 90 s, and stays hidden otherwise', () => {
  assert.equal(stalledRig({ aliveAgo: 91_000 }).hidden, false, 'silent for 91 s: shown');
  assert.equal(stalledRig({ aliveAgo: 20_000 }).hidden, true, 'a recent answer: hidden');
  assert.equal(stalledRig({ aliveAgo: 91_000, hidden: true }).hidden, true, 'a page nobody sees: hidden');
  assert.equal(stalledRig({ aliveAgo: 91_000, visibleAgo: 3_000 }).hidden, true, 'it just came back: hidden, no flash');
});
