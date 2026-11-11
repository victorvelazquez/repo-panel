'use strict';
// RP135 (S26), design F of design/panel-movil/06: under 760 px the head of the chat says the state of the repo, so the way into Repo is visible without a bar. The name of the repo gets a second line (the commits ahead, the checks that
// are running or failed, and the branch) and the whole block is a button that opens Repo; the Repo button gets a badge with the number of checks that are pending. It reads what the page already has (the board's facts and the open PR of
// THAT branch, the same rule as the footer of the column) and adds no reads. From 760 px up the head is the one of always.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { appSource } = require('./pagesrc.js');
const V = require('../public/view.js');
const R = require('../public/resumen.js');
const lib = require('../lib.js');

const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'style.css'), 'utf8').replace(/\r\n/g, '\n');
const A = 'abcdef0123';
const pr = (checks, extra = {}) => ({ number: 5, head: 'feat/x', checks, ...extra });
const g = (o = {}) => ({ id: A, branch: 'feat/x', ahead: 0, pr: null, ...o });

// ---------- the line (pure) ----------
test('l1: with nothing to say the line is the branch alone; with commits ahead it starts with them; with no git or no branch there is nothing', () => {
  assert.deepEqual(R.repoStatus(g()), { ahead: 0, pending: 0, failed: 0, branch: 'feat/x', line: 'feat/x', label: 'Open the repo: branch feat/x' });
  assert.equal(R.repoStatus(g({ ahead: 2 })).line, '↑2 · feat/x');
  assert.equal(R.repoStatus(g({ ahead: 2 })).label, 'Open the repo: branch feat/x, 2 commits ahead');
  assert.equal(R.repoStatus(g({ ahead: 1 })).label, 'Open the repo: branch feat/x, 1 commit ahead');
  for (const bad of [null, undefined, 5, 'x', [], true]) assert.deepEqual(R.repoStatus(bad), { ahead: 0, pending: 0, failed: 0, branch: '', line: '', label: 'Open the repo' }, String(bad));
  assert.equal(R.repoStatus(g({ branch: '' })).line, '');
  assert.equal(R.repoStatus(g({ branch: '', ahead: 3 })).line, '↑3');
});

test('l2: the checks of the open PR of this branch: running ones and failed ones are said, passed ones are not; none known says nothing', () => {
  const run = R.repoStatus(g({ ahead: 2, pr: pr({ state: 'pending', total: 4, passed: 2, failed: 0, pending: 2 }) }));
  assert.equal(run.line, '↑2 · 2 checks · feat/x');
  assert.equal(run.pending, 2);
  assert.equal(run.label, 'Open the repo: branch feat/x, 2 commits ahead, 2 checks running');
  assert.equal(R.repoStatus(g({ pr: pr({ pending: 1, total: 1 }) })).line, '1 check · feat/x');
  const failed = R.repoStatus(g({ pr: pr({ state: 'failed', total: 3, passed: 2, failed: 1, pending: 0 }) }));
  assert.equal(failed.line, '1 failed · feat/x');
  assert.equal(failed.label, 'Open the repo: branch feat/x, 1 check failed');
  const both = R.repoStatus(g({ pr: pr({ total: 5, passed: 1, failed: 1, pending: 3 }) }));
  assert.equal(both.line, '3 checks · 1 failed · feat/x');
  assert.equal(R.repoStatus(g({ pr: pr({ state: 'success', total: 3, passed: 3, failed: 0, pending: 0 }) })).line, 'feat/x');
  assert.equal(R.repoStatus(g({ pr: pr(undefined) })).line, 'feat/x');
  assert.equal(R.repoStatus(g({ pr: { head: 'feat/x', checks: { pending: 2 } } })).pending, 0, 'a PR with no number is not a PR');
});

test('l3: hostile or broken numbers and names never reach the line as anything but plain text', () => {
  for (const n of [-1, NaN, Infinity, 1.5, '2', null, {}, [], 1e12]) {
    const s = R.repoStatus(g({ ahead: n, pr: pr({ pending: n, failed: n }) }));
    assert.ok(s.ahead >= 0 && Number.isInteger(s.ahead), `ahead ${String(n)}`);
    assert.ok(s.pending >= 0 && Number.isInteger(s.pending), `pending ${String(n)}`);
    assert.doesNotMatch(s.line, /NaN|Infinity|undefined|null|\[object/, String(n));
  }
  assert.equal(R.repoStatus(g({ branch: 5 })).branch, '');
  assert.equal(R.repoStatus(g({ branch: 'a'.repeat(500) })).branch.length, 500, 'cutting a long name is the stylesheet\'s job (ellipsis), not the text\'s');
});

// ---------- the head ----------
const head = (ctx) => R.chatHead({ id: A, tab: 'chat' }, { name: 'demo', column: true, ...ctx });
const run = { git: g({ ahead: 2, pr: pr({ pending: 2, total: 4, passed: 2 }) }) };

test('h1: narrow, the name and the line are ONE button that opens Repo, with the label of the state; the Repo button carries the badge of pending checks', () => {
  const h = head({ ...run, narrow: true });
  assert.match(h, /<button type="button" class="ch-id" data-act="zone-set" data-zone="repo" aria-label="Open the repo: branch feat\/x, 2 commits ahead, 2 checks running" title="[^"]*"><b class="ch-name"[^>]*>demo<\/b><span class="ch-sub mono">↑2 · 2 checks · feat\/x<\/span><\/button>/);
  assert.match(h, /<button type="button" class="ch-repo" data-act="zone-set" data-zone="repo" aria-label="Repo: 2 checks pending"[^>]*>[\s\S]*?<i class="ch-dot" aria-hidden="true">2<\/i><\/button>/);
});

test('h2: not narrow the head is the one of always: a plain name, no second line, and the Repo button keeps its plain label with no badge', () => {
  for (const ctx of [{ ...run }, { ...run, narrow: false }, { ...run, narrow: 'yes' }, { ...run, narrow: 1 }]) {
    const h = head(ctx);
    assert.doesNotMatch(h, /ch-id|ch-sub/);
    assert.match(h, /<b class="ch-name"[^>]*>demo<\/b><button type="button" class="ch-repo"/);
  }
  assert.doesNotMatch(head({ ...run, narrow: true }).replace(/<button type="button" class="ch-repo"[\s\S]*?<\/button>/, ''), /ch-dot/);
});

test('h3: the badge says the pending number, caps at 99+, and is out when none is pending (failed ones are in the line, not the badge)', () => {
  assert.match(head({ git: g({ pr: pr({ pending: 150 }) }), narrow: true }), /<i class="ch-dot" aria-hidden="true">99\+<\/i>/);
  assert.match(head({ git: g({ pr: pr({ pending: 99 }) }), narrow: true }), />99<\/i>/);
  assert.doesNotMatch(head({ git: g({ pr: pr({ pending: 0, failed: 2 }) }), narrow: true }), /ch-dot/);
  assert.doesNotMatch(head({ git: g(), narrow: true }), /ch-dot/);
  assert.match(head({ git: g({ pr: pr({ pending: 0, failed: 2 }) }), narrow: true }), /<span class="ch-sub mono">2 failed · feat\/x<\/span>/);
});

test('h4: with no git known the head is still right: the name is the button, with no second line, and the Repo button has its plain label', () => {
  const h = head({ narrow: true });
  assert.match(h, /<button type="button" class="ch-id" data-act="zone-set" data-zone="repo" aria-label="Open the repo"/);
  assert.doesNotMatch(h, /ch-sub|ch-dot/);
  assert.match(h, /aria-label="Open the repo: tasks, changes, status and files"/);
});

test('h5: the branch and the name are text: markup in them is escaped everywhere they land', () => {
  const evil = '<img src=x onerror=alert(1)>"\'';
  const h = head({ git: g({ branch: evil, ahead: 1 }), narrow: true, name: evil });
  assert.doesNotMatch(h, /<img/);
  assert.doesNotMatch(h.replace(/&lt;img[^"]*/g, ""), /onerror/, "the text may say it, no attribute may carry it");
  assert.match(h, /&lt;img/);
});

// ---------- the stylesheet ----------
const rules = [...css.matchAll(/(?:^|\n)([^{}\n@/ ][^{}\n]*)\{([^}]*)\}/g)].flatMap((m) => m[1].split(',').map((s) => ({ sel: s.trim().replace(/\s+/g, ' '), body: m[2] })));
const rule = (sel) => { const r = rules.filter((x) => x.sel === sel); assert.ok(r.length, `a rule for ${sel}`); return r.map((x) => x.body).join(';'); };

test('c1: the block is a 44 px target that takes the room, cuts a long name and a long branch with an ellipsis instead of pushing the buttons out, and keeps a visible focus ring; the badge sits on the corner of the Repo button', () => {
  const id = rule('.ch-id');
  assert.match(id, /min-height:\s*44px/);
  assert.match(id, /flex:\s*1/);
  assert.match(id, /min-width:\s*0/);
  assert.match(rule('.ch-sub'), /text-overflow:\s*ellipsis/);
  assert.match(rule('.ch-sub'), /white-space:\s*nowrap/);
  assert.match(css, /\.ch-id:focus-visible[^{]*\{[^}]*outline:\s*2px solid var\(--blue\)/);
  assert.match(rule('.ch-repo'), /position:\s*relative/);
  assert.match(rule('.ch-dot'), /position:\s*absolute/);
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
const CONFIG = { groups: [{ name: 'G', repos: [{ id: A, name: 'repo-a', path: 'p-a' }] }], snoozed: [], dismissed: [], rooms: [], roomIssues: [] };
async function boot(width) {
  const els = {};
  const frames = [];
  const listeners = {};
  const loc = { hash: '', pathname: '/panel/', search: '' };
  const hist = { pushState(s, t, url) { const at = String(url).indexOf('#'); loc.hash = at >= 0 ? String(url).slice(at) : ''; }, replaceState() {}, back() {} };
  const tabEls = ['summary', 'work', 'conformity', 'settings'].map((t) => element({ dataset: { tab: t } }));
  const get = (sel) => (els[sel] ||= (sel === 'meta[name=token]' ? element({ content: 'token' }) : element()));
  get('#sumLayout').clientWidth = width;
  const doc = { hidden: false, querySelector: get, querySelectorAll: (s) => (String(s).includes('data-tab') ? tabEls : []), addEventListener() {}, createElement: () => element(), body: element(), activeElement: null };
  const sandbox = {
    console, document: doc, TextDecoder, AbortController, confirm: () => true, location: loc, history: hist,
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    requestAnimationFrame: (cb) => { frames.push(cb); return frames.length; }, setInterval: () => 0, setTimeout: () => 0, clearTimeout: () => {}, clearInterval: () => {},
    fetch: (url) => (String(url).startsWith('/api/config') ? Promise.resolve({ ok: true, json: async () => CONFIG }) : new Promise(() => {})),
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
  return {
    get, tick, run: (code) => vm.runInContext(code, ctx),
    head: () => get('#chatHead').html,
    screen: () => get('#sumLayout').dataset.screen,
    click: async (act, dataset = {}) => { vm.runInContext(`ACTIONS[${JSON.stringify(act)}]({ dataset: ${JSON.stringify(dataset)} })`, ctx); await tick(); },
    facts: async (facts, prs) => { vm.runInContext(`S.local[${JSON.stringify(A)}] = ${JSON.stringify(facts)}; S.prs[${JSON.stringify(A)}] = ${JSON.stringify(prs)}; draw();`, ctx); await tick(); },
  };
}
const FACTS = { branch: 'feat/x', ahead: 2, files: [], error: null };
// real pull requests: what GitHub sends, reduced by the same enrichPr the server uses
const RUN = (name, over = {}) => ({ __typename: 'CheckRun', name, status: 'COMPLETED', conclusion: 'SUCCESS', detailsUrl: `https://github.com/o/r/actions/runs/${name.length}1`, ...over });
const GH = (over = {}) => ({ number: 7, title: 'feat(x): the title', url: 'https://github.com/o/r/pull/7', headRefName: 'feat/x', baseRefName: 'main', headRefOid: 'abc123', isDraft: false, isCrossRepository: false, author: { login: 'me' }, reviewDecision: null, mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', additions: 164, deletions: 6, changedFiles: 6, statusCheckRollup: [RUN('build')], ...over });
const ROLL = { pending: [RUN('build'), RUN('test', { status: 'IN_PROGRESS', conclusion: null })], success: [RUN('build'), RUN('test')] };
const PRS = (headRefName, state) => ({ prs: [lib.enrichPr(GH({ number: 5, headRefName, statusCheckRollup: ROLL[state] }))] });

test('p1: narrow, the head says the state of the repo from the facts the page already has, and a tap on it opens Repo', async () => {
  const page = await boot(390);
  await page.click('chat-open', { id: A });
  await page.facts(FACTS, PRS('feat/x', 'pending'));
  assert.match(page.head(), /<span class="ch-sub mono">↑2 · 1 check · feat\/x<\/span>/);
  assert.match(page.head(), /<i class="ch-dot" aria-hidden="true">1<\/i>/);
  await page.click('zone-set', { zone: 'repo' });
  assert.equal(page.screen(), 'repo');
});

test('p2: a PR of ANOTHER branch is never shown as the one of this: no checks in the line, no badge', async () => {
  const page = await boot(390);
  await page.click('chat-open', { id: A });
  await page.facts(FACTS, PRS('feat/other', 'pending'));
  assert.match(page.head(), /<span class="ch-sub mono">↑2 · feat\/x<\/span>/);
  assert.doesNotMatch(page.head(), /ch-dot|checks/);
});

test('p3: the line follows the facts: when the checks finish the line and the badge change on the next draw, and a failed read of the facts says only the name', async () => {
  const page = await boot(390);
  await page.click('chat-open', { id: A });
  await page.facts(FACTS, PRS('feat/x', 'pending'));
  assert.match(page.head(), /ch-dot/);
  await page.facts(FACTS, PRS('feat/x', 'success'));
  assert.doesNotMatch(page.head(), /ch-dot/);
  assert.match(page.head(), /<span class="ch-sub mono">↑2 · feat\/x<\/span>/);
  await page.facts({ error: 'boom' }, { error: 'x' });
  assert.doesNotMatch(page.head(), /ch-sub|ch-dot/);
  assert.match(page.head(), /class="ch-id"/);
});

test('p4: from 760 px up the head is the one of always, with or without the facts', async () => {
  for (const width of [760, 900, 1440]) {
    const page = await boot(width);
    await page.click('chat-open', { id: A });
    await page.facts(FACTS, PRS('feat/x', 'pending'));
    assert.doesNotMatch(page.head(), /ch-id|ch-sub|ch-dot/, String(width));
  }
});

test('p5: crossing the cut with a resize repaints the head both ways (the second line comes and goes)', async () => {
  const page = await boot(1200);
  await page.click('chat-open', { id: A });
  await page.facts(FACTS, PRS('feat/x', 'pending'));
  assert.doesNotMatch(page.head(), /ch-sub/);
  page.get('#sumLayout').clientWidth = 500;
  page.run('applyLayout()');
  await page.tick();
  assert.match(page.head(), /ch-sub/);
  page.get('#sumLayout').clientWidth = 1200;
  page.run('applyLayout()');
  await page.tick();
  assert.doesNotMatch(page.head(), /ch-sub/);
});
