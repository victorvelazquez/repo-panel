'use strict';
// RPC4 (S6, S8): the series that replaced the terminal program with pi over RPC is closed. Nothing outside the history names that program any more, the CSS keeps no class of the
// cards that were deleted on the way (RP95, absorbed by RPC4), and the README says where the page code lives. History is only docs/ROADMAP.md, the fichas under odd/ and the mockups
// under design/: they tell what happened and may name it. The word is built in pieces so this file does not name it either.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { APP_FILES } = require('./pagesrc.js');

const ROOT = path.join(__dirname, '..');
const NAME = new RegExp('or' + 'ca', 'i');
const SKIP_DIRS = new Set(['node_modules', '.git', '.panel', '.atl']); // the person's own scratch folders: Git ignores them, so they are not part of the repository
const HISTORY_DIRS = ['odd', 'design'];
const HISTORY_FILES = ['docs/ROADMAP.md'];
const TEXT = /\.(js|json|md|html|css|yml|yaml|txt|cmd|sh)$/i;

function walk(dir = ROOT, rel = '') {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) out.push(...walk(path.join(dir, e.name), r)); } else if (TEXT.test(e.name)) out.push(r);
  }
  return out;
}
// What the repository contains: the files Git tracks plus the new ones not yet tracked, never the ignored ones. Without a .git it falls back to walking the folder.
function files() {
  try {
    return execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { cwd: ROOT, encoding: 'utf8' }).split('\0').filter((r) => r && TEXT.test(r) && fs.existsSync(path.join(ROOT, r)));
  } catch { return walk(); }
}
const isHistory = (rel) => HISTORY_FILES.includes(rel) || HISTORY_DIRS.some((d) => rel === d || rel.startsWith(`${d}/`));

test('no file outside the history names the program the series replaced', () => {
  const hits = [];
  for (const rel of files().filter((r) => !isHistory(r))) {
    fs.readFileSync(path.join(ROOT, rel), 'utf8').split('\n').forEach((l, i) => { if (NAME.test(l)) hits.push(`${rel}:${i + 1}: ${l.trim().slice(0, 100)}`); });
  }
  assert.deepEqual(hits, [], `the history may name it, nothing else:\n${hits.join('\n')}`);
});

test('the history exemption is exactly the roadmap, the fichas and the mockups, and those places exist', () => {
  assert.deepEqual(HISTORY_FILES, ['docs/ROADMAP.md']);
  assert.deepEqual(HISTORY_DIRS, ['odd', 'design']);
  for (const p of [...HISTORY_FILES, ...HISTORY_DIRS]) assert.ok(fs.existsSync(path.join(ROOT, p)), p);
  assert.ok(files().length > 100, 'the list sees the repository');
  assert.ok(!files().some((r) => r.startsWith('.atl/') || r.startsWith('.panel/') || r === 'config.json'), 'ignored files are not part of the repository');
});

test('style.css keeps no class of the cards deleted by the series (RP95)', () => {
  const css = fs.readFileSync(path.join(ROOT, 'public', 'style.css'), 'utf8');
  const DEAD = ['group-head', 'repo-top', 'card-title', 'rm-count', 'rs-count', 'rs-stale', 'ch-foot', 'ch-asking', 'ch-ask-note', 'ch-ask-sending', 'ch-ask-done', 'ch-ask-error'];
  const left = DEAD.filter((c) => new RegExp(`\\.${c}(?![\\w-])`).test(css));
  assert.deepEqual(left, []);
});

test('the README says where the page code lives: every page script, in load order', () => {
  const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8').replace(/\r\n/g, '\n'); // a Windows checkout has \r\n
  const section = (readme.match(/^## Page code\n([\s\S]*?)(?=^## )/m) || [])[1];
  assert.ok(section, 'the README has a "Page code" section');
  for (const f of ['view.js', 'resumen.js', ...APP_FILES]) assert.ok(section.includes(`public/${f}`), `the section names public/${f}`);
  const order = APP_FILES.map((f) => section.indexOf(`public/${f}`));
  assert.deepEqual(order, [...order].sort((a, b) => a - b), 'the section lists the page scripts in the order index.html loads them');
});
