'use strict';
// RP170 (13 November, asked by the person): while the session is IDLE and the PR of the CURRENT branch has checks running, the state label of the chat reads «Verifying Checks · 2 running · 2/4» with the turning icon of the
// CI (red «Checks Failed · 1 failed · 3/4», no animation, when they failed). The card of the Summary list does NOT get this state (its PR line already says it): there the PR chip only swaps the dots «…» for the same turning icon.
// The CI only shows: it never holds or releases a button. Fakes only: no server, no GitHub, no session.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const V = require('../public/view.js');
const R = require('../public/resumen.js');
const { appSource } = require('./pagesrc.js');

const read = (f) => fs.readFileSync(path.join(__dirname, '..', 'public', f), 'utf8').replace(/\r\n/g, '\n');
const css = read('style.css');
const chatJs = read('chat.js');
const PR = (checks, extra = {}) => ({ number: 7, title: 'the title', head: 'feat/x', checks, ...extra });
const RUN = { state: 'pending', items: [], total: 4, passed: 2, pending: 2, failed: 0 };
const BAD = { state: 'failed', items: [], total: 4, passed: 3, pending: 0, failed: 1 };
const OK = { state: 'success', items: [], total: 4, passed: 4, pending: 0, failed: 0 };
const NONE = { state: 'none', items: [], total: 0, passed: 0, pending: 0, failed: 0 };
const live = (rpc, ci) => R.sessionLabelHtml({ info: true, rpc, ...(ci === undefined ? {} : { ci }) });
const IDLE = { state: 'idle' };
const ci = (pr) => V.ciOf(pr);
const words = (html) => html.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
const SPIN = /<svg [^>]*><circle cx="8" cy="8" r="6" stroke-dasharray="3 2\.2"\/><\/svg>/;

// ---------- abuse first: hostile numbers ----------
test('a1: hostile numbers in checks never render NaN, undefined, Infinity, e+ or [object, and become 0', () => {
  const bad = [NaN, Infinity, -Infinity, -3, 'x', '5', null, undefined, {}, [], 1e308, true, 2 ** 60];
  for (const v of bad) {
    const c = { state: 'pending', total: v, passed: v, pending: v, failed: v };
    const o = ci(PR(c));
    assert.deepEqual(o && [o.pending, o.failed, o.passed, o.total], [0, 0, 0, 0], String(v));
    const label = live(IDLE, o);
    assert.equal(words(label), 'Verifying Checks · 0 running · 0/0', String(v));
    assert.doesNotMatch(label, /NaN|undefined|Infinity|e\+|\[object/, String(v));
    assert.doesNotMatch(V.prChip([PR(c)]), /NaN|undefined|Infinity|e\+|\[object/, String(v));
    const f = ci(PR({ ...c, state: 'failed' }));
    assert.doesNotMatch(live(IDLE, f), /NaN|undefined|Infinity|e\+|\[object/, String(v));
  }
  assert.equal(ci(PR({ state: 'pending', total: 4.9, passed: 2.5, pending: 1.2, failed: 0 })).total, 4, 'a float is floored, as in the chip');
});

test('a2: ciOf is total: not an object, no number, no checks, an unknown state', () => {
  for (const v of [null, undefined, 5, 'x', [], true, () => 1]) assert.equal(ci(v), null, String(v));
  assert.equal(ci({ head: 'feat/x', checks: RUN }), null, 'no number');
  assert.equal(ci({ number: NaN, checks: RUN }), null);
  assert.equal(ci({ number: 7 }), null, 'checks missing');
  for (const checks of [null, 5, 'x', [], { state: 'weird', pending: 2, total: 4 }, { state: 5 }, {}]) assert.equal(ci(PR(checks)), null, JSON.stringify(checks));
});

test('a3: only a running or a failed CI is a CI: passed and no checks are null', () => {
  assert.equal(ci(PR(OK)), null);
  assert.equal(ci(PR(NONE)), null);
  assert.deepEqual(ci(PR(RUN)), { kind: 'running', pending: 2, failed: 0, passed: 2, total: 4, number: 7 });
  assert.deepEqual(ci(PR(BAD)), { kind: 'failed', pending: 0, failed: 1, passed: 3, total: 4, number: 7 });
});

// ---------- abuse first: never over another session state ----------
const BUSY_STATES = [
  ['asking', { info: true, rpc: { state: 'asking' } }], ['compacting', { info: true, rpc: { state: 'idle', compacting: true } }], ['starting', { info: true, rpc: { state: 'starting' } }],
  ['working', { info: true, rpc: { state: 'busy' } }], ['closed', { info: true, rpc: { state: 'closed' } }], ['loading', { rpc: IDLE }], ['unknown', { info: true }], ['unknown rpc', { info: true, rpc: { state: 'zzz' } }],
];
test('a4: a running or failed CI over any state but idle changes nothing: the label equals today\'s', () => {
  for (const [name, c] of BUSY_STATES) {
    for (const o of [ci(PR(RUN)), ci(PR(BAD))]) {
      assert.equal(R.sessionLabelHtml({ ...c, ci: o }), R.sessionLabelHtml(c), name);
      assert.doesNotMatch(R.sessionLabelHtml({ ...c, ci: o }), /Verifying|Checks Failed/, name);
    }
  }
});

test('a5: a hostile `ci` input (not from ciOf) never breaks the label or injects markup', () => {
  for (const x of [null, undefined, 5, 'x', [], {}, { kind: 'zzz' }, { kind: 'running' }, { kind: '<b>', number: 1 }]) assert.equal(live(IDLE, x), live(IDLE), JSON.stringify(x));
  const h = live(IDLE, { kind: 'running', number: '<img src=x>', pending: '<i>', passed: NaN, total: Infinity, failed: -1 });
  assert.doesNotMatch(h, /<img|<i>|NaN|Infinity/);
});

// ---------- the chat label ----------
test('c1: running: text, tone, spinner, title, animation class', () => {
  const h = live(IDLE, ci(PR(RUN)));
  assert.equal(words(h), 'Verifying Checks · 2 running · 2/4');
  assert.match(h, /^<span class="ss ss-yellow ss-ci ss-anim" role="status" title="PR #7: the checks are running \(2 running, 2 of 4 passed\)">/);
  assert.match(h, /<i class="ss-dot" aria-hidden="true"><svg /);
  assert.match(h, SPIN);
  assert.match(h, /<span class="ss-word">Verifying Checks<\/span>/);
});

test('c2: failed: red, a cross, NO animation, the exact text', () => {
  const h = live(IDLE, ci(PR(BAD)));
  assert.equal(words(h), 'Checks Failed · 1 failed · 3/4');
  assert.match(h, /^<span class="ss ss-red ss-ci" role="status" title="PR #7: the checks failed \(1 failed, 3 of 4 passed\)">/);
  assert.doesNotMatch(h, /ss-anim|stroke-dasharray/);
  assert.match(h, /<path d="M6 6l4 4M10 6l-4 4"\/>/);
  assert.match(h, /<span class="ss-word">Checks Failed<\/span>/);
});

test('c3: the numbers are in their own span OUTSIDE ss-word, and the narrow-chat rule hides ss-word only', () => {
  for (const o of [ci(PR(RUN)), ci(PR(BAD))]) {
    const h = live(IDLE, o);
    assert.match(h, /<span class="ss-word">[^<]*<\/span><span class="ss-n"> · \d+ (running|failed) · \d+\/\d+<\/span><\/span>$/);
    assert.doesNotMatch(h, /<span class="ss-word">[^<]*·/, 'no number inside ss-word');
  }
  const block = /@container cmp \(max-width: 456px\) \{([^}]*)\}/.exec(css);
  assert.ok(block, 'the RP156 block');
  assert.match(block[1], /\.ss-word/);
  assert.doesNotMatch(block[1], /\.ss-n\b|\.ss-ci/);
});

test('c4: passed, no checks and no CI show the normal Idle, identical to today', () => {
  const idle = live(IDLE);
  for (const o of [ci(PR(OK)), ci(PR(NONE)), ci(PR({})), null, undefined]) assert.equal(live(IDLE, o), idle);
  assert.match(idle, /ss-word">Idle</);
});

test('c5: without `ci` the label is byte for byte what it was before RP170 (frozen)', () => {
  const cases = { loading: {}, unknown: { info: true }, none: { info: true, rpc: { state: 'closed' } }, starting: { info: true, rpc: { state: 'starting' } }, free: { info: true, rpc: IDLE },
    working: { info: true, rpc: { state: 'busy' } }, compacting: { info: true, rpc: { state: 'idle', compacting: true } }, waiting: { info: true, rpc: { state: 'asking' } } };
  for (const [k, c] of Object.entries(cases)) assert.equal(R.sessionLabelHtml(c), FROZEN[k], k);
});

test('c6: the label and the chip read the same numbers (ciOf), whatever the checks hold', () => {
  for (const c of [RUN, { state: 'pending', total: 9, passed: 1, pending: 8, failed: 0 }, { state: 'pending', total: NaN, passed: -1, pending: 2.9, failed: 0 }]) {
    const o = ci(PR(c));
    assert.ok(words(live(IDLE, o)).endsWith(` · ${o.pending} running · ${o.passed}/${o.total}`));
    assert.ok(words(V.prChip([PR(c)])).endsWith(`${o.pending} running`));
    assert.ok(V.prChip([PR(c)]).includes(`${o.pending} running · ${o.passed}/${o.total} checks`), 'the title of the chip too');
  }
});

// ---------- CSS ----------
const rule = (sel) => { const m = new RegExp(`(?:^|\\n)${sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`).exec(css); assert.ok(m, `a rule for ${sel}`); return m[1]; };
test('d1: the icon of the label turns with ck-spin (linear, endless, 1.4 s like the CI spinner); the failed label has no animation', () => {
  assert.match(rule('.ss-ci.ss-anim .ss-dot'), /animation:\s*ck-spin\s+1\.4s\s+linear\s+infinite/);
  assert.match(rule('.ss-red'), /color:\s*var\(--red\)/);
  assert.doesNotMatch(css, /\.ss-ci[^{,\n]*failed[^{]*\{[^}]*animation/);
  assert.match(css, /@keyframes ck-spin/);
});

test('d2: reduced motion stops the chat label and the icon of the card\'s PR line', () => {
  const blocks = [...css.matchAll(/@media \(prefers-reduced-motion: reduce\) \{([^]*?)\n\}|@media \(prefers-reduced-motion: reduce\) \{([^\n]*)\}/g)].map((m) => m[1] || m[2]).join('\n');
  assert.match(blocks, /\.ss-ci\.ss-anim \.ss-dot \{ animation: none; \}/);
  assert.match(blocks, /\.chip > i\[aria-hidden="true"\] svg \{ animation: none; \}/);
  assert.match(rule('.chip > i[aria-hidden="true"] svg'), /animation:\s*ck-spin\s+1\.4s\s+linear\s+infinite/);
});

test('d3: the animation class exists only on the running label', () => {
  assert.match(live(IDLE, ci(PR(RUN))), /ss-anim/);
  for (const o of [ci(PR(BAD)), ci(PR(OK)), null]) assert.doesNotMatch(live(IDLE, o), /ss-anim/);
});

// ---------- the card ----------
const stripTags = (h) => h.replace(/<[^>]*>/g, '');
test('k1: the PR chip pending (one PR, several PRs) starts with the spinner icon and has no dots; the colour, counts and title stay', () => {
  const one = V.prChip([PR(RUN)]);
  assert.match(one, /^<span class="chip yellow" title="#7 the title — … 2 running · 2\/4 checks">PR #7 <i aria-hidden="true"><svg [^]*<\/svg><\/i>2 running<\/span>$/);
  assert.match(one, SPIN);
  assert.equal(stripTags(one.replace(/title="[^"]*"/, '')), 'PR #7 2 running');
  const many = V.prChip([PR(OK), PR(RUN, { number: 9 })]);
  assert.match(many, /^<span class="chip yellow" title="[^"]*">2 PRs <i aria-hidden="true"><svg [^]*<\/svg><\/i>1 running<\/span>$/);
  assert.equal(stripTags(many.replace(/title="[^"]*"/, '')), '2 PRs 1 running');
  for (const h of [one, many]) assert.doesNotMatch(h.replace(/title="[^"]*"/, ''), /…/, 'no dots in the text');
});

test('k2: failed, passed and no checks are unchanged byte for byte', () => {
  assert.equal(V.prChip([PR(BAD)]), '<span class="chip red" title="#7 the title — ✘ 1 failed · 3/4 checks">PR #7 ✘ 1 failed</span>');
  assert.equal(V.prChip([PR(OK)]), '<span class="chip green" title="#7 the title — ✔ 4/4 checks">PR #7 ✔ 4/4</span>');
  assert.equal(V.prChip([PR(NONE)]), '<span class="chip gray" title="#7 the title — no checks">PR #7 · no checks</span>');
  assert.equal(V.prChip([PR(OK), PR(BAD, { number: 8 })]).includes('2 PRs ✘ 1 failing'), true);
  assert.equal(V.prChip([PR(OK), PR(OK, { number: 8 })]).endsWith('2 PRs ✔ all passing</span>'), true);
});

test('k3: the title of the chip is still escaped and the text can never inject markup', () => {
  const h = V.prChip([PR(RUN, { title: '<img src=x onerror=1>"&' })]);
  assert.doesNotMatch(h, /<img/);
  assert.match(h, /title="#7 &lt;img src=x onerror=1&gt;&quot;&amp; — … 2 running · 2\/4 checks"/);
  assert.equal(typeof h, 'string');
});

test('k4: the session chip of the card is byte for byte the same with or without a CI in the row', () => {
  const base = { id: 'r1', name: 'a', group: 'G', room: null, branch: 'feat/x', progress: { total: 1, completada: 0, enRevision: 0, bloqueada: 0, pendiente: 1, enCurso: 0 }, session: { state: 'free' },
    next: null, blocking: [], lastMovement: { at: '2026-05-01T11:48:00Z', what: 'x' }, action: null, error: null };
  const view = (row, ctx = {}) => R.summaryView({ rows: [row], counts: {}, attention: [], generatedAt: 'x' }, { now: Date.parse('2026-05-01T12:00:00Z'), scope: { kind: 'all' }, rooms: [], ...ctx });
  const chip = (h) => (/<span class="ss [^]*?<\/i> <span class="ss-word">[^<]*<\/span><\/span>/.exec(h) || [''])[0];
  const prs = { r1: { prs: [PR(RUN)] } };
  const plain = chip(view(base));
  assert.ok(plain.includes('ss-free'));
  for (const ctx of [{ prsFor: (id) => prs[id] }, { prs }, { ci: ci(PR(RUN)) }]) assert.equal(chip(view({ ...base, ci: ci(PR(RUN)), prs: [PR(RUN)] }, ctx)), plain);
  assert.equal(chip(view({ ...base, ci: ci(PR(BAD)) })), plain);
  assert.doesNotMatch(plain, /Verifying|Checks Failed/);
});

// ---------- the page ----------
test('w1: chat.js gives the label the CI of the PR of the current branch, through ciOf', () => {
  assert.match(chatJs, /R\.sessionLabelHtml\(\{ \.\.\.shown, ci: [^}]*ciOf\(columnGit\(S\.chat\.id, facts\)\.pr\)/);
  const src = read('resumen.js');
  const at = src.indexOf('function sessionChip');
  assert.doesNotMatch(src.slice(at, src.indexOf('\n  }\n', at)), /\bci\b/, 'the card chip is called without ci');
});

const A = 'abcdef0123';
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
const CONFIG = { groups: [{ name: 'G', repos: [{ id: A, name: 'repo-a', path: 'p-a' }] }], snoozed: [], dismissed: [], rooms: [], roomIssues: [] };
async function boot() {
  const els = {};
  const frames = [];
  const loc = { hash: '', pathname: '/panel/', search: '' };
  const hist = { pushState() {}, replaceState() {}, back() {} };
  const tabEls = ['summary', 'work', 'conformity', 'settings'].map((t) => element({ dataset: { tab: t } }));
  const get = (sel) => (els[sel] ||= (sel === 'meta[name=token]' ? element({ content: 'token' }) : element()));
  get('#sumLayout').clientWidth = 1400;
  const doc = { hidden: false, querySelector: get, querySelectorAll: (s) => (String(s).includes('data-tab') ? tabEls : []), addEventListener() {}, createElement: () => element(), body: element(), activeElement: null };
  const sandbox = {
    console, document: doc, TextDecoder, AbortController, confirm: () => true, location: loc, history: hist,
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    requestAnimationFrame: (cb) => { frames.push(cb); return frames.length; }, setInterval: () => 0, setTimeout: () => 0, clearTimeout: () => {}, clearInterval: () => {},
    fetch: (url) => (String(url).startsWith('/api/config') ? Promise.resolve({ ok: true, json: async () => CONFIG }) : new Promise(() => {})),
  };
  const ctx = vm.createContext(sandbox);
  ctx.window = ctx;
  ctx.addEventListener = () => {};
  ctx.RepoPanelView = V;
  ctx.RepoPanelResumen = R;
  vm.runInContext(appSource(), ctx);
  const tick = async (n = 10) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); while (frames.length) frames.shift()(); };
  await tick();
  const run = (code) => vm.runInContext(code, ctx);
  run(`ACTIONS['chat-open']({ dataset: { id: ${JSON.stringify(A)} } })`);
  await tick();
  return {
    state: () => get('#sessState').html,
    set: async ({ rpc, branch = 'feat/x', prs }) => {
      run(`S.chat.info = { adopted: null, adoptedFound: true, sessions: [] }; S.rpc[${JSON.stringify(A)}] = ${JSON.stringify(rpc)}; S.local[${JSON.stringify(A)}] = ${JSON.stringify({ branch, ahead: 0, files: [], error: null })}; S.prs[${JSON.stringify(A)}] = ${JSON.stringify({ prs })}; draw();`);
      await tick();
    },
  };
}
test('w2: page: idle + a running PR of the current branch reads Verifying Checks; another branch, another state, passed or none read as today', async () => {
  const page = await boot();
  await page.set({ rpc: IDLE, prs: [PR(RUN)] });
  assert.equal(words(page.state()).startsWith('Verifying Checks · 2 running · 2/4'), true, page.state());
  await page.set({ rpc: IDLE, prs: [PR(RUN, { head: 'feat/other' })] });
  assert.match(page.state(), /ss-word">Idle</);
  await page.set({ rpc: IDLE, prs: [PR(RUN, { head: 'feat/other', number: 3 }), PR(BAD, { number: 9 })] });
  assert.equal(words(page.state()).startsWith('Checks Failed · 1 failed · 3/4'), true, 'only the PR of the current branch counts');
  assert.match(page.state(), /title="PR #9: the checks failed/);
  await page.set({ rpc: { state: 'busy' }, prs: [PR(RUN)] });
  assert.match(page.state(), /Working…/);
  assert.doesNotMatch(page.state(), /Verifying/);
  await page.set({ rpc: IDLE, prs: [PR(OK)] });
  assert.match(page.state(), /ss-word">Idle</);
  await page.set({ rpc: IDLE, prs: [PR(NONE)] });
  assert.match(page.state(), /ss-word">Idle</);
  await page.set({ rpc: IDLE, branch: '', prs: [PR(RUN, { head: '' })] });
  assert.match(page.state(), /ss-word">Idle</);
});

// ---------- the label of today, frozen before RP170 ----------
const FROZEN = {
  loading: "<span class=\"ss ss-gray ss-loading\" role=\"status\" title=\"Loading the session\"><i class=\"ss-dot\" aria-hidden=\"true\"><svg width=\"14\" height=\"14\" viewBox=\"0 0 16 16\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.5\" stroke-linecap=\"round\" stroke-linejoin=\"round\" aria-hidden=\"true\"><circle cx=\"3.5\" cy=\"8\" r=\"1.2\" fill=\"currentColor\" stroke=\"none\"/><circle cx=\"8\" cy=\"8\" r=\"1.2\" fill=\"currentColor\" stroke=\"none\"/><circle cx=\"12.5\" cy=\"8\" r=\"1.2\" fill=\"currentColor\" stroke=\"none\"/></svg></i> <span class=\"ss-word\">Loading…</span></span>",
  unknown: "<span class=\"ss ss-gray ss-unknown\" role=\"status\" title=\"The session state is unknown\"><i class=\"ss-dot\" aria-hidden=\"true\"><svg width=\"14\" height=\"14\" viewBox=\"0 0 16 16\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.5\" stroke-linecap=\"round\" stroke-linejoin=\"round\" aria-hidden=\"true\"><circle cx=\"8\" cy=\"8\" r=\"5.5\"/><path d=\"M6.4 6.4a1.7 1.7 0 1 1 2.5 1.5c-.6.4-.9.7-.9 1.3\"/><circle cx=\"8\" cy=\"11.2\" r=\".5\" fill=\"currentColor\" stroke=\"none\"/></svg></i> <span class=\"ss-word\">Unknown</span></span>",
  none: "<span class=\"ss ss-gray ss-none\" role=\"status\" title=\"The session is not started: sending a message starts it\"><i class=\"ss-dot\" aria-hidden=\"true\"><svg width=\"14\" height=\"14\" viewBox=\"0 0 16 16\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.5\" stroke-linecap=\"round\" stroke-linejoin=\"round\" aria-hidden=\"true\"><circle cx=\"8\" cy=\"8\" r=\"5.5\" stroke-dasharray=\"2 2.2\"/></svg></i> <span class=\"ss-word\">Not started</span></span>",
  starting: "<span class=\"ss ss-yellow ss-starting ss-anim\" role=\"status\" title=\"The session is starting; this can take half a minute\"><i class=\"ss-dot\" aria-hidden=\"true\"><svg width=\"14\" height=\"14\" viewBox=\"0 0 16 16\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.5\" stroke-linecap=\"round\" stroke-linejoin=\"round\" aria-hidden=\"true\"><path d=\"M8 2.5a5.5 5.5 0 1 1-5.5 5.5\"/></svg></i> <span class=\"ss-word\">Starting…</span></span>",
  free: "<span class=\"ss ss-gray ss-free\" role=\"status\" title=\"The session is idle: you can write to it\"><i class=\"ss-dot\" aria-hidden=\"true\"><svg width=\"14\" height=\"14\" viewBox=\"0 0 16 16\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.5\" stroke-linecap=\"round\" stroke-linejoin=\"round\" aria-hidden=\"true\"><circle cx=\"8\" cy=\"8\" r=\"5.5\"/><path d=\"M5.6 8.2l1.8 1.8 3-3.4\"/></svg></i> <span class=\"ss-word\">Idle</span></span>",
  working: "<span class=\"ss ss-green ss-working ss-anim\" role=\"status\" title=\"The session is working\"><i class=\"ss-dot\" aria-hidden=\"true\"><svg width=\"14\" height=\"14\" viewBox=\"0 0 16 16\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.5\" stroke-linecap=\"round\" stroke-linejoin=\"round\" aria-hidden=\"true\"><circle cx=\"8\" cy=\"8\" r=\"2.6\" fill=\"currentColor\"/><circle cx=\"8\" cy=\"8\" r=\"5.5\"/></svg></i> <span class=\"ss-word\">Working…</span></span>",
  compacting: "<span class=\"ss ss-yellow ss-compacting ss-anim\" role=\"status\" title=\"The session is compacting its context: wait a moment\"><i class=\"ss-dot\" aria-hidden=\"true\"><svg width=\"14\" height=\"14\" viewBox=\"0 0 16 16\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.5\" stroke-linecap=\"round\" stroke-linejoin=\"round\" aria-hidden=\"true\"><path d=\"M3 3l3.6 3.6M6.8 3.6v3.2H3.6M13 13l-3.6-3.6M9.2 12.4V9.2h3.2\"/></svg></i> <span class=\"ss-word\">Compacting…</span></span>",
  waiting: "<span class=\"ss ss-yellow ss-waiting\" role=\"status\" title=\"pi is asking something: answer it in the card of the chat\"><i class=\"ss-dot\" aria-hidden=\"true\"><svg width=\"14\" height=\"14\" viewBox=\"0 0 16 16\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.5\" stroke-linecap=\"round\" stroke-linejoin=\"round\" aria-hidden=\"true\"><path d=\"M3 3.5h10v7H8.6L5.6 13v-2.5H3z\"/><path d=\"M8 5.4v2.2\"/><circle cx=\"8\" cy=\"9\" r=\".5\" fill=\"currentColor\" stroke=\"none\"/></svg></i> <span class=\"ss-word\">Asking you something</span></span>",
};
