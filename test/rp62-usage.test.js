'use strict';
// RP62 (S61, S77), design points 1 to 3: server/usage.js (readUsage never rejects; usageFile picks the path) and GET /api/usage.
// Every file is built in a temp dir; the real claude-usage.json, the real config and Orca, git and gh are never touched. The clock is injected
// (readUsage({ now })); the route cases use values that do not depend on the real clock (a far-future or a very old date).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'rp62u-'));
const repoDir = path.join(scratch, 'RepoOne');
fs.mkdirSync(repoDir);
const ENV_FILE = path.join(scratch, 'env-usage.json'); // a safety net: a route that ignores deps.usageFile reads this, never the real file
process.env.REPO_PANEL_CONFIG = path.join(scratch, 'config.json');
process.env.REPO_PANEL_CASES_FILE = 'off';
process.env.REPO_PANEL_USAGE_FILE = ENV_FILE;
fs.writeFileSync(process.env.REPO_PANEL_CONFIG, JSON.stringify({ port: 4311, groups: [{ name: 'G', repos: [{ path: repoDir }] }], rooms: [] }));
test.after(() => fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 5 }));

const { readUsage, usageFile } = require('../server/usage.js');
const { createServer } = require('../server/http.js');

const NOW = 1_800_000_000_000; // a multiple of 1000, so seconds and ms line up exactly
const MIN = 60000;
const UNAVAILABLE = { available: false, five: null, seven: null, updatedAt: null, stale: false };
const KEYS = ['available', 'five', 'seven', 'updatedAt', 'stale'];

let n = 0;
const put = (content) => {
  const f = path.join(scratch, `u${n++}.json`);
  fs.writeFileSync(f, typeof content === 'string' ? content : JSON.stringify(content));
  return f;
};
const doc = (over = {}, windows = {}) => ({
  version: 1, updatedAt: NOW - MIN,
  windows: { '5h': { percent: 5, resetAt: NOW + 3600000 }, '7d': { percent: 40, resetAt: NOW + 86400000 }, ...windows },
  ...over,
});
const read = (content, now = NOW) => readUsage({ file: put(content), now: () => now });
const readWith = (windows, now = NOW) => read(doc({}, windows), now);

// ---------- point 1 and 2: readUsage ----------
test('a valid file: exact object, keys in order, percent rounded, resetAt in ms, nothing else', async () => {
  const r = await read(doc({}, { '5h': { percent: 5.4, resetAt: NOW + 3600000 }, '7d': { percent: 72.5, resetAt: (NOW + 86400000) / 1000 } }));
  assert.deepEqual(r, {
    available: true,
    five: { percent: 5, resetAt: NOW + 3600000, expired: false },
    seven: { percent: 73, resetAt: NOW + 86400000, expired: false },
    updatedAt: NOW - MIN,
    stale: false,
  });
  assert.deepEqual(Object.keys(r), KEYS);
  assert.deepEqual(Object.keys(r.five), ['percent', 'resetAt', 'expired']);
});

test('without an injected clock it uses Date.now', async (t) => {
  t.mock.method(Date, 'now', () => NOW);
  const r = await readUsage({ file: put(doc({ updatedAt: NOW - 900000 })) });
  assert.equal(r.stale, true);
  assert.equal(r.five.expired, false);
});

test('unknown extra fields are ignored and never returned', async () => {
  const f = put({ ...doc(), secret: 'top-secret-value', windows: { '5h': { percent: 1, resetAt: NOW + 1000, token: 'top-secret-token' }, '7d': { percent: 2, resetAt: NOW + 2000 }, '30d': { percent: 3, resetAt: NOW + 3000 } } });
  const r = await readUsage({ file: f, now: () => NOW });
  assert.deepEqual(Object.keys(r), KEYS);
  assert.deepEqual(Object.keys(r.five), ['percent', 'resetAt', 'expired']);
  assert.ok(!JSON.stringify(r).includes('top-secret'));
  assert.ok(!('30d' in r));
});

test('a file that cannot be used is { available: false, ... } and never throws or rejects', async () => {
  const dir = path.join(scratch, 'adir');
  fs.mkdirSync(dir);
  const bad = {
    missing: path.join(scratch, 'does-not-exist.json'),
    directory: dir,
    nul: `${scratch}${path.sep}a\0b.json`,
    empty: put(''),
    notJson: put('{ "version": 1, '),
    nan: put('{"version":1,"updatedAt":NaN,"windows":{}}'),
    array: put('[]'), nullJson: put('null'), number: put('5'), string: put('"x"'), bool: put('true'),
    noVersion: put({ updatedAt: NOW, windows: {} }),
    version2: put(doc({ version: 2 })),
    versionString: put(doc({ version: '1' })),
    noUpdatedAt: put({ version: 1, windows: {} }),
  };
  for (const [name, file] of Object.entries(bad)) {
    const p = readUsage({ file, now: () => NOW });
    assert.ok(p instanceof Promise, name);
    assert.deepEqual(await p, UNAVAILABLE, name);
    assert.deepEqual(Object.keys(await readUsage({ file, now: () => NOW })), KEYS, name);
  }
});

test('updatedAt must be a finite number greater than 0', async () => {
  for (const v of [0, -1, '1700000000000', null, true, [], {}, 1e999]) assert.deepEqual(await read(doc({ updatedAt: v })), UNAVAILABLE, JSON.stringify(v));
  assert.equal((await read(doc({ updatedAt: 1 }))).available, true);
});

test('size: exactly 16384 bytes is read, 16385 is unavailable', async () => {
  const sized = (bytes) => { const base = JSON.stringify(doc()); return base + ' '.repeat(bytes - Buffer.byteLength(base)); };
  assert.equal(Buffer.byteLength(sized(16384)), 16384);
  assert.equal((await read(sized(16384))).available, true);
  assert.equal(Buffer.byteLength(sized(16385)), 16385);
  assert.deepEqual(await read(sized(16385)), UNAVAILABLE);
  assert.deepEqual(await read(sized(1_000_000)), UNAVAILABLE);
});

test('a window needs a percent in 0..100: 0 and 100 are valid; -1, 100.5, NaN, Infinity, a string, null and a missing percent are not', async () => {
  for (const p of [0, 100]) {
    const r = await readWith({ '5h': { percent: p, resetAt: NOW + 1000 } });
    assert.deepEqual(r.five, { percent: p, resetAt: NOW + 1000, expired: false }, String(p));
  }
  for (const [name, raw] of [['-1', -1], ['100.5', 100.5], ['NaN', NaN], ['string', '50'], ['null', null], ['array', [5]], ['true', true]]) {
    const r = await readWith({ '5h': { percent: raw, resetAt: NOW + 1000 } });
    assert.equal(r.five, null, name);
    assert.deepEqual(r.seven, { percent: 40, resetAt: NOW + 86400000, expired: false }, `${name}: the other window is untouched`);
    assert.equal(r.available, true, `${name}: the file is still valid`);
  }
  assert.equal((await read(`{"version":1,"updatedAt":${NOW},"windows":{"5h":{"percent":1e999,"resetAt":${NOW + 1000}}}}`)).five, null);
  assert.equal((await readWith({ '5h': { resetAt: NOW + 1000 } })).five, null);
});

test('percent is rounded with Math.round', async () => {
  for (const [raw, want] of [[0.4, 0], [0.5, 1], [4.49, 4], [4.5, 5], [99.5, 100], [100, 100]]) {
    assert.equal((await readWith({ '5h': { percent: raw, resetAt: NOW + 1000 } })).five.percent, want, String(raw));
  }
});

test('resetAt must be a finite number greater than 0', async () => {
  for (const [name, v] of [['0', 0], ['-5', -5], ['string', String(NOW + 1000)], ['null', null], ['object', {}]]) {
    assert.equal((await readWith({ '5h': { percent: 10, resetAt: v } })).five, null, name);
  }
  assert.equal((await read(`{"version":1,"updatedAt":${NOW},"windows":{"5h":{"percent":10,"resetAt":1e999}}}`)).five, null);
  assert.equal((await readWith({ '5h': { percent: 10 } })).five, null);
});

test('resetAt below 1e12 is epoch seconds (returned in ms); from 1e12 on it is ms and returned as is', async () => {
  const at = async (v) => (await readWith({ '5h': { percent: 10, resetAt: v } }, 1)).five.resetAt;
  assert.equal(await at(1_800_003_600), 1_800_003_600_000);
  assert.equal(await at(1), 1000);
  assert.equal(await at(999_999_999_999), 999_999_999_999_000);
  assert.equal(await at(1e12), 1e12);
  assert.equal(await at(1_800_003_600_123), 1_800_003_600_123);
});

test('expired: resetAt <= now means the window already reset; percent is null, the old number is never kept', async () => {
  const at = async (v) => (await readWith({ '5h': { percent: 87, resetAt: v } })).five;
  assert.deepEqual(await at(NOW), { percent: null, resetAt: NOW, expired: true }, 'exactly now (ms)');
  assert.deepEqual(await at(NOW + 1), { percent: 87, resetAt: NOW + 1, expired: false }, 'now plus 1 ms');
  assert.deepEqual(await at(NOW - 1), { percent: null, resetAt: NOW - 1, expired: true }, 'now minus 1 ms');
  assert.deepEqual(await at(NOW / 1000), { percent: null, resetAt: NOW, expired: true }, 'exactly now (seconds)');
  assert.deepEqual(await at(NOW / 1000 + 1), { percent: 87, resetAt: NOW + 1000, expired: false }, 'now plus 1 s (seconds)');
  assert.deepEqual(await at(NOW / 1000 - 1), { percent: null, resetAt: NOW - 1000, expired: true }, 'now minus 1 s (seconds)');
  assert.ok(!JSON.stringify(await readWith({ '7d': { percent: 87, resetAt: NOW - 5 } })).includes('87'));
});

test('stale: 899999 ms old is fresh, exactly 900000 ms is stale; a date in the future is not stale', async () => {
  const stale = async (age) => (await read(doc({ updatedAt: NOW - age }))).stale;
  assert.equal(await stale(899999), false);
  assert.equal(await stale(900000), true);
  assert.equal(await stale(900001), true);
  assert.equal(await stale(0), false);
  assert.equal(await stale(-5000), false);
  const r = await read(doc({ updatedAt: NOW - 900000 }));
  assert.equal(r.updatedAt, NOW - 900000);
  assert.equal(r.available, true);
  assert.equal(r.five.expired, false);
});

test('available stays true when one or both windows are missing or invalid', async () => {
  const one = await readWith({ '5h': null });
  assert.deepEqual([one.available, one.five, one.seven.percent], [true, null, 40]);
  const both = await read(doc({ windows: {} }));
  assert.deepEqual(both, { available: true, five: null, seven: null, updatedAt: NOW - MIN, stale: false });
  const none = await read({ version: 1, updatedAt: NOW - MIN });
  assert.deepEqual(none, { available: true, five: null, seven: null, updatedAt: NOW - MIN, stale: false });
});

// ---------- point 2: usageFile ----------
test('usageFile: the default is ~/.gentle-shell/agent/claude-usage.json; REPO_PANEL_USAGE_FILE overrides it only when it is a non-empty string', () => {
  const home = path.join(os.homedir(), '.gentle-shell', 'agent', 'claude-usage.json');
  assert.equal(usageFile({}), home);
  assert.equal(usageFile({ REPO_PANEL_USAGE_FILE: '' }), home);
  assert.equal(usageFile({ REPO_PANEL_USAGE_FILE: undefined }), home);
  const custom = path.join(scratch, 'custom-usage.json');
  assert.equal(usageFile({ REPO_PANEL_USAGE_FILE: custom }), custom);
});

test('usageFile() reads process.env by default', () => {
  assert.equal(usageFile(), ENV_FILE);
  const saved = process.env.REPO_PANEL_USAGE_FILE;
  try {
    delete process.env.REPO_PANEL_USAGE_FILE;
    assert.equal(usageFile(), path.join(os.homedir(), '.gentle-shell', 'agent', 'claude-usage.json'));
  } finally { process.env.REPO_PANEL_USAGE_FILE = saved; }
});

// ---------- point 3: GET /api/usage ----------
const freePort = () => new Promise((resolve) => {
  const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
});
const call = (port, method, p, { headers = {} } = {}) => new Promise((resolve, reject) => {
  const req = http.request({ host: '127.0.0.1', port, path: p, method, agent: false, headers: { host: `127.0.0.1:${port}`, ...headers } }, (res) => {
    let text = '';
    res.setEncoding('utf8');
    res.on('data', (c) => { text += c; });
    res.on('end', () => resolve({ status: res.statusCode, body: text, json: () => JSON.parse(text) }));
  });
  req.on('error', reject);
  req.end();
});
// Fakes that record every call: this route must make none.
function fakeDeps(extra = {}) {
  const calls = [];
  const fail = (name) => async () => { calls.push(name); throw new Error(`${name} must not be called`); };
  return { calls, noSummaryStore: true, orca: async (args) => { calls.push(`orca ${args[0]}`); throw new Error('orca must not be called'); }, local: fail('local'), prs: fail('prs'), roadmap: fail('roadmap'), state: fail('state'), requirements: fail('requirements'), git: fail('git'), ...extra };
}
async function withServer(deps, fn) {
  const port = await freePort();
  const server = createServer(port, deps);
  await new Promise((r) => server.listen(port, '127.0.0.1', r));
  try {
    const token = /name="?token"? content="([0-9a-f]+)"/.exec((await call(port, 'GET', '/')).body)[1];
    await fn({ port, get: (p, headers = {}) => call(port, 'GET', p, { headers: { 'x-token': token, ...headers } }), post: (p) => call(port, 'POST', p, { headers: { 'x-token': token } }) });
  } finally { server.close(); server.closeAllConnections(); }
}
// Far future and very old values keep these cases independent of the real clock.
const FUTURE = 4_102_444_800_000; // 2100-01-01
const FRESH_DOC = { version: 1, updatedAt: FUTURE, windows: { '5h': { percent: 5, resetAt: FUTURE }, '7d': { percent: 71.6, resetAt: FUTURE / 1000 } } };
const FRESH_ANSWER = { available: true, five: { percent: 5, resetAt: FUTURE, expired: false }, seven: { percent: 72, resetAt: FUTURE, expired: false }, updatedAt: FUTURE, stale: false };

test('GET /api/usage needs the token and our own host, and reads nothing before both', async () => {
  const deps = fakeDeps({ usageFile: put(FRESH_DOC) });
  await withServer(deps, async ({ port, get }) => {
    const noToken = await call(port, 'GET', '/api/usage');
    assert.equal(noToken.status, 401);
    assert.deepEqual(noToken.json(), { error: 'Invalid token' });
    const badToken = await call(port, 'GET', '/api/usage', { headers: { 'x-token': 'nope' } });
    assert.equal(badToken.status, 401);
    const badHost = await get('/api/usage', { host: 'evil.example:80' });
    assert.equal(badHost.status, 403);
    assert.deepEqual(badHost.json(), { error: 'Forbidden host' });
    for (const r of [noToken, badToken, badHost]) assert.ok(!r.body.includes('percent') && !r.body.includes('available'));
    assert.deepEqual(deps.calls, []);
  });
});

test('GET /api/usage answers exactly what readUsage reads from deps.usageFile: 200, same keys in the same order', async () => {
  const deps = fakeDeps({ usageFile: put({ ...FRESH_DOC, secret: 'top-secret-value' }) });
  await withServer(deps, async ({ get }) => {
    const r = await get('/api/usage');
    assert.equal(r.status, 200);
    assert.deepEqual(r.json(), FRESH_ANSWER);
    assert.equal(r.body, JSON.stringify(FRESH_ANSWER), 'exactly those keys, in order');
    assert.deepEqual(Object.keys(r.json()), KEYS);
  });
});

test('GET /api/usage: an old file is stale and its reset windows are expired with percent null (still 200)', async () => {
  const old = { version: 1, updatedAt: 1000, windows: { '5h': { percent: 90, resetAt: 2000 }, '7d': { percent: 10, resetAt: 3000 } } };
  await withServer(fakeDeps({ usageFile: put(old) }), async ({ get }) => {
    const r = await get('/api/usage');
    assert.equal(r.status, 200);
    assert.deepEqual(r.json(), { available: true, five: { percent: null, resetAt: 2_000_000, expired: true }, seven: { percent: null, resetAt: 3_000_000, expired: true }, updatedAt: 1000, stale: true });
  });
});

test('GET /api/usage with a missing, broken or oversized file is 200 with available false and no other content', async () => {
  const missing = path.join(scratch, 'route-missing.json');
  for (const file of [missing, put('not json at all'), put(`{"version":1,"updatedAt":${FUTURE},"pad":"${'x'.repeat(20000)}"}`), put(doc({ version: 7 }))]) {
    await withServer(fakeDeps({ usageFile: file }), async ({ get }) => {
      const r = await get('/api/usage');
      assert.equal(r.status, 200, file);
      assert.equal(r.body, JSON.stringify(UNAVAILABLE), file);
    });
  }
});

test('GET /api/usage without deps.usageFile uses usageFile() (REPO_PANEL_USAGE_FILE); an injected file wins over it', async () => {
  fs.writeFileSync(ENV_FILE, JSON.stringify({ ...FRESH_DOC, windows: { '5h': { percent: 33, resetAt: FUTURE }, '7d': { percent: 44, resetAt: FUTURE } } }));
  try {
    await withServer(fakeDeps(), async ({ get }) => {
      const r = (await get('/api/usage')).json();
      assert.deepEqual([r.available, r.five.percent, r.seven.percent], [true, 33, 44]);
    });
    await withServer(fakeDeps({ usageFile: put(FRESH_DOC) }), async ({ get }) => {
      assert.deepEqual((await get('/api/usage')).json(), FRESH_ANSWER);
    });
  } finally { fs.rmSync(ENV_FILE, { force: true }); }
  await withServer(fakeDeps(), async ({ get }) => {
    assert.equal((await get('/api/usage')).body, JSON.stringify(UNAVAILABLE), 'the env file is gone: no data');
  });
});

test('GET /api/usage makes no Orca, git or gh call, and never returns the path or content outside its keys', async () => {
  const file = put({ ...FRESH_DOC, note: 'top-secret-note', windows: { ...FRESH_DOC.windows, '5h': { ...FRESH_DOC.windows['5h'], token: 'top-secret-token' } } });
  const deps = fakeDeps({ usageFile: file });
  await withServer(deps, async ({ get }) => {
    for (const b of [(await get('/api/usage')).body, (await get('/api/usage?x=1')).body]) {
      assert.ok(!b.includes('top-secret'), b);
      assert.ok(!b.includes(scratch), 'no file path');
      assert.ok(!/claude-usage|\.json|version/.test(b), b);
    }
    assert.deepEqual(deps.calls, []);
  });
});

test('GET /api/usage reads the file on every request (no cache): a change is seen by the next call', async () => {
  const file = put(FRESH_DOC);
  await withServer(fakeDeps({ usageFile: file }), async ({ get }) => {
    assert.equal((await get('/api/usage')).json().five.percent, 5);
    fs.writeFileSync(file, JSON.stringify({ ...FRESH_DOC, windows: { '5h': { percent: 61, resetAt: FUTURE }, '7d': { percent: 2, resetAt: FUTURE } } }));
    const r = (await get('/api/usage')).json();
    assert.deepEqual([r.five.percent, r.seven.percent], [61, 2]);
    fs.rmSync(file);
    assert.equal((await get('/api/usage')).body, JSON.stringify(UNAVAILABLE));
  });
});

test('POST /api/usage is 404 like any unknown route, with or without the token', async () => {
  await withServer(fakeDeps({ usageFile: put(FRESH_DOC) }), async ({ port, post }) => {
    const withToken = await post('/api/usage');
    assert.equal(withToken.status, 404);
    assert.deepEqual(withToken.json(), { error: 'Not found' });
    const without = await call(port, 'POST', '/api/usage');
    assert.equal(without.status, 404);
    assert.deepEqual(without.json(), { error: 'Not found' });
    assert.equal((await post('/api/no-such-route')).body, withToken.body, 'the same answer as an unknown route');
  });
});
