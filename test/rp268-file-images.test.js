'use strict';
// RP268: a png, jpg, gif or webp of the repo opened in the file viewer shows as an image instead of «Binary file, not shown», with a button that opens it
// in a new tab. The type comes from the bytes (server/images.js), never from the name. GET /api/file says which image it is; GET /api/file/image answers
// its bytes with the same guards as GET /api/file (only a file git lists, inside the repo), only when the bytes are an image, and never SVG.
// Real git repo in a temp folder; the real config and repos are never touched.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { sh } = require('./git-helper.js');

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'rp268-'));
const repoDir = path.join(scratch, 'Repo');
fs.mkdirSync(repoDir);
process.env.REPO_PANEL_CONFIG = path.join(scratch, 'config.json');
fs.writeFileSync(process.env.REPO_PANEL_CONFIG, JSON.stringify({ port: 4312, groups: [{ name: 'G', repos: [{ path: repoDir }] }], rooms: [] }));
test.after(() => fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 5 }));

const { readFile, readImage } = require('../server/files.js');
const { imageType } = require('../server/images.js');
const { createServer } = require('../server/http.js');
const lib = require('../lib.js');
const R = require('../public/resumen.js');

const repo = { path: repoDir, id: lib.repoId(repoDir), name: 'Repo' };
const put = (rel, data) => { const f = path.join(repoDir, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, data); };
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from([0, 0, 0, 13, 1, 2, 3])]);
const JPG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16]);
const GIF = Buffer.from('GIF89a\x01\x00\x01\x00\x00', 'latin1');
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.from([0, 0, 0, 0]), Buffer.from('WEBPVP8 '), Buffer.from([0])]);

test.before(() => {
  sh(repoDir, 'init', '-q', '-b', 'main');
  put('img/shot.png', PNG);
  put('img/photo.jpg', JPG);
  put('img/anim.gif', GIF);
  put('img/pic.webp', WEBP);
  put('img/fake.png', Buffer.from([1, 2, 0, 3])); // an image name with bytes that are not an image
  put('img/logo.svg', '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>\n');
  put('img/big.png', Buffer.concat([PNG, Buffer.alloc(2 * 1024 * 1024)])); // over the 1 MiB of text, under the 5 MiB of an image
  put('img/huge.png', Buffer.concat([PNG, Buffer.alloc(5 * 1024 * 1024)])); // over the 5 MiB of an image
  put('.gitignore', 'hidden.png\n');
  put('hidden.png', PNG); // ignored: git does not list it
  sh(repoDir, 'add', '-A');
  sh(repoDir, 'commit', '-q', '-m', 'init');
});

test('a1: the type of an image comes from its bytes, not from its name', () => {
  assert.equal(imageType(PNG), 'image/png');
  assert.equal(imageType(JPG), 'image/jpeg');
  assert.equal(imageType(GIF), 'image/gif');
  assert.equal(imageType(WEBP), 'image/webp');
  assert.equal(imageType(Buffer.from('<svg></svg>')), '');
  assert.equal(imageType(Buffer.from([1, 2, 0, 3])), '');
  assert.equal(imageType(Buffer.alloc(0)), '');
});

test('a2: GET /api/file says which image a file is, with no text, even over the 1 MiB of text', async () => {
  for (const [p, type] of [['img/shot.png', 'image/png'], ['img/photo.jpg', 'image/jpeg'], ['img/anim.gif', 'image/gif'], ['img/pic.webp', 'image/webp'], ['img/big.png', 'image/png']]) {
    const f = await readFile(repo, p);
    assert.equal(f.image, type, p);
    assert.equal(f.binary, true, `${p}: an older page still says binary`);
    assert.equal(f.tooLarge, false, p);
    assert.equal(f.text, undefined, p);
  }
  const fake = await readFile(repo, 'img/fake.png');
  assert.equal(fake.image, undefined);
  assert.equal(fake.binary, true);
  const svg = await readFile(repo, 'img/logo.svg');
  assert.equal(svg.image, undefined, 'an SVG stays text');
  assert.match(svg.text, /<svg/);
  const huge = await readFile(repo, 'img/huge.png');
  assert.equal(huge.image, undefined);
  assert.equal(huge.tooLarge, true);
});

test('a3: readImage answers the bytes and the type of an image of the repo, and nothing else', async () => {
  const ok = await readImage(repo, 'img/shot.png');
  assert.equal(ok.type, 'image/png');
  assert.ok(ok.body.equals(PNG));
  const fails = async (p, status) => assert.rejects(readImage(repo, p), (e) => e.status === status && !/OUTSIDE|alert|\x00/.test(e.message), p);
  await fails('img/fake.png', 415);
  await fails('img/logo.svg', 415);
  await fails('img/huge.png', 413);
  await fails('hidden.png', 404);
  await fails('nope.png', 404);
  await fails('../outside.png', 400);
  await fails('.git/config', 400);
});

const request = (port, p, headers = {}) => new Promise((resolve, reject) => {
  http.get({ host: '127.0.0.1', port, path: p, headers }, (res) => {
    const chunks = []; res.on('data', (c) => chunks.push(c)); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
  }).on('error', reject);
});
const freePort = () => new Promise((resolve) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });

test('a4: GET /api/file/image needs the token and answers the bytes sandboxed, never a file that is not an image', async () => {
  const port = await freePort();
  const server = createServer(port, { noSummaryStore: true });
  await new Promise((r) => server.listen(port, '127.0.0.1', r));
  try {
    const token = /name="?token"? content="([0-9a-f]+)"/.exec((await request(port, '/')).body.toString())[1];
    const url = (p) => `/api/file/image?id=${repo.id}&path=${encodeURIComponent(p)}`;
    assert.equal((await request(port, url('img/shot.png'))).status, 401);
    const ok = await request(port, url('img/shot.png'), { 'x-token': token });
    assert.equal(ok.status, 200);
    assert.equal(ok.headers['content-type'], 'image/png');
    assert.equal(ok.headers['x-content-type-options'], 'nosniff');
    assert.match(ok.headers['content-security-policy'], /sandbox/);
    assert.ok(ok.body.equals(PNG));
    for (const [p, status] of [['img/logo.svg', 415], ['img/fake.png', 415], ['hidden.png', 404], ['../x.png', 400]]) {
      const r = await request(port, url(p), { 'x-token': token });
      assert.equal(r.status, status, p);
      assert.doesNotMatch(r.body.toString(), /alert|<svg/, p);
    }
  } finally { await new Promise((r) => server.close(r)); }
});

test('a5: the viewer shows an image from its blob: address with a button to open it in a new tab, and nothing from any other address', () => {
  const on = R.fileView({ path: 'img/shot.png', binary: true, image: 'image/png', url: 'blob:http://127.0.0.1/abc' }, { selected: 'img/shot.png' });
  assert.match(on, /<img [^>]*src="blob:http:\/\/127\.0\.0\.1\/abc"/);
  assert.match(on, /<a [^>]*href="blob:http:\/\/127\.0\.0\.1\/abc"[^>]*target="_blank"[^>]*rel="noopener[^"]*"[^>]*>Open in new tab<\/a>/);
  assert.doesNotMatch(on, /Binary file/);
  const bad = R.fileView({ path: 'img/shot.png', binary: true, image: 'image/png', url: 'javascript:alert(1)' }, { selected: 'img/shot.png' });
  assert.doesNotMatch(bad, /javascript:|<img |<a /);
  assert.match(bad, /Image unavailable/);
  const loading = R.fileView({ path: 'img/shot.png', binary: true, image: 'image/png' }, { selected: 'img/shot.png' });
  assert.match(loading, /Image unavailable/);
  assert.match(R.fileView({ path: 'a.dat', binary: true }, { selected: 'a.dat' }), /Binary file, not shown/, 'a binary that is not an image is as before');
});
