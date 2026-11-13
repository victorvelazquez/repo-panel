'use strict';
// RP177: remote access. With `remote.host` and `remote.secret` in config.json the panel also answers to that Host (Tailscale Serve), behind a
// one-time login that leaves a signed, stateless cookie; every POST with a foreign Origin is refused; 127.0.0.1 never needs a login and a config
// with no `remote` behaves as before. Real http server on an ephemeral port, temp config, no timers waited on.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'rp177-'));
const configFile = path.join(scratch, 'config.json');
process.env.REPO_PANEL_CONFIG = configFile;
const SECRET = 'correct-horse-battery-staple-1234';
const HOST = 'pc.tail1234.ts.net';
const writeConfig = (extra = {}) => fs.writeFileSync(configFile, JSON.stringify({ port: 4310, groups: [], rooms: [], ...extra }));
writeConfig();
test.after(() => fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 5 }));

const { createServer } = require('../server/http.js');
const remote = require('../server/remote.js');
const { loadConfig, saveConfig } = require('../server/config.js');

const freePort = () => new Promise((resolve) => {
  const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
});
const call = (port, method, p, { headers = {}, body } = {}) => new Promise((resolve, reject) => {
  const data = body === undefined ? null : JSON.stringify(body);
  const req = http.request({ host: '127.0.0.1', port, path: p, method, agent: false, headers: { host: `127.0.0.1:${port}`, ...(data ? { 'content-type': 'application/json' } : {}), ...headers } }, (res) => {
    let text = '';
    res.setEncoding('utf8');
    res.on('data', (c) => { text += c; });
    res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: text }));
  });
  req.on('error', reject);
  req.end(data);
});
async function withServer(fn, { now } = {}) {
  const port = await freePort();
  const server = createServer(port, { noSummaryStore: true, ...(now ? { now } : {}) });
  await new Promise((r) => server.listen(port, '127.0.0.1', r));
  const local = (m, p, o = {}) => call(port, m, p, o);
  const remoteCall = (m, p, o = {}) => call(port, m, p, { ...o, headers: { host: HOST, ...(o.headers || {}) } });
  try { await fn({ port, local, remoteCall, server }); } finally { server.close(); server.closeAllConnections(); }
}
const tokenOf = (html) => (/name="?token"? content="([0-9a-f]+)"/.exec(html) || [])[1];
const cookieOf = (res) => (res.headers['set-cookie'] || [])[0];
const pair = (setCookie) => setCookie.split(';')[0];

test('no remote config: a foreign Host is still refused and 127.0.0.1 works as before', async () => {
  writeConfig();
  await withServer(async ({ local, remoteCall }) => {
    assert.equal((await remoteCall('GET', '/')).status, 403);
    const page = await local('GET', '/');
    assert.equal(page.status, 200);
    assert.ok(tokenOf(page.body));
    assert.equal((await local('POST', '/api/queue', { headers: { 'x-token': tokenOf(page.body) }, body: {} })).status !== 403, true);
  });
});

test('remote host without a usable secret fails closed', async () => {
  writeConfig({ remote: { host: HOST } });
  await withServer(async ({ remoteCall }) => { assert.equal((await remoteCall('GET', '/')).status, 403); });
  writeConfig({ remote: { host: HOST, secret: 'too-short' } });
  await withServer(async ({ remoteCall }) => { assert.equal((await remoteCall('GET', '/')).status, 403); });
});

test('remote host: no cookie means a login page without the token, and 401 for the API and the stream', async () => {
  writeConfig({ remote: { host: HOST, secret: SECRET } });
  await withServer(async ({ remoteCall, local }) => {
    const page = await remoteCall('GET', '/');
    assert.equal(page.status, 401);
    assert.match(page.headers['content-type'], /text\/html/);
    assert.equal(tokenOf(page.body), undefined);
    assert.match(page.body, /<form|<input/i);
    const realToken = tokenOf((await local('GET', '/')).body);
    assert.equal((await remoteCall('GET', '/api/config', { headers: { 'x-token': realToken } })).status, 401);
    assert.equal((await remoteCall('GET', '/api/events', { headers: { 'x-token': realToken } })).status, 401);
    assert.equal((await remoteCall('GET', '/app.js')).status, 401);
    assert.equal((await remoteCall('GET', '/health')).status, 200);
  });
});

test('login: wrong secret is 401 with no cookie; the right one sets a HttpOnly SameSite=Strict cookie', async () => {
  writeConfig({ remote: { host: HOST, secret: SECRET } });
  await withServer(async ({ remoteCall }) => {
    const bad = await remoteCall('POST', '/login', { body: { secret: 'nope' } });
    assert.equal(bad.status, 401);
    assert.equal(cookieOf(bad), undefined);
    const ok = await remoteCall('POST', '/login', { body: { secret: SECRET } });
    assert.equal(ok.status, 200);
    const c = cookieOf(ok);
    assert.match(c, /HttpOnly/i);
    assert.match(c, /SameSite=Strict/i);
    assert.match(c, /Max-Age=\d{6,}/i);
    assert.doesNotMatch(c, /Secure/i);
    assert.doesNotMatch(c, new RegExp(SECRET));
    const viaHttps = await remoteCall('POST', '/login', { headers: { 'x-forwarded-proto': 'https' }, body: { secret: SECRET } });
    assert.match(cookieOf(viaHttps), /; Secure/i);
  });
});

test('a valid cookie opens the page with the token; the API still needs the token too', async () => {
  writeConfig({ remote: { host: HOST, secret: SECRET } });
  await withServer(async ({ remoteCall }) => {
    const cookie = pair(cookieOf(await remoteCall('POST', '/login', { body: { secret: SECRET } })));
    const page = await remoteCall('GET', '/', { headers: { cookie } });
    assert.equal(page.status, 200);
    const token = tokenOf(page.body);
    assert.ok(token);
    assert.equal((await remoteCall('GET', '/app.js', { headers: { cookie } })).status, 200);
    assert.equal((await remoteCall('GET', '/api/config', { headers: { cookie, 'x-token': token } })).status, 200);
    assert.equal((await remoteCall('GET', '/api/config', { headers: { cookie } })).status, 401);
  });
});

test('the cookie survives a server restart and dies when the secret changes; forged and expired ones are refused', async () => {
  writeConfig({ remote: { host: HOST, secret: SECRET } });
  let cookie;
  await withServer(async ({ remoteCall }) => { cookie = pair(cookieOf(await remoteCall('POST', '/login', { body: { secret: SECRET } }))); });
  await withServer(async ({ remoteCall }) => {
    assert.equal((await remoteCall('GET', '/', { headers: { cookie } })).status, 200);
    const [name, value] = cookie.split('=');
    const parts = value.split('.');
    const forged = `${name}=${parts[0]}.${parts[1]}.${'0'.repeat(parts[2].length)}`;
    assert.equal((await remoteCall('GET', '/', { headers: { cookie: forged } })).status, 401);
    const longer = `${name}=${parts[0]}.${Number(parts[1]) + 1e9}.${parts[2]}`;
    assert.equal((await remoteCall('GET', '/', { headers: { cookie: longer } })).status, 401);
    assert.equal((await remoteCall('GET', '/', { headers: { cookie: `${name}=garbage` } })).status, 401);
  });
  writeConfig({ remote: { host: HOST, secret: `${SECRET}-rotated` } });
  await withServer(async ({ remoteCall }) => { assert.equal((await remoteCall('GET', '/', { headers: { cookie } })).status, 401); });
});

test('five wrong secrets lock the login, even for the right one', async () => {
  writeConfig({ remote: { host: HOST, secret: SECRET } });
  await withServer(async ({ remoteCall }) => {
    for (let i = 0; i < 5; i++) assert.equal((await remoteCall('POST', '/login', { body: { secret: `bad-${i}` } })).status, 401);
    const locked = await remoteCall('POST', '/login', { body: { secret: SECRET } });
    assert.equal(locked.status, 429);
    assert.equal(cookieOf(locked), undefined);
  });
});

test('127.0.0.1 never needs the login, whatever the remote config says', async () => {
  writeConfig({ remote: { host: HOST, secret: SECRET } });
  await withServer(async ({ local }) => {
    const page = await local('GET', '/');
    assert.equal(page.status, 200);
    assert.equal((await local('GET', '/api/config', { headers: { 'x-token': tokenOf(page.body) } })).status, 200);
  });
});

test('Origin: a POST from another host is refused, "null" too; the same host passes (local and remote)', async () => {
  writeConfig({ remote: { host: HOST, secret: SECRET } });
  await withServer(async ({ local, remoteCall, port }) => {
    const token = tokenOf((await local('GET', '/')).body);
    const post = (origin) => local('POST', '/api/queue', { headers: { 'x-token': token, ...(origin ? { origin } : {}) }, body: {} });
    assert.equal((await post('http://evil.example')).status, 403);
    assert.equal((await post('null')).status, 403);
    assert.equal((await post(`http://127.0.0.1:${port}`)).status !== 403, true);
    assert.equal((await post()).status !== 403, true);
    assert.equal((await remoteCall('POST', '/login', { headers: { origin: 'https://evil.example' }, body: { secret: SECRET } })).status, 403);
    assert.equal((await remoteCall('POST', '/login', { headers: { origin: `https://${HOST}` }, body: { secret: SECRET } })).status, 200);
  });
});

test('the remote Host is compared exactly (case aside): a lookalike or a suffix is refused', async () => {
  writeConfig({ remote: { host: HOST, secret: SECRET } });
  await withServer(async ({ remoteCall, port }) => {
    assert.equal((await remoteCall('GET', '/', { headers: { host: HOST.toUpperCase() } })).status, 401);
    assert.equal((await remoteCall('GET', '/', { headers: { host: `${HOST}:${port}` } })).status, 401);
    assert.equal((await remoteCall('GET', '/', { headers: { host: `evil.${HOST}` } })).status, 403);
    assert.equal((await remoteCall('GET', '/', { headers: { host: `${HOST}.evil.example` } })).status, 403);
  });
});

test('remote.js: signed sessions verify only with the same secret before their expiry; the limiter locks and releases', () => {
  const now = 1_000_000;
  const value = remote.signSession(SECRET, now);
  assert.equal(remote.verifySession(SECRET, value, now + 1000), true);
  assert.equal(remote.verifySession('another-secret-another-secret', value, now + 1000), false);
  assert.equal(remote.verifySession(SECRET, value, now + remote.SESSION_MS + 1), false);
  assert.equal(remote.verifySession(SECRET, undefined, now), false);
  let t = 0;
  const limiter = remote.createLoginLimiter({ now: () => t, max: 3, lockMs: 1000 });
  for (let i = 0; i < 3; i++) { assert.equal(limiter.locked(), false); limiter.fail(); }
  assert.equal(limiter.locked(), true);
  t = 1001;
  assert.equal(limiter.locked(), false);
  limiter.fail(); limiter.success();
  for (let i = 0; i < 2; i++) limiter.fail();
  assert.equal(limiter.locked(), false);
});

test('config: `remote` is read, cleaned and written back untouched by a save', () => {
  writeConfig({ remote: { host: `  ${HOST.toUpperCase()} `, secret: SECRET } });
  assert.deepEqual(loadConfig().remote, { host: HOST, secret: SECRET });
  saveConfig({ ...loadConfig(), snoozed: ['x:1'] });
  assert.deepEqual(JSON.parse(fs.readFileSync(configFile, 'utf8')).remote, { host: HOST, secret: SECRET });
  writeConfig({ remote: { host: 'https://bad/host', secret: 5 } });
  assert.deepEqual(remote.remoteOf(loadConfig()), null);
  writeConfig();
  assert.equal(loadConfig().remote, undefined);
});
