'use strict';
const { execFileSync } = require('node:child_process');

// Only these setup commands can hit a transient file lock on Windows. Any other failure is real and must surface at once.
const RETRYABLE = new Set(['push', 'clone', 'fetch']);
const RETRY_DELAY_MS = 300;

const blockingSleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
// Credentials in a URL, GitHub token shapes (ghp_, gho_, ghu_, ghs_, ghr_, github_pat_) and Authorization header values.
const SECRETS = [
  [/(:\/\/)[^/\s@]+@/g, '$1***@'],
  [/\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/g, '***'],
  [/(authorization:\s*(?:(?:basic|bearer|token)\s+)?)\S+/gi, '$1***'],
];
const hideSecrets = (text) => SECRETS.reduce((s, [re, to]) => s.replace(re, to), String(text));
const subcommand = (args) => args.find((a) => !String(a).startsWith('-'));

// Runs `git <args>` and returns the trimmed stdout. `exec`, `platform` and `sleep` are injectable for tests.
function runGit(cwd, args, { exec = execFileSync, platform = process.platform, sleep = blockingSleep } = {}) {
  const argv = ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args];
  const run = () => exec('git', argv, { cwd, encoding: 'utf8', stdio: 'pipe' });
  const canRetry = platform === 'win32' && RETRYABLE.has(subcommand(args));
  let retried = false;
  let failure;
  try {
    return run().trim();
  } catch (e) { failure = e; }
  if (canRetry) {
    retried = true;
    sleep(RETRY_DELAY_MS);
    try {
      return run().trim();
    } catch (e) { failure = e; }
  }
  const text = (v) => (v == null ? '' : String(v).trim());
  const lines = [
    `git ${hideSecrets(args.join(' '))} failed in ${cwd} (status ${failure.status}, signal ${failure.signal})${retried ? ' after 1 retry' : ''}`,
    `stderr: ${hideSecrets(text(failure.stderr))}`,
    `stdout: ${hideSecrets(text(failure.stdout))}`,
  ];
  if (failure.status == null && failure.code) lines.push(`code: ${failure.code}`);
  throw new Error(lines.join('\n'), { cause: failure });
}

// Same call as before the move: sh(cwd, ...gitArgs) returns the trimmed stdout.
const sh = (cwd, ...args) => runGit(cwd, args);

module.exports = { sh, runGit };
