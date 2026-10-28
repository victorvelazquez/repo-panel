'use strict';
// RP58: the real /flow-next button (server key, Summary button, no verdict in the page).
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-panel-rp58-'));
process.env.REPO_PANEL_CONFIG = path.join(dir, 'config.json');

const test = require('node:test');
const assert = require('node:assert/strict');
const lib = require('../lib.js');
const V = require('../public/view.js');
const R = require('../public/resumen.js');
const { piSend, sendGuard } = require('../server/pi.js');

test.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 }));

const IDLE_PI = '▎ ✿ waiting for input\n▎   type, or / for commands\n▎\n';
const BUSY_PI = '$ sleep 20 (timeout 30s)\nElapsed 7.2s\n▎ ❁ working…\n▎   type, or / for commands\n▎\n';
const piTerm = (o = {}) => ({ handle: 'h1', title: 'Terminal 1', worktreePath: 'C:/dev/repo', connected: true, writable: true, ...o });
function fakeOrca({ terminals = [piTerm()], previews = [IDLE_PI, IDLE_PI, 'working'] } = {}) {
  const calls = [];
  let n = 0;
  const orca = async (args) => {
    calls.push(args);
    if (args[0] === 'list') return { terminals };
    if (args[0] === 'show') return { terminal: { preview: previews[Math.min(n++, previews.length - 1)] } };
    return { send: { accepted: true } };
  };
  return { orca, calls, sends: () => calls.filter((c) => c[0] === 'send') };
}
const REPO = { path: 'C:\\dev\\repo' };
const noWait = async () => {};
const refuses = (p, status, re) => assert.rejects(p, (e) => e.status === status && re.test(e.message));

test('flow-next is a fixed command: exactly /flow-next, no arguments', async () => {
  assert.equal(lib.PI_COMMANDS['flow-next'], '/flow-next');
  const f = fakeOrca();
  assert.deepEqual(await piSend(REPO, 'flow-next', f.orca, noWait), { sent: true, confirmed: true });
  assert.deepEqual(f.sends(), [['send', '--terminal', 'h1', '--text', '/flow-next', '--enter']]);
});

test('flow-next goes through the same guards: no session, several sessions, busy, and the same-key refusal', async () => {
  for (const [opts, re] of [
    [{ terminals: [] }, /No open pi session/],
    [{ terminals: [piTerm(), piTerm({ handle: 'h2' })] }, /Several pi sessions/],
    [{ previews: [BUSY_PI] }, /busy or has text typed/],
  ]) {
    const f = fakeOrca(opts);
    await refuses(piSend(REPO, 'flow-next', f.orca, noWait), 409, re);
    assert.equal(f.sends().length, 0);
  }
  const guard = sendGuard(() => 1000);
  assert.equal((await piSend(REPO, 'flow-next', fakeOrca().orca, noWait, undefined, { guard })).confirmed, true);
  await refuses(piSend(REPO, 'flow-next', fakeOrca().orca, noWait, undefined, { guard }), 409, /already sent/);
});

test('an unknown key is still refused and sends nothing; flow-base keeps its text', async () => {
  const f = fakeOrca();
  await refuses(piSend(REPO, 'flow-nextt', f.orca, noWait), 400, /Unknown command/);
  await refuses(piSend(REPO, 'flow-next --x', f.orca, noWait), 400, /Unknown command/);
  assert.equal(f.sends().length, 0);
  assert.equal(lib.PI_COMMANDS['flow-base'], '/flow-base');
  const b = fakeOrca();
  await piSend(REPO, 'flow-base', b.orca, noWait);
  assert.deepEqual(b.sends(), [['send', '--terminal', 'h1', '--text', '/flow-base', '--enter']]);
  const busy = fakeOrca({ previews: [BUSY_PI] });
  await refuses(piSend(REPO, 'flow-base', busy.orca, noWait), 409, /busy or has text typed/);
});

// ---------- the Summary button ----------
const row = (over = {}) => ({
  id: 'r1', name: 'repo', group: 'G', room: null, branch: 'main', progress: { total: 2, completada: 1, enRevision: 0, bloqueada: 0, pendiente: 1, enCurso: 0 },
  session: { state: 'free' }, next: { id: 'T5', entrega: 'e', resultadoVisible: 'r' }, blocking: [], lastMovement: { at: null, what: null },
  action: { kind: 'start', label: 'Start T5', pr: null }, error: null, ...over,
});
const view = (rows, ctx = {}) => R.summaryView({ rows, attention: [], generatedAt: '2026-10-28T10:00:00Z' }, { now: Date.parse('2026-10-28T10:00:00Z'), ...ctx });

test('start action: a primary /flow-next button that sends the key through data-act="pi"', () => {
  const html = view([row()]);
  assert.match(html, /<button class="primary" data-act="pi" data-id="r1" data-cmd="flow-next" title="Send \/flow-next to the open pi session of this repo \(starts T5\)">\/flow-next<\/button>/);
  assert.doesNotMatch(html, /Start T5/);
});

test('start action: disabled while sending, and the unit id is escaped', () => {
  assert.match(view([row()], { sending: { r1: 'flow-next' } }), /data-cmd="flow-next"[^>]*disabled>\/flow-next</);
  const bad = view([row({ next: { id: '"><img src=x>', entrega: 'e', resultadoVisible: 'r' } })]);
  assert.doesNotMatch(bad, /<img/);
});

// ---------- the page does not judge /flow-next ----------
test('flowVerdict: /flow-next has no verdict once the session is idle, and never fails on the unknown key', () => {
  const local = { branch: 'main', base: 'main', head: 'abc', files: [], ahead: 0, behind: 0 };
  const sent = { cmd: 'flow-next', at: 1000 };
  assert.equal(V.flowVerdict(sent, local, 'idle', null, 1000 + 10 * 60 * 1000), null);
  assert.equal(V.flowVerdict(sent, local, 'busy', null, 5000).state, 'running');
  assert.equal(V.flowVerdict(sent, local, 'closed', null, 1000 + 10 * 60 * 1000).state, 'attention');
});
