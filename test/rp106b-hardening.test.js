'use strict';
// RP106b, round 2: the three real defects an independent verifier found. D1: a nested quantifier made `redact` cubic on a run like `--pass-token-` (the server's single thread
// froze about 5 s per click). D2: the UPPERCASE_NAME=value layer did not cross CR, CRLF or an ANSI prefix (a `.env` written on Windows). D3: the refusal of `read` took a name with
// spaces or control characters for another tool.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'rp106b-h-'));
const sessionsBase = path.join(scratch, 'sessions');
const repoDir = path.join(scratch, 'My Repo.Api');
for (const d of [sessionsBase, repoDir]) fs.mkdirSync(d);
const configFile = path.join(scratch, 'config.json');
process.env.REPO_PANEL_CONFIG = configFile;
process.env.REPO_PANEL_SESSIONS_DIR = sessionsBase;
test.after(() => fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 5 }));

const lib = require('../lib.js');
const S = require('../server/sessions.js');
const { redact, redactText, resultText, argSummary } = require('../server/redact.js');

const V = 'hunter2secretvalue';
const ms = (fn) => { const t0 = process.hrtime.bigint(); fn(); return Number(process.hrtime.bigint() - t0) / 1e6; };

test('D2: NAME=value loses its value with CRLF, a lone CR, an `export` prefix and an ANSI colour prefix', () => {
  for (const t of [`MYAPP=${V}\r\nB=1`, `A=1\rMYAPP=${V}\rB=2`, `export MYAPP=${V}\r\n`, `\u001b[32mMYAPP=${V}`, `MYAPP=${V}\r`, `\ufeffMYAPP=${V}`, `\u001b[1;31m\u001b[0KMYAPP=${V}`]) {
    assert.ok(!resultText(t).text.includes(V), JSON.stringify(t));
    assert.ok(!redactText(t).includes(V), JSON.stringify(t));
  }
});

test('D2: ordinary output with CRLF and colours keeps its words, with the colours gone and the lines kept', () => {
  assert.equal(resultText('\u001b[32m4 passing\u001b[0m\r\n\u001b[31m0 failing\u001b[0m\r\n').text, '4 passing\n0 failing');
});

test('D1: a pathological flag run is cleaned in bounded time, for the result text and for the patterns', () => {
  for (const unit of ['--pass-token-', '-a-token-', '--key-key-key-', '--a-b-c-d-e-f-g-h-token-', 'x-'.repeat(3), '-token'.repeat(2)]) {
    assert.ok(ms(() => resultText(unit.repeat(Math.ceil(5e6 / unit.length)))) < 250, `${unit} (result)`);
    assert.ok(ms(() => redact(unit.repeat(Math.ceil(5e3 / unit.length)))) < 250, `${unit} (redact)`);
    assert.ok(ms(() => argSummary('grep', { pattern: unit.repeat(Math.ceil(1e6 / unit.length)) })) < 250, `${unit} (argument)`);
  }
});

test('D1: the flags that were cleaned before are still cleaned (the prefix of a flag is at most 4 words)', () => {
  for (const cmd of ['tool --password hunter2x', 'tool --password=hunter2x', 'tool --client-secret hunter2x', 'tool --x-api-key=hunter2x', 'tool --a-b-c-token hunter2x']) {
    assert.ok(!redact(cmd).includes('hunter2x'), cmd);
  }
  assert.equal(redact('tool --monkey hunter2x'), 'tool --monkey hunter2x');
});

test('D1: only the start of a long result is looked at, and a secret that the cut would split never shows half of itself', () => {
  const secretTail = ['gh', 'p_aB3dE6gH9jK2mN5pQ8sT1vW4yZ7bC0eF3hJ6'].join('');
  for (let cut = 1200; cut < 1700; cut += 37) {
    const t = `${'word '.repeat(cut / 5)}${secretTail} and more`;
    assert.ok(!resultText(t).text.includes('ghp_'), `cut ${cut}`);
  }
  assert.ok(resultText('y '.repeat(5e6)).text.length <= 300);
});

// ---------- D3: the refusal of read ----------
const REPO_ID = lib.repoId(repoDir);
const header = (id, cwd) => JSON.stringify({ type: 'session', version: 3, id, timestamp: '2026-10-28T10:00:00.000Z', cwd });
const msg = (role, content, extra = {}) => JSON.stringify({ type: 'message', timestamp: '2026-10-28T14:00:00.000Z', message: { role, content, timestamp: Date.parse('2026-10-28T14:00:00Z'), ...extra } });
function seed(toolName, callName = 'bash') {
  fs.writeFileSync(configFile, JSON.stringify({ groups: [{ name: 'G', repos: [{ path: repoDir }] }], sessions: { [REPO_ID]: { id: 's1', name: 'n', adoptedAt: '2026-10-28T10:00:00.000Z' } }, chat: { showResults: true } }));
  const dir = S.sessionsDirFor(repoDir, sessionsBase);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '2026-10-28T10-00-00-000Z_s1.jsonl'), [
    header('s1', repoDir), msg('user', [{ type: 'text', text: 'go' }]),
    msg('assistant', [{ type: 'toolCall', id: 'c1', name: callName, arguments: {} }]),
    msg('toolResult', [{ type: 'text', text: 'CONTENTS OF A FILE' }], { toolCallId: 'c1', ...(toolName === undefined ? {} : { toolName }), isError: false, durationMs: 1 }),
  ].join('\n') + '\n');
}
const status = (fn) => { try { fn(); return 200; } catch (e) { return e.status; } };
const ask = () => S.chatResult(REPO_ID, 'c1', sessionsBase);

test('D3: a tool name that is read, however it is dressed (spaces, controls, case, full width, zero width), is refused', () => {
  for (const name of ['read', 'Read', 'READ', 'read ', ' read', '\tread', 'read\n', 'read\u0000', 'ｒｅａｄ', 're\u200bad', 'r\u00adead', 'read_file', 'mcp__fs__read_file', 'file-read', 'Read File']) {
    seed(name);
    assert.equal(status(ask), 403, JSON.stringify(name));
  }
});

test('D3: a name with nothing in it, no name or a name that is not text is refused too', () => {
  for (const name of ['   ', '\u0000', '', null, undefined, ['bash'], { x: 1 }, 42]) {
    seed(name);
    assert.equal(status(ask), 403, JSON.stringify(name));
  }
});

test('D3: another tool is still answered, and a name that merely contains the letters is not taken for read', () => {
  for (const name of ['bash', 'grep', 'thread', 'spread', 'Reader', 'already']) {
    seed(name);
    assert.equal(status(ask), 200, name);
  }
});

// ---------- round 3: the gaps the second verifier found (every odd character is written as an escape) ----------
test('D2 (round 3): other line separators and control prefixes do not hide NAME=value', () => {
  for (const t of [`MYAPP=${V}\u2028next`, `A=1\u2029MYAPP=${V}`, `x\u0085MYAPP=${V}`, `\u001b]0;t\u0007MYAPP=${V}`, `\u001b]0;t\u001b\\MYAPP=${V}`, `\u001b(BMYAPP=${V}`, `\u0000MYAPP=${V}`, `\bMYAPP=${V}`,
    `\u009b32mMYAPP=${V}`, `\u001b7MYAPP=${V}`, `x\nMYAPP=${V}\u2028`, `\u000eMYAPP=${V}`, `\u000b\u000cMYAPP=${V}`]) {
    assert.ok(!resultText(t).text.includes(V), JSON.stringify(t));
  }
});

test('D2 (round 3): the shell forms of an assignment lose their value (set, declare -x, $env:, spaces around =), a lowercase name stays as an accepted limit', () => {
  for (const t of [`set X=${V}`, `SET "X=${V}"`, `set MYAPP=${V}`, `declare -x MYAPP=${V}`, `declare -rx MYAPP="${V}"`, `$env:MYAPP="${V}"`, `$env:MYAPP = '${V}'`, `MYAPP = ${V}`, `MYAPP =${V}`]) {
    assert.ok(!resultText(t).text.includes(V), JSON.stringify(t));
  }
  assert.equal(resultText('lowercase=value').text, 'lowercase=value');
});

test('D3 (round 3): read dressed with inner controls, bidi or invisible marks, combining marks, camel case or a long prefix is refused', () => {
  for (const name of ['re\u0000ad', 're\u202ead', 're\u034fad', 're\ufe0fad', 're\u00a0ad', 'r e a d', 'r.e.a.d', 'r\ne\na\nd', 're\u001b[0mad', 're\u0338ad', 'r\u0301ead', 're\u061cad', 're\u180ead', 're\u2064ad',
    'readFile', 'ReadFile', 'readfile', 'mcp__fs__readFile', 'FileRead', 'fileRead', 'ReadManyFiles', 'readMultipleFiles', 'readTextFile', `${'x'.repeat(100)}_read`, `${'x'.repeat(100)}readFile`]) {
    seed(name);
    assert.equal(status(ask), 403, JSON.stringify(name));
  }
});

test('D3 (round 3): ordinary tools whose name merely holds the letters are still answered', () => {
  for (const name of ['bash', 'grep', 'find', 'ls', 'write', 'edit', 'thread', 'spread', 'Reader', 'already', 'unread', 'readable', 'readme', 'readdir', 'reading', 'ready', 'head', 'tread', 'overread', 'bread']) {
    seed(name);
    assert.equal(status(ask), 200, name);
  }
});

// ---------- round 4: the cheap, realistic advisories of the third verifier ----------
test('D2 (round 4): `setx NAME value`, fish `set -x NAME value` and a form feed, a vertical tab or a separator between lines do not hide NAME=value', () => {
  for (const t of [`setx DB_PASS ${V}`, `SETX DB_PASS ${V}`, `set -x DB_PASS ${V}`, `set -gx DB_PASS ${V}`, `SET -x DB_PASS ${V}`, `ok\u000cDB_URL=${V}`, `ok\u000bDB_URL=${V}`, `ok\u001cDB_URL=${V}`, `ok\u001eDB_URL=${V}`]) {
    assert.ok(!resultText(t).text.includes(V), JSON.stringify(t));
  }
  assert.equal(resultText('set the table').text, 'set the table');
});

test('D3 (round 4): tools that return the contents of a file by another name are refused too, and the harmless neighbours are not', () => {
  for (const name of ['cat', 'view', 'slurp', 'view_file', 'ViewFile', 'open_file', 'openFile', 'get_file_contents', 'getFileContents', 'get_file_content', 'fetch_file', 'load_file', 'loadFile', 'show_file', 'display_file', 'print_file', 'dump_file', 'cat_file', 'head_file', 'tail_file', 'open_document', 'file_get_contents']) {
    seed(name);
    assert.equal(status(ask), 403, name);
  }
  for (const name of ['category', 'preview', 'viewer', 'review', 'interview', 'profile', 'filename', 'bash', 'ls', 'find', 'web_search', 'todo']) {
    seed(name);
    assert.equal(status(ask), 200, name);
  }
});
