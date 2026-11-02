'use strict';
// RP88b (S9, S10), part 2 of 3: ONE function, V.RepoCard(model, mode), draws the frame of a repo card: the card element with its attributes, the branch, the
// chips wrapper and the order of the parts. Mode 'summary' is the Summary card (two lines), mode 'work' the board card (a column of lines). What differs on
// purpose is passed in as ready HTML (the caller escapes it): the identity and the time and session chip of the Summary, the top line, the notices and the
// buttons of the board card. The HTML comes out byte for byte the same as before (checked against the base commit by a differential script, not committed).
// The PR card body and the clean row are not touched here (the clean row is RP88c). No network, no real clock.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const V = require('../public/view.js');
const R = require('../public/resumen.js');

const read = (f) => fs.readFileSync(path.join(__dirname, '..', 'public', f), 'utf8').replace(/\r\n/g, '\n');
const C = (o = {}) => ({ files: 0, added: 0, deleted: 0, ahead: 0, behind: 0, noUpstream: false, ...o });

// ---------- pure: the summary mode ----------
const S = (o = {}) => ({ id: 'r1', label: 'alpha', identity: '<b class="rs-name">alpha</b>', branch: { text: 'feat/x', title: 'feat/x' }, chips: '', meta: '<i>M</i>', body: '<i>B</i>', ...o });

test('s1: the summary card is the article with its hooks, then the first line (identity, branch, chips, spacer, meta) and the second line (the body)', () => {
  assert.equal(V.RepoCard(S({ chips: '<i>C</i>', cls: ' ask', current: true }), 'summary'),
    '<article class="rs-card ask" data-id="r1" data-act="chat-open" tabindex="0" aria-current="true" aria-label="alpha">\n'
    + '      <div class="rs-l1"><b class="rs-name">alpha</b><span class="mono rs-branch" title="feat/x">feat/x</span><span class="rs-chips"><i>C</i></span><span class="rs-spacer"></span><i>M</i></div>\n'
    + '      <div class="rs-l2"><i>B</i></div>\n    </article>');
});

test('s2: no chips means no wrapper; no class and not the open chat means no extra attribute', () => {
  const h = V.RepoCard(S(), 'summary');
  assert.doesNotMatch(h, /rs-chips|aria-current/);
  assert.match(h, /^<article class="rs-card" data-id="r1" data-act="chat-open" tabindex="0" aria-label="alpha">/);
});

test('s3: the id, the label and the branch (text and title) are escaped; the slots are the caller HTML, untouched', () => {
  const h = V.RepoCard(S({ id: 'a"b', label: '<x>', branch: { text: '<b>', title: 'a"b' }, identity: '<u>ok</u>' }), 'summary');
  assert.match(h, /data-id="a&quot;b"/);
  assert.match(h, /aria-label="&lt;x&gt;"/);
  assert.match(h, /title="a&quot;b">&lt;b&gt;<\/span>/);
  assert.ok(h.includes('<u>ok</u>'));
});

// ---------- pure: the work mode ----------
const W = (o = {}) => ({ top: '<div class="card-top">T</div>', branch: { text: 'main', title: 'main' }, chips: '', before: [], between: [], after: [], ...o });

test('w1: the board card is the top line, the lines before, the branch line, the lines between, the chips block and the lines after, one per line, in that order', () => {
  assert.equal(V.RepoCard(W({ attn: true, before: ['<p>1</p>', '<p>2</p>'], between: ['<p>3</p>'], chips: '<i>C</i>', after: ['<p>4</p>', ''] }), 'work'),
    '<div class="card attn">\n    <div class="card-top">T</div>\n    <p>1</p>\n    <p>2</p>\n    <div class="branch one-line" title="main">main</div>\n    <p>3</p>\n    <div class="chips"><i>C</i></div>\n    <p>4</p>\n    \n  </div>');
});

test('w2: no attention keeps the trailing space of the class (as the board card always had it), and no chips leaves an empty line, not a wrapper', () => {
  const h = V.RepoCard(W(), 'work');
  assert.ok(h.startsWith('<div class="card ">'));
  assert.doesNotMatch(h, /class="chips"/);
  assert.equal(h, '<div class="card ">\n    <div class="card-top">T</div>\n    <div class="branch one-line" title="main">main</div>\n    \n  </div>');
});

test('w3: the branch is escaped in the board card too', () => {
  assert.match(V.RepoCard(W({ branch: { text: '<b>', title: 'a"b' } }), 'work'), /title="a&quot;b">&lt;b&gt;<\/div>/);
});

// ---------- pure: total ----------
test('t1: a model that is not an object or an unknown mode draws nothing and never fails', () => {
  for (const m of [null, undefined, 5, 'x', []]) assert.equal(V.RepoCard(m, 'summary'), '');
  assert.equal(V.RepoCard(S({ top: '<p>T</p>' }), 'compact'), '');
  assert.equal(V.RepoCard(S({ top: '<p>T</p>' }), undefined), '');
  assert.equal(V.RepoCard({}, 'summary').includes('undefined'), false);
  assert.equal(V.RepoCard({}, 'work').includes('undefined'), false);
});

// ---------- the pages use it ----------
function element(extra = {}) {
  const el = {
    writes: 0, html: '', hidden: false, dataset: {}, value: '', textContent: '', attrs: {}, listeners: {},
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false }, style: { setProperty() {} },
    addEventListener() {}, setAttribute(k, v) { el.attrs[k] = v; }, querySelector: () => null, querySelectorAll: () => [], closest: () => null, focus() {},
    get innerHTML() { return el.html; },
    set innerHTML(v) { el.html = String(v); el.writes++; },
    ...extra,
  };
  return el;
}
function loadPage(view = V) {
  const els = {};
  const get = (sel) => (els[sel] ||= (sel === 'meta[name=token]' ? element({ content: 'token' }) : element()));
  const ctx = vm.createContext({
    console, document: { hidden: false, querySelector: get, querySelectorAll: () => [], addEventListener() {}, createElement: () => element(), body: element(), activeElement: null },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} }, location: { hash: '' },
    requestAnimationFrame: () => 1, setInterval: () => 0, setTimeout: () => 0, clearTimeout: () => {}, AbortController, confirm: () => true,
    fetch: () => new Promise(() => {}),
  });
  ctx.window = ctx;
  ctx.addEventListener = () => {};
  ctx.RepoPanelView = view;
  ctx.RepoPanelResumen = R;
  vm.runInContext(read('app.js'), ctx);
  return { run: (c) => vm.runInContext(c, ctx) };
}
const REPO = '{ id: "abc", path: "p", name: "demo", group: "Personal" }';
const seed = (page, local, prs = { prs: [] }) => page.run(`S.groups = [{ name: 'Personal', repos: [${REPO}] }]; S.local.abc = ${JSON.stringify(local)}; S.prs.abc = ${JSON.stringify(prs)};`);

test('p1: the board card is drawn by RepoCard: it is the frame RepoCard returns, with the shared chips inside the chips block', () => {
  const calls = [];
  const real = V.RepoCard;
  const page = loadPage({ ...V, RepoCard: (m, mode) => { calls.push(mode); return real(m, mode); } });
  seed(page, { branch: 'feat/x', files: [{ path: 'a.js', status: 'M' }], added: 1, deleted: 0, ahead: 0, behind: 0 });
  const h = page.run(`repoCard(${REPO})`);
  assert.deepEqual(calls, ['work']);
  assert.match(h, /^<div class="card ">/);
  assert.ok(h.includes(`<div class="chips">${V.changeChips(C({ files: 1, added: 1 }), 'abc')}</div>`));
});

test('p2: the Summary card is drawn by RepoCard in summary mode', () => {
  const calls = [];
  const real = V.RepoCard;
  V.RepoCard = (m, mode) => { calls.push(mode); return real(m, mode); }; // resumen.js finds view.js through require: the same exports object
  try {
    const row = { id: 'r1', name: 'alpha', group: 'g', room: null, branch: 'b', needs: false, rank: 9, progress: { total: null }, next: null, blocking: [], lastMovement: {}, session: { state: 'free' }, action: null };
    const h = R.summaryView({ rows: [row], generatedAt: 't' }, { now: 0, scope: { kind: 'all' }, rooms: [], changesFor: () => C({ behind: 1 }) });
    assert.deepEqual(calls, ['summary']);
    assert.match(h, /<article class="rs-card" data-id="r1"/);
  } finally { V.RepoCard = real; }
});

test('p3: the frame markup lives once, in view.js: repoCard and cardHtml no longer carry the card or the Summary card element (the PR card keeps its own)', () => {
  const has = (f, s) => read(f).split(s).length - 1;
  assert.equal(has('view.js', '<article class="rs-card'), 1);
  assert.equal(has('resumen.js', '<article class="rs-card$' + '{'), 0, 'cardHtml no longer builds the article');
  assert.equal(has('app.js', '<div class="card $' + '{attn'), 0, 'repoCard no longer builds the card div');
  assert.equal(has('view.js', 'class="branch one-line"'), 1);
  assert.equal(has('app.js', 'class="branch one-line" title="$' + '{esc(l.branch'), 0, 'the branch line of the board card is the one of RepoCard');
});

test('p4: the lines of the board card keep their order: top, requirements, verdict, branch, state, roadmap, chips, then the errors', () => {
  const page = loadPage();
  seed(page, { branch: 'feat/x', files: [{ path: 'a.js', status: 'M' }], added: 1, deleted: 0, ahead: 0, behind: 0, error: undefined }, { prs: [], error: 'rate limited' });
  page.run(`S.req.abc = { state: 'loaded', data: { results: [{ id: 'R1', level: 'required', status: 'fail' }] } };
    S.state.abc = { available: true, state: 'working', next: 'n', at: new Date().toISOString() };
    S.roadmap.abc = { available: true, summary: { kind: 'next', id: 'X1', entrega: 'y', waiting: [], extra: 0, problems: { total: 0 }, done: 1, total: 2, pct: 50, header: {} } };`);
  const h = page.run(`repoCard(${REPO}, false, { state: 'attention', reason: 'failed' })`);
  const at = (s) => { const i = h.indexOf(s); assert.ok(i >= 0, `${s} is on the card`); return i; };
  const order = ['class="card-top"', 'class="attn-bar"', 'class="req-warn"', 'class="branch one-line"', 'class="state-line"', 'class="roadmap"', 'class="chips"', 'class="err">GitHub:'].map(at);
  assert.deepEqual(order, [...order].sort((a, b) => a - b));
  const fresh = loadPage();
  seed(fresh, { branch: 'feat/x', files: [{ path: 'a.js', status: 'M' }], added: 1, deleted: 0, ahead: 0, behind: 0 });
  const plain = fresh.run(`repoCard(${REPO})`);
  assert.ok(plain.indexOf('class="chips"') >= 0 && plain.indexOf('class="chips"') < plain.indexOf('class="actions"'), 'the buttons come last');
});
