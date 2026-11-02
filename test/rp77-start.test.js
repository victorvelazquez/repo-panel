'use strict';
// RP77 (S68, S71): the read-only answer of a folder shares the 1 s list and the cached screens. (The start tests went with `startSession`, RPC2-1.)
// A fake Orca counting every call (list, show, create), temp dirs, no real Orca, no real session, no waiting.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'rp77s-'));
const sessionsBase = path.join(scratch, 'sessions');
const repoDir = path.join(scratch, 'My Repo.Api');
for (const d of [sessionsBase, repoDir]) fs.mkdirSync(d);
const configFile = path.join(scratch, 'config.json');
process.env.REPO_PANEL_CONFIG = configFile;
process.env.REPO_PANEL_SESSIONS_DIR = sessionsBase;
process.env.REPO_PANEL_CASES_FILE = 'off';
test.after(() => fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 5 }));

const lib = require('../lib.js');
const S = require('../server/sessions.js');
const { clearLiveCache } = require('../server/pi.js');
const REPO_ID = lib.repoId(repoDir);
fs.writeFileSync(configFile, JSON.stringify({ port: 4310, groups: [{ name: 'G', repos: [{ path: repoDir }] }], rooms: [] }));

const IDLE = '▎ ✿ waiting for input\n▎   type, or / for commands\n▎\n~\\proj (main) • panel:demo\n';

// `create` adds an idle session terminal to the world, as Orca does. Every call is recorded.
function fakeOrca() {
  const world = {};
  const calls = [];
  let at = 100;
  const orca = async (args) => {
    calls.push(args);
    if (args[0] === 'list') return { terminals: Object.keys(world).map((handle) => ({ handle, worktreePath: repoDir, connected: true, writable: true, lastOutputAt: world[handle].at })) };
    if (args[0] === 'show') return { terminal: { preview: world[args[2]].preview } };
    if (args[0] === 'create') { const handle = `t${calls.length}`; world[handle] = { preview: IDLE, at: ++at }; return { terminal: { handle } }; }
    throw new Error(`unexpected ${args[0]}`);
  };
  const count = (verb) => calls.filter((c) => c[0] === verb).length;
  return { orca, world, calls, lists: () => count('list'), shows: () => count('show'), creates: () => count('create') };
}
test.beforeEach(() => { clearLiveCache(); });

test('the read-only answer of a folder is unchanged: still shared and cached', async () => {
  const f = fakeOrca();
  f.world.t0 = { preview: IDLE, at: 7 };
  const a = await S.sessionsState(REPO_ID, f.orca, sessionsBase);
  const b = await S.sessionsState(REPO_ID, f.orca, sessionsBase);
  assert.deepEqual(a.live, b.live);
  assert.deepEqual([f.lists(), f.shows()], [1, 1]);
});
