'use strict';
// RP124 (S10): the chat draws a Markdown table as a table. Until now `mdBlocks` had no case for it, so the lines with vertical bars fell into a paragraph glued with <br>.
// The rules: a header line, then a separator line with the SAME number of cells (`---`, `:---`, `---:`, `:---:`), then body lines that still have a bar; cells go through the same
// one-pass inline scan as everything else (so they are escaped and have no HTML), the alignment is a CLASS (no inline style), a wide table scrolls inside its own box, and what
// is not a table keeps drawing exactly as before. How it LOOKS is for the person to see in the real chat.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const R = require('../public/resumen.js');

const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'style.css'), 'utf8').replace(/\r\n/g, '\n');
const md = R.mdHtml;
const TABLE = ['| Option | Cost |', '| --- | --- |', '| **A** | `low` |', '| B | high |'].join('\n');

test('t1: a table becomes a boxed table with a head and a body, one cell per column, and the cells keep their inline Markdown', () => {
  const h = md(TABLE);
  assert.equal(h, '<div class="md-table"><table><thead><tr><th>Option</th><th>Cost</th></tr></thead><tbody><tr><td><strong>A</strong></td><td><code>low</code></td></tr><tr><td>B</td><td>high</td></tr></tbody></table></div>');
});

test('t2: the alignment of the separator row is a class on each cell of the column (no inline style)', () => {
  const h = md(['| L | C | R | N |', '|:---|:---:|---:|---|', '| a | b | c | d |'].join('\n'));
  assert.match(h, /<th>L<\/th><th class="al-c">C<\/th><th class="al-r">R<\/th><th>N<\/th>/);
  assert.match(h, /<td>a<\/td><td class="al-c">b<\/td><td class="al-r">c<\/td><td>d<\/td>/);
  assert.doesNotMatch(h, /style=/);
});

test('t3: the outer bars are optional, a row with more cells is cut to the width of the head and a row with fewer is padded', () => {
  const cut = md(['a | b', '--- | ---', 'x | y | z', 'p | q'].join('\n'));
  assert.equal(cut, '<div class="md-table"><table><thead><tr><th>a</th><th>b</th></tr></thead><tbody><tr><td>x</td><td>y</td></tr><tr><td>p</td><td>q</td></tr></tbody></table></div>');
  const padded = md(['| a | b | c |', '| - | - | - |', '| 1 | 2 |'].join('\n'));
  assert.match(padded, /<td>1<\/td><td>2<\/td><td><\/td>/, 'padded with an empty cell');
});

test('t4: an escaped bar stays in the cell and an empty cell stays empty', () => {
  const h = md(['| a | b |', '| --- | --- |', '| x \\| y | |'].join('\n'));
  assert.match(h, /<td>x \| y<\/td><td><\/td>/);
});

test('t5: the table ends at a blank line or at a line without a bar, and the text around it is still drawn; it can interrupt a paragraph', () => {
  const h = md(['Before the table', TABLE, '', 'After it'].join('\n'));
  assert.match(h, /^<p>Before the table<\/p><div class="md-table">/);
  assert.match(h, /<\/table><\/div><p>After it<\/p>$/);
  const ends = md(['| a | b |', '| - | - |', '| 1 | 2 |', 'plain line', 'more'].join('\n'));
  assert.match(ends, /<\/table><\/div><p>plain line<br>more<\/p>$/);
});

test('t6: a table in a quote and a table next to a list work, and a table inside a code fence stays code', () => {
  const quote = md(['> | a | b |', '> | - | - |', '> | 1 | 2 |'].join('\n'));
  assert.match(quote, /^<blockquote><div class="md-table">/);
  const fenced = md(['```', TABLE, '```'].join('\n'));
  assert.equal(fenced.startsWith('<pre><code>'), true);
  assert.doesNotMatch(fenced, /md-table/);
  const list = md(['- one', '- two', '', TABLE].join('\n'));
  assert.match(list, /^<ul><li>one<\/li><li>two<\/li><\/ul><div class="md-table">/);
});

test('t7: what is not a table draws exactly as before: bars without a separator row, a separator with another number of cells, a lone dashed line', () => {
  for (const text of ['| a | b |\n| c | d |', 'a | b\n---', '| a | b |\n| --- |', 'just a | pipe', '| --- | --- |', 'x\n|---|---|\ny']) {
    const h = md(text);
    assert.doesNotMatch(h, /<table|md-table/, JSON.stringify(text));
  }
  assert.equal(md('| a | b |\n| c | d |'), '<p>| a | b |<br>| c | d |</p>', 'the same paragraph with <br> as before');
});

test('t8: nothing from the agent becomes HTML: cells and the head are escaped, a javascript link is not a link, and only the tags this renderer builds appear', () => {
  const bad = '<img src=x onerror=alert(1)>';
  const h = md([`| ${bad} | <script>alert(1)</script> |`, '| --- | --- |', `| [x](javascript:alert(1)) | ${bad} \`${bad}\` |`].join('\n'));
  assert.doesNotMatch(h, /<img|<script/);
  assert.match(h, /&lt;img/);
  assert.doesNotMatch(h, /href="javascript/);
  const tags = new Set((h.match(/<\/?([a-z0-9]+)/g) || []).map((t) => t.replace(/[</]/g, '')));
  for (const t of tags) assert.ok(['div', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'code', 'strong', 'em', 'a'].includes(t), t);
  // Every `<` in the output is a real tag (the agent's own are escaped), so an event handler or a style attribute would show up INSIDE a tag; the escaped text may still say «onerror=».
  assert.doesNotMatch(h, /<[^>]*\son\w+=/i);
  assert.doesNotMatch(h, /<[^>]*\sstyle=/i);
});

test('t9: a link in a cell keeps the safe link rules of the rest of the chat', () => {
  const h = md(['| a |', '| - |', '| [site](https://example.com/p?q=1) |'].join('\n'));
  assert.match(h, /<td><a href="https:\/\/example\.com\/p\?q=1" target="_blank" rel="noopener noreferrer">site<\/a><\/td>/);
});

test('t10: it is bounded: a head with a hundred thousand cells, thousands of rows and long runs of bars finish at once and keep a cap on columns', () => {
  const t0 = Date.now();
  const wide = md(`${'| a '.repeat(1e5)}|\n${'| - '.repeat(1e5)}|\n${'| x '.repeat(1e5)}|`);
  assert.ok((wide.match(/<th/g) || []).length <= 40, 'the columns are capped');
  const tall = md(['| a | b |', '| - | - |', ...Array.from({ length: 5000 }, (_, i) => `| ${i} | v |`)].join('\n'));
  assert.ok((tall.match(/<tr>/g) || []).length <= 301, 'the rows are capped');
  md(`|${'|'.repeat(1e5)}\n|${'-|'.repeat(5e4)}`);
  md(`${'| a | b |\n'.repeat(5e3)}`);
  assert.ok(Date.now() - t0 < 2000, `took ${Date.now() - t0} ms`);
});

test('t11: the rest of the Markdown does not change: headings, lists, quotes, fences, emphasis and links give the same HTML as the old renderer', () => {
  const sample = ['# Title', '', 'Some **bold** and _it_ and `code`', 'second line', '', '- a', '- b', '', '1. x', '2. y', '', '> quoted', '', '```', 'raw <b>', '```', '', '[l](https://e.com)'].join('\n');
  assert.equal(md(sample), '<h3>Title</h3><p>Some <strong>bold</strong> and <em>it</em> and <code>code</code><br>second line</p><ul><li>a</li><li>b</li></ul><ol><li>x</li><li>y</li></ol><blockquote><p>quoted</p></blockquote><pre><code>raw &lt;b&gt;</code></pre><p><a href="https://e.com" target="_blank" rel="noopener noreferrer">l</a></p>');
  assert.equal(md(null), '');
  assert.equal(md('a\r\nb'), '<p>a<br>b</p>');
});

test('t12: the styles: the box scrolls on its own, the table has thin rows with a muted head and no background of its own, and the aligned cells have their class', () => {
  assert.match(css, /\.md-table\s*\{[^}]*overflow-x:\s*auto/);
  assert.match(css, /\.md-table table\s*\{[^}]*border-collapse:\s*collapse/);
  assert.match(css, /\.md-table th\s*\{[^}]*color:\s*var\(--muted\)/);
  assert.doesNotMatch((/\.md-table (?:th|td)[^{]*\{[^}]*\}/.exec(css) || [''])[0], /background/);
  assert.match(css, /\.md-table \.al-c\s*\{[^}]*text-align:\s*center/);
  assert.match(css, /\.md-table \.al-r\s*\{[^}]*text-align:\s*right/);
});
