'use strict';
// RP218: the folder of a room is the room itself. It is one thing in the Summary (the room card, which opens the chat of its session), it is not a project in
// Conformity (no roadmap is asked of it) and GET /api/rooms carries its id.
const test = require('node:test');
const { after } = test;
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
// repoByPath reads the config of the panel: a temp one, set BEFORE the server modules load, with one repo in one group.
const ABC = path.join(os.tmpdir(), `rp218-abc-${process.pid}`);
const CFG = path.join(os.tmpdir(), `rp218-config-${process.pid}.json`);
fs.writeFileSync(CFG, JSON.stringify({ port: 4999, groups: [{ name: 'g', repos: [{ path: ABC }] }] }));
process.env.REPO_PANEL_CONFIG = CFG;
after(() => fs.rmSync(CFG, { force: true }));
const R = require('../public/resumen.js');
const V = require('../public/view.js');
const { roomsState } = require('../server/rooms.js');
const { repoByPath } = require('../server/config.js');
const { appSource } = require('./pagesrc.js');

const NOW = Date.parse('2026-05-01T12:00:00Z');
const REQ = async () => ({ available: true, base: 'main', results: [], summary: { ready: true } });
const GIT = async () => ({ code: 0, stdout: '2026-05-01T10:00:00+00:00\n' });

test('GET /api/rooms: each room carries the id of its folder when the folder is a repo of a group, else null', async () => {
  const rooms = [{ name: 'U', path: '/x/u', repos: [] }, { name: 'T', path: '/x/t', repos: [] }];
  const s = await roomsState({ rooms, git: GIT, requirements: REQ, repoOf: (p) => (p === '/x/u' ? { id: 'abc123' } : null) });
  assert.deepEqual(s.rooms.map((m) => m.id), ['abc123', null]);
  assert.deepEqual(s.rooms.map((m) => m.name), ['U', 'T']);
});

const card = (o = {}) => ({
  id: 'r1', name: 'alpha', group: 'G', room: null, branch: 'main', progress: { total: 4, completada: 1, enRevision: 0, bloqueada: 0, pendiente: 3, enCurso: 0 }, session: { state: 'free' },
  next: null, blocking: [], lastMovement: { at: '2026-05-01T11:48:00Z', what: 'x' }, action: null, error: null, needs: false, rank: 9, ...o,
});
const ROOM = { name: 'U', id: 'r9', path: '/x/u', repos: ['r1'], lastCommit: '2026-05-01T10:00:00Z' };
const view = (rows, ctx = {}) => R.summaryView({ rows, generatedAt: 'x' }, {
  now: NOW, scope: { kind: 'all' }, rooms: [{ name: 'U', repos: ['r1'] }], roomData: { rooms: [ROOM] }, ...ctx,
});
const articles = (html) => html.split('<article').slice(1);
const withId = (html, id) => articles(html).filter((c) => c.includes(`data-id="${id}"`));

test('the folder of a room is ONE thing in the Summary: the room card, which opens the chat of its folder; there is no second card for the folder', () => {
  const html = view([card({ id: 'r9', name: 'ceo' }), card({ id: 'r1', name: 'alpha', room: 'U' })]);
  const folder = withId(html, 'r9');
  assert.equal(folder.length, 1);
  assert.match(folder[0], /rs-room/);
  assert.match(folder[0], /data-act="chat-open" tabindex="0"/);
  assert.doesNotMatch(folder[0], /aria-current/);
  assert.equal(withId(html, 'r1').length, 1);
  assert.match(withId(view([card({ id: 'r9', name: 'ceo' }), card({ id: 'r1', room: 'U' })], { chatId: 'r9' }), 'r9')[0], /aria-current="true"/);
});

test('the room card counts the folder of its own session among the ones that need attention', () => {
  const rows = (needs) => [card({ id: 'r9', name: 'ceo', needs }), card({ id: 'r1', name: 'alpha', room: 'U' })];
  assert.match(view(rows(true)), /1 project · 1 need attention/);
  assert.match(view(rows(false)), /1 project · 0 need attention/);
});

test('a folder that is also a member of its own room is counted once among the ones that need attention', () => {
  const html = view([card({ id: 'r9', name: 'ceo', room: 'U', needs: true })]);
  assert.match(html, /1 project · 1 need attention/);
});

test('the id of a room is escaped in data-id (a payload with HTML never reaches the page as markup)', () => {
  const html = view([card({ id: 'r1', room: 'U' })], { roomData: { rooms: [{ ...ROOM, id: '"><b>x</b>' }] } });
  assert.doesNotMatch(html, /<b>/);
  assert.match(html, /data-id="&quot;&gt;&lt;b&gt;x&lt;\/b&gt;"/);
});

test('repoByPath: a prefix never matches, case, slashes and a trailing slash do not matter, and bad input gives null', () => {
  assert.equal(repoByPath(ABC.slice(0, -1)), null);
  assert.equal(repoByPath(`${ABC}x`), null);
  assert.equal(repoByPath(ABC.toUpperCase() + '/').group, 'g');
  assert.equal(repoByPath(ABC.replace(/\\/g, '/')).group, 'g');
  for (const bad of [null, undefined, 5, '', {}]) assert.equal(repoByPath(bad), null);
});

test('when a filter hides the room cards the folder stays findable as a plain repo card, and the room card does not come back', () => {
  const html = view([card({ id: 'r9', name: 'ceo' }), card({ id: 'r1', name: 'alpha', room: 'U' })], { q: 'ceo' });
  const folder = withId(html, 'r9');
  assert.equal(folder.length, 1);
  assert.doesNotMatch(folder[0], /rs-room/);
  assert.equal(articles(html).filter((c) => c.includes('rs-room')).length, 0);
});

test('a room whose folder has no repo row (no id) keeps its card as it was: not clickable', () => {
  const html = view([card({ id: 'r1', name: 'alpha', room: 'U' })], { roomData: { rooms: [{ ...ROOM, id: null }] } });
  const room = articles(html).find((c) => c.includes('rs-room'));
  assert.doesNotMatch(room, /chat-open|tabindex/);
});

test('Conformity: projectRepos drops the folder of every room (it is the room, not a project) and keeps the rest in order', () => {
  const repos = [{ id: 'r9' }, { id: 'r1' }, { id: 'r2' }];
  assert.deepEqual(V.projectRepos(repos, [{ name: 'U', id: 'r9' }]).map((r) => r.id), ['r1', 'r2']);
  assert.deepEqual(V.projectRepos(repos, [{ name: 'U', id: 'r9' }, { name: 'T', id: 'r2' }]).map((r) => r.id), ['r1']);
  assert.deepEqual(V.projectRepos(repos, [{ name: 'U', id: null }, { name: 'T' }, null]).map((r) => r.id), ['r9', 'r1', 'r2']);
  assert.deepEqual(V.projectRepos(repos, undefined).map((r) => r.id), ['r9', 'r1', 'r2']);
});

test('Conformity: the roadmap audit, the requirement counts and the requirement blocks all leave the folder of a room out', () => {
  const src = appSource();
  const tabs = fs.readFileSync(path.join(__dirname, '..', 'public', 'tabs.js'), 'utf8').replace(/\r\n/g, '\n');
  assert.match(tabs, /const projectRepos = \(\) => \(V \? V\.projectRepos\(allRepos\(\), roomList\(\)\) : allRepos\(\)\);/);
  assert.match(tabs, /function refreshConformity\(\) \{\n  const entries = projectRepos\(\)\.map\(/);
  assert.match(tabs, /repos: projectRepos\(\)\.map\(\(r\) => \{/);
  assert.match(tabs, /<div class="conf-heading">Requirements<\/div>\$\{projectRepos\(\)\.map\(reqBlock\)\.join\(''\)\}/);
  assert.equal((src.match(/allRepos\(\)\.map\(reqBlock\)/g) || []).length, 0);
});
