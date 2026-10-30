'use strict';
// RP73 (S70), the server side: answerDialog(id, body, { orca, wait, now }) and POST /api/dialog/answer press keys in the terminal of
// the ONE session that is asking, in a closed loop: one down arrow at a time, a fresh read after each, Enter only with the marker on
// the chosen option, and a check that the dialog changed. The real Orca is never involved: a TERMINAL SIMULATOR (a fake orca whose
// terminal holds a dialog and moves its marker when it receives the bytes of a down arrow) records every call. No test reads a clock:
// `wait` resolves at once and `now` is a number the test moves.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'rp73-'));
const repoDir = path.join(scratch, 'My Repo.Api');
fs.mkdirSync(repoDir);
const configFile = path.join(scratch, 'config.json');
process.env.REPO_PANEL_CONFIG = configFile;
process.env.REPO_PANEL_CASES_FILE = 'off';
process.env.REPO_PANEL_MAX_PARALLEL = '2';
test.after(() => fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 5 }));

const lib = require('../lib.js');
const { piBusy } = require('../server/pi.js');
const { createServer } = require('../server/http.js');

const REPO_ID = lib.repoId(repoDir);
fs.writeFileSync(configFile, JSON.stringify({ port: 4310, groups: [{ name: 'G', repos: [{ path: repoDir }] }], rooms: [] }));

// The module is loaded inside each call, so a missing module fails that test and not the whole file.
const answerDialog = async (...args) => require('../server/dialoganswer.js').answerDialog(...args);

// ---------- fixtures ----------
const NAV = '↑↓ navigate  enter select  escape/ctrl+c cancel';
const SEP = '─'.repeat(40);
const WIDGET = `${' '.repeat(50)}5h 14% ↻11:20 · 7d 6% ↻jue 11:00`;
const TITLE = 'Allow guarded git push?';
const CMD = 'cd C:/proj && git add . && git commit -qm demo && git push -q origin demo-branch';
const IDLE = '▎ ✿ waiting for input\n▎   type, or / for commands\n▎\n~\\proj (main) • panel:demo\n';
const WORKING = '▎ ❁ working…\n▎   type, or / for commands\n▎\n~\\proj (main) • panel:demo\n';
const DOWN = '\x1b[B';
const ENTER = '\r';

// The answer memory of the module lives across tests, so every dialog gets a command of its own.
let seq = 0;
const uniq = () => `${CMD} --run ${++seq}`;
const FOUR = ['Allow once', 'Allow for this session', 'Always allow in this repo', 'Deny'];

// The fingerprint of a dialog, computed here from the spec and not through the code under test.
const fpOf = (questionRows, labels) => crypto.createHash('sha256').update(JSON.stringify([questionRows, labels])).digest('hex').slice(0, 16);

// One simulated terminal. mode: dialog | idle | busy. Knobs: ignoreKeys, jump (rows per down arrow), stayAfterEnter, closeAfterReads,
// onDown(t) / afterEnter(t) hooks, fixedRows (a screen of its own).
function term(o = {}) {
  const t = { mode: 'dialog', talk: ['earlier conversation', 'a few rows of it', ''], question: [TITLE, uniq()], labels: ['Yes', 'No'], marker: 0, jump: 1, downs: 0, enters: 0, pendingReads: null, ...o };
  t.fp = () => fpOf(t.question, t.labels.slice(t.marker));
  t.rows = () => {
    if (t.mode === 'idle') return IDLE.split('\n');
    if (t.mode === 'busy') return WORKING.split('\n');
    if (t.mode === 'shell') return ['PS C:\\proj> git status', 'On branch main', 'nothing to commit, working tree clean', 'PS C:\\proj>']; // a plain shell: NOT a session
    if (t.fixedRows) return t.fixedRows;
    return [...t.talk, ...t.question, ...t.labels.map((l, i) => (i === t.marker ? `→ ${l}` : `  ${l}`)), NAV, '', SEP, WIDGET, '', ''];
  };
  t.preview = () => (t.mode === 'dialog' ? t.rows().filter((l) => l.trim()).slice(-5).join('\n') : t.rows().join('\n'));
  t.close = () => { t.mode = 'idle'; t.pendingReads = null; };
  return t;
}

const ALL_SENDS = [];
function sim(terms = { t1: term() }) {
  if (terms.rows) terms = { t1: terms };
  const calls = [];
  const s = { calls, terms, failList: false, gate: null, throwOnSend: false, readNull: false, readReject: false };
  s.orca = async (args) => {
    calls.push(args);
    if (args[0] === 'send') ALL_SENDS.push(args);
    if (args[0] === 'list') {
      if (s.failList) throw new Error('orca is down');
      if (s.gate) await s.gate.promise;
      return { terminals: Object.keys(terms).map((handle) => ({ handle, worktreePath: repoDir, connected: true, writable: true })) };
    }
    const t = terms[args[2]];
    if (!t) throw new Error(`unknown terminal ${args[2]}`);
    if (args[0] === 'show') return { terminal: { preview: t.preview() } };
    if (args[0] === 'read') {
      if (s.readReject) throw new Error('read failed');
      if (s.readNull) return { terminal: {} };
      if (t.pendingReads !== null) { if (t.pendingReads <= 0) t.close(); else t.pendingReads--; }
      return { terminal: { handle: args[2], status: 'running', tail: t.rows() } };
    }
    if (args[0] === 'send') {
      if (s.throwOnSend) throw new Error('send failed');
      const key = String(args[3]).slice('--text='.length);
      if (key === DOWN) {
        t.downs++;
        if (!t.ignoreKeys) t.marker = Math.min(t.marker + t.jump, t.labels.length - 1);
        if (t.onDown) t.onDown(t);
      } else if (key === ENTER) {
        t.enters++;
        if (!t.stayAfterEnter) {
          if (t.closeAfterReads) t.pendingReads = t.closeAfterReads; else t.close();
          if (t.afterEnter) t.afterEnter(t);
        }
      }
      return {};
    }
    throw new Error(`unexpected ${args[0]}`);
  };
  s.sends = () => calls.filter((c) => c[0] === 'send');
  s.keys = () => s.sends().map((c) => String(c[3]).slice('--text='.length));
  s.t = () => terms.t1;
  return s;
}

function env(o = {}) {
  const e = { waits: [], clock: { t: 1_000_000 }, ...o };
  e.wait = o.wait || (async (ms) => { e.waits.push(ms); });
  e.now = () => e.clock.t;
  return e;
}
// One call of answerDialog against a simulator.
const answer = (s, index, { fingerprint, e = env(), body } = {}) => answerDialog(REPO_ID, body || { fingerprint: fingerprint || s.t().fp(), index }, { orca: s.orca, wait: e.wait, now: e.now });
const refuses = (p, status, message) => assert.rejects(p, (err) => { const got = `${err.status || err.code}: ${err.message}`; assert.equal(err.status, status, got); if (message !== undefined) assert.equal(err.message, message, got); return true; });

// ---------- 1. the answers ----------
test('index 0: ONE Enter and nothing else; the answer says which option was pressed', async () => {
  const s = sim();
  const got = await answer(s, 0);
  assert.deepEqual(got, { answered: true, option: 'Yes' });
  assert.deepEqual(s.keys(), [ENTER]);
  assert.deepEqual(s.sends()[0], ['send', '--terminal', 't1', `--text=${ENTER}`]);
  assert.equal(s.t().mode, 'idle');
});

test('index 1: exactly one down arrow, then Enter', async () => {
  const s = sim({ t1: term({ labels: FOUR }) });
  const got = await answer(s, 1);
  assert.deepEqual(got, { answered: true, option: 'Allow for this session' });
  assert.deepEqual(s.keys(), [DOWN, ENTER]);
  assert.equal(s.t().marker, 1);
});

test('index 2: two down arrows, one read between them, then Enter', async () => {
  const s = sim({ t1: term({ labels: FOUR }) });
  const got = await answer(s, 2);
  assert.deepEqual(got, { answered: true, option: 'Always allow in this repo' });
  assert.deepEqual(s.keys(), [DOWN, DOWN, ENTER]);
  const order = s.calls.map((c) => c[0]).join(' ');
  assert.match(order, /send read send read send/, order);
});

test('the keys are only ever sent to the handle of the asking terminal, one send call per key', async () => {
  // A plain shell of the same worktree is not a session: the asking terminal is still the ONLY live session (two sessions are refused, see below).
  const s = sim({ t1: term({ mode: 'shell' }), t2: term({ labels: FOUR }) });
  await answer(s, 1, { fingerprint: s.terms.t2.fp() });
  assert.equal(s.sends().length, 2);
  for (const c of s.sends()) assert.equal(c[2], 't2');
});

test('a NEGATIVE option is allowed even when the command is cut off (first row and second row)', async () => {
  const cut = (labels) => term({ labels, question: [TITLE, `${uniq()}…`] });
  const a = sim({ t1: cut(['Deny', 'Allow once', 'Allow for this session']) });
  assert.deepEqual(await answer(a, 0), { answered: true, option: 'Deny' });
  assert.deepEqual(a.keys(), [ENTER]);
  const b = sim({ t1: cut(['Allow once', 'Deny', 'Always allow']) });
  assert.deepEqual(await answer(b, 1), { answered: true, option: 'Deny' });
  assert.deepEqual(b.keys(), [DOWN, ENTER]);
});

test('an AFFIRMATIVE option with a cut-off command is refused and nothing is sent', async () => {
  for (const question of [[TITLE, `${uniq()}…`], [TITLE, `${uniq()}...`], []]) {
    const s = sim({ t1: term({ question }) });
    await refuses(answer(s, 0), 409, 'The question is cut off, so the panel will not approve it: use the terminal');
    assert.deepEqual(s.sends(), [], JSON.stringify(question));
  }
});

test('the question changed since the card: refused with zero sends (a different command, and a made-up fingerprint)', async () => {
  const s = sim();
  const stale = fpOf([TITLE, 'git push --force origin main'], ['Yes', 'No']);
  await refuses(answer(s, 0, { fingerprint: stale }), 409, 'The question changed: look at the card again');
  await refuses(answer(s, 0, { fingerprint: '0123456789abcdef' }), 409, 'The question changed: look at the card again');
  assert.deepEqual(s.sends(), []);
});

test('an index beyond the options of the dialog is a 400 with zero sends', async () => {
  const s = sim();
  await refuses(answer(s, 2), 400);
  await refuses(answer(s, 7), 400);
  assert.deepEqual(s.sends(), []);
});

// ---------- 2. the closed loop ----------
test('a NEW question appears after the first down arrow: abort, no Enter, no further key', async () => {
  const s = sim({ t1: term({ labels: FOUR, onDown: (t) => { t.question = ['Run another guarded command?', 'rm something-else']; } }) });
  await refuses(answer(s, 2), 409, 'The selection did not move as expected: nothing was confirmed');
  assert.deepEqual(s.keys(), [DOWN]);
});

test('the terminal ignores the down arrow: abort after that one key, no Enter', async () => {
  const s = sim({ t1: term({ labels: FOUR, ignoreKeys: true }) });
  await refuses(answer(s, 1), 409, 'The selection did not move as expected: nothing was confirmed');
  assert.deepEqual(s.keys(), [DOWN]);
});

test('the marker moves two rows on one key: abort, no Enter', async () => {
  const s = sim({ t1: term({ labels: [...FOUR, 'Review'], jump: 2 }) });
  await refuses(answer(s, 2), 409, 'The selection did not move as expected: nothing was confirmed');
  assert.deepEqual(s.keys(), [DOWN]);
});

test('the dialog disappears after the first key: abort, no Enter', async () => {
  const s = sim({ t1: term({ labels: FOUR, onDown: (t) => t.close() }) });
  await refuses(answer(s, 2), 409, 'The selection did not move as expected: nothing was confirmed');
  assert.deepEqual(s.keys(), [DOWN]);
});

test('a wait between keys is asked of the injected wait, never of a real clock', async () => {
  const s = sim({ t1: term({ labels: FOUR }) });
  const e = env();
  await answer(s, 2, { e });
  assert.ok(e.waits.length >= 2, 'it waited at least once per arrow');
  for (const ms of e.waits) assert.ok(Number.isFinite(ms) && ms >= 0 && ms <= 5000, String(ms));
});

// ---------- 3. verification after Enter ----------
test('Enter sent but the dialog stays: "still open" and exactly one Enter, polled at most 8 times, never resent', async () => {
  const s = sim({ t1: term({ stayAfterEnter: true }) });
  await refuses(answer(s, 0), 409, 'The question is still open: check the terminal');
  assert.deepEqual(s.keys(), [ENTER]);
  const afterEnter = s.calls.slice(s.calls.findIndex((c) => c[0] === 'send') + 1);
  assert.ok(afterEnter.length >= 2 && afterEnter.length <= 8, `reads after Enter: ${afterEnter.length}`);
  for (const c of afterEnter) assert.equal(c[0], 'read');
});

test('the dialog closes a few reads after Enter: confirmed, still one Enter', async () => {
  const s = sim({ t1: term({ closeAfterReads: 3 }) });
  const e = env();
  assert.deepEqual(await answer(s, 0, { e }), { answered: true, option: 'Yes' });
  assert.deepEqual(s.keys(), [ENTER]);
  assert.ok(e.waits.length >= 3);
});

test('another question appears after Enter: the first one counts as answered and no key follows', async () => {
  const s = sim({ t1: term({ afterEnter: (t) => { t.mode = 'dialog'; t.question = ['Allow guarded git fetch?', 'git fetch origin']; t.marker = 0; } }) });
  assert.deepEqual(await answer(s, 0), { answered: true, option: 'Yes' });
  assert.deepEqual(s.keys(), [ENTER]);
});

// ---------- 4. who is asking ----------
test('not asking: an idle session, a busy session and no session all refuse with zero sends', async () => {
  for (const mode of ['idle', 'busy']) {
    const s = sim({ t1: term({ mode }) });
    await refuses(answer(s, 0, { fingerprint: '0123456789abcdef' }), 409, 'The session is not asking anything');
    assert.deepEqual(s.sends(), [], mode);
  }
  const none = sim({});
  await refuses(answer(none, 0, { fingerprint: '0123456789abcdef' }), 409, 'The session is not asking anything');
  assert.deepEqual(none.sends(), []);
});

test('the dialog disappears before the click: "not asking", zero sends', async () => {
  const s = sim();
  const fingerprint = s.t().fp();
  s.t().close();
  await refuses(answer(s, 0, { fingerprint }), 409, 'The session is not asking anything');
  assert.deepEqual(s.sends(), []);
});

test('two live sessions (one asking, or both asking): refused with zero sends', async () => {
  const one = sim({ t1: term(), t2: term({ mode: 'idle' }) });
  await refuses(answer(one, 0), 409, 'Several sessions are open for this repo; close the extra ones');
  assert.deepEqual(one.sends(), []);
  const both = sim({ t1: term(), t2: term() });
  await refuses(answer(both, 0, { fingerprint: both.terms.t1.fp() }), 409, 'Several sessions are open for this repo; close the extra ones');
  assert.deepEqual(both.sends(), []);
});

test('an Orca failure is a 503 with zero sends', async () => {
  const s = sim();
  s.failList = true;
  await refuses(answer(s, 0), 503, 'Orca CLI is unavailable or Orca is not running');
  assert.deepEqual(s.sends(), []);
});

test('the full screen cannot be read (null or a failing read): 409 and zero sends', async () => {
  for (const knob of ['readNull', 'readReject']) {
    const s = sim();
    s[knob] = true;
    await refuses(answer(s, 0), 409, 'The question cannot be read right now');
    assert.deepEqual(s.sends(), [], knob);
  }
});

test('a layout the panel does not recognise (options with descriptions) is refused with zero sends', async () => {
  const fixedRows = [TITLE, '→ Review this change', '    Look at the diff before anything is applied', '  Skip it', '    Leave the change for later', NAV, '', SEP, WIDGET];
  const s = sim({ t1: term({ fixedRows }) });
  await refuses(answer(s, 0, { fingerprint: '0123456789abcdef' }), 409, 'This kind of question cannot be answered from the panel: use the terminal');
  assert.deepEqual(s.sends(), []);
});

// ---------- 5. one answer per question ----------
test('the same question answered less than 10 s ago is refused with zero sends; at 10 s it is allowed again', async () => {
  const question = [TITLE, uniq()];
  const e = env();
  const first = sim({ t1: term({ question }) });
  assert.deepEqual(await answer(first, 0, { e }), { answered: true, option: 'Yes' });
  e.clock.t += 9999;
  const early = sim({ t1: term({ question }) });
  await refuses(answer(early, 0, { e }), 409, 'That question was already answered');
  assert.deepEqual(early.sends(), []);
  e.clock.t += 1;
  const later = sim({ t1: term({ question }) });
  assert.deepEqual(await answer(later, 0, { e }), { answered: true, option: 'Yes' });
  assert.deepEqual(later.keys(), [ENTER]);
});

test('a refused or aborted attempt does not use up the question', async () => {
  const question = [TITLE, uniq()];
  const e = env();
  const bad = sim({ t1: term({ question, labels: FOUR, ignoreKeys: true }) });
  await refuses(answer(bad, 1, { e }), 409, 'The selection did not move as expected: nothing was confirmed');
  const good = sim({ t1: term({ question, labels: FOUR }) });
  assert.deepEqual(await answer(good, 1, { e }), { answered: true, option: 'Allow for this session' });
});

// ---------- 6. the in-flight guard ----------
test('a command already in flight for the repo (the shared piBusy guard): refused with zero Orca calls', async () => {
  const s = sim();
  piBusy.add(repoDir);
  try { await refuses(answer(s, 0), 409, 'A command is already being sent to this repo'); } finally { piBusy.delete(repoDir); }
  assert.deepEqual(s.calls, []);
});

test('concurrent calls for the same repo: one runs, the other is refused, exactly one Enter overall', async () => {
  const s = sim();
  let open;
  s.gate = { promise: new Promise((r) => { open = r; }) };
  const first = answer(s, 0);
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(s.calls.map((c) => c[0]), ['list'], 'the first call is held inside Orca');
  await refuses(answer(s, 0), 409, 'A command is already being sent to this repo');
  assert.deepEqual(s.calls.map((c) => c[0]), ['list'], 'the refused call touched nothing');
  open();
  assert.deepEqual(await first, { answered: true, option: 'Yes' });
  assert.deepEqual(s.keys(), [ENTER]);
});

test('the guard is released after a success, a refusal and a thrown error: a second call runs each time', async () => {
  const q = [TITLE, uniq()];
  const ok = sim({ t1: term({ question: q }) });
  await answer(ok, 0);
  assert.equal(piBusy.has(repoDir), false, 'after a success');

  const idle = sim({ t1: term({ mode: 'idle' }) });
  await refuses(answer(idle, 0, { fingerprint: '0123456789abcdef' }), 409);
  assert.equal(piBusy.has(repoDir), false, 'after a refusal');
  const again = sim({ t1: term({ question: [TITLE, uniq()] }) });
  assert.deepEqual(await answer(again, 0), { answered: true, option: 'Yes' });

  const boom = sim({ t1: term({ question: [TITLE, uniq()], labels: FOUR }) });
  const exploding = env({ wait: async () => { throw new Error('wait exploded'); } });
  await assert.rejects(answer(boom, 1, { e: exploding }));
  assert.equal(piBusy.has(repoDir), false, 'after a thrown error');
  const fresh = sim({ t1: term({ question: boom.t().question, labels: FOUR }) });
  assert.deepEqual(await answer(fresh, 1), { answered: true, option: 'Allow for this session' });
});

// ---------- 7. the body ----------
test('bad bodies are a 400 and not one Orca call', async () => {
  const fp = '0123456789abcdef';
  const bodies = [
    {}, { index: 0 }, { fingerprint: fp }, { fingerprint: 'abc', index: 0 }, { fingerprint: 'z'.repeat(16), index: 0 }, { fingerprint: `${fp}0`, index: 0 },
    { fingerprint: fp.slice(1), index: 0 }, { fingerprint: 5, index: 0 }, { fingerprint: [fp], index: 0 }, { fingerprint: null, index: 0 },
    { fingerprint: fp, index: -1 }, { fingerprint: fp, index: 8 }, { fingerprint: fp, index: 1.5 }, { fingerprint: fp, index: '1' }, { fingerprint: fp, index: [0] },
    { fingerprint: fp, index: null }, { fingerprint: fp, index: NaN }, { fingerprint: fp, index: Infinity },
    { fingerprint: fp, index: 0, text: 'rm -rf /' }, { fingerprint: fp, index: 0, keys: ['\r'] }, { fingerprint: fp, index: 0, command: 'git push' },
    [], [fp, 0], null, undefined, 'fingerprint', 7, true,
  ];
  for (const body of bodies) {
    const s = sim();
    await refuses(answerDialog(REPO_ID, body, { orca: s.orca, wait: env().wait, now: env().now }), 400);
    assert.deepEqual(s.calls, [], JSON.stringify(body));
  }
});

test('the body the page posts (it carries the repo id too) is accepted', async () => {
  const s = sim();
  assert.deepEqual(await answer(s, 0, { body: { id: REPO_ID, fingerprint: s.t().fp(), index: 0 } }), { answered: true, option: 'Yes' });
});

test('a room id is a 400 and an unknown repo is a 404, with zero Orca calls', async () => {
  for (const [id, status] of [['room:x', 400], ['nonexistent01', 404], ['', 400], [undefined, 400], [5, 400]]) {
    const s = sim();
    await refuses(answerDialog(id, { fingerprint: s.t().fp(), index: 0 }, { orca: s.orca, wait: env().wait, now: env().now }), status);
    assert.deepEqual(s.calls, [], String(id));
  }
});

// ---------- 8. source guards ----------
const SRC = path.join(__dirname, '..', 'server', 'dialoganswer.js');

test('source: no Enter flag, no interrupt, no text taken from the body, one fixed key table', () => {
  const src = fs.readFileSync(SRC, 'utf8');
  assert.doesNotMatch(src, /--enter|--interrupt/);
  assert.doesNotMatch(src, /\bbody\.text\b|\bbody\[/);
  for (const line of src.split(/\r?\n/).filter((l) => /--text/.test(l))) assert.doesNotMatch(line, /\bbody\b|\bfingerprint\b|\blabel\b|\boption/, line);
  assert.doesNotMatch(src, /`[^`]*--text=[^`]*\$\{[^}]*(body|label|option)/);
});

test('source: the route never reads text from the request', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server', 'http.js'), 'utf8');
  const line = src.split(/\r?\n/).find((l) => l.includes("'POST /api/dialog/answer'"));
  assert.ok(line, 'the route exists');
  assert.doesNotMatch(line, /\.text\b/);
  assert.match(line, /answerDialog/);
});

// ---------- 9. HTTP ----------
const freePort = () => new Promise((resolve) => {
  const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
});

async function withServer(deps, fn) {
  const port = await freePort();
  const server = createServer(port, deps);
  await new Promise((r) => server.listen(port, '127.0.0.1', r));
  const call = (method, p, token, body) => new Promise((resolve, reject) => {
    const h = { host: `127.0.0.1:${port}`, ...(token ? { 'x-token': token } : {}), 'content-type': 'application/json' };
    const req = http.request({ host: '127.0.0.1', port, path: p, method, headers: h }, (res) => {
      let d = ''; res.on('data', (c) => { d += c; }); res.on('end', () => resolve({ status: res.statusCode, text: d }));
    });
    req.on('error', reject);
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
  try {
    const token = /name="?token"? content="([0-9a-f]+)"/.exec((await call('GET', '/')).text)[1];
    await fn({ call, token });
  } finally { server.close(); server.closeAllConnections(); }
}
const ROUTE = '/api/dialog/answer';

test('HTTP: no token is a 401, a room id a 400, an unknown repo a 404, and none of them reaches Orca', async () => {
  const s = sim();
  await withServer({ orca: s.orca, wait: env().wait }, async ({ call, token }) => {
    const body = { fingerprint: s.t().fp(), index: 0 };
    assert.equal((await call('POST', ROUTE, undefined, { id: REPO_ID, ...body })).status, 401);
    assert.equal((await call('POST', ROUTE, token, { id: 'room:x', ...body })).status, 400);
    assert.equal((await call('POST', ROUTE, token, { id: 'nonexistent01', ...body })).status, 404);
    assert.equal((await call('POST', ROUTE, token, body)).status, 400, 'no id');
  });
  assert.deepEqual(s.calls, []);
});

test('HTTP: a good request answers the dialog; a body with text is a 400 with zero sends; an error carries its message', async () => {
  const s = sim({ t1: term({ labels: FOUR }) });
  await withServer({ orca: s.orca, wait: env().wait }, async ({ call, token }) => {
    const base = { id: REPO_ID, fingerprint: s.t().fp(), index: 1 };
    const withText = await call('POST', ROUTE, token, { ...base, text: 'rm -rf /' });
    assert.equal(withText.status, 400);
    assert.deepEqual(s.sends(), []);
    const ok = await call('POST', ROUTE, token, base);
    assert.equal(ok.status, 200);
    assert.deepEqual(JSON.parse(ok.text), { answered: true, option: 'Allow for this session' });
    assert.deepEqual(s.keys(), [DOWN, ENTER]);
    const again = await call('POST', ROUTE, token, base);
    assert.equal(again.status, 409);
    assert.deepEqual(JSON.parse(again.text), { error: 'The session is not asking anything' });
  });
});

test('HTTP: the route runs in the interactive lane (every answer is recorded as a user priority, never background)', async () => {
  const s = sim();
  await withServer({ orca: s.orca, wait: env().wait }, async ({ call, token }) => {
    await call('POST', ROUTE, token, { id: REPO_ID, fingerprint: s.t().fp(), index: 0 });
    await call('POST', ROUTE, token, { id: REPO_ID, fingerprint: s.t().fp(), index: 0 });
    const perf = JSON.parse((await call('GET', '/api/perf', token)).text);
    const r = perf.routes[`POST ${ROUTE}`];
    assert.ok(r, 'the route is recorded under its own name');
    assert.equal(r.priorities.user, 2);
    assert.equal(r.priorities.background, undefined);
  });
});

// ---------- 10. the closing guard: the same two byte strings in every test ----------
test('over ALL the tests of this file, every send is exactly [send, --terminal, <handle>, --text=<down or enter>]', () => {
  assert.ok(ALL_SENDS.length >= 10, `the simulator recorded the sends (${ALL_SENDS.length})`);
  for (const args of ALL_SENDS) {
    assert.equal(args.length, 4, JSON.stringify(args));
    assert.deepEqual(args.slice(0, 3), ['send', '--terminal', args[2]]);
    assert.match(args[2], /^t[12]$/);
    assert.ok(args[3] === `--text=${DOWN}` || args[3] === `--text=${ENTER}`, JSON.stringify(args));
  }
});

// ---------- 11. the LAST option (parent decision: reads after a key accept a single option) ----------
test('the LAST option can be answered: Yes/No, "No" (down, Enter)', async () => {
  const s = sim({ t1: term({ question: [TITLE, `${uniq()}…`] }) });
  assert.deepEqual(await answer(s, 1), { answered: true, option: 'No' });
  assert.deepEqual(s.keys(), [DOWN, ENTER]);
});

test('the LAST option can be answered: Allow once / Allow for this session / Deny, "Deny" (down, down, Enter)', async () => {
  const s = sim({ t1: term({ labels: ['Allow once', 'Allow for this session', 'Deny'] }) });
  assert.deepEqual(await answer(s, 2), { answered: true, option: 'Deny' });
  assert.deepEqual(s.keys(), [DOWN, DOWN, ENTER]);
});

test('the card never offers a list that starts with ONE option (the first read needs 2 to 8)', async () => {
  const s = sim({ t1: term({ labels: ['Yes', 'No'], marker: 1 }) });
  await refuses(answer(s, 0, { fingerprint: '0123456789abcdef' }), 409, 'This kind of question cannot be answered from the panel: use the terminal');
  assert.deepEqual(s.sends(), []);
});

// ---------- 12. step 9: up to 8 reads after Enter, stopping at the first that confirms ----------
test('Enter: the dialog closes on the 8th read counts as confirmed; on a 9th it does not (still open)', async () => {
  const late = sim({ t1: term({ closeAfterReads: 7 }) });
  assert.deepEqual(await answer(late, 0), { answered: true, option: 'Yes' });
  const tooLate = sim({ t1: term({ closeAfterReads: 8 }) });
  await refuses(answer(tooLate, 0), 409, 'The question is still open: check the terminal');
  assert.deepEqual(tooLate.keys(), [ENTER]);
  assert.equal(tooLate.calls.slice(tooLate.calls.findIndex((c) => c[0] === 'send') + 1).length, 8);
});

test('Enter: the polling stops at the first read that confirms', async () => {
  const s = sim({ t1: term({ closeAfterReads: 1 }) });
  await answer(s, 0);
  assert.equal(s.calls.slice(s.calls.findIndex((c) => c[0] === 'send') + 1).length, 2);
});

test('Enter: a screen that still shows a footer but no list the panel can read is NOT a confirmation', async () => {
  const s = sim({ t1: term({ labels: FOUR, afterEnter: (t) => { t.mode = 'dialog'; t.fixedRows = [TITLE, 'Yes', 'No', NAV]; } }) });
  await refuses(answer(s, 1), 409, 'The question is still open: check the terminal');
  assert.deepEqual(s.keys(), [DOWN, ENTER]);
});

// ---------- 13. dialog.choices reaches the page through sessionsState ----------
const sessionsState = (...a) => require('../server/sessions.js').sessionsState(...a);
const liveOfSim = async (s) => (await sessionsState(REPO_ID, s.orca, scratch)).live;

test('sessionsState: the asking session carries live.dialog.choices (fingerprint, options with tone, complete) for the page', async () => {
  const s = sim({ t1: term({ labels: FOUR }) });
  const live = await liveOfSim(s);
  assert.equal(live.state, 'waiting');
  assert.deepEqual(live.dialog.choices, {
    fingerprint: s.t().fp(),
    options: [{ label: 'Allow once', tone: 'affirmative' }, { label: 'Allow for this session', tone: 'affirmative' }, { label: 'Always allow in this repo', tone: 'affirmative' }, { label: 'Deny', tone: 'negative' }],
    complete: true,
    markerRow: 5,
    questionRows: s.t().question,
  });
  assert.deepEqual(JSON.parse(JSON.stringify(live.dialog.choices)), live.dialog.choices, 'nothing but plain data crosses JSON');
  assert.ok(Array.isArray(live.dialog.lines), 'the lines of the card stay');
});

test('sessionsState: a cut command gives complete false; a description layout or an unreadable full screen gives choices null', async () => {
  const cut = await liveOfSim(sim({ t1: term({ question: [TITLE, `${uniq()}…`] }) }));
  assert.equal(cut.dialog.choices.complete, false);
  const fixedRows = [TITLE, '→ Review this change', '    Look at the diff before anything is applied', '  Skip it', '    Leave the change for later', NAV, '', SEP, WIDGET];
  const description = await liveOfSim(sim({ t1: term({ fixedRows }) }));
  assert.equal(description.state, 'waiting');
  assert.equal(description.dialog.choices, null);
  for (const knob of ['readNull', 'readReject']) {
    const s = sim();
    s[knob] = true;
    const live = await liveOfSim(s);
    assert.equal(live.state, 'waiting', knob);
    assert.equal(live.dialog.choices, null, knob);
  }
});

test('sessionsState: two open sessions give no dialog and so no choices', async () => {
  const live = await liveOfSim(sim({ t1: term(), t2: term() }));
  assert.equal(live.count, 2);
  assert.equal(live.dialog, undefined);
  const idle = await liveOfSim(sim({ t1: term({ mode: 'idle' }) }));
  assert.equal(idle.dialog, undefined);
});

// ---------- hardening after the independent verification of RP73 ----------
test('a failing Enter still uses up the question: a second attempt is refused and no second Enter follows', async () => {
  const s = sim();
  const e = env();
  const fp = s.t().fp();
  const orig = s.orca;
  let fail = true;
  s.orca = async (a) => { if (fail && a[0] === 'send' && a[3] === `--text=${ENTER}`) throw new Error('send failed'); return orig(a); };
  await assert.rejects(answer(s, 0, { fingerprint: fp, e }));
  fail = false;
  await refuses(answer(s, 0, { fingerprint: fp, e }), 409, 'That question was already answered');
  assert.equal(s.keys().filter((k) => k === ENTER).length, 0, 'no Enter ever reached the terminal');
});

test('a terminal of the repo whose show fails is unknown, not absent: refused with zero sends', async () => {
  const s = sim({ t1: term(), t2: term() });
  const orig = s.orca;
  s.orca = async (a) => { if (a[0] === 'show' && a[2] === 't2') throw new Error('show failed'); return orig(a); };
  await refuses(answer(s, 0, { fingerprint: s.t().fp() }), 409);
  assert.deepEqual(s.keys(), []);
});

test('the answer is confirmed only when the dialog is gone or another question (another title) took its place', async () => {
  // Same question still there but scrolled by one row (the Enter was ignored): NOT confirmed.
  const scrolled = sim({ t1: term({ stayAfterEnter: true }) });
  const e1 = env();
  const orig = scrolled.orca;
  let after = false;
  scrolled.orca = async (a) => {
    if (a[0] === 'send' && a[3] === `--text=${ENTER}`) after = true;
    const r = await orig(a);
    if (after && a[0] === 'read') return { terminal: { tail: ['one more row of output', ...r.terminal.tail] } };
    return r;
  };
  await refuses(answer(scrolled, 0, { e: e1 }), 409, 'The question is still open: check the terminal');
  // Same title, a different command, in the same place: the question changed under the person, not confirmed either.
  const same = sim({ t1: term({ afterEnter: (t) => { t.question = [TITLE, uniq()]; t.marker = 0; t.mode = 'dialog'; } }) });
  await refuses(answer(same, 0), 409, 'The question is still open: check the terminal');
  // Another title: the first question is over.
  const other = sim({ t1: term({ afterEnter: (t) => { t.question = ['Allow guarded git fetch?', 'git fetch origin']; t.marker = 0; t.mode = 'dialog'; } }) });
  assert.equal((await answer(other, 0)).answered, true);
  // Gone: confirmed.
  assert.equal((await answer(sim(), 0)).answered, true);
});

test('the duplicate guard is per repo and per question: the key carries the repo', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server', 'dialoganswer.js'), 'utf8');
  assert.match(src, /repo\.path\}\|\$\{fingerprint\}|\$\{repo\.path\}.*\$\{fingerprint\}|repo\.path \+ ['"]\|['"] \+ fingerprint/, 'the answered map is keyed by repo and fingerprint');
});
