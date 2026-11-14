'use strict';
// RP196 (S10, S12): under 760 px Notes and the viewer of a file or a diff live in the right column, not in the chat. Notes is a FIFTH tab of the column (only on the phone); a file or a diff tapped in the column opens a
// DETAIL screen inside the column, a head with an arrow back to the list of its tab and the viewer under it, so the person does not leave the column. The chat of the phone keeps no tabs of its own (Chat is alone). Between
// 760 px and above nothing changes: the viewer is still the tab of the chat. How it LOOKS is for the person to try; these tests pin the markup, the state and the rules.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { appSource } = require('./pagesrc.js');
const V = require('../public/view.js');
const R = require('../public/resumen.js');

const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'style.css'), 'utf8').replace(/\r\n/g, '\n').replace(/\/\*[\s\S]*?\*\//g, '');
const ruleIn = (src, sel) => [...src.matchAll(/(?:^|\n|\})\s*([^{}@]+)\{([^}]*)\}/g)].filter((m) => m[1].split(',').some((s) => s.trim().replace(/\s+/g, ' ') === sel)).map((m) => m[2]).join(';');
const A = 'abcdef0123';
const B = '9c15a89663';

// ---------- pure ----------
test('n1: the column has a Notes tab only when it is asked for it (the phone); the others stay and Notes comes last', () => {
  const phone = R.columnView({ tab: 'changes', notes: true, files: [] });
  assert.match(phone, /<button type="button" role="tab" class="col-tab" id="coltab-notes" data-act="col-tab" data-tab="notes" aria-selected="false"[^>]*aria-label="Notes"/);
  assert.ok(phone.indexOf('coltab-files') < phone.indexOf('coltab-notes'), 'Notes after Files');
  assert.doesNotMatch(R.columnView({ tab: 'changes', files: [] }), /coltab-notes/, 'wide and duo: no Notes tab');
});

test('n2: with the Notes tab open the pane is an empty box the page paints; without the flag a «notes» tab reads as Changes', () => {
  const open = R.columnView({ tab: 'notes', notes: true, files: [] });
  assert.match(open, /id="coltab-notes"[^>]*aria-selected="true"/);
  assert.match(open, /<div class="col-pane" id="colpane" role="tabpanel" aria-labelledby="coltab-notes"><div id="colNotes" class="col-notes"><\/div><\/div>/);
  const wide = R.columnView({ tab: 'notes', files: [] });
  assert.match(wide, /id="coltab-changes"[^>]*aria-selected="true"/);
  assert.doesNotMatch(wide, /colNotes/);
});

test('n3: the detail screen has the arrow back first, the name of the file with its path as the title, and the viewer under it; everything it prints is escaped', () => {
  const h = R.columnDetail({ title: 'src/<b>x.js', html: '<p id="v">viewer</p>' });
  assert.match(h, /^<div class="col-head"><button type="button" class="ch-back" data-act="detail-close" aria-label="Back to the list" title="Back to the list"><svg[^>]*aria-hidden="true">/);
  assert.match(h, /<b class="col-title" title="src\/&lt;b&gt;x\.js">&lt;b&gt;x\.js<\/b>/);
  assert.match(h, /<div class="col-detail" id="coldetail"><p id="v">viewer<\/p><\/div>$/);
  assert.doesNotMatch(h, /<b>x/);
  assert.match(R.columnDetail({ title: '', html: '' }), /class="col-title" title="">/);
});

test('n3b: the name in the title is the last part of the path, whether the path is written with slashes or with the backslashes of Windows', () => {
  const name = (title) => /<b class="col-title"[^>]*>([^<]*)<\/b>/.exec(R.columnDetail({ title, html: '' }))[1];
  assert.equal(name('src/sub/a.js'), 'a.js');
  assert.equal(name('src\\sub\\a.js'), 'a.js');
  assert.equal(name('README.md'), 'README.md');
  assert.equal(name(undefined), '');
});

test('n4: the chat head of the phone has no Notes tab and no tab of the open file or diff (they live in the column); the head of the wide screen keeps both', () => {
  const c = { tab: 'chat', dfile: 'src/b.js', ffile: '' };
  const phone = R.chatHead(c, { name: 'demo', column: true, narrow: true, git: {} });
  assert.deepEqual([...phone.matchAll(/data-act="chat-tab" data-tab="(\w+)"/g)].map((m) => m[1]), ['chat']);
  assert.doesNotMatch(phone, /ch-dtab|diff-close/);
  const wide = R.chatHead(c, { name: 'demo', column: true, git: {} });
  assert.deepEqual([...wide.matchAll(/data-act="chat-tab" data-tab="(\w+)"/g)].map((m) => m[1]), ['chat', 'notes', 'diff']);
  assert.match(wide, /ch-dtab/);
});

test('n5: the stylesheet: the phone hides the row of tabs of the chat (only Chat is left), and the detail screen has its own rules', () => {
  assert.match(ruleIn(css, '#sumLayout[data-screen="chat"] .ch-tabs'), /display:\s*none/);
  assert.match(ruleIn(css, '.col-detail'), /padding:/);
  assert.match(ruleIn(css, '.col-title'), /overflow:\s*hidden/);
  assert.match(ruleIn(css, '.col-notes'), /display:\s*flex/);
});

// ---------- the page ----------
function element(extra = {}) {
  const el = {
    html: '', hidden: false, dataset: {}, disabled: false, value: '', checked: false, textContent: '', title: '', placeholder: '', attrs: {}, listeners: {}, children: [], open: false, scrollTop: 0,
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    style: { setProperty(k, v) { el.style[k] = v; } },
    addEventListener(t, fn) { (el.listeners[t] ||= []).push(fn); }, setAttribute(k, v) { el.attrs[k] = v; }, querySelector: () => null, querySelectorAll: () => [], closest: () => null,
    showModal() {}, close() {}, focus() {}, append(c) { el.children.push(c); },
    get innerHTML() { return el.html; }, set innerHTML(v) { el.html = String(v); }, ...extra,
  };
  return el;
}
const CONFIG = (ids) => ({ groups: [{ name: 'G', repos: ids.map((id) => ({ id, name: `repo-${id}`, path: `p-${id}` })) }], snoozed: [], dismissed: [], rooms: [], roomIssues: [] });
async function boot({ width = 390, hash = '', ids = [A, B] } = {}) {
  const els = {};
  const frames = [];
  const listeners = {};
  const calls = [];
  const loc = { hash, pathname: '/panel/', search: '' };
  const setUrl = (url) => { const at = String(url).indexOf('#'); loc.hash = at >= 0 ? String(url).slice(at) : ''; };
  const hist = { pushState(s, t, url) { calls.push(['push', url]); setUrl(url); }, replaceState(s, t, url) { calls.push(['replace', url]); setUrl(url); }, back() { calls.push(['back']); } };
  const tabEls = ['summary', 'work', 'conformity', 'settings'].map((t) => element({ dataset: { tab: t } }));
  const get = (sel) => (els[sel] ||= (sel === 'meta[name=token]' ? element({ content: 'token' }) : element()));
  get('#sumLayout').clientWidth = width;
  const doc = { hidden: false, querySelector: get, querySelectorAll: (s) => (String(s).includes('data-tab') ? tabEls : []), addEventListener() {}, createElement: () => element(), body: element(), activeElement: null };
  const sandbox = {
    console, document: doc, TextDecoder, AbortController, confirm: () => true, location: loc, history: hist,
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    requestAnimationFrame: (cb) => { frames.push(cb); return frames.length; }, setInterval: () => 0, setTimeout: () => 0, clearTimeout: () => {}, clearInterval: () => {},
    fetch: (url) => { calls.push(['fetch', String(url)]); return String(url).startsWith('/api/config') ? Promise.resolve({ ok: true, json: async () => CONFIG(ids) }) : new Promise(() => {}); },
  };
  const ctx = vm.createContext(sandbox);
  ctx.window = ctx;
  ctx.addEventListener = (t, fn) => { (listeners[t] ||= []).push(fn); };
  ctx.RepoPanelView = V;
  ctx.RepoPanelResumen = R;
  vm.runInContext(appSource(), ctx);
  const flush = () => { while (frames.length) frames.shift()(); };
  const tick = async (n = 10) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); flush(); };
  await tick();
  const fire = async (t) => { for (const fn of listeners[t] || []) fn({ type: t }); await tick(); };
  return {
    calls, loc, get, tick, fire, run: (code) => vm.runInContext(code, ctx),
    fresh: (sel) => { els[sel] = element(); return els[sel]; }, // a NEW element, as when the page repaints a block and its inner boxes are made again
    fetches: () => calls.filter((c) => c[0] === 'fetch').map((c) => c[1]),
    screen: () => get('#sumLayout').dataset.screen,
    state: (expr) => vm.runInContext(expr, ctx),
    setWidth: async (w) => { get('#sumLayout').clientWidth = w; await fire('resize'); },
    click: async (act, dataset = {}) => { vm.runInContext(`ACTIONS[${JSON.stringify(act)}]({ dataset: ${JSON.stringify(dataset)} })`, ctx); await tick(); },
  };
}
const head = (page) => page.get('#chatHead').html;
const colBody = (page) => page.get('#colBody').html;
const repoScreen = async (page) => { await page.click('chat-open', { id: A }); await page.click('zone-set', { zone: 'repo' }); };

test('p1: a file tapped in the column of the phone opens its DETAIL in the column: the person stays on the repo screen, the chat tab does not change and the chat head has no chip', async () => {
  const page = await boot({ width: 390 });
  await repoScreen(page);
  await page.click('files-open', { path: 'src/a.js' });
  assert.equal(page.screen(), 'repo', 'the person does not leave the column');
  assert.equal(page.state('S.chat.detail'), 'file');
  assert.equal(page.state('S.chat.ffile'), 'src/a.js');
  assert.equal(page.state("S.chat.tab || 'chat'"), 'chat', 'the viewer is not a tab of the chat on the phone');
  assert.match(colBody(page), /^<div class="col-head"><button type="button" class="ch-back" data-act="detail-close"/);
  assert.match(colBody(page), /class="col-title" title="src\/a\.js">a\.js<\/b>/);
  assert.match(colBody(page), /<div class="col-detail" id="coldetail">/);
  assert.doesNotMatch(colBody(page), /col-tabs/, 'the tabs wait behind the detail');
  assert.doesNotMatch(head(page), /ch-dtab/);
});

test('p2: a diff tapped in the column of the phone opens its detail the same way, and the changes are asked for', async () => {
  const page = await boot({ width: 390 });
  await repoScreen(page);
  await page.click('changes-file', { path: 'src/b.js' });
  assert.equal(page.screen(), 'repo');
  assert.equal(page.state('S.chat.detail'), 'diff');
  assert.equal(page.state('S.chat.dfile'), 'src/b.js');
  assert.equal(page.state('S.chat.ffile'), '');
  assert.equal(page.state("S.chat.tab || 'chat'"), 'chat');
  assert.equal(page.state('S.chat.changesLoading'), true, 'the changes are being read for the viewer');
  assert.match(colBody(page), /class="col-title" title="src\/b\.js">b\.js<\/b>/);
});

test('p3: the arrow of the detail goes back to the list of the column, with its tabs, on the same screen; the arrow of the list still goes to the chat', async () => {
  const page = await boot({ width: 390 });
  await repoScreen(page);
  await page.click('files-open', { path: 'src/a.js' });
  await page.click('detail-close');
  assert.equal(page.screen(), 'repo');
  assert.equal(page.state("S.chat.detail || ''"), '');
  assert.match(colBody(page), /class="col-tabs"/);
  assert.match(colBody(page), /data-act="zone-back"/, 'the arrow of the list: back to the chat');
  const backs = () => page.calls.filter((c) => c[0] === 'back').length;
  const before = backs();
  await page.click('zone-back');
  assert.equal(backs(), before + 1, 'the arrow of the list asks the browser to go back, like before');
});

test('p4: leaving the column for the chat closes the detail: coming back to Repo shows the list', async () => {
  const page = await boot({ width: 390 });
  await repoScreen(page);
  await page.click('files-open', { path: 'src/a.js' });
  await page.click('zone-set', { zone: 'chat' });
  assert.equal(page.state("S.chat.detail || ''"), '');
  await page.click('zone-set', { zone: 'repo' });
  assert.match(colBody(page), /class="col-tabs"/);
});

test('p5: opening a detail starts it at the top of the column, whatever the list was scrolled to', async () => {
  const page = await boot({ width: 390 });
  await repoScreen(page);
  page.get('#col').scrollTop = 640;
  await page.click('changes-file', { path: 'src/b.js' });
  assert.equal(page.get('#col').scrollTop, 0);
});

test('p6: the Notes tab of the phone: it is in the column, selecting it paints the notes box in the column and leaves the chat alone', async () => {
  const page = await boot({ width: 390 });
  await repoScreen(page);
  assert.match(colBody(page), /id="coltab-notes"/);
  await page.click('col-tab', { tab: 'notes' });
  assert.equal(page.state('S.chat.colTab'), 'notes');
  assert.match(colBody(page), /id="coltab-notes"[^>]*aria-selected="true"/);
  assert.match(colBody(page), /<div id="colNotes" class="col-notes"><\/div>/);
  assert.match(page.get('#colNotes').html, /Loading notes…|id="notesBox"/);
  assert.equal(page.state("S.chat.tab || 'chat'"), 'chat', 'Notes is not a tab of the chat on the phone');
  await page.click('col-tab', { tab: 'tasks' });
  assert.equal(page.state('S.chat.colTab'), 'tasks');
  assert.doesNotMatch(colBody(page), /colNotes/);
});

test('p7: from 760 px nothing changes: the column has no Notes tab, and a file or a diff is still the viewer tab of the chat with no detail', async () => {
  for (const width of [900, 1300]) {
    const page = await boot({ width });
    await page.click('chat-open', { id: A });
    assert.doesNotMatch(colBody(page), /coltab-notes/, `no Notes tab at ${width}`);
    await page.click('files-open', { path: 'src/a.js' });
    assert.equal(page.state('S.chat.tab'), 'file', `file tab at ${width}`);
    assert.equal(page.state("S.chat.detail || ''"), '');
    await page.click('changes-file', { path: 'src/b.js' });
    assert.equal(page.state('S.chat.tab'), 'diff', `diff tab at ${width}`);
    assert.match(head(page), /ch-dtab/);
  }
});

test('p8: a chat opened wide on Notes, then narrowed to a phone, does not paint the notes in the chat body and keeps the message box', async () => {
  const page = await boot({ width: 1300 });
  await page.click('chat-open', { id: A });
  await page.click('chat-tab', { tab: 'notes' });
  assert.equal(page.state('S.chat.tab'), 'notes');
  await page.setWidth(390);
  assert.doesNotMatch(page.get('#chatBody').html, /notesBox|Loading notes/);
  assert.equal(page.get('#composer').hidden, false);
  assert.deepEqual([...head(page).matchAll(/data-act="chat-tab" data-tab="(\w+)"/g)].map((m) => m[1]), ['chat']);
});

test('p9: the existing actions of the column still work on the phone: a tab, and a task tapped in the list opens Repo on Tasks', async () => {
  const page = await boot({ width: 390 });
  await repoScreen(page);
  await page.click('col-tab', { tab: 'files' });
  assert.equal(page.state('S.chat.colTab'), 'files');
  await page.click('zone-set', { zone: 'chat' });
  await page.click('tasks-open', { id: B });
  assert.equal(page.screen(), 'repo');
  assert.equal(page.state('S.chat.colTab'), 'tasks');
});

// ---------- the notepad in the column: what keeps the person's typing safe ----------
const loadedPad = (page, text = '') => page.run(`Object.assign(padOf(S.chat.id), { loaded: true, status: 'saved', text: ${JSON.stringify(text)}, savedText: ${JSON.stringify(text)}, base: 'r1' })`);

test('p10: opening the Notes tab of the phone reads the notes once: the box is made from what was read', async () => {
  const page = await boot({ width: 390 });
  await repoScreen(page);
  await page.click('col-tab', { tab: 'notes' });
  assert.ok(page.fetches().some((u) => u === `/api/notes?id=${A}`), 'the notes were asked for');
});

test('p11: typing in the notes box of the column does not repaint the box (the caret and the focus stay): only its status line changes', async () => {
  const page = await boot({ width: 390 });
  await repoScreen(page);
  await page.click('col-tab', { tab: 'notes' });
  loadedPad(page, 'first');
  page.run('draw()');
  await page.tick();
  const box = page.get('#colNotes');
  assert.match(box.html, /id="notesBox"[^>]*>first</);
  page.run("padOf(S.chat.id).text = 'first and then typed'");
  page.run('draw()');
  await page.tick();
  assert.doesNotMatch(box.html, /typed/, 'the box keeps what it painted: the textarea holds the new text by itself');
  assert.match(page.get('#notesStatus').html, /Saved|Saving/, 'the status line is the one that is painted');
});

test('p12: when the column repaints and the box is made again empty, the notes are painted again, not left blank', async () => {
  const page = await boot({ width: 390 });
  await repoScreen(page);
  await page.click('col-tab', { tab: 'notes' });
  loadedPad(page, 'my notes');
  page.run('draw()');
  await page.tick();
  assert.match(page.get('#colNotes').html, /my notes/);
  const again = page.fresh('#colNotes');
  page.run('draw()');
  await page.tick();
  assert.match(again.html, /id="notesBox"[^>]*>my notes</, 'the new box got the notes');
});

test('p13: leaving the Notes tab saves what was typed at once, and leaving a clean notepad saves nothing', async () => {
  const page = await boot({ width: 390 });
  await repoScreen(page);
  await page.click('col-tab', { tab: 'notes' });
  loadedPad(page, '');
  page.run("padOf(S.chat.id).text = 'typed but not saved yet'");
  const saves = () => page.fetches().filter((u) => u === '/api/notes').length;
  const before = saves();
  await page.click('col-tab', { tab: 'tasks' });
  assert.equal(saves(), before + 1, 'the dirty notes were sent when the tab was left');
  await page.click('col-tab', { tab: 'notes' });
  loadedPad(page, 'clean');
  const mid = saves();
  await page.click('col-tab', { tab: 'files' });
  assert.equal(saves(), mid, 'nothing to save, nothing sent');
});

test('p14: from 760 px a «notes» tab of the column is not a thing: it reads as Changes, and the notepad of the chat is the one that works', async () => {
  const page = await boot({ width: 1300 });
  await page.click('chat-open', { id: A });
  await page.click('col-tab', { tab: 'notes' });
  assert.equal(page.state('S.chat.colTab'), 'changes');
  assert.doesNotMatch(colBody(page), /colNotes/);
  await page.click('chat-tab', { tab: 'notes' });
  assert.equal(page.state('S.chat.tab'), 'notes', 'the chat tab of the wide screen still works');
  assert.match(page.get('#chatBody').html, /Loading notes|notesBox/);
});
