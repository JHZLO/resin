// Resin 의 구문 트리. 파서(parser.ts)가 만들고, 검사기(checker.ts)와 모델(model.ts)이 읽는다.
//
// 모든 노드가 원문 위치(span)를 들고 다닌다 — 진단 메시지와, 나중에 에디터 기능(호버, 이동)이
// 원문의 어느 글자를 가리키는지 알아야 하기 때문이다. 문법의 정본은 docs/SPEC.md 다.

/** 원문 위치. 줄, 열은 1부터. 한 줄 안의 구간만 표현한다(여러 줄에 걸친 노드는 시작 줄만). */
export interface Span {
  line: number;
  col: number;
  /** 글자 수(코드 유닛). 0 이면 지점 하나 */
  len: number;
}

/** 이름 하나 — 원문 위치를 함께 들고 있어야 "이 이름이 없다" 같은 진단이 정확한 자리를 짚는다 */
export interface Ident {
  text: string;
  span: Span;
  /** 백틱으로 감싼 이름. 키워드로 읽히지 않는다 */
  quoted?: boolean;
}

export interface Document {
  tables: Table[];
}

export interface Table {
  name: Ident;
  /** `external table` — 이 문서 밖에 있는 테이블. 참조를 받기만 한다 */
  external: boolean;
  /** 사람이 읽을 테이블 설명(`table t "주문"`). 없으면 null */
  description: string | null;
  columns: Column[];
  constraints: TableConstraint[];
  audit: Audit | null;
  span: Span;
}

export interface TypeRef {
  name: Ident;
  /** `varchar(32)`, `decimal(12,2)` 의 인자. 없으면 null */
  args: number[] | null;
  span: Span;
}

export interface Column {
  name: Ident;
  type: TypeRef;
  nullable: boolean;
  pk: boolean;
  /** `uk` / `uk as 이름`. 없으면 null */
  uk: { name: Ident | null; span: Span } | null;
  enc: boolean;
  /** `enum(A, B)` / `enum(0, 1)`. 없으면 null */
  enumValues: EnumValue[] | null;
  /** `index` / `index as 이름`. 없으면 null, 이름을 모르면 name = null */
  index: { name: Ident | null; span: Span } | null;
  ref: Ref | null;
  description: string | null;
  span: Span;
}

export interface EnumValue {
  text: string;
  span: Span;
}

export interface Ref {
  /** physical = `->` (DB FK 제약), logical = `~>` (앱 레벨 참조) */
  kind: "physical" | "logical";
  table: Ident;
  /** 생략하면 null — 검사기가 대상 테이블의 단일 기본키로 푼다 */
  column: Ident | null;
  span: Span;
}

export interface TableConstraint {
  kind: "unique" | "index";
  name: Ident | null;
  columns: Ident[];
  span: Span;
}

export interface Audit {
  /** 감사 방식. 지금은 `envers` 하나 */
  method: Ident;
  /** null = 괄호 없이 — 기본키와 created_at/updated_at 을 뺀 전부 */
  columns: Ident[] | null;
  span: Span;
}

/** `varchar(32)` — 타입 이름과 인자를 적힌 그대로 */
export const typeText = (t: TypeRef): string => (t.args ? `${t.name.text}(${t.args.join(",")})` : t.name.text);
