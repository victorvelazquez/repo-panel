'use strict';
// RP227: the Merge button and the phone's confirm sheet show the method the server will really use (RP226 picks the one the repo allows), not only the one of Settings.
// ONE rule: pickMergeMethod lives in public/view.js (the page and the server load it) and lib.js hands out that same function, so the page and the merge never disagree.
const test = require('node:test');
const assert = require('node:assert/strict');
const V = require('../public/view.js');
const lib = require('../lib.js');
const R = require('../public/resumen.js');

const PR = { number: 7, base: 'main', ready: true, blockedReason: '' };
const SQUASH_ONLY = { merge: false, squash: true, rebase: false };
const ALL = { merge: true, squash: true, rebase: true };

test('one rule: lib.pickMergeMethod IS view.js pickMergeMethod, and it answers as RP226 for every allowed set and request', () => {
  assert.equal(lib.pickMergeMethod, V.pickMergeMethod);
  const old = (requested, allowed) => { // the RP226 rule as it was in lib.js
    const ok = (m) => allowed?.[m] !== false;
    if (ok(requested)) return { method: requested, requested, fellBack: false };
    const method = ['squash', 'rebase', 'merge'].find(ok);
    return method ? { method, requested, fellBack: true } : null;
  };
  const sets = [null, undefined, {}];
  for (const m of [true, false]) for (const s of [true, false]) for (const r of [true, false]) sets.push({ merge: m, squash: s, rebase: r });
  for (const allowed of sets) for (const req of ['merge', 'squash', 'rebase']) assert.deepEqual(V.pickMergeMethod(req, allowed), old(req, allowed), `${req} ${JSON.stringify(allowed)}`);
});

test('mergeButton: with merge in Settings on a squash-only repo it says Merge · squash and why; on a repo that allows merge it says merge', () => {
  const b = V.mergeButton(PR, { method: 'merge', methods: SQUASH_ONLY });
  assert.equal(b.label, 'Merge · squash');
  assert.equal(b.enabled, true);
  assert.match(b.title, /Method: squash \(this repo does not allow merge\)\. Change it in Settings, Delivery\./);
  const a = V.mergeButton(PR, { method: 'merge', methods: ALL });
  assert.equal(a.label, 'Merge · merge');
  assert.match(a.title, /Method: merge\. Change it in Settings, Delivery\./);
});

test('mergeButton: unknown methods keep the requested one exactly as before; a repo that allows none is off and says so', () => {
  for (const methods of [undefined, null]) assert.deepEqual(V.mergeButton(PR, { method: 'rebase', methods }), V.mergeButton(PR, { method: 'rebase' }));
  assert.equal(V.mergeButton(PR, { method: 'rebase' }).label, 'Merge · rebase');
  const none = V.mergeButton(PR, { method: 'squash', methods: { merge: false, squash: false, rebase: false } });
  assert.equal(none.enabled, false);
  assert.match(none.title, /This repo allows no merge method/);
  assert.equal(V.mergeWhy(none), none.title, 'the phone writes the reason where there is no tooltip');
});

test('mergeSheetHtml: the sheet says the method that will be used, and why when it is not the one of Settings', () => {
  const sheet = R.mergeSheetHtml({ n: 7, base: 'main', title: 't', method: 'squash', asked: 'merge', del: false });
  assert.match(sheet, /Method: <b>squash<\/b> \(this repo does not allow merge\)\./);
  assert.match(sheet, />Merge · squash</);
  const same = R.mergeSheetHtml({ n: 7, base: 'main', title: 't', method: 'merge', asked: 'merge', del: false });
  assert.match(same, /Method: <b>merge<\/b>\. /);
  assert.ok(!same.includes('does not allow'));
  assert.ok(!R.mergeSheetHtml({ n: 7, base: 'main', method: 'squash', asked: '<b>x', del: false }).includes('<b>x'), 'only a known method is ever written');
});

// ---------- found by the independent verification ----------
test('mergeMethodOf: an unknown saved method is cleaned as the button does, so the button and the sheet always say the same method', () => {
  const ms = { merge: true, squash: false, rebase: true };
  assert.deepEqual(V.mergeMethodOf('x', ms), { method: 'rebase', asked: 'squash', allowed: true });
  assert.equal(V.mergeButton(PR, { method: 'x', methods: ms }).label, `Merge · ${V.mergeMethodOf('x', ms).method}`);
  assert.deepEqual(V.mergeMethodOf('merge', null), { method: 'merge', asked: 'merge', allowed: true });
  assert.deepEqual(V.mergeMethodOf('merge', { merge: false, squash: false, rebase: false }), { method: 'merge', asked: 'merge', allowed: false });
});

test('probe: the shared rule answers as RP226 for odd allowed values and requests', () => {
  const old = (requested, allowed) => { const ok = (m) => allowed?.[m] !== false; if (ok(requested)) return { method: requested, requested, fellBack: false }; const method = ['squash', 'rebase', 'merge'].find(ok); return method ? { method, requested, fellBack: true } : null; };
  const nullp = Object.create(null); nullp.squash = false;
  const alloweds = [[], [false], 'squash', '', 0, true, { merge: 0 }, { merge: null }, { squash: 'false' }, { toString: false }, Object.create({ merge: false }), nullp, { __proto__: { squash: false, rebase: false } }];
  for (const a of alloweds) for (const r of ['squash', 'merge', 'rebase', 'x', undefined, 'toString']) assert.deepEqual(lib.pickMergeMethod(r, a), old(r, a));
});

test('probe: for every valid Settings method and repo flags, the button says what the server sends, and the sheet says the same', () => {
  const sets = [null];
  for (const a of [true, false, undefined]) for (const b of [true, false, undefined]) for (const c of [true, false, undefined]) sets.push({ merge: a, squash: b, rebase: c });
  for (const ms of sets) for (const pref of ['squash', 'merge', 'rebase']) {
    const b = V.mergeButton(PR, { method: pref, methods: ms });
    const srv = lib.pickMergeMethod(pref, ms);
    if (!srv) { assert.equal(b.enabled, false); continue; }
    assert.equal(b.label, `Merge · ${srv.method}`, `${pref} ${JSON.stringify(ms)}`);
    const m = V.mergeMethodOf(pref, ms);
    assert.ok(R.mergeSheetHtml({ n: 7, base: 'main', title: 't', method: m.method, asked: m.asked, del: false }).includes(`>Merge · ${srv.method}<`));
  }
});

test('probe: with no methods the button is byte-identical for busy, held, hold, noPr and odd PRs', () => {
  for (const p of [PR, { ...PR, ready: false, blockedReason: 'CI' }, null, [], { ready: 'yes' }]) for (const c of [{ method: 'merge', busy: true }, { method: 'x', held: true }, { method: 'squash', hold: 'running' }, { noPr: 'nope' }]) {
    assert.deepEqual(V.mergeButton(p, { ...c, methods: null }), V.mergeButton(p, c));
  }
});
