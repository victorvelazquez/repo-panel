'use strict';
// RP208 (S19): the message box starts as ONE line, grows with its text up to 10 lines (never more than 40 % of the visible height) and then scrolls; on a phone or a narrow window a button expands the SAME
// field over the list of messages (a class on #chat, never position: fixed) and Escape, a send or a chat change fold it back. Fakes only: no server, no GitHub, no real session.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { appSource } = require('./pagesrc.js');
const R = require('../public/resumen.js');
const V = require('../public/view.js');

const PUBLIC = path.join(__dirname, '..', 'public');
const read = (f) => fs.readFileSync(path.join(PUBLIC, f), 'utf8').replace(/\r\n/g, '\n');
const css = read('style.css');
const html = read('index.html');

// ====================================================================================================
// A. boxFit: the arithmetic (pure). line 20, padding 8: one line is 28 px, ten lines are 208 px.
// ====================================================================================================
const fit = (lines, extra = {}) => V.boxFit({ scroll: 8 + 20 * lines, line: 20, pad: 8, view: 1000, ...extra });

test('A1: one line, three lines and ten lines grow the box to exactly their height and never scroll', () => {
  assert.deepEqual(fit(1), { height: 28, scrolls: false, rows: 1, expandable: false });
  assert.deepEqual(fit(3), { height: 68, scrolls: false, rows: 3, expandable: false });
  assert.deepEqual(fit(10), { height: 208, scrolls: false, rows: 10, expandable: true });
});

test('A2: past ten lines the height stops at ten lines and the box scrolls inside', () => {
  assert.deepEqual(fit(11), { height: 208, scrolls: true, rows: 11, expandable: true });
  assert.deepEqual(fit(60), { height: 208, scrolls: true, rows: 60, expandable: true });
  assert.equal(V.boxFit({ scroll: 8 + 20 * 5, line: 20, pad: 8, view: 1000, lines: 4 }).height, 88, 'the number of lines is a parameter');
});

test('A3: the height is also capped at 40 % of the visible height (the keyboard is open) and never below one line', () => {
  assert.deepEqual(fit(12, { view: 400 }), { height: 160, scrolls: true, rows: 12, expandable: true });
  assert.equal(fit(2, { view: 100 }).height, 40, '40 % of 100 is 40: a text taller than that is cut');
  assert.equal(fit(2, { view: 100 }).scrolls, true);
  assert.equal(fit(1, { view: 50 }).height, 28, 'the floor is one line');
  assert.equal(fit(5, { view: 50 }).height, 28, 'a tiny viewport still leaves one line');
  assert.equal(fit(5, { view: 50 }).scrolls, true);
  assert.equal(V.boxFit({ scroll: 108, line: 20, pad: 8, view: 400, share: 0.5 }).height, 108, 'the share is a parameter');
});

test('A4: expandable only above four lines; below one line of text still counts as one row', () => {
  assert.equal(fit(4).expandable, false);
  assert.equal(fit(5).expandable, true);
  assert.equal(V.boxFit({ scroll: 0, line: 20, pad: 8, view: 1000 }).rows, 1);
  assert.equal(V.boxFit({ scroll: 0, line: 20, pad: 8, view: 1000 }).height, 28);
});

test('A5: total: a missing or hostile measure is one line, never NaN and never a throw', () => {
  for (const bad of [undefined, null, NaN, 'x', {}, -5, Infinity]) {
    const r = V.boxFit({ scroll: bad, line: 20, pad: 8, view: 1000 });
    assert.deepEqual(r, { height: 28, scrolls: false, rows: 1, expandable: false }, String(bad));
  }
  assert.doesNotThrow(() => V.boxFit());
  assert.doesNotThrow(() => V.boxFit({}));
  const noView = V.boxFit({ scroll: 8 + 20 * 12, line: 20, pad: 8 });
  assert.equal(noView.height, 208, 'without a visible height only the ten lines cap it');
  assert.equal(V.boxFit({ scroll: 100, line: 20, pad: NaN, view: 1000 }).rows, 5, 'a missing padding is zero');
});

// ====================================================================================================
// B. the page: fitMsgBox, the places that set the value, the toggle
// ====================================================================================================
function element(extra = {}) {
  const el = {
    writes: 0, html: '', hidden: false, dataset: {}, disabled: false, value: '', checked: false, textContent: '', title: '', attrs: {}, listeners: {}, children: [], open: false, focused: 0,
    classList: { on: {}, add(c) { this.on[c] = true; }, remove(c) { this.on[c] = false; }, toggle(c, f) { this.on[c] = f === undefined ? !this.on[c] : !!f; }, contains(c) { return !!this.on[c]; } },
    style: { setProperty(k, v) { el.style[k] = v; } },
    addEventListener(t, fn) { (el.listeners[t] ||= []).push(fn); }, setAttribute(k, v) { el.attrs[k] = v; }, querySelector: () => null, querySelectorAll: () => [], closest: () => null,
    showModal() {}, close() {}, focus() { el.focused++; }, append(c) { el.children.push(c); },
    get innerHTML() { return el.html; },
    set innerHTML(v) { el.html = String(v); el.writes++; },
    ...extra,
  };
  return el;
}

function loadPage({ answers = {}, measure = true } = {}) {
  const els = {};
  const frames = [];
  const docL = {};
  const store = {};
  const fetches = [];
  const tabEls = ['summary', 'work', 'conformity'].map((t) => element({ dataset: { tab: t } }));
  const get = (sel) => (els[sel] ||= (sel === 'meta[name=token]' ? element({ content: 'token' }) : element()));
  const doc = {
    hidden: false, querySelector: get, querySelectorAll: (s) => (String(s).includes('data-tab') ? tabEls : []),
    addEventListener(t, fn) { (docL[t] ||= []).push(fn); }, createElement: () => element(), body: element(), activeElement: null,
  };
  const winL = {};
  const ctx = vm.createContext({
    console, document: doc, location: { hash: '' },
    localStorage: { getItem: (k) => (k in store ? store[k] : null), setItem(k, v) { store[k] = String(v); }, removeItem(k) { delete store[k]; } },
    requestAnimationFrame: (cb) => { frames.push(cb); return frames.length; },
    setInterval: () => 0, setTimeout: () => 0, clearTimeout: () => {}, AbortController, confirm: () => true,
    fetch: (url, opts = {}) => {
      fetches.push({ url, method: opts.method || 'GET', body: opts.body });
      const a = Object.entries(answers).find(([k]) => url.startsWith(k));
      if (!a) return new Promise(() => {});
      return Promise.resolve({ ok: true, json: async () => a[1] });
    },
    ...(measure ? { getComputedStyle: () => ({ lineHeight: '20px', paddingTop: '4px', paddingBottom: '4px', fontSize: '16px' }), innerHeight: 1000 } : {}),
  });
  ctx.window = ctx;
  ctx.addEventListener = (t, fn) => { (winL[t] ||= []).push(fn); };
  ctx.RepoPanelView = V;
  ctx.RepoPanelResumen = R;
  vm.runInContext(appSource(), ctx);
  const flush = () => { while (frames.length) frames.shift()(); };
  const tick = async (n = 6) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); flush(); };
  const key = (k, target, extra = {}) => { const e = { type: 'keydown', key: k, target, prevented: false, preventDefault() { e.prevented = true; }, ...extra }; for (const fn of docL.keydown || []) fn(e); return e; };
  const input = (target) => { for (const fn of docL.input || []) fn({ type: 'input', target }); };
  return { get, flush, tick, fetches, key, input, docL, winL, run: (c) => vm.runInContext(c, ctx) };
}

const card = (o = {}) => ({
  id: 'abc', name: 'demo', group: 'G', room: null, branch: 'main', progress: { total: 4, completada: 1, enRevision: 0, bloqueada: 0, pendiente: 3, enCurso: 0 }, session: { state: 'free' },
  next: null, blocking: [], lastMovement: { at: '2026-05-01T11:48:00Z', what: 'x' }, action: null, error: null, needs: false, rank: 9, ...o,
});
const sess = { id: 's1', name: 'panel:alpha', updatedAt: '2026-05-01T11:00:00Z', lastMessage: { role: 'user', text: 'last words' } };
const ADOPTED = { key: 'abc', adopted: { id: 's1', name: 'panel:demo', adoptedAt: 'x' }, adoptedFound: true, sessions: [sess], live: { state: 'free', count: 1 } };
const BASE = {
  '/api/rpc/start': { state: 'idle', pendingDialogs: [], sessionId: 's1' }, '/api/rpc/status': { state: 'idle', pendingDialogs: [], sessionId: 's1' }, '/api/rpc/prompt': { disposition: 'started' },
  '/api/pi-status': { state: 'busy' }, '/api/sessions': ADOPTED, '/api/chat': { key: 'abc', sessionId: 's1', found: true, items: [], truncated: false, updatedAt: null },
};
async function chatPage(opts = {}) {
  const page = loadPage({ answers: { ...BASE, ...(opts.answers || {}) }, measure: opts.measure });
  const S = page.run('S');
  S.groups = [{ name: 'G', repos: [{ id: 'abc', name: 'demo', path: 'p' }, { id: 'def', name: 'other', path: 'q' }] }];
  S.summary = { rows: [card(), card({ id: 'def', name: 'other' })], generatedAt: 'x' };
  if (opts.draft) S.drafts.abc = opts.draft;
  page.run("ACTIONS['chat-open']({ dataset: { id: 'abc' } })");
  await page.tick();
  const box = page.get('#msgBox');
  box.id = 'msgBox';
  return { page, S, box, btn: page.get('#msgExpand'), chat: page.get('#chat') };
}
const lines = (n) => 8 + 20 * n; // padding 4 + 4, line 20

test('B1: fitMsgBox sizes the box from the measure (line height and padding come from the computed style)', async () => {
  const { page, box } = await chatPage();
  box.scrollHeight = lines(3);
  page.run('fitMsgBox()');
  assert.equal(box.style.height, '68px');
  assert.equal(box.style.overflowY, 'hidden');
  box.scrollHeight = lines(12);
  page.run('fitMsgBox()');
  assert.equal(box.style.height, '208px');
  assert.equal(box.style.overflowY, 'auto', 'beyond ten lines it scrolls inside');
});

test('B2: the visible height caps it: the visualViewport wins over innerHeight', async () => {
  const { page, box } = await chatPage();
  box.scrollHeight = lines(12);
  page.run('window.visualViewport = { height: 300 }');
  page.run('fitMsgBox()');
  assert.equal(box.style.height, '120px', '40 % of 300');
  page.run('window.visualViewport = undefined');
  page.run('fitMsgBox()');
  assert.equal(box.style.height, '208px', 'without it innerHeight (1000) leaves room for ten lines');
});

test('B3: a page without layout (no scrollHeight, no getComputedStyle) is one line and never throws', async () => {
  const { page, box } = await chatPage({ measure: false });
  assert.doesNotThrow(() => page.run('fitMsgBox()'));
  assert.notEqual(box.style.height, 'auto', 'the inline height is not left at auto');
  assert.equal(page.get('#msgExpand').hidden, true);
  const { page: p2, box: b2 } = await chatPage();
  b2.scrollHeight = undefined;
  assert.doesNotThrow(() => p2.run('fitMsgBox()'));
  assert.notEqual(b2.style.height, 'auto');
  assert.equal(p2.get('#msgExpand').hidden, true);
});

test('B4: the expand button shows only above four lines', async () => {
  const { page, box, btn } = await chatPage();
  box.scrollHeight = lines(4);
  page.run('fitMsgBox()');
  assert.equal(btn.hidden, true);
  box.scrollHeight = lines(5);
  page.run('fitMsgBox()');
  assert.equal(btn.hidden, false);
  assert.equal(btn.attrs['aria-expanded'], 'false');
  assert.equal(btn.attrs['aria-label'], 'Expand the message box');
  box.scrollHeight = lines(1);
  page.run('fitMsgBox()');
  assert.equal(btn.hidden, true);
});

test('B5: typing, resize, rotation and the keyboard (visualViewport) run the fit', async () => {
  const { page, box } = await chatPage();
  box.scrollHeight = lines(6);
  page.input(box);
  assert.equal(box.style.height, '128px', 'the input event');
  box.scrollHeight = lines(2);
  for (const t of ['resize', 'orientationchange']) {
    assert.ok((page.winL[t] || []).length > 0, `${t} is listened to`);
    box.style.height = '';
    for (const fn of page.winL[t]) fn({});
    assert.equal(box.style.height, '48px', t);
  }
  assert.match(appSource(), /visualViewport[^\n]*addEventListener\('resize', fitMsgBox\)/);
});

test('B6: the places that set the value call the fit: the draft restored when a chat opens, the clear after a send and the text put back after a refused send', async () => {
  const { page, box } = await chatPage({ draft: 'one\ntwo\nthree' });
  assert.equal(box.value, 'one\ntwo\nthree');
  box.scrollHeight = lines(3);
  page.run("ACTIONS['chat-close']()");
  page.run("ACTIONS['chat-open']({ dataset: { id: 'abc' } })");
  assert.equal(box.style.height, '68px', 'opening a chat fits the restored draft');
  box.value = 'hello';
  box.scrollHeight = lines(1);
  page.run('sendChatMessage()');
  assert.equal(box.value, '');
  assert.equal(box.style.height, '28px', 'the clear is fitted at once');
});

test('B7: the history recall (app.js) and the restore after a refused send (chat.js) are followed by the fit (sources)', () => {
  const src = appSource();
  const at = [];
  const all = src.split('\n');
  all.forEach((l, i) => { if (/#msgBox'\)\.value = |\bbox\.value = step\.text/.test(l) && !/^\s*\/\//.test(l)) at.push(i); });
  assert.ok(at.length >= 4, `found ${at.length} assignments`);
  for (const i of at) assert.ok(/fitMsgBox\(\)/.test(all.slice(i, i + 3).join('\n')), `line ${i + 1} is followed by fitMsgBox(): ${all[i].trim()}`);
  assert.match(src, /if \(S\.chat\.id === id\) \{ \$\('#msgBox'\)\.value = back; fitMsgBox\(\); \} else S\.drafts\[id\] = back;/);
});

test('B8: the toggle: a class on #chat, aria-expanded, the label, the focus, and no second field', async () => {
  const { page, S, box, btn, chat } = await chatPage();
  box.scrollHeight = lines(6);
  page.run('fitMsgBox()');
  assert.equal(S.composing, false);
  page.run("ACTIONS['msg-expand']({})");
  assert.equal(S.composing, true);
  assert.equal(chat.classList.on.composing, true);
  assert.equal(btn.attrs['aria-expanded'], 'true');
  assert.equal(btn.attrs['aria-label'], 'Collapse the message box');
  assert.equal(btn.title, 'Collapse the message box');
  assert.equal(btn.hidden, false);
  assert.ok(box.focused > 0, 'the focus stays in the textarea');
  assert.ok(box.style.height === '' || box.style.height === undefined, 'expanded: the inline height is cleared, the CSS sizes the field');
  box.scrollHeight = lines(1);
  page.run('fitMsgBox()');
  assert.equal(btn.hidden, false, 'while expanded the button stays, even for a short text');
  assert.ok(box.style.height === '' || box.style.height === undefined, 'fitMsgBox does not size an expanded box');
  page.run("ACTIONS['msg-expand']({})");
  assert.equal(S.composing, false);
  assert.equal(chat.classList.on.composing, false);
  assert.equal(btn.attrs['aria-expanded'], 'false');
  assert.equal(btn.attrs['aria-label'], 'Expand the message box');
  assert.equal(btn.hidden, true, 'a short text: the button goes');
  assert.equal(box.style.height, '28px');
});

test('B9: the draft is the same: expanding keeps the value and the draft', async () => {
  const { page, S, box } = await chatPage();
  box.value = 'a\nb\nc\nd\ne\nf';
  box.scrollHeight = lines(6);
  page.input(box);
  page.run("ACTIONS['msg-expand']({})");
  assert.equal(box.value, 'a\nb\nc\nd\ne\nf');
  assert.equal(S.drafts.abc, 'a\nb\nc\nd\ne\nf');
});

test('B10: a successful send collapses the box; a refused one leaves it as it was', async () => {
  const { page, S, box } = await chatPage();
  box.value = 'hi';
  page.run("ACTIONS['msg-expand']({})");
  page.run('sendChatMessage()');
  assert.equal(S.composing, false, 'collapsed after the send');
  const { page: p2, S: S2, box: b2 } = await chatPage();
  S2.rpc.abc = { state: 'asking' }; // RP236: a busy session takes the message now; asking is the state that refuses
  b2.value = 'hi';
  p2.run("ACTIONS['msg-expand']({})");
  p2.run('sendChatMessage()');
  assert.equal(S2.composing, true, 'a refused send (the session is asking) does not collapse it');
});

test('B11: closing the chat or opening another one collapses it, and it is not saved between chats', async () => {
  const { page, S, chat } = await chatPage();
  page.run("ACTIONS['msg-expand']({})");
  page.run("ACTIONS['chat-close']()");
  assert.equal(S.composing, false);
  assert.equal(chat.classList.on.composing, false);
  page.run("ACTIONS['chat-open']({ dataset: { id: 'abc' } })");
  assert.equal(S.composing, false, 'a chat opens collapsed');
  page.run("ACTIONS['msg-expand']({})");
  page.run("ACTIONS['chat-open']({ dataset: { id: 'def' } })");
  assert.equal(S.composing, false, 'changing the chat collapses it');
  assert.equal(chat.classList.on.composing, false);
});

test('B12: Escape inside the box while expanded only collapses it; collapsed, Escape closes the chat as before; Escape elsewhere while expanded still closes it', async () => {
  const { page, S, box } = await chatPage();
  box.id = 'msgBox';
  page.run("ACTIONS['msg-expand']({})");
  const e = page.key('Escape', box);
  assert.equal(S.composing, false);
  assert.equal(S.chat.id, 'abc', 'the chat stays open');
  assert.equal(e.prevented, true);
  assert.ok(box.focused > 0);
  page.key('Escape', box);
  assert.equal(S.chat.id, null, 'collapsed: Escape closes the chat as before');
  page.run("ACTIONS['chat-open']({ dataset: { id: 'abc' } })");
  page.run("ACTIONS['msg-expand']({})");
  page.key('Escape', page.get('#chatHead'));
  assert.equal(S.chat.id, null, 'Escape from another element is the old rule (closing the chat folds it)');
  assert.equal(S.composing, false);
});

test('B13: quick replies fill nothing in the box (they send), so the box height is untouched', () => {
  const src = appSource();
  assert.ok(!/'quick-reply': [\s\S]{0,600}#msgBox'\)\.value/.test(src));
});

// ====================================================================================================
// C. the markup and the style
// ====================================================================================================
test('C1: index.html: one row, the expand button inside the composer with its icon and attributes', () => {
  const tag = /<textarea id="msgBox"[^>]*>/.exec(html)[0];
  assert.match(tag, /rows="1"/);
  assert.doesNotMatch(tag, /rows="2"/);
  assert.match(tag, /enterkeyhint="enter"/);
  const btn = /<button[^>]*id="msgExpand"[^>]*>[\s\S]*?<\/button>/.exec(html);
  assert.ok(btn, 'the button exists');
  assert.match(btn[0], /type="button"/);
  assert.match(btn[0], /data-act="msg-expand"/);
  assert.match(btn[0], /aria-label="Expand the message box"/);
  assert.match(btn[0], /aria-expanded="false"/);
  assert.match(btn[0], /title="Expand the message box"/);
  assert.match(btn[0], /\shidden[\s>]/);
  assert.match(btn[0], /<svg[^>]*width="16"[^>]*height="16"[^>]*stroke="currentColor"[^>]*stroke-width="1\.5"/);
  const composer = html.slice(html.indexOf('id="composer"'), html.indexOf('id="msgNote"'));
  assert.ok(composer.includes('id="msgExpand"') && composer.includes('id="msgBox"'));
});

test('C2: style.css: the textarea has no fixed min or max height any more', () => {
  const rule = /\n\.composer textarea \{[^}]*\}/.exec(css)[0];
  assert.doesNotMatch(rule, /min-height: 42px/);
  assert.doesNotMatch(rule, /max-height: 150px/);
  assert.doesNotMatch(css, /min-height: 42px; max-height: 150px/);
});

test('C3: style.css: the expanded mode is a class on #chat that hides the list and lets the composer and the field fill the height; nothing is position: fixed', () => {
  assert.match(css, /#chat\.composing \.ch-body \{[^}]*display: none/);
  const rules = css.match(/[^\n}]*#chat\.composing[^{\n]*\{[^}]*\}/g) || [];
  assert.ok(rules.length >= 3, `found ${rules.length} rules`);
  assert.ok(rules.every((r) => !/position:\s*fixed/.test(r)), 'no fixed position under .composing');
  assert.match(rules.join('\n'), /#chat\.composing \.composer \{[^}]*flex: 1 1 auto[^}]*min-height: 0/);
  assert.match(rules.join('\n'), /#chat\.composing[^{]*textarea[^{]*\{[^}]*flex: 1 1 auto[^}]*max-height: none/);
  const block = css.slice(css.indexOf('RP208'));
  assert.doesNotMatch(block.slice(0, block.indexOf('RP209') > 0 ? block.indexOf('RP209') : undefined), /position:\s*fixed/);
});

test('C4: style.css: the expand button is displayed only under (pointer: coarse), (max-width: 760px); the base rule hides it', () => {
  const base = /\n\.msg-expand \{[^}]*\}/.exec(css);
  assert.ok(base, 'a base rule for the button');
  assert.match(base[0], /display: none/);
  assert.match(css, /\.msg-expand\[hidden\] \{[^}]*display: none/);
  const media = /@media \(pointer: coarse\), \(max-width: 760px\) \{[^\n]*\.msg-expand[^\n]*display: (inline-)?flex[^\n]*\}|@media \(pointer: coarse\), \(max-width: 760px\) \{\n(?:[^\n]*\n)*?[^\n]*\.msg-expand[^\n]*display: (?:inline-)?flex/.exec(css);
  assert.ok(media, 'the display rule sits under the media query');
  const shown = css.match(/[^\n]*\.msg-expand[^\n]*display: (?:inline-)?flex[^\n]*/g) || [];
  assert.equal(shown.length, 1, 'only one rule shows it');
  const before = css.slice(0, css.indexOf(shown[0]));
  assert.ok(before.lastIndexOf('@media (pointer: coarse), (max-width: 760px)') > before.lastIndexOf('\n}\n'), 'and it is inside that media block');
});

// ====================================================================================================
// D. holes found by the mutations of the parent
// ====================================================================================================
test('A6: the rows are rounded, not cut: a phone measures in fractions, so five lines minus a pixel are five rows and four lines plus a pixel are four', () => {
  const near5 = V.boxFit({ scroll: 8 + 20 * 5 - 1, line: 20, pad: 8, view: 1000 });
  const near4 = V.boxFit({ scroll: 8 + 20 * 4 + 1, line: 20, pad: 8, view: 1000 });
  assert.equal(near5.rows, 5);
  assert.equal(near5.expandable, true);
  assert.equal(near4.rows, 4);
  assert.equal(near4.expandable, false);
});

test('B14: without an open chat the box is never expanded: the class goes out even if the state was left on, and the toggle does nothing', async () => {
  const page = loadPage({ answers: BASE });
  const S = page.run('S');
  const chat = page.get('#chat');
  S.composing = true;
  chat.classList.add('composing');
  page.run('fitMsgBox()');
  assert.equal(chat.classList.on.composing, false);
  S.composing = false;
  page.run('setMsgComposing(true, true)');
  assert.equal(S.composing, false, 'with no chat there is nothing to expand');
});

test('B15: the box is measured with its height on auto (a stale inline height would hide that the text shrank)', async () => {
  const { page, box } = await chatPage();
  let seen = null;
  Object.defineProperty(box, 'scrollHeight', { configurable: true, get() { seen = box.style.height; return lines(2); } });
  box.style.height = '208px';
  page.run('fitMsgBox()');
  assert.equal(seen, 'auto');
  assert.equal(box.style.height, '48px');
});

test('B16: drawing the chat with no chat open folds the expanded class away (the pick-a-repo state)', async () => {
  const page = loadPage({ answers: BASE });
  const chat = page.get('#chat');
  chat.classList.add('composing');
  page.run('drawChat()');
  assert.equal(chat.classList.on.composing, false);
});
