'use strict';
// RP66c (S1, S5, S6): the side-by-side diff. R.changesView({ split: true }) pairs the lines of every hunk (context on both sides; a group of deleted lines next to a group of added ones, one
// by one; the rest stands alone) in rows of two halves, with the colors of RP66b and the same `esc` for every character (S5). A button, kept in the browser, turns it on (S6); below a width
// of the column the two halves stack, with CSS only. The unified view of before does not change. No network, no clock.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { appSource } = require('./pagesrc.js');

const R = require('../public/resumen.js');
const V = require('../public/view.js');

const PUBLIC = path.join(__dirname, '..', 'public');
const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(PUBLIC, f), 'utf8').replace(/\r\n/g, '\n');
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const bare = (cell) => cell.replace(/<span class="hl-[a-z]">/g, '').replace(/<\/span>/g, '');
const balanced = (h) => { let d = 0; for (const m of h.matchAll(/<span class="hl-[a-z]">|<\/span>/g)) { d += m[0] === '</span>' ? -1 : 1; if (d < 0 || d > 1) return false; } return d === 0; };

const diffOf = (p, body) => `diff --git a/${p} b/${p}\nindex 111..222 100644\n--- a/${p}\n+++ b/${p}\n${body}`;
const view = (p, body, ctx = {}) => R.changesView({ diff: diffOf(p, body) }, { selected: p, only: true, split: true, ...ctx });
// Every half of every split row: { side: 'l'|'r', kind: 'c'|'d'|'a'|'e', n, cell }.
const halves = (h) => [...String(h).matchAll(/<div class="cv-half cv-h([lr]) ([cdae])"><span class="cv-n">([^<]*)<\/span><span class="cv-t">(.*?)<\/span><\/div>/gs)].map((m) => ({ side: m[1], kind: m[2], n: m[3], cell: m[4] }));
const pairs = (h) => { const a = halves(h); const out = []; for (let i = 0; i < a.length; i += 2) out.push([a[i], a[i + 1]]); return out; };
const unifiedCells = (h) => [...String(h).matchAll(/<div class="cv-l(?! h")[^"]*"><span class="cv-n">[^<]*<\/span><span class="cv-n">[^<]*<\/span><span class="cv-t">(.*?)<\/span><\/div>/gs)].map((m) => m[1]);

const BODY = '@@ -1,6 +1,6 @@\n ctx1\n-del1\n-del2\n+add1\n tail\n+only-add\n-only-del\n';

test('the pairing: context on both sides, deleted next to added one by one, the rest alone with an empty half', () => {
  const p = pairs(view('notes.txt', '@@ -1,5 +1,5 @@\n ctx1\n-del1\n-del2\n+add1\n tail\n+only-add'));
  assert.deepEqual(p.map(([l, r]) => [l.kind, l.cell, l.n, r.kind, r.cell, r.n]), [
    ['c', ' ctx1', '1', 'c', ' ctx1', '1'],
    ['d', '-del1', '2', 'a', '+add1', '2'],
    ['d', '-del2', '3', 'e', '', ''],
    ['c', ' tail', '4', 'c', ' tail', '3'],
    ['e', '', '', 'a', '+only-add', '4'],
  ]);
  assert.ok(p.every(([l, r]) => l.side === 'l' && r.side === 'r'));
});

test('added lines before deleted ones in a group pair the same way, and a group of only deleted lines has empty right halves', () => {
  const p = pairs(view('notes.txt', '@@ -1,3 +1,2 @@\n+new1\n-old1\n-old2\n keep'));
  assert.deepEqual(p.map(([l, r]) => [l.cell, r.cell]), [['-old1', '+new1'], ['-old2', ''], [' keep', ' keep']]);
});

test('every hunk header and "no newline" marker is a full-width row, and the numbers are the old on the left and the new on the right', () => {
  const h = view('notes.txt', '@@ -10,2 +10,2 @@\n-a\n+b\n\\ No newline at end of file\n@@ -40,1 +40,1 @@\n same');
  assert.match(h, /<div class="cv-l h">.*?@@ -10,2 \+10,2 @@/s);
  assert.match(h, /<div class="cv-l m">.*?\\ No newline at end of file<\/span><\/div>/s);
  assert.match(h, /<div class="cv-l h">.*?@@ -40,1 \+40,1 @@/s);
  const p = pairs(h);
  assert.deepEqual([p[0][0].n, p[0][1].n, p[1][0].n, p[1][1].n], ['10', '10', '40', '40']);
});

test('the split view is drawn only when asked, and the unified view of before is byte for byte the same rows', () => {
  const body = BODY;
  const off = view('a.js', body, { split: false });
  const none = view('a.js', body, { split: undefined });
  assert.equal(off, none);
  assert.doesNotMatch(off, /cv-split"|cv-half|cv-s"/);
  assert.equal(halves(off).length, 0);
  const on = view('a.js', body, { split: true });
  assert.match(on, /<div class="cv-code cv-split">/);
  assert.equal(unifiedCells(on).length, 0, 'no unified row is left in the split view');
  assert.ok(unifiedCells(off).length >= 6);
});

test('the button turns it on: it is there with the state in aria-pressed, in the diff tab and in the Changes tab, and not in a note', () => {
  const D = diffOf('a.js', BODY) + '\n' + diffOf('b.js', BODY);
  for (const ctx of [{ selected: 'a.js', only: true }, { selected: '' }]) {
    const off = R.changesView({ diff: D }, ctx);
    const on = R.changesView({ diff: D }, { ...ctx, split: true });
    assert.match(off, /<button type="button" class="cv-split-btn" data-act="diff-split" aria-pressed="false">Side by side<\/button>/);
    assert.match(on, /<button type="button" class="cv-split-btn" data-act="diff-split" aria-pressed="true">Side by side<\/button>/);
  }
  for (const h of [R.changesView(null, {}), R.changesView({ diff: '' }, {}), R.changesView({ diff: D }, { selected: 'gone.js', only: true })]) assert.doesNotMatch(h, /diff-split/);
});

test('the colors of RP66b are on the two sides, with the two streams: a deleted comment opener does not turn the added lines into a comment', () => {
  const p = pairs(view('a.js', '@@ -1,3 +1,3 @@\n-/* start\n-still old\n+const a = 1;\n+const b = 2;\n tail();', { split: true }));
  assert.match(p[0][0].cell, /^-<span class="hl-c">\/\* start<\/span>$/);
  assert.match(p[1][0].cell, /^-<span class="hl-c">still old<\/span>$/);
  assert.match(p[0][1].cell, /^\+<span class="hl-k">const<\/span> a/);
  assert.match(p[1][1].cell, /^\+<span class="hl-k">const<\/span> b/);
  assert.match(p[2][0].cell, /^ tail\(\);$/);
});

test('a file with no language is split without color, as plain escaped text', () => {
  const h = view('notes.xyz', '@@ -1,1 +1,1 @@\n-old "q" <b>\n+new & x', { split: true });
  assert.deepEqual(halves(h).map((x) => x.cell), ['-old &quot;q&quot; &lt;b&gt;', '+new &amp; x']);
  assert.doesNotMatch(h, /class="hl-/);
});

const HOSTILE = [
  '</span><script>alert(1)</script>', '"><img src=x onerror=alert(1)>', "'><svg onload=alert(1)>", '<!-- </style><script>alert(1)</script>', '/* </span><b onmouseover=alert(1)> */',
  '`${</span><i>}` <a href="javascript:alert(1)">x</a>', '# <script>x</script> **<u>a</u>** `<s>`', '```<script>', '{"k":"</span><x>"}', 'a { background: url("</style><script>x</script>") } /*',
  'echo "$(</span><x>)" # </span>', '<div class="cv-half cv-hl d" onclick=1><span class="hl-s">', '&lt;b&gt; &amp;amp; &#60;', '\\"</span>\\\'<script>',
];
const PATHS = ['a.js', 'a.ts', 'a.json', 'a.css', 'a.html', 'a.md', 'a.sh', 'a.txt'];

test('S5: in every language each half with its spans removed is the sign and the escaped line, the spans are balanced, and no tag of the file reaches the page', () => {
  for (const p of PATHS) {
    const lines = [...HOSTILE, HOSTILE.join(' ')];
    const body = `@@ -1,${lines.length} +1,${lines.length} @@ ${HOSTILE[1]}\n${lines.map((l, i) => `${[' ', '+', '-'][i % 3]}${l}`).join('\n')}`;
    const h = view(p, body, { split: true });
    const sign = { c: ' ', a: '+', d: '-' };
    const all = halves(h).filter((x) => x.kind !== 'e');
    assert.ok(all.length >= lines.length, `${p}: ${all.length} halves`);
    for (const x of all) {
      assert.ok(balanced(x.cell), `${p} unbalanced: ${x.cell}`);
      const text = bare(x.cell);
      assert.ok(lines.some((l) => text === sign[x.kind] + esc(l)), `${p}: a half is not a sign plus an escaped line: ${text}`);
    }
    assert.match(h, /<div class="cv-l h">.*?@@ &quot;&gt;&lt;img src=x onerror=alert\(1\)&gt;<\/span><\/div>/s, `${p}: the text of the hunk header is escaped`);
    for (const t of [...h.matchAll(/<[^>]*>/g)].map((m) => m[0])) assert.match(t, /^<\/?(?:span|div|section|h3|button)\b/, `${p}: unexpected tag ${t}`);
    assert.doesNotMatch(h, /<(?:script|img|svg|style|a|b|i|u|s|x)\b/i, p);
    assert.doesNotMatch(h, /<[^>]*\son[a-z]+=/i, p);
  }
});

test('the cap of 2,000 rows holds in the split view too, and a very long line is split in linear time', () => {
  const many = `@@ -1,2100 +1,2100 @@\n${Array.from({ length: 2100 }, (_, i) => ` line ${i}`).join('\n')}`;
  const h = view('a.txt', many, { split: true });
  assert.equal(pairs(h).length, 2000);
  assert.match(h, /\+100 more lines/);
  const t = Date.now();
  view('a.html', `@@ -1,1 +1,1 @@\n+<a ${'a.'.repeat(50000)}`, { split: true });
  assert.ok(Date.now() - t < 1500, 'a long line took too long');
});

test('the CSS: two columns per row, the halves keep the row colors, and below the width of the column the halves stack (deleted first, the repeated context once, the empty half hidden)', () => {
  const css = read('style.css');
  assert.match(css, /\.cv-code\.cv-split\s*\{[^}]*container-type:\s*inline-size/);
  assert.match(css, /\.cv-s\s*\{[^}]*display:\s*grid[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)\s+minmax\(0,\s*1fr\)/);
  assert.match(css, /\.cv-half\.d\s*\{[^}]*background/);
  assert.match(css, /\.cv-half\.a\s*\{[^}]*background/);
  assert.match(css, /@container [a-z-]+ \(max-width:\s*\d+px\)\s*\{[^@]*\.cv-s\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)\s*;/);
  assert.match(css, /@container [a-z-]+ \(max-width:\s*\d+px\)\s*\{[^@]*\.cv-hr\.c[^{]*\{[^}]*display:\s*none/);
  assert.match(css, /\.cv-split-btn[^{]*\{/);
  const w = /@container cvs \(max-width:\s*(\d+)px\)/.exec(css);
  assert.ok(w && Number(w[1]) >= 500 && Number(w[1]) <= 900, `the halves stack below a width where two columns still fit (found ${w && w[1]} px)`);
});

// ---------- the page: the button keeps the choice in the browser ----------
function element(extra = {}) {
  const el = { html: '', textContent: '', dataset: {}, hidden: false, style: {}, attrs: {}, listeners: {}, children: [], writes: 0, classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    addEventListener(t, fn) { (el.listeners[t] ||= []).push(fn); }, setAttribute(k, v) { el.attrs[k] = v; }, querySelector: () => null, querySelectorAll: () => [], closest: () => null,
    showModal() {}, close() {}, focus() {}, append(c) { el.children.push(c); },
    get innerHTML() { return el.html; }, set innerHTML(v) { el.html = String(v); el.writes++; }, ...extra };
  return el;
}
function loadPage(stored = {}) {
  const els = {}; const frames = []; const routes = {};
  const tabEls = ['summary', 'work', 'conformity'].map((t) => element({ dataset: { tab: t } }));
  const get = (sel) => (els[sel] ||= (sel === 'meta[name=token]' ? element({ content: 'token' }) : element()));
  const doc = { hidden: false, querySelector: get, querySelectorAll: (s) => (String(s).includes('data-tab') ? tabEls : []), addEventListener() {}, createElement: () => element(), body: element(), activeElement: null };
  const ctx = vm.createContext({
    console, document: doc, location: { hash: '' },
    localStorage: { getItem: (k) => (k in stored ? stored[k] : null), setItem: (k, v) => { stored[k] = String(v); }, removeItem: (k) => { delete stored[k]; } },
    requestAnimationFrame: (cb) => { frames.push(cb); return frames.length; }, setInterval: () => 1, setTimeout: () => 0, clearTimeout: () => {}, AbortController, confirm: () => true,
    fetch: (url) => (routes[url] ? routes[url](url) : new Promise(() => {})),
  });
  ctx.window = ctx; ctx.addEventListener = () => {}; ctx.RepoPanelView = V; ctx.RepoPanelResumen = R; ctx.RepoPanelHighlight = require('../public/highlight.js');
  vm.runInContext(appSource(), ctx);
  const flush = () => { while (frames.length) frames.shift()(); };
  const tick = async (n = 8) => { for (let r = 0; r < 2; r++) { for (let i = 0; i < n; i++) await new Promise((x) => setImmediate(x)); flush(); } };
  return { get, tick, routes, stored, run: (c) => vm.runInContext(c, ctx) };
}
const ok = (b) => ({ ok: true, json: async () => b });
const card = (id, name) => ({ id, name, group: 'G', room: null, branch: 'main', progress: { total: 4, completada: 1, enRevision: 0, bloqueada: 0, pendiente: 3, enCurso: 0 }, session: { state: 'free' }, next: null, blocking: [], lastMovement: {}, activity: null });
async function boot(stored) {
  const page = loadPage(stored);
  const S = page.run('S');
  S.groups = [{ name: 'G', repos: [{ id: 'abc', name: 'demo', path: 'p' }] }];
  S.summary = { rows: [card('abc', 'demo')], generatedAt: 'x' };
  page.routes['/api/diff?id=abc'] = () => Promise.resolve(ok({ diff: diffOf('src/a.js', BODY), truncated: false }));
  page.run("ACTIONS['chat-open']({ dataset: { id: 'abc' } })");
  page.run("ACTIONS['chat-tab']({ dataset: { tab: 'changes' } })");
  await page.tick();
  return page;
}
const body = (page) => page.get('#chatBody').html;

test('page: by default the Changes tab is unified; the button turns the split view on and saves the choice, and again turns it off', async () => {
  const page = await boot();
  assert.doesNotMatch(body(page), /cv-split"/);
  assert.match(body(page), /data-act="diff-split" aria-pressed="false"/);
  page.run("ACTIONS['diff-split']({ dataset: {} })");
  await page.tick();
  assert.match(body(page), /<div class="cv-code cv-split">/);
  assert.match(body(page), /data-act="diff-split" aria-pressed="true"/);
  assert.equal(JSON.parse(page.stored.prefs).split, true, 'the choice is saved with the other preferences');
  assert.equal(JSON.parse(page.stored.prefs).method, 'squash', 'the other preferences are kept');
  page.run("ACTIONS['diff-split']({ dataset: {} })");
  await page.tick();
  assert.doesNotMatch(body(page), /cv-split"/);
  assert.equal(JSON.parse(page.stored.prefs).split, false);
});

test('page: a saved choice is applied the next time the page opens, in the Changes tab and in the diff tab', async () => {
  const page = await boot({ prefs: JSON.stringify({ method: 'squash', del: true, split: true }) });
  assert.match(body(page), /<div class="cv-code cv-split">/);
  page.run("ACTIONS['changes-file']({ dataset: { path: 'src/a.js' } })");
  await page.tick();
  assert.equal(page.run('S.chat.tab'), 'diff');
  assert.match(body(page), /<div class="cv-code cv-split">/);
  assert.match(body(page), /data-act="diff-split" aria-pressed="true"/);
});

test('the README says where the choice lives and what the button does', () => {
  const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8').replace(/\r\n/g, '\n');
  assert.match(readme, /Side by side/);
  assert.match(readme, /stack/i);
});
