// Semantic checks on the syntax tree: things that parse but do not make sense — a reference to a
// table that does not exist, a name used twice, a nullable primary key. The rules are in docs/SPEC.md §4.
//
// The model (model.ts) assumes it only ever sees trees that passed these checks without errors.
// resolveRef is exported because the model resolves references with exactly the same rule.

import type { Column, Document, Ident, Table } from "./ast.ts";
import { type Diagnostic, error, warning } from "./diagnostics.ts";

export const AUDIT_SUFFIX = "_aud";
export const REVINFO = "revinfo";
/** Audit methods that exist today */
export const AUDIT_METHODS = ["envers"] as const;
/** Columns a bare `audit envers` leaves out: there is no point in versioning timestamps */
export const AUDIT_SKIP = new Set(["created_at", "updated_at"]);

/** The column a reference points at, or null when it cannot be resolved (the checker has reported it) */
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

/** Columns that `audit` copies into the audit table (primary key excluded). Empty without audit */
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
    if (tables.has(t.name.text)) out.push(error(`table \`${t.name.text}\` is declared twice`, t.name.span));
    else tables.set(t.name.text, t);
  }

  const audited = doc.tables.filter((t) => t.audit && !t.external);
  if (audited.length > 0) {
    const generated = new Set([REVINFO, ...audited.map((t) => t.name.text + AUDIT_SUFFIX)]);
    for (const t of doc.tables)
      if (generated.has(t.name.text))
        out.push(
          error(
            `\`${t.name.text}\` clashes with a table that \`audit\` generates`,
            t.name.span,
            "remove it and let `audit` generate it, or rename this table",
          ),
        );
  }

  // Services: names of their own, unique among services; a service with no table draws nothing
  const services = new Set<string>();
  for (const s of doc.services) {
    if (services.has(s.name.text)) out.push(error(`service \`${s.name.text}\` is declared twice`, s.name.span));
    else services.add(s.name.text);
    if (!doc.tables.some((t) => t.service?.text === s.name.text))
      out.push(warning(`service \`${s.name.text}\` has no tables`, s.name.span, "put tables inside it, or remove it"));
  }

  for (const t of doc.tables) checkTable(doc, t, out);
  return out;
}

function checkTable(doc: Document, t: Table, out: Diagnostic[]): void {
  const cols = new Map<string, Column>();
  for (const c of t.columns) {
    if (cols.has(c.name.text)) out.push(error(`column \`${c.name.text}\` appears twice in table \`${t.name.text}\``, c.name.span));
    else cols.set(c.name.text, c);
  }

  const known = (i: Ident) => {
    if (!cols.has(i.text)) out.push(error(`table \`${t.name.text}\` has no column \`${i.text}\``, i.span));
  };

  for (const c of t.columns) {
    if (c.pk && c.nullable)
      out.push(error(`primary key \`${c.name.text}\` cannot be nullable`, c.type.span, "remove the `?` after the type"));
    if (c.ref && t.external)
      out.push(
        error(
          "columns of an external table cannot hold references",
          c.ref.span,
          "external tables only receive references; declare it as `table` to draw this relation",
        ),
      );
    else if (c.ref) checkRef(doc, t, c, out);
  }

  for (const k of t.constraints) {
    k.columns.forEach(known);
    if (k.columns.length === 1) {
      const modifier = k.kind === "unique" ? "uk" : "index";
      out.push(
        warning(
          `\`${k.kind}(...)\` over a single column`,
          k.span,
          `use the column modifier \`${modifier}\`${k.name ? ` (\`${modifier} as ${k.name.text}\`)` : ""}`,
        ),
      );
    }
  }

  // Index and unique names are only shown, but two constraints with the same name in one table are ambiguous
  const names = new Map<string, Ident>();
  const named = (i: Ident | null) => {
    if (!i) return;
    if (names.has(i.text)) out.push(error(`name \`${i.text}\` is used twice in table \`${t.name.text}\``, i.span));
    else names.set(i.text, i);
  };
  for (const c of t.columns) {
    named(c.uk?.name ?? null);
    named(c.index?.name ?? null);
  }
  for (const k of t.constraints) named(k.name);

  if (t.audit) {
    const a = t.audit;
    if (t.external) out.push(error("`audit` cannot be used on an external table", a.span));
    else if (!(AUDIT_METHODS as readonly string[]).includes(a.method.text))
      out.push(
        error(`unknown audit method \`${a.method.text}\``, a.method.span, `available methods: ${AUDIT_METHODS.map((m) => `\`${m}\``).join(", ")}`),
      );
    else {
      if (!t.columns.some((c) => c.pk))
        out.push(error(`\`audit\` needs a primary key, and table \`${t.name.text}\` has none`, a.span));
      for (const i of a.columns ?? []) {
        known(i);
        if (cols.get(i.text)?.pk)
          out.push(warning(`primary key \`${i.text}\` is always part of the audit table`, i.span, "you can drop it from the list"));
      }
    }
  }
}

function checkRef(doc: Document, t: Table, c: Column, out: Diagnostic[]): void {
  const ref = c.ref!;
  const target = doc.tables.find((t) => t.name.text === ref.table.text);
  if (!target) {
    out.push(
      error(
        `referenced table \`${ref.table.text}\` is not in this document`,
        ref.table.span,
        "declare it with `external table` if it lives outside this document",
      ),
    );
    return;
  }
  if (ref.column && !target.columns.some((x) => x.name.text === ref.column!.text)) {
    out.push(error(`table \`${target.name.text}\` has no column \`${ref.column.text}\``, ref.column.span));
    return;
  }
  if (!ref.column && target.columns.filter((x) => x.pk).length !== 1) {
    out.push(
      error(
        `cannot pick a target column: the primary key of \`${target.name.text}\` is not a single column`,
        ref.table.span,
        `name the column, e.g. \`${target.name.text}.column\``,
      ),
    );
    return;
  }
  const resolved = resolveRef(doc, c);
  // Only the type name is compared: foreign keys often mix lengths (varchar(32) against varchar(64))
  if (resolved && resolved.column.type.name.text !== c.type.name.text)
    out.push(
      warning(
        `type mismatch: \`${c.name.text}\` is ${c.type.name.text} but \`${resolved.table.name.text}.${resolved.column.name.text}\` is ${resolved.column.type.name.text}`,
        c.type.span,
      ),
    );
  // Each service has a database of its own, and a FOREIGN KEY cannot reach into another database
  if (ref.kind === "physical" && t.service && target.service && t.service.text !== target.service.text)
    out.push(
      warning(
        `foreign key \`${t.name.text}.${c.name.text}\` crosses from service \`${t.service.text}\` into \`${target.service.text}\``,
        ref.span,
        "a FOREIGN KEY ties the data of two services together; write `~>` for a logical reference",
      ),
    );
}
