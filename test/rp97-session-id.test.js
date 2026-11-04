'use strict';
// RP97 (S1, S2, S3): the id the panel gives to pi (`--session-id`) is unique per repository. It used to be `panel-<last folder of the path>`, so `C:\a\app` and `C:\b\app` shared it. Now a NEW
// session is `panel-<slug>-<first 8 alphanumerics of the repo id>` (the repo id is the hash of its path); an adopted id still wins, so no repo that already runs a session changes id.
const test = require('node:test');
const assert = require('node:assert/strict');

const { createRpcHost, sessionIdFor } = require('../server/rpchost.js');
const { SESSION_ID } = require('../server/sessions.js');
const lib = require('../lib.js');

const sid = (p, id, adopted = null) => sessionIdFor({ path: p, id }, adopted);

test('two repos whose last folder has the same name get different ids, and each keeps its own on every call', () => {
  const a = sid('C:\\a\\app', lib.repoId('C:\\a\\app'));
  const b = sid('C:\\b\\app', lib.repoId('C:\\b\\app'));
  assert.notEqual(a, b);
  for (const x of [a, b]) { assert.match(x, SESSION_ID); assert.ok(x.startsWith('panel-app-'), x); }
  assert.equal(sid('C:\\a\\app', lib.repoId('C:\\a\\app')), a, 'the same repo always gets the same id');
  assert.equal(sid('/home/u/app', lib.repoId('/home/u/app')) === sid('/srv/app', lib.repoId('/srv/app')), false, 'also with the paths of another platform');
});

test('the format is panel-<slug>-<first 8 alphanumerics of the repo id>', () => {
  assert.equal(sid('C:\\repos\\My App', 'ab1'), 'panel-my-app-ab1');
  assert.equal(sid('/home/u/repos/my-app/', 'ab1'), 'panel-my-app-ab1');
  assert.equal(sid('C:/repos/my-app', '7c847e222f'), 'panel-my-app-7c847e22');
  assert.equal(sid('C:\\repos\\x', 'a-b_c!1234567890'), 'panel-x-abc12345', 'only letters and digits of the repo id, at most 8');
});

test('a very long folder name keeps its suffix and is still a valid id of at most 80 characters, and two long names with the same beginning differ', () => {
  const long = 'a'.repeat(200);
  const one = sid(`C:\\x\\${long}`, 'aaaaaaaa11');
  const two = sid(`C:\\y\\${long}`, 'bbbbbbbb22');
  for (const x of [one, two]) { assert.match(x, SESSION_ID); assert.ok(x.length <= 80, `${x.length} characters`); }
  assert.ok(one.endsWith('-aaaaaaaa') && two.endsWith('-bbbbbbbb'));
  assert.notEqual(one, two);
});

test('an adopted id wins unchanged (a repo that already runs a session never changes id); an invalid one is ignored', () => {
  assert.equal(sid('C:\\repos\\app', 'ab1', { id: 'adopted-1.x' }), 'adopted-1.x');
  assert.equal(sid('C:\\repos\\app', 'ab1', { id: 'panel-app' }), 'panel-app', 'an old-style adopted id is respected as it is');
  assert.equal(sid('C:\\repos\\app', 'ab1', { id: '../evil;x' }), 'panel-app-ab1');
  assert.equal(sid('C:\\repos\\app', 'ab1', { id: 7 }), 'panel-app-ab1');
});

test('no folder in the path: the repo id as before; no repo id: no dangling dash', () => {
  assert.equal(sid('/', 'ab1'), 'panel-ab1');
  assert.equal(sid('C:\\', 'ab1'), 'panel-ab1');
  assert.equal(sid('/', ''), 'panel-repo');
  assert.equal(sid('/home/u/my-app', ''), 'panel-my-app');
  assert.equal(sid('/home/u/my-app', undefined), 'panel-my-app');
  assert.equal(sid('/home/u/my-app', '!!!'), 'panel-my-app');
});

test('hostile folder names and repo ids never leave the id alphabet', () => {
  const names = ['My App', 'ünï cödé', '...', 'x;rm -rf', '  ', 'a b\\c', '../..', '-x-', 'CON', '%00', '"><script>'];
  const ids = ['ab1', '7c847e222f', 'ünï', '../x', '', undefined, 'a'.repeat(300)];
  for (const n of names) for (const id of ids) {
    const x = sid(`C:\\repos\\${n}`, id);
    assert.match(x, SESSION_ID, `${n} / ${String(id).slice(0, 10)}`);
    assert.ok(x.startsWith('panel-'), x);
  }
});

test('the host starts pi with the unique id: two repos with the same folder name get different --session-id, and each adopts its own', async () => {
  const pa = 'C:\\a\\app';
  const pb = 'C:\\b\\app';
  const ida = lib.repoId(pa);
  const idb = lib.repoId(pb);
  const repos = { [ida]: { id: ida, path: pa }, [idb]: { id: idb, path: pb } };
  const made = [];
  const adopted = {};
  const createClient = (opts) => { const c = { opts, start: () => Promise.resolve({}), state: () => 'idle', pendingDialogs: () => [], close() {} }; made.push(c); return c; };
  const host = createRpcHost({
    resolve: async () => ({ active: { id: 'gentle-shell', command: 'C:\\L\\gentle-shell.cmd', agentDir: 'C:\\u\\agent' } }),
    repoOf: (id) => repos[id], publish() {}, createClient, adoptedOf: (id) => adopted[id] || null, adopt: (id, s) => { adopted[id] = { id: s }; },
  });
  await host.start(ida);
  await host.start(idb);
  const [x, y] = made.map((c) => c.opts.args[3]);
  assert.notEqual(x, y);
  assert.deepEqual([adopted[ida].id, adopted[idb].id], [x, y]);
  assert.ok(x.startsWith('panel-app-') && y.startsWith('panel-app-'));
});
