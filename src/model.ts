// 검사를 통과한 구문 트리 → 모델. 출력(mermaid, SVG)은 모델만 읽는다.
//
// 왜 한 단계가 더 있나: 참조 풀기, 몇 대 몇인지, 부모가 꼭 있는지, 감사 테이블 펼치기 같은 유도
// 규칙을 출력마다 다시 짜면 출력끼리 어긋난다. 여기서 한 번 풀고, 규칙의 테스트도 여기 모은다.
// 원문 위치(span)는 버린다 — 모델은 "무엇을 그리나"만 담는다.

import { type Column, type Document, type Table, typeText } from "./ast.ts";
import { AUDIT_SUFFIX, REVINFO, auditedColumns, resolveRef } from "./checker.ts";

export type TableOrigin = "table" | "external" | "audit";

export interface Model {
  /** 문서 순서(external 포함), 그 뒤에 펼친 감사 테이블(revinfo, *_aud) */
  tables: ModelTable[];
  /** 자식 테이블, 컬럼의 문서 순서. 그 뒤에 감사 관계 */
  relations: Relation[];
}

export interface ModelTable {
  name: string;
  description: string | null;
  /** table = 문서의 테이블, external = 문서 밖 테이블, audit = audit 이 만든 테이블 */
  origin: TableOrigin;
  columns: ModelColumn[];
  constraints: ModelConstraint[];
  /** 이 테이블에 붙은 감사. 출력이 감사 테이블을 접어서 보여 줄 때 쓴다 */
  audit: { method: string; columns: string[] } | null;
}

export interface ModelColumn {
  name: string;
  /** 인자까지 적힌 그대로: `varchar(32)` */
  type: string;
  nullable: boolean;
  pk: boolean;
  uk: boolean;
  ukName: string | null;
  enc: boolean;
  enumValues: string[] | null;
  index: { name: string | null } | null;
  description: string | null;
  ref: { table: string; column: string; kind: "physical" | "logical" } | null;
}

export interface ModelConstraint {
  kind: "unique" | "index";
  name: string | null;
  columns: string[];
}

export interface Relation {
  parent: string;
  parentColumn: string;
  child: string;
  childColumn: string;
  kind: "physical" | "logical";
  /** 1:1 — 참조 컬럼이 uk 거나 테이블의 유일한 기본키 */
  one: boolean;
  /** 부모가 없을 수 있다 — 참조 컬럼이 널 허용 */
  optional: boolean;
  origin: "table" | "audit";
}

const plain = (name: string, type: string, extra: Partial<ModelColumn> = {}): ModelColumn => ({
  name,
  type,
  nullable: false,
  pk: false,
  uk: false,
  ukName: null,
  enc: false,
  enumValues: null,
  index: null,
  description: null,
  ref: null,
  ...extra,
});

export function lower(doc: Document): Model {
  const tables: ModelTable[] = [];
  const relations: Relation[] = [];

  for (const t of doc.tables) {
    const pkCount = t.columns.filter((c) => c.pk).length;
    tables.push({
      name: t.name.text,
      description: t.description,
      origin: t.external ? "external" : "table",
      columns: t.columns.map((c) => column(doc, c)),
      constraints: t.constraints.map((k) => ({ kind: k.kind, name: k.name?.text ?? null, columns: k.columns.map((i) => i.text) })),
      audit: t.audit ? { method: t.audit.method.text, columns: auditedColumns(t).map((c) => c.name.text) } : null,
    });
    for (const c of t.columns) {
      const target = resolveRef(doc, c);
      if (!target) continue;
      relations.push({
        parent: target.table.name.text,
        parentColumn: target.column.name.text,
        child: t.name.text,
        childColumn: c.name.text,
        kind: c.ref!.kind,
        one: c.uk !== null || (c.pk && pkCount === 1),
        optional: c.nullable,
        origin: "table",
      });
    }
  }

  const audited = doc.tables.filter((t) => t.audit && !t.external);
  if (audited.length > 0) {
    tables.push({
      name: REVINFO,
      description: null,
      origin: "audit",
      columns: [plain("rev", "int", { pk: true }), plain("revtstmp", "bigint")],
      constraints: [],
      audit: null,
    });
    for (const t of audited) tables.push(envers(t));
    for (const t of audited)
      relations.push({
        parent: REVINFO,
        parentColumn: "rev",
        child: t.name.text + AUDIT_SUFFIX,
        childColumn: "rev",
        kind: "logical",
        one: false,
        optional: false,
        origin: "audit",
      });
  }
  return { tables, relations };
}

function column(doc: Document, c: Column): ModelColumn {
  const target = resolveRef(doc, c);
  return {
    name: c.name.text,
    type: typeText(c.type),
    nullable: c.nullable,
    pk: c.pk,
    uk: c.uk !== null,
    ukName: c.uk?.name?.text ?? null,
    enc: c.enc,
    enumValues: c.enumValues?.map((v) => v.text) ?? null,
    index: c.index ? { name: c.index.name?.text ?? null } : null,
    description: c.description,
    ref: target && c.ref ? { table: target.table.name.text, column: target.column.name.text, kind: c.ref.kind } : null,
  };
}

/** Hibernate Envers 감사 테이블: 기본키, rev, revtype, 그리고 감사하는 컬럼.
 *  감사하는 컬럼은 널 허용이다 — Envers 는 삭제 이력에 기본키 밖의 값을 비워 둔다 */
function envers(t: Table): ModelTable {
  return {
    name: t.name.text + AUDIT_SUFFIX,
    description: null,
    origin: "audit",
    columns: [
      ...t.columns.filter((c) => c.pk).map((c) => plain(c.name.text, typeText(c.type), { pk: true })),
      plain("rev", "int", { pk: true, ref: { table: REVINFO, column: "rev", kind: "logical" } }),
      plain("revtype", "tinyint"),
      ...auditedColumns(t).map((c) => plain(c.name.text, typeText(c.type), { nullable: true })),
    ],
    constraints: [],
    audit: null,
  };
}
