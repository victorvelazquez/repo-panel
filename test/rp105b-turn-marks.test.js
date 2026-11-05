'use strict';
// RP105b (S3 family): the chat history marks a turn that was stopped or failed (`stop`: «aborted» or «error», from the `stopReason` of the assistant message) and a
// compaction of the context (an item `{ role: 'system', kind: 'compaction' }`). Only the category travels: the `errorMessage` (it can hold the raw body of an API
// answer) and the summary of a compaction never leave the server. Temp dirs only.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'rp105b-'));
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
const call = (name, args = {}, id = `c-${name}`) => ({ type: 'toolCall', id, name, arguments: args });
const msg = (role, content, extra = {}) => JSON.stringify({ type: 'message', timestamp: '2026-10-28T14:00:00.000Z', message: { role, content, timestamp: Date.parse('2026-10-28T14:00:00Z'), ...extra } });
const compaction = (extra = {}) => JSON.stringify({ type: 'compaction', timestamp: '2026-10-28T14:05:00.000Z', summary: 'SECRET-SUMMARY', firstKeptEntryId: 'x', tokensBefore: 12345, ...extra });
function putSession(id, lines) {
  const dir = S.sessionsDirFor(repoDir, sessionsBase);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `2026-10-28T10-00-00-000Z_${id}.jsonl`), lines.join('\n') + '\n');
}
const chatOf = (id) => S.readChat(repoDir, id, { base: sessionsBase });

test('a stopped turn: the item that has text keeps it and gains stop: «aborted»', () => {
  putSession('s1', [header('s1', repoDir), msg('user', [text('go')]), msg('assistant', [text('Partial answer')], { stopReason: 'aborted' })]);
  const a = chatOf('s1').items[1];
  assert.deepEqual([a.role, a.text, a.stop], ['assistant', 'Partial answer', 'aborted']);
});

test('a failed turn with NO text is still an item (it was invisible before), with its tools and stop: «error»; the error message never leaves', () => {
  putSession('s2', [
    header('s2', repoDir), msg('user', [text('go')]),
    msg('assistant', [call('read', { path: 'a.md' }, 'r1')], { stopReason: 'toolUse' }),
    msg('assistant', [], { stopReason: 'error', errorMessage: '400 {"error":{"message":"SECRET-API-BODY key sk-live"}}' }),
  ]);
  const items = chatOf('s2').items;
  assert.deepEqual(items.map((i) => [i.role, i.text, i.stop || null]), [['user', 'go', null], ['assistant', '', 'error']]);
  assert.deepEqual(items[1].tools, ['read']);
  assert.doesNotMatch(JSON.stringify(chatOf('s2')), /SECRET|sk-live|400/);
});

test('a turn that ended normally (stop, toolUse, anything else) has no stop field, and the keys of an item are the ones of before', () => {
  putSession('s3', [header('s3', repoDir), msg('user', [text('go')]), msg('assistant', [text('a')], { stopReason: 'stop' }), msg('assistant', [text('b')], { stopReason: 'toolUse' }), msg('assistant', [text('c')], { stopReason: 'length' }), msg('assistant', [text('d')])]);
  assert.deepEqual(chatOf('s3').items.slice(1).map((i) => Object.keys(i).sort()), Array(4).fill(['at', 'role', 'text', 'tools']));
});

test('a compaction becomes a system item in its place, with its time and none of its summary', () => {
  putSession('s4', [header('s4', repoDir), msg('user', [text('before')]), compaction(), msg('assistant', [text('after')])]);
  const items = chatOf('s4').items;
  assert.deepEqual(items.map((i) => [i.role, i.kind || null, i.text]), [['user', null, 'before'], ['system', 'compaction', ''], ['assistant', null, 'after']]);
  assert.equal(items[1].at, '2026-10-28T14:05:00.000Z');
  assert.deepEqual(items[1].tools, []);
  assert.doesNotMatch(JSON.stringify(chatOf('s4')), /SECRET|12345/);
});

test('a compaction with no time, and a malformed one, do not break the history', () => {
  putSession('s5', [header('s5', repoDir), msg('user', [text('hi')]), JSON.stringify({ type: 'compaction' }), JSON.stringify({ type: 'compaction', timestamp: 'nope' }), msg('assistant', [text('ok')])]);
  assert.deepEqual(chatOf('s5').items.map((i) => [i.role, i.at === null]), [['user', false], ['system', true], ['system', true], ['assistant', false]]);
});

test('tools folded before a compaction stay with the next assistant text', () => {
  putSession('s6', [header('s6', repoDir), msg('user', [text('go')]), msg('assistant', [call('bash', { command: 'ls' }, 'b1')]), compaction(), msg('assistant', [text('done')])]);
  const items = chatOf('s6').items;
  assert.deepEqual(items.map((i) => [i.role, i.tools.length]), [['user', 0], ['system', 0], ['assistant', 1]]);
});

// ---------- the page ----------
const body = (items) => R.chatBody({ id: 's1', info: { adopted: { id: 's1', name: 'panel:alpha' }, adoptedFound: true, sessions: [] }, hist: { found: true, items, truncated: false } }, {});

test('page: a stopped or failed turn gets a note after its message; with no text the note replaces «working…»', () => {
  const withText = body([{ role: 'assistant', text: 'Partial', at: null, tools: [], stop: 'aborted' }]);
  assert.match(withText, /<div class="m">[\s\S]*Partial[\s\S]*<\/div><div class="m stopnote aborted">⏹ Turn stopped<\/div>/);
  const noText = body([{ role: 'assistant', text: '', at: '2026-10-28T14:00:00.000Z', tools: ['bash'], stop: 'error' }]);
  assert.match(noText, /<div class="m stopnote error">⚠ Turn failed<\/div>/);
  assert.doesNotMatch(noText, /working…/);
});

test('page: a trailing run with no stop is still «working…», and an unknown stop value draws nothing', () => {
  assert.match(body([{ role: 'assistant', text: '', at: null, tools: ['bash'] }]), /working…/);
  const odd = body([{ role: 'assistant', text: 'x', at: null, tools: [], stop: '<img onerror=1>' }]);
  assert.doesNotMatch(odd, /stopnote|<img/);
});

test('page: a compaction item is a quiet centered note with its time; an unknown system item draws nothing', () => {
  const html = body([{ role: 'system', kind: 'compaction', text: '', at: '2026-10-28T14:05:00.000Z', tools: [] }]);
  assert.match(html, /<div class="sysnote">↻ Context compacted · \d\d:\d\d<\/div>/);
  assert.match(body([{ role: 'system', kind: 'compaction', text: '', at: null, tools: [] }]), /<div class="sysnote">↻ Context compacted<\/div>/);
  assert.doesNotMatch(body([{ role: 'system', kind: 'whatever', text: 'SECRET', at: null, tools: [] }]), /sysnote|SECRET|class="m"/);
});

test('page: a system item is not taken for a message of the person or of the assistant (the pending-message count ignores it)', () => {
  const html = body([{ role: 'user', text: 'hi', at: null, tools: [] }, { role: 'system', kind: 'compaction', text: '', at: null, tools: [] }, { role: 'assistant', text: 'ok', at: null, tools: [] }]);
  assert.equal((html.match(/class="m me"/g) || []).length, 1);
  assert.equal((html.match(/class="m"/g) || []).length, 1);
});
