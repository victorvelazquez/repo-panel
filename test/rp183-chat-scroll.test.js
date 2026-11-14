'use strict';
// RP183: the chat keeps its place. The list of the chat is repainted with innerHTML and only knew how to stay at the bottom; when the browser reset it (a repaint
// at the end, the keyboard opening) nothing put it back, and it went to the first messages. Now a snapshot of the position is taken before a repaint and when the
// keyboard is about to move things, and restored after: pinned to the end stays pinned, reading higher up stays there, and ONLY a jump to zero is undone.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const read = (f) => fs.readFileSync(path.join(__dirname, '..', 'public', f), 'utf8').replace(/\r\n/g, '\n');

function loadChat() {
  const ctx = vm.createContext({ console, window: {}, localStorage: { getItem: () => null } });
  ctx.window = ctx;
  vm.runInContext(read('chat.js'), ctx);
  return ctx;
}
const body = (o = {}) => ({ scrollTop: 0, scrollHeight: 1000, clientHeight: 100, ...o });

test('chatScrollSnap: pinned to the end (under 24 px) is stuck; reading higher up is not; an empty list counts as stuck', () => {
  const c = loadChat();
  assert.deepEqual({ ...c.chatScrollSnap(body({ scrollTop: 900 })) }, { top: 900, stuck: true });
  assert.deepEqual({ ...c.chatScrollSnap(body({ scrollTop: 877 })) }, { top: 877, stuck: true });
  assert.deepEqual({ ...c.chatScrollSnap(body({ scrollTop: 876 })) }, { top: 876, stuck: false });
  assert.deepEqual({ ...c.chatScrollSnap(body({ scrollTop: 300 })) }, { top: 300, stuck: false });
  assert.equal(c.chatScrollSnap(body({ scrollHeight: 0, scrollTop: 0 })).stuck, true);
});

test('chatScrollSnap: a list that is not measured yet (no clientHeight, no height) counts as stuck, as it always did', () => {
  const c = loadChat();
  assert.equal(c.chatScrollSnap({ scrollTop: 0, scrollHeight: 0 }).stuck, true);
  assert.equal(c.chatScrollSnap({ scrollTop: 0 }).stuck, true);
});

test('keyboard: a new mark replaces the old one, inside the window and after it expired', () => {
  const c = loadChat();
  const b = body({ scrollTop: 900 });
  c.chatKeyboardMark(b, 0);
  b.scrollTop = 300; // the person scrolled up, then touched the box again
  c.chatKeyboardMark(b, 500);
  b.scrollTop = 0;
  assert.equal(c.chatKeyboardFix(b, 600), true);
  assert.equal(b.scrollTop, 300, 'the new position, not the old one pinned to the end');
  const later = body({ scrollTop: 400 });
  c.chatKeyboardMark(later, 5000); // long after the first mark expired
  later.scrollTop = 0;
  assert.equal(c.chatKeyboardFix(later, 5100), true);
  assert.equal(later.scrollTop, 400);
});

test('chatScrollSnap and chatScrollRestore never throw on garbage', () => {
  const c = loadChat();
  for (const bad of [null, undefined, {}, 5, 'x']) {
    assert.doesNotThrow(() => c.chatScrollSnap(bad));
    assert.doesNotThrow(() => c.chatScrollRestore(bad, { top: 5, stuck: false }));
    assert.doesNotThrow(() => c.chatScrollRestore(body(), bad));
  }
  assert.equal(c.chatScrollRestore(null, null), false);
});

test('chatScrollRestore: a list that was pinned to the end goes back to the end, whatever the browser did', () => {
  const c = loadChat();
  const b = body({ scrollTop: 0, scrollHeight: 1500 });
  assert.equal(c.chatScrollRestore(b, { top: 900, stuck: true }), true);
  assert.equal(b.scrollTop, 1500);
  const half = body({ scrollTop: 400, scrollHeight: 1500 });
  c.chatScrollRestore(half, { top: 900, stuck: true });
  assert.equal(half.scrollTop, 1500, 'pinned means pinned: the new last message must be seen');
});

test('chatScrollRestore: a list the person was reading higher up goes back where it was, but ONLY when it was thrown to zero', () => {
  const c = loadChat();
  const reset = body({ scrollTop: 0 });
  assert.equal(c.chatScrollRestore(reset, { top: 300, stuck: false }), true);
  assert.equal(reset.scrollTop, 300);
  const moved = body({ scrollTop: 250 });
  assert.equal(c.chatScrollRestore(moved, { top: 300, stuck: false }), false, 'the person scrolled: never fight the finger');
  assert.equal(moved.scrollTop, 250);
  const top = body({ scrollTop: 0 });
  assert.equal(c.chatScrollRestore(top, { top: 0, stuck: false }), false, 'it was at the very top: nothing to undo');
  assert.equal(top.scrollTop, 0);
});

test('keyboard: a mark, then every fix inside 1.5 s restores it; after that it does nothing and forgets', () => {
  const c = loadChat();
  const b = body({ scrollTop: 900 });
  c.chatKeyboardMark(b, 1000);
  b.scrollTop = 0; // the keyboard opened and the browser threw the list to the top
  assert.equal(c.chatKeyboardFix(b, 1200), true);
  assert.equal(b.scrollTop, 1000, 'stuck: back to the end (scrollHeight)');
  b.scrollTop = 0;
  assert.equal(c.chatKeyboardFix(b, 2400), true, 'resize fires many times while the keyboard animates');
  b.scrollTop = 0;
  assert.equal(c.chatKeyboardFix(b, 2501), false, 'older than 1.5 s');
  assert.equal(b.scrollTop, 0);
  assert.equal(c.chatKeyboardFix(b, 2502), false, 'and it forgot the mark');
});

test('keyboard: a fix with no mark does nothing; reading higher up is kept; the person scrolling is never fought', () => {
  const c = loadChat();
  assert.equal(c.chatKeyboardFix(body({ scrollTop: 0 }), 5000), false);
  const b = body({ scrollTop: 300 });
  c.chatKeyboardMark(b, 0);
  b.scrollTop = 0;
  assert.equal(c.chatKeyboardFix(b, 100), true);
  assert.equal(b.scrollTop, 300);
  b.scrollTop = 220; // the person is dragging
  assert.equal(c.chatKeyboardFix(b, 200), false);
  assert.equal(b.scrollTop, 220);
});

test('chatNextFrame runs the function on the next frame, or at once where there is no requestAnimationFrame', () => {
  const c = loadChat();
  let ran = 0;
  c.chatNextFrame(() => { ran += 1; });
  assert.equal(ran, 1, 'no requestAnimationFrame here: at once');
  const later = [];
  c.requestAnimationFrame = (fn) => later.push(fn);
  c.chatNextFrame(() => { ran += 10; });
  assert.equal(ran, 1, 'deferred');
  later[0]();
  assert.equal(ran, 11);
});

test('drawChat takes the snapshot before the repaint, restores it now and one frame later, and a different chat still starts at the end', () => {
  const src = read('chat.js');
  const i = src.indexOf("const body = $('#chatBody');");
  const block = src.slice(i, src.indexOf('chatShown = S.chat.id;', i));
  assert.match(block, /const snap = chatScrollSnap\(body\);/);
  assert.match(block, /if \(chatShown !== S\.chat\.id\) snap\.stuck = true;/);
  assert.ok(block.indexOf('chatScrollSnap(body)') < block.indexOf('paint(body'), 'snapshot first');
  assert.match(block, /if \(paint\(body, R\.chatBody\(shown, \{ now: Date\.now\(\) \}\)\)\) \{\s*chatScrollRestore\(body, snap\);\s*chatNextFrame\(\(\) => chatScrollRestore\(body, snap\)\);\s*\}/);
});

test('app.js wires the keyboard, guarded for a page with no visualViewport: mark on touching the box and on focus in and out, fix on every resize', () => {
  const app = read('app.js');
  assert.match(app, /const kbMark = \(\) => chatKeyboardMark\(\$\('#chatBody'\), Date\.now\(\)\);/);
  assert.match(app, /const kbFix = \(\) => \{ chatKeyboardFix\(\$\('#chatBody'\), Date\.now\(\)\); chatNextFrame\(\(\) => chatKeyboardFix\(\$\('#chatBody'\), Date\.now\(\)\)\); \};/);
  assert.match(app, /document\.addEventListener\('focusin', \(e\) => \{ if \(e\.target && e\.target\.id === 'msgBox'\) kbMark\(\); \}\);/);
  assert.match(app, /document\.addEventListener\('focusout', \(e\) => \{ if \(e\.target && e\.target\.id === 'msgBox'\) kbMark\(\); \}\);/);
  assert.match(app, /if \(composerBox && composerBox\.addEventListener\) composerBox\.addEventListener\('touchstart', kbMark, \{ passive: true \}\);/);
  assert.match(app, /if \(window\.visualViewport && window\.visualViewport\.addEventListener\) window\.visualViewport\.addEventListener\('resize', kbFix\);/);
});

test('chat.js keeps no listener at the top level (they stay in app.js, which loads last)', () => {
  assert.doesNotMatch(read('chat.js'), /^(document|window)\.addEventListener|^\$\([^)]*\)\.addEventListener/m);
});

test('the README explains how the chat keeps its place', () => {
  assert.match(fs.readFileSync(path.join(__dirname, '..', 'README.md'), 'utf8'), /RP183/);
});
