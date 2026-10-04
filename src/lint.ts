// Lint: rules of schema design that a document can break and still compile. A reference column
// without an index, a table without a primary key, one that nothing joins, a column name typed two
// ways, an index that another one covers. The rules are defined in docs/SPEC.md §9.
//
// Findings are warnings that carry their rule's name, so a reader can tell advice from the
// compiler's own warnings. They never stop the output. Run only on a document that compiled without
// errors: references are resolved exactly as the model resolves them.

import type { Column, Document, Span, Table } from "./ast.ts";
import { resolveRef, resolveTable } from "./checker.ts";
import { type Diagnostic, sortDiagnostics } from "./diagnostics.ts";

export type LintRule = "ref-index" | "no-pk" | "unrelated" | "type-drift" | "dup-index";

/** Every rule, in the order the docs list them */
export const LINT_RULES: readonly LintRule[] = ["ref-index", "no-pk", "unrelated", "type-drift", "dup-index"];

const finding = (rule: LintRule, message: string, span: Span, hint: string): Diagnostic => ({ severity: "warning", message, span, hint, rule });
const code = (s: string): string => `\`${s}\``;
const list = (cols: readonly Column[]): string => cols.map((c) => code(c.name.text)).join(", ");

interface TableIndex {
  kind: "pk" | "uk" | "unique" | "index";
  name: string | null;
  columns: Column[];
  span: Span;
}

/** Every index of a table, in a fixed order: the primary key, each column's `uk` and `index`, then
 *  the table's constraints. "The later one" of two equal indexes means later in this order */
function indexesOf(t: Table): TableIndex[] {
  const byName = new Map(t.columns.map((c) => [c.name.text, c]));
  const out: TableIndex[] = [];
  const pk = t.columns.filter((c) => c.pk);
  if (pk.length) out.push({ kind: "pk", name: null, columns: pk, span: pk[0].name.span });
  for (const c of t.columns) {
    if (c.uk) out.push({ kind: "uk", name: c.uk.name?.text ?? null, columns: [c], span: c.uk.span });
    if (c.index) out.push({ kind: "index", name: c.index.name?.text ?? null, columns: [c], span: c.index.span });
  }
  for (const k of t.constraints)
    out.push({ kind: k.kind, name: k.name?.text ?? null, columns: k.columns.flatMap((i) => byName.get(i.text) ?? []), span: k.span });
  return out;
}

const unique = (ix: TableIndex): boolean => ix.kind !== "index";
const startsWith = (long: readonly Column[], short: readonly Column[]): boolean => short.length <= long.length && short.every((c, k) => long[k] === c);
const sameSet = (a: readonly Column[], b: readonly Column[]): boolean => a.length === b.length && a.every((c) => b.includes(c));

export function lint(doc: Document): Diagnostic[] {
  const out: Diagnostic[] = [];
  const own = doc.tables.filter((t) => !t.external);

  // ref-index and no-pk: one table at a time
  for (const t of own) {
    const indexes = indexesOf(t);
    for (const c of t.columns)
      if (c.ref && !indexes.some((ix) => ix.columns[0] === c))
        out.push(finding("ref-index", `reference column ${code(c.name.text)} has no index`, c.name.span, "add `index` to the column, or start a composite index with it"));
    if (!t.columns.some((c) => c.pk))
      out.push(finding("no-pk", `table ${code(t.name.text)} has no primary key`, t.name.span, "mark its key column `pk`"));
    for (const fk of t.foreignKeys) {
      const columns = fk.columns.map(c => t.columns.find(x => x.name.text === c.text)!);
      if (!indexes.some(ix => startsWith(ix.columns, columns)))
        out.push(finding("ref-index", "composite reference has no covering index", fk.span, `add index(${fk.columns.map(c => c.text).join(", ")})`));
    }
  }

  // unrelated: tables no reference joins to another table
  if (doc.tables.length >= 2) {
    const joined = new Set<Table>();
    for (const t of doc.tables)
      for (const c of t.columns) {
        const target = resolveRef(doc, c)?.table;
        if (target && target !== t) joined.add(t).add(target);
      }
    for (const t of doc.tables) {
      for (const fk of t.foreignKeys) {
        const target = resolveTable(doc, fk.table.text, t, fk.service?.text);
        if (target && target !== t) joined.add(t).add(target);
      }
    }
    for (const t of doc.tables) {
      if (joined.has(t)) continue;
      out.push(
        t.external
          ? finding("unrelated", `external table ${code(t.name.text)} is not referenced`, t.name.span, "remove it, or point a column at it with `~>`")
          : finding("unrelated", `table ${code(t.name.text)} has no references to or from other tables`, t.name.span, "connect it with `->` or `~>`, if it relates to another table"),
      );
    }
  }

  // type-drift: one column name, two type names. A reference whose types already differ has its own warning
  const byName = new Map<string, { table: Table; column: Column }[]>();
  for (const t of doc.tables)
    for (const c of t.columns) {
      const target = resolveRef(doc, c);
      if (target && target.column.type.name.text !== c.type.name.text) continue;
      const same = byName.get(c.name.text) ?? [];
      byName.set(c.name.text, [...same, { table: t, column: c }]);
    }
  for (const [name, uses] of byName) {
    if (new Set(uses.map((u) => u.table)).size < 2) continue;
    const counts = new Map<string, number>();
    for (const u of uses) counts.set(u.column.type.name.text, (counts.get(u.column.type.name.text) ?? 0) + 1);
    if (counts.size < 2) continue;
    // The type most of them have; Map keeps first-seen order, so a tie goes to the first
    const norm = [...counts].reduce((best, next) => (next[1] > best[1] ? next : best))[0];
    const usual = uses.filter((u) => u.column.type.name.text === norm).map((u) => code(u.table.name.text));
    const where = usual.length > 3 ? `${usual.slice(0, 3).join(", ")} and ${usual.length - 3} more` : usual.join(", ");
    for (const u of uses)
      if (u.column.type.name.text !== norm)
        out.push(
          finding("type-drift", `column ${code(name)} is ${u.column.type.name.text} here but ${norm} in ${where}`, u.column.type.span, `use the same type for every ${code(name)} column`),
        );
  }

  // dup-index: an index another one covers, and a unique constraint that repeats the primary key
  for (const t of own) {
    const indexes = indexesOf(t);
    const pk = indexes.find((ix) => ix.kind === "pk");
    indexes.forEach((ix, i) => {
      if (ix.kind === "uk" || ix.kind === "unique") {
        if (pk && sameSet(ix.columns, pk.columns))
          out.push(finding("dup-index", `unique on (${list(ix.columns)}) repeats the primary key`, ix.span, "remove it; a primary key is unique already"));
        return;
      }
      if (ix.kind !== "index") return;
      const cover = indexes.find(
        (other, j) => j !== i && startsWith(other.columns, ix.columns) && (other.columns.length > ix.columns.length || unique(other) || j < i),
      );
      if (!cover) return;
      const self = ix.name ? `index ${code(ix.name)} on` : "the index on";
      const by = cover.kind === "pk" ? "the primary key" : cover.name ? code(cover.name) : unique(cover) ? "a unique constraint" : "another index";
      const hint =
        cover.columns.length > ix.columns.length
          ? `remove it; the wider index serves lookups on (${list(ix.columns)}) too`
          : "remove it; the other one indexes the same columns";
      out.push(finding("dup-index", `${self} (${list(ix.columns)}) is covered by ${by} (${list(cover.columns)})`, ix.span, hint));
    });
  }

  return sortDiagnostics(out);
}
