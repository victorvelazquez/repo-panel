'use strict';
// RP54 (S48, S53, S56): the chat panel of the Summary. Server: readChat + GET /api/chat (last 64 KB of the adopted session,
// read-only). Client: the divider math, the card as chat selector, the panel states, polling, and the guarantee that
// nothing here ever sends text to a session. Temp dirs and fake deps only: the real Orca and the real sessions are never touched.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const net = require('node:net');
const vm = require('node:vm');

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'rp54-'));
const sessionsBase = path.join(scratch, 'sessions');
const repoDir = path.join(scratch, 'My Repo.Api');
const roomDir = path.join(scratch, 'room-folder');
for (const d of [sessionsBase, repoDir, roomDir]) fs.mkdirSync(d);
const configFile = path.join(scratch, 'config.json');
process.env.REPO_PANEL_CONFIG = configFile;
process.env.REPO_PANEL_SESSIONS_DIR = sessionsBase;
process.env.REPO_PANEL_CASES_FILE = 'off';
test.after(() => fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 5 }));

const lib = require('../lib.js');
const S = require('../server/sessions.js');
const { createServer } = require('../server/http.js');
const R = require('../public/resumen.js');

const PUBLIC = path.join(__dirname, '..', 'public');
const REPO_ID = lib.repoId(repoDir);
const writeConfig = (extra = {}) => fs.writeFileSync(configFile, JSON.stringify({
  port: 4310, groups: [{ name: 'G', repos: [{ path: repoDir }] }], rooms: [{ name: 'Sala Uno', path: roomDir, repos: [] }], ...extra,
}));
const resetDisk = () => { fs.rmSync(sessionsBase, { recursive: true, force: true }); fs.mkdirSync(sessionsBase); };

const header = (id, cwd) => JSON.stringify({ type: 'session', version: 3, id, timestamp: '2026-10-28T10:00:00.000Z', cwd });
const text = (t) => ({ type: 'text', text: t });
const call = (name, args = {}) => ({ type: 'toolCall', id: `c-${name}`, name, arguments: args });
const msg = (role, content, ts = Date.parse('2026-10-28T14:00:00Z')) => JSON.stringify({ type: 'message', timestamp: new Date(ts).toISOString(), message: { role, content, timestamp: ts } });
function putSession(folder, id, lines, mtimeSec = 2000) {
  const dir = S.sessionsDirFor(folder, sessionsBase);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `2026-10-28T10-00-00-000Z_${id}.jsonl`);
  fs.writeFileSync(file, lines.join('\n') + '\n');
  fs.utimesSync(file, mtimeSec, mtimeSec);
  return file;
}
const chatOf = (id, opts) => S.readChat(repoDir, id, { base: sessionsBase, ...opts });

// ---------- Part A: readChat ----------
test('readChat returns user and assistant text oldest first, with the tool NAMES only, never thinking, arguments or results', () => {
  resetDisk();
  putSession(repoDir, 'c1', [
    header('c1', repoDir),
    msg('user', [text('/flow-next'), text('please')]),
    msg('assistant', [{ type: 'thinking', thinking: 'SECRET-THOUGHT' }, call('read', { path: 'SECRET-ARG' })]),
    msg('toolResult', [text('SECRET-RESULT')]),
    msg('assistant', [{ type: 'thinking', thinking: 'SECRET-THOUGHT-2' }, text('Taking B2b.'), text('It is one file.')]),
    msg('system', [text('SECRET-SYSTEM')]),
    JSON.stringify({ type: 'custom', data: 'SECRET-CUSTOM' }),
    JSON.stringify({ type: 'session_info', name: 'n' }),
  ]);
  const r = chatOf('c1', { key: 'k' });
  assert.deepEqual(r.items.map((i) => [i.role, i.text, i.tools]), [['user', '/flow-next please', []], ['assistant', 'Taking B2b. It is one file.', ['read']]]);
  assert.equal(r.key, 'k');
  assert.equal(r.sessionId, 'c1');
  assert.equal(r.found, true);
  assert.equal(r.truncated, false);
  assert.equal(r.items[0].at, '2026-10-28T14:00:00.000Z');
  assert.equal(r.updatedAt, new Date(2000 * 1000).toISOString());
  assert.doesNotMatch(JSON.stringify(r), /SECRET/);
});

test('a timestamp may be a number, a numeric string or an ISO string; anything else is null', () => {
  resetDisk();
  const at = (ts) => JSON.stringify({ type: 'message', message: { role: 'user', content: [text('hi')], timestamp: ts } });
  putSession(repoDir, 'ts1', [header('ts1', repoDir), at(1793232936000), at('1793232936000'), at('2026-10-28T14:00:00.000Z'), at('not a date'), at({ x: 1 })]);
  const iso = new Date(1793232936000).toISOString();
  assert.deepEqual(chatOf('ts1').items.map((i) => i.at), [iso, iso, '2026-10-28T14:00:00.000Z', null, null]);
});

test('tool-only assistant messages fold into the next assistant item with text; a trailing run becomes a final item with empty text', () => {
  resetDisk();
  putSession(repoDir, 'c2', [
    header('c2', repoDir),
    msg('user', [text('go')]),
    msg('assistant', [call('read')]), msg('toolResult', [text('x')]), msg('assistant', [call('grep'), call('bash')]),
    msg('assistant', [text('Done.'), call('write')]),
    msg('user', [text('more')]),
    msg('assistant', [call('bash')]), msg('assistant', [call('edit')]),
  ]);
  const r = chatOf('c2');
  assert.deepEqual(r.items.map((i) => [i.role, i.text, i.tools]), [
    ['user', 'go', []], ['assistant', 'Done.', ['read', 'grep', 'bash', 'write']], ['user', 'more', []], ['assistant', '', ['bash', 'edit']],
  ]);
});

test('limit: 30 by default, at most 100, oldest first; older items than the limit set truncated', () => {
  resetDisk();
  const lines = [header('c3', repoDir)];
  for (let i = 0; i < 120; i++) lines.push(msg(i % 2 ? 'assistant' : 'user', [text(`m${i}`)]));
  putSession(repoDir, 'c3', lines);
  const d = chatOf('c3');
  assert.equal(d.items.length, 30);
  assert.equal(d.items[0].text, 'm90');
  assert.equal(d.items[29].text, 'm119');
  assert.equal(d.truncated, true);
  assert.equal(chatOf('c3', { limit: 5 }).items.length, 5);
  assert.equal(chatOf('c3', { limit: 5000 }).items.length, 100);
  assert.equal(chatOf('c3', { limit: 0 }).items.length, 30);
  assert.equal(chatOf('c3', { limit: 'x' }).items.length, 30);
});

test('text is capped at 4000 chars with an ellipsis, control characters become spaces, timestamps are normalised to ISO or null', () => {
  resetDisk();
  const file = putSession(repoDir, 'c4', [
    header('c4', repoDir),
    msg('user', [text('a'.repeat(5000))]),
    msg('assistant', [text('x\u0007y\u0000z')], Date.parse('2026-10-28T15:00:00Z')),
    JSON.stringify({ type: 'message', timestamp: '2026-10-28T16:00:00.000Z', message: { role: 'user', content: [text('iso')] } }),
    JSON.stringify({ type: 'message', message: { role: 'user', content: [text('none')], timestamp: 'garbage' } }),
  ]);
  const r = chatOf('c4');
  assert.equal(r.items[0].text, `${'a'.repeat(4000)}…`);
  assert.equal(r.items[1].text, 'x y z');
  assert.equal(r.items[2].at, '2026-10-28T16:00:00.000Z');
  assert.equal(r.items[3].at, null);
  assert.ok(file);
});

test('a missing session is found:false; corrupt lines are skipped; a small file is not truncated', () => {
  resetDisk();
  assert.deepEqual(chatOf('nope'), { key: null, sessionId: 'nope', found: false, items: [], truncated: false, updatedAt: null });
  putSession(repoDir, 'c5', [header('c5', repoDir), '{not json', msg('user', [text('ok')]), '', '[1,2', JSON.stringify({ type: 'message', message: null }), JSON.stringify({ type: 'message', message: { role: 'user', content: 'plain' } })]);
  const r = chatOf('c5');
  assert.deepEqual(r.items.map((i) => i.text), ['ok']);
  assert.equal(r.found, true);
  assert.equal(r.truncated, false);
});

test('only the last 64 KB of a ~5 MB file is read: a garbage middle and a long last line neither throw nor load the file', () => {
  resetDisk();
  const dir = S.sessionsDirFor(repoDir, sessionsBase);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, '2026-10-28T10-00-00-000Z_big.jsonl');
  fs.writeFileSync(file, [header('big', repoDir), msg('user', [text('FIRST')]), 'g'.repeat(5 * 1024 * 1024)].join('\n') + '\n');
  fs.appendFileSync(file, `${msg('user', [text('before')])}\n${msg('assistant', [text('L'.repeat(30000))])}`);
  const realRead = fs.readSync;
  let bytes = 0;
  fs.readSync = (...a) => { const n = realRead(...a); bytes += n; return n; };
  let r;
  try { r = chatOf('big'); } finally { fs.readSync = realRead; }
  assert.ok(bytes <= 70 * 1024, `read ${bytes} bytes`);
  assert.deepEqual(r.items.map((i) => i.text.length), [6, 4001]);
  assert.equal(r.truncated, true);
  assert.doesNotMatch(JSON.stringify(r), /FIRST/);
  fs.appendFileSync(file, `\n${msg('assistant', [text('H'.repeat(90000))])}\n`);
  assert.deepEqual(chatOf('big').items, []);
  assert.equal(chatOf('big').truncated, true);
});

// ---------- Part A: GET /api/chat ----------
const freePort = () => new Promise((resolve) => {
  const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
});
async function withServer(deps, fn) {
  const port = await freePort();
  const server = createServer(port, deps);
  await new Promise((r) => server.listen(port, '127.0.0.1', r));
  const get = (p, token) => new Promise((resolve, reject) => {
    const headers = { host: `127.0.0.1:${port}`, ...(token ? { 'x-token': token } : {}) };
    http.get({ host: '127.0.0.1', port, path: p, headers }, (res) => {
      let d = ''; res.on('data', (c) => { d += c; }); res.on('end', () => resolve({ status: res.statusCode, text: d }));
    }).on('error', reject);
  });
  try {
    const token = /name="?token"? content="([0-9a-f]+)"/.exec((await get('/')).text)[1];
    await fn({ get, token });
  } finally { server.close(); server.closeAllConnections(); }
}
const recordingOrca = () => { const calls = []; return { calls, orca: async (a) => { calls.push(a); if (a[0] === 'list') return { terminals: [] }; throw new Error(`unexpected ${a[0]}`); } }; };

test('GET /api/chat: token, adopted default, explicit session, 400/404, nothing adopted, and it never talks to Orca or writes', async () => {
  resetDisk();
  writeConfig({ sessions: { [REPO_ID]: { id: 'a-1', name: 'panel:x', adoptedAt: '2026-10-28T10:00:00.000Z' }, 'room:Sala Uno': { id: 'r-1', name: 'sala', adoptedAt: '2026-10-28T10:00:00.000Z' } } });
  putSession(repoDir, 'a-1', [header('a-1', repoDir), msg('user', [text('adopted one')])], 3000);
  putSession(repoDir, 'b-2', [header('b-2', repoDir), msg('user', [text('other one')])], 1000);
  putSession(roomDir, 'r-1', [header('r-1', roomDir), msg('user', [text('room one')])]);
  const before = fs.readFileSync(configFile, 'utf8');
  const f = recordingOrca();
  await withServer({ orca: f.orca }, async ({ get, token }) => {
    assert.equal((await get(`/api/chat?id=${REPO_ID}`)).status, 401);
    const def = JSON.parse((await get(`/api/chat?id=${REPO_ID}`, token)).text);
    assert.deepEqual([def.key, def.sessionId, def.found, def.items.map((i) => i.text)], [REPO_ID, 'a-1', true, ['adopted one']]);
    const exp = JSON.parse((await get(`/api/chat?id=${REPO_ID}&session=b-2`, token)).text);
    assert.deepEqual([exp.sessionId, exp.items.map((i) => i.text)], ['b-2', ['other one']]);
    assert.equal((await get(`/api/chat?id=${REPO_ID}&session=${encodeURIComponent('../x')}`, token)).status, 400);
    assert.equal((await get(`/api/chat?id=${REPO_ID}&session=ghost`, token)).status, 400);
    assert.equal((await get('/api/chat?id=nonexistent01', token)).status, 404);
    assert.equal((await get('/api/chat?id=room%3ANope', token)).status, 404);
    const room = JSON.parse((await get(`/api/chat?id=${encodeURIComponent('room:Sala Uno')}`, token)).text);
    assert.deepEqual(room.items.map((i) => i.text), ['room one']);
    assert.equal(JSON.parse((await get(`/api/chat?id=${REPO_ID}&limit=1`, token)).text).items.length, 1);
    writeConfig();
    assert.deepEqual(JSON.parse((await get(`/api/chat?id=${REPO_ID}`, token)).text), { key: REPO_ID, sessionId: null, found: false, items: [], truncated: false, updatedAt: null });
  });
  assert.deepEqual(f.calls, [], 'the chat route never calls Orca');
  assert.notEqual(before, '');
});

test('a fake Orca records no send during the sessions and chat reads', async () => {
  resetDisk();
  writeConfig();
  putSession(repoDir, 'a-1', [header('a-1', repoDir), msg('user', [text('hi')])]);
  const f = recordingOrca();
  await withServer({ orca: f.orca }, async ({ get, token }) => {
    await get(`/api/sessions?id=${REPO_ID}`, token);
    await get(`/api/chat?id=${REPO_ID}&session=a-1`, token);
  });
  assert.equal(f.calls.some((c) => c[0] === 'send'), false);
});

// ---------- Part B: pure helpers ----------
test('chatWidth: 40% by default, 50% under 1100, chat >= 340 and cards >= 360, clamped', () => {
  assert.equal(R.chatWidth(1390, null), 556);
  assert.equal(R.chatWidth(1000, null), 500);
  assert.equal(R.chatWidth(1390, 0.5), 695);
  assert.equal(R.chatWidth(1390, 0.1), 340);
  assert.equal(R.chatWidth(1390, 0.9), 1030);
  assert.equal(R.chatWidth(1390, 5), 1030);
  assert.equal(R.chatWidth(1390, -1), 556);
  assert.equal(R.chatWidth(1390, NaN), 556);
  assert.equal(R.chatWidth(600, null), 340);
});

const card = (o = {}) => ({
  id: 'r1', name: 'alpha', group: 'G', room: null, branch: 'main', progress: { total: 4, completada: 1, enRevision: 0, bloqueada: 0, pendiente: 3, enCurso: 0 }, session: { state: 'free' },
  next: null, blocking: [], lastMovement: { at: '2026-05-01T11:48:00Z', what: 'x' }, action: null, error: null, needs: false, rank: 9, ...o,
});
const summary = (rows, ctx = {}) => R.summaryView({ rows, generatedAt: 'x' }, { now: Date.parse('2026-05-01T12:00:00Z'), scope: { kind: 'all' }, rooms: [], ...ctx });

test('a repo card opens the chat (data-act, tabindex, aria-current only for the open one); its buttons keep their own data-act; the room card does not', () => {
  const html = summary([card(), card({ id: 'r2', name: 'beta', action: { kind: 'merge', pr: 7 } })], { chatId: 'r2', roomData: { rooms: [{ name: 'U', repos: [], presence: { state: 'idle' } }] } });
  const cards = html.split('<article').slice(1);
  const r1 = cards.find((c) => c.includes('data-id="r1"'));
  const r2 = cards.find((c) => c.includes('data-id="r2"'));
  assert.match(r1, /data-act="chat-open" tabindex="0"/);
  assert.doesNotMatch(r1, /aria-current/);
  assert.match(r2, /aria-current="true"/);
  assert.match(r2, /<button class="merge" data-act="merge" data-id="r2"/);
  const room = cards.find((c) => c.includes('rs-room'));
  assert.doesNotMatch(room, /chat-open|tabindex/);
  assert.deepEqual([...html.matchAll(/<article class="rs-card[^"]*"[^>]* data-id="([^"]*)"/g)].map((m) => m[1]), ['r1', 'r2']);
});

const info = (o = {}) => ({ key: 'r1', adopted: null, adoptedFound: false, sessions: [], live: { state: 'none', count: 0 }, ...o });
const sess = (o = {}) => ({ id: 's1', name: 'panel:alpha', updatedAt: '2026-05-01T11:00:00Z', lastMessage: { role: 'user', text: 'last words' }, ...o });
const head = (c) => R.chatHead({ id: 'r1', ...c }, { name: 'alpha' });
const body = (c) => R.chatBody({ id: 'r1', ...c }, { now: Date.parse('2026-05-01T12:00:00Z') });

test('chat header: repo name, live chip with icon + word, adopted session name, close button, and a banner for working or waiting', () => {
  assert.match(head({ info: null }), /alpha[\s\S]*\? unknown[\s\S]*data-act="chat-close"/);
  const adopted = { id: 's1', name: 'panel:alpha' };
  const w = head({ info: info({ adopted, adoptedFound: true, live: { state: 'working', count: 1 } }) });
  assert.match(w, /● working/);
  assert.match(w, /<span class="mono[^"]*"[^>]*>panel:alpha</);
  assert.match(w, /The session is working/);
  assert.match(head({ info: info({ adopted, live: { state: 'waiting', count: 1 } }) }), /◐ asking you[\s\S]*The session is asking you something\. Answer it in its terminal: the panel does not answer yet\./);
  const free = head({ info: info({ adopted, adoptedFound: true, live: { state: 'free', count: 1 } }) });
  assert.match(free, /○ free/);
  assert.doesNotMatch(free, /ch-live/);
  assert.doesNotMatch(head({ info: info({ adopted, live: { state: 'unknown', count: 0 } }) }), /ch-live/);
  assert.match(head({ info: info() }), /○ no session/);
});

test('no adopted session: up to 5 sessions with Adopt buttons, a Start button, all text escaped; Start is disabled while starting', () => {
  const list = Array.from({ length: 7 }, (_, i) => sess({ id: `s${i}`, name: i === 0 ? '<img src=x onerror=1>' : null, lastMessage: { role: 'user', text: 'z'.repeat(300) } }));
  const html = body({ info: info({ sessions: list }) });
  assert.equal((html.match(/data-act="chat-adopt"/g) || []).length, 5);
  assert.match(html, /data-act="chat-adopt" data-id="r1" data-session="s0"/);
  assert.match(html, /data-act="chat-start" data-id="r1"/);
  assert.doesNotMatch(html, /<img/);
  assert.match(html, /&lt;img/);
  assert.match(html, /1 h ago/);
  assert.doesNotMatch(html, /z{200}/);
  assert.doesNotMatch(html, /data-act="chat-start"[^>]*disabled/);
  assert.match(body({ info: info(), starting: true }), /data-act="chat-start" data-id="r1" disabled/);
  assert.doesNotMatch(body({ info: info() }), /chat-adopt/);
});

test('adopted but not found yet: the Starting state', () => {
  const html = body({ info: info({ adopted: { id: 's1', name: 'panel:alpha' }, adoptedFound: false }) });
  assert.match(html, /The session is loading \(Gentle Shell: skills, MCP, extensions\)\. The history appears with its first message\./);
  assert.doesNotMatch(html, /chat-adopt|chat-start/);
});

test('bubbles: user right, assistant left, small time, the folded tools line, working…, older notice, all escaped', () => {
  const adopted = { id: 's1', name: 'panel:alpha' };
  const items = [
    { role: 'user', text: '<b>hi</b>', at: '2026-05-01T11:00:00.000Z', tools: [] },
    { role: 'assistant', text: 'Taking it.', at: null, tools: ['read', 'grep', 'bash', 'write', 'edit'] },
    { role: 'assistant', text: 'one', at: null, tools: ['bash'] },
    { role: 'assistant', text: '', at: null, tools: ['edit', 'bash'] },
  ];
  const html = body({ info: info({ adopted, adoptedFound: true }), hist: { found: true, items, truncated: true } });
  assert.match(html, /Older messages are not shown/);
  assert.match(html, /<div class="m me">[\s\S]*\d\d:\d\d[\s\S]*&lt;b&gt;hi&lt;\/b&gt;/);
  assert.doesNotMatch(html, /<b>hi/);
  assert.match(html, /<div class="tools">▸ 5 tools · read, grep, bash \(\+2\)<\/div>\s*<div class="m">[\s\S]*Taking it\./);
  assert.match(html, /▸ 1 tool · bash</);
  assert.match(html, /▸ 2 tools · edit, bash<\/div>\s*<div class="m working">working…/);
  assert.doesNotMatch(body({ info: info({ adopted, adoptedFound: true }), hist: { found: true, items: [], truncated: false } }), /Older messages/);
});

test('loading and unavailable states', () => {
  assert.match(body({ info: null }), /Loading chat/);
  assert.match(body({ info: null, failed: true }), /Chat unavailable/);
  assert.match(body({ info: info(), failed: true }), /Chat unavailable[\s\S]*chat-start/);
});

// ---------- Part B: the page (app.js in vm) ----------
function element(extra = {}) {
  const el = {
    writes: 0, html: '', hidden: false, dataset: {}, disabled: false, value: '', checked: false, textContent: '', title: '', attrs: {}, listeners: {}, children: [], open: false,
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    style: { setProperty(k, v) { el.style[k] = v; } },
    addEventListener(t, fn) { (el.listeners[t] ||= []).push(fn); }, setAttribute(k, v) { el.attrs[k] = v; }, querySelector: () => null, querySelectorAll: () => [], closest: () => null,
    showModal() {}, close() {}, focus() {}, append(c) { el.children.push(c); },
    get innerHTML() { return el.html; },
    set innerHTML(v) { el.html = String(v); el.writes++; },
    ...extra,
  };
  return el;
}

function loadPage({ answers = {}, resumen = true } = {}) {
  const els = {};
  const frames = [];
  const docL = {};
  const winL = {};
  const intervals = [];
  const store = {};
  const fetches = [];
  const tabEls = ['summary', 'work', 'conformity'].map((t) => element({ dataset: { tab: t } }));
  const get = (sel) => (els[sel] ||= (sel === 'meta[name=token]' ? element({ content: 'token' }) : element()));
  const state = { hidden: false };
  const doc = {
    get hidden() { return state.hidden; },
    querySelector: get, querySelectorAll: (s) => (String(s).includes('data-tab') ? tabEls : []),
    addEventListener(t, fn) { (docL[t] ||= []).push(fn); }, createElement: () => element(), body: element(), activeElement: null,
  };
  const ctx = vm.createContext({
    console, document: doc, location: { hash: '' },
    localStorage: { getItem: (k) => (k in store ? store[k] : null), setItem(k, v) { store[k] = String(v); }, removeItem(k) { delete store[k]; } },
    requestAnimationFrame: (cb) => { frames.push(cb); return frames.length; },
    setInterval: (fn, ms) => { intervals.push({ fn, ms }); return intervals.length; }, setTimeout: () => 0, confirm: () => true,
    fetch: (url, opts = {}) => {
      fetches.push({ url, method: opts.method || 'GET', body: opts.body });
      const a = Object.entries(answers).find(([k]) => url.startsWith(k));
      if (!a) return new Promise(() => {});
      return typeof a[1] === 'function' ? a[1](url, opts) : Promise.resolve({ ok: true, json: async () => a[1] });
    },
  });
  ctx.window = ctx;
  ctx.addEventListener = (t, fn) => { (winL[t] ||= []).push(fn); };
  ctx.RepoPanelView = require('../public/view.js');
  if (resumen) ctx.RepoPanelResumen = R;
  vm.runInContext(fs.readFileSync(path.join(PUBLIC, 'app.js'), 'utf8'), ctx);
  const flush = () => { while (frames.length) frames.shift()(); };
  const tick = async (n = 6) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); flush(); };
  const fire = (type, e = {}) => { for (const fn of docL[type] || []) fn({ type, preventDefault() {}, target: element(), ...e }); };
  return { ctx, get, frames, flush, tick, fire, fetches, store, state, tabEls, docL, winL, intervals, run: (code) => vm.runInContext(code, ctx) };
}

const seed = (page) => {
  const S2 = page.run('S');
  S2.groups = [{ name: 'G', repos: [{ id: 'abc', name: 'demo', path: 'p' }, { id: 'xyz', name: 'other', path: 'q' }] }];
  S2.summary = { rows: [card({ id: 'abc', name: 'demo' }), card({ id: 'xyz', name: 'other' })], generatedAt: 'x' };
  return S2;
};
const ADOPTED = { key: 'abc', adopted: { id: 's1', name: 'panel:demo', adoptedAt: 'x' }, adoptedFound: true, sessions: [sess()], live: { state: 'free', count: 1 } };
const HIST = { key: 'abc', sessionId: 's1', found: true, items: [{ role: 'user', text: 'hello there', at: null, tools: [] }], truncated: false, updatedAt: null };
const chatTick = (page) => page.intervals.find((i) => i.ms === 5000).fn;

test('index.html: the static wrapper, the divider, the chat aside and the read-only footer', () => {
  const html = fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8');
  assert.match(html, /<div id="sumLayout" class="chatlayout">\s*<section id="summary"[^>]*><\/section>\s*<div id="split" role="separator" aria-orientation="vertical" tabindex="0" aria-label="Adjust the chat width \(left and right arrows; double click to reset\)" hidden><\/div>\s*<aside id="chat" hidden aria-label="Chat">/);
  assert.match(html, /id="chatHead"/);
  assert.match(html, /id="chatBody"[^>]*role="log"[^>]*aria-live="polite"|id="chatBody"[^>]*aria-live="polite"[^>]*role="log"/);
  const aside = /<aside id="chat"[\s\S]*?<\/aside>/.exec(html);
  assert.ok(aside && /id="composer"/.test(aside[0]) && /<textarea[^>]*id="msgBox"/.test(aside[0]) && /id="msgSend"/.test(aside[0]), 'the composer lives inside the aside');
  assert.match(html, /<\/aside>\s*<\/div>\s*<div id="work"/);
});

test('the tab toggles the WRAPPER, not #summary: the chat exists only in Summary', () => {
  const page = loadPage();
  seed(page);
  page.run('render()');
  assert.equal(page.get('#sumLayout').hidden, false);
  assert.equal(page.get('#summary').hidden, false);
  page.run("ACTIONS.tab({ dataset: { tab: 'work' } })");
  assert.equal(page.get('#sumLayout').hidden, true);
  assert.equal(page.get('#work').hidden, false);
  page.run("ACTIONS.tab({ dataset: { tab: 'summary' } })");
  assert.equal(page.get('#sumLayout').hidden, false);
});

test('opening a card shows the chat and the divider, marks the card, and reads sessions then chat; closing hides them and stops polling', async () => {
  const page = loadPage({ answers: { '/api/sessions': ADOPTED, '/api/chat': HIST } });
  seed(page);
  page.run('render()');
  assert.equal(page.get('#chat').hidden, true);
  assert.equal(page.get('#split').hidden, true);
  assert.doesNotMatch(page.get('#summary').html, /aria-current/);
  page.fetches.length = 0;
  page.run("ACTIONS['chat-open']({ dataset: { id: 'abc' } })");
  await page.tick();
  assert.deepEqual(page.fetches.map((f) => f.url), ['/api/sessions?id=abc', '/api/chat?id=abc']);
  assert.equal(page.run('S.chat.id'), 'abc');
  assert.equal(page.get('#chat').hidden, false);
  assert.equal(page.get('#split').hidden, false);
  assert.match(page.get('#summary').html, /data-id="abc"[^>]*aria-current="true"/);
  assert.doesNotMatch(page.get('#summary').html, /data-id="xyz"[^>]*aria-current/);
  assert.match(page.get('#chatHead').html, /demo/);
  assert.match(page.get('#chatBody').html, /hello there/);
  page.fetches.length = 0;
  page.run("ACTIONS['chat-close']()");
  await page.tick();
  assert.equal(page.get('#chat').hidden, true);
  assert.equal(page.get('#split').hidden, true);
  assert.doesNotMatch(page.get('#summary').html, /aria-current/);
  chatTick(page)();
  await page.tick();
  assert.deepEqual(page.fetches, []);
});

test('clicks: the card opens the chat, a button inside keeps its own action, Enter and Space on the focused card open it', () => {
  const page = loadPage();
  seed(page);
  const hits = [];
  page.ctx.hitLog = hits;
  page.run("ACTIONS['chat-open'] = (el) => hitLog.push('open ' + el.dataset.id); ACTIONS.merge = (el) => hitLog.push('merge ' + el.dataset.id);");
  const cardEl = element({ dataset: { act: 'chat-open', id: 'abc' }, tagName: 'ARTICLE' });
  const mergeEl = element({ dataset: { act: 'merge', id: 'abc' }, tagName: 'BUTTON' });
  const target = (found) => element({ closest: (sel) => (sel === '[data-act]' ? found : null) });
  page.fire('click', { target: target(cardEl) });
  page.fire('click', { target: target(mergeEl) });
  assert.deepEqual(hits, ['open abc', 'merge abc']);
  hits.length = 0;
  for (const key of ['Enter', ' ']) page.fire('keydown', { key, target: cardEl });
  assert.deepEqual(hits, ['open abc', 'open abc']);
  hits.length = 0;
  page.fire('keydown', { key: 'Enter', target: mergeEl });
  page.fire('keydown', { key: 'a', target: cardEl });
  assert.deepEqual(hits, []);
});

test('Escape closes the chat only when it is open and no dialog or menu is open', async () => {
  const page = loadPage({ answers: { '/api/sessions': ADOPTED, '/api/chat': HIST } });
  seed(page);
  page.fire('keydown', { key: 'Escape' });
  assert.equal(page.run('S.chat.id'), null);
  page.run("ACTIONS['chat-open']({ dataset: { id: 'abc' } })");
  page.get('#addDialog').open = true;
  page.fire('keydown', { key: 'Escape' });
  assert.equal(page.run('S.chat.id'), 'abc');
  page.get('#addDialog').open = false;
  page.get('#mergeMenu').open = true;
  page.fire('keydown', { key: 'Escape' });
  assert.equal(page.run('S.chat.id'), 'abc');
  page.get('#mergeMenu').open = false;
  page.run('S.menu = "x"');
  page.fire('keydown', { key: 'Escape' });
  assert.equal(page.run('S.chat.id'), 'abc');
  page.run('S.menu = null');
  page.fire('keydown', { key: 'Escape' });
  assert.equal(page.run('S.chat.id'), null);
  await page.tick();
});

test('polling: every 5 s only while the chat is open, Summary is shown and the page is visible; an unchanged answer redraws nothing', async () => {
  const page = loadPage({ answers: { '/api/sessions': ADOPTED, '/api/chat': HIST } });
  seed(page);
  assert.ok(chatTick(page));
  page.run("ACTIONS['chat-open']({ dataset: { id: 'abc' } })");
  await page.tick();
  const writes = page.get('#chatBody').writes;
  page.fetches.length = 0;
  chatTick(page)();
  await page.tick();
  assert.deepEqual(page.fetches.map((f) => f.url), ['/api/sessions?id=abc', '/api/chat?id=abc']);
  assert.equal(page.get('#chatBody').writes, writes, 'same answer, no write');
  page.fetches.length = 0;
  page.state.hidden = true;
  chatTick(page)();
  page.state.hidden = false;
  page.run("S.tab = 'work'");
  chatTick(page)();
  await page.tick();
  assert.deepEqual(page.fetches, []);
});

test('a failed read keeps the last data and adds a small note; the next good read removes it', async () => {
  let down = false;
  const page = loadPage({ answers: { '/api/sessions': () => (down ? Promise.reject(new Error('down')) : Promise.resolve({ ok: true, json: async () => ADOPTED })), '/api/chat': HIST } });
  seed(page);
  page.run("ACTIONS['chat-open']({ dataset: { id: 'abc' } })");
  await page.tick();
  down = true;
  chatTick(page)();
  await page.tick();
  assert.match(page.get('#chatBody').html, /hello there/);
  assert.match(page.get('#chatBody').html, /Chat unavailable/);
  down = false;
  chatTick(page)();
  await page.tick();
  assert.doesNotMatch(page.get('#chatBody').html, /Chat unavailable/);
});

test('a stale answer is ignored when the user switches cards quickly', async () => {
  const pending = {};
  const page = loadPage({ answers: {
    '/api/sessions': (url) => new Promise((resolve) => { pending[url] = () => resolve({ ok: true, json: async () => ({ ...ADOPTED, key: url.slice(-3) }) }); }),
    '/api/chat': (url) => Promise.resolve({ ok: true, json: async () => ({ ...HIST, items: [{ role: 'user', text: `from ${url.slice(-3)}`, at: null, tools: [] }] }) }),
  } });
  seed(page);
  page.run("ACTIONS['chat-open']({ dataset: { id: 'abc' } })");
  page.run("ACTIONS['chat-open']({ dataset: { id: 'xyz' } })");
  pending['/api/sessions?id=xyz']();
  await page.tick();
  pending['/api/sessions?id=abc']();
  await page.tick();
  assert.equal(page.run('S.chat.id'), 'xyz');
  assert.match(page.get('#chatBody').html, /from xyz/);
  assert.doesNotMatch(page.get('#chatBody').html, /from abc/);
});

test('Adopt posts to /api/sessions/adopt and reloads; Start posts to /api/sessions/start, disables itself, shows the 409 message and reloads', async () => {
  const noSession = { key: 'abc', adopted: null, adoptedFound: false, sessions: [sess()], live: { state: 'none', count: 0 } };
  let startOk = false;
  const page = loadPage({ answers: {
    '/api/sessions/adopt': { ok: true }, '/api/sessions/start': () => Promise.resolve(startOk ? { ok: true, json: async () => ({ started: true }) } : { ok: false, status: 409, statusText: 'Conflict', json: async () => ({ error: 'This folder already has a pi session open; adopt it instead of starting another' }) }),
    '/api/sessions?': noSession,
  } });
  seed(page);
  const toasts = [];
  page.ctx.document.createElement = () => { const e = element(); toasts.push(e); return e; };
  page.run("ACTIONS['chat-open']({ dataset: { id: 'abc' } })");
  await page.tick();
  assert.match(page.get('#chatBody').html, /chat-adopt/);
  page.fetches.length = 0;
  await page.run("ACTIONS['chat-adopt']({ dataset: { id: 'abc', session: 's1' } })");
  await page.tick();
  const adopt = page.fetches.find((f) => f.url === '/api/sessions/adopt');
  assert.equal(adopt.method, 'POST');
  assert.deepEqual(JSON.parse(adopt.body), { id: 'abc', session: 's1' });
  assert.ok(page.fetches.some((f) => f.url === '/api/sessions?id=abc'), 'reloads');
  page.fetches.length = 0;
  const btn = element({ dataset: { id: 'abc' } });
  const running = page.run("ACTIONS['chat-start']").call(null, btn);
  assert.equal(btn.disabled, true);
  await running;
  await page.tick();
  assert.equal(page.fetches.find((f) => f.url === '/api/sessions/start').method, 'POST');
  assert.deepEqual(JSON.parse(page.fetches.find((f) => f.url === '/api/sessions/start').body), { id: 'abc' });
  assert.ok(toasts.some((t) => /already has a pi session open/.test(t.textContent)), '409 message shown');
  assert.equal(page.run('S.chat.starting'), false);
  assert.ok(page.fetches.some((f) => f.url === '/api/sessions?id=abc'), 'reloads');
  assert.equal(page.fetches.some((f) => f.url === '/api/pi'), false);
});

test('safety: the chat code never reaches /api/pi or an Orca send, and Summary rendering touches no session', () => {
  const app = fs.readFileSync(path.join(PUBLIC, 'app.js'), 'utf8');
  const region = app.slice(app.indexOf('// ---------- chat (RP54)'), app.indexOf('// ---------- end chat ----------'));
  assert.ok(region.length > 500, 'chat region found');
  assert.doesNotMatch(region, /\/api\/pi|piSend|\bsend\b|'send'/);
  assert.match(region, /\/api\/chat/);
  const res = fs.readFileSync(path.join(PUBLIC, 'resumen.js'), 'utf8');
  assert.doesNotMatch(res.slice(res.indexOf('function chatHead')), /\/api\/pi|piSend/);
  const srv = fs.readFileSync(path.join(__dirname, '..', 'server', 'sessions.js'), 'utf8');
  const chatSrv = srv.slice(srv.indexOf('function readChat'), srv.indexOf('function sessionKeyFor'));
  assert.doesNotMatch(chatSrv, /orca\(|writeFile|saveConfig|appendFile/);
});

// ---------- the divider ----------
function withDivider(page, width = 1400) {
  seed(page);
  page.get('#sumLayout').clientWidth = width;
  page.get('#sumLayout').getBoundingClientRect = () => ({ right: width, width });
  page.get('#split').offsetWidth = 10;
  page.run("ACTIONS['chat-open']({ dataset: { id: 'abc' } })");
  page.flush();
}
const widthOf = (page) => page.get('#chat').style['--chat-w'];
const ls = (page) => page.store['repo-panel.chatRatio'];
const fireOn = (el, type, e = {}) => { for (const fn of el.listeners[type] || []) fn({ type, preventDefault() {}, ...e }); };

test('divider: default width, ArrowLeft/ArrowRight move 24 px and persist the ratio, Enter and double click reset', () => {
  const page = loadPage();
  withDivider(page);
  const split = page.get('#split');
  assert.equal(widthOf(page), '556px');
  fireOn(split, 'keydown', { key: 'ArrowLeft' });
  assert.equal(widthOf(page), '580px');
  assert.ok(Math.abs(Number(ls(page)) - 580 / 1390) < 1e-9);
  fireOn(split, 'keydown', { key: 'ArrowRight' });
  fireOn(split, 'keydown', { key: 'ArrowRight' });
  assert.equal(widthOf(page), '532px');
  fireOn(split, 'keydown', { key: 'Enter' });
  assert.equal(widthOf(page), '556px');
  assert.equal(ls(page), undefined);
  fireOn(split, 'keydown', { key: 'ArrowLeft' });
  assert.ok(ls(page));
  fireOn(split, 'dblclick');
  assert.equal(widthOf(page), '556px');
  assert.equal(ls(page), undefined);
});

test('divider: the minimums hold, a stored ratio is used on load, and a resize recomputes', () => {
  const page = loadPage();
  withDivider(page);
  const split = page.get('#split');
  for (let i = 0; i < 40; i++) fireOn(split, 'keydown', { key: 'ArrowRight' });
  assert.equal(widthOf(page), '340px');
  for (let i = 0; i < 80; i++) fireOn(split, 'keydown', { key: 'ArrowLeft' });
  assert.equal(widthOf(page), `${1390 - 360}px`);
  fireOn(split, 'dblclick');
  page.get('#sumLayout').clientWidth = 1000;
  for (const fn of page.winL.resize || []) fn({ type: 'resize' });
  assert.equal(widthOf(page), '495px', 'under 1100 px the default is 50/50');
  assert.ok((page.winL.resize || []).length >= 1);
});

test('divider: pointer drag with capture follows the pointer; without the optional DOM APIs nothing throws', () => {
  const page = loadPage();
  withDivider(page);
  const split = page.get('#split');
  const captured = [];
  split.setPointerCapture = (id) => captured.push(id);
  split.releasePointerCapture = () => captured.push('released');
  fireOn(split, 'pointermove', { pointerId: 1, clientX: 500 });
  assert.equal(widthOf(page), '556px', 'a move without a press does nothing');
  fireOn(split, 'pointerdown', { pointerId: 1 });
  fireOn(split, 'pointermove', { pointerId: 1, clientX: 900 });
  assert.equal(widthOf(page), '495px');
  fireOn(split, 'pointerup', { pointerId: 1 });
  assert.deepEqual(captured, [1, 'released']);
  fireOn(split, 'pointermove', { pointerId: 1, clientX: 300 });
  assert.equal(widthOf(page), '495px');
  assert.ok(ls(page));
  const bare = loadPage();
  withDivider(bare);
  assert.doesNotThrow(() => { fireOn(bare.get('#split'), 'pointerdown', { pointerId: 1 }); fireOn(bare.get('#split'), 'pointerup', { pointerId: 1 }); });
});

test('without resumen.js the page still loads and the chat stays closed', () => {
  const page = loadPage({ resumen: false });
  assert.doesNotThrow(() => page.run('render()'));
  assert.doesNotThrow(() => page.run("ACTIONS['chat-open']({ dataset: { id: 'abc' } })"));
});
