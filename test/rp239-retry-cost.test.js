'use strict';
// RP239: Stop also cuts an automatic retry of pi (abort_retry), and the context chip adds the cost and the tokens of the session. Fake clients only; numbers only, never a text of pi.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'rp239-'));
const REPO = path.join(scratch, 'repo');
fs.mkdirSync(REPO);
process.env.REPO_PANEL_CONFIG = path.join(scratch, 'config.json');
fs.writeFileSync(process.env.REPO_PANEL_CONFIG, JSON.stringify({ groups: [{ name: 'g', repos: [{ path: REPO }] }] }));
test.after(() => fs.rmSync(scratch, { recursive: true, force: true }));

const lib = require('../lib.js');
const { createRpcHost } = require('../server/rpchost.js');
const { findRepo } = require('../server/config.js');
const V = require('../public/view.js');
const R = require('../public/resumen.js');

const ID = lib.repoId(REPO);
const ACTIVE = { id: 'gentle-shell', command: 'C:\\L\\gentle-shell.exe', agentDir: 'C:\\a' };

// A fake client: `answers[type]` is what request(type) gives (a value, or a function that returns or throws); `emit` sends a record of pi as an event.
async function hostWith(answers = {}) {
  const made = [];
  const createClient = (opts) => {
    const c = { opts, reqs: [], start: async () => ({}), pendingDialogs: () => [], state: () => 'busy', close() {}, emit: (record) => opts.onEvent({ kind: 'event', record }) };
    c.request = async (type, fields) => { c.reqs.push([type, fields]); const a = answers[type]; return typeof a === 'function' ? a() : a === undefined ? {} : a; };
    made.push(c);
    return c;
  };
  const host = createRpcHost({ resolve: async () => ({ active: ACTIVE }), repoOf: findRepo, publish: () => {}, createClient, adoptedOf: () => null });
  await host.start(ID);
  const c = made[0];
  c.reqs.length = 0; // the commands asked at the start
  return { host, c };
}
const RETRY = { type: 'auto_retry_start', attempt: 1, maxAttempts: 3, delayMs: 4000, errorMessage: 'SECRET' };

// ---------- Stop during a retry ----------
test('stop during a pending retry cuts the retry first, then aborts as before', async () => {
  const { host, c } = await hostWith();
  c.emit(RETRY);
  await host.abort(ID);
  assert.deepEqual(c.reqs, [['abort_retry', {}], ['abort', {}]]);
});

test('stop with no retry sends only abort, as before', async () => {
  const { host, c } = await hostWith();
  await host.abort(ID);
  assert.deepEqual(c.reqs, [['abort', {}]]);
});

test('a retry that ended (or a run that settled) is not pending any more', async () => {
  for (const end of [{ type: 'auto_retry_end', success: false }, { type: 'agent_settled' }]) {
    const { host, c } = await hostWith();
    c.emit(RETRY);
    c.emit(end);
    await host.abort(ID);
    assert.deepEqual(c.reqs, [['abort', {}]], end.type);
  }
});

test('a failed abort_retry is ignored: abort is still sent and its answer returned', async () => {
  const { host, c } = await hostWith({ abort_retry: () => { throw new Error('Unknown command: abort_retry'); }, abort: { ok: 1 } });
  c.emit(RETRY);
  assert.deepEqual(await host.abort(ID), { ok: 1 });
  assert.deepEqual(c.reqs, [['abort_retry', {}], ['abort', {}]]);
});

// ---------- the cost and the tokens of the session ----------
const usage = { tokens: 124000, contextWindow: 200000, percent: 62 };
const read = async (stats) => { const { host } = await hostWith({ get_session_stats: stats }); return host.context(ID); };

test('context: carries the cost and the total tokens of the session, and no text', async () => {
  const got = await read({ contextUsage: usage, cost: 0.1234, tokens: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, total: 34000 }, sessionFile: 'SECRET' });
  assert.deepEqual(got, { tokens: 124000, window: 200000, percent: 62, cost: 0.1234, sessionTokens: 34000 });
});

test('context: a cost or a total that is not a clean number is null, never 0', async () => {
  for (const [cost, total] of [['0.12', '34000'], [-1, -1], [NaN, NaN], [Infinity, 1.5], [1e300, 2 ** 60], [null, null], [{}, []]]) {
    const got = await read({ contextUsage: usage, cost, tokens: { total } });
    assert.equal(got.cost, null, `cost ${String(cost)}`);
    assert.equal(got.sessionTokens, null, `total ${String(total)}`);
  }
  assert.equal((await read({ contextUsage: usage, cost: 0, tokens: { total: 0 } })).cost, 0, 'an exact 0 stays 0');
  assert.equal((await read({ contextUsage: usage, tokens: 'x' })).sessionTokens, null);
});

test('context: an unknown window keeps the session totals; a failed read is all null', async () => {
  assert.deepEqual(await read({ cost: 0.5, tokens: { total: 10 } }), { tokens: null, window: null, percent: null, cost: 0.5, sessionTokens: 10 });
  assert.deepEqual(await read(() => { throw new Error('SECRET'); }), { tokens: null, window: null, percent: null, cost: null, sessionTokens: null });
});

test('page record: rpcWithContext keeps the cost and the total tokens, validated the same way', () => {
  const ok = V.rpcWithContext({ state: 'idle' }, { tokens: 5, percent: 10, window: 100, cost: 0.12, sessionTokens: 34000, text: 'SECRET' }).ctx;
  assert.deepEqual(ok, { tokens: 5, percent: 10, window: 100, cost: 0.12, sessionTokens: 34000 });
  const bad = V.rpcWithContext({ state: 'idle' }, { tokens: 5, percent: 10, window: 100, cost: '0.12', sessionTokens: 1.5 }).ctx;
  assert.equal(bad.cost, null);
  assert.equal(bad.sessionTokens, null);
  const huge = V.rpcWithContext({ state: 'idle' }, { window: 0, cost: 1e300, sessionTokens: 2 ** 60 }).ctx;
  assert.deepEqual(huge, { tokens: null, percent: null, window: null, cost: null, sessionTokens: null });
  assert.deepEqual(V.rpcWithContext({ state: 'idle' }, { window: 0, cost: 0.5, sessionTokens: 7 }).ctx, { tokens: null, percent: null, window: null, cost: 0.5, sessionTokens: 7 });
});

// ---------- the words of the chip (a pure function) ----------
test('chip totals: tokens in k and the cost with 2 decimals; a null part is left out', () => {
  assert.deepEqual(R.sessionTotals({ sessionTokens: 34000, cost: 0.12 }), ['34k tok', '$0.12']);
  assert.deepEqual(R.sessionTotals({ sessionTokens: 950, cost: 1.005 }), ['950 tok', '$1.00']);
  assert.deepEqual(R.sessionTotals({ sessionTokens: null, cost: 2.5 }), ['$2.50']);
  assert.deepEqual(R.sessionTotals({ sessionTokens: 34000, cost: null }), ['34k tok']);
  assert.deepEqual(R.sessionTotals({ sessionTokens: null, cost: null }), []);
  assert.deepEqual(R.sessionTotals(null), []);
  // Seen by the person: 97,428,000 tokens read «97428k tok». Millions read as M; the help says the exact number with thousands separators.
  assert.deepEqual(R.sessionTotals({ sessionTokens: 97428123, cost: 36.34 }), ['97.4M tok', '$36.34']);
  assert.deepEqual(R.sessionTotals({ sessionTokens: 1000000 }), ['1M tok']);
  assert.deepEqual(R.sessionTotals({ sessionTokens: 999600 }), ['1M tok'], 'never «1000k»');
  assert.deepEqual(R.sessionTotals({ sessionTokens: 128400000 }), ['128M tok']);
  assert.deepEqual(R.sessionTotals({ sessionTokens: 97428123, cost: 36.34 }, { exact: true }), ['97,428,123 tokens', '$36.34']);
  assert.deepEqual(R.sessionTotals({ sessionTokens: 950 }, { exact: true }), ['950 tokens']);
  // Seen by the person in the help: «471k of 1000k». The context window of 1M tokens reads in M too.
  assert.equal(R.tokensShort(1000000), '1M');
  assert.equal(R.tokensShort(471000), '471k');
  assert.equal(R.tokensShort(200000), '200k');
});

test('chip totals: under a cent is <$0.01 and exactly 0 is $0.00', () => {
  assert.deepEqual(R.sessionTotals({ cost: 0.004 }), ['<$0.01']);
  assert.deepEqual(R.sessionTotals({ cost: 0 }), ['$0.00']);
  assert.deepEqual(R.sessionTotals({ cost: 0.01 }), ['$0.01']);
  assert.deepEqual(R.sessionTotals({ cost: -1, sessionTokens: '5' }), []);
});
