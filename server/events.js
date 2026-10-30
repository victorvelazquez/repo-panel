'use strict';
// The event hub (RP77b): the clients of GET /api/events and the last live payload of every repo. The warmer publishes after each scan;
// only a change is written, and a client that arrives later gets everything in one `snapshot`. Writes are plain SSE frames; JSON keeps
// every payload on ONE data line (LF, CR and U+2028 are escaped), so a value can never forge a frame.
const PREAMBLE = 'retry: 3000\n\n';

// A client that never reads would make its socket buffer grow for ever: over `maxBuffer` bytes waiting it is dropped (the page reconnects).
function createEventHub({ maxClients = 8, heartbeatMs = 15000, maxBuffer = 1048576, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  const clients = new Set();
  const last = new Map(); // id -> JSON of the last payload
  let timer = null;

  const frame = (event, data) => `event: ${event}\ndata: ${data}\n\n`;
  const entry = (id, json) => `{"id":${JSON.stringify(id)}${json.length > 2 ? ',' : ''}${json.slice(1)}`;

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

  function snapshotFor() {
    return frame('snapshot', `[${[...last].map(([id, json]) => entry(id, json)).join(',')}]`);
  }

  function add(res) {
    if (clients.size >= maxClients) return false;
    if (res.writableLength > maxBuffer) { endQuietly(res); return false; }
    try { res.write(PREAMBLE + snapshotFor()); } catch { endQuietly(res); return false; }
    clients.add(res);
    res.on('close', () => drop(res, false));
    if (timer === null) arm();
    return true;
  }

  function publish(id, payload) {
    // JSON leaves U+2028/9 raw; escaped, a value can never break the line.
    const json = JSON.stringify(payload).replace(/[\u2028\u2029]/g, (c) => `\\u${c.charCodeAt(0).toString(16)}`);
    if (last.get(id) === json) return;
    last.set(id, json);
    if (clients.size) writeAll(frame('live', entry(id, json)));
  }

  function closeAll() {
    const all = [...clients];
    clients.clear();
    all.forEach(endQuietly);
    stopTimer();
  }

  return { add, size: () => clients.size, publish, snapshotFor, closeAll };
}

module.exports = { createEventHub };
