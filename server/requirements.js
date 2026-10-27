'use strict';
// Requirements of a repo to show well in the panel, plus the per-machine prerequisites. The panel only
// detects: it reads the remote base branch and never writes to another repo (the agent applies the remedies).
const fs = require('node:fs');
const path = require('node:path');
const checks = require('../checks.js');
const { HttpError } = require('./errors.js');
const lib = require('../lib.js');
const { run, git, firstLine } = require('./exec.js');
const { roomOf } = require('./config.js');
const { remoteFile } = require('./roadmap.js');

const REGISTRY_PATH = path.join(__dirname, '..', 'requirements.json');
let registry = null;

function loadRegistry() {
  if (registry) return registry;
  let parsed = null;
  try { parsed = JSON.parse(fs.readFileSync(REGISTRY_PATH, 'utf8')); } catch { /* reported below */ }
  if (!parsed || !Array.isArray(parsed.requirements)) throw new HttpError(500, 'requirements.json is missing or invalid');
  registry = parsed;
  return registry;
}

// Whether Git ignores .panel/state.json in the repo's working tree (a local fact, not read from the base branch):
// `git check-ignore -q` exits 0 when ignored and 1 when not; anything else (no repo, no folder, git missing) is unavailable.
async function panelIgnored(repo, gitRun) {
  const r = await gitRun(repo.path, ['check-ignore', '-q', '.panel/state.json']).catch(() => null);
  if (r && r.code === 0) return { available: true, ignored: true };
  if (r && r.code === 1) return { available: true, ignored: false };
  return { available: false, reason: 'error' };
}

// Reads the files of `paths` ({ role: relative path }) from the remote base branch and evaluates `list` of the registry.
async function evaluateRepo(repo, paths, list, room, local = null) {
  const reg = loadRegistry();
  const roles = Object.keys(paths);
  const read = await Promise.all(roles.map((role) => remoteFile(repo, paths[role])));
  const files = Object.fromEntries(roles.map((role, i) => [role, { ...read[i], path: paths[role] }]));
  // Every read resolves the same base, so the first one tells whether it exists.
  const first = read[0];
  const status = first.reason === 'no-repo' || first.reason === 'no-base' ? first.reason : 'ok';
  const base = { status, name: first.base };
  const { results, summary } = checks.evaluate(reg, { base, files, room, local }, list);
  return { available: status === 'ok', base: first.base || null, results, summary };
}

// A repo that belongs to a room also gets the member-only requirements and a `room` field; any other repo's answer is unchanged.
async function requirementsFor(repo, room = roomOf(repo.id), { git: gitRun = git } = {}) {
  const paths = { agents: 'AGENTS.md', roadmap: repo.roadmap || 'docs/ROADMAP.md', adoption: 'docs/ORQUESTACION.md' };
  const local = { panelIgnored: await panelIgnored(repo, gitRun) };
  const out = await evaluateRepo(repo, paths, 'requirements', room ? { name: room.name } : null, local);
  return room ? { ...out, room: { name: room.name } } : out;
}

// The room repo itself: AGENTS.md and the link map, which lives at the root or under estrategia/.
function roomRequirementsFor(room) {
  const repo = { id: room.id || lib.repoId(room.path), path: room.path };
  return evaluateRepo(repo, { agents: 'AGENTS.md', enlaces: 'ENLACES.md', enlacesAlt: 'estrategia/ENLACES.md' }, 'roomRequirements', null);
}

const TOOLS = [
  { id: 'git', cmd: 'git', args: ['--version'] },
  { id: 'gh', cmd: 'gh', args: ['auth', 'status'] },
  { id: 'orca', cmd: 'orca', args: ['--version'] },
];

// The runner is injectable so tests do not need the real tools. A missing tool is ok:false, never an error.
async function prerequisites(runner = run) {
  const items = await Promise.all(TOOLS.map(async ({ id, cmd, args }) => {
    const r = await runner(cmd, args, { timeout: 15000 }).catch(() => ({ code: -1, stdout: '', stderr: '' }));
    const ok = r.code === 0;
    const detail = ok ? firstLine(r.stdout) || firstLine(r.stderr) : firstLine(r.stderr) || firstLine(r.stdout);
    return { id, ok, detail: detail || (ok ? 'ok' : 'not available') };
  }));
  return { items };
}

// The version of the whole set of rules, written in requirements.json: the order cites it and each repo records it.
const padronVersion = () => loadRegistry().padron || null;

module.exports = { requirementsFor, roomRequirementsFor, prerequisites, padronVersion };
