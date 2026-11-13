'use strict';
// RP166: quick replies. When the last line of the LAST assistant message offers 2 to 6 options as `text`, the chat draws one button per option under it;
// a click sends exactly that option through the message box path. Abuse first: the detector is strict (one closed shape on the last line), total, and the
// buttons only exist when the session is idle, nothing is pending and no real dialog is open. Fakes only: no server, no GitHub, no real session.
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

// ====================================================================================================
// A. the detector (pure and total): abuse first
// ====================================================================================================
const Q = (text) => R.quickReplies(text);
const line = (s) => `Some intro.\n\n${s}`;

test('A1: hostile options never make a partial list: markup, 41 characters, spaces, control characters, RTL marks, duplicates, __proto__', () => {
  const bad = [
    'Answer with `<img src=x onerror=1>` or `cancel`.',
    `Answer with \`${'a'.repeat(41)}\` or \`cancel\`.`,
    'Answer with `two words` or `cancel`.',
    'Answer with `a\u0001b` or `cancel`.',
    'Answer with `a\u202Eb` or `cancel`.',
    'Answer with `ok` or `cancel`\u200F.',
    'Answer with `ok`\u200B or `cancel`.',
    'Answer with `ok`\uFEFF or `cancel`.',
    'Answer with `ok` or `ok`.',
    'Answer with `__proto__` or `cancel`.',
    'Answer with `` or `cancel`.',
    'Answer with `a/b c` or `cancel`.',
    'Answer with `ok` or `cancel` or `<b>`.',
  ];
  for (const s of bad) assert.deepEqual(Q(line(s)), [], JSON.stringify(s));
  assert.deepEqual(Q(line(`Answer with \`${'a'.repeat(40)}\` or \`cancel\`.`)), ['a'.repeat(40), 'cancel'], '40 characters is the limit and is fine');
});

test('A2: extra words, a second line, options in the middle, a line that is not the last one: all rejected', () => {
  const bad = [
    'Answer with `ok` or `cancel` please.',
    'Please answer with `ok` or `cancel`.',
    'Answer with `ok` or `cancel`. Thanks!',
    'Answer with `ok` or `cancel` and `x` is the default.',
    'I would say `ok` or `cancel` here.',
    'Answer with `ok` or `cancel`, then wait.',
    'Answer with `ok` `cancel`.',
    'Answer with `ok`; `cancel`.',
    'Answer with `ok or `cancel`.',
    'Answer with `ok` or `cancel.',
    'Answer with ``ok` or `cancel`.',
    'Respond `ok` or `cancel`.',
    'Siguiente: elegí algo: `ok` o `cancel`.',
    'Hola Siguiente: respondé `ok` o `cancel`.',
    'Then: Answer with `ok` or `cancel`.',
  ];
  for (const s of bad) assert.deepEqual(Q(line(s)), [], JSON.stringify(s));
  assert.deepEqual(Q('Answer with `ok` or `cancel`.\n\nBye.'), [], 'the options are not on the last non-empty line');
  assert.deepEqual(Q('Answer with `ok` or `cancel`.\nDone'), []);
});

test('A3: code fences, indented code, blockquotes, list items, an unclosed fence: all rejected', () => {
  const l = 'Answer with `ok` or `cancel`.';
  assert.deepEqual(Q(`Example:\n\`\`\`\n${l}\n\`\`\``), [], 'inside a closed fence, the fence is the last line');
  assert.deepEqual(Q(`Example:\n\`\`\`\n${l}`), [], 'inside an unclosed fence');
  assert.deepEqual(Q(`\`\`\`\ncode\n\`\`\`\n${l}\n\`\`\`js`), [], 'an unclosed fence after the line');
  assert.deepEqual(Q(`Text\n~~~\n${l}`), [], 'tilde fence');
  assert.deepEqual(Q(`Text\n    ${l}`), [], 'indented code block');
  assert.deepEqual(Q(`Text\n\t${l}`), [], 'tab indented code block');
  assert.deepEqual(Q(`Text\n> ${l}`), [], 'blockquote');
  assert.deepEqual(Q(`Text\n>${l}`), [], 'blockquote without space');
  assert.deepEqual(Q(`Text\n- ${l}`), [], 'list item');
  assert.deepEqual(Q(`Text\n* ${l}`), [], 'list item with a star');
  assert.deepEqual(Q(`Text\n1. ${l}`), [], 'numbered list item');
  assert.deepEqual(Q(`Text\n2) ${l}`), [], 'numbered list item with a parenthesis');
  assert.deepEqual(Q(`\`\`\`\ncode\n\`\`\`\n\n${l}`), ['ok', 'cancel'], 'a CLOSED fence earlier does not matter');
});

test('A4: total: non-strings, __proto__, control characters, empty, a 1 MB string (fast) and a huge one with a valid last line', () => {
  for (const v of [undefined, null, 0, 7, NaN, true, {}, [], ['Answer with `a` or `b`.'], () => 1, Symbol('x'), 10n, { toString: () => 'Answer with `a` or `b`.' }, '__proto__', 'constructor', '', '   ', '\n\n', '\u0000', '`', '``']) {
    assert.doesNotThrow(() => Q(v), String(typeof v));
    assert.deepEqual(Q(v), [], String(typeof v));
  }
  const big = 'x'.repeat(1024 * 1024);
  const t0 = Date.now();
  assert.deepEqual(Q(big), []);
  assert.deepEqual(Q(`${big}\n${'`a`, '.repeat(100000)}\`b\`.`), []);
  assert.deepEqual(Q(`${big}\nAnswer with \`a\` or \`b\`.`), [], 'a 1 MB message is never looked at');
  assert.deepEqual(Q('x\n'.repeat(500000)), []);
  assert.ok(Date.now() - t0 < 1500, 'fast');
  assert.deepEqual(Q(`${'x'.repeat(2500)}\nAnswer with \`a\` or \`b\`.`), ['a', 'b'], 'a long message with the line at the end is fine');
  assert.deepEqual(Q(`Answer with \`a\` or \`b\`.${' '.repeat(3000)}`), ['a', 'b'], 'trailing spaces do not hide the last line');
  assert.deepEqual(Q(`${'y'.repeat(3000)}Answer with \`a\` or \`b\`.`), [], 'a cut first line is not trusted');
});

test('A5: counts: 2 and 6 options are accepted, 1 and 7 are rejected', () => {
  const mk = (n) => `Choose ${Array.from({ length: n }, (_, i) => `\`o${i}\``).join(', ')}.`;
  assert.deepEqual(Q(mk(2)), ['o0', 'o1']);
  assert.deepEqual(Q(mk(6)), ['o0', 'o1', 'o2', 'o3', 'o4', 'o5']);
  assert.deepEqual(Q(mk(1)), []);
  assert.deepEqual(Q(mk(7)), []);
  assert.deepEqual(Q(mk(0)), []);
  assert.deepEqual(Q(mk(500)), []);
});

// ====================================================================================================
// B. the detector: what it accepts
// ====================================================================================================
test('B1: the line the person actually saw, with and without the Siguiente: prefix', () => {
  assert.deepEqual(Q('Texto.\n\nRespondé `start_task`, `adjust_task` o `cancel`.'), ['start_task', 'adjust_task', 'cancel']);
  assert.deepEqual(Q('Texto.\n\nSiguiente: respondé `start_task`, `adjust_task` o `cancel`.'), ['start_task', 'adjust_task', 'cancel']);
  assert.deepEqual(Q('Text.\n\nNext: Answer with `a` or `b`.'), ['a', 'b']);
  assert.deepEqual(Q('Respondé `start_task`, `adjust_task` o `cancel`.\n\n'), ['start_task', 'adjust_task', 'cancel'], 'trailing blank lines');
  assert.deepEqual(Q('Respondé `start_task`, `adjust_task` o `cancel`.\r\n'), ['start_task', 'adjust_task', 'cancel'], 'CRLF');
});

test('B2: the closed verbs in both languages (case-insensitive), the fillers and the separators', () => {
  for (const v of ['Respondé', 'Respondé con', 'Contestá', 'Contestá con', 'Elegí', 'Elegí una', 'Responde', 'Contesta', 'RESPONDÉ', 'respond with', 'Answer with', 'Reply with', 'Choose', 'Pick', 'answer WITH']) {
    assert.deepEqual(Q(`${v} \`a\` o \`b\`.`), ['a', 'b'], v);
  }
  for (const f of ['una de estas', 'una de estas tres', 'one of these', 'one of:']) assert.deepEqual(Q(`Choose ${f} \`a\`, \`b\`, \`c\``), ['a', 'b', 'c'], f);
  assert.deepEqual(Q('Elegí una de estas tres: `a`, `b` y `c`'), ['a', 'b', 'c']);
  for (const s of [' o ', ' or ', ' y ', ' and ', ', ', ' / ', '/', ',', ', o ', ', or ', ', y ', ', and ']) assert.deepEqual(Q(`Pick \`a\`${s}\`b\``), ['a', 'b'], JSON.stringify(s));
  for (const end of ['', '.', ':', '?', '!']) assert.deepEqual(Q(`Pick \`a\` or \`b\`${end}`), ['a', 'b'], end);
  assert.deepEqual(Q('**Respondé `a` o `b`.**'), ['a', 'b'], 'markdown emphasis around the line');
  assert.deepEqual(Q('  Pick `v1.2:x_y-z` or `0`  '), ['v1.2:x_y-z', '0']);
  assert.deepEqual(Q('Pick `A` or `a`'), ['A', 'a'], 'distinct means case-sensitive');
});

// ====================================================================================================
// C. the page: the buttons, the click and the conditions
// ====================================================================================================
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

test('C1: abuse: nothing is sent when the chat opens, redraws or the buttons are only drawn', async () => {
  const { page } = await chatPage();
  assert.equal(buttons(page), 3, 'precondition: the buttons are there');
  redraw(page); redraw(page);
  await page.tick();
  assert.equal(sendsOf(page).length, 0);
  assert.ok(!page.fetches.some((f) => f.method === 'POST' && f.url.startsWith('/api/rpc/prompt')));
});

test('C2: the buttons appear under the last assistant message when ALL conditions hold; the options are not in a data attribute', async () => {
  const { page, S } = await chatPage();
  const h = body(page);
  assert.match(h, /<div class="qr-row" role="group" aria-label="Quick replies">/);
  for (let i = 0; i < 3; i++) assert.match(h, new RegExp(`<button type="button" class="qr" data-act="quick-reply" data-i="${i}">`));
  assert.ok(h.includes('>start_task</button>') && h.includes('>adjust_task</button>') && h.includes('>cancel</button>'));
  assert.ok(!/data-(?:option|text|value)=/.test(h.slice(h.indexOf('qr-row'))), 'the option text is not a data attribute');
  assert.deepEqual(JSON.parse(JSON.stringify(S.quick.options)), ['start_task', 'adjust_task', 'cancel']);
  assert.equal(S.quick.id, 'abc');
  assert.ok(typeof S.quick.sig === 'string' && S.quick.sig.length > 0);
  assert.ok(h.lastIndexOf('class="qr-row"') > h.lastIndexOf('class="m"'), 'the row comes after the last assistant bubble');
});

test('C3: each condition alone, when broken, removes the buttons', async () => {
  const cases = {
    'a user message after': { '/api/chat': histOf(item('user', 'go'), ASSISTANT(), item('user', 'and then')) },
    'a message the history cut': { '/api/chat': histOf(item('user', 'go'), ASSISTANT(MSG, { cut: 40 })) },
    'a tool-only item after': { '/api/chat': histOf(item('user', 'go'), ASSISTANT(), item('assistant', '', { tools: ['bash'] })) },
    'a compaction note after': { '/api/chat': histOf(item('user', 'go'), ASSISTANT(), { role: 'system', kind: 'compaction', at: null }) },
    'the line is not the last': { '/api/chat': histOf(item('user', 'go'), ASSISTANT(`${LINE}\nBye.`)) },
    'an older assistant message holds the line': { '/api/chat': histOf(item('user', 'go'), ASSISTANT(), item('assistant', 'Nothing to choose.')) },
  };
  for (const [name, extra] of Object.entries(cases)) {
    const { page } = await chatPage(extra);
    assert.equal(buttons(page), 0, name);
    assert.equal(rows(page), 0, name);
  }
  for (const state of ['busy', 'asking', 'starting', 'closed', 'unknown', 'compacting']) {
    const { page } = await chatPage();
    assert.equal(buttons(page), 3, 'precondition');
    page.run(`setRpc('abc', { state: ${JSON.stringify(state === 'compacting' ? 'idle' : state)}${state === 'compacting' ? ', compacting: true' : ''} }); draw()`);
    page.flush();
    assert.equal(buttons(page), 0, state);
  }
  const { page } = await chatPage();
  page.run(`setRpc('abc', { asks: [${JSON.stringify(ASK)}] }); draw()`);
  page.flush();
  assert.equal(buttons(page), 0, 'a pending real dialog');
  assert.match(body(page), /class="ch-ask"/, 'and the real dialog is drawn: it wins');
  assert.match(body(page), /data-act="rpc-answer"/);
  page.run("setRpc('abc', { asks: [] }); S.pending.abc = [{ text: 'x', state: 'ok', base: 99 }]; draw()");
  page.flush();
  assert.equal(buttons(page), 0, 'a message of this page is pending');
  page.run('S.pending.abc = []; draw()');
  page.flush();
  assert.equal(buttons(page), 3, 'and they are back when everything holds again');
});

test('C4: a click sends exactly the option (no backticks) once, through the message box path, and the row is gone', async () => {
  const post = gate();
  const { page, S } = await chatPage({ '/api/rpc/prompt': () => post.promise });
  page.get('#msgBox').value = 'half-typed draft';
  click(page, '1');
  const sends = sendsOf(page);
  assert.equal(sends.length, 1);
  assert.deepEqual(JSON.parse(sends[0].body), { id: 'abc', text: 'adjust_task' });
  assert.equal(page.get('#msgBox').value, 'half-typed draft', 'the draft of the person is untouched');
  page.flush();
  assert.equal(rows(page), 0, 'the row is gone at once');
  assert.match(body(page), /class="m me pending"/, 'the optimistic bubble shows the option');
  assert.equal(S.pending.abc.length, 1);
  post.resolve({ ok: true, json: async () => ({ disposition: 'started' }) });
  await page.tick();
  assert.equal(sendsOf(page).length, 1);
});

test('C5: double click and a click while a send is in flight send ONCE', async () => {
  const post = gate();
  const { page } = await chatPage({ '/api/rpc/prompt': () => post.promise });
  click(page, '0'); click(page, '0'); click(page, '2');
  assert.equal(sendsOf(page).length, 1);
  await page.tick();
  click(page, '0');
  assert.equal(sendsOf(page).length, 1);
  post.resolve({ ok: true, json: async () => ({ disposition: 'started' }) });
  await page.tick();
  click(page, '0');
  assert.equal(sendsOf(page).length, 1);
});

test('C6: a click with an index out of range, negative, NaN, fractional, empty, a string or missing sends nothing', async () => {
  const { page } = await chatPage();
  for (const i of ['3', '99', '-1', 'NaN', '1.5', '', 'x', '__proto__', 'constructor', '0x1', '1e0', ' 1', '01 ', null, undefined, 1, {}, [1]]) click(page, i);
  page.run("ACTIONS['quick-reply']({})");
  page.run("ACTIONS['quick-reply']({ dataset: {} })");
  assert.equal(sendsOf(page).length, 0);
  click(page, '2');
  assert.equal(sendsOf(page).length, 1, 'a valid index still works');
});

test('C7: a stale click sends nothing: the chat changed, the message changed or the session is no longer idle', async () => {
  let { page } = await chatPage();
  page.run("S.chat.id = 'other'");
  click(page, '0');
  assert.equal(sendsOf(page).length, 0, 'another chat');
  ({ page } = await chatPage());
  page.run("S.chat.hist = { ...S.chat.hist, items: [S.chat.hist.items[0], { role: 'assistant', text: 'A different one.\\n\\nPick `x` or `y`.', at: null, tools: [] }] }");
  click(page, '0');
  assert.equal(sendsOf(page).length, 0, 'the message changed since the draw');
  ({ page } = await chatPage());
  page.run("S.chat.hist = { ...S.chat.hist, items: [...S.chat.hist.items, { role: 'user', text: 'typed it', at: null, tools: [] }] }");
  click(page, '0');
  assert.equal(sendsOf(page).length, 0, 'a user message came after');
  ({ page } = await chatPage());
  page.run("setRpc('abc', { state: 'busy' })");
  click(page, '0');
  assert.equal(sendsOf(page).length, 0, 'the session is working');
  ({ page } = await chatPage());
  page.run(`setRpc('abc', { asks: [${JSON.stringify(ASK)}] })`);
  click(page, '0');
  assert.equal(sendsOf(page).length, 0, 'a real dialog is pending');
});

test('C8: the option is read from the page state, never from the DOM: a forged element changes nothing', async () => {
  const { page } = await chatPage();
  page.run("ACTIONS['quick-reply']({ dataset: { i: '0', option: 'rm -rf', text: 'evil', value: 'evil' }, textContent: 'evil', innerHTML: 'evil' })");
  const sends = sendsOf(page);
  assert.equal(sends.length, 1);
  assert.equal(JSON.parse(sends[0].body).text, 'start_task');
});

test('C9: a failed send puts the option back in the box (the message box handling)', async () => {
  const { page } = await chatPage({ '/api/rpc/prompt': () => Promise.resolve({ ok: false, status: 500, statusText: 'No', json: async () => ({ error: 'nope' }) }) });
  click(page, '0');
  await page.tick();
  assert.equal(page.get('#msgBox').value, 'start_task');
  assert.equal(sendsOf(page).length, 1);
});

test('C10: the Reply button: only for a trailing question with no options, under the same conditions, and it only focuses', async () => {
  const q = { '/api/chat': histOf(item('user', 'go'), ASSISTANT('Done.\n\n¿Querés que lo suba?')) };
  const { page } = await chatPage(q);
  assert.equal(buttons(page), 0);
  assert.match(body(page), /<button type="button" class="qr qr-reply" data-act="quick-focus">Reply<\/button>/);
  assert.equal(count(body(page), 'qr-reply'), 1);
  assert.match(body(page), /role="group" aria-label="Quick replies"/);
  let focused = 0;
  page.get('#msgBox').focus = () => { focused++; };
  page.get('#msgBox').scrollIntoView = () => {};
  page.run("ACTIONS['quick-focus']({ dataset: {} })");
  assert.equal(focused, 1);
  assert.equal(sendsOf(page).length, 0, 'it sends nothing');
  const none = {
    'no question mark': histOf(item('user', 'go'), ASSISTANT('Done.\n\nAll good.')),
    'a question that is not the last line': histOf(item('user', 'go'), ASSISTANT('¿Querés?\n\nDone.')),
    'a cut message': histOf(item('user', 'go'), ASSISTANT('Done?', { cut: 5 })),
    'a user message after': histOf(item('user', 'go'), ASSISTANT('Done?'), item('user', 'yes')),
    'a question inside a fence': histOf(item('user', 'go'), ASSISTANT('```\nWhy?')),
    'a quoted question': histOf(item('user', 'go'), ASSISTANT('> Why?')),
  };
  for (const [name, hist] of Object.entries(none)) {
    const p = (await chatPage({ '/api/chat': hist })).page;
    assert.equal(count(body(p), 'qr-reply'), 0, name);
  }
  const opts = (await chatPage({ '/api/chat': histOf(item('user', 'go'), ASSISTANT('Pick `a` or `b`?')) })).page;
  assert.equal(buttons(opts), 2, 'options win over a question');
  assert.equal(count(body(opts), 'qr-reply'), 0);
  page.run("setRpc('abc', { state: 'busy' }); draw()");
  page.flush();
  assert.equal(count(body(page), 'qr-reply'), 0, 'busy');
  page.run(`setRpc('abc', { state: 'idle', asks: [${JSON.stringify(ASK)}] }); draw()`);
  page.flush();
  assert.equal(count(body(page), 'qr-reply'), 0, 'a real dialog');
});

test('C11: the message markup of a bubble with such a line is unchanged (mdHtml)', async () => {
  const { page } = await chatPage();
  assert.ok(body(page).includes(`<div class="m"><span class="who">panel:demo</span>${R.mdHtml(MSG)}</div>`));
});

test('C12: sendChatMessage still sends the text of the box exactly as before and clears it', async () => {
  const post = gate();
  const { page, S } = await chatPage({ '/api/rpc/prompt': () => post.promise });
  page.get('#msgBox').value = '  hello team \nsecond line ';
  S.drafts.abc = 'draft';
  page.run("ACTIONS['chat-send']({})");
  const sends = sendsOf(page);
  assert.equal(sends.length, 1);
  assert.deepEqual(JSON.parse(sends[0].body), { id: 'abc', text: '  hello team \nsecond line ' });
  assert.equal(page.get('#msgBox').value, '');
  assert.equal(S.drafts.abc, undefined);
  post.resolve({ ok: true, json: async () => ({ disposition: 'started' }) });
  await page.tick();
  page.get('#msgBox').value = '   ';
  page.run("ACTIONS['chat-send']({})");
  assert.equal(sendsOf(page).length, 1, 'a blank box sends nothing');
});

test('C13: the look: small outlined buttons that wrap, with a visible focus, and no wording the person must not read', () => {
  const css = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'public', 'style.css'), 'utf8');
  assert.match(css, /\.qr-row\s*\{[^}]*flex-wrap:\s*wrap/);
  assert.match(css, /\.qr\s*\{[^}]*border:/);
  assert.match(css, /\.qr:focus-visible\s*\{[^}]*outline:\s*2px/);
  assert.match(css, /\.qr\s*\{[^}]*overflow-wrap:\s*anywhere/);
  const h = R.chatBody({ id: 'abc', info: ADOPTED, hist: histOf(item('user', 'go'), ASSISTANT()), rpc: { state: 'idle', asks: [] } }, {});
  assert.ok(!/pi session|pi screen|Gentle Shell/i.test(h));
});
