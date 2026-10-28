'use strict';
// RP53 (S47): the panel keeps ONE adopted pi session per repo and per room. Pure parts (folder mapping, head/tail
// reading of .jsonl, config validation), the adopt/release/start logic with a fake Orca, and the token-protected routes.
// The real Orca CLI and the real sessions folder are never touched.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const net = require('node:net');

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'rp53-'));
const sessionsBase = path.join(scratch, 'sessions');
const repoDir = path.join(scratch, 'My Repo.Api');
const roomDir = path.join(scratch, 'room-folder');
fs.mkdirSync(sessionsBase);
fs.mkdirSync(repoDir);
fs.mkdirSync(roomDir);
const configFile = path.join(scratch, 'config.json');
process.env.REPO_PANEL_CONFIG = configFile;
process.env.REPO_PANEL_SESSIONS_DIR = sessionsBase;
process.env.REPO_PANEL_CASES_FILE = 'off';
test.after(() => fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 5 }));

const lib = require('../lib.js');
const { loadConfig, saveConfig } = require('../server/config.js');
const S = require('../server/sessions.js');
const { createServer } = require('../server/http.js');

const REPO_ID = lib.repoId(repoDir);
const baseConfig = (extra = {}) => ({
  port: 4310,
  groups: [{ name: 'G', repos: [{ path: repoDir }] }],
  rooms: [{ name: 'Sala Uno', path: roomDir, repos: [] }],
  ...extra,
});
const writeConfig = (cfg) => fs.writeFileSync(configFile, JSON.stringify(cfg));
const readConfig = () => JSON.parse(fs.readFileSync(configFile, 'utf8'));

const header = (id, cwd, extra = {}) => JSON.stringify({ type: 'session', version: 3, id, timestamp: '2026-10-28T10:00:00.000Z', cwd, ...extra });
const msg = (role, text) => JSON.stringify({ type: 'message', message: { role, content: [{ type: 'text', text }] } });

// Writes one session file under the folder's directory and sets its mtime (seconds since a fixed origin).
function putSession(folder, id, lines, mtimeSec = 1000, stamp = '2026-10-28T10-00-00-000Z') {
  const dir = S.sessionsDirFor(folder, sessionsBase);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${stamp}_${id}.jsonl`);
  fs.writeFileSync(file, lines.join('\n') + '\n');
  fs.utimesSync(file, mtimeSec, mtimeSec);
  return file;
}
const resetDisk = () => { fs.rmSync(sessionsBase, { recursive: true, force: true }); fs.mkdirSync(sessionsBase); };

// A fake Orca recording every call; `terminals` is what `list` answers, `previews` the `show` previews by handle.
function fakeOrca({ terminals = [], previews = {}, failList = false, failCreate = false } = {}) {
  const calls = [];
  const orca = async (args) => {
    calls.push(args);
    if (args[0] === 'list') { if (failList) throw new Error('down'); return { terminals }; }
    if (args[0] === 'show') return { terminal: { preview: previews[args[2]] || '' } };
    if (args[0] === 'create') { if (failCreate) throw new Error('nope'); return { terminal: { handle: 'term_new' } }; }
    throw new Error(`unexpected ${args[0]}`);
  };
  return { orca, calls };
}

test('sessionsDirFor maps the folder with : \\ and / each turned into a dash; dots and spaces are kept', () => {
  const base = path.join('B', 'sessions');
  assert.equal(S.sessionsDirFor('C:\\Users\\victor\\Developer\\Tools\\repo-panel', base), path.join(base, '--C--Users-victor-Developer-Tools-repo-panel--'));
  assert.equal(S.sessionsDirFor('C:\\Users\\victor\\Developer\\h2o\\CROSS.BackofficeApi', base), path.join(base, '--C--Users-victor-Developer-h2o-CROSS.BackofficeApi--'));
  assert.equal(S.sessionsDirFor('C:\\Users\\victor', base), path.join(base, '--C--Users-victor--'));
  assert.equal(S.sessionsDirFor('C:\\Users\\victor\\My Repo', base), path.join(base, '--C--Users-victor-My Repo--'));
  assert.equal(S.sessionsDirFor('/home/me/x', base), path.join(base, '---home-me-x--'));
});

test('listSessions reads the header, the name, the last message and the mtime of a session', () => {
  resetDisk();
  putSession(repoDir, 'abc-1', [
    header('abc-1', repoDir),
    JSON.stringify({ type: 'session_info', name: 'my name' }),
    msg('user', 'hello'),
    JSON.stringify({ type: 'message', message: { role: 'assistant', content: [{ type: 'thinking' }, { type: 'text', text: 'line\u0007one\ntwo ' + 'x'.repeat(300) }, { type: 'toolCall' }] } }),
    JSON.stringify({ type: 'message', message: { role: 'toolResult', content: [{ type: 'text', text: 'ignored' }] } }),
  ], 5000);
  const [s, ...rest] = S.listSessions(repoDir, { base: sessionsBase });
  assert.equal(rest.length, 0);
  assert.equal(s.id, 'abc-1');
  assert.equal(s.name, 'my name');
  assert.match(s.file, /_abc-1\.jsonl$/);
  assert.equal(s.startedAt, '2026-10-28T10:00:00.000Z');
  assert.equal(s.updatedAt, new Date(5000 * 1000).toISOString());
  assert.equal(s.cwdMatches, true);
  assert.equal(s.lastMessage.role, 'assistant');
  assert.equal(s.lastMessage.text.length, 200);
  assert.ok(s.lastMessage.text.startsWith('line one two xxx'));
  assert.equal(/[\x00-\x1f]/.test(s.lastMessage.text), false);
});

test('listSessions: a session with no text message has lastMessage null, a different cwd does not match, a missing folder is empty', () => {
  resetDisk();
  putSession(repoDir, 'only-head', [header('only-head', path.join(scratch, 'elsewhere'))]);
  const [s] = S.listSessions(repoDir, { base: sessionsBase });
  assert.equal(s.lastMessage, null);
  assert.equal(s.name, null);
  assert.equal(s.cwdMatches, false);
  assert.deepEqual(S.listSessions(path.join(scratch, 'nothing-here'), { base: sessionsBase }), []);
});

test('listSessions never reads a whole file: a ~5 MB file with a garbage middle still gives its header and its last message', () => {
  resetDisk();
  const dir = S.sessionsDirFor(repoDir, sessionsBase);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, '2026-10-28T10-00-00-000Z_big-1.jsonl');
  const garbage = Buffer.alloc(5 * 1024 * 1024, 0x7b); // "{" everywhere: not parseable, and no newline
  fs.writeFileSync(file, Buffer.concat([
    Buffer.from(header('big-1', repoDir) + '\n'), garbage, Buffer.from('\n' + msg('user', 'the first tail line is cut') + '\n' + msg('assistant', 'last words') + '\n'),
  ]));
  const [s] = S.listSessions(repoDir, { base: sessionsBase });
  assert.equal(s.id, 'big-1');
  assert.deepEqual(s.lastMessage, { role: 'assistant', text: 'last words' });
});

test('listSessions skips a file with a corrupt first line and never throws', () => {
  resetDisk();
  putSession(repoDir, 'good-1', [header('good-1', repoDir), msg('user', 'hi')], 2000);
  putSession(repoDir, 'bad-1', ['{not json', msg('user', 'hi')], 3000);
  putSession(repoDir, 'bad-2', [JSON.stringify({ type: 'message' })], 4000);
  putSession(repoDir, 'bad-3', [], 5000);
  assert.deepEqual(S.listSessions(repoDir, { base: sessionsBase }).map((s) => s.id), ['good-1']);
});

test('listSessions is newest first by mtime and returns at most 20 by default (limit overridable)', () => {
  resetDisk();
  for (let i = 0; i < 25; i++) putSession(repoDir, `s${i}`, [header(`s${i}`, repoDir)], 1000 + i);
  const all = S.listSessions(repoDir, { base: sessionsBase });
  assert.equal(all.length, 20);
  assert.deepEqual(all.slice(0, 3).map((s) => s.id), ['s24', 's23', 's22']);
  assert.equal(all[19].id, 's5');
  assert.equal(S.listSessions(repoDir, { base: sessionsBase, limit: 2 }).length, 2);
});

test('config: the sessions key is validated on load; invalid entries are ignored and the rest survives a save', () => {
  const ok = { id: 'panel-x', name: 'panel:x', adoptedAt: '2026-10-28T10:00:00.000Z' };
  writeConfig(baseConfig({ sessions: {
    [REPO_ID]: ok,
    'room:Sala Uno': { id: 'bad id!', name: 'n', adoptedAt: ok.adoptedAt },
    other: { id: 'a'.repeat(81), name: 'n', adoptedAt: ok.adoptedAt },
    third: 'text', fourth: null, fifth: { id: 5 }, sixth: { id: 'fine', name: 'n', adoptedAt: 'not a date' },
  } }));
  const cfg = loadConfig();
  assert.deepEqual(cfg.sessions, { [REPO_ID]: ok });
  saveConfig(cfg);
  assert.deepEqual(readConfig().sessions, { [REPO_ID]: ok });
  writeConfig(baseConfig({ sessions: ['x'] }));
  assert.deepEqual(loadConfig().sessions, {});
  writeConfig(baseConfig());
  assert.equal('sessions' in loadConfig(), false);
});

test('config: the other optional keys still load as before (dismissed, rooms, priority)', () => {
  writeConfig(baseConfig({ dismissed: ['a', 'a', 5, 'b'], priority: ['x', 'X'] }));
  const cfg = loadConfig();
  assert.deepEqual(cfg.dismissed, ['a', 'b']);
  assert.deepEqual(cfg.priority, ['x']);
  assert.deepEqual(cfg.rooms, [{ name: 'Sala Uno', path: roomDir, repos: [] }]);
  assert.equal('sessions' in cfg, false);
});

test('adoptSession stores a listed session, release clears it, and an id not on disk is a 400 that stores nothing', async () => {
  resetDisk();
  writeConfig(baseConfig());
  putSession(repoDir, 'live-1', [header('live-1', repoDir), JSON.stringify({ type: 'session_info', name: 'My session' }), msg('user', 'hi')]);
  const { orca } = fakeOrca();
  await assert.rejects(() => S.adoptSession(REPO_ID, 'ghost', orca), (e) => e.status === 400);
  assert.equal(readConfig().sessions, undefined);
  const st = await S.adoptSession(REPO_ID, 'live-1', orca);
  assert.equal(st.key, REPO_ID);
  assert.equal(st.adopted.id, 'live-1');
  assert.equal(st.adopted.name, 'My session');
  assert.equal(st.adoptedFound, true);
  assert.equal(readConfig().sessions[REPO_ID].id, 'live-1');
  const gone = await S.releaseSession(REPO_ID, orca);
  assert.equal(gone.adopted, null);
  assert.equal(gone.adoptedFound, false);
  assert.deepEqual(readConfig().sessions, {});
  await assert.rejects(() => S.adoptSession('nonexistent01', 'live-1', orca), (e) => e.status === 404);
  await assert.rejects(() => S.adoptSession('room:No Such', 'live-1', orca), (e) => e.status === 404);
});

test('a room key resolves to the room folder', async () => {
  resetDisk();
  writeConfig(baseConfig());
  putSession(roomDir, 'room-1', [header('room-1', roomDir), msg('user', 'hi')]);
  putSession(repoDir, 'repo-1', [header('repo-1', repoDir), msg('user', 'hi')]);
  const { orca } = fakeOrca();
  const st = await S.adoptSession('room:Sala Uno', 'room-1', orca);
  assert.equal(st.key, 'room:Sala Uno');
  assert.deepEqual(st.sessions.map((s) => s.id), ['room-1']);
  assert.equal(readConfig().sessions['room:Sala Uno'].id, 'room-1');
  await assert.rejects(() => S.adoptSession('room:Sala Uno', 'repo-1', orca), (e) => e.status === 400);
});

test('sessionsState: live comes from ONE list; free, working, waiting, none; an Orca failure is unknown, never none', async () => {
  resetDisk();
  writeConfig(baseConfig());
  const wt = [{ handle: 't1', worktreePath: repoDir, connected: true, writable: true }];
  const idle = '▎ repo waiting for input';
  const none = fakeOrca();
  assert.deepEqual((await S.sessionsState(REPO_ID, none.orca)).live, { state: 'none', count: 0 });
  assert.equal(none.calls.filter((c) => c[0] === 'list').length, 1);
  assert.deepEqual((await S.sessionsState(REPO_ID, fakeOrca({ failList: true }).orca)).live, { state: 'unknown', count: 0 });
  const st = await S.sessionsState(REPO_ID, fakeOrca({ terminals: wt, previews: { t1: idle } }).orca);
  assert.equal(st.live.count, 1);
  assert.ok(['free', 'working', 'waiting', 'unknown'].includes(st.live.state));
  assert.equal(st.adopted, null);
  assert.equal(st.adoptedFound, false);
});

test('startSession builds the exact orca vector (list first, then create once), stores the adoption and never sends', async () => {
  resetDisk();
  writeConfig(baseConfig());
  const f = fakeOrca();
  const r = await S.startSession(REPO_ID, f.orca);
  assert.deepEqual(r, { started: true, handle: 'term_new', id: 'panel-my-repo.api', name: 'panel:My-Repo.Api', state: 'starting' });
  const creates = f.calls.filter((c) => c[0] === 'create');
  assert.equal(creates.length, 1);
  assert.deepEqual(creates[0], ['create', '--worktree', 'path:' + repoDir, '--title', 'panel:My-Repo.Api', '--command', 'gentle-shell -n panel:My-Repo.Api --session-id panel-my-repo.api']);
  assert.equal(f.calls[0][0], 'list');
  assert.ok(f.calls.indexOf(creates[0]) > f.calls.findIndex((c) => c[0] === 'list'));
  assert.equal(f.calls.some((c) => c[0] === 'send'), false);
  const a = readConfig().sessions[REPO_ID];
  assert.deepEqual([a.id, a.name], ['panel-my-repo.api', 'panel:My-Repo.Api']);
  assert.ok(!Number.isNaN(Date.parse(a.adoptedAt)));
});

test('startSession for a room uses sala-<slug> and sala:<name>, with the room folder as the only path', async () => {
  resetDisk();
  writeConfig(baseConfig({ rooms: [{ name: 'Sala $(x) Uno', path: roomDir, repos: [] }] }));
  const f = fakeOrca();
  const r = await S.startSession('room:Sala $(x) Uno', f.orca);
  assert.equal(r.id, 'sala-sala---x--uno');
  assert.equal(r.name, 'sala:Sala---x--Uno');
  const create = f.calls.find((c) => c[0] === 'create');
  assert.equal(create[2], 'path:' + roomDir);
  assert.equal(create[6], 'gentle-shell -n sala:Sala---x--Uno --session-id sala-sala---x--uno');
  assert.equal(/[$()&|;<>`"' ]/.test(create[4] + create[6].replace(/ /g, '')), false);
  assert.match(r.id, /^[A-Za-z0-9._-]{1,80}$/);
});

test('startSession refuses with 409 when a live pi session exists or Orca cannot be listed: nothing is created or stored', async () => {
  resetDisk();
  writeConfig(baseConfig());
  const live = fakeOrca({ terminals: [{ handle: 't1', worktreePath: repoDir, connected: true, writable: true }], previews: { t1: '▎ repo waiting for input' } });
  await assert.rejects(() => S.startSession(REPO_ID, live.orca), (e) => e.status === 409 && /adopt/i.test(e.message));
  assert.equal(live.calls.some((c) => c[0] === 'create'), false);
  const down = fakeOrca({ failList: true });
  await assert.rejects(() => S.startSession(REPO_ID, down.orca), (e) => e.status === 409);
  assert.equal(down.calls.some((c) => c[0] === 'create'), false);
  const failing = fakeOrca({ failCreate: true });
  await assert.rejects(() => S.startSession(REPO_ID, failing.orca));
  assert.equal(readConfig().sessions, undefined);
  await assert.rejects(() => S.startSession('nonexistent01', fakeOrca().orca), (e) => e.status === 404);
});

// ---- routes (in-process server with an injected fake Orca) ----
const freePort = () => new Promise((resolve) => {
  const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
});

async function withServer(deps, fn) {
  const port = await freePort();
  const server = createServer(port, deps);
  await new Promise((r) => server.listen(port, '127.0.0.1', r));
  const call = (method, p, token, body) => new Promise((resolve, reject) => {
    const headers = { host: `127.0.0.1:${port}`, ...(token ? { 'x-token': token, 'content-type': 'application/json' } : {}) };
    const req = http.request({ host: '127.0.0.1', port, path: p, method, headers }, (res) => {
      let d = ''; res.on('data', (c) => { d += c; }); res.on('end', () => resolve({ status: res.statusCode, text: d }));
    });
    req.on('error', reject);
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
  try {
    const token = /name="?token"? content="([0-9a-f]+)"/.exec((await call('GET', '/')).text)[1];
    await fn({ call, token });
  } finally { server.close(); server.closeAllConnections(); }
}

test('routes answer 401 without the token and work with it', async () => {
  resetDisk();
  writeConfig(baseConfig());
  putSession(repoDir, 'route-1', [header('route-1', repoDir), msg('user', 'hi')]);
  const f = fakeOrca();
  await withServer({ orca: f.orca }, async ({ call, token }) => {
    for (const [m, p] of [['GET', `/api/sessions?id=${REPO_ID}`], ['POST', '/api/sessions/adopt'], ['POST', '/api/sessions/release'], ['POST', '/api/sessions/start']]) {
      assert.equal((await call(m, p, null, m === 'POST' ? {} : undefined)).status, 401, `${m} ${p}`);
    }
    assert.equal(f.calls.length, 0);
    const got = await call('GET', `/api/sessions?id=${REPO_ID}`, token);
    assert.equal(got.status, 200);
    const j = JSON.parse(got.text);
    assert.deepEqual([j.key, j.adopted, j.adoptedFound, j.sessions.map((s) => s.id), j.live], [REPO_ID, null, false, ['route-1'], { state: 'none', count: 0 }]);
    assert.equal((await call('GET', '/api/sessions?id=nonexistent01', token)).status, 404);
    assert.equal((await call('POST', '/api/sessions/adopt', token, { id: REPO_ID, session: 'ghost' })).status, 400);
    const adopted = JSON.parse((await call('POST', '/api/sessions/adopt', token, { id: REPO_ID, session: 'route-1' })).text);
    assert.equal(adopted.adopted.id, 'route-1');
    assert.equal(adopted.adoptedFound, true);
    assert.equal(JSON.parse((await call('POST', '/api/sessions/release', token, { id: REPO_ID })).text).adopted, null);
    const started = JSON.parse((await call('POST', '/api/sessions/start', token, { id: REPO_ID })).text);
    assert.equal(started.started, true);
    assert.equal(f.calls.filter((c) => c[0] === 'create').length, 1);
  });
});

test('existing behaviour: another config write keeps the sessions key and GET /api/config is unchanged in shape', async () => {
  resetDisk();
  const entry = { id: 'keep-1', name: 'n', adoptedAt: '2026-10-28T10:00:00.000Z' };
  writeConfig(baseConfig({ sessions: { [REPO_ID]: entry } }));
  await withServer({ orca: fakeOrca().orca }, async ({ call, token }) => {
    assert.equal((await call('POST', '/api/dismiss', token, { id: REPO_ID, on: true })).status, 200);
    const cfg = JSON.parse((await call('GET', '/api/config', token)).text);
    assert.deepEqual(Object.keys(cfg).sort(), ['dismissed', 'groups', 'roomIssues', 'rooms', 'snoozed']);
  });
  assert.deepEqual(readConfig().sessions, { [REPO_ID]: entry });
});
