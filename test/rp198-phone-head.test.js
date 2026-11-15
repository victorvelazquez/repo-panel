'use strict';
// RP198 (S10, S14), design/panel-cabecera-chat-movil/07-todo-en-57.html: under 760 px the head of the chat is ONE block of a fixed 57 px with three columns: the arrow back (44 px), a central block of two rows and the
// panel button with the ⋮ (44 px each). Row 1: the repo name and the branch (the branch is cut first, then the name). Row 2: ↑N, the context, then the alerts (memory, checks), which say a short word when it fits and fall to
// icon + number when it does not. The block is the one button that opens Repo. From 760 px up the head is the one of always. These tests pin the markup and the rules; how it LOOKS is for the person to try.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const R = require('../public/resumen.js');

const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'style.css'), 'utf8').replace(/\r\n/g, '\n').replace(/\/\*[\s\S]*?\*\//g, '');
const ruleIn = (src, sel) => [...src.matchAll(/(?:^|\n|\})\s*([^{}@]+)\{([^}]*)\}/g)].filter((m) => m[1].split(',').some((s) => s.trim().replace(/\s+/g, ' ') === sel)).map((m) => m[2]).join(';');
const rule = (sel) => { const r = ruleIn(css, sel); assert.ok(r, `a rule for ${sel}`); return r; };
const block = (src, head) => { const at = src.indexOf(head); assert.ok(at >= 0, head); let d = 0; const open = src.indexOf('{', at); for (let i = open; i < src.length; i++) { if (src[i] === '{') d++; else if (src[i] === '}' && --d === 0) return src.slice(open + 1, i); } return ''; };

const CTX = { percent: 75, window: 200000, tokens: 150000 };
const view = (memory, ctx, state = 'idle') => ({ info: { adopted: { id: 's1' } }, rpc: { state, ...(memory ? { memory } : {}), ...(ctx ? { ctx } : {}) } });
const CI_FAILED = { kind: 'failed', pending: 0, failed: 2, passed: 3, total: 5, number: 7 };
const git = (o = {}) => ({ branch: 'feat/rp198-phone-head', ahead: 0, pr: null, ...o });
const head = (o = {}) => R.chatHead({ id: 'abcdef0123', tab: 'chat' }, { name: 'repo-panel', column: true, narrow: true, git: git(), session: view('ready', CTX), ci: null, menu: { open: false, session: view('ready', CTX), hasSession: true }, ...o });
const wide = (o = {}) => head({ narrow: false, ...o });
const row2 = (h) => { const m = /<span class="ch-info[^"]*">([\s\S]*?)<\/span>(?=<\/button>)/.exec(h); return m ? m[0] : ''; };
const attr = (h, name) => [...h.matchAll(new RegExp(`${name}="([^"]*)"`, 'g'))].map((m) => m[1]);

// ---------- the markup ----------
test('m1: narrow, the head is one row with the arrow, the central block (one button that opens Repo) and the actions, in that order', () => {
  const h = head();
  assert.match(h, /^<div class="ch-row ch-phone"><button type="button" class="ch-back" data-act="chat-back"/);
  assert.match(h, /<button type="button" class="ch-mid" data-act="zone-set" data-zone="repo" aria-label="Open the repo: branch feat\/rp198-phone-head" title="Open the repo">/);
  const at = (s) => h.indexOf(s);
  assert.ok(at('class="ch-back"') < at('class="ch-mid"') && at('class="ch-mid"') < at('class="ch-acts"') && at('class="ch-acts"') < at('class="ch-repo"') && at('class="ch-repo"') < at('class="ch-more"'), 'the panel button, then the ⋮, are last');
  const acts = /<span class="ch-acts">([\s\S]*)<\/span><\/div><div class="ch-tabs"/.exec(h);
  assert.ok(acts, 'the actions wrapper closes the row');
  assert.match(acts[1], /class="ch-repo"/);
  assert.match(acts[1], /id="chMenuBtn" class="ch-more"/);
  assert.doesNotMatch(h, /class="ch-id"|ch-sub/, 'RP135 block is replaced');
});

test('m2: row 1 is the name and then the branch with its icon; the branch has its name as the title and the whole text is escaped', () => {
  const h = head();
  const l1 = /<span class="ch-l1">([\s\S]*?)<\/span>(?=<span class="ch-info|<\/button>)/.exec(h);
  assert.ok(l1, 'row 1');
  assert.ok(l1[1].indexOf('class="ch-name"') < l1[1].indexOf('class="ch-br"'), 'the name, then the branch');
  assert.match(l1[1], /<span class="ch-br" title="feat\/rp198-phone-head"><svg[^>]*aria-hidden="true"[\s\S]*?<circle cx="4" cy="3\.5" r="1\.6"\/>[\s\S]*?<\/svg><span class="ch-brn">feat\/rp198-phone-head<\/span>/);
  const evil = '<img src=x onerror=alert(1)>"\'';
  const e = head({ git: git({ branch: evil }), name: evil });
  assert.doesNotMatch(e, /<img/);
  assert.match(e, /&lt;img/);
});

test('m3: no branch known: row 1 is the name alone (no icon, no empty span)', () => {
  const h = head({ git: {} });
  assert.doesNotMatch(h, /ch-br/);
  assert.match(h, /<b class="ch-name"[^>]*>repo-panel<\/b>/);
});

test('m4: row 2 comes in a fixed order: ↑N, the context, then the alerts (memory, checks)', () => {
  const h = head({ git: git({ ahead: 2 }), session: view('offline', CTX), ci: CI_FAILED });
  const r = row2(h);
  assert.ok(r, 'row 2');
  const at = (s) => r.indexOf(s);
  assert.ok(at('ch-up') >= 0 && at('ch-up') < at('mem ctx') && at('mem ctx') < at('mem-bad') && at('mem-bad') < at('ss-ci'), 'ahead, context, memory, checks');
  assert.ok(h.indexOf('class="ch-l1"') < h.indexOf('class="ch-info') , 'row 1 first');
});

test('m5: ↑N only when ahead > 0, with an up arrow, the number and its accessible name', () => {
  const r = row2(head({ git: git({ ahead: 2 }) }));
  assert.match(r, /<span class="ch-up" title="2 commits ahead" aria-label="2 commits ahead"><svg[^>]*aria-hidden="true"[\s\S]*?M8 13V3M4 7l4-4 4 4[\s\S]*?<\/svg>2<\/span>/);
  assert.match(row2(head({ git: git({ ahead: 1 }) })), /aria-label="1 commit ahead"/);
  assert.doesNotMatch(row2(head({ git: git({ ahead: 0 }) })), /ch-up/);
  assert.doesNotMatch(row2(head({ git: {} })), /ch-up/);
});

test('m6: the context chip is always there once read (icon + number), and the memory only when it is not ready and the checks only when they run or fail', () => {
  const r = row2(head());
  assert.match(r, /class="mem ctx[^"]*"[^>]*title="Context used by this session: 150k of 200k tokens \(getting full\)"/);
  assert.match(r, /75%/);
  assert.doesNotMatch(r, /mem-ready|ss-ci|mem-bad/);
  const run = row2(head({ ci: { kind: 'running', pending: 1, failed: 0, passed: 2, total: 3, number: 7 } }));
  assert.match(run, /ss-yellow ss-ci ss-anim/);
  assert.match(row2(head({ session: view('disabled', CTX) })), /mem-warn/);
});

test('m7: the alerts carry a short word and a number in their own spans (the stylesheet picks which to show), and keep their accessible names', () => {
  const r = row2(head({ session: view('offline', CTX), ci: CI_FAILED }));
  assert.match(r, /<span class="mem mem-bad"[^>]*title="The memory of this session cannot be reached"[^>]*aria-label="The memory of this session cannot be reached"><i class="mem-ic" aria-hidden="true"><svg[\s\S]*?<\/svg><\/i><span class="ch-w">offline<\/span><\/span>/);
  assert.match(r, /<span class="ss ss-red ss-ci"[^>]*title="PR #7: the checks failed \(2 failed, 3 of 5 passed\)"[^>]*aria-label="PR #7: the checks failed \(2 failed, 3 of 5 passed\)"><i class="ss-dot" aria-hidden="true"><svg[\s\S]*?<\/svg><\/i><span class="ch-n">2<\/span><span class="ch-w">failed<\/span><\/span>/);
  assert.match(row2(head({ ci: { kind: 'running', pending: 3, failed: 0, passed: 1, total: 4, number: 7 } })), /<span class="ch-n">3<\/span><span class="ch-w">running<\/span>/);
});

test('m8: with 4 or more pieces in row 2 the row is marked tight (words go, icons and numbers stay); with fewer it is not', () => {
  const four = row2(head({ git: git({ ahead: 2 }), session: view('offline', CTX), ci: CI_FAILED }));
  assert.match(four, /^<span class="ch-info ch-tight">/);
  const three = row2(head({ git: git({ ahead: 2 }), ci: CI_FAILED }));
  assert.match(three, /^<span class="ch-info">/);
  assert.match(row2(head({ git: git({ ahead: 2 }), session: view('offline', CTX) })), /^<span class="ch-info">/);
});

test('m9: with no chips there is no row 2 (no empty wrapper) and no ⋮; with no session the panel button stays and the block still opens Repo', () => {
  const h = head({ git: git(), session: null, ci: null, menu: { open: false, session: null, hasSession: false } });
  assert.doesNotMatch(h, /ch-info/);
  assert.doesNotMatch(h, /ch-more|ch-menu/);
  assert.match(h, /class="ch-repo"/);
  assert.match(h, /class="ch-mid"[^>]*data-zone="repo"/);
  assert.match(h, /class="ch-l1"/);
  const q = head({ session: view('ready'), git: git() });
  assert.doesNotMatch(q, /ch-info/, 'a session with nothing to say: no row 2');
});

test('m10: the panel button keeps its badge with the pending checks and the old aria-label; the badge shows only here', () => {
  const pr = { number: 5, head: 'feat/x', checks: { pending: 2, total: 4, passed: 2, failed: 0 } };
  const h = head({ git: git({ pr }) });
  assert.match(h, /class="ch-repo"[^>]*aria-label="Repo: 2 checks pending"[\s\S]*?<i class="ch-dot" aria-hidden="true">2<\/i>/);
  assert.match(h, /class="ch-mid" data-act="zone-set" data-zone="repo" aria-label="Open the repo: branch feat\/rp198-phone-head, 2 checks running"/);
});

// ---------- not narrow: the head of always ----------
test('w1: from 760 px up the markup is the one of always: no phone block anywhere', () => {
  for (const ctx of [{ git: git({ ahead: 2 }), session: view('offline', CTX), ci: CI_FAILED }, {}, { narrow: 'yes' }, { narrow: 1 }]) {
    const h = wide(ctx);
    assert.match(h, /^<div class="ch-row"><button type="button" class="ch-back"/);
    assert.doesNotMatch(h, /ch-phone|ch-mid|ch-info|ch-l1|ch-acts|ch-br|ch-up|ch-w"|ch-n"/);
    assert.match(h, /<b class="ch-name"[^>]*>repo-panel<\/b>/);
  }
  const h = wide({ session: view('offline', CTX), ci: CI_FAILED });
  assert.match(h, /<span class="ch-chips">/);
  assert.match(h, /<span class="mem mem-bad" title="[^"]*"><i class="mem-ic" aria-hidden="true">[\s\S]*?<\/i> <span class="mem-word">memory offline<\/span><\/span>/, 'the chips of the wide head keep their words');
});

// ---------- the stylesheet ----------
test('c1: the phone row is a grid of 44 px, the central block and auto, 56 px tall + the 1 px border of the head = 57 px, whatever it holds', () => {
  const r = rule('#sumLayout[data-screen] .ch-phone');
  assert.match(r, /display:\s*grid/);
  assert.match(r, /grid-template-columns:\s*44px minmax\(0,\s*1fr\) auto/);
  assert.match(r, /height:\s*56px/);
  assert.match(r, /padding:\s*0 2px/);
  assert.match(rule('.ch-head'), /border-bottom:\s*1px solid var\(--line\)/);
  assert.match(rule('#sumLayout[data-screen] .ch-phone .ch-back'), /width:\s*44px/);
  assert.match(rule('#sumLayout[data-screen] .ch-phone .ch-back'), /height:\s*44px/);
});

test('c2: the targets are 44 px (arrow, panel, ⋮) and never shrink; the actions are side by side', () => {
  assert.match(rule('#sumLayout[data-screen] .ch-phone .ch-acts'), /display:\s*flex/);
  for (const sel of ['.ch-repo', '.ch-more']) {
    const r = rule(`#sumLayout[data-screen] .ch-phone .ch-acts ${sel}`);
    assert.match(r, /width:\s*44px/, sel);
    assert.match(r, /height:\s*44px/, sel);
    assert.match(r, /flex:\s*none/, sel);
  }
  assert.match(rule('#sumLayout[data-screen] .ch-phone .x'), /display:\s*none/);
});

test('c3: the central block is two rows, centered, can shrink (min-width 0), is the container the words are measured against and has a focus ring', () => {
  const r = rule('#sumLayout[data-screen] .ch-phone .ch-mid');
  assert.match(r, /display:\s*flex/);
  assert.match(r, /flex-direction:\s*column/);
  assert.match(r, /justify-content:\s*center/);
  assert.match(r, /min-width:\s*0/);
  assert.match(r, /container-type:\s*inline-size/);
  assert.match(r, /container-name:\s*chmid/);
  assert.match(css, /\.ch-mid:focus-visible[^{]*\{[^}]*outline:\s*2px solid var\(--blue\)/);
});

test('c4: row 1 cuts the branch FIRST (it shrinks with ellipsis, the name only after) and the name is bold 16 px; the branch is mono 12 px muted', () => {
  const l1 = rule('#sumLayout[data-screen] .ch-phone .ch-l1');
  assert.match(l1, /display:\s*flex/);
  assert.match(l1, /min-width:\s*0/);
  const name = rule('#sumLayout[data-screen] .ch-phone .ch-name');
  assert.match(name, /font-size:\s*16px/);
  assert.match(name, /font-weight:\s*(600|700)/);
  assert.match(name, /flex:\s*0 1 auto/);
  assert.match(name, /text-overflow:\s*ellipsis/);
  const br = rule('#sumLayout[data-screen] .ch-phone .ch-br');
  assert.match(br, /flex:\s*1 1 0/, 'the branch takes the rest and gives way first');
  assert.match(br, /min-width:\s*0/);
  assert.match(br, /font-size:\s*12px/);
  assert.match(br, /color:\s*var\(--muted\)/);
  assert.match(br, /ui-monospace/);
  const brn = rule('#sumLayout[data-screen] .ch-phone .ch-brn');
  assert.match(brn, /text-overflow:\s*ellipsis/);
  assert.match(brn, /white-space:\s*nowrap/);
  assert.match(brn, /overflow:\s*hidden/);
});

test('c5: row 2 never wraps, chips never shrink, the row keeps a safety overflow hidden, and the words of the context chip stay out of it', () => {
  const r = rule('#sumLayout[data-screen] .ch-phone .ch-info');
  assert.match(r, /display:\s*flex/);
  assert.match(r, /overflow:\s*hidden/);
  assert.match(r, /flex-wrap:\s*nowrap|white-space:\s*nowrap/);
  const chip = rule('#sumLayout[data-screen] .ch-phone .ch-info > *');
  assert.match(chip, /flex:\s*none/);
  assert.match(chip, /margin-left:\s*0/);
  assert.match(chip, /white-space:\s*nowrap/);
  assert.match(rule('#sumLayout[data-screen] .ch-phone .ch-info .mem-word'), /clip-path:\s*inset\(50%\)/);
});

test('c6: the alert words fall to icon + number when there is no room: a tight row (4 pieces) always, a narrow central block (container query on it) too; the number stays', () => {
  const hide = '.ch-w';
  const tight = rule(`#sumLayout[data-screen] .ch-phone .ch-tight ${hide}`);
  assert.match(tight, /clip-path:\s*inset\(50%\)/);
  assert.match(tight, /position:\s*absolute/);
  const q = /@container chmid \(max-width:\s*(\d+)px\)/.exec(css);
  assert.ok(q, 'a container query on the central block');
  assert.ok(Number(q[1]) >= 180 && Number(q[1]) <= 240, 'between the 320 px and the 390 px phones');
  assert.match(block(css, '@container chmid'), /\.ch-w[^{]*\{[^}]*clip-path:\s*inset\(50%\)/);
  assert.doesNotMatch(block(css, '@container chmid'), /\.ch-n/, 'the number is never hidden');
  assert.doesNotMatch(rule('#sumLayout[data-screen] .ch-phone .ch-w'), /clip-path/, 'with room the word shows');
});

test('c8: row 1 is ONE line of a fixed height: it never wraps, so the head cannot grow when the name and the branch do not fit', () => {
  const l1 = rule('#sumLayout[data-screen] .ch-phone .ch-l1');
  assert.match(l1, /display:\s*flex/);
  assert.match(l1, /height:\s*21px/);
  assert.doesNotMatch(l1, /flex-wrap:\s*wrap/);
  assert.match(rule('#sumLayout[data-screen] .ch-phone .ch-name'), /white-space:\s*nowrap/);
});

test('c7: the phone block lives outside the wide-screen block and the old RP135 rules are gone', () => {
  const wideBlock = block(css, '@container sum (min-width: 760px)');
  assert.doesNotMatch(wideBlock, /ch-phone|ch-mid|ch-info|ch-l1/);
  assert.doesNotMatch(css, /\.ch-id\b|\.ch-sub\b/);
  assert.match(rule('.ch-repo'), /position:\s*relative/);
  assert.match(rule('.ch-dot'), /position:\s*absolute/);
});
