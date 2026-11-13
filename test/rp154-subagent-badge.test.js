'use strict';
// RP168 (13 November, asked by the person): the card of a repo in the Summary list no longer draws the badge and the list of the subagents that RP154 had put there. The person found them unnecessary on the card (the live indicator of the chat,
// RP152, is where a subagent belongs) and the card kept showing it for some seconds after the chat had cleared it. This file REPLACES the 13 tests of RP154 (the file keeps its name so the history of the task stays together): it pins that the card
// draws NOTHING about subagents even when its row carries `session.subagents`, and that what must stay still stays: the chip of the chat (RP152), the server that reads the presence (RP164) and the rest of the card.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const R = require('../public/resumen.js');
const P = require('../server/presence.js');

const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8').replace(/\r\n/g, '\n');
const row = (name, session, o = {}) => ({ id: `id-${name}`, name, group: 'G', room: null, branch: 'main', needs: false, rank: 9, progress: { total: null }, next: null, blocking: [], lastMovement: {}, session, ...o });
const sub = (o = {}) => ({ name: 'scout', state: 'working', minutes: 3, idle: 0, ...o });
const card = (session, ctx = {}, o = {}) => R.summaryView({ rows: [row('r1', session, o)], generatedAt: 'x' }, ctx);
const SUBAGENT_WORDS = /sub-badge|rs-subs|rs-sub-item|subs-toggle|Subagent working|subagents? ·|Possible block|No signal/;

// ---------- the card draws nothing about subagents ----------
test('a1: ABUSE FIRST: whatever the row carries in `session.subagents` (a list, no signal, hostile names and numbers, more than five, values that are not objects) the card is byte for byte the card of a row without it', () => {
  const variants = [
    { signal: true, list: [sub()] },
    { signal: true, list: [sub(), sub({ name: 'b', state: 'slow', idle: 3 }), sub({ name: 'c', state: 'stuck', idle: 6 })] },
    { signal: false, list: [] },
    { signal: true, list: [sub({ name: '<img src=x onerror=alert(1)>' })] },
    { signal: true, list: Array.from({ length: 9 }, (_, i) => sub({ name: `a${i}` })) },
    { signal: true, list: [sub({ minutes: -1 }), sub({ state: '__proto__' }), null, 5, 'x', []] },
    null, 'x', [], 5, { signal: 'yes', list: 'x' },
  ];
  for (const state of ['working', 'waiting', 'free', 'none', 'unknown']) {
    const plain = card({ state });
    for (const v of variants) {
      const html = card({ state, subagents: v }, { subsOpen: { 'id-r1': true } });
      assert.equal(html, plain, `${state} ${JSON.stringify(v).slice(0, 60)}`);
      assert.doesNotMatch(html, SUBAGENT_WORDS);
    }
  }
});

test('a2: a card that has an error, or no session at all, draws no subagents either, and the open-list state of the page changes nothing', () => {
  const withSubs = { state: 'working', subagents: { signal: true, list: [sub()] } };
  assert.doesNotMatch(card(withSubs, {}, { error: 'boom' }), SUBAGENT_WORDS);
  assert.doesNotMatch(card(undefined), SUBAGENT_WORDS);
  for (const open of [{ 'id-r1': true }, 'true', 1, [], null, { __proto__: { 'id-r1': true } }]) assert.equal(card(withSubs, { subsOpen: open }), card({ state: 'working' }), String(open));
});

test('a3: the rest of the card is untouched: the state chip of RP169 (words, icon and animation of the chat), the name and the branch are still drawn', () => {
  const html = card({ state: 'working', subagents: { signal: true, list: [sub()] } });
  assert.match(html, /class="ss ss-green ss-working ss-anim"/);
  assert.match(html, /<span class="ss-word">Working…<\/span>/);
  assert.match(html, /class="rs-name"[^>]*>r1</);
  assert.match(html, /main/);
});

// ---------- what must stay ----------
test('k1: the chat (RP152, now a bubble of the thread: RP171) keeps drawing the live subagent with its clock', () => {
  const chat = (rpc, now) => R.chatBody({ id: 'abcdef0123', info: { adopted: { id: 's', name: 'demo' }, adoptedFound: true, sessions: [] }, hist: { items: [], truncated: false }, rpc }, { now });
  assert.match(chat({ state: 'busy', subs: 1, subSince: 1000 }, 1000 + 135000), /Subagent working<\/span> <b class="sub-time" aria-hidden="true">02:15<\/b>/);
  assert.match(chat({ state: 'busy', subs: 3, subSince: 1000 }, 5000), /3 subagents working/);
  assert.doesNotMatch(chat({ state: 'idle', subs: 1, subSince: 1000 }, 5000), /Subagent/);
});

test('k2: the server that reads the presence (RP164) is still there and still hands the page a closed shape: only the card stopped drawing it', () => {
  assert.equal(typeof P.subagentsOf, 'function');
  assert.equal(typeof P.sanitize, 'function');
  const s = P.sanitize({ signal: true, list: [{ name: 'scout', state: 'working', minutes: 3, idle: 0, label: 'SECRET', thread: ['SECRET'] }] });
  assert.deepEqual(s, { signal: true, list: [{ name: 'scout', state: 'working', minutes: 3, idle: 0 }] });
  assert.match(read('server/summary.js'), /subagents/);
});

// ---------- what is gone ----------
test('g1: the code of the badge and its list is gone from the page: the helpers, the action, the open-list state, the styles and the paragraph of the README', () => {
  const files = { 'public/resumen.js': read('public/resumen.js'), 'public/actions.js': read('public/actions.js'), 'public/app.js': read('public/app.js'), 'public/tabs.js': read('public/tabs.js'), 'public/style.css': read('public/style.css') };
  const GONE = ['subsOf(', 'subsBadgeHtml', 'subsListHtml', 'subsOpenFor', 'subs-toggle', 'subsOpen', 'sub-badge', 'rs-subs', 'rs-sub-item', 'SUBS_MAX', 'SUB_RANK', 'wholeMinutes', 'sbi-', '.sb-working', '.sb-slow', '.sb-stuck', '.sb-nosignal'];
  for (const [f, text] of Object.entries(files)) for (const g of GONE) assert.ok(!text.includes(g), `${f} still has ${g}`);
  assert.doesNotMatch(read('README.md'), /Subagents on the card/);
});

test('g2: and what belongs to the chat bubble is still in the page (RP171: the helper of the chip is gone, the classes of the bubble stay), so nothing was removed by mistake', () => {
  const js = read('public/resumen.js');
  const css = read('public/style.css');
  assert.match(js, /const subBubbleHtml = \(r, items, now\) =>/);
  assert.doesNotMatch(js, /subagentChipHtml/);
  for (const c of ['m.subrun', 'sub-dot', 'sub-time']) assert.ok(css.includes('.' + c), c);
});
