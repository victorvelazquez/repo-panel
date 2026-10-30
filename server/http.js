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
const { loadConfig, findRepo, roomIssues } = require('./config.js');
const { localState, diffText } = require('./local.js');
const { prState, mergePr, rerunFailed } = require('./github.js');
const { roadmapState } = require('./roadmap.js');
const { addRepo, removeRepo, setSnoozed, setDismissed, scanFolder } = require('./repos.js');
const { piSend, piStatus, sendGuard, liveCacheStats } = require('./pi.js');
const { readState } = require('./state.js');
const { requirementsFor, prerequisites } = require('./requirements.js');
const { roomsState, createRoom, removeRoom, assignRoom } = require('./rooms.js');
const { queueFor, conformityFor } = require('./queue.js');
const { summaryFor } = require('./summary.js');
const { sendChat, clearChat } = require('./chatsend.js');
const { answerDialog } = require('./dialoganswer.js');
const { createEventHub } = require('./events.js');
const { sessionsState, chatState, adoptSession, releaseSession, startSession } = require('./sessions.js');

const ROOT = path.join(__dirname, '..');
const TOKEN = crypto.randomBytes(24).toString('hex');

// RP76: these POSTs only calculate; every other POST is an action of the person and goes through the interactive lane.
const READ_ONLY_POSTS = new Set(['POST /api/queue', 'POST /api/conformity']);
const query = (u) => Object.fromEntries(new URL(u, 'http://x').searchParams);

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
  'GET /api/pi-status': (q, b, d) => piStatus(findRepo(q.id), d.orca, { tail: q.tail === '1' }),
  'GET /api/rooms': () => roomsState(),
  'GET /api/summary': (q, b, d) => summaryFor(d, q),
  'GET /api/sessions': (q, b, d) => sessionsState(q.id, d.orca, d.sessionsDir),
  'GET /api/chat': (q, b, d) => chatState(q.id, q.session, q.limit, d.sessionsDir),
  'GET /api/prerequisites': () => prerequisites(),
  'GET /api/diff': (q) => diffText(findRepo(q.id)),
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
  'POST /api/pi': (q, b, d) => piSend(findRepo(b.id), b.command, d.orca, d.wait, d.requirements, { pr: b.pr, prs: d.prs, guard: d.guard }),
  'POST /api/sessions/adopt': (q, b, d) => adoptSession(b.id, b.session, d.orca, d.sessionsDir),
  'POST /api/sessions/release': (q, b, d) => releaseSession(b.id, d.orca, d.sessionsDir),
  'POST /api/sessions/start': (q, b, d) => startSession(b.id, d.orca),
  'POST /api/chat/send': (q, b, d) => sendChat(b && b.id, b, { orca: d.orca, wait: d.wait, sessionsDir: d.sessionsDir, now: d.now }),
  'POST /api/chat/clear': (q, b, d) => clearChat(b && b.id, { orca: d.orca, wait: d.wait }),
  'POST /api/dialog/answer': (q, b, d) => answerDialog(b && b.id, b, { orca: d.orca, wait: d.wait, now: d.now }),
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

// `deps` replaces what the pi routes talk to ({ orca, wait, requirements, prs, guard }); tests inject fakes, the real server passes none.
function createServer(port, deps = {}) {
  // One duplicate-send guard per server (tests inject theirs with a fake clock).
  deps = { guard: sendGuard(), ...deps };
  const hostOk = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  const perf = createPerf();
  const flights = new Map();
  const hub = deps.hub || createEventHub();
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
        if (!handler) return reply(200, { routes: perf.summary(), queue: stats(), liveCache: liveCacheStats() });
        const body = req.method === 'POST' ? await readBody(req) : {};
        const run = () => { executed = true; return handler(query(req.url), body, deps); };
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
  server.close = (cb) => { hub.closeAll(); return close(cb); };
  server.hub = hub;
  return server;
}

module.exports = { createServer, isPanelRunning };
