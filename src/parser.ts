// 토큰 열 → 구문 트리. 손으로 쓴 재귀 하강 파서다 — 문법이 작고, 오류 메시지를 한 문장씩
// 다듬어야 해서 생성기(PEG 등)보다 이쪽이 싸다. 문법의 정본은 docs/SPEC.md §3.
//
// 오류 복구: 한 줄(컬럼, 제약)에서 틀리면 그 줄 끝까지 건너뛰고 다음 줄부터 다시 읽는다.
// 그래서 오류가 여럿이어도 한 번에 다 보고된다. 틀린 줄의 노드는 트리에 넣지 않는다.
//
// v0.1 문법(첫 줄 `erd`, `index(이름)`, `unique 이름(a, b)`, 방식 없는 `audit`)은 알아보고
// 고치는 법을 hint 로 알려 준다 — SPEC §7.

import type { Audit, Column, Document, EnumValue, Ident, Ref, Span, Table, TableConstraint, TypeRef } from "./ast.ts";
import { type Diagnostic, error } from "./diagnostics.ts";
import { type Token, type TokenKind, lex } from "./lexer.ts";

/** 한 줄을 버려야 할 때 던진다. 진단은 던지기 전에 이미 쌓여 있다 */
class LineError extends Error {}

const COLUMN_MODIFIERS = ["pk", "uk", "enc", "enum", "index", "->", "~>", '"설명"'];
const MODIFIER_WORDS = new Set(["pk", "uk", "enc", "enum", "index", "as"]);

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
  /** 키워드 자리 확인. 백틱 이름은 키워드가 아니다 */
  private atWord(word: string, offset = 0): boolean {
    const t = this.peek(offset);
    return t.kind === "ident" && !t.quoted && t.value === word;
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
  /** 이름 자리 — 맨 이름이든 백틱 이름이든 받는다 */
  private name(what: string): Ident {
    const t = this.expect("ident", what);
    return t.quoted ? { text: t.value, span: t.span, quoted: true } : { text: t.value, span: t.span };
  }

  // ---- 문서 ----

  document(): Document {
    const tables: Table[] = [];
    for (;;) {
      this.skipNewlines();
      if (this.at("eof")) break;
      try {
        if (this.atWord("table")) tables.push(this.table(null));
        else if (this.atWord("external")) {
          const ext = this.next();
          if (!this.atWord("table")) this.fail("`external` 뒤에는 `table` 이 와야 합니다", this.peek().span, "`external table 이름 { ... }`");
          tables.push(this.table(ext));
        } else if (this.atWord("erd"))
          this.fail("v0.2 부터 첫 줄에 `erd` 를 쓰지 않습니다", this.peek().span, "이 줄을 지워 주세요");
        else
          this.fail(`알 수 없는 문장 ${describe(this.peek())}`, this.peek().span, "최상위에는 `table` 과 `external table` 만 올 수 있습니다");
      } catch (e) {
        if (!(e instanceof LineError)) throw e;
        this.recoverTopLevel();
      }
    }
    return { tables };
  }

  /** 최상위 오류 뒤: 다음 `table` / `external` 로 시작하는 줄까지 건너뛴다 */
  private recoverTopLevel(): void {
    while (!this.at("eof")) {
      if (this.at("newline") && (this.atWord("table", 1) || this.atWord("external", 1))) return;
      this.next();
    }
  }

  private endOfStatement(): void {
    if (this.at("newline") || this.at("eof")) return;
    this.fail(`줄이 끝나야 합니다 (실제: ${describe(this.peek())})`, this.peek().span);
  }

  // ---- 테이블 ----

  private table(external: Token | null): Table {
    const kw = this.next(); // table
    const span = external ? external.span : kw.span;
    const name = this.name("테이블 이름");
    const description = this.at("string") ? this.next().value : null;
    this.expect("lbrace", "`{`");

    const columns: Column[] = [];
    const constraints: TableConstraint[] = [];
    const done = (audit: Audit | null): Table => ({
      name,
      external: external !== null,
      description,
      columns,
      constraints,
      audit,
      span,
    });
    for (;;) {
      this.skipNewlines();
      if (this.at("rbrace")) break;
      if (this.at("eof")) {
        this.diagnostics.push(error(`테이블 \`${name.text}\` 의 \`}\` 가 없습니다`, name.span));
        return done(null);
      }
      try {
        if (this.atConstraint()) constraints.push(this.constraint());
        else {
          this.rejectOldConstraint();
          columns.push(this.column());
        }
      } catch (e) {
        if (!(e instanceof LineError)) throw e;
        this.skipLine();
      }
    }
    this.next(); // }

    const audit = this.atWord("audit") ? this.audit() : null;
    this.endOfStatement();
    return done(audit);
  }

  /** `unique(` / `index(` — 키워드 바로 뒤가 `(` 일 때만 제약이다.
   *  그래야 `index int` 나 `index varchar(32)` 같은 "index 라는 컬럼"과 겹치지 않는다 */
  private atConstraint(): boolean {
    return (this.atWord("unique") || this.atWord("index")) && this.at("lparen", 1);
  }

  /** v0.1 의 `unique 이름(a, b)` — 괄호 안이 수가 아니라 이름이면 타입 인자가 아니라 옛 제약이다 */
  private rejectOldConstraint(): void {
    if ((this.atWord("unique") || this.atWord("index")) && this.at("ident", 1) && this.at("lparen", 2) && this.at("ident", 3)) {
      const kw = this.peek();
      this.fail("v0.2 부터 제약 이름은 괄호 뒤 `as` 로 적습니다", kw.span, `\`${kw.value}(${this.peek(3).value}, ...) as ${this.peek(1).value}\``);
    }
  }

  private constraint(): TableConstraint {
    const kw = this.next();
    const columns = this.list("컬럼 이름");
    if (columns.length === 0) this.fail("컬럼을 하나 이상 적어야 합니다", kw.span);
    let name: Ident | null = null;
    if (this.atWord("as")) {
      this.next();
      name = this.name("제약 이름");
    }
    this.endOfMember();
    return { kind: kw.value === "unique" ? "unique" : "index", name, columns, span: kw.span };
  }

  private audit(): Audit {
    const a = this.next();
    if (this.at("lparen") || this.at("newline") || this.at("eof"))
      this.fail("`audit` 뒤에 감사 방식을 적어야 합니다", a.span, "v0.2 부터 `audit envers(a, b)` 또는 `audit envers` 로 적습니다");
    const method = this.name("감사 방식");
    const columns = this.at("lparen") ? this.list("감사할 컬럼 이름") : null;
    return { method, columns, span: a.span };
  }

  // ---- 컬럼 ----

  private column(): Column {
    const name = this.name("컬럼 이름");
    if (this.at("newline") || this.at("rbrace") || this.at("eof"))
      this.fail(`컬럼 \`${name.text}\` 의 타입이 없습니다`, name.span, "`이름 타입` 순서로 적습니다. 예) `id bigint pk`");
    const type = this.typeRef();
    const nullable = this.at("question");
    if (nullable) this.next();

    const col: Column = {
      name,
      type,
      nullable,
      pk: false,
      uk: null,
      enc: false,
      enumValues: null,
      index: null,
      ref: null,
      description: null,
      span: name.span,
    };

    const dup = (what: string, span: Span) => this.fail(`\`${what}\` 를 두 번 적었습니다`, span);
    /** 바로 앞에 이름을 받을 수 있는 수식어(uk, index)가 왔나 — 맨 이름을 적은 실수에 hint 를 주려고 */
    let named: string | null = null;

    while (!this.at("newline") && !this.at("eof") && !this.at("rbrace")) {
      const t = this.peek();
      const after = named;
      named = null;
      if (t.kind === "string") {
        if (col.description !== null) dup("설명", t.span);
        col.description = this.next().value;
      } else if (t.kind === "arrow" || t.kind === "tildeArrow") {
        if (col.ref) dup("참조", t.span);
        col.ref = this.ref();
      } else if (this.atWord("pk") || this.atWord("enc")) {
        const key = t.value as "pk" | "enc";
        if (col[key]) dup(key, t.span);
        this.next();
        col[key] = true;
      } else if (this.atWord("uk")) {
        if (col.uk) dup("uk", t.span);
        this.next();
        col.uk = { name: this.optionalAs("유니크 이름"), span: t.span };
        if (!col.uk.name) named = "uk";
      } else if (this.atWord("index")) {
        if (col.index) dup("index", t.span);
        this.next();
        if (this.at("lparen"))
          this.fail("v0.2 부터 인덱스 이름은 `as` 뒤에 적습니다", this.peek().span, `\`index as ${this.peek(1).value}\``);
        col.index = { name: this.optionalAs("인덱스 이름"), span: t.span };
        if (!col.index.name) named = "index";
      } else if (this.atWord("enum")) {
        if (col.enumValues) dup("enum", t.span);
        this.next();
        col.enumValues = this.values("enum 값");
        if (col.enumValues.length === 0) this.fail("enum 값을 하나 이상 적어야 합니다", t.span);
      } else if (this.atWord("as")) {
        this.fail("`as` 는 `uk` 나 `index` 바로 뒤에만 옵니다", t.span);
      } else if (after && t.kind === "ident" && !MODIFIER_WORDS.has(t.value)) {
        this.fail(`알 수 없는 수식어 ${describe(t)}`, t.span, `이름을 붙이려면 \`${after} as ${t.value}\``);
      } else {
        this.fail(`알 수 없는 수식어 ${describe(t)}`, t.span, `컬럼 뒤에는 ${COLUMN_MODIFIERS.join(", ")} 가 올 수 있습니다`);
      }
    }
    return col;
  }

  private typeRef(): TypeRef {
    const t = this.peek();
    if (t.kind === "ident" && t.quoted) this.fail("타입에는 백틱 이름을 쓸 수 없습니다", t.span);
    const name = this.name("타입");
    let args: number[] | null = null;
    let end = name.span.col + name.span.len;
    if (this.at("lparen")) {
      this.next();
      args = [];
      for (;;) {
        const n = this.peek();
        if (n.kind !== "number") this.fail(`타입 인자는 수여야 합니다 (실제: ${describe(n)})`, n.span, "예) `varchar(32)`, `decimal(12,2)`");
        args.push(Number(this.next().value));
        if (this.at("comma")) {
          this.next();
          continue;
        }
        const close = this.expect("rparen", "`)`");
        end = close.span.col + close.span.len;
        break;
      }
    }
    return { name, args, span: { line: name.span.line, col: name.span.col, len: end - name.span.col } };
  }

  /** `as 이름` 이 있으면 이름, 없으면 null */
  private optionalAs(what: string): Ident | null {
    if (!this.atWord("as")) return null;
    this.next();
    return this.name(what);
  }

  private ref(): Ref {
    const arrow = this.next();
    const table = this.name("참조할 테이블 이름");
    let column: Ident | null = null;
    if (this.at("dot")) {
      this.next();
      column = this.name("참조할 컬럼 이름");
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
    return this.parenthesized(() => this.name(what));
  }

  /** enum 값 — 이름이나 수 */
  private values(what: string): EnumValue[] {
    return this.parenthesized(() => {
      const t = this.peek();
      if (t.kind === "number" || t.kind === "ident") return { text: this.next().value, span: t.span };
      return this.fail(`${what} 필요 (실제: ${describe(t)})`, t.span);
    });
  }

  private parenthesized<T>(item: () => T): T[] {
    this.expect("lparen", "`(`");
    const items: T[] = [];
    for (;;) {
      this.skipNewlines();
      if (this.at("rparen")) break;
      items.push(item());
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
