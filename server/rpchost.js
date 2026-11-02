'use strict';
// One pi session per repo, kept INSIDE the panel process (RPC1b, S1, S2): started on demand with `--mode rpc` in the repo's folder from
// config.json (never from a request) under the same `--session-id` every time, so a panel restart ends the sessions and they come back
// with that id. There is no separate daemon. The browser can only start, prompt, steer, abort and answer a pending dialog; it never names
// a program, a folder or an argument. Everything it sends is cleaned or refused with a fixed message that echoes nothing.
const path = require('node:path');
const { HttpError } = require('./errors.js');
const { loadConfig } = require('./config.js');
const { runtimeEnv } = require('./piruntime.js');
const { createRpcClient, RpcError } = require('./rpc.js');

const TEXT_MAX = 20000;
const ANSWER_MAX = 4000;
const EVENT_MAX = 256 * 1024;
const SESSION_ID = /^[A-Za-z0-9._-]{1,80}$/;
// Same set as server/chatsend.js: everything but LF and TAB (C0, DEL, C1, line separators, bidi and zero-width controls).
const CONTROLS = /[\x00-\x08\x0b-\x1f\x7f-\x9f\u2028\u2029\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g;
const BEHAVIORS = ['steer', 'followUp'];

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

// The adopted session of the repo (config.json `sessions`), else `panel-<slug>` like the sessions the panel names itself.
function sessionIdFor(repo, adopted) {
  if (adopted && typeof adopted.id === 'string' && SESSION_ID.test(adopted.id)) return adopted.id;
  // The last folder name with BOTH separators: `path.basename` only knows the ones of the platform, so a Windows path read on Linux would give the whole string.
  const slug = (String(repo.path).split(/[\\/]/).filter((s) => s && !/^[A-Za-z]:$/.test(s)).pop() || '').toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '').slice(0, 60);
  return `panel-${slug || String(repo.id).replace(/[^A-Za-z0-9]/g, '').slice(0, 20) || 'repo'}`;
}

// What the host tells the page: the dialog id travels as `requestId` (the hub reserves `id` for the repo), a huge record is cut to its type.
function wire(e) {
  if (!e || typeof e !== 'object') return null;
  if (e.kind === 'dialog' || e.kind === 'dialog-closed') { const { id, ...rest } = e; return { ...rest, requestId: id }; }
  if (e.kind === 'event' && JSON.stringify(e.record).length > EVENT_MAX) return { kind: 'event', record: { type: e.record.type, truncated: true } };
  return e;
}

function createRpcHost({ resolve, repoOf, publish, createClient = createRpcClient, max = 6, adoptedOf = (id) => (loadConfig().sessions || {})[id], env = process.env }) {
  const live = new Map(); // repo id -> { client, sessionId, ready }

  const closedStatus = { state: 'closed', pendingDialogs: [], sessionId: null };
  const statusOf = (entry) => (entry && entry.client ? { state: entry.client.state(), pendingDialogs: entry.client.pendingDialogs(), sessionId: entry.sessionId } : closedStatus);
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
    if (!found || !found.active) throw new HttpError(409, 'No pi runtime is available');
    entry.sessionId = sessionIdFor(repo, adoptedOf(id));
    entry.client = createClient({
      command: found.active.command,
      args: ['--mode', 'rpc', '--session-id', entry.sessionId],
      cwd: repo.path,
      env: runtimeEnv(found.active, env),
      onEvent: (e) => { const w = wire(e); if (w) publish(id, w); },
      onExit: () => { if (live.get(id) === entry) live.delete(id); publish(id, { kind: 'exit' }); },
    });
    try { await entry.client.start(); } catch { throw new HttpError(502, 'The session could not be started'); }
  }

  async function start(id) {
    const repo = repoOf(id); // unknown repo: 404 before anything starts
    const current = live.get(id);
    if (current) { await current.ready; return statusOf(live.get(id)); }
    if (live.size >= max) throw new HttpError(409, `Too many live sessions (at most ${max})`);
    const entry = { client: null, sessionId: null, ready: null };
    live.set(id, entry);
    entry.ready = launch(id, repo, entry).catch((e) => {
      if (live.get(id) === entry) live.delete(id);
      if (entry.client) entry.client.close();
      throw e;
    });
    await entry.ready;
    return statusOf(live.get(id));
  }

  return {
    start,
    async prompt(id, value, { behavior } = {}) {
      repoOf(id);
      if (behavior !== undefined && !BEHAVIORS.includes(behavior)) throw new HttpError(400, 'behavior must be steer or followUp');
      const message = cleanText(value);
      const entry = running(id);
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
      if (!running(id).client.answerDialog(requestId, answer)) throw new HttpError(409, 'That question is not waiting for an answer');
      return { ok: true };
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

function answerOf(b) {
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
    start: (b) => host.start(idOf(bodyOf(b))),
    prompt: (b) => host.prompt(idOf(bodyOf(b)), b.text, b.behavior === undefined ? {} : { behavior: b.behavior }),
    steer: (b) => host.steer(idOf(bodyOf(b)), b.text),
    abort: (b) => host.abort(idOf(bodyOf(b))),
    dialog: (b) => {
      const id = idOf(bodyOf(b));
      if (typeof b.requestId !== 'string' || !b.requestId || b.requestId.length > 200) throw new HttpError(400, 'Invalid request');
      return host.answer(id, b.requestId, answerOf(b));
    },
    status: (q) => host.status(idOf(bodyOf(q))),
  };
}

module.exports = { createRpcHost, rpcApi, cleanText, sessionIdFor };
