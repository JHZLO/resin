import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { compile } from "./index.ts";
import { attributeName, entityName } from "./mermaid.ts";

const EXAMPLES = join(import.meta.dirname, "../examples");
const mmd = (src: string): string => {
  const r = compile(src);
  expect(r.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
  return r.mermaid!;
};

describe("toMermaid", () => {
  it("draws one-to-one as o|, logical references dotted, and optional parents as |o", () => {
    const out = mmd("table a {\n id bigint pk\n}\ntable b {\n a_id bigint uk ~> a\n c_id bigint? -> a\n}");
    expect(out).toContain('    a ||..o| b : "a_id"');
    expect(out).toContain('    a |o--o{ b : "c_id"');
    expect(out).toContain('        bigint a_id FK,UK "~> a.id"');
    expect(out).toContain('        bigint? c_id FK "-> a.id"');
  });

  it("treats a foreign key that is the sole primary key as one-to-one", () => {
    expect(mmd("table a {\n id bigint pk\n}\ntable a_ext {\n id bigint pk -> a\n}")).toContain("    a ||--o| a_ext");
  });

  it("shows descriptions as aliases after the name, and marks external tables", () => {
    const out = mmd('external table users "Accounts" {\n id bigint pk\n}\ntable o "Orders" {\n id bigint pk\n u_id bigint ~> users\n}');
    expect(out).toContain('    users["users (Accounts)"]:::external {');
    expect(out).toContain('    o["o (Orders)"] {');
    expect(out.trimEnd().endsWith("    classDef external stroke-dasharray:4 3")).toBe(true);
  });

  it("puts names, indexes and composite constraints into comments", () => {
    const out = mmd(`
      table t {
        id bigint pk
        a varchar(32) uk as uk_a index as ix_a "Code"
        b int
        unique(a, b) as uk_ab
        index(b, a)
      }`);
    expect(out).toContain('        varchar(32) a UK "Code (uk_a) (ix_a); uk_ab(a,b)"');
    expect(out).toContain('        int b "ix(b,a)"');
  });

  it("writes quotes in descriptions as #quot; because Mermaid has no \\\" escape", () => {
    expect(mmd('table a {\n x int "say \\"hi\\""\n}')).toContain('int x "say #quot;hi#quot;"');
  });

  it("produces neither a model nor Mermaid when there are errors", () => {
    const r = compile("table a {\n x int -> nope\n}");
    expect([r.model, r.mermaid]).toEqual([null, null]);
    expect(r.diagnostics).toHaveLength(1);
  });

  it("is deterministic", () => {
    const src = readFileSync(join(EXAMPLES, "order.erd"), "utf8");
    expect(compile(src).mermaid).toBe(compile(src).mermaid);
  });
});

describe("names Mermaid cannot read as they are", () => {
  it("quotes table names that are not plain identifiers or are keywords", () => {
    expect(["users", "orders", "style", "Class", "to", "order-items", "주문", "1a"].map(entityName)).toEqual([
      "users", "orders", '"style"', '"Class"', '"to"', '"order-items"', '"주문"', '"1a"',
    ]);
  });

  it("rewrites column names, since Mermaid does not accept quoted ones", () => {
    expect(["order_no", "주문번호", "order-no", "order no", "2fa", "pk", "UK"].map((n) => attributeName(n))).toEqual([
      { text: "order_no", changed: false },
      { text: "주문번호", changed: false },
      { text: "order-no", changed: false },
      { text: "order_no", changed: true },
      { text: "_2fa", changed: true },
      { text: "pk_", changed: true },
      { text: "UK_", changed: true },
    ]);
  });

  it("keeps the original of a rewritten column name at the start of its comment", () => {
    const out = mmd('table style {\n pk int pk\n `order no` varchar "Order number"\n}\ntable x {\n s_pk int -> style\n}');
    expect(out).toContain('    "style" ||--o{ x : "s_pk"');
    expect(out).toContain('    "style" {');
    expect(out).toContain('        int pk_ PK "`pk`"');
    expect(out).toContain('        varchar order_no "`order no`; Order number"');
  });
});

// Golden files: examples/<name>.erd → examples/<name>.mmd. Changing the output format breaks these;
// review the diff and update with `pnpm test -u` only when the change is intended.
describe("golden", () => {
  for (const file of readdirSync(EXAMPLES).filter((f) => f.endsWith(".erd")).sort()) {
    it(file, async () => {
      const r = compile(readFileSync(join(EXAMPLES, file), "utf8"));
      expect(r.diagnostics).toEqual([]);
      await expect(r.mermaid).toMatchFileSnapshot(join(EXAMPLES, file.replace(/\.erd$/, ".mmd")));
    });
  }
});
