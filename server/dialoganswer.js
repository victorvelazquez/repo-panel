'use strict';
// Answers the selection dialog of the ONE session that is asking (RP73). The browser sends { id, fingerprint, index }; the keys are
// two constants and nothing from the request reaches a terminal. A closed loop: the whole screen is read, the question must still be
// the one the person saw, then ONE down arrow at a time with a fresh read after each (the marker must have moved exactly one row and
// nothing else in the dialog changed), then ONE Enter and up to 8 reads to see the dialog leave. It fails closed and never resends.
const { HttpError } = require('./errors.js');
const { findRepo } = require('./config.js');
const { scanSessions, readScreen, orcaTerminal, piBusy } = require('./pi.js');
const lib = require('../lib.js');

const KEYS = { down: '\x1b[B', enter: '\r' };
const KEY_WAIT_MS = 150;
const CONFIRM_WAIT_MS = 300;
const CONFIRM_READS = 8;
const OPTIONS_MAX = 8;
const DUPLICATE_MS = 10 * 1000;
const RECENT_MAX = 50;
const BODY_KEYS = new Set(['id', 'fingerprint', 'index']);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Fingerprint -> time of the Enter. Entries older than DUPLICATE_MS go on every call and the map never holds more than RECENT_MAX.
const answered = new Map();

function remember(fingerprint, at) {
  answered.delete(fingerprint);
  answered.set(fingerprint, at);
  while (answered.size > RECENT_MAX) answered.delete(answered.keys().next().value);
}

function repoOf(id) {
  if (typeof id !== 'string' || !id) throw new HttpError(400, 'Invalid request');
  if (id.startsWith('room:')) throw new HttpError(400, 'The room chat is not available yet');
  return findRepo(id);
}

function checkBody(body) {
  const plain = body && typeof body === 'object' && !Array.isArray(body);
  if (!plain || !Object.keys(body).every((k) => BODY_KEYS.has(k)) || typeof body.fingerprint !== 'string' || !/^[0-9a-f]{16}$/.test(body.fingerprint)
    || !Number.isInteger(body.index) || body.index < 0 || body.index >= OPTIONS_MAX) throw new HttpError(400, 'Invalid request');
  return { fingerprint: body.fingerprint, index: body.index };
}

const press = (orca, handle, key) => orca(['send', '--terminal', handle, `--text=${key}`]);

async function answerDialog(id, body, { orca = orcaTerminal, wait = sleep, now = Date.now } = {}) {
  const repo = repoOf(id);
  const { fingerprint, index } = checkBody(body);
  if (piBusy.has(repo.path)) throw new HttpError(409, 'A command is already being sent to this repo');
  piBusy.add(repo.path);
  try {
    let found;
    try { found = await scanSessions(repo.path, orca, undefined, false, true); } catch (e) {
      throw e instanceof HttpError ? e : new HttpError(503, 'Orca CLI is unavailable or Orca is not running');
    }
    if (found.sessions.length > 1) throw new HttpError(409, 'Several sessions are open for this repo; close the extra ones');
    if (!found.sessions.length || found.sessions[0].state !== 'asking') throw new HttpError(409, 'The session is not asking anything');
    if (found.failed) throw new HttpError(409, 'Orca could not read every terminal of this repo; try again');
    const { handle } = found.sessions[0];
    const screen = await readScreen(orca, handle);
    if (screen === null) throw new HttpError(409, 'The question cannot be read right now');
    const first = lib.piDialogChoices(screen);
    if (!first) throw new HttpError(409, 'This kind of question cannot be answered from the panel: use the terminal');
    if (first.fingerprint !== fingerprint) throw new HttpError(409, 'The question changed: look at the card again');
    if (index >= first.options.length) throw new HttpError(400, 'Invalid request');
    const chosen = first.options[index];
    if (chosen.tone === 'affirmative' && !first.complete) throw new HttpError(409, 'The question is cut off, so the panel will not approve it: use the terminal');
    // One answer per question AND per repo: two repos that show the same text do not block each other.
    const answeredKey = `${repo.path}|${fingerprint}`;
    for (const [key, at] of answered) if (now() - at >= DUPLICATE_MS) answered.delete(key);
    if (answered.has(answeredKey)) throw new HttpError(409, 'That question was already answered');
    for (let step = 1; step <= index; step++) {
      await press(orca, handle, KEYS.down);
      await wait(KEY_WAIT_MS);
      const seen = lib.piDialogChoices(await readScreen(orca, handle) || '', { allowSingle: true });
      if (!lib.piDialogMovedDown(first, seen, step)) throw new HttpError(409, 'The selection did not move as expected: nothing was confirmed');
    }
    // From here on the question counts as answered even if the Enter fails: a second one must never follow.
    remember(answeredKey, now());
    await press(orca, handle, KEYS.enter);
    for (let read = 0; read < CONFIRM_READS; read++) {
      await wait(CONFIRM_WAIT_MS);
      const after = await readScreen(orca, handle);
      if (after === null) continue;
      // Confirmed only when the dialog is gone (no footer) or another question took its place, that is, the first row of the question (its
      // title) is no longer on the screen. The same title with a footer is the same question, scrolled or changed: never reported as answered.
      if (!lib.piScreenAsk(after)) return { answered: true, option: chosen.label };
      const lead = first.questionRows[0];
      if (lead !== undefined && !after.split('\n').some((r) => r.trim() === lead)) return { answered: true, option: chosen.label };
    }
    throw new HttpError(409, 'The question is still open: check the terminal');
  } finally { piBusy.delete(repo.path); }
}

module.exports = { answerDialog };
