'use strict';
// RP161 (S50, S52, S53), HIGH RISK (privacy, RP105, and a file format the panel does not control): the SERVER counts the background jobs a session still waits for, from the session file it already reads for the chat, and the row
// of the Summary carries ONLY an integer (`session.jobs`, 1 to 99, and absent when there is none). A start is a `bash_background` or `monitor` answer (`details.gentleJobs`, status running, identified by its `outputPath`) or a
// background `subagent_run` answer (`details.gentleAgents`, mode background, status queued or running, identified by its `taskId`); it ENDS with the notice `gentle-jobs.notice` (status exited), the answer of `job_stop` (stopped or
// exited) or the notice `gentle-agents.result` (any status that is not queued or running). A monitor tells many times while it runs (status running): those are not an end. `jobId` repeats and is never the identity.
// Only the starts written after the session was started by the panel count (the jobs of an older process are gone). What the code cannot understand counts as NO job (the buttons behave as they do today), and neither the text
// nor a path of the file ever travels. The abuse tests come first: hostile and broken input, the window of 512 KB, the cache, the cap, and that nothing but a number leaves.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'rp161-'));
const sessionsBase = path.join(scratch, 'sessions');
const repoDir = path.join(scratch, 'My Repo.Api');
for (const d of [sessionsBase, repoDir]) fs.mkdirSync(d);
const configFile = path.join(scratch, 'config.json');
process.env.REPO_PANEL_CONFIG = configFile;
process.env.REPO_PANEL_SESSIONS_DIR = sessionsBase;
test.after(() => fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 5 }));

const lib = require('../lib.js');
const S = require('../server/sessions.js');
const J = require('../server/jobs.js');
const { summarize, summaryFor } = require('../server/summary.js');

const T0 = Date.parse('2026-11-12T10:00:00Z');
const iso = (ms) => new Date(ms).toISOString();
const SEC = 'SECRET-LABEL-DO-NOT-LEAK';
const toolResult = (tool, details, at) => ({ type: 'message', timestamp: iso(T0 + at), message: { role: 'toolResult', toolName: tool, content: [{ type: 'text', text: `${SEC} result` }], details } });
const notice = (customType, details, at) => ({ type: 'custom_message', customType, timestamp: iso(T0 + at), content: `${SEC} notice`, display: false, details });
const gj = (p, o = {}) => ({ gentleJobs: { jobId: 'job-1', kind: o.kind || 'command', label: SEC, status: o.status || 'running', exitCode: o.exitCode ?? null, outputPath: p, ...(o.event ? { event: o.event } : {}) } });
const ga = (id, o = {}) => ({ gentleAgents: { taskId: id, agent: 'a', label: SEC, mode: o.mode || 'background', status: o.status || 'queued', cwd: '/x', model: 'm', toolCalls: 0, turns: 0 } });
const jobStart = (p, at = 1000, o = {}) => toolResult(o.tool || 'bash_background', gj(p, o), at);
const monitorStart = (p, at = 1000) => jobStart(p, at, { tool: 'monitor', kind: 'monitor' });
const jobEnd = (p, at = 2000, o = {}) => notice('gentle-jobs.notice', gj(p, { status: 'exited', exitCode: 0, ...o }), at);
const jobTell = (p, at = 1500) => notice('gentle-jobs.notice', gj(p, { kind: 'monitor', status: 'running', event: 'events' }), at);
const jobStop = (p, at = 2000, status = 'stopped') => toolResult('job_stop', gj(p, { status }), at);
const agentStart = (id, at = 1000, o = {}) => toolResult('subagent_run', ga(id, o), at);
const agentEnd = (id, at = 2000, status = 'completed') => notice('gentle-agents.result', ga(id, { status }), at);
const count = (entries, since = T0) => J.countPending(entries, { since });

// ---------- the rule (pure) ----------
test('r1: a start with no end is one pending job; a start and its end is none; the three kinds of start count (job, monitor, background subagent)', () => {
  assert.equal(count([]), 0);
  assert.equal(count([jobStart('/p/1.log')]), 1);
  assert.equal(count([monitorStart('/p/m.log')]), 1);
  assert.equal(count([agentStart('t1')]), 1);
  assert.equal(count([jobStart('/p/1.log'), monitorStart('/p/m.log'), agentStart('t1')]), 3);
  assert.equal(count([jobStart('/p/1.log'), jobEnd('/p/1.log')]), 0);
  assert.equal(count([monitorStart('/p/m.log'), jobEnd('/p/m.log')]), 0);
  assert.equal(count([agentStart('t1'), agentEnd('t1')]), 0);
});

test('r2: ABUSE: a monitor that tells while it runs (status running, event events) is NOT finished: it ends only with exited, a job_stop or never', () => {
  assert.equal(count([monitorStart('/p/m.log'), jobTell('/p/m.log', 1200), jobTell('/p/m.log', 1300), jobTell('/p/m.log', 1400)]), 1);
  assert.equal(count([monitorStart('/p/m.log'), jobTell('/p/m.log'), jobEnd('/p/m.log', 3000)]), 0);
});

test('r3: job_stop ends a job with no notice of its own (stopped or exited); a job_stop of another job ends nothing', () => {
  assert.equal(count([jobStart('/p/1.log'), jobStop('/p/1.log')]), 0);
  assert.equal(count([jobStart('/p/1.log'), jobStop('/p/1.log', 2000, 'exited')]), 0);
  assert.equal(count([jobStart('/p/1.log'), jobStop('/p/OTHER.log')]), 1);
  assert.equal(count([jobStart('/p/1.log'), jobStop('/p/1.log', 2000, 'running')]), 1, 'a job_stop that left it running did not end it');
});

test('r4: ABUSE: an end with no start counts for nothing and never goes below zero; an end of another job does not end this one', () => {
  assert.equal(count([jobEnd('/p/ghost.log')]), 0);
  assert.equal(count([jobEnd('/p/ghost.log'), jobEnd('/p/ghost2.log'), agentEnd('ghost')]), 0);
  assert.equal(count([jobStart('/p/1.log'), jobEnd('/p/OTHER.log')]), 1);
  assert.equal(count([agentStart('t1'), agentEnd('OTHER')]), 1);
  assert.equal(count([jobEnd('/p/1.log'), jobStart('/p/1.log', 3000)]), 1, 'an end that came BEFORE the start (file order) ended nothing');
});

test('r5: ABUSE: the identity is the outputPath (or the taskId), never the jobId (it repeats): two jobs with the same jobId are two; the same start twice is one; a restart after an end is pending again', () => {
  assert.equal(count([jobStart('/p/a.log'), jobStart('/p/b.log')]), 2, 'both have jobId job-1');
  assert.equal(count([jobStart('/p/a.log'), jobStart('/p/a.log', 1100)]), 1);
  assert.equal(count([jobStart('/p/a.log'), jobEnd('/p/a.log'), jobStart('/p/a.log', 3000)]), 1);
  assert.equal(count([jobStart('/p/a.log'), jobStart('/p/b.log'), jobEnd('/p/a.log')]), 1);
  assert.equal(count([agentStart('t1'), agentStart('t1', 1100), agentEnd('t1')]), 0);
});

test('r6: a subagent that blocks (mode task) is never a pending job; only a background one in queued or running is; any other status of its notice ends it', () => {
  assert.equal(count([agentStart('t1', 1000, { mode: 'task', status: 'completed' })]), 0);
  assert.equal(count([agentStart('t1', 1000, { mode: 'task', status: 'queued' })]), 0);
  assert.equal(count([agentStart('t1', 1000, { status: 'running' })]), 1);
  assert.equal(count([agentStart('t1', 1000, { status: 'completed' })]), 0);
  assert.equal(count([agentStart('t1', 1000, { status: 'cancelled' })]), 0);
  for (const status of ['completed', 'cancelled', 'failed', 'error', 'timeout', 'whatever']) assert.equal(count([agentStart('t1'), agentEnd('t1', 2000, status)]), 0, status);
  for (const status of ['queued', 'running']) assert.equal(count([agentStart('t1'), agentEnd('t1', 2000, status)]), 1, `a notice that says ${status} is not an end`);
});

test('r7: ABUSE: only the starts written AFTER the session was started by the panel count; with no start time (not hosted, closed, unknown) nothing counts; an END always ends, whatever its time', () => {
  assert.equal(count([jobStart('/p/1.log', -5000)]), 0, 'a start of an older process');
  assert.equal(count([jobStart('/p/1.log', 0)]), 1, 'the same instant counts');
  assert.equal(count([jobStart('/p/1.log', -1)]), 0);
  assert.equal(count([agentStart('t1', -5000)]), 0, 'a background subagent of an older process');
  assert.equal(count([agentStart('t1', 0)]), 1);
  for (const since of [null, undefined, NaN, Infinity, -Infinity, '1', {}, [], true]) assert.equal(J.countPending([jobStart('/p/1.log')], { since }), 0, String(since));
  assert.equal(J.countPending([jobStart('/p/1.log')]), 0, 'no options');
  assert.equal(J.countPending([jobStart('/p/1.log')], null), 0);
  const noTime = { ...jobEnd('/p/1.log'), timestamp: undefined };
  assert.equal(count([jobStart('/p/1.log'), noTime]), 0, 'an end with no time still ends it');
  assert.equal(count([jobStart('/p/1.log'), { ...jobEnd('/p/1.log'), timestamp: 'garbage' }]), 0);
  assert.equal(count([{ ...jobStart('/p/1.log'), timestamp: 'garbage' }]), 0, 'a start with no valid time cannot be told to be new');
  assert.equal(count([{ ...jobStart('/p/1.log'), timestamp: undefined }]), 0);
});

test('r8: ABUSE: hostile entries never throw and never count: not objects, wrong types, huge or empty ids, odd statuses, details that are not objects', () => {
  const junk = [null, undefined, 5, 'x', [], [1, 2], true, () => 1, Symbol('s'), {}, { type: 'message' }, { type: 'message', message: null }, { type: 'message', message: 5 }, { type: 'message', message: { role: 'toolResult' } },
    { type: 'message', message: { role: 'toolResult', toolName: 'bash_background', details: null } }, { type: 'message', message: { role: 'toolResult', toolName: 'bash_background', details: [] } },
    { type: 'message', message: { role: 'toolResult', toolName: 'bash_background', details: { gentleJobs: null } } }, { type: 'message', message: { role: 'toolResult', toolName: 'bash_background', details: { gentleJobs: 'x' } } }];
  assert.equal(count(junk), 0);
  const odd = (o) => toolResult('bash_background', { gentleJobs: { status: 'running', outputPath: '/p/1.log', ...o } }, 1000);
  for (const o of [{ outputPath: 5 }, { outputPath: '' }, { outputPath: null }, { outputPath: {} }, { outputPath: ['/p'] }, { outputPath: 'x'.repeat(5000) }, { outputPath: undefined }, { status: 'RUNNING' }, { status: 'exited' }, { status: 5 }, { status: undefined }]) assert.equal(count([odd(o)]), 0, JSON.stringify(o).slice(0, 60));
  const wrongTool = (tool) => toolResult(tool, gj('/p/1.log'), 1000);
  for (const tool of ['read', 'bash', 'Bash_Background', 'bash_background ', '', undefined, 5, null, 'job_list', 'job_stop']) assert.equal(count([wrongTool(tool)]), 0, String(tool));
  const wrongCustom = (ct) => notice(ct, gj('/p/1.log', { status: 'exited' }), 2000);
  for (const ct of ['gentle-jobs.noticeX', 'other', '', undefined, 5]) assert.equal(count([jobStart('/p/1.log'), wrongCustom(ct)]), 1, `a notice of type ${String(ct)} is not an end`);
  assert.equal(count([toolResult('subagent_run', { gentleAgents: { taskId: 5, mode: 'background', status: 'queued' } }, 1000)]), 0);
  assert.equal(count([toolResult('subagent_run', { gentleAgents: { taskId: '', mode: 'background', status: 'queued' } }, 1000)]), 0);
  assert.equal(count([toolResult('subagent_run', { gentleAgents: { taskId: 'x'.repeat(5000), mode: 'background', status: 'queued' } }, 1000)]), 0);
});

test('r9: the cap is 99, the result is always a safe integer of 0 or more, and an enormous list does not blow up', () => {
  assert.equal(J.MAX_JOBS, 99);
  const many = (n) => Array.from({ length: n }, (_, i) => jobStart(`/p/${i}.log`, 1000 + i));
  assert.equal(count(many(98)), 98);
  assert.equal(count(many(99)), 99);
  assert.equal(count(many(100)), 99);
  assert.equal(count(many(5000)), 99);
  for (const entries of [[], many(3), [jobEnd('/p/x')], [null], 'not an array', null, undefined, 5, {}]) {
    const n = J.countPending(entries, { since: T0 });
    assert.ok(Number.isSafeInteger(n) && n >= 0 && n <= 99, String(n));
  }
});

test('r10: ABUSE (privacy): the only thing that comes out is a number: never a path, a label or a word of the file', () => {
  const n = count([jobStart('/p/SECRET.log'), monitorStart('/p/SECRET2.log'), agentStart('SECRET-TASK')]);
  assert.equal(typeof n, 'number');
  assert.equal(JSON.stringify(n), '3');
  assert.doesNotMatch(String(n), /SECRET|\//);
});

// ---------- the file ----------
let seq = 0;
function sessionFile(lines, mtimeSec = 2000) {
  const id = `s161x${++seq}`;
  const dir = S.sessionsDirFor(repoDir, sessionsBase);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `2026-11-12T10-00-00-000Z_${id}.jsonl`);
  fs.writeFileSync(file, lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n') + '\n');
  fs.utimesSync(file, mtimeSec, mtimeSec);
  return { id, file };
}
const header = (id) => JSON.stringify({ type: 'session', version: 3, id, timestamp: iso(T0), cwd: repoDir });
const fromFile = (file, since = T0) => J.pendingFromFile(file, { since });

test('f1: a real file: the pending jobs are counted from it, with broken lines in the middle ignored and a last line cut in half dropped', () => {
  const { id, file } = sessionFile([header('x'), jobStart('/p/1.log'), '{not json', '', '[1,2', jobStart('/p/2.log', 1100), jobEnd('/p/1.log', 3000)]);
  assert.equal(fromFile(file), 1);
  fs.appendFileSync(file, `${JSON.stringify(jobStart('/p/3.log', 4000)).slice(0, 40)}`);
  assert.equal(fromFile(file), 1, 'the last line was cut: it is not read');
  assert.ok(id);
});

test('f2: ABUSE: a file that is missing, a directory, an empty file, a file with only garbage or a path that is not text give 0 and never throw', () => {
  assert.equal(fromFile(path.join(scratch, 'nope.jsonl')), 0);
  assert.equal(fromFile(scratch), 0);
  assert.equal(fromFile(sessionFile([]).file), 0);
  assert.equal(fromFile(sessionFile(['\u0000\u0001\u0002', '}{', '"just a string"', '12', 'null']).file), 0);
  for (const bad of [null, undefined, 5, {}, [], '']) assert.equal(J.pendingFromFile(bad, { since: T0 }), 0, String(bad));
  assert.equal(J.pendingFromFile(sessionFile([header('x'), jobStart('/p/1.log')]).file), 0, 'no options: no start time: nothing counts');
});

test('f3: only the last 512 KB are read: a start older than the window is not seen (it counts LESS, the safe side) and the read is bounded', () => {
  const { file } = sessionFile([header('x'), jobStart('/p/old.log', 1000), 'g'.repeat(900 * 1024), jobStart('/p/new.log', 2000)]);
  const realRead = fs.readSync;
  let bytes = 0;
  fs.readSync = (...a) => { const n = realRead(...a); bytes += n; return n; };
  let n;
  try { n = fromFile(file); } finally { fs.readSync = realRead; }
  assert.equal(n, 1, 'the old start fell out of the window');
  assert.ok(bytes <= 530 * 1024, `read ${bytes} bytes`);
});

test('f4: the answer is cached by the size and the time of the file: asking again reads nothing, and a changed file is read again', () => {
  const { file } = sessionFile([header('x'), jobStart('/p/1.log')]);
  const realRead = fs.readSync;
  let reads = 0;
  fs.readSync = (...a) => { reads++; return realRead(...a); };
  try {
    assert.equal(fromFile(file), 1);
    const first = reads;
    assert.ok(first > 0);
    assert.equal(fromFile(file), 1);
    assert.equal(fromFile(file), 1);
    assert.equal(reads, first, 'cached');
    fs.appendFileSync(file, `${JSON.stringify(jobEnd('/p/1.log', 3000))}\n`);
    assert.equal(fromFile(file), 0, 'the file grew: read again');
    assert.ok(reads > first);
    assert.equal(fromFile(file, T0 + 99999), 0, 'another start time is another question');
  } finally { fs.readSync = realRead; }
});

test('f5: the cache does not grow without bound and a changed start time never reuses the answer of another', () => {
  const { file } = sessionFile([header('x'), jobStart('/p/1.log', 1000)]);
  assert.equal(fromFile(file, T0), 1);
  assert.equal(fromFile(file, T0 + 5000), 0, 'the start is older than this start time');
  assert.equal(fromFile(file, T0), 1);
  for (let i = 0; i < 400; i++) fromFile(file, T0 + i);
  assert.ok(J.cacheSize() <= 200, `the cache keeps ${J.cacheSize()} entries`);
});

// ---------- the session of a repo ----------
const REPO_ID = lib.repoId(repoDir);
const writeConfig = (sessions) => fs.writeFileSync(configFile, JSON.stringify({ port: 4310, groups: [{ name: 'G', repos: [{ path: repoDir }] }], rooms: [], sessions }));

test('j1: the jobs of a repo come from ITS adopted session; no adopted session, no start time, an unknown repo or a session that is not in the folder give 0 and never throw', () => {
  const { id } = sessionFile([header('x'), jobStart('/p/1.log'), monitorStart('/p/m.log', 1100), jobEnd('/p/1.log', 3000)]);
  writeConfig({ [REPO_ID]: { id, name: 'panel:x', adoptedAt: iso(T0) } });
  assert.equal(J.jobsOf(REPO_ID, T0, sessionsBase), 1);
  assert.equal(J.jobsOf(REPO_ID, null, sessionsBase), 0, 'the panel did not start it');
  assert.equal(J.jobsOf(REPO_ID, undefined, sessionsBase), 0);
  assert.equal(J.jobsOf('nope000000', T0, sessionsBase), 0, 'an unknown repo');
  assert.equal(J.jobsOf('room:Nope', T0, sessionsBase), 0);
  assert.equal(J.jobsOf(5, T0, sessionsBase), 0);
  writeConfig({ [REPO_ID]: { id: 'ghost-session', name: 'x', adoptedAt: iso(T0) } });
  assert.equal(J.jobsOf(REPO_ID, T0, sessionsBase), 0, 'adopted, but the file is not in the folder');
  writeConfig({});
  assert.equal(J.jobsOf(REPO_ID, T0, sessionsBase), 0, 'nothing adopted');
  writeConfig({ [REPO_ID]: { id: '../../etc/passwd', name: 'x', adoptedAt: iso(T0) } });
  assert.equal(J.jobsOf(REPO_ID, T0, sessionsBase), 0, 'a session id that is not an id never opens a file');
});

test('j2: ABUSE (privacy): whatever the file holds, jobsOf gives a number and nothing else', () => {
  const { id } = sessionFile([header('x'), jobStart(`/p/${SEC}.log`), agentStart(SEC)]);
  writeConfig({ [REPO_ID]: { id, name: 'panel:x', adoptedAt: iso(T0) } });
  const n = J.jobsOf(REPO_ID, T0, sessionsBase);
  assert.equal(n, 2);
  assert.equal(JSON.stringify(n), '2');
});

// ---------- the row of the Summary ----------
const facts = (over = {}) => ({
  repo: { id: 'r1', name: 'repo-one', group: 'G', room: null }, local: { branch: 'main', files: [], ahead: 0, behind: 0, base: 'main' }, prs: { prs: [], stale: null },
  roadmap: { available: true, rows: [], derived: {}, next: null }, state: { available: false }, session: 'closed', last: { at: '2026-10-28T10:00:00Z', what: 'a subject' }, snoozed: [], now: T0, ...over,
});
const sessionOfRow = (over) => summarize(facts(over)).session; // summarize gives the row itself

test('m1: the row says the number only when the session is alive and the number is a positive integer; nothing else changes in the row', () => {
  assert.deepEqual(sessionOfRow({ session: 'idle', jobs: 2 }), { state: 'free', jobs: 2 });
  assert.deepEqual(sessionOfRow({ session: 'busy', jobs: 1 }), { state: 'working', jobs: 1 });
  assert.deepEqual(sessionOfRow({ session: 'asking', jobs: 5 }), { state: 'waiting', jobs: 5 });
  assert.deepEqual(sessionOfRow({ session: 'idle' }), { state: 'free' }, 'as today: no field');
  assert.deepEqual(sessionOfRow({ session: 'idle', jobs: 0 }), { state: 'free' });
  assert.deepEqual(summarize(facts({ session: 'idle', jobs: 2 })).progress, summarize(facts({ session: 'idle' })).progress);
});

test('m2: ABUSE: a number that is not a positive safe integer is no number (the field is absent); an enormous one is 99; a closed or unknown session has no jobs', () => {
  for (const jobs of [-1, 0, NaN, Infinity, 1.5, '3', null, undefined, {}, [], true, 1e21]) assert.deepEqual(sessionOfRow({ session: 'idle', jobs }), { state: 'free' }, String(jobs));
  assert.deepEqual(sessionOfRow({ session: 'idle', jobs: 100 }), { state: 'free', jobs: 99 });
  assert.deepEqual(sessionOfRow({ session: 'idle', jobs: Number.MAX_SAFE_INTEGER }), { state: 'free', jobs: 99 });
  assert.deepEqual(sessionOfRow({ session: 'closed', jobs: 3 }), { state: 'none' }, 'a closed session has no jobs left');
  assert.deepEqual(sessionOfRow({ session: 'unknown', jobs: 3 }), { state: 'unknown' });
  assert.deepEqual(sessionOfRow({ session: 'ambiguous', jobs: 3 }), { state: 'unknown' });
  assert.deepEqual(sessionOfRow({ session: 'idle', jobs: 3, error: 'boom' }), { state: 'free', jobs: 3 }, 'the row of a repo with an error keeps the same rule');
});

const prs = async () => ({ prs: [], stale: null });
test('m3: summaryFor asks the getter once per repo, a getter that throws or answers garbage is no jobs, and a session that is closed never asks', async () => {
  writeConfig({});
  fs.writeFileSync(configFile, JSON.stringify({ groups: [{ name: 'G', repos: [{ path: repoDir }] }] }));
  const asked = [];
  const run = (jobsOf, sessionOf = () => 'idle') => summaryFor({ sessionOf, jobsOf, prs }, { fresh: '1' }).then((o) => o.rows[0].session);
  assert.deepEqual(await run((id) => { asked.push(id); return 4; }), { state: 'free', jobs: 4 });
  assert.deepEqual(asked, [REPO_ID]);
  assert.deepEqual(await run(() => { throw new Error('boom'); }), { state: 'free' });
  assert.deepEqual(await run(() => 'many'), { state: 'free' });
  assert.deepEqual(await run(() => ({ path: '/secret' })), { state: 'free' });
  asked.length = 0;
  assert.deepEqual(await run((id) => { asked.push(id); return 2; }, () => 'closed'), { state: 'none' });
  assert.deepEqual(asked, [], 'a closed session has no jobs: the getter is not even asked');
  assert.deepEqual(await summaryFor({ sessionOf: () => 'idle', prs }, { fresh: '1' }).then((o) => o.rows[0].session), { state: 'free' }, 'with no getter: as today');
});

const store = () => {
  const make = (opts) => require('../server/summarystore.js').createSummaryStore({ waitForClient: false, intervals: { fast: 5000 }, ...opts });
  return make;
};
test('m4: the in-memory store reads the number when it builds the snapshot, like the state of the session, and a getter that throws is no jobs', async () => {
  const cfg = { groups: [{ name: 'G', repos: [{ path: repoDir }] }], rooms: [], snoozed: [] };
  const good = { local: { branch: 'main', files: [], ahead: 0, behind: 0, base: 'main' }, prs: { prs: [], stale: null }, roadmap: { available: true, rows: [], derived: {}, next: null }, state: { available: false } };
  const deps = { local: async () => good.local, prs: async () => good.prs, roadmap: async () => good.roadmap, state: async () => good.state, git: async () => ({ code: 0, stdout: `${iso(T0)}\nx\n`, stderr: '' }), fetch: async () => ({ skipped: 'no-remote' }) };
  let jobs = 3;
  const s = store()({ deps, now: () => T0, loadCfg: () => cfg, setTimer: () => ({ unref() {} }), clearTimer() {}, sessionOf: () => 'idle', jobsOf: () => { if (jobs === 'boom') throw new Error('x'); return jobs; } });
  await s.refreshAll();
  assert.deepEqual(s.snapshot().rows[0].session, { state: 'free', jobs: 3 });
  jobs = 0;
  assert.deepEqual(s.snapshot().rows[0].session, { state: 'free' }, 'the number is read at each snapshot');
  jobs = 'boom';
  assert.deepEqual(s.snapshot().rows[0].session, { state: 'free' });
  jobs = 3;
  const broken = store()({ deps: { ...deps, roadmap: async () => { throw new Error('read failed'); } }, now: () => T0, loadCfg: () => cfg, setTimer: () => ({ unref() {} }), clearTimer() {}, sessionOf: () => 'idle', jobsOf: () => jobs });
  await broken.refreshAll();
  const row = broken.snapshot().rows[0];
  assert.ok(row.error, 'the repo has an error');
  assert.deepEqual(row.session, { state: 'free', jobs: 3 }, 'the row of a repo with an error says it too');
});

// ---------- the host: when the panel started the session ----------
const http = require('node:http');
const net = require('node:net');
const { createRpcHost } = require('../server/rpchost.js');
const { findRepo } = require('../server/config.js');
const { createServer } = require('../server/http.js');
const ACTIVE = { id: 'gentle-shell', command: 'C:\L\gentle-shell.exe', agentDir: 'C:\a' };
const hostWith = (over = {}) => createRpcHost({
  resolve: async () => ({ active: ACTIVE }), repoOf: findRepo, publish() {}, adoptedOf: () => null,
  createClient: () => ({ start: over.start || (async () => ({})), request: async () => ({}), answerDialog: () => false, pendingDialogs: () => [], state: () => 'idle', close() {} }),
});

test('h1: startedAtOf is null with no session and while it starts, the time it was up once started, null again after closeAll, and a restart gives a NEWER time; it never throws', async () => {
  writeConfig({});
  let open;
  const host = hostWith({ start: () => new Promise((r) => { open = r; }) });
  assert.equal(host.startedAtOf(REPO_ID), null);
  for (const bad of [undefined, null, 5, {}, '__proto__', 'constructor', 'nope']) assert.equal(host.startedAtOf(bad), null, String(bad));
  const before = Date.now();
  const starting = host.start(REPO_ID);
  await new Promise((r) => setImmediate(r));
  assert.equal(host.startedAtOf(REPO_ID), null, 'still starting');
  open({});
  await starting;
  const at = host.startedAtOf(REPO_ID);
  assert.ok(Number.isFinite(at) && at >= before && at <= Date.now(), String(at));
  host.closeAll();
  assert.equal(host.startedAtOf(REPO_ID), null, 'closed');
  const host2 = hostWith();
  await host2.start(REPO_ID);
  await new Promise((r) => setTimeout(r, 5));
  await host2.start(REPO_ID).catch(() => {});
  assert.ok(host2.startedAtOf(REPO_ID) >= at);
});

// ---------- end to end: GET /api/summary ----------
const freePort = () => new Promise((resolve) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });
const call = (port, p, token) => new Promise((resolve, reject) => {
  http.get({ host: '127.0.0.1', port, path: p, headers: token ? { 'x-token': token } : {} }, (res) => {
    let d = ''; res.on('data', (c) => { d += c; }); res.on('end', () => { let json = null; try { json = JSON.parse(d); } catch { /* not json */ } resolve({ status: res.statusCode, body: d, json }); });
  }).on('error', reject);
});
const GOOD = {
  local: async () => ({ branch: 'main', files: [], ahead: 0, behind: 0, base: 'main' }), prs: async () => ({ prs: [], stale: null }), roadmap: async () => ({ available: false, reason: 'missing' }),
  state: async () => ({ available: false }), git: async () => ({ code: 0, stdout: '2026-10-28T10:00:00Z\nsubject\n', stderr: '' }),
};
test('e1: END TO END: the Summary route carries the integer for a session the panel started AFTER the jobs began... and nothing for a session the panel did not start; the answer never holds a path or a word of the file', async () => {
  const future = Date.now() + 60000;
  const at = (e, ms) => ({ ...e, timestamp: iso(ms) });
  const { id } = sessionFile([header('x'), at(jobStart('/p/OLD-PROCESS.log'), Date.now() - 600000), at(jobStart(`/p/${SEC}.log`), future), at(monitorStart('/p/m.log'), future + 1), at(jobEnd('/p/m.log'), future + 2), at(agentStart(SEC), future + 3)]);
  writeConfig({ [REPO_ID]: { id, name: 'panel:x', adoptedAt: iso(T0) } });
  const host = hostWith();
  const port = await freePort();
  const server = createServer(port, { rpcHost: host, ...GOOD, noSummaryStore: true });
  await new Promise((r) => server.listen(port, '127.0.0.1', r));
  try {
    const token = /name="?token"? content="([0-9a-f]+)"/.exec((await call(port, '/')).body)[1];
    const row = async () => (await call(port, '/api/summary?fresh=1', token)).json.rows.find((r) => r.id === REPO_ID);
    assert.deepEqual((await row()).session, { state: 'none' }, 'the panel did not start it: closed, no jobs');
    await host.start(REPO_ID);
    const live = await call(port, '/api/summary?fresh=1', token);
    assert.deepEqual(live.json.rows.find((r) => r.id === REPO_ID).session, { state: 'free', jobs: 2 }, 'the job and the subagent are pending, the monitor ended, and the job of an OLDER process does not count');
    assert.doesNotMatch(live.body, /SECRET|\/p\//, 'no path and no label of the file in the answer');
    host.closeAll();
    assert.deepEqual((await row()).session, { state: 'none' }, 'a closed session has no jobs left');
  } finally { host.closeAll(); await new Promise((r) => server.close(r)); }
});

test('e2: END TO END with the store of the server (the one that runs in production): the same integer reaches the row', async () => {
  const future = Date.now() + 60000;
  const { id } = sessionFile([header('x'), { ...jobStart('/p/1.log'), timestamp: iso(future) }]);
  writeConfig({ [REPO_ID]: { id, name: 'panel:x', adoptedAt: iso(T0) } });
  const host = hostWith();
  await host.start(REPO_ID);
  const port = await freePort();
  const server = createServer(port, { rpcHost: host, ...GOOD, fetch: async () => ({ skipped: 'no-remote' }) });
  await new Promise((r) => server.listen(port, '127.0.0.1', r));
  try {
    const token = /name="?token"? content="([0-9a-f]+)"/.exec((await call(port, '/')).body)[1];
    const got = await call(port, '/api/summary?fresh=1', token);
    assert.deepEqual(got.json.rows.find((r) => r.id === REPO_ID).session, { state: 'free', jobs: 1 });
  } finally { host.closeAll(); await new Promise((r) => server.close(r)); }
});

// ---------- after the independent verification (D1, D3) ----------
test('v1: D1: a notice of a job with ANY status that is not running ends it (failed, killed, stopped...: a state pi adds later must not pin the buttons); a tell that says running, or a status that is not text, does not', () => {
  for (const status of ['failed', 'killed', 'stopped', 'error', 'cancelled', 'exited', 'whatever']) assert.equal(count([jobStart('/p/1.log'), jobEnd('/p/1.log', 2000, { status })]), 0, status);
  for (const status of ['running', 5, null, undefined, {}, [], '', true]) assert.equal(count([jobStart('/p/1.log'), notice('gentle-jobs.notice', gj('/p/1.log', { status }), 2000)]), 1, JSON.stringify(status));
  assert.equal(count([monitorStart('/p/m.log'), jobTell('/p/m.log'), jobTell('/p/m.log', 1600), jobEnd('/p/m.log', 3000, { status: 'failed' })]), 0);
  assert.equal(count([jobStart('/p/1.log'), jobEnd('/p/OTHER.log', 2000, { status: 'failed' })]), 1, 'only its own outputPath');
});

test('v2: D3: the time of an entry may be a number of milliseconds as well as an ISO text; a number that is not a finite time, or older than the start of the session, does not count', () => {
  const num = (e, ms) => ({ ...e, timestamp: ms });
  assert.equal(count([num(jobStart('/p/1.log'), T0 + 1000)]), 1);
  assert.equal(count([num(agentStart('t1'), T0 + 1000)]), 1);
  assert.equal(count([num(jobStart('/p/1.log'), T0 - 1)]), 0);
  assert.equal(count([num(jobStart('/p/1.log'), T0)]), 1);
  for (const bad of [NaN, Infinity, -Infinity, null, {}, [], true, '12abc', '']) assert.equal(count([num(jobStart('/p/1.log'), bad)]), 0, String(bad));
  assert.equal(count([num(jobStart('/p/1.log'), T0 + 1000), jobEnd('/p/1.log', 3000)]), 0);
});
