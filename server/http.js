'use strict';
// HTTP layer: host and token checks, routes, static files and the server factory.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const lib = require('../lib.js');
const view = require('../public/view.js');
const { HttpError } = require('./errors.js');
const { git, firstLine } = require('./exec.js');
const { loadConfig, findRepo } = require('./config.js');
const { localState, diffText } = require('./local.js');
const { prState, mergePr, rerunFailed } = require('./github.js');
const { roadmapState } = require('./roadmap.js');
const { addRepo, removeRepo, setSnoozed, scanFolder } = require('./repos.js');
const { piSend } = require('./pi.js');
const { queueFor, conformityFor } = require('./queue.js');

const ROOT = path.join(__dirname, '..');
const TOKEN = crypto.randomBytes(24).toString('hex');

const query = (u) => Object.fromEntries(new URL(u, 'http://x').searchParams);

const routes = {
  'GET /api/config': () => {
    const cfg = loadConfig();
    return {
      snoozed: cfg.snoozed,
      groups: cfg.groups.map((g) => ({
        name: g.name,
        repos: g.repos.map((r) => ({ id: lib.repoId(r.path), path: r.path, name: path.basename(r.path) })),
      })),
    };
  },
  'GET /api/local': (q) => localState(findRepo(q.id)),
  'GET /api/prs': (q) => prState(findRepo(q.id)),
  'GET /api/roadmap': (q) => roadmapState(findRepo(q.id)),
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
  'POST /api/pi': (q, b) => piSend(findRepo(b.id), b.command),
  'POST /api/queue': (q, b) => queueFor(b),
  'POST /api/conformity': (q, b) => conformityFor(b),
  'POST /api/repos': (q, b) => addRepo(b.path, b.group),
  'POST /api/repos/remove': (q, b) => { removeRepo(b.id); return { ok: true }; },
  'GET /api/scan': (q) => ({ repos: scanFolder(q.dir) }),
};

const STATIC = {
  '/view.js': ['view.js', 'text/javascript; charset=utf-8'],
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

const send = (res, status, body, type = 'application/json; charset=utf-8') => {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
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

function createServer(port) {
  const hostOk = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  return http.createServer(async (req, res) => {
    try {
      // Blocks DNS-rebinding: only our own host names are served.
      if (!hostOk.has(req.headers.host)) throw new HttpError(403, 'Forbidden host');
      const pathname = new URL(req.url, 'http://x').pathname;
      if (req.method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
        const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8').replace('__TOKEN__', TOKEN);
        return send(res, 200, html, 'text/html; charset=utf-8');
      }
      if (req.method === 'GET' && STATIC[pathname]) {
        const [file, type] = STATIC[pathname];
        return send(res, 200, fs.readFileSync(path.join(ROOT, 'public', file), 'utf8'), type);
      }
      // Lets a second launch tell "my own panel is already here" from "another project owns the port".
      if (req.method === 'GET' && pathname === '/health') return send(res, 200, { app: 'repo-panel', api: view.API_VERSION });
      const handler = routes[`${req.method} ${pathname}`];
      if (!handler) throw new HttpError(404, 'Not found');
      if (req.headers['x-token'] !== TOKEN) throw new HttpError(401, 'Invalid token');
      const body = req.method === 'POST' ? await readBody(req) : {};
      return send(res, 200, await handler(query(req.url), body));
    } catch (e) {
      return send(res, e.status || 500, { error: e.message || 'Internal error' });
    }
  });
}

module.exports = { createServer, isPanelRunning };
