'use strict';
// RP106b: the text of a tool result, ON REQUEST. A click on a chip asks `GET /api/chat/result`, which answers only when `chat.showResults` of config.json is true (off by default),
// never for `read`, never as part of the history, with about 300 characters of the START of the result, cleaned (control characters, uppercase NAME=value lines, patterns of secrets).
// The abuse tests come first. Every token-shaped fake is built from parts, so no literal in this file looks like a secret to a scanner (GitHub push protection rejected one before).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { appSource } = require('./pagesrc.js');

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'rp106b-'));
const sessionsBase = path.join(scratch, 'sessions');
const repoDir = path.join(scratch, 'My Repo.Api');
for (const d of [sessionsBase, repoDir]) fs.mkdirSync(d);
const configFile = path.join(scratch, 'config.json');
process.env.REPO_PANEL_CONFIG = configFile;
process.env.REPO_PANEL_SESSIONS_DIR = sessionsBase;
test.after(() => fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 5 }));

const lib = require('../lib.js');
const S = require('../server/sessions.js');
const { createServer } = require('../server/http.js');
const { loadConfig, saveConfig } = require('../server/config.js');
const { redactText, RESULT_MAX } = require('../server/redact.js');
const V = require('../public/view.js');
const R = require('../public/resumen.js');

const REPO_ID = lib.repoId(repoDir);
const j = (...p) => p.join('');
const TOKEN = j('gh', 'p_aB3dE6gH9jK2mN5pQ8sT1vW4yZ7bC0eF3hJ6');
const AWS = j('AK', 'IAIOSFODNN7EXAMPLE');
const KEYBLOCK = j('-----BEGIN RSA', ' PRIVATE KEY-----');
const writeConfig = (extra = {}) => fs.writeFileSync(configFile, JSON.stringify({ port: 4310, groups: [{ name: 'G', repos: [{ path: repoDir }] }], sessions: { [REPO_ID]: { id: 's1', name: 'panel:x', adoptedAt: '2026-10-28T10:00:00.000Z' } }, ...extra }));

const header = (id, cwd) => JSON.stringify({ type: 'session', version: 3, id, timestamp: '2026-10-28T10:00:00.000Z', cwd });
const text = (t) => ({ type: 'text', text: t });
const call = (name, args, id) => ({ type: 'toolCall', id, name, arguments: args });
const msg = (role, content, extra = {}) => JSON.stringify({ type: 'message', timestamp: '2026-10-28T14:00:00.000Z', message: { role, content, timestamp: Date.parse('2026-10-28T14:00:00Z'), ...extra } });
const result = (toolCallId, toolName, content, extra = {}) => msg('toolResult', content, { toolCallId, toolName, isError: false, durationMs: 5, ...extra });
function putSession(id, lines) {
  const dir = S.sessionsDirFor(repoDir, sessionsBase);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `2026-10-28T10-00-00-000Z_${id}.jsonl`), lines.join('\n') + '\n');
}
const DIRTY = ['npm test ok', 'API_KEY=hunter2x', 'PGPASSWORD=hunter2x', 'DATABASE_URL=postgres://u:hunter2x@h/db', 'FOO=hunter2x', 'Authorization: Bearer hunter2x', 'curl https://user:hunter2x@host/x', `token ${TOKEN}`, `aws ${AWS}`, KEYBLOCK, 'MIIEowIBAAKCAQEA1234567890'].join('\n');
function seed() {
  putSession('s1', [
    header('s1', repoDir), msg('user', [text('go')]),
    msg('assistant', [call('bash', { command: 'env' }, 'b1'), call('read', { path: 'a.md' }, 'r1'), call('bash', { command: 'sleep' }, 'b2'), call('bash', { command: 'ls' }, 'b3'), call('bash', { command: 'false' }, 'b4')]),
    result('b1', 'bash', [text(DIRTY)]), result('r1', 'read', [text('FILE BODY OF A SECRET FILE')]),
    result('b3', 'bash', [text('x'.repeat(100)), { type: 'image', data: 'IMG' }, text('z\u0007'.repeat(300))]),
    result('b4', 'bash', [text('boom: it failed')], { isError: true }),
  ]);
}

async function withServer(fn) {
  const port = await new Promise((resolve) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const { port: p } = s.address(); s.close(() => resolve(p)); }); });
  const server = createServer(port, {});
  await new Promise((r) => server.listen(port, '127.0.0.1', r));
  const get = (p, token) => new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: p, headers: { host: `127.0.0.1:${port}`, ...(token ? { 'x-token': token } : {}) } }, (res) => {
      let d = ''; res.on('data', (c) => { d += c; }); res.on('end', () => resolve({ status: res.statusCode, text: d }));
    }).on('error', reject);
  });
  try {
    const token = /name="?token"? content="([0-9a-f]+)"/.exec((await get('/')).text)[1];
    await fn({ get, token });
  } finally { server.close(); server.closeAllConnections(); }
}
const result_ = (get, token, c, id = REPO_ID) => get(`/api/chat/result?id=${id}&call=${encodeURIComponent(c)}`, token);

// ---------- the switch in config.json ----------
test('config: chat.showResults survives a save, anything but true is false, other keys of chat are dropped, and no chat stays no chat', () => {
  writeConfig({ chat: { showResults: true, other: 'x' } });
  assert.deepEqual(loadConfig().chat, { showResults: true });
  saveConfig(loadConfig());
  assert.deepEqual(JSON.parse(fs.readFileSync(configFile, 'utf8')).chat, { showResults: true });
  for (const v of ['true', 1, null, 'yes', {}]) { writeConfig({ chat: { showResults: v } }); assert.deepEqual(loadConfig().chat, { showResults: false }, String(v)); }
  writeConfig({ chat: 'nope' });
  assert.deepEqual(loadConfig().chat, { showResults: false });
  writeConfig();
  assert.equal('chat' in loadConfig(), false);
});

// ---------- the cleaning ----------
test('abuse: a result full of secrets loses every one of them (lines of NAME=value, headers, URLs, tokens, key blocks)', () => {
  const out = redactText(DIRTY);
  for (const bad of ['hunter2x', TOKEN, TOKEN.slice(0, 12), AWS, 'MIIEow', 'postgres://u']) assert.ok(!out.includes(bad), `${bad} -> ${out}`);
  assert.match(out, /npm test ok/);
});

test('redactText: any uppercase NAME=value line loses its value, a lowercase or inline assignment is left to the patterns, and ordinary text stays', () => {
  assert.equal(redactText('FOO=bar\nNODE_ENV=production\nlowercase=value\nA=1'), 'FOO=[redacted]\nNODE_ENV=[redacted]\nlowercase=value\nA=[redacted]');
  assert.equal(redactText('  4 passing (12ms)\n  0 failing'), '  4 passing (12ms)\n  0 failing');
});

// ---------- the route ----------
test('off by default: the history is exactly as before (no results flag, no id on a chip) and the route answers 403 without looking at the session', async () => {
  writeConfig(); seed();
  await withServer(async ({ get, token }) => {
    const chat = JSON.parse((await get(`/api/chat?id=${REPO_ID}`, token)).text);
    assert.equal('results' in chat, false);
    assert.equal(chat.items[1].toolInfo.some((c) => 'id' in c), false);
    for (const c of ['b1', 'b3', 'nothing']) assert.equal((await result_(get, token, c)).status, 403);
  });
});

test('on: the history says results: true and its chips carry the call id; the route answers a result with only call, name, ok, text, truncated and size', async () => {
  writeConfig({ chat: { showResults: true } }); seed();
  await withServer(async ({ get, token }) => {
    const chat = JSON.parse((await get(`/api/chat?id=${REPO_ID}`, token)).text);
    assert.equal(chat.results, true);
    assert.deepEqual(chat.items[1].toolInfo.map((c) => c.id), ['b1', 'r1', 'b2', 'b3', 'b4']);
    const r = await result_(get, token, 'b4');
    assert.equal(r.status, 200);
    assert.deepEqual(JSON.parse(r.text), { call: 'b4', name: 'bash', ok: false, text: 'boom: it failed', truncated: false, size: 15 });
  });
});

test('on, abuse: what the route sends of a dirty result has no secret in it, in any field', async () => {
  writeConfig({ chat: { showResults: true } }); seed();
  await withServer(async ({ get, token }) => {
    const r = await result_(get, token, 'b1');
    assert.equal(r.status, 200);
    for (const bad of ['hunter2x', TOKEN, AWS, 'MIIEow']) assert.ok(!r.text.includes(bad), `${bad} -> ${r.text}`);
    assert.match(JSON.parse(r.text).text, /^npm test ok/);
  });
});

test('on: about 300 characters of the START, one cut mark, control characters and images gone', async () => {
  writeConfig({ chat: { showResults: true } }); seed();
  await withServer(async ({ get, token }) => {
    const r = JSON.parse((await result_(get, token, 'b3')).text);
    assert.equal(r.truncated, true);
    assert.ok(r.text.length <= RESULT_MAX + 1 && r.text.endsWith('…'), r.text.length);
    assert.ok(r.text.startsWith('x'.repeat(100)));
    assert.doesNotMatch(r.text, /[\u0000-\u0008\u000b-\u001f]|IMG/);
    assert.equal(r.size, 700);
  });
});

test('on: read is never shown, a call with no result yet or unknown is 404, a bad id is 400, a bad chat is 404, no token is 401, and nothing is written', async () => {
  writeConfig({ chat: { showResults: true } }); seed();
  const before = fs.readFileSync(configFile, 'utf8');
  await withServer(async ({ get, token }) => {
    assert.equal((await result_(get, token, 'r1')).status, 403);
    assert.equal((await result_(get, token, 'b2')).status, 404);
    assert.equal((await result_(get, token, 'ghost')).status, 404);
    for (const bad of ['', 'a b', '../x', 'x'.repeat(200)]) assert.equal((await result_(get, token, bad)).status, 400, bad);
    assert.equal((await result_(get, token, 'b1', 'nonexistent01')).status, 404);
    assert.equal((await result_(get, token, 'b1', 'room%3ANope')).status, 404);
    assert.equal((await get(`/api/chat/result?id=${REPO_ID}&call=b1`)).status, 401);
  });
  assert.equal(fs.readFileSync(configFile, 'utf8'), before);
});

// ---------- the page ----------
const ID = '0123456789';
const item = (chips) => ({ role: 'assistant', text: 'x', at: null, tools: chips.map((c) => c.name), toolInfo: chips });
const chip = (o) => ({ name: 'bash', ok: true, ms: 12, arg: 'ls', size: 500, id: 'b1', ...o });
const body = (items, extra = {}) => R.chatBody({ id: ID, info: { adopted: { id: 's1', name: 'panel:alpha' }, adoptedFound: true, sessions: [] }, hist: { found: true, items, truncated: false, ...(extra.results === undefined ? {} : { results: extra.results }) }, results: extra.map }, {});

test('page: a chip is a button only with the flag, an id, a result with something in it, and a tool that is not read', () => {
  const button = /<button type="button" class="tc ok res" data-act="chat-result" data-id="0123456789" data-call="b1" title="Show the start of the result">✓ <b>bash<\/b>/;
  assert.match(body([item([chip()])], { results: true }), button);
  for (const [name, html] of [
    ['no flag', body([item([chip()])])], ['flag false', body([item([chip()])], { results: false })],
    ['no id', body([item([chip({ id: undefined })])], { results: true })], ['read', body([item([chip({ name: 'read' })])], { results: true })],
    ['empty result', body([item([chip({ size: 0 })])], { results: true })], ['still running', body([item([chip({ ok: null, size: undefined })])], { results: true })],
  ]) assert.doesNotMatch(html, /data-act="chat-result"/, name);
  assert.match(body([item([chip()])]), /<span class="tc ok">✓ <b>bash<\/b>/);
});

test('page: the id is escaped and a strange one draws no button', () => {
  assert.doesNotMatch(body([item([chip({ id: 'a"><img onerror=1>' })])], { results: true }), /<img|data-call="a"/);
});

test('page: the result opens under the chips: loading, text (escaped), error; a chip with nothing asked draws nothing under it', () => {
  const html = (map) => body([item([chip()])], { results: true, map });
  assert.match(html({ b1: { state: 'loading' } }), /<div class="tresnote">Loading result…<\/div>/);
  assert.match(html({ b1: { state: 'ok', text: 'one\n<b>two</b>' } }), /<\/div><pre class="tres">one\n&lt;b&gt;two&lt;\/b&gt;<\/pre>/);
  assert.match(html({ b1: { state: 'error', error: 'Result viewing is off <x>' } }), /<div class="tresnote bad">Result viewing is off &lt;x&gt;<\/div>/);
  assert.doesNotMatch(html({}), /tres/);
  assert.doesNotMatch(html({ other: { state: 'ok', text: 'x' } }), /tres/);
});

// the real page, in a vm (fake fetch, no timers, no network)
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
  const fetches = [];
  const tabEls = ['summary', 'work', 'conformity'].map((t) => element({ dataset: { tab: t } }));
  const get = (sel) => (els[sel] ||= (sel === 'meta[name=token]' ? element({ content: 'token' }) : element()));
  const doc = { hidden: false, querySelector: get, querySelectorAll: (s) => (String(s).includes('data-tab') ? tabEls : []), addEventListener() {}, createElement: () => element(), body: element(), activeElement: null };
  const store = {};
  const ctx = vm.createContext({
    console, document: doc, location: { hash: '' }, TextDecoder, AbortController, confirm: () => true,
    localStorage: { getItem: (k) => (k in store ? store[k] : null), setItem(k, v) { store[k] = String(v); }, removeItem(k) { delete store[k]; } },
    requestAnimationFrame: (cb) => { frames.push(cb); return frames.length; }, setInterval: () => 0, setTimeout: () => 0, clearTimeout: () => {},
    fetch: (url, opts = {}) => {
      fetches.push({ url, method: opts.method || 'GET', body: opts.body });
      const a = Object.entries(answers).find(([k]) => url.startsWith(k));
      if (!a) return new Promise(() => {});
      return typeof a[1] === 'function' ? a[1](url, opts) : Promise.resolve({ ok: true, json: async () => a[1] });
    },
  });
  ctx.window = ctx;
  ctx.addEventListener = () => {};
  ctx.RepoPanelView = V;
  ctx.RepoPanelResumen = R;
  vm.runInContext(appSource(), ctx);
  const flush = () => { while (frames.length) frames.shift()(); };
  const tick = async (n = 8) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); flush(); };
  return { get, fetches, tick, run: (code) => vm.runInContext(code, ctx) };
}
const reply = (b) => Promise.resolve({ ok: true, json: async () => b });
const fail = (status, b) => Promise.resolve({ ok: false, status, statusText: 'Failed', json: async () => b });
const ADOPTED = { key: ID, adopted: { id: 's1', name: 'panel-demo', adoptedAt: 'x' }, adoptedFound: true, sessions: [], live: { state: 'none', count: 0 } };
const hist = (items, results = true) => ({ key: ID, sessionId: 's1', found: true, items, truncated: false, updatedAt: null, ...(results ? { results: true } : {}) });
async function chatPage(extra = {}) {
  const page = loadPage({
    ...extra, // the longer routes first: the fake fetch takes the first key the url starts with
    '/api/events': () => new Promise(() => {}), '/api/rpc/status': { state: 'closed', pendingDialogs: [], sessionId: 's1' },
    '/api/sessions': ADOPTED, '/api/chat': hist([item([chip()])]),
  });
  const st = page.run('S');
  st.groups = [{ name: 'G', repos: [{ id: ID, name: 'demo', path: 'p' }] }];
  st.summary = { rows: [], generatedAt: 'x' };
  page.run(`ACTIONS['chat-open']({ dataset: { id: '${ID}' } })`);
  await page.tick();
  return page;
}
const html = (page) => page.get('#chatBody').html;
const click = (page, c = 'b1') => page.run(`ACTIONS['chat-result']({ dataset: { call: '${c}' } })`);

test('page action: a click asks the route with the chat id and the call, shows the text, and a second click folds it', async () => {
  const page = await chatPage({ '/api/chat/result': () => reply({ call: 'b1', name: 'bash', ok: true, text: 'hello <b>', truncated: false, size: 9 }) });
  assert.match(html(page), /data-act="chat-result"/);
  await click(page); await page.tick();
  assert.deepEqual(page.fetches.filter((f) => f.url.startsWith('/api/chat/result')).map((f) => f.url), [`/api/chat/result?id=${ID}&call=b1`]);
  assert.match(html(page), /<pre class="tres">hello &lt;b&gt;<\/pre>/);
  await click(page); await page.tick();
  assert.doesNotMatch(html(page), /tres/);
});

test('page action: while it loads it says so and a second click does not ask again; an error shows its message and a click asks again', async () => {
  let resolve;
  const page = await chatPage({ '/api/chat/result': () => new Promise((r) => { resolve = r; }) });
  const p = click(page); await page.tick();
  assert.match(html(page), /Loading result…/);
  click(page); await page.tick();
  assert.equal(page.fetches.filter((f) => f.url.startsWith('/api/chat/result')).length, 1);
  resolve(fail(403, { error: 'Result viewing is off' })); await p; await page.tick();
  assert.match(html(page), /<div class="tresnote bad">Result viewing is off<\/div>/);
  click(page); await page.tick(); // not awaited: the fake answers this second ask never
  assert.equal(page.fetches.filter((f) => f.url.startsWith('/api/chat/result')).length, 2);
});

test('page action: an answer that arrives after the chat was closed is dropped, and opening another chat starts with nothing open', async () => {
  let resolve;
  const page = await chatPage({ '/api/chat/result': () => new Promise((r) => { resolve = r; }) });
  const p = click(page); await page.tick();
  page.run('closeChat()'); await page.tick();
  resolve(reply({ call: 'b1', name: 'bash', ok: true, text: 'late', truncated: false, size: 4 })); await p; await page.tick();
  assert.deepEqual(page.run('JSON.stringify(S.chatResults)'), '{}');
});
