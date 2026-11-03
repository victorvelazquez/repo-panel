'use strict';
// Sends a fixed command to the repo's pi session over RPC (RPC2-2): the text is built here, the session must be started and idle, and the
// same text is not accepted twice within a window (sendGuard). It fails closed: not started, busy or asking all refuse.
const path = require('node:path');
const lib = require('../lib.js');
const { HttpError } = require('./errors.js');
const { requirementsFor, padronVersion } = require('./requirements.js');
const { prState } = require('./github.js');

const INSTALL_PATH = path.join(__dirname, '..', 'requirements', 'INSTALL.md');
const PUT_IN_CONDITIONS = 'put-in-conditions';
const FIX_PR = 'fix-pr';

// The same command key is not accepted twice for one repo within this window after a confirmed send: a pi screen
// that reads idle while a subagent still works would otherwise let a second /flow-pr through.
const DUPLICATE_MS = 45 * 1000;

// In-memory record of the last confirmed send per repo path and command key. The clock is injectable for tests.
function sendGuard(now = Date.now) {
  const last = new Map();
  const id = (repo, key) => `${repo.path}|${key}`;
  return {
    check(repo, key) {
      const ago = now() - (last.get(id(repo, key)) ?? -Infinity);
      if (ago < DUPLICATE_MS) throw new HttpError(409, `That command was already sent ${Math.max(0, Math.round(ago / 1000))} s ago; wait for it to finish`);
    },
    record(repo, key) { last.set(id(repo, key), now()); },
    forget(repo, key) { last.delete(id(repo, key)); },
  };
}

// Appended to the orders that make a session edit files: /flow-commit refuses to start when the index is not empty.
const INDEX_RULE = 'Never use git mv or git add; keep the git index empty (/flow-commit refuses to start with staged files).';

// The one-line order that sends the agent to requirements/INSTALL.md. Built here from the requirement results
// (non-pass ids, required first); the browser never supplies text or ids.
function conditionsOrder(results, installPath = INSTALL_PATH, padron = padronVersion()) {
  if (/["\x00-\x1f\x7f]/.test(installPath)) throw new HttpError(500, 'The path of requirements/INSTALL.md has unsupported characters');
  const open = results.filter((r) => r.status !== 'pass');
  if (!open.length) throw new HttpError(409, 'Every requirement already passes: nothing to do');
  const ids = [...open.filter((r) => r.level === 'required'), ...open.filter((r) => r.level !== 'required')].map((r) => r.id);
  return `Put this repo in conditions for repo-panel${padron ? ` (padrón ${padron})` : ''}: read "${installPath}" (the user authorizes reading that one file outside this repo) and apply these requirement ids: ${ids.join(', ')}. ${INDEX_RULE}`;
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
  return `Pull request #${n} "${clean(pr.title, 120)}" of this repo has failing checks (${list}). Find out why with gh (gh pr checks ${n}, gh run view --log-failed) and be on its branch "${clean(pr.head, 120)}" (switch only if the tree is clean; if not, stop and ask). Fix whatever is needed, in production code, test code or configuration, as long as it serves the original objective of this pull request (its title, description and commits). If the failure is unrelated to that objective or looks transient (infrastructure, a flaky run, a runner problem), do not edit any code: say so and recommend the "Re-run failed" button. If the right fix would change the scope of the pull request or needs a product decision, stop and ask. Run this repo's tests; do not commit, push or open pull requests: the user will run /flow-commit and /flow-pr. ${INDEX_RULE} Finish with one line: what you fixed and the next step.`;
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
    if (req.isRoom) throw new HttpError(409, `${req.room.name} is a room: a room is put in conditions with the room standard, which is not available yet`);
    return conditionsOrder(req.results);
  }
  return Object.hasOwn(lib.PI_COMMANDS, key) ? lib.PI_COMMANDS[key] : null;
}

// The fixed refusal for each session state that cannot take a command; a session that is still starting counts as busy.
const REFUSALS = { closed: 'The session is not started', starting: 'The session is busy', busy: 'The session is busy', asking: 'The session is waiting for an answer' };

// `extra` is { pr, prs, guard }: the PR number of fix-pr, the provider of the repo's open PRs (injectable for tests) and the duplicate-send
// guard of sendGuard (the HTTP server always passes one; without it nothing is refused as a repeat). `host` is the rpc host (status, prompt).
async function piSend(repo, key, host, requirements = requirementsFor, { pr, prs = prState, guard = null } = {}) {
  if (key !== PUT_IN_CONDITIONS && key !== FIX_PR && !Object.hasOwn(lib.PI_COMMANDS, key)) throw new HttpError(400, 'Unknown command');
  if (key === FIX_PR && !(Number.isInteger(pr) && pr > 0)) throw new HttpError(400, 'fix-pr needs the pr number of an open pull request (a positive integer)');
  const text = await orderText(repo, key, requirements, { pr, prs });
  const { state } = await host.status(repo.id);
  if (state !== 'idle') throw new HttpError(409, REFUSALS[state] || 'The session is busy');
  // Armed before the await so two clicks in flight cannot both pass; a refused prompt gives the slot back.
  if (guard) { guard.check(repo, key); guard.record(repo, key); }
  try { await host.prompt(repo.id, text); } catch (e) { if (guard) guard.forget(repo, key); throw e instanceof HttpError ? e : new HttpError(500, 'The session failed'); }
  return { sent: true, confirmed: true };
}

// The session state for the commit verdict and the buttons, from the host: closed | idle | busy | asking (starting reads as busy).
async function rpcPiStatus(repo, host) {
  const { state } = await host.status(repo.id);
  return { state: state === 'starting' ? 'busy' : state };
}

module.exports = { piSend, conditionsOrder, fixPrOrder, sendGuard, rpcPiStatus };
