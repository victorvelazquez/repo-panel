'use strict';
// RP195 (S5, S10): the buttons of MANAGEMENT of the session, Compact, Terminal and Close session, leave the foot of the chat (the composer frame) and live in a ⋮ menu of the head of the chat. They are offered
// with the same conditions as before (Compact only with a live session that is not compacting; Terminal and Close session only with a session), each with the title it had. The menu opens with the button, closes with
// Escape (the focus goes back to the button), with a click outside and with the choice of an item. How it LOOKS is for the person to try; these tests pin the markup, the state and the rules.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { appSource } = require('./pagesrc.js');
const V = require('../public/view.js');
const R = require('../public/resumen.js');

const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'style.css'), 'utf8').replace(/\r\n/g, '\n').replace(/\/\*[\s\S]*?\*\//g, '');
const ruleIn = (src, sel) => [...src.matchAll(/(?:^|\n|\})\s*([^{}@]+)\{([^}]*)\}/g)].filter((m) => m[1].split(',').some((s) => s.trim().replace(/\s+/g, ' ') === sel)).map((m) => m[2]).join(';');

const idle = { info: { adopted: { id: 's1' } }, rpc: { state: 'idle' } };
const menu = (o = {}) => R.chatMenuHtml({ open: true, session: idle, hasSession: true, terminal: null, closing: false, ...o });
const acts = (h) => [...h.matchAll(/role="menuitem"[^>]*data-act="([\w-]+)"/g)].map((m) => m[1]);

// ---------- pure ----------
test('m1: closed, the menu is ONE button with its name and what it controls; the list is not in the page', () => {
  const h = menu({ open: false });
  assert.match(h, /<button type="button" id="chMenuBtn" class="ch-more" data-act="ch-menu" aria-label="Session menu" title="Session menu" aria-haspopup="menu" aria-expanded="false" aria-controls="chMenu">/);
  assert.match(h, /<svg[^>]*aria-hidden="true"/);
  assert.doesNotMatch(h, /id="chMenu"|role="menu"/);
  assert.match(h, /^<span class="ch-menu" id="chMenuWrap">/);
});

test('m2: open, the list has Compact, Terminal and Close session, in that order, each a menu item with the action it had in the foot', () => {
  const h = menu();
  assert.match(h, /aria-expanded="true"/);
  assert.match(h, /<div id="chMenu" class="ch-menu-list" role="menu" aria-label="Session">/);
  assert.deepEqual(acts(h), ['compact', 'session-terminal', 'session-close']);
  assert.match(h, /data-act="compact"[^>]*>Compact<\/button>/);
  assert.match(h, /data-act="session-terminal"[^>]*>Terminal<\/button>/);
  assert.match(h, /data-act="session-close"[^>]*>Close session<\/button>/);
  for (const m of h.matchAll(/<button type="button" class="ch-mi"/g)) assert.ok(m);
});

test('m3: the same conditions as the foot had: no session, no menu; Compact only with a live session that is not compacting; the titles are the old ones', () => {
  assert.equal(menu({ session: { info: null, rpc: { state: 'closed' } }, hasSession: false }), '', 'nothing to offer: no button at all');
  assert.deepEqual(acts(menu({ session: { ...idle, rpc: { state: 'starting' } } })), ['session-terminal', 'session-close'], 'starting: no Compact');
  assert.deepEqual(acts(menu({ session: { ...idle, rpc: { state: 'idle', compacting: true } } })), ['session-terminal', 'session-close'], 'compacting: no Compact');
  assert.deepEqual(acts(menu({ session: { info: null, rpc: { state: 'idle' } } })), ['session-terminal', 'session-close'], 'without the info of the repo: no Compact');
  assert.match(menu(), /data-act="compact" title="Compact the context of this session">/);
  assert.match(menu({ session: { ...idle, rpc: { state: 'busy' } } }), /data-act="compact" title="Compact the context of this session\. It stops the answer in progress first">/);
  assert.match(menu(), /data-act="session-terminal"[^>]*title="Show the command to open this session in a normal terminal"/);
  assert.match(menu(), /data-act="session-close"[^>]*title="Stop this session and go back to the list of sessions"/);
});

test('m4: Terminal says whether its line is open, and Close session is disabled while it closes', () => {
  assert.match(menu({ terminal: { open: true } }), /data-act="session-terminal" aria-expanded="true"/);
  assert.match(menu({ terminal: { open: false } }), /data-act="session-terminal" aria-expanded="false"/);
  assert.match(menu({ terminal: null }), /data-act="session-terminal" aria-expanded="false"/);
  assert.match(menu({ closing: true }), /data-act="session-close" disabled/);
  assert.doesNotMatch(menu({ closing: false }), /data-act="session-close" disabled/);
});

test('m5: the head of the chat carries the menu between the name and the panel button; without the menu it is the head of before', () => {
  const withMenu = R.chatHead({ tab: 'chat' }, { name: 'demo', column: true, git: {}, menu: { open: false, session: idle, hasSession: true } });
  assert.ok(withMenu.indexOf('class="ch-name"') < withMenu.indexOf('class="ch-menu"') && withMenu.indexOf('class="ch-menu"') < withMenu.indexOf('class="ch-repo"') && withMenu.indexOf('class="ch-repo"') < withMenu.indexOf('data-act="chat-close"'));
  const without = R.chatHead({ tab: 'chat' }, { name: 'demo', column: true, git: {} });
  assert.doesNotMatch(without, /ch-menu|ch-more/);
  assert.doesNotMatch(R.chatHead({ tab: 'chat' }, { name: 'demo', column: true, git: {}, menu: { open: true, session: { info: null, rpc: { state: 'closed' } }, hasSession: false } }), /ch-menu|ch-more/, 'no session: no button');
});

test('m6: the foot builders became menu items: no footer-button classes are left, and the old words stay', () => {
  assert.match(R.compactButtonHtml(idle), /^<button type="button" class="ch-mi" role="menuitem" data-act="compact"/);
  assert.match(R.sessionTerminalHtml(true, null), /^<button type="button" class="ch-mi" role="menuitem" data-act="session-terminal"/);
  assert.match(R.sessionCloseHtml(true, false), /^<button type="button" class="ch-mi" role="menuitem" data-act="session-close"[^>]*>Close session<\/button>$/);
  assert.equal(R.compactButtonHtml({ info: null, rpc: { state: 'idle' } }), '');
  assert.equal(R.sessionTerminalHtml(false, null), '');
  assert.equal(R.sessionCloseHtml(false, false), '');
  for (const h of [R.compactButtonHtml(idle), R.sessionTerminalHtml(true, null), R.sessionCloseHtml(true, false)]) assert.doesNotMatch(h, /ss-compact|ss-term|ss-close|ss-long/);
});

test('m7: the stylesheet: the ⋮ button has the size of the buttons of the head (44 px on the phone), the list hangs from it, and the foot button rules are gone', () => {
  const more = ruleIn(css, '.ch-more');
  assert.match(more, /display:\s*inline-flex/);
  assert.match(more, /width:\s*30px/);
  assert.match(more, /height:\s*30px/);
  assert.match(ruleIn(css, '#sumLayout[data-screen] .ch-more'), /min-width:\s*44px/);
  assert.match(ruleIn(css, '.ch-menu'), /position:\s*relative/);
  const list = ruleIn(css, '.ch-menu-list');
  assert.match(list, /position:\s*absolute/);
  assert.match(list, /right:\s*0/);
  assert.match(list, /z-index:\s*\d+/);
  assert.match(ruleIn(css, '.ch-mi'), /text-align:\s*left/);
  assert.match(ruleIn(css, '.ch-mi:hover:not(:disabled)'), /background/);
  assert.match(css, /\.ch-mi:focus-visible[^{]*\{[^}]*outline:\s*2px solid var\(--blue\)/);
  assert.match(ruleIn(css, '.ch-menu'), /order:\s*2/, 'in the one row of the wide head, the menu sits with the panel button and the close button');
  for (const gone of ['.ss-close', '.ss-compact', '.ss-term']) assert.equal(ruleIn(css, gone), '', `${gone} has no rule`);
});

// ---------- the page ----------
function element(extra = {}) {
  const el = {
    html: '', hidden: false, dataset: {}, disabled: false, value: '', checked: false, textContent: '', title: '', attrs: {}, children: [], writes: 0, focused: 0,
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false }, style: { setProperty() {} }, addEventListener() {}, setAttribute() {}, querySelector: () => null, querySelectorAll: () => [], closest: () => null,
    showModal() {}, close() {}, focus() { el.focused++; }, append() {}, get innerHTML() { return el.html; }, set innerHTML(v) { el.html = String(v); el.writes++; }, ...extra,
  };
  return el;
}
const ok = (b) => ({ ok: true, json: async () => b });
const card = (id, name) => ({ id, name, group: 'G', room: null, branch: 'main', progress: { total: 1, completada: 0, enRevision: 0, bloqueada: 0, pendiente: 1, enCurso: 0 }, session: { state: 'free' }, next: null, blocking: [], lastMovement: {}, activity: null });
const INFO = { key: 'abc', adopted: { id: 's1', name: 'First', adoptedAt: 'x' }, adoptedFound: true, sessions: [{ id: 's1', name: 'First', updatedAt: '2026-01-01T00:00:00.000Z', lastMessage: 'hi' }], live: { state: 'none', count: 0 } };
async function boot() {
  const frames = []; const fetches = []; const docL = {};
  const els = {};
  const tabEls = ['summary', 'work', 'conformity'].map((t) => element({ dataset: { tab: t } }));
  const get = (sel) => (els[sel] ||= (sel === 'meta[name=token]' ? element({ content: 'token' }) : element()));
  const doc = { hidden: false, querySelector: get, querySelectorAll: (s) => (String(s).includes('data-tab') ? tabEls : []), addEventListener(t, fn) { (docL[t] ||= []).push(fn); }, createElement: () => element(), body: element(), activeElement: null };
  const routes = [[(u) => u.startsWith('/api/sessions?'), () => Promise.resolve(ok(INFO))], [(u) => u.startsWith('/api/chat?'), () => Promise.resolve(ok({ items: [], truncated: false }))]];
  const ctx = vm.createContext({
    console, document: doc, location: { hash: '' }, localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    requestAnimationFrame: (cb) => { frames.push(cb); return frames.length; }, setInterval: () => 1, setTimeout: () => 0, clearTimeout: () => {}, AbortController, confirm: () => true,
    fetch: (url, opts = {}) => { fetches.push(String(url)); for (const [m, fn] of routes) if (m(String(url))) return fn(); return new Promise(() => {}); },
  });
  ctx.window = ctx; ctx.addEventListener = () => {}; ctx.RepoPanelView = V; ctx.RepoPanelResumen = R;
  vm.runInContext(appSource(), ctx);
  const flush = () => { while (frames.length) frames.shift()(); };
  const tick = async (n = 20) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); flush(); };
  const run = (c) => vm.runInContext(c, ctx);
  const S = run('S');
  S.groups = [{ name: 'G', repos: [{ id: 'abc', name: 'demo', path: 'p' }] }];
  S.summary = { rows: [card('abc', 'demo')], generatedAt: 'x' };
  run("S.rpc.abc = { state: 'idle' }");
  run("ACTIONS['chat-open']({ dataset: { id: 'abc' } })");
  await tick();
  const fire = (type, e) => { const ev = { type, preventDefault() {}, stopPropagation() {}, ...e }; for (const fn of docL[type] || []) fn(ev); return ev; };
  return { get, tick, run, fetches, fire, S, doc };
}
const head = (page) => page.get('#chatHead').html;
const sess = (page) => page.get('#sessState').html;
const toggle = async (page) => { page.run("ACTIONS['ch-menu']({ dataset: { act: 'ch-menu' } })"); await page.tick(); };

test('p1: with a session the head has the ⋮ button, closed; pressing it opens the list with the three actions and the focus goes to the first item', async () => {
  const page = await boot();
  assert.match(head(page), /id="chMenuBtn"[^>]*aria-expanded="false"/);
  assert.doesNotMatch(head(page), /id="chMenu"/);
  await toggle(page);
  assert.equal(page.S.chat.menu, true);
  assert.deepEqual(acts(head(page)), ['compact', 'session-terminal', 'session-close']);
  assert.match(head(page), /id="chMenuBtn"[^>]*aria-expanded="true"/);
  assert.ok(page.get('#chMenu [role="menuitem"]').focused >= 1, 'the focus is on the first item');
  await toggle(page);
  assert.equal(page.S.chat.menu, false, 'the button closes it too');
  assert.doesNotMatch(head(page), /id="chMenu"/);
});

test('p2: the foot of the chat no longer has Compact, Terminal or Close session; it keeps the state of the session', async () => {
  const page = await boot();
  assert.doesNotMatch(sess(page), /data-act="compact"|data-act="session-terminal"|data-act="session-close"/);
  assert.match(sess(page), /class="ss /, 'the state chip stays in the foot (RP191 will handle it)');
});

test('p3: Escape closes the menu, puts the focus back on its button and does NOT close the chat; the next Escape closes the chat as before', async () => {
  const page = await boot();
  await toggle(page);
  const before = page.get('#chMenuBtn').focused;
  page.fire('keydown', { key: 'Escape', target: element() });
  await page.tick();
  assert.equal(page.S.chat.menu, false);
  assert.equal(page.S.chat.id, 'abc', 'the chat stays open');
  assert.ok(page.get('#chMenuBtn').focused > before, 'the focus is back on the button');
  page.fire('keydown', { key: 'Escape', target: element() });
  assert.equal(page.S.chat.id, null, 'with the menu closed the Escape closes the chat as before');
});

test('p4: a click outside closes the menu, a click on the button leaves it to its own action, and a click on an item closes it and runs the action', async () => {
  const page = await boot();
  await toggle(page);
  page.fire('click', { target: element() });
  await page.tick();
  assert.equal(page.S.chat.menu, false, 'outside');
  await toggle(page);
  const btn = element({ dataset: { act: 'ch-menu' } });
  btn.closest = (s) => (s === '[data-act]' || s === '#chMenuWrap' ? btn : null);
  page.fire('click', { target: btn });
  await page.tick();
  assert.equal(page.S.chat.menu, false, 'the button toggled it closed, once');
  await toggle(page);
  const item = element({ dataset: { act: 'session-terminal' } });
  item.closest = (s) => (s === '[data-act]' || s === '#chMenu' || s === '#chMenuWrap' ? item : null);
  page.fire('click', { target: item });
  await page.tick();
  assert.equal(page.S.chat.menu, false, 'the item closed the menu');
  assert.ok(page.S.chat.terminal && page.S.chat.terminal.open, 'and its action ran: the line of the terminal is open');
});

test('p5: the line of the terminal is still the block above the message box, and the menu says it is open', async () => {
  const page = await boot();
  page.run("ACTIONS['session-terminal']()");
  await page.tick();
  assert.equal(page.S.chat.terminal.open, true);
  assert.match(page.get('#termBlock').html, /term-block|terminal/i);
  await toggle(page);
  assert.match(head(page), /data-act="session-terminal" aria-expanded="true"/);
});

test('p6: a chat without a session has no ⋮ button, and a new chat starts with the menu closed', async () => {
  const page = await boot();
  await toggle(page);
  assert.equal(page.S.chat.menu, true);
  page.run("ACTIONS['chat-close']()");
  await page.tick();
  page.run("S.rpc.abc = { state: 'closed' }; S.chatCache = {}");
  page.run("ACTIONS['chat-open']({ dataset: { id: 'abc' } })");
  await page.tick();
  assert.ok(!page.S.chat.menu, 'the menu of the old chat is not carried over');
});
