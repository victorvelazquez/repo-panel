'use strict';
// Local-only dashboard server. Binds to 127.0.0.1, requires a per-run token on every API call,
// and only operates on repositories registered in config.json.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile, spawn } = require('node:child_process');
const lib = require('./lib.js');

const ROOT = __dirname;
const CONFIG_PATH = process.env.REPO_PANEL_CONFIG || path.join(ROOT, 'config.json');
const TOKEN = crypto.randomBytes(24).toString('hex');
const MAX_PARALLEL = 8;
const PR_FIELDS = [
  'number', 'title', 'url', 'headRefName', 'baseRefName', 'headRefOid', 'isDraft', 'isCrossRepository',
  'mergeable', 'mergeStateStatus', 'reviewDecision', 'statusCheckRollup', 'author',
].join(',');

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

// ---------- config ----------
// Keeps per-repo settings ("base": the branch work is merged into; "roadmap": its plan file) across a save.
function loadRepo(r) {
  if (typeof r === 'string') return { path: r };
  const roadmap = lib.safeRelPath(r.roadmap);
  return {
    path: r.path,
    ...(typeof r.base === 'string' && r.base ? { base: r.base } : {}),
    ...(roadmap ? { roadmap } : {}),
  };
}

function loadConfig() {
  let cfg = {};
  try { cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); } catch { /* first run */ }
  return {
    port: Number(cfg.port) || 4310,
    editor: typeof cfg.editor === 'string' && cfg.editor ? cfg.editor : 'code',
    groups: Array.isArray(cfg.groups) ? cfg.groups.map((g) => ({
      name: String(g.name),
      repos: (g.repos || []).map(loadRepo),
    })) : [],
    // PRs the user parked, as "<repoId>:<number>" keys.
    snoozed: Array.isArray(cfg.snoozed) ? cfg.snoozed.filter((k) => typeof k === 'string') : [],
  };
}

function saveConfig(cfg) {
  const tmp = `${CONFIG_PATH}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2));
  fs.renameSync(tmp, CONFIG_PATH);
}

function findRepo(id) {
  for (const g of loadConfig().groups) {
    for (const r of g.repos) if (lib.repoId(r.path) === id) return { ...r, id, group: g.name };
  }
  throw new HttpError(404, 'Unknown repository');
}

// ---------- process runner ----------
let active = 0;
const waiting = [];
function slot() {
  return new Promise((resolve) => {
    const go = () => { active++; resolve(() => { active--; if (waiting.length) waiting.shift()(); }); };
    if (active < MAX_PARALLEL) go(); else waiting.push(go);
  });
}

async function run(cmd, args, { cwd, timeout = 60000 } = {}) {
  const release = await slot();
  try {
    return await new Promise((resolve) => {
      execFile(cmd, args, {
        cwd, timeout, maxBuffer: 64 * 1024 * 1024, windowsHide: true,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1' },
      }, (err, stdout, stderr) => {
        resolve({ code: err ? (typeof err.code === 'number' ? err.code : -1) : 0, stdout: stdout || '', stderr: stderr || '' });
      });
    });
  } finally { release(); }
}

const git = (cwd, args, opts) => run('git', ['--no-optional-locks', '-c', 'core.quotepath=false', ...args], { cwd, ...opts });
const gh = (cwd, args, opts) => run('gh', args, { cwd, ...opts });
const firstLine = (s) => (s || '').trim().split('\n').find(Boolean) || '';

function ghError(r) {
  try { const j = JSON.parse(r.stdout); if (j.message) return j.message; } catch { /* not json */ }
  return firstLine(r.stderr) || firstLine(r.stdout) || `exit code ${r.code}`;
}

// ---------- local state ----------
function countLines(file) {
  try {
    const st = fs.statSync(file);
    if (!st.isFile() || st.size > 1024 * 1024) return { lines: 0, binary: false };
    const buf = fs.readFileSync(file);
    if (buf.includes(0)) return { lines: 0, binary: true };
    let n = 0;
    for (const b of buf) if (b === 10) n++;
    if (buf.length && buf[buf.length - 1] !== 10) n++;
    return { lines: n, binary: false };
  } catch { return { lines: 0, binary: false }; }
}

async function localState(repo) {
  if (!fs.existsSync(repo.path)) return { error: 'Folder not found' };
  const st = await git(repo.path, ['status', '--porcelain=v2', '-b', '-uall']);
  if (st.code !== 0) return { error: firstLine(st.stderr) || 'git status failed' };
  const s = lib.parseStatus(st.stdout);

  let ns = await git(repo.path, ['diff', 'HEAD', '--numstat', '--no-renames']);
  if (ns.code !== 0) ns = await git(repo.path, ['diff', '--numstat', '--no-renames']);
  const stats = lib.parseNumstat(ns.code === 0 ? ns.stdout : '');

  const files = s.files.map((f) => {
    const letter = lib.statusLetter(f.xy);
    let added = 0; let deleted = 0; let binary = false;
    if (f.xy === '??') {
      const c = countLines(path.join(repo.path, f.path));
      added = c.lines; binary = c.binary;
    } else if (stats.has(f.path)) {
      ({ added, deleted, binary } = stats.get(f.path));
    }
    return { path: f.path, status: letter, untracked: f.xy === '??', conflict: !!f.conflict, added, deleted, binary };
  });

  let ahead = s.ahead;
  let noUpstream = !s.upstream;
  if (noUpstream && !s.detached) {
    const rl = await git(repo.path, ['rev-list', '--count', 'HEAD', '--not', '--remotes']);
    ahead = rl.code === 0 ? Number(rl.stdout.trim()) || 0 : 0;
  }
  const fr = await git(repo.path, ['for-each-ref', '--format=%(refname:short)%09%(upstream:track)', 'refs/heads']);
  const gone = fr.code === 0 ? lib.parseGoneBranches(fr.stdout) : [];

  return {
    branch: s.branch, detached: s.detached, upstream: s.upstream, noUpstream,
    ahead, behind: s.behind, files,
    added: files.reduce((a, f) => a + f.added, 0),
    deleted: files.reduce((a, f) => a + f.deleted, 0),
    goneBranches: gone, currentGone: !!s.branch && gone.includes(s.branch),
  };
}

const DIFF_CAP = 3 * 1024 * 1024;
async function diffText(repo) {
  let d = await git(repo.path, ['diff', 'HEAD', '--no-color', '--no-renames']);
  if (d.code !== 0) d = await git(repo.path, ['diff', '--no-color', '--no-renames']);
  let text = d.code === 0 ? d.stdout : '';
  const st = await git(repo.path, ['status', '--porcelain=v2', '-uall']);
  const untracked = st.code === 0 ? lib.parseStatus(st.stdout).files.filter((f) => f.xy === '??').slice(0, 50) : [];
  for (const f of untracked) {
    if (text.length > DIFF_CAP) break;
    const full = path.join(repo.path, f.path);
    const c = countLines(full);
    if (c.binary || !fs.existsSync(full) || fs.statSync(full).size > 512 * 1024) {
      text += `\ndiff --git a/${f.path} b/${f.path}\nnew file\nBinary or large file not shown\n`;
      continue;
    }
    const r = await git(repo.path, ['diff', '--no-index', '--no-color', '--', '/dev/null', f.path]);
    text += `\n${r.stdout}`;
  }
  const truncated = text.length > DIFF_CAP;
  return { diff: truncated ? text.slice(0, DIFF_CAP) : text, truncated };
}

// ---------- GitHub state ----------
const metaCache = new Map();
const NO_REMOTE = /no git remotes|none of the git remotes|not a git repository|could not determine|unable to determine/i;

async function repoMeta(repo) {
  const hit = metaCache.get(repo.id);
  if (hit && Date.now() - hit.t < 10 * 60 * 1000) return hit.data;
  const r = await gh(repo.path, ['repo', 'view', '--json', 'nameWithOwner,url,deleteBranchOnMerge']);
  if (r.code !== 0) {
    const msg = firstLine(r.stderr);
    if (NO_REMOTE.test(r.stderr)) return { noRemote: true };
    throw new Error(msg || 'gh repo view failed');
  }
  const j = JSON.parse(r.stdout);
  const data = { slug: j.nameWithOwner, url: j.url, deleteBranchOnMerge: !!j.deleteBranchOnMerge };
  metaCache.set(repo.id, { t: Date.now(), data });
  return data;
}

// Merged PRs per repo+branch, cached briefly so a refresh does not hit the API every time.
const mergedCache = new Map();
const MERGED_TTL = 60 * 1000;

async function mergedPrFor(repo, branch) {
  const key = `${repo.id}:${branch}`;
  const hit = mergedCache.get(key);
  if (hit && Date.now() - hit.t < MERGED_TTL) return hit.pr;
  const r = await gh(repo.path, ['pr', 'list', '--state', 'merged', '--head', branch, '--limit', '5', '--json', 'number,url,isCrossRepository']);
  if (r.code !== 0) return null; // an unknown answer must not raise a false alarm, and is not cached
  let pr = null;
  try { pr = JSON.parse(r.stdout).find((p) => !p.isCrossRepository) || null; } catch { /* keep null */ }
  mergedCache.set(key, { t: Date.now(), pr });
  return pr;
}

// The branch work is merged into: the configured one, else origin/HEAD, else "main".
async function baseBranchOf(repo) {
  if (repo.base) return repo.base;
  const sym = await git(repo.path, ['symbolic-ref', 'refs/remotes/origin/HEAD']);
  return lib.parseBaseBranch(sym.code === 0 ? sym.stdout : '');
}

// The current branch when its work already landed, so the next unit must start from a fresh branch.
async function staleState(repo, openPrs) {
  const b = await git(repo.path, ['symbolic-ref', '--short', '-q', 'HEAD']);
  const branch = b.code === 0 ? b.stdout.trim() : '';
  if (!branch) return null;
  const base = await baseBranchOf(repo);
  if (branch === base) return null;
  const fr = await git(repo.path, ['for-each-ref', '--format=%(refname:short)%09%(upstream:track)', 'refs/heads']);
  const gone = fr.code === 0 && lib.parseGoneBranches(fr.stdout).includes(branch);
  const mergedPr = gone ? null : await mergedPrFor(repo, branch);
  return lib.staleBranch({ branch, base, gone, mergedPr, openPrs });
}

// ---------- roadmap ----------
// Read from the remote base branch, not the working tree: a unit is done only once its PR is merged.
const roadmapCache = new Map();

async function roadmapState(repo) {
  if (!fs.existsSync(repo.path)) return { available: false, reason: 'no-repo' };
  const top = await git(repo.path, ['rev-parse', '--git-dir']);
  if (top.code !== 0) return { available: false, reason: 'no-repo' };
  const base = await baseBranchOf(repo);
  const file = repo.roadmap || 'docs/ROADMAP.md';
  const ref = `origin/${base}`;
  const rev = await git(repo.path, ['rev-parse', '--verify', '-q', `${ref}^{commit}`]);
  if (rev.code !== 0) return { available: false, reason: 'no-base', base, path: file };
  const sha = rev.stdout.trim();
  const key = `${repo.id}|${file}`;
  const hit = roadmapCache.get(key);
  if (hit && hit.sha === sha) return hit.data;
  const show = await git(repo.path, ['show', `${ref}:${file}`]);
  const data = show.code === 0
    ? { available: true, base, sha, path: file, ...lib.parseRoadmap(show.stdout) }
    : { available: false, reason: 'missing', base, path: file };
  roadmapCache.set(key, { sha, data });
  return data;
}

async function prState(repo) {
  if (!fs.existsSync(repo.path)) return { error: 'Folder not found' };
  let meta;
  try { meta = await repoMeta(repo); } catch (e) { return { error: e.message }; }
  if (meta.noRemote) return { noRemote: true, prs: [] };
  const r = await gh(repo.path, ['pr', 'list', '--state', 'open', '--limit', '50', '--json', PR_FIELDS]);
  if (r.code !== 0) return { repo: meta, error: firstLine(r.stderr) || 'gh pr list failed' };
  const prs = JSON.parse(r.stdout).map(lib.enrichPr);
  return { repo: meta, prs, stale: await staleState(repo, prs) };
}

async function viewPr(repo, number) {
  const r = await gh(repo.path, ['pr', 'view', String(number), '--json', `${PR_FIELDS},state`]);
  if (r.code !== 0) throw new HttpError(502, firstLine(r.stderr) || 'gh pr view failed');
  const j = JSON.parse(r.stdout);
  return { ...lib.enrichPr(j), state: j.state };
}

async function mergePr(repo, number, method, deleteBranch) {
  if (!['squash', 'merge', 'rebase'].includes(method)) throw new HttpError(400, 'Invalid merge method');
  if (!Number.isInteger(number)) throw new HttpError(400, 'Invalid PR number');
  const meta = await repoMeta(repo);
  if (meta.noRemote) throw new HttpError(400, 'Repository has no GitHub remote');
  const pr = await viewPr(repo, number);
  if (pr.state !== 'OPEN') throw new HttpError(409, `PR is ${pr.state}`);
  if (!pr.ready) throw new HttpError(409, `Not ready to merge: ${pr.blockedReason}`);

  // Merge through the API so the local working tree and branches are never touched.
  const m = await gh(repo.path, [
    'api', '-X', 'PUT', `repos/${meta.slug}/pulls/${number}/merge`,
    '-f', `merge_method=${method}`, '-f', `sha=${pr.headOid}`,
  ]);
  if (m.code !== 0) {
    const after = await viewPr(repo, number).catch(() => null);
    if (!after || after.state !== 'MERGED') throw new HttpError(502, ghError(m));
  }

  // Branch cleanup: skip when the repo already deletes branches, or the head lives in a fork.
  let branch = 'kept';
  if (meta.deleteBranchOnMerge) branch = 'auto';
  else if (deleteBranch && !pr.isCrossRepository) {
    const d = await gh(repo.path, ['api', '-X', 'DELETE', `repos/${meta.slug}/git/refs/heads/${lib.encodeRef(pr.head)}`]);
    branch = d.code === 0 || /reference does not exist/i.test(d.stdout + d.stderr) ? 'deleted' : 'kept';
  }
  return { merged: true, branch };
}

async function rerunFailed(repo, number) {
  const pr = await viewPr(repo, number);
  const ids = pr.checks.failedRuns;
  if (!ids.length) throw new HttpError(409, 'No failed GitHub Actions runs to re-run');
  let ok = 0;
  const errors = [];
  for (const id of ids) {
    const r = await gh(repo.path, ['run', 'rerun', id, '--failed']);
    if (r.code === 0) ok++; else errors.push(firstLine(r.stderr));
  }
  if (!ok) throw new HttpError(502, errors[0] || 'Re-run failed');
  return { rerun: ok };
}

// ---------- repo management ----------
const UNSAFE_PATH = /["&^%`<>|]/;

async function addRepo(rawPath, group) {
  if (!rawPath || !path.isAbsolute(rawPath)) throw new HttpError(400, 'Use an absolute folder path');
  group = (group || '').trim() || 'Default';
  const top = await git(rawPath, ['rev-parse', '--show-toplevel']);
  if (top.code !== 0) throw new HttpError(400, 'Not a git repository');
  const repoPath = path.resolve(top.stdout.trim());
  if (UNSAFE_PATH.test(repoPath)) throw new HttpError(400, 'Path contains unsupported characters');
  const cfg = loadConfig();
  const id = lib.repoId(repoPath);
  if (cfg.groups.some((g) => g.repos.some((r) => lib.repoId(r.path) === id))) throw new HttpError(409, 'Repository already added');
  let g = cfg.groups.find((x) => x.name === group);
  if (!g) { g = { name: group, repos: [] }; cfg.groups.push(g); }
  g.repos.push({ path: repoPath });
  saveConfig(cfg);
  return { id, path: repoPath, group };
}

function removeRepo(id) {
  const cfg = loadConfig();
  for (const g of cfg.groups) g.repos = g.repos.filter((r) => lib.repoId(r.path) !== id);
  cfg.groups = cfg.groups.filter((g) => g.repos.length);
  cfg.snoozed = cfg.snoozed.filter((k) => !k.startsWith(`${id}:`));
  saveConfig(cfg);
  metaCache.delete(id);
}

// A key ends in ":ready" when the PR was already ready at snooze time, so it is never auto-woken.
function setSnoozed(id, number, on, wasReady) {
  findRepo(id);
  if (!Number.isInteger(number) || number < 1) throw new HttpError(400, 'Invalid PR number');
  const key = `${id}:${number}`;
  const cfg = loadConfig();
  const rest = cfg.snoozed.filter((k) => k !== key && k !== `${key}:ready`);
  cfg.snoozed = on ? [...rest, wasReady ? `${key}:ready` : key] : rest;
  saveConfig(cfg);
  return { snoozed: cfg.snoozed };
}

function scanFolder(dir) {
  if (!dir || !path.isAbsolute(dir) || !fs.existsSync(dir)) throw new HttpError(400, 'Folder not found');
  const known = new Set(loadConfig().groups.flatMap((g) => g.repos.map((r) => lib.repoId(r.path))));
  const isRepo = (p) => fs.existsSync(path.join(p, '.git'));
  const dirs = isRepo(dir) ? [dir] : fs.readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory()).map((e) => path.join(dir, e.name)).filter(isRepo);
  return dirs.slice(0, 200).map((p) => ({ path: p, added: known.has(lib.repoId(p)) }));
}

function openEditor(repo, editor) {
  if (UNSAFE_PATH.test(repo.path)) throw new HttpError(400, 'Path contains unsupported characters');
  spawn(`${editor} "${repo.path}"`, { shell: true, detached: true, stdio: 'ignore', windowsHide: true }).unref();
}

// ---------- HTTP ----------
const query = (u) => Object.fromEntries(new URL(u, 'http://x').searchParams);

const routes = {
  'GET /api/config': () => {
    const cfg = loadConfig();
    return {
      editor: cfg.editor,
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
  'POST /api/editor': (q, b) => { openEditor(findRepo(b.id), loadConfig().editor); return { ok: true }; },
  'POST /api/snooze': (q, b) => setSnoozed(b.id, Number(b.number), !!b.on, !!b.wasReady),
  'POST /api/repos': (q, b) => addRepo(b.path, b.group),
  'POST /api/repos/remove': (q, b) => { removeRepo(b.id); return { ok: true }; },
  'GET /api/scan': (q) => ({ repos: scanFolder(q.dir) }),
};

const STATIC = {
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
      if (req.method === 'GET' && pathname === '/health') return send(res, 200, { app: 'repo-panel' });
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

if (require.main === module) {
  const { port } = loadConfig();
  const server = createServer(port);
  server.on('error', async (e) => {
    if (e.code !== 'EADDRINUSE') { console.error(e.message); process.exit(1); }
    // The URL must stay stable, so never fall back to another port.
    if (await isPanelRunning(port)) {
      console.log(`repo-panel is already running at http://127.0.0.1:${port}/`);
      process.exit(0);
    }
    console.error(`Port ${port} is used by another program. Free it or change "port" in config.json.`);
    process.exit(1);
  });
  server.listen(port, '127.0.0.1', () => {
    const url = `http://127.0.0.1:${port}/`;
    console.log(`repo-panel running at ${url}`);
    if (process.argv.includes('--open')) spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  });
}

module.exports = { createServer };
