'use strict';
// RP137 (S26, S48), HIGH RISK (the merge cannot be undone): under 760 px a tap on ANY Merge button (the footer of the column, the card of the list, the Work tab: all go through the action `merge`) does not merge: it opens a sheet that
// says what will happen, and only the Merge button of the sheet sends the order, ONCE. The sheet asks the SAME rule as the button (V.mergeButton) again when confirmed: a PR that is not ready any more, one that is already merging, or one
// that is gone does not merge. It closes with Cancel, Esc, a tap outside, and when the PR or the open repo changes. From 760 px up (and when the width is not known) a tap merges as it did. The server is not touched: POST /api/merge
// still revalidates. The reason why Merge is off is written above the footer of the Repo screen (there is no tooltip on a phone).
// The abuse tests come first: a tap on Merge does not call /api/merge, the sheet's button does and once, a PR that stopped being ready does not merge, a change of PR or repo closes the sheet, a second tap while merging sends nothing.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { appSource } = require('./pagesrc.js');
const lib = require('../lib.js');
const V = require('../public/view.js');
const R = require('../public/resumen.js');

const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'style.css'), 'utf8').replace(/\r\n/g, '\n');
const A = 'abcdef0123';
const B = '9c15a89663';

// real pull requests: what GitHub sends, reduced by the same enrichPr the server uses
const RUN = (name, over = {}) => ({ __typename: 'CheckRun', name, status: 'COMPLETED', conclusion: 'SUCCESS', detailsUrl: `https://github.com/o/r/actions/runs/${name.length}1`, ...over });
const GH = (over = {}) => ({ number: 7, title: 'feat(x): the title', url: 'https://github.com/o/r/pull/7', headRefName: 'feat/x', baseRefName: 'main', headRefOid: 'abc123', isDraft: false, isCrossRepository: false, author: { login: 'me' }, reviewDecision: null, mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', statusCheckRollup: [RUN('build'), RUN('test')], additions: 3, deletions: 1, changedFiles: 2, ...over });
const READY = () => lib.enrichPr(GH());
const PENDING = () => lib.enrichPr(GH({ statusCheckRollup: [RUN('build'), RUN('test', { status: 'IN_PROGRESS', conclusion: null })] }));

// ---------- the pure parts ----------
test('v1: mergeWhy gives the reason only for a Merge button that is off for a reason: not for a merging or merged one, not for one that is on', () => {
  const off = V.mergeButton(PENDING(), { method: 'squash' });
  assert.equal(off.enabled, false);
  assert.equal(V.mergeWhy(off), off.title);
  assert.match(V.mergeWhy(off), /Method: squash/);
  assert.equal(V.mergeWhy(V.mergeButton(READY(), { method: 'squash' })), '');
  assert.equal(V.mergeWhy(V.mergeButton(READY(), { busy: true })), '', 'Merging…');
  assert.equal(V.mergeWhy(V.mergeButton(READY(), { held: true })), '', 'Merged ✓');
  assert.match(V.mergeWhy(V.mergeButton(null, { noPr: 'No open pull request for this branch' })), /No open pull request/);
  assert.equal(V.mergeWhy(V.mergeButton(READY(), { hold: 'A command is running' })), 'A command is running');
  for (const bad of [null, undefined, 5, 'x', [], {}, { enabled: false }, { enabled: false, label: 5, title: 'x' }, { enabled: false, label: 'Merge · squash', title: 5 }]) assert.equal(V.mergeWhy(bad), '', String(bad));
});

test('m1: the sheet says the number, the base, the method and what happens to the branch, with Cancel and Merge; the text of the PR and of the base is escaped; a model that is not valid gives nothing', () => {
  const h = R.mergeSheetHtml({ n: 7, base: 'main', title: 'feat(x): the title', method: 'squash', del: true });
  assert.match(h, /^<div class="ms-back" data-act="merge-cancel"><\/div><div class="ms-card" role="dialog" aria-modal="true" aria-labelledby="ms-t">/);
  assert.match(h, /<h3 id="ms-t">Merge #7 into main\?<\/h3>/);
  assert.match(h, /feat\(x\): the title/);
  assert.match(h, /Method: <b>squash<\/b>/);
  assert.match(h, /The branch will be deleted/);
  assert.match(h, /<button type="button" class="ms-cancel" id="ms-cancel" data-act="merge-cancel">Cancel<\/button>/);
  assert.match(h, /<button type="button" class="primary ms-ok" data-act="merge-confirm">Merge · squash<\/button>/);
  assert.match(R.mergeSheetHtml({ n: 7, base: 'main', method: 'rebase', del: false }), /The branch is kept[\s\S]*Merge · rebase/);
  assert.match(R.mergeSheetHtml({ n: 7, base: 'main', method: 'octopus', del: false }), /Method: <b>squash<\/b>/, 'a method that is not one of the three reads as squash, as the button does');
  const evil = R.mergeSheetHtml({ n: 7, base: '<img src=x onerror=alert(1)>', title: '"><script>1</script>', method: 'squash', del: false });
  assert.doesNotMatch(evil, /<img|<script/);
  for (const bad of [null, undefined, 5, 'x', [], {}, { n: 0, base: 'main' }, { n: -1, base: 'main' }, { n: 1.5, base: 'main' }, { n: '7', base: 'main' }, { n: 7 }, { n: 7, base: 5 }]) assert.equal(R.mergeSheetHtml(bad), '', JSON.stringify(bad));
});

test('m2: RP175: the composer writes the reason next to Merge only when it is off for a reason, and escapes it', () => {
  const off = R.composerMergeHtml({ id: A, branch: 'feat/x', ahead: 0, pr: PENDING(), merge: { enabled: false, label: 'Merge · squash', title: 'Checks <b>pending</b>. Method: squash.', why: 'Checks <b>pending</b>. Method: squash.' } });
  assert.match(off, /<span class="c-why" role="status">Checks &lt;b&gt;pending&lt;\/b&gt;\. Method: squash\.<\/span>$/);
  const on = R.composerMergeHtml({ id: A, branch: 'feat/x', ahead: 0, pr: READY(), merge: { enabled: true, label: 'Merge · squash', title: 'Merge into main', why: '' } });
  assert.doesNotMatch(on, /c-why/);
});

// ---------- the stylesheet ----------
const rules = [...css.matchAll(/(?:^|\n)([^{}\n@/ ][^{}\n]*)\{([^}]*)\}/g)].flatMap((m) => m[1].split(',').map((s) => ({ sel: s.trim().replace(/\s+/g, ' '), body: m[2] })));
const rule = (sel) => { const r = rules.filter((x) => x.sel === sel); assert.ok(r.length, `a rule for ${sel}`); return r.map((x) => x.body).join(';'); };

test('c1: the sheet is an overlay above everything with a backdrop, its buttons are 44 px targets with a visible focus ring, and the reason line is on every screen (RP175: it is in the composer now)', () => {
  assert.match(rule('#mergeSheet'), /position:\s*fixed/);
  assert.match(rule('#mergeSheet'), /z-index:\s*\d{2,}/);
  assert.match(rule('#mergeSheet[hidden]'), /display:\s*none/);
  assert.match(rule('.ms-back'), /position:\s*absolute/);
  assert.match(rule('.ms-btns button'), /min-height:\s*44px/);
  assert.match(css, /\.ms-btns button:focus-visible[^{]*\{[^}]*outline:\s*2px solid var\(--blue\)/);
  assert.doesNotMatch(rule('.c-why'), /display:\s*none/); // RP175: the reason is never hidden: a phone has no hover
  assert.doesNotMatch(css, /ft-why/);
});

// ---------- the page ----------
function element(extra = {}) {
  const el = {
    html: '', hidden: false, dataset: {}, disabled: false, value: '', checked: false, textContent: '', title: '', placeholder: '', attrs: {}, listeners: {}, children: [], open: false,
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    style: { setProperty(k, v) { el.style[k] = v; } },
    addEventListener(t, fn) { (el.listeners[t] ||= []).push(fn); }, setAttribute(k, v) { el.attrs[k] = v; }, querySelector: () => null, querySelectorAll: () => [], closest: () => null,
    showModal() {}, close() {}, focus() { el.focused = true; }, append(c) { el.children.push(c); },
    get innerHTML() { return el.html; }, set innerHTML(v) { el.html = String(v); }, ...extra,
  };
  return el;
}
const CONFIG = { groups: [{ name: 'G', repos: [{ id: A, name: 'repo-a', path: 'p-a' }, { id: B, name: 'repo-b', path: 'p-b' }] }], snoozed: [], dismissed: [], rooms: [], roomIssues: [] };
async function boot({ width = 390, inner } = {}) {
  const els = {};
  const frames = [];
  const listeners = {};
  const docListeners = {};
  const merges = [];
  const toasts = [];
  const loc = { hash: '', pathname: '/panel/', search: '' };
  const hist = { pushState(s, t, url) { const at = String(url).indexOf('#'); loc.hash = at >= 0 ? String(url).slice(at) : ''; }, replaceState() {}, back() {} };
  const tabEls = ['summary', 'work', 'conformity', 'settings'].map((t) => element({ dataset: { tab: t } }));
  const get = (sel) => (els[sel] ||= (sel === 'meta[name=token]' ? element({ content: 'token' }) : element()));
  get('#sumLayout').clientWidth = width;
  const doc = { hidden: false, querySelector: get, querySelectorAll: (s) => (String(s).includes('data-tab') ? tabEls : []), addEventListener(t, fn) { (docListeners[t] ||= []).push(fn); }, createElement: () => element(), body: element(), activeElement: null };
  const sandbox = {
    console, document: doc, TextDecoder, AbortController, confirm: () => true, location: loc, history: hist,
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    requestAnimationFrame: (cb) => { frames.push(cb); return frames.length; }, setInterval: () => 0, setTimeout: () => 0, clearTimeout: () => {}, clearInterval: () => {},
    fetch: (url, opts) => {
      if (String(url).startsWith('/api/config')) return Promise.resolve({ ok: true, json: async () => CONFIG });
      if (String(url).startsWith('/api/merge')) { merges.push(JSON.parse(opts.body)); return Promise.resolve({ ok: true, json: async () => ({ merged: true, branch: 'deleted' }) }); }
      return new Promise(() => {});
    },
  };
  const ctx = vm.createContext(sandbox);
  ctx.window = ctx;
  if (inner !== undefined) ctx.innerWidth = inner;
  ctx.addEventListener = (t, fn) => { (listeners[t] ||= []).push(fn); };
  ctx.RepoPanelView = V;
  ctx.RepoPanelResumen = R;
  vm.runInContext(appSource(), ctx);
  const flush = () => { while (frames.length) frames.shift()(); };
  const tick = async (n = 10) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); flush(); };
  await tick();
  const page = {
    get, tick, merges, run: (code) => vm.runInContext(code, ctx),
    sheet: () => get('#mergeSheet').html,
    state: (expr) => vm.runInContext(expr, ctx),
    click: async (act, dataset = {}) => { vm.runInContext(`ACTIONS[${JSON.stringify(act)}]({ dataset: ${JSON.stringify(dataset)} })`, ctx); await tick(); },
    key: async (key) => { for (const fn of docListeners.keydown || []) fn({ key, preventDefault() {}, target: { dataset: {} } }); await tick(); },
    setWidth: async (w) => { get('#sumLayout').clientWidth = w; for (const fn of listeners.resize || []) fn({ type: 'resize' }); await tick(); },
    setPr: async (id, pr) => { vm.runInContext(`S.prs[${JSON.stringify(id)}] = ${JSON.stringify({ prs: pr ? [pr] : [] })}`, ctx); },
    draw: async () => { vm.runInContext('draw()', ctx); await tick(); },
  };
  return page;
}
const tap = (page, id = A, n = 7) => page.click('merge', { id, n: String(n) });

test('a1: ABUSE: a tap on Merge under 760 px does NOT call /api/merge: it opens the sheet, which says what will happen', async () => {
  const page = await boot();
  await page.setPr(A, READY());
  await tap(page);
  assert.equal(page.merges.length, 0);
  assert.match(page.sheet(), /Merge #7 into main\?/);
  assert.match(page.sheet(), /data-act="merge-confirm"/);
  assert.equal(page.get('#mergeSheet').hidden, false);
});

test('a2: ABUSE: the Merge of the sheet sends the order ONCE, with the method and the branch rule that the sheet showed; a second tap on it finds nothing', async () => {
  const page = await boot();
  page.run("S.prefs.method = 'rebase'; S.prefs.del = true");
  await page.setPr(A, READY());
  await tap(page);
  assert.match(page.sheet(), /Method: <b>rebase<\/b>/);
  assert.match(page.sheet(), /The branch will be deleted/);
  await page.click('merge-confirm');
  await page.click('merge-confirm');
  await page.click('merge-confirm');
  assert.deepEqual(page.merges, [{ id: A, number: 7, method: 'rebase', deleteBranch: true }]);
  assert.equal(page.get('#mergeSheet').hidden, true);
  assert.equal(page.sheet(), '');
});

test('a3: ABUSE: a confirm with no sheet open sends nothing (the action cannot be called by itself)', async () => {
  const page = await boot();
  await page.setPr(A, READY());
  await page.click('merge-confirm');
  assert.deepEqual(page.merges, []);
});

test('a4: ABUSE: the PR stopped being ready between the tap and the confirm: it does NOT merge (the same rule of the button, asked again), the sheet closes and the person is told', async () => {
  const page = await boot();
  await page.setPr(A, READY());
  await tap(page);
  assert.match(page.sheet(), /merge-confirm/);
  await page.setPr(A, PENDING()); // the data changed and nothing has drawn yet: the confirm is the one that must ask again
  await page.click('merge-confirm');
  assert.deepEqual(page.merges, []);
  assert.equal(page.get('#mergeSheet').hidden, true);
  assert.match(page.get('#toasts').children.map((c) => c.textContent).join('|'), /#7/);
});

test('a5: ABUSE: the PR is gone, or is another PR, when the person confirms: nothing is merged', async () => {
  const page = await boot();
  await page.setPr(A, READY());
  await tap(page);
  await page.setPr(A, null);
  await page.click('merge-confirm');
  assert.deepEqual(page.merges, []);
  const other = await boot();
  await other.setPr(A, READY());
  await tap(other);
  await other.setPr(A, lib.enrichPr(GH({ number: 8 })));
  await other.click('merge-confirm');
  assert.deepEqual(other.merges, [], 'the sheet was for #7 and #7 is not listed any more');
});

test('a6: ABUSE: a PR that is already merging, or already merged and held, does not open the sheet, and a confirm with the merge in flight sends nothing', async () => {
  const page = await boot();
  await page.setPr(A, READY());
  page.run(`S.busy['${A}:7'] = true`);
  await tap(page);
  assert.equal(page.sheet(), '');
  assert.deepEqual(page.merges, []);
  page.run(`delete S.busy['${A}:7']; S.merged['${A}:7'] = Date.now()`);
  await tap(page);
  assert.equal(page.sheet(), '');
  page.run(`delete S.merged['${A}:7']`);
  await tap(page);
  assert.match(page.sheet(), /merge-confirm/);
  page.run(`S.busy['${A}:7'] = true`);
  await page.click('merge-confirm');
  assert.deepEqual(page.merges, [], 'a merge was already on its way for this PR');
});

test('a7: ABUSE: a tap on a Merge that is off (not ready, no PR, unknown repo, a number that is not one) opens nothing and sends nothing', async () => {
  const page = await boot();
  await page.setPr(A, PENDING());
  await tap(page);
  await tap(page, B);
  await tap(page, 'nope');
  await tap(page, A, NaN);
  await page.click('merge', {});
  await page.click('merge', { id: A, n: '7; drop' });
  assert.equal(page.sheet(), '');
  assert.deepEqual(page.merges, []);
});

test('a8: the sheet closes with Cancel, with Esc (and Esc does not close the chat then), and a tap on the backdrop is a Cancel; none of them merges', async () => {
  for (const how of ['cancel', 'esc']) {
    const page = await boot();
    await page.setPr(A, READY());
    await page.click('chat-open', { id: A });
    await tap(page);
    assert.match(page.sheet(), /merge-confirm/, how);
    if (how === 'cancel') await page.click('merge-cancel'); else await page.key('Escape');
    assert.equal(page.get('#mergeSheet').hidden, true, how);
    assert.equal(page.state('S.chat.id'), A, `${how}: the chat is still open`);
    assert.deepEqual(page.merges, [], how);
  }
  const page = await boot();
  await page.setPr(A, READY());
  await page.click('chat-open', { id: A });
  await page.key('Escape');
  assert.equal(page.state('S.chat.id'), null, 'with no sheet Esc still closes the chat, as before');
});

test('a9: ABUSE: the open repo changes with the sheet open (the chat is closed or another one opens): the sheet closes and nothing is merged', async () => {
  const page = await boot();
  await page.setPr(A, READY());
  await page.click('chat-open', { id: A });
  await tap(page);
  page.run('closeChat()');
  await page.tick();
  assert.equal(page.get('#mergeSheet').hidden, true);
  await page.click('merge-confirm');
  assert.deepEqual(page.merges, []);
  const other = await boot();
  await other.setPr(A, READY());
  await other.click('chat-open', { id: A });
  await tap(other);
  await other.click('chat-open', { id: B });
  assert.equal(other.get('#mergeSheet').hidden, true);
  await other.click('merge-confirm');
  assert.deepEqual(other.merges, []);
});

test('a10: the sheet follows the data: when the PR stops being ready while it is open, the next draw closes it', async () => {
  const page = await boot();
  await page.setPr(A, READY());
  await tap(page);
  assert.equal(page.get('#mergeSheet').hidden, false);
  await page.setPr(A, PENDING());
  await page.draw();
  assert.equal(page.get('#mergeSheet').hidden, true);
});

test('a11: from 760 px up a tap merges at once, as it did: no sheet', async () => {
  for (const width of [760, 900, 1099, 1100, 1500]) {
    const page = await boot({ width });
    await page.setPr(A, READY());
    await tap(page);
    assert.equal(page.sheet(), '', String(width));
    assert.equal(page.merges.length, 1, String(width));
  }
});

test('a12: a width that is not known keeps today\'s behaviour (a tap merges), unless the window says it is a phone: the Work tab has no layout to measure, so the width of the window counts', async () => {
  const unknown = await boot({ width: 0 });
  await unknown.setPr(A, READY());
  await tap(unknown);
  assert.equal(unknown.merges.length, 1);
  const work = await boot({ width: 0, inner: 390 });
  await work.setPr(A, READY());
  await tap(work);
  assert.deepEqual(work.merges, []);
  assert.match(work.sheet(), /merge-confirm/);
  const desktop = await boot({ width: 0, inner: 1440 });
  await desktop.setPr(A, READY());
  await tap(desktop);
  assert.equal(desktop.merges.length, 1);
});

test('a13: the sheet takes the focus on Cancel (the safe button) when it opens', async () => {
  const page = await boot();
  await page.setPr(A, READY());
  await tap(page);
  assert.equal(page.get('#ms-cancel').focused, true);
});

test('r1: RP175: the chat screen (the composer) writes the reason Merge is off next to it, and takes it away when the PR is ready', async () => {
  const page = await boot();
  await page.click('chat-open', { id: A });
  page.run(`S.local['${A}'] = { branch: 'feat/x', ahead: 0, files: [], error: null }`);
  await page.setPr(A, PENDING());
  await page.draw();
  assert.match(page.get('#chatActions').html, /<span class="c-why" role="status">/);
  await page.setPr(A, READY());
  await page.draw();
  assert.doesNotMatch(page.get('#chatActions').html, /c-why/);
});

test('a14: ABUSE: a tap on a Merge that is off leaves NO sheet pending in the state (it is not just hidden by the next draw)', async () => {
  const page = await boot();
  await page.setPr(A, PENDING());
  page.run(`ACTIONS['merge']({ dataset: { id: '${A}', n: '7' } })`);
  assert.equal(page.state('S.mergeSheet') ?? null, null);
  page.run(`ACTIONS['merge']({ dataset: { id: 'nope', n: '7' } })`);
  assert.equal(page.state('S.mergeSheet') ?? null, null);
});

test('a15: ABUSE: the confirm closes the sheet BEFORE anything else: the state is empty the moment it returns, the order is out once, and a second confirm in the same instant sends nothing', async () => {
  const page = await boot();
  await page.setPr(A, READY());
  await tap(page);
  assert.notEqual(page.state('S.mergeSheet') ?? null, null);
  page.run("ACTIONS['merge-confirm']({})");
  assert.equal(page.state('S.mergeSheet') ?? null, null, 'closed in the same instant');
  assert.equal(page.merges.length, 1, 'the order went out');
  page.run("ACTIONS['merge-confirm']({})");
  page.run("ACTIONS['merge-confirm']({})");
  assert.equal(page.merges.length, 1);
});

test('a16: ABUSE: the open repo changed since the tap and nothing has drawn yet: the confirm does NOT merge', async () => {
  const page = await boot();
  await page.setPr(A, READY());
  await page.click('chat-open', { id: A });
  await tap(page);
  assert.match(page.sheet(), /merge-confirm/);
  page.run(`S.chat = { ...S.chat, id: '${B}' }`);
  await page.click('merge-confirm');
  assert.deepEqual(page.merges, []);
});

test('a17: ABUSE (the verifier\'s A1): a DIFFERENT PR with the same number (another branch, or another title) took the place of the one the sheet showed and nothing has drawn: the confirm does NOT merge it', async () => {
  for (const swapped of [lib.enrichPr(GH({ headRefName: 'feat/other' })), lib.enrichPr(GH({ title: 'a title the person never saw' }))]) {
    const page = await boot();
    await page.setPr(A, READY());
    await tap(page);
    assert.match(page.sheet(), /merge-confirm/);
    await page.setPr(A, swapped); // same repo, same number, still ready: only what the person saw is different
    await page.click('merge-confirm');
    assert.deepEqual(page.merges, [], JSON.stringify([swapped.head, swapped.title]));
  }
});

test('a18: the sheet closes by itself when the PR of the same number is another one (the next draw)', async () => {
  const page = await boot();
  await page.setPr(A, READY());
  await tap(page);
  await page.setPr(A, lib.enrichPr(GH({ headRefName: 'feat/other' })));
  await page.draw();
  assert.equal(page.get('#mergeSheet').hidden, true);
});
