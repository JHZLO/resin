// 원문 → 토큰 열. 키워드는 따로 두지 않고 전부 ident 로 낸다 — Resin 의 키워드는 문맥 키워드라
// (`index` 라는 컬럼도 된다) 무엇이 키워드인지는 자리를 아는 파서가 정한다.
//
// 줄바꿈은 토큰이다(문장 구분자). 빈 줄이 여러 개여도 그대로 내고, 파서가 건너뛴다.
// 모르는 글자와 닫히지 않은 문자열은 진단을 남기고 계속 읽는다 — 한 번에 여러 오류를 보여주려고.

import type { Span } from "./ast.ts";
import { type Diagnostic, error } from "./diagnostics.ts";

export type TokenKind =
  | "ident"
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
  /** ident 는 이름, string 은 이스케이프를 푼 값, 나머지는 원문 그대로 */
  value: string;
  span: Span;
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
      if (!closed)
        diagnostics.push(error("문자열이 닫히지 않았습니다", span(start, i), '문자열은 한 줄 안에서 `"` 로 닫아야 합니다'));
      push("string", value, start, i);
      continue;
    }

    diagnostics.push(error(`알 수 없는 문자 \`${c}\``, span(i, i + 1)));
    i++;
  }

  push("eof", "", i, i);
  return { tokens, diagnostics };
}
