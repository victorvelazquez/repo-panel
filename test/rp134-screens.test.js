'use strict';
// RP134 (S26), first half of the mobile version (design F of design/panel-movil/06): under 760 px of width of the layout the page shows ONE zone at a time: the list of repos, or the chat of the open repo, with the grey arrow
// that goes back to the list. From 760 px up nothing changes. The page marks the screen with `data-screen` (list or chat) on #sumLayout, and ONLY under 760 px; the stylesheet follows that mark. The tabs Tasks, Changes and Files of the
// chat stay in the chat as they are today under 1100 px (they move to Repo with RP157, the second half). The arrow uses the Back of the browser when the page itself opened the chat from the list (so the Back of the phone does not
// return to the chat that was just closed); when the chat came from a link, Back, Forward or the start, it closes it. The address of RP133 is how the Back of the phone walks the screens.
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

// ---------- the cut (pure) ----------
test('s1: the screen under 760 px is the list with no repo open and the chat with one; from 1100 px up there is no screen (null; RP136: 760 to 1099 is the duo)', () => {
  assert.equal(V.screenOf(759, null), 'list');
  assert.equal(V.screenOf(759, A), 'chat');
  assert.equal(V.screenOf(390, A), 'chat');
  assert.equal(V.screenOf(360, null), 'list');
  assert.equal(V.screenOf(1, A), 'chat');
  for (const w of [1100, 1500, 4000, Infinity]) { assert.equal(V.screenOf(w, null), null, String(w)); assert.equal(V.screenOf(w, A), null, String(w)); }
});

test('s2: a width that is not a real size is not «narrow»: unknown (a layout that is hidden in another tab measures 0) keeps today\'s behaviour', () => {
  for (const w of [0, -1, -760, NaN, undefined, null, '', '390', '759', {}, [], true, false, 7n]) assert.equal(V.screenOf(w, A), null, String(typeof w) + String(w));
});

test('s3: the id only says «a repo is open»: any text that is not empty counts, and nothing that is not text does', () => {
  assert.equal(V.screenOf(500, ''), 'list');
  for (const id of [null, undefined, 0, false]) assert.equal(V.screenOf(500, id), 'list', String(id));
  assert.equal(V.screenOf(500, 'x'), 'chat');
  assert.equal(V.NARROW_BELOW, 760);
});

// ---------- the chat head: the arrow ----------
test('h1: the head of the chat has the arrow that goes back to the list (a real button with a name, its icon hidden from assistive tools) before the name, and the close button of always', () => {
  const h = R.chatHead({ id: A, tab: 'chat' }, { name: 'demo', column: false });
  assert.match(h, /^<div class="ch-row"><button type="button" class="ch-back" data-act="chat-back" aria-label="Back to the list of repos" title="Back to the list"><svg [^>]*aria-hidden="true"[^>]*>[\s\S]*?<\/svg><\/button><b class="ch-name"/);
  assert.match(h, /data-act="chat-close"/);
});

test('h2: the tabs of the chat do not change under 760 px (they stay in the chat until RP157): the same markup with or without the column', () => {
  const without = R.chatHead({ id: A, tab: 'chat' }, { name: 'demo', column: false });
  for (const t of ['chat', 'tasks', 'changes', 'files', 'notes']) assert.match(without, new RegExp(`data-tab="${t}"`), t);
  const withColumn = R.chatHead({ id: A, tab: 'chat' }, { name: 'demo', column: true });
  assert.doesNotMatch(withColumn, /data-tab="tasks"|data-tab="changes"|data-tab="files"/);
});

// ---------- the stylesheet ----------
const rules = [...css.matchAll(/(?:^|\n)([^{}\n@/ ][^{}\n]*)\{([^}]*)\}/g)].flatMap((m) => m[1].split(',').map((s) => ({ sel: s.trim().replace(/\s+/g, ' '), body: m[2] })));
const rule = (sel) => { const r = rules.filter((x) => x.sel === sel); assert.ok(r.length, `a rule for ${sel}`); return r.map((x) => x.body).join(';'); };

test('c1: the stylesheet follows the mark: one screen at a time, the other zones out, the separators and the column out, and the zone that stays takes the whole width', () => {
  assert.match(rule('#sumLayout[data-screen="list"] #chat'), /display:\s*none/);
  assert.match(rule('#sumLayout[data-screen="chat"] #listCol'), /display:\s*none/);
  // RP157: the column is the third screen, so it is out on the list and on the chat screens (before it was out on both)
  for (const sel of ['#sumLayout[data-screen] #split', '#sumLayout[data-screen] #split2', '#sumLayout[data-screen="list"] #col', '#sumLayout[data-screen="chat"] #col']) assert.match(rule(sel), /display:\s*none/, sel);
  const wide = rule('#sumLayout[data-screen] #listCol');
  assert.match(wide, /min-width:\s*0/);
  assert.match(wide, /width:\s*auto|width:\s*100%/);
  assert.match(rule('#sumLayout[data-screen] #chat'), /min-width:\s*0/);
  assert.match(rule('#sumLayout[data-screen]'), /flex-direction:\s*column/);
});

test('c2: the arrow is out by default and in only under 760 px (the mark), where the close button of the head is out; the arrow is a 44 px target and keeps a visible focus ring', () => {
  assert.match(rule('.ch-back'), /display:\s*none/);
  assert.match(rule('#sumLayout[data-screen] .ch-back'), /display:\s*inline-flex/);
  assert.match(rule('#sumLayout[data-screen] .ch-row .x'), /display:\s*none/);
  const size = rule('#sumLayout[data-screen] .ch-back');
  assert.match(size, /min-width:\s*44px/);
  assert.match(size, /min-height:\s*44px/);
  assert.match(css, /\.ch-back:focus-visible[^{]*\{[^}]*outline:\s*2px solid var\(--blue\)/);
});

test('c3: the old block that stacked the list over the chat under 720 px is gone (the screens replace it), and the layout fills the viewport with the dynamic height', () => {
  assert.doesNotMatch(css, /@media \(max-width: 720px\)\s*\{[^}]*\.chatlayout\.chat-open/);
  assert.match(rule('#sumLayout[data-screen]'), /height:\s*calc\(100dvh/);
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
async function boot({ width = 390, hash = '', ids = [A, B], history = true } = {}) {
  const els = {};
  const frames = [];
  const listeners = {};
  const calls = [];
  const loc = { hash, pathname: '/panel/', search: '' };
  const setUrl = (url) => { const at = String(url).indexOf('#'); loc.hash = at >= 0 ? String(url).slice(at) : ''; };
  const hist = history ? { pushState(s, t, url) { calls.push(['push', url]); setUrl(url); }, replaceState(s, t, url) { calls.push(['replace', url]); setUrl(url); }, back() { calls.push(['back']); } } : undefined;
  const tabEls = ['summary', 'work', 'conformity', 'settings'].map((t) => element({ dataset: { tab: t } }));
  const get = (sel) => (els[sel] ||= (sel === 'meta[name=token]' ? element({ content: 'token' }) : element()));
  get('#sumLayout').clientWidth = width;
  const doc = { hidden: false, querySelector: get, querySelectorAll: (s) => (String(s).includes('data-tab') ? tabEls : []), addEventListener() {}, createElement: () => element(), body: element(), activeElement: null };
  const sandbox = {
    console, document: doc, TextDecoder, AbortController, confirm: () => true, location: loc,
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    requestAnimationFrame: (cb) => { frames.push(cb); return frames.length; }, setInterval: () => 0, setTimeout: () => 0, clearTimeout: () => {}, clearInterval: () => {},
    fetch: (url) => (String(url).startsWith('/api/config') ? Promise.resolve({ ok: true, json: async () => CONFIG(ids) }) : new Promise(() => {})),
  };
  if (hist) sandbox.history = hist;
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
    calls, loc, get, tick, fire, listeners, run: (code) => vm.runInContext(code, ctx),
    screen: () => get('#sumLayout').dataset.screen,
    chatId: () => vm.runInContext('S.chat.id', ctx),
    pushes: () => calls.filter((c) => c[0] === 'push').map((c) => c[1]),
    backs: () => calls.filter((c) => c[0] === 'back').length,
    setWidth: async (w) => { get('#sumLayout').clientWidth = w; await fire('resize'); },
    go: async (h) => { loc.hash = h; await fire('popstate'); await fire('hashchange'); },
    click: async (act, dataset = {}) => { vm.runInContext(`ACTIONS[${JSON.stringify(act)}]({ dataset: ${JSON.stringify(dataset)} })`, ctx); await tick(); },
  };
}

test('p1: under 760 px with no repo open the screen is the list; opening a repo shows the chat; closing it shows the list again', async () => {
  const page = await boot({ width: 390 });
  assert.equal(page.screen(), 'list');
  await page.click('chat-open', { id: A });
  assert.equal(page.screen(), 'chat');
  page.run('closeChat()');
  await page.tick();
  assert.equal(page.screen(), 'list');
});

test('p2: from 1100 px up there is no screen (RP136: 760 to 1099 is the duo), with or without a repo open: today\'s layout is untouched', async () => {
  for (const width of [1100, 1500]) {
    const page = await boot({ width });
    assert.equal(page.screen(), undefined, String(width));
    await page.click('chat-open', { id: A });
    assert.equal(page.screen(), undefined, String(width));
  }
});

test('p3: a resize across the cut changes the screen at once, both ways, and keeps the open repo', async () => {
  const page = await boot({ width: 1200 });
  await page.click('chat-open', { id: A });
  assert.equal(page.screen(), undefined);
  await page.setWidth(759);
  assert.equal(page.screen(), 'chat');
  assert.equal(page.chatId(), A);
  await page.setWidth(760);
  assert.equal(page.screen(), 'duo', 'RP136: from 760 to 1099 px the screen is the duo');
  await page.setWidth(1100);
  assert.equal(page.screen(), undefined);
  await page.setWidth(500);
  page.run('closeChat()');
  await page.tick();
  assert.equal(page.screen(), 'list');
});

test('p4: a layout that measures nothing (hidden in another tab) is not taken as narrow: no screen is guessed', async () => {
  const page = await boot({ width: 0 });
  assert.equal(page.screen(), undefined);
  await page.click('chat-open', { id: A });
  assert.equal(page.screen(), undefined);
});

test('p5: the screen follows an address: a link to a repo opens the chat screen, the list address the list screen', async () => {
  const page = await boot({ width: 390, hash: `#/repo/${B}/chat` });
  assert.equal(page.screen(), 'chat');
  await page.go('');
  assert.equal(page.screen(), 'list');
  await page.go(`#/repo/${A}/repo`);
  assert.equal(page.screen(), 'repo', 'RP157: the zone repo is the screen repo (until then it read as chat)');
});

test('p6: the chat head under 760 px has the arrow and only the tabs Chat and Notes (RP157 moved Tasks, Changes and Files to the Repo screen)', async () => {
  const page = await boot({ width: 390 });
  await page.click('chat-open', { id: A });
  const head = page.get('#chatHead').html;
  assert.match(head, /data-act="chat-back"/);
  for (const t of ['chat', 'notes']) assert.match(head, new RegExp(`data-tab="${t}"`), t);
  for (const t of ['tasks', 'changes', 'files']) assert.doesNotMatch(head, new RegExp(`data-tab="${t}"`), t);
});

// ---------- the arrow and the Back of the phone ----------
test('b1: the arrow, with the chat opened from the list by the page, uses the Back of the browser, and the answer of the browser (the address changes) closes it: ONE entry was written and none more', async () => {
  const page = await boot({ width: 390 });
  await page.click('chat-open', { id: A });
  assert.deepEqual(page.pushes(), [`/panel/#/repo/${A}/chat`]);
  await page.click('chat-back');
  assert.equal(page.backs(), 1);
  assert.equal(page.chatId(), A, 'the browser has not answered yet: nothing is closed by the arrow itself');
  await page.go('');
  assert.equal(page.chatId(), null);
  assert.equal(page.screen(), 'list');
  assert.equal(page.pushes().length, 1, 'no entry was added by going back');
});

test('b2: the Back of the phone alone does the same as the arrow: the list, with nothing written', async () => {
  const page = await boot({ width: 390 });
  await page.click('chat-open', { id: A });
  const written = page.calls.length;
  await page.go('');
  assert.equal(page.screen(), 'list');
  assert.equal(page.calls.length, written);
});

test('b3: a chat that came from a link, from Back or from the start is closed by the arrow without leaving the page (there is no entry of the page to go back to)', async () => {
  const page = await boot({ width: 390, hash: `#/repo/${A}/chat` });
  assert.equal(page.chatId(), A);
  await page.click('chat-back');
  assert.equal(page.backs(), 0);
  assert.equal(page.chatId(), null);
  assert.equal(page.screen(), 'list');
  const c = await boot({ width: 390 });
  await c.click('chat-open', { id: A });
  await c.go(`#/repo/${B}/chat`);
  await c.click('chat-back');
  assert.equal(c.backs(), 0, 'a repo opened by Back, Forward or a link is not «from the list»');
  assert.equal(c.chatId(), null);
});

test('b4: opening a second repo from the open chat (no list between them) is not «from the list»: the arrow closes it', async () => {
  const page = await boot({ width: 1200, ids: [A, B] });
  await page.click('chat-open', { id: A });
  await page.click('chat-open', { id: B });
  assert.equal(page.chatId(), B);
  assert.equal(page.pushes().length, 2, 'both openings wrote their entry');
  await page.click('chat-back');
  assert.equal(page.backs(), 0, 'the page before B is the chat of A, not the list: the arrow does not go back');
  assert.equal(page.chatId(), null, 'it closes the chat');
});

test('b5: no history, or a history with no back: the arrow just closes the chat', async () => {
  const none = await boot({ width: 390, history: false });
  await none.click('chat-open', { id: A });
  await none.click('chat-back');
  assert.equal(none.chatId(), null);
  const partial = await boot({ width: 390 });
  await partial.click('chat-open', { id: A });
  partial.run('history.back = undefined');
  await partial.click('chat-back');
  assert.equal(partial.chatId(), null);
});

test('b6: the arrow with no chat open does nothing and writes nothing; a chat that has no address (a room) is closed by the arrow', async () => {
  const page = await boot({ width: 390 });
  await page.click('chat-back');
  assert.deepEqual(page.calls, []);
  const room = await boot({ width: 390, ids: [A, 'room:team'] });
  await room.click('chat-open', { id: 'room:team' });
  assert.deepEqual(room.calls, [], 'a room has no address: nothing was pushed');
  await room.click('chat-back');
  assert.equal(room.backs(), 0, 'with no entry of its own there is nothing to go back to');
  assert.equal(room.chatId(), null);
});

test('b8: a second tap on the arrow while the first Back is on its way does nothing (one Back, not two: two would leave the page)', async () => {
  const page = await boot({ width: 390 });
  await page.click('chat-open', { id: A });
  await page.click('chat-back');
  await page.click('chat-back');
  await page.click('chat-back');
  assert.equal(page.backs(), 1);
});

test('b7: the code is total: no history, no location or no dataset never throws when the screen is drawn', async () => {
  const page = await boot({ width: 390, history: false });
  page.get('#sumLayout').dataset = undefined;
  await assert.doesNotReject(async () => { page.run('applyLayout()'); await page.tick(); });
  assert.match(appSource(), /function applyScreen\(\)/);
});
