// SQL text → statements made of tokens, for the SQL importer (sql.ts).
//
// One tokenizer reads every dialect at once instead of asking which one the text is in. Their
// lexical rules hardly collide: names are quoted with "..." (standard, PostgreSQL, Oracle), `...`
// (MySQL) or [...] (SQL Server), strings with '...', comments start with --, /* or, at the start of
// a line, # (MySQL). Where two rules do collide, the one that fits schema dumps wins: a `[` that
// cannot start a name (`text[]`, `ARRAY[1]`) is punctuation, and backslash escapes in strings are on
// only when the text uses backticks, as every MySQL dump does.
//
// Statements end at `;` and at the batch separators dump tools write on a line of their own: `GO`
// (SQL Server), `/` (Oracle SQL*Plus) and whatever `DELIMITER` sets (MySQL, around procedure bodies).
// A line that starts with CREATE or ALTER outside parentheses also starts a new statement, so DDL
// copied from a tool that leaves out the semicolons does not run together into one statement.
// psql meta-commands (`\connect`, `\restrict`) and the data of `COPY ... FROM stdin` are skipped.
// MySQL's versioned comments (`/*!50001 CREATE VIEW ... */`) are code, not comments: dumps put
// statements in them, so only the markers are dropped.

export type SqlTokenKind = "word" | "quoted" | "string" | "number" | "punct";

export interface SqlToken {
  kind: SqlTokenKind;
  /** Standard double quotes preserve identifier case; other quoting follows dump conventions */
  caseSensitive?: boolean;
  /** A word as written, a quoted name without its quotes, a string unescaped, punctuation as written */
  value: string;
  /** The word in uppercase, for keyword checks; "" for other kinds */
  upper: string;
  /** 1-based, like resin's own spans */
  line: number;
  col: number;
  /** Offsets into `text`, to quote part of a statement back */
  start: number;
  end: number;
}

export interface SqlSource {
  /** The input with COPY data blanked out (line numbers unchanged); token offsets point into it */
  text: string;
  statements: SqlToken[][];
  notes: { message: string; line: number; col: number }[];
}

const ESCAPES: Record<string, string> = { n: "\n", r: "\r", t: "\t", "0": "", Z: "" };
const STRING_PREFIXES = new Set(["N", "E", "B", "X"]);

const isAsciiLetter = (c: number): boolean => (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
const isDigit = (c: number): boolean => c >= 48 && c <= 57;
const isWordStart = (s: string, i: number): boolean => {
  const c = s.charCodeAt(i);
  return isAsciiLetter(c) || c === 95 /* _ */ || c === 64 /* @ */ || (c > 127 && /\p{L}/u.test(s[i]));
};
const isWordPart = (s: string, i: number): boolean => {
  const c = s.charCodeAt(i);
  return isAsciiLetter(c) || isDigit(c) || c === 95 || c === 36 /* $ */ || c === 35 /* # */ || c === 64 || (c > 127 && /[\p{L}\p{N}]/u.test(s[i]));
};

/** pg_dump writes table data as `COPY t (...) FROM stdin;` followed by raw rows up to a `\.` line.
 *  The rows are not SQL (tabs, unbalanced quotes), so they are blanked before tokenizing */
function blankCopyData(source: string): string {
  if (!/^COPY\b/im.test(source)) return source;
  const lines = source.split("\n");
  let inData = false;
  for (let k = 0; k < lines.length; k++) {
    if (inData) {
      if (lines[k].replace(/\r$/, "") === "\\.") inData = false;
      lines[k] = "";
    } else if (/^COPY\b.*\bFROM\s+stdin\b/i.test(lines[k])) inData = true;
  }
  return lines.join("\n");
}

export function tokenize(source: string): SqlSource {
  const text = blankCopyData(source);
  const n = text.length;
  const backslashEscapes = text.includes("`");

  const lineStarts = [0];
  for (let k = 0; k < n; k++) if (text.charCodeAt(k) === 10) lineStarts.push(k + 1);
  /** Line and column of an offset, by binary search over the line starts */
  const where = (offset: number): { line: number; col: number } => {
    let lo = 0;
    let hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (lineStarts[mid] <= offset) lo = mid;
      else hi = mid - 1;
    }
    return { line: lo + 1, col: offset - lineStarts[lo] + 1 };
  };

  const statements: SqlToken[][] = [];
  const notes: SqlSource["notes"] = [];
  const note = (message: string, offset: number) => notes.push({ message, ...where(offset) });
  let current: SqlToken[] = [];
  /** Parentheses open in the current statement */
  let depth = 0;
  let openParenthesis = 0;
  const endStatement = () => {
    if (depth > 0) note("unterminated SQL parentheses; the statement may be incomplete", openParenthesis);
    if (current.length) statements.push(current);
    current = [];
    depth = 0;
  };
  const push = (kind: SqlTokenKind, value: string, start: number, end: number) => {
    const { line, col } = where(start);
    current.push({ kind, value, upper: kind === "word" ? value.toUpperCase() : "", line, col, start, end });
  };

  /** Only spaces and tabs between the start of the line and i */
  const atLineStart = (i: number): boolean => {
    for (let k = i - 1; k >= 0; k--) {
      const c = text[k];
      if (c === "\n") return true;
      if (c !== " " && c !== "\t" && c !== "\r") return false;
    }
    return true;
  };
  const lineEnd = (i: number): number => {
    const e = text.indexOf("\n", i);
    return e < 0 ? n : e;
  };

  /** A quoted run closed by `close`, where a doubled close stands for itself. Returns [value, end] */
  const quoted = (i: number, close: string, backslash: boolean): [string, number] => {
    let value = "";
    let j = i + 1;
    while (j < n) {
      const c = text[j];
      if (c === close) {
        if (text[j + 1] === close) {
          value += close;
          j += 2;
          continue;
        }
        return [value, j + 1];
      }
      if (backslash && c === "\\" && j + 1 < n) {
        const e = text[j + 1];
        value += ESCAPES[e] ?? e;
        j += 2;
        continue;
      }
      value += c;
      j++;
    }
    note(`unterminated SQL ${close === "'" ? "string" : "quoted name"}; the remaining input may be incomplete`, i);
    return [value, n];
  };

  let delimiter = ";";
  /** Inside a MySQL versioned comment, whose closing marker is to be dropped */
  let versioned = false;
  let versionedStart = 0;
  let i = 0;
  while (i < n) {
    const c = text[i];
    const code = text.charCodeAt(i);

    if (c === " " || c === "\t" || c === "\n" || c === "\r" || c === "\f" || code === 0xfeff || code === 0xa0) {
      i++;
      continue;
    }
    if (delimiter !== ";" && text.startsWith(delimiter, i)) {
      endStatement();
      i += delimiter.length;
      continue;
    }
    // Lines that mean something on their own: batch separators, DELIMITER, psql meta-commands, # comments
    if ((c === "G" || c === "g" || c === "/" || c === "D" || c === "d" || c === "\\" || c === "#") && atLineStart(i)) {
      const e = lineEnd(i);
      const rest = text.slice(i, e).trimEnd();
      if (c === "\\" || c === "#" || /^GO(\s+\d+)?$/i.test(rest) || rest === "/") {
        if (c !== "\\" && c !== "#") endStatement();
        i = e;
        continue;
      }
      const set = /^DELIMITER\s+(\S+)$/i.exec(rest);
      if (set) {
        endStatement();
        delimiter = set[1];
        i = e;
        continue;
      }
    }
    if (c === "-" && text[i + 1] === "-") {
      i = lineEnd(i);
      continue;
    }
    if (c === "/" && text[i + 1] === "*") {
      if (text[i + 2] === "!") {
        versionedStart = i;
        i += 3;
        while (isDigit(text.charCodeAt(i))) i++;
        versioned = true;
        continue;
      }
      const e = text.indexOf("*/", i + 2);
      if (e < 0) note("unterminated SQL comment; the remaining input was skipped", i);
      i = e < 0 ? n : e + 2;
      continue;
    }
    if (versioned && c === "*" && text[i + 1] === "/") {
      versioned = false;
      i += 2;
      continue;
    }
    if (c === "'") {
      const [value, end] = quoted(i, "'", backslashEscapes);
      push("string", value, i, end);
      i = end;
      continue;
    }
    if (c === '"' || c === "`") {
      const [value, end] = quoted(i, c, false);
      push("quoted", value, i, end);
      if (c === '"') current[current.length - 1].caseSensitive = true;
      i = end;
      continue;
    }
    if (c === "[" && i + 1 < n && isWordStart(text, i + 1)) {
      const [value, end] = quoted(i, "]", false);
      push("quoted", value, i, end);
      i = end;
      continue;
    }
    if (c === "$") {
      // PostgreSQL dollar quoting, mostly function bodies: $$ ... $$ or $tag$ ... $tag$
      const tag = /\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/y;
      tag.lastIndex = i;
      if (tag.test(text)) {
        const open = text.slice(i, tag.lastIndex);
        const close = text.indexOf(open, tag.lastIndex);
        if (close < 0) note("unterminated SQL dollar quote; the remaining input may be incomplete", i);
        const end = close < 0 ? n : close + open.length;
        push("string", text.slice(tag.lastIndex, close < 0 ? n : close), i, end);
        i = end;
        continue;
      }
    }
    if (isDigit(code) || (c === "." && isDigit(text.charCodeAt(i + 1)))) {
      const num = /\d*\.?\d+(?:[eE][+-]?\d+)?/y;
      num.lastIndex = i;
      num.test(text);
      push("number", text.slice(i, num.lastIndex), i, num.lastIndex);
      i = num.lastIndex;
      continue;
    }
    if (isWordStart(text, i)) {
      let j = i + 1;
      while (j < n && isWordPart(text, j)) j++;
      const word = text.slice(i, j);
      if (depth === 0 && delimiter === ";" && current.length > 0 && /^(?:CREATE|ALTER)$/i.test(word) && atLineStart(i)) endStatement();
      // A string with a prefix: N'...', E'...', B'...', X'...', or a MySQL charset introducer _utf8mb4'...'
      if (text[j] === "'" && (STRING_PREFIXES.has(word.toUpperCase()) || word.startsWith("_"))) {
        const [value, end] = quoted(j, "'", backslashEscapes || word.toUpperCase() === "E");
        push("string", value, i, end);
        i = end;
        continue;
      }
      push("word", word, i, j);
      i = j;
      continue;
    }
    if (c === ";") {
      if (delimiter === ";") endStatement();
      else push("punct", c, i, i + 1);
      i++;
      continue;
    }
    if (c === ":" && text[i + 1] === ":") {
      push("punct", "::", i, i + 2);
      i += 2;
      continue;
    }
    if (c === "(") {
      if (depth === 0) openParenthesis = i;
      depth++;
    }
    else if (c === ")") depth = Math.max(0, depth - 1);
    push("punct", c, i, i + 1);
    i++;
  }
  endStatement();
  if (versioned) note("unterminated SQL versioned comment; the remaining input may be incomplete", versionedStart);
  return { text, statements, notes };
}
