'use strict';
// Passive recorder of pi screens that look like a question for the user (lib.piScreenQuestionish), kept to study the
// ones the panel does not recognise yet. It only observes: it never answers, never presses a key and never changes
// what the panel shows. One JSON line per case is appended to a local file; the lines can hold commands or paths.
const fsp = require('node:fs/promises');
const path = require('node:path');
const lib = require('../lib.js');

const MIN_GAP_MS = 30 * 1000;
const MAX_BYTES = 1024 * 1024;
const WARN_EVERY_MS = 60 * 1000;

// REPO_PANEL_CASES_FILE wins; an empty value or `off` disables recording (null); the default is git-ignored.
function casesFile(env, root) {
  const v = env.REPO_PANEL_CASES_FILE;
  if (v === undefined) return path.join(root, '.panel', 'casos-preguntas.jsonl');
  return v === '' || v.toLowerCase() === 'off' ? null : v;
}

// Digits removed and whitespace collapsed, so a ticking timer or counter does not make the same question look new.
const normalize = (lines) => lines.join('\n').replace(/\d+/g, '').replace(/\s+/g, ' ').trim();

// `fs` is the promises API (mkdir, stat, appendFile); `now` returns milliseconds. record() is fire-and-forget: it
// returns nothing, never throws, and the write happens later. flush() resolves when the pending writes are done.
function createRecorder({ file, fs = fsp, now = Date.now, minGapMs = MIN_GAP_MS, maxBytes = MAX_BYTES } = {}) {
  const last = new Map(); // handle -> { text: of the last recorded case, null once the screen left the question, at }
  let chain = Promise.resolve();
  let ready = null;
  let fullSaid = false;
  let warnedAt = -Infinity;

  const warn = (msg) => {
    try {
      const t = now();
      if (t - warnedAt < WARN_EVERY_MS) return;
      warnedAt = t;
      console.warn(`repo-panel: case recorder: ${msg}`);
    } catch { /* nothing to do */ }
  };

  async function write(line) {
    ready = ready || fs.mkdir(path.dirname(file), { recursive: true });
    await ready;
    let size = 0;
    try { size = (await fs.stat(file)).size; } catch (e) { if (e && e.code !== 'ENOENT') throw e; }
    if (size > maxBytes) {
      if (!fullSaid) { fullSaid = true; console.log(`repo-panel: case recorder stopped: ${file} is over ${maxBytes} bytes`); }
      return;
    }
    await fs.appendFile(file, line, 'utf8');
  }

  function record(input) {
    try {
      const { folder, handle, state, preview } = input || {};
      const q = lib.piScreenQuestionish(preview);
      const key = String(handle);
      if (!q) {
        const old = last.get(key);
        if (old) old.text = null;
        return;
      }
      const text = normalize(q.lines);
      const old = last.get(key);
      const t = now();
      if (old && old.text === text) return;
      if (old && t - old.at < minGapMs) return;
      last.set(key, { text, at: t });
      const line = `${JSON.stringify({ at: new Date(t).toISOString(), folder, handle, state, recognized: lib.piScreenAsk(preview) !== null, signals: q.signals, lines: q.lines })}\n`;
      chain = chain.then(() => write(line)).catch((e) => warn(String((e && e.message) || e)));
    } catch (e) {
      warn(String((e && e.message) || e));
    }
  }

  return { record, flush: () => chain };
}

module.exports = { createRecorder, casesFile };
