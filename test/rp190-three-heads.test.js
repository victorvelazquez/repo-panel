'use strict';
// RP190 (S5, S7): from 760 px the three headers (the repos list, the chat and the right column) are the same height (40 px, ONE variable) and the head of the chat is ONE row: the name, the tabs
// Chat and Notes (and the one of the open file) and, at the right, the panel icon and the close button. The head stays and only the body scrolls. Under 760 px nothing changes here: the phone
// keeps its two rows until RP196 and RP195. How it LOOKS is for the person to try; these tests pin the rules, the markup and the glyph.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const R = require('../public/resumen.js');

const PUBLIC = path.join(__dirname, '..', 'public');
const read = (f) => fs.readFileSync(path.join(PUBLIC, f), 'utf8').replace(/\r\n/g, '\n');
const css = read('style.css').replace(/\/\*[\s\S]*?\*\//g, ''); // without comments: a comment before a rule would stick to its selector
const html = read('index.html');

// The text of a block `@container sum (min-width: 760px) { ... }` (braces matched), and the body of a rule inside a text.
function block(src, head) {
  const at = src.indexOf(head);
  assert.ok(at >= 0, `a block ${head}`);
  let depth = 0;
  for (let i = src.indexOf('{', at); i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(src.indexOf('{', at) + 1, i);
  }
  throw new Error('unbalanced');
}
const ruleIn = (src, sel) => [...src.matchAll(/(?:^|\n|\})\s*([^{}@]+)\{([^}]*)\}/g)].filter((m) => m[1].split(',').some((s) => s.trim().replace(/\s+/g, ' ') === sel)).map((m) => m[2]).join(';');
const WIDE = '@container sum (min-width: 760px)';
const wide = css.includes(WIDE) ? block(css, WIDE) : ''; // a missing block makes each test fail on its own, not the whole file

test('h1: ONE variable says how tall a header is, 40 px, and the three headers use it', () => {
  assert.match(ruleIn(css, ':root'), /--head-h:\s*40px/);
  assert.match(ruleIn(css, '#listHead'), /height:\s*var\(--head-h\)/, 'the repos list');
  assert.match(ruleIn(wide, '.ch-head'), /height:\s*var\(--head-h\)/, 'the chat');
  assert.match(ruleIn(wide, '.col-tabs'), /height:\s*var\(--head-h\)/, 'the right column');
});

test('h2: the bar of the repos list fills its header (no number of its own that can drift from the variable)', () => {
  const bar = ruleIn(css, '.lh-bar');
  assert.match(bar, /height:\s*100%/);
  assert.doesNotMatch(bar, /min-height:\s*40px/);
});

test('h3: from 760 px the head of the chat is ONE row: the row is dissolved into the head, the tabs fill the middle and the icon and the close button go to the right', () => {
  assert.match(ruleIn(wide, '.ch-head'), /display:\s*flex/);
  assert.match(ruleIn(wide, '.ch-head'), /align-items:\s*center/);
  assert.match(ruleIn(wide, '.ch-row'), /display:\s*contents/);
  const tabs = ruleIn(wide, '.ch-tabs');
  assert.match(tabs, /order:\s*1/);
  assert.match(tabs, /flex:\s*1 1 auto/);
  assert.match(tabs, /min-width:\s*0/);
  assert.match(tabs, /flex-wrap:\s*nowrap/);
  assert.match(tabs, /align-self:\s*stretch/);
  assert.match(tabs, /align-items:\s*stretch/);
  assert.match(ruleIn(wide, '.ch-repo'), /order:\s*2/);
  assert.match(ruleIn(wide, '.ch-row .x'), /order:\s*2/);
});

test('h4: a tab of the chat is as tall as the head, so its blue line sits on the bottom edge like the tabs of the column', () => {
  assert.match(ruleIn(wide, '.ch-tab'), /padding:\s*0 12px/);
});

test('h5: the phone is untouched: the one-row rules live ONLY in the block from 760 px, and the global rules of the row and the tabs stay', () => {
  const outside = css.replace(wide, '');
  assert.doesNotMatch(outside, /\.ch-row\s*\{[^}]*display:\s*contents/);
  assert.doesNotMatch(outside, /\.col-tabs\s*\{[^}]*height:\s*var\(--head-h\)/);
  assert.match(ruleIn(css, '.ch-row'), /display:\s*flex/);
  assert.match(ruleIn(css, '.ch-row'), /padding:\s*10px 14px/);
  assert.match(ruleIn(css, '.ch-tabs'), /flex-wrap:\s*wrap/);
});

test('h6: the panel icon is a side panel (a frame with its right bar), the button keeps its name, its action and its place in the head', () => {
  const h = R.chatHead({ tab: 'chat' }, { name: 'demo', column: true, narrow: true, git: {} });
  const btn = /<button type="button" class="ch-repo"[^>]*>[\s\S]*?<\/button>/.exec(h)[0];
  assert.match(btn, /data-act="zone-set" data-zone="repo"/);
  assert.match(btn, /aria-label="Open the repo: tasks, changes, status and files"/);
  assert.match(btn, /<svg[^>]*aria-hidden="true"/);
  assert.match(btn, /<rect /, 'the frame');
  assert.match(btn, /M10 3v10/, 'the bar of the panel');
  assert.doesNotMatch(btn, /M3 4\.5h10M3 8h10M3 11\.5h6/, 'not the three lines of before');
  assert.ok(h.indexOf('class="ch-back"') < h.indexOf('class="ch-name"') && h.indexOf('class="ch-name"') < h.indexOf('class="ch-repo"') && h.indexOf('class="ch-repo"') < h.indexOf('data-act="chat-close"'), 'the same order in the markup');
});

test('h7: the markup of the head is the same two blocks (the row, then the tabs) and with the column in the chat has only Chat and Notes', () => {
  const h = R.chatHead({ tab: 'chat' }, { name: 'demo', column: true, git: {} });
  assert.ok(h.indexOf('<div class="ch-row">') === 0 && h.indexOf('<div class="ch-tabs"') > h.indexOf('</div>'));
  assert.deepEqual([...h.matchAll(/data-act="chat-tab" data-tab="(\w+)"/g)].map((m) => m[1]), ['chat', 'notes']);
});

test('h8: the head stays and only the body scrolls: the head and the body are siblings in the chat, the chat is a column and the body is the one that scrolls', () => {
  assert.match(html, /<aside id="chat"[^>]*>\s*<div id="chatHead" class="ch-head"><\/div>\s*<div id="chatBody" class="ch-body"/);
  assert.match(ruleIn(css, '#chat'), /flex-direction:\s*column/);
  assert.match(ruleIn(css, '#chat'), /min-height:\s*0/);
  const body = ruleIn(css, '.ch-body');
  assert.match(body, /overflow:\s*auto/);
  assert.match(body, /min-height:\s*0/);
});

test('h9: in the duo (760 to 1100 px) the arrow back is as tall as the head instead of the 44 px of the phone, so it does not stick out of the 40 px', () => {
  const back = ruleIn(wide, '#sumLayout[data-screen="duo"] .ch-back');
  assert.match(back, /min-height:\s*0/);
  assert.match(back, /align-self:\s*stretch/);
  assert.match(ruleIn(css, '#sumLayout[data-screen] .ch-back'), /min-height:\s*44px/, 'the phone keeps its 44 px');
});
