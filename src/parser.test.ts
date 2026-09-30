import { describe, expect, it } from "vitest";
import { typeText } from "./ast.ts";
import { parse } from "./parser.ts";

const doc = (body: string) => {
  const r = parse(body);
  return { ...r, messages: r.diagnostics.map((d) => d.message), hints: r.diagnostics.map((d) => d.hint ?? null) };
};

describe("parse", () => {
  it("컬럼의 이름, 타입, 널 허용, 수식어를 읽는다", () => {
    const { doc: d, diagnostics } = doc(`
      table t "설명" {
        id bigint pk
        name varchar(32)? uk as uk_name enc "이름" index as ix_name
        status varchar enum(A, B,) index
        kind tinyint enum(0, 1, 2)
      }`);
    expect(diagnostics).toEqual([]);
    const [t] = d.tables;
    expect([t.name.text, t.external, t.description]).toEqual(["t", false, "설명"]);
    const [id, name, status, kind] = t.columns;
    expect([id.name.text, typeText(id.type), id.nullable, id.pk]).toEqual(["id", "bigint", false, true]);
    expect([typeText(name.type), name.nullable, name.uk?.name?.text, name.enc, name.description, name.index?.name?.text]).toEqual([
      "varchar(32)", true, "uk_name", true, "이름", "ix_name",
    ]);
    expect(status.enumValues?.map((v) => v.text)).toEqual(["A", "B"]);
    expect(status.index).toMatchObject({ name: null });
    expect(kind.enumValues?.map((v) => v.text)).toEqual(["0", "1", "2"]);
  });

  it("타입 인자는 수 목록이고 span 은 괄호까지 덮는다", () => {
    const { doc: d, diagnostics } = doc("table t {\n  amount decimal(12,2)\n}");
    expect(diagnostics).toEqual([]);
    const { type } = d.tables[0].columns[0];
    expect([type.name.text, type.args]).toEqual(["decimal", [12, 2]]);
    expect(type.span).toEqual({ line: 2, col: 10, len: 13 });
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

  it("external table 을 읽는다", () => {
    const { doc: d, diagnostics } = doc('external table users "회원" {\n  id bigint pk\n}');
    expect(diagnostics).toEqual([]);
    expect(d.tables[0]).toMatchObject({ name: { text: "users" }, external: true, description: "회원" });
  });

  it("테이블 제약과 이름, audit 방식을 읽는다", () => {
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

  it("괄호 없는 audit envers 는 columns = null", () => {
    expect(doc("table t {\n id bigint pk\n} audit envers").doc.tables[0].audit).toMatchObject({ method: { text: "envers" }, columns: null });
  });

  it("문맥 키워드라서 index, unique, as 라는 이름의 컬럼도 된다", () => {
    const { doc: d, diagnostics } = doc("table t {\n index int\n unique varchar(32)\n as bigint\n}");
    expect(diagnostics).toEqual([]);
    expect(d.tables[0].columns.map((c) => [c.name.text, typeText(c.type)])).toEqual([
      ["index", "int"],
      ["unique", "varchar(32)"],
      ["as", "bigint"],
    ]);
  });

  it("백틱 이름은 키워드로 읽히지 않는다", () => {
    const { doc: d, diagnostics } = doc("table `order-items` {\n `pk` int pk\n}");
    expect(diagnostics).toEqual([]);
    expect(d.tables[0].name).toMatchObject({ text: "order-items", quoted: true });
    expect(d.tables[0].columns[0]).toMatchObject({ name: { text: "pk", quoted: true }, pk: true });
  });

  it("한 줄 테이블도 된다", () => {
    const { doc: d, diagnostics } = doc("table t { id bigint pk }");
    expect(diagnostics).toEqual([]);
    expect(d.tables[0].columns).toHaveLength(1);
  });

  describe("v0.1 문법은 고치는 법을 알려 준다", () => {
    it("첫 줄 erd", () => {
      const r = doc("erd\n  table t {\n    id int pk\n  }");
      expect(r.messages).toEqual(["v0.2 부터 첫 줄에 `erd` 를 쓰지 않습니다"]);
      expect(r.doc.tables.map((t) => t.name.text)).toEqual(["t"]);
    });

    it("index(이름)", () => {
      const r = doc("table t {\n a int index(ix_a)\n}");
      expect(r.messages).toEqual(["v0.2 부터 인덱스 이름은 `as` 뒤에 적습니다"]);
      expect(r.hints).toEqual(["`index as ix_a`"]);
    });

    it("unique 이름(a, b)", () => {
      const r = doc("table t {\n a int\n b int\n unique uk_ab(a, b)\n}");
      expect(r.messages).toEqual(["v0.2 부터 제약 이름은 괄호 뒤 `as` 로 적습니다"]);
      expect(r.hints).toEqual(["`unique(a, ...) as uk_ab`"]);
    });

    it("방식 없는 audit", () => {
      expect(doc("table t {\n id int pk\n} audit(id)").messages).toEqual(["`audit` 뒤에 감사 방식을 적어야 합니다"]);
      expect(doc("table t {\n id int pk\n} audit").messages).toEqual(["`audit` 뒤에 감사 방식을 적어야 합니다"]);
    });

    it("uk 뒤 맨 이름", () => {
      const r = doc("table t {\n a int uk uk_a\n}");
      expect(r.messages).toEqual(["알 수 없는 수식어 `uk_a`"]);
      expect(r.hints).toEqual(["이름을 붙이려면 `uk as uk_a`"]);
    });
  });

  describe("오류 복구 — 틀린 줄만 버리고 계속 읽는다", () => {
    it("여러 줄의 오류를 한 번에 보고한다", () => {
      const { doc: d, messages } = doc(`
      table t {
        id bigint pk pk
        name
        ok int
        bad int foo
        amount decimal(a)
      }`);
      expect(messages).toEqual([
        "`pk` 를 두 번 적었습니다",
        "컬럼 `name` 의 타입이 없습니다",
        "알 수 없는 수식어 `foo`",
        "타입 인자는 수여야 합니다 (실제: `a`)",
      ]);
      expect(d.tables[0].columns.map((c) => c.name.text)).toEqual(["ok"]);
    });

    it("오류 위치는 문제의 토큰을 짚는다", () => {
      const { diagnostics } = doc("table t {\n  a int foo\n}");
      expect(diagnostics[0].span).toEqual({ line: 2, col: 9, len: 3 });
    });

    it("닫는 } 가 없어도 멈추지 않는다", () => {
      const { doc: d, messages } = doc("table t {\n a int");
      expect(messages).toEqual(["테이블 `t` 의 `}` 가 없습니다"]);
      expect(d.tables[0].columns).toHaveLength(1);
    });

    it("최상위 오류 뒤 다음 table 부터 다시 읽는다", () => {
      const { doc: d, messages } = doc("tabel t {\n a int\n}\nexternal table u {\n b int\n}");
      expect(messages).toEqual(["알 수 없는 문장 `tabel`"]);
      expect(d.tables.map((t) => t.name.text)).toEqual(["u"]);
    });

    it("external 뒤에 table 이 없으면 오류", () => {
      expect(doc("external users {\n id int\n}").messages).toEqual(["`external` 뒤에는 `table` 이 와야 합니다"]);
    });
  });
});
