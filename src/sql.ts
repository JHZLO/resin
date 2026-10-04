// SQL DDL → resin source. Behind `fromSql`, the playground's paste and `resin --from-sql`.
//
// Three steps. sql-lexer.ts tokenizes every dialect at once and splits statements; sql-parser.ts
// reads each statement into facts on its own, so one it cannot read costs only itself. This file
// resolves the facts in two passes and writes resin:
//
//   1. tables, in order: CREATE TABLE (with its own constraints), DROP TABLE, enum types
//   2. what is said about them, in order: ALTER TABLE, CREATE INDEX, COMMENT ON
//
// Dumps put constraints and indexes after every table (pg_dump) or before the table they point at
// (FKs in MySQL), so references are resolved only once both passes are done. Tables from two or more
// schemas are written in a group per schema. The mapping rules are
// listed in docs/SPEC.md §8.
//
// Nothing is dropped silently that a diagram would show: a composite foreign key or an expression
// index stays in the output as a `%%` comment inside its table, and is reported in `notes`. What a
// diagram never shows (DEFAULT, CHECK other than a value list, ON DELETE, storage options, views,
// data) is left out; views, triggers, functions and procedures are counted in a comment on top.

import { AUDIT_SKIP } from "./checker.ts";
import { tokenize } from "./sql-lexer.ts";
import { type SqlColumn, type SqlConstraint, type SqlName, type SqlTable, type SqlType, columnsOf, objectName, parseStatement, schemaName } from "./sql-parser.ts";

export interface SqlNote {
  message: string;
  /** Position in the SQL */
  line: number;
  col: number;
}

export interface SqlImport {
  /** resin source; empty when the SQL defines no table */
  source: string;
  /** What did not convert, or converted with a caveat, in SQL order */
  notes: SqlNote[];
  /** Tables converted, not counting the external tables added for references */
  tables: number;
}

export interface SqlImportOptions {
  /** Tables of the document the result goes into: references to them need no external table */
  known?: readonly string[];
  /** Also read `<table>_id` columns that have no foreign key as logical references (`~>`) */
  inferReferences?: boolean;
}

interface At {
  line: number;
  col: number;
}

interface Col {
  name: string;
  type: SqlType;
  notNull: boolean;
  pk: boolean;
  uk: { name: string | null } | null;
  index: { name: string | null } | null;
  ref: { table: SqlName; column: string | null; kind: "physical" | "logical"; at: At } | null;
  values: string[] | null;
  comment: string | null;
}

interface Tbl {
  name: SqlName;
  /** The name written in resin */
  display: string;
  /** Lowercase object name and schema, for lookups: SQL names are case-insensitive unless quoted, and dumps mix both */
  key: string;
  schema: string | null;
  cols: Col[];
  uniques: { name: string | null; columns: Col[] }[];
  indexes: { name: string | null; columns: Col[] }[];
  comment: string | null;
  /** Written as `%%` comments at the end of the table */
  losses: string[];
  audit: { columns: string[] | null } | null;
  dropped: boolean;
}

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
const lower = (s: string): string => s.toLowerCase();

/** A resin name: bare when it can be, in backticks otherwise */
export const resinName = (s: string): string => (IDENT.test(s) ? s : `\`${s.replace(/[`\r\n]/g, "_") || "_"}\``);
const resinString = (s: string): string => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
const oneLine = (s: string | null): string => (s ?? "").replace(/\s+/g, " ").trim();
const typeText = (t: SqlType): string => (t.args ? `${t.name}(${t.args.join(",")})` : t.name);
const sameSet = (a: readonly Col[], b: readonly Col[]): boolean => a.length === b.length && a.every((c) => b.includes(c));
const plural = (word: string, n: number): string => (n === 1 ? word : `${word}s`);

/** Is this text SQL that defines a table? The playground converts a paste when it is */
export function looksLikeSql(text: string): boolean {
  return /\bcreate\s+(?:[a-z_]+\s+){0,4}table\b[^;{]{0,400}?\(/i.test(text);
}

export function fromSql(sql: string, options: SqlImportOptions = {}): SqlImport {
  const { text, statements } = tokenize(sql);
  const parsed = statements.map((tokens) => ({ st: parseStatement(tokens, text), at: { line: tokens[0].line, col: tokens[0].col } }));
  const notes: SqlNote[] = [];
  const note = (message: string, at: At) => notes.push({ message, line: at.line, col: at.col });

  const tables: Tbl[] = [];
  const enums = new Map<string, string[]>();
  const skipped = new Map<string, number>();
  const skippedNames = new Set<string>();

  const find = (name: SqlName): Tbl | null => {
    const key = lower(objectName(name));
    const schema = schemaName(name);
    const live = tables.filter((t) => !t.dropped && t.key === key);
    return (schema !== null && live.find((t) => t.schema === lower(schema))) || live[0] || null;
  };
  const colOf = (t: Tbl, name: string): Col | null => t.cols.find((c) => lower(c.name) === lower(name)) ?? null;
  const loss = (t: Tbl, message: string, at: At) => {
    t.losses.push(message);
    note(`table \`${objectName(t.name)}\`: ${message[0].toLowerCase()}${message.slice(1)}`, at);
  };

  const column = (c: SqlColumn): Col => ({
    name: c.name,
    type: c.type,
    notNull: c.notNull || c.pk,
    pk: c.pk,
    uk: c.unique ? { name: c.unique.name } : null,
    index: null,
    ref: c.ref ? { table: c.ref.table, column: c.ref.columns?.[0] ?? null, kind: "physical", at: { line: c.line, col: c.col } } : null,
    values: c.type.values ?? c.checkValues,
    comment: c.comment,
  });

  const columns = (t: Tbl, names: string[], what: string, at: At): Col[] | null => {
    const out: Col[] = [];
    for (const name of names) {
      const c = colOf(t, name);
      if (!c) {
        note(`table \`${objectName(t.name)}\`: ${what} names \`${name}\`, which the table does not have`, at);
        return null;
      }
      out.push(c);
    }
    return out;
  };

  const constrain = (t: Tbl, k: SqlConstraint, at: At): void => {
    switch (k.kind) {
      case "pk":
        for (const c of columns(t, k.columns, "the primary key", at) ?? []) {
          c.pk = true;
          c.notNull = true;
        }
        return;
      case "check": {
        const c = colOf(t, k.column);
        if (c && !c.values) c.values = k.values;
        return;
      }
      case "fk": {
        if (k.columns.length !== 1 || (k.ref.columns && k.ref.columns.length !== 1)) {
          const target = k.ref.columns ? ` (${k.ref.columns.join(", ")})` : "";
          loss(t, `Not converted: composite foreign key (${k.columns.join(", ")}) -> ${objectName(k.ref.table)}${target}`, at);
          return;
        }
        const [c] = columns(t, k.columns, "a foreign key", at) ?? [];
        if (c && !c.ref) c.ref = { table: k.ref.table, column: k.ref.columns?.[0] ?? null, kind: "physical", at };
        return;
      }
      case "index": {
        const label = `${k.unique ? "unique index" : "index"}${k.name ? ` ${k.name}` : ""}`;
        const list = k.items.map((i) => ("column" in i ? i.column : i.expression)).join(", ");
        if (k.items.some((i) => "expression" in i)) {
          loss(t, `Not converted: ${label} on (${list})`, at);
          return;
        }
        const cs = columns(t, columnsOf(k.items), `${label}`, at);
        if (!cs || cs.length === 0) return;
        if (k.unique && k.where) {
          // Unique only among some rows: drawing it as unique would claim a one-to-one relation
          loss(t, `Partial ${label} on (${list}) ${k.where}, drawn as a plain index`, at);
          t.indexes.push({ name: k.name, columns: cs });
        } else (k.unique ? t.uniques : t.indexes).push({ name: k.name, columns: cs });
      }
    }
  };

  const table = (s: SqlTable): Tbl => {
    const t: Tbl = {
      name: s.name,
      display: objectName(s.name),
      key: lower(objectName(s.name)),
      schema: schemaName(s.name) === null ? null : lower(schemaName(s.name)!),
      cols: [],
      uniques: [],
      indexes: [],
      comment: s.comment,
      losses: [],
      audit: null,
      dropped: false,
    };
    for (const c of s.columns) {
      if (colOf(t, c.name)) note(`table \`${objectName(s.name)}\`: column \`${c.name}\` appears twice; the first is kept`, c);
      else t.cols.push(column(c));
    }
    for (const k of s.constraints) constrain(t, k.constraint, k);
    for (const u of s.unreadable) loss(t, `Not converted: ${u.text}`, u);
    return t;
  };

  // ---- pass 1: the tables ----
  const known = new Map((options.known ?? []).map((k) => [lower(k), k]));
  for (const { st, at } of parsed) {
    if (st.kind === "table") {
      const existing = find(st.table.name);
      const schema = schemaName(st.table.name);
      if (existing && existing.schema === (schema === null ? null : lower(schema))) {
        note(`table \`${objectName(st.table.name)}\` is created twice; the first is kept`, at);
        continue;
      }
      if (known.has(lower(objectName(st.table.name)))) note(`table \`${objectName(st.table.name)}\` is already in the document`, at);
      tables.push(table(st.table));
    } else if (st.kind === "drop") {
      for (const n of st.names) {
        const t = find(n);
        if (t) t.dropped = true;
      }
    } else if (st.kind === "skip" && st.object) {
      skipped.set(st.object, (skipped.get(st.object) ?? 0) + 1);
      if (st.name) {
        skippedNames.add(lower(st.name));
        // mysqldump stands a placeholder table in for each view until the view itself is created
        if (st.object === "view") {
          const t = find({ parts: [st.name], ...at });
          if (t) t.dropped = true;
        }
      }
      note(`skipped ${st.object}${st.name ? ` \`${st.name}\`` : ""}: resin draws tables`, at);
    } else if (st.kind === "enum") enums.set(lower(objectName(st.name)), [...st.values]);
    else if (st.kind === "enum-value") enums.get(lower(objectName(st.name)))?.push(st.value);
    else if (st.kind === "unreadable") note(st.what, at);
  }

  // ---- pass 2: what is said about them ----
  const missing = (name: SqlName, what: string, at: At) => {
    if (!skippedNames.has(lower(objectName(name)))) note(`${what} skipped: there is no table \`${objectName(name)}\``, at);
  };
  for (const { st, at } of parsed) {
    if (st.kind === "alter") {
      const t = find(st.table);
      if (!t) {
        if (st.actions.length) missing(st.table, "ALTER TABLE", at);
        continue;
      }
      for (const a of st.actions) {
        if (a.kind === "constraint") constrain(t, a.constraint, a);
        else if (a.kind === "null") {
          const c = colOf(t, a.column);
          if (c) c.notNull = a.notNull || c.pk;
        } else {
          const next = column(a.column);
          const old = colOf(t, a.column.name);
          if (!old) t.cols.push(next);
          // MODIFY redefines the column; the keys declared elsewhere stay
          else Object.assign(old, { type: next.type, notNull: next.notNull || old.pk, values: next.values ?? old.values, comment: next.comment ?? old.comment, ref: old.ref ?? next.ref });
        }
      }
    } else if (st.kind === "index") {
      const t = find(st.table);
      if (t) constrain(t, st.index, at);
      else missing(st.table, `index${st.index.name ? ` \`${st.index.name}\`` : ""}`, at);
    } else if (st.kind === "comment") {
      const tableName = st.on === "table" ? st.name : { ...st.name, parts: st.name.parts.slice(0, -1) };
      const t = tableName.parts.length ? find(tableName) : null;
      if (!t) {
        if (tableName.parts.length) missing(tableName, "COMMENT ON", at);
        continue;
      }
      if (st.on === "table") t.comment = st.text;
      else {
        const c = colOf(t, objectName(st.name));
        if (c) c.comment = st.text;
      }
    }
  }

  const live = tables.filter((t) => !t.dropped);

  // Enum types: a column of type `order_status` takes the values of `CREATE TYPE order_status AS ENUM`
  for (const t of live)
    for (const c of t.cols) {
      const values = enums.get(c.type.name);
      if (!c.values && values) c.values = values;
    }

  // Hibernate Envers: revinfo and <table>_aud are what `audit envers` generates, so they become that line
  const revinfo = live.find((t) => t.key === "revinfo");
  const audits: Tbl[] = [];
  if (revinfo) {
    for (const aud of live) {
      if (!aud.key.endsWith("_aud")) continue;
      const base = live.find((t) => t.key === aud.key.slice(0, -4) && t.schema === aud.schema);
      const has = (n: string) => aud.cols.some((c) => lower(c.name) === n);
      if (!base || base.audit || !has("rev") || !has("revtype") || !base.cols.some((c) => c.pk)) continue;
      const kept = new Set(aud.cols.map((c) => lower(c.name)));
      const audited = base.cols.filter((c) => !c.pk && kept.has(lower(c.name)));
      const all = base.cols.filter((c) => !c.pk && !AUDIT_SKIP.has(c.name));
      base.audit = { columns: sameSet(audited, all) ? null : audited.map((c) => c.name) };
      audits.push(aud);
    }
    if (audits.length) audits.push(revinfo);
  }
  const drawn = live.filter((t) => !audits.includes(t));

  // Two tables of one name in different schemas keep their schema in the name
  for (const t of drawn)
    if (t.schema !== null && drawn.some((o) => o !== t && o.key === t.key)) t.display = `${schemaName(t.name)}.${objectName(t.name)}`;

  // ---- references ----
  const stubs = new Map<string, { name: string; columns: { name: string; type: SqlType }[] }>();
  const refs = new Map<Col, () => string>();
  for (const t of drawn)
    for (const c of t.cols) {
      const ref = c.ref;
      if (!ref) continue;
      const target = find(ref.table);
      if (target && audits.includes(target)) {
        loss(t, `Not converted: reference ${c.name} -> ${objectName(ref.table)}, a table that \`audit envers\` generates`, ref.at);
        c.ref = null;
      } else if (target) {
        const pks = target.cols.filter((x) => x.pk);
        const to = ref.column ? colOf(target, ref.column) : pks.length === 1 ? pks[0] : null;
        if (!to) {
          const why = ref.column ? `${target.display} has no column ${ref.column}` : `the primary key of ${target.display} is not one column`;
          loss(t, `Not converted: reference ${c.name} -> ${ref.column ? `${target.display}.${ref.column}` : target.display}, ${why}`, ref.at);
          c.ref = null;
          continue;
        }
        // Pointing at the primary key needs no column name
        const text = pks.length === 1 && pks[0] === to ? resinName(target.display) : `${resinName(target.display)}.${resinName(to.name)}`;
        refs.set(c, () => text);
      } else if (known.has(lower(objectName(ref.table)))) {
        const text = `${resinName(known.get(lower(objectName(ref.table)))!)}${ref.column ? `.${resinName(ref.column)}` : ""}`;
        refs.set(c, () => text);
      } else {
        // A table outside the SQL: declare what is known of it, the columns pointed at
        const key = lower(objectName(ref.table));
        const stub = stubs.get(key) ?? { name: objectName(ref.table), columns: [] };
        stubs.set(key, stub);
        const name = ref.column ?? "id";
        if (!ref.column) note(`table \`${stub.name}\` is not in the SQL; its primary key is taken to be \`id\``, ref.at);
        if (!stub.columns.some((x) => lower(x.name) === lower(name))) stub.columns.push({ name, type: c.type });
        // Only a lone column is taken for the primary key, and then the reference needs no column name
        refs.set(c, () => (stub.columns.length === 1 ? resinName(stub.name) : `${resinName(stub.name)}.${resinName(name)}`));
      }
    }

  // Logical references by name, when asked for: user_id → users, buyer_user_id → users, categoryId → categories
  let inferred = 0;
  if (options.inferReferences)
    for (const t of drawn)
      for (const c of t.cols) {
        if (c.ref) continue;
        const target = guessTarget(c.name, drawn);
        const pks = target?.cols.filter((x) => x.pk) ?? [];
        if (!target || pks.length !== 1 || pks[0] === c || pks[0].type.name !== c.type.name) continue;
        c.ref = { table: target.name, column: null, kind: "logical", at: { line: 0, col: 0 } };
        const text = resinName(target.display);
        refs.set(c, () => text);
        inferred++;
      }

  // ---- write ----
  const out: string[] = [];
  if (skipped.size) out.push(`%% Skipped: ${[...skipped].map(([object, n]) => `${n} ${plural(object, n)}`).join(", ")}`);
  if (inferred) out.push("%% References written ~> were inferred from column names");
  if (out.length) out.push("");
  for (const stub of stubs.values()) {
    const pk = stub.columns.length === 1;
    out.push(`external table ${resinName(stub.name)} {`, ...align(stub.columns.map((x) => [resinName(x.name), typeText(x.type), pk ? "pk" : ""])), "}", "");
  }
  // Tables from two or more schemas: each schema's tables in a group of its name, where it first appears
  const schemas = new Set(drawn.flatMap((t) => (t.schema === null ? [] : [t.schema])));
  const grouped = schemas.size >= 2;
  const written = new Set<string>();
  for (const t of drawn) {
    if (!grouped || t.schema === null) out.push(...writeTable(t, refs), "");
    else if (!written.has(t.schema)) {
      written.add(t.schema);
      const members = drawn.filter((x) => x.schema === t.schema);
      const body = members.flatMap((x, k) => [...(k ? [""] : []), ...writeTable(x, refs)]).map((l) => (l ? `  ${l}` : l));
      out.push(`group ${resinName(schemaName(t.name)!)} {`, ...body, "}", "");
    }
  }
  notes.sort((a, b) => a.line - b.line || a.col - b.col);
  return { source: drawn.length ? `${out.join("\n").trimEnd()}\n` : "", notes, tables: drawn.length };
}

function writeTable(t: Tbl, refs: Map<Col, () => string>): string[] {
  const pks = t.cols.filter((c) => c.pk);
  // A name used twice in one table is an error in resin; SQL scopes some names wider, so keep the first
  const used = new Set<string>();
  const claim = (n: string | null): string | null => {
    if (n === null || used.has(n)) return null;
    used.add(n);
    return n;
  };
  for (const c of t.cols) {
    // UNIQUE on the only primary key column says nothing more
    if (c.uk && c.pk && pks.length === 1) c.uk = null;
    if (c.uk) c.uk.name = claim(c.uk.name);
  }

  const uniques: { name: string | null; columns: Col[] }[] = [];
  for (const u of t.uniques) {
    if (u.columns.length === 1) {
      const [c] = u.columns;
      if (c.pk && pks.length === 1) continue;
      if (!c.uk) c.uk = { name: claim(u.name) };
      else if (!c.uk.name) c.uk.name = claim(u.name);
    } else if (!sameSet(u.columns, pks) && !uniques.some((x) => sameSet(x.columns, u.columns))) uniques.push({ name: claim(u.name), columns: u.columns });
  }
  const indexes: { name: string | null; columns: Col[] }[] = [];
  for (const ix of t.indexes) {
    if (ix.columns.length === 1) {
      const [c] = ix.columns;
      // A second index on the same column adds nothing the drawing shows
      if (!c.index) c.index = { name: claim(ix.name) };
    } else if (!indexes.some((x) => x.columns.length === ix.columns.length && x.columns.every((c, k) => c === ix.columns[k])))
      indexes.push({ name: claim(ix.name), columns: ix.columns });
  }

  const rows = t.cols.map((c) => {
    const mods: string[] = [];
    if (c.pk) mods.push("pk");
    if (c.uk) mods.push(c.uk.name ? `uk as ${resinName(c.uk.name)}` : "uk");
    const ref = refs.get(c);
    if (ref && c.ref) mods.push(`${c.ref.kind === "physical" ? "->" : "~>"} ${ref()}`);
    const values = enumValues(c.values);
    if (values) mods.push(`enum(${values})`);
    if (c.index) mods.push(c.index.name ? `index as ${resinName(c.index.name)}` : "index");
    const comment = oneLine(c.comment);
    if (comment) mods.push(resinString(comment));
    return [resinName(c.name), `${typeText(c.type)}${c.notNull ? "" : "?"}`, mods.join("  ")];
  });

  const list = (cs: Col[]) => cs.map((c) => resinName(c.name)).join(", ");
  const as = (n: string | null) => (n ? ` as ${resinName(n)}` : "");
  const comment = oneLine(t.comment);
  const audit = t.audit ? ` audit envers${t.audit.columns ? `(${t.audit.columns.map(resinName).join(", ")})` : ""}` : "";
  return [
    `table ${resinName(t.display)}${comment ? ` ${resinString(comment)}` : ""} {`,
    ...align(rows),
    ...uniques.map((u) => `  unique(${list(u.columns)})${as(u.name)}`),
    ...indexes.map((ix) => `  index(${list(ix.columns)})${as(ix.name)}`),
    ...t.losses.map((l) => `  %% ${oneLine(l)}`),
    `}${audit}`,
  ];
}

/** Columns as the examples write them: names, types and modifiers each lined up. A wide character
 *  (Hangul, CJK) takes two cells of a monospace editor */
function align(rows: string[][]): string[] {
  const cells = (s: string) => s.length + (s.match(/[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFF60\uFFE0-\uFFE6]/g)?.length ?? 0);
  const pad = (s: string, width: number) => s + " ".repeat(Math.max(0, width - cells(s)));
  const name = Math.max(0, ...rows.map((r) => cells(r[0])));
  const type = Math.max(0, ...rows.map((r) => cells(r[1])));
  return rows.map(([n, t, mods]) => `  ${pad(n, name)}  ${pad(t, type)}  ${mods}`.trimEnd());
}

/** Values resin can write: names and numbers bare, anything else in backticks. null when none are left */
function enumValues(values: string[] | null): string | null {
  if (!values) return null;
  const out: string[] = [];
  for (const v of values) {
    const text = IDENT.test(v) || /^\d+$/.test(v) ? v : v !== "" && !/[`\r\n]/.test(v) ? `\`${v}\`` : null;
    if (text && !out.includes(text)) out.push(text);
  }
  return out.length ? out.join(", ") : null;
}

/** The table a `..._id` column is named after, as tbls and Azimutt read names: the words before `id`
 *  are the table's name in the singular, possibly after a word or two of role (`buyer_user_id`) */
function guessTarget(column: string, tables: readonly Tbl[]): Tbl | null {
  const words = column
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .split(/_+/)
    .filter(Boolean);
  if (words.length < 2 || words[words.length - 1] !== "id") return null;
  const stem = words.slice(0, -1);
  for (let k = 0; k < stem.length && k <= 3; k++) {
    const wanted = stem.slice(k).join("_");
    const found = tables.find((t) => t.key === wanted || t.key === `${wanted}s` || singular(t.key) === wanted);
    if (found) return found;
  }
  return null;
}

/** The last word of a table name in the singular: categories → category, addresses → address */
function singular(name: string): string {
  if (/ies$/.test(name)) return name.replace(/ies$/, "y");
  if (/(s|x|z|ch|sh)es$/.test(name)) return name.replace(/es$/, "");
  if (/[^s]s$/.test(name)) return name.slice(0, -1);
  return name;
}
