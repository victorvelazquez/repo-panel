'use strict';
// RP269: a .md file opened in the file viewer shows rendered by default (with the chat's escaped Markdown renderer), and a «Rendered / Source»
// switch shows the original text with its changed lines marked. The choice is a page preference (ctx.mdSource); other files never get the switch.
const test = require('node:test');
const assert = require('node:assert/strict');
const R = require('../public/resumen.js');

const MD = '# Roadmap\n\n| ID | State |\n| --- | --- |\n| RP1 | Done |\n\n<script>alert(1)</script>\n';
const file = (path, text, changed = []) => ({ path, text, changed });

test('a .md file shows rendered by default, with the switch on Rendered', () => {
  const html = R.fileView(file('docs/ROADMAP.md', MD), { selected: 'docs/ROADMAP.md' });
  assert.match(html, /<table>/);
  assert.match(html, /<td>RP1<\/td>/);
  assert.match(html, /data-act="md-source"/);
  assert.match(html, /aria-pressed="false"[^>]*>Source</);
  assert.doesNotMatch(html, /class="cv-code"/);
});

test('the rendered view escapes the HTML inside the file', () => {
  const html = R.fileView(file('a.md', MD), { selected: 'a.md' });
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /&lt;script&gt;/);
});

test('with mdSource the file shows its original text with the changed lines marked', () => {
  const html = R.fileView(file('README.MD', MD, [[3, 1]]), { selected: 'README.MD', mdSource: true });
  assert.doesNotMatch(html, /<table>/);
  assert.match(html, /class="cv-code"/);
  assert.match(html, /<div class="cv-l e"><span class="cv-n">3<\/span>/);
  assert.match(html, /aria-pressed="true"[^>]*>Source</);
});

test('a file that is not Markdown has no switch and still shows its lines', () => {
  const html = R.fileView(file('src/a.js', 'const a = 1;\n'), { selected: 'src/a.js' });
  assert.doesNotMatch(html, /md-source/);
  assert.match(html, /class="cv-code"/);
});
