'use strict';
// Rooms: a room is a repo where the user coordinates a group of repos. This reports each room's requirements,
// whether a pi session is open in its folder and the date of its last commit. Read-only: Orca is only listed
// and shown (never sent to) and Git only reads.
const lib = require('../lib.js');
const { git } = require('./exec.js');
const { loadConfig } = require('./config.js');
const { orcaTerminal } = require('./pi.js');
const { roomRequirementsFor } = require('./requirements.js');

// closed | idle | busy | ambiguous | unknown. `terminals` is null when Orca could not be listed: that is
// unknown, never closed. The state is read from a fresh `show` (the `list` preview is truncated); a prompt
// with text typed in it is still a session waiting for input, so it counts as idle.
async function presenceOf(room, terminals, orca) {
  if (!terminals) return { state: 'unknown', sessions: null };
  const mine = lib.piTerminalsFor(terminals, room.path);
  if (!mine.length) return { state: 'closed', sessions: 0 };
  if (mine.length > 1) return { state: 'ambiguous', sessions: mine.length };
  try {
    const shown = await orca(['show', '--terminal', mine[0].handle]);
    return { state: lib.piPromptState((shown.terminal || {}).preview) === 'busy' ? 'busy' : 'idle', sessions: 1 };
  } catch { return { state: 'unknown', sessions: null }; }
}

// ISO date of the last commit of the room's local HEAD, or null when Git cannot say.
async function lastCommitOf(room, gitRun) {
  const r = await gitRun(room.path, ['log', '-1', '--format=%cI', 'HEAD']).catch(() => null);
  const text = r && r.code === 0 ? r.stdout.trim() : '';
  return /^\d{4}-\d\d-\d\dT/.test(text) ? text : null;
}

// The runners are injectable so tests need neither Orca nor real repos.
async function roomsState({ rooms = loadConfig().rooms || [], orca = orcaTerminal, git: gitRun = git, requirements = roomRequirementsFor } = {}) {
  if (!rooms.length) return { rooms: [] };
  let terminals = null;
  try {
    const listed = (await orca(['list'])).terminals;
    if (Array.isArray(listed)) terminals = listed;
  } catch { /* Orca unavailable: presence stays unknown */ }
  return {
    rooms: await Promise.all(rooms.map(async (room) => {
      const [req, presence, lastCommit] = await Promise.all([requirements(room), presenceOf(room, terminals, orca), lastCommitOf(room, gitRun)]);
      return {
        name: room.name, path: room.path, repos: room.repos,
        available: req.available, base: req.base, results: req.results, summary: req.summary,
        presence, lastCommit,
      };
    })),
  };
}

module.exports = { roomsState };
