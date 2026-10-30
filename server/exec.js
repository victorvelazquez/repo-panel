'use strict';
// Process runner: runs git and gh with a cap on parallel child processes.
const { execFile } = require('node:child_process');

const { AsyncLocalStorage } = require('node:async_hooks');

// RP76: REPO_PANEL_MAX_PARALLEL caps the child processes (a positive integer, else 8). A request of the person (lane 'user') may use
// URGENT_EXTRA places over the cap, and waiting user jobs go before waiting background ones (FIFO inside each lane).
const envMax = Number(process.env.REPO_PANEL_MAX_PARALLEL);
const MAX_PARALLEL = Number.isInteger(envMax) && envMax > 0 ? envMax : 8;
const URGENT_EXTRA = 2;
let active = 0;
const lanes = { user: [], background: [] };
const als = new AsyncLocalStorage();
const withPriority = (priority, fn) => als.run({ ...als.getStore(), priority }, fn);
const withContext = (ctx, fn) => als.run({ ...als.getStore(), ctx }, fn);
const stats = () => ({ active, max: MAX_PARALLEL, waitingBackground: lanes.background.length, waitingUser: lanes.user.length });

function dispatch() {
  for (;;) {
    const lane = lanes.user.length && active < MAX_PARALLEL + URGENT_EXTRA ? lanes.user : lanes.background.length && active < MAX_PARALLEL ? lanes.background : null;
    if (!lane) return;
    lane.shift()();
  }
}
function slot(user) {
  return new Promise((resolve) => {
    lanes[user ? 'user' : 'background'].push(() => { active++; resolve(() => { active--; dispatch(); }); });
    dispatch();
  });
}

// Shares one in-flight call per key; the key is freed when it settles.
function singleFlight(map, key, fn) {
  if (map.has(key)) return map.get(key);
  let p;
  try { p = Promise.resolve(fn()); } catch (e) { p = Promise.reject(e); }
  p = p.finally(() => map.delete(key));
  map.set(key, p);
  return p;
}

async function run(cmd, args, { cwd, timeout = 60000 } = {}) {
  const st = als.getStore() || {};
  const t0 = Date.now();
  const release = await slot(st.priority === 'user');
  if (st.ctx) { st.ctx.procs += 1; st.ctx.waitMs += Date.now() - t0; }
  try {
    return await new Promise((resolve) => {
      execFile(cmd, args, {
        cwd, timeout, maxBuffer: 64 * 1024 * 1024, windowsHide: true,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1' },
      }, (err, stdout, stderr) => {
        resolve({ code: err ? (typeof err.code === 'number' ? err.code : -1) : 0, stdout: stdout || '', stderr: stderr || '' });
      });
    });
  } finally { release(); }
}

const git = (cwd, args, opts) => run('git', ['--no-optional-locks', '-c', 'core.quotepath=false', ...args], { cwd, ...opts });
const gh = (cwd, args, opts) => run('gh', args, { cwd, ...opts });
const firstLine = (s) => (s || '').trim().split('\n').find(Boolean) || '';

module.exports = { URGENT_EXTRA, withPriority, withContext, stats, singleFlight, run, git, gh, firstLine };
