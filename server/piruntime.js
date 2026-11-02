'use strict';
// Which pi the panel runs (S11): Gentle Shell or the original pi, found on this machine. The panel will LAUNCH a program, so the rules
// are strict: the browser only ever picks an id of a detected runtime; a `command` or `agentDir` comes ONLY from config.json and must
// pass `commandProblem` / `dirProblem`; the child gets a scrubbed environment (nothing inherited from a Gentle Shell session); and a
// fixed runtime that is unavailable is a problem, never a silent fall back to the other one. Everything that spawns or reads the file
// system is injectable, so tests use fakes.
const cp = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadConfig, PI_RUNTIMES } = require('./config.js');

const SCRUB = /^(PI_|GENTLE_|ENGRAM_)/i;
const SAFE_COMMAND = /^[\p{L}\p{N}_.\-:\\/ ()~@+]+$/u;
const BARE_NAME = /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/;
const VERSION_TIMEOUT_MS = 5000;
const CACHE_MS = 60 * 1000;
const RPC_ARGS = ['--mode', 'rpc', '--no-session'];
const LABELS = { 'gentle-shell': 'Gentle Shell', pi: 'pi (original)' };
const NO_RUNTIME = 'No pi found. Install Gentle Shell, or install pi with npm and make sure `pi` is on the PATH.';

const isAbs = (p) => path.win32.isAbsolute(p) || path.posix.isAbsolute(p);
const hasDots = (p) => p.split(/[\\/]/).includes('..');

// Why `command` cannot be run, or null. An absolute path or a bare name made only of letters, digits (any script) and `_ . - : \ / space ( ) ~ @ +`: no shell
// metacharacter, no `..`, no relative path, never the text that was rejected (it is not echoed).
function commandProblem(command) {
  if (typeof command !== 'string' || !command) return 'command must be a non-empty string';
  if (!SAFE_COMMAND.test(command)) return 'command has characters that are not allowed';
  if (hasDots(command)) return 'command must not contain ..';
  if (!isAbs(command) && !BARE_NAME.test(command)) return 'command must be an absolute path or a bare name';
  return null;
}

function dirProblem(dir) {
  if (typeof dir !== 'string' || !dir) return 'agentDir must be a non-empty string';
  if (/[\x00-\x1f\x7f]/.test(dir)) return 'agentDir has control characters';
  if (!isAbs(dir) || hasDots(dir)) return 'agentDir must be an absolute path without ..';
  return null;
}

// PATH lookup without spawning (`where` would be a process): PATHEXT order on Windows, the plain name elsewhere.
function makeWhich({ env, platform, exists }) {
  const P = platform === 'win32' ? path.win32 : path.posix;
  const dirs = String(env.PATH || env.Path || '').split(P.delimiter).filter(Boolean);
  const exts = platform === 'win32' ? ['.exe', '.cmd', '.bat', '.com'] : [''];
  return (name) => {
    for (const d of dirs) for (const e of exts) { const f = P.join(d, name + e); if (exists(f)) return f; }
    return null;
  };
}

// How to start `command`: a .cmd or .bat needs the shell on Windows (only after commandProblem passed, and quoted).
function launchSpec(command, platform) {
  if (platform === 'win32' && /\.(cmd|bat)$/i.test(command)) return { file: `"${command}"`, shell: true };
  return { file: command, shell: false };
}

// The environment of the child: a COPY of baseEnv without PI_*, GENTLE_* and ENGRAM_*. The original pi gets its own data folder; Gentle
// Shell's launcher sets its own variables when it starts (unverified here), so for it this only scrubs.
function runtimeEnv(candidate, baseEnv) {
  const env = {};
  for (const [k, v] of Object.entries(baseEnv || {})) if (!SCRUB.test(k)) env[k] = v;
  if (candidate && candidate.id === 'pi' && candidate.agentDir) env.PI_CODING_AGENT_DIR = candidate.agentDir;
  return env;
}

const NOT_FOUND = (label) => `${label} not found`;

// Both installs without spawning anything: launcher file and `current` for Gentle Shell, PATH for the original pi. Gentle Shell first.
function findRuntimes(deps = {}) {
  const env = deps.env || process.env;
  const platform = deps.platform || process.platform;
  const homedir = deps.homedir || os.homedir();
  const exists = deps.exists || fs.existsSync;
  const readText = deps.readText || ((p) => fs.readFileSync(p, 'utf8'));
  const which = deps.which || makeWhich({ env, platform, exists });
  const P = platform === 'win32' ? path.win32 : path.posix;
  const out = [];
  let gs;
  if (platform === 'win32') {
    // GENTLE_SHELL_PREFIX or %LOCALAPPDATA%\gentle-shell; <prefix>\current holds the version.
    const prefix = env.GENTLE_SHELL_PREFIX || P.join(env.LOCALAPPDATA || P.join(homedir, 'AppData', 'Local'), 'gentle-shell');
    const launcher = P.join(prefix, 'bin', 'gentle-shell.cmd');
    let version = null;
    if (exists(launcher)) { try { version = String(readText(P.join(prefix, 'current'))).trim() || null; } catch { /* no version */ } }
    gs = { command: exists(launcher) ? launcher : null, version };
  } else {
    // Where Gentle Shell installs on Linux is unknown, so nothing is guessed: only `gentle-shell` on the PATH, with no version.
    gs = { command: which('gentle-shell'), version: null };
  }
  out.push({ id: 'gentle-shell', label: LABELS['gentle-shell'], command: gs.command || 'gentle-shell', agentDir: P.join(homedir, '.gentle-shell', 'agent'), version: gs.version, available: !!gs.command, reason: gs.command ? null : NOT_FOUND(LABELS['gentle-shell']) });
  const pi = which('pi');
  out.push({ id: 'pi', label: LABELS.pi, command: pi || 'pi', agentDir: P.join(homedir, '.pi', 'agent'), version: null, available: !!pi, reason: pi ? null : 'pi not found on the PATH' });
  return out;
}

// The default `run` of the version check: execFile with a short timeout, through the shell only for a validated .cmd on Windows.
function versionRun(command, args, { timeout = VERSION_TIMEOUT_MS, env } = {}) {
  return new Promise((resolve) => {
    const spec = launchSpec(command, process.platform);
    try {
      cp.execFile(spec.file, args, { timeout, env, shell: spec.shell, windowsHide: true, cwd: os.tmpdir() }, (err, stdout, stderr) => {
        resolve({ code: err ? (typeof err.code === 'number' ? err.code : -1) : 0, stdout: stdout || '', stderr: stderr || '' });
      });
    } catch { resolve({ code: -1, stdout: '', stderr: '' }); }
  });
}

// findRuntimes plus the version of the original pi (`<command> --version`). A failure is available:false with a short reason, never a throw.
async function detectRuntimes(deps = {}) {
  const run = deps.run || versionRun;
  const env = deps.env || process.env;
  const list = findRuntimes(deps);
  const pi = list[1];
  if (pi.available) {
    const problem = commandProblem(pi.command);
    if (problem) { pi.available = false; pi.reason = 'pi path is not allowed'; return list; }
    const r = await Promise.resolve().then(() => run(pi.command, ['--version'], { timeout: VERSION_TIMEOUT_MS, env: runtimeEnv(pi, env) })).catch(() => null);
    const line = r && r.code === 0 ? String(r.stdout || r.stderr).trim().split('\n')[0].trim() : '';
    if (line) pi.version = line.slice(0, 40);
    else { pi.available = false; pi.reason = 'could not read the pi version'; }
  }
  return list;
}

// A configured `agentDir` changes the sessions folder but, for Gentle Shell, not the child's environment (its launcher sets its own).
// `baseDir()` uses the version-less detection (findCached) while `resolveRuntime` also reads the version, so a failing `pi --version`
// can make them differ (the folder of one runtime, the active one of the other).
// Picks the runtime to use from the candidates and the `pi` object of config.json. A fixed runtime that is unavailable is a problem; the
// config's command / agentDir replace the detected values of the chosen candidate after validation, and a bad one runs nothing.
function chooseRuntime(candidates, setting) {
  const s = setting && typeof setting === 'object' ? setting : {};
  const mode = PI_RUNTIMES.includes(s.runtime) ? s.runtime : 'auto';
  let chosen;
  if (mode === 'auto') {
    chosen = candidates.find((c) => c.available);
    if (!chosen) return { active: null, mode, problem: NO_RUNTIME };
  } else {
    chosen = candidates.find((c) => c.id === mode);
    if (!chosen || !chosen.available) return { active: null, mode, problem: `${LABELS[mode]} is selected but is not available (${(chosen && chosen.reason) || 'not found'}). Install it or choose Auto.` };
  }
  const active = { ...chosen };
  if (s.command !== undefined) {
    const problem = commandProblem(s.command);
    if (problem) return { active: null, mode, problem: `config.json pi.command: ${problem}` };
    active.command = s.command;
  }
  if (s.agentDir !== undefined) {
    const problem = dirProblem(s.agentDir);
    if (problem) return { active: null, mode, problem: `config.json pi.agentDir: ${problem}` };
    active.agentDir = s.agentDir;
  }
  return { active, mode };
}

// Ends the child AND everything it started: taskkill /T on Windows, the process group elsewhere.
function killTree(child, { spawn, platform, kill }) {
  try {
    if (platform === 'win32') {
      const k = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      if (k && typeof k.on === 'function') k.on('error', () => {});
    } else kill(-child.pid, 'SIGKILL');
  } catch { try { child.kill('SIGKILL'); } catch { /* already gone */ } }
}

// Starts the runtime in RPC mode in the temp folder, asks for `get_state` and waits for its answer. Always ends the process tree;
// never throws. No text from the user reaches the arguments.
function handshake(candidate, { spawn = cp.spawn, env = process.env, timeoutMs = 60000, platform = process.platform, tmpdir = os.tmpdir(), kill = process.kill, exists = fs.existsSync, which = makeWhich({ env, platform, exists }) } = {}) {
  return new Promise((resolve) => {
    const problem = commandProblem(candidate && candidate.command);
    if (problem) return resolve({ ok: false, error: problem });
    // cmd.exe looks a bare name in the current folder first: never launch one, only the file found on the PATH.
    let command = candidate.command;
    if (!isAbs(command)) {
      command = which(command);
      if (!command || commandProblem(command)) return resolve({ ok: false, error: 'command not found on the PATH' });
    }
    let child = null;
    let done = false;
    let timer = null;
    const finish = (result) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (child) killTree(child, { spawn, platform, kill });
      resolve(result);
    };
    const fail = (error) => finish({ ok: false, error: String(error).replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, 200) });
    try {
      const spec = launchSpec(command, platform);
      child = spawn(spec.file, RPC_ARGS, { cwd: tmpdir, env: runtimeEnv(candidate, env), shell: spec.shell, windowsHide: true, detached: platform !== 'win32', stdio: ['pipe', 'pipe', 'ignore'] });
    } catch (e) { return fail(`could not start: ${e && e.message}`); }
    timer = setTimeout(() => fail(`no answer in ${Math.round(timeoutMs / 1000)} s (it can be a slow start)`), timeoutMs);
    child.on('error', (e) => fail(`could not start: ${e && e.message}`));
    child.on('close', (code) => fail(`exited with code ${code} before answering`));
    let buf = '';
    child.stdout.on('data', (chunk) => {
      buf += chunk;
      if (buf.length > 1e6) buf = '';
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        let msg = null;
        try { msg = JSON.parse(line); } catch { /* not a message */ }
        if (msg && msg.type === 'response' && msg.command === 'get_state') {
          if (msg.success === true) return finish({ ok: true });
          return fail(`get_state failed: ${msg.error || 'unknown error'}`);
        }
      }
      return undefined;
    });
    try {
      if (child.stdin && typeof child.stdin.on === 'function') child.stdin.on('error', () => {});
      child.stdin.write(`${JSON.stringify({ id: '1', type: 'get_state' })}\n`);
    } catch (e) { fail(`could not write: ${e && e.message}`); }
  });
}

let cache = null;

// Detection plus the choice from config.json. With no injected deps (the real server) the detection is kept for a minute so the page
// does not spawn `pi --version` on every request; injected deps (tests) are never cached. `setting` overrides config.json.
async function resolveRuntime(deps = {}) {
  const real = Object.keys(deps).length === 0;
  let candidates;
  if (real && cache && Date.now() - cache.at < CACHE_MS) candidates = cache.candidates;
  else {
    candidates = await detectRuntimes(deps);
    if (real) cache = { at: Date.now(), candidates };
  }
  const setting = deps.setting !== undefined ? deps.setting : loadConfig().pi;
  return { candidates, ...chooseRuntime(candidates, setting) };
}

// The sync view for `baseDir()` (no spawn, no version): the same files and PATH as findRuntimes, kept for 30 seconds.
let syncCache = null;
function findCached() {
  if (!syncCache || Date.now() - syncCache.at > 30 * 1000) syncCache = { at: Date.now(), candidates: findRuntimes() };
  return syncCache.candidates;
}

module.exports = { findRuntimes, detectRuntimes, chooseRuntime, runtimeEnv, handshake, resolveRuntime, findCached, commandProblem, launchSpec, killTree, makeWhich, isAbs, LABELS };
