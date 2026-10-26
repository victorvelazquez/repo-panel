'use strict';
// RP23 part 3 (S22): colors that follow GitHub. A color per action for the animated progress lines and the pending CI
// chip, and the top border of the five columns. The text of every line stays: color is never the only cue.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const view = require('../public/view.js');

const lf = (text) => text.replace(/\r\n/g, '\n');
const read = (f) => lf(fs.readFileSync(path.join(__dirname, '..', 'public', f), 'utf8'));
const css = read('style.css');

const rule = (selector) => {
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = new RegExp(`(?:^|\\n)${esc}\\s*\\{([^}]*)\\}`).exec(css);
  return m ? m[1] : null;
};
const variable = (name) => new RegExp(`${name}:\\s*(#[0-9a-fA-F]{6})`).exec(/:root \{[\s\S]*?\n\}/.exec(css)[0])?.[1];

// ---------- variables ----------
test(':root keeps its palette and adds --purple and --orange', () => {
  assert.equal(variable('--purple'), '#a371f7');
  assert.equal(variable('--orange'), '#db6d28');
  assert.equal(variable('--blue'), '#58a6ff');
  assert.equal(variable('--yellow'), '#d29922');
  assert.equal(variable('--green'), '#3fb950');
  assert.equal(variable('--gray'), '#6e7681');
});

test('PRESERVE: the base palette the person did not approve to change is untouched', () => {
  assert.equal(variable('--bg'), '#0f1216');
  assert.equal(variable('--panel'), '#171b21');
  assert.equal(variable('--line'), '#2a323c');
  assert.equal(variable('--text'), '#d7dde5');
  assert.equal(variable('--muted'), '#8b96a3');
});

// ---------- the color of each action ----------
test('runColor: one color per command', () => {
  assert.equal(view.runColor('flow-commit'), 'blue');
  assert.equal(view.runColor('flow-commit-unstage'), 'blue');
  assert.equal(view.runColor('flow-pr'), 'green');
  assert.equal(view.runColor('flow-base'), 'purple');
  assert.equal(view.runColor('flow-base-stash'), 'purple');
  assert.equal(view.runColor('fix-pr'), 'orange');
  assert.equal(view.runColor('put-in-conditions'), 'gray');
  assert.equal(view.runColor('something-else'), 'gray');
  assert.equal(view.runColor(undefined), 'gray');
});

test('css: each data-run value colors the running line with its variable; the pending chip is yellow already', () => {
  for (const name of ['blue', 'green', 'purple', 'orange', 'gray']) {
    const r = rule(`.verdict-line[data-run="${name}"]`);
    assert.ok(r, `data-run="${name}" exists`);
    assert.match(r, new RegExp(`color:\\s*var\\(--${name}\\)`));
  }
  assert.match(rule('.chip.yellow'), /color:\s*var\(--yellow\)/);
});

// ---------- the page ----------
const stub = () => new Proxy(function stubElement() {}, {
  get: (t, k) => (k === 'content' ? 'token' : k === 'dataset' ? {} : k === 'classList' ? { add() {}, remove() {}, toggle() {} } : k === Symbol.toPrimitive ? () => '' : stub),
  set: () => true,
  apply: () => stub(),
});

async function loadPage() {
  const ctx = vm.createContext({
    console,
    document: new Proxy({}, { get: (t, k) => (k === 'hidden' ? false : stub) }),
    localStorage: { getItem: () => null, setItem() {} },
    location: { hash: '' },
    requestAnimationFrame: () => 0,
    setInterval: () => 0,
    setTimeout: () => 0,
    confirm: () => true,
    fetch: async () => { throw new Error('offline'); },
  });
  ctx.window = ctx;
  ctx.RepoPanelView = view;
  vm.runInContext(read('app.js'), ctx);
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
  return { get: (name) => vm.runInContext(name, ctx) };
}

const R = { id: 'abc', name: 'demo', path: 'x' };
const running = (cmd, label) => ({ state: 'running', reason: 'r', label, cmd });

test('page: the running line carries the modifier of its command and keeps its text', async () => {
  const page = await loadPage();
  const verdictRow = page.get('verdictRow');
  const cases = [
    ['flow-commit', 'committing…', 'blue'], ['flow-pr', 'creating pull request…', 'green'],
    ['flow-base', 'updating base branch…', 'purple'], ['fix-pr', 'fixing pull request…', 'orange'],
    ['put-in-conditions', 'putting repo in conditions…', 'gray'],
  ];
  for (const [cmd, label, color] of cases) {
    const html = verdictRow(R, running(cmd, label));
    assert.match(html, new RegExp(`class="verdict-line"[^>]* data-run="${color}"`), cmd);
    assert.ok(html.includes(label.slice(0, -1)), `${cmd}: the text stays`);
    assert.match(html, /class="pulse-dot"/);
    assert.match(html, /class="ell"/);
  }
});

test('page: the session waiting for the user keeps the static ask line, with no data-run', async () => {
  const page = await loadPage();
  const html = page.get('verdictRow')(R, { state: 'running', asking: true, reason: 'r', label: 'waiting for your answer in the session', cmd: 'flow-commit' });
  assert.match(html, /class="ask-line"/);
  assert.ok(!/data-run/.test(html));
});

test('page: PRESERVE the attention bar and the empty verdicts', async () => {
  const page = await loadPage();
  const verdictRow = page.get('verdictRow');
  assert.equal(verdictRow(R, null), '');
  assert.equal(verdictRow(R, { state: 'ok' }), '');
  const html = verdictRow(R, { state: 'attention', reason: 'nope', cmd: 'flow-commit' });
  assert.match(html, /class="attn-bar"/);
  assert.ok(!/data-run/.test(html));
});

test('page: the pending CI chip is yellow (unchanged), and the final chips are as before', async () => {
  const page = await loadPage();
  const chip = page.get('checksChip');
  const items = [{ name: 'a', state: 'pending' }];
  const pending = chip({ state: 'pending', pending: 2, passed: 2, total: 4, failed: 0, items });
  assert.match(pending, /^<span class="chip yellow chip-verify" /);
  assert.ok(pending.includes('verifying checks · 2 running · 2/4'));
  assert.match(chip({ state: 'success', passed: 4, total: 4, items }), /^<span class="chip green" /);
  assert.match(chip({ state: 'failed', passed: 3, failed: 1, total: 4, items }), /^<span class="chip red" /);
  assert.equal(chip({ state: 'none', items: [] }), '<span class="chip gray">no checks</span>');
});

// ---------- the columns ----------
test('css: top border of the five columns follows GitHub', () => {
  assert.match(rule('.col-clean'), /border-top-color:\s*var\(--gray\)/);
  assert.match(rule('.col-changes'), /border-top-color:\s*var\(--yellow\)/);
  assert.match(rule('.col-committed'), /border-top-color:\s*var\(--blue\)/);
  assert.match(rule('.col-prs'), /border-top-color:\s*#238636/); // RP28: Open PRs and Ready to merge became one column
  assert.match(rule('button.merge'), /background:\s*#238636/);
});

// RP23 left the Merged column out on purpose; RP25 adds it, purple, so this pin now says the opposite.
test('css: the Merged column (added by RP25) is purple and the existing borders above did not change', () => {
  assert.match(rule('.col-merged'), /border-top-color:\s*var\(--purple\)/);
  assert.ok(/key: 'merged'/.test(read('app.js')));
});

test('css: the reduced-motion block and the ask line are untouched', () => {
  assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{\n  \.pulse-dot, \.ell, button\.loading \.ico \{ animation: none; \}\n\}/);
  assert.match(rule('.ask-line'), /border-left:\s*3px solid var\(--yellow\)/);
});
