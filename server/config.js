'use strict';
// Config file: groups of repos, snoozed PRs, dismissed warnings and the manual priority order. REPO_PANEL_CONFIG picks the file.
const fs = require('node:fs');
const path = require('node:path');
const lib = require('../lib.js');
const { HttpError } = require('./errors.js');

const ROOT = path.join(__dirname, '..');
const CONFIG_PATH = process.env.REPO_PANEL_CONFIG || path.join(ROOT, 'config.json');

// Keeps per-repo settings ("base": the branch work is merged into; "roadmap": its plan file) across a save.
function loadRepo(r) {
  if (typeof r === 'string') return { path: r };
  const roadmap = lib.safeRelPath(r.roadmap);
  return {
    path: r.path,
    ...(typeof r.base === 'string' && r.base ? { base: r.base } : {}),
    ...(roadmap ? { roadmap } : {}),
  };
}

function cleanPriority(list) {
  const seen = new Set();
  return list.filter((n) => typeof n === 'string').map((n) => n.trim())
    .filter((n) => n && !seen.has(n.toLowerCase()) && seen.add(n.toLowerCase()));
}

function cleanIds(list) {
  const seen = new Set();
  return list.filter((n) => typeof n === 'string' && n && !seen.has(n) && seen.add(n));
}

function loadConfig() {
  let cfg = {};
  try { cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); } catch { /* first run */ }
  return {
    port: Number(cfg.port) || 4310,
    groups: Array.isArray(cfg.groups) ? cfg.groups.map((g) => ({
      name: String(g.name),
      repos: (g.repos || []).map(loadRepo),
    })) : [],
    // PRs the user parked, as "<repoId>:<number>" keys.
    snoozed: Array.isArray(cfg.snoozed) ? cfg.snoozed.filter((k) => typeof k === 'string') : [],
    // Repos whose "requirements missing" warning the user hid; written back only when present.
    ...(Array.isArray(cfg.dismissed) ? { dismissed: cleanIds(cfg.dismissed) } : {}),
    // Optional manual order of the "Go work on" strip; written back only when present.
    ...(Array.isArray(cfg.priority) ? { priority: cleanPriority(cfg.priority) } : {}),
  };
}

function saveConfig(cfg) {
  const tmp = `${CONFIG_PATH}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2));
  fs.renameSync(tmp, CONFIG_PATH);
}

function findRepo(id) {
  for (const g of loadConfig().groups) {
    for (const r of g.repos) if (lib.repoId(r.path) === id) return { ...r, id, group: g.name };
  }
  throw new HttpError(404, 'Unknown repository');
}

module.exports = { loadConfig, saveConfig, findRepo };
