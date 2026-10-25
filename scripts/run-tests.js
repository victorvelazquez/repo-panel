'use strict';
// `npm test` goes through here: it runs `node --test` and, on Windows, compares the definition of the user's REAL
// scheduled tasks before and after. A test that overwrites one of them fails the run even if every test passed
// (the task state alone cannot show it: a task that is already running stays Running while its definition changes).
const { spawnSync } = require('node:child_process');

const TASKS = ['repo-panel', 'repo-panel-tray'];
const FIELDS = ['execute', 'arguments', 'workingDirectory', 'triggers', 'restartCount'];

// Read-only: Get-ScheduledTask only. A task that is not there is `absent`; any other failure is `unavailable`.
const READ_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  '$r = @{}',
  `foreach ($n in ${TASKS.map((t) => `'${t}'`).join(', ')}) {`,
  '  try {',
  '    $t = Get-ScheduledTask -TaskName $n',
  '    $a = @($t.Actions)[0]',
  "    $r[$n] = @{ status = 'present'; execute = $a.Execute; arguments = $a.Arguments; workingDirectory = $a.WorkingDirectory;",
  '      triggers = @($t.Triggers | ForEach-Object { $_.CimClass.CimClassName }); restartCount = $t.Settings.RestartCount }',
  '  } catch {',
  "    if ($_.CategoryInfo.Category -eq 'ObjectNotFound' -or $_.FullyQualifiedErrorId -like '*NotFound*') { $r[$n] = @{ status = 'absent' } }",
  "    else { $r[$n] = @{ status = 'unavailable'; reason = [string]$_.Exception.Message } }",
  '  }',
  '}',
  '$r | ConvertTo-Json -Depth 4 -Compress',
].join('\n');

function readSnapshot(spawn = spawnSync) {
  const unavailable = (reason) => Object.fromEntries(TASKS.map((t) => [t, { status: 'unavailable', reason }]));
  try {
    const encoded = Buffer.from(READ_SCRIPT, 'utf16le').toString('base64');
    const r = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], { encoding: 'utf8', timeout: 60000, windowsHide: true });
    if (r.error) return unavailable(r.error.message);
    if (r.status !== 0) return unavailable(`powershell.exe exited with ${r.status}`);
    const parsed = JSON.parse(r.stdout);
    const out = {};
    for (const t of TASKS) {
      const e = parsed[t];
      if (!e || typeof e !== 'object') out[t] = { status: 'unavailable', reason: 'no data' };
      else if (e.status === 'present') out[t] = { ...e, triggers: [].concat(e.triggers ?? []) };
      else out[t] = e;
    }
    return out;
  } catch (e) {
    return unavailable(String(e && e.message || e));
  }
}

// Pure. Compares only the two real tasks. `unavailable` on either side is a note, never a change.
function diffSnapshots(before, after) {
  const changes = [];
  const notes = [];
  for (const task of TASKS) {
    const a = before && before[task];
    const b = after && after[task];
    const unreadable = (e) => !e || e.status === 'unavailable';
    if (unreadable(a) || unreadable(b)) {
      const reason = [a, b].map((e) => e && e.reason).find(Boolean);
      notes.push(`${task}: unavailable${reason ? ` (${reason})` : ''}, not checked`);
      continue;
    }
    if (a.status !== b.status) {
      changes.push({ task, field: 'status', before: a.status, after: b.status });
      continue;
    }
    if (a.status !== 'present') continue;
    for (const field of FIELDS) {
      if (JSON.stringify(a[field]) !== JSON.stringify(b[field])) changes.push({ task, field, before: a[field], after: b[field] });
    }
  }
  return { changes, notes };
}

const show = (v) => (typeof v === 'string' ? JSON.stringify(v) : JSON.stringify(v) ?? 'undefined');

function runTests(argv) {
  const r = spawnSync(process.execPath, ['--test', ...argv], { stdio: 'inherit' });
  return r.status ?? 1;
}

// Returns the exit code. Everything it needs from the outside is injectable.
function main({ argv = process.argv.slice(2), platform = process.platform, readSnapshot: read = readSnapshot, runTests: run = runTests, out = console.log, err = console.error } = {}) {
  if (platform !== 'win32') return run(argv);
  const before = read();
  const code = run(argv);
  const { changes, notes } = diffSnapshots(before, read());
  if (changes.length) {
    err('');
    err('task guard: THE DEFINITION OF A REAL SCHEDULED TASK CHANGED DURING THE TEST RUN');
    for (const c of changes) {
      err(`  ${c.task}: ${c.field}`);
      err(`    before: ${show(c.before)}`);
      err(`    after:  ${show(c.after)}`);
    }
    err('A test or script touched the user\'s real autostart or tray task. Repair it by running the real installer from the real repository folder.');
    err('');
    return code || 1;
  }
  if (notes.length) out(`task guard: ${notes.join('; ')}`);
  else out(`task guard: ${TASKS.join(' and ')} unchanged`);
  return code;
}

module.exports = { TASKS, diffSnapshots, readSnapshot, main };

if (require.main === module) process.exit(main());
