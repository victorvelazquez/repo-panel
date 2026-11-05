'use strict';
// RP106: the chip of a tool in the history also carries NUMBERS about its result: `size` (the characters of the result text) and, for an edit, `add` and `del` (the lines
// the diff added and removed). No text of the result or of the diff goes out: the result of a tool is free text, and showing it is RP106b. Temp dirs only.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'rp106-'));
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
const result = (toolCallId, content, details, extra = {}) => msg('toolResult', content, { toolCallId, toolName: 'x', isError: false, durationMs: 5, ...(details === undefined ? {} : { details }), ...extra });
function putSession(id, lines) {
  const dir = S.sessionsDirFor(repoDir, sessionsBase);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `2026-10-28T10-00-00-000Z_${id}.jsonl`), lines.join('\n') + '\n');
}
const chipsOf = (id) => S.readChat(repoDir, id, { base: sessionsBase }).items[1].toolInfo;
const PATCH = ['--- a/x.md', '+++ b/x.md', '@@ -1,4 +1,5 @@', ' keep', '-old one', '-old two', '+new one', '+new two', '+new three', ' keep', '\\ No newline at end of file'].join('\n');

test('size: the characters of the text of the result, summed over its text blocks (and a plain string)', () => {
  putSession('z1', [header('z1', repoDir), msg('user', [text('go')]),
    msg('assistant', [call('bash', { command: 'ls' }, 'b1'), call('read', { path: 'a.md' }, 'r1'), call('ls', { path: 'x' }, 'l1')]),
    result('b1', [text('12345'), text('678')]), result('r1', 'abcd'), result('l1', [{ type: 'image', data: 'XXXX' }])]);
  assert.deepEqual(chipsOf('z1').map((c) => c.size), [8, 4, 0]);
});

test('size: a tool with no result yet has no size', () => {
  putSession('z2', [header('z2', repoDir), msg('user', [text('go')]), msg('assistant', [call('bash', { command: 'ls' }, 'b1')])]);
  assert.equal('size' in chipsOf('z2')[0], false);
});

test('edit: add and del are the lines of the unified diff that start with + or -, without the headers or the «No newline» note', () => {
  putSession('e1', [header('e1', repoDir), msg('user', [text('go')]), msg('assistant', [call('edit', { path: 'x.md' }, 'e1')]), result('e1', [text('Successfully replaced 1 block(s) in x.md.')], { patch: PATCH, diff: '+ 3 shown', firstChangedLine: 3 })]);
  const c = chipsOf('e1')[0];
  assert.deepEqual([c.add, c.del], [3, 2]);
});

test('edit: no patch, a patch that is not a string, or a tool other than edit gives no add or del', () => {
  putSession('e2', [header('e2', repoDir), msg('user', [text('go')]),
    msg('assistant', [call('edit', { path: 'a' }, 'e1'), call('edit', { path: 'b' }, 'e2'), call('write', { path: 'c' }, 'w1'), call('edit', { path: 'd' }, 'e3')]),
    result('e1', [text('ok')], { diff: 'only a diff' }), result('e2', [text('ok')], { patch: 42 }), result('w1', [text('ok')], { patch: PATCH }), result('e3', [text('ok')])]);
  for (const c of chipsOf('e2')) assert.equal('add' in c || 'del' in c, false, JSON.stringify(c));
});

test('edit: a patch with no changed lines counts zero and zero, and a huge one is still cheap', () => {
  const big = ['--- a', '+++ b', '@@ -1 +1 @@', ...Array.from({ length: 8000 }, (_, k) => `${k % 2 ? '+' : '-'}line ${k}`)].join('\n');
  putSession('e3', [header('e3', repoDir), msg('user', [text('go')]), msg('assistant', [call('edit', { path: 'a' }, 'e1'), call('edit', { path: 'b' }, 'e2')]),
    result('e1', [text('ok')], { patch: '--- a\n+++ b\n@@\n context' }), result('e2', [text('ok')], { patch: big })]);
  const t0 = Date.now();
  const [a, b] = chipsOf('e3');
  assert.deepEqual([a.add, a.del, b.add, b.del], [0, 0, 4000, 4000]);
  assert.ok(Date.now() - t0 < 1000);
});

test('abuse: nothing of the text of a result, of a diff or of a patch is in the answer; only integers travel', () => {
  putSession('a1', [header('a1', repoDir), msg('user', [text('go')]),
    msg('assistant', [call('edit', { path: 'x.md', oldText: 'SECRET-OLD', newText: 'SECRET-NEW' }, 'e1'), call('bash', { command: 'cat .env' }, 'b1')]),
    result('e1', [text('replaced SECRET-RESULT')], { patch: '--- a\n+++ b\n-SECRET-DEL\n+SECRET-ADD', diff: '+ 1 SECRET-DIFF', firstChangedLine: 1 }),
    result('b1', [text('API_KEY=SECRET-ENV')])]);
  const items = S.readChat(repoDir, 'a1', { base: sessionsBase }).items;
  assert.doesNotMatch(JSON.stringify(items), /SECRET/);
  for (const c of items[1].toolInfo) for (const k of ['size', 'add', 'del']) if (k in c) assert.ok(Number.isInteger(c[k]) && c[k] >= 0, `${k}=${c[k]}`);
});

// ---------- the page ----------
const body = (items) => R.chatBody({ id: 's1', info: { adopted: { id: 's1', name: 'panel:alpha' }, adoptedFound: true, sessions: [] }, hist: { found: true, items, truncated: false } }, {});
const item = (chip) => [{ role: 'assistant', text: 'x', at: null, tools: [chip.name || 'edit'], toolInfo: [{ name: 'edit', ok: true, ms: 12, arg: 'a.md', ...chip }] }];

test('page: an edit chip shows «+N −M» after its time, and a big result shows its size; a small one shows none', () => {
  assert.match(body(item({ add: 12, del: 3, size: 40 })), /<span class="tc ok">✓ <b>edit<\/b> <i>a\.md<\/i> <small>12ms<\/small> <small class="chg">\+12 −3<\/small><\/span>/);
  assert.match(body(item({ name: 'read', arg: 'a.md', size: 11200 })), /<small>12ms<\/small> <small class="sz">11\.2k chars<\/small><\/span>/);
  assert.match(body(item({ name: 'bash', arg: 'ls', size: 999 })), /<small>12ms<\/small><\/span>/);
  assert.doesNotMatch(body(item({ name: 'bash', arg: 'ls', size: 999 })), /class="sz"/);
});

test('page: an edit that changed nothing (+0 −0) still says so; the size is hidden when the chip has «+N −M»', () => {
  assert.match(body(item({ add: 0, del: 0 })), /<small class="chg">\+0 −0<\/small>/);
  assert.doesNotMatch(body(item({ add: 1, del: 1, size: 50000 })), /class="sz"/);
});

test('page: odd values (a string, a negative number, a fraction, a huge number) draw nothing and never break the chip', () => {
  for (const chip of [{ add: '12', del: '3' }, { add: -1, del: 2 }, { add: 1.5, del: 2 }, { add: 1e12, del: 1 }, { size: '9999' }, { size: -5 }, { size: 1e18 }]) {
    const html = body(item(chip));
    assert.match(html, /class="tc ok"/);
    assert.doesNotMatch(html, /class="chg"|class="sz"|NaN|undefined|e\+/, JSON.stringify(chip));
  }
});

test('page: a chip from an older server (no size, no add) is drawn exactly as before', () => {
  assert.match(body(item({})), /<span class="tc ok">✓ <b>edit<\/b> <i>a\.md<\/i> <small>12ms<\/small><\/span>/);
});
