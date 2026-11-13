'use strict';
// RP175: the Merge button left the footer of the right column and lives in the composer, next to the commands of the flow (/flow-commit, /flow-pr, /flow-base). It is the SAME Merge as the card of the board:
// data-act="merge", the ONE rule V.mergeButton, the same POST /api/merge. It is drawn only when the repo has an open PR of the CURRENT branch, and it is NOT held by the state of the session (RP159).
// When it is off, the reason is written next to it (a phone has no hover). The footer of the column and the visible hint «Enter sends · Shift+Enter new line» are gone. The abuse cases come first.
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
const html = read('index.html');

const RUN = (name, over = {}) => ({ __typename: 'CheckRun', name, status: 'COMPLETED', conclusion: 'SUCCESS', detailsUrl: `https://github.com/o/r/actions/runs/${name.length}1`, ...over });
const GH = (over = {}) => ({ number: 7, title: 'feat(x): the title', url: 'https://github.com/o/r/pull/7', headRefName: 'feat/x', baseRefName: 'main', headRefOid: 'abc123', isDraft: false, isCrossRepository: false, author: { login: 'me' }, reviewDecision: null, mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', additions: 164, deletions: 6, changedFiles: 6, statusCheckRollup: [RUN('build')], ...over });
const PR = (over) => lib.enrichPr(GH(over));
const CASES = {
  ready: PR(),
  draft: PR({ isDraft: true }),
  failed: PR({ statusCheckRollup: [RUN('build'), RUN('test', { conclusion: 'FAILURE' })] }),
  pending: PR({ statusCheckRollup: [RUN('build'), RUN('test', { status: 'IN_PROGRESS', conclusion: null })] }),
  conflict: PR({ mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY' }),
  behind: PR({ mergeStateStatus: 'BEHIND' }),
  blocked: PR({ mergeStateStatus: 'BLOCKED' }),
  unknown: PR({ mergeable: 'UNKNOWN', mergeStateStatus: 'UNKNOWN' }),
  review: PR({ reviewDecision: 'REVIEW_REQUIRED', mergeStateStatus: 'BLOCKED' }),
};
const MERGE = (pr, ctx = {}) => { const b = V.mergeButton(pr, { method: 'squash', ...ctx }); return { ...b, why: V.mergeWhy(b) }; };
const GIT = (pr, ctx = {}, over = {}) => ({ id: 'abc', branch: 'feat/x', pr, merge: MERGE(pr, ctx), ...over });
const btn = (h) => (/<button [^>]*data-act="merge"[^>]*>[^<]*<\/button>/.exec(h) || [''])[0];
const why = (h) => (/<span class="c-why" role="status">([^<]*)<\/span>/.exec(h) || [])[1];
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// ---------- the pure piece: the abuse first ----------
test('a1: hostile PR title, branch, id and reason never become markup', () => {
  const evil = PR({ title: '<img src=x onerror=1>', headRefName: '<b>x</b>', baseRefName: '"><i>', url: 'javascript:alert(1)', mergeStateStatus: 'BLOCKED' });
  const h = R.composerMergeHtml(GIT(evil, {}, { branch: '<u>x</u>', id: '"><s>' }));
  assert.doesNotMatch(h, /<img|<script|<u>|<b>|<i>|<s>|javascript:/);
  const g = GIT(CASES.review, {}, { id: 'a' });
  g.merge = { enabled: false, label: 'Merge · <b>x</b>', title: '"><img src=x>', why: '<script>alert(1)</script> & "q"' };
  const o = R.composerMergeHtml(g);
  assert.doesNotMatch(o, /<script|<img|<b>/);
  assert.equal(why(o), '&lt;script&gt;alert(1)&lt;/script&gt; &amp; &quot;q&quot;');
});

test('a2: no PR (nothing, odd values, a PR without a number) draws NOTHING: no button and no reason line; the function is total', () => {
  for (const pr of [null, undefined, {}, 'x', 5, [], { ready: true }, { number: '7' }, { number: 0 }, { number: 1.5 }]) assert.equal(R.composerMergeHtml(GIT(pr, {}, { pr })), '', JSON.stringify(pr));
  for (const g of [null, undefined, 7, 'x', [], {}, { id: 'a' }, { id: 'a', pr: 'x', merge: 'x' }]) assert.equal(R.composerMergeHtml(g), '', JSON.stringify(g));
  assert.doesNotMatch(R.composerMergeHtml({ id: 'a', pr: CASES.ready }), /undefined|NaN|null/);
});

test('a3: a PR that is not ready: the button is disabled AND the reason is a visible line with the exact V.mergeWhy text (escaped)', () => {
  for (const [k, pr] of Object.entries(CASES)) {
    const h = R.composerMergeHtml(GIT(pr));
    assert.equal(/ disabled /.test(btn(h)), !pr.ready, k);
    if (pr.ready) { assert.equal(why(h), undefined, k); continue; }
    const b = V.mergeButton(pr, { method: 'squash' });
    assert.equal(why(h), esc(V.mergeWhy(b)), k);
    assert.ok(V.mergeWhy(b).length > 0, k);
    assert.ok(btn(h).includes(`title="${esc(b.title)}"`), `${k}: the title stays on the button`);
  }
});

test('a4: ready: enabled with the label «Merge · <method>», the same data of the old button, and no reason line; merging and merged are off without a reason', () => {
  const h = R.composerMergeHtml(GIT(CASES.ready));
  assert.equal(h, '<button type="button" class="c-act merge" data-act="merge" data-id="abc" data-n="7" title="Merge into main. Method: squash. Change it in Settings, Delivery.">Merge · squash</button>');
  assert.match(R.composerMergeHtml(GIT(CASES.ready, { method: 'rebase' })), />Merge · rebase<\/button>$/);
  const held = R.composerMergeHtml(GIT(CASES.ready, { held: true }));
  assert.match(btn(held), / disabled /);
  assert.match(held, />Merged ✓<\/button>$/);
  assert.equal(why(held), undefined);
  const busy = R.composerMergeHtml(GIT(CASES.ready, { busy: true }));
  assert.match(busy, / disabled [^>]*>Merging…<\/button>$/);
  assert.equal(why(busy), undefined);
  const running = R.composerMergeHtml(GIT(CASES.ready, { hold: 'Running /flow-commit (committing…): wait for it to finish' }));
  assert.match(btn(running), / disabled /);
  assert.equal(why(running), 'Running /flow-commit (committing…): wait for it to finish');
});

test('a5: the reason line comes right after the button, inside the actions row', () => {
  assert.match(R.composerMergeHtml(GIT(CASES.draft)), /^<button [^>]*>Merge · squash<\/button><span class="c-why" role="status">Draft pull request\. Method: squash\. Change it in Settings, Delivery\.<\/span>$/);
});

// ---------- the page ----------
function element(extra = {}) {
  const el = {
    writes: 0, html: '', hidden: false, dataset: {}, disabled: false, value: '', checked: false, textContent: '', title: '', attrs: {}, listeners: {}, children: [], open: false, focused: 0,
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
  const fetches = [];
  const routes = {};
  const docL = {};
  const tabEls = ['summary', 'work', 'conformity'].map((t) => element({ dataset: { tab: t } }));
  const get = (sel) => (els[sel] ||= (sel === 'meta[name=token]' ? element({ content: 'token' }) : element()));
  const doc = { hidden: false, querySelector: get, querySelectorAll: (s) => (String(s).includes('data-tab') ? tabEls : []), addEventListener(t, fn) { (docL[t] ||= []).push(fn); }, createElement: () => element(), body: element(), activeElement: null };
  const ctx = vm.createContext({
    console, document: doc, location: { hash: '' },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    requestAnimationFrame: (cb) => { frames.push(cb); return frames.length; },
    setInterval: () => 0, setTimeout: () => 0, clearTimeout: () => {}, AbortController, confirm: () => true,
    fetch: (url, opts = {}) => { fetches.push({ url, method: opts.method || 'GET', body: opts.body ? JSON.parse(opts.body) : null }); return routes[url] ? routes[url](url, opts) : new Promise(() => {}); },
  });
  ctx.window = ctx;
  ctx.addEventListener = () => {};
  ctx.RepoPanelView = V;
  ctx.RepoPanelResumen = R;
  vm.runInContext(appSource(), ctx);
  const flush = () => { while (frames.length) frames.shift()(); };
  const tick = async (n = 8) => { for (let r = 0; r < 2; r++) { for (let i = 0; i < n; i++) await new Promise((x) => setImmediate(x)); flush(); } };
  const click = (el) => { const e = { type: 'click', target: { closest: (sel) => (sel === '[data-act]' ? el : null) } }; for (const fn of docL.click || []) fn(e); };
  return { get, flush, tick, fetches, routes, click, run: (c) => vm.runInContext(c, ctx) };
}
const ok = (body) => ({ ok: true, json: async () => body });
const ROW = (id, estado) => ({ id, entrega: `Delivery of ${id}`, resultadoVisible: '', dependsOn: [], estado, notas: '', line: 1 });
const card = (id, name) => ({ id, name, group: 'G', room: null, branch: 'main', progress: { total: 4, completada: 1, enRevision: 0, bloqueada: 0, pendiente: 3, enCurso: 0 }, session: { state: 'free' }, next: null, blocking: [], lastMovement: {}, action: null, needs: false, rank: 9 });
function boot({ width = 1400, branch = 'feat/x', prs = { prs: [CASES.ready] } } = {}) {
  const page = loadPage();
  const S = page.run('S');
  S.groups = [{ name: 'G', repos: [{ id: 'abc', name: 'demo', path: 'p' }] }];
  S.summary = { rows: [card('abc', 'demo')], generatedAt: 'x' };
  S.local.abc = { branch, ahead: 2, files: [{ path: 'a.js', status: 'M', added: 1, deleted: 0 }] };
  if (prs) S.prs.abc = prs;
  const layout = page.get('#sumLayout');
  layout.clientWidth = width;
  layout.getBoundingClientRect = () => ({ left: 0, right: width, width });
  page.get('#split').offsetWidth = 10;
  page.get('#split2').offsetWidth = 10;
  page.routes['/api/roadmap?id=abc'] = () => Promise.resolve(ok({ available: true, rows: [ROW('A1', 'Completada')], derived: {}, next: null }));
  return page;
}
const open = async (page) => { page.run("ACTIONS['chat-open']({ dataset: { id: 'abc' } })"); await page.tick(); };
const actions = (page) => page.get('#chatActions').html;
const posts = (page, url) => page.fetches.filter((f) => f.method === 'POST' && f.url === url);
const MERGE_EL = (over = {}) => ({ dataset: { act: 'merge', id: 'abc', n: '7' }, disabled: false, tagName: 'BUTTON', ...over });

test('p1: a hostile branch with a PR of that branch: the composer holds the button and the branch name is never in the markup', async () => {
  const page = boot({ branch: '<b>x</b>', prs: { prs: [PR({ headRefName: '<b>x</b>', title: '<img src=x onerror=1>' })] } });
  await open(page);
  assert.match(btn(actions(page)), /data-act="merge" data-id="abc" data-n="7"/);
  assert.doesNotMatch(actions(page), /<b>|<img|&lt;b&gt;/);
});

test('p2: a PR of ANOTHER branch (and the base branch, and a detached HEAD) draws no button and no reason line; the right PR is picked among many', async () => {
  const other = PR({ number: 9, headRefName: 'feat/other' });
  const a = boot({ prs: { prs: [other] } });
  await open(a);
  assert.doesNotMatch(actions(a), /merge|c-why/);
  for (const branch of ['main', null]) {
    const b = boot({ branch, prs: { prs: [other, PR({ number: 8 })] } });
    await open(b);
    assert.doesNotMatch(actions(b), /merge|c-why/, String(branch));
  }
  const many = boot({ prs: { prs: [other, PR({ number: 8 }), PR({ number: 10, headRefName: 'feat/third' })] } });
  await open(many);
  assert.match(btn(actions(many)), /data-n="8"/);
});

test('p3: nothing known (loading, failed read, no remote, no PR) draws nothing and sends nothing', async () => {
  for (const prs of [null, { error: 'gh failed' }, { noRemote: true, prs: [] }, { prs: [] }]) {
    const page = boot({ prs });
    page.routes['/api/merge'] = () => Promise.resolve(ok({}));
    await open(page);
    assert.doesNotMatch(actions(page), /merge|c-why/, JSON.stringify(prs));
    page.click(MERGE_EL({ disabled: true }));
    await page.tick();
    assert.equal(posts(page, '/api/merge').length, 0);
  }
});

test('p4: THE MATRIX on the page: the composer button is off where the card is off, with the visible reason; touching an off button calls nothing; a ready one posts once', async () => {
  for (const [k, pr] of Object.entries(CASES)) {
    const page = boot({ prs: { prs: [pr] } });
    page.routes['/api/merge'] = () => Promise.resolve(ok({}));
    await open(page);
    const h = actions(page);
    assert.equal(/ disabled /.test(btn(h)), !pr.ready, `${k}: ${btn(h)}`);
    assert.equal(why(h) !== undefined, !pr.ready, `${k}: the reason line is there exactly when it is off`);
    if (!pr.ready) assert.equal(why(h), esc(V.mergeWhy(V.mergeButton(pr, { method: 'squash' }))), k);
    page.click(MERGE_EL({ disabled: !pr.ready }));
    await page.tick();
    assert.equal(posts(page, '/api/merge').length, pr.ready ? 1 : 0, k);
  }
});

test('p5: ready: the click sends exactly ONE order (the same of the card); after it the button says «Merged ✓», is off and a second click sends nothing', async () => {
  const page = boot();
  page.routes['/api/merge'] = () => Promise.resolve(ok({ branch: 'kept' }));
  await open(page);
  assert.match(actions(page), />Merge · squash<\/button>/);
  page.click(MERGE_EL());
  await page.tick();
  assert.deepEqual(posts(page, '/api/merge').map((p) => p.body), [{ id: 'abc', number: 7, method: 'squash', deleteBranch: true }]);
  assert.match(btn(actions(page)), / disabled [^>]*>Merged ✓<\/button>/);
  assert.equal(why(actions(page)), undefined, 'merged is not off for a reason');
  page.click(MERGE_EL({ disabled: true })); // the button drawn after the merge is off: the page drops a touch on a disabled button
  await page.tick();
  assert.equal(posts(page, '/api/merge').length, 1);
});

test('p6: while the merge is in flight the button says «Merging…» and more clicks send nothing', async () => {
  const page = boot();
  page.routes['/api/merge'] = () => new Promise(() => {});
  await open(page);
  page.click(MERGE_EL());
  page.click(MERGE_EL());
  page.click(MERGE_EL());
  await page.tick();
  assert.equal(posts(page, '/api/merge').length, 1);
  assert.match(btn(actions(page)), / disabled [^>]*>Merging…<\/button>/);
});

test('p7: the button is NOT held by the session: busy, asking, closed or free, it is drawn and enabled for a ready PR', async () => {
  for (const state of ['busy', 'asking', 'closed', 'free', 'starting']) {
    const page = boot();
    await open(page);
    page.run(`S.rpc.abc = { state: '${state}' }`);
    page.run('draw()');
    page.flush();
    assert.match(btn(actions(page)), /data-act="merge" data-id="abc" data-n="7"/, state);
    assert.doesNotMatch(btn(actions(page)), / disabled /, state);
  }
  const chat = read('chat.js');
  const line = chat.split('\n').find((l) => l.includes('composerMergeHtml')) || '';
  assert.ok(line, 'the composer paints the merge button');
  assert.ok(line.includes('+ R.composerMergeHtml(columnGit(id, S.local[id])));'), 'it asks the PR and the rule, never the session menu or the hold of the delivery');
  assert.doesNotMatch((/function columnGit[\s\S]*?\n\}/.exec(chat) || [''])[0], /deliveryHold/);
});

test('p8: a command that the panel itself is running in the session turns the button off, with the reason visible (the rule of the card)', async () => {
  const page = boot();
  await open(page);
  page.run("S.sending.abc = 'flow-commit'");
  page.run('draw()');
  page.flush();
  assert.match(btn(actions(page)), / disabled /);
  assert.match(why(actions(page)), /^Running /);
});

test('p9: the footer is gone from the column in every tab, and the PR of the branch still shows in the Status tab', async () => {
  const page = boot();
  await open(page);
  for (const t of ['changes', 'status', 'tasks', 'files']) {
    page.run(`ACTIONS['col-tab']({ dataset: { tab: '${t}' } })`);
    page.flush();
    assert.doesNotMatch(page.get('#colBody').html, /col-foot|ft-merge|ft-br|ft-ci|ft-why|data-act="merge"/, t);
  }
  page.run("ACTIONS['col-tab']({ dataset: { tab: 'status' } })");
  page.flush();
  assert.match(page.get('#colBody').html, /class="st-n"/);
});

test('p10: drawing the button writes nothing', async () => {
  const page = boot();
  await open(page);
  const before = page.fetches.filter((f) => f.method !== 'GET').length;
  page.run('draw()');
  page.flush();
  assert.equal(page.fetches.filter((f) => f.method !== 'GET').length, before);
});

// ---------- static: the footer and the hint are gone, the styles ----------
test('s1: no trace of the footer of the column in the code, the styles or the page (the Files tree keeps its own ft-name)', () => {
  const all = { 'style.css': css, 'index.html': html, ...Object.fromEntries(fs.readdirSync(PUBLIC).filter((f) => f.endsWith('.js')).map((f) => [f, read(f)])) };
  for (const [f, text] of Object.entries(all)) {
    assert.doesNotMatch(text, /col-foot|ft-merge|ft-why|ft-br\b|ft-ci|footHtml|ciMark/, f);
  }
  assert.doesNotMatch(R.columnView({ files: [], git: GIT(CASES.ready) }), /col-foot|data-act="merge"/);
});

test('s2: the hint is not visible any more; the information is the title of the box; the keyboard is as it was', () => {
  assert.doesNotMatch(html, /class="hint"|<span[^>]*>[^<]*Enter sends/);
  assert.doesNotMatch(css, /(^|\n)\.hint\s*\{/);
  assert.match(/<textarea id="msgBox"[^>]*>/.exec(html)[0], /title="Enter sends · Shift\+Enter new line"/);
  assert.match(/<textarea id="msgBox"[^>]*>/.exec(html)[0], /aria-label="Message to the session"/);
  assert.match(read('app.js'), /e\.key !== 'Enter' \|\| !e\.target \|\| e\.target\.id !== 'msgBox' \|\| e\.shiftKey \|\| e\.isComposing \|\| e\.keyCode === 229\) return;\n\s*e\.preventDefault\(\);\n\s*sendChatMessage\(\);/);
});

test('s3: the reason wraps and never cuts, the row wraps in a narrow chat, and the RP156 container query still only hides chip words', () => {
  const decl = (sel) => [...css.matchAll(/(?:^|\n)([^{}\n@/][^{}\n]*)\{([^}]*)\}/g)].filter((m) => m[1].split(',').map((s) => s.trim()).includes(sel)).map((m) => m[2]).join(';');
  const w = decl('.c-why');
  assert.match(w, /flex:\s*1 1 100%/);
  assert.match(w, /overflow-wrap:\s*anywhere/);
  assert.doesNotMatch(w, /nowrap|text-overflow|overflow:\s*hidden|display:\s*none/);
  assert.match(w, /color:\s*var\(--muted\)/);
  const a = decl('.c-actions');
  assert.match(a, /flex-wrap:\s*wrap/);
  assert.match(a, /min-width:\s*0/);
  const q = /@container cmp \(max-width: 456px\) \{([\s\S]*?)\n\}/.exec(css)[1];
  assert.match(q, /\.ss-word, \.mem-word, \.ss-long/); // RP171: the subagent chip is gone, so its words are not in the list any more
  assert.doesNotMatch(q, /c-why|c-act|merge/);
});

test('s4: the new visible words follow the rp69 rule (no «pi session», «pi screen», «Gentle Shell»)', () => {
  const FORBIDDEN = /\b[Pp]i (?:sessions?|prompt|screens?|terminals?|orders?)\b|\b(?:to|in|of|with) pi\b|Gentle Shell/;
  assert.doesNotMatch(R.composerMergeHtml(GIT(CASES.draft)), FORBIDDEN);
  assert.doesNotMatch(/<textarea id="msgBox"[^>]*>/.exec(html)[0], FORBIDDEN);
});
