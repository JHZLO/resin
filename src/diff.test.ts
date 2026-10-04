import ELK from "elkjs";
import { describe, expect, it } from "vitest";
import { diff, diffMarkdown } from "./diff.ts";
import { compile } from "./index.ts";
import type { Model } from "./model.ts";
import { toSvg } from "./svg.ts";

const model = (src: string): Model => {
  const r = compile(src);
  expect(r.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
  return r.model!;
};
const changesOf = (before: string, after: string) => diff(model(before), model(after)).changes.map((c) => [c.table, c.column, c.kind, c.details]);

const BASE = `table users {
  id     bigint  pk
  email  varchar(255)
}

table orders {
  id       bigint  pk
  user_id  bigint  -> users  index
  status   varchar  enum(PENDING, PAID)
}`;

describe("diff", () => {
  it("finds nothing between a model and itself", () => {
    expect(diff(model(BASE), model(BASE)).changes).toEqual([]);
    expect(diffMarkdown([])).toBe("No changes to the schema.\n");
  });

  it("reports added and removed tables, and puts a removed table back after the table before it", () => {
    const after = BASE.replace(/table users \{[^}]*\}\n\n/, "").replace("-> users  index", "index") + "\n\ntable refunds {\n  id  bigint  pk\n}";
    const d = diff(model(BASE), model(after));
    expect(d.changes.map((c) => [c.table, c.column, c.kind, c.details])).toEqual([
      ["users", null, "removed", []],
      ["orders", null, "changed", []],
      ["orders", "user_id", "changed", ["reference -> users.id removed"]],
      ["refunds", null, "added", []],
    ]);
    expect(d.model.tables.map((t) => [t.name, t.change?.kind ?? null])).toEqual([
      ["users", "removed"],
      ["orders", "changed"],
      ["refunds", "added"],
    ]);
  });

  it("says in words what changed about a column", () => {
    const after = BASE.replace("email  varchar(255)", "email  varchar(320)  uk")
      .replace("user_id  bigint  -> users  index", "user_id  bigint?  ~> users")
      .replace("enum(PENDING, PAID)", "enum(PENDING, PAID, REFUNDED)");
    expect(changesOf(BASE, after)).toEqual([
      ["users", null, "changed", []],
      ["users", "email", "changed", ["type varchar(255) → varchar(320)", "now unique"]],
      ["orders", null, "changed", []],
      ["orders", "user_id", "changed", ["now nullable", "index removed", "reference -> users.id → ~> users.id"]],
      ["orders", "status", "changed", ["values PENDING, PAID → PENDING, PAID, REFUNDED"]],
    ]);
  });

  it("puts a removed column back after the column before it, and marks an added one", () => {
    const after = BASE.replace("  email  varchar(255)\n", "  name  varchar(100)\n");
    const d = diff(model(BASE), model(after));
    const users = d.model.tables.find((t) => t.name === "users")!;
    expect(users.columns.map((c) => [c.name, c.change?.kind ?? null])).toEqual([
      ["id", null],
      ["email", "removed"],
      ["name", "added"],
    ]);
  });

  it("reports changes to a table itself: constraints, audit, description", () => {
    const before = 'service g {\n  table t "Things" {\n    id  bigint  pk\n    a   int\n    b   int\n  }\n}';
    const after = 'service g {\n  table t "Items" {\n    id  bigint  pk\n    a   int\n    b   int\n    unique(a, b)\n  } audit envers\n}';
    expect(changesOf(before, after)).toEqual([["g.t", null, "changed", ["description changed", "unique (a, b) added", "audit added"]]]);
  });

  it("treats a table moved into a service as a different qualified identity", () => {
    expect(changesOf("table t { id int pk }", "service g {\n table t { id int pk }\n}")).toEqual([
      ["t", null, "removed", []], ["g.t", null, "added", []],
    ]);
  });

  it("marks relations that appear, go and change kind, and keeps the service of a removed table", () => {
    const before = 'service crm {\n  table customers {\n    id  bigint  pk\n  }\n}\ntable orders {\n  id  bigint  pk\n  customer_id  bigint  -> customers  index\n}';
    const after = "table orders {\n  id  bigint  pk\n  customer_id  bigint  index\n}";
    const d = diff(model(before), model(after));
    expect(d.model.relations.map((r) => [r.parent, r.child, r.change?.kind])).toEqual([["crm.customers", "orders", "removed"]]);
    expect(d.model.services.map((g) => g.name)).toEqual(["crm"]);
    const kind = diff(model(after.replace("customer_id  bigint  index", "customer_id  bigint  -> orders.id  index")), model(after.replace("customer_id  bigint  index", "customer_id  bigint  ~> orders.id  index")));
    expect(kind.model.relations.map((r) => r.change?.kind)).toEqual(["changed"]);
  });

  it("leaves generated audit tables out of the comparison", () => {
    const before = "table t {\n  id  bigint  pk\n  a   int\n}";
    const after = "table t {\n  id  bigint  pk\n  a   int\n} audit envers";
    const d = diff(model(before), model(after));
    expect(d.changes.map((c) => c.table)).toEqual(["t"]);
    expect(d.model.tables.filter((t) => t.origin === "audit").every((t) => !t.change)).toBe(true);
  });

  it("marks a relation when only its cardinality or parent requirement changes", () => {
    const before = model(BASE);
    const after = model(BASE.replace("user_id  bigint  ->", "user_id  bigint?  uk ->"));
    const relation = diff(before, after).model.relations[0];
    expect(relation).toMatchObject({ one: true, optional: true, change: {
      kind: "changed", details: ["cardinality one-to-many → one-to-one", "parent now optional"],
    } });
    expect(diff(after, before).model.relations[0].change).toEqual({
      kind: "changed", details: ["cardinality one-to-one → one-to-many", "parent now required"],
    });
  });

  it("writes the changes as a Markdown list", () => {
    const after = BASE.replace("  email  varchar(255)\n", "") + "\n\ntable refunds {\n  id  bigint  pk\n}";
    expect(diffMarkdown(diff(model(BASE), model(after)).changes)).toBe(
      "- ~ table `users` changed\n  - - column `email` removed\n- + table `refunds` added\n",
    );
  });
});

describe("drawing a diff", () => {
  it("marks tables, rows and connectors in their colors", async () => {
    const after = BASE.replace("  email  varchar(255)\n", "  name  varchar(100)\n") + "\n\ntable refunds {\n  id        bigint  pk\n  order_id  bigint  -> orders  index\n}";
    const { svg } = await toSvg(diff(model(BASE), model(after)).model, new ELK(), { look: "aurora-dark" });
    expect(svg).toContain(">CHANGED</text>");
    expect(svg).toContain(">NEW</text>");
    expect(svg).toMatch(/text-decoration="line-through"[^>]*>email</);
    expect(svg).toMatch(/data-c="name"><title>[^<]*added/);
    expect(svg).toMatch(/data-b="refunds"[^>]*><path[^>]*stroke="#3FB950"/);
  });

  it("draws a model without changes exactly as before", async () => {
    const m = model(BASE);
    const plain = await toSvg(m, new ELK());
    const merged = await toSvg(diff(m, m).model, new ELK());
    expect(merged.svg).toBe(plain.svg);
  });
});
