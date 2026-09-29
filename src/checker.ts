// 구문 트리의 의미 검사. 문법으로는 맞지만 뜻이 성립하지 않는 것을 잡는다 —
// 없는 테이블을 가리키는 참조, 같은 이름 두 번, 널 허용 기본키 같은 것. 규칙은 docs/SPEC.md §4.
//
// 컴파일러(mermaid.ts)는 오류 없이 이 검사를 통과한 트리만 받는다고 가정한다.
// 참조 대상을 푸는 규칙(resolveRef)은 컴파일러도 같이 써야 해서 여기서 내보낸다.

import type { Column, Document, Ident, Table } from "./ast.ts";
import { type Diagnostic, error, warning } from "./diagnostics.ts";

export const AUDIT_SUFFIX = "_aud";
export const REVINFO = "revinfo";
/** 괄호 없는 `audit` 이 싣지 않는 컬럼 — 감사 테이블에 타임스탬프를 복제할 이유가 없다 */
export const AUDIT_SKIP = new Set(["created_at", "updated_at"]);

/** 참조 컬럼이 가리키는 대상 컬럼. 풀 수 없으면 null(검사기가 이미 오류로 보고했다) */
export function resolveRef(doc: Document, col: Column): { table: Table; column: Column } | null {
  if (!col.ref) return null;
  const table = doc.tables.find((t) => t.name.text === col.ref!.table.text);
  if (!table) return null;
  if (col.ref.column) {
    const column = table.columns.find((c) => c.name.text === col.ref!.column!.text);
    return column ? { table, column } : null;
  }
  const pks = table.columns.filter((c) => c.pk);
  return pks.length === 1 ? { table, column: pks[0] } : null;
}

/** `audit` 이 감사 테이블에 싣는 컬럼(기본키 제외). audit 이 없으면 빈 배열 */
export function auditedColumns(table: Table): Column[] {
  if (!table.audit) return [];
  if (table.audit.columns === null)
    return table.columns.filter((c) => !c.pk && !AUDIT_SKIP.has(c.name.text));
  const names = new Set(table.audit.columns.map((i) => i.text));
  return table.columns.filter((c) => !c.pk && names.has(c.name.text));
}

export function check(doc: Document): Diagnostic[] {
  const out: Diagnostic[] = [];
  const tables = new Map<string, Table>();

  for (const t of doc.tables) {
    if (tables.has(t.name.text)) out.push(error(`테이블 \`${t.name.text}\` 을 두 번 선언했습니다`, t.name.span));
    else tables.set(t.name.text, t);
  }

  const audited = doc.tables.filter((t) => t.audit);
  if (audited.length > 0) {
    const generated = new Set([REVINFO, ...audited.map((t) => t.name.text + AUDIT_SUFFIX)]);
    for (const t of doc.tables)
      if (generated.has(t.name.text))
        out.push(
          error(
            `\`${t.name.text}\` 는 \`audit\` 이 자동으로 만드는 테이블 이름과 겹칩니다`,
            t.name.span,
            "직접 선언하지 말고 `audit` 에 맡기거나, 이 테이블 이름을 바꿔 주세요",
          ),
        );
  }

  for (const t of doc.tables) checkTable(doc, t, out);
  return out;
}

function checkTable(doc: Document, t: Table, out: Diagnostic[]): void {
  const cols = new Map<string, Column>();
  for (const c of t.columns) {
    if (cols.has(c.name.text))
      out.push(error(`테이블 \`${t.name.text}\` 에 컬럼 \`${c.name.text}\` 이 두 번 있습니다`, c.name.span));
    else cols.set(c.name.text, c);
  }

  const known = (i: Ident) => {
    if (!cols.has(i.text)) out.push(error(`테이블 \`${t.name.text}\` 에 컬럼 \`${i.text}\` 이 없습니다`, i.span));
  };

  for (const c of t.columns) {
    if (c.pk && c.nullable)
      out.push(error(`기본키 \`${c.name.text}\` 는 널을 허용할 수 없습니다`, c.type.span, "타입 뒤의 `?` 를 지워 주세요"));
    if (c.ref) checkRef(doc, c, out);
  }

  for (const k of t.constraints) {
    k.columns.forEach(known);
    if (k.columns.length === 1)
      out.push(
        warning(
          `한 컬럼짜리 \`${k.kind}(...)\` 입니다`,
          k.span,
          `컬럼 수식어 \`${k.kind === "unique" ? "uk" : "index"}\` 로 적어 주세요`,
        ),
      );
  }

  if (t.audit) {
    if (!t.columns.some((c) => c.pk))
      out.push(error(`기본키가 없는 테이블 \`${t.name.text}\` 에는 \`audit\` 을 쓸 수 없습니다`, t.audit.span));
    for (const i of t.audit.columns ?? []) {
      known(i);
      if (cols.get(i.text)?.pk)
        out.push(warning(`기본키 \`${i.text}\` 는 감사 테이블에 항상 실립니다`, i.span, "목록에서 빼도 됩니다"));
    }
  }
}

function checkRef(doc: Document, c: Column, out: Diagnostic[]): void {
  const ref = c.ref!;
  const target = doc.tables.find((t) => t.name.text === ref.table.text);
  if (!target) {
    out.push(
      error(
        `참조하는 테이블 \`${ref.table.text}\` 이 이 문서에 없습니다`,
        ref.table.span,
        "문서 밖을 가리키는 컬럼은 화살표 없이 설명으로 적어 주세요",
      ),
    );
    return;
  }
  if (ref.column && !target.columns.some((x) => x.name.text === ref.column!.text)) {
    out.push(error(`테이블 \`${target.name.text}\` 에 컬럼 \`${ref.column.text}\` 이 없습니다`, ref.column.span));
    return;
  }
  if (!ref.column && target.columns.filter((x) => x.pk).length !== 1) {
    out.push(
      error(
        `\`${target.name.text}\` 의 기본키가 한 컬럼이 아니라 참조 대상을 정할 수 없습니다`,
        ref.table.span,
        `\`${target.name.text}.컬럼\` 처럼 컬럼을 적어 주세요`,
      ),
    );
    return;
  }
  const resolved = resolveRef(doc, c);
  if (resolved && resolved.column.type.text !== c.type.text)
    out.push(
      warning(
        `타입이 다릅니다: \`${c.name.text}\` 는 ${c.type.text}, \`${resolved.table.name.text}.${resolved.column.name.text}\` 는 ${resolved.column.type.text}`,
        c.type.span,
      ),
    );
}
