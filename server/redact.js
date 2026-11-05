'use strict';
// RP105: the one-line summary of a tool call that the chat history shows on a chip (`argSummary`). A pattern list cannot know every form a secret takes
// (two independent checks found 23 and then 12 that got through), so a shell command is NOT redacted: it is rebuilt from an ALLOW-LIST of vocabularies known
// in advance (the program, the subcommand of a few CLIs, flag NAMES, files, the host of a URL) and every other word becomes `…`. `redact` (patterns) stays
// as a second layer on every summary, and the summary is tiny (80 characters, one line) and built only from the main argument of a KNOWN tool: the body of
// a write, the old and new text of an edit, an environment or any argument it does not know never reaches it.

const MAX_ARG = 80;
// Only this much of an argument is looked at (a command can hold a whole file): it bounds the work of the patterns, and the word the cut lands in is dropped so
// a secret is never left half there.
const LOOK_AT = 2000;
const MARK = '[redacted]';
const NAME_WORDS = '(?:token|secret|pass(?:w(?:or)?d)?|pwd|api[-_]?key|apikey|key|auth|credential|cookie|session)';
const RULES = [
  // A private key block: from its first line to the end of the text.
  [/-----BEGIN [A-Z ]*-----[\s\S]*/g, MARK],
  // Authorization-like headers: the value goes, with the scheme in front of it.
  [/\b(authorization|proxy-authorization|x-api-key|x-auth-token|api-?key|set-cookie|cookie)(\s*[:=]\s*)(?:(?:bearer|basic|token|digest)\s+)?[^\s"']+/gi, `$1$2${MARK}`],
  [/\b(bearer)\s+[A-Za-z0-9._~+/=-]{6,}/gi, `$1 ${MARK}`],
  // user:password@ in a URL.
  [/(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/gi, `$1${MARK}@`],
  // The value of a flag whose name says it is a secret, in both forms (`--password x` and `--password=x`).
  [new RegExp(`(--?(?:[a-z0-9]{1,20}[-_]){0,4}${NAME_WORDS}s?)(=|\\s+)(?:"[^"]*"|'[^']*'|\\S+)`, 'gi'), `$1$2${MARK}`],
  // NAME=value where the name says it is a secret (quoted values may hold spaces).
  [new RegExp(`\\b([A-Za-z0-9_.-]{0,40}${NAME_WORDS}[A-Za-z0-9_.-]{0,40})(\\s*=\\s*)("[^"]*"|'[^']*'|[^\\s"']+)`, 'gi'), `$1$2${MARK}`],
  // Token formats that identify themselves.
  [/\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|[sp]k[-_](?:live_|test_|proj-)?[A-Za-z0-9_-]{16,}|glpat-[A-Za-z0-9_-]{16,}|npm_[A-Za-z0-9]{30,}|xox[abprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{30,}|eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}(?:\.[A-Za-z0-9_-]*)?)/g, MARK],
];
// A long run of letters and digits that looks random: a long hex string, or 20+ characters with upper case, lower case and at least 3 digits
// (a long identifier or a path segment rarely has all of those).
const looksRandom = (t) => (t.length >= 32 && /^[0-9a-f]+$/i.test(t)) || (t.length >= 20 && /[A-Z]/.test(t) && /[a-z]/.test(t) && (t.match(/\d/g) || []).length >= 3);

// Zero-width and soft-hyphen characters would split a name from its `=` for the patterns: they go first.
const INVISIBLE = /[\u200b-\u200f\u2060\ufeff\u00ad]/g;

function redact(text) {
  let out = String(text).replace(INVISIBLE, '');
  for (const [re, to] of RULES) out = out.replace(re, to);
  return out.replace(/[A-Za-z0-9+_-]{20,}/g, (t) => (looksRandom(t) ? MARK : t));
}

// ---- the words of a shell command that are safe to show; anything not recognised becomes `…` (runs of them collapse into one) ----
// A word is shown only when it belongs to a vocabulary known in advance, so a secret can never be taken for one: the program (and only at the start of a
// command, after an operator), the subcommand of a few CLIs, flag names made of letters, a file with a known extension or an absolute path, the host of a
// URL. Accepted limits, written in the README: the NAME of an absolute path or of a host, and the text of a grep or find pattern, are shown as they are
// (they are names the agent works with, not values it passes to a command).
const PROGRAMS = new Set(('git npm npx pnpm yarn node deno bun tsc eslint prettier jest mocha vitest python python3 pip pip3 dotnet cargo go rustc java mvn gradle make cmake docker kubectl gh '
  + 'terraform aws gcloud az ls dir cat type cd pwd echo printf grep rg find sed awk cut sort uniq wc head tail diff cp mv rm mkdir rmdir touch chmod curl wget tar unzip zip bash sh zsh pwsh '
  + 'powershell cmd where which ssh scp sudo env export set test true false sleep tee xargs code flow gentle-ai pi').split(' '));
const SUBCOMMAND_CLIS = new Set(['git', 'npm', 'pnpm', 'yarn', 'npx', 'docker', 'kubectl', 'gh', 'cargo', 'go', 'pip', 'pip3', 'dotnet', 'make']);
const EXTENSIONS = new Set(('js mjs cjs jsx ts tsx json md txt yml yaml toml ini html htm css scss py sh ps1 cmd bat log csv xml java go rs c h cpp cs sql lock map png jpg jpeg gif svg ico zip tar gz pdf exe dll')
  .split(' '));
const OPERATORS = new Set(['|', '||', '&&', ';', '&']);
const FLAG = /^(?:--[A-Za-z][A-Za-z-]*|-[A-Za-z]{1,2}|-\d{1,2})$/; // a short flag is at most 2 letters: `-phunter2` is a flag with its value glued on
const FLAG_EQ = /^(--[A-Za-z][A-Za-z-]*)=/;
const ASSIGN = /^([A-Z_][A-Z0-9_]{0,40})=/;
const WORD = /^[A-Za-z][A-Za-z0-9_-]{0,23}$/;
const SUBCOMMAND = /^[a-z][a-z-]{0,14}$/; // letters and hyphens only: a secret almost always has a digit
const URL_START = /^([a-z][a-z0-9+.-]*):\/\/([^/?#]*)/i;
const PATH_CHARS = /^(?:[A-Za-z]:)?[A-Za-z0-9_.~\\/-]+$/;
const ABSOLUTE = /^(?:[A-Za-z]:[\\/]|\/|\\\\|\.{1,2}[\\/]|~[\\/])/; // a drive, a root, a UNC share, ./ ../ ~/ ; a lone backslash is an escape, not a root
const extensionOf = (t) => { const m = /\.([A-Za-z0-9]{1,6})$/.exec(t); return m ? m[1].toLowerCase() : ''; };
// A file: absolute, or with a KNOWN extension. A random-looking segment is not a file.
const isFile = (t) => PATH_CHARS.test(t) && (ABSOLUTE.test(t) || EXTENSIONS.has(extensionOf(t))) && !t.split(/[\\/]/).some(looksRandom);
// scheme://host/… (http, https, ftp only) with no user, password, port text, path or query: a secret travels in those.
function urlHost(t) {
  const m = URL_START.exec(t);
  if (!m || !/^(?:https?|ftp)$/i.test(m[1])) return '';
  const host = m[2].slice(m[2].lastIndexOf('@') + 1).replace(/:(?!\d+$).*$/, '');
  return /^[A-Za-z0-9.-]{1,100}(?::\d{1,5})?$/.test(host) ? `${m[1].toLowerCase()}://${host}/…` : '';
}
// A quoted run is ONE unit (its words, operators and paths are not syntax), and an operator glued to a word is split off it.
const unquote = (c) => c.replace(/"(?:[^"\\]|\\.)*"|'[^']*'|`[^`]*`/g, ' … ').replace(/(&&|\|\||[|;&])/g, ' $1 ');
function shellSummary(command) {
  const out = [];
  const push = (w) => { if (!(w === '…' && out[out.length - 1] === '…')) out.push(w); };
  let program = null; // null while the program of the current command is expected; '?' when it is not a known one
  let positional = 0;
  let afterFlag = false;
  for (const t of unquote(command).split(' ')) {
    if (!t) continue;
    let m;
    if (OPERATORS.has(t)) { push(t); program = null; positional = 0; afterFlag = false; continue; }
    if (FLAG.test(t)) { push(t); afterFlag = true; continue; }
    const wasAfterFlag = afterFlag;
    afterFlag = false;
    if ((m = FLAG_EQ.exec(t))) { push(`${m[1]}=…`); continue; }
    if (program === null && (m = ASSIGN.exec(t))) { push(`${m[1]}=…`); continue; }
    if (URL_START.test(t)) { push(urlHost(t) || '…'); continue; }
    if (program === null) { // the first word of a command decides: a known program, or nothing of this command is shown but its flags, files and hosts
      const name = t.toLowerCase().replace(/\.exe$/, '');
      if (WORD.test(t) && PROGRAMS.has(name)) { push(t); program = name; continue; }
      program = '?';
    }
    if (isFile(t)) { push(t); continue; }
    if (SUBCOMMAND.test(t) && !wasAfterFlag && positional === 0 && SUBCOMMAND_CLIS.has(program)) { push(t); positional++; continue; }
    push('…');
  }
  return out.join(' ');
}

// How each tool's main argument is read: the key it travels under (the first one that is a string wins) and how it is turned into a line.
const FILE_KEYS = ['path', 'file_path', 'filePath', 'file'];
const TOOLS = {
  read: { keys: FILE_KEYS, file: true }, edit: { keys: FILE_KEYS, file: true }, write: { keys: FILE_KEYS, file: true }, ls: { keys: ['path'], file: true },
  grep: { keys: ['pattern', 'query'] }, find: { keys: ['pattern', 'path'] }, glob: { keys: ['pattern', 'path'] },
  bash: { keys: ['command', 'cmd'], shell: true }, shell: { keys: ['command', 'cmd'], shell: true }, powershell: { keys: ['command', 'cmd'], shell: true },
  fetch_content: { keys: ['url'], url: true },
  subagent_run: { keys: ['agent'], word: true }, // the NAME of the subagent, not its free-text label
  // web_search is NOT here: a query is free text that no pattern can clean.
};
const own = Object.prototype.hasOwnProperty;
const cut = (line) => (line.length > MAX_ARG ? `${line.slice(0, MAX_ARG - 1)}…` : line);

// One line of at most MAX_ARG characters, or '' when the tool is not known or the argument is not a string.
function argSummary(name, args) {
  const tool = typeof name === 'string' && own.call(TOOLS, name.toLowerCase()) ? TOOLS[name.toLowerCase()] : null;
  if (!tool || !args || typeof args !== 'object' || Array.isArray(args)) return '';
  const key = tool.keys.find((k) => typeof args[k] === 'string');
  if (!key) return '';
  const flat = args[key].slice(0, LOOK_AT * 4).replace(INVISIBLE, '').replace(/[\x00-\x20\x7f-\x9f\u2028\u2029]+/g, ' ').trim();
  const looked = flat.length > LOOK_AT ? flat.slice(0, LOOK_AT).replace(/\S*$/, '') : flat;
  if (tool.word) return /^[a-z][a-z0-9-]{0,40}$/.test(looked) ? looked : '';
  if (tool.file && /:\/\//.test(looked)) return ''; // a file argument is a path, not a URL (a URL can carry a user)
  return cut(redact(tool.url ? urlHost(looked) : tool.shell ? shellSummary(looked) : looked));
}

// ---- RP106b: the start of the text of a tool RESULT, shown only on request. Free text cannot be allow-listed, so this is the second layer, never the only one (the
// switch in config.json and the click are the first). Every line of the form UPPERCASE_NAME=value loses its value (the shape of `env`, `printenv` and a .env file), then the
// patterns run, then the text is cut: the cut comes LAST on purpose here, because a cut of 300 characters cannot split a secret that the patterns already replaced.
const RESULT_MAX = 300;
// Only this much of a result is looked at (it bounds the work of the patterns: a nested quantifier was cubic on a run of `--pass-token-`, found by an independent check).
const RESULT_LOOK = RESULT_MAX * 5;
// What a terminal puts in front of a line and would hide it from the `^NAME=` rule: a title (OSC), colour and cursor sequences (CSI, 7-bit or 8-bit), any other escape pair, and the
// control characters. They all go BEFORE the lines are split; every line break (LF, CR, CRLF, NEL, U+2028, U+2029) ends a line; a tab stays.
const OSC = /\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)?/g;
const ANSI = /(?:\u001b\[|\u009b)[0-9;?]*[ -/]*[@-~]/g;
const ESC_PAIR = /\u001b[ -~]?/g;
const LINE_BREAKS = /\r\n?|[\u000b\u000c\u001c-\u001e\u2028\u2029\u0085]/g;
const CONTROLS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g;
// A line that sets a variable: `NAME=value`, `export`, `set`, `setx`, `declare -x` and `typeset` forms, PowerShell's `$env:NAME=`, spaces around the `=`, an optional quote. The NAME is uppercase.
const ASSIGNMENT = /^(\s*(?:(?:export|EXPORT|set|SET|setx|SETX|declare|typeset)(?:\s+-[A-Za-z]+)*\s+|\$env:)?"?[A-Z_][A-Z0-9_]*\s*=\s*).*$/;
// The forms that set a variable with a space and no `=`: Windows' `setx NAME value` and fish's `set -x NAME value`.
const ASSIGN_SPACE = /^(\s*(?:setx|SETX|set\s+-[A-Za-z]+|SET\s+-[A-Za-z]+)\s+[A-Z_][A-Z0-9_]*\s+).*$/;
function redactText(text) {
  const lines = String(text).replace(INVISIBLE, '').replace(OSC, '').replace(ANSI, '').replace(ESC_PAIR, '').replace(LINE_BREAKS, '\n').replace(CONTROLS, '').split('\n').map((l) => l.replace(ASSIGNMENT, `$1${MARK}`).replace(ASSIGN_SPACE, `$1${MARK}`));
  return redact(lines.join('\n'));
}
// The cleaned start of a result: control characters (but not line feeds) become spaces, at most RESULT_MAX characters, a cut ends with `…`.
function resultText(text) {
  const raw = String(text);
  // The word the look ends in is dropped (a blob with no space keeps its first RESULT_LOOK characters), so a secret is never left half there.
  const looked = raw.length > RESULT_LOOK ? raw.slice(0, RESULT_LOOK).replace(/\S*$/, '') || raw.slice(0, RESULT_LOOK) : raw;
  const clean = redactText(looked).trim();
  return clean.length > RESULT_MAX ? { text: `${clean.slice(0, RESULT_MAX - 1)}…`, truncated: true } : { text: clean, truncated: false };
}

module.exports = { redact, argSummary, redactText, resultText, MAX_ARG, MARK, RESULT_MAX };
