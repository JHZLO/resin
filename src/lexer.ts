// Source text → tokens. Keywords are not a separate token kind: resin's keywords are contextual
// (a column may be called `index`), so the parser, which knows the position, decides what is a keyword.
//
// Backtick names (`order-items`) are emitted as idents marked `quoted` — they are never keywords.
// Newlines are tokens (they end statements). Runs of blank lines are kept; the parser skips them.
// Unknown characters and unterminated strings leave a diagnostic and lexing goes on, so that one
// run can report several errors.

import type { Span } from "./ast.ts";
import { type Diagnostic, error } from "./diagnostics.ts";

export type TokenKind =
  | "ident"
  | "number"
  | "string"
  | "lbrace"
  | "rbrace"
  | "lparen"
  | "rparen"
  | "comma"
  | "dot"
  | "question"
  | "arrow" // ->
  | "tildeArrow" // ~>
  | "newline"
  | "eof";

export interface Token {
  kind: TokenKind;
  /** The name for idents (backticks stripped), the unescaped value for strings, the source text otherwise */
  value: string;
  span: Span;
  /** An ident written in backticks */
  quoted?: boolean;
}

const SINGLE: Record<string, TokenKind> = {
  "{": "lbrace",
  "}": "rbrace",
  "(": "lparen",
  ")": "rparen",
  ",": "comma",
  ".": "dot",
  "?": "question",
};

const isIdentStart = (c: string): boolean => /[A-Za-z_]/.test(c);
const isIdentPart = (c: string): boolean => /[A-Za-z0-9_]/.test(c);

export function lex(source: string): { tokens: Token[]; diagnostics: Diagnostic[] } {
  const tokens: Token[] = [];
  const diagnostics: Diagnostic[] = [];
  let i = 0;
  let line = 1;
  let lineStart = 0;

  const span = (start: number, end: number): Span => ({ line, col: start - lineStart + 1, len: end - start });
  const push = (kind: TokenKind, value: string, start: number, end: number) =>
    tokens.push({ kind, value, span: span(start, end) });

  while (i < source.length) {
    const c = source[i];

    if (c === " " || c === "\t" || c === "\r") {
      i++;
      continue;
    }
    if (c === "\n") {
      push("newline", "\n", i, i + 1);
      i++;
      line++;
      lineStart = i;
      continue;
    }
    if (c === "%" && source[i + 1] === "%") {
      while (i < source.length && source[i] !== "\n") i++;
      continue;
    }
    if (c === "-" && source[i + 1] === ">") {
      push("arrow", "->", i, i + 2);
      i += 2;
      continue;
    }
    if (c === "~" && source[i + 1] === ">") {
      push("tildeArrow", "~>", i, i + 2);
      i += 2;
      continue;
    }
    const single = SINGLE[c];
    if (single) {
      push(single, c, i, i + 1);
      i++;
      continue;
    }
    if (c >= "0" && c <= "9") {
      const start = i;
      while (i < source.length && source[i] >= "0" && source[i] <= "9") i++;
      push("number", source.slice(start, i), start, i);
      continue;
    }
    if (c === "`") {
      const start = i;
      i++;
      while (i < source.length && source[i] !== "`" && source[i] !== "\n") i++;
      const closed = source[i] === "`";
      const value = source.slice(start + 1, i);
      if (closed) i++;
      if (!closed) diagnostics.push(error("unterminated backtick name", span(start, i), "close the name with a backtick on the same line"));
      else if (value.length === 0) diagnostics.push(error("empty backtick name", span(start, i)));
      tokens.push({ kind: "ident", value, span: span(start, i), quoted: true });
      continue;
    }
    if (isIdentStart(c)) {
      const start = i;
      while (i < source.length && isIdentPart(source[i])) i++;
      push("ident", source.slice(start, i), start, i);
      continue;
    }
    if (c === '"') {
      const start = i;
      i++;
      let value = "";
      let closed = false;
      while (i < source.length && source[i] !== "\n") {
        const ch = source[i];
        if (ch === '"') {
          closed = true;
          i++;
          break;
        }
        if (ch === "\\" && (source[i + 1] === '"' || source[i + 1] === "\\")) {
          value += source[i + 1];
          i += 2;
          continue;
        }
        value += ch;
        i++;
      }
      if (!closed) diagnostics.push(error("unterminated string", span(start, i), 'close the string with `"` on the same line'));
      push("string", value, start, i);
      continue;
    }

    // A name made of non-ASCII letters (Hangul and the like). Report it once as a whole instead of
    // once per character, and emit it as a name so no follow-up errors ("expected a table name") pile up.
    if (/\p{L}/u.test(c)) {
      const start = i;
      while (i < source.length && /[\p{L}\p{N}_]/u.test(source[i])) i++;
      const value = source.slice(start, i);
      diagnostics.push(error("names with non-ASCII letters must be wrapped in backticks", span(start, i), `write it as \`${value}\``));
      tokens.push({ kind: "ident", value, span: span(start, i), quoted: true });
      continue;
    }
    diagnostics.push(error(`unexpected character \`${c}\``, span(i, i + 1)));
    i++;
  }

  push("eof", "", i, i);
  return { tokens, diagnostics };
}
