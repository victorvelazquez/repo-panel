'use strict';
// Types a fixed command into the one idle pi session Orca has open for the repo. It fails closed: no session,
// several sessions, a busy prompt or text already typed all refuse instead of guessing. A pi session is found by
// its screen, never by the terminal title (Orca renames the same session), so each check reads one `show` per
// terminal of the repo's worktree.
const path = require('node:path');
const lib = require('../lib.js');
const { HttpError } = require('./errors.js');
const { run } = require('./exec.js');
const { requirementsFor } = require('./requirements.js');
const { prState } = require('./github.js');

const INSTALL_PATH = path.join(__dirname, '..', 'requirements', 'INSTALL.md');
const PUT_IN_CONDITIONS = 'put-in-conditions';
const FIX_PR = 'fix-pr';

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

// Text that comes from GitHub (titles, branch and check names) goes into the order only after this: control
// characters become a space, double quotes are dropped, spaces collapse and the length is capped.
function clean(value, max) {
  return String(value ?? '').replace(/[\x00-\x1f\x7f-\x9f\u2028\u2029]/g, ' ').replace(/"/g, '').replace(/\s+/g, ' ').trim().slice(0, max).trim();
}

const MAX_CHECK_NAMES = 5;

// The one-line order that sends the agent to fix a pull request with failing checks. Built here from the PR's own
// data (as listed by prState); the browser never supplies text. It never starts with "/" and holds no control character.
function fixPrOrder(pr) {
  const names = ((pr.checks && pr.checks.items) || []).filter((i) => i && i.state === 'failed').map((i) => clean(i.name, 60)).filter(Boolean);
  const more = names.length - MAX_CHECK_NAMES;
  const list = names.slice(0, MAX_CHECK_NAMES).join(', ') + (more > 0 ? ` and ${more} more` : '') || 'unnamed checks';
  const n = Number(pr.number);
  return `Pull request #${n} "${clean(pr.title, 120)}" of this repo has failing checks (${list}). Find out why with gh (gh pr checks ${n}, gh run view --log-failed) and make sure you are on its branch "${clean(pr.head, 120)}" (switch to it only if the tree is clean; if not, stop and ask). Fix whatever is needed, in production code, test code or configuration, as long as it serves the original objective of this pull request (its title, description and commits). If the failure is unrelated to that objective or looks transient (infrastructure, a flaky run, a runner problem), do not edit any code: say so and recommend the "Re-run failed" button. If the right fix would change the scope of the pull request or needs a product decision, stop and ask. Run this repo's tests, and do not commit, push or open pull requests: the user will run /flow-commit and then /flow-pr, which updates this PR. When done, write one line with what you fixed and the next step.`;
}

// Looks the PR up in the repo's open PRs and refuses unless it exists and its checks failed.
async function fixPrOrderFor(repo, number, prs) {
  const listed = await prs(repo);
  if (!listed || listed.error || listed.noRemote || !Array.isArray(listed.prs)) throw new HttpError(409, 'The pull requests of this repo could not be read');
  const pr = listed.prs.find((p) => p && p.number === number);
  if (!pr) throw new HttpError(409, `Pull request #${number} does not exist or is not open`);
  if (!pr.checks || pr.checks.state !== 'failed') throw new HttpError(409, `Pull request #${number} has no failing checks: nothing to fix`);
  return fixPrOrder(pr);
}

async function orderText(repo, key, requirements, extra) {
  if (key === FIX_PR) return fixPrOrderFor(repo, extra.pr, extra.prs);
  if (key === PUT_IN_CONDITIONS) {
    const req = await requirements(repo);
    if (!req.available) throw new HttpError(409, 'The requirements could not be evaluated (is the base branch available?)');
    return conditionsOrder(req.results);
  }
  return Object.hasOwn(lib.PI_COMMANDS, key) ? lib.PI_COMMANDS[key] : null;
}

// Looks at every terminal of the folder's worktree with a fresh `show` (the `list` preview is truncated), in
// parallel. `sessions` are the ones whose screen is a pi screen; `failed` counts the terminals whose `show`
// failed: those are unknown, not sessions. `listed` is an already fetched `list` result (rooms list once).
async function scanSessions(folder, orca, listed) {
  const terminals = lib.terminalsOfWorktree(listed === undefined ? (await orca(['list'])).terminals : listed, folder);
  const seen = await Promise.all(terminals.map(async ({ handle }) => {
    try { return { handle, state: lib.piScreenState(((await orca(['show', '--terminal', handle])).terminal || {}).preview) }; }
    catch { return { handle, state: null, failed: true }; }
  }));
  return { sessions: seen.filter((t) => t.state).map(({ handle, state }) => ({ handle, state })), failed: seen.filter((t) => t.failed).length };
}

// The pi sessions of the repo: [{ handle, state }] with state idle | typed | busy.
const piSessions = async (repo, orca = orcaTerminal) => (await scanSessions(repo.path, orca)).sessions;

// `extra` is { pr, prs }: the PR number of fix-pr and the provider of the repo's open PRs (injectable for tests).
async function piSend(repo, key, orca = orcaTerminal, wait = sleep, requirements = requirementsFor, { pr, prs = prState } = {}) {
  if (key !== PUT_IN_CONDITIONS && key !== FIX_PR && !Object.hasOwn(lib.PI_COMMANDS, key)) throw new HttpError(400, 'Unknown command');
  if (key === FIX_PR && !(Number.isInteger(pr) && pr > 0)) throw new HttpError(400, 'fix-pr needs the pr number of an open pull request (a positive integer)');
  if (piBusy.has(repo.path)) throw new HttpError(409, 'A command is already being sent to this repo');
  piBusy.add(repo.path);
  try {
    const text = await orderText(repo, key, requirements, { pr, prs });
    const mine = await piSessions(repo, orca);
    if (!mine.length) throw new HttpError(409, 'No open pi session found for this repo in Orca');
    if (mine.length > 1) throw new HttpError(409, 'Several pi sessions are open for this repo; close the extra ones');
    const { handle } = mine[0];
    const state = async () => lib.piPromptState(((await orca(['show', '--terminal', handle])).terminal || {}).preview);
    if (mine[0].state !== 'idle') throw new HttpError(409, 'The pi session is busy or has text typed in its prompt');
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
// (`list` and a fresh `show` per terminal, never `send`), as the room presence does. An Orca failure is unknown,
// never closed; a prompt with text typed in it is still a session waiting for input, so it counts as idle. If a
// `show` failed and no pi screen was seen, the failed terminal could be the session, so that is unknown too.
async function piStatus(repo, orca = orcaTerminal) {
  try {
    const listed = (await orca(['list'])).terminals;
    if (!Array.isArray(listed)) return { state: 'unknown' };
    const { sessions, failed } = await scanSessions(repo.path, orca, listed);
    if (!sessions.length) return { state: failed ? 'unknown' : 'closed' };
    if (sessions.length > 1) return { state: 'ambiguous' };
    return { state: sessions[0].state === 'busy' ? 'busy' : 'idle' };
  } catch { return { state: 'unknown' }; }
}

module.exports = { piSend, piStatus, piSessions, scanSessions, conditionsOrder, fixPrOrder, orcaTerminal };
