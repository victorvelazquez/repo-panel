'use strict';
const test = require('node:test');
const { after } = test;
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const net = require('node:net');
const { spawn, execFileSync } = require('node:child_process');
const lib = require('../lib.js');
const { nameProblem, pathProblem } = require('../server/config.js');

const SERVER = path.join(__dirname, '..', 'server.js');

const scratch = [];
after(() => { for (const d of scratch) fs.rmSync(d, { recursive: true, force: true, maxRetries: 5 }); });
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-panel-rooms-')); scratch.push(d); return d; };

const freePort = () => new Promise((resolve) => {
  const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
});

// A fake room folder: a `.git` entry is all the panel looks for. Returns its path.
function roomFolder(name, { git = true } = {}) {
  const dir = path.join(tmp(), name);
  fs.mkdirSync(dir);
  if (git) fs.mkdirSync(path.join(dir, '.git'));
  fs.writeFileSync(path.join(dir, 'AGENTS.md'), '# room\n');
  return dir;
}

// Every file and folder under `dir` with its content, to prove a call did not touch the folder.
function snapshot(dir) {
  const out = {};
  for (const e of fs.readdirSync(dir, { withFileTypes: true, recursive: true })) {
    const p = path.join(e.parentPath || e.path, e.name);
    out[path.relative(dir, p)] = e.isDirectory() ? 'dir' : fs.readFileSync(p, 'utf8');
  }
  return out;
}

async function withPanel(config, fn) {
  const port = await freePort();
  const file = path.join(tmp(), 'config.json');
  fs.writeFileSync(file, JSON.stringify({ port, ...config }, null, 2));
  const child = spawn(process.execPath, [SERVER], { env: { ...process.env, REPO_PANEL_CONFIG: file }, stdio: 'pipe' });
  const request = (method, p, body, withToken = true) => new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: p, method, headers: { ...(withToken ? { 'x-token': token } : {}), 'content-type': 'application/json' } }, (res) => {
      let d = ''; res.on('data', (c) => { d += c; }); res.on('end', () => resolve({ status: res.statusCode, json: JSON.parse(d) }));
    });
    req.on('error', reject);
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
  let token = '';
  try {
    for (let i = 0; i < 50 && !token; i++) {
      try {
        token = await new Promise((resolve, reject) => http.get({ host: '127.0.0.1', port, path: '/' }, (res) => {
          let d = ''; res.on('data', (c) => { d += c; }); res.on('end', () => resolve(/name="?token"? content="([0-9a-f]+)"/.exec(d)[1]));
        }).on('error', reject));
      } catch { await new Promise((r) => setTimeout(r, 100)); }
    }
    assert.ok(token, 'server did not start');
    await fn({ post: (p, b, t) => request('POST', p, b, t), getApi: (p, t) => request('GET', p, undefined, t), file, read: () => JSON.parse(fs.readFileSync(file, 'utf8')) });
  } finally { child.kill(); }
}

const A = '/x/a';
const B = '/x/b';
const [idA, idB] = [A, B].map(lib.repoId);
const GROUPS = [{ name: 'g', repos: [{ path: A }, { path: B }] }];
const ABS = (n) => path.join(os.tmpdir(), 'rp-manage', n);

// ---------- invalid entries are kept and reported ----------
const MIXED = [
  { name: 'Good', path: ABS('good'), repos: [idA] },
  { name: 'good', path: ABS('dupe'), repos: [] },
  { name: 'Rel', path: 'rel/dir', repos: [] },
  'junk',
  { name: 'x'.repeat(61), path: ABS('long') },
  { name: 7, path: ABS('seven') },
  { name: 'Other', path: ABS('other'), repos: [] },
];

test('config: entries the panel does not understand survive a save in place and are listed in roomIssues', async () => {
  await withPanel({ groups: GROUPS, rooms: MIXED }, async ({ post, getApi, read }) => {
    const cfg = (await getApi('/api/config')).json;
    assert.deepEqual(cfg.rooms.map((r) => r.name), ['Good', 'Other']);
    assert.deepEqual(cfg.roomIssues, [
      'rooms[1]: name is already used by another room',
      'rooms[2]: path must be absolute',
      'rooms[3]: entry is not an object',
      `rooms[4]: name is longer than 60 characters`,
      'rooms[5]: name must be text',
    ]);
    await post('/api/snooze', { id: idA, number: 3, on: true });
    assert.deepEqual(read().rooms, MIXED);
    assert.equal(JSON.stringify(read().rooms), JSON.stringify(MIXED));
  });
});

test('config: a rooms value that is not a list is reported and written back as it was', async () => {
  await withPanel({ groups: GROUPS, rooms: 'x' }, async ({ post, getApi, read }) => {
    const cfg = (await getApi('/api/config')).json;
    assert.deepEqual([cfg.rooms, cfg.roomIssues], [[], ['rooms: must be a list']]);
    await post('/api/snooze', { id: idA, number: 3, on: true });
    assert.equal(read().rooms, 'x');
    const refused = await post('/api/rooms/create', { name: 'New', path: roomFolder('new') });
    assert.equal(refused.status, 409);
    assert.equal(read().rooms, 'x');
  });
});

test('config: valid rooms give an empty roomIssues, and a config without rooms gives [] too', async () => {
  const rooms = [{ name: 'UPEN', path: ABS('ceo'), repos: [idA] }];
  await withPanel({ groups: GROUPS, rooms }, async ({ post, getApi, read }) => {
    const cfg = (await getApi('/api/config')).json;
    assert.deepEqual([cfg.rooms, cfg.roomIssues], [rooms, []]);
    await post('/api/snooze', { id: idA, number: 3, on: true });
    assert.deepEqual(read().rooms, rooms);
  });
  await withPanel({ groups: GROUPS }, async ({ getApi }) => {
    const cfg = (await getApi('/api/config')).json;
    assert.deepEqual([cfg.rooms, cfg.roomIssues], [[], []]);
    assert.deepEqual(Object.keys(cfg).sort(), ['dismissed', 'groups', 'roomIssues', 'rooms', 'snoozed']);
  });
});

// ---------- pure validation ----------
test('nameProblem: empty, too long and duplicate (case-insensitive) names are refused', () => {
  const taken = new Set(['upen']);
  assert.equal(nameProblem('', taken), 'name is empty');
  assert.equal(nameProblem('x'.repeat(61), taken), 'name is longer than 60 characters');
  assert.equal(nameProblem('UPEN', taken), 'name is already used by another room');
  assert.equal(nameProblem('x'.repeat(60), taken), null);
  assert.equal(nameProblem('TOOLS', taken), null);
});

test('pathProblem: only an absolute path passes', () => {
  assert.equal(pathProblem('rel/dir'), 'path must be absolute');
  assert.equal(pathProblem(''), 'path must be absolute');
  assert.equal(pathProblem(undefined), 'path must be absolute');
  assert.equal(pathProblem(ABS('ok')), null);
});

// ---------- the three routes ----------
test('rooms routes need the token', async () => {
  await withPanel({ groups: GROUPS }, async ({ post }) => {
    for (const p of ['create', 'remove', 'assign']) assert.equal((await post(`/api/rooms/${p}`, {}, false)).status, 401, p);
  });
});

test('POST /api/rooms/create registers the room, trims the name and never touches the folder', async () => {
  const dir = roomFolder('ceo');
  const before = snapshot(dir);
  await withPanel({ groups: GROUPS }, async ({ post, getApi, read }) => {
    const r = await post('/api/rooms/create', { name: '  UPEN  ', path: dir });
    assert.equal(r.status, 200);
    assert.deepEqual(r.json, { rooms: [{ name: 'UPEN', path: dir, repos: [] }] });
    assert.deepEqual(read().rooms, r.json.rooms);
    assert.deepEqual((await getApi('/api/config')).json.rooms, r.json.rooms);
    const second = await post('/api/rooms/create', { name: 'TOOLS', path: roomFolder('tools') });
    assert.deepEqual(second.json.rooms.map((x) => x.name), ['UPEN', 'TOOLS']);
  });
  assert.deepEqual(snapshot(dir), before);
});

test('POST /api/rooms/create refuses every invalid name and path with a clear 400 and writes nothing', async () => {
  const dir = roomFolder('ceo');
  const plain = roomFolder('plain', { git: false });
  const file = path.join(dir, 'AGENTS.md');
  const missing = path.join(tmp(), 'nope');
  await withPanel({ groups: GROUPS, rooms: [{ name: 'UPEN', path: dir, repos: [] }] }, async ({ post, read }) => {
    const cases = [
      [{ name: '', path: dir }, 'Name is empty'],
      [{ name: '   ', path: dir }, 'Name is empty'],
      [{ path: dir }, 'Name is empty'],
      [{ name: 'x'.repeat(61), path: dir }, 'Name is longer than 60 characters'],
      [{ name: 'upen', path: dir }, 'Name is already used by another room'],
      [{ name: 'New', path: 'rel/dir' }, 'Path must be absolute'],
      [{ name: 'New' }, 'Path must be absolute'],
      [{ name: 'New', path: missing }, 'Folder not found'],
      [{ name: 'New', path: file }, 'Path is not a folder'],
      [{ name: 'New', path: plain }, 'Folder is not a git repository'],
    ];
    const rooms = read().rooms;
    for (const [body, message] of cases) {
      const r = await post('/api/rooms/create', body);
      assert.deepEqual([r.status, r.json.error], [400, message], JSON.stringify(body));
    }
    assert.deepEqual(read().rooms, rooms);
  });
  assert.deepEqual(snapshot(plain), { 'AGENTS.md': '# room\n' });
});

test('POST /api/rooms/remove drops only the config entry; unknown rooms are 404; ignored entries stay', async () => {
  const dir = roomFolder('ceo');
  const before = snapshot(dir);
  const junk = { name: 'Rel', path: 'rel' };
  await withPanel({ groups: GROUPS, rooms: [{ name: 'UPEN', path: dir, repos: [idA] }, junk] }, async ({ post, read }) => {
    assert.deepEqual([(await post('/api/rooms/remove', { name: 'nope' })).status, (await post('/api/rooms/remove', {})).status], [404, 404]);
    const r = await post('/api/rooms/remove', { name: 'upen' });
    assert.deepEqual([r.status, r.json], [200, { rooms: [] }]);
    assert.deepEqual(read().rooms, [junk]);
    assert.deepEqual(read().groups, GROUPS);
  });
  assert.deepEqual(snapshot(dir), before);
});

test('POST /api/rooms/assign moves a repo between rooms (at most one), unassigns with null, and 404s unknown ids', async () => {
  const rooms = [{ name: 'UPEN', path: ABS('ceo'), repos: [idB] }, { name: 'TOOLS', path: ABS('tools'), repos: [] }];
  await withPanel({ groups: GROUPS, rooms }, async ({ post, read }) => {
    const members = (r) => r.json.rooms.map((x) => x.repos);
    assert.deepEqual(members(await post('/api/rooms/assign', { id: idA, room: 'UPEN' })), [[idB, idA], []]);
    const moved = await post('/api/rooms/assign', { id: idA, room: 'tools' });
    assert.deepEqual([moved.status, members(moved)], [200, [[idB], [idA]]]);
    assert.deepEqual(read().rooms.map((x) => x.repos), [[idB], [idA]]);
    assert.deepEqual(members(await post('/api/rooms/assign', { id: idA, room: 'TOOLS' })), [[idB], [idA]]);
    assert.deepEqual(members(await post('/api/rooms/assign', { id: idA, room: null })), [[idB], []]);
    const before = read();
    for (const body of [{ id: 'nope', room: 'UPEN' }, { id: idA, room: 'Nope' }, { id: idA, room: 7 }, { room: 'UPEN' }]) {
      assert.equal((await post('/api/rooms/assign', body)).status, 404, JSON.stringify(body));
    }
    assert.deepEqual(read(), before);
  });
});

test('removing a repo drops its id from every room; its other cleanup is unchanged', async () => {
  const rooms = [{ name: 'UPEN', path: ABS('ceo'), repos: [idA, idB] }, { name: 'TOOLS', path: ABS('tools'), repos: [] }];
  await withPanel({ groups: GROUPS, rooms, snoozed: [`${idA}:3`, `${idB}:4`], dismissed: [idA, idB] }, async ({ post, read }) => {
    assert.deepEqual((await post('/api/repos/remove', { id: idA })).json, { ok: true });
    const cfg = read();
    assert.deepEqual(cfg.rooms, [{ name: 'UPEN', path: ABS('ceo'), repos: [idB] }, { name: 'TOOLS', path: ABS('tools'), repos: [] }]);
    assert.deepEqual(cfg.groups, [{ name: 'g', repos: [{ path: B }] }]);
    assert.deepEqual([cfg.snoozed, cfg.dismissed], [[`${idB}:4`], [idB]]);
  });
});

test('adding a repo still registers it in its group and leaves the rooms alone', async () => {
  const repo = path.join(tmp(), 'member');
  fs.mkdirSync(repo);
  execFileSync('git', ['init', '-q'], { cwd: repo });
  const rooms = [{ name: 'UPEN', path: ABS('ceo'), repos: [] }];
  await withPanel({ rooms }, async ({ post, read }) => {
    const r = await post('/api/repos', { path: repo, group: 'g' });
    assert.equal(r.status, 200);
    assert.deepEqual(read().groups.map((g) => [g.name, g.repos.length]), [['g', 1]]);
    assert.deepEqual(read().rooms, rooms);
  });
});

// ---------- the example config ----------
test('config.example.json parses and its rooms pass the panel validation', () => {
  const example = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config.example.json'), 'utf8'));
  assert.ok(Array.isArray(example.rooms) && example.rooms.length > 0);
  const taken = new Set();
  for (const r of example.rooms) {
    assert.equal(nameProblem(r.name.trim(), taken), null);
    taken.add(r.name.trim().toLowerCase());
    assert.equal(typeof r.path, 'string');
    assert.ok(path.win32.isAbsolute(r.path) || path.posix.isAbsolute(r.path));
    assert.ok(Array.isArray(r.repos));
  }
});
