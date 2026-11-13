'use strict';
// RP178: watches the Summary store and tells the page, through the event hub, when a repo starts to need the person (an asking session, a
// failing CI, work to ship, a PR to merge, a clean repo to start). It emits on a CHANGE of kind only: the first look at a repo is a baseline,
// a kind must hold for `confirm` looks in a row (a flicker says nothing), and a row that cannot say keeps what was known.
// The hub only writes to the clients that are connected, so with none connected it does NOTHING: asking the store for a snapshot wakes it, and an awake
// store reads Git of every repo all the time (the panel keeps a store that nobody asked for idle on purpose). When the pages leave, what it knew is
// forgotten, so the first look of the next one is a baseline and never old news. The push of RP179 is what reaches a person with no page open.
const N = require('../public/notify.js');

function createNotifier({ store, hub, intervalMs = 3000, confirm = 2, setTimer = setTimeout, clearTimer = clearTimeout, onNotice } = {}) {
  const seen = new Map(); // repo id -> { stable: kind | null, cand: kind | null | undefined, count }
  let timer = null;

  // An injected hub with no size() is taken as listened to.
  const listened = () => (typeof hub.size !== 'function' || hub.size() > 0);

  function tick() {
    if (!listened()) { seen.clear(); return; }
    let rows;
    try { rows = store.snapshot().rows; } catch { return; }
    if (!Array.isArray(rows)) return;
    const ids = new Set();
    for (const row of rows) {
      if (!row || typeof row.id !== 'string') continue;
      ids.add(row.id);
      const kind = N.kindOf(row);
      const s = seen.get(row.id);
      if (!s) { if (kind !== undefined) seen.set(row.id, { stable: kind, cand: kind, count: 1 }); continue; }
      if (kind === undefined) continue;
      if (kind === s.cand) s.count += 1; else { s.cand = kind; s.count = 1; }
      if (s.count < confirm || kind === s.stable) continue;
      s.stable = kind;
      if (kind) {
        const notice = { kind, ...N.textOf(kind, row), at: new Date().toISOString() };
        hub.emit('notify', row.id, notice);
        if (onNotice) onNotice(row.id, notice);
      }
    }
    for (const id of seen.keys()) if (!ids.has(id)) seen.delete(id);
  }

  function arm() {
    timer = setTimer(() => { tick(); if (timer !== null) arm(); }, intervalMs);
    if (timer && typeof timer.unref === 'function') timer.unref();
  }
  function start() { if (timer === null) arm(); }
  function stop() { if (timer !== null) { clearTimer(timer); timer = null; } }

  return { tick, start, stop };
}

module.exports = { createNotifier };
