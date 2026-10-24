'use strict';
// Requirements of a repo to show well in the panel, plus the per-machine prerequisites. The panel only
// detects: it reads the remote base branch and never writes to another repo (the agent applies the remedies).
const fs = require('node:fs');
const path = require('node:path');
const checks = require('../checks.js');
const { HttpError } = require('./errors.js');
const { run, firstLine } = require('./exec.js');
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

async function requirementsFor(repo) {
  const reg = loadRegistry();
  const paths = { agents: 'AGENTS.md', roadmap: repo.roadmap || 'docs/ROADMAP.md', adoption: 'docs/ORQUESTACION.md' };
  const roles = Object.keys(paths);
  const read = await Promise.all(roles.map((role) => remoteFile(repo, paths[role])));
  const files = Object.fromEntries(roles.map((role, i) => [role, { ...read[i], path: paths[role] }]));
  // Every read resolves the same base, so the first one tells whether it exists.
  const first = read[0];
  const status = first.reason === 'no-repo' || first.reason === 'no-base' ? first.reason : 'ok';
  const base = { status, name: first.base };
  const { results, summary } = checks.evaluate(reg, { base, files });
  return { available: status === 'ok', base: first.base || null, results, summary };
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

module.exports = { requirementsFor, prerequisites };
