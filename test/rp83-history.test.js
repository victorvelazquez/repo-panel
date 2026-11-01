'use strict';
// RP83 (S3): the arrow keys of the message box recall what was sent to the session, like the prompt of pi. Up brings the last message,
// another Up the one before, and so on; Down walks forward and, past the newest, gives back what the person was typing. The arrows only act
// on the first line (Up) or the last line (Down) of the box, never with a modifier or during an IME composition, so editing a multi-line
// message is untouched. Pure helpers in resumen.js and the key handling of app.js, driven here with fake keyboard events. No network.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const R = require('../public/resumen.js');

const PUBLIC = path.join(__dirname, '..', 'public');
const item = (role, text) => ({ role, text, at: '2026-05-01T12:00:00Z', tools: [] });

// ---------- pure ----------
test('h1: the history is the person\'s messages in order, then the pending ones, without empty or repeated-in-a-row entries', () => {
  const items = [item('user', 'one'), item('assistant', 'reply'), item('user', 'two'), item('user', 'two'), item('user', '   '), item('user', 'three')];
  assert.deepEqual(R.inputHistory(items, [{ text: 'four', state: 'sending' }]), ['one', 'two', 'three', 'four']);
  assert.deepEqual(R.inputHistory(items, [{ text: 'three', state: 'ok' }]), ['one', 'two', 'three'], 'a pending copy of the last one is not repeated');
  assert.deepEqual(R.inputHistory([item('user', 'a'), item('user', 'b'), item('user', 'a')], []), ['a', 'b', 'a'], 'only consecutive repeats go');
});

test('h2: the history is total: any input gives an array of strings', () => {
  for (const [a, b] of [[undefined, undefined], [null, null], [{}, 'x'], [[null, 3, {}, { role: 'user' }, { role: 'user', text: 5 }], [null, { text: 5 }, 7]]]) {
    const h = R.inputHistory(a, b);
    assert.ok(Array.isArray(h) && h.every((x) => typeof x === 'string'));
  }
});

test('h3: Up walks back one message at a time and stops at the oldest; Down walks forward and returns the draft past the newest', () => {
  const hist = ['first', 'second', 'third'];
  let s = R.historyStep(null, 'up', 'my draft', hist);
  assert.deepEqual([s.text, s.nav.i], ['third', 2]);
  s = R.historyStep(s.nav, 'up', s.text, hist);
  assert.equal(s.text, 'second');
  s = R.historyStep(s.nav, 'up', s.text, hist);
  assert.equal(s.text, 'first');
  s = R.historyStep(s.nav, 'up', s.text, hist);
  assert.equal(s.text, 'first', 'the oldest stays');
  s = R.historyStep(s.nav, 'down', s.text, hist);
  assert.equal(s.text, 'second');
  s = R.historyStep(s.nav, 'down', s.text, hist);
  assert.equal(s.text, 'third');
  s = R.historyStep(s.nav, 'down', s.text, hist);
  assert.deepEqual([s.text, s.nav], ['my draft', null], 'the draft is back and browsing is over');
});

test('h4: nothing to do gives null: Down when not browsing, and Up with an empty history', () => {
  assert.equal(R.historyStep(null, 'down', 'x', ['a']), null);
  assert.equal(R.historyStep(null, 'up', 'x', []), null);
  assert.equal(R.historyStep(null, 'sideways', 'x', ['a']), null);
});

test('h5: if the history changed while browsing the position is clamped, never undefined', () => {
  const s = R.historyStep({ i: 5, stash: 'd' }, 'up', 'c', ['a', 'b']);
  assert.equal(typeof s.text, 'string');
  const t = R.historyStep({ i: 5, stash: 'd' }, 'down', 'c', ['a', 'b']);
  assert.equal(t.text, 'd');
});

test('h6: the arrows only act on the first line (Up) or the last line (Down) with no selection', () => {
  assert.equal(R.canRecall('up', 'one\ntwo', 2, 2), true, 'cursor inside the first line');
  assert.equal(R.canRecall('up', 'one\ntwo', 5, 5), false, 'second line: the arrow moves the cursor');
  assert.equal(R.canRecall('up', 'one\ntwo', 0, 3), false, 'a selection');
  assert.equal(R.canRecall('up', '', 0, 0), true, 'an empty box');
  assert.equal(R.canRecall('down', 'one\ntwo', 5, 5), true, 'cursor inside the last line');
  assert.equal(R.canRecall('down', 'one\ntwo', 1, 1), false, 'first of two lines');
  assert.equal(R.canRecall('down', 'one', 1, 1), true, 'a single line is both first and last');
  assert.equal(R.canRecall('left', 'x', 0, 0), false);
  assert.equal(R.canRecall('up', 5, 0, 0), false);
});

// ---------- the page ----------
function element(extra = {}) {
  const el = {
    writes: 0, html: '', hidden: false, dataset: {}, value: '', textContent: '', attrs: {}, selectionStart: 0, selectionEnd: 0,
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false }, style: { setProperty() {} },
    addEventListener() {}, setAttribute(k, v) { el.attrs[k] = v; }, querySelector: () => null, querySelectorAll: () => [], closest: () => null, focus() {},
    setSelectionRange(a, b) { el.selectionStart = a; el.selectionEnd = b; },
    get innerHTML() { return el.html; },
    set innerHTML(v) { el.html = String(v); el.writes++; },
    ...extra,
  };
  return el;
}
function loadPage() {
  const els = {};
  const listeners = [];
  const get = (sel) => (els[sel] ||= (sel === 'meta[name=token]' ? element({ content: 'token' }) : element()));
  const ctx = vm.createContext({
    console, document: { hidden: false, querySelector: get, querySelectorAll: () => [], addEventListener: (type, fn) => listeners.push({ type, fn }), createElement: () => element(), body: element(), activeElement: null },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} }, location: { hash: '' },
    requestAnimationFrame: () => 1, setInterval: () => 0, setTimeout: () => 0, clearTimeout: () => {}, AbortController, confirm: () => true,
    fetch: () => new Promise(() => {}),
  });
  ctx.window = ctx;
  ctx.addEventListener = () => {};
  ctx.RepoPanelView = require('../public/view.js');
  ctx.RepoPanelResumen = R;
  vm.runInContext(fs.readFileSync(path.join(PUBLIC, 'app.js'), 'utf8').replace(/\r\n/g, '\n'), ctx);
  const box = get('#msgBox');
  box.id = 'msgBox'; // a real element knows its id; the stub does not
  // One keydown: returns whether the page stopped the default action (the arrow did not move the cursor).
  const key = (k, { value, start, end, ...mods } = {}) => {
    if (value !== undefined) { box.value = value; box.selectionStart = start ?? value.length; box.selectionEnd = end ?? start ?? value.length; }
    let stopped = false;
    const ev = { type: 'keydown', key: k, target: box, preventDefault() { stopped = true; }, stopPropagation() {}, ...mods };
    for (const l of listeners.filter((x) => x.type === 'keydown')) l.fn(ev);
    return stopped;
  };
  const typed = (text) => { box.value = text; box.selectionStart = box.selectionEnd = text.length; for (const l of listeners.filter((x) => x.type === 'input')) l.fn({ type: 'input', target: box }); };
  const run = (c) => vm.runInContext(c, ctx);
  return { box, key, typed, run, get };
}
const withChat = (page, id = 'abc', texts = ['first', 'second', 'third']) => {
  page.run(`S.chat = { id: ${JSON.stringify(id)}, seq: 1, hist: { items: ${JSON.stringify(texts.flatMap((t) => [item('user', t), item('assistant', `re ${t}`)]))} } };`);
};

test('p1: three Ups bring the last, the one before and the one before that, in sequence', () => {
  const page = loadPage();
  withChat(page);
  assert.equal(page.key('ArrowUp', { value: '' }), true);
  assert.equal(page.box.value, 'third');
  page.key('ArrowUp');
  assert.equal(page.box.value, 'second');
  page.key('ArrowUp');
  assert.equal(page.box.value, 'first');
  page.key('ArrowUp');
  assert.equal(page.box.value, 'first', 'the oldest stays');
  assert.equal(page.box.selectionStart, 'first'.length, 'the cursor goes to the end');
});

test('p2: Down walks forward and past the newest gives back the draft that was being typed', () => {
  const page = loadPage();
  withChat(page);
  page.key('ArrowUp', { value: 'half a sentence' });
  page.key('ArrowUp');
  assert.equal(page.box.value, 'second');
  assert.equal(page.key('ArrowDown'), true);
  assert.equal(page.box.value, 'third');
  assert.equal(page.key('ArrowDown'), true);
  assert.equal(page.box.value, 'half a sentence');
  assert.equal(page.key('ArrowDown'), false, 'not browsing any more: the key is left alone');
});

test('p3: with nothing to recall the page leaves the arrows alone', () => {
  const page = loadPage();
  page.run('S.chat = { id: "abc", seq: 1 };');
  assert.equal(page.key('ArrowUp', { value: 'x' }), false);
  assert.equal(page.key('ArrowDown', { value: 'x' }), false);
  assert.equal(page.box.value, 'x');
  withChat(page);
  assert.equal(page.key('ArrowDown', { value: 'x' }), false, 'Down without browsing');
});

test('p4: inside a multi-line message the arrows are not taken: only the first line (Up) and the last (Down) recall', () => {
  const page = loadPage();
  withChat(page);
  assert.equal(page.key('ArrowUp', { value: 'line one\nline two', start: 12 }), false, 'Up on the second line moves the cursor');
  assert.equal(page.box.value, 'line one\nline two');
  assert.equal(page.key('ArrowUp', { value: 'line one\nline two', start: 3 }), true, 'Up on the first line recalls');
  assert.equal(page.box.value, 'third');
  assert.equal(page.key('ArrowUp', { value: 'a\nb', start: 0, end: 3 }), false, 'a selection is never taken');
});

test('p5: Shift, Ctrl, Alt, Meta and an IME composition are never taken', () => {
  const page = loadPage();
  withChat(page);
  for (const mods of [{ shiftKey: true }, { ctrlKey: true }, { altKey: true }, { metaKey: true }, { isComposing: true }, { keyCode: 229 }]) {
    assert.equal(page.key('ArrowUp', { value: 'draft', start: 0, ...mods }), false, JSON.stringify(mods));
    assert.equal(page.box.value, 'draft');
  }
});

test('p6: typing in the recalled text ends the browsing: the next Up starts again from the newest', () => {
  const page = loadPage();
  withChat(page);
  page.key('ArrowUp', { value: '' });
  page.key('ArrowUp');
  assert.equal(page.box.value, 'second');
  page.typed('second, edited');
  page.key('ArrowUp', { start: 0 });
  assert.equal(page.box.value, 'third', 'from the newest again');
  page.key('ArrowDown');
  assert.equal(page.box.value, 'second, edited', 'and the edited text is the draft that comes back');
});

test('p7: each repo has its own history, and switching repo forgets the position', () => {
  const page = loadPage();
  withChat(page, 'abc', ['a1', 'a2']);
  page.key('ArrowUp', { value: '' });
  assert.equal(page.box.value, 'a2');
  withChat(page, 'def', ['d1']);
  page.run('S.recall = {};');
  page.key('ArrowUp', { value: '' });
  assert.equal(page.box.value, 'd1');
});

test('p8: pending messages (sent, not yet in the history) are recalled too', () => {
  const page = loadPage();
  withChat(page, 'abc', ['old']);
  page.run("S.pending.abc = [{ text: 'just sent', state: 'sending', base: 0 }];");
  page.key('ArrowUp', { value: '' });
  assert.equal(page.box.value, 'just sent');
  page.key('ArrowUp');
  assert.equal(page.box.value, 'old');
});

test('p9: the page wires the history to the box only, and Enter still sends', () => {
  const app = fs.readFileSync(path.join(PUBLIC, 'app.js'), 'utf8');
  assert.match(app, /e\.target\.id !== 'msgBox'|t\.id !== 'msgBox'/);
  assert.match(app, /e\.key !== 'Enter' \|\| !e\.target \|\| e\.target\.id !== 'msgBox'/, 'the Enter handler is untouched');
  assert.match(app, /delete S\.recall\[id\];[\s\S]{0,120}\$\('#msgBox'\)\.value = '';|\$\('#msgBox'\)\.value = '';[\s\S]{0,60}delete S\.recall\[id\]/, 'sending ends the browsing');
});
