// Tokens → syntax tree. A hand-written recursive descent parser: the grammar is small and every
// error message deserves individual care, which is cheaper here than with a generator (PEG and
// friends). The grammar is defined in docs/SPEC.md §3.
//
// Error recovery: when a line (a column or a constraint) is wrong, skip to its end and carry on with
// the next line. Several errors are reported in one run. Nodes of broken lines are left out of the tree.
//
// v0.1 syntax (the `erd` header, `index(name)`, `unique name(a, b)`, `audit` without a method) is
// recognized and answered with a hint on how to write it now (SPEC §7).

import type { Audit, Column, Document, EnumValue, Group, Ident, Ref, Span, Table, TableConstraint, TypeRef } from "./ast.ts";
import { type Diagnostic, error } from "./diagnostics.ts";
import { type Token, type TokenKind, lex } from "./lexer.ts";

/** Thrown to abandon a line. The diagnostic has already been recorded */
class LineError extends Error {}

const COLUMN_MODIFIERS = ["pk", "uk", "enc", "enum", "index", "->", "~>", '"description"'];
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

  // ---- token helpers ----

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
  /** Is this keyword here? Backtick names are never keywords */
  private atWord(word: string, offset = 0): boolean {
    const t = this.peek(offset);
    return t.kind === "ident" && !t.quoted && t.value === word;
  }
  private skipNewlines(): void {
    while (this.at("newline")) this.next();
  }
  /** Drop tokens up to the end of the line, keeping the newline. Also stops at `}`: eating the end of a block makes recovery worse */
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
    return this.fail(`expected ${what}, found ${describe(t)}`, t.span);
  }
  /** A name: bare or in backticks */
  private name(what: string): Ident {
    const t = this.expect("ident", what);
    return t.quoted ? { text: t.value, span: t.span, quoted: true } : { text: t.value, span: t.span };
  }

  // ---- document ----

  document(): Document {
    const tables: Table[] = [];
    const groups: Group[] = [];
    for (;;) {
      this.skipNewlines();
      if (this.at("eof")) break;
      try {
        if (this.atWord("group")) groups.push(this.group(tables));
        else if (this.atTable()) tables.push(this.tableOrExternal(null));
        else if (this.atWord("erd")) this.fail("the `erd` header was removed in v0.2", this.peek().span, "delete this line");
        else this.fail(`unexpected ${describe(this.peek())}`, this.peek().span, "only `group`, `table` and `external table` can appear at the top level");
      } catch (e) {
        if (!(e instanceof LineError)) throw e;
        this.recoverTopLevel();
      }
    }
    return { tables, groups };
  }

  /** After a top-level error: skip to the next line that starts with `group`, `table` or `external` */
  private recoverTopLevel(): void {
    while (!this.at("eof")) {
      if (this.at("newline") && (this.atWord("group", 1) || this.atWord("table", 1) || this.atWord("external", 1))) return;
      this.next();
    }
  }

  private atTable(): boolean {
    return this.atWord("table") || this.atWord("external");
  }

  private tableOrExternal(group: Ident | null): Table {
    if (this.atWord("table")) return this.table(null, group);
    const ext = this.next();
    if (!this.atWord("table")) this.fail("expected `table` after `external`", this.peek().span, "write `external table name { ... }`");
    return this.table(ext, group);
  }

  // ---- groups ----

  /** `group name ["description"] { tables }`. Its tables go into `tables` in document order, each
   *  knowing its group. A line that is not a table is skipped; a nested group is skipped whole */
  private group(tables: Table[]): Group {
    const kw = this.next(); // group
    const name = this.name("a group name");
    const description = this.at("string") ? this.next().value : null;
    this.expect("lbrace", "`{`");
    for (;;) {
      this.skipNewlines();
      if (this.at("rbrace")) break;
      if (this.at("eof")) {
        this.diagnostics.push(error(`group \`${name.text}\` is missing its closing \`}\``, name.span));
        return { name, description, span: kw.span };
      }
      try {
        if (this.atTable()) tables.push(this.tableOrExternal(name));
        else if (this.atWord("group")) {
          this.diagnostics.push(error("groups cannot be nested", this.peek().span, `close \`${name.text}\` before opening another group`));
          this.skipBlock();
        } else this.fail(`expected \`table\` or \`external table\` in group \`${name.text}\`, found ${describe(this.peek())}`, this.peek().span);
      } catch (e) {
        if (!(e instanceof LineError)) throw e;
        this.skipLine();
      }
    }
    this.next(); // }
    this.endOfStatement();
    return { name, description, span: kw.span };
  }

  /** Skip a line and, when it opens a block, the whole block */
  private skipBlock(): void {
    let depth = 0;
    while (!this.at("eof")) {
      const t = this.next();
      if (t.kind === "lbrace") depth++;
      else if (t.kind === "rbrace" && --depth <= 0) return;
      else if (t.kind === "newline" && depth === 0) return;
    }
  }

  private endOfStatement(): void {
    if (this.at("newline") || this.at("eof")) return;
    this.fail(`expected end of line, found ${describe(this.peek())}`, this.peek().span);
  }

  // ---- tables ----

  private table(external: Token | null, group: Ident | null): Table {
    const kw = this.next(); // table
    const span = external ? external.span : kw.span;
    const name = this.name("a table name");
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
      group,
      span,
    });
    for (;;) {
      this.skipNewlines();
      if (this.at("rbrace")) break;
      if (this.at("eof")) {
        this.diagnostics.push(error(`table \`${name.text}\` is missing its closing \`}\``, name.span));
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

  /** `unique(` or `index(`: only a keyword directly followed by `(` starts a constraint.
   *  That keeps a column called `index` (`index int`, `index varchar(32)`) a column */
  private atConstraint(): boolean {
    return (this.atWord("unique") || this.atWord("index")) && this.at("lparen", 1);
  }

  /** v0.1's `unique name(a, b)`. A name inside the parentheses (not a number) means an old constraint, not type arguments */
  private rejectOldConstraint(): void {
    if ((this.atWord("unique") || this.atWord("index")) && this.at("ident", 1) && this.at("lparen", 2) && this.at("ident", 3)) {
      const kw = this.peek();
      this.fail(
        "constraint names go after the column list since v0.2",
        kw.span,
        `write \`${kw.value}(${this.peek(3).value}, ...) as ${this.peek(1).value}\``,
      );
    }
  }

  private constraint(): TableConstraint {
    const kw = this.next();
    const columns = this.list("a column name");
    if (columns.length === 0) this.fail("list at least one column", kw.span);
    let name: Ident | null = null;
    if (this.atWord("as")) {
      this.next();
      name = this.name("a constraint name");
    }
    this.endOfMember();
    return { kind: kw.value === "unique" ? "unique" : "index", name, columns, span: kw.span };
  }

  private audit(): Audit {
    const a = this.next();
    if (this.at("lparen") || this.at("newline") || this.at("eof"))
      this.fail("`audit` needs a method", a.span, "write `audit envers(a, b)` or `audit envers` (changed in v0.2)");
    const method = this.name("an audit method");
    const columns = this.at("lparen") ? this.list("a column name to audit") : null;
    return { method, columns, span: a.span };
  }

  // ---- columns ----

  private column(): Column {
    const name = this.name("a column name");
    if (this.at("newline") || this.at("rbrace") || this.at("eof"))
      this.fail(`column \`${name.text}\` has no type`, name.span, "a column is written `name type`, e.g. `id bigint pk`");
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

    const dup = (what: string, span: Span) => this.fail(`duplicate ${what}`, span);
    /** The previous modifier could take a name (uk, index): a bare name after it gets a targeted hint */
    let named: string | null = null;

    while (!this.at("newline") && !this.at("eof") && !this.at("rbrace")) {
      const t = this.peek();
      const after = named;
      named = null;
      if (t.kind === "string") {
        if (col.description !== null) dup("description", t.span);
        col.description = this.next().value;
      } else if (t.kind === "arrow" || t.kind === "tildeArrow") {
        if (col.ref) dup("reference", t.span);
        col.ref = this.ref();
      } else if (this.atWord("pk") || this.atWord("enc")) {
        const key = t.value as "pk" | "enc";
        if (col[key]) dup(`\`${key}\``, t.span);
        this.next();
        col[key] = true;
      } else if (this.atWord("uk")) {
        if (col.uk) dup("`uk`", t.span);
        this.next();
        col.uk = { name: this.optionalAs("a unique constraint name"), span: t.span };
        if (!col.uk.name) named = "uk";
      } else if (this.atWord("index")) {
        if (col.index) dup("`index`", t.span);
        this.next();
        if (this.at("lparen"))
          this.fail("index names go after `as` since v0.2", this.peek().span, `write \`index as ${this.peek(1).value}\``);
        col.index = { name: this.optionalAs("an index name"), span: t.span };
        if (!col.index.name) named = "index";
      } else if (this.atWord("enum")) {
        if (col.enumValues) dup("`enum`", t.span);
        this.next();
        col.enumValues = this.values("an enum value");
        if (col.enumValues.length === 0) this.fail("list at least one enum value", t.span);
      } else if (this.atWord("as")) {
        this.fail("`as` can only follow `uk` or `index`", t.span);
      } else if (after && t.kind === "ident" && !MODIFIER_WORDS.has(t.value)) {
        this.fail(`unknown modifier ${describe(t)}`, t.span, `to name it, write \`${after} as ${t.value}\``);
      } else {
        this.fail(`unknown modifier ${describe(t)}`, t.span, `a column accepts ${COLUMN_MODIFIERS.join(", ")}`);
      }
    }
    return col;
  }

  private typeRef(): TypeRef {
    const t = this.peek();
    if (t.kind === "ident" && t.quoted) this.fail("a type cannot be a backtick name", t.span);
    const name = this.name("a type");
    let args: number[] | null = null;
    let end = name.span.col + name.span.len;
    if (this.at("lparen")) {
      this.next();
      args = [];
      for (;;) {
        const n = this.peek();
        if (n.kind !== "number") this.fail(`type arguments must be numbers, found ${describe(n)}`, n.span, "e.g. `varchar(32)`, `decimal(12,2)`");
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

  /** The name after `as`, or null when there is no `as` */
  private optionalAs(what: string): Ident | null {
    if (!this.atWord("as")) return null;
    this.next();
    return this.name(what);
  }

  private ref(): Ref {
    const arrow = this.next();
    const table = this.name("a referenced table name");
    let column: Ident | null = null;
    if (this.at("dot")) {
      this.next();
      column = this.name("a referenced column name");
    }
    return { kind: arrow.kind === "arrow" ? "physical" : "logical", table, column, span: arrow.span };
  }

  // ---- shared ----

  private endOfMember(): void {
    if (this.at("newline") || this.at("eof") || this.at("rbrace")) return;
    this.fail(`expected end of line, found ${describe(this.peek())}`, this.peek().span);
  }

  /** `( a, b, c )`: newlines inside the parentheses are ignored, a trailing comma is allowed */
  private list(what: string): Ident[] {
    return this.parenthesized(() => this.name(what));
  }

  /** Enum values: names or numbers */
  private values(what: string): EnumValue[] {
    return this.parenthesized(() => {
      const t = this.peek();
      if (t.kind === "number" || t.kind === "ident") return { text: this.next().value, span: t.span };
      return this.fail(`expected ${what}, found ${describe(t)}`, t.span);
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
      if (!this.at("rparen")) this.fail(`expected \`,\` or \`)\`, found ${describe(this.peek())}`, this.peek().span);
    }
    this.next(); // )
    return items;
  }
}

function describe(t: Token): string {
  switch (t.kind) {
    case "string":
      return "a string";
    case "newline":
      return "end of line";
    case "eof":
      return "end of file";
    default:
      return `\`${t.value}\``;
  }
}
