'use strict';
// RP158 (S26, S49): the filter «Working now» of the list of repos. An icon next to the flag of Needs attention (same look: pressed is on, with the number of cards) that shows only the repos with a LIVE session and hides the ones
// whose session is not started or was closed. A live session is working (which includes starting), asking you, or free: a session that finished its cycle goes from busy to free and stays alive, so it is NOT hidden. What is not known is
// not hidden either (an unknown or loading state, a row with no session). It is independent of the flag (both can be on: the intersection), «Clear» turns it off, it shows as a chip of active filter, the room cards go out while it is on,
// and the page remembers it across reloads (localStorage, like the widths of the columns). It reads what the card already knows (r.session.state): no new reads, nothing from the server.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { appSource } = require('./pagesrc.js');
const V = require('../public/view.js');
const R = require('../public/resumen.js');

const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'style.css'), 'utf8').replace(/\r\n/g, '\n');
const KEY = 'repo-panel.live';
const row = (name, session, o = {}) => ({ id: `id-${name}`, name, group: 'G', room: null, branch: 'main', needs: false, rank: 9, progress: { total: null }, next: null, blocking: [], lastMovement: {}, session, action: null, ...o });
const ROWS = [
  row('r-working', { state: 'working' }), row('r-waiting', { state: 'waiting' }, { needs: true, rank: 1 }), row('r-free', { state: 'free' }),
  row('r-none', { state: 'none' }), row('r-none-needs', { state: 'none' }, { needs: true, rank: 2 }), row('r-unknown', { state: 'unknown' }),
  row('r-nosession', undefined), row('r-bogus', { state: 'bogus' }), row('r-badstate', { state: 5 }),
];
const payload = { rows: ROWS, generatedAt: 'x' };
const names = (html) => [...html.matchAll(/class="rs-name"[^>]*>([^<]+)</g)].map((m) => m[1].trim());
const view = (ctx) => names(R.summaryView(payload, ctx));

// ---------- the filter (pure) ----------
test('f1: with the filter on only the sessions that are NOT «none» stay: working, asking, free, and everything that is not known; with it off every card shows', () => {
  assert.deepEqual(view({ live: false }).sort(), ROWS.map((r) => r.name).sort());
  assert.deepEqual(view({}).sort(), ROWS.map((r) => r.name).sort());
  assert.deepEqual(view({ live: true }).sort(), ['r-badstate', 'r-bogus', 'r-free', 'r-nosession', 'r-unknown', 'r-waiting', 'r-working']);
});

test('f2: only the boolean true turns it on: any other value is no filter', () => {
  for (const v of ['true', 1, 'on', {}, [], 'yes', null, undefined, 0, false]) assert.equal(view({ live: v }).length, ROWS.length, String(v));
});

test('f3: it counts what it shows, with the scope, the group and the text, and it is the intersection with Needs attention', () => {
  assert.equal(R.listCount(payload, { live: true }), 7);
  assert.equal(R.listCount(payload, { live: false }), 9);
  assert.equal(R.listCount(payload, { live: true, filter: 'attention' }), 1, 'only the asking one needs attention and has a session');
  assert.equal(R.listCount(payload, { live: false, filter: 'attention' }), 2);
  assert.equal(R.listCount(payload, { live: true, q: 'FREE' }), 1);
  assert.equal(R.listCount(payload, { live: true, group: 'Other' }), 0);
  assert.deepEqual(view({ live: true, filter: 'attention' }), ['r-waiting']);
});

test('f4: when nothing is live the list says so (and it does not say «no repositories in this scope»)', () => {
  const none = { rows: [row('a', { state: 'none' }), row('b', { state: 'none' })], generatedAt: 'x' };
  assert.match(R.summaryView(none, { live: true }), /No repository has a session open right now/);
  assert.doesNotMatch(R.summaryView(none, { live: true }), /No repositories in this scope/);
  assert.match(R.summaryView(none, { live: false }), /rs-name/);
  assert.match(R.summaryView({ rows: [], generatedAt: 'x' }, { live: true }), /No repositories in this scope|No repository has a session open/);
});

test('f5: the room cards go out while the filter is on (a room has no session)', () => {
  const rooms = { rooms: [{ name: 'Team' }] };
  const withRoom = { rows: [row('a', { state: 'free' }, { room: 'Team' })], generatedAt: 'x' };
  assert.match(R.summaryView(withRoom, { live: false, roomData: rooms, rooms: ['Team'] }), /chip purple">room/);
  assert.doesNotMatch(R.summaryView(withRoom, { live: true, roomData: rooms, rooms: ['Team'] }), /chip purple">room/);
});

test('f6: a payload that is not valid and a hostile name never break it: names are escaped', () => {
  for (const bad of [null, undefined, 5, 'x', {}, { rows: 'x' }]) assert.doesNotThrow(() => R.summaryView(bad, { live: true }));
  assert.equal(R.listCount(null, { live: true }), null);
  const evil = { rows: [row('<img src=x onerror=alert(1)>', { state: 'free' })], generatedAt: 'x' };
  assert.doesNotMatch(R.summaryView(evil, { live: true }), /<img/);
});

// ---------- the icon and the chip ----------
test('i1: the icon is next to the flag, a pressed-state button with the count in its label, and the button sets the value it is NOT in', () => {
  const off = R.summaryTools(payload, { compact: true, live: false });
  assert.match(off, /class="lh-ic lh-att on"[\s\S]*?<\/button><button type="button" class="lh-ic lh-live on" data-act="slive" data-live="on" aria-pressed="false" aria-label="Working now · 7" title="Working now · 7"><svg [^>]*aria-hidden="true"[^>]*>[\s\S]*?<\/svg><small>7<\/small><\/button>/);
  const on = R.summaryTools(payload, { compact: true, live: true });
  assert.match(on, /class="lh-ic lh-live on" data-act="slive" data-live="off" aria-pressed="true" aria-label="Working now · 7"/);
});

test('i2: the number is how many repos of the scope, group and text have a live session; with none it is 0 and the icon is not marked on', () => {
  const none = { rows: [row('a', { state: 'none' })], generatedAt: 'x' };
  const h = R.summaryTools(none, { compact: true });
  assert.match(h, /class="lh-ic lh-live" data-act="slive" data-live="on" aria-pressed="false" aria-label="Working now · 0"/);
  assert.match(R.summaryTools(payload, { compact: true, q: 'free' }), /aria-label="Working now · 1"/);
  assert.equal(R.summaryTools(null, { compact: true }), '');
  assert.equal(R.summaryTools({ rows: 'x' }, { compact: true, live: true }), '');
});

test('i3: the chip of the active filter comes only when it is on, before Needs attention, and Clear shows with it', () => {
  assert.doesNotMatch(R.listHeadChips({ live: false }), /Working now/);
  assert.equal(R.listHeadChips({}), '');
  const h = R.listHeadChips({ live: true, filter: 'attention' });
  assert.match(h, /<button type="button" data-act="slive" data-live="off">Working now ✕<\/button><button type="button" data-act="sfilter" data-filter="all">Needs attention ✕<\/button>/);
  assert.match(R.listHeadChips({ live: true }), /Working now ✕<\/button><button type="button" class="lh-clr" data-act="lh-clear">Clear<\/button>/);
});

test('c1: the icon looks like the flag: green when it has cards, a green frame when pressed, a visible focus ring', () => {
  const rules = [...css.matchAll(/(?:^|\n)([^{}\n@/ ][^{}\n]*)\{([^}]*)\}/g)].flatMap((m) => m[1].split(',').map((s) => ({ sel: s.trim().replace(/\s+/g, ' '), body: m[2] })));
  const rule = (sel) => { const r = rules.filter((x) => x.sel === sel); assert.ok(r.length, `a rule for ${sel}`); return r.map((x) => x.body).join(';'); };
  assert.match(rule('.lh-live.on'), /color:\s*var\(--green\)/);
  assert.match(rule('.lh-live[aria-pressed="true"]'), /border-color:\s*var\(--green\)/);
});

// ---------- the page ----------
function element(extra = {}) {
  const el = {
    html: '', hidden: false, dataset: {}, disabled: false, value: '', checked: false, textContent: '', title: '', placeholder: '', attrs: {}, listeners: {}, children: [], open: false,
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    style: { setProperty(k, v) { el.style[k] = v; } },
    addEventListener(t, fn) { (el.listeners[t] ||= []).push(fn); }, setAttribute(k, v) { el.attrs[k] = v; }, querySelector: () => null, querySelectorAll: () => [], closest: () => null,
    showModal() {}, close() {}, focus() {}, append(c) { el.children.push(c); },
    get innerHTML() { return el.html; }, set innerHTML(v) { el.html = String(v); }, ...extra,
  };
  return el;
}
async function boot({ stored } = {}) {
  const els = {};
  const frames = [];
  const writes = [];
  const store = new Map(stored === undefined ? [] : [[KEY, stored]]);
  const tabEls = ['summary', 'work', 'conformity', 'settings'].map((t) => element({ dataset: { tab: t } }));
  const get = (sel) => (els[sel] ||= (sel === 'meta[name=token]' ? element({ content: 'token' }) : element()));
  get('#sumLayout').clientWidth = 1200;
  const doc = { hidden: false, querySelector: get, querySelectorAll: (s) => (String(s).includes('data-tab') ? tabEls : []), addEventListener() {}, createElement: () => element(), body: element(), activeElement: null };
  const sandbox = {
    console, document: doc, TextDecoder, AbortController, confirm: () => true, location: { hash: '', pathname: '/panel/', search: '' }, history: { pushState() {}, replaceState() {}, back() {} },
    localStorage: { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem(k, v) { writes.push([k, v]); store.set(k, v); }, removeItem(k) { store.delete(k); } },
    requestAnimationFrame: (cb) => { frames.push(cb); return frames.length; }, setInterval: () => 0, setTimeout: () => 0, clearTimeout: () => {}, clearInterval: () => {},
    fetch: (url) => (String(url).startsWith('/api/config') ? Promise.resolve({ ok: true, json: async () => ({ groups: [{ name: 'G', repos: ROWS.map((r) => ({ id: r.id, name: r.name, path: `p-${r.name}` })) }], snoozed: [], dismissed: [], rooms: [], roomIssues: [] }) }) : new Promise(() => {})),
  };
  const ctx = vm.createContext(sandbox);
  ctx.window = ctx;
  ctx.addEventListener = () => {};
  ctx.RepoPanelView = V;
  ctx.RepoPanelResumen = R;
  vm.runInContext(appSource(), ctx);
  const flush = () => { while (frames.length) frames.shift()(); };
  const tick = async (n = 10) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); flush(); };
  await tick();
  return {
    get, tick, writes, store, run: (code) => vm.runInContext(code, ctx),
    state: (expr) => vm.runInContext(expr, ctx),
    click: async (act, dataset = {}) => { vm.runInContext(`ACTIONS[${JSON.stringify(act)}]({ dataset: ${JSON.stringify(dataset)} })`, ctx); await tick(); },
    show: async () => { vm.runInContext(`S.summary = ${JSON.stringify(payload)}; draw()`, ctx); await tick(); },
    list: () => names(get('#summary').html),
  };
}

test('p1: the action sets the value it is told, remembers it, and anything that is not «on» is off', async () => {
  const page = await boot();
  assert.equal(page.state('S.slive'), false);
  await page.click('slive', { live: 'on' });
  assert.equal(page.state('S.slive'), true);
  assert.deepEqual(page.writes.at(-1), [KEY, 'true']);
  await page.click('slive', { live: 'on' });
  assert.equal(page.state('S.slive'), true, 'twice on is still on');
  await page.click('slive', { live: 'off' });
  assert.equal(page.state('S.slive'), false);
  assert.deepEqual(page.writes.at(-1), [KEY, 'false']);
  await page.click('slive', { live: 'on' });
  for (const junk of [{}, { live: 'ON' }, { live: 'true' }, { live: '' }, { live: 1 }]) { await page.click('slive', { live: 'on' }); await page.click('slive', junk); assert.equal(page.state('S.slive'), false, JSON.stringify(junk)); }
});

test('p2: the page remembers it across reloads: a saved true is on, and a saved value that is anything else is off', async () => {
  assert.equal(await (await boot({ stored: 'true' })).state('S.slive'), true);
  for (const bad of ['false', '', 'null', '1', '"true"', '{"x":1}', 'maybe', '[true]']) assert.equal(await (await boot({ stored: bad })).state('S.slive'), false, JSON.stringify(bad));
  assert.equal(await (await boot()).state('S.slive'), false);
});

test('p3: Clear turns it off (and the saved value with it), together with the other filters', async () => {
  const page = await boot({ stored: 'true' });
  page.run("S.q = 'x'; S.sfilter = 'attention'");
  await page.click('lh-clear');
  assert.equal(page.state('S.slive'), false);
  assert.equal(page.state('S.sfilter'), 'all');
  assert.deepEqual(page.writes.at(-1), [KEY, 'false']);
});

test('p4: drawn in the page: with the filter on the list, the count, the chip and the pressed icon follow it', async () => {
  const page = await boot();
  await page.show();
  assert.equal(page.list().length, ROWS.length);
  assert.equal(page.get('#lhCount').textContent, String(ROWS.length));
  await page.click('slive', { live: 'on' });
  assert.deepEqual(page.list().sort(), ['r-badstate', 'r-bogus', 'r-free', 'r-nosession', 'r-unknown', 'r-waiting', 'r-working']);
  assert.equal(page.get('#lhCount').textContent, '7');
  assert.match(page.get('#lhActive').html, /Working now ✕/);
  assert.match(page.get('#lhAttention').html, /lh-live[^>]*aria-pressed="true"/);
  await page.click('sfilter', { filter: 'attention' });
  assert.deepEqual(page.list(), ['r-waiting']);
  assert.equal(page.get('#lhCount').textContent, '1');
  await page.click('slive', { live: 'off' });
  assert.deepEqual(page.list().sort(), ['r-none-needs', 'r-waiting']);
});

test('p5: the filter drawn from a saved true shows at the first draw (the page opens already filtered)', async () => {
  const page = await boot({ stored: 'true' });
  await page.show();
  assert.ok(!page.list().includes('r-none') && !page.list().includes('r-none-needs'));
  assert.ok(page.list().includes('r-free'), 'a free session stays: it finished its cycle and is still open');
});
