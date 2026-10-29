'use strict';
// RP70 (S64): chat messages keep their format. Server: readChat keeps line structure (LF and TAB survive, blocks are
// joined with a blank line) and the delivery check still works on multi-line text. Client: R.mdHtml turns ONE message into
// safe HTML (escape first, tiny markdown subset) and R.chatBody uses it. Temp dirs and a fake Orca only.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'rp70-'));
const sessionsBase = path.join(scratch, 'sessions');
const repoDir = path.join(scratch, 'my-repo');
for (const d of [sessionsBase, repoDir]) fs.mkdirSync(d);
const configFile = path.join(scratch, 'config.json');
process.env.REPO_PANEL_CONFIG = configFile;
process.env.REPO_PANEL_SESSIONS_DIR = sessionsBase;
process.env.REPO_PANEL_CASES_FILE = 'off';
test.after(() => fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 5 }));

const lib = require('../lib.js');
const S = require('../server/sessions.js');
const { sendChat } = require('../server/chatsend.js');
const R = require('../public/resumen.js');

// ---------- server helpers ----------
const header = (id) => JSON.stringify({ type: 'session', version: 3, id, timestamp: '2026-10-28T10:00:00.000Z', cwd: repoDir });
const text = (t) => ({ type: 'text', text: t });
const call = (name, args = {}) => ({ type: 'toolCall', id: `c-${name}`, name, arguments: args });
const msg = (role, content, ts = Date.parse('2026-10-28T14:00:00Z')) => JSON.stringify({ type: 'message', timestamp: new Date(ts).toISOString(), message: { role, content, timestamp: ts } });
function putSession(id, lines) {
  const dir = S.sessionsDirFor(repoDir, sessionsBase);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `2026-10-28T10-00-00-000Z_${id}.jsonl`);
  fs.writeFileSync(file, lines.join('\n') + '\n');
  return file;
}
const resetDisk = () => { fs.rmSync(sessionsBase, { recursive: true, force: true }); fs.mkdirSync(sessionsBase); };
const chatOf = (id) => S.readChat(repoDir, id, { base: sessionsBase });
// The text of the single item of a one-message session.
const oneUser = (id, content) => { resetDisk(); putSession(id, [header(id), msg('user', content)]); return chatOf(id).items[0].text; };

// ---------- A: readChat keeps the line structure ----------
test('readChat: CRLF and CR become LF', () => {
  assert.equal(oneUser('a1', [text('a\r\nb\rc\r\n\r\nd')]), 'a\nb\nc\n\nd');
});

test('readChat: LF and TAB are kept in the message text', () => {
  assert.equal(oneUser('a2', [text('# Title\n\n- one\n\t- nested\n\nlast')]), '# Title\n\n- one\n\t- nested\n\nlast');
});

test('readChat: every other control character still becomes ONE space', () => {
  const ctrl = ['\x00', '\x01', '\x07', '\x08', '\x0b', '\x0c', '\x0e', '\x1b', '\x1f', '\x7f', '\x80', '\x85', '\x9f', '\u2028', '\u2029'];
  for (const c of ctrl) assert.equal(oneUser('a3', [text(`a${c}b`)]), 'a b', `U+${c.charCodeAt(0).toString(16).padStart(4, '0')} must become a space`);
  assert.equal(oneUser('a3', [text('a\x1b\x00b')]), 'a  b', 'two controls are two spaces, nothing collapses');
});

test('readChat: several text blocks of one message are joined with a blank line, user and assistant', () => {
  assert.equal(oneUser('a4', [text('First'), text('Second'), text('Third')]), 'First\n\nSecond\n\nThird');
  resetDisk();
  putSession('a4b', [header('a4b'), msg('assistant', [text('One.'), { type: 'thinking', thinking: 'SECRET' }, text('Two.\nTwo b.')])]);
  assert.equal(chatOf('a4b').items[0].text, 'One.\n\nTwo.\nTwo b.');
});

test('readChat: the text is still trimmed (whole message, not each line)', () => {
  assert.equal(oneUser('a5', [text('\n\n  hello\n  world  \n\n')]), 'hello\n  world');
});

test('readChat: the cap is still 4000 characters plus the ellipsis, and a capped multi-line text keeps its newlines', () => {
  const flat = oneUser('a6', [text('x'.repeat(5000))]);
  assert.equal(flat.length, 4001);
  assert.equal(flat, `${'x'.repeat(4000)}…`);
  const multi = oneUser('a6b', [text('ab\n'.repeat(2000))]);
  assert.equal(multi.length, 4001);
  assert.equal(multi, `${'ab\n'.repeat(2000).slice(0, 4000)}…`);
});

test('readChat: a tool NAME is still flattened (no newline or tab in it) and thinking, arguments and results stay out', () => {
  resetDisk();
  putSession('a7', [
    header('a7'),
    msg('assistant', [{ type: 'thinking', thinking: 'SECRET-T\nline' }, call('read\nfile\tx', { path: 'SECRET-ARG\nline' })]),
    msg('toolResult', [text('SECRET-RESULT\nline')]),
    msg('assistant', [text('Done.')]),
  ]);
  const r = chatOf('a7');
  assert.deepEqual(r.items.map((i) => [i.text, i.tools]), [['Done.', ['read file x']]]);
  assert.doesNotMatch(JSON.stringify(r), /SECRET/);
});

test('listSessions: the lastMessage preview stays flattened to one line', () => {
  resetDisk();
  putSession('a8', [header('a8'), msg('user', [text('first line\nsecond\tline')])]);
  const s = S.listSessions(repoDir, { base: sessionsBase }).find((x) => x.id === 'a8');
  assert.equal(s.lastMessage.text, 'first line second line');
});

// ---------- B: the delivery check with multi-line text ----------
const NAME = 'panel:my-repo';
const ADOPTED = { id: 'panel-my-repo', name: NAME, adoptedAt: '2026-10-28T10:00:00.000Z' };
const REPO_ID = lib.repoId(repoDir);
const IDLE = `▎ ✿ waiting for input\n▎   type, or / for commands\n▎\n~\\Developer\\my-repo (main) • ${NAME}\n`;
const userLine = (t) => JSON.stringify({ type: 'message', message: { role: 'user', content: [{ type: 'text', text: t }], timestamp: 1793232936000 } });
function appendUser(t, id = ADOPTED.id) {
  const dir = S.sessionsDirFor(repoDir, sessionsBase);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `2026-10-28T10-00-00-000Z_${id}.jsonl`);
  if (!fs.existsSync(file)) fs.writeFileSync(file, `${header(id)}\n`);
  fs.appendFileSync(file, `${userLine(t)}\n`);
}
function fakeOrca(onSend = () => {}) {
  const calls = [];
  const orca = async (args) => {
    calls.push(args);
    if (args[0] === 'list') return { terminals: [{ handle: 'h1', title: 'Terminal 1', worktreePath: repoDir, connected: true, writable: true }] };
    if (args[0] === 'show') return { terminal: { preview: IDLE } };
    if (args[0] === 'send') onSend(args);
    return { send: { accepted: true } };
  };
  return { orca, calls };
}
const textOfSend = (a) => a.find((x) => String(x).startsWith('--text=')).slice('--text='.length);
const sendDeps = (f) => ({ orca: f.orca, wait: async () => {}, sessionsDir: sessionsBase });

test('sendChat: a multi-line message is delivered when the history keeps its newlines', async () => {
  resetDisk();
  fs.writeFileSync(configFile, JSON.stringify({ port: 4310, groups: [{ name: 'G', repos: [{ path: repoDir }] }], rooms: [], sessions: { [REPO_ID]: ADOPTED } }));
  const f = fakeOrca((a) => appendUser(textOfSend(a)));
  const out = await sendChat(REPO_ID, { text: 'line one\n\nline two' }, sendDeps(f));
  assert.deepEqual(out, { sent: true, delivered: true, leftInBox: false });
  assert.equal(f.calls.filter((c) => c[0] === 'send').length, 1);
  assert.equal(textOfSend(f.calls.find((c) => c[0] === 'send')), 'line one\n\nline two');
});

// ---------- C: R.mdHtml ----------
// Every call goes through here so a missing function fails with a clear message instead of a bare TypeError.
const md = (t) => {
  assert.equal(typeof R.mdHtml, 'function', 'R.mdHtml is missing');
  return R.mdHtml(t);
};
// Blocks may or may not be separated by whitespace: compare the structure only.
const tight = (h) => h.replace(/>\s+</g, '><');

const CLOSE = /^<\/(p|ul|ol|li|pre|code|strong|em|blockquote|h3|h4|h5|a)>$/;
const OPEN = /^<(p|ul|ol|li|pre|code|strong|em|blockquote|h3|h4|h5)>$/;
const ANCHOR = /^<a href="https?:\/\/[^"'<>\s]*" target="_blank" rel="noopener noreferrer">$/;
// The ONLY markup allowed in an output: the tags mdHtml owns, balanced and well nested; a link tag has one exact shape
// (no way to add an attribute); no angle bracket is left in the text between the tags.
function assertSafe(html, label = '') {
  const stack = [];
  for (const t of html.match(/<[^>]*>/g) || []) {
    let m;
    if (t === '<br>') continue;
    if (ANCHOR.test(t)) { stack.push('a'); continue; }
    if ((m = OPEN.exec(t))) { stack.push(m[1]); continue; }
    if ((m = CLOSE.exec(t))) { assert.equal(stack.pop(), m[1], `${label} misnested ${t} in ${html}`); continue; }
    assert.fail(`${label} tag outside the allowed set: ${t} in ${html}`);
  }
  assert.deepEqual(stack, [], `${label} unclosed tags in ${html}`);
  assert.doesNotMatch(html.replace(/<[^>]*>/g, ''), /[<>]/, `${label} raw angle bracket in the text of ${html}`);
}
const noTag = (html, re) => assert.doesNotMatch(html, re);

test('mdHtml: an empty or non-string input returns an empty string', () => {
  for (const v of ['', undefined, null, 42, {}, [], true]) assert.equal(md(v), '');
});

test('mdHtml: a plain one-line message is a single paragraph', () => {
  assert.equal(md('hello world'), '<p>hello world</p>');
  assert.equal((md('hello world').match(/<p>/g) || []).length, 1);
});

test('mdHtml: blank lines separate paragraphs and single newlines become <br>', () => {
  assert.equal(tight(md('one\n\ntwo')), '<p>one</p><p>two</p>');
  assert.equal(tight(md('one\ntwo\nthree')), '<p>one<br>two<br>three</p>');
  assert.equal(tight(md('a\nb\n\n\n\nc')), '<p>a<br>b</p><p>c</p>');
  assert.equal(tight(md('a\r\nb')), '<p>a<br>b</p>', 'CRLF never leaves a stray CR');
});

test('mdHtml: headings use h3 for #, h4 for ##, h5 for ### and deeper, with inline formatting', () => {
  assert.equal(tight(md('# One')), '<h3>One</h3>');
  assert.equal(tight(md('## Two')), '<h4>Two</h4>');
  assert.equal(tight(md('### Three')), '<h5>Three</h5>');
  assert.equal(tight(md('#### Four')), '<h5>Four</h5>');
  assert.equal(tight(md('###### Six')), '<h5>Six</h5>');
  assert.equal(tight(md('# a **b** `c`')), '<h3>a <strong>b</strong><code>c</code></h3>');
  assert.equal(tight(md('# Title\n\ntext')), '<h3>Title</h3><p>text</p>');
});

test('mdHtml: a heading marker without a space, or with 7 hashes, stays plain text', () => {
  assert.equal(md('#hashtag'), '<p>#hashtag</p>');
  assert.equal(md('##nospace'), '<p>##nospace</p>');
  assert.equal(md('####### seven'), '<p>####### seven</p>');
  assert.equal(md('a # b'), '<p>a # b</p>');
});

test('mdHtml: unordered lists with - or *, ordered lists with 1.', () => {
  assert.equal(tight(md('- x\n- y')), '<ul><li>x</li><li>y</li></ul>');
  assert.equal(tight(md('* x\n* y')), '<ul><li>x</li><li>y</li></ul>');
  assert.equal(tight(md('1. one\n2. two\n3. three')), '<ol><li>one</li><li>two</li><li>three</li></ol>');
  assert.equal(tight(md('intro\n\n- **b** item\n- `c` item\n\noutro')), '<p>intro</p><ul><li><strong>b</strong> item</li><li><code>c</code> item</li></ul><p>outro</p>');
  assert.equal(md('-no space'), '<p>-no space</p>');
  assert.equal(md('1.no space'), '<p>1.no space</p>');
});

test('mdHtml: a fenced block becomes pre/code with the content escaped, NOT formatted, newlines and indentation kept', () => {
  const html = md('before\n\n```js\nconst a = "<b>**x**</b>";\n  # not a heading\n- not a list\n[l](https://a.com)\n```\n\nafter');
  assertSafe(html);
  assert.match(html, /<pre><code>/);
  assert.ok(html.includes('const a = &quot;&lt;b&gt;**x**&lt;/b&gt;&quot;;\n  # not a heading\n- not a list\n[l](https://a.com)'), html);
  const inside = html.slice(html.indexOf('<pre>'), html.indexOf('</pre>'));
  noTag(inside, /<(strong|em|h3|h4|h5|ul|ol|li|a|br)[ >]/);
  assert.match(tight(html), /^<p>before<\/p><pre><code>[\s\S]*<\/code><\/pre><p>after<\/p>$/);
});

test('mdHtml: an UNCLOSED fence takes the rest of the message as code and keeps the markup balanced', () => {
  const html = md('intro\n\n```\ncode <b> here\n# still code\n\n- also code');
  assertSafe(html);
  assert.ok(html.includes('code &lt;b&gt; here\n# still code\n\n- also code'), html);
  noTag(html.slice(html.indexOf('<pre>')), /<(h3|h4|h5|ul|li|p|strong)[ >]/);
  assertSafe(md('```'));
  assertSafe(md('```js'));
  assertSafe(md('````'));
});

test('mdHtml: inline code is escaped and not formatted', () => {
  const html = md('use `<script>**x** # y [a](https://a.com)</script>` now');
  assertSafe(html);
  assert.equal(html, '<p>use <code>&lt;script&gt;**x** # y [a](https://a.com)&lt;/script&gt;</code> now</p>');
});

test('mdHtml: bold, italic with * and _, in one line', () => {
  assert.equal(md('a **bold** b'), '<p>a <strong>bold</strong> b</p>');
  assert.equal(md('a *it* b'), '<p>a <em>it</em> b</p>');
  assert.equal(md('a _it_ b'), '<p>a <em>it</em> b</p>');
  assert.equal(md('*a b c*'), '<p><em>a b c</em></p>');
  assert.equal(md('**a** and *b*'), '<p><strong>a</strong> and <em>b</em></p>');
});

test('mdHtml: markers that do not touch the text stay plain (2 * 3 * 4, snake_case_name)', () => {
  assert.equal(md('2 * 3 * 4'), '<p>2 * 3 * 4</p>');
  assert.equal(md('snake_case_name'), '<p>snake_case_name</p>');
  assert.equal(md('call my_func_name() and other_var_here'), '<p>call my_func_name() and other_var_here</p>');
  assert.equal(md('a ** b ** c'), '<p>a ** b ** c</p>');
});

test('mdHtml: unclosed or lone markers stay plain and never break the markup', () => {
  for (const [input, plain] of [['a **b', '**b'], ['**', '**'], ['a `b', '`b'], ['a *b', '*b'], ['a _b', '_b'], ['a [b', '[b'], ['a [b](https://x', '[b](https://x']]) {
    const html = md(input);
    assertSafe(html, input);
    assert.ok(html.includes(plain), `${input} -> ${html}`);
    noTag(html, /<(strong|em|code|a)[ >]/);
  }
  assert.equal(md('**'), '<p>**</p>');
});

test('mdHtml: a link with an http(s) url becomes a new-tab anchor with the exact attributes', () => {
  assert.equal(md('[docs](https://example.com/a?b=1&c=2)'), '<p><a href="https://example.com/a?b=1&amp;c=2" target="_blank" rel="noopener noreferrer">docs</a></p>');
  assert.equal(md('see [x](http://example.com) now'), '<p>see <a href="http://example.com" target="_blank" rel="noopener noreferrer">x</a> now</p>');
});

test('mdHtml: a bare URL stays plain text', () => {
  assert.equal(md('see https://example.com now'), '<p>see https://example.com now</p>');
  noTag(md('www.example.com and http://a.com'), /<a[ >]/);
});

test('mdHtml: a url that is not http or https never becomes a link (every casing, spacing and encoding trick)', () => {
  const urls = [
    'javascript:alert(1)', 'JavaScript:alert(1)', 'JAVASCRIPT:alert(1)', 'jAvAsCrIpT:alert(1)',
    ' javascript:alert(1)', '  javascript:alert(1)', '\tjavascript:alert(1)', '\njavascript:alert(1)', '\r\njavascript:alert(1)',
    'java\tscript:alert(1)', 'java\nscript:alert(1)', 'jav&#x61;script:alert(1)', 'jav&#97;script:alert(1)', '&#106;avascript:alert(1)',
    '%6Aavascript:alert(1)', '%6aavascript:alert(1)', 'javascript%3Aalert(1)',
    'data:text/html,<script>alert(1)</script>', 'data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==', 'DATA:text/html,x',
    'vbscript:msgbox(1)', 'VBScript:msgbox(1)', 'file:///etc/passwd', 'FILE:///c:/x', 'ftp://a.com/x', 'mailto:a@b.c', '//evil.com/x', '/relative/path', 'x.com',
    ' https://a.com', '\thttps://a.com', 'xhttps://a.com', 'https:/a.com', 'https//a.com', 'javascript://https://a.com/%0aalert(1)',
  ];
  for (const u of urls) {
    const html = md(`[x](${u})`);
    assertSafe(html, JSON.stringify(u));
    noTag(html, /<a[ >]/);
    noTag(html, /href=/i);
    if (!/\s/.test(u)) assert.ok(html.includes(R.esc(`[x](${u})`)), `${JSON.stringify(u)} must stay as escaped text: ${html}`);
  }
});

test('mdHtml: a link text with quotes, markdown or html stays inside the anchor, escaped', () => {
  const quotes = md('[a"b\'c](https://a.com)');
  assertSafe(quotes);
  assert.ok(quotes.includes('>a&quot;b&#39;c</a>'), quotes);
  const rich = md('[**b** <i onclick=alert(1)> `c`](https://a.com)');
  assertSafe(rich);
  assert.equal((rich.match(/<a /g) || []).length, 1);
  assert.ok(rich.includes('&lt;i onclick=alert(1)&gt;'), rich);
  const inj = md('[<script>alert(1)</script>](https://a.com)');
  assertSafe(inj);
  assert.ok(inj.includes('&lt;script&gt;'), inj);
});

test('mdHtml: quotes and apostrophes in the url can never end the href attribute', () => {
  for (const input of ['[x](https://a.com/"onmouseover="alert(1))', "[x](https://a.com/' onfocus='alert(1))", '[x](https://a.com/" onclick="alert(1)">y)', '[x](https://a.com/<script>alert(1)</script>)', '[x](https://a.com/ onmouseover=alert(1))', '[x](https://a.com/\'"`)']) {
    const html = md(input);
    assertSafe(html, input);
    for (const a of html.match(/<a [^>]*>/g) || []) {
      assert.match(a, ANCHOR, `${input}: anchor with an unexpected shape`);
      assert.doesNotMatch(a, /onmouseover|onfocus|onclick/i, `${input}: attribute injected`);
    }
    assert.doesNotMatch(html, /"\s*on\w+=/i, `${input}: attribute injected`);
    assert.doesNotMatch(html, /'\s*on\w+=/i, `${input}: attribute injected`);
  }
});

test('mdHtml: a blockquote from consecutive > lines, and a list inside a quote', () => {
  const q = md('> first\n> second');
  assertSafe(q);
  assert.match(tight(q), /^<blockquote>[\s\S]*first[\s\S]*second[\s\S]*<\/blockquote>$/);
  assert.equal((q.match(/<blockquote>/g) || []).length, 1);
  const l = md('> - a\n> - b\n\nafter');
  assertSafe(l);
  assert.match(l, /<blockquote>/);
  assert.match(l, /<li>a<\/li>/);
  assert.match(l, /<li>b<\/li>/);
  assert.match(tight(l), /<\/blockquote><p>after<\/p>$/);
  assert.equal(md('a > b'), '<p>a &gt; b</p>');
  assert.equal(md('>no space'), '<p>&gt;no space</p>');
});

// ---------- D: abuse ----------
test('abuse: raw HTML in a message is never inserted, it is shown as text', () => {
  const cases = [
    ['<script>alert(1)</script>', '&lt;script&gt;alert(1)&lt;/script&gt;'],
    ['<img src=x onerror=alert(1)>', '&lt;img src=x onerror=alert(1)&gt;'],
    ['</p><script>alert(1)</script>', '&lt;/p&gt;&lt;script&gt;'],
    ['<svg/onload=alert(1)>', '&lt;svg/onload=alert(1)&gt;'],
    ['<iframe src="javascript:alert(1)"></iframe>', '&lt;iframe src=&quot;javascript:alert(1)&quot;&gt;&lt;/iframe&gt;'],
    ['<a href="javascript:alert(1)">x</a>', '&lt;a href=&quot;javascript:alert(1)&quot;&gt;x&lt;/a&gt;'],
    ['<b', '&lt;b'],
    ['hello <b and more', 'hello &lt;b and more'],
    ['<', '&lt;'],
    ['a > b < c', 'a &gt; b &lt; c'],
  ];
  for (const [input, shown] of cases) {
    const html = md(input);
    assertSafe(html, input);
    assert.ok(html.includes(shown), `${input} -> ${html}`);
  }
});

test('abuse: raw HTML inside every kind of block is escaped (heading, list, quote, link text, bold, fence)', () => {
  for (const wrap of ['# {}', '- {}', '1. {}', '> {}', '[{}](https://a.com)', '**{}**', '*{}*', '```\n{}\n```', '`{}`', 'x\n\n{}\n\ny']) {
    const html = md(wrap.replace('{}', '<script>alert(1)</script><img src=x onerror=alert(1)>'));
    assertSafe(html, wrap);
    assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'), `${wrap} -> ${html}`);
  }
});

test('abuse: an entity in the message is escaped again, never decoded', () => {
  const html = md('&lt;script&gt; and &amp; and &#60;b&#62;');
  assertSafe(html);
  assert.equal(html, '<p>&amp;lt;script&amp;gt; and &amp;amp; and &amp;#60;b&amp;#62;</p>');
});

test('abuse: quotes and apostrophes in plain text are escaped', () => {
  assert.equal(md('say "hi" it\'s'), '<p>say &quot;hi&quot; it&#39;s</p>');
});

test('abuse: a very long message of nested markers finishes fast and stays balanced', () => {
  md('warm up **a** [b](https://a.com) `c`');
  const inputs = {
    stars: '**'.repeat(2000),
    brackets: '['.repeat(4000),
    bracketParen: '[x]('.repeat(1000),
    mixed: '**[`_*'.repeat(660),
    unclosedLinks: '[a](https://a.com'.repeat(235),
    ticks: '`'.repeat(4000),
    underscores: '_a'.repeat(2000),
    boldItalic: '***a** *b* __c__ '.repeat(230),
    quotes: '> '.repeat(2000),
    heads: '# '.repeat(2000),
    lists: '- '.repeat(2000),
    listLines: '- **a\n'.repeat(660),
    fences: '```\n'.repeat(1000),
    alternating: '*a_'.repeat(1300),
  };
  for (const [name, input] of Object.entries(inputs)) {
    assert.ok(input.length <= 4000, `${name} is ${input.length} long`);
    const t0 = process.hrtime.bigint();
    const html = md(input);
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    assert.ok(ms < 200, `${name} took ${ms.toFixed(1)} ms`);
    assertSafe(html, name);
  }
});

test('abuse: code with HTML, bold markers and hashes is shown literally, inside a fence and inside backticks', () => {
  const fenced = md('```\n<script>alert(1)</script>\n**not bold**\n# not a heading\n```');
  assertSafe(fenced);
  assert.ok(fenced.includes('&lt;script&gt;alert(1)&lt;/script&gt;\n**not bold**\n# not a heading'), fenced);
  noTag(fenced, /<(strong|h3|h4|h5)[ >]/);
  const inline = md('`<script>` and `**x**` and `# y`');
  assertSafe(inline);
  assert.equal(inline, '<p><code>&lt;script&gt;</code> and <code>**x**</code> and <code># y</code></p>');
});

test('abuse: a link whose text breaks out of the anchor or nests another link stays well formed', () => {
  for (const input of ['[[x](https://a.com)](https://b.com)', '[a](https://a.com)[b](https://b.com)', '[](https://a.com)', '[x]()', '[x](https://a.com', '[x](https://a.com))', '[x](https://a.com)(https://b.com)', '**[x](https://a.com)**', '[**x](https://a.com)**', '*[x*](https://a.com)', '`[x](https://a.com)`']) {
    assertSafe(md(input), input);
  }
});

// ---------- C: R.chatBody ----------
const adopted = { id: 's1', name: 'panel:alpha' };
const info = { key: 'r1', adopted, adoptedFound: true, sessions: [], live: { state: 'free', count: 1 } };
const bodyOf = (items) => R.chatBody({ id: 'r1', info, hist: { found: true, items, truncated: false } }, { now: Date.parse('2026-05-01T12:00:00Z') });

test('chatBody: a user and an assistant bubble render the message with mdHtml', () => {
  const items = [
    { role: 'user', text: 'a\n\n- x\n- y', at: '2026-05-01T11:00:00.000Z', tools: [] },
    { role: 'assistant', text: '## Plan\n\nuse **bold**\nsecond line', at: null, tools: [] },
  ];
  const html = tight(bodyOf(items));
  assert.match(html, /<div class="m me"><span class="who">You · \d\d:\d\d<\/span>[\s\S]*<p>a<\/p><ul><li>x<\/li><li>y<\/li><\/ul>[\s\S]*<\/div>/);
  assert.match(html, /<div class="m"><span class="who">panel:alpha<\/span>[\s\S]*<h4>Plan<\/h4><p>use <strong>bold<\/strong><br>second line<\/p>[\s\S]*<\/div>/);
});

test('chatBody: the who label, the time, the tools line and the working bubble are unchanged', () => {
  const items = [
    { role: 'user', text: 'hi', at: '2026-05-01T11:00:00.000Z', tools: [] },
    { role: 'assistant', text: 'ok', at: null, tools: ['read', 'grep', 'bash', 'write', 'edit'] },
    { role: 'assistant', text: '', at: null, tools: ['edit', 'bash'] },
  ];
  const html = bodyOf(items);
  assert.match(html, /<span class="who">You · \d\d:\d\d<\/span>/);
  assert.match(html, /<span class="who">panel:alpha<\/span>/);
  assert.match(html, /<div class="tools">▸ 5 tools · read, grep, bash \(\+2\)<\/div>\s*<div class="m">/);
  assert.match(html, /▸ 2 tools · edit, bash<\/div>\s*<div class="m working">working…<\/div>/);
});

test('chatBody: raw HTML in a message is escaped and the markup stays balanced', () => {
  const html = bodyOf([{ role: 'user', text: '<script>alert(1)</script>\n\n[x](javascript:alert(1))', at: null, tools: [] }, { role: 'assistant', text: '<img src=x onerror=alert(1)>', at: null, tools: [] }]);
  assert.doesNotMatch(html, /<script|<img|<a /);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
});

// ---------- E: existing behaviour that must keep holding ----------
test('existing: a control character such as ESC is still replaced by a space in the chat text', () => {
  const out = oneUser('e1', [text('x\x1b[31mred\x1b[0m next')]);
  assert.equal(out.includes('\x1b'), false);
  assert.equal(out, 'x [31mred [0m next');
});
