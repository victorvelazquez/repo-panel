'use strict';
// RPC1b (S1, S2): the /api/rpc routes and the `rpc` SSE event. The host is the real createRpcHost over a fake client, so no program is
// started; the config file is a scratch one. Abuse tests: no token, unknown repo, bad bodies, and browser fields that must change nothing.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'rpc1b-http-'));
const REPO = path.join(scratch, 'My Repo');
fs.mkdirSync(REPO);
process.env.REPO_PANEL_CONFIG = path.join(scratch, 'config.json');
test.after(() => fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 5 }));

const lib = require('../lib.js');
const { createServer } = require('../server/http.js');
const { createRpcHost } = require('../server/rpchost.js');
const { findRepo } = require('../server/config.js');
const { createEventHub } = require('../server/events.js');

const ID = lib.repoId(REPO);
const ACTIVE = { id: 'gentle-shell', command: 'C:\\L\\gentle-shell.exe', agentDir: 'C:\\a' };
const writeConfig = (extra = {}) => fs.writeFileSync(process.env.REPO_PANEL_CONFIG, JSON.stringify({ groups: [{ name: 'g', repos: [{ path: REPO }] }], ...extra }));

function fakeFactory() {
  const made = [];
  const createClient = (opts) => {
    const c = {
      opts, reqs: [], answers: [], dialogs: [], closed: 0,
      start: async () => ({}),
      request: async (type, fields) => { c.reqs.push([type, fields]); return { disposition: 'started' }; },
      answerDialog: (id, a) => { c.answers.push([id, a]); return c.dialogs.includes(id); },
      pendingDialogs: () => c.dialogs.map((id) => ({ id, method: 'confirm' })),
      state: () => 'idle',
      close: () => { c.closed++; },
    };
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
async function withServer(fn, { hub } = {}) {
  writeConfig();
  const f = fakeFactory();
  const port = await freePort();
  const hubInstance = hub || createEventHub();
  const host = createRpcHost({ resolve: async () => ({ active: ACTIVE }), repoOf: findRepo, publish: (id, p) => hubInstance.emit('rpc', id, p), createClient: f.createClient });
  const server = createServer(port, { noSummaryStore: true, hub: hubInstance, rpcHost: host });
  await new Promise((r) => server.listen(port, '127.0.0.1', r));
  try {
    const token = /name="?token"? content="([0-9a-f]+)"/.exec((await call(port, 'GET', '/')).body)[1];
    const post = (p, body) => call(port, 'POST', `/api/rpc/${p}`, { token, body });
    return await fn({ port, token, post, get: (p) => call(port, 'GET', p, { token }), made: f.made, host, server });
  } finally { await new Promise((r) => server.close(r)); }
}

const ROUTES = [['POST', 'start', { id: ID }], ['POST', 'prompt', { id: ID, text: 'x' }], ['POST', 'steer', { id: ID, text: 'x' }], ['POST', 'abort', { id: ID }], ['POST', 'dialog', { id: ID, requestId: 'd1', cancelled: true }], ['GET', 'status', null]];
const urlOf = ([m, name]) => `/api/rpc/${name}${m === 'GET' ? `?id=${ID}` : ''}`;

test('a1: every route needs the token and does nothing without it', async () => {
  await withServer(async ({ port, made }) => {
    for (const r of ROUTES) {
      const res = await call(port, r[0], urlOf(r), { body: r[2] || undefined });
      assert.equal(res.status, 401, r[1]);
      const bad = await call(port, r[0], urlOf(r), { token: 'wrong', body: r[2] || undefined });
      assert.equal(bad.status, 401, `${r[1]} with a wrong token`);
    }
    assert.equal(made.length, 0);
  });
});

test('a2: an unknown repo is 404 on every route, and the id is not echoed', async () => {
  await withServer(async ({ post, get, made }) => {
    const bodies = { start: {}, prompt: { text: 'x' }, steer: { text: 'x' }, abort: {}, dialog: { requestId: 'd', cancelled: true } };
    for (const [name, b] of Object.entries(bodies)) {
      const r = await post(name, { id: 'ECHOME-unknown', ...b });
      assert.equal(r.status, 404, name);
      assert.equal(r.body.includes('ECHOME'), false, name);
    }
    const g = await get('/api/rpc/status?id=ECHOME-unknown');
    assert.equal(g.status, 404);
    assert.equal(g.body.includes('ECHOME'), false);
    assert.equal(made.length, 0);
  });
});

test('a3: malformed bodies are 400 with a fixed message that echoes nothing', async () => {
  await withServer(async ({ post, port, token, made }) => {
    const raws = [[], 'ECHOME', 5, null, { id: 5 }, { id: { x: 'ECHOME' } }, { id: ['ECHOME'] }, { id: '' }, {}];
    for (const name of ['start', 'prompt', 'steer', 'abort', 'dialog']) {
      for (const b of raws) {
        const r = await post(name, b);
        assert.equal(r.status, 400, `${name} ${JSON.stringify(b)}`);
        assert.equal(r.body.includes('ECHOME'), false);
      }
    }
    for (const b of [{ id: ID, text: { x: 'ECHOME' } }, { id: ID, text: 5 }, { id: ID }, { id: ID, text: '   ' }]) {
      const r = await post('prompt', b);
      assert.equal(r.status, 400, JSON.stringify(b));
      assert.equal(r.body.includes('ECHOME'), false);
    }
    const broken = await call(port, 'POST', '/api/rpc/start', { token, body: undefined });
    assert.equal(broken.status, 400);
    assert.equal(made.length, 0);
  });
});

test('a4: start answers the status; prompt, steer and abort reach the session of that repo with cleaned text', async () => {
  await withServer(async ({ post, get, made }) => {
    const s = await post('start', { id: ID });
    assert.equal(s.status, 200);
    assert.deepEqual(s.json, { state: 'idle', pendingDialogs: [], sessionId: 'panel-my-repo' });
    assert.equal(made.length, 1);
    assert.equal((await post('start', { id: ID })).status, 200);
    assert.equal(made.length, 1);
    const p = await post('prompt', { id: ID, text: ' hi\r\nthere\u0007 ', behavior: 'followUp' });
    assert.equal(p.status, 200);
    assert.deepEqual(p.json, { disposition: 'started' });
    assert.equal((await post('steer', { id: ID, text: 'left' })).status, 200);
    assert.equal((await post('abort', { id: ID })).status, 200);
    assert.deepEqual(made[0].reqs, [['prompt', { message: 'hi\nthere', streamingBehavior: 'followUp' }], ['steer', { message: 'left' }], ['abort', {}]]);
    const g = await get(`/api/rpc/status?id=${ID}`);
    assert.deepEqual(g.json, { state: 'idle', pendingDialogs: [], sessionId: 'panel-my-repo' });
    for (const k of ['command', 'cwd', 'agentDir', 'gentle-shell.exe']) assert.equal(g.body.includes(k), false, k);
  });
});

test('a5: prompt refuses an empty text, a text over 20000 characters and a `!` start, and sends nothing', async () => {
  await withServer(async ({ post, made }) => {
    await post('start', { id: ID });
    for (const text of ['', '!dir', 'x'.repeat(20001)]) {
      const r = await post('prompt', { id: ID, text });
      assert.equal(r.status, 400);
      assert.equal(r.body.includes('xxxx'), false);
    }
    assert.deepEqual(made[0].reqs, []);
  });
});

test('a6: behavior outside steer and followUp is 400', async () => {
  await withServer(async ({ post, made }) => {
    await post('start', { id: ID });
    for (const behavior of ['queue', 'Steer', 'follow_up', '', 5, null, true, ['steer'], { a: 1 }]) {
      const r = await post('prompt', { id: ID, text: 'x', behavior });
      assert.equal(r.status, 400, JSON.stringify(behavior));
    }
    assert.deepEqual(made[0].reqs, []);
  });
});

test('a7: a prompt or an abort without a started session is 409 and starts nothing', async () => {
  await withServer(async ({ post, made }) => {
    for (const [name, b] of [['prompt', { id: ID, text: 'x' }], ['steer', { id: ID, text: 'x' }], ['abort', { id: ID }], ['dialog', { id: ID, requestId: 'd', cancelled: true }]]) assert.equal((await post(name, b)).status, 409, name);
    assert.equal(made.length, 0);
  });
});

test('a8: dialog takes exactly one answer shape, a pending request id and a clean value', async () => {
  await withServer(async ({ post, made }) => {
    await post('start', { id: ID });
    made[0].dialogs.push('d1');
    const base = { id: ID, requestId: 'd1' };
    const bad = [{ ...base }, { ...base, value: 'a', confirmed: true }, { ...base, value: 'a', cancelled: true }, { ...base, confirmed: true, cancelled: true }, { ...base, value: 5 }, { ...base, value: 'x'.repeat(4001) }, { ...base, value: 'a\u0007b' }, { ...base, value: 'a\u001b[0m' }, { ...base, confirmed: 'yes' }, { ...base, confirmed: 1 }, { ...base, cancelled: false }, { ...base, cancelled: 'true' }, { id: ID, cancelled: true }, { id: ID, requestId: 5, cancelled: true }, { id: ID, requestId: { a: 1 }, cancelled: true }];
    for (const b of bad) assert.equal((await post('dialog', b)).status, 400, JSON.stringify(b).slice(0, 80));
    assert.deepEqual(made[0].answers, [], 'a malformed answer never reaches the session');
    const stale = await post('dialog', { id: ID, requestId: 'ECHOME', value: 'a' });
    assert.equal(stale.status, 409);
    assert.equal(stale.body.includes('ECHOME'), false);
    assert.deepEqual(made[0].answers.at(-1), ['ECHOME', { value: 'a' }]);
    assert.equal((await post('dialog', { ...base, value: 'line1\nline2\ttab' })).status, 200);
    assert.deepEqual(made[0].answers.at(-1), ['d1', { value: 'line1\nline2\ttab' }]);
    assert.equal((await post('dialog', { ...base, confirmed: false })).status, 200);
    assert.deepEqual(made[0].answers.at(-1), ['d1', { confirmed: false }]);
    assert.equal((await post('dialog', { ...base, cancelled: true })).status, 200);
    assert.deepEqual(made[0].answers.at(-1), ['d1', { cancelled: true }]);
  });
});

test('a9: no route takes a command, cwd, path, args or env from the browser', async () => {
  await withServer(async ({ post, made }) => {
    const evil = { command: 'calc.exe', cwd: 'C:\\Windows', path: 'C:\\Windows', args: ['--x'], env: { PI_X: '1' }, agentDir: 'C:\\evil', sessionId: 'evil', runtime: 'pi' };
    assert.equal((await post('start', { id: ID, ...evil })).status, 200);
    assert.equal(made.length, 1);
    assert.equal(made[0].opts.cwd, REPO);
    assert.equal(made[0].opts.command, ACTIVE.command);
    assert.deepEqual(made[0].opts.args, ['--mode', 'rpc', '--session-id', 'panel-my-repo']);
    assert.equal(JSON.stringify(made[0].opts.env).includes('"PI_X"'), false);
    await post('prompt', { id: ID, text: 'x', ...evil });
    await post('steer', { id: ID, text: 'x', ...evil });
    await post('abort', { id: ID, ...evil });
    assert.deepEqual(made[0].reqs, [['prompt', { message: 'x' }], ['steer', { message: 'x' }], ['abort', {}]]);
    assert.equal(made.length, 1);
  });
});

test('e1: an event of a session reaches the page as `event: rpc`, and the live events are byte-identical', async () => {
  await withServer(async ({ port, token, post, made, server }) => {
    const frames = [];
    const req = http.get({ host: '127.0.0.1', port, path: '/api/events', headers: { 'x-token': token } }, (res) => { res.setEncoding('utf8'); res.on('data', (c) => frames.push(c)); });
    await new Promise((r) => setTimeout(r, 100));
    server.hub.publish('abc', { state: 'idle' });
    await post('start', { id: ID });
    made[0].opts.onEvent({ kind: 'event', record: { type: 'agent_start' } });
    made[0].opts.onEvent({ kind: 'dialog', id: 'd1', method: 'confirm', title: 'T' });
    await new Promise((r) => setTimeout(r, 100));
    req.destroy();
    const text = frames.join('');
    assert.ok(text.includes('event: live\ndata: {"id":"abc","state":"idle"}\n\n'));
    assert.ok(text.includes(`event: rpc\ndata: {"kind":"event","record":{"type":"agent_start"},"id":"${ID}"}\n\n`));
    const dialog = text.split('\n\n').find((fr) => fr.includes('"kind":"dialog"'));
    assert.ok(dialog.startsWith('event: rpc\ndata: '));
    assert.deepEqual(JSON.parse(dialog.slice('event: rpc\ndata: '.length)), { kind: 'dialog', method: 'confirm', title: 'T', requestId: 'd1', id: ID });
  });
});

test('e2: still holding: a route that existed answers as before, an unknown route is 404 and close ends the streams and the sessions', async () => {
  await withServer(async ({ get, port, token, host, post, made, server }) => {
    assert.equal((await get('/api/config')).status, 200);
    assert.equal((await call(port, 'GET', '/api/nope', { token })).status, 404);
    assert.equal((await call(port, 'GET', '/api/rpc/status')).status, 401);
    await post('start', { id: ID });
    const ended = new Promise((resolve) => { const r = http.get({ host: '127.0.0.1', port, path: '/api/events', headers: { 'x-token': token } }, (res) => { res.resume(); res.on('end', resolve); res.on('close', resolve); }); r.on('error', () => resolve()); });
    await new Promise((r) => setTimeout(r, 100));
    await new Promise((r) => server.close(r));
    await ended;
    assert.deepEqual(made.map((c) => c.closed), [1], 'closing the server closes the sessions');
    assert.equal((await host.status(ID)).state, 'closed');
  });
});

test('e3: the cap of 8 event streams still holds', async () => {
  await withServer(async ({ port, token }) => {
    const opened = [];
    for (let i = 0; i < 9; i++) {
      opened.push(await new Promise((resolve) => { const r = http.get({ host: '127.0.0.1', port, path: '/api/events', headers: { 'x-token': token } }, (res) => { resolve({ r, status: res.statusCode }); res.resume(); }); r.on('error', () => resolve({ r, status: 0 })); }));
    }
    assert.deepEqual(opened.map((o) => o.status), [200, 200, 200, 200, 200, 200, 200, 200, 503]);
    opened.forEach((o) => o.r.destroy());
  });
});

// ---------- the hub ----------
const fakeRes = () => { const res = { writes: [], on() { return res; }, write(c) { res.writes.push(String(c)); return true; }, end() {}, writableLength: 0 }; return res; };

test('e4: hub.emit writes one `event: rpc` frame; it is not remembered, cannot be forged and the repo id wins', () => {
  const hub = createEventHub();
  const res = fakeRes();
  hub.add(res);
  res.writes.length = 0;
  hub.emit('rpc', 'abc', { kind: 'event', id: 'FORGED', record: { text: 'a\u2028b\nevent: live' } });
  assert.deepEqual(res.writes, ['event: rpc\ndata: {"kind":"event","id":"abc","record":{"text":"a\\u2028b\\nevent: live"}}\n\n']);
  assert.equal(hub.snapshotFor(), 'event: snapshot\ndata: []\n\n', 'an rpc event never enters the snapshot');
  hub.publish('abc', { state: 'idle' });
  assert.equal(res.writes.at(-1), 'event: live\ndata: {"id":"abc","state":"idle"}\n\n');
  assert.doesNotThrow(() => createEventHub().emit('rpc', 'x', { kind: 'state' }));
});

