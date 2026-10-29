'use strict';
// The ONE pi session the panel adopts per repo and per room (config.json `sessions`). Gentle Shell keeps every session
// as a .jsonl file under <base>/--<folder>--/; a file can be 25 MB, so only its first and last 64 KB are ever read.
// Nothing here sends text to a session: `startSession` only asks Orca to open a terminal that runs `gentle-shell`.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { HttpError } = require('./errors.js');
const { loadConfig, saveConfig, findRepo } = require('./config.js');
const { orcaTerminal, scanSessions } = require('./pi.js');

const CHUNK = 64 * 1024;
const LIMIT = 20;
const TEXT_MAX = 200;
const CHAT_TEXT = 4000;
const CHAT_DEFAULT = 30;
const CHAT_MAX = 100;
const SESSION_ID = /^[A-Za-z0-9._-]{1,80}$/;
const LIVE_OF = { idle: 'free', typed: 'free', busy: 'working', asking: 'waiting' };
const RANK = { free: 1, working: 2, waiting: 3 };

const starting = new Set();

const baseDir = () => process.env.REPO_PANEL_SESSIONS_DIR || path.join(os.homedir(), '.gentle-shell', 'agent', 'sessions');

// <base>/--<folder>--/ with the folder's `:`, `\` and `/` each turned into a dash (dots and spaces stay).
const sessionsDirFor = (folder, base = baseDir()) => path.join(base, `--${String(folder).replace(/[:\\/]/g, '-')}--`);

const normPath = (p) => String(p).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
const clean = (s) => String(s).replace(/[\x00-\x1f\x7f-\x9f\u2028\u2029]/g, ' ');
const parse = (line) => { try { return JSON.parse(line); } catch { return null; } };

// Complete lines of a chunk: the first one is dropped when the chunk starts mid-file, the last when it ends mid-file.
function linesOf(buf, partialStart, partialEnd) {
  const lines = buf.toString('utf8').split('\n');
  if (partialStart) lines.shift();
  if (partialEnd) lines.pop();
  return lines.filter((l) => l.trim());
}

function readChunk(fd, position, length) {
  const buf = Buffer.alloc(length);
  const n = fs.readSync(fd, buf, 0, length, position);
  return buf.subarray(0, n);
}

const textOf = (m) => (Array.isArray(m.content) ? m.content.filter((c) => c && c.type === 'text' && typeof c.text === 'string').map((c) => c.text).join(' ') : '');

// The session of one file, or null when its first line is not a session header. Throws only on I/O errors.
function readSession(file, folder, mtimeMs) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const head = readChunk(fd, 0, Math.min(size, CHUNK));
    const whole = size <= CHUNK;
    const nl = head.indexOf(10);
    if (nl < 0 && !whole) return null;
    const first = parse(head.subarray(0, nl < 0 ? head.length : nl).toString('utf8'));
    if (!first || first.type !== 'session' || typeof first.id !== 'string' || !SESSION_ID.test(first.id)) return null;
    const tail = whole ? head : readChunk(fd, size - CHUNK, CHUNK);
    const tailLines = linesOf(tail, !whole, false).map(parse).filter(Boolean);
    const nameIn = (entries) => entries.reverse().find((e) => e.type === 'session_info' && typeof e.name === 'string' && e.name.trim());
    const info = nameIn(tailLines.slice()) || nameIn(linesOf(head, false, !whole).map(parse).filter(Boolean));
    let lastMessage = null;
    for (let i = tailLines.length - 1; i >= 0 && !lastMessage; i--) {
      const m = tailLines[i].type === 'message' && tailLines[i].message;
      if (!m || (m.role !== 'user' && m.role !== 'assistant')) continue;
      const text = clean(textOf(m)).slice(0, TEXT_MAX);
      if (text.trim()) lastMessage = { role: m.role, text };
    }
    return {
      id: first.id, name: info ? clean(info.name).trim().slice(0, 100) : null, file,
      startedAt: typeof first.timestamp === 'string' ? first.timestamp : null,
      updatedAt: new Date(mtimeMs).toISOString(), lastMessage,
      cwdMatches: typeof first.cwd === 'string' && normPath(first.cwd) === normPath(folder),
    };
  } finally { fs.closeSync(fd); }
}

// The sessions of a folder, newest first by file mtime, at most `limit`. A file that cannot be read is skipped.
function listSessions(folder, { base = baseDir(), limit = LIMIT } = {}) {
  const dir = sessionsDirFor(folder, base);
  let names = [];
  try { names = fs.readdirSync(dir).filter((n) => n.endsWith('.jsonl')); } catch { return []; }
  const files = [];
  for (const n of names) {
    try { files.push({ file: path.join(dir, n), mtimeMs: fs.statSync(path.join(dir, n)).mtimeMs }); } catch { /* vanished */ }
  }
  files.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const out = [];
  for (const f of files) {
    if (out.length >= limit) break;
    try { const s = readSession(f.file, folder, f.mtimeMs); if (s) out.push(s); } catch { /* unreadable file */ }
  }
  return out;
}

const hasSession = (folder, id, base) => {
  try { return fs.readdirSync(sessionsDirFor(folder, base)).some((n) => n.endsWith(`_${id}.jsonl`)); } catch { return false; }
};

const isoOf = (t) => {
  const d = new Date(typeof t === 'string' && /^\d+$/.test(t) ? Number(t) : t);
  return typeof t === 'number' || typeof t === 'string' ? (Number.isNaN(d.getTime()) ? null : d.toISOString()) : null;
};
const capped = (s) => { const t = clean(s).trim(); return t.length > CHAT_TEXT ? `${t.slice(0, CHAT_TEXT)}…` : t; };
const blocksOf = (m, type) => (Array.isArray(m.content) ? m.content.filter((c) => c && c.type === type) : []);

// The history of one session for the chat panel: only the LAST 64 KB of its file is read (the first line of that window may be
// partial and is dropped). Only text reaches the output: no thinking, no tool arguments, no tool results; a tool is its NAME.
function readChat(folder, sessionId, { base = baseDir(), limit = CHAT_DEFAULT, key = null } = {}) {
  const none = { key, sessionId, found: false, items: [], truncated: false, updatedAt: null };
  let file;
  try { file = fs.readdirSync(sessionsDirFor(folder, base)).sort().find((n) => n.endsWith(`_${sessionId}.jsonl`)); } catch { return none; }
  if (!file) return none;
  const max = Math.min(CHAT_MAX, Math.floor(Number(limit)) > 0 ? Math.floor(Number(limit)) : CHAT_DEFAULT);
  let fd;
  try {
    fd = fs.openSync(path.join(sessionsDirFor(folder, base), file), 'r');
    const { size, mtimeMs } = fs.fstatSync(fd);
    const start = Math.max(0, size - CHUNK);
    const items = [];
    let pending = [];
    for (const entry of linesOf(readChunk(fd, start, size - start), start > 0, false).map(parse)) {
      const m = entry && entry.type === 'message' && entry.message;
      if (!m || typeof m !== 'object') continue;
      const at = isoOf(m.timestamp ?? entry.timestamp);
      const body = capped(blocksOf(m, 'text').filter((c) => typeof c.text === 'string').map((c) => c.text).join(' '));
      if (m.role === 'user') { pending = []; if (body) items.push({ role: 'user', text: body, at, tools: [] }); continue; }
      if (m.role !== 'assistant') continue;
      pending.push(...blocksOf(m, 'toolCall').filter((c) => typeof c.name === 'string').map((c) => clean(c.name).slice(0, 60)));
      if (body) { items.push({ role: 'assistant', text: body, at, tools: pending }); pending = []; }
    }
    if (pending.length) items.push({ role: 'assistant', text: '', at: null, tools: pending });
    return { key, sessionId, found: true, items: items.slice(-max), truncated: start > 0 || items.length > max, updatedAt: new Date(mtimeMs).toISOString() };
  } catch { return none; } finally { if (fd !== undefined) fs.closeSync(fd); }
}

// GET /api/chat: the adopted session of the key, or an explicit one that must be among the folder's listed sessions.
function chatState(id, session, limit, base = baseDir()) {
  const { key, folder } = sessionKeyFor(id);
  let sid = null;
  if (session) {
    if (!SESSION_ID.test(session)) throw new HttpError(400, 'Invalid session id');
    if (!listSessions(folder, { base }).some((s) => s.id === session)) throw new HttpError(400, 'That session is not one of the sessions listed for this folder');
    sid = session;
  } else {
    const stored = (loadConfig().sessions || {})[key];
    sid = stored ? stored.id : null;
  }
  return sid ? readChat(folder, sid, { base, limit, key }) : { key, sessionId: null, found: false, items: [], truncated: false, updatedAt: null };
}

// What an adopted-session key stands for: a repo id, or "room:<name>". Unknown keys are 404, as in the other routes.
function sessionKeyFor(id) {
  if (typeof id === 'string' && id.startsWith('room:')) {
    const name = id.slice(5);
    const room = (loadConfig().rooms || []).find((r) => r.name === name);
    if (!room) throw new HttpError(404, 'Unknown room');
    return { key: id, folder: room.path, prefix: 'sala', label: room.name };
  }
  const repo = findRepo(id);
  return { key: id, folder: repo.path, prefix: 'panel', label: path.basename(repo.path) };
}

// Orca is listed ONCE; the folder's screens are then read with `scanSessions`. An Orca failure is unknown, never none.
async function liveOf(folder, orca) {
  try {
    const terminals = (await orca(['list'])).terminals;
    if (!Array.isArray(terminals)) return { state: 'unknown', count: 0 };
    const { sessions, failed } = await scanSessions(folder, orca, terminals, false, true);
    if (!sessions.length) return { state: failed ? 'unknown' : 'none', count: 0 };
    const state = sessions.map((s) => LIVE_OF[s.state] || 'free').reduce((a, b) => (RANK[b] > RANK[a] ? b : a));
    return { state, count: sessions.length };
  } catch { return { state: 'unknown', count: 0 }; }
}

async function sessionsState(id, orca = orcaTerminal, base = baseDir()) {
  const { key, folder } = sessionKeyFor(id);
  const stored = (loadConfig().sessions || {})[key];
  return {
    key,
    adopted: stored ? { id: stored.id, name: stored.name, adoptedAt: stored.adoptedAt } : null,
    adoptedFound: stored ? hasSession(folder, stored.id, base) : false,
    sessions: listSessions(folder, { base }),
    live: await liveOf(folder, orca),
  };
}

function store(key, entry) {
  const cfg = loadConfig();
  const sessions = { ...(cfg.sessions || {}) };
  if (entry) sessions[key] = entry; else delete sessions[key];
  saveConfig({ ...cfg, sessions });
}

async function adoptSession(id, session, orca = orcaTerminal, base = baseDir()) {
  const { key, folder } = sessionKeyFor(id);
  const found = listSessions(folder, { base }).find((s) => s.id === session);
  if (!found) throw new HttpError(400, 'That session is not one of the sessions listed for this folder');
  store(key, { id: found.id, name: found.name || found.id, adoptedAt: new Date().toISOString() });
  return sessionsState(id, orca, base);
}

async function releaseSession(id, orca = orcaTerminal, base = baseDir()) {
  const { key } = sessionKeyFor(id);
  if ((loadConfig().sessions || {})[key]) store(key, null);
  return sessionsState(id, orca, base);
}

// Opens a terminal that runs `gentle-shell -n <name> --session-id <id>` and adopts that id. The id and the name are
// built here from the repo or room name with a closed character set, so nothing else reaches the command string.
async function startSession(id, orca = orcaTerminal) {
  const { key, folder, prefix, label } = sessionKeyFor(id);
  if (starting.has(key)) throw new HttpError(409, 'A session is already being started for this folder');
  starting.add(key);
  try {
    const sid = `${prefix}-${label.toLowerCase().replace(/[^a-z0-9.-]/g, '-')}`.slice(0, 80);
    const name = `${prefix === 'sala' ? 'sala' : 'panel'}:${label.replace(/[^A-Za-z0-9._-]/g, '-')}`.slice(0, 100);
    const live = await liveOf(folder, orca);
    if (live.state === 'unknown') throw new HttpError(409, 'Orca could not be read, so it is not known whether a pi session is already open; try again');
    if (live.state !== 'none') throw new HttpError(409, 'This folder already has a pi session open; adopt it instead of starting another');
    const created = await orca(['create', '--worktree', `path:${folder}`, '--title', name, '--command', `gentle-shell -n ${name} --session-id ${sid}`]);
    store(key, { id: sid, name, adoptedAt: new Date().toISOString() });
    return { started: true, handle: (created.terminal && created.terminal.handle) || null, id: sid, name, state: 'starting' };
  } finally { starting.delete(key); }
}

module.exports = { sessionsDirFor, listSessions, readChat, chatState, sessionKeyFor, sessionsState, adoptSession, releaseSession, startSession, SESSION_ID };
