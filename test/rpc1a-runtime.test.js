'use strict';
// RPC1a (S1, S2, S11), part a: server/piruntime.js. The panel will LAUNCH a program, so these are the abuse cases: a `command` that is not
// a plain path or name is never run, a FIXED runtime never falls back to the other one, and nothing inherited from a Gentle Shell session
// (PI_*, GENTLE_*, ENGRAM_*) leaks into the child. Nothing here spawns or reads the real machine: every dependency is a fake.
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { detectRuntimes, chooseRuntime, runtimeEnv, handshake, commandProblem } = require('../server/piruntime.js');

const LAUNCHER = 'C:\\L\\gentle-shell\\bin\\gentle-shell.cmd';
const PI_CMD = 'C:\\N\\npm\\pi.cmd';
// A fake machine: `files` maps a path to its text; `onPath` maps a name to its path; `versions` answers `<command> --version`.
function machine({ files = {}, onPath = {}, versions = {} } = {}) {
  const runs = [];
  return {
    runs,
    deps: {
      env: { LOCALAPPDATA: 'C:\\L', PATH: 'x' }, platform: 'win32', homedir: 'C:\\Users\\u',
      exists: (p) => p in files,
      readText: (p) => { if (!(p in files)) throw new Error('ENOENT'); return files[p]; },
      which: (n) => onPath[n] || null,
      run: async (cmd, args, opts) => { runs.push({ cmd, args, opts }); const v = versions[cmd]; if (v === undefined) return { code: -1, stdout: '', stderr: 'boom' }; return { code: 0, stdout: v, stderr: '' }; },
    },
  };
}
const GS_FILES = { [LAUNCHER]: '', 'C:\\L\\gentle-shell\\current': '4.5.1-1.4.0\n' };
const both = () => machine({ files: GS_FILES, onPath: { pi: PI_CMD }, versions: { [PI_CMD]: '1.2.0\n' } });
const ids = (c) => c.map((x) => x.id);

test('a1: detects Gentle Shell from its launcher and `current` file without spawning, and the original pi from PATH with its version', async () => {
  const m = both();
  const c = await detectRuntimes(m.deps);
  assert.deepEqual(ids(c), ['gentle-shell', 'pi']);
  assert.deepEqual([c[0].available, c[0].version, c[0].command, c[0].agentDir], [true, '4.5.1-1.4.0', LAUNCHER, 'C:\\Users\\u\\.gentle-shell\\agent']);
  assert.deepEqual([c[1].available, c[1].version, c[1].command, c[1].agentDir], [true, '1.2.0', PI_CMD, 'C:\\Users\\u\\.pi\\agent']);
  assert.deepEqual(m.runs.map((r) => r.cmd), [PI_CMD], 'only the original pi is run, and only for its version');
  assert.deepEqual(m.runs[0].args, ['--version']);
  assert.ok(m.runs[0].opts.timeout > 0 && m.runs[0].opts.timeout <= 10000, 'short timeout');
});

test('a2: both missing -> both unavailable with a short reason, never a throw', async () => {
  const c = await detectRuntimes(machine().deps);
  assert.deepEqual(c.map((x) => x.available), [false, false]);
  for (const x of c) assert.ok(typeof x.reason === 'string' && x.reason.length > 0 && x.reason.length < 120);
});

test('a3: version unreadable -> Gentle Shell stays available with no version; a pi whose --version fails is unavailable', async () => {
  const gs = await detectRuntimes(machine({ files: { [LAUNCHER]: '' } }).deps);
  assert.deepEqual([gs[0].available, gs[0].version], [true, null]);
  const broken = await detectRuntimes(machine({ onPath: { pi: PI_CMD } }).deps);
  assert.equal(broken[1].available, false);
  assert.match(broken[1].reason, /version/i);
  const throwing = machine({ onPath: { pi: PI_CMD } });
  throwing.deps.run = async () => { throw new Error('EPERM'); };
  assert.equal((await detectRuntimes(throwing.deps))[1].available, false);
});

test('a4: the version run of the original pi gets the scrubbed env, not the inherited one', async () => {
  const m = both();
  m.deps.env = { ...m.deps.env, PI_CODING_AGENT_DIR: 'C:\\evil', GENTLE_X: '1' };
  await detectRuntimes(m.deps);
  const env = m.runs[0].opts.env;
  assert.equal(env.PI_CODING_AGENT_DIR, 'C:\\Users\\u\\.pi\\agent');
  assert.equal('GENTLE_X' in env, false);
});

test('a5: GENTLE_SHELL_PREFIX moves the Gentle Shell prefix; on Linux the plain names are used, nothing is guessed', async () => {
  const files = { 'D:\\gs\\bin\\gentle-shell.cmd': '', 'D:\\gs\\current': '9.9.9' };
  const m = machine({ files });
  m.deps.env = { ...m.deps.env, GENTLE_SHELL_PREFIX: 'D:\\gs' };
  assert.equal((await detectRuntimes(m.deps))[0].version, '9.9.9');
  const l = machine({ onPath: { 'gentle-shell': '/usr/bin/gentle-shell', pi: '/usr/bin/pi' }, versions: { '/usr/bin/pi': '1.2.0' } });
  l.deps.platform = 'linux'; l.deps.homedir = '/home/u'; l.deps.env = { PATH: '/usr/bin' };
  const c = await detectRuntimes(l.deps);
  assert.deepEqual([c[0].available, c[0].command, c[0].agentDir], [true, '/usr/bin/gentle-shell', '/home/u/.gentle-shell/agent']);
  assert.deepEqual([c[1].available, c[1].agentDir], [true, '/home/u/.pi/agent']);
});

const cand = (id, over = {}) => ({ id, label: id, command: id === 'pi' ? PI_CMD : LAUNCHER, agentDir: id === 'pi' ? 'C:\\h\\.pi\\agent' : 'C:\\h\\.gentle-shell\\agent', version: '1', available: true, reason: null, ...over });
const GS = cand('gentle-shell');
const PI = cand('pi');

test('c1: auto picks Gentle Shell first when both are available', () => {
  const r = chooseRuntime([GS, PI], { runtime: 'auto' });
  assert.equal(r.active.id, 'gentle-shell');
  assert.equal(r.mode, 'auto');
  assert.ok(!r.problem);
  assert.equal(chooseRuntime([GS, PI], undefined).active.id, 'gentle-shell', 'auto is the default');
});

test('c2: auto with only the original pi picks it', () => {
  assert.equal(chooseRuntime([cand('gentle-shell', { available: false }), PI], { runtime: 'auto' }).active.id, 'pi');
});

test('c3: auto with none gives null and a problem that says how to install one', () => {
  const r = chooseRuntime([cand('gentle-shell', { available: false }), cand('pi', { available: false })], { runtime: 'auto' });
  assert.equal(r.active, null);
  assert.match(r.problem, /install/i);
});

test('c4: a FIXED runtime that is unavailable gives null and a problem; it never falls back to the other one', () => {
  const off = (id) => cand(id, { available: false, reason: 'not found' });
  let r = chooseRuntime([off('gentle-shell'), PI], { runtime: 'gentle-shell' });
  assert.equal(r.active, null);
  assert.equal(r.mode, 'gentle-shell');
  assert.match(r.problem, /not found/);
  r = chooseRuntime([GS, off('pi')], { runtime: 'pi' });
  assert.equal(r.active, null);
  assert.ok(r.problem);
  assert.equal(chooseRuntime([GS, PI], { runtime: 'pi' }).active.id, 'pi', 'a fixed available runtime is used even when the other is first');
});

test('o1: command and agentDir from the setting override the detected values of the chosen candidate only', () => {
  const r = chooseRuntime([GS, PI], { runtime: 'pi', command: 'C:\\tools\\my pi\\pi.exe', agentDir: 'D:\\data\\agent' });
  assert.equal(r.active.command, 'C:\\tools\\my pi\\pi.exe');
  assert.equal(r.active.agentDir, 'D:\\data\\agent');
  assert.equal(PI.command, PI_CMD, 'the candidate is not mutated');
  assert.equal(chooseRuntime([GS, PI], { runtime: 'auto', command: 'mypi' }).active.command, 'mypi', 'a bare name is allowed');
});

// One test per class of what must never be run.
const bad = (name, command) => test(`o2: a command with ${name} is rejected with a problem and nothing is chosen`, () => {
  const r = chooseRuntime([GS, PI], { runtime: 'auto', command });
  assert.equal(r.active, null, JSON.stringify(command));
  assert.ok(r.problem);
  if (typeof command === 'string' && command.length > 3) assert.equal(r.problem.includes(command), false, 'the rejected text is not echoed');
});
bad('&', 'C:\\x\\pi.exe & calc');
bad('|', 'C:\\x\\pi.exe | calc');
bad(';', '/usr/bin/pi; rm');
bad('a backtick', '/usr/bin/`id`');
bad('$(', '/usr/bin/$(id)');
bad('$ alone', '/usr/bin/$HOME');
bad('a double quote', 'C:\\x\\"pi".exe');
bad('a single quote', "/usr/bin/pi'");
bad('a newline', '/usr/bin/pi\ncalc');
bad('a percent', 'C:\\x\\%COMSPEC%');
bad('a caret', 'C:\\x\\a^b');
bad('redirects', '/usr/bin/pi > out');
bad('a less-than sign', 'C:\\x\\a<b');
bad('a tab', 'C:\\x\\a\tb');
bad('a NUL', 'C:\\x\\a\u0000b');
bad('a dollar inside parentheses', 'C:\\x (1)\\$(id)');
bad('a relative path with ..', '..\\..\\evil.exe');
bad('an absolute path with ..', 'C:\\x\\..\\..\\evil.exe');
bad('a relative path', 'tools/pi');
bad('a leading dash', '--version');
bad('an empty string', '');
bad('a non-string (number)', 42);
bad('a non-string (array)', ['pi']);
bad('a non-string (object)', { a: 1 });

test('o3: a bad agentDir (relative, non-string, control character) is a problem too; a fixed unavailable runtime still wins over overrides', () => {
  for (const agentDir of ['rel/dir', 7, 'C:\\a\nb', '']) {
    const r = chooseRuntime([GS, PI], { runtime: 'auto', agentDir });
    assert.equal(r.active, null, JSON.stringify(agentDir));
    assert.ok(r.problem);
  }
  const off = chooseRuntime([cand('gentle-shell', { available: false }), PI], { runtime: 'gentle-shell', command: 'pi' });
  assert.equal(off.active, null);
});

test('e1: runtimeEnv removes every PI_*, GENTLE_* and ENGRAM_* key (any case), keeps the rest and does not mutate its input', () => {
  const base = { PATH: 'p', HOME: 'h', PI_CODING_AGENT_DIR: 'x', PI_OTHER: '1', pi_lower: '2', GENTLE_SHELL_CHILD_PACKAGE_INJECTION: '1', gentle_x: '1', ENGRAM_PROJECT: 'a', Engram_Y: 'b', PIPE: 'keep', PIXEL: 'keep' };
  const copy = { ...base };
  const env = runtimeEnv(GS, base);
  assert.deepEqual(env, { PATH: 'p', HOME: 'h', PIPE: 'keep', PIXEL: 'keep' });
  assert.deepEqual(base, copy);
  assert.notEqual(env, base);
});

test('e2: only the original pi gets PI_CODING_AGENT_DIR (its agentDir); Gentle Shell only gets scrubbed', () => {
  const base = { PATH: 'p', PI_CODING_AGENT_DIR: 'C:\\inherited' };
  assert.equal(runtimeEnv(PI, base).PI_CODING_AGENT_DIR, 'C:\\h\\.pi\\agent');
  assert.equal(runtimeEnv(PI, base).PATH, 'p');
  assert.equal('PI_CODING_AGENT_DIR' in runtimeEnv(GS, base), false);
});

// A fake child process: records what is written and lets the test answer, exit or fail.
function fakeSpawn({ onWrite } = {}) {
  const calls = [];
  const spawn = (file, args, opts) => {
    const child = new EventEmitter();
    child.pid = 4242;
    child.stdout = new EventEmitter();
    child.stdin = Object.assign(new EventEmitter(), { written: '', write(s) { this.written += s; if (onWrite) onWrite(child, s); return true; }, end() {} });
    child.killed = false;
    child.kill = () => { child.killed = true; };
    calls.push({ file, args, opts, child });
    if (file === 'taskkill') setImmediate(() => child.emit('exit', 0));
    return child;
  };
  return { spawn, calls, main: () => calls.find((c) => c.file !== 'taskkill'), kills: () => calls.filter((c) => c.file === 'taskkill') };
}
const reply = (obj) => (child) => setImmediate(() => child.stdout.emit('data', Buffer.from(`${JSON.stringify(obj)}\n`)));
const OK = { id: '1', type: 'response', command: 'get_state', success: true, data: {} };
const treeKilled = (f) => f.kills().some((k) => k.args.join(' ') === '/PID 4242 /T /F');

test('h1: handshake ok: starts `--mode rpc --no-session` in the temp dir with the scrubbed env, writes one get_state line and kills the tree', async () => {
  const f = fakeSpawn({ onWrite: reply(OK) });
  const r = await handshake(PI, { spawn: f.spawn, env: { PATH: 'p', PI_CODING_AGENT_DIR: 'bad', GENTLE_A: '1' }, timeoutMs: 2000, platform: 'win32', tmpdir: 'C:\\T' });
  assert.deepEqual(r, { ok: true });
  const m = f.main();
  assert.deepEqual(m.args, ['--mode', 'rpc', '--no-session']);
  assert.equal(m.opts.cwd, 'C:\\T');
  assert.equal(m.opts.env.PI_CODING_AGENT_DIR, 'C:\\h\\.pi\\agent');
  assert.equal('GENTLE_A' in m.opts.env, false);
  assert.deepEqual(JSON.parse(m.child.stdin.written.trim()), { id: '1', type: 'get_state' });
  assert.equal(m.child.stdin.written.trim().split('\n').length, 1);
  assert.ok(treeKilled(f), 'taskkill /T /F on success');
});

test('h2: a .cmd goes through the shell only on Windows and quoted; an .exe or a Linux command never does', async () => {
  let f = fakeSpawn({ onWrite: reply(OK) });
  await handshake(PI, { spawn: f.spawn, env: {}, platform: 'win32' });
  assert.equal(f.main().opts.shell, true);
  assert.equal(f.main().file, `"${PI_CMD}"`);
  f = fakeSpawn({ onWrite: reply(OK) });
  await handshake(cand('pi', { command: 'C:\\x\\pi.exe' }), { spawn: f.spawn, env: {}, platform: 'win32' });
  assert.ok(!f.main().opts.shell);
  assert.equal(f.main().file, 'C:\\x\\pi.exe');
  f = fakeSpawn({ onWrite: reply(OK) });
  await handshake(cand('pi', { command: '/usr/bin/pi' }), { spawn: f.spawn, env: {}, platform: 'linux', kill: () => {} });
  assert.ok(!f.main().opts.shell);
});

test('h3: an error response, an exit, a spawn error and a timeout are all { ok: false, error } and all kill the tree; only the get_state response counts', async () => {
  const cases = {
    'error line': { onWrite: reply({ id: '1', type: 'response', command: 'get_state', success: false, error: 'nope' }) },
    'close before answering': { onWrite: (c) => setImmediate(() => c.emit('close', 3)) },
    'process error': { onWrite: (c) => setImmediate(() => c.emit('error', new Error('EPERM'))) },
    timeout: {},
  };
  for (const [name, opts] of Object.entries(cases)) {
    const f = fakeSpawn(opts);
    const r = await handshake(PI, { spawn: f.spawn, env: {}, timeoutMs: 30, platform: 'win32' });
    assert.equal(r.ok, false, name);
    assert.ok(typeof r.error === 'string' && r.error.length > 0 && r.error.length < 300, name);
    assert.ok(treeKilled(f), `${name}: the tree is killed`);
  }
  const f = fakeSpawn({ onWrite: (c) => setImmediate(() => { c.stdout.emit('data', 'banner text\n{"type":"response","command":"other","success":true}\n'); }) });
  assert.equal((await handshake(PI, { spawn: f.spawn, env: {}, timeoutMs: 30, platform: 'win32' })).ok, false);
});

test('h4: a spawn that throws, and a command that fails the validation, never throw and never spawn the bad command', async () => {
  const throwing = () => { throw new Error('EPERM'); };
  assert.equal((await handshake(PI, { spawn: throwing, env: {}, platform: 'win32' })).ok, false);
  const f = fakeSpawn({ onWrite: reply(OK) });
  assert.equal((await handshake(cand('pi', { command: 'pi & calc' }), { spawn: f.spawn, env: {}, platform: 'win32' })).ok, false);
  assert.equal(f.calls.length, 0);
});

test('h5: on Linux the tree is killed through the process group and the child is started detached', async () => {
  const f = fakeSpawn({ onWrite: reply(OK) });
  const killed = [];
  await handshake(cand('pi', { command: '/usr/bin/pi' }), { spawn: f.spawn, env: {}, platform: 'linux', kill: (pid, sig) => killed.push([pid, sig]) });
  assert.equal(f.main().opts.detached, true);
  assert.deepEqual(killed, [[-4242, 'SIGKILL']]);
});

test('o4: legitimate paths pass the allow-list (parentheses, 8.3 short names, accents); the metacharacters still do not', () => {
  for (const ok of ['C:\\Program Files (x86)\\x\\gentle-shell.cmd', 'C:\\Users\\Víctor\\x.cmd', 'C:\\PROGRA~1\\x.cmd', 'C:\\a@b+c\\x.exe', '/home/ñandú/bin/pi']) assert.equal(commandProblem(ok), null, ok);
  for (const no of ['C:\\x\\%COMSPEC%', 'C:\\x & y', 'C:\\x | y', 'C:\\x; y', 'C:\\x\\a^b', 'C:\\x\\"a"', "C:\\x\\a'b", 'C:\\x\\`a`', 'C:\\x\\$a', 'C:\\x > y', 'C:\\x < y', 'C:\\x\n', 'C:\\x\u0000', 'C:\\x\\..\\y']) assert.ok(commandProblem(no), JSON.stringify(no));
});

test('h6: the default handshake waits for a slow start (15 s is ok) and fails with a slow-start hint when nothing answers in 60 s', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const slow = fakeSpawn({ onWrite: (c) => setTimeout(() => c.stdout.emit('data', `${JSON.stringify(OK)}\n`), 15000) });
  const p1 = handshake(PI, { spawn: slow.spawn, env: {}, platform: 'win32' });
  const p2 = handshake(PI, { spawn: fakeSpawn().spawn, env: {}, platform: 'win32' });
  t.mock.timers.tick(15000);
  t.mock.timers.tick(44999);
  t.mock.timers.tick(1);
  return Promise.all([p1, p2]).then(([a, b]) => {
    assert.deepEqual(a, { ok: true });
    assert.equal(b.ok, false);
    assert.match(b.error, /60 s/);
    assert.match(b.error, /slow start/i);
  });
});

test('h7: the process ending before its last chunk is read is not a failure (close, not exit): a response after exit still counts', async () => {
  const f = fakeSpawn({ onWrite: (c) => setImmediate(() => { c.emit('exit', 0); c.stdout.emit('data', `${JSON.stringify(OK)}\n`); c.emit('close', 0); }) });
  assert.deepEqual(await handshake(PI, { spawn: f.spawn, env: {}, timeoutMs: 2000, platform: 'win32' }), { ok: true });
});

test('h8: a bare name is resolved on the PATH to an absolute file and only that is launched; not on the PATH it is never launched; an absolute command is used as is', async () => {
  const asked = [];
  const which = (n) => { asked.push(n); return n === 'pi' ? PI_CMD : null; };
  let f = fakeSpawn({ onWrite: reply(OK) });
  assert.deepEqual(await handshake(cand('pi', { command: 'pi' }), { spawn: f.spawn, env: {}, platform: 'win32', which }), { ok: true });
  assert.equal(f.main().file, `"${PI_CMD}"`);
  f = fakeSpawn({ onWrite: reply(OK) });
  const r = await handshake(cand('pi', { command: 'mypi' }), { spawn: f.spawn, env: {}, platform: 'win32', which });
  assert.equal(r.ok, false);
  assert.match(r.error, /PATH/);
  assert.equal(f.calls.length, 0);
  asked.length = 0;
  f = fakeSpawn({ onWrite: reply(OK) });
  await handshake(cand('pi', { command: 'C:\\x\\pi.exe' }), { spawn: f.spawn, env: {}, platform: 'win32', which });
  assert.equal(f.main().file, 'C:\\x\\pi.exe');
  assert.deepEqual(asked, [], 'an absolute command is not looked up');
});
