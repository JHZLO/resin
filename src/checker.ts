// 구문 트리의 의미 검사. 문법으로는 맞지만 뜻이 성립하지 않는 것을 잡는다 —
// 없는 테이블을 가리키는 참조, 같은 이름 두 번, 널 허용 기본키 같은 것. 규칙은 docs/SPEC.md §4.
//
// 모델(model.ts)은 오류 없이 이 검사를 통과한 트리만 받는다고 가정한다.
// 참조 대상을 푸는 규칙(resolveRef)은 모델도 같이 써야 해서 여기서 내보낸다.

import type { Column, Document, Ident, Table } from "./ast.ts";
import { type Diagnostic, error, warning } from "./diagnostics.ts";

export const AUDIT_SUFFIX = "_aud";
export const REVINFO = "revinfo";
/** 지금 있는 감사 방식 */
export const AUDIT_METHODS = ["envers"] as const;
/** 괄호 없는 `audit envers` 가 싣지 않는 컬럼 — 감사 테이블에 타임스탬프를 복제할 이유가 없다 */
export const AUDIT_SKIP = new Set(["created_at", "updated_at"]);

/** 참조 컬럼이 가리키는 대상 컬럼. 풀 수 없으면 null(검사기가 이미 오류로 보고했다) */
export function resolveRef(doc: Document, col: Column): { table: Table; column: Column } | null {
  const ref = col.ref;
  if (!ref) return null;
  const table = doc.tables.find((t) => t.name.text === ref.table.text);
  if (!table) return null;
  if (ref.column) {
    const name = ref.column.text;
    const column = table.columns.find((c) => c.name.text === name);
    return column ? { table, column } : null;
  }
  const pks = table.columns.filter((c) => c.pk);
  return pks.length === 1 ? { table, column: pks[0] } : null;
}

/** `audit` 이 감사 테이블에 싣는 컬럼(기본키 제외). audit 이 없으면 빈 배열 */
export function auditedColumns(table: Table): Column[] {
  if (!table.audit) return [];
  const list = table.audit.columns;
  if (list === null) return table.columns.filter((c) => !c.pk && !AUDIT_SKIP.has(c.name.text));
  const names = new Set(list.map((i) => i.text));
  return table.columns.filter((c) => !c.pk && names.has(c.name.text));
}

export function check(doc: Document): Diagnostic[] {
  const out: Diagnostic[] = [];
  const tables = new Map<string, Table>();

  for (const t of doc.tables) {
    if (tables.has(t.name.text)) out.push(error(`테이블 \`${t.name.text}\` 을 두 번 선언했습니다`, t.name.span));
    else tables.set(t.name.text, t);
  }

  const audited = doc.tables.filter((t) => t.audit && !t.external);
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
    if (c.ref && t.external)
      out.push(
        error(
          "external table 의 컬럼에는 참조를 적을 수 없습니다",
          c.ref.span,
          "문서 밖 테이블은 참조를 받기만 합니다. 이 관계를 그리려면 테이블을 `table` 로 선언해 주세요",
        ),
      );
    else if (c.ref) checkRef(doc, c, out);
  }

  for (const k of t.constraints) {
    k.columns.forEach(known);
    if (k.columns.length === 1) {
      const modifier = k.kind === "unique" ? "uk" : "index";
      out.push(
        warning(
          `한 컬럼짜리 \`${k.kind}(...)\` 입니다`,
          k.span,
          `컬럼 수식어 \`${modifier}\`${k.name ? ` 와 \`${modifier} as ${k.name.text}\`` : ""} 로 적어 주세요`,
        ),
      );
    }
  }

  // 인덱스와 유니크 이름은 표시용이지만, 한 테이블 안에서 같은 이름이면 어느 쪽인지 알 수 없다
  const names = new Map<string, Ident>();
  const named = (i: Ident | null) => {
    if (!i) return;
    if (names.has(i.text)) out.push(error(`이름 \`${i.text}\` 이 테이블 \`${t.name.text}\` 에서 두 번 쓰였습니다`, i.span));
    else names.set(i.text, i);
  };
  for (const c of t.columns) {
    named(c.uk?.name ?? null);
    named(c.index?.name ?? null);
  }
  for (const k of t.constraints) named(k.name);

  if (t.audit) {
    const a = t.audit;
    if (t.external) out.push(error("external table 에는 `audit` 을 쓸 수 없습니다", a.span));
    else if (!(AUDIT_METHODS as readonly string[]).includes(a.method.text))
      out.push(
        error(`알 수 없는 감사 방식 \`${a.method.text}\``, a.method.span, `지금 있는 방식은 ${AUDIT_METHODS.map((m) => `\`${m}\``).join(", ")} 입니다`),
      );
    else {
      if (!t.columns.some((c) => c.pk))
        out.push(error(`기본키가 없는 테이블 \`${t.name.text}\` 에는 \`audit\` 을 쓸 수 없습니다`, a.span));
      for (const i of a.columns ?? []) {
        known(i);
        if (cols.get(i.text)?.pk)
          out.push(warning(`기본키 \`${i.text}\` 는 감사 테이블에 항상 실립니다`, i.span, "목록에서 빼도 됩니다"));
      }
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
        "문서 밖 테이블이면 `external table` 로 선언해 주세요",
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
  // 타입 이름만 비교한다 — 길이(varchar(32) 와 varchar(64))는 FK 로 흔히 섞여 쓴다
  if (resolved && resolved.column.type.name.text !== c.type.name.text)
    out.push(
      warning(
        `타입이 다릅니다: \`${c.name.text}\` 는 ${c.type.name.text}, \`${resolved.table.name.text}.${resolved.column.name.text}\` 는 ${resolved.column.type.name.text}`,
        c.type.span,
      ),
    );
}
