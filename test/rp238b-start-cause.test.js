'use strict';
// RP238b: when a session does not start or dies by itself, the panel says why with ONE category of a closed list, read from what pi wrote as an error. pi's error
// output was dropped (stdio ignore); now the server keeps only its last 16 KB, always drains it (a chatty pi never blocks on a full pipe) and never sends or logs it:
// only the category travels. pi in --mode rpc also writes there what is not an error, so only known messages count. Fake children only.
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'rp238b-'));
process.env.REPO_PANEL_CONFIG = path.join(scratch, 'config.json');
test.after(() => fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 5 }));

const { createRpcClient, causeOf, CAUSES } = require('../server/rpc.js');
const { createRpcHost } = require('../server/rpchost.js');
const V = require('../public/view.js');

const red = (s) => `\u001b[31m${s}\u001b[39m`;

// ---------- the text -> a category ----------
test('causeOf: the messages pi writes before it exits are the four categories, also coloured; anything else is null', () => {
  assert.equal(causeOf(red('No models available. Use /login or set an API key environment variable.')), 'no-model');
  assert.equal(causeOf('No API key found for anthropic.'), 'no-model');
  assert.equal(causeOf(red('Error: Failed to load extension "C:\\x\\ext.js": boom') + '\n' + 'Hint: Start without extensions using "pi -ne".'), 'extension');
  assert.equal(causeOf('Error: Session id must be non-empty, contain only alphanumeric characters'), 'session');
  assert.equal(causeOf("Session already exists with id 'abc'"), 'session');
  assert.equal(causeOf("No session found matching 'abc'"), 'session');
  assert.equal(causeOf('No [1mmodels[22m available.'), 'no-model', 'a code inside the phrase (a bold word)');
  assert.equal(causeOf('Error: --session-id cannot be combined with --continue'), 'session');
  assert.equal(causeOf(red('Error: The current working directory no longer exists. Please cd to a valid directory.')), 'folder');
  for (const t of ["Warning: No project session found with id 'x'; creating a new session with that id.", 'Warning: Could not restore model p/m', 'some log line', '', undefined, null, 7]) assert.equal(causeOf(t), null, String(t));
});

test('causeOf (verification A1, A2): only the last lines pi wrote count, and the match closest to the end wins', () => {
  const noise = Array.from({ length: 10 }, (_, i) => `[tool] step ${i}`).join('\n');
  assert.equal(causeOf(`[ext] tool output: No API key found for "openai" (subagent skipped)\n${noise}\nTypeError: boom`), null, 'an old tool line is not the cause');
  assert.equal(causeOf('Warning: x Failed to load extension "y" (noise)\nsomething\nNo models available.'), 'no-model', 'the last fatal line wins over an earlier one');
  assert.equal(causeOf(`${red('Error: Failed to load extension "x"')}\nHint: Start without extensions using "pi -ne".\n\n`), 'extension', 'a hint line after it still lets it count');
});

// ---------- the client (server/rpc.js) ----------
// A fake pi: it answers every request unless it is told to fail; its error output is an emitter like a real pipe.
function fakePi() {
  const c = new EventEmitter();
  c.pid = 4242;
  c.stdout = new EventEmitter();
  c.stderr = new EventEmitter();
  c.kill = () => {};
  c.answer = true;
  c.stdin = Object.assign(new EventEmitter(), {
    write(s) {
      if (c.answer) for (const l of String(s).split('\n').filter(Boolean)) {
        const r = JSON.parse(l);
        if (r.id) setImmediate(() => c.stdout.emit('data', `${JSON.stringify({ id: r.id, type: 'response', command: r.type, success: true, data: r.type === 'get_state' ? { isStreaming: false } : { commands: [] } })}\n`));
      }
      return true;
    },
    end() { setImmediate(() => { c.emit('exit', 0, null); if (c.stderr) c.stderr.emit('end'); c.emit('close', 0, null); }); },
  });
  c.err = (s) => c.stderr.emit('data', Buffer.from(s));
  // Node may report the exit BEFORE the last error output is read: the exit comes first here on purpose.
  c.die = (text = '') => { c.emit('exit', 1, null); if (text) c.err(text); setImmediate(() => { c.stderr.emit('end'); c.emit('close', 1, null); }); };
  return c;
}
const spawnOf = (children) => (file) => (file === 'taskkill' ? new EventEmitter() : children[children.push(fakePi()) - 1]);
const clientWith = (children, extra = {}) => createRpcClient({ command: 'C:\\x\\pi.exe', args: [], cwd: scratch, env: {}, spawn: spawnOf(children), platform: 'win32', graceMs: 50, killWaitMs: 50, causeWaitMs: 200, ...extra });

test('client: a pi that exits during the start, with its error written after the exit, gives the category once its error output ends', async () => {
  const kids = [];
  const client = clientWith(kids, { spawn: (f) => { const s = spawnOf(kids)(f); if (f !== 'taskkill') { s.answer = false; setImmediate(() => s.die(red('No models available.'))); } return s; } });
  await assert.rejects(client.start(), /could not be started|ended/);
  assert.equal(await client.cause(), 'no-model');
});

test('client: the error output is always drained and only its END is kept (16 KB): a match at the end counts, one pushed out of the window does not', async () => {
  const kids = [];
  const a = clientWith(kids);
  await a.start();
  kids[0].err('Error: Failed to load extension "x"\n');
  for (let i = 0; i < 400; i++) kids[0].err('x'.repeat(10000)); // 4 MB: never kept, never blocks
  kids[0].die();
  assert.equal(await a.cause(), null, 'the old line is out of the window');
  const b = clientWith(kids);
  await b.start();
  for (let i = 0; i < 400; i++) kids[1].err('y'.repeat(10000));
  kids[1].die('Error: The current working directory no longer exists.');
  assert.equal(await b.cause(), 'folder');
});

test('client: an error output that never ends gives its category at the cap; a fake child with no error output still works and has none', async () => {
  const kids = [];
  const client = clientWith(kids);
  await client.start();
  kids[0].err('No models available.');
  const t0 = Date.now();
  assert.equal(await client.cause(), 'no-model');
  assert.ok(Date.now() - t0 < 1000);
  const bare = createRpcClient({ command: 'C:\\x\\pi.exe', args: [], cwd: scratch, env: {}, platform: 'win32', graceMs: 50, killWaitMs: 50, causeWaitMs: 50, spawn: (f) => { if (f === 'taskkill') return new EventEmitter(); const c = fakePi(); delete c.stderr; return c; } });
  await bare.start();
  assert.equal(await bare.cause(), null);
  await bare.close();
  await client.close();
});

test('client: the cause waits for error output that arrives after it was asked (Node may report the exit first)', async () => {
  const kids = [];
  const client = clientWith(kids, { causeWaitMs: 500 });
  await client.start();
  kids[0].emit('exit', 1, null);
  const p = client.cause();
  setTimeout(() => { kids[0].err('No models available.'); kids[0].stderr.emit('end'); kids[0].emit('close', 1, null); }, 30);
  assert.equal(await p, 'no-model');
});

// ---------- the host (server/rpchost.js) ----------
const ACTIVE = { id: 'gentle-shell', command: 'C:\\L\\gentle-shell.exe', agentDir: 'C:\\a' };
function hostWith({ failWith = null } = {}) {
  const kids = [];
  const sent = [];
  const spawn = (f) => {
    const s = spawnOf(kids)(f);
    if (f !== 'taskkill' && failWith !== null) { s.answer = false; setImmediate(() => s.die(failWith)); }
    return s;
  };
  const createClient = (opts) => createRpcClient({ ...opts, spawn, platform: 'win32', graceMs: 50, killWaitMs: 50, causeWaitMs: 200 });
  const host = createRpcHost({ resolve: async () => ({ active: ACTIVE }), repoOf: (id) => ({ id, path: 'C:\\repos\\alpha' }), publish: (id, p) => sent.push([id, p]), createClient, adoptedOf: () => null });
  return { host, sent, kids };
}
const SECRET = 'sk-live-SECRET-123 <script>alert(1)</script>';
const until = async (fn, ms = 2000) => { const end = Date.now() + ms; while (Date.now() < end) { if (fn()) return; await new Promise((r) => setTimeout(r, 5)); } throw new Error('timed out waiting'); };

test('host ABUSE: a start that fails says the category with a fixed text; the text pi wrote (a key, HTML) never reaches the answer or any event', async () => {
  const { host, sent } = hostWith({ failWith: `${SECRET}\n${red('No models available.')}\n${SECRET}` });
  await assert.rejects(host.start('aaa'), (e) => e.status === 502 && e.message === 'The session could not be started: No model or login is set up: run pi in a terminal to sign in');
  assert.ok(!JSON.stringify(sent).includes('SECRET') && !JSON.stringify(sent).includes('<script>'));
});

test('host: a start that fails with an unknown error keeps today\'s message, and so does one with nothing written', async () => {
  for (const failWith of [`${SECRET} something else`, '']) {
    const { host } = hostWith({ failWith });
    await assert.rejects(host.start('aaa'), (e) => e.status === 502 && e.message === 'The session could not be started');
  }
});

test('host ABUSE: a session that dies by itself publishes the exit at once and then its category, never the text', async () => {
  const { host, sent, kids } = hostWith();
  await host.start('aaa');
  kids[0].die(`Error: Failed to load extension "x": ${SECRET}`);
  await until(() => sent.some(([, p]) => p.kind === 'ended'));
  const kinds = sent.map(([, p]) => p.kind);
  assert.ok(kinds.indexOf('exit') < kinds.indexOf('ended'));
  assert.deepEqual(sent.find(([, p]) => p.kind === 'ended'), ['aaa', { kind: 'ended', cause: 'extension' }]);
  assert.ok(!JSON.stringify(sent).includes('SECRET') && !JSON.stringify(sent).includes('<script>'));
});

test('host: a session the panel closes says no cause, and one that dies with an unknown error neither', async () => {
  const a = hostWith();
  await a.host.start('aaa');
  a.kids[0].err('No models available.');
  await a.host.close('aaa');
  const b = hostWith();
  await b.host.start('aaa');
  b.kids[0].die(SECRET);
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(a.sent.filter(([, p]) => p.kind === 'ended').length, 0);
  assert.equal(b.sent.filter(([, p]) => p.kind === 'ended').length, 0);
  assert.ok(b.sent.some(([, p]) => p.kind === 'exit'));
});

test('client (verification): an error output that already ended before cause() is asked answers at once, not at the cap', async () => {
  const kids = [];
  const client = clientWith(kids, { causeWaitMs: 5000 });
  await client.start();
  kids[0].die('No models available.');
  await new Promise((r) => setTimeout(r, 50));
  const t0 = Date.now();
  assert.equal(await client.cause(), 'no-model');
  assert.ok(Date.now() - t0 < 100);
});

test('host (verification): a session that dies while a new one of the repo is live publishes no ended', async () => {
  const { host, sent, kids } = hostWith();
  await host.start('aaa');
  kids[0].emit('exit', 1, null);
  kids[0].err('No models available.'); // its error output does not end: the cause waits for the cap
  await host.start('aaa');
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(sent.filter(([, p]) => p.kind === 'ended').length, 0);
});

// ---------- the page (public/view.js) ----------
test('page: the ended event passes the stream filter; its note names the cause with the same fixed text as the server; an unknown cause has no note', () => {
  assert.deepEqual(V.CAUSE_TEXT, CAUSES);
  assert.equal(V.rpcEvent({ event: 'rpc', data: JSON.stringify({ id: 'abcdef0123', kind: 'ended', cause: 'folder' }) }).cause, 'folder');
  assert.equal(V.endedNote({ kind: 'ended', cause: 'folder' }), 'The session ended: The repo folder no longer exists');
  for (const p of [{ kind: 'ended', cause: 'constructor' }, { kind: 'ended', cause: 'x' }, { kind: 'exit' }, null]) assert.equal(V.endedNote(p), null);
});
