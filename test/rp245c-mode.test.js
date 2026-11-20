'use strict';
// RP245c (part 3 of the parity with the terminal): the head of the chat shows the permission mode of the session. Gentle Shell announces it with the status notice
// `gentle:mode` («Permissions: NORMAL|AUTO|YOLO|SUPER-YOLO», at the start of the session and on every change); the panel reduces it to ONE category of a closed list and
// never passes its text. The head says nothing in the normal mode.
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'rp245c-'));
process.env.REPO_PANEL_CONFIG = path.join(scratch, 'config.json');
test.after(() => fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 5 }));

const { createRpcClient } = require('../server/rpc.js');
const { createRpcHost, rpcApi, modeOf } = require('../server/rpchost.js');
const V = require('../public/view.js');
const R = require('../public/resumen.js');

// ---------- the text of the notice -> a category ----------
test('modeOf: the four texts Gentle Shell writes are the four categories; anything else is null (it never changes what is known)', () => {
  assert.equal(modeOf('Permissions: NORMAL'), 'normal');
  assert.equal(modeOf('Permissions: AUTO'), 'auto');
  assert.equal(modeOf('Permissions: YOLO'), 'yolo');
  assert.equal(modeOf('Permissions: SUPER-YOLO'), 'super-yolo');
  assert.equal(modeOf('  permissions:  super-yolo '), 'super-yolo');
  for (const t of ['', 'Permissions: GOD', 'Permissions: YOLO — default: NORMAL', 'YOLO', 'x Permissions: YOLO', undefined, null, 7]) assert.equal(modeOf(t), null, String(t));
});

// ---------- the RPC client (server/rpc.js) ----------
function fakeChild() {
  const c = new EventEmitter();
  c.pid = 4242;
  c.stdout = new EventEmitter();
  c.writes = [];
  c.stdin = Object.assign(new EventEmitter(), { write(s) { c.writes.push(s); return true; }, end() {} });
  c.kill = () => {};
  c.said = (obj) => c.stdout.emit('data', `${JSON.stringify(obj)}\n`);
  c.sent = () => c.writes.join('').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  return c;
}
const until = async (fn, ms = 1000) => { const end = Date.now() + ms; while (Date.now() < end) { const v = fn(); if (v) return v; await new Promise((r) => setTimeout(r, 5)); } throw new Error('timed out waiting'); };
const notice = (key, text) => ({ type: 'extension_ui_request', id: `u-${Math.random()}`, method: 'setStatus', statusKey: key, statusText: text });

test('client: the notice gentle:mode is kept like the memory one; the gentle:yolo badge and its widget are still dropped', async (t) => {
  const child = fakeChild();
  const events = [];
  const client = createRpcClient({ command: 'C:\\x\\pi.exe', args: [], cwd: scratch, env: {}, spawn: (f) => (f === 'taskkill' ? new EventEmitter() : child), platform: 'win32', graceMs: 50, killWaitMs: 50, onEvent: (e) => events.push(e), onExit: () => {} }); // RP238: a short grace, the fake never exits by itself
  t.after(() => client.close());
  const started = client.start();
  await until(() => child.sent().length >= 1);
  child.said({ id: child.sent()[0].id, type: 'response', command: 'get_state', success: true, data: { isStreaming: false } });
  await started;
  child.said(notice('gentle:mode', 'Permissions: YOLO'));
  child.said(notice('gentle:yolo', '🚀 YOLO ON 🔥 — destructive confirmations remain'));
  child.said({ type: 'extension_ui_request', id: 'w1', method: 'setWidget', widgetKey: 'gentle:yolo', widgetLines: ['YOLO'] });
  assert.deepEqual(events.filter((e) => e.kind === 'status').map((e) => [e.key, e.text]), [['gentle:mode', 'Permissions: YOLO']]);
  assert.equal(client.state(), 'idle');
});

// ---------- the host (server/rpchost.js) ----------
const ACTIVE = { id: 'gentle-shell', command: 'C:\\L\\gentle-shell.exe', agentDir: 'C:\\a' };
async function hostWith() {
  const made = [];
  const sent = [];
  const createClient = (opts) => {
    const c = { opts, start: async () => ({}), request: async () => ({}), answerDialog: () => false, pendingDialogs: () => [], state: () => 'idle', close() {} };
    made.push(c);
    return c;
  };
  const host = createRpcHost({ resolve: async () => ({ active: ACTIVE }), repoOf: (id) => ({ id, path: 'C:\\repos\\alpha' }), publish: (id, p) => sent.push([id, p]), createClient, adoptedOf: () => null });
  await host.start('aaa');
  const say = (text, key = 'gentle:mode') => made[made.length - 1].opts.onEvent({ kind: 'status', key, text });
  return { host, sent, say, made };
}

test('host: the status reports the mode as a category; a change is published once to every tab; an unknown text changes nothing', async () => {
  const { host, sent, say } = await hostWith();
  assert.equal((await rpcApi(host).status({ id: 'aaa' })).mode, undefined, 'nothing announced yet');
  say('Permissions: NORMAL');
  say('Permissions: NORMAL');
  say('Permissions: SUPER-YOLO');
  say('Permissions: WHAT');
  say('Permissions: AUTO', 'gentle:yolo');
  assert.equal((await rpcApi(host).status({ id: 'aaa' })).mode, 'super-yolo');
  assert.deepEqual(sent.filter(([, p]) => p.kind === 'mode'), [['aaa', { kind: 'mode', mode: 'normal' }], ['aaa', { kind: 'mode', mode: 'super-yolo' }]]);
  assert.ok(!JSON.stringify(sent).includes('Permissions'), 'the text never leaves the server');
});

test('host: the notice of an old client (replaced by a new start) is not the new session\'s', async () => {
  const { host, sent, say, made } = await hostWith();
  const old = made[0];
  await host.close('aaa');
  await host.start('aaa');
  old.opts.onEvent({ kind: 'status', key: 'gentle:mode', text: 'Permissions: YOLO' });
  assert.equal((await rpcApi(host).status({ id: 'aaa' })).mode, undefined);
  assert.equal(sent.filter(([, p]) => p.kind === 'mode').length, 0);
  say('Permissions: AUTO');
  assert.equal((await rpcApi(host).status({ id: 'aaa' })).mode, 'auto');
});

// ---------- the page (public/view.js) ----------
test('page: the mode event and the status set it; only the closed list counts; an exit or a closed session forgets it', () => {
  const e0 = V.rpcFromStatus(undefined, { state: 'idle', pendingDialogs: [] });
  assert.equal(e0.mode, null);
  assert.equal(V.rpcEvent({ event: 'rpc', data: JSON.stringify({ id: 'abcdef0123', kind: 'mode', mode: 'yolo' }) }).mode, 'yolo');
  const e1 = V.rpcReduce(e0, { kind: 'mode', mode: 'yolo' }).entry;
  assert.equal(e1.mode, 'yolo');
  assert.equal(V.rpcReduce(e1, { kind: 'mode', mode: 'root' }).entry.mode, 'yolo');
  assert.equal(V.rpcReduce(e1, { kind: 'exit' }).entry.mode, null);
  assert.equal(V.rpcFromStatus(e1, { state: 'idle', pendingDialogs: [], mode: 'auto' }).mode, 'auto');
  assert.equal(V.rpcFromStatus(e1, { state: 'idle', pendingDialogs: [] }).mode, 'yolo', 'a status without the mode keeps what was known');
  assert.equal(V.rpcFromStatus(e1, { state: 'closed', pendingDialogs: [] }).mode, null);
});

// ---------- what the head decides to say (public/resumen.js) ----------
test('head: nothing in the normal mode, unknown or closed; a chip for auto, yolo and super-yolo', () => {
  const c = (mode, state = 'idle') => ({ rpc: { ...V.rpcFromStatus(undefined, null), state, mode } });
  for (const x of [c('normal'), c(null), c('yolo', 'closed'), c('root'), {}]) assert.equal(R.modeChipHtml(x), '');
  for (const [m, word] of [['auto', 'auto'], ['yolo', 'yolo'], ['super-yolo', 'super-yolo']]) assert.match(R.modeChipHtml(c(m)), new RegExp(`>${word}<`));
  assert.match(R.headChipsHtml(c('super-yolo'), null), /super-yolo/);
});
