'use strict';
// RP171: a running subagent is ONE bubble at the end of the chat thread («Subagent working · NAME», a clock), and when it ends it stays as ONE result line («Subagent NAME finished · M:SS»).
// It REPLACES the chip of the composer, the chip of the tool `subagent_run` in the thread and the grey «working…» bubbles; every datum is drawn in one place only. The name comes from the history the
// page already reads (the `arg` of the `subagent_run` item of `toolInfo`), never from the live events (the server whitelist is untouched). It only shows: it holds no button.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { appSource } = require('./pagesrc.js');
const V = require('../public/view.js');
const R = require('../public/resumen.js');

const read = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8').replace(/\r\n/g, '\n');
const css = read('public', 'style.css');
const T0 = 1000000000000;
const ID = 'abcdef0123';
const ADOPTED = { key: ID, adopted: { id: 's1', name: 'demo', adoptedAt: 'x' }, adoptedFound: true, sessions: [], live: { state: 'none', count: 0 } };
const pendingItem = (arg = 'flow-commit', over = {}) => ({ role: 'assistant', text: '', at: null, tools: ['subagent_run'], toolInfo: [{ name: 'subagent_run', ok: null, ms: null, arg, ...over }] });
const doneItem = (arg = 'flow-commit', ms = 5000, ok = true) => ({ role: 'assistant', text: 'done', at: null, tools: ['subagent_run'], toolInfo: [{ name: 'subagent_run', ok, ms, arg }] });
const rpc = (over = {}) => ({ state: 'busy', text: '', blocks: [], streaming: true, thinking: false, retry: null, asks: [], subs: 1, subSince: T0, ...over });
const chat = (items, r) => ({ id: ID, info: ADOPTED, hist: { items, truncated: false }, rpc: r });
const body = (items, r, now = T0 + 135000) => R.chatBody(chat(items, r), { now });
const count = (html, re) => (html.match(re) || []).length;
const BUBBLE = /role="status"[^>]*>[^<]*<i[^>]*aria-hidden="true">/; // the bubble: a status with a drawn icon first

// ---------- abuse first ----------
test('a1: a hostile name (markup, longer than 40, spaces, empty, not a string) never reaches the markup; the bubble says «Subagent working» with no name', () => {
  const evil = ['<img src=x onerror=1>', '"><script>alert(1)</script>', 'a'.repeat(41), 'two words', '', ' ', 'a/b', 'x\ny', 7, null, {}, ['flow-commit']];
  for (const arg of evil) {
    const h = body([pendingItem(arg)], rpc());
    assert.match(h, /Subagent working/, JSON.stringify(arg));
    assert.doesNotMatch(h, /<img|<script|onerror|alert\(1\)| · [^<]*<\/span>/, JSON.stringify(arg));
    assert.equal(count(h, /Subagent/g), 1, JSON.stringify(arg));
  }
  assert.match(body([pendingItem('a'.repeat(40))], rpc()), /Subagent working · a{40}/, 'exactly 40 is allowed');
  assert.match(body([pendingItem('Flow_2.x-y')], rpc()), /Subagent working · Flow_2\.x-y/);
});

test('a2: the result line applies the same rules: a hostile name is never drawn, and a finished item never shows markup', () => {
  for (const arg of ['<b>x</b>', 'a'.repeat(41), 'a b', '']) {
    const h = body([doneItem(arg)], rpc({ subs: 0, subSince: 0, streaming: false, state: 'idle' }));
    assert.match(h, /Subagent finished · 0:05/, JSON.stringify(arg));
    assert.doesNotMatch(h, /<b>x|a{41}|a b/);
  }
});

test('a3: an end with no start (no count, a finished item in the history) is one result line and no bubble', () => {
  const h = body([doneItem()], rpc({ subs: 0, subSince: 0 }));
  assert.equal(count(h, /Subagent flow-commit finished/g), 1);
  assert.doesNotMatch(h, /Subagent working/);
});

test('a4: a tool that ended with an error says «failed», never «finished»', () => {
  const h = body([doneItem('flow-commit', 7000, false)], rpc({ subs: 0, subSince: 0, state: 'idle', streaming: false }));
  assert.match(h, /Subagent flow-commit failed · 0:07/);
  assert.doesNotMatch(h, /finished/);
});

test('a5: two subagents at once: «2 subagents working» and the clock of the first, once', () => {
  const h = body([pendingItem('a'), pendingItem('b')], rpc({ subs: 2 }), T0 + 135000);
  assert.match(h, /2 subagents working/);
  assert.equal(count(h, /2:15|02:15/g), 1);
  assert.equal(count(h, /Subagent/gi), 1);
  assert.doesNotMatch(h, / · [ab]\b/, 'with several there is no single name to say');
});

test('a6: a history reloaded in the middle of the call (pending item present, count still 1) gives exactly ONE bubble and no chip of the tool', () => {
  const h = body([{ role: 'user', text: 'go', at: null, tools: [] }, pendingItem()], rpc());
  assert.equal(count(h, /Subagent working/g), 1);
  assert.equal(count(h, /role="status"/g), 1);
  assert.doesNotMatch(h, /subagent_run/, 'the dotted chip of the tool is not drawn');
  assert.match(h, /Subagent working · flow-commit/);
});

test('a7: a history reloaded after the end gives exactly ONE result line (and no chip of the tool, no bubble)', () => {
  const h = body([doneItem()], rpc({ subs: 0, subSince: 0, state: 'idle', streaming: false }));
  assert.equal(count(h, /Subagent/g), 1);
  assert.match(h, /Subagent flow-commit finished · 0:05/);
  assert.doesNotMatch(h, /subagent_run|class="tc /);
});

test('a8: no known duration: «Subagent NAME finished» with no time; a bad duration is no duration', () => {
  for (const ms of [null, -1, NaN, 'x', Infinity, 1e12]) {
    const h = body([doneItem('flow-commit', ms)], rpc({ subs: 0, subSince: 0, state: 'idle', streaming: false }));
    assert.match(h, /Subagent flow-commit finished(?! ·)/, String(ms));
  }
  const bare = { role: 'assistant', text: '', at: null, tools: ['subagent_run'], toolInfo: [{ name: 'subagent_run', ok: true, arg: 'flow-commit' }] };
  assert.match(body([bare], rpc({ subs: 0, subSince: 0, state: 'idle', streaming: false })), /Subagent flow-commit finished<\/span>/, 'no ms at all');
  const long = body([doneItem('flow-commit', 135000)], rpc({ subs: 0, subSince: 0, state: 'idle', streaming: false }));
  assert.match(long, /finished · 2:15/);
});

test('a9: the bubble says nothing when nobody knows of a subagent: the count is invalid, the session is not busy or asking, or the clock is bad', () => {
  for (const o of [{ subs: 0 }, { subs: -1 }, { subs: 1.5 }, { subs: '1' }, { subSince: 0 }, { subSince: NaN }, { state: 'idle' }, { state: 'closed' }, { state: 'starting' }]) {
    assert.doesNotMatch(body([pendingItem()], rpc(o)), /Subagent working/, JSON.stringify(o));
  }
  assert.match(body([pendingItem()], rpc({ state: 'asking' })), /Subagent working/);
  assert.doesNotMatch(R.chatBody(chat([pendingItem()], rpc()), {}), /Subagent working/, 'without a clock there is no bubble');
});

test('a10: nothing but the validated name of the history item is read: hostile fields of the entry and of the item are ignored', () => {
  const evil = '<img src=x onerror=1>';
  const h = body([pendingItem('flow-commit', { label: evil, task: evil, prompt: evil })], rpc({ text: '', error: evil, agent: evil, label: evil, task: evil, name: evil }));
  assert.doesNotMatch(h, /<img|onerror/);
  assert.match(h, /Subagent working · flow-commit/);
});

// ---------- the bubble ----------
test('b1: one subagent: the icon (hidden from screen readers), «Subagent working · NAME» and the clock from its start; the bubble is a status and the clock is aria-hidden', () => {
  const h = body([pendingItem()], rpc(), T0 + 135000);
  assert.match(h, BUBBLE);
  assert.match(h, /<i class="sub-dot" aria-hidden="true"><svg /);
  assert.match(h, /<div class="m subrun" role="status">/);
  assert.match(h, /Subagent working · flow-commit/);
  assert.match(h, /<b class="sub-time" aria-hidden="true">02:15<\/b>/);
  assert.doesNotMatch(h, /aria-live|aria-atomic/);
  assert.equal(count(h, /<svg/g), 1);
});

test('b2: the bubble is the END of the thread: after the messages and the live text, never before them', () => {
  const h = body([pendingItem(), { role: 'user', text: 'second', at: null, tools: [] }, pendingItem()], rpc({ text: 'typing now' }));
  assert.ok(h.lastIndexOf('Subagent working') > h.indexOf('typing now'));
  assert.ok(h.lastIndexOf('Subagent working') > h.lastIndexOf('second'));
  assert.ok(h.trimEnd().endsWith('</div>'));
  assert.equal(count(h, /Subagent working/g), 1);
});

test('b3: it never says slow or stuck, however long it has been on', () => {
  for (const hours of [0, 1, 30]) assert.doesNotMatch(body([pendingItem()], rpc(), T0 + hours * 3600000 + 5000), /slow|stuck|block|lento|bloque/i);
});

test('b4: the result line is a status that says it once, with no clock to announce', () => {
  const h = body([doneItem()], rpc({ subs: 0, subSince: 0, state: 'idle', streaming: false }));
  assert.match(h, /<div class="m subrun done" role="status">/);
  assert.doesNotMatch(h, /aria-live/);
});

// ---------- it replaces, it does not add ----------
test('r1: «working…» is ONE grey bubble when the session works and has nothing else to say, whatever the history ends with', () => {
  const tail = [pendingItem('flow-commit'), { role: 'assistant', text: '', at: null, tools: ['read'], toolInfo: [{ name: 'read', ok: true, ms: 5, arg: 'a.js' }] }];
  for (const items of [[], [{ role: 'user', text: 'hi', at: null, tools: [] }], [tail[1]], [{ role: 'assistant', text: '', at: null, tools: ['bash'] }]]) {
    const h = body(items, rpc({ subs: 0, subSince: 0 }));
    assert.equal(count(h, /class="m working"/g), 1, JSON.stringify(items));
  }
  assert.equal(count(body([tail[1]], rpc({ subs: 0, subSince: 0, thinking: true })), /thinking…/g), 1);
});

test('r2: no «working…» bubble while a subagent bubble shows (the bubble says it already)', () => {
  const h = body([{ role: 'assistant', text: '', at: null, tools: ['read'], toolInfo: [{ name: 'read', ok: true, ms: 5, arg: 'a.js' }] }, pendingItem()], rpc());
  assert.doesNotMatch(h, /working…/);
  assert.equal(count(h, /Subagent working/g), 1);
});

test('r3: a session that is not working shows no «working…» at all, not even for a history that ends with a tool-only item', () => {
  const h = body([{ role: 'assistant', text: '', at: null, tools: ['read'], toolInfo: [{ name: 'read', ok: true, ms: 5, arg: 'a.js' }] }], rpc({ subs: 0, subSince: 0, state: 'idle', streaming: false }));
  assert.doesNotMatch(h, /working…/);
});

test('r4: the chip of the tool `subagent_run` is gone from the thread; the chips of every other tool are drawn exactly as before (frozen)', () => {
  const items = [{ role: 'assistant', text: 'hi', at: null, tools: ['read', 'edit', 'bash'], toolInfo: [
    { name: 'read', ok: true, ms: 1200, arg: 'src/a.js', size: 2500 }, { name: 'edit', ok: true, ms: 80, arg: 'b.js', add: 3, del: 1 }, { name: 'bash', ok: false, ms: null, arg: 'git status' }, { name: 'grep', ok: null, ms: null, arg: 'x<y' },
  ] }];
  const frozen = '<div class="tools tcs"><span class="tc ok">✓ <b>read</b> <i>src/a.js</i> <small>1.2s</small> <small class="sz">2.5k chars</small></span><span class="tc ok">✓ <b>edit</b> <i>b.js</i> <small>80ms</small> <small class="chg">+3 −1</small></span><span class="tc bad">✗ <b>bash</b> <i>git status</i></span><span class="tc run">… <b>grep</b> <i>x&lt;y</i></span></div>';
  assert.ok(body(items, rpc({ subs: 0, subSince: 0, state: 'idle', streaming: false })).includes(frozen));
  const mixed = [{ ...items[0], tools: ['subagent_run', 'read'], toolInfo: [{ name: 'subagent_run', ok: true, ms: 3000, arg: 'flow-commit' }, items[0].toolInfo[0]] }];
  const h = body(mixed, rpc({ subs: 0, subSince: 0, state: 'idle', streaming: false }));
  assert.doesNotMatch(h, /<b>subagent_run<\/b>/);
  assert.ok(h.includes('<div class="tools tcs"><span class="tc ok">✓ <b>read</b> <i>src/a.js</i> <small>1.2s</small> <small class="sz">2.5k chars</small></span></div>'));
  assert.equal(count(h, /Subagent flow-commit finished · 0:03/g), 1);
});

test('r5: the rest of the thread is unchanged: user bubbles, assistant text, thinking, stop notes and real dialog cards', () => {
  const items = [{ role: 'user', text: 'hello', at: null, tools: [] }, { role: 'assistant', text: 'answer', at: null, tools: [], thinking: true }, { role: 'assistant', text: '', at: null, tools: [], stop: 'aborted' }];
  const asks = [{ requestId: 'r1', method: 'confirm', title: 'Run it?', message: 'rm x', options: [], truncated: false }];
  const h = body(items, rpc({ subs: 0, subSince: 0, streaming: false, state: 'asking', asks }));
  assert.match(h, /<div class="m me"><span class="who">You<\/span><p>hello<\/p><\/div>/);
  assert.match(h, /<div class="tools thought">▸ thinking…<\/div><div class="m"><span class="who">demo<\/span><p>answer<\/p><\/div>/);
  assert.match(h, /<div class="m stopnote aborted">⏹ Turn stopped<\/div>/);
  assert.match(h, /class="ch-ask" role="alert"/);
  assert.doesNotMatch(h, /Subagent|working…/);
});

test('r6: a retry still says so; it is not a second generic «working…»', () => {
  const h = body([], rpc({ subs: 0, subSince: 0, retry: { attempt: 1, max: 3, delayMs: 2000 } }));
  assert.match(h, /⟳ Retrying/);
  assert.doesNotMatch(h, /working…/);
});

// ---------- the stylesheet, the helper and the holds ----------
test('s1: the chip of the composer and its look are gone; the bubble has a look of its own that wraps, does not overflow and never animates', () => {
  assert.equal(typeof R.subagentChipHtml, 'undefined');
  assert.doesNotMatch(css, /\.sub-chip/);
  assert.doesNotMatch(read('public', 'resumen.js') + read('public', 'chat.js'), /sub-chip|subagentChipHtml/);
  const rule = (sel) => (css.match(new RegExp(`(?:^|\\n)${sel.replace(/[.]/g, '\\.')}\\s*\\{([^}]*)\\}`)) || [])[1];
  assert.ok(rule('.m.subrun'), 'a rule for the bubble');
  assert.match(rule('.sub-time'), /font-variant-numeric:\s*tabular-nums/);
  assert.doesNotMatch(rule('.m.subrun'), /animation|transition/);
  assert.doesNotMatch(css, /\.m\.subrun[^{]*\{[^}]*animation/);
  assert.match(rule('.m.subrun'), /overflow-wrap:\s*anywhere|word-break/, 'a long name wraps at 360 px');
});

test('s2: it only shows: the hold code of the page never reads the new data', () => {
  const tabs = read('public', 'tabs.js');
  const view = read('public', 'view.js');
  assert.doesNotMatch(tabs, /subSince|\.subs\b|subrun|subagent/i);
  const holds = view.split('\n').filter((l) => /hold|Hold|gate|busyReason/.test(l)).join('\n');
  assert.doesNotMatch(holds, /subSince|\.subs\b|subrun/);
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
function loadPage(answers) {
  const els = {};
  const frames = [];
  const timers = [];
  const tabEls = ['summary', 'work', 'conformity', 'settings'].map((t) => element({ dataset: { tab: t } }));
  const get = (sel) => (els[sel] ||= (sel === 'meta[name=token]' ? element({ content: 'token' }) : element()));
  const doc = { hidden: false, querySelector: get, querySelectorAll: (s) => (String(s).includes('data-tab') ? tabEls : []), addEventListener() {}, createElement: () => element(), body: element(), activeElement: null };
  const ctx = vm.createContext({
    console, document: doc, location: { hash: '' }, TextDecoder, AbortController, confirm: () => true,
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    requestAnimationFrame: (cb) => { frames.push(cb); return frames.length; }, setInterval: (fn, ms) => { timers.push({ fn, ms }); return timers.length; }, setTimeout: (fn) => { timers.push({ fn }); return timers.length; }, clearTimeout: () => {}, clearInterval: () => {},
    fetch: (url) => {
      const a = Object.entries(answers).find(([k]) => url.startsWith(k));
      if (!a) return new Promise(() => {});
      const v = typeof a[1] === 'function' ? a[1](url) : a[1];
      return Promise.resolve(v).then((json) => ({ ok: true, json: async () => json }));
    },
  });
  ctx.window = ctx;
  ctx.addEventListener = () => {};
  ctx.RepoPanelView = V;
  ctx.RepoPanelResumen = R;
  vm.runInContext(appSource(), ctx);
  const flush = () => { while (frames.length) frames.shift()(); };
  const tick = async (n = 8) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); flush(); };
  return { get, tick, timers, run: (code) => vm.runInContext(code, ctx) };
}
async function chatPage(items) {
  const page = loadPage({
    '/api/events': () => new Promise(() => {}), '/api/rpc/status': { state: 'busy', pendingDialogs: [], sessionId: 's1' }, '/api/rpc/context': { tokens: 1, percent: 1, window: 100 }, '/api/sessions': ADOPTED,
    '/api/chat': () => ({ key: ID, sessionId: 's1', found: true, items: page.items, truncated: false, updatedAt: null }),
  });
  page.items = items;
  const st = page.run('S');
  st.groups = [{ name: 'G', repos: [{ id: ID, name: 'demo', path: 'p' }] }];
  st.summary = { rows: [], generatedAt: 'x' };
  page.rpc = async (p) => { page.run(`applyRpc(${JSON.stringify({ id: ID, ...p })})`); await page.tick(); };
  page.state = () => page.get('#sessState').html;
  page.thread = () => page.get('#chatBody').html;
  page.reload = async () => { page.run(`loadChat('${ID}')`); await page.tick(); };
  await page.run(`ACTIONS['chat-open']({ dataset: { id: '${ID}' } })`);
  await page.tick();
  return page;
}
const start = { kind: 'event', record: { type: 'tool_execution_start', toolName: 'subagent_run' } };
const end = (isError = false) => ({ kind: 'event', record: { type: 'tool_execution_end', toolName: 'subagent_run', isError, durationMs: 5 } });

test('p1: the page draws the bubble in the thread on a live start, takes it away on the end, and the composer row never carries a subagent chip', async () => {
  const page = await chatPage([pendingItem()]);
  assert.doesNotMatch(page.thread(), /Subagent/);
  await page.rpc(start);
  assert.match(page.thread(), /Subagent working · flow-commit/);
  assert.match(page.thread(), /<b class="sub-time" aria-hidden="true">00:0\d<\/b>/);
  assert.doesNotMatch(page.state(), /sub-chip|Subagent|sub-time/, 'the composer row says nothing of the subagent');
  await page.rpc(end());
  assert.doesNotMatch(page.thread(), /Subagent working/);
  assert.doesNotMatch(page.state(), /sub-chip|Subagent/);
});

test('p2: the same subagent is drawn ONCE in the whole page (the thread plus the composer row), live, after a reload in the middle of the call and after the end', async () => {
  const page = await chatPage([pendingItem()]);
  await page.rpc(start);
  const whole = () => page.thread() + page.state();
  assert.equal(count(whole(), /Subagent/gi), 1, 'live');
  await page.reload();
  assert.equal(count(whole(), /Subagent/gi), 1, 'reloaded mid-call');
  assert.equal(count(whole(), /subagent_run/g), 0);
  page.items = [doneItem()];
  await page.rpc(end());
  await page.reload();
  assert.equal(count(whole(), /Subagent/gi), 1, 'reloaded after the end');
  assert.match(whole(), /Subagent flow-commit finished · 0:05/);
  assert.equal(count(whole(), /working…/g), 1, 'the run is still on: one generic bubble, never two');
});

test('p3: an end that failed leaves «failed», an end with no start leaves no bubble, and the clock runs by itself every second', async () => {
  const page = await chatPage([doneItem('flow-commit', 3000, false)]);
  await page.rpc(end(true));
  assert.match(page.thread(), /Subagent flow-commit failed · 0:03/);
  assert.doesNotMatch(page.thread(), /Subagent working/);
  const live = await chatPage([pendingItem()]);
  await live.rpc(start);
  live.run(`S.rpc['${ID}'].subSince = Date.now() - 125000`);
  live.run('subTick()');
  await live.tick();
  assert.match(live.thread(), /<b class="sub-time" aria-hidden="true">02:0\d<\/b>/);
  assert.ok(live.timers.find((t) => t.ms === 1000));
});
