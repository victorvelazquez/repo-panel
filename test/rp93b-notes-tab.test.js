'use strict';
// RP93b (S8): the Notes tab of the chat head: a free-text notepad saved by the page through GET/POST /api/notes (RP93). The tab is there with and without the right column;
// the text is saved ~800 ms after the person stops typing and at once when the tab, the chat or the page is left; one write at a time; a conflict writes nothing; unsaved text is never
// lost or overwritten by a read. The page runs in a vm with a fake clock (no real timers, no network).
const test = require('node:test');
const { appSource } = require('./pagesrc.js');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const R = require('../public/resumen.js');
const V = require('../public/view.js');

const PUBLIC = path.join(__dirname, '..', 'public');
const css = fs.readFileSync(path.join(PUBLIC, 'style.css'), 'utf8').replace(/\r\n/g, '\n');

// ---------- pure ----------
const view = (n) => R.notesView(n);
const READY = { text: 'hello', base: 'r1', savedText: 'hello', status: 'saved', error: '', loaded: true };

test('n1: the view is one full-size textarea with the text and a separate status line; the status words are exactly Saving…, Saved and Not saved', () => {
  const h = view(READY);
  assert.match(h, /<textarea id="notesBox" class="notes-box"[^>]*>hello<\/textarea>/);
  assert.match(h, /<div id="notesStatus" class="notes-status" role="status">Saved<\/div>/);
  assert.match(view({ ...READY, status: 'saving' }), /id="notesStatus"[^>]*>Saving…</);
  const bad = view({ ...READY, status: 'error', error: 'Notes unavailable' });
  assert.match(bad, /Not saved/);
  assert.match(bad, /Notes unavailable/);
  assert.match(bad, /<button type="button"[^>]*data-act="notes-retry"[^>]*>Retry<\/button>/);
  assert.match(view({ ...READY, status: 'error', error: '' }), /Not saved/);
  assert.doesNotMatch(view({ ...READY, status: 'error', error: '' }), /undefined|null|: </);
  assert.equal(R.notesStatus(READY), 'Saved');
});

test('n2: loading and unavailable states have no textarea; a conflict shows the notice with both buttons', () => {
  assert.match(view(null), /Loading notes…/);
  assert.match(view({ status: 'loading', loaded: false }), /Loading notes…/);
  assert.doesNotMatch(view(null), /<textarea/);
  const u = view({ status: 'unavailable', error: 'Notes unavailable', loaded: false });
  assert.match(u, /Notes unavailable/);
  assert.doesNotMatch(u, /<textarea/);
  const c = view({ ...READY, status: 'conflict' });
  assert.match(c, /<textarea id="notesBox"/);
  assert.match(c, /<button type="button"[^>]*data-act="notes-disk"[^>]*>Load the version on disk<\/button>/);
  assert.match(c, /<button type="button"[^>]*data-act="notes-mine"[^>]*>Keep mine<\/button>/);
  assert.match(c, /changed outside/i);
});

test('n3: the text and the reason are escaped, and the view is total for odd input', () => {
  const h = view({ ...READY, text: '</textarea><b>"x" & \'y\'</b>', status: 'error', error: '<i>&"' });
  assert.doesNotMatch(h, /<b>|<i>/);
  assert.equal((h.match(/<\/textarea>/g) || []).length, 1);
  assert.match(h, /&lt;\/textarea&gt;&lt;b&gt;&quot;x&quot; &amp; &#39;y&#39;&lt;\/b&gt;/);
  for (const arg of [undefined, null, {}, [], 'x', 5, { text: 5 }, { text: null, status: 'zzz', loaded: true }]) {
    const out = view(arg);
    assert.equal(typeof out, 'string');
    assert.doesNotMatch(out, /undefined|\bnull\b|NaN/, JSON.stringify(arg));
  }
});

test('n4: the head has a Notes tab: with and without the column; selected when c.tab is notes; the other tabs are as before', () => {
  const tabs = (c, x) => [...R.chatHead(c, x).matchAll(/data-tab="(\w+)"/g)].map((m) => m[1]);
  assert.deepEqual(tabs({ id: 'abc' }, { name: 'd', column: true }), ['chat', 'files', 'notes']);
  assert.deepEqual(tabs({ id: 'abc' }, { name: 'd' }), ['chat', 'tasks', 'changes', 'files', 'notes']);
  assert.match(R.chatHead({ id: 'abc', tab: 'notes' }, { name: 'd', column: true }), /data-tab="notes"[^>]*aria-selected="true"[^>]*>Notes</);
  assert.match(R.chatHead({ id: 'abc', tab: 'notes' }, { name: 'd' }), /data-tab="notes"[^>]*aria-selected="true"/);
  assert.doesNotMatch(R.chatHead({ id: 'abc', tab: 'notes' }, { name: 'd' }), /data-tab="chat"[^>]*aria-selected="true"/);
  assert.deepEqual(tabs({ id: 'abc', tab: 'diff', dfile: 'a.js' }, { name: 'd', column: true }), ['chat', 'files', 'notes', 'diff']);
  assert.match(R.chatHead({ id: 'abc', tab: 'tasks' }, { name: 'd', column: true }), /data-tab="chat"[^>]*aria-selected="true"/, 'Tasks still reads as chat with the column');
});

test('n5: the styles: the notepad fills the block, monospace, status below', () => {
  assert.match(css, /\.notes\s*\{[^}]*flex:\s*1/);
  assert.match(css, /\.notes-box\s*\{[^}]*flex:\s*1/);
  assert.match(css, /\.notes-box\s*\{[^}]*monospace/);
  assert.match(css, /\.notes-status\s*\{/);
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
function loadPage() {
  const els = {};
  const frames = [];
  const fetches = [];
  const routes = {};
  const winL = {};
  const docL = {};
  const timers = [];
  let now = 0;
  const tabEls = ['summary', 'work', 'conformity'].map((t) => element({ dataset: { tab: t } }));
  const get = (sel) => (els[sel] ||= (sel === 'meta[name=token]' ? element({ content: 'token' }) : element()));
  const doc = { hidden: false, querySelector: get, querySelectorAll: (s) => (String(s).includes('data-tab') ? tabEls : []), addEventListener(t, fn) { (docL[t] ||= []).push(fn); }, createElement: () => element(), body: element(), activeElement: null };
  const ctx = vm.createContext({
    console, document: doc, location: { hash: '' },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    requestAnimationFrame: (cb) => { frames.push(cb); return frames.length; },
    setInterval: () => 0, AbortController, confirm: () => true,
    setTimeout: (fn, ms) => { timers.push({ at: now + ms, fn, id: timers.length + 1 }); return timers.length; },
    clearTimeout: (id) => { const t = timers.find((x) => x.id === id); if (t) t.fn = null; },
    fetch: (url, opts = {}) => { fetches.push({ url, method: opts.method || 'GET', body: opts.body ? JSON.parse(opts.body) : null }); return routes[url] ? routes[url](url, opts) : new Promise(() => {}); },
  });
  ctx.window = ctx;
  ctx.addEventListener = (t, fn) => { (winL[t] ||= []).push(fn); };
  ctx.RepoPanelView = V;
  ctx.RepoPanelResumen = R;
  vm.runInContext(appSource(), ctx);
  const flush = () => { while (frames.length) frames.shift()(); };
  const settle = async (n = 8) => { for (let i = 0; i < n; i++) await new Promise((x) => setImmediate(x)); };
  const tick = async (n = 8) => { for (let r = 0; r < 2; r++) { await settle(n); flush(); } };
  // The fake clock: runs the timers due within `ms` (the request time limits are cleared when a request ends).
  const advance = async (ms) => {
    now += ms;
    for (const t of timers.filter((x) => x.fn && x.at <= now)) { const f = t.fn; t.fn = null; f(); }
    await tick();
  };
  return { get, flush, tick, advance, fetches, routes, winL, docL, doc, run: (c) => vm.runInContext(c, ctx) };
}
const ok = (body) => ({ ok: true, json: async () => body });
const fail = (msg) => ({ ok: false, status: 500, statusText: 'Failed', json: async () => ({ error: msg }) });
const card = (id, name) => ({ id, name, group: 'G', room: null, branch: 'main', progress: { total: 4, completada: 1, enRevision: 0, bloqueada: 0, pendiente: 3, enCurso: 0 }, session: { state: 'free' }, next: null, blocking: [], lastMovement: {}, action: null, needs: false, rank: 9 });
function boot(width = 1400) {
  const page = loadPage();
  const S = page.run('S');
  S.groups = [{ name: 'G', repos: [{ id: 'abc', name: 'demo', path: 'p' }, { id: 'xyz', name: 'other', path: 'q' }] }];
  S.summary = { rows: [card('abc', 'demo'), card('xyz', 'other')], generatedAt: 'x' };
  const layout = page.get('#sumLayout');
  layout.clientWidth = width;
  layout.getBoundingClientRect = () => ({ left: 0, right: width, width });
  page.get('#split').offsetWidth = 10;
  page.get('#split2').offsetWidth = 10;
  return page;
}
const open = (page, id) => page.run(`ACTIONS['chat-open']({ dataset: { id: '${id}' } })`);
const tab = (page, t) => page.run(`ACTIONS['chat-tab']({ dataset: { tab: '${t}' } })`);
const act = (page, a) => page.run(`ACTIONS['${a}']({ dataset: {} })`);
const head = (page) => page.get('#chatHead').html;
const body = (page) => page.get('#chatBody');
const status = (page) => page.get('#notesStatus').html;
const GET = (id) => `/api/notes?id=${id}`;
const gets = (page, id = 'abc') => page.fetches.filter((f) => f.url === GET(id) && f.method === 'GET');
const saves = (page) => page.fetches.filter((f) => f.url === '/api/notes' && f.method === 'POST');
// What the person does in the textarea: the value changes, then the input event reaches the document.
const type = (page, text) => {
  page.get('#notesBox').value = text;
  for (const fn of page.docL.input || []) fn({ target: { id: 'notesBox', value: text } });
  page.flush();
};
// A POST /api/notes the test answers by hand: it stays in flight until its `resolve` is called.
function manualSaves(page) {
  const pending = [];
  page.routes['/api/notes'] = (url, opts) => new Promise((resolve) => { pending.push({ body: JSON.parse(opts.body), resolve }); });
  return pending;
}
async function onNotes(over = {}) {
  const page = boot();
  page.routes[GET('abc')] = () => Promise.resolve(ok({ text: 'start', rev: 'r0', exists: true, ...over }));
  open(page, 'abc');
  await page.tick();
  tab(page, 'notes');
  await page.tick();
  return page;
}

test('p1: the Notes tab is in the head with the column and without it, and opening it reads the notes of the repo and draws the textarea', async () => {
  for (const width of [1400, 900]) {
    const page = boot(width);
    page.routes[GET('abc')] = () => Promise.resolve(ok({ text: 'my note', rev: 'r0', exists: true }));
    open(page, 'abc');
    await page.tick();
    assert.match(head(page), /data-tab="notes"/, `width ${width}`);
    assert.equal(gets(page).length, 0, 'the chat tab reads nothing');
    tab(page, 'notes');
    await page.tick();
    assert.equal(gets(page).length, 1);
    assert.match(body(page).html, /<textarea id="notesBox"[^>]*>my note<\/textarea>/);
    assert.match(status(page), /Saved/);
    assert.equal(page.get('#composer').hidden, true, 'no composer on the notes tab');
    assert.match(head(page), /data-tab="notes"[^>]*aria-selected="true"/);
  }
});

test('p2: back on the chat tab the composer is back and Tasks/Changes still read as chat with the column in', async () => {
  const page = await onNotes();
  tab(page, 'chat');
  await page.tick();
  assert.equal(page.get('#composer').hidden, false);
  for (const t of ['tasks', 'changes']) {
    tab(page, t);
    await page.tick();
    assert.equal(page.run('S.chat.tab'), 'chat', `${t} is hidden by the column`);
  }
});

test('p3: typing then waiting 800 ms saves exactly once with { id, text, base }; before that nothing is sent', async () => {
  const page = await onNotes();
  page.routes['/api/notes'] = () => Promise.resolve(ok({ ok: true, rev: 'r1' }));
  type(page, 'start more');
  await page.advance(799);
  assert.equal(saves(page).length, 0);
  assert.match(status(page), /Saving…/);
  await page.advance(1);
  assert.equal(saves(page).length, 1);
  assert.deepEqual(saves(page)[0].body, { id: 'abc', text: 'start more', base: 'r0' });
  assert.match(status(page), /Saved/);
  await page.advance(5000);
  assert.equal(saves(page).length, 1, 'nothing more once saved');
});

test('p4: typing again resets the 800 ms wait (one save for a burst)', async () => {
  const page = await onNotes();
  page.routes['/api/notes'] = () => Promise.resolve(ok({ ok: true, rev: 'r1' }));
  type(page, 'a');
  await page.advance(500);
  type(page, 'ab');
  await page.advance(500);
  assert.equal(saves(page).length, 0);
  await page.advance(300);
  assert.equal(saves(page).length, 1);
  assert.equal(saves(page)[0].body.text, 'ab');
});

test('p5: one write at a time: text typed during a save is saved with the NEW rev only after the first ends', async () => {
  const page = await onNotes();
  const pending = manualSaves(page);
  type(page, 'one');
  await page.advance(800);
  assert.equal(pending.length, 1);
  type(page, 'one two');
  await page.advance(800);
  await page.advance(800);
  assert.equal(pending.length, 1, 'the second save waits for the first');
  assert.equal(saves(page).length, 1);
  pending[0].resolve(ok({ ok: true, rev: 'r1' }));
  await page.tick();
  assert.equal(pending.length, 2);
  assert.deepEqual(pending[1].body, { id: 'abc', text: 'one two', base: 'r1' });
  assert.doesNotMatch(status(page), /Saved/, 'not Saved while there is text left to save');
  pending[1].resolve(ok({ ok: true, rev: 'r2' }));
  await page.tick();
  assert.match(status(page), /Saved/);
  assert.equal(saves(page).length, 2);
});

test('p6: leaving the tab flushes at once, without waiting; so does closing the chat and opening another repo', async () => {
  for (const leave of [(p) => tab(p, 'chat'), (p) => act(p, 'chat-close'), (p) => open(p, 'xyz')]) {
    const page = await onNotes();
    page.routes['/api/notes'] = () => Promise.resolve(ok({ ok: true, rev: 'r1' }));
    type(page, 'start!');
    leave(page);
    await page.tick();
    assert.equal(saves(page).length, 1, String(leave));
    assert.deepEqual(saves(page)[0].body, { id: 'abc', text: 'start!', base: 'r0' });
    await page.advance(2000);
    assert.equal(saves(page).length, 1, 'the pending wait does not save a second time');
  }
});

test('p7: the page hiding (visibilitychange to hidden) and pagehide flush the notes', async () => {
  for (const [kind, fire] of [['visibilitychange', (p) => { p.doc.hidden = true; for (const fn of p.docL.visibilitychange || []) fn(); }], ['pagehide', (p) => { for (const fn of p.winL.pagehide || []) fn(); }]]) {
    const page = await onNotes();
    page.routes['/api/notes'] = () => Promise.resolve(ok({ ok: true, rev: 'r1' }));
    type(page, 'start!');
    fire(page);
    await page.tick();
    assert.equal(saves(page).length, 1, kind);
  }
});

test('p8: a conflict writes nothing more and shows the notice with both buttons; the text stays', async () => {
  const page = await onNotes();
  page.routes['/api/notes'] = () => Promise.resolve(ok({ conflict: true, text: 'disk text', rev: 'r9' }));
  type(page, 'mine');
  await page.advance(800);
  assert.equal(saves(page).length, 1);
  assert.match(status(page), /Load the version on disk/);
  assert.match(status(page), /Keep mine/);
  assert.equal(page.run('S.pad.abc.text'), 'mine');
  type(page, 'mine and more');
  await page.advance(3000);
  tab(page, 'chat');
  await page.tick();
  assert.equal(saves(page).length, 1, 'no save while the conflict is open, not even on leaving');
  assert.equal(page.run('S.pad.abc.text'), 'mine and more');
});

test('p9: Load the version on disk replaces the text and base, writes nothing, and repaints the textarea', async () => {
  const page = await onNotes();
  page.routes['/api/notes'] = () => Promise.resolve(ok({ conflict: true, text: 'disk text', rev: 'r9' }));
  type(page, 'mine');
  await page.advance(800);
  act(page, 'notes-disk');
  await page.tick();
  assert.equal(saves(page).length, 1);
  assert.equal(page.run('S.pad.abc.text'), 'disk text');
  assert.equal(page.run('S.pad.abc.base'), 'r9');
  assert.match(body(page).html, /<textarea id="notesBox"[^>]*>disk text<\/textarea>/);
  assert.match(status(page), /Saved/);
  await page.advance(3000);
  assert.equal(saves(page).length, 1);
});

test('p10: Keep mine takes the disk rev as base and saves the local text again', async () => {
  const page = await onNotes();
  let n = 0;
  page.routes['/api/notes'] = () => Promise.resolve(n++ === 0 ? ok({ conflict: true, text: 'disk text', rev: 'r9' }) : ok({ ok: true, rev: 'r10' }));
  type(page, 'mine');
  await page.advance(800);
  act(page, 'notes-mine');
  await page.tick();
  assert.equal(saves(page).length, 2);
  assert.deepEqual(saves(page)[1].body, { id: 'abc', text: 'mine', base: 'r9' });
  assert.match(status(page), /Saved/);
  assert.equal(page.run('S.pad.abc.base'), 'r10');
});

test('p11: a failed save shows Not saved with the reason and a Retry button, keeps the text, and the next input or Retry saves again', async () => {
  const page = await onNotes();
  let n = 0;
  page.routes['/api/notes'] = () => Promise.resolve(n++ < 2 ? fail('Notes unavailable') : ok({ ok: true, rev: 'r1' }));
  type(page, 'keep me');
  await page.advance(800);
  assert.match(status(page), /Not saved/);
  assert.match(status(page), /Notes unavailable/);
  assert.match(status(page), /Retry/);
  assert.equal(page.run('S.pad.abc.text'), 'keep me');
  await page.advance(5000);
  assert.equal(saves(page).length, 1, 'no loop of retries on its own');
  type(page, 'keep me too');
  await page.advance(800);
  assert.equal(saves(page).length, 2, 'the next input saves again');
  assert.match(status(page), /Not saved/);
  act(page, 'notes-retry');
  await page.tick();
  assert.equal(saves(page).length, 3);
  assert.deepEqual(saves(page)[2].body, { id: 'abc', text: 'keep me too', base: 'r0' });
  assert.match(status(page), /Saved/);
});

test('p12: a load never overwrites text that is dirty or being saved; unsaved text survives leaving the tab and the chat', async () => {
  const page = await onNotes();
  const pending = manualSaves(page);
  type(page, 'dirty text');
  tab(page, 'chat'); // flushes: the save is now in flight and never ends
  await page.tick();
  assert.equal(pending.length, 1);
  tab(page, 'notes');
  await page.tick();
  assert.equal(page.run('S.pad.abc.text'), 'dirty text', 'a read does not replace the text of a save in flight');
  assert.equal(gets(page).length, 1, 'no read over text being saved');
  assert.match(body(page).html, /dirty text/);
  act(page, 'chat-close');
  open(page, 'abc');
  await page.tick();
  assert.equal(page.run('S.pad.abc.text'), 'dirty text');
});

test('p13: a read that lands after the person typed does not replace the text', async () => {
  const page = boot();
  let release;
  page.routes[GET('abc')] = () => new Promise((resolve) => { release = () => resolve(ok({ text: 'from disk', rev: 'r5', exists: true })); });
  open(page, 'abc');
  await page.tick();
  tab(page, 'notes');
  await page.tick();
  assert.match(body(page).html, /Loading notes…/);
  page.run("S.pad.abc.loaded = true; S.pad.abc.status = 'saved'");
  page.run('draw()');
  page.flush();
  type(page, 'typed meanwhile');
  release();
  await page.tick();
  assert.equal(page.run('S.pad.abc.text'), 'typed meanwhile');
});

test('p14: each switch to the tab reads again; only the latest read counts; a read for the repo left is stored for it and never painted over another', async () => {
  const page = boot();
  const held = [];
  page.routes[GET('abc')] = () => new Promise((resolve) => held.push((v) => resolve(ok(v))));
  page.routes[GET('xyz')] = () => Promise.resolve(ok({ text: 'xyz note', rev: 'x1', exists: true }));
  open(page, 'abc');
  await page.tick();
  tab(page, 'notes');
  tab(page, 'chat');
  tab(page, 'notes');
  await page.tick();
  assert.equal(held.length, 2, 'one read per switch');
  held[1]({ text: 'new', rev: 'r2', exists: true });
  await page.tick();
  held[0]({ text: 'old', rev: 'r1', exists: true });
  await page.tick();
  assert.equal(page.run('S.pad.abc.text'), 'new');
  tab(page, 'chat');
  tab(page, 'notes');
  await page.tick();
  held[2]({ text: 'late for abc', rev: 'r3', exists: true });
  open(page, 'xyz');
  await page.tick();
  tab(page, 'notes');
  await page.tick();
  assert.match(body(page).html, /xyz note/);
  assert.doesNotMatch(body(page).html, /late for abc/);
  assert.equal(page.run('S.pad.abc.text'), 'late for abc', 'stored for its own repo');
});

test('p15: a failed first read says Notes unavailable (no textarea); a later switch tries again', async () => {
  const page = boot();
  let n = 0;
  page.routes[GET('abc')] = () => Promise.resolve(n++ === 0 ? fail('Notes unavailable') : ok({ text: 'now', rev: 'r1', exists: true }));
  open(page, 'abc');
  await page.tick();
  tab(page, 'notes');
  await page.tick();
  assert.match(body(page).html, /Notes unavailable/);
  assert.doesNotMatch(body(page).html, /<textarea/);
  tab(page, 'chat');
  tab(page, 'notes');
  await page.tick();
  assert.match(body(page).html, /<textarea id="notesBox"[^>]*>now<\/textarea>/);
});

test('p16: a status change or any redraw does not recreate the textarea: the body is written once per opening and the status on its own', async () => {
  const page = await onNotes();
  page.routes['/api/notes'] = () => Promise.resolve(ok({ ok: true, rev: 'r1' }));
  const b = body(page);
  const written = b.writes;
  type(page, 'abc');
  await page.advance(800);
  assert.match(status(page), /Saved/);
  for (let i = 0; i < 3; i++) { page.run('draw()'); page.flush(); }
  assert.equal(b.writes, written, 'the textarea (the body) was not written again');
  assert.equal(page.get('#notesBox').value, 'abc');
});

test('p17: the chat state changing while the notepad is open does not touch it', async () => {
  const page = await onNotes();
  const b = body(page);
  const written = b.writes;
  page.run("S.chat.info = { live: { state: 'working' } }; draw()");
  page.flush();
  assert.equal(b.writes, written);
  assert.match(b.html, /<textarea id="notesBox"/);
});
