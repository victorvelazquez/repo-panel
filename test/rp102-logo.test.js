'use strict';
// RP102: the person's logo (Kletus.dev, an SVG) replaces the word "Repo Panel" in the header, and the tab icon is the K of that logo, white on a dark square. The K is
// not redrawn: it is the first sub-path of the white path of the logo (straight lines only), reused as it is. The tab title stays "Repo Panel".
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'rp102-'));
process.env.REPO_PANEL_CONFIG = path.join(scratch, 'config.json');
test.after(() => fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 5 }));
const { createServer } = require('../server/http.js');

const PUBLIC = path.join(__dirname, '..', 'public');
const raw = (f) => fs.readFileSync(path.join(PUBLIC, f));
const read = (f) => raw(f).toString('utf8').replace(/\r\n/g, '\n');
const rule = (css, sel) => {
  const m = new RegExp(`(?:^|\\n)${sel.replace(/\./g, '\\.')}\\s*\\{([^}]*)\\}`).exec(css);
  return m ? m[1] : null;
};
const freePort = () => new Promise((resolve) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });
const get = (port, p) => new Promise((resolve, reject) => {
  http.get({ host: '127.0.0.1', port, path: p }, (res) => { let d = ''; res.on('data', (c) => { d += c; }); res.on('end', () => resolve({ status: res.statusCode, type: res.headers['content-type'], body: d })); }).on('error', reject);
});
async function withServer(fn) {
  const port = await freePort();
  const server = createServer(port, { noSummaryStore: true });
  await new Promise((r) => server.listen(port, '127.0.0.1', r));
  try { await fn(port); } finally { await new Promise((r) => server.close(r)); }
}
// The K: the first sub-path of the path filled with the near-white of the logo.
const logoK = () => {
  const m = /<path d="([^"]+)" fill="#FAFBFC"\/>/.exec(read('kletus-dev.svg'));
  assert.ok(m, 'the logo has a white path');
  return m[1].split(/(?=M)/)[0];
};

test('t1: the server serves the logo and the icon as SVG images, with no token (like the other static files)', async () => {
  await withServer(async (port) => {
    for (const f of ['kletus-dev.svg', 'icon.svg']) {
      const r = await get(port, `/${f}`);
      assert.equal(r.status, 200, f);
      assert.match(r.type, /^image\/svg\+xml/, f);
      assert.equal(r.body.replace(/\r\n/g, '\n'), read(f), `${f} is served as it is`);
      assert.match(r.body, /^<svg\b/, f);
    }
  });
});

test('t2: the logo is the person\'s file, unchanged: same size, the white text and the blue .dev', () => {
  const svg = read('kletus-dev.svg');
  assert.match(svg, /viewBox="0 0 760 116"/);
  assert.equal((svg.match(/<path\b/g) || []).length, 2);
  assert.match(svg, /fill="#FAFBFC"/);
  assert.match(svg, /fill="#007FFF"/);
});

test('t3: the K of the icon is the K of the logo, exactly (the same path data, white), on a dark square', () => {
  const icon = read('icon.svg');
  const k = logoK();
  assert.match(k, /^M3\.8147e-06 113\.55V1\.80004H14\.7V64\.65/, 'it is the K (the first sub-path), not another letter');
  assert.ok(icon.includes(`d="${k}"`), 'the icon uses the K path data of the logo untouched');
  assert.match(icon, /<path\b[^>]*fill="#FAFBFC"/, 'the K is white');
  assert.match(icon, /<rect\b[^>]*fill="#0f1216"/, 'on the dark of the panel');
  assert.match(icon, /<svg\b[^>]*viewBox="0 0 64 64"/, 'a square');
});

test('t4: the K sits inside the square with room around it (no clipped corner)', () => {
  const icon = read('icon.svg');
  const t = /transform="translate\(([\d.]+)[ ,]+([\d.]+)\) scale\(([\d.]+)\)"/.exec(icon);
  assert.ok(t, 'the K is placed with translate and scale');
  const [x, y, s] = [Number(t[1]), Number(t[2]), Number(t[3])];
  // The K spans x 0 to 85.2 and y 1.8 to 113.55 in the logo.
  const [left, right, top, bottom] = [x, x + 85.2 * s, y + 1.8 * s, y + 113.55 * s];
  for (const v of [left, top]) assert.ok(v >= 8, `at least 8 of 64 from the top and left edge (${v})`);
  for (const v of [right, bottom]) assert.ok(v <= 56, `at least 8 of 64 from the bottom and right edge (${v})`);
  assert.ok(Math.abs((left + right) / 2 - 32) < 1.5, 'centered across');
  assert.ok(Math.abs((top + bottom) / 2 - 32) < 1.5, 'centered down');
});

test('t5: the files are plain: no script, no event handler, nothing loaded from outside (line endings do not matter: a Windows checkout has CRLF)', () => {
  for (const f of ['kletus-dev.svg', 'icon.svg']) {
    const svg = raw(f).toString('utf8');
    assert.doesNotMatch(svg, /<script|\son\w+=|javascript:|<foreignObject|<image\b|<use\b|href=/i, f);
  }
});

test('t6: the header shows the logo with the text "Kletus.dev" as its alternative, and the old word is gone as plain text', () => {
  const html = read('index.html');
  assert.match(html, /<h1><img src="\/kletus-dev\.svg" alt="Kletus\.dev"[^>]*><\/h1>/);
  assert.doesNotMatch(html, /<h1>Repo Panel<\/h1>/);
});

test('t7: the tab is titled "Kletus.dev" and shows the K as its icon', () => {
  const html = read('index.html');
  assert.match(html, /<title>Kletus\.dev<\/title>/);
  assert.match(html, /<link rel="icon" type="image\/svg\+xml" href="\/icon\.svg">/);
  assert.doesNotMatch(html, /href="data:,"/);
});

test('t9: the name the person sees is Kletus.dev everywhere the page and the README say it: no "Repo Panel" is left in them', () => {
  assert.doesNotMatch(read('index.html'), /Repo Panel/);
  const readme = fs.readFileSync(path.join(PUBLIC, '..', 'README.md'), 'utf8').replace(/\r\n/g, '\n');
  assert.match(readme, /^# Kletus\.dev\n/);
  assert.doesNotMatch(readme, /Repo Panel/);
});

test('t10: what is not a name stays as it was: the package, the folder and the environment variables keep repo-panel and REPO_PANEL_*', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(PUBLIC, '..', 'package.json'), 'utf8'));
  assert.equal(pkg.name, 'repo-panel');
  assert.match(fs.readFileSync(path.join(PUBLIC, '..', 'server', 'http.js'), 'utf8'), /app: 'repo-panel'/);
});

test('t8: the logo has a set height in the header, keeps its proportions and does not leave a gap under it', () => {
  const css = read('style.css');
  const r = rule(css, 'header h1 img');
  assert.ok(r, 'a rule for the logo in the header');
  assert.match(r, /height:\s*\d+px/);
  assert.match(r, /width:\s*auto/);
  assert.match(r, /display:\s*block/);
});
