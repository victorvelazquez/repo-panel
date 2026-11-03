'use strict';
// RPC2-3 (S1, S6, S8), the page side of a dialog of the agent. HIGH RISK: the card is how the person answers a PERMISSION. The reducer keeps the
// dialogs as objects, the card shows the title and the FULL message escaped, Deny comes first and the Allow button is never offered when the
// command may be cut or is not shown (RP81). Pure functions: no DOM, no network.
const test = require('node:test');
const assert = require('node:assert/strict');
const V = require('../public/view.js');
const R = require('../public/resumen.js');

const ID = '0123456789';
const dlg = (over = {}) => ({ requestId: 'd1', method: 'confirm', title: 'Allow guarded git push?', message: 'git push origin HEAD', options: [], expiresAt: null, truncated: false, ...over });
const card = (ask, extra = {}) => R.chatBody({ id: ID, info: { adopted: { id: 's1', name: 'demo' }, adoptedFound: true }, hist: { items: [] }, rpc: { state: 'asking', asks: [ask], text: '', streaming: false }, ...extra }, { now: 0 });
const buttons = (html) => [...html.matchAll(/<button[^>]*>/g)].map((m) => m[0]);
const labels = (html) => [...html.matchAll(/<button[^>]*>([^<]*)<\/button>/g)].map((m) => m[1]);

// ---------- state ----------
test('s1: dialog adds the object (requestId, method, title, message, options, truncated, expiresAt) and dialog-closed removes it by requestId', () => {
  let r = V.rpcReduce(undefined, { id: ID, kind: 'dialog', ...dlg(), extra: 'x' });
  r = V.rpcReduce(r.entry, { id: ID, kind: 'dialog', ...dlg({ requestId: 'd2', method: 'select', options: ['a', 'b'] }) });
  assert.deepEqual(r.entry.asks[0], dlg());
  assert.deepEqual(Object.keys(r.entry.asks[1]).sort(), ['expiresAt', 'message', 'method', 'options', 'requestId', 'title', 'truncated']);
  r = V.rpcReduce(r.entry, { id: ID, kind: 'dialog', ...dlg({ title: 'again' }) });
  assert.deepEqual(r.entry.asks.map((a) => a.requestId), ['d1', 'd2'], 'the same requestId is not added twice');
  r = V.rpcReduce(r.entry, { id: ID, kind: 'dialog-closed', requestId: 'd1' });
  assert.deepEqual(r.entry.asks.map((a) => a.requestId), ['d2']);
  r = V.rpcReduce(r.entry, { id: ID, kind: 'dialog-closed', requestId: 'nope' });
  assert.equal(r.entry.asks.length, 1);
});

test('s2: a dialog that is not well formed is not added; what is too long is cut and counts as truncated; at most 20', () => {
  for (const bad of [{ requestId: 5 }, { requestId: '' }, { method: 'exec' }, { method: undefined }, { requestId: 'x'.repeat(201) }]) {
    assert.deepEqual(V.rpcReduce(undefined, { id: ID, kind: 'dialog', ...dlg(), ...bad }).entry.asks, [], JSON.stringify(bad).slice(0, 40));
  }
  const e = V.rpcReduce(undefined, { id: ID, kind: 'dialog', ...dlg({ title: 't'.repeat(400), message: 'm'.repeat(5000), options: Array.from({ length: 30 }, () => 'o'.repeat(300)), truncated: false }) }).entry.asks[0];
  assert.deepEqual([e.title.length, e.message.length, e.options.length, e.options[0].length, e.truncated], [300, 4000, 20, 200, true]);
  let entry;
  for (let i = 0; i < 25; i++) entry = V.rpcReduce(entry, { id: ID, kind: 'dialog', ...dlg({ requestId: `d${i}` }) }).entry;
  assert.equal(entry.asks.length, 20);
});

test('s3: rpcFromStatus rebuilds the cards from pendingDialogs (a reload shows them again); exit clears them', () => {
  const st = V.rpcFromStatus(undefined, { state: 'asking', pendingDialogs: [dlg(), dlg({ requestId: 'd2', method: 'input', title: 'T' }), null, { requestId: 5 }], sessionId: 's' });
  assert.deepEqual(st.asks.map((a) => a.requestId), ['d1', 'd2']);
  assert.equal(st.asks[0].message, 'git push origin HEAD');
  assert.deepEqual(V.rpcFromStatus(st, { state: 'idle', pendingDialogs: [], sessionId: 's' }).asks, []);
  assert.deepEqual(V.rpcReduce(st, { id: ID, kind: 'exit' }).entry.asks, []);
});

// ---------- the card ----------
test('k1: a confirm shows the title and the FULL message in a pre block, Deny first and then Allow, no autofocus and no Allow always', () => {
  const html = card(dlg());
  assert.match(html, /Allow guarded git push\?/);
  assert.match(html, /<pre class="ch-ask-text">git push origin HEAD<\/pre>/);
  assert.deepEqual(labels(html), ['Deny', 'Allow']);
  assert.match(buttons(html)[0], /data-kind="deny"/);
  assert.match(buttons(html)[1], /data-kind="allow"/);
  assert.doesNotMatch(html, /autofocus|accesskey|always/i);
  assert.match(buttons(html)[0], /data-act="rpc-answer"/);
});

test('k2: no Allow when truncated, when the message is empty or blank, or when it ends with an ellipsis; Deny stays and a note says to use the terminal', () => {
  const NOTE = /The command is cut or not shown: answer it in the terminal/;
  for (const over of [{ truncated: true }, { message: '' }, { message: '   \n' }, { message: 'git push origin…' }, { message: 'git push origin...' }, { message: 'git push origin … \n' }]) {
    const html = card(dlg(over));
    assert.deepEqual(labels(html), ['Deny'], JSON.stringify(over));
    assert.match(html, NOTE);
  }
  assert.doesNotMatch(card(dlg()), NOTE);
  assert.deepEqual(labels(card(dlg({ message: 'echo ... done' }))), ['Deny', 'Allow'], 'an ellipsis in the middle is fine');
});

test('k3: the title and the message are escaped (img onerror, </pre>, quotes) and shown in full', () => {
  const evil = '</pre><img src=x onerror=alert(1)> "q" \'s\' &amp; <script>x</script>';
  const html = card(dlg({ title: evil, message: evil + '\nline 2' }));
  assert.doesNotMatch(html, /<img|<script|<\/pre><img/);
  assert.match(html, /&lt;\/pre&gt;&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(html, /&quot;q&quot;/);
  assert.match(html, /line 2<\/pre>/);
  assert.equal((html.match(/<pre/g) || []).length, 1);
  const long = card(dlg({ message: 'x'.repeat(3999) + 'y' }));
  assert.ok(long.includes('x'.repeat(3999) + 'y</pre>'), 'the whole text is in the card');
});

test('k4: a select has one escaped button per option in order plus Cancel; an Allow… select without a safe message offers only Cancel', () => {
  const html = card(dlg({ method: 'select', title: 'Pick', message: '', options: ['b <i>one</i>', 'a', 'c"d'] }));
  assert.deepEqual(labels(html), ['b &lt;i&gt;one&lt;/i&gt;', 'a', 'c&quot;d', 'Cancel']);
  assert.deepEqual(buttons(html).map((b) => (/data-index="(\d)"/.exec(b) || [])[1]), ['0', '1', '2', undefined]);
  assert.doesNotMatch(html, /<i>/);
  for (const over of [{ message: '' }, { truncated: true }, { message: 'sudo rm…' }]) {
    const h = card(dlg({ method: 'select', title: 'Allow recognized data-loss command?', options: ['Yes', 'No'], ...over }));
    assert.deepEqual(labels(h), ['Cancel'], JSON.stringify(over));
    assert.match(h, /The command is cut or not shown: answer it in the terminal/);
  }
  assert.deepEqual(labels(card(dlg({ method: 'select', title: 'Allow it?', message: 'git push', options: ['Yes', 'No'] }))), ['Yes', 'No', 'Cancel']);
});

test('k5: an input has a text field and an editor a textarea, each with Send and Cancel; the message shows for both', () => {
  const input = card(dlg({ method: 'input', title: 'Enter a value', message: 'hint <b>', options: [] }));
  assert.match(input, /<input[^>]*class="ask-field"/);
  assert.deepEqual(labels(input), ['Send', 'Cancel']);
  assert.match(input, /<pre class="ch-ask-text">hint &lt;b&gt;<\/pre>/);
  const editor = card(dlg({ method: 'editor', title: 'Edit', message: '' }));
  assert.match(editor, /<textarea[^>]*class="ask-field"/);
  assert.deepEqual(labels(editor), ['Send', 'Cancel']);
  assert.doesNotMatch(input + editor, /autofocus/);
});

test('k6: buttons are disabled while the answer is on its way, and the old line «pi is asking something…» is gone', () => {
  const html = card(dlg(), { askBusy: { d1: true } });
  assert.ok(buttons(html).every((b) => /disabled/.test(b)));
  assert.ok(!buttons(card(dlg())).some((b) => /disabled/.test(b)));
  assert.doesNotMatch(html, /pi is asking something/);
  assert.doesNotMatch(html, /rpc-cancel/);
});

test('k7: askAllowed is the one rule: confirm and Allow-titled select need a whole, non-empty message that is not cut', () => {
  assert.equal(R.askAllowed(dlg()), true);
  assert.equal(R.askAllowed(dlg({ truncated: true })), false);
  assert.equal(R.askAllowed(dlg({ message: '' })), false);
  assert.equal(R.askAllowed(dlg({ message: 'x…' })), false);
  assert.equal(R.askAllowed(dlg({ method: 'select', title: 'Pick', message: '', options: ['a'] })), true, 'not an Allow select');
  assert.equal(R.askAllowed(dlg({ method: 'select', title: 'allow it', message: '', options: ['a'] })), false);
  assert.equal(R.askAllowed(null), false);
});

// ---------- found by the independent verification: a command that is not really visible, or whose cut is disguised ----------
test('k8: no Allow when the command is not visible, has hidden characters or its cut is disguised; Deny stays', () => {
  const hidden = ['\x01', '\u200b', '\u00ad', '\u3164', '\u2800', '\u202e', 'ls \u202e-fr', 'ls\u200bfoo', 'ls\u2028foo'];
  const cut = ['ls \u2025', 'ls \u22ef', 'ls \ufe19', 'ls \u2026\u200b', 'ls ...\u202c', 'ls ..', 'ls . . .', 'ls\u2026 \n'];
  for (const message of [...hidden, ...cut, '   ', '\n\t ']) assert.deepEqual(labels(card(dlg({ message }))), ['Deny'], JSON.stringify(message));
  assert.deepEqual(labels(card(dlg({ message: 'git push origin HEAD' }))), ['Deny', 'Allow'], 'a plain command keeps both');
  assert.deepEqual(labels(card(dlg({ message: 'git log --oneline\ngit status' }))), ['Deny', 'Allow'], 'a multi-line command is fine');
});

test('k9: the hidden characters of the title, the message and the options are SHOWN as markers, never rendered', () => {
  const html = card(dlg({ title: 'Allow\u202e?', message: 'rm\u200b -rf x' }));
  assert.ok(html.includes('\u27e6U+202E\u27e7') && html.includes('\u27e6U+200B\u27e7'), 'markers present');
  assert.equal(/[\u202e\u200b]/.test(html), false, 'no raw hidden character reaches the page');
  const sel = card(dlg({ method: 'select', title: 'Pick', message: '', options: ['a\u202eb', 'ok'] }));
  assert.deepEqual(labels(sel), ['Cancel'], 'a select with a hidden character in an option offers no option at all');
  assert.equal(/\u202e/.test(sel), false, 'and no raw hidden character reaches the page');
  assert.ok(card(dlg({ message: 'a\nb\tc' })).includes('a\nb\tc'), 'LF and TAB stay as they are');
});

test('k11: marks, selectors, fillers, unassigned and private-use characters never leave an Allow, and a mark after an ellipsis does not hide the cut', () => {
  const bad = ['ls \ufe00', 'ls \u{e0100}', 'ls \u034f', 'ls \u17b4\u17b5', 'ls \u180b', 'ls \uffa0', 'ls \u0301', 'ls \u2065', 'ls \ue000', 'ls \ud800',
    'ls \u2026\u0301', 'ls \u2026\ufe0f', 'ls ..\u034f', 'ls ...\ufe00', 'ls \u2026\uffa0', 'ls \u2026\u17b4', 'ls \u2026\u180b', '\ufe00', '\u034f', '\uffa0', '\u17b5', 'ls\r'];
  for (const m of bad) assert.equal(R.askAllowed(dlg({ message: m })), false, JSON.stringify(m));
  for (const m of ['ls -la', 'git push origin HEAD', 'cd "C:\\Users\\V\u00edctor\\repo"', 'echo \u4e2d\u6587 \u0434\u0430', 'rm -rf ./x && echo "done"', 'echo caf\u00e9 \u2192 ok']) assert.equal(R.askAllowed(dlg({ message: m })), true, JSON.stringify(m));
  assert.ok(card(dlg({ message: 'ls \u0301' })).includes('\u27e6U+0301\u27e7'), 'a mark is shown as a marker');
  assert.equal(R.askAllowed(dlg({ method: 'select', title: 'Pick', message: '', options: ['a\u0301', 'b'] })), false, 'a mark in an option of a select');
});

test('k12: glyph-less symbols, odd spaces, a mark after an ellipsis and lookalike cut markers never leave an Allow; the card does not break on a select without options', () => {
  const bad = ['ls \u{1d159}', 'ls \ufffc', 'ls\u00a0foo', 'ls \u3000', 'ls \u2003', 'ls \u202f', 'ls \u2026\u0903', 'ls ...\u0903', 'ls .\u0903.\u0903.\u0903',
    'ls \u22ee', 'ls \u205d', 'ls \u2d48', 'ls \u1365', 'ls \uff0e\uff0e', 'ls \u2024\u2024', 'ls \u3002\u3002\u3002', 'ls \u00b7\u00b7\u00b7'];
  for (const m of bad) assert.equal(R.askAllowed(dlg({ message: m })), false, JSON.stringify(m));
  for (const m of ['ls -la', 'a\tb', 'git log --oneline\ngit status', 'echo "a b" | wc -l']) assert.equal(R.askAllowed(dlg({ message: m })), true, JSON.stringify(m));
  assert.ok(card(dlg({ message: 'ls\u00a0foo' })).includes('\u27e6U+00A0\u27e7'), 'an odd space is shown as a marker');
  assert.doesNotThrow(() => card(dlg({ method: 'select', title: 'Pick', message: '', options: undefined })));
});

test('k10: a select is never answerable when it is truncated or has hidden characters, and an Allow-like title is read through invisibles and width', () => {
  const sel = (over) => dlg({ method: 'select', title: 'Pick one', message: '', options: ['Yes', 'No'], ...over });
  assert.equal(R.askAllowed(sel({ truncated: true })), false, 'any truncated select');
  assert.equal(R.askAllowed(sel({ options: ['Y\u200bes', 'No'] })), false, 'a hidden character in an option');
  assert.equal(R.askAllowed(sel({ title: 'Pi\u202eck' })), false, 'a hidden character in the title');
  assert.equal(R.askAllowed(sel({ title: '\u200bAllow it' })), false, 'Allow behind an invisible, no message');
  assert.equal(R.askAllowed(sel({ title: '\uff21llow it' })), false, 'full-width A, no message');
  assert.equal(R.askAllowed(sel({ title: '\uff21llow it', message: 'git push' })), true, 'with the whole command it may be answered');
  assert.equal(R.askAllowed(sel()), true, 'a plain select');
  assert.deepEqual(labels(card(sel({ title: '\u200bAllow it', truncated: true }))), ['Cancel']);
});
