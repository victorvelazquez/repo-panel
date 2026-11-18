'use strict';
// RP233: the commands are checked. When a session starts, the panel asks pi for its commands (`get_commands`) once and keeps the list in memory; a /flow-* key
// whose command is not loaded is refused by the server and its button goes off with the reason. A send is confirmed only when pi did not say it handled or queued it
// (`data.disposition`); a pi that says nothing about it stays confirmed, as before. Put in conditions and Fix PR are plain text, never checked against the list.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'rp233-'));
process.env.REPO_PANEL_CONFIG = path.join(scratch, 'config.json');
test.after(() => fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 5 }));

const lib = require('../lib.js');
const { piSend, sendLock } = require('../server/pi.js');
const { createRpcHost } = require('../server/rpchost.js');
const V = require('../public/view.js');

const REPO = { id: 'r1', path: 'C:\\dev\\repo' };
const refuses = (p, status, re) => assert.rejects(p, (e) => e.status === status && re.test(e.message));

// The rpc host's side of a send: what prompt answers, and the commands the session loaded (null: the list is unknown).
function fakeHost({ answer = { disposition: 'started' }, commands = null } = {}) {
  const sent = [];
  return { sent, status: async () => ({ state: 'idle' }), commandsOf: () => commands, prompt: async (id, text) => { sent.push(text); return answer; } };
}
const FLOW = Object.values(lib.PI_COMMANDS).map((t) => t.split(' ')[0].slice(1));

// ---------- the answer of pi ----------
test('piSend: a prompt pi started is confirmed', async () => {
  assert.deepEqual(await piSend(REPO, 'flow-ship', fakeHost()), { sent: true, confirmed: true });
});

test('piSend: a prompt an extension handled is not confirmed, and a Retry goes at once', async () => {
  const lock = sendLock();
  const h = fakeHost({ answer: { disposition: 'handled' } });
  assert.deepEqual(await piSend(REPO, 'flow-ship', h, undefined, { lock }), { sent: true, confirmed: false, disposition: 'handled' });
  assert.deepEqual(await piSend(REPO, 'flow-ship', h, undefined, { lock }), { sent: true, confirmed: false, disposition: 'handled' });
  assert.deepEqual(h.sent, ['/flow-ship', '/flow-ship']);
});

// RP234: there is no time window any more; what holds a second order after a queued one is the state of the session (busy), which the real host reports.
test('piSend: a prompt pi queued is not confirmed, and it frees the send lock', async () => {
  const lock = sendLock();
  const h = fakeHost({ answer: { disposition: 'queued' } });
  assert.deepEqual(await piSend(REPO, 'flow-pr', h, undefined, { lock }), { sent: true, confirmed: false, disposition: 'queued' });
  assert.doesNotThrow(() => { lock.take(REPO); lock.free(REPO); });
  assert.deepEqual(h.sent, ['/flow-pr']);
});

test('piSend: an answer with no disposition, or one outside the closed list, stays confirmed and is never forwarded', async () => {
  for (const answer of [{}, undefined, null, { disposition: 'weird' }, { disposition: 7 }]) {
    assert.deepEqual(await piSend(REPO, 'flow-base', fakeHost({ answer })), { sent: true, confirmed: true }, JSON.stringify(answer));
  }
});

// ---------- the list of commands ----------
test('piSend: a /flow-* command that is not loaded is refused with its name, nothing is prompted and the send lock is not taken', async () => {
  const lock = sendLock();
  const h = fakeHost({ commands: ['flow-pr', 'skill:flow-ship'] });
  await refuses(piSend(REPO, 'flow-ship', h, undefined, { lock }), 409, /^\/flow-ship is not loaded in this session/);
  await refuses(piSend(REPO, 'flow-ship-unstage', h, undefined, { lock }), 409, /^\/flow-ship is not loaded in this session/);
  assert.deepEqual(h.sent, []);
  h.commandsOf = () => [...FLOW];
  assert.deepEqual(await piSend(REPO, 'flow-ship', h, undefined, { lock }), { sent: true, confirmed: true });
  assert.deepEqual(h.sent, ['/flow-ship']);
});

test('piSend: a loaded command is sent, an unknown list blocks nothing, and a host with no list sends as before', async () => {
  const loaded = fakeHost({ commands: ['flow-pr'] });
  assert.deepEqual(await piSend(REPO, 'flow-pr', loaded), { sent: true, confirmed: true });
  assert.deepEqual(await piSend(REPO, 'flow-next', fakeHost({ commands: null })), { sent: true, confirmed: true });
  const old = fakeHost();
  delete old.commandsOf;
  assert.deepEqual(await piSend(REPO, 'flow-next', old), { sent: true, confirmed: true });
});

test('piSend: put-in-conditions is plain text and is never checked against the list', async () => {
  const h = fakeHost({ commands: [] });
  const requirements = async () => ({ available: true, results: [{ id: 'roadmap', status: 'fail', level: 'required' }] });
  assert.deepEqual(await piSend(REPO, 'put-in-conditions', h, requirements), { sent: true, confirmed: true });
  assert.match(h.sent[0], /^Put this repo in conditions/);
});

// ---------- the host asks for the list once ----------
const ACTIVE = { id: 'gentle-shell', command: 'C:\\L\\gentle-shell.exe', agentDir: 'C:\\a' };
function hostWith(commands, { commandsMs } = {}) {
  const asked = [];
  const createClient = () => ({
    start: async () => ({}), answerDialog: () => false, pendingDialogs: () => [], state: () => 'idle', close() {},
    request: (type) => { asked.push(type); return type === 'get_commands' ? commands() : Promise.resolve({}); },
  });
  const host = createRpcHost({ resolve: async () => ({ active: ACTIVE }), repoOf: (id) => ({ id, path: 'C:\\repos\\alpha' }), publish: () => {}, createClient, adoptedOf: () => null, ...(commandsMs ? { commandsMs } : {}) });
  return { host, asked };
}

test('host: the start asks pi for its commands once; the status names the /flow-* keys that are not loaded', async () => {
  const list = [{ name: 'flow-pr', source: 'prompt' }, { name: 'flow-base', source: 'prompt' }, { name: 'skill:flow-ship', source: 'skill' }, { name: 7 }, 'flow-next'];
  const { host, asked } = hostWith(async () => ({ commands: list }));
  const st = await host.start('aaa');
  assert.deepEqual(st.missing, ['flow-ship', 'flow-ship-unstage', 'flow-commit', 'flow-commit-unstage', 'flow-next']);
  assert.deepEqual(host.commandsOf('aaa'), ['flow-pr', 'flow-base', 'skill:flow-ship']);
  await host.start('aaa');
  assert.deepEqual(asked, ['get_commands']);
  assert.equal(host.commandsOf('nobody'), null);
});

test('host: every /flow-* command loaded leaves nothing missing', async () => {
  const { host } = hostWith(async () => ({ commands: FLOW.map((name) => ({ name, source: 'prompt' })) }));
  assert.deepEqual((await host.start('aaa')).missing, []);
});

test('host: a failed, malformed or slow get_commands leaves the list unknown and the start still succeeds', async () => {
  for (const commands of [async () => { throw new Error('no'); }, async () => ({ commands: 'x' }), async () => null, () => new Promise(() => {})]) {
    const { host } = hostWith(commands, { commandsMs: 20 });
    const st = await host.start('aaa');
    assert.equal(st.state, 'idle');
    assert.equal('missing' in st, false);
    assert.equal(host.commandsOf('aaa'), null);
  }
});

// ---------- the page ----------
test('page: the status keeps the missing keys it knows; a closed session or a status without them knows none', () => {
  const e = V.rpcFromStatus(null, { state: 'idle', pendingDialogs: [], missing: ['flow-ship', 'nope', 3, 'flow-pr'] });
  assert.deepEqual(e.missing, ['flow-ship', 'flow-pr']);
  assert.deepEqual(V.rpcFromStatus(e, { state: 'closed', pendingDialogs: [] }).missing, []);
  assert.deepEqual(V.rpcFromStatus(e, { state: 'busy', pendingDialogs: [] }).missing, ['flow-ship', 'flow-pr']);
  assert.deepEqual(V.rpcFromStatus(null, { state: 'idle', pendingDialogs: [] }).missing, []);
});

const local = (o = {}) => ({ branch: 'task', detached: false, upstream: 'origin/task', noUpstream: false, ahead: 0, behind: 0, files: [{ path: 'a.txt', status: 'M', untracked: false }], head: 'b'.repeat(40), inProgress: null, base: 'main', ...o });
const prs = { prs: [], stale: null };

test('page: a delivery button whose command is not loaded is off with the reason; the others and the lists without it are unchanged', () => {
  const now = Date.parse('2026-11-18T12:00:00Z');
  assert.deepEqual(V.flowButtons(local(), prs, null, { now, missing: ['flow-ship'] }), [{ cmd: 'flow-ship', label: '/flow-ship', disabled: true, reason: '/flow-ship is not loaded in this session' }]);
  assert.deepEqual(V.flowButtons(local({ stagedCount: 1 }), prs, null, { now, missing: ['flow-ship-unstage'] })[0].reason, '/flow-ship is not loaded in this session');
  assert.deepEqual(V.flowButtons(local(), prs, null, { now, missing: ['flow-pr'] }), [{ cmd: 'flow-ship', label: '/flow-ship' }]);
  assert.deepEqual(V.flowButtons(local(), prs, null, { now, missing: [] }), V.flowButtons(local(), prs, null, { now }));
  assert.deepEqual(V.flowButtons(local({ files: [], ahead: 1 }), prs, null, { now, missing: ['flow-pr'] }), [{ cmd: 'flow-pr', label: '/flow-pr', disabled: true, reason: '/flow-pr is not loaded in this session' }]);
});

test('page: the toast says sent only for a confirmed send, and names what pi did otherwise', () => {
  assert.deepEqual(V.sentToast('/flow-ship', { sent: true, confirmed: true }), { text: 'Sent /flow-ship to the session', tone: 'ok' });
  assert.deepEqual(V.sentToast('/flow-ship', { sent: true, confirmed: false, disposition: 'handled' }), { text: 'The session handled /flow-ship without starting a run: check the session', tone: '' });
  assert.deepEqual(V.sentToast('/flow-pr', { sent: true, confirmed: false, disposition: 'queued' }), { text: 'The session queued /flow-pr: it runs when the current work ends', tone: '' });
  assert.deepEqual(V.sentToast('/flow-pr', { sent: true, confirmed: false }), { text: 'Sent /flow-pr, not confirmed: check the session', tone: '' });
});
