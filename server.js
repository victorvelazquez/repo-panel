'use strict';
// Local-only dashboard server. Binds to 127.0.0.1, requires a per-run token on every API call,
// and only operates on repositories registered in config.json.
const { spawn } = require('node:child_process');
const { loadConfig } = require('./server/config.js');
const { createServer, isPanelRunning } = require('./server/http.js');
const { piSend } = require('./server/pi.js');

if (require.main === module) {
  const { port } = loadConfig();
  const server = createServer(port);
  // RPC1b: the pi sessions are children of this process; no child may outlive the panel, so they end with it (Ctrl+C, a stop, a restart).
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { server.rpcHost.closeAll(); setTimeout(() => process.exit(0), 300); });
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
    server.summaryStore.start(); // only once the port is ours: a second launch must not read anything
    if (server.notifier) server.notifier.start(); // RP178: idle while no page is connected (it asks the store only for a connected page)
    if (process.argv.includes('--open')) spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  });
}

module.exports = { createServer, piSend };
