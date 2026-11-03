'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { roomsState } = require('../server/rooms.js');

const ROOM = { name: 'UPEN', path: 'C:\\dev\\ceo', repos: ['a', 'b'] };
const REQ = { available: true, base: 'main', results: [{ id: 'room-base-branch', status: 'pass' }], summary: { ready: true } };
const requirements = async () => REQ;
const gitAt = (stdout = '2026-10-24T10:00:00-05:00\n', code = 0) => {
  const calls = [];
  const run = async (cwd, args) => { calls.push({ cwd, args }); return { code, stdout, stderr: '' }; };
  return Object.assign(run, { calls });
};

const state = async (room = ROOM) => ({ room: (await roomsState({ rooms: [room], git: gitAt(), requirements })).rooms[0] });

test('roomsState: no rooms answers an empty list without touching Git', async () => {
  const g = gitAt();
  assert.deepEqual(await roomsState({ rooms: [], git: g, requirements }), { rooms: [] });
  assert.equal(g.calls.length, 0);
});

test('roomsState: a room reports its config, requirements and last commit, and no presence', async () => {
  const { room } = await state();
  assert.deepEqual(Object.keys(room).sort(), ['available', 'base', 'lastCommit', 'name', 'path', 'repos', 'results', 'summary']);
  assert.deepEqual([room.name, room.path, room.repos], ['UPEN', 'C:\\dev\\ceo', ['a', 'b']]);
  assert.deepEqual([room.available, room.base, room.results, room.summary], [true, 'main', REQ.results, REQ.summary]);
});

test('lastCommit: the ISO date of the room HEAD, or null when Git cannot say', async () => {
  const g = gitAt();
  const ok = await roomsState({ rooms: [ROOM], git: g, requirements });
  assert.equal(ok.rooms[0].lastCommit, '2026-10-24T10:00:00-05:00');
  assert.equal(g.calls.length, 1);
  assert.equal(g.calls[0].cwd, ROOM.path);
  assert.deepEqual(g.calls[0].args, ['log', '-1', '--format=%cI', 'HEAD']);
  for (const bad of [gitAt('', 128), gitAt('\n', 0), gitAt('not a date', 0)]) {
    assert.equal((await roomsState({ rooms: [ROOM], git: bad, requirements })).rooms[0].lastCommit, null);
  }
});

test('roomsState: each room has its own requirements and last commit', async () => {
  const other = { name: 'TOOLS', path: 'C:\dev\tools', repos: [] };
  const out = await roomsState({ rooms: [ROOM, other], git: gitAt(), requirements });
  assert.deepEqual(out.rooms.map((r) => [r.name, r.available, 'presence' in r]), [['UPEN', true, false], ['TOOLS', true, false]]);
});
