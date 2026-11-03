'use strict';
// RPC2-3 (S1, S6, S8), the dialog card in the page: the real public/app.js in a vm (fake fetch, a fake event stream, no pi). HIGH RISK: the card answers a
// PERMISSION. The answer is built from the page state (never from the button), posted ONCE, locked at the click, unlocked only by a refusal; the Allow
// never goes out for text that may be cut; a reload rebuilds the card; the card read from the screen is gone.
const test = require('node:test');
const { appSource } = require('./pagesrc.js');
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
  vm.runInContext(appSource(), ctx);
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

const dialog = (over = {}) => ({ requestId: 'd1', method: 'confirm', title: 'Allow guarded git push?', message: 'git push origin HEAD', options: [], expiresAt: null, truncated: false, ...over });
const asking = (...ds) => status('asking', ds);
const posts = (page) => urls(page, '/api/rpc/dialog', 'POST').map((f) => JSON.parse(f.body));
const click = (page, kind, extra = {}, request = 'd1') => page.run(`ACTIONS['rpc-answer'](${JSON.stringify({ dataset: { id: ID, request, kind, ...extra } })})`);

test('q1: a dialog shows as a card under the history (a reload rebuilds it from the status) and the composer is off', async () => {
  const { page } = await chatPage({ '/api/rpc/status': asking(dialog()) });
  assert.match(body(page), /<pre class="ch-ask-text">git push origin HEAD<\/pre>/);
  assert.match(body(page), /data-kind="deny"[^>]*>Deny<\/button><button[^>]*data-kind="allow"/);
  assert.equal(page.get('#msgSend').disabled, true);
  assert.doesNotMatch(body(page), /pi is asking something/);
});

test('q2: Deny posts {id, requestId, confirmed:false} ONCE; the card locks at the click; a second click while it travels posts nothing', async () => {
  const g = gate();
  const { page, S } = await chatPage({ '/api/rpc/status': asking(dialog()), '/api/rpc/dialog': () => g.promise });
  click(page, 'deny');
  click(page, 'deny');
  click(page, 'allow');
  assert.equal(S.askBusy.d1, true);
  page.flush();
  assert.ok([...body(page).matchAll(/<button[^>]*>/g)].every((m) => /disabled/.test(m[0])), 'every button is disabled at the click');
  g.resolve({ ok: true, json: async () => ({ ok: true }) });
  await page.tick();
  assert.deepEqual(posts(page), [{ id: ID, requestId: 'd1', confirmed: false }]);
});

test('q3: Allow posts confirmed:true only when the dialog may be approved; a truncated or empty one posts nothing even if the action is called', async () => {
  const ok = await chatPage({ '/api/rpc/status': asking(dialog()) });
  click(ok.page, 'allow');
  await ok.page.tick();
  assert.deepEqual(posts(ok.page), [{ id: ID, requestId: 'd1', confirmed: true }]);
  for (const over of [{ truncated: true }, { message: '' }, { message: 'git push…' }]) {
    const bad = await chatPage({ '/api/rpc/status': asking(dialog(over)) });
    assert.doesNotMatch(body(bad.page), /data-kind="allow"/);
    click(bad.page, 'allow');
    await bad.page.tick();
    assert.deepEqual(posts(bad.page), [], JSON.stringify(over));
    assert.equal(bad.S.askBusy.d1, undefined);
  }
});

test('q4: a select posts the option at that index (read from the page state, not from the button) or a cancel; an unknown index posts nothing', async () => {
  const sel = dialog({ method: 'select', title: 'Pick', message: '', options: ['one', 'two <b>'] });
  const a = await chatPage({ '/api/rpc/status': asking(sel) });
  click(a.page, 'option', { index: '1', value: 'forged' });
  await a.page.tick();
  assert.deepEqual(posts(a.page), [{ id: ID, requestId: 'd1', value: 'two <b>' }]);
  const b = await chatPage({ '/api/rpc/status': asking(sel) });
  click(b.page, 'option', { index: '7' });
  click(b.page, 'option', { index: '-1' });
  click(b.page, 'option', {});
  click(b.page, 'cancel');
  await b.page.tick();
  assert.deepEqual(posts(b.page), [{ id: ID, requestId: 'd1', cancelled: true }]);
});

test('q4b: an option of a select that may not be answered posts nothing even if the action is called (truncated, or Allow behind an invisible)', async () => {
  for (const over of [{ title: 'Allow it?', truncated: true }, { title: '​Allow it?', message: '' }, { title: 'Pick', truncated: true }, { title: 'Pick', options: ['Y​es', 'No'] }]) {
    const p = await chatPage({ '/api/rpc/status': asking(dialog({ method: 'select', message: '', options: ['Yes', 'No'], ...over })) });
    click(p.page, 'option', { index: '0' });
    await p.page.tick();
    assert.deepEqual(posts(p.page), [], JSON.stringify(over));
    click(p.page, 'cancel');
    await p.page.tick();
    assert.deepEqual(posts(p.page), [{ id: ID, requestId: 'd1', cancelled: true }], 'Cancel still works');
  }
});

test('q5: an input sends the text of the field of its own card; no field, or a kind that does not fit the method, posts nothing', async () => {
  const input = dialog({ method: 'input', title: 'Enter a value', message: '', options: [] });
  const a = await chatPage({ '/api/rpc/status': asking(input) });
  a.page.run(`ACTIONS['rpc-answer']({ dataset: { id: '${ID}', request: 'd1', kind: 'send' }, closest: () => ({ querySelector: () => ({ value: 'typed\ttext' }) }) })`);
  await a.page.tick();
  assert.deepEqual(posts(a.page), [{ id: ID, requestId: 'd1', value: 'typed\ttext' }]);
  const b = await chatPage({ '/api/rpc/status': asking(input) });
  click(b.page, 'send');
  click(b.page, 'deny');
  click(b.page, 'allow');
  click(b.page, 'option', { index: '0' });
  const conf = await chatPage({ '/api/rpc/status': asking(dialog()) });
  click(conf.page, 'send');
  click(conf.page, 'option', { index: '0' });
  click(conf.page, 'bogus');
  await Promise.all([b.page.tick(), conf.page.tick()]);
  assert.deepEqual([posts(b.page), posts(conf.page)], [[], []]);
});

test('q6: a refusal (400) unlocks the card and toasts; a 409 resyncs the status and the card goes away', async () => {
  const refused = await chatPage({ '/api/rpc/status': asking(dialog()), '/api/rpc/dialog': () => fail(400, { error: 'Invalid answer' }) });
  click(refused.page, 'deny');
  await refused.page.tick();
  assert.equal(refused.S.askBusy.d1, undefined);
  assert.ok(![...body(refused.page).matchAll(/<button[^>]*>/g)].some((m) => /disabled/.test(m[0])), 'unlocked');
  assert.match(body(refused.page), /data-kind="deny"/);
  let calls = 0;
  const gone = await chatPage({ '/api/rpc/status': () => reply(++calls === 1 ? asking(dialog()) : status('idle')), '/api/rpc/dialog': () => fail(409, { error: 'That question is not waiting for an answer' }) });
  assert.match(body(gone.page), /ch-ask/);
  click(gone.page, 'deny');
  await gone.page.tick();
  assert.doesNotMatch(body(gone.page), /ch-ask/);
  assert.equal(posts(gone.page).length, 1);
});

test('q7: dialog and dialog-closed frames add and remove the card; exit clears it; two dialogs show two cards', async () => {
  const { page, stream } = await chatPage({ '/api/rpc/status': status('idle') });
  page.run('startEvents()');
  await page.tick();
  await feed(page, stream, { kind: 'dialog', ...dialog(), method: 'confirm' }, { kind: 'state', state: 'asking' });
  assert.equal((body(page).match(/class="ch-ask"/g) || []).length, 1);
  await feed(page, stream, { kind: 'dialog', ...dialog({ requestId: 'd2', method: 'input', title: 'Enter a value', message: '' }) });
  assert.equal((body(page).match(/class="ch-ask"/g) || []).length, 2);
  await feed(page, stream, { kind: 'dialog-closed', requestId: 'd1' });
  assert.equal((body(page).match(/class="ch-ask"/g) || []).length, 1);
  await feed(page, stream, { kind: 'exit' });
  assert.doesNotMatch(body(page), /ch-ask/);
});

test('q8: the question read from the screen is gone: a live state «waiting» with a dialog paints no card and no screen answer buttons', async () => {
  const waiting = { ...ADOPTED, live: { state: 'waiting', count: 1, dialog: { lines: ['Proceed?', '→ Yes', '  No'], selected: 1, choices: { fingerprint: '0123456789abcdef', complete: true, options: [{ label: 'Yes', tone: 'affirmative' }] } } } };
  const { page } = await chatPage({ '/api/sessions': waiting, '/api/rpc/status': status('idle') });
  assert.doesNotMatch(body(page), /ch-ask|dialog-answer|Proceed\?/);
  assert.equal(page.run("typeof ACTIONS['dialog-answer']"), 'undefined');
  assert.equal(page.run("typeof ACTIONS['rpc-cancel']"), 'undefined');
  assert.equal(page.run("'answer' in S"), false);
});
