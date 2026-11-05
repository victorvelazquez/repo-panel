'use strict';
// RP105c: while pi retries a failed request on its own (`auto_retry_start`, then `auto_retry_end`), the live chat says so. Evidence: pi emits both as session events and
// the RPC mode forwards them; the history file keeps NO record of a retry, so this is live only. Only the NUMBERS and the verdict travel: the `errorMessage` of the
// start (it can hold the raw body of an API answer) and the `finalError` of the end never leave the server.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'rp105c-'));
process.env.REPO_PANEL_CONFIG = path.join(scratch, 'config.json');
test.after(() => fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 5 }));

const { createRpcHost } = require('../server/rpchost.js');
const V = require('../public/view.js');
const R = require('../public/resumen.js');

const ACTIVE = { id: 'gentle-shell', command: 'C:\\L\\gentle-shell.exe', agentDir: 'C:\\a' };
async function hostWith() {
  const made = [];
  const published = [];
  const createClient = (opts) => { const c = { opts, start: async () => ({}), request: async () => ({}), answerDialog: () => false, pendingDialogs: () => [], state: () => 'idle', close() {} }; made.push(c); return c; };
  const host = createRpcHost({ resolve: async () => ({ active: ACTIVE }), repoOf: (id) => ({ id, path: 'C:\\repos\\alpha' }), publish: (id, p) => published.push(p), createClient, adoptedOf: () => null });
  await host.start('aaa');
  return { published, emit: (record) => made[0].opts.onEvent({ kind: 'event', record }) };
}
const events = (published) => published.filter((p) => p.kind === 'event').map((p) => p.record);

test('server: a retry start keeps its numbers and a retry end its verdict; the error texts never travel', async () => {
  const { published, emit } = await hostWith();
  emit({ type: 'auto_retry_start', attempt: 2, maxAttempts: 3, delayMs: 4000, errorMessage: '529 {"error":"SECRET-API-BODY"}' });
  emit({ type: 'auto_retry_end', success: false, attempt: 3, finalError: 'SECRET-FINAL', junk: 1 });
  assert.deepEqual(events(published), [
    { type: 'auto_retry_start', attempt: 2, maxAttempts: 3, delayMs: 4000 },
    { type: 'auto_retry_end', success: false, attempt: 3 },
  ]);
  assert.doesNotMatch(JSON.stringify(published), /SECRET|529/);
});

test('server: a number that is not a finite number, or a verdict that is not a boolean, is dropped', async () => {
  const { published, emit } = await hostWith();
  emit({ type: 'auto_retry_start', attempt: '2', maxAttempts: null, delayMs: Infinity });
  emit({ type: 'auto_retry_end', success: 'yes', attempt: { x: 1 } });
  assert.deepEqual(events(published), [{ type: 'auto_retry_start' }, { type: 'auto_retry_end' }]);
});

const rec = (record) => ({ kind: 'event', id: '0123456789', record });
const reduce = (e, record, now = 0) => V.rpcReduce(e, rec(record), now).entry;

test('page: a retry start sets the note, its end clears it, and a new run, the end of a run and an exit clear it too', () => {
  let e = reduce(null, { type: 'agent_start' }, 1);
  assert.equal(e.retry, null);
  e = reduce(e, { type: 'auto_retry_start', attempt: 2, maxAttempts: 3, delayMs: 4000 });
  assert.deepEqual(e.retry, { attempt: 2, max: 3, delayMs: 4000 });
  assert.equal(reduce(e, { type: 'auto_retry_end', success: true, attempt: 2 }).retry, null);
  assert.equal(reduce(e, { type: 'agent_start' }, 2).retry, null);
  assert.equal(reduce(e, { type: 'agent_settled' }).retry, null);
  assert.equal(V.rpcReduce(e, { kind: 'exit' }).entry.retry, null);
});

test('page: a retry start with missing or odd numbers still sets a note, with only what is valid', () => {
  const e = reduce(null, { type: 'auto_retry_start' });
  assert.deepEqual(e.retry, { attempt: null, max: null, delayMs: null });
  assert.deepEqual(reduce(null, { type: 'auto_retry_start', attempt: -1, maxAttempts: 'x', delayMs: 1e12 }).retry, { attempt: null, max: null, delayMs: null });
});

const tail = (rpc) => R.chatBody({ id: 's1', info: { adopted: { id: 's1', name: 'panel:alpha' }, adoptedFound: true, sessions: [] }, hist: { found: true, items: [], truncated: false }, rpc }, {});

test('page: while it retries, the tail says so instead of «working…»; with the attempt and the wait when it knows them', () => {
  const base = { state: 'busy', streaming: true, text: '', asks: [] };
  assert.match(tail({ ...base, retry: { attempt: 2, max: 3, delayMs: 4000 } }), /<div class="m working">⟳ Retrying · attempt 2 of 3 · in 4s<\/div>/);
  assert.match(tail({ ...base, retry: { attempt: 2, max: null, delayMs: null } }), /<div class="m working">⟳ Retrying · attempt 2<\/div>/);
  assert.match(tail({ ...base, retry: { attempt: null, max: null, delayMs: null } }), /<div class="m working">⟳ Retrying<\/div>/);
  assert.doesNotMatch(tail({ ...base, retry: { attempt: 2, max: 3, delayMs: 4000 } }), /working…/);
});

test('page: with no retry nothing changes, and a retry under streaming text keeps the text and adds the note', () => {
  assert.match(tail({ state: 'busy', streaming: true, text: '', asks: [] }), /<div class="m working">working…<\/div>/);
  assert.doesNotMatch(tail({ state: 'busy', streaming: true, text: '', asks: [], retry: null }), /Retrying/);
  const both = tail({ state: 'busy', streaming: true, text: 'Partial', asks: [], retry: { attempt: 1, max: 3, delayMs: 2000 } });
  assert.match(both, /Partial[\s\S]*⟳ Retrying · attempt 1 of 3 · in 2s/);
});
