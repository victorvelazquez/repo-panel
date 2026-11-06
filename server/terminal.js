'use strict';
// RP118: the line the person pastes into a normal terminal to open the panel's session with the whole interface of pi. It carries a folder path and a session id into a SHELL, so the server writes it
// (never the page) and it is built to be inert: the folder and the launcher go in single quotes (inside them PowerShell and POSIX shells expand nothing), the session id is only letters, digits, dot, dash and
// underscore and never starts with a dash (it would read as an option), and whatever cannot be carried safely is refused, never "cleaned": a control character, a folder that is not absolute and, in PowerShell,
// the typographic quotes it reads as quotes (a doubled one is not something to count on) and the characters cmd.exe reads as operators (& | < > ^ %). The line is for PowerShell and the page says so. One line, no line break.
const UNSAFE = 'The command cannot be written safely for this folder or session';
const NO_RUNTIME = 'No pi runtime is available';

const SESSION_ID = /^(?=.*[A-Za-z0-9])[A-Za-z0-9._][A-Za-z0-9._-]{0,79}$/; // at least one letter or digit: `.` and `..` are not ids
// Controls, and characters that show one thing and run another (direction marks, zero-width characters, odd spaces): refused, never "cleaned".
const CONTROLS = /[\x00-\x1f\x7f-\x9f\u00a0\u061c\u180e\u2000-\u200f\u2028-\u202f\u205f-\u2064\u2066-\u2069\u3000\ufeff]/;
const PS_QUOTES = /[\u2018\u2019\u201a\u201b]/;
// cmd.exe reads these as operators (and expands %VAR% even inside PowerShell single quotes): the line is for PowerShell, and pasted in cmd a folder with one would run something else.
const CMD_META = /[&|<>^%]/;

const isText = (v) => typeof v === 'string' && v.trim() !== '';
const absolute = (p, win) => (win ? /^[A-Za-z]:[\\/]/.test(p) || /^\\\\[^\\]/.test(p) : p.startsWith('/'));
const psQuote = (s) => `'${s.replace(/'/g, "''")}'`;
const posixQuote = (s) => `'${s.replace(/'/g, "'\\''")}'`;

function terminalCommand({ cwd, launcher, sessionId, platform = process.platform } = {}) {
  const win = platform === 'win32';
  if (!isText(cwd) || !isText(launcher) || typeof sessionId !== 'string' || !SESSION_ID.test(sessionId)) return { ok: false, reason: UNSAFE };
  if (CONTROLS.test(cwd) || CONTROLS.test(launcher)) return { ok: false, reason: UNSAFE };
  if (win && (PS_QUOTES.test(cwd) || PS_QUOTES.test(launcher) || CMD_META.test(cwd) || CMD_META.test(launcher))) return { ok: false, reason: UNSAFE };
  if (!absolute(cwd, win)) return { ok: false, reason: UNSAFE };
  const command = win
    ? `Set-Location -LiteralPath ${psQuote(cwd)}; & ${psQuote(launcher)} --session-id ${sessionId}`
    : `cd ${posixQuote(cwd)} && ${posixQuote(launcher)} --session-id ${sessionId}`;
  return { ok: true, command };
}

// GET /api/terminal?id=<repo id>: only reads. A repo with no runtime, or whose folder cannot be carried safely, answers `available: false` with a FIXED reason (the folder is never echoed); an unknown repo
// is the host's 404.
async function terminalAnswer(host, id, platform = process.platform) {
  let info;
  try { info = await host.terminalInfo(id); } catch (e) {
    if (e && e.status === 409) return { available: false, reason: NO_RUNTIME };
    throw e;
  }
  const r = terminalCommand({ cwd: info.cwd, launcher: info.launcher, sessionId: info.sessionId, platform });
  if (!r.ok) return { available: false, reason: r.reason };
  return { available: true, cwd: info.cwd, command: r.command, sessionId: info.sessionId, shell: platform === 'win32' ? 'powershell' : 'posix' };
}

module.exports = { terminalCommand, terminalAnswer, UNSAFE, NO_RUNTIME };
