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

  it("수는 number 토큰이다 — 타입 인자와 enum 값에 쓴다", () => {
    const { tokens } = lex("decimal(12,2)");
    expect(tokens.map((t) => [t.kind, t.value])).toEqual([
      ["ident", "decimal"], ["lparen", "("], ["number", "12"], ["comma", ","], ["number", "2"], ["rparen", ")"], ["eof", ""],
    ]);
  });

  it("백틱 이름은 벗겨서 quoted ident 로 낸다", () => {
    const { tokens, diagnostics } = lex("`order-items` `주문 번호`");
    expect(diagnostics).toEqual([]);
    expect(tokens.slice(0, 2).map((t) => [t.kind, t.value, t.quoted])).toEqual([
      ["ident", "order-items", true],
      ["ident", "주문 번호", true],
    ]);
    expect(tokens[0].span).toEqual({ line: 1, col: 1, len: 13 });
  });

  it("닫히지 않은 백틱과 빈 백틱은 오류", () => {
    expect(lex("`abc\nx").diagnostics.map((d) => d.message)).toEqual(["백틱 이름이 닫히지 않았습니다"]);
    expect(lex("``").diagnostics.map((d) => d.message)).toEqual(["빈 백틱 이름입니다"]);
  });

  it("영문 밖의 글자로 된 이름은 한 덩어리로 묶어 백틱을 권한다", () => {
    const { tokens, diagnostics } = lex("table 주문 {");
    expect(diagnostics.map((d) => [d.message, d.hint, d.span])).toEqual([
      ["영문 밖의 글자로 된 이름은 백틱으로 감싸야 합니다", "`주문` 처럼 적어 주세요", { line: 1, col: 7, len: 2 }],
    ]);
    expect(tokens.map((t) => t.kind)).toEqual(["ident", "ident", "lbrace", "eof"]);
  });

  it("모르는 글자는 오류로 남기고 건너뛴다", () => {
    const { tokens, diagnostics } = lex("a @ b");
    expect(diagnostics[0].span).toEqual({ line: 1, col: 3, len: 1 });
    expect(tokens.map((t) => t.value)).toEqual(["a", "b", ""]);
  });
});
