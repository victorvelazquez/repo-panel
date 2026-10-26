'use strict';
// RP34: /flow-base is judged by what it was asked to do, not by what the repo looks like later. A tree that was clean
// when the command was sent and is dirty now means the person started working on the fresh base branch: that is a
// finished /flow-base, not a failed one.
const test = require('node:test');
const assert = require('node:assert/strict');
const { flowVerdict } = require('../public/view.js');

const NOW = 10_000_000;
const file = { path: 'a.txt', status: 'M', untracked: false };
const local = (o = {}) => ({ branch: 'main', detached: false, upstream: 'origin/main', noUpstream: false, ahead: 0, behind: 0, files: [], head: 'h1', inProgress: null, base: 'main', stagedCount: 0, stagedPaths: [], ...o });
const sent = (cmd, o = {}) => ({ cmd, at: NOW - 10 * 60_000, head: 'h1', branch: 'task', files: 0, ahead: 0, busySeen: true, ...o });
const verdict = (s, l, session) => flowVerdict(s, l, session, { prs: [], stale: null }, NOW);

test('a clean tree at send time that is dirty now on the up-to-date base branch is a finished /flow-base', () => {
  const v = verdict(sent('flow-base'), local({ files: [file, file, file, file] }), 'idle');
  assert.equal(v.state, 'ok');
  assert.equal(v.reason, '/flow-base done');
});

test('the same holds when the session is closed or its state is unknown', () => {
  const dirty = local({ files: [file] });
  assert.equal(verdict(sent('flow-base'), dirty, 'closed').state, 'ok');
  assert.equal(verdict(sent('flow-base'), dirty, 'unknown').state, 'ok');
});

test('a tree that was already dirty when /flow-base was sent and still is stays an attention', () => {
  const v = verdict(sent('flow-base', { files: 3 }), local({ files: [file] }), 'idle');
  assert.equal(v.state, 'attention');
  assert.equal(v.reason, 'Not on a clean, up-to-date main after /flow-base');
});

test('a record without the file count keeps the strict reading (a dirty tree is an attention)', () => {
  const s = sent('flow-base');
  delete s.files;
  assert.equal(verdict(s, local({ files: [file] }), 'idle').state, 'attention');
});

test('being dirty never hides the other failures: not on the base branch, behind or ahead', () => {
  const dirty = [file];
  assert.equal(verdict(sent('flow-base'), local({ files: dirty, branch: 'task' }), 'idle').state, 'attention');
  assert.equal(verdict(sent('flow-base'), local({ files: dirty, behind: 2 }), 'idle').state, 'attention');
  assert.equal(verdict(sent('flow-base'), local({ files: dirty, ahead: 1 }), 'idle').state, 'attention');
});

test('a clean up-to-date base branch is still ok, and /flow-base --stash is unchanged', () => {
  assert.equal(verdict(sent('flow-base'), local(), 'idle').state, 'ok');
  assert.equal(verdict(sent('flow-base-stash', { files: 3 }), local({ files: [file] }), 'idle').state, 'ok');
  assert.equal(verdict(sent('flow-base-stash'), local({ branch: 'task' }), 'idle').state, 'attention');
});
