'use strict';
// RP78 verifier probes (S68, S73): gaps the mutation round found (survivors) and two defects.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'rp78v-'));
process.env.REPO_PANEL_CONFIG = path.join(scratch, 'config.json');
process.env.REPO_PANEL_CASES_FILE = 'off';
test.after(() => fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 5 }));

const lib = require('../lib.js');
const { createSummaryStore } = require('../server/summarystore.js');
const { summarize } = require('../server/summary.js');

const GOOD = {
  local: { branch: 'main', files: [], ahead: 0, behind: 0, base: 'main' },
  prs: { prs: [{ number: 9, title: 'T', ready: true, checks: { state: 'success' } }], stale: null },
  roadmap: { available: false, reason: 'missing' },
  state: { available: false },
};
const LAST = { code: 0, stdout: '2026-10-28T10:00:00Z\nsubject\n', stderr: '' };
const readers = (over = {}) => ({ local: async () => GOOD.local, prs: async () => GOOD.prs, roadmap: async () => GOOD.roadmap, state: async () => GOOD.state, git: async () => LAST, ...over });
const cfgOf = (names, extra = {}) => ({ groups: [{ name: 'G', repos: names.map((n) => ({ path: `/w/${n}` })) }], rooms: [], snoozed: [], ...extra });
const idOf = (n) => lib.repoId(`/w/${n}`);
const flush = async () => { for (let i = 0; i < 25; i++) await new Promise((r) => setImmediate(r)); };
// These probes use the 5 s fast interval of the store tests.
const FAST = { intervals: { fast: 5000 } };

test('every snapshot() touches: a page asking every 50 s keeps the store on the active intervals (S68)', async () => {
  let t = 1e6;
  let reads = 0;
  const store = createSummaryStore({ ...FAST, deps: readers({ local: async () => { reads++; return GOOD.local; } }), waitForClient: false, now: () => t, loadCfg: () => cfgOf(['a']) });
  store.snapshot(); t += 50000; store.snapshot(); t += 40000; await store.refreshAll();
  t += 10000; // 50 s after the last ask (not idle), 10 s after the last read: due at 5 s, not at the idle 30 s
  const before = reads;
  await store.tick();
  assert.equal(reads, before + 1);
});

test('the snoozed PRs of the config reach the row, like summarize does (no Merge for a snoozed PR)', async () => {
  const snoozed = [`${idOf('a')}:9`];
  const store = createSummaryStore({ deps: readers(), waitForClient: false, loadCfg: () => cfgOf(['a'], { snoozed }) });
  await store.refreshAll();
  const row = store.snapshot().rows[0];
  const want = summarize({ repo: { id: idOf('a'), name: 'a', group: 'G', room: null }, ...GOOD, last: { at: '2026-10-28T10:00:00Z', what: 'subject' }, session: 'unknown', snoozed, now: Date.now() });
  assert.deepEqual(row.action, want.action);
  assert.notEqual(row.action && row.action.kind, 'merge');
});

test('a repo removed from the config and added again starts from nothing: loading row, session unknown', async () => {
  let c = cfgOf(['a']);
  const store = createSummaryStore({ deps: readers(), waitForClient: false, loadCfg: () => c });
  await store.refreshAll(); store.setSession(idOf('a'), 'asking');
  c = cfgOf([]); store.snapshot(); c = cfgOf(['a']);
  const row = store.snapshot().rows[0];
  assert.equal(row.loading, true);
  await store.refreshAll();
  assert.equal(store.snapshot().rows[0].session.state, 'unknown');
});

test('git that cannot say (null last) after a good read keeps the previous last movement', async () => {
  let ok = true;
  const store = createSummaryStore({ deps: readers({ git: async () => (ok ? LAST : { code: 1, stdout: '', stderr: 'x' }) }), waitForClient: false, loadCfg: () => cfgOf(['a']) });
  await store.refreshAll(); ok = false; await store.refreshAll();
  assert.equal(store.snapshot().rows[0].lastMovement.at, '2026-10-28T10:00:00Z');
});

test('default pool is 3 repos, also when two ticks overlap', async () => {
  let live = 0;
  let max = 0;
  const open = [];
  const names = Array.from({ length: 9 }, (_, i) => `r${i}`);
  const hold = () => new Promise((r) => open.push(r));
  const deps = readers({ local: async () => { live++; max = Math.max(max, live); await hold(); live--; return GOOD.local; } });
  const store = createSummaryStore({ deps, waitForClient: false, loadCfg: () => cfgOf(names) });
  const a = store.tick();
  const b = store.tick();
  await flush();
  while (open.length) { open.shift()(); await flush(); }
  await Promise.all([a, b]);
  assert.equal(max, 3);
});

test('a row is real while only the last-movement read is still pending (last is not NEEDED)', async () => {
  const store = createSummaryStore({ deps: readers({ git: () => new Promise(() => {}) }), waitForClient: false, loadCfg: () => cfgOf(['a']), timeout: (p) => p });
  store.tick(); await flush();
  assert.notEqual(store.snapshot().rows[0].loading, true);
});

test('server.close() stops the summary store', async () => {
  const { createServer } = require('../server/http.js');
  const server = createServer(0, {});
  let stopped = 0;
  const real = server.summaryStore.stop;
  server.summaryStore.stop = () => { stopped++; return real(); };
  await new Promise((r) => server.close(r));
  assert.equal(stopped, 1);
});

test('the page asks the summary again while rows load (app.js keeps the 2 s re-ask)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  assert.match(src, /rows\.some\(\(r\) => r\.loading\)\) setTimeout\(summaryTick, SUMMARY_LOADING_MS\)/);
});

// ---- defects found by the verification ----
test('DEFECT: a loadCfg that throws inside the loop never becomes an unhandled rejection and the loop keeps going', async () => {
  let bad = false;
  const timers = [];
  const store = createSummaryStore({ deps: readers(), waitForClient: false, loadCfg: () => { if (bad) throw new Error('groups[0] is null'); return cfgOf(['a']); }, setTimer: (fn) => { timers.push(fn); return {}; } });
  store.start(); bad = true;
  let rejected = null;
  const h = (e) => { rejected = e; };
  process.once('unhandledRejection', h);
  timers[0](); await flush(); process.removeListener('unhandledRejection', h);
  assert.equal(rejected, null);
  assert.equal(timers.length, 2, 'the loop re-armed itself');
});

test('DEFECT: one reader that never resolves does not stop the other repos from being read again', async () => {
  let t = 1000;
  let b = 0;
  const deps = readers({ prs: async (r) => (r.path.endsWith('/a') ? new Promise(() => {}) : (b++, GOOD.prs)) });
  // The injected timeout gives up on the held read at once: a reader that hangs outside exec must not pin the loop for ever.
  const store = createSummaryStore({ deps, waitForClient: false, now: () => t, loadCfg: () => cfgOf(['a', 'b']), timeout: (p, ms) => Promise.race([p, new Promise((_, rej) => setImmediate(() => rej(new Error(`Read timed out after ${ms} ms`))))]) });
  store.tick(); await flush(); const first = b;
  t += 10000 * 60; store.tick(); await flush();
  assert.ok(b > first);
});
