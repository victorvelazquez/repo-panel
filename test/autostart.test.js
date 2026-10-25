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
  assert.ok(text.includes('-Argument "--headless `"$node`" server.js" -WorkingDirectory $root'));
  assert.ok(text.includes('Register-ScheduledTask -TaskName $taskName'));
  assert.ok(text.includes('-RestartCount 99'));
  assert.ok(text.includes('Write-Host "Task \'$taskName\' installed. repo-panel will start at your next logon."'));
  const dry = text.indexOf('if ($DryRun)');
  assert.ok(dry >= 0 && dry < text.indexOf('Register-ScheduledTask'), 'the dry-run exit comes before the registration');
});

test('install-autostart.ps1 parses without errors in Windows PowerShell 5.1 and in PowerShell 7', opts, (t) => {
  const shells = [POWERSHELL, 'pwsh'].filter((s) => spawnSync(s, ['-NoProfile', '-Command', '1'], { encoding: 'utf8' }).status === 0);
  assert.ok(shells.includes(POWERSHELL));
  if (!shells.includes('pwsh')) t.diagnostic('pwsh not found: only Windows PowerShell 5.1 was checked');
  for (const shell of shells) {
    for (const file of [INSTALL, UNINSTALL]) {
      const cmd = `$e=$null;$t=$null;[void][System.Management.Automation.Language.Parser]::ParseFile('${file.replace(/'/g, "''")}',[ref]$t,[ref]$e);if($e.Count){$e|ForEach-Object{$_.Message};exit 1}`;
      const r = spawnSync(shell, ['-NoProfile', '-Command', cmd], { encoding: 'utf8' });
      assert.equal(r.status, 0, `${shell} ${path.basename(file)}: ${r.stdout}${r.stderr}`);
    }
  }
});
