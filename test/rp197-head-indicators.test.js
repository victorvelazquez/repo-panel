'use strict';
// RP197 (S5, S11): the INDICATORS of the session leave the foot of the chat and live in its head. Silence when all is well: the context is always there (once it has been read), the memory only when it is not ready
// (offline, error, disabled) and the checks of the PR only while they run or fail (the CI chip of RP170 is already silent on green). In the ⋮ menu the states are ICONS, side by side and with no text: the memory (also when it is
// ready), the context and the checks. The foot keeps only the state of the session. How it LOOKS is for the person to try; these tests pin the markup, the rules and the page.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { appSource } = require('./pagesrc.js');
const V = require('../public/view.js');
const R = require('../public/resumen.js');

const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'style.css'), 'utf8').replace(/\r\n/g, '\n').replace(/\/\*[\s\S]*?\*\//g, '');
const ruleIn = (src, sel) => [...src.matchAll(/(?:^|\n|\})\s*([^{}@]+)\{([^}]*)\}/g)].filter((m) => m[1].split(',').some((s) => s.trim().replace(/\s+/g, ' ') === sel)).map((m) => m[2]).join(';');
const block = (src, head) => { const at = src.indexOf(head); assert.ok(at >= 0, head); let d = 0; for (let i = src.indexOf('{', at); i < src.length; i++) { if (src[i] === '{') d++; else if (src[i] === '}' && --d === 0) return src.slice(src.indexOf('{', at) + 1, i); } throw new Error('unbalanced'); };

const CTX = { percent: 62, window: 200000, tokens: 124000 };
const view = (memory, ctx, state = 'idle') => ({ info: { adopted: { id: 's1' } }, rpc: { state, ...(memory ? { memory } : {}), ...(ctx ? { ctx } : {}) } });
const CI_FAILED = { kind: 'failed', pending: 0, failed: 2, passed: 3, total: 5, number: 7 };
const CI_RUNNING = { kind: 'running', pending: 1, failed: 0, passed: 2, total: 3, number: 7 };
const gitWith = (state) => ({ pr: { number: 7, checks: { state, total: 5, passed: state === 'success' ? 5 : 3, failed: state === 'failed' ? 2 : 0, pending: state === 'pending' ? 2 : 0, items: [] } } });
const text = (h) => h.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();

// ---------- pure: the chips of the head ----------
test('i1: the memory chip can be asked to be quiet: «ready» is nothing, the others are the chip they were; without the option nothing changes', () => {
  assert.equal(R.memoryChipHtml(view('ready'), { quiet: true }), '');
  for (const m of ['offline', 'error', 'disabled']) {
    const quiet = R.memoryChipHtml(view(m), { quiet: true });
    assert.ok(quiet.length > 0, m);
    assert.equal(quiet, R.memoryChipHtml(view(m)), `${m}: the same chip`);
  }
  assert.match(R.memoryChipHtml(view('ready')), /mem-ready/);
  assert.equal(R.memoryChipHtml(view('ready'), {}), R.memoryChipHtml(view('ready')));
});

test('i2: the chips of the head: the context first, then what is wrong (memory, checks); nothing when the session is closed', () => {
  const quiet = R.headChipsHtml(view('ready', CTX), null);
  assert.match(quiet, /class="mem ctx"/);
  assert.match(quiet, /62%/);
  assert.doesNotMatch(quiet, /mem-ready|ss-ci/, 'a ready memory and no CI say nothing');
  const all = R.headChipsHtml(view('offline', CTX), CI_FAILED);
  assert.ok(all.indexOf('mem ctx') < all.indexOf('mem-bad') && all.indexOf('mem-bad') < all.indexOf('ss-ci'), 'context, memory, checks');
  assert.equal(R.headChipsHtml(view('ready', CTX, 'closed'), null), '');
  assert.equal(R.headChipsHtml(view('ready'), null), '', 'no context read yet, nothing wrong: no chips');
  assert.equal(R.headChipsHtml(null, null), '');
});

test('i3: the CI chip of the head is silent on green, says running or failed, and does not announce itself as a status (the foot has the one that does)', () => {
  const failed = R.headChipsHtml(view('ready'), CI_FAILED);
  assert.match(failed, /class="ss ss-red ss-ci"/);
  assert.match(failed, /PR #7: the checks failed/);
  assert.doesNotMatch(failed, /role="status"/);
  const running = R.headChipsHtml(view('ready'), CI_RUNNING);
  assert.match(running, /ss-yellow ss-ci ss-anim/);
  assert.equal(R.headChipsHtml(view('ready'), { kind: 'success', number: 7 }), '', 'green is not a kind of the chip');
  assert.match(R.sessionLabelHtml({ ...view('ready'), ci: CI_FAILED }), /role="status"/, 'the label of the foot is unchanged');
});

test('i4: the head of the chat carries the chips between the name and the menu, and no empty wrapper when there is nothing to say', () => {
  const ctx = { name: 'demo', column: true, git: {}, session: view('offline', CTX), ci: null, menu: { open: false, session: view('offline', CTX), hasSession: true } };
  const h = R.chatHead({ tab: 'chat' }, ctx);
  assert.ok(h.indexOf('class="ch-name"') < h.indexOf('class="ch-chips"') && h.indexOf('class="ch-chips"') < h.indexOf('class="ch-menu"') && h.indexOf('class="ch-menu"') < h.indexOf('class="ch-repo"'));
  assert.match(h, /<span class="ch-chips">/);
  assert.doesNotMatch(R.chatHead({ tab: 'chat' }, { ...ctx, session: view('ready') }), /ch-chips/);
  assert.doesNotMatch(R.chatHead({ tab: 'chat' }, { name: 'demo', column: true, git: {} }), /ch-chips/);
});

// ---------- pure: the icons of the menu ----------
test('i5: the menu shows the states as ICONS with no text: the memory (also ready), the context and the checks, each with its name and a tone', () => {
  const h = R.statusIconsHtml(view('ready', CTX), gitWith('success'));
  assert.match(h, /^<div class="ch-status" role="group" aria-label="Status">/);
  const icons = [...h.matchAll(/<span class="ch-st ch-st-(\w+)" role="img" aria-label="([^"]*)" title="([^"]*)">/g)];
  assert.deepEqual(icons.map((m) => m[1]), ['ok', 'ok', 'ok']);
  assert.match(icons[0][2], /memory of this session is ready/i);
  assert.match(icons[1][2], /Context used by this session: 124k of 200k tokens/);
  assert.match(icons[2][2], /PR #7: all the checks passed/);
  for (const m of icons) assert.equal(m[2], m[3], 'the name and the tooltip are the same words');
  assert.equal(text(h), '', 'no text at all: only drawings');
  assert.equal((h.match(/<svg[^>]*aria-hidden="true"/g) || []).length, 3);
});

test('i6: the tones follow the state: memory ready/disabled/offline, context from 70 % and 90 %, checks passed/running/failed; what is not known is not drawn', () => {
  const tone = (h) => [...h.matchAll(/ch-st-(\w+)/g)].map((m) => m[1]);
  assert.deepEqual(tone(R.statusIconsHtml(view('disabled'), {})), ['warn']);
  assert.deepEqual(tone(R.statusIconsHtml(view('offline'), {})), ['bad']);
  assert.deepEqual(tone(R.statusIconsHtml(view('error'), {})), ['bad']);
  assert.deepEqual(tone(R.statusIconsHtml(view(null, { ...CTX, percent: 70 }), {})), ['warn']);
  assert.deepEqual(tone(R.statusIconsHtml(view(null, { ...CTX, percent: 91 }), {})), ['bad']);
  assert.deepEqual(tone(R.statusIconsHtml(view(null, null), gitWith('pending'))), ['warn']);
  assert.deepEqual(tone(R.statusIconsHtml(view(null, null), gitWith('failed'))), ['bad']);
  assert.equal(R.statusIconsHtml(view(null, null), {}), '', 'nothing known, nothing drawn');
  assert.doesNotMatch(R.statusIconsHtml(view('ready', CTX, 'closed'), {}), /memory|Context/i, 'a closed session has neither memory nor context');
});

test('i7: the open menu has the icons FIRST, then the actions; the icons are not items of the menu, and a closed menu has none in the page', () => {
  const m = { open: true, session: view('ready', CTX), hasSession: true, terminal: null, closing: false, git: gitWith('failed') };
  const h = R.chatMenuHtml(m);
  assert.ok(h.indexOf('class="ch-status"') > h.indexOf('id="chMenu"') && h.indexOf('class="ch-status"') < h.indexOf('data-act="compact"'));
  assert.deepEqual([...h.matchAll(/role="menuitem"[^>]*data-act="([\w-]+)"/g)].map((x) => x[1]), ['compact', 'session-terminal', 'session-close']);
  assert.doesNotMatch(R.chatMenuHtml({ ...m, open: false }), /ch-status/);
  assert.doesNotMatch(R.chatMenuHtml({ ...m, git: undefined, session: view(null, null) }), /ch-status/, 'no icon to show: no row');
});

test('i8: the stylesheet: the words of the chips of the head are hidden the accessible way, the chips sit in the group of the right of the one-row head, and the icons have tones', () => {
  assert.match(ruleIn(css, '.ch-chips'), /display:\s*inline-flex/);
  assert.match(ruleIn(css, '.ch-chips'), /gap:\s*6px/);
  const words = ruleIn(css, '.ch-chips .mem-word');
  assert.match(words, /clip-path:\s*inset\(50%\)/);
  assert.doesNotMatch(words, /display:\s*none/, 'never display:none: the accessible name stays');
  for (const w of ['.ch-chips .ss-word', '.ch-chips .ss-n']) assert.match(ruleIn(css, w), /clip-path:\s*inset\(50%\)/, w);
  assert.match(ruleIn(css, '.ch-chips'), /flex:\s*none/);
  assert.match(ruleIn(block(css, '@container sum (min-width: 760px)'), '.ch-chips'), /order:\s*2/);
  assert.match(ruleIn(css, '.ch-status'), /display:\s*flex/);
  assert.match(ruleIn(css, '.ch-st-warn'), /color:\s*var\(--yellow\)/);
  assert.match(ruleIn(css, '.ch-st-bad'), /color:\s*var\(--red\)/);
});

// ---------- the page ----------
function element(extra = {}) {
  const el = {
    html: '', hidden: false, dataset: {}, disabled: false, value: '', checked: false, textContent: '', title: '', attrs: {}, children: [], writes: 0,
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false }, style: { setProperty() {} }, addEventListener() {}, setAttribute() {}, querySelector: () => null, querySelectorAll: () => [], closest: () => null,
    showModal() {}, close() {}, focus() {}, append() {}, get innerHTML() { return el.html; }, set innerHTML(v) { el.html = String(v); el.writes++; }, ...extra,
  };
  return el;
}
const ok = (b) => ({ ok: true, json: async () => b });
const card = (id, name) => ({ id, name, group: 'G', room: null, branch: 'main', progress: { total: 1, completada: 0, enRevision: 0, bloqueada: 0, pendiente: 1, enCurso: 0 }, session: { state: 'free' }, next: null, blocking: [], lastMovement: {}, activity: null });
const INFO = { key: 'abc', adopted: { id: 's1', name: 'First', adoptedAt: 'x' }, adoptedFound: true, sessions: [{ id: 's1', name: 'First', updatedAt: '2026-01-01T00:00:00.000Z', lastMessage: 'hi' }], live: { state: 'none', count: 0 } };
async function boot(rpc) {
  const frames = [];
  const els = {};
  const tabEls = ['summary', 'work', 'conformity'].map((t) => element({ dataset: { tab: t } }));
  const get = (sel) => (els[sel] ||= (sel === 'meta[name=token]' ? element({ content: 'token' }) : element()));
  const doc = { hidden: false, querySelector: get, querySelectorAll: (s) => (String(s).includes('data-tab') ? tabEls : []), addEventListener() {}, createElement: () => element(), body: element(), activeElement: null };
  const routes = [[(u) => u.startsWith('/api/sessions?'), () => Promise.resolve(ok(INFO))], [(u) => u.startsWith('/api/chat?'), () => Promise.resolve(ok({ items: [], truncated: false }))]];
  const ctx = vm.createContext({
    console, document: doc, location: { hash: '' }, localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    requestAnimationFrame: (cb) => { frames.push(cb); return frames.length; }, setInterval: () => 1, setTimeout: () => 0, clearTimeout: () => {}, AbortController, confirm: () => true,
    fetch: (url) => { for (const [m, fn] of routes) if (m(String(url))) return fn(); return new Promise(() => {}); },
  });
  ctx.window = ctx; ctx.addEventListener = () => {}; ctx.RepoPanelView = V; ctx.RepoPanelResumen = R;
  vm.runInContext(appSource(), ctx);
  const flush = () => { while (frames.length) frames.shift()(); };
  const tick = async (n = 20) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); flush(); };
  const run = (c) => vm.runInContext(c, ctx);
  const S = run('S');
  S.groups = [{ name: 'G', repos: [{ id: 'abc', name: 'demo', path: 'p' }] }];
  S.summary = { rows: [card('abc', 'demo')], generatedAt: 'x' };
  run(`S.rpc.abc = ${JSON.stringify(rpc)}`);
  run("ACTIONS['chat-open']({ dataset: { id: 'abc' } })");
  await tick();
  return { get, tick, run, S };
}
const head = (page) => page.get('#chatHead').html;
const foot = (page) => page.get('#sessState').html;
const RPC = (memory) => ({ state: 'idle', memory, ctx: CTX });

test('p1: with a session whose memory is ready, the head shows the context and nothing about the memory; the foot has no chip of either', async () => {
  const page = await boot(RPC('ready'));
  assert.match(head(page), /<span class="ch-chips">/);
  assert.match(head(page), /class="mem ctx"[^>]*>[\s\S]*62%/);
  assert.doesNotMatch(head(page), /mem-ready|memory ready/);
  assert.doesNotMatch(foot(page), /class="mem/, 'the foot has no chip of memory or context');
  assert.match(foot(page), /class="ss /, 'the foot keeps the state of the session');
});

test('p2: when the memory fails the head says so, and when it comes back the head is quiet again', async () => {
  const page = await boot(RPC('offline'));
  assert.match(head(page), /mem-bad/);
  assert.match(head(page), /The memory of this session cannot be reached/);
  assert.doesNotMatch(foot(page), /mem-bad/);
  page.run("S.rpc.abc = { state: 'idle', memory: 'ready', ctx: " + JSON.stringify(CTX) + " }; draw()");
  await page.tick();
  assert.doesNotMatch(head(page), /mem-bad/);
  assert.match(head(page), /class="mem ctx"/, 'the context stays');
});

test('p3: the context is always there once read, and grows its tone with the level; a closed session shows no chip', async () => {
  const page = await boot({ state: 'idle', memory: 'ready', ctx: { ...CTX, percent: 93 } });
  assert.match(head(page), /class="mem ctx mem-bad"/);
  page.run("S.rpc.abc = { state: 'closed' }; draw()");
  await page.tick();
  assert.doesNotMatch(head(page), /ch-chips/);
});

test('p4: the open menu lists the states as icons, memory included even when it is ready, before the actions', async () => {
  const page = await boot(RPC('ready'));
  page.run("ACTIONS['ch-menu']({ dataset: {} })");
  await page.tick();
  assert.match(head(page), /<div class="ch-status" role="group" aria-label="Status">/);
  assert.match(head(page), /ch-st ch-st-ok" role="img" aria-label="The memory of this session is ready"/);
  assert.match(head(page), /aria-label="Context used by this session: 124k of 200k tokens"/);
  assert.ok(head(page).indexOf('ch-status') < head(page).indexOf('data-act="session-terminal"'));
});

test('p5: the state of the session in the foot is the same as before: a free session with a CI that fails shows the CI label there', async () => {
  const page = await boot(RPC('ready'));
  assert.match(foot(page), /ss-green ss-free|ss-free/);
});

// ---------- the checks of the PR in the page ----------
const withPr = async (page, state) => {
  const checks = { state, total: 5, passed: state === 'success' ? 5 : 3, failed: state === 'failed' ? 2 : 0, pending: state === 'pending' ? 2 : 0, items: [] };
  page.run(`S.local.abc = { branch: 'main', ahead: 0, files: [] }; S.prs.abc = { prs: [{ number: 7, head: 'main', title: 'x', checks: ${JSON.stringify(checks)} }] }; draw()`);
  await page.tick();
};
const chips = (page) => (/<span class="ch-chips">[\s\S]*?<\/span><span class="ch-menu"|<span class="ch-chips">[\s\S]*$/.exec(head(page)) || [''])[0];

test('p6: checks that FAIL show a chip in the head, with the words hidden and without announcing itself (RP191: and the foot no longer says it)', async () => {
  const page = await boot(RPC('ready'));
  await withPr(page, 'failed');
  assert.match(chips(page), /ss ss-red ss-ci/);
  assert.match(chips(page), /PR #7: the checks failed/);
  assert.doesNotMatch(chips(page), /role="status"/);
  assert.doesNotMatch(foot(page), /ss-ci/, 'RP191: the state label of the foot has no CI words any more');
});

test('p7: checks that are running show the turning chip; checks that PASSED show nothing in the head (silence when all is well)', async () => {
  const page = await boot(RPC('ready'));
  await withPr(page, 'pending');
  assert.match(chips(page), /ss-yellow ss-ci ss-anim/);
  await withPr(page, 'success');
  assert.doesNotMatch(head(page), /ss-ci/);
  assert.match(head(page), /class="mem ctx"/, 'the context stays');
});

test('p8: the open menu has the icon of the checks of the PR in its tone, green included, and nothing for a PR without checks', async () => {
  const page = await boot(RPC('ready'));
  await withPr(page, 'success');
  page.run("ACTIONS['ch-menu']({ dataset: {} })");
  await page.tick();
  assert.match(head(page), /ch-st ch-st-ok" role="img" aria-label="PR #7: all the checks passed \(5 of 5\)"/);
  await withPr(page, 'failed');
  assert.match(head(page), /ch-st ch-st-bad" role="img" aria-label="PR #7: the checks failed \(2 failed, 3 of 5 passed\)"/);
  await withPr(page, 'none');
  assert.doesNotMatch(head(page), /PR #7/);
});

test('i9: a PR whose checks have no state is not an icon', () => {
  assert.equal(R.statusIconsHtml(view(null, null), gitWith('none')), '');
});
