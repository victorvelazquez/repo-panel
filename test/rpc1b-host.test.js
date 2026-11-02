'use strict';
// RPC1b (S1, S2): server/rpchost.js, one pi session per repo inside the panel process. The client is a fake (the real one is tested in
// rpc1b-client.test.js), so nothing is spawned here.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createRpcHost, sessionIdFor } = require('../server/rpchost.js');
const { RpcError } = require('../server/rpc.js');
const { SESSION_ID } = require('../server/sessions.js');

const ACTIVE = { id: 'gentle-shell', command: 'C:\\L\\gentle-shell\\bin\\gentle-shell.cmd', agentDir: 'C:\\Users\\u\\.gentle-shell\\agent' };
const repos = {};
const addRepo = (id, p) => { repos[id] = { id, path: p }; return id; };
const repoOf = (id) => { if (!repos[id]) { const e = new Error('Unknown repository'); e.status = 404; throw e; } return repos[id]; };

function fakeFactory() {
  const made = [];
  const createClient = (opts) => {
    const c = {
      opts, closed: 0, started: 0, reqs: [], answers: [], dialogs: [], st: 'idle', failStart: null, gate: null,
      start() { c.started++; if (c.failStart) return Promise.reject(c.failStart); return c.gate || Promise.resolve({}); },
      request(type, fields) { c.reqs.push([type, fields]); return c.failRequest ? Promise.reject(c.failRequest) : Promise.resolve({ disposition: 'started' }); },
      answerDialog(id, a) { c.answers.push([id, a]); return c.dialogs.includes(id); },
      pendingDialogs: () => c.dialogs.map((id) => ({ id, method: 'select' })),
      state: () => c.st,
      close() { c.closed++; },
    };
    made.push(c);
    return c;
  };
  return { made, createClient };
}
function hostWith(over = {}) {
  const f = fakeFactory();
  const published = [];
  const host = createRpcHost({ resolve: async () => ({ active: ACTIVE }), repoOf, publish: (id, p) => published.push([id, p]), createClient: f.createClient, adoptedOf: () => null, ...over });
  return { host, published, ...f };
}
const CODE = (fn) => assert.rejects(fn, (e) => e.status !== undefined);

test('h1: one client per repo, started on demand; a second start returns the live one', async () => {
  const a = addRepo('aaa', 'C:\\repos\\alpha');
  const b = addRepo('bbb', 'C:\\repos\\beta');
  const { host, made } = hostWith();
  assert.equal(made.length, 0, 'nothing starts by itself');
  await host.start(a);
  await host.start(a);
  assert.equal(made.length, 1);
  assert.equal(made[0].started, 1);
  await host.start(b);
  assert.equal(made.length, 2);
});

test('h2: a double start while starting is single flight', async () => {
  const a = addRepo('aaa', 'C:\\repos\\alpha');
  const { host, made } = hostWith();
  const first = host.start(a);
  const second = host.start(a);
  await Promise.all([first, second]);
  assert.equal(made.length, 1);
  assert.equal(made[0].started, 1);
});

test('h3: more than max live sessions is a fixed error and nothing starts; a freed slot can be used again', async () => {
  const ids = [1, 2, 3, 4, 5, 6, 7].map((i) => addRepo(`r${i}`, `C:\\repos\\r${i}`));
  const { host, made } = hostWith();
  for (const id of ids.slice(0, 6)) await host.start(id);
  await assert.rejects(host.start(ids[6]), (e) => e.status === 409 && !/r7/.test(e.message));
  assert.equal(made.length, 6);
  made[0].opts.onExit({});
  await host.start(ids[6]);
  assert.equal(made.length, 7);
});

test('h3b: the cap also counts sessions that are still starting', async () => {
  const ids = [1, 2, 3].map((i) => addRepo(`c${i}`, `C:\\repos\\c${i}`));
  const made2 = [];
  let open;
  const gate = new Promise((r) => { open = r; });
  const { host } = hostWith({ max: 2, createClient: (o) => { const c = fakeFactory().createClient(o); c.gate = gate; made2.push(c); return c; } });
  const p1 = host.start(ids[0]);
  const p2 = host.start(ids[1]);
  await assert.rejects(host.start(ids[2]), (e) => e.status === 409);
  open();
  await Promise.all([p1, p2]);
  assert.equal(made2.length, 2);
});

test('h4: the folder is the repo path from the config, never something the caller passes', async () => {
  const a = addRepo('aaa', 'C:\\repos\\alpha');
  const { host, made } = hostWith();
  await host.start(a, { cwd: 'C:\\evil', command: 'calc', args: ['--x'] });
  assert.equal(made[0].opts.cwd, 'C:\\repos\\alpha');
  assert.equal(made[0].opts.command, ACTIVE.command);
  assert.deepEqual(made[0].opts.args.slice(0, 3), ['--mode', 'rpc', '--session-id']);
  assert.equal(made[0].opts.args.length, 4);
});

test('h5: --session-id is the adopted one, else panel-<slug>, and always passes SESSION_ID', async () => {
  const a = addRepo('aaa', 'C:\\repos\\alpha');
  const adopted = hostWith({ adoptedOf: (id) => (id === a ? { id: 'adopted-1.x' } : null) });
  await adopted.host.start(a);
  assert.deepEqual(adopted.made[0].opts.args, ['--mode', 'rpc', '--session-id', 'adopted-1.x']);
  const names = ['My App', 'alpha', 'ünï cödé', '...', 'a'.repeat(200), 'x;rm -rf', '  ', 'a b\\c'];
  for (const [i, name] of names.entries()) {
    const id = addRepo(`n${i}`, `C:\\repos\\${name}`);
    const h = hostWith();
    await h.host.start(id);
    const sid = h.made[0].opts.args[3];
    assert.match(sid, SESSION_ID, name);
    assert.ok(sid === `panel-alpha` || sid.startsWith('panel-') || sid === id, name);
  }
  const plain = hostWith();
  await plain.host.start(addRepo('p1', 'C:\\repos\\My App'));
  assert.equal(plain.made[0].opts.args[3], 'panel-my-app');
  const bad = hostWith({ adoptedOf: () => ({ id: '../evil;x' }) });
  await bad.host.start(a);
  assert.match(bad.made[0].opts.args[3], SESSION_ID);
  assert.equal(bad.made[0].opts.args[3].startsWith('panel-'), true);
});

test('h6: the environment of the child has no PI_*, GENTLE_* or ENGRAM_* from the panel', async () => {
  const a = addRepo('aaa', 'C:\\repos\\alpha');
  const keys = { PI_CODING_AGENT_DIR: 'leak1', GENTLE_SHELL_X: 'leak2', ENGRAM_URL: 'leak3', RPC1B_KEEP: 'kept' };
  Object.assign(process.env, keys);
  try {
    const { host, made } = hostWith();
    await host.start(a);
    const env = made[0].opts.env;
    assert.equal(Object.keys(env).filter((k) => /^(PI_|GENTLE_|ENGRAM_)/i.test(k)).length, 0);
    assert.equal(env.RPC1B_KEEP, 'kept');
    const pi = hostWith({ resolve: async () => ({ active: { id: 'pi', command: 'C:\\n\\pi.cmd', agentDir: 'D:\\pi' } }) });
    await pi.host.start(a);
    assert.equal(pi.made[0].opts.env.PI_CODING_AGENT_DIR, 'D:\\pi', 'only the chosen runtime sets its own folder');
    assert.equal(pi.made[0].opts.env.GENTLE_SHELL_X, undefined);
  } finally { for (const k of Object.keys(keys)) delete process.env[k]; }
});

test('h7: with no usable runtime nothing starts and the error is fixed, never the config text', async () => {
  const a = addRepo('aaa', 'C:\\repos\\alpha');
  const { host, made } = hostWith({ resolve: async () => ({ active: null, problem: 'config.json pi.command: C:\\secret\\thing' }) });
  await assert.rejects(host.start(a), (e) => e.status === 409 && !/secret|config/.test(e.message));
  assert.equal(made.length, 0);
  const boom = hostWith({ resolve: async () => { throw new Error('C:\\secret'); } });
  await assert.rejects(boom.host.start(a), (e) => !/secret/.test(e.message));
});

test('h8: an exited client is removed and the next start launches a new one; a failed start leaves nothing behind', async () => {
  const a = addRepo('aaa', 'C:\\repos\\alpha');
  const { host, made, published } = hostWith();
  await host.start(a);
  made[0].opts.onExit({ reason: 'exit' });
  assert.deepEqual(await host.status(a), { state: 'closed', pendingDialogs: [], sessionId: null });
  assert.ok(published.some(([id, p]) => id === a && p.kind === 'exit'));
  await host.start(a);
  assert.equal(made.length, 2);
  made[1].opts.onExit({});
  const f2 = hostWith({ createClient: (o) => { const c = fakeFactory().createClient(o); c.failStart = new RpcError('C:\\secret'); made3.push(c); return c; } });
  const made3 = [];
  await assert.rejects(f2.host.start(a), (e) => e.status === 502 && !/secret/.test(e.message));
  assert.equal(made3[0].closed, 1);
  assert.equal((await f2.host.status(a)).state, 'closed');
  await assert.rejects(f2.host.start(a), (e) => e.status === 502);
  assert.equal(made3.length, 2, 'a failed start does not block the next one');
});

test('h9: closeAll closes every client', async () => {
  const ids = ['a1', 'a2', 'a3'].map((i) => addRepo(i, `C:\\repos\\${i}`));
  const { host, made } = hostWith();
  for (const id of ids) await host.start(id);
  host.closeAll();
  assert.deepEqual(made.map((c) => c.closed), [1, 1, 1]);
  assert.equal((await host.status(ids[0])).state, 'closed');
  host.closeAll();
  assert.deepEqual(made.map((c) => c.closed), [1, 1, 1]);
});

test('h10: text from the browser is cleaned like the chat does and refused when empty, too long or starting with !', async () => {
  const a = addRepo('aaa', 'C:\\repos\\alpha');
  const { host, made } = hostWith();
  await host.start(a);
  const c = made[0];
  await host.prompt(a, '  hello\r\nworld\u0007\t!x\u001b[31m\u202e\u200b \r');
  assert.deepEqual(c.reqs.at(-1), ['prompt', { message: 'hello\nworld\t!x[31m' }]);
  c.reqs.length = 0;
  for (const bad of ['', '  \n\t ', '\u0007\u001b', '!ls', '  !rm -rf', '!!x', 'x'.repeat(20001), 5, null, undefined, {}]) await CODE(() => host.prompt(a, bad));
  await CODE(() => host.steer(a, '!ls'));
  assert.deepEqual(c.reqs, [], 'a refused text sends nothing');
  const max = 'y'.repeat(20000);
  await host.prompt(a, max);
  assert.equal(c.reqs.at(-1)[1].message, max, 'exactly 20000 characters goes whole');
});

test('h11: behavior is only steer or followUp; steer and abort have their own commands', async () => {
  const a = addRepo('aaa', 'C:\\repos\\alpha');
  const { host, made } = hostWith();
  await host.start(a);
  const c = made[0];
  await host.prompt(a, 'x', { behavior: 'steer' });
  await host.prompt(a, 'x', { behavior: 'followUp' });
  await host.prompt(a, 'x', {});
  assert.deepEqual(c.reqs, [['prompt', { message: 'x', streamingBehavior: 'steer' }], ['prompt', { message: 'x', streamingBehavior: 'followUp' }], ['prompt', { message: 'x' }]]);
  c.reqs.length = 0;
  for (const bad of ['Steer', 'queue', '', 5, null, {}]) await CODE(() => host.prompt(a, 'x', { behavior: bad }));
  assert.deepEqual(c.reqs, []);
  await host.steer(a, ' go left ');
  await host.abort(a);
  assert.deepEqual(c.reqs, [['steer', { message: 'go left' }], ['abort', {}]]);
});

test('h12: without a started session nothing is sent and nothing is started', async () => {
  const a = addRepo('aaa', 'C:\\repos\\alpha');
  const { host, made } = hostWith();
  for (const fn of [() => host.prompt(a, 'x'), () => host.steer(a, 'x'), () => host.abort(a), () => host.answer(a, 'd1', { cancelled: true })]) await assert.rejects(fn, (e) => e.status === 409);
  assert.equal(made.length, 0);
  await assert.rejects(host.prompt('nope', 'x'), (e) => e.status === 404);
  await assert.rejects(host.start('nope'), (e) => e.status === 404);
  await assert.rejects(host.status('nope'), (e) => e.status === 404);
});

test('h13: answer only goes through for a pending dialog', async () => {
  const a = addRepo('aaa', 'C:\\repos\\alpha');
  const { host, made } = hostWith();
  await host.start(a);
  made[0].dialogs.push('d1');
  await assert.rejects(host.answer(a, 'invented', { value: 'x' }), (e) => e.status === 409);
  assert.deepEqual(await host.answer(a, 'd1', { value: 'x' }), { ok: true });
  assert.deepEqual(made[0].answers.at(-1), ['d1', { value: 'x' }]);
});

test('h14: status carries state, pending dialogs and the session id; events are published without an `id` key of their own', async () => {
  const a = addRepo('aaa', 'C:\\repos\\alpha');
  const { host, made, published } = hostWith();
  await host.start(a);
  made[0].st = 'asking';
  made[0].dialogs.push('d9');
  assert.deepEqual(await host.status(a), { state: 'asking', pendingDialogs: [{ requestId: 'd9', method: 'select' }], sessionId: 'panel-alpha' });
  made[0].opts.onEvent({ kind: 'dialog', id: 'd9', method: 'select', title: 'T' });
  made[0].opts.onEvent({ kind: 'event', record: { type: 'agent_start' } });
  made[0].opts.onEvent({ kind: 'event', record: { type: 'huge', text: 'z'.repeat(400000) } });
  const out = published.filter(([, p]) => p.kind !== 'state' && p.kind !== 'exit');
  assert.deepEqual(out[0], [a, { kind: 'dialog', requestId: 'd9', method: 'select', title: 'T' }]);
  assert.deepEqual(out[1], [a, { kind: 'event', record: { type: 'agent_start' } }]);
  assert.deepEqual(out[2], [a, { kind: 'event', record: { type: 'huge' } }]);
});

test('h5b: the slug of panel-<slug> is the last folder with either separator, on any platform, and a root path falls back to the repo id', () => {
  const slug = (p, id = 'ab1') => sessionIdFor({ path: p, id }, null);
  assert.equal(slug('C:\\repos\\My App'), 'panel-my-app');
  assert.equal(slug('/home/u/repos/my-app/'), 'panel-my-app');
  assert.equal(slug('C:/repos/my-app'), 'panel-my-app');
  assert.equal(slug('/', 'ab1'), 'panel-ab1', 'no folder name: the repo id, never a throw');
  assert.equal(slug('C:\\'), 'panel-ab1');
  for (const p of ['C:\\repos\\x y', '/a/b', '/', 'C:\\']) assert.match(slug(p), SESSION_ID);
});

test('h16: a start that was waiting for the runtime when closeAll ran creates no client, and the host works again afterwards', async () => {
  const a = addRepo('aaa', 'C:\\repos\\alpha');
  let release;
  const { host, made } = hostWith({ resolve: () => new Promise((r) => { release = r; }) });
  const starting = host.start(a);
  host.closeAll();
  release({ active: ACTIVE });
  await assert.rejects(starting, (e) => e.status === 503);
  assert.equal(made.length, 0, 'no client was created after closeAll');
  assert.equal((await host.status(a)).state, 'closed');
  const again = host.start(a);
  release({ active: ACTIVE });
  await again;
  assert.equal(made.length, 1, 'a later start still works');
});

test('h15: a failing command is an HTTP error with a fixed message', async () => {
  const a = addRepo('aaa', 'C:\\repos\\alpha');
  const { host, made } = hostWith();
  await host.start(a);
  made[0].failRequest = new RpcError('The agent rejected the command');
  await assert.rejects(host.prompt(a, 'x'), (e) => e.status === 409 && e.message === 'The agent rejected the command');
  made[0].failRequest = new Error('C:\\secret raw');
  await assert.rejects(host.prompt(a, 'x'), (e) => e.status >= 500 && !/secret/.test(e.message));
});
