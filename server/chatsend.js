'use strict';
// Free text typed into the adopted pi session of a repo (S49). The text is cleaned here (no control character can
// reach Orca), and NOTHING is sent unless exactly one live pi session is open, it is the adopted one, and its prompt
// is idle. One `send` per call, never an interrupt flag, never a resend: delivery is verified by reading the history.
const { HttpError } = require('./errors.js');
const { loadConfig, findRepo } = require('./config.js');
const { scanSessions, orcaTerminal, piBusy } = require('./pi.js');
const { readChat } = require('./sessions.js');
const lib = require('../lib.js');

const TEXT_MAX = 4000;
const DUPLICATE_MS = 5000;
const POLL_STEPS = 15;
const POLL_MS = 1000;
const CTRL_U = '\x15';
const RECENT_MAX = 50;
// Everything but LF and TAB: C0 (ESC, NUL, BEL...), DEL, C1, line/paragraph separators, bidi and zero-width controls.
const CONTROLS = /[\x00-\x08\x0b-\x1f\x7f-\x9f\u2028\u2029\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// The same per-repo guard as the command buttons (piSend): a command and a message never go to one repo at the same time.
const inFlight = piBusy;
const recent = new Map();

// Remember a sent text for the double-click guard. The memory holds at most RECENT_MAX texts (the oldest goes first); an
// expired entry is harmless because the guard compares the time, not the presence.
function remember(key, at) {
  recent.delete(key);
  recent.set(key, at);
  while (recent.size > RECENT_MAX) recent.delete(recent.keys().next().value);
}

function sanitizeText(text) {
  if (typeof text !== 'string') throw new HttpError(400, 'The text must be a string');
  const clean = text.replace(/\r\n?/g, '\n').replace(CONTROLS, '').trim();
  if (!clean) throw new HttpError(400, 'Write something to send');
  if (clean.length > TEXT_MAX) throw new HttpError(400, `The message is longer than ${TEXT_MAX} characters`);
  if (clean.startsWith('!')) throw new HttpError(400, 'Messages that start with ! run a shell command in pi; type those in the terminal');
  return clean;
}

function repoOf(id) {
  if (typeof id !== 'string' || !id) throw new HttpError(400, 'Invalid request');
  if (id.startsWith('room:')) throw new HttpError(400, 'The room chat is not available yet');
  return findRepo(id);
}

function adoptedOf(id) {
  const adopted = (loadConfig().sessions || {})[id];
  if (!adopted) throw new HttpError(409, 'Adopt or start a session of this repo first');
  return adopted;
}

// The ONE live pi session of the repo, with its screen. An Orca failure is the same 503 orcaTerminal throws.
async function liveSession(repo, orca) {
  let found;
  try { found = await scanSessions(repo.path, orca, undefined, true, true); } catch (e) {
    throw e instanceof HttpError ? e : new HttpError(503, 'Orca CLI is unavailable or Orca is not running');
  }
  const { sessions, failed } = found;
  if (!sessions.length) throw new HttpError(409, 'No open pi session found for this repo in Orca');
  if (sessions.length > 1) throw new HttpError(409, 'Several pi sessions are open for this repo; close the extra ones');
  if (failed) throw new HttpError(409, 'Orca could not read every terminal of this repo; try again');
  return sessions[0];
}

// A named session shows ` • <name>` at the end of a footer line, BELOW the prompt bars (the lines that start with the bar glyph).
// A line of the conversation above the bars can say anything, so only what follows the last bar line counts. An unnamed
// adopted session cannot be told apart this way (the delivery check still notices a wrong target).
function checkIdentity(session, adopted) {
  if (adopted.name === adopted.id) return;
  const mine = ` • ${String(adopted.name).trim()}`;
  const lines = String(session.preview || '').split(/\r?\n/).map((l) => l.trim());
  const footer = lines.slice(lines.map((l) => l.startsWith('▎')).lastIndexOf(true) + 1);
  if (!footer.some((l) => l.endsWith(mine))) throw new HttpError(409, 'The open pi session is not the adopted one');
}

const promptState = async (orca, handle) => lib.piPromptState(((await orca(['show', '--terminal', handle])).terminal || {}).preview);
// Both sides are compared flattened the way readChat flattens and in the same Unicode form (NFC), so an accent stored
// decomposed or composed does not make a delivered message look undelivered.
const flat = (t) => String(t).replace(/[\x00-\x1f\x7f-\x9f\u2028\u2029]/g, ' ').trim().normalize('NFC');
const countOf = (repo, adopted, text, base) => readChat(repo.path, adopted.id, { base, limit: 100 }).items.filter((i) => i.role === 'user' && flat(i.text) === text).length;

async function sendChat(id, body, { orca = orcaTerminal, wait = sleep, sessionsDir, now = Date.now } = {}) {
  const repo = repoOf(id);
  const text = sanitizeText(body && typeof body === 'object' ? body.text : undefined);
  const adopted = adoptedOf(id);
  if (inFlight.has(repo.path)) throw new HttpError(409, 'A message is already being sent to this repo');
  inFlight.add(repo.path);
  try {
    const session = await liveSession(repo, orca);
    if (session.state === 'asking') throw new HttpError(409, 'The pi session is waiting for your answer to a question');
    if (session.state === 'typed') throw new HttpError(409, 'The pi session already has text typed in its prompt');
    if (session.state !== 'idle') throw new HttpError(409, 'The pi session is working; wait until it is free');
    checkIdentity(session, adopted);
    const last = recent.get(`${repo.path}|${text}`);
    if (last !== undefined && now() - last < DUPLICATE_MS) throw new HttpError(409, 'That message was just sent to this repo; wait a moment');
    const before = countOf(repo, adopted, flat(text), sessionsDir);
    remember(`${repo.path}|${text}`, now());
    // `--text=<value>` (not a separate argument): a message that starts with -- would otherwise be read as an Orca option.
    await orca(['send', '--terminal', session.handle, `--text=${text}`, '--enter']);
    let delivered = false;
    for (let i = 0; i < POLL_STEPS && !delivered; i++) {
      await wait(POLL_MS);
      delivered = countOf(repo, adopted, flat(text), sessionsDir) > before;
    }
    let leftInBox = false;
    try { leftInBox = await promptState(orca, session.handle) === 'typed'; } catch { /* unknown: not reported as left */ }
    return { sent: true, delivered, leftInBox };
  } finally { inFlight.delete(repo.path); }
}

async function clearChat(id, { orca = orcaTerminal, wait = sleep } = {}) {
  const repo = repoOf(id);
  const adopted = adoptedOf(id);
  if (inFlight.has(repo.path)) throw new HttpError(409, 'A message is already being sent to this repo');
  inFlight.add(repo.path);
  try {
    const session = await liveSession(repo, orca);
    if (session.state !== 'typed') throw new HttpError(409, 'There is nothing typed to clear');
    checkIdentity(session, adopted);
    await orca(['send', '--terminal', session.handle, `--text=${CTRL_U}`]);
    await wait(300);
    return { cleared: await promptState(orca, session.handle) === 'idle' };
  } finally { inFlight.delete(repo.path); }
}

module.exports = { sanitizeText, sendChat, clearChat, __recentSize: () => recent.size };
