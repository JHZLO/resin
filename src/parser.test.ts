import { describe, expect, it } from "vitest";
import { parse } from "./parser.ts";

const doc = (body: string) => {
  const r = parse(`erd\n${body}`);
  return { ...r, messages: r.diagnostics.map((d) => d.message) };
};

describe("parse", () => {
  it("컬럼의 이름, 타입, 널 허용, 수식어를 읽는다", () => {
    const { doc: d, diagnostics } = doc(`
      table t "라벨" {
        id bigint pk
        name varchar? uk enc "이름" index(ix_name)
        status varchar enum(A, B,) index
      }`);
    expect(diagnostics).toEqual([]);
    const [t] = d.tables;
    expect(t.label).toBe("라벨");
    const [id, name, status] = t.columns;
    expect([id.name.text, id.type.text, id.nullable, id.pk]).toEqual(["id", "bigint", false, true]);
    expect([name.nullable, name.uk, name.enc, name.description, name.index?.name?.text]).toEqual([
      true, true, true, "이름", "ix_name",
    ]);
    expect(status.enumValues?.map((v) => v.text)).toEqual(["A", "B"]);
    expect(status.index).toMatchObject({ name: null });
  });

  it("-> 는 물리, ~> 는 논리 참조이고 컬럼은 생략할 수 있다", () => {
    const { doc: d } = doc(`
      table t {
        a_id bigint -> a.id
        b_id bigint ~> b
      }`);
    const [a, b] = d.tables[0].columns;
    expect(a.ref).toMatchObject({ kind: "physical", table: { text: "a" }, column: { text: "id" } });
    expect(b.ref).toMatchObject({ kind: "logical", table: { text: "b" }, column: null });
  });

  it("테이블 제약과 audit 을 읽는다", () => {
    const { doc: d, diagnostics } = doc(`
      table t {
        a int
        b int
        unique(a, b)
        index ix_ab(
          a,
          b
        )
      } audit(a)`);
    expect(diagnostics).toEqual([]);
    const t = d.tables[0];
    expect(t.constraints.map((k) => [k.kind, k.name?.text ?? null, k.columns.map((c) => c.text)])).toEqual([
      ["unique", null, ["a", "b"]],
      ["index", "ix_ab", ["a", "b"]],
    ]);
    expect(t.audit?.columns?.map((c) => c.text)).toEqual(["a"]);
  });

  it("괄호 없는 audit 은 columns = null", () => {
    expect(doc("table t {\n id bigint pk\n} audit").doc.tables[0].audit?.columns).toBeNull();
  });

  it("문맥 키워드라서 index, unique 라는 이름의 컬럼도 된다", () => {
    const { doc: d, diagnostics } = doc("table t {\n index int\n unique varchar\n}");
    expect(diagnostics).toEqual([]);
    expect(d.tables[0].columns.map((c) => c.name.text)).toEqual(["index", "unique"]);
  });

  it("한 줄 테이블도 된다", () => {
    const { doc: d, diagnostics } = doc("table t { id bigint pk }");
    expect(diagnostics).toEqual([]);
    expect(d.tables[0].columns).toHaveLength(1);
  });

  it("erd 헤더가 없으면 오류", () => {
    expect(parse("table t {\n}").diagnostics.map((d) => d.message)).toEqual(["문서는 `erd` 로 시작해야 합니다"]);
  });

  describe("오류 복구 — 틀린 줄만 버리고 계속 읽는다", () => {
    it("여러 줄의 오류를 한 번에 보고한다", () => {
      const { doc: d, messages } = doc(`
      table t {
        id bigint pk pk
        name
        ok int
        bad int foo
      }`);
      expect(messages).toEqual([
        "`pk` 를 두 번 적었습니다",
        "컬럼 `name` 의 타입이 없습니다",
        "알 수 없는 수식어 `foo`",
      ]);
      expect(d.tables[0].columns.map((c) => c.name.text)).toEqual(["ok"]);
    });

    it("오류 위치는 문제의 토큰을 짚는다", () => {
      const { diagnostics } = doc("table t {\n  a int foo\n}");
      expect(diagnostics[0].span).toEqual({ line: 3, col: 9, len: 3 });
    });

    it("닫는 } 가 없어도 멈추지 않는다", () => {
      const { doc: d, messages } = doc("table t {\n a int");
      expect(messages).toEqual(["테이블 `t` 의 `}` 가 없습니다"]);
      expect(d.tables[0].columns).toHaveLength(1);
    });

    it("최상위 오류 뒤 다음 table 부터 다시 읽는다", () => {
      const { doc: d, messages } = doc("tabel t {\n a int\n}\ntable u {\n b int\n}");
      expect(messages).toEqual(["알 수 없는 문장 `tabel`"]);
      expect(d.tables.map((t) => t.name.text)).toEqual(["u"]);
    });
  });
});
