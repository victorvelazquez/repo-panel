'use strict';
// RP136 (S26, S47): between 760 and 1100 px of width of the layout the page shows TWO zones side by side: the chat and Repo (the column). The list of repos is reached with the arrow of the chat, as on a phone, and
// takes the whole width while no repo is open. The page marks it with data-screen="duo" (a repo open) or "list" (none). In that band the tabs Tasks, Changes and Files leave the chat and live in the column (columnOn is on);
// what is only for the phone stays only for the phone: the arrow of Repo, the Repo button and the second line of the head. Under 760 px and from 1100 px up nothing changes.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { appSource } = require('./pagesrc.js');
const V = require('../public/view.js');
const R = require('../public/resumen.js');

const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'style.css'), 'utf8').replace(/\r\n/g, '\n');
const A = 'abcdef0123';
const B = '9c15a89663';

// ---------- the band and the screen (pure) ----------
test('s1: the band of a width: narrow under 760, mid from 760 to 1099, wide from 1100; a width that is not a real size is no band', () => {
  assert.equal(V.bandOf(1), 'narrow');
  assert.equal(V.bandOf(759), 'narrow');
  assert.equal(V.bandOf(760), 'mid');
  assert.equal(V.bandOf(1099), 'mid');
  assert.equal(V.bandOf(1100), 'wide');
  assert.equal(V.bandOf(4000), 'wide');
  for (const w of [0, -1, NaN, Infinity, undefined, null, '', '900', {}, [], true, 7n]) assert.equal(V.bandOf(w), null, String(typeof w) + String(w));
  assert.equal(V.DUO_BELOW, 1100);
});

test('s2: in the mid band the screen is duo with a repo open and the list with none, whatever the zone; the narrow band and the wide band keep what they had', () => {
  for (const z of [undefined, 'chat', 'repo', 'x', 5]) { assert.equal(V.screenOf(800, A, z), 'duo', String(z)); assert.equal(V.screenOf(800, null, z), 'list', String(z)); }
  assert.equal(V.screenOf(760, A), 'duo');
  assert.equal(V.screenOf(1099, A), 'duo');
  assert.equal(V.screenOf(1100, A), null);
  assert.equal(V.screenOf(1100, null), null);
  assert.equal(V.screenOf(759, A, 'repo'), 'repo');
  assert.equal(V.screenOf(759, A, 'chat'), 'chat');
  assert.equal(V.screenOf(759, null), 'list');
  for (const w of [0, NaN, '900']) assert.equal(V.screenOf(w, A), null, String(w));
  assert.equal(V.screenOf(800, ''), 'list');
});

// ---------- the stylesheet ----------
const rules = [...css.matchAll(/(?:^|\n)([^{}\n@/ ][^{}\n]*)\{([^}]*)\}/g)].flatMap((m) => m[1].split(',').map((s) => ({ sel: s.trim().replace(/\s+/g, ' '), body: m[2] })));
const rule = (sel) => { const r = rules.filter((x) => x.sel === sel); assert.ok(r.length, `a rule for ${sel}`); return r.map((x) => x.body).join(';'); };

test('c1: the duo screen is a row: the list and its separator are out, the chat takes the room, and the column and ITS separator are in with their width; the Repo button is out there (Repo is in view)', () => {
  assert.match(rule('#sumLayout[data-screen="duo"]'), /flex-direction:\s*row/);
  assert.match(rule('#sumLayout[data-screen="duo"] #listCol'), /display:\s*none/);
  assert.match(rule('#sumLayout[data-screen="duo"] #split'), /display:\s*none/);
  assert.match(rule('#sumLayout[data-screen="duo"] #split2'), /display:\s*block/);
  const col = rule('#sumLayout[data-screen="duo"] #col');
  assert.match(col, /display:\s*flex/);
  assert.match(col, /flex:\s*none/);
  assert.match(col, /width:\s*var\(--col-w/);
  assert.match(col, /min-width:\s*220px/);
  assert.match(rule('#sumLayout[data-screen="duo"] #chat'), /flex:\s*1 1 0/);
  assert.match(rule('#sumLayout[data-screen="duo"] .ch-repo'), /display:\s*none/);
});

// ---------- the widths ----------
test('w1: with the list out (the duo) the chat and the column share ALL the width: the column has its share or 40%, 220 at least; the chat keeps 340; a width too small splits 60 | 40; the three-block widths are untouched', () => {
  assert.deepEqual(R.blockWidths(980, {}, { list: false }), { list: 0, chat: 588, col: 392 });
  assert.deepEqual(R.blockWidths(740, {}, { list: false }), { list: 0, chat: 444, col: 296 });
  assert.deepEqual(R.blockWidths(980, { col: 0.25 }, { list: false }), { list: 0, chat: 735, col: 245 });
  assert.deepEqual(R.blockWidths(980, { col: 0.9 }, { list: false }), { list: 0, chat: 340, col: 640 });
  assert.deepEqual(R.blockWidths(500, {}, { list: false }), { list: 0, chat: 300, col: 200 });
  for (const t of [0, -5, NaN, '9', null]) assert.deepEqual(R.blockWidths(t, {}, { list: false }), { list: 0, chat: 0, col: 0 }, String(t));
  for (let t = 560; t <= 1090; t += 7) { const w = R.blockWidths(t, {}, { list: false }); assert.equal(w.chat + w.col, t, String(t)); assert.ok(w.chat >= 340 && w.col >= 220, `fits ${t}`); }
  assert.deepEqual(R.blockWidths(1380, {}), { list: 345, chat: 690, col: 345 });
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
const CONFIG = (ids) => ({ groups: [{ name: 'G', repos: ids.map((id) => ({ id, name: `repo-${id}`, path: `p-${id}` })) }], snoozed: [], dismissed: [], rooms: [], roomIssues: [] });
async function boot({ width = 900, hash = '', ids = [A, B] } = {}) {
  const els = {};
  const frames = [];
  const listeners = {};
  const calls = [];
  const loc = { hash, pathname: '/panel/', search: '' };
  const setUrl = (url) => { const at = String(url).indexOf('#'); loc.hash = at >= 0 ? String(url).slice(at) : ''; };
  const hist = { pushState(s, t, url) { calls.push(['push', url]); setUrl(url); }, replaceState(s, t, url) { calls.push(['replace', url]); setUrl(url); }, back() { calls.push(['back']); } };
  const tabEls = ['summary', 'work', 'conformity', 'settings'].map((t) => element({ dataset: { tab: t } }));
  const get = (sel) => (els[sel] ||= (sel === 'meta[name=token]' ? element({ content: 'token' }) : element()));
  get('#sumLayout').clientWidth = width;
  const doc = { hidden: false, querySelector: get, querySelectorAll: (s) => (String(s).includes('data-tab') ? tabEls : []), addEventListener() {}, createElement: () => element(), body: element(), activeElement: null };
  const sandbox = {
    console, document: doc, TextDecoder, AbortController, confirm: () => true, location: loc, history: hist,
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    requestAnimationFrame: (cb) => { frames.push(cb); return frames.length; }, setInterval: () => 0, setTimeout: () => 0, clearTimeout: () => {}, clearInterval: () => {},
    fetch: (url) => (String(url).startsWith('/api/config') ? Promise.resolve({ ok: true, json: async () => CONFIG(ids) }) : new Promise(() => {})),
  };
  const ctx = vm.createContext(sandbox);
  ctx.window = ctx;
  ctx.addEventListener = (t, fn) => { (listeners[t] ||= []).push(fn); };
  ctx.RepoPanelView = V;
  ctx.RepoPanelResumen = R;
  vm.runInContext(appSource(), ctx);
  const flush = () => { while (frames.length) frames.shift()(); };
  const tick = async (n = 10) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); flush(); };
  await tick();
  const fire = async (t) => { for (const fn of listeners[t] || []) fn({ type: t }); await tick(); };
  return {
    calls, loc, get, tick, fire, run: (code) => vm.runInContext(code, ctx),
    screen: () => get('#sumLayout').dataset.screen,
    state: (expr) => vm.runInContext(expr, ctx),
    head: () => get('#chatHead').html,
    col: () => get('#colBody').html,
    backs: () => calls.filter((c) => c[0] === 'back').length,
    setWidth: async (w) => { get('#sumLayout').clientWidth = w; await fire('resize'); },
    go: async (h) => { loc.hash = h; await fire('popstate'); await fire('hashchange'); },
    click: async (act, dataset = {}) => { vm.runInContext(`ACTIONS[${JSON.stringify(act)}]({ dataset: ${JSON.stringify(dataset)} })`, ctx); await tick(); },
  };
}

test('p1: at 800 px with a repo open the screen is duo: the chat keeps only Chat and Notes, the column is painted with its tabs and NO arrow of Repo, and the chat head has the arrow back to the list', async () => {
  const page = await boot({ width: 800 });
  await page.click('chat-open', { id: A });
  assert.equal(page.screen(), 'duo');
  const h = page.head();
  for (const t of ['chat', 'notes']) assert.match(h, new RegExp(`data-tab="${t}"`), t);
  for (const t of ['tasks', 'changes', 'files']) assert.doesNotMatch(h, new RegExp(`data-tab="${t}"`), t);
  assert.match(h, /data-act="chat-back"/);
  for (const t of ['tasks', 'changes', 'status', 'files']) assert.match(page.col(), new RegExp(`coltab-${t}|data-tab="${t}"`), t);
  assert.doesNotMatch(page.col(), /col-head|zone-back/, 'the arrow of Repo is the phone\'s');
});

test('p2: the head in the duo has no second line and no badge (they are the phone\'s: Repo is in view), even with the facts of a running PR', async () => {
  const page = await boot({ width: 1000 });
  await page.click('chat-open', { id: A });
  assert.doesNotMatch(page.head(), /ch-id|ch-sub|ch-dot/);
});

test('p3: at 800 px with no repo open the screen is the list; opening one makes it duo; closing it returns to the list', async () => {
  const page = await boot({ width: 800 });
  assert.equal(page.screen(), 'list');
  await page.click('chat-open', { id: A });
  assert.equal(page.screen(), 'duo');
  page.run('closeChat()');
  await page.tick();
  assert.equal(page.screen(), 'list');
});

test('p4: the arrow of the chat at 800 px does what it does on a phone: the Back of the browser when the page opened the chat from the list, and the list shows', async () => {
  const page = await boot({ width: 800 });
  await page.click('chat-open', { id: A });
  await page.click('chat-back');
  assert.equal(page.backs(), 1);
  await page.click('chat-back');
  assert.equal(page.backs(), 1, 'a second tap does nothing while the Back is on its way');
  await page.go('');
  assert.equal(page.screen(), 'list');
  const link = await boot({ width: 800, hash: `#/repo/${B}/chat` });
  assert.equal(link.screen(), 'duo');
  await link.click('chat-back');
  assert.equal(link.backs(), 0);
  assert.equal(link.screen(), 'list');
});

test('p5: the cuts are 760 and 1100: 759 is the phone, 760 and 1099 the duo, 1100 the three columns (no screen)', async () => {
  const page = await boot({ width: 1200 });
  await page.click('chat-open', { id: A });
  const seen = [];
  for (const w of [1100, 1099, 760, 759, 760, 1099, 1100]) { await page.setWidth(w); seen.push(`${w}:${page.screen()}`); }
  assert.deepEqual(seen, ['1100:undefined', '1099:duo', '760:duo', '759:chat', '760:duo', '1099:duo', '1100:undefined']);
});

test('p6: crossing a cut with a resize repaints the chat head and the column both ways, in each band', async () => {
  const page = await boot({ width: 1200 });
  await page.click('chat-open', { id: A });
  assert.doesNotMatch(page.head(), /data-tab="tasks"/, 'wide: the column holds them');
  await page.setWidth(900);
  assert.doesNotMatch(page.head(), /data-tab="tasks"/, 'mid: the column holds them');
  assert.notEqual(page.col(), '');
  await page.setWidth(500);
  assert.doesNotMatch(page.head(), /data-tab="tasks"/);
  assert.match(page.col(), /col-head/, 'phone: the Repo screen has its arrow');
  await page.setWidth(900);
  assert.doesNotMatch(page.col(), /col-head/, 'back in the duo the arrow of Repo is gone');
});

test('p7: a file or a diff tapped in the column of the duo opens in the chat beside it (no screen change), and a task tapped in the list opens the chat with the column on its Tasks tab', async () => {
  const page = await boot({ width: 900 });
  await page.click('chat-open', { id: A });
  await page.click('files-open', { path: 'src/a.js' });
  assert.equal(page.screen(), 'duo');
  assert.equal(page.state('S.chat.tab'), 'file');
  assert.equal(page.state('S.chat.ffile'), 'src/a.js');
  await page.click('changes-file', { path: 'src/b.js' });
  assert.equal(page.state('S.chat.tab'), 'diff');
  const task = await boot({ width: 900 });
  await task.click('tasks-open', { id: A });
  assert.equal(task.screen(), 'duo');
  assert.equal(task.state('S.chat.colTab'), 'tasks');
});

test('p8: an address with the zone repo in the duo keeps both zones; the zone is not a screen there', async () => {
  const page = await boot({ width: 900, hash: `#/repo/${A}/repo` });
  assert.equal(page.screen(), 'duo');
  assert.equal(page.state('S.chat.zone'), 'repo');
});

test('p10: in the duo the widths are those of the chat and the column (the list is 0) and fit the window at the ends of the band', async () => {
  for (const [width, split] of [[760, 10], [800, 10], [1099, 10]]) {
    const page = await boot({ width });
    page.get('#split2').offsetWidth = split;
    await page.click('chat-open', { id: A });
    page.run('applyLayout()');
    const col = parseInt(page.get('#col').style['--col-w'], 10);
    const list = parseInt(page.get('#listCol').style['--list-w'], 10);
    assert.equal(list, 0, String(width));
    assert.ok(col >= 220 && width - split - col >= 340, `${width}: column ${col}, chat ${width - split - col}`);
  }
});

test('p11: with no repo open the list is in the shares even in the mid band (the duo is only with a repo): a width, not 0', async () => {
  const page = await boot({ width: 800 });
  page.get('#split').offsetWidth = 10;
  page.get('#split2').offsetWidth = 10;
  page.run('applyLayout()');
  assert.ok(parseInt(page.get('#listCol').style['--list-w'], 10) > 0, 'the list is in the shares (its width is the three-block split of a small window)');
  await page.click('chat-open', { id: A });
  page.run('applyLayout()');
  assert.equal(parseInt(page.get('#listCol').style['--list-w'], 10), 0, 'with a repo open the duo takes it out');
});

test('p12: dragging the separator of the column in the duo does not wipe the share the person saved for the list (it is not on screen, so it is not theirs to change)', async () => {
  const page = await boot({ width: 900 });
  page.get('#split2').offsetWidth = 10;
  page.run('layoutRatios = { list: 0.3, col: 0.25 }');
  await page.click('chat-open', { id: A });
  page.run('setBlocks({ col: 300 })');
  assert.equal(page.state('layoutRatios.list'), 0.3);
  assert.ok(page.state('layoutRatios.col') > 0);
});

test('p9: a layout that measures nothing (hidden in another tab) is not guessed: no screen, as before', async () => {
  const page = await boot({ width: 0 });
  assert.equal(page.screen(), undefined);
  await page.click('chat-open', { id: A });
  assert.equal(page.screen(), undefined);
});
