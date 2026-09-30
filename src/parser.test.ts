import { describe, expect, it } from "vitest";
import { typeText } from "./ast.ts";
import { parse } from "./parser.ts";

const doc = (body: string) => {
  const r = parse(body);
  return { ...r, messages: r.diagnostics.map((d) => d.message), hints: r.diagnostics.map((d) => d.hint ?? null) };
};

describe("parse", () => {
  it("reads column names, types, nullability and modifiers", () => {
    const { doc: d, diagnostics } = doc(`
      table t "Things" {
        id bigint pk
        name varchar(32)? uk as uk_name enc "Name" index as ix_name
        status varchar enum(A, B,) index
        kind tinyint enum(0, 1, 2)
      }`);
    expect(diagnostics).toEqual([]);
    const [t] = d.tables;
    expect([t.name.text, t.external, t.description]).toEqual(["t", false, "Things"]);
    const [id, name, status, kind] = t.columns;
    expect([id.name.text, typeText(id.type), id.nullable, id.pk]).toEqual(["id", "bigint", false, true]);
    expect([typeText(name.type), name.nullable, name.uk?.name?.text, name.enc, name.description, name.index?.name?.text]).toEqual([
      "varchar(32)", true, "uk_name", true, "Name", "ix_name",
    ]);
    expect(status.enumValues?.map((v) => v.text)).toEqual(["A", "B"]);
    expect(status.index).toMatchObject({ name: null });
    expect(kind.enumValues?.map((v) => v.text)).toEqual(["0", "1", "2"]);
  });

  it("reads type arguments as numbers; the type span covers the parentheses", () => {
    const { doc: d, diagnostics } = doc("table t {\n  amount decimal(12,2)\n}");
    expect(diagnostics).toEqual([]);
    const { type } = d.tables[0].columns[0];
    expect([type.name.text, type.args]).toEqual(["decimal", [12, 2]]);
    expect(type.span).toEqual({ line: 2, col: 10, len: 13 });
  });

  it("reads -> as physical and ~> as logical; the column may be omitted", () => {
    const { doc: d } = doc(`
      table t {
        a_id bigint -> a.id
        b_id bigint ~> b
      }`);
    const [a, b] = d.tables[0].columns;
    expect(a.ref).toMatchObject({ kind: "physical", table: { text: "a" }, column: { text: "id" } });
    expect(b.ref).toMatchObject({ kind: "logical", table: { text: "b" }, column: null });
  });

  it("reads external tables", () => {
    const { doc: d, diagnostics } = doc('external table users "Accounts" {\n  id bigint pk\n}');
    expect(diagnostics).toEqual([]);
    expect(d.tables[0]).toMatchObject({ name: { text: "users" }, external: true, description: "Accounts" });
  });

  it("reads table constraints with names and audit with its method", () => {
    const { doc: d, diagnostics } = doc(`
      table t {
        id int pk
        a int
        b int
        unique(a, b) as uk_ab
        index(
          a,
          b
        )
      } audit envers(a)`);
    expect(diagnostics).toEqual([]);
    const t = d.tables[0];
    expect(t.constraints.map((k) => [k.kind, k.name?.text ?? null, k.columns.map((c) => c.text)])).toEqual([
      ["unique", "uk_ab", ["a", "b"]],
      ["index", null, ["a", "b"]],
    ]);
    expect([t.audit?.method.text, t.audit?.columns?.map((c) => c.text)]).toEqual(["envers", ["a"]]);
  });

  it("reads audit envers without a list as columns = null", () => {
    expect(doc("table t {\n id bigint pk\n} audit envers").doc.tables[0].audit).toMatchObject({ method: { text: "envers" }, columns: null });
  });

  it("allows columns called index, unique or as, because keywords are contextual", () => {
    const { doc: d, diagnostics } = doc("table t {\n index int\n unique varchar(32)\n as bigint\n}");
    expect(diagnostics).toEqual([]);
    expect(d.tables[0].columns.map((c) => [c.name.text, typeText(c.type)])).toEqual([
      ["index", "int"],
      ["unique", "varchar(32)"],
      ["as", "bigint"],
    ]);
  });

  it("never reads a backtick name as a keyword", () => {
    const { doc: d, diagnostics } = doc("table `order-items` {\n `pk` int pk\n}");
    expect(diagnostics).toEqual([]);
    expect(d.tables[0].name).toMatchObject({ text: "order-items", quoted: true });
    expect(d.tables[0].columns[0]).toMatchObject({ name: { text: "pk", quoted: true }, pk: true });
  });

  it("accepts a table on one line", () => {
    const { doc: d, diagnostics } = doc("table t { id bigint pk }");
    expect(diagnostics).toEqual([]);
    expect(d.tables[0].columns).toHaveLength(1);
  });

  describe("points v0.1 syntax at the v0.2 form", () => {
    it("the erd header", () => {
      const r = doc("erd\n  table t {\n    id int pk\n  }");
      expect(r.messages).toEqual(["the `erd` header was removed in v0.2"]);
      expect(r.doc.tables.map((t) => t.name.text)).toEqual(["t"]);
    });

    it("index(name)", () => {
      const r = doc("table t {\n a int index(ix_a)\n}");
      expect(r.messages).toEqual(["index names go after `as` since v0.2"]);
      expect(r.hints).toEqual(["write `index as ix_a`"]);
    });

    it("unique name(a, b)", () => {
      const r = doc("table t {\n a int\n b int\n unique uk_ab(a, b)\n}");
      expect(r.messages).toEqual(["constraint names go after the column list since v0.2"]);
      expect(r.hints).toEqual(["write `unique(a, ...) as uk_ab`"]);
    });

    it("audit without a method", () => {
      expect(doc("table t {\n id int pk\n} audit(id)").messages).toEqual(["`audit` needs a method"]);
      expect(doc("table t {\n id int pk\n} audit").messages).toEqual(["`audit` needs a method"]);
    });

    it("a bare name after uk", () => {
      const r = doc("table t {\n a int uk uk_a\n}");
      expect(r.messages).toEqual(["unknown modifier `uk_a`"]);
      expect(r.hints).toEqual(["to name it, write `uk as uk_a`"]);
    });
  });

  describe("error recovery: drop the broken line, keep reading", () => {
    it("reports errors on several lines at once", () => {
      const { doc: d, messages } = doc(`
      table t {
        id bigint pk pk
        name
        ok int
        bad int foo
        amount decimal(a)
      }`);
      expect(messages).toEqual([
        "duplicate `pk`",
        "column `name` has no type",
        "unknown modifier `foo`",
        "type arguments must be numbers, found `a`",
      ]);
      expect(d.tables[0].columns.map((c) => c.name.text)).toEqual(["ok"]);
    });

    it("points at the offending token", () => {
      const { diagnostics } = doc("table t {\n  a int foo\n}");
      expect(diagnostics[0].span).toEqual({ line: 2, col: 9, len: 3 });
    });

    it("survives a missing closing brace", () => {
      const { doc: d, messages } = doc("table t {\n a int");
      expect(messages).toEqual(["table `t` is missing its closing `}`"]);
      expect(d.tables[0].columns).toHaveLength(1);
    });

    it("resumes at the next table after a top-level error", () => {
      const { doc: d, messages } = doc("tabel t {\n a int\n}\nexternal table u {\n b int\n}");
      expect(messages).toEqual(["unexpected `tabel`"]);
      expect(d.tables.map((t) => t.name.text)).toEqual(["u"]);
    });

    it("requires table after external", () => {
      expect(doc("external users {\n id int\n}").messages).toEqual(["expected `table` after `external`"]);
    });
  });
});
