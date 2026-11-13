'use strict';
// RP105 (S3): a chip per tool in the chat history: ✓/✗, duration and the main argument in one short line, with secrets redacted. The history item keeps
// `tools` (the names) as before and gains `toolInfo`. The abuse tests come first: a secret in an argument, in a result or in the reasoning never leaves the server.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'rp105-'));
const sessionsBase = path.join(scratch, 'sessions');
const repoDir = path.join(scratch, 'My Repo.Api');
for (const d of [sessionsBase, repoDir]) fs.mkdirSync(d);
process.env.REPO_PANEL_CONFIG = path.join(scratch, 'config.json');
process.env.REPO_PANEL_SESSIONS_DIR = sessionsBase;
test.after(() => fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 5 }));

const S = require('../server/sessions.js');
const { redact, argSummary, MAX_ARG } = require('../server/redact.js');
const R = require('../public/resumen.js');

// ---------- the redaction ----------
const SECRETS = {
  'github token': 'gh' + 'p_aB3dE6gH9jK2mN5pQ8sT1vW4yZ7bC0eF3hJ6',
  'github fine-grained': 'gi' + 'thub_pat_11ABCDEFG0aBcDeFgHiJk_lMnOpQrStUvWxYz0123456789',
  'openai-style key': 'sk' + '-proj-aB3dE6gH9jK2mN5pQ8sT1vW4',
  'slack token': 'xo' + 'xb-123456789012-abcdefghijklmnop',
  'aws key id': 'AK' + 'IAIOSFODNN7EXAMPLE',
  'google key': 'AI' + 'zaSyA-aB3dE6gH9jK2mN5pQ8sT1vW4yZ7bC0e',
  'jwt': 'ey' + 'JhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk',
  'long random string': 'Zk8Qw2Lm9Xa4Rt7Vb1Nc5Hd3Jf6Gs0P',
  'long hex': '5f4dcc3b5aa765d61d8327deb882cf995f4dcc3b5aa765d6',
};
for (const [name, secret] of Object.entries(SECRETS)) {
  test(`redact: a ${name} inside a command does not survive`, () => {
    const out = redact(`curl https://api.example.com/v1 --data x=${secret} -o out.json`);
    assert.ok(!out.includes(secret), out);
    assert.ok(!out.includes(secret.slice(0, 16)), out);
  });
}

test('redact: Authorization and Bearer headers lose their value', () => {
  assert.ok(!/abc123SECRET/.test(redact('curl -H "Authorization: Bearer abc123SECRET" https://x.test')));
  assert.ok(!/abc123SECRET/.test(redact("curl -H 'authorization: Basic abc123SECRET' https://x.test")));
  assert.ok(!/abc123SECRET/.test(redact('curl -H "X-Api-Key: abc123SECRET" https://x.test')));
  assert.ok(!/abc123SECRET/.test(redact('Bearer abc123SECRET')));
});

test('redact: the value of a secret flag goes, in both forms, and the flag stays', () => {
  for (const cmd of ['tool --password hunter2x', 'tool --password=hunter2x', 'tool --token hunter2x', 'tool --pass hunter2x', 'tool --api-key=hunter2x', 'tool --client-secret hunter2x']) {
    assert.ok(!redact(cmd).includes('hunter2x'), cmd);
  }
  assert.match(redact('tool --password hunter2x'), /--password/);
});

test('redact: KEY=value of a secret-looking name goes, an ordinary variable stays', () => {
  for (const cmd of ['API_KEY=hunter2x node a.js', 'export GITHUB_TOKEN=hunter2x', 'DB_PASSWORD="hunter2x hunter3y" run', "SECRET_KEY='hunter2x' run", 'PGPASSWORD=hunter2x psql']) {
    const out = redact(cmd);
    assert.ok(!/hunter[23]/.test(out), `${cmd} -> ${out}`);
  }
  assert.equal(redact('NODE_ENV=production node a.js'), 'NODE_ENV=production node a.js');
});

test('redact: credentials in a URL and a private key block go', () => {
  assert.ok(!redact('git clone https://user:hunter2x@github.com/o/r.git').includes('hunter2x'));
  assert.ok(!redact('echo -----BEGIN RSA PRIVATE KEY----- MIIEowIBAAKCAQEA1234567890').includes('MIIEow'));
});

test('redact: ordinary paths, patterns and short words are untouched', () => {
  for (const t of ['C:\\Users\\victor\\Developer\\Tools\\repo-panel\\server\\sessions.js', 'server/rpchost.js', 'toolCall|tool_use|toolResult', 'node --test test/rp104-chat-reach.test.js', 'git log --oneline -3', 'docs/ROADMAP.md']) {
    assert.equal(redact(t), t);
  }
});

test('redact is applied BEFORE the cut: a secret that straddles the limit never shows half of itself', () => {
  const cmd = `${'a'.repeat(MAX_ARG - 10)} ${SECRETS['github token']}`;
  const out = argSummary('bash', { command: cmd });
  assert.ok(!out.includes('ghp_'), out);
  assert.ok(!out.includes('aB3dE6'), out);
});

// ---------- the summary ----------
test('argSummary: the main argument per tool, one line, at most 80 characters', () => {
  assert.equal(argSummary('read', { path: 'server/a.js' }), 'server/a.js');
  assert.equal(argSummary('edit', { path: 'server/a.js', oldText: 'x' }), 'server/a.js');
  assert.equal(argSummary('write', { file_path: 'server/a.js', content: 'SECRET-BODY' }), 'server/a.js');
  assert.equal(argSummary('grep', { pattern: 'toolCall', path: 'server' }), 'toolCall');
  assert.equal(argSummary('find', { pattern: '*.js' }), '*.js');
  assert.equal(argSummary('bash', { command: 'git status\n  --short' }), 'git status --short');
  const long = argSummary('bash', { command: 'x'.repeat(500) });
  assert.ok(long.length <= MAX_ARG && long.endsWith('…'), long);
  assert.equal(argSummary('bash', { command: 'a\tb\r\nc\u0007d' }).includes('\n'), false);
});

test('argSummary: nothing it does not know about leaves, whatever the arguments hold', () => {
  assert.equal(argSummary('mystery', { blob: 'SECRET-BODY', n: 1 }), '');
  assert.equal(argSummary('read', null), '');
  assert.equal(argSummary('read', { path: { x: 1 } }), '');
  assert.equal(argSummary('bash', { command: 42 }), '');
  assert.equal(argSummary(undefined, undefined), '');
});

// ---------- the history ----------
const header = (id, cwd) => JSON.stringify({ type: 'session', version: 3, id, timestamp: '2026-10-28T10:00:00.000Z', cwd });
const text = (t) => ({ type: 'text', text: t });
const call = (name, args = {}, id = `c-${name}`) => ({ type: 'toolCall', id, name, arguments: args });
const msg = (role, content, extra = {}) => JSON.stringify({ type: 'message', timestamp: '2026-10-28T14:00:00.000Z', message: { role, content, timestamp: Date.parse('2026-10-28T14:00:00Z'), ...extra } });
const result = (toolCallId, isError, durationMs, body = 'RESULT-BODY') => msg('toolResult', [text(body)], { toolCallId, toolName: 'x', isError, durationMs });
function putSession(id, lines) {
  const dir = S.sessionsDirFor(repoDir, sessionsBase);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `2026-10-28T10-00-00-000Z_${id}.jsonl`), lines.join('\n') + '\n');
}
const chatOf = (id) => S.readChat(repoDir, id, { base: sessionsBase });

test('S3: toolInfo carries, per tool and in order, name, ok, ms and the redacted argument; `tools` is unchanged', () => {
  putSession('i1', [
    header('i1', repoDir),
    msg('user', [text('go')]),
    msg('assistant', [call('read', { path: 'server/a.js' }, 'r1'), call('bash', { command: 'false' }, 'b1')]),
    result('r1', false, 72), result('b1', true, 2500),
    msg('assistant', [text('Done.'), call('grep', { pattern: 'x' }, 'g1')]),
    result('g1', false, 1234),
  ]);
  const a = chatOf('i1').items[1];
  assert.deepEqual(a.tools, ['read', 'bash', 'grep']);
  assert.deepEqual(a.toolInfo, [
    { name: 'read', ok: true, ms: 72, arg: 'server/a.js', size: 11 },
    { name: 'bash', ok: false, ms: 2500, arg: 'false', size: 11 },
    { name: 'grep', ok: true, ms: 1234, arg: 'x', size: 11 },
  ]);
});

test('S3: a tool with no result yet is ok: null (still running); a result without a duration has ms: null', () => {
  putSession('i2', [header('i2', repoDir), msg('user', [text('go')]), msg('assistant', [call('read', { path: 'a' }, 'r1'), call('bash', { command: 'ls' }, 'b1')]), result('b1', false, undefined)]);
  const t = chatOf('i2').items[1];
  assert.deepEqual(t.toolInfo, [{ name: 'read', ok: null, ms: null, arg: 'a' }, { name: 'bash', ok: true, ms: null, arg: 'ls', size: 11 }]);
});

test('S3 abuse: a secret in an argument, in a result or in the reasoning is nowhere in the answer', () => {
  const tok = SECRETS['github token'];
  putSession('i3', [
    header('i3', repoDir),
    msg('user', [text('go')]),
    msg('assistant', [{ type: 'thinking', thinking: `THOUGHT ${tok}` }, call('bash', { command: `curl -H "Authorization: Bearer ${tok}" --password hunter2x https://x.test`, env: { TOKEN: tok } }, 'b1')]),
    result('b1', false, 5, `RESULT ${tok}`),
    msg('assistant', [text('ok')]),
  ]);
  const wire = JSON.stringify(chatOf('i3'));
  for (const bad of [tok, tok.slice(0, 12), 'hunter2x', 'RESULT', 'THOUGHT']) assert.ok(!wire.includes(bad), `${bad} leaked: ${wire}`);
});

test('S3: an item with no tools has no toolInfo, and a result that matches no call is ignored', () => {
  putSession('i4', [header('i4', repoDir), msg('user', [text('go')]), result('ghost', true, 1), msg('assistant', [text('plain')])]);
  assert.deepEqual(chatOf('i4').items.map((i) => Object.keys(i).sort()), [['at', 'role', 'text', 'tools'], ['at', 'role', 'text', 'tools']]);
});

test('S3: names are capped and cleaned like before, and a malformed call is skipped', () => {
  putSession('i5', [header('i5', repoDir), msg('user', [text('go')]), msg('assistant', [call('bash\nx', { command: 'a' }, 'b1'), { type: 'toolCall' }, call(7, {}, 'z'), text('t')])]);
  const a = chatOf('i5').items[1];
  assert.deepEqual(a.tools, ['bash x']);
  assert.deepEqual(a.toolInfo.map((x) => x.name), ['bash x']);
});

// ---------- the page ----------
const body = (items) => R.chatBody({ id: 's1', info: { adopted: { id: 's1', name: 'panel:alpha' }, adoptedFound: true, sessions: [] }, hist: { found: true, items, truncated: false } }, {});
const info = (o) => ({ name: 'read', ok: true, ms: 72, arg: 'server/a.js', ...o });

test('S3: the chip shows ✓ or ✗, the name, the argument and a short duration; a running tool shows … and no time', () => {
  const html = body([{ role: 'assistant', text: 'Done.', at: null, tools: ['read', 'bash', 'grep', 'ls'], toolInfo: [info(), info({ name: 'bash', ok: false, ms: 2500, arg: 'false' }), info({ name: 'grep', ok: null, ms: null, arg: 'x' }), info({ name: 'ls', ms: 1234, arg: '' })] }]);
  assert.match(html, /<span class="tc ok">✓ <b>read<\/b> <i>server\/a\.js<\/i> <small>72ms<\/small><\/span>/);
  assert.match(html, /<span class="tc bad">✗ <b>bash<\/b> <i>false<\/i> <small>2\.5s<\/small><\/span>/);
  assert.match(html, /<span class="tc run">… <b>grep<\/b> <i>x<\/i><\/span>/);
  assert.match(html, /<span class="tc ok">✓ <b>ls<\/b> <small>1\.2s<\/small><\/span>/);
});

test('S3: everything in a chip is escaped', () => {
  const html = body([{ role: 'assistant', text: 'x', at: null, tools: ['<b>'], toolInfo: [info({ name: '<b>', arg: '<img src=x onerror=alert(1)>' })] }]);
  assert.doesNotMatch(html, /<img/);
  assert.ok(html.includes('<b>&lt;b&gt;</b>'));
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
});

test('S3: more than 12 chips fold into «+N»; durations read 72ms, 1.2s, 1m05s', () => {
  const many = Array.from({ length: 15 }, (_, k) => info({ arg: `f${k}` }));
  const html = body([{ role: 'assistant', text: 'x', at: null, tools: many.map((m) => m.name), toolInfo: many }]);
  assert.equal((html.match(/class="tc /g) || []).length, 12);
  assert.match(html, /\+3/);
  assert.match(body([{ role: 'assistant', text: 'x', at: null, tools: ['a'], toolInfo: [info({ ms: 65000 })] }]), /<small>1m05s<\/small>/);
});

test('S3: an item without toolInfo (an older server, a cached chat) keeps the line of before', () => {
  assert.match(body([{ role: 'assistant', text: 'Taking it.', at: null, tools: ['read', 'grep', 'bash', 'write', 'edit'] }]), /<div class="tools">▸ 5 tools · read, grep, bash \(\+2\)<\/div>\s*<div class="m">/);
});

test('S3: a trailing run with no text still shows its chips (RP171: its own «working…» is gone, the tail of the thread says it)', () => {
  const html = body([{ role: 'assistant', text: '', at: null, tools: ['bash'], toolInfo: [info({ name: 'bash', ok: null, ms: null, arg: 'npm test' })] }]);
  assert.match(html, /class="tc run">… <b>bash<\/b> <i>npm test<\/i><\/span>/);
  assert.doesNotMatch(html, /working…/); // RP171
});

test('S3 abuse: a huge argument is cheap to summarise and a secret at the edge of what is looked at never shows', () => {
  const t0 = Date.now();
  for (const command of ['a'.repeat(1e6), 'A_KEY=x '.repeat(1e5), 'a-'.repeat(5e5), `${' '.repeat(1e6)}x`]) assert.ok(argSummary('bash', { command }).length <= MAX_ARG);
  assert.ok(Date.now() - t0 < 1500, `took ${Date.now() - t0} ms`);
  const tok = SECRETS['github token'];
  for (let cut = 5; cut < tok.length; cut += 3) {
    // the secret starts 5 characters before the 2000-character edge, so the edge cuts it at `cut`
    const out = argSummary('bash', { command: `${'w '.repeat(997)}x ${tok.slice(0, cut)}${' tail'.repeat(50)}` });
    assert.ok(!out.includes('ghp_'), out);
  }
});

// ---------- the allow-list for a shell command (the leaks an independent verifier found in the pattern-only version) ----------
const LEAKS = [
  'curl -u admin:hunter2 https://x.io', 'curl --user admin:hunter2 https://x.io', 'curl -u:hunter2 u', 'mysql -phunter2 db', "mysql -uroot -p'hunter2' db",
  'sshpass -p hunter2 ssh x', 'docker login -p hunter2', "export PW='hun ter2'; run", 'curl -d \'{"password":"hunter2"}\' url', 'curl -d \'{"token": "hunter2"}\' url',
  'echo password: hunter2', 'PASSWORD hunter2 run', 'cat <<EOF\npassword: hunter2\nEOF', 'PASS="hu""nter2" c', "TOKEN=hu'nter2'x c", "TOKEN=$'hunter2 abc' c",
  'secret="a\\"hunter2 b" c', 'token\u200b=hunter2', 'tok\u200ben=hunter2', "curl -H 'X-Custom-Token: hunter2' u", 'curl -H "apikey: hunter2" u', "curl -b 'sid=hunter2' u",
  'curl "https://x.io/?sig=hunter2"', 'curl https://user@x.io:hunter2', 'curl https://x:p@hunter2@z', 'curl https://x:hunter2/ss@z',
  'echo pk' + '_live_hunter2abcdefghijklmnop', 'echo sk' + '_live_hunter2abcdefghijklmnopq', 'echo gl' + 'pat-hunter2abcdefghijklmnop', 'echo np' + 'm_hunter2abcdefghijklmnopqrstuvwxyz0123',
  'echo hunter2hunter2hunter2hunter2', 'aws configure set aws_secret_access_key hunter2/K7MDENG/bPxRfiCYEXAMPLEKEY', 'echo aGVudGVyMnNlY3JldA | base64 -d',
  "echo $(printf '%s' hun)ter2", "echo 'my password is hunter2'", 'echo hunter2', 'printf %s hunter2', 'tool --pass=hunter2 -P hunter2', 'cp a.txt hunter2',
  '/usr/bin/env hunter2=1 run', 'X=hunter2 run', 'curl --data "password=hunter2&u=1" url',
];
test('S3 abuse: none of the secrets a verifier found in a shell command survives, whatever its form', () => {
  for (const command of LEAKS) {
    const out = argSummary('bash', { command });
    assert.ok(!out.includes('hunter2'), `${JSON.stringify(command)} -> ${JSON.stringify(out)}`);
    assert.ok(!/hun.?ter/.test(out), `${JSON.stringify(command)} -> ${JSON.stringify(out)}`);
  }
});

test('S3: a shell command keeps what is safe to know: the program, the subcommand of a known CLI, flag names, paths and hosts', () => {
  const sum = (command) => argSummary('bash', { command });
  assert.equal(sum('git status --short'), 'git status --short');
  assert.equal(sum('npm test'), 'npm test');
  assert.equal(sum('node --test test/rp104-chat-reach.test.js'), 'node --test test/rp104-chat-reach.test.js');
  assert.equal(sum('git log --oneline -3'), 'git log --oneline -3');
  assert.equal(sum('cd C:\\Users\\victor\\repo && git log -n 5'), 'cd C:\\Users\\victor\\repo && git log -n …');
  assert.equal(sum('curl -sS https://api.example.com/v1/users?id=7 -o out.json'), 'curl -sS https://api.example.com/… -o out.json');
  assert.equal(sum('grep -rn foo src | wc -l'), 'grep -rn … | wc -l');
  assert.equal(sum('NODE_ENV=production node a.js'), 'NODE_ENV=… node a.js');
  assert.equal(sum('git commit -m "feat: x"'), 'git commit -m …');
});

test('S3: other arguments: a URL shows only its host, a search query shows nothing, a path is checked for random-looking parts', () => {
  assert.equal(argSummary('fetch_content', { url: 'https://user:hunter2@example.com/a/b?token=hunter2#x' }), 'https://example.com/…');
  assert.equal(argSummary('web_search', { query: 'my password hunter2' }), '');
  assert.equal(argSummary('read', { path: 'docs/Zk8Qw2Lm9Xa4Rt7Vb1Nc5/notes.md' }).includes('Zk8Qw2'), false);
  assert.equal(argSummary('read', { path: 'C:\\Users\\victor\\Developer\\Tools\\repo-panel\\server\\sessions.js' }), 'C:\\Users\\victor\\Developer\\Tools\\repo-panel\\server\\sessions.js');
  assert.equal(argSummary('read', { path: 'tok\u200ben=hunter2x' }).includes('hunter2x'), false);
  assert.equal(argSummary('grep', { pattern: 'toolCall|tool_use' }), 'toolCall|tool_use');
});

test('S3: a duration beyond a week, a negative one or a text one is not a duration (ms: null)', () => {
  putSession('d1', [header('d1', repoDir), msg('user', [text('go')]), msg('assistant', [call('ls', { path: 'a.md' }, 'l1'), call('ls', { path: 'b.md' }, 'l2'), call('ls', { path: 'c.md' }, 'l3')]),
    result('l1', false, 1e300), result('l2', false, -5), result('l3', false, '12')]);
  assert.deepEqual(chatOf('d1').items[1].toolInfo.map((x) => x.ms), [null, null, null]);
});
