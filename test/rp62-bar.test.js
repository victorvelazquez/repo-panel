'use strict';
// RP62 (S61, S77), design points 4 and 5: usageView (pure helper of public/view.js), the #usage element of index.html, the classes in style.css and
// the page (the real public/app.js in a vm with a stubbed DOM, a fake fetch and a fake clock). No network, no timers, no sleeps, no real clock
// and no real usage file: the page only ever talks to the fake fetch.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const V = require('../public/view.js');
const R = require('../public/resumen.js');

const PUBLIC = path.join(__dirname, '..', 'public');
const read = (f) => fs.readFileSync(path.join(PUBLIC, f), 'utf8').replace(/\r\n/g, '\n');
// The words rp69-wording keeps out of every text the person reads.
const FORBIDDEN = /\b[Pp]i (?:sessions?|prompt|screens?|terminals?|orders?)\b|\b(?:to|in|of|with) pi\b|\bpi\b|Gentle Shell/;

const MIN = 60000;
const NOW = Date.UTC(2026, 9, 31, 12, 0, 0); // Saturday 2026-10-31 12:00 UTC
const UTC = { now: NOW, timeZone: 'UTC' };
const at = (y, mo, d, h = 0, mi = 0, s = 0, ms = 0) => Date.UTC(y, mo - 1, d, h, mi, s, ms);
const win = (percent, resetAt, expired = false) => ({ percent, resetAt, expired });
const usage = (five, seven, over = {}) => ({ available: true, five, seven, updatedAt: NOW - MIN, stale: false, ...over });
const SOON = at(2026, 10, 31, 17, 50);
const NEXT = at(2026, 11, 5, 11, 0); // Thursday
const NONE_LABEL = 'Claude usage: no data';
const UNAVAILABLE = { available: false, five: null, seven: null, updatedAt: null, stale: false };
const deepFreeze = (o) => { if (o && typeof o === 'object') { Object.values(o).forEach(deepFreeze); Object.freeze(o); } return o; };

// ---------- point 4: usageView ----------
test('usageView: an ok state is { state, five, seven, label, title } with the window texts, tones and label', () => {
  const v = V.usageView(usage(win(5, SOON), win(40, NEXT)), UTC);
  assert.deepEqual(Object.keys(v), ['state', 'five', 'seven', 'label', 'title', 'age', 'updated']); // age and updated are RP96
  assert.equal(v.state, 'ok');
  assert.deepEqual(core(v.five), { text: '5h 5% ↻17:50', tone: '' });
  assert.deepEqual(core(v.seven), { text: '7d 40% ↻Thu 11:00', tone: '' });
  assert.equal(v.label, '5h 5% ↻17:50 · 7d 40% ↻Thu 11:00');
  assert.equal(typeof v.title, 'string');
  assert.ok(v.title.length > 0);
  assert.ok(!FORBIDDEN.test(v.title), v.title);
});

test('usageView: no data when usage is falsy, unavailable, or both windows are null (label and title)', () => {
  for (const [name, u] of [['undefined', undefined], ['null', null], ['unavailable', UNAVAILABLE], ['both null', usage(null, null)], ['empty', {}]]) {
    const v = V.usageView(u, UTC);
    assert.equal(v.state, 'none', name);
    assert.equal(v.label, NONE_LABEL, name);
    assert.match(v.title, /usage file/i, name);
    assert.match(v.title, /not been written yet/i, name);
    assert.match(v.title, /not reported/i, name);
    assert.ok(!FORBIDDEN.test(v.title), v.title);
  }
  assert.equal(V.usageView(undefined).state, 'none', 'the options are optional too');
});

test('usageView: both windows null with available true is "none" and the windows read "–" in dim', () => {
  const v = V.usageView(usage(null, null), UTC);
  assert.deepEqual([core(v.five), core(v.seven)], [{ text: '5h –', tone: 'dim' }, { text: '7d –', tone: 'dim' }]);
});

test('usageView: "none" wins over "old" (an unavailable file never says how old it is)', () => {
  for (const u of [{ ...UNAVAILABLE, stale: true, updatedAt: NOW - 3600000 }, usage(null, null, { stale: true, updatedAt: NOW - 3600000 })]) {
    const v = V.usageView(u, UTC);
    assert.equal(v.state, 'none');
    assert.equal(v.label, NONE_LABEL);
  }
});

test('usageView: tone is "" below 70, warn from 70, error from 90 (0, 69, 70, 89, 90, 100)', () => {
  for (const [p, tone] of [[0, ''], [1, ''], [69, ''], [70, 'warn'], [71, 'warn'], [89, 'warn'], [90, 'error'], [91, 'error'], [100, 'error']]) {
    const v = V.usageView(usage(win(p, SOON), win(p, NEXT)), UTC);
    assert.equal(v.five.tone, tone, `five ${p}`);
    assert.equal(v.seven.tone, tone, `seven ${p}`);
    assert.equal(v.five.text, `5h ${p}% ↻17:50`);
    assert.equal(v.seven.text, `7d ${p}% ↻Thu 11:00`);
  }
  const mixed = V.usageView(usage(win(95, SOON), win(10, NEXT)), UTC);
  assert.deepEqual([mixed.five.tone, mixed.seven.tone], ['error', '']);
});

test('usageView: a null window and an expired window read "–" with no reset and the dim tone; the other one is untouched', () => {
  const a = V.usageView(usage(null, win(40, NEXT)), UTC);
  assert.equal(a.state, 'ok');
  assert.deepEqual(core(a.five), { text: '5h –', tone: 'dim' });
  assert.deepEqual(core(a.seven), { text: '7d 40% ↻Thu 11:00', tone: '' });
  assert.equal(a.label, '5h – · 7d 40% ↻Thu 11:00');
  const b = V.usageView(usage(win(88, SOON), win(null, NOW - 1, true)), UTC);
  assert.equal(b.state, 'ok');
  assert.deepEqual(core(b.five), { text: '5h 88% ↻17:50', tone: 'warn' });
  assert.deepEqual(core(b.seven), { text: '7d –', tone: 'dim' });
  assert.equal(b.label, '5h 88% ↻17:50 · 7d –');
  const c = V.usageView(usage(win(80, NOW - 5, true), win(null, NOW - 9, true)), UTC);
  assert.equal(c.state, 'ok', 'an expired window is still a window: only two null windows are "no data"');
  assert.deepEqual([core(c.five), core(c.seven)], [{ text: '5h –', tone: 'dim' }, { text: '7d –', tone: 'dim' }]);
  assert.equal(c.label, '5h – · 7d –');
});

test('usageView: the reset is HH:MM (24 hours, zero padded) on the same calendar day, else a short weekday and the time', () => {
  const five = (now, reset, timeZone = 'UTC') => V.usageView(usage(win(5, reset), win(5, reset)), { now, timeZone }).five.text;
  assert.equal(five(NOW, at(2026, 10, 31, 12, 0)), '5h 5% ↻12:00', 'resetAt exactly now is still today');
  assert.equal(five(NOW, at(2026, 10, 31, 9, 5)), '5h 5% ↻09:05');
  assert.equal(five(NOW, at(2026, 10, 31, 23, 59, 59, 999)), '5h 5% ↻23:59', 'the last millisecond of today');
  assert.equal(five(NOW, at(2026, 11, 1, 0, 0)), '5h 5% ↻Sun 00:00', 'midnight is tomorrow');
  assert.equal(five(NOW, at(2026, 11, 1, 0, 5)), '5h 5% ↻Sun 00:05', 'never 24:05');
  assert.equal(five(NOW, at(2026, 11, 7, 12, 0)), '5h 5% ↻Sat 12:00', 'the same weekday next week is another day');
  assert.equal(five(at(2026, 10, 31, 23, 59, 59, 999), at(2026, 11, 1, 0, 0)), '5h 5% ↻Sun 00:00');
  assert.equal(five(at(2026, 10, 31, 23, 59, 59, 999), at(2026, 10, 31, 23, 59, 59, 999)), '5h 5% ↻23:59');
  assert.equal(five(at(2026, 11, 1, 0, 0), at(2026, 11, 1, 0, 30)), '5h 5% ↻00:30', 'just after midnight: 00:30, not 24:30');
  assert.equal(five(NOW, at(2026, 11, 2, 8, 30)), '5h 5% ↻Mon 08:30');
});

test('usageView: "today" is the calendar day in the given time zone', () => {
  const now = at(2026, 10, 31, 23, 30);
  const reset = at(2026, 11, 1, 0, 30);
  const text = (timeZone) => V.usageView(usage(win(5, reset), win(5, reset)), { now, timeZone }).five.text;
  assert.equal(text('UTC'), '5h 5% ↻Sun 00:30');
  assert.equal(text('Asia/Tokyo'), '5h 5% ↻09:30', 'in Tokyo both are 1 November');
  assert.equal(V.usageView(usage(win(5, reset), win(5, reset)), { now, timeZone: 'Asia/Tokyo' }).seven.text, '7d 5% ↻09:30');
});

test('usageView: without options it uses Date.now and the local time zone', (t) => {
  t.mock.method(Date, 'now', () => NOW);
  const u = usage(win(5, NOW + 3600000), win(40, NEXT));
  assert.deepEqual(V.usageView(u), V.usageView(u, { now: NOW }));
  assert.equal(V.usageView(u).state, 'ok');
});

test('usageView: stale is "old": every tone is dim, the texts stay, and the label ends with how old the file is', () => {
  const u = (age, over = {}) => usage(win(95, SOON), win(75, NEXT), { stale: true, updatedAt: NOW - age, ...over });
  const v = V.usageView(u(20 * MIN), UTC);
  assert.equal(v.state, 'old');
  assert.deepEqual(core(v.five), { text: '5h 95% ↻17:50', tone: 'dim' });
  assert.deepEqual(core(v.seven), { text: '7d 75% ↻Thu 11:00', tone: 'dim' });
  assert.equal(v.label, '5h 95% ↻17:50 · 7d 75% ↻Thu 11:00 · 20 min ago');
  const age = (ms) => V.usageView(u(ms), UTC).label.split(' · ').slice(2).join(' · ');
  assert.equal(age(15 * MIN), '15 min ago');
  assert.equal(age(59 * MIN), '59 min ago');
  assert.equal(age(59 * MIN + 59999), '59 min ago', 'rounded down');
  assert.equal(age(60 * MIN), '1 h ago');
  assert.equal(age(119 * MIN + 59999), '1 h ago');
  assert.equal(age(120 * MIN), '2 h ago');
  assert.equal(age(25 * 60 * MIN), '25 h ago');
  const dash = V.usageView(usage(null, win(75, NEXT), { stale: true, updatedAt: NOW - 30 * MIN }), UTC);
  assert.equal(dash.label, '5h – · 7d 75% ↻Thu 11:00 · 30 min ago');
  assert.equal(dash.five.tone, 'dim');
  assert.ok(!FORBIDDEN.test(v.title), v.title);
});

test('usageView does not change what it is given', () => {
  const u = deepFreeze(usage(win(95, SOON), win(10, NEXT), { stale: true, updatedAt: NOW - 20 * MIN }));
  const before = JSON.stringify(u);
  V.usageView(u, UTC);
  assert.equal(JSON.stringify(u), before);
});

// ---------- point 5: index.html and style.css ----------
test('index.html has <span|div id="usage" class="usage" role="status" hidden> inside the <header>, once', () => {
  const html = read('index.html');
  const tags = html.match(/<[a-z0-9]+\b[^>]*\bid="usage"[^>]*>/g) || [];
  assert.equal(tags.length, 1, 'exactly one element with id usage');
  const tag = tags[0];
  assert.match(tag, /\bclass="usage"/);
  assert.match(tag, /\brole="status"/);
  assert.match(tag, /(\s|^)hidden(\s|=|>|\/)/, 'hidden until the first answer');
  const head = html.indexOf('<header>');
  assert.ok(head >= 0 && html.indexOf(tag) > head && html.indexOf(tag) < html.indexOf('</header>'), 'inside the header');
  assert.ok(!FORBIDDEN.test(tag));
});

test('style.css defines .usage and every usage-* class the page uses (tones warn, error, dim)', () => {
  const css = read('style.css');
  const used = new Set(read('app.js').match(/\busage-[a-z]+\b/g) || []);
  assert.match(css, /(^|[\s,}])\.usage\b(?!-)/m, '.usage');
  for (const c of new Set(['usage-warn', 'usage-error', 'usage-dim', ...used])) assert.ok(new RegExp(`\\.${c}\\b`).test(css), `style.css defines .${c}`);
});

// ---------- point 5: the page ----------
function element(extra = {}) {
  const el = {
    html: '', hidden: false, dataset: {}, disabled: false, value: '', checked: false, textContent: '', title: '', attrs: {}, listeners: {}, children: [], open: false,
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    style: { setProperty(k, v) { el.style[k] = v; } },
    addEventListener(t, fn) { (el.listeners[t] ||= []).push(fn); }, setAttribute(k, v) { el.attrs[k] = v; }, querySelector: () => null, querySelectorAll: () => [], closest: () => null,
    showModal() {}, close() {}, focus() {}, append(c) { el.children.push(c); },
    get innerHTML() { return el.html; },
    set innerHTML(v) { el.html = String(v); },
    ...extra,
  };
  return el;
}
const ok = (body) => ({ ok: true, status: 200, json: async () => body });
const fail = (status) => ({ ok: false, status, statusText: 'Failed', json: async () => ({ error: 'nope' }) });
const CONFIG = { snoozed: [], dismissed: [], rooms: [], roomIssues: [], groups: [] };
const flushAll = async (n = 30) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); };

// `routes` maps an exact url to (url, opts) => a response promise; a url without a route never answers. The clock is the test's.
async function loadPage(routes = {}) {
  const els = {};
  const frames = [];
  const intervals = [];
  const fetches = [];
  const listeners = {};
  const clock = { now: NOW };
  const doc = {
    hidden: false, querySelector: (sel) => (els[sel] ||= (sel === 'meta[name=token]' ? element({ content: 'token' }) : element())), querySelectorAll: () => [],
    addEventListener(type, fn) { (listeners[type] ||= []).push(fn); }, createElement: () => element(), body: element(), activeElement: null,
  };
  doc.querySelector('#usage').hidden = true; // as in index.html
  class FakeDate extends Date { static now() { return clock.now; } }
  const ctx = vm.createContext({
    console, document: doc, location: { hash: '' }, Date: FakeDate,
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    requestAnimationFrame: (cb) => { frames.push(cb); return frames.length; },
    setInterval: (fn, ms) => { intervals.push({ fn, ms }); return intervals.length; }, setTimeout: () => 0, clearTimeout: () => {}, AbortController, confirm: () => true,
    fetch: (url, opts = {}) => {
      fetches.push({ url, method: opts.method || 'GET', headers: opts.headers || {} });
      const route = page.routes[url];
      return route ? Promise.resolve().then(() => route(url, opts)) : new Promise(() => {});
    },
  });
  const page = {
    routes: { '/api/config': () => ok(CONFIG), ...routes }, fetches, intervals, listeners, doc, clock,
    el: (sel) => doc.querySelector(sel),
    usageCalls: () => fetches.filter((f) => f.url === '/api/usage'),
    usageTimers: () => intervals.filter((i) => i.ms === 30000),
    tick: async () => { await flushAll(); while (frames.length) frames.shift()(); },
  };
  ctx.window = ctx;
  ctx.addEventListener = () => {};
  ctx.RepoPanelView = V;
  ctx.RepoPanelResumen = R;
  vm.runInContext(read('app.js'), ctx);
  await page.tick();
  return page;
}
// RP96 added keys to each window (percent, left, elapsed, reset, ahead); what RP62 pinned is its text and tone.
const core = (w) => ({ text: w.text, tone: w.tone });
const plain = (html) => html.replace(/<[^>]*>/g, '');
// RP96: the tone of each painted meter, in order ('' when it has none).
const meterTones = (html) => [...html.matchAll(/<span class="um(?: usage-([a-z]+))?" data-win=/g)].map((m) => m[1] || '');
// The painted element must show exactly view = usageView(answer, { now }) as usageHtml draws it (local time zone, like the page).
function assertPainted(page, answer) {
  const el = page.el('#usage');
  const view = V.usageView(answer, { now: page.clock.now });
  assert.equal(el.hidden, false, 'shown');
  assert.equal(el.html, V.usageHtml(view));
  assert.equal(el.title, view.state === 'none' ? view.title : '', 'the popover replaces the tooltip; a message keeps its title');
  if (view.state === 'none') {
    assert.ok(!/usage-(warn|error|dim)|um-/.test(el.html), 'no tone on a message');
    return view;
  }
  assert.deepEqual(meterTones(el.html), [view.five.tone, view.seven.tone], 'one tone class per window');
  assert.ok(!FORBIDDEN.test(el.html), el.html);
  return view;
}
const A_OK = usage(win(95, NOW + 3600000), win(40, NOW + 5 * 86400000));
const A_WARN = usage(win(72, NOW + 3600000), win(10, NOW + 5 * 86400000));
const A_OLD = usage(win(95, NOW + 3600000), win(75, NOW + 5 * 86400000), { stale: true, updatedAt: NOW - 20 * MIN });
const A_EXPIRED = usage(win(null, NOW - 1000, true), win(5, NOW + 5 * 86400000));

test('start-up: /api/usage is requested once (GET, with the token, as a background read) and the element stays hidden until it answers', async () => {
  const page = await loadPage(); // no route: the request is held
  const calls = page.usageCalls();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, 'GET');
  assert.equal(calls[0].headers['x-token'], 'token');
  assert.equal(calls[0].headers['x-priority'], undefined);
  assert.equal(page.el('#usage').hidden, true);
  assert.equal(page.el('#usage').html, '');
  assert.equal(page.usageTimers().length, 1, 'one 30 s timer');
});

test('the first answer shows the element: label, one span per window with its tone class, and the title', async () => {
  const page = await loadPage({ '/api/usage': () => ok(A_OK) });
  assert.equal(page.usageCalls().length, 1);
  const view = assertPainted(page, A_OK);
  assert.equal(view.state, 'ok');
  assert.deepEqual([view.five.tone, view.seven.tone], ['error', '']);
  assert.match(page.el('#usage').html, /data-win="5h"[^]*95%/);
});

test('every tone has its class: error from 90, warn from 70, none below, dim when expired or old', async () => {
  const none = await loadPage({ '/api/usage': () => ok(usage(win(69, NOW + 3600000), win(0, NOW + 3600000))) });
  assert.doesNotMatch(none.el('#usage').html, /usage-(warn|error|dim)/);
  for (const answer of [A_WARN, A_OK, A_EXPIRED, A_OLD]) {
    const page = await loadPage({ '/api/usage': () => ok(answer) });
    assertPainted(page, answer);
  }
  const warn = await loadPage({ '/api/usage': () => ok(A_WARN) });
  assert.deepEqual(meterTones(warn.el('#usage').html), ['warn', '']);
  const old = await loadPage({ '/api/usage': () => ok(A_OLD) });
  assert.ok(old.el('#usage').html.includes('<span class="um-age">20 min ago</span>'));
  assert.deepEqual(meterTones(old.el('#usage').html), ['dim', 'dim']);
});

test('an unavailable answer (200) shows "Claude usage: no data" with its title, not hidden and without tones', async () => {
  const page = await loadPage({ '/api/usage': () => ok(UNAVAILABLE) });
  assert.equal(page.usageCalls().length, 1);
  assert.equal(page.el('#usage').hidden, false);
  assert.equal(plain(page.el('#usage').html), NONE_LABEL);
  assertPainted(page, UNAVAILABLE);
});

test('every 30 s the timer loads again while the tab is visible and repaints; nothing is requested while it is hidden', async () => {
  let answer = A_OK;
  const page = await loadPage({ '/api/usage': () => ok(answer) });
  const [timer] = page.usageTimers();
  assert.equal(page.usageCalls().length, 1);
  answer = A_WARN;
  timer.fn();
  await page.tick();
  assert.equal(page.usageCalls().length, 2);
  assertPainted(page, A_WARN);
  page.doc.hidden = true;
  timer.fn();
  timer.fn();
  await page.tick();
  assert.equal(page.usageCalls().length, 2, 'hidden: no request');
  assertPainted(page, A_WARN);
  page.doc.hidden = false;
  timer.fn();
  await page.tick();
  assert.equal(page.usageCalls().length, 3);
});

test('the tab becoming visible loads at once; becoming hidden loads nothing', async () => {
  let answer = A_OK;
  const page = await loadPage({ '/api/usage': () => ok(answer) });
  assert.ok(page.listeners.visibilitychange && page.listeners.visibilitychange.length > 0);
  const fire = () => page.listeners.visibilitychange.forEach((f) => f());
  page.doc.hidden = true;
  fire();
  await page.tick();
  assert.equal(page.usageCalls().length, 1, 'hiding the tab requests nothing');
  answer = A_WARN;
  page.doc.hidden = false;
  fire();
  await page.tick();
  assert.equal(page.usageCalls().length, 2, 'one request at once, not at the next beat');
  assertPainted(page, A_WARN);
});

test('a request that fails keeps the last painted value: no toast, no hide, no change; the next good answer repaints', async () => {
  let next = () => ok(A_OK);
  const page = await loadPage({ '/api/usage': () => next() });
  const el = page.el('#usage');
  assertPainted(page, A_OK);
  const painted = { html: el.html, title: el.title };
  const toasts = () => page.el('#toasts').children.length;
  const before = toasts();
  const [timer] = page.usageTimers();
  const failures = [
    ['network error', () => Promise.reject(new Error('offline'))],
    ['500', () => fail(500)],
    ['invalid JSON', () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError('bad json'); } })],
    ['401', () => fail(401)],
  ];
  for (const [name, f] of failures) {
    next = f;
    timer.fn();
    await page.tick();
    assert.equal(el.hidden, false, name);
    assert.deepEqual({ html: el.html, title: el.title }, painted, name);
    assert.equal(toasts(), before, `${name}: no toast`);
  }
  assert.equal(page.usageCalls().length, 1 + failures.length);
  next = () => ok(A_WARN);
  timer.fn();
  await page.tick();
  assertPainted(page, A_WARN);
});

test('a first request that fails leaves the element hidden and empty, with no toast; a later answer shows it', async () => {
  let next = () => Promise.reject(new Error('offline'));
  const page = await loadPage({ '/api/usage': () => next() });
  const el = page.el('#usage');
  assert.equal(page.usageCalls().length, 1);
  assert.equal(el.hidden, true);
  assert.equal(el.html, '');
  assert.equal(page.el('#toasts').children.length, 0);
  next = () => ok(A_OK);
  page.usageTimers()[0].fn();
  await page.tick();
  assertPainted(page, A_OK);
});

test('an old server answers 404: the element stays hidden and empty, nothing broken, no toast', async () => {
  const page = await loadPage({ '/api/usage': () => fail(404) });
  const el = page.el('#usage');
  assert.equal(page.usageCalls().length, 1);
  assert.equal(el.hidden, true);
  assert.equal(el.html, '');
  assert.equal(el.title, '');
  assert.equal(page.el('#toasts').children.length, 0);
  page.usageTimers()[0].fn();
  await page.tick();
  assert.equal(el.hidden, true);
  assert.equal(el.html, '');
  assert.equal(page.el('#toasts').children.length, 0);
});

test('the visible texts of the page never say "pi" or "Gentle Shell", and the message says "Claude usage"', async () => {
  for (const answer of [A_OK, A_OLD, A_EXPIRED, UNAVAILABLE]) {
    const page = await loadPage({ '/api/usage': () => ok(answer) });
    const el = page.el('#usage');
    assert.ok(!FORBIDDEN.test(`${el.html} ${el.title}`), el.html + el.title);
  }
  const none = await loadPage({ '/api/usage': () => ok(UNAVAILABLE) });
  assert.match(none.el('#usage').html, /Claude usage/);
});
