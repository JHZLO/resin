// 토큰 열 → 구문 트리. 손으로 쓴 재귀 하강 파서다 — 문법이 작고, 오류 메시지를 한 문장씩
// 다듬어야 해서 생성기(PEG 등)보다 이쪽이 싸다. 문법의 정본은 docs/SPEC.md §3.
//
// 오류 복구: 한 줄(컬럼, 제약)에서 틀리면 그 줄 끝까지 건너뛰고 다음 줄부터 다시 읽는다.
// 그래서 오류가 여럿이어도 한 번에 다 보고된다. 틀린 줄의 노드는 트리에 넣지 않는다.

import type { Audit, Column, Document, Ident, Ref, Span, Table, TableConstraint } from "./ast.ts";
import { type Diagnostic, error } from "./diagnostics.ts";
import { type Token, type TokenKind, lex } from "./lexer.ts";

/** 한 줄을 버려야 할 때 던진다. 진단은 던지기 전에 이미 쌓여 있다 */
class LineError extends Error {}

const COLUMN_MODIFIERS = ["pk", "uk", "enc", "enum", "index", "->", "~>", '"설명"'];

export function parse(source: string): { doc: Document; diagnostics: Diagnostic[] } {
  const lexed = lex(source);
  const p = new Parser(lexed.tokens);
  const doc = p.document();
  return { doc, diagnostics: [...lexed.diagnostics, ...p.diagnostics] };
}

class Parser {
  readonly diagnostics: Diagnostic[] = [];
  private pos = 0;
  private readonly tokens: Token[];

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  // ---- 토큰 도우미 ----

  private peek(offset = 0): Token {
    return this.tokens[Math.min(this.pos + offset, this.tokens.length - 1)];
  }
  private next(): Token {
    const t = this.peek();
    if (t.kind !== "eof") this.pos++;
    return t;
  }
  private at(kind: TokenKind, offset = 0): boolean {
    return this.peek(offset).kind === kind;
  }
  private atWord(word: string, offset = 0): boolean {
    const t = this.peek(offset);
    return t.kind === "ident" && t.value === word;
  }
  private skipNewlines(): void {
    while (this.at("newline")) this.next();
  }
  /** 줄 끝(또는 eof)까지 버린다. 줄바꿈 자체는 남긴다. `}` 에서도 멈춘다 — 블록 끝을 먹으면 복구가 더 꼬인다 */
  private skipLine(): void {
    while (!this.at("newline") && !this.at("eof") && !this.at("rbrace")) this.next();
  }

  private fail(message: string, span: Span, hint?: string): never {
    this.diagnostics.push(error(message, span, hint));
    throw new LineError(message);
  }
  private expect(kind: TokenKind, what: string): Token {
    const t = this.peek();
    if (t.kind === kind) return this.next();
    return this.fail(`${what} 필요 (실제: ${describe(t)})`, t.span);
  }
  private ident(what: string): Ident {
    const t = this.expect("ident", what);
    return { text: t.value, span: t.span };
  }

  // ---- 문서 ----

  document(): Document {
    const tables: Table[] = [];
    this.skipNewlines();
    if (this.atWord("erd")) {
      this.next();
      this.endOfStatement();
    } else {
      this.diagnostics.push(error("문서는 `erd` 로 시작해야 합니다", this.peek().span, "첫 줄에 `erd` 를 적어 주세요"));
    }

    for (;;) {
      this.skipNewlines();
      if (this.at("eof")) break;
      try {
        if (this.atWord("table")) tables.push(this.table());
        else this.fail(`알 수 없는 문장 ${describe(this.peek())}`, this.peek().span, "최상위에는 `table` 만 올 수 있습니다");
      } catch (e) {
        if (!(e instanceof LineError)) throw e;
        this.recoverTopLevel();
      }
    }
    return { tables };
  }

  /** 최상위 오류 뒤: 다음 `table` 로 시작하는 줄까지 건너뛴다 */
  private recoverTopLevel(): void {
    while (!this.at("eof")) {
      if (this.at("newline") && this.atWord("table", 1)) return;
      this.next();
    }
  }

  private endOfStatement(): void {
    if (this.at("newline") || this.at("eof")) return;
    this.fail(`줄이 끝나야 합니다 (실제: ${describe(this.peek())})`, this.peek().span);
  }

  // ---- 테이블 ----

  private table(): Table {
    const kw = this.next(); // table
    const name = this.ident("테이블 이름");
    const label = this.at("string") ? this.next().value : null;
    this.expect("lbrace", "`{`");

    const columns: Column[] = [];
    const constraints: TableConstraint[] = [];
    for (;;) {
      this.skipNewlines();
      if (this.at("rbrace")) break;
      if (this.at("eof")) {
        this.diagnostics.push(error(`테이블 \`${name.text}\` 의 \`}\` 가 없습니다`, name.span));
        return { name, label, columns, constraints, audit: null, span: kw.span };
      }
      try {
        if (this.atConstraint()) constraints.push(this.constraint());
        else columns.push(this.column());
      } catch (e) {
        if (!(e instanceof LineError)) throw e;
        this.skipLine();
      }
    }
    this.next(); // }

    let audit: Audit | null = null;
    if (this.atWord("audit")) {
      const a = this.next();
      audit = { columns: this.at("lparen") ? this.list("감사할 컬럼 이름") : null, span: a.span };
    }
    this.endOfStatement();
    return { name, label, columns, constraints, audit, span: kw.span };
  }

  /** `unique(` / `unique name(` / `index(` / `index name(` — 뒤에 `(` 가 와야 제약이다.
   *  그래야 `index int` 같은 "index 라는 컬럼"과 겹치지 않는다 */
  private atConstraint(): boolean {
    if (!this.atWord("unique") && !this.atWord("index")) return false;
    return this.at("lparen", 1) || (this.at("ident", 1) && this.at("lparen", 2));
  }

  private constraint(): TableConstraint {
    const kw = this.next();
    const name = this.at("ident") ? this.ident("제약 이름") : null;
    const columns = this.list("컬럼 이름");
    if (columns.length === 0) this.fail("컬럼을 하나 이상 적어야 합니다", kw.span);
    this.endOfMember();
    return { kind: kw.value === "unique" ? "unique" : "index", name, columns, span: kw.span };
  }

  // ---- 컬럼 ----

  private column(): Column {
    const name = this.ident("컬럼 이름");
    if (this.at("newline") || this.at("rbrace") || this.at("eof"))
      this.fail(`컬럼 \`${name.text}\` 의 타입이 없습니다`, name.span, "`이름 타입` 순서로 적습니다. 예) `id bigint pk`");
    const type = this.ident("타입");
    const nullable = this.at("question");
    if (nullable) this.next();

    const col: Column = {
      name,
      type,
      nullable,
      pk: false,
      uk: false,
      enc: false,
      enumValues: null,
      index: null,
      ref: null,
      description: null,
      span: name.span,
    };

    const dup = (what: string, span: Span) => this.fail(`\`${what}\` 를 두 번 적었습니다`, span);

    while (!this.at("newline") && !this.at("eof") && !this.at("rbrace")) {
      const t = this.peek();
      if (t.kind === "string") {
        if (col.description !== null) dup("설명", t.span);
        col.description = this.next().value;
      } else if (t.kind === "arrow" || t.kind === "tildeArrow") {
        if (col.ref) dup("참조", t.span);
        col.ref = this.ref();
      } else if (t.kind === "ident" && (t.value === "pk" || t.value === "uk" || t.value === "enc")) {
        if (col[t.value]) dup(t.value, t.span);
        this.next();
        col[t.value] = true;
      } else if (this.atWord("enum")) {
        if (col.enumValues) dup("enum", t.span);
        this.next();
        col.enumValues = this.list("enum 값");
        if (col.enumValues.length === 0) this.fail("enum 값을 하나 이상 적어야 합니다", t.span);
      } else if (this.atWord("index")) {
        if (col.index) dup("index", t.span);
        this.next();
        let idxName: Ident | null = null;
        if (this.at("lparen")) {
          this.next();
          idxName = this.ident("인덱스 이름");
          this.expect("rparen", "`)`");
        }
        col.index = { name: idxName, span: t.span };
      } else {
        this.fail(
          `알 수 없는 수식어 ${describe(t)}`,
          t.span,
          `컬럼 뒤에는 ${COLUMN_MODIFIERS.join(", ")} 가 올 수 있습니다`,
        );
      }
    }
    return col;
  }

  private ref(): Ref {
    const arrow = this.next();
    const table = this.ident("참조할 테이블 이름");
    let column: Ident | null = null;
    if (this.at("dot")) {
      this.next();
      column = this.ident("참조할 컬럼 이름");
    }
    return { kind: arrow.kind === "arrow" ? "physical" : "logical", table, column, span: arrow.span };
  }

  // ---- 공통 ----

  private endOfMember(): void {
    if (this.at("newline") || this.at("eof") || this.at("rbrace")) return;
    this.fail(`줄이 끝나야 합니다 (실제: ${describe(this.peek())})`, this.peek().span);
  }

  /** `( a, b, c )` — 괄호 안에서는 줄바꿈을 무시하고 끝 쉼표를 허용한다 */
  private list(what: string): Ident[] {
    this.expect("lparen", "`(`");
    const items: Ident[] = [];
    for (;;) {
      this.skipNewlines();
      if (this.at("rparen")) break;
      items.push(this.ident(what));
      this.skipNewlines();
      if (this.at("comma")) {
        this.next();
        continue;
      }
      if (!this.at("rparen")) this.fail(`\`,\` 또는 \`)\` 필요 (실제: ${describe(this.peek())})`, this.peek().span);
    }
    this.next(); // )
    return items;
  }
}

function describe(t: Token): string {
  switch (t.kind) {
    case "ident":
      return `\`${t.value}\``;
    case "string":
      return "문자열";
    case "newline":
      return "줄바꿈";
    case "eof":
      return "파일 끝";
    default:
      return `\`${t.value}\``;
  }
}
