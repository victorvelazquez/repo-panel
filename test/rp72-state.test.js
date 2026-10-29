'use strict';
// RP72 (S66): the state of the adopted session moves INSIDE the composer frame (top left, state first, hint below) and the
// chat header is cleaned. Pure helpers (sessionState, sessionLabelHtml, chatHead), the static markup of index.html, the page
// wiring in app.js (vm harness, fake fetch, no real timers, no network) and the stylesheet read as text (no browser).
//
// PHASE 2 MUST REWRITE these two older tests: they pin the chip, the session name and the banner that RP72 removes from the header.
//   - test/rp54-chat.test.js line 262: "chat header: repo name, live chip with icon + word, adopted session name, close button, ..."
//   - test/rp68-composer.test.js line 272: "chatHead: an adopted session that is closed says "session closed"; with none adopted ..."
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const R = require('../public/resumen.js');
const PUBLIC = path.join(__dirname, '..', 'public');
const read = (f) => fs.readFileSync(path.join(PUBLIC, f), 'utf8');

// ---------- helpers (copied from rp68-composer.test.js) ----------
const card = (o = {}) => ({
  id: 'r1', name: 'alpha', group: 'G', room: null, branch: 'main', progress: { total: 4, completada: 1, enRevision: 0, bloqueada: 0, pendiente: 3, enCurso: 0 }, session: { state: 'free' },
  next: null, blocking: [], lastMovement: { at: '2026-05-01T11:48:00Z', what: 'x' }, action: null, error: null, needs: false, rank: 9, ...o,
});
const info = (o = {}) => ({ key: 'r1', adopted: null, adoptedFound: false, sessions: [], live: { state: 'none', count: 0 }, ...o });
const sess = (o = {}) => ({ id: 's1', name: 'panel:alpha', updatedAt: '2026-05-01T11:00:00Z', lastMessage: { role: 'user', text: 'last words' }, ...o });

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
    setInterval: (fn, ms) => { intervals.push({ fn, ms }); return intervals.length; }, setTimeout: () => 0, confirm: () => true,
    fetch: (url, opts = {}) => {
      fetches.push({ url, method: opts.method || 'GET', body: opts.body });
      const a = Object.entries(answers).find(([k]) => url.startsWith(k));
      if (!a) return new Promise(() => {});
      return typeof a[1] === 'function' ? a[1](url, opts) : Promise.resolve({ ok: true, json: async () => a[1] });
    },
  });
  ctx.window = ctx;
  ctx.addEventListener = () => {};
  ctx.RepoPanelView = require('../public/view.js');
  ctx.RepoPanelResumen = R;
  vm.runInContext(fs.readFileSync(path.join(PUBLIC, 'app.js'), 'utf8'), ctx);
  const flush = () => { while (frames.length) frames.shift()(); };
  const tick = async (n = 6) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); flush(); };
  const fire = (type, e = {}) => { for (const fn of docL[type] || []) fn({ type, preventDefault() {}, target: element(), ...e }); };
  return { ctx, get, flush, tick, fire, fetches, intervals, run: (code) => vm.runInContext(code, ctx) };
}

const seed = (page) => {
  const S2 = page.run('S');
  S2.groups = [{ name: 'G', repos: [{ id: 'abc', name: 'demo', path: 'p' }, { id: 'xyz', name: 'other', path: 'q' }] }];
  S2.summary = { rows: [card({ id: 'abc', name: 'demo' }), card({ id: 'xyz', name: 'other' })], generatedAt: 'x' };
  return S2;
};
const adoptedInfo = (live = 'free', o = {}) => info({ adopted: { id: 's1', name: 'panel:alpha' }, adoptedFound: true, live: { state: live, count: live === 'none' ? 0 : 1 }, ...o });
const ADOPTED = { key: 'abc', adopted: { id: 's1', name: 'panel:demo', adoptedAt: 'x' }, adoptedFound: true, sessions: [sess()], live: { state: 'free', count: 1 } };
const UNADOPTED = { key: 'abc', adopted: null, adoptedFound: false, sessions: [sess()], live: { state: 'none', count: 0 } };
const HIST = { key: 'abc', sessionId: 's1', found: true, items: [{ role: 'user', text: 'hello there', at: null, tools: [] }], truncated: false, updatedAt: null };
const okJson = (body) => Promise.resolve({ ok: true, json: async () => body });
// '/api/chat/send' and '/api/chat/clear' come BEFORE '/api/chat': the fake fetch takes the first key the url starts with.
const answersFor = (extra = {}) => ({
  '/api/chat/send': { sent: true, delivered: true }, '/api/chat/clear': { cleared: true }, '/api/pi': { sent: true, confirmed: true },
  '/api/sessions': ADOPTED, '/api/chat': HIST, ...extra,
});
async function ready(extra = {}) {
  const page = loadPage({ answers: answersFor(extra) });
  const S2 = seed(page);
  page.run("ACTIONS['chat-open']({ dataset: { id: 'abc' } })");
  await page.tick();
  return { page, S: S2 };
}
const live = (state, o = {}) => ({ ...ADOPTED, live: { state, count: state === 'none' ? 0 : 1 }, ...o });
const WORKING = 'The session is working: wait until it is free';
const WAITING_TITLE = 'Answer it in its terminal: the panel does not answer yet.';
const text = (html) => html.replace(/<[^>]*>/g, '');
const classes = (html) => new Set((/^<span[^>]*\sclass="([^"]*)"/.exec(html) || [, ''])[1].split(/\s+/).filter(Boolean));

// ---------- sessionState ----------
const ss = (c) => R.sessionState({ id: 'r1', ...c }, { name: 'alpha' });
const STATES = [
  ['info missing (not loaded)', { info: null }, { key: 'loading', tone: 'gray', icon: '○', word: 'loading…', animate: false }],
  ['not adopted', { info: info() }, { key: 'none', tone: 'gray', icon: '○', word: 'no session', animate: false }],
  ['not adopted, live working', { info: info({ live: { state: 'working', count: 1 } }) }, { key: 'none', tone: 'gray', icon: '○', word: 'no session', animate: false }],
  ['adopted, live none', { info: adoptedInfo('none') }, { key: 'closed', tone: 'gray', icon: '○', word: 'session closed', animate: false }],
  ['adopted, live free', { info: adoptedInfo('free') }, { key: 'free', tone: 'gray', icon: '○', word: 'free', animate: false }],
  ['adopted, live working', { info: adoptedInfo('working') }, { key: 'working', tone: 'green', icon: '●', word: 'working…', animate: true }],
  ['adopted, live waiting', { info: adoptedInfo('waiting') }, { key: 'waiting', tone: 'yellow', icon: '◐', word: 'asking you something', animate: false }],
  ['adopted, live unknown', { info: adoptedInfo('unknown') }, { key: 'unknown', tone: 'gray', icon: '?', word: 'unknown', animate: false }],
  ['adopted, live something else', { info: adoptedInfo('bogus') }, { key: 'unknown', tone: 'gray', icon: '?', word: 'unknown', animate: false }],
  ['adopted, no live at all', { info: adoptedInfo('free', { live: undefined }) }, { key: 'unknown', tone: 'gray', icon: '?', word: 'unknown', animate: false }],
  ['adopted but not found yet (live free)', { info: adoptedInfo('free', { adoptedFound: false }) }, { key: 'loading', tone: 'gray', icon: '○', word: 'session loading…', animate: false }],
  ['adopted but not found yet (live working)', { info: adoptedInfo('working', { adoptedFound: false }) }, { key: 'loading', tone: 'gray', icon: '○', word: 'session loading…', animate: false }],
];

test('sessionState: key, tone, icon, word and animate for every case', () => {
  assert.equal(typeof R.sessionState, 'function');
  for (const [name, c, want] of STATES) {
    const got = ss(c);
    for (const k of Object.keys(want)) assert.strictEqual(got[k], want[k], `${name}: ${k}`);
  }
});

test('sessionState: only working animates; title is a non-empty string everywhere and the exact old banner sentence for waiting', () => {
  for (const [name, c, want] of STATES) {
    const got = ss(c);
    assert.equal(typeof got.title, 'string', name);
    assert.ok(got.title.trim().length > 0, `${name}: title is not empty`);
    assert.strictEqual(got.animate, want.key === 'working', name);
  }
  assert.equal(ss({ info: adoptedInfo('waiting') }).title, WAITING_TITLE);
});

// ---------- sessionLabelHtml ----------
const label = (c) => R.sessionLabelHtml({ id: 'r1', ...c });

test('sessionLabelHtml: ONE span with role=status, the tone and key classes, the escaped title, the icon in i.ss-dot and the word', () => {
  assert.equal(typeof R.sessionLabelHtml, 'function');
  for (const [name, c, want] of STATES) {
    const html = label(c);
    const title = ss(c).title;
    assert.match(html, /^<span /, name);
    assert.match(html, /<\/span>$/, name);
    assert.equal((html.match(/<span/g) || []).length, 1, `${name}: exactly one span`);
    assert.match(html, /\srole="status"/, name);
    const cl = classes(html);
    for (const k of ['ss', `ss-${want.tone}`, `ss-${want.key}`]) assert.ok(cl.has(k), `${name}: class ${k} in ${[...cl]}`);
    assert.ok(html.includes(`title="${R.esc(title)}"`), `${name}: title`);
    assert.ok(html.includes(`<i class="ss-dot" aria-hidden="true">${want.icon}</i>`), `${name}: icon in i.ss-dot`);
    assert.ok(text(html).includes(want.word), `${name}: word`);
    assert.ok([`${want.icon} ${want.word}`, `${want.icon}${want.word}`].includes(text(html).trim()), `${name}: visible text is the icon and the word, got ${text(html)}`);
  }
});

test('sessionLabelHtml: ss-anim only while working; the label never uses the hidden attribute; the waiting title is escaped and in the element', () => {
  for (const [name, c, want] of STATES) {
    const html = label(c);
    assert.strictEqual(classes(html).has('ss-anim'), want.key === 'working', `${name}: ss-anim`);
    assert.doesNotMatch(html, /\shidden(?=[\s=>])/, name); // the attribute, not aria-hidden
    const t = /title="([^"]*)"/.exec(html); // the value ends at the first quote: a raw quote would cut it short
    assert.ok(t && !/[<>]/.test(t[1]) && /^(?: |>)/.test(html.slice(html.indexOf(t[0]) + t[0].length)), `${name}: nothing raw in the title attribute`);
  }
  assert.ok(label({ info: adoptedInfo('waiting') }).includes(`title="${R.esc(WAITING_TITLE)}"`));
});

// ---------- chatHead (cleaned) ----------
const head = (c) => R.chatHead({ id: 'r1', ...c }, { name: 'alpha' });
const HEADS = [
  ['not loaded', { info: null }], ['not adopted', { info: info() }], ['adopted/none', { info: adoptedInfo('none') }], ['adopted/free', { info: adoptedInfo('free') }],
  ['adopted/working', { info: adoptedInfo('working') }], ['adopted/waiting', { info: adoptedInfo('waiting') }], ['adopted/unknown', { info: adoptedInfo('unknown') }],
  ['adopted, not found', { info: adoptedInfo('free', { adoptedFound: false }) }],
];

test('chatHead: only the repo name and the close button; no chip, no state word, no session name or id, no banner, for every state', () => {
  for (const [name, c] of HEADS) {
    const html = head(c);
    assert.doesNotMatch(html, /class="chip|\bchip\b/, `${name}: no chip`);
    assert.doesNotMatch(html, /ch-sess|ch-live/, `${name}: no ch-sess or ch-live`);
    assert.doesNotMatch(html, /role="status"/, `${name}: no status banner`);
    assert.doesNotMatch(html, /panel:alpha/, `${name}: the session name is not in the head`);
    assert.doesNotMatch(html, /session closed|no session|free|working|asking you|unknown|The session is/, `${name}: no state word`);
    assert.equal(text(html).trim(), 'alpha✕', `${name}: visible text is exactly the name plus the close glyph`);
    assert.ok(!text(html).includes('s1'), `${name}: the id is never visible text`);
  }
});

test('chatHead: the name is bold with class ch-name; its title carries "<name> · <session id>" when adopted and just the name otherwise', () => {
  const nameTag = (html) => (/<b[^>]*\bclass="[^"]*\bch-name\b[^"]*"[^>]*>/.exec(html) || [''])[0];
  const titleOf = (html) => (/\stitle="([^"]*)"/.exec(nameTag(html)) || [])[1];
  assert.ok(nameTag(head({ info: adoptedInfo('free') })), 'b.ch-name exists');
  assert.equal(titleOf(head({ info: adoptedInfo('free') })), 'alpha · s1');
  assert.equal(titleOf(head({ info: adoptedInfo('working') })), 'alpha · s1');
  assert.equal(titleOf(head({ info: info() })), 'alpha');
  assert.equal(titleOf(head({ info: null })), 'alpha');
  assert.match(head({ info: adoptedInfo('free') }), /<b[^>]*>alpha<\/b>/);
});

test('chatHead: the id is escaped in the title and the name too; the close button keeps data-act, title and aria-label', () => {
  const tricky = R.chatHead({ id: 'r1', info: info({ adopted: { id: 'a"<b>', name: 'n' }, adoptedFound: true, live: { state: 'free', count: 1 } }) }, { name: '<i>x</i>' });
  assert.doesNotMatch(tricky, /<i>x|a"<b>/);
  assert.match(tricky, /&lt;i&gt;x&lt;\/i&gt; · a&quot;&lt;b&gt;/);
  const btn = (/<button[^>]*data-act="chat-close"[^>]*>/.exec(head({ info: adoptedInfo('free') })) || [''])[0];
  assert.ok(btn, 'close button exists');
  assert.match(btn, /\stitle="[^"]+"/);
  assert.match(btn, /\saria-label="[^"]+"/);
  assert.match(btn, /type="button"/);
});

// ---------- composerState unchanged (PRESERVE) ----------
test('composerState: unchanged by RP72 (working: cannot send, same reason, same placeholder)', () => {
  assert.deepEqual(R.composerState({ id: 'r1', sending: false, info: adoptedInfo('working') }, { name: 'alpha' }), { canSend: false, reason: WORKING, placeholder: WORKING });
  assert.deepEqual(R.composerState({ id: 'r1', sending: false, info: adoptedInfo('free') }, { name: 'alpha' }), { canSend: true, reason: '', placeholder: 'Message the pi session of alpha' });
});

// ---------- index.html ----------
test('index.html: div#sessState.sess-state is the FIRST child of div#composer and comes before textarea#msgBox; it is never hidden', () => {
  const html = read('index.html');
  assert.match(html, /<div id="composer"[^>]*>\s*<div id="sessState" class="sess-state"><\/div>/);
  const composer = html.indexOf('id="composer"');
  const at = html.indexOf('id="sessState"');
  const box = html.indexOf('id="msgBox"');
  assert.ok(composer >= 0 && at > composer, 'sessState is inside the composer');
  assert.ok(box > at, 'sessState comes before the textarea');
  assert.doesNotMatch((/<[^>]*id="sessState"[^>]*>/.exec(html) || [''])[0], /\bhidden\b/);
});

// ---------- page ----------
const box = (page) => {
  const b = page.get('#msgBox');
  const w = { count: 0 };
  let val = 'half-typed message';
  Object.defineProperty(b, 'value', { get: () => val, set: (v) => { w.count++; val = v; }, configurable: true });
  return w;
};

test('page: after drawChat #sessState holds the label of the state: working (ss-working, ss-anim, working…), free (ss-free, no ss-anim)', async () => {
  const w = (await ready({ '/api/sessions': live('working') })).page.get('#sessState').html;
  assert.ok(w.includes('ss-working') && w.includes('ss-anim') && w.includes('working…'), w);
  const f = (await ready({ '/api/sessions': live('free') })).page.get('#sessState').html;
  assert.ok(f.includes('ss-free'), f);
  assert.ok(!f.includes('ss-anim'), f);
});

test('page: an unadopted repo shows ss-none; adopted with a closed session shows ss-closed; waiting shows ss-waiting', async () => {
  assert.ok((await ready({ '/api/sessions': UNADOPTED })).page.get('#sessState').html.includes('ss-none'));
  assert.ok((await ready({ '/api/sessions': live('none') })).page.get('#sessState').html.includes('ss-closed'));
  assert.ok((await ready({ '/api/sessions': live('waiting') })).page.get('#sessState').html.includes('ss-waiting'));
});

test('page: while the chat info is still loading the label says loading… (ss-loading)', async () => {
  const page = loadPage({ answers: {} });
  seed(page);
  page.run("ACTIONS['chat-open']({ dataset: { id: 'abc' } })");
  await page.tick();
  const html = page.get('#sessState').html;
  assert.ok(html.includes('ss-loading') && html.includes('loading…'), html);
});

test('page: the label is painted only while the chat is open; closing it leaves #sessState untouched and it is never hidden', async () => {
  const idle = loadPage({ answers: answersFor() });
  seed(idle);
  idle.run('drawChat()');
  assert.equal(idle.get('#sessState').html, '');
  assert.equal(idle.get('#sessState').writes, 0);
  const { page } = await ready();
  const el = page.get('#sessState');
  assert.ok(el.writes > 0, 'painted while open');
  const before = el.writes;
  page.run("ACTIONS['chat-close']()");
  await page.tick();
  assert.equal(el.writes, before, 'not written once closed');
  assert.equal(el.hidden, false);
});

test('page: the 5 s poll with an unchanged answer does not rewrite #sessState (paint cache) and never touches #msgBox.value', async () => {
  const { page } = await ready({ '/api/sessions': live('working') });
  const el = page.get('#sessState');
  const w = box(page);
  const before = el.writes;
  assert.ok(before > 0, 'painted once');
  page.intervals.find((i) => i.ms === 5000).fn();
  await page.tick();
  assert.equal(el.writes, before);
  assert.equal(w.count, 0);
  assert.equal(page.get('#msgBox').value, 'half-typed message');
});

test('page: when the live state changes the poll repaints #sessState (working to free) and still leaves #msgBox.value alone', async () => {
  let state = 'working';
  const { page } = await ready({ '/api/sessions': () => okJson(live(state)) });
  const el = page.get('#sessState');
  const w = box(page);
  assert.ok(el.html.includes('ss-working'), el.html);
  const before = el.writes;
  state = 'free';
  page.intervals.find((i) => i.ms === 5000).fn();
  await page.tick();
  assert.ok(el.writes > before, 'repainted');
  assert.ok(el.html.includes('ss-free') && !el.html.includes('ss-anim'), el.html);
  assert.equal(w.count, 0);
});

test('page: the chat head painted by the page has no chip and no banner either', async () => {
  const { page } = await ready({ '/api/sessions': live('working') });
  const html = page.get('#chatHead').html;
  assert.ok(html.includes('ch-name'), html);
  assert.doesNotMatch(html, /chip|ch-live|ch-sess/);
});

// ---------- style.css (read as text) ----------
const css = read('style.css');
const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({ sel: m[1].trim(), body: m[2] }));
const has = (re) => rules.some((r) => re.test(`${r.sel}{${r.body}`));
const reduce = [...css.matchAll(/@media \(prefers-reduced-motion: reduce\)\s*\{((?:[^{}]*\{[^{}]*\})*)\s*\}/g)].map((m) => m[1]).join('\n');

test('style.css: .sess-state exists and the tone rules use the same colour tokens as .chip.green, .chip.yellow and .chip.gray', () => {
  assert.ok(rules.some((r) => /(^|[\s,])\.sess-state\b/.test(r.sel)), '.sess-state rule');
  for (const [tone, token] of [['green', '--green'], ['yellow', '--yellow'], ['gray', '--muted']]) {
    assert.ok(has(new RegExp(`\\.chip\\.${tone}\\b[^{}]*\\{[^}]*color:\\s*var\\(${token}\\)`)), `.chip.${tone} uses ${token}`);
    assert.ok(has(new RegExp(`\\.ss-${tone}\\b[^{}]*\\{[^}]*color:\\s*var\\(${token}\\)`)), `.ss-${tone} uses ${token}`);
  }
});

test('style.css: .ss-anim animates with the existing pulse-dot keyframes, only on the working label, and reduced motion turns it off', () => {
  assert.match(css, /@keyframes pulse-dot/);
  assert.ok(has(/\.ss-anim\b[^{}]*\{[^}]*animation:[^;}]*pulse-dot/), '.ss-anim sets animation: pulse-dot');
  const stray = rules.filter((r) => /\.ss-dot\b/.test(r.sel) && !/\.ss-anim\b/.test(r.sel) && /animation:\s*(?!none)/.test(r.body));
  assert.deepEqual(stray, [], 'a bare .ss-dot never animates');
  assert.ok(reduce.length > 0, 'a prefers-reduced-motion block exists');
  assert.match(reduce, /(\.ss-anim|\.ss-dot)\b[^{}]*\{[^}]*animation:\s*none/);
});

test('style.css: the old .ch-live and .ch-sess rules are gone', () => {
  assert.doesNotMatch(css, /\.ch-live\b/);
  assert.doesNotMatch(css, /\.ch-sess\b/);
});

test('style.css: .sess-state never relies on the hidden attribute', () => {
  assert.doesNotMatch(css, /\.sess-state\[hidden\]/);
  assert.doesNotMatch(css, /\.ss-[\w-]*\[hidden\]/);
});
