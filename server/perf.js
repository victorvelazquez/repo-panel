'use strict';
// Request timings: a bounded ring of the last records of every route, nearest-rank percentiles and a rate-limited slow log.
const WARN_EVERY_MS = 10000;

function createPerf({ now = Date.now, ringSize = 200, slowMs = 1500, warn = console.warn } = {}) {
  const rings = new Map();
  const lastWarn = new Map();
  const rank = (sorted, p) => sorted[Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)];
  const sum = (a, k) => a.reduce((t, r) => t + r[k], 0);

  // executed is false for a request that shared the answer of an identical one in flight.
  function record({ route, ms, waitMs = 0, procs = 0, priority = 'background', executed = true }) {
    let ring = rings.get(route);
    if (!ring) rings.set(route, (ring = []));
    ring.push({ ms, waitMs, procs, priority, executed });
    if (ring.length > ringSize) ring.shift();
    if (ms < slowMs) return;
    const t = now();
    if (lastWarn.has(route) && t - lastWarn.get(route) < WARN_EVERY_MS) return;
    lastWarn.set(route, t);
    try { warn(`slow request: ${route} ${ms} ms (queue ${waitMs} ms, ${procs} processes)`); } catch { /* logging must never break a request */ }
  }

  function summary() {
    const out = {};
    for (const [route, ring] of rings) {
      const ms = ring.map((r) => r.ms).sort((a, b) => a - b);
      const wait = ring.map((r) => r.waitMs).sort((a, b) => a - b);
      const priorities = {};
      for (const r of ring) priorities[r.priority] = (priorities[r.priority] || 0) + 1;
      out[route] = {
        n: ring.length, p50: rank(ms, 50), p95: rank(ms, 95), max: ms[ms.length - 1],
        waitP50: rank(wait, 50), procsAvg: sum(ring, 'procs') / ring.length,
        executions: ring.filter((r) => r.executed).length, priorities,
      };
    }
    return out;
  }
  return { record, summary };
}

module.exports = { createPerf };
