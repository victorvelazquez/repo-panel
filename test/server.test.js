'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const net = require('node:net');
const { spawn, spawnSync } = require('node:child_process');

const SERVER = path.join(__dirname, '..', 'server.js');

function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

function configFor(port) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-panel-'));
  const file = path.join(dir, 'config.json');
  fs.writeFileSync(file, JSON.stringify({ port }));
  return file;
}

function launch(port) {
  return spawn(process.execPath, [SERVER], { env: { ...process.env, REPO_PANEL_CONFIG: configFor(port) }, stdio: 'pipe' });
}

const get = (port, p) => new Promise((resolve, reject) => {
  http.get({ host: '127.0.0.1', port, path: p }, (res) => {
    let d = ''; res.on('data', (c) => { d += c; }); res.on('end', () => resolve({ status: res.statusCode, body: d }));
  }).on('error', reject);
});

const waitFor = async (fn) => {
  for (let i = 0; i < 50; i++) { try { return await fn(); } catch { await new Promise((r) => setTimeout(r, 100)); } }
  throw new Error('timeout');
};

test('GET /health identifies the panel without a token', async () => {
  const port = await freePort();
  const child = launch(port);
  try {
    const res = await waitFor(() => get(port, '/health'));
    assert.equal(res.status, 200);
    assert.deepEqual(JSON.parse(res.body), { app: 'repo-panel' });
    assert.equal((await get(port, '/api/config')).status, 401);
  } finally { child.kill(); }
});

test('a second launch exits 0 when the panel already owns the port', async () => {
  const port = await freePort();
  const first = launch(port);
  try {
    await waitFor(() => get(port, '/health'));
    const second = spawnSync(process.execPath, [SERVER], { env: { ...process.env, REPO_PANEL_CONFIG: configFor(port) }, encoding: 'utf8' });
    assert.equal(second.status, 0);
    assert.match(second.stdout, /already running at http:\/\/127\.0\.0\.1:\d+\//);
  } finally { first.kill(); }
});

test('a launch exits 1 and keeps the same port when another program owns it', async () => {
  const port = await freePort();
  const blocker = http.createServer((req, res) => res.end('other app')).listen(port, '127.0.0.1');
  await new Promise((r) => blocker.once('listening', r));
  try {
    const run = spawnSync(process.execPath, [SERVER], { env: { ...process.env, REPO_PANEL_CONFIG: configFor(port) }, encoding: 'utf8' });
    assert.equal(run.status, 1);
    assert.match(run.stderr, new RegExp(`Port ${port} is used by another program`));
  } finally { blocker.close(); }
});

test('per-repo settings survive a config save; plain repos stay plain', async () => {
  const [A, B] = ['/x/a', '/x/b'];
  const port = await freePort();
  const file = configFor(port);
  fs.writeFileSync(file, JSON.stringify({
    port, groups: [{ name: 'g', repos: [{ path: A, base: 'develop' }, { path: B }] }],
  }));
  const child = spawn(process.execPath, [SERVER], { env: { ...process.env, REPO_PANEL_CONFIG: file }, stdio: 'pipe' });
  try {
    const html = (await waitFor(() => get(port, '/'))).body;
    const token = /name="?token"? content="([0-9a-f]+)"/.exec(html)[1];
    const id = require('../lib.js').repoId(A);
    await new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, path: '/api/snooze', method: 'POST', headers: { 'x-token': token, 'content-type': 'application/json' } }, (res) => { res.resume(); res.on('end', resolve); });
      req.on('error', reject);
      req.end(JSON.stringify({ id, number: 3, on: true }));
    });
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.deepEqual(saved.groups[0].repos, [{ path: A, base: 'develop' }, { path: B }]);
    assert.equal(saved.snoozed.length, 1);
  } finally { child.kill(); }
});
