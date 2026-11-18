'use strict';
// Sends a fixed command to the repo's pi session over RPC (RPC2-2): the text is built here, the session must be started and idle, and the
// same repo takes one order at a time (sendLock, RP234). It fails closed: not started, busy or asking all refuse.
const path = require('node:path');
const lib = require('../lib.js');
const { HttpError } = require('./errors.js');
const { requirementsFor, padronVersion } = require('./requirements.js');
const { prState } = require('./github.js');

const INSTALL_PATH = path.join(__dirname, '..', 'requirements', 'INSTALL.md');
const PUT_IN_CONDITIONS = 'put-in-conditions';
const FIX_PR = 'fix-pr';

// RP234: two orders that arrive together would both read the session free before the first reaches pi. The lock holds one repo while an order
// is on its way and is freed as soon as pi answers (or fails): from then on the state of the session says busy, so there is no time window.
function sendLock() {
  const held = new Set();
  return {
    take(repo) {
      if (held.has(repo.path)) throw new HttpError(409, 'Another order is on its way to this session: wait for its answer');
      held.add(repo.path);
    },
    free(repo) { held.delete(repo.path); },
  };
}

// RP234: the background jobs the session still waits for (the number of RP161). A count that cannot be read is none: it blocks nothing.
function jobsCount(jobs, id) {
  try {
    const n = typeof jobs === 'function' ? jobs(id) : 0;
    return Number.isSafeInteger(n) && n > 0 ? n : 0;
  } catch { return 0; }
}

// Appended to the orders that make a session edit files: /flow-ship and /flow-commit refuse to start when the index is not empty.
const INDEX_RULE = 'Never use git mv or git add; keep the git index empty (/flow-ship refuses to start with staged files).';

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
  return `Pull request #${n} "${clean(pr.title, 120)}" of this repo has failing checks (${list}). Find out why with gh (gh pr checks ${n}, gh run view --log-failed) and be on its branch "${clean(pr.head, 120)}" (switch only if the tree is clean; if not, stop and ask). Fix whatever is needed, in production code, test code or configuration, as long as it serves the original objective of this pull request (its title, description and commits). If the failure is unrelated to that objective or looks transient (infrastructure, a flaky run, a runner problem), do not edit any code: say so and recommend the "Re-run failed" button. If the right fix would change the scope of the pull request or needs a product decision, stop and ask. Run this repo's tests; do not commit, push or open pull requests: the user will run /flow-ship. ${INDEX_RULE} Finish with one line: what you fixed and the next step.`;
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

// RP233: what pi did with a prompt (data.disposition) when it did not start a run; any other answer, or none, is a start as before.
const NOT_STARTED = ['handled', 'queued'];

// The fixed refusal for each session state that cannot take a command; a session that is still starting counts as busy.
const REFUSALS = { closed: 'The session is not started', starting: 'The session is busy', busy: 'The session is busy', asking: 'The session is waiting for an answer' };

// `extra` is { pr, prs, lock, jobs }: the PR number of fix-pr, the provider of the repo's open PRs (injectable for tests), the lock of sendLock (the HTTP
// server always passes one; without it nothing is refused as a repeat) and the count of background jobs per repo id. `host` is the rpc host (status, prompt).
async function piSend(repo, key, host, requirements = requirementsFor, { pr, prs = prState, lock = null, jobs = null } = {}) {
  if (typeof key !== 'string' || (key !== PUT_IN_CONDITIONS && key !== FIX_PR && !Object.hasOwn(lib.PI_COMMANDS, key))) throw new HttpError(400, 'Unknown command');
  if (key === FIX_PR && !(Number.isInteger(pr) && pr > 0)) throw new HttpError(400, 'fix-pr needs the pr number of an open pull request (a positive integer)');
  const text = await orderText(repo, key, requirements, { pr, prs });
  // RP233: a fixed command the session did not load would reach the model as plain chat. An unknown list (null) blocks nothing.
  const name = lib.piCommandName(key);
  const loaded = name && typeof host.commandsOf === 'function' ? host.commandsOf(repo.id) : null;
  if (Array.isArray(loaded) && !loaded.includes(name)) throw new HttpError(409, `/${name} is not loaded in this session: is flow-skills installed for pi?`);
  const { state } = await host.status(repo.id);
  if (state !== 'idle') throw new HttpError(409, REFUSALS[state] || 'The session is busy');
  // RP234: a background subagent leaves the session free while it works; a delivery order waits for it. Put in conditions and Fix PR are not delivery.
  const waiting = name ? jobsCount(jobs, repo.id) : 0;
  if (waiting) throw new HttpError(409, `The session still has ${waiting} background job${waiting === 1 ? '' : 's'} running: wait for ${waiting === 1 ? 'it' : 'them'} to finish`);
  // Taken after the last await before the prompt, so two clicks in flight cannot both pass; freed when pi answers or fails.
  if (lock) lock.take(repo);
  let answer;
  try { answer = await host.prompt(repo.id, text); } catch (e) { throw e instanceof HttpError ? e : new HttpError(500, 'The session failed'); } finally { if (lock) lock.free(repo); }
  const disposition = answer && typeof answer === 'object' && NOT_STARTED.includes(answer.disposition) ? answer.disposition : null;
  if (!disposition) return { sent: true, confirmed: true };
  return { sent: true, confirmed: false, disposition };
}

// The session state for the commit verdict and the buttons, from the host: closed | idle | busy | asking (starting reads as busy).
async function rpcPiStatus(repo, host) {
  const { state } = await host.status(repo.id);
  return { state: state === 'starting' ? 'busy' : state };
}

module.exports = { piSend, conditionsOrder, fixPrOrder, sendLock, rpcPiStatus };
