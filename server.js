'use strict';
// Local-only dashboard server. Binds to 127.0.0.1, requires a per-run token on every API call,
// and only operates on repositories registered in config.json.
const { spawn } = require('node:child_process');
const { loadConfig } = require('./server/config.js');
const { createServer, isPanelRunning } = require('./server/http.js');
const { piSend, setCaseRecorder, orcaTerminal } = require('./server/pi.js');
const { createRecorder, casesFile } = require('./server/casos.js');
const { createWatcher, watchInterval } = require('./server/vigia.js');

if (require.main === module) {
  const { port } = loadConfig();
  // The passive recorder of question-like pi screens is installed ONLY here, never by a module import (see README).
  const cases = casesFile(process.env, __dirname);
  if (cases) {
    setCaseRecorder(createRecorder({ file: cases }).record);
    // The watcher scans the sessions by itself (read-only) so the recorder works with the page closed; it exists only with a recorder.
    const every = watchInterval(process.env);
    if (every) createWatcher({ orca: orcaTerminal, intervalMs: every }).start();
  }
  const server = createServer(port);
  server.on('error', async (e) => {
    if (e.code !== 'EADDRINUSE') { console.error(e.message); process.exit(1); }
    // The URL must stay stable, so never fall back to another port.
    if (await isPanelRunning(port)) {
      console.log(`repo-panel is already running at http://127.0.0.1:${port}/`);
      process.exit(0);
    }
    console.error(`Port ${port} is used by another program. Free it or change "port" in config.json.`);
    process.exit(1);
  });
  server.listen(port, '127.0.0.1', () => {
    const url = `http://127.0.0.1:${port}/`;
    console.log(`repo-panel running at ${url}`);
    if (process.argv.includes('--open')) spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  });
}

module.exports = { createServer, piSend };
