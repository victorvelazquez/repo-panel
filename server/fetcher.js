'use strict';
// RP150: the only place that runs `git fetch` on a repo. ONE fetch process per repo at a time: an automatic call (no prune) joins any fetch in
// flight; a manual one (prune) joins an in-flight manual one, or waits for an automatic one and then runs its own. The automatic fetch deletes
// nothing (--no-prune beats fetch.prune and remote.<name>.prune), has its own timeout, never prompts, and skips (no process, no failure) a repo with no remote or with a git lock taken.
const fs = require('node:fs');
const path = require('node:path');
const exec = require('./exec.js');

const AUTO_ARGS = ['-c', 'gc.auto=0', '-c', 'maintenance.auto=false', 'fetch', '--no-prune', '--quiet']; // the -c flags stop git from starting maintenance in the person's repo
const AUTO_ENV = { GCM_INTERACTIVE: 'never', GIT_TERMINAL_PROMPT: '0' }; // a credential manager must not open a window
const AUTO_TIMEOUT_MS = 30000;
const GUARD_GRACE_MS = 5000; // frees the in-flight entry if git never answers, even after its own timeout
const MAX_AUTO = 2;

// Keyed by the git common dir: a main repo and its linked worktrees share refs, so they share one fetch.
const autos = new Map(); // key -> the automatic call in flight, from the queue for a place until it ends
const started = new Map(); // key -> the automatic fetch whose git process is running (the only one a manual call waits for)
const manuals = new Map(); // key -> the manual fetch in flight (or waiting for a started automatic one)
const keys = new Map(); // repo path -> the promise of its key

// A small semaphore: a place is handed straight to the next waiter, so the count never exceeds MAX_AUTO.
let used = 0;
const waiting = [];
async function acquire() {
  if (used < MAX_AUTO) { used++; return; }
  await new Promise((resolve) => waiting.push(resolve));
}
function release() {
  const next = waiting.shift();
  if (next) next(); else used--;
}

function guard(promise, ms, { setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  let timer;
  const limit = new Promise((_, reject) => { timer = setTimer(() => reject(new Error('git fetch timed out')), ms); if (timer && timer.unref) timer.unref(); });
  promise.catch(() => {});
  return Promise.race([promise, limit]).finally(() => clearTimer(timer));
}

// Why an automatic round must not run: 'no-remote' or 'locked' (the index lock of this worktree, which linked worktrees have of their own).
async function skipReason(repo, git) {
  const remotes = await git(repo.path, ['remote']);
  if (remotes.code === 0 && remotes.stdout.trim() === '') return 'no-remote';
  const lock = await git(repo.path, ['rev-parse', '--git-path', 'index.lock']);
  const where = lock.code === 0 ? lock.stdout.trim() : '';
  if (where && fs.existsSync(path.resolve(repo.path, where))) return 'locked';
  return null;
}

// Same comparison as config.js normPath: slashes, trailing slashes and case do not matter.
const normPath = (p) => String(p).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();

// The key of a repo: its git common dir (resolved against the repo path), or the repo path when git cannot say. Asked once per path.
function keyOf(repo, git) {
  if (!keys.has(repo.path)) {
    keys.set(repo.path, git(repo.path, ['rev-parse', '--git-common-dir']).then(
      (r) => normPath(r.code === 0 && r.stdout.trim() ? path.resolve(repo.path, r.stdout.trim()) : repo.path),
      () => normPath(repo.path),
    ));
  }
  return keys.get(repo.path);
}

async function autoFetch(repo, key, deps) {
  const git = deps.git || exec.git;
  const why = await skipReason(repo, git);
  if (why) return { skipped: why };
  await acquire();
  // A manual fetch of this repo got in while this one queued: give the place back at once and share its answer.
  const manual = manuals.get(key);
  if (manual) { release(); return manual; }
  try {
    const p = guard(git(repo.path, AUTO_ARGS, { timeout: AUTO_TIMEOUT_MS, env: AUTO_ENV }), AUTO_TIMEOUT_MS + GUARD_GRACE_MS, deps);
    started.set(key, p);
    try { return await p; } finally { started.delete(key); }
  } finally { release(); }
}

// Resolves to what git answered ({ code, stdout, stderr }) or { skipped }; rejects only when git never answered. The manual fetch (prune) never skips.
// The key is the only await before a call registers: callers that ask together all register in order, and the later ones join the first.
async function fetchRepo(repo, { prune = false, lane = prune ? 'user' : 'background', deps = {} } = {}) {
  const inLane = (fn) => exec.withPriority(lane, fn);
  const key = await inLane(() => keyOf(repo, deps.git || exec.git));
  if (!prune) return manuals.get(key) || exec.singleFlight(autos, key, () => inLane(() => autoFetch(repo, key, deps)));
  return exec.singleFlight(manuals, key, () => inLane(async () => {
    const running = started.get(key);
    if (running) await running.catch(() => {});
    return (deps.git || exec.git)(repo.path, ['fetch', '--prune', '--quiet']);
  }));
}

module.exports = { fetchRepo };
