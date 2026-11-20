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
// RP238: how long a closed pi may take to exit by itself once its stdin ends (it saves its session file first; 13.4 s measured through the .cmd launcher) before
// its tree is killed. Decided by the person.
const GRACE_MS = 20000;
// RP238: after the kill, how long to wait for the child to report its exit before the close counts as done anyway (a child that never reports must not hang the shutdown).
const KILL_WAIT_MS = 2000;
const MAX_LINE = 8 * 1024 * 1024;
const MAX_WAITING = 200;
const MAX_DIALOGS = 20;
const STATUS_MAX = 200;
const DIALOGS = new Set(['select', 'confirm', 'input', 'editor']);
const SAFE_ARG = /^[A-Za-z0-9._-]+$/;
// RP238b: what pi wrote as an error, reduced to ONE category of a closed list; its text never leaves the server. pi in --mode rpc also writes there what is
// not an error (its stdout goes there too), so only the messages it writes before it exits count, and anything else is null.
const CAUSES = {
  'no-model': 'No model or login is set up: run pi in a terminal to sign in',
  extension: 'An extension failed to load: start pi in a terminal to see which',
  session: 'The session id was rejected',
  folder: 'The repo folder no longer exists',
};
const CAUSE_RULES = [
  ['folder', /current working directory no longer exists/i],
  ['session', /--session-id cannot be combined|Session id must|Session already exists with id|No session found matching/i],
  ['extension', /Failed to load extension/i],
  ['no-model', /No models available|No API key found/i],
];
const CAUSE_LINES = 8;
const ANSI = /[[0-?]*[ -/]*[@-~]/g;
function causeOf(text) {
  if (typeof text !== 'string' || !text) return null;
  // Only the last lines pi wrote count (its fatal message and a hint come right before the exit; an older tool line is not the cause), and the closest to the end wins.
  const lines = text.replace(ANSI, '').split(/\r?\n/).filter((l) => l.trim()).slice(-CAUSE_LINES);
  for (let i = lines.length - 1; i >= 0; i--) {
    const hit = CAUSE_RULES.find(([, re]) => re.test(lines[i]));
    if (hit) return hit[0];
  }
  return null;
}
// Only the end of the error output is kept (the messages that matter come right before the exit), and the cause waits at most this long for that output to end.
const ERR_KEEP = 16384;
const CAUSE_WAIT_MS = 1000;
const FAILURES = { timeout: 'The session did not start in time', error: 'The session could not be started', exit: 'The session ended', closed: 'The session is closed' };

class RpcError extends Error { constructor(message) { super(message); this.name = 'RpcError'; } }
const fail = (message) => new RpcError(message);
const text = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '');
// What the page may see of a dialog (RPC2-3): the caps below; anything cut sets `truncated`; the page notes it (RP245: it no longer blocks the answer, as in the terminal).
const TITLE_MAX = 300;
const MESSAGE_MAX = 4000;
const OPTIONS_MAX = 20;
const OPTION_MAX = 200;
const ANSWER_MAX = 4000;
// Everything but LF and TAB (C0, DEL, C1).
const CONTROLS = /[\x00-\x08\x0b-\x1f\x7f-\x9f]/;
const over = (v, max) => typeof v === 'string' && v.length > max;

// The body for the agent, or null: the shape must fit the METHOD of the dialog, with no extra key. A select value must be strictly one of
// the options the page was shown (never any other string); `d.sure` holds the options that were not cut and that no cut option shows the same (RP245).
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

// RP231: how long a run that ended (agent_end, no retry) may wait for agent_settled before the client stops waiting (a pi that never sends it), and how a
// failed get_state is asked again.
const SETTLE_MS = 30000;
const RETRY_FACTOR = 4; // a run that will retry waits four times longer, plus the delay pi announces
const REFRESH_RETRIES = 3;
const REFRESH_RETRY_MS = 1000;

function createRpcClient({ command, args = [], cwd, env, spawn = cp.spawn, platform = process.platform, kill = process.kill, startTimeoutMs = START_MS, graceMs = GRACE_MS, killWaitMs = KILL_WAIT_MS, causeWaitMs = CAUSE_WAIT_MS, requestTimeoutMs = 120000, settleMs = SETTLE_MS, refreshRetries = REFRESH_RETRIES, refreshRetryMs = REFRESH_RETRY_MS, onEvent = () => {}, onExit = () => {} }) {
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
  let stopReason = null; // RP228: how the last turn of the run ended
  let outcome = null; // RP228: { kind, at } of the last finished task
  let unsettled = false; // RP231: a run started and pi has not said agent_settled yet
  let compacting = false; // RP231: between compaction_start and compaction_end
  let settleDue = false; // RP231: the fallback ran out while pi was compacting
  let settleTimer = null;
  let retryTimer = null;
  let startTimer = null;
  let lastState = 'starting';
  let exited = false; // RP238: the child said exit or close: it is gone and never killed (its PID may already be another process)
  let gone = null; // RP238: resolves once the child is gone (it exited, or it was killed at the end of the grace)
  let onGone = () => {};
  const safe = (fn, arg) => { try { fn(arg); } catch { /* a listener must not break the client */ } };
  const emit = (e) => safe(onEvent, e);

  const state = () => (closed ? 'closed' : !ready ? 'starting' : dialogs.size ? 'asking' : streaming || unsettled ? 'busy' : 'idle');
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

  // The agent's idea of "streaming" wins whenever a run ends. RP231: a failed read is asked again a few times; when they all fail and pi already said it is done
  // (no run waits for agent_settled), the session is free, so a lost answer never leaves it busy for ever.
  function refresh(tries = 0) {
    if (!ready || closed) return;
    if (refreshing) { again = true; return; }
    refreshing = true;
    clearTimeout(retryTimer);
    let failed = false;
    send('get_state', {}, requestTimeoutMs, true)
      .then((d) => { streaming = !!(d && d.isStreaming); }, () => { failed = true; })
      .then(() => {
        refreshing = false;
        if (failed && !again && !closed) {
          if (tries < refreshRetries) { retryTimer = setTimeout(() => refresh(tries + 1), refreshRetryMs); if (retryTimer.unref) retryTimer.unref(); }
          else if (!unsettled) streaming = false;
        }
        notify();
        if (again) { again = false; refresh(); }
      });
  }
  // RP231: the run is over for pi (agent_settled, or the fallback timer for a pi that never sends it).
  function settle() {
    clearTimeout(settleTimer);
    settleDue = false;
    unsettled = false;
  }
  // RP231: the fallback for a run that ended and never settles. While pi compacts, the end waits for compaction_end instead of freeing the session in the middle.
  function armSettle(ms) {
    clearTimeout(settleTimer);
    if (!unsettled || closed) return;
    settleTimer = setTimeout(() => { if (compacting) { settleDue = true; return; } settle(); refresh(); }, ms);
    if (settleTimer.unref) settleTimer.unref();
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
      // RP245c: the permission mode of Gentle Shell (`gentle:mode`) is kept the same way; its `gentle:yolo` badge is not needed (the mode says it all).
      if (rec.statusKey === 'engram' || rec.statusKey === 'gentle:mode') emit({ kind: 'status', key: rec.statusKey, text: typeof rec.statusText === 'string' ? rec.statusText.slice(-STATUS_MAX) : '' });
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
      // RP245: an option is sure when it was not cut AND no cut option shows the same text (otherwise the person may have meant the cut one).
      sure: options.filter((o, i) => o === raw[i] && !options.some((p, j) => p === o && p !== raw[j])),
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
    if (rec.type === 'agent_start') { streaming = true; unsettled = true; settleDue = false; clearTimeout(settleTimer); stopReason = null; outcome = null; }
    if (rec.type === 'turn_end') { const r = typeof rec.stopReason === 'string' ? rec.stopReason : rec.message && typeof rec.message.stopReason === 'string' ? rec.message.stopReason : null; stopReason = r; } // RP228: only the last turn counts (a retry that succeeds ends done)
    // RP231: an agent_end that will retry is not the end of the task: no outcome, no read, the session stays busy. Any other one keeps it busy until agent_settled,
    // with a fallback timer for a pi that never sends it (much longer for a retry, stretched by the delay pi announces).
    const retrying = rec.type === 'agent_end' && rec.willRetry === true;
    const kindNow = () => (rec.aborted === true || stopReason === 'aborted' ? 'stopped' : stopReason === 'error' ? 'failed' : 'done');
    if (rec.type === 'agent_end' && !retrying) outcome = { kind: kindNow(), at: Date.now() }; // RP228
    if (rec.type === 'agent_end') armSettle(retrying ? settleMs * RETRY_FACTOR : settleMs);
    if (rec.type === 'auto_retry_start' && unsettled) armSettle((Number(rec.delayMs) > 0 ? Math.min(Number(rec.delayMs), 3600000) : 0) + settleMs * RETRY_FACTOR);
    if (rec.type === 'compaction_start') compacting = true;
    if (rec.type === 'compaction_end') { compacting = false; if (settleDue) { settleDue = false; settle(); refresh(); } }
    if (rec.type === 'agent_settled') {
      const wasRunning = unsettled;
      settle();
      // RP231: only a task whose last agent_end was a retry is decided here (given up, or stopped by hand: `aborted`); an outcome agent_end already fixed is
      // never overwritten, and a settled with no run before it creates nothing (RP228).
      if (wasRunning && !outcome) outcome = { kind: kindNow(), at: Date.now() };
    }
    emit({ kind: 'event', record: rec });
    notify();
    if ((rec.type === 'agent_end' && !retrying) || rec.type === 'agent_settled') { ends++; refresh(); }
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

  // RP238b: the error output is ALWAYS read, also after the end (a pi that writes a lot never blocks on a full pipe), and only its last ERR_KEEP characters stay.
  let errTail = '';
  let errDone = Promise.resolve();
  function keepErrors(err) {
    if (!err || typeof err.on !== 'function') return;
    const dec = new StringDecoder('utf8');
    err.on('error', () => {});
    err.on('data', (c) => { const s = typeof c === 'string' ? c : dec.write(c); errTail = s.length >= ERR_KEEP ? s.slice(-ERR_KEEP) : (errTail + s).slice(-ERR_KEEP); });
    errDone = new Promise((r) => { err.once('end', r); err.once('close', r); });
  }
  // The category of what pi wrote as an error (null when nothing known), once that output ended (pi may report its exit first) or at the cap.
  function cause() {
    let t;
    const cap = new Promise((r) => { t = setTimeout(r, causeWaitMs); });
    return Promise.race([errDone, cap]).then(() => { clearTimeout(t); return causeOf(errTail); });
  }

  // RP238: an orderly end: stdin is closed (pi then saves its session file and exits by itself); only a child still alive after graceMs is killed with its tree.
  function stop() {
    return new Promise((resolve) => {
      if (!child || exited) return resolve();
      let capped = null;
      // The child is gone when it reports its exit (taskkill takes a moment), or at the cap. The cap is armed before the kill, which may report the exit at once.
      const timer = setTimeout(() => { capped = setTimeout(() => onGone(), killWaitMs); killTree(child, { spawn, platform, kill }); }, graceMs);
      onGone = () => { onGone = () => {}; clearTimeout(timer); clearTimeout(capped); resolve(); };
      try { child.stdin.end(); } catch { /* the grace still ends it */ }
    });
  }
  function exit(reason) {
    exited = true;
    onGone();
    teardown(reason);
  }

  // Ends everything once: pending requests fail, dialogs go away and the child is stopped (RP238: stdin first, the tree killed only after the grace).
  function teardown(reason) {
    if (closed) return gone;
    closed = true;
    clearTimeout(startTimer);
    clearTimeout(settleTimer);
    clearTimeout(retryTimer);
    const err = fail(FAILURES[reason] || FAILURES.exit);
    for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(err); }
    pending.clear();
    queue.length = 0;
    outbox.length = 0;
    for (const d of dialogs.values()) clearTimeout(d.timer);
    dialogs.clear();
    buf = '';
    gone = stop();
    safe(onExit, { reason });
    notify();
    return gone;
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
        child = spawn(spec.file, args, { cwd, env, shell: spec.shell, windowsHide: true, detached: platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'] });
      } catch { return refuse(); }
      keepErrors(child.stderr);
      child.on('error', () => teardown('error'));
      child.on('exit', () => exit('exit'));
      child.on('close', () => exit('exit'));
      for (const stream of [child.stdout, child.stdin]) if (stream && typeof stream.on === 'function') stream.on('error', () => {});
      child.stdout.on('data', onData);
      startTimer = setTimeout(() => teardown('timeout'), startTimeoutMs);
      return send('get_state', {}, Infinity, true).then((data) => {
        clearTimeout(startTimer);
        ready = true;
        streaming = !!(data && data.isStreaming);
        unsettled = streaming; // RP231: a run already in progress when the client joined counts as a run that has not settled
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
    outcome: () => (closed || !outcome ? null : { ...outcome }), // RP228
    close: () => teardown('closed'), // RP238: resolves once the process is gone (bounded by graceMs)
    cause, // RP238b
  };
}

module.exports = { createRpcClient, RpcError, START_MS, GRACE_MS, KILL_WAIT_MS, CAUSES, causeOf };
