'use strict';
// RP55 (S49): free text typed into the adopted pi session. Every abuse case asserts that the fake Orca recorded ZERO
// `send` calls. Temp dirs and a fake Orca only: the real Orca and the real sessions are never touched.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const net = require('node:net');

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'rp55-'));
const sessionsBase = path.join(scratch, 'sessions');
const repoDir = path.join(scratch, 'my-repo');
const roomDir = path.join(scratch, 'room-folder');
const repoDir2 = path.join(scratch, 'other-repo');
for (const d of [sessionsBase, repoDir, repoDir2, roomDir]) fs.mkdirSync(d);
const configFile = path.join(scratch, 'config.json');
process.env.REPO_PANEL_CONFIG = configFile;
process.env.REPO_PANEL_SESSIONS_DIR = sessionsBase;
process.env.REPO_PANEL_CASES_FILE = 'off';
test.after(() => fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 5 }));

const lib = require('../lib.js');
const S = require('../server/sessions.js');
const { sanitizeText, sendChat, clearChat, __recentSize } = require('../server/chatsend.js');
const { createServer } = require('../server/http.js');

const REPO_ID = lib.repoId(repoDir);
const REPO_ID2 = lib.repoId(repoDir2);
const NAME = 'panel:my-repo';
const ADOPTED = { id: 'panel-my-repo', name: NAME, adoptedAt: '2026-10-28T10:00:00.000Z' };
const writeConfig = (sessions = { [REPO_ID]: ADOPTED }) => fs.writeFileSync(configFile, JSON.stringify({
  port: 4310, groups: [{ name: 'G', repos: [{ path: repoDir }, { path: repoDir2 }] }], rooms: [{ name: 'Sala Uno', path: roomDir, repos: [] }], sessions,
}));

const footer = (name = NAME) => `~\\Developer\\my-repo (main) • ${name}\n`;
const IDLE = (name) => `▎ ✿ waiting for input\n▎   type, or / for commands\n▎\n${footer(name)}`;
const TYPED = (name) => `▎ ✿ waiting for input\n▎   half written text\n▎\n${footer(name)}`;
const BUSY = (name) => `▎ ❁ working…\n▎   type, or / for commands\n▎\n${footer(name)}`;
const ASKING = '▎ ✿ waiting for input\nAllow guarded git operation?\n↑↓ navigate  enter select  escape/ctrl+c cancel\n';
const term = (o = {}) => ({ handle: 'h1', title: 'Terminal 1', worktreePath: repoDir, connected: true, writable: true, ...o });

// onSend(args, calls) runs after a send is recorded (it can change the screen or write the history).
function fakeOrca({ terminals = [term()], screens = { h1: IDLE() }, failList = false, onSend = () => {} } = {}) {
  const calls = [];
  const orca = async (args) => {
    calls.push(args);
    if (args[0] === 'list') { if (failList) throw new Error('boom'); return { terminals }; }
    if (args[0] === 'show') return { terminal: { preview: screens[args[2]] } };
    if (args[0] === 'send') onSend(args, calls);
    return { send: { accepted: true } };
  };
  return { orca, calls, screens, sends: () => calls.filter((c) => c[0] === 'send') };
}
const noWait = async () => {};
const refuses = async (p, status, re) => assert.rejects(p, (e) => e.status === status && re.test(e.message));
const header = (id) => JSON.stringify({ type: 'session', version: 3, id, timestamp: '2026-10-28T10:00:00.000Z', cwd: repoDir });
const userLine = (t) => JSON.stringify({ type: 'message', message: { role: 'user', content: [{ type: 'text', text: t }], timestamp: 1793232936000 } });
function appendUser(t, id = ADOPTED.id) {
  const dir = S.sessionsDirFor(repoDir, sessionsBase);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `2026-10-28T10-00-00-000Z_${id}.jsonl`);
  if (!fs.existsSync(file)) fs.writeFileSync(file, `${header(id)}\n`);
  fs.appendFileSync(file, `${userLine(t)}\n`);
}
const reset = (sessions) => { fs.rmSync(sessionsBase, { recursive: true, force: true }); fs.mkdirSync(sessionsBase); writeConfig(sessions); };
const deps = (f, extra = {}) => ({ orca: f.orca, wait: noWait, sessionsDir: sessionsBase, ...extra });
let uniq = 0;
const textOf = (a) => { const v = a.find((x) => String(x).startsWith('--text=')); return v === undefined ? undefined : v.slice('--text='.length); };
const fresh = (s = 'hello') => `${s} ${++uniq}`;

// ---------- sanitizeText ----------
test('sanitizeText removes every control character but LF and TAB and normalises line ends', () => {
  assert.equal(sanitizeText('a\r\nb\rc\td'), 'a\nb\nc\td');
  assert.equal(sanitizeText('x\x1b[31mred\x1b[0m'), 'x[31mred[0m');
  assert.equal(sanitizeText('a\x00b\x07c\x7fd\x85e\x9ff'), 'abcdef');
  assert.equal(sanitizeText('a\u2028b\u2029c\u200bd\u200fe\u202af\u202eg\u2066h\u2069i\ufeffj'), 'abcdefghij');
  assert.equal(sanitizeText('  \n hi there \n '), 'hi there');
});

test('sanitizeText neutralises a bracketed-paste terminator: no ESC byte survives', () => {
  const out = sanitizeText('before\x1b[201~! rm -rf x\x1b[200~after');
  assert.equal(out, 'before[201~! rm -rf x[200~after');
  assert.equal(out.includes('\x1b'), false);
});

test('sanitizeText refuses empty, huge, non-string and leading-! texts, never truncating', () => {
  const bad = (v, re) => assert.throws(() => sanitizeText(v), (e) => e.status === 400 && re.test(e.message));
  for (const v of ['', '   ', '\x1b\x00\u200b', '\n\t']) bad(v, /^Write something to send$/);
  for (const v of [1, {}, [], null, undefined, true]) bad(v, /string/);
  bad('x'.repeat(4001), /longer than 4000/);
  assert.equal(sanitizeText('x'.repeat(4000)).length, 4000);
  for (const v of ['!ls', '   !ls', '\x1b!ls', '\u200b!ls', '\n!ls']) bad(v, /^Messages that start with ! run a shell command in pi; type those in the terminal$/);
  assert.equal(sanitizeText('hi !ok'), 'hi !ok');
});

// ---------- sendChat: happy paths ----------
test('sendChat sends exactly one send with the exact vector and reports delivered when the history gains the user item', async () => {
  reset();
  const text = fresh();
  const f = fakeOrca({ onSend: (a) => appendUser(textOf(a)) });
  assert.deepEqual(await sendChat(REPO_ID, { text: `  ${text}\r\n` }, deps(f)), { sent: true, delivered: true, leftInBox: false });
  assert.deepEqual(f.sends(), [['send', '--terminal', 'h1', `--text=${text}`, '--enter']]);
  assert.equal(f.calls.flat().includes('--interrupt'), false);
});

test('a session whose file appears only after the message is delivered; an equal older message does not count', async () => {
  reset();
  const text = fresh('same');
  appendUser(text);
  const f = fakeOrca({ onSend: (a) => appendUser(textOf(a)) });
  assert.equal((await sendChat(REPO_ID, { text }, deps(f))).delivered, true);
  reset();
  const g = fakeOrca({ onSend: (a) => appendUser(textOf(a)) });
  assert.equal((await sendChat(REPO_ID, { text: fresh() }, deps(g))).delivered, true);
});

test('a multi-line text is delivered when the history has it flattened', async () => {
  reset();
  const text = fresh('line one') + '\nline two';
  const f = fakeOrca({ onSend: (a) => appendUser(textOf(a)) });
  assert.equal((await sendChat(REPO_ID, { text }, deps(f))).delivered, true);
});

test('delivered false + leftInBox true when the prompt stays typed; both false when nothing happens; one send, never a resend', async () => {
  reset();
  const waits = [];
  const f = fakeOrca({ onSend: () => { f.screens.h1 = TYPED(); } });
  assert.deepEqual(await sendChat(REPO_ID, { text: fresh() }, deps(f, { wait: async (ms) => { waits.push(ms); } })), { sent: true, delivered: false, leftInBox: true });
  assert.equal(f.sends().length, 1);
  assert.equal(waits.length, 15);
  const g = fakeOrca();
  assert.deepEqual(await sendChat(REPO_ID, { text: fresh() }, deps(g)), { sent: true, delivered: false, leftInBox: false });
  assert.equal(g.sends().length, 1);
});

test('an unnamed adopted session skips the name check', async () => {
  reset({ [REPO_ID]: { id: 'abc', name: 'abc', adoptedAt: '2026-10-28T10:00:00.000Z' } });
  const f = fakeOrca({ screens: { h1: IDLE('other') } });
  assert.equal((await sendChat(REPO_ID, { text: fresh() }, deps(f))).sent, true);
  assert.equal(f.sends().length, 1);
});

// ---------- sendChat: abuse, nothing is sent ----------
test('ESC sequences, CR, NUL, DEL, C1, separators and bidi controls are removed before the text reaches Orca', async () => {
  reset();
  const cases = [
    [`a\x1b[201~b ${uniq++}`, `a[201~b ${uniq - 1}`],
    [`c\r\nd\re\x00\x7f\x85\u2028\u202e\u2066 ${uniq++}`, `c\nd\ne ${uniq - 1}`],
  ];
  for (const [raw, clean] of cases) {
    const f = fakeOrca();
    await sendChat(REPO_ID, { text: raw }, deps(f));
    assert.deepEqual(f.sends(), [['send', '--terminal', 'h1', `--text=${clean}`, '--enter']]);
    assert.equal(f.sends()[0][4].includes('\x1b'), false);
  }
});

test('invalid texts, ids and bodies send nothing', async () => {
  reset();
  const f = fakeOrca();
  for (const t of ['!ls', '  !ls', 'x'.repeat(4001), '', '   ', 5, {}, [], null, undefined]) {
    await assert.rejects(sendChat(REPO_ID, { text: t }, deps(f)), (e) => e.status === 400);
  }
  for (const b of [null, undefined, 'text', 7, [], {}]) await assert.rejects(sendChat(REPO_ID, b, deps(f)), (e) => e.status === 400);
  await refuses(sendChat('room:Sala Uno', { text: 'hi' }, deps(f)), 400, /The room chat is not available yet/);
  await refuses(sendChat('nonexistent01', { text: 'hi' }, deps(f)), 404, /Unknown repository/);
  await assert.rejects(sendChat(undefined, { text: 'hi' }, deps(f)), (e) => e.status === 400);
  assert.equal(f.calls.length, 0);
});

test('no adopted session sends nothing and does not even look at Orca', async () => {
  reset({});
  const f = fakeOrca();
  await refuses(sendChat(REPO_ID, { text: fresh() }, deps(f)), 409, /^Adopt or start a session of this repo first$/);
  assert.equal(f.calls.length, 0);
});

test('no live session, two live sessions, busy, typed, asking, wrong name, failed list: 409/503 and zero sends', async () => {
  reset();
  const table = [
    [{ terminals: [] }, 409, /^No open pi session found for this repo in Orca$/],
    [{ terminals: [term(), term({ handle: 'h2' })], screens: { h1: IDLE(), h2: IDLE() } }, 409, /^Several pi sessions are open for this repo; close the extra ones$/],
    [{ screens: { h1: BUSY() } }, 409, /^The pi session is working; wait until it is free$/],
    [{ screens: { h1: TYPED() } }, 409, /^The pi session already has text typed in its prompt$/],
    [{ screens: { h1: ASKING } }, 409, /^The pi session is waiting for your answer to a question$/],
    [{ screens: { h1: IDLE('panel:other') } }, 409, /^The open pi session is not the adopted one$/],
    [{ screens: { h1: IDLE(`${NAME}-2`) } }, 409, /not the adopted one/],
    [{ screens: { h1: `▎ ✿ waiting for input\n▎   type, or / for commands\n${NAME}\n` } }, 409, /not the adopted one/],
    [{ failList: true }, 503, /^Orca CLI is unavailable or Orca is not running$/],
  ];
  for (const [opts, status, re] of table) {
    const f = fakeOrca(opts);
    await refuses(sendChat(REPO_ID, { text: fresh() }, deps(f)), status, re);
    assert.equal(f.sends().length, 0);
  }
});

test('a terminal whose screen cannot be read next to the session refuses (it could be a second session)', async () => {
  reset();
  const f = fakeOrca({ terminals: [term(), term({ handle: 'h2' })], screens: { h1: IDLE() } });
  const orca = async (a) => { if (a[0] === 'show' && a[2] === 'h2') throw new Error('gone'); return f.orca(a); };
  await refuses(sendChat(REPO_ID, { text: fresh() }, { ...deps(f), orca }), 409, /could not read every terminal/);
  assert.equal(f.sends().length, 0);
});

test('a second concurrent send is refused and only one send reaches Orca', async () => {
  reset();
  const f = fakeOrca();
  let release;
  const gate = new Promise((r) => { release = r; });
  const first = sendChat(REPO_ID, { text: fresh() }, deps(f, { wait: () => gate }));
  await new Promise((r) => setImmediate(r));
  await refuses(sendChat(REPO_ID, { text: fresh('other') }, deps(f)), 409, /^A message is already being sent to this repo$/);
  release();
  await first;
  assert.equal(f.sends().length, 1);
  // the guard is released afterwards
  assert.equal((await sendChat(REPO_ID, { text: fresh() }, deps(fakeOrca()))).sent, true);
});

test('the same text within 5 s is refused (double click) and accepted again after 5 s with an injected clock', async () => {
  reset();
  let t = 1000;
  const now = () => t;
  const text = fresh('dup');
  const f = fakeOrca();
  await sendChat(REPO_ID, { text }, deps(f, { now }));
  t = 5999;
  await refuses(sendChat(REPO_ID, { text }, deps(f, { now })), 409, /just sent/);
  assert.equal(f.sends().length, 1);
  await sendChat(REPO_ID, { text: fresh('different') }, deps(f, { now }));
  t = 6000;
  await sendChat(REPO_ID, { text }, deps(f, { now }));
  assert.equal(f.sends().length, 3);
});

// ---------- clearChat ----------
test('clearChat sends one Ctrl+U without --enter only when text is typed, and reports cleared from the re-read state', async () => {
  reset();
  const f = fakeOrca({ screens: { h1: TYPED() }, onSend: () => { f.screens.h1 = IDLE(); } });
  assert.deepEqual(await clearChat(REPO_ID, deps(f)), { cleared: true });
  assert.deepEqual(f.sends(), [['send', '--terminal', 'h1', '--text=\x15']]);
  const g = fakeOrca({ screens: { h1: TYPED() } });
  assert.deepEqual(await clearChat(REPO_ID, deps(g)), { cleared: false });
  assert.equal(g.sends().length, 1);
});

test('clearChat refuses everything else with zero sends', async () => {
  reset();
  for (const [opts, status, re] of [
    [{ screens: { h1: IDLE() } }, 409, /^There is nothing typed to clear$/],
    [{ screens: { h1: BUSY() } }, 409, /^There is nothing typed to clear$/],
    [{ screens: { h1: ASKING } }, 409, /^There is nothing typed to clear$/],
    [{ terminals: [] }, 409, /No open pi session/],
    [{ terminals: [term(), term({ handle: 'h2' })], screens: { h1: TYPED(), h2: TYPED() } }, 409, /Several pi sessions/],
    [{ screens: { h1: TYPED('panel:other') } }, 409, /not the adopted one/],
    [{ failList: true }, 503, /unavailable/],
  ]) {
    const f = fakeOrca(opts);
    await refuses(clearChat(REPO_ID, deps(f)), status, re);
    assert.equal(f.sends().length, 0);
  }
  await refuses(clearChat('room:Sala Uno', deps(fakeOrca())), 400, /room chat/);
  await refuses(clearChat('nonexistent01', deps(fakeOrca())), 404, /Unknown/);
  reset({});
  await refuses(clearChat(REPO_ID, deps(fakeOrca())), 409, /Adopt or start/);
});

// ---------- routes ----------
const freePort = () => new Promise((resolve) => {
  const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
});
async function withServer(d, fn) {
  const port = await freePort();
  const server = createServer(port, d);
  await new Promise((r) => server.listen(port, '127.0.0.1', r));
  const req = (method, p, { token, body, raw } = {}) => new Promise((resolve, reject) => {
    const payload = raw !== undefined ? raw : body === undefined ? '' : JSON.stringify(body);
    const r = http.request({ host: '127.0.0.1', port, path: p, method, headers: { host: `127.0.0.1:${port}`, ...(token ? { 'x-token': token } : {}) } }, (res) => {
      let t = ''; res.on('data', (c) => { t += c; }); res.on('end', () => resolve({ status: res.statusCode, text: t }));
    });
    r.on('error', reject); r.end(payload);
  });
  try {
    const token = /name="?token"? content="([0-9a-f]+)"/.exec((await req('GET', '/')).text)[1];
    await fn({ req, token });
  } finally { await new Promise((r) => server.close(r)); }
}

test('POST /api/chat/send and /clear: token required, 400 for a bad body, one send for a good one', async () => {
  reset();
  const f = fakeOrca({ onSend: (a) => { if (textOf(a) !== '\x15') appendUser(textOf(a)); } });
  await withServer({ orca: f.orca, wait: noWait }, async ({ req, token }) => {
    const text = fresh('route');
    assert.equal((await req('POST', '/api/chat/send', { body: { id: REPO_ID, text } })).status, 401);
    assert.equal((await req('POST', '/api/chat/clear', { body: { id: REPO_ID } })).status, 401);
    for (const raw of ['not json', '{}', 'null', '[]', '"x"', JSON.stringify({ id: REPO_ID }), JSON.stringify({ text: 'hi' }), JSON.stringify({ id: REPO_ID, text: 5 })]) {
      const r = await req('POST', '/api/chat/send', { token, raw });
      assert.equal(r.status, 400, raw);
    }
    assert.equal((await req('POST', '/api/chat/clear', { token, raw: 'null' })).status, 400);
    assert.equal((await req('POST', '/api/chat/clear', { token, raw: '{}' })).status, 400);
    assert.equal(f.sends().length, 0);
    const ok = await req('POST', '/api/chat/send', { token, body: { id: REPO_ID, text } });
    assert.equal(ok.status, 200);
    assert.deepEqual(JSON.parse(ok.text), { sent: true, delivered: true, leftInBox: false });
    assert.deepEqual(f.sends(), [['send', '--terminal', 'h1', `--text=${text}`, '--enter']]);
    const nothing = await req('POST', '/api/chat/clear', { token, body: { id: REPO_ID } });
    assert.equal(nothing.status, 409);
    assert.equal(f.sends().length, 1);
  });
});

// ---------- RP55 follow-up: text that looks like an Orca option ----------
test('a text that starts with -- reaches orca as the VALUE of --text= and never as an option', async () => {
  for (const raw of ['--enter', '--interrupt', '--interrupt hello', '--terminal', '--foo', '-x', '-']) {
    reset();
    const f = fakeOrca({ onSend: (a) => appendUser(textOf(a)) });
    const r = await sendChat(REPO_ID, { text: raw }, deps(f));
    assert.equal(r.sent, true, raw);
    assert.deepEqual(f.sends(), [['send', '--terminal', 'h1', `--text=${raw}`, '--enter']], raw);
    assert.deepEqual(f.sends()[0].filter((x) => /^--(interrupt|enter|terminal)$/.test(x)), ['--terminal', '--enter'], raw + ': only the two real options in the send');
    assert.equal(f.sends()[0].includes('--text'), false, raw + ': no bare --text left');
  }
});

test('the recent-texts memory is bounded and forgets old entries', async () => {
  reset();
  let clock = 1000;
  const f = fakeOrca({ onSend: (a) => appendUser(textOf(a)) });
  for (let i = 0; i < 60; i++) { clock += 6000; await sendChat(REPO_ID, { text: `distinct text number ${i} ${++uniq}` }, deps(f, { now: () => clock })); }
  assert.equal(f.sends().length, 60);
  assert.ok(__recentSize() <= 50, 'at most 50 remembered texts, got ' + __recentSize());
  clock += 1000;
  const again = textOf(f.sends()[59]);
  await assert.rejects(() => sendChat(REPO_ID, { text: again }, deps(f, { now: () => clock })), (e) => e.status === 409);
});

// ---------- independent verification (RP55): gaps and hardening ----------
const ticks = async (n = 30) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); };

test('the recent-texts memory stays at 50 under a burst inside 5 s', async () => {
  reset();
  const f = fakeOrca();
  for (let i = 0; i < 70; i++) await sendChat(REPO_ID, { text: `burst ${i} ${++uniq}` }, deps(f, { now: () => 1000 + i }));
  assert.equal(f.sends().length, 70);
  assert.ok(__recentSize() <= 50, 'got ' + __recentSize());
});

test('clear is refused while a send is in flight, and a second clear while a clear is in flight', async () => {
  reset();
  const f = fakeOrca();
  let release; const gate = new Promise((r) => { release = r; });
  const first = sendChat(REPO_ID, { text: fresh() }, deps(f, { wait: () => gate }));
  await ticks();
  await refuses(clearChat(REPO_ID, deps(f)), 409, /already being sent/);
  release(); await first;
  const g = fakeOrca({ screens: { h1: TYPED() } });
  let release2; const gate2 = new Promise((r) => { release2 = r; });
  const c1 = clearChat(REPO_ID, deps(g, { wait: () => gate2 }));
  await ticks();
  await refuses(clearChat(REPO_ID, deps(g)), 409, /already being sent/);
  release2(); await c1;
});

test('the same text may go to two different repos inside 5 s (the duplicate key includes the repo)', async () => {
  reset();
  writeConfig({ [REPO_ID]: ADOPTED, [REPO_ID2]: { id: 'panel-other', name: 'panel:other', adoptedAt: ADOPTED.adoptedAt } });
  const text = fresh('shared');
  const f = fakeOrca({ terminals: [term(), term({ handle: 'h2', worktreePath: repoDir2 })], screens: { h1: IDLE(), h2: IDLE('panel:other') } });
  await sendChat(REPO_ID, { text }, deps(f, { now: () => 5000 }));
  await sendChat(REPO_ID2, { text }, deps(f, { now: () => 5001 }));
  assert.equal(f.sends().length, 2);
  await refuses(sendChat(REPO_ID, { text }, deps(f, { now: () => 5002 })), 409, /just sent/);
});

test('the identity is read below the prompt bars: a conversation line that ends with the adopted name does not count', async () => {
  reset();
  const above = `pi said • ${NAME}\n▎ ✿ waiting for input\n▎   type, or / for commands\n▎\n${footer('panel:other')}`;
  const f = fakeOrca({ screens: { h1: above } });
  await refuses(sendChat(REPO_ID, { text: fresh() }, deps(f)), 409, /not the adopted one/);
  assert.equal(f.sends().length, 0);
  const below = `pi said • panel:other\n▎ ✿ waiting for input\n▎   type, or / for commands\n▎\n${footer()}`;
  const g = fakeOrca({ screens: { h1: below }, onSend: (a) => appendUser(textOf(a)) });
  assert.equal((await sendChat(REPO_ID, { text: fresh() }, deps(g))).sent, true);
});

test('a command button (piSend) and the chat exclude each other on the same repo', async () => {
  reset();
  const { findRepo } = require('../server/config.js');
  const { piSend } = require('../server/pi.js');
  const repo = findRepo(REPO_ID);
  const f = fakeOrca();
  let release; const gate = new Promise((r) => { release = r; });
  const cmd = piSend(repo, 'flow-base', f.orca, () => gate);
  await ticks();
  await refuses(sendChat(REPO_ID, { text: fresh() }, deps(f)), 409, /already being sent/);
  release(); await cmd;
  const g = fakeOrca();
  let release2; const gate2 = new Promise((r) => { release2 = r; });
  const msg = sendChat(REPO_ID, { text: fresh() }, deps(g, { wait: () => gate2 }));
  await ticks();
  await assert.rejects(piSend(repo, 'flow-base', g.orca, async () => {}), (e) => e.status === 409);
  release2(); await msg;
});

test('delivery is found even when the history stores the text in another Unicode normalisation form', async () => {
  reset();
  const decomposed = 'cafe\u0301 ' + fresh('nfc');
  const f = fakeOrca({ onSend: (a) => appendUser(textOf(a).normalize('NFC')) });
  assert.equal((await sendChat(REPO_ID, { text: decomposed }, deps(f))).delivered, true);
});

// ---------- guarantees ----------
test('server/chatsend.js never runs a process or writes a file itself', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server', 'chatsend.js'), 'utf8');
  assert.doesNotMatch(src, /\b(execFile|execFileSync|exec|execSync|spawn|spawnSync|fork)\s*\(/);
  assert.doesNotMatch(src, /child_process|node:fs|require\(['"]fs['"]\)|writeFile|appendFile|--interrupt/);
});
