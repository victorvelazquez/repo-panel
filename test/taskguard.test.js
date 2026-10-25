'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { diffSnapshots, main, TASKS } = require('../scripts/run-tests');

const ROOT = path.join(__dirname, '..');
const WIN = process.platform === 'win32';

const present = (over = {}) => ({
  status: 'present',
  execute: 'conhost.exe',
  arguments: '--headless "C:\\node.exe" server.js',
  workingDirectory: 'C:\\repo',
  triggers: ['MSFT_TaskLogonTrigger'],
  restartCount: 99,
  ...over,
});
const snap = (a, b) => ({ 'repo-panel': a, 'repo-panel-tray': b });
const same = () => snap(present(), present({ execute: 'powershell.exe', restartCount: 0 }));

test('the guard watches exactly the two real tasks', () => {
  assert.deepEqual(TASKS, ['repo-panel', 'repo-panel-tray']);
});

test('diffSnapshots: identical snapshots report no change and no note', () => {
  assert.deepEqual(diffSnapshots(same(), same()), { changes: [], notes: [] });
});

test('diffSnapshots: a changed field names the task, the field and both values', () => {
  const after = same();
  after['repo-panel'] = present({ arguments: '--headless "C:\\tmp\\node.cmd" server.js' });
  assert.deepEqual(diffSnapshots(same(), after).changes, [
    { task: 'repo-panel', field: 'arguments', before: '--headless "C:\\node.exe" server.js', after: '--headless "C:\\tmp\\node.cmd" server.js' },
  ]);
  assert.deepEqual(diffSnapshots(same(), after).notes, []);
});

test('diffSnapshots: every compared field is seen, including the triggers and the restart count', () => {
  for (const [field, value] of [['execute', 'x.exe'], ['workingDirectory', 'C:\\tmp'], ['triggers', ['MSFT_TaskTimeTrigger']], ['restartCount', 1]]) {
    const after = same();
    after['repo-panel-tray'] = present({ execute: 'powershell.exe', restartCount: 0, [field]: value });
    const { changes } = diffSnapshots(same(), after);
    assert.equal(changes.length, 1, field);
    assert.equal(changes[0].task, 'repo-panel-tray');
    assert.equal(changes[0].field, field);
  }
});

test('diffSnapshots: several changes are all reported', () => {
  const after = snap(present({ execute: 'a', restartCount: 5 }), present({ execute: 'powershell.exe', restartCount: 0, workingDirectory: 'z' }));
  assert.deepEqual(diffSnapshots(same(), after).changes.map((c) => `${c.task}:${c.field}`), ['repo-panel:execute', 'repo-panel:restartCount', 'repo-panel-tray:workingDirectory']);
});

test('diffSnapshots: a task that appeared or disappeared is a change', () => {
  const absent = { status: 'absent' };
  assert.deepEqual(diffSnapshots(snap(absent, present()), snap(present(), present())).changes, [{ task: 'repo-panel', field: 'status', before: 'absent', after: 'present' }]);
  assert.deepEqual(diffSnapshots(snap(present(), present()), snap(present(), absent)).changes, [{ task: 'repo-panel-tray', field: 'status', before: 'present', after: 'absent' }]);
  assert.deepEqual(diffSnapshots(snap(absent, absent), snap(absent, absent)), { changes: [], notes: [] });
});

test('diffSnapshots: unavailable on either side is no failure, only a note naming the task', () => {
  const unavailable = { status: 'unavailable', reason: 'no powershell' };
  for (const [before, after] of [[snap(unavailable, same()['repo-panel-tray']), same()], [same(), snap(same()['repo-panel'], unavailable)], [snap(unavailable, unavailable), snap(unavailable, unavailable)]]) {
    const r = diffSnapshots(before, after);
    assert.deepEqual(r.changes, []);
    assert.ok(r.notes.length >= 1);
    assert.match(r.notes.join('\n'), /unavailable/);
  }
  assert.match(diffSnapshots(snap(unavailable, same()['repo-panel-tray']), same()).notes.join('\n'), /repo-panel\b/);
  const tray = same()['repo-panel-tray'];
  const mixed = diffSnapshots(snap(unavailable, tray), snap(present({ arguments: 'x' }), { ...tray, restartCount: 7 }));
  assert.equal(mixed.changes.length, 1, 'the readable task is still compared');
  assert.equal(mixed.changes[0].task, 'repo-panel-tray');
});

test('diffSnapshots: a missing entry counts as unavailable and tasks other than the two are ignored', () => {
  assert.deepEqual(diffSnapshots({}, {}).changes, []);
  assert.ok(diffSnapshots({}, {}).notes.length >= 1);
  const before = { ...same(), other: present() };
  const after = { ...same(), other: present({ execute: 'changed' }), another: present() };
  assert.deepEqual(diffSnapshots(before, after), { changes: [], notes: [] });
});

// ---------- main(): what is printed and which exit code comes out ----------
function run({ before = same(), after = same(), code = 0, platform = 'win32' } = {}) {
  const snaps = [before, after];
  const log = { out: [], err: [], read: 0, ran: [] };
  const exit = main({
    argv: ['--test-name-pattern', 'x'],
    platform,
    readSnapshot: () => snaps[log.read++],
    runTests: (argv) => { log.ran.push(argv); return code; },
    out: (l) => log.out.push(l),
    err: (l) => log.err.push(l),
  });
  return { exit, ...log };
}

test('main: when nothing changed it prints one quiet line and returns the exit code of the tests', () => {
  const r = run();
  assert.equal(r.exit, 0);
  assert.deepEqual(r.out, ['task guard: repo-panel and repo-panel-tray unchanged']);
  assert.deepEqual(r.err, []);
  assert.deepEqual(r.ran, [['--test-name-pattern', 'x']], 'every extra argument is forwarded');
  assert.equal(r.read, 2, 'the snapshot is taken before and after');
  assert.equal(run({ code: 3 }).exit, 3, 'a failing test run keeps its own code');
});

test('main: a changed real task fails the run with a loud message even when the tests passed', () => {
  const after = same();
  after['repo-panel'] = present({ execute: 'cmd.exe', workingDirectory: 'C:\\Users\\x\\AppData\\Local\\Temp\\copy' });
  const r = run({ after });
  assert.equal(r.exit, 1);
  assert.deepEqual(r.out, []);
  const text = r.err.join('\n');
  assert.ok(r.err.length > 3, 'multi-line');
  assert.match(text, /repo-panel/);
  assert.match(text, /execute/);
  assert.match(text, /workingDirectory/);
  assert.match(text, /cmd\.exe/);
  assert.match(text, /changed/i);
  assert.ok(!/unchanged/.test(text));
  assert.equal(run({ after, code: 5 }).exit, 5, 'a failing test run keeps its own non-zero code');
});

test('main: an unavailable snapshot never fails the run and says it could not check', () => {
  const r = run({ before: snap({ status: 'unavailable', reason: 'boom' }, { status: 'unavailable', reason: 'boom' }) });
  assert.equal(r.exit, 0);
  assert.equal(r.out.length, 1);
  assert.match(r.out[0], /^task guard: /);
  assert.match(r.out[0], /unavailable/);
  assert.deepEqual(r.err, []);
});

test('main: outside Windows it only runs the tests', () => {
  const r = run({ platform: 'linux', code: 2 });
  assert.equal(r.exit, 2);
  assert.equal(r.read, 0);
  assert.deepEqual(r.out, []);
  assert.deepEqual(r.err, []);
});

test('package.json: npm test goes through the wrapper and the other scripts are kept', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.equal(pkg.scripts.test, 'node scripts/run-tests.js');
  assert.equal(pkg.scripts.start, 'node server.js');
  assert.equal(pkg.scripts.open, 'node server.js --open');
});

// A real, read-only run: the filter matches no test, so nothing else executes. On Windows it really reads the two tasks.
test('scripts/run-tests.js forwards its arguments to node --test and prints the guard line', (t) => {
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (k.startsWith('NODE_TEST')) delete env[k];
  const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'run-tests.js'), '--test-reporter=dot', '--test-name-pattern', 'zzz-no-test-has-this-name'], { encoding: 'utf8', env, cwd: ROOT, timeout: 240000 });
  assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
  assert.ok(!/TAP version/.test(r.stdout), 'the forwarded --test-reporter=dot reached node --test');
  assert.ok(!/^not ok/m.test(r.stdout) && !/failing tests/i.test(r.stdout), 'the forwarded name filter left nothing to fail');
  if (WIN) assert.match(r.stdout, /^task guard: (repo-panel and repo-panel-tray unchanged|.*unavailable.*)$/m);
  else t.diagnostic('not Windows: the guard prints nothing');
});

// ---------- every action of a task is watched, not only the first ----------
const extra = (execute) => ({ execute, arguments: '/c calc', workingDirectory: 'C:\\Users\\x\\AppData\\Local\\Temp\\copy' });

test('diffSnapshots: an action added after the first one is a change', () => {
  const after = same();
  after['repo-panel'] = present({ moreActions: [extra('cmd.exe')] });
  const { changes } = diffSnapshots(same(), after);
  assert.equal(changes.length, 1);
  assert.equal(changes[0].task, 'repo-panel');
  assert.equal(changes[0].field, 'moreActions');
});

test('diffSnapshots: a second action that was edited, or removed, is a change; the same second action is not', () => {
  const withExtra = (e) => snap(present({ moreActions: [e] }), same()['repo-panel-tray']);
  assert.equal(diffSnapshots(withExtra(extra('a.exe')), withExtra(extra('b.exe'))).changes.length, 1);
  assert.equal(diffSnapshots(withExtra(extra('a.exe')), same()).changes.length, 1);
  assert.deepEqual(diffSnapshots(withExtra(extra('a.exe')), withExtra(extra('a.exe'))), { changes: [], notes: [] });
});

test('readSnapshot: asks PowerShell for every action and always returns moreActions as a list', () => {
  const calls = [];
  const spawn = (cmd, args) => {
    calls.push(Buffer.from(args[args.indexOf('-EncodedCommand') + 1], 'base64').toString('utf16le'));
    const task = (more) => ({ status: 'present', execute: 'conhost.exe', arguments: 'a', workingDirectory: 'C:\r', triggers: 'MSFT_TaskLogonTrigger', restartCount: 1, ...more });
    // PowerShell's ConvertTo-Json writes a one-element list as a bare object
    return { status: 0, stdout: JSON.stringify({ 'repo-panel': task({ moreActions: extra('cmd.exe') }), 'repo-panel-tray': task({}) }) };
  };
  const snapshot = require('../scripts/run-tests').readSnapshot(spawn);
  assert.match(calls[0], /moreActions/, 'the PowerShell reader looks past the first action');
  assert.deepEqual(snapshot['repo-panel'].moreActions, [extra('cmd.exe')]);
  assert.deepEqual(snapshot['repo-panel-tray'].moreActions, []);
});
