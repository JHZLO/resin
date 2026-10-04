import { describe, expect, it } from "vitest";
import { compile } from "../src/index.ts";
import { addLogicalReferences, assignService, mergeImport, referenceCandidates, relatedModel, relationPath, writeDocument } from "./schema-tools.ts";
const source = `table users "People" { id bigint pk }
table orders {
 id bigint pk
 user_id bigint
}
table items {
 id bigint pk
 order_id bigint -> orders
}`;
describe("schema editing tools", () => {
  it("offers name/type matches without changing the schema", () => {
    const m = compile(source).model!;
    const candidates = referenceCandidates(m);
    expect(candidates).toHaveLength(1);
    expect(m.relations).toHaveLength(1);
    const updated = compile(addLogicalReferences(source, candidates)).model!;
    expect(updated.relations.filter(r => r.kind === "logical")).toHaveLength(1);
    expect(() => addLogicalReferences(addLogicalReferences(source, candidates), candidates)).toThrow("already has a reference");
  });
  it("preserves schema facts in a canonical round trip", () => {
    const input = `${source}\n table sensitive {\n id int pk\n secret varchar(30)? enc enum(A, B) index as ix_secret "Description"\n unique(id, secret)\n } audit envers(secret)`;
    const r = compile(input);
    expect(compile(writeDocument(r.doc)).model).toEqual(r.model);
  });
  it("imports into a service without changing local relationships", () => {
    const r = compile(assignService(source, "billing"));
    expect(r.diagnostics).toEqual([]);
    expect(r.model!.relations[0].parent).toBe("billing.orders");
  });
  it("retains descriptions, encryption and logical references during reimport", () => {
    const current = source.replace("user_id bigint", "user_id bigint enc ~> users.id \"Owner\"");
    const incoming = source.replace(' "People"', "").replace("user_id bigint", "user_id bigint?\n total int");
    const result = mergeImport(current, incoming, source);
    expect(result.notes).toEqual([]);
    const model = compile(result.source).model!;
    const c = model.tables.find(t => t.name === "orders")!.columns.find(c => c.name === "user_id")!;
    expect(c).toMatchObject({ nullable: true, enc: true, description: "Owner", ref: { kind: "logical", table: "users" } });
    expect(result.changes.some(c => c.column === "total")).toBe(true);
  });
  it("finds the shortest relationship path and respects direction", () => {
    const model = compile(addLogicalReferences(source, referenceCandidates(compile(source).model!))).model!;
    expect(relationPath(model, "users", "items")).toEqual(["users", "orders", "items"]);
    expect(relatedModel(model, "orders", 1, "outgoing").tables.map(t => t.name)).toEqual(["users", "orders"]);
    expect(relatedModel(model, "orders", 1, "incoming").tables.map(t => t.name)).toEqual(["orders", "items"]);
    expect(relationPath(model, "users", "missing")).toBeNull();
  });
  it("keeps a manually assigned service and inline comments on reimport", () => {
    const current = assignService(source, "billing") + "%% Keep this note\n";
    const result = mergeImport(current, source.replace(" total", " amount"), source);
    expect(result.notes).toEqual([]);
    expect(compile(result.source).model!.tables.every(t => t.service === "billing")).toBe(true);
    const commented = source.replace("id bigint pk }", "id bigint pk %% Keep the key\n}");
    const roundtrip = writeDocument(compile(commented).doc, [commented]);
    expect(roundtrip).toContain("%% Keep the key");
    expect(compile(roundtrip).model).toEqual(compile(commented).model);
  });
  it("never replaces an owned table with an import's external stub", () => {
    const current = 'table users "Owned" {\n id bigint pk\n email varchar\n}';
    const incoming = 'external table users { id bigint pk }\ntable orders {\n id int pk\n user_id bigint -> users\n}';
    const first = mergeImport(current, incoming, null);
    const second = mergeImport(first.source, incoming.replace("id int pk", "id bigint pk"), incoming);
    const users = compile(second.source).model!.tables.find(t => t.name === "users")!;
    expect(users.origin).toBe("table");
    expect(users.columns).toHaveLength(2);
    expect(users.description).toBe("Owned");
  });
});
