'use strict';
// RP152 (S42, S43): the page shows, live, that a subagent is working: «Subagent working · mm:ss» next to the state of the session, made ONLY of data the machine gives (the `tool_execution_start` and
// `tool_execution_end` events of the tool `subagent_run`, which the server already lets through with the tool name alone: test/rpc2-1-server.test.js pins that the arguments and the id are cut).
// It counts the starts without an end, clears with the end of the run, an abort, a closed session or a (re)connect (what is not known is NOT «working»), and it NEVER says «Slow» (that needs activity data: RP153).
// A subagent launched in the background ends its call at once, so it is not shown by this row. The name of the agent is not shown either (it needs the arguments: RP153, by presence).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { appSource } = require('./pagesrc.js');
const V = require('../public/view.js');
const R = require('../public/resumen.js');

const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'style.css'), 'utf8').replace(/\r\n/g, '\n');
const T0 = 1000000000000;
const rec = (record) => ({ kind: 'event', record });
const start = (toolName = 'subagent_run') => rec({ type: 'tool_execution_start', toolName });
const end = (toolName = 'subagent_run') => rec({ type: 'tool_execution_end', toolName, isError: false, durationMs: 5 });
const feed = (e, ...ps) => ps.reduce((acc, p, i) => V.rpcReduce(acc, p, T0 + i * 1000).entry, e);
const busy = () => V.rpcReduce(null, { kind: 'state', state: 'busy' }, T0).entry;

// ---------- the reducer ----------
test('r1: a subagent_run that starts is counted, with the moment the first one started; one that ends is taken out', () => {
  let e = feed(busy(), start());
  assert.equal(e.subs, 1);
  assert.equal(e.subSince, T0);
  e = feed(e, end());
  assert.equal(e.subs, 0);
  assert.equal(e.subSince, 0);
});

test('r2: two at once are two; the clock keeps the FIRST start while any is on; the end of one leaves the other', () => {
  const e1 = V.rpcReduce(busy(), start(), T0).entry;
  const e2 = V.rpcReduce(e1, start(), T0 + 40000).entry;
  assert.equal(e2.subs, 2);
  assert.equal(e2.subSince, T0, 'the clock of the first one');
  const e3 = V.rpcReduce(e2, end(), T0 + 50000).entry;
  assert.equal(e3.subs, 1);
  assert.equal(e3.subSince, T0, 'one is still on: the clock does not restart');
  const e4 = V.rpcReduce(e3, end(), T0 + 60000).entry;
  assert.deepEqual([e4.subs, e4.subSince], [0, 0]);
});

test('r3: an end with no start never goes below zero', () => {
  const e = feed(busy(), end(), end(), end());
  assert.equal(e.subs, 0);
  assert.equal(e.subSince, 0);
});

test('r4: only the exact name subagent_run counts: other tools, other spellings and odd names never turn it on', () => {
  for (const name of ['bash', 'read', 'subagent_status', 'subagent_result', 'subagent_cancel', 'subagent_list_tasks', 'subagent_runner', 'Subagent_Run', ' subagent_run', 'mcp__custom-tools__subagent_run', '', undefined, null, 7, {}, ['subagent_run'], '__proto__']) {
    const e = feed(busy(), rec({ type: 'tool_execution_start', toolName: name }));
    assert.equal(e.subs, 0, String(name));
    assert.equal(e.subSince, 0, String(name));
  }
  assert.equal(feed(busy(), start('bash')).subs, 0);
});

test('r5: it clears when the run ends (agent_end and agent_settled), when a new run starts, when the session closes or goes idle, and when the status is read again', () => {
  const on = () => feed(busy(), start());
  assert.equal(on().subs, 1);
  for (const p of [rec({ type: 'agent_end' }), rec({ type: 'agent_settled' }), rec({ type: 'agent_start' }), { kind: 'exit' }, { kind: 'state', state: 'idle' }, { kind: 'state', state: 'closed' }]) {
    const e = V.rpcReduce(on(), p, T0 + 9000).entry;
    assert.deepEqual([e.subs, e.subSince], [0, 0], JSON.stringify(p));
  }
  const s = V.rpcFromStatus(on(), { state: 'busy', pendingDialogs: [], sessionId: 's' });
  assert.deepEqual([s.subs, s.subSince], [0, 0], 'after a (re)connect nothing is known: not «working»');
});

test('r6: what keeps it on: other events of the same run, and a state that is still busy or asking', () => {
  let e = on();
  function on() { return feed(busy(), start()); }
  for (const p of [rec({ type: 'message_update', assistantMessageEvent: { type: 'thinking_start', contentIndex: 0 } }), rec({ type: 'compaction_start' }), rec({ type: 'auto_retry_start', attempt: 1, maxAttempts: 3, delayMs: 10 }), { kind: 'state', state: 'busy' }, { kind: 'state', state: 'asking' }, { kind: 'memory', memory: 'ready' }]) {
    e = V.rpcReduce(e, p, T0 + 5000).entry;
    assert.equal(e.subs, 1, JSON.stringify(p));
  }
});

test('r7: it is capped, and odd input never throws or changes it', () => {
  let e = busy();
  for (let i = 0; i < 100; i++) e = V.rpcReduce(e, start(), T0 + i).entry;
  assert.equal(e.subs, 20);
  const on = feed(busy(), start());
  for (const p of [null, undefined, 'x', 7, [], {}, { kind: 'event' }, { kind: 'event', record: null }, { kind: 'event', record: [] }, { kind: 'event', record: { type: 7 } }, rec({ type: 'tool_execution_start' })]) {
    const out = V.rpcReduce(on, p, T0 + 1).entry;
    assert.equal(out.subs, 1, JSON.stringify(p));
  }
});

test('r8: the entry of a repo that has none starts at zero, and what the cache keeps never brings it back', () => {
  assert.deepEqual([V.rpcFromStatus(undefined, null).subs, V.rpcFromStatus(undefined, null).subSince], [0, 0]);
  assert.equal(V.rpcReduce(null, { kind: 'memory', memory: 'ready' }, 0).entry.subs, 0);
  const cached = V.chatFromCache({ info: { found: true }, rpc: { state: 'busy', subs: 3, subSince: 1 }, items: [] });
  assert.ok(!cached || !cached.rpc || !cached.rpc.subs, 'a cached live count is never reused');
});

// ---------- the clock ----------
test('k1: the counter reads mm:ss (minutes keep growing past 59), and anything that is not a duration reads 00:00', () => {
  assert.equal(typeof V.subClock, 'function');
  const cases = [[0, '00:00'], [999, '00:00'], [1000, '00:01'], [59999, '00:59'], [60000, '01:00'], [135000, '02:15'], [3599000, '59:59'], [3665000, '61:05'], [36000000, '600:00']];
  for (const [ms, text] of cases) assert.equal(V.subClock(ms), text, String(ms));
  for (const bad of [-1, -99999, NaN, Infinity, -Infinity, '5', null, undefined, {}, []]) assert.equal(V.subClock(bad), '00:00', String(bad));
});

// ---------- the chip ----------
const live = (over = {}) => ({ info: { found: true }, rpc: { ...busy(), subs: 1, subSince: T0, ...over } });

test('c1: one subagent: «Subagent working» and the counter from its start; two: «2 subagents working» and the counter of the first', () => {
  const one = R.subagentChipHtml(live(), T0 + 135000);
  assert.match(one, /^<span class="sub-chip" title="[^"]+"><i class="sub-dot" aria-hidden="true">[^<]+<\/i> Subagent working <b class="sub-time">02:15<\/b><\/span>$/);
  const two = R.subagentChipHtml(live({ subs: 2 }), T0 + 135000);
  assert.match(two, /2 subagents working <b class="sub-time">02:15<\/b>/);
});

test('c2: it says nothing when nobody knows of a subagent: no count, a session that is not busy or asking, a bad clock, no entry', () => {
  assert.equal(R.subagentChipHtml(live({ subs: 0 }), T0 + 5000), '');
  for (const state of ['closed', 'idle', 'starting']) assert.equal(R.subagentChipHtml(live({ state }), T0 + 5000), '', state);
  assert.match(R.subagentChipHtml(live({ state: 'asking' }), T0 + 5000), /Subagent working/);
  for (const subSince of [0, -5, NaN, Infinity, '1', null, undefined]) assert.equal(R.subagentChipHtml(live({ subSince }), T0 + 5000), '', String(subSince));
  for (const subs of [-1, 1.5, NaN, '1', null, undefined, Infinity]) assert.equal(R.subagentChipHtml(live({ subs }), T0 + 5000), '', String(subs));
  for (const c of [null, undefined, {}, { info: null }, { rpc: null }, { rpc: 'x' }, { rpc: [] }, 7, 'x']) assert.equal(R.subagentChipHtml(c, T0), '', JSON.stringify(c));
  assert.equal(R.subagentChipHtml(live(), undefined), '', 'without a clock there is no counter to show');
});

test('c3: it NEVER says slow or stuck, however long it has been on (only the counter grows): that needs activity data (RP153)', () => {
  for (const hours of [0, 1, 3, 30]) {
    const h = R.subagentChipHtml(live(), T0 + hours * 3600000 + 5000);
    assert.doesNotMatch(h, /slow|stuck|block|no signal|lento|bloque|sin se/i, `${hours} h`);
    assert.match(h, /Subagent working/);
  }
});

test('c4: nothing that is not ours reaches the markup: no free text of the entry, no name of an agent, no prompt (hostile fields are ignored)', () => {
  const evil = '<img src=x onerror=1>';
  const h = R.subagentChipHtml(live({ text: evil, error: evil, agent: evil, label: evil, task: evil, blocks: [evil], name: evil }), T0 + 5000);
  assert.ok(!h.includes('<img') && !h.includes(evil) && !h.includes('onerror'), h);
});

test('c5: it is not a live region (a counter that changes every second must not be announced), it has a help text, and it never depends on colour alone', () => {
  const h = R.subagentChipHtml(live(), T0 + 5000);
  assert.doesNotMatch(h, /role=|aria-live|aria-atomic/);
  assert.match(h, /title="[^"]*subagent[^"]*"/i);
  assert.match(h, /Subagent working/, 'the words are there');
});

// ---------- the stylesheet ----------
const rules = [...css.matchAll(/(?:^|\n)([^{}\n@/ ][^{}\n]*)\{([^}]*)\}/g)].flatMap((m) => m[1].split(',').map((s) => ({ sel: s.trim().replace(/\s+/g, ' '), body: m[2] })));
const rule = (sel) => { const r = rules.filter((x) => x.sel === sel); assert.ok(r.length, `a rule for ${sel}`); return r.map((x) => x.body).join(';'); };

test('s1: the chip is blue (normal activity, not a warning), rounded like its neighbours, with a counter that does not jump when its digits change', () => {
  assert.match(rule('.sub-chip'), /color:\s*var\(--blue\)/);
  assert.match(rule('.sub-chip'), /border-radius:/);
  assert.match(rule('.sub-time'), /font-variant-numeric:\s*tabular-nums/);
});

// ---------- the page ----------
function element(extra = {}) {
  const el = {
    html: '', hidden: false, dataset: {}, disabled: false, value: '', checked: false, textContent: '', title: '', placeholder: '', attrs: {}, listeners: {}, children: [], open: false,
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    style: { setProperty(k, v) { el.style[k] = v; } },
    addEventListener(t, fn) { (el.listeners[t] ||= []).push(fn); }, setAttribute(k, v) { el.attrs[k] = v; }, querySelector: () => null, querySelectorAll: () => [], closest: () => null,
    showModal() {}, close() {}, focus() {}, append(c) { el.children.push(c); },
    get innerHTML() { return el.html; }, set innerHTML(v) { el.html = String(v); }, ...extra,
  };
  return el;
}
function loadPage(answers) {
  const els = {};
  const frames = [];
  const timers = [];
  const tabEls = ['summary', 'work', 'conformity', 'settings'].map((t) => element({ dataset: { tab: t } }));
  const get = (sel) => (els[sel] ||= (sel === 'meta[name=token]' ? element({ content: 'token' }) : element()));
  const doc = { hidden: false, querySelector: get, querySelectorAll: (s) => (String(s).includes('data-tab') ? tabEls : []), addEventListener() {}, createElement: () => element(), body: element(), activeElement: null };
  const ctx = vm.createContext({
    console, document: doc, location: { hash: '' }, TextDecoder, AbortController, confirm: () => true,
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    requestAnimationFrame: (cb) => { frames.push(cb); return frames.length; }, setInterval: (fn, ms) => { timers.push({ fn, ms }); return timers.length; }, setTimeout: (fn) => { timers.push({ fn }); return timers.length; }, clearTimeout: () => {}, clearInterval: () => {},
    fetch: (url) => {
      const a = Object.entries(answers).find(([k]) => url.startsWith(k));
      if (!a) return new Promise(() => {});
      const v = typeof a[1] === 'function' ? a[1](url) : a[1];
      return Promise.resolve(v).then((json) => ({ ok: true, json: async () => json }));
    },
  });
  ctx.window = ctx;
  ctx.addEventListener = () => {};
  ctx.RepoPanelView = V;
  ctx.RepoPanelResumen = R;
  vm.runInContext(appSource(), ctx);
  const flush = () => { while (frames.length) frames.shift()(); };
  const tick = async (n = 8) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); flush(); };
  return { get, tick, timers, doc, run: (code) => vm.runInContext(code, ctx) };
}
const ID = 'abcdef0123';
const ID2 = 'abcdefghij';
const ADOPTED = { key: ID, adopted: { id: 's1', name: 'demo', adoptedAt: 'x' }, adoptedFound: true, sessions: [], live: { state: 'none', count: 0 } };
async function chatPage({ state = 'busy' } = {}) {
  const page = loadPage({
    '/api/events': () => new Promise(() => {}), '/api/rpc/status': { state, pendingDialogs: [], sessionId: 's1' }, '/api/rpc/context': { tokens: 1, percent: 1, window: 100 }, '/api/sessions': ADOPTED,
    '/api/chat': { key: ID, sessionId: 's1', found: true, items: [], truncated: false, updatedAt: null },
  });
  const st = page.run('S');
  st.groups = [{ name: 'G', repos: [{ id: ID, name: 'demo', path: 'p' }, { id: ID2, name: 'other', path: 'q' }] }];
  st.summary = { rows: [], generatedAt: 'x' };
  page.open = async (id = ID) => { page.run(`ACTIONS['chat-open']({ dataset: { id: '${id}' } })`); await page.tick(); };
  page.rpc = async (id, p) => { page.run(`applyRpc(${JSON.stringify({ id, ...p })})`); await page.tick(); };
  page.state = () => page.get('#sessState').html;
  return page;
}

test('p1: a subagent_run that starts shows the chip next to the state of the session, right after its label; its end takes it away', async () => {
  const page = await chatPage();
  await page.open();
  assert.doesNotMatch(page.state(), /Subagent/);
  await page.rpc(ID, start());
  assert.match(page.state(), /Subagent working <b class="sub-time">00:0\d<\/b>/);
  assert.match(page.state(), /<\/span><span class="sub-chip"/, 'right after the label of the state');
  await page.rpc(ID, end());
  assert.doesNotMatch(page.state(), /Subagent/);
});

test('p2: the end of the run, an exit and a state that goes idle also take it away', async () => {
  for (const p of [rec({ type: 'agent_end' }), rec({ type: 'agent_settled' }), { kind: 'exit' }, { kind: 'state', state: 'idle' }]) {
    const page = await chatPage();
    await page.open();
    await page.rpc(ID, start());
    assert.match(page.state(), /Subagent working/, JSON.stringify(p));
    await page.rpc(ID, p);
    assert.doesNotMatch(page.state(), /Subagent/, JSON.stringify(p));
  }
});

test('p3: a subagent of ANOTHER repo is not drawn in the open chat, and it is there when that repo is opened', async () => {
  const page = await chatPage();
  await page.open();
  await page.rpc(ID2, start());
  assert.doesNotMatch(page.state(), /Subagent/);
  assert.equal(page.run(`S.rpc['${ID2}'].subs`), 1);
});

test('p4: the clock runs by itself every second while one is on: the counter moves without any event', async () => {
  const page = await chatPage();
  await page.open();
  await page.rpc(ID, start());
  page.run(`S.rpc['${ID}'].subSince = Date.now() - 125000`);
  page.run('subTick()');
  await page.tick();
  assert.match(page.state(), /Subagent working <b class="sub-time">02:0\d<\/b>/);
  const ticker = page.timers.find((t) => t.ms === 1000);
  assert.ok(ticker, 'a timer of 1000 ms is registered');
  assert.match(appSource(), /setInterval\(subTick, 1000\)/);
});

test('p5: the clock does nothing (no repaint) when no subagent is on, when the page is hidden, or when no chat is open', async () => {
  const page = await chatPage();
  await page.open();
  page.run('globalThis.__draws = 0; { const real = draw; draw = (...a) => { globalThis.__draws++; return real(...a); }; }');
  page.run('subTick()');
  assert.equal(page.run('__draws'), 0, 'nobody working: no repaint');
  await page.rpc(ID, start());
  const before = page.run('__draws');
  page.doc.hidden = true;
  page.run('subTick()');
  assert.equal(page.run('__draws'), before, 'a hidden page is not repainted');
  page.doc.hidden = false;
  page.run('subTick()');
  assert.equal(page.run('__draws'), before + 1, 'visible and working: one repaint');
  page.run('closeChat()');
  page.run('subTick()');
  assert.equal(page.run('__draws') >= before + 1, true);
  const n = page.run('__draws');
  page.run('subTick()');
  assert.equal(page.run('__draws'), n, 'no chat open: nothing to repaint');
});

test('p6: reading the status again (open, reconnect) clears it: after a missed event nothing is known, so it is not «working»', async () => {
  const page = await chatPage();
  await page.open();
  await page.rpc(ID, start());
  assert.match(page.state(), /Subagent working/);
  page.run(`S.rpc['${ID}'] = V.rpcFromStatus(S.rpc['${ID}'], { state: 'busy', pendingDialogs: [], sessionId: 's1' }); draw();`);
  await page.tick();
  assert.doesNotMatch(page.state(), /Subagent/);
});

test('p7: the existing state label is unchanged by this row: Working…, Idle and the chips of memory, context and compaction are drawn as before', async () => {
  const page = await chatPage();
  await page.open();
  assert.match(page.state(), /Working…/);
  await page.rpc(ID, { kind: 'memory', memory: 'ready' });
  assert.match(page.state(), /memory ready/);
  assert.doesNotMatch(page.state(), /Subagent/);
});

test('p8: the page code has no way to show an agent name or free text of a tool call: the server whitelist is untouched and the reducer reads only the type and the tool name', () => {
  const lf = (text) => text.replace(/\r\n/g, '\n'); // a Windows runner checks the repo out with CRLF: the regex below looks for LF
  const view = lf(fs.readFileSync(path.join(__dirname, '..', 'public', 'view.js'), 'utf8'));
  const reducer = /function rpcReduce\([\s\S]*?\n  \}\n/.exec(view)[0];
  assert.doesNotMatch(reducer, /\bargs\b|toolCallId|\.agent\b|\.label\b|\.task\b/, 'the reducer never reads arguments, ids or names of agents');
  assert.match(lf(fs.readFileSync(path.join(__dirname, 'rpc2-1-server.test.js'), 'utf8')), /tool_execution_start', toolName: 'read' \}/, 'the server test that pins the whitelist is still there');
});
