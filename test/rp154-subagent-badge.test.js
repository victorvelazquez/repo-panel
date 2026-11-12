'use strict';
// RP154 (S54, S55): the card of a repo in the Summary list shows a badge when its session has subagents (what the server of RP164 puts in `row.session.subagents`: `{ signal, list: [{ name, state, minutes, idle }] }`), in the
// same words and colours as the chat head («Subagent working», blue), plus «Slow» (yellow), «Possible block» (red) and «No signal» (gray); the badge is a button that opens the list of the subagents of that repo (name, state, time)
// under the card; without subagents there is no badge. It only SHOWS: it never holds or releases a delivery button. The page trusts nothing: the closed list of states, whole numbers from 0 to 9999, at most 5 entries,
// every text escaped. Not included (decisions of the person, 12 November): the subagents that already finished (the server of RP164 only carries the live ones) and the notice of a failing automatic fetch.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const R = require('../public/resumen.js');
const V = require('../public/view.js');

const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'style.css'), 'utf8').replace(/\r\n/g, '\n');
const row = (name, session, o = {}) => ({ id: `id-${name}`, name, group: 'G', room: null, branch: 'main', needs: false, rank: 9, progress: { total: null }, next: null, blocking: [], lastMovement: {}, session, ...o });
const sub = (o = {}) => ({ name: 'scout', state: 'working', minutes: 3, idle: 0, ...o });
const withSubs = (list, signal = true, state = 'working') => ({ state, subagents: { signal, list } });
const card = (session, ctx = {}) => R.summaryView({ rows: [row('r1', session)], generatedAt: 'x' }, ctx);
const text = (html) => html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
const badge = (html) => { const m = /<button[^>]*class="chip sub-badge[^"]*"[\s\S]*?<\/button>/.exec(html); return m ? m[0] : ''; };

// ---------- abuse first ----------
test('a1: ABUSE: hostile names and numbers never reach the markup: the name is escaped, an entry with a state outside the list, or a number that is not a whole 0..9999, is left out', () => {
  const bad = [
    sub({ name: '<img src=x onerror=alert(1)>' }), sub({ state: 'running' }), sub({ state: '__proto__' }), sub({ minutes: -1 }), sub({ minutes: 1.5 }), sub({ minutes: 1e9 }), sub({ minutes: '3' }), sub({ idle: NaN }),
    sub({ idle: Infinity }), sub({ minutes: null }), null, 5, 'x', [], {},
  ];
  const html = card(withSubs(bad), { subsOpen: { 'id-r1': true } });
  assert.doesNotMatch(html, /<img|NaN|Infinity|undefined|\[object|__proto__/); // the escaped name still holds the text onerror: inert
  const li = (html.match(/<li class="rs-sub-item/g) || []).length;
  assert.equal(li, 1, 'only the entry with the hostile NAME survives (a name is text: escaped, never markup)');
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
});

test('a2: ABUSE: what is not an object, a list that is not a list, a signal that is not a boolean: no badge, no list, no error', () => {
  for (const s of [{ state: 'working', subagents: null }, { state: 'working', subagents: 'x' }, { state: 'working', subagents: [] }, { state: 'working', subagents: { signal: true, list: 'x' } }, { state: 'working', subagents: { signal: 'yes', list: [sub()] } },
    { state: 'working', subagents: { signal: true } }, { state: 'working', subagents: { signal: true, list: [] } }, { state: 'working', subagents: { signal: false, list: 'x' } }, { state: 'working' }, undefined, null, 5, 'x']) {
    const html = card(s, { subsOpen: { 'id-r1': true } });
    assert.equal(badge(html), '', JSON.stringify(s));
    assert.doesNotMatch(html, /rs-subs/, JSON.stringify(s));
  }
});

test('a3: ABUSE: more than five subagents list five; the badge counts the ones it can draw (never the raw length)', () => {
  const list = Array.from({ length: 9 }, (_, i) => sub({ name: `a${i}`, minutes: i }));
  const html = card(withSubs(list), { subsOpen: { 'id-r1': true } });
  assert.equal((html.match(/<li class="rs-sub-item/g) || []).length, 5);
  assert.match(text(badge(html)), /5 subagents/);
});

test('a4: ABUSE: a session that is not started or unknown never shows the badge, even if the row carries subagents (the server only sends them for a live one: the page does not trust it)', () => {
  for (const state of ['none', 'unknown', 'bogus', 5, undefined]) assert.equal(badge(card({ state, subagents: { signal: true, list: [sub()] } })), '', String(state));
});

// ---------- the badge ----------
test('b1: working: «Subagent working» in blue with the drawn arrow; two: «2 subagents working»; the title explains it; it is a button with aria-expanded=false', () => {
  const one = badge(card(withSubs([sub()])));
  assert.match(one, /^<button type="button" class="chip sub-badge sb-working" data-act="subs-toggle" data-id="id-r1" aria-expanded="false" title="[^"]+">/);
  assert.match(one, /<svg [^>]*aria-hidden="true"/);
  assert.equal(text(one), 'Subagent working');
  assert.equal(text(badge(card(withSubs([sub(), sub({ name: 'b' })])))), '2 subagents working');
});

test('b2: the worst state names the badge (stuck, then slow, then working), with its own tone; no signal says so and lists nobody', () => {
  const t = (list, signal) => { const b = badge(card(withSubs(list, signal))); return [text(b), (/sb-(\w+)/.exec(b) || [])[1]]; };
  assert.deepEqual(t([sub(), sub({ state: 'slow', idle: 3 })]), ['2 subagents · slow', 'slow']);
  assert.deepEqual(t([sub({ state: 'slow', idle: 3 }), sub({ state: 'stuck', idle: 6 }), sub()]), ['3 subagents · possible block', 'stuck']);
  assert.deepEqual(t([sub({ state: 'stuck', idle: 6 })]), ['Possible block', 'stuck']);
  assert.deepEqual(t([sub({ state: 'slow', idle: 3 })]), ['Slow', 'slow']);
  assert.deepEqual(t([], false), ['No signal', 'nosignal']);
});

test('b3: with the list open the badge says aria-expanded=true and the list sits under the card with the name, the state and the time of each subagent, the oldest as the server sent them', () => {
  const html = card(withSubs([sub({ name: 'scout', minutes: 6, idle: 5, state: 'stuck' }), sub({ name: 'writer', minutes: 2, idle: 0 })]), { subsOpen: { 'id-r1': true } });
  assert.match(badge(html), /aria-expanded="true"/);
  const items = [...html.matchAll(/<li class="rs-sub-item[^"]*">([\s\S]*?)<\/li>/g)].map((m) => text(m[1]));
  assert.deepEqual(items, ['scout possible block 6 min · idle 5 min', 'writer working 2 min']);
  assert.match(html, /<ul class="rs-subs" aria-label="Subagents of this repo">/);
});

test('b4: no signal opens to one line that says why, never a list; the closed list never shows when subsOpen is not for this card', () => {
  const html = card(withSubs([], false), { subsOpen: { 'id-r1': true } });
  assert.match(html, /<p class="rs-subs rs-subs-none">[^<]*no signal/i);
  assert.doesNotMatch(card(withSubs([sub()]), { subsOpen: { 'id-other': true } }), /rs-subs/);
  assert.doesNotMatch(card(withSubs([sub()]), {}), /rs-subs/);
  for (const v of ['true', 1, [], null]) assert.doesNotMatch(card(withSubs([sub()]), { subsOpen: v }), /rs-subs/, String(v));
});

test('b5: without subagents the card is the card of always (the same markup as a row with no `subagents` key)', () => {
  const plain = card({ state: 'working' });
  assert.equal(card({ state: 'working', subagents: undefined }), plain);
  assert.doesNotMatch(plain, /sub-badge|rs-subs/);
});

// ---------- it only shows ----------
test('h1: the badge never holds or releases a delivery button: the hold of a row is the same with and without subagents', () => {
  const hold = (session) => V.deliveryHold({ session: session.state, jobs: 0 });
  for (const state of ['busy', 'idle', 'asking', 'closed']) assert.equal(hold({ state }), V.deliveryHold({ session: state, jobs: 0 }), state);
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'view.js'), 'utf8') + fs.readFileSync(path.join(__dirname, '..', 'public', 'tabs.js'), 'utf8');
  assert.doesNotMatch(src, /subagents/, 'the files that hold the buttons never read the subagents');
});

// ---------- the click ----------
function pageWith() {
  const S = { subsOpen: {}, slive: false };
  const calls = { draw: 0 };
  const ctx = vm.createContext({ S, draw: () => { calls.draw += 1; }, console, localStorage: { getItem: () => null, setItem() {} } });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'public', 'actions.js'), 'utf8').replace(/\r\n/g, '\n'), ctx, { filename: 'actions.js' });
  return { S, calls, ctx };
}
test('k1: the action toggles the list of ONE card, redraws once, and an id that is not a string changes nothing', () => {
  const page = pageWith();
  const act = vm.runInContext('ACTIONS["subs-toggle"]', page.ctx);
  assert.equal(typeof act, 'function');
  act({ dataset: { id: 'id-r1' } });
  assert.deepEqual({ ...page.S.subsOpen }, { 'id-r1': true });
  assert.equal(page.calls.draw, 1);
  act({ dataset: { id: 'id-r1' } });
  assert.deepEqual({ ...page.S.subsOpen }, {});
  for (const bad of [{}, { dataset: {} }, { dataset: { id: 5 } }, { dataset: { id: '' } }, { dataset: { id: '__proto__' } }, null, undefined]) { const before = page.calls.draw; act(bad); assert.equal(page.calls.draw, before, JSON.stringify(bad)); }
  assert.deepEqual({ ...page.S.subsOpen }, {});
  assert.equal(Object.getPrototypeOf(page.S.subsOpen) === Object.prototype || Object.getPrototypeOf(page.S.subsOpen) === null, true);
});

test('k2: the summary view receives the open lists from the page state', () => {
  const tabs = fs.readFileSync(path.join(__dirname, '..', 'public', 'tabs.js'), 'utf8');
  assert.match(tabs, /subsOpen: S\.subsOpen/);
  assert.match(fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8'), /subsOpen: \{\}/);
});

// ---------- the look ----------
const rule = (sel) => { const m = new RegExp(`(?:^|\\n)${sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`).exec(css); assert.ok(m, `a rule for ${sel}`); return m[1]; };
test('s1: the tones are the ones of the chat head (blue, yellow, red, gray) and the badge is a chip that shows it is clickable and keeps a visible focus', () => {
  assert.match(rule('.sub-badge'), /cursor:\s*pointer/);
  assert.match(rule('.sb-working'), /color:\s*var\(--blue\)/);
  assert.match(rule('.sb-slow'), /color:\s*var\(--yellow\)/);
  assert.match(rule('.sb-stuck'), /color:\s*var\(--red\)/);
  assert.match(rule('.sb-nosignal'), /color:\s*var\(--muted\)/);
  assert.match(css, /\.sub-badge:focus-visible\s*\{[^}]*outline/);
  assert.match(css, /\.sub-badge svg\s*\{[^}]*display:\s*block/);
  assert.match(rule('.rs-subs'), /font-size:\s*12px/);
});
