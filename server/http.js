'use strict';
// HTTP layer: host and token checks, routes, static files and the server factory.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const lib = require('../lib.js');
const view = require('../public/view.js');
const { HttpError } = require('./errors.js');
const { git, firstLine, withContext, withPriority, singleFlight, stats } = require('./exec.js');
const { createPerf } = require('./perf.js');
const { loadConfig, saveConfig, findRepo, roomIssues } = require('./config.js');
const { resolveRuntime, handshake } = require('./piruntime.js');
const { localState, diffText } = require('./local.js');
const { listFiles, readFile } = require('./files.js');
const { readNotes, saveNotes } = require('./notes.js');
const { prState, mergePr, rerunFailed } = require('./github.js');
const { roadmapState } = require('./roadmap.js');
const { addRepo, removeRepo, setSnoozed, setDismissed, scanFolder } = require('./repos.js');
const { piSend, rpcPiStatus, sendGuard } = require('./pi.js');
const { readState } = require('./state.js');
const { requirementsFor, prerequisites } = require('./requirements.js');
const { roomsState, createRoom, removeRoom, assignRoom } = require('./rooms.js');
const { queueFor, conformityFor } = require('./queue.js');
const { summaryFor } = require('./summary.js');
const { createSummaryStore } = require('./summarystore.js');
const { createEventHub } = require('./events.js');
const { createRpcHost, rpcApi } = require('./rpchost.js');
const { readUsage, usageFile } = require('./usage.js');
const { sessionsState, chatState, adoptSession, releaseSession, adoptIfNone } = require('./sessions.js');

const ROOT = path.join(__dirname, '..');
const TOKEN = crypto.randomBytes(24).toString('hex');

// RP76: these POSTs only calculate; every other POST is an action of the person and goes through the interactive lane.
const READ_ONLY_POSTS = new Set(['POST /api/queue', 'POST /api/conformity']);
// RP80b: after these actions end (success or failure) the store catches up that repo, fire-and-forget.
const CATCH_UP_POSTS = new Set(['POST /api/merge', 'POST /api/rerun', 'POST /api/fetch', 'POST /api/pi']);
// No client, no work: a store that has never been asked (awake() false) is left alone; a store without awake() is always called.
const catchUp = (store, id) => { if (store && (typeof store.awake !== 'function' || store.awake())) Promise.resolve().then(() => store.catchUp(id)).catch(() => {}); };
const query = (u) => Object.fromEntries(new URL(u, 'http://x').searchParams);

// What the page may know of the runtimes: ids, labels, versions and state; never a command or a folder.
const piState = (r) => ({
  mode: r.mode,
  active: r.active ? r.active.id : null,
  ...(r.problem ? { problem: r.problem } : {}),
  candidates: r.candidates.map((c) => ({ id: c.id, label: c.label, version: c.version, available: c.available, ...(c.reason ? { reason: c.reason } : {}), active: !!(r.active && r.active.id === c.id) })),
});

// RPC1a: only `auto` or the id of a runtime detected as available can be chosen; the body carries nothing else (no command, no folder).
async function setPiRuntime(b, deps) {
  const found = await resolveRuntime(deps);
  const allowed = new Set(['auto', ...found.candidates.filter((c) => c.available).map((c) => c.id)]);
  const keys = b && typeof b === 'object' && !Array.isArray(b) ? Object.keys(b) : null;
  if (!keys || keys.length !== 1 || keys[0] !== 'runtime' || typeof b.runtime !== 'string' || !allowed.has(b.runtime)) throw new HttpError(400, 'runtime must be auto or a detected pi runtime');
  const cfg = loadConfig();
  saveConfig({ ...cfg, pi: { ...(cfg.pi || {}), runtime: b.runtime } });
  return piState(await resolveRuntime(deps));
}

const routes = {
  'GET /api/config': () => {
    const cfg = loadConfig();
    return {
      snoozed: cfg.snoozed,
      dismissed: cfg.dismissed || [],
      rooms: cfg.rooms || [],
      roomIssues: roomIssues(cfg),
      groups: cfg.groups.map((g) => ({
        name: g.name,
        repos: g.repos.map((r) => ({ id: lib.repoId(r.path), path: r.path, name: path.basename(r.path) })),
      })),
    };
  },
  'GET /api/local': (q) => localState(findRepo(q.id)),
  'GET /api/prs': (q) => prState(findRepo(q.id)),
  'GET /api/roadmap': (q) => roadmapState(findRepo(q.id)),
  'GET /api/requirements': (q) => requirementsFor(findRepo(q.id)),
  'GET /api/state': (q) => readState(findRepo(q.id)),
  'GET /api/pi-status': (q, b, d) => rpcPiStatus(findRepo(q.id), d.rpcHost), // RPC2-2: `tail` and `fresh` are accepted and ignored
  'GET /api/rooms': () => roomsState(),
  'GET /api/summary': (q, b, d) => summaryFor(d, q),
  // RP80: the board is answered from the store's memory (reads nothing); the refresh answers at once and reads in the background.
  'GET /api/board': (q, b, d) => {
    if (!d.summaryStore) throw new HttpError(404, 'No board');
    if (q.since !== undefined && !/^\d+$/.test(q.since)) throw new HttpError(400, 'since must be an integer >= 0');
    return d.summaryStore.board(q.since === undefined ? 0 : Number(q.since));
  },
  'POST /api/board/refresh': (q, b, d) => {
    const store = d.summaryStore;
    if (!store) throw new HttpError(404, 'No board');
    if (b.id !== undefined && typeof b.id !== 'string') throw new HttpError(400, 'id must be a string');
    if (b.id !== undefined) findRepo(b.id); // an unknown repo is a 404 before anything starts
    Promise.resolve().then(() => (b.id === undefined ? store.refreshAll() : store.catchUp(b.id))).catch(() => {});
    return { started: true };
  },
  'GET /api/sessions': (q, b, d) => sessionsState(q.id, d.sessionsDir, d.sessionOf),
  'GET /api/chat': (q, b, d) => chatState(q.id, q.session, q.limit, d.sessionsDir),
  // RP62: the Claude usage file, read on every request (no cache); a missing or broken file is a normal 200 with available false.
  'GET /api/usage': (q, b, d) => readUsage({ file: d.usageFile || usageFile() }),
  'GET /api/prerequisites': (q, b, d) => prerequisites(undefined, d.piRuntime ? () => resolveRuntime(d.piRuntime) : undefined),
  // RPC1a: spawns nothing unless ?check=1, which starts the active runtime once (`get_state`) and ends it.
  'GET /api/pi-runtime': async (q, b, d) => {
    const found = await resolveRuntime(d.piRuntime);
    const out = piState(found);
    if (q.check === '1') {
      // The last check is reused for 5 s (ok or failed): the page cannot make the panel spawn the runtime over and over.
      const now = d.now || Date.now;
      const id = found.active ? found.active.id : null;
      if (!d.piCheck || d.piCheck.id !== id || now() - d.piCheck.at >= 5000) {
        const check = found.active ? await handshake(found.active, d.piRuntime) : { ok: false, error: found.problem };
        d.piCheck = { at: now(), id, check };
      }
      out.check = d.piCheck.check;
    }
    return out;
  },
  'POST /api/pi-runtime': (q, b, d) => setPiRuntime(b, d.piRuntime),
  'GET /api/diff': (q) => diffText(findRepo(q.id)),
  // RP65: the file explorer; the repo comes only from the config by id, the path is validated and matched against git's own listing.
  'GET /api/files': (q) => listFiles(findRepo(q.id)),
  'GET /api/file': (q) => readFile(findRepo(q.id), q.path),
  // RP93: the notes of a repo, one fixed file (see server/notes.js); the repo comes from the config by id, never a path from the page.
  'GET /api/notes': (q) => readNotes(findRepo(q.id)),
  'POST /api/notes': (q, b) => saveNotes(findRepo(b && b.id), b),
  'POST /api/fetch': async (q, b) => {
    const repo = findRepo(b.id);
    const r = await git(repo.path, ['fetch', '--prune', '--quiet']);
    if (r.code !== 0) throw new HttpError(502, firstLine(r.stderr) || 'git fetch failed');
    return { ok: true };
  },
  'POST /api/merge': (q, b) => mergePr(findRepo(b.id), Number(b.number), b.method, !!b.deleteBranch),
  'POST /api/rerun': (q, b) => rerunFailed(findRepo(b.id), Number(b.number)),
  'POST /api/snooze': (q, b) => setSnoozed(b.id, Number(b.number), !!b.on, !!b.wasReady),
  'POST /api/dismiss': (q, b) => setDismissed(b.id, !!b.on),
  'POST /api/pi': (q, b, d) => piSend(findRepo(b.id), b.command, d.rpcHost, d.requirements, { pr: b.pr, prs: d.prs, guard: d.guard }),
  'POST /api/sessions/adopt': (q, b, d) => adoptSession(b.id, b.session, d.sessionsDir, d.sessionOf),
  'POST /api/sessions/release': (q, b, d) => releaseSession(b.id, d.sessionsDir, d.sessionOf),
  // RPC1b: pi sessions in RPC mode, one per repo; the repo comes from the config by id and no program, folder or argument comes from the page.
  'POST /api/rpc/start': (q, b, d) => rpcApi(d.rpcHost).start(b),
  'POST /api/rpc/prompt': (q, b, d) => rpcApi(d.rpcHost).prompt(b),
  'POST /api/rpc/steer': (q, b, d) => rpcApi(d.rpcHost).steer(b),
  'POST /api/rpc/abort': (q, b, d) => rpcApi(d.rpcHost).abort(b),
  'POST /api/rpc/dialog': (q, b, d) => rpcApi(d.rpcHost).dialog(b),
  // RPC2b-1: the state of EVERY configured repo (closed by default), from the host's memory: nothing starts and nothing is read.
  'GET /api/rpc/states': (q, b, d) => ({ states: Object.fromEntries(loadConfig().groups.flatMap((g) => g.repos).map((r) => { const id = lib.repoId(r.path); return [id, d.rpcHost.stateOf(id)]; })) }),
  'GET /api/rpc/status': (q, b, d) => rpcApi(d.rpcHost).status(q),
  'POST /api/queue': (q, b) => queueFor(b),
  'POST /api/conformity': (q, b) => conformityFor(b),
  'POST /api/repos': (q, b) => addRepo(b.path, b.group),
  'POST /api/repos/remove': (q, b) => { removeRepo(b.id); return { ok: true }; },
  'POST /api/rooms/create': (q, b) => createRoom(b.name, b.path),
  'POST /api/rooms/remove': (q, b) => removeRoom(b.name),
  'POST /api/rooms/assign': (q, b) => assignRoom(b.id, b.room),
  'GET /api/scan': (q) => ({ repos: scanFolder(q.dir) }),
};

const STATIC = {
  '/view.js': ['view.js', 'text/javascript; charset=utf-8'],
  '/resumen.js': ['resumen.js', 'text/javascript; charset=utf-8'],
  '/data.js': ['data.js', 'text/javascript; charset=utf-8'],
  '/feed.js': ['feed.js', 'text/javascript; charset=utf-8'],
  '/tabs.js': ['tabs.js', 'text/javascript; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
};

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > 1e6) { reject(new HttpError(413, 'Body too large')); req.destroy(); } });
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch { reject(new HttpError(400, 'Invalid JSON')); } });
  });
}

const send = (res, status, body, type = 'application/json; charset=utf-8', extra = {}) => {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...extra });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
};

function isPanelRunning(port) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/health', timeout: 1500 }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => { try { resolve(JSON.parse(data).app === 'repo-panel'); } catch { resolve(false); } });
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(false));
  });
}

// `deps` replaces what the pi routes talk to ({ wait, requirements, prs, guard, summaryStore, noSummaryStore }); tests inject fakes, the real server passes none.
function createServer(port, deps = {}) {
  // One duplicate-send guard per server (tests inject theirs with a fake clock).
  deps = { guard: sendGuard(), ...deps };
  const hostOk = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  const perf = createPerf();
  const flights = new Map();
  const hub = deps.hub || createEventHub();
  // RPC1b: the pi sessions live in this process (a restart ends them; they come back with the same --session-id). Their events go to the hub as `rpc`.
  if (!deps.rpcHost) deps.rpcHost = createRpcHost({ resolve: deps.rpcResolve || (() => resolveRuntime(deps.piRuntime)), repoOf: findRepo, publish: (id, payload) => hub.emit('rpc', id, payload), adopt: adoptIfNone, createClient: deps.rpcClient });
  // RPC2b-1: the session state of every repo is the host's (a synchronous read of memory); an injected host with no stateOf leaves the session `unknown`.
  if (!deps.sessionOf && typeof deps.rpcHost.stateOf === 'function') deps.sessionOf = (id) => deps.rpcHost.stateOf(id);
  // RP78: the Summary comes from a store kept in memory (server.js starts it); injected by tests, or off with noSummaryStore. Built AFTER the host: it reads its state.
  if (!deps.summaryStore && !deps.noSummaryStore) deps.summaryStore = createSummaryStore({ deps, now: deps.now, sessionOf: deps.sessionOf });
  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url.split('?')[0] === '/api/events') return openStream(req, res);
    const t0 = Date.now();
    const ctx = { procs: 0, waitMs: 0 };
    // A URL the parser rejects (`//`, `http://[`) must answer an error, never throw outside the try below and take the panel down.
    let pathname = '/';
    let badUrl = false;
    try { pathname = new URL(req.url, 'http://x').pathname; } catch { badUrl = true; }
    const key = `${req.method} ${pathname}`;
    const priority = (req.method === 'POST' && !READ_ONLY_POSTS.has(key)) || (req.method === 'GET' && req.headers['x-priority'] === 'user') ? 'user' : 'background';
    let executed = true;
    // Every JSON answer is timed (errors too); GET /api/perf does not record itself.
    const reply = (status, body, type) => {
      const ms = Date.now() - t0;
      const json = !type;
      // The page, its assets and /health are not API calls; only API routes (and unknown /api/ paths) are timed.
      if (key !== 'GET /api/perf' && pathname.startsWith('/api/')) perf.record({ route: routes[key] ? key : `${req.method} (other)`, ms, waitMs: ctx.waitMs, procs: ctx.procs, priority, executed });
      const timing = json ? { 'server-timing': `total;dur=${ms}${ctx.waitMs > 0 ? `, queue;dur=${ctx.waitMs}` : ''}` } : {};
      return send(res, status, body, type, timing);
    };
    return withContext(ctx, () => withPriority(priority, async () => {
      try {
        // Blocks DNS-rebinding: only our own host names are served.
        if (!hostOk.has(req.headers.host)) throw new HttpError(403, 'Forbidden host');
        if (badUrl) throw new HttpError(400, 'Bad request');
        if (req.method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
          const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8').replace('__TOKEN__', TOKEN);
          return reply(200, html, 'text/html; charset=utf-8');
        }
        if (req.method === 'GET' && STATIC[pathname]) {
          const [file, type] = STATIC[pathname];
          return reply(200, fs.readFileSync(path.join(ROOT, 'public', file), 'utf8'), type);
        }
        // Lets a second launch tell "my own panel is already here" from "another project owns the port".
        if (req.method === 'GET' && pathname === '/health') return reply(200, { app: 'repo-panel', api: view.API_VERSION });
        const handler = routes[key];
        if (!handler && key !== 'GET /api/perf') throw new HttpError(404, 'Not found');
        if (req.headers['x-token'] !== TOKEN) throw new HttpError(401, 'Invalid token');
        if (!handler) return reply(200, { routes: perf.summary(), queue: stats() });
        const body = req.method === 'POST' ? await readBody(req) : {};
        const run = async () => {
          executed = true;
          try { return await handler(query(req.url), body, deps); } finally { if (CATCH_UP_POSTS.has(key)) catchUp(deps.summaryStore, body && body.id); }
        };
        // Identical GETs in flight share one execution; POSTs never do.
        if (req.method !== 'GET') return reply(200, await run());
        executed = false;
        // The lane is part of the key: an interactive request never joins a background one that may have waited in the queue.
        return reply(200, await singleFlight(flights, `${priority}|${req.url}`, run));
      } catch (e) {
        return reply(e.status || 500, { error: e.message || 'Internal error' });
      }
    }));
  });
  // RP77b: GET /api/events is long-lived, so it skips perf and singleFlight; the token is read ONLY from the x-token header (never the URL).
  function openStream(req, res) {
    if (!hostOk.has(req.headers.host)) return send(res, 403, { error: 'Forbidden host' });
    if (req.headers['x-token'] !== TOKEN) return send(res, 401, { error: 'Invalid token' });
    for (const [k, v] of Object.entries({ 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })) res.setHeader(k, v);
    if (hub.add(res)) return undefined;
    res.removeHeader('connection');
    return send(res, 503, { error: 'Too many event streams open' });
  }
  const close = server.close.bind(server);
  server.close = (cb) => { hub.closeAll(); deps.rpcHost.closeAll(); if (deps.summaryStore) deps.summaryStore.stop(); return close(cb); };
  server.hub = hub;
  server.rpcHost = deps.rpcHost;
  server.summaryStore = deps.summaryStore;
  return server;
}

module.exports = { createServer, isPanelRunning };
