'use strict';
// RP79 (S68, S74), point 1 of the design: the pure helpers of the per-repo chat cache that the PAGE owns (public/view.js).
// chatCachePut / chatCacheGet keep at most `max` repos (least recently USED goes first; the order is an insertion counter, never a clock);
// chatFromCache is what the page paints at once: the cached messages with the live state REPLACED, so a question card or answer
// buttons can never come from the cache. No DOM, no timers, no clock.
const test = require('node:test');
const assert = require('node:assert/strict');
const V = require('../public/view.js');
const R = require('../public/resumen.js');

const ASK = {
  state: 'waiting', count: 1,
  dialog: { lines: ['Proceed?'], selected: 0, choices: { fingerprint: 'f1', complete: true, options: [{ label: 'Yes', tone: 'affirmative' }, { label: 'No', tone: 'negative' }] } },
};
const infoOf = (n = 1, live = { state: 'free', count: 1 }) => ({ key: `k${n}`, adopted: { id: `s${n}`, name: `panel:r${n}`, adoptedAt: 'x' }, adoptedFound: true, sessions: [], live });
const histOf = (...texts) => ({ key: 'k', sessionId: 's', found: true, items: texts.map((text) => ({ role: 'user', text, at: null, tools: [] })), truncated: false, updatedAt: null });
const entryOf = (n = 1, o = {}) => {
  const info = infoOf(n);
  const hist = histOf(`hello ${n}`);
  return { info, hist, key: JSON.stringify([info, hist]), ...o };
};
const copy = (x) => JSON.parse(JSON.stringify(x));
const fill = (cache, n, max) => { for (let i = 1; i <= n; i++) assert.equal(V.chatCachePut(cache, `r${i}`, entryOf(i), max), true); };

// ---------- chatCachePut / chatCacheGet ----------
test('put stores a copy of { info, hist, key } plus an insertion counter `at` (a small integer, not a clock); get gives it back', () => {
  const cache = {};
  const entry = entryOf(1);
  assert.equal(V.chatCachePut(cache, 'abc', entry), true);
  assert.deepEqual(Object.keys(cache), ['abc']);
  assert.deepEqual(Object.keys(cache.abc).sort(), ['at', 'hist', 'info', 'key']);
  assert.ok(Number.isInteger(cache.abc.at) && cache.abc.at >= 0 && cache.abc.at < 1e9, `at is a counter: ${cache.abc.at}`);
  assert.deepEqual(cache.abc.info, entry.info);
  assert.deepEqual(cache.abc.hist, entry.hist);
  assert.equal(cache.abc.key, entry.key);
  const got = V.chatCacheGet(cache, 'abc');
  assert.deepEqual(got.info, entry.info);
  assert.deepEqual(got.hist, entry.hist);
  assert.equal(got.key, entry.key);
});

test('put keeps only info, hist and key of the entry: a draft, a pending message or a flag in the entry never reaches the cache', () => {
  const cache = {};
  V.chatCachePut(cache, 'abc', { ...entryOf(1), draft: 'my draft', pending: [{ text: 'p' }], failed: true, cached: true, at: 99 });
  assert.deepEqual(Object.keys(cache.abc).sort(), ['at', 'hist', 'info', 'key']);
  assert.ok(!JSON.stringify(cache).includes('my draft'));
  assert.notEqual(cache.abc.at, 99, 'the counter is the cache\'s, not the entry\'s');
});

test('put stores a COPY: mutating the entry afterwards (deep) never changes the cache', () => {
  const cache = {};
  const entry = entryOf(1);
  V.chatCachePut(cache, 'abc', entry);
  const before = copy(cache.abc);
  entry.info.adopted.id = 'changed';
  entry.hist.items.push({ role: 'user', text: 'late', at: null, tools: [] });
  entry.key = 'changed';
  assert.deepEqual(copy(cache.abc), before);
});

test('a null hist (no adopted session) is stored as null', () => {
  const cache = {};
  const info = { key: 'k', adopted: null, adoptedFound: false, sessions: [], live: { state: 'none', count: 0 } };
  assert.equal(V.chatCachePut(cache, 'abc', { info, hist: null, key: 'kk' }), true);
  assert.equal(V.chatCacheGet(cache, 'abc').hist, null);
});

test('get returns a deep copy: mutating it never changes the cache', () => {
  const cache = {};
  V.chatCachePut(cache, 'abc', entryOf(1));
  const before = copy(cache.abc);
  const got = V.chatCacheGet(cache, 'abc');
  got.info.adopted.id = 'changed';
  got.hist.items.length = 0;
  got.key = 'changed';
  assert.deepEqual(copy(cache.abc).info, before.info);
  assert.deepEqual(copy(cache.abc).hist, before.hist);
  assert.equal(cache.abc.key, before.key);
  assert.notEqual(V.chatCacheGet(cache, 'abc'), got, 'a new copy each time');
});

test('get of an id that was never stored is null and leaves the cache as it was', () => {
  const cache = {};
  V.chatCachePut(cache, 'abc', entryOf(1));
  const before = copy(cache);
  assert.equal(V.chatCacheGet(cache, 'zzz'), null);
  assert.equal(V.chatCacheGet({}, 'abc'), null);
  assert.deepEqual(copy(cache), before);
});

test('put ignores an id that is not a non-empty string: returns false and the cache stays as it was', () => {
  for (const id of [null, undefined, '', 0, 42, {}, [], true]) {
    const cache = {};
    V.chatCachePut(cache, 'abc', entryOf(1));
    const before = copy(cache);
    assert.equal(V.chatCachePut(cache, id, entryOf(2)), false, `id ${JSON.stringify(id)}`);
    assert.deepEqual(copy(cache), before, `id ${JSON.stringify(id)}`);
  }
});

test('put ignores an entry without an object info (null, undefined, no info, info null or a string): false, nothing stored', () => {
  const bad = [null, undefined, {}, { info: null, hist: null, key: 'k' }, { info: undefined }, { info: 'x', hist: null, key: 'k' }, { hist: histOf('a'), key: 'k' }, 'text', 7];
  for (const entry of bad) {
    const cache = {};
    assert.equal(V.chatCachePut(cache, 'abc', entry), false, JSON.stringify(entry));
    assert.deepEqual(Object.keys(cache), [], JSON.stringify(entry));
  }
});

test('get with a null, undefined or empty id (or a non-string one) is null and does not throw', () => {
  const cache = {};
  V.chatCachePut(cache, 'abc', entryOf(1));
  for (const id of [null, undefined, '', 0, {}]) assert.equal(V.chatCacheGet(cache, id), null, JSON.stringify(id));
});

test('the same id twice replaces its entry and does not grow the cache', () => {
  const cache = {};
  V.chatCachePut(cache, 'abc', entryOf(1));
  V.chatCachePut(cache, 'abc', entryOf(2));
  assert.deepEqual(Object.keys(cache), ['abc']);
  assert.deepEqual(V.chatCacheGet(cache, 'abc').hist, entryOf(2).hist);
  assert.equal(V.chatCacheGet(cache, 'abc').key, entryOf(2).key);
});

test('8 repos fit (default max); the 9th evicts the first one put', () => {
  const cache = {};
  fill(cache, 8);
  assert.equal(Object.keys(cache).length, 8);
  for (let i = 1; i <= 8; i++) assert.notEqual(V.chatCacheGet(cache, `r${i}`), null, `r${i} is kept`);
  assert.equal(V.chatCachePut(cache, 'r9', entryOf(9)), true);
  assert.deepEqual(Object.keys(cache).sort(), ['r2', 'r3', 'r4', 'r5', 'r6', 'r7', 'r8', 'r9']);
  assert.equal(V.chatCacheGet(cache, 'r1'), null, 'r1 is gone');
});

test('a get refreshes use: the repo read last survives the 9th put and the least recently used one goes instead', () => {
  const cache = {};
  fill(cache, 8);
  assert.notEqual(V.chatCacheGet(cache, 'r1'), null);
  V.chatCachePut(cache, 'r9', entryOf(9));
  assert.deepEqual(Object.keys(cache).sort(), ['r1', 'r3', 'r4', 'r5', 'r6', 'r7', 'r8', 'r9']);
  assert.equal(V.chatCacheGet(cache, 'r2'), null, 'r2 was the least recently used');
});

test('a get of a missing id refreshes nothing: the oldest still goes first', () => {
  const cache = {};
  fill(cache, 8);
  V.chatCacheGet(cache, 'zzz');
  V.chatCachePut(cache, 'r9', entryOf(9));
  assert.equal(V.chatCacheGet(cache, 'r1'), null);
});

test('putting the same id again refreshes its use and, at the limit, evicts nobody', () => {
  const cache = {};
  fill(cache, 8);
  V.chatCachePut(cache, 'r1', entryOf(1, { key: 'again' }));
  assert.equal(Object.keys(cache).length, 8, 'replacing at the limit evicts nobody');
  assert.equal(V.chatCacheGet(cache, 'r1').key, 'again');
  V.chatCachePut(cache, 'r9', entryOf(9));
  assert.notEqual(V.chatCacheGet(cache, 'r1'), null, 'r1 was just used');
  assert.equal(V.chatCacheGet(cache, 'r2'), null, 'r2 is now the oldest');
});

test('max is a parameter: with 2, the third put evicts the least recently used; an ignored put evicts nobody', () => {
  const cache = {};
  fill(cache, 2, 2);
  V.chatCacheGet(cache, 'r1');
  assert.equal(V.chatCachePut(cache, 'r3', entryOf(3), 2), true);
  assert.deepEqual(Object.keys(cache).sort(), ['r1', 'r3']);
  assert.equal(V.chatCachePut(cache, '', entryOf(4), 2), false);
  assert.equal(V.chatCachePut(cache, 'r4', { info: null }, 2), false);
  assert.deepEqual(Object.keys(cache).sort(), ['r1', 'r3'], 'a rejected put never evicts');
});

test('the order never depends on the clock: puts and gets in the same millisecond keep the exact order', () => {
  const real = Date.now;
  Date.now = () => 1700000000000; // frozen
  try {
    const cache = {};
    fill(cache, 8);
    V.chatCacheGet(cache, 'r2');
    V.chatCacheGet(cache, 'r1');
    V.chatCachePut(cache, 'r9', entryOf(9));
    V.chatCachePut(cache, 'r10', entryOf(10));
    assert.deepEqual(Object.keys(cache).sort(), ['r1', 'r10', 'r2', 'r5', 'r6', 'r7', 'r8', 'r9'], 'r3 and r4 (never used again) went first');
  } finally { Date.now = real; }
});

// ---------- chatFromCache ----------
test('chatFromCache of null or undefined is null', () => {
  assert.equal(V.chatFromCache(null), null);
  assert.equal(V.chatFromCache(undefined), null);
});

test('chatFromCache gives { info, hist, key, cached: true } with the live state replaced by unknown, everything else as cached', () => {
  const info = { ...infoOf(1), live: ASK, sessions: [{ id: 's1', name: 'n', updatedAt: 'u' }] };
  const hist = histOf('cached hello');
  const entry = { info, hist, key: 'the-key', at: 3 };
  const out = V.chatFromCache(entry);
  assert.deepEqual(Object.keys(out).sort(), ['cached', 'hist', 'info', 'key']);
  assert.equal(out.cached, true);
  assert.equal(out.key, 'the-key');
  assert.deepEqual(out.hist, hist, 'the messages are kept as cached');
  assert.deepEqual(out.info, { ...info, live: { state: 'unknown', count: 0 } });
});

test('chatFromCache: a cached live state with a dialog and choices comes out without dialog and without choices', () => {
  const out = V.chatFromCache({ info: { ...infoOf(1), live: ASK }, hist: histOf('a'), key: 'k' });
  assert.deepEqual(out.info.live, { state: 'unknown', count: 0 });
  assert.ok(!('dialog' in out.info.live));
  assert.ok(!JSON.stringify(out).includes('choices'));
  assert.ok(!JSON.stringify(out).includes('Proceed?'));
});

test('chatFromCache: an info with no live at all also gets { state: unknown, count: 0 }; a null hist stays null', () => {
  const info = { key: 'k', adopted: { id: 's', name: 'n' }, adoptedFound: true, sessions: [] };
  const out = V.chatFromCache({ info, hist: null, key: 'k' });
  assert.deepEqual(out.info.live, { state: 'unknown', count: 0 });
  assert.equal(out.hist, null);
});

test('chatFromCache does not touch the entry it reads', () => {
  const entry = { info: { ...infoOf(1), live: ASK }, hist: histOf('a'), key: 'k', at: 1 };
  const before = copy(entry);
  const out = V.chatFromCache(entry);
  assert.deepEqual(copy(entry), before, 'the cached live state is still there');
  assert.notEqual(out.info, entry.info, 'info is a copy');
  out.info.adopted.id = 'changed';
  assert.equal(entry.info.adopted.id, 's1', 'not even deep');
});

test('painted by the real chat view, the cached chat shows its messages, no question card and no answer buttons', () => {
  const entry = { info: { ...infoOf(1), live: ASK }, hist: histOf('cached hello'), key: 'k' };
  const live = R.chatBody({ id: 'abc', ...entry, answer: undefined }, { now: 0 });
  assert.ok(live.includes('data-act="dialog-answer"'), 'control: the same data painted as it came shows the buttons');
  const html = R.chatBody({ id: 'abc', ...V.chatFromCache(entry) }, { now: 0 });
  assert.ok(html.includes('cached hello'));
  assert.ok(!html.includes('data-act="dialog-answer"'));
  assert.ok(!html.includes('ch-ask'));
  assert.ok(!html.includes('Loading chat…'));
  assert.ok(R.sessionLabelHtml({ id: 'abc', ...V.chatFromCache(entry) }).includes('ss-unknown'));
});
