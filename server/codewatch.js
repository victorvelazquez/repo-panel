'use strict';
// RP201: tells whether the code of the server on disk is not the one it started with. A server loads its code when it starts and never notices that the disk changed (a route added after the start answers 404 until
// the restart). At start it keeps a FINGERPRINT of the content of the files it has loaded; `stale()` is true when the fingerprint of NOW is another one. The content is measured, not the date: changing branch without a
// change of content, touching a file, or a change and its undo never make the server stale, and line endings do not count (a checkout with CRLF is the same code). The files of public/ are read on every request and never
// make it old. It only informs: nothing here restarts anything.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const JS = /\.js$/;

// The files a running server has loaded: the root *.js (server.js, lib.js, checks.js) and server/*.js, as relative paths with forward slashes, sorted. Files only: no folder is entered.
function codeFiles(root, { readdir = fs.readdirSync } = {}) {
  // A folder that is not there has no files: that is a change of the code like any other (it is told by the fingerprint), not an error. Any other failure (no permission) is.
  const jsIn = (rel) => {
    let entries;
    try { entries = readdir(path.join(root, rel), { withFileTypes: true }); } catch (e) { if (e && e.code === 'ENOENT') return []; throw e; }
    return entries.filter((e) => e.isFile() && JS.test(e.name)).map((e) => (rel ? `${rel}/${e.name}` : e.name));
  };
  return [...jsIn(''), ...jsIn('server')].sort();
}

// sha-256 (hex) of the names and the content of those files. Every file goes in with its name and its length, so the same text split in another way, or under another name, is another code.
function fingerprint(root, { readdir = fs.readdirSync, readFile = fs.readFileSync } = {}) {
  const hash = crypto.createHash('sha256');
  for (const rel of codeFiles(root, { readdir })) {
    const text = String(readFile(path.join(root, rel), 'utf8')).replace(/\r\n/g, '\n');
    hash.update(`${rel}\0${text.length}\0${text}\0`);
  }
  return hash.digest('hex');
}

// The fingerprint is taken NOW (call it right after the modules are loaded) and compared with the one of the disk at most once per `ttlMs`, so a page that asks every few seconds reads the files once a minute at most.
// When the files cannot be read it never throws and never warns by mistake: with no fingerprint at the start it is never stale; later it keeps its last answer.
function createCodeWatch({ root, ttlMs = 30000, now = Date.now, readdir = fs.readdirSync, readFile = fs.readFileSync } = {}) {
  let started = null;
  try { started = fingerprint(root, { readdir, readFile }); } catch { started = null; }
  let checkedAt = now();
  let last = false;
  return {
    stale() {
      if (started === null) return false;
      const t = now();
      if (t - checkedAt < ttlMs) return last;
      checkedAt = t;
      try { last = fingerprint(root, { readdir, readFile }) !== started; } catch { /* it keeps what it knew */ }
      return last;
    },
  };
}

module.exports = { codeFiles, fingerprint, createCodeWatch };
