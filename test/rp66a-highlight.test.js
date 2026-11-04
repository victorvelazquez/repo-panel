'use strict';
// RP66a (S2, S3, S5): the syntax highlighter is a pure module (public/highlight.js, plain <script> global RepoPanelHighlight, CommonJS in tests, like resumen.js). languageOf(path) says the
// language of a file by its extension; highlightLines(lines, lang) returns the HTML of each line with <span class="hl-x"> around tokens, or null when there is no language or the file is too
// long. The safety rule (S5) is the one that matters: the content of a file is data, so what comes out, once the spans the highlighter itself adds are taken away, is exactly the escaped input.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { execFileSync } = require('node:child_process');

const H = require('../public/highlight.js');
const ROOT = path.join(__dirname, '..');
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const strip = (h) => h.replace(/<span class="hl-[a-z]">/g, '').replace(/<\/span>/g, '');
const one = (line, lang) => H.highlightLines([line], lang)[0];
const LANGS = ['js', 'json', 'css', 'html', 'md', 'sh'];

test('the module exports languageOf, highlightLines and the limit of 2000 lines', () => {
  assert.equal(typeof H.languageOf, 'function');
  assert.equal(typeof H.highlightLines, 'function');
  assert.equal(H.MAX_LINES, 2000);
});

test('languageOf looks at the extension, ignores the case and the folders, and says null for the rest', () => {
  const table = { 'a/b.js': 'js', 'x.mjs': 'js', 'y.cjs': 'js', 'z.jsx': 'js', 'a.ts': 'js', 'b.tsx': 'js', 'package.json': 'json', 'a/b.css': 'css', 'i.html': 'html', 'i.htm': 'html',
    'README.md': 'md', 'n.markdown': 'md', 'run.sh': 'sh', 'r.bash': 'sh', 'UP.JS': 'js', 'a\\b\\c.css': 'css', 'dir.js/readme.md': 'md' };
  for (const [p, lang] of Object.entries(table)) assert.equal(H.languageOf(p), lang, p);
  for (const p of ['Makefile', 'README', '.gitignore', 'a.txt', 'a.b/c', 'image.png', 'archive.tar.gz', '', 'js']) assert.equal(H.languageOf(p), null, JSON.stringify(p));
  for (const bad of [undefined, null, 5, {}, []]) assert.equal(H.languageOf(bad), null);
});

test('highlightLines says null for no language, for a bad input and for more than 2000 lines, and an array otherwise', () => {
  assert.equal(H.highlightLines(['x'], null), null);
  assert.equal(H.highlightLines(['x'], 'cobol'), null);
  assert.equal(H.highlightLines('x', 'js'), null);
  assert.equal(H.highlightLines(null, 'js'), null);
  assert.deepEqual(H.highlightLines([], 'js'), []);
  assert.equal(H.highlightLines(new Array(H.MAX_LINES).fill('x'), 'js').length, H.MAX_LINES);
  assert.equal(H.highlightLines(new Array(H.MAX_LINES + 1).fill('x'), 'js'), null);
});

test('js: keywords, numbers, strings and comments; a keyword inside a string or a name is not a keyword', () => {
  const h = one('const x = 42; // note', 'js');
  assert.ok(h.includes('<span class="hl-k">const</span>'), h);
  assert.ok(h.includes('<span class="hl-n">42</span>'), h);
  assert.ok(h.includes('<span class="hl-c">// note</span>'), h);
  assert.equal((one("a = 'x' + \"y\"", 'js').match(/class="hl-s"/g) || []).length, 2);
  assert.doesNotMatch(one('x = "const if return"', 'js'), /hl-k/);
  assert.doesNotMatch(one('constant = iffy + returned', 'js'), /hl-k/);
  assert.ok(one("s = 'it\\'s'", 'js').includes('<span class="hl-s">&#39;it\\&#39;s&#39;</span>'), 'an escaped quote does not end the string');
  assert.ok(one("s = 'open", 'js').includes('<span class="hl-s">&#39;open</span>'), 'an unterminated string goes to the end of the line');
});

test('js: a block comment and a template literal keep their state from one line to the next, and the state does not leak between calls', () => {
  const c = H.highlightLines(['x /* start', 'middle', 'end */ y'], 'js');
  assert.ok(c[0].includes('<span class="hl-c">/* start</span>'), c[0]);
  assert.equal(c[1], '<span class="hl-c">middle</span>');
  assert.ok(c[2].startsWith('<span class="hl-c">end */</span>') && c[2].endsWith(' y'), c[2]);
  const t = H.highlightLines(['a = `one', 'two', 'three`; b'], 'js');
  assert.ok(t[0].includes('<span class="hl-s">`one</span>') && t[1] === '<span class="hl-s">two</span>' && t[2].startsWith('<span class="hl-s">three`</span>'), t.join(' | '));
  H.highlightLines(['/* never closed', '`never closed'], 'js');
  assert.doesNotMatch(H.highlightLines(['plain const'], 'js')[0], /hl-c|hl-s/);
});

test('json: keys, strings, numbers and the three literals', () => {
  const h = one('{"name": "x", "n": -1.5e3, "ok": true, "z": null}', 'json');
  assert.ok(h.includes('<span class="hl-p">&quot;name&quot;</span>'), h);
  assert.ok(h.includes('<span class="hl-s">&quot;x&quot;</span>'), h);
  assert.ok(h.includes('<span class="hl-n">-1.5e3</span>'), h);
  assert.ok(h.includes('<span class="hl-k">true</span>') && h.includes('<span class="hl-k">null</span>'), h);
});

test('css: comments across lines, at-rules, properties only inside braces, numbers and hex colors', () => {
  assert.ok(one('@media (max-width: 600px) {', 'css').includes('<span class="hl-k">@media</span>'));
  const h = one('a { color: #fff; margin: 10px 0; }', 'css');
  assert.ok(h.includes('<span class="hl-p">color</span>') && h.includes('<span class="hl-n">#fff</span>') && h.includes('<span class="hl-n">10px</span>'), h);
  const sel = one('a:hover { color: red; }', 'css');
  assert.doesNotMatch(sel, /<span class="hl-p">hover/, 'a pseudo-class in a selector is not a property');
  assert.ok(sel.includes('<span class="hl-p">color</span>'), sel);
  const c = H.highlightLines(['/* one', 'two */ a {}'], 'css');
  assert.equal(c[0], '<span class="hl-c">/* one</span>');
  assert.ok(c[1].startsWith('<span class="hl-c">two */</span>'), c[1]);
});

test('html: tags, attributes, strings and comments across lines', () => {
  const h = one('<div class="a" id=b>text</div>', 'html');
  assert.ok(h.includes('<span class="hl-t">&lt;div</span>'), h);
  assert.ok(h.includes('<span class="hl-a">class</span>') && h.includes('<span class="hl-a">id</span>'), h);
  assert.ok(h.includes('<span class="hl-s">&quot;a&quot;</span>'), h);
  assert.ok(h.includes('<span class="hl-t">&lt;/div</span>'), h);
  const c = H.highlightLines(['<!-- one', 'two --> <p>'], 'html');
  assert.equal(c[0], '<span class="hl-c">&lt;!-- one</span>');
  assert.ok(c[1].startsWith('<span class="hl-c">two --&gt;</span>') && c[1].includes('<span class="hl-t">&lt;p</span>'), c[1]);
});

test('md: headings, list markers, inline code and fenced blocks', () => {
  assert.equal(one('# Title', 'md'), '<span class="hl-h"># Title</span>');
  assert.ok(one('- item', 'md').startsWith('<span class="hl-k">-</span> item'));
  assert.ok(one('use `npm test` now', 'md').includes('<span class="hl-s">`npm test`</span>'));
  const f = H.highlightLines(['```js', 'const x = 1', '```', 'after'], 'md');
  assert.ok(f[0].includes('hl-s') && f[1].includes('hl-s') && f[2].includes('hl-s'), f.join(' | '));
  assert.doesNotMatch(f[3], /hl-s/);
});

test('sh: comments only after whitespace, strings, variables and the control words', () => {
  const h = one('echo "hi $USER" # done', 'sh');
  assert.ok(h.includes('<span class="hl-k">echo</span>') && h.includes('<span class="hl-s">&quot;hi $USER&quot;</span>') && h.includes('<span class="hl-c"># done</span>'), h);
  assert.ok(one('if [ -f "$x" ]; then', 'sh').includes('<span class="hl-k">if</span>') && one('if [ -f "$x" ]; then', 'sh').includes('<span class="hl-k">then</span>'));
  assert.ok(one('cd $HOME', 'sh').includes('<span class="hl-v">$HOME</span>'));
  assert.doesNotMatch(one('x=${y#z}', 'sh'), /hl-c/, 'a # inside ${} is not a comment');
});

test('S5: whatever the content, without the spans the highlighter adds the output is exactly the escaped input', () => {
  const NASTY = ['<script>alert(1)</script>', '"><img src=x onerror=alert(1)>', "&amp; &lt; &#39; &quot;", "'\\\"", '`` ` ```', '</span><b>x</b>', '<span class="hl-k">fake</span>',
    '/* <!-- --> */', '<!-- /* */ -->', '${`<i>`}', 'a"b\'c`d', '<', '>', '&', '\\', '', ' '];
  for (const lang of LANGS) {
    const out = H.highlightLines(NASTY, lang);
    assert.equal(out.length, NASTY.length, lang);
    out.forEach((h, i) => {
      assert.equal(strip(h), esc(NASTY[i]), `${lang}: ${JSON.stringify(NASTY[i])}`);
      assert.doesNotMatch(h, /<(?!\/?span\b)/, `${lang}: a raw < that is not ours: ${h}`);
      assert.equal((h.match(/<span class="hl-[a-z]">/g) || []).length, (h.match(/<\/span>/g) || []).length, `${lang}: balanced spans`);
    });
  }
});

test('S5: the same rule holds for deterministic random garbage in every language', () => {
  let seed = 12345;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  const ALPHA = '<>&"\'`/*#$ \\{}[]()-=:;.,@!abc012\tconst<!--*/';
  for (const lang of LANGS) {
    const lines = Array.from({ length: 300 }, () => Array.from({ length: Math.floor(rnd() * 40) }, () => ALPHA[Math.floor(rnd() * ALPHA.length)]).join(''));
    const out = H.highlightLines(lines, lang);
    out.forEach((h, i) => {
      assert.equal(strip(h), esc(lines[i]), `${lang} line ${i}: ${JSON.stringify(lines[i])}`);
      assert.doesNotMatch(h, /<(?!\/?span\b)/);
    });
  }
});

test('S5 on the real files: every file of the repository with a known language keeps the rule, whole', () => {
  const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { cwd: ROOT, encoding: 'utf8' }).split('\0').filter((f) => f && H.languageOf(f) && fs.existsSync(path.join(ROOT, f)));
  assert.ok(files.length > 150, `the repository has files to check (${files.length})`);
  let lines = 0;
  for (const f of files) {
    const text = fs.readFileSync(path.join(ROOT, f), 'utf8').replace(/\r\n/g, '\n').split('\n');
    const out = H.highlightLines(text, H.languageOf(f));
    if (out === null) { assert.ok(text.length > H.MAX_LINES, `${f} is skipped only for being long`); continue; }
    out.forEach((h, i) => { if (strip(h) !== esc(text[i])) assert.fail(`${f}:${i + 1}: ${text[i].slice(0, 80)}`); });
    lines += out.length;
  }
  assert.ok(lines > 20000, `a lot of real code was checked (${lines} lines)`);
});

test('a hostile line does not hang it: very long lines of the characters that open a token finish fast', () => {
  const t0 = Date.now();
  for (const lang of LANGS) {
    for (const ch of ['"', "'", '`', '/*', '<!--', '<a ', '${', '\\', '#', '$(']) H.highlightLines([ch.repeat(40000), `${ch}x`.repeat(20000)], lang);
  }
  assert.ok(Date.now() - t0 < 5000, `took ${Date.now() - t0} ms`);
});

test('a line of backticks that never closes is linear in markdown: 60000 of them take well under a second (the run is skipped whole)', () => {
  const line = `x${'`'.repeat(60000)}`; // starts with a letter: a line that STARTS with three backticks is a code fence, which never reaches the inline rule
  const t0 = Date.now();
  const [h] = H.highlightLines([line], 'md');
  assert.equal(strip(h), line);
  assert.ok(Date.now() - t0 < 1000, `took ${Date.now() - t0} ms`);
});

test('every scanner is linear: a line of 100,000 characters that repeat a name separator, a tag or a quote finishes fast in every language (RP66b, found by the independent check)', () => {
  const nasty = [
    '<a ' + 'a.'.repeat(50000), '<a ' + 'a:a:'.repeat(25000), '<a ' + 'a-'.repeat(50000), '<a ' + 'a@'.repeat(50000), '<a ' + 'a b '.repeat(25000), '<a ' + 'x = '.repeat(25000),
    '<a ' + '"'.repeat(100000), '<' + 'a<'.repeat(50000), '<!--'.repeat(25000), '&'.repeat(100000),
    'a.'.repeat(50000), 'a:'.repeat(50000), '$'.repeat(100000), '$('.repeat(50000), '"'.repeat(100000), "'".repeat(100000), '/*'.repeat(50000), '//'.repeat(50000),
    '@a '.repeat(30000), '{'.repeat(100000), 'a{b:c;'.repeat(20000), '#'.repeat(100000), '1.'.repeat(50000), '0x'.repeat(50000), '`'.repeat(100000), '**'.repeat(50000), '['.repeat(100000),
  ];
  for (const lang of LANGS) {
    for (const s of nasty) {
      const t = Date.now();
      const out = one(s, lang);
      const ms = Date.now() - t;
      assert.ok(ms < 1500, `${lang}: ${ms} ms for ${JSON.stringify(s.slice(0, 12))}... (${s.length} chars): not linear`);
      assert.equal(strip(out), esc(s));
    }
  }
});

test('S5: the spans are balanced and never nested, in every language, on deterministic random hostile lines (a stray </span> would break out of the cell)', () => {
  const alpha = ['<', '>', '"', "'", '`', '/', '*', '\\', '#', '$', '{', '}', '-', '!', '=', ':', ' ', '\r', '\0', '\ud800', '\udc00', 'a', '1', '.', '<!--', '-->', '/*', '*/', '</', '<a', '${', '```', '</span>', '<span class="hl-k">'];
  let seed = 7;
  const rnd = (n) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
  const balanced = (h) => { let d = 0; for (const m of h.matchAll(/<span class="hl-[a-z]">|<\/span>/g)) { d += m[0] === '</span>' ? -1 : 1; if (d < 0 || d > 1) return false; } return d === 0; };
  for (const lang of LANGS) {
    for (let t = 0; t < 400; t++) {
      const lines = Array.from({ length: 1 + rnd(5) }, () => Array.from({ length: rnd(25) }, () => alpha[rnd(alpha.length)]).join(''));
      H.highlightLines(lines, lang).forEach((h, i) => {
        assert.ok(balanced(h), `${lang} ${JSON.stringify(lines[i])} gave unbalanced spans: ${h}`);
        assert.equal(strip(h), esc(lines[i]), `${lang} ${JSON.stringify(lines[i])}`);
      });
    }
  }
});

test('it is pure: it loads in an empty context with no document, no window and no network', () => {
  const ctx = vm.createContext({});
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'public', 'highlight.js'), 'utf8'), ctx);
  assert.equal(typeof vm.runInContext('RepoPanelHighlight.languageOf', ctx), 'function');
  assert.equal(vm.runInContext('RepoPanelHighlight.languageOf("a.js")', ctx), 'js');
});
