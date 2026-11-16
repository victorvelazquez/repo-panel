'use strict';
// RP191 (S6, S20): the bottom bar of the chat composer. ONE row: the state of the session at the left with the actions beside it, and at the right ONE round icon button that is Send, or Stop while the session works.
// The state line above the field is gone; the foot state no longer carries the CI words (the head already shows the checks). The quick replies stay where they are (RP209 moves them).
// Fakes only: the page is built in `vm`, the sources and the stylesheet are read as text.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { appSource } = require('./pagesrc.js');
const R = require('../public/resumen.js');
const V = require('../public/view.js');

const PUBLIC = path.join(__dirname, '..', 'public');
const read = (f) => fs.readFileSync(path.join(PUBLIC, f), 'utf8').replace(/\r\n/g, '\n');
const css = read('style.css');
const html = read('index.html');
const chatJs = read('chat.js');
const rule = (sel) => { const at = css.indexOf(`\n${sel} {`); assert.ok(at >= 0, `rule ${sel}`); return css.slice(at + 1, css.indexOf('}', at) + 1); };
const tag = (id) => { const m = html.match(new RegExp(`<(\\w+)[^>]*\\bid="${id}"[^>]*>`)); assert.ok(m, `#${id} in index.html`); return m[0]; };

// ====================================================================================================
// A. index.html: the structure of the bar
// ====================================================================================================
const composer = html.slice(html.indexOf('id="composer"'), html.indexOf('id="msgNote"'));
const bar = composer.slice(composer.indexOf('<div class="c-bar">'));

test('A1: the bar is .c-left (only #sessState), then #chatActions, then #msgStop, then #msgSend; the actions are not inside .c-left; nothing of the state is left above the field', () => {
  assert.ok(composer.includes('<div class="c-bar">'));
  const left = bar.indexOf('<div class="c-left">');
  assert.ok(left > 0, '.c-left in the bar');
  const st = bar.indexOf('id="sessState"');
  const leftEnd = bar.indexOf('</div>', st) + '</div>'.length;
  assert.equal(bar.slice(left, leftEnd + '</div>'.length).replace(/\s+/g, ' '), '<div class="c-left"><div id="sessState" class="sess-state"></div></div>', '.c-left holds only the state');
  const act = bar.indexOf('id="chatActions"');
  assert.ok(act > leftEnd, '#chatActions comes after .c-left closes');
  assert.ok(bar.indexOf('id="msgStop"') > act && bar.indexOf('id="msgSend"') > bar.indexOf('id="msgStop"'), 'order: c-left, chatActions, msgStop, msgSend');
  assert.match(tag('sessState'), /class="sess-state"/);
  assert.match(tag('chatActions'), /class="c-actions"/);
  const beforeField = composer.slice(0, composer.indexOf('class="msg-field"'));
  assert.doesNotMatch(beforeField, /id="sessState"/, 'no state above the field');
  assert.equal(html.match(/id="sessState"/g).length, 1);
});

test('A2: the bar has no spacer', () => {
  assert.doesNotMatch(bar, /class="spacer"/);
});

test('A3: Send and Stop keep ids, data-act and titles, and are round icon buttons with an accessible name and no visible text', () => {
  const send = tag('msgSend');
  const stop = tag('msgStop');
  assert.match(send, /data-act="chat-send"/);
  assert.match(stop, /data-act="chat-stop"/);
  assert.match(send, /class="[^"]*\bc-round\b[^"]*\bc-send\b/);
  assert.match(stop, /class="[^"]*\bc-round\b[^"]*\bc-stop\b/);
  assert.match(send, /aria-label="Send message"/);
  assert.match(stop, /aria-label="Stop the run"/);
  assert.match(stop, /title="Stop the run that is going on"/);
  assert.match(stop, /\bhidden\b/, 'Stop is hidden by default');
  assert.doesNotMatch(send, /\bhidden\b/);
  const btn = (id) => bar.slice(bar.indexOf(`id="${id}"`), bar.indexOf('</button>', bar.indexOf(`id="${id}"`)));
  for (const id of ['msgSend', 'msgStop']) {
    const b = btn(id);
    assert.match(b, /<svg width="16" height="16" viewBox="0 0 16 16"[^>]*aria-hidden="true"/, id);
    assert.equal(b.slice(b.indexOf('>') + 1).replace(/<svg[^]*<\/svg>/, '').trim(), '', `${id} has no visible text`);
  }
  assert.match(btn('msgSend'), /stroke="currentColor"[^>]*stroke-width="1\.9"[^>]*stroke-linecap="round"/);
  assert.match(btn('msgStop'), /<rect[^>]*rx=[^>]*fill="currentColor"/);
});

// ====================================================================================================
// B. the page: the swap, the foot state and the markup that does not change
// ====================================================================================================
function element(extra = {}) {
  const el = {
    writes: 0, html: '', hidden: false, dataset: {}, disabled: false, value: '', checked: false, textContent: '', title: '', placeholder: '', attrs: {}, listeners: {}, children: [], open: false,
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    style: { setProperty(k, v) { el.style[k] = v; } },
    addEventListener(t, fn) { (el.listeners[t] ||= []).push(fn); }, setAttribute(k, v) { el.attrs[k] = v; }, querySelector: () => null, querySelectorAll: () => [], closest: () => null,
    showModal() {}, close() {}, focus() {}, append(c) { el.children.push(c); },
    get innerHTML() { return el.html; }, set innerHTML(v) { el.html = String(v); }, ...extra,
  };
  return el;
}
const A = 'abcdef0123';
const CONFIG = { groups: [{ name: 'G', repos: [{ id: A, name: 'repo-a', path: 'p-a' }] }], snoozed: [], dismissed: [], rooms: [], roomIssues: [] };
async function boot() {
  const els = {};
  const frames = [];
  const tabEls = ['summary', 'work', 'conformity', 'settings'].map((t) => element({ dataset: { tab: t } }));
  const get = (sel) => (els[sel] ||= (sel === 'meta[name=token]' ? element({ content: 'token' }) : element()));
  get('#sumLayout').clientWidth = 1400;
  const doc = { hidden: false, querySelector: get, querySelectorAll: (s) => (String(s).includes('data-tab') ? tabEls : []), addEventListener() {}, createElement: () => element(), body: element(), activeElement: null };
  const ctx = vm.createContext({
    console, document: doc, TextDecoder, AbortController, confirm: () => true, location: { hash: '', pathname: '/panel/', search: '' }, history: { pushState() {}, replaceState() {}, back() {} },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    requestAnimationFrame: (cb) => { frames.push(cb); return frames.length; }, setInterval: () => 0, setTimeout: () => 0, clearTimeout: () => {}, clearInterval: () => {},
    fetch: (url) => (String(url).startsWith('/api/config') ? Promise.resolve({ ok: true, json: async () => CONFIG }) : new Promise(() => {})),
  });
  ctx.window = ctx;
  ctx.addEventListener = () => {};
  ctx.RepoPanelView = V;
  ctx.RepoPanelResumen = R;
  vm.runInContext(appSource(), ctx);
  const tick = async (n = 10) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); while (frames.length) frames.shift()(); };
  await tick();
  const run = (code) => vm.runInContext(code, ctx);
  run(`ACTIONS['chat-open']({ dataset: { id: ${JSON.stringify(A)} } })`);
  await tick();
  return {
    get,
    set: async ({ rpc, prs }) => {
      run(`S.chat.info = { adopted: { id: 's1', name: 'panel:a', adoptedAt: 'x' }, adoptedFound: true, sessions: [] }; S.rpc[${JSON.stringify(A)}] = ${JSON.stringify(rpc)}; S.local[${JSON.stringify(A)}] = ${JSON.stringify({ branch: 'feat/x', ahead: 0, files: [], error: null })}; S.prs[${JSON.stringify(A)}] = ${JSON.stringify({ prs: prs || [] })}; draw();`);
      await tick();
    },
  };
}
const IDLE = { state: 'idle', pendingDialogs: [] };
const PR = (checks) => ({ number: 7, title: 'the title', head: 'feat/x', checks });
const RUN = { state: 'pending', items: [], total: 4, passed: 2, pending: 2, failed: 0 };
const BAD = { state: 'failed', items: [], total: 4, passed: 3, pending: 0, failed: 1 };

test('B1: busy shows Stop and hides Send; idle shows Send and hides Stop; asking keeps Send visible and disabled with no Stop', async () => {
  const page = await boot();
  const send = page.get('#msgSend');
  const stop = page.get('#msgStop');
  await page.set({ rpc: { state: 'busy', pendingDialogs: [] } });
  assert.equal(send.hidden, true, 'busy: Send hidden');
  assert.equal(stop.hidden, false, 'busy: Stop visible');
  await page.set({ rpc: IDLE });
  assert.equal(send.hidden, false, 'idle: Send visible');
  assert.equal(send.disabled, false);
  assert.equal(stop.hidden, true, 'idle: Stop hidden');
  await page.set({ rpc: { state: 'asking', pendingDialogs: [{ requestId: 'd1', method: 'confirm', title: 'Allow?', message: 'x', options: [], expiresAt: null, truncated: false }] } });
  assert.equal(send.hidden, false, 'asking: Send visible');
  assert.equal(send.disabled, true, 'asking: Send disabled');
  assert.equal(stop.hidden, true, 'asking: no Stop');
  assert.ok(send.title.length > 0, 'the title of Send is still the reason');
});

test('B2: the foot state shows no CI words with a PR whose checks run or failed (it reads Idle); sessionLabelHtml still gives them to its other callers', async () => {
  const page = await boot();
  for (const checks of [RUN, BAD]) {
    await page.set({ rpc: IDLE, prs: [PR(checks)] });
    const h = page.get('#sessState').html;
    assert.match(h, /ss-word">Idle</, h);
    assert.doesNotMatch(h, /Verifying|Checks Failed|ss-ci/);
  }
  assert.match(R.sessionLabelHtml({ info: true, rpc: IDLE, ci: V.ciOf(PR(RUN)) }), /Verifying Checks/);
  assert.match(R.sessionLabelHtml({ info: true, rpc: IDLE, ci: V.ciOf(PR(BAD)) }), /Checks Failed/);
  assert.doesNotMatch(chatJs, /sessionLabelHtml\(\{[^\n]*\bci\b/, 'chat.js no longer passes ci');
});

test('B3: actionButtonsHtml and composerMergeHtml give the same markup as before (fixed input)', () => {
  assert.equal(
    R.actionButtonsHtml({ items: [{ cmd: 'flow-ship', label: '/flow-ship', available: true, why: '' }, { cmd: 'flow-pr', label: '/flow-pr', available: false, why: 'x' }] }, 'r1', {}),
    '<button type="button" class="c-act" data-act="pi" data-id="r1" data-cmd="flow-ship" title="Send /flow-ship to the open session of this repo">/flow-ship</button>',
  );
  assert.equal(
    R.composerMergeHtml({ id: 'r1', pr: { number: 7 }, merge: { enabled: false, label: 'Merge · squash', title: 't', why: 'checks running' } }),
    '<button type="button" class="c-act merge" data-act="merge" data-id="r1" data-n="7" disabled title="t">Merge · squash</button>', // RP191 (S22): the reason line is gone
  );
});

// ====================================================================================================
// C. the stylesheet
// ====================================================================================================
test('C1 (S21): the bar centers its items; the state group takes the free space and never shrinks below the state; the actions are glued to the round button at the right and wrap right-aligned', () => {
  const bar = rule('.c-bar');
  assert.match(bar, /display:\s*flex/);
  assert.match(bar, /align-items:\s*center/);
  assert.match(bar, /gap:\s*8px/);
  const left = rule('.c-left');
  for (const re of [/display:\s*flex/, /flex:\s*1 1 auto/, /min-width:\s*min-content/, /align-items:\s*center/]) assert.match(left, re);
  assert.doesNotMatch(left, /flex-wrap|align-self/, 'the old wrap and align-self are gone');
  const acts = rule('.c-actions');
  for (const re of [/display:\s*flex/, /flex:\s*0 1 auto/, /flex-wrap:\s*wrap/, /justify-content:\s*flex-end/, /align-items:\s*center/, /gap:\s*6px/, /min-width:\s*0/]) assert.match(acts, re);
  assert.match(rule('button.c-round'), /align-self:\s*flex-end/, 'the button stays at the bottom right when the actions wrap');
  assert.doesNotMatch(css, /\.c-why/, 'RP191 (S22): the reason line has no rule any more');
});

test('C2: the state is an inline-flex item with a minimum width and no row layout of its own', () => {
  const all = css.split('\n').filter((l) => /^\.sess-state\b/.test(l)).join('\n');
  assert.match(all, /display:\s*inline-flex/);
  assert.match(all, /flex:\s*none/);
  assert.match(all, /min-width:\s*84px/);
  assert.match(all, /min-height:\s*28px/);
  assert.doesNotMatch(all, /flex-wrap|row-gap/, 'the row layout is gone');
  assert.match(css, /@container cmp \(max-width: 456px\) \{\s*\.ss-word, \.mem-word \{/, 'the words are still hidden in a narrow chat');
});

test('C3: the actions are compact (28 px, 12.5 px, monospace); Merge has the page font and NO colour of its own, so the soft green of the palette shows when it is on and the muted gray when it is off; no reason is written beside it (RP191, S22)', () => {
  const act = rule('.c-act');
  assert.match(act, /height:\s*28px/);
  assert.match(act, /font:\s*12\.5px ui-monospace/);
  const merge = rule('.c-act.merge');
  assert.doesNotMatch(merge, /color:/, 'a colour here would beat the disabled rule of the palette (a disabled Merge would look on)');
  assert.match(merge, /font-family:\s*inherit/);
  assert.doesNotMatch(css, /\.c-why/);
});

test('C4: the round buttons are 40 px (44 px with a coarse pointer), keep their border and have no padding for the soft layer to give back; Send is in the SOFT blue layer of the palette (RP67: no solid action button) with its hover and its disabled gray; Stop is panel2 with a red icon and ring', () => {
  const round = rule('button.c-round');
  assert.match(round, /width:\s*40px/);
  assert.match(round, /height:\s*40px/);
  assert.match(round, /padding:\s*0/);
  assert.match(round, /border-radius:\s*50%/);
  assert.doesNotMatch(round, /border:\s*0/, 'the border stays so the soft layer has a ring');
  assert.match(css, /@media \(pointer: coarse\) \{[^}]*button\.c-round \{[^}]*width:\s*44px[^}]*height:\s*44px/);
  assert.equal(css.match(/\n\.c-send[^{]*\{/g), null, 'no rule of its own for Send: the palette gives its colour');
  assert.match(css, /\nbutton:is\([^)]*\.c-send\) \{ --h: var\(--blue\); \}/, 'the blue hue');
  const soft = css.match(/\nbutton:is\(([^)]*)\) \{\n\s*background: color-mix\(in srgb, var\(--h\) 13%/);
  assert.ok(soft && soft[1].includes('.c-send'), 'the soft layer lists .c-send');
  const hover = css.match(/\nbutton:is\(([^)]*)\):hover:not\(:disabled\) \{\n\s*background: color-mix\(in srgb, var\(--h\) 24%/);
  assert.ok(hover && hover[1].includes('.c-send'), 'and its hover');
  const off = css.match(/\nbutton:is\(([^)]*)\):disabled \{ --h: var\(--gray\)/);
  assert.ok(off && off[1].includes('.c-send'), 'and the disabled gray');
  const stop = rule('.c-stop');
  assert.match(stop, /background:\s*var\(--panel2\)/);
  assert.match(stop, /color:\s*var\(--red\)/);
  assert.match(stop, /box-shadow:[^;]*color-mix\(in srgb, var\(--red\)/);
  for (const r of [round, stop]) assert.doesNotMatch(r, /#[0-9a-fA-F]{3,6}\b/, 'tokens only');
});

test('C5: [hidden] wins over the display of the round buttons', () => {
  assert.match(css, /\n#msgSend\[hidden\], #msgStop\[hidden\] \{ display: none; \}/);
});

test('C6: the composing list does not name .sess-state; no rule of .spacer is left for the bar', () => {
  const list = css.match(/\n(#chat\.composing [^\n]*\{ flex: none; \})/)[1];
  assert.doesNotMatch(list, /\.sess-state/);
  assert.match(list, /\.term-block/);
  assert.match(list, /\.c-bar/);
  assert.match(list, /\.rs-note/);
  assert.doesNotMatch(css, /\.c-bar[^{]*\.spacer|\.c-bar \.spacer/);
});

test('C7: what RP207 and RP208 wrote is still there', () => {
  assert.match(css, /@media \(pointer: coarse\) \{ \.composer \{ border-radius: 16px; \} \}/);
  assert.match(css, /\.msg-field:has\(\.msg-expand:not\(\[hidden\]\)\) textarea \{ padding-right: 34px; \}/);
  assert.match(css, /#chat\.composing \.composer textarea \{ flex: 1 1 auto; max-height: none; \}/);
});
