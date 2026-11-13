'use strict';
// RP176: everywhere the panel offered the /flow-commit button (and its variants) it now offers /flow-ship (commit, check Git, publish the PR, one run).
// The server keeps accepting the old keys (an old page may still send them) and adds the two new ones. The holds, the labels and the verdict are the ones
// of /flow-commit, with the names changed; the verdict of /flow-ship waits longer (the chain is a commit plus a pull request). Fakes only, no network.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { appSource } = require('./pagesrc.js');

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'rp176-'));
const REPO = path.join(scratch, 'My Repo');
fs.mkdirSync(REPO);
process.env.REPO_PANEL_CONFIG = path.join(scratch, 'config.json');
test.after(() => fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 5 }));

const lib = require('../lib.js');
const pi = require('../server/pi.js');
const V = require('../public/view.js');
const R = require('../public/resumen.js');
const { createServer } = require('../server/http.js');
const { createRpcHost } = require('../server/rpchost.js');
const { findRepo } = require('../server/config.js');

// ---------- the pure buttons ----------
const NOW = Date.parse('2026-11-13T12:00:00Z');
const FILES = [{ path: 'a.js', status: 'M', added: 1, deleted: 0 }];
const local = (o = {}) => ({ files: FILES, stagedCount: 0, branch: 'feat/x', base: 'main', ahead: 0, behind: 0, head: 'abc', noUpstream: false, lastChangeMs: 0, ...o });
const open = (o = {}) => ({ prs: [], stale: null, ...o });
const declared = (state) => ({ available: true, state, next: 'x', detail: null, at: new Date(NOW - 60000).toISOString(), stale: false, reason: null });
const one = (arr) => { assert.equal(arr.length, 1, JSON.stringify(arr)); return arr[0]; };
const buttons = (l, p, st, ctx) => V.flowButtons(l, p, st, { now: NOW, ...ctx });

test('b1: a dirty tree offers /flow-ship; staged files offer /flow-ship --unstage; retry words both', () => {
  assert.deepEqual(buttons(local(), open(), {}, {}), [{ cmd: 'flow-ship', label: '/flow-ship' }]);
  const staged = one(buttons(local({ stagedCount: 2 }), open(), {}, {}));
  assert.deepEqual([staged.cmd, staged.label], ['flow-ship-unstage', '/flow-ship --unstage']);
  assert.match(staged.reason, /^\/flow-ship needs an empty index\./);
  assert.equal(one(buttons(local(), open(), {}, { retry: true })).label, 'Retry /flow-ship');
  assert.equal(one(buttons(local({ stagedCount: 1 }), open(), {}, { retry: true })).label, 'Retry /flow-ship --unstage');
});

test('b2: the hold table of /flow-ship is the one /flow-commit had: session busy or asking, jobs, quiet period, declared working; the override lifts the last two only', () => {
  const busy = one(buttons(local(), open(), {}, { session: 'busy' }));
  assert.deepEqual([busy.cmd, busy.disabled, busy.reason], ['flow-ship', true, 'the session is still working']);
  assert.equal(one(buttons(local(), open(), {}, { session: 'asking' })).disabled, true);
  const jobs = one(buttons(local(), open(), {}, { session: 'idle', jobs: 2 }));
  assert.deepEqual([jobs.disabled, jobs.reason], [true, '2 background jobs are running']);
  const quiet = one(buttons(local({ lastChangeMs: NOW - 1000 }), open(), {}, {}));
  assert.deepEqual([quiet.cmd, quiet.disabled, quiet.reason], ['flow-ship', true, 'files changed a few seconds ago']);
  const quietStaged = one(buttons(local({ lastChangeMs: NOW - 1000, stagedCount: 1 }), open(), {}, {}));
  assert.deepEqual([quietStaged.cmd, quietStaged.disabled], ['flow-ship-unstage', true]);
  assert.deepEqual(buttons(local(), open(), declared('working'), {}), [], 'declared working hides it');
  for (const st of [declared('working'), {}]) {
    assert.equal(one(buttons(local({ lastChangeMs: NOW - 1000 }), open(), st, { override: true })).disabled, undefined, 'the override lifts quiet and declared-state holds');
  }
  assert.deepEqual(buttons(local(), open(), declared('working'), { override: true }).map((b) => b.cmd), ['flow-ship']);
  // The session and jobs holds are NOT lifted by the declared-state override of the page: only the menu item does it, as before.
  assert.equal(one(buttons(local(), open(), {}, { session: 'busy', override: true })).disabled, undefined);
  assert.equal(one(buttons(local(), open(), {}, { running: { cmd: 'flow-ship', label: 'shipping…' } })).disabled, true);
  assert.match(one(buttons(local(), open(), {}, { running: { cmd: 'flow-ship', label: 'shipping…' } })).reason, /^Running \/flow-ship/);
});

test('b3: a stale branch with changes still offers /flow-base --stash, never /flow-ship; the override item says /flow-ship', () => {
  const merged = { via: 'merged', pr: 7, reason: 'Merged: run /flow-base' };
  assert.deepEqual(buttons(local(), open({ stale: merged }), {}, {}).map((b) => b.cmd), ['flow-base-stash']);
  assert.deepEqual(V.commitOverrideItem(declared('working'), { now: NOW }), { act: 'show-commit', label: 'Show /flow-ship anyway' });
  assert.deepEqual(V.commitOverrideItem({}, { session: 'idle', jobs: 2 }), { act: 'show-commit', label: 'Show /flow-ship anyway' });
  assert.equal(V.commitOverrideItem({}, { session: 'idle', jobs: 2, stale: true }), null);
});

test('b4: a clean branch with commits still offers /flow-pr; nothing here ever offers /flow-commit', () => {
  assert.deepEqual(buttons(local({ files: [], ahead: 1 }), open(), {}, {}).map((b) => b.cmd), ['flow-pr']);
  const texts = [];
  for (const l of [local(), local({ stagedCount: 1 }), local({ lastChangeMs: NOW - 1000 }), local({ files: [], ahead: 1 })]) {
    for (const ctx of [{}, { retry: true }, { session: 'busy' }, { jobs: 3 }, { override: true }, { verdict: 'attention' }]) {
      for (const b of buttons(l, open(), {}, ctx)) texts.push(JSON.stringify(b));
    }
  }
  assert.ok(texts.length > 10);
  assert.equal(texts.filter((t) => /flow-commit/.test(t)).length, 0);
});

test('b5: the "/ Actions" menu draws /flow-ship in the deliver slot (default label and with a flow button), and no /flow-commit', () => {
  const row = { action: { kind: 'deliver' }, next: null };
  const idle = R.actionMenu(row, { live: 'free', changes: { files: 0, ahead: 0 } });
  assert.deepEqual(idle.items.map((i) => i.label), ['/flow-next', '/flow-ship', '/flow-pr', '/flow-base']);
  for (const f of [{ cmd: 'flow-ship', label: '/flow-ship' }, { cmd: 'flow-ship-unstage', label: '/flow-ship --unstage' }, { cmd: 'flow-ship', label: 'Retry /flow-ship', disabled: true, reason: 'files changed a few seconds ago' }]) {
    const m = R.actionMenu(row, { live: 'free', changes: { files: 1, ahead: 0 }, flow: f });
    assert.equal(m.items[1].cmd, f.cmd);
    assert.equal(m.items[1].label, f.label);
    assert.equal(m.items[1].available, !f.disabled);
    const html = R.actionButtonsHtml(m, 'id1');
    assert.doesNotMatch(html, /flow-commit/);
    if (!f.disabled) assert.match(html, new RegExp(`data-cmd="${f.cmd}"`));
  }
  assert.doesNotMatch(JSON.stringify(R.actionMenu(row, { live: 'busy', changes: {} })), /flow-commit/);
});

// ---------- the verdict ----------
test('v1: /flow-ship is judged from Git: committed and published (HEAD changed, clean, nothing ahead) is ok; the PR stage failing is attention with /flow-pr still offered', () => {
  const sent = { cmd: 'flow-ship', at: NOW - 120000, head: 'old', files: 1, ahead: 0 };
  const done = V.flowVerdict(sent, local({ files: [], head: 'new', ahead: 0 }), 'idle', open({ prs: [{ head: 'feat/x' }] }), NOW);
  assert.equal(done.state, 'ok');
  const prFailed = V.flowVerdict(sent, local({ files: [], head: 'new', ahead: 1 }), 'idle', open(), NOW);
  assert.equal(prFailed.state, 'attention');
  assert.match(prFailed.reason, /pull request was not published/);
  assert.doesNotMatch(prFailed.reason, /flow-commit/);
  // The clean tree with commits ahead and no PR is exactly what the /flow-pr button needs: the attention verdict must not hide it.
  const l = local({ files: [], head: 'new', ahead: 1 });
  assert.deepEqual(buttons(l, open(), {}, { verdict: null }).map((b) => b.cmd), ['flow-pr']);
  const notCommitted = V.flowVerdict(sent, local({ files: FILES, head: 'old' }), 'idle', open(), NOW);
  assert.equal(notCommitted.state, 'attention');
  assert.match(notCommitted.reason, /1 file still uncommitted after \/flow-ship/);
  assert.equal(V.flowVerdict(sent, local({ files: FILES, head: 'old' }), 'busy', open(), NOW).state, 'running');
  assert.equal(V.flowVerdict({ ...sent, at: NOW - 5000 }, local({ files: FILES, head: 'old' }), 'idle', open(), NOW).state, 'running');
  const closed = V.flowVerdict(sent, local({ files: [], head: 'old' }), 'closed', open(), NOW);
  assert.match(closed.reason, /The session closed before \/flow-ship made a commit/);
  assert.equal(V.flowVerdict({ ...sent, cmd: 'flow-ship-unstage' }, local({ files: [], head: 'new', ahead: 0, stagedCount: 2 }), 'idle', open(), NOW).state, 'attention', 'unstage must leave an empty index');
  assert.match(V.flowVerdict({ ...sent, cmd: 'flow-ship-unstage' }, local({ files: [], head: 'new', ahead: 0, stagedCount: 2 }), 'idle', open(), NOW).reason, /still staged after \/flow-ship --unstage/);
  assert.equal(V.flowVerdict({ ...sent, cmd: 'flow-ship-unstage' }, local({ files: [], head: 'new', ahead: 0 }), 'idle', open(), NOW).state, 'ok');
  assert.equal(done.label, 'shipping…');
});

test('v2: timing: a ship whose session state is unknown stays running 30 minutes (a commit plus a pull request), then needs attention; /flow-commit keeps its 15 minutes', () => {
  const MIN = 60 * 1000;
  const at = NOW - 20 * MIN;
  const files = local({ files: [], head: 'old' }); // clean and HEAD unchanged: the wait is what decides
  assert.equal(V.flowVerdict({ cmd: 'flow-ship', at, head: 'old', files: 1 }, files, 'unknown', open(), NOW).state, 'running', 'minute 20');
  const late = V.flowVerdict({ cmd: 'flow-ship', at: NOW - 31 * MIN, head: 'old', files: 1 }, files, 'unknown', open(), NOW);
  assert.equal(late.state, 'attention');
  assert.match(late.reason, /30 minutes after \/flow-ship/);
  assert.equal(V.flowVerdict({ cmd: 'flow-commit', at, head: 'old', files: 1 }, files, 'unknown', open(), NOW).state, 'attention', 'the old command keeps its short wait');
  // A session that is working never expires, however long it takes.
  assert.equal(V.flowVerdict({ cmd: 'flow-ship', at: NOW - 3 * 60 * MIN, head: 'old', files: 1 }, files, 'busy', open(), NOW).state, 'running');
  assert.equal(V.flowVerdict({ cmd: 'flow-ship', at: NOW - 3 * 60 * MIN, head: 'old', files: 1 }, files, 'asking', open(), NOW).state, 'running');
});

test('v3: every command the page judges, including both ship keys, is judged and has a running label, a color and a text', () => {
  assert.equal(V.runColor('flow-ship'), 'blue');
  assert.equal(V.runColor('flow-ship-unstage'), 'blue');
  assert.equal(V.sendingVerdict('flow-ship').label, 'shipping…');
  assert.equal(V.sendingVerdict('flow-ship-unstage').label, 'shipping…');
  const actions = fs.readFileSync(path.join(__dirname, '..', 'public', 'actions.js'), 'utf8');
  const judged = /const JUDGED_CMDS = (\[[^\]]*\]);/.exec(actions);
  assert.ok(judged, 'JUDGED_CMDS found');
  const list = JSON.parse(judged[1].replace(/'/g, '"'));
  for (const k of ['flow-ship', 'flow-ship-unstage', 'flow-pr', 'flow-base', 'flow-base-stash']) assert.ok(list.includes(k), k);
  assert.ok(!list.includes('flow-commit') || list.includes('flow-commit-unstage'), 'old keys, if still judged, are judged together');
});

// ---------- the server ----------
const ID = lib.repoId(REPO);
const ACTIVE = { id: 'gentle-shell', command: 'C:\\L\\gentle-shell.exe', agentDir: 'C:\\a' };
const NEVER = async () => { throw new Error('must not be read'); };
const freePort = () => new Promise((resolve) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });
const call = (port, method, p, { token, body } = {}) => new Promise((resolve, reject) => {
  const data = body === undefined ? null : JSON.stringify(body);
  const req = http.request({ host: '127.0.0.1', port, path: p, method, headers: { ...(token ? { 'x-token': token } : {}), ...(data ? { 'content-type': 'application/json' } : {}) } }, (res) => {
    let d = ''; res.on('data', (c) => { d += c; }); res.on('end', () => { let json = null; try { json = JSON.parse(d); } catch { /* not json */ } resolve({ status: res.statusCode, body: d, json }); });
  });
  req.on('error', reject);
  req.end(data);
});
async function withServer(fn) {
  fs.writeFileSync(process.env.REPO_PANEL_CONFIG, JSON.stringify({ groups: [{ name: 'g', repos: [{ path: REPO }] }] }));
  const made = [];
  const createClient = (opts) => {
    const c = { opts, reqs: [], start: async () => ({}), request: async (type, fields) => { c.reqs.push([type, fields]); return { disposition: 'started' }; }, answerDialog: () => false, pendingDialogs: () => [], state: () => 'idle', close() {} };
    made.push(c);
    return c;
  };
  const host = createRpcHost({ resolve: async () => ({ active: ACTIVE }), repoOf: findRepo, publish() {}, createClient });
  await host.start(ID);
  const port = await freePort();
  const deps = { noSummaryStore: true, rpcHost: host, wait: NEVER, requirements: NEVER, prs: async () => ({ repo: {}, prs: [] }), guard: pi.sendGuard(() => 1_000_000) };
  const server = createServer(port, deps);
  await new Promise((r) => server.listen(port, '127.0.0.1', r));
  try {
    const token = /name="?token"? content="([0-9a-f]+)"/.exec((await call(port, 'GET', '/')).body)[1];
    const prompts = () => made.flatMap((c) => c.reqs).filter(([type]) => type === 'prompt').map(([, f]) => f.message);
    return await fn({ post: (p, body) => call(port, 'POST', p, { token, body }), prompts });
  } finally { await new Promise((r) => server.close(r)); }
}

test('s1: PI_COMMANDS adds the two ship keys and keeps every old one, with the exact order text', () => {
  assert.deepEqual(lib.PI_COMMANDS, {
    'flow-ship': '/flow-ship', 'flow-ship-unstage': '/flow-ship --unstage',
    'flow-commit': '/flow-commit', 'flow-commit-unstage': '/flow-commit --unstage',
    'flow-pr': '/flow-pr', 'flow-base': '/flow-base', 'flow-base-stash': '/flow-base --stash', 'flow-next': '/flow-next',
  });
});

test('s2: through the server, flow-ship and flow-ship-unstage go out as /flow-ship and /flow-ship --unstage, and the old keys still go out unchanged', async () => {
  for (const [key, text] of [['flow-ship', '/flow-ship'], ['flow-ship-unstage', '/flow-ship --unstage'], ['flow-commit', '/flow-commit'], ['flow-commit-unstage', '/flow-commit --unstage']]) {
    await withServer(async ({ post, prompts }) => {
      const r = await post('/api/pi', { id: ID, command: key });
      assert.deepEqual([r.status, r.json], [200, { sent: true, confirmed: true }], key);
      assert.deepEqual(prompts(), [text], key);
    });
  }
});

test('s3: ABUSE: unknown keys, __proto__, odd casing and look-alikes of the ship keys still answer 400 and send nothing', async () => {
  await withServer(async ({ post, prompts }) => {
    for (const c of ['/flow-ship', 'flow-ship --unstage', 'Flow-Ship', 'FLOW-SHIP', 'flow-ship-UNSTAGE', 'flow-ship ', ' flow-ship', 'flow-ship\n', 'flow-ship-stash', 'flow-shipper', 'constructor', '__proto__', 'toString', 'hasOwnProperty', 'rm -rf']) {
      const r = await post('/api/pi', { id: ID, command: c });
      assert.deepEqual([r.status, r.json && r.json.error], [400, 'Unknown command'], JSON.stringify(c));
    }
    for (const c of [null, 5, ['flow-ship'], { toString: 'flow-ship' }]) assert.equal((await post('/api/pi', { id: ID, command: c })).status, 400, JSON.stringify(c));
    assert.deepEqual(prompts(), []);
  });
});

// ---------- the page: every place ----------
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
const PID = 'abcdef0123';
async function boot() {
  const els = {};
  const frames = [];
  const tabEls = ['summary', 'work', 'conformity', 'settings'].map((t) => element({ dataset: { tab: t } }));
  const get = (sel) => (els[sel] ||= (sel === 'meta[name=token]' ? element({ content: 'token' }) : element()));
  get('#sumLayout').clientWidth = 1200;
  const doc = { hidden: false, querySelector: get, querySelectorAll: (s) => (String(s).includes('data-tab') ? tabEls : []), addEventListener() {}, createElement: () => element(), body: element(), activeElement: null };
  const sandbox = {
    console, document: doc, TextDecoder, AbortController, confirm: () => true, location: { hash: '', pathname: '/', search: '' }, history: { pushState() {}, replaceState() {}, back() {} },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    requestAnimationFrame: (cb) => { frames.push(cb); return frames.length; }, setInterval: () => 0, setTimeout: () => 0, clearTimeout: () => {}, clearInterval: () => {},
    fetch: (url) => (String(url).startsWith('/api/config') ? Promise.resolve({ ok: true, json: async () => ({ groups: [{ name: 'G', repos: [{ id: PID, name: 'repo-a', path: 'p' }] }], snoozed: [], dismissed: [], rooms: [], roomIssues: [] }) }) : new Promise(() => {})),
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
  const run = (code) => vm.runInContext(code, ctx);
  return {
    run, get, tick,
    set: async (l, { prs = '{ prs: [], stale: null }', rpc = 'idle', menu = null, sent = null, pistatus = 'idle', showCommit = false, summary = null } = {}) => {
      run(`S.rpc['${PID}'] = { state: '${rpc}' }; S.state['${PID}'] = {}; S.prs['${PID}'] = ${prs}; S.local['${PID}'] = ${JSON.stringify(l)}; S.menu = ${menu ? `'${PID}|repo'` : 'null'};`);
      run(`S.showCommit.delete('${PID}'); ${showCommit ? `S.showCommit.add('${PID}');` : ''} delete S.sent['${PID}']; delete S.pistatus['${PID}']; ${sent ? `S.sent['${PID}'] = ${JSON.stringify(sent)}; S.pistatus['${PID}'] = '${pistatus}';` : ''}`);
      run(`S.summary = ${JSON.stringify({ rows: [summary || { id: PID, name: 'repo-a', group: 'G', room: null, branch: 'main', needs: false, rank: 9, progress: { total: null }, next: { id: 'X1', entrega: 'A task' }, blocking: [], lastMovement: {}, session: { state: 'free' }, action: { kind: 'deliver', label: 'Deliver', pr: null } }], generatedAt: 'x' })}; draw()`);
      await tick();
    },
    app: () => get('#app').html,
    summaryHtml: () => get('#summary').html,
  };
}
const dirtyLocal = (o = {}) => ({ branch: 'feat/x', base: 'main', files: FILES, ahead: 0, behind: 0, head: 'a', noUpstream: false, stagedCount: 0, lastChangeMs: 0, error: null, ...o });
const cmdsOf = (html) => [...html.matchAll(/data-cmd="([^"]+)"/g)].map((m) => m[1]);

test('p1: the board card and the Summary card offer /flow-ship in every state (dirty, staged, quiet, override, retry, held by session, held by jobs, stale) and never /flow-commit anywhere in the markup', async () => {
  const page = await boot();
  const states = [
    ['dirty', dirtyLocal(), {}, 'flow-ship'],
    ['staged', dirtyLocal({ stagedCount: 2, stagedPaths: ['a.js', 'b.js'] }), {}, 'flow-ship-unstage'],
    ['quiet', dirtyLocal({ lastChangeMs: Date.now() }), {}, 'flow-ship'],
    ['override', dirtyLocal({ lastChangeMs: Date.now() }), { showCommit: true }, 'flow-ship'],
    ['retry', dirtyLocal(), { sent: { cmd: 'flow-ship', at: 1, head: 'a', branch: 'feat/x', files: 1, ahead: 0 } }, 'flow-ship'],
    ['retry staged', dirtyLocal({ stagedCount: 1 }), { sent: { cmd: 'flow-ship-unstage', at: 1, head: 'a', branch: 'feat/x', files: 1, ahead: 0 } }, 'flow-ship-unstage'],
    ['held by session', dirtyLocal(), { rpc: 'busy' }, 'flow-ship'],
    ['held by asking', dirtyLocal(), { rpc: 'asking' }, 'flow-ship'],
    ['held by jobs', dirtyLocal(), { summary: { id: PID, name: 'repo-a', group: 'G', room: null, branch: 'main', needs: false, rank: 9, progress: { total: null }, next: { id: 'X1', entrega: 'A task' }, blocking: [], lastMovement: {}, session: { state: 'free', jobs: 2 }, action: { kind: 'deliver', label: 'Deliver', pr: null } } }, 'flow-ship'],
    ['dirty + stale', dirtyLocal(), { prs: `{ prs: [], stale: { via: 'merged', pr: 7, reason: 'Merged' } }` }, 'flow-base-stash'],
  ];
  for (const [name, l, opts, want] of states) {
    for (const menu of [false, true]) {
      await page.set(l, { ...opts, menu });
      assert.ok(cmdsOf(page.app()).includes(want), `${name}: board offers ${want}: ${cmdsOf(page.app())}`);
      assert.doesNotMatch(page.app(), /flow-commit/, `${name}: board markup (menu ${menu})`);
      assert.doesNotMatch(page.summaryHtml(), /flow-commit/, `${name}: summary markup (menu ${menu})`);
      if (want !== 'flow-base-stash') assert.ok(cmdsOf(page.summaryHtml()).includes(want) || /disabled|rs-card/.test(page.summaryHtml()), `${name}: summary`);
    }
  }
  await page.set(dirtyLocal(), { menu: true, rpc: 'busy' });
  assert.match(page.app(), /data-act="show-commit"[^>]*>Show \/flow-ship anyway</);
  await page.set(dirtyLocal(), { sent: { cmd: 'flow-ship', at: 1, head: 'a', branch: 'feat/x', files: 1, ahead: 0 } });
  assert.match(page.app(), /Retry \/flow-ship</);
  assert.match(page.app(), /1 file still uncommitted after \/flow-ship/);
  await page.set(dirtyLocal({ stagedCount: 2, stagedPaths: ['a.js'] }));
  assert.match(page.app(), /staged: \/flow-ship needs an empty index/);
  await page.set(dirtyLocal(), { rpc: 'busy' });
  const held = /<button[^>]*data-cmd="flow-ship"[^>]*>/.exec(page.app());
  assert.ok(held && / disabled/.test(held[0]), 'held by the session');
  await page.set(dirtyLocal({ files: [], ahead: 1, head: 'new' }), { sent: { cmd: 'flow-ship', at: 1, head: 'old', branch: 'feat/x', files: 1, ahead: 0 } });
  assert.deepEqual(cmdsOf(page.app()).filter((c) => c.startsWith('flow-')), ['flow-pr'], 'PR stage failed: /flow-pr is still offered');
});

test('p2: the card action of the Summary says /flow-ship in its label, and the stylesheet colors the ship buttons like the commit ones', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'style.css'), 'utf8');
  for (const k of ['flow-ship', 'flow-ship-unstage']) assert.match(css, new RegExp(`data-cmd="${k}"`), k);
  assert.doesNotMatch(css, /flow-commit/);
  const summary = fs.readFileSync(path.join(__dirname, '..', 'server', 'summary.js'), 'utf8');
  assert.match(summary, /Deliver the changes \(\/flow-ship, \/flow-pr\)/);
  assert.doesNotMatch(summary, /flow-commit/);
});
