'use strict';
// RP67 (S59): soft action palette by effect, calm chrome, and the "Fix with pi" -> "Fix CI" rename.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const resumen = require('../public/resumen.js');

const read = (f) => fs.readFileSync(path.join(__dirname, '..', 'public', f), 'utf8').replace(/\r\n/g, '\n');
const css = read('style.css');
const rules = [...css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}@]+)\{([^{}]*)\}/g)].map((m) => ({ sel: m[1].trim(), body: m[2] }));
const items = (sel) => sel.split(/,(?![^(]*\))/).map((s) => s.trim());
// Every rule that lists `item` as one of its selectors (also inside :is()).
const rulesWith = (item) => rules.filter((r) => items(r.sel).some((s) => s === item || s.includes(item)));
const hueOf = (item) => {
  const m = rulesWith(item).filter((r) => !/:disabled/.test(r.sel)).map((r) => /--h:\s*var\(--(\w+)\)/.exec(r.body)).filter(Boolean).pop();
  return m && m[1];
};
const ROOT = { panel: '#171b21', blue: '#58a6ff', yellow: '#d29922', green: '#3fb950', purple: '#a371f7', orange: '#db6d28' };

// ---------- contrast, no browser ----------
const rgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
const mix = (a, pct, b) => rgb(a).map((v, i) => v * (pct / 100) + rgb(b)[i] * (1 - pct / 100));
const lum = (c) => { const [r, g, b] = c.map((v) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
const ratio = (x, y) => { const [hi, lo] = [lum(x), lum(y)].sort((p, q) => q - p); return (hi + 0.05) / (lo + 0.05); };

test('contrast: every soft and urgent button text keeps WCAG AA (>= 4.5) in every hue and state', () => {
  const states = { soft: [13, 24, 68], urgent: [20, 30, 62] };
  for (const hue of ['blue', 'yellow', 'green', 'purple', 'orange']) {
    for (const [name, [rest, hover, text]] of Object.entries(states)) {
      const fg = mix(ROOT[hue], text, '#ffffff');
      for (const [state, bg] of [['rest', rest], ['hover', hover]]) {
        const r = ratio(fg, mix(ROOT[hue], bg, ROOT.panel));
        assert.ok(r >= 4.5, `${hue} ${name} ${state}: ${r.toFixed(2)}`);
      }
    }
  }
});

test('css: the soft and urgent numbers are the approved mockup ones', () => {
  assert.match(css, /background:\s*color-mix\(in srgb, var\(--h\) 13%, var\(--panel\)\)/);
  assert.match(css, /border-color:\s*color-mix\(in srgb, var\(--h\) 42%, var\(--panel\)\)/);
  assert.match(css, /color:\s*color-mix\(in srgb, var\(--h\) 68%, #fff\)/);
  assert.match(css, /background:\s*color-mix\(in srgb, var\(--h\) 24%, var\(--panel\)\)/);
  assert.match(css, /border-color:\s*color-mix\(in srgb, var\(--h\) 68%, var\(--panel\)\)/);
  assert.match(css, /background:\s*color-mix\(in srgb, var\(--h\) 20%, var\(--panel\)\)/);
  assert.match(css, /border-color:\s*color-mix\(in srgb, var\(--h\) 62%, var\(--panel\)\)/);
  assert.match(css, /color:\s*color-mix\(in srgb, var\(--h\) 62%, #fff\)/);
  assert.match(css, /background:\s*color-mix\(in srgb, var\(--h\) 30%, var\(--panel\)\)/);
  assert.match(css, /font-weight:\s*600/);
});

// ---------- the hue by effect ----------
test('css: one hue per effect, through the --h variable', () => {
  const want = {
    '[data-cmd="flow-next"]': 'blue', 'header .primary': 'blue',
    '[data-cmd="flow-commit"]': 'yellow', '[data-cmd="flow-commit-unstage"]': 'yellow', '[data-kind="answer"]': 'yellow', '[data-kind="waiting"]': 'yellow',
    '[data-cmd="flow-pr"]': 'green', '.merge': 'green',
    '[data-cmd="flow-base"]': 'purple', '[data-cmd="flow-base-stash"]': 'purple',
    '[data-cmd="fix-pr"]': 'orange',
  };
  for (const [item, hue] of Object.entries(want)) assert.equal(hueOf(item), hue, item);
});

test('css: no action button keeps a solid fill; button.primary is solid only inside a dialog', () => {
  assert.equal(rules.find((r) => items(r.sel).includes('button.primary')), undefined, 'the global solid rule is gone');
  const solid = rules.filter((r) => /#1f6feb|background:\s*#238636/.test(r.body) && !/:disabled/.test(r.sel));
  // Only the dialog confirm buttons are solid; Merge has no fill of its own any more, the soft layer is the only one.
  assert.deepEqual(solid.map((r) => r.sel), ['dialog button.primary']);
  assert.match(rules.find((r) => r.sel === 'dialog button.primary').body, /background:\s*#1f6feb/);
  assert.equal(rules.find((r) => r.sel === 'button.merge'), undefined, 'no legacy solid rule for button.merge');
  assert.ok(rules.some((r) => /\.merge/.test(r.sel) && /background:\s*color-mix/.test(r.body)), 'a soft rule for .merge exists');
});

test('css: disabled soft buttons turn neutral gray, dimmed, not-allowed, after every soft rule', () => {
  const idx = rules.findIndex((r) => /:disabled/.test(r.sel) && /--h:\s*var\(--gray\)/.test(r.body));
  assert.ok(idx > 0, 'a disabled rule that resets the hue');
  const d = rules[idx].body;
  assert.match(d, /opacity:\s*\.45/);
  assert.match(d, /cursor:\s*not-allowed/);
  assert.match(d, /background:\s*var\(--panel2\)/);
  const lastSoft = rules.map((r, i) => (/--h\)/.test(r.body) && !/:disabled/.test(r.sel) ? i : -1)).reduce((a, b) => Math.max(a, b));
  assert.ok(idx > lastSoft, 'after the last soft rule');
});

test('css: soft buttons do not stretch inside cards', () => {
  assert.ok(rules.some((r) => /justify-self:\s*start/.test(r.body) && /align-self:\s*flex-start/.test(r.body) && /\.card/.test(r.sel)));
});

// ---------- calm chrome ----------
test('css: chips lose border and background except the clickable one; borders get calmer; the column bar is 2px', () => {
  const chip = rules.filter((r) => items(r.sel).includes('.chip:not(.chip-btn)') || items(r.sel).includes('.chip.green:not(.chip-btn)')).map((r) => r.body).join(';');
  assert.match(chip, /border-color:\s*transparent/);
  assert.match(chip, /background:\s*transparent/);
  assert.match(chip, /padding:\s*0 2px/);
  assert.match(rules.find((r) => r.sel === '.chip.chip-btn').body, /border-color:\s*var\(--line\)/);
  assert.match(rules.find((r) => r.sel === '.chip.chip-btn:hover').body, /border-color:\s*var\(--muted\)/);
  assert.match(rules.find((r) => r.sel === '.col').body, /border:\s*1px solid #222a33;\s*border-top:\s*2px solid var\(--gray\)/);
  assert.match(rules.find((r) => r.sel === '.card').body, /border:\s*1px solid #222a33/);
  assert.match(rules.find((r) => r.sel === '.rs-card').body, /border:\s*1px solid #222a33/);
  assert.match(css, /\.card\.attn \{ border-color: #7a2a27/, 'the attention card keeps its red border');
  assert.match(css, /\.rs-card\.ask \{ border-left: 3px solid var\(--yellow\)/);
});

test('css: the mapping is documented in a comment block', () => {
  assert.match(css, /\/\*[^*]*RP67: soft action palette[\s\S]*?blue[\s\S]*?amber[\s\S]*?green[\s\S]*?violet[\s\S]*?orange[\s\S]*?\*\//);
});

// ---------- rename ----------
test('the Fix CI label replaces "Fix with pi" and keeps the data attributes', () => {
  const app = read('app.js');
  assert.match(app, /piBtn\(r, 'fix-pr', 'Fix CI', \{ pr: pr\.number, title: hold \|\| FIX_PR_HINT, disabled: !!hold \}\)/);
  for (const f of ['app.js', 'view.js']) assert.doesNotMatch(read(f), /Fix with pi/, f);
  assert.match(read('../README.md'), /Fix CI/);
  assert.equal(read('../README.md').split('Fix with pi').length - 1, 1, 'only the "formerly" mention is left');
  assert.match(read('../README.md'), /formerly `Fix with pi`/);
});

// ---------- Summary: urgent Open buttons carry their kind ----------
const row = (action, extra = {}) => ({
  id: 'r1', name: 'alpha', group: 'G1', room: null, branch: 'main', session: { state: 'free' }, next: null, blocking: [],
  progress: { total: 10, completada: 3, enRevision: 0, bloqueada: 0, pendiente: 7, enCurso: 0 },
  lastMovement: { at: '2026-05-01T11:48:00Z', what: 'x' }, action, error: null, needs: false, rank: 9, ...extra,
});
const cardOf = (r) => resumen.summaryView({ rows: [r], counts: {}, attention: [], generatedAt: '2026-05-01T12:00:00Z' }, { now: Date.parse('2026-05-01T12:00:00Z'), scope: { kind: 'all' }, rooms: [] });
test('summary: only the answer and waiting Open buttons carry data-kind', () => {
    for (const kind of ['answer', 'waiting']) assert.match(cardOf(row({ kind, label: 'L', pr: null })), new RegExp(`<button class="primary" data-act="focus-repo" data-id="r1" data-kind="${kind}"`), kind);
  for (const kind of ['manual']) assert.doesNotMatch(cardOf(row({ kind, label: 'L', pr: null })), /data-kind/, kind);
  assert.doesNotMatch(cardOf(row(null, { error: 'boom' })), /data-kind/);
});
