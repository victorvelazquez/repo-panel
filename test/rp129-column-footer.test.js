'use strict';
// RP129 (S20, S21): the FIXED FOOTER of the right column (branch, commits ahead, the state of the CI and the Merge button) and the STATUS tab (the pull request of the branch, each check with its
// name and state, and Re-run failed). By decision of the person nothing new is created: the footer button is the SAME Merge action of the cards (data-act="merge", doMerge, POST /api/merge) and the
// re-run is the same one (doRerun). The server is the real guard (mergePr reads the PR again and refuses one that is not open or not ready); what this file pins is the page side, FIRST the
// security matrix: the footer button is never enabled where the card of the board has it off, and touching a disabled button calls nothing. One rule, in view.js, for the card and the footer.
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

// ---------- real pull requests: what GitHub sends, reduced by the same enrichPr the server uses ----------
const RUN = (name, over = {}) => ({ __typename: 'CheckRun', name, status: 'COMPLETED', conclusion: 'SUCCESS', detailsUrl: `https://github.com/o/r/actions/runs/${name.length}1`, ...over });
const GH = (over = {}) => ({ number: 7, title: 'feat(x): the title', url: 'https://github.com/o/r/pull/7', headRefName: 'feat/x', baseRefName: 'main', headRefOid: 'abc123', isDraft: false, isCrossRepository: false, author: { login: 'me' }, reviewDecision: null, mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', additions: 164, deletions: 6, changedFiles: 6, statusCheckRollup: [RUN('build')], ...over });
const PR = (over) => lib.enrichPr(GH(over));
const CASES = {
  ready: PR(),
  hooks: PR({ mergeStateStatus: 'HAS_HOOKS' }),
  draft: PR({ isDraft: true }),
  failed: PR({ statusCheckRollup: [RUN('build'), RUN('test', { conclusion: 'FAILURE' })] }),
  pending: PR({ statusCheckRollup: [RUN('build'), RUN('test', { status: 'IN_PROGRESS', conclusion: null })] }),
  conflict: PR({ mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY' }),
  behind: PR({ mergeStateStatus: 'BEHIND' }),
  blocked: PR({ mergeStateStatus: 'BLOCKED' }),
  unknown: PR({ mergeable: 'UNKNOWN', mergeStateStatus: 'UNKNOWN' }),
  review: PR({ reviewDecision: 'REVIEW_REQUIRED', mergeStateStatus: 'BLOCKED' }),
};
const CTXS = [{}, { busy: true }, { busy: 'done' }, { held: true }, { hold: 'Running /flow-commit (committing…): wait for it to finish' }, { busy: true, held: true, hold: 'x' }];

// ---------- the security matrix ----------
test('m0: the fixtures are real: only a clean PR (or one with hooks) is ready, and the others say why not', () => {
  assert.deepEqual(Object.entries(CASES).filter(([, p]) => p.ready).map(([k]) => k), ['ready', 'hooks']);
  for (const [k, p] of Object.entries(CASES)) if (!p.ready) assert.ok(p.blockedReason, `${k} has a reason`);
});

test('m1: the Merge button is enabled ONLY for a ready PR with nothing in flight, nothing held and nothing running in the session, in every combination', () => {
  for (const [k, pr] of Object.entries(CASES)) {
    for (const ctx of CTXS) {
      const b = V.mergeButton(pr, { method: 'squash', ...ctx });
      const want = pr.ready && !ctx.busy && !ctx.held && !ctx.hold;
      assert.equal(b.enabled, want, `${k} ${JSON.stringify(ctx)}`);
    }
  }
});

test('m2: the label and the title say what is happening: merged, merging, the method, the target, the reason it is off, or what is running', () => {
  const ready = CASES.ready;
  assert.deepEqual(V.mergeButton(ready, { method: 'squash' }), { enabled: true, label: 'Merge · squash', title: 'Merge into main' });
  assert.equal(V.mergeButton(ready, { method: 'rebase' }).label, 'Merge · rebase');
  assert.equal(V.mergeButton(ready, { method: 'squash', busy: true }).label, 'Merging…');
  assert.equal(V.mergeButton(ready, { method: 'squash', busy: 'done' }).label, 'Merged ✓');
  assert.equal(V.mergeButton(ready, { method: 'squash', held: true }).label, 'Merged ✓');
  assert.equal(V.mergeButton(CASES.draft, { method: 'squash' }).title, 'Draft pull request');
  assert.equal(V.mergeButton(CASES.conflict, { method: 'squash' }).title, CASES.conflict.blockedReason);
  assert.equal(V.mergeButton(ready, { method: 'squash', hold: 'Running x' }).title, 'Running x', 'what is running beats everything');
  assert.equal(V.mergeButton(CASES.failed, { method: 'squash', hold: 'Running x' }).title, 'Running x');
});

test('m3: without a PR the button is off, whatever else the context says, and it names the reason it was given or the default one; odd input is total', () => {
  for (const pr of [null, undefined, {}, 'x', 5, [], { ready: 'yes' }]) {
    for (const ctx of CTXS) assert.equal(V.mergeButton(pr, { method: 'squash', ...ctx }).enabled, false, JSON.stringify(pr));
  }
  assert.equal(V.mergeButton(null, { method: 'squash' }).title, 'No open pull request for this branch');
  assert.equal(V.mergeButton(null, { method: 'squash', noPr: 'Loading pull requests…' }).title, 'Loading pull requests…');
  assert.equal(V.mergeButton({ ready: true, base: 'main' }, {}).enabled, true, 'a PR object is enough; the method has a default');
  assert.match(V.mergeButton({ ready: true, base: 'main' }, {}).label, /^Merge · squash$/);
  assert.equal(V.mergeButton(null, { method: '<x>' }).label, 'Merge · squash', 'a method that is not one of the three reads as squash');
});

test('m4: re-run: shown only when there are failed runs, enabled only with nothing in flight, held or running', () => {
  for (const [k, pr] of Object.entries(CASES)) {
    for (const ctx of CTXS) {
      const b = V.rerunButton(pr, ctx);
      const show = (pr.checks.failedRuns || []).length > 0;
      assert.equal(b.show, show, k);
      assert.equal(b.enabled, show && !ctx.busy && !ctx.held && !ctx.hold, `${k} ${JSON.stringify(ctx)}`);
    }
  }
  assert.equal(V.rerunButton(CASES.failed, { hold: 'Running x' }).title, 'Running x');
  assert.equal(V.rerunButton(CASES.failed, {}).title, '');
  for (const pr of [null, undefined, {}, { checks: null }, { checks: { failedRuns: 'x' } }]) assert.deepEqual(V.rerunButton(pr, {}), { show: false, enabled: false, title: '' });
});

test('m5: the card of the board and the footer share ONE rule: both ask view.js, and the old inline rule is gone from the page', () => {
  const board = read('board.js');
  const chat = read('chat.js');
  assert.match(board, /V\.mergeButton\(/);
  assert.match(board, /V\.rerunButton\(/);
  assert.match(chat, /V\.mergeButton\(/);
  assert.match(chat, /V\.rerunButton\(/);
  for (const f of ['board.js', 'chat.js', 'resumen.js', 'tabs.js', 'actions.js']) assert.doesNotMatch(read(f), /pr\.ready && !busy && !held/, `${f} has no copy of the rule`);
});

// ---------- the footer and the Status tab: pure ----------
const MERGE = (pr, ctx = {}) => V.mergeButton(pr, { method: 'squash', ...ctx });
const GIT = (pr, over = {}) => ({ id: 'abc', branch: 'feat/x', ahead: 2, pr, merge: MERGE(pr), rerun: V.rerunButton(pr, {}), noPr: 'No open pull request for this branch', ...over });
const foot = (h) => (/<div class="col-foot"[\s\S]*$/.exec(h) || [''])[0];
const tabs = (h) => [...h.matchAll(/id="coltab-(\w+)"/g)].map((m) => m[1]);

test('r1: the footer has the branch, the commits ahead, the state of the CI and the Merge button of the PR of the branch', () => {
  const h = R.columnView({ name: 'demo', files: [], git: GIT(CASES.ready) });
  const f = foot(h);
  assert.match(f, /^<div class="col-foot" role="group" aria-label="Branch and pull request">/);
  assert.match(f, /<span class="ft-br" title="feat\/x">.*<span class="ft-name">feat\/x<\/span><\/span>/);
  assert.match(f, /<span class="chip" title="Commits ahead of the base">↑2<\/span>/);
  assert.match(f, /<span class="ft-ci ft-ci-success" role="img" aria-label="All 1 checks passed" title="All 1 checks passed">/);
  assert.match(f, /<button type="button" class="merge ft-merge" data-act="merge" data-id="abc" data-n="7" title="Merge into main">Merge · squash<\/button><\/div>$/);
  assert.doesNotMatch(f, /disabled/);
});

test('r2: the CI says running, failed or passed with the numbers; no PR, or no checks, draws no CI mark; ahead is only drawn when there are commits', () => {
  const state = (pr) => (/ft-ci-(\w+)/.exec(foot(R.columnView({ files: [], git: GIT(pr) }))) || [])[1];
  assert.equal(state(CASES.pending), 'pending');
  assert.equal(state(CASES.failed), 'failed');
  assert.equal(state(CASES.ready), 'success');
  assert.equal(state(null), undefined);
  assert.equal(state(PR({ statusCheckRollup: [] })), undefined, 'a PR with no checks has no CI mark');
  assert.match(foot(R.columnView({ files: [], git: GIT(CASES.pending) })), /aria-label="1 running · 1\/2 passed"/);
  assert.match(foot(R.columnView({ files: [], git: GIT(CASES.failed) })), /aria-label="1 failed · 1\/2 passed"/);
  assert.doesNotMatch(foot(R.columnView({ files: [], git: GIT(CASES.ready, { ahead: 0 }) })), /Commits ahead/);
  for (const ahead of [undefined, null, -1, 1.5, '3', NaN]) assert.doesNotMatch(foot(R.columnView({ files: [], git: GIT(CASES.ready, { ahead }) })), /Commits ahead/, String(ahead));
});

test('r3: the footer button is the disabled one when the rule says so, with the reason as its tooltip; without a PR it has no PR number to send', () => {
  for (const [k, pr] of Object.entries(CASES)) {
    const f = foot(R.columnView({ files: [], git: GIT(pr) }));
    const btn = /<button type="button" class="merge ft-merge"[^>]*>/.exec(f)[0];
    assert.equal(/ disabled/.test(btn), !pr.ready, k);
    assert.match(btn, new RegExp(`data-n="${pr.number}"`));
  }
  const none = foot(R.columnView({ files: [], git: GIT(null, { merge: MERGE(null) }) }));
  const btn = /<button type="button" class="merge ft-merge"[^>]*>/.exec(none)[0];
  assert.match(btn, / disabled title="No open pull request for this branch"/);
  assert.doesNotMatch(btn, /data-n=/);
  const busy = foot(R.columnView({ files: [], git: GIT(CASES.ready, { merge: MERGE(CASES.ready, { busy: true }) }) }));
  assert.match(busy, / disabled title="Merge into main">Merging…<\/button>/);
});

test('r4: the footer is total: no branch, odd values, and nothing from the repo or the PR becomes markup', () => {
  const evil = PR({ title: '<img src=x onerror=1>', headRefName: '<b>x</b>', baseRefName: '"><i>', url: 'javascript:alert(1)', statusCheckRollup: [RUN('<script>', { detailsUrl: 'javascript:alert(2)' })] });
  const h = R.columnView({ name: '<b>', files: [], git: GIT(evil, { branch: '<u>x</u>', id: '"><s>', merge: MERGE(evil) }) });
  assert.doesNotMatch(h, /<img|<script|<u>|<b>x|<i>|<s>|javascript:/);
  assert.match(h, /&lt;u&gt;x&lt;\/u&gt;/);
  for (const git of [{}, { id: 'a' }, { id: 'a', branch: 5 }, { id: 'a', pr: 'x', merge: 'x' }, null, 7]) {
    const out = R.columnView({ files: [], git });
    assert.doesNotMatch(out, /undefined|NaN|null/, JSON.stringify(git));
  }
  assert.match(foot(R.columnView({ files: [], git: { id: 'a', merge: MERGE(null) } })), /<span class="ft-name">—<\/span>/, 'no branch');
});

test('r5: with the git data the column has FOUR tabs in the order Changes, Files, Status, Tasks, and Status counts the pending checks; without it the column is as before', () => {
  assert.deepEqual(tabs(R.columnView({ files: [], git: GIT(CASES.ready) })), ['changes', 'files', 'status', 'tasks']);
  assert.deepEqual(R.COLUMN_TABS, ['changes', 'files', 'status', 'tasks']);
  assert.deepEqual(tabs(R.columnView({ files: [] })), ['changes', 'files', 'tasks']);
  assert.doesNotMatch(R.columnView({ files: [] }), /col-foot/);
  assert.match(R.columnView({ files: [], git: GIT(CASES.pending) }), /<span class="lb">Status<\/span><span class="n y">1<\/span><\/button>/);
  assert.doesNotMatch(R.columnView({ files: [], git: GIT(CASES.ready) }), /<span class="n y">/);
  assert.match(R.columnView({ files: [], git: GIT(CASES.ready), tab: 'status' }), /id="coltab-status"[^>]*aria-selected="true"/);
  assert.match(R.columnView({ files: [], tab: 'status' }), /id="coltab-changes"[^>]*aria-selected="true"/, 'no Status tab without the data: it reads as Changes');
  assert.match(R.columnView({ files: [], git: GIT(CASES.ready), tab: 'status' }), /aria-labelledby="coltab-status"/);
});

test('r6: the Status tab has the PR (number as a safe link, state, title, branches and size), a summary of the checks, each check with its state, and what blocks the merge', () => {
  const h = R.columnView({ files: [], git: GIT(CASES.conflict), tab: 'status' });
  assert.match(h, /<div class="st-pr"><div class="st-t"><a class="st-n" href="https:\/\/github\.com\/o\/r\/pull\/7" target="_blank" rel="noopener noreferrer">#7<\/a><span class="chip green">open<\/span><\/div><div class="st-ti">feat\(x\): the title<\/div><div class="st-mt">feat\/x → main · \+164 −6 · 6 files<\/div><\/div>/);
  assert.match(h, /<p class="rs-sub" role="status">Merge conflicts with the base branch<\/p>/, 'the reason is there when it is not about the checks');
  const f = R.columnView({ files: [], git: GIT(CASES.failed), tab: 'status' });
  assert.match(f, /<div class="ck-r"><span class="ck-i ck-failed" aria-hidden="true">.*<\/span><span class="ck-nm" title="test">test<\/span><span class="ck-s">Failed<\/span><a class="ck-l" href="https:\/\/github\.com\/o\/r\/actions\/runs\/41" target="_blank" rel="noopener noreferrer" aria-label="Open test on GitHub">↗<\/a><\/div>/);
  assert.match(f, /ck-i ck-success[\s\S]*<span class="ck-s">Successful<\/span>/);
  const p = R.columnView({ files: [], git: GIT(CASES.pending), tab: 'status' });
  assert.match(p, /<span class="ck-s">In progress<\/span>/);
  const seen = (x) => x.replace(/ (?:title|aria-label)="[^"]*"/g, ''); // what is on screen: the tooltip of the off button may explain itself on hover
  assert.doesNotMatch(seen(p), /Checks still running|still running/, 'the spinner and the count already say it');
  assert.doesNotMatch(seen(f), /Some checks failed/, 'a failed check is in its row, not repeated as a reason');
  assert.deepEqual([...R.columnView({ files: [], git: GIT(CASES.pending), tab: 'status' }).matchAll(/ck-c ck-(\w+)/g)].map((m) => m[1]), ['pending', 'success']);
});

test('r7: a draft says draft, a review that is asked for or against shows its chip, and the size is left out when GitHub did not send it', () => {
  assert.match(R.columnView({ files: [], git: GIT(CASES.draft), tab: 'status' }), /<span class="chip gray">draft<\/span>/);
  assert.doesNotMatch(R.columnView({ files: [], git: GIT(CASES.draft), tab: 'status' }), /chip green">open/);
  assert.match(R.columnView({ files: [], git: GIT(CASES.review), tab: 'status' }), /<span class="chip yellow">review required<\/span>/);
  assert.match(R.columnView({ files: [], git: GIT(PR({ reviewDecision: 'CHANGES_REQUESTED' })), tab: 'status' }), /<span class="chip red">changes requested<\/span>/);
  assert.match(R.columnView({ files: [], git: GIT(PR({ additions: undefined, deletions: undefined, changedFiles: undefined })), tab: 'status' }), /<div class="st-mt">feat\/x → main<\/div>/);
});

test('r8: Re-run failed is the same button of the card (data-act rerun) and follows its rule; no failed runs, no button', () => {
  const on = R.columnView({ files: [], git: GIT(CASES.failed), tab: 'status' });
  assert.match(on, /<button type="button" class="ck-rerun" data-act="rerun" data-id="abc" data-n="7">Re-run failed<\/button>/);
  const held = R.columnView({ files: [], git: GIT(CASES.failed, { rerun: V.rerunButton(CASES.failed, { hold: 'Running x' }) }), tab: 'status' });
  assert.match(held, /<button type="button" class="ck-rerun" data-act="rerun" data-id="abc" data-n="7" disabled title="Running x">Re-run failed<\/button>/);
  assert.doesNotMatch(R.columnView({ files: [], git: GIT(CASES.ready), tab: 'status' }), /ck-rerun/);
  assert.doesNotMatch(R.columnView({ files: [], git: GIT(CASES.pending), tab: 'status' }), /ck-rerun/);
});

test('r9: without a PR the Status tab says why (none, loading, unavailable, no remote); the reason is the one it was given, escaped', () => {
  assert.match(R.columnView({ files: [], git: GIT(null, { merge: MERGE(null) }), tab: 'status' }), /<p class="rs-sub" role="status">No open pull request for this branch<\/p>/);
  assert.match(R.columnView({ files: [], git: GIT(null, { noPr: 'Loading pull requests…', merge: MERGE(null) }), tab: 'status' }), /Loading pull requests…/);
  assert.match(R.columnView({ files: [], git: GIT(null, { noPr: '<b>x</b>', merge: MERGE(null) }), tab: 'status' }), /&lt;b&gt;x&lt;\/b&gt;/);
});

test('r10: a PR with many checks is cut at 50 rows with the rest counted, and a link that is not https is never a link', () => {
  const many = PR({ statusCheckRollup: Array.from({ length: 55 }, (_, i) => RUN(`c${i}`)) });
  const h = R.columnView({ files: [], git: GIT(many), tab: 'status' });
  assert.equal((h.match(/<div class="ck-r">/g) || []).length, 50);
  assert.match(h, /<p class="rs-sub" role="status">and 5 more<\/p>/);
  const odd = PR({ url: 'ftp://x', statusCheckRollup: [RUN('a', { detailsUrl: 'http://insecure' }), RUN('b', { detailsUrl: 'javascript:1' }), RUN('c', { detailsUrl: undefined })] });
  const o = R.columnView({ files: [], git: GIT(odd), tab: 'status' });
  assert.equal((o.match(/class="ck-l"/g) || []).length, 1, 'only the plain http(s) link of a check stays');
  assert.doesNotMatch(o, /ftp:|javascript:/);
  assert.match(o, /<span class="st-n">#7<\/span>/, 'a number with no safe URL is plain text');
});

test('s1: the styles: the footer stays at the bottom of the column in every tab, the checks have their states, the pending ones spin unless the person asked for less motion', () => {
  assert.match(css, /#colBody\s*\{[^}]*display:\s*flex[^}]*flex-direction:\s*column[^}]*min-height:\s*100%/);
  assert.match(css, /\.col-pane\s*\{[^}]*flex:\s*1/);
  assert.match(css, /\.col-foot\s*\{[^}]*position:\s*sticky[^}]*bottom:\s*0/);
  assert.match(css, /\.ft-name\s*\{[^}]*text-overflow:\s*ellipsis/);
  assert.match(css, /\.ft-merge\s*\{[^}]*flex:\s*none/);
  for (const k of ['success', 'pending', 'failed']) assert.match(css, new RegExp(`\\.ck-i\\.ck-${k}\\b|\\.ck-${k}\\b`), k);
  assert.match(css, /\.ck-nm\s*\{[^}]*text-overflow:\s*ellipsis/);
  assert.match(css, /\.col-tab \.n\.y\s*\{/);
  assert.match(css, /@keyframes ck-spin/);
  assert.match(css, /prefers-reduced-motion[\s\S]*?\.ck-pending[\s\S]*?animation:\s*none/);
  const q = /@container col \(max-width:\s*300px\)\s*\{([\s\S]*?)\n\}/.exec(css);
  assert.match(q[1], /\.ck-s\b/, 'the state words go in a narrow column');
  assert.match(q[1], /\.ck-c \.w\b/);
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
  const key = (k, target) => { const e = { type: 'keydown', key: k, target, prevented: false, preventDefault() { e.prevented = true; } }; for (const fn of docL.keydown || []) fn(e); return e; };
  const click = (el) => { const e = { type: 'click', target: { closest: (sel) => (sel === '[data-act]' ? el : null) } }; for (const fn of docL.click || []) fn(e); };
  return { get, flush, tick, fetches, routes, key, click, run: (c) => vm.runInContext(c, ctx) };
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
const tab = (page, t) => { page.run(`ACTIONS['col-tab']({ dataset: { tab: '${t}' } })`); page.flush(); };
const col = (page) => page.get('#colBody').html;
const footBtn = (page) => (/<button type="button" class="merge ft-merge"[^>]*>[^<]*<\/button>/.exec(col(page)) || [''])[0];
const posts = (page, url) => page.fetches.filter((f) => f.method === 'POST' && f.url === url);

test('p1: with the column in, the footer is drawn in EVERY tab and its button is the Merge of the PR of the branch', async () => {
  const page = boot();
  await open(page);
  for (const t of ['changes', 'status', 'tasks']) {
    tab(page, t);
    assert.match(col(page), /<div class="col-foot"/, t);
    assert.match(footBtn(page), /data-act="merge" data-id="abc" data-n="7" title="Merge into main">Merge · squash<\/button>/, t);
    assert.doesNotMatch(footBtn(page), /disabled/, t);
  }
  assert.match(col(page), /<span class="ft-name">feat\/x<\/span>/);
  assert.match(col(page), /Commits ahead of the base">↑2</);
});

test('p2: touching the enabled footer button sends the SAME order as the card: POST /api/merge with the repo, the number, the method and the branch choice', async () => {
  const page = boot();
  page.routes['/api/merge'] = () => Promise.resolve(ok({ branch: 'kept' }));
  await open(page);
  page.click({ dataset: { act: 'merge', id: 'abc', n: '7' }, disabled: false, tagName: 'BUTTON' });
  await page.tick();
  assert.deepEqual(posts(page, '/api/merge').map((p) => p.body), [{ id: 'abc', number: 7, method: 'squash', deleteBranch: true }]);
  assert.match(footBtn(page), / disabled /, 'after the merge the button stays off');
  assert.match(footBtn(page), />Merged ✓</);
});

test('p3: a second touch while the merge is in flight, or on a held one, sends nothing more', async () => {
  const page = boot();
  page.routes['/api/merge'] = () => new Promise(() => {});
  await open(page);
  const el = { dataset: { act: 'merge', id: 'abc', n: '7' }, disabled: false, tagName: 'BUTTON' };
  page.click(el);
  page.click(el);
  page.click(el);
  await page.tick();
  assert.equal(posts(page, '/api/merge').length, 1, 'doMerge ignores a PR that is already merging');
  assert.match(footBtn(page), / disabled title="Merge into main">Merging…</);
});

test('p4: THE MATRIX on the page: for every kind of PR the footer button is off where the card is off, and touching it calls nothing', async () => {
  for (const [k, pr] of Object.entries(CASES)) {
    const page = boot({ prs: { prs: [pr] } });
    page.routes['/api/merge'] = () => Promise.resolve(ok({}));
    await open(page);
    const btn = footBtn(page);
    assert.equal(/ disabled /.test(btn), !pr.ready, `${k}: ${btn}`);
    if (!pr.ready) assert.ok(btn.includes(`title="${pr.blockedReason.replace(/&/g, '&amp;')}"`) || /title="/.test(btn), `${k} has a tooltip`);
    // the event the page really handles: a button with the disabled flag is dropped before any action runs
    page.click({ dataset: { act: 'merge', id: 'abc', n: String(pr.number) }, disabled: !pr.ready, tagName: 'BUTTON' });
    await page.tick();
    assert.equal(posts(page, '/api/merge').length, pr.ready ? 1 : 0, k);
  }
});

test('p5: the footer only ever points at the PR of the CURRENT branch: a ready PR of another branch is not offered, and the right one is picked among many', async () => {
  const other = PR({ number: 9, headRefName: 'feat/other' });
  const page = boot({ prs: { prs: [other] } });
  await open(page);
  assert.match(footBtn(page), / disabled title="No open pull request for this branch">/);
  assert.doesNotMatch(footBtn(page), /data-n=/);
  tab(page, 'status');
  assert.match(col(page), /No open pull request for this branch/);
  const mine = PR({ number: 8, headRefName: 'feat/x' });
  const many = boot({ prs: { prs: [other, mine, PR({ number: 10, headRefName: 'feat/third' })] } });
  await open(many);
  assert.match(footBtn(many), /data-n="8"/);
  const onMain = boot({ branch: 'main', prs: { prs: [other, mine] } });
  await open(onMain);
  assert.match(footBtn(onMain), / disabled /, 'on the base branch no PR belongs to it');
  const detached = boot({ branch: null, prs: { prs: [other, mine] } });
  await open(detached);
  assert.match(footBtn(detached), / disabled /, 'a detached HEAD has no PR either');
});

test('p6: what is not known yet is never read as "ready": loading, a failed read, and a repo with no remote each keep the button off and say so', async () => {
  const a = boot({ prs: null });
  await open(a);
  assert.match(footBtn(a), / disabled title="Loading pull requests…">/);
  const b = boot({ prs: { error: 'gh failed' } });
  await open(b);
  assert.match(footBtn(b), / disabled title="Pull requests unavailable">/);
  const c = boot({ prs: { noRemote: true, prs: [] } });
  await open(c);
  assert.match(footBtn(c), / disabled title="This repository has no GitHub remote">/);
  const d = boot({ prs: { prs: [] } });
  await open(d);
  assert.match(footBtn(d), / disabled title="No open pull request for this branch">/);
});

test('p7: while a command of the session is running the footer is off with its reason, like the card; a merge in flight turns off the Re-run too', async () => {
  const page = boot({ prs: { prs: [CASES.failed] } });
  await open(page);
  tab(page, 'status');
  assert.match(col(page), /class="ck-rerun" data-act="rerun" data-id="abc" data-n="7">Re-run failed/);
  page.run("S.sending.abc = 'flow-commit'");
  page.run('draw()');
  page.flush();
  assert.match(footBtn(page), / disabled title="Running [^"]*">/);
  assert.match(col(page), /class="ck-rerun" data-act="rerun" data-id="abc" data-n="7" disabled title="Running /);
  const ready = boot();
  await open(ready);
  ready.run("S.sending.abc = 'flow-commit'");
  ready.run('draw()');
  ready.flush();
  assert.match(footBtn(ready), / disabled title="Running /);
  assert.equal(posts(ready, '/api/merge').length, 0);
});

test('p8: Re-run failed in the Status tab is the same action of the card (POST /api/rerun with the repo and the number)', async () => {
  const page = boot({ prs: { prs: [CASES.failed] } });
  page.routes['/api/rerun'] = () => Promise.resolve(ok({ rerun: 1 }));
  await open(page);
  tab(page, 'status');
  page.click({ dataset: { act: 'rerun', id: 'abc', n: '7' }, disabled: false, tagName: 'BUTTON' });
  await page.tick();
  assert.deepEqual(posts(page, '/api/rerun').map((p) => p.body), [{ id: 'abc', number: 7 }]);
  page.click({ dataset: { act: 'rerun', id: 'abc', n: '7' }, disabled: true, tagName: 'BUTTON' });
  await page.tick();
  assert.equal(posts(page, '/api/rerun').length, 1, 'a disabled one sends nothing');
});

test('p9: the Status tab lists the checks of the PR and the yellow badge counts the pending ones; the tree and the tasks still work next to it', async () => {
  const page = boot({ prs: { prs: [CASES.pending] } });
  await open(page);
  assert.match(col(page), /<span class="lb">Status<\/span><span class="n y">1<\/span>/);
  tab(page, 'status');
  assert.match(col(page), /<span class="ck-nm" title="test">test<\/span><span class="ck-s">In progress<\/span>/);
  assert.match(col(page), /<span class="ck-nm" title="build">build<\/span><span class="ck-s">Successful<\/span>/);
  tab(page, 'changes');
  assert.match(col(page), /data-act="changes-file" data-path="a\.js"/);
  tab(page, 'tasks');
  assert.match(col(page), /class="tk-bar"/);
});

test('p10: the arrows now cycle Changes, Files, Status, Tasks and back; a fresh opening starts on Changes again', async () => {
  const page = boot();
  await open(page);
  const el = (t) => ({ dataset: { act: 'col-tab', tab: t }, tagName: 'BUTTON' });
  const sel = () => (/id="coltab-(\w+)"[^>]*aria-selected="true"/.exec(col(page)) || [])[1];
  page.key('ArrowRight', el('changes')); page.flush();
  assert.equal(sel(), 'files');
  page.key('ArrowRight', el('files')); page.flush();
  assert.equal(sel(), 'status');
  page.key('ArrowRight', el('status')); page.flush();
  assert.equal(sel(), 'tasks');
  page.key('ArrowRight', el('tasks')); page.flush();
  assert.equal(sel(), 'changes');
  page.key('ArrowLeft', el('changes')); page.flush();
  assert.equal(sel(), 'tasks');
  page.key('Home', el('tasks')); page.flush();
  assert.equal(sel(), 'changes');
  page.key('End', el('changes')); page.flush();
  assert.equal(sel(), 'tasks');
});

test('p11: under 1100 px there is no column, so no footer and no merge button of it; and nothing is written by drawing the footer', async () => {
  const page = boot({ width: 900 });
  await open(page);
  assert.equal(col(page), '');
  const wide = boot();
  await open(wide);
  const writes = () => wide.fetches.filter((f) => f.method !== 'GET').map((f) => f.url);
  const before = writes();
  for (const t of ['status', 'tasks', 'changes', 'status']) tab(wide, t);
  assert.deepEqual(writes(), before, 'drawing the footer and switching tabs write nothing');
});
