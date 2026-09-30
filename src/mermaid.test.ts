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
  it("1:1 은 o|, 논리 참조는 점선, 널 허용 FK 는 부모 쪽 |o", () => {
    const out = mmd("table a {\n id bigint pk\n}\ntable b {\n a_id bigint uk ~> a\n c_id bigint? -> a\n}");
    expect(out).toContain('    a ||..o| b : "a_id"');
    expect(out).toContain('    a |o--o{ b : "c_id"');
    expect(out).toContain('        bigint a_id FK,UK "~> a.id"');
    expect(out).toContain('        bigint? c_id FK "-> a.id"');
  });

  it("유일한 기본키인 FK 는 1:1", () => {
    expect(mmd("table a {\n id bigint pk\n}\ntable a_ext {\n id bigint pk -> a\n}")).toContain("    a ||--o| a_ext");
  });

  it("테이블 설명은 이름을 앞에 둔 별칭, external 은 :::external 과 classDef", () => {
    const out = mmd('external table users "회원" {\n id bigint pk\n}\ntable o "주문" {\n id bigint pk\n u_id bigint ~> users\n}');
    expect(out).toContain('    users["users (회원)"]:::external {');
    expect(out).toContain('    o["o (주문)"] {');
    expect(out.trimEnd().endsWith("    classDef external stroke-dasharray:4 3")).toBe(true);
  });

  it("이름과 인덱스, 복합 제약은 코멘트에 싣는다", () => {
    const out = mmd(`
      table t {
        id bigint pk
        a varchar(32) uk as uk_a index as ix_a "설명"
        b int
        unique(a, b) as uk_ab
        index(b, a)
      }`);
    expect(out).toContain('        varchar(32) a UK "설명 (uk_a) (ix_a); uk_ab(a,b)"');
    expect(out).toContain('        int b "ix(b,a)"');
  });

  it("설명의 따옴표는 #quot; 로 바꾼다 — mermaid 는 \\\" 를 모른다", () => {
    expect(mmd('table a {\n x int "say \\"hi\\""\n}')).toContain('int x "say #quot;hi#quot;"');
  });

  it("오류가 있으면 모델도 mermaid 도 만들지 않는다", () => {
    const r = compile("table a {\n x int -> nope\n}");
    expect([r.model, r.mermaid]).toEqual([null, null]);
    expect(r.diagnostics).toHaveLength(1);
  });

  it("같은 입력이면 같은 출력", () => {
    const src = readFileSync(join(EXAMPLES, "order.erd"), "utf8");
    expect(compile(src).mermaid).toBe(compile(src).mermaid);
  });
});

describe("이름 옮기기 — mermaid 가 그대로 못 읽는 이름", () => {
  it("테이블: 영문, 숫자, _ 가 아니거나 예약어면 따옴표", () => {
    expect(["users", "ts_order", "style", "Class", "to", "order-items", "주문", "1a"].map(entityName)).toEqual([
      "users", "ts_order", '"style"', '"Class"', '"to"', '"order-items"', '"주문"', '"1a"',
    ]);
  });

  it("컬럼: 따옴표를 못 쓰니 고쳐 쓰고 바뀌었는지 알린다", () => {
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

  it("고친 컬럼 이름은 코멘트 맨 앞에 원래 이름을 싣는다", () => {
    const out = mmd('table style {\n pk int pk\n `order no` varchar "주문번호"\n}\ntable x {\n s_pk int -> style\n}');
    expect(out).toContain('    "style" ||--o{ x : "s_pk"');
    expect(out).toContain('    "style" {');
    expect(out).toContain('        int pk_ PK "`pk`"');
    expect(out).toContain('        varchar order_no "`order no`; 주문번호"');
  });
});

// 골든: examples/<name>.erd → examples/<name>.mmd. 출력 형식을 바꾸면 여기가 깨진다 —
// diff 를 눈으로 확인하고 의도한 변화일 때만 `pnpm test -u` 로 갱신한다.
describe("golden", () => {
  for (const file of readdirSync(EXAMPLES).filter((f) => f.endsWith(".erd")).sort()) {
    it(file, async () => {
      const r = compile(readFileSync(join(EXAMPLES, file), "utf8"));
      expect(r.diagnostics).toEqual([]);
      await expect(r.mermaid).toMatchFileSnapshot(join(EXAMPLES, file.replace(/\.erd$/, ".mmd")));
    });
  }
});
