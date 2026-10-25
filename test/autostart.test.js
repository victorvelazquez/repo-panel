'use strict';
const test = require('node:test');
const { after } = test;
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const INSTALL = path.join(ROOT, 'scripts', 'install-autostart.ps1');
const UNINSTALL = path.join(ROOT, 'scripts', 'uninstall-autostart.ps1');
const WIN = process.platform === 'win32';
const opts = { skip: WIN ? false : 'the autostart scripts are Windows only (PowerShell + ScheduledTasks)' };
const PS = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass'];
const SYSTEM32 = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32');
const POWERSHELL = path.join(SYSTEM32, 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const pathKey = Object.keys(process.env).find((k) => k.toLowerCase() === 'path') || 'PATH';

const dirs = [];
after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true, maxRetries: 5 }); });

// Only ever runs the script with -DryRun: the real install would register the user's actual `repo-panel` task.
function dryRun(env) {
  const r = spawnSync(POWERSHELL, [...PS, '-File', INSTALL, '-DryRun'], { encoding: 'utf8', env: { ...process.env, ...env }, timeout: 60000 });
  return { code: r.status, out: r.stdout.trim(), err: r.stderr.trim() };
}

// The count is compared before and after, because a machine with autostart installed already has one task.
const taskCount = () => spawnSync(POWERSHELL, [...PS, '-Command', "@(Get-ScheduledTask -TaskName 'repo-panel' -ErrorAction SilentlyContinue).Count"], { encoding: 'utf8' }).stdout.trim();

test('install-autostart.ps1 -DryRun prints the task, the conhost action and the folder, and registers nothing', opts, () => {
  const before = taskCount();
  const r = dryRun({});
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /repo-panel/);
  assert.match(r.out, /conhost\.exe/);
  assert.match(r.out, /--headless/);
  assert.match(r.out, /server\.js/);
  assert.match(r.out, /node\.exe/i);
  assert.match(r.out, /logon/i);
  assert.match(r.out, /dry run/i);
  assert.ok(r.out.includes(ROOT), 'names the repo folder');
  assert.equal(taskCount(), before, 'a dry run leaves the scheduled tasks as they were');
});

test('install-autostart.ps1 -DryRun skips a node.cmd shim placed first on PATH', opts, () => {
  const shimDir = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-panel-autostart-shim-'));
  dirs.push(shimDir);
  fs.writeFileSync(path.join(shimDir, 'node.cmd'), ['@echo off', 'exit /b 1', ''].join(String.fromCharCode(13, 10)));
  const before = taskCount();
  const r = dryRun({ [pathKey]: shimDir + path.delimiter + process.env[pathKey] });
  assert.equal(r.code, 0, r.err);
  assert.ok(!r.out.includes(shimDir), 'the decoy is never used');
  assert.ok(!/node\.cmd/i.test(r.out));
  assert.match(r.out, /node\.exe/i);
  assert.equal(taskCount(), before);
});

test('install-autostart.ps1 -DryRun fails clearly when PATH has no node.exe, and registers nothing', opts, () => {
  const before = taskCount();
  const r = dryRun({ [pathKey]: SYSTEM32 });
  assert.notEqual(r.code, 0);
  assert.match(r.err, /node\.exe was not found/);
  assert.ok(!/conhost/.test(r.out), 'nothing is announced as registered');
  assert.equal(taskCount(), before);
});

test('the real install path of install-autostart.ps1 still registers the same task (script text only, never run)', opts, () => {
  const text = fs.readFileSync(INSTALL, 'utf8');
  assert.ok(text.includes("$taskName = 'repo-panel'"));
  assert.ok(text.includes("New-ScheduledTaskAction -Execute 'conhost.exe'"));
  assert.ok(text.includes('-Argument $argument -WorkingDirectory $root'), 'registers the very text the dry run prints');
  const code = text.split(/\r?\n/).filter((l) => !l.trimStart().startsWith('#')).join('\n');
  assert.equal(code.split('--headless').length - 1, 1, 'the argument is built once');
  assert.equal(code.split('server.js').length - 1, 1, 'and so is the script it starts');
  assert.ok(text.includes('Register-ScheduledTask -TaskName $taskName'));
  assert.ok(text.includes('-RestartCount 99'));
  assert.ok(text.includes('Write-Host "Task \'$taskName\' installed. repo-panel will start at your next logon."'));
  const dry = text.indexOf('if ($DryRun)');
  assert.ok(dry >= 0 && dry < text.indexOf('Register-ScheduledTask'), 'the dry-run exit comes before the registration');
});

// ---------- the temp-folder guard of the four scripts that register or remove the user's real scheduled tasks ----------
// Every run below uses -DryRun. The guard sits before the dry-run block, so a copy inside the temp folder must be refused;
// were the guard missing, the dry run would still register and remove nothing.
const SCRIPTS = path.join(ROOT, 'scripts');
const GUARDED = ['install-autostart.ps1', 'uninstall-autostart.ps1', 'install-tray.ps1', 'uninstall-tray.ps1'];
const REFUSAL = /refused: this copy lives inside the OS temp folder \(.+\); install from the real repository folder\.$/m;

function runCopyInTemp(name) {
  const text = fs.readFileSync(path.join(SCRIPTS, name), 'utf8');
  // Never execute a script that could do the real thing: it has to declare -DryRun, and the dry-run exit has to come first.
  assert.match(text, /\[switch\]\$DryRun/, `${name} must declare -DryRun before a copy of it is run`);
  assert.ok(text.indexOf('if ($DryRun)') >= 0, `${name} must have a dry-run branch`);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-panel-guard-'));
  dirs.push(dir);
  fs.mkdirSync(path.join(dir, 'scripts'));
  const copy = path.join(dir, 'scripts', name);
  fs.copyFileSync(path.join(SCRIPTS, name), copy);
  // TMP and TEMP both name the folder Node used, so .NET's GetTempPath agrees with os.tmpdir().
  const env = { ...process.env, TMP: os.tmpdir(), TEMP: os.tmpdir() };
  const r = spawnSync(POWERSHELL, [...PS, '-File', copy, '-DryRun'], { encoding: 'utf8', env, timeout: 60000 });
  return { code: r.status, out: r.stdout.trim(), err: r.stderr.trim(), dir };
}

for (const name of GUARDED) {
  test(`${name} run from a copy inside the OS temp folder is refused with exit code 2 and does not print the dry-run text`, opts, () => {
    const r = runCopyInTemp(name);
    assert.equal(r.code, 2, `${r.out}\n${r.err}`);
    assert.match(r.err, REFUSAL);
    // Compare the unique folder name, not the full path: on Windows runners os.tmpdir() can come back in 8.3 short form (RUNNER~1) while PowerShell prints the long one.
    assert.ok(r.err.includes(path.basename(r.dir)), 'names the folder of the copy');
    assert.ok(!/dry run/i.test(r.out), 'the dry-run text is not printed');
    assert.equal(r.out, '');
  });
}

test('the four scripts still dry-run from the real repository folder (exit 0, prints the task)', opts, () => {
  const expected = { 'install-autostart.ps1': /Task:\s+repo-panel \(/, 'uninstall-autostart.ps1': /Would remove task 'repo-panel'/, 'install-tray.ps1': /Task:\s+repo-panel-tray \(/, 'uninstall-tray.ps1': /Would remove task 'repo-panel-tray'/ };
  for (const name of GUARDED) {
    const r = spawnSync(POWERSHELL, [...PS, '-File', path.join(SCRIPTS, name), '-DryRun'], { encoding: 'utf8', timeout: 60000 });
    assert.equal(r.status, 0, `${name}: ${r.stdout}${r.stderr}`);
    assert.match(r.stdout, /dry run: nothing was/i);
    assert.match(r.stdout, expected[name], name);
    assert.equal(r.stderr.trim(), '', name);
  }
});

// Offsets, in the AST, of the guard call, the first *-ScheduledTask* command and the `if ($DryRun)` statement.
const OFFSETS_PS = [
  'param([string]$File)',
  '$t=$null;$e=$null',
  '$ast=[System.Management.Automation.Language.Parser]::ParseFile($File,[ref]$t,[ref]$e)',
  '$cmds=$ast.FindAll({param($n) $n -is [System.Management.Automation.Language.CommandAst]},$true)',
  "$guard=@($cmds | Where-Object { $_.GetCommandName() -eq 'Test-UnderTemp' })",
  "$sched=@($cmds | Where-Object { $_.GetCommandName() -like '*-ScheduledTask*' })",
  "$dry=@($ast.FindAll({param($n) $n -is [System.Management.Automation.Language.IfStatementAst] -and $n.Clauses[0].Item1.Extent.Text -eq '$DryRun'},$true))",
  '[pscustomobject]@{ guards=$guard.Count; guard=$guard[0].Extent.StartOffset; sched=$sched[0].Extent.StartOffset; dry=$dry[0].Extent.StartOffset } | ConvertTo-Json -Compress',
].join(';');

test('in each of the four scripts the Test-UnderTemp call comes before any *-ScheduledTask* cmdlet and before if ($DryRun)', opts, () => {
  for (const name of GUARDED) {
    const r = spawnSync(POWERSHELL, [...PS, '-Command', `& { ${OFFSETS_PS} } '${path.join(SCRIPTS, name).replace(/'/g, "''")}'`], { encoding: 'utf8' });
    assert.equal(r.status, 0, `${name}: ${r.stdout}${r.stderr}`);
    const o = JSON.parse(r.stdout);
    assert.equal(o.guards, 1, `${name} calls Test-UnderTemp once`);
    assert.ok(o.guard > 0 && o.guard < o.sched, `${name}: the guard comes before the first scheduled-task cmdlet`);
    assert.ok(o.guard < o.dry, `${name}: the guard comes before the dry-run block`);
  }
});

// Only the function is evaluated, in a fresh PowerShell, from a file that holds nothing else of the script.
function underTempChecks(name) {
  const parse = `$t=$null;$e=$null;$a=[System.Management.Automation.Language.Parser]::ParseFile('${path.join(SCRIPTS, name).replace(/'/g, "''")}',[ref]$t,[ref]$e);`
    + "$f=@($a.FindAll({param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq 'Test-UnderTemp'},$true));if($f.Count -ne 1){exit 3};$f[0].Extent.Text";
  const got = spawnSync(POWERSHELL, [...PS, '-Command', parse], { encoding: 'utf8' });
  assert.equal(got.status, 0, `${name} defines Test-UnderTemp exactly once: ${got.stdout}${got.stderr}`);
  return got.stdout.trim();
}

test('Test-UnderTemp (the function alone, same text in the four scripts) tells temp paths from the others', opts, () => {
  const texts = GUARDED.map(underTempChecks);
  for (const text of texts) assert.equal(text, texts[0], 'the function is the same in every script');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-panel-undertemp-'));
  dirs.push(dir);
  const temp = 'C:\\Users\\x\\AppData\\Local\\Temp';
  const cases = [
    [temp + '\\a\\b', true, 'a folder under temp'],
    [temp, true, 'the temp folder itself'],
    [temp + '\\', true, 'the temp folder with a trailing separator'],
    ['C:\\Users\\x\\AppData\\Local\\Temp2\\x', false, 'a sibling that only shares the prefix'],
    ['C:\\Users\\x\\Developer\\repo-panel', false, 'a path outside temp'],
    ['c:\\users\\X\\appdata\\local\\TEMP\\Foo', true, 'different letter case'],
    [temp + '\\..\\Other', false, 'a .. that leaves temp'],
    [temp + '\\..\\Temp\\z', true, 'a .. that comes back into temp'],
  ];
  const lines = cases.map(([p], i) => `$r${i}=Test-UnderTemp '${p}' '${temp}\\'; "$r${i}"`);
  const file = path.join(dir, 'check.ps1');
  fs.writeFileSync(file, [texts[0], ...lines, ''].join('\n'));
  const r = spawnSync(POWERSHELL, [...PS, '-File', file], { encoding: 'utf8' });
  assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
  const got = r.stdout.trim().split(/\r?\n/);
  assert.equal(got.length, cases.length, r.stdout);
  cases.forEach(([p, want, label], i) => assert.equal(got[i], want ? 'True' : 'False', `${label}: ${p}`));
  // Called without a second argument it uses the real OS temp folder.
  const own = path.join(dir, 'own.ps1');
  fs.writeFileSync(own, [texts[0], `Test-UnderTemp '${path.join(os.tmpdir(), 'x', 'y').replace(/'/g, "''")}'`, `Test-UnderTemp '${ROOT.replace(/'/g, "''")}'`, ''].join('\n'));
  const o = spawnSync(POWERSHELL, [...PS, '-File', own], { encoding: 'utf8', env: { ...process.env, TMP: os.tmpdir(), TEMP: os.tmpdir() } });
  assert.deepEqual(o.stdout.trim().split(/\r?\n/), ['True', ROOT.toLowerCase().startsWith(os.tmpdir().toLowerCase()) ? 'True' : 'False']);
});

test('uninstall-autostart.ps1 has a -DryRun switch that returns before Unregister-ScheduledTask (script text only, never run)', opts, () => {
  const text = fs.readFileSync(UNINSTALL, 'utf8');
  assert.match(text, /^param\(\[switch\]\$DryRun\)/m);
  const dry = text.indexOf('if ($DryRun)');
  assert.ok(dry >= 0, 'has a dry-run branch');
  assert.ok(dry < text.indexOf('Unregister-ScheduledTask'), 'the dry-run exit comes before the removal');
  assert.ok(text.includes("Dry run: nothing was removed. Would remove task '$taskName' if installed."));
});

test('install-autostart.ps1 parses without errors in Windows PowerShell 5.1 and in PowerShell 7', opts, (t) => {
  const shells = [POWERSHELL, 'pwsh'].filter((s) => spawnSync(s, ['-NoProfile', '-Command', '1'], { encoding: 'utf8' }).status === 0);
  assert.ok(shells.includes(POWERSHELL));
  if (!shells.includes('pwsh')) t.diagnostic('pwsh not found: only Windows PowerShell 5.1 was checked');
  for (const shell of shells) {
    for (const file of GUARDED.map((n) => path.join(SCRIPTS, n))) {
      const cmd = `$e=$null;$t=$null;[void][System.Management.Automation.Language.Parser]::ParseFile('${file.replace(/'/g, "''")}',[ref]$t,[ref]$e);if($e.Count){$e|ForEach-Object{$_.Message};exit 1}`;
      const r = spawnSync(shell, ['-NoProfile', '-Command', cmd], { encoding: 'utf8' });
      assert.equal(r.status, 0, `${shell} ${path.basename(file)}: ${r.stdout}${r.stderr}`);
    }
  }
});
