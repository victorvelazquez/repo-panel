'use strict';
// RPC1a (S1, S2, S11), part b: the `pi` key of config.json, GET/POST /api/pi-runtime, the `pi` prerequisite and the sessions folder that
// follows the active runtime. The browser may only choose `auto` or the id of a DETECTED runtime: never a path, never `command` or
// `agentDir`. Nothing here spawns a real program: the routes get fake machine dependencies through `deps.piRuntime`.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'rpc1a-'));
const CONFIG = path.join(scratch, 'config.json');
process.env.REPO_PANEL_CONFIG = CONFIG;
delete process.env.REPO_PANEL_SESSIONS_DIR;
test.after(() => fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 5 }));

const { EventEmitter } = require('node:events');
const { loadConfig, saveConfig } = require('../server/config.js');
const { createServer } = require('../server/http.js');
const { prerequisites } = require('../server/requirements.js');
const { baseDir } = require('../server/sessions.js');
const { findRuntimes } = require('../server/piruntime.js');

const writeConfig = (cfg) => fs.writeFileSync(CONFIG, JSON.stringify(cfg));
const readRaw = () => fs.readFileSync(CONFIG, 'utf8');

test('k1: the config cleaner keeps a valid `pi` and drops bad values and unknown keys', () => {
  writeConfig({ pi: { runtime: 'gentle-shell', command: 'C:\\x\\pi.exe', agentDir: 'D:\\a', extra: 'x', other: { a: 1 } } });
  assert.deepEqual(loadConfig().pi, { runtime: 'gentle-shell', command: 'C:\\x\\pi.exe', agentDir: 'D:\\a' });
  writeConfig({ pi: { runtime: '/usr/bin/evil', command: 7, agentDir: ['x'] } });
  assert.deepEqual(loadConfig().pi, {});
  writeConfig({ pi: { runtime: 'pi' } });
  assert.deepEqual(loadConfig().pi, { runtime: 'pi' });
  for (const v of ['pi', 5, null, ['auto']]) { writeConfig({ pi: v }); assert.deepEqual(loadConfig().pi, {}, JSON.stringify(v)); }
});

test('k2: no `pi` in the file means no `pi` in the config, and saveConfig keeps `pi` when present', () => {
  writeConfig({ port: 4310 });
  assert.equal('pi' in loadConfig(), false);
  writeConfig({ pi: { runtime: 'auto', command: 'mypi', agentDir: 'D:\\a' } });
  saveConfig(loadConfig());
  assert.deepEqual(JSON.parse(readRaw()).pi, { runtime: 'auto', command: 'mypi', agentDir: 'D:\\a' });
});

// ---------- routes ----------
const LAUNCHER = 'C:\\L\\gentle-shell\\bin\\gentle-shell.cmd';
const PI_CMD = 'C:\\N\\npm\\pi.cmd';
function fakeMachine({ gs = true, pi = true } = {}) {
  const files = gs ? { [LAUNCHER]: '', 'C:\\L\\gentle-shell\\current': '4.5.1-1.4.0' } : {};
  const spawned = [];
  return {
    spawned,
    deps: {
      env: { LOCALAPPDATA: 'C:\\L' }, platform: 'win32', homedir: 'C:\\Users\\u',
      exists: (p) => p in files, readText: (p) => files[p],
      which: (n) => (pi && n === 'pi' ? PI_CMD : null),
      run: async () => ({ code: 0, stdout: '1.2.0\n', stderr: '' }),
      spawn: (file, args) => {
        spawned.push([file, ...args]);
        const child = new EventEmitter();
        child.pid = 7; child.stdout = new EventEmitter();
        child.stdin = { write() { setImmediate(() => child.stdout.emit('data', '{"type":"response","command":"get_state","success":true}\n')); return true; }, on() {}, end() {} };
        child.kill = () => {};
        if (file === 'taskkill') setImmediate(() => child.emit('exit', 0));
        return child;
      },
    },
  };
}
const freePort = () => new Promise((resolve) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });
const call = (port, method, p, { headers = {}, body } = {}) => new Promise((resolve, reject) => {
  const data = body === undefined ? null : JSON.stringify(body);
  const req = http.request({ host: '127.0.0.1', port, path: p, method, headers: { ...headers, ...(data ? { 'content-type': 'application/json' } : {}) } }, (res) => {
    let d = ''; res.on('data', (c) => { d += c; }); res.on('end', () => { let json = null; try { json = JSON.parse(d); } catch { /* html */ } resolve({ status: res.statusCode, body: d, json }); });
  });
  req.on('error', reject);
  req.end(data);
});
async function withServer(machine, fn) {
  const port = await freePort();
  const server = createServer(port, { noSummaryStore: true, piRuntime: machine.deps });
  await new Promise((r) => server.listen(port, '127.0.0.1', r));
  try {
    const token = /name="?token"? content="([0-9a-f]+)"/.exec((await call(port, 'GET', '/')).body)[1];
    await fn({ get: (p) => call(port, 'GET', p, { headers: { 'x-token': token } }), post: (body) => call(port, 'POST', '/api/pi-runtime', { headers: { 'x-token': token }, body }), port });
  } finally { await new Promise((r) => server.close(r)); }
}

test('p1: GET needs the token, answers the candidates and the active one, and spawns NOTHING without ?check=1', async () => {
  writeConfig({});
  const m = fakeMachine();
  await withServer(m, async ({ get, port }) => {
    assert.equal((await call(port, 'GET', '/api/pi-runtime')).status, 401);
    const r = await get('/api/pi-runtime');
    assert.equal(r.status, 200);
    assert.deepEqual(r.json, {
      mode: 'auto', active: 'gentle-shell',
      candidates: [
        { id: 'gentle-shell', label: 'Gentle Shell', version: '4.5.1-1.4.0', available: true, active: true },
        { id: 'pi', label: 'pi (original)', version: '1.2.0', available: true, active: false },
      ],
    });
    assert.equal(r.body.includes('command'), false, 'no command or folder is shown to the page');
    assert.deepEqual(m.spawned, []);
  });
});

test('p2: GET ?check=1 runs the handshake of the active runtime once and adds `check`', async () => {
  writeConfig({});
  const m = fakeMachine();
  await withServer(m, async ({ get }) => {
    const r = await get('/api/pi-runtime?check=1');
    assert.deepEqual(r.json.check, { ok: true });
    assert.deepEqual(m.spawned.filter((s) => s[0] !== 'taskkill').map((s) => s.slice(1)), [['--mode', 'rpc', '--no-session']]);
    assert.ok(m.spawned.some((s) => s[0] === 'taskkill'));
  });
  const none = fakeMachine({ gs: false, pi: false });
  await withServer(none, async ({ get }) => {
    const r = await get('/api/pi-runtime?check=1');
    assert.equal(r.json.active, null);
    assert.ok(r.json.problem);
    assert.equal(r.json.check.ok, false);
    assert.deepEqual(none.spawned, [], 'nothing to start');
  });
});

test('p3: POST needs the token; it saves only `runtime`, keeps command and agentDir, and answers like the GET', async () => {
  writeConfig({ port: 4310, pi: { runtime: 'auto', command: 'mypi', agentDir: 'D:\\a' } });
  await withServer(fakeMachine(), async ({ post, port }) => {
    assert.equal((await call(port, 'POST', '/api/pi-runtime', { body: { runtime: 'pi' } })).status, 401);
    assert.equal(JSON.parse(readRaw()).pi.runtime, 'auto');
    const r = await post({ runtime: 'pi' });
    assert.equal(r.status, 200);
    assert.deepEqual([r.json.mode, r.json.active], ['pi', 'pi']);
    assert.deepEqual(JSON.parse(readRaw()).pi, { runtime: 'pi', command: 'mypi', agentDir: 'D:\\a' });
    assert.equal((await post({ runtime: 'auto' })).json.mode, 'auto');
    assert.equal(JSON.parse(readRaw()).pi.runtime, 'auto');
  });
});

test('p4: POST rejects paths, unknown and undetected ids, non-strings, arrays, objects and extra fields with a fixed 400; config.json is untouched', async () => {
  writeConfig({ port: 4310, pi: { runtime: 'auto' } });
  const before = readRaw();
  await withServer(fakeMachine({ pi: false }), async ({ post }) => {
    const attempts = [
      { runtime: 'C:\\Windows\\System32\\cmd.exe' }, { runtime: '/usr/bin/evil' }, { runtime: '..\\x' }, { runtime: 'nope' }, { runtime: '' },
      { runtime: 'pi' }, // known id but not detected as available on this machine
      { runtime: 'AUTO' }, { runtime: 'gentle-shell ' }, { runtime: 'constructor' }, { runtime: '__proto__' },
      { runtime: 5 }, { runtime: null }, { runtime: ['auto'] }, { runtime: { id: 'auto' } }, { runtime: true }, {}, { id: 'pi' },
      { runtime: 'auto', command: 'C:\\evil.exe' }, { runtime: 'gentle-shell', agentDir: 'C:\\evil' }, { runtime: 'auto', path: 'x' },
      ['auto'], 'auto', 7, null,
    ];
    for (const body of attempts) {
      const r = await post(body);
      assert.equal(r.status, 400, JSON.stringify(body));
      assert.deepEqual(r.json, { error: 'runtime must be auto or a detected pi runtime' });
      assert.equal(readRaw(), before, `config unchanged after ${JSON.stringify(body)}`);
    }
    assert.equal((await post({ runtime: 'gentle-shell' })).status, 200, 'a detected id still works');
  });
});

test('p5: duplicate keys, __proto__, a command in the body or in the query never choose an undetected id and never touch config.json', async () => {
  writeConfig({ port: 4310, pi: { runtime: 'auto' } });
  const before = readRaw();
  await withServer(fakeMachine({ pi: false }), async ({ port, get }) => {
    const token = /name="?token"? content="([0-9a-f]+)"/.exec((await call(port, 'GET', '/')).body)[1];
    const raw = (p, text) => new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, path: p, method: 'POST', headers: { 'x-token': token, 'content-type': 'application/json' } }, (res) => { let d = ''; res.on('data', (c) => { d += c; }); res.on('end', () => resolve({ status: res.statusCode, json: JSON.parse(d) })); });
      req.on('error', reject);
      req.end(text);
    });
    const attempts = [
      ['/api/pi-runtime', '{"runtime":"auto","runtime":"pi"}'],
      ['/api/pi-runtime', '{"runtime":"pi","runtime":"pi"}'],
      ['/api/pi-runtime', '{"__proto__":{"runtime":"pi"}}'],
      ['/api/pi-runtime', '{"runtime":"auto","__proto__":{"command":"C:\\\\evil.exe"}}'],
      ['/api/pi-runtime', '{"runtime":"pi","command":"C:\\\\evil.exe"}'],
      ['/api/pi-runtime?runtime=gentle-shell&command=C%3A%5Cevil.exe', '{}'],
      ['/api/pi-runtime?runtime=pi&command=C%3A%5Cevil.exe', '{"runtime":"pi"}'],
    ];
    for (const [p, text] of attempts) {
      const r = await raw(p, text);
      assert.equal(r.status, 400, text);
      assert.deepEqual(r.json, { error: 'runtime must be auto or a detected pi runtime' });
      assert.equal(readRaw(), before, `config unchanged after ${text}`);
    }
    assert.equal((await get('/api/pi-runtime?runtime=pi&command=x')).json.mode, 'auto', 'a GET query never changes the choice');
    assert.equal(readRaw(), before);
  });
});

test('p6: ?check=1 is reused for 5 s (ok or failed) and spawns again after that', async () => {
  const started = (m) => m.spawned.filter((s) => s[0] !== 'taskkill').length;
  for (const ok of [true, false]) {
    writeConfig({});
    const m = fakeMachine();
    const inner = m.deps.spawn;
    m.deps.spawn = (file, args) => {
      const c = inner(file, args);
      if (!ok && file !== 'taskkill') c.stdin.write = () => { setImmediate(() => c.stdout.emit('data', '{"type":"response","command":"get_state","success":false,"error":"no"}\n')); return true; };
      return c;
    };
    let clock = 1000;
    const port = await freePort();
    const server = createServer(port, { noSummaryStore: true, piRuntime: m.deps, now: () => clock });
    await new Promise((r) => server.listen(port, '127.0.0.1', r));
    try {
      const token = /name="?token"? content="([0-9a-f]+)"/.exec((await call(port, 'GET', '/')).body)[1];
      const get = (n) => call(port, 'GET', `/api/pi-runtime?check=1&n=${n}`, { headers: { 'x-token': token } });
      const a = await get(1);
      assert.equal(a.json.check.ok, ok);
      clock += 4999;
      assert.deepEqual((await get(2)).json.check, a.json.check, 'reused within 5 s');
      assert.equal(started(m), 1, 'spawned once for two checks');
      clock += 2;
      await get(3);
      assert.equal(started(m), 2, 'spawned again after 5 s');
    } finally { await new Promise((r) => server.close(r)); }
  }
});

// ---------- prerequisites ----------
test('q1: prerequisites keeps git and gh as they were and adds `pi` with the runtime, its version and the mode', async () => {
  const runner = async (cmd) => (cmd === 'git' ? { code: 0, stdout: 'git version 2.50.0\n', stderr: '' } : { code: -1, stdout: '', stderr: '' });
  const rt = { active: { id: 'gentle-shell', label: 'Gentle Shell', version: '4.5.1-1.4.0' }, mode: 'auto', candidates: [] };
  const { items } = await prerequisites(runner, async () => rt);
  assert.deepEqual(items.map((i) => i.id), ['git', 'gh', 'pi']);
  assert.deepEqual(items[0], { id: 'git', ok: true, detail: 'git version 2.50.0' });
  assert.deepEqual(items[2], { id: 'pi', ok: true, detail: 'Gentle Shell 4.5.1-1.4.0 (auto)' });
  const none = await prerequisites(runner, async () => ({ active: null, mode: 'auto', problem: 'No pi found. Install one.', candidates: [] }));
  assert.deepEqual(none.items[2], { id: 'pi', ok: false, detail: 'No pi found. Install one.' });
  const broke = await prerequisites(runner, async () => { throw new Error('x'); });
  assert.equal(broke.items[2].ok, false, 'a detection failure is ok:false, never a throw');
});

// ---------- sessions folder ----------
const homedir = os.homedir();
const finder = (files, onPath = {}) => () => findRuntimes({ env: { LOCALAPPDATA: 'C:\\L' }, platform: process.platform, homedir, exists: (p) => files.includes(p), readText: () => '1', which: (n) => onPath[n] || null });
const gsLauncher = process.platform === 'win32' ? 'C:\\L\\gentle-shell\\bin\\gentle-shell.cmd' : '/bin/gentle-shell';
const gsFiles = [gsLauncher];
const gsPath = process.platform === 'win32' ? {} : { 'gentle-shell': '/bin/gentle-shell' };

test('s1: with Gentle Shell active the sessions folder is IDENTICAL to the old default', () => {
  writeConfig({});
  assert.equal(baseDir({ candidates: finder(gsFiles, gsPath) }), path.join(homedir, '.gentle-shell', 'agent', 'sessions'));
});

test('s2: with only the original pi (or a fixed `pi`) the folder follows ~/.pi/agent/sessions', () => {
  writeConfig({});
  const piOnly = finder([], { pi: 'X:\\pi.cmd' });
  assert.equal(baseDir({ candidates: piOnly }), path.join(homedir, '.pi', 'agent', 'sessions'));
  writeConfig({ pi: { runtime: 'pi' } });
  assert.equal(baseDir({ candidates: finder(gsFiles, { ...gsPath, pi: 'X:\\pi.cmd' }) }), path.join(homedir, '.pi', 'agent', 'sessions'));
});

test('s3: no active runtime or a detection that throws keeps the old default; REPO_PANEL_SESSIONS_DIR still wins', () => {
  writeConfig({});
  const old = path.join(homedir, '.gentle-shell', 'agent', 'sessions');
  assert.equal(baseDir({ candidates: finder([]) }), old);
  assert.equal(baseDir({ candidates: () => { throw new Error('boom'); } }), old);
  writeConfig({ pi: { runtime: 'gentle-shell' } });
  assert.equal(baseDir({ candidates: finder([]) }), old, 'a fixed unavailable runtime has no folder of its own: default');
  process.env.REPO_PANEL_SESSIONS_DIR = path.join(scratch, 'sess');
  try { assert.equal(baseDir({ candidates: finder([], { pi: 'X:\\pi.cmd' }) }), path.join(scratch, 'sess')); } finally { delete process.env.REPO_PANEL_SESSIONS_DIR; }
});

test('s4: baseDir reads the setting fresh: changing pi.runtime in config.json changes the folder at once', () => {
  const gs = path.join(homedir, '.gentle-shell', 'agent', 'sessions');
  const pi = path.join(homedir, '.pi', 'agent', 'sessions');
  const list = finder(gsFiles, { ...gsPath, pi: 'X:\\pi.cmd' })(); // the real platform, like the other tests: a forced win32 builds backslash paths on Linux
  const candidates = () => list; // one detection kept (like findCached); the setting is read on every call
  writeConfig({});
  assert.equal(baseDir({ candidates }), gs, 'auto -> Gentle Shell');
  writeConfig({ pi: { runtime: 'pi' } });
  assert.equal(baseDir({ candidates }), pi, 'pi -> the original pi folder, no restart');
  writeConfig({ pi: { runtime: 'auto' } });
  assert.equal(baseDir({ candidates }), gs);
});
