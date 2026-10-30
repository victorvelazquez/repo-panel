'use strict';
// RP77b (S68, S71, S72), the pure state and the warmer's publish. server/pi.js exports piStateOf(sessions, failed) -> { state, ask? } (exactly what
// piStatus answers: closed | idle | busy | asking | ambiguous | unknown); server/sessions.js exports liveFromSessions(sessions, failed) -> exactly
// what liveOf answers ({ state: none|free|working|waiting|unknown, count, dialog? }). createWarmer({ publish(id, { state, ask, live }) }) calls publish
// after each folder's cached scan, with id = lib.repoId(folder); intervalMs may be a function returning the next delay. Fake Orca, fake timers.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'rp77bw-'));
const sessionsBase = path.join(scratch, 'sessions');
const repoDir = path.join(scratch, 'Repo.One');
for (const d of [sessionsBase, repoDir]) fs.mkdirSync(d);
const configFile = path.join(scratch, 'config.json');
process.env.REPO_PANEL_CONFIG = configFile;
process.env.REPO_PANEL_SESSIONS_DIR = sessionsBase;
process.env.REPO_PANEL_CASES_FILE = 'off';
fs.writeFileSync(configFile, JSON.stringify({ port: 4310, groups: [{ name: 'G', repos: [{ path: repoDir }] }], rooms: [] }));
test.after(() => fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 5 }));

const lib = require('../lib.js');
const P = require('../server/pi.js');
const S = require('../server/sessions.js');
const { createWarmer } = require('../server/livewarm.js');

test.beforeEach(() => P.clearLiveCache());

const IDLE = '▎ ✿ waiting for input\n▎   type, or / for commands\n▎\n~\\proj (main) • panel:demo\n';
const WORKING = '▎ ❁ working…\n▎   type, or / for commands\n▎\n~\\proj (main) • panel:demo\n';
const NAV = '↑↓ navigate  enter select  escape/ctrl+c cancel';
const ASK_ROWS = ['earlier', '', 'Allow guarded git push?', 'git push origin demo-branch', '→ Yes', '  No', NAV, '', '─'.repeat(40), '', ''];
const ASK_PREVIEW = ASK_ROWS.filter((l) => l.trim()).slice(-6).join('\n');
const s = (state, extra = {}) => ({ handle: `h-${state}`, state, ...extra });
const DIALOG = { kind: 'select', title: 'Allow?', choices: ['Yes', 'No'] };

// ---------- piStateOf (point 1) ----------
test('piStateOf: no session is closed, or unknown when a read failed', () => {
  assert.deepEqual(P.piStateOf([], 0), { state: 'closed' });
  assert.deepEqual(P.piStateOf([], 1), { state: 'unknown' });
  assert.deepEqual(P.piStateOf([], 3), { state: 'unknown' });
});

test('piStateOf: one session is idle (typed too), busy or asking; `ask` only when asking and not empty', () => {
  assert.deepEqual(P.piStateOf([s('idle')], 0), { state: 'idle' });
  assert.deepEqual(P.piStateOf([s('typed')], 0), { state: 'idle' });
  assert.deepEqual(P.piStateOf([s('busy')], 0), { state: 'busy' });
  assert.deepEqual(P.piStateOf([s('asking', { ask: 'Allow guarded git push?' })], 0), { state: 'asking', ask: 'Allow guarded git push?' });
  assert.deepEqual(P.piStateOf([s('asking', { ask: '' })], 0), { state: 'asking' });
  assert.equal(Object.hasOwn(P.piStateOf([s('idle', { ask: 'stray' })], 0), 'ask'), false);
});

test('piStateOf: two or more sessions are ambiguous (no ask); a failed read does not change a state that was seen', () => {
  assert.deepEqual(P.piStateOf([s('idle'), s('idle')], 0), { state: 'ambiguous' });
  assert.deepEqual(P.piStateOf([s('asking', { ask: 'x' }), s('busy'), s('idle')], 0), { state: 'ambiguous' });
  assert.deepEqual(P.piStateOf([s('busy')], 2), { state: 'busy' });
  assert.deepEqual(P.piStateOf([s('idle'), s('idle')], 1), { state: 'ambiguous' });
});

test('piStateOf does not change its input', () => {
  const input = [s('asking', { ask: 'Q?', dialog: DIALOG })];
  const before = structuredClone(input);
  P.piStateOf(input, 0);
  assert.deepEqual(input, before);
});

// A fake Orca for the equivalence tests: world[handle] = { preview, rows?, showFails? }.
function fakeOrca(world) {
  return async (args) => {
    if (args[0] === 'list') return { terminals: Object.keys(world).map((handle, i) => ({ handle, worktreePath: repoDir, connected: true, writable: true, lastOutputAt: 100 + i })) };
    const t = world[args[2]];
    if (args[0] === 'show') { if (t.showFails) throw new Error('show failed'); return { terminal: { preview: t.preview } }; }
    if (args[0] === 'read') return { terminal: { handle: args[2], status: 'running', tail: t.rows || [] } };
    throw new Error(`unexpected ${args[0]}`);
  };
}
const WORLDS = {
  none: {},
  idle: { a: { preview: IDLE } },
  busy: { a: { preview: WORKING } },
  asking: { a: { preview: ASK_PREVIEW, rows: ASK_ROWS } },
  two: { a: { preview: IDLE }, b: { preview: WORKING } },
  failedOnly: { a: { showFails: true } },
  failedPlusIdle: { a: { showFails: true }, b: { preview: IDLE } },
};

test('piStatus answers exactly piStateOf of the scan it read, for every kind of folder', async () => {
  for (const [name, world] of Object.entries(WORLDS)) {
    P.clearLiveCache();
    const orca = fakeOrca(world);
    const listed = await P.listTerminals(orca);
    const { sessions, failed } = await P.scanSessions(repoDir, orca, listed, false, true, { cached: true });
    P.clearLiveCache();
    assert.deepEqual(await P.piStatus({ path: repoDir }, orca), P.piStateOf(sessions, failed), name);
  }
});

// ---------- liveFromSessions ----------
test('liveFromSessions: none, unknown (a failed read) and the count', () => {
  assert.deepEqual(S.liveFromSessions([], 0), { state: 'none', count: 0 });
  assert.deepEqual(S.liveFromSessions([], 2), { state: 'unknown', count: 0 });
  assert.deepEqual(S.liveFromSessions([s('idle'), s('idle')], 0), { state: 'free', count: 2 });
  assert.deepEqual(S.liveFromSessions([s('idle')], 4), { state: 'free', count: 1 });
});

test('liveFromSessions: idle and typed are free, busy is working, asking is waiting; the worst of several wins', () => {
  assert.deepEqual(S.liveFromSessions([s('typed')], 0), { state: 'free', count: 1 });
  assert.deepEqual(S.liveFromSessions([s('busy')], 0), { state: 'working', count: 1 });
  assert.deepEqual(S.liveFromSessions([s('weird')], 0), { state: 'free', count: 1 }, 'an unknown screen state counts as free, as liveOf does');
  assert.deepEqual(S.liveFromSessions([s('idle'), s('busy')], 0), { state: 'working', count: 2 });
  assert.deepEqual(S.liveFromSessions([s('busy'), s('asking'), s('idle')], 0), { state: 'waiting', count: 3 });
});

test('liveFromSessions: the dialog only when ONE session is waiting and it has one', () => {
  assert.deepEqual(S.liveFromSessions([s('asking', { ask: 'Q?', dialog: DIALOG })], 0), { state: 'waiting', count: 1, dialog: DIALOG });
  assert.deepEqual(S.liveFromSessions([s('asking', { ask: 'Q?' })], 0), { state: 'waiting', count: 1 });
  assert.deepEqual(S.liveFromSessions([s('asking', { dialog: DIALOG }), s('idle')], 0), { state: 'waiting', count: 2 });
});

test('sessionsState().live is exactly liveFromSessions of the scan, for every kind of folder', async () => {
  const id = lib.repoId(repoDir);
  for (const [name, world] of Object.entries(WORLDS)) {
    P.clearLiveCache();
    const orca = fakeOrca(world);
    const listed = await P.listTerminals(orca);
    const { sessions, failed } = await P.scanSessions(repoDir, orca, listed, false, true, { cached: true });
    P.clearLiveCache();
    assert.deepEqual((await S.sessionsState(id, orca, sessionsBase)).live, S.liveFromSessions(sessions, failed), name);
  }
});

// ---------- the warmer: publish and a variable interval (point 3) ----------
function fakeTimers() {
  const t = { pending: null, set: [], cleared: 0 };
  t.setTimer = (fn, ms) => { const h = { fn, ms, unref() { return h; } }; t.pending = h; t.set.push(ms); return h; };
  t.clearTimer = (h) => { t.cleared++; if (t.pending === h) t.pending = null; };
  t.fire = async () => { const h = t.pending; t.pending = null; await h.fn(); };
  return t;
}
// `scans[folder]` is the { sessions, failed } of that folder, or an Error to throw.
function make({ folders = ['C:/a', 'C:/b'], scans = {}, ...over } = {}) {
  const log = [];
  const timers = fakeTimers();
  const w = createWarmer({
    listRepoFolders: () => folders,
    orca: async (args) => { log.push(`orca ${args.join(' ')}`); return { terminals: [{ handle: 't1' }] }; },
    scan: async (folder) => { log.push(`scan ${folder}`); const r = scans[folder] || { sessions: [], failed: 0 }; if (r instanceof Error) throw r; return r; },
    publish: (id, payload) => log.push({ publish: id, payload: JSON.parse(JSON.stringify(payload)) }),
    setTimer: timers.setTimer, clearTimer: timers.clearTimer, log: () => {}, now: () => 1000, ...over,
  });
  return { w, log, timers };
}
const published = (log) => log.filter((e) => typeof e === 'object');

test('tick: publishes once per folder, right after ITS scan, with id = lib.repoId(folder) (lower-cased by repoId)', async () => {
  const { w, log } = make({ folders: ['C:/Work/Repo-A', 'D:/Other'] });
  await w.tick();
  assert.equal(log[0], 'orca list');
  assert.equal(log[1], 'scan C:/Work/Repo-A');
  assert.equal(log[2].publish, lib.repoId('C:/Work/Repo-A'));
  assert.equal(log[3], 'scan D:/Other');
  assert.equal(log[4].publish, lib.repoId('D:/Other'));
  assert.equal(log.length, 5);
});

test('tick: the payload is { state, ask, live } built from the SAME { sessions, failed } the scan returned', async () => {
  const asking = { sessions: [s('asking', { ask: 'Allow guarded git push?', dialog: DIALOG })], failed: 0 };
  const { w, log } = make({ folders: ['C:/a', 'C:/b', 'C:/c', 'C:/d', 'C:/e'], scans: {
    'C:/a': { sessions: [s('idle')], failed: 0 },
    'C:/b': asking,
    'C:/c': { sessions: [], failed: 1 },
    'C:/d': { sessions: [], failed: 0 },
    'C:/e': { sessions: [s('busy'), s('idle')], failed: 0 },
  } });
  await w.tick();
  const by = Object.fromEntries(published(log).map((e) => [e.publish, e.payload]));
  assert.deepEqual(by[lib.repoId('C:/a')], { state: 'idle', live: { state: 'free', count: 1 } });
  assert.deepEqual(by[lib.repoId('C:/b')], { state: 'asking', ask: 'Allow guarded git push?', live: { state: 'waiting', count: 1, dialog: DIALOG } });
  assert.deepEqual(by[lib.repoId('C:/c')], { state: 'unknown', live: { state: 'unknown', count: 0 } });
  assert.deepEqual(by[lib.repoId('C:/d')], { state: 'closed', live: { state: 'none', count: 0 } });
  assert.deepEqual(by[lib.repoId('C:/e')], { state: 'ambiguous', live: { state: 'working', count: 2 } });
  assert.equal(published(log).length, 5);
});

test('tick: the payload agrees with piStateOf and liveFromSessions for the same scan', async () => {
  const scan = { sessions: [s('asking', { ask: 'Q?', dialog: DIALOG })], failed: 1 };
  const { w, log } = make({ folders: ['C:/a'], scans: { 'C:/a': scan } });
  await w.tick();
  const { ask, ...rest } = published(log)[0].payload;
  assert.deepEqual({ ...rest, ...(ask ? { ask } : {}) }, { ...P.piStateOf(scan.sessions, scan.failed), live: S.liveFromSessions(scan.sessions, scan.failed) });
});

test('tick: a scan that throws publishes nothing for that folder; the others are still published', async () => {
  const { w, log } = make({ folders: ['C:/a', 'C:/b', 'C:/c'], scans: { 'C:/b': new Error('boom') } });
  await w.tick();
  assert.deepEqual(published(log).map((e) => e.publish), [lib.repoId('C:/a'), lib.repoId('C:/c')]);
});

test('tick: nothing is published without folders, or when Orca cannot be listed', async () => {
  const none = make({ folders: [] });
  await none.w.tick();
  assert.deepEqual(none.log, []);
  const bad = make({ orca: async () => { throw new Error('orca is down'); } });
  await bad.w.tick();
  assert.deepEqual(published(bad.log), []);
  const noList = make({ orca: async () => ({}) });
  await noList.w.tick();
  assert.deepEqual(published(noList.log), []);
});

test('tick: a duplicated folder is scanned and published once; without a publish option the warmer still works', async () => {
  const { w, log } = make({ folders: ['C:/a', 'c:\\a'] });
  await w.tick();
  assert.equal(published(log).length, 1);
  const quiet = make({ publish: undefined });
  await assert.doesNotReject(quiet.w.tick());
  assert.deepEqual(quiet.log.filter((e) => typeof e === 'string'), ['orca list', 'scan C:/a', 'scan C:/b']);
});

test('intervalMs as a function: asked each time the warmer re-arms, never for the first delay', async () => {
  const delays = [1000, 3000, 1000];
  let asked = 0;
  const { w, timers } = make({ intervalMs: () => delays[asked++] });
  w.start();
  assert.deepEqual(timers.set, [1000], 'the first delay is the fixed 1000');
  assert.equal(asked, 0);
  await timers.fire();
  assert.deepEqual(timers.set, [1000, 1000]);
  await timers.fire();
  assert.deepEqual(timers.set, [1000, 1000, 3000]);
  await timers.fire();
  assert.deepEqual(timers.set, [1000, 1000, 3000, 1000]);
  assert.equal(asked, 3);
  w.stop();
  assert.equal(timers.pending, null);
});

test('intervalMs as a number keeps working as before; after stop nothing is asked or armed', async () => {
  const num = make({ intervalMs: 2500 });
  num.w.start();
  await num.timers.fire();
  assert.deepEqual(num.timers.set, [1000, 2500]);
  let asked = 0;
  const fn = make({ intervalMs: () => { asked++; return 4000; } });
  fn.w.start();
  const firing = fn.timers.fire();
  fn.w.stop();
  await firing;
  assert.equal(fn.timers.set.length, 1, 'stopped during the tick: no re-arm');
  assert.equal(asked, 0);
});

// ---------- verification probe: the wiring of server.js (it only runs as a program, so it is pinned by its text) ----------
test('server.js wires the warmer to 1 s while someone listens and to the idle interval otherwise (S68)', () => {
  const src = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'server.js'), 'utf8');
  assert.match(src, /intervalMs: \(\) => \(server\.hub\.size\(\) > 0 \? 1000 : warm\)/);
  assert.match(src, /publish: \(id, payload\) => server\.hub\.publish\(id, payload\)/);
});
