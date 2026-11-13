'use strict';
// RP156 (S26, S57): the chips of the chat (the state of the session, the memory, the context and the subagent) draw their icons as SVG, the family of the icons of the rest of the page (16 grid, stroke 1.5, currentColor), instead of
// text characters that each system draws with another shape and size. Direction chosen by the person in design/panel-chips/: the icons of A (02-linea) at every width and the collapse of C (04-solo-icono-angosto) in a narrow chat:
// under about 480 px of chat (the composer is 24 px narrower) a chip keeps only its icon, the number of the context and the time of the subagent; the word stays in the markup, visually hidden, so the accessible name does not change.
// What does NOT change: the words, the titles of help, the tones, the rules of when each chip shows (RP110b, RP139, RP140, RP152) and the Compact, Terminal and Close session buttons.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const R = require('../public/resumen.js');

const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'style.css'), 'utf8').replace(/\r\n/g, '\n');
const text = (html) => html.replace(/<[^>]*>/g, '').trim();
const GLYPHS = /[●○◌◍◐◔▲✖↳]/;
const INFO = { adopted: { id: 's1', name: 'panel:alpha' }, adoptedFound: true, sessions: [] };
const adopted = (rpc) => ({ id: 'r1', info: INFO, rpc });
const ico = (html) => { const m = /<svg[\s\S]*?<\/svg>/.exec(html); assert.ok(m, `an svg in ${html}`); return m[0]; };

// ---------- the state of the session ----------
const SESSION = [
  ['loading', { info: null }, 'Loading…'], ['none', adopted({ state: 'closed' }), 'Not started'], ['starting', adopted({ state: 'starting' }), 'Starting…'], ['free', adopted({ state: 'idle' }), 'Idle'],
  ['working', adopted({ state: 'busy' }), 'Working…'], ['compacting', adopted({ state: 'idle', compacting: true }), 'Compacting…'], ['waiting', adopted({ state: 'asking' }), 'Asking you something'], ['unknown', adopted({ state: 'bogus' }), 'Unknown'],
];

test('s1: every state of the session has its OWN drawn icon (eight different shapes: Idle, Not started and Loading… used to share one glyph), no text character, and the word and the title are the ones of always', () => {
  const icons = new Set();
  for (const [key, c, word] of SESSION) {
    const s = R.sessionState(c, { name: 'alpha' });
    assert.equal(s.key, key);
    assert.equal(s.word, word);
    assert.match(s.icon, /^<svg [^>]*aria-hidden="true"[^>]*>[\s\S]*<\/svg>$/, key);
    assert.doesNotMatch(s.icon, GLYPHS, key);
    icons.add(s.icon);
  }
  assert.equal(icons.size, 8, 'eight states, eight shapes');
});

test('s2: the label is ONE span with role=status: the icon in i.ss-dot, the word in span.ss-word, the tone and the key as classes, and the title escaped; the visible text is the word', () => {
  for (const [key, c, word] of SESSION) {
    const s = R.sessionState(c, { name: 'alpha' });
    const html = R.sessionLabelHtml(c);
    assert.match(html, /^<span class="ss [^"]*" role="status" title="[^"]*"><i class="ss-dot" aria-hidden="true"><svg /, key);
    assert.ok(html.includes(`<span class="ss-word">${word}</span></span>`), key);
    assert.ok(html.includes(`title="${R.esc(s.title)}"`), key);
    assert.equal(text(html), word, key);
    assert.doesNotMatch(html, GLYPHS, key);
    for (const cl of ['ss', `ss-${s.tone}`, `ss-${key}`]) assert.match(html, new RegExp(`class="[^"]*\\b${cl}\\b`), `${key} ${cl}`);
    assert.equal(/ss-anim/.test(html), ['working', 'starting', 'compacting'].includes(key), `${key}: only the three that already pulse move`);
  }
});

// ---------- the memory ----------
const MEMORY = [['ready', 'memory ready', 'mem-ready'], ['offline', 'memory offline', 'mem-bad'], ['error', 'memory error', 'mem-bad'], ['disabled', 'memory disabled', 'mem-warn']];
const memory = (m, state = 'idle') => R.memoryChipHtml({ rpc: { state, memory: m } });

test('m1: the memory chip gets the icon it did not have: four different drawings, the word in span.mem-word, the tone of always, the title of always; the visible text is the word', () => {
  const icons = new Set();
  for (const [m, word, tone] of MEMORY) {
    const html = memory(m);
    assert.match(html, new RegExp(`^<span class="mem ${tone}" title="[^"]+"><i class="mem-ic" aria-hidden="true"><svg `), m);
    assert.ok(html.endsWith(`<span class="mem-word">${word}</span></span>`), m);
    assert.equal(text(html), word, m);
    icons.add(ico(html));
  }
  assert.equal(icons.size, 4, 'ready, offline, error and disabled do not share a drawing');
});

test('m2: what showed nothing still shows nothing: a closed session, no category, a category that is not on the list', () => {
  for (const c of [null, undefined, {}, { rpc: null }, { rpc: { state: 'closed', memory: 'ready' } }, { rpc: { state: 'idle' } }, { rpc: { state: 'idle', memory: 'bogus' } }, { rpc: { state: 'idle', memory: 5 } }, { rpc: { state: 'idle', memory: '__proto__' } }]) assert.equal(R.memoryChipHtml(c), '', JSON.stringify(c));
});

// ---------- the context ----------
const ctx = (percent, extra = {}) => R.ctxChipHtml({ rpc: { state: 'idle', ctx: { tokens: percent === null ? null : 1000, percent, window: 200000, ...extra } } });

test('c1: the context draws an arc under 70%, a triangle from 70% and a cross from 90%, a dashed ring when it is not known: four shapes, the tone of always, and the text `ctx NN%` (the number is the rounded percent)', () => {
  const shapes = new Set();
  for (const [p, tone] of [[28, ''], [69, ''], [70, 'mem-warn'], [89, 'mem-warn'], [90, 'mem-bad'], [100, 'mem-bad']]) {
    const html = ctx(p);
    assert.match(html, /^<span class="mem ctx[^"]*" title="[^"]+"><i class="mem-ic" aria-hidden="true"><svg /, String(p));
    assert.equal(/mem-warn/.test(html), tone === 'mem-warn', String(p));
    assert.equal(/mem-bad/.test(html), tone === 'mem-bad', String(p));
    assert.equal(text(html), `ctx ${p}%`, String(p));
    assert.doesNotMatch(html, GLYPHS, String(p));
    shapes.add(p < 70 ? 'arc' : p < 90 ? 'triangle' : 'cross');
  }
  assert.equal(shapes.size, 3);
  const arc = ico(ctx(28)); const tri = ico(ctx(72)); const bad = ico(ctx(93));
  assert.equal(new Set([arc, tri, bad, ico(ctx(null))]).size, 4, 'arc, triangle, cross and unknown are four drawings');
  assert.match(arc, /stroke-dasharray="28 100"/, 'the arc is as long as the percent');
  assert.match(ico(ctx(61.6)), /stroke-dasharray="62 100"/);
  assert.match(ico(ctx(500)), /<path|<circle/, 'a number past 100 is capped like the text');
  assert.equal(text(ctx(500)), 'ctx 100%');
});

test('c2: ABUSE: unknown reads `ctx —` with its dashed ring and never 0; a percent that is not a number, negative or infinite is unknown; nothing but the rounded number reaches the markup', () => {
  assert.equal(text(ctx(null)), 'ctx —');
  assert.match(ico(ctx(null)), /stroke-dasharray="2 2\.2"/);
  for (const p of [NaN, Infinity, -Infinity, -1, '62', undefined, {}, [], true]) assert.equal(text(R.ctxChipHtml({ rpc: { state: 'idle', ctx: { tokens: 1, percent: p, window: 200000 } } })), 'ctx —', String(p));
  for (const w of [0, -5, 1.5, NaN, '200000', null]) assert.equal(text(R.ctxChipHtml({ rpc: { state: 'idle', ctx: { tokens: 1, percent: 50, window: w } } })), 'ctx —', `window ${String(w)}`);
  for (const st of ['closed', 'starting']) assert.equal(R.ctxChipHtml({ rpc: { state: st, ctx: { tokens: 1, percent: 50, window: 10 } } }), '', st);
  for (const c of [null, undefined, {}, { rpc: {} }, { rpc: { state: 'idle' } }, { rpc: { state: 'idle', ctx: null } }]) assert.equal(R.ctxChipHtml(c), '', JSON.stringify(c));
  assert.doesNotMatch(ctx(62), /undefined|NaN|\[object/);
});

test('c3: the word «ctx» is in span.mem-word and the number stays outside it (when the chat is narrow only the word is hidden)', () => {
  assert.match(ctx(62), /<span class="mem-word">ctx <\/span>62%<\/span>$/);
  assert.match(ctx(null), /<span class="mem-word">ctx <\/span>—<\/span>$/);
});

// ---------- the subagent ----------
test('u1: the subagent (RP171: a bubble of the thread, no longer a chip) draws the arrow as an SVG, the words in span.sub-text, the time outside it and hidden from screen readers; the rules of when it shows are the ones of RP152', () => {
  const chat = (rpc, now) => R.chatBody({ id: 'abcdef0123', info: { adopted: { id: 's', name: 'demo' }, adoptedFound: true, sessions: [] }, hist: { items: [], truncated: false }, rpc }, { now });
  const html = chat({ state: 'busy', subs: 1, subSince: 1000 }, 1000 + 134000);
  assert.match(html, /<div class="m subrun" role="status"><i class="sub-dot" aria-hidden="true"><svg /);
  assert.ok(html.includes('<span class="sub-text">Subagent working</span>'));
  assert.match(html, /<b class="sub-time" aria-hidden="true">02:14<\/b><\/div>$/);
  assert.doesNotMatch(/<div class="m subrun"[\s\S]*?<\/div>/.exec(html)[0], GLYPHS);
  assert.ok(chat({ state: 'busy', subs: 3, subSince: 1000 }, 5000).includes('<span class="sub-text">3 subagents working</span>'));
  for (const rpc of [null, undefined, {}, { state: 'idle', subs: 1, subSince: 1000 }, { state: 'busy', subs: 0, subSince: 1000 }, { state: 'busy', subs: 1, subSince: 0 }]) assert.doesNotMatch(chat(rpc, 5000), /Subagent/, JSON.stringify(rpc));
});

// ---------- the buttons ----------
test('b1: Close session keeps its words for the accessible name and the title, and a narrow chat shows «Close»; Terminal and Compact are unchanged', () => {
  const close = R.sessionCloseHtml(true, false);
  assert.match(close, /^<button type="button" class="ss-close" data-act="session-close" title="Stop this session and go back to the list of sessions">Close<span class="ss-long"> session<\/span><\/button>$/);
  assert.equal(text(close), 'Close session');
  assert.equal(R.sessionCloseHtml(false, false), '');
  assert.match(R.sessionCloseHtml(true, true), / disabled /);
  assert.match(R.sessionTerminalHtml(true, null), />Terminal<\/button>$/);
  assert.match(R.compactButtonHtml({ info: INFO, rpc: { state: 'idle' } }), />Compact<\/button>$/);
});

// ---------- the stylesheet ----------
const rules = [...css.matchAll(/(?:^|\n)([^{}\n@/ ][^{}\n]*)\{([^}]*)\}/g)].flatMap((m) => m[1].split(',').map((s) => ({ sel: s.trim().replace(/\s+/g, ' '), body: m[2] })));
const rule = (sel) => { const r = rules.filter((x) => x.sel === sel); assert.ok(r.length, `a rule for ${sel}`); return r.map((x) => x.body).join(';'); };

test('t1: the composer is the container of the row and a narrow chat hides ONLY the words, visually (the clip way: never display:none, so the accessible name does not change), at 456 px of composer (480 of chat)', () => {
  assert.match(rule('.composer'), /container-type:\s*inline-size/);
  assert.match(rule('.composer'), /container-name:\s*cmp/);
  const q = /@container cmp \(max-width:\s*456px\)\s*\{\s*([\s\S]*?)\n\}/.exec(css);
  assert.ok(q, 'the container query of the composer');
  assert.match(q[1], /\.ss-word,\s*\.mem-word,\s*\.ss-long\s*\{[^}]*clip-path:\s*inset\(50%\)/);
  assert.doesNotMatch(q[1], /display:\s*none/);
  assert.match(q[1], /position:\s*absolute/);
  assert.match(q[1], /width:\s*1px/);
});

test('t2: the icons sit in the line with the text (inline-flex, centred) and do not move the row; the pulse of the three states stays and stops under reduced motion', () => {
  assert.match(rule('.mem'), /display:\s*inline-flex/);
  assert.match(rule('.mem'), /align-items:\s*center/);
  assert.match(css, /\.ss-dot svg,\s*\.mem-ic svg,\s*\.sub-dot svg\s*\{[^}]*display:\s*block/);
  assert.match(css, /\.ss-anim \.ss-dot\s*\{[^}]*animation:\s*pulse-dot/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)[^{]*\{[^}]*\.ss-anim \.ss-dot[^}]*animation:\s*none/);
});

test('t3: the row of the chips wraps to a second line instead of cutting a button at the edge of the composer (seen at 1440 and 360 px with every chip on)', () => {
  assert.match(rule('.sess-state'), /flex-wrap:\s*wrap/);
  assert.match(rule('.sess-state'), /row-gap:\s*4px/);
});
