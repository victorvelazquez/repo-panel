'use strict';
// INSTALL.md is read by the agent as numbered steps. A step starts at "N. " and runs until the next numbered line, so
// it can carry indented sub-points. Shared by the tests that pin what the agent reads.
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const lf = (text) => text.replace(/\r\n/g, '\n');
const read = (...p) => lf(fs.readFileSync(path.join(ROOT, ...p), 'utf8'));
const installText = () => read('requirements', 'INSTALL.md');

function steps(src = installText()) {
  const out = {};
  let n = null;
  for (const line of src.split('\n')) {
    const m = /^(\d+)\. /.exec(line);
    if (m) { n = Number(m[1]); out[n] = line; } else if (n !== null && line.trim() !== '') out[n] += `\n${line}`;
  }
  return out;
}
const step = (n) => steps()[n];

module.exports = { ROOT, lf, read, installText, steps, step };
