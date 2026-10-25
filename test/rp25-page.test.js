'use strict';
// RP25 (S23): the board of the page. A Merged column, a collapsible Idle bar instead of the Clean column, a Needs
// attention column that exists only while it has cards, and a preference that brings the Clean column back.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const view = require('../public/view.js');

const ROOT = path.join(__dirname, '..');
// Windows runners check the repo out with CRLF line endings: read everything as LF so the regexes below do not depend on it.
const lf = (text) => text.replace(/\r\n/g, '\n');
const read = (f) => lf(fs.readFileSync(path.join(ROOT, f), 'utf8'));
const rule = (css, sel) => {
  const m = new RegExp(`(?:^|\\n)${sel.replace(/\./g, '\\.')}\\s*\\{([^}]*)\\}`).exec(css);
  return m ? m[1] : null;
};

const stub = () => new Proxy(function stubElement() {}, {
  get: (t, k) => (k === 'content' ? 'token' : k === 'dataset' ? {} : k === 'classList' ? { add() {}, remove() {}, toggle() {} } : k === Symbol.toPrimitive ? () => '' : stub),
  set: () => true,
  apply: () => stub(),
});

async function loadPage(stored = {}) {
  const app = { innerHTML: '' };
  const saved = {};
  const ctx = vm.createContext({
    console,
    document: new Proxy({}, { get: (t, k) => (k === 'hidden' ? false : k === 'querySelector' ? (sel) => (sel === '#app' ? app : stub()) : stub) }),
    localStorage: { getItem: (k) => (k in stored ? stored[k] : null), setItem: (k, v) => { saved[k] = v; } },
    location: { hash: '' },
    requestAnimationFrame: () => 0,
    setInterval: () => 0,
    setTimeout: () => 0,
    confirm: () => true,
    fetch: async () => { throw new Error('offline'); },
  });
  ctx.window = ctx;
  ctx.RepoPanelView = view;
  vm.runInContext(read('public/app.js'), ctx);
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
  return { get: (name) => vm.runInContext(name, ctx), app, saved };
}

const file = { path: 'a.txt', status: 'M', untracked: false };
const local = (o = {}) => ({ branch: 'main', detached: false, upstream: 'origin/main', noUpstream: false, ahead: 0, behind: 0, files: [], added: 0, deleted: 0, head: 'h1', inProgress: null, base: 'main', ...o });
const stale = { via: 'merged', pr: 7, reason: 'Merged: run /flow-base' };
const repo = (name) => ({ id: `id-${name}`, name, path: `C:/x/${name}`, group: 'g' }); // group: as allRepos() adds it
const REPOS = { quiet: repo('quiet-repo'), quiet2: repo('quiet-two'), stale: repo('stale-repo'), manual: repo('manual-repo'), dirty: repo('dirty-repo') };
const STATE = {
  quiet: [local(), { prs: [], stale: null }],
  quiet2: [local(), { prs: [], stale: null }],
  stale: [local({ branch: 'task', upstream: 'origin/task', currentGone: true }), { prs: [], stale }],
  manual: [local({ branch: null, detached: true }), { prs: [], stale: null }],
  dirty: [local({ files: [file] }), { prs: [], stale: null }],
};

function setup(page, keys, prefs = {}) {
  const S = page.get('S');
  S.groups = [{ name: 'g', repos: keys.map((k) => REPOS[k]) }];
  for (const k of keys) { S.local[REPOS[k].id] = STATE[k][0]; S.prs[REPOS[k].id] = { ...STATE[k][1], repo: { url: `https://github.com/o/${REPOS[k].name}` } }; }
  Object.assign(S.prefs, prefs);
  return S;
}

// The board's sections by column key.
function sections(html) {
  const out = [];
  const re = /<section class="col col-([a-z]+)">([\s\S]*?)<\/section>/g;
  let m;
  while ((m = re.exec(html))) out.push({ key: m[1], html: m[2] });
  return out;
}
const byKey = (html, key) => sections(html).find((s) => s.key === key);

test('page: default layout puts the stale-clean repo in Merged with its attention card and keeps the others where they were', async () => {
  const page = await loadPage();
  setup(page, ['quiet', 'stale', 'manual', 'dirty']);
  page.get('render')();
  const html = page.app.innerHTML;
  assert.deepEqual(sections(html).map((s) => s.key), ['attention', 'changes', 'committed', 'progress', 'ready', 'merged']);
  const R = REPOS;
  const merged = byKey(html, 'merged');
  assert.ok(merged.html.includes('stale-repo'));
  assert.ok(merged.html.includes(page.get('repoCard')(R.stale, true, null)), 'the same card markup as before, marked as attention');
  assert.match(merged.html, /<h2>Merged<\/h2>/);
  assert.match(merged.html, /title="Merged: run \/flow-base"/);
  assert.ok(byKey(html, 'changes').html.includes('dirty-repo'), 'changes is unchanged');
  assert.ok(!html.includes('col-clean'), 'no Clean column by default');
});

test('page: the Merged column has no other repo and shows the empty marker when there is none', async () => {
  const page = await loadPage();
  setup(page, ['quiet', 'dirty']);
  page.get('render')();
  const merged = byKey(page.app.innerHTML, 'merged');
  assert.ok(merged, 'Merged is always a column');
  assert.match(merged.html, /<span class="n">0<\/span>/);
  assert.ok(!merged.html.includes('quiet-repo') && !merged.html.includes('dirty-repo'));
});

test('page: Needs attention holds the manual-action card, is first, and is not hidden in the closed bar', async () => {
  const page = await loadPage();
  setup(page, ['quiet', 'manual']);
  page.get('render')();
  const html = page.app.innerHTML;
  const cols = sections(html);
  assert.equal(cols[0].key, 'attention');
  assert.match(cols[0].html, /<h2>Needs attention<\/h2>/);
  assert.ok(cols[0].html.includes(page.get('repoCard')(REPOS.manual, true, null)));
  const idle = /<div class="idle[\s\S]*$/.exec(html)[0];
  assert.ok(!idle.includes('manual-repo'), 'the idle bar never holds a card that needs a person');
  assert.ok(html.indexOf('manual-repo') < html.indexOf('class="idle'), 'it is on the board, above the bar');
});

test('page: a failed /flow-commit with a clean tree goes to Needs attention', async () => {
  const page = await loadPage();
  const S = setup(page, ['quiet']);
  S.sent[REPOS.quiet.id] = { at: Date.now() - 3600 * 1000, head: 'h1', files: 1, cmd: 'flow-commit' };
  S.pistatus[REPOS.quiet.id] = 'idle';
  const verdict = page.get('verdictOf')(REPOS.quiet);
  assert.equal(verdict && verdict.state, 'attention', 'precondition: the verdict is attention');
  page.get('render')();
  const html = page.app.innerHTML;
  assert.ok(byKey(html, 'attention').html.includes('quiet-repo'));
  assert.ok(!/class="idle/.test(html), 'and nothing is left idle');
});

test('page: no Needs attention column without cards', async () => {
  const page = await loadPage();
  setup(page, ['quiet', 'dirty', 'stale']);
  page.get('render')();
  assert.ok(!byKey(page.app.innerHTML, 'attention'));
  assert.ok(!page.app.innerHTML.includes('Needs attention'));
});

test('page: the Idle bar is closed by default, counts the quiet repos and its header is a button with aria-expanded', async () => {
  const page = await loadPage();
  setup(page, ['quiet', 'quiet2', 'dirty']);
  page.get('render')();
  const html = page.app.innerHTML;
  const btn = /<button[^>]*data-act="toggle-idle"[^>]*>([\s\S]*?)<\/button>/.exec(html);
  assert.ok(btn, 'a button toggles the bar');
  assert.match(btn[0], /type="button"/);
  assert.match(btn[0], /aria-expanded="false"/);
  assert.match(btn[1], /Idle · 2 repos/);
  assert.ok(!html.includes('quiet-repo') && !html.includes('quiet-two'), 'closed: the rows are not shown');
  assert.ok(!html.includes('clean-row'));
});

test('page: the open Idle bar lists the rows with exactly the markup of cleanRow, inside a container for future actions', async () => {
  const page = await loadPage();
  setup(page, ['quiet', 'quiet2'], { idleOpen: true });
  page.get('render')();
  const html = page.app.innerHTML;
  assert.match(html, /data-act="toggle-idle"[^>]*aria-expanded="true"/);
  const list = /<div class="idle-list"[^>]*>([\s\S]*?)<\/div><\/div>\s*$/.exec(html) || /<div class="idle-list"[^>]*>([\s\S]*)$/.exec(html);
  assert.ok(list, 'the rows live in .idle-list');
  assert.ok(list[1].includes(page.get('cleanRow')(REPOS.quiet)));
  assert.ok(list[1].includes(page.get('cleanRow')(REPOS.quiet2)));
  assert.match(page.get('cleanRow')(REPOS.quiet), /^<div class="clean-row">/);
});

test('page: the Idle bar shows nothing when no repo is idle', async () => {
  const page = await loadPage();
  setup(page, ['dirty', 'manual']);
  page.get('render')();
  assert.ok(!/idle/i.test(page.app.innerHTML.replace(/idle-?repo/gi, '')), 'no bar markup at all');
});

test('page: the Idle bar header offers Show as column', async () => {
  const page = await loadPage();
  setup(page, ['quiet']);
  page.get('render')();
  assert.match(page.app.innerHTML, /<button[^>]*data-act="clean-as-column"[^>]*>Show as column<\/button>/);
});

test('page: toggle-idle flips the preference, persists it in the prefs entry and redraws', async () => {
  const page = await loadPage();
  const S = setup(page, ['quiet']);
  const A = page.get('ACTIONS');
  A['toggle-idle']();
  assert.equal(S.prefs.idleOpen, true);
  assert.equal(JSON.parse(page.saved.prefs).idleOpen, true);
  A['toggle-idle']();
  assert.equal(S.prefs.idleOpen, false);
  assert.equal(JSON.parse(page.saved.prefs).idleOpen, false);
});

test('page: a stored idleOpen preference is honoured on load (state survives a reload)', async () => {
  const page = await loadPage({ prefs: JSON.stringify({ method: 'squash', del: true, idleOpen: true, cleanAsColumn: false }) });
  setup(page, ['quiet']);
  page.get('render')();
  assert.match(page.app.innerHTML, /aria-expanded="true"/);
  assert.ok(page.app.innerHTML.includes('quiet-repo'));
});

test('page: cleanAsColumn brings back the Clean column first with the rows and the attention cards, no bar, no Needs attention', async () => {
  const page = await loadPage();
  setup(page, ['quiet', 'stale', 'manual', 'dirty'], { cleanAsColumn: true });
  page.get('render')();
  const html = page.app.innerHTML;
  assert.deepEqual(sections(html).map((s) => s.key), ['clean', 'changes', 'committed', 'progress', 'ready', 'merged']);
  const clean = byKey(html, 'clean');
  assert.match(clean.html, /<h2>Clean<\/h2>/);
  assert.match(clean.html, /title="Nothing to do"/);
  assert.ok(clean.html.includes(page.get('cleanRow')(REPOS.quiet)));
  assert.ok(clean.html.includes(page.get('repoCard')(REPOS.manual, true, null)));
  assert.ok(!clean.html.includes('stale-repo'), 'the stale repo is in Merged in both modes');
  assert.ok(byKey(html, 'merged').html.includes('stale-repo'));
  assert.ok(!html.includes('data-act="toggle-idle"') && !html.includes('Needs attention'));
});

test('page: the clean-as-column action and the header checkbox set the same preference', async () => {
  const page = await loadPage();
  const S = setup(page, ['quiet']);
  page.get('ACTIONS')['clean-as-column']();
  assert.equal(S.prefs.cleanAsColumn, true);
  assert.equal(JSON.parse(page.saved.prefs).cleanAsColumn, true);
  assert.match(read('public/index.html'), /<input[^>]*type="checkbox"[^>]*data-pref="cleanAsColumn"/, 'the always-visible header toggle');
  assert.match(read('public/index.html'), /id="cleanAsColumn"[^>]*data-pref="cleanAsColumn"|data-pref="cleanAsColumn"[^>]*id="cleanAsColumn"/);
  assert.match(read('public/app.js'), /\$\('#cleanAsColumn'\)\.checked = !!S\.prefs\.cleanAsColumn/, 'the checkbox reflects the stored preference on load');
});

test('page: the problems filter hides the idle bar and keeps the attention cards', async () => {
  const page = await loadPage();
  const S = setup(page, ['quiet', 'manual']);
  S.onlyProblems = true;
  page.get('render')();
  const html = page.app.innerHTML;
  assert.ok(!html.includes('data-act="toggle-idle"'));
  assert.ok(byKey(html, 'attention').html.includes('manual-repo'));
});

test('css: Merged is purple, Needs attention is red, Clean keeps its gray and the other borders are untouched', () => {
  const css = read('public/style.css');
  assert.match(rule(css, '.col-merged'), /border-top-color:\s*var\(--purple\)/);
  assert.match(rule(css, '.col-attention'), /border-top-color:\s*var\(--red\)/);
  assert.match(rule(css, '.col-clean'), /border-top-color:\s*var\(--gray\)/);
  assert.match(rule(css, '.col-changes'), /border-top-color:\s*var\(--yellow\)/);
  assert.match(rule(css, '.col-committed'), /border-top-color:\s*var\(--blue\)/);
  assert.match(rule(css, '.col-progress'), /border-top-color:\s*var\(--green\)/);
  assert.match(rule(css, '.col-ready'), /border-top-color:\s*#238636/);
  assert.match(css, /--bg: #0f1216; --panel: #171b21; --panel2: #1e242c; --line: #2a323c; --text: #d7dde5; --muted: #8b96a3;/);
});

test('css: the board grows with the number of columns instead of fixing five', () => {
  const css = read('public/style.css');
  assert.ok(!/\.board\s*\{[^}]*repeat\(5,/.test(css));
  assert.match(rule(css, '.board'), /grid-auto-flow:\s*column/);
  assert.match(rule(css, '.board'), /grid-auto-columns:\s*minmax\(200px,\s*1fr\)/);
  assert.ok(rule(css, '.idle-toggle'), 'the toggle is styled');
});

test('README describes the new board and how to get the Clean column back', () => {
  const readme = read('README.md');
  assert.match(readme, /Merged/);
  assert.match(readme, /Idle/);
  assert.match(readme, /Needs attention/);
  assert.match(readme, /Clean column/);
});
