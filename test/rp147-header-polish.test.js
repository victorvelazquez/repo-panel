'use strict';
// RP147 (S37): the polish of the header. (1) An OLD usage file shows a small yellow dot with a help text that says how old the data is, instead of the loose text «N min ago» next to the meters
// (the meters stay grey). (2) The title of every Merge button says the method in use and where it is changed (Settings, Delivery), because the Merge menu left the header (RP143).
// What does NOT change: when the Merge button is enabled, its label, the hold reason as the whole title, and the text of the popover of the usage.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const V = require('../public/view.js');

const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'style.css'), 'utf8').replace(/\r\n/g, '\n');
const NOW = Date.UTC(2026, 10, 10, 12, 0, 0);
const win = (percent, hours) => ({ percent, resetAt: NOW + hours * 3600000 });
const usage = (extra) => ({ available: true, five: win(44, 2), seven: win(23, 40), updatedAt: NOW - 20 * 60000, ...extra });
const html = (u) => V.usageHtml(V.usageView(u, { now: NOW, timeZone: 'UTC' }));
const meters = (h) => h.slice(0, h.indexOf('<div class="usage-pop"'));

test('u1: an old usage file shows ONE yellow dot with a help text of its age, hidden from assistive tools, and no loose «min ago» next to the meters', () => {
  const h = html(usage({ stale: true }));
  const dots = meters(h).match(/<span class="um-old"[^>]*><\/span>/g) || [];
  assert.equal(dots.length, 1);
  assert.match(dots[0], /aria-hidden="true"/);
  assert.match(dots[0], /title="Usage data is 20 min old"/);
  assert.ok(!/min ago|h ago/.test(meters(h)), 'no loose age text');
  assert.ok(!h.includes('um-age'));
  assert.ok(meters(h).indexOf('um-old') < meters(h).indexOf('class="um '), 'the dot comes first, as in the design');
});

test('u2: the age reads in hours when it is an hour or more, and the dot is absent when the data is fresh, missing or has no age', () => {
  assert.match(html(usage({ stale: true, updatedAt: NOW - 3 * 3600000 })), /title="Usage data is 3 h old"/);
  assert.ok(!html(usage()).includes('um-old'), 'fresh data: no dot');
  assert.ok(!html({ available: false }).includes('um-old'), 'no data: no dot');
  assert.ok(!html(usage({ stale: true, updatedAt: undefined })).includes('um-old'), 'an old file without an age says nothing it cannot back');
});

test('u3: what stays: the meters of an old file are still dim, and the popover keeps its note and its «Updated … ago» line', () => {
  const h = html(usage({ stale: true }));
  assert.equal((h.match(/class="um usage-dim"/g) || []).length, 2);
  assert.match(h, /<div class="up-note">The usage file is old: the numbers may have changed\.<\/div>/);
  assert.match(h, /<div class="up-foot">Updated 20 min ago<\/div>/);
});

test('u4: the CSS draws the dot yellow and round, and the old text rule is gone', () => {
  const rule = (css.match(/(?:^|\n)\.um-old\s*\{([^}]*)\}/) || [])[1] || '';
  assert.match(rule, /background:\s*var\(--yellow\)/);
  assert.match(rule, /border-radius:\s*50%/);
  assert.match(rule, /width:\s*8px/);
  assert.ok(!/\.um-age\b/.test(css), 'no dead rule');
});

const PR = (extra) => ({ ready: true, base: 'main', ...extra });
const HINT = (m) => `Method: ${m}. Change it in Settings, Delivery.`;

test('m1: the title of a ready Merge button names the base, the method and where it is changed; the three methods and the default', () => {
  for (const m of ['squash', 'merge', 'rebase']) assert.equal(V.mergeButton(PR(), { method: m }).title, `Merge into main. ${HINT(m)}`);
  assert.equal(V.mergeButton(PR(), {}).title, `Merge into main. ${HINT('squash')}`);
});

test('m2: a method that is not one of the three never reaches the title (no text from outside)', () => {
  for (const m of ['<img src=x onerror=1>', 'fast-forward', '', null, 7, {}]) assert.equal(V.mergeButton(PR(), { method: m }).title, `Merge into main. ${HINT('squash')}`, String(m));
});

test('m3: a blocked PR and a missing PR keep their reason and add the hint; a hold is the WHOLE title, unchanged', () => {
  assert.equal(V.mergeButton(PR({ ready: false, blockedReason: 'CI is failing' }), { method: 'merge' }).title, `CI is failing. ${HINT('merge')}`);
  assert.equal(V.mergeButton(PR({ ready: false }), {}).title, `Not ready to merge. ${HINT('squash')}`);
  assert.equal(V.mergeButton(null, { method: 'rebase' }).title, `No open pull request for this branch. ${HINT('rebase')}`);
  assert.equal(V.mergeButton(null, { noPr: 'Nothing to merge', method: 'rebase' }).title, `Nothing to merge. ${HINT('rebase')}`);
  assert.equal(V.mergeButton(PR(), { hold: 'A merge is running', method: 'rebase' }).title, 'A merge is running');
});

test('m4: when the button is enabled and its label do not change (the previous rule, case by case)', () => {
  const cases = [
    [PR(), {}, true, 'Merge · squash'], [PR(), { method: 'rebase' }, true, 'Merge · rebase'], [PR({ ready: false }), {}, false, 'Merge · squash'],
    [PR(), { busy: true }, false, 'Merging…'], [PR(), { busy: 'done' }, false, 'Merged ✓'], [PR(), { held: true }, false, 'Merged ✓'], [PR(), { hold: 'x' }, false, 'Merge · squash'],
    [null, { method: 'merge' }, false, 'Merge · merge'], [{ ready: 'yes' }, {}, false, 'Merge · squash'], [[], {}, false, 'Merge · squash'],
  ];
  for (const [pr, ctx, enabled, label] of cases) { const b = V.mergeButton(pr, ctx); assert.equal(b.enabled, enabled, JSON.stringify([pr, ctx])); assert.equal(b.label, label, JSON.stringify([pr, ctx])); }
});
