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
// schemas are written in a service per schema. The mapping rules are
// listed in docs/SPEC.md §8.
//
// Composite foreign keys keep their ordered column pairs. Unresolved references and expression
// indexes stay in the output as `%%` comments inside their table, and are reported in `notes`. What a
// diagram never shows (DEFAULT, CHECK other than a value list, ON DELETE, storage options, views,
// data) is left out; views, triggers, functions and procedures are counted in a comment on top.

import { AUDIT_SKIP } from "./checker.ts";
import { tokenize } from "./sql-lexer.ts";
import { type SqlColumn, type SqlConstraint, type SqlName, type SqlRef, type SqlTable, type SqlType, columnsOf, keysOf, objectKey, objectName, parseStatement, schemaKey, schemaName } from "./sql-parser.ts";
import { cells } from "./format.ts";

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
  key: string;
  display: string;
  at: At;
  type: SqlType;
  notNull: boolean;
  pk: boolean;
  uk: { name: string | null } | null;
  index: { name: string | null } | null;
  ref: { table: SqlName; column: string | null; key: string | null; kind: "physical" | "logical"; at: At } | null;
  values: string[] | null;
  comment: string | null;
}

interface Tbl {
  name: SqlName;
  /** The name written in resin */
  display: string;
  /** SQL lookup identity, separate from the name written in resin */
  key: string;
  schema: string | null;
  cols: Col[];
  uniques: { name: string | null; columns: Col[] }[];
  indexes: { name: string | null; columns: Col[] }[];
  foreignKeys: { name: string | null; columns: Col[]; ref: SqlRef; at: At; text?: () => string }[];
  comment: string | null;
  /** Written as `%%` comments at the end of the table */
  losses: string[];
  audit: { columns: string[] | null } | null;
  dropped: boolean;
}

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
const lower = (s: string): string => s.toLowerCase();
const cleanName = (s: string): string => s.replace(/[`\r\n]/g, "_") || "_";

/** A resin name: bare when it can be, in backticks otherwise */
export const resinName = (s: string): string => (IDENT.test(s) ? s : `\`${cleanName(s)}\``);
const resinString = (s: string): string => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
const oneLine = (s: string | null): string => (s ?? "").replace(/\s+/g, " ").trim();
const typeText = (t: SqlType): string => (t.args ? `${t.name}(${t.args.join(",")})` : t.name);
const sameSet = (a: readonly Col[], b: readonly Col[]): boolean => a.length === b.length && a.every((c) => b.includes(c));
const plural = (word: string, n: number): string => (n === 1 ? word : `${word}s`);

/** Reserve readable names first, so sanitizing an earlier name cannot take a later one's identity */
function allocateNames(names: Iterable<string>, occupied: Iterable<string> = []): (name: string) => string {
  const reserved = new Set([...names].filter((name) => cleanName(name) === name));
  const used = new Set(occupied);
  return (name) => {
    const base = cleanName(name);
    let result = base;
    if (used.has(result) || (base !== name && reserved.has(base))) {
      let suffix = 2;
      do result = `${base}_${suffix++}`; while (used.has(result) || reserved.has(result));
    }
    used.add(result);
    return result;
  };
}

/** Is this text SQL that defines a table? The playground converts a paste when it is */
export function looksLikeSql(text: string): boolean {
  return /\bcreate\s+(?:[a-z_]+\s+){0,4}table\b[^;{]{0,400}?\(/i.test(text);
}

export function fromSql(sql: string, options: SqlImportOptions = {}): SqlImport {
  const { text, statements, notes: lexicalNotes } = tokenize(sql);
  const parsed = statements.map((tokens) => ({ st: parseStatement(tokens, text), at: { line: tokens[0].line, col: tokens[0].col } }));
  const notes: SqlNote[] = [...lexicalNotes];
  const note = (message: string, at: At) => notes.push({ message, line: at.line, col: at.col });

  const tables: Tbl[] = [];
  const enums = new Map<string, string[]>();
  const skipped = new Map<string, number>();
  const skippedNames = new Set<string>();

  const matches = (name: SqlName, context?: Tbl): Tbl[] => {
    const key = objectKey(name);
    const schema = schemaKey(name);
    const live = tables.filter((t) => !t.dropped && t.key === key);
    if (schema !== null) return live.filter((t) => t.schema === schema);
    if (context?.schema !== null && context?.schema !== undefined) {
      const local = live.filter((t) => t.schema === context.schema);
      if (local.length) return local;
    }
    return live;
  };
  const find = (name: SqlName): Tbl | null => {
    const found = matches(name);
    return found.length === 1 ? found[0] : null;
  };
  const colOf = (t: Tbl, key: string): Col | null => t.cols.find((c) => c.key === key) ?? null;
  const loss = (t: Tbl, message: string, at: At) => {
    t.losses.push(message);
    note(`table \`${objectName(t.name)}\`: ${message[0].toLowerCase()}${message.slice(1)}`, at);
  };

  const column = (c: SqlColumn): Col => ({
    name: c.name,
    key: c.key,
    display: c.name,
    at: { line: c.line, col: c.col },
    type: c.type,
    notNull: c.notNull || c.pk,
    pk: c.pk,
    uk: c.unique ? { name: c.unique.name } : null,
    index: null,
    ref: c.ref ? { table: c.ref.table, column: c.ref.columns?.[0] ?? null, key: c.ref.keys?.[0] ?? null, kind: "physical", at: { line: c.line, col: c.col } } : null,
    values: c.type.values ?? c.checkValues,
    comment: c.comment,
  });

  const columns = (t: Tbl, names: string[], keys: string[], what: string, at: At): Col[] | null => {
    const out: Col[] = [];
    for (const [i, name] of names.entries()) {
      const c = colOf(t, keys[i]);
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
        for (const c of columns(t, k.columns, k.keys, "the primary key", at) ?? []) {
          c.pk = true;
          c.notNull = true;
        }
        return;
      case "check": {
        const c = colOf(t, k.key);
        if (c && !c.values) c.values = k.values;
        return;
      }
      case "fk": {
        if (k.columns.length !== 1 || (k.ref.columns && k.ref.columns.length !== 1)) {
          const cs = columns(t, k.columns, k.keys, "a foreign key", at);
          if (!cs) {
            t.losses.push(`Not converted: foreign key (${k.columns.join(", ")}) has a missing source column`);
            return;
          }
          if (cs.length < 2 || (k.ref.columns && k.ref.columns.length !== cs.length) || new Set(cs).size !== cs.length || (k.ref.keys && new Set(k.ref.keys).size !== k.ref.keys.length)) {
            loss(t, `Not converted: foreign key (${k.columns.join(", ")}) needs equal lists of distinct columns`, at);
            return;
          }
          t.foreignKeys.push({ name: k.name, columns: cs, ref: k.ref, at });
          return;
        }
        const [c] = columns(t, k.columns, k.keys, "a foreign key", at) ?? [];
        if (c && !c.ref) c.ref = { table: k.ref.table, column: k.ref.columns?.[0] ?? null, key: k.ref.keys?.[0] ?? null, kind: "physical", at };
        return;
      }
      case "index": {
        const label = `${k.unique ? "unique index" : "index"}${k.name ? ` ${k.name}` : ""}`;
        const list = k.items.map((i) => ("column" in i ? i.column : i.expression)).join(", ");
        if (k.items.some((i) => "expression" in i)) {
          loss(t, `Not converted: ${label} on (${list})`, at);
          return;
        }
        const cs = columns(t, columnsOf(k.items), keysOf(k.items), `${label}`, at);
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
      key: objectKey(s.name),
      schema: schemaKey(s.name),
      cols: [],
      uniques: [],
      indexes: [],
      foreignKeys: [],
      comment: s.comment,
      losses: [],
      audit: null,
      dropped: false,
    };
    for (const c of s.columns) {
      if (colOf(t, c.key)) note(`table \`${objectName(s.name)}\`: column \`${c.name}\` appears twice; the first is kept`, c);
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
      const existing = tables.find((t) => !t.dropped && t.key === objectKey(st.table.name) && t.schema === schemaKey(st.table.name));
      if (existing) {
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
          const t = find({ parts: [st.name], keys: [lower(st.name)], ...at });
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
    if (!skippedNames.has(lower(objectName(name))))
      note(`${what} skipped: ${matches(name).length > 1 ? "ambiguous table" : "there is no table"} \`${name.parts.join(".")}\``, at);
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
          const c = colOf(t, a.key);
          if (c) c.notNull = a.notNull || c.pk;
        } else {
          const next = column(a.column);
          const old = colOf(t, a.column.key);
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
      const tableName = st.on === "table" ? st.name : { ...st.name, parts: st.name.parts.slice(0, -1), keys: st.name.keys.slice(0, -1) };
      const t = tableName.parts.length ? find(tableName) : null;
      if (!t) {
        if (tableName.parts.length) missing(tableName, "COMMENT ON", at);
        continue;
      }
      if (st.on === "table") t.comment = st.text;
      else {
        const c = colOf(t, objectKey(st.name));
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

  const renamed = (what: string, name: string, display: string, at: At) => {
    if (name !== display) note(`${what} ${JSON.stringify(name)} renamed to ${JSON.stringify(display)} for resin`, at);
  };
  const tableNames = allocateNames(drawn.map((t) => t.display), options.known);
  for (const t of drawn) {
    const name = t.display;
    t.display = tableNames(name);
    renamed("table", name, t.display, t.name);
    const columnNames = allocateNames(t.cols.map((c) => c.name));
    for (const c of t.cols) {
      c.display = columnNames(c.name);
      renamed(`column of ${JSON.stringify(t.display)}`, c.name, c.display, c.at);
      for (const value of c.values ?? [])
        if (value === "" || /[`\r\n]/.test(value))
          loss(t, `Not converted: enum value ${JSON.stringify(value)} of column ${JSON.stringify(c.name)}`, c.at);
    }
  }

  // ---- references ----
  interface StubColumn { name: string; key: string; display: string; type: SqlType; at: At }
  interface Stub { name: string; display: string; at: At; columns: StubColumn[] }
  const stubs = new Map<string, Stub>();
  const refs = new Map<Col, () => string>();
  const knownTarget = (name: SqlName): string | null => {
    const text = name.parts.join(".");
    const exact = options.known?.find((k) => k === text);
    if (exact) return exact;
    return name.keys.every((key, i) => key === lower(name.parts[i])) ? known.get(lower(text)) ?? null : null;
  };
  const stubColumn = (table: SqlName, name: string, key: string, type: SqlType, at: At): { stub: Stub; column: StubColumn } => {
    const tableKey = JSON.stringify(table.keys);
    const stub = stubs.get(tableKey) ?? { name: table.parts.join("."), display: "", at, columns: [] };
    stubs.set(tableKey, stub);
    let column = stub.columns.find((c) => c.key === key);
    if (!column) {
      column = { name, key, display: "", type, at };
      stub.columns.push(column);
    } else if (typeText(column.type) !== typeText(type)) {
      note(`external column \`${stub.name}.${name}\` has conflicting inferred types; ${typeText(column.type)} is kept`, at);
    }
    return { stub, column };
  };
  for (const t of drawn)
    for (const c of t.cols) {
      const ref = c.ref;
      if (!ref) continue;
      const targets = matches(ref.table, t);
      if (targets.length > 1) {
        loss(t, `Not converted: reference ${c.name} -> ${ref.table.parts.join(".")}, ambiguous target (${targets.map((x) => x.name.parts.join(".")).join(", ")})`, ref.at);
        continue;
      }
      const target = targets[0];
      if (target && audits.includes(target)) {
        loss(t, `Not converted: reference ${c.name} -> ${objectName(ref.table)}, a table that \`audit envers\` generates`, ref.at);
      } else if (target) {
        const pks = target.cols.filter((x) => x.pk);
        const to = ref.key !== null ? colOf(target, ref.key) : pks.length === 1 ? pks[0] : null;
        if (!to) {
          const why = ref.column ? `${target.display} has no column ${ref.column}` : `the primary key of ${target.display} is not one column`;
          loss(t, `Not converted: reference ${c.name} -> ${ref.column ? `${target.display}.${ref.column}` : target.display}, ${why}`, ref.at);
          continue;
        }
        // Pointing at the primary key needs no column name
        const text = pks.length === 1 && pks[0] === to ? resinName(target.display) : `${resinName(target.display)}.${resinName(to.display)}`;
        refs.set(c, () => text);
      } else if (knownTarget(ref.table)) {
        const text = `${resinName(knownTarget(ref.table)!)}${ref.column ? `.${resinName(ref.column)}` : ""}`;
        refs.set(c, () => text);
      } else {
        // A table outside the SQL: declare what is known of it, the columns pointed at
        const name = ref.column ?? "id";
        const { stub, column: targetColumn } = stubColumn(ref.table, name, ref.key ?? "id", c.type, ref.at);
        if (!ref.column) note(`table \`${stub.name}\` is not in the SQL; its primary key is taken to be \`id\``, ref.at);
        // Only a lone column is taken for the primary key, and then the reference needs no column name
        refs.set(c, () => (stub.columns.length === 1 ? resinName(stub.display) : `${resinName(stub.display)}.${resinName(targetColumn.display)}`));
      }
    }

  for (const t of drawn)
    for (const fk of t.foreignKeys) {
      const targets = matches(fk.ref.table, t);
      const target = targets[0];
      const label = `foreign key (${fk.columns.map((c) => c.name).join(", ")}) -> ${fk.ref.table.parts.join(".")}`;
      if (targets.length > 1 || (target && audits.includes(target))) {
        loss(t, `Not converted: ${label}, ${targets.length > 1 ? "ambiguous target" : "the target is generated by audit envers"}`, fk.at);
        continue;
      }
      if (target) {
        const to = fk.ref.keys ? fk.ref.keys.map((key) => colOf(target, key)) : target.cols.filter((c) => c.pk);
        if (to.length !== fk.columns.length || to.some((c) => c === null)) {
          loss(t, `Not converted: ${label}, target columns are missing or do not match the source list`, fk.at);
          continue;
        }
        fk.text = () => `${resinName(target.display)}(${to.map((c) => resinName(c!.display)).join(", ")})`;
      } else if (!fk.ref.columns || !fk.ref.keys) {
        loss(t, `Not converted: ${label}, the target key columns are unknown`, fk.at);
      } else if (knownTarget(fk.ref.table)) {
        fk.text = () => `${resinName(knownTarget(fk.ref.table)!)}(${fk.ref.columns!.map(resinName).join(", ")})`;
      } else {
        const refs = fk.ref.columns.map((name, i) => stubColumn(fk.ref.table, name, fk.ref.keys![i], fk.columns[i].type, fk.at));
        fk.text = () => `${resinName(refs[0].stub.display)}(${refs.map((r) => resinName(r.column.display)).join(", ")})`;
      }
    }

  const stubNames = allocateNames([...stubs.values()].map((s) => s.name), [...drawn.map((t) => t.display), ...(options.known ?? [])]);
  for (const stub of stubs.values()) {
    stub.display = stubNames(stub.name);
    renamed("external table", stub.name, stub.display, stub.at);
    const columnNames = allocateNames(stub.columns.map((c) => c.name));
    for (const c of stub.columns) {
      c.display = columnNames(c.name);
      renamed(`column of ${JSON.stringify(stub.display)}`, c.name, c.display, c.at);
    }
  }

  // Logical references by name, when asked for: user_id → users, buyer_user_id → users, categoryId → categories
  let inferred = 0;
  if (options.inferReferences)
    for (const t of drawn)
      for (const c of t.cols) {
        if (c.ref || t.foreignKeys.some((fk) => fk.columns.includes(c))) continue;
        const targets = guessTargets(c.name, drawn);
        if (targets.length > 1) {
          note(`table \`${t.display}\`: reference for \`${c.name}\` not inferred: ambiguous target (${targets.map((x) => x.name.parts.join(".")).join(", ")})`, c.at);
          continue;
        }
        const target = targets[0];
        const pks = target?.cols.filter((x) => x.pk) ?? [];
        if (!target || pks.length !== 1 || pks[0] === c || pks[0].type.name !== c.type.name) continue;
        c.ref = { table: target.name, column: null, key: null, kind: "logical", at: c.at };
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
    out.push(`external table ${resinName(stub.display)} {`, ...align(stub.columns.map((x) => [resinName(x.display), typeText(x.type), pk ? "pk" : ""])), "}", "");
  }
  // Tables from two or more schemas: each schema's tables in a service of its name, where it first appears
  const schemas = new Set(drawn.flatMap((t) => (t.schema === null ? [] : [t.schema])));
  const split = schemas.size >= 2;
  const written = new Set<string>();
  const schemaNames = new Map(drawn.filter((t) => t.schema !== null).map((t) => [t.schema!, schemaName(t.name)!]));
  const serviceNames = allocateNames(schemaNames.values());
  for (const [schema, name] of schemaNames) {
    const display = serviceNames(name);
    schemaNames.set(schema, display);
    renamed("service", name, display, drawn.find((t) => t.schema === schema)!.name);
  }
  for (const t of drawn) {
    if (!split || t.schema === null) out.push(...writeTable(t, refs, note), "");
    else if (!written.has(t.schema)) {
      written.add(t.schema);
      const members = drawn.filter((x) => x.schema === t.schema);
      const body = members.flatMap((x, k) => [...(k ? [""] : []), ...writeTable(x, refs, note)]).map((l) => (l ? `  ${l}` : l));
      out.push(`service ${resinName(schemaNames.get(t.schema)!)} {`, ...body, "}", "");
    }
  }
  notes.sort((a, b) => a.line - b.line || a.col - b.col);
  return { source: drawn.length ? `${out.join("\n").trimEnd()}\n` : "", notes, tables: drawn.length };
}

function writeTable(t: Tbl, refs: Map<Col, () => string>, note: (message: string, at: At) => void): string[] {
  const pks = t.cols.filter((c) => c.pk);
  // SQL names must stay distinct after conversion, even when resin cannot write the original spelling
  const names = allocateNames([...t.cols.flatMap((c) => c.uk?.name ? [c.uk.name] : []), ...t.uniques.flatMap((x) => x.name ? [x.name] : []), ...t.indexes.flatMap((x) => x.name ? [x.name] : []), ...t.foreignKeys.flatMap((x) => x.name ? [x.name] : [])]);
  const claim = (n: string | null): string | null => {
    if (n === null) return null;
    const display = names(n);
    if (display !== n) note(`index name ${JSON.stringify(n)} renamed to ${JSON.stringify(display)} in table ${JSON.stringify(t.display)}`, t.name);
    return display;
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
    return [resinName(c.display), `${typeText(c.type)}${c.notNull ? "" : "?"}`, mods.join("  ")];
  });

  const list = (cs: Col[]) => cs.map((c) => resinName(c.display)).join(", ");
  const as = (n: string | null) => (n ? ` as ${resinName(n)}` : "");
  const comment = oneLine(t.comment);
  const audit = t.audit ? ` audit envers${t.audit.columns ? `(${t.audit.columns.map((name) => resinName(t.cols.find((c) => c.name === name)!.display)).join(", ")})` : ""}` : "";
  return [
    `table ${resinName(t.display)}${comment ? ` ${resinString(comment)}` : ""} {`,
    ...align(rows),
    ...uniques.map((u) => `  unique(${list(u.columns)})${as(u.name)}`),
    ...indexes.map((ix) => `  index(${list(ix.columns)})${as(ix.name)}`),
    ...t.foreignKeys.flatMap((fk) => fk.text ? [`  foreign(${list(fk.columns)}) -> ${fk.text()}${as(claim(fk.name))}`] : []),
    ...t.losses.map((l) => `  %% ${oneLine(l)}`),
    `}${audit}`,
  ];
}

/** Columns as the examples write them: names, types and modifiers each lined up. A wide character
 *  (Hangul, CJK) takes two cells of a monospace editor */
function align(rows: string[][]): string[] {
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
function guessTargets(column: string, tables: readonly Tbl[]): Tbl[] {
  const words = column
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .split(/_+/)
    .filter(Boolean);
  if (words.length < 2 || words[words.length - 1] !== "id") return [];
  const stem = words.slice(0, -1);
  for (let k = 0; k < stem.length && k <= 3; k++) {
    const wanted = stem.slice(k).join("_");
    const found = tables.filter((t) => lower(t.key) === wanted || lower(t.key) === `${wanted}s` || singular(lower(t.key)) === wanted);
    if (found.length) return found;
  }
  return [];
}

/** The last word of a table name in the singular: categories → category, addresses → address */
function singular(name: string): string {
  if (/ies$/.test(name)) return name.replace(/ies$/, "y");
  if (/(s|x|z|ch|sh)es$/.test(name)) return name.replace(/es$/, "");
  if (/[^s]s$/.test(name)) return name.slice(0, -1);
  return name;
}
