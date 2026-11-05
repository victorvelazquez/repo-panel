'use strict';
// The ONE pi session the panel adopts per repo and per room (config.json `sessions`). Gentle Shell keeps every session
// as a .jsonl file under <base>/--<folder>--/; a file can be 25 MB, so the listing reads only its first and last 64 KB and the chat its last 512 KB.
// Nothing here sends text to a session.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { HttpError } = require('./errors.js');
const { loadConfig, saveConfig, findRepo } = require('./config.js');
const { chooseRuntime, findCached } = require('./piruntime.js');
const { argSummary } = require('./redact.js');

const CHUNK = 64 * 1024;
// RP104: the chat reads this much of the END of the session file (the listing keeps the 64 KB of CHUNK); the first line of the window may be partial and is dropped.
const CHAT_WINDOW = 512 * 1024;
const LIMIT = 20;
const TEXT_MAX = 200;
const CHAT_TEXT = 4000;
const CHAT_DEFAULT = 30;
const BLOCK_GAP = '\n\n';
const CHAT_MAX = 100;
const SESSION_ID = /^[A-Za-z0-9._-]{1,80}$/;

// REPO_PANEL_SESSIONS_DIR wins; else the folder of the ACTIVE pi (<agentDir>/sessions); with none active, or when detection fails, the
// old default (Gentle Shell's). The detection is sync and spawns nothing (files and PATH only), and `findCached` keeps it for 30 s.
function baseDir({ candidates = findCached } = {}) {
  if (process.env.REPO_PANEL_SESSIONS_DIR) return process.env.REPO_PANEL_SESSIONS_DIR;
  try {
    const { active } = chooseRuntime(candidates(), loadConfig().pi);
    if (active) return path.join(active.agentDir, 'sessions');
  } catch { /* keep the default */ }
  return path.join(os.homedir(), '.gentle-shell', 'agent', 'sessions');
}

// <base>/--<folder>--/ with the folder's `:`, `\` and `/` each turned into a dash (dots and spaces stay).
const sessionsDirFor = (folder, base = baseDir()) => path.join(base, `--${String(folder).replace(/[:\\/]/g, '-')}--`);

const normPath = (p) => String(p).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
const clean = (s) => String(s).replace(/[\x00-\x1f\x7f-\x9f\u2028\u2029]/g, ' ');
// Chat message text keeps its line structure: CRLF and CR become LF, LF and TAB stay, every other control becomes one space.
const cleanText = (s) => String(s).replace(/\r\n?/g, '\n').replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f\u2028\u2029]/g, ' ');
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

// A session file is exactly '<timestamp>_<id>.jsonl' and the timestamp has no underscore, so another id that merely ends with '_<id>' never matches.
const isSessionFile = (name, id) => name.endsWith(`_${id}.jsonl`) && name.length > id.length + 7 && !name.slice(0, name.length - id.length - 7).includes('_');
const hasSession = (folder, id, base) => {
  try { return fs.readdirSync(sessionsDirFor(folder, base)).some((n) => isSessionFile(n, String(id))); } catch { return false; }
};

const isoOf = (t) => {
  const d = new Date(typeof t === 'string' && /^\d+$/.test(t) ? Number(t) : t);
  return typeof t === 'number' || typeof t === 'string' ? (Number.isNaN(d.getTime()) ? null : d.toISOString()) : null;
};
const capped = (s) => { const t = cleanText(s).trim(); return t.length > CHAT_TEXT ? `${t.slice(0, CHAT_TEXT)}…` : t; };
// RP106: NUMBERS about a tool result, never its text: the characters of its text blocks, and for an edit the lines its unified diff adds and removes (counted only after the
// first hunk header, so a changed line that starts with "--" or "++" is not taken for a file header).
const textSize = (c) => (typeof c === 'string' ? c.length : Array.isArray(c) ? c.reduce((n, b) => n + (b && b.type === 'text' && typeof b.text === 'string' ? b.text.length : 0), 0) : 0);
function patchLines(patch) {
  let add = 0;
  let del = 0;
  let inHunk = false;
  for (const l of patch.split('\n')) {
    if (l.startsWith('@@')) { inHunk = true; continue; }
    if (!inHunk) continue;
    if (l.startsWith('+')) add++;
    else if (l.startsWith('-')) del++;
  }
  return { add, del };
}
const blocksOf = (m, type) => (Array.isArray(m.content) ? m.content.filter((c) => c && c.type === type) : []);

// The history of one session for the chat panel: only the LAST 64 KB of its file is read (the first line of that window may be
// partial and is dropped). Only text reaches the output: no thinking text (only a `thinking` mark), no tool results (only their verdict and time); a tool is its NAME plus `toolInfo`: ok, ms and a redacted one-line argument (server/redact.js).
function readChat(folder, sessionId, { base = baseDir(), limit = CHAT_DEFAULT, key = null } = {}) {
  const none = { key, sessionId, found: false, items: [], truncated: false, updatedAt: null };
  let file;
  try { file = fs.readdirSync(sessionsDirFor(folder, base)).sort().find((n) => isSessionFile(n, String(sessionId))); } catch { return none; }
  if (!file) return none;
  const max = Math.min(CHAT_MAX, Math.floor(Number(limit)) > 0 ? Math.floor(Number(limit)) : CHAT_DEFAULT);
  let fd;
  try {
    fd = fs.openSync(path.join(sessionsDirFor(folder, base), file), 'r');
    const { size, mtimeMs } = fs.fstatSync(fd);
    const start = Math.max(0, size - CHAT_WINDOW);
    const items = [];
    let pending = [];
    let pendingInfo = [];
    const infoById = new Map(); // toolCallId -> the chip of that call, so its result (which comes later) fills ok and ms
    let thought = false;
    for (const entry of linesOf(readChunk(fd, start, size - start), start > 0, false).map(parse)) {
      // RP105b: a compaction of the context is only a mark in its place (its summary is long and private and never read).
      if (entry && entry.type === 'compaction') { items.push({ role: 'system', kind: 'compaction', text: '', at: isoOf(entry.timestamp), tools: [] }); continue; }
      const m = entry && entry.type === 'message' && entry.message;
      if (!m || typeof m !== 'object') continue;
      const at = isoOf(m.timestamp ?? entry.timestamp);
      const body = capped(blocksOf(m, 'text').filter((c) => typeof c.text === 'string').map((c) => c.text).join(BLOCK_GAP));
      if (m.role === 'toolResult') {
        const chip = typeof m.toolCallId === 'string' ? infoById.get(m.toolCallId) : undefined;
        if (chip) {
          Object.assign(chip, { ok: m.isError !== true, ms: Number.isFinite(m.durationMs) && m.durationMs >= 0 && m.durationMs <= 7 * 86400000 ? Math.round(m.durationMs) : null, size: textSize(m.content) }); // the verdict, the time and the size: the result text is never sent
          if (chip.name.toLowerCase() === 'edit' && m.details && typeof m.details.patch === 'string') Object.assign(chip, patchLines(m.details.patch));
        }
        continue;
      }
      if (m.role === 'user') { pending = []; pendingInfo = []; thought = false; if (body) items.push({ role: 'user', text: body, at, tools: [] }); continue; }
      if (m.role !== 'assistant') continue;
      if (blocksOf(m, 'thinking').length) thought = true; // only THAT it reasoned: the reasoning text never leaves the server
      for (const c of blocksOf(m, 'toolCall').filter((b) => typeof b.name === 'string')) {
        const chip = { name: clean(c.name).slice(0, 60), ok: null, ms: null, arg: argSummary(c.name, c.arguments) };
        pending.push(chip.name);
        pendingInfo.push(chip);
        if (typeof c.id === 'string') infoById.set(c.id, chip);
      }
      // RP105b: only the CATEGORY of a stopped or failed turn travels; the `errorMessage` (it can hold the raw body of an API answer) is never read. A turn that stopped with
      // no text is an item too (it was invisible before).
      const stop = m.stopReason === 'aborted' || m.stopReason === 'error' ? m.stopReason : null;
      if (body || stop) { items.push({ role: 'assistant', text: body, at, tools: pending, ...(pendingInfo.length ? { toolInfo: pendingInfo } : {}), ...(thought ? { thinking: true } : {}), ...(stop ? { stop } : {}) }); pending = []; pendingInfo = []; thought = false; }
    }
    if (pending.length || thought) items.push({ role: 'assistant', text: '', at: null, tools: pending, ...(pendingInfo.length ? { toolInfo: pendingInfo } : {}), ...(thought ? { thinking: true } : {}) });
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

// The live state from the RPC host's state; a room has no session of its own.
const HOST_LIVE = { idle: 'free', busy: 'working', starting: 'working', asking: 'waiting' };
const liveFromHost = (key, hostState) => {
  let state;
  try { state = key.startsWith('room:') ? 'closed' : hostState(key); } catch { state = 'closed'; }
  return HOST_LIVE[state] ? { state: HOST_LIVE[state], count: 1 } : { state: 'none', count: 0 };
};

async function sessionsState(id, base = baseDir(), hostState) {
  const { key, folder } = sessionKeyFor(id);
  const stored = (loadConfig().sessions || {})[key];
  return {
    key,
    adopted: stored ? { id: stored.id, name: stored.name, adoptedAt: stored.adoptedAt } : null,
    adoptedFound: stored ? hasSession(folder, stored.id, base) : false,
    sessions: listSessions(folder, { base }),
    live: liveFromHost(key, hostState),
  };
}

function store(key, entry) {
  const cfg = loadConfig();
  const sessions = { ...(cfg.sessions || {}) };
  if (entry) sessions[key] = entry; else delete sessions[key];
  saveConfig({ ...cfg, sessions });
}

async function adoptSession(id, session, base = baseDir(), hostState) {
  const { key, folder } = sessionKeyFor(id);
  const found = listSessions(folder, { base }).find((s) => s.id === session);
  if (!found) throw new HttpError(400, 'That session is not one of the sessions listed for this folder');
  store(key, { id: found.id, name: found.name || found.id, adoptedAt: new Date().toISOString() });
  return sessionsState(id, base, hostState);
}

async function releaseSession(id, base = baseDir(), hostState) {
  const { key } = sessionKeyFor(id);
  if ((loadConfig().sessions || {})[key]) store(key, null);
  return sessionsState(id, base, hostState);
}

// RPC2-1: `rpc/start` adopts the id it runs under when the repo has none, so the history (read from the adopted id) shows what the session writes.
// Same entry as `adoptSession` stores; an adopted session is never replaced and an id that is not a session id is never written.
function adoptIfNone(key, sid) {
  if (typeof sid !== 'string' || !SESSION_ID.test(sid) || (loadConfig().sessions || {})[key]) return false;
  store(key, { id: sid, name: sid, adoptedAt: new Date().toISOString() });
  return true;
}

module.exports = { baseDir, sessionsDirFor, listSessions, readChat, chatState, sessionKeyFor, sessionsState, adoptSession, releaseSession, adoptIfNone, SESSION_ID };
