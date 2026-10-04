import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { compile } from "./index.ts";
import { type Model, neighbors } from "./model.ts";

const EXAMPLES = join(import.meta.dirname, "../examples");

const model = (src: string): Model => {
  const r = compile(src);
  expect(r.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
  return r.model!;
};

describe("lower", () => {
  it("derives one-to-one from uk or a sole primary key, and optional parents from nullability", () => {
    const m = model(`
      table a {
        id bigint pk
      }
      table b {
        id bigint pk
        a_id bigint -> a
        a2_id bigint? uk ~> a
      }
      table a_ext {
        id bigint pk -> a
      }
      table ab {
        a_id bigint pk -> a
        b_id bigint pk -> b
      }`);
    expect(m.relations.map((r) => [`${r.child}.${r.childColumn}`, r.kind, r.one, r.optional])).toEqual([
      ["b.a_id", "physical", false, false],
      ["b.a2_id", "logical", true, true],
      ["a_ext.id", "physical", true, false],
      ["ab.a_id", "physical", false, false],
      ["ab.b_id", "physical", false, false],
    ]);
  });

  it("keeps type arguments and names on columns", () => {
    const m = model(`
      table a {
        id bigint pk
        code varchar(32) uk as uk_code index
        amount decimal(12,2)? enc enum(1, 2) "Amount"
      }`);
    const [, code, amount] = m.tables[0].columns;
    expect(code).toMatchObject({ type: "varchar(32)", uk: true, ukName: "uk_code", index: { name: null } });
    expect(amount).toMatchObject({ type: "decimal(12,2)", nullable: true, enc: true, enumValues: ["1", "2"], description: "Amount" });
  });

  it("resolves reference targets, defaulting to the primary key", () => {
    const m = model("external table u {\n  id bigint pk\n}\ntable o {\n  id bigint pk\n  u_id bigint ~> u\n}");
    expect(m.tables.map((t) => [t.name, t.origin])).toEqual([
      ["u", "external"],
      ["o", "table"],
    ]);
    expect(m.tables[1].columns[1].ref).toEqual({ table: "u", column: "id", kind: "logical" });
  });

  it("expands audit envers into revinfo and *_aud tables and links them", () => {
    const m = model(`
      table o {
        id bigint pk
        status varchar?
        memo text
        created_at datetime
      } audit envers
      table p {
        id bigint pk
        amount int
      } audit envers(amount)`);
    expect(m.tables.map((t) => [t.name, t.origin])).toEqual([
      ["o", "table"],
      ["p", "table"],
      ["revinfo", "audit"],
      ["o_aud", "audit"],
      ["p_aud", "audit"],
    ]);
    expect(m.tables[0].audit).toEqual({ method: "envers", columns: ["status", "memo"] });
    expect(m.tables[3].columns.map((c) => [c.name, c.type, c.pk, c.nullable, c.ref?.table ?? null])).toEqual([
      ["id", "bigint", true, false, null],
      ["rev", "int", true, false, "revinfo"],
      ["revtype", "tinyint", false, false, null],
      ["status", "varchar", false, true, null],
      ["memo", "text", false, true, null],
    ]);
    expect(m.relations.map((r) => [r.parent, r.child, r.origin])).toEqual([
      ["revinfo", "o_aud", "audit"],
      ["revinfo", "p_aud", "audit"],
    ]);
  });
});

describe("examples", () => {
  for (const file of readdirSync(EXAMPLES).filter((f) => f.endsWith(".erd")).sort())
    it(`${file} compiles without a diagnostic`, () => {
      expect(compile(readFileSync(join(EXAMPLES, file), "utf8")).diagnostics).toEqual([]);
    });
});

describe("neighbors", () => {
  const shop = compile(readFileSync(join(EXAMPLES, "shop.erd"), "utf8")).model!;
  const names = (m: Model) => m.tables.map((t) => t.name);

  it("keeps a table, its parents and its children, one hop per step", () => {
    expect(names(neighbors(shop, "orders", 1))).toEqual(["users", "coupons", "orders", "order_items", "coupon_usages", "payments", "shipments"]);
    expect(names(neighbors(shop, "refunds", 1))).toEqual(["payments", "refunds"]);
    expect(names(neighbors(shop, "refunds", 2))).toEqual(["orders", "payments", "refunds"]);
  });

  it("keeps every relation among the tables it keeps, and the references to the rest", () => {
    const part = neighbors(shop, "orders", 1);
    expect(part.relations.some((r) => r.child === "coupon_usages" && r.parent === "coupons")).toBe(true);
    expect(part.relations.every((r) => names(part).includes(r.parent) && names(part).includes(r.child))).toBe(true);
    const items = part.tables.find((t) => t.name === "order_items")!;
    expect(items.columns.find((c) => c.name === "option_id")?.ref?.table).toBe("product_options");
  });

  it("leaves a table alone when nothing joins it", () => {
    const m = compile("table a {\n id bigint pk\n}\ntable b {\n id bigint pk\n}").model!;
    expect(names(neighbors(m, "a", 2))).toEqual(["a"]);
  });
});

describe("groups", () => {
  it("keeps groups in document order, and puts an audit table in the group of its table", () => {
    const m = model(`
group ordering "Order service" {
  table orders {
    id      bigint   pk
    status  varchar
  } audit envers
}
table shipments {
  id  bigint  pk
}`);
    expect(m.groups).toEqual([{ name: "ordering", description: "Order service" }]);
    expect(m.tables.map((t) => [t.name, t.group])).toEqual([
      ["orders", "ordering"],
      ["shipments", null],
      ["revinfo", null],
      ["orders_aud", "ordering"],
    ]);
  });
});

