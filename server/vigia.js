'use strict';
// Server-side watcher (RP31): scans the pi sessions of every repo and room by itself, so the passive recorder of
// question-like screens (server/casos.js) sees them even when the page is closed or hidden. It only observes:
// read-only `orca terminal list/show` through `scan`, whose result is ignored. server.js starts it, and only when
// a recorder was installed; no module and no test starts it by itself.
const lib = require('../lib.js');
const { loadConfig } = require('./config.js');
const { scanSessions } = require('./pi.js');

const DEFAULT_INTERVAL_MS = 60000;
const DEFAULT_FIRST_DELAY_MS = 5000;
const MIN_INTERVAL_MS = 10000;
const WARN_EVERY_MS = 10 * 60 * 1000;

// Every repo path of every group plus every room path, in config order.
const foldersOf = (cfg) => [
  ...(cfg.groups || []).flatMap((g) => (g.repos || []).map((r) => r.path)),
  ...(cfg.rooms || []).map((r) => r.path),
].filter((p) => typeof p === 'string' && p);

const configFolders = () => foldersOf(loadConfig());

// REPO_PANEL_WATCH_MS in milliseconds: unset gives the default; `0`, `off`, empty or an invalid value disable the
// watcher (null); anything below the minimum is raised to it.
function watchInterval(env) {
  const raw = env.REPO_PANEL_WATCH_MS;
  if (raw === undefined) return DEFAULT_INTERVAL_MS;
  const text = String(raw).trim();
  if (!/^\d+$/.test(text)) return null;
  const ms = Number(text);
  return ms > 0 ? Math.max(ms, MIN_INTERVAL_MS) : null;
}

function createWatcher({
  listRepoFolders = configFolders,
  orca,
  scan = scanSessions,
  intervalMs = DEFAULT_INTERVAL_MS,
  firstDelayMs = DEFAULT_FIRST_DELAY_MS,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  log = console.warn,
  now = Date.now,
} = {}) {
  let timer = null;
  let running = false;
  let started = false;
  let lastWarn = -Infinity;

  // At most one warning per 10 minutes, whatever failed.
  function warn(message) {
    try {
      const t = now();
      if (t - lastWarn < WARN_EVERY_MS) return;
      lastWarn = t;
      log(`repo-panel watcher: ${message}`);
    } catch { /* logging never breaks the watcher */ }
  }

  async function tick() {
    if (running) return;
    running = true;
    try {
      const folders = [];
      const seen = new Set();
      for (const f of listRepoFolders()) {
        const key = lib.normPath(f);
        if (!seen.has(key)) { seen.add(key); folders.push(f); }
      }
      if (!folders.length) return;
      const terminals = (await orca(['list'])).terminals;
      if (!Array.isArray(terminals)) throw new Error('Orca returned no terminal list');
      for (const folder of folders) {
        try { await scan(folder, orca, terminals); } catch (e) { warn(`scan of ${folder} failed: ${e && e.message}`); }
      }
    } catch (e) {
      warn(`skipped a tick: ${e && e.message}`);
    } finally { running = false; }
  }

  function arm(ms) {
    timer = setTimer(async () => {
      timer = null;
      await tick();
      if (started) arm(intervalMs);
    }, ms);
    if (timer && typeof timer.unref === 'function') timer.unref();
  }

  function start() {
    if (started) return;
    started = true;
    arm(firstDelayMs);
  }

  function stop() {
    started = false;
    if (timer) { clearTimer(timer); timer = null; }
  }

  return { start, stop, tick };
}

module.exports = { createWatcher, watchInterval, foldersOf, defaultScan: scanSessions };
