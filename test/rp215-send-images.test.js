'use strict';
// RP215: images in the chat, the server part. A prompt, a follow-up or a steer may carry up to 4 images ({ data, mimeType } and nothing else), already shrunk by the page.
// Each one passes the checks of RP240 (png, jpeg, gif or webp, magic bytes that match the type, strict base64, at most 5 MB decoded) and goes to pi in the same RPC
// request; nothing is written to disk and no name from the client is ever used. Only the send routes take a body over 1 MB (up to 16 MB). The abuse tests come first.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'rp215-'));
const repoDir = path.join(scratch, 'repo');
fs.mkdirSync(repoDir);
process.env.REPO_PANEL_CONFIG = path.join(scratch, 'config.json');
process.env.REPO_PANEL_SESSIONS_DIR = path.join(scratch, 'sessions');
fs.writeFileSync(process.env.REPO_PANEL_CONFIG, JSON.stringify({ port: 4310, groups: [{ name: 'G', repos: [{ path: repoDir }] }] }));
test.after(() => fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 5 }));

const { createRpcHost } = require('../server/rpchost.js');
const { createServer } = require('../server/http.js');

const MAGIC = { 'image/png': [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 'image/jpeg': [0xff, 0xd8, 0xff, 0xe0], 'image/gif': [...Buffer.from('GIF89a')], 'image/webp': [...Buffer.from('RIFF'), 1, 2, 3, 4, ...Buffer.from('WEBPVP8 ')] };
const bytesOf = (type, size = 1024) => Buffer.concat([Buffer.from(MAGIC[type]), Buffer.alloc(Math.max(0, size - MAGIC[type].length), 7)]);
const img = (type = 'image/png', size = 1024, buf = bytesOf(type, size)) => ({ data: buf.toString('base64'), mimeType: type });

function hostWith() {
  const reqs = [];
  const client = { start: () => Promise.resolve({}), request(type, fields) { reqs.push([type, fields]); return Promise.resolve({ disposition: 'started' }); }, answerDialog: () => false, pendingDialogs: () => [], state: () => 'idle', close() {} };
  const host = createRpcHost({ resolve: async () => ({ active: { id: 'gs', command: 'gs', agentDir: scratch } }), repoOf: (id) => { if (id !== 'r1') { const e = new Error('Unknown repository'); e.status = 404; throw e; } return { id, path: repoDir }; }, publish: () => {}, createClient: () => client, adoptedOf: () => null });
  return { host, reqs };
}
const started = async () => { const h = hostWith(); await h.host.start('r1'); h.reqs.length = 0; return h; };
const refused = (status) => (e) => e.status === status;

// Every fs call that could write, counted while `fn` runs.
async function writesDuring(fn) {
  const names = ['writeFileSync', 'writeFile', 'appendFileSync', 'appendFile', 'createWriteStream', 'mkdirSync', 'mkdir', 'openSync', 'copyFileSync', 'renameSync'];
  const saved = names.map((n) => fs[n]);
  const savedP = fs.promises.writeFile;
  let n = 0;
  names.forEach((k, i) => { fs[k] = (...a) => { if (k !== 'openSync' || /[wa+]/.test(String(a[1] || 'r'))) n++; return saved[i](...a); }; });
  fs.promises.writeFile = (...a) => { n++; return savedP(...a); };
  try { await fn(); } finally { names.forEach((k, i) => { fs[k] = saved[i]; }); fs.promises.writeFile = savedP; }
  return n;
}

// ---------- abuse first: the host ----------
test('abuse: a bad images value is refused before anything reaches pi, with prompt, follow-up and steer alike', async () => {
  const { host, reqs } = await started();
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
  const cases = [
    [400, 'x'], [400, 5], [400, null], [400, {}], [400, { data: 'x', mimeType: 'image/png' }],
    [400, [img(), img(), img(), img(), img()]], // more than 4
    [400, ['iVBOR']], [400, [null]], [400, [[]]],
    [400, [{ ...img(), name: '../../evil.png' }]], [400, [{ ...img(), path: 'C:\\x' }]], [400, [{ ...img(), type: 'image' }]], // nothing but data and mimeType
    [415, [{ data: img().data }]], [415, [{ mimeType: 'image/png' }]], [415, [{ data: 42, mimeType: 'image/png' }]],
    [415, [img('image/png', 0, bytesOf('image/jpeg'))]], // fake type
    [415, [img('image/svg+xml', 0, svg)]], [415, [img('text/html', 0, Buffer.from('<script>alert(1)</script>'))]], [415, [{ ...img(), mimeType: '__proto__' }]],
    [415, [{ data: 'iVBORw0K<script>', mimeType: 'image/png' }]], [415, [{ data: `${img().data}A`, mimeType: 'image/png' }]], // broken base64
    [413, [img('image/png', 5 * 1024 * 1024 + 1)]], // over 5 MB decoded
  ];
  for (const [status, images] of cases) {
    for (const send of [() => host.prompt('r1', 'look', { images }), () => host.prompt('r1', 'look', { behavior: 'followUp', images }), () => host.steer('r1', 'look', { images })]) {
      await assert.rejects(send, refused(status), `${status} ${JSON.stringify(images).slice(0, 60)}`);
    }
  }
  assert.deepEqual(reqs, [], 'nothing reached pi');
});

test('abuse: text rules still hold with images: a ! command is refused, and an empty text needs at least one image', async () => {
  const { host, reqs } = await started();
  await assert.rejects(host.prompt('r1', '!rm -rf .', { images: [img()] }), refused(400));
  await assert.rejects(host.prompt('r1', '', { images: [] }), refused(400));
  await assert.rejects(host.prompt('r1', '   '), refused(400));
  await assert.rejects(host.prompt('r1', 5, { images: [img()] }), refused(400));
  await assert.rejects(host.prompt('r1', '/gentle:yolo', { images: [img()] }), refused(409));
  assert.deepEqual(reqs, []);
});

test('abuse: nothing is written to disk, whether the images are refused or sent', async () => {
  const { host } = await started();
  const n = await writesDuring(async () => {
    await host.prompt('r1', 'look', { images: [img('image/jpeg', 200 * 1024), img('image/webp')] });
    await host.steer('r1', 'now', { images: [img('image/gif')] });
    await assert.rejects(host.prompt('r1', 'x', { images: [{ ...img(), name: '../a.png' }] }));
    await assert.rejects(host.prompt('r1', 'x', { images: [img('image/png', 0, bytesOf('image/jpeg'))] }));
  });
  assert.equal(n, 0);
});

// ---------- what goes to pi ----------
test('send: valid images go to pi in the same request as { type, data, mimeType }, in order, the data untouched; no images, no field', async () => {
  const { host, reqs } = await started();
  const types = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
  const images = types.map((t) => img(t, 3000));
  const sent = types.map((t, i) => ({ type: 'image', data: images[i].data, mimeType: t }));
  await host.prompt('r1', '  see these  ', { images });
  await host.prompt('r1', 'and this', { behavior: 'followUp', images: [images[0]] });
  await host.steer('r1', 'stop, look', { images: [images[3]] });
  await host.prompt('r1', '', { images: [images[1]] }); // an image with no text
  await host.prompt('r1', 'plain');
  await host.steer('r1', 'plain steer');
  await host.prompt('r1', 'empty list', { images: [] });
  await host.prompt('r1', 'exactly 5 MB', { images: [img('image/png', 5 * 1024 * 1024)] });
  assert.deepEqual(reqs.slice(0, 7), [
    ['prompt', { message: 'see these', images: sent }],
    ['prompt', { message: 'and this', streamingBehavior: 'followUp', images: [sent[0]] }],
    ['steer', { message: 'stop, look', images: [sent[3]] }],
    ['prompt', { message: '', images: [sent[1]] }],
    ['prompt', { message: 'plain' }],
    ['steer', { message: 'plain steer' }],
    ['prompt', { message: 'empty list' }],
  ]);
  assert.equal(reqs[7][1].images[0].data.length, Math.ceil((5 * 1024 * 1024) / 3) * 4);
});

// ---------- the HTTP routes ----------
async function withServer(fn) {
  const calls = [];
  const rpcHost = { prompt: async (id, text, opts) => { calls.push(['prompt', id, text, opts]); return { ok: true }; }, steer: async (id, text, opts) => { calls.push(['steer', id, text, opts]); return { ok: true }; }, abort: async (id) => { calls.push(['abort', id]); return { ok: true }; }, closeAll() {} };
  const port = await new Promise((resolve) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const { port: p } = s.address(); s.close(() => resolve(p)); }); });
  const server = createServer(port, { rpcHost, noSummaryStore: true });
  await new Promise((r) => server.listen(port, '127.0.0.1', r));
  const request = (method, p, body, token) => new Promise((resolve, reject) => {
    const data = body === undefined ? null : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
    const req = http.request({ host: '127.0.0.1', port, path: p, method, headers: { host: `127.0.0.1:${port}`, 'content-type': 'application/json', ...(token ? { 'x-token': token } : {}) } }, (res) => {
      const parts = []; res.on('data', (c) => parts.push(c)); res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(parts).toString() }));
    });
    req.on('error', (e) => resolve({ status: 0, error: e.code }));
    if (data) req.write(data);
    req.end();
  });
  try {
    const token = /name="?token"? content="([0-9a-f]+)"/.exec((await request('GET', '/')).text)[1];
    await fn({ post: (p, b, t = token) => request('POST', p, b, t), calls, token });
  } finally { server.close(); server.closeAllConnections(); }
}

test('routes: prompt and steer take a body up to 16 MB with images; over it is 413 and the host is never called; other routes keep 1 MB; no token, nothing', async () => {
  await withServer(async ({ post, calls }) => {
    const big = img('image/jpeg', 4 * 1024 * 1024); // about 5.6 MB of JSON
    assert.equal((await post('/api/rpc/prompt', { id: 'r1', text: 'big', images: [big] })).status, 200);
    assert.equal((await post('/api/rpc/steer', { id: 'r1', text: 'big', images: [big] })).status, 200);
    assert.equal((await post('/api/rpc/prompt', { id: 'r1', text: 'b', behavior: 'followUp', images: [big] })).status, 200);
    assert.deepEqual(calls.map((c) => [c[0], c[2], c[3]]), [['prompt', 'big', { images: [big] }], ['steer', 'big', { images: [big] }], ['prompt', 'b', { behavior: 'followUp', images: [big] }]]);
    calls.length = 0;
    const huge = 'x'.repeat(17 * 1024 * 1024);
    const r = await post('/api/rpc/prompt', { id: 'r1', text: 'x', images: [{ data: huge, mimeType: 'image/png' }] });
    assert.ok(r.status === 413 || r.status === 0, `status ${r.status}`);
    const other = await post('/api/rpc/abort', { id: 'r1', pad: 'x'.repeat(2 * 1024 * 1024) });
    assert.ok(other.status === 413 || other.status === 0, `status ${other.status}`);
    assert.equal((await post('/api/rpc/prompt', { id: 'r1', text: 'x', images: [big] }, null)).status, 401);
    assert.deepEqual(calls, []);
    assert.equal((await post('/api/rpc/prompt', { id: 'r1', text: 'plain' })).status, 200);
    assert.deepEqual(calls.at(-1), ['prompt', 'r1', 'plain', {}], 'a send with no images is exactly as before');
  });
});

// ---------- found by the independent verification (pins, they passed at once) ----------
test('abuse: prototype tricks and odd lists are refused before pi; images:null is refused, not ignored', async () => {
  const { host, reqs } = await started();
  const ok = img();
  const bad = [
    [400, JSON.parse(`[{"data":"${ok.data}","mimeType":"image/png","__proto__":{"x":1}}]`)],
    [400, JSON.parse(`[{"__proto__":{"data":"${ok.data}","mimeType":"image/png"}}]`)],
    [400, null], [400, { length: 1, 0: ok }], [400, new Array(1e6).fill(0)],
    [415, [{ ...ok, mimeType: 'constructor' }]], [415, [{ ...ok, mimeType: 'toString' }]], [415, [{ ...ok, mimeType: 'IMAGE/PNG' }]],
    [415, [{ ...ok, data: `data:image/png;base64,${ok.data}` }]], [415, [{ ...ok, data: `${ok.data.slice(0, 8)}\n${ok.data.slice(8)}` }]],
  ];
  for (const [status, images] of bad) {
    await assert.rejects(host.prompt('r1', 'x', { images }), refused(status));
    await assert.rejects(host.steer('r1', 'x', { images }), refused(status));
  }
  assert.deepEqual(reqs, []);
});

test('text rules: with images, a text of only controls is sent as "" but a missing text, /foo while busy and a bad behavior are refused', async () => {
  const { host, reqs } = await started();
  await host.steer('r1', '\u200b\r\n\t', { images: [img()] });
  assert.equal(reqs.at(-1)[1].message, '');
  reqs.length = 0;
  await assert.rejects(host.prompt('r1', undefined, { images: [img()] }), refused(400));
  await assert.rejects(host.prompt('r1', '/foo', { behavior: 'followUp', images: [img()] }), refused(409));
  await assert.rejects(host.prompt('r1', 'x', { behavior: 'now', images: [img()] }), refused(400));
  await assert.rejects(host.steer('r1', '/gentle:yolo:2', { images: [img()] }), refused(409));
  assert.deepEqual(reqs, []);
});
