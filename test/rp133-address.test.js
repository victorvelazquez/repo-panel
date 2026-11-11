'use strict';
// RP133 (S26): one address per screen in Summary. The open repo and its zone (chat or repo) live in the address of the page (the hash), so Back and Forward of the browser and of the phone walk those screens and a link reopens
// the same place. The address is UNTRUSTED INPUT: anyone can type or paste one. The grammar is closed: `#/repo/<id>/<zone>` (the zone is optional when reading, always written), `#conformity` as before, and empty, `#` and `#/`
// for the list. Only an id that is in the list of repos of the page counts, compared as exact text after a closed check of its characters and length; nothing is decoded (any `%` is out), evaluated or drawn as markup. Anything else is
// ignored and the junk is replaced in the address bar (no new entry of the history). The page WRITES with history.pushState (no event, no loop) and READS with popstate and hashchange; applying an address never writes.
// The zone has no buttons yet (RP134): this row keeps it in S.chat.zone, takes it to the address and has the action `zone-set`.
// The tests of the abuse come first: the parser is pure, so the hostile addresses are a table.
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { appSource } = require('./pagesrc.js');
const V = require('../public/view.js');
const R = require('../public/resumen.js');

const A = '5f7891df60';
const B = 'abcdef0123';
const IDS = [A, B, 'a-b_c'];
const parse = (h, ids = IDS) => V.parseAddress(h, ids);

// ---------- the grammar ----------
test('g1: the list is the empty address, #, #/ ; Conformity is #conformity exactly; neither needs a list of repos', () => {
  for (const h of ['', '#', '#/']) assert.deepEqual(parse(h), { kind: 'list' }, JSON.stringify(h));
  assert.deepEqual(parse('#conformity'), { kind: 'conformity' });
  for (const ids of [undefined, null, [], 'x', 7, {}]) { assert.deepEqual(parse('', ids), { kind: 'list' }); assert.deepEqual(parse('#conformity', ids), { kind: 'conformity' }); }
});

test('g2: a repo of the list, with the zone or without it (then it is chat); the id comes back as the SAME text of the list, the zone from the closed list', () => {
  assert.deepEqual(parse(`#/repo/${A}`), { kind: 'repo', id: A, zone: 'chat' });
  assert.deepEqual(parse(`#/repo/${A}/chat`), { kind: 'repo', id: A, zone: 'chat' });
  assert.deepEqual(parse(`#/repo/${B}/repo`), { kind: 'repo', id: B, zone: 'repo' });
  assert.deepEqual(parse('#/repo/a-b_c/chat'), { kind: 'repo', id: 'a-b_c', zone: 'chat' });
  for (const h of [`#/repo/${A}`, `#/repo/${B}/repo`]) assert.ok(IDS.includes(parse(h).id));
});

test('g3: addressOf writes the same grammar, with the zone always; an id that is not safe gives no address; a zone that is not of the list is chat', () => {
  assert.equal(V.addressOf(A, 'repo'), `#/repo/${A}/repo`);
  assert.equal(V.addressOf(A, 'chat'), `#/repo/${A}/chat`);
  for (const z of [undefined, null, '', 'x', 'Chat', 'tasks', '__proto__', 7, {}, []]) assert.equal(V.addressOf(A, z), `#/repo/${A}/chat`, String(z));
  for (const id of ['room:abc', '', 'a/b', '<img>', 'a b', 'a%20b', `${'a'.repeat(65)}`, null, undefined, 7, {}, [], '__proto__', 'constructor', 'prototype', 'ñ']) assert.equal(V.addressOf(id, 'chat'), '', String(id));
});

test('g4: what addressOf writes parseAddress reads back, for every repo and zone', () => {
  for (const id of IDS) for (const zone of ['chat', 'repo']) assert.deepEqual(parse(V.addressOf(id, zone)), { kind: 'repo', id, zone });
});

// ---------- the abuse ----------
const HOSTILE = [
  // ids that are not in the list, and look-alikes of the ones that are
  `#/repo/nope/chat`, `#/repo/${A.toUpperCase()}/chat`, `#/repo/${A}0/chat`, `#/repo/${A.slice(1)}/chat`, `#/repo/\u0435${B.slice(1)}/chat`, `#/repo/${A.slice(0, 5)}\u200b${A.slice(5)}/chat`, `#/repo/${A}\u202e/chat`,
  // shape: repeated, missing, extra and out-of-order segments
  `#/repo/${A}/chat/chat`, `#/repo/${A}/chat/`, `#/repo/${A}/`, `#/repo//chat`, `#//repo/${A}/chat`, `#repo/${A}/chat`, `#/${A}/chat`, `#/repo`, `#/repo/`, `#/repo/${A}/repo/${B}/chat`, `#/repo/${A}/chat/more`, `#/chat/repo/${A}`,
  // case and spelling of the fixed words
  `#/REPO/${A}/chat`, `#/Repo/${A}/chat`, `#/repo/${A}/Chat`, `#/repo/${A}/CHAT`, `#/repo/${A}/ch\u0430t`, '#Conformity', '#CONFORMITY', '#conformity/', '#conformity?x=1', '#conformity#x', '#conformity ',
  // zones that do not exist
  `#/repo/${A}/tasks`, `#/repo/${A}/changes`, `#/repo/${A}/files`, `#/repo/${A}/x`, `#/repo/${A}/__proto__`, `#/repo/${A}/constructor`, `#/repo/${A}/ chat`, `#/repo/${A}/chat `,
  // query, fragment, spaces, control characters, null byte, backslash
  `#/repo/${A}/chat?x=1`, `#/repo/${A}/chat#x`, `#/repo/${A}?x=1`, ` #/repo/${A}/chat`, `#/repo/${A}/chat\n`, `#/repo/${A}/chat\r`, `#/repo/${A}/chat\t`, `#/repo/${A}/chat\u0000`, `#/repo/${A}\\chat`, `#/repo\\${A}/chat`, '#\u0000',
  // encodings (nothing is decoded, so any % is out)
  `#/repo/${A}%2Fchat`, `#/repo/${A}/%63hat`, `#/repo/%35f7891df60/chat`, `#/repo/%2e%2e/${A}/chat`, `#/repo/${A}%00/chat`, `#/repo/%3Cimg%20src%3Dx%3E/chat`, `#%2Frepo%2F${A}%2Fchat`, `#/repo/${A}/chat%`,
  // markup and scripts
  '#/repo/<img src=x onerror=1>/chat', '#/repo/"><script>alert(1)</script>/chat', "#/repo/';alert(1);'/chat", `#/repo/${A}/<b>`, `#/repo/${A}/"><svg/onload=1>`, '#javascript:alert(1)', '#/repo/javascript:alert(1)/chat', '#data:text/html,<script>alert(1)</script>', '#/<script>/chat',
  // paths that climb
  '#/../../etc/passwd', `#/repo/../${A}/chat`, `#/repo/./${A}/chat`, `#/repo/${A}/../chat`, '#/repo/..', '#/repo/.',
  // names of the machinery of the language, even if they were in the list (see below) or not
  '#/repo/__proto__/chat', '#/repo/constructor/chat', '#/repo/prototype/chat', '#/repo/toString/chat', '#/repo/hasOwnProperty/chat', '#/repo/valueOf/chat',
  // size
  `#/repo/${'a'.repeat(65)}/chat`, `#/repo/${'a'.repeat(1000)}`, `#/repo/${'a'.repeat(100000)}`, `#${'x'.repeat(100000)}`, `#/repo/${A}/${'chat'.repeat(1000)}`,
  // other
  '#/repo/ñ/chat', '#/repo/日本/chat', '#/repo/🙂/chat', '#!', '#?', '##', '#/#', '#//', '#.', '#/ ', '#0', '#null', '#undefined', '#[object Object]',
];

test('a1: every hostile address is ignored (null): not a list, not a repo, not Conformity', () => {
  assert.ok(HOSTILE.length >= 90, `${HOSTILE.length} addresses in the table`);
  for (const h of HOSTILE) assert.equal(parse(h), null, JSON.stringify(h).slice(0, 80));
});

test('a2: what is not text is ignored and never throws: null, undefined, numbers, booleans, objects, arrays, functions, symbols', () => {
  for (const h of [null, undefined, 0, 7, NaN, true, false, {}, { toString: () => '#/' }, [], ['#/'], () => '#/', Symbol('x'), 10n]) assert.doesNotThrow(() => parse(h), String(typeof h));
  for (const h of [null, undefined, 0, 7, NaN, true, false, {}, { toString: () => '#/' }, [], ['#/'], () => '#/', Symbol('x'), 10n]) assert.equal(parse(h), null);
});

test('a3: the list of repos can be anything: only a real array of texts lets a repo through, and an odd list never throws', () => {
  for (const ids of [undefined, null, 'x', 7, {}, new Set([A]), new Map([[A, 1]]), { [A]: true }, { length: 1, 0: A }, () => [A], Symbol('x'), [null], [undefined], [7], [{}], [[A]]]) {
    assert.doesNotThrow(() => V.parseAddress(`#/repo/${A}/chat`, ids));
    assert.equal(V.parseAddress(`#/repo/${A}/chat`, ids), null, String(ids)); // (not through `parse`: its default list would replace an undefined)
  }
  assert.deepEqual(parse(`#/repo/${A}/chat`, [null, 7, A]), { kind: 'repo', id: A, zone: 'chat' }, 'odd entries are skipped, a good one still counts');
});

test('a4: the names of the machinery are refused even if a list had them, and an id of the list that is not safe text is never returned', () => {
  for (const id of ['__proto__', 'constructor', 'prototype', 'toString', 'hasOwnProperty']) assert.equal(parse(`#/repo/${id}/chat`, [id, A]), null, id);
  for (const id of ['room:abc', 'a b', 'a/b', '<img>', 'ñ', '', 'a'.repeat(65), 'a%20b', '%41', '50%', '%']) assert.equal(parse(`#/repo/${id}/chat`, [id]), null, id); // nothing is decoded: a % is out even if the list had such an id
});

test('a5: a list of fifty thousand repos and a hundred thousand hostile addresses are fast, and nothing is retained between calls', () => {
  const many = Array.from({ length: 50000 }, (_, i) => `r${i}`);
  const t0 = Date.now();
  assert.deepEqual(parse('#/repo/r49999/repo', many), { kind: 'repo', id: 'r49999', zone: 'repo' });
  for (let i = 0; i < 2000; i++) assert.equal(parse(`#/repo/${'z'.repeat(70)}${i}/chat`, many), null);
  for (let i = 0; i < 100000; i++) parse(`#${i}`, IDS);
  assert.ok(Date.now() - t0 < 5000, `${Date.now() - t0} ms`);
  assert.equal(parse('#/repo/r1/chat', IDS), null);
});

test('a6: a result is a fresh plain object each time (nothing the page can change is shared) and carries only its own fields', () => {
  const a = parse(`#/repo/${A}/chat`);
  const b = parse(`#/repo/${A}/chat`);
  assert.notEqual(a, b);
  assert.deepEqual(Object.keys(a).sort(), ['id', 'kind', 'zone']);
  assert.deepEqual(Object.keys(parse('')), ['kind']);
  a.id = 'changed';
  assert.equal(parse(`#/repo/${A}/chat`).id, A);
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
const CONFIG = (ids) => ({ groups: [{ name: 'G', repos: ids.map((id) => ({ id, name: `repo-${id}`, path: `p-${id}` })) }], snoozed: [], dismissed: [], rooms: [], roomIssues: [] });
// `opts.hash`: the address the page is opened with; `opts.history: false` runs it with no history at all (the stub of most suites), `opts.noLocation` with no location.
async function boot({ hash = '', ids = [A, B], history = true, noLocation = false, config = true } = {}) {
  const els = {};
  const frames = [];
  const listeners = {};
  const calls = [];
  const loc = { hash, pathname: '/panel/', search: '?x=1' };
  const setUrl = (url) => { const at = String(url).indexOf('#'); loc.hash = at >= 0 ? String(url).slice(at) : ''; };
  const hist = history ? { pushState(s, t, url) { calls.push(['push', url]); setUrl(url); }, replaceState(s, t, url) { calls.push(['replace', url]); setUrl(url); } } : undefined;
  const tabEls = ['summary', 'work', 'conformity', 'settings'].map((t) => element({ dataset: { tab: t } }));
  const get = (sel) => (els[sel] ||= (sel === 'meta[name=token]' ? element({ content: 'token' }) : element()));
  const doc = { hidden: false, querySelector: get, querySelectorAll: (s) => (String(s).includes('data-tab') ? tabEls : []), addEventListener() {}, createElement: () => element(), body: element(), activeElement: null };
  const sandbox = {
    console, document: doc, TextDecoder, AbortController, confirm: () => true,
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    requestAnimationFrame: (cb) => { frames.push(cb); return frames.length; }, setInterval: () => 0, setTimeout: () => 0, clearTimeout: () => {}, clearInterval: () => {},
    fetch: (url) => {
      if (config && String(url).startsWith('/api/config')) return Promise.resolve({ ok: true, json: async () => CONFIG(ids) });
      return new Promise(() => {});
    },
  };
  if (!noLocation) sandbox.location = loc;
  if (hist) sandbox.history = hist;
  const ctx = vm.createContext(sandbox);
  ctx.window = ctx;
  ctx.addEventListener = (t, fn) => { (listeners[t] ||= []).push(fn); };
  ctx.RepoPanelView = V;
  ctx.RepoPanelResumen = R;
  vm.runInContext(appSource(), ctx);
  const flush = () => { while (frames.length) frames.shift()(); };
  const tick = async (n = 10) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); flush(); };
  await tick();
  const page = {
    loc, calls, listeners, tick, get, run: (code) => vm.runInContext(code, ctx),
    chatId: () => vm.runInContext('S.chat.id', ctx), zone: () => vm.runInContext('S.chat.zone', ctx), tab: () => vm.runInContext('S.tab', ctx),
    go: async (h) => { loc.hash = h; for (const t of ['popstate', 'hashchange']) for (const fn of listeners[t] || []) fn({ type: t }); await tick(); },
    pushes: () => calls.filter((c) => c[0] === 'push').map((c) => c[1]),
    replaces: () => calls.filter((c) => c[0] === 'replace').map((c) => c[1]),
    click: async (act, dataset = {}) => { vm.runInContext(`ACTIONS[${JSON.stringify(act)}]({ dataset: ${JSON.stringify(dataset)} })`, ctx); await tick(); },
  };
  return page;
}
const LIST_URL = '/panel/?x=1';

test('p1: opened with the address of a repo and a zone, the page opens that repo in that zone, on Summary, and writes nothing to the history', async () => {
  const page = await boot({ hash: `#/repo/${B}/repo` });
  assert.equal(page.chatId(), B);
  assert.equal(page.zone(), 'repo');
  assert.equal(page.tab(), 'summary');
  assert.deepEqual(page.calls, []);
});

test('p2: without the zone it opens in chat; the list address leaves the list; Conformity still opens its tab (the existing link)', async () => {
  const a = await boot({ hash: `#/repo/${A}` });
  assert.deepEqual([a.chatId(), a.zone()], [A, 'chat']);
  const b = await boot({ hash: '' });
  assert.equal(b.chatId(), null);
  const c = await boot({ hash: '#conformity' });
  assert.equal(c.tab(), 'conformity');
  assert.equal(c.chatId(), null);
  assert.deepEqual(c.calls, [], 'a link that works does not touch the history');
});

test('p3: every hostile address opens nothing, draws no markup, and is replaced in the address bar by the list (no new history entry)', async () => {
  for (const h of HOSTILE.slice(0, 60)) {
    const page = await boot({ hash: h });
    assert.equal(page.chatId(), null, JSON.stringify(h).slice(0, 60));
    assert.equal(page.tab(), 'summary');
    assert.deepEqual(page.pushes(), [], 'a pushed entry would let Back return to the junk');
    assert.deepEqual(page.replaces(), [LIST_URL], JSON.stringify(h).slice(0, 60));
    assert.equal(page.loc.hash, '');
    assert.ok(!page.get('#chatBody').html.includes('<img') && !page.get('#sessState').html.includes('<img'));
  }
});

test('p4: opening a repo from the list writes ONE entry with its address and chat; the same repo again writes nothing', async () => {
  const page = await boot();
  await page.click('chat-open', { id: A });
  assert.deepEqual(page.pushes(), [`/panel/?x=1#/repo/${A}/chat`]);
  await page.click('chat-open', { id: A });
  assert.equal(page.pushes().length, 1);
  assert.equal(page.chatId(), A);
});

test('p5: a change of zone writes one entry; the same zone, a zone that does not exist and an odd value write nothing and change nothing', async () => {
  const page = await boot();
  await page.click('chat-open', { id: A });
  await page.click('zone-set', { zone: 'repo' });
  assert.deepEqual(page.pushes().slice(-1), [`/panel/?x=1#/repo/${A}/repo`]);
  assert.equal(page.zone(), 'repo');
  const n = page.pushes().length;
  await page.click('zone-set', { zone: 'repo' });
  for (const z of ['', 'x', 'Chat', '__proto__', 'constructor', 'tasks', '<img>', undefined, null, 7]) await page.click('zone-set', { zone: z === undefined ? undefined : z });
  assert.equal(page.pushes().length, n);
  assert.equal(page.zone(), 'repo');
  await page.click('zone-set', { zone: 'chat' });
  assert.deepEqual(page.pushes().slice(-1), [`/panel/?x=1#/repo/${A}/chat`]);
});

test('p6: with no repo open the zone has nothing to change: no write and no zone', async () => {
  const page = await boot();
  await page.click('zone-set', { zone: 'repo' });
  assert.deepEqual(page.calls, []);
  assert.equal(page.chatId(), null);
});

test('p7: closing the chat writes the list address (the URL without a hash)', async () => {
  const page = await boot();
  await page.click('chat-open', { id: A });
  page.run('closeChat()');
  await page.tick();
  assert.deepEqual(page.pushes().slice(-1), [LIST_URL]);
  assert.equal(page.loc.hash, '');
});

test('p8: Back and Forward (the address changes by the browser): another repo opens, the list closes, and none of it writes to the history', async () => {
  const page = await boot();
  await page.click('chat-open', { id: A });
  const written = page.calls.length;
  await page.go(`#/repo/${B}/repo`);
  assert.deepEqual([page.chatId(), page.zone()], [B, 'repo']);
  await page.go('');
  assert.equal(page.chatId(), null);
  await page.go(`#/repo/${A}/chat`);
  assert.equal(page.chatId(), A);
  await page.go('#conformity');
  assert.equal(page.tab(), 'conformity');
  assert.equal(page.calls.length, written, 'applying an address never writes');
});

test('p9: a junk address typed while a repo is open changes nothing in the page and the address bar goes back to the address of what is open', async () => {
  const page = await boot();
  await page.click('chat-open', { id: A });
  await page.click('zone-set', { zone: 'repo' });
  for (const h of ['#/repo/nope/chat', '#/repo/<img src=x onerror=1>/chat', `#/repo/${A}/chat/chat`, '#/repo/%41/chat', `#/repo/${A}/tasks`]) {
    const before = page.calls.length;
    await page.go(h);
    assert.equal(page.chatId(), A, h);
    assert.equal(page.zone(), 'repo', h);
    assert.deepEqual(page.calls.slice(before), [['replace', `/panel/?x=1#/repo/${A}/repo`]], h);
    assert.equal(page.loc.hash, `#/repo/${A}/repo`);
  }
});

test('p10: a burst of changes of the address does not loop and does not write: five hundred events, every transition applied once', async () => {
  const page = await boot();
  page.run('globalThis.__n = { open: 0, close: 0 }; { const o = openChat; const c = closeChat; openChat = (...a) => { __n.open++; return o(...a); }; closeChat = (...a) => { __n.close++; return c(...a); }; }');
  const seq = [`#/repo/${A}/chat`, `#/repo/${B}/repo`, '', '#/repo/nope/chat', `#/repo/${A}/repo`, '#/repo/<x>/chat', ''];
  let transitions = 0;
  let current = null;
  for (let i = 0; i < 500; i++) {
    const h = seq[i % seq.length];
    const want = h === '' ? null : /^#\/repo\/([a-z0-9]+)/.exec(h) && [A, B].includes(/^#\/repo\/([a-z0-9]+)/.exec(h)[1]) ? /^#\/repo\/([a-z0-9]+)/.exec(h)[1] : undefined;
    if (want !== undefined && want !== current) { transitions++; current = want; }
    await page.go(h);
  }
  assert.equal(page.pushes().length, 0, 'not one entry written by applying addresses');
  assert.equal(page.run('__n.open + __n.close') <= transitions + 1, true, `${page.run('__n.open + __n.close')} calls for ${transitions} transitions`);
  assert.ok(page.calls.length < 400, 'the junk is replaced, never answered with a flood');
});

test('p11: events before the list of repos is known are ignored (a valid address is not cleared as if it were junk)', async () => {
  const page = await boot({ hash: `#/repo/${A}/chat`, config: false });
  assert.equal(page.chatId(), null, 'no repos yet: nothing to open');
  await page.go(`#/repo/${A}/chat`);
  assert.deepEqual(page.replaces(), [], 'and nothing is cleared');
  assert.equal(page.loc.hash, `#/repo/${A}/chat`);
});

test('p12: a chat that has no address (a room: its id is not a plain id) leaves the address bar alone', async () => {
  const page = await boot({ ids: [A, 'room:team'] });
  await page.click('chat-open', { id: A });
  const n = page.calls.length;
  await page.click('chat-open', { id: 'room:team' });
  assert.equal(page.calls.length, n, 'nothing written for a chat with no address');
  const b = await boot({ hash: '#/repo/room:team/chat', ids: [A, 'room:team'] });
  assert.equal(b.chatId(), null, 'and an address with such an id is not valid');
});

test('p15: opening a repo whose address is ALREADY in the address bar writes nothing (no duplicate entry); and the list address already there is not written again when the chat closes', async () => {
  const page = await boot();
  page.loc.hash = `#/repo/${A}/chat`; // the bar already says it (a link that could not be applied before the repos were known)
  await page.click('chat-open', { id: A });
  assert.equal(page.chatId(), A);
  assert.deepEqual(page.pushes(), [], 'the address of the repo is already the one in the bar');
  page.loc.hash = '#'; // the bar says the list in its other spelling
  page.run('closeChat()');
  await page.tick();
  assert.deepEqual(page.pushes(), [], '# and #/ and the empty address are all the list');
  page.loc.hash = '#/';
  await page.click('chat-open', { id: B });
  assert.equal(page.pushes().length, 1, 'a different repo does write');
  assert.equal(page.loc.hash, `#/repo/${B}/chat`, 'and the bar now says that repo');
  page.run('closeChat()');
  await page.tick();
  assert.equal(page.pushes().length, 2, 'closing from a repo whose address is in the bar writes the list');
});

test('p16: a link to a repo while the page is on another tab (Work, Conformity) takes it to Summary, where the repo opens, and writes nothing', async () => {
  for (const tab of ['work', 'conformity']) {
    const page = await boot();
    page.run(`setTab('${tab}')`);
    await page.tick();
    assert.equal(page.tab(), tab);
    await page.go(`#/repo/${B}/repo`);
    assert.equal(page.tab(), 'summary', tab);
    assert.deepEqual([page.chatId(), page.zone()], [B, 'repo'], tab);
    assert.deepEqual(page.calls, [], tab);
  }
});

test('p13: with no history, no pushState, no replaceState or no location at all the page still runs (most suites run it in a stub): nothing throws', async () => {
  for (const o of [{ history: false }, { noLocation: true }, { history: false, noLocation: true }]) {
    const page = await boot(o);
    await page.click('chat-open', { id: A });
    assert.equal(page.chatId(), A);
    await page.go(`#/repo/${B}/chat`);
  }
  const partial = await boot();
  partial.run('history.pushState = undefined');
  await partial.click('chat-open', { id: A });
  assert.equal(partial.chatId(), A);
});

test('p14: the page listens to both popstate and hashchange, once each, and the code has no way to evaluate or draw an address', () => {
  const src = appSource();
  assert.match(src, /addEventListener\('popstate'/);
  assert.match(src, /addEventListener\('hashchange'/);
  const glue = /function addressApply[\s\S]*?\n\}\n/.exec(src);
  assert.ok(glue, 'the function that applies an address exists');
  assert.doesNotMatch(glue[0], /innerHTML|eval\(|new Function|decodeURI|unescape|document\.write|location\.(href|assign|replace)\s*=/);
});
