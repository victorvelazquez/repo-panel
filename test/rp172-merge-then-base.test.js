'use strict';
// RP172: after a merge made from the panel (the Merge button, or the phone sheet of RP137: both end in doMerge) SUCCEEDS, the panel sends /flow-base to the open session of that repo by itself, through the same path as the
// /flow-base button (the `pi` action). Only when the LIVE session is open and free (idle, no background jobs, no send of this page in flight): a closed, working, asking or starting session gets nothing and is never started,
// and the card keeps its /flow-base button. Never on an error, once per merge, only to the repo that merged. The tests use fakes only: /api/merge and /api/pi are recorded, nothing real is called.
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { appSource } = require('./pagesrc.js');
const lib = require('../lib.js');
const V = require('../public/view.js');
const R = require('../public/resumen.js');

const A = 'abcdef0123';
const B = '9c15a89663';
const RUN = (name) => ({ __typename: 'CheckRun', name, status: 'COMPLETED', conclusion: 'SUCCESS', detailsUrl: `https://github.com/o/r/actions/runs/${name.length}1` });
const GH = (over = {}) => ({ number: 7, title: 'feat(x): the title', url: 'https://github.com/o/r/pull/7', headRefName: 'feat/x', baseRefName: 'main', headRefOid: 'abc123', isDraft: false, isCrossRepository: false, author: { login: 'me' }, reviewDecision: null, mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', statusCheckRollup: [RUN('build'), RUN('test')], additions: 3, deletions: 1, changedFiles: 2, ...over });
const READY = (over) => lib.enrichPr(GH(over));

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
const CONFIG = { groups: [{ name: 'G', repos: [{ id: A, name: 'repo-a', path: 'p-a' }, { id: B, name: 'repo-b', path: 'p-b' }] }], snoozed: [], dismissed: [], rooms: [], roomIssues: [] };

// mergeAnswer: what the fake /api/merge does ('ok' | 'error'); branch: what it reports about the branch
async function boot({ width = 1200, mergeAnswer = 'ok', branch = 'deleted' } = {}) {
  const els = {};
  const frames = [];
  const merges = [];
  const sends = [];
  const starts = [];
  const tabEls = ['summary', 'work', 'conformity', 'settings'].map((t) => element({ dataset: { tab: t } }));
  const get = (sel) => (els[sel] ||= (sel === 'meta[name=token]' ? element({ content: 'token' }) : element()));
  get('#sumLayout').clientWidth = width;
  const doc = { hidden: false, querySelector: get, querySelectorAll: (s) => (String(s).includes('data-tab') ? tabEls : []), addEventListener() {}, createElement: () => element(), body: element(), activeElement: null };
  const sandbox = {
    console, document: doc, TextDecoder, AbortController, confirm: () => true, location: { hash: '', pathname: '/panel/', search: '' }, history: { pushState() {}, replaceState() {}, back() {} },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    requestAnimationFrame: (cb) => { frames.push(cb); return frames.length; }, setInterval: () => 0, setTimeout: () => 0, clearTimeout: () => {}, clearInterval: () => {},
    fetch: (url, opts) => {
      const u = String(url);
      if (u.startsWith('/api/config')) return Promise.resolve({ ok: true, json: async () => CONFIG });
      if (u.startsWith('/api/merge')) {
        merges.push(JSON.parse(opts.body));
        if (mergeAnswer === 'error') return Promise.resolve({ ok: false, status: 409, json: async () => ({ error: 'PR is not mergeable' }) });
        return Promise.resolve({ ok: true, json: async () => ({ merged: true, branch }) });
      }
      if (u.startsWith('/api/pi')) { sends.push(JSON.parse(opts.body)); return Promise.resolve({ ok: true, json: async () => ({ sent: true, confirmed: true }) }); }
      if (u.startsWith('/api/local')) return Promise.resolve({ ok: true, json: async () => ({ error: 'no git here', files: [] }) });
      if (u.startsWith('/api/rpc/start')) { starts.push(u); return Promise.resolve({ ok: true, json: async () => ({}) }); }
      return new Promise(() => {});
    },
  };
  const ctx = vm.createContext(sandbox);
  ctx.window = ctx;
  ctx.addEventListener = () => {};
  ctx.RepoPanelView = V;
  ctx.RepoPanelResumen = R;
  vm.runInContext(appSource(), ctx);
  const flush = () => { while (frames.length) frames.shift()(); };
  const tick = async (n = 10) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); flush(); };
  await tick();
  vm.runInContext('globalThis.__toasts = []; toast = (m) => { __toasts.push(m); }', ctx);
  const run = (code) => vm.runInContext(code, ctx);
  return {
    merges, sends, starts, tick, run, get,
    toasts: () => JSON.parse(run('JSON.stringify(__toasts)')),
    session: (id, state) => run(`S.rpc[${JSON.stringify(id)}] = ${JSON.stringify(state === undefined ? undefined : { state })}`),
    jobs: (id, n) => run(`S.summary = ${JSON.stringify({ rows: [{ id, session: { jobs: n } }], generatedAt: 'x' })}`),
    setPr: (id, pr) => run(`S.prs[${JSON.stringify(id)}] = ${JSON.stringify({ prs: [pr] })}`),
    click: async (act, dataset = {}) => { run(`ACTIONS[${JSON.stringify(act)}]({ dataset: ${JSON.stringify(dataset)} })`); await tick(); },
    merge: (id = A, n = 7) => run(`ACTIONS.merge({ dataset: { id: ${JSON.stringify(id)}, n: ${JSON.stringify(String(n))} } })`),
  };
}
const merge = async (page, id = A, n = 7) => { await page.click('merge', { id, n: String(n) }); };

test('a1: merge ok + the session is open and free: exactly ONE /flow-base goes out, to that repo, nothing is started; the toast says it', async () => {
  const page = await boot();
  page.session(A, 'idle');
  page.setPr(A, READY());
  await merge(page);
  assert.equal(page.merges.length, 1);
  assert.deepEqual(page.sends, [{ id: A, command: 'flow-base' }]);
  assert.deepEqual(page.starts, []);
  assert.equal(page.toasts()[0], '#7 merged · branch deleted · running /flow-base');
});

test('a2: the session is closed (or unknown): nothing is sent and nothing is started, the toast says to run it later; the card keeps its button', async () => {
  for (const state of ['closed', undefined]) {
    const page = await boot();
    page.session(A, state);
    page.setPr(A, READY());
    await merge(page);
    assert.equal(page.merges.length, 1, String(state));
    assert.deepEqual(page.sends, [], String(state));
    assert.deepEqual(page.starts, [], String(state));
    assert.equal(page.toasts()[0], '#7 merged · branch deleted · run /flow-base when the session is free', String(state));
  }
});

test('a3: the session is busy, asking or starting: nothing is sent', async () => {
  for (const state of ['busy', 'asking', 'starting']) {
    const page = await boot();
    page.session(A, state);
    page.setPr(A, READY());
    await merge(page);
    assert.equal(page.merges.length, 1, state);
    assert.deepEqual(page.sends, [], state);
    assert.match(page.toasts()[0], /merged · branch deleted · run \/flow-base when the session is free$/, state);
  }
});

test('a4: background jobs hold it (RP163); a row with nonsense jobs does not', async () => {
  const page = await boot();
  page.session(A, 'idle');
  page.setPr(A, READY());
  page.jobs(A, 2);
  await merge(page);
  assert.deepEqual(page.sends, []);
  assert.match(page.toasts()[0], /run \/flow-base when the session is free$/);
  const odd = await boot();
  odd.session(A, 'idle');
  odd.setPr(A, READY());
  odd.jobs(A, 'x');
  await merge(odd);
  assert.equal(odd.sends.length, 1);
});

test('a5: a send of this page in flight (S.sending) holds it', async () => {
  const page = await boot();
  page.session(A, 'idle');
  page.setPr(A, READY());
  page.run(`S.sending[${JSON.stringify(A)}] = 'flow-commit'`);
  await merge(page);
  assert.equal(page.merges.length, 1);
  assert.deepEqual(page.sends, []);
  assert.match(page.toasts()[0], /run \/flow-base when the session is free$/);
});

test('a6: a merge that fails sends nothing and keeps the old error toast; the button comes back', async () => {
  const page = await boot({ mergeAnswer: 'error' });
  page.session(A, 'idle');
  page.setPr(A, READY());
  await merge(page);
  assert.deepEqual(page.sends, []);
  assert.deepEqual(page.toasts(), ['#7: PR is not mergeable']);
  assert.equal(page.run(`S.busy['${A}:7']`), undefined);
  assert.equal(page.run(`S.merged['${A}:7']`), undefined);
});

test('a7: two quick merges of the same PR send ONE /flow-base (the second finds the button busy)', async () => {
  const page = await boot();
  page.session(A, 'idle');
  page.setPr(A, READY());
  page.merge(); page.merge(); page.merge();
  await page.tick();
  assert.equal(page.merges.length, 1);
  assert.equal(page.sends.length, 1);
});

test('a8: a merge of repo A never sends to repo B, even when B is the free one and A is not', async () => {
  const page = await boot();
  page.session(A, 'busy');
  page.session(B, 'idle');
  page.setPr(A, READY());
  await merge(page, A);
  assert.deepEqual(page.sends, []);
  const other = await boot();
  other.session(A, 'idle');
  other.session(B, 'busy');
  other.setPr(A, READY());
  await merge(other, A);
  assert.deepEqual(other.sends, [{ id: A, command: 'flow-base' }]);
});

test('a9: hostile or odd values change nothing: an unknown PR number (NaN, 0, text), an unknown repo id or an id with odd characters merge nothing and send nothing', async () => {
  const page = await boot();
  page.session(A, 'idle');
  page.setPr(A, READY());
  for (const [id, n] of [[A, 'NaN'], [A, 'x'], [A, 0], [A, 8], ['../x', 7], ['a"b<c>', 7], ['', 7], ['__proto__', 7]]) await page.click('merge', { id, n: String(n) });
  assert.deepEqual(page.merges, []);
  assert.deepEqual(page.sends, []);
  assert.deepEqual(page.toasts(), []);
});

test('b1: the phone sheet (mergeConfirm) also sends once, and the tap that only opens the sheet sends nothing', async () => {
  const page = await boot({ width: 390 });
  page.session(A, 'idle');
  page.setPr(A, READY());
  await merge(page);
  assert.deepEqual(page.sends, []);
  await page.click('merge-confirm');
  await page.click('merge-confirm');
  assert.equal(page.merges.length, 1);
  assert.deepEqual(page.sends, [{ id: A, command: 'flow-base' }]);
});

test('c1: toast words: the branch-deleted suffixes are kept, in the three cases (deleted, auto-deleted, nothing), with and without the send', async () => {
  for (const [branch, suffix] of [['deleted', ' · branch deleted'], ['auto', ' · branch auto-deleted'], [null, '']]) {
    for (const [state, tail] of [['idle', 'running /flow-base'], ['closed', 'run /flow-base when the session is free']]) {
      const page = await boot({ branch });
      page.session(A, state);
      page.setPr(A, READY());
      await merge(page);
      assert.equal(page.toasts()[0], `#7 merged${suffix} · ${tail}`, `${branch} ${state}`);
    }
  }
});

test('c2: S.merged still holds the button after the merge (sent or not), and the visible words follow the wording rule', async () => {
  for (const state of ['idle', 'busy']) {
    const page = await boot();
    page.session(A, state);
    page.setPr(A, READY());
    await merge(page);
    assert.equal(typeof page.run(`S.merged['${A}:7']`), 'number', state);
    for (const t of page.toasts()) assert.doesNotMatch(t, /pi session|pi screen|Gentle Shell/i);
  }
});

test('d1: the pi action is unchanged for a normal /flow-base click: it sends once and says what it sent', async () => {
  const page = await boot();
  page.session(A, 'idle');
  await page.click('pi', { id: A, cmd: 'flow-base' });
  assert.deepEqual(page.sends, [{ id: A, command: 'flow-base' }]);
  assert.deepEqual(page.toasts(), ['Sent /flow-base to the session']);
  assert.equal(page.run(`S.sending['${A}']`), undefined);
});
