'use strict';
// RP56 (S50, S67): the screen parser behind the question of a session (lib.piScreenDialog), the scan and /api/sessions with a fake Orca that
// records every call. Read-only: NO key is ever sent to a terminal. The card of the chat and the page parts went with RPC2-3 (the card now comes
// from the RPC dialogs, see rpc2-3-*.test.js). The real Orca and the real sessions are never touched.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'rp56-'));
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
const { scanSessions } = require('../server/pi.js');

const REPO_ID = lib.repoId(repoDir);
const writeConfig = () => fs.writeFileSync(configFile, JSON.stringify({ port: 4310, groups: [{ name: 'G', repos: [{ path: repoDir }] }], rooms: [] }));

// ---------- fixtures: screens shaped like the real ones the panel recorded (paths of the machine replaced by C:\proj) ----------
const SEP = '─'.repeat(110);
const USAGE = '5h 15% ↻lun 01:50 · 7d 37% ↻jue 11:00';
const NAV = '↑↓ navigate  enter select  escape/ctrl+c cancel';
const FOOT_B = '↑↓ navigate • Enter select • Esc cancel';
const FOOT_C = '↑↓ move · enter select · tab switch · esc cancel';
const FOOT_E = '↑↓ choose · Enter confirm · Esc cancel · D details';
const screen = (...lines) => lines.join('\n');

const A = screen('Allow guarded git command?', 'git -C C:\\proj fetch origin --prune && git log --oneline -3 | head -n 3', '→ Yes', 'No', NAV, SEP);
const B = screen('What do we do with the stash?', '→ Dejarlo como está', 'No toco el stash y la instalación del panel queda frenada.', 'Aplicar el stash', 'Recupero los cambios guardados y sigo con la entrega.', FOOT_B, SEP);
const B_NO_ARROW = screen('Read-only access to those files, for this session', 'No', 'I stop here and nothing is written', FOOT_B, SEP);
const C = screen('Which database should I use for the tests?', '→ No', 'No leo nada más fuera del repo; frenamos acá', 'Type something.', FOOT_C, SEP);
const D = screen('Run a guarded command?', '→ Allow once', 'Allow for this session', 'Deny', NAV, SEP);
const E = screen('Native review: this change is medium risk', '→ 1. Review this change', '2. Skip this time', '3. Review and allow this session', 'Effect: Reviews only this change; later medium- or high-risk changes ask again, and delivery needs separate approval.', FOOT_E);
const NOT_COMPACT = screen('Warning: Context usage is at 90% (≥ 90%); consider compacting before the next turn.', '⠙ Compacting context... (escape to cancel)', '▎ ✿ waiting for input', '▎   type, or / for commands', '▎');
const NOT_OVERFLOW = screen('↓ Jump to latest message · Ctrl+End', '⠋ Context overflow detected, Auto-compacting... (escape to cancel)', '▎ ✿ implementing…', '▎   type, or / for commands', '▎');
const IDLE = '▎ ✿ waiting for input\n▎   type, or / for commands\n▎\n~\\proj (main) • panel:demo\n';
const WORKING = '▎ ❁ working…\n▎   type, or / for commands\n▎\n~\\proj (main) • panel:demo\n';

// [name, screen, the question line, the footer, the index of the highlighted line]
const DIALOGS = [
  ['A', A, 'Allow guarded git command?', NAV, 2],
  ['B', B, 'What do we do with the stash?', FOOT_B, 1],
  ['C', C, 'Which database should I use for the tests?', FOOT_C, 1],
  ['D', D, 'Run a guarded command?', NAV, 1],
  ['E', E, 'Native review: this change is medium risk', FOOT_E, 1],
];
const NOT_DIALOGS = [['compacting', NOT_COMPACT], ['overflow', NOT_OVERFLOW], ['idle', IDLE], ['working', WORKING], ['plain text', 'just text\nmore text']];
const ALL = [...DIALOGS.map(([n, s]) => [n, s]), ['B without arrow', B_NO_ARROW], ...NOT_DIALOGS];

const dialogOf = (lines, selected) => ({ text: lines.join(String.fromCharCode(10)), lines, selected });
// RP73: the scan now adds `choices` (null here: these sessions have no full-screen read, and these screens have unindented options).
const A_DIALOG = { choices: null, ...dialogOf(['Allow guarded git command?', 'git -C C:\\proj fetch origin --prune && git log --oneline -3 | head -n 3', '→ Yes', 'No', NAV], 2) };
const D_DIALOG = { choices: null, ...dialogOf(['Run a guarded command?', '→ Allow once', 'Allow for this session', 'Deny', NAV], 1) };

// A fake Orca recording every call; `show` answers the screen by handle, anything else (send included) is unexpected.
const wt = (handle) => ({ handle, worktreePath: repoDir, connected: true, writable: true });
function fakeOrca({ screens = {}, failList = false, failShow = false } = {}) {
  const calls = [];
  const orca = async (args) => {
    calls.push(args);
    if (args[0] === 'list') { if (failList) throw new Error('down'); return { terminals: Object.keys(screens).map(wt) }; }
    if (args[0] === 'show') { if (failShow) throw new Error('show failed'); return { terminal: { preview: screens[args[2]] } }; }
    throw new Error(`unexpected ${args[0]}`);
  };
  return { orca, calls, sends: () => calls.filter((c) => c[0] === 'send') };
}

// ---------- 1. lib.piScreenDialog ----------
test('piScreenDialog is null for every non-string and for a screen with no footer of keys', () => {
  assert.equal(typeof lib.piScreenDialog, 'function');
  for (const v of [undefined, null, 5, {}, [], ['a'], true, () => 'x']) assert.equal(lib.piScreenDialog(v), null);
  assert.equal(lib.piScreenDialog(''), null);
  assert.equal(lib.piScreenDialog('just text\nmore text'), null);
  assert.equal(lib.piScreenDialog('→ Yes\nNo\n'), null);
});

test('an "(escape to cancel)" animation line is not a dialog footer: the two compaction screens, idle and working are null', () => {
  assert.equal(typeof lib.piScreenDialog, 'function');
  for (const [name, s] of NOT_DIALOGS) assert.equal(lib.piScreenDialog(s), null, name);
});

test('piScreenDialog(x) is null exactly when piScreenAsk(x) is null, over all the fixtures and the 14-line boundary', () => {
  assert.equal(typeof lib.piScreenDialog, 'function');
  const withAfter = (n) => screen('Allow?', '→ Yes', 'No', NAV, ...Array.from({ length: n }, (_, i) => `after ${i}`));
  const extra = [['13 lines after the footer', withAfter(13)], ['14 lines after the footer', withAfter(14)], ['15 lines after the footer', withAfter(15)], ['footer too long', `${NAV} ${'x'.repeat(200)}`], ['empty', ''], ['spaces', '  \n \n']];
  for (const [name, s] of [...ALL, ...extra]) assert.equal(lib.piScreenDialog(s) === null, lib.piScreenAsk(s) === null, name);
  assert.notEqual(lib.piScreenAsk(withAfter(13)), null);
  assert.notEqual(lib.piScreenDialog(withAfter(13)), null);
  assert.equal(lib.piScreenDialog(withAfter(14)), null);
});

test('piScreenDialog: lines end AT the footer (separator and usage widget are dropped), blank lines go, text is the lines joined', () => {
  const d = lib.piScreenDialog(`\n${A}\n\n   \n${USAGE}\n`);
  assert.deepEqual(d.lines, ['Allow guarded git command?', 'git -C C:\\proj fetch origin --prune && git log --oneline -3 | head -n 3', '→ Yes', 'No', NAV]);
  assert.equal(d.text, d.lines.join('\n'));
  assert.equal(d.selected, 2);
  assert.deepEqual(Object.keys(d).sort(), ['lines', 'selected', 'text']);
});

test('piScreenDialog: control characters become a space, lines are trimmed and cut to 200 characters', () => {
  const d = lib.piScreenDialog(screen('  e\u001b[31mred\u0007x\ty  ', 'z'.repeat(300), '→ Yes', NAV));
  assert.equal(d.lines[0], 'e [31mred x y');
  assert.equal(d.lines[1], 'z'.repeat(200));
  assert.equal(/[\x00-\x1f\x7f-\x9f]/.test(d.text.replace(/\n/g, '')), false);
});

test('piScreenDialog: the last 40 lines up to the footer, the text at most 3000 characters cut from the START', () => {
  const many = Array.from({ length: 60 }, (_, i) => (i === 45 ? '→ arrow here' : `line ${String(i).padStart(2, '0')}`));
  const d = lib.piScreenDialog(screen(...many, NAV, SEP));
  assert.equal(d.lines.length, 40);
  assert.equal(d.lines[0], 'line 21');
  assert.equal(d.lines[39], NAV);
  assert.equal(d.selected, 24);
  assert.equal(d.lines[d.selected], '→ arrow here');
  const wide = screen(...Array.from({ length: 39 }, (_, i) => `${String(i).padStart(2, '0')}${'y'.repeat(98)}`), NAV);
  const w = lib.piScreenDialog(wide);
  assert.equal(w.lines.length, 40);
  assert.equal(w.text.length, 3000);
  assert.equal(w.text, w.lines.join('\n').slice(-3000));
  assert.ok(w.text.endsWith(NAV));
  assert.equal(w.selected, null);
});

test('piScreenDialog: selected is the LAST line starting with an arrow marker followed by a space, else null', () => {
  assert.equal(lib.piScreenDialog(screen('> one', 'two', '→ three', 'four', NAV)).selected, 2);
  assert.equal(lib.piScreenDialog(screen('→ one', '> two', 'three', NAV)).selected, 1);
  assert.equal(lib.piScreenDialog(screen('x', '   → indented', 'y', NAV)).selected, 1);
  assert.equal(lib.piScreenDialog(screen('→no space', '>>> deep', 'a → b', 'quote > here', NAV)).selected, null);
  assert.equal(lib.piScreenDialog(B_NO_ARROW).selected, null);
});

// ---------- 2. scanSessions ----------
test('scanSessions askAware: an asking session keeps its fields and gains dialog; a non-asking one has no dialog field', async () => {
  const f = fakeOrca({ screens: { t1: A, t2: IDLE, t3: WORKING } });
  const { sessions } = await scanSessions(repoDir, f.orca, undefined, false, true);
  const by = Object.fromEntries(sessions.map((s) => [s.handle, s]));
  assert.deepEqual(by.t1, { handle: 't1', state: 'asking', ask: lib.piScreenAsk(A).text, dialog: A_DIALOG });
  assert.deepEqual(by.t2, { handle: 't2', state: 'idle' });
  assert.deepEqual(by.t3, { handle: 't3', state: 'busy' });
  assert.deepEqual(f.sends(), []);
});

test('scanSessions with askAware false changes nothing: the asking screen is still busy, with no ask and no dialog', async () => {
  const f = fakeOrca({ screens: { t1: A } });
  assert.deepEqual((await scanSessions(repoDir, f.orca, undefined, false, false)).sessions, [{ handle: 't1', state: 'busy' }]);
  assert.deepEqual((await scanSessions(repoDir, f.orca)).sessions, [{ handle: 't1', state: 'busy' }]);
});

// ---------- 3. sessionsState ----------
test('sessionsState: dialog only when the state is waiting AND exactly one session is live; no call is a send', async () => {
  writeConfig();
  const one = fakeOrca({ screens: { t1: D } });
  const st = await S.sessionsState(REPO_ID, one.orca, sessionsBase);
  assert.deepEqual(st.live, { state: 'waiting', count: 1, dialog: D_DIALOG });
  assert.deepEqual(Object.keys(st).sort(), ['adopted', 'adoptedFound', 'key', 'live', 'sessions']);
  assert.deepEqual(one.calls.map((c) => c[0]).sort(), ['list', 'read', 'show']);
  assert.deepEqual(one.sends(), []);
});

test('sessionsState: free, working and none carry no dialog; two live sessions (one asking) are ambiguous, so no dialog', async () => {
  writeConfig();
  const live = async (screens) => { const f = fakeOrca({ screens }); const st = await S.sessionsState(REPO_ID, f.orca, sessionsBase); assert.deepEqual(f.sends(), []); return st.live; };
  assert.deepEqual(await live({ t1: IDLE }), { state: 'free', count: 1 });
  assert.deepEqual(await live({ t1: WORKING }), { state: 'working', count: 1 });
  assert.deepEqual(await live({}), { state: 'none', count: 0 });
  assert.deepEqual(await live({ t1: A, t2: IDLE }), { state: 'waiting', count: 2 });
  assert.deepEqual(await live({ t1: A, t2: D }), { state: 'waiting', count: 2 });
});

test('sessionsState: an Orca failure stays unknown with no dialog, and nothing is sent', async () => {
  writeConfig();
  const down = fakeOrca({ screens: { t1: A }, failList: true });
  assert.deepEqual((await S.sessionsState(REPO_ID, down.orca, sessionsBase)).live, { state: 'unknown', count: 0 });
  assert.deepEqual(down.sends(), []);
  const blind = fakeOrca({ screens: { t1: A }, failShow: true });
  assert.deepEqual((await S.sessionsState(REPO_ID, blind.orca, sessionsBase)).live, { state: 'unknown', count: 0 });
  assert.deepEqual(blind.sends(), []);
});

