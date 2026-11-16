'use strict';
// RP209: the quick replies sit in a thin row of their own above the message field (#quickRow), outside the scroll of the chat. Fakes only: no server, no GitHub, no real session.
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { appSource } = require('./pagesrc.js');

const R = require('../public/resumen.js');
const V = require('../public/view.js');

// ---------- harness (the same fakes rp75 uses) ----------
function element(extra = {}) {
  const el = {
    writes: 0, html: '', hidden: false, dataset: {}, disabled: false, value: '', checked: false, textContent: '', title: '', attrs: {}, listeners: {}, children: [], open: false,
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    style: { setProperty(k, v) { el.style[k] = v; } },
    addEventListener(t, fn) { (el.listeners[t] ||= []).push(fn); }, setAttribute(k, v) { el.attrs[k] = v; }, querySelector: () => null, querySelectorAll: () => [], closest: () => null,
    showModal() {}, close() {}, focus() {}, append(c) { el.children.push(c); },
    get innerHTML() { return el.html; },
    set innerHTML(v) { el.html = String(v); el.writes++; },
    ...extra,
  };
  return el;
}

function loadPage({ answers = {} } = {}) {
  const els = {};
  const frames = [];
  const docL = {};
  const intervals = [];
  const store = {};
  const fetches = [];
  const tabEls = ['summary', 'work', 'conformity'].map((t) => element({ dataset: { tab: t } }));
  const get = (sel) => (els[sel] ||= (sel === 'meta[name=token]' ? element({ content: 'token' }) : element()));
  const doc = {
    hidden: false, querySelector: get, querySelectorAll: (s) => (String(s).includes('data-tab') ? tabEls : []),
    addEventListener(t, fn) { (docL[t] ||= []).push(fn); }, createElement: () => element(), body: element(), activeElement: null,
  };
  const ctx = vm.createContext({
    console, document: doc, location: { hash: '' },
    localStorage: { getItem: (k) => (k in store ? store[k] : null), setItem(k, v) { store[k] = String(v); }, removeItem(k) { delete store[k]; } },
    requestAnimationFrame: (cb) => { frames.push(cb); return frames.length; },
    setInterval: (fn, ms) => { intervals.push({ fn, ms }); return intervals.length; }, setTimeout: () => 0, clearTimeout: () => {}, AbortController, confirm: () => true,
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
  // The clock of the page moves only when a test says so: Date.now() inside the page is the real one plus an offset.
  vm.runInContext('globalThis.__offset = 0; { const real = Date.now.bind(Date); Date.now = () => real() + globalThis.__offset; }', ctx);
  const flush = () => { while (frames.length) frames.shift()(); };
  const tick = async (n = 6) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); flush(); };
  return {
    ctx, get, flush, tick, fetches, intervals, run: (code) => vm.runInContext(code, ctx),
    advance: (ms) => vm.runInContext(`globalThis.__offset += ${ms}`, ctx),
  };
}

const card = (o = {}) => ({
  id: 'abc', name: 'demo', group: 'G', room: null, branch: 'main', progress: { total: 4, completada: 1, enRevision: 0, bloqueada: 0, pendiente: 3, enCurso: 0 }, session: { state: 'free' },
  next: null, blocking: [], lastMovement: { at: '2026-05-01T11:48:00Z', what: 'x' }, action: null, error: null, needs: false, rank: 9, ...o,
});
const sess = { id: 's1', name: 'panel:alpha', updatedAt: '2026-05-01T11:00:00Z', lastMessage: { role: 'user', text: 'last words' } };
const ADOPTED = { key: 'abc', adopted: { id: 's1', name: 'panel:demo', adoptedAt: 'x' }, adoptedFound: true, sessions: [sess], live: { state: 'free', count: 1 } };
const item = (role, text, extra = {}) => ({ role, text, at: null, tools: [], ...extra });
const histOf = (...items) => ({ key: 'abc', sessionId: 's1', found: true, items, truncated: false, updatedAt: null });
const gate = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };
const count = (s, sub) => s.split(sub).length - 1;
const LINE = 'Respondé `start_task`, `adjust_task` o `cancel`.';
const MSG = `Listo el plan.\n\n${LINE}`;
const ASSISTANT = (text = MSG, extra = {}) => item('assistant', text, extra);
const ASK = { requestId: 'r1', method: 'confirm', title: 'Allow?', message: 'run it', options: [], truncated: false, expiresAt: null };

const BASE = {
  '/api/rpc/start': { state: 'idle', pendingDialogs: [], sessionId: 's1' }, '/api/rpc/status': { state: 'idle', pendingDialogs: [], sessionId: 's1' }, '/api/rpc/prompt': { disposition: 'started' },
  '/api/pi-status': { state: 'busy' }, '/api/sessions': ADOPTED, '/api/chat': histOf(item('user', 'go'), ASSISTANT()),
};
async function chatPage(extra = {}) {
  const page = loadPage({ answers: { ...BASE, ...extra } });
  const S = page.run('S');
  S.groups = [{ name: 'G', repos: [{ id: 'abc', name: 'demo', path: 'p' }] }];
  S.summary = { rows: [card()], generatedAt: 'x' };
  page.run("ACTIONS['chat-open']({ dataset: { id: 'abc' } })");
  await page.tick();
  return { page, S };
}
const body = (page) => page.get('#chatBody').html;
const rows = (page) => count(body(page), 'class="qr-row"');
const buttons = (page) => count(body(page), 'data-act="quick-reply"');
const sendsOf = (page) => page.fetches.filter((f) => f.method === 'POST' && f.url === '/api/rpc/prompt');
const redraw = (page) => { page.run('draw()'); page.flush(); };
const click = (page, i) => page.run(`ACTIONS['quick-reply']({ dataset: { i: ${JSON.stringify(i)} } })`);

const fs = require('node:fs');
const path = require('node:path');
const PUBLIC = path.join(__dirname, '..', 'public');
const read = (f) => fs.readFileSync(path.join(PUBLIC, f), 'utf8').replace(/\r\n/g, '\n');
const slot = (page) => page.get('#quickRow').html;

// ====================================================================================================
// A. the markup
// ====================================================================================================
test('A1: index.html: an empty #quickRow slot in #composer, between #termBlock and the message field', () => {
  const html = read('index.html');
  assert.match(html, /<div id="quickRow" class="quick-slot"><\/div>/);
  const comp = html.slice(html.indexOf('id="composer"'));
  const a = comp.indexOf('id="termBlock"');
  const b = comp.indexOf('id="quickRow"');
  const c = comp.indexOf('class="msg-field"');
  assert.ok(a > 0 && b > a && c > b, 'termBlock < quickRow < msg-field');
});

// ====================================================================================================
// B. the page
// ====================================================================================================
test('B1: options: the slot holds the row with the chips and the body holds no row', async () => {
  const { page, S } = await chatPage();
  const h = slot(page);
  assert.match(h, /<div class="qr-row" role="group" aria-label="Quick replies">/);
  for (let i = 0; i < 3; i++) assert.match(h, new RegExp(`<button type="button" class="qr" data-act="quick-reply" data-i="${i}">`));
  assert.equal(count(body(page), 'qr-row'), 0);
  assert.equal(count(body(page), 'quick-reply'), 0);
  assert.equal(S.quick.options.length, 3);
});

test('B2: a question only: the slot holds the Reply chip with quick-focus and the body none', async () => {
  const { page } = await chatPage({ '/api/chat': histOf(item('user', 'go'), ASSISTANT('Done.\n\n¿Querés que lo suba?')) });
  assert.match(slot(page), /<button type="button" class="qr qr-reply" data-act="quick-focus">Reply<\/button>/);
  assert.equal(count(body(page), 'qr-row'), 0);
  assert.equal(count(body(page), 'quick-focus'), 0);
});

test('B3: no replies: the slot is empty and the body has no row; it empties again when the options go away', async () => {
  const { page } = await chatPage({ '/api/chat': histOf(item('user', 'go'), ASSISTANT('Nothing to choose.')) });
  assert.equal(slot(page), '');
  assert.equal(count(body(page), 'qr-row'), 0);
  const { page: p2 } = await chatPage();
  assert.ok(slot(p2).includes('qr-row'));
  p2.run("setRpc('abc', { state: 'busy' }); draw()");
  p2.flush();
  assert.equal(slot(p2), '', 'busy: the row leaves');
});

test('B4: the slot is painted before the scroll snapshot of the body', () => {
  const src = read('chat.js');
  const d = src.slice(src.indexOf('function drawChat'));
  const paintAt = d.indexOf("$('#quickRow')");
  assert.ok(paintAt > 0, 'drawChat paints #quickRow');
  assert.ok(paintAt < d.indexOf('chatScrollSnap(body)'), 'before the snapshot');
  assert.ok(paintAt < d.indexOf('chatScrollRestore(body, snap)'), 'before the restore');
});

test('B5: a page without #quickRow still draws (the slot is guarded)', async () => {
  const page = loadPage({ answers: BASE });
  page.run("{ const q = document.querySelector; document.querySelector = (s) => (s === '#quickRow' ? null : q(s)); }");
  const S = page.run('S');
  S.groups = [{ name: 'G', repos: [{ id: 'abc', name: 'demo', path: 'p' }] }];
  S.summary = { rows: [card()], generatedAt: 'x' };
  page.run("ACTIONS['chat-open']({ dataset: { id: 'abc' } })");
  await page.tick();
  assert.ok(body(page).includes('class="m"'), 'the body still draws');
  assert.equal(S.quick.options.length, 3, 'S.quick is still set');
});

test('B6: a click on a chip still sends exactly that option', async () => {
  const { page } = await chatPage();
  click(page, '1');
  const sends = sendsOf(page);
  assert.equal(sends.length, 1);
  assert.deepEqual(JSON.parse(sends[0].body), { id: 'abc', text: 'adjust_task' });
});

test('B7: chatBody no longer draws the row; quickRow and quickOf keep their output', () => {
  const view = { id: 'abc', info: ADOPTED, hist: histOf(item('user', 'go'), ASSISTANT()), rpc: { state: 'idle', asks: [] } };
  assert.equal(R.chatBody(view, {}).includes('qr-row'), false);
  assert.deepEqual(R.quickOf(view).options, ['start_task', 'adjust_task', 'cancel']);
  assert.match(R.quickRow(R.quickOf(view)), /^<div class="qr-row" role="group" aria-label="Quick replies">/);
  assert.equal(R.quickRow(null), '');
});

// ====================================================================================================
// C. the style
// ====================================================================================================
test('C1: CSS: the slot takes no space when empty, is capped, and the row fits the composer', () => {
  const css = read('style.css');
  assert.match(css, /\.quick-slot\s*\{[^}]*flex:\s*none/);
  assert.match(css, /\.quick-slot:empty\s*\{[^}]*display:\s*none/);
  assert.match(css, /\.quick-slot\s+\.qr-row\s*\{[^}]*margin:\s*0[;\s}]/);
  assert.match(css, /\.quick-slot\s+\.qr-row\s*\{[^}]*max-height:\s*88px/);
  assert.match(css, /\.quick-slot\s+\.qr-row\s*\{[^}]*overflow-y:\s*auto/);
  assert.match(css, /\.quick-slot\s+\.qr-row\s*\{[^}]*gap:\s*6px/);
  assert.match(css, /\.quick-slot\s+\.qr-row\s*\{[^}]*flex-wrap:\s*wrap/);
});

test('C2: CSS: expanded (#chat.composing) the slot stays visible and flex none', () => {
  const css = read('style.css');
  const rule = /(#chat\.composing[^{}]*)\{[^}]*flex:\s*none[^}]*\}/g;
  let found = false;
  for (const m of css.matchAll(rule)) if (m[1].includes('#chat.composing .quick-slot')) found = true;
  assert.ok(found, 'the composing flex-none rule lists the slot');
  assert.doesNotMatch(css, /#chat\.composing[^{}]*\.quick-slot[^{}]*\{[^}]*display:\s*none/);
});

test('C3: CSS: the new rules come after the RP207 and RP208 rules and their media blocks; the chip rules are untouched', () => {
  const css = read('style.css');
  const slotAt = css.indexOf('.quick-slot {');
  assert.ok(slotAt > css.lastIndexOf('@media (pointer: coarse), (max-width: 760px) {'), 'after the RP208 media block');
  assert.ok(slotAt > css.indexOf('#chat.composing .ch-body'), 'after the RP208 composing rules');
  assert.match(css, /\.qr-row\s*\{[^}]*margin:\s*4px 0 8px/);
  assert.match(css, /\.qr:focus-visible\s*\{[^}]*outline:\s*2px/);
});

test('D1: when only the quick row changes (it appears or goes while no message changes) the reading position of the body is restored too: the body gets shorter or taller and must not hide its last message', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'chat.js'), 'utf8').replace(/\r\n/g, '\n');
  assert.ok(src.includes('const slotChanged = quickSlot ? paint(quickSlot, R.quickRow(qk)) : false;'), 'the slot paint says whether it changed');
  assert.ok(src.includes('const bodyChanged = paint(body, R.chatBody(shown, { now: Date.now() }));'), 'the body is always painted, whatever the slot did');
  assert.ok(src.includes('if (bodyChanged || slotChanged) {'), 'and the position is restored when either changed');
});
