'use strict';
// RP169: the Summary card draws the SAME session chip as the chat (R.sessionLabelHtml), from the LIVE state of the page (ctx.liveFor) and,
// only when the page has none for that repo, from the row of the server. Fakes only: no server, no GitHub, no session.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const R = require('../public/resumen.js');

const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'style.css'), 'utf8').replace(/\r\n/g, '\n');
const NOW = Date.parse('2026-05-01T12:00:00Z');
const row = (o = {}) => ({
  id: 'r1', name: 'alpha', group: 'G1', room: null, branch: 'main', progress: { total: 10, completada: 4, enRevision: 1, bloqueada: 1, pendiente: 3, enCurso: 1 }, session: { state: 'free' },
  next: null, blocking: [], lastMovement: { at: '2026-05-01T11:48:00Z', what: 'fix: thing' }, action: null, error: null, ...o,
});
const view = (rows, ctx = {}) => R.summaryView({ rows, counts: {}, attention: [], generatedAt: 'x' }, { now: NOW, scope: { kind: 'all' }, rooms: [], ...ctx });
const chip = (html) => { const m = /<span class="ss [^]*?<\/i> <span class="ss-word">[^<]*<\/span><\/span>/.exec(html); return m ? m[0] : ''; };
const chat = (rpc) => R.sessionLabelHtml({ info: {}, rpc });
const live = (map) => ({ liveFor: (id) => map[id] });

// ---------- the same function, byte for byte ----------
const LIVE_CASES = [
  [{ state: 'idle' }, 'Idle'], [{ state: 'busy' }, 'Working…'], [{ state: 'starting' }, 'Starting…'], [{ state: 'asking' }, 'Asking you something'],
  [{ state: 'closed' }, 'Not started'], [{ state: 'busy', compacting: true }, 'Compacting…'], [{ state: 'idle', compacting: true }, 'Compacting…'],
];
test('c1: for every live state the chip of the card equals the chip of the chat, byte for byte', () => {
  for (const [rpc, word] of LIVE_CASES) {
    const c = chip(view([row()], live({ r1: rpc })));
    assert.equal(c, chat(rpc), JSON.stringify(rpc));
    assert.ok(c.includes(`<span class="ss-word">${word}</span>`), word);
    assert.match(c, /role="status" title="[^"]+"/);
    assert.match(c, /<i class="ss-dot" aria-hidden="true"><svg/);
  }
});

test('c2: live starting and compacting carry the animation classes and the tone of the chat', () => {
  assert.match(chip(view([row()], live({ r1: { state: 'starting' } }))), /class="ss ss-yellow ss-starting ss-anim"/);
  assert.match(chip(view([row()], live({ r1: { state: 'busy' } }))), /class="ss ss-green ss-working ss-anim"/);
  assert.match(chip(view([row()], live({ r1: { state: 'idle', compacting: true } }))), /class="ss ss-yellow ss-compacting ss-anim"/);
  assert.match(chip(view([row()], live({ r1: { state: 'idle' } }))), /class="ss ss-gray ss-free"/);
  assert.doesNotMatch(chip(view([row()], live({ r1: { state: 'idle' } }))), /ss-anim/);
});

test('c3: the live state wins over the row (row says working, live says idle)', () => {
  const c = chip(view([row({ session: { state: 'working' } })], live({ r1: { state: 'idle' } })));
  assert.equal(c, chat({ state: 'idle' }));
  assert.match(c, /Idle/);
  assert.doesNotMatch(c, /Working/);
});

test('c4: the compacting mark does not count for a closed or a starting session (same rule as the chat)', () => {
  for (const state of ['closed', 'starting']) assert.equal(chip(view([row()], live({ r1: { state, compacting: true } }))), chat({ state, compacting: true }), state);
});

// ---------- fallback: the row of the server ----------
test('c5: with no live state the five row states map to the chat keys and words', () => {
  const want = { working: 'busy', waiting: 'asking', free: 'idle', none: 'closed' };
  for (const [state, rpcState] of Object.entries(want)) assert.equal(chip(view([row({ session: { state } })])), chat({ state: rpcState }), state);
  assert.equal(chip(view([row({ session: { state: 'unknown' } })])), chat(undefined));
  assert.match(chip(view([row({ session: { state: 'unknown' } })])), /ss-unknown[^]*Unknown/);
  // a getter that has nothing for this repo falls back as well
  assert.equal(chip(view([row({ session: { state: 'waiting' } })], live({}))), chat({ state: 'asking' }));
  assert.equal(chip(view([row({ session: { state: 'waiting' } })], { liveFor: () => null })), chat({ state: 'asking' }));
});

test('c6: ABUSE: hostile row states and a missing session draw Unknown, never throw, never echo', () => {
  const unknown = chat(undefined);
  for (const bad of ['__proto__', 'constructor', 'toString', 'hasOwnProperty', 5, null, undefined, {}, [], '<img src=x onerror=alert(1)>', true]) {
    const html = view([row({ session: { state: bad } })]);
    assert.equal(chip(html), unknown, String(bad));
    assert.ok(!html.includes('<img src=x'), 'nothing is echoed');
  }
  for (const session of [undefined, null, 'working', 7, []]) assert.equal(chip(view([row({ session })])), unknown, String(session));
  const noKey = row(); delete noKey.session;
  assert.equal(chip(view([noKey])), unknown);
});

test('c7: ABUSE: a hostile live state never throws and falls back to the row', () => {
  for (const bad of [{ state: '__proto__' }, { state: 'constructor' }, { state: 5 }, { state: {} }, { state: '<b>x</b>' }, {}, 'idle', 7, [], true]) {
    const html = view([row({ session: { state: 'working' } })], live({ r1: bad }));
    assert.equal(chip(html), chat({ state: 'busy' }), JSON.stringify(bad));
    assert.ok(!html.includes('<b>x</b>'));
  }
});

test('c8: the row and the context are never mutated', () => {
  const r = row({ session: { state: 'working' } });
  const before = JSON.stringify(r);
  const rpc = { state: 'idle', compacting: true };
  const rpcBefore = JSON.stringify(rpc);
  view([r], live({ r1: rpc }));
  assert.equal(JSON.stringify(r), before);
  assert.equal(JSON.stringify(rpc), rpcBefore);
});

// ---------- no old strings or characters ----------
test('c9: the chip has no text characters of the old chip and the old words are gone from it', () => {
  const states = [...['working', 'waiting', 'free', 'none', 'unknown'].map((state) => view([row({ session: { state } })])), ...LIVE_CASES.map(([rpc]) => view([row()], live({ r1: rpc })))];
  for (const html of states) {
    const c = chip(html);
    assert.ok(c, 'the chip is drawn');
    assert.doesNotMatch(c.replace(/<svg[^]*?<\/svg>/g, ''), /[●○◐?]/);
    assert.doesNotMatch(c, /class="chip /);
    const word = /<span class="ss-word">([^<]*)</.exec(c)[1];
    assert.ok(!['free', 'working', 'asking you', 'no session', 'unknown'].includes(word.toLowerCase()) || word === 'Unknown', word);
    assert.doesNotMatch(html, /[●○◐] (free|working|asking you|no session)|\? unknown/);
  }
});

test('c10: a card with an error keeps the red chip and no session chip; a loading row is the same placeholder; a closed session is the chat chip', () => {
  const err = view([row({ error: 'boom' })], live({ r1: { state: 'busy' } }));
  assert.match(err, /<span class="chip red">▲ error<\/span>/);
  assert.equal(chip(err), '');
  const loading = view([row({ loading: true })], live({ r1: { state: 'busy' } }));
  assert.match(loading, /class="rs-card rs-loading"[^>]*aria-busy="true"/);
  assert.match(loading, /role="status">Loading…<\/span>/);
  assert.equal(chip(loading), '');
  assert.equal(chip(view([row({ session: { state: 'none' } })])), chat({ state: 'closed' }));
});

// ---------- the filter and the order are the row's, unchanged ----------
const mk = (n, session, o = {}) => ({ ...row({ id: `id-${n}`, name: n, session }), needs: false, rank: 9, ...o });
const ROWS = [mk('a-working', { state: 'working' }), mk('b-waiting', { state: 'waiting' }, { needs: true, rank: 1 }), mk('c-free', { state: 'free' }), mk('d-none', { state: 'none' }), mk('e-unknown', { state: 'unknown' }), mk('f-nosession', undefined), mk('g-err', { state: 'free' }, { error: 'x' })];
const names = (html) => [...html.matchAll(/class="rs-name"[^>]*>([^<]+)</g)].map((m) => m[1].trim());
test('c11: «Working now» and the order read the row of the server, whatever the live state says (frozen results)', () => {
  const liveAll = { liveFor: () => ({ state: 'closed' }) }; // every repo "closed" live: the filter must not notice
  for (const extra of [{}, liveAll]) {
    assert.deepEqual(names(view(ROWS, { ...extra, live: false })), ['a-working', 'b-waiting', 'c-free', 'd-none', 'e-unknown', 'f-nosession', 'g-err']);
    assert.deepEqual(names(view(ROWS, { ...extra, live: true })), ['a-working', 'b-waiting', 'c-free', 'e-unknown', 'f-nosession', 'g-err']);
    assert.deepEqual(names(view(ROWS, { ...extra, live: false, filter: 'attention' })), ['b-waiting']);
  }
});

// ---------- CSS ----------
test('c12: the words of the chip are hidden only inside the composer container, never on the card', () => {
  assert.match(css, /\.composer \{[^}]*container-name: cmp;/);
  const hide = /@container cmp \([^)]*\) \{\s*[^}]*\.ss-word[^}]*\}/.exec(css);
  assert.ok(hide, 'the collapse rule exists');
  const outside = css.replace(hide[0], '');
  assert.doesNotMatch(outside, /[^\n]*\.ss-word[^\n]*\{[^}]*(clip-path|display: none|visibility: hidden|width: 1px)/, 'no other rule hides the word');
  for (const sel of ['.rs-list', '.rs-card', '.rs-l1']) assert.doesNotMatch(css, new RegExp(`${sel.replace('.', '\\.')}[^{]*\\{[^}]*container-name: cmp`), sel);
  assert.match(css, /\.ss \{ display: inline-flex;/);
  assert.match(css, /\.ss-anim \.ss-dot \{ animation: pulse-dot/);
});
