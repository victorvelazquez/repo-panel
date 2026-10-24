'use strict';
// Process runner: runs git and gh with a cap on parallel child processes.
const { execFile } = require('node:child_process');

const MAX_PARALLEL = 8;
let active = 0;
const waiting = [];
function slot() {
  return new Promise((resolve) => {
    const go = () => { active++; resolve(() => { active--; if (waiting.length) waiting.shift()(); }); };
    if (active < MAX_PARALLEL) go(); else waiting.push(go);
  });
}

async function run(cmd, args, { cwd, timeout = 60000 } = {}) {
  const release = await slot();
  try {
    return await new Promise((resolve) => {
      execFile(cmd, args, {
        cwd, timeout, maxBuffer: 64 * 1024 * 1024, windowsHide: true,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1' },
      }, (err, stdout, stderr) => {
        resolve({ code: err ? (typeof err.code === 'number' ? err.code : -1) : 0, stdout: stdout || '', stderr: stderr || '' });
      });
    });
  } finally { release(); }
}

const git = (cwd, args, opts) => run('git', ['--no-optional-locks', '-c', 'core.quotepath=false', ...args], { cwd, ...opts });
const gh = (cwd, args, opts) => run('gh', args, { cwd, ...opts });
const firstLine = (s) => (s || '').trim().split('\n').find(Boolean) || '';

module.exports = { run, git, gh, firstLine };
