'use strict';
// F4: a panel that stops updating is seen within minutes. The Summary store says it is down when no sweep ended well for more than
// 2 minutes; panel.ok of GET /api/attention and `ok` of GET /api/server-state report it; the page warns when the server says so or
// when its own reads of the Summary or the board keep failing for more than 2 minutes.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'rp-f4-'));
process.env.REPO_PANEL_CONFIG = path.join(scratch, 'config.json');
fs.writeFileSync(process.env.REPO_PANEL_CONFIG, JSON.stringify({ groups: [] }));
test.after(() => fs.rmSync(scratch, { recursive: true, force: true }));

const { createSummaryStore, DOWN_MS } = require('../server/summarystore.js');
const { createServer } = require('../server/http.js');
const V = require('../public/view.js');

const MIN = 60000;
// A store on a hand clock; `cfg` decides what each sweep finds (a throwing config makes the sweep fail).
function clockStore({ waitForClient = false, cfg = () => ({ groups: [] }) } = {}) {
  const clock = { t: 1_000_000 };
  const store = createSummaryStore({ now: () => clock.t, loadCfg: () => cfg(), waitForClient, setTimer: () => null, clearTimer: () => {} });
  return { store, clock };
}

test('F4: the store is healthy while its sweeps end well, and down after more than 2 minutes without one', async () => {
  assert.equal(DOWN_MS, 2 * MIN);
  const { store, clock } = clockStore();
  assert.deepEqual(store.health(), { ok: true });
  await store.tick();
  clock.t += 2 * MIN;
  assert.deepEqual(store.health(), { ok: true }, 'exactly 2 minutes is not down yet');
  clock.t += 1;
  assert.deepEqual(store.health(), { ok: false });
  await store.tick();
  assert.deepEqual(store.health(), { ok: true }, 'a sweep that ends well brings it back');
});

test('F4 abuse: sweeps that fail in silence (the config cannot be read) turn the store down after 2 minutes, never throwing', async () => {
  let broken = false;
  const { store, clock } = clockStore({ cfg: () => { if (broken) throw new Error('config unreadable'); return { groups: [] }; } });
  await store.tick();
  broken = true;
  for (let i = 0; i < 5; i++) { clock.t += 30000; await store.tick(); }
  assert.deepEqual(store.health(), { ok: false });
});

test('F4: a store that waits for a page and was never asked is not down, however long it waits', () => {
  const { store, clock } = clockStore({ waitForClient: true });
  clock.t += 60 * MIN;
  assert.deepEqual(store.health(), { ok: true });
});

const freePort = () => new Promise((resolve) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });
const call = (port, p, headers = {}) => new Promise((resolve, reject) => {
  http.get({ host: '127.0.0.1', port, path: p, headers }, (res) => { let d = ''; res.on('data', (c) => { d += c; }); res.on('end', () => { let json = null; try { json = JSON.parse(d); } catch { /* html */ } resolve({ status: res.statusCode, json, body: d }); }); }).on('error', reject);
});
async function withServer(deps, fn) {
  const port = await freePort();
  const server = createServer(port, { sessionsDir: path.join(scratch, 'sessions'), rpcHost: { stateOf: () => 'closed', closeAll: async () => {} }, ...deps });
  await new Promise((r) => server.listen(port, '127.0.0.1', r));
  try {
    const token = /name="?token"? content="([0-9a-f]+)"/.exec((await call(port, '/')).body)[1];
    await fn((p) => call(port, p, { 'x-token': token }));
  } finally { await new Promise((r) => server.close(r)); }
}

test('F4: panel.ok of /api/attention and ok of /api/server-state follow the store; its seq moves when ok changes', async () => {
  const { store, clock } = clockStore();
  await store.tick();
  await withServer({ summaryStore: store }, async (get) => {
    const up = (await get('/api/attention')).json;
    assert.deepEqual(up.panel, { ok: true, stale: false });
    assert.equal((await get('/api/server-state')).json.ok, true);
    clock.t += 3 * MIN;
    const down = (await get('/api/attention')).json;
    assert.deepEqual(down.panel, { ok: false, stale: false });
    assert.notEqual(down.seq, up.seq);
    assert.deepEqual((await get('/api/server-state')).json, { stale: false, ok: false });
  });
});

test('F4: without a Summary store the panel reports ok, as before', async () => {
  await withServer({ noSummaryStore: true }, async (get) => {
    assert.deepEqual((await get('/api/attention')).json.panel, { ok: true, stale: false });
    assert.deepEqual((await get('/api/server-state')).json, { stale: false, ok: true });
  });
});

test('F4: the page warns when the server is down or when one of its reads keeps failing for more than 2 minutes', () => {
  const now = 10 * MIN;
  const at = (over = {}) => V.panelDown({ now, serverOk: true, failSince: { summary: null, board: null }, ...over });
  assert.equal(V.PANEL_DOWN_MS, 2 * MIN);
  assert.equal(at(), false);
  assert.equal(at({ serverOk: false }), true);
  assert.equal(at({ serverOk: null }), false, 'an unknown answer (an old server, a failed question) says nothing');
  assert.equal(at({ failSince: { summary: now - 2 * MIN, board: null } }), false, 'exactly 2 minutes is not down yet');
  assert.equal(at({ failSince: { summary: now - 2 * MIN - 1, board: null } }), true);
  assert.equal(at({ failSince: { summary: null, board: now - 5 * MIN } }), true);
  assert.equal(at({ failSince: { summary: now - MIN, board: now - MIN } }), false);
});
