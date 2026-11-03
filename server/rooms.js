'use strict';
// Rooms: a room is a repo where the user coordinates a group of repos. This reports each room's requirements and the date
// of its last commit (RPC2b-1: no session state any more). Read-only: Git only reads. It also edits the panel's own config.json (create, remove and
// assign a room); a room folder is only looked at, never written.
const fs = require('node:fs');
const path = require('node:path');
const { HttpError } = require('./errors.js');
const { git } = require('./exec.js');
const { loadConfig, saveConfig, findRepo, roomIssues, nameProblem, pathProblem, ROOMS_NOT_LIST } = require('./config.js');
const { roomRequirementsFor } = require('./requirements.js');

// ISO date of the last commit of the room's local HEAD, or null when Git cannot say.
async function lastCommitOf(room, gitRun) {
  const r = await gitRun(room.path, ['log', '-1', '--format=%cI', 'HEAD']).catch(() => null);
  const text = r && r.code === 0 ? r.stdout.trim() : '';
  return /^\d{4}-\d\d-\d\dT/.test(text) ? text : null;
}

// The runners are injectable so tests need no real repos.
async function roomsState({ rooms = loadConfig().rooms || [], git: gitRun = git, requirements = roomRequirementsFor } = {}) {
  if (!rooms.length) return { rooms: [] };
  return {
    rooms: await Promise.all(rooms.map(async (room) => {
      const [req, lastCommit] = await Promise.all([requirements(room), lastCommitOf(room, gitRun)]);
      return {
        name: room.name, path: room.path, repos: room.repos,
        available: req.available, base: req.base, results: req.results, summary: req.summary,
        lastCommit,
      };
    })),
  };
}

const upper = (s) => s[0].toUpperCase() + s.slice(1);

// A room folder must exist, be a directory and be a git repo (a `.git` entry), like the repo scan checks.
function folderProblem(dir) {
  let stat = null;
  try { stat = fs.statSync(dir); } catch { return 'folder not found'; }
  if (!stat.isDirectory()) return 'path is not a folder';
  return fs.existsSync(path.join(dir, '.git')) ? null : 'folder is not a git repository';
}

function editableRooms(cfg) {
  if (roomIssues(cfg).includes(ROOMS_NOT_LIST)) throw new HttpError(409, 'rooms in config.json is not a list: fix it by hand first');
  return cfg.rooms || [];
}

const roomNamed = (rooms, name) => rooms.find((r) => r.name.toLowerCase() === String(name).trim().toLowerCase());

// Registers a room in the config. Never touches the folder.
function createRoom(rawName, rawPath) {
  const cfg = loadConfig();
  const rooms = editableRooms(cfg);
  const name = typeof rawName === 'string' ? rawName.trim() : '';
  const problem = nameProblem(name, new Set(rooms.map((r) => r.name.toLowerCase())))
    || pathProblem(rawPath) || folderProblem(rawPath);
  if (problem) throw new HttpError(400, upper(problem));
  cfg.rooms = [...rooms, { name, path: path.resolve(rawPath), repos: [] }];
  saveConfig(cfg);
  return { rooms: cfg.rooms };
}

// Forgets a room; its members become unassigned. Only the config entry goes.
function removeRoom(rawName) {
  const cfg = loadConfig();
  const rooms = editableRooms(cfg);
  const room = roomNamed(rooms, rawName);
  if (!room) throw new HttpError(404, 'Unknown room');
  cfg.rooms = rooms.filter((r) => r !== room);
  saveConfig(cfg);
  return { rooms: cfg.rooms };
}

// Puts a repo in a room (by name) or in none (null), taking it out of any other room first.
function assignRoom(id, rawRoom) {
  findRepo(id);
  const cfg = loadConfig();
  const rooms = editableRooms(cfg);
  const target = rawRoom === null || rawRoom === undefined ? null : roomNamed(rooms, rawRoom);
  if (rawRoom !== null && rawRoom !== undefined && !target) throw new HttpError(404, 'Unknown room');
  cfg.rooms = rooms.map((r) => {
    const rest = r.repos.filter((x) => x !== id);
    return { ...r, repos: r === target ? [...rest, id] : rest };
  });
  saveConfig(cfg);
  return { rooms: cfg.rooms };
}

module.exports = { roomsState, createRoom, removeRoom, assignRoom };
