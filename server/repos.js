'use strict';
// Repo management: add, remove, snooze, dismiss and folder scan.
const fs = require('node:fs');
const path = require('node:path');
const lib = require('../lib.js');
const { HttpError } = require('./errors.js');
const { git } = require('./exec.js');
const { loadConfig, saveConfig, findRepo } = require('./config.js');
const { forgetMeta } = require('./github.js');

const UNSAFE_PATH = /["&^%`<>|]/;

async function addRepo(rawPath, group) {
  if (!rawPath || !path.isAbsolute(rawPath)) throw new HttpError(400, 'Use an absolute folder path');
  group = (group || '').trim() || 'Default';
  const top = await git(rawPath, ['rev-parse', '--show-toplevel']);
  if (top.code !== 0) throw new HttpError(400, 'Not a git repository');
  const repoPath = path.resolve(top.stdout.trim());
  if (UNSAFE_PATH.test(repoPath)) throw new HttpError(400, 'Path contains unsupported characters');
  const cfg = loadConfig();
  const id = lib.repoId(repoPath);
  if (cfg.groups.some((g) => g.repos.some((r) => lib.repoId(r.path) === id))) throw new HttpError(409, 'Repository already added');
  let g = cfg.groups.find((x) => x.name === group);
  if (!g) { g = { name: group, repos: [] }; cfg.groups.push(g); }
  g.repos.push({ path: repoPath });
  saveConfig(cfg);
  return { id, path: repoPath, group };
}

function removeRepo(id) {
  const cfg = loadConfig();
  for (const g of cfg.groups) g.repos = g.repos.filter((r) => lib.repoId(r.path) !== id);
  cfg.groups = cfg.groups.filter((g) => g.repos.length);
  cfg.snoozed = cfg.snoozed.filter((k) => !k.startsWith(`${id}:`));
  if (cfg.dismissed) cfg.dismissed = cfg.dismissed.filter((k) => k !== id);
  saveConfig(cfg);
  forgetMeta(id);
}

// A key ends in ":ready" when the PR was already ready at snooze time, so it is never auto-woken.
function setSnoozed(id, number, on, wasReady) {
  findRepo(id);
  if (!Number.isInteger(number) || number < 1) throw new HttpError(400, 'Invalid PR number');
  const key = `${id}:${number}`;
  const cfg = loadConfig();
  const rest = cfg.snoozed.filter((k) => k !== key && k !== `${key}:ready`);
  cfg.snoozed = on ? [...rest, wasReady ? `${key}:ready` : key] : rest;
  saveConfig(cfg);
  return { snoozed: cfg.snoozed };
}

// Hides (or shows again) the "requirements missing" warning of one repo.
function setDismissed(id, on) {
  findRepo(id);
  const cfg = loadConfig();
  const rest = (cfg.dismissed || []).filter((k) => k !== id);
  cfg.dismissed = on ? [...rest, id] : rest;
  saveConfig(cfg);
  return { dismissed: cfg.dismissed };
}

function scanFolder(dir) {
  if (!dir || !path.isAbsolute(dir) || !fs.existsSync(dir)) throw new HttpError(400, 'Folder not found');
  const known = new Set(loadConfig().groups.flatMap((g) => g.repos.map((r) => lib.repoId(r.path))));
  const isRepo = (p) => fs.existsSync(path.join(p, '.git'));
  const dirs = isRepo(dir) ? [dir] : fs.readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory()).map((e) => path.join(dir, e.name)).filter(isRepo);
  return dirs.slice(0, 200).map((p) => ({ path: p, added: known.has(lib.repoId(p)) }));
}

module.exports = { addRepo, removeRepo, setSnoozed, setDismissed, scanFolder };
