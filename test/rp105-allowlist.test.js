'use strict';
// RP105 (S3), second round: the secret forms a SECOND independent verifier found in the first allow-list. A word of a shell command is shown only if it belongs to a
// vocabulary known in advance (a program at the start of a command, a subcommand of a few CLIs, a flag name, a file with a known extension, an absolute path, a URL
// host), a quoted run is one unit, and an operator glued to a word is still an operator.
const test = require('node:test');
const assert = require('node:assert/strict');
const { argSummary } = require('../server/redact.js');

const sum = (command) => argSummary('bash', { command });

const LEAKS2 = [
  '( hunter2 )', '{ hunter2 }', "$x = @'\nhunter2\n'@", 'ls; hunter2', 'x=1 y=2 hunter2', 'FOO=1 hunter2',
  '"C:\\Program Files\\t.exe" hunter2', '& "C:\\Program Files\\t.exe" hunter2',
  'echo "pw | hunter2 x"', 'git commit -m "a ; hunter2 b"', 'echo "x && hunter2 y"', 'echo "my secret /tmp/hunter2 ok"',
  'git commit -m "fix login password Abc.hunter2 and more"', 'curl -H "Authorization: Bearer abc.hunter2 " u',
  'sshpass -p P4ss.hunter2 ssh x', 'mysql -p my.hunter2 db', 'echo Pass.hunter2', 'echo a.hunter2', 'run --hunter2', 'run -123456', 'mysql -pab',
  'set X=hunter2', 'set /p X=hunter2', 'tool -Password hunter2', 'tool /p:hunter2', '$env:TOKEN="hunter2"', 'token=hunter2 run', 'a&&hunter2', 'a;hunter2', '`hunter2`',
  'echo hunter2 | base64', 'cmd /c set P=hunter2', 'C:hunter2', 'echo +hunter2', 'echo =hunter2',
];
test('S3 abuse (2nd verifier): no secret form survives in a shell command', () => {
  for (const command of LEAKS2) {
    const out = sum(command);
    assert.ok(!/hunter/.test(out), `${JSON.stringify(command)} -> ${JSON.stringify(out)}`);
  }
});

test('S3 abuse (2nd verifier): the other tools show no secret in a place where one travels', () => {
  const cases = [
    ['subagent_run', { label: 'password hunter2' }], ['subagent_run', { agent: 'hunter2 x' }], ['read', { path: 'https://hunter2@host/x' }],
    ['write', { path: 'https://u:hunter2@host/x' }], ['fetch_content', { url: 'x://hunter2/' }], ['fetch_content', { url: 'javascript://hunter2/%0a' }],
    ['fetch_content', { url: 'https://user:hunter2@example.com/a?token=hunter2#hunter2' }], ['web_search', { query: 'my password hunter2' }],
  ];
  for (const [name, args] of cases) {
    const out = argSummary(name, args);
    assert.ok(!out.includes('hunter2'), `${name} ${JSON.stringify(args)} -> ${JSON.stringify(out)}`);
  }
});

test('S3: what the allow-list keeps (a known program, a subcommand, flag names, a file, a host) and what a quote or an operator does', () => {
  assert.equal(sum('git status --short'), 'git status --short');
  assert.equal(sum('ls; git log --oneline -3'), 'ls ; git log --oneline -3');
  assert.equal(sum('a&&git status'), '… && git status');
  assert.equal(sum('echo "pw | x" | wc -l'), 'echo … | wc -l');
  assert.equal(sum('cat /tmp/notes.md'), 'cat /tmp/notes.md');
  assert.equal(sum('node scripts/run.js'), 'node scripts/run.js');
  assert.equal(sum('node scripts/run'), 'node …');
  assert.equal(sum('cp a.txt b.txt'), 'cp a.txt b.txt');
  assert.equal(sum('unknowntool --flag file.json'), '… --flag file.json');
  assert.equal(argSummary('subagent_run', { agent: 'flow-commit' }), 'flow-commit');
  assert.equal(argSummary('fetch_content', { url: 'HTTPS://U:P@Ex.COM:8080/x?k=1' }), 'https://Ex.COM:8080/…');
});

test('S3: the limits that are accepted and written in the README: the NAME of an absolute path, a host and a search pattern are shown as they are', () => {
  assert.equal(sum('cat /tmp/notes'), 'cat /tmp/notes');
  assert.equal(argSummary('fetch_content', { url: 'https://example.com/a' }), 'https://example.com/…');
  assert.equal(argSummary('grep', { pattern: 'toolCall' }), 'toolCall');
});

test('S3 (3rd verifier): the subcommand slot takes letters and hyphens only, and a lone backslash is not a root', () => {
  assert.equal(sum('git status'), 'git status');
  assert.equal(sum('docker compose-up'), 'docker compose-up');
  for (const c of ['git hunter2', 'npm hunter2', 'docker hunter2', 'make hunter2', 'npx hunter2', 'gh hunter2', 'git --foo x hunter2', 'echo \\hunter2', 'echo \\p\\a\\s\\s2']) {
    assert.ok(!sum(c).includes('hunter2') && !sum(c).includes('s2'), `${c} -> ${sum(c)}`);
  }
  assert.equal(sum('cd \\\\server\\share'), 'cd \\\\server\\share');
});

test('S3 (3rd verifier): nothing after a quote, a here-string or a substitution exposes a word, and no input is slow', () => {
  for (const c of ['echo hunter2', 'env hunter2', 'sudo hunter2', 'set PASSWORD=hunter2', 'echo "hunter2', 'cat <<< hunter2', 'echo $(cat x)']) assert.ok(!sum(c).includes('hunter2'), c);
  for (const c of ['"'.repeat(1e5), 'a_key='.repeat(5e5), '-'.repeat(1e6)]) { const t = Date.now(); sum(c); assert.ok(Date.now() - t < 500); }
});
