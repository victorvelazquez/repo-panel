'use strict';
// RP178: notifications. public/notify.js is the pure part shared by the server and the page (which kind of attention a Summary row asks for, the
// text, the validation of an event frame and the decision of what to show); server/notifier.js watches the Summary store and emits one `notify` event
// per CHANGE (never the first look, never a repeat, never a flicker); the page plays a sound and shows a notice only when it is not in view.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const N = require('../public/notify.js');
const { createNotifier } = require('../server/notifier.js');
const { settingsView } = require('../public/resumen.js');

const ID = 'a1b2c3d4e5';
const row = (over = {}) => ({ id: ID, name: 'my-repo', loading: false, error: null, rank: 9, session: { state: 'free' }, action: null, ...over });

test('kindOf: the attention a row asks for, one kind per row', () => {
  assert.equal(N.kindOf(row({ session: { state: 'waiting' }, action: { kind: 'answer' }, rank: 0 })), 'answer');
  assert.equal(N.kindOf(row({ rank: 1 })), 'ci');
  assert.equal(N.kindOf(row({ action: { kind: 'deliver', label: 'x', pr: null }, rank: 5 })), 'deliver');
  assert.equal(N.kindOf(row({ action: { kind: 'merge', label: 'x', pr: { number: 7 } }, rank: 2 })), 'merge');
  assert.equal(N.kindOf(row({ action: { kind: 'start', label: 'x', pr: null }, rank: 6 })), 'start');
  assert.equal(N.kindOf(row({ session: { state: 'working' }, rank: 7 })), null);
  assert.equal(N.kindOf(row({ action: { kind: 'branch' }, rank: 3 })), null);
});

test('kindOf: a row that cannot say (loading, error, unknown session) is undefined, never a kind and never "nothing"', () => {
  assert.equal(N.kindOf(row({ loading: true })), undefined);
  assert.equal(N.kindOf(row({ error: 'git failed' })), undefined);
  assert.equal(N.kindOf(row({ session: { state: 'unknown' }, action: { kind: 'deliver' } })), undefined);
  assert.equal(N.kindOf(null), undefined);
});

test('textOf: every kind has a title with the repo name and a body that names the next step', () => {
  assert.deepEqual(Object.keys(N.PREF).sort(), [...N.KINDS].sort());
  for (const k of N.KINDS) { const t = N.textOf(k, row({ name: 'my-repo', action: { pr: { number: 7 } } })); assert.match(t.title, /my-repo/); assert.ok(t.body.length > 5); }
  assert.match(N.textOf('deliver', row()).body, /flow-ship/);
  assert.match(N.textOf('start', row()).body, /flow-next/);
  assert.match(N.textOf('merge', row({ action: { pr: { number: 7 } } })).body, /#7/);
  assert.match(N.textOf('merge', row({ action: { pr: null } })).body, /merge/i);
});

test('parse: only a well-formed notify frame passes, with capped text', () => {
  const ok = { event: 'notify', data: JSON.stringify({ id: ID, kind: 'deliver', title: 'my-repo', body: 'ready' }) };
  assert.deepEqual(N.parse(ok), { id: ID, kind: 'deliver', title: 'my-repo', body: 'ready' });
  assert.equal(N.parse({ ...ok, event: 'rpc' }), null);
  assert.equal(N.parse({ ...ok, data: '{nope' }), null);
  assert.equal(N.parse({ ...ok, data: JSON.stringify({ id: 'x', kind: 'deliver', title: 't', body: 'b' }) }), null);
  assert.equal(N.parse({ ...ok, data: JSON.stringify({ id: ID, kind: 'rm-rf', title: 't', body: 'b' }) }), null);
  assert.equal(N.parse({ ...ok, data: JSON.stringify({ id: ID, kind: 'deliver', title: 5, body: 'b' }) }), null);
  assert.equal(N.parse({ ...ok, data: JSON.stringify({ id: ID, kind: 'deliver', title: 't', body: 'b', pad: 'x'.repeat(5000) }) }), null, 'a valid frame over the size cap');
  assert.equal(N.parse(null), null);
  const long = N.parse({ event: 'notify', data: JSON.stringify({ id: ID, kind: 'ci', title: 't'.repeat(500), body: 'b'.repeat(900) }) });
  assert.ok(long.title.length <= 120 && long.body.length <= 240);
});

const away = { visible: false, focused: false, permission: 'granted', prefs: {} };
const n = { id: ID, kind: 'merge', title: 't', body: 'b' };

test('plan: nothing when the panel is in view; otherwise a notice, a sound and a system notification when allowed', () => {
  assert.equal(N.plan(n, { ...away, visible: true, focused: true }), null);
  assert.deepEqual(N.plan(n, away), { toast: true, sound: true, system: true });
  assert.notEqual(N.plan(n, { ...away, visible: true, focused: false }), null, 'visible but another window has the focus');
  assert.notEqual(N.plan(n, { ...away, visible: false, focused: true }), null);
});

test('plan: each switch of the person is honoured, and an unavailable system notification falls back to the notice', () => {
  assert.equal(N.plan(n, { ...away, prefs: { notifyMerge: false } }), null);
  assert.notEqual(N.plan(n, { ...away, prefs: { notifyDeliver: false } }), null, 'another kind off does not silence this one');
  assert.equal(N.plan(n, { ...away, prefs: { notifySound: false } }).sound, false);
  assert.equal(N.plan(n, { ...away, prefs: { notifySystem: false } }).system, false);
  assert.equal(N.plan(n, { ...away, permission: 'default' }).system, false);
  assert.equal(N.plan(n, { ...away, permission: 'denied' }).system, false);
  assert.equal(N.plan(n, { ...away, permission: 'unsupported' }).toast, true);
  assert.deepEqual(N.plan(n, { ...away, prefs: { notifyMerge: false } }, true), { toast: true, sound: true, system: true }, 'force (the test button) ignores view and kind switches');
});

// A fake store and hub: the notifier only reads snapshot().rows and emits through hub.emit.
function rig(confirm = 2) {
  let rows = [];
  let clients = 1;
  const emitted = [];
  const reads = { n: 0 };
  const hub = { emit: (event, id, payload) => emitted.push({ event, id, payload }), size: () => clients };
  const store = { snapshot: () => { reads.n += 1; return { rows }; } };
  const notifier = createNotifier({ store, hub, confirm, setTimer: () => 0, clearTimer: () => {} });
  const tick = (next) => { rows = next; notifier.tick(); };
  return { tick, emitted, notifier, reads, pages: (n) => { clients = n; } };
}
const working = row({ session: { state: 'working' }, rank: 7 });
const deliver = row({ action: { kind: 'deliver', label: 'x', pr: null }, rank: 5 });

test('notifier: the first look is only a baseline, even for a repo that already waits for you', () => {
  const r = rig();
  r.tick([deliver]); r.tick([deliver]); r.tick([deliver]);
  assert.deepEqual(r.emitted, []);
});

test('notifier: working -> deliver emits ONE event after two equal looks, and not again while it stays', () => {
  const r = rig();
  r.tick([working]); r.tick([working]);
  r.tick([deliver]);
  assert.equal(r.emitted.length, 0, 'one look is not enough');
  r.tick([deliver]);
  assert.equal(r.emitted.length, 1);
  assert.equal(r.emitted[0].event, 'notify');
  assert.equal(r.emitted[0].id, ID);
  assert.equal(r.emitted[0].payload.kind, 'deliver');
  assert.match(r.emitted[0].payload.title, /my-repo/);
  r.tick([deliver]); r.tick([deliver]); r.tick([deliver]);
  assert.equal(r.emitted.length, 1);
});

test('notifier: a flicker (one look of another state) emits nothing and does not repeat the old kind', () => {
  const r = rig();
  r.tick([working]); r.tick([working]);
  r.tick([deliver]); r.tick([working]); r.tick([deliver]);
  assert.equal(r.emitted.length, 0);
  r.tick([deliver]);
  assert.equal(r.emitted.length, 1);
});

test('notifier: the whole cycle gives one notice per step: answer, deliver, merge, start, ci', () => {
  const r = rig(1);
  const merge = row({ action: { kind: 'merge', label: 'x', pr: { number: 3 } }, rank: 2 });
  const start = row({ action: { kind: 'start', label: 'x', pr: null }, rank: 6 });
  const ask = row({ session: { state: 'waiting' }, action: { kind: 'answer' }, rank: 0 });
  const ci = row({ rank: 1 });
  for (const step of [working, ask, working, deliver, working, merge, start, ci]) r.tick([step]);
  assert.deepEqual(r.emitted.map((e) => e.payload.kind), ['answer', 'deliver', 'merge', 'start', 'ci']);
});

test('notifier: an unsure row (loading, error, unknown session) keeps what was known, so it never fakes a change', () => {
  const r = rig(1);
  r.tick([deliver]);
  r.tick([row({ loading: true })]); r.tick([row({ error: 'x' })]); r.tick([row({ session: { state: 'unknown' }, action: { kind: 'deliver' } })]);
  r.tick([deliver]);
  assert.deepEqual(r.emitted, [], 'back to deliver after unsure looks: still the same, nothing to say');
});

test('notifier: a repo that appears later is a baseline too, and a repo that goes away is forgotten', () => {
  const r = rig(1);
  const idle = row({ id: 'ffffffffff', name: 'other' });
  const ready = row({ id: 'ffffffffff', name: 'other', action: { kind: 'deliver' }, rank: 5 });
  r.tick([working]);
  r.tick([working, ready]); r.tick([working, ready]);
  assert.deepEqual(r.emitted, [], 'it appeared already waiting: a baseline');
  r.tick([working, idle]);
  r.tick([working, ready]);
  assert.equal(r.emitted.length, 1, 'idle -> ready is a real change');
  r.tick([working]);
  r.tick([working, idle]);
  r.tick([working]);
  r.tick([working, ready]);
  assert.equal(r.emitted.length, 1, 'it went away and came back already waiting: forgotten, so a baseline again');
});

test('notifier: with no page connected it never reads the store (asking would wake it and start every read)', () => {
  const r = rig(1);
  r.pages(0);
  r.tick([working]); r.tick([deliver]); r.tick([deliver]);
  assert.equal(r.reads.n, 0);
  assert.deepEqual(r.emitted, []);
  r.pages(1);
  r.tick([deliver]);
  assert.equal(r.reads.n, 1);
});

test('notifier: when the pages leave and one comes back, the first look is a baseline again (no old news)', () => {
  const r = rig(1);
  r.tick([working]);
  r.pages(0);
  r.tick([deliver]); r.tick([deliver]);
  r.pages(1);
  r.tick([deliver]); r.tick([deliver]);
  assert.deepEqual(r.emitted, [], 'it changed while nobody listened: not a notice');
  r.tick([working]); r.tick([deliver]);
  assert.equal(r.emitted.length, 1, 'a change seen while listening still notifies');
});

test('notifier: a failing snapshot never throws and never emits', () => {
  const emitted = [];
  const notifier = createNotifier({ store: { snapshot: () => { throw new Error('boom'); } }, hub: { emit: (...a) => emitted.push(a) }, setTimer: () => 0, clearTimer: () => {} });
  assert.doesNotThrow(() => notifier.tick());
  assert.deepEqual(emitted, []);
});

test('notifier: start arms one timer, stop clears it, and a second start does not double it', () => {
  const calls = { set: 0, clear: 0 };
  const notifier = createNotifier({ store: { snapshot: () => ({ rows: [] }) }, hub: { emit() {} }, setTimer: () => { calls.set += 1; return calls.set; }, clearTimer: () => { calls.clear += 1; } });
  notifier.start(); notifier.start();
  assert.equal(calls.set, 1);
  notifier.stop();
  assert.equal(calls.clear, 1);
  notifier.stop();
  assert.equal(calls.clear, 1);
});

test('the server builds the notifier on its store, starts it with the store from server.js and stops it on close', () => {
  const ROOT = path.join(__dirname, '..');
  const http = fs.readFileSync(path.join(ROOT, 'server', 'http.js'), 'utf8');
  assert.match(http, /createNotifier/);
  assert.match(http, /server\.notifier = /);
  assert.match(http, /notifier\.stop\(\)/);
  assert.match(http, /'\/notify\.js': \['notify\.js', 'text\/javascript; charset=utf-8'\]/);
  assert.match(fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8'), /server\.notifier\.start\(\)/);
  const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
  assert.ok(html.indexOf('/notify.js') > html.indexOf('/resumen.js') && html.indexOf('/notify.js') < html.indexOf('/data.js'), 'a pure library, before the page scripts');
});

test('settings: a Notifications section with a switch per kind, the sound, the system option and the two buttons', () => {
  const on = { answer: true, ci: true, deliver: true, merge: false, start: true, sound: true, system: true, permission: 'default' };
  const html = settingsView({ state: 'ready', options: {}, prefs: { notify: on } });
  assert.match(html, /Notifications/);
  for (const key of N.PREF_KEYS) assert.match(html, new RegExp(`data-pref="${key}"`), key);
  assert.match(html, /data-pref="notifyMerge" data-value="true"/, 'an off switch turns on');
  assert.match(html, /data-pref="notifyAnswer" data-value="false"/, 'an on switch turns off');
  assert.match(html, /data-act="notify-allow"/);
  assert.match(html, /data-act="notify-test"/);
  const granted = settingsView({ state: 'ready', options: {}, prefs: { notify: { ...on, permission: 'granted' } } });
  assert.doesNotMatch(granted, /data-act="notify-allow"/);
  assert.match(granted, /data-act="notify-test"/);
});

test('the page wires the pref list, the frame and the buttons from the one library', () => {
  const ROOT = path.join(__dirname, '..');
  const read = (f) => fs.readFileSync(path.join(ROOT, 'public', f), 'utf8');
  assert.match(read('actions.js'), /N\.PREF_KEYS/);
  assert.match(read('actions.js'), /'notify-allow'/);
  assert.match(read('actions.js'), /'notify-test'/);
  assert.match(read('feed.js'), /N\.parse\(frame\)/);
  assert.match(read('feed.js'), /N\.plan\(/);
  assert.match(read('tabs.js'), /notify:/);
  assert.match(fs.readFileSync(path.join(ROOT, 'test', 'pagesrc.js'), 'utf8'), /'notify\.js'/);
});
