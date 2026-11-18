'use strict';
// RP191 (S22): the reason Merge is off is no longer written under the buttons (it took a line and deformed the field). The foot draws only the Merge button; a hold reason (the session or a command is busy)
// is shown nowhere (the state on the left says it and the buttons keep their titles); the reason of the PR itself goes INSIDE the message field, muted, as its placeholder.
// Fakes only: the page is built in `vm`, the sources and the stylesheet are read as text.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { appSource } = require('./pagesrc.js');
const lib = require('../lib.js');
const V = require('../public/view.js');
const R = require('../public/resumen.js');

const PUBLIC = path.join(__dirname, '..', 'public');
const read = (f) => fs.readFileSync(path.join(PUBLIC, f), 'utf8').replace(/\r\n/g, '\n');
const css = read('style.css');
const TAIL = ' Method: squash. Change it in Settings, Delivery.';
const OFF = (title, over = {}) => ({ enabled: false, label: 'Merge · squash', title, ...over });

// ---------- the pure helper ----------
test('n1: mergeNote is exported with the others and gives the reason of the PR: the title without the tail and without the final period', () => {
  assert.equal(typeof V.mergeNote, 'function');
  assert.equal(V.mergeNote(OFF(`Not ready to merge.${TAIL}`), false), 'Not ready to merge');
  assert.equal(V.mergeNote(OFF(`Checks failed (test).${TAIL}`)), 'Checks failed (test)');
  assert.equal(V.mergeNote(OFF('No reason with a tail.')), 'No reason with a tail');
  assert.equal(V.mergeNote(OFF('  Spaces around  ')), 'Spaces around');
  assert.equal(V.mergeNote(V.mergeButton({ ready: false, blockedReason: 'Checks pending' }, { method: 'rebase' }), false), 'Checks pending');
  assert.equal(V.mergeNote(V.mergeButton({ ready: false }, {}), false), 'Not ready to merge');
});

test('n2: no note when held, when enabled, when merging or merged, or without a title', () => {
  const t = `Not ready to merge.${TAIL}`;
  assert.equal(V.mergeNote(OFF(t), true), '');
  assert.equal(V.mergeNote(OFF(t), 'Running /flow-ship'), '');
  assert.equal(V.mergeNote({ enabled: true, label: 'Merge · squash', title: `Merge into main.${TAIL}` }, false), '');
  assert.equal(V.mergeNote(OFF(t, { label: 'Merging…' }), false), '');
  assert.equal(V.mergeNote(OFF(t, { label: 'Merged ✓' }), false), '');
  assert.equal(V.mergeNote(OFF(''), false), '');
  assert.equal(V.mergeNote(OFF(5), false), '');
  assert.equal(V.mergeNote(OFF(`.${TAIL}`), false), '');
});

test('n3: clipped to 60 characters with a final …; exactly 60 is not clipped', () => {
  const sixty = 'x'.repeat(60);
  assert.equal(V.mergeNote(OFF(`${sixty}.${TAIL}`)), sixty);
  const out = V.mergeNote(OFF(`${'y'.repeat(61)}.${TAIL}`));
  assert.equal(out.length, 60);
  assert.equal(out, `${'y'.repeat(59)}…`);
  assert.equal(V.mergeNote(OFF('z'.repeat(500))).length, 60);
});

test('n4: total: anything that is not an object gives an empty string and never throws', () => {
  const hostile = { enabled: false, label: 'Merge · squash', title: { toString() { throw new Error('boom'); } } };
  for (const bad of [null, undefined, 5, 'x', [], {}, true, () => 1, { enabled: false }, { enabled: false, label: 5, title: 'x' }, hostile]) assert.equal(V.mergeNote(bad, false), '', String(bad));
  assert.equal(V.mergeNote(OFF('<img src=x onerror=1>. Method: x. y'), false), '<img src=x onerror=1>', 'text only: the placeholder is an attribute, never markup');
  assert.equal(V.mergeNote(), '');
});

test('n5: mergeWhy keeps working as it is', () => {
  const b = V.mergeButton({ ready: false, blockedReason: 'Checks pending' }, { method: 'squash' });
  assert.equal(V.mergeWhy(b), b.title);
});

// ---------- the foot draws only the button ----------
test('f1: an off Merge draws the button (same markup, title and disabled) and NO reason line, whatever `why` says', () => {
  const g = { id: 'r1', pr: { number: 7 }, merge: { enabled: false, label: 'Merge · squash', title: 't', why: 'checks running', held: false } };
  assert.equal(R.composerMergeHtml(g), '<button type="button" class="c-act merge" data-act="merge" data-id="r1" data-n="7" disabled title="t">Merge · squash</button>');
  assert.doesNotMatch(R.composerMergeHtml(g), /c-why|status/);
  assert.equal(R.composerMergeHtml({ id: 'r1', pr: { number: 7 }, merge: { enabled: true, label: 'Merge · squash', title: 'go', why: '' } }), '<button type="button" class="c-act merge" data-act="merge" data-id="r1" data-n="7" title="go">Merge · squash</button>');
});

test('f2: with no PR the foot still draws nothing', () => {
  for (const g of [null, undefined, 5, [], {}, { id: 'a', pr: null, merge: OFF('x') }, { id: 'a', pr: { number: 0 } }]) assert.equal(R.composerMergeHtml(g), '', JSON.stringify(g));
});

// ---------- the page ----------
function element(extra = {}) {
  const el = {
    writes: 0, html: '', hidden: false, dataset: {}, disabled: false, value: '', checked: false, textContent: '', title: '', placeholder: '', attrs: {}, listeners: {}, children: [], open: false, focused: 0,
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    style: { setProperty(k, v) { el.style[k] = v; } },
    addEventListener(t, fn) { (el.listeners[t] ||= []).push(fn); }, setAttribute(k, v) { el.attrs[k] = v; }, querySelector: () => null, querySelectorAll: () => [], closest: () => null,
    showModal() {}, close() {}, focus() { el.focused++; }, append(c) { el.children.push(c); },
    get innerHTML() { return el.html; },
    set innerHTML(v) { el.html = String(v); el.writes++; },
    ...extra,
  };
  return el;
}
function loadPage() {
  const els = {};
  const frames = [];
  const docL = {};
  const tabEls = ['summary', 'work', 'conformity'].map((t) => element({ dataset: { tab: t } }));
  const get = (sel) => (els[sel] ||= (sel === 'meta[name=token]' ? element({ content: 'token' }) : element()));
  const doc = { hidden: false, querySelector: get, querySelectorAll: (s) => (String(s).includes('data-tab') ? tabEls : []), addEventListener(t, fn) { (docL[t] ||= []).push(fn); }, createElement: () => element(), body: element(), activeElement: null };
  const ctx = vm.createContext({
    console, document: doc, location: { hash: '' },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    requestAnimationFrame: (cb) => { frames.push(cb); return frames.length; },
    setInterval: () => 0, setTimeout: () => 0, clearTimeout: () => {}, AbortController, confirm: () => true,
    fetch: () => new Promise(() => {}),
  });
  ctx.window = ctx;
  ctx.addEventListener = () => {};
  ctx.RepoPanelView = V;
  ctx.RepoPanelResumen = R;
  vm.runInContext(appSource(), ctx);
  const flush = () => { while (frames.length) frames.shift()(); };
  const tick = async (n = 8) => { for (let r = 0; r < 2; r++) { for (let i = 0; i < n; i++) await new Promise((x) => setImmediate(x)); flush(); } };
  return { get, flush, tick, run: (c) => vm.runInContext(c, ctx) };
}
const RUN = (name, over = {}) => ({ __typename: 'CheckRun', name, status: 'COMPLETED', conclusion: 'SUCCESS', detailsUrl: `https://github.com/o/r/actions/runs/${name.length}1`, ...over });
const GH = (over = {}) => ({ number: 7, title: 't', url: 'https://github.com/o/r/pull/7', headRefName: 'feat/x', baseRefName: 'main', headRefOid: 'abc123', isDraft: false, isCrossRepository: false, author: { login: 'me' }, reviewDecision: null, mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', additions: 1, deletions: 0, changedFiles: 1, statusCheckRollup: [RUN('build')], ...over });
const READY = lib.enrichPr(GH());
const FAILED = lib.enrichPr(GH({ statusCheckRollup: [RUN('build'), RUN('test', { conclusion: 'FAILURE' })] }));
const card = (id, name) => ({ id, name, group: 'G', room: null, branch: 'main', progress: { total: 4, completada: 1, enRevision: 0, bloqueada: 0, pendiente: 3, enCurso: 0 }, session: { state: 'free' }, next: null, blocking: [], lastMovement: {}, action: null, needs: false, rank: 9 });
async function boot({ pr = FAILED, adopted = true, rpc = 'idle' } = {}) {
  const page = loadPage();
  const S = page.run('S');
  S.groups = [{ name: 'G', repos: [{ id: 'abc', name: 'demo', path: 'p' }] }];
  S.summary = { rows: [card('abc', 'demo')], generatedAt: 'x' };
  S.local.abc = { branch: 'feat/x', ahead: 2, files: [] };
  S.prs.abc = { prs: [pr] };
  page.run("ACTIONS['chat-open']({ dataset: { id: 'abc' } })");
  await page.tick();
  S.chat.info = { adopted: adopted ? { id: 's1', name: 'x' } : null, adoptedFound: adopted, sessions: [], live: { state: 'free', count: 1 } };
  S.rpc.abc = { state: rpc };
  page.run('draw()');
  page.flush();
  return page;
}
const box = (page) => page.get('#msgBox').placeholder;

test('p1: adopted and idle, PR not ready: the placeholder is the reason of the PR, and the foot has no reason line', async () => {
  const page = await boot();
  assert.equal(box(page), V.mergeNote(V.mergeButton(FAILED, { method: 'squash' }), false));
  assert.notEqual(box(page), '');
  assert.notEqual(box(page), 'Message…');
  assert.doesNotMatch(page.get('#chatActions').html, /c-why/);
  assert.match(page.get('#chatActions').html, /data-act="merge"[^>]* disabled /);
});

test('p2: PR ready: the placeholder is «Message…»', async () => {
  const page = await boot({ pr: READY });
  assert.equal(box(page), 'Message…');
});

test('p3: a hold shows no note: a command running in the session (and a busy session) leave the plain placeholder', async () => {
  const page = await boot();
  page.run("S.sending.abc = 'flow-commit'");
  page.run('draw()');
  page.flush();
  assert.equal(box(page), 'Message…');
  assert.doesNotMatch(page.get('#chatActions').html, /c-why/);
  assert.match(page.get('#chatActions').html, /title="Running /);
  const busy = await boot({ rpc: 'busy' });
  assert.equal(box(busy), 'Correct the agent, or queue a message for later…'); // RP236: a working session takes a correction; still no merge note
  const asking = await boot({ rpc: 'asking' });
  assert.equal(box(asking), '');
});

test('p4: no adopted session: «Start a session to write», never the note', async () => {
  const page = await boot({ adopted: false });
  assert.equal(box(page), 'Start a session to write');
});

test('p5: once the PR is ready again the placeholder goes back to «Message…»', async () => {
  const page = await boot();
  page.run(`S.prs.abc = { prs: [${JSON.stringify(READY)}] }`);
  page.run('draw()');
  page.flush();
  assert.equal(box(page), 'Message…');
});

// ---------- the code and the stylesheet ----------
test('s1: the stylesheet has no .c-why rule and the placeholder is muted and soft with tokens only', () => {
  assert.doesNotMatch(css, /\.c-why/);
  const m = /\.composer textarea::placeholder \{([^}]*)\}/.exec(css);
  assert.ok(m, 'a rule for the placeholder of the composer');
  assert.match(m[1], /color:\s*var\(--muted\)/);
  assert.match(m[1], /opacity:\s*1/);
  assert.doesNotMatch(m[1], /#|rgb/);
});

test('s2: no code writes c-why any more; the chat tells the helper whether the reason is a hold', () => {
  assert.doesNotMatch(read('resumen.js'), /c-why/);
  assert.doesNotMatch(read('chat.js'), /c-why/);
  assert.match(read('chat.js'), /held: !!ctx\.hold/);
  assert.match(read('chat.js'), /V\.mergeNote\(/);
});

test('p6: with no PR the placeholder stays «Message…»: Merge is not drawn, so its «No open pull request…» title is no reason to write in the field', async () => {
  const page = await boot();
  const S = page.run('S');
  S.prs.abc = { prs: [] };
  page.run('draw()');
  page.flush();
  assert.equal(page.get('#chatActions').html.includes('data-act="merge"'), false, 'no Merge button without a PR');
  assert.equal(box(page), 'Message…');
});
