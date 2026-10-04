import { describe, expect, it } from "vitest";
import { compile, fromSql, neighbors } from "./index.ts";

describe("schema identities and composite references", () => {
  it("distinguishes a literal dotted name from a service-qualified table", () => {
    const r = compile("table `a.b` { id int pk }\nservice a {\n table b { id int pk }\n}");
    expect(r.diagnostics).toEqual([]);
    expect(new Set(r.model!.tables.map(t => t.name)).size).toBe(2);
    expect(r.model!.tables.map(t => t.label)).toEqual(["a.b", "b"]);
  });
  it("resolves same-service names and explicit cross-service targets", () => {
    const r = compile(`service accounts {
  table users { id bigint pk }
}
service billing {
  table users { id bigint pk }
  table invoices {
    id bigint pk
    owner_id bigint -> users
    account_id bigint ~> accounts.users.id
  }
}`);
    expect(r.diagnostics).toEqual([]);
    expect(r.model!.relations.map(r => r.parent)).toEqual(["billing.users", "accounts.users"]);
    expect(r.model!.tables.map(t => t.name)).toEqual(["accounts.users", "billing.users", "billing.invoices"]);
  });

  it("rejects ambiguous names at the reference position", () => {
    const r = compile(`service a {
 table users { id int pk }
}
service b {
 table users { id int pk }
}
table orders {
  user_id int -> users
}`);
    expect(r.model).toBeNull();
    expect(r.diagnostics).toContainEqual(expect.objectContaining({ message: "referenced table `users` is ambiguous", span: { line: 8, col: 18, len: 5 } }));
  });

  it("keeps a composite reference as one relation with ordered column pairs", () => {
    const r = compile(`table products {
  tenant_id bigint pk
  id bigint pk
}
table orders {
  tenant_id bigint
  product_id bigint
  foreign(tenant_id, product_id) -> products(tenant_id, id) as fk_product
}`);
    expect(r.diagnostics).toEqual([]);
    expect(r.model!.relations).toHaveLength(1);
    expect(r.model!.relations[0]).toMatchObject({ childColumns: ["tenant_id", "product_id"], parentColumns: ["tenant_id", "id"], constraint: "fk_product" });
    expect(neighbors(r.model!, "orders", 1).tables).toHaveLength(2);
  });

  it("rejects unequal composite lists at the constraint", () => {
    const r = compile(`table a { id int pk }
table b {
  x int
  y int
  foreign(x, y) -> a(id)
}`);
    expect(r.model).toBeNull();
    expect(r.diagnostics).toContainEqual(expect.objectContaining({ message: "foreign key lists must have the same number of columns", span: { line: 5, col: 3, len: 7 } }));
  });

  it("keeps new contextual keywords available as column names", () => {
    expect(compile("table t {\n foreign int\n service int\n}").diagnostics).toEqual([]);
  });
});

describe("SQL import fidelity", () => {
  it("does not resolve a missing qualified target to another schema", () => {
    const r = fromSql("CREATE TABLE sales.users (id bigint PRIMARY KEY); CREATE TABLE sales.orders (id bigint PRIMARY KEY, user_id bigint REFERENCES identity.users(id));");
    const m = compile(r.source).model!;
    const target = m.tables.find(t => t.name === m.relations[0].parent)!;
    expect(target.origin).toBe("external");
    expect(target.name).toContain("identity");
  });

  it("keeps distinct standard quoted names", () => {
    const r = fromSql('CREATE TABLE public."Users" (id bigint PRIMARY KEY); CREATE TABLE public."users" (id bigint PRIMARY KEY, email text);');
    expect(r.tables).toBe(2);
    expect(compile(r.source).model!.tables).toHaveLength(2);
  });

  it("imports composite foreign keys into the relation model", () => {
    const r = fromSql("CREATE TABLE products (tenant_id bigint, id bigint, PRIMARY KEY(tenant_id,id)); CREATE TABLE orders (tenant_id bigint, product_id bigint, FOREIGN KEY(tenant_id,product_id) REFERENCES products(tenant_id,id));");
    expect(r.notes).toEqual([]);
    expect(compile(r.source).model!.relations[0]).toMatchObject({ childColumns: ["tenant_id", "product_id"], parentColumns: ["tenant_id", "id"] });
  });
});
