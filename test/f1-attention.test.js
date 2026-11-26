'use strict';
// F1: GET /api/attention, everything a director must act on, in one call. Critical zone (the token): the abuse cases come first.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'rp-f1-'));
process.env.REPO_PANEL_CONFIG = path.join(scratch, 'config.json');

const lib = require('../lib.js');
const { createServer } = require('../server/http.js');
const { createRpcHost } = require('../server/rpchost.js');
const { buildAttention, nextLine, createSeq, MAX_ITEMS } = require('../server/attention.js');

const A = path.join(scratch, 'alpha');
const B = path.join(scratch, 'beta');
const C = path.join(scratch, 'gamma');
for (const p of [A, B, C]) fs.mkdirSync(p, { recursive: true });
const [IA, IB, IC] = [A, B, C].map(lib.repoId);
const writeConfig = (extra = {}) => fs.writeFileSync(process.env.REPO_PANEL_CONFIG, JSON.stringify({ groups: [{ name: 'g', repos: [{ path: A }, { path: B }, { path: C }] }], ...extra }));

const MIN = 60000;
const NOW = Date.parse('2026-11-25T12:00:00Z');
const iso = (ms) => new Date(ms).toISOString();
const repos = [{ id: IA, name: 'alpha', branch: 'main' }, { id: IB, name: 'beta', branch: 'feat/x' }];

// ---- Critical zone: the token and the host gate, through the real server ----

const freePort = () => new Promise((resolve) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });
const call = (port, p, headers = {}) => new Promise((resolve, reject) => {
  http.get({ host: '127.0.0.1', port, path: p, headers }, (res) => { let d = ''; res.on('data', (c) => { d += c; }); res.on('end', () => { let json = null; try { json = JSON.parse(d); } catch { /* html */ } resolve({ status: res.statusCode, body: d, json }); }); }).on('error', reject);
});
// A host that only answers from memory, like the real one: alpha asks a question whose title carries `secret` (set by the test).
function fakeHost(over = {}) {
  const at = { title: 'Pick one' };
  const since = Date.now() - MIN;
  return {
    at,
    stateOf: (id) => (id === IA ? 'asking' : 'closed'),
    attentionOf: (id) => (id === IA ? { state: 'asking', since, mode: 'super-yolo', ended: null, dialogs: [{ requestId: 'r1', method: 'select', title: at.title, options: ['Yes', 'No'] }, ...(at.rawId ? [{ requestId: at.rawId, method: 'confirm', title: 't', options: [] }] : [])] } : { state: 'closed', since: null, mode: null, ended: null, dialogs: [] }),
    closeAll: async () => {},
    ...over,
  };
}
async function withServer(host, fn) {
  const port = await freePort();
  const server = createServer(port, { noSummaryStore: true, rpcHost: host, sessionsDir: path.join(scratch, 'sessions') });
  await new Promise((r) => server.listen(port, '127.0.0.1', r));
  try {
    const token = /name="?token"? content="([0-9a-f]+)"/.exec((await call(port, '/')).body)[1];
    await fn({ port, token, get: (p) => call(port, p, { 'x-token': token }) });
  } finally { await new Promise((r) => server.close(r)); }
}

test('f1-a: without the token, with a wrong one or with the token in the URL, the answer is 401 and carries no data', async () => {
  writeConfig({ attentionRepos: [IA] });
  await withServer(fakeHost(), async ({ port, token }) => {
    for (const r of [
      await call(port, '/api/attention'),
      await call(port, '/api/attention', { 'x-token': 'f'.repeat(48) }),
      await call(port, '/api/attention', { 'x-token': '' }),
      await call(port, `/api/attention?token=${token}`),
      await call(port, `/api/attention?x-token=${token}`),
    ]) {
      assert.equal(r.status, 401);
      assert.deepEqual(r.json, { error: 'Invalid token' });
      assert.ok(!r.body.includes('Pick one') && !r.body.includes(token));
    }
  });
});

test('f1-b: a foreign Host is refused before the token is even looked at', async () => {
  writeConfig({ attentionRepos: [IA] });
  await withServer(fakeHost(), async ({ port, token }) => {
    const r = await call(port, '/api/attention', { 'x-token': token, host: 'evil.example:80' });
    assert.equal(r.status, 403);
    assert.ok(!r.body.includes('Pick one'));
  });
});

test('f1-c: the answer never carries the token, even when a session prints it in a question', async () => {
  writeConfig({ attentionRepos: [IA] });
  const host = fakeHost();
  await withServer(host, async ({ get, token }) => {
    host.at.title = `Paste this: ${token} ok?`;
    host.at.rawId = `id-${token}`; // a field that does not pass through redact
    const r = await get('/api/attention');
    assert.equal(r.status, 200);
    assert.ok(!r.body.includes(token));
    assert.equal(r.json.items[0].kind, 'asking');
    assert.equal(r.json.items[0].requestId, 'r1');
    assert.equal(r.json.items[1].requestId, 'id-[token]');
  });
});

test('f1-d: with the token, one call answers seq, at, panel and the items of the scope', async () => {
  writeConfig({ attentionRepos: [IA] });
  await withServer(fakeHost(), async ({ get }) => {
    const r = await get('/api/attention');
    assert.equal(r.status, 200);
    assert.deepEqual(Object.keys(r.json).sort(), ['at', 'items', 'panel', 'seq']);
    assert.deepEqual(r.json.panel, { ok: true, stale: false });
    assert.deepEqual(r.json.items.map((i) => [i.kind, i.id, i.name]), [['asking', IA, 'alpha']]);
    assert.ok(Buffer.byteLength(r.body) < 2048);
    const again = await get('/api/attention');
    assert.equal(again.json.seq, r.json.seq);
  });
});

test('f1-e: scope is ?room= members, else attentionRepos, else repos with an open session; an unknown room is 404', async () => {
  const states = { [IA]: 'idle', [IB]: 'closed', [IC]: 'busy' };
  const host = fakeHost({
    stateOf: (id) => states[id] || 'closed',
    attentionOf: (id) => ({ state: states[id] || 'closed', since: Date.now() - 10 * MIN, mode: 'super-yolo', ended: null, dialogs: [] }),
  });
  await withServer(host, async ({ get }) => {
    writeConfig({ rooms: [{ name: 'erp', path: scratch, repos: [IB] }], attentionRepos: [IC] });
    assert.deepEqual((await get('/api/attention?room=erp')).json.items, []);
    assert.equal((await get('/api/attention?room=nope')).status, 404);
    writeConfig({ attentionRepos: [IA] });
    assert.deepEqual((await get('/api/attention')).json.items.map((i) => [i.kind, i.id]), [['idle-no-order', IA]]);
    writeConfig({});
    assert.deepEqual((await get('/api/attention')).json.items.map((i) => [i.kind, i.id]), [['idle-no-order', IA]]);
  });
});

test('F1b: ?room= also covers the repos of attentionRepos, each repo once; no room and an unknown room behave as before', async () => {
  const states = { [IA]: 'idle', [IB]: 'idle', [IC]: 'busy' };
  const host = fakeHost({
    stateOf: (id) => states[id] || 'closed',
    attentionOf: (id) => ({ state: states[id] || 'closed', since: Date.now() - 10 * MIN, mode: 'super-yolo', ended: null, dialogs: [] }),
  });
  const scope = async (get, p) => (await get(p)).json.items.map((i) => [i.kind, i.id]).sort((x, y) => x[1].localeCompare(y[1]));
  const both = [['idle-no-order', IA], ['idle-no-order', IB]].sort((x, y) => x[1].localeCompare(y[1]));
  await withServer(host, async ({ get }) => {
    writeConfig({ rooms: [{ name: 'erp', path: scratch, repos: [IB] }], attentionRepos: [IA] });
    assert.deepEqual(await scope(get, '/api/attention?room=erp'), both); // the member and the repo outside the room
    assert.deepEqual(await scope(get, '/api/attention'), [['idle-no-order', IA]]); // without a room: only attentionRepos, as before
    assert.equal((await get('/api/attention?room=nope')).status, 404);
    writeConfig({ rooms: [{ name: 'erp', path: scratch, repos: [IA, IB] }], attentionRepos: [IA] });
    assert.deepEqual(await scope(get, '/api/attention?room=erp'), both); // a repo in both lists counts once
    writeConfig({ rooms: [{ name: 'erp', path: scratch, repos: [IB] }] });
    assert.deepEqual(await scope(get, '/api/attention?room=erp'), [['idle-no-order', IB]]); // no attentionRepos: only the members
  });
});

// ---- The pure rules ----

test('f1-f: nextLine reads the last «Siguiente:» line of an agent message, cut to 200 characters', () => {
  assert.equal(nextLine('Hecho.\n\nSiguiente: corré /flow-commit con F1.'), 'Siguiente: corré /flow-commit con F1.');
  assert.equal(nextLine('**Siguiente:** aprobá la pantalla'), 'Siguiente: aprobá la pantalla');
  assert.equal(nextLine('Siguiente: a\nmás\nSiguiente: b'), 'Siguiente: b');
  assert.equal(nextLine(`Siguiente: ${'x'.repeat(300)}`).length, 200);
  assert.equal(nextLine('No hay paso siguiente: nada'), null);
  assert.equal(nextLine(''), null);
  assert.equal(nextLine(null), null);
});

const quiet = { state: 'closed', since: null, mode: null, ended: null, dialogs: [] };
const one = (session, extra = {}) => buildAttention({ repos, sessions: { [IA]: session, [IB]: quiet }, prs: {}, last: {}, now: NOW, stale: false, ...extra });

test('f1-g: an open question is asking, with its options and since', () => {
  const out = one({ state: 'asking', since: NOW - 3 * MIN, mode: 'super-yolo', ended: null, dialogs: [{ requestId: 'r9', method: 'select', title: 'Which?', options: ['A', 'B'], message: 'long', expiresAt: 1 }] });
  assert.deepEqual(out.items, [{ kind: 'asking', id: IA, name: 'alpha', requestId: 'r9', method: 'select', title: 'Which?', options: ['A', 'B'], since: iso(NOW - 3 * MIN) }]);
  assert.deepEqual(out.panel, { ok: true, stale: false });
});

test('f1-h: a free session with «Siguiente:» is waiting at once; without it, idle-no-order only after 5 minutes', () => {
  const free = (ms) => ({ state: 'idle', since: NOW - ms, mode: 'super-yolo', ended: null, dialogs: [] });
  assert.deepEqual(one(free(MIN), { last: { [IA]: 'Listo.\nSiguiente: corré /flow-commit' } }).items, [{ kind: 'waiting', id: IA, name: 'alpha', next: 'Siguiente: corré /flow-commit', since: iso(NOW - MIN) }]);
  assert.deepEqual(one(free(4 * MIN)).items, []);
  assert.deepEqual(one(free(6 * MIN), { last: { [IA]: 'sin orden' } }).items, [{ kind: 'idle-no-order', id: IA, name: 'alpha', since: iso(NOW - 6 * MIN) }]);
  assert.deepEqual(one({ ...free(6 * MIN), state: 'busy' }).items, []);
});

test('f1-i: a session that died by itself is session-dead; a mode other than super-yolo is mode-not-super-yolo', () => {
  assert.deepEqual(one({ ...quiet, ended: { cause: 'crashed', at: NOW - MIN } }).items, [{ kind: 'session-dead', id: IA, name: 'alpha', cause: 'crashed', since: iso(NOW - MIN) }]);
  assert.deepEqual(one({ state: 'busy', since: NOW, mode: 'normal', ended: null, dialogs: [] }).items, [{ kind: 'mode-not-super-yolo', id: IA, name: 'alpha', mode: 'normal', expected: 'super-yolo', fix: fixFor('super-yolo') }]);
  assert.deepEqual(one({ state: 'busy', since: NOW, mode: null, ended: null, dialogs: [] }).items, []);
});

const fixFor = (m) => `Set the default permission mode to ${m} in a terminal, then restart this session`;

test('F2: the expected mode is configurable; the kind keeps its name and the item says what was expected and how to fix it', () => {
  const at = (mode) => ({ state: 'busy', since: NOW, mode, ended: null, dialogs: [] });
  assert.deepEqual(one(at('yolo'), { expectedMode: 'yolo' }).items, []);
  assert.deepEqual(one(at('super-yolo'), { expectedMode: 'yolo' }).items, [{ kind: 'mode-not-super-yolo', id: IA, name: 'alpha', mode: 'super-yolo', expected: 'yolo', fix: fixFor('yolo') }]);
  assert.deepEqual(one(at('normal'), { expectedMode: undefined }).items.map((i) => i.expected), ['super-yolo']); // no setting: super-yolo, as before
  assert.deepEqual(one({ ...at('normal'), state: 'closed' }, { expectedMode: 'yolo' }).items, []); // a closed session is never flagged
});

test('F2: config.json keeps pi.permissionMode only when it is a known mode; a save keeps it', () => {
  const { loadConfig, saveConfig } = require('../server/config.js');
  writeConfig({ pi: { runtime: 'gentle-shell', permissionMode: 'yolo' } });
  assert.deepEqual(loadConfig().pi, { runtime: 'gentle-shell', permissionMode: 'yolo' });
  saveConfig(loadConfig());
  assert.equal(JSON.parse(fs.readFileSync(process.env.REPO_PANEL_CONFIG, 'utf8')).pi.permissionMode, 'yolo');
  for (const bad of ['root', 'SUPER-YOLO', 5, null, ['yolo']]) {
    writeConfig({ pi: { runtime: 'gentle-shell', permissionMode: bad } });
    assert.deepEqual(loadConfig().pi, { runtime: 'gentle-shell' }, String(bad));
  }
});

test('F2: through the route, the item follows pi.permissionMode of config.json', async () => {
  let mode = 'yolo';
  const host = fakeHost({ stateOf: () => 'busy', attentionOf: (id) => (id === IA ? { state: 'busy', since: Date.now(), mode, ended: null, dialogs: [] } : { state: 'closed', since: null, mode: null, ended: null, dialogs: [] }) });
  await withServer(host, async ({ get }) => {
    writeConfig({ attentionRepos: [IA], pi: { permissionMode: 'yolo' } });
    assert.deepEqual((await get('/api/attention')).json.items, []);
    mode = 'normal';
    assert.deepEqual((await get('/api/attention')).json.items.map((i) => [i.kind, i.mode, i.expected]), [['mode-not-super-yolo', 'normal', 'yolo']]);
    writeConfig({ attentionRepos: [IA] });
    assert.deepEqual((await get('/api/attention')).json.items.map((i) => i.expected), ['super-yolo']);
  });
});

test('f1-j: PRs: ready is pr-green with the clone whose branch is its head, failed checks are pr-red, a PR seen by two clones counts once', () => {
  const green = { number: 7, title: 'F1 attention', url: 'u/7', head: 'feat/x', ready: true, checks: { state: 'passed' } };
  const red = { number: 8, title: 'Broken', url: 'u/8', head: 'other', ready: false, checks: { state: 'failed' } };
  const wait = { number: 9, title: 'Pending', url: 'u/9', head: 'p', ready: false, checks: { state: 'pending' } };
  const out = buildAttention({ repos, sessions: { [IA]: quiet, [IB]: quiet }, prs: { [IA]: [green, red, wait], [IB]: [green, red] }, last: {}, now: NOW, stale: false });
  assert.deepEqual(out.items, [
    { kind: 'pr-green', id: IB, name: 'beta', number: 7, head: 'feat/x', title: 'F1 attention', clone: 'beta' },
    { kind: 'pr-red', id: IA, name: 'alpha', number: 8, head: 'other', title: 'Broken', clone: null },
  ]);
});

test('f1-k: order is asking, pr-green, waiting, then the rest; at most 20 items, with truncated:true when cut', () => {
  const many = Array.from({ length: 25 }, (_, n) => ({ number: n + 1, title: `t${n}`, url: `u${n}`, head: `h${n}`, ready: true, checks: { state: 'passed' } }));
  const out = buildAttention({ repos, sessions: { [IA]: { state: 'asking', since: NOW, mode: 'normal', ended: null, dialogs: [{ requestId: 'q', method: 'confirm', title: 'Sure?', options: [] }] }, [IB]: { state: 'idle', since: NOW, mode: 'super-yolo', ended: null, dialogs: [] } }, prs: { [IA]: many }, last: { [IB]: 'Siguiente: x' }, now: NOW, stale: true });
  assert.equal(MAX_ITEMS, 20);
  assert.equal(out.items.length, 20);
  assert.equal(out.truncated, true);
  assert.equal(out.items[0].kind, 'asking');
  assert.ok(out.items.slice(1).every((i) => i.kind === 'pr-green'));
  assert.deepEqual(out.panel, { ok: true, stale: true });
  assert.equal(one(quiet).truncated, undefined);
});

test('f1-l: texts are cut (200, PR titles 90) and pass through redact', () => {
  const secret = 'ghp_' + 'a'.repeat(36);
  const out = one({ state: 'asking', since: NOW, mode: 'super-yolo', ended: null, dialogs: [{ requestId: 'r', method: 'select', title: `key ${secret} ${'y'.repeat(300)}`, options: [`o ${secret}`, 'z'.repeat(300)] }] }, { prs: { [IA]: [{ number: 1, title: 'w'.repeat(200), url: 'u', head: 'h', ready: true, checks: {} }] } });
  const [ask, pr] = out.items;
  assert.ok(!JSON.stringify(out).includes(secret));
  assert.ok(ask.title.length <= 200 && ask.options[1].length <= 200);
  assert.equal(pr.title.length, 90);
});

test('f1-m: seq moves only when items or panel change, never for the same content', () => {
  const seq = createSeq();
  const a = { panel: { ok: true, stale: false }, items: [{ kind: 'asking', id: IA }] };
  const s1 = seq(a);
  assert.equal(seq({ ...a, items: [{ kind: 'asking', id: IA }] }), s1);
  const s2 = seq({ ...a, items: [] });
  assert.ok(s2 > s1);
  const s3 = seq({ panel: { ok: true, stale: true }, items: [] });
  assert.ok(s3 > s2);
  assert.equal(seq({ panel: { ok: true, stale: true }, items: [] }), s3);
});

// ---- The host: memory only (critical zone: the host's concurrency) ----

test('f1-n: attentionOf reads memory only: state with since, dialogs, mode; a session that died by itself stays dead until it starts again', async () => {
  let exit; let state = 'idle'; let made = 0; let cause = 'extension';
  const createClient = (opts) => { made += 1; exit = opts.onExit; let gone = false; return { start: async () => ({}), request: async () => ({}), pendingDialogs: () => (state === 'asking' ? [{ id: 'r1', method: 'select', title: 'T', options: ['a'] }] : []), state: () => state, close: async () => { if (!gone) { gone = true; setImmediate(() => opts.onExit({ reason: 'exit' })); } }, cause: async () => cause }; };
  const host = createRpcHost({ resolve: async () => ({ active: { id: 'x', command: 'pi', args: [] } }), repoOf: (id) => ({ id, path: A }), publish: () => {}, createClient, adoptedOf: () => null });
  assert.deepEqual(host.attentionOf(IA), { state: 'closed', since: null, mode: null, ended: null, dialogs: [] });
  const t0 = Date.now();
  await host.start(IA);
  const up = host.attentionOf(IA);
  assert.equal(up.state, 'idle');
  assert.ok(up.since >= t0 && up.since <= Date.now());
  state = 'asking';
  assert.deepEqual(host.attentionOf(IA).dialogs, [{ requestId: 'r1', method: 'select', title: 'T', options: ['a'] }]);
  state = 'idle';
  exit({ reason: 'exit' });
  await new Promise((r) => setImmediate(r));
  const dead = host.attentionOf(IA);
  assert.equal(dead.state, 'closed');
  assert.equal(dead.ended.cause, 'extension');
  assert.ok(Number.isFinite(dead.ended.at));
  await host.start(IA);
  assert.equal(made, 2);
  assert.equal(host.attentionOf(IA).ended, null);
  cause = 'not-a-known-cause'; // an unknown cause still leaves the session dead, without a cause
  exit({ reason: 'exit' });
  await new Promise((r) => setImmediate(r));
  assert.equal(host.attentionOf(IA).ended.cause, null);
  await host.start(IA);
  await host.close(IA);
  await new Promise((r) => setImmediate(r));
  assert.equal(host.attentionOf(IA).ended, null); // closed by the person: not dead
  await host.closeAll();
});

// ---- Findings of the independent verification ----

test('f1-o: a token glued to other letters is never left cut in half by the 200-character cut', async () => {
  writeConfig({ attentionRepos: [IA] });
  const host = fakeHost();
  await withServer(host, async ({ get, token }) => {
    host.at.title = 'q'.repeat(170) + token;
    const r = await get('/api/attention');
    assert.equal(r.status, 200);
    for (let n = 12; n <= token.length; n += 1) assert.ok(!r.body.includes(token.slice(0, n)), `a ${n}-character prefix of the token leaked`);
  });
});

test('f1-p: seq is kept per scope (alternating scopes with no change never move it) and starts above any earlier run', () => {
  const before = Date.now();
  const seq = createSeq();
  const a = { panel: { ok: true, stale: false }, items: [] };
  const b = { panel: { ok: true, stale: false }, items: [{ kind: 'asking', id: IA }] };
  const sa = seq(a, 'room:r');
  const sb = seq(b, '');
  assert.ok(sa >= before);
  assert.equal(seq(a, 'room:r'), sa);
  assert.equal(seq(b, ''), sb);
  assert.ok(seq(b, 'room:r') > sb);
});

test('f1-q: the owner clone is only a clone that lists the same PR; an unrelated repo on a branch of the same name is not', () => {
  const pr = { number: 3, title: 'x', url: 'alpha/3', head: 'feat/x', ready: true, checks: { state: 'passed' } };
  const out = buildAttention({ repos, sessions: {}, prs: { [IA]: [pr], [IB]: [] }, last: {}, now: NOW, stale: false });
  assert.deepEqual(out.items, [{ kind: 'pr-green', id: IA, name: 'alpha', number: 3, head: 'feat/x', title: 'x', clone: null }]);
});

test('f1-r: a snoozed PR is left out, like in the summary', () => {
  const pr = { number: 4, title: 'parked', url: 'u/4', head: 'h', ready: true, checks: {} };
  const out = buildAttention({ repos, sessions: {}, prs: { [IA]: [pr] }, last: {}, now: NOW, stale: false, snoozed: [`${IA}:4`] });
  assert.deepEqual(out.items, []);
});

test('f1-s: a PR snoozed on any clone that lists it is left out, also when another clone lists it first', () => {
  const pr = { number: 3, title: 'x', url: 'r/3', head: 'feat/x', ready: true, checks: {} };
  const out = buildAttention({ repos, sessions: {}, prs: { [IA]: [pr], [IB]: [pr] }, last: {}, now: NOW, stale: false, snoozed: [`${IB}:3`] });
  assert.deepEqual(out.items, []);
});
