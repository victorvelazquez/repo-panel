'use strict';
// A fake `pi --mode rpc` for tests: JSONL on stdin and stdout, records separated by LF only. It only runs with FAKE_PI=1 (`node --test` also
// picks up every file under test/, and without the variable this one exits at once). Its behaviour comes from environment variables:
//   FAKE_DELAY_MS   wait this long before it starts answering (a slow start)
//   FAKE_NOTICES=1  UI notices (setStatus, setWidget) before the first answer
//   FAKE_GARBAGE=1  a broken line and a non-JSON line before and after the first answer
//   FAKE_DIE=early|ready  exit(3) at once, or right after the first answer
//   FAKE_CRLF=1     end every line with CRLF
//   FAKE_SPLIT=1    write every line in two chunks, with a pause in the middle
//   FAKE_NO_ANSWER=<command>  never answer that command
//   FAKE_DIALOG=select|confirm  a prompt raises that dialog (FAKE_DIALOG_TIMEOUT=<ms> adds a timeout) and the run ends when it is answered
//   FAKE_RUN_MS     how long a prompt runs before agent_end (default 30)
//   FAKE_FLOOD=<n>  a line of n characters after the first answer
//   FAKE_STATS=<json>  the data that get_session_stats answers (default: 124000 of 200000 tokens, 62 percent); FAKE_STATS_FAIL=1 answers success false
//   the command fake_emit { record } is answered and then written to stdout as an event (for example a compaction_end)
//   FAKE_LOG=<file> every line received on stdin is appended to this file
const fs = require('node:fs');

const env = process.env;
if (!env.FAKE_PI) process.exit(0);
const delay = Number(env.FAKE_DELAY_MS) || 0;
const eol = env.FAKE_CRLF ? '\r\n' : '\n';
let streaming = false;
let ready = false;
let runTimer = null;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Writes go one after the other, so FAKE_SPLIT halves of two records never interleave.
let chain = Promise.resolve();
const out = (obj) => { chain = chain.then(() => write(obj)); return chain; };
async function write(obj) {
  const line = (typeof obj === 'string' ? obj : JSON.stringify(obj)) + eol;
  if (env.FAKE_SPLIT) {
    const mid = Math.floor(line.length / 2);
    process.stdout.write(line.slice(0, mid));
    await sleep(15);
    process.stdout.write(line.slice(mid));
  } else process.stdout.write(line);
}

function endRun() {
  clearTimeout(runTimer);
  if (!streaming) return;
  streaming = false;
  out({ type: 'agent_end' });
  out({ type: 'agent_settled' });
}

function startRun(msg) {
  streaming = true;
  out({ type: 'agent_start' });
  out({ type: 'message_update', text: String(msg.message || '').slice(0, 100) });
  if (env.FAKE_DIALOG) {
    const confirm = env.FAKE_DIALOG === 'confirm';
    out({ type: 'extension_ui_request', id: 'd1', method: env.FAKE_DIALOG, title: 'Allow?', message: confirm ? 'Run it?' : undefined, options: confirm ? undefined : ['Yes', 'No'], ...(env.FAKE_DIALOG_TIMEOUT ? { timeout: Number(env.FAKE_DIALOG_TIMEOUT) } : {}) });
    out({ type: 'extension_ui_request', id: 'n1', method: 'notify', message: 'fire and forget' });
    if (env.FAKE_DIALOG_TIMEOUT) runTimer = setTimeout(endRun, Number(env.FAKE_DIALOG_TIMEOUT));
  } else runTimer = setTimeout(endRun, Number(env.FAKE_RUN_MS) || 30);
}

async function handle(line) {
  if (env.FAKE_LOG) fs.appendFileSync(env.FAKE_LOG, `${line}\n`);
  let msg;
  try { msg = JSON.parse(line); } catch { return out({ type: 'response', command: 'parse', success: false, error: 'Failed to parse command' }); }
  if (msg.type === 'extension_ui_response') {
    out({ type: 'ui_answered', id: msg.id });
    return endRun();
  }
  if (env.FAKE_NO_ANSWER === msg.type) return undefined;
  const reply = (success, data, error) => out({ id: msg.id, type: 'response', command: msg.type, success, ...(success ? { data } : { error }) });
  if (msg.type === 'get_state') return reply(true, { isStreaming: streaming, isCompacting: false, sessionId: 'fake', sessionFile: null, sessionName: null, messageCount: 0, pendingMessageCount: 0, model: null });
  if (msg.type === 'prompt') {
    if (streaming && !msg.streamingBehavior) return reply(false, null, 'Agent is already processing: /home/secret/file.txt');
    if (streaming) return reply(true, { disposition: 'queued' });
    reply(true, { disposition: 'started' });
    return startRun(msg);
  }
  if (msg.type === 'steer' || msg.type === 'follow_up') return reply(true, { disposition: 'queued' });
  if (msg.type === 'abort') { reply(true, {}); return endRun(); }
  if (msg.type === 'get_session_stats') return env.FAKE_STATS_FAIL ? reply(false, null, 'stats failed: /home/secret/file.txt') : reply(true, env.FAKE_STATS ? JSON.parse(env.FAKE_STATS) : { contextUsage: { tokens: 124000, contextWindow: 200000, percent: 62 } });
  if (msg.type === 'fake_emit') { reply(true, {}); return out(msg.record); }
  return reply(false, null, 'unknown command');
}

async function main() {
  if (env.FAKE_DIE === 'early') process.exit(3);
  if (env.FAKE_NOTICES) {
    out({ type: 'extension_ui_request', id: 'u1', method: 'setStatus', statusKey: 'x', statusText: 'loading' });
    out({ type: 'extension_ui_request', id: 'u2', method: 'setWidget', widgetKey: 'w', widgetLines: ['hi'] });
  }
  if (delay) await sleep(delay);
  if (env.FAKE_GARBAGE) { process.stdout.write(`{"broken${eol}not json at all${eol}`); }
  ready = true;
  let buf = '';
  const queue = [];
  let busy = false;
  const drain = async () => {
    if (busy) return;
    busy = true;
    while (queue.length) await handle(queue.shift());
    busy = false;
    if (env.FAKE_DIE === 'ready' && ready) setTimeout(() => process.exit(3), 80);
  };
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).replace(/\r$/, '');
      buf = buf.slice(nl + 1);
      if (line.trim()) queue.push(line);
    }
    if (ready) drain().then(async () => {
      if (env.FAKE_GARBAGE && !global.garbageAfter) { global.garbageAfter = true; process.stdout.write(`{"x":${eol}{"id":"zzz","type":"response","command":"get_state","success":true}${eol}`); }
      if (env.FAKE_FLOOD && !global.flooded) { global.flooded = true; process.stdout.write(`${'x'.repeat(Number(env.FAKE_FLOOD))}${eol}`); }
    });
  });
  process.stdin.on('end', () => process.exit(0));
}
main();
