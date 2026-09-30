// 모델 → Mermaid `erDiagram` 원문. 대응 규칙은 docs/SPEC.md §5.
//
// 결정적이어야 한다: 같은 입력이면 바이트 단위로 같은 출력. 순서는 전부 모델 순서(= 문서 순서)에서
// 유도하고 Map/Set 순회 순서나 로케일 정렬에 기대지 않는다. 출력 형식을 바꾸면 examples/*.mmd 골든이
// 바뀌므로, 골든 diff 를 눈으로 확인하고 `pnpm test -u` 로 갱신한다.

import type { Model, ModelColumn, ModelTable } from "./model.ts";

const I1 = "    ";
const I2 = "        ";

/** mermaid 는 `\"` 이스케이프를 모른다 — 따옴표는 엔티티 코드로 */
const quote = (s: string): string => `"${s.replace(/"/g, "#quot;")}"`;

// mermaid 11.16 이 따옴표 없이 읽지 못하는 테이블 이름(실측) + 같은 부류의 예약어. 대소문자 무시
const RESERVED = new Set(["class", "classdef", "style", "erdiagram", "direction", "acctitle", "accdescr", "title", "to", "one", "many"]);

/** 테이블 이름 — 영문, 숫자, `_` 로만 된 예약어 아닌 이름만 그대로 쓰고 나머지는 따옴표로 감싼다 */
export function entityName(name: string): string {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) && !RESERVED.has(name.toLowerCase()) ? name : quote(name);
}

/** 컬럼 이름 — mermaid 는 속성 이름에 따옴표를 받지 않아서 고쳐 쓴다. 바뀌었으면 changed */
export function attributeName(name: string): { text: string; changed: boolean } {
  let text = name.replace(/[^\p{L}\p{N}_-]/gu, "_");
  if (/^[\p{N}-]/u.test(text)) text = "_" + text;
  if (/^(pk|fk|uk)$/i.test(text)) text += "_";
  return { text, changed: text !== name };
}

export function toMermaid(model: Model): string {
  const out: string[] = ["erDiagram"];

  const domain = model.relations.filter((r) => r.origin === "table");
  const audit = model.relations.filter((r) => r.origin === "audit");
  if (domain.length > 0) out.push(`${I1}%% solid(--)=physical FK / dotted(..)=logical reference`);
  for (const r of domain) {
    const left = r.optional ? "|o" : "||";
    const line = r.kind === "physical" ? "--" : "..";
    const right = r.one ? "o|" : "o{";
    out.push(`${I1}${entityName(r.parent)} ${left}${line}${right} ${entityName(r.child)} : ${quote(r.childColumn)}`);
  }
  if (domain.length > 0 && audit.length > 0) out.push("");
  for (const r of audit) out.push(`${I1}${entityName(r.parent)} ||..o{ ${entityName(r.child)} : "Envers rev"`);

  for (const t of model.tables) out.push("", ...entity(t));
  if (model.tables.some((t) => t.origin === "external")) out.push("", `${I1}classDef external stroke-dasharray:4 3`);
  return out.join("\n") + "\n";
}

function entity(t: ModelTable): string[] {
  let head = entityName(t.name);
  if (t.description) head += `[${quote(`${t.name} (${t.description})`)}]`;
  if (t.origin === "external") head += ":::external";

  // 복합 제약은 mermaid 에 자리가 없어 첫 컬럼의 코멘트에 싣는다
  const notes = new Map<string, string[]>();
  for (const k of t.constraints) {
    const tag = k.name ?? (k.kind === "unique" ? "uk" : "ix");
    const list = notes.get(k.columns[0]) ?? [];
    list.push(`${tag}(${k.columns.join(",")})`);
    notes.set(k.columns[0], list);
  }
  const lines = t.columns.map((c) => I2 + (t.origin === "audit" ? auditAttribute(c) : attribute(c, notes.get(c.name) ?? [])));
  return [`${I1}${head} {`, ...lines, `${I1}}`];
}

function keys(c: ModelColumn): string {
  return [c.pk && "PK", c.ref && "FK", c.uk && "UK"].filter(Boolean).join(",");
}

function attribute(c: ModelColumn, notes: string[]): string {
  const name = attributeName(c.name);
  // "`원래 이름`; 설명 (enc) A/B; -> t.c (uk_name) (ix_name); uk(a,b)"
  const facts = [
    [c.description, c.enc ? "(enc)" : null, c.enumValues ? c.enumValues.join("/") : null].filter((x) => x !== null && x !== "").join(" "),
    c.ref ? `${c.ref.kind === "physical" ? "->" : "~>"} ${c.ref.table}.${c.ref.column}` : "",
  ]
    .filter((x) => x !== "")
    .join("; ");
  const names = [c.ukName ? `(${c.ukName})` : "", c.index ? `(${c.index.name ?? "ix"})` : ""].filter((x) => x !== "").join(" ");
  const comment = [name.changed ? `\`${c.name}\`` : "", [facts, names].filter((x) => x !== "").join(" "), ...notes]
    .filter((x) => x !== "")
    .join("; ");

  let line = `${c.type}${c.nullable ? "?" : ""} ${name.text}`;
  const k = keys(c);
  if (k) line += ` ${k}`;
  if (comment) line += ` ${quote(comment)}`;
  return line;
}

/** 감사 테이블은 무엇이 버전 관리되는지만 적는다 — 널 여부와 설명은 원래 테이블에 있다 */
function auditAttribute(c: ModelColumn): string {
  const name = attributeName(c.name);
  const k = [c.pk && "PK", c.ref && "FK"].filter(Boolean).join(",");
  let line = `${c.type} ${name.text}`;
  if (k) line += ` ${k}`;
  if (name.changed) line += ` ${quote(`\`${c.name}\``)}`;
  return line;
}
