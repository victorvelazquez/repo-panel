'use strict';
// RP88 (S9, S10), part 1 of 3: the Summary card fits a COLUMN of 20 to 25% of the screen (about 260 to 480 px). The markup keeps its two parts (.rs-l1 and
// .rs-l2) and only wraps the change chips in .rs-chips; the vertical layout is CSS: the list is a named container, so the width a query sees is the width of
// every card, and three widths decide the look: up to 320 px (no time), the stacked card (321 to 639 px) and the horizontal card of today (640 px or more).
// No information is lost. Work is not touched here. How it LOOKS is for the person to approve by looking; these tests pin structure, rules and information.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const R = require('../public/resumen.js');

const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'style.css'), 'utf8').replace(/\r\n/g, '\n');
const NOW = Date.UTC(2026, 4, 1, 12, 0, 0);
const C = (o = {}) => ({ files: 0, added: 0, deleted: 0, ahead: 0, behind: 0, noUpstream: false, ...o });
const row = (o = {}) => ({
  id: 'r1', name: 'alpha', group: 'g', room: null, branch: 'feat/x', needs: false, rank: 9,
  progress: { total: 4, completada: 1, enRevision: 0, bloqueada: 0, pendiente: 3, enCurso: 0 },
  next: { id: 'B2b', entrega: 'Validate the ownerId', resultadoVisible: 'Photos are rejected' }, blocking: [],
  lastMovement: { at: new Date(NOW - 12 * 60000).toISOString(), what: 'commit' }, session: { state: 'free' }, action: { kind: 'start' }, ...o,
});
const view = (rows, ctx = {}) => R.summaryView({ rows, generatedAt: 't' }, { now: NOW, scope: { kind: 'all' }, rooms: [], changesFor: () => null, flowFor: () => null, sending: {}, busy: {}, ...ctx });
const cardOf = (html) => /<article class="rs-card[^>]*>[\s\S]*?<\/article>/.exec(html)[0];
// The body of the first block that starts with `head` (balanced braces), or ''.
function block(head) {
  const i = css.indexOf(head);
  if (i < 0) return '';
  const open = css.indexOf('{', i);
  let depth = 0;
  for (let j = open; j < css.length; j++) {
    if (css[j] === '{') depth++;
    else if (css[j] === '}' && --depth === 0) return css.slice(open + 1, j);
  }
  return '';
}

// ---------- markup ----------
test('v1: the card keeps its two parts, and the change chips travel together in one wrapper inside the first one', () => {
  const html = cardOf(view([row()], { changesFor: () => C({ files: 2, added: 5, deleted: 1, ahead: 1 }) }));
  assert.match(html, /^<article class="rs-card" data-id="r1"[^>]*>\s*<div class="rs-l1">[\s\S]*<\/div>\s*<div class="rs-l2">/);
  const l1 = /<div class="rs-l1">([\s\S]*?)<\/div>\s*<div class="rs-l2">/.exec(html)[1];
  const chips = /<span class="rs-chips">([\s\S]*?)<\/span><span class="rs-spacer">/.exec(l1);
  assert.ok(chips, 'the wrapper sits right before the spacer, where the chips always were');
  assert.match(chips[1], /chip yellow chip-btn/);
  assert.match(chips[1], /chip blue/);
  assert.ok(l1.indexOf('rs-branch') < l1.indexOf('rs-chips') && l1.indexOf('rs-chips') < l1.indexOf('rs-when'), 'name, branch, chips, then the time and the session as before');
});

test('v2: no chips, no wrapper (so the card has no empty gap), and an errored row has none either', () => {
  assert.doesNotMatch(cardOf(view([row()])), /rs-chips/);
  assert.doesNotMatch(cardOf(view([row({ error: 'git failed' })], { changesFor: () => C({ files: 3 }) })), /rs-chips/);
});

test('v3: the manual-action chip is inside the wrapper too', () => {
  const html = cardOf(view([row({ action: { kind: 'manual', label: 'x' } })]));
  assert.match(html, /<span class="rs-chips"><span class="chip red">▲ manual action<\/span><\/span>/);
});

test('v4: nothing is lost: name, branch, time, session, chips, progress, next unit and the action are all still on the card', () => {
  const html = cardOf(view([row({ action: { kind: 'deliver' } })], { changesFor: () => C({ files: 1, added: 2, deleted: 0 }), flowFor: () => ({ cmd: 'flow-commit', label: '/flow-commit' }) }));
  for (const part of [/<b class="rs-name" title="alpha">alpha<\/b>/, /class="mono rs-branch" title="feat\/x">feat\/x</, /12 min ago/, /○ free/, /chip yellow chip-btn/, /class="rs-prog"/, /class="rs-bar"/, /class="rs-next"/, /Validate the ownerId/, /data-cmd="flow-commit"/]) assert.match(html, part, String(part));
});

test('v5: the hooks that other code relies on survive: data-id, the chat opening, focus, aria-current, aria-label and the ask and block classes', () => {
  const html = view([row({ session: { state: 'waiting' } }), row({ id: 'r2', name: 'beta', next: null, blocking: [{ unit: 'T4', waitsFor: ['T3'] }] })], { chatId: 'r1' });
  assert.match(html, /<article class="rs-card ask" data-id="r1" data-act="chat-open" tabindex="0" aria-current="true" aria-label="alpha">/);
  assert.match(html, /<article class="rs-card block" data-id="r2" data-act="chat-open" tabindex="0" aria-label="beta">/);
});

test('v6: the loading card and the room card still draw (the new CSS applies to them too)', () => {
  assert.match(view([{ id: 'l1', name: 'loady', loading: true }]), /<article class="rs-card rs-loading" data-id="l1"/);
  const room = R.summaryView({ rows: [row({ room: 'UPEN' })], generatedAt: 't' }, { now: NOW, scope: { kind: 'all' }, rooms: [{ name: 'UPEN', repos: ['r1'] }], roomData: { rooms: [{ name: 'UPEN', repos: ['r1'], presence: { state: 'idle' }, lastCommit: null }] }, changesFor: () => null });
  assert.match(room, /rs-card rs-room/);
});

// ---------- css ----------
test('c1: the list is a named container, so a query measures the width of the cards; the panel is no longer one', () => {
  assert.match(block('.rs-list {'), /container-type:\s*inline-size/);
  assert.match(block('.rs-list {'), /container-name:\s*cards/);
  assert.doesNotMatch(block('.rs-panel {'), /container-type/);
  assert.doesNotMatch(css, /@container \(max-width:\s*520px\)/, 'the old query that measured the whole list is gone');
});

test('c2: the default is the stacked card: the first part wraps, the name clips with an ellipsis, the chips take their own full line, the second part is one column', () => {
  assert.match(block('.rs-l1 {'), /flex-wrap:\s*wrap/);
  assert.match(block('.rs-name {'), /min-width:\s*0/);
  assert.match(block('.rs-name {'), /text-overflow:\s*ellipsis/);
  assert.match(block('.rs-name {'), /overflow:\s*hidden/);
  assert.match(block('.rs-chips {'), /display:\s*flex/);
  assert.match(block('.rs-chips {'), /flex-wrap:\s*wrap/);
  assert.match(block('.rs-chips {'), /flex:\s*1 1 100%/);
  assert.match(block('.rs-l2 {'), /grid-template-columns:\s*minmax\(0, 1fr\)/);
  assert.doesNotMatch(block('.rs-l2 {'), /minmax\(110px/);
});

test('c3: the action button takes the full width of the stacked card', () => {
  assert.match(block('.rs-l2 button {'), /width:\s*100%/);
});

test('c4: from 640 px the card is the horizontal one of today again: one line, the old three columns, the button at its natural width', () => {
  const wide = block('@container cards (min-width: 640px)');
  assert.ok(wide, 'a container rule for 640 px or more');
  assert.match(wide, /\.rs-l1\s*\{[^}]*flex-wrap:\s*nowrap/);
  assert.match(wide, /\.rs-chips\s*\{[^}]*flex:\s*0 1 auto/);
  assert.match(wide, /\.rs-branch\s*\{[^}]*max-width:\s*26ch/, 'a long branch name does not squeeze the chips onto a second line');
  assert.match(wide, /\.rs-l2\s*\{[^}]*grid-template-columns:\s*minmax\(110px, 170px\) minmax\(0, 1fr\) auto/);
  assert.match(wide, /\.rs-l2 button\s*\{[^}]*width:\s*auto/);
});

test('c5: up to 320 px the time of the last movement is dropped (it is also the tooltip of the card), nothing else', () => {
  const tiny = block('@container cards (max-width: 320px)');
  assert.ok(tiny, 'a container rule up to 320 px');
  assert.match(tiny, /\.rs-when\s*\{[^}]*display:\s*none/);
  assert.equal((tiny.match(/display:\s*none/g) || []).length, 1);
});

test('c6: the card keeps its look: the border rule, the ask and block borders and the keyboard focus', () => {
  assert.match(block('.rs-card {'), /border:\s*1px solid #222a33/);
  assert.match(css, /\.rs-card\.ask\s*\{[^}]*border-left:[^}]*var\(--yellow\)/);
  assert.match(css, /\.rs-card\.block\s*\{[^}]*border-left:[^}]*var\(--red\)/);
  assert.match(css, /\.rs-card[^{]*:focus-visible|\.rs-panel :focus-visible/);
});

test('c7: only container queries decide the card: no media query touches the Summary card rules', () => {
  const media = [...css.matchAll(/@media[^{]*\{/g)].map((m) => m.index);
  for (const i of media) assert.doesNotMatch(block(css.slice(i, i + 200)), /\.rs-l1|\.rs-l2|\.rs-chips|\.rs-name/);
});
