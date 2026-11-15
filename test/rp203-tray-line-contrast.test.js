'use strict';
// RP203 (S5): the thin line of the tray icon (RP199) must be SEEN where the icon is shown. On 15 November the person looked at the real icon in the menu of hidden icons of Windows and said the square looked
// smaller: the line was #2a323c (42, 50, 60, the --line of the page) and the background of that menu is (44, 47, 52), the same tone, so the line was invisible, the visible square lost a ring of pixels and the
// icon looked smaller. The line is now #3a4553 (58, 69, 83), the border of the cards of the page, which shows against that menu, against a gray taskbar and against a nearly black one. These tests measure what is
// SEEN: the icon is drawn over each background (with its alpha) and the width of what differs from the background is read. How the real icon LOOKS is for the person to try.
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

// The backgrounds where the icon is seen: the menu of hidden icons of Windows (measured in the screenshot of the person), a gray taskbar and a nearly black one.
const BACKGROUNDS = { 'menu of hidden icons': [44, 47, 52], 'gray taskbar': [32, 32, 32], 'nearly black taskbar': [14, 14, 16] };
const mean = (c) => (c[0] + c[1] + c[2]) / 3;
const LINE = (/Line\s*=\s*\[System\.Drawing\.Color\]::FromArgb\((\d+), (\d+), (\d+)\)/.exec(tray) || []).slice(1).map(Number);

// ---------- the script, as text (any system) ----------
test('c1: the line is #3a4553 (58, 69, 83), a color of the page itself (the border of its cards), and it is no longer the --line of the page', () => {
  assert.deepEqual(LINE, [58, 69, 83]);
  assert.ok(/#3a4553/i.test(style), 'the page uses that color');
  assert.ok(!/Line\s*=\s*\[System\.Drawing\.Color\]::FromArgb\(42, 50, 60\)/.test(tray), 'the old, invisible one is gone');
});

test('c2: the line is told apart from each background where the icon is seen: at least 18 levels of difference on average, and it is still darker than the K', () => {
  assert.equal(LINE.length, 3);
  for (const [name, bg] of Object.entries(BACKGROUNDS)) assert.ok(Math.abs(mean(LINE) - mean(bg)) >= 18, `${name}: line ${mean(LINE).toFixed(0)} against ${mean(bg).toFixed(0)}`);
  assert.ok(mean(LINE) < mean([250, 251, 252]) - 100, 'it stays a quiet line, far from the white of the K');
});

test('c3: the comment of the script says why, with the measured background, and the README says it too', () => {
  assert.match(tray, /#3a4553/);
  assert.match(tray, /44, 47, 52/);
  assert.match(readme, /RP203/);
  assert.match(readme, /lighter in RP203: `#3a4553`/);
  assert.match(readme, /44, 47, 52/);
});

// ---------- what is SEEN (Windows) ----------
const cache = new Map();
function render(size) {
  if (cache.has(size)) return cache.get(size);
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', TRAY, '-RenderIcons', String(size)], { encoding: 'utf8', timeout: 90000, maxBuffer: 128 * 1024 * 1024 });
  assert.equal(r.status, 0, `${r.stderr}${r.stdout.slice(0, 300)}`);
  const j = JSON.parse(r.stdout);
  cache.set(size, j);
  return j;
}
// The icon drawn over a background: what the person sees.
const over = (rgba, size, x, y, bg) => { const i = (y * size + x) * 4; const a = rgba[i + 3] / 255; return [0, 1, 2].map((k) => rgba[i + k] * a + bg[k] * (1 - a)); };
// Width and height of what differs from the background (by at least 10 levels on average) along the middle row and the middle column.
function seen(rgba, size, bg) {
  const mid = Math.floor(size / 2);
  const differs = (x, y) => Math.abs(mean(over(rgba, size, x, y, bg)) - mean(bg)) >= 10;
  const span = (get) => { let a = -1; let b = -1; for (let k = 0; k < size; k++) if (get(k)) { if (a < 0) a = k; b = k; } return a < 0 ? 0 : b - a + 1; };
  return { w: span((x) => differs(x, mid)), h: span((y) => differs(mid, y)) };
}

for (const size of [16, 24, 32]) {
  for (const [name, bg] of Object.entries(BACKGROUNDS)) {
    test(`c4 (${size} px, ${name}): the square is seen at its whole size, edge to edge, in both directions: the line is not lost against the background`, opts, () => {
      const { running } = render(size);
      const s = seen(running, size, bg);
      assert.equal(s.w, size, `seen width ${s.w} of ${size}`);
      assert.equal(s.h, size, `seen height ${s.h} of ${size}`);
    });
  }
}

test('c5: the stopped icon has the same line, so the square looks the same size in both states', opts, () => {
  for (const size of [16, 24]) {
    const { running, stopped } = render(size);
    const bg = BACKGROUNDS['menu of hidden icons'];
    assert.deepEqual(seen(stopped, size, bg), seen(running, size, bg));
  }
});

test('c6: the K and the dot are the ones of RP199: this only changes the color of the line', opts, () => {
  const { running } = render(32);
  const px = (x, y) => { const i = (y * 32 + x) * 4; return [running[i], running[i + 1], running[i + 2], running[i + 3]]; };
  const mid = 16;
  assert.deepEqual(px(mid, 0).slice(0, 3), [58, 69, 83], 'the top edge is the line');
  assert.deepEqual(px(mid, 1).slice(0, 3), [15, 18, 22], 'and just inside it is the dark of the panel');
  let blue = 0;
  for (let y = 0; y < 32; y++) for (let x = 0; x < 32; x++) { const p = px(x, y); if (p[3] === 255 && Math.abs(p[0]) < 12 && Math.abs(p[1] - 127) < 12 && Math.abs(p[2] - 255) < 12) blue += 1; }
  assert.ok(blue >= 25, `the blue dot is still there (${blue} px)`);
});
