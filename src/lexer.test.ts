import { describe, expect, it } from "vitest";
import { lex } from "./lexer.ts";

const kinds = (src: string) => lex(src).tokens.map((t) => t.kind);

describe("lex", () => {
  it("tells punctuation and arrows apart", () => {
    expect(kinds("{ } ( ) , . ? -> ~>")).toEqual([
      "lbrace", "rbrace", "lparen", "rparen", "comma", "dot", "question", "arrow", "tildeArrow", "eof",
    ]);
  });

  it("emits keywords as idents; the parser decides what is a keyword", () => {
    const { tokens } = lex("table index pk");
    expect(tokens.slice(0, 3).map((t) => [t.kind, t.value])).toEqual([
      ["ident", "table"],
      ["ident", "index"],
      ["ident", "pk"],
    ]);
  });

  it("emits the ? after a type as its own token", () => {
    expect(kinds("varchar?")).toEqual(["ident", "question", "eof"]);
  });

  it("drops %% comments up to the end of the line and keeps the newline", () => {
    expect(kinds("a %% note -> {\nb")).toEqual(["ident", "newline", "ident", "eof"]);
  });

  it('unescapes only \\" and \\\\ in strings', () => {
    const { tokens, diagnostics } = lex('"a \\"b\\" \\\\ \\n"');
    expect(diagnostics).toEqual([]);
    expect(tokens[0].value).toBe('a "b" \\ \\n');
  });

  it("reports an unterminated string and carries on with the next line", () => {
    const { tokens, diagnostics } = lex('"abc\nnext');
    expect(diagnostics.map((d) => d.message)).toEqual(["unterminated string"]);
    expect(tokens.map((t) => t.kind)).toEqual(["string", "newline", "ident", "eof"]);
  });

  it("counts lines and columns from 1", () => {
    const { tokens } = lex("table a {\n  id int\n}");
    const t = tokens.find((x) => x.value === "int")!;
    expect(t.span).toEqual({ line: 2, col: 6, len: 3 });
  });

  it("emits numbers for type arguments and enum values", () => {
    const { tokens } = lex("decimal(12,2)");
    expect(tokens.map((t) => [t.kind, t.value])).toEqual([
      ["ident", "decimal"], ["lparen", "("], ["number", "12"], ["comma", ","], ["number", "2"], ["rparen", ")"], ["eof", ""],
    ]);
  });

  it("strips backticks and marks the ident as quoted", () => {
    const { tokens, diagnostics } = lex("`order-items` `주문 번호`");
    expect(diagnostics).toEqual([]);
    expect(tokens.slice(0, 2).map((t) => [t.kind, t.value, t.quoted])).toEqual([
      ["ident", "order-items", true],
      ["ident", "주문 번호", true],
    ]);
    expect(tokens[0].span).toEqual({ line: 1, col: 1, len: 13 });
  });

  it("reports unterminated and empty backtick names", () => {
    expect(lex("`abc\nx").diagnostics.map((d) => d.message)).toEqual(["unterminated backtick name"]);
    expect(lex("``").diagnostics.map((d) => d.message)).toEqual(["empty backtick name"]);
  });

  it("reports a non-ASCII name once, as a whole, and suggests backticks", () => {
    const { tokens, diagnostics } = lex("table 주문 {");
    expect(diagnostics.map((d) => [d.message, d.hint, d.span])).toEqual([
      ["names with non-ASCII letters must be wrapped in backticks", "write it as `주문`", { line: 1, col: 7, len: 2 }],
    ]);
    expect(tokens.map((t) => t.kind)).toEqual(["ident", "ident", "lbrace", "eof"]);
  });

  it("reports and skips unexpected characters", () => {
    const { tokens, diagnostics } = lex("a @ b");
    expect(diagnostics[0]).toMatchObject({ message: "unexpected character `@`", span: { line: 1, col: 3, len: 1 } });
    expect(tokens.map((t) => t.value)).toEqual(["a", "b", ""]);
  });
});
