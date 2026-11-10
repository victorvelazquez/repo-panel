'use strict';
// One pi session per repo, kept INSIDE the panel process (RPC1b, S1, S2): started on demand with `--mode rpc` in the repo's folder from
// config.json (never from a request) under the same `--session-id` every time, so a panel restart ends the sessions and they come back
// with that id. There is no separate daemon. The browser can only start, prompt, steer, abort and answer a pending dialog; it never names
// a program, a folder or an argument. Everything it sends is cleaned or refused with a fixed message that echoes nothing.
const path = require('node:path');
const crypto = require('node:crypto');
const { HttpError } = require('./errors.js');
const { loadConfig } = require('./config.js');
const { runtimeEnv } = require('./piruntime.js');
const { createRpcClient, RpcError } = require('./rpc.js');

const TEXT_MAX = 20000;
const ANSWER_MAX = 4000;
const EVENT_MAX = 256 * 1024;
const SESSION_ID = /^[A-Za-z0-9._-]{1,80}$/;
// Everything but LF and TAB (C0, DEL, C1, line separators, bidi and zero-width controls).
const CONTROLS = /[\x00-\x08\x0b-\x1f\x7f-\x9f\u2028\u2029\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g;
const BEHAVIORS = ['steer', 'followUp'];
const STATES = ['closed', 'starting', 'idle', 'busy', 'asking'];
const SESSION_CLOSED = 'The session was closed';

// Text typed in the browser: CR and CRLF become LF, controls go, ends are trimmed. Too long is refused, never cut; a leading `!` is a
// shell command for pi, so it is refused too.
function cleanText(value) {
  if (typeof value !== 'string') throw new HttpError(400, 'The text must be a string');
  const clean = value.replace(/\r\n?/g, '\n').replace(CONTROLS, '').trim();
  if (!clean) throw new HttpError(400, 'Write something to send');
  if (clean.length > TEXT_MAX) throw new HttpError(400, `The message is longer than ${TEXT_MAX} characters`);
  if (clean.startsWith('!')) throw new HttpError(400, 'Messages that start with ! run a shell command; type those in the terminal');
  return clean;
}

// The adopted session of the repo (config.json `sessions`), else `panel-<slug>-<id>` like the sessions the panel names itself. RP97: the id is the first 8 letters and digits of the repo id
// (the hash of its path), so two repos whose last folder has the same name (`C:\a\app`, `C:\b\app`) never share an id; an adopted id always wins, so no repo that already runs a session changes id.
function sessionIdFor(repo, adopted) {
  if (adopted && typeof adopted.id === 'string' && SESSION_ID.test(adopted.id)) return adopted.id;
  const { slug, own } = idParts(repo, 60);
  if (!slug) return `panel-${own.slice(0, 20) || 'repo'}`;
  return `panel-${slug}${own ? `-${own.slice(0, 8)}` : ''}`;
}
// The two parts of a panel session id: the last folder name with BOTH separators (`path.basename` only knows the ones of the platform, so a Windows path read on Linux would give the whole
// string), cut to `cap`, and the letters and digits of the repo id.
function idParts(repo, cap) {
  const slug = (String(repo.path).split(/[\\/]/).filter((s) => s && !/^[A-Za-z]:$/.test(s)).pop() || '').toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '').slice(0, cap);
  return { slug, own: (repo.id == null ? '' : String(repo.id)).replace(/[^A-Za-z0-9]/g, '') };
}
// RP99: the id of a NEW session: the id of RP97 plus a unique part, so a new session never resumes an old one (the id of RP97 is the same for every session of the repo). The folder name is cut
// to 50 so the whole id stays within the 80 characters of SESSION_ID: panel- + 50 + - + 8 + - + 12 at most.
function freshSessionId(repo, suffix) {
  const { slug, own } = idParts(repo, 50);
  const tail = String(suffix).replace(/[^A-Za-z0-9]/g, '').slice(0, 12) || 'new';
  if (!slug) return `panel-${own.slice(0, 20) || 'repo'}-${tail}`;
  return `panel-${slug}${own ? `-${own.slice(0, 8)}` : ''}-${tail}`;
}

const CONTENT_MAX = 8 * 1024;
const own = (o, ...keys) => Object.fromEntries(keys.filter((k) => o[k] !== undefined).map((k) => [k, o[k]]));
const finiteOwn = (o, ...keys) => Object.fromEntries(keys.filter((k) => Number.isFinite(o[k])).map((k) => [k, o[k]]));
// The text of a finished assistant turn (the page needs nothing else of it).
const turnText = (m) => (m && Array.isArray(m.content) ? m.content.filter((c) => c && c.type === 'text' && typeof c.text === 'string').map((c) => c.text).join('\n\n') : '');
// RP139: the reason of a compaction is one of this closed list (the page reads the context again when one ends); any other value is dropped.
const COMPACTION_REASONS = ['manual', 'threshold', 'overflow'];
const reasonOf = (r) => (COMPACTION_REASONS.includes(r.reason) ? { reason: r.reason } : {});
// Per type, the small fields the page uses. `message_start`, `message_end` and `agent_end` carry the whole system prompt (about 180 KB) and
// `agent_end` every message, so nothing is copied by default: what is not listed here never leaves the server.
const WHITELIST = {
  message_update: (r) => {
    const a = r.assistantMessageEvent && typeof r.assistantMessageEvent === 'object' ? r.assistantMessageEvent : null;
    if (!a) return {};
    const out = own(a, 'type', 'contentIndex');
    // Only the text blocks carry their words: the thinking and the tool-call deltas keep just their `type` and `contentIndex` (RP104: the page shows «thinking…» from the type), never their words, which can be private or huge.
    if (typeof a.type === 'string' && a.type.startsWith('text_')) {
      if (typeof a.delta === 'string') out.delta = a.delta;
      if (typeof a.content === 'string' && a.content.length <= CONTENT_MAX) out.content = a.content;
    }
    return { assistantMessageEvent: out };
  },
  turn_end: (r) => ({ ...own(r, 'stopReason'), text: turnText(r.message) }),
  agent_start: (r) => own(r, 'aborted'),
  agent_end: (r) => own(r, 'aborted'),
  agent_settled: (r) => own(r, 'aborted'),
  // RP105c: a retry that pi does on its own. Only numbers and the verdict travel; the error texts (`errorMessage`, `finalError`) can hold the raw body of an API answer.
  auto_retry_start: (r) => finiteOwn(r, 'attempt', 'maxAttempts', 'delayMs'),
  auto_retry_end: (r) => ({ ...finiteOwn(r, 'attempt'), ...(typeof r.success === 'boolean' ? { success: r.success } : {}) }),
  compaction_start: reasonOf,
  compaction_end: reasonOf,
  tool_execution_start: (r) => own(r, 'toolName', 'isError', 'durationMs'),
  tool_execution_end: (r) => own(r, 'toolName', 'isError', 'durationMs'),
};
const slim = (r) => {
  const rec = r && typeof r === 'object' && !Array.isArray(r) ? r : {};
  return { ...(rec.type === undefined ? {} : { type: rec.type }), ...(WHITELIST[rec.type] || (() => ({})))(rec) };
};

// What the host tells the page: the dialog id travels as `requestId` (the hub reserves `id` for the repo); a record is cut to its whitelist,
// and what is still huge after that is cut to its type.
// RP110b: what the page may know of the memory plugin of a session: ONE category of this closed list, never the text of its notice (it can hold the name of the project or an error message).
const MEMORY = ['ready', 'offline', 'disabled', 'error'];
// The text of the notice of the key `engram` -> a category, or null when it says nothing lasting: a step in progress (`· saving…`) or a text nobody knows. null never changes the
// category already known. The plugin writes `🧠 <project> · ready|offline|error|ambiguous project` and `🧠 memory disabled`; only those two shapes count, and only at the END of the text.
function memoryOf(text) {
  if (typeof text !== 'string') return null;
  const t = text.replace(/\s+/g, ' ').trim();
  if (t.replace(/^[^A-Za-z0-9]+/, '').toLowerCase() === 'memory disabled') return 'disabled';
  // RP123: after a call the plugin writes `✓ <result>` when it went well and `✗ <text>` when it failed: a recovery and an error (the failure first, because its text is free). `✓`, `✗` and the `·` before them are all it reads.
  if (/\u00b7 ?\u2717/.test(t)) return 'error';
  if (/\u00b7 ?\u2713/.test(t)) return 'ready';
  const m = /\u00b7 ?(ready|offline|error|ambiguous project)$/i.exec(t);
  if (!m) return null;
  return m[1].toLowerCase() === 'ready' ? 'ready' : m[1].toLowerCase() === 'offline' ? 'offline' : 'error';
}

// RP139: what the page may know of the context window of a session: three numbers, every one finite and not negative or null. Nothing else of the answer (no text, no other field) is kept.
// A window that is not a positive integer makes the whole answer unknown; `tokens` and `percent` are null right after a compaction and stay null (never 0).
const CONTEXT_NONE = { tokens: null, window: null, percent: null };
const nonNeg = (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null);
function contextOf(stats) {
  const u = stats && typeof stats === 'object' ? stats.contextUsage : null;
  if (!u || typeof u !== 'object' || Array.isArray(u) || !Number.isSafeInteger(u.contextWindow) || u.contextWindow <= 0) return { ...CONTEXT_NONE };
  const percent = nonNeg(u.percent);
  return { tokens: nonNeg(u.tokens), window: u.contextWindow, percent: percent === null ? null : Math.min(100, percent) };
}

// RP140: after a timeout, does the session still say it is compacting? Asked once with a short wait. Any doubt (no answer, a broken answer) reads as no, so the mark never stays on for a session that cannot say.
async function stillCompacting(entry) {
  try { const s = await entry.client.request('get_state', {}, { timeoutMs: 5000 }); return !!s && typeof s === 'object' && s.isCompacting === true; } catch { return false; }
}

function wire(e) {
  if (!e || typeof e !== 'object') return null;
  if (e.kind === 'status') return null; // a raw notice never goes to the page (the host turns it into `memory` first)
  if (e.kind === 'memory') return MEMORY.includes(e.memory) ? { kind: 'memory', memory: e.memory } : null;
  if (e.kind === 'dialog' || e.kind === 'dialog-closed') { const { id, ...rest } = e; return { ...rest, requestId: id }; }
  if (e.kind === 'event') {
    const record = slim(e.record);
    return { kind: 'event', record: JSON.stringify(record).length > EVENT_MAX ? { type: record.type, truncated: true } : record };
  }
  return e;
}

function createRpcHost({ resolve, repoOf, publish, createClient = createRpcClient, max = 6, adoptedOf = (id) => (loadConfig().sessions || {})[id], adopt = () => {}, env = process.env, contextMs = 10000, compactMs = 600000, suffix = () => crypto.randomBytes(3).toString('hex') }) {
  const live = new Map(); // repo id -> { client, sessionId, ready }

  const closedStatus = { state: 'closed', pendingDialogs: [], sessionId: null };
  // A pending dialog is named `requestId` here as in the SSE `dialog` event.
  const statusOf = (entry) => (entry && entry.client
    ? { state: entry.client.state(), pendingDialogs: entry.client.pendingDialogs().map(({ id, ...rest }) => ({ requestId: id, ...rest })), sessionId: entry.sessionId, ...(entry.memory ? { memory: entry.memory } : {}), ...(entry.compacting ? { compacting: true } : {}) }
    : closedStatus);
  const running = (id) => {
    const entry = live.get(id);
    if (!entry) throw new HttpError(409, 'The session is not started');
    return entry;
  };
  // A failed command is a fixed message: RpcError texts are fixed already, anything else is hidden.
  const ask = async (entry, type, fields) => {
    try { return await entry.client.request(type, fields); } catch (e) {
      if (e instanceof RpcError) throw new HttpError(409, e.message);
      throw new HttpError(500, 'The session failed');
    }
  };

  // closeAll bumps the epoch: a start that was waiting for the runtime when it ran must not create a client nobody owns (found by the independent verification).
  let epoch = 0;
  async function launch(id, repo, entry) {
    const at = epoch;
    let found;
    try { found = await resolve(); } catch { found = null; }
    if (at !== epoch) throw new HttpError(503, 'The panel is closing');
    if (entry.closed) throw new HttpError(409, SESSION_CLOSED); // RP98: closed while the host waited for the runtime: no client is created for it
    if (!found || !found.active) throw new HttpError(409, 'No pi runtime is available');
    entry.sessionId = entry.fresh ? freshSessionId(repo, suffix()) : sessionIdFor(repo, adoptedOf(id));
    entry.client = createClient({
      command: found.active.command,
      args: ['--mode', 'rpc', '--session-id', entry.sessionId],
      cwd: repo.path,
      env: runtimeEnv(found.active, env),
      onEvent: (e) => {
        // RP140: the compaction mark follows the events of THIS session, so one that pi starts by itself (threshold, overflow) shows too.
        if (e && e.kind === 'event' && e.record && live.get(id) === entry && (e.record.type === 'compaction_start' || e.record.type === 'compaction_end')) entry.compacting = e.record.type === 'compaction_start';
        if (e && e.kind === 'status') { // RP110b: only the notice of THIS session counts (an old client's is not the new one's), and only a change of category is published
          const cat = e.key === 'engram' && live.get(id) === entry ? memoryOf(e.text) : null;
          if (cat && cat !== entry.memory) { entry.memory = cat; publish(id, { kind: 'memory', memory: cat }); }
          return;
        }
        const w = wire(e);
        if (w) publish(id, w);
      },
      // RP98: the exit of an OLD client (closed, replaced by a new start) is not the new session's: it is published only while this entry is the live one or none is.
      onExit: () => { const cur = live.get(id); if (cur === entry) live.delete(id); if (cur === entry || !cur) publish(id, { kind: 'exit' }); },
    });
    try { await entry.client.start(); entry.up = true; } catch (e) {
      if (entry.closed) throw new HttpError(409, SESSION_CLOSED); // closed while starting: not a failure to launch
      // Fixed messages only: a start that ran out of time is not a failure to launch, and the raw error never reaches the page.
      throw e && e.message === 'The session did not start in time' ? new HttpError(504, 'The session did not start in time') : new HttpError(502, 'The session could not be started');
    }
    if (entry.closed) throw new HttpError(409, SESSION_CLOSED); // the client answered but the session was closed meanwhile
  }

  // RP99: `fresh` starts a NEW session with its own id. It is only for a repo with no session: a live one or an adopted one (live or not) is 409, and nothing is created.
  async function start(id, { fresh = false } = {}) {
    const repo = repoOf(id); // unknown repo: 404 before anything starts
    const current = live.get(id);
    if (fresh && (current || adoptedOf(id))) throw new HttpError(409, 'This repo already has a session: close it first');
    if (current) { await current.ready; if (current.closed) throw new HttpError(409, SESSION_CLOSED); return statusOf(live.get(id)); } // RP98: a joiner of a session that was closed meanwhile fails like the others
    if (live.size >= max) throw new HttpError(409, `Too many live sessions (at most ${max})`);
    const entry = { client: null, sessionId: null, ready: null, fresh };
    live.set(id, entry);
    entry.ready = launch(id, repo, entry).catch((e) => {
      if (live.get(id) === entry) live.delete(id);
      if (entry.client) entry.client.close();
      throw e;
    });
    await entry.ready;
    if (entry.closed) throw new HttpError(409, SESSION_CLOSED); // RP98: a session that was closed is never adopted, so the chat does not come back to it
    // The session id it used becomes the adopted one when the repo has none (the history is read from the adopted id); never fails the start.
    try { adopt(id, entry.sessionId); } catch { /* the chat shows no history until a session is adopted */ }
    return statusOf(live.get(id));
  }

  // RP98: closes the session of ONE repo: the slot is free at once, the process is stopped (also one that is still starting: its start then fails with 409 and adopts nothing) and the
  // answer is the closed status. A repo with no live session answers closed too; an unknown repo is 404.
  async function close(id) {
    repoOf(id);
    const entry = live.get(id);
    if (!entry) return { ...closedStatus };
    live.delete(id);
    entry.closed = true;
    if (entry.client) entry.client.close();
    return { ...closedStatus };
  }

  // RPC2b-1: the state of a repo's session, synchronous and total: it reads memory only, never starts anything and never calls `repoOf`.
  // No live entry (also an id nobody knows) is closed; an entry that has not finished starting is starting; anything the client says outside the five is closed.
  function stateOf(id) {
    try {
      const entry = live.get(id);
      if (!entry) return 'closed';
      if (!entry.up) return 'starting';
      const state = entry.client.state();
      return STATES.includes(state) ? state : 'closed';
    } catch { return 'closed'; }
  }

  return {
    start,
    close,
    stateOf,
    async prompt(id, value, { behavior } = {}) {
      repoOf(id);
      if (behavior !== undefined && !BEHAVIORS.includes(behavior)) throw new HttpError(400, 'behavior must be steer or followUp');
      const message = cleanText(value);
      const entry = running(id);
      if (entry.compacting) throw new HttpError(409, 'The session is compacting its context: wait a moment'); // pi would refuse it too
      return ask(entry, 'prompt', { message, ...(behavior ? { streamingBehavior: behavior } : {}) });
    },
    async steer(id, value) {
      repoOf(id);
      const message = cleanText(value);
      return ask(running(id), 'steer', { message });
    },
    async abort(id) { repoOf(id); return ask(running(id), 'abort', {}); },
    async answer(id, requestId, answer) {
      repoOf(id);
      const { client } = running(id);
      if (!client.answerDialog(requestId, answer)) {
        // Still pending after a refusal: the SHAPE was wrong (nothing was written); otherwise the question is gone.
        if (client.pendingDialogs().some((d) => d.id === requestId)) throw new HttpError(400, 'Invalid answer');
        throw new HttpError(409, 'That question is not waiting for an answer');
      }
      return { ok: true };
    },
    // RP118: what the line for a normal terminal needs: the folder, the launcher of the active runtime and the id of the session the panel would use (a live session's own id, else the adopted
    // one, else the default). It only reads: nothing is started, adopted or written.
    async terminalInfo(id) {
      const repo = repoOf(id);
      let found;
      try { found = await resolve(); } catch { found = null; }
      if (!found || !found.active) throw new HttpError(409, 'No pi runtime is available');
      const entry = live.get(id);
      return { cwd: repo.path, launcher: found.active.command, sessionId: entry && entry.sessionId ? entry.sessionId : sessionIdFor(repo, adoptedOf(id)) };
    },
    // RP139: read-only. Any failure of the session (refused, no answer in time, a broken answer) is the unknown answer, never its text.
    async context(id) {
      repoOf(id);
      const entry = running(id);
      try { return contextOf(await entry.client.request('get_session_stats', {}, { timeoutMs: contextMs })); } catch { return { ...CONTEXT_NONE }; }
    },
    // RP140 (S28): compacts the context by hand. The server alone decides: only a running idle session gets `compact` (a busy one only with force === true, because pi aborts the turn in progress first; asking,
    // starting and closed get nothing). `manual` closes the window of two simultaneous calls: the check and the mark are one synchronous step. No text of the page or of the session goes in or out.
    async compact(id, { force = false } = {}) {
      repoOf(id);
      const entry = running(id);
      const state = stateOf(id);
      if (entry.compacting || entry.manual) throw new HttpError(409, 'The session is already compacting its context');
      if (state === 'asking') throw new HttpError(409, 'A question is waiting for your answer: answer it before compacting');
      if (state === 'starting') throw new HttpError(409, 'The session is still starting');
      if (state === 'busy' && force !== true) throw new HttpError(409, 'The session is answering: compacting stops that answer first');
      if (state !== 'idle' && state !== 'busy') throw new HttpError(409, 'The session is not started');
      entry.manual = true;
      entry.compacting = true;
      let keep = false; // a timeout is not an end: while the session still reports compacting the mark stays (its end event clears it) and a second compact is refused
      try {
        await entry.client.request('compact', {}, { timeoutMs: compactMs });
        return { compacted: true };
      } catch (e) {
        const why = e instanceof RpcError && typeof e.reason === 'string' ? e.reason : '';
        if (why.startsWith('Already compacted')) throw new HttpError(409, 'The context is already compacted');
        if (why.startsWith('Nothing to compact')) throw new HttpError(409, 'There is nothing to compact yet: the session is too small');
        if (e instanceof RpcError && e.message === 'The agent did not answer in time') { keep = await stillCompacting(entry); throw new HttpError(504, 'The compaction did not finish in time'); }
        throw new HttpError(502, 'The compaction failed');
      } finally {
        entry.manual = false;
        // No end event arrived (it timed out or failed): the mark goes and the page is told with the event it already reads.
        if (entry.compacting && !keep) { entry.compacting = false; if (live.get(id) === entry) publish(id, { kind: 'event', record: { type: 'compaction_end', reason: 'manual' } }); }
      }
    },
    async status(id) { repoOf(id); return statusOf(live.get(id)); },
    closeAll() {
      epoch++;
      for (const entry of [...live.values()]) if (entry.client) entry.client.close();
      live.clear();
    },
  };
}

// The routes' side: validates a body and calls the host. Only the fields below are read, so anything else (`command`, `cwd`, `path`,
// `args`...) is ignored by construction. Messages are fixed and never echo what was sent.
const bodyOf = (b) => { if (!b || typeof b !== 'object' || Array.isArray(b)) throw new HttpError(400, 'Invalid request'); return b; };
const idOf = (b) => { if (typeof b.id !== 'string' || !b.id || b.id.length > 100) throw new HttpError(400, 'Invalid request'); return b.id; };

const ANSWER_KEYS = new Set(['id', 'requestId', 'value', 'confirmed', 'cancelled']);
function answerOf(b) {
  if (Object.keys(b).some((k) => !ANSWER_KEYS.has(k))) throw new HttpError(400, 'Invalid answer');
  const given = ['value', 'confirmed', 'cancelled'].filter((k) => b[k] !== undefined);
  if (given.length !== 1) throw new HttpError(400, 'Send exactly one of value, confirmed or cancelled');
  if (given[0] === 'value') {
    if (typeof b.value !== 'string' || b.value.length > ANSWER_MAX || /[\x00-\x08\x0b-\x1f\x7f-\x9f]/.test(b.value)) throw new HttpError(400, 'Invalid answer');
    return { value: b.value };
  }
  if (given[0] === 'confirmed') {
    if (typeof b.confirmed !== 'boolean') throw new HttpError(400, 'Invalid answer');
    return { confirmed: b.confirmed };
  }
  if (b.cancelled !== true) throw new HttpError(400, 'Invalid answer');
  return { cancelled: true };
}

function rpcApi(host) {
  return {
    start: (b) => {
      const body = bodyOf(b);
      const id = idOf(body);
      if (body.new !== undefined && body.new !== true) throw new HttpError(400, 'Invalid request'); // RP99: `new` is true or absent
      return host.start(id, { fresh: body.new === true });
    },
    close: (b) => host.close(idOf(bodyOf(b))),
    prompt: (b) => host.prompt(idOf(bodyOf(b)), b.text, b.behavior === undefined ? {} : { behavior: b.behavior }),
    steer: (b) => host.steer(idOf(bodyOf(b)), b.text),
    abort: (b) => host.abort(idOf(bodyOf(b))),
    dialog: (b) => {
      const id = idOf(bodyOf(b));
      if (typeof b.requestId !== 'string' || !b.requestId || b.requestId.length > 200) throw new HttpError(400, 'Invalid request');
      return host.answer(id, b.requestId, answerOf(b));
    },
    status: (q) => host.status(idOf(bodyOf(q))),
    context: (q) => host.context(idOf(bodyOf(q))),
    // RP140: `force` is a strict boolean; nothing else of the body is read (no instructions for the compaction come from the page).
    compact: (b) => host.compact(idOf(bodyOf(b)), { force: b.force === true }),
  };
}

module.exports = { createRpcHost, rpcApi, cleanText, sessionIdFor, memoryOf, MEMORY };
