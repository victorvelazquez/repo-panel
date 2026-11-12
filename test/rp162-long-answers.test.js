'use strict';
// RP162 (S52): the chat bubble does not cut the long answers of the agent. The history used to cut EVERY text at 4000 characters and glue a «…» to it (server/sessions.js, `capped`), so a long answer, or a long message of the
// person, ended in «corr…». The cut is now at 50 000 characters (the history is read from a window of 512 KB, so the answer of one read stays bounded either way), the number of characters that are left out travels in a field
// of its own (`cut`, an integer, only when something was cut) and the bubble SAYS it: «Message cut: N more characters, see the rest in the terminal». The text of a cut item has no «…» glued to it. And RP155 keeps working:
// the live text (it has a cap of 200 000) is compared with a CUT item by its beginning, so the same answer is not drawn twice (a cut history item and the whole live text used to differ and showed it twice).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'rp162-'));
const sessionsBase = path.join(scratch, 'sessions');
const repoDir = path.join(scratch, 'My Repo.Api');
for (const d of [sessionsBase, repoDir]) fs.mkdirSync(d);
process.env.REPO_PANEL_CONFIG = path.join(scratch, 'config.json');
process.env.REPO_PANEL_SESSIONS_DIR = sessionsBase;
test.after(() => fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 5 }));

const S = require('../server/sessions.js');
const R = require('../public/resumen.js');

const header = (id, cwd) => JSON.stringify({ type: 'session', version: 3, id, timestamp: '2026-10-28T10:00:00.000Z', cwd });
const text = (t) => ({ type: 'text', text: t });
const msg = (role, content, ts = Date.parse('2026-10-28T14:00:00Z')) => JSON.stringify({ type: 'message', timestamp: new Date(ts).toISOString(), message: { role, content, timestamp: ts } });
let n = 0;
function chatWith(lines) {
  const id = `s${++n}`;
  const dir = S.sessionsDirFor(repoDir, sessionsBase);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `2026-10-28T10-00-00-000Z_${id}.jsonl`);
  fs.writeFileSync(file, [header(id, repoDir), ...lines].join('\n') + '\n');
  fs.utimesSync(file, 2000, 2000);
  return S.readChat(repoDir, id, { base: sessionsBase });
}
const MAX = 50000;

// ---------- the server ----------
test('s1: an answer up to 50 000 characters arrives WHOLE, with no cut and no «…» (4001, 5000, 6000, 49 999 and 50 000), for the agent and for the person', () => {
  for (const len of [4000, 4001, 5000, 6000, 49999, 50000]) {
    const r = chatWith([msg('user', [text('u'.repeat(len))]), msg('assistant', [text('a'.repeat(len))])]);
    assert.deepEqual(r.items.map((i) => i.text.length), [len, len], String(len));
    for (const it of r.items) { assert.equal(it.cut, undefined, `${len} ${it.role}: no cut field`); assert.doesNotMatch(it.text, /…/); }
  }
});

test('s2: past 50 000 characters the text is exactly 50 000 characters, `cut` is how many were left out (an integer), and nothing is glued to the text', () => {
  for (const [len, cut] of [[50001, 1], [50002, 2], [60000, 10000], [200000, 150000]]) {
    const r = chatWith([msg('assistant', [text('x'.repeat(len))])]);
    const it = r.items[0];
    assert.equal(it.text.length, MAX, String(len));
    assert.equal(it.text, 'x'.repeat(MAX));
    assert.equal(it.cut, cut, String(len));
    assert.ok(Number.isSafeInteger(it.cut) && it.cut > 0);
  }
  const user = chatWith([msg('user', [text('p'.repeat(MAX + 7))])]).items[0];
  assert.equal(user.cut, 7);
  assert.equal(user.text.length, MAX);
});

test('s3: the count is of the text as the page gets it: control characters are cleaned first and the spaces at the ends do not count; blocks of one message join with a blank line', () => {
  const r = chatWith([msg('assistant', [text(`  ${'y\u0007'.repeat(30000)}z  `)])]);
  assert.equal(r.items[0].text.length, MAX, 'a control character becomes a space: 60 001 characters once the ends are trimmed, the first 50 000 stay');
  assert.equal(r.items[0].cut, 10001);
  const two = chatWith([msg('assistant', [text('b'.repeat(30000)), text('c'.repeat(30000))])]);
  assert.equal(two.items[0].text.length, MAX);
  assert.equal(two.items[0].cut, 30000 + 2 + 30000 - MAX, 'the blank line between blocks counts');
});

test('s4: what stays the same: the other fields of the item, the roles, the tool names, and the one read of a long message stays bounded', () => {
  const r = chatWith([msg('user', [text('hi')]), msg('assistant', [{ type: 'toolCall', id: 'c-read', name: 'read', arguments: { path: 'a.js' } }]), msg('assistant', [text('k'.repeat(MAX + 5))])]);
  assert.deepEqual(r.items.map((i) => i.role), ['user', 'assistant'], 'the tool call joins the next answer with text');
  assert.deepEqual(r.items[1].tools, ['read']);
  assert.equal(r.items[1].cut, 5);
  assert.equal(r.items[0].cut, undefined);
  assert.ok(JSON.stringify(r).length < 120 * 1024, 'one cut answer is about 50 KB of JSON, not the whole message');
});

// ---------- the bubble ----------
const INFO = { adopted: { id: 's1', name: 'panel:alpha' }, adoptedFound: true, sessions: [] };
const asst = (text, extra = {}) => ({ role: 'assistant', text, at: null, tools: [], ...extra });
const user = (text, extra = {}) => ({ role: 'user', text, at: null, tools: [], ...extra });
const body = (items, rpc) => R.chatBody({ id: 's1', info: INFO, hist: { found: true, items, truncated: false }, rpc }, {});
const live = (text) => ({ state: 'busy', streaming: true, thinking: false, text, asks: [] });
const NOTE = (k) => `<div class="m-cut" role="note">Message cut: ${k} more characters, see the rest in the terminal</div>`;
const count = (h, needle) => h.split(needle).length - 1;
const streaming = (h) => count(h, '<div class="m streaming">');

test('b1: a cut answer says it right under its text, with the number; an answer that was not cut says nothing', () => {
  const html = body([user('q'), asst('hello', { cut: 1234 })]);
  assert.ok(html.includes(NOTE(1234)), html);
  assert.ok(html.indexOf('hello') < html.indexOf('m-cut'), 'under the text');
  assert.doesNotMatch(body([user('q'), asst('hello')]), /m-cut|Message cut/);
  assert.ok(body([user('mine', { cut: 5 }), asst('ok')]).includes(NOTE(5)), 'the messages of the person too');
});

test('b2: only a positive safe integer draws the note: anything else says nothing and never breaks the bubble', () => {
  for (const cut of [0, -1, 1.5, NaN, Infinity, '12', null, undefined, {}, [], true, Number.MAX_SAFE_INTEGER + 2, 1e21]) {
    const html = body([user('q'), asst('hello', { cut })]);
    assert.doesNotMatch(html, /m-cut|Message cut/, String(cut));
    assert.match(html, /hello/);
  }
  assert.ok(body([asst('x', { cut: Number.MAX_SAFE_INTEGER })]).includes(NOTE(Number.MAX_SAFE_INTEGER)));
});

test('b3: the text of a bubble is still escaped: markup in a cut answer never becomes markup', () => {
  const html = body([asst('<img src=x onerror=alert(1)>', { cut: 3 })]);
  assert.doesNotMatch(html, /<img/);
  assert.ok(html.includes(NOTE(3)));
});

test('b4: the words of the note are the ones the rules of the page allow: no mention of the session runtime or of the shell by name', () => {
  assert.doesNotMatch(NOTE(1), /pi session|pi screen|Gentle Shell/i);
});

// ---------- RP155: the same answer is not drawn twice ----------
test('d1: a CUT history item and the whole live text of the same answer are the same answer (compared by the beginning): the live bubble is not drawn', () => {
  const whole = `${'a b '.repeat(20000)}the end`;
  const h = body([user('q'), asst(whole.slice(0, 50000), { cut: whole.length - 50000 })], live(whole));
  assert.equal(streaming(h), 0);
});

test('d2: a live text that does not start like the cut item is another answer and is drawn; an item that was not cut still needs the whole text to match', () => {
  const cutItems = [user('q'), asst('one two three', { cut: 10 })];
  assert.equal(streaming(body(cutItems, live('other thing entirely'))), 1);
  assert.equal(streaming(body(cutItems, live('one two three plus more'))), 0);
  const whole = [user('q'), asst('one two')];
  assert.equal(streaming(body(whole, live('one two three'))), 1, 'no cut: a longer live text is not the same');
  assert.equal(streaming(body(whole, live('one  two'))), 0, 'spaces collapse, as before');
});

test('d3: a cut item that comes BEFORE a message of the person never hides a new answer (an older run), and a bad cut is not a cut', () => {
  const items = [asst('old answer', { cut: 4 }), user('next')];
  assert.equal(streaming(body(items, live('old answer and more'))), 1);
  assert.equal(streaming(body([user('q'), asst('abc', { cut: -3 })], live('abc def'))), 1, 'a negative cut is no cut: the whole text must match');
  assert.equal(streaming(body([user('q'), asst('abc', { cut: '9' })], live('abc def'))), 1);
});
