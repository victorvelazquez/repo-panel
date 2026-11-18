'use strict';
// RP235: the server translates the events of pi into the panel's own vocabulary and the page reads only that one. The `rpc` frame keeps its envelope
// ({ kind: 'event', record }); the `record.type` is a panel name: run_start, run_end, run_settled, stream, tool_start, tool_end, subagent_start, subagent_end,
// retry_start, retry_end, compact_start, compact_end, or other (any event the page does not use: it still reaches the page, so the page redraws as before).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'rp235-'));
process.env.REPO_PANEL_CONFIG = path.join(scratch, 'config.json');
test.after(() => fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 5 }));

const { createRpcHost, toPanel } = require('../server/rpchost.js');
const V = require('../public/view.js');

const PANEL = ['run_start', 'run_end', 'run_settled', 'stream', 'tool_start', 'tool_end', 'subagent_start', 'subagent_end', 'retry_start', 'retry_end', 'compact_start', 'compact_end', 'other'];
const ACTIVE = { id: 'gentle-shell', command: 'C:\\L\\gentle-shell.exe', agentDir: 'C:\\a' };
async function hostWith() {
  const made = [];
  const published = [];
  const createClient = (opts) => { const c = { opts, start: async () => ({}), request: async () => ({}), answerDialog: () => false, pendingDialogs: () => [], state: () => 'idle', close() {} }; made.push(c); return c; };
  const host = createRpcHost({ resolve: async () => ({ active: ACTIVE }), repoOf: (id) => ({ id, path: 'C:\\repos\\alpha' }), publish: (id, p) => published.push(p), createClient, adoptedOf: () => null });
  await host.start('aaa');
  return { published, emit: (record) => made[0].opts.onEvent({ kind: 'event', record }) };
}
const records = (published) => published.filter((p) => p.kind === 'event').map((p) => p.record);
const upd = (a) => ({ type: 'message_update', assistantMessageEvent: a });

// ---------- the translator ----------
test('server: every event of pi the page uses becomes its panel name, with only the fields the page reads', () => {
  const rows = [
    [{ type: 'agent_start', aborted: false, systemPrompt: 'x'.repeat(50) }, { type: 'run_start' }],
    [{ type: 'agent_end', aborted: true, messages: [{ role: 'user' }] }, { type: 'run_end' }],
    [{ type: 'agent_settled' }, { type: 'run_settled' }],
    [{ type: 'message_start', message: { role: 'assistant' } }, { type: 'stream', part: 'reset' }],
    [upd({ type: 'text_start', contentIndex: 0 }), { type: 'stream', index: 0, part: 'text', phase: 'start' }],
    [upd({ type: 'text_delta', contentIndex: 1, delta: 'Hi' }), { type: 'stream', index: 1, part: 'text', phase: 'delta', delta: 'Hi' }],
    [upd({ type: 'text_end', contentIndex: 1, content: 'Hi there' }), { type: 'stream', index: 1, part: 'text', phase: 'end', content: 'Hi there' }],
    [upd({ type: 'thinking_start', contentIndex: 0 }), { type: 'stream', index: 0, part: 'thinking', phase: 'start' }],
    [upd({ type: 'thinking_delta', contentIndex: 0, delta: 'PRIVATE' }), { type: 'stream', index: 0, part: 'thinking', phase: 'delta' }],
    [upd({ type: 'thinking_end', contentIndex: 0, content: 'PRIVATE' }), { type: 'stream', index: 0, part: 'thinking', phase: 'end' }],
    [upd({ type: 'toolcall_delta', contentIndex: 2, delta: '{"cmd":"SECRET"}' }), { type: 'stream', index: 2, part: 'other' }],
    [upd({ type: 'text_other', contentIndex: 3, delta: 'd' }), { type: 'stream', index: 3, part: 'text', delta: 'd' }],
    [upd({ type: 'text_delta', contentIndex: '1', delta: 'x' }), { type: 'stream', part: 'text', phase: 'delta', delta: 'x' }],
    [upd({ type: 'text_end', contentIndex: 0, content: 'y'.repeat(9000) }), { type: 'stream', index: 0, part: 'text', phase: 'end' }],
    [{ type: 'message_update' }, { type: 'stream' }],
    [{ type: 'tool_execution_start', toolName: 'read', args: { path: 'C:\\secret' } }, { type: 'tool_start', name: 'read' }],
    [{ type: 'tool_execution_end', toolName: 'read', isError: false, result: 'SECRET' }, { type: 'tool_end', name: 'read' }],
    [{ type: 'tool_execution_start', toolName: 'subagent_run', args: { task: 'SECRET' } }, { type: 'subagent_start' }],
    [{ type: 'tool_execution_end', toolName: 'subagent_run', result: 'SECRET' }, { type: 'subagent_end' }],
    [{ type: 'tool_execution_start', toolName: 7 }, { type: 'tool_start' }],
    [{ type: 'auto_retry_start', attempt: 2, maxAttempts: 3, delayMs: 4000, errorMessage: 'SECRET' }, { type: 'retry_start', attempt: 2, max: 3, delayMs: 4000 }],
    [{ type: 'auto_retry_start', attempt: '2', maxAttempts: null, delayMs: Infinity }, { type: 'retry_start' }],
    [{ type: 'auto_retry_end', success: false, attempt: 3, finalError: 'SECRET' }, { type: 'retry_end', attempt: 3, success: false }],
    [{ type: 'compaction_start', reason: 'threshold' }, { type: 'compact_start', reason: 'threshold' }],
    [{ type: 'compaction_end', reason: 'weird', summary: 'SECRET' }, { type: 'compact_end' }],
    [{ type: 'turn_end', stopReason: 'stop', message: { content: [{ type: 'text', text: 'SECRET' }] } }, { type: 'other' }],
    [{ type: 'queue_update', steering: ['mine'] }, { type: 'queue', steering: ['mine'], followUp: [] }], // RP236: the person's own queued texts
    [{ type: 'tool_execution_update', partialResult: 'SECRET' }, { type: 'other' }],
    [{ no: 'type' }, { type: 'other' }],
  ];
  for (const [pi, panel] of rows) assert.deepEqual(toPanel(pi), panel, JSON.stringify(pi).slice(0, 80));
  for (const bad of [null, undefined, 'agent_start', 7, ['agent_start']]) assert.deepEqual(toPanel(bad), { type: 'other' });
});

test('server: what the host publishes carries panel names only, and no text the page does not show', async () => {
  const { published, emit } = await hostWith();
  for (const r of [{ type: 'agent_start' }, upd({ type: 'thinking_delta', contentIndex: 0, delta: 'SECRET' }), { type: 'tool_execution_start', toolName: 'subagent_run', args: 'SECRET' },
    { type: 'turn_end', message: { content: [{ type: 'text', text: 'SECRET' }] } }, { type: 'auto_retry_start', errorMessage: 'SECRET' }, { type: 'agent_settled' }]) emit(r);
  const out = records(published);
  assert.deepEqual(out.map((r) => r.type), ['run_start', 'stream', 'subagent_start', 'other', 'retry_start', 'run_settled']);
  for (const r of out) assert.ok(PANEL.includes(r.type), r.type);
  assert.doesNotMatch(JSON.stringify(published), /SECRET|"agent_(start|end|settled)"|tool_execution|auto_retry|message_update|subagent_run/);
});

// ---------- the page reads the panel vocabulary ----------
const rec = (record) => ({ kind: 'event', id: '0123456789', record });
const run = (pis, now = 5) => pis.reduce((e, r) => V.rpcReduce(e, rec(toPanel(r)), now).entry, null);

test('page: a whole run through the translator shows the same chat as before: text, thinking, retry, subagents, compaction and the end', () => {
  let e = run([{ type: 'agent_start' }], 7);
  assert.deepEqual([e.streaming, e.startedAt, e.text], [true, 7, '']);
  e = [upd({ type: 'thinking_start', contentIndex: 0 })].reduce((x, r) => V.rpcReduce(x, rec(toPanel(r))).entry, e);
  assert.equal(e.thinking, true);
  e = [upd({ type: 'thinking_end', contentIndex: 0 }), upd({ type: 'text_start', contentIndex: 1 }), upd({ type: 'text_delta', contentIndex: 1, delta: 'Hel' }), upd({ type: 'text_delta', contentIndex: 1, delta: 'lo' })]
    .reduce((x, r) => V.rpcReduce(x, rec(toPanel(r))).entry, e);
  assert.deepEqual([e.thinking, e.blocks, e.text], [false, ['', 'Hello'], 'Hello']);
  e = V.rpcReduce(e, rec(toPanel(upd({ type: 'text_end', contentIndex: 1, content: 'Hello!' })))).entry;
  assert.equal(e.text, 'Hello!');
  e = V.rpcReduce(e, rec(toPanel({ type: 'message_start' }))).entry;
  assert.deepEqual([e.blocks, e.thinking], [[], false]);
  e = V.rpcReduce(e, rec(toPanel({ type: 'auto_retry_start', attempt: 2, maxAttempts: 3, delayMs: 4000 }))).entry;
  assert.deepEqual(e.retry, { attempt: 2, max: 3, delayMs: 4000 });
  assert.equal(V.rpcReduce(e, rec(toPanel({ type: 'auto_retry_end', success: true }))).entry.retry, null);
  e = V.rpcReduce(e, rec(toPanel({ type: 'tool_execution_start', toolName: 'subagent_run' })), 30).entry;
  e = V.rpcReduce(e, rec(toPanel({ type: 'tool_execution_start', toolName: 'subagent_run' })), 40).entry;
  assert.deepEqual([e.subs, e.subSince], [2, 30]);
  e = V.rpcReduce(e, rec(toPanel({ type: 'tool_execution_start', toolName: 'read' })), 50).entry;
  assert.equal(e.subs, 2, 'another tool is not a subagent');
  e = V.rpcReduce(e, rec(toPanel({ type: 'tool_execution_end', toolName: 'subagent_run' }))).entry;
  assert.deepEqual([e.subs, e.subSince], [1, 30]);
  const comp = V.rpcReduce(e, rec(toPanel({ type: 'compaction_start', reason: 'manual' })));
  assert.deepEqual([comp.entry.compacting, comp.ctx], [true, false]);
  const compEnd = V.rpcReduce(comp.entry, rec(toPanel({ type: 'compaction_end', reason: 'manual' })));
  assert.deepEqual([compEnd.entry.compacting, compEnd.ctx], [false, true]);
  const end = V.rpcReduce(compEnd.entry, rec(toPanel({ type: 'agent_end' })));
  assert.deepEqual([end.ctx, end.reload, end.entry.subs, end.entry.streaming], [true, false, 0, true]);
  const settled = V.rpcReduce(end.entry, rec(toPanel({ type: 'agent_settled' })));
  assert.deepEqual([settled.reload, settled.ctx, settled.entry.streaming, settled.entry.thinking, settled.entry.retry], [true, true, false, false, null]);
});

test('page: the first text of the answer ends the reasoning even when pi sent no end of it (RP104)', () => {
  const thinking = run([{ type: 'agent_start' }, upd({ type: 'thinking_delta', contentIndex: 0 })]);
  assert.equal(thinking.thinking, true);
  for (const a of [{ type: 'text_start', contentIndex: 1 }, { type: 'text_delta', contentIndex: 1, delta: 'Hi' }, { type: 'text_end', contentIndex: 1, content: 'Hi' }]) {
    assert.equal(V.rpcReduce(thinking, rec(toPanel(upd(a)))).entry.thinking, false, a.type);
  }
  assert.equal(V.rpcReduce(thinking, rec(toPanel(upd({ type: 'toolcall_delta', contentIndex: 1 })))).entry.thinking, true, 'a tool call does not end it');
});

test('page: a stream event with no valid index changes no block, and an event the page does not use changes nothing', () => {
  const e = run([{ type: 'agent_start' }, upd({ type: 'text_delta', contentIndex: 0, delta: 'ab' })]);
  for (const r of [upd({ type: 'text_delta', contentIndex: 99, delta: 'x' }), upd({ type: 'text_delta', contentIndex: -1, delta: 'x' }), { type: 'message_update' }, { type: 'turn_end' }, { type: 'queue_update' }]) {
    const out = V.rpcReduce(e, rec(toPanel(r)));
    assert.deepEqual([out.entry.blocks, out.entry.text, out.reload, out.ctx], [['ab'], 'ab', false, false], JSON.stringify(r));
  }
});

test('page: the names of pi mean nothing to it any more', () => {
  const e = run([{ type: 'agent_start' }, upd({ type: 'text_delta', contentIndex: 0, delta: 'ab' })]);
  for (const record of [{ type: 'agent_start' }, { type: 'agent_settled' }, { type: 'agent_end' }, { type: 'message_start' }, { type: 'compaction_start' }, { type: 'auto_retry_start', attempt: 1 },
    { type: 'tool_execution_start', toolName: 'subagent_run' }, { type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'zz' } }]) {
    const out = V.rpcReduce(e, rec(record), 99);
    assert.deepEqual(out, { entry: e, reload: false, ctx: false }, record.type);
  }
});
