'use strict';
// RP77 (S68, S71), the live cache: `scanSessions(folder, orca, listed, withPreview, askAware, opts)` takes a 6th optional argument
// `opts = { cached: false, now: Date.now }`. Without it nothing changes (one `show` per terminal, every time). With `cached: true` AND a
// `listed` array, a terminal whose `lastOutputAt` (a finite number) equals the cached one, whose cached read did not fail and did not read
// 'asking', and whose entry is younger than 30000 ms, is answered with NO orca call. The entry is keyed `${handle}|${withPreview}|${askAware}`,
// holds the whole per-terminal result and a terminal missing in `listed` is dropped. `clearLiveCache()` empties it. The read-only callers
// (liveOf, sessionState, piStatus) opt in; the writers (piSend, the dialog answer, the chat send) read fresh. The real Orca, the real config
// and the real sessions are never touched: a fake Orca counting every call, temp dirs and an injected clock (no real waiting).
const test = require('node:test');
const { mock } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'rp77c-'));
const sessionsBase = path.join(scratch, 'sessions');
const repoDir = path.join(scratch, 'My Repo.Api');
const otherDir = path.join(scratch, 'Other Repo');
for (const d of [sessionsBase, repoDir, otherDir]) fs.mkdirSync(d);
const configFile = path.join(scratch, 'config.json');
process.env.REPO_PANEL_CONFIG = configFile;
process.env.REPO_PANEL_SESSIONS_DIR = sessionsBase;
process.env.REPO_PANEL_CASES_FILE = 'off';
test.after(() => fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 5 }));

const lib = require('../lib.js');
const S = require('../server/sessions.js');
const P = require('../server/pi.js');
const { summaryFor } = require('../server/summary.js');
const { answerDialog } = require('../server/dialoganswer.js');
const { sendChat } = require('../server/chatsend.js');
const { scanSessions, piStatus, piSend, piSessions, clearLiveCache } = P;

const REPO_ID = lib.repoId(repoDir);
const REPO = { path: repoDir };
const writeConfig = (extra = {}) => fs.writeFileSync(configFile, JSON.stringify({ port: 4310, groups: [{ name: 'G', repos: [{ path: repoDir }] }], rooms: [], ...extra }));
writeConfig();

// ---------- fixtures ----------
const NAV = '↑↓ navigate  enter select  escape/ctrl+c cancel';
const IDLE = '▎ ✿ waiting for input\n▎   type, or / for commands\n▎\n~\\proj (main) • panel:demo\n';
const TYPED = '▎ ✿ waiting for input\n▎   half a sentence\n▎\n~\\proj (main) • panel:demo\n';
const WORKING = '▎ ❁ working…\n▎   type, or / for commands\n▎\n~\\proj (main) • panel:demo\n';
const SHELL = 'PS C:\\proj> git status\nOn branch main\nPS C:\\proj>';
const ASK_ROWS = ['earlier conversation', '', 'Allow guarded git push?', 'git push origin demo-branch', '→ Yes', '  No', NAV, '', '─'.repeat(40), '', ''];
const ASK_PREVIEW = ASK_ROWS.filter((l) => l.trim()).slice(-6).join('\n');

// A fake Orca recording every call. `world[handle]` = { preview, rows, lastOutputAt?, dir?, showFails?, readFails? }. The `lastOutputAt` key is
// listed only when the terminal object has it (so absent / NaN / string / null can be told apart). `listed()` is what `list` answers, as a plain
// array a test can hand to scanSessions. A `send` makes every `show` answer WORKING from then on (only the piSend test sends).
function fakeOrca(world) {
  const calls = [];
  let sent = false;
  const listed = () => Object.keys(world).map((handle) => ({
    handle, worktreePath: world[handle].dir || repoDir, connected: true, writable: true,
    ...('lastOutputAt' in world[handle] ? { lastOutputAt: world[handle].lastOutputAt } : {}),
  }));
  const orca = async (args) => {
    calls.push(args);
    if (args[0] === 'list') return { terminals: listed() };
    const t = world[args[2]];
    if (args[0] === 'show') { if (t.showFails) throw new Error('show failed'); return { terminal: { preview: sent ? WORKING : t.preview } }; }
    if (args[0] === 'read') { if (t.readFails) throw new Error('read failed'); return { terminal: { handle: args[2], status: 'running', tail: t.rows } }; }
    if (args[0] === 'send') { sent = true; return {}; }
    throw new Error(`unexpected ${args[0]}`);
  };
  const count = (verb) => calls.filter((c) => c[0] === verb).length;
  return { orca, calls, listed, world, shows: () => count('show'), reads: () => count('read'), lists: () => count('list'), sends: () => count('send') };
}
const term = (preview, lastOutputAt, extra = {}) => ({ preview, rows: [], ...(lastOutputAt === undefined ? {} : { lastOutputAt }), ...extra });
const asking = (lastOutputAt) => term(ASK_PREVIEW, lastOutputAt, { rows: ASK_ROWS });

let clock = 0;
const now = () => clock;
const CACHED = { cached: true, now };
const scan = (f, ...rest) => scanSessions(repoDir, f.orca, f.listed(), ...rest);
// What an uncached scan of the same world answers (a fresh fake with the same terminals: never touches the cache).
const fresh = (f, withPreview = false, askAware = true, folder = repoDir) => scanSessions(folder, f.orca, f.listed(), withPreview, askAware);

// Tolerant on purpose: before RP77 exists the hook must not fail every test for one reason.
test.afterEach(() => mock.restoreAll());
test.beforeEach(() => { if (typeof clearLiveCache === 'function') clearLiveCache(); clock = 1000; writeConfig(); });

// ---------- 1. the default is unchanged ----------
test('clearLiveCache is exported and returns nothing', () => {
  assert.equal(typeof clearLiveCache, 'function');
  assert.equal(clearLiveCache(), undefined);
});

test('without opts, or with cached false / {} , every scan makes one show per terminal and nothing is cached', async () => {
  const f = fakeOrca({ t1: term(IDLE, 5), t2: term(WORKING, 6) });
  for (const opts of [undefined, {}, { cached: false }, { cached: false, now }]) {
    const before = f.shows();
    const a = opts === undefined ? await scan(f, false, true) : await scan(f, false, true, opts);
    const b = opts === undefined ? await scan(f, false, true) : await scan(f, false, true, opts);
    assert.equal(f.shows() - before, 4, JSON.stringify(opts));
    assert.deepEqual(a, { sessions: [{ handle: 't1', state: 'idle' }, { handle: 't2', state: 'busy' }], failed: 0 });
    assert.deepEqual(b, a);
  }
  assert.equal(f.lists(), 0, 'a supplied list is never fetched again');
});

test('a cached scan WITHOUT a listed array fetches its own list and reads every terminal each time', async () => {
  const f = fakeOrca({ t1: term(IDLE, 5) });
  const a = await scanSessions(repoDir, f.orca, undefined, false, true, CACHED);
  const b = await scanSessions(repoDir, f.orca, undefined, false, true, CACHED);
  assert.deepEqual(f.calls.map((c) => c[0]), ['list', 'show', 'list', 'show']);
  assert.deepEqual(a, b);
  // and it did not fill the cache either: a later cached scan with a list still has to read
  await scan(f, false, true, CACHED);
  assert.equal(f.shows(), 3);
});

// ---------- 2. hits ----------
test('cached + listed: the second scan makes NO orca call and answers the same; a fresh uncached scan agrees', async () => {
  const f = fakeOrca({ t1: term(IDLE, 5) });
  const first = await scan(f, false, true, CACHED);
  assert.deepEqual(f.calls.map((c) => c[0]), ['show']);
  const second = await scan(f, false, true, CACHED);
  assert.deepEqual(f.calls.map((c) => c[0]), ['show'], 'no call at all');
  assert.deepEqual(first, { sessions: [{ handle: 't1', state: 'idle' }], failed: 0 });
  assert.deepEqual(second, first);
  assert.deepEqual(await fresh(f), first);
});

test('only the terminal whose lastOutputAt changed is read again; the others come from the cache', async () => {
  const f = fakeOrca({ t1: term(IDLE, 5), t2: term(IDLE, 7) });
  await scan(f, false, true, CACHED);
  f.world.t2.lastOutputAt = 8;
  f.world.t2.preview = WORKING;
  const out = await scan(f, false, true, CACHED);
  assert.equal(f.shows(), 3);
  assert.deepEqual(f.calls.slice(2), [['show', '--terminal', 't2']]);
  assert.deepEqual(out, { sessions: [{ handle: 't1', state: 'idle' }, { handle: 't2', state: 'busy' }], failed: 0 });
});

test('lastOutputAt: equal hits; different in either direction reads again and the new value is what gets cached', async () => {
  const f = fakeOrca({ t1: term(IDLE, 5) });
  await scan(f, false, true, CACHED);
  await scan(f, false, true, CACHED);
  assert.equal(f.shows(), 1);
  f.world.t1.lastOutputAt = 6; f.world.t1.preview = WORKING;
  assert.deepEqual((await scan(f, false, true, CACHED)).sessions, [{ handle: 't1', state: 'busy' }]);
  assert.equal(f.shows(), 2);
  assert.deepEqual((await scan(f, false, true, CACHED)).sessions, [{ handle: 't1', state: 'busy' }]);
  assert.equal(f.shows(), 2);
  f.world.t1.lastOutputAt = 5; f.world.t1.preview = IDLE; // going back is a change too
  assert.deepEqual((await scan(f, false, true, CACHED)).sessions, [{ handle: 't1', state: 'idle' }]);
  assert.equal(f.shows(), 3);
});

test('0 and a negative number are finite: they are cached', async () => {
  for (const at of [0, -3, 1.5]) {
    clearLiveCache();
    const f = fakeOrca({ t1: term(IDLE, at) });
    await scan(f, false, true, CACHED);
    await scan(f, false, true, CACHED);
    assert.equal(f.shows(), 1, String(at));
  }
});

test('lastOutputAt missing, NaN, Infinity, null, undefined or a string: never cached, even when the same value repeats', async () => {
  const bad = [['absent', undefined], ['NaN', NaN], ['Infinity', Infinity], ['-Infinity', -Infinity], ['null', null], ['string', '5'], ['numeric string', '1000'], ['object', {}]];
  for (const [name, at] of bad) {
    clearLiveCache();
    const world = { t1: term(IDLE, at) };
    if (name === 'absent') delete world.t1.lastOutputAt;
    if (name === 'undefined') world.t1.lastOutputAt = undefined;
    const f = fakeOrca(world);
    const a = await scan(f, false, true, CACHED);
    const b = await scan(f, false, true, CACHED);
    assert.equal(f.shows(), 2, name);
    assert.deepEqual(a, { sessions: [{ handle: 't1', state: 'idle' }], failed: 0 }, name);
    assert.deepEqual(b, a, name);
  }
  clearLiveCache();
  const f = fakeOrca({ t1: { preview: IDLE, rows: [], lastOutputAt: undefined } });
  await scan(f, false, true, CACHED);
  await scan(f, false, true, CACHED);
  assert.equal(f.shows(), 2, 'undefined value');
});

test('a number that was cached and then becomes a string / NaN / missing is read again', async () => {
  for (const next of ['5', NaN, undefined]) {
    clearLiveCache();
    const f = fakeOrca({ t1: term(IDLE, 5) });
    await scan(f, false, true, CACHED);
    if (next === undefined) delete f.world.t1.lastOutputAt; else f.world.t1.lastOutputAt = next;
    await scan(f, false, true, CACHED);
    assert.equal(f.shows(), 2, String(next));
  }
});

// ---------- 3. age ----------
for (const [age, hit] of [[0, true], [1, true], [29999, true], [30000, false], [30001, false], [120000, false]]) {
  test(`age ${age} ms: ${hit ? 'answered from the cache' : 'read again'}`, async () => {
    const f = fakeOrca({ t1: term(IDLE, 5) });
    clock = 1000;
    await scan(f, false, true, CACHED);
    clock = 1000 + age;
    const out = await scan(f, false, true, CACHED);
    assert.equal(f.shows(), hit ? 1 : 2);
    assert.deepEqual(out, { sessions: [{ handle: 't1', state: 'idle' }], failed: 0 });
  });
}

test('a hit does not renew the entry: it expires 30000 ms after it was STORED; a re-read stores it again with the new time', async () => {
  const f = fakeOrca({ t1: term(IDLE, 5) });
  clock = 1000;
  await scan(f, false, true, CACHED);
  clock = 1000 + 29999;
  await scan(f, false, true, CACHED);
  assert.equal(f.shows(), 1);
  clock = 1000 + 30000;
  await scan(f, false, true, CACHED);
  assert.equal(f.shows(), 2, 'old by its original time');
  clock = 1000 + 30000 + 29999;
  await scan(f, false, true, CACHED);
  assert.equal(f.shows(), 2, 'young again from the second store');
  clock = 1000 + 30000 + 30000;
  await scan(f, false, true, CACHED);
  assert.equal(f.shows(), 3);
});

test('the age is measured with opts.now, not the real clock; without opts.now the real clock is used', async () => {
  const f = fakeOrca({ t1: term(IDLE, 5) });
  clock = 1e12;
  await scan(f, false, true, CACHED);
  clock = 5; // the clock going backwards is not an old entry
  await scan(f, false, true, CACHED);
  assert.equal(f.shows(), 1);
  const g = fakeOrca({ t1: term(IDLE, 9) });
  await scan(g, false, true, { cached: true });
  await scan(g, false, true, { cached: true });
  assert.equal(g.shows(), 1);
});

// ---------- 4. failures are never stored ----------
test('a failed show is never stored: failed 1, then a good read, then a hit', async () => {
  const f = fakeOrca({ t1: term(IDLE, 5, { showFails: true }) });
  assert.deepEqual(await scan(f, false, true, CACHED), { sessions: [], failed: 1 });
  assert.deepEqual(await scan(f, false, true, CACHED), { sessions: [], failed: 1 });
  assert.equal(f.shows(), 2, 'a failure is read again');
  f.world.t1.showFails = false;
  assert.deepEqual(await scan(f, false, true, CACHED), { sessions: [{ handle: 't1', state: 'idle' }], failed: 0 });
  assert.equal(f.shows(), 3);
  assert.deepEqual(await scan(f, false, true, CACHED), { sessions: [{ handle: 't1', state: 'idle' }], failed: 0 });
  assert.equal(f.shows(), 3);
});

test('a read that fails after a good one (new lastOutputAt) is reported failed, and the next scan reads it again', async () => {
  const f = fakeOrca({ t1: term(IDLE, 5), t2: term(IDLE, 5) });
  await scan(f, false, true, CACHED);
  f.world.t1.lastOutputAt = 6; f.world.t1.showFails = true;
  assert.deepEqual(await scan(f, false, true, CACHED), { sessions: [{ handle: 't2', state: 'idle' }], failed: 1 });
  assert.equal(f.shows(), 3, 't2 came from the cache');
  f.world.t1.showFails = false;
  assert.deepEqual(await scan(f, false, true, CACHED), { sessions: [{ handle: 't1', state: 'idle' }, { handle: 't2', state: 'idle' }], failed: 0 });
  assert.equal(f.shows(), 4);
});

test('a terminal that is not a pi screen (state null) is cached like any other and stays out of sessions', async () => {
  const f = fakeOrca({ t1: term(SHELL, 5), t2: term(IDLE, 5) });
  const a = await scan(f, false, true, CACHED);
  const b = await scan(f, false, true, CACHED);
  assert.equal(f.shows(), 2);
  assert.deepEqual(a, { sessions: [{ handle: 't2', state: 'idle' }], failed: 0 });
  assert.deepEqual(b, a);
});

// ---------- 5. asking terminals ----------
test('an asking terminal is re-read every scan (show + read), with the same dialog each time', async () => {
  const f = fakeOrca({ t1: asking(5) });
  const a = await scan(f, false, true, CACHED);
  const b = await scan(f, false, true, CACHED);
  const c = await scan(f, false, true, CACHED);
  assert.equal(f.shows(), 3);
  assert.equal(f.reads(), 3);
  assert.equal(a.sessions[0].state, 'asking');
  assert.ok(a.sessions[0].dialog && a.sessions[0].dialog.lines.includes('Allow guarded git push?'));
  assert.deepEqual(b, a);
  assert.deepEqual(c, a);
  assert.deepEqual(await fresh(f), a);
});

test('an asking terminal that stops asking is reported as it is now, even with the same lastOutputAt as before the question', async () => {
  const f = fakeOrca({ t1: asking(5), t2: term(IDLE, 5) });
  await scan(f, false, true, CACHED);
  f.world.t1.preview = WORKING;
  const out = await scan(f, false, true, CACHED);
  assert.deepEqual(out.sessions.find((s) => s.handle === 't1'), { handle: 't1', state: 'busy' });
});

test('askAware false: an asking screen is "busy" and cacheable; a later askAware scan is another key and reads the dialog', async () => {
  const f = fakeOrca({ t1: asking(5) });
  const a = await scan(f, false, false, CACHED);
  const b = await scan(f, false, false, CACHED);
  assert.deepEqual(a, { sessions: [{ handle: 't1', state: 'busy' }], failed: 0 });
  assert.deepEqual(b, a);
  assert.equal(f.shows(), 1);
  assert.equal(f.reads(), 0);
  const c = await scan(f, false, true, CACHED);
  assert.equal(f.shows(), 2);
  assert.equal(f.reads(), 1);
  assert.equal(c.sessions[0].state, 'asking');
});

// ---------- 6. the flags are part of the key ----------
test('withPreview and askAware are part of the key: each combination is read once, then served, and always equals the uncached answer', async () => {
  const f = fakeOrca({ t1: term(WORKING, 5) });
  const combos = [[false, true], [true, true], [false, false], [true, false]];
  const expected = {};
  for (const [p, a] of combos) expected[`${p}|${a}`] = await fresh(f, p, a);
  const base = f.shows();
  for (let round = 0; round < 2; round++) {
    for (const [p, a] of combos) assert.deepEqual(await scan(f, p, a, CACHED), expected[`${p}|${a}`], `${p}|${a} round ${round}`);
    assert.equal(f.shows() - base, 4, `round ${round}: four reads, none after`);
  }
  assert.deepEqual(expected['true|true'], { sessions: [{ handle: 't1', state: 'busy', preview: WORKING }], failed: 0 });
  assert.deepEqual(expected['false|true'], { sessions: [{ handle: 't1', state: 'busy' }], failed: 0 });
});

test('a withPreview hit carries the preview of the terminal as it was read', async () => {
  const f = fakeOrca({ t1: term(IDLE, 5) });
  const a = await scan(f, true, true, CACHED);
  f.world.t1.preview = WORKING; // changes the screen but NOT lastOutputAt: the cache answers what it stored
  const b = await scan(f, true, true, CACHED);
  assert.deepEqual(a, { sessions: [{ handle: 't1', state: 'idle', preview: IDLE }], failed: 0 });
  assert.deepEqual(b, a);
});

// ---------- 7. dropping, scoping, aliasing, clearing ----------
test('a terminal missing in listed is dropped from the cache on that scan: it is read again when it comes back', async () => {
  const f = fakeOrca({ t1: term(IDLE, 5), t2: term(IDLE, 5) });
  await scan(f, false, true, CACHED);
  assert.equal(f.shows(), 2);
  const onlyT1 = f.listed().filter((t) => t.handle === 't1');
  assert.deepEqual(await scanSessions(repoDir, f.orca, onlyT1, false, true, CACHED), { sessions: [{ handle: 't1', state: 'idle' }], failed: 0 });
  assert.equal(f.shows(), 2, 't1 came from the cache');
  await scan(f, false, true, CACHED);
  assert.equal(f.shows(), 3, 'only t2 was read again');
  assert.deepEqual(f.calls[2], ['show', '--terminal', 't2']);
});

test('an empty listed drops everything, answers an empty scan with no call, and the cache refills afterwards', async () => {
  const f = fakeOrca({ t1: term(IDLE, 5) });
  await scan(f, false, true, CACHED);
  assert.deepEqual(await scanSessions(repoDir, f.orca, [], false, true, CACHED), { sessions: [], failed: 0 });
  assert.equal(f.calls.length, 1);
  await scan(f, false, true, CACHED);
  assert.equal(f.shows(), 2);
});

test('scanning one folder does not drop the terminals of another one that are in the same listed array', async () => {
  const f = fakeOrca({ a1: term(IDLE, 5), b1: term(WORKING, 5, { dir: otherDir }) });
  const listed = f.listed();
  const a = await scanSessions(repoDir, f.orca, listed, false, true, CACHED);
  const b = await scanSessions(otherDir, f.orca, listed, false, true, CACHED);
  assert.deepEqual(a, { sessions: [{ handle: 'a1', state: 'idle' }], failed: 0 });
  assert.deepEqual(b, { sessions: [{ handle: 'b1', state: 'busy' }], failed: 0 });
  assert.equal(f.shows(), 2);
  assert.deepEqual(await scanSessions(repoDir, f.orca, listed, false, true, CACHED), a);
  assert.deepEqual(await scanSessions(otherDir, f.orca, listed, false, true, CACHED), b);
  assert.equal(f.shows(), 2, 'both folders served from the cache');
});

test('the cached answer is a copy: changing what a scan returned does not change the next answer', async () => {
  const f = fakeOrca({ t1: term(IDLE, 5) });
  const a = await scan(f, true, true, CACHED);
  a.sessions[0].state = 'hacked';
  a.sessions.push({ handle: 'x' });
  a.failed = 9;
  const b = await scan(f, true, true, CACHED);
  assert.deepEqual(b, { sessions: [{ handle: 't1', state: 'idle', preview: IDLE }], failed: 0 });
  b.sessions[0].preview = 'changed';
  assert.deepEqual(await scan(f, true, true, CACHED), { sessions: [{ handle: 't1', state: 'idle', preview: IDLE }], failed: 0 });
  assert.equal(f.shows(), 1);
});

test('clearLiveCache empties it: the next cached scan reads again', async () => {
  const f = fakeOrca({ t1: term(IDLE, 5) });
  await scan(f, false, true, CACHED);
  clearLiveCache();
  await scan(f, false, true, CACHED);
  assert.equal(f.shows(), 2);
});

test('every state answers the same cached or not: idle, typed, busy, not-a-session, asking, with and without preview', async () => {
  const f = fakeOrca({ i: term(IDLE, 1), t: term(TYPED, 2), b: term(WORKING, 3), s: term(SHELL, 4), q: asking(5) });
  for (const [p, a] of [[false, true], [true, true], [false, false], [true, false]]) {
    const want = await fresh(f, p, a);
    assert.deepEqual(await scan(f, p, a, CACHED), want, `miss ${p}|${a}`);
    assert.deepEqual(await scan(f, p, a, CACHED), want, `hit ${p}|${a}`);
  }
});

// ---------- 8. the read-only readers use the cache ----------
const showsOf = (f, from = 0) => f.calls.slice(from).filter((c) => c[0] === 'show').length;

test('sessionsState (liveOf): the second call makes no show; a bumped lastOutputAt re-reads and reports the new state', async () => {
  mock.method(Date, 'now', () => clock); // the shared list ages with this clock
  const f = fakeOrca({ t1: term(IDLE, 5) });
  const a = await S.sessionsState(REPO_ID, f.orca, sessionsBase);
  assert.deepEqual(a.live, { state: 'free', count: 1 });
  assert.equal(f.shows(), 1);
  const b = await S.sessionsState(REPO_ID, f.orca, sessionsBase);
  assert.deepEqual(b.live, { state: 'free', count: 1 });
  assert.equal(f.shows(), 1);
  assert.equal(f.lists(), 1, 'the second call shares the list read a moment ago');
  clock += 2000; // the shared list is a second old
  f.world.t1.lastOutputAt = 6; f.world.t1.preview = WORKING;
  assert.deepEqual((await S.sessionsState(REPO_ID, f.orca, sessionsBase)).live, { state: 'working', count: 1 });
  assert.equal(f.shows(), 2);
  assert.equal(f.lists(), 2);
});

test('sessionsState: an asking session is read on every call (show + read) and keeps its dialog', async () => {
  const f = fakeOrca({ t1: asking(5) });
  const a = (await S.sessionsState(REPO_ID, f.orca, sessionsBase)).live;
  const b = (await S.sessionsState(REPO_ID, f.orca, sessionsBase)).live;
  assert.equal(a.state, 'waiting');
  assert.deepEqual(a, { state: 'waiting', count: 1, dialog: a.dialog });
  assert.ok(a.dialog.lines.includes('Allow guarded git push?'));
  assert.deepEqual(b, a);
  assert.equal(f.shows(), 2);
  assert.equal(f.reads(), 2);
});

const summaryDeps = (f) => ({
  orca: f.orca,
  prs: async () => ({ prs: [], stale: null }),
  local: async () => ({ branch: 'main', files: [], ahead: 0, behind: 0, base: 'main' }),
  roadmap: async () => ({ available: false, reason: 'missing' }),
  state: async () => ({ available: false }),
  git: async () => ({ code: 1, stdout: '', stderr: '' }),
});

test('summaryFor (sessionState): the second build makes no show; a bumped lastOutputAt re-reads and the row shows the new state', async () => {
  const f = fakeOrca({ t1: term(IDLE, 5) });
  const deps = summaryDeps(f);
  const a = await summaryFor(deps, { fresh: '1' });
  assert.equal(a.rows.length, 1);
  assert.deepEqual(a.rows[0].session, { state: 'free' });
  assert.equal(f.shows(), 1);
  const b = await summaryFor(deps, { fresh: '1' });
  assert.deepEqual(b.rows[0].session, { state: 'free' });
  assert.equal(f.shows(), 1);
  assert.equal(f.lists(), 2);
  f.world.t1.lastOutputAt = 6; f.world.t1.preview = WORKING;
  const c = await summaryFor(deps, { fresh: '1' });
  assert.deepEqual(c.rows[0].session, { state: 'working' });
  assert.equal(f.shows(), 2);
});

test('piStatus: the second call makes no show; a bumped lastOutputAt re-reads; the tail option is cached with its preview', async () => {
  mock.method(Date, 'now', () => clock);
  const f = fakeOrca({ t1: term(IDLE, 5) });
  assert.deepEqual(await piStatus(REPO, f.orca), { state: 'idle' });
  assert.deepEqual(await piStatus(REPO, f.orca), { state: 'idle' });
  assert.equal(f.shows(), 1);
  clock += 2000; // the shared list is a second old
  f.world.t1.lastOutputAt = 6; f.world.t1.preview = WORKING;
  assert.deepEqual(await piStatus(REPO, f.orca), { state: 'busy' });
  assert.equal(f.shows(), 2);
  const withTail = await piStatus(REPO, f.orca, { tail: true });
  assert.equal(f.shows(), 3, 'a preview is another key');
  assert.deepEqual(await piStatus(REPO, f.orca, { tail: true }), withTail);
  assert.equal(f.shows(), 3);
  clearLiveCache();
  assert.deepEqual(await piStatus(REPO, f.orca, { tail: true }), withTail, 'identical to a cold read');
});

test('piStatus: closed, ambiguous and unknown answers are unchanged (a failed show is unknown, never cached)', async () => {
  assert.deepEqual(await piStatus(REPO, fakeOrca({}).orca), { state: 'closed' });
  assert.deepEqual(await piStatus(REPO, fakeOrca({ a: term(IDLE, 1), b: term(IDLE, 2) }).orca), { state: 'ambiguous' });
  const broken = fakeOrca({ t1: term(IDLE, 5, { showFails: true }) });
  assert.deepEqual(await piStatus(REPO, broken.orca), { state: 'unknown' });
  assert.deepEqual(await piStatus(REPO, broken.orca), { state: 'unknown' });
  assert.equal(broken.shows(), 2);
});

// ---------- 9. the writers never use the cache ----------
async function warm(f) { // fills the cache for the idle terminal, as the read-only callers do
  await piStatus(REPO, f.orca, { tail: false });
  await scan(f, true, true, CACHED);
  await scan(f, false, true, CACHED);
  await scan(f, true, false, CACHED);
  await scan(f, false, false, CACHED);
}

test('piSend reads fresh even when the cache is warm: one show for the scan and one for the delivery check, exactly as when cold', async () => {
  const cold = fakeOrca({ t1: term(IDLE, 5) });
  assert.deepEqual(await piSend(REPO, 'flow-commit', cold.orca, async () => {}), { sent: true, confirmed: true });
  assert.equal(cold.shows(), 2);
  clearLiveCache();
  const f = fakeOrca({ t1: term(IDLE, 5) });
  await warm(f);
  const before = f.calls.length;
  assert.deepEqual(await piSend(REPO, 'flow-commit', f.orca, async () => {}), { sent: true, confirmed: true });
  assert.equal(showsOf(f, before), 2);
  assert.equal(f.sends(), 1);
});

test('piSend with a warm cache that says idle refuses a terminal that is working now (same lastOutputAt): nothing is sent', async () => {
  const f = fakeOrca({ t1: term(IDLE, 5) });
  await warm(f);
  f.world.t1.preview = WORKING;
  await assert.rejects(piSend(REPO, 'flow-commit', f.orca, async () => {}), (e) => e.status === 409 && e.message === 'The session is busy or has text typed in its prompt');
  assert.equal(f.sends(), 0);
});

test('piSessions (the writers\' scan) makes a show per terminal on every call, warm or not', async () => {
  const f = fakeOrca({ t1: term(IDLE, 5), t2: term(WORKING, 6) });
  await warm(f);
  const before = f.calls.length;
  for (let i = 0; i < 3; i++) assert.deepEqual(await piSessions(REPO, f.orca), [{ handle: 't1', state: 'idle' }, { handle: 't2', state: 'busy' }]);
  assert.equal(showsOf(f, before), 6);
});

test('the dialog answer reads fresh: a warm cache that says idle does not hide a question that is open now', async () => {
  const f = fakeOrca({ t1: term(IDLE, 5) });
  await warm(f);
  Object.assign(f.world.t1, asking(5)); // same lastOutputAt: only a fresh read can see the question
  const before = f.calls.length;
  await assert.rejects(answerDialog(REPO_ID, { fingerprint: '0123456789abcdef', index: 0 }, { orca: f.orca, wait: async () => {}, now }),
    (e) => e.status === 409 && e.message === 'The question changed: look at the card again');
  assert.equal(showsOf(f, before), 1);
  assert.equal(f.sends(), 0);
});

test('the chat send reads fresh: a warm cache that says idle does not let a message go to a session that is working now', async () => {
  writeConfig({ sessions: { [REPO_ID]: { id: 'sid-1', name: 'panel:demo', adoptedAt: '2026-10-30T10:00:00Z' } } });
  const f = fakeOrca({ t1: term(IDLE, 5) });
  await warm(f);
  f.world.t1.preview = WORKING;
  const before = f.calls.length;
  await assert.rejects(sendChat(REPO_ID, { text: 'hello' }, { orca: f.orca, wait: async () => {}, sessionsDir: sessionsBase, now }),
    (e) => e.status === 409 && e.message === 'The session is working; wait until it is free');
  assert.equal(showsOf(f, before), 1);
  assert.equal(f.sends(), 0);
});

test('the writers reading fresh do not poison the cache: a read-only call afterwards still answers from what it stored', async () => {
  const f = fakeOrca({ t1: term(IDLE, 5) });
  await piStatus(REPO, f.orca);
  await piSessions(REPO, f.orca);
  const before = f.shows();
  await piStatus(REPO, f.orca);
  assert.equal(f.shows(), before);
});
