'use strict';
// RP68 (S49, S54): the composer of the chat (free text to the adopted pi session) and (until RP85) the "/ Actions" menu, now direct buttons. Pure helpers
// (composerState, actionMenu, actionButtonsHtml, composerNote, chatHead), the page wiring in app.js (vm harness, fake fetch,
// no real timers, no network, no Orca) and the readChat file-name match. Temp dirs only.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'rp68-'));
const sessionsBase = path.join(scratch, 'sessions');
fs.mkdirSync(sessionsBase);
process.env.REPO_PANEL_CONFIG = path.join(scratch, 'config.json');
process.env.REPO_PANEL_SESSIONS_DIR = sessionsBase;
test.after(() => fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 5 }));

const SS = require('../server/sessions.js');
const R = require('../public/resumen.js');
const PUBLIC = path.join(__dirname, '..', 'public');

// ---------- helpers (copied from rp54-chat.test.js) ----------
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
const HIST = { key: 'abc', sessionId: 's1', found: true, items: [{ role: 'user', text: 'hello there', at: null, tools: [] }], truncated: false, updatedAt: null };
const okJson = (body) => Promise.resolve({ ok: true, json: async () => body });
const fail = (status, error) => Promise.resolve({ ok: false, status, statusText: 'Error', json: async () => ({ error }) });
// The live session answers /api/rpc/*: the fake fetch takes the first key the url starts with.
const rpcState = (state, pendingDialogs = []) => ({ state, pendingDialogs, sessionId: 's1' });
const answersFor = (extra = {}) => ({
  '/api/rpc/status': rpcState('idle'), '/api/rpc/start': rpcState('idle'), '/api/rpc/prompt': { disposition: 'started' }, '/api/rpc/abort': {}, '/api/pi': { sent: true, confirmed: true },
  '/api/sessions': ADOPTED, '/api/chat': HIST, ...extra,
});
async function ready(extra = {}) {
  const page = loadPage({ answers: answersFor(extra) });
  const S2 = seed(page);
  page.run("ACTIONS['chat-open']({ dataset: { id: 'abc' } })");
  await page.tick();
  return { page, S: S2 };
}
const act = (page, name, el) => {
  const fn = page.run(`ACTIONS['${name}']`);
  assert.equal(typeof fn, 'function', `ACTIONS['${name}'] exists`);
  return fn(el);
};
const posts = (page, url) => page.fetches.filter((f) => f.method === 'POST' && f.url === url);
const typeIn = (page, text) => { page.get('#msgBox').value = text; page.fire('input', { target: page.get('#msgBox') }); };
const sendClick = (page) => act(page, 'chat-send', page.get('#msgSend'));
const WORKING = 'The session is working: wait until it is idle, or press Stop';

// ---------- index.html ----------
test('index.html: the composer replaces the read-only footer inside aside#chat', () => {
  const html = fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8');
  assert.doesNotMatch(html, /Read-only for now/);
  const aside = /<aside id="chat"[\s\S]*?<\/aside>/.exec(html);
  assert.ok(aside, 'aside#chat exists');
  const tag = (id) => (new RegExp(`<(?:div|textarea|button)[^>]*\\bid="${id}"[^>]*>`).exec(aside[0]) || [''])[0];
  assert.match(tag('composer'), /^<div[^>]*role="group"/);
  assert.match(tag('msgBox'), /^<textarea/);
  const send = tag('msgSend');
  assert.match(send, /^<button/);
  assert.match(send, /data-act="chat-send"/);
  assert.match(send, /type="button"/);
  assert.ok(aside[0].includes('id="chatActions"') && aside[0].indexOf('class="c-bar"') < aside[0].indexOf('id="chatActions"'), 'RP85: the bar holds the container of the action buttons');
  assert.match(tag('msgNote'), /role="status"/);
});

// ---------- composerState ----------
const cs = (c) => R.composerState({ id: 'r1', sending: false, ...c }, { name: 'alpha' });

test('composerState: canSend for a loaded chat whose session is idle or not started (sending starts it), not while sending, starting, working or asking', () => {
  const rpc = (state) => ({ state });
  assert.equal(cs({ info: adoptedInfo(), rpc: rpc('idle') }).canSend, true);
  assert.match(cs({ info: adoptedInfo(), rpc: rpc('idle') }).placeholder, /alpha/);
  assert.equal(cs({ info: info(), rpc: rpc('closed') }).canSend, true, 'not adopted and not started: the send starts it');
  assert.equal(cs({ info: adoptedInfo() }).canSend, false, 'no rpc entry yet: the status read has not answered');
  assert.equal(cs({ info: adoptedInfo() }).reason, 'The session state is unknown');
  assert.equal(cs({ info: adoptedInfo(), rpc: rpc('idle'), sending: true }).canSend, false);
  for (const st of ['starting', 'busy', 'asking']) assert.equal(cs({ info: adoptedInfo(), rpc: rpc(st) }).canSend, false, st);
  assert.equal(cs({ info: null }).canSend, false);
});
test('composerState: one distinct, non-empty reason per blocked case and a non-empty placeholder always', () => {
  const cases = {
    notLoaded: cs({ info: null }), sending: cs({ info: adoptedInfo(), rpc: { state: 'idle' }, sending: true }),
    starting: cs({ info: adoptedInfo(), rpc: { state: 'starting' } }), working: cs({ info: adoptedInfo(), rpc: { state: 'busy' } }), asking: cs({ info: adoptedInfo(), rpc: { state: 'asking' } }),
  };
  for (const [k, v] of Object.entries(cases)) {
    assert.ok(v.reason && typeof v.reason === 'string', `${k} has a reason`);
    assert.ok(v.placeholder && typeof v.placeholder === 'string', `${k} has a placeholder`);
  }
  assert.equal(new Set(Object.values(cases).map((v) => v.reason)).size, 5);
  assert.equal(cases.working.reason, WORKING);
  assert.equal(cases.asking.reason, 'pi is asking something: answer it in the card of the chat');
  assert.equal(cases.sending.reason, 'Sending…');
  assert.ok(cs({ info: adoptedInfo(), rpc: { state: 'idle' } }).placeholder.length > 0);
});
// ---------- actionMenu ----------
const NEXT = { id: 'RP9', entrega: 'The thing', resultadoVisible: 'x' };
const menuOf = (row, ctx = {}) => R.actionMenu(row, { live: 'free', changes: { files: 0, ahead: 0, behind: 0 }, flow: null, ...ctx });
const avail = (m) => m.items.map((i) => i.available);
const whys = (m) => m.items.map((i) => i.why);

test('actionMenu: always four items in the fixed order; start offers flow-next with the unit as the reason', () => {
  const m = menuOf(card({ action: { kind: 'start' }, next: NEXT }));
  assert.deepEqual(m.items.map((i) => i.cmd), ['flow-next', 'flow-commit', 'flow-pr', 'flow-base']);
  assert.deepEqual(avail(m), [true, false, false, false]);
  assert.ok(m.items.every((i) => i.label && typeof i.label === 'string'));
  assert.equal(m.items[0].why, 'RP9 — The thing');
  assert.deepEqual(whys(m).slice(1), ['No changes to commit', 'Nothing committed yet', 'The branch has not been merged yet']);
});

test('actionMenu: branch offers flow-base; the flow-next reason is "Finish what is in progress first" when a unit waits', () => {
  const m = menuOf(card({ action: { kind: 'branch' }, next: NEXT }));
  assert.deepEqual(avail(m), [false, false, false, true]);
  assert.equal(m.items[0].why, 'Finish what is in progress first');
});

test('actionMenu: deliver takes the slot of the flow command (commit, pr, unstage, stash) and a disabled flow keeps its reason', () => {
  const commit = menuOf(card({ action: { kind: 'deliver' }, next: NEXT }), { changes: { files: 2, ahead: 0, behind: 0 }, flow: { cmd: 'flow-commit', label: '/flow-commit' } });
  assert.deepEqual(avail(commit), [false, true, false, false]);
  assert.deepEqual([commit.items[0].why, commit.items[2].why, commit.items[3].why], ['Deliver the current changes first', 'Commit the changes first', 'The branch has not been merged yet']);
  const pr = menuOf(card({ action: { kind: 'deliver' }, next: NEXT }), { changes: { files: 0, ahead: 1, behind: 0 }, flow: { cmd: 'flow-pr', label: '/flow-pr' } });
  assert.deepEqual(avail(pr), [false, false, true, false]);
  assert.deepEqual([pr.items[0].why, pr.items[1].why], ['Deliver the current changes first', 'No changes to commit']);
  const unstage = menuOf(card({ action: { kind: 'deliver' } }), { changes: { files: 1, ahead: 0, behind: 0 }, flow: { cmd: 'flow-commit-unstage', label: '/flow-commit (unstage first)' } });
  assert.equal(unstage.items.length, 4);
  assert.deepEqual([unstage.items[1].cmd, unstage.items[1].label, unstage.items[1].available], ['flow-commit-unstage', '/flow-commit (unstage first)', true]);
  const stash = menuOf(card({ action: { kind: 'branch' } }), { flow: { cmd: 'flow-base-stash', label: '/flow-base --stash' } });
  assert.equal(stash.items.length, 4);
  assert.deepEqual([stash.items[3].cmd, stash.items[3].label], ['flow-base-stash', '/flow-base --stash']);
  const off = menuOf(card({ action: { kind: 'deliver' } }), { changes: { files: 0, ahead: 1, behind: 0 }, flow: { cmd: 'flow-pr', label: '/flow-pr', disabled: true, reason: 'Checks are red' } });
  assert.equal(off.items[2].available, false);
  assert.equal(off.items[2].why, 'Checks are red');
});

test('actionMenu: flow-next reasons (changes first, then no unit), and a repo with an error or no row has nothing available', () => {
  const dirty = menuOf(card({ action: { kind: 'merge', pr: 3 }, next: NEXT }), { changes: { files: 1, ahead: 0, behind: 0 } });
  assert.equal(dirty.items[0].why, 'Deliver the current changes first');
  const unpushed = menuOf(card({ action: { kind: 'merge', pr: 3 }, next: NEXT }), { changes: { files: 0, ahead: 2, behind: 0 } });
  assert.equal(unpushed.items[0].why, 'Deliver the current changes first');
  assert.equal(menuOf(card({ action: null, next: null })).items[0].why, 'No next unit to take');
  for (const row of [card({ error: 'boom', action: { kind: 'start' }, next: NEXT }), null]) {
    const m = menuOf(row);
    assert.equal(m.items.length, 4);
    assert.deepEqual(avail(m), [false, false, false, false]);
    assert.ok(m.items.every((i) => i.why));
  }
});

test('actionMenu: when the session is not free all four are unavailable with the reason of that state', () => {
  const REASONS = { working: 'The session is working: wait until it is free', waiting: 'The session is asking you something: answer it in the card of the chat', none: 'No open session of this repo', unknown: 'The session state is unknown' };
  for (const [live, reason] of Object.entries(REASONS)) {
    const m = menuOf(card({ action: { kind: 'start' }, next: NEXT }), { live });
    assert.deepEqual(avail(m), [false, false, false, false], live);
    assert.deepEqual(whys(m), [reason, reason, reason, reason], live);
  }
});
// ---------- actionButtonsHtml (RP85: the menu became direct buttons) ----------
const MENU = {
  items: [
    { cmd: 'flow-next', label: '/flow-next', available: true, why: 'RP9 — <i>x</i>' },
    { cmd: 'flow-commit', label: '/flow-commit', available: false, why: 'No <b>changes</b>' },
    { cmd: 'flow-pr', label: '/flow-pr', available: false, why: 'Nothing committed yet' },
    { cmd: 'flow-base', label: '/flow-base', available: false, why: 'The branch has not been merged yet' },
  ],
};

test('actionButtonsHtml: only the available command is drawn, as a pi button with its reason as title, everything escaped', () => {
  const html = R.actionButtonsHtml(MENU, 'abc');
  assert.equal((html.match(/<button/g) || []).length, 1);
  assert.match(html, /<button type="button" class="c-act" data-act="pi" data-id="abc" data-cmd="flow-next" title="RP9 — &lt;i&gt;x&lt;\/i&gt;">\/flow-next<\/button>/);
  assert.doesNotMatch(html, /disabled/);
  assert.doesNotMatch(html, /flow-commit|flow-pr|flow-base|Not available|Available now|No &lt;b&gt;|<i>x|<b>/, 'the unavailable ones leave no trace');
  assert.match(R.actionButtonsHtml(MENU, 'a"b'), /data-id="a&quot;b"/);
});

test('actionButtonsHtml: two available commands are two buttons in the fixed order; none gives an empty string', () => {
  const two = { items: MENU.items.map((i) => (i.cmd === 'flow-pr' ? { ...i, available: true, why: '' } : i)) };
  const html = R.actionButtonsHtml(two, 'abc');
  assert.deepEqual([...html.matchAll(/data-cmd="([a-z-]+)"/g)].map((m) => m[1]), ['flow-next', 'flow-pr']);
  assert.match(html, /data-cmd="flow-pr" title="Send \/flow-pr to the open session of this repo"/, 'no reason: a plain title');
  assert.equal(R.actionButtonsHtml({ items: MENU.items.map((i) => ({ ...i, available: false })) }, 'abc'), '');
  for (const bad of [null, undefined, {}, { items: 'x' }, { items: [null, 5, {}] }]) assert.equal(R.actionButtonsHtml(bad, 'abc'), '');
});

test('actionButtonsHtml: while an order of the repo is on its way the buttons are disabled', () => {
  assert.match(R.actionButtonsHtml(MENU, 'abc', { sending: true }), /data-cmd="flow-next" title="[^"]*" disabled>/);
  assert.doesNotMatch(R.actionButtonsHtml(MENU, 'abc', { sending: false }), /disabled/);
});

test('the menu helpers are gone: no actionMenuHtml export', () => {
  assert.equal(R.actionMenuHtml, undefined);
});

// ---------- composerNote + chatHead ----------
test('composerNote: empty for null; escaped text in a span; never a Clear button (the Orca prompt box is gone)', () => {
  assert.equal(R.composerNote(null), '');
  const plain = R.composerNote({ text: 'Sent <b>x</b>', id: 'abc' });
  assert.match(plain, /<span[^>]*>Sent &lt;b&gt;x&lt;\/b&gt;<\/span>/);
  assert.doesNotMatch(plain, /chat-clear|<b>/);
  assert.doesNotMatch(R.composerNote({ text: 'Still there', id: 'a"c', clear: true }), /button|chat-clear/);
});
test('sessionState: the label follows the rpc state, and the header never shows it', () => {
  const word = (rpc, i = adoptedInfo()) => R.sessionState({ id: 'r1', info: i, rpc }).word;
  assert.deepEqual(['starting', 'idle', 'busy', 'asking', 'closed'].map((state) => word({ state })), ['Starting…', 'Idle', 'Working…', 'Asking you something', 'Not started']);
  assert.equal(word(undefined), 'Unknown');
  assert.equal(R.sessionState({ id: 'r1', info: null }).word, 'Loading…');
  assert.doesNotMatch(R.chatHead({ id: 'r1', info: adoptedInfo(), rpc: { state: 'busy' } }, { name: 'alpha' }), /Working|Idle|Not started/);
});
// ---------- server: readChat file match ----------
test('readChat: another session whose id ends with "_<id>" is not read; the real "<ts>_<id>.jsonl" still is', () => {
  const folder = path.join(scratch, 'Some Repo');
  const dir = SS.sessionsDirFor(folder, sessionsBase);
  fs.mkdirSync(dir, { recursive: true });
  const line = (t) => JSON.stringify({ type: 'message', timestamp: '2026-10-28T14:00:00.000Z', message: { role: 'user', content: [{ type: 'text', text: t }], timestamp: Date.parse('2026-10-28T14:00:00Z') } });
  const put = (name, t) => fs.writeFileSync(path.join(dir, name), `${JSON.stringify({ type: 'session', version: 3, id: 'x', timestamp: '2026-10-28T10:00:00.000Z', cwd: folder })}\n${line(t)}\n`);
  put('2026-10-28T10-00-00-000Z_a_b.jsonl', 'from a_b');
  const only = SS.readChat(folder, 'b', { base: sessionsBase });
  assert.equal(only.found, false);
  assert.deepEqual(only.items, []);
  put('2026-10-28T10-00-00-000Z_b.jsonl', 'from b');
  const both = SS.readChat(folder, 'b', { base: sessionsBase });
  assert.equal(both.found, true);
  assert.deepEqual(both.items.map((i) => i.text), ['from b']);
});

// ---------- page: sending ----------
test('chat-send: an empty or whitespace-only box posts nothing', async () => {
  const { page } = await ready();
  for (const v of ['', '   \n\t ']) { page.get('#msgBox').value = v; await sendClick(page); }
  await page.tick();
  assert.deepEqual(posts(page, '/api/rpc/prompt'), []);
});
test('chat-send: a session that cannot receive posts nothing and the note shows why', async () => {
  const { page } = await ready({ '/api/rpc/status': rpcState('busy') });
  typeIn(page, 'hello');
  await sendClick(page);
  await page.tick();
  assert.deepEqual(posts(page, '/api/rpc/prompt'), []);
  assert.ok(page.get('#msgNote').html.includes(WORKING), page.get('#msgNote').html);
  assert.equal(page.get('#msgBox').value, 'hello');
});
test('chat-send: ONE prompt with the text exactly as typed; it clears the box and the note and leaves no draft', async () => {
  const { page } = await ready();
  const typed = '  hello there \n second line  ';
  typeIn(page, typed);
  page.fetches.length = 0;
  await sendClick(page);
  await page.tick();
  const sent = posts(page, '/api/rpc/prompt');
  assert.equal(sent.length, 1);
  assert.deepEqual(JSON.parse(sent[0].body), { id: 'abc', text: typed });
  assert.equal(posts(page, '/api/rpc/start').length, 0, 'an idle session is not started again');
  assert.equal(page.get('#msgBox').value, '');
  assert.equal(page.get('#msgNote').html, '');
  page.run("ACTIONS['chat-open']({ dataset: { id: 'xyz' } })");
  await page.tick();
  page.run("ACTIONS['chat-open']({ dataset: { id: 'abc' } })");
  await page.tick();
  assert.equal(page.get('#msgBox').value, '', 'the sent text did not come back as a draft');
});
test('chat-send: the button is disabled while the request is in flight and a second dispatch posts nothing', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const { page } = await ready({ '/api/rpc/prompt': () => gate });
  typeIn(page, 'once');
  const first = sendClick(page);
  await page.tick(2);
  assert.equal(page.get('#msgSend').disabled, true);
  await sendClick(page);
  await page.tick(2);
  assert.equal(posts(page, '/api/rpc/prompt').length, 1);
  release({ ok: true, json: async () => ({ disposition: 'started' }) });
  await first;
  await page.tick();
  assert.equal(page.get('#msgSend').disabled, false);
  assert.equal(posts(page, '/api/rpc/prompt').length, 1);
});
test('chat-send: a server error keeps the text, shows the server message, and a later dispatch is allowed', async () => {
  const msg = 'The agent rejected the command';
  const { page } = await ready({ '/api/rpc/prompt': () => fail(409, msg) });
  typeIn(page, 'keep me');
  await sendClick(page);
  await page.tick();
  assert.equal(page.get('#msgBox').value, 'keep me');
  assert.ok(page.get('#msgNote').html.includes(msg), page.get('#msgNote').html);
  assert.equal(posts(page, '/api/rpc/prompt').length, 1);
  await sendClick(page);
  await page.tick();
  assert.equal(posts(page, '/api/rpc/prompt').length, 2);
});
test('the send button follows the session: disabled with the reason as title while working, enabled once idle', async () => {
  let state = 'busy';
  const { page } = await ready({ '/api/rpc/status': () => okJson(rpcState(state)) });
  const title = () => page.get('#msgSend').title || page.get('#msgSend').attrs.title || '';
  assert.equal(page.get('#msgSend').disabled, true);
  assert.ok(title().includes(WORKING), title());
  await sendClick(page);
  assert.deepEqual(posts(page, '/api/rpc/prompt'), []);
  state = 'idle';
  page.run("rpcSync('abc')");
  await page.tick();
  assert.equal(page.get('#msgSend').disabled, false);
  assert.ok(!title().includes(WORKING));
});
// ---------- page: drafts and polling ----------
test('drafts: the text typed for one repo survives opening another repo, coming back, and closing the chat', async () => {
  const { page } = await ready();
  typeIn(page, 'draft for demo');
  page.run("ACTIONS['chat-open']({ dataset: { id: 'xyz' } })");
  await page.tick();
  assert.equal(page.get('#msgBox').value, '');
  typeIn(page, 'draft for other');
  page.run("ACTIONS['chat-open']({ dataset: { id: 'abc' } })");
  await page.tick();
  assert.equal(page.get('#msgBox').value, 'draft for demo');
  page.run("ACTIONS['chat-close']()");
  await page.tick();
  page.run("ACTIONS['chat-open']({ dataset: { id: 'xyz' } })");
  await page.tick();
  assert.equal(page.get('#msgBox').value, 'draft for other');
  page.run("ACTIONS['chat-open']({ dataset: { id: 'abc' } })");
  await page.tick();
  assert.equal(page.get('#msgBox').value, 'draft for demo');
});

test('the 5 s poll never rewrites #msgBox.value, even when the answer changed; the action buttons and the note are what it paints', async () => {
  let text = 'hello there';
  const { page } = await ready({ '/api/chat': () => okJson({ ...HIST, items: [{ role: 'user', text, at: null, tools: [] }] }) });
  const box = page.get('#msgBox');
  let writes = 0;
  let val = 'half-typed message';
  Object.defineProperty(box, 'value', { get: () => val, set: (v) => { writes++; val = v; }, configurable: true });
  text = 'something new from the session';
  page.intervals.find((i) => i.ms === 5000).fn();
  await page.tick();
  assert.match(page.get('#chatBody').html, /something new from the session/);
  assert.equal(writes, 0);
  assert.equal(val, 'half-typed message');
});

// ---------- page: the action buttons (RP85) ----------
const composerTarget = (page, { act: name = null, inside = false, dataset = {} } = {}) => {
  const composer = page.get('#composer');
  const node = element({ dataset: name ? { act: name, ...dataset } : {}, tagName: 'BUTTON' });
  node.closest = (sel) => (sel === '[data-act]' ? (name ? node : null) : sel === '#composer' && inside ? composer : null);
  composer.contains = (t) => inside && t === node;
  return node;
};

test('actions: no trace of the old menu is left in the page (no / Actions button, chat-menu act, actionsOpen state or #actionsPop)', () => {
  const app = fs.readFileSync(path.join(PUBLIC, 'app.js'), 'utf8');
  assert.doesNotMatch(app, /chat-menu|actionsOpen|closeActions|actionsPop/);
  assert.doesNotMatch(fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8'), /chat-menu|actionsPop|\/ Actions/);
  assert.doesNotMatch(fs.readFileSync(path.join(PUBLIC, 'style.css'), 'utf8'), /#actionsPop/);
});

test('actions: one Escape closes the chat now that no menu is in between', async () => {
  const { page, S } = await ready();
  page.fire('keydown', { key: 'Escape' });
  assert.equal(S.chat.id, null);
});

test('actions: #chatActions is painted from the open row, the live state, summaryChanges and summaryFlow, and only with what is available', async () => {
  const page = loadPage({ answers: answersFor() });
  const S = seed(page);
  Object.assign(S.summary.rows[0], { action: { kind: 'deliver' }, next: NEXT });
  S.local = { abc: { files: [{}, {}], added: 3, deleted: 1, ahead: 0, behind: 0 } };
  page.run("summaryFlow = () => ({ cmd: 'flow-commit', label: '/flow-commit' })");
  page.run("ACTIONS['chat-open']({ dataset: { id: 'abc' } })");
  await page.tick();
  const html = page.get('#chatActions').html;
  assert.match(html, /<button[^>]*data-act="pi" data-id="abc" data-cmd="flow-commit"[^>]*>\/flow-commit<\/button>/);
  assert.equal((html.match(/<button/g) || []).length, 1, 'only the command that conviene ahora');
  assert.doesNotMatch(html, /Commit the changes first|Deliver the current changes first|flow-next|flow-pr|flow-base/);
});

test('actions: with the session working nothing is drawn, and it comes back when the session is free', async () => {
  const page = loadPage({ answers: answersFor() });
  const S = seed(page);
  Object.assign(S.summary.rows[0], { action: { kind: 'deliver' }, next: NEXT });
  S.local = { abc: { files: [{}], added: 1, deleted: 0, ahead: 0, behind: 0 } };
  page.run("summaryFlow = () => ({ cmd: 'flow-commit', label: '/flow-commit' })");
  page.run("ACTIONS['chat-open']({ dataset: { id: 'abc' } })");
  await page.tick();
  assert.match(page.get('#chatActions').html, /data-cmd="flow-commit"/);
  page.run("S.rpc.abc = { ...S.rpc.abc, state: 'busy' }; draw();"); // RPC2b-1: the reason follows S.rpc, not the live answer
  await page.tick();
  assert.equal(page.get('#chatActions').html, '');
  page.run("S.rpc.abc = { ...S.rpc.abc, state: 'idle' }; draw();");
  await page.tick();
  assert.match(page.get('#chatActions').html, /data-cmd="flow-commit"/);
});

test('actions: the button goes through ACTIONS.pi (POST /api/pi) exactly once', async () => {
  const { page } = await ready();
  const item = composerTarget(page, { act: 'pi', inside: true, dataset: { id: 'abc', cmd: 'flow-next' } });
  page.fire('click', { target: item });
  await page.tick();
  const sent = posts(page, '/api/pi');
  assert.equal(sent.length, 1);
  assert.deepEqual(JSON.parse(sent[0].body), { id: 'abc', command: 'flow-next' });
});

test('actions: while an order of the repo is on its way the painted buttons are disabled', async () => {
  const page = loadPage({ answers: answersFor() });
  const S = seed(page);
  Object.assign(S.summary.rows[0], { action: { kind: 'deliver' }, next: NEXT });
  S.local = { abc: { files: [{}], added: 1, deleted: 0, ahead: 0, behind: 0 } };
  page.run("summaryFlow = () => ({ cmd: 'flow-commit', label: '/flow-commit' })");
  page.run("ACTIONS['chat-open']({ dataset: { id: 'abc' } })");
  await page.tick();
  assert.doesNotMatch(page.get('#chatActions').html, /disabled/);
  page.run("S.sending.abc = 'flow-commit'; draw();");
  await page.tick();
  assert.match(page.get('#chatActions').html, /data-cmd="flow-commit"[^>]*disabled/);
});

// ---------- page: the keyboard ----------
const enter = (page, e = {}) => {
  let prevented = 0;
  page.fire('keydown', { key: 'Enter', shiftKey: false, isComposing: false, target: Object.assign(page.get('#msgBox'), { id: 'msgBox' }), preventDefault: () => { prevented++; }, ...e });
  return () => prevented;
};

test('keyboard: Enter sends once and is prevented; Shift+Enter and IME composition neither send nor prevent', async () => {
  const { page } = await ready();
  typeIn(page, 'via keyboard');
  const prevented = enter(page);
  await page.tick();
  assert.equal(prevented(), 1);
  assert.equal(posts(page, '/api/rpc/prompt').length, 1);
  assert.deepEqual(JSON.parse(posts(page, '/api/rpc/prompt')[0].body), { id: 'abc', text: 'via keyboard' });
  typeIn(page, 'second');
  const shift = enter(page, { shiftKey: true });
  const composing = enter(page, { isComposing: true });
  await page.tick();
  assert.equal(shift(), 0);
  assert.equal(composing(), 0);
  assert.equal(posts(page, '/api/rpc/prompt').length, 1);
});

test('keyboard: Enter when the session cannot receive is prevented, posts nothing and the note shows the reason', async () => {
  const { page } = await ready({ '/api/rpc/status': rpcState('busy') });
  typeIn(page, 'too soon');
  const prevented = enter(page);
  await page.tick();
  assert.equal(prevented(), 1);
  assert.deepEqual(posts(page, '/api/rpc/prompt'), []);
  assert.ok(page.get('#msgNote').html.includes(WORKING), page.get('#msgNote').html);
  assert.equal(page.get('#msgBox').value, 'too soon');
});
