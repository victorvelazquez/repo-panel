'use strict';
// Types a fixed command into the one idle pi session Orca has open for the repo. It fails closed: no session,
// several sessions, a busy prompt or text already typed all refuse instead of guessing.
const path = require('node:path');
const lib = require('../lib.js');
const { HttpError } = require('./errors.js');
const { run } = require('./exec.js');
const { requirementsFor } = require('./requirements.js');

const INSTALL_PATH = path.join(__dirname, '..', 'requirements', 'INSTALL.md');
const PUT_IN_CONDITIONS = 'put-in-conditions';

const piBusy = new Set();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function orcaTerminal(args) {
  const r = await run('orca', ['terminal', ...args, '--json'], { timeout: 15000 });
  let out = null;
  try { out = JSON.parse(r.stdout); } catch { /* not JSON */ }
  if (r.code !== 0 || !out || out.ok === false) throw new HttpError(503, 'Orca CLI is unavailable or Orca is not running');
  return out.result || {};
}

// The one-line order that sends the agent to requirements/INSTALL.md. Built here from the requirement results
// (non-pass ids, required first); the browser never supplies text or ids.
function conditionsOrder(results, installPath = INSTALL_PATH) {
  if (/["\x00-\x1f\x7f]/.test(installPath)) throw new HttpError(500, 'The path of requirements/INSTALL.md has unsupported characters');
  const open = results.filter((r) => r.status !== 'pass');
  if (!open.length) throw new HttpError(409, 'Every requirement already passes: nothing to do');
  const ids = [...open.filter((r) => r.level === 'required'), ...open.filter((r) => r.level !== 'required')].map((r) => r.id);
  return `Put this repo in conditions for repo-panel: read "${installPath}" (the user authorizes reading that one file outside this repo) and apply these requirement ids: ${ids.join(', ')}.`;
}

async function orderText(repo, key, requirements) {
  if (key === PUT_IN_CONDITIONS) {
    const req = await requirements(repo);
    if (!req.available) throw new HttpError(409, 'The requirements could not be evaluated (is the base branch available?)');
    return conditionsOrder(req.results);
  }
  return Object.hasOwn(lib.PI_COMMANDS, key) ? lib.PI_COMMANDS[key] : null;
}

async function piSend(repo, key, orca = orcaTerminal, wait = sleep, requirements = requirementsFor) {
  if (key !== PUT_IN_CONDITIONS && !Object.hasOwn(lib.PI_COMMANDS, key)) throw new HttpError(400, 'Unknown command');
  if (piBusy.has(repo.path)) throw new HttpError(409, 'A command is already being sent to this repo');
  piBusy.add(repo.path);
  try {
    const text = await orderText(repo, key, requirements);
    const mine = lib.piTerminalsFor((await orca(['list'])).terminals, repo.path);
    if (!mine.length) throw new HttpError(409, 'No open pi session found for this repo in Orca');
    if (mine.length > 1) throw new HttpError(409, 'Several pi sessions are open for this repo; close the extra ones');
    const handle = mine[0].handle;
    const state = async () => lib.piPromptState(((await orca(['show', '--terminal', handle])).terminal || {}).preview);
    if (await state() !== 'idle') throw new HttpError(409, 'The pi session is busy or has text typed in its prompt');
    await orca(['send', '--terminal', handle, '--text', text, '--enter']);
    // Orca cannot report delivery, so look for the session to leave the idle prompt. `confirmed` only means the
    // prompt left the idle state (the agent started something); it does not prove the order was read or applied.
    for (let i = 0; i < 6; i++) {
      await wait(700);
      if (await state() !== 'idle') return { sent: true, confirmed: true };
    }
    return { sent: true, confirmed: false };
  } finally { piBusy.delete(repo.path); }
}

// The state of the repo's pi session for the commit verdict: closed | idle | busy | ambiguous | unknown. Read-only
// (`list` and a fresh `show`, never `send`), as the room presence does. An Orca failure is unknown, never closed;
// a prompt with text typed in it is still a session waiting for input, so it counts as idle.
async function piStatus(repo, orca = orcaTerminal) {
  try {
    const listed = (await orca(['list'])).terminals;
    if (!Array.isArray(listed)) return { state: 'unknown' };
    const mine = lib.piTerminalsFor(listed, repo.path);
    if (!mine.length) return { state: 'closed' };
    if (mine.length > 1) return { state: 'ambiguous' };
    const shown = await orca(['show', '--terminal', mine[0].handle]);
    return { state: lib.piPromptState((shown.terminal || {}).preview) === 'busy' ? 'busy' : 'idle' };
  } catch { return { state: 'unknown' }; }
}

module.exports = { piSend, piStatus, conditionsOrder, orcaTerminal };
