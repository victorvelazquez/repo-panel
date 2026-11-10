'use strict';
// The client of ONE `pi --mode rpc` child (RPC1b, S1, S2): JSON lines on stdin and stdout, records separated ONLY by LF (never readline,
// it also splits on U+2028/U+2029, which are legal inside a JSON string). It launches with the rules of server/piruntime.js (a validated
// command, a .cmd through the shell only on Windows, the tree killed as a whole). The start is slow and variable (5 to 25 s measured), so
// commands wait in a queue until `get_state` answers. Nothing from pi reaches a caller raw: errors are fixed messages, UI notices are
// dropped and dialogs are kept pending so only an answer to a real pending dialog can be sent. Spawn is injectable, tests use a fake.
const cp = require('node:child_process');
const fs = require('node:fs');
const { StringDecoder } = require('node:string_decoder');
const { commandProblem, launchSpec, killTree, makeWhich, isAbs } = require('./piruntime.js');

// Five minutes (RP101): the real pi took 4 s to over 60 s to start, with no pattern (measured through the panel, RPC2-1), and on one machine a New session ran past the old
// two-minute cap twice in a row (24 to 29 s measured here when pi has to look for the session id among a repo's sessions).
const START_MS = 300000;
const MAX_LINE = 8 * 1024 * 1024;
const MAX_WAITING = 200;
const MAX_DIALOGS = 20;
const STATUS_MAX = 200;
const DIALOGS = new Set(['select', 'confirm', 'input', 'editor']);
const SAFE_ARG = /^[A-Za-z0-9._-]+$/;
const FAILURES = { timeout: 'The session did not start in time', error: 'The session could not be started', exit: 'The session ended', closed: 'The session is closed' };

class RpcError extends Error { constructor(message) { super(message); this.name = 'RpcError'; } }
const fail = (message) => new RpcError(message);
const text = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '');
// What the page may see of a dialog (RPC2-3): the caps below; anything cut sets `truncated`, and the page then offers no way to approve it.
const TITLE_MAX = 300;
const MESSAGE_MAX = 4000;
const OPTIONS_MAX = 20;
const OPTION_MAX = 200;
const ANSWER_MAX = 4000;
// Everything but LF and TAB (C0, DEL, C1).
const CONTROLS = /[\x00-\x08\x0b-\x1f\x7f-\x9f]/;
const over = (v, max) => typeof v === 'string' && v.length > max;

// The body for the agent, or null: the shape must fit the METHOD of the dialog, with no extra key. A select value must be strictly one of
// the options the page was shown (never any other string); `d.sure` holds the options that were not cut.
function answerBody(d, a) {
  if (!a || typeof a !== 'object' || Array.isArray(a)) return null;
  const keys = Object.keys(a);
  if (keys.length !== 1) return null;
  if (keys[0] === 'cancelled') return a.cancelled === true ? { cancelled: true } : null;
  if (d.method === 'confirm') return keys[0] === 'confirmed' && typeof a.confirmed === 'boolean' ? { confirmed: a.confirmed } : null;
  if (keys[0] !== 'value' || typeof a.value !== 'string') return null;
  if (d.method === 'select') return d.sure.includes(a.value) ? { value: a.value } : null;
  return a.value.length <= ANSWER_MAX && !CONTROLS.test(a.value) ? { value: a.value } : null;
}

function createRpcClient({ command, args = [], cwd, env, spawn = cp.spawn, platform = process.platform, kill = process.kill, startTimeoutMs = START_MS, requestTimeoutMs = 120000, onEvent = () => {}, onExit = () => {} }) {
  const pending = new Map(); // id -> { type, resolve, reject, timer, ends }
  const queue = []; // commands issued before ready
  const outbox = []; // lines waiting for stdin to drain
  const dialogs = new Map(); // id -> dialog still waiting for an answer
  const decoder = new StringDecoder('utf8');
  let child = null;
  let started = false;
  let ready = false;
  let closed = false;
  let streaming = false;
  let refreshing = false;
  let again = false;
  let blocked = false;
  let skipping = false;
  let buf = '';
  let seq = 0;
  let ends = 0;
  let startTimer = null;
  let lastState = 'starting';
  const safe = (fn, arg) => { try { fn(arg); } catch { /* a listener must not break the client */ } };
  const emit = (e) => safe(onEvent, e);

  const state = () => (closed ? 'closed' : !ready ? 'starting' : dialogs.size ? 'asking' : streaming ? 'busy' : 'idle');
  function notify() {
    const s = state();
    if (s !== lastState) { lastState = s; emit({ kind: 'state', state: s }); }
  }

  // Honors backpressure: one write at a time while stdin says it is full.
  function flush() {
    while (outbox.length && !blocked && !closed) {
      let ok = true;
      try { ok = child.stdin.write(outbox.shift()) !== false; } catch { /* the exit handler reports it */ }
      if (!ok) { blocked = true; child.stdin.once('drain', () => { blocked = false; flush(); }); }
    }
  }
  function write(obj) {
    if (closed || !child) return;
    outbox.push(`${JSON.stringify(obj)}\n`);
    flush();
  }

  function send(type, fields, timeoutMs, internal) {
    if (closed) return Promise.reject(fail(FAILURES.closed));
    if (!started) return Promise.reject(fail('The session is not started'));
    if (outbox.length + queue.length >= MAX_WAITING) return Promise.reject(fail('Too many commands are waiting'));
    return new Promise((resolve, reject) => {
      const id = `c${++seq}`;
      const entry = { type, resolve, reject, timer: null, ends };
      if (Number.isFinite(timeoutMs)) {
        entry.timer = setTimeout(() => {
          pending.delete(id);
          const at = queue.findIndex((c) => c.id === id);
          if (at >= 0) queue.splice(at, 1);
          reject(fail('The agent did not answer in time'));
        }, timeoutMs);
      }
      pending.set(id, entry);
      const cmd = { ...fields, id, type }; // the client owns `id` and `type`
      if (ready || internal) write(cmd); else queue.push(cmd);
    });
  }

  // The agent's idea of "streaming" wins whenever a run ends.
  function refresh() {
    if (!ready || closed) return;
    if (refreshing) { again = true; return; }
    refreshing = true;
    send('get_state', {}, requestTimeoutMs, true)
      .then((d) => { streaming = !!(d && d.isStreaming); })
      .catch(() => {})
      .then(() => { refreshing = false; notify(); if (again) { again = false; refresh(); } });
  }

  function dropDialog(id, reason) {
    const d = dialogs.get(id);
    if (!d) return false;
    clearTimeout(d.timer);
    dialogs.delete(id);
    emit({ kind: 'dialog-closed', id, reason });
    notify();
    return true;
  }
  const publicDialog = (d) => ({ id: d.id, method: d.method, title: d.title, options: d.options, message: d.message, expiresAt: d.expiresAt, truncated: d.truncated });

  function onUi(rec) {
    // RP110b: of all the notices, only the status of the MEMORY plugin (the key `engram`) is kept, and only its tail: the plugin ends it with the part that tells the state (`· ready`, `· offline`), so a
    // long project name must not push that part out. It is not a dialog: it needs no answer and does not change the state. The host reduces it to a category; the text never goes further.
    if (rec.method === 'setStatus') {
      if (rec.statusKey === 'engram') emit({ kind: 'status', key: 'engram', text: typeof rec.statusText === 'string' ? rec.statusText.slice(-STATUS_MAX) : '' });
      return;
    }
    // The other notices (setWidget, notify...) need no answer and are dropped; only the four dialog methods block the agent.
    if (!DIALOGS.has(rec.method) || typeof rec.id !== 'string' || !rec.id || rec.id.length > 200) return;
    if (dialogs.has(rec.id) || dialogs.size >= MAX_DIALOGS) return;
    const wait = Number(rec.timeout) > 0 ? Math.min(Number(rec.timeout), 2147483647) : 0;
    const raw = Array.isArray(rec.options) ? rec.options.slice(0, OPTIONS_MAX) : [];
    const options = raw.map((o) => text(o, OPTION_MAX));
    const d = {
      id: rec.id, method: rec.method, title: text(rec.title, TITLE_MAX), message: text(rec.message, MESSAGE_MAX), options,
      sure: options.filter((o, i) => o === raw[i]),
      truncated: over(rec.title, TITLE_MAX) || over(rec.message, MESSAGE_MAX) || (Array.isArray(rec.options) && rec.options.length > OPTIONS_MAX) || raw.some((o) => over(o, OPTION_MAX)),
      expiresAt: wait ? Date.now() + wait : null, timer: null,
    };
    if (wait) { d.timer = setTimeout(() => dropDialog(d.id, 'expired'), wait); if (d.timer.unref) d.timer.unref(); }
    dialogs.set(d.id, d);
    emit({ kind: 'dialog', ...publicDialog(d) });
    notify();
  }

  function onResponse(rec) {
    const entry = typeof rec.id === 'string' ? pending.get(rec.id) : undefined;
    if (!entry) return; // unknown id: ignored
    pending.delete(rec.id);
    clearTimeout(entry.timer);
    // RP140: the text of a refusal stays in `reason` (never in the message): the host only matches its start to tell a known refusal; it is never forwarded.
    if (rec.success !== true) { const err = fail('The agent rejected the command'); if (typeof rec.error === 'string') err.reason = rec.error.slice(0, 200); return entry.reject(err); }
    const data = rec.data === undefined || rec.data === null ? {} : rec.data;
    if (entry.type === 'prompt' && data.disposition === 'started') {
      streaming = true;
      // The run may have ended before its own answer arrived: then ask again instead of staying busy for ever.
      if (ends !== entry.ends) refresh();
      notify();
    }
    return entry.resolve(data);
  }

  function onLine(line) {
    let rec;
    try { rec = JSON.parse(line); } catch { return; }
    if (!rec || typeof rec !== 'object' || Array.isArray(rec)) return;
    if (rec.type === 'response') return onResponse(rec);
    if (rec.type === 'extension_ui_request') return onUi(rec);
    if (rec.type === 'agent_start') streaming = true;
    emit({ kind: 'event', record: rec });
    notify();
    if (rec.type === 'agent_end' || rec.type === 'agent_settled') { ends++; refresh(); }
    return undefined;
  }

  // LF is the only separator (one optional CR before it is dropped). A line over 8 MB is thrown away up to its LF, never held in memory.
  function append(part) {
    if (skipping) return;
    buf += part;
    if (buf.length > MAX_LINE) { buf = ''; skipping = true; }
  }
  function onData(chunk) {
    if (closed) return;
    try {
      let rest = typeof chunk === 'string' ? chunk : decoder.write(chunk);
      for (let nl = rest.indexOf('\n'); nl >= 0; nl = rest.indexOf('\n')) {
        append(rest.slice(0, nl));
        rest = rest.slice(nl + 1);
        const line = skipping ? '' : buf;
        buf = '';
        skipping = false;
        if (line.trim()) onLine(line.endsWith('\r') ? line.slice(0, -1) : line);
      }
      append(rest);
    } catch { /* a bad record never takes the client down */ }
  }

  // Ends everything once: pending requests fail, dialogs go away, the whole process tree is killed (even after an exit, for what it left).
  function teardown(reason) {
    if (closed) return;
    closed = true;
    clearTimeout(startTimer);
    const err = fail(FAILURES[reason] || FAILURES.exit);
    for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(err); }
    pending.clear();
    queue.length = 0;
    outbox.length = 0;
    for (const d of dialogs.values()) clearTimeout(d.timer);
    dialogs.clear();
    buf = '';
    if (child) killTree(child, { spawn, platform, kill });
    safe(onExit, { reason });
    notify();
  }

  function launch() {
    return new Promise((resolve, reject) => {
      const refuse = () => { teardown('error'); reject(fail(FAILURES.error)); };
      // cmd.exe looks for a bare name in the current folder (the repo!) first: only an absolute file found on the PATH is ever launched.
      let file = command;
      if (!commandProblem(command) && !isAbs(command)) file = makeWhich({ env: env || {}, platform, exists: fs.existsSync })(command);
      if (!file || commandProblem(file) || !Array.isArray(args)) return refuse();
      try {
        const spec = launchSpec(file, platform);
        if (spec.shell && !args.every((a) => SAFE_ARG.test(a))) return refuse();
        child = spawn(spec.file, args, { cwd, env, shell: spec.shell, windowsHide: true, detached: platform !== 'win32', stdio: ['pipe', 'pipe', 'ignore'] });
      } catch { return refuse(); }
      child.on('error', () => teardown('error'));
      child.on('exit', () => teardown('exit'));
      child.on('close', () => teardown('exit'));
      for (const stream of [child.stdout, child.stdin]) if (stream && typeof stream.on === 'function') stream.on('error', () => {});
      child.stdout.on('data', onData);
      startTimer = setTimeout(() => teardown('timeout'), startTimeoutMs);
      return send('get_state', {}, Infinity, true).then((data) => {
        clearTimeout(startTimer);
        ready = true;
        streaming = !!(data && data.isStreaming);
        while (queue.length) write(queue.shift());
        notify();
        resolve(data);
      }, (e) => { teardown('error'); reject(e); });
    });
  }

  let starting = null;
  function start() {
    if (!starting) { started = true; starting = launch(); }
    return starting;
  }

  function answerDialog(id, answer) {
    const d = typeof id === 'string' ? dialogs.get(id) : undefined;
    if (closed || !d) return false; // only a dialog that is pending right now can be answered
    if (d.expiresAt && Date.now() >= d.expiresAt) { dropDialog(id, 'expired'); return false; }
    const body = answerBody(d, answer);
    if (!body) return false; // a refused answer writes nothing and the dialog stays pending
    write({ type: 'extension_ui_response', id, ...body });
    dropDialog(id, 'answered');
    return true;
  }

  return {
    start,
    request: (type, fields = {}, { timeoutMs = requestTimeoutMs } = {}) => send(type, fields, timeoutMs, false),
    answerDialog,
    pendingDialogs: () => [...dialogs.values()].map(publicDialog),
    state,
    close: () => teardown('closed'),
  };
}

module.exports = { createRpcClient, RpcError, START_MS };
