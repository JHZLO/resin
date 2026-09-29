import { describe, expect, it } from "vitest";
import { check } from "./checker.ts";
import { parse } from "./parser.ts";

const run = (body: string) => {
  const { doc, diagnostics } = parse(`erd\n${body}`);
  expect(diagnostics).toEqual([]); // 이 파일은 의미 검사만 본다 — 구문은 맞아야 한다
  return check(doc).map((d) => `${d.severity}: ${d.message}`);
};

describe("check", () => {
  it("맞는 문서는 진단이 없다", () => {
    expect(run("table a {\n id bigint pk\n}\ntable b {\n id bigint pk\n a_id bigint -> a\n}")).toEqual([]);
  });

  it("없는 테이블, 없는 컬럼을 가리키는 참조", () => {
    expect(run("table b {\n x bigint -> nope.id\n y bigint -> b.nope\n}")).toEqual([
      "error: 참조하는 테이블 `nope` 이 이 문서에 없습니다",
      "error: 테이블 `b` 에 컬럼 `nope` 이 없습니다",
    ]);
  });

  it("컬럼을 생략한 참조는 대상의 기본키가 한 컬럼이어야 한다", () => {
    expect(run("table a {\n x int pk\n y int pk\n}\ntable b {\n a_x int -> a\n}")).toEqual([
      "error: `a` 의 기본키가 한 컬럼이 아니라 참조 대상을 정할 수 없습니다",
    ]);
  });

  it("참조 타입이 다르면 경고", () => {
    expect(run("table a {\n id bigint pk\n}\ntable b {\n a_id int -> a\n}")).toEqual([
      "warning: 타입이 다릅니다: `a_id` 는 int, `a.id` 는 bigint",
    ]);
  });

  it("중복 테이블, 중복 컬럼, 널 허용 기본키", () => {
    expect(run("table a {\n id bigint? pk\n id int\n}\ntable a {\n}")).toEqual([
      "error: 테이블 `a` 을 두 번 선언했습니다",
      "error: 테이블 `a` 에 컬럼 `id` 이 두 번 있습니다",
      "error: 기본키 `id` 는 널을 허용할 수 없습니다",
    ]);
  });

  it("audit: 기본키 필요, 컬럼 존재, 자동 생성 이름과 충돌", () => {
    expect(run("table a {\n x int\n} audit(nope)\ntable revinfo {\n rev int pk\n}")).toEqual([
      "error: `revinfo` 는 `audit` 이 자동으로 만드는 테이블 이름과 겹칩니다",
      "error: 기본키가 없는 테이블 `a` 에는 `audit` 을 쓸 수 없습니다",
      "error: 테이블 `a` 에 컬럼 `nope` 이 없습니다",
    ]);
  });

  it("한 컬럼짜리 복합 제약은 수식어로 쓰라고 경고", () => {
    expect(run("table a {\n x int\n unique(x)\n}")).toEqual(["warning: 한 컬럼짜리 `unique(...)` 입니다"]);
  });
});
