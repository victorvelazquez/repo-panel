'use strict';
// RP104 (S1, S2): the chat history reads a 512 KB window of the session file (it was 64 KB), and a «thinking…» mark shows where the model
// reasoned, live and in the history, WITHOUT any of the reasoning text. Temp dirs only: the real sessions are never touched.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'rp104-'));
const sessionsBase = path.join(scratch, 'sessions');
const repoDir = path.join(scratch, 'My Repo.Api');
for (const d of [sessionsBase, repoDir]) fs.mkdirSync(d);
process.env.REPO_PANEL_CONFIG = path.join(scratch, 'config.json');
process.env.REPO_PANEL_SESSIONS_DIR = sessionsBase;
test.after(() => fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 5 }));

const S = require('../server/sessions.js');
const R = require('../public/resumen.js');
const V = require('../public/view.js');

const header = (id, cwd) => JSON.stringify({ type: 'session', version: 3, id, timestamp: '2026-10-28T10:00:00.000Z', cwd });
const text = (t) => ({ type: 'text', text: t });
const call = (name, args = {}) => ({ type: 'toolCall', id: `c-${name}`, name, arguments: args });
const think = (t = 'SECRET-THOUGHT') => ({ type: 'thinking', thinking: t });
const msg = (role, content, ts = Date.parse('2026-10-28T14:00:00Z')) => JSON.stringify({ type: 'message', timestamp: new Date(ts).toISOString(), message: { role, content, timestamp: ts } });
function putSession(id, lines) {
  const dir = S.sessionsDirFor(repoDir, sessionsBase);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `2026-10-28T10-00-00-000Z_${id}.jsonl`), lines.join('\n') + '\n');
}
const chatOf = (id, opts) => S.readChat(repoDir, id, { base: sessionsBase, ...opts });
const filler = (kb) => msg('toolResult', [text('x'.repeat(kb * 1024))]);

test('S1: a message 200 KB before the end of the file is in the history (it was out of the 64 KB window)', () => {
  putSession('w1', [header('w1', repoDir), msg('user', [text('EARLY')]), filler(200), msg('user', [text('LATE')])]);
  const r = chatOf('w1');
  assert.deepEqual(r.items.map((i) => i.text), ['EARLY', 'LATE']);
  assert.equal(r.truncated, false);
});

test('S1: the window is still bounded: a message 600 KB before the end is out and the history says it is cut', () => {
  putSession('w2', [header('w2', repoDir), msg('user', [text('EARLY')]), filler(300), filler(300), msg('user', [text('LATE')])]);
  const r = chatOf('w2');
  assert.deepEqual(r.items.map((i) => i.text), ['LATE']);
  assert.equal(r.truncated, true);
});

test('S2: an assistant item that reasoned is marked thinking, also when the reasoning came in a tool-only message; the text never leaves', () => {
  putSession('t1', [
    header('t1', repoDir),
    msg('user', [text('go')]),
    msg('assistant', [think('SECRET-ONE'), call('read')]),
    msg('toolResult', [text('r')]),
    msg('assistant', [think('SECRET-TWO'), text('Done.')]),
    msg('user', [text('again')]),
    msg('assistant', [text('Plain.')]),
    msg('assistant', [think('SECRET-THREE'), call('bash')]),
  ]);
  const r = chatOf('t1');
  assert.deepEqual(r.items.map((i) => [i.role, i.text, i.thinking === true]), [
    ['user', 'go', false], ['assistant', 'Done.', true], ['user', 'again', false], ['assistant', 'Plain.', false], ['assistant', '', true],
  ]);
  assert.doesNotMatch(JSON.stringify(r), /SECRET/);
});

test('S2: an assistant item with no reasoning has no thinking field at all (the items of before are unchanged)', () => {
  putSession('t2', [header('t2', repoDir), msg('user', [text('hi')]), msg('assistant', [text('ok')])]);
  assert.deepEqual(chatOf('t2').items.map((i) => Object.keys(i).sort()), [['at', 'role', 'text', 'tools'], ['at', 'role', 'text', 'tools']]);
});

test('S2: a thinking item is drawn with a «thinking…» line, a plain one is drawn as before', () => {
  const html = (items) => R.chatBody({ id: 's1', info: { adopted: { id: 's1', name: 'panel:alpha' }, adoptedFound: true, sessions: [] }, hist: { found: true, items, truncated: false } }, {});
  const withIt = html([{ role: 'assistant', text: 'Done.', at: null, tools: [], thinking: true }]);
  assert.match(withIt, /<div class="tools thought">▸ thinking…<\/div>\s*<div class="m">/);
  assert.doesNotMatch(html([{ role: 'assistant', text: 'Done.', at: null, tools: [] }]), /thinking/);
  // RP171: an item with no text no longer draws its own «working…» (the tail of the thread is the only one, see rp171)
  const bare = html([{ role: 'assistant', text: '', at: null, tools: ['bash'], thinking: true }]);
  assert.match(bare, /thinking…<\/div>\s*<div class="tools">▸ 1 tool · bash<\/div>$/);
  assert.doesNotMatch(bare, /working…/);
});

const rec = (r) => ({ kind: 'event', id: '0123456789', record: r });
const upd = (type, contentIndex = 0, extra = {}) => rec({ type: 'message_update', assistantMessageEvent: { type, contentIndex, ...extra } });

test('S2: live, thinking_start turns the flag on and thinking_end (or the first text, or a new run) turns it off; the text blocks are untouched', () => {
  let e = V.rpcReduce(null, rec({ type: 'agent_start' }), 1).entry;
  assert.equal(e.thinking, false);
  e = V.rpcReduce(e, upd('thinking_start')).entry;
  assert.equal(e.thinking, true);
  e = V.rpcReduce(e, upd('thinking_delta', 0, { delta: 'x' })).entry;
  assert.equal(e.thinking, true);
  assert.equal(e.text, '');
  e = V.rpcReduce(e, upd('thinking_end')).entry;
  assert.equal(e.thinking, false);
  e = V.rpcReduce(e, upd('thinking_start', 1)).entry;
  e = V.rpcReduce(e, upd('text_delta', 2, { delta: 'Hi' })).entry;
  assert.equal(e.thinking, false);
  assert.equal(e.text, 'Hi');
  e = V.rpcReduce(e, upd('thinking_start', 3)).entry;
  assert.equal(V.rpcReduce(e, rec({ type: 'agent_start' }), 2).entry.thinking, false);
  assert.equal(V.rpcReduce(e, rec({ type: 'agent_settled' })).entry.thinking, false);
});

test('S2: live, the tail says «thinking…» while the model reasons and no text has come; with text, the text wins', () => {
  const tail = (rpc) => R.chatBody({ id: 's1', info: { adopted: { id: 's1', name: 'panel:alpha' }, adoptedFound: true, sessions: [] }, hist: { found: true, items: [], truncated: false }, rpc }, {});
  assert.match(tail({ state: 'busy', streaming: true, thinking: true, text: '', asks: [] }), /<div class="m working">thinking…<\/div>/);
  assert.match(tail({ state: 'busy', streaming: true, thinking: false, text: '', asks: [] }), /<div class="m working">working…<\/div>/);
  assert.doesNotMatch(tail({ state: 'busy', streaming: true, thinking: true, text: 'Hello', asks: [] }), /thinking…/);
});
