'use strict';
// Config file: groups of repos, rooms, snoozed PRs, dismissed warnings, adopted pi sessions and the manual priority order. REPO_PANEL_CONFIG picks the file.
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

const ROOM_NAME_MAX = 60;

// Why a (trimmed) room name cannot be used, or null. `taken` holds the lowercase names already in use.
function nameProblem(name, taken) {
  if (!name) return 'name is empty';
  if (name.length > ROOM_NAME_MAX) return `name is longer than ${ROOM_NAME_MAX} characters`;
  if (taken.has(name.toLowerCase())) return 'name is already used by another room';
  return null;
}

const pathProblem = (p) => (typeof p === 'string' && path.isAbsolute(p) ? null : 'path must be absolute');

const ROOMS_NOT_LIST = 'rooms: must be a list';

// Held under a symbol so it is never written to the file: what loadConfig could not use, kept for saveConfig.
const ROOM_INFO = Symbol('rooms');

// A room is a repo where the user coordinates a group of repos: { name, path (absolute), repos: [repoId] }.
// Names are unique (case-insensitive, first wins) and a repo id belongs to at most one room. An entry the panel
// does not understand is not used, but it is reported in `issues` and kept in `invalid` (with its position) so
// that a save writes it back untouched: a typo must never erase a room.
function cleanRooms(list) {
  const names = new Set();
  const members = new Set();
  const rooms = [];
  const issues = [];
  const invalid = [];
  list.forEach((r, index) => {
    let problem = null;
    if (!r || typeof r !== 'object' || Array.isArray(r)) problem = 'entry is not an object';
    else if (typeof r.name !== 'string') problem = 'name must be text';
    else if (typeof r.path !== 'string') problem = 'path must be text';
    else problem = nameProblem(r.name.trim(), names) || pathProblem(r.path);
    if (problem) { issues.push(`rooms[${index}]: ${problem}`); invalid.push({ index, raw: r }); return; }
    const name = r.name.trim();
    names.add(name.toLowerCase());
    const repos = cleanIds(Array.isArray(r.repos) ? r.repos : []).filter((id) => !members.has(id));
    for (const id of repos) members.add(id);
    rooms.push({ name, path: r.path, repos });
  });
  return { rooms, issues, invalid };
}

const SESSION_ID = /^[A-Za-z0-9._-]{1,80}$/;

// Adopted pi sessions, { "<repoId>" | "room:<name>": { id, name, adoptedAt } }; an invalid entry is ignored.
function cleanSessions(map) {
  const out = {};
  if (!map || typeof map !== 'object' || Array.isArray(map)) return out;
  for (const [key, v] of Object.entries(map)) {
    if (!key || !v || typeof v !== 'object' || typeof v.id !== 'string' || !SESSION_ID.test(v.id)) continue;
    if (typeof v.name !== 'string' || typeof v.adoptedAt !== 'string' || Number.isNaN(Date.parse(v.adoptedAt))) continue;
    out[key] = { id: v.id, name: v.name.replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, 100), adoptedAt: v.adoptedAt };
  }
  return out;
}

function loadConfig() {
  let cfg = {};
  try { cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); } catch { /* first run */ }
  const cleaned = Array.isArray(cfg.rooms) ? cleanRooms(cfg.rooms) : null;
  const out = {
    port: Number(cfg.port) || 4310,
    groups: Array.isArray(cfg.groups) ? cfg.groups.map((g) => ({
      name: String(g.name),
      repos: (g.repos || []).map(loadRepo),
    })) : [],
    // PRs the user parked, as "<repoId>:<number>" keys.
    snoozed: Array.isArray(cfg.snoozed) ? cfg.snoozed.filter((k) => typeof k === 'string') : [],
    // Repos whose "requirements missing" warning the user hid; written back only when present.
    ...(Array.isArray(cfg.dismissed) ? { dismissed: cleanIds(cfg.dismissed) } : {}),
    // Rooms the user declared by hand; written back only when present.
    ...(cleaned ? { rooms: cleaned.rooms } : {}),
    // The pi session the panel adopted per repo and room; written back only when present.
    ...(cfg.sessions !== undefined ? { sessions: cleanSessions(cfg.sessions) } : {}),
    // Optional manual order of the "Go work on" strip; written back only when present.
    ...(Array.isArray(cfg.priority) ? { priority: cleanPriority(cfg.priority) } : {}),
  };
  if (cleaned) out[ROOM_INFO] = { issues: cleaned.issues, invalid: cleaned.invalid };
  else if (cfg.rooms !== undefined) out[ROOM_INFO] = { issues: [ROOMS_NOT_LIST], invalid: [], notList: { value: cfg.rooms } };
  return out;
}

// Short reasons for the `rooms` entries of config.json that the panel ignores (empty when all are fine).
const roomIssues = (cfg) => (cfg[ROOM_INFO] ? cfg[ROOM_INFO].issues : []);

// Puts the ignored room entries back where they were, and a `rooms` that was not a list back as it was.
function withIgnoredRooms(cfg) {
  const info = cfg[ROOM_INFO];
  if (!info) return cfg;
  if (info.notList) return cfg.rooms === undefined ? { ...cfg, rooms: info.notList.value } : cfg;
  if (!info.invalid.length || !Array.isArray(cfg.rooms)) return cfg;
  const rooms = cfg.rooms.slice();
  for (const { index, raw } of info.invalid) rooms.splice(Math.min(index, rooms.length), 0, raw);
  return { ...cfg, rooms };
}

function saveConfig(cfg) {
  const tmp = `${CONFIG_PATH}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(withIgnoredRooms(cfg), null, 2));
  fs.renameSync(tmp, CONFIG_PATH);
}

function findRepo(id) {
  for (const g of loadConfig().groups) {
    for (const r of g.repos) if (lib.repoId(r.path) === id) return { ...r, id, group: g.name };
  }
  throw new HttpError(404, 'Unknown repository');
}

// The room a repo belongs to, or null.
function roomOf(id) {
  return (loadConfig().rooms || []).find((r) => r.repos.includes(id)) || null;
}

// Paths compare by text: slashes, trailing slashes and case do not matter (no path.resolve, so it behaves the same on Linux).
const normPath = (p) => String(p).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();

// The room whose folder is `p`, or null. The repo that is a room's folder is the room itself, not one of its members.
function roomByPath(p) {
  if (typeof p !== 'string' || !p) return null;
  const want = normPath(p);
  return (loadConfig().rooms || []).find((r) => normPath(r.path) === want) || null;
}

module.exports = { loadConfig, saveConfig, findRepo, roomOf, roomByPath, roomIssues, nameProblem, pathProblem, ROOM_NAME_MAX, ROOMS_NOT_LIST };
