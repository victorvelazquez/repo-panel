'use strict';
// RP201 (S2): the page warns when the server runs OLDER code than the files on disk. A server loads its code when it starts and never notices that the disk changed: on 14 November /K-icon.svg answered 404
// and the tray icon did not change, both for that reason. At start the server keeps a FINGERPRINT of the content of the files it has loaded (server.js, lib.js, checks.js and server/*.js; the files of public/
// are read on every request and never make it old); when the fingerprint of NOW is another one, GET /api/server-state answers { stale: true } and the page shows a notice. The content is measured, not the date,
// so changing branch without a change of content never warns (a change and its undo neither), and line endings do not count. It only INFORMS: the person restarts the panel (a button of Settings that
// restarted it from the phone was discarded: it could leave the person with no way in). The answer is ONE boolean: the fingerprint itself is never sent. How it LOOKS is for the person to try.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { appSource } = require('./pagesrc.js');
const V = require('../public/view.js');
const R = require('../public/resumen.js');

const ROOT = path.join(__dirname, '..');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'rp201-'));
const configFile = path.join(scratch, 'config.json');
process.env.REPO_PANEL_CONFIG = configFile;
fs.writeFileSync(configFile, JSON.stringify({ port: 4310, groups: [], rooms: [] }));
test.after(() => fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 5 }));

const { codeFiles, fingerprint, createCodeWatch } = require('../server/codewatch.js');
const { createServer } = require('../server/http.js');

// A small copy of the shape of the repo: the root js files, server/*.js and things that are NOT code of the server.
function tree(files) {
  const dir = fs.mkdtempSync(path.join(scratch, 'tree-'));
  for (const [rel, text] of Object.entries(files)) {
    const f = path.join(dir, rel);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, text);
  }
  return dir;
}
const BASE = { 'server.js': 'a', 'lib.js': 'b', 'checks.js': 'c', 'server/http.js': 'd', 'server/x.js': 'e', 'public/app.js': 'page', 'test/t.test.js': 'test', 'package.json': '{}', 'config.json': '{}', 'README.md': 'doc' };

// ---------- the files that count ----------
test('c1: the files of the server are the root *.js and server/*.js, sorted; the page, the tests, the docs, the config and the folders inside server/ are not', () => {
  const dir = tree({ ...BASE, 'server/deep/y.js': 'deep', 'server/notes.txt': 'x', 'node_modules/m/index.js': 'm', 'server/folder.js/inner.txt': 'a folder whose name ends in .js is not a file' });
  assert.deepEqual(codeFiles(dir), ['checks.js', 'lib.js', 'server.js', 'server/http.js', 'server/x.js']);
});

test('c2: in this repo the list has the server and its modules, and nothing of the page', () => {
  const files = codeFiles(ROOT);
  for (const f of ['server.js', 'lib.js', 'checks.js', 'server/http.js', 'server/codewatch.js', 'server/summarystore.js']) assert.ok(files.includes(f), f);
  assert.ok(!files.some((f) => f.startsWith('public/') || f.startsWith('test/') || f.startsWith('docs/')));
  assert.ok(files.length >= 30, `${files.length} files`);
});

// ---------- the fingerprint ----------
test('f1: the fingerprint is a sha-256 in hex, the same for the same content, and the same twice in a row', () => {
  const dir = tree(BASE);
  assert.match(fingerprint(dir), /^[0-9a-f]{64}$/);
  assert.equal(fingerprint(dir), fingerprint(dir));
  assert.equal(fingerprint(tree(BASE)), fingerprint(dir), 'another folder with the same files: the same fingerprint');
});

test('f2: it changes when the content of a file of the server changes (one byte is enough), when a file is added and when one is removed', () => {
  const dir = tree(BASE);
  const before = fingerprint(dir);
  fs.writeFileSync(path.join(dir, 'server/x.js'), 'f');
  const edited = fingerprint(dir);
  assert.notEqual(edited, before, 'edited');
  fs.writeFileSync(path.join(dir, 'server/new.js'), 'n');
  const added = fingerprint(dir);
  assert.notEqual(added, edited, 'added');
  fs.rmSync(path.join(dir, 'server/new.js'));
  assert.equal(fingerprint(dir), edited, 'removed again: the fingerprint of before the file');
  fs.rmSync(path.join(dir, 'lib.js'));
  assert.notEqual(fingerprint(dir), edited, 'a file removed');
});

test('f3: a file that is renamed changes it, and the same content split in another way between two files changes it too', () => {
  const a = fingerprint(tree({ 'server.js': 'ab', 'lib.js': '' }));
  const b = fingerprint(tree({ 'server.js': 'a', 'lib.js': 'b' }));
  assert.notEqual(a, b, 'the same letters in another place are another code');
  const c = fingerprint(tree({ 'server.js': 'a', 'checks.js': 'b' }));
  assert.notEqual(b, c, 'the same content under another name');
});

test('f4: it does not change with what is not code of the server: the page, the tests, the docs, the config, and it ignores line endings (a checkout with CRLF is the same code)', () => {
  const dir = tree(BASE);
  const before = fingerprint(dir);
  for (const f of ['public/app.js', 'test/t.test.js', 'README.md', 'config.json', 'package.json']) fs.writeFileSync(path.join(dir, f), 'changed');
  assert.equal(fingerprint(dir), before);
  const lf = tree({ ...BASE, 'server/x.js': 'one\ntwo\n' });
  const crlf = tree({ ...BASE, 'server/x.js': 'one\r\ntwo\r\n' });
  assert.equal(fingerprint(crlf), fingerprint(lf));
});

// ---------- the watch ----------
function watchOf(dir, extra = {}) {
  let t = 1000;
  const reads = { dir: 0, file: 0 };
  const watch = createCodeWatch({
    root: dir, ttlMs: 30000, now: () => t,
    readdir: (...a) => { reads.dir += 1; return fs.readdirSync(...a); },
    readFile: (...a) => { reads.file += 1; return fs.readFileSync(...a); },
    ...extra,
  });
  return { watch, reads, at: (ms) => { t = ms; } };
}

test('w1: a server that has not seen a change is not stale, and the answer is a plain boolean', () => {
  const { watch } = watchOf(tree(BASE));
  assert.equal(watch.stale(), false);
  assert.equal(typeof watch.stale(), 'boolean');
});

test('w2: after the code on disk changes the server is stale, once the minute of the answer has gone; right before that it still says what it said', () => {
  const dir = tree(BASE);
  const { watch, at } = watchOf(dir);
  fs.writeFileSync(path.join(dir, 'server/http.js'), 'a new version');
  at(1000 + 29999);
  assert.equal(watch.stale(), false, 'inside the time of the answer nothing is read again');
  at(1000 + 30000);
  assert.equal(watch.stale(), true);
});

test('w3: a change and its undo is not stale (changing branch and coming back): the content is the same as at the start', () => {
  const dir = tree(BASE);
  const { watch, at } = watchOf(dir);
  const original = fs.readFileSync(path.join(dir, 'server/http.js'), 'utf8');
  fs.writeFileSync(path.join(dir, 'server/http.js'), 'other branch');
  at(1000 + 30000);
  assert.equal(watch.stale(), true);
  fs.writeFileSync(path.join(dir, 'server/http.js'), original);
  at(1000 + 60000);
  assert.equal(watch.stale(), false);
});

test('w4: a file that is only touched (the date changes, the content does not) is not stale; a file added or removed is', () => {
  const dir = tree(BASE);
  const { watch, at } = watchOf(dir);
  const f = path.join(dir, 'server/x.js');
  fs.utimesSync(f, new Date(2030, 0, 1), new Date(2030, 0, 1));
  at(1000 + 30000);
  assert.equal(watch.stale(), false, 'the date is not what is measured');
  fs.writeFileSync(path.join(dir, 'server/added.js'), 'x');
  at(1000 + 60000);
  assert.equal(watch.stale(), true, 'added');
  fs.rmSync(path.join(dir, 'server/added.js'));
  fs.rmSync(path.join(dir, 'server/x.js'));
  at(1000 + 90000);
  assert.equal(watch.stale(), true, 'removed');
});

test('w5: the files are read once at the start and then once per time of the answer, not once per question', () => {
  const dir = tree(BASE);
  const { watch, reads, at } = watchOf(dir);
  const atStart = reads.file;
  assert.equal(atStart, 5, 'the five files of the server were read at the start');
  for (let i = 0; i < 20; i++) { at(1000 + i * 1000); watch.stale(); }
  assert.equal(reads.file, atStart, 'twenty questions in 20 s read nothing');
  at(1000 + 30000);
  watch.stale();
  assert.equal(reads.file, atStart * 2, 'one new read after the time');
  at(1000 + 31000);
  watch.stale();
  at(1000 + 55000);
  watch.stale();
  assert.equal(reads.file, atStart * 2, 'and the time starts again from that read: the questions of the next 30 s read nothing');
  at(1000 + 60000);
  watch.stale();
  assert.equal(reads.file, atStart * 3, 'until the time has gone again');
});

test('w6: when the files cannot be read it never throws and never warns by mistake: at the start it is never stale, later it keeps its last answer', () => {
  const boom = () => { throw Object.assign(new Error('EACCES'), { code: 'EACCES' }); };
  const never = createCodeWatch({ root: tree(BASE), readdir: boom, now: () => 1 });
  assert.equal(never.stale(), false);
  const dir = tree(BASE);
  let fail = false;
  let t = 1000;
  const watch = createCodeWatch({ root: dir, ttlMs: 10, now: () => t, readFile: (...a) => { if (fail) boom(); return fs.readFileSync(...a); } });
  fs.writeFileSync(path.join(dir, 'server/x.js'), 'changed');
  t = 2000;
  assert.equal(watch.stale(), true);
  fail = true;
  t = 3000;
  assert.equal(watch.stale(), true, 'it could not read: it keeps saying what it knew');
  let broken = true;
  let u = 1000;
  const blind = createCodeWatch({ root: tree(BASE), ttlMs: 10, now: () => u, readdir: (...a) => { if (broken) boom(); return fs.readdirSync(...a); } });
  broken = false;
  u = 5000;
  assert.equal(blind.stale(), false, 'it started without a fingerprint, so it has nothing to compare with: being able to read later is not a change of code');
});

// ---------- the route ----------
const freePort = () => new Promise((resolve) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });
function call(port, p, { token, host = `127.0.0.1:${port}` } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: p, method: 'GET', headers: { host, ...(token ? { 'x-token': token } : {}) }, agent: false }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.end();
  });
}
async function withServer(deps, fn) {
  const port = await freePort();
  const server = createServer(port, deps);
  await new Promise((r) => server.listen(port, '127.0.0.1', r));
  const page = await call(port, '/');
  const token = /name="?token"? content="([0-9a-f]+)"/.exec(page.body)[1];
  try { await fn({ port, token }); } finally { try { server.closeAllConnections(); server.close(); } catch { /* closed */ } }
}

test('r1: with the token the route answers { stale: false } for a server that has not changed (the real watch of the repo)', async () => {
  await withServer({}, async ({ port, token }) => {
    const r = await call(port, '/api/server-state', { token });
    assert.equal(r.status, 200);
    assert.match(r.headers['content-type'], /application\/json/);
    assert.deepEqual(JSON.parse(r.body), { stale: false });
  });
});

test('r2: it answers { stale: true } when the watch says so, and the answer is ONE key: the fingerprint is never sent', async () => {
  await withServer({ codeWatch: { stale: () => true } }, async ({ port, token }) => {
    const r = await call(port, '/api/server-state', { token });
    assert.deepEqual(JSON.parse(r.body), { stale: true });
    assert.deepEqual(Object.keys(JSON.parse(r.body)), ['stale']);
    assert.doesNotMatch(r.body, /[0-9a-f]{40}/);
  });
});

test('r3: it is behind the token and the host check like every API route: no token 401, a wrong token 401, a foreign host 403', async () => {
  await withServer({ codeWatch: { stale: () => true } }, async ({ port, token }) => {
    assert.equal((await call(port, '/api/server-state')).status, 401);
    assert.equal((await call(port, '/api/server-state', { token: 'nope' })).status, 401);
    assert.equal((await call(port, '/api/server-state', { token, host: 'evil.example' })).status, 403);
  });
});

test('r4: it is NOT one of the routes that the remote host serves without the login: /health stays the only API-like one', () => {
  const src = fs.readFileSync(path.join(ROOT, 'server', 'http.js'), 'utf8');
  const open = /const OPEN_STATIC = new Set\(\[([^\]]*)\]\)/.exec(src)[1];
  assert.doesNotMatch(open, /server-state/);
  assert.match(src, /const denied = pathname === '\/health' \|\| \(req\.method === 'GET' && OPEN_STATIC\.has\(pathname\)\) \? null : refusal\(req, rem\);/);
});

test('r5: /health is the answer it was: { app, api } and nothing else (the tray and the page read it)', async () => {
  await withServer({}, async ({ port }) => {
    const r = await call(port, '/health');
    assert.deepEqual(Object.keys(JSON.parse(r.body)).sort(), ['api', 'app']);
    assert.equal(JSON.parse(r.body).app, 'repo-panel');
  });
});

test('r6: server.js builds the watch right after it has loaded its modules, so the fingerprint is the one of the code it runs', () => {
  const http = fs.readFileSync(path.join(ROOT, 'server', 'http.js'), 'utf8');
  assert.match(http, /require\('\.\/codewatch\.js'\)/);
  assert.match(http, /deps\.codeWatch\s*=\s*createCodeWatch\(\{ root: ROOT \}\)/);
  assert.match(http, /'GET \/api\/server-state': \(q, b, d\) => \(\{ stale: d\.codeWatch\.stale\(\) === true \}\)/);
});

// ---------- the page ----------
const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
const css = fs.readFileSync(path.join(ROOT, 'public', 'style.css'), 'utf8');

test('n1: the notice is in the page, hidden, says what happened and how to fix it, and looks like the other warning of the page', () => {
  const m = /<div id="stale"([^>]*)>([^<]*)<\/div>/.exec(html);
  assert.ok(m, 'a #stale notice');
  assert.match(m[1], /class="outdated"/);
  assert.match(m[1], /role="status"/);
  assert.match(m[1], /\bhidden\b/);
  assert.match(m[2], /older code/i);
  assert.match(m[2], /Restart panel/);
  assert.ok(html.indexOf('id="outdated"') < html.indexOf('id="stale"') && html.indexOf('id="stale"') < html.indexOf('id="stalled"'), 'between the two other notices');
  assert.match(css, /\.outdated\[hidden\]/);
});

function element(extra = {}) {
  const el = {
    html: '', hidden: false, dataset: {}, disabled: false, value: '', checked: false, textContent: '', title: '', attrs: {}, children: [], writes: 0,
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false }, style: { setProperty() {} }, addEventListener() {}, setAttribute() {}, querySelector: () => null, querySelectorAll: () => [], closest: () => null,
    showModal() {}, close() {}, focus() {}, append() {}, get innerHTML() { return el.html; }, set innerHTML(v) { el.html = String(v); el.writes++; }, ...extra,
  };
  return el;
}
async function boot({ health = { app: 'repo-panel', api: V.API_VERSION }, state = { stale: false } } = {}) {
  const frames = [];
  const fetches = [];
  const els = {};
  const answers = { health, state };
  const tabEls = ['summary', 'work', 'conformity'].map((t) => element({ dataset: { tab: t } }));
  const get = (sel) => (els[sel] ||= (sel === 'meta[name=token]' ? element({ content: 'token' }) : element()));
  const doc = { hidden: false, querySelector: get, querySelectorAll: (s) => (String(s).includes('data-tab') ? tabEls : []), addEventListener() {}, createElement: () => element(), body: element(), activeElement: null };
  const reply = (v) => (v instanceof Error ? Promise.reject(v) : v && v.status ? Promise.resolve({ ok: false, status: v.status, statusText: 'x', json: async () => ({ error: 'nope' }) }) : Promise.resolve({ ok: true, json: async () => v }));
  const ctx = vm.createContext({
    console, document: doc, location: { hash: '' }, localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    requestAnimationFrame: (cb) => { frames.push(cb); return frames.length; }, setInterval: () => 1, setTimeout: () => 0, clearTimeout: () => {}, AbortController, confirm: () => true,
    fetch: (url) => {
      fetches.push(String(url));
      if (String(url) === '/health') return reply(answers.health);
      if (String(url) === '/api/server-state') return reply(answers.state);
      return new Promise(() => {});
    },
  });
  ctx.window = ctx; ctx.addEventListener = () => {}; ctx.RepoPanelView = V; ctx.RepoPanelResumen = R;
  vm.runInContext(appSource(), ctx);
  const tick = async (n = 20) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); while (frames.length) frames.shift()(); };
  await tick();
  return { get, fetches, answers, tick, run: (c) => vm.runInContext(c, ctx), check: async () => { await vm.runInContext('checkHealth()', ctx); await tick(); } };
}

test('n2: a server that says it is stale shows the notice; one that does not, hides it', async () => {
  const stale = await boot({ state: { stale: true } });
  await stale.check();
  assert.equal(stale.get('#stale').hidden, false);
  const fresh = await boot({ state: { stale: false } });
  await fresh.check();
  assert.equal(fresh.get('#stale').hidden, true);
});

test('n3: it goes away on its own when the server is restarted (the next check says stale false)', async () => {
  const page = await boot({ state: { stale: true } });
  await page.check();
  assert.equal(page.get('#stale').hidden, false);
  page.answers.state = { stale: false };
  await page.check();
  assert.equal(page.get('#stale').hidden, true);
});

test('n4: nothing to say when the question fails: no answer, a server that does not know the route (404), or an answer that is not { stale: true }', async () => {
  for (const state of [new Error('down'), { status: 404 }, {}, { stale: 'true' }, { stale: 1 }, null]) {
    const page = await boot({ state });
    await page.check();
    assert.equal(page.get('#stale').hidden, true, JSON.stringify(state && state.status ? state.status : String(state)));
  }
});

test('n5: the other warning is the one it was: an API version that does not match shows #outdated and says nothing about #stale', async () => {
  const old = await boot({ health: { app: 'repo-panel' }, state: { stale: false } });
  await old.check();
  assert.equal(old.get('#outdated').hidden, false);
  assert.equal(old.get('#stale').hidden, true);
  const both = await boot({ health: { app: 'repo-panel' }, state: { stale: true } });
  await both.check();
  assert.equal(both.get('#outdated').hidden, false);
  assert.equal(both.get('#stale').hidden, false, 'each notice follows its own fact');
  const fine = await boot();
  await fine.check();
  assert.equal(fine.get('#outdated').hidden, true);
});

test('n6: every refresh asks both questions, so a notice shows (and goes away) without reloading the page', async () => {
  const page = await boot();
  const before = page.fetches.filter((u) => u === '/api/server-state').length;
  page.run('refreshAll()');
  await page.tick();
  assert.ok(page.fetches.filter((u) => u === '/api/server-state').length > before, 'refreshAll asked the state of the server');
  assert.ok(page.fetches.includes('/health'));
});

test('n7: the README says what the notice means, how the fingerprint is measured and that it only informs', () => {
  const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
  assert.match(readme, /RP201/);
  assert.match(readme, /GET \/api\/server-state/);
  assert.match(readme, /fingerprint/i);
  assert.match(readme, /only informs|does not restart/i);
});
