'use strict';
// RPC3a (S3): the data layer of the page (the request pool, the config and the per-repo reads) lives in public/data.js, which index.html loads before
// app.js and the server serves. data.js shares the global scope with app.js (like view.js and resumen.js), so it may use S, V, R and draw only when a
// function is called, never while it loads. What moved stays out of app.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { PUBLIC, APP_FILES, appSource } = require('./pagesrc.js');

const read = (f) => fs.readFileSync(path.join(PUBLIC, f), 'utf8');
const MOVED = ['api', 'pooled', 'pump', 'toast', 'allRepos', 'loadConfig', 'track', 'touchSummary', 'setFact', 'loadLocal', 'rpcSession', 'sessionOf', 'loadPrs',
  'mergeHeld', 'releaseMerged', 'busyView', 'markAsked', 'stamp', 'refreshRepo', 'loadRequirements', 'loadState', 'loadPiStatus'];
const defines = (src, name) => new RegExp(`^(async function ${name}\\b|function ${name}\\b|const ${name} =|let ${name}\\b)`, 'm').test(src);

test('data.js defines the whole data layer and app.js defines none of it', () => {
  const data = read('data.js');
  for (const n of MOVED) assert.equal(defines(data, n), true, `data.js defines ${n}`);
  const app = read('app.js');
  for (const n of MOVED) assert.equal(defines(app, n), false, `app.js no longer defines ${n}`);
  for (const n of ['S', 'TOKEN', 'paint', 'draw']) assert.equal(defines(app, n), true, `app.js keeps ${n}`);
});

test('the page list is the one index.html loads, in order, after view.js and resumen.js', () => {
  const html = read('index.html');
  const scripts = [...html.matchAll(/<script src="([^"]+)"><\/script>/g)].map((m) => m[1]);
  assert.deepEqual(scripts, ['/view.js', '/resumen.js', ...APP_FILES.map((f) => `/${f}`)]);
});

test('data.js loads on its own, before app.js, without touching S, V, R or the DOM', () => {
  const ctx = vm.createContext({ console, window: {}, document: new Proxy({}, { get: () => { throw new Error('data.js touched the document while loading'); } }) });
  ctx.window = ctx;
  assert.doesNotThrow(() => vm.runInContext(read('data.js'), ctx));
  for (const n of ['api', 'pooled', 'refreshRepo', 'loadPiStatus']) assert.equal(vm.runInContext(`typeof ${n}`, ctx), 'function', n);
});

test('the page text is data.js then app.js, and the server serves every one of them as JavaScript', async () => {
  const src = appSource();
  const at = src.indexOf('async function api(');
  assert.ok(at >= 0 && at < src.indexOf('const S = {'), 'the text of data.js comes first');
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'rpc3a-'));
  process.env.REPO_PANEL_CONFIG = path.join(scratch, 'config.json');
  fs.writeFileSync(process.env.REPO_PANEL_CONFIG, JSON.stringify({ groups: [] }));
  const { createServer } = require('../server/http.js');
  const port = await new Promise((resolve) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const { port: p } = s.address(); s.close(() => resolve(p)); }); });
  const server = createServer(port, { noSummaryStore: true });
  await new Promise((resolve) => { server.listen(port, '127.0.0.1', resolve); });
  try {
    for (const f of APP_FILES) {
      const res = await new Promise((resolve, reject) => { http.get({ host: '127.0.0.1', port, path: `/${f}` }, (r) => { let b = ''; r.on('data', (d) => { b += d; }); r.on('end', () => resolve({ status: r.statusCode, type: r.headers['content-type'], body: b })); }).on('error', reject); });
      assert.equal(res.status, 200, f);
      assert.match(res.type, /javascript/, f);
      assert.equal(res.body, read(f), f);
    }
  } finally {
    await new Promise((resolve) => { server.close(resolve); server.closeAllConnections?.(); });
    fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 5 });
  }
});
