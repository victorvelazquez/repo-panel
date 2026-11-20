'use strict';
// RP240: a chat history that survives images. pi keeps each image in base64 inside the session file (118 to 262 KB per line), so a byte window pushed the text out.
// The reader now counts messages from the END of the file (with a byte ceiling), never keeps the base64 of an image, and the listing keeps its last message behind a huge line.
// The images of a USER message are served one at a time by GET /api/chat/image, from the adopted session only, with a closed list of types whose magic bytes must match.
// The abuse tests come first. Temp dirs only: the real sessions are never touched.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'rp240-'));
const sessionsBase = path.join(scratch, 'sessions');
const repoDir = path.join(scratch, 'My Repo.Api');
const otherDir = path.join(scratch, 'Other');
for (const d of [sessionsBase, repoDir, otherDir]) fs.mkdirSync(d);
const configFile = path.join(scratch, 'config.json');
process.env.REPO_PANEL_CONFIG = configFile;
process.env.REPO_PANEL_SESSIONS_DIR = sessionsBase;
test.after(() => fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 5 }));

const lib = require('../lib.js');
const S = require('../server/sessions.js');
const { createServer } = require('../server/http.js');
const R = require('../public/resumen.js');

const REPO_ID = lib.repoId(repoDir);
const OTHER_ID = lib.repoId(otherDir);
const writeConfig = (sessions = { [REPO_ID]: { id: 's1', name: 'panel:x', adoptedAt: '2026-10-28T10:00:00.000Z' }, [OTHER_ID]: { id: 'o1', name: 'panel:o', adoptedAt: '2026-10-28T10:00:00.000Z' } }) => fs.writeFileSync(configFile, JSON.stringify({ port: 4310, groups: [{ name: 'G', repos: [{ path: repoDir }, { path: otherDir }] }], sessions }));

const header = (id, cwd) => JSON.stringify({ type: 'session', version: 3, id, timestamp: '2026-10-28T10:00:00.000Z', cwd });
const text = (t) => ({ type: 'text', text: t });
let seq = 0;
const msg = (role, content, extra = {}, id = `e${++seq}`) => JSON.stringify({ type: 'message', id, timestamp: '2026-10-28T14:00:00.000Z', message: { role, content, timestamp: Date.parse('2026-10-28T14:00:00Z'), ...extra } });
const MAGIC = { 'image/png': [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 'image/jpeg': [0xff, 0xd8, 0xff, 0xe0], 'image/gif': [...Buffer.from('GIF89a')], 'image/webp': [...Buffer.from('RIFF'), 1, 2, 3, 4, ...Buffer.from('WEBPVP8 ')] };
const bytesOf = (type, kb = 1) => Buffer.concat([Buffer.from(MAGIC[type]), Buffer.alloc(kb * 1024, 7)]);
const image = (type = 'image/png', kb = 1, buf = bytesOf(type, kb)) => ({ type: 'image', data: buf.toString('base64'), mimeType: type });
function putSession(folder, id, lines) {
  const dir = S.sessionsDirFor(folder, sessionsBase);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `2026-10-28T10-00-00-000Z_${id}.jsonl`), lines.join('\n') + '\n');
}
const chatOf = (id, opts) => S.readChat(repoDir, id, { base: sessionsBase, ...opts });

async function withServer(fn) {
  const port = await new Promise((resolve) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const { port: p } = s.address(); s.close(() => resolve(p)); }); });
  const server = createServer(port, {});
  await new Promise((r) => server.listen(port, '127.0.0.1', r));
  const get = (p, token, host = `127.0.0.1:${port}`) => new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: p, headers: { host, ...(token ? { 'x-token': token } : {}) } }, (res) => {
      const parts = []; res.on('data', (c) => parts.push(c)); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(parts) }));
    }).on('error', reject);
  });
  try {
    const token = /name="?token"? content="([0-9a-f]+)"/.exec((await get('/')).body.toString())[1];
    await fn({ get, token, port });
  } finally { server.close(); server.closeAllConnections(); }
}
const imageUrl = (entry, n = 0, id = REPO_ID) => `/api/chat/image?id=${encodeURIComponent(id)}&entry=${encodeURIComponent(entry)}&n=${encodeURIComponent(n)}`;

// ---------- abuse first: the route ----------
test('abuse: an image whose bytes do not match its type, an SVG, an HTML or an unknown type, or broken base64, is refused and nothing else is served', async () => {
  writeConfig();
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
  putSession(repoDir, 's1', [header('s1', repoDir),
    msg('user', [image('image/png', 1, bytesOf('image/jpeg'))], {}, 'fake'),
    msg('user', [image('image/svg+xml', 1, svg)], {}, 'svg'),
    msg('user', [image('text/html', 1, Buffer.from('<script>alert(1)</script>'))], {}, 'html'),
    msg('user', [{ type: 'image', data: 'iVBORw0K<script>', mimeType: 'image/png' }], {}, 'b64bad'),
    msg('user', [{ type: 'image', data: `${bytesOf('image/png').toString('base64')}A`, mimeType: 'image/png' }], {}, 'b64len'),
    msg('user', [{ type: 'image', data: 42, mimeType: 'image/png' }], {}, 'b64num'),
    msg('user', [{ type: 'image', data: bytesOf('image/png').toString('base64') }], {}, 'notype'),
  ]);
  await withServer(async ({ get, token }) => {
    for (const e of ['fake', 'svg', 'html', 'b64bad', 'b64len', 'b64num', 'notype']) {
      const r = await get(imageUrl(e), token);
      assert.equal(r.status, 415, e);
      assert.match(r.headers['content-type'], /^application\/json/, e);
      assert.ok(!r.body.toString().includes('<s'), e);
    }
  });
});

test('abuse: no token, another host, a bad entry or index, an entry of another repo, an image of a tool result and an unknown repo get nothing', async () => {
  writeConfig();
  putSession(repoDir, 's1', [header('s1', repoDir), msg('user', [text('look'), image()], {}, 'ok1'),
    msg('toolResult', [text('Read image file'), image()], { toolCallId: 'r1', toolName: 'read', isError: false }, 'tool1')]);
  putSession(otherDir, 'o1', [header('o1', otherDir), msg('user', [image()], {}, 'oth1')]);
  await withServer(async ({ get, token, port }) => {
    assert.equal((await get(imageUrl('ok1'), token)).status, 200);
    assert.equal((await get(imageUrl('ok1'))).status, 401);
    assert.equal((await get(imageUrl('ok1'), 'wrong')).status, 401);
    assert.equal((await get(imageUrl('ok1'), token, `evil.example:${port}`)).status, 403);
    for (const e of ['', '../ok1', '..\\ok1', 'ok1/../x', 'a'.repeat(41), 'ok 1', '%2e%2e']) assert.equal((await get(imageUrl(e), token)).status, 400, `entry ${e}`);
    for (const n of ['', '-1', '1.5', 'x', '1e1', '999', '0x0']) assert.equal((await get(imageUrl('ok1', n), token)).status, 400, `n ${n}`);
    assert.equal((await get(imageUrl('ok1', 1), token)).status, 404); // one image only
    assert.equal((await get(imageUrl('nothere'), token)).status, 404);
    assert.equal((await get(imageUrl('tool1'), token)).status, 404); // a file the agent read is never served
    assert.equal((await get(imageUrl('oth1'), token)).status, 404); // repo A never serves the session of repo B
    assert.equal((await get(imageUrl('ok1', 0, 'nope'), token)).status, 404);
  });
});

test('abuse: an image larger than the cap is refused (413) and a repo with no adopted session has no images', async () => {
  writeConfig({ [REPO_ID]: { id: 's1', name: 'panel:x', adoptedAt: '2026-10-28T10:00:00.000Z' } });
  putSession(repoDir, 's1', [header('s1', repoDir), msg('user', [image('image/png', 5 * 1024 + 256)], {}, 'big')]);
  putSession(otherDir, 'o1', [header('o1', otherDir), msg('user', [image()], {}, 'oth1')]);
  await withServer(async ({ get, token }) => {
    assert.equal((await get(imageUrl('big'), token)).status, 413);
    assert.equal((await get(imageUrl('oth1', 0, OTHER_ID), token)).status, 404);
  });
});

test('route: each allowed type is served as it is, with its own fixed type, nosniff, no-store and a sandbox', async () => {
  writeConfig();
  const types = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
  putSession(repoDir, 's1', [header('s1', repoDir), msg('user', [text('four'), ...types.map((t) => image(t, 3))], {}, 'four')]);
  await withServer(async ({ get, token }) => {
    for (const [n, t] of types.entries()) {
      const r = await get(imageUrl('four', n), token);
      assert.equal(r.status, 200, t);
      assert.equal(r.headers['content-type'], t);
      assert.equal(r.headers['x-content-type-options'], 'nosniff');
      assert.equal(r.headers['cache-control'], 'no-store');
      assert.match(r.headers['content-security-policy'], /sandbox/);
      assert.deepEqual(r.body, bytesOf(t, 3));
    }
  });
});

// ---------- the reader ----------
test('history: five recent images of 250 KB no longer push the earlier text out; each user image is counted, never its base64', () => {
  putSession(repoDir, 'h1', [header('h1', repoDir), msg('user', [text('EARLY')]), msg('assistant', [text('ANSWER')]),
    ...Array.from({ length: 5 }, (_, i) => msg('user', [text(`shot ${i}`), image('image/png', 250)], {}, `img${i}`)),
    msg('user', [image('image/jpeg', 2)], {}, 'only')]);
  const r = chatOf('h1');
  assert.deepEqual(r.items.map((i) => i.text), ['EARLY', 'ANSWER', 'shot 0', 'shot 1', 'shot 2', 'shot 3', 'shot 4', '']);
  assert.deepEqual(r.items.slice(2).map((i) => [i.images, i.entry]), [[1, 'img0'], [1, 'img1'], [1, 'img2'], [1, 'img3'], [1, 'img4'], [1, 'only']]);
  assert.equal(r.truncated, false);
  assert.equal('images' in r.items[0], false);
  assert.ok(JSON.stringify(r).length < 4000, 'no base64 in the answer');
});

test('history: the images of a tool result are no item and never travel; a user entry with a strange id keeps its images without a reference', () => {
  putSession(repoDir, 'h2', [header('h2', repoDir), msg('user', [text('go')]), msg('assistant', [{ type: 'toolCall', id: 'r1', name: 'read', arguments: { path: 'a.png' } }]),
    msg('toolResult', [text('Read image'), image('image/png', 300)], { toolCallId: 'r1', toolName: 'read', isError: false }), msg('assistant', [text('done')]),
    msg('user', [text('weird'), image()], {}, 'x"><img src=x>')]);
  const r = chatOf('h2');
  assert.deepEqual(r.items.map((i) => i.text), ['go', 'done', 'weird']);
  assert.equal(r.items[2].images, 1);
  assert.equal('entry' in r.items[2], false);
  assert.ok(JSON.stringify(r).length < 3000);
});

test('history: the limit counts messages (the last 30 by default, at most 100) and says truncated when older ones exist', () => {
  putSession(repoDir, 'h3', [header('h3', repoDir), ...Array.from({ length: 150 }, (_, i) => msg('user', [text(`m${i}`)]))]);
  const r = chatOf('h3');
  assert.equal(r.items.length, 30);
  assert.equal(r.items[0].text, 'm120');
  assert.equal(r.truncated, true);
  assert.equal(chatOf('h3', { limit: 500 }).items.length, 100);
  putSession(repoDir, 'h4', [header('h4', repoDir), ...Array.from({ length: 5 }, (_, i) => msg('user', [text(`m${i}`)]))]);
  assert.deepEqual(chatOf('h4'), { ...chatOf('h4'), truncated: false });
  assert.equal(chatOf('h4').items.length, 5);
});

test('history: a 20 MB file that is one line, or only images, is read up to a ceiling and answers fast', () => {
  const dir = S.sessionsDirFor(repoDir, sessionsBase);
  fs.writeFileSync(path.join(dir, '2026-10-28T10-00-00-000Z_big.jsonl'), `${header('big', repoDir)}\n${'x'.repeat(20 * 1024 * 1024)}`);
  let t0 = Date.now();
  const r = chatOf('big');
  assert.ok(Date.now() - t0 < 2000);
  assert.deepEqual([r.found, r.items, r.truncated], [true, [], true]);
  putSession(repoDir, 'imgs', [header('imgs', repoDir), msg('user', [text('LOST')]), ...Array.from({ length: 80 }, () => msg('user', [image('image/png', 250)]))]);
  t0 = Date.now();
  const q = chatOf('imgs');
  assert.ok(Date.now() - t0 < 2000);
  assert.equal(q.truncated, true);
  assert.ok(q.items.length > 5 && q.items.every((i) => i.images === 1));
});

test('listing: the last message survives a final line of 300 KB, and a short file reads as before', () => {
  putSession(repoDir, 'l1', [header('l1', repoDir), msg('user', [text('LAST QUESTION')]),
    msg('toolResult', [text('Read image'), image('image/png', 300)], { toolCallId: 'r1', toolName: 'read', isError: false })]);
  putSession(repoDir, 'l2', [header('l2', repoDir), JSON.stringify({ type: 'session_info', name: 'Named' }), msg('assistant', [text('short')])]);
  const list = S.listSessions(repoDir, { base: sessionsBase });
  const l1 = list.find((s) => s.id === 'l1');
  const l2 = list.find((s) => s.id === 'l2');
  assert.deepEqual(l1.lastMessage, { role: 'user', text: 'LAST QUESTION' });
  assert.deepEqual([l2.name, l2.lastMessage], ['Named', { role: 'assistant', text: 'short' }]);
});

// ---------- the page ----------
test('page: a user message with images draws one frame per image (at most 8), the loaded one as an <img> of its blob address, and escapes everything', () => {
  const body = (items, imgs) => R.chatBody({ id: 'r1', info: { adopted: { id: 's1', name: 'panel:a' }, adoptedFound: true, sessions: [] }, hist: { found: true, items, truncated: false } }, { now: Date.now(), imgs });
  const html = body([{ role: 'user', text: 'see', at: null, tools: [], images: 2, entry: 'e1' }], { 'e1/0': 'blob:http://127.0.0.1/abc' });
  assert.equal((html.match(/class="m-img/g) || []).length, 2);
  assert.match(html, /<img src="blob:http:\/\/127\.0\.0\.1\/abc" alt="Image"/);
  assert.match(html, /data-img-entry="e1" data-img-n="1"/);
  const many = body([{ role: 'user', text: '', at: null, tools: [], images: 50, entry: 'e2' }], {});
  assert.equal((many.match(/class="m-img/g) || []).length, 8);
  const hostile = body([{ role: 'user', text: 'x', at: null, tools: [], images: 1, entry: '"><b>' }], { '"><b>/0': 'javascript:alert(1)' });
  assert.ok(!hostile.includes('<b>') && !hostile.includes('javascript:'));
  const noRef = body([{ role: 'user', text: 'x', at: null, tools: [], images: 1 }], {});
  assert.match(noRef, /class="m-img[^"]*"[^>]*>Image</);
  assert.ok(!noRef.includes('data-img-entry'));
  for (const bad of [0, -1, '2', 1.5, null]) assert.ok(!body([{ role: 'user', text: 'x', at: null, tools: [], images: bad, entry: 'e' }], {}).includes('m-img'), String(bad));
});

// ---------- found by the independent verification ----------
test('listing: a session_info written mid-file, before the last messages, still names the session', () => {
  writeConfig();
  putSession(repoDir, 'named', [header('named', repoDir),
    msg('assistant', [text('x'.repeat(100000))]), msg('user', [text('y'.repeat(60000))]),
    JSON.stringify({ type: 'session_info', name: 'Renamed later' }),
    msg('user', [text('hi')]), msg('assistant', [text('ok')])]);
  const s = S.listSessions(repoDir, { base: sessionsBase }).find((x) => x.id === 'named');
  assert.equal(s.name, 'Renamed later');
  assert.equal(s.lastMessage.text, 'ok');
});

test('abuse: an image of 5 MB + 1 byte is 413; exactly 5 MB is served', async () => {
  writeConfig();
  const png = (n) => Buffer.concat([Buffer.from(MAGIC['image/png']), Buffer.alloc(n - 8, 7)]);
  putSession(repoDir, 's1', [header('s1', repoDir), msg('user', [image('image/png', 0, png(5 * 1024 * 1024))], {}, 'exact5')]);
  putSession(otherDir, 'o1', [header('o1', otherDir), msg('user', [image('image/png', 0, png(5 * 1024 * 1024 + 1))], {}, 'over5')]);
  await withServer(async ({ get, token }) => {
    assert.equal((await get(imageUrl('exact5'), token)).status, 200);
    const r = await get(imageUrl('over5', 0, OTHER_ID), token);
    assert.equal(r.status, 413);
    assert.match(r.headers['content-type'], /^application\/json/);
  });
});
