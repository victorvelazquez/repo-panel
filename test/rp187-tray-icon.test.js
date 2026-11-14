'use strict';
// RP187: the icon of the tray (scripts/tray.ps1) is the K with the dot of K-icon.svg on a dark gray rounded square. The DOT tells the state: blue while the panel runs, light gray
// (lighter than the square) while it is stopped; the square and the K never change. The dot is drawn 1.4 times bigger than the one of the file, from its bottom right corner, so
// that it can be seen on 16 px. `tray.ps1 -RenderIcons <size>` draws both icons and prints their pixels as JSON (no window, no mutex, nothing written): on Windows the tests read
// the pixels of what the tray really draws; on any system the script is also checked as text. It never touches the scheduled tasks.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const TRAY = path.join(ROOT, 'scripts', 'tray.ps1');
const tray = fs.readFileSync(TRAY, 'utf8').replace(/\r\n/g, '\n');
const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
const WIN = process.platform === 'win32';
const opts = { skip: WIN ? false : 'the tray icon is drawn with System.Drawing on Windows (PowerShell)' };

const BACK = [52, 56, 64];
const KEY = [250, 251, 252];
const BLUE = [0, 127, 255];
const LIGHT = [200, 205, 212];

// ---------- the script, as text (any system) ----------
test('t1: the four colors are named once: dark gray square, near-white K, blue dot when running, light gray dot when stopped', () => {
  assert.match(tray, /Back\s*=\s*\[System\.Drawing\.Color\]::FromArgb\(52, 56, 64\)/);
  assert.match(tray, /Key\s*=\s*\[System\.Drawing\.Color\]::FromArgb\(250, 251, 252\)/);
  assert.match(tray, /Running\s*=\s*\[System\.Drawing\.Color\]::FromArgb\(0, 127, 255\)/);
  assert.match(tray, /Stopped\s*=\s*\[System\.Drawing\.Color\]::FromArgb\(200, 205, 212\)/);
});

test('t2: the square is rounded (four arcs and a path), the K is filled with the winding rule like SVG, and the dot is a rectangle in the color of the state', () => {
  assert.equal((tray.match(/\.AddArc\(/g) || []).length, 4);
  assert.match(tray, /FillPath\(\$backBrush/);
  assert.doesNotMatch(tray, /FillEllipse/);
  assert.match(tray, /FillPolygon\(\$keyBrush, \$points, \[System\.Drawing\.Drawing2D\.FillMode\]::Winding\)/, 'the outline of the K crosses itself: with the default rule it has notches');
  assert.match(tray, /FillRectangle\(\$dotBrush/);
  assert.match(tray, /function New-StateBitmap\(\[System\.Drawing\.Color\]\$Dot, \[int\]\$Width, \[int\]\$Height\)/);
});

test('t3: the dot of the tray is the dot of K-icon.svg (its size and its place next to the K), drawn 1.4 times bigger from its bottom right corner', () => {
  const { parseSvgShapes } = require('../scripts/make-icons.js');
  const dot = parseSvgShapes(fs.readFileSync(path.join(ROOT, 'public', 'K-icon.svg'), 'utf8'))[1].points;
  const xs = dot.map((p) => p[0]);
  const ys = dot.map((p) => p[1]);
  const [w, h, right] = [Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys), Math.max(...xs)];
  assert.match(tray, new RegExp(`\\$dotBoost = 1\\.4`));
  assert.ok(tray.includes(String(Math.round(w * 10) / 10)), `the width of the dot (${w})`);
  assert.ok(tray.includes(String(h)), `the height of the dot (${h})`);
  assert.ok(tray.includes(String(right)), `the right edge of the K and its dot (${right})`);
});

test('t4: the two icons are built from the colors and the tray shows the running one while the panel answers and the stopped one when it does not', () => {
  assert.match(tray, /\$colors = Get-TrayColors/);
  assert.match(tray, /\$running = New-StateIcon \$colors\.Running/);
  assert.match(tray, /\$stopped = New-StateIcon \$colors\.Stopped/);
  assert.match(tray, /\$notify\.Icon = if \(\$script:healthy\) \{ \$running\.Icon \} else \{ \$stopped\.Icon \}/);
  assert.doesNotMatch(tray, /\$green|\$gray/);
  assert.match(tray, /New-StateBitmap \$Dot \$size\.Width \$size\.Height/, 'the tray icon is as wide and as tall as the small icon of the screen, in that order');
  assert.match(tray, /foreach \(\$i in @\(\$running, \$stopped\)\) \{ \$i\.Icon\.Dispose\(\); \[void\]\[RepoPanel\.Native\]::DestroyIcon\(\$i\.Handle\) \}/, 'both icons are freed when the tray quits');
});

test('t5: -RenderIcons is a mode like -SelfTest: it leaves before the mutex and the tray icon are created, and it is in the header comment', () => {
  assert.match(tray, /\[int\]\$RenderIcons = 0/);
  assert.match(tray, /-RenderIcons/);
  const mode = tray.indexOf('if ($RenderIcons -gt 0)');
  assert.ok(mode > 0, 'the mode exists');
  assert.ok(mode < tray.indexOf('New-Object System.Threading.Mutex'), 'before the mutex');
  assert.ok(mode < tray.indexOf('New-Object System.Windows.Forms.NotifyIcon'), 'before the tray icon');
  assert.match(tray.slice(mode, mode + 900), /exit 0/, 'and it ends the script');
  assert.doesNotMatch(tray.slice(mode, tray.indexOf('# ---- UI ----')), /ScheduledTask|Stop-Process|Start-Process/, 'it never touches a task or a process');
});

test('t6: the fit of the drawing in the icon is one constant, and the scale and the centering come from it', () => {
  assert.match(tray, /\$fit = 0\.88/);
  assert.match(tray, /\$scale = \$Width \* \$fit \/ 125\.116/);
  assert.match(tray, /\(\$Width - 125\.116 \* \$scale\) \/ 2/);
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
// The dot is the ONLY thing that changes with the state: the pixels that differ between the two icons.
const changed = (a, b) => ({ width: a.width, height: a.height, rgba: a.rgba.map((v, i) => (v === b.rgba[i] ? 0 : 255)) });
const diffBox = (a, b) => boxOf(changed(a, b), (p) => p.slice(0, 3).some((v) => v === 255));
const isKey = (p) => p[3] === 255 && near(p.slice(0, 3), KEY, 12);
const isBlue = (p) => p[3] === 255 && near(p.slice(0, 3), BLUE, 12);

test('t7: -RenderIcons prints the size and both icons, as many pixels as the size says', opts, () => {
  const r = render(16);
  assert.equal(r.size, 16);
  assert.equal(r.running.rgba.length, 16 * 16 * 4);
  assert.equal(r.stopped.rgba.length, 16 * 16 * 4);
});

for (const size of [16, 32, 48]) {
  test(`t8 (${size} px): a dark gray rounded square with transparent corners, and the K in near-white`, opts, () => {
    const { running } = render(size);
    assert.equal(px(running, 0, 0)[3], 0, 'the corner is transparent');
    assert.equal(px(running, size - 1, size - 1)[3], 0, 'and so is the other one');
    assert.ok(near(px(running, Math.floor(size / 2), 0).slice(0, 3), BACK, 2) && px(running, Math.floor(size / 2), 0)[3] === 255, 'the square is dark gray, not black');
    const k = boxOf(running, isKey);
    assert.ok(k.h >= size * 0.55, `the K is tall enough (${k.h} of ${size})`);
    assert.ok(k.x0 < size / 2, 'on the left');
  });

  test(`t9 (${size} px): the dot is blue while running, light gray while stopped, in the same place and of a size that can be seen; nothing else changes`, opts, () => {
    const { running, stopped } = render(size);
    const blue = boxOf(running, isBlue);
    const dot = diffBox(running, stopped);
    const key = boxOf(running, isKey);
    assert.ok(blue.w >= Math.round(size * 0.18) && blue.h >= Math.round(size * 0.18), `the blue dot is at least ${Math.round(size * 0.18)} px (${blue.w}x${blue.h})`);
    assert.deepEqual([dot.x0, dot.y0, dot.w, dot.h], [blue.x0, blue.y0, blue.w, blue.h], 'the blue pixels are exactly the ones that change with the state');
    for (let y = dot.y0; y <= dot.y1; y++) for (let x = dot.x0; x <= dot.x1; x++) {
      assert.ok(px(running, x, y)[3] === 255 && near(px(running, x, y).slice(0, 3), BLUE, 1), `blue at ${x},${y} while running`);
      assert.ok(px(stopped, x, y)[3] === 255 && near(px(stopped, x, y).slice(0, 3), LIGHT, 1), `light gray at ${x},${y} while stopped`);
    }
    assert.equal(boxOf(stopped, isBlue).w, 0, 'no blue while stopped');
    assert.ok(blue.x0 > key.x1 - size * 0.12 && blue.y0 > size / 2 - 1, 'to the right of the K and in the lower half');
    assert.ok(Math.abs(blue.y1 - key.y1) <= 1, 'on the baseline of the K');
    let outside = 0;
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      const inDot = x >= blue.x0 && x <= blue.x1 && y >= blue.y0 && y <= blue.y1;
      if (!inDot && px(running, x, y).some((v, i) => v !== px(stopped, x, y)[i])) outside += 1;
    }
    assert.equal(outside, 0, 'the square and the K are the same in both states');
  });

  test(`t10 (${size} px): the drawing is centered in the icon (the K and the dot together), within one pixel`, opts, () => {
    const { running } = render(size);
    const k = boxOf(running, isKey);
    const d = boxOf(running, isBlue);
    const [x0, x1, y0, y1] = [Math.min(k.x0, d.x0), Math.max(k.x1, d.x1), Math.min(k.y0, d.y0), Math.max(k.y1, d.y1)];
    assert.ok(Math.abs((x0 + x1) / 2 - (size - 1) / 2) <= 1.01, `centered across (${x0}..${x1})`);
    assert.ok(Math.abs((y0 + y1) / 2 - (size - 1) / 2) <= 1.51, `centered down (${y0}..${y1})`);
  });
}

test('t10 (128 px): where a fraction of a pixel shows, the drawing is centered to half a pixel in both directions (the K starts at y = 1.8 in the units of the logo)', opts, () => {
  const { running } = render(128);
  const k = boxOf(running, isKey);
  const d = boxOf(running, isBlue);
  const [x0, x1, y0, y1] = [Math.min(k.x0, d.x0), Math.max(k.x1, d.x1), Math.min(k.y0, d.y0), Math.max(k.y1, d.y1)];
  assert.ok(Math.abs((x0 + x1) / 2 - 63.5) <= 0.51, `centered across (${x0}..${x1})`);
  assert.ok(Math.abs((y0 + y1) / 2 - 63.5) <= 0.51, `centered down (${y0}..${y1})`);
});

test('t11: the dot of the stopped icon is clearly lighter than the square, and it is not the white of the K', opts, () => {
  const { running, stopped } = render(32);
  const box = diffBox(running, stopped);
  assert.ok(box.w > 0, 'there is a dot that changes with the state');
  const dot = px(stopped, Math.round((box.x0 + box.x1) / 2), Math.round((box.y0 + box.y1) / 2));
  const mean = (c) => (c[0] + c[1] + c[2]) / 3;
  assert.ok(mean(dot) - mean(BACK) >= 100, `lighter than the square (${mean(dot)} vs ${mean(BACK)})`);
  assert.ok(mean(KEY) - mean(dot) >= 30, 'but not the white of the K');
});

test('t12: the K has no notch where its outline crosses itself (the winding rule), at both joints', opts, () => {
  const size = 128;
  const { running } = render(size);
  const scale = (size * 0.88) / 125.116;
  const offsetX = (size - 125.116 * scale) / 2;
  const offsetY = (size - 111.75 * scale) / 2 - 1.8 * scale;
  for (const [ux, uy] of [[13.45, 62.29], [39.79, 48.39]]) {
    const p = px(running, Math.floor(offsetX + ux * scale), Math.floor(offsetY + uy * scale));
    assert.ok(near(p.slice(0, 3), KEY, 3) && p[3] === 255, `solid at ${ux},${uy}: ${p}`);
  }
});

test('t13: the README says what the tray shows now and how to see it', () => {
  assert.match(readme, /RP187/);
  assert.match(readme, /blue dot/i);
  assert.match(readme, /light gray/i);
  assert.match(readme, /-RenderIcons/);
  assert.match(readme, /Quit tray/);
});
