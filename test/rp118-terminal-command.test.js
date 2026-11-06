'use strict';
// RP118 (S1, S2), the server: the line the person pastes into a normal terminal to open the panel's session with the whole interface of pi. The SERVER writes it (never the page), because it carries a
// folder path and a session id into a shell: a path like `a$(calc)` or a name with a quote must never turn into a command that runs something else. PowerShell: the folder and the launcher go in single
// quotes with the single quote doubled (inside single quotes nothing is expanded), the session id is only letters, digits, dot, dash and underscore and never starts with a dash, and anything that cannot
// be carried safely (a control character, one of the typographic quotes PowerShell reads as a quote) is refused, never "cleaned". The route is GET /api/terminal?id=<repo id>.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'rp112-'));
const REPO = path.join(scratch, 'My Repo');
const REPO_Q = path.join(scratch, 'Maria\u2019s repo'); // a typographic apostrophe: PowerShell reads it as a quote
fs.mkdirSync(REPO);
fs.mkdirSync(REPO_Q);
process.env.REPO_PANEL_CONFIG = path.join(scratch, 'config.json');
test.after(() => fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 5 }));

const lib = require('../lib.js');
const { terminalCommand, UNSAFE } = require('../server/terminal.js');
const { createServer } = require('../server/http.js');
const { createRpcHost } = require('../server/rpchost.js');
const { adoptIfNone } = require('../server/sessions.js');
const { findRepo } = require('../server/config.js');

const WIN = 'C:\\Users\\victor\\Developer\\Tools\\repo-panel';
const LAUNCHER = 'C:\\Users\\victor\\AppData\\Local\\gentle-shell\\bin\\gentle-shell.cmd';
const SID = 'panel-repo-panel-7fd427a6';
const ps = (over = {}) => terminalCommand({ cwd: WIN, launcher: LAUNCHER, sessionId: SID, platform: 'win32', ...over });

test('t1: PowerShell: the folder, then the launcher of the active runtime with --session-id and the real id, on ONE line', () => {
  assert.deepEqual(ps(), {
    ok: true,
    command: `Set-Location -LiteralPath '${WIN}'; & '${LAUNCHER}' --session-id ${SID}`,
  });
});

test('t2: on another platform it is a POSIX line with the same pieces', () => {
  const r = terminalCommand({ cwd: '/home/u/my repo', launcher: '/usr/local/bin/gentle-shell', sessionId: SID, platform: 'linux' });
  assert.deepEqual(r, { ok: true, command: `cd '/home/u/my repo' && '/usr/local/bin/gentle-shell' --session-id ${SID}` });
});

test('t3: a single quote in the folder or the launcher is doubled in PowerShell and closed-and-escaped in POSIX', () => {
  assert.equal(ps({ cwd: "C:\\Users\\O'Brien\\app" }).command.split('; ')[0], "Set-Location -LiteralPath 'C:\\Users\\O''Brien\\app'");
  assert.equal(ps({ launcher: "C:\\L'x\\gs.cmd" }).command.split('; ')[1].split(' --session-id')[0], "& 'C:\\L''x\\gs.cmd'");
  assert.equal(terminalCommand({ cwd: "/home/o'b/app", launcher: '/bin/gs', sessionId: SID, platform: 'linux' }).command.split(' && ')[0], "cd '/home/o'\\''b/app'");
});

test('t4: the characters a shell would run (a dollar with parentheses, a semicolon, a backtick, an ampersand, a double quote, a pipe) stay inside the quotes, as plain text', () => {
  for (const evil of ['a$(calc)b', 'a;b', 'a`b', 'a"b', 'a$env:USERPROFILE', 'a#b', 'a{b}c', 'a@b', 'a b']) {
    const cwd = `C:\\x\\${evil}`;
    const r = ps({ cwd });
    assert.equal(r.ok, true, evil);
    assert.equal(r.command, `Set-Location -LiteralPath '${cwd}'; & '${LAUNCHER}' --session-id ${SID}`, evil);
    assert.equal(r.command.includes('\n'), false, evil);
  }
});

test('t5: a control character in the folder or the launcher is refused: it is not cleaned and nothing is written', () => {
  for (const c of ['\n', '\r', '\t', '\0', '\x1b', '\x7f', '\x85', '\u2028', '\u2029']) {
    for (const over of [{ cwd: `C:\\x\\a${c}b` }, { launcher: `C:\\L${c}x\\gs.cmd` }]) {
      assert.deepEqual(ps(over), { ok: false, reason: UNSAFE }, JSON.stringify(c));
      assert.deepEqual(terminalCommand({ cwd: '/h/a' + c, launcher: '/bin/gs', sessionId: SID, platform: 'linux' }), { ok: false, reason: UNSAFE });
    }
  }
});

test('t6: the typographic quotes PowerShell reads as quotes are refused in PowerShell (a doubled one is not safe to count on), and are plain text elsewhere', () => {
  for (const q of ['\u2018', '\u2019', '\u201a', '\u201b']) {
    assert.deepEqual(ps({ cwd: `C:\\Users\\Maria${q}s\\app` }), { ok: false, reason: UNSAFE }, 'cwd ' + q.codePointAt(0).toString(16));
    assert.deepEqual(ps({ launcher: `C:\\L${q}\\gs.cmd` }), { ok: false, reason: UNSAFE }, 'launcher ' + q.codePointAt(0).toString(16));
  }
  assert.equal(terminalCommand({ cwd: '/h/Maria\u2019s', launcher: '/bin/gs', sessionId: SID, platform: 'linux' }).ok, true);
});

test('t7: the folder must be an absolute path: a relative one, an empty one or anything that is not text is refused', () => {
  for (const cwd of ['app', '.\\app', '..\\app', 'C:app', '', '   ', null, undefined, 7, {}, ['C:\\x']]) {
    assert.deepEqual(ps({ cwd }), { ok: false, reason: UNSAFE }, JSON.stringify(cwd));
  }
  for (const cwd of ['C:\\a', 'C:/a', '\\\\server\\share\\a', 'D:\\Dev\\x y']) assert.equal(ps({ cwd }).ok, true, cwd);
  assert.equal(terminalCommand({ cwd: '/a/b', launcher: '/bin/gs', sessionId: SID, platform: 'linux' }).ok, true);
  assert.equal(terminalCommand({ cwd: 'a/b', launcher: '/bin/gs', sessionId: SID, platform: 'linux' }).ok, false);
});

test('t8: the session id is only letters, digits, dot, dash and underscore, 1 to 80 characters, and never starts with a dash', () => {
  for (const sessionId of ['', ' ', 'a b', 'a;b', 'a$(x)', '../x', 'a/b', 'a\\b', "a'b", 'a"b', 'a`b', 'a\nb', '--help', '-x', '.', '..', '...', 'a'.repeat(81), null, undefined, 7, {}, ['a']]) {
    assert.deepEqual(ps({ sessionId }), { ok: false, reason: UNSAFE }, JSON.stringify(sessionId));
  }
  for (const sessionId of ['a', 'panel-x-1', 'adopted-1.x', 'A_b.c-d', 'a'.repeat(80), '.hidden', 'a.b']) assert.equal(ps({ sessionId }).ok, true, sessionId);
});

test('t9: the launcher must be text and not empty; a bare name (the runtime was not found on disk) is carried as it is', () => {
  for (const launcher of ['', '  ', null, undefined, 7, {}]) assert.deepEqual(ps({ launcher }), { ok: false, reason: UNSAFE }, JSON.stringify(launcher));
  assert.equal(ps({ launcher: 'gentle-shell' }).command, `Set-Location -LiteralPath '${WIN}'; & 'gentle-shell' --session-id ${SID}`);
});

test('t10: whatever comes in, an ok answer never has a line break and never an unquoted piece of the folder or the launcher', () => {
  const pieces = ['a', 'a b', "a'b", 'a$(x)', 'a;b', 'a`b', 'a"b', 'a&b', 'a|b', 'a<b', 'a>b', 'a\u00e9b', 'a\u4e2db'];
  for (const p of pieces) for (const platform of ['win32', 'linux']) {
    const r = terminalCommand({ cwd: platform === 'win32' ? `C:\\x\\${p}` : `/x/${p}`, launcher: platform === 'win32' ? `C:\\L\\${p}.cmd` : `/L/${p}`, sessionId: SID, platform });
    if (!r.ok) continue;
    assert.equal(/[\r\n\u2028\u2029]/.test(r.command), false, p);
    // Strip every quoted piece: what is left is only our own words.
    const rest = platform === 'win32' ? r.command.replace(/'(?:[^']|'')*'/g, "''") : r.command.replace(/'(?:[^']|'\\'')*'/g, "''");
    assert.equal(rest, platform === 'win32' ? `Set-Location -LiteralPath ''; & '' --session-id ${SID}` : `cd '' && '' --session-id ${SID}`, p);
  }
});

// ---------- the host and the route ----------
const ACTIVE = { id: 'gentle-shell', command: LAUNCHER, agentDir: 'C:\\a' };
const writeConfig = (repos, sessions = {}) => fs.writeFileSync(process.env.REPO_PANEL_CONFIG, JSON.stringify({ groups: [{ name: 'g', repos: repos.map((p) => ({ path: p })) }], sessions }));
const fakeClient = () => ({ start: async () => {}, state: () => 'idle', pendingDialogs: () => [], close() {}, prompt: async () => {} });
const makeHost = (over = {}) => createRpcHost({ resolve: async () => ({ active: ACTIVE }), repoOf: findRepo, publish() {}, createClient: fakeClient, adopt: adoptIfNone, suffix: () => 'abc123', ...over });

test('t11: the host gives the folder, the launcher and the id of the session the panel would use: the default id, an adopted one, and the id of a live NEW session', async () => {
  writeConfig([REPO]);
  const id = lib.repoId(REPO);
  const host = makeHost();
  const first = await host.terminalInfo(id);
  assert.equal(first.cwd, REPO);
  assert.equal(first.launcher, LAUNCHER);
  assert.match(first.sessionId, /^panel-my-repo-[a-z0-9]{8}$/);
  writeConfig([REPO], { [id]: { id: 'adopted-1', name: 'adopted-1', adoptedAt: '2026-01-01T00:00:00.000Z' } });
  assert.equal((await host.terminalInfo(id)).sessionId, 'adopted-1', 'an adopted id wins');
  writeConfig([REPO]);
  // The live session's own id is reported even while it is NOT adopted (a start still going, or an adoption that did not happen): with the default adopt the two ids coincide and hide the difference.
  const noAdopt = makeHost({ adopt() {} });
  await noAdopt.start(id, { fresh: true });
  const fresh = await noAdopt.terminalInfo(id);
  assert.match(fresh.sessionId, /^panel-my-repo-[a-z0-9]{8}-abc123$/, 'the live new session has its own id');
  assert.notEqual(fresh.sessionId, first.sessionId, 'and it is not the default id');
  noAdopt.closeAll();
  host.closeAll();
});

test('t12: no runtime means a 409 with a fixed message; an unknown repo means a 404', async () => {
  writeConfig([REPO]);
  const host = makeHost({ resolve: async () => ({ active: null }) });
  await assert.rejects(host.terminalInfo(lib.repoId(REPO)), (e) => e.status === 409 && e.message === 'No pi runtime is available');
  await assert.rejects(makeHost().terminalInfo('nope'), (e) => e.status === 404);
});

const freePort = () => new Promise((resolve) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });
const call = (port, p, headers = {}) => new Promise((resolve, reject) => {
  http.get({ host: '127.0.0.1', port, path: p, headers }, (res) => { let d = ''; res.on('data', (c) => { d += c; }); res.on('end', () => { let json = null; try { json = JSON.parse(d); } catch { /* html */ } resolve({ status: res.statusCode, body: d, json }); }); }).on('error', reject);
});
async function withServer(host, fn) {
  const port = await freePort();
  const server = createServer(port, { noSummaryStore: true, rpcHost: host });
  await new Promise((r) => server.listen(port, '127.0.0.1', r));
  try {
    const token = /name="?token"? content="([0-9a-f]+)"/.exec((await call(port, '/')).body)[1];
    await fn({ port, get: (p) => call(port, p, { 'x-token': token }) });
  } finally { await new Promise((r) => server.close(r)); host.closeAll(); }
}

test('t13: GET /api/terminal needs the token and answers the line for the session of the repo, built from the host data', async () => {
  writeConfig([REPO]);
  const id = lib.repoId(REPO);
  await withServer(makeHost(), async ({ port, get }) => {
    assert.equal((await call(port, `/api/terminal?id=${id}`)).status, 401);
    const r = await get(`/api/terminal?id=${id}`);
    assert.equal(r.status, 200);
    assert.equal(r.json.available, true);
    assert.equal(r.json.cwd, REPO);
    assert.match(r.json.sessionId, /^panel-my-repo-[a-z0-9]{8}$/);
    assert.deepEqual(Object.keys(r.json).sort(), ['available', 'command', 'cwd', 'sessionId', 'shell']);
    assert.equal(r.json.shell, process.platform === 'win32' ? 'powershell' : 'posix');
    assert.equal(r.json.command, terminalCommand({ cwd: REPO, launcher: LAUNCHER, sessionId: r.json.sessionId, platform: process.platform }).command);
    assert.ok(r.json.command.includes(LAUNCHER) && r.json.command.includes(r.json.sessionId));
  });
});

test('t14: the route never starts or changes anything: a session that is not started is still not started, and the config file is the same after', async () => {
  writeConfig([REPO]);
  const id = lib.repoId(REPO);
  const before = fs.readFileSync(process.env.REPO_PANEL_CONFIG, 'utf8');
  const host = makeHost();
  await withServer(host, async ({ get }) => {
    await get(`/api/terminal?id=${id}`);
    assert.equal(host.stateOf(id), 'closed');
  });
  assert.equal(fs.readFileSync(process.env.REPO_PANEL_CONFIG, 'utf8'), before);
});

test('t15: a folder the line cannot carry safely answers available:false with a fixed reason that does not echo the folder; no runtime answers the same way; an unknown repo is a 404', async () => {
  writeConfig([REPO_Q, REPO]);
  await withServer(makeHost(), async ({ get }) => {
    if (process.platform === 'win32') {
      const r = await get(`/api/terminal?id=${lib.repoId(REPO_Q)}`);
      assert.equal(r.status, 200);
      assert.deepEqual(r.json, { available: false, reason: UNSAFE });
      assert.equal(r.body.includes('Maria'), false, 'the folder is not echoed');
    }
    assert.equal((await get('/api/terminal?id=nope')).status, 404);
    assert.equal((await get('/api/terminal')).status, 404);
  });
  writeConfig([REPO]);
  await withServer(makeHost({ resolve: async () => ({ active: null }) }), async ({ get }) => {
    const r = await get(`/api/terminal?id=${lib.repoId(REPO)}`);
    assert.equal(r.status, 200);
    assert.deepEqual(r.json, { available: false, reason: 'No pi runtime is available' });
  });
});

// ---------- found by the independent verification ----------
test('t16: the line is for PowerShell, and cmd.exe reads & | < > ^ % as operators: on Windows a folder or launcher with one is refused (pasted in cmd it would run something else); POSIX single quotes keep them inert', () => {
  for (const c of ['&', '|', '<', '>', '^', '%']) {
    assert.deepEqual(ps({ cwd: `C:\\x\\a${c}b` }), { ok: false, reason: UNSAFE }, 'cwd ' + c);
    assert.deepEqual(ps({ launcher: `C:\\L\\a${c}b.cmd` }), { ok: false, reason: UNSAFE }, 'launcher ' + c);
    assert.equal(terminalCommand({ cwd: `/h/a${c}b`, launcher: '/bin/gs', sessionId: SID, platform: 'linux' }).ok, true, 'posix ' + c);
  }
});

test('t17: characters that show one thing and run another (direction marks, zero-width, odd spaces) are refused in the folder and the launcher, on every platform', () => {
  const deceive = ['\u00a0', '\u061c', '\u180e', '\u2000', '\u200a', '\u200b', '\u200c', '\u200d', '\u200e', '\u200f', '\u202a', '\u202b', '\u202c', '\u202d', '\u202e', '\u202f', '\u205f', '\u2060', '\u2064', '\u2066', '\u2067', '\u2068', '\u2069', '\u3000', '\ufeff'];
  for (const c of deceive) {
    const label = 'U+' + c.codePointAt(0).toString(16);
    assert.deepEqual(ps({ cwd: `C:\\x\\a${c}b` }), { ok: false, reason: UNSAFE }, 'win cwd ' + label);
    assert.deepEqual(ps({ launcher: `C:\\L\\a${c}b.cmd` }), { ok: false, reason: UNSAFE }, 'win launcher ' + label);
    assert.deepEqual(terminalCommand({ cwd: `/h/a${c}b`, launcher: '/bin/gs', sessionId: SID, platform: 'linux' }), { ok: false, reason: UNSAFE }, 'posix cwd ' + label);
  }
  assert.equal(ps({ cwd: 'C:\\x\\Mar\u00eda \u4e2d\u6587' }).ok, true, 'ordinary accents and other scripts are fine');
});

// The line is RUN in a real PowerShell, with a stub launcher, from folders whose names would do something if any piece were expanded or split: the stub must run once, in the right folder, with the
// right arguments, and no side effect file may appear. (Windows only: PowerShell is what the line is for.)
test('t18: run in a real PowerShell, hostile folder names are just names', { skip: process.platform !== 'win32' ? 'PowerShell on Windows only' : false }, () => {
  const cp = require('node:child_process');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rp112-ps-'));
  try {
    const stub = path.join(root, 'stub.cmd');
    fs.writeFileSync(stub, '@echo off\r\necho %CD% > "%~dp0out.txt"\r\necho %* >> "%~dp0out.txt"\r\n');
    for (const name of ['a$(ni SIDE1.txt)b', 'a;ni SIDE2.txt;b', "a'ni SIDE3.txt'b", 'a b', 'a`ni SIDE4.txt`b']) {
      const dir = path.join(root, name);
      fs.mkdirSync(dir);
      fs.rmSync(path.join(root, 'out.txt'), { force: true });
      const r = terminalCommand({ cwd: dir, launcher: stub, sessionId: SID, platform: 'win32' });
      assert.equal(r.ok, true, name);
      cp.execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(r.command, 'utf16le').toString('base64')], { cwd: root, timeout: 60000, stdio: 'ignore' });
      const lines = fs.readFileSync(path.join(root, 'out.txt'), 'utf8').split(/\r?\n/).filter(Boolean);
      assert.equal(lines.length, 2, name + ': the stub ran once');
      assert.equal(fs.realpathSync.native(lines[0].trim()).toLowerCase(), fs.realpathSync.native(dir).toLowerCase(), name + ': in the intended folder');
      assert.equal(lines[1].trim(), `--session-id ${SID}`, name + ': with exactly these arguments');
      assert.deepEqual(fs.readdirSync(root).filter((n) => n.startsWith('SIDE')), [], name + ': nothing else ran');
    }
  } finally { fs.rmSync(root, { recursive: true, force: true, maxRetries: 5 }); }
});
