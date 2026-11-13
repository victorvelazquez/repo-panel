'use strict';
// RP174 (13 November, asked by the person): the icon of «Starting…» is an open arc and it used to PULSE (grow, shrink and fade) like the filled dot of «Working…»: an arc that pulses says nothing. It now SPINS, like the spinner of the CI («ck-spin»,
// linear, endless), and stops under `prefers-reduced-motion`. «Working…» and «Compacting…» keep their pulse. Only the animation changes: the words, the titles, the tones, the icons (RP156) and the rules of when each state shows do not.
// The card of the Summary list does not draw «Starting…» today: the server folds it into «working» (`SESSION_OF` in server/summary.js), so the card gets this with RP169, which gives it the chip of the chat.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const R = require('../public/resumen.js');

const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'style.css'), 'utf8').replace(/\r\n/g, '\n');
const label = (rpc) => R.sessionLabelHtml({ id: 'r1', info: { adopted: { id: 's1', name: 'panel:alpha' }, adoptedFound: true, sessions: [] }, rpc });
const body = (sel) => {
  const esc = sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = new RegExp(`(?:^|\\n)${esc}\\s*\\{([^}]*)\\}`).exec(css);
  assert.ok(m, `a rule for ${sel}`);
  return m[1];
};

test('s1: «Starting…» spins: its icon turns with the animation of the CI spinner, linear and endless, and it does not pulse', () => {
  const b = body('.ss-starting.ss-anim .ss-dot');
  assert.match(b, /animation:\s*ck-spin\s+[\d.]+s\s+linear\s+infinite/);
  assert.doesNotMatch(b, /pulse-dot/);
  assert.match(css, /@keyframes ck-spin\s*\{\s*to\s*\{\s*transform:\s*rotate\(360deg\)/);
});

test('s2: «Working…» and «Compacting…» keep the pulse of always, and nothing else pulses or spins', () => {
  assert.match(body('.ss-anim .ss-dot'), /animation:\s*pulse-dot\s+1\.2s\s+ease-in-out\s+infinite/);
  const anim = [...css.matchAll(/(^|\n)([^{}\n@/ ][^{}\n]*\.ss-[a-z-]*[^{}\n]*)\{[^}]*animation:\s*(?!none)/g)].map((m) => m[2].trim());
  assert.deepEqual(anim.sort(), ['.ss-anim .ss-dot', '.ss-ci.ss-anim .ss-dot', '.ss-starting.ss-anim .ss-dot']); // RP170: «Verifying Checks» (the CI of the PR of the branch) turns too
});

test('s3: it stops under reduced motion, like every animation of the page', () => {
  const m = /@media \(prefers-reduced-motion: reduce\)\s*\{([^@]*?)\n\}/.exec(css.slice(css.indexOf('.ss-anim .ss-dot')));
  assert.ok(m, 'the reduced motion block of the state chip');
  assert.match(m[1], /\.ss-anim \.ss-dot\s*\{\s*animation:\s*none/);
  assert.match(m[1], /\.ss-starting\.ss-anim \.ss-dot\s*\{\s*animation:\s*none/);
});

test('m1: the markup carries what the rules need: only the three animated states have ss-anim, and starting is the only one that also has ss-starting', () => {
  const starting = label({ state: 'starting' });
  assert.match(starting, /class="ss ss-yellow ss-starting ss-anim"/);
  assert.match(starting, /<span class="ss-word">Starting…<\/span>/);
  for (const [rpc, key] of [[{ state: 'busy' }, 'working'], [{ state: 'idle', compacting: true }, 'compacting']]) {
    const h = label(rpc);
    assert.match(h, /ss-anim/, key);
    assert.doesNotMatch(h, /ss-starting/, key);
  }
  for (const rpc of [{ state: 'idle' }, { state: 'closed' }, { state: 'asking' }, { state: 'bogus' }]) assert.doesNotMatch(label(rpc), /ss-anim/, JSON.stringify(rpc));
});

test('m2: only the animation changed: the icon of «Starting…» is still the arc of RP156 and the other seven icons are the same eight different drawings', () => {
  const icon = (rpc) => /<svg[\s\S]*?<\/svg>/.exec(label(rpc))[0];
  assert.match(icon({ state: 'starting' }), /<path d="M8 2\.5a5\.5 5\.5 0 1 1-5\.5 5\.5"\/>/);
  const all = [{ state: 'starting' }, { state: 'busy' }, { state: 'idle' }, { state: 'closed' }, { state: 'asking' }, { state: 'bogus' }, { state: 'idle', compacting: true }].map(icon);
  assert.equal(new Set(all).size, 7);
});
