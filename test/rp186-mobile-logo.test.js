'use strict';
// RP186: the header shows the K with the blue dot in the corner on a narrow screen (under the narrow cut of the page, 760 px: the phone) and keeps the big logo from
// there up. One <picture>: the <source> with the media of the cut holds the K and the <img> keeps the logo and its alt, so a browser with no <picture> still shows the logo.
// K-icon.svg is served behind the login of the remote host: the header is painted after the login, with the cookie. Real http server on an ephemeral port, temp config.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'rp186-'));
const configFile = path.join(scratch, 'config.json');
process.env.REPO_PANEL_CONFIG = configFile;
const HOST = 'pc.tail1234.ts.net';
const KEY = 'correct-horse-battery-staple-1234';
const writeConfig = (extra = {}) => fs.writeFileSync(configFile, JSON.stringify({ port: 4310, groups: [], rooms: [], ...extra }));
writeConfig();
test.after(() => fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 5 }));

const ROOT = path.join(__dirname, '..');
const { createServer } = require('../server/http.js');
const V = require('../public/view.js');
const text = (f) => fs.readFileSync(path.join(ROOT, 'public', f), 'utf8').replace(/\r\n/g, '\n');

const MARKUP = /<h1><picture><source media="\(max-width: ([\d.]+)px\)" srcset="\/K-icon\.svg"><img src="\/kletus-dev\.svg" alt="Kletus\.dev"><\/picture><\/h1>/;

test('the header has one h1 with a picture: the K below the cut, and the img keeps the big logo and its alternative text', () => {
  const html = text('index.html');
  assert.match(html, MARKUP);
  assert.equal((html.match(/<h1>/g) || []).length, 1, 'still one h1');
  assert.equal((html.match(/<img\b/g) || []).filter((i) => i).length, 1, 'one image in the whole page header: the picture does not add a second one');
});

test('the cut of the K is the narrow cut of the page: every width under NARROW_BELOW shows it, from there up it does not', () => {
  const max = Number(MARKUP.exec(text('index.html'))[1]);
  assert.equal(V.NARROW_BELOW, 760);
  assert.ok(max < V.NARROW_BELOW && max >= V.NARROW_BELOW - 0.5, `a max-width just under the cut (${max})`);
  for (const w of [320, 360, 390, 430, 600, 759, 759.5]) assert.equal(w <= max && V.bandOf(w) === 'narrow', true, `${w} shows the K`);
  for (const w of [760, 761, 800, 1024, 1100, 1440]) assert.equal(w <= max || V.bandOf(w) === 'narrow', false, `${w} shows the big logo`);
  for (const w of [320, 390, 759, 760, 800, 1440]) assert.equal(w <= max, V.bandOf(w) === 'narrow', `the media and the page agree at ${w}`);
});

test('the picture does not add space around the image: it is a block and the image keeps its height', () => {
  const css = text('style.css');
  assert.match(css, /header h1 picture\s*\{[^}]*display:\s*block/);
  assert.match(css, /header h1 img\s*\{[^}]*display:\s*block;[^}]*height:\s*24px;[^}]*width:\s*auto/);
});

// ---------- the server ----------
const freePort = () => new Promise((resolve) => {
  const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
});
const call = (port, method, p, { headers = {}, body } = {}) => new Promise((resolve, reject) => {
  const data = body === undefined ? null : JSON.stringify(body);
  const req = http.request({ host: '127.0.0.1', port, path: p, method, agent: false, headers: { host: `127.0.0.1:${port}`, ...(data ? { 'content-type': 'application/json' } : {}), ...headers } }, (res) => {
    const chunks = [];
    res.on('data', (c) => chunks.push(c));
    res.on('end', () => resolve({ status: res.statusCode, type: res.headers['content-type'] || '', headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
  });
  req.on('error', reject);
  req.end(data);
});
async function withServer(fn) {
  const port = await freePort();
  const server = createServer(port, { noSummaryStore: true });
  await new Promise((r) => server.listen(port, '127.0.0.1', r));
  try { await fn(port); } finally { server.close(); server.closeAllConnections(); }
}

test('both images of the header are served as SVG, and the K is the file of the person', async () => {
  writeConfig();
  await withServer(async (port) => {
    for (const f of ['K-icon.svg', 'kletus-dev.svg']) {
      const r = await call(port, 'GET', `/${f}`);
      assert.equal(r.status, 200, f);
      assert.match(r.type, /^image\/svg\+xml/, f);
      assert.equal(r.body.replace(/\r\n/g, '\n'), text(f), f);
    }
    assert.match(text('K-icon.svg'), /fill="#007FFF"/, 'the K with the blue dot');
  });
});

test('on the remote host the K comes with the login, as the header does: no cookie 401, with the cookie 200', async () => {
  writeConfig({ remote: { host: HOST, secret: KEY } });
  await withServer(async (port) => {
    const remote = (m, p, o = {}) => call(port, m, p, { ...o, headers: { host: HOST, ...(o.headers || {}) } });
    assert.equal((await remote('GET', '/K-icon.svg')).status, 401);
    const login = await remote('POST', '/login', { body: { secret: KEY } });
    const cookie = login.headers['set-cookie'][0].split(';')[0];
    const k = await remote('GET', '/K-icon.svg', { headers: { cookie } });
    assert.equal(k.status, 200);
    assert.match(k.type, /^image\/svg\+xml/);
    assert.equal((await remote('GET', '/', { headers: { cookie } })).status, 200, 'and the page that holds the picture');
  });
  writeConfig();
});

test('the README says what the header shows and where the cut is', () => {
  const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
  assert.match(readme, /RP186/);
  assert.match(readme, /K-icon\.svg[^.]*header|header[^.]*K-icon\.svg/i);
  assert.match(readme, /760 px/);
});
