// Model → SQL DDL for one of the five dialects fromSql reads (docs/SPEC.md §12). It is the import run
// backwards, so what it writes imports back to the same document: every fact goes where §8 reads it
// from. What SQL cannot hold (logical references, encryption) is written as an SQL comment, and
// everything written in an unexpected way is listed in the notes.

import { REVINFO } from "./checker.ts";
import { cells } from "./format.ts";
import type { Model, ModelColumn, ModelTable } from "./model.ts";

export type SqlDialect = "mysql" | "postgres" | "sqlite" | "sqlserver" | "oracle";
export const SQL_DIALECTS: readonly SqlDialect[] = ["mysql", "postgres", "sqlite", "sqlserver", "oracle"];
const DIALECT_NAME: Record<SqlDialect, string> = { mysql: "MySQL", postgres: "PostgreSQL", sqlite: "SQLite", sqlserver: "SQL Server", oracle: "Oracle" };

export interface ToSqlOptions {
  dialect: SqlDialect;
  /** Only this service's tables, for its own database. Without it, the whole document, a schema per service */
  service?: string;
}

export interface SqlDdl {
  sql: string;
  /** Everything written in an unexpected way or left out, one line each */
  notes: string[];
}

/** Words that are reserved in at least one of the dialects, and so always quoted */
const RESERVED = new Set(
  (
    "add all alter and any as asc between by case check column comment constraint create cross current database default delete desc distinct " +
    "drop else end exists foreign from full grant group having in index inner insert intersect into is join key left level like limit not null " +
    "number of offset on or order outer primary references right row rows select session set size table then to union unique update user " +
    "using values view when where with"
  ).split(" "),
);

/** PostgreSQL's own types: a column with `enum(...)` and any other type names an enum type to create */
const PG_TYPES = new Set(
  (
    "bigint int8 bigserial serial8 bit varbit boolean bool box bytea char character varchar cidr circle date double float float4 float8 inet " +
    "int int2 int4 integer interval json jsonb line lseg macaddr macaddr8 money name numeric decimal oid path point polygon real smallint " +
    "smallserial serial serial2 serial4 text time timetz timestamp timestamptz tsquery tsvector uuid xml citext"
  ).split(" "),
);

interface Row {
  text: string;
  comment: string | null;
}

export function toSql(model: Model, options: ToSqlOptions): SqlDdl {
  const { dialect, service } = options;
  if (service !== undefined && !model.services.some((s) => s.name === service)) throw new Error(`there is no service \`${service}\``);
  const notes: string[] = [];
  const name = DIALECT_NAME[dialect];
  const tables = new Map(model.tables.map((t) => [t.name, t]));

  // ---- which tables, and what they are called ----

  const owned = (t: ModelTable) => service === undefined || t.service === service;
  const audits = (t: ModelTable) => t.origin === "audit" && t.name !== REVINFO;
  let written = model.tables.filter((t) => t.origin !== "external" && owned(t));
  if (service !== undefined && written.some(audits)) written = model.tables.filter((t) => (t.origin !== "external" && owned(t)) || t.name === REVINFO);
  /** Services become schemas when the whole document goes into one database that has them */
  const schemas = service === undefined && dialect !== "sqlite";

  const [open, close] = dialect === "mysql" ? ["`", "`"] : dialect === "sqlserver" ? ["[", "]"] : ['"', '"'];
  const q = (n: string): string =>
    /^[A-Za-z_][A-Za-z0-9_]*$/.test(n) && !RESERVED.has(n.toLowerCase()) && !(dialect === "postgres" && /[A-Z]/.test(n)) ? n : open + n.split(close).join(close + close) + close;
  const local = (t: ModelTable) => t.label ?? t.name;
  /** The schema a table goes in: its service's, or on SQL Server dbo, which its descriptions name */
  const schemaOf = (t: ModelTable): string | null => (schemas && t.service ? t.service : dialect === "sqlserver" ? "dbo" : null);
  /** The table as the SQL names it */
  const sqlName = (t: ModelTable) => {
    const schema = schemaOf(t);
    return schema ? `${q(schema)}.${q(local(t))}` : q(local(t));
  };
  /** The table as comments and notes name it: with its service when that is not where the reader is */
  const shown = (t: ModelTable) => (t.service && (schemas || (service !== undefined && t.service !== service)) ? `${t.service}.${local(t)}` : local(t));
  /** A target this database cannot hold a FOREIGN KEY to: a table of another service, in a service's DDL */
  const elsewhere = (t: ModelTable) => service !== undefined && t.service !== service;
  const away = (t: ModelTable) => (t.service ? "in another service" : "outside every service");
  const str = (s: string) => `${dialect === "sqlserver" ? "N" : ""}'${s.split("'").join("''")}'`;
  const value = (v: string) => (/^-?\d+(\.\d+)?$/.test(v) ? v : `'${v.split("'").join("''")}'`);
  const list = (names: string[]) => names.map(q).join(", ");

  if (service === undefined && dialect === "sqlite" && written.some((t) => t.service)) {
    notes.push("SQLite has no schemas: the tables of services are written without one");
    const seen = new Set<string>();
    for (const t of written)
      if (seen.has(local(t))) notes.push(`two tables are named ${local(t)}; write each service on its own with \`service\``);
      else seen.add(local(t));
  }
  const services = model.services.filter((s) => schemas && written.some((t) => t.service === s.name)).map((s) => s.name);
  if (services.length && dialect === "oracle")
    notes.push(`services are written as schemas, which Oracle makes as users: CREATE SCHEMA is left out, so create the users ${words(services)} first`);

  // ---- types: enum types, and the one type name SQL spells in two words ----

  const enumTypes = new Map<string, string[]>();
  const baseType = (c: ModelColumn) => c.type.replace(/\(.*$/, "").toLowerCase();
  /** The column's type in SQL, and whether its values still need a check */
  const typeOf = (t: ModelTable, c: ModelColumn): { type: string; check: boolean } => {
    const values = c.enumValues;
    if (dialect === "mysql" && values && baseType(c) === "enum") return { type: `enum(${values.map(value).join(", ")})`, check: false };
    if (dialect === "postgres" && values && !PG_TYPES.has(baseType(c))) {
      if (!enumTypes.has(c.type)) enumTypes.set(c.type, values);
      else if (enumTypes.get(c.type)!.join() !== values.join()) notes.push(`${shown(t)}.${c.name}: the enum type ${c.type} was created with other values`);
      return { type: c.type, check: false };
    }
    if (baseType(c) === "enum") {
      notes.push(`${shown(t)}.${c.name}: ${name} has no type enum, so it is written varchar(255)`);
      return { type: "varchar(255)", check: values !== null };
    }
    if ((dialect === "postgres" || dialect === "oracle") && baseType(c) === "double") return { type: c.type.replace(/^double/i, "double precision"), check: values !== null };
    return { type: c.type, check: values !== null };
  };

  // ---- each table ----

  // Names already given are taken before any is made up
  const usedIndexNames = new Set(written.flatMap((t) => [...t.columns.flatMap((c) => c.index?.name ?? []), ...t.constraints.flatMap((k) => (k.kind === "index" && k.name ? [k.name] : []))]));
  const madeUpName = (t: ModelTable, columns: string[]): string => {
    const base = `ix_${local(t)}_${columns.join("_")}`.replace(/\W/g, "_");
    let made = base;
    for (let k = 2; usedIndexNames.has(made); k++) made = `${base}_${k}`;
    usedIndexNames.add(made);
    notes.push(`the index on ${shown(t)} (${columns.join(", ")}) has no name, which ${name} needs: named ${made}`);
    return made;
  };
  const foreignKeys: string[] = [];
  const blocks: string[] = [];

  for (const t of written) {
    const lines: string[] = [];
    if (dialect === "sqlite" && t.description) lines.push(`-- ${oneLine(t.description)}`);

    // columns, lined up as in resin
    const columns = t.columns.map((c) => {
      const { type, check } = typeOf(t, c);
      const rest: string[] = [];
      if (!c.nullable) rest.push("NOT NULL");
      if (check && c.enumValues) rest.push(`CHECK (${q(c.name)} IN (${c.enumValues.map(value).join(", ")}))`);
      if (dialect === "mysql" && c.description) rest.push(`COMMENT ${str(oneLine(c.description))}`);
      const comment: string[] = [];
      if (c.enc) comment.push("encrypted");
      const target = c.ref ? tables.get(c.ref.table) : undefined;
      if (c.ref && target) {
        if (c.ref.kind === "logical") comment.push(`~> ${shown(target)}.${c.ref.column}`);
        else if (elsewhere(target)) {
          comment.push(`-> ${shown(target)}.${c.ref.column}, ${away(target)}: no FOREIGN KEY`);
          notes.push(`${shown(t)}.${c.name} -> ${shown(target)}.${c.ref.column}: ${away(target)}, so no FOREIGN KEY`);
        }
      }
      if (dialect === "sqlite" && c.description) comment.push(oneLine(c.description));
      return { name: q(c.name), type, rest: rest.join(" "), comment: comment.length ? comment.join("; ") : null };
    });
    const nameWidth = Math.max(0, ...columns.map((c) => cells(c.name)));
    const typeWidth = Math.max(0, ...columns.map((c) => cells(c.type)));
    const pad = (s: string, width: number) => s + " ".repeat(Math.max(0, width - cells(s)));
    const rows: Row[] = columns.map((c) => ({ text: `${pad(c.name, nameWidth)}  ${pad(c.type, typeWidth)}  ${c.rest}`.trimEnd(), comment: c.comment }));

    const pk = t.columns.filter((c) => c.pk).map((c) => c.name);
    if (pk.length) rows.push({ text: `PRIMARY KEY (${list(pk)})`, comment: null });
    const named = (n: string | null) => (n ? `CONSTRAINT ${q(n)} ` : "");
    for (const c of t.columns) if (c.uk) rows.push({ text: `${named(c.ukName)}UNIQUE (${q(c.name)})`, comment: null });
    for (const k of t.constraints) if (k.kind === "unique") rows.push({ text: `${named(k.name)}UNIQUE (${list(k.columns)})`, comment: null });

    // indexes: in the table on MySQL, after it elsewhere
    const indexes = [
      ...t.columns.filter((c) => c.index).map((c) => ({ name: c.index!.name, columns: [c.name] })),
      ...t.constraints.filter((k) => k.kind === "index").map((k) => ({ name: k.name, columns: k.columns })),
    ];
    const after: string[] = [];
    for (const ix of indexes) {
      if (dialect === "mysql") rows.push({ text: `INDEX ${ix.name ? `${q(ix.name)} ` : ""}(${list(ix.columns)})`, comment: null });
      else if (!ix.name && dialect === "postgres") after.push(`CREATE INDEX ON ${sqlName(t)} (${list(ix.columns)});`);
      else after.push(`CREATE INDEX ${q(ix.name ?? madeUpName(t, ix.columns))} ON ${sqlName(t)} (${list(ix.columns)});`);
    }

    // foreign keys: in the table on SQLite, at the end elsewhere; logical ones as comments
    const trailing: string[] = [];
    const keys = [
      ...t.columns.flatMap((c) => (c.ref && c.ref.kind === "physical" ? [{ name: null, columns: [c.name], target: c.ref.table, targetColumns: [c.ref.column] }] : [])),
      ...(t.foreignKeys ?? []).filter((fk) => fk.kind === "physical"),
    ];
    for (const fk of keys) {
      const target = tables.get(fk.target)!;
      if (elsewhere(target)) {
        if (fk.columns.length > 1) {
          trailing.push(`-- (${fk.columns.join(", ")}) -> ${shown(target)} (${fk.targetColumns.join(", ")}), ${away(target)}: no FOREIGN KEY`);
          notes.push(`${shown(t)} (${fk.columns.join(", ")}) -> ${shown(target)}: ${away(target)}, so no FOREIGN KEY`);
        }
        continue;
      }
      const clause = `${named(fk.name)}FOREIGN KEY (${list(fk.columns)}) REFERENCES ${sqlName(target)} (${list(fk.targetColumns)})`;
      if (dialect === "sqlite") rows.push({ text: clause, comment: null });
      else foreignKeys.push(`ALTER TABLE ${sqlName(t)} ADD ${clause};`);
    }
    for (const fk of t.foreignKeys ?? [])
      if (fk.kind === "logical") trailing.push(`-- (${fk.columns.join(", ")}) ~> ${shown(tables.get(fk.target)!)} (${fk.targetColumns.join(", ")})`);

    lines.push(`CREATE TABLE ${sqlName(t)} (`);
    rows.forEach((r, i) => lines.push(`  ${r.text}${i < rows.length - 1 ? "," : ""}${r.comment ? `  -- ${r.comment}` : ""}`));
    for (const c of trailing) lines.push(`  ${c}`);
    lines.push(`)${dialect === "mysql" && t.description ? ` COMMENT = ${str(oneLine(t.description))}` : ""};`);
    lines.push(...after);

    // descriptions, where the dialect keeps them apart from the table
    if (dialect === "postgres" || dialect === "oracle") {
      if (t.description) lines.push(`COMMENT ON TABLE ${sqlName(t)} IS ${str(oneLine(t.description))};`);
      for (const c of t.columns) if (c.description) lines.push(`COMMENT ON COLUMN ${sqlName(t)}.${q(c.name)} IS ${str(oneLine(c.description))};`);
    } else if (dialect === "sqlserver") {
      const level = `@level0type = N'SCHEMA', @level0name = ${str(schemaOf(t)!)}, @level1type = N'TABLE', @level1name = ${str(local(t))}`;
      const property = (text: string, more = "") => `EXEC sp_addextendedproperty @name = N'MS_Description', @value = ${str(oneLine(text))}, ${level}${more};`;
      if (t.description) lines.push(property(t.description));
      for (const c of t.columns) if (c.description) lines.push(property(c.description, `, @level2type = N'COLUMN', @level2name = ${str(c.name)}`));
    }
    blocks.push(lines.join("\n"));
  }

  const head = `-- Generated by resin for ${name}${service !== undefined ? `, service ${service}` : ""}`;
  const out = [head];
  if (services.length && dialect !== "oracle") out.push(services.map((s) => `CREATE SCHEMA ${q(s)};`).join("\n"));
  if (enumTypes.size) out.push([...enumTypes].map(([type, values]) => `CREATE TYPE ${type} AS ENUM (${values.map((v) => `'${v.split("'").join("''")}'`).join(", ")});`).join("\n"));
  out.push(...blocks);
  if (foreignKeys.length) out.push(foreignKeys.join("\n"));
  return { sql: out.join("\n\n") + "\n", notes };
}

/** a, b and c */
const words = (items: string[]): string => (items.length < 2 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`);

/** A description on one line, as SQL comments and strings take it */
const oneLine = (s: string): string => s.replace(/\s*\n\s*/g, " ");
