'use strict';
// RP99 (S2, S4, S6): the list of sessions of a repo with Open and New session. `POST /api/rpc/start { id, new: true }` starts a session with its OWN id (the id of RP97 plus a unique part, so "new" never
// resumes an old one) and is refused with 409 when the repo already has a live or an adopted session; the list shows up to 20 sessions with Open (adopt, the process starts when the first message is sent)
// and New session; with the list in view the composer cannot send and says why (RP98 found that typing there started and adopted a new session without telling). No process is started.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { appSource } = require('./pagesrc.js');

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'rp99-'));
const REPO = path.join(scratch, 'My Repo');
fs.mkdirSync(REPO);
process.env.REPO_PANEL_CONFIG = path.join(scratch, 'config.json');
test.after(() => fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 5 }));

const lib = require('../lib.js');
const R = require('../public/resumen.js');
const V = require('../public/view.js');
const { createRpcHost, sessionIdFor } = require('../server/rpchost.js');
const { SESSION_ID } = require('../server/sessions.js');
const { createServer } = require('../server/http.js');
const { loadConfig } = require('../server/config.js');
const { createEventHub } = require('../server/events.js');

const ID = lib.repoId(REPO);
const ACTIVE = { id: 'gentle-shell', command: 'C:\\L\\gentle-shell.exe', agentDir: 'C:\\a' };

// ---------- the host ----------
const REPOS = { aaa: { id: 'aaa', path: 'C:\\repos\\alpha' }, bbb: { id: 'bbb', path: 'C:\\repos\\beta' } };
const repoOf = (id) => { if (!REPOS[id]) { const e = new Error('Unknown repository'); e.status = 404; throw e; } return REPOS[id]; };
function hostWith(over = {}) {
  const made = [];
  const adopted = {};
  const createClient = (opts) => { const c = { opts, closed: 0, start: async () => ({}), request: async () => ({}), answerDialog: () => false, pendingDialogs: () => [], state: () => 'idle', close() { c.closed++; } }; made.push(c); return c; };
  const host = createRpcHost({
    resolve: async () => ({ active: ACTIVE }), repoOf, createClient, publish() {}, adoptedOf: (id) => adopted[id] || null,
    adopt: (id, sid) => { if (!adopted[id]) adopted[id] = { id: sid }; }, ...over,
  });
  return { host, made, adopted };
}
const sidOf = (c) => c.opts.args[3];

test('h1: a new session gets the id of the repo plus a unique part, and it is adopted', async () => {
  const { host, made, adopted } = hostWith({ suffix: () => 'abc123' });
  await host.start('aaa', { fresh: true });
  assert.equal(sidOf(made[0]), 'panel-alpha-aaa-abc123');
  assert.deepEqual(adopted.aaa, { id: 'panel-alpha-aaa-abc123' });
});

test('h2: two new sessions of the same repo (one after closing the other) have different ids, each adopted when it started', async () => {
  let n = 0;
  const { host, made, adopted } = hostWith({ suffix: () => `s${++n}` });
  await host.start('aaa', { fresh: true });
  await host.close('aaa');
  delete adopted.aaa; // what the route does when it closes
  await host.start('aaa', { fresh: true });
  assert.deepEqual([sidOf(made[0]), sidOf(made[1])], ['panel-alpha-aaa-s1', 'panel-alpha-aaa-s2']);
  assert.equal(adopted.aaa.id, 'panel-alpha-aaa-s2');
});

test('h3: with no injected suffix the unique part is random: letters and digits, always different, and the id stays valid', async () => {
  const seen = new Set();
  for (let i = 0; i < 12; i++) {
    const { host, made } = hostWith();
    await host.start('aaa', { fresh: true });
    assert.match(sidOf(made[0]), /^panel-alpha-aaa-[0-9a-f]{6}$/);
    assert.match(sidOf(made[0]), SESSION_ID);
    seen.add(sidOf(made[0]));
  }
  assert.ok(seen.size >= 11, `${seen.size} different ids out of 12`);
});

test('h4: a long folder name keeps the whole id within 80 characters', async () => {
  const long = 'a'.repeat(200);
  const { host, made } = hostWith({ suffix: () => 'abc123', repoOf: () => ({ id: 'aaaaaaaa11', path: `C:\\x\\${long}` }) });
  await host.start('aaa', { fresh: true });
  assert.ok(sidOf(made[0]).length <= 80, `${sidOf(made[0]).length} characters`);
  assert.match(sidOf(made[0]), SESSION_ID);
  assert.ok(sidOf(made[0]).endsWith('-aaaaaaaa-abc123'));
});

test('h5: a new session is refused with 409 when the repo has a live session, and nothing is created', async () => {
  const { host, made } = hostWith();
  await host.start('aaa');
  await assert.rejects(host.start('aaa', { fresh: true }), (e) => e.status === 409 && /close/i.test(e.message));
  assert.equal(made.length, 1);
  assert.equal(host.stateOf('aaa'), 'idle');
});

test('h5b: also when the live session was never adopted (the adoption failed): the live check stands by itself', async () => {
  const { host, made } = hostWith({ adopt() { throw new Error('disk full'); } });
  await host.start('aaa');
  assert.equal(host.stateOf('aaa'), 'idle');
  await assert.rejects(host.start('aaa', { fresh: true }), (e) => e.status === 409);
  assert.equal(made.length, 1);
});

test('h6: a new session is refused with 409 when the repo has an adopted session (live or not), and nothing is created', async () => {
  const { host, made } = hostWith({ adoptedOf: () => ({ id: 'mine-1' }) });
  await assert.rejects(host.start('aaa', { fresh: true }), (e) => e.status === 409);
  assert.equal(made.length, 0);
  assert.equal(host.stateOf('aaa'), 'closed');
});

test('h7: a start that is not new is as before: the adopted id, or the id of RP97, and `fresh: false` is the same as nothing', async () => {
  const a = hostWith();
  await a.host.start('aaa');
  assert.equal(sidOf(a.made[0]), 'panel-alpha-aaa');
  const b = hostWith();
  await b.host.start('aaa', { fresh: false });
  assert.equal(sidOf(b.made[0]), 'panel-alpha-aaa');
  const c = hostWith({ adoptedOf: () => ({ id: 'mine-1' }) });
  await c.host.start('aaa');
  assert.equal(sidOf(c.made[0]), 'mine-1');
});

test('h8: the id of a new session is never the id sessionIdFor gives (the one that would resume the old session)', async () => {
  const { host, made } = hostWith();
  await host.start('aaa', { fresh: true });
  assert.notEqual(sidOf(made[0]), sessionIdFor(REPOS.aaa, null));
});

test('h9: an unknown repo is 404 also for a new session, and a new session of another repo does not care about this one', async () => {
  const { host, made } = hostWith();
  await assert.rejects(host.start('nope', { fresh: true }), (e) => e.status === 404);
  await host.start('aaa');
  await host.start('bbb', { fresh: true });
  assert.equal(made.length, 2);
});

// ---------- the route ----------
const writeConfig = (sessions = {}) => fs.writeFileSync(process.env.REPO_PANEL_CONFIG, JSON.stringify({ groups: [{ name: 'g', repos: [{ path: REPO }] }], sessions }));
const freePort = () => new Promise((resolve) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });
const call = (port, method, p, { token, body } = {}) => new Promise((resolve, reject) => {
  const data = body === undefined ? null : JSON.stringify(body);
  const req = http.request({ host: '127.0.0.1', port, path: p, method, headers: { ...(token ? { 'x-token': token } : {}), ...(data ? { 'content-type': 'application/json' } : {}) } }, (res) => {
    let d = ''; res.on('data', (c) => { d += c; }); res.on('end', () => { let json = null; try { json = JSON.parse(d); } catch { /* not json */ } resolve({ status: res.statusCode, body: d, json }); });
  });
  req.on('error', reject);
  req.end(data);
});
async function withServer(fn, { gate = null } = {}) {
  const made = [];
  const createClient = (opts) => { const c = { opts, start: () => (gate ? gate.promise : Promise.resolve({})), request: async () => ({}), answerDialog: () => false, pendingDialogs: () => [], state: () => 'idle', close() {} }; made.push(c); return c; };
  const port = await freePort();
  const server = createServer(port, { noSummaryStore: true, hub: createEventHub(), rpcResolve: async () => ({ active: ACTIVE }), rpcClient: createClient });
  await new Promise((r) => server.listen(port, '127.0.0.1', r));
  try {
    const token = /name="?token"? content="([0-9a-f]+)"/.exec((await call(port, 'GET', '/')).body)[1];
    return await fn({ port, token, post: (p, body) => call(port, 'POST', `/api/rpc/${p}`, { token, body }), api: (method, p, body) => call(port, method, p, { token, body }), made });
  } finally { if (gate) gate.release(); await new Promise((r) => server.close(r)); } // a failed assertion must not leave a start pending: closing the server waits for it
}
const adoptedId = () => (loadConfig().sessions || {})[ID] && loadConfig().sessions[ID].id;

test('r1: POST /api/rpc/start { new: true } starts a session with its own id and adopts it', async () => {
  writeConfig();
  await withServer(async ({ post, made }) => {
    const res = await post('start', { id: ID, new: true });
    assert.equal(res.status, 200);
    assert.equal(res.json.state, 'idle');
    assert.match(res.json.sessionId, new RegExp(`^panel-my-repo-${ID.slice(0, 8)}-[0-9a-f]{6}$`));
    assert.equal(adoptedId(), res.json.sessionId);
    assert.equal(made[0].opts.args[3], res.json.sessionId);
  });
});

test('r2: new must be exactly true or absent: another value is 400 and starts nothing', async () => {
  writeConfig();
  await withServer(async ({ post, made }) => {
    for (const v of ['yes', 1, 0, null, [], {}, 'true']) assert.equal((await post('start', { id: ID, new: v })).status, 400, JSON.stringify(v));
    assert.equal(made.length, 0);
    assert.equal(adoptedId(), undefined);
  });
});

test('r3: new while the repo has an adopted session is 409 and changes nothing; while it has a live one too', async () => {
  writeConfig({ [ID]: { id: 'mine-1', name: 'Mine', adoptedAt: '2026-01-01T00:00:00.000Z' } });
  await withServer(async ({ post, made }) => {
    const res = await post('start', { id: ID, new: true });
    assert.equal(res.status, 409);
    assert.equal(made.length, 0);
    assert.equal(adoptedId(), 'mine-1');
    await post('start', { id: ID });
    assert.equal((await post('start', { id: ID, new: true })).status, 409);
    assert.equal(made.length, 1);
  });
});

test('r4: a new session, close it, a new session again: two different ids, the second adopted', async () => {
  writeConfig();
  await withServer(async ({ post }) => {
    const first = (await post('start', { id: ID, new: true })).json.sessionId;
    await post('close', { id: ID });
    assert.equal(adoptedId(), undefined);
    const second = (await post('start', { id: ID, new: true })).json.sessionId;
    assert.notEqual(first, second);
    assert.equal(adoptedId(), second);
  });
});

test('r5: without new, or with new absent, the start is as before (the adopted id wins, else the id of the repo)', async () => {
  writeConfig({ [ID]: { id: 'mine-1', name: 'Mine', adoptedAt: '2026-01-01T00:00:00.000Z' } });
  await withServer(async ({ post, made }) => {
    assert.equal((await post('start', { id: ID })).json.sessionId, 'mine-1');
    assert.equal(made[0].opts.args[3], 'mine-1');
  });
});

const gateOf = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, release: () => resolve({}) }; };
const until = async (fn) => { for (let i = 0; i < 200; i++) { if (await fn()) return true; await new Promise((r) => setTimeout(r, 10)); } return false; };

test('r6: while a session is STARTING (up to two minutes) another session cannot be adopted: 409, nothing changes, and the start ends adopted as itself (found by the independent verification)', async () => {
  writeConfig();
  const gate = gateOf();
  await withServer(async ({ post, api, made }) => {
    const starting = post('start', { id: ID, new: true });
    assert.ok(await until(async () => (await api('GET', '/api/rpc/states')).json.states[ID] === 'starting'), 'the start is pending'); // states reads the host's entry (the fake client always says idle)
    const adopt = await api('POST', '/api/sessions/adopt', { id: ID, session: 's1' });
    assert.equal(adopt.status, 409);
    assert.match(adopt.json.error, /close/i);
    assert.equal(adoptedId(), undefined);
    gate.release();
    const res = await starting;
    assert.equal(res.status, 200);
    assert.equal(adoptedId(), res.json.sessionId, 'the live session is the adopted one');
    assert.equal(made.length, 1);
  }, { gate });
});

test('r7: nor while it is live and adopted; with no session running the adopt route is as before (a session that is not listed is 400)', async () => {
  writeConfig();
  await withServer(async ({ post, api }) => {
    assert.equal((await api('POST', '/api/sessions/adopt', { id: ID, session: 's1' })).status, 400, 'nothing running: as before');
    await post('start', { id: ID, new: true });
    assert.equal((await api('POST', '/api/sessions/adopt', { id: ID, session: 's1' })).status, 409);
    await post('close', { id: ID });
    assert.equal((await api('POST', '/api/sessions/adopt', { id: ID, session: 's1' })).status, 400, 'after closing: as before');
  });
});

test('r8: an unknown repo is not made 409 by the check: the adopt route answers what it answered before for it', async () => {
  writeConfig();
  await withServer(async ({ api }) => {
    assert.equal((await api('POST', '/api/sessions/adopt', { id: 'nope', session: 's1' })).status, 404);
  });
});

test('h10: two simultaneous new starts: one 409 and one client; a plain start joins the pending new one', async () => {
  const gate = gateOf();
  const { host, made } = hostWith({ createClient: (o) => { const c = { opts: o, start: () => gate.promise, request: async () => ({}), answerDialog: () => false, pendingDialogs: () => [], state: () => 'idle', close() {} }; made.push(c); return c; } });
  const a = host.start('aaa', { fresh: true });
  const b = host.start('aaa', { fresh: true });
  const c = host.start('aaa');
  gate.release();
  const r = await Promise.allSettled([a, b, c]);
  assert.deepEqual(r.map((x) => x.status), ['fulfilled', 'rejected', 'fulfilled']);
  assert.equal(r[1].reason.status, 409);
  assert.equal(made.length, 1);
});

// ---------- the list and the composer (pure) ----------
const info = (o = {}) => ({ key: 'r1', adopted: null, adoptedFound: false, sessions: [], live: { state: 'none', count: 0 }, ...o });
const sess = (o = {}) => ({ id: 's1', name: 'panel:alpha', updatedAt: '2026-05-01T11:00:00Z', lastMessage: { role: 'user', text: 'last words' }, ...o });
const body = (c) => R.chatBody({ id: 'r1', ...c }, { now: Date.parse('2026-05-01T12:00:00Z') });

test('p1: the list shows up to 20 sessions (the 21st does not), each with Open, in a box that scrolls, all text escaped', () => {
  const list = Array.from({ length: 25 }, (_, i) => sess({ id: `s${i}`, name: i === 0 ? '<img src=x onerror=1>' : null, lastMessage: { role: 'user', text: 'z'.repeat(300) } }));
  const html = body({ info: info({ sessions: list }) });
  assert.equal((html.match(/data-act="chat-adopt"/g) || []).length, 20);
  assert.match(html, /data-act="chat-adopt" data-id="r1" data-session="s19"/);
  assert.doesNotMatch(html, /data-session="s20"/);
  assert.match(html, /<div class="ch-picks">/);
  assert.doesNotMatch(html, /<img/);
  assert.match(html, /&lt;img/);
  assert.doesNotMatch(html, /z{200}/);
});

test('p2: the buttons say Open and New session, and the words Adopt and Start panel session are gone', () => {
  const html = body({ info: info({ sessions: [sess()] }) });
  assert.match(html, /data-act="chat-adopt"[^>]*>Open<\/button>/);
  assert.match(html, /data-act="chat-start" data-id="r1"[^>]*>New session<\/button>/);
  assert.doesNotMatch(html, />Adopt<|Start panel session/);
  assert.match(html, /No session is adopted for this folder\./);
  assert.match(body({ info: info(), starting: true }), /data-act="chat-start" data-id="r1" disabled/);
  assert.doesNotMatch(body({ info: info() }), /chat-adopt/);
});

test('p2b: while a session is starting the Open buttons are disabled (the list stays in view), and a list that is not an array is an empty list', () => {
  const html = body({ info: info({ sessions: [sess({ id: 's1' }), sess({ id: 's2' })] }), starting: true });
  assert.equal((html.match(/data-act="chat-adopt"[^>]*disabled/g) || []).length, 2);
  assert.equal((body({ info: info({ sessions: [sess()] }) }).match(/data-act="chat-adopt"[^>]*disabled/g) || []).length, 0);
  for (const bad of ['text', { a: 1 }, 5, true]) assert.doesNotMatch(body({ info: info({ sessions: bad }) }), /chat-adopt/, JSON.stringify(bad));
  assert.match(body({ info: info({ sessions: 'text' }) }), /data-act="chat-start"/);
});

test('p3: with no session adopted the composer cannot send and says why; an adopted session and the loading state are as before', () => {
  const cs = (c) => R.composerState({ id: 'r1', sending: false, ...c }, { name: 'alpha' });
  const none = cs({ info: info(), rpc: { state: 'closed' } });
  assert.equal(none.canSend, false);
  assert.equal(none.reason, 'Open a session or start a new one to write');
  assert.equal(none.placeholder, 'Open a session or start a new one to write');
  assert.equal(cs({ info: info(), rpc: { state: 'idle' } }).canSend, false, 'also with a live state');
  const adopted = info({ adopted: { id: 's1', name: 'x' }, adoptedFound: true });
  assert.equal(cs({ info: adopted, rpc: { state: 'idle' } }).canSend, true);
  assert.equal(cs({ info: adopted, rpc: { state: 'closed' } }).canSend, true, 'an adopted session that is not started: the send starts it');
  assert.equal(cs({ info: null }).reason, 'Loading the chat…');
});

// ---------- the page ----------
function element(extra = {}) {
  const el = { html: '', hidden: false, dataset: {}, disabled: false, value: '', checked: false, textContent: '', title: '', placeholder: '', attrs: {}, children: [], writes: 0,
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false }, style: { setProperty() {} }, addEventListener() {}, setAttribute() {}, querySelector: () => null, querySelectorAll: () => [], closest: () => null,
    showModal() {}, close() {}, focus() {}, append() {}, get innerHTML() { return el.html; }, set innerHTML(v) { el.html = String(v); el.writes++; }, ...extra };
  return el;
}
const ok = (b) => ({ ok: true, json: async () => b });
const bad = (status, message) => ({ ok: false, status, statusText: 'Failed', json: async () => ({ error: message || 'nope' }) });
function loadPage() {
  const frames = []; const fetches = []; const routes = [];
  const els = {};
  const tabEls = ['summary', 'work', 'conformity'].map((t) => element({ dataset: { tab: t } }));
  const get = (sel) => (els[sel] ||= (sel === 'meta[name=token]' ? element({ content: 'token' }) : element()));
  const doc = { hidden: false, querySelector: get, querySelectorAll: (s) => (String(s).includes('data-tab') ? tabEls : []), addEventListener() {}, createElement: () => element(), body: element(), activeElement: null };
  const respond = (url, opts) => { for (const [m, fn] of routes) if (m(url)) return fn(url, opts); return new Promise(() => {}); };
  const ctx = vm.createContext({
    console, document: doc, location: { hash: '' }, localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    requestAnimationFrame: (cb) => { frames.push(cb); return frames.length; }, setInterval: () => 1, setTimeout: () => 0, clearTimeout: () => {}, AbortController, confirm: () => true,
    fetch: (url, opts = {}) => { fetches.push({ url, method: opts.method || 'GET', body: opts.body }); return respond(url, opts); },
  });
  ctx.window = ctx; ctx.addEventListener = () => {}; ctx.RepoPanelView = V; ctx.RepoPanelResumen = R;
  vm.runInContext(appSource(), ctx);
  const flush = () => { while (frames.length) frames.shift()(); };
  const tick = async (n = 20) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); flush(); };
  return { get, tick, routes, fetches, run: (c) => vm.runInContext(c, ctx) };
}
const card = (id, name) => ({ id, name, group: 'G', room: null, branch: 'main', progress: { total: 1, completada: 0, enRevision: 0, bloqueada: 0, pendiente: 1, enCurso: 0 }, session: { state: 'free' }, next: null, blocking: [], lastMovement: {}, activity: null });
async function boot({ adopted = null, sessions = [sess()] } = {}) {
  const page = loadPage();
  const S = page.run('S');
  S.groups = [{ name: 'G', repos: [{ id: 'abc', name: 'demo', path: 'p' }] }];
  S.summary = { rows: [card('abc', 'demo')], generatedAt: 'x' };
  const world = { adopted, sessions };
  page.world = world;
  page.routes.push([(u) => u.startsWith('/api/sessions?'), () => Promise.resolve(ok({ key: 'abc', adopted: world.adopted, adoptedFound: !!world.adopted, sessions: world.sessions, live: { state: 'none', count: 0 } }))]);
  page.routes.push([(u) => u.startsWith('/api/chat?'), () => Promise.resolve(ok({ items: [], truncated: false }))]);
  page.routes.push([(u) => u.startsWith('/api/rpc/status'), () => Promise.resolve(ok({ state: 'closed', pendingDialogs: [], sessionId: null }))]);
  page.run("ACTIONS['chat-open']({ dataset: { id: 'abc' } })");
  await page.tick();
  return page;
}
const posts = (page, url) => page.fetches.filter((f) => f.url === url && f.method === 'POST');

test('g1: with the list in view the Send button is disabled and the box explains why', async () => {
  const page = await boot();
  assert.equal(page.get('#msgSend').disabled, true);
  assert.equal(page.get('#msgBox').placeholder, 'Open a session or start a new one to write');
  assert.equal(page.get('#msgSend').title, 'Open a session or start a new one to write');
});

test('g2: with an adopted session the Send button works again (the list is gone)', async () => {
  const page = await boot({ adopted: { id: 's1', name: 'First', adoptedAt: 'x' } });
  assert.equal(page.get('#msgSend').disabled, false);
  assert.match(page.get('#msgBox').placeholder, /Message the session of demo/);
});

test('g3: New session sends { id, new: true } to /api/rpc/start, reloads the chat and never starts by itself', async () => {
  const page = await boot();
  assert.equal(posts(page, '/api/rpc/start').length, 0, 'opening the chat starts nothing');
  page.routes.unshift([(u) => u === '/api/rpc/start', () => { page.world.adopted = { id: 'panel-demo-abc-1', name: 'x', adoptedAt: 'x' }; return Promise.resolve(ok({ state: 'idle', pendingDialogs: [], sessionId: 'panel-demo-abc-1' })); }]);
  await page.run("ACTIONS['chat-start']({ dataset: { id: 'abc' }, disabled: false })");
  await page.tick();
  assert.equal(posts(page, '/api/rpc/start').length, 1);
  assert.deepEqual(JSON.parse(posts(page, '/api/rpc/start')[0].body), { id: 'abc', new: true });
  assert.equal(page.run('S.rpc.abc.state'), 'idle');
  assert.equal(page.get('#msgSend').disabled, false, 'with the new session the box works');
});

test('g3b: pressing New session marks the session as starting at once (the composer waits) and a refusal puts it back to closed', async () => {
  const page = await boot();
  let release;
  page.routes.unshift([(u) => u === '/api/rpc/start', () => new Promise((r) => { release = () => r(ok({ state: 'idle', pendingDialogs: [], sessionId: 'panel-demo-abc-1' })); })]);
  const running = page.run("ACTIONS['chat-start']({ dataset: { id: 'abc' }, disabled: false })");
  await page.tick();
  assert.equal(page.run('S.rpc.abc.state'), 'starting');
  assert.equal(page.get('#msgSend').disabled, true);
  assert.match(page.get('#chatBody').html, /data-act="chat-adopt"[^>]*disabled/);
  release();
  await running;
  await page.tick();
  assert.equal(page.run('S.rpc.abc.state'), 'idle');
  const refused = await boot();
  refused.routes.unshift([(u) => u === '/api/rpc/start', () => Promise.resolve(bad(409, 'This repo already has a session: close it first'))]);
  await refused.run("ACTIONS['chat-start']({ dataset: { id: 'abc' }, disabled: false })");
  await refused.tick();
  assert.equal(refused.run('S.rpc.abc.state'), 'closed');
});

test('g3c: Open while a New session is starting sends nothing', async () => {
  const page = await boot();
  page.routes.unshift([(u) => u === '/api/rpc/start', () => new Promise(() => {})]);
  page.run("ACTIONS['chat-start']({ dataset: { id: 'abc' }, disabled: false })");
  await page.tick();
  page.run("ACTIONS['chat-adopt']({ dataset: { id: 'abc', session: 's1' } })"); // not awaited: if it were let through it would hang on its own unanswered request
  await page.tick();
  assert.equal(posts(page, '/api/sessions/adopt').length, 0);
});

test('g4: a refused New session (409) shows the server message, keeps the list and stays usable', async () => {
  const page = await boot();
  page.routes.unshift([(u) => u === '/api/rpc/start', () => Promise.resolve(bad(409, 'Too many live sessions (at most 6)'))]);
  await page.run("ACTIONS['chat-start']({ dataset: { id: 'abc' }, disabled: false })");
  await page.tick();
  assert.equal(page.run('!!S.chat.starting'), false);
  assert.match(page.get('#chatBody').html, /data-act="chat-start"/);
  assert.doesNotMatch(page.get('#chatBody').html, /data-act="chat-start"[^>]*disabled/);
});

test('g5: Open posts to /api/sessions/adopt, shows the history at once and starts no process', async () => {
  const page = await boot();
  page.routes.unshift([(u) => u === '/api/sessions/adopt', () => { page.world.adopted = { id: 's1', name: 'First', adoptedAt: 'x' }; return Promise.resolve(ok({})); }]);
  await page.run("ACTIONS['chat-adopt']({ dataset: { id: 'abc', session: 's1' } })");
  await page.tick();
  assert.deepEqual(JSON.parse(posts(page, '/api/sessions/adopt')[0].body), { id: 'abc', session: 's1' });
  assert.equal(posts(page, '/api/rpc/start').length, 0, 'the process starts when the first message is sent');
  assert.doesNotMatch(page.get('#chatBody').html, /No session is adopted/);
});

test('c1: the list box scrolls inside the chat and does not grow it', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'style.css'), 'utf8').replace(/\r\n/g, '\n');
  assert.match(css, /\.ch-picks\s*\{[^}]*max-height:[^}]*overflow-y:\s*auto/);
});

test('d1: the README says what Open and New session do and that a new session needs no live or adopted session', () => {
  const readme = fs.readFileSync(path.join(__dirname, '..', 'README.md'), 'utf8').replace(/\r\n/g, '\n');
  assert.match(readme, /New session/);
  assert.match(readme, /\{ id, new: true \}/);
});
