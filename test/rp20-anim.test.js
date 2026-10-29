'use strict';
// RP20 part A: CSS-only animated progress lines and the verifying chip. The page re-renders #app on every draw, so
// each animated element carries an inline negative animation-delay computed from the clock to stay continuous.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const view = require('../public/view.js');

const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'style.css'), 'utf8');

// ---------- the delay helper ----------
test('animDelay: a negative delay in ms from the injected clock, always within one period', () => {
  const P = view.ANIM_MS;
  assert.ok(Number.isInteger(P) && P > 0);
  assert.equal(view.animDelay(0), 0);
  assert.ok(Object.is(view.animDelay(0), 0), 'never -0');
  assert.equal(view.animDelay(P), 0);
  assert.equal(view.animDelay(7 * P + 345), -345);
  assert.equal(view.animDelay(P - 1), -(P - 1));
  for (let t = 1_700_000_000_123; t < 1_700_000_000_123 + 5 * P; t += 97) {
    const d = view.animDelay(t);
    assert.ok(d <= 0 && d > -P, String(d));
    assert.equal((t + d) % P, 0, 'the animation phase at t is t mod P');
  }
});

test('animDelay: two redraws at different times keep the animation phase continuous', () => {
  const P = view.ANIM_MS;
  const t1 = 5 * P + 400;
  const t2 = t1 + 250; // a redraw 250 ms later restarts the animation, but its delay compensates
  assert.equal(view.animDelay(t2) - view.animDelay(t1), -250);
});

test('animDelay: defaults to the real clock', () => {
  const before = Date.now();
  const d = view.animDelay();
  assert.ok(d <= 0 && d > -view.ANIM_MS);
  assert.ok(Date.now() >= before);
});

// ---------- structural CSS ----------
const block = (src, open) => {
  const start = src.indexOf(open);
  assert.ok(start >= 0, `${open} exists`);
  let depth = 0;
  for (let i = src.indexOf('{', start); i < src.length; i++) {
    if (src[i] === '{') depth++;
    if (src[i] === '}' && --depth === 0) return src.slice(start, i + 1);
  }
  throw new Error(`${open} is not closed`);
};

test('style.css: the keyframes of the pulsing dot and the ellipsis exist', () => {
  assert.match(css, /@keyframes\s+pulse-dot\s*\{/);
  assert.match(css, /@keyframes\s+ell\s*\{/);
  assert.match(block(css, '.pulse-dot {'), /animation:[^;]*pulse-dot[^;]*infinite/);
  assert.match(block(css, '.ell {'), /animation:[^;]*\bell\b[^;]*infinite/);
});

test('style.css: reduced motion turns every animation off', () => {
  const media = block(css, '@media (prefers-reduced-motion: reduce)');
  for (const sel of ['.pulse-dot', '.ell']) assert.match(media, new RegExp(`${sel.replace('.', '\\.')}[^{]*\\{[^}]*animation:\\s*none`), sel);
  assert.equal(/display:\s*none|visibility:\s*hidden/.test(media), false, 'the text stays');
});

test('style.css: every class of the animated markup has a rule', () => {
  for (const cls of ['.verdict-line', '.pulse-dot', '.ell', '.chip-verify', '.ask-line']) assert.ok(css.includes(`${cls} {`) || css.includes(`${cls},`) || css.includes(`${cls}.`), cls);
});

test('style.css: the asking line is static (no animation) and highlighted', () => {
  const rule = block(css, '.ask-line {');
  assert.equal(/animation/.test(rule), false);
  assert.match(rule, /background|border/);
});

// ---------- the page ----------
const stub = () => new Proxy(function stubElement() {}, {
  get: (t, k) => (k === 'content' ? 'token' : k === 'dataset' ? {} : k === 'classList' ? { add() {}, remove() {}, toggle() {} } : k === Symbol.toPrimitive ? () => '' : stub),
  set: () => true,
  apply: () => stub(),
});
function loadPage() {
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
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8'), ctx);
  return (name) => vm.runInContext(name, ctx);
}
const R = { id: 'abc', name: 'demo' };
const local = (o = {}) => ({ branch: 'task', detached: false, upstream: 'origin/task', noUpstream: false, ahead: 0, behind: 0, files: [], added: 0, deleted: 0, head: 'h1', inProgress: null, base: 'main', ...o });
const textOf = (html) => html.replace(/<[^>]*>/g, '');
const DELAY = /style="animation-delay:-?\d+ms"/;

test('page: the running line is a polite status with a pulsing dot, an animated ellipsis, a delay and the plain text intact', () => {
  const get = loadPage();
  const S = get('S');
  S.local[R.id] = local({ ahead: 1 });
  S.prs[R.id] = { prs: [], stale: null, repo: { url: 'https://github.com/o/demo' } };
  const labels = { 'flow-commit': 'committing…', 'flow-pr': 'creating pull request…', 'flow-base': 'updating base branch…', 'fix-pr': 'fixing pull request…', 'put-in-conditions': 'putting repo in conditions…' };
  for (const [cmd, label] of Object.entries(labels)) {
    const html = get('verdictRow')(R, { state: 'running', reason: 'The session is working', label, cmd });
    assert.match(html, /^<div class="verdict-line"[^>]* role="status"[^>]* aria-live="polite"/, html);
    assert.match(html, /<span class="pulse-dot" aria-hidden="true" style="animation-delay:-?\d+ms"><\/span>/);
    assert.match(html, /<span class="ell" style="animation-delay:-?\d+ms">…<\/span>/);
    assert.equal(textOf(html), label, 'no text is removed');
    assert.ok(html.includes('title="The session is working"'));
    assert.ok(DELAY.test(html));
  }
});

test('page: the pending checks chip says it is verifying, with the dot and the delay; the tooltip still lists the checks', () => {
  const html = loadPage()('checksChip')({ state: 'pending', total: 4, passed: 2, failed: 0, pending: 2, items: [{ name: 'lint', state: 'success' }, { name: 'test', state: 'pending' }] });
  assert.match(html, /^<span class="chip yellow chip-verify" title="✔ lint\n… test">/);
  assert.match(html, /<span class="pulse-dot" aria-hidden="true" style="animation-delay:-?\d+ms"><\/span>/);
  assert.equal(textOf(html), 'verifying checks · 2 running · 2/4');
});

test('page: the success, failed and none check chips keep their exact markup', () => {
  const chip = loadPage()('checksChip');
  const items = [{ name: 'lint', state: 'success' }, { name: 'test', state: 'failed' }, { name: 'e2e', state: 'pending' }];
  const tip = '✔ lint\n✘ test\n… e2e';
  assert.equal(chip({ state: 'none' }), '<span class="chip gray">no checks</span>');
  assert.equal(chip({ state: 'success', total: 3, passed: 3, failed: 0, pending: 0, items }), `<span class="chip green" title="${tip}">✔ 3/3 checks</span>`);
  assert.equal(chip({ state: 'failed', total: 3, passed: 1, failed: 1, pending: 1, items }), `<span class="chip red" title="${tip}">✘ 1 failed · 1/3</span>`);
});

test('page: the attention bar keeps its markup and gets no animation', () => {
  const get = loadPage();
  get('S').pitail[R.id] = '';
  const html = get('verdictRow')(R, { state: 'attention', reason: 'No new commit', cmd: 'flow-commit' });
  assert.equal(html, '<div class="attn-bar"><span>⚠ Needs attention: No new commit</span><button data-act="dismiss-sent" data-id="abc" title="Dismiss">✕</button></div>');
  assert.equal(get('verdictRow')(R, null), '');
});
