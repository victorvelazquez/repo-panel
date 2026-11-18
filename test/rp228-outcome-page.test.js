'use strict';
// RP228: the Projects tab says how the last task of a member ended: «Finished», «Failed» or «Stopped», beside the state chip of a free session. The page passes `last` through only
// from a well-formed row, and API_VERSION is 16 because the row of the Summary gained `session.last`.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const R = require('../public/resumen.js');
const V = require('../public/view.js');

const NOW = Date.parse('2026-11-17T12:00:00Z');
const AT = '2026-11-17T11:57:00Z'; // three minutes before NOW
const member = (o = {}) => ({ id: 'a1', name: 'upen-erp', known: true, state: 'free', at: '2026-11-17T11:00:00Z', what: 'docs: plan', prs: null, live: undefined, ...o });
const view = (members) => R.membersView({ members, now: NOW });
const chips = (html) => [...html.matchAll(/<span class="mb-end mb-end-(\w+)"[^>]*>.*?<\/svg>[^<]*<\/span>/g)];

test('API_VERSION is 16: the row of the Summary gained session.last', () => {
  assert.equal(V.API_VERSION, 16);
});

test('roomMembers: passes last through from row.session.last when it is well formed', () => {
  for (const kind of ['done', 'failed', 'stopped']) {
    const rows = [{ id: 'a1', session: { state: 'free', last: { kind, at: AT } }, lastMovement: { at: AT, what: 'x' } }];
    const [m] = V.roomMembers({ repos: ['a1'] }, { repos: [{ id: 'a1', name: 'n' }], rows });
    assert.deepEqual(m.last, { kind, at: AT }, kind);
  }
});

test('roomMembers: no last key when the row has none or it is malformed, and the member of always keeps its keys', () => {
  const room = { repos: ['a1', 'zz'] };
  const get = (session) => V.roomMembers(room, { repos: [{ id: 'a1', name: 'n' }], rows: [{ id: 'a1', session }] })[0];
  const bad = [undefined, null, 'done', 5, [], {}, { kind: 'weird', at: AT }, { kind: 'done' }, { kind: 'done', at: 5 }, { kind: 5, at: AT }, { at: AT }];
  for (const last of bad) assert.ok(!('last' in get({ state: 'free', last })), JSON.stringify(last));
  assert.ok(!('last' in get({ state: 'free' })));
  assert.ok(!('last' in get(null)));
  assert.ok(!('last' in V.roomMembers(room, { repos: [], rows: [] })[1]), 'an unknown member');
  assert.deepEqual(Object.keys(get({ state: 'free' })).sort(), ['at', 'id', 'known', 'live', 'name', 'prs', 'state', 'what']);
});

test('membersView: a free member says Finished, Failed or Stopped with an icon, the word and the relative time in the title', () => {
  const said = { done: ['Finished', 'finished'], failed: ['Failed', 'failed'], stopped: ['Stopped', 'was stopped'] };
  for (const [kind, [word, phrase]] of Object.entries(said)) {
    const found = chips(view([member({ last: { kind, at: AT } })]));
    assert.equal(found.length, 1, kind);
    const chip = found[0][0];
    assert.equal(found[0][1], kind);
    assert.match(chip, /<svg[^>]*aria-hidden="true"/, `${kind}: has an icon`);
    assert.match(chip, new RegExp(`</svg>\\s*${word}</span>$`), `${kind}: has the word after the icon`);
    assert.ok(chip.includes(`title="The last task ${phrase} 3 min ago"`), `${kind}: ${chip}`);
  }
});

test('membersView: the three icons are different shapes, and the chip comes in the first line right after the state chip', () => {
  const icon = (kind) => chips(view([member({ last: { kind, at: AT } })]))[0][0].match(/<svg.*<\/svg>/)[0];
  assert.equal(new Set(['done', 'failed', 'stopped'].map(icon)).size, 3);
  const html = view([member({ last: { kind: 'done', at: AT } })]);
  const end = html.indexOf('mb-end');
  assert.ok(end > html.indexOf('mb-l1') && end < html.indexOf('mb-l2'), 'in the first line of the block');
  const state = html.indexOf('class="ss ');
  assert.ok(state >= 0 && state < end, 'after the state chip');
});

test('membersView: no chip unless the member is free and last is valid', () => {
  const last = { kind: 'failed', at: AT };
  for (const state of ['working', 'waiting', 'none', 'unknown', undefined]) assert.equal(view([member({ state, last })]).includes('mb-end'), false, String(state));
  assert.equal(view([member({ known: false, last })]).includes('mb-end'), false, 'not in the panel');
  const bad = [undefined, null, 'done', {}, { kind: 'weird', at: AT }, { kind: 'done' }, { kind: 'done', at: 5 }];
  for (const l of bad) assert.equal(view([member({ last: l })]).includes('mb-end'), false, JSON.stringify(l));
});

test('membersView: the row of a member with no last is the row of always', () => {
  const plain = view([member()]);
  assert.ok(!plain.includes('mb-end'));
  assert.equal(view([member({ last: undefined })]), plain);
  assert.equal(view([member({ last: { kind: 'done', at: AT } })]).replace(chips(view([member({ last: { kind: 'done', at: AT } })]))[0][0], ''), plain, 'the rest of the block is the same');
});

test('membersView: a hostile time never becomes markup', () => {
  const html = view([member({ last: { kind: 'done', at: '"><img src=x onerror=alert(1)>' } })]);
  assert.ok(!html.includes('<img'));
  assert.ok(!html.includes('"><'.concat('img')));
});

test('style.css and README: the three tones of .mb-end exist and the README says it', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'style.css'), 'utf8').replace(/\r\n/g, '\n');
  for (const k of ['.mb-end {', '.mb-end-done', '.mb-end-failed', '.mb-end-stopped']) assert.ok(css.includes(k), k);
  // each outcome has its OWN colour (the icon and the word say it too, but a tone with no colour would look like the others)
  const rule = (sel) => { const i = css.indexOf(`${sel} {`); return i < 0 ? '' : css.slice(i, css.indexOf('}', i)); };
  const tones = ['.mb-end-done', '.mb-end-failed', '.mb-end-stopped'].map((s) => (/color:\s*var\(--\w+\)/.exec(rule(s)) || [])[0]);
  assert.ok(tones.every(Boolean), `every tone sets a colour: ${tones}`);
  assert.equal(new Set(tones).size, 3, `the three colours differ: ${tones}`);
  const readme = fs.readFileSync(path.join(__dirname, '..', 'README.md'), 'utf8');
  assert.match(readme, /RP228[^\n]*(Finished|finished)/);
});
