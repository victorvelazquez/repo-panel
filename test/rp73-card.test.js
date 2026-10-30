'use strict';
// RP73 (S70), the page side: the pinned question card of the chat (class ch-ask) gets one answer button per option when the server sent
// dialog.choices, and a click posts { id, fingerprint, index } to /api/dialog/answer, optimistic like RP75. The real public/resumen.js
// and public/app.js in a vm with a fake fetch and fake timers: no network, no clock, no real session.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const R = require('../public/resumen.js');
const V = require('../public/view.js');

const PUBLIC = path.join(__dirname, '..', 'public');
const NAV = '↑↓ navigate  enter select  escape/ctrl+c cancel';
const FP = 'a1b2c3d4e5f60718';
const FP2 = '0f0e0d0c0b0a0908';

// ---------- the card as a pure function ----------
const choicesOf = (labels = ['Yes', 'No'], o = {}) => ({
  fingerprint: FP, options: labels.map((label) => ({ label, tone: /^(no|deny)\b/i.test(label) ? 'negative' : 'affirmative' })), complete: true, markerRow: 2, questionRows: ['Allow guarded git push?', 'git push -q origin demo'], ...o,
});
const dialogOf = (choices, lines = ['Allow guarded git push?', 'git push -q origin demo', '→ Yes', 'No', NAV]) => ({ text: lines.join('\n'), lines, selected: 2, ...(choices === undefined ? {} : { choices }) });
const info = (dialog) => ({ key: 'r1', adopted: { id: 's1', name: 'panel:alpha' }, adoptedFound: true, sessions: [], live: { state: 'waiting', count: 1, ...(dialog ? { dialog } : {}) } });
const HIST = { found: true, truncated: false, items: [{ role: 'user', text: 'hello there', at: null, tools: [] }] };
const body = (c) => R.chatBody({ id: 'r1', hist: HIST, ...c }, { now: Date.parse('2026-05-01T12:00:00Z') });
const cardOf = (html) => (/<div class="ch-ask[^"]*" role="alert">[\s\S]*$/.exec(html) || [''])[0];
const buttonsOf = (html) => (html.match(/<button\b[^>]*data-act="dialog-answer"[^>]*>[\s\S]*?<\/button>/g) || []).map((tag) => {
  const open = /^<button\b[^>]*>/.exec(tag)[0];
  const attr = (n) => { const m = new RegExp(`\\s${n}="([^"]*)"`).exec(open); return m ? m[1] : null; };
  return { tag, open, text: tag.replace(/^<button\b[^>]*>/, '').replace(/<\/button>$/, ''), cls: attr('class'), index: attr('data-index'), fp: attr('data-fp'), title: attr('title'), disabled: /\sdisabled(\s|=|>)/.test(open), type: attr('type') };
});
const OLD_NOTE = 'Answer it in the terminal of the session: the panel does not answer yet.';
const NEW_NOTE = 'Pick an answer, or answer it in the terminal.';

test('chatBody with choices: one button per option, in order, with its index, the fingerprint and the tone class', () => {
  const html = cardOf(body({ info: info(dialogOf(choicesOf(['Allow once', 'Allow for this session', 'Deny']))) }));
  const b = buttonsOf(html);
  assert.equal(b.length, 3);
  assert.deepEqual(b.map((x) => x.text), ['Allow once', 'Allow for this session', 'Deny']);
  assert.deepEqual(b.map((x) => x.index), ['0', '1', '2']);
  assert.deepEqual(b.map((x) => x.fp), [FP, FP, FP]);
  assert.deepEqual(b.map((x) => x.type), ['button', 'button', 'button']);
  assert.deepEqual(b.map((x) => x.disabled), [false, false, false]);
  for (const x of b.slice(0, 2)) assert.ok(x.cls.split(' ').includes('ask-btn') && x.cls.split(' ').includes('ask-affirmative') && !x.cls.includes('ask-negative'), x.cls);
  assert.ok(b[2].cls.split(' ').includes('ask-btn') && b[2].cls.split(' ').includes('ask-negative') && !b[2].cls.includes('ask-affirmative'), b[2].cls);
});

test('chatBody with choices: the note becomes "Pick an answer, or answer it in the terminal." and the question lines stay', () => {
  const html = cardOf(body({ info: info(dialogOf(choicesOf())) }));
  assert.match(html, /class="ch-ask-note"[^>]*>Pick an answer, or answer it in the terminal\.</);
  assert.ok(!html.includes(OLD_NOTE));
  assert.match(html, /class="ch-ask-title"[^>]*>The session is asking</);
  assert.match(html, /<mark class="ask-sel">→ Yes<\/mark>/);
  assert.ok(html.includes('git push -q origin demo'));
});

test('chatBody without choices (missing or null): no buttons, the old note, the card exactly as before', () => {
  for (const choices of [undefined, null]) {
    const html = cardOf(body({ info: info(dialogOf(choices)) }));
    assert.deepEqual(buttonsOf(html), []);
    assert.ok(html.includes(OLD_NOTE));
    assert.ok(!html.includes(NEW_NOTE));
    assert.ok(!html.includes('dialog-answer'));
  }
  const bare = cardOf(body({ info: info(null) }));
  assert.ok(bare.includes(OLD_NOTE) && buttonsOf(bare).length === 0);
});

test('chatBody: an incomplete question disables the affirmative buttons with a title; a negative one stays enabled', () => {
  const html = cardOf(body({ info: info(dialogOf(choicesOf(['Allow once', 'Deny', 'Allow for this session'], { complete: false }))) }));
  const [a, d, s] = buttonsOf(html);
  assert.equal(a.disabled, true);
  assert.equal(s.disabled, true);
  assert.equal(d.disabled, false);
  for (const x of [a, s]) {
    assert.ok(x.title && /cut off/i.test(x.title) && /terminal/i.test(x.title), x.title);
  }
  assert.ok(!d.title || !/cut off/i.test(d.title));
  assert.ok(html.includes(NEW_NOTE));
});

test('chatBody: a complete question has no disabled button and no cut-off title', () => {
  const html = cardOf(body({ info: info(dialogOf(choicesOf())) }));
  assert.equal(buttonsOf(html).length, 2, 'the buttons exist');
  for (const x of buttonsOf(html)) assert.ok(!x.disabled && !/cut off/i.test(x.title || ''), x.tag);
});

test('chatBody: a hostile label or fingerprint is escaped everywhere and never becomes a tag or an attribute', () => {
  const evil = '<img src=x onerror=alert(1)>';
  const choices = choicesOf([evil, 'No "quoted" & <b>'], { fingerprint: '"><img src=x onerror=alert(2)>' });
  const html = cardOf(body({ info: info(dialogOf(choices)) }));
  assert.ok(!html.includes('<img'), html);
  assert.ok(!/onerror=alert\(\d\)>/.test(html.replace(/&lt;[^&]*&gt;/g, '')), 'no live handler');
  assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;'));
  const b = buttonsOf(html);
  assert.equal(b.length, 2);
  assert.ok(!b[1].text.includes('<b>') && b[1].text.includes('&lt;b&gt;'));
  assert.ok(!b[0].open.includes('<img'));
});

test('chatBody: the arrow glyph is never part of a label (the buttons show the labels as the server sent them)', () => {
  const html = cardOf(body({ info: info(dialogOf(choicesOf(['Yes', 'No']))) }));
  assert.equal(buttonsOf(html).length, 2, 'the buttons exist');
  for (const x of buttonsOf(html)) assert.ok(!/[→>]/.test(x.text), x.text);
});

test('chatBody: no card and no button unless the session is waiting, even when a dialog with choices is present', () => {
  for (const state of ['free', 'working', 'none', 'unknown']) {
    const html = body({ info: { ...info(dialogOf(choicesOf())), live: { state, count: 1, dialog: dialogOf(choicesOf()) } } });
    assert.ok(!html.includes('ch-ask') && !html.includes('dialog-answer'), state);
  }
});

// ---------- the page ----------
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
  const store = {};
  const fetches = [];
  const timers = [];
  const tabEls = ['summary', 'work', 'conformity'].map((t) => element({ dataset: { tab: t } }));
  const get = (sel) => (els[sel] ||= (sel === 'meta[name=token]' ? element({ content: 'token' }) : element()));
  const doc = {
    hidden: false, querySelector: get, querySelectorAll: (s) => (String(s).includes('data-tab') ? tabEls : []),
    addEventListener(t, fn) { (docL[t] ||= []).push(fn); }, createElement: () => element(), body: element(), activeElement: null,
  };
  const ctx = vm.createContext({
    console, document: doc, location: { hash: '' }, AbortController,
    localStorage: { getItem: (k) => (k in store ? store[k] : null), setItem(k, v) { store[k] = String(v); }, removeItem(k) { delete store[k]; } },
    requestAnimationFrame: (cb) => { frames.push(cb); return frames.length; },
    setInterval: () => 0, confirm: () => true,
    setTimeout: (fn, ms) => { timers.push({ fn, ms, cleared: false }); return timers.length; },
    clearTimeout: (id) => { if (timers[id - 1]) timers[id - 1].cleared = true; },
    fetch: (url, opts = {}) => {
      fetches.push({ url, method: opts.method || 'GET', headers: opts.headers || {}, signal: opts.signal, body: opts.body });
      const a = Object.entries(answers).find(([k]) => url.startsWith(k));
      if (!a) return new Promise(() => {});
      return typeof a[1] === 'function' ? a[1](url, opts) : Promise.resolve({ ok: true, json: async () => a[1] });
    },
  });
  ctx.window = ctx;
  ctx.addEventListener = () => {};
  ctx.RepoPanelView = V;
  ctx.RepoPanelResumen = R;
  vm.runInContext(fs.readFileSync(path.join(PUBLIC, 'app.js'), 'utf8'), ctx);
  const flush = () => { while (frames.length) frames.shift()(); };
  const tick = async (n = 6) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); flush(); };
  return { ctx, get, flush, tick, fetches, timers, run: (code) => vm.runInContext(code, ctx) };
}

const gate = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };
const okJson = (data) => Promise.resolve({ ok: true, json: async () => data });
const failJson = (status, error) => Promise.resolve({ ok: false, status, statusText: 'Conflict', json: async () => ({ error }) });
const histOf = (text) => ({ key: 'abc', sessionId: 's1', found: true, items: [{ role: 'user', text, at: null, tools: [] }], truncated: false, updatedAt: null });
const card = (o = {}) => ({
  id: 'abc', name: 'demo', group: 'G', room: null, branch: 'main', progress: { total: 4, completada: 1, enRevision: 0, bloqueada: 0, pendiente: 3, enCurso: 0 }, session: { state: 'free' },
  next: null, blocking: [], lastMovement: { at: '2026-05-01T11:48:00Z', what: 'x' }, action: null, error: null, needs: false, rank: 9, ...o,
});
const LABELS = ['Allow once', 'Allow for this session', 'Deny'];

// A chat page with two repos (abc, xyz), each asking its own question (different fingerprints). `lives` can be replaced to change what the poll returns.
async function chatPage(answerPost, { lives } = {}) {
  const state = { lives: lives || { abc: { state: 'waiting', count: 1, dialog: dialogOf(choicesOf(LABELS)) }, xyz: { state: 'waiting', count: 1, dialog: dialogOf(choicesOf(['Yes', 'No'], { fingerprint: FP2 })) } } };
  const sessionsFor = (id) => ({ key: id, adopted: { id: 's1', name: 'panel:demo', adoptedAt: 'x' }, adoptedFound: true, sessions: [], live: state.lives[id] });
  const page = loadPage({
    answers: {
      '/api/dialog/answer': answerPost,
      '/api/sessions': (url) => okJson(sessionsFor(/id=(\w+)/.exec(url)[1])),
      '/api/chat': histOf('hello there'),
    },
  });
  const S = page.run('S');
  S.groups = [{ name: 'G', repos: [{ id: 'abc', name: 'demo', path: 'p' }, { id: 'xyz', name: 'other', path: 'q' }] }];
  S.summary = { rows: [card(), card({ id: 'xyz', name: 'other' })], generatedAt: 'x' };
  page.run('draw()');
  page.run("ACTIONS['chat-open']({ dataset: { id: 'abc' } })");
  await page.tick();
  return { page, S, state };
}
const html = (page) => page.get('#chatBody').html;
const buttons = (page) => buttonsOf(cardOf(html(page)));
const posts = (page) => page.fetches.filter((f) => f.method === 'POST' && f.url === '/api/dialog/answer');
const click = (page, index, fp = FP) => page.run(`ACTIONS['dialog-answer']({ dataset: { index: '${index}', fp: '${fp}' }, disabled: false })`);
const ours = (page) => page.fetches.filter((f) => /^\/api\/(pi|chat\/send|chat\/clear)\b/.test(String(f.url)));

test('page: the open card shows the answer buttons from the polled dialog', async () => {
  const { page } = await chatPage(() => gate().promise);
  const b = buttons(page);
  assert.deepEqual(b.map((x) => x.text), LABELS);
  assert.deepEqual(b.map((x) => x.fp), [FP, FP, FP]);
  assert.ok(html(page).includes(NEW_NOTE));
});

test('page: the click is optimistic - in the same tick every button is disabled and the card says "Sending the answer…", before the POST resolves', async () => {
  const post = gate();
  const { page } = await chatPage(() => post.promise);
  click(page, 1);
  assert.equal(posts(page).length, 1, 'the POST left in the same tick');
  page.flush();
  const b = buttons(page);
  assert.equal(b.length, 3, 'the buttons are still drawn');
  assert.deepEqual(b.map((x) => x.disabled), [true, true, true]);
  const card1 = cardOf(html(page));
  assert.ok(card1.includes('Sending the answer…'), card1);
  assert.match(card1, /class="[^"]*\bch-ask-sending\b[^"]*"/);
  assert.ok(!card1.includes('Answered:'));
  post.resolve();
});

test('page: the body is exactly { id, fingerprint, index } with the index as a number, to the user lane, and nothing else is sent', async () => {
  const post = gate();
  const { page } = await chatPage(() => post.promise);
  click(page, 2);
  const [p] = posts(page);
  assert.deepEqual(JSON.parse(p.body), { id: 'abc', fingerprint: FP, index: 2 });
  assert.equal(p.headers['x-priority'], 'user');
  assert.equal(p.headers['x-token'], 'token');
  assert.deepEqual(ours(page), [], 'no order and no message is sent by this flow');
  post.resolve();
});

test('page: two quick clicks (the same or another button) send ONE POST', async () => {
  const post = gate();
  const { page } = await chatPage(() => post.promise);
  click(page, 0);
  click(page, 0);
  click(page, 2);
  page.flush();
  click(page, 1);
  assert.equal(posts(page).length, 1);
  post.resolve();
});

test('page: on success the card shows "Answered: <label>", no button can be pressed, and the next poll without the dialog removes the card', async () => {
  const post = gate();
  const { page, state } = await chatPage(() => post.promise);
  click(page, 1);
  page.flush();
  post.resolve({ ok: true, json: async () => ({ answered: true, option: 'Allow for this session' }) });
  await page.tick();
  const card1 = cardOf(html(page));
  assert.ok(card1.includes('Answered: Allow for this session'), card1);
  assert.ok(!card1.includes('Sending the answer…'));
  assert.deepEqual(buttons(page).filter((x) => !x.disabled), [], 'nothing left to press');
  assert.equal(page.get('#toasts').children.length, 0, 'no toast');
  state.lives.abc = { state: 'free', count: 1 };
  page.run('chatTick()');
  await page.tick();
  assert.ok(!html(page).includes('ch-ask') && !html(page).includes('Answered:'));
  assert.deepEqual(ours(page), []);
});

test('page: on success the label is escaped in the card', async () => {
  const { page } = await chatPage(() => okJson({ answered: true, option: '<img src=x onerror=alert(1)>' }));
  click(page, 0);
  await page.tick();
  assert.ok(!html(page).includes('<img'));
  assert.ok(html(page).includes('Answered: &lt;img'));
});

test('page: on error the server message shows in the card (class ch-ask-error), the buttons come back, and there is no toast', async () => {
  const { page } = await chatPage(() => failJson(409, 'The question changed: look at the card again'));
  click(page, 0);
  page.flush();
  await page.tick();
  const card1 = cardOf(html(page));
  assert.match(card1, /class="[^"]*\bch-ask-error\b[^"]*"[^>]*>[^<]*The question changed: look at the card again/);
  assert.ok(!card1.includes('Sending the answer…') && !card1.includes('Answered:'));
  assert.deepEqual(buttons(page).map((x) => x.disabled), [false, false, false]);
  assert.equal(page.get('#toasts').children.length, 0, 'no toast');
  assert.deepEqual(ours(page), []);
});

test('page: after an error a new click posts again (the in-flight mark is gone), and the error message is escaped', async () => {
  let n = 0;
  const { page } = await chatPage(() => (++n === 1 ? failJson(409, '<b>bad</b>') : okJson({ answered: true, option: 'Allow once' })));
  click(page, 0);
  await page.tick();
  assert.ok(!html(page).includes('<b>bad</b>') && html(page).includes('&lt;b&gt;bad'));
  click(page, 0);
  await page.tick();
  assert.equal(posts(page).length, 2);
  assert.ok(html(page).includes('Answered: Allow once'));
});

test('page: a click on the card of another repo never sends the first one: it posts its own id and fingerprint, and its buttons are not disabled', async () => {
  const post = gate();
  const { page } = await chatPage(() => post.promise);
  click(page, 0);
  page.flush();
  page.run("ACTIONS['chat-open']({ dataset: { id: 'xyz' } })");
  await page.tick();
  const other = buttons(page);
  assert.deepEqual(other.map((x) => x.text), ['Yes', 'No']);
  assert.deepEqual(other.map((x) => x.disabled), [false, false]);
  assert.ok(!cardOf(html(page)).includes('Sending the answer…'));
  click(page, 1, FP2);
  const sent = posts(page).map((p) => JSON.parse(p.body));
  assert.deepEqual(sent, [{ id: 'abc', fingerprint: FP, index: 0 }, { id: 'xyz', fingerprint: FP2, index: 1 }]);
  post.resolve();
});

test('page: an index or fingerprint that is not what the card printed is never posted', async () => {
  const { page } = await chatPage(() => okJson({ answered: true, option: 'x' }));
  for (const [index, fp] of [['-1', FP], ['8', FP], ['1.5', FP], ['x', FP], ['', FP], ['0', 'nothex'], ['0', ''], ['0', `${FP}0`]]) {
    page.run(`ACTIONS['dialog-answer']({ dataset: { index: ${JSON.stringify(index)}, fp: ${JSON.stringify(fp)} }, disabled: false })`);
  }
  await page.tick();
  assert.equal(posts(page).length, 0);
});

test('page: with no chat open nothing is posted', async () => {
  const page = loadPage({ answers: { '/api/dialog/answer': okJson({ answered: true, option: 'Yes' }) } });
  click(page, 0);
  await page.tick();
  assert.equal(posts(page).length, 0);
});

test('page: the answer flow never posts to /api/pi, /api/chat/send or /api/chat/clear (source guard on the chat region of app.js)', () => {
  const app = fs.readFileSync(path.join(PUBLIC, 'app.js'), 'utf8');
  const at = app.indexOf("'dialog-answer'");
  assert.ok(at >= 0, "ACTIONS has a 'dialog-answer' entry");
  const entry = app.slice(at, at + 1800);
  assert.match(entry, /\/api\/dialog\/answer/);
  assert.doesNotMatch(entry.slice(0, entry.indexOf("\n  '", 20) > 0 ? entry.indexOf("\n  '", 20) : entry.length), /\/api\/pi\b|\/api\/chat\/(send|clear)/);
});

// ---------- found when looking at the card: the reason of a disabled button must be visible, not only a tooltip ----------
test('chatBody: a cut-off question says so in plain view; a complete one does not', () => {
  const cut = cardOf(body({ info: info(dialogOf(choicesOf(['Yes', 'No'], { complete: false }))) }));
  assert.match(cut, /<div class="ch-ask-warn"[^>]*>[^<]*cut off[^<]*refuse[^<]*terminal[^<]*<\/div>/i);
  const whole = cardOf(body({ info: info(dialogOf(choicesOf(['Yes', 'No']))) }));
  assert.ok(!/ch-ask-warn/.test(whole));
  const onlyRefusals = cardOf(body({ info: info(dialogOf(choicesOf(['No', 'Deny'], { complete: false }))) }));
  assert.ok(!/ch-ask-warn/.test(onlyRefusals), 'nothing is disabled, so nothing to explain');
});
