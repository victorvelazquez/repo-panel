'use strict';
// Syntax highlighter of the viewer (plain <script>, global RepoPanelHighlight; CommonJS in tests). Pure: no DOM, no network, no dependencies. languageOf(path) gives the language of a file by its
// extension; highlightLines(lines, lang) gives the HTML of every line, with <span class="hl-x"> around the tokens, or null when there is no language or the file is longer than MAX_LINES.
// The rule that matters (RP66a, S5): the content of a file is data. Every character that comes from it goes through `esc` exactly once, and the only markup that is ever added is the span
// of a token, so the output without those spans is the escaped input. Every scanner is linear: a token is found by looking forward from where it starts, never by retrying on the rest of the line.
// Classes: k keyword, s string, c comment, n number, p property or key, t tag, a attribute, v variable, h heading. Not highlighted on purpose: regular expressions, the ${} inside a template
// literal, and the code inside <script> and <style>.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.RepoPanelHighlight = api;
}(typeof self !== 'undefined' ? self : this, () => {
  const MAX_LINES = 2000;
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const wrap = (cls, text) => (text ? `<span class="hl-${cls}">${esc(text)}</span>` : '');
  const EXT = { js: 'js', mjs: 'js', cjs: 'js', jsx: 'js', ts: 'js', tsx: 'js', json: 'json', css: 'css', html: 'html', htm: 'html', md: 'md', markdown: 'md', sh: 'sh', bash: 'sh' };

  function languageOf(p) {
    if (typeof p !== 'string') return null;
    const base = p.split(/[\\/]/).pop();
    const dot = base.lastIndexOf('.');
    if (dot <= 0) return null; // no extension, or a dotfile such as .gitignore
    const ext = base.slice(dot + 1).toLowerCase();
    return Object.hasOwn(EXT, ext) ? EXT[ext] : null;
  }

  const WORD_JS = /[A-Za-z_$][\w$]*/y;
  const WORD = /[A-Za-z_]\w*/y;
  const isWordChar = (c) => c !== undefined && /[\w$]/.test(c);
  // The length of the keyword that starts at i, or 0: it must start a word (the previous character is not part of one) and be one of `set`.
  function wordAt(line, i, set, re) {
    if (isWordChar(line[i - 1])) return 0;
    re.lastIndex = i;
    const m = re.exec(line);
    return m && set.has(m[0]) ? m[0].length : 0;
  }
  // Where a string that opens at `from - 1`... no: the index after the closing quote found from `from`, or -1. A backslash skips the next character (unless `raw`).
  function endOf(line, from, quote, raw = false) {
    for (let i = from; i < line.length; i++) {
      if (!raw && line[i] === '\\') i++;
      else if (line[i] === quote) return i + 1;
    }
    return -1;
  }
  const sticky = (re) => { const r = new RegExp(re.source, 'y'); return (line, i) => { r.lastIndex = i; const m = r.exec(line); return m ? m[0].length : 0; }; };

  // ---- the driver: at each position the first rule that matches wins; a rule returns [length, class] (class null: plain) or null ----
  function run(line, st, rules, from = 0) {
    let out = '';
    let plain = '';
    let i = from;
    const flush = () => { if (plain) { out += esc(plain); plain = ''; } };
    while (i < line.length) {
      let hit = null;
      for (const r of rules) { hit = r(line, i, st); if (hit) break; }
      if (!hit) { plain += line[i++]; continue; }
      if (hit[1] === null) plain += line.slice(i, i + hit[0]);
      else { flush(); out += wrap(hit[1], line.slice(i, i + hit[0])); }
      i += hit[0];
    }
    flush();
    return out;
  }

  // A line that starts inside something that spans lines (a block comment, a template literal, an HTML comment): the highlighted part up to where it ends, and where to go on from.
  function resume(line, st, closer) {
    if (!st.mode) return null;
    const m = closer[st.mode];
    if (!m) return null;
    const end = m.find(line);
    if (end < 0) return { html: wrap(m.cls, line), from: line.length };
    st.mode = null;
    return { html: wrap(m.cls, line.slice(0, end)), from: end };
  }
  const BLOCK = { block: { cls: 'c', find: (l) => { const k = l.indexOf('*/'); return k < 0 ? -1 : k + 2; } } };
  const JS_CLOSER = { ...BLOCK, tpl: { cls: 's', find: (l) => endOf(l, 0, '`') } };
  const HTML_CLOSER = { htmlc: { cls: 'c', find: (l) => { const k = l.indexOf('-->'); return k < 0 ? -1 : k + 3; } } };

  // ---- shared rules ----
  const blockComment = (line, i, st) => {
    if (line[i] !== '/' || line[i + 1] !== '*') return null;
    const k = line.indexOf('*/', i + 2);
    if (k < 0) { st.mode = 'block'; return [line.length - i, 'c']; }
    return [k + 2 - i, 'c'];
  };
  const quoted = (quotes, kind) => (line, i, st) => {
    const q = line[i];
    if (!quotes.includes(q)) return null;
    const e = endOf(line, i + 1, q, q === "'" && kind === 'sh');
    if (e < 0) { if (q === '`') st.mode = 'tpl'; return [line.length - i, 's']; }
    return [e - i, 's'];
  };

  // ---- js (and ts) ----
  const JS_KW = new Set('break case catch class const continue debugger default delete do else export extends finally for from function if import in instanceof let new of return static super switch this throw try typeof var void while with yield async await null true false undefined interface type enum implements public private protected readonly as'.split(' '));
  const jsNumber = sticky(/(?:0[xX][0-9a-fA-F_]+|\d[\d_]*(?:\.\d+)?(?:[eE][+-]?\d+)?)n?/);
  const JS_RULES = [
    (line, i) => (line[i] === '/' && line[i + 1] === '/' ? [line.length - i, 'c'] : null),
    blockComment,
    quoted(['"', "'", '`'], 'js'),
    (line, i) => { if (isWordChar(line[i - 1])) return null; const n = jsNumber(line, i); return n ? [n, 'n'] : null; },
    (line, i) => { const n = wordAt(line, i, JS_KW, WORD_JS); return n ? [n, 'k'] : null; },
  ];

  // ---- json ----
  const JSON_LIT = new Set(['true', 'false', 'null']);
  const jsonNumber = sticky(/-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/);
  const JSON_RULES = [
    (line, i) => {
      if (line[i] !== '"') return null;
      const e = endOf(line, i + 1, '"');
      if (e < 0) return [line.length - i, 's'];
      let j = e; while (line[j] === ' ' || line[j] === '\t') j++;
      return [e - i, line[j] === ':' ? 'p' : 's'];
    },
    (line, i) => { if (isWordChar(line[i - 1])) return null; const n = jsonNumber(line, i); return n ? [n, 'n'] : null; },
    (line, i) => { const n = wordAt(line, i, JSON_LIT, WORD); return n ? [n, 'k'] : null; },
  ];

  // ---- css: a property is only the word before a colon INSIDE braces, so `a:hover` in a selector is not one ----
  const cssAt = sticky(/@[A-Za-z-]+/);
  const cssProp = sticky(/[A-Za-z-]+(?=\s*:)/);
  const cssHex = sticky(/#[0-9a-fA-F]{3,8}(?![\w-])/);
  const cssNum = sticky(/-?(?:\d+\.?\d*|\.\d+)[a-zA-Z%]*/);
  const CSS_RULES = [
    blockComment,
    quoted(['"', "'"], 'css'),
    (line, i, st) => { if (line[i] === '{') { st.depth++; return [1, null]; } if (line[i] === '}') { st.depth = Math.max(0, st.depth - 1); return [1, null]; } return null; },
    (line, i) => { if (line[i] !== '@') return null; const n = cssAt(line, i); return n ? [n, 'k'] : null; },
    (line, i, st) => { if (st.depth < 1 || isWordChar(line[i - 1]) || line[i - 1] === '-') return null; const n = cssProp(line, i); return n ? [n, 'p'] : null; },
    (line, i, st) => { if (st.depth < 1 || line[i] !== '#') return null; const n = cssHex(line, i); return n ? [n, 'n'] : null; },
    (line, i, st) => { if (st.depth < 1 || isWordChar(line[i - 1]) || line[i - 1] === '-') return null; const n = cssNum(line, i); return n ? [n, 'n'] : null; },
  ];

  // ---- html ----
  const htmlTag = sticky(/<\/?[A-Za-z][\w:-]*/);
  const htmlAttr = sticky(/[A-Za-z_:@][\w:.@-]*(?=\s*=)/);
  const HTML_RULES = [
    (line, i, st) => {
      if (line.startsWith('<!--', i)) { const k = line.indexOf('-->', i + 4); if (k < 0) { st.mode = 'htmlc'; return [line.length - i, 'c']; } return [k + 3 - i, 'c']; }
      return null;
    },
    (line, i, st) => { if (line[i] !== '<') return null; const n = htmlTag(line, i); if (!n) return null; st.inTag = true; return [n, 't']; },
    (line, i, st) => { if (!st.inTag || line[i] !== '>') return null; st.inTag = false; return [1, null]; },
    (line, i, st) => { if (!st.inTag || isWordChar(line[i - 1])) return null; const n = htmlAttr(line, i); return n ? [n, 'a'] : null; },
    (line, i, st) => (st.inTag ? quoted(['"', "'"], 'html')(line, i, st) : null),
  ];

  // ---- markdown: whole-line things first, then the inline code ----
  const MD_FENCE = /^\s*(```|~~~)/;
  const MD_RULES = [
    (line, i) => {
      if (line[i] !== '`') return null;
      let n = 1; while (line[i + n] === '`') n++;
      const close = line.indexOf('`'.repeat(n), i + n);
      return close < 0 ? [n, null] : [close + n - i, 's']; // an unclosed run is plain: skipped whole, so a line of backticks stays linear
    },
  ];
  function mdLine(line, st) {
    if (st.fence) { if (MD_FENCE.test(line)) st.fence = false; return wrap('s', line); }
    if (MD_FENCE.test(line)) { st.fence = true; return wrap('s', line); }
    if (/^#{1,6}(\s|$)/.test(line)) return wrap('h', line);
    const m = /^(\s*)([-*+]|\d+[.)]|>)(?=\s|$)/.exec(line);
    if (m) return esc(m[1]) + wrap('k', m[2]) + run(line, st, MD_RULES, m[0].length);
    return run(line, st, MD_RULES);
  }

  // ---- shell ----
  const SH_KW = new Set('if then else elif fi for while until do done case esac in function select return exit break continue echo cd export source local set unset read shift trap test'.split(' '));
  const shVar = sticky(/\$(?:\{[^}]*\}?|[A-Za-z_]\w*|[0-9@#?*$!-])/);
  const SH_RULES = [
    (line, i) => (line[i] === '#' && (i === 0 || /\s/.test(line[i - 1])) ? [line.length - i, 'c'] : null),
    quoted(['"', "'"], 'sh'),
    (line, i) => { if (line[i] !== '$') return null; const n = shVar(line, i); return n ? [n, 'v'] : null; },
    (line, i) => { const n = wordAt(line, i, SH_KW, WORD); return n ? [n, 'k'] : null; },
  ];

  const LANG = {
    js: { rules: JS_RULES, closer: JS_CLOSER },
    json: { rules: JSON_RULES },
    css: { rules: CSS_RULES, closer: BLOCK },
    html: { rules: HTML_RULES, closer: HTML_CLOSER },
    md: { line: mdLine },
    sh: { rules: SH_RULES },
  };

  function highlightLines(lines, lang) {
    if (!Array.isArray(lines) || typeof lang !== 'string' || !Object.hasOwn(LANG, lang) || lines.length > MAX_LINES) return null;
    const spec = LANG[lang];
    const st = { mode: null, depth: 0, inTag: false, fence: false }; // lives for this call only
    return lines.map((l) => {
      const line = String(l ?? '');
      if (spec.line) return spec.line(line, st);
      const r = spec.closer ? resume(line, st, spec.closer) : null;
      return r ? r.html + run(line, st, spec.rules, r.from) : run(line, st, spec.rules);
    });
  }

  return { languageOf, highlightLines, MAX_LINES };
}));
