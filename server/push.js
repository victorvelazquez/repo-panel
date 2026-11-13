'use strict';
// RP179: Web Push with no library. push.json (next to config.json, ignored by Git) holds the VAPID key pair and the subscribed devices; the private key never
// leaves this file. A push carries NO body: it only wakes the service worker, which asks POST /push/pending for the text (kept here, a few minutes). The server
// only ever sends to the push services of the big browsers, so a subscription cannot make it request any URL.
const crypto = require('node:crypto');
const fs = require('node:fs');
const https = require('node:https');
const path = require('node:path');

const SERVICES = ['web.push.apple.com', 'fcm.googleapis.com', 'notify.windows.com', 'push.services.mozilla.com'];
const MAX_DEVICES = 20;
const MAX_PENDING = 10;
const PENDING_MS = 10 * 60 * 1000;
const FALLBACK_SUB = 'mailto:repo-panel@example.com'; // never the person's own address

const b64u = (buf) => Buffer.from(buf).toString('base64url');

function validEndpoint(endpoint) {
  if (typeof endpoint !== 'string' || endpoint.length === 0 || endpoint.length > 2048) return false;
  let u;
  try { u = new URL(endpoint); } catch { return false; }
  if (u.protocol !== 'https:' || u.username || u.password || u.port) return false;
  return SERVICES.some((d) => u.hostname === d || u.hostname.endsWith(`.${d}`));
}

function createPushStore({ file, now = Date.now } = {}) {
  let data = null;
  const pending = new Map(); // endpoint -> [{ id, kind, title, body, at }], in memory only
  const save = () => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(`${file}.tmp`, JSON.stringify(data, null, 2), { mode: 0o600 });
    fs.renameSync(`${file}.tmp`, file);
  };
  function load() {
    if (data) return data;
    try { data = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { data = null; }
    if (!data || typeof data !== 'object' || !data.vapid || typeof data.vapid.publicKey !== 'string' || !data.vapid.d) {
      const jwk = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({ format: 'jwk' });
      data = { vapid: { publicKey: b64u(Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x, 'base64url'), Buffer.from(jwk.y, 'base64url')])), d: jwk.d }, subs: [] };
      save();
    }
    if (!Array.isArray(data.subs)) data.subs = [];
    return data;
  }
  const fresh = (list) => list.filter((n) => now() - n.at <= PENDING_MS);
  return {
    vapid: () => ({ ...load().vapid }),
    list: () => load().subs.map((s) => s.endpoint),
    count: () => load().subs.length,
    add(sub) {
      const d = load();
      if (!sub || !validEndpoint(sub.endpoint)) return false;
      if (d.subs.some((s) => s.endpoint === sub.endpoint)) return true;
      if (d.subs.length >= MAX_DEVICES) return false;
      d.subs.push({ endpoint: sub.endpoint });
      save();
      return true;
    },
    remove(endpoint) {
      const d = load();
      const n = d.subs.length;
      d.subs = d.subs.filter((s) => s.endpoint !== endpoint);
      pending.delete(endpoint);
      if (d.subs.length === n) return false;
      save();
      return true;
    },
    queue(notice) {
      const entry = { id: notice.id, kind: notice.kind, title: notice.title, body: notice.body, at: now() };
      for (const s of load().subs) pending.set(s.endpoint, fresh([...(pending.get(s.endpoint) || []), entry]).slice(-MAX_PENDING));
    },
    take(endpoint) {
      const list = fresh(pending.get(endpoint) || []);
      pending.delete(endpoint);
      return list.map(({ id, kind, title, body }) => ({ id, kind, title, body }));
    },
  };
}

// The Authorization header: an ES256 JWT for the origin of the endpoint, valid 12 hours, and the public key.
function vapidHeader(keys, endpoint, { now = Date.now(), sub = FALLBACK_SUB } = {}) {
  const raw = Buffer.from(keys.publicKey, 'base64url');
  const key = crypto.createPrivateKey({ key: { kty: 'EC', crv: 'P-256', x: b64u(raw.subarray(1, 33)), y: b64u(raw.subarray(33)), d: keys.d }, format: 'jwk' });
  const text = `${b64u(JSON.stringify({ typ: 'JWT', alg: 'ES256' }))}.${b64u(JSON.stringify({ aud: new URL(endpoint).origin, exp: Math.floor(now / 1000) + 12 * 3600, sub }))}`;
  const sig = crypto.sign('sha256', Buffer.from(text), { key, dsaEncoding: 'ieee-p1363' });
  return `vapid t=${text}.${b64u(sig)}, k=${keys.publicKey}`;
}

// The real sender: one empty POST, 10 seconds at most; the answer is drained and only its status matters.
function post(endpoint, headers) {
  return new Promise((resolve, reject) => {
    const req = https.request(endpoint, { method: 'POST', headers, timeout: 10000 }, (res) => { res.resume(); res.on('end', () => resolve({ status: res.statusCode })); });
    req.on('timeout', () => req.destroy(new Error('Push service timed out')));
    req.on('error', reject);
    req.end();
  });
}

// `sub` is the VAPID contact: a string or a function read on every push (the remote host can change).
function createPusher({ store, post: send = post, now = Date.now, sub } = {}) {
  async function pushTo(endpoint) {
    if (!validEndpoint(endpoint)) return false; // push.json can be edited by hand: the list is checked again at the moment of sending
    try {
      const contact = (typeof sub === 'function' ? sub() : sub) || FALLBACK_SUB;
      const headers = { Authorization: vapidHeader(store.vapid(), endpoint, { now: now(), sub: contact }), TTL: '600', Urgency: 'high', 'Content-Length': '0' };
      const { status } = await send(endpoint, headers);
      if (status === 404 || status === 410) store.remove(endpoint);
      return status >= 200 && status < 300;
    } catch { return false; }
  }
  const fanOut = async (notice) => {
    const devices = store.list();
    store.queue(notice);
    return (await Promise.all(devices.map(pushTo))).filter(Boolean).length;
  };
  return {
    store,
    notify: (id, notice) => fanOut({ id, kind: notice.kind, title: notice.title, body: notice.body }).then(() => undefined, () => undefined),
    test: () => fanOut({ id: '0000000000', kind: 'test', title: 'Repo Panel', body: 'This is a test push' }).catch(() => 0),
  };
}

module.exports = { validEndpoint, createPushStore, vapidHeader, createPusher, post };
