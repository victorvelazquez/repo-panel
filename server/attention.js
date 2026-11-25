'use strict';
// F1: GET /api/attention. What a director must act on across the repos of a scope, in one small answer read from memory only
// (the host's sessions, the summary store's cached PRs and branches, the last agent message on disk); nothing runs gh or Git here.

const path = require('node:path');
const { redact } = require('./redact.js');
const { HttpError } = require('./errors.js');
const { OLD_MS, isCommand } = require('./queuestore.js');

const MAX_ITEMS = 20;
const TEXT_MAX = 200;
const TITLE_MAX = 90;
const IDLE_MS = 5 * 60000; // a free session without an order counts only after this long
const EXPECTED_MODE = 'super-yolo'; // fixed until F2 makes it configurable
// The order a director attends to them (the strategy's round): questions, green PRs, idle lanes with their next step, then the rest.
const ORDER = ['asking', 'queue-lost', 'pr-green', 'waiting', 'idle-no-order', 'session-dead', 'pr-red', 'mode-not-super-yolo'];

// `scrub` runs on the raw text, before redact and the cut: a secret cut in half would no longer be found whole.
const cutWith = (scrub) => (s, n = TEXT_MAX) => redact(scrub(String(s == null ? '' : s))).slice(0, n);
const cut = cutWith((s) => s);
const isoOf = (ms) => (Number.isFinite(ms) ? new Date(ms).toISOString() : null);

// The last «Siguiente:» line of an agent message (bold marks dropped), or null when it has none.
function nextLine(text) {
  if (typeof text !== 'string') return null;
  const lines = text.split(/\r?\n/).map((l) => l.replace(/\*\*/g, '').trim()).filter((l) => /^Siguiente:/.test(l));
  return lines.length ? cut(lines[lines.length - 1]) : null;
}

// repos: [{ id, name, branch }] in scope order; sessions: id -> attentionOf(id); prs: id -> enriched PRs (or null); last: id -> last agent text;
// snoozed: "<repoId>:<number>" keys the person parked; scrub: applied to every text first (the server replaces its token there).
function buildAttention({ repos, sessions, prs, last, now, stale, ok = true, snoozed = [], scrub = (s) => s }) {
  const cut = cutWith(scrub);
  const items = [];
  const parked = new Set(snoozed);
  // The owner of a PR is a clone that lists that same PR (so, of the same remote) and has its head checked out.
  const ownerOf = (p) => repos.find((r) => r.branch && r.branch === p.head && (prs[r.id] || []).some((x) => (x.url || `${x.number}|${x.head}`) === (p.url || `${p.number}|${p.head}`))) || null;
  for (const r of repos) {
    const s = sessions[r.id];
    if (!s) continue;
    const who = { id: r.id, name: r.name };
    for (const d of s.dialogs || []) items.push({ kind: 'asking', ...who, requestId: cut(d.requestId), method: cut(d.method), title: cut(d.title), options: (Array.isArray(d.options) ? d.options : []).map((o) => cut(o)), since: isoOf(s.since) });
    // F3 (S3, S6): a saved queue that is not in pi yet, with the first line of each message; one older than 12 h or a command waits for queue-confirm.
    const queued = Array.isArray(s.queued) ? s.queued : [];
    if (queued.length) items.push({ kind: 'queue-lost', ...who, count: queued.length, lines: queued.map((m) => ({ text: cut(String(m.text).split('\n')[0]), ...(now - m.at > OLD_MS ? { old: true } : {}), ...(isCommand(m.text) ? { command: true } : {}) })) });
    if (s.state === 'idle') {
      const next = typeof last[r.id] === 'string' ? nextLine(scrub(last[r.id])) : null;
      if (next) items.push({ kind: 'waiting', ...who, next, since: isoOf(s.since) });
      else if (Number.isFinite(s.since) && now - s.since > IDLE_MS) items.push({ kind: 'idle-no-order', ...who, since: isoOf(s.since) });
    }
    if (s.state === 'closed' && s.ended) items.push({ kind: 'session-dead', ...who, cause: s.ended.cause ? cut(s.ended.cause) : null, since: isoOf(s.ended.at) });
    if (s.state !== 'closed' && s.mode && s.mode !== EXPECTED_MODE) items.push({ kind: 'mode-not-super-yolo', ...who, mode: cut(s.mode) });
  }
  // Clones of one remote list the same PRs: each counts once, under the clone whose branch is its head when there is one.
  const seen = new Set();
  for (const r of repos) {
    for (const p of prs[r.id] || []) {
      const key = p.url || `${p.number}|${p.head}`;
      if (seen.has(key)) continue;
      if (repos.some((x) => parked.has(`${x.id}:${p.number}`) && (prs[x.id] || []).some((y) => (y.url || `${y.number}|${y.head}`) === key))) { seen.add(key); continue; } // snoozed on any clone that lists it
      const kind = p.ready === true ? 'pr-green' : p.checks && p.checks.state === 'failed' ? 'pr-red' : null;
      if (!kind) continue;
      seen.add(key);
      const owner = ownerOf(p);
      const at = owner || r;
      items.push({ kind, id: at.id, name: at.name, number: p.number, head: cut(p.head), title: cut(p.title, TITLE_MAX), clone: owner ? owner.name : null });
    }
  }
  items.sort((a, b) => ORDER.indexOf(a.kind) - ORDER.indexOf(b.kind));
  const out = { panel: { ok, stale: stale === true }, items: items.slice(0, MAX_ITEMS) };
  if (items.length > MAX_ITEMS) out.truncated = true;
  return out;
}

// A counter that moves only when the content (items, panel, truncated) of a scope changes; `at` is never part of it. Each scope keeps its own
// fingerprint, so alternating scopes never move it; it starts at the clock (ms), so a restarted panel answers above any seq of an earlier run.
function createSeq() {
  let seq = Date.now();
  const prints = new Map();
  const at = new Map();
  return (content, scope = '') => {
    const p = JSON.stringify([content.panel, content.items, content.truncated === true]);
    if (prints.get(scope) !== p) { prints.set(scope, p); seq += 1; at.set(scope, seq); }
    return at.get(scope);
  };
}

const CLOSED = { state: 'closed', since: null, mode: null, ended: null, dialogs: [] };

// Gathers the input of buildAttention for one request. Scope: the members of ?room=, else cfg.attentionRepos, else the repos with an open (or dead) session.
function collect({ cfg, room, host, store, lastOf, repoId, now }) {
  const all = cfg.groups.flatMap((g) => g.repos).map((r) => ({ id: repoId(r.path), name: r.name || path.basename(r.path) }));
  const sessionOf = (id) => {
    try { return typeof host.attentionOf === 'function' ? host.attentionOf(id) : { ...CLOSED, state: host.stateOf(id) }; } catch { return CLOSED; }
  };
  let ids;
  if (room !== undefined) {
    const found = (cfg.rooms || []).find((x) => x.name === room);
    if (!found) throw new HttpError(404, 'Unknown room');
    ids = new Set(found.repos);
  } else if (Array.isArray(cfg.attentionRepos) && cfg.attentionRepos.length) ids = new Set(cfg.attentionRepos);
  else ids = new Set(all.filter((r) => { const s = sessionOf(r.id); return s.state !== 'closed' || !!s.ended || !!(s.queued && s.queued.length); }).map((r) => r.id));
  const repos = [];
  const sessions = {};
  const prs = {};
  const last = {};
  for (const r of all.filter((x) => ids.has(x.id))) {
    let cached = null;
    try { cached = store && typeof store.cachedOf === 'function' ? store.cachedOf(r.id) : null; } catch { cached = null; }
    repos.push({ ...r, branch: cached ? cached.branch : null });
    prs[r.id] = cached ? cached.prs : null;
    sessions[r.id] = sessionOf(r.id);
    if (sessions[r.id].state === 'idle') { try { last[r.id] = lastOf(r.id); } catch { last[r.id] = null; } }
  }
  return { repos, sessions, prs, last, now, snoozed: cfg.snoozed || [] };
}

module.exports = { buildAttention, nextLine, createSeq, collect, MAX_ITEMS, IDLE_MS, EXPECTED_MODE };
