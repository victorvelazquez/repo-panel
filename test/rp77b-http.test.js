'use strict';
// RP77b (S68, S71, S72), GET /api/events. A long-lived route handled before the normal ones, outside singleFlight and perf: host check (403),
// token ONLY in the `x-token` header (401; a `?token=` never authenticates), 200 text/event-stream, then the hub preamble and snapshot; more than
// maxClients get 503 JSON; a disconnect removes the client; closing the server ends every stream. Real http server on an ephemeral port and
// a real client; the tests wait for BYTES (the stream's own data events), never for time. Fake Orca that counts calls; temp config.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'rp77bh-'));
const configFile = path.join(scratch, 'config.json');
process.env.REPO_PANEL_CONFIG = configFile;
process.env.REPO_PANEL_CASES_FILE = 'off';
fs.writeFileSync(configFile, JSON.stringify({ port: 4310, groups: [], rooms: [] }));
test.after(() => fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 5 }));

const { createServer } = require('../server/http.js');
const events = () => require('../server/events.js');

const PREAMBLE = 'retry: 3000\n\n';
const EMPTY_SNAPSHOT = 'event: snapshot\ndata: []\n\n';
const P1 = { state: 'busy', live: { state: 'working', count: 1 } };
const frame = (id, payload) => `event: live\ndata: ${JSON.stringify({ id, ...payload })}\n\n`;

const freePort = () => new Promise((resolve) => {
  const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
});

// One request that is read as a stream: `until(text)` resolves when the body so far contains `text` (rejects if the stream ends first).
function open(port, { token, p = '/api/events', host = `127.0.0.1:${port}`, method = 'GET' } = {}) {
  return new Promise((resolve, reject) => {
    const headers = { host, ...(token ? { 'x-token': token } : {}) };
    const req = http.request({ host: '127.0.0.1', port, path: p, method, headers, agent: false }, (res) => {
      let body = '';
      let ended = false;
      const waiters = [];
      const check = () => { for (const w of waiters.splice(0)) { if (body.includes(w.text)) w.ok(body); else if (ended) w.no(new Error(`stream ended before ${JSON.stringify(w.text)}; got ${JSON.stringify(body)}`)); else waiters.push(w); } };
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; check(); });
      const done = () => { ended = true; check(); };
      res.on('end', done); res.on('close', done); res.on('error', done);
      const ending = new Promise((r) => { res.on('close', r); });
      resolve({
        status: res.statusCode, headers: res.headers, res, req, ending,
        text: () => body,
        until: (text) => new Promise((ok, no) => { waiters.push({ text, ok, no }); check(); }),
        close: () => req.destroy(),
      });
    });
    req.on('error', reject);
    req.end();
  });
}

// A server on an ephemeral port with an injected hub and a fake Orca that must never be called by the events route.
async function withServer(fn, { hub = events().createEventHub() } = {}) {
  const port = await freePort();
  const orcaCalls = [];
  const server = createServer(port, { hub, orca: async (args) => { orcaCalls.push(args); throw new Error('orca must not be called'); } });
  await new Promise((r) => server.listen(port, '127.0.0.1', r));
  const page = await open(port, { p: '/' });
  await page.ending;
  const token = /name="?token"? content="([0-9a-f]+)"/.exec(page.text())[1];
  const json = async (p, tk = token) => { const r = await open(port, { token: tk, p }); await r.ending; return JSON.parse(r.text()); };
  try { await fn({ port, token, server, hub, orcaCalls, json }); } finally { try { hub.closeAll(); server.close(); server.closeAllConnections(); } catch { /* already closed */ } }
}

test('createServer exposes the hub it was given as server.hub, and makes its own when none is given', async () => {
  const hub = events().createEventHub();
  const own = createServer(1, { hub });
  assert.equal(own.hub, hub);
  const dflt = createServer(1, {});
  assert.equal(typeof dflt.hub.add, 'function');
  assert.equal(typeof dflt.hub.publish, 'function');
  assert.equal(dflt.hub.size(), 0);
  assert.notEqual(dflt.hub, createServer(1, {}).hub, 'one hub per server');
});

test('with the token: 200, text/event-stream, no-cache, keep-alive, then the preamble and an empty snapshot', async () => {
  await withServer(async ({ port, token, hub }) => {
    const c = await open(port, { token });
    assert.equal(c.status, 200);
    assert.equal(c.headers['content-type'], 'text/event-stream');
    assert.equal(c.headers['cache-control'], 'no-cache');
    assert.equal(c.headers.connection, 'keep-alive');
    await c.until(PREAMBLE + EMPTY_SNAPSHOT);
    assert.equal(c.text(), PREAMBLE + EMPTY_SNAPSHOT, 'exactly the preamble and the snapshot, nothing else');
    assert.equal(hub.size(), 1);
    c.close();
  });
});

test('a publish reaches every open stream as one live frame; a late client gets it in its snapshot', async () => {
  await withServer(async ({ port, token, hub }) => {
    const a = await open(port, { token });
    const b = await open(port, { token });
    await a.until(EMPTY_SNAPSHOT);
    await b.until(EMPTY_SNAPSHOT);
    hub.publish('0123456789', P1);
    await a.until(frame('0123456789', P1));
    await b.until(frame('0123456789', P1));
    assert.equal(a.text(), PREAMBLE + EMPTY_SNAPSHOT + frame('0123456789', P1));
    const late = await open(port, { token });
    const snap = `event: snapshot\ndata: ${JSON.stringify([{ id: '0123456789', ...P1 }])}\n\n`;
    await late.until(snap);
    assert.equal(late.text(), PREAMBLE + snap);
    [a, b, late].forEach((c) => c.close());
  });
});

test('no token or a wrong token: 401 JSON error, no stream, the hub is untouched', async () => {
  await withServer(async ({ port, hub }) => {
    for (const token of [undefined, 'wrong', '']) {
      const r = await open(port, { token });
      await r.ending;
      assert.equal(r.status, 401, String(token));
      assert.match(r.headers['content-type'], /^application\/json/);
      assert.deepEqual(JSON.parse(r.text()), { error: 'Invalid token' });
    }
    assert.equal(hub.size(), 0);
  });
});

test('a ?token= in the URL does NOT authenticate (valid token, no header: 401)', async () => {
  await withServer(async ({ port, token, hub }) => {
    const r = await open(port, { p: `/api/events?token=${token}` });
    await r.ending;
    assert.equal(r.status, 401);
    assert.deepEqual(JSON.parse(r.text()), { error: 'Invalid token' });
    assert.equal(hub.size(), 0);
  });
});

test('the header still works with a query string present (the query is ignored)', async () => {
  await withServer(async ({ port, token }) => {
    const c = await open(port, { token, p: '/api/events?x=1' });
    assert.equal(c.status, 200);
    await c.until(EMPTY_SNAPSHOT);
    c.close();
  });
});

test('another host: 403 even with a valid token, and 403 before the token check without one', async () => {
  await withServer(async ({ port, token, hub }) => {
    for (const tk of [token, undefined]) {
      const r = await open(port, { token: tk, host: 'evil.example:80' });
      await r.ending;
      assert.equal(r.status, 403);
      assert.deepEqual(JSON.parse(r.text()), { error: 'Forbidden host' });
    }
    const local = await open(port, { token, host: `localhost:${port}` });
    assert.equal(local.status, 200, 'localhost:port is an own host name');
    local.close();
  });
});

test('more than maxClients: the extra one gets 503 JSON {error} and the hub keeps exactly maxClients', async () => {
  await withServer(async ({ port, token, hub }) => {
    const a = await open(port, { token });
    const b = await open(port, { token });
    await a.until(EMPTY_SNAPSHOT);
    await b.until(EMPTY_SNAPSHOT);
    assert.equal(hub.size(), 2, 'exactly maxClients is accepted');
    const c = await open(port, { token });
    await c.ending;
    assert.equal(c.status, 503);
    assert.match(c.headers['content-type'], /^application\/json/);
    const body = JSON.parse(c.text());
    assert.deepEqual(Object.keys(body), ['error']);
    assert.equal(typeof body.error, 'string');
    assert.ok(body.error.length > 0);
    assert.equal(hub.size(), 2);
    a.close(); b.close();
  }, { hub: events().createEventHub({ maxClients: 2 }) });
});

test('a client that disconnects is removed from the hub and its slot is free again', async () => {
  const real = events().createEventHub({ maxClients: 1 });
  let gone;
  const closed = new Promise((r) => { gone = r; });
  // The real hub registers its own close listener first; ours runs after it, so size() is already updated when `closed` resolves.
  const hub = { ...real, add(res) { const ok = real.add(res); if (ok) res.on('close', gone); return ok; } };
  await withServer(async ({ port, token }) => {
    const a = await open(port, { token });
    await a.until(EMPTY_SNAPSHOT);
    assert.equal(real.size(), 1);
    a.close();
    await closed;
    assert.equal(real.size(), 0);
    const b = await open(port, { token });
    assert.equal(b.status, 200, 'the slot was freed');
    await b.until(EMPTY_SNAPSHOT);
    b.close();
  }, { hub });
});

test('the events route is not a perf route and never touches Orca', async () => {
  await withServer(async ({ port, token, json, orcaCalls }) => {
    const c = await open(port, { token });
    await c.until(EMPTY_SNAPSHOT);
    const denied = await open(port, {});
    await denied.ending;
    const perf = await json('/api/perf');
    assert.deepEqual(Object.keys(perf.routes).filter((k) => /events/.test(k)), []);
    assert.equal(perf.routes['GET (other)'], undefined);
    assert.deepEqual(orcaCalls, []);
    c.close();
  });
});

test('closing the http server ends every open stream, so server.close() resolves', async () => {
  await withServer(async ({ port, token, server, hub }) => {
    const a = await open(port, { token });
    const b = await open(port, { token });
    await a.until(EMPTY_SNAPSHOT);
    await b.until(EMPTY_SNAPSHOT);
    assert.equal(hub.size(), 2);
    await new Promise((resolve, reject) => { server.close((e) => (e ? reject(e) : resolve())); });
    await a.ending;
    await b.ending;
    assert.equal(a.res.complete, true, 'the stream ended cleanly (a final chunk), it was not torn down');
    assert.equal(hub.size(), 0);
  });
});

test('the normal routes are unchanged next to the stream: /health and an unknown route', async () => {
  await withServer(async ({ port, token, json }) => {
    const c = await open(port, { token });
    await c.until(EMPTY_SNAPSHOT);
    assert.equal((await json('/health')).app, 'repo-panel');
    const missing = await open(port, { token, p: '/api/eventz' });
    await missing.ending;
    assert.equal(missing.status, 404);
    c.close();
  });
});
