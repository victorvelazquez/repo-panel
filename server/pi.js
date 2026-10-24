'use strict';
// Types a fixed command into the one idle pi session Orca has open for the repo. It fails closed: no session,
// several sessions, a busy prompt or text already typed all refuse instead of guessing.
const lib = require('../lib.js');
const { HttpError } = require('./errors.js');
const { run } = require('./exec.js');

const piBusy = new Set();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function orcaTerminal(args) {
  const r = await run('orca', ['terminal', ...args, '--json'], { timeout: 15000 });
  let out = null;
  try { out = JSON.parse(r.stdout); } catch { /* not JSON */ }
  if (r.code !== 0 || !out || out.ok === false) throw new HttpError(503, 'Orca CLI is unavailable or Orca is not running');
  return out.result || {};
}

async function piSend(repo, key, orca = orcaTerminal, wait = sleep) {
  const text = Object.hasOwn(lib.PI_COMMANDS, key) ? lib.PI_COMMANDS[key] : null;
  if (!text) throw new HttpError(400, 'Unknown command');
  if (piBusy.has(repo.path)) throw new HttpError(409, 'A command is already being sent to this repo');
  piBusy.add(repo.path);
  try {
    const mine = lib.piTerminalsFor((await orca(['list'])).terminals, repo.path);
    if (!mine.length) throw new HttpError(409, 'No open pi session found for this repo in Orca');
    if (mine.length > 1) throw new HttpError(409, 'Several pi sessions are open for this repo; close the extra ones');
    const handle = mine[0].handle;
    const state = async () => lib.piPromptState(((await orca(['show', '--terminal', handle])).terminal || {}).preview);
    if (await state() !== 'idle') throw new HttpError(409, 'The pi session is busy or has text typed in its prompt');
    await orca(['send', '--terminal', handle, '--text', text, '--enter']);
    // Orca cannot report delivery, so look for the session to leave the idle prompt.
    for (let i = 0; i < 6; i++) {
      await wait(700);
      if (await state() !== 'idle') return { sent: true, confirmed: true };
    }
    return { sent: true, confirmed: false };
  } finally { piBusy.delete(repo.path); }
}

module.exports = { piSend };
