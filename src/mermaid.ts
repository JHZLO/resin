// 검사를 통과한 구문 트리 → Mermaid `erDiagram` 원문. 대응 규칙은 docs/SPEC.md §5.
//
// 결정적이어야 한다: 같은 입력이면 바이트 단위로 같은 출력. 순서는 전부 문서 순서에서 유도하고
// Map/Set 순회 순서나 로케일 정렬에 기대지 않는다. 출력 형식을 바꾸면 examples/*.mmd 골든이
// 바뀌므로, 골든 diff 를 눈으로 확인하고 `pnpm test -u` 로 갱신한다.

import type { Column, Document, Table } from "./ast.ts";
import { AUDIT_SUFFIX, REVINFO, auditedColumns, resolveRef } from "./checker.ts";

const I1 = "    ";
const I2 = "        ";

/** mermaid 는 `\"` 이스케이프를 모른다 — 따옴표는 엔티티 코드로 */
const quote = (s: string): string => `"${s.replace(/"/g, "#quot;")}"`;

export function toMermaid(doc: Document): string {
  const out: string[] = ["erDiagram"];

  const rels: string[] = [];
  for (const child of doc.tables)
    for (const col of child.columns) {
      const target = resolveRef(doc, col);
      if (!target) continue;
      const line = col.ref!.kind === "physical" ? "--" : "..";
      const card = col.uk ? "o|" : "o{";
      rels.push(`${I1}${target.table.name.text} ||${line}${card} ${child.name.text} : ${quote(col.name.text)}`);
    }

  const audited = doc.tables.filter((t) => t.audit);
  const auditRels = audited.map((t) => `${I1}${REVINFO} ||..o{ ${t.name.text}${AUDIT_SUFFIX} : "Envers rev"`);

  if (rels.length > 0) out.push(`${I1}%% solid(--)=physical FK / dotted(..)=logical reference`);
  out.push(...rels);
  if (rels.length > 0 && auditRels.length > 0) out.push("");
  out.push(...auditRels);

  for (const t of doc.tables) out.push("", ...entity(doc, t));
  if (audited.length > 0) {
    out.push("", `${I1}${REVINFO} {`, `${I2}int rev PK`, `${I2}bigint revtstmp`, `${I1}}`);
    for (const t of audited) out.push("", ...auditEntity(t));
  }
  return out.join("\n") + "\n";
}

function entity(doc: Document, t: Table): string[] {
  // 복합 제약은 mermaid 에 자리가 없어 첫 컬럼의 코멘트에 싣는다
  const notes = new Map<string, string[]>();
  for (const k of t.constraints) {
    const first = k.columns[0].text;
    const tag = k.kind === "unique" ? "uk" : (k.name?.text ?? "ix");
    const list = notes.get(first) ?? [];
    list.push(`${tag}(${k.columns.map((c) => c.text).join(",")})`);
    notes.set(first, list);
  }
  return [`${I1}${t.name.text} {`, ...t.columns.map((c) => I2 + attribute(doc, c, notes.get(c.name.text) ?? [])), `${I1}}`];
}

function attribute(doc: Document, c: Column, notes: string[]): string {
  const keys = [c.pk && "PK", c.ref && "FK", c.uk && "UK"].filter(Boolean).join(",");

  // "설명 (enc) A/B; -> t.c (ix_name); uk(a,b)" — 인덱스는 맨 앞 사실 묶음 끝에 붙는다
  const target = resolveRef(doc, c);
  const facts = [
    [c.description, c.enc ? "(enc)" : null, c.enumValues ? c.enumValues.map((v) => v.text).join("/") : null]
      .filter((x) => x !== null && x !== "")
      .join(" "),
    target ? `${c.ref!.kind === "physical" ? "->" : "~>"} ${target.table.name.text}.${target.column.name.text}` : "",
  ]
    .filter((x) => x !== "")
    .join("; ");
  const index = c.index ? `(${c.index.name?.text ?? "ix"})` : "";
  const comment = [[facts, index].filter((x) => x !== "").join(" "), ...notes].filter((x) => x !== "").join("; ");

  let line = `${c.type.text}${c.nullable ? "?" : ""} ${c.name.text}`;
  if (keys) line += ` ${keys}`;
  if (comment) line += ` ${quote(comment)}`;
  return line;
}

/** Envers 감사 테이블 — 무엇이 버전 관리되는지만 적는다(널 여부, 설명 없음) */
function auditEntity(t: Table): string[] {
  const pks = t.columns.filter((c) => c.pk).map((c) => `${I2}${c.type.text} ${c.name.text} PK`);
  const cols = auditedColumns(t).map((c) => `${I2}${c.type.text} ${c.name.text}`);
  return [
    `${I1}${t.name.text}${AUDIT_SUFFIX} {`,
    ...pks,
    `${I2}int rev PK,FK`,
    `${I2}tinyint revtype`,
    ...cols,
    `${I1}}`,
  ];
}
