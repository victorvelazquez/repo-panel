'use strict';
// RP132 (S25): the right column of the Summary uses ALL the height of the window and scrolls as a whole. Two faults, found by looking at the real panel: (1) the tree of the Files tab kept the
// `max-height: 40vh` it had when it lived in the chat (the file below it), so in the column it stopped at 40% of the window with a scrollbar of its own and left the rest of the pane empty;
// (2) `#colBody` is a flex item of `#col` and SHRANK to the visible height while its content kept growing (flex-shrink 1 with `min-height: 100%`), so the sticky tab bar, whose box is `#colBody`, stopped
// sticking as soon as a list was longer than the window (Changes with many files too). The fix is two rules; the chat's own Files tab under 1100 px keeps its cap. Plain CSS cannot be run here: how it LOOKS
// was measured in the real panel at six window sizes and is for the person to try; these tests pin the rules so that neither fault comes back.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'style.css'), 'utf8').replace(/\r\n/g, '\n');
// The declarations of the TOP-LEVEL rules whose selector is exactly `sel` (the ones inside @media and @container are indented, so they never match).
function decls(sel) {
  const esc = sel.replace(/[.*+?^${}()|[\]\\#]/g, '\\$&');
  return [...css.matchAll(new RegExp(`(?:^|\\n)${esc} \\{([^}]*)\\}`, 'g'))].map((m) => m[1]);
}

test('c1: #colBody keeps the height of its content (it does not shrink to the visible height), still fills the column when the content is short, and is the box the sticky bars live in', () => {
  const d = decls('#colBody');
  assert.equal(d.length, 1, 'one rule');
  assert.match(d[0], /flex:\s*none/, 'a flex item of #col that must not shrink: its sticky children need its whole height');
  assert.match(d[0], /min-height:\s*100%/, 'a short list still pushes the footer to the bottom');
  assert.match(d[0], /flex-direction:\s*column/);
  assert.doesNotMatch(d[0], /overflow/, 'the column scrolls as a whole, #colBody does not scroll by itself');
});

test('c2: in the column the tree of the Files tab has no cap and no scrollbar of its own: it takes its natural height and the column scrolls', () => {
  const d = decls('#colBody .ft-tree');
  assert.equal(d.length, 1, 'one rule');
  assert.match(d[0], /max-height:\s*none/);
  assert.match(d[0], /overflow:\s*visible/);
  assert.match(d[0], /flex:\s*none/);
});

test('c3: the chat keeps its own Files tab under 1100 px exactly as before: the tree has its cap and scrolls by itself because the file is below it', () => {
  const d = decls('.ft-tree');
  assert.equal(d.length, 1, 'one base rule');
  assert.match(d[0], /max-height:\s*40vh/);
  assert.match(d[0], /overflow:\s*auto/);
  assert.match(d[0], /flex:\s*none/);
});

test('c4: the bars stay: the tab bar sticks to the top of the column, the footer to the bottom, both over the content and with a background of their own', () => {
  const tabs = decls('.col-tabs');
  assert.equal(tabs.length, 1);
  assert.match(tabs[0], /position:\s*sticky/);
  assert.match(tabs[0], /top:\s*0/);
  assert.match(tabs[0], /z-index:\s*\d+/);
  assert.match(tabs[0], /background:\s*var\(--bg\)/);
  const foot = decls('.col-foot');
  assert.equal(foot.length, 1);
  assert.match(foot[0], /position:\s*sticky/);
  assert.match(foot[0], /bottom:\s*0/);
  assert.match(foot[0], /z-index:\s*\d+/);
  assert.match(foot[0], /background:\s*var\(--bg\)/);
});

test('c5: the column is the scroll container of both bars (#col scrolls, #colBody does not) and the pane takes the room that is left', () => {
  const col = decls('#col');
  assert.equal(col.length, 1);
  assert.match(col[0], /overflow:\s*auto/);
  assert.match(col[0], /min-height:\s*0/);
  const pane = decls('.col-pane');
  assert.equal(pane.length, 1);
  assert.match(pane[0], /flex:\s*1/);
});

test('c6: nothing else in the stylesheet lets #colBody shrink again or caps a tree of the column', () => {
  const lines = css.split('\n').filter((l) => /#colBody/.test(l));
  for (const l of lines) {
    assert.doesNotMatch(l, /flex-shrink:\s*[1-9]/, l);
    assert.doesNotMatch(l, /flex:\s*[01] 1/, l);
    assert.doesNotMatch(l, /max-height:\s*\d/, l);
  }
});
