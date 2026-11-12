/**
 * A POSIX shell reader, enough to see what a command line runs: words (quotes removed; `$VAR`, `${…}`, `$(…)` and
 * backticks kept as written and flagged), redirections with heredoc bodies, pipelines, and every command substitution's
 * source (analyzed on its own). It never expands or runs anything. A syntax error (an unclosed quote, say) throws
 * `ParseError`, and the caller falls back to scanning the raw text.
 */

export interface Word {
  /** quotes removed; expansions kept as written (`$HOME`, `$(cmd)`) */
  text: string;
  raw: string;
  quoted: boolean;
  /** contains a parameter expansion or a substitution outside single quotes */
  dynamic: boolean;
  /** contains a command substitution (`$(…)`, backticks) */
  subst: boolean;
  /** unquoted glob characters */
  glob: boolean;
}

export interface Redir {
  op: string;
  fd?: string;
  target?: Word;
  heredoc?: { body: string; quoted: boolean };
}

export interface Cmd {
  words: Word[];
  redirs: Redir[];
  /** the command whose output this one reads (`a | b`: b's is a) */
  pipedFrom?: Cmd;
}

export interface Script {
  cmds: Cmd[];
  /** sources of `$(…)`, backticks and `<(…)`/`>(…)` anywhere in the script */
  subs: string[];
}

export class ParseError extends Error {}

const OPS = ["&&", "||", ";;", "|&", ";", "|", "&", "(", ")"];
const REDIRS = ["&>>", "<<<", "<<-", "&>", "<<", ">>", ">&", "<&", ">|", "<>", ">", "<"];
const KEYWORDS = new Set(["if", "then", "else", "elif", "do", "while", "until", "!", "{", "time"]);
const ENDERS = new Set(["fi", "done", "esac", "}"]);

/** index just past the `)` closing a `$(` / `<(` whose `(` is at `open` */
function closeParen(s: string, open: number): number {
  let depth = 1;
  for (let i = open + 1; i < s.length; i++) {
    const c = s[i];
    if (c === "\\") i++;
    else if (c === "'") {
      const j = s.indexOf("'", i + 1);
      if (j < 0) throw new ParseError("unclosed single quote");
      i = j;
    } else if (c === '"') i = closeDouble(s, i);
    else if (c === "`") i = closeBacktick(s, i);
    else if (c === "(") depth++;
    else if (c === ")" && --depth === 0) return i + 1;
  }
  throw new ParseError("unclosed command substitution");
}

/** index of the `"` closing the one at `open` */
function closeDouble(s: string, open: number): number {
  for (let i = open + 1; i < s.length; i++) {
    const c = s[i];
    if (c === "\\") i++;
    else if (c === '"') return i;
    else if (c === "$" && s[i + 1] === "(") i = closeParen(s, i + 1) - 1;
    else if (c === "`") i = closeBacktick(s, i);
  }
  throw new ParseError("unclosed double quote");
}

function closeBacktick(s: string, open: number): number {
  for (let i = open + 1; i < s.length; i++) {
    if (s[i] === "\\") i++;
    else if (s[i] === "`") return i;
  }
  throw new ParseError("unclosed backtick");
}

function closeBrace(s: string, open: number): number {
  let depth = 1;
  for (let i = open + 1; i < s.length; i++) {
    if (s[i] === "\\") i++;
    else if (s[i] === "{") depth++;
    else if (s[i] === "}" && --depth === 0) return i;
  }
  throw new ParseError("unclosed parameter expansion");
}

const ANSI: Record<string, string> = { n: "\n", t: "\t", r: "\r", a: "\x07", b: "\b", e: "\x1b", E: "\x1b", f: "\f" };
ANSI.v = "\v";

/** `$'…'` body → text */
function ansiC(body: string): string {
  return body.replace(/\\(x[0-9a-fA-F]{1,2}|u[0-9a-fA-F]{1,4}|U[0-9a-fA-F]{1,8}|[0-7]{1,3}|.)/g, (_, e: string) => {
    if (/^[xuU]/.test(e)) return String.fromCodePoint(Number.parseInt(e.slice(1), 16));
    if (/^[0-7]/.test(e)) return String.fromCharCode(Number.parseInt(e, 8));
    return ANSI[e] ?? e;
  });
}

interface Tok {
  kind: "word" | "op" | "redir";
  value: string;
  word?: Word;
}

/** Reads `src` into commands; throws `ParseError` on what bash would reject. */
export function parse(src: string): Script {
  const subs: string[] = [];
  const toks: Tok[] = [];
  /** heredoc redirections (token indices) waiting for the end of their line, and the bodies read */
  const pending: number[] = [];
  const docs = new Map<number, { body: string; quoted: boolean }>();
  let i = 0;
  let w: Word | undefined;
  const word = () => {
    w ??= { text: "", raw: "", quoted: false, dynamic: false, subst: false, glob: false };
    return w;
  };
  const end = () => {
    if (w) toks.push({ kind: "word", value: w.text, word: w });
    w = undefined;
  };
  const sub = (start: number, close: number, inner: string) => {
    subs.push(inner);
    const cur = word();
    cur.text += src.slice(start, close);
    cur.dynamic = cur.subst = true;
  };
  /** `$…` at i (outside single quotes); returns the index after it */
  const dollar = (at: number): number => {
    const cur = word();
    const next = src[at + 1];
    if (next === "(" && src[at + 2] === "(") {
      // arithmetic: its text, no command
      const close = closeParen(src, at + 1);
      cur.text += src.slice(at, close);
      cur.dynamic = true;
      return close;
    }
    if (next === "(") {
      const close = closeParen(src, at + 1);
      sub(at, close, src.slice(at + 2, close - 1));
      return close;
    }
    if (next === "{") {
      const close = closeBrace(src, at + 1);
      const body = src.slice(at + 2, close);
      // ${x:-$(cmd)} and friends: the nested parts are analyzed too
      for (const m of body.matchAll(/\$\(([^)]*)\)|`([^`]*)`/g)) subs.push(m[1] ?? m[2] ?? "");
      cur.text += src.slice(at, close + 1);
      cur.dynamic = true;
      return close + 1;
    }
    const m = /^(?:[A-Za-z_][A-Za-z0-9_]*|[0-9@*#?$!-])/.exec(src.slice(at + 1));
    if (!m) {
      cur.text += "$";
      return at + 1;
    }
    cur.text += `$${m[0]}`;
    cur.dynamic = true;
    return at + 1 + m[0].length;
  };

  while (i < src.length) {
    const c = src[i] as string;
    const start = i;
    if (c === "\\") {
      if (src[i + 1] === "\n") {
        i += 2;
        continue;
      }
      if (i + 1 >= src.length) throw new ParseError("trailing escape");
      const cur = word();
      cur.text += src[i + 1];
      cur.quoted = true;
      cur.raw += src.slice(i, i + 2);
      i += 2;
      continue;
    }
    if (c === " " || c === "\t" || c === "\r") {
      end();
      i++;
      continue;
    }
    if (c === "#" && !w) {
      while (i < src.length && src[i] !== "\n") i++;
      continue;
    }
    if (c === "\n") {
      end();
      toks.push({ kind: "op", value: ";" });
      i++;
      // heredoc bodies start on the next line
      for (const at of pending.splice(0)) {
        const target = toks[at + 1]?.word;
        if (!target) throw new ParseError("missing heredoc delimiter");
        const delim = target.text;
        const strip = toks[at]?.value.endsWith("<<-");
        const lines: string[] = [];
        let found = false;
        while (i < src.length) {
          const nl = src.indexOf("\n", i);
          const line = src.slice(i, nl < 0 ? src.length : nl);
          i = nl < 0 ? src.length : nl + 1;
          if ((strip ? line.replace(/^\t+/, "") : line) === delim) {
            found = true;
            break;
          }
          lines.push(line);
        }
        if (!found && delim === "") throw new ParseError("missing heredoc delimiter");
        docs.set(at, { body: lines.join("\n"), quoted: target.quoted });
      }
      continue;
    }
    if (c === "'") {
      const j = src.indexOf("'", i + 1);
      if (j < 0) throw new ParseError("unclosed single quote");
      const cur = word();
      cur.text += src.slice(i + 1, j);
      cur.quoted = true;
      cur.raw += src.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    if (c === "$" && src[i + 1] === "'") {
      let j = i + 2;
      for (; j < src.length && src[j] !== "'"; j++) if (src[j] === "\\") j++;
      if (j >= src.length) throw new ParseError("unclosed ANSI-C quote");
      const cur = word();
      cur.text += ansiC(src.slice(i + 2, j));
      cur.quoted = true;
      cur.raw += src.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    if (c === '"') {
      const close = closeDouble(src, i);
      const cur = word();
      cur.quoted = true;
      for (let k = i + 1; k < close; ) {
        const d = src[k] as string;
        if (d === "\\" && '$`"\\\n'.includes(src[k + 1] ?? "")) {
          if (src[k + 1] !== "\n") cur.text += src[k + 1];
          k += 2;
        } else if (d === "$") k = dollar(k);
        else if (d === "`") {
          const j = closeBacktick(src, k);
          sub(k, j + 1, src.slice(k + 1, j));
          k = j + 1;
        } else {
          cur.text += d;
          k++;
        }
      }
      cur.raw += src.slice(i, close + 1);
      i = close + 1;
      continue;
    }
    if (c === "$") {
      i = dollar(i);
      word().raw += src.slice(start, i);
      continue;
    }
    if (c === "`") {
      const j = closeBacktick(src, i);
      sub(i, j + 1, src.slice(i + 1, j));
      i = j + 1;
      word().raw += src.slice(start, i);
      continue;
    }
    if ((c === "<" || c === ">") && src[i + 1] === "(") {
      const close = closeParen(src, i + 1);
      sub(i, close, src.slice(i + 2, close - 1));
      i = close;
      word().raw += src.slice(start, i);
      continue;
    }
    const redir = REDIRS.find((r) => src.startsWith(r, i));
    if (redir && (redir[0] !== "&" || !w)) {
      // a word of digits right before it is its fd
      let fd: string | undefined;
      if (w && /^\d+$/.test(w.raw) && !w.quoted) {
        fd = w.text;
        w = undefined;
      } else end();
      if (redir === "<<" || redir === "<<-") pending.push(toks.length);
      toks.push({ kind: "redir", value: fd ? `${fd}${redir}` : redir });
      i += redir.length;
      continue;
    }
    const op = OPS.find((o) => src.startsWith(o, i));
    if (op) {
      end();
      toks.push({ kind: "op", value: op });
      i += op.length;
      continue;
    }
    const cur = word();
    if ("*?[".includes(c)) cur.glob = true;
    cur.text += c;
    cur.raw += c;
    i++;
  }
  end();

  // tokens → commands
  const cmds: Cmd[] = [];
  let cur: Cmd = { words: [], redirs: [] };
  let pipe = false;
  let skip = false;
  const flush = (op: string) => {
    if (cur.words.length || cur.redirs.length) {
      if (pipe) cur.pipedFrom = cmds.at(-1);
      cmds.push(cur);
    }
    pipe = op === "|" || op === "|&";
    cur = { words: [], redirs: [] };
    skip = false;
  };
  for (let t = 0; t < toks.length; t++) {
    const tok = toks[t] as Tok;
    if (tok.kind === "op") {
      flush(tok.value);
      continue;
    }
    if (tok.kind === "redir") {
      const target = toks[t + 1];
      if (target?.kind !== "word" || !target.word) throw new ParseError("missing redirection target");
      t++;
      const op = tok.value.replace(/^\d+/, "");
      const r: Redir = { op, target: target.word };
      const fd = tok.value.slice(0, tok.value.length - op.length);
      if (fd) r.fd = fd;
      if (op === "<<" || op === "<<-") r.heredoc = docs.get(t - 1) ?? { body: "", quoted: target.word.quoted };
      cur.redirs.push(r);
      continue;
    }
    const wd = tok.word as Word;
    if (skip) continue;
    if (!cur.words.length && !wd.quoted) {
      if (KEYWORDS.has(wd.text)) continue;
      if (ENDERS.has(wd.text)) continue;
      // `for x in …` / `case … in` / `select`: their header runs nothing
      if (wd.text === "for" || wd.text === "case" || wd.text === "select" || wd.text === "function") {
        skip = true;
        continue;
      }
    }
    cur.words.push(wd);
  }
  flush(";");
  return { cmds, subs };
}

/** `a{b,c}d` → [abd, acd] (one level, as bash would for a literal word); none → [text] */
export function braces(text: string): string[] {
  const m = /^(.*?)\{([^{}]*,[^{}]*)\}(.*)$/.exec(text);
  if (!m) return [text];
  return (m[2] ?? "").split(",").flatMap((part) => braces(`${m[1]}${part}${m[3]}`));
}
