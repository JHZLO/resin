// Two models → one model that draws what changed between them, and the list of changes.
//
// The merged model is the newer model with what is gone put back where it was: a removed table after
// the table that came before it, a removed column after the column that came before it, a removed
// relation with the rest. Every part that was added, removed or changed carries `change`, which the
// renderer marks in color. Generated audit tables are left out of the comparison: a change to them
// shows as a change to the `audit` of their table.

import type { Model, ModelColumn, ModelConstraint, ModelTable, Relation } from "./model.ts";

export type ChangeKind = "added" | "removed" | "changed";

/** How a part of the merged model changed, and, when it changed, what about it did */
export interface Change {
  kind: ChangeKind;
  details: string[];
}

export interface ChangeEntry {
  table: string;
  /** null for a change to the table itself */
  column: string | null;
  kind: ChangeKind;
  details: string[];
}

export interface ModelDiff {
  /** The newer model with the removed parts put back, every changed part marked with `change` */
  model: Model;
  /** Table by table, in the order of the merged model; empty when nothing changed */
  changes: ChangeEntry[];
}

const same = <T>(a: T, b: T): boolean => JSON.stringify(a) === JSON.stringify(b);
const refText = (r: ModelColumn["ref"]): string => (r ? `${r.kind === "physical" ? "->" : "~>"} ${r.table}.${r.column}` : "");
const constraintText = (k: ModelConstraint): string => `${k.kind}${k.name ? ` ${k.name}` : ""} (${k.columns.join(", ")})`;
const relationKey = (r: Relation): string => JSON.stringify([r.child, r.childColumns ?? [r.childColumn], r.parent, r.parentColumns ?? [r.parentColumn]]);

/** What differs between two versions of a column, in words */
function columnDetails(a: ModelColumn, b: ModelColumn): string[] {
  const out: string[] = [];
  if (a.type !== b.type) out.push(`type ${a.type} → ${b.type}`);
  if (a.nullable !== b.nullable) out.push(b.nullable ? "now nullable" : "now NOT NULL");
  if (a.pk !== b.pk) out.push(b.pk ? "now in the primary key" : "no longer in the primary key");
  if (a.uk !== b.uk) out.push(b.uk ? "now unique" : "no longer unique");
  else if (a.ukName !== b.ukName) out.push(`unique name ${a.ukName ?? "unnamed"} → ${b.ukName ?? "unnamed"}`);
  if (a.enc !== b.enc) out.push(b.enc ? "now encrypted" : "no longer encrypted");
  if (!same(a.enumValues, b.enumValues))
    out.push(!a.enumValues ? `values ${b.enumValues!.join(", ")} added` : !b.enumValues ? "values removed" : `values ${a.enumValues.join(", ")} → ${b.enumValues.join(", ")}`);
  if (!same(a.index, b.index)) out.push(!a.index ? "index added" : !b.index ? "index removed" : `index name ${a.index.name ?? "unnamed"} → ${b.index.name ?? "unnamed"}`);
  if (!same(a.ref, b.ref)) out.push(!a.ref ? `reference ${refText(b.ref)} added` : !b.ref ? `reference ${refText(a.ref)} removed` : `reference ${refText(a.ref)} → ${refText(b.ref)}`);
  if (a.description !== b.description) out.push("description changed");
  return out;
}

/** What differs about a table itself, apart from its columns */
function tableDetails(a: ModelTable, b: ModelTable): string[] {
  const out: string[] = [];
  if (a.origin !== b.origin) out.push(b.origin === "external" ? "now external" : "no longer external");
  if (a.description !== b.description) out.push("description changed");
  if (a.service !== b.service)
    out.push(!a.service ? `now in service ${b.service}` : !b.service ? `no longer in service ${a.service}` : `moved from service ${a.service} to ${b.service}`);
  const before = a.constraints.map(constraintText);
  const after = b.constraints.map(constraintText);
  for (const k of after) if (!before.includes(k)) out.push(`${k} added`);
  for (const k of before) if (!after.includes(k)) out.push(`${k} removed`);
  if (!same(a.audit, b.audit)) out.push(!a.audit ? "audit added" : !b.audit ? "audit removed" : "audited columns changed");
  if (!same(a.foreignKeys ?? [], b.foreignKeys ?? [])) out.push("composite references changed");
  return out;
}

/** `items` of `after` with the `before` items that are gone put back after their old predecessor */
function merge<T>(before: T[], after: T[], key: (x: T) => string, gone: (x: T) => T): T[] {
  const out = [...after];
  const kept = new Set(after.map(key));
  let last: string | null = null;
  for (const x of before) {
    if (kept.has(key(x))) {
      last = key(x);
      continue;
    }
    const at = last === null ? 0 : out.findIndex((y) => key(y) === last) + 1;
    out.splice(at, 0, gone(x));
    last = key(x);
  }
  return out;
}

export function diff(before: Model, after: Model): ModelDiff {
  const changes: ChangeEntry[] = [];
  const own = (m: Model) => m.tables.filter((t) => t.origin !== "audit");
  const beforeTables = new Map(own(before).map((t) => [t.name, t]));

  const marked = (kind: ChangeKind, details: string[] = []): Change => ({ kind, details });
  const tables = merge(
    own(before),
    after.tables,
    (t) => t.name,
    (t) => ({ ...t, change: marked("removed") }),
  ).map((t): ModelTable => {
    if (t.origin === "audit" || t.change) return t;
    const old = beforeTables.get(t.name);
    if (!old) return { ...t, change: marked("added") };
    const oldColumns = new Map(old.columns.map((c) => [c.name, c]));
    const columns = merge(
      old.columns,
      t.columns,
      (c) => c.name,
      (c) => ({ ...c, change: marked("removed") }),
    ).map((c): ModelColumn => {
      if (c.change) return c;
      const was = oldColumns.get(c.name);
      if (!was) return { ...c, change: marked("added") };
      const details = columnDetails(was, c);
      return details.length ? { ...c, change: marked("changed", details) } : c;
    });
    const details = tableDetails(old, t);
    const changed = details.length > 0 || columns.some((c) => c.change);
    return changed ? { ...t, columns, change: marked("changed", details) } : t;
  });

  for (const t of tables) {
    if (!t.change) continue;
    changes.push({ table: t.name, column: null, kind: t.change.kind, details: t.change.details });
    if (t.change.kind === "changed")
      for (const c of t.columns) if (c.change) changes.push({ table: t.name, column: c.name, kind: c.change.kind, details: c.change.details });
  }

  // Compare the facts drawn on a connector, including cardinality and the parent's requirement
  const beforeRelations = new Map(before.relations.filter((r) => r.origin === "table").map((r) => [relationKey(r), r]));
  const afterKeys = new Set(after.relations.map(relationKey));
  const relations: Relation[] = after.relations.map((r) => {
    if (r.origin !== "table") return r;
    const old = beforeRelations.get(relationKey(r));
    if (!old) return { ...r, change: marked("added") };
    const details: string[] = [];
    if (old.kind !== r.kind) details.push(`reference kind ${old.kind} → ${r.kind}`);
    if (old.one !== r.one) details.push(`cardinality ${old.one ? "one-to-one" : "one-to-many"} → ${r.one ? "one-to-one" : "one-to-many"}`);
    if (old.optional !== r.optional) details.push(r.optional ? "parent now optional" : "parent now required");
    return details.length ? { ...r, change: marked("changed", details) } : r;
  });
  for (const [key, r] of beforeRelations) if (!afterKeys.has(key) && tables.some((t) => t.name === r.child) && tables.some((t) => t.name === r.parent)) relations.push({ ...r, change: marked("removed") });

  // A removed table may take its service with it: keep the service so the table is drawn where it was
  const services = [
    ...after.services,
    ...before.services.filter((s) => !after.services.some((x) => x.name === s.name) && tables.some((t) => t.service === s.name)),
  ];
  return { model: { tables, relations, services }, changes };
}

/** The changes as Markdown: a line per table, its column changes under it */
export function diffMarkdown(changes: ChangeEntry[]): string {
  if (changes.length === 0) return "No changes to the schema.\n";
  const sign = { added: "+", removed: "-", changed: "~" } as const;
  const lines: string[] = [];
  for (const c of changes) {
    const what = c.details.length ? `: ${c.details.join("; ")}` : "";
    if (c.column === null) lines.push(`- ${sign[c.kind]} table \`${c.table}\` ${c.kind}${what}`);
    else lines.push(`  - ${sign[c.kind]} column \`${c.column}\` ${c.kind}${what}`);
  }
  return `${lines.join("\n")}\n`;
}
