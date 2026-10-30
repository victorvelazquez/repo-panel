'use strict';
// RP81 (S70): the dialog of an asking session is built from the WHOLE rendered screen (`orca terminal read --screen`), not from the
// 6 lines of `show`, so the title and the first lines of a long command reach the chat card. One extra read per asking terminal, only
// in an ask-aware scan; any failure falls back to the preview of `show` (RP56). Read-only: a fake Orca records every call and a send
// is never expected. The real Orca and the real sessions are never touched.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'rp81-'));
const sessionsBase = path.join(scratch, 'sessions');
const repoDir = path.join(scratch, 'My Repo.Api');
for (const d of [sessionsBase, repoDir]) fs.mkdirSync(d);
const configFile = path.join(scratch, 'config.json');
process.env.REPO_PANEL_CONFIG = configFile;
process.env.REPO_PANEL_SESSIONS_DIR = sessionsBase;
process.env.REPO_PANEL_CASES_FILE = 'off';
test.after(() => fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 5 }));

const lib = require('../lib.js');
const S = require('../server/sessions.js');
const P = require('../server/pi.js');
const { scanSessions, piSessions, piSend } = P;

const REPO_ID = lib.repoId(repoDir);
const REPO = { path: repoDir };
const writeConfig = () => fs.writeFileSync(configFile, JSON.stringify({ port: 4310, groups: [{ name: 'G', repos: [{ path: repoDir }] }], rooms: [] }));

// ---------- fixtures ----------
const NAV = '↑↓ navigate  enter select  escape/ctrl+c cancel';
const SEP = '─'.repeat(110);
const WIDGET = `${' '.repeat(70)}5h 14% ↻11:20 · 7d 6% ↻jue 11:00`;
const TITLE = 'Allow guarded git push?';
const CMD = ['git -C C:\\proj push origin feature/rp81-fullscreen', '  --force-with-lease=feature/rp81-fullscreen:abc1234', '  && git log --oneline -3 | head -n 3'];
const IDLE = '▎ ✿ waiting for input\n▎   type, or / for commands\n▎\n~\\proj (main) • panel:demo\n';
const WORKING = '▎ ❁ working…\n▎   type, or / for commands\n▎\n~\\proj (main) • panel:demo\n';

// Earlier conversation: some rows long, some with trailing spaces, a few blank.
const talk = (n) => Array.from({ length: n }, (_, i) => (i % 9 === 4 ? '' : `${i % 5 === 0 ? 'A long explanation of what the session is doing now, '.repeat(6) : 'row of conversation '}${i}${i % 3 === 0 ? '   ' : ''}`));
// 59 rows: 40 of conversation, blanks, the dialog block, a blank, the separator, the usage widget and blank rows to the bottom.
const dialogBlock = () => [TITLE, ...CMD, '→ Yes', 'No', NAV];
const fullRows = (before = 40) => [...talk(before), '', '', '', '', ...dialogBlock(), '', SEP, WIDGET, '', '', '', '', ''];
// What `show` gives: only the last 6 non-empty lines of the same screen.
const previewOf = (rows) => rows.filter((l) => l.trim()).slice(-6).join('\n');
const ROWS = fullRows();
const PREVIEW = previewOf(ROWS);
const FULL = ROWS.join('\n');
const FALLBACK = lib.piScreenDialog(PREVIEW);
const EXPECTED = lib.piScreenDialog(FULL);

const wt = (handle) => ({ handle, worktreePath: repoDir, connected: true, writable: true });

// A fake Orca recording every call. `terminals[handle]` = { preview, rows, read } where `read` is how the read answers:
// undefined = the rows, 'reject', 'no-terminal', 'no-tail', 'tail-string', 'empty', 'not-strings', 'no-footer', or an explicit answer object.
// After a send the show of every terminal answers WORKING (only the piSend test sends).
function fakeOrca(terminals, { failList = false } = {}) {
  const calls = [];
  let sent = false;
  const orca = async (args) => {
    calls.push(args);
    if (args[0] === 'list') { if (failList) throw new Error('down'); return { terminals: Object.keys(terminals).map(wt) }; }
    const t = terminals[args[2]];
    if (args[0] === 'show') return { terminal: { preview: sent ? WORKING : t.preview } };
    if (args[0] === 'read') {
      const r = t.read;
      if (r === 'reject') throw new Error('read failed');
      if (r === 'no-terminal') return {};
      if (r === 'no-tail') return { terminal: { handle: args[2], status: 'running' } };
      if (r === 'tail-string') return { terminal: { tail: t.rows.join('\n') } };
      if (r === 'empty') return { terminal: { tail: [] } };
      if (r === 'not-strings') return { terminal: { tail: [1, 2, { a: 3 }, null] } };
      if (r === 'no-footer') return { terminal: { tail: talk(59) } };
      if (r && typeof r === 'object') return r;
      return { terminal: { handle: args[2], status: 'running', tail: t.rows, source: 'screen', returnedLineCount: t.rows.length, nextCursor: null } };
    }
    if (args[0] === 'send') { sent = true; return {}; }
    throw new Error(`unexpected ${args[0]}`);
  };
  return {
    orca, calls,
    sends: () => calls.filter((c) => c[0] === 'send'),
    reads: () => calls.filter((c) => c[0] === 'read'),
    names: () => calls.map((c) => c[0]).sort(),
  };
}
const asking = (o = {}) => ({ preview: PREVIEW, rows: ROWS, ...o });
const idle = () => ({ preview: IDLE, rows: [] });
const readArgs = (h) => ['read', '--terminal', h, '--screen', '--limit', '80'];

// ---------- sanity of the fixture (these hold today: they keep the rest honest) ----------
test('fixture: 59 rows; the 6-line preview has neither the title nor the first command lines, the full screen has them', () => {
  assert.equal(ROWS.length, 59);
  assert.ok(lib.piScreenAsk(PREVIEW), 'the preview is already an asking screen');
  assert.equal(FALLBACK.lines.includes(TITLE), false);
  assert.equal(FALLBACK.lines.some((l) => l.includes('push origin')), false);
  for (const l of [TITLE, ...CMD.map((c) => c.trim())]) assert.ok(EXPECTED.lines.includes(l), l);
  assert.equal(EXPECTED.lines.at(-1), NAV);
});

// ---------- 1 + 2. the scan reads the full screen of an asking terminal ----------
test('scanSessions askAware: ONE read per asking terminal with the exact arguments, after the show; the dialog comes from the full screen', async () => {
  const f = fakeOrca({ t1: asking() });
  const { sessions, failed } = await scanSessions(repoDir, f.orca, undefined, false, true);
  assert.equal(failed, 0);
  assert.deepEqual(f.reads(), [readArgs('t1')]);
  assert.deepEqual(f.calls.map((c) => c[0]), ['list', 'show', 'read']);
  assert.deepEqual(f.sends(), []);
  assert.deepEqual(sessions, [{ handle: 't1', state: 'asking', ask: lib.piScreenAsk(PREVIEW).text, dialog: EXPECTED }]);
});

test('the dialog holds the title and the 3 command lines, ends with the footer, selects "→ Yes" and drops the separator and the widget', async () => {
  const f = fakeOrca({ t1: asking() });
  const [s] = (await scanSessions(repoDir, f.orca, undefined, false, true)).sessions;
  const { lines, selected, text } = s.dialog;
  assert.ok(lines.includes(TITLE));
  for (const c of CMD) assert.ok(lines.includes(c.trim()), c);
  assert.equal(lines.at(-1), NAV);
  assert.equal(lines[selected], '→ Yes');
  assert.equal(lines.some((l) => l.includes('─') || /↻/.test(l)), false);
  assert.equal(text, lines.join('\n'));
  assert.ok(lines.indexOf(TITLE) < lines.indexOf(CMD[0].trim()) && lines.indexOf(CMD[2].trim()) < selected);
});

test('at most 40 dialog lines come back even when 200 rows of text precede the dialog', async () => {
  const rows = fullRows(200);
  const f = fakeOrca({ t1: asking({ rows, preview: previewOf(rows) }) });
  const [s] = (await scanSessions(repoDir, f.orca, undefined, false, true)).sessions;
  assert.equal(s.dialog.lines.length, 40);
  assert.equal(s.dialog.lines.at(-1), NAV);
  assert.equal(s.dialog.lines[s.dialog.selected], '→ Yes');
  assert.ok(s.dialog.lines.includes(TITLE));
  assert.deepEqual(s.dialog, lib.piScreenDialog(rows.join('\n')));
});

test('terminals that are not asking get no read: a mixed scan reads only the asking one', async () => {
  const f = fakeOrca({ t1: idle(), t2: asking(), t3: { preview: WORKING, rows: [] } });
  const { sessions } = await scanSessions(repoDir, f.orca, undefined, false, true);
  assert.deepEqual(f.reads(), [readArgs('t2')]);
  assert.deepEqual(f.names(), ['list', 'read', 'show', 'show', 'show']);
  assert.deepEqual(sessions.find((s) => s.handle === 't1'), { handle: 't1', state: 'idle' });
  assert.deepEqual(sessions.find((s) => s.handle === 't3'), { handle: 't3', state: 'busy' });
  assert.equal(sessions.find((s) => s.handle === 't2').state, 'asking');
  assert.deepEqual(f.sends(), []);
});

test('two asking terminals: two reads, one per terminal', async () => {
  const f = fakeOrca({ t1: asking(), t2: asking() });
  await scanSessions(repoDir, f.orca, undefined, false, true);
  assert.deepEqual(f.reads().sort(), [readArgs('t1'), readArgs('t2')]);
});

test('every scan with askAware false makes no read: the asking screen stays busy (rooms), with or without preview', async () => {
  const f = fakeOrca({ t1: asking() });
  assert.deepEqual((await scanSessions(repoDir, f.orca, undefined, false, false)).sessions, [{ handle: 't1', state: 'busy' }]);
  assert.deepEqual((await scanSessions(repoDir, f.orca)).sessions, [{ handle: 't1', state: 'busy' }]);
  const withPreview = await scanSessions(repoDir, f.orca, [wt('t1')], true, false);
  assert.deepEqual(withPreview.sessions, [{ handle: 't1', state: 'busy', preview: PREVIEW }]);
  assert.deepEqual(f.reads(), []);
  assert.deepEqual(f.calls.filter((c) => c[0] !== 'list' && c[0] !== 'show'), []);
});

// ---------- 3. fallbacks ----------
const FALLBACKS = ['reject', 'no-terminal', 'no-tail', 'tail-string', 'empty', 'not-strings', 'no-footer', { terminal: { tail: null } }, { result: 'x' }];
for (const mode of FALLBACKS) {
  test(`fallback (${typeof mode === 'string' ? mode : JSON.stringify(mode)}): never throws, stays asking, the dialog is the one of the show preview`, async () => {
    const f = fakeOrca({ t1: asking({ read: mode }) });
    const { sessions, failed } = await scanSessions(repoDir, f.orca, undefined, false, true);
    assert.equal(failed, 0);
    assert.equal(f.reads().length, 1, 'the read was attempted once');
    assert.deepEqual(sessions, [{ handle: 't1', state: 'asking', ask: lib.piScreenAsk(PREVIEW).text, dialog: FALLBACK }]);
    assert.deepEqual(f.sends(), []);
  });
}

test('a failed read is not a failed terminal: the other asking terminal still gets its full screen', async () => {
  const f = fakeOrca({ t1: asking({ read: 'reject' }), t2: asking() });
  const { sessions, failed } = await scanSessions(repoDir, f.orca, undefined, false, true);
  assert.equal(failed, 0);
  assert.deepEqual(sessions.find((s) => s.handle === 't1').dialog, FALLBACK);
  assert.deepEqual(sessions.find((s) => s.handle === 't2').dialog, EXPECTED);
});

// ---------- 4. the case recorder ----------
function withRecorder(fn) {
  const seen = [];
  P.setCaseRecorder((x) => { seen.push(x); });
  const done = () => P.setCaseRecorder(null);
  return fn(seen).finally(done);
}

test('recorder: an asking terminal is recorded ONCE per scan with the FULL screen text', () => withRecorder(async (seen) => {
  const f = fakeOrca({ t1: asking() });
  await scanSessions(repoDir, f.orca, undefined, false, true);
  assert.deepEqual(seen, [{ folder: repoDir, handle: 't1', state: 'asking', preview: FULL }]);
}));

test('recorder: when the read failed the single record carries the show preview', () => withRecorder(async (seen) => {
  const f = fakeOrca({ t1: asking({ read: 'reject' }) });
  await scanSessions(repoDir, f.orca, undefined, false, true);
  assert.deepEqual(seen, [{ folder: repoDir, handle: 't1', state: 'asking', preview: PREVIEW }]);
}));

test('recorder: non-asking terminals get the show preview and their state as before; no read happens for them', () => withRecorder(async (seen) => {
  const f = fakeOrca({ t1: idle(), t2: { preview: WORKING, rows: [] } });
  await scanSessions(repoDir, f.orca, undefined, false, true);
  assert.deepEqual(seen.sort((a, b) => a.handle.localeCompare(b.handle)), [
    { folder: repoDir, handle: 't1', state: 'idle', preview: IDLE },
    { folder: repoDir, handle: 't2', state: 'busy', preview: WORKING },
  ]);
  assert.deepEqual(f.reads(), []);
}));

test('recorder: a scan without askAware (rooms) records the show preview of the asking screen once, with no read', () => withRecorder(async (seen) => {
  const f = fakeOrca({ t1: asking() });
  await scanSessions(repoDir, f.orca, undefined, false, false);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].preview, PREVIEW);
  assert.deepEqual(f.reads(), []);
}));

test('recorder: a recorder that throws never fails the scan, and the full-screen dialog is still returned', () => withRecorder(async () => {
  P.setCaseRecorder(() => { throw new Error('boom'); });
  const f = fakeOrca({ t1: asking() });
  const { sessions } = await scanSessions(repoDir, f.orca, undefined, false, true);
  assert.deepEqual(sessions[0].dialog, EXPECTED);
}));

// ---------- 5. sessionsState / liveOf ----------
test('sessionsState: one live asking session carries the dialog from the full screen; one read, no send', async () => {
  writeConfig();
  const f = fakeOrca({ t1: asking() });
  const st = await S.sessionsState(REPO_ID, f.orca, sessionsBase);
  assert.deepEqual(st.live, { state: 'waiting', count: 1, dialog: EXPECTED });
  assert.ok(st.live.dialog.lines.includes(TITLE));
  for (const c of CMD) assert.ok(st.live.dialog.lines.includes(c.trim()), c);
  assert.deepEqual(f.names(), ['list', 'read', 'show']);
  assert.deepEqual(f.reads(), [readArgs('t1')]);
  assert.deepEqual(f.sends(), []);
});

test('sessionsState: a failed read keeps the RP56 dialog of the preview', async () => {
  writeConfig();
  const f = fakeOrca({ t1: asking({ read: 'reject' }) });
  const st = await S.sessionsState(REPO_ID, f.orca, sessionsBase);
  assert.deepEqual(st.live, { state: 'waiting', count: 1, dialog: FALLBACK });
  assert.equal(f.reads().length, 1);
  assert.deepEqual(f.sends(), []);
});

test('sessionsState: two live sessions carry no dialog; reads equal the asking terminals scanned; no send', async () => {
  writeConfig();
  const one = fakeOrca({ t1: asking(), t2: idle() });
  assert.deepEqual((await S.sessionsState(REPO_ID, one.orca, sessionsBase)).live, { state: 'waiting', count: 2 });
  assert.equal(one.reads().length, 1);
  assert.deepEqual(one.sends(), []);
  const two = fakeOrca({ t1: asking(), t2: asking() });
  assert.deepEqual((await S.sessionsState(REPO_ID, two.orca, sessionsBase)).live, { state: 'waiting', count: 2 });
  assert.equal(two.reads().length, 2);
  assert.deepEqual(two.sends(), []);
});

test('sessionsState: free, working and none make no read call', async () => {
  writeConfig();
  for (const terminals of [{ t1: idle() }, { t1: { preview: WORKING, rows: [] } }, {}]) {
    const f = fakeOrca(terminals);
    await S.sessionsState(REPO_ID, f.orca, sessionsBase);
    assert.deepEqual(f.reads(), []);
    assert.deepEqual(f.sends(), []);
  }
});

// ---------- 6. cost and priority for the other callers ----------
test('piSessions (askAware) makes no read when the session is idle, one read when it is asking', async () => {
  const quiet = fakeOrca({ t1: idle() });
  assert.deepEqual(await piSessions(REPO, quiet.orca), [{ handle: 't1', state: 'idle' }]);
  assert.deepEqual(quiet.reads(), []);
  const ask = fakeOrca({ t1: asking() });
  const [s] = await piSessions(REPO, ask.orca);
  assert.equal(s.state, 'asking');
  assert.deepEqual(ask.reads(), [readArgs('t1')]);
  assert.deepEqual(ask.sends(), []);
});

test('piSend: an idle session sends as before with no read call', async () => {
  const f = fakeOrca({ t1: idle() });
  assert.deepEqual(await piSend(REPO, 'flow-commit', f.orca, async () => {}), { sent: true, confirmed: true });
  assert.deepEqual(f.reads(), []);
  assert.equal(f.sends().length, 1);
});

test('piSend: an asking session makes the one read and is still refused with the same 409 and nothing sent', async () => {
  const f = fakeOrca({ t1: asking() });
  await assert.rejects(piSend(REPO, 'flow-commit', f.orca, async () => {}), (e) => e.status === 409 && e.message === 'The session is waiting for your answer to a question');
  assert.deepEqual(f.reads(), [readArgs('t1')]);
  assert.deepEqual(f.sends(), []);
  const broken = fakeOrca({ t1: asking({ read: 'reject' }) });
  await assert.rejects(piSend(REPO, 'flow-commit', broken.orca, async () => {}), (e) => e.status === 409 && e.message === 'The session is waiting for your answer to a question');
  assert.deepEqual(broken.sends(), []);
});
