'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { roomsState } = require('../server/rooms.js');

const IDLE_PI = '▎ ✿ waiting for input\n▎   type, or / for commands\n▎\n';
const TYPED_PI = '▎ ✿ waiting for input\n▎ half a sentence\n▎\n';
const PLAIN_PS = 'PS C:\\dev\\ceo> git status\nnothing to commit\nPS C:\\dev\\ceo> ';
const BUSY_PI = '▎ ❁ working…\n▎   type, or / for commands\n▎\n';
const ROOM = { name: 'UPEN', path: 'C:\\dev\\ceo', repos: ['a', 'b'] };
const piTerm = (o = {}) => ({ handle: 'h1', title: 'Terminal 1', worktreePath: 'C:/dev/ceo', connected: true, writable: true, ...o });
const REQ = { available: true, base: 'main', results: [{ id: 'room-base-branch', status: 'pass' }], summary: { ready: true } };
const requirements = async () => REQ;
const gitAt = (stdout = '2026-10-24T10:00:00-05:00\n', code = 0) => {
  const calls = [];
  const run = async (cwd, args) => { calls.push({ cwd, args }); return { code, stdout, stderr: '' }; };
  return Object.assign(run, { calls });
};

// A fake Orca: `terminals` is what `list` returns, `preview` what every `show` returns (or `screens[handle]`);
// `fail` makes a verb throw and `failShow` makes the `show` of those handles throw.
function fakeOrca({ terminals = [], preview = IDLE_PI, fail = null, screens = null, failShow = [] } = {}) {
  const calls = [];
  const orca = async (args) => {
    calls.push(args);
    if (fail === args[0] || fail === 'all') throw new Error('Orca CLI is unavailable');
    if (args[0] === 'list') return typeof terminals === 'function' ? terminals() : { terminals };
    if (args[0] === 'show' && failShow.includes(args[2])) throw new Error('Orca could not show that terminal');
    if (args[0] === 'show') return { terminal: { preview: screens ? screens[args[2]] : preview } };
    throw new Error(`unexpected orca verb ${args[0]}`);
  };
  return { orca, calls };
}

const state = async (orcaOpts, room = ROOM) => {
  const f = fakeOrca(orcaOpts);
  const out = await roomsState({ rooms: [room], orca: f.orca, git: gitAt(), requirements });
  return { room: out.rooms[0], calls: f.calls };
};

test('roomsState: no rooms answers an empty list without touching Orca or Git', async () => {
  const f = fakeOrca();
  const g = gitAt();
  assert.deepEqual(await roomsState({ rooms: [], orca: f.orca, git: g, requirements }), { rooms: [] });
  assert.deepEqual([f.calls.length, g.calls.length], [0, 0]);
});

test('roomsState: a room reports its config, requirements and last commit, and no presence', async () => {
  const { room } = await state({ terminals: [piTerm()] });
  assert.deepEqual(Object.keys(room).sort(), ['available', 'base', 'lastCommit', 'name', 'path', 'repos', 'results', 'summary']);
  assert.deepEqual([room.name, room.path, room.repos], ['UPEN', 'C:\\dev\\ceo', ['a', 'b']]);
  assert.deepEqual([room.available, room.base, room.results, room.summary], [true, 'main', REQ.results, REQ.summary]);
});

test('lastCommit: the ISO date of the room HEAD, or null when Git cannot say', async () => {
  const g = gitAt();
  const ok = await roomsState({ rooms: [ROOM], orca: fakeOrca().orca, git: g, requirements });
  assert.equal(ok.rooms[0].lastCommit, '2026-10-24T10:00:00-05:00');
  assert.equal(g.calls.length, 1);
  assert.equal(g.calls[0].cwd, ROOM.path);
  assert.deepEqual(g.calls[0].args, ['log', '-1', '--format=%cI', 'HEAD']);
  for (const bad of [gitAt('', 128), gitAt('\n', 0), gitAt('not a date', 0)]) {
    assert.equal((await roomsState({ rooms: [ROOM], orca: fakeOrca().orca, git: bad, requirements })).rooms[0].lastCommit, null);
  }
});

test('roomsState: each room has its own requirements and last commit; Orca is never called', async () => {
  const other = { name: 'TOOLS', path: 'C:\dev\tools', repos: [] };
  const f = fakeOrca({ terminals: [piTerm()] });
  const out = await roomsState({ rooms: [ROOM, other], orca: f.orca, git: gitAt(), requirements });
  assert.deepEqual(out.rooms.map((r) => [r.name, r.available, 'presence' in r]), [['UPEN', true, false], ['TOOLS', true, false]]);
  assert.deepEqual(f.calls, []);
});
