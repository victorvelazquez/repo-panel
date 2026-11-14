'use strict';
// RP185: the K with the blue dot is the icon of the panel wherever an image is needed. public/K-icon.svg is the base of the person (the white K and the blue dot, no
// background). icon.svg is that K on the dark square (the K is almost white, so without a background it is invisible on a light tab). scripts/make-icons.js draws the
// PNG files (the iPhone needs a 180 px one, the installed app 192, 512 and one for a mask) and the favicon.ico from the base, with no dependency, and the tests read the
// pixels. The server has to serve images as bytes, not as text. Real http server on an ephemeral port with a temp config.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'rp185-'));
const configFile = path.join(scratch, 'config.json');
process.env.REPO_PANEL_CONFIG = configFile;
const HOST = 'pc.tail1234.ts.net';
const KEY = 'correct-horse-battery-staple-1234';
const writeConfig = (extra = {}) => fs.writeFileSync(configFile, JSON.stringify({ port: 4310, groups: [], rooms: [], ...extra }));
writeConfig();
test.after(() => fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 5 }));

const ROOT = path.join(__dirname, '..');
const PUBLIC = path.join(ROOT, 'public');
const { createServer } = require('../server/http.js');
const lib = () => require('../scripts/make-icons.js');
const raw = (f) => fs.readFileSync(path.join(PUBLIC, f));
const text = (f) => raw(f).toString('utf8').replace(/\r\n/g, '\n');

const BG = [15, 18, 22]; // #0f1216, the dark of the panel
const px = (img, x, y) => { const i = (y * img.width + x) * 4; return [img.rgba[i], img.rgba[i + 1], img.rgba[i + 2], img.rgba[i + 3]]; };
const isWhite = (p) => p[3] === 255 && p[0] > 235 && p[1] > 235 && p[2] > 235;
const isBlue = (p) => p[3] === 255 && p[2] > 235 && p[0] < 20 && p[1] > 100 && p[1] < 155;
function boxOf(img, pred) {
  let x0 = Infinity; let y0 = Infinity; let x1 = -1; let y1 = -1;
  for (let y = 0; y < img.height; y++) for (let x = 0; x < img.width; x++) if (pred(px(img, x, y))) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  return { x0, y0, x1, y1, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

// ---------- the files of the person and the icon ----------
test('K-icon.svg is the base of the person: the white K and the blue dot, no background, 126 by 112', () => {
  const svg = text('K-icon.svg');
  assert.match(svg, /<svg\b[^>]*viewBox="0 0 126 112"/);
  assert.equal((svg.match(/<path\b/g) || []).length, 2);
  assert.match(svg, /fill="#FAFBFC"/);
  assert.match(svg, /fill="#007FFF"/);
  assert.doesNotMatch(svg, /<rect\b/);
  assert.ok(svg.includes('M105.316 111.75V90.75H125.116V111.75H105.316Z'), 'the dot');
  assert.doesNotMatch(svg, /\r/, 'LF line endings');
});

test('icon.svg is the K and the blue dot together on the dark square, the K first and untouched, the whole centered', () => {
  const icon = text('icon.svg');
  assert.match(icon, /<svg\b[^>]*viewBox="0 0 64 64"/);
  assert.match(icon, /<rect\b[^>]*fill="#0f1216"/);
  assert.ok(icon.includes('<path d="M105.316 113.55V92.55H125.116V113.55H105.316Z" fill="#007FFF"/>'), 'the dot, in the units of the K of the logo (1.8 down), blue and drawn as it is');
  assert.ok(icon.includes('fill="#007FFF"'));
  assert.ok(icon.indexOf('d="M3.8147e-06') > -1 && icon.indexOf('d="M3.8147e-06') < icon.indexOf('d="M105.316'), 'the K comes first (the tray reads the first path)');
  const t = /transform="translate\(([\d.]+)[ ,]+([\d.]+)\) scale\(([\d.]+)\)"/.exec(icon);
  assert.ok(t, 'one group placed with translate and scale');
  const [x, y, s] = [Number(t[1]), Number(t[2]), Number(t[3])];
  const [left, right, top, bottom] = [x, x + 125.116 * s, y + 1.8 * s, y + 113.55 * s];
  for (const v of [left, top]) assert.ok(v >= 8, `at least 8 of 64 from the top and left edge (${v})`);
  for (const v of [right, bottom]) assert.ok(v <= 56, `at least 8 of 64 from the bottom and right edge (${v})`);
  assert.ok(Math.abs((left + right) / 2 - 32) < 1.5, 'centered across');
  assert.ok(Math.abs((top + bottom) / 2 - 32) < 1.5, 'centered down');
});

// ---------- the generator ----------
test('parseSvgShapes reads the paths of K-icon.svg: the K (14 points, near-white) and the dot (4 points, blue)', () => {
  const shapes = lib().parseSvgShapes(text('K-icon.svg'));
  assert.equal(shapes.length, 2);
  assert.equal(shapes[0].fill.toUpperCase(), '#FAFBFC');
  assert.equal(shapes[0].points.length, 14);
  assert.equal(shapes[1].fill.toUpperCase(), '#007FFF');
  assert.deepEqual(shapes[1].points.map((p) => p.map((n) => Math.round(n * 1000) / 1000)), [[105.316, 111.75], [105.316, 90.75], [125.116, 90.75], [125.116, 111.75]]);
});

test('parseSvgShapes refuses what it cannot draw: curves, and a path with no fill', () => {
  assert.throws(() => lib().parseSvgShapes('<svg><path d="M0 0C1 1 2 2 3 3Z" fill="#fff"/></svg>'), /unsupported/i);
  assert.throws(() => lib().parseSvgShapes('<svg><path d="M0 0H1V1Z"/></svg>'), /fill/i);
});

test('encodePng and decodePng round-trip an RGBA image, write a valid PNG header, and refuse a corrupted chunk', () => {
  const { encodePng, decodePng } = lib();
  const rgba = new Uint8Array(4 * 3 * 2);
  rgba.forEach((_, i) => { rgba[i] = (i * 37) % 256; });
  const png = encodePng(3, 2, rgba);
  assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  assert.equal(png.readUInt32BE(16), 3, 'width');
  assert.equal(png.readUInt32BE(20), 2, 'height');
  assert.equal(png[24], 8, 'bit depth');
  assert.equal(png[25], 6, 'RGBA');
  const back = decodePng(png);
  assert.equal(back.width, 3);
  assert.equal(back.height, 2);
  assert.deepEqual([...back.rgba], [...rgba]);
  const bad = Buffer.from(png);
  bad[bad.length - 20] ^= 0xff; // a byte inside the data of the image
  assert.throws(() => decodePng(bad), /crc|corrupt|invalid/i);
  assert.throws(() => decodePng(Buffer.from('not a png')), /png/i);
});

test('renderIcon: the shapes fill their box, `fit` is the share of the side they take, `radius` rounds the square, and it is deterministic', () => {
  const { renderIcon } = lib();
  const red = [{ points: [[0, 0], [10, 0], [10, 10], [0, 10]], fill: '#ff0000' }];
  const plain = renderIcon({ shapes: red, size: 20, radius: 0, fit: 1, background: null });
  assert.deepEqual(px(plain, 10, 10), [255, 0, 0, 255]);
  assert.deepEqual(px(plain, 0, 0), [255, 0, 0, 255]);
  const half = renderIcon({ shapes: red, size: 20, radius: 0, fit: 0.5, background: '#000000' });
  assert.deepEqual(px(half, 10, 10), [255, 0, 0, 255], 'the center');
  assert.deepEqual(px(half, 1, 1), [0, 0, 0, 255], 'the background around it');
  assert.deepEqual(px(half, 4, 10), [0, 0, 0, 255], 'just outside the half that the shape takes');
  const round = renderIcon({ shapes: red, size: 20, radius: 0.5, fit: 0.5, background: '#000000' });
  assert.equal(px(round, 0, 0)[3], 0, 'a round square has transparent corners');
  assert.equal(px(round, 10, 2)[3], 255, 'and an opaque middle');
  const bare = renderIcon({ shapes: red, size: 20, radius: 0, fit: 0.5, background: null });
  assert.deepEqual(px(bare, 10, 10), [255, 0, 0, 255], 'the shape on nothing');
  assert.equal(px(bare, 1, 1)[3], 0, 'and nothing around it: transparent, not black');
  const clipped = renderIcon({ shapes: red, size: 20, radius: 0.5, fit: 1, background: null });
  assert.equal(px(clipped, 0, 0)[3], 0, 'a shape that reaches the corner is cut by the rounded square');
  assert.deepEqual(px(clipped, 10, 10), [255, 0, 0, 255]);
  const again = renderIcon({ shapes: red, size: 20, radius: 0.5, fit: 0.5, background: '#000000' });
  assert.deepEqual([...again.rgba], [...round.rgba]);
});

test('every PNG of the list is in public, has its size, and is exactly what the generator draws from K-icon.svg (checkIcons finds no problem)', () => {
  const { ICONS, checkIcons, decodePng } = lib();
  assert.deepEqual(ICONS.map((i) => i.file).sort(), ['apple-touch-icon.png', 'icon-192.png', 'icon-512.png', 'icon-maskable-512.png']);
  for (const i of ICONS) {
    const img = decodePng(raw(i.file));
    assert.equal(img.width, i.size, i.file);
    assert.equal(img.height, i.size, i.file);
  }
  assert.deepEqual(checkIcons(PUBLIC), []);
});

test('buildIcons writes the whole set from the base into a folder, and checkIcons of that folder is clean; a changed pixel or a missing file is a problem', () => {
  const { buildIcons, checkIcons, decodePng, encodePng } = lib();
  const dir = fs.mkdtempSync(path.join(scratch, 'build-'));
  fs.copyFileSync(path.join(PUBLIC, 'K-icon.svg'), path.join(dir, 'K-icon.svg'));
  const written = buildIcons(dir);
  assert.deepEqual([...written].sort(), ['apple-touch-icon.png', 'favicon.ico', 'icon-192.png', 'icon-512.png', 'icon-maskable-512.png']);
  assert.deepEqual(checkIcons(dir), []);
  const ico = fs.readFileSync(path.join(dir, 'favicon.ico'));
  assert.equal(ico.readUInt16LE(2), 1, 'the built favicon.ico is an icon');
  assert.equal(ico.readUInt16LE(4), 3, 'with three images');
  const img = decodePng(fs.readFileSync(path.join(dir, 'icon-192.png')));
  img.rgba[(96 * 192 + 96) * 4 + 1] ^= 0x55;
  fs.writeFileSync(path.join(dir, 'icon-192.png'), encodePng(img.width, img.height, img.rgba));
  assert.match(checkIcons(dir).join('\n'), /icon-192\.png/);
  fs.rmSync(path.join(dir, 'icon-512.png'));
  assert.match(checkIcons(dir).join('\n'), /icon-512\.png/);
  fs.writeFileSync(path.join(dir, 'icon-192.png'), encodePng(100, 100, new Uint8Array(100 * 100 * 4)));
  assert.match(checkIcons(dir).join('\n'), /icon-192\.png is 100x100/, 'a file of another size says so');
});

test('the script checks from the command line: --check exits 0 on the committed files and 1 on a folder that has none', () => {
  const ok = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'make-icons.js'), '--check'], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(ok.status, 0, ok.stdout + ok.stderr);
  const empty = fs.mkdtempSync(path.join(scratch, 'empty-'));
  fs.copyFileSync(path.join(PUBLIC, 'K-icon.svg'), path.join(empty, 'K-icon.svg'));
  const bad = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'make-icons.js'), '--check', '--dir', empty], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(bad.status, 1);
});

// ---------- what the pictures look like ----------
function layoutOf(img) {
  const white = boxOf(img, isWhite);
  const blue = boxOf(img, isBlue);
  return { white, blue, all: { x0: Math.min(white.x0, blue.x0), x1: Math.max(white.x1, blue.x1), y0: Math.min(white.y0, blue.y0), y1: Math.max(white.y1, blue.y1) } };
}

test('icon-512.png: the K and the dot on the dark square, the dot to the right of the K on its baseline, the whole centered, with rounded corners', () => {
  const img = lib().decodePng(raw('icon-512.png'));
  const { white, blue, all } = layoutOf(img);
  assert.ok(white.w > 100 && blue.w > 10, 'both are there');
  assert.ok(blue.x0 > white.x1, 'the dot is to the right of the K');
  assert.ok(Math.abs(blue.y1 - white.y1) <= 2, 'on the same baseline');
  assert.ok(Math.abs(blue.w / white.w - 19.8 / 85.2) < 0.03, `the dot is as wide as in the base (${blue.w / white.w})`);
  assert.ok(Math.abs((all.x0 + all.x1) / 2 - 255.5) <= 2.5, 'centered across');
  assert.ok(Math.abs((all.y0 + all.y1) / 2 - 255.5) <= 2.5, 'centered down');
  const share = (all.x1 - all.x0 + 1) / 512;
  assert.ok(share > 0.6 && share < 0.7, `about two thirds of the width (${share})`);
  assert.deepEqual(px(img, white.x0 + 3, Math.round((white.y0 + white.y1) / 2)), [250, 251, 252, 255], 'the K is the near-white of the logo');
  assert.deepEqual(px(img, Math.round((blue.x0 + blue.x1) / 2), Math.round((blue.y0 + blue.y1) / 2)), [0, 127, 255, 255], 'the dot is #007FFF');
  assert.equal(px(img, 0, 0)[3], 0, 'rounded: the corner is transparent');
  assert.equal(px(img, 511, 511)[3], 0);
  assert.deepEqual(px(img, 256, 4), [...BG, 255], 'and the square is the dark of the panel');
});

test('apple-touch-icon.png: 180 by 180, opaque everywhere (iOS draws its own corners and fills any transparency with black), the same picture', () => {
  const img = lib().decodePng(raw('apple-touch-icon.png'));
  assert.equal(img.width, 180);
  assert.equal(img.height, 180);
  for (let i = 3; i < img.rgba.length; i += 4) if (img.rgba[i] !== 255) assert.fail(`a pixel that is not opaque at ${(i - 3) / 4}`);
  assert.deepEqual(px(img, 0, 0), [...BG, 255], 'the corner is the dark of the panel, not transparent');
  const { white, blue, all } = layoutOf(img);
  assert.ok(blue.x0 > white.x1 && white.w > 30);
  assert.ok(Math.abs((all.x0 + all.x1) / 2 - 89.5) <= 2 && Math.abs((all.y0 + all.y1) / 2 - 89.5) <= 2, 'centered');
});

test('icon-maskable-512.png: opaque to the edge, and everything that is drawn stays inside the safe zone (the central 80 percent circle)', () => {
  const img = lib().decodePng(raw('icon-maskable-512.png'));
  assert.equal(img.width, 512);
  let far = 0;
  for (let y = 0; y < 512; y++) for (let x = 0; x < 512; x++) {
    const p = px(img, x, y);
    assert.equal(p[3], 255, `opaque at ${x},${y}`);
    const differs = Math.abs(p[0] - BG[0]) + Math.abs(p[1] - BG[1]) + Math.abs(p[2] - BG[2]) > 6;
    if (differs && Math.hypot(x - 255.5, y - 255.5) > 0.4 * 512 + 1) far += 1;
  }
  assert.equal(far, 0, 'nothing outside the safe zone');
  const { white, blue } = layoutOf(img);
  assert.ok(white.w > 80 && blue.w > 8, 'and both are drawn');
});

test('favicon.ico holds three PNG images of 16, 32 and 48 px that decode to their size', () => {
  const buf = raw('favicon.ico');
  assert.equal(buf.readUInt16LE(0), 0, 'reserved');
  assert.equal(buf.readUInt16LE(2), 1, 'an icon');
  assert.equal(buf.readUInt16LE(4), 3, 'three images');
  const seen = [];
  for (let i = 0; i < 3; i++) {
    const e = 6 + i * 16;
    const w = buf[e] || 256;
    const len = buf.readUInt32LE(e + 8);
    const off = buf.readUInt32LE(e + 12);
    const png = buf.subarray(off, off + len);
    assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10], 'a PNG inside');
    const img = lib().decodePng(png);
    assert.equal(img.width, w);
    assert.equal(img.height, w);
    seen.push(w);
  }
  assert.deepEqual(seen, [16, 32, 48]);
});

// The outline of the K crosses itself at two joints (the arm enters the stem, the leg has a notch). SVG fills with the nonzero rule, so those areas are solid in a browser;
// with the even-odd rule they came out as dark notches in the PNG (seen by looking at the picture: no test measured the joints).
const JOINTS = [[13.45, 60.49], [39.79, 46.59]]; // the middle of each overlap, in the units of K-icon.svg
function atUnits(img, shapes, { size, fit }, [ux, uy]) {
  const pts = shapes.flatMap((s) => s.points);
  const [x0, x1] = [Math.min(...pts.map((p) => p[0])), Math.max(...pts.map((p) => p[0]))];
  const [y0, y1] = [Math.min(...pts.map((p) => p[1])), Math.max(...pts.map((p) => p[1]))];
  const k = (fit * size) / (x1 - x0);
  const ox = (size - (x1 - x0) * k) / 2 - x0 * k;
  const oy = (size - (y1 - y0) * k) / 2 - y0 * k;
  return px(img, Math.floor(ox + ux * k), Math.floor(oy + uy * k));
}

test('the K has no notch where its outline crosses itself: both joints are solid white in every PNG and in a fresh drawing', () => {
  const { ICONS, parseSvgShapes, renderIcon, decodePng } = lib();
  const shapes = parseSvgShapes(text('K-icon.svg'));
  for (const spec of ICONS) {
    const img = decodePng(raw(spec.file));
    for (const joint of JOINTS) assert.deepEqual(atUnits(img, shapes, spec, joint), [250, 251, 252, 255], `${spec.file} at ${joint}`);
  }
  const fresh = renderIcon({ shapes, size: 256, radius: 0, fit: 0.66, background: '#0f1216' });
  for (const joint of JOINTS) assert.deepEqual(atUnits(fresh, shapes, { size: 256, fit: 0.66 }, joint), [250, 251, 252, 255], `fresh at ${joint}`);
});

// ---------- the server serves the pictures as bytes ----------
const freePort = () => new Promise((resolve) => {
  const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
});
const getBuf = (port, p, host) => new Promise((resolve, reject) => {
  http.get({ host: '127.0.0.1', port, path: p, agent: false, headers: { host: host || `127.0.0.1:${port}` } }, (res) => {
    const chunks = [];
    res.on('data', (c) => chunks.push(c));
    res.on('end', () => resolve({ status: res.statusCode, type: res.headers['content-type'] || '', body: Buffer.concat(chunks) }));
  }).on('error', reject);
});
async function withServer(fn) {
  const port = await freePort();
  const server = createServer(port, { noSummaryStore: true });
  await new Promise((r) => server.listen(port, '127.0.0.1', r));
  try { await fn(port); } finally { server.close(); server.closeAllConnections(); }
}
const INSTALL_FILES = ['icon.svg', 'apple-touch-icon.png', 'icon-192.png', 'icon-512.png', 'icon-maskable-512.png', 'favicon.ico'];

test('the server serves each PNG and the icon as the exact bytes of the file, with the right type, and K-icon.svg as an SVG', async () => {
  writeConfig();
  await withServer(async (port) => {
    for (const f of ['apple-touch-icon.png', 'icon-192.png', 'icon-512.png', 'icon-maskable-512.png']) {
      const r = await getBuf(port, `/${f}`);
      assert.equal(r.status, 200, f);
      assert.match(r.type, /^image\/png/, f);
      assert.ok(Buffer.compare(r.body, raw(f)) === 0, `${f} arrives byte for byte`);
    }
    const ico = await getBuf(port, '/favicon.ico');
    assert.equal(ico.status, 200);
    assert.match(ico.type, /^image\/(x-icon|vnd\.microsoft\.icon)/);
    assert.ok(Buffer.compare(ico.body, raw('favicon.ico')) === 0, 'favicon.ico arrives byte for byte');
    const k = await getBuf(port, '/K-icon.svg');
    assert.equal(k.status, 200);
    assert.match(k.type, /^image\/svg\+xml/);
    assert.equal(k.body.toString('utf8').replace(/\r\n/g, '\n'), text('K-icon.svg'));
  });
});

test('on the remote host the install-time pictures need no login (the browser asks for them without the cookie), and the rest still does', async () => {
  writeConfig({ remote: { host: HOST, secret: KEY } });
  await withServer(async (port) => {
    for (const f of INSTALL_FILES) {
      const r = await getBuf(port, `/${f}`, HOST);
      assert.equal(r.status, 200, f);
      assert.ok(r.body.length > 100, f);
    }
    assert.equal((await getBuf(port, '/app.js', HOST)).status, 401);
    assert.equal((await getBuf(port, '/apple-touch-icon.png', 'evil.example')).status, 403, 'a foreign Host never gets anything');
  });
  writeConfig();
});

// ---------- the wiring ----------
test('the manifest lists the SVG and the three PNG (two to use as they are, one to put under a mask), each real and with its true size', () => {
  const m = JSON.parse(raw('manifest.webmanifest').toString('utf8'));
  const by = (src) => m.icons.find((i) => i.src === src);
  assert.ok(by('/icon.svg') && by('/icon.svg').type === 'image/svg+xml');
  for (const [src, size, purpose] of [['/icon-192.png', 192, 'any'], ['/icon-512.png', 512, 'any'], ['/icon-maskable-512.png', 512, 'maskable']]) {
    const i = by(src);
    assert.ok(i, src);
    assert.equal(i.type, 'image/png');
    assert.equal(i.sizes, `${size}x${size}`);
    assert.equal(i.purpose, purpose);
    const img = lib().decodePng(raw(src.slice(1)));
    assert.equal(img.width, size, `${src} really is ${size}`);
  }
});

test('the page links the iPhone icon; the notices use the PNG (an SVG does not show in every browser)', () => {
  assert.ok(text('index.html').includes('<link rel="apple-touch-icon" href="/apple-touch-icon.png">'));
  assert.ok(text('index.html').includes('<link rel="icon" type="image/svg+xml" href="/icon.svg">'), 'the tab still takes the SVG');
  for (const f of ['sw.js', 'feed.js']) {
    assert.ok(text(f).includes("icon: '/icon-192.png'"), `${f} uses the PNG`);
    assert.ok(!text(f).includes("icon: '/icon.svg'"), `${f} no longer uses the SVG`);
  }
});

test('the README says how to regenerate the icons and what the iPhone needs to show the new one', () => {
  const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
  assert.match(readme, /scripts\/make-icons\.js/);
  assert.match(readme, /apple-touch-icon/);
  assert.match(readme, /K-icon\.svg/);
  assert.match(readme, /remove the app[^.]*add it again|Add to Home Screen again/i);
});
