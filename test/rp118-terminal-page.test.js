'use strict';
// RP118 (S1, S2), the page: next to "Close session" a "Terminal" button shows the line to open the session of the repo in a normal terminal (the server wrote it: GET /api/terminal) with a Copy
// button and one fixed warning (close the session here first: pi does not lock its files, RP100). The line is read when the button is clicked, never when a chat opens. The command is kept in the page
// state and copied from there: it is never put in an attribute, and it is escaped where it is shown. A stale answer (another chat was opened meanwhile) is ignored; a failure says one fixed thing.
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { appSource } = require('./pagesrc.js');
const R = require('../public/resumen.js');
const V = require('../public/view.js');

const CMD = "Set-Location -LiteralPath 'C:\\Users\\victor\\Developer\\Tools\\repo-panel'; & 'C:\\L\\gentle-shell.cmd' --session-id panel-demo-abc";
const ANSWER = { available: true, cwd: 'C:\\Users\\victor\\Developer\\Tools\\repo-panel', command: CMD, sessionId: 'panel-demo-abc', shell: 'powershell' };

// ---------- the pure pieces ----------
test('t1: the button is there only while the repo has a session, and says what it does', () => {
  assert.equal(R.sessionTerminalHtml(false, null), '');
  const html = R.sessionTerminalHtml(true, null);
  assert.match(html, /<button type="button" class="ss-term" data-act="session-terminal"[^>]*>Terminal<\/button>/);
  assert.match(html, /aria-expanded="false"/);
  assert.match(html, /title="Show the command to open this session in a normal terminal"/);
  assert.match(R.sessionTerminalHtml(true, { open: true }), /aria-expanded="true"/);
});

test('t2: nothing is shown until the button is clicked; then a loading line, then the command', () => {
  assert.equal(R.terminalBlockHtml(null), '');
  assert.equal(R.terminalBlockHtml(undefined), '');
  assert.match(R.terminalBlockHtml({ open: true, loading: true }), /Loading the command/);
  const html = R.terminalBlockHtml({ open: true, ...ANSWER });
  assert.match(html, /<code class="term-cmd">Set-Location -LiteralPath &#39;C:\\Users\\victor|<code class="term-cmd">Set-Location -LiteralPath 'C:\\Users\\victor/);
  assert.match(html, /data-act="terminal-copy"[^>]*>Copy<\/button>/);
  assert.match(html, /data-act="terminal-hide"/);
});

test('t3: the warning is one fixed sentence: close the session here first, and why', () => {
  const html = R.terminalBlockHtml({ open: true, ...ANSWER });
  assert.match(html, /Close the session here first/);
  assert.match(html, /two programs on the same session mix up its history/i);
});

test('t4: after copying the button says Copied', () => {
  assert.match(R.terminalBlockHtml({ open: true, ...ANSWER, copied: true }), /data-act="terminal-copy"[^>]*>Copied<\/button>/);
});

test('t5: the command is escaped where it is shown, and never put in an attribute', () => {
  const evil = { open: true, available: true, cwd: 'x', sessionId: 's', command: `<img src=x onerror=alert(1)> "a" 'b' Set-Location` };
  const html = R.terminalBlockHtml(evil);
  assert.doesNotMatch(html, /<img/);
  assert.match(html, /&lt;img/);
  for (const m of html.matchAll(/\s[a-z-]+="([^"]*)"/g)) assert.equal(/Set-Location|onerror|<img/.test(m[1]), false, `an attribute carries the command: ${m[0]}`);
});

test('t6: an unavailable answer shows its reason (escaped); a failure shows one fixed line and never the raw error', () => {
  assert.match(R.terminalBlockHtml({ open: true, available: false, reason: 'No pi runtime is available' }), /No pi runtime is available/);
  const html = R.terminalBlockHtml({ open: true, available: false, reason: '<b>x</b>' });
  assert.doesNotMatch(html, /<b>x<\/b>/, 'the reason is not written as a tag');
  assert.match(html, /&lt;b&gt;x&lt;\/b&gt;/, 'it is escaped');
  assert.doesNotMatch(html, /data-act="terminal-copy"/, 'nothing to copy');
  const failed = R.terminalBlockHtml({ open: true, failed: true, message: 'ECONNRESET at C:\\secret' });
  assert.match(failed, /Could not read the command/);
  assert.doesNotMatch(failed, /ECONNRESET|secret/);
});

// ---------- the page ----------
function element(extra = {}) {
  const el = { html: '', hidden: false, dataset: {}, disabled: false, value: '', checked: false, textContent: '', title: '', placeholder: '', attrs: {}, children: [], writes: 0,
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false }, style: { setProperty() {} }, addEventListener() {}, setAttribute() {}, querySelector: () => null, querySelectorAll: () => [], closest: () => null,
    showModal() {}, close() {}, focus() {}, append() {}, get innerHTML() { return el.html; }, set innerHTML(v) { el.html = String(v); el.writes++; }, ...extra };
  return el;
}
const ok = (b) => ({ ok: true, json: async () => b });
function loadPage() {
  const frames = []; const fetches = []; const routes = []; const copies = []; const toasts = [];
  const clip = { fail: false }; const ui = { confirm: true };
  const els = {};
  const tabEls = ['summary', 'work', 'conformity'].map((t) => element({ dataset: { tab: t } }));
  const get = (sel) => (els[sel] ||= (sel === 'meta[name=token]' ? element({ content: 'token' }) : element()));
  const doc = { hidden: false, querySelector: get, querySelectorAll: (s) => (String(s).includes('data-tab') ? tabEls : []), addEventListener() {}, createElement: () => element(), body: element(), activeElement: null };
  const respond = (url, opts) => { for (const [m, fn] of routes) if (m(url)) return fn(url, opts); return new Promise(() => {}); };
  const ctx = vm.createContext({
    console, document: doc, location: { hash: '' }, localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    requestAnimationFrame: (cb) => { frames.push(cb); return frames.length; }, setInterval: () => 1, setTimeout: () => 0, clearTimeout: () => {}, AbortController,
    confirm: () => ui.confirm,
    navigator: { clipboard: { writeText: async (t) => { if (clip.fail) throw new Error('denied'); copies.push(t); } } },
    fetch: (url, opts = {}) => { fetches.push({ url, method: opts.method || 'GET', body: opts.body }); return respond(url, opts); },
  });
  ctx.window = ctx; ctx.addEventListener = () => {}; ctx.RepoPanelView = V; ctx.RepoPanelResumen = R;
  vm.runInContext(appSource(), ctx);
  vm.runInContext('globalThis.toast = (m, k) => { globalThis.__toasts.push([m, k]); };', Object.assign(ctx, { __toasts: toasts }) && ctx);
  const flush = () => { while (frames.length) frames.shift()(); };
  const tick = async (n = 20) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); flush(); };
  return { get, tick, routes, fetches, copies, toasts, clip, ui, run: (c) => vm.runInContext(c, ctx) };
}
const card = (id, name) => ({ id, name, group: 'G', room: null, branch: 'main', progress: { total: 1, completada: 0, enRevision: 0, bloqueada: 0, pendiente: 1, enCurso: 0 }, session: { state: 'free' }, next: null, blocking: [], last: null });
const ADOPTED = { id: 'panel-demo-abc', name: 'panel-demo-abc', adoptedAt: '2026-01-01T00:00:00.000Z' };
async function boot({ adopted = ADOPTED, terminal = () => Promise.resolve(ok(ANSWER)) } = {}) {
  const page = loadPage();
  const S = page.run('S');
  S.groups = [{ name: 'G', repos: [{ id: 'abc', name: 'demo', path: 'p' }, { id: 'xyz', name: 'other', path: 'q' }] }];
  S.summary = { rows: [card('abc', 'demo'), card('xyz', 'other')], generatedAt: 'x' };
  page.routes.push([(u) => u.startsWith('/api/sessions?'), () => Promise.resolve(ok({ key: 'abc', adopted, adoptedFound: !!adopted, sessions: [], live: { state: 'none', count: 0 } }))]);
  page.routes.push([(u) => u.startsWith('/api/chat?'), () => Promise.resolve(ok({ items: [], truncated: false }))]);
  page.routes.push([(u) => u.startsWith('/api/rpc/status'), () => Promise.resolve(ok({ state: adopted ? 'idle' : 'closed', pendingDialogs: [], sessionId: adopted ? adopted.id : null }))]);
  page.routes.push([(u) => u.startsWith('/api/terminal'), terminal]);
  page.routes.push([(u) => u === '/api/rpc/close', () => Promise.resolve(ok({ ok: true }))]);
  page.routes.push([(u) => u === '/api/sessions/adopt', () => Promise.resolve(ok({}))]);
  page.run("ACTIONS['chat-open']({ dataset: { id: 'abc' } })");
  await page.tick();
  return page;
}
const terminalCalls = (page) => page.fetches.filter((f) => f.url.startsWith('/api/terminal'));

test('t7: with a session the Terminal button is drawn next to Close session; with none it is not, and opening the chat reads nothing', async () => {
  const page = await boot();
  const state = page.get('#sessState').html;
  assert.match(state, /data-act="session-terminal"/);
  assert.ok(state.indexOf('session-terminal') < state.indexOf('session-close'), 'before Close session');
  assert.equal(terminalCalls(page).length, 0, 'no request until the click');
  assert.equal(page.get('#termBlock').html, '');
  const none = await boot({ adopted: null });
  assert.doesNotMatch(none.get('#sessState').html, /session-terminal/);
});

test('t8: the click reads the line of THIS repo once, shows it, and a second click hides it', async () => {
  const page = await boot();
  page.run("ACTIONS['session-terminal']()");
  await page.tick();
  const calls = terminalCalls(page);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, 'GET');
  assert.equal(calls[0].url, '/api/terminal?id=abc');
  assert.match(page.get('#termBlock').html, /Set-Location -LiteralPath/);
  assert.match(page.get('#sessState').html, /aria-expanded="true"/);
  page.run("ACTIONS['session-terminal']()");
  await page.tick();
  assert.equal(page.get('#termBlock').html, '');
  assert.equal(terminalCalls(page).length, 1, 'hiding asks nothing');
});

test('t9: Copy puts exactly the command of the page state on the clipboard (not text read from the screen) and then says Copied', async () => {
  const page = await boot();
  page.run("ACTIONS['session-terminal']()");
  await page.tick();
  page.run("ACTIONS['terminal-copy']()");
  await page.tick();
  assert.deepEqual(page.copies, [CMD]);
  assert.match(page.get('#termBlock').html, />Copied<\/button>/);
});

test('t10: if the browser refuses to copy, one fixed message is shown and the button does not say Copied', async () => {
  const page = await boot();
  page.clip.fail = true;
  page.run("ACTIONS['session-terminal']()");
  await page.tick();
  page.run("ACTIONS['terminal-copy']()");
  await page.tick();
  assert.deepEqual(page.copies, []);
  assert.equal(page.toasts.length, 1);
  assert.match(page.toasts[0][0], /Could not copy/);
  assert.equal(page.toasts[0][0].includes('denied'), false, 'the raw error is not shown');
  assert.doesNotMatch(page.get('#termBlock').html, />Copied<\/button>/);
});

test('t11: a failed read shows the fixed line and no raw error, and the button can try again', async () => {
  let n = 0;
  const page = await boot({ terminal: () => (++n === 1 ? Promise.reject(new Error('ECONNRESET at C:\\secret')) : Promise.resolve(ok(ANSWER))) });
  page.run("ACTIONS['session-terminal']()");
  await page.tick();
  const html = page.get('#termBlock').html;
  assert.match(html, /Could not read the command/);
  assert.doesNotMatch(html, /ECONNRESET|secret/);
  page.run("ACTIONS['session-terminal']()"); // hides
  await page.tick();
  page.run("ACTIONS['session-terminal']()"); // opens again: reads again
  await page.tick();
  assert.match(page.get('#termBlock').html, /Set-Location -LiteralPath/);
});

test('t12: an answer that arrives after another chat was opened is ignored: the block of the new chat stays empty', async () => {
  let release;
  const page = await boot({ terminal: () => new Promise((resolve) => { release = () => resolve(ok(ANSWER)); }) });
  page.run("ACTIONS['session-terminal']()");
  await page.tick();
  assert.match(page.get('#termBlock').html, /Loading the command/);
  page.run("ACTIONS['chat-open']({ dataset: { id: 'xyz' } })");
  await page.tick();
  assert.equal(page.get('#termBlock').html, '', 'the new chat starts with nothing shown');
  release();
  await page.tick();
  assert.equal(page.get('#termBlock').html, '', 'the late answer was dropped');
  assert.equal(page.run('S.chat.terminal'), undefined);
});

test('t13: Hide closes the block; the button, the block and the actions exist in the page and the CSS styles them', () => {
  const html = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'public', 'index.html'), 'utf8');
  assert.match(html, /<div id="termBlock" class="term-block"><\/div>/);
  const css = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'public', 'style.css'), 'utf8').replace(/\r\n/g, '\n');
  assert.match(css, /\.ss-term \{[^}]*margin-left: auto/);
  assert.match(css, /\.term-block:empty \{[^}]*display: none/);
  assert.match(css, /\.term-cmd \{[^}]*user-select: all/);
  assert.match(css, /\.term-cmd \{[^}]*white-space: pre-wrap/);
  const src = appSource();
  for (const a of ["'session-terminal'", "'terminal-copy'", "'terminal-hide'"]) assert.ok(src.includes(a), a);
});

test('t14: the README says what the Terminal button shows and what it does not do', () => {
  const readme = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'README.md'), 'utf8').replace(/\r\n/g, '\n');
  assert.match(readme, /\*\*Open the session in a normal terminal \(RP118\)\.\*\*/);
  assert.match(readme, /does not open a terminal/i);
});

// ---------- found by the independent verification ----------
test('t15: the block says which shell the line is for (PowerShell, not cmd); with no shell in the answer it says nothing', () => {
  assert.match(R.terminalBlockHtml({ open: true, ...ANSWER }), /<span class="term-shell" title="Paste it in PowerShell: cmd reads some characters differently">PowerShell<\/span>/);
  assert.match(R.terminalBlockHtml({ open: true, ...ANSWER, shell: 'posix' }), /<span class="term-shell"[^>]*>bash or zsh<\/span>/);
  assert.doesNotMatch(R.terminalBlockHtml({ open: true, ...ANSWER, shell: undefined }), /term-shell/);
  assert.doesNotMatch(R.terminalBlockHtml({ open: true, ...ANSWER, shell: '<img src=x>' }), /<img|term-shell/, 'an unknown value is not drawn');
});

test('t16: the page keeps the shell of the answer and shows it', async () => {
  const page = await boot();
  page.run("ACTIONS['session-terminal']()");
  await page.tick();
  assert.match(page.get('#termBlock').html, />PowerShell<\/span>/);
});

test('t17: closing the session clears the block, so it can never show the command of a session that is gone', async () => {
  const page = await boot();
  page.run("ACTIONS['session-terminal']()");
  await page.tick();
  assert.match(page.get('#termBlock').html, /Set-Location/);
  page.run("ACTIONS['session-close']()");
  await page.tick();
  assert.equal(page.run('S.chat.terminal') == null, true);
  assert.equal(page.get('#termBlock').html, '');
});

test('t18: adopting another session clears the block; a refused confirmation (a session written to a moment ago) changes nothing', async () => {
  const page = await boot();
  page.run("ACTIONS['session-terminal']()");
  await page.tick();
  page.ui.confirm = false;
  page.run("ACTIONS['chat-adopt']({ dataset: { id: 'abc', session: 'other', recent: '1' } })");
  await page.tick();
  assert.match(page.get('#termBlock').html, /Set-Location/, 'refused: the block stays');
  page.ui.confirm = true;
  page.run("ACTIONS['chat-adopt']({ dataset: { id: 'abc', session: 'other', recent: '1' } })");
  await page.tick();
  assert.equal(page.run('S.chat.terminal') == null, true);
  assert.equal(page.get('#termBlock').html, '');
});

test('t19: starting a NEW session clears the block too', async () => {
  const page = await boot();
  page.run("ACTIONS['session-terminal']()");
  await page.tick();
  page.run("ACTIONS['chat-start']({ dataset: { id: 'abc' }, disabled: false })");
  await page.tick();
  assert.equal(page.run('S.chat.terminal') == null, true);
  assert.equal(page.get('#termBlock').html, '');
});
