'use strict';
// RP164 (S54, S55), HIGH RISK (privacy, RP105, and a file format the panel does not control): the SERVER reads the presence Gentle Pi publishes for the ADOPTED session of a repo
// (<agentDir>/gentle-agents/presence/<sha256 of the session id>.<incarnation uuid>.{header,activity,discovery}.json) and the row of the Summary carries ONLY
// `session.subagents = { signal: boolean, list: [{ name: string|null, state: 'working'|'slow'|'stuck', minutes: int, idle: int }] }` (at most 5 entries).
// Rules pinned here: slow at 2 min without activity, stuck at 5, no signal when the header heartbeat is older than 15 s (decision 8: then NO subagent is listed). Shape chosen for «no signal»:
// `{ signal: false, list: [] }`, and only when that stale header still CLAIMS work (counts.running + queued + waiting > 0): an idle leftover header is not news, so the row stays the row of today.
// With a fresh heartbeat and nothing running there is nothing to show either: the field is absent. Absent too: no folder, a broken, huge or unmatched file, a session that is not live.
// A name that is not ^[A-Za-z0-9._-]{1,40}$ is shown with name null (the subagent still counts, the text never travels). `label`, `thread`, ids, hashes, digest, model and paths never leave.
// `discovery` is never opened (a spy on fs proves it). The tests use a temp folder and never touch the real profile. The abuse tests come first.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const net = require('node:net');

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'rp164-'));
const sessionsBase = path.join(scratch, 'sessions');
const presence = path.join(scratch, 'gentle-agents', 'presence');
const repoDir = path.join(scratch, 'My Repo.Api');
for (const d of [sessionsBase, presence, repoDir]) fs.mkdirSync(d, { recursive: true });
const configFile = path.join(scratch, 'config.json');
process.env.REPO_PANEL_CONFIG = configFile;
process.env.REPO_PANEL_SESSIONS_DIR = sessionsBase;
test.after(() => fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 5 }));

const lib = require('../lib.js');
const P = require('../server/presence.js');
const { summarize, summaryFor } = require('../server/summary.js');
const { createRpcHost } = require('../server/rpchost.js');
const { findRepo } = require('../server/config.js');
const { createServer } = require('../server/http.js');

const NOW = Date.parse('2026-11-12T10:00:00Z');
const SEC = 'SECRET-LABEL-DO-NOT-LEAK';
const REPO_ID = lib.repoId(repoDir);
const SID = 'sess-abc.1_2';
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const HASH = sha(SID);
const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const U1 = uuid(1);
const writeConfig = (sessions) => fs.writeFileSync(configFile, JSON.stringify({ port: 4310, groups: [{ name: 'G', repos: [{ path: repoDir }] }], rooms: [], sessions }));
const adopt = (id = SID) => writeConfig({ [REPO_ID]: { id, name: 'panel:x', adoptedAt: new Date(NOW).toISOString() } });

const put = (name, content) => fs.writeFileSync(path.join(presence, name), typeof content === 'string' ? content : JSON.stringify(content));
const clean = () => { for (const n of fs.readdirSync(presence)) fs.rmSync(path.join(presence, n), { recursive: true, force: true }); };
const header = (o = {}) => ({ schema: 1, sessionHash: HASH, incarnation: U1, label: SEC, heartbeat: NOW - 2000, generation: 3, counts: { running: 1, queued: 0, waiting: 0, finished: 0 }, digest: SEC, unavailable: false, ...o });
const task = (o = {}) => ({
  summary: { id: `task-${SEC}`, agent: 'scout', label: SEC, model: `model-${SEC}`, status: 'running', createdAt: NOW - 200000, startedAt: NOW - 180000, endedAt: null, lastActivityAt: NOW - 10000, ...(o.summary || {}) },
  thread: { version: 1, dropped: 0, items: [{ prompt: SEC, result: SEC, path: `C:\\Users\\${SEC}` }] }, ...(o.rest || {}),
});
const activity = (tasks) => ({ schema: 1, activity: { tasks } });
const setup = (h, tasks, u = U1) => { P.clearCache(); /* RP164: the answer of the real clock is kept 3 s; every test starts from new files */ if (h) put(`${HASH}.${u}.header.json`, h); if (tasks) put(`${HASH}.${u}.activity.json`, activity(tasks)); };
const read = (over = {}) => P.subagentsOf(REPO_ID, { dir: presence, now: NOW, ...over });
const listed = (tasks, h = header()) => { clean(); setup(h, tasks); return read(); };
const never = (out) => { const j = JSON.stringify(out); assert.ok(!j.includes(SEC) && !/task-|model-|thread|prompt|result|digest|incarnation|sessionHash|C:\\/.test(j), j); };

test.beforeEach(() => { clean(); adopt(); });

// ---------- ABUSE: what must never leave ----------
test('a1: ABUSE (privacy): label, thread, ids, model, digest and paths never leave; the whole answer is exactly the closed shape', () => {
  const out = listed([task()]);
  assert.deepEqual(out, { signal: true, list: [{ name: 'scout', state: 'working', minutes: 3, idle: 0 }] });
  assert.deepEqual(Object.keys(out.list[0]).sort(), ['idle', 'minutes', 'name', 'state']);
  never(out);
  const row = summarize({ repo: { id: 'r1', name: 'x', group: 'G', room: null }, local: { branch: 'main', files: [], ahead: 0, behind: 0, base: 'main' }, prs: { prs: [], stale: null }, roadmap: { available: true, rows: [], derived: {}, next: null }, state: { available: false }, session: 'idle', subagents: out, last: { at: null }, snoozed: [], now: NOW });
  never(row);
  assert.deepEqual(row.session, { state: 'free', subagents: out });
});

test('a2: ABUSE: a hostile task (extra keys, markup in every text, a thread that is not even a list) shows only the whitelist', () => {
  const t = task({ summary: { extra: SEC, agent: 'scout' }, rest: { thread: SEC, secret: SEC, result: SEC } });
  t.summary.nested = { label: SEC };
  never(listed([t]));
  assert.deepEqual(listed([t]), { signal: true, list: [{ name: 'scout', state: 'working', minutes: 3, idle: 0 }] });
});

// ---------- ABUSE: heartbeat ----------
test('a3: ABUSE: a stale heartbeat that still says running lists NO subagent, only the flag; 15 s exactly is still alive; an idle stale header is no news', () => {
  assert.deepEqual(listed([task()], header({ heartbeat: NOW - 15001 })), { signal: false, list: [] });
  assert.deepEqual(listed([task()], header({ heartbeat: NOW - 15000 })), { signal: true, list: [{ name: 'scout', state: 'working', minutes: 3, idle: 0 }] });
  assert.deepEqual(listed([task()], header({ heartbeat: NOW - 3600000, counts: { running: 0, queued: 1, waiting: 0, finished: 0 } })), { signal: false, list: [] });
  assert.equal(listed([task()], header({ heartbeat: NOW - 3600000, counts: { running: 0, queued: 0, waiting: 0, finished: 4 } })), null, 'leftover header of a dead process with nothing pending');
  assert.equal(listed([task()], header({ heartbeat: NOW - 3600000, counts: undefined })), null);
  never(listed([task()], header({ heartbeat: NOW - 99999 })));
});

test('a4: ABUSE: a heartbeat that is not a plausible number invalidates the header (no answer): strings, NaN, Infinity, negative, zero, the far future, objects', () => {
  for (const heartbeat of ['now', String(NOW), null, undefined, -5, 0, 1e999, NOW + 60000, 1e308, {}, [NOW], true]) assert.equal(listed([task()], header({ heartbeat })), null, String(heartbeat));
  assert.deepEqual(listed([task()], header({ heartbeat: NOW + 5000 })), { signal: true, list: [{ name: 'scout', state: 'working', minutes: 3, idle: 0 }] }, 'a clock skew of a few seconds is tolerated');
});

// ---------- ABUSE: files ----------
test('a5: ABUSE: a file over 64 KiB is skipped (the header or the activity), one of exactly 64 KiB is read', () => {
  const pad = (obj, size) => { const s = JSON.stringify(obj); return s + ' '.repeat(size - s.length); };
  clean(); setup(header(), null); put(`${HASH}.${U1}.activity.json`, pad(activity([task()]), 65 * 1024));
  assert.equal(read(), null, 'a huge activity is skipped: nothing to show');
  clean(); setup(null, [task()]); put(`${HASH}.${U1}.header.json`, pad(header(), 65 * 1024));
  assert.equal(read(), null, 'a huge header is skipped: that incarnation does not exist');
  clean(); setup(header(), null); put(`${HASH}.${U1}.activity.json`, pad(activity([task()]), 64 * 1024));
  assert.deepEqual(read(), { signal: true, list: [{ name: 'scout', state: 'working', minutes: 3, idle: 0 }] });
  assert.equal(P.FILE_MAX, 64 * 1024);
});

test('a6: ABUSE: cut, empty, binary and corrupt files are skipped without inventing a state; non-object JSON too; nothing throws', () => {
  const good = JSON.stringify(activity([task()]));
  for (const bad of [good.slice(0, 40), '', '{', 'null', '[]', '5', '"x"', '{"activity":null}', '{"activity":{"tasks":"x"}}', '{"activity":{"tasks":{}}}', '\u0000\u0001\u0002', 'true']) {
    clean(); setup(header(), null); put(`${HASH}.${U1}.activity.json`, bad);
    assert.equal(read(), null, bad.slice(0, 20));
  }
  for (const bad of [JSON.stringify(header()).slice(0, 50), '', '[]', 'null', '{}', '\u0000']) {
    clean(); setup(null, [task()]); put(`${HASH}.${U1}.header.json`, bad);
    assert.equal(read(), null, bad.slice(0, 20));
  }
  clean(); put(`${HASH}.${U1}.header.json`, header()); fs.mkdirSync(path.join(presence, `${HASH}.${U1}.activity.json`));
  assert.equal(read(), null, 'a folder with the name of the file');
});

test('a7: ABUSE: only names that match the exact pattern of THIS session are looked at (other hash, wrong kind, extra suffix, upper case, short uuid, traversal)', () => {
  const other = sha('another-session');
  const bait = (name) => put(name, name.includes('header') ? header() : activity([task({ summary: { agent: 'intruder' } })]));
  const names = [
    `${other}.${U1}.header.json`, `${other}.${U1}.activity.json`, `${HASH}.${U1}.summary.json`, `${HASH}.${U1}.header.json.bak`, `${HASH}.${U1}.header.json.`, `x${HASH}.${U1}.header.json`,
    `${HASH.toUpperCase()}.${U1}.header.json`, `${HASH}.${U1.toUpperCase()}.header.json`, `${HASH}.0000.header.json`, `${HASH}..${U1}.header.json`, `${HASH}.${U1}.header.JSON`,
    `${HASH.slice(1)}.${U1}.header.json`, `${HASH}x.${U1}.header.json`, `${HASH}.${U1}.header .json`, `${HASH}.${U1}.activity.json~`,
  ];
  for (const n of names) bait(n);
  fs.mkdirSync(path.join(presence, `${HASH}.${uuid(9)}.header.json`));
  assert.equal(read(), null, 'nothing matches');
  never(read());
  clean(); // (a case-insensitive file system would merge the upper-case baits with the real names)
  put(`${HASH}.${U1}.header.json`, header());
  put(`${HASH}.${U1}.activity.json`, activity([task()]));
  assert.deepEqual(read(), { signal: true, list: [{ name: 'scout', state: 'working', minutes: 3, idle: 0 }] }, 'only the real pair is read');
});

test('a8: ABUSE: text inside a file never builds a path: a sessionHash or incarnation full of dots and slashes changes nothing', () => {
  clean();
  setup(header({ sessionHash: '../../../etc/passwd', incarnation: '..\\..\\x' }), [task()]);
  assert.deepEqual(read(), { signal: true, list: [{ name: 'scout', state: 'working', minutes: 3, idle: 0 }] });
  assert.deepEqual(fs.readdirSync(presence).sort(), [`${HASH}.${U1}.activity.json`, `${HASH}.${U1}.header.json`]);
});

test('a9: ABUSE: the incarnation with the NEWEST header heartbeat wins; the tasks of an older one never show, and one with no valid header does not compete', () => {
  const U2 = uuid(2), U3 = uuid(3), U4 = uuid(4);
  setup(header({ heartbeat: NOW - 9000 }), [task({ summary: { agent: 'old-one' } })], U1);
  setup(header({ heartbeat: NOW - 1000 }), [task({ summary: { agent: 'new-one' } })], U2);
  setup(header({ heartbeat: 'x' }), [task({ summary: { agent: 'broken-one' } })], U3);
  put(`${HASH}.${U4}.activity.json`, activity([task({ summary: { agent: 'headless' } })]));
  assert.deepEqual(read(), { signal: true, list: [{ name: 'new-one', state: 'working', minutes: 3, idle: 0 }] });
  setup(header({ heartbeat: NOW - 500, counts: { running: 0, queued: 0, waiting: 0, finished: 1 } }), null, uuid(5));
  assert.equal(read(), null, 'the newest header has no activity: nothing running, and the old tasks are not borrowed');
});

// ---------- ABUSE: numbers, names, states ----------
test('b1: ABUSE: times that are not plausible numbers hide that subagent (huge, negative, NaN as text, Infinity, strings, null, objects, the far future) and never throw or leak', () => {
  const bad = [1e308, -5, -1e308, 'abc', String(NOW - 1000), null, undefined, {}, [], true, 1e999, NOW + 60000, 0];
  for (const v of bad) {
    assert.equal(listed([task({ summary: { startedAt: v } })]), null, `startedAt ${String(v)}`);
    assert.equal(listed([task({ summary: { lastActivityAt: v } })]), null, `lastActivityAt ${String(v)}`);
  }
  assert.deepEqual(listed([task({ summary: { startedAt: 1e308 } }), task({ summary: { agent: 'ok-one' } })]), { signal: true, list: [{ name: 'ok-one', state: 'working', minutes: 3, idle: 0 }] }, 'one bad task does not hide the good ones');
});

test('b2: minutes are whole numbers, clamped: a skew of seconds is 0, a year is 9999, never negative, never fractional', () => {
  assert.deepEqual(listed([task({ summary: { startedAt: NOW + 3000, lastActivityAt: NOW + 3000 } })]).list[0], { name: 'scout', state: 'working', minutes: 0, idle: 0 });
  assert.deepEqual(listed([task({ summary: { startedAt: NOW - 365 * 86400000, lastActivityAt: NOW - 365 * 86400000 } })]).list[0], { name: 'scout', state: 'stuck', minutes: 9999, idle: 9999 });
  assert.deepEqual(listed([task({ summary: { startedAt: NOW - 90500, lastActivityAt: NOW - 59999 } })]).list[0], { name: 'scout', state: 'working', minutes: 1, idle: 0 });
});

test('b3: thresholds on the server clock: working under 2 min, slow from 2 min, stuck from 5 min of silence', () => {
  const at = (idleMs) => listed([task({ summary: { lastActivityAt: NOW - idleMs } })]).list[0];
  assert.deepEqual([at(0).state, at(119999).state, at(120000).state, at(299999).state, at(300000).state, at(3600000).state], ['working', 'working', 'slow', 'slow', 'stuck', 'stuck']);
  assert.equal(at(120000).idle, 2);
  assert.equal(at(300000).idle, 5);
  assert.deepEqual([P.SLOW_MS, P.STUCK_MS, P.STALE_MS], [120000, 300000, 15000]);
  const injected = P.subagentsOf(REPO_ID, { dir: presence, now: NOW + 10000 });
  assert.equal(injected.signal, true, 'the injected clock decides, not the real one');
});

test('b4: ABUSE: the name is validated; one that is not valid is shown with name null (the subagent still counts), never as text', () => {
  const names = ['<img src=x onerror=alert(1)>', 'a'.repeat(41), '', 'has space', 'ünï', 'a/b', '..\\x', '"; drop', 5, null, undefined, {}, ['scout'], 'a\nb'];
  for (const agent of names) {
    const out = listed([task({ summary: { agent } })]);
    assert.deepEqual(out, { signal: true, list: [{ name: null, state: 'working', minutes: 3, idle: 0 }] }, String(JSON.stringify(agent)).slice(0, 30));
    assert.doesNotMatch(JSON.stringify(out), /img|onerror|drop/);
  }
  for (const agent of ['a', 'a'.repeat(40), 'Scout.v2_x-1']) assert.equal(listed([task({ summary: { agent } })]).list[0].name, agent);
});

test('b5: the list of states is CLOSED: a task whose status is not running shows nothing', () => {
  for (const status of ['queued', 'waiting', 'finished', 'completed', 'failed', 'RUNNING', 'running ', '', 5, null, undefined, {}, ['running'], 'cancelled']) assert.equal(listed([task({ summary: { status } })]), null, JSON.stringify(status));
  assert.equal(listed([task({ summary: { endedAt: NOW - 1000 } })]).list.length, 1, 'only the status decides (endedAt is null while it runs, other values are not trusted for the list)');
});

test('b6: at most 5 subagents, the ones that started first; entries that are not tasks are skipped', () => {
  const many = Array.from({ length: 8 }, (_, i) => task({ summary: { agent: `a${i}`, startedAt: NOW - (i + 1) * 60000, lastActivityAt: NOW - 1000 } }));
  const out = listed([null, 5, 'x', [], {}, { summary: null }, ...many]);
  assert.equal(out.list.length, 5);
  assert.deepEqual(out.list.map((e) => e.name), ['a7', 'a6', 'a5', 'a4', 'a3']);
  assert.equal(P.MAX_SUBAGENTS, 5);
  assert.equal(listed(Array.from({ length: 250 }, () => ({ summary: task().summary }))).list.length, 5, 'a long list is bounded too');
});

// ---------- ABUSE: discovery, folder, ids, read-only ----------
test('c1: ABUSE: `discovery` is NEVER opened, read, listed or stat-ed, even with a huge or unreadable one next to the others', () => {
  setup(header(), [task()]);
  put(`${HASH}.${U1}.discovery.json`, 'x'.repeat(200000));
  fs.mkdirSync(path.join(presence, `${HASH}.${uuid(7)}.discovery.json`));
  const touched = [];
  const real = {};
  for (const fn of ['openSync', 'readFileSync', 'statSync', 'lstatSync', 'createReadStream', 'readSync']) {
    real[fn] = fs[fn];
    fs[fn] = (...a) => { touched.push(String(typeof a[0] === 'string' ? a[0] : a[0])); return real[fn](...a); };
  }
  let out;
  try { out = read(); } finally { Object.assign(fs, real); }
  assert.deepEqual(out, { signal: true, list: [{ name: 'scout', state: 'working', minutes: 3, idle: 0 }] });
  assert.ok(touched.some((p) => p.endsWith('.header.json')), 'the spy works: it saw the header');
  assert.deepEqual(touched.filter((p) => p.includes('discovery')), []);
});

test('c2: nothing to read: no folder, a file where the folder should be, an empty folder, a folder with no permission to list: no answer, no throw', () => {
  assert.equal(P.subagentsOf(REPO_ID, { dir: path.join(scratch, 'nope', 'presence'), now: NOW }), null);
  const file = path.join(scratch, 'afile'); fs.writeFileSync(file, 'x');
  assert.equal(P.subagentsOf(REPO_ID, { dir: file, now: NOW }), null);
  assert.equal(read(), null, 'empty folder');
  for (const dir of [undefined, null, 5, {}, '', '\u0000']) assert.equal(P.subagentsOf(REPO_ID, { dir, now: NOW, base: sessionsBase }), null, String(dir));
});

test('c3: ABUSE: the id of the session and the repo: unknown repo, a room, nothing adopted, an id with path characters or too long: no answer, nothing opened', () => {
  setup(header(), [task()]);
  assert.equal(P.subagentsOf('nope000000', { dir: presence, now: NOW }), null);
  assert.equal(P.subagentsOf('room:Nope', { dir: presence, now: NOW }), null);
  for (const bad of [5, null, undefined, {}, '__proto__']) assert.equal(P.subagentsOf(bad, { dir: presence, now: NOW }), null, String(bad));
  writeConfig({});
  assert.equal(read(), null, 'nothing adopted');
  for (const id of ['../../etc/passwd', 'a/b', 'a\\b', '..', 'x'.repeat(81), '', 5, null]) {
    writeConfig({ [REPO_ID]: { id, name: 'x', adoptedAt: 'x' } });
    const real = fs.readdirSync; let listedDir = false;
    fs.readdirSync = (...a) => { listedDir = true; return real(...a); };
    try { assert.equal(read(), null, String(id)); } finally { fs.readdirSync = real; }
    assert.equal(listedDir, false, `an id that is not an id never lists the folder: ${String(id)}`);
  }
  adopt('another-session');
  assert.equal(read(), null, 'another session has another hash: its files are not these');
});

test('c4: it only reads: the folder is the same after (names, sizes, times), and no file is created anywhere', () => {
  setup(header(), [task()]);
  put(`${HASH}.${U1}.discovery.json`, '{}');
  const snap = () => fs.readdirSync(presence).sort().map((n) => { const s = fs.statSync(path.join(presence, n)); return `${n}|${s.size}|${s.mtimeMs}`; });
  const top = fs.readdirSync(scratch).sort();
  const before = snap();
  read(); listed([task()]); clean(); setup(header({ heartbeat: 1 }), [task()]);
  const mid = snap();
  read();
  assert.deepEqual(snap(), mid);
  assert.ok(before.length > 0, 'the snapshot saw the files'); // RP164: it compared a number with 0 before
  assert.deepEqual(fs.readdirSync(scratch).sort(), top);
  const real = { writeFileSync: fs.writeFileSync, writeSync: fs.writeSync, unlinkSync: fs.unlinkSync, rmSync: fs.rmSync, renameSync: fs.renameSync, appendFileSync: fs.appendFileSync, mkdirSync: fs.mkdirSync };
  const writes = [];
  for (const fn of Object.keys(real)) fs[fn] = (...a) => { writes.push(fn); return real[fn](...a); };
  try { read(); } finally { Object.assign(fs, real); }
  assert.deepEqual(writes, []);
});

test('c5: the default folder comes from the SAME agent folder as the sessions (<agent>/sessions -> <agent>/gentle-agents/presence), never from a fixed home', () => {
  const agent = path.join(scratch, 'agent');
  assert.equal(P.presenceDirFor(path.join(agent, 'sessions')), path.join(agent, 'gentle-agents', 'presence'));
  const dir = path.join(agent, 'gentle-agents', 'presence'); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${HASH}.${U1}.header.json`), JSON.stringify(header()));
  fs.writeFileSync(path.join(dir, `${HASH}.${U1}.activity.json`), JSON.stringify(activity([task()])));
  assert.deepEqual(P.subagentsOf(REPO_ID, { base: path.join(agent, 'sessions'), now: NOW }), { signal: true, list: [{ name: 'scout', state: 'working', minutes: 3, idle: 0 }] });
  assert.equal(P.subagentsOf(REPO_ID, { now: NOW }), null, 'the env override of the sessions folder gives its sibling folder, which is empty here');
  assert.doesNotThrow(() => P.subagentsOf(REPO_ID));
  assert.doesNotThrow(() => P.subagentsOf());
});

test('c6: sanitize is the one gate: whatever a getter answers, the row gets the closed shape or nothing', () => {
  const ok = { signal: true, list: [{ name: 'scout', state: 'slow', minutes: 4, idle: 2 }] };
  assert.deepEqual(P.sanitize(ok), ok);
  assert.deepEqual(P.sanitize({ signal: false, list: [] }), { signal: false, list: [] });
  assert.deepEqual(P.sanitize({ ...ok, id: SEC, label: SEC, list: [{ ...ok.list[0], id: SEC, label: SEC, thread: [SEC], path: '/x' }] }), ok, 'extra keys are dropped');
  for (const bad of [null, undefined, 5, 'x', [], true, {}, { signal: 'yes', list: [] }, { signal: true }, { signal: true, list: 'x' }, { signal: true, list: {} }, { list: [] }]) assert.equal(P.sanitize(bad), null, JSON.stringify(bad));
  const entry = (o) => P.sanitize({ signal: true, list: [{ ...ok.list[0], ...o }] });
  for (const o of [{ state: 'running' }, { state: 'WORKING' }, { state: 5 }, { state: undefined }, { minutes: -1 }, { minutes: 1.5 }, { minutes: NaN }, { minutes: Infinity }, { minutes: '3' }, { minutes: 1e21 }, { idle: -1 }, { idle: '2' }, { idle: null }]) assert.equal(entry(o), null, JSON.stringify(o)); // the entry is dropped and a live signal with nothing listed is nothing to show
  assert.equal(entry({ name: '<b>x</b>' }).list[0].name, null);
  assert.equal(entry({ name: 7 }).list[0].name, null);
  assert.equal(entry({ minutes: 99999 }).list[0].minutes, 9999);
  assert.equal(P.sanitize({ signal: true, list: Array.from({ length: 9 }, () => ok.list[0]) }).list.length, 5);
  assert.deepEqual(P.sanitize({ signal: false, list: [ok.list[0]] }), { signal: false, list: [] }, 'with no signal nothing is listed, whatever the getter says');
});

// ---------- the row: exactly today's row without presence ----------
const facts = (over = {}) => ({
  repo: { id: 'r1', name: 'repo-one', group: 'G', room: null }, local: { branch: 'main', files: [], ahead: 0, behind: 0, base: 'main' }, prs: { prs: [], stale: null },
  roadmap: { available: true, rows: [], derived: {}, next: null }, state: { available: false }, session: 'closed', last: { at: '2026-10-28T10:00:00Z', what: 'a subject' }, snoozed: [], now: NOW, ...over,
});
const GOOD = { signal: true, list: [{ name: 'scout', state: 'slow', minutes: 4, idle: 2 }] };

test('d1: without presence the row is EXACTLY the row of today (no `subagents` key at all), with the same keys and values', () => {
  for (const session of ['idle', 'busy', 'asking', 'closed', 'unknown']) {
    const today = summarize(facts({ session, jobs: 2 }));
    for (const subagents of [undefined, null, 0, '', false, {}, [], 'x', 5, { signal: 'x' }]) {
      const row = summarize(facts({ session, jobs: 2, subagents }));
      assert.deepEqual(row, today, `${session} ${JSON.stringify(subagents)}`);
      assert.ok(!('subagents' in row.session), session);
    }
  }
  assert.deepEqual(summarize(facts({ session: 'idle' })).session, { state: 'free' });
});

test('d2: with presence, a LIVE session carries it next to state and jobs; a closed, unknown or ambiguous session never does; nothing else in the row changes', () => {
  assert.deepEqual(summarize(facts({ session: 'idle', subagents: GOOD })).session, { state: 'free', subagents: GOOD });
  assert.deepEqual(summarize(facts({ session: 'busy', jobs: 3, subagents: GOOD })).session, { state: 'working', jobs: 3, subagents: GOOD }, 'jobs still works with presence');
  assert.deepEqual(summarize(facts({ session: 'asking', subagents: GOOD })).session, { state: 'waiting', subagents: GOOD });
  for (const session of ['closed', 'unknown', 'ambiguous', 'zzz']) assert.deepEqual(summarize(facts({ session, jobs: 3, subagents: GOOD })).session, summarize(facts({ session, jobs: 3 })).session, session);
  const a = summarize(facts({ session: 'idle', subagents: GOOD })), b = summarize(facts({ session: 'idle' }));
  assert.deepEqual({ ...a, session: 0 }, { ...b, session: 0 });
  assert.deepEqual(summarize(facts({ session: 'idle', subagents: { ...GOOD, id: SEC, list: [{ ...GOOD.list[0], label: SEC }] } })).session, { state: 'free', subagents: GOOD });
  assert.deepEqual(summarize(facts({ session: 'idle', jobs: 0, subagents: GOOD })).session, { state: 'free', subagents: GOOD });
  assert.deepEqual(summarize(facts({ session: 'idle', jobs: -1 })).session, { state: 'free' }, 'jobs rules are untouched');
});

test('d3: the presence never holds anything: the rank, the action and the needs of the row do not depend on it', () => {
  for (const session of ['idle', 'busy', 'asking']) {
    const a = summarize(facts({ session, subagents: GOOD })), b = summarize(facts({ session }));
    assert.deepEqual([a.rank, a.needs, a.action], [b.rank, b.needs, b.action], session);
  }
  const stuck = { signal: false, list: [] };
  assert.deepEqual(summarize(facts({ session: 'idle', subagents: stuck })).session, { state: 'free', subagents: stuck });
});

const prs = async () => ({ prs: [], stale: null });
test('d4: summaryFor asks the getter once per repo and only for a live session; a getter that throws or answers garbage is no presence; with no getter the row is as today', async () => {
  fs.writeFileSync(configFile, JSON.stringify({ groups: [{ name: 'G', repos: [{ path: repoDir }] }] }));
  const asked = [];
  const run = (subagentsOf, sessionOf = () => 'idle', extra = {}) => summaryFor({ sessionOf, subagentsOf, prs, ...extra }, { fresh: '1' }).then((o) => o.rows[0].session);
  assert.deepEqual(await run((id) => { asked.push(id); return GOOD; }), { state: 'free', subagents: GOOD });
  assert.deepEqual(asked, [REPO_ID]);
  assert.deepEqual(await run(() => { throw new Error('boom'); }), { state: 'free' });
  assert.deepEqual(await run(() => 'many'), { state: 'free' });
  assert.deepEqual(await run(() => ({ path: '/secret', label: SEC })), { state: 'free' });
  assert.deepEqual(await run(() => GOOD, () => 'busy', { jobsOf: () => 2 }), { state: 'working', jobs: 2, subagents: GOOD });
  asked.length = 0;
  assert.deepEqual(await run((id) => { asked.push(id); return GOOD; }, () => 'closed'), { state: 'none' });
  assert.deepEqual(asked, [], 'a closed session: the getter is not even asked');
  assert.deepEqual(await summaryFor({ sessionOf: () => 'idle', prs }, { fresh: '1' }).then((o) => o.rows[0].session), { state: 'free' });
});

test('d5: the in-memory store reads it when it builds the snapshot, like the state; a getter that throws is no presence; the error row keeps today\'s shape', async () => {
  const cfg = { groups: [{ name: 'G', repos: [{ path: repoDir }] }], rooms: [], snoozed: [] };
  const good = { local: { branch: 'main', files: [], ahead: 0, behind: 0, base: 'main' }, prs: { prs: [], stale: null }, roadmap: { available: true, rows: [], derived: {}, next: null }, state: { available: false } };
  const deps = { local: async () => good.local, prs: async () => good.prs, roadmap: async () => good.roadmap, state: async () => good.state, git: async () => ({ code: 0, stdout: `${new Date(NOW).toISOString()}\nx\n`, stderr: '' }), fetch: async () => ({ skipped: 'no-remote' }) };
  const make = (opts) => require('../server/summarystore.js').createSummaryStore({ waitForClient: false, intervals: { fast: 5000 }, deps, now: () => NOW, loadCfg: () => cfg, setTimer: () => ({ unref() {} }), clearTimer() {}, sessionOf: () => 'idle', ...opts });
  let got = GOOD;
  const s = make({ subagentsOf: () => { if (got === 'boom') throw new Error('x'); return got; } });
  await s.refreshAll();
  assert.deepEqual(s.snapshot().rows[0].session, { state: 'free', subagents: GOOD });
  got = 'boom';
  assert.deepEqual(s.snapshot().rows[0].session, { state: 'free' });
  got = null;
  assert.deepEqual(s.snapshot().rows[0].session, { state: 'free' });
  const none = make({});
  await none.refreshAll();
  assert.deepEqual(none.snapshot().rows[0].session, { state: 'free' }, 'no getter: as today');
  const broken = make({ deps: { ...deps, roadmap: async () => { throw new Error('read failed'); } }, subagentsOf: () => GOOD });
  await broken.refreshAll();
  assert.ok(broken.snapshot().rows[0].error);
  assert.deepEqual(broken.snapshot().rows[0].session, { state: 'free', subagents: GOOD }, 'the error row keeps the same rule as for jobs');
});

// ---------- end to end ----------
const freePort = () => new Promise((resolve) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });
const call = (port, p, token) => new Promise((resolve, reject) => {
  http.get({ host: '127.0.0.1', port, path: p, headers: token ? { 'x-token': token } : {} }, (res) => {
    let d = ''; res.on('data', (c) => { d += c; }); res.on('end', () => { let json = null; try { json = JSON.parse(d); } catch { /* not json */ } resolve({ status: res.statusCode, body: d, json }); });
  }).on('error', reject);
});
const ACTIVE = { id: 'gentle-shell', command: 'C:\\L\\gentle-shell.exe', agentDir: 'C:\\a' };
const hostWith = () => createRpcHost({
  resolve: async () => ({ active: ACTIVE }), repoOf: findRepo, publish() {}, adoptedOf: () => null,
  createClient: () => ({ start: async () => ({}), request: async () => ({}), answerDialog: () => false, pendingDialogs: () => [], state: () => 'idle', close() {} }),
});
const OK = {
  local: async () => ({ branch: 'main', files: [], ahead: 0, behind: 0, base: 'main' }), prs: async () => ({ prs: [], stale: null }), roadmap: async () => ({ available: false, reason: 'missing' }),
  state: async () => ({ available: false }), git: async () => ({ code: 0, stdout: '2026-10-28T10:00:00Z\nsubject\n', stderr: '' }),
};
test('e1: END TO END: the Summary route carries the closed shape for a session the panel started and nothing for a closed one; the answer never holds the label or the thread; a stale heartbeat gives only the flag', async () => {
  const real = Date.now();
  adopt();
  setup(header({ heartbeat: real - 1000 }), [task({ summary: { startedAt: real - 400000, lastActivityAt: real - 350000 } })]);
  put(`${HASH}.${U1}.discovery.json`, `{"root":"C:\\\\${SEC}"}`);
  const host = hostWith();
  const port = await freePort();
  const server = createServer(port, { rpcHost: host, ...OK, noSummaryStore: true });
  await new Promise((r) => server.listen(port, '127.0.0.1', r));
  try {
    const token = /name="?token"? content="([0-9a-f]+)"/.exec((await call(port, '/')).body)[1];
    const row = async () => { const r = await call(port, '/api/summary?fresh=1', token); return { row: r.json.rows.find((x) => x.id === REPO_ID), body: r.body }; };
    assert.deepEqual((await row()).row.session, { state: 'none' }, 'the panel did not start it: closed, nothing read');
    await host.start(REPO_ID);
    const live = await row();
    assert.deepEqual(live.row.session, { state: 'free', subagents: { signal: true, list: [{ name: 'scout', state: 'stuck', minutes: 6, idle: 5 }] } });
    assert.doesNotMatch(live.body, /SECRET|task-|model-|thread|prompt|digest|incarnation|sessionHash|discovery|gentle-agents/);
    setup(header({ heartbeat: real - 60000 }), [task()]); P.clearCache(); // RP164: the answer is kept 3 s; the test changes the files between two reads
    assert.deepEqual((await row()).row.session, { state: 'free', subagents: { signal: false, list: [] } });
    clean(); P.clearCache();
    assert.deepEqual((await row()).row.session, { state: 'free' }, 'no presence: the row of today');
    host.closeAll();
    assert.deepEqual((await row()).row.session, { state: 'none' });
  } finally { host.closeAll(); await new Promise((r) => server.close(r)); }
});

test('a10: ABUSE: a symlink named like a valid file is not followed (only regular files of this folder)', (t) => {
  clean();
  const outside = path.join(scratch, 'outside.json');
  fs.writeFileSync(outside, JSON.stringify(header()));
  try { fs.symlinkSync(outside, path.join(presence, `${HASH}.${U1}.header.json`)); } catch { return t.skip('no permission for symlinks'); }
  assert.equal(read(), null);
  fs.rmSync(path.join(presence, `${HASH}.${U1}.header.json`), { force: true });
});

test('a11: the answer of the real clock is kept 3 s (one listing of the folder per repo per window), expires at 3 s, and a given now never uses the cache', () => {
  clean(); P.clearCache();
  const T = Date.now();
  let clock = T;
  const live = (o = {}) => P.subagentsOf(REPO_ID, { dir: presence, clock: () => clock, ...o });
  setup(header({ heartbeat: T - 1000 }), [task({ summary: { startedAt: T - 180000, lastActivityAt: T } })]);
  const first = live();
  assert.equal(first.signal, true);
  assert.equal(first.list.length, 1);
  clean(); // the files vanish: inside the window the answer is the same one
  clock = T + 2999;
  assert.deepEqual(live(), first, 'at 2999 ms it is still the kept answer');
  assert.equal(live({ now: T }), null, 'a given now reads the folder even when it is the very instant of the cache');
  clock = T + 3000;
  assert.equal(live(), null, 'at 3000 ms it expires and the folder is read again');
  clock = T - 5;
  setup(header({ heartbeat: T - 1000 }), [task({ summary: { startedAt: T - 180000, lastActivityAt: T } })]);
  live(); clean(); clock = T - 10;
  assert.equal(live(), null, 'a clock that goes back never serves the kept answer');
});
