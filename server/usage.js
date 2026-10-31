'use strict';
// RP62 (S61, S77): the Claude usage the Gentle Shell extension wrote to a small JSON file. This only reads it, never writes, and answers a fixed
// shape: { available, five, seven, updatedAt, stale }. Anything unusable is "unavailable"; nothing from the file but those keys is ever returned.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const MAX_BYTES = 16384;
const STALE_MS = 15 * 60 * 1000;
const SECONDS_BELOW = 1e12; // a resetAt below this is epoch seconds
const UNAVAILABLE = { available: false, five: null, seven: null, updatedAt: null, stale: false };

const usageFile = (env = process.env) => (typeof env.REPO_PANEL_USAGE_FILE === 'string' && env.REPO_PANEL_USAGE_FILE
  ? env.REPO_PANEL_USAGE_FILE
  : path.join(os.homedir(), '.gentle-shell', 'agent', 'claude-usage.json'));

const isObject = (x) => !!x && typeof x === 'object' && !Array.isArray(x);
const positive = (x) => typeof x === 'number' && Number.isFinite(x) && x > 0;

// One window as { percent, resetAt (ms), expired }, or null. A window that already reset keeps no percent: the old number would be a lie.
function windowOf(w, now) {
  if (!isObject(w) || typeof w.percent !== 'number' || !(w.percent >= 0 && w.percent <= 100) || !positive(w.resetAt)) return null;
  const resetAt = w.resetAt < SECONDS_BELOW ? w.resetAt * 1000 : w.resetAt;
  const expired = resetAt <= now;
  return { percent: expired ? null : Math.round(w.percent), resetAt, expired };
}

async function readUsage({ file = usageFile(), now = Date.now } = {}) {
  try {
    if ((await fs.promises.stat(file)).size > MAX_BYTES) return { ...UNAVAILABLE };
    const text = await fs.promises.readFile(file);
    if (text.length > MAX_BYTES) return { ...UNAVAILABLE };
    const doc = JSON.parse(text.toString('utf8'));
    if (!isObject(doc) || doc.version !== 1 || !positive(doc.updatedAt)) return { ...UNAVAILABLE };
    const t = now();
    const windows = isObject(doc.windows) ? doc.windows : {};
    return { available: true, five: windowOf(windows['5h'], t), seven: windowOf(windows['7d'], t), updatedAt: doc.updatedAt, stale: t - doc.updatedAt >= STALE_MS };
  } catch {
    return { ...UNAVAILABLE };
  }
}

module.exports = { readUsage, usageFile };
