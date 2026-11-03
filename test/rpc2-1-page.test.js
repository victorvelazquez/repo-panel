'use strict';
// RPC2-1 (S1, S6, S8), the live chat in the page: the real public/app.js in a vm (fake fetch, a fake event stream, no timers, no network, no pi).
// Streaming bubble from `rpc` frames, one history reload when a run settles, Send that starts the session first, Stop, a failed send, the resync on
// open and on every (re)connect of the stream, and the Cancel line of a pending dialog.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const R = require('../public/resumen.js');
const V = require('../public/view.js');

const PUBLIC = path.join(__dirname, '..', 'public');
const ID = '0123456789';

function element(extra = {}) {
  const el = {
    html: '', hidden: false, dataset: {}, disabled: false, value: '', checked: false, textContent: '', title: '', placeholder: '', attrs: {}, listeners: {}, children: [], open: false,
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    style: { setProperty(k, v) { el.style[k] = v; } },
    addEventListener(t, fn) { (el.listeners[t] ||= []).push(fn); }, setAttribute(k, v) { el.attrs[k] = v; }, querySelector: () => null, querySelectorAll: () => [], closest: () => null,
    showModal() {}, close() {}, focus() {}, append(c) { el.children.push(c); },
    get innerHTML() { return el.html; },
    set innerHTML(v) { el.html = String(v); },
    ...extra,
  };
  return el;
}

// A stream the test feeds by hand: `push(text)` is read by the page as the next chunk of GET /api/events.
function eventStream() {
  const queue = [];
  let wake = null;
  const enc = new TextEncoder();
  return {
    opened: 0,
    push(text) { queue.push(enc.encode(text)); if (wake) { wake(); wake = null; } },
    response() {
      this.opened++;
      const read = async () => { while (!queue.length) await new Promise((r) => { wake = r; }); return { done: false, value: queue.shift() }; };
      return Promise.resolve({ ok: true, body: { getReader: () => ({ read }) } });
    },
  };
}

function loadPage(answers) {
  const els = {};
  const frames = [];
  const fetches = [];
  const tabEls = ['summary', 'work', 'conformity'].map((t) => element({ dataset: { tab: t } }));
  const get = (sel) => (els[sel] ||= (sel === 'meta[name=token]' ? element({ content: 'token' }) : element()));
  const doc = { hidden: false, querySelector: get, querySelectorAll: (s) => (String(s).includes('data-tab') ? tabEls : []), addEventListener() {}, createElement: () => element(), body: element(), activeElement: null };
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
  vm.runInContext(fs.readFileSync(path.join(PUBLIC, 'app.js'), 'utf8'), ctx);
  const flush = () => { while (frames.length) frames.shift()(); };
  const tick = async (n = 8) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); flush(); };
  return { get, fetches, tick, run: (code) => vm.runInContext(code, ctx), flush };
}

const reply = (body) => Promise.resolve({ ok: true, json: async () => body });
const fail = (status, body) => Promise.resolve({ ok: false, status, statusText: 'Failed', json: async () => body });
const gate = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };
const item = (role, text) => ({ role, text, at: null, tools: [] });
const hist = (...items) => ({ key: ID, sessionId: 's1', found: true, items, truncated: false, updatedAt: null });
const ADOPTED = { key: ID, adopted: { id: 's1', name: 'panel-demo', adoptedAt: 'x' }, adoptedFound: true, sessions: [], live: { state: 'none', count: 0 } };
const NONE = { key: ID, adopted: null, adoptedFound: false, sessions: [], live: { state: 'none', count: 0 } };
const status = (state, pendingDialogs = []) => ({ state, pendingDialogs, sessionId: 's1' });

// The longer routes come before their prefixes (the fake fetch takes the first key the url starts with).
async function chatPage(extra = {}) {
  const stream = eventStream();
  const answers = {
    '/api/events': () => stream.response(),
    '/api/rpc/status': status('closed'), '/api/rpc/start': status('idle'), '/api/rpc/prompt': { disposition: 'started' }, '/api/rpc/abort': {}, '/api/rpc/dialog': { ok: true },
    '/api/sessions': ADOPTED, '/api/chat': hist(item('user', 'earlier')),
    ...extra,
  };
  const page = loadPage(answers);
  const S = page.run('S');
  S.groups = [{ name: 'G', repos: [{ id: ID, name: 'demo', path: 'p' }] }];
  S.summary = { rows: [], generatedAt: 'x' };
  page.run("ACTIONS['chat-open']({ dataset: { id: '" + ID + "' } })");
  await page.tick();
  return { page, S, stream };
}
const frame = (payload) => `event: rpc\ndata: ${JSON.stringify({ id: ID, ...payload })}\n\n`;
const feed = async (page, stream, ...payloads) => { for (const p of payloads) stream.push(frame(p)); await page.tick(); };
const rec = (record) => ({ kind: 'event', record });
const delta = (i, text) => rec({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: i, delta: text } });
const urls = (page, prefix, method) => page.fetches.filter((f) => f.url.startsWith(prefix) && (!method || f.method === method));
const type = (page, text) => { page.get('#msgBox').value = text; };
const send = (page) => page.run("ACTIONS['chat-send']({})");
const body = (page) => page.get('#chatBody').html;
const note = (page) => page.get('#msgNote').html;

test('p1: opening a chat reads /api/rpc/status and the label, Send and Stop follow it', async () => {
  const { page } = await chatPage({ '/api/rpc/status': status('busy') });
  assert.equal(urls(page, '/api/rpc/status').length, 1);
  assert.match(urls(page, '/api/rpc/status')[0].url, new RegExp(`id=${ID}`));
  assert.match(page.get('#sessState').html, /Working…/);
  assert.equal(page.get('#msgSend').disabled, true);
  assert.equal(page.get('#msgStop').hidden, false);
});

test('p2: an idle session says Idle and lets Send through; a closed one says it is not started and Send is still on (it starts it)', async () => {
  const idle = await chatPage({ '/api/rpc/status': status('idle') });
  assert.match(idle.page.get('#sessState').html, /Idle/);
  assert.equal(idle.page.get('#msgSend').disabled, false);
  assert.equal(idle.page.get('#msgStop').hidden, true);
  const closed = await chatPage();
  assert.match(closed.page.get('#sessState').html, /Not started/);
  assert.equal(closed.page.get('#msgSend').disabled, false);
});

test('p3: every (re)connect of the event stream reads the status again', async () => {
  const { page, stream } = await chatPage();
  const before = urls(page, '/api/rpc/status').length;
  page.run('startEvents()');
  await page.tick();
  assert.equal(stream.opened, 1);
  assert.equal(urls(page, '/api/rpc/status').length, before + 1);
  page.run('stopEvents(); startEvents()');
  await page.tick();
  assert.equal(stream.opened, 2);
  assert.equal(urls(page, '/api/rpc/status').length, before + 2);
});

test('p4: rpc frames build a streaming bubble under the history; text_end replaces the text; the other events and ids change nothing', async () => {
  const { page, stream } = await chatPage({ '/api/rpc/status': status('idle') });
  page.run('startEvents()');
  await page.tick();
  stream.push('event: live\ndata: {"nothing":1}\n\nevent: rpc\ndata: not json\n\n');
  await feed(page, stream, { kind: 'state', state: 'busy' }, rec({ type: 'agent_start' }), delta(0, 'Hel'), delta(0, 'lo **there**'));
  assert.match(body(page), /earlier/);
  assert.match(body(page), /Hello <strong>there<\/strong>/);
  assert.match(page.get('#sessState').html, /Working…/);
  await feed(page, stream, rec({ type: 'message_update', assistantMessageEvent: { type: 'text_end', contentIndex: 0, content: 'Final text' } }));
  assert.match(body(page), /Final text/);
  assert.doesNotMatch(body(page), /Hello/);
  stream.push(`event: rpc\ndata: ${JSON.stringify({ id: 'ffffffffff', kind: 'event', record: { type: 'agent_start' } })}\n\n`);
  await page.tick();
  assert.match(body(page), /Final text/);
});

test('p5: the streaming bubble is escaped: HTML in the text is shown as text', async () => {
  const { page, stream } = await chatPage({ '/api/rpc/status': status('idle') });
  page.run('startEvents()');
  await page.tick();
  await feed(page, stream, { kind: 'state', state: 'busy' }, rec({ type: 'agent_start' }), delta(0, '<img src=x onerror=alert(1)> <script>x</script>'));
  assert.doesNotMatch(body(page), /<img|<script/);
  assert.match(body(page), /&lt;img src=x onerror=alert\(1\)&gt;/);
});

test('p6: agent_settled reloads the history ONCE and the persisted messages replace the streaming bubble', async () => {
  let hs = hist(item('user', 'earlier'));
  const { page, stream } = await chatPage({ '/api/rpc/status': status('idle'), '/api/chat': () => reply(hs) });
  page.run('startEvents()');
  await page.tick();
  await feed(page, stream, { kind: 'state', state: 'busy' }, rec({ type: 'agent_start' }), delta(0, 'Streaming answer'));
  const before = urls(page, '/api/chat').length;
  hs = hist(item('user', 'earlier'), item('assistant', 'Persisted answer'));
  await feed(page, stream, rec({ type: 'agent_settled', aborted: false }));
  assert.equal(urls(page, '/api/chat').length, before + 1);
  assert.match(body(page), /Persisted answer/);
  assert.doesNotMatch(body(page), /Streaming answer/);
  await feed(page, stream, { kind: 'state', state: 'idle' });
  assert.equal(urls(page, '/api/chat').length, before + 1, 'the idle state reloads nothing more');
  assert.match(page.get('#sessState').html, /Idle/);
  assert.equal(page.get('#msgSend').disabled, false);
});

test('p7: Send on a session that is not started starts it FIRST, then posts the prompt; both with the repo id', async () => {
  const start = gate();
  const { page } = await chatPage({ '/api/rpc/start': () => start.promise });
  type(page, 'hello there');
  send(page);
  await page.tick();
  assert.equal(urls(page, '/api/rpc/start', 'POST').length, 1);
  assert.deepEqual(JSON.parse(urls(page, '/api/rpc/start')[0].body), { id: ID });
  assert.equal(urls(page, '/api/rpc/prompt').length, 0, 'no prompt before the start answers');
  assert.match(page.get('#sessState').html, /Starting…/);
  assert.equal(page.get('#msgSend').disabled, true);
  assert.equal(page.get('#msgBox').value, '');
  start.resolve({ ok: true, json: async () => status('idle') });
  await page.tick();
  assert.equal(urls(page, '/api/rpc/prompt', 'POST').length, 1);
  assert.deepEqual(JSON.parse(urls(page, '/api/rpc/prompt')[0].body), { id: ID, text: 'hello there' });
  assert.match(body(page), /hello there/, 'the optimistic user bubble stays until the history has it');
});

test('p8: Send on an idle session posts only the prompt', async () => {
  const { page } = await chatPage({ '/api/rpc/status': status('idle') });
  type(page, 'go');
  send(page);
  await page.tick();
  assert.equal(urls(page, '/api/rpc/start').length, 0);
  assert.deepEqual(JSON.parse(urls(page, '/api/rpc/prompt', 'POST')[0].body), { id: ID, text: 'go' });
});

test('p9: Send does nothing while the session is busy or asking, and an empty box sends nothing', async () => {
  const busy = await chatPage({ '/api/rpc/status': status('busy') });
  type(busy.page, 'nope');
  send(busy.page);
  await busy.page.tick();
  assert.equal(urls(busy.page, '/api/rpc/prompt').length + urls(busy.page, '/api/rpc/start').length, 0);
  assert.equal(busy.page.get('#msgBox').value, 'nope');
  const idle = await chatPage({ '/api/rpc/status': status('idle') });
  type(idle.page, '   ');
  send(idle.page);
  await idle.page.tick();
  assert.equal(urls(idle.page, '/api/rpc/prompt').length, 0);
});

test('p10: a second click while the first send is in flight posts nothing more', async () => {
  const prompt = gate();
  const { page } = await chatPage({ '/api/rpc/status': status('idle'), '/api/rpc/prompt': () => prompt.promise });
  type(page, 'once');
  send(page);
  type(page, 'twice');
  send(page);
  await page.tick();
  assert.equal(urls(page, '/api/rpc/prompt', 'POST').length, 1);
  prompt.resolve({ ok: true, json: async () => ({ disposition: 'started' }) });
  await page.tick();
});

test('p11: a failed prompt puts the text back in the box and shows the server message', async () => {
  const { page } = await chatPage({ '/api/rpc/status': status('idle'), '/api/rpc/prompt': () => fail(400, { error: 'Messages that start with ! run a shell command; type those in the terminal' }) });
  type(page, '!ls');
  send(page);
  await page.tick();
  assert.equal(page.get('#msgBox').value, '!ls');
  assert.match(note(page), /Messages that start with ! run a shell command/);
  assert.doesNotMatch(body(page), /!ls/, 'the optimistic bubble is gone');
});

test('p12: a failed start puts the text back, shows the message, never posts the prompt and leaves the session not started', async () => {
  const { page } = await chatPage({ '/api/rpc/start': () => fail(502, { error: 'The session could not be started' }) });
  type(page, 'hello');
  send(page);
  await page.tick();
  assert.equal(urls(page, '/api/rpc/prompt').length, 0);
  assert.equal(page.get('#msgBox').value, 'hello');
  assert.match(note(page), /The session could not be started/);
  assert.match(page.get('#sessState').html, /Not started/);
  assert.equal(page.get('#msgSend').disabled, false);
});

test('p13: Stop posts the abort of the repo while busy', async () => {
  const { page } = await chatPage({ '/api/rpc/status': status('busy') });
  page.run("ACTIONS['chat-stop']({})");
  await page.tick();
  assert.deepEqual(JSON.parse(urls(page, '/api/rpc/abort', 'POST')[0].body), { id: ID });
});

test('p14: an exit frame closes the session: the label says so and the streaming text is dropped', async () => {
  const { page, stream } = await chatPage({ '/api/rpc/status': status('idle') });
  page.run('startEvents()');
  await page.tick();
  await feed(page, stream, { kind: 'state', state: 'busy' }, rec({ type: 'agent_start' }), delta(0, 'half an answer'));
  await feed(page, stream, { kind: 'exit' });
  assert.match(page.get('#sessState').html, /Not started/);
  assert.doesNotMatch(body(page), /half an answer/);
  assert.equal(page.get('#msgStop').hidden, true);
});

test('p15: with a pending dialog the composer is off and the card shows; Deny posts the dialog answer and the dialog-closed frame removes it', async () => {
  const { page, stream } = await chatPage({ '/api/rpc/status': status('asking', [{ requestId: 'd1', method: 'confirm', title: 'Allow?', message: 'git push', options: [], expiresAt: null, truncated: false }]) });
  assert.equal(page.get('#msgSend').disabled, true);
  assert.match(body(page), /data-act="rpc-answer"/);
  page.run("ACTIONS['rpc-answer']({ dataset: { id: '" + ID + "', request: 'd1', kind: 'deny' } })");
  await page.tick();
  assert.deepEqual(JSON.parse(urls(page, '/api/rpc/dialog', 'POST')[0].body), { id: ID, requestId: 'd1', confirmed: false });
  page.run('startEvents()');
  await page.tick();
  await feed(page, stream, { kind: 'dialog-closed', requestId: 'd1' }, { kind: 'state', state: 'busy' });
  assert.doesNotMatch(body(page), /ch-ask/);
});

test('p16: the old send is gone from the page: no chat/send, chat/clear, sessions/start, msgBusy or Clear button', () => {
  const app = fs.readFileSync(path.join(PUBLIC, 'app.js'), 'utf8');
  const res = fs.readFileSync(path.join(PUBLIC, 'resumen.js'), 'utf8');
  for (const gone of ['/api/chat/send', '/api/chat/clear', '/api/sessions/start', 'msgBusy', "'chat-clear'"]) assert.equal(app.includes(gone), false, gone);
  assert.equal(res.includes('chat-clear'), false);
  assert.equal(R.composerNote({ text: 'x', id: 'a', clear: true }).includes('button'), false);
});

test('p17: the history still reads the adopted session: GET /api/chat renders its messages and the adopt list of a repo with none stays', async () => {
  const kept = await chatPage({ '/api/rpc/status': status('idle'), '/api/chat': hist(item('user', 'q one'), item('assistant', 'a one')) });
  assert.match(body(kept.page), /q one/);
  assert.match(body(kept.page), /a one/);
  const none = await chatPage({ '/api/sessions': { ...NONE, sessions: [{ id: 's9', name: 'old', updatedAt: '2026-05-01T11:00:00Z' }] } });
  assert.match(body(none.page), /data-act="chat-adopt"/);
});

test('p18: until the status answers the label says Unknown and Send is off; a status read that fails reads as not started', async () => {
  const held = gate();
  const waiting = await chatPage({ '/api/rpc/status': () => held.promise });
  assert.match(waiting.page.get('#sessState').html, /Unknown/);
  assert.equal(waiting.page.get('#msgSend').disabled, true);
  held.resolve({ ok: true, json: async () => status('idle') });
  await waiting.page.tick();
  assert.match(waiting.page.get('#sessState').html, /Idle/);
  const failed = await chatPage({ '/api/rpc/status': () => fail(500, { error: 'boom' }) });
  assert.match(failed.page.get('#sessState').html, /Not started/);
  assert.equal(failed.page.get('#msgSend').disabled, false);
});
