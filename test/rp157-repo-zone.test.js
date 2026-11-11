'use strict';
// RP157 (S26), second half of the mobile version (design F of design/panel-movil/06): under 760 px of width the Repo is a THIRD screen on top of the chat (data-screen="repo"), reached by a button of the chat head and left by an
// arrow next to its title. The tabs Tasks, Changes and Files leave the chat and live in Repo (the column's content is painted under 760 px, and the chat keeps Chat and Notes). A file or a diff tapped in Repo takes the person back to
// the chat, where the viewer tab is. A task tapped in the list opens the Repo on its Tasks tab. Between 760 and 1100 px, and from 1100 px up, nothing changes.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { appSource } = require('./pagesrc.js');
const V = require('../public/view.js');
const R = require('../public/resumen.js');

const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'style.css'), 'utf8').replace(/\r\n/g, '\n');
const A = 'abcdef0123';
const B = '9c15a89663';

// ---------- the screen (pure) ----------
test('s1: under 760 px the zone repo of an open repo is the screen repo; any other zone is the chat; no repo is the list; from 1100 px up there is no screen (RP136: 760 to 1099 is the duo)', () => {
  assert.equal(V.screenOf(390, A, 'repo'), 'repo');
  assert.equal(V.screenOf(759, A, 'repo'), 'repo');
  assert.equal(V.screenOf(390, A, 'chat'), 'chat');
  assert.equal(V.screenOf(390, A), 'chat');
  for (const z of ['', null, 5, 'Repo', 'repo ', {}, undefined]) assert.equal(V.screenOf(390, A, z), 'chat', String(z));
  assert.equal(V.screenOf(390, null, 'repo'), 'list');
  for (const w of [1100, 1500]) assert.equal(V.screenOf(w, A, 'repo'), null, String(w));
  for (const w of [0, NaN, undefined, '390']) assert.equal(V.screenOf(w, A, 'repo'), null, String(w));
});

// ---------- the markup ----------
test('h1: the head of the chat has the Repo button (a named button, its icon hidden) after the name and before the close button; zone-set with the zone repo', () => {
  const h = R.chatHead({ id: A, tab: 'chat' }, { name: 'demo', column: true });
  assert.match(h, /<b class="ch-name"[^>]*>demo<\/b><button type="button" class="ch-repo" data-act="zone-set" data-zone="repo" aria-label="Open the repo: tasks, changes, status and files" title="Open the repo"><svg [^>]*aria-hidden="true"[^>]*>[\s\S]*?<\/svg><\/button><button type="button" class="x" data-act="chat-close"/);
});

test('h2: the column view, asked for the Repo screen (back), starts with a head with the arrow and the title; without it nothing is added', () => {
  const base = { name: 'demo', tab: 'changes', fold: {}, git: null, files: [], fa: null };
  const withBack = R.columnView({ ...base, back: true });
  assert.match(withBack, /^<div class="col-head"><button type="button" class="ch-back" data-act="zone-back" aria-label="Back to the chat" title="Back to the chat"><svg [^>]*aria-hidden="true"[^>]*>[\s\S]*?<\/svg><\/button><b>Repo<\/b>/);
  assert.doesNotMatch(R.columnView(base), /col-head|zone-back/);
  assert.doesNotMatch(R.columnView({ ...base, back: 'yes' }), /col-head/, 'only true turns it on');
});

// ---------- the stylesheet ----------
const rules = [...css.matchAll(/(?:^|\n)([^{}\n@/ ][^{}\n]*)\{([^}]*)\}/g)].flatMap((m) => m[1].split(',').map((s) => ({ sel: s.trim().replace(/\s+/g, ' '), body: m[2] })));
const rule = (sel) => { const r = rules.filter((x) => x.sel === sel); assert.ok(r.length, `a rule for ${sel}`); return r.map((x) => x.body).join(';'); };

test('c1: the repo screen shows only the column, which takes the whole width; the other screens keep it out; the Repo button is out by default and in only under 760 px; the head of Repo is a 44 px row', () => {
  assert.match(rule('#sumLayout[data-screen="repo"] #listCol'), /display:\s*none/);
  assert.match(rule('#sumLayout[data-screen="repo"] #chat'), /display:\s*none/);
  assert.match(rule('#sumLayout[data-screen="list"] #col'), /display:\s*none/);
  assert.match(rule('#sumLayout[data-screen="chat"] #col'), /display:\s*none/);
  const col = rule('#sumLayout[data-screen="repo"] #col');
  assert.match(col, /display:\s*flex/);
  assert.match(col, /width:\s*auto|width:\s*100%/);
  assert.match(col, /min-width:\s*0/);
  assert.doesNotMatch(rule('#sumLayout[data-screen] #split'), /undefined/);
  assert.match(rule('.ch-repo'), /display:\s*none/);
  assert.match(rule('#sumLayout[data-screen] .ch-repo'), /display:\s*inline-flex/);
  assert.match(rule('#sumLayout[data-screen] .ch-repo'), /min-width:\s*44px/);
  assert.match(rule('.col-head'), /min-height:\s*44px/);
  assert.match(css, /\.ch-repo:focus-visible[^{]*\{[^}]*outline:\s*2px solid var\(--blue\)/);
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
    fetch: (url) => (String(url).startsWith('/api/config') ? Promise.resolve({ ok: true, json: async () => CONFIG(ids) }) : new Promise(() => {})),
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
    screen: () => get('#sumLayout').dataset.screen,
    state: (expr) => vm.runInContext(expr, ctx),
    pushes: () => calls.filter((c) => c[0] === 'push').map((c) => c[1]),
    backs: () => calls.filter((c) => c[0] === 'back').length,
    setWidth: async (w) => { get('#sumLayout').clientWidth = w; await fire('resize'); },
    go: async (h) => { loc.hash = h; await fire('popstate'); await fire('hashchange'); },
    click: async (act, dataset = {}) => { vm.runInContext(`ACTIONS[${JSON.stringify(act)}]({ dataset: ${JSON.stringify(dataset)} })`, ctx); await tick(); },
  };
}
const head = (page) => page.get('#chatHead').html;
const colBody = (page) => page.get('#colBody').html;

test('p1: the Repo button opens the repo screen; its head has the arrow; the column is painted there with its tabs; the chat head has no Tasks, Changes or Files tab but keeps Chat and Notes', async () => {
  const page = await boot({ width: 390 });
  await page.click('chat-open', { id: A });
  assert.equal(page.screen(), 'chat');
  await page.click('zone-set', { zone: 'repo' });
  assert.equal(page.screen(), 'repo');
  assert.match(colBody(page), /^<div class="col-head">/);
  for (const t of ['tasks', 'changes', 'status', 'files']) assert.match(colBody(page), new RegExp(`data-tab="${t}"|data-coltab="${t}"|coltab-${t}`), t);
  const h = head(page);
  assert.doesNotMatch(h, /data-tab="tasks"|data-tab="changes"|data-tab="files"/);
  assert.match(h, /data-tab="chat"/);
  assert.match(h, /data-tab="notes"/);
  assert.match(h, /data-act="zone-set" data-zone="repo"/);
});

test('p2: a file tapped in Repo takes the person back to the chat with the viewer tab; the same for a diff', async () => {
  const page = await boot({ width: 390 });
  await page.click('chat-open', { id: A });
  await page.click('zone-set', { zone: 'repo' });
  await page.click('files-open', { path: 'src/a.js' });
  assert.equal(page.screen(), 'chat');
  assert.equal(page.state('S.chat.tab'), 'file');
  assert.equal(page.state('S.chat.ffile'), 'src/a.js');
  await page.click('zone-set', { zone: 'repo' });
  await page.click('changes-file', { path: 'src/b.js' });
  assert.equal(page.screen(), 'chat');
  assert.equal(page.state('S.chat.tab'), 'diff');
  assert.equal(page.state('S.chat.dfile'), 'src/b.js');
});

test('p3: a task tapped in the list opens the repo screen on its Tasks tab', async () => {
  const page = await boot({ width: 390 });
  await page.click('tasks-open', { id: A });
  assert.equal(page.screen(), 'repo');
  assert.equal(page.state('S.chat.colTab'), 'tasks');
});

test('p4: the arrow of Repo uses the Back of the browser when the page itself moved from the chat to Repo (one entry), and closes to the chat otherwise', async () => {
  const page = await boot({ width: 390 });
  await page.click('chat-open', { id: A });
  await page.click('zone-set', { zone: 'repo' });
  assert.deepEqual(page.pushes(), [`/panel/#/repo/${A}/chat`, `/panel/#/repo/${A}/repo`]);
  await page.click('zone-back');
  assert.equal(page.backs(), 1);
  await page.click('zone-back');
  assert.equal(page.backs(), 1, 'a second tap while the Back is on its way does nothing');
  await page.go(`#/repo/${A}/chat`);
  assert.equal(page.screen(), 'chat');
  assert.equal(page.pushes().length, 2, 'going back wrote nothing');
  const link = await boot({ width: 390, hash: `#/repo/${B}/repo` });
  assert.equal(link.screen(), 'repo');
  await link.click('zone-back');
  assert.equal(link.backs(), 0, 'a Repo that came from a link has no entry of the page to go back to');
  assert.equal(link.screen(), 'chat');
  assert.equal(link.state('S.chat.zone'), 'chat');
});

test('p5: the Back of the phone alone does the same as the arrow', async () => {
  const page = await boot({ width: 390 });
  await page.click('chat-open', { id: A });
  await page.click('zone-set', { zone: 'repo' });
  const written = page.calls.length;
  await page.go(`#/repo/${A}/chat`);
  assert.equal(page.screen(), 'chat');
  assert.equal(page.calls.length, written);
});

test('p6: a resize across the cut keeps the zone: wide there is no screen and the three columns; narrow again returns to Repo', async () => {
  const page = await boot({ width: 390 });
  await page.click('chat-open', { id: A });
  await page.click('zone-set', { zone: 'repo' });
  await page.setWidth(1200);
  assert.equal(page.screen(), undefined);
  assert.doesNotMatch(colBody(page), /col-head/, 'no arrow where the column is a column');
  await page.setWidth(390);
  assert.equal(page.screen(), 'repo');
  assert.match(colBody(page), /^<div class="col-head">/);
});

test('p7: from 760 px up the chat has no Tasks, Changes or Files tabs: the column holds them, in the duo (760 to 1099 px, RP136) and in the three columns (from 1100 px)', async () => {
  const mid = await boot({ width: 900 });
  await mid.click('chat-open', { id: A });
  for (const t of ['tasks', 'changes', 'files']) assert.doesNotMatch(head(mid), new RegExp(`data-tab="${t}"`), `900 ${t}`);
  assert.notEqual(colBody(mid), '');
  const wide = await boot({ width: 1440 });
  await wide.click('chat-open', { id: A });
  for (const t of ['tasks', 'changes', 'files']) assert.doesNotMatch(head(wide), new RegExp(`data-tab="${t}"`), `1440 ${t}`);
  await wide.click('zone-set', { zone: 'repo' });
  assert.equal(wide.screen(), undefined);
});

test('p8: an address with the zone repo opens the repo screen; the list address and closing the chat leave it', async () => {
  const page = await boot({ width: 390 });
  await page.go(`#/repo/${A}/repo`);
  assert.equal(page.screen(), 'repo');
  await page.go('');
  assert.equal(page.screen(), 'list');
});

test('p9: the Repo button and the zone are total: no repo open does nothing and writes nothing; a room has no repo screen', async () => {
  const page = await boot({ width: 390 });
  await page.click('zone-set', { zone: 'repo' });
  await page.click('zone-back');
  assert.deepEqual(page.calls, []);
  assert.equal(page.screen(), 'list');
});

test('p10: when the page wrote no entry for Repo (a room has no address) the arrow does not use the Back of the browser: it goes to the chat zone', async () => {
  const page = await boot({ width: 390, ids: [A, 'room:team'] });
  await page.click('chat-open', { id: 'room:team' });
  await page.click('zone-set', { zone: 'repo' });
  assert.equal(page.state('S.chat.zone'), 'repo');
  assert.deepEqual(page.calls, [], 'nothing was written');
  await page.click('zone-back');
  assert.equal(page.backs(), 0);
  assert.equal(page.state('S.chat.zone'), 'chat');
});
