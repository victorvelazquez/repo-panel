'use strict';
// RP77 (S68, S71), the shared terminal list. `listTerminals(orca, opts = {})` in server/pi.js is the read of `orca terminal list` for the READ-ONLY
// callers (piStatus, liveOf): it answers the same array as `(await orca(['list'])).terminals` and (a) callers that arrive while a list is in flight
// share it (one orca call); (b) an answer is reused while it is younger than 1000 ms by `opts.now` (default Date.now), counted from when the list
// RESOLVED; (c) a rejection or a non-array `terminals` is never cached and every waiting caller gets the same outcome; (d) the cache is module-level
// and `clearLiveCache()` resets it and the counters; (e) `liveCacheStats()` also answers `listHits` and `listMisses`. `primeList(terminals, opts)`
// stores a list the warmer just fetched. The writers (piSend, piSessions, the dialog answer, the chat send) and the warmer always list fresh.
// COUNTING (assumption pinned here): listMisses = the orca list calls made (failed ones too); listHits = callers answered with no call of their own
// (from the cache or by sharing a flight); primeList counts nothing. A fake Orca, a fake clock (Date.now is mocked for the callers that take no
// `now`), gate promises for concurrency: no real waiting, no real Orca, no real config.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'rp77l-'));
const sessionsBase = path.join(scratch, 'sessions');
const repoDir = path.join(scratch, 'My Repo.Api');
for (const d of [sessionsBase, repoDir]) fs.mkdirSync(d);
const configFile = path.join(scratch, 'config.json');
process.env.REPO_PANEL_CONFIG = configFile;
process.env.REPO_PANEL_SESSIONS_DIR = sessionsBase;
process.env.REPO_PANEL_CASES_FILE = 'off';
test.after(() => fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 5 }));

const lib = require('../lib.js');
const S = require('../server/sessions.js');
const P = require('../server/pi.js');
const { createWarmer } = require('../server/livewarm.js');
const { answerDialog } = require('../server/dialoganswer.js');
const { sendChat } = require('../server/chatsend.js');
const { scanSessions, piStatus, piSend, piSessions, clearLiveCache, liveCacheStats } = P;

const REPO_ID = lib.repoId(repoDir);
const REPO = { path: repoDir };
const writeConfig = (extra = {}) => fs.writeFileSync(configFile, JSON.stringify({ port: 4310, groups: [{ name: 'G', repos: [{ path: repoDir }] }], rooms: [], ...extra }));

const IDLE = '▎ ✿ waiting for input\n▎   type, or / for commands\n▎\n~\\proj (main) • panel:demo\n';
const WORKING = '▎ ❁ working…\n▎   type, or / for commands\n▎\n~\\proj (main) • panel:demo\n';

// Through a function so a missing export fails the test that uses it, not the whole file.
const tl = (...a) => P.listTerminals(...a);
const prime = (...a) => P.primeList(...a);
const tick = () => new Promise((r) => setImmediate(r));
const deferred = () => { let resolve; let reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };

let clock = 0;
const now = () => clock;
test.beforeEach((t) => { t.mock.method(Date, 'now', () => clock); clearLiveCache(); clock = 1000; writeConfig(); });

// ---------- fixtures ----------
// A bare fake: every `list` answers a fresh object whose lastOutputAt is the number of the call, so answers can be told apart.
function listOrca(answer) {
  const calls = [];
  const orca = async (args) => { calls.push(args); return answer ? answer(calls.length, args) : { terminals: [{ handle: 'a', worktreePath: repoDir, lastOutputAt: calls.length }] }; };
  return { orca, calls, lists: () => calls.length };
}
const answerN = (n) => [{ handle: 'a', worktreePath: repoDir, lastOutputAt: n }];

// A fake Orca for the pi callers. `gate` (a promise) holds every `list` answer; `mode` 'fail' rejects it, 'nonarray' answers no array.
function fakeOrca(world) {
  const calls = [];
  const self = { calls, world, gate: null, mode: null };
  let sent = false;
  self.orca = async (args) => {
    calls.push(args);
    if (args[0] === 'list') {
      if (self.gate) await self.gate;
      if (self.mode === 'fail') throw new Error('list failed');
      if (self.mode === 'nonarray') return {};
      return { terminals: Object.keys(world).map((handle) => ({ handle, worktreePath: repoDir, connected: true, writable: true, lastOutputAt: world[handle].lastOutputAt })) };
    }
    const t = world[args[2]];
    if (args[0] === 'show') return { terminal: { preview: sent ? WORKING : t.preview } };
    if (args[0] === 'send') { sent = true; return {}; }
    throw new Error(`unexpected ${args[0]}`);
  };
  const count = (verb) => calls.filter((c) => c[0] === verb).length;
  return Object.assign(self, { lists: () => count('list'), shows: () => count('show'), sends: () => count('send') });
}
const idleWorld = () => ({ t1: { preview: IDLE, lastOutputAt: 5 } });
const bump = (f, preview) => { f.world.t1.lastOutputAt += 1; f.world.t1.preview = preview; };

// ---------- the shape ----------
test('listTerminals and primeList are exported; liveCacheStats answers exactly hits, misses, size, listHits and listMisses, all zero at the start', () => {
  assert.equal(typeof P.listTerminals, 'function');
  assert.equal(typeof P.primeList, 'function');
  assert.deepEqual(Object.keys(liveCacheStats()).sort(), ['hits', 'listHits', 'listMisses', 'misses', 'size']);
  assert.deepEqual(liveCacheStats(), { hits: 0, misses: 0, size: 0, listHits: 0, listMisses: 0 });
});

test('a first call lists once with exactly `list` and answers the same array as (await orca(["list"])).terminals', async () => {
  const f = listOrca();
  assert.deepEqual(await tl(f.orca, { now }), answerN(1));
  assert.deepEqual(f.calls, [['list']]);
});

// ---------- (a) single flight ----------
test('(a) callers that arrive while a list is in flight share it: ONE orca call, the same answer for all, counted as 1 miss and 2 hits', async () => {
  const gate = deferred();
  const f = listOrca(async (n) => { await gate.promise; return { terminals: answerN(n) }; });
  const all = [tl(f.orca, { now }), tl(f.orca, { now }), tl(f.orca, { now })];
  await tick();
  assert.equal(f.lists(), 1, 'the first answer is still held');
  gate.resolve();
  for (const got of await Promise.all(all)) assert.deepEqual(got, answerN(1));
  assert.equal(f.lists(), 1);
  assert.deepEqual(liveCacheStats(), { hits: 0, misses: 0, size: 0, listHits: 2, listMisses: 1 });
});

// ---------- (b) the short cache ----------
for (const [age, hit] of [[0, true], [999, true], [1000, false], [60000, false]]) {
  test(`(b) age ${age} ms by opts.now: ${hit ? 'a hit, no orca call' : 'a miss, listed again'}`, async () => {
    const f = listOrca();
    clock = 5000;
    await tl(f.orca, { now });
    clock = 5000 + age;
    assert.deepEqual(await tl(f.orca, { now }), answerN(hit ? 1 : 2));
    assert.equal(f.lists(), hit ? 1 : 2);
    assert.deepEqual([liveCacheStats().listHits, liveCacheStats().listMisses], hit ? [1, 1] : [0, 2]);
  });
}

test('(b) a hit does not renew the answer: it expires 1000 ms after it RESOLVED, and a new list is young again', async () => {
  const f = listOrca();
  clock = 0;
  await tl(f.orca, { now });
  clock = 999;
  await tl(f.orca, { now });
  assert.equal(f.lists(), 1);
  clock = 1000;
  await tl(f.orca, { now });
  assert.equal(f.lists(), 2, 'old by its original time');
  clock = 1999;
  await tl(f.orca, { now });
  assert.equal(f.lists(), 2, 'young from the second list');
  clock = 2000;
  await tl(f.orca, { now });
  assert.equal(f.lists(), 3);
});

test('(b) the age is counted from when the list RESOLVED, not from when it started', async () => {
  for (const [later, hit] of [[999, true], [1000, false]]) {
    clearLiveCache();
    const gate = deferred();
    const f = listOrca(async (n) => { await gate.promise; return { terminals: answerN(n) }; });
    clock = 0;
    const first = tl(f.orca, { now });
    await tick();
    clock = 3000; // the list takes 3 s
    gate.resolve();
    await first;
    clock = 3000 + later;
    await tl(f.orca, { now });
    assert.equal(f.lists(), hit ? 1 : 2, `${later} ms after it resolved`);
  }
});

test('(b) the age is measured with opts.now, not the real clock; without opts.now the (mocked) Date.now is used', async () => {
  const f = listOrca();
  clock = 1e12;
  await tl(f.orca, { now });
  clock = 5; // a clock that goes backwards is not an old answer
  await tl(f.orca, { now });
  assert.equal(f.lists(), 1);
  clearLiveCache();
  const g = listOrca();
  clock = 100;
  await tl(g.orca);
  clock = 1099;
  await tl(g.orca);
  assert.equal(g.lists(), 1);
  clock = 1100;
  await tl(g.orca);
  assert.equal(g.lists(), 2);
});

// ---------- (c) failures are never cached ----------
test('(c) a rejection is shared by every waiting caller (the same error) and is not cached: the next call lists again and then caches', async () => {
  const gate = deferred();
  const boom = new Error('Orca CLI is unavailable');
  let failing = true;
  const f = listOrca(async (n) => { await gate.promise; if (failing) throw boom; return { terminals: answerN(n) }; });
  const waiting = [tl(f.orca, { now }), tl(f.orca, { now }), tl(f.orca, { now })].map((p) => p.then(() => null, (e) => e));
  gate.resolve();
  for (const e of await Promise.all(waiting)) assert.equal(e, boom);
  assert.equal(f.lists(), 1);
  failing = false;
  assert.deepEqual(await tl(f.orca, { now }), answerN(2), 'same instant: not served from a failure');
  assert.equal(f.lists(), 2);
  assert.deepEqual(await tl(f.orca, { now }), answerN(2));
  assert.equal(f.lists(), 2);
});

test('(c) a non-array terminals is never cached, and callers that waited on it all get that same outcome', async () => {
  for (const bad of [{}, { terminals: null }, { terminals: 'x' }, { terminals: { handle: 'a' } }]) {
    clearLiveCache();
    const gate = deferred();
    const f = listOrca(async () => { await gate.promise; return bad; });
    const waiting = [tl(f.orca, { now }), tl(f.orca, { now })];
    gate.resolve();
    const [a, b] = await Promise.all(waiting);
    assert.deepEqual(a, bad.terminals, JSON.stringify(bad));
    assert.deepEqual(b, bad.terminals, JSON.stringify(bad));
    assert.equal(f.lists(), 1);
    assert.deepEqual(await tl(f.orca, { now }), bad.terminals);
    assert.equal(f.lists(), 2, 'not cached');
  }
  const f = listOrca((n) => (n === 1 ? {} : { terminals: answerN(n) }));
  await tl(f.orca, { now });
  assert.deepEqual(await tl(f.orca, { now }), answerN(2), 'the next good answer is the one that gets cached');
  assert.deepEqual(await tl(f.orca, { now }), answerN(2));
  assert.equal(f.lists(), 2);
});

// ---------- (d) module-level, cleared ----------
test('(d) a list read through one orca function is never answered to a caller of another one; a primed list without an orca serves any', async () => {
  const f = listOrca();
  const g = listOrca();
  await tl(f.orca, { now });
  assert.deepEqual(await tl(g.orca, { now }), answerN(1));
  assert.equal(g.lists(), 1, 'the other orca lists on its own');
  clearLiveCache();
  prime([{ handle: 'p' }], { now });
  assert.deepEqual(await tl(f.orca, { now }), [{ handle: 'p' }]);
  assert.equal(f.lists(), 1, 'no new call: the primed list serves it');
});

test('(d) clearLiveCache empties the shared list and zeroes listHits and listMisses; the next call lists again', async () => {
  const f = listOrca();
  await tl(f.orca, { now });
  await tl(f.orca, { now });
  assert.deepEqual([liveCacheStats().listHits, liveCacheStats().listMisses], [1, 1]);
  assert.equal(clearLiveCache(), undefined);
  assert.deepEqual(liveCacheStats(), { hits: 0, misses: 0, size: 0, listHits: 0, listMisses: 0 });
  assert.deepEqual(await tl(f.orca, { now }), answerN(2));
  assert.equal(f.lists(), 2);
});

// ---------- (e) counters ----------
test('(e) the counters are exact: misses are orca calls (failed ones too), hits are callers answered without a call, and they stay apart from hits/misses/size', async () => {
  let fail = false;
  const f = listOrca((n) => { if (fail) throw new Error('down'); return { terminals: answerN(n) }; });
  clock = 0;
  await tl(f.orca, { now });
  clock = 999;
  await tl(f.orca, { now });
  await tl(f.orca, { now });
  assert.deepEqual(liveCacheStats(), { hits: 0, misses: 0, size: 0, listHits: 2, listMisses: 1 });
  clock = 1000;
  await tl(f.orca, { now });
  fail = true;
  clock = 2000;
  await assert.rejects(tl(f.orca, { now }));
  assert.deepEqual(liveCacheStats(), { hits: 0, misses: 0, size: 0, listHits: 2, listMisses: 3 });
  const g = fakeOrca(idleWorld());
  await scanSessions(repoDir, g.orca, [{ handle: 't1', worktreePath: repoDir, connected: true, writable: true, lastOutputAt: 5 }], false, true, { cached: true, now });
  assert.deepEqual(liveCacheStats(), { hits: 0, misses: 1, size: 1, listHits: 2, listMisses: 3 }, 'the terminal counters do not touch the list ones');
});

// ---------- the answer is not shared mutably ----------
test('mutating what a caller got changes neither the next answer nor what a caller that shared the flight got', async () => {
  const gate = deferred();
  const f = listOrca(async (n) => { await gate.promise; return { terminals: answerN(n) }; });
  const [a, b] = [tl(f.orca, { now }), tl(f.orca, { now })];
  gate.resolve();
  const [first, second] = await Promise.all([a, b]);
  const want = structuredClone(answerN(1));
  first[0].handle = 'hacked';
  first.push({ handle: 'x' });
  assert.deepEqual(second, want, 'the other waiter');
  second.length = 0;
  const third = await tl(f.orca, { now });
  assert.deepEqual(third, want, 'the cache');
  third[0].lastOutputAt = 99;
  assert.deepEqual(await tl(f.orca, { now }), want);
  assert.equal(f.lists(), 1);
});

// ---------- primeList ----------
test('primeList stores a list as the shared answer (no call), counts nothing, replaces the older one and ages from the moment it was primed', async () => {
  const f = listOrca();
  clock = 100;
  await tl(f.orca, { now });
  clock = 500;
  prime(answerN(77), { now });
  assert.deepEqual(liveCacheStats(), { hits: 0, misses: 0, size: 0, listHits: 0, listMisses: 1 });
  clock = 1499;
  assert.deepEqual(await tl(f.orca, { now }), answerN(77));
  assert.equal(f.lists(), 1);
  clock = 1500;
  assert.deepEqual(await tl(f.orca, { now }), answerN(2));
});

// ---------- piStatus and liveOf use it ----------
test('piStatus: two calls inside the second make ONE list call and one show; at 1000 ms it lists again and a bumped lastOutputAt is seen', async () => {
  const f = fakeOrca(idleWorld());
  assert.deepEqual(await piStatus(REPO, f.orca), { state: 'idle' });
  bump(f, WORKING);
  clock += 999;
  assert.deepEqual(await piStatus(REPO, f.orca), { state: 'idle' }, 'inside the TTL the list is the old one');
  assert.equal(f.lists(), 1);
  clock += 1;
  assert.deepEqual(await piStatus(REPO, f.orca), { state: 'busy' });
  assert.equal(f.lists(), 2);
  assert.equal(f.shows(), 2);
});

test('liveOf (sessionsState): two calls inside the second make ONE list call; a bump after the TTL is seen', async () => {
  const f = fakeOrca(idleWorld());
  assert.deepEqual((await S.sessionsState(REPO_ID, f.orca, sessionsBase)).live, { state: 'free', count: 1 });
  assert.deepEqual((await S.sessionsState(REPO_ID, f.orca, sessionsBase)).live, { state: 'free', count: 1 });
  assert.equal(f.lists(), 1);
  bump(f, WORKING);
  clock += 1000;
  assert.deepEqual((await S.sessionsState(REPO_ID, f.orca, sessionsBase)).live, { state: 'working', count: 1 });
  assert.equal(f.lists(), 2);
});

test('piStatus and liveOf share the same list; concurrent piStatus calls share one flight', async () => {
  const f = fakeOrca(idleWorld());
  await piStatus(REPO, f.orca);
  await S.sessionsState(REPO_ID, f.orca, sessionsBase);
  assert.equal(f.lists(), 1);
  clearLiveCache();
  let release;
  f.gate = new Promise((r) => { release = r; });
  const all = [piStatus(REPO, f.orca), piStatus(REPO, f.orca), S.sessionsState(REPO_ID, f.orca, sessionsBase)];
  await tick();
  release();
  const [a, b, c] = await Promise.all(all);
  assert.deepEqual([a, b, c.live], [{ state: 'idle' }, { state: 'idle' }, { state: 'free', count: 1 }]);
  assert.equal(f.lists(), 2, 'one before, one for the whole concurrent group');
});

test('piStatus: a failed list or a non-array terminals is unknown for everyone and is never cached', async () => {
  const f = fakeOrca(idleWorld());
  for (const mode of ['fail', 'nonarray']) {
    f.mode = mode;
    const before = f.lists();
    assert.deepEqual(await piStatus(REPO, f.orca), { state: 'unknown' }, mode);
    assert.deepEqual(await piStatus(REPO, f.orca), { state: 'unknown' }, mode);
    assert.equal(f.lists() - before, 2, mode);
  }
  f.mode = null;
  assert.deepEqual(await piStatus(REPO, f.orca), { state: 'idle' });
});

// ---------- the writers always list fresh, even with the shared list warm ----------
test('piSend, piSessions, the dialog answer and the chat send each make their own list call although the shared one is warm', async () => {
  const f = fakeOrca(idleWorld());
  await piStatus(REPO, f.orca);
  assert.equal(f.lists(), 1);
  assert.deepEqual(await piSend(REPO, 'flow-commit', f.orca, async () => {}), { sent: true, confirmed: true });
  assert.equal(f.lists(), 2, 'piSend');
  assert.equal(f.sends(), 1);
  await piSessions(REPO, f.orca);
  await piSessions(REPO, f.orca);
  assert.equal(f.lists(), 4, 'piSessions, twice');
  await assert.rejects(answerDialog(REPO_ID, { fingerprint: '0123456789abcdef', index: 0 }, { orca: f.orca, wait: async () => {}, now }), (e) => e.status === 409);
  assert.equal(f.lists(), 5, 'the dialog answer');
  writeConfig({ sessions: { [REPO_ID]: { id: 'sid-1', name: 'panel:demo', adoptedAt: '2026-10-30T10:00:00Z' } } });
  await assert.rejects(sendChat(REPO_ID, { text: 'hello' }, { orca: f.orca, wait: async () => {}, sessionsDir: sessionsBase, now }), (e) => e.status === 409);
  assert.equal(f.lists(), 6, 'the chat send');
  assert.equal(f.sends(), 1, 'nothing else was sent');
});

// ---------- the warmer ----------
const warmerFor = (f, folders = [repoDir]) => createWarmer({ listRepoFolders: () => folders, orca: f.orca, scan: scanSessions, setTimer: () => ({}), clearTimer: () => {}, log: () => {}, now });

test('the warmer primes the shared list: after one tick a piStatus call makes no list call and no show', async () => {
  const f = fakeOrca(idleWorld());
  await warmerFor(f).tick();
  assert.equal(f.lists(), 1);
  assert.equal(f.shows(), 1);
  assert.deepEqual(await piStatus(REPO, f.orca), { state: 'idle' });
  assert.deepEqual((await S.sessionsState(REPO_ID, f.orca, sessionsBase)).live, { state: 'free', count: 1 });
  assert.equal(f.lists(), 1);
  assert.equal(f.shows(), 1);
  assert.deepEqual([liveCacheStats().listHits, liveCacheStats().listMisses], [2, 0], 'priming is not a miss');
});

test('the warmer always lists fresh, even with the shared list warm, and its fresh list replaces the shared one', async () => {
  const f = fakeOrca(idleWorld());
  const w = warmerFor(f);
  await piStatus(REPO, f.orca);
  assert.equal(f.lists(), 1);
  bump(f, WORKING);
  clock += 10; // well inside the TTL of the status list
  await w.tick();
  assert.equal(f.lists(), 2, 'the tick did not use the shared list');
  assert.deepEqual(await piStatus(REPO, f.orca), { state: 'busy' });
  assert.equal(f.lists(), 2, 'and piStatus found the tick\'s list');
  await w.tick();
  assert.equal(f.lists(), 3, 'every tick lists');
});
