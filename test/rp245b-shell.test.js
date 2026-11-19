'use strict';
// RP245b (part 2 of the parity with the terminal, decided by the person): a message that starts with ! runs its command in the folder of the session with pi's `bash`
// order (its output goes to the conversation), and one that starts with !! runs it without sending the output to the model (excludeFromContext). The output streams
// live into the chat (`bash_execution_update` becomes the panel's `bash_output`). With the session not free the command waits in the box, like a command with /.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'rp245b-'));
process.env.REPO_PANEL_CONFIG = path.join(scratch, 'config.json');
test.after(() => fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 5 }));

const { createRpcHost, rpcApi, toPanel } = require('../server/rpchost.js');
const V = require('../public/view.js');
const R = require('../public/resumen.js');

const SHELL_WAITS = 'Shell commands wait until the session is free: send it when the run ends';
const ACTIVE = { id: 'gentle-shell', command: 'C:\\L\\gentle-shell.exe', agentDir: 'C:\\a' };
async function hostWith({ state = 'idle', answer = { output: 'ok\n', exitCode: 0, cancelled: false, truncated: false }, hold = false } = {}) {
  const made = [];
  const cur = { state };
  const gates = [];
  const createClient = (opts) => {
    const c = { opts, reqs: [], start: async () => ({}), answerDialog: () => false, pendingDialogs: () => [], state: () => cur.state, close() {} };
    c.request = async (type, fields, o) => { c.reqs.push([type, fields, o]); if (type === 'bash' && hold) await new Promise((r) => gates.push(r)); return type === 'bash' ? answer : {}; };
    made.push(c);
    return c;
  };
  const host = createRpcHost({ resolve: async () => ({ active: ACTIVE }), repoOf: (id) => ({ id, path: 'C:\\repos\\alpha' }), publish() {}, createClient, adoptedOf: () => null });
  await host.start('aaa');
  return { host, cur, release: () => gates.splice(0).forEach((r) => r()), reqs: () => made[0].reqs.filter(([t]) => t !== 'get_commands') };
}
const refuses = (p, status, re) => assert.rejects(p, (e) => e.status === status && re.test(e.message));

// ---------- the server ----------
test('server: !command runs it with pi\'s bash order, its output to the conversation; !!command without sending it to the model', async () => {
  const { host, reqs } = await hostWith();
  assert.deepEqual(await rpcApi(host).bash({ id: 'aaa', text: '!git status' }), { output: 'ok\n', exitCode: 0, cancelled: false, truncated: false });
  await rpcApi(host).bash({ id: 'aaa', text: '  !!ls -la  ' });
  assert.deepEqual(reqs().map(([t, f]) => [t, f]), [['bash', { command: 'git status', excludeFromContext: false }], ['bash', { command: 'ls -la', excludeFromContext: true }]]);
  assert.ok(reqs()[0][2].timeoutMs >= 600000, 'a command may take longer than an ordinary request');
});

test('server: what is not a shell command, or has no command, is refused and nothing is sent', async () => {
  const { host, reqs } = await hostWith();
  await refuses(rpcApi(host).bash({ id: 'aaa', text: 'git status' }), 400, /^A shell command starts with ! or !!$/);
  for (const text of ['!', '!!', '!!   ', '!  ']) await refuses(rpcApi(host).bash({ id: 'aaa', text }), 400, /^Write a command after ! or !!$/);
  await refuses(rpcApi(host).bash({ id: 'aaa', text: 7 }), 400, /must be a string/);
  assert.deepEqual(reqs(), []);
});

test('server: with the session not free the command waits; one command at a time; a repo with no session is refused', async () => {
  for (const state of ['busy', 'asking']) {
    const { host, reqs } = await hostWith({ state });
    await refuses(rpcApi(host).bash({ id: 'aaa', text: '!ls' }), 409, new RegExp(`^${SHELL_WAITS}$`));
    assert.deepEqual(reqs(), [], state);
  }
  const one = await hostWith({ hold: true });
  const first = rpcApi(one.host).bash({ id: 'aaa', text: '!sleep 5' });
  await new Promise((r) => setImmediate(r));
  await refuses(rpcApi(one.host).bash({ id: 'aaa', text: '!ls' }), 409, /^A shell command is already running in this session$/);
  one.release();
  await first;
  const again = rpcApi(one.host).bash({ id: 'aaa', text: '!ls' }); // the slot is free again (the fake still holds it until released)
  await new Promise((r) => setImmediate(r));
  one.release();
  await again;
  assert.equal(one.reqs().length, 2);
  await refuses(rpcApi(one.host).bash({ id: 'bbb', text: '!ls' }), 409, /not started/);
});

test('server: a failed command frees the slot', async () => {
  const made = [];
  const createClient = () => { const c = { start: async () => ({}), answerDialog: () => false, pendingDialogs: () => [], state: () => 'idle', close() {}, request: async (t) => { made.push(t); if (t === 'bash' && made.filter((x) => x === 'bash').length === 1) throw new Error('boom'); return { output: '', exitCode: 0 }; } }; return c; };
  const h = createRpcHost({ resolve: async () => ({ active: ACTIVE }), repoOf: (id) => ({ id, path: 'C:\\r' }), publish() {}, createClient, adoptedOf: () => null });
  await h.start('aaa');
  await refuses(rpcApi(h).bash({ id: 'aaa', text: '!ls' }), 500, /^The session failed$/);
  assert.deepEqual(await rpcApi(h).bash({ id: 'aaa', text: '!ls' }), { output: '', exitCode: 0 });
});

test('server: the output stream becomes bash_output with its text only; a prompt that starts with ! is still refused', async () => {
  assert.deepEqual(toPanel({ type: 'bash_execution_update', id: 'c4', delta: 'total 48\n' }), { type: 'bash_output', delta: 'total 48\n' });
  assert.deepEqual(toPanel({ type: 'bash_execution_update', delta: 7 }), { type: 'bash_output' });
  const { host } = await hostWith();
  await refuses(rpcApi(host).prompt({ id: 'aaa', text: '!ls' }), 400, /^Messages that start with ! run a shell command: send them from the chat box$/);
});

// ---------- stopping a command (asked by the person after the independent verification) ----------
const { RpcError } = require('../server/rpc.js');
test('server: Stop sends pi\'s abort_bash; a repo with no session is refused', async () => {
  const { host, reqs } = await hostWith();
  assert.deepEqual(await rpcApi(host).abortBash({ id: 'aaa', junk: 1 }), { ok: true });
  assert.deepEqual(reqs().map(([t, f]) => [t, f]), [['abort_bash', {}]]);
  await refuses(rpcApi(host).abortBash({ id: 'bbb' }), 409, /not started/);
});

test('server: a command that runs past the wait is stopped in pi too, and the slot is free again', async () => {
  const sent = [];
  const waits = {};
  let first = true;
  const createClient = () => ({ start: async () => ({}), answerDialog: () => false, pendingDialogs: () => [], state: () => 'idle', close() {},
    request: async (t, f, o) => { sent.push(t); waits[t] = o && o.timeoutMs; if (t === 'bash' && first) { first = false; throw new RpcError('The agent did not answer in time'); } return t === 'bash' ? { output: '', exitCode: 0 } : {}; } });
  const h = createRpcHost({ resolve: async () => ({ active: ACTIVE }), repoOf: (id) => ({ id, path: 'C:\\r' }), publish() {}, createClient, adoptedOf: () => null });
  await h.start('aaa');
  await refuses(rpcApi(h).bash({ id: 'aaa', text: '!sleep 9999' }), 409, /^The shell command ran longer than 30 minutes and was stopped$/);
  assert.deepEqual(sent.filter((t) => t !== 'get_commands'), ['bash', 'abort_bash']);
  assert.ok(waits.abort_bash > 0 && waits.abort_bash <= 20000, `the abort after the wait is short, so the 409 reaches the page before it gives up: ${waits.abort_bash}`);
  assert.deepEqual(await rpcApi(h).bash({ id: 'aaa', text: '!ls' }), { output: '', exitCode: 0 });
});

test('server: the command length boundary is the text cap', async () => {
  const { host } = await hostWith();
  await rpcApi(host).bash({ id: 'aaa', text: '!' + 'x'.repeat(20000) });
  await refuses(rpcApi(host).bash({ id: 'aaa', text: '!' + 'x'.repeat(20001) }), 400, /^The command is longer than 20000 characters$/);
});

// ---------- the page ----------
test('page: a running command has Stop in its bubble; a finished one does not', () => {
  assert.match(R.shellHtml({ command: 'sleep 9', exclude: false, output: '', running: true }), /data-act="shell-stop"[^>]*>Stop</);
  assert.doesNotMatch(R.shellHtml({ command: 'ls', exclude: false, output: '', running: false, exitCode: 0 }), /shell-stop/);
});

test('page: bashOf reads ! and !! and nothing else', () => {
  assert.deepEqual(R.bashOf('!git status'), { command: 'git status', exclude: false });
  assert.deepEqual(R.bashOf('  !!ls -la '), { command: 'ls -la', exclude: true });
  for (const t of ['git status', '', '!', '!! ', 'a !b', null, undefined]) assert.equal(R.bashOf(t), null, String(t));
});

const rec = (record) => ({ kind: 'event', id: '0123456789', record: toPanel(record) });
test('page: the live output is added to the running command, capped; nothing is added without one; an exit or a closed status clears it', () => {
  let e = { ...V.rpcFromStatus(undefined, { state: 'idle', pendingDialogs: [] }), bash: { command: 'ls', exclude: false, output: '', running: true } };
  e = V.rpcReduce(e, rec({ type: 'bash_execution_update', delta: 'a\n' })).entry;
  e = V.rpcReduce(e, rec({ type: 'bash_execution_update', delta: 'b\n' })).entry;
  assert.equal(e.bash.output, 'a\nb\n');
  const done = { ...e, bash: { ...e.bash, running: false } };
  assert.equal(V.rpcReduce(done, rec({ type: 'bash_execution_update', delta: 'late' })).entry.bash.output, 'a\nb\n', 'a finished command takes nothing more');
  const big = V.rpcReduce({ ...e, bash: { ...e.bash, output: 'x'.repeat(1000000) } }, rec({ type: 'bash_execution_update', delta: 'y'.repeat(100) })).entry;
  assert.equal(big.bash.output.length, 1000000, 'the output is capped at 1 MB, keeping its end');
  assert.ok(big.bash.output.endsWith('y'.repeat(100)));
  assert.equal(V.rpcReduce(null, rec({ type: 'bash_execution_update', delta: 'x' })).entry.bash, null);
  assert.equal(V.rpcReduce(e, { kind: 'exit' }).entry.bash, null);
  assert.equal(V.rpcFromStatus(e, { state: 'closed', pendingDialogs: [] }).bash, null);
  assert.equal(V.rpcFromStatus(e, { state: 'idle', pendingDialogs: [], bash: { command: 'ls', exclude: false, output: 'a\nb\n', running: true } }).bash.output, 'a\nb\n', 'a status read that reports it keeps it');
  assert.equal(V.rpcFromStatus(e, { state: 'idle', pendingDialogs: [] }).bash, null, 'RP252: a status with no command running ends it');
});

test('page: the shell bubble shows the command, the output escaped and the result; a long one is folded to its last 20 lines', () => {
  assert.equal(R.shellHtml(null), '');
  const running = R.shellHtml({ command: 'ls <x>', exclude: false, output: '<b>a</b>\n', running: true });
  assert.match(running, /\$ ls &lt;x&gt;/);
  assert.match(running, /&lt;b&gt;a&lt;\/b&gt;/);
  assert.match(running, /Running/);
  assert.doesNotMatch(running, /<b>a/);
  assert.match(R.shellHtml({ command: 'false', exclude: false, output: '', running: false, exitCode: 1 }), /Exit code 1/);
  assert.match(R.shellHtml({ command: 'ls', exclude: true, output: 'x', running: false, exitCode: 0 }), /Not sent to the model/);
  assert.match(R.shellHtml({ command: 'sleep 9', exclude: false, output: '', running: false, cancelled: true }), /Cancelled/);
  const lines = Array.from({ length: 30 }, (_, i) => `line${i + 1}`).join('\n');
  const folded = R.shellHtml({ command: 'seq', exclude: false, output: lines, running: false, exitCode: 0 });
  assert.match(folded, /data-act="shell-toggle"[^>]*>Show all 30 lines</);
  assert.doesNotMatch(folded, /line10\b/);
  assert.match(folded, /line11[\s\S]*line30/);
  const open = R.shellHtml({ command: 'seq', exclude: false, output: lines, running: false, exitCode: 0, open: true });
  assert.match(open, /line1\b[\s\S]*line30/);
  assert.match(open, />Show the last 20 lines</);
});
