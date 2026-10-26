'use strict';
// RP32 B: piScreenAsk recognises the family of selection-dialog footers, not only `Enter confirm  Esc cancel`.
const test = require('node:test');
const assert = require('node:assert/strict');
const lib = require('../lib.js');
const { piStatus, scanSessions } = require('../server/pi.js');

const GUARDED = [
  'rdd running · start',
  '',
  'Allow guarded git operation?',
  '  The agent wants to run a guarded command.',
  '→ Yes',
  '  No',
  '',
  '↑↓ navigate  enter select  escape/ctrl+c cancel',
  '',
].join('\n');
const RP20 = [
  'Review consent',
  '→ 1. Review this change',
  '  2. Skip this time',
  '',
  'Enter confirm  Esc cancel',
].join('\n');
const IDLE_BAR = '▎ ✿ waiting for input\n▎   type, or / for commands\n▎\n';
const WORKING_BAR = '▎ ❁ working…\n▎   type, or / for commands\n▎\n';

test('piScreenAsk: the `Allow guarded ...?` dialog with the navigate/select/escape footer is asking', () => {
  const a = lib.piScreenAsk(GUARDED);
  assert.ok(a);
  assert.match(a.text, /Allow guarded git operation\?/);
  assert.match(a.text, /enter select {2}escape\/ctrl\+c cancel/);
  assert.ok(lib.piScreenAsk(GUARDED + WORKING_BAR));
  assert.ok(lib.piScreenAsk(GUARDED + IDLE_BAR));
});

test('piScreenAsk: the old `Enter confirm  Esc cancel` footer returns the same { text } as before', () => {
  const NL = String.fromCharCode(10);
  assert.deepEqual(lib.piScreenAsk(RP20), { text: RP20.split(NL).map((l) => l.trim()).filter(Boolean).join(NL) });
});

test('piScreenAsk: the footer is case-insensitive and accepts the other action words and keys', () => {
  for (const footer of ['ENTER CONFIRM  ESC CANCEL', 'Return submit · Ctrl+C cancel', 'enter accept, escape cancel', 'Enter select  Esc cancel']) {
    assert.ok(lib.piScreenAsk(`Pick one\n${footer}`), footer);
  }
});

test('piScreenAsk: idle and working pi screens, and plain prose with only some of the words, are not asking', () => {
  assert.equal(lib.piScreenAsk(IDLE_BAR), null);
  assert.equal(lib.piScreenAsk(`$ sleep 20\n${WORKING_BAR}`), null);
  for (const prose of ['Press enter to continue', 'You can cancel the run', 'I will select the file and cancel nothing', 'enter select', 'escape cancel', 'ctrl+c cancel', 'enter select  esc']) {
    assert.equal(lib.piScreenAsk(`${prose}\n${IDLE_BAR}`), null, prose);
  }
});

test('piScreenAsk: the words must share ONE line', () => {
  assert.equal(lib.piScreenAsk('enter select\nescape cancel'), null);
});

test('piScreenAsk: a line longer than 140 characters is not a footer', () => {
  const footer = 'enter select  escape cancel';
  assert.ok(lib.piScreenAsk(`${footer}${' '.repeat(0)}`));
  assert.equal(lib.piScreenAsk(`${footer} ${'x'.repeat(141 - footer.length - 1)}`), null);
  assert.ok(lib.piScreenAsk(`${footer} ${'x'.repeat(140 - footer.length - 1)}`));
});

test('piScreenAsk: the words only outside the last 14 non-empty lines are not asking', () => {
  const later = Array.from({ length: 14 }, (_, i) => `output line ${i}`).join('\n');
  assert.equal(lib.piScreenAsk(`${GUARDED}\n${later}`), null);
  assert.ok(lib.piScreenAsk(`${GUARDED}\n${later.split('\n').slice(1).join('\n')}`));
});

test('piScreenState and piScreenQuestionish are untouched by the wider footer', () => {
  assert.equal(lib.piScreenState(GUARDED), null);
  assert.equal(lib.piScreenState(GUARDED + WORKING_BAR), 'busy');
  assert.deepEqual(lib.piScreenQuestionish(GUARDED).signals, ['footer']);
});

const piTerm = () => ({ handle: 'h1', title: 'Terminal 1', worktreePath: 'C:/dev/repo', connected: true, writable: true });
const fakeOrca = (preview) => async (args) => {
  if (args[0] === 'list') return { terminals: [piTerm()] };
  if (args[0] === 'show') return { terminal: { preview } };
  return { send: { accepted: true } };
};
const REPO = { path: 'C:\\dev\\repo' };

test('the guarded dialog flows through piStatus and scanSessions as asking, with its ask text', async () => {
  const s = await piStatus(REPO, fakeOrca(GUARDED));
  assert.equal(s.state, 'asking');
  assert.match(s.ask, /Allow guarded git operation\?/);
  assert.deepEqual((await scanSessions(REPO.path, fakeOrca(GUARDED), undefined, false, true)).sessions.map((x) => x.state), ['asking']);
  assert.deepEqual(await piStatus(REPO, fakeOrca(IDLE_BAR)), { state: 'idle' });
});
