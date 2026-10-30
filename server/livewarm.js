'use strict';
// Live warmer (RP77): every few seconds it lists Orca once and scans every repo and room folder with the cache on, so the read-only
// callers (status, summary, sessions) find the screens already read. Read-only (`list` and `show`); modelled on server/vigia.js.
// server.js starts it, only when run as the program; no module and no test starts it by itself.
const lib = require('../lib.js');
const { scanSessions, primeList } = require('./pi.js');
const { foldersOf, configFolders } = require('./vigia.js');

const DEFAULT_INTERVAL_MS = 3000;
const MIN_INTERVAL_MS = 1000;
const FIRST_DELAY_MS = 1000;
const WARN_EVERY_MS = 10 * 60 * 1000;

// REPO_PANEL_WARM_MS in milliseconds: unset gives 3000; `0`, `off`, empty or an invalid value disable it (null); below 1000 is raised to 1000.
function warmInterval(env) {
  const raw = env.REPO_PANEL_WARM_MS;
  if (raw === undefined) return DEFAULT_INTERVAL_MS;
  const text = String(raw).trim();
  if (!/^\d+$/.test(text)) return null;
  const ms = Number(text);
  return ms > 0 ? Math.max(ms, MIN_INTERVAL_MS) : null;
}

function createWarmer({
  listRepoFolders = configFolders, orca, scan = scanSessions, intervalMs = DEFAULT_INTERVAL_MS,
  setTimer = setTimeout, clearTimer = clearTimeout, log = console.warn, now = Date.now,
} = {}) {
  let timer = null;
  let running = false;
  let started = false;
  let lastWarn = -Infinity;

  function warn(message) {
    try {
      const t = now();
      if (t - lastWarn < WARN_EVERY_MS) return;
      lastWarn = t;
      log(`repo-panel warmer: ${message}`);
    } catch { /* logging never breaks the warmer */ }
  }

  async function tick() {
    if (running) return;
    running = true;
    try {
      const seen = new Set();
      const folders = listRepoFolders().filter((f) => { const k = lib.normPath(f); return !seen.has(k) && seen.add(k); });
      if (!folders.length) return;
      const terminals = (await orca(['list'])).terminals;
      if (!Array.isArray(terminals)) throw new Error('Orca returned no terminal list');
      primeList(terminals, { now, orca });
      for (const folder of folders) {
        try { await scan(folder, orca, terminals, false, true, { cached: true }); } catch (e) { warn(`scan of ${folder} failed: ${e && e.message}`); }
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

  function start() { if (started) return; started = true; arm(FIRST_DELAY_MS); }
  function stop() { started = false; if (timer) { clearTimer(timer); timer = null; } }

  return { start, stop, tick };
}

module.exports = { createWarmer, warmInterval };
