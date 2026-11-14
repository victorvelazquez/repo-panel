'use strict';
// RP102 (tray): the icon in the notification area (scripts/tray.ps1) draws the K of the logo instead of an "R" typed with a font, and its texts say Kletus.dev. The badge
// keeps its colors: green while the panel runs, gray while it is stopped (that is what the icon is for). The K is the SAME polygon as the logo: its 14 points are read
// from public/icon.svg and compared with the ones in the script, so the two cannot drift apart. PowerShell only runs on Windows: the script is checked as text.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const tray = fs.readFileSync(path.join(ROOT, 'scripts', 'tray.ps1'), 'utf8').replace(/\r\n/g, '\n');
const icon = fs.readFileSync(path.join(ROOT, 'public', 'icon.svg'), 'utf8').replace(/\r\n/g, '\n');

// The points of the K, from its SVG path (M, H, V, L and Z only: straight lines).
function svgPoints(d) {
  const pts = [];
  let x = 0; let y = 0;
  for (const [, cmd, args] of d.matchAll(/([MHVLZ])([^MHVLZ]*)/g)) {
    const n = (args.match(/-?\d+(?:\.\d+)?(?:e-?\d+)?/g) || []).map(Number);
    if (cmd === 'M' || cmd === 'L') { [x, y] = n; pts.push([x, y]); } else if (cmd === 'H') { [x] = n; pts.push([x, y]); } else if (cmd === 'V') { [y] = n; pts.push([x, y]); }
  }
  // The path closes by going back to its first point: that last point is the first again, not a fifteenth vertex.
  const [f, l] = [pts[0], pts[pts.length - 1]];
  if (pts.length > 1 && Math.abs(f[0] - l[0]) < 0.001 && Math.abs(f[1] - l[1]) < 0.001) pts.pop();
  return pts;
}
const iconK = () => svgPoints(/\sd="([^"]+)"/.exec(icon)[1]);
const trayK = () => {
  const m = /\$kPoints\s*=\s*@\(([\s\S]*?)\n\s*\)\n/.exec(tray);
  assert.ok(m, 'the script lists the points of the K in $kPoints');
  return [...m[1].matchAll(/@\(\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*\)/g)].map((p) => [Number(p[1]), Number(p[2])]);
};

test('t1: the K of the tray is the same polygon as the K of the logo: the same 14 points, in the same order', () => {
  const a = iconK();
  const b = trayK();
  assert.equal(a.length, 14, 'the K of the logo has 14 points');
  assert.equal(b.length, a.length);
  a.forEach((p, i) => { assert.ok(Math.abs(p[0] - b[i][0]) < 0.001 && Math.abs(p[1] - b[i][1]) < 0.001, `point ${i}: ${p} vs ${b[i]}`); });
});

test('t2: the icon no longer types an "R": the K is drawn as a polygon, white, on a dark rounded square (RP187)', () => {
  assert.doesNotMatch(tray, /DrawString\(\s*'R'/);
  assert.match(tray, /FillPolygon\(\$keyBrush/);
  assert.match(tray, /FillPath\(\$backBrush/, 'the dark rounded square');
  assert.doesNotMatch(tray, /FillEllipse/, 'the round badge is gone');
  assert.doesNotMatch(tray, /an "R"/, 'the comment does not describe an R either');
});

test('t3: the state is the dot: blue while running, light gray while stopped; the square and the K do not change (RP187)', () => {
  assert.match(tray, /Running\s*=\s*\[System\.Drawing\.Color\]::FromArgb\(0, 127, 255\)/);
  assert.match(tray, /Stopped\s*=\s*\[System\.Drawing\.Color\]::FromArgb\((200, 205, 212|229, 115, 115)\)/, 'a light gray or a soft red: the person accepts either');
  assert.match(tray, /\$running = New-StateIcon \$colors\.Running/);
  assert.match(tray, /\$stopped = New-StateIcon \$colors\.Stopped/);
  assert.match(tray, /\$notify\.Icon = if \(\$script:healthy\) \{ \$running\.Icon \} else \{ \$stopped\.Icon \}/);
  assert.doesNotMatch(tray, /\$green|\$gray/, 'no more green and gray badge');
});

test('t4: the drawing is sized to the icon (not a fixed pixel count) and centered, so it follows the small-icon size of the screen', () => {
  assert.match(tray, /\$scale = \$Width \* \$fit \/ 125\.116/, 'the scale comes from the width of the icon and the width of the K with its dot');
  assert.match(tray, /\(\$Width - 125\.116 \* \$scale\) \/ 2/, 'centered across');
});

test('t5: the texts the person sees say Kletus.dev: the hover text (running and stopped) and the balloon title', () => {
  assert.match(tray, /"Kletus\.dev: running \(port \$\(\$script:port\)\)"/);
  assert.match(tray, /'Kletus\.dev: stopped'/);
  assert.match(tray, /ShowBalloonTip\(5000, 'Kletus\.dev'/);
  assert.doesNotMatch(tray, /'repo-panel: |"repo-panel: |ShowBalloonTip\(5000, 'repo-panel'/, 'no old visible text is left');
});

test('t6: the hover text still fits the 63 characters a notification icon allows, even with a long port', () => {
  const longest = 'Kletus.dev: running (port 65535)';
  assert.ok(longest.length <= 63, String(longest.length));
});

test('t7: what is not a name stays: the script still talks to the panel through its health route and the scheduled task keeps its name', () => {
  assert.match(tray, /health/i);
  const install = fs.readFileSync(path.join(ROOT, 'scripts', 'install-tray.ps1'), 'utf8');
  assert.match(install, /\$taskName\s*=/);
});
