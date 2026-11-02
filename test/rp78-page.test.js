'use strict';
// RP78 (S68, S73), point 8: the Summary page with rows from the memory store. A row with `loading: true` is a calm placeholder card (the repo
// name and "Loading…", no button, no action); a row with `stale: { facts }` is a normal card plus a small "Updating…" marker whose title names
// the facts. Pure payload-in, HTML-out, as test/rp59-cards.test.js; the wording says "session", never "pi".
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-panel-rp78p-'));
process.env.REPO_PANEL_CONFIG = path.join(dir, 'config.json');
process.env.REPO_PANEL_CASES_FILE = 'off';

const test = require('node:test');
const assert = require('node:assert/strict');
const R = require('../public/resumen.js');

test.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 }));

const NOW = Date.parse('2026-05-01T12:00:00Z');
const BAD = '<img src=x onerror=alert(1)>';
const NO_PROGRESS = { total: null, completada: null, enRevision: null, bloqueada: null, pendiente: null, enCurso: null };
const row = (o = {}) => ({
  id: 'r1', name: 'alpha', group: 'G1', room: null, branch: 'main', progress: { total: 74, completada: 30, enRevision: 1, bloqueada: 0, pendiente: 43, enCurso: 0 },
  session: { state: 'free' }, next: { id: 'B2b', entrega: 'Validate the ownerId', resultadoVisible: 'Photos are rejected' }, blocking: [],
  lastMovement: { at: '2026-05-01T11:48:00Z', what: 'fix: thing' }, action: null, error: null, needs: false, rank: 9, ...o,
});
const loading = (o = {}) => row({
  id: 'l1', name: 'loady', loading: true, branch: null, progress: NO_PROGRESS, session: { state: 'unknown' }, next: null,
  lastMovement: { at: null, what: null }, rank: 99, ...o,
});
const view = (rows, ctx = {}) => R.summaryView({ rows, counts: {}, attention: [], generatedAt: '2026-05-01T12:00:00Z' }, { now: NOW, scope: { kind: 'all' }, rooms: [], ...ctx });
const cardOf = (html, id) => (new RegExp(`<article class="rs-card[^"]*"[^>]* data-id="${id}"[\\s\\S]*?</article>`).exec(html) || [''])[0];
// RP94b: the "Updating…" text is gone; the card carries the tooltip with the facts and aria-busy.
const marker = (html) => (/^<article class="rs-card[^"]*"[^>]* title="([^"]*)" aria-busy="true">/.exec(html) ? [null, null, /title="Updating: ([^"]*)" aria-busy="true">/.exec(html)[1]] : null);

// ---------- loading ----------
test('a loading row is a calm placeholder card: the repo name and "Loading…", no button, no action, no error look', () => {
  const html = view([loading()]);
  const card = cardOf(html, 'l1');
  assert.notEqual(card, '', 'the card exists, with its data-id');
  assert.match(card, /<b class="rs-name" title="loady">loady<\/b>/);
  assert.match(card, /Loading…/);
  assert.doesNotMatch(card, /<button|data-act=|data-cmd=/);
  assert.doesNotMatch(card, /▲ error|no data|\? unknown|Open<|rs-err|chip red|rs-bar|Updating…/);
  assert.doesNotMatch(card, /\bpi\b/i);
});

test('a loading row is never shown as needing attention and does not hide its neighbours; order is kept', () => {
  const html = view([row({ id: 'a1', name: 'first', action: { kind: 'merge', label: 'Merge #1', pr: 1 } }), loading(), row({ id: 'z9', name: 'last' })]);
  assert.deepEqual([...html.matchAll(/<article class="rs-card[^"]*"[^>]* data-id="([^"]*)"/g)].map((m) => m[1]), ['a1', 'l1', 'z9']);
  assert.match(cardOf(html, 'a1'), /<button/, 'a real row keeps its own look');
  assert.match(view([loading({ needs: false }), row({ id: 'n1', needs: true })], { filter: 'attention' }), /data-id="n1"/);
  assert.doesNotMatch(view([loading({ needs: false })], { filter: 'attention' }), /data-id="l1"/);
});

test('a loading row escapes its name and group', () => {
  const html = view([loading({ name: BAD, group: BAD })]);
  assert.doesNotMatch(html, /<img/);
  assert.match(html, /&lt;img/);
});

// ---------- stale ----------
test('a stale row is a normal card marked busy (RP94b: no "Updating…" text) whose tooltip names the stale facts', () => {
  const plain = cardOf(view([row({ action: { kind: 'merge', label: 'Merge #9', pr: 9 } })]), 'r1');
  const html = view([row({ action: { kind: 'merge', label: 'Merge #9', pr: 9 }, stale: { facts: ['prs', 'local'] } })]);
  const card = cardOf(html, 'r1');
  const m = marker(card);
  assert.ok(m, 'the card is marked busy, with its tooltip');
  assert.match(m[2], /prs/);
  assert.match(m[2], /local/);
  assert.match(card, /<button class="merge"/, 'the action is still offered');
  assert.match(card, /30 of 74 completed/, 'the progress is still shown (in its title and aria-label)');
  assert.equal(card.replace(/ title="Updating: [^"]*" aria-busy="true">/, '>'), plain, 'nothing else changes in the card');
});

test('no "Updating…" without stale or with an empty list of facts; a loading row never carries it', () => {
  assert.doesNotMatch(view([row()]), /Updating…/);
  assert.doesNotMatch(view([row({ stale: { facts: [] } })]), /Updating…/);
  assert.doesNotMatch(view([loading({ stale: { facts: ['prs'] } })]), /Updating…/);
});

test('the stale tooltip escapes the fact names and says "session", never "pi"', () => {
  const html = cardOf(view([row({ stale: { facts: [BAD, 'session'] } })]), 'r1');
  assert.doesNotMatch(html, /<img/);
  assert.match(marker(html)[2], /&lt;img/);
  assert.doesNotMatch(marker(html)[2], /\bpi\b/i);
});

test('the resumen.js source keeps the wording rule: no visible "pi session", "pi screen", "Gentle Shell"', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'resumen.js'), 'utf8');
  assert.doesNotMatch(src.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n'), /\b[Pp]i (?:sessions?|prompt|screens?|terminals?|orders?)\b|Gentle Shell/);
});
