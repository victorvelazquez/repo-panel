'use strict';
// RP237: the panel launches Gentle Shell with GENTLE_SHELL_INTERACTIVE_HOST=1, so the question tools of Gentle Shell ask with a dialog the panel answers with buttons
// instead of writing the options as text. It is the ONLY variable added: every other PI_*, GENTLE_* and ENGRAM_* key is still removed, the value is always the fixed
// '1' (never taken from the panel's own environment), and the original pi does not get it.
const test = require('node:test');
const assert = require('node:assert/strict');

const { runtimeEnv } = require('../server/piruntime.js');

const GS = { id: 'gentle-shell', command: 'C:\\L\\gentle-shell\\bin\\gentle-shell.cmd' };
const PI = { id: 'pi', command: 'C:\\N\\npm\\pi.cmd', agentDir: 'C:\\h\\.pi\\agent' };
const BASE = { PATH: 'p', HOME: 'h', PI_OTHER: '1', GENTLE_SHELL_CHILD_PACKAGE_INJECTION: '1', gentle_x: '1', ENGRAM_PROJECT: 'a', PIPE: 'keep' };

test('Gentle Shell gets GENTLE_SHELL_INTERACTIVE_HOST=1 and nothing else is added', () => {
  const env = runtimeEnv(GS, BASE);
  assert.deepEqual(env, { PATH: 'p', HOME: 'h', PIPE: 'keep', GENTLE_SHELL_INTERACTIVE_HOST: '1' });
  const added = Object.keys(env).filter((k) => !(k in BASE));
  assert.deepEqual(added, ['GENTLE_SHELL_INTERACTIVE_HOST']);
});

test('the value is always the fixed 1: a value in the panel environment (any case) is removed, never copied', () => {
  for (const [k, v] of [['GENTLE_SHELL_INTERACTIVE_HOST', '0'], ['GENTLE_SHELL_INTERACTIVE_HOST', 'yes; rm'], ['gentle_shell_interactive_host', '0']]) {
    const env = runtimeEnv(GS, { PATH: 'p', [k]: v });
    assert.deepEqual(env, { PATH: 'p', GENTLE_SHELL_INTERACTIVE_HOST: '1' }, `${k}=${v}`);
  }
});

test('the original pi and an unknown or missing runtime do not get it', () => {
  assert.equal('GENTLE_SHELL_INTERACTIVE_HOST' in runtimeEnv(PI, BASE), false);
  assert.equal(runtimeEnv(PI, BASE).PI_CODING_AGENT_DIR, 'C:\\h\\.pi\\agent');
  for (const c of [null, undefined, {}, { id: 'other' }]) assert.equal('GENTLE_SHELL_INTERACTIVE_HOST' in runtimeEnv(c, BASE), false, JSON.stringify(c));
});

test('the input is not mutated', () => {
  const base = { ...BASE };
  runtimeEnv(GS, base);
  assert.deepEqual(base, BASE);
});

// ---------- the launches themselves (probe left by the independent verification) ----------
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'rp237-'));
process.env.REPO_PANEL_CONFIG = path.join(scratch, 'config.json');
test.after(() => fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 5 }));
const { createRpcHost, rpcApi } = require('../server/rpchost.js');
const R = require('../public/resumen.js');

function hostFor(active) {
  const made = [];
  const createClient = (opts) => { const c = { opts, reqs: [], start: async () => ({}), request: async (type, fields) => { c.reqs.push([type, fields]); return {}; }, answerDialog: () => false, pendingDialogs: () => [], state: () => 'idle', close() {} }; made.push(c); return c; };
  const host = createRpcHost({ resolve: async () => ({ active }), repoOf: (id) => ({ id, path: 'C:\\r' }), publish() {}, adoptedOf: () => null, createClient });
  return { host, made, sent: () => made[0].reqs.filter(([t]) => t !== 'get_commands') };
}

// The launch through the handshake is pinned in rpc1a-runtime (h1, h1b), where the fake child is complete.
test('the session launch: Gentle Shell gets 1, the original pi and an unknown id get nothing', async () => {
  const gs = hostFor(GS);
  await gs.host.start('r');
  assert.equal(gs.made[0].opts.env.GENTLE_SHELL_INTERACTIVE_HOST, '1');
  for (const active of [PI, { id: 'other', command: 'C:/x.exe' }]) {
    const { host, made } = hostFor(active);
    await host.start('r');
    assert.equal(Object.keys(made[0].opts.env).some((k) => k.toUpperCase() === 'GENTLE_SHELL_INTERACTIVE_HOST'), false, active.id);
  }
});

// ---------- the permission commands stay out of the panel (option (a), decided by the person) ----------
// With the variable on, /gentle:desktop, /gentle:mode and /gentle:yolo can change Gentle Shell's permission mode (even super-yolo, saved for new sessions) and the
// panel would not show it. The person keeps doing that in the terminal; the panel refuses them, the server and the page alike.
const NOT_HERE = 'Permission and configuration commands (/gentle:desktop, /gentle:mode, /gentle:yolo) are not available from the panel: use the terminal';
const BLOCKED = ['/gentle:desktop', '/gentle:desktop {"type":"set_permission_mode","mode":"super-yolo","persist":true}', '/gentle:yolo', '  /gentle:yolo on', '/GENTLE:MODE auto', '\n/gentle:mode'];

test('the server refuses the permission commands as a prompt, a correction, a queued message and a steer, and sends nothing', async () => {
  const { host, sent } = hostFor(GS);
  await host.start('r');
  const api = rpcApi(host);
  for (const text of BLOCKED) {
    for (const call of [() => api.prompt({ id: 'r', text }), () => api.prompt({ id: 'r', text, behavior: 'steer' }), () => api.prompt({ id: 'r', text, behavior: 'followUp' }), () => api.steer({ id: 'r', text })]) {
      await assert.rejects(call(), (e) => e.status === 409 && e.message === NOT_HERE, JSON.stringify(text));
    }
  }
  assert.deepEqual(sent(), []);
});

test('other commands and texts that only mention them still go as before', async () => {
  const { host, sent } = hostFor(GS);
  await host.start('r');
  const api = rpcApi(host);
  for (const text of ['/flow-next', '/gentle:guide', '/gentle:modes', 'run /gentle:yolo later', '/gentle:yoloX']) await api.prompt({ id: 'r', text });
  assert.deepEqual(sent().map(([, f]) => f.message), ['/flow-next', '/gentle:guide', '/gentle:modes', 'run /gentle:yolo later', '/gentle:yoloX']);
});

// ---------- the permission card of the new shape (measured live: a select whose title carries the command on its second line) ----------
// With the variable, Gentle Shell asks a guarded command as select(`${title}\n${preview}`, ['Allow once', 'Allow for this session'?, 'Always allow …'?, 'Deny']).
// The person chose parity with the terminal: every option, in Gentle Shell's order; the command is shown whole; a cut or hidden text still only refuses (until the parity row).
const PUSH = { requestId: 'd1', method: 'select', title: 'Allow guarded git push?\ngit push origin HEAD', message: '', options: ['Allow once', 'Allow for this session', 'Always allow git push', 'Deny'], expiresAt: null, truncated: false };

test('the card of the new shape: the question, the command whole, every option in order, Deny as a refusing button, no cut note', () => {
  assert.equal(R.askAllowed(PUSH), true);
  const html = R.askCard(PUSH, 'abc', false);
  assert.match(html, /<div class="ch-ask-title">Allow guarded git push\?<\/div><pre class="ch-ask-text">git push origin HEAD<\/pre>/);
  const labels = [...html.matchAll(/data-kind="option" data-index="(\d)"[^>]*>([^<]*)</g)].map((m) => [Number(m[1]), m[2]]);
  assert.deepEqual(labels, [[0, 'Allow once'], [1, 'Allow for this session'], [2, 'Always allow git push'], [3, 'Deny']]);
  assert.match(html, /class="ask-btn ask-negative"[^>]*data-kind="option" data-index="3"/);
  assert.doesNotMatch(html, /The text is cut or has hidden characters/, 'a whole command has no note');
});

// Found by the second independent verification: Gentle Shell also cuts the preview at its START («…») when the guarded action is far into the command.
// RP245: such a preview still counts as cut (askAllowed false and the note), but its options are offered, as in the terminal.
test('a preview cut at its START («…» prefix) counts as cut and shows the note, in the new shape and in a confirm', () => {
  const d = { ...PUSH, title: 'Allow guarded git push?\n…cd /a/long/path && npm run build && git push origin HEAD' };
  assert.equal(R.askAllowed(d), false);
  assert.match(R.askCard(d, 'abc', false), /data-kind="option"[\s\S]*The text is cut or has hidden characters/);
  const c = { requestId: 'd9', method: 'confirm', title: 'Allow guarded git push?', message: '… && git push origin HEAD', options: [], expiresAt: null, truncated: false };
  assert.equal(R.askAllowed(c), false);
});

// Third verification: the leading check must catch a cut behind whitespace, but only the ellipsis characters the session adds: a command that starts with
// dots (../scripts/x.sh, ..\\x.ps1, ./run.sh) is legitimate and stays approvable.
test('a leading ellipsis behind whitespace is refused; commands that start with dots stay approvable', () => {
  for (const cmd of ['  \u2026cd /a && git push', '\t\u2026x', '\u22efx', '\u2025x']) {
    assert.equal(R.askAllowed({ ...PUSH, title: `Allow guarded git push?\n${cmd}` }), false, cmd);
  }
  for (const cmd of ['./run.sh', '  ./run.sh', '.git/hooks/x', '. a.sh', 'cd .. && rm -rf build', '../scripts/x.sh', '..\\x.ps1', '. ./env.sh']) {
    assert.equal(R.askAllowed({ ...PUSH, title: `Allow guarded git push?\n${cmd}` }), true, cmd);
  }
});

test('numbered /gentle forms are refused in every way in, also behind whitespace; near misses are not', async () => {
  const { host, sent } = hostFor(GS);
  await host.start('r');
  const api = rpcApi(host);
  for (const text of ['  /gentle:yolo:1', '\n/gentle:desktop:3 {}', '/gentle:Yolo:007']) {
    for (const call of [() => api.prompt({ id: 'r', text }), () => api.prompt({ id: 'r', text, behavior: 'steer' }), () => api.prompt({ id: 'r', text, behavior: 'followUp' }), () => api.steer({ id: 'r', text })]) {
      await assert.rejects(call(), (e) => e.status === 409 && e.message === NOT_HERE, JSON.stringify(text));
    }
    assert.equal(R.panelRefusal(text), NOT_HERE, text);
  }
  assert.deepEqual(sent(), []);
  for (const text of ['/gentle:mode:2super', '/gentle:yolo:1x']) { assert.equal(R.panelRefusal(text), '', text); await api.prompt({ id: 'r', text }); }
  assert.equal(sent().length, 2);
});

test('pi\'s duplicate-name forms (/gentle:yolo:1) are refused too, by the server and the page', async () => {
  const { host, sent } = hostFor(GS);
  await host.start('r');
  const api = rpcApi(host);
  for (const text of ['/gentle:yolo:1', '/gentle:mode:2 super-yolo', '/gentle:desktop:1 {}', '/GENTLE:YOLO:12']) {
    await assert.rejects(api.prompt({ id: 'r', text }), (e) => e.status === 409 && e.message === NOT_HERE, text);
    await assert.rejects(api.steer({ id: 'r', text }), (e) => e.status === 409, text);
    assert.equal(R.panelRefusal(text), NOT_HERE, text);
  }
  for (const text of ['/gentle:yolo:x', '/gentle:yolo:']) assert.equal(R.panelRefusal(text), '', text);
  assert.deepEqual(sent(), []);
});

test('the new shape with a cut or hidden command counts as not whole and shows the note, with every option (RP245)', () => {
  for (const title of ['Allow guarded git push?\ngit push origin \u2026', 'Allow guarded git push?\ngit push\u200b origin HEAD', 'Allow guarded git push?\n   ']) {
    const d = { ...PUSH, title };
    assert.equal(R.askAllowed(d), false, JSON.stringify(title));
    const html = R.askCard(d, 'abc', false);
    assert.equal((html.match(/data-kind="option"/g) || []).length, 4, JSON.stringify(title));
    assert.match(html, /The text is cut or has hidden characters/, JSON.stringify(title));
  }
});

// The command the card shows must be the one the session sends: when a message comes, it wins, and a second line of the title never replaces it.
test('an «Allow…» select that has a message shows that message as the command, not the second line of its title', () => {
  const d = { ...PUSH, title: 'Allow guarded git push?\ngit push origin HEAD', message: 'git push --force origin main' };
  const html = R.askCard(d, 'abc', false);
  assert.match(html, /<pre class="ch-ask-text">git push --force origin main<\/pre>/);
  assert.doesNotMatch(html, /<pre class="ch-ask-text">git push origin HEAD<\/pre>/);
});

test('the old confirm and a plain question are unchanged', () => {
  const confirm = { requestId: 'd2', method: 'confirm', title: 'Allow guarded git push?', message: 'git push origin HEAD', options: [], expiresAt: null, truncated: false };
  assert.equal(R.askAllowed(confirm), true);
  assert.match(R.askCard(confirm, 'abc', false), /data-kind="deny"[\s\S]*data-kind="allow"/);
  const q = { requestId: 'd3', method: 'select', title: 'Which color?', message: '', options: ['red', 'blue'], expiresAt: null, truncated: false };
  assert.equal(R.askAllowed(q), true);
  assert.match(R.askCard(q, 'abc', false), /<div class="ch-ask-title">Which color\?<\/div><div class="ch-ask-btns">/);
});

test('the page names the same reason for the same texts, and nothing for the rest', () => {
  for (const text of BLOCKED) assert.equal(R.panelRefusal(text), NOT_HERE, JSON.stringify(text));
  for (const text of ['/flow-next', '/gentle:guide', 'run /gentle:yolo later', '', null, undefined]) assert.equal(R.panelRefusal(text), '', String(text));
});
