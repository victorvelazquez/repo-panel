'use strict';
// RP213 (S25): Conformity on the phone, mobile first. Under 760 px only: (1) the summary counters are figures, (2) each repo block under «Requirements» is folded to one line (name and state),
// (3) the repos that ask for attention (or are still loading) open by themselves, the ones that conform stay folded, and what the person opens or closes wins and survives a redraw.
// Plain CSS cannot be run here: these tests read the page as text and run its pure functions; how it LOOKS is for the person to try on the phone.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { appSource } = require('./pagesrc.js');
const V = require('../public/view.js');

const read = (f) => fs.readFileSync(path.join(__dirname, '..', 'public', f), 'utf8').replace(/\r\n/g, '\n');
const raw = read('style.css').replace(/\/\*[\s\S]*?\*\//g, '');
const MOBILE = '(max-width: 759.98px)';
const blocks = [...raw.matchAll(/@media ([^{]*)\{((?:[^{}]*\{[^}]*\})*)\s*\}/g)].filter((m) => m[1].trim() === MOBILE).map((m) => ({ at: m.index, body: m[2] }));
const phone = blocks.map((b) => b.body).join('\n');
const outsidePhone = blocks.reduce((s, b) => s.replace(b.body, ''), raw);
const rule = (src, sel) => [...src.matchAll(/(?:^|\n|\})\s*([^{}@]+)\{([^}]*)\}/g)].filter((m) => m[1].split(',').some((s) => s.trim().replace(/\s+/g, ' ') === sel)).map((m) => m[2]).join(';');
const actionsJs = read('actions.js');

const stub = () => new Proxy(function stubElement() {}, {
  get: (t, k) => (k === 'content' ? 'token' : k === 'dataset' ? {} : k === 'classList' ? { add() {}, remove() {}, toggle() {} } : k === Symbol.toPrimitive ? () => '' : stub),
  set: () => true,
  apply: () => stub(),
});
async function loadPage() {
  const drawer = { innerHTML: '', hidden: true };
  const focused = [];
  const ctx = vm.createContext({
    console,
    document: new Proxy({}, {
      get: (t, k) => (k === 'hidden' ? false : k === 'querySelector' ? (sel) => (sel === '#conformityView' ? drawer : sel === '#confBadge' ? { hidden: false, textContent: '' } : sel.startsWith('#conformityView [data-act="req-fold"]') ? { focus: () => focused.push(sel) } : stub())
        : k === 'addEventListener' ? () => {} : stub),
    }),
    localStorage: { getItem: () => null, setItem() {} }, location: { hash: '' }, requestAnimationFrame: () => 1, setInterval: () => 0, setTimeout: () => 0, clearTimeout: () => {}, AbortController, confirm: () => true,
    fetch: async () => { throw new Error('offline'); },
  });
  ctx.window = ctx;
  ctx.RepoPanelView = V;
  vm.runInContext(appSource(), ctx);
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
  return { get: (name) => vm.runInContext(name, ctx), drawer, focused };
}
const A = { id: 'a1', name: 'alpha', path: 'x', group: 'g' };
const B = { id: 'b2', name: 'beta', path: 'y', group: 'g' };
const C = { id: 'c3', name: 'gamma', path: 'z', group: 'g' };
const D = { id: 'd4', name: 'delta', path: 'w', group: 'g' };
const res = (o = {}) => ({ id: 'agents-file', title: 'AGENTS.md', category: 'verificable', level: 'required', status: 'pass', detail: 'ok', remedy: 'Create it', ...o });
const entry = (results) => ({ state: 'loaded', data: { results, summary: { ready: results.every((x) => x.status === 'pass'), required: { pass: results.filter((x) => x.status === 'pass').length, total: results.length }, recommended: { pass: 0, total: 0 } } } });
function open(page, repos, reqs) {
  const S = page.get('S');
  S.groups = [{ name: 'g', repos }];
  S.tab = 'conformity';
  for (const [id, e] of Object.entries(reqs)) S.req[id] = e;
  page.get('drawConformity')();
  return S;
}
const FOLD = /<button type="button" class="req-fold"[^>]*>[^<]*<\/button>/g;
const blockOf = (html, name) => html.split('<div class="conf-item">').find((b) => b.includes(`data-name="${name}"`)) || '';
const foldOf = (html, name) => (blockOf(html, name).match(FOLD) || [])[0] || '';
const mix = { [A.id]: entry([res(), res({ id: 'x', status: 'pass' })]), [B.id]: entry([res({ status: 'fail' })]), [C.id]: { state: 'failed' } };

// ---- (1) the counters as figures
test('c1: conformityView gives the counters as figures (number and short word), built from the same data as the text, which stays unchanged', () => {
  const conf = { items: [{ id: 'a' }, { id: 'b' }], ok: 5, loaded: true, failed: false, req: { prereq: 'loaded', repos: [{ id: 'z', state: 'loaded', ready: false }], rooms: { state: 'loaded', list: [{ name: 'r', ready: false }] } } };
  const v = V.conformityView(conf);
  assert.equal(v.summary, '5 conform · 2 need attention · 1 not ready · 1 room not ready');
  assert.deepEqual(v.figures, [{ n: 5, word: 'conform' }, { n: 2, word: 'attention' }, { n: 1, word: 'not ready' }, { n: 1, word: 'rooms' }]);
  assert.deepEqual(V.conformityView({ ...conf, items: [], req: { prereq: 'loaded', repos: [], rooms: { state: 'loaded', list: [] } } }).figures, [{ n: 5, word: 'conform' }]);
  assert.equal(V.conformityView({ items: [], ok: 0, loaded: false, failed: false }).figures, undefined, 'nothing to count while computing');
});

test('c2: drawConformity paints the figures next to the unchanged text line: the figures are aria-hidden, the text stays for assistive tools', async () => {
  const page = await loadPage();
  const S = page.get('S');
  Object.assign(S.conf, { items: [{ id: 'a1', name: 'alpha', status: 'problems', problems: [] }], ok: 3, loaded: true, key: 'k' });
  open(page, [A], { [A.id]: entry([res()]) });
  const html = page.drawer.innerHTML;
  assert.match(html, /<div class="conf-sum">3 conform · 1 need attention<\/div>/);
  assert.match(html, /<div class="conf-figs" aria-hidden="true"><span class="conf-fig"><b>3<\/b> conform<\/span><span class="conf-fig"><b>1<\/b> attention<\/span><\/div>/);
});

test('c3: CSS: the figures exist only under 760 px, where the text line stays for assistive tools (clipped, not display:none)', () => {
  assert.match(rule(outsidePhone, '.conf-figs'), /display:\s*none/);
  assert.match(rule(phone, '.conf-figs'), /display:\s*flex/);
  const sum = rule(phone, '.conf-figs + .conf-sum');
  assert.match(sum, /position:\s*absolute/);
  assert.match(sum, /clip/);
  assert.doesNotMatch(sum, /display:\s*none/);
  assert.doesNotMatch(rule(outsidePhone, '.conf-sum'), /clip|absolute/);
});

// ---- (2) each repo folded to one line
test('c4: a repo block has, after its name, a fold control with a visible state line, aria-expanded and its id; prerequisites, issues and rooms have none', async () => {
  const page = await loadPage();
  open(page, [A, B], mix);
  const html = page.drawer.innerHTML;
  assert.equal((html.match(FOLD) || []).length, 2);
  const f = foldOf(html, 'alpha');
  assert.match(f, /data-act="req-fold"/);
  assert.match(f, /data-id="a1"/);
  assert.match(f, /aria-expanded="(true|false)"/);
  assert.match(f, />Ready · 2 passing</);
  const b = blockOf(html, 'alpha');
  assert.ok(b.indexOf('repo-name') < b.indexOf('req-fold') && b.indexOf('req-fold') < b.indexOf('conf-status'), 'name, then the fold, then the results');
  assert.doesNotMatch(html.split('Requirements')[0], /req-fold/);
});

test('c5: the fold control is hidden outside the phone; on the phone it is 44 px, closed hides everything after it but the name, the arrow flips', () => {
  assert.match(rule(outsidePhone, '.req-fold'), /display:\s*none/);
  assert.match(rule(phone, '.conf-item .req-fold'), /display:\s*flex/);
  assert.match(rule(phone, '.conf-item .req-fold'), /min-height:\s*44px/);
  assert.match(rule(phone, '.req-fold[aria-expanded="false"] ~ *'), /display:\s*none/);
  assert.match(rule(phone, '.req-fold::after'), /content:\s*"\\25BE"/);
  assert.match(rule(phone, '.req-fold[aria-expanded="true"]::after'), /content:\s*"\\25B4"/);
  assert.ok(raw.indexOf('.req-fold { display: none') < blocks.find((b) => b.body.includes('.req-fold')).at, 'phone rules come after the base rule');
});

test('c6: desktop markup is the old one: without the fold controls a repo block is byte for byte what it was', async () => {
  const page = await loadPage();
  open(page, [A, B, C, D], { ...mix });
  const name = (r) => `<button class="repo-name" data-act="queue-pick" data-close="1" data-name="${r.name}" title="Filter the board to this repo">${r.name}</button>`;
  const stripped = page.drawer.innerHTML.replace(FOLD, '');
  assert.ok(stripped.includes(`<div class="conf-item">${name(C)}<div class="conf-line">Could not read the requirements</div></div>`));
  assert.ok(stripped.includes(`<div class="conf-item">${name(D)}<div class="conf-line">Checking the requirements…</div></div>`));
  assert.ok(stripped.includes(`<div class="conf-item">${name(A)}<div class="conf-status">Ready</div><details class="req-passing" data-id="a1"><summary>2 passing</summary>`));
  assert.ok(stripped.includes(`<div class="conf-item">${name(B)}<button class="conf-put" data-act="put-in-conditions" data-id="b2" title="Asks the session of this repo to apply the requirements that are not passing">Put in conditions</button><div class="conf-status">Not ready · required 0/1</div>`));
});

// ---- (3) open and closed
// found by mutation: nothing pinned the layout of the folded block (state on the right, content on its own line when open), that the control is not a solid button, or its accessible name
test('c11: the phone block lays the name and the state on one line (state to the right), the open content on its own line, and the fold control is a soft button with an accessible name', () => {
  const item = rule(phone, '.conf-item:has(> .req-fold)');
  assert.match(item, /display:\s*flex/);
  assert.match(item, /flex-wrap:\s*wrap/);
  assert.match(rule(phone, '.conf-item .req-fold'), /margin-left:\s*auto/);
  assert.ok(!/background:\s*var\(--(blue|green|red)\)/.test(rule(phone, '.conf-item .req-fold')), 'no solid button (RP67)');
  assert.match(rule(phone, '.req-fold ~ div'), /flex:\s*1 0 100%/);
  assert.match(read('tabs.js'), /class="req-fold"[^`]*aria-label="\$\{esc\(r\.name\)\}: \$\{esc\(fold\.state\)\}"/);
});

test('c7: reqFold: not ready, could not be read and still loading open by themselves; a repo that conforms is folded with its count of passing requirements', () => {
  assert.deepEqual(V.reqFold(entry([res(), res()])), { open: false, state: 'Ready · 2 passing' });
  assert.deepEqual(V.reqFold(entry([res({ status: 'fail' }), res()])), { open: true, state: 'Not ready · required 1/2' });
  assert.deepEqual(V.reqFold({ state: 'failed' }), { open: true, state: 'Could not read' });
  assert.deepEqual(V.reqFold(undefined), { open: true, state: 'Checking…' });
});

test('c8: what the person chose wins over the rule in both directions', () => {
  assert.equal(V.reqFold(entry([res()]), true).open, true, 'a repo that conforms, opened');
  assert.equal(V.reqFold(entry([res({ status: 'fail' })]), false).open, false, 'a repo with a gap, closed');
  assert.equal(V.reqFold(undefined, false).open, false, 'loading, closed');
  assert.equal(V.reqFold(entry([res()]), undefined).open, false, 'no choice = the rule');
});

test('c9: drawConformity opens the repos that ask for attention and folds the ones that conform; the choice of the person survives a redraw', async () => {
  const page = await loadPage();
  const S = open(page, [A, B, C, D], mix);
  const expanded = () => Object.fromEntries(['alpha', 'beta', 'gamma', 'delta'].map((n) => [n, /aria-expanded="(\w+)"/.exec(foldOf(page.drawer.innerHTML, n))[1]]));
  assert.deepEqual(expanded(), { alpha: 'false', beta: 'true', gamma: 'true', delta: 'true' });
  S.conf.fold.set(A.id, true);
  S.conf.fold.set(B.id, false);
  page.get('drawConformity')();
  page.get('drawConformity')();
  assert.deepEqual(expanded(), { alpha: 'true', beta: 'false', gamma: 'true', delta: 'true' });
  S.req[B.id] = entry([res()]); // the data changes: beta conforms now, the person's «closed» still holds
  page.get('drawConformity')();
  assert.equal(expanded().beta, 'false');
});

test('c10: the req-fold action sets the opposite of what is shown, redraws and returns the focus to the control; S.conf starts with its Map', async () => {
  const m = /'req-fold':\s*\(el\)\s*=>\s*\{([^\n]*)\}/.exec(actionsJs);
  assert.ok(m, 'the action exists');
  assert.match(m[1], /S\.conf\.fold/);
  assert.match(m[1], /drawConformity\(\)/);
  assert.match(m[1], /\.focus\(\)/);
  assert.match(read('app.js'), /conf: \{[^\n]*fold: new Map\(\)/);
  const page = await loadPage();
  const S = open(page, [A, B], mix);
  const act = page.get('ACTIONS')['req-fold'];
  act({ dataset: { id: A.id } });
  assert.equal(S.conf.fold.get(A.id), true, 'a folded repo opens');
  assert.match(foldOf(page.drawer.innerHTML, 'alpha'), /aria-expanded="true"/);
  act({ dataset: { id: A.id } });
  assert.equal(S.conf.fold.get(A.id), false, 'and a second tap closes it');
  act({ dataset: { id: B.id } });
  assert.equal(S.conf.fold.get(B.id), false, 'a repo that was open by the rule closes');
  assert.equal(page.focused.length, 3);
  act({ dataset: {} });
  assert.equal(S.conf.fold.size, 2, 'no id, no change');
});
