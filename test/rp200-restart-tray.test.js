'use strict';
// RP200 (S2): the menu of the tray has «Restart tray»: it reloads the tray itself, with the code of the disk, with nothing to do by hand. A tray process reads scripts/tray.ps1 ONCE, when it starts, and Quit tray
// does not bring it back (the task only starts it at log on), so before this a change of the tray needed Task Manager and a command. How it works: the scheduled task refuses a second instance (MultipleInstances:
// IgnoreNew), so the NEW tray is a child of the old one, started like the task starts it (conhost --headless powershell); it carries -ReplacePid <old> and waits for that process to END before it takes the
// single-instance lock, and the old one leaves right after starting it. Measured on this PC: a child started that way outlives the end of the task instance. Before anything is ended the new script is tried
// in the dry way (-SelfTest: it must load and answer), so a script that does not even load never replaces the tray that works; if the dry run fails or the child cannot start, the old tray stays and says why.
// The tests never open a tray or touch the real one: they read the script as text and run the modes that create no window and take no lock (-CheckScript, -SelfTestReplace).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const TRAY = path.join(ROOT, 'scripts', 'tray.ps1');
const INSTALL = path.join(ROOT, 'scripts', 'install-tray.ps1');
const tray = fs.readFileSync(TRAY, 'utf8').replace(/\r\n/g, '\n');
const install = fs.readFileSync(INSTALL, 'utf8').replace(/\r\n/g, '\n');
const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
const WIN = process.platform === 'win32';
const opts = { skip: WIN ? false : 'the tray scripts are Windows only (PowerShell + System.Windows.Forms)' };
const PS = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass'];

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'rp200-'));
const sleepers = [];
test.after(() => {
  for (const s of sleepers) { try { process.kill(s.pid); } catch { /* already gone */ } }
  fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 5 });
});

// A function of the script, as text: from its line to the closing brace at the start of a line.
const fn = (name) => { const m = new RegExp(`function ${name}\\b[\\s\\S]*?\\n\\}\\n`).exec(tray); assert.ok(m, `function ${name}`); return m[0]; };
const run = (args) => spawnSync('powershell.exe', [...PS, '-File', TRAY, ...args], { encoding: 'utf8', timeout: 90000 });
const sleeper = (seconds) => { const c = spawn('powershell.exe', [...PS, '-Command', `Start-Sleep -Seconds ${seconds}`], { stdio: 'ignore', windowsHide: true }); sleepers.push(c); return c; };

// ---------- the script, as text (any system) ----------
test('r1: the menu has Restart tray between Start panel and Quit tray, in the list of labels and in the menu, and the other items are the ones they were', () => {
  assert.match(tray, /\$script:menuLabels = @\('Open panel', 'Restart panel', 'Start panel', 'Restart tray', 'Quit tray'\)/);
  const order = ['$menu.Items.Add($script:menuLabels[0])', '$menu.Items.Add($script:menuLabels[1])', '$menu.Items.Add($script:menuLabels[2])', '$menu.Items.Add($script:menuLabels[3])', "[void]$menu.Items.Add('-')", '$menu.Items.Add($script:menuLabels[4])'].map((k) => tray.indexOf(k));
  assert.ok(order.every((i) => i >= 0), `every item is added: ${order}`);
  assert.deepEqual([...order].sort((a, b) => a - b), order, 'in this order, the separator right before Quit tray');
  assert.match(tray, /\$itemQuit\.add_Click\(\{ \$context\.ExitThread\(\) \}\)/, 'Quit tray still just leaves');
  assert.match(tray, /\$itemRestart\.add_Click\(\{ Invoke-Safe \{\s*Show-Balloon 'Restarting repo-panel\.\.\.'\s*\$r = Invoke-PanelRestart/, 'Restart panel still restarts the panel and only the panel');
});

test('r2: the new parameters are there and the header says what they are for', () => {
  for (const p of ['[int]$ReplacePid = 0', '[int]$ReplaceWaitSeconds = 20', "[string]$CheckScript = ''", '[switch]$SelfTestReplace']) assert.ok(tray.includes(p), p);
  const head = tray.slice(0, tray.indexOf('param('));
  for (const w of ['-ReplacePid', '-CheckScript', '-SelfTestReplace']) assert.ok(head.includes(w), `the header says ${w}`);
});

test('r3: the new tray is started like the task starts the tray (conhost --headless, the full path of powershell, -NoProfile -ExecutionPolicy Bypass -File) with -ReplacePid of the old one, in the folder of the repo', () => {
  const body = fn('Start-NewTray');
  assert.match(body, /Start-Process -FilePath 'conhost\.exe'/);
  assert.match(body, /--headless/);
  assert.match(body, /-NoProfile -ExecutionPolicy Bypass -File/);
  assert.match(body, /-ReplacePid \$OldPid/);
  assert.match(body, /-WorkingDirectory \$script:root/);
  assert.match(body, /-WindowStyle Hidden/);
  assert.match(body, /WindowsPowerShell\\v1\.0\\powershell\.exe/, 'the full path, like the task: conhost cannot run a shim');
  assert.match(install, /--headless `"\$powershell`" -NoProfile -ExecutionPolicy Bypass -File/, 'the installer starts it the same way');
});

test('r4: Restart tray tries the script in the dry way first, starts the child only when that went well, and leaves only after the child was started; any failure leaves the old tray where it was', () => {
  const body = fn('Invoke-TrayRestart');
  assert.ok(body.indexOf('Test-TrayScript') >= 0 && body.indexOf('Test-TrayScript') < body.indexOf('Start-NewTray'), 'dry run, then the child');
  assert.match(body, /if \(-not \$check\.ok\)[\s\S]*return/, 'a script that does not load: nothing is started');
  assert.match(body, /try \{ Start-NewTray \$PID \} catch/, 'a child that cannot start is a message, not an exit');
  assert.match(body, /restarted = \$true/);
  const click = /\$itemRestartTray\.add_Click\(\{[\s\S]*?\n\} \}\)/.exec(tray);
  assert.ok(click, 'the click of the item');
  assert.match(click[0], /Invoke-TrayRestart/);
  assert.match(click[0], /if \(\$r\.restarted\) \{ \$context\.ExitThread\(\) \} else \{ Show-Balloon \$r\.message \}/);
});

test('r5: the dry run is -SelfTest of the script, hidden, with a limit of time, and it needs exit code 0', () => {
  const body = fn('Test-TrayScript');
  assert.match(body, /-File `"\$Path`" -SelfTest/, 'the path goes between quotes: a folder with spaces must work');
  assert.match(body, /-WindowStyle Hidden/);
  assert.match(body, /WaitForExit\(\$Seconds \* 1000\)/);
  assert.match(body, /\.ExitCode -eq 0/);
  assert.match(body, /Stop-Process/, 'a dry run that hangs is ended');
});

test('r6: the new tray waits for the old one to END BEFORE it takes the lock, with a limit, and leaves quietly when the old one does not end', () => {
  const wait = tray.indexOf('if (-not (Wait-ProcessEnd $ReplacePid $ReplaceWaitSeconds)) { exit 0 }'); // the REAL wait, not the one of the test mode
  const lock = tray.indexOf("New-Object System.Threading.Mutex($true, 'Local\\repo-panel-tray'");
  assert.ok(wait > 0 && lock > 0 && wait < lock, 'the wait is before the lock');
  assert.match(tray, /if \(\$ReplacePid -gt 0\) \{[\s\S]*?if \(-not \(Wait-ProcessEnd \$ReplacePid \$ReplaceWaitSeconds\)\) \{ exit 0 \}/);
  assert.match(fn('Wait-ProcessEnd'), /Get-Process -Id \$ProcessId/);
});

test('r7: the single-instance lock and the way out of the tray are the ones they were: the lock is released when the tray leaves', () => {
  assert.match(tray, /if \(-not \$created\) \{ \$mutex\.Dispose\(\); exit 0 \}/);
  assert.match(tray, /\$mutex\.ReleaseMutex\(\); \$mutex\.Dispose\(\)/);
});

test('r8: the README says what Restart tray does, why it is a child of the old tray, and what it checks first', () => {
  assert.match(readme, /RP200/);
  assert.match(readme, /\*\*Restart tray\*\*/);
  assert.match(readme, /-ReplacePid/);
  assert.match(readme, /dry run|tries the new script/i);
});

// ---------- what it really does (Windows; no window, no lock, nothing of the real tray) ----------
test('t1: -SelfTest lists the menu with Restart tray, and still answers as before', opts, () => {
  const r = run(['-SelfTest']);
  assert.equal(r.status, 0, r.stderr);
  const j = JSON.parse(r.stdout);
  assert.deepEqual(j.menu, ['Open panel', 'Restart panel', 'Start panel', 'Restart tray', 'Quit tray']);
  for (const k of ['port', 'healthy', 'listeners', 'ownedListeners', 'task']) assert.ok(k in j, k);
});

test('t2: -CheckScript says ok for the real script, and not ok for one that does not even load, without starting anything', opts, () => {
  const good = run(['-CheckScript', TRAY]);
  assert.equal(good.status, 0, good.stderr);
  assert.deepEqual(Object.keys(JSON.parse(good.stdout)).sort(), ['ok', 'seconds']);
  assert.equal(JSON.parse(good.stdout).ok, true);
  const broken = path.join(scratch, 'broken.ps1');
  fs.writeFileSync(broken, 'param([switch]$SelfTest)\nif ($SelfTest {\n  "x"\n');
  const bad = run(['-CheckScript', broken]);
  assert.equal(bad.status, 0, 'the check itself works: it reports');
  assert.equal(JSON.parse(bad.stdout).ok, false);
  const missing = run(['-CheckScript', path.join(scratch, 'nope.ps1')]);
  assert.equal(JSON.parse(missing.stdout).ok, false, 'a script that is not there is not ok');
});

test('t3: -CheckScript is for the dry run only: a script that exits with a failure is not ok, and one that never ends is ended and not ok', opts, () => {
  const fails = path.join(scratch, 'fails.ps1');
  fs.writeFileSync(fails, 'param([switch]$SelfTest)\nexit 3\n');
  assert.equal(JSON.parse(run(['-CheckScript', fails]).stdout).ok, false);
  const hangs = path.join(scratch, 'hangs.ps1');
  fs.writeFileSync(hangs, 'param([switch]$SelfTest)\nStart-Sleep -Seconds 120\n');
  const t = Date.now();
  const r = run(['-CheckScript', hangs, '-ReplaceWaitSeconds', '2']);
  assert.equal(JSON.parse(r.stdout).ok, false);
  assert.ok(Date.now() - t < 40000, 'it did not wait for the two minutes');
});

test('t4: -SelfTestReplace waits until the process of -ReplacePid has ended, and then says replaced', opts, () => {
  const old = sleeper(5);
  const r = run(['-SelfTestReplace', '-ReplacePid', String(old.pid)]);
  assert.equal(r.status, 0, r.stderr);
  const j = JSON.parse(r.stdout);
  assert.equal(j.replaced, true);
  assert.ok(j.waitedMs >= 1500, `it really waited (${j.waitedMs} ms)`);
  assert.ok(j.waitedMs < 20000, `and only until the end (${j.waitedMs} ms)`);
});

test('t5: when the old process does not end in time it leaves quietly: not replaced, exit code 0, and the old process is left alone', opts, () => {
  const old = sleeper(60);
  const t = Date.now();
  const r = run(['-SelfTestReplace', '-ReplacePid', String(old.pid), '-ReplaceWaitSeconds', '1']);
  assert.equal(r.status, 0, r.stderr);
  const j = JSON.parse(r.stdout);
  assert.equal(j.replaced, false);
  assert.ok(j.waitedMs >= 900, `it waited its second (${j.waitedMs} ms)`);
  assert.ok(Date.now() - t < 30000);
  assert.doesNotThrow(() => process.kill(old.pid, 0), 'the old process is still alive: nothing was ended');
});

test('t6: a process that is not there counts as ended at once, and without -ReplacePid there is nothing to wait for', opts, () => {
  const gone = run(['-SelfTestReplace', '-ReplacePid', '2147483000']);
  assert.equal(JSON.parse(gone.stdout).replaced, true);
  assert.ok(JSON.parse(gone.stdout).waitedMs < 3000);
  const none = run(['-SelfTestReplace']);
  assert.equal(none.status, 0);
  assert.deepEqual(JSON.parse(none.stdout), { replaced: true, waitedMs: 0 });
});

test('t7: the modes of the test create no tray: the lock of the real tray is not taken and the real tray (if it runs) is not touched', opts, () => {
  const before = spawnSync('powershell.exe', [...PS, '-Command', "(Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match 'scripts.tray\\.ps1' -and $_.CommandLine -notmatch 'SelfTest|CheckScript|RenderIcons' -and $_.Name -eq 'powershell.exe' }).ProcessId -join ','"], { encoding: 'utf8' }).stdout.trim();
  run(['-SelfTest']);
  run(['-SelfTestReplace', '-ReplacePid', '2147483000']);
  run(['-CheckScript', TRAY]);
  const after = spawnSync('powershell.exe', [...PS, '-Command', "(Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match 'scripts.tray\\.ps1' -and $_.CommandLine -notmatch 'SelfTest|CheckScript|RenderIcons' -and $_.Name -eq 'powershell.exe' }).ProcessId -join ','"], { encoding: 'utf8' }).stdout.trim();
  assert.equal(after, before, 'the same tray processes before and after');
});
