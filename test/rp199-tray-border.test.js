'use strict';
// RP199 (S1): the icon of the tray (scripts/tray.ps1) gets a thin line of ONE pixel around the square, in the color of the lines of the panel (--line of public/style.css), so the square keeps its
// shape on a dark taskbar; and the K is smaller inside its box, so the drawing breathes. The state dot, the colors of the K and of the square, and the rounded corners are the ones of RP187.
// `tray.ps1 -RenderIcons <size>` prints the pixels of what the tray really draws (Windows); on any system the script is also checked as text. How it LOOKS is for the person to try.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const TRAY = path.join(ROOT, 'scripts', 'tray.ps1');
const tray = fs.readFileSync(TRAY, 'utf8').replace(/\r\n/g, '\n');
const style = fs.readFileSync(path.join(ROOT, 'public', 'style.css'), 'utf8');
const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
const WIN = process.platform === 'win32';
const opts = { skip: WIN ? false : 'the tray icon is drawn with System.Drawing on Windows (PowerShell)' };

const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const LINE = hex('#3a4553'); // RP203: the line is the border of the cards of the page (#3a4553), lighter than --line (#2a323c), which was as dark as the menu of hidden icons of Windows and could not be seen
const BACK = [15, 18, 22];
const KEY = [250, 251, 252];
const BLUE = [0, 127, 255];

// ---------- the script, as text (any system) ----------
test('b1: the line has a name among the colors and it is a color of the page (the border of its cards), which is found in the stylesheet', () => {
  assert.equal(LINE.length, 3);
  assert.ok(/#3a4553/i.test(style), 'that color is in style.css: it is the page\'s own');
  const m = /Line\s*=\s*\[System\.Drawing\.Color\]::FromArgb\((\d+), (\d+), (\d+)\)/.exec(tray);
  assert.ok(m, 'Get-TrayColors has a Line');
  assert.deepEqual(m.slice(1).map(Number), LINE);
});

test('b2: the line is drawn with a pen of ONE pixel along the edge of the square, after the fill and before the K, and it is disposed', () => {
  assert.match(tray, /New-Object System\.Drawing\.Pen\(\$colors\.Line, 1\)/);
  assert.match(tray, /DrawPath\(\$linePen, \$linePath\)/);
  assert.ok(tray.indexOf('FillPath($backBrush') < tray.indexOf('DrawPath($linePen'), 'the line goes over the fill');
  assert.ok(tray.indexOf('DrawPath($linePen') < tray.indexOf('FillPolygon($keyBrush'), 'and under the K');
  assert.match(tray, /\$linePen\.Dispose\(\)/);
  assert.match(tray, /\$linePath\.Dispose\(\)/);
});

test('b3: the K is smaller than before (it took 88 % of the width), and its share is still ONE constant that the scale and the centering come from', () => {
  const fit = Number((/\$fit = (0\.\d+)/.exec(tray) || [])[1]);
  assert.ok(fit > 0.5 && fit < 0.8, `the drawing takes less than 80 % of the width and more than half (${fit})`);
  assert.match(tray, /\$scale = \$Width \* \$fit \/ 125\.116/);
});

// ---------- what it really draws (Windows) ----------
const cache = new Map();
function render(size) {
  if (cache.has(size)) return cache.get(size);
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', TRAY, '-RenderIcons', String(size)], { encoding: 'utf8', timeout: 90000, maxBuffer: 128 * 1024 * 1024 });
  assert.equal(r.status, 0, `${r.stderr}${r.stdout.slice(0, 300)}`);
  const j = JSON.parse(r.stdout);
  const out = { size: j.size, running: { width: size, height: size, rgba: j.running }, stopped: { width: size, height: size, rgba: j.stopped } };
  cache.set(size, out);
  return out;
}
const px = (img, x, y) => { const i = (y * img.width + x) * 4; return [img.rgba[i], img.rgba[i + 1], img.rgba[i + 2], img.rgba[i + 3]]; };
const near = (a, b, d = 3) => a.every((v, i) => Math.abs(v - b[i]) <= d);
function boxOf(img, pred) {
  let x0 = Infinity; let y0 = Infinity; let x1 = -1; let y1 = -1;
  for (let y = 0; y < img.height; y++) for (let x = 0; x < img.width; x++) if (pred(px(img, x, y))) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y1 < y) y1 = y; }
  if (x1 < 0) return { x0: -1, y0: -1, x1: -1, y1: -1, w: 0, h: 0 };
  return { x0, y0, x1, y1, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}
// The K is every light GRAY pixel (the line, the square and the colored dot are not), with its antialiased edge: on 16 px almost no pixel of the smaller K is painted at 100 %.
const isKey = (p) => p[3] === 255 && p[0] >= 90 && Math.abs(p[0] - p[1]) <= 12 && Math.abs(p[1] - p[2]) <= 12;
const isBlue = (p) => p[3] === 255 && near(p.slice(0, 3), BLUE, 12);

for (const size of [16, 32, 48]) {
  test(`b4 (${size} px): the line is ONE pixel and runs along the four edges: the middle of each edge is the color of the line, and the pixel inside it is the dark of the square`, opts, () => {
    const { running } = render(size);
    const mid = Math.floor(size / 2);
    const edges = { top: [mid, 0, mid, 1], left: [0, mid, 1, mid], right: [size - 1, mid, size - 2, mid], bottom: [mid, size - 1, mid, size - 2] };
    for (const [name, [x, y, ix, iy]] of Object.entries(edges)) {
      const edge = px(running, x, y);
      assert.ok(edge[3] === 255 && near(edge.slice(0, 3), LINE, 2), `${name}: the edge is the line (${edge})`);
      const inside = px(running, ix, iy);
      assert.ok(inside[3] === 255 && near(inside.slice(0, 3), BACK, 2), `${name}: just inside it is the dark of the square, so the line is one pixel (${inside})`);
    }
  });

  test(`b5 (${size} px): the drawing breathes: from the edge of the icon to the K and to the dot there is at least an eighth of the side (${Math.floor(size / 8)} px) on every side`, opts, () => {
    const { running } = render(size);
    const k = boxOf(running, isKey);
    const d = boxOf(running, isBlue);
    const need = Math.floor(size / 8);
    const [x0, x1, y0, y1] = [Math.min(k.x0, d.x0), Math.max(k.x1, d.x1), Math.min(k.y0, d.y0), Math.max(k.y1, d.y1)];
    assert.ok(x0 >= need, `left: ${x0} >= ${need}`);
    assert.ok(size - 1 - x1 >= need, `right: ${size - 1 - x1} >= ${need}`);
    assert.ok(y0 >= need, `top: ${y0} >= ${need}`);
    assert.ok(size - 1 - y1 >= need, `bottom: ${size - 1 - y1} >= ${need}`);
  });

  test(`b6 (${size} px): the K is still big enough to read: at least half of the height of the icon`, opts, () => {
    const { running } = render(size);
    const k = boxOf(running, isKey);
    assert.ok(k.h >= size * 0.5, `the K is ${k.h} px tall of ${size}`);
  });

  test(`b7 (${size} px): the line is the same in both states: only the dot changes`, opts, () => {
    const { running, stopped } = render(size);
    const mid = Math.floor(size / 2);
    for (const [x, y] of [[mid, 0], [0, mid], [size - 1, mid], [mid, size - 1]]) assert.deepEqual(px(running, x, y), px(stopped, x, y), `edge ${x},${y}`);
  });
}

test('b8: the README says the icon has a thin line of one pixel and where its color comes from, and that the K is smaller so it breathes', () => {
  assert.match(readme, /\*\*thin line\*\* of one pixel around it \(RP199, lighter in RP203: `#3a4553`/);
  assert.match(readme, /smaller inside its box so that it breathes/);
  assert.match(readme, /drawn 1\.6 times bigger/);
});

test('b9: the README tells how a new icon really shows: the tray reads its script once and Quit tray does not bring it back (the task starts it at log on)', () => {
  assert.match(readme, /reads `scripts\/tray\.ps1` ONCE/);
  assert.match(readme, /\*\*Quit tray\*\* closes it, but the `repo-panel-tray` task only starts it at log on/);
  assert.match(readme, /Start-ScheduledTask repo-panel-tray/);
  assert.doesNotMatch(readme, /quit the tray \(\*\*Quit tray\*\*\) and start it again/, 'the false instruction of RP187 is gone');
});
