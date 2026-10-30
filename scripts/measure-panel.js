'use strict';
// Measures how fast the panel answers, on an ISOLATED temporary panel (a copy of config.json on its own port, no browser polling it), so the
// numbers are the cost of the routes and not the noise of an open page. GET routes only: it never calls an action route and never sends
// anything to a session.   node scripts/measure-panel.js [--port 4398] [--json]
// Reports: the Summary in frio and after its cache, each per-repo route, a full refresh (5 calls x every repo, all at once, like the page),
// and the wait of an interactive read issued 300 ms after that refresh started (what a click suffers behind the automatic work).
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const args = process.argv.slice(2);
const flag = (n, d) => { const i = args.indexOf(n); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const PORT = Number(flag('--port', 4398));
const JSON_OUT = args.includes('--json');
const BASE = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ms = (t0) => Math.round(Number(process.hrtime.bigint() - t0) / 1e6);
const stats = (a) => { const s = [...a].sort((x, y) => x - y); return { n: s.length, min: s[0], med: s[Math.floor(s.length / 2)], max: s[s.length - 1] }; };
let TOKEN = null;
const get = async (url, extra = {}, timing = null) => {
  const t0 = process.hrtime.bigint();
  const r = await fetch(BASE + url, { headers: { 'x-token': TOKEN, ...extra } });
  await r.text();
  if (timing) timing.header = r.headers.get('server-timing'); // the server's own account: total and the wait for a process slot
  return ms(t0);
};

async function main() {
  const lib = require(path.join(ROOT, 'lib.js'));
  const source = process.env.REPO_PANEL_CONFIG || path.join(ROOT, 'config.json');
  const cfg = { ...JSON.parse(fs.readFileSync(source, 'utf8')), port: PORT };
  const ids = cfg.groups.flatMap((g) => g.repos.map((r) => lib.repoId(typeof r === 'string' ? r : r.path)));
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'measure-'));
  const file = path.join(tmp, 'config.json');
  fs.writeFileSync(file, JSON.stringify(cfg, null, 2));
  const server = spawn(process.execPath, [path.join(ROOT, 'server.js')], { cwd: ROOT, env: { ...process.env, REPO_PANEL_CONFIG: file, REPO_PANEL_CASES_FILE: 'off' }, stdio: 'ignore' });
  const stop = () => { try { server.kill(); } catch { /* already gone */ } };
  process.on('exit', stop);
  const out = { repos: ids.length };
  try {
    for (let i = 0; i < 60; i++) { try { await fetch(`${BASE}/health`); break; } catch { await sleep(300); } }
    TOKEN = (/name="token" content="([^"]+)"/.exec(await (await fetch(`${BASE}/`)).text()) || [])[1];
    await sleep(1500);
    out.summaryCold = await get('/api/summary');
    out.summaryCached = await get('/api/summary');
    await sleep(11000);
    out.summaryAfterExpiry = await get('/api/summary');
    out.routes = {};
    const sample = ids.slice(0, 5);
    for (const route of ['local', 'prs', 'roadmap', 'requirements', 'state', 'pi-status', 'sessions', 'chat']) {
      const t = [];
      for (const id of sample) t.push(await get(`/api/${route}?id=${id}`));
      out.routes[route] = stats(t);
    }
    // A full refresh and, 300 ms after it started, the read an interactive action would need (the session state of one repo).
    const t0 = process.hrtime.bigint();
    const all = [];
    for (const id of ids) for (const route of ['local', 'prs', 'roadmap', 'requirements', 'state']) all.push(get(`/api/${route}?id=${id}`));
    await sleep(300);
    // The page marks what a click needs with x-priority: user (older panels ignore the header).
    const timing = {};
    const interactive = get(`/api/pi-status?id=${ids[0]}`, { 'x-priority': 'user' }, timing);
    const [wait, times] = [await interactive, await Promise.all(all)];
    out.fullRefresh = { wallMs: ms(t0), perCall: stats(times) };
    out.interactiveDuringRefreshMs = wait;
    const queue = /queue;dur=(\d+)/.exec(timing.header || '');
    out.interactiveQueueMs = queue ? Number(queue[1]) : 0; // time that read waited for a process slot (0 when none was needed)
    const t1 = process.hrtime.bigint();
    await Promise.all(ids.map((id) => get(`/api/local?id=${id}`)));
    out.localAllAtOnceMs = ms(t1);
    try { out.perf = await (await fetch(`${BASE}/api/perf`, { headers: { 'x-token': TOKEN } })).json(); } catch { /* older panels have no /api/perf */ }
  } finally { stop(); }
  if (JSON_OUT) { console.log(JSON.stringify(out, null, 2)); return; }
  console.log(`isolated panel, ${out.repos} repos`);
  console.log(`summary: cold ${out.summaryCold} ms | cached ${out.summaryCached} ms | after its cache expired ${out.summaryAfterExpiry} ms`);
  for (const [r, s] of Object.entries(out.routes)) console.log(`  /api/${r}`.padEnd(20), `min ${s.min} | median ${s.med} | max ${s.max} ms`);
  console.log(`full refresh (${out.repos * 5} calls at once): wall ${out.fullRefresh.wallMs} ms | per call median ${out.fullRefresh.perCall.med} ms, max ${out.fullRefresh.perCall.max} ms`);
  console.log(`an interactive read issued 300 ms after the refresh started waited: ${out.interactiveDuringRefreshMs} ms (of which waiting for a process slot: ${out.interactiveQueueMs} ms)`);
  console.log(`${out.repos} x /api/local at once: ${out.localAllAtOnceMs} ms`);
}
main().then(() => process.exit(0), (e) => { console.error('FAILED', e.message); process.exit(1); });
