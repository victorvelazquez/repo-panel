'use strict';
// RP25 (S23): where each repo's local card goes on the new board. Pure logic in public/view.js.
// boardPlacement wraps localPlacement (which stays as it was) and adds the Merged, Needs attention and Idle places.
const test = require('node:test');
const assert = require('node:assert/strict');
const view = require('../public/view.js');

const { localPlacement, boardPlacement, boardColumns } = view;

const file = { path: 'a.txt', status: 'M', untracked: false };
const local = (o = {}) => ({ branch: 'task', detached: false, upstream: 'origin/task', noUpstream: false, ahead: 0, behind: 0, files: [], head: 'h1', inProgress: null, base: 'main', ...o });
const stale = { via: 'merged', pr: 7, reason: 'Merged: run /flow-base' };
const none = { prs: [], stale: null };
const withStale = { prs: [], stale };

const CASES = [
  // [name, local, prInfo, prCount, verdict, expected in the default layout, expected with cleanAsColumn]
  ['stale branch, clean tree, nothing ahead', local({ currentGone: true }), withStale, 0, null,
    { column: 'merged', attn: true, row: false }, { column: 'merged', attn: true, row: false }],
  ['stale branch with uncommitted files', local({ files: [file], currentGone: true }), withStale, 0, null,
    { column: 'changes', attn: true, row: false }, { column: 'changes', attn: true, row: false }],
  ['stale branch with commits ahead', local({ ahead: 1, currentGone: true }), withStale, 0, null,
    { column: 'committed', attn: true, row: false }, { column: 'committed', attn: true, row: false }],
  ['manual action (detached HEAD), clean tree', local({ branch: null, detached: true }), none, 0, null,
    { column: 'attention', attn: true, row: false }, { column: 'clean', attn: true, row: false }],
  ['manual action (rebase in progress), clean tree', local({ inProgress: 'rebase' }), none, 0, null,
    { column: 'attention', attn: true, row: false }, { column: 'clean', attn: true, row: false }],
  ['failed /flow-commit with a clean tree', local(), none, 0, 'attention',
    { column: 'attention', attn: true, row: false }, { column: 'clean', attn: true, row: false }],
  ['quiet repo, no PR', local({ branch: 'main', upstream: 'origin/main' }), none, 0, null,
    { column: 'idle', attn: false, row: true }, { column: 'clean', attn: false, row: true }],
  ['quiet repo with an open PR has no local card', local(), none, 1, null,
    { column: null, attn: false, row: false }, { column: null, attn: false, row: false }],
  ['uncommitted files', local({ files: [file] }), none, 0, null,
    { column: 'changes', attn: false, row: false }, { column: 'changes', attn: false, row: false }],
  ['commits ahead', local({ ahead: 2 }), none, 0, null,
    { column: 'committed', attn: false, row: false }, { column: 'committed', attn: false, row: false }],
  ['git error', { error: 'boom' }, none, 0, null,
    { column: 'changes', attn: true, row: false }, { column: 'changes', attn: true, row: false }],
  ['failed /flow-commit with files left stays in changes', local({ files: [file] }), none, 0, 'attention',
    { column: 'changes', attn: true, row: false }, { column: 'changes', attn: true, row: false }],
  ['running /flow-commit with a clean tree is not an attention card', local(), none, 0, 'running',
    { column: 'idle', attn: false, row: true }, { column: 'clean', attn: false, row: true }],
];

for (const [name, l, p, n, verdict, normal, asColumn] of CASES) {
  test(`boardPlacement: ${name}`, () => {
    assert.deepEqual(boardPlacement(l, p, n, verdict, false), normal, 'default layout');
    assert.deepEqual(boardPlacement(l, p, n, verdict), normal, 'the option absent means the default layout');
    assert.deepEqual(boardPlacement(l, p, n, verdict, true), asColumn, 'cleanAsColumn: true');
  });
}

test('boardPlacement with cleanAsColumn matches the previous localPlacement for everything but a stale-clean repo', () => {
  for (const [name, l, p, n, verdict] of CASES) {
    const before = localPlacement(l, p, n, verdict);
    const now = boardPlacement(l, p, n, verdict, true);
    if (name.startsWith('stale branch, clean tree')) { assert.equal(before.column, 'clean'); assert.equal(now.column, 'merged'); continue; }
    assert.deepEqual(now, before, name);
  }
});

test('no card that needs a person can end up in the idle bar: attn is never combined with the idle place', () => {
  const states = [local(), local({ branch: null, detached: true }), local({ inProgress: 'merge' }), local({ branch: 'main', ahead: 0, upstream: 'origin/main' }), local({ currentGone: true })];
  for (const l of states) for (const p of [none, withStale]) for (const n of [0, 1]) for (const v of [null, 'running', 'attention']) for (const col of [false, true]) {
    const place = boardPlacement(l, p, n, v, col);
    if (place.attn) assert.notEqual(place.column, 'idle', JSON.stringify({ l, p, n, v, col }));
    if (place.column === 'idle') assert.equal(place.row, true);
  }
});

test('localPlacement itself is unchanged: a stale clean repo is still a clean-column card there', () => {
  assert.deepEqual(localPlacement(local({ currentGone: true }), withStale, 0, null), { column: 'clean', attn: true, row: false });
});

test('boardColumns: default layout has Needs attention first only when it has cards, Merged last, no Clean', () => {
  assert.deepEqual(boardColumns(false, 0), ['changes', 'committed', 'progress', 'ready', 'merged']);
  assert.deepEqual(boardColumns(false, 3), ['attention', 'changes', 'committed', 'progress', 'ready', 'merged']);
  assert.deepEqual(boardColumns(), ['changes', 'committed', 'progress', 'ready', 'merged']);
});

test('boardColumns: cleanAsColumn puts Clean first and never shows Needs attention', () => {
  assert.deepEqual(boardColumns(true, 0), ['clean', 'changes', 'committed', 'progress', 'ready', 'merged']);
  assert.deepEqual(boardColumns(true, 5), ['clean', 'changes', 'committed', 'progress', 'ready', 'merged']);
});
