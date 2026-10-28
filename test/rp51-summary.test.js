'use strict';
// RP51 (S46): GET /api/summary. `summarize(facts)` turns the facts of one repo into one row; `summaryFor(deps, query)`
// gathers every configured repo with injected Orca and PR providers, isolating failures per repo.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'rp51-'));
const goodRepo = path.join(scratch, 'good');
const missingRepo = path.join(scratch, 'missing');
fs.mkdirSync(goodRepo);
// The caller's git environment (a hook, a worktree) must not leak into the throwaway repo.
const gitEnv = { ...process.env };
for (const k of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE']) delete gitEnv[k];
const g = (...args) => spawnSync('git', ['-C', goodRepo, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { encoding: 'utf8', env: gitEnv });
g('init', '-q');
fs.writeFileSync(path.join(goodRepo, 'a.txt'), 'x\n');
g('add', 'a.txt');
g('commit', '-q', '-m', 'first subject');
const configFile = path.join(scratch, 'config.json');
fs.writeFileSync(configFile, JSON.stringify({ groups: [{ name: 'G', repos: [{ path: goodRepo }, { path: missingRepo }] }] }));
process.env.REPO_PANEL_CONFIG = configFile;
process.env.REPO_PANEL_CASES_FILE = 'off';
test.after(() => fs.rmSync(scratch, { recursive: true, force: true }));

const { summarize, summaryFor } = require('../server/summary.js');

const unit = (id, estado, extra = {}) => ({ id, entrega: `deliver ${id}`, resultadoVisible: `see ${id}`, dependsOn: [], externalDeps: [], estado, ...extra });
const roadmap = (rows, derived = {}, next = null) => ({ available: true, rows, derived, next });
const facts = (over = {}) => ({
  repo: { id: 'r1', name: 'repo-one', group: 'G', room: null },
  local: { branch: 'main', files: [], ahead: 0, behind: 0, base: 'main' },
  prs: { prs: [], stale: null },
  roadmap: roadmap([]),
  state: { available: false },
  session: 'closed',
  last: { at: '2026-10-28T10:00:00Z', what: 'a subject' },
  now: Date.parse('2026-10-28T12:00:00Z'),
  ...over,
});

test('progress counts En revisión and En curso from the derived states, not the hand-written column', () => {
  const rows = [unit('A', 'Completada'), unit('B', 'Pendiente'), unit('C', 'Pendiente'), unit('D', 'En curso'), unit('E', 'Bloqueada'), unit('F', 'Pendiente')];
  const derived = { B: { state: 'En revisión', via: 'pr', pr: 7 }, C: { state: 'En curso', via: 'branch' }, F: { state: 'Lista', via: 'branch' } };
  const row = summarize(facts({ roadmap: roadmap(rows, derived) }));
  assert.deepEqual(row.progress, { total: 6, completada: 1, enRevision: 1, bloqueada: 1, pendiente: 1, enCurso: 2 });
});

test('the row has every field; a repo without a roadmap has null progress values, no next and no blocking', () => {
  const row = summarize(facts({ roadmap: { available: false, reason: 'missing' } }));
  assert.deepEqual(Object.keys(row), ['id', 'name', 'group', 'room', 'branch', 'progress', 'session', 'next', 'blocking', 'lastMovement', 'action', 'error', 'needs', 'rank']);
  assert.deepEqual(row.progress, { total: null, completada: null, enRevision: null, bloqueada: null, pendiente: null, enCurso: null });
  assert.equal(row.next, null);
  assert.deepEqual(row.blocking, []);
  assert.deepEqual([row.id, row.name, row.group, row.room, row.branch, row.error], ['r1', 'repo-one', 'G', null, 'main', null]);
  assert.deepEqual(row.lastMovement, { at: '2026-10-28T10:00:00Z', what: 'a subject' });
  assert.deepEqual(summarize(facts({ last: null })).lastMovement, { at: null, what: null });
});

test('next carries the id, entrega and resultadoVisible of the next unit', () => {
  const rows = [unit('A', 'Completada'), unit('B', 'Pendiente', { dependsOn: ['A'] })];
  const row = summarize(facts({ roadmap: roadmap(rows, {}, rows[1]) }));
  assert.deepEqual(row.next, { id: 'B', entrega: 'deliver B', resultadoVisible: 'see B' });
});

test('blocking lists Bloqueada rows with their table and external dependencies, at most 3', () => {
  const rows = [
    unit('A', 'Bloqueada', { dependsOn: ['Z'], externalDeps: ['other project'] }),
    unit('B', 'Bloqueada'), unit('C', 'Bloqueada'), unit('D', 'Bloqueada'), unit('Z', 'Pendiente'),
  ];
  const row = summarize(facts({ roadmap: roadmap(rows) }));
  assert.equal(row.blocking.length, 3);
  assert.deepEqual(row.blocking[0], { unit: 'A', waitsFor: ['Z'], external: ['other project'] });
  assert.deepEqual(row.blocking[1], { unit: 'B', waitsFor: [], external: [] });
});

test('with no takeable next unit, blocking adds the first Pendiente row with its unmet dependencies', () => {
  const rows = [unit('A', 'Pendiente', { dependsOn: ['B'] }), unit('B', 'Pendiente', { dependsOn: ['A'] }), unit('C', 'Pendiente', { dependsOn: ['Q'] }), unit('Q', 'Bloqueada')];
  const row = summarize(facts({ roadmap: roadmap(rows, {}, null) }));
  assert.deepEqual(row.blocking, [{ unit: 'Q', waitsFor: [], external: [] }, { unit: 'A', waitsFor: ['B'], external: [] }]);
  // with a takeable next unit the Pendiente row is not reported
  const ok = [unit('A', 'Pendiente'), unit('B', 'Pendiente', { dependsOn: ['A'] })];
  assert.deepEqual(summarize(facts({ roadmap: roadmap(ok, {}, ok[0]) })).blocking, []);
});

test('session mapping: closed none, idle free, busy working, asking waiting, ambiguous and unknown unknown', () => {
  const of = (session) => summarize(facts({ session })).session;
  assert.deepEqual(['closed', 'idle', 'busy', 'asking', 'ambiguous', 'unknown', undefined].map(of), [
    { state: 'none' }, { state: 'free' }, { state: 'working' }, { state: 'waiting' },
    { state: 'unknown' }, { state: 'unknown' }, { state: 'unknown' },
  ]);
});

test('action: no work gives null; changes give deliver; a ready PR gives merge before deliver', () => {
  assert.equal(summarize(facts()).action, null);
  const dirty = { branch: 'x', files: [{ path: 'a' }], ahead: 0, behind: 0, base: 'main' };
  assert.deepEqual(Object.keys(summarize(facts({ local: dirty })).action), ['kind', 'label', 'pr']);
  assert.equal(summarize(facts({ local: dirty })).action.kind, 'deliver');
  assert.equal(summarize(facts({ local: dirty })).action.pr, null);
  const merge = summarize(facts({ local: dirty, prs: { prs: [{ number: 9, title: 'T', ready: true }], stale: null } })).action;
  assert.deepEqual([merge.kind, merge.pr], ['merge', 9]);
  assert.match(merge.label, /#9/);
  // a snoozed ready PR is not offered
  assert.equal(summarize(facts({ prs: { prs: [{ number: 9, title: 'T', ready: true }], stale: null }, snoozed: ['r1:9'] })).action, null);
});

test('action: a clean repo with a next unit gives start; a waiting session gives answer over everything', () => {
  const rows = [unit('A', 'Pendiente')];
  const start = summarize(facts({ roadmap: roadmap(rows, {}, rows[0]) })).action;
  assert.deepEqual([start.kind, start.pr], ['start', null]);
  assert.match(start.label, /A/);
  const dirty = { branch: 'x', files: [{ path: 'a' }], ahead: 0, behind: 0, base: 'main' };
  const ask = summarize(facts({ local: dirty, session: 'asking', prs: { prs: [{ number: 9, title: 'T', ready: true }], stale: null } })).action;
  assert.deepEqual(ask, { kind: 'answer', label: 'Answer the question in the pi session', pr: null });
});

test('action: stale branch gives branch, a declared needs-input gives waiting', () => {
  assert.equal(summarize(facts({ prs: { prs: [], stale: { branch: 'x' } } })).action.kind, 'branch');
  const state = { available: true, state: 'needs-input', next: 'Pick one', at: '2026-10-28T11:59:00Z', stale: false };
  const dirty = { branch: 'x', files: [{ path: 'a' }], ahead: 0, behind: 0, base: 'main' };
  assert.equal(summarize(facts({ local: dirty, state })).action.kind, 'waiting');
});

test('a repo whose local or PR read failed is an error row with nulls', () => {
  for (const bad of [{ local: { error: 'Folder not found' } }, { prs: { error: 'gh pr list failed' } }, { error: 'boom' }]) {
    const row = summarize(facts(bad));
    assert.ok(row.error);
    assert.deepEqual([row.branch, row.next, row.action, row.progress.total], [null, null, null, null]);
    assert.deepEqual(row.blocking, []);
    assert.deepEqual([row.id, row.name, row.group], ['r1', 'repo-one', 'G']);
  }
  assert.equal(summarize(facts({ local: { error: 'Folder not found' } })).error, 'Folder not found');
});

// ---------- summaryFor ----------
const IDLE_PI = '▎ ✿ waiting for input\n▎   type, or / for commands\n▎\n';
function fakeOrca({ preview = IDLE_PI, fail = false } = {}) {
  const calls = [];
  const orca = async (args) => {
    calls.push(args);
    if (fail) throw new Error('Orca CLI is unavailable');
    if (args[0] === 'list') return { terminals: [{ handle: 'h1', title: 'T', worktreePath: goodRepo.replace(/\\/g, '/'), connected: true, writable: true }] };
    if (args[0] === 'show') return { terminal: { preview } };
    throw new Error(`unexpected orca verb ${args[0]}`);
  };
  return { orca, calls };
}
const prs = async (repo) => {
  if (repo.path === missingRepo) throw new Error('gh exploded');
  return { prs: [], stale: null };
};

test('summaryFor: one failing repo does not break the other, and orca list runs once', async () => {
  const f = fakeOrca();
  const out = await summaryFor({ orca: f.orca, prs }, { fresh: '1' });
  assert.equal(out.rows.length, 2);
  const [good, bad] = out.rows;
  assert.equal(good.error, null);
  assert.match(good.branch, /^(master|main)$/);
  assert.deepEqual(good.session, { state: 'free' });
  assert.equal(good.lastMovement.what, 'first subject');
  assert.match(good.lastMovement.at, /^\d{4}-\d\d-\d\dT/);
  assert.equal(good.group, 'G');
  assert.ok(bad.error);
  assert.equal(bad.action, null);
  assert.equal(f.calls.filter((c) => c[0] === 'list').length, 1);
  assert.deepEqual(Object.keys(out), ['rows', 'counts', 'attention', 'generatedAt']);
  assert.deepEqual(out.counts, { working: 0, waiting: 0, blocked: 0, idle: 1 });
  assert.match(out.generatedAt, /^\d{4}-\d\d-\d\dT/);
});

test('summaryFor: an Orca failure makes every session unknown, never none', async () => {
  const out = await summaryFor({ orca: fakeOrca({ fail: true }).orca, prs }, { fresh: '1' });
  assert.deepEqual(out.rows.map((r) => r.session.state), ['unknown', 'unknown']);
});

test('summaryFor: an asking session counts as waiting and appears in attention', async () => {
  const ask = '▎ ✿ waiting for input\nAllow guarded git operation?\n  ↑↓ navigate  enter select  escape/ctrl+c cancel\n';
  const out = await summaryFor({ orca: fakeOrca({ preview: ask }).orca, prs }, { fresh: '1' });
  assert.equal(out.rows[0].session.state, 'waiting');
  assert.equal(out.rows[0].action.kind, 'answer');
  assert.equal(out.counts.waiting, 1);
  assert.deepEqual(out.attention.map((a) => a.id), [out.rows[0].id]);
  assert.ok(out.attention[0].why && out.attention[0].name);
});

test('summaryFor: failing CI on a PR is an attention reason', async () => {
  const failing = async () => ({ prs: [{ number: 3, title: 'T', ready: false, checks: { state: 'failed' } }], stale: null });
  const out = await summaryFor({ orca: fakeOrca().orca, prs: failing }, { fresh: '1' });
  assert.match(out.attention[0].why, /#3/);
});

test('summaryFor: the response is cached for 10 s and ?fresh=1 bypasses the cache', async () => {
  let t = 1000000;
  const f = fakeOrca();
  const deps = { orca: f.orca, prs, now: () => t };
  const a = await summaryFor(deps, {});
  const b = await summaryFor(deps, {});
  assert.equal(a, b);
  assert.equal(f.calls.filter((c) => c[0] === 'list').length, 1);
  const c = await summaryFor(deps, { fresh: '1' });
  assert.notEqual(c, a);
  assert.equal(f.calls.filter((x) => x[0] === 'list').length, 2);
  t += 10001;
  assert.notEqual(await summaryFor(deps, {}), c);
  assert.equal(f.calls.filter((x) => x[0] === 'list').length, 3);
});

test('GET /api/summary is a registered route that needs the token', async () => {
  const http = require('node:http');
  const { createServer } = require('../server/http.js');
  // The host check needs the real port: find a free one first.
  const probe = http.createServer();
  await new Promise((r) => probe.listen(0, '127.0.0.1', r));
  const port = probe.address().port;
  await new Promise((r) => probe.close(r));
  const real = createServer(port, { orca: fakeOrca().orca, prs });
  await new Promise((r) => real.listen(port, '127.0.0.1', r));
  try {
    const status = await new Promise((resolve, reject) => {
      http.get({ host: '127.0.0.1', port, path: '/api/summary' }, (res) => { res.resume(); resolve(res.statusCode); }).on('error', reject);
    });
    assert.equal(status, 401);
  } finally { real.close(); }
});

// ---------- RP58: follow-ups of the review ----------
test('summaryFor: an exception while analysing one repo gives an error row for it only and never rejects', async () => {
  const local = async (repo) => (repo.path === goodRepo ? { branch: 'main', files: null, ahead: 0 } : { branch: 'main', files: [], ahead: 0, behind: 0, base: 'main' });
  const out = await summaryFor({ orca: fakeOrca().orca, prs: async () => ({ prs: [], stale: null }), local }, { fresh: '1' });
  assert.equal(out.rows.length, 2);
  const [bad, ok] = out.rows;
  assert.ok(bad.error);
  assert.deepEqual([bad.action, bad.next, bad.progress.total, bad.blocking], [null, null, null, []]);
  assert.deepEqual([bad.name, bad.group], ['good', 'G']);
  assert.equal(ok.error, null);
  assert.deepEqual(out.counts, { working: 0, waiting: 0, blocked: 0, idle: 1 });
});

test('summaryFor: the 10 s cache counts from when the build finished, not from when it started', async () => {
  let t = 1000000;
  const f = fakeOrca();
  let slowed = false;
  const slow = async () => { if (!slowed) { slowed = true; t += 8000; } return { prs: [], stale: null }; };
  const deps = { orca: f.orca, prs: slow, now: () => t };
  const a = await summaryFor(deps, {});
  assert.equal(t, 1000000 + 8000);
  t += 5000; // 13 s after the start, 5 s after the end
  assert.equal(await summaryFor(deps, {}), a);
  t += 5001; // 10.001 s after the end
  assert.notEqual(await summaryFor(deps, {}), a);
});

const blockedRoadmap = async () => ({ available: true, rows: [unit('B', 'Bloqueada')], derived: {}, next: null });
const cleanLocal = async () => ({ branch: 'main', files: [], ahead: 0, behind: 0, base: 'main' });

test('summaryFor: counts and attention come from the rows (waiting session, failing CI, blocked unit)', async () => {
  const ask = '▎ ✿ waiting for input\nAllow guarded git operation?\n  ↑↓ navigate  enter select  escape/ctrl+c cancel\n';
  const failing = async (repo) => (repo.path === goodRepo ? { prs: [{ number: 3, title: 'T', ready: false, checks: { state: 'failed' } }], stale: null } : { prs: [], stale: null });
  const out = await summaryFor({ orca: fakeOrca({ preview: ask }).orca, prs: failing, local: cleanLocal, roadmap: blockedRoadmap, state: async () => ({ available: false }) }, { fresh: '1' });
  const [waiting, blocked] = out.rows;
  assert.deepEqual([waiting.session.state, blocked.session.state], ['waiting', 'none']);
  assert.deepEqual(blocked.blocking, [{ unit: 'B', waitsFor: [], external: [] }]);
  assert.deepEqual(out.counts, { working: 0, waiting: 1, blocked: 1, idle: 0 });
  assert.deepEqual(out.attention, [
    { id: waiting.id, name: 'good', why: 'The pi session is waiting for an answer; PR #3 has failing checks; Blocked: B' },
    { id: blocked.id, name: 'missing', why: 'Blocked: B' },
  ]);
});

test('GET /api/summary with a valid token answers 200 with the summary keys', async () => {
  const http = require('node:http');
  const { createServer } = require('../server/http.js');
  const probe = http.createServer();
  await new Promise((r) => probe.listen(0, '127.0.0.1', r));
  const port = probe.address().port;
  await new Promise((r) => probe.close(r));
  const real = createServer(port, { orca: fakeOrca().orca, prs });
  await new Promise((r) => real.listen(port, '127.0.0.1', r));
  const get = (p, headers = {}) => new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: p, headers }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    }).on('error', reject);
  });
  try {
    const token = /name="?token"? content="([0-9a-f]+)"/.exec((await get('/')).body)[1];
    const res = await get('/api/summary?fresh=1', { 'x-token': token });
    assert.equal(res.status, 200);
    assert.deepEqual(Object.keys(JSON.parse(res.body)), ['rows', 'counts', 'attention', 'generatedAt']);
  } finally { real.close(); }
});
