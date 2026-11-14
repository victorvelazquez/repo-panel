'use strict';
// RP185: draws the PNG icons and favicon.ico from public/K-icon.svg with no dependency. Run `node scripts/make-icons.js` to write them, `--check` to verify them
// (the decoded pixels are compared, never the bytes of the zlib stream, which can differ between Node versions), `--dir <folder>` to use another folder than public/.
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const BACKGROUND = '#0f1216'; // the dark of the panel
const ICONS = [
  { file: 'apple-touch-icon.png', size: 180, radius: 0, fit: 0.66, background: BACKGROUND }, // iOS draws its own corners and fills transparency with black
  { file: 'icon-192.png', size: 192, radius: 0.21875, fit: 0.66, background: BACKGROUND },
  { file: 'icon-512.png', size: 512, radius: 0.21875, fit: 0.66, background: BACKGROUND },
  { file: 'icon-maskable-512.png', size: 512, radius: 0, fit: 0.5, background: BACKGROUND }, // the whole square: the mask of Android cuts it
];
const ICO = { file: 'favicon.ico', sizes: [16, 32, 48], radius: 0.21875, fit: 0.66, background: BACKGROUND };

// Absolute M, H, V, L and Z only; the point that closes the path (it repeats the first) is dropped.
function parseSvgShapes(svg) {
  const shapes = [];
  for (const tag of svg.match(/<path\b[^>]*>/g) || []) {
    const d = /\sd="([^"]*)"/.exec(tag);
    const fill = /\sfill="(#[0-9a-fA-F]{3}|#[0-9a-fA-F]{6})"/.exec(tag);
    if (!fill) throw new Error('A path has no fill color');
    const tokens = (d ? d[1] : '').match(/[A-Za-z]|-?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/g) || [];
    const points = [];
    let [x, y, cmd] = [0, 0, ''];
    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i];
      if (/^[A-Za-z]$/.test(t)) {
        if (!'MHVLZ'.includes(t)) throw new Error(`Unsupported path command ${t}`);
        cmd = t;
      } else if (cmd === 'M' || cmd === 'L') { x = Number(t); y = Number(tokens[++i]); points.push([x, y]); } else if (cmd === 'H') { x = Number(t); points.push([x, y]); } else if (cmd === 'V') { y = Number(t); points.push([x, y]); } else throw new Error('Unsupported path data');
    }
    const [a, b] = [points[0], points[points.length - 1]];
    if (points.length > 1 && a[0] === b[0] && a[1] === b[1]) points.pop();
    shapes.push({ points, fill: fill[1].length === 4 ? `#${[...fill[1].slice(1)].map((c) => c + c).join('')}` : fill[1] });
  }
  return shapes;
}

const rgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
// The fill rule of SVG, nonzero: where the outline of the K crosses itself the area is solid, not a hole. A scanline fill on the 4 by 4 samples of every pixel: for each
// sample row the crossings of the edges give the spans where the winding is not zero, and each span paints the sample columns whose center it covers.
function edgesOf(points) {
  const edges = [];
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const [xa, ya] = points[j];
    const [xb, yb] = points[i];
    if (ya === yb) continue;
    edges.push({ ylo: Math.min(ya, yb), yhi: Math.max(ya, yb), xa, ya, slope: (xb - xa) / (yb - ya), dir: yb > ya ? 1 : -1 });
  }
  return edges;
}
function spansAt(edges, y) {
  const hits = [];
  for (const e of edges) if (y >= e.ylo && y < e.yhi) hits.push([e.xa + (y - e.ya) * e.slope, e.dir]);
  hits.sort((p, q) => p[0] - q[0]);
  const spans = [];
  let wind = 0;
  let from = 0;
  for (const [x, dir] of hits) {
    const before = wind;
    wind += dir;
    if (before === 0 && wind !== 0) from = x;
    else if (before !== 0 && wind === 0) spans.push([from, x]);
  }
  return spans;
}

// One uniform scale: the bounding box of the shapes takes `fit` of the width of the square and is centered on both axes. 4 by 4 samples per pixel, premultiplied average.
function renderIcon({ shapes, size, radius, fit, background }) {
  const all = shapes.flatMap((s) => s.points);
  const [x0, x1] = [Math.min(...all.map((p) => p[0])), Math.max(...all.map((p) => p[0]))];
  const [y0, y1] = [Math.min(...all.map((p) => p[1])), Math.max(...all.map((p) => p[1]))];
  const scale = (fit * size) / (x1 - x0);
  const [ox, oy] = [size / 2 - ((x0 + x1) / 2) * scale, size / 2 - ((y0 + y1) / 2) * scale];
  const mapped = shapes.map((s) => ({ color: rgb(s.fill), edges: edgesOf(s.points.map(([x, y]) => [x * scale + ox, y * scale + oy])) }));
  const palette = [background ? rgb(background) : null, ...mapped.map((s) => s.color)];
  const r = radius * size;
  const cols = size * 4;
  const columnAt = (x) => Math.min(cols, Math.max(0, Math.ceil(x * 4 - 0.5))); // the first sample column whose center is at or after x
  const row = new Int16Array(cols);
  const sum = new Float64Array(size * 4);
  const rgba = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    sum.fill(0);
    for (let sy = 0; sy < 4; sy++) {
      const py = y + (sy + 0.5) / 4;
      // The rounded square at this height: its corners are cut by a circle of radius r.
      const dy = py < r ? r - py : py > size - r ? py - (size - r) : 0;
      const half = Math.sqrt(Math.max(0, r * r - dy * dy));
      const [left, right] = dy > 0 ? [columnAt(r - half), columnAt(size - r + half)] : [0, cols];
      row.fill(-1);
      if (palette[0]) row.fill(0, left, right);
      mapped.forEach((s, k) => { for (const [xa, xb] of spansAt(s.edges, py)) row.fill(k + 1, Math.max(left, columnAt(xa)), Math.min(right, columnAt(xb))); });
      for (let c = 0; c < cols; c++) {
        const v = row[c];
        if (v < 0) continue;
        const color = palette[v];
        const o = (c >> 2) * 4;
        sum[o] += color[0]; sum[o + 1] += color[1]; sum[o + 2] += color[2]; sum[o + 3] += 1;
      }
    }
    for (let x = 0; x < size; x++) {
      const n = sum[x * 4 + 3];
      if (!n) continue;
      const i = (y * size + x) * 4;
      rgba[i] = Math.round(sum[x * 4] / n); rgba[i + 1] = Math.round(sum[x * 4 + 1] / n); rgba[i + 2] = Math.round(sum[x * 4 + 2] / n); rgba[i + 3] = Math.round((n * 255) / 16);
    }
  }
  return { width: size, height: size, rgba };
}

const CRC = new Uint32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc32 = (buf) => { let c = 0xffffffff; for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const chunk = (type, data) => {
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const [head, tail] = [Buffer.alloc(4), Buffer.alloc(4)];
  head.writeUInt32BE(data.length);
  tail.writeUInt32BE(crc32(body));
  return Buffer.concat([head, body, tail]);
};

function encodePng(width, height, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.set([8, 6, 0, 0, 0], 8); // 8 bit, RGBA, deflate, filter method 0, no interlace
  const rows = Buffer.alloc((width * 4 + 1) * height); // every row starts with filter type 0
  for (let y = 0; y < height; y++) rows.set(rgba.subarray(y * width * 4, (y + 1) * width * 4), y * (width * 4 + 1) + 1);
  return Buffer.concat([SIGNATURE, chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
}

function decodePng(buf) {
  if (buf.length < 8 || !buf.subarray(0, 8).equals(SIGNATURE)) throw new Error('Not a png file');
  let [pos, header] = [8, null];
  const data = [];
  while (pos + 12 <= buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('latin1', pos + 4, pos + 8);
    const body = buf.subarray(pos + 8, pos + 8 + len);
    if (pos + 12 + len > buf.length || buf.readUInt32BE(pos + 8 + len) !== crc32(buf.subarray(pos + 4, pos + 8 + len))) throw new Error(`png chunk ${type} has a wrong crc`);
    if (type === 'IHDR') header = body;
    else if (type === 'IDAT') data.push(body);
    else if (type === 'IEND') break;
    pos += 12 + len;
  }
  if (!header) throw new Error('png has no header');
  const [width, height] = [header.readUInt32BE(0), header.readUInt32BE(4)];
  if (header[8] !== 8 || header[9] !== 6 || header[12] !== 0) throw new Error('Unsupported png: only 8-bit RGBA without interlace');
  const raw = zlib.inflateSync(Buffer.concat(data));
  const rgba = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    const at = y * (width * 4 + 1);
    if (raw[at] !== 0) throw new Error('Unsupported png: only filter 0');
    rgba.set(raw.subarray(at + 1, at + 1 + width * 4), y * width * 4);
  }
  return { width, height, rgba };
}

function encodeIco(images) {
  const head = Buffer.alloc(6 + images.length * 16);
  head.writeUInt16LE(1, 2);
  head.writeUInt16LE(images.length, 4);
  let offset = head.length;
  images.forEach(({ size, png }, i) => {
    const e = 6 + i * 16;
    head[e] = size >= 256 ? 0 : size;
    head[e + 1] = head[e];
    head.writeUInt16LE(1, e + 4); // planes
    head.writeUInt16LE(32, e + 6); // bits per pixel
    head.writeUInt32LE(png.length, e + 8);
    head.writeUInt32LE(offset, e + 12);
    offset += png.length;
  });
  return Buffer.concat([head, ...images.map((i) => i.png)]);
}

const shapesOf = (dir) => parseSvgShapes(fs.readFileSync(path.join(dir, 'K-icon.svg'), 'utf8'));
const draw = (shapes, size, spec) => renderIcon({ shapes, size, radius: spec.radius, fit: spec.fit, background: spec.background });

function buildIcons(dir) {
  const shapes = shapesOf(dir);
  const out = [];
  for (const i of ICONS) {
    const img = draw(shapes, i.size, i);
    fs.writeFileSync(path.join(dir, i.file), encodePng(img.width, img.height, img.rgba));
    out.push(i.file);
  }
  const images = ICO.sizes.map((size) => ({ size, png: encodePng(size, size, draw(shapes, size, ICO).rgba) }));
  fs.writeFileSync(path.join(dir, ICO.file), encodeIco(images));
  return [...out, ICO.file];
}

function checkIcons(dir) {
  const shapes = shapesOf(dir);
  const problems = [];
  const verify = (label, png, size, spec) => {
    try {
      const img = decodePng(png);
      if (img.width !== size || img.height !== size) problems.push(`${label} is ${img.width}x${img.height}, expected ${size}x${size}`);
      else if (Buffer.compare(Buffer.from(img.rgba), Buffer.from(draw(shapes, size, spec).rgba)) !== 0) problems.push(`${label} differs from what K-icon.svg draws now`);
    } catch (e) { problems.push(`${label} cannot be read: ${e.message}`); }
  };
  const read = (file) => { try { return fs.readFileSync(path.join(dir, file)); } catch { problems.push(`${file} is missing`); return null; } };
  for (const i of ICONS) { const png = read(i.file); if (png) verify(i.file, png, i.size, i); }
  const ico = read(ICO.file);
  if (ico) {
    const n = ico.length >= 6 ? ico.readUInt16LE(4) : 0;
    if (n !== ICO.sizes.length) problems.push(`${ICO.file} holds ${n} images, expected ${ICO.sizes.length}`);
    else ICO.sizes.forEach((size, k) => { const e = 6 + k * 16; const off = ico.readUInt32LE(e + 12); verify(`${ICO.file} (${size}px)`, ico.subarray(off, off + ico.readUInt32LE(e + 8)), size, ICO); });
  }
  return problems;
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const at = args.indexOf('--dir');
  const dir = at >= 0 ? path.resolve(args[at + 1]) : path.join(__dirname, '..', 'public');
  if (args.includes('--check')) {
    const problems = checkIcons(dir);
    if (problems.length) { process.stderr.write(`${problems.join('\n')}\n`); process.exit(1); }
    process.stdout.write('Icons OK\n');
  } else process.stdout.write(`Wrote ${buildIcons(dir).join(', ')}\n`);
}

module.exports = { parseSvgShapes, renderIcon, encodePng, decodePng, encodeIco, buildIcons, checkIcons, ICONS, ICO };
