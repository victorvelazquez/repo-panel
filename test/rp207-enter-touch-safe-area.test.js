'use strict';
// RP207 (S19): on a phone Enter makes a new line (only Send, Ctrl+Enter or Cmd+Enter send); a blocked box has an empty placeholder (the state line and the title of Send say why);
// the foot of the chat respects the safe area of the screen and has rounder corners where the pointer is a finger.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { appSource } = require('./pagesrc.js');
const V = require('../public/view.js');
const R = require('../public/resumen.js');

const PUBLIC = path.join(__dirname, '..', 'public');
const read = (f) => fs.readFileSync(path.join(PUBLIC, f), 'utf8').replace(/\r\n/g, '\n');
const css = read('style.css');
const html = read('index.html');

test('enterSends: a finger keyboard never sends with a plain Enter; Ctrl or Cmd always send', () => {
  assert.equal(typeof V.enterSends, 'function');
  assert.equal(V.enterSends({ coarse: true }), false);
  assert.equal(V.enterSends({ coarse: true, ctrl: true }), true);
  assert.equal(V.enterSends({ coarse: true, meta: true }), true);
  assert.equal(V.enterSends({ coarse: false }), true, 'desktop is as before');
  assert.equal(V.enterSends({ coarse: false, ctrl: true }), true);
  assert.equal(V.enterSends({ coarse: false, meta: true }), true);
});

test('enterSends: Shift and an IME composition never send, on any device', () => {
  for (const coarse of [true, false]) {
    assert.equal(V.enterSends({ coarse, shift: true }), false);
    assert.equal(V.enterSends({ coarse, shift: true, ctrl: true }), false);
    assert.equal(V.enterSends({ coarse, composing: true }), false);
    assert.equal(V.enterSends({ coarse, composing: true, ctrl: true }), false);
  }
  assert.equal(V.enterSends(), true);
});

test('app.js: the Enter handler keeps the IME guards, asks the helper at the moment of the key and guards a page without matchMedia', () => {
  const app = appSource().replace(/\r\n/g, '\n');
  assert.match(app, /e\.key !== 'Enter' \|\| !e\.target \|\| e\.target\.id !== 'msgBox' \|\| e\.keyCode === 229\) return;/);
  assert.match(app, /V\.enterSends\(\{[^}]*composing: e\.isComposing[^}]*\}\)/);
  assert.match(app, /window\.matchMedia && window\.matchMedia\('\(pointer: coarse\)'\)\.matches/);
  // RP236: the key also tells whether Alt was held (while the session works Alt+Enter queues).
  assert.match(app, /if \(!sends\) return;\n\s*e\.preventDefault\(\);\n\s*sendChatMessage\(R \? R\.busyBehavior\(\{ alt: e\.altKey \}\) : undefined\);/);
});

test('index.html: the box asks the phone keyboard for a return key and keeps its title and label', () => {
  const tag = /<textarea id="msgBox"[^>]*>/.exec(html)[0];
  assert.match(tag, /enterkeyhint="enter"/);
  assert.match(tag, /title="Enter sends · Shift\+Enter new line"/);
  assert.match(tag, /aria-label="Message to the session"/);
});

const IDLE = { id: 'r1', sending: false, info: { adopted: { id: 's1' } }, rpc: { state: 'idle' } };
const cs = (c) => R.composerState({ ...IDLE, ...c }, { name: 'alpha' });

test('composerState: a quiet placeholder; the reason stays as it was', () => {
  assert.equal(cs({}).placeholder, 'Message…');
  assert.equal(cs({ rpc: { state: 'closed' } }).placeholder, 'Message…');
  const notAdopted = cs({ info: { adopted: null }, rpc: { state: 'closed' } });
  assert.equal(notAdopted.placeholder, 'Start a session to write');
  assert.equal(notAdopted.reason, 'Open a session or start a new one to write');
  const blocked = {
    loading: [cs({ info: null }), 'Loading the chat…'],
    sending: [cs({ sending: true }), 'Sending…'],
    starting: [cs({ rpc: { state: 'starting' } }), 'The session is starting…'],
    working: [cs({ rpc: { state: 'busy' } }), 'The session is working: wait until it is idle, or press Stop'],
    compacting: [cs({ rpc: { state: 'idle', compacting: true } }), 'The session is compacting its context: wait a moment'],
    asking: [cs({ rpc: { state: 'asking' } }), 'pi is asking something: answer it in the card of the chat'],
    unknown: [cs({ rpc: undefined }), 'The session state is unknown'],
  };
  for (const [k, [v, reason]] of Object.entries(blocked)) {
    assert.equal(v.canSend, false, k);
    assert.equal(v.placeholder, k === 'working' ? 'Correct the agent, or queue a message for later…' : '', `${k}: quiet placeholder (RP236: a working session takes a correction)`);
    assert.equal(v.reason, reason, `${k}: the reason is untouched`);
  }
});

test('style.css: the foot keeps 12 px where the system reserves nothing and clears the safe area; rounder corners only for a finger', () => {
  const rule = /\n\.composer \{[^}]*\}/.exec(css)[0];
  assert.match(rule, /margin: 0 max\(12px, env\(safe-area-inset-right, 0px\)\) max\(12px, env\(safe-area-inset-bottom, 0px\)\) max\(12px, env\(safe-area-inset-left, 0px\)\);/);
  assert.match(rule, /border-radius: 12px;/);
  assert.match(rule, /padding: 8px 8px 6px;/);
  const coarse = /@media \(pointer: coarse\) \{[^\n]*\.composer \{ border-radius: 16px; \}[^\n]*\}/.exec(css);
  assert.ok(coarse, 'the 16 px radius sits under (pointer: coarse)');
  assert.equal(css.match(/\.composer\s*\{[^}]*border-radius: 16px/g).length, 1);
  assert.equal(css.match(/(^|\n)[^\n{]*\.composer\s*\{[^}]*\bmargin:/g).length, 1, 'no other rule sets the margin of .composer');
});

test('app.js: without the helper the old rule holds (a page where view.js did not load still sends with Enter, never with Shift or an IME composition)', () => {
  const src = read('app.js');
  assert.ok(src.includes('V && V.enterSends ? V.enterSends('), 'the helper is used only when it exists');
  assert.ok(src.includes(': !e.shiftKey && !e.isComposing'), 'the fallback is the rule of before RP207');
  assert.ok(!src.includes('if (!V.enterSends('), 'no unguarded call');
});
