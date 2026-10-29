'use strict';
// RP69 (S63): nothing the person reads names "pi" or "Gentle Shell": the panel says "session". Internal names (api/pi, PI_COMMANDS,
// piSend, comments) stay as they are. The guard reads the source files and looks at every line that is not a pure comment (a forbidden
// phrase on such a line is inside a string, a template or a regular expression, i.e. in text the person can read or in a test that pins it).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
// "Gentle Shell" as a phrase; the folder `.gentle-shell` and the command that starts a session are technical, not text.
const FORBIDDEN = /\b[Pp]i (?:sessions?|prompt|screens?|terminals?|orders?)\b|\b(?:to|in|of|with) pi\b|Gentle Shell/;

// A source line without its comment: pure comment lines go away, and a trailing " // ..." is cut (URLs have no space before //).
function code(line) {
  const t = line.trim();
  if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) return '';
  const cut = line.search(/\s\/\/\s/);
  return cut >= 0 ? line.slice(0, cut) : line;
}
const files = (dir, ext) => fs.readdirSync(path.join(ROOT, dir)).filter((n) => n.endsWith(ext)).map((n) => path.join(dir, n));

const VISIBLE = [...files('public', '.js'), 'public/index.html', ...files('server', '.js'), 'lib.js', 'checks.js'];

test('no visible text names pi or Gentle Shell (source files)', () => {
  const found = [];
  for (const f of VISIBLE) {
    fs.readFileSync(path.join(ROOT, f), 'utf8').split(/\r?\n/).forEach((line, i) => {
      const c = code(line);
      if (FORBIDDEN.test(c)) found.push(`${f}:${i + 1}: ${c.trim().slice(0, 100)}`);
    });
  }
  assert.deepEqual(found, []);
});

test('the README talks about "the session", never "the pi session", and names Gentle Shell only where it explains how a session is recognised', () => {
  const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
  const found = readme.split(/\r?\n/).map((l, i) => [i + 1, l]).filter(([, l]) => /\b[Pp]i sessions?\b/.test(l)).map(([n, l]) => `README.md:${n}: ${l.slice(0, 90)}`);
  assert.deepEqual(found, []);
  assert.ok((readme.match(/Gentle Shell/g) || []).length <= 3, 'Gentle Shell stays in the technical recognition and folder notes only');
});

test('the guard itself catches what it must and lets the internal names through', () => {
  for (const bad of ["'The pi session is working'", '`Sent ${x} to pi`', "'Message the pi session of repo'", '/The pi session closed/', "'Gentle Shell pi screen'"]) assert.ok(FORBIDDEN.test(bad), bad);
  for (const ok of ["'/api/pi'", "'/api/pi-status'", 'PI_COMMANDS', 'piSend(repo)', "'pi': async (el) => {", "const piBusy = new Set();", "'Waiting for the session'"]) assert.ok(!FORBIDDEN.test(ok), ok);
  assert.equal(code('  // the pi session of the repo'), '');
  assert.equal(code("const a = 1; // a pi session here").trim(), 'const a = 1;');
});
