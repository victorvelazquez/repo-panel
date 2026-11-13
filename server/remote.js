'use strict';
// RP177: remote access. `remote: { host, secret }` in config.json lets the panel also answer to one more Host (Tailscale Serve, which reaches us from
// 127.0.0.1) behind a one-time login. The login leaves a signed cookie with no server state: it survives a restart and changing the secret ends every
// session. 127.0.0.1 and localhost never need it. A host without a usable secret is not served at all.
const crypto = require('node:crypto');

const COOKIE = 'rp_session';
const SESSION_MS = 180 * 24 * 3600 * 1000;
const SECRET_MIN = 16;
const HOST_RE = /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?(:\d{1,5})?$/;

// The usable remote access of a config, or null (no host, a malformed one, or a secret shorter than SECRET_MIN).
function remoteOf(cfg) {
  const r = cfg && cfg.remote;
  if (!r || typeof r.host !== 'string' || typeof r.secret !== 'string') return null;
  return HOST_RE.test(r.host) && r.secret.length >= SECRET_MIN ? { host: r.host, secret: r.secret } : null;
}

const mac = (secret, text) => crypto.createHmac('sha256', secret).update(text).digest('hex');
const same = (a, b) => { const x = Buffer.from(String(a)); const y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };

const signSession = (secret, now = Date.now()) => { const exp = now + SESSION_MS; return `v1.${exp}.${mac(secret, `v1.${exp}`)}`; };

function verifySession(secret, value, now = Date.now()) {
  const m = /^v1\.(\d{1,15})\.([0-9a-f]{64})$/.exec(typeof value === 'string' ? value : '');
  return !!m && Number(m[1]) > now && same(m[2], mac(secret, `v1.${m[1]}`));
}

// Compares through a hash so the length of the secret never leaks and the comparison takes the same time.
const secretOk = (given, secret) => typeof given === 'string' && same(crypto.createHash('sha256').update(given).digest('hex'), crypto.createHash('sha256').update(secret).digest('hex'));

// After `max` wrong secrets in a row the login is closed for `lockMs`, whatever is sent; one right secret clears the count.
function createLoginLimiter({ now = Date.now, max = 5, lockMs = 15 * 60 * 1000 } = {}) {
  let fails = 0;
  let until = 0;
  return {
    locked: () => now() < until,
    fail: () => { fails += 1; if (fails >= max) { fails = 0; until = now() + lockMs; } },
    success: () => { fails = 0; },
  };
}

// 'local' for the panel's own host names, 'remote' for the configured one (with or without the port), null for anything else.
function classify(hostHeader, localHosts, remote, port) {
  const h = String(hostHeader || '').toLowerCase();
  if (localHosts.has(hostHeader)) return 'local';
  return remote && (h === remote.host || h === `${remote.host}:${port}`) ? 'remote' : null;
}

function cookieValue(header, name) {
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return undefined;
}

const isAuthed = (req, secret, now = Date.now()) => verifySession(secret, cookieValue(req.headers.cookie, COOKIE), now);

// A browser sends Origin on every POST; when it names another host (or is the literal "null") the request is a cross-site one.
function originOk(req) {
  const o = req.headers.origin;
  if (o === undefined) return true;
  try { return new URL(o).host.toLowerCase() === String(req.headers.host || '').toLowerCase(); } catch { return false; }
}

const sessionCookie = (value, secure) => `${COOKIE}=${value}; Path=/; Max-Age=${SESSION_MS / 1000}; HttpOnly; SameSite=Strict${secure ? '; Secure' : ''}`;

const LOGIN_PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>repo-panel</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0d1117;color:#e6edf3;font:16px system-ui,sans-serif}
form{display:grid;gap:12px;width:min(320px,86vw)}input,button{font:inherit;padding:12px;border-radius:8px;border:1px solid #30363d;background:#161b22;color:inherit}
button{background:#1f6feb;border-color:#1f6feb}#e{color:#f85149;min-height:1.2em;margin:0}</style></head>
<body><form id="f"><input id="s" type="password" autocomplete="current-password" placeholder="Secret" autofocus required><button>Enter</button><p id="e"></p></form>
<script>document.getElementById('f').addEventListener('submit',async(ev)=>{ev.preventDefault();const e=document.getElementById('e');e.textContent='';
const r=await fetch('/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({secret:document.getElementById('s').value})}).catch(()=>null);
if(r&&r.ok)location.reload();else e.textContent=r&&r.status===429?'Too many attempts. Try later.':'Wrong secret.';});</script></body></html>`;

module.exports = { remoteOf, signSession, verifySession, secretOk, createLoginLimiter, classify, isAuthed, originOk, sessionCookie, LOGIN_PAGE, COOKIE, SESSION_MS, SECRET_MIN };
