'use strict';
const lib = require('../lib.js');
const { loadConfig } = require('./config.js');

// The browser sends the per-repo facts it already holds; they are cleaned here and ordered by lib.workQueue.
const MAX_QUEUE_ITEMS = 200;
const qStr = (v) => (typeof v === 'string' ? v.trim().slice(0, 200) : null);

function cleanQueueItem(it) {
  if (!it || typeof it !== 'object') return null;
  const id = qStr(it.id);
  const name = qStr(it.name);
  if (!id || !name) return null;
  const ready = (Array.isArray(it.ready) ? it.ready : [])
    .filter((p) => p && typeof p.number === 'number' && Number.isFinite(p.number))
    .map((p) => ({ number: Math.trunc(p.number), title: qStr(p.title) ?? '' }));
  const nid = it.next && qStr(it.next.id);
  const manual = qStr(it.manual);
  const w = it.waiting;
  const waiting = w && typeof w === 'object' && (w.state === 'needs-input' || w.state === 'blocked') ? { state: w.state, next: qStr(w.next) ?? '' } : null;
  return {
    id, name, ready, stale: !!it.stale, dirty: !!it.dirty, unpushed: !!it.unpushed, hasPrs: !!it.hasPrs,
    next: nid ? { id: nid, entrega: qStr(it.next.entrega) ?? '' } : null,
    ...(manual ? { manual } : {}),
    ...(waiting ? { waiting } : {}),
  };
}

function queueFor(body) {
  const items = body && Array.isArray(body.items) ? body.items.slice(0, MAX_QUEUE_ITEMS) : [];
  return { queue: lib.workQueue(items.map(cleanQueueItem).filter(Boolean), loadConfig().priority) };
}

// The browser sends each repo's roadmap availability and problems; lib.conformityReport audits them.
function conformityFor(body) {
  return lib.conformityReport(body && Array.isArray(body.entries) ? body.entries.slice(0, MAX_QUEUE_ITEMS) : []);
}

module.exports = { queueFor, conformityFor };
