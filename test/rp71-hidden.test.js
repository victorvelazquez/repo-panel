'use strict';
// RP71 (S65): the `hidden` attribute of a block the page hides with JavaScript must really hide it. An author rule such as
// `.chatlayout { display: flex }` beats the browser's default `[hidden] { display: none }`, so every element of index.html that
// starts hidden (or that the page toggles) and that a rule gives a `display` needs its own `[hidden]` rule. The fake DOM of the
// other tests cannot see this: it has no CSS, so these tests read the two files.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const PUBLIC = path.join(__dirname, '..', 'public');
const css = fs.readFileSync(path.join(PUBLIC, 'style.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const html = fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8');
const app = fs.readFileSync(path.join(PUBLIC, 'app.js'), 'utf8');

// Every rule outside @media blocks: { selectors: [..], body }.
function rules(source) {
  const out = [];
  const flat = source.replace(/@media[^{]*\{([\s\S]*?\})\s*\}/g, '');
  for (const m of flat.matchAll(/([^{}]+)\{([^{}]*)\}/g)) out.push({ selectors: m[1].split(',').map((s) => s.trim()), body: m[2] });
  return out;
}
const ALL = rules(css);
const displayOf = (body) => { const m = /(?:^|;)\s*display\s*:\s*([^;]+)/.exec(body); return m ? m[1].trim() : null; };

// Elements of index.html that carry the hidden attribute: [{ id, classes }].
const hiddenInHtml = [...html.matchAll(/<(\w+)([^>]*)\shidden(?=[\s>=])([^>]*)>/g)].map((m) => {
  const attrs = `${m[2]} ${m[3]}`;
  return { tag: m[1], id: (/\sid="([^"]+)"/.exec(` ${attrs}`) || [])[1] || null, classes: ((/\sclass="([^"]+)"/.exec(` ${attrs}`) || [])[1] || '').split(/\s+/).filter(Boolean) };
});
// Elements the page toggles with .hidden = ... on a static node, by id: $('#id').hidden = ...
const toggledIds = [...app.matchAll(/\$\('#([A-Za-z][\w-]*)'\)\.hidden\s*=/g)].map((m) => m[1]);

const hasHiddenRule = (id, classes) => ALL.some((r) => r.selectors.some((s) => /\[hidden\]/.test(s) && (new RegExp(`#${id}\\b`).test(s) || classes.some((c) => new RegExp(`\\.${c}\\b`).test(s)))) && displayOf(r.body) === 'none');
const givesDisplay = (id, classes) => ALL.some((r) => r.selectors.some((s) => !/\[hidden\]/.test(s) && /^[#.][\w-]+$/.test(s) && (s === `#${id}` || classes.some((c) => s === `.${c}`))) && displayOf(r.body) && displayOf(r.body) !== 'none');

test('the wrapper of the Summary and the chat is really hidden when the page hides it', () => {
  assert.ok(hasHiddenRule('sumLayout', ['chatlayout']), '#sumLayout / .chatlayout needs a [hidden] rule with display: none');
});

test('guard: no element that starts hidden or is toggled by id keeps a display rule without its [hidden] rule', () => {
  const byId = new Map(hiddenInHtml.filter((e) => e.id).map((e) => [e.id, e]));
  for (const id of toggledIds) {
    const m = new RegExp(`<\\w+[^>]*\\sid="${id}"([^>]*)>`).exec(html);
    if (m && !byId.has(id)) byId.set(id, { id, classes: ((/\sclass="([^"]+)"/.exec(` ${m[0]}`) || [])[1] || '').split(/\s+/).filter(Boolean) });
  }
  const broken = [...byId.values()].filter((e) => givesDisplay(e.id, e.classes) && !hasHiddenRule(e.id, e.classes)).map((e) => `#${e.id}`);
  assert.deepEqual(broken, []);
});

test('the guard itself sees the elements it must protect', () => {
  const ids = hiddenInHtml.map((e) => e.id);
  for (const id of ['chat', 'split']) assert.ok(ids.includes(id), `#${id} starts hidden in index.html`);
  assert.ok(toggledIds.includes('sumLayout'), 'the page toggles #sumLayout.hidden');
});
