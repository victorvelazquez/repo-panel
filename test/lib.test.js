'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const lib = require('../lib.js');

test('parseStatus reads branch, upstream, ahead/behind and files', () => {
  const out = [
    '# branch.oid abc', '# branch.head feat/x', '# branch.upstream origin/feat/x', '# branch.ab +2 -1',
    '1 .M N... 100644 100644 100644 a b src/a.js',
    '1 A. N... 000000 100644 100644 a b my file.txt',
    '2 R. N... 100644 100644 100644 a b R100 new.js\told.js',
    '? untracked.txt',
  ].join('\n');
  const s = lib.parseStatus(out);
  assert.equal(s.branch, 'feat/x');
  assert.equal(s.upstream, 'origin/feat/x');
  assert.deepEqual([s.ahead, s.behind, s.hasAb], [2, 1, true]);
  assert.deepEqual(s.files.map((f) => f.path), ['src/a.js', 'my file.txt', 'new.js', 'untracked.txt']);
});

test('parseStatus without upstream has no ahead/behind info', () => {
  const s = lib.parseStatus('# branch.oid abc\n# branch.head main\n');
  assert.equal(s.upstream, null);
  assert.equal(s.hasAb, false);
  assert.equal(s.files.length, 0);
});

test('parseNumstat handles text and binary files', () => {
  const m = lib.parseNumstat('3\t1\ta.js\n-\t-\timg.png\n');
  assert.deepEqual(m.get('a.js'), { added: 3, deleted: 1, binary: false });
  assert.deepEqual(m.get('img.png'), { added: 0, deleted: 0, binary: true });
});

test('parseGoneBranches only returns branches whose upstream is gone', () => {
  const out = 'main\t\nfeat-a\t[gone]\nfeat-b\t[ahead 1]\n';
  assert.deepEqual(lib.parseGoneBranches(out), ['feat-a']);
});

test('summarizeChecks: all green, pending, failed, none', () => {
  const ok = { __typename: 'CheckRun', name: 'ci', status: 'COMPLETED', conclusion: 'SUCCESS' };
  const skipped = { __typename: 'CheckRun', name: 's', status: 'COMPLETED', conclusion: 'SKIPPED' };
  const running = { __typename: 'CheckRun', name: 'r', status: 'IN_PROGRESS', conclusion: '' };
  const bad = { __typename: 'CheckRun', name: 'b', status: 'COMPLETED', conclusion: 'FAILURE', detailsUrl: 'https://github.com/o/r/actions/runs/123/job/9' };
  assert.equal(lib.summarizeChecks([ok, skipped]).state, 'success');
  assert.equal(lib.summarizeChecks([ok, running]).state, 'pending');
  const failed = lib.summarizeChecks([ok, running, bad]);
  assert.equal(failed.state, 'failed');
  assert.deepEqual(failed.failedRuns, ['123']);
  assert.equal(lib.summarizeChecks([]).state, 'none');
});

test('summarizeChecks understands legacy status contexts', () => {
  assert.equal(lib.summarizeChecks([{ __typename: 'StatusContext', context: 'x', state: 'SUCCESS' }]).state, 'success');
  assert.equal(lib.summarizeChecks([{ __typename: 'StatusContext', context: 'x', state: 'PENDING' }]).state, 'pending');
  assert.equal(lib.summarizeChecks([{ __typename: 'StatusContext', context: 'x', state: 'ERROR' }]).state, 'failed');
});

test('blockedReason: ready only when green, clean and not draft', () => {
  const green = { state: 'success' };
  const base = { isDraft: false, mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN' };
  assert.equal(lib.blockedReason(base, green), null);
  assert.equal(lib.blockedReason(base, { state: 'none' }), null);
  assert.ok(lib.blockedReason({ ...base, isDraft: true }, green));
  assert.ok(lib.blockedReason(base, { state: 'pending' }));
  assert.ok(lib.blockedReason(base, { state: 'failed' }));
  assert.ok(lib.blockedReason({ ...base, mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY' }, green));
  assert.ok(lib.blockedReason({ ...base, mergeStateStatus: 'BEHIND' }, green));
  assert.ok(lib.blockedReason({ ...base, mergeStateStatus: 'BLOCKED' }, green));
  assert.ok(lib.blockedReason({ ...base, mergeable: 'UNKNOWN', mergeStateStatus: 'UNKNOWN' }, green));
});

test('encodeRef keeps slashes and encodes the rest', () => {
  assert.equal(lib.encodeRef('feat/a b#1'), 'feat/a%20b%231');
});

test('repoId is stable and case-insensitive', () => {
  assert.equal(lib.repoId('C:\\Dev\\A'), lib.repoId('c:\\dev\\a'));
  assert.equal(lib.repoId('x').length, 10);
});

test('parseBaseBranch reads origin/HEAD and falls back to main', () => {
  assert.equal(lib.parseBaseBranch('refs/remotes/origin/develop\n'), 'develop');
  assert.equal(lib.parseBaseBranch('refs/remotes/origin/release/1.x\n'), 'release/1.x');
  assert.equal(lib.parseBaseBranch(''), 'main');
  assert.equal(lib.parseBaseBranch('garbage'), 'main');
});

test('staleBranch flags a working branch whose work was already merged', () => {
  const merged = { number: 12, url: 'u' };
  const gone = lib.staleBranch({ branch: 'docs/x', base: 'main', gone: true });
  assert.deepEqual(gone, { reason: 'Merged: run /flow-branch', via: 'gone', pr: null });
  const viaPr = lib.staleBranch({ branch: 'docs/x', base: 'main', mergedPr: merged });
  assert.deepEqual(viaPr, { reason: 'Merged: run /flow-branch', via: 'merged', pr: 12 });
});

test('staleBranch stays quiet when there is nothing to start over from', () => {
  const merged = { number: 12 };
  assert.equal(lib.staleBranch({ branch: 'main', base: 'main', gone: true, mergedPr: merged }), null);
  assert.equal(lib.staleBranch({ branch: null, base: 'main', gone: true }), null);
  assert.equal(lib.staleBranch({ branch: 'docs/x', base: 'main' }), null);
  // The branch name was reused for a new, still open PR.
  assert.equal(lib.staleBranch({ branch: 'docs/x', base: 'main', mergedPr: merged, openPrs: [{ head: 'docs/x' }] }), null);
  assert.notEqual(lib.staleBranch({ branch: 'docs/x', base: 'main', mergedPr: merged, openPrs: [{ head: 'other' }] }), null);
});
