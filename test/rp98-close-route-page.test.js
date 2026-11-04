'use strict';
// RP98 (S2, S3), the route and the page: POST /api/rpc/close stops the session of ONE repo and releases its adoption (so the chat comes back to the list of sessions); the chat head gets a
// "Close session" button that asks first when the session is working; the chat's ✕ still only hides the chat. The host is the real createRpcHost over a fake client; the config is a scratch file.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { appSource } = require('./pagesrc.js');

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'rp98-route-'));
const REPO = path.join(scratch, 'My Repo');
const REPO2 = path.join(scratch, 'Other Repo');
fs.mkdirSync(REPO);
fs.mkdirSync(REPO2);
process.env.REPO_PANEL_CONFIG = path.join(scratch, 'config.json');
test.after(() => fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 5 }));

const lib = require('../lib.js');
const R = require('../public/resumen.js');
const V = require('../public/view.js');
const { createServer } = require('../server/http.js');
const { createRpcHost } = require('../server/rpchost.js');
const { adoptIfNone } = require('../server/sessions.js');
const { findRepo, loadConfig } = require('../server/config.js');
const { createEventHub } = require('../server/events.js');

const ID = lib.repoId(REPO);
const ID2 = lib.repoId(REPO2);
const ACTIVE = { id: 'gentle-shell', command: 'C:\\L\\gentle-shell.exe', agentDir: 'C:\\a' };
const ADOPTED = (id) => ({ id, name: id, adoptedAt: '2026-01-01T00:00:00.000Z' });
const writeConfig = (sessions = {}) => fs.writeFileSync(process.env.REPO_PANEL_CONFIG, JSON.stringify({ groups: [{ name: 'g', repos: [{ path: REPO }, { path: REPO2 }] }], sessions }));
const CLOSED = { state: 'closed', pendingDialogs: [], sessionId: null };

function fakeFactory() {
  const made = [];
  const createClient = (opts) => {
    const c = { opts, closed: 0, start: async () => ({}), request: async () => ({}), answerDialog: () => false, pendingDialogs: () => [], state: () => 'idle', close: () => { c.closed++; } };
    made.push(c);
    return c;
  };
  return { made, createClient };
}
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
  const f = fakeFactory();
  const port = await freePort();
  const hub = createEventHub();
  const host = createRpcHost({ resolve: async () => ({ active: ACTIVE }), repoOf: findRepo, publish: (id, p) => hub.emit('rpc', id, p), adopt: adoptIfNone, createClient: f.createClient }); // adopt: as the server wires its own host
  const server = createServer(port, { noSummaryStore: true, hub, rpcHost: host });
  await new Promise((r) => server.listen(port, '127.0.0.1', r));
  try {
    const token = /name="?token"? content="([0-9a-f]+)"/.exec((await call(port, 'GET', '/')).body)[1];
    return await fn({ port, token, post: (p, body) => call(port, 'POST', `/api/rpc/${p}`, { token, body }), made: f.made, host });
  } finally { await new Promise((r) => server.close(r)); }
}
const sessionsNow = () => loadConfig().sessions || {};

test('r1: the route needs the token and does nothing without it', async () => {
  writeConfig({ [ID]: ADOPTED('mine-1') });
  await withServer(async ({ port, post, made }) => {
    await post('start', { id: ID });
    for (const t of [undefined, 'wrong']) {
      const res = await call(port, 'POST', '/api/rpc/close', { token: t, body: { id: ID } });
      assert.equal(res.status, 401);
    }
    assert.equal(made[0].closed, 0, 'the session is still alive');
    assert.equal(sessionsNow()[ID].id, 'mine-1', 'and still adopted');
  });
});

test('r2: closing stops the session and releases ITS adoption only (another repo keeps its session adopted)', async () => {
  writeConfig({ [ID]: ADOPTED('mine-1'), [ID2]: ADOPTED('other-1') });
  await withServer(async ({ post, made, host }) => {
    assert.equal((await post('start', { id: ID })).status, 200);
    assert.equal((await post('start', { id: ID2 })).status, 200);
    const res = await post('close', { id: ID });
    assert.equal(res.status, 200);
    assert.deepEqual(res.json, CLOSED);
    assert.deepEqual([made[0].closed, made[1].closed], [1, 0]);
    assert.equal(host.stateOf(ID), 'closed');
    assert.equal(host.stateOf(ID2), 'idle');
    assert.equal(sessionsNow()[ID], undefined, 'released: the chat goes back to the list');
    assert.equal(sessionsNow()[ID2].id, 'other-1');
  });
});

test('r3: a repo with an adopted session and no live process is released too, and closing twice is fine', async () => {
  writeConfig({ [ID]: ADOPTED('mine-1') });
  await withServer(async ({ post, made }) => {
    assert.deepEqual((await post('close', { id: ID })).json, CLOSED);
    assert.equal(sessionsNow()[ID], undefined);
    assert.equal((await post('close', { id: ID })).status, 200);
    assert.equal(made.length, 0, 'nothing was started');
  });
});

test('r4: an unknown repo is 404 (the id is not echoed) and nothing is released; a bad body is 400 and nothing changes', async () => {
  writeConfig({ [ID]: ADOPTED('mine-1') });
  await withServer(async ({ post, made }) => {
    await post('start', { id: ID });
    const unknown = await post('close', { id: 'ECHOME-unknown' });
    assert.equal(unknown.status, 404);
    assert.equal(unknown.body.includes('ECHOME'), false);
    for (const body of [undefined, {}, { id: 5 }, { id: '' }, [], 'text', { id: 'x'.repeat(101) }]) {
      assert.equal((await post('close', body)).status, 400, JSON.stringify(body));
    }
    assert.equal(made[0].closed, 0);
    assert.equal(sessionsNow()[ID].id, 'mine-1');
  });
});

test('r5: fields the browser adds (command, cwd, args, session) are ignored: the close is the same', async () => {
  writeConfig({ [ID]: ADOPTED('mine-1'), [ID2]: ADOPTED('other-1') });
  await withServer(async ({ post, made }) => {
    await post('start', { id: ID });
    const res = await post('close', { id: ID, command: 'calc.exe', cwd: 'C:\\', args: ['--evil'], session: 'other-1', key: ID2 });
    assert.equal(res.status, 200);
    assert.equal(made[0].closed, 1);
    assert.equal(sessionsNow()[ID], undefined);
    assert.equal(sessionsNow()[ID2].id, 'other-1', 'a session named by the browser is not touched');
  });
});

test('r6: after a close the repo starts a NEW session, which is adopted again (the list, then a new session)', async () => {
  writeConfig({ [ID]: ADOPTED('mine-1') });
  await withServer(async ({ post, made }) => {
    await post('start', { id: ID });
    await post('close', { id: ID });
    const again = await post('start', { id: ID });
    assert.equal(again.status, 200);
    assert.equal(made.length, 2);
    assert.equal(sessionsNow()[ID].id, `panel-my-repo-${ID.slice(0, 8)}`);
  });
});

// ---------- the page ----------
test('p0: Close session is next to the session state (RP72 keeps the chat head to the repo name and the ✕): the helper draws it only when there is a session, disabled while closing', () => {
  assert.match(R.sessionCloseHtml(true, false), /^<button type="button" class="ss-close" data-act="session-close" title="[^"]+">Close session<\/button>$/);
  assert.match(R.sessionCloseHtml(true, true), /data-act="session-close" disabled /);
  assert.equal(R.sessionCloseHtml(false, false), '');
  const adopted = { id: 'abc', info: { adopted: { id: 's1' } } };
  assert.doesNotMatch(R.chatHead(adopted, { name: 'demo', live: true }), /session-close|ss-close/, 'the head is only the name and the ✕');
  assert.match(R.chatHead(adopted, { name: 'demo' }), /data-act="chat-close"/);
});

function element(extra = {}) {
  const el = { html: '', hidden: false, dataset: {}, disabled: false, value: '', checked: false, textContent: '', title: '', attrs: {}, children: [], writes: 0,
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false }, style: { setProperty() {} }, addEventListener() {}, setAttribute() {}, querySelector: () => null, querySelectorAll: () => [], closest: () => null,
    showModal() {}, close() {}, focus() {}, append() {}, get innerHTML() { return el.html; }, set innerHTML(v) { el.html = String(v); el.writes++; }, ...extra };
  return el;
}
const ok = (b) => ({ ok: true, json: async () => b });
const bad = (status) => ({ ok: false, status, statusText: 'Failed', json: async () => ({ error: 'nope' }) });
function loadPage() {
  const frames = []; const fetches = []; const routes = []; const confirms = [];
  const state = { answer: true };
  const els = {};
  const tabEls = ['summary', 'work', 'conformity'].map((t) => element({ dataset: { tab: t } }));
  const get = (sel) => (els[sel] ||= (sel === 'meta[name=token]' ? element({ content: 'token' }) : element()));
  const doc = { hidden: false, querySelector: get, querySelectorAll: (s) => (String(s).includes('data-tab') ? tabEls : []), addEventListener() {}, createElement: () => element(), body: element(), activeElement: null };
  const respond = (url, opts) => { for (const [m, fn] of routes) if (m(url)) return fn(url, opts); return new Promise(() => {}); };
  const ctx = vm.createContext({
    console, document: doc, location: { hash: '' }, localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    requestAnimationFrame: (cb) => { frames.push(cb); return frames.length; }, setInterval: () => 1, setTimeout: () => 0, clearTimeout: () => {}, AbortController,
    confirm: (m) => { confirms.push(m); return state.answer; },
    fetch: (url, opts = {}) => { fetches.push({ url, method: opts.method || 'GET', body: opts.body }); return respond(url, opts); },
  });
  ctx.window = ctx; ctx.addEventListener = () => {}; ctx.RepoPanelView = V; ctx.RepoPanelResumen = R;
  vm.runInContext(appSource(), ctx);
  const flush = () => { while (frames.length) frames.shift()(); };
  const tick = async (n = 20) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); flush(); };
  return { ctx, get, tick, routes, fetches, confirms, state, run: (c) => vm.runInContext(c, ctx) };
}
const card = (id, name) => ({ id, name, group: 'G', room: null, branch: 'main', progress: { total: 1, completada: 0, enRevision: 0, bloqueada: 0, pendiente: 1, enCurso: 0 }, session: { state: 'free' }, next: null, blocking: [], lastMovement: {}, activity: null });
const INFO = (adopted) => ({ key: 'abc', adopted, adoptedFound: !!adopted, sessions: [{ id: 's1', name: 'First', updatedAt: '2026-01-01T00:00:00.000Z', lastMessage: 'hi' }], live: { state: 'none', count: 0 } });
async function boot({ adopted = { id: 's1', name: 'First', adoptedAt: 'x' } } = {}) {
  const page = loadPage();
  const S = page.run('S');
  S.groups = [{ name: 'G', repos: [{ id: 'abc', name: 'demo', path: 'p' }] }];
  S.summary = { rows: [card('abc', 'demo')], generatedAt: 'x' };
  const world = { adopted };
  page.world = world;
  page.routes.push([(u) => u.startsWith('/api/sessions?'), () => Promise.resolve(ok(INFO(world.adopted)))]);
  page.routes.push([(u) => u.startsWith('/api/chat?'), () => Promise.resolve(ok({ items: [], truncated: false }))]);
  page.routes.push([(u) => u === '/api/rpc/close', () => { world.adopted = null; return Promise.resolve(ok(CLOSED)); }]);
  page.run("ACTIONS['chat-open']({ dataset: { id: 'abc' } })");
  await page.tick();
  return page;
}
const closes = (page) => page.fetches.filter((f) => f.url === '/api/rpc/close');
const head = (page) => page.get('#chatHead').html;
const sess = (page) => page.get('#sessState').html;
const body = (page) => page.get('#chatBody').html;

test('p1: with an adopted session the head has the button; pressing it stops the session, the chat comes back to the list of sessions and the session shows as closed', async () => {
  const page = await boot();
  assert.match(sess(page), /data-act="session-close"/);
  assert.doesNotMatch(head(page), /session-close/, 'not in the header');
  await page.run("ACTIONS['session-close']({ dataset: {} })");
  await page.tick();
  assert.equal(closes(page).length, 1);
  assert.deepEqual(JSON.parse(closes(page)[0].body), { id: 'abc' });
  assert.equal(closes(page)[0].method, 'POST');
  assert.equal(page.run('S.rpc.abc.state'), 'closed');
  assert.match(body(page), /No session is adopted for this folder/);
  assert.match(body(page), /data-act="chat-adopt"/, 'the sessions of the folder are listed to open one');
  assert.doesNotMatch(sess(page), /session-close/, 'nothing left to close');
});

test('p2: a session that is working or asking is confirmed first: refusing sends nothing, accepting closes it', async () => {
  for (const st of ['busy', 'asking']) {
    const page = await boot();
    page.run(`S.rpc.abc = V.rpcFromStatus(undefined, { state: '${st}', pendingDialogs: [], sessionId: 's1' })`);
    page.state.answer = false;
    await page.run("ACTIONS['session-close']({ dataset: {} })");
    await page.tick();
    assert.equal(page.confirms.length, 1, st);
    assert.equal(closes(page).length, 0, `${st}: refused`);
    page.state.answer = true;
    await page.run("ACTIONS['session-close']({ dataset: {} })");
    await page.tick();
    assert.equal(closes(page).length, 1, `${st}: accepted`);
  }
});

test('p3: an idle or closed session is closed without asking', async () => {
  const page = await boot();
  page.run("S.rpc.abc = V.rpcFromStatus(undefined, { state: 'idle', pendingDialogs: [], sessionId: 's1' })");
  await page.run("ACTIONS['session-close']({ dataset: {} })");
  await page.tick();
  assert.equal(page.confirms.length, 0);
  assert.equal(closes(page).length, 1);
});

test('p4: a failed close keeps the session as it was, shows the error and leaves the button usable', async () => {
  const page = await boot();
  page.routes.unshift([(u) => u === '/api/rpc/close', () => Promise.resolve(bad(500))]);
  page.run("S.rpc.abc = V.rpcFromStatus(undefined, { state: 'idle', pendingDialogs: [], sessionId: 's1' })");
  await page.run("ACTIONS['session-close']({ dataset: {} })");
  await page.tick();
  assert.equal(page.run('S.rpc.abc.state'), 'idle', 'not marked closed');
  assert.equal(page.run('!!S.chat.closing'), false, 'ready for another try');
  assert.match(sess(page), /session-close/);
  assert.equal(page.world.adopted.id, 's1');
});

test('p5: a second press while the first close is on its way sends nothing more', async () => {
  const page = await boot();
  let release;
  page.routes.unshift([(u) => u === '/api/rpc/close', () => new Promise((r) => { release = () => { page.world.adopted = null; r(ok(CLOSED)); }; })]);
  const first = page.run("ACTIONS['session-close']({ dataset: {} })");
  await page.tick();
  assert.match(sess(page), /data-act="session-close" disabled /, 'the button is disabled while the close is on its way');
  page.run("ACTIONS['session-close']({ dataset: {} })"); // not awaited: if it were let through it would hang on its own pending answer
  await page.tick();
  assert.equal(closes(page).length, 1);
  release();
  await first;
  await page.tick();
  assert.equal(closes(page).length, 1);
});

test('p6: the ✕ of the chat still only hides it: no session is closed and the adoption stays', async () => {
  const page = await boot();
  page.run("ACTIONS['chat-close']({ dataset: {} })");
  await page.tick();
  assert.equal(closes(page).length, 0);
  assert.equal(page.run('S.chat.id'), null);
  assert.equal(page.world.adopted.id, 's1');
});

test('p7: the close is for the open chat only: with no chat open the action sends nothing', async () => {
  const page = await boot();
  page.run("ACTIONS['chat-close']({ dataset: {} })");
  await page.tick();
  await page.run("ACTIONS['session-close']({ dataset: {} })");
  await page.tick();
  assert.equal(closes(page).length, 0);
});

test('p8: the README says what the button does and that the ✕ only hides the chat', () => {
  const readme = fs.readFileSync(path.join(__dirname, '..', 'README.md'), 'utf8').replace(/\r\n/g, '\n');
  assert.match(readme, /Close session/);
  assert.match(readme, /POST \/api\/rpc\/close/);
});
