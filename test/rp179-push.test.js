'use strict';
// RP179: Web Push. A notice that RP178 emits also reaches a device with the panel closed or the phone locked. server/push.js keeps the VAPID keys and the
// subscriptions in push.json (next to config.json), signs the VAPID header with node:crypto and sends a push with NO body; public/sw.js (the service worker)
// asks the server for the text and ALWAYS shows a notification (iOS revokes a subscription that does not). No library. Real http server on an ephemeral
// port with a temp config and an injected `pushPost`, so nothing ever leaves the machine.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'rp179-'));
const configFile = path.join(scratch, 'config.json');
process.env.REPO_PANEL_CONFIG = configFile;
const HOST = 'pc.tail1234.ts.net';
const KEY = 'correct-horse-battery-staple-1234';
const writeConfig = (extra = {}) => fs.writeFileSync(configFile, JSON.stringify({ port: 4310, groups: [], rooms: [], ...extra }));
writeConfig();
test.after(() => fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 5 }));

const ROOT = path.join(__dirname, '..');
const { createServer } = require('../server/http.js');
const push = require('../server/push.js');
const { createNotifier } = require('../server/notifier.js');

const APPLE = 'https://web.push.apple.com/QGxyz123';
const ID = 'a1b2c3d4e5';
const b64u = (buf) => Buffer.from(buf).toString('base64url');
const tmpFile = () => path.join(fs.mkdtempSync(path.join(scratch, 's-')), 'push.json');

// ---------- the endpoint allow-list ----------
test('validEndpoint: only https push services of the big browsers; never an arbitrary URL', () => {
  for (const ok of [APPLE, 'https://fcm.googleapis.com/fcm/send/abc', 'https://wns2-par02p.notify.windows.com/w/?token=x', 'https://updates.push.services.mozilla.com/wpush/v2/abc', 'https://web.push.apple.com/x']) assert.equal(push.validEndpoint(ok), true, ok);
  for (const bad of ['http://web.push.apple.com/x', 'https://evil.example/x', 'https://web.push.apple.com.evil.example/x', 'https://evilweb.push.apple.com/x', 'https://user@evil.example/x', 'https://user:pw@web.push.apple.com/x', 'https://web.push.apple.com:444/x', 'https://127.0.0.1/x', 'https://localhost/x', 'ftp://web.push.apple.com/x', 'javascript:alert(1)', '', null, undefined, 5, {}, `https://web.push.apple.com/${'a'.repeat(2100)}`]) assert.equal(push.validEndpoint(bad), false, String(bad).slice(0, 40));
});

// ---------- keys and the VAPID header ----------
test('store: the VAPID key pair is made once, persisted, and the public key is a raw P-256 point in base64url', () => {
  const file = tmpFile();
  const a = push.createPushStore({ file }).vapid();
  const raw = Buffer.from(a.publicKey, 'base64url');
  assert.equal(raw.length, 65);
  assert.equal(raw[0], 4);
  const b = push.createPushStore({ file }).vapid();
  assert.equal(b.publicKey, a.publicKey, 'a new store on the same file reads the same pair');
  assert.ok(fs.existsSync(file));
});

test('vapidHeader: a signed ES256 JWT for the origin of the endpoint, short lived, that the public key verifies', () => {
  const keys = push.createPushStore({ file: tmpFile() }).vapid();
  const now = 1_700_000_000_000;
  const header = push.vapidHeader(keys, APPLE, { now, sub: 'https://pc.example' });
  const m = /^vapid t=([\w-]+)\.([\w-]+)\.([\w-]+), k=([\w-]+)$/.exec(header);
  assert.ok(m, header);
  assert.equal(m[4], keys.publicKey);
  assert.deepEqual(JSON.parse(Buffer.from(m[1], 'base64url')), { typ: 'JWT', alg: 'ES256' });
  const claims = JSON.parse(Buffer.from(m[2], 'base64url'));
  assert.equal(claims.aud, 'https://web.push.apple.com');
  assert.ok(claims.exp > now / 1000 && claims.exp <= now / 1000 + 24 * 3600);
  assert.match(claims.sub, /^(mailto:|https:\/\/)/);
  const raw = Buffer.from(keys.publicKey, 'base64url');
  const pub = crypto.createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: b64u(raw.subarray(1, 33)), y: b64u(raw.subarray(33)) }, format: 'jwk' });
  const verify = (jwt, sig) => crypto.verify('sha256', Buffer.from(jwt), { key: pub, dsaEncoding: 'ieee-p1363' }, Buffer.from(sig, 'base64url'));
  assert.equal(verify(`${m[1]}.${m[2]}`, m[3]), true);
  assert.equal(verify(`${m[1]}.${m[2]}x`, m[3]), false, 'a changed claim breaks the signature');
});

// ---------- subscriptions and pending notices ----------
test('store: add validates and de-duplicates, remove forgets, and everything survives a restart', () => {
  const file = tmpFile();
  const s = push.createPushStore({ file });
  assert.equal(s.add({ endpoint: 'https://evil.example/x' }), false);
  assert.equal(s.add(null), false);
  assert.equal(s.add({ endpoint: APPLE }), true);
  assert.equal(s.add({ endpoint: APPLE }), true);
  assert.equal(s.count(), 1);
  assert.equal(push.createPushStore({ file }).count(), 1);
  assert.equal(s.remove(APPLE), true);
  assert.equal(s.remove(APPLE), false);
  assert.equal(s.count(), 0);
  assert.equal(push.createPushStore({ file }).count(), 0);
});

test('store: at most 20 devices; the 21st is refused', () => {
  const s = push.createPushStore({ file: tmpFile() });
  for (let i = 0; i < 20; i++) assert.equal(s.add({ endpoint: `https://web.push.apple.com/d${i}` }), true);
  assert.equal(s.add({ endpoint: 'https://web.push.apple.com/one-more' }), false);
});

test('store: queue gives each device the notice, take hands it over once, old and surplus notices are dropped', () => {
  let t = 1000;
  const s = push.createPushStore({ file: tmpFile(), now: () => t });
  s.add({ endpoint: APPLE });
  s.add({ endpoint: 'https://fcm.googleapis.com/fcm/send/abc' });
  s.queue({ id: ID, kind: 'deliver', title: 'my-repo', body: 'ready' });
  assert.deepEqual(s.take(APPLE).map((n) => [n.id, n.kind, n.title, n.body]), [[ID, 'deliver', 'my-repo', 'ready']]);
  assert.deepEqual(s.take(APPLE), [], 'taken once');
  assert.equal(s.take('https://fcm.googleapis.com/fcm/send/abc').length, 1, 'each device has its own');
  assert.deepEqual(s.take('https://web.push.apple.com/unknown'), []);
  s.queue({ id: ID, kind: 'ci', title: 't', body: 'b' });
  t += 11 * 60 * 1000;
  assert.deepEqual(s.take(APPLE), [], 'older than 10 minutes is dropped');
  for (let i = 0; i < 12; i++) s.queue({ id: ID, kind: 'merge', title: `t${i}`, body: 'b' });
  assert.deepEqual(s.take(APPLE).map((n) => n.title), Array.from({ length: 10 }, (_, i) => `t${i + 2}`), 'the newest ten');
});

// ---------- the pusher ----------
const lower = (h) => Object.fromEntries(Object.entries(h).map(([k, v]) => [k.toLowerCase(), v]));
function pusherRig(status = 201) {
  const posts = [];
  const store = push.createPushStore({ file: tmpFile() });
  const statusOf = typeof status === 'function' ? status : () => status;
  const pusher = push.createPusher({ store, post: async (endpoint, headers) => { posts.push({ endpoint, headers: lower(headers) }); return { status: statusOf(endpoint) }; }, now: () => 1_700_000_000_000 });
  return { posts, store, pusher };
}
const notice = { kind: 'deliver', title: 'my-repo', body: 'Done working: ready for /flow-ship' };

test('pusher: one empty, high-urgency push per device with its own VAPID header, and the text waits to be taken', async () => {
  const r = pusherRig();
  r.store.add({ endpoint: APPLE });
  r.store.add({ endpoint: 'https://fcm.googleapis.com/fcm/send/abc' });
  await r.pusher.notify(ID, notice);
  assert.deepEqual(r.posts.map((p) => p.endpoint).sort(), [APPLE, 'https://fcm.googleapis.com/fcm/send/abc'].sort());
  for (const p of r.posts) {
    assert.match(p.headers.authorization, /^vapid t=[\w-]+\.[\w-]+\.[\w-]+, k=[\w-]+$/);
    assert.equal(p.headers['content-length'], '0');
    assert.equal(p.headers.urgency, 'high');
    assert.ok(Number(p.headers.ttl) > 0 && Number(p.headers.ttl) <= 3600);
  }
  assert.equal(r.store.take(APPLE)[0].kind, 'deliver');
});

test('pusher: a dead subscription (404, 410) is forgotten; a server error or a throw keeps it and never throws out', async () => {
  const gone = 'https://web.push.apple.com/gone';
  const flaky = 'https://web.push.apple.com/flaky';
  const r = pusherRig((e) => (e === gone ? 410 : 503));
  r.store.add({ endpoint: gone });
  r.store.add({ endpoint: flaky });
  await r.pusher.notify(ID, notice);
  assert.equal(r.store.count(), 1);
  const store = push.createPushStore({ file: tmpFile() });
  store.add({ endpoint: APPLE });
  const boom = push.createPusher({ store, post: async () => { throw new Error('network'); } });
  await assert.doesNotReject(boom.notify(ID, notice));
  assert.equal(store.count(), 1);
});

test('pusher: with no device it sends nothing, and test() sends one push with its own notice', async () => {
  const r = pusherRig();
  await r.pusher.notify(ID, notice);
  assert.deepEqual(r.posts, []);
  r.store.add({ endpoint: APPLE });
  await r.pusher.test();
  assert.equal(r.posts.length, 1);
  assert.match(r.store.take(APPLE)[0].body, /test/i);
});

test('pusher: a device that is not a push service (push.json edited by hand) is never requested', async () => {
  const file = tmpFile();
  const first = push.createPushStore({ file });
  first.add({ endpoint: APPLE });
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  data.subs.push({ endpoint: 'https://evil.example/steal' }, { endpoint: 'http://web.push.apple.com/plain' });
  fs.writeFileSync(file, JSON.stringify(data));
  const posts = [];
  const pusher = push.createPusher({ store: push.createPushStore({ file }), post: async (endpoint) => { posts.push(endpoint); return { status: 201 }; } });
  await pusher.notify(ID, notice);
  assert.deepEqual(posts, [APPLE]);
});

// ---------- the notifier keeps watching while a device is subscribed ----------
test('notifier: with no page but a subscribed device it still reads the store, and every notice also goes to onNotice', () => {
  let rows = [];
  let devices = 0;
  const reads = { n: 0 };
  const got = [];
  const notifier = createNotifier({
    store: { snapshot: () => { reads.n += 1; return { rows }; } },
    hub: { emit() {}, size: () => 0 },
    hasSubscribers: () => devices > 0,
    onNotice: (id, n) => got.push([id, n.kind]),
    confirm: 1, setTimer: () => 0, clearTimer: () => {},
  });
  const row = (over) => ({ id: ID, name: 'my-repo', loading: false, error: null, rank: 9, session: { state: 'free' }, action: null, ...over });
  rows = [row({ session: { state: 'working' }, rank: 7 })];
  notifier.tick();
  assert.equal(reads.n, 0, 'nobody listens: nothing is read');
  devices = 1;
  notifier.tick();
  assert.equal(reads.n, 1);
  rows = [row({ action: { kind: 'deliver', label: 'x', pr: null }, rank: 5 })];
  notifier.tick();
  assert.deepEqual(got, [[ID, 'deliver']]);
  devices = 0;
  notifier.tick();
  assert.equal(reads.n, 2, 'the last device leaving stops the reads');
});

// ---------- the service worker ----------
function swRig({ fetchImpl, clientsList = [] } = {}) {
  const handlers = {};
  const shown = [];
  const opened = [];
  const sandbox = {
    addEventListener: (type, fn) => { handlers[type] = fn; },
    registration: { showNotification: async (title, opts) => { shown.push({ title, opts }); }, pushManager: { getSubscription: async () => ({ endpoint: APPLE }) } },
    clients: { matchAll: async () => clientsList, openWindow: async (url) => { opened.push(url); } },
    fetch: fetchImpl,
    location: { origin: 'https://pc.example' },
    JSON, Promise, Array, Object, String, Number, console,
  };
  sandbox.self = sandbox;
  vm.runInNewContext(fs.readFileSync(path.join(ROOT, 'public', 'sw.js'), 'utf8'), sandbox);
  const run = async (type, event) => { let p; handlers[type]({ ...event, waitUntil: (x) => { p = x; } }); await p; };
  return { handlers, shown, opened, run };
}
const ok = (notices) => async () => ({ ok: true, json: async () => ({ notices }) });

test('sw.js: a push shows one notification per pending notice, with the same tag the page uses', async () => {
  const calls = [];
  const sw = swRig({ fetchImpl: async (url, init) => { calls.push([url, init]); return ok([{ id: ID, kind: 'deliver', title: 'my-repo', body: 'ready' }, { id: 'ffffffffff', kind: 'ci', title: 'other', body: 'CI is failing' }])(); } });
  await sw.run('push', {});
  assert.deepEqual(sw.shown.map((s) => [s.title, s.opts.body, s.opts.tag]), [['my-repo', 'ready', `rp-${ID}-deliver`], ['other', 'CI is failing', 'rp-ffffffffff-ci']]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], '/push/pending');
  assert.equal(calls[0][1].method, 'POST');
  assert.deepEqual(JSON.parse(calls[0][1].body), { endpoint: APPLE });
  assert.equal(sw.shown[0].opts.data.id, ID);
});

test('sw.js: it ALWAYS shows something: a failed or empty answer gives one generic notification', async () => {
  for (const fetchImpl of [async () => { throw new Error('offline'); }, async () => ({ ok: false, status: 401, json: async () => ({}) }), ok([]), async () => ({ ok: true, json: async () => { throw new Error('bad json'); } }), ok('nope')]) {
    const sw = swRig({ fetchImpl });
    await sw.run('push', {});
    assert.equal(sw.shown.length, 1);
    assert.match(sw.shown[0].title, /panel/i);
    assert.ok(sw.shown[0].opts.body.length > 3);
  }
});

test('sw.js: clicking a notification focuses an open panel, or else opens that repo', async () => {
  const closed = [];
  const note = (id) => ({ close: () => closed.push(id), data: { id } });
  const none = swRig({ fetchImpl: ok([]) });
  await none.run('notificationclick', { notification: note(ID) });
  assert.deepEqual(none.opened, [`/#/repo/${ID}/chat`]);
  assert.equal(closed.length, 1);
  const focused = [];
  const navigated = [];
  const open = swRig({ fetchImpl: ok([]), clientsList: [{ focus: async () => { focused.push(1); }, navigate: async (u) => { navigated.push(u); } }] });
  await open.run('notificationclick', { notification: note(ID) });
  assert.equal(focused.length, 1);
  assert.deepEqual(open.opened, []);
  assert.deepEqual(navigated, [`/#/repo/${ID}/chat`]);
  const bad = swRig({ fetchImpl: ok([]) });
  await bad.run('notificationclick', { notification: { close() {}, data: { id: '../../x' } } });
  assert.deepEqual(bad.opened, ['/'], 'an id that is not a repo id never reaches the address');
});

// ---------- the routes ----------
const freePort = () => new Promise((resolve) => {
  const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
});
const call = (port, method, p, { headers = {}, body } = {}) => new Promise((resolve, reject) => {
  const data = body === undefined ? null : JSON.stringify(body);
  const req = http.request({ host: '127.0.0.1', port, path: p, method, agent: false, headers: { host: `127.0.0.1:${port}`, ...(data ? { 'content-type': 'application/json' } : {}), ...headers } }, (res) => {
    let text = '';
    res.setEncoding('utf8');
    res.on('data', (c) => { text += c; });
    res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: text, json: () => JSON.parse(text) }));
  });
  req.on('error', reject);
  req.end(data);
});
const tokenOf = (html) => (/name="?token"? content="([0-9a-f]+)"/.exec(html) || [])[1];
async function withServer(fn, deps = {}) {
  fs.rmSync(path.join(scratch, 'push.json'), { force: true }); // every server starts with no device: push.json lives next to the temp config and outlives a test
  const port = await freePort();
  const posts = [];
  const rowsBox = { rows: [], reads: 0 };
  const summaryStore = { snapshot: () => { rowsBox.reads += 1; return { rows: rowsBox.rows }; }, start() {}, stop() {}, awake: () => true };
  const server = createServer(port, { summaryStore, pushPost: async (endpoint, headers) => { posts.push({ endpoint, headers: lower(headers) }); return { status: 201 }; }, ...deps });
  await new Promise((r) => server.listen(port, '127.0.0.1', r));
  const token = tokenOf((await call(port, 'GET', '/')).body);
  const api = (m, p, body, headers = {}) => call(port, m, p, { headers: { 'x-token': token, ...headers }, body });
  const remoteCall = (m, p, o = {}) => call(port, m, p, { ...o, headers: { host: HOST, ...(o.headers || {}) } });
  try { await fn({ port, token, api, posts, rowsBox, server, remoteCall, local: (m, p, o) => call(port, m, p, o) }); } finally { server.close(); server.closeAllConnections(); }
}
const until = async (cond) => { for (let i = 0; i < 200 && !cond(); i++) await new Promise((r) => setTimeout(r, 10)); };

test('routes: the worker, the manifest and the icon need no login (they carry no data), and the manifest installs the app', async () => {
  writeConfig({ remote: { host: HOST, secret: KEY } });
  await withServer(async ({ remoteCall, local }) => {
    assert.equal((await remoteCall('GET', '/')).status, 401, 'the page itself still asks for the login');
    const sw = await remoteCall('GET', '/sw.js');
    assert.equal(sw.status, 200);
    assert.match(sw.headers['content-type'], /text\/javascript/);
    const mf = await remoteCall('GET', '/manifest.webmanifest');
    assert.equal(mf.status, 200);
    assert.match(mf.headers['content-type'], /application\/manifest\+json/);
    const m = JSON.parse(mf.body);
    assert.equal(m.display, 'standalone');
    assert.equal(m.start_url, '/');
    assert.ok(m.name && m.short_name && m.theme_color && m.background_color);
    assert.ok(Array.isArray(m.icons) && m.icons.some((i) => i.src === '/icon.svg'));
    assert.equal((await remoteCall('GET', '/icon.svg')).status, 200);
    assert.equal((await remoteCall('GET', '/app.js')).status, 401, 'the rest of the assets still need the login');
    assert.equal((await local('GET', '/sw.js')).status, 200);
    assert.equal((await remoteCall('GET', '/sw.js', { headers: { host: 'evil.example' } })).status, 403, 'a foreign Host never gets anything');
  });
  writeConfig();
});

test('routes: the page links the manifest and the service worker file is the one the repo ships', () => {
  const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
  assert.match(html, /<link rel="manifest" href="\/manifest\.webmanifest">/);
  assert.ok(fs.existsSync(path.join(ROOT, 'public', 'sw.js')));
});

test('routes: key, subscribe, unsubscribe and test need the token and validate the endpoint', async () => {
  await withServer(async ({ api, local, posts }) => {
    assert.equal((await local('GET', '/api/push/key')).status, 401);
    assert.equal((await local('POST', '/api/push/subscribe', { body: { endpoint: APPLE } })).status, 401);
    const key = await api('GET', '/api/push/key');
    assert.equal(key.status, 200);
    assert.deepEqual(Object.keys(key.json()), ['key']);
    assert.equal(Buffer.from(key.json().key, 'base64url').length, 65);
    assert.equal((await api('POST', '/api/push/subscribe', { endpoint: 'https://evil.example/x' })).status, 400);
    assert.equal((await api('POST', '/api/push/subscribe', {})).status, 400);
    assert.equal((await api('POST', '/api/push/subscribe', { endpoint: APPLE, keys: { p256dh: 'x', auth: 'y' } })).status, 200);
    assert.deepEqual((await api('POST', '/api/push/test', {})).json().sent, 1);
    await until(() => posts.length === 1);
    assert.equal(posts[0].endpoint, APPLE);
    assert.equal((await api('POST', '/api/push/unsubscribe', { endpoint: APPLE })).status, 200);
    assert.deepEqual((await api('POST', '/api/push/test', {})).json().sent, 0);
    assert.ok(fs.existsSync(path.join(scratch, 'push.json')), 'push.json lives next to config.json');
  });
});

test('routes: /push/pending needs no token but does need the login on the remote host, and hands each notice over once', async () => {
  writeConfig({ remote: { host: HOST, secret: KEY } });
  await withServer(async ({ api, remoteCall, server }) => {
    await api('POST', '/api/push/subscribe', { endpoint: APPLE });
    server.pusher.store.queue({ id: ID, kind: 'merge', title: 'my-repo', body: 'PR #7 is ready to merge' });
    const ask = (headers = {}) => remoteCall('POST', '/push/pending', { headers, body: { endpoint: APPLE } });
    assert.equal((await ask()).status, 401, 'no cookie, no notices');
    const cookie = (await remoteCall('POST', '/login', { body: { secret: KEY } })).headers['set-cookie'][0].split(';')[0];
    const first = await ask({ cookie });
    assert.equal(first.status, 200);
    assert.deepEqual(first.json().notices.map((n) => [n.id, n.kind, n.body]), [[ID, 'merge', 'PR #7 is ready to merge']]);
    assert.deepEqual((await ask({ cookie })).json().notices, []);
    assert.equal((await remoteCall('POST', '/push/pending', { headers: { cookie }, body: { endpoint: 'https://web.push.apple.com/unknown' } })).json().notices.length, 0, 'an unknown device gets nothing');
    assert.equal((await remoteCall('POST', '/push/pending', { headers: { cookie, origin: 'https://evil.example' }, body: { endpoint: APPLE } })).status, 403);
  });
  writeConfig();
});

test('end to end: a repo that finishes working pushes to the subscribed device with every page closed, and stops when it unsubscribes', async () => {
  await withServer(async ({ api, posts, rowsBox, server, local }) => {
    const row = (over) => ({ id: ID, name: 'my-repo', loading: false, error: null, rank: 9, session: { state: 'free' }, action: null, ...over });
    const working = [row({ session: { state: 'working' }, rank: 7 })];
    const deliver = [row({ action: { kind: 'deliver', label: 'x', pr: null }, rank: 5 })];
    rowsBox.rows = working;
    server.notifier.tick(); server.notifier.tick();
    assert.equal(rowsBox.reads, 0, 'no page and no device: nothing is read');
    await api('POST', '/api/push/subscribe', { endpoint: APPLE });
    server.notifier.tick(); server.notifier.tick();
    assert.equal(rowsBox.reads, 2, 'a device is listening');
    rowsBox.rows = deliver;
    server.notifier.tick(); server.notifier.tick();
    await until(() => posts.length === 1);
    assert.equal(posts.length, 1);
    assert.equal(posts[0].endpoint, APPLE);
    const pending = await local('POST', '/push/pending', { body: { endpoint: APPLE } });
    assert.deepEqual(pending.json().notices.map((n) => [n.id, n.kind, n.title]), [[ID, 'deliver', 'my-repo']]);
    server.notifier.tick(); server.notifier.tick();
    assert.equal(posts.length, 1, 'the same state is not pushed again');
    await api('POST', '/api/push/unsubscribe', { endpoint: APPLE });
    const before = rowsBox.reads;
    server.notifier.tick();
    assert.equal(rowsBox.reads, before, 'the last device left: no more reads');
  });
});

test('pusher: a 404 forgets a device like a 410 does', async () => {
  const r = pusherRig(404);
  r.store.add({ endpoint: APPLE });
  await r.pusher.notify(ID, notice);
  assert.equal(r.store.count(), 0);
});

test('store: it writes through a temp file and a rename, and keeps the file private where the OS has modes', (t) => {
  const file = tmpFile();
  const rename = t.mock.method(fs, 'renameSync');
  push.createPushStore({ file }).add({ endpoint: APPLE });
  assert.ok(rename.mock.calls.some((c) => c.arguments[0] === `${file}.tmp` && c.arguments[1] === file), 'temp file, then rename');
  assert.equal(fs.existsSync(`${file}.tmp`), false);
  if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

test('routes: only a GET reaches the open files; HEAD and POST of the worker still need the login; unsubscribe needs the token', async () => {
  writeConfig({ remote: { host: HOST, secret: KEY } });
  await withServer(async ({ remoteCall, local }) => {
    assert.equal((await remoteCall('HEAD', '/sw.js')).status, 401);
    assert.equal((await remoteCall('POST', '/sw.js', { body: {} })).status, 401);
    assert.equal((await local('POST', '/api/push/unsubscribe', { body: { endpoint: APPLE } })).status, 401);
  });
  writeConfig();
});

test('sw.js: a notice whose title is not text is dropped, and a bad one beside a good one does not hide it', async () => {
  const bad = { id: ID, kind: 'ci', title: { x: 1 }, body: 'b' };
  const good = { id: 'ffffffffff', kind: 'merge', title: 'other', body: 'PR #1 is ready to merge' };
  const only = swRig({ fetchImpl: ok([bad]) });
  await only.run('push', {});
  assert.equal(only.shown.length, 1);
  assert.match(only.shown[0].title, /panel/i);
  const mixed = swRig({ fetchImpl: ok([bad, good]) });
  await mixed.run('push', {});
  assert.deepEqual(mixed.shown.map((s) => s.title), ['other']);
});

// ---------- the page, the files and the docs ----------
test('settings: a Push section for this device: install hint, enable, and disable with a test button', () => {
  const { settingsView } = require('../public/resumen.js');
  const view = (push) => settingsView({ state: 'ready', options: {}, prefs: { notify: { answer: true, ci: true, deliver: true, merge: true, start: true, sound: true, system: true, permission: 'default' }, push } });
  const unsupported = view({ supported: false, subscribed: false, permission: 'default' });
  assert.match(unsupported, /Push notifications/);
  assert.match(unsupported, /Add to Home Screen/);
  assert.doesNotMatch(unsupported, /data-act="push-enable"/);
  const ready = view({ supported: true, subscribed: false, permission: 'default' });
  assert.match(ready, /data-act="push-enable"/);
  assert.doesNotMatch(ready, /data-act="push-disable"/);
  const on = view({ supported: true, subscribed: true, permission: 'granted' });
  assert.match(on, /data-act="push-disable"/);
  assert.match(on, /data-act="push-test"/);
  assert.doesNotMatch(on, /data-act="push-enable"/);
  assert.match(view({ supported: true, subscribed: false, permission: 'denied' }), /Blocked/);
});

test('the page wires the three push buttons, the worker registration and the key', () => {
  const read = (f) => fs.readFileSync(path.join(ROOT, 'public', f), 'utf8');
  for (const act of ['push-enable', 'push-disable', 'push-test']) assert.match(read('actions.js'), new RegExp(`'${act}'`));
  const all = ['actions.js', 'feed.js', 'tabs.js'].map(read).join('\n');
  assert.match(all, /serviceWorker\.register\('\/sw\.js'\)/);
  assert.match(all, /pushManager\.subscribe/);
  assert.match(all, /userVisibleOnly: true/);
  assert.match(all, /\/api\/push\/key/);
  assert.match(all, /\/api\/push\/subscribe/);
});

test('push.json holds the private key, so Git must ignore it; the README explains the feature and its cost', () => {
  assert.ok(fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8').split(/\r?\n/).includes('push.json'));
  const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
  assert.match(readme, /## Push notifications \(RP179\)/);
  assert.match(readme, /push\.json/);
  assert.match(readme, /Add to Home Screen/);
});
