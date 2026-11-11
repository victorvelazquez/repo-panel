'use strict';
// RP155 (S44): while a tool runs, the chat drew the SAME assistant message twice: the history already holds the message that comes before the tool (it is saved as soon as it ends), and the live bubble of the session
// keeps its text until the run ends (the reducer clears it only at the next agent_start and at agent_settled). The person chose «compare when drawing»: the live bubble is not drawn when the last answer of the assistant that
// the history already has (one that comes AFTER the last message of the person: an older run never hides a new message) says the same thing, with the spaces collapsed the way the pending messages already compare.
// When the history does not have it yet the live bubble is drawn (no gap). When the copy is hidden and the run goes on, the «working…» line takes its place, so the chat never looks stopped. Known limit, tested: two messages
// that are legitimately identical and follow each other hide the live copy until the run ends; then the history shows both.
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { appSource } = require('./pagesrc.js');
const V = require('../public/view.js');
const R = require('../public/resumen.js');

const INFO = { adopted: { id: 's1', name: 'panel:alpha' }, adoptedFound: true, sessions: [] };
const asst = (text, extra = {}) => ({ role: 'assistant', text, at: null, tools: [], ...extra });
const user = (text) => ({ role: 'user', text, at: null, tools: [] });
const html = (items, rpc, more = {}) => R.chatBody({ id: 's1', info: INFO, hist: { found: true, items, truncated: false }, rpc, ...more }, {});
const live = (text, over = {}) => ({ state: 'busy', streaming: true, thinking: false, text, asks: [], ...over });
const count = (h, needle) => h.split(needle).length - 1;
const streamingBubbles = (h) => count(h, '<div class="m streaming">');
const T = 'Corriendo: el subagente para contar los archivos. Esperando: su respuesta.';

// ---------- the duplicate ----------
test('d1: the history already has the message and the live bubble says the same: the message is drawn ONCE, and there is no live bubble', () => {
  const h = html([user('go'), asst(T, { tools: ['bash'] })], live(T));
  assert.equal(count(h, 'Esperando: su respuesta.'), 1);
  assert.equal(streamingBubbles(h), 0);
});

test('d2: spaces and line breaks do not make them different (the same comparison the pending messages use)', () => {
  const h = html([user('go'), asst('Hola   mundo\n\nsegundo  párrafo')], live('Hola mundo segundo párrafo'));
  assert.equal(streamingBubbles(h), 0);
  assert.equal(streamingBubbles(html([user('go'), asst('Hola mundo segundo párrafo')], live('Hola\n\nmundo\tsegundo   párrafo '))), 0);
});

test('d3: the history does not have the message yet: the live bubble IS drawn (no gap), once', () => {
  const h = html([user('go')], live(T));
  assert.equal(streamingBubbles(h), 1);
  assert.equal(count(h, 'Esperando: su respuesta.'), 1);
});

test('d4: a different text, a longer one, a shorter one and another case are all drawn: only the same text is hidden', () => {
  for (const text of [`${T} Y algo más.`, 'Corriendo: el subagente', 'corriendo: el subagente para contar los archivos. esperando: su respuesta.', 'Otra cosa']) {
    const h = html([user('go'), asst(T)], live(text));
    assert.equal(streamingBubbles(h), 1, text);
    assert.equal(count(h, '<div class="m"><span class="who">panel:alpha</span>'), 1, 'the history bubble is still there');
  }
});

// ---------- which message of the history it is compared with ----------
test('d5: it is compared with the LAST answer with text, and a tool-only answer after it (no text) does not hide that', () => {
  const items = [user('go'), asst(T), asst('', { tools: ['read'] })];
  assert.equal(streamingBubbles(html(items, live(T))), 0);
  assert.equal(streamingBubbles(html([user('go'), asst('Primero.'), asst(T), asst('', { tools: ['bash'] })], live('Primero.'))), 1, 'an older answer of the same run is not the last one');
});

test('d6: a message of an OLDER run never hides a new one: only what comes after the last message of the person counts', () => {
  const items = [user('first'), asst(T), user('again'), asst('', { tools: ['bash'] })];
  assert.equal(streamingBubbles(html(items, live(T))), 1, 'the same words as the answer of the run before: the live one is a new message');
  assert.equal(streamingBubbles(html([user('first'), asst(T), user('again'), asst(T)], live(T))), 0, 'but once the history has it in THIS run, it is the duplicate');
});

test('d7: system items (a compaction note) and odd items between do not stop the search or break it', () => {
  // (a `null` item is not here: the drawing of the history itself, which this row does not touch, cannot take one and the server never sends it)
  const items = [user('go'), asst(T), { role: 'system', kind: 'compaction', at: null }, 7, 'x', {}, { role: 'assistant', tools: [] }, { role: 'assistant', text: 7, tools: [] }];
  assert.equal(streamingBubbles(html(items, live(T))), 0);
});

// ---------- the run goes on ----------
test('d8: when the copy is hidden and the run goes on, the «working…» line takes its place; with reasoning it says «thinking…»; a run that is over leaves nothing', () => {
  const items = [user('go'), asst(T, { tools: ['bash'] })];
  assert.match(html(items, live(T)), /<div class="m working">working…<\/div>/);
  assert.match(html(items, live(T, { thinking: true })), /<div class="m working">thinking…<\/div>/);
  const over = html(items, live(T, { streaming: false, state: 'idle' }));
  assert.doesNotMatch(over, /class="m working"/);
  assert.equal(streamingBubbles(over), 0);
});

test('d9: a retry line is drawn once and the dialog cards are still drawn, with the copy hidden', () => {
  const ask = { requestId: 'r1', method: 'confirm', title: 'Allow?', message: 'run it', options: [], truncated: false, expiresAt: null };
  const h = html([user('go'), asst(T)], live(T, { retry: { attempt: 2, max: 3, delayMs: 4000 }, asks: [ask] }));
  assert.equal(streamingBubbles(h), 0);
  assert.equal(count(h, 'Retrying'), 1);
  assert.doesNotMatch(h, /class="m working">working/, 'the retry line already says what is going on');
  assert.match(h, /class="ch-ask"/);
  assert.match(h, /Allow\?/);
});

// ---------- nothing else changes ----------
test('n1: with no live text everything is drawn as before: «working…» while a run is on, nothing when not, and the history alone', () => {
  const items = [user('go'), asst(T)];
  assert.match(html(items, live('')), /<div class="m working">working…<\/div>/);
  assert.doesNotMatch(html(items, live('', { streaming: false, state: 'idle' })), /class="m working"/);
  assert.equal(count(html(items, undefined), T), 1);
  assert.equal(count(html(items, null), T), 1);
});

test('n2: with no history, or odd history, the live bubble is drawn as before and nothing throws', () => {
  for (const hist of [undefined, null, { found: true }, { items: null }, { items: 'x' }, { items: {} }, { items: [] }]) {
    const h = R.chatBody({ id: 's1', info: INFO, hist, rpc: live(T) }, {});
    assert.equal(streamingBubbles(h), 1, JSON.stringify(hist));
  }
  const noAdopted = R.chatBody({ id: 's1', info: { adopted: { id: 's1', name: 'p' }, adoptedFound: false, sessions: [] }, hist: null, rpc: live(T) }, {});
  assert.equal(streamingBubbles(noAdopted), 1, 'a session that is still loading has no history to compare with');
});

test('n3: odd live text never throws and never hides anything: not a string, empty, only spaces', () => {
  for (const text of [undefined, null, 7, {}, [], '', '   \n  ']) {
    assert.doesNotThrow(() => html([user('go'), asst(T)], live(text)), String(text));
    assert.equal(count(html([user('go'), asst(T)], live(text)), T), 1, String(text));
  }
});

test('n4: what is hidden is not escaped away: markup in the text is escaped in the bubble that IS drawn, and a duplicate with markup is hidden whole', () => {
  const evil = '<img src=x onerror=1> & done';
  const shown = html([user('go')], live(evil));
  assert.ok(!shown.includes('<img'), shown);
  const hidden = html([user('go'), asst(evil)], live(evil));
  assert.equal(streamingBubbles(hidden), 0);
  assert.ok(!hidden.includes('<img'), hidden);
});

test('n5: a very long text compares fast and the message of the person and the pending ones are untouched', () => {
  const big = `${'palabra '.repeat(30000)}fin`;
  const t0 = Date.now();
  const h = html([user('go'), asst(big)], live(big));
  assert.ok(Date.now() - t0 < 2000, 'a 200 KB text compares in under two seconds');
  assert.equal(streamingBubbles(h), 0);
  const withPending = html([user('go'), asst(T)], live(T), { pending: [{ text: 'next one', base: 0, state: 'sending' }] });
  assert.match(withPending, /class="m me pending"[^>]*>[\s\S]*next one/);
  assert.equal(streamingBubbles(withPending), 0);
});

test('n6: the known limit: two messages that are really identical and follow each other: the live copy waits until the run ends, then the history shows both', () => {
  const items = [user('go'), asst('Listo.', { tools: ['bash'] })];
  assert.equal(streamingBubbles(html(items, live('Listo.'))), 0, 'hidden while the run is on');
  const after = html([...items, asst('Listo.')], live('Listo.', { streaming: false, state: 'idle', text: '' }));
  assert.equal(count(after, 'Listo.'), 2, 'the run ended: the history has both');
});

// ---------- the live text is the message being written, not the whole run ----------
// MEASURED on the real stream (11 November, with the turns of this very chat): a message arrives as message_start, then (if it reasons) the reasoning at position 0, the text at position 1 and message_end. The reducer keeps the text BLOCKS BY POSITION
// and cleared them only at the next agent_start, so the text of the message before stayed in the position the next one did not use (blocks [110] then [110, 1625]), and a text_delta is added to whatever its position already held.
const evn = (record) => ({ kind: 'event', record });
const upd = (type, contentIndex, extra = {}) => evn({ type: 'message_update', assistantMessageEvent: { type, contentIndex, ...extra } });
const say = (index, text) => [upd('text_start', index), upd('text_delta', index, { delta: text }), upd('text_end', index, { content: text })];
const run = (e, ...events) => events.flat().reduce((acc, p, i) => V.rpcReduce(acc, p, 1000 + i).entry, e);
const startRun = () => V.rpcReduce(null, evn({ type: 'agent_start' }), 1000).entry;
const stage = (e) => run(e, evn({ type: 'message_start' }), say(0, 'Mensaje uno'), upd('toolcall_start', 1), upd('toolcall_end', 1), evn({ type: 'message_end' }), evn({ type: 'tool_execution_start', toolName: 'bash' }));

test('m1: the real shape: a message with reasoning at position 0 and text at position 1 after one with text at position 0 shows ONLY the new text', () => {
  let e = stage(startRun());
  assert.equal(e.text, 'Mensaje uno', 'during the tool the finished message is still there (no gap before the history has it)');
  e = run(e, evn({ type: 'tool_execution_end', toolName: 'bash' }), evn({ type: 'message_start' }), evn({ type: 'message_end' }), evn({ type: 'turn_end' }), evn({ type: 'turn_start' }), evn({ type: 'message_start' }), upd('thinking_start', 0), upd('thinking_end', 0), say(1, 'Mensaje dos'));
  assert.equal(e.text, 'Mensaje dos');
});

test('m2: two messages with their text at the SAME position: the second is not added to the first (message_start clears it, and text_start does even without it)', () => {
  let e = run(stage(startRun()), evn({ type: 'message_start' }), upd('text_start', 0), upd('text_delta', 0, { delta: 'Dos' }));
  assert.equal(e.text, 'Dos');
  e = run(stage(startRun()), upd('text_start', 0), upd('text_delta', 0, { delta: 'Dos' }));
  assert.equal(e.text, 'Dos', 'a text_start alone starts its block empty');
});

test('m3: message_start clears only the live text and the reasoning flag: the state, the count of subagents, the dialogs, the retry, the memory and the context are untouched', () => {
  let e = V.rpcReduce(null, { kind: 'state', state: 'busy' }, 5).entry;
  e = run(e, evn({ type: 'agent_start' }), evn({ type: 'tool_execution_start', toolName: 'subagent_run' }), upd('thinking_start', 0), { kind: 'memory', memory: 'ready' }, { kind: 'dialog', requestId: 'r1', method: 'confirm', title: 'Allow?', message: 'x' }, evn({ type: 'auto_retry_start', attempt: 1, maxAttempts: 3, delayMs: 10 }), evn({ type: 'compaction_start' }));
  const before = { ...e, blocks: [...e.blocks] };
  e = V.rpcReduce(e, evn({ type: 'message_start' }), 9).entry;
  for (const k of ['state', 'streaming', 'subs', 'subSince', 'asks', 'retry', 'memory', 'ctx', 'compacting', 'startedAt', 'error']) assert.deepEqual(e[k], before[k], k);
  assert.deepEqual([e.text, e.blocks.length, e.thinking], ['', 0, false]);
});

test('m4: inside ONE message nothing changes: the blocks of several positions are still joined, and the deltas of one block still add up', () => {
  const e = run(startRun(), evn({ type: 'message_start' }), upd('text_start', 0), upd('text_delta', 0, { delta: 'Hola ' }), upd('text_delta', 0, { delta: 'mundo' }), upd('toolcall_start', 1), upd('text_start', 2), upd('text_delta', 2, { delta: 'Fin' }));
  assert.equal(e.text, 'Hola mundo\n\nFin');
});

test('m5: the first message of a run and a message_start before any text: the live text is empty, the run is still on, and odd forms never throw', () => {
  const e = run(startRun(), evn({ type: 'message_start' }));
  assert.deepEqual([e.text, e.streaming], ['', true]);
  for (const p of [evn({ type: 'message_start', message: { role: 'assistant' }, extra: 7 }), evn({ type: 'message_start', assistantMessageEvent: null }), { kind: 'event', record: { type: 'message_start' } }]) assert.doesNotThrow(() => V.rpcReduce(null, p, 1));
  assert.equal(V.rpcReduce(null, evn({ type: 'message_start' }), 1).entry.state, 'closed', 'a message_start does not wake a closed session');
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
  const tabEls = ['summary', 'work', 'conformity', 'settings'].map((t) => element({ dataset: { tab: t } }));
  const get = (sel) => (els[sel] ||= (sel === 'meta[name=token]' ? element({ content: 'token' }) : element()));
  const doc = { hidden: false, querySelector: get, querySelectorAll: (s) => (String(s).includes('data-tab') ? tabEls : []), addEventListener() {}, createElement: () => element(), body: element(), activeElement: null };
  const ctx = vm.createContext({
    console, document: doc, location: { hash: '' }, TextDecoder, AbortController, confirm: () => true,
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    requestAnimationFrame: (cb) => { frames.push(cb); return frames.length; }, setInterval: () => 0, setTimeout: () => 0, clearTimeout: () => {}, clearInterval: () => {},
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
  return { get, tick, run: (code) => vm.runInContext(code, ctx) };
}
const ID = 'abcdef0123';
async function chatPage(items) {
  const page = loadPage({
    '/api/events': () => new Promise(() => {}), '/api/rpc/status': { state: 'busy', pendingDialogs: [], sessionId: 's1' }, '/api/rpc/context': { tokens: 1, percent: 1, window: 100 },
    '/api/sessions': { key: ID, adopted: { id: 's1', name: 'demo', adoptedAt: 'x' }, adoptedFound: true, sessions: [], live: { state: 'none', count: 0 } },
    '/api/chat': { key: ID, sessionId: 's1', found: true, items, truncated: false, updatedAt: null },
  });
  const st = page.run('S');
  st.groups = [{ name: 'G', repos: [{ id: ID, name: 'demo', path: 'p' }] }];
  st.summary = { rows: [], generatedAt: 'x' };
  page.open = async () => { page.run(`ACTIONS['chat-open']({ dataset: { id: '${ID}' } })`); await page.tick(); };
  page.rpc = async (p) => { page.run(`applyRpc(${JSON.stringify({ id: ID, ...p })})`); await page.tick(); };
  page.body = () => page.get('#chatBody').html;
  return page;
}
const ev = (record) => ({ kind: 'event', record });
const said = (text) => ev({ type: 'message_update', assistantMessageEvent: { type: 'text_end', contentIndex: 0, content: text } });

test('p1: in the real page: the message the history already has and the live one are drawn ONCE while the tool runs; at the end of the run the chat is as before', async () => {
  const page = await chatPage([user('go'), asst(T, { tools: ['bash'] })]);
  await page.open();
  await page.rpc(ev({ type: 'agent_start' }));
  await page.rpc(said(T));
  assert.equal(count(page.body(), 'Esperando: su respuesta.'), 1);
  assert.equal(streamingBubbles(page.body()), 0);
  assert.match(page.body(), /<div class="m working">working…<\/div>/);
  await page.rpc(ev({ type: 'tool_execution_start', toolName: 'bash' }));
  assert.equal(count(page.body(), 'Esperando: su respuesta.'), 1, 'still once while the tool runs');
  await page.rpc(ev({ type: 'agent_settled' }));
  assert.equal(count(page.body(), 'Esperando: su respuesta.'), 1);
  assert.equal(streamingBubbles(page.body()), 0);
});

test('p3: in the real page, with several messages in one run: the live bubble holds ONLY the message being written, and the one the history already has is drawn once', async () => {
  const page = await chatPage([user('go'), asst('Mensaje uno', { tools: ['bash'] })]);
  await page.open();
  await page.rpc(ev({ type: 'agent_start' }));
  for (const p of [ev({ type: 'message_start' }), ...say(0, 'Mensaje uno'), ev({ type: 'message_end' }), ev({ type: 'tool_execution_start', toolName: 'bash' })]) await page.rpc(p);
  assert.equal(count(page.body(), 'Mensaje uno'), 1, 'during the tool: once');
  for (const p of [ev({ type: 'tool_execution_end', toolName: 'bash' }), ev({ type: 'message_start' }), ev({ type: 'message_end' }), ev({ type: 'message_start' }), upd('thinking_start', 0), upd('thinking_end', 0), ...say(1, 'Mensaje dos')]) await page.rpc(p);
  assert.equal(count(page.body(), 'Mensaje uno'), 1, 'the first message is NOT repeated inside the live bubble');
  assert.equal(streamingBubbles(page.body()), 1);
  assert.equal(count(page.body(), 'Mensaje dos'), 1);
});

test('p2: in the real page: when the history does not have the message yet the live bubble shows it, once', async () => {
  const page = await chatPage([user('go')]);
  await page.open();
  await page.rpc(ev({ type: 'agent_start' }));
  await page.rpc(said(T));
  assert.equal(streamingBubbles(page.body()), 1);
  assert.equal(count(page.body(), 'Esperando: su respuesta.'), 1);
});
