'use strict';
// RP111b, the page: a fourth tab «Settings» (artboard A, a grouped list). The options of the PANEL (config.json, through the closed list of `/api/settings`, and «pi to use» through
// the route that already exists) and the options of THIS BROWSER (the preferences that already exist) are rows with their control on the right, their default and where they are saved.
// What does not exist yet is shown disabled and marked «Planned». The real page runs in a vm with a fake fetch: no timers, no network.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { appSource } = require('./pagesrc.js');

const R = require('../public/resumen.js');
const V = require('../public/view.js');

const INDEX = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

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
function loadPage(answers) {
  const els = {};
  const frames = [];
  const fetches = [];
  const classes = new Set();
  const tabEls = ['summary', 'work', 'conformity', 'settings'].map((t) => element({ dataset: { tab: t } }));
  const get = (sel) => (els[sel] ||= (sel === 'meta[name=token]' ? element({ content: 'token' }) : element()));
  const body = element({ classList: { add() {}, remove() {}, contains: (c) => classes.has(c), toggle(c, on) { if (on) classes.add(c); else classes.delete(c); } } });
  const doc = { hidden: false, querySelector: get, querySelectorAll: (s) => (String(s).includes('data-tab') ? tabEls : []), addEventListener() {}, createElement: () => element(), body, activeElement: null };
  const store = {};
  const ctx = vm.createContext({
    console, document: doc, location: { hash: '' }, TextDecoder, AbortController, confirm: () => true,
    localStorage: { getItem: (k) => (k in store ? store[k] : null), setItem(k, v) { store[k] = String(v); }, removeItem(k) { delete store[k]; } },
    requestAnimationFrame: (cb) => { frames.push(cb); return frames.length; }, setInterval: () => 0, setTimeout: () => 0, clearTimeout: () => {},
    fetch: (url, opts = {}) => {
      fetches.push({ url, method: opts.method || 'GET', body: opts.body });
      const a = Object.entries(answers).find(([k]) => url.startsWith(k));
      if (!a) return new Promise(() => {});
      return typeof a[1] === 'function' ? a[1](url, opts) : Promise.resolve({ ok: true, json: async () => a[1] });
    },
  });
  ctx.window = ctx;
  ctx.addEventListener = () => {};
  ctx.RepoPanelView = V;
  ctx.RepoPanelResumen = R;
  vm.runInContext(appSource(), ctx);
  const flush = () => { while (frames.length) frames.shift()(); };
  const tick = async (n = 8) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); flush(); };
  return { get, fetches, tick, tabEls, classes, store, run: (code) => vm.runInContext(code, ctx) };
}
const reply = (b) => Promise.resolve({ ok: true, json: async () => b });
const fail = (status, b) => Promise.resolve({ ok: false, status, statusText: 'Failed', json: async () => b });
const PI = { mode: 'auto', active: 'gentle-shell', candidates: [{ id: 'gentle-shell', label: 'Gentle Shell', available: true, version: '4.6.0' }, { id: 'pi', label: 'pi (original)', available: true, version: '0.9.2' }, { id: 'gone', label: 'Gone <b>', available: false }] };
const OPTIONS = { options: [{ key: 'chat.showResults', value: false, default: false }] };
// the longer routes first: the fake fetch takes the first key the url starts with
const answers = (extra = {}) => ({ '/api/pi-runtime': PI, '/api/prerequisites': { items: [] }, '/api/settings': OPTIONS, '/api/events': () => new Promise(() => {}), ...extra });
async function openSettings(extra) {
  const page = loadPage(answers(extra));
  page.run("ACTIONS.tab({ dataset: { tab: 'settings' } })");
  await page.tick();
  return page;
}
const html = (page) => page.get('#settingsView').html;
const switchOf = (h, key) => new RegExp(`<button type="button" class="st-sw" role="switch" aria-checked="(true|false)"[^>]*data-key="${key.replace(/\./g, '\\.')}"[^>]*>`).exec(h);

// ---------- the tab ----------
test('index.html: a Settings tab button after Conformity and its full-width panel, hidden at the start', () => {
  assert.match(INDEX, /<button type="button" role="tab" class="hd-icon" id="tab-settings" data-act="tab" data-tab="settings" aria-selected="false" aria-controls="settingsView" aria-label="Settings" title="Settings">/);
  assert.match(INDEX, /<section id="settingsView" class="rs-panel" role="tabpanel" aria-labelledby="tab-settings" hidden><\/section>/);
  assert.ok(INDEX.indexOf('id="tab-conformity"') < INDEX.indexOf('id="tab-settings"'));
});

test('opening the tab shows its panel and hides the others, marks the tab, reads the options and the pi runtimes, and is NOT remembered for the next load', async () => {
  const page = await openSettings();
  assert.equal(page.run('S.tab'), 'settings');
  assert.equal(page.get('#settingsView').hidden, false);
  for (const sel of ['#sumLayout', '#work', '#conformityView']) assert.equal(page.get(sel).hidden, true, sel);
  assert.deepEqual(page.tabEls.map((b) => b.attrs['aria-selected']), ['false', 'false', 'false', 'true']);
  assert.ok(page.classes.has('tab-settings') && !page.classes.has('tab-summary'));
  const urls = page.fetches.map((f) => f.url);
  for (const u of ['/api/settings', '/api/pi-runtime', '/api/prerequisites']) assert.ok(urls.some((x) => x.startsWith(u)), u);
  assert.notEqual(JSON.parse(page.store.prefs || '{}').tab, 'settings');
  page.run("ACTIONS.tab({ dataset: { tab: 'summary' } })"); await page.tick();
  assert.equal(page.get('#settingsView').hidden, true);
  assert.equal(page.get('#sumLayout').hidden, false);
});

test('an unknown tab name is still ignored', async () => {
  const page = loadPage(answers());
  page.run("ACTIONS.tab({ dataset: { tab: 'nothing' } })"); await page.tick();
  assert.equal(page.run('S.tab'), 'summary');
});

// ---------- the view (artboard A) ----------
test('the grouped list: sections, where each option is saved, its default, the privacy note and the planned options disabled', async () => {
  const page = await openSettings();
  const h = html(page);
  for (const title of ['Chat', 'Pi', 'Delivery', 'Visual', 'Director']) assert.match(h, new RegExp(`<h3[^>]*>${title} `), title);
  assert.match(h, /Saved in config\.json · chat\.showResults/);
  assert.match(h, /<div class="st-warn" role="note"><b>Privacy\.<\/b>[^<]*can hold secrets/);
  assert.match(h, /The result of <code>read<\/code> is never shown/);
  assert.match(h, /Default: off/);
  assert.match(h, /Planned · RP110/);
  assert.match(h, /Planned · RP109/);
  assert.equal((h.match(/Saved in this browser/g) || []).length, 4);
  assert.match(h, /<input id="st-env"[^>]*disabled/);
  assert.match(h, /<select id="st-par"[^>]*disabled/);
});

test('the privacy switch reads the option, and the real default of a browser option is shown (delete branch and clean column are ON by default)', async () => {
  const off = await openSettings();
  assert.equal(switchOf(html(off), 'chat.showResults')[1], 'false');
  assert.match(html(off), /id="st-l-del"[\s\S]*?Default: on/);
  const on = await openSettings({ '/api/settings': { options: [{ key: 'chat.showResults', value: true, default: false }] } });
  assert.equal(switchOf(html(on), 'chat.showResults')[1], 'true');
});

test('«pi to use» is a select with Auto and the available runtimes (escaped), uses the route that already exists, and lists what was detected', async () => {
  const page = await openSettings();
  const h = html(page);
  assert.match(h, /<select id="st-pi" data-pi-runtime aria-label="pi to use">[\s\S]*<option value="auto" selected>Auto<\/option><option value="gentle-shell">Gentle Shell<\/option><option value="pi">pi \(original\)<\/option><\/select>/);
  assert.doesNotMatch(h, /Gone/);
  assert.match(h, /Detected: Gentle Shell 4\.6\.0 · pi \(original\) 0\.9\.2/);
  assert.doesNotMatch(h, /<b>(?!Privacy)/);
});

test('while the pi runtimes are not read yet the select says so and is disabled', () => {
  const h = R.settingsView({ state: 'ready', options: { 'chat.showResults': false }, prefs: {}, pi: null, saved: '', error: '' });
  assert.match(h, /<select id="st-pi"[^>]*disabled[^>]*>/);
  assert.match(h, /Loading…/);
});

// ---------- the actions ----------
test('the privacy switch: a click posts the opposite value, the view shows it and says where it was saved', async () => {
  const page = await openSettings({ '/api/settings': (url, opts) => reply(opts.method === 'POST' ? { options: [{ key: 'chat.showResults', value: JSON.parse(opts.body).value, default: false }] } : OPTIONS) });
  await page.run("ACTIONS['setting-toggle']({ dataset: { key: 'chat.showResults' } })"); await page.tick();
  const post = page.fetches.filter((f) => f.method === 'POST' && f.url.startsWith('/api/settings'));
  assert.deepEqual(post.map((f) => JSON.parse(f.body)), [{ key: 'chat.showResults', value: true }]);
  assert.equal(switchOf(html(page), 'chat.showResults')[1], 'true');
  assert.match(html(page), /role="status"[^>]*>Saved to config\.json/);
  await page.run("ACTIONS['setting-toggle']({ dataset: { key: 'chat.showResults' } })"); await page.tick();
  assert.deepEqual(page.fetches.filter((f) => f.method === 'POST' && f.url.startsWith('/api/settings')).map((f) => JSON.parse(f.body).value), [true, false]);
});

test('the privacy switch: when the server refuses, the switch stays where it was and the message is shown (escaped)', async () => {
  const page = await openSettings({ '/api/settings': (url, opts) => (opts.method === 'POST' ? fail(400, { error: 'Unknown <i>setting' }) : reply(OPTIONS)) });
  await page.run("ACTIONS['setting-toggle']({ dataset: { key: 'chat.showResults' } })"); await page.tick();
  assert.equal(switchOf(html(page), 'chat.showResults')[1], 'false');
  assert.match(html(page), /Unknown &lt;i&gt;setting/);
  assert.doesNotMatch(html(page), /<i>setting/);
});

test('the privacy switch: a key the page does not know sends nothing', async () => {
  const page = await openSettings();
  for (const key of ['port', '__proto__', 'constructor', '', undefined]) await page.run(`ACTIONS['setting-toggle']({ dataset: { key: ${JSON.stringify(key)} } })`);
  await page.tick();
  assert.equal(page.fetches.filter((f) => f.method === 'POST' && f.url.startsWith('/api/settings')).length, 0);
});

test('the browser options: each click saves the preference, redraws, says «Saved in this browser» and keeps the control of the bar in step', async () => {
  const page = await openSettings();
  await page.run("ACTIONS['pref-set']({ dataset: { pref: 'method', value: 'rebase' } })"); await page.tick();
  assert.equal(page.run('S.prefs.method'), 'rebase');
  assert.equal(JSON.parse(page.store.prefs).method, 'rebase');
  assert.match(html(page), /role="status"[^>]*>Saved in this browser/);
  assert.match(html(page), /aria-pressed="true"[^>]*data-value="rebase"|data-value="rebase"[^>]*aria-pressed="true"/);
  await page.run("ACTIONS['pref-set']({ dataset: { pref: 'del', value: 'false' } })"); await page.tick();
  assert.equal(page.run('S.prefs.del'), false);
  await page.run("ACTIONS['pref-set']({ dataset: { pref: 'cleanAsColumn', value: 'false' } })"); await page.tick();
  assert.equal(page.run('S.prefs.cleanAsColumn'), false);
  assert.equal(page.get('#cleanAsColumn').checked, false);
  await page.run("ACTIONS['pref-set']({ dataset: { pref: 'split', value: 'true' } })"); await page.tick();
  assert.equal(page.run('S.prefs.split'), true);
  assert.equal(page.fetches.filter((f) => f.method === 'POST' && f.url.startsWith('/api/settings')).length, 0, 'a browser option never goes to the server');
});

test('the browser options: a name or a value that is not on the list changes nothing', async () => {
  const page = await openSettings();
  const before = page.store.prefs;
  for (const [pref, value] of [['tab', 'settings'], ['__proto__', 'x'], ['method', 'delete'], ['method', true], ['del', 'yes'], ['split', 'maybe'], ['cleanAsColumn', '1'], ['', 'x']]) {
    await page.run(`ACTIONS['pref-set']({ dataset: { pref: ${JSON.stringify(pref)}, value: ${JSON.stringify(value)} } })`);
  }
  await page.tick();
  assert.equal(page.store.prefs, before);
});

test('when the options cannot be read the panel options say so and the browser options are still there', async () => {
  const page = await openSettings({ '/api/settings': () => fail(500, { error: 'boom' }) });
  assert.match(html(page), /Settings of the panel are unavailable/);
  assert.equal(switchOf(html(page), 'chat.showResults'), null);
  assert.match(html(page), /data-pref="method"/);
});

test('the view is pure: odd inputs never throw and never print undefined or NaN', () => {
  for (const m of [undefined, null, {}, { state: 'ready' }, { state: 'ready', options: null, prefs: null, pi: { candidates: 'x' } }, { state: 'zzz', pi: { candidates: [null, 1, { id: 7 }] } }]) {
    const h = R.settingsView(m);
    assert.equal(typeof h, 'string');
    assert.doesNotMatch(h, /undefined|NaN|\[object/, JSON.stringify(m));
  }
});

// ---------- found by the independent check: the tab a person comes back to from Conformity ----------
test('the way back from Conformity is Summary or Work, never Settings (S.backTab)', async () => {
  const go = async (page, ...tabs) => { for (const t of tabs) { page.run(`ACTIONS.tab({ dataset: { tab: '${t}' } })`); await page.tick(); } return page.run('S.backTab'); };
  assert.equal(await go(loadPage(answers()), 'conformity'), 'summary');
  assert.equal(await go(loadPage(answers()), 'work', 'conformity'), 'work');
  assert.equal(await go(loadPage(answers()), 'settings', 'conformity'), 'summary');
  assert.equal(await go(loadPage(answers()), 'work', 'settings', 'conformity'), 'work');
  assert.equal(await go(loadPage(answers()), 'conformity', 'settings', 'conformity'), 'summary');
  assert.equal(await go(loadPage(answers()), 'summary', 'work', 'settings', 'conformity', 'settings', 'conformity'), 'work');
});
