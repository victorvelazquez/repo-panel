'use strict';
// The event hub: the clients of GET /api/events. It stores nothing: `emit` writes one-off SSE frames (the `rpc` events). JSON keeps
// every payload on ONE data line (LF, CR and U+2028 are escaped), so a value can never forge a frame.
const PREAMBLE = 'retry: 3000\n\n';

// A client that never reads would make its socket buffer grow for ever: over `maxBuffer` bytes waiting it is dropped (the page reconnects).
function createEventHub({ maxClients = 8, heartbeatMs = 15000, maxBuffer = 1048576, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  const clients = new Set();
  let timer = null;

  const frame = (event, data) => `event: ${event}\ndata: ${data}\n\n`;

  function stopTimer() { if (timer !== null) { clearTimer(timer); timer = null; } }
  function endQuietly(res) { try { res.end(); } catch { /* already gone */ } }
  function drop(res, end) {
    if (!clients.delete(res)) return;
    if (end) endQuietly(res);
    if (!clients.size) stopTimer();
  }
  function writeAll(text) {
    for (const res of [...clients]) {
      try { res.write(text); } catch { drop(res, true); continue; }
      if (res.writableLength > maxBuffer) drop(res, true);
    }
  }
  function arm() {
    timer = setTimer(() => { timer = null; if (!clients.size) return; writeAll(': ping\n\n'); if (clients.size) arm(); }, heartbeatMs);
    if (timer && typeof timer.unref === 'function') timer.unref();
  }

  function add(res) {
    if (clients.size >= maxClients) return false;
    if (res.writableLength > maxBuffer) { endQuietly(res); return false; }
    try { res.write(PREAMBLE); } catch { endQuietly(res); return false; }
    clients.add(res);
    res.on('close', () => drop(res, false));
    if (timer === null) arm();
    return true;
  }

  // A one-off event (`rpc`). It is never stored; the repo id always wins over an `id` inside the payload, and the escaping keeps it on one data line.
  function emit(event, id, payload) {
    if (!clients.size) return;
    const json = JSON.stringify({ ...payload, id }).replace(/[\u2028\u2029]/g, (c) => `\\u${c.charCodeAt(0).toString(16)}`);
    writeAll(frame(event, json));
  }

  function closeAll() {
    const all = [...clients];
    clients.clear();
    all.forEach(endQuietly);
    stopTimer();
  }

  return { add, size: () => clients.size, emit, closeAll };
}

module.exports = { createEventHub };
