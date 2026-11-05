'use strict';
// RP111b, server side: `GET /api/settings` and `POST /api/settings` over a CLOSED list of options (today only `chat.showResults`). The page can read and write nothing else of
// config.json: not the port, not the groups and paths, not the sessions, not another key of `chat`. The abuse tests come first: an unknown key, a value of another type or a body
// that is not an object is a 400 that leaves the file byte for byte as it was, and a write keeps every other key of config.json.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'rp111b-'));
const repoDir = path.join(scratch, 'My Repo.Api');
const roomDir = path.join(scratch, 'room');
for (const d of [repoDir, roomDir]) fs.mkdirSync(d);
const configFile = path.join(scratch, 'config.json');
process.env.REPO_PANEL_CONFIG = configFile;
process.env.REPO_PANEL_SESSIONS_DIR = path.join(scratch, 'sessions');
test.after(() => fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 5 }));

const lib = require('../lib.js');
const { createServer } = require('../server/http.js');
const { OPTIONS } = require('../server/settings.js');

const REPO_ID = lib.repoId(repoDir);
const base = () => ({
  port: 4310, groups: [{ name: 'G', repos: [{ path: repoDir }] }], rooms: [{ name: 'Sala', path: roomDir, repos: [] }],
  sessions: { [REPO_ID]: { id: 's1', name: 'panel:x', adoptedAt: '2026-10-28T10:00:00.000Z' } }, pi: { runtime: 'pi' }, priority: ['My Repo.Api'], snoozed: ['abc:1'],
});
const writeConfig = (extra = {}) => fs.writeFileSync(configFile, JSON.stringify({ ...base(), ...extra }));
const text = () => fs.readFileSync(configFile, 'utf8');

async function withServer(fn) {
  const port = await new Promise((resolve) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const { port: p } = s.address(); s.close(() => resolve(p)); }); });
  const server = createServer(port, {});
  await new Promise((r) => server.listen(port, '127.0.0.1', r));
  const call = (method, p, token, body) => new Promise((resolve, reject) => {
    const payload = body === undefined ? null : typeof body === 'string' ? body : JSON.stringify(body);
    const req = http.request({ host: '127.0.0.1', port, path: p, method, headers: { host: `127.0.0.1:${port}`, ...(token ? { 'x-token': token } : {}), ...(payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {}) } }, (res) => {
      let d = ''; res.on('data', (c) => { d += c; }); res.on('end', () => resolve({ status: res.statusCode, text: d }));
    });
    req.on('error', reject); if (payload) req.write(payload); req.end();
  });
  try {
    const token = /name="?token"? content="([0-9a-f]+)"/.exec((await call('GET', '/')).text)[1];
    await fn({ get: (p, t = token) => call('GET', p, t), post: (b, t = token) => call('POST', '/api/settings', t, b), token, call });
  } finally { server.close(); server.closeAllConnections(); }
}
const body = (r) => JSON.parse(r.text);

// ---------- abuse ----------
test('abuse: a key that is not on the closed list is a 400 and the file does not change, whatever the key', async () => {
  writeConfig(); const before = text();
  await withServer(async ({ post }) => {
    for (const key of ['port', 'groups', 'rooms', 'sessions', 'pi', 'pi.runtime', 'chat', 'chat.other', 'chat.showresults', 'CHAT.SHOWRESULTS', ' chat.showResults', 'chat.showResults ', '__proto__', 'constructor', 'prototype', 'toString', 'hasOwnProperty', 'chat.__proto__', '', 'token', 'path', 'x'.repeat(5000)]) {
      const r = await post({ key, value: true });
      assert.equal(r.status, 400, JSON.stringify(key));
      assert.equal(text(), before, JSON.stringify(key));
    }
  });
});

test('abuse: a key that is not text, a missing key and a value of another type are a 400 and the file does not change', async () => {
  writeConfig(); const before = text();
  await withServer(async ({ post }) => {
    for (const b of [{ key: 1, value: true }, { key: null, value: true }, { key: ['chat.showResults'], value: true }, { key: { a: 1 }, value: true }, { value: true }, {},
      { key: 'chat.showResults' }, { key: 'chat.showResults', value: 'true' }, { key: 'chat.showResults', value: 1 }, { key: 'chat.showResults', value: 0 }, { key: 'chat.showResults', value: null },
      { key: 'chat.showResults', value: {} }, { key: 'chat.showResults', value: [] }, { key: 'chat.showResults', value: [true] }, { key: 'chat.showResults', value: 'on' }]) {
      const r = await post(b);
      assert.equal(r.status, 400, JSON.stringify(b));
      assert.equal(text(), before, JSON.stringify(b));
    }
  });
});

test('abuse: a body that is not an object (text, a list, null, nothing, broken JSON) is a 400 and the file does not change', async () => {
  writeConfig(); const before = text();
  await withServer(async ({ call, token }) => {
    for (const b of ['"chat.showResults"', '[]', '[{"key":"chat.showResults","value":true}]', 'null', '42', 'true', '{broken', '']) {
      const r = await call('POST', '/api/settings', token, b === '' ? undefined : b);
      assert.equal(r.status, 400, JSON.stringify(b));
      assert.equal(text(), before, JSON.stringify(b));
    }
  });
});

test('abuse: without the token nothing is read and nothing is written', async () => {
  writeConfig(); const before = text();
  await withServer(async ({ get, post, call }) => {
    assert.equal((await get('/api/settings', '')).status, 401);
    assert.equal((await post({ key: 'chat.showResults', value: true }, '')).status, 401);
    assert.equal((await call('POST', '/api/settings', 'wrong-token', { key: 'chat.showResults', value: true })).status, 401);
  });
  assert.equal(text(), before);
});

test('abuse: GET answers the closed list and nothing else of the configuration (no port, groups, paths, sessions, rooms or other keys)', async () => {
  writeConfig({ chat: { showResults: true, other: 'SECRET-EXTRA' } });
  await withServer(async ({ get }) => {
    const r = await get('/api/settings');
    assert.equal(r.status, 200);
    assert.deepEqual(Object.keys(body(r)), ['options']);
    assert.deepEqual(body(r).options, [{ key: 'chat.showResults', value: true, default: false }]);
    for (const bad of ['4310', 'My Repo', repoDir.slice(0, 12), 'panel:x', 'Sala', 'SECRET-EXTRA', 'runtime', 'abc:1']) assert.ok(!r.text.includes(bad), bad);
  });
  assert.deepEqual(OPTIONS.map((o) => o.key), ['chat.showResults']);
});

// ---------- the behaviour ----------
test('GET: the default is off when config.json says nothing, and anything but true is off', async () => {
  for (const extra of [{}, { chat: {} }, { chat: { showResults: 'true' } }, { chat: { showResults: 1 } }, { chat: 'yes' }]) {
    writeConfig(extra);
    await withServer(async ({ get }) => { assert.deepEqual(body(await get('/api/settings')).options, [{ key: 'chat.showResults', value: false, default: false }], JSON.stringify(extra)); });
  }
});

test('POST: it sets the option, answers the list as it is now, and every other key of config.json is kept as it was', async () => {
  writeConfig({ dismissed: ['aaaaaaaaaa'] });
  // every key but `chat`, by name and in a fixed order (the panel writes its keys in its own order, which is not a change of any value)
  const rest = (t) => { const c = JSON.parse(t); delete c.chat; return JSON.stringify(Object.entries(c).sort(([a], [b]) => (a < b ? -1 : 1))); };
  const before = rest(text());
  await withServer(async ({ post, get }) => {
    const on = await post({ key: 'chat.showResults', value: true });
    assert.equal(on.status, 200);
    assert.deepEqual(body(on).options, [{ key: 'chat.showResults', value: true, default: false }]);
    assert.deepEqual(JSON.parse(text()).chat, { showResults: true });
    assert.equal(rest(text()), before);
    assert.deepEqual(body(await get('/api/settings')).options[0].value, true);
    const off = await post({ key: 'chat.showResults', value: false, ignored: 'x', port: 1 });
    assert.deepEqual(body(off).options[0].value, false);
    assert.deepEqual(JSON.parse(text()).chat, { showResults: false });
    assert.equal(rest(text()), before);
    assert.equal((await post({ key: 'chat.showResults', value: false })).status, 200);
  });
});

test('POST: the switch really changes what the chat answers (results: true appears with it on and goes with it off)', async () => {
  writeConfig();
  await withServer(async ({ get, post }) => {
    assert.equal('results' in body(await get(`/api/chat?id=${REPO_ID}`)), false);
    await post({ key: 'chat.showResults', value: true });
    assert.equal(body(await get(`/api/chat?id=${REPO_ID}`)).results, true);
    await post({ key: 'chat.showResults', value: false });
    assert.equal('results' in body(await get(`/api/chat?id=${REPO_ID}`)), false);
  });
});

test('POST: when config.json is missing or has ignored entries, the write still keeps what the panel keeps', async () => {
  writeConfig({ rooms: [{ name: 'Sala', path: roomDir, repos: [] }, { name: 'Bad', path: 'relative', repos: [] }] });
  await withServer(async ({ post }) => {
    assert.equal((await post({ key: 'chat.showResults', value: true })).status, 200);
    assert.equal(JSON.parse(text()).rooms.length, 2, 'the ignored room entry is written back untouched');
  });
});

// ---------- found by the independent check ----------
test('abuse: duplicate keys in the body (the last one wins, as JSON.parse says) and a `__proto__` property next to a valid key change nothing else', async () => {
  writeConfig({ pi: { runtime: 'pi', command: 'C:\tools\pi.cmd' } });
  await withServer(async ({ post }) => {
    const before = text();
    assert.equal((await post('{"key":"chat.showResults","key":"port","value":true}')).status, 400);
    assert.equal(text(), before);
    assert.equal((await post('{"key":"port","key":"chat.showResults","value":true}')).status, 200);
    assert.equal((await post('{"key":"chat.showResults","value":false,"__proto__":{"polluted":"x"},"constructor":{"prototype":{"polluted":"x"}}}')).status, 200);
    assert.equal(({}).polluted, undefined);
    const after = JSON.parse(text());
    assert.deepEqual(Object.keys(after).filter((k) => !(k in JSON.parse(before)) || k === 'chat').sort(), ['chat']);
    assert.equal(after.pi.command, 'C:\tools\pi.cmd', 'the command of pi is kept');
    assert.equal(after.port, 4310);
  });
});
