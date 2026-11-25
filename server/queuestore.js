'use strict';
// F3: queues.json (next to config.json, like push.json) keeps the messages waiting in each session's queue, so «Restart panel» (Stop-Process -Force, no exit code runs)
// does not lose them. Every change is written at once, synchronously, to a .tmp and renamed. A broken or odd file reads as empty; a write that fails stays in memory and the
// next change writes everything again. With no file it only keeps memory (the host's default).
const fs = require('node:fs');
const path = require('node:path');

const QUEUE_MAX = 20; // the caps of queueOf in server/rpchost.js
const TEXT_MAX = 4000;
const OLD_MS = 12 * 3600000; // S6: an older message waits for queue-confirm
// A saved text that starts with / or ! (a command, a shell) waits for queue-confirm too, like an old one; spaces and invisible format characters before it do not hide it.
const isCommand = (text) => /^[\s\p{Cf}]*[/!]/u.test(String(text));
const messages = (list) => (Array.isArray(list) ? list.filter((m) => m && typeof m.text === 'string' && Number.isFinite(m.at)).slice(0, QUEUE_MAX).map((m) => ({ text: m.text.slice(0, TEXT_MAX), at: m.at })) : []);
// One repo's copy: { steering: [{ text, at }], followUp: [...], confirmed }, or null when both lists are empty.
function queueOf(q) {
  if (!q || typeof q !== 'object' || Array.isArray(q)) return null;
  const out = { steering: messages(q.steering), followUp: messages(q.followUp), confirmed: q.confirmed === true };
  return out.steering.length || out.followUp.length ? out : null;
}
const copy = (q) => ({ steering: q.steering.map((m) => ({ ...m })), followUp: q.followUp.map((m) => ({ ...m })), confirmed: q.confirmed });

function createQueueStore({ file = null } = {}) {
  let data = null; // repo id -> copy
  function load() {
    if (data) return data;
    data = new Map();
    let raw = null;
    try { raw = file ? JSON.parse(fs.readFileSync(file, 'utf8')) : null; } catch { raw = null; }
    const all = raw && typeof raw === 'object' && raw.queues && typeof raw.queues === 'object' && !Array.isArray(raw.queues) ? raw.queues : {};
    for (const [id, q] of Object.entries(all)) { const clean = queueOf(q); if (clean) data.set(id, clean); }
    return data;
  }
  function save() {
    if (!file) return;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(`${file}.tmp`, JSON.stringify({ version: 1, queues: Object.fromEntries(data) }, null, 2), { mode: 0o600 });
      fs.renameSync(`${file}.tmp`, file);
    } catch { /* kept in memory: the next change writes it all again */ }
  }
  return {
    get: (id) => { const q = load().get(id); return q ? copy(q) : null; },
    // Replaces the copy of one repo (an empty one removes it) and writes the file before it returns.
    put(id, q) {
      const clean = queueOf(q);
      if (clean) load().set(id, clean); else if (!load().delete(id)) return;
      save();
    },
  };
}

module.exports = { createQueueStore, OLD_MS, isCommand };
