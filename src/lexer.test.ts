import { describe, expect, it } from "vitest";
import { lex } from "./lexer.ts";

const kinds = (src: string) => lex(src).tokens.map((t) => t.kind);

describe("lex", () => {
  it("기호와 화살표를 구분한다", () => {
    expect(kinds("{ } ( ) , . ? -> ~>")).toEqual([
      "lbrace", "rbrace", "lparen", "rparen", "comma", "dot", "question", "arrow", "tildeArrow", "eof",
    ]);
  });

  it("키워드도 ident 로 낸다 — 무엇이 키워드인지는 파서가 정한다", () => {
    const { tokens } = lex("table index pk");
    expect(tokens.slice(0, 3).map((t) => [t.kind, t.value])).toEqual([
      ["ident", "table"],
      ["ident", "index"],
      ["ident", "pk"],
    ]);
  });

  it("타입 바로 뒤 ? 를 따로 낸다", () => {
    expect(kinds("varchar?")).toEqual(["ident", "question", "eof"]);
  });

  it("%% 주석은 줄 끝까지 버리고 줄바꿈은 남긴다", () => {
    expect(kinds("a %% 주석 -> {\nb")).toEqual(["ident", "newline", "ident", "eof"]);
  });

  it("문자열 이스케이프는 \\\" 와 \\\\ 만 푼다", () => {
    const { tokens, diagnostics } = lex('"a \\"b\\" \\\\ \\n"');
    expect(diagnostics).toEqual([]);
    expect(tokens[0].value).toBe('a "b" \\ \\n');
  });

  it("닫히지 않은 문자열은 오류를 남기고 다음 줄부터 계속 읽는다", () => {
    const { tokens, diagnostics } = lex('"abc\nnext');
    expect(diagnostics.map((d) => d.message)).toEqual(["문자열이 닫히지 않았습니다"]);
    expect(tokens.map((t) => t.kind)).toEqual(["string", "newline", "ident", "eof"]);
  });

  it("위치는 1부터 센 줄, 열이다", () => {
    const { tokens } = lex("erd\n  table t");
    const t = tokens.find((x) => x.value === "t")!;
    expect(t.span).toEqual({ line: 2, col: 9, len: 1 });
  });

  it("모르는 글자는 오류로 남기고 건너뛴다", () => {
    const { tokens, diagnostics } = lex("a @ b");
    expect(diagnostics[0].span).toEqual({ line: 1, col: 3, len: 1 });
    expect(tokens.map((t) => t.value)).toEqual(["a", "b", ""]);
  });
});
