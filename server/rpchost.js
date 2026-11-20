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
const { createRpcClient, RpcError, CAUSES } = require('./rpc.js');
const lib = require('../lib.js');

// RP233: the names of the commands pi loaded (get_commands), or null when the answer is not a list. Only string names count.
function commandNames(data) {
  const list = data && typeof data === 'object' ? data.commands : null;
  return Array.isArray(list) ? list.filter((c) => c && typeof c === 'object' && typeof c.name === 'string').map((c) => c.name) : null;
}
// The /flow-* keys whose command is not among `names`.
const missingOf = (names) => Object.keys(lib.PI_COMMANDS).filter((key) => !names.includes(lib.piCommandName(key)));

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
  if (clean.startsWith('!')) throw new HttpError(400, 'Messages that start with ! run a shell command: send them from the chat box'); // RP245b: they go to bash(), never to prompt
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
// RP139: the reason of a compaction is one of this closed list (the page reads the context again when one ends); any other value is dropped.
const COMPACTION_REASONS = ['manual', 'threshold', 'overflow'];
const reasonOf = (r) => (COMPACTION_REASONS.includes(r.reason) ? { reason: r.reason } : {});
// RP235: the page reads the panel's own names, never the ones of pi; this is the only place that knows both. `message_start`, `message_end` and `agent_end` carry the
// whole system prompt (about 180 KB) and `agent_end` every message, so nothing is copied by default: only the fields listed here leave the server.
const SUB_TOOL = 'subagent_run';
// One delta of the assistant message: its block (`index`), what the block is (`part`: text, thinking or other) and the step (`phase`). Only a text block carries its words;
// the thinking and the tool-call deltas never do (they can be private or huge; RP104: the page shows «thinking…» from the part alone).
function streamOf(r) {
  const a = r.assistantMessageEvent && typeof r.assistantMessageEvent === 'object' ? r.assistantMessageEvent : null;
  if (!a) return { type: 'stream' };
  const out = { type: 'stream', ...(Number.isInteger(a.contentIndex) ? { index: a.contentIndex } : {}) };
  const kind = typeof a.type === 'string' ? a.type : '';
  const phase = /_(start|delta|end)$/.exec(kind);
  if (kind.startsWith('text_')) {
    Object.assign(out, { part: 'text' }, phase ? { phase: phase[1] } : {});
    if (typeof a.delta === 'string') out.delta = a.delta;
    if (typeof a.content === 'string' && a.content.length <= CONTENT_MAX) out.content = a.content;
  } else if (phase && kind === `thinking_${phase[1]}`) Object.assign(out, { part: 'thinking', phase: phase[1] });
  else out.part = 'other';
  return out;
}
// RP236: the messages waiting for the session (the person's own texts): at most QUEUE_MAX per list, each cut to QUEUE_TEXT_MAX; anything that is not a text is dropped.
const QUEUE_MAX = 20;
const QUEUE_TEXT_MAX = 4000;
const texts = (list) => (Array.isArray(list) ? list.filter((t) => typeof t === 'string').slice(0, QUEUE_MAX).map((t) => t.slice(0, QUEUE_TEXT_MAX)) : []);
const queueOf = (r) => ({ steering: texts(r && r.steering), followUp: texts(r && r.followUp) });
// RP236b (B1): what clear_queue gives back goes into the box, and pi has already dropped it: every text, whole. Only what is not a text is left out.
const allTexts = (list) => (Array.isArray(list) ? list.filter((t) => typeof t === 'string') : []);
const clearedOf = (r) => ({ steering: allTexts(r && r.steering), followUp: allTexts(r && r.followUp) });
// RP236b (B2): pi runs an extension command sent by prompt at once, even during a run; while the session works a command waits for it to be free.
const COMMAND_WAITS = 'Commands wait until the session is free: send it when the run ends';
// RP245b: a shell command (! or !!) waits for a free session too; it may run long, so it waits longer than an ordinary request.
const SHELL_WAITS = 'Shell commands wait until the session is free: send it when the run ends';
const SHELL_MAX = TEXT_MAX;
const SHELL_MS = 30 * 60 * 1000;
// The abort sent after that wait is short, so the 409 reaches the page (which waits one minute more) even when pi does not answer it.
const SHELL_ABORT_MS = 15000;
// RP239: how long Stop waits for abort_retry before it sends the abort anyway.
const RETRY_ABORT_MS = 5000;
// RP252: how much of the output of the running command the status keeps (its end).
const SHELL_KEEP = 200000;
// RP237 (option (a), decided by the person): with GENTLE_SHELL_INTERACTIVE_HOST=1 these commands can change the runtime's permission mode (even super-yolo, saved for new
// sessions) and its configuration, and the panel would not show it. They stay in the terminal: refused here whatever the way the text comes in.
// pi names a command registered twice `name:1`, `name:2`: those forms are the same command.
const PANEL_BLOCKED = /^\/gentle:(desktop|mode|yolo)(?::\d+)?(?![\w:-])/i;
const NOT_HERE = 'Permission and configuration commands (/gentle:desktop, /gentle:mode, /gentle:yolo) are not available from the panel: use the terminal';
const panelOnly = (message) => { if (PANEL_BLOCKED.test(message)) throw new HttpError(409, NOT_HERE); return message; };
const TRANSLATE = {
  queue_update: (r) => ({ type: 'queue', ...queueOf(r) }),
  // RP245b: one chunk of the output of a shell command the person ran with ! or !! (only one runs at a time per session).
  bash_execution_update: (r) => ({ type: 'bash_output', ...(typeof r.delta === 'string' ? { delta: r.delta } : {}) }),
  agent_start: () => ({ type: 'run_start' }),
  agent_end: () => ({ type: 'run_end' }),
  agent_settled: () => ({ type: 'run_settled' }),
  message_start: () => ({ type: 'stream', part: 'reset' }),
  message_update: streamOf,
  // RP105c: a retry that pi does on its own. Only numbers and the verdict travel; the error texts (`errorMessage`, `finalError`) can hold the raw body of an API answer.
  auto_retry_start: (r) => { const n = finiteOwn(r, 'attempt', 'maxAttempts', 'delayMs'); return { type: 'retry_start', ...own(n, 'attempt'), ...(n.maxAttempts === undefined ? {} : { max: n.maxAttempts }), ...own(n, 'delayMs') }; },
  auto_retry_end: (r) => ({ type: 'retry_end', ...finiteOwn(r, 'attempt'), ...(typeof r.success === 'boolean' ? { success: r.success } : {}) }),
  compaction_start: (r) => ({ type: 'compact_start', ...reasonOf(r) }),
  compaction_end: (r) => ({ type: 'compact_end', ...reasonOf(r) }),
  // RP152: a subagent is told apart from the other tools here, so the page never needs the name of the tool of pi; only the name of a tool travels, never its arguments or result.
  tool_execution_start: (r) => (r.toolName === SUB_TOOL ? { type: 'subagent_start' } : { type: 'tool_start', ...(typeof r.toolName === 'string' ? { name: r.toolName } : {}) }),
  tool_execution_end: (r) => (r.toolName === SUB_TOOL ? { type: 'subagent_end' } : { type: 'tool_end', ...(typeof r.toolName === 'string' ? { name: r.toolName } : {}) }),
};
// Any other event (a turn end, a queue update, a tool update…) still reaches the page as `other`, with nothing of it: the page redraws on every frame as before.
const toPanel = (r) => {
  const rec = r && typeof r === 'object' && !Array.isArray(r) ? r : {};
  return Object.hasOwn(TRANSLATE, rec.type) ? TRANSLATE[rec.type](rec) : { type: 'other' };
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

// RP245c: what the page may know of the permission mode of a session: ONE category of this closed list. Gentle Shell writes `Permissions: <MODE>` in its notice `gentle:mode`
// (at the start of the session and on every change); any other text is null and never changes what is known.
const MODES = ['normal', 'auto', 'yolo', 'super-yolo'];
function modeOf(text) {
  if (typeof text !== 'string') return null;
  const m = /^permissions: (normal|auto|yolo|super-yolo)$/i.exec(text.replace(/\s+/g, ' ').trim());
  return m ? m[1].toLowerCase() : null;
}

// RP139: what the page may know of the context window of a session: three numbers, every one finite and not negative or null. Nothing else of the answer (no text, no other field) is kept.
// A window that is not a positive integer makes those three unknown; `tokens` and `percent` are null right after a compaction and stay null (never 0).
// RP239: plus the totals of the session: its cost (finite, 0 to COST_MAX) and its tokens (`tokens.total`, a safe integer); either is null when it is anything else.
const CONTEXT_NONE = { tokens: null, window: null, percent: null, cost: null, sessionTokens: null };
const COST_MAX = 1e6;
const nonNeg = (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null);
function contextOf(stats) {
  const s = stats && typeof stats === 'object' ? stats : {};
  const total = s.tokens && typeof s.tokens === 'object' ? s.tokens.total : null;
  const totals = { cost: nonNeg(s.cost) !== null && s.cost <= COST_MAX ? s.cost : null, sessionTokens: Number.isSafeInteger(total) && total >= 0 ? total : null };
  const u = s.contextUsage;
  if (!u || typeof u !== 'object' || Array.isArray(u) || !Number.isSafeInteger(u.contextWindow) || u.contextWindow <= 0) return { ...CONTEXT_NONE, ...totals };
  const percent = nonNeg(u.percent);
  return { tokens: nonNeg(u.tokens), window: u.contextWindow, percent: percent === null ? null : Math.min(100, percent), ...totals };
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
    const record = toPanel(e.record);
    return { kind: 'event', record: JSON.stringify(record).length > EVENT_MAX ? { type: record.type, truncated: true } : record };
  }
  return e;
}

function createRpcHost({ resolve, repoOf, publish, createClient = createRpcClient, max = 6, adoptedOf = (id) => (loadConfig().sessions || {})[id], adopt = () => {}, env = process.env, contextMs = 10000, commandsMs = 5000, compactMs = 600000, suffix = () => crypto.randomBytes(3).toString('hex') }) {
  const live = new Map(); // repo id -> { client, sessionId, ready }
  // RP238: repo id -> a promise that resolves once every pi of its closed sessions is gone (exited, or killed after the grace). A new start of the repo waits for it,
  // so two pi never write the same session file.
  const closing = new Map();
  function track(id, gone) {
    const all = Promise.all([closing.get(id), gone]).then(() => {}, () => {});
    closing.set(id, all);
    all.then(() => { if (closing.get(id) === all) closing.delete(id); });
  }
  const stop = (id, entry) => { if (entry.client) track(id, entry.client.close()); };

  const closedStatus = { state: 'closed', pendingDialogs: [], sessionId: null };
  // A pending dialog is named `requestId` here as in the SSE `dialog` event.
  const statusOf = (entry) => (entry && entry.client
    ? { state: entry.client.state(), pendingDialogs: entry.client.pendingDialogs().map(({ id, ...rest }) => ({ requestId: id, ...rest })), sessionId: entry.sessionId, ...(entry.memory ? { memory: entry.memory } : {}), ...(entry.mode ? { mode: entry.mode } : {}), ...(entry.compacting ? { compacting: true } : {}), ...(entry.bash ? { bash: { ...entry.bash, running: true } } : {}), ...(entry.commands ? { missing: missingOf(entry.commands) } : {}) }
    : closedStatus);
  const running = (id) => {
    const entry = live.get(id);
    if (!entry) throw new HttpError(409, 'The session is not started');
    return entry;
  };
  // A failed command is a fixed message: RpcError texts are fixed already, anything else is hidden.
  const ask = async (entry, type, fields, opts) => {
    try { return await entry.client.request(type, fields, ...(opts ? [opts] : [])); } catch (e) {
      if (e instanceof RpcError) throw new HttpError(409, e.message);
      throw new HttpError(500, 'The session failed');
    }
  };
  const askLong = (entry, type, fields) => ask(entry, type, fields, { timeoutMs: SHELL_MS });

  // closeAll bumps the epoch: a start that was waiting for the runtime when it ran must not create a client nobody owns (found by the independent verification).
  let epoch = 0;
  let final = false; // RP238: the panel is shutting down: no start is taken any more, so no pi outlives the wait of the shutdown
  async function launch(id, repo, entry) {
    const at = epoch;
    let found;
    try { found = await resolve(); } catch { found = null; }
    while (closing.has(id) && at === epoch && !entry.closed) await closing.get(id); // RP238: the previous pi of this repo is still closing
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
        // RP239: pi is waiting to retry a failed request; Stop then cuts that wait too.
        if (e && e.kind === 'event' && e.record && ['auto_retry_start', 'auto_retry_end', 'agent_settled'].includes(e.record.type)) entry.retrying = e.record.type === 'auto_retry_start';
        // RP252: the output of the running shell command is kept too (its end), so a reload or another tab shows it from the status.
        if (e && e.kind === 'event' && e.record && e.record.type === 'bash_execution_update' && entry.bash && typeof e.record.delta === 'string') entry.bash.output = (entry.bash.output + e.record.delta).slice(-SHELL_KEEP);
        if (e && e.kind === 'status') { // RP110b: only the notice of THIS session counts (an old client's is not the new one's), and only a change of category is published
          const cat = e.key === 'engram' && live.get(id) === entry ? memoryOf(e.text) : null;
          if (cat && cat !== entry.memory) { entry.memory = cat; publish(id, { kind: 'memory', memory: cat }); }
          const mode = e.key === 'gentle:mode' && live.get(id) === entry ? modeOf(e.text) : null; // RP245c
          if (mode && mode !== entry.mode) { entry.mode = mode; publish(id, { kind: 'mode', mode }); }
          return;
        }
        const w = wire(e);
        if (w) publish(id, w);
      },
      // RP98: the exit of an OLD client (closed, replaced by a new start) is not the new session's: it is published only while this entry is the live one or none is.
      onExit: (info) => {
        const cur = live.get(id); if (cur === entry) live.delete(id); if (cur === entry || !cur) publish(id, { kind: 'exit' }); stop(id, entry); // RP238: a pi that ended any way may still be closing
        // RP238b: a session that was up and died by itself then says why, with its category only; not when a new session of the repo started meanwhile.
        if (entry.up && info && info.reason === 'exit' && typeof entry.client.cause === 'function') entry.client.cause().then((c) => { if (Object.hasOwn(CAUSES, c || '') && !live.has(id)) publish(id, { kind: 'ended', cause: c }); }, () => {});
      },
    });
    try { await entry.client.start(); entry.up = true; entry.upAt = Date.now(); } catch (e) { // RP161: when the panel started this session (the jobs of an older process are gone)
      if (entry.closed) throw new HttpError(409, SESSION_CLOSED); // closed while starting: not a failure to launch
      // Fixed messages only: a start that ran out of time is not a failure to launch, and the raw error never reaches the page.
      if (e && e.message === 'The session did not start in time') throw new HttpError(504, 'The session did not start in time');
      let c = null;
      try { c = typeof entry.client.cause === 'function' ? await entry.client.cause() : null; } catch { /* no cause */ }
      throw new HttpError(502, Object.hasOwn(CAUSES, c || '') ? `The session could not be started: ${CAUSES[c]}` : 'The session could not be started'); // RP238b: the cause by its fixed text only
    }
    if (entry.closed) throw new HttpError(409, SESSION_CLOSED); // the client answered but the session was closed meanwhile
    entry.commands = await loadCommands(entry);
  }

  // RP233: asked once per start; a failure, a malformed answer or no answer within commandsMs leaves the list unknown (null), which blocks nothing.
  async function loadCommands(entry) {
    let timer;
    const late = new Promise((resolve) => { timer = setTimeout(() => resolve(null), commandsMs); });
    try { return await Promise.race([Promise.resolve().then(() => entry.client.request('get_commands', {})).then(commandNames, () => null), late]); } finally { clearTimeout(timer); }
  }

  // RP99: `fresh` starts a NEW session with its own id. It is only for a repo with no session: a live one or an adopted one (live or not) is 409, and nothing is created.
  async function start(id, { fresh = false } = {}) {
    const repo = repoOf(id); // unknown repo: 404 before anything starts
    if (final) throw new HttpError(503, 'The panel is shutting down');
    const current = live.get(id);
    if (fresh && (current || adoptedOf(id))) throw new HttpError(409, 'This repo already has a session: close it first');
    if (current) { await current.ready; if (current.closed) throw new HttpError(409, SESSION_CLOSED); return statusOf(live.get(id)); } // RP98: a joiner of a session that was closed meanwhile fails like the others
    if (live.size >= max) throw new HttpError(409, `Too many live sessions (at most ${max})`);
    const entry = { client: null, sessionId: null, ready: null, fresh };
    live.set(id, entry);
    entry.ready = launch(id, repo, entry).catch((e) => {
      if (live.get(id) === entry) live.delete(id);
      stop(id, entry);
      throw e;
    });
    await entry.ready;
    if (entry.closed) throw new HttpError(409, SESSION_CLOSED); // RP98: a session that was closed is never adopted, so the chat does not come back to it
    // The session id it used becomes the adopted one when the repo has none (the history is read from the adopted id); never fails the start.
    try { adopt(id, entry.sessionId); } catch { /* the chat shows no history until a session is adopted */ }
    return statusOf(live.get(id));
  }

  // RP98: closes the session of ONE repo: the slot is free at once, the process is stopped (also one that is still starting: its start then fails with 409 and adopts nothing) and the
  // answer is the closed status. A repo with no live session answers closed too; an unknown repo is 404. RP238: the answer does not wait for pi to exit; the next start of the repo does.
  async function close(id) {
    repoOf(id);
    const entry = live.get(id);
    if (!entry) return { ...closedStatus };
    live.delete(id);
    entry.closed = true;
    stop(id, entry);
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

  // RP161: when (ms) the panel finished starting the live session of a repo, or null (no live session, still starting, closed). Memory only, total.
  function startedAtOf(id) {
    try {
      const entry = live.get(id);
      return entry && entry.up === true && !entry.closed && Number.isFinite(entry.upAt) ? entry.upAt : null;
    } catch { return null; }
  }

  // RP228: how the last task of a repo's live session ended, { kind: 'done' | 'failed' | 'stopped', at }, or null. Memory only, total: no live entry, still starting, closed, a client with none or a malformed value are null.
  function outcomeOf(id) {
    try {
      const entry = live.get(id);
      if (!entry || entry.up !== true || entry.closed || typeof entry.client.outcome !== 'function') return null;
      const o = entry.client.outcome();
      return o && typeof o === 'object' && typeof o.kind === 'string' && Number.isFinite(o.at) ? { kind: o.kind, at: o.at } : null;
    } catch { return null; }
  }

  return {
    start,
    close,
    stateOf,
    startedAtOf,
    outcomeOf,
    // RP233: the command names the live session of a repo loaded, or null (no live session, still starting, or the list is unknown). Memory only.
    commandsOf(id) { const entry = live.get(id); return entry && entry.up === true && !entry.closed && Array.isArray(entry.commands) ? [...entry.commands] : null; },
    async prompt(id, value, { behavior } = {}) {
      repoOf(id);
      if (behavior !== undefined && !BEHAVIORS.includes(behavior)) throw new HttpError(400, 'behavior must be steer or followUp');
      const message = panelOnly(cleanText(value));
      if (behavior && message.startsWith('/')) throw new HttpError(409, COMMAND_WAITS);
      const entry = running(id);
      if (entry.compacting) throw new HttpError(409, 'The session is compacting its context: wait a moment'); // pi would refuse it too
      return ask(entry, 'prompt', { message, ...(behavior ? { streamingBehavior: behavior } : {}) });
    },
    async steer(id, value) {
      repoOf(id);
      const message = panelOnly(cleanText(value));
      return ask(running(id), 'steer', { message });
    },
    // RP239: during an automatic retry pi's abort_retry goes first (pi's abort cuts it too, but this ends the wait at once); its failure never stops the abort.
    async abort(id) {
      repoOf(id);
      const entry = running(id);
      if (entry.retrying) { try { await entry.client.request('abort_retry', {}, { timeoutMs: RETRY_ABORT_MS }); } catch { /* the abort below cuts it as well */ } }
      return ask(entry, 'abort', {});
    },
    // RP245b (parity with the terminal): `!command` runs it in the folder of the session with pi's bash order and its output goes to the conversation; `!!command`
    // keeps the output from the model (excludeFromContext). It waits for a free session, like a command with /, and only one runs at a time.
    async bash(id, value) {
      repoOf(id);
      const text = typeof value === 'string' ? value.replace(/\r\n?/g, '\n').trim() : value;
      if (typeof text !== 'string') throw new HttpError(400, 'The text must be a string');
      const m = /^(!!?)([\s\S]*)$/.exec(text);
      if (!m) throw new HttpError(400, 'A shell command starts with ! or !!');
      const command = m[2].trim();
      if (!command) throw new HttpError(400, 'Write a command after ! or !!');
      if (command.length > SHELL_MAX) throw new HttpError(400, `The command is longer than ${SHELL_MAX} characters`);
      const entry = running(id);
      if (entry.compacting) throw new HttpError(409, 'The session is compacting its context: wait a moment');
      if (entry.bashing) throw new HttpError(409, 'A shell command is already running in this session');
      if (!entry.up || entry.client.state() !== 'idle') throw new HttpError(409, SHELL_WAITS);
      entry.bashing = true;
      // RP252: the running command is in the status and every tab hears its start and its end (its finished run is then read from the session file).
      entry.bash = { command, exclude: m[1] === '!!', output: '', since: Date.now() };
      publish(id, { kind: 'event', record: { type: 'bash_start', command, exclude: entry.bash.exclude, since: entry.bash.since } });
      try { return await askLong(entry, 'bash', { command, excludeFromContext: m[1] === '!!' }); } catch (e) {
        // Past the wait the panel stops waiting; it also stops the command in pi, so a later one never runs alongside it.
        if (e instanceof HttpError && e.message === 'The agent did not answer in time') {
          try { await entry.client.request('abort_bash', {}, { timeoutMs: SHELL_ABORT_MS }); } catch { /* the session may be gone */ }
          throw new HttpError(409, 'The shell command ran longer than 30 minutes and was stopped');
        }
        throw e;
      } finally {
        entry.bashing = false;
        entry.bash = null;
        if (live.get(id) === entry) publish(id, { kind: 'event', record: { type: 'bash_end' } });
      }
    },
    // RP245b: Stop of a running shell command (pi's abort_bash; its answer then says cancelled).
    async abortBash(id) { repoOf(id); await ask(running(id), 'abort_bash', {}); return { ok: true }; },
    // RP236: takes the queued messages back (pi answers their texts, which the page puts back in the box).
    async clearQueue(id) { repoOf(id); return clearedOf(await ask(running(id), 'clear_queue', {})); },
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
        if (entry.compacting && !keep) { entry.compacting = false; if (live.get(id) === entry) publish(id, { kind: 'event', record: { type: 'compact_end', reason: 'manual' } }); }
      }
    },
    async status(id) { repoOf(id); return statusOf(live.get(id)); },
    // RP238: resolves once every pi is gone (each one exits by itself or is killed after its grace, all in parallel), also the ones closed just before.
    // `final` (the shutdown of the panel) refuses every later start with 503.
    closeAll({ final: last = false } = {}) {
      if (last) final = true;
      epoch++;
      for (const [id, entry] of [...live]) stop(id, entry);
      live.clear();
      return Promise.all([...closing.values()]).then(() => {});
    },
  };
}

// RP238: the handler of the stop signals of the panel: it closes every session the orderly way and exits once they are all gone; a second signal meanwhile changes nothing.
function shutdown(host, exit = process.exit) {
  let once = null;
  return () => {
    if (!once) once = Promise.resolve().then(() => host.closeAll({ final: true })).then(() => exit(0), () => exit(0));
    return once;
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
    clearQueue: (b) => host.clearQueue(idOf(bodyOf(b))),
    bash: (b) => host.bash(idOf(bodyOf(b)), b.text),
    abortBash: (b) => host.abortBash(idOf(bodyOf(b))),
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

module.exports = { createRpcHost, shutdown, rpcApi, cleanText, sessionIdFor, memoryOf, MEMORY, modeOf, MODES, toPanel };
