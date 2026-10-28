'use strict';
// RP48: the repo that is the folder of a room is judged with the room requirements and never gets the member order.
const test = require('node:test');
const { after } = test;
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const net = require('node:net');
const { spawn, spawnSync } = require('node:child_process');
const { sh } = require('./git-helper');
const lib = require('../lib.js');
const view = require('../public/view.js');
const { requirementsFor } = require('../server/requirements.js');
const { piSend } = require('../server/pi.js');

const SERVER = path.join(__dirname, '..', 'server.js');
const CONFIG_JS = path.join(__dirname, '..', 'server', 'config.js');
const ROOM_IDS = ['room-base-branch', 'room-agents-file', 'room-enlaces-file', 'room-enlaces-sections'];

const scratch = [];
after(() => { for (const d of scratch) fs.rmSync(d, { recursive: true, force: true, maxRetries: 5 }); });

const slashed = (p) => p.replace(/\\/g, '/');
const freePort = () => new Promise((resolve) => {
  const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
});

// A bare origin and a clone whose main has an AGENTS.md; returns the clone's folder.
function cloneWithAgents() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-panel-rp48-'));
  scratch.push(tmp);
  const origin = path.join(tmp, 'origin.git');
  const work = path.join(tmp, 'work');
  sh(tmp, 'init', '--bare', '-b', 'main', origin);
  sh(tmp, 'clone', '-q', origin, work);
  sh(work, 'checkout', '-q', '-B', 'main');
  fs.writeFileSync(path.join(work, 'AGENTS.md'), '# Agents\n');
  sh(work, 'add', '-A'); sh(work, 'commit', '-q', '-m', 'c'); sh(work, 'push', '-q', 'origin', 'main');
  return work;
}

function tempConfig(config) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-panel-rp48cfg-'));
  scratch.push(dir);
  const file = path.join(dir, 'config.json');
  fs.writeFileSync(file, JSON.stringify(config));
  return file;
}

// Starts the panel on a temporary config (never the real one); `fn` gets { get, post }.
async function withPanel(config, fn) {
  const port = await freePort();
  const file = tempConfig({ port, ...config });
  const child = spawn(process.execPath, [SERVER], { env: { ...process.env, REPO_PANEL_CONFIG: file, REPO_PANEL_CASES_FILE: 'off' }, stdio: 'pipe' });
  const request = (method, p, token, body) => new Promise((resolve, reject) => {
    const headers = token ? { 'x-token': token, 'content-type': 'application/json' } : {};
    const req = http.request({ host: '127.0.0.1', port, path: p, method, headers }, (res) => {
      let d = ''; res.on('data', (c) => { d += c; }); res.on('end', () => resolve({ status: res.statusCode, body: d }));
    });
    req.on('error', reject);
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
  try {
    let page = null;
    for (let i = 0; i < 100 && !page; i++) {
      page = await request('GET', '/').then((r) => (r.status === 200 ? r : null)).catch(() => null);
      if (!page) await new Promise((r) => setTimeout(r, 100));
    }
    const token = /name="?token"? content="([0-9a-f]+)"/.exec(page.body)[1];
    const json = (r) => ({ status: r.status, json: JSON.parse(r.body) });
    await fn({
      get: async (p) => json(await request('GET', p, token)),
      post: async (p, body) => json(await request('POST', p, token, body)),
    });
  } finally { child.kill(); }
}

// A room whose path differs from its group entry in case and by a trailing slash, plus a member repo of the room.
function roomConfig() {
  const roomRepo = cloneWithAgents();
  const member = cloneWithAgents();
  const config = {
    groups: [{ name: 'g', repos: [{ path: slashed(roomRepo) }, { path: slashed(member) }] }],
    rooms: [{ name: 'Casa', path: `${roomRepo.toUpperCase()}${path.sep}`, repos: [lib.repoId(slashed(member))] }],
  };
  return { config, roomId: lib.repoId(slashed(roomRepo)), memberId: lib.repoId(slashed(member)) };
}

test('roomByPath normalizes slashes, case and a trailing slash, and returns null for other paths', () => {
  const abs = path.resolve(path.parse(process.cwd()).root, 'Dev', 'Room');
  const file = tempConfig({ rooms: [{ name: 'Casa', path: abs, repos: [] }] });
  const script = `const { roomByPath } = require(${JSON.stringify(CONFIG_JS)});
    const p = ${JSON.stringify(abs)};
    console.log(JSON.stringify({ same: roomByPath(p), upper: roomByPath(p.toUpperCase() + '/'), slashes: roomByPath(p.split('\\\\').join('/') + '//'),
      other: roomByPath(p + '-x'), parent: roomByPath(require('node:path').dirname(p)), none: roomByPath(undefined) }));`;
  const run = spawnSync(process.execPath, ['-e', script], { env: { ...process.env, REPO_PANEL_CONFIG: file }, encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  const out = JSON.parse(run.stdout);
  for (const k of ['same', 'upper', 'slashes']) assert.equal(out[k] && out[k].name, 'Casa', k);
  assert.deepEqual([out.other, out.parent, out.none], [null, null, null]);
});

test('requirementsFor answers a room repo with only the room requirements', async () => {
  const work = cloneWithAgents();
  const out = await requirementsFor({ id: 'r', path: work }, null, { roomRepo: { name: 'Casa', path: work, repos: [] } });
  assert.equal(out.isRoom, true);
  assert.deepEqual(out.room, { name: 'Casa' });
  assert.deepEqual(out.results.map((r) => r.id), ROOM_IDS);
  assert.equal(out.summary.required.total, 4);
  assert.equal(out.available, true);
});

test('an explicit null room stays hermetic: a repo outside every room is answered as before', async () => {
  const work = cloneWithAgents();
  const out = await requirementsFor({ id: 'r', path: work }, null);
  assert.equal('isRoom' in out, false);
  assert.equal('room' in out, false);
  assert.ok(out.results.length > 0);
  assert.equal(out.results.some((r) => r.id.startsWith('room-')), false);
});

test('GET /api/requirements: the room repo is judged as a room; a member and an outsider keep the member ids', async () => {
  const { config, roomId, memberId } = roomConfig();
  const outsider = cloneWithAgents();
  config.groups[0].repos.push({ path: slashed(outsider) });
  await withPanel(config, async ({ get }) => {
    const room = await get(`/api/requirements?id=${roomId}`);
    assert.equal(room.status, 200);
    assert.equal(room.json.isRoom, true);
    assert.deepEqual(room.json.room, { name: 'Casa' });
    assert.deepEqual(room.json.results.map((r) => r.id), ROOM_IDS);
    assert.equal(room.json.summary.required.total, 4);
    const member = await get(`/api/requirements?id=${memberId}`);
    assert.equal('isRoom' in member.json, false);
    assert.deepEqual(member.json.room, { name: 'Casa' });
    assert.equal(member.json.results.some((r) => r.id.startsWith('room-')), false);
    const other = await get(`/api/requirements?id=${lib.repoId(slashed(outsider))}`);
    assert.equal('isRoom' in other.json, false);
    assert.equal('room' in other.json, false);
    assert.equal(other.json.results.some((r) => r.id.startsWith('room-')), false);
  });
});

test('POST /api/pi put-in-conditions for the room repo answers 409 and names the room', async () => {
  const { config, roomId } = roomConfig();
  await withPanel(config, async ({ post }) => {
    const r = await post('/api/pi', { id: roomId, command: 'put-in-conditions' });
    assert.equal(r.status, 409);
    assert.match(r.json.error, /Casa/);
    assert.match(r.json.error, /room standard/);
    assert.match(r.json.error, /not available yet/);
  });
});

test('piSend refuses the member order for a room before touching any session', async () => {
  const calls = [];
  const orca = async (args) => { calls.push(args); return { terminals: [] }; };
  const requirements = async () => ({ available: true, results: [], isRoom: true, room: { name: 'Casa' } });
  await assert.rejects(piSend({ path: 'C:\\dev\\room' }, 'put-in-conditions', orca, async () => {}, requirements),
    (e) => e.status === 409 && /Casa/.test(e.message) && /room standard/.test(e.message));
  assert.deepEqual(calls, []);
});

test('cardMenu hides put-in-conditions for a room and keeps it for a normal repo', () => {
  const results = [{ id: 'x', level: 'required', status: 'fail' }];
  const room = view.cardMenu({ state: 'loaded', data: { isRoom: true, results } }, false);
  assert.deepEqual(room.map((i) => i.act), ['toggle-warning']);
  const normal = view.cardMenu({ state: 'loaded', data: { results } }, false);
  assert.deepEqual(normal.map((i) => i.act), ['put-in-conditions', 'toggle-warning']);
  assert.deepEqual(view.cardMenu({ state: 'loaded', data: { isRoom: true, results: [] } }, false), []);
});
