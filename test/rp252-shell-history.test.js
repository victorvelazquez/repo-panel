'use strict';
// RP252: the output of a command run with ! or !! stays in the chat. pi writes each finished run to the session file as a `bashExecution` message (command, output,
// exitCode, cancelled, truncated, excludeFromContext); the history reader turns it into a `shell` item drawn like the live bubble. A command that still runs is not in
// the file yet: the server keeps it (command and the tail of its output) in the session status and announces its start and its end, so any tab (or a reload) shows it
// with its Stop. Temp dirs only.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'rp252-'));
const sessionsBase = path.join(scratch, 'sessions');
const repoDir = path.join(scratch, 'repo');
for (const d of [sessionsBase, repoDir]) fs.mkdirSync(d);
process.env.REPO_PANEL_CONFIG = path.join(scratch, 'config.json');
process.env.REPO_PANEL_SESSIONS_DIR = sessionsBase;
test.after(() => fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 5 }));

const S = require('../server/sessions.js');
const { createRpcHost, rpcApi } = require('../server/rpchost.js');
const V = require('../public/view.js');
const R = require('../public/resumen.js');

// ---------- the history (server/sessions.js) ----------
const header = (id) => JSON.stringify({ type: 'session', version: 3, id, timestamp: '2026-11-19T12:00:00.000Z', cwd: repoDir });
const user = (t) => JSON.stringify({ type: 'message', id: 'u1', timestamp: '2026-11-19T12:40:00.000Z', message: { role: 'user', content: [{ type: 'text', text: t }], timestamp: Date.parse('2026-11-19T12:40:00Z') } });
// The exact shape pi writes (taken from a real session file of this repo).
const bashRun = (fields, id = 'b1') => JSON.stringify({ type: 'message', id, parentId: 'u1', timestamp: '2026-11-19T12:48:48.952Z', message: { role: 'bashExecution', command: 'git status', output: 'On branch main\n', exitCode: 0, cancelled: false, truncated: false, timestamp: 1795092528952, excludeFromContext: false, ...fields } });
function putSession(id, lines) {
  const dir = S.sessionsDirFor(repoDir, sessionsBase);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `2026-11-19T12-00-00-000Z_${id}.jsonl`), lines.join('\n') + '\n');
}
const chatOf = (id) => S.readChat(repoDir, id, { base: sessionsBase });

test('history: a finished ! run is a shell item with its command, output, exit code and time, after the message before it', () => {
  putSession('s1', [header('s1'), user('hi'), bashRun({})]);
  const items = chatOf('s1').items;
  assert.equal(items.length, 2);
  assert.deepEqual(items[1], { role: 'system', kind: 'shell', id: 'b1', command: 'git status', output: 'On branch main\n', exitCode: 0, cancelled: false, truncated: false, exclude: false, at: '2026-11-19T12:48:48.952Z', tools: [] });
});

test('history: !! says its output was not sent to the model; a stopped run has no exit code and says cancelled; pi\'s cut output says so', () => {
  putSession('s2', [header('s2'), bashRun({ command: 'ls', excludeFromContext: true }, 'b1'), bashRun({ command: 'ping -n 30 127.0.0.1', exitCode: undefined, cancelled: true }, 'b2'), bashRun({ command: 'cat big', truncated: true, exitCode: 1 }, 'b3')]);
  const [a, b, c] = chatOf('s2').items;
  assert.deepEqual([a.command, a.exclude, a.exitCode], ['ls', true, 0]);
  assert.deepEqual([b.command, b.cancelled, b.exitCode], ['ping -n 30 127.0.0.1', true, null]);
  assert.deepEqual([c.truncated, c.exitCode], [true, 1]);
});

test('history: a long output keeps its END (the last characters) and says how many were left out; CRLF and controls are cleaned', () => {
  const long = 'x'.repeat(S.SHELL_HISTORY_MAX + 500) + 'END';
  putSession('s3', [header('s3'), bashRun({ output: long, command: 'a\u0007b' }), bashRun({ output: 'one\r\ntwo\u001b[0m\n' }, 'b2')]);
  const [a, b] = chatOf('s3').items;
  assert.equal(a.output.length, S.SHELL_HISTORY_MAX);
  assert.ok(a.output.endsWith('END'));
  assert.equal(a.cut, 503);
  assert.equal(a.command, 'a b');
  assert.equal(b.output, 'one\ntwo [0m\n');
  assert.equal(b.cut, undefined);
});

test('history: a bashExecution with no command string, or a bad id, is never a broken item', () => {
  putSession('s4', [header('s4'), bashRun({ command: 7 }, 'b1'), bashRun({ output: 9 }, 'bad id!')]);
  const items = chatOf('s4').items;
  assert.equal(items.length, 1);
  assert.deepEqual([items[0].output, items[0].id], ['', undefined]);
});

// ---------- the drawing (public/resumen.js) ----------
const chat = (items, extra = {}) => ({ id: 'aaa', info: { adopted: { id: 's1', name: 'pi' }, adoptedFound: true }, hist: { items }, ...extra });
const shellItem = (extra = {}) => ({ role: 'system', kind: 'shell', id: 'b1', command: 'git status', output: 'On branch main\n', exitCode: 0, cancelled: false, truncated: false, exclude: false, at: '2026-11-19T12:48:48.952Z', tools: [], ...extra });

test('drawing: a history shell item is the shell bubble with its command, output and exit code, and no Stop', () => {
  const html = R.chatBody(chat([shellItem()]));
  assert.match(html, /class="m shell"/);
  assert.match(html, /\$ git status/);
  assert.match(html, /On branch main/);
  assert.match(html, /Exit code 0/);
  assert.doesNotMatch(html, /shell-stop/);
  assert.match(R.chatBody(chat([shellItem({ exitCode: null, cancelled: true, exclude: true, truncated: true })])), /Cancelled · Not sent to the model · The output was cut/);
});

test('drawing: a long history output is folded to its last 20 lines; its button names the item, and the item opens when the chat says so', () => {
  const out = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join('\n');
  const folded = R.chatBody(chat([shellItem({ output: out })]));
  assert.match(folded, /data-act="shell-toggle" data-shell="b1"[^>]*>Show all 30 lines</);
  assert.doesNotMatch(folded, /line 10\n/);
  const open = R.chatBody(chat([shellItem({ output: out })], { shellOpen: { aaa: ['b1'] } }));
  assert.match(open, /line 1\n/);
  assert.match(open, />Show the last 20 lines</);
  assert.match(R.chatBody(chat([shellItem({ cut: 503 })])), /503 earlier characters are not shown/);
});

// ---------- the server (server/rpchost.js) ----------
const ACTIVE = { id: 'gentle-shell', command: 'C:\\L\\gentle-shell.exe', agentDir: 'C:\\a' };
async function hostWith() {
  const made = [];
  const sent = [];
  const gates = [];
  const createClient = (opts) => {
    const c = { opts, start: async () => ({}), answerDialog: () => false, pendingDialogs: () => [], state: () => 'idle', close() {} };
    c.request = async (type) => { if (type === 'bash') { await new Promise((r) => gates.push(r)); return { output: 'done\n', exitCode: 0, cancelled: false, truncated: false }; } return {}; };
    made.push(c);
    return c;
  };
  const host = createRpcHost({ resolve: async () => ({ active: ACTIVE }), repoOf: (id) => ({ id, path: 'C:\\repos\\alpha' }), publish: (id, p) => sent.push([id, p]), createClient, adoptedOf: () => null });
  await host.start('aaa');
  const delta = (d) => made[0].opts.onEvent({ kind: 'event', record: { type: 'bash_execution_update', delta: d } });
  return { host, sent, delta, release: () => gates.splice(0).forEach((r) => r()) };
}
const tick = () => new Promise((r) => setImmediate(r));

test('server: while a command runs the status says so with its command and the output so far; when it ends the status has none', async () => {
  const { host, delta, release } = await hostWith();
  assert.equal((await rpcApi(host).status({ id: 'aaa' })).bash, undefined);
  const run = rpcApi(host).bash({ id: 'aaa', text: '!!sleep 9' });
  await tick();
  delta('one\n');
  delta('two\n');
  const st = await rpcApi(host).status({ id: 'aaa' });
  assert.equal(st.bash.command, 'sleep 9');
  assert.equal(st.bash.exclude, true);
  assert.equal(st.bash.output, 'one\ntwo\n');
  assert.equal(st.bash.running, true);
  assert.ok(Number.isSafeInteger(st.bash.since) && st.bash.since > 0);
  release();
  await run;
  assert.equal((await rpcApi(host).status({ id: 'aaa' })).bash, undefined);
});

test('server: the output kept for the status is capped and keeps its end; output with no command running is not kept', async () => {
  const { host, delta, release } = await hostWith();
  delta('stray');
  assert.equal((await rpcApi(host).status({ id: 'aaa' })).bash, undefined);
  const run = rpcApi(host).bash({ id: 'aaa', text: '!yes' });
  await tick();
  delta('a'.repeat(300000));
  delta('TAIL');
  const out = (await rpcApi(host).status({ id: 'aaa' })).bash.output;
  assert.ok(out.length <= 200000);
  assert.ok(out.endsWith('TAIL'));
  release();
  await run;
});

test('server: every tab hears when a command starts and when it ends', async () => {
  const { host, sent, release } = await hostWith();
  const run = rpcApi(host).bash({ id: 'aaa', text: '!git status' });
  await tick();
  const start = sent.find(([, p]) => p.kind === 'event' && p.record.type === 'bash_start');
  assert.deepEqual(start[1].record, { type: 'bash_start', command: 'git status', exclude: false, since: start[1].record.since });
  release();
  await run;
  const end = sent.find(([, p]) => p.kind === 'event' && p.record.type === 'bash_end');
  assert.deepEqual(end, ['aaa', { kind: 'event', record: { type: 'bash_end' } }]);
});

// ---------- the live state of the page (public/view.js) ----------
test('page: a status that reports a running command rebuilds the bubble with its output and Stop (a reload, another tab)', () => {
  const e = V.rpcFromStatus(undefined, { state: 'idle', pendingDialogs: [], sessionId: 's', bash: { command: 'sleep 9', exclude: false, output: 'one\n', running: true, since: 5 } });
  assert.deepEqual(e.bash, { command: 'sleep 9', exclude: false, output: 'one\n', running: true, since: 5 });
  assert.match(R.shellHtml(e.bash), /data-act="shell-stop"/);
  const kept = V.rpcFromStatus({ ...e, bash: { ...e.bash, open: true } }, { state: 'idle', pendingDialogs: [], bash: { command: 'sleep 9', exclude: false, output: 'one\ntwo\n', running: true, since: 5 } });
  assert.deepEqual([kept.bash.output, kept.bash.open], ['one\ntwo\n', true]);
});

test('page: a status with no command ends a running bubble; a finished bubble waiting for the history stays; a bad bash is ignored', () => {
  const run = { command: 'x', exclude: false, output: '', running: true, since: 5 };
  assert.equal(V.rpcFromStatus({ ...V.rpcFromStatus(undefined, null), bash: run }, { state: 'idle', pendingDialogs: [] }).bash, null);
  const done = { ...run, running: false, exitCode: 0 };
  assert.deepEqual(V.rpcFromStatus({ ...V.rpcFromStatus(undefined, null), bash: done }, { state: 'idle', pendingDialogs: [] }).bash, done);
  assert.equal(V.rpcFromStatus(undefined, { state: 'idle', pendingDialogs: [], bash: { command: 7, running: true } }).bash, null);
});

test('page: bash_start opens the bubble in a tab that did not send it; its output then streams; bash_end closes it and reads the history once', () => {
  let e = V.rpcFromStatus(undefined, { state: 'idle', pendingDialogs: [] });
  e = V.rpcReduce(e, { kind: 'event', record: { type: 'bash_start', command: 'ls', exclude: true, since: 7 } }).entry;
  assert.deepEqual(e.bash, { command: 'ls', exclude: true, output: '', running: true, since: 7 });
  e = V.rpcReduce(e, { kind: 'event', record: { type: 'bash_output', delta: 'a\n' } }).entry;
  const own = V.rpcReduce({ ...e, bash: { ...e.bash, output: 'kept' } }, { kind: 'event', record: { type: 'bash_start', command: 'ls', exclude: true, since: 7 } }).entry;
  assert.equal(own.bash.output, 'kept', 'the tab that sent it keeps what it already has');
  const end = V.rpcReduce(e, { kind: 'event', record: { type: 'bash_end' } });
  assert.deepEqual([end.entry.bash.running, end.entry.bash.output, end.reload], [false, 'a\n', true]);
});

test('page: the live bubble leaves only when the history already has that run', () => {
  const bash = { command: 'git status', exclude: false, output: 'x', running: false, exitCode: 0, since: Date.parse('2026-11-19T12:48:40Z') };
  assert.equal(V.shellInHistory(bash, [shellItem()]), true);
  assert.equal(V.shellInHistory(bash, [shellItem({ command: 'ls' })]), false);
  assert.equal(V.shellInHistory(bash, [shellItem({ at: '2026-11-19T12:00:00.000Z' })]), false, 'an older run of the same command');
  assert.equal(V.shellInHistory({ ...bash, running: true }, [shellItem()]), false, 'a running command never leaves');
  assert.equal(V.shellInHistory(null, [shellItem()]), false);
});

// ---------- fixes from the independent verification ----------
test('page: a status read during a shell run still updates the commands the session did not load (RP233)', () => {
  const st = { state: 'idle', pendingDialogs: [], sessionId: 's', missing: ['flow-next'] };
  assert.deepEqual(V.rpcFromStatus(V.rpcFromStatus(undefined, null), { ...st, bash: { command: 'ls', output: '', running: true, since: 1 } }).missing, ['flow-next']);
  const own = { ...V.rpcFromStatus(undefined, null), bash: { command: 'ls', exclude: false, output: '', running: true, since: 1, own: true } };
  assert.deepEqual(V.rpcFromStatus(own, st).missing, ['flow-next'], 'the start answer of a session started by !cmd');
});

test('page: the bubble of the tab that sent the command is never ended by a status (a start answer, a status read sent before it); its own answer ends it', () => {
  const own = { command: 'sleep 9', exclude: false, output: 'a', running: true, since: 1, own: true };
  const base = { ...V.rpcFromStatus(undefined, null), bash: own };
  assert.deepEqual(V.rpcFromStatus(base, { state: 'idle', pendingDialogs: [] }).bash, own);
  const fresh = V.rpcFromStatus(base, { state: 'idle', pendingDialogs: [], bash: { command: 'sleep 9', exclude: false, output: 'a\nb', running: true, since: 2 } }).bash;
  assert.deepEqual([fresh.output, fresh.own], ['a\nb', true], 'the server output, still the own bubble');
  assert.equal(V.rpcFromStatus(base, { state: 'closed', pendingDialogs: [] }).bash, null, 'a closed session still ends it');
});

test('page: a finished own bubble does not make a command started from another tab its own, so a status can still end it', () => {
  const st = (o) => ({ state: 'idle', pendingDialogs: [], sessionId: 's', ...o });
  let e = V.rpcFromStatus(undefined, st({}));
  e.bash = { command: 'ls', exclude: false, output: 'x', running: false, exitCode: 0, since: 1, own: true };
  e = V.rpcFromStatus(e, st({ bash: { command: 'sleep 100', exclude: false, output: '', running: true, since: 5 } }));
  assert.notEqual(e.bash.own, true);
  assert.equal(V.rpcFromStatus(e, st({})).bash, null);
  const mine = { ...V.rpcFromStatus(undefined, st({})), bash: { command: 'ls', exclude: false, output: '', running: true, since: 1, own: true } };
  assert.equal(V.rpcFromStatus(mine, st({ bash: { command: 'other', exclude: false, output: '', running: true, since: 2 } })).bash.own, undefined, 'a different command is not this tab\'s');
});
