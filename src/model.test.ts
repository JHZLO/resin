import { describe, expect, it } from "vitest";
import { compile } from "./index.ts";
import type { Model } from "./model.ts";

const model = (src: string): Model => {
  const r = compile(src);
  expect(r.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
  return r.model!;
};

describe("lower", () => {
  it("관계: 1:1 은 uk 이거나 유일한 기본키, 부모가 없을 수 있음은 널 허용", () => {
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

  it("컬럼은 타입 인자와 이름까지 풀어 둔다", () => {
    const m = model(`
      table a {
        id bigint pk
        code varchar(32) uk as uk_code index
        amount decimal(12,2)? enc enum(1, 2) "금액"
      }`);
    const [, code, amount] = m.tables[0].columns;
    expect(code).toMatchObject({ type: "varchar(32)", uk: true, ukName: "uk_code", index: { name: null } });
    expect(amount).toMatchObject({ type: "decimal(12,2)", nullable: true, enc: true, enumValues: ["1", "2"], description: "금액" });
  });

  it("참조 대상 컬럼을 푼다 — 생략하면 기본키", () => {
    const m = model("external table u {\n  id bigint pk\n}\ntable o {\n  id bigint pk\n  u_id bigint ~> u\n}");
    expect(m.tables.map((t) => [t.name, t.origin])).toEqual([
      ["u", "external"],
      ["o", "table"],
    ]);
    expect(m.tables[1].columns[1].ref).toEqual({ table: "u", column: "id", kind: "logical" });
  });

  it("audit envers 는 revinfo 와 *_aud 를 펼치고 관계를 잇는다", () => {
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
