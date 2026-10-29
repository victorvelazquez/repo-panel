'use strict';
// Types a fixed command into the one idle pi session Orca has open for the repo. It fails closed: no session,
// several sessions, a busy prompt or text already typed all refuse instead of guessing. A pi session is found by
// its screen, never by the terminal title (Orca renames the same session), so each check reads one `show` per
// terminal of the repo's worktree.
const path = require('node:path');
const lib = require('../lib.js');
const { HttpError } = require('./errors.js');
const { run } = require('./exec.js');
const { requirementsFor, padronVersion } = require('./requirements.js');
const { prState } = require('./github.js');

const INSTALL_PATH = path.join(__dirname, '..', 'requirements', 'INSTALL.md');
const PUT_IN_CONDITIONS = 'put-in-conditions';
const FIX_PR = 'fix-pr';

const piBusy = new Set();

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
  };
}

// Appended to the orders that make a session edit files: /flow-commit refuses to start when the index is not empty.
const INDEX_RULE = 'Never use git mv or git add; keep the git index empty (/flow-commit refuses to start with staged files).';

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

// Passive recorder of question-like screens (server/casos.js). A no-op until server.js installs one in its entry block;
// no module and no test installs it by itself. It only observes: its result is never used and it can never fail a scan.
const NO_RECORDER = () => {};
let caseRecorder = NO_RECORDER;
const setCaseRecorder = (fn) => { caseRecorder = typeof fn === 'function' ? fn : NO_RECORDER; };
const caseRecorderInstalled = () => caseRecorder !== NO_RECORDER;
function observe(folder, handle, state, preview) {
  try { const r = caseRecorder({ folder, handle, state, preview }); if (r && typeof r.catch === 'function') r.catch(() => {}); } catch { /* observing never changes a scan */ }
}

// Looks at every terminal of the folder's worktree with a fresh `show` (the `list` preview is truncated), in
// parallel. `sessions` are the ones whose screen is a pi screen; `failed` counts the terminals whose `show`
// failed: those are unknown, not sessions. `listed` is an already fetched `list` result (rooms list once). A
// terminal showing a selection dialog (lib.piScreenAsk) IS a session and that wins over idle/busy/typed: it is
// reported as 'asking' (with its `ask` text) only when `askAware`; other callers (rooms) keep seeing 'busy'.
async function scanSessions(folder, orca, listed, withPreview = false, askAware = false) {
  const terminals = lib.terminalsOfWorktree(listed === undefined ? (await orca(['list'])).terminals : listed, folder);
  const seen = await Promise.all(terminals.map(async ({ handle }) => {
    try {
      const preview = ((await orca(['show', '--terminal', handle])).terminal || {}).preview;
      const ask = lib.piScreenAsk(preview);
      observe(folder, handle, ask ? 'asking' : lib.piScreenState(preview), preview);
      if (ask) return askAware ? { handle, state: 'asking', ask: ask.text, preview } : { handle, state: 'busy', preview };
      return { handle, state: lib.piScreenState(preview), preview };
    } catch { return { handle, state: null, failed: true }; }
  }));
  const sessions = seen.filter((t) => t.state).map(({ handle, state, ask, preview }) => ({ handle, state, ...(ask ? { ask } : {}), ...(withPreview ? { preview } : {}) }));
  return { sessions, failed: seen.filter((t) => t.failed).length };
}

// The pi sessions of the repo: [{ handle, state }] with state idle | typed | busy | asking.
const piSessions = async (repo, orca = orcaTerminal) => (await scanSessions(repo.path, orca, undefined, false, true)).sessions;

// `extra` is { pr, prs, guard }: the PR number of fix-pr, the provider of the repo's open PRs (injectable for tests) and
// the duplicate-send guard of sendGuard (the HTTP server always passes one; without it nothing is refused as a repeat).
async function piSend(repo, key, orca = orcaTerminal, wait = sleep, requirements = requirementsFor, { pr, prs = prState, guard = null } = {}) {
  if (key !== PUT_IN_CONDITIONS && key !== FIX_PR && !Object.hasOwn(lib.PI_COMMANDS, key)) throw new HttpError(400, 'Unknown command');
  if (key === FIX_PR && !(Number.isInteger(pr) && pr > 0)) throw new HttpError(400, 'fix-pr needs the pr number of an open pull request (a positive integer)');
  if (piBusy.has(repo.path)) throw new HttpError(409, 'A command is already being sent to this repo');
  piBusy.add(repo.path);
  try {
    const text = await orderText(repo, key, requirements, { pr, prs });
    const mine = await piSessions(repo, orca);
    if (!mine.length) throw new HttpError(409, 'No open session found for this repo in Orca');
    if (mine.length > 1) throw new HttpError(409, 'Several sessions are open for this repo; close the extra ones');
    if (mine[0].state === 'asking') throw new HttpError(409, 'The session is waiting for your answer to a question');
    const { handle } = mine[0];
    const state = async () => lib.piPromptState(((await orca(['show', '--terminal', handle])).terminal || {}).preview);
    if (mine[0].state !== 'idle') throw new HttpError(409, 'The session is busy or has text typed in its prompt');
    if (guard) guard.check(repo, key);
    await orca(['send', '--terminal', handle, '--text', text, '--enter']);
    // Orca cannot report delivery, so look for the session to leave the idle prompt. `confirmed` only means the
    // prompt left the idle state (the agent started something); it does not prove the order was read or applied.
    for (let i = 0; i < 6; i++) {
      await wait(700);
      if (await state() !== 'idle') { if (guard) guard.record(repo, key); return { sent: true, confirmed: true }; }
    }
    return { sent: true, confirmed: false };
  } finally { piBusy.delete(repo.path); }
}

const TAIL_LINES = 6;
const TAIL_LINE_MAX = 200;
const TAIL_MAX = 800;

// The last non-empty lines of a pi screen ABOVE its prompt bars (the `▎` lines and the footer below them), made
// safe to show: control characters become a space and the lengths are capped. '' when the screen has no prompt bar.
// Informational only: nothing is ever decided from it.
function screenTail(preview) {
  if (typeof preview !== 'string') return '';
  const lines = preview.split(/\r?\n/);
  const at = lines.reduce((last, l, i) => (/^▎\s*\S+\s+(waiting for input|working…)/.test(l.trim()) ? i : last), -1);
  if (at < 0) return '';
  let start = at;
  while (start > 0 && lines[start - 1].trim().startsWith('▎')) start--;
  const above = lines.slice(0, start)
    .map((l) => l.replace(/[\x00-\x1f\x7f-\x9f\u2028\u2029]/g, ' ').trim().slice(0, TAIL_LINE_MAX))
    .filter(Boolean);
  return above.slice(-TAIL_LINES).join('\n').slice(0, TAIL_MAX);
}

// The state of the repo's pi session for the commit verdict: closed | idle | busy | ambiguous | unknown. Read-only
// (`list` and a fresh `show` per terminal, never `send`), as the room presence does. An Orca failure is unknown,
// never closed; a prompt with text typed in it is still a session waiting for input, so it counts as idle. If a
// `show` failed and no pi screen was seen, the failed terminal could be the session, so that is unknown too.
// With `tail` the answer also carries the end of the screen above the prompt (screenTail), '' when unreadable. A
// session showing a selection dialog is 'asking' and the answer carries `ask`, its sanitized text (only then).
async function piStatus(repo, orca = orcaTerminal, { tail = false } = {}) {
  const out = (state, screen = '', ask) => ({ state, ...(tail ? { tail: screen } : {}), ...(ask ? { ask } : {}) });
  try {
    const listed = (await orca(['list'])).terminals;
    if (!Array.isArray(listed)) return out('unknown');
    const { sessions, failed } = await scanSessions(repo.path, orca, listed, tail, true);
    if (!sessions.length) return out(failed ? 'unknown' : 'closed');
    if (sessions.length > 1) return out('ambiguous');
    if (sessions[0].state === 'asking') return out('asking', screenTail(sessions[0].preview), sessions[0].ask);
    return out(sessions[0].state === 'busy' ? 'busy' : 'idle', screenTail(sessions[0].preview));
  } catch { return out('unknown'); }
}

module.exports = { piSend, piStatus, piSessions, scanSessions, conditionsOrder, fixPrOrder, orcaTerminal, sendGuard, setCaseRecorder, caseRecorderInstalled, piBusy };
