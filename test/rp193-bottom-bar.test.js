'use strict';
// RP193 (S24): under 760 px the three menus of the header (Sessions, Conformity, Settings) are a bar at the BOTTOM of three icons with one short word under each. The nav stays inside <header> in the HTML
// (CSS pulls it out of the flow), the bar hides in the chat and Repo screens, tapping an icon never writes the browser history, and desktop and tablet keep the tabs in the header as before.
// Plain CSS cannot be run here: these tests read the page as text; how it LOOKS is for the person to try on the phone.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const V = require('../public/view.js');

const read = (f) => fs.readFileSync(path.join(__dirname, '..', 'public', f), 'utf8').replace(/\r\n/g, '\n');
const html = read('index.html');
const css = read('style.css').replace(/\/\*[\s\S]*?\*\//g, '');
const tabsJs = read('tabs.js');
const actionsJs = read('actions.js');
const header = /<header>[\s\S]*?<\/header>/.exec(html)[0];
const nav = /<nav class="rs-tabs"[\s\S]*?<\/nav>/.exec(header)[0];
const buttons = [...nav.matchAll(/<button[^>]*>[\s\S]*?<\/button>/g)].map((m) => m[0]);
const MOBILE = '(max-width: 759.98px)';
const phoneBlocks = [...css.matchAll(/@media ([^{]*)\{((?:[^{}]*\{[^}]*\})*)\s*\}/g)].filter((m) => m[1].trim() === MOBILE).map((m) => m[2]);
const phone = phoneBlocks.join('\n');
const outsidePhone = phoneBlocks.reduce((s, b) => s.replace(b, ''), css);
const rule = (src, sel) => [...src.matchAll(/(?:^|\n|\})\s*([^{}@]+)\{([^}]*)\}/g)].filter((m) => m[1].split(',').some((s) => s.trim().replace(/\s+/g, ' ') === sel)).map((m) => m[2]).join(';');

test('a1: the three tabs stay inside <header>, in order, each with ONE icon (hidden from assistive tools) and ONE short word in .tab-tx', () => {
  assert.equal(buttons.length, 3);
  assert.deepEqual(buttons.map((b) => /data-tab="(\w+)"/.exec(b)[1]), ['summary', 'conformity', 'settings']);
  for (const b of buttons) {
    assert.equal((b.match(/<svg\b[^>]*class="tab-ic"[^>]*aria-hidden="true"/g) || []).length, 1, b);
    const words = [...b.matchAll(/<span class="tab-tx">([^<]*)<\/span>/g)].map((m) => m[1]);
    assert.equal(words.length, 1);
    assert.match(words[0], /^[A-Za-z]{1,11}$/, 'one short word');
  }
});

test('a2: Sessions has an icon like the other two (svg.tab-ic, viewBox 0 0 16 16, stroke currentColor, aria-hidden) and its word is wrapped in .tab-tx', () => {
  const s = buttons[0];
  assert.match(s, /<svg[^>]*class="tab-ic"[^>]*viewBox="0 0 16 16"|<svg[^>]*viewBox="0 0 16 16"[^>]*class="tab-ic"/);
  assert.match(s, /<svg[^>]*stroke="currentColor"/);
  assert.match(s, /aria-hidden="true"/);
  assert.match(s, /<span class="tab-tx">Sessions<\/span><\/button>$/);
  assert.match(s, /aria-selected="true"/);
});

test('b1: under 760 px the nav is a bar fixed to the bottom edge, edge to edge, with a background and a top border', () => {
  const r = rule(phone, 'header .rs-tabs');
  assert.match(r, /position:\s*fixed/);
  for (const p of [/left:\s*0/, /right:\s*0/, /bottom:\s*0/, /border-top:\s*1px solid var\(--line\)/, /background:\s*var\(--panel\)/]) assert.match(r, p);
});

test('b2: each item of the bar shows its icon and its word (the old rule that hid the word is gone), icon over word, at least 44 px tall', () => {
  assert.doesNotMatch(phone, /\.tab-tx\s*\{[^}]*display:\s*none/);
  assert.match(rule(phone, 'header .rs-tabs .tab-ic'), /display:\s*block/);
  const item = rule(phone, 'header .rs-tabs button');
  assert.match(item, /flex-direction:\s*column/);
  assert.match(item, /flex:\s*1 1 0/);
  assert.ok(Number(/min-height:\s*(\d+)px/.exec(item)[1]) >= 44);
  assert.ok(Number(/min-height:\s*(\d+)px/.exec(rule(phone, 'header .rs-tabs .tab-dual'))[1]) >= 44, 'the coarse-pointer rule of 44 px cannot shrink the others');
});

test('b3: the bottom edge keeps a floor of 12 px and grows with the iOS inset (it looks right with the inset at 0)', () => {
  assert.match(rule(phone, ':root'), /--tabbar-pad:\s*max\(12px,\s*env\(safe-area-inset-bottom,\s*0px\)\)/);
  assert.match(rule(phone, 'header .rs-tabs'), /padding:[^;]*var\(--tabbar-pad\)/);
  assert.match(rule(phone, ':root'), /--tabbar-h:\s*calc\(\d+px \+ var\(--tabbar-pad\)\)/);
});

// The hide rule is `body.<tab>:has(A, B) header .rs-tabs`: the model below reads it from the CSS and applies it to a state of the page.
const hideRule = [...phone.matchAll(/([^{}]*header \.rs-tabs)\s*\{([^}]*)\}/g)].find((m) => /display:\s*none/.test(m[2]) && /:has\(/.test(m[1]));
function barShown({ tab, hidden, screen }) {
  const m = /^\s*body\.([\w-]+):has\((.*)\)\s+header \.rs-tabs\s*$/.exec(hideRule[1]);
  assert.ok(m, 'the hide rule is body.<tab>:has(...) header .rs-tabs');
  const bodyMatches = tab === m[1].replace(/^tab-/, '');
  const inner = m[2].split(',').some((sel) => { const x = /#sumLayout(:not\(\[hidden\]\))?\[data-screen="(\w+)"\]/.exec(sel); return x && (x[1] ? !hidden : true) && x[2] === screen; });
  return !(bodyMatches && inner);
}

test('c1: the bar is hidden when a chat or a Repo screen is open on Sessions', () => {
  assert.ok(hideRule, 'a hide rule exists inside the phone rules');
  assert.equal(barShown({ tab: 'summary', hidden: false, screen: 'chat' }), false);
  assert.equal(barShown({ tab: 'summary', hidden: false, screen: 'repo' }), false);
  assert.equal(barShown({ tab: 'summary', hidden: false, screen: 'list' }), true);
});

test('c2: chat open, then Conformity or Settings (#sumLayout keeps data-screen="chat" but is hidden): the bar is there', () => {
  for (const screen of ['chat', 'repo']) for (const tab of ['conformity', 'settings', 'work']) {
    assert.equal(barShown({ tab, hidden: true, screen }), true, `${tab} with ${screen} kept`);
  }
  assert.match(tabsJs, /\$\('#sumLayout'\)\.hidden = S\.tab !== 'summary'/, 'the layout is hidden outside Sessions (that is the case above)');
  assert.match(tabsJs, /classList\.toggle\(`tab-\$\{t\}`, S\.tab === t\)/, 'the body carries tab-<name> for the rule');
});

test('d1: the active item is marked by aria-selected, which applyTab keeps, and only changes colour and takes the soft layer (no solid button)', () => {
  assert.match(tabsJs, /querySelectorAll\('header \[role=tab\]\[data-tab\]'\)[\s\S]*setAttribute\('aria-selected', String\(b\.dataset\.tab === S\.tab\)\)/);
  const on = rule(phone, 'header .rs-tabs button[aria-selected="true"]');
  assert.match(on, /color:\s*var\(--text\)/);
  assert.match(on, /background:\s*var\(--panel2\)/);
  assert.match(on, /border-bottom-color:\s*transparent|border-bottom:\s*0/, 'no blue underline on the phone');
  assert.doesNotMatch(on, /#1f6feb|var\(--blue\)|var\(--green\)/);
  assert.match(rule(phone, 'header .rs-tabs button'), /color:\s*var\(--muted\)/);
});

test('e1: the Conformity badge stays inside the Conformity button and sits on its icon; drawConformity still writes it', () => {
  assert.match(buttons[1], /id="tab-conformity"[\s\S]*<svg class="tab-ic"[\s\S]*<span id="confBadge" class="badge" hidden><\/span><\/button>$/);
  assert.match(rule(phone, 'header .rs-tabs .tab-dual .badge'), /position:\s*absolute/);
  // the button is a third of the width: a corner of the button (right: 0) would leave the badge far from the icon, so it is anchored from the centre
  assert.match(rule(phone, 'header .rs-tabs .tab-dual .badge'), /left:\s*calc\(50%\s*\+\s*\d+px\)/);
  assert.doesNotMatch(rule(phone, 'header .rs-tabs .tab-dual .badge'), /(^|[;\s])right:\s*0/);
  assert.match(tabsJs, /\$\('#confBadge'\)\.hidden = !n;[\s\S]*\$\('#confBadge'\)\.textContent = n;/);
});

test('f1: tapping an icon does not write the browser history or the address, and the address grammar is unchanged', () => {
  const setTab = /function setTab\(tab\) \{[\s\S]*?\n\}/.exec(tabsJs)[0];
  const applyTab = /function applyTab\(\) \{[\s\S]*?\n\}/.exec(tabsJs)[0];
  for (const src of [setTab, applyTab, /'tab': \(el\) => [^\n]*/.exec(actionsJs)[0]]) assert.doesNotMatch(src, /history|location|pushState|replaceState|addressOf|hash/);
  assert.deepEqual(V.parseAddress(''), { kind: 'list' });
  assert.equal(V.addressOf('r1', 'chat'), '#/repo/r1/chat');
  assert.deepEqual(V.parseAddress('#/repo/r1/chat', ['r1']), { kind: 'repo', id: 'r1', zone: 'chat' });
  assert.deepEqual(V.parseAddress('#conformity'), { kind: 'conformity' });
  assert.equal(V.parseAddress('#/settings'), null, 'Settings has no address');
});

test('g1: desktop and tablet (760 px and up) keep the tabs in the header exactly as today: in the flow, text only, 48 px, no bar rules', () => {
  const nav0 = rule(outsidePhone, 'header .rs-tabs');
  assert.doesNotMatch(nav0, /position:|(?<![-w])bottom:|border-top/);
  assert.match(nav0, /padding:\s*0;\s*gap:\s*2px/);
  assert.match(rule(outsidePhone, 'header .rs-tabs .tab-ic'), /display:\s*none/);
  assert.match(rule(outsidePhone, 'header .rs-tabs button'), /min-height:\s*48px/);
  assert.doesNotMatch(outsidePhone, /--tabbar|\.rs-tabs[^{]*\{[^}]*position:\s*fixed/);
  assert.doesNotMatch(outsidePhone, /:has\(#sumLayout/);
  assert.match(rule(outsidePhone, 'header'), /position:\s*sticky/);
});

test('h1: the list screen leaves room for the bar (all three height declarations); chat and Repo screens do not subtract it', () => {
  const list = rule(phone, '#sumLayout[data-screen="list"]');
  const heights = [...list.matchAll(/height:\s*([^;]*)/g)].map((m) => m[1]);
  assert.equal(heights.length, 3);
  for (const h of heights) assert.match(h, /var\(--sum-top[^)]*\)\s*-\s*var\(--tabbar-h\)/);
  assert.doesNotMatch(rule(css, '#sumLayout[data-screen]'), /tabbar/, 'the base rule (chat and Repo) is the one of before');
  assert.ok(css.lastIndexOf('#sumLayout[data-screen="list"] {') > css.indexOf('#sumLayout[data-screen] { flex-direction'), 'it comes after the base rule, so it wins at equal weight');
});

test('h2: Conformity and Settings (and Work) leave room under their bodies, and the toasts rise above the bar', () => {
  assert.match(rule(phone, '.rs-panel'), /padding-bottom:\s*calc\([^;]*var\(--tabbar-h\)/);
  assert.match(rule(phone, '#work'), /padding-bottom:\s*var\(--tabbar-h\)/);
  assert.match(rule(phone, '#toasts'), /bottom:\s*calc\(var\(--tabbar-h\)/);
});
