'use strict';
// RP56 (S50, S67): when the live session of a repo is asking a question (a dialog with a footer of keys), the chat shows
// the question as it is on the session's screen, with the highlighted option marked. Read-only: NO key is ever sent to a
// terminal (answering is RP73). Pure part (lib.piScreenDialog), the scan and /api/sessions with a fake Orca that records
// every call, the card of chatBody, and the page (app.js in vm). The real Orca and the real sessions are never touched.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'rp56-'));
const sessionsBase = path.join(scratch, 'sessions');
const repoDir = path.join(scratch, 'My Repo.Api');
for (const d of [sessionsBase, repoDir]) fs.mkdirSync(d);
const configFile = path.join(scratch, 'config.json');
process.env.REPO_PANEL_CONFIG = configFile;
process.env.REPO_PANEL_SESSIONS_DIR = sessionsBase;
process.env.REPO_PANEL_CASES_FILE = 'off';
test.after(() => fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 5 }));

const lib = require('../lib.js');
const S = require('../server/sessions.js');
const { scanSessions } = require('../server/pi.js');
const R = require('../public/resumen.js');

const PUBLIC = path.join(__dirname, '..', 'public');
const REPO_ID = lib.repoId(repoDir);
const writeConfig = () => fs.writeFileSync(configFile, JSON.stringify({ port: 4310, groups: [{ name: 'G', repos: [{ path: repoDir }] }], rooms: [] }));

// ---------- fixtures: screens shaped like the real ones the panel recorded (paths of the machine replaced by C:\proj) ----------
const SEP = '─'.repeat(110);
const USAGE = '5h 15% ↻lun 01:50 · 7d 37% ↻jue 11:00';
const NAV = '↑↓ navigate  enter select  escape/ctrl+c cancel';
const FOOT_B = '↑↓ navigate • Enter select • Esc cancel';
const FOOT_C = '↑↓ move · enter select · tab switch · esc cancel';
const FOOT_E = '↑↓ choose · Enter confirm · Esc cancel · D details';
const screen = (...lines) => lines.join('\n');

const A = screen('Allow guarded git command?', 'git -C C:\\proj fetch origin --prune && git log --oneline -3 | head -n 3', '→ Yes', 'No', NAV, SEP);
const B = screen('What do we do with the stash?', '→ Dejarlo como está', 'No toco el stash y la instalación del panel queda frenada.', 'Aplicar el stash', 'Recupero los cambios guardados y sigo con la entrega.', FOOT_B, SEP);
const B_NO_ARROW = screen('Read-only access to those files, for this session', 'No', 'I stop here and nothing is written', FOOT_B, SEP);
const C = screen('Which database should I use for the tests?', '→ No', 'No leo nada más fuera del repo; frenamos acá', 'Type something.', FOOT_C, SEP);
const D = screen('Run a guarded command?', '→ Allow once', 'Allow for this session', 'Deny', NAV, SEP);
const E = screen('Native review: this change is medium risk', '→ 1. Review this change', '2. Skip this time', '3. Review and allow this session', 'Effect: Reviews only this change; later medium- or high-risk changes ask again, and delivery needs separate approval.', FOOT_E);
const NOT_COMPACT = screen('Warning: Context usage is at 90% (≥ 90%); consider compacting before the next turn.', '⠙ Compacting context... (escape to cancel)', '▎ ✿ waiting for input', '▎   type, or / for commands', '▎');
const NOT_OVERFLOW = screen('↓ Jump to latest message · Ctrl+End', '⠋ Context overflow detected, Auto-compacting... (escape to cancel)', '▎ ✿ implementing…', '▎   type, or / for commands', '▎');
const IDLE = '▎ ✿ waiting for input\n▎   type, or / for commands\n▎\n~\\proj (main) • panel:demo\n';
const WORKING = '▎ ❁ working…\n▎   type, or / for commands\n▎\n~\\proj (main) • panel:demo\n';

// [name, screen, the question line, the footer, the index of the highlighted line]
const DIALOGS = [
  ['A', A, 'Allow guarded git command?', NAV, 2],
  ['B', B, 'What do we do with the stash?', FOOT_B, 1],
  ['C', C, 'Which database should I use for the tests?', FOOT_C, 1],
  ['D', D, 'Run a guarded command?', NAV, 1],
  ['E', E, 'Native review: this change is medium risk', FOOT_E, 1],
];
const NOT_DIALOGS = [['compacting', NOT_COMPACT], ['overflow', NOT_OVERFLOW], ['idle', IDLE], ['working', WORKING], ['plain text', 'just text\nmore text']];
const ALL = [...DIALOGS.map(([n, s]) => [n, s]), ['B without arrow', B_NO_ARROW], ...NOT_DIALOGS];

const dialogOf = (lines, selected) => ({ text: lines.join(String.fromCharCode(10)), lines, selected });
// RP73: the scan now adds `choices` (null here: these sessions have no full-screen read, and these screens have unindented options).
const A_DIALOG = { choices: null, ...dialogOf(['Allow guarded git command?', 'git -C C:\\proj fetch origin --prune && git log --oneline -3 | head -n 3', '→ Yes', 'No', NAV], 2) };
const D_DIALOG = { choices: null, ...dialogOf(['Run a guarded command?', '→ Allow once', 'Allow for this session', 'Deny', NAV], 1) };

// A fake Orca recording every call; `show` answers the screen by handle, anything else (send included) is unexpected.
const wt = (handle) => ({ handle, worktreePath: repoDir, connected: true, writable: true });
function fakeOrca({ screens = {}, failList = false, failShow = false } = {}) {
  const calls = [];
  const orca = async (args) => {
    calls.push(args);
    if (args[0] === 'list') { if (failList) throw new Error('down'); return { terminals: Object.keys(screens).map(wt) }; }
    if (args[0] === 'show') { if (failShow) throw new Error('show failed'); return { terminal: { preview: screens[args[2]] } }; }
    throw new Error(`unexpected ${args[0]}`);
  };
  return { orca, calls, sends: () => calls.filter((c) => c[0] === 'send') };
}

// ---------- 1. lib.piScreenDialog ----------
test('piScreenDialog is null for every non-string and for a screen with no footer of keys', () => {
  assert.equal(typeof lib.piScreenDialog, 'function');
  for (const v of [undefined, null, 5, {}, [], ['a'], true, () => 'x']) assert.equal(lib.piScreenDialog(v), null);
  assert.equal(lib.piScreenDialog(''), null);
  assert.equal(lib.piScreenDialog('just text\nmore text'), null);
  assert.equal(lib.piScreenDialog('→ Yes\nNo\n'), null);
});

test('an "(escape to cancel)" animation line is not a dialog footer: the two compaction screens, idle and working are null', () => {
  assert.equal(typeof lib.piScreenDialog, 'function');
  for (const [name, s] of NOT_DIALOGS) assert.equal(lib.piScreenDialog(s), null, name);
});

test('piScreenDialog(x) is null exactly when piScreenAsk(x) is null, over all the fixtures and the 14-line boundary', () => {
  assert.equal(typeof lib.piScreenDialog, 'function');
  const withAfter = (n) => screen('Allow?', '→ Yes', 'No', NAV, ...Array.from({ length: n }, (_, i) => `after ${i}`));
  const extra = [['13 lines after the footer', withAfter(13)], ['14 lines after the footer', withAfter(14)], ['15 lines after the footer', withAfter(15)], ['footer too long', `${NAV} ${'x'.repeat(200)}`], ['empty', ''], ['spaces', '  \n \n']];
  for (const [name, s] of [...ALL, ...extra]) assert.equal(lib.piScreenDialog(s) === null, lib.piScreenAsk(s) === null, name);
  assert.notEqual(lib.piScreenAsk(withAfter(13)), null);
  assert.notEqual(lib.piScreenDialog(withAfter(13)), null);
  assert.equal(lib.piScreenDialog(withAfter(14)), null);
});

test('piScreenDialog: lines end AT the footer (separator and usage widget are dropped), blank lines go, text is the lines joined', () => {
  const d = lib.piScreenDialog(`\n${A}\n\n   \n${USAGE}\n`);
  assert.deepEqual(d.lines, ['Allow guarded git command?', 'git -C C:\\proj fetch origin --prune && git log --oneline -3 | head -n 3', '→ Yes', 'No', NAV]);
  assert.equal(d.text, d.lines.join('\n'));
  assert.equal(d.selected, 2);
  assert.deepEqual(Object.keys(d).sort(), ['lines', 'selected', 'text']);
});

test('piScreenDialog: control characters become a space, lines are trimmed and cut to 200 characters', () => {
  const d = lib.piScreenDialog(screen('  e\u001b[31mred\u0007x\ty  ', 'z'.repeat(300), '→ Yes', NAV));
  assert.equal(d.lines[0], 'e [31mred x y');
  assert.equal(d.lines[1], 'z'.repeat(200));
  assert.equal(/[\x00-\x1f\x7f-\x9f]/.test(d.text.replace(/\n/g, '')), false);
});

test('piScreenDialog: the last 40 lines up to the footer, the text at most 3000 characters cut from the START', () => {
  const many = Array.from({ length: 60 }, (_, i) => (i === 45 ? '→ arrow here' : `line ${String(i).padStart(2, '0')}`));
  const d = lib.piScreenDialog(screen(...many, NAV, SEP));
  assert.equal(d.lines.length, 40);
  assert.equal(d.lines[0], 'line 21');
  assert.equal(d.lines[39], NAV);
  assert.equal(d.selected, 24);
  assert.equal(d.lines[d.selected], '→ arrow here');
  const wide = screen(...Array.from({ length: 39 }, (_, i) => `${String(i).padStart(2, '0')}${'y'.repeat(98)}`), NAV);
  const w = lib.piScreenDialog(wide);
  assert.equal(w.lines.length, 40);
  assert.equal(w.text.length, 3000);
  assert.equal(w.text, w.lines.join('\n').slice(-3000));
  assert.ok(w.text.endsWith(NAV));
  assert.equal(w.selected, null);
});

test('piScreenDialog: selected is the LAST line starting with an arrow marker followed by a space, else null', () => {
  assert.equal(lib.piScreenDialog(screen('> one', 'two', '→ three', 'four', NAV)).selected, 2);
  assert.equal(lib.piScreenDialog(screen('→ one', '> two', 'three', NAV)).selected, 1);
  assert.equal(lib.piScreenDialog(screen('x', '   → indented', 'y', NAV)).selected, 1);
  assert.equal(lib.piScreenDialog(screen('→no space', '>>> deep', 'a → b', 'quote > here', NAV)).selected, null);
  assert.equal(lib.piScreenDialog(B_NO_ARROW).selected, null);
});

// ---------- 2. scanSessions ----------
test('scanSessions askAware: an asking session keeps its fields and gains dialog; a non-asking one has no dialog field', async () => {
  const f = fakeOrca({ screens: { t1: A, t2: IDLE, t3: WORKING } });
  const { sessions } = await scanSessions(repoDir, f.orca, undefined, false, true);
  const by = Object.fromEntries(sessions.map((s) => [s.handle, s]));
  assert.deepEqual(by.t1, { handle: 't1', state: 'asking', ask: lib.piScreenAsk(A).text, dialog: A_DIALOG });
  assert.deepEqual(by.t2, { handle: 't2', state: 'idle' });
  assert.deepEqual(by.t3, { handle: 't3', state: 'busy' });
  assert.deepEqual(f.sends(), []);
});

test('scanSessions with askAware false changes nothing: the asking screen is still busy, with no ask and no dialog', async () => {
  const f = fakeOrca({ screens: { t1: A } });
  assert.deepEqual((await scanSessions(repoDir, f.orca, undefined, false, false)).sessions, [{ handle: 't1', state: 'busy' }]);
  assert.deepEqual((await scanSessions(repoDir, f.orca)).sessions, [{ handle: 't1', state: 'busy' }]);
});

// ---------- 3. sessionsState ----------
test('sessionsState: dialog only when the state is waiting AND exactly one session is live; no call is a send', async () => {
  writeConfig();
  const one = fakeOrca({ screens: { t1: D } });
  const st = await S.sessionsState(REPO_ID, one.orca, sessionsBase);
  assert.deepEqual(st.live, { state: 'waiting', count: 1, dialog: D_DIALOG });
  assert.deepEqual(Object.keys(st).sort(), ['adopted', 'adoptedFound', 'key', 'live', 'sessions']);
  assert.deepEqual(one.calls.map((c) => c[0]).sort(), ['list', 'read', 'show']);
  assert.deepEqual(one.sends(), []);
});

test('sessionsState: free, working and none carry no dialog; two live sessions (one asking) are ambiguous, so no dialog', async () => {
  writeConfig();
  const live = async (screens) => { const f = fakeOrca({ screens }); const st = await S.sessionsState(REPO_ID, f.orca, sessionsBase); assert.deepEqual(f.sends(), []); return st.live; };
  assert.deepEqual(await live({ t1: IDLE }), { state: 'free', count: 1 });
  assert.deepEqual(await live({ t1: WORKING }), { state: 'working', count: 1 });
  assert.deepEqual(await live({}), { state: 'none', count: 0 });
  assert.deepEqual(await live({ t1: A, t2: IDLE }), { state: 'waiting', count: 2 });
  assert.deepEqual(await live({ t1: A, t2: D }), { state: 'waiting', count: 2 });
});

test('sessionsState: an Orca failure stays unknown with no dialog, and nothing is sent', async () => {
  writeConfig();
  const down = fakeOrca({ screens: { t1: A }, failList: true });
  assert.deepEqual((await S.sessionsState(REPO_ID, down.orca, sessionsBase)).live, { state: 'unknown', count: 0 });
  assert.deepEqual(down.sends(), []);
  const blind = fakeOrca({ screens: { t1: A }, failShow: true });
  assert.deepEqual((await S.sessionsState(REPO_ID, blind.orca, sessionsBase)).live, { state: 'unknown', count: 0 });
  assert.deepEqual(blind.sends(), []);
});

// ---------- 4. chatBody: the pinned card ----------
const info = (live, o = {}) => ({ key: 'r1', adopted: { id: 's1', name: 'panel:alpha' }, adoptedFound: true, sessions: [], live, ...o });
const HIST = { found: true, truncated: false, items: [{ role: 'user', text: 'hello there', at: null, tools: [] }, { role: 'assistant', text: 'Taking it.', at: null, tools: [] }] };
const body = (c) => R.chatBody({ id: 'r1', hist: HIST, ...c }, { now: Date.parse('2026-05-01T12:00:00Z') });
const dlg = (lines, selected) => ({ text: lines.join('\n'), lines, selected });
const cardOf = (html) => (/<div class="ch-ask" role="alert">[\s\S]*$/.exec(html) || [''])[0];
const TITLE = /class="ch-ask-title"[^>]*>The session is asking</;
const NOTE = /class="ch-ask-note"[^>]*>Answer it in the terminal of the session: the panel does not answer yet\.</;

test('chatBody: waiting with a dialog appends AFTER the bubbles one card with title, the lines (selected one in a mark) and the note', () => {
  const lines = ['Run a guarded command?', '→ Allow once', 'Allow for this session', 'Deny', NAV];
  const html = body({ info: info({ state: 'waiting', count: 1, dialog: dlg(lines, 1) }) });
  const card = cardOf(html);
  assert.notEqual(card, '');
  assert.equal((html.match(/class="ch-ask"/g) || []).length, 1);
  assert.ok(html.indexOf('hello there') < html.indexOf('class="ch-ask"') && html.indexOf('Taking it.') < html.indexOf('class="ch-ask"'));
  assert.match(card, TITLE);
  assert.match(card, NOTE);
  const pre = /<pre class="ch-ask-text">([\s\S]*?)<\/pre>/.exec(card);
  assert.ok(pre, 'a pre with the lines');
  assert.equal(pre[1], ['Run a guarded command?', '<mark class="ask-sel">→ Allow once</mark>', 'Allow for this session', 'Deny', R.esc(NAV)].join('\n'));
  assert.equal((card.match(/<mark/g) || []).length, 1);
});

test('chatBody: no selected line means no mark; waiting without a dialog shows the title and the note but no pre', () => {
  const plain = cardOf(body({ info: info({ state: 'waiting', count: 1, dialog: dlg(['Pick one', NAV], null) }) }));
  assert.match(plain, /<pre class="ch-ask-text">Pick one\n/);
  assert.doesNotMatch(plain, /<mark/);
  const bare = cardOf(body({ info: info({ state: 'waiting', count: 1 }) }));
  assert.match(bare, /^<div class="ch-ask" role="alert">/);
  assert.match(bare, TITLE);
  assert.match(bare, NOTE);
  assert.doesNotMatch(bare, /<pre|<mark/);
});

test('chatBody: any other state shows no card, even when a dialog is present', () => {
  for (const state of ['free', 'working', 'none', 'unknown']) {
    assert.doesNotMatch(body({ info: info({ state, count: 1, dialog: dlg(['x', NAV], null) }) }), /ch-ask/, state);
  }
  assert.doesNotMatch(body({ info: info({ state: 'free', count: 1 }) }), /ch-ask/);
});

test('chatBody: the card is also shown when there are no messages yet', () => {
  const html = body({ hist: { found: true, truncated: false, items: [] }, info: info({ state: 'waiting', count: 1, dialog: dlg(['Q?', NAV], null) }) });
  assert.match(html, /No messages yet/);
  assert.match(cardOf(html), TITLE);
});

test('chatBody: a hostile dialog never produces raw tags; the text appears escaped', () => {
  const lines = ['<script>alert(1)</script>', '→ <img src=x onerror=alert(1)>', 'say "hi" & \'bye\'', `<b>${'q'.repeat(200)}</b>`, NAV];
  const card = cardOf(body({ info: info({ state: 'waiting', count: 1, dialog: dlg(lines, 1) }) }));
  assert.notEqual(card, '');
  const tags = new Set([...card.matchAll(/<\/?([a-zA-Z][a-zA-Z0-9]*)/g)].map((m) => m[1].toLowerCase()));
  for (const t of tags) assert.ok(['div', 'span', 'pre', 'mark'].includes(t), `unexpected tag ${t}`);
  assert.doesNotMatch(card, /<script|<img|<b>/);
  assert.ok(card.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
  assert.ok(card.includes('<mark class="ask-sel">→ &lt;img src=x onerror=alert(1)&gt;</mark>'));
  assert.ok(card.includes('say &quot;hi&quot; &amp; &#39;bye&#39;'));
  assert.ok(card.includes(`&lt;b&gt;${'q'.repeat(200)}&lt;/b&gt;`));
});

// ---------- 7. the real fixtures end to end: screen -> dialog -> card ----------
test('fixtures A-E: dialog found, footer is the last line, selected points at the arrow, the card holds the escaped question', () => {
  for (const [name, screenText, question, footerLine, selected] of DIALOGS) {
    const d = lib.piScreenDialog(screenText);
    assert.notEqual(d, null, name);
    assert.equal(d.lines[d.lines.length - 1], footerLine, `${name}: footer last`);
    assert.equal(d.lines.includes(SEP), false, `${name}: separator dropped`);
    assert.equal(d.selected, selected, name);
    assert.ok(/^(→|>) /.test(d.lines[d.selected]), `${name}: arrow line`);
    assert.equal(d.lines[0], question, name);
    const card = cardOf(body({ info: info({ state: 'waiting', count: 1, dialog: d }) }));
    assert.ok(card.includes(R.esc(question)), `${name}: question in the card`);
    assert.ok(card.includes(`<mark class="ask-sel">${R.esc(d.lines[d.selected])}</mark>`), `${name}: marked line`);
  }
  assert.equal(lib.piScreenDialog(A).lines[2], '→ Yes');
  assert.equal(lib.piScreenDialog(D).lines[1], '→ Allow once');
  assert.equal(lib.piScreenDialog(E).lines[1], '→ 1. Review this change');
  assert.match(cardOf(body({ info: info({ state: 'waiting', count: 1, dialog: lib.piScreenDialog(A) }) })), /fetch origin --prune &amp;&amp; git log/);
  assert.equal(lib.piScreenDialog(B_NO_ARROW).selected, null);
  assert.equal(lib.piScreenDialog(B_NO_ARROW).lines.at(-1), FOOT_B);
});

// ---------- 5. the page ----------
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
  return { ctx, get, tick, fetches, intervals, run: (code) => vm.runInContext(code, ctx) };
}
const row = (o = {}) => ({
  id: 'r1', name: 'alpha', group: 'G', room: null, branch: 'main', progress: { total: 4, completada: 1, enRevision: 0, bloqueada: 0, pendiente: 3, enCurso: 0 }, session: { state: 'free' },
  next: null, blocking: [], lastMovement: { at: '2026-05-01T11:48:00Z', what: 'x' }, action: null, error: null, needs: false, rank: 9, ...o,
});
const seed = (page) => {
  const S2 = page.run('S');
  S2.groups = [{ name: 'G', repos: [{ id: 'abc', name: 'demo', path: 'p' }] }];
  S2.summary = { rows: [row({ id: 'abc', name: 'demo' })], generatedAt: 'x' };
};

test('page: the card appears with the dialog, disappears when the next poll has none, #sessState is unchanged, and nothing is POSTed', async () => {
  let live = { state: 'waiting', count: 1, dialog: D_DIALOG };
  const sessions = () => ({ key: 'abc', adopted: { id: 's1', name: 'panel:demo', adoptedAt: 'x' }, adoptedFound: true, sessions: [], live });
  const histAnswer = { key: 'abc', sessionId: 's1', found: true, items: [{ role: 'user', text: 'hello there', at: null, tools: [] }], truncated: false, updatedAt: null };
  const page = loadPage({ answers: { '/api/sessions': () => Promise.resolve({ ok: true, json: async () => sessions() }), '/api/chat': histAnswer } });
  seed(page);
  page.run("ACTIONS['chat-open']({ dataset: { id: 'abc' } })");
  await page.tick();
  const html = page.get('#chatBody').html;
  assert.match(html, /hello there/);
  assert.match(cardOf(html), TITLE);
  assert.match(cardOf(html), /<mark class="ask-sel">→ Allow once<\/mark>/);
  assert.match(page.get('#sessState').html, /asking you something/);
  live = { state: 'free', count: 1 };
  page.intervals.find((i) => i.ms === 5000).fn();
  await page.tick();
  assert.doesNotMatch(page.get('#chatBody').html, /ch-ask/);
  assert.match(page.get('#chatBody').html, /hello there/);
  assert.match(page.get('#sessState').html, /free/);
  assert.ok(page.fetches.length >= 4, 'it did poll');
  // The board POSTs its own read-only queries (/api/queue, /api/conformity); what must never happen is an order or a message to a session.
  assert.deepEqual(page.fetches.filter((f) => /^\/api\/(pi|chat\/send|chat\/clear)\b/.test(String(f.url))), []);
});

// ---------- 6. safety source guard ----------
test('safety: the new function and the chat card code never reference send, orca or key bytes', () => {
  assert.equal(typeof lib.piScreenDialog, 'function');
  const src = lib.piScreenDialog.toString();
  assert.doesNotMatch(src, /send/i);
  assert.doesNotMatch(src, /orca/i);
  assert.equal(src.includes('\\x1b'), false);
  assert.equal(src.includes('\u001b'), false);
  const chat = R.chatBody.toString();
  assert.match(chat, /ch-ask/);
  assert.doesNotMatch(chat, /send|orca|\/api\/pi|\\x1b/i);
  const app = fs.readFileSync(path.join(PUBLIC, 'app.js'), 'utf8');
  const region = app.slice(app.indexOf('// ---------- chat (RP54)'), app.indexOf('// ---------- end chat ----------'));
  assert.ok(region.length > 500);
  assert.doesNotMatch(region, /\/api\/pi|piSend|\bsend\b|'send'/);
});
