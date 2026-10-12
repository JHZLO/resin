// What the playground says about a table or a service (the side panel) and about a column (the small
// popover). All are built from the model, so they state exactly what the diagram means, and all are
// plain HTML, so their text can be selected and copied.
//
// The panel is a set of tables in one style: columns, indexes, references. Every column has the same
// cells (key, name, type, NULL or NOT NULL, description), so the eye runs straight down them; facts
// that belong to one column only (its enum values, that it is encrypted) sit under its description.

import { type Model, type ModelColumn, type ModelTable, type Relation, type SqlDdl, type SqlDialect, SQL_DIALECTS } from "../src/index.ts";

/** ", Order service": a service's description after its name, when it has one */
const serviceDescription = (model: Model, name: string): string => {
  const d = model.services.find((s) => s.name === name)?.description;
  return d ? `, ${d}` : "";
};

type Child = Node | string | null | false | undefined;

function h<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string | null, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  for (const c of children) if (c !== null && c !== false && c !== undefined) el.append(c);
  return el;
}

/** Following a table name: the page decides what that does (open it in the panel, show it) */
export type OpenTable = (name: string, animate?: boolean) => void;
/** Following a service name: the page opens the service in the panel */
export type OpenService = (name: string, animate?: boolean) => void;
/** Picking a column from the panel */
export type PickColumn = (table: string, column: string, animate?: boolean) => void;

type Key = "PK" | "UK" | "FK" | "IX";
/** A column's strongest role: primary key, unique, reference, or just indexed */
const keyOf = (c: ModelColumn, refs: Relation[], table: ModelTable): Key | null =>
  c.pk ? "PK" : c.uk ? "UK" : c.ref || refs.length || table.foreignKeys?.some((fk) => fk.columns.includes(c.name)) ? "FK" : c.index ? "IX" : null;
const kindOf = (r: Relation): string => (r.kind === "physical" ? "foreign key" : "logical");
const columnsOf = (r: Relation, side: "parent" | "child"): string[] => r[`${side}Columns`] ?? [r[`${side}Column`]];
const columnSuffix = (columns: string[]): string => columns.length === 1 ? `.${columns[0]}` : ` (${columns.join(", ")})`;

function link(name: string, open: OpenTable | OpenService): HTMLButtonElement {
  const b = h("button", "d-link", name);
  b.type = "button";
  b.title = `Show ${name}`;
  b.addEventListener("click", (event) => open(name, event.detail !== 0));
  return b;
}

const key = (k: Key | null): Child => h("span", k ? `d-key k-${k.toLowerCase()}` : "d-key", k ?? "");

/** A row pressed as a whole (its name is a button, for the keyboard). Selecting text in it does not press it */
function pressable(row: HTMLTableRowElement, act: (animate: boolean) => void): HTMLTableRowElement {
  row.addEventListener("click", (event) => {
    const selection = getSelection();
    if (event.detail !== 0 && selection && !selection.isCollapsed && selection.containsNode(row, true)) return;
    act(event.detail !== 0);
  });
  return row;
}
const code = (text: string): HTMLElement => h("code", null, text);
/** NULL stands out (in the same amber the diagram uses); NOT NULL, the usual case, stays quiet */
const nullity = (c: ModelColumn): HTMLElement => h("span", c.nullable ? "t-null is-null" : "t-null", c.nullable ? "NULL" : "NOT NULL");
const slashed = (values: string[]): Child[] => values.flatMap((v, i) => (i ? [h("i", null, "/"), v] : [v]));

function list(title: string, ...items: Child[]): HTMLElement {
  return h("section", "d-section", h("h3", null, title), h("ul", null, ...items));
}

/** One of the panel's tables. Narrow panels scroll it sideways rather than squeeze it */
function table(title: string, cls: string, heads: [string, string | null][], rows: HTMLTableRowElement[]): HTMLElement {
  const head = h("tr", null, ...heads.map(([label, c]) => {
    const cell = h("th", c, label);
    cell.scope = "col";
    return cell;
  }));
  return h(
    "section",
    "d-section",
    h("h3", null, title),
    h("div", "t-wrap", h("table", `t-table ${cls}`, h("thead", null, head), h("tbody", null, ...rows))),
  );
}

/** Every index of a table: its primary key, then unique keys, then indexes, single or composite */
function indexesOf(t: ModelTable): { kind: Key; name: string | null; columns: string[] }[] {
  const out: { kind: Key; name: string | null; columns: string[] }[] = [];
  const pk = t.columns.filter((c) => c.pk).map((c) => c.name);
  if (pk.length) out.push({ kind: "PK", name: null, columns: pk });
  for (const c of t.columns) if (c.uk) out.push({ kind: "UK", name: c.ukName, columns: [c.name] });
  for (const k of t.constraints) if (k.kind === "unique") out.push({ kind: "UK", name: k.name, columns: k.columns });
  for (const c of t.columns) if (c.index) out.push({ kind: "IX", name: c.index.name, columns: [c.name] });
  for (const k of t.constraints) if (k.kind === "index") out.push({ kind: "IX", name: k.name, columns: k.columns });
  return out;
}

/** The side panel: everything about one table */
export function tableDetails(model: Model, name: string, open: OpenTable, pick: PickColumn, openService: OpenService): HTMLElement | null {
  const t = model.tables.find((x) => x.name === name);
  if (!t) return null;
  const outgoing = model.relations.filter((r) => r.child === name);
  const incoming = model.relations.filter((r) => r.parent === name);
  const changed = { added: "NEW", removed: "REMOVED", changed: "CHANGED" } as const;
  const tags = [t.change && changed[t.change.kind], t.origin === "external" && "EXTERNAL", t.origin === "audit" && "GENERATED", t.audit && t.audit.method.toUpperCase()].filter(
    (x): x is string => typeof x === "string",
  );
  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

  const columns = t.columns.map((c) => {
    const nameButton = h("button", "d-col-name", c.name);
    nameButton.type = "button";
    nameButton.title = "Show this column on the diagram";
    const notes: Child[] = [];
    if (c.enumValues) notes.push(h("span", "t-note", h("span", "t-lab", "values"), " ", ...slashed(c.enumValues)));
    if (c.enc) notes.push(h("span", "t-note", h("span", "t-lab", "stored"), " encrypted"));
    // Comparing with an older version: what happened to the column
    if (c.change) notes.push(h("span", "t-note", h("span", "t-lab", c.change.kind), c.change.details.length ? ` ${c.change.details.join("; ")}` : ""));
    const row = h(
      "tr",
      null,
      h("td", "t-key", key(keyOf(c, outgoing.filter((r) => columnsOf(r, "child").includes(c.name)), t))),
      h("td", "t-name", nameButton),
      h("td", "t-type", c.type),
      h("td", null, nullity(c)),
      h("td", "t-desc", c.description ? h("span", "t-desc-text", c.description) : null, ...notes),
    );
    row.dataset.c = c.name;
    // The whole row picks the column
    return pressable(row, (animate) => pick(t.name, c.name, animate));
  });

  const indexes = indexesOf(t).map((ix) =>
    h(
      "tr",
      null,
      h("td", "t-key", key(ix.kind)),
      h("td", ix.name ? "t-name" : "t-name t-none", ix.name ?? (ix.kind === "PK" ? "primary key" : "unnamed")),
      h("td", "t-type", ix.columns.join(", ")),
    ),
  );

  const references = outgoing.map((r) =>
    h(
      "tr",
      null,
      h("td", "t-name", columnsOf(r, "child").join(", ")),
      h("td", "t-name", link(r.parent, open), columnSuffix(columnsOf(r, "parent"))),
      h("td", "t-rel", `${kindOf(r)}, ${r.one ? "one-to-one" : "many-to-one"}${r.optional ? ", optional" : ""}`),
    ),
  );
  const referencedBy = incoming.map((r) =>
    h(
      "tr",
      null,
      h("td", "t-name", link(r.child, open), columnSuffix(columnsOf(r, "child"))),
      h("td", "t-name", columnsOf(r, "parent").join(", ")),
      h("td", "t-rel", `${kindOf(r)}, ${r.one ? "one-to-one" : "one-to-many"}`),
    ),
  );

  const audit: Child[] = [];
  if (t.audit) {
    audit.push(
      h("li", "d-note", `Audited with ${t.audit.method} on `, ...t.audit.columns.flatMap((c, i) => [i ? ", " : "", code(c)]), "."),
      h("li", "d-note", "Generated tables: ", link("revinfo", open), ", ", link(model.tables.find(x => x.origin === "audit" && x.service === t.service && (x.label ?? x.name) === `${t.label ?? t.name}_aud`)?.name ?? `${t.name}_aud`, open)),
    );
  } else if (t.origin === "audit") {
    const label = t.label ?? t.name;
    const base = label.endsWith("_aud") ? model.tables.find(x => x.audit && x.service === t.service && (x.label ?? x.name) === label.slice(0, -4))?.name ?? null : null;
    audit.push(
      base
        ? h("li", "d-note", "Generated by the audit of ", link(base, open), ": one row per revision of each change.")
        : h("li", "d-note", "One row per revision, shared by every audited table."),
    );
  }

  return h(
    "div",
    "d-table",
    h(
      "header",
      "d-head",
      h("h2", "d-name", t.name),
      tags.length ? h("span", "d-tags", ...tags.map((x) => h("span", "d-chip", x))) : null,
      t.description ? h("p", "d-desc", t.description) : null,
      h("p", "d-meta", `${plural(t.columns.length, "column")}, ${plural(outgoing.length, "reference")}, referenced by ${incoming.length}`),
      t.service ? h("p", "d-meta", "In service ", link(t.service, openService), serviceDescription(model, t.service)) : null,
    ),
    table(
      "Columns",
      "t-cols",
      [
        ["Key", "t-key"],
        ["Column", null],
        ["Type", null],
        ["Null", null],
        ["Description", null],
      ],
      columns,
    ),
    indexes.length
      ? table(
          "Indexes",
          "t-ix",
          [
            ["Key", "t-key"],
            ["Name", null],
            ["Columns", null],
          ],
          indexes,
        )
      : null,
    references.length
      ? table(
          "References",
          "t-refs",
          [
            ["Column", null],
            ["References", null],
            ["Relation", null],
          ],
          references,
        )
      : null,
    referencedBy.length
      ? table(
          "Referenced by",
          "t-refs",
          [
            ["From", null],
            ["Column", null],
            ["Relation", null],
          ],
          referencedBy,
        )
      : null,
    audit.length ? list("Audit", ...audit) : null,
  );
}

/** The service panel answers three questions: what the service owns, what it depends on and what
 *  uses it. The header answers them in names; the tables below list the references that cross the
 *  service's edge, under a row for each service on the other side. References inside the service are
 *  in the panels of its tables. Rows are pressed as a whole: a table opens it, a reference shows it */
export function serviceDetails(model: Model, name: string, open: OpenTable, pick: PickColumn, openService: OpenService): HTMLElement | null {
  const sv = model.services.find((s) => s.name === name);
  if (!sv) return null;
  const tables = model.tables.filter((t) => t.service === name && t.origin !== "audit");
  const byName = new Map(model.tables.map((t) => [t.name, t]));
  const serviceOf = (table: string) => byName.get(table)?.service ?? null;
  const labelOf = (table: string) => byName.get(table)?.label ?? table;
  const cross = model.relations.filter((r) => r.origin === "table" && serviceOf(r.parent) !== serviceOf(r.child));
  const out = cross.filter((r) => serviceOf(r.child) === name);
  const inc = cross.filter((r) => serviceOf(r.parent) === name);
  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

  const button = (text: string, title: string) => {
    const b = h("button", "d-col-name", text);
    b.type = "button";
    b.title = title;
    return b;
  };

  const owned = tables.map((t) => {
    const tags = [t.origin === "external" && "EXTERNAL", t.audit && t.audit.method.toUpperCase()].filter((x): x is string => typeof x === "string");
    return pressable(
      h(
        "tr",
        null,
        h("td", "t-name", button(labelOf(t.name), `Open ${t.name}`), ...tags.map((x) => h("span", "d-chip", x))),
        h("td", "t-type t-num", String(t.columns.length)),
        h("td", "t-desc", t.description ?? ""),
      ),
      (animate) => open(t.name, animate),
    );
  });

  /** The services on the other side, in the order they are declared; tables outside every service last */
  const groups = (rels: Relation[], side: "parent" | "child") => {
    const keys = [...new Set(rels.map((r) => serviceOf(r[side])))];
    const at = (key: string | null) => (key === null ? Infinity : model.services.findIndex((s) => s.name === key));
    return keys.sort((a, b) => at(a) - at(b)).map((key) => {
      const rs = rels.filter((r) => serviceOf(r[side]) === key);
      const other = model.services.find((s) => s.name === key);
      const head = h(
        "th",
        null,
        other ? link(other.name, openService) : h("span", "t-none", "No service"),
        other?.description ? h("span", "s-desc", other.description) : null,
        h("span", "s-count", plural(rs.length, "reference")),
      );
      head.colSpan = 4;
      head.scope = "rowgroup";
      const rows = rs.map((r) => {
        const crossing = r.kind === "physical" && serviceOf(r.parent) !== null && serviceOf(r.child) !== null;
        const arrow = h("td", crossing ? "t-arrow is-warn" : "t-arrow", r.kind === "physical" ? "->" : "~>");
        arrow.title = crossing ? "A foreign key across services: write ~> for a logical reference" : r.kind === "physical" ? "Foreign key" : "Logical reference";
        const from = `${labelOf(r.child)}${columnSuffix(columnsOf(r, "child"))}`;
        const to = `${labelOf(r.parent)}${columnSuffix(columnsOf(r, "parent"))}`;
        const cardinality = side === "parent" ? (r.one ? "one-to-one" : "many-to-one") : r.one ? "one-to-one" : "one-to-many";
        return pressable(
          h(
            "tr",
            null,
            h("td", "t-name", button(from, "Show this reference on the diagram")),
            arrow,
            h("td", "t-name", to),
            h("td", "t-rel", `${cardinality}${r.optional && side === "parent" ? ", optional" : ""}`),
          ),
          (animate) => pick(r.child, columnsOf(r, "child")[0], animate),
        );
      });
      return h("tbody", null, h("tr", "s-group", head), ...rows);
    });
  };
  const refs = (title: string, heads: string[], body: HTMLElement[]) => {
    const cols = h("colgroup", null, ...["c-from", "c-arrow", null, "c-rel"].map((c) => h("col", c)));
    const head = h("tr", null, ...heads.map((label) => {
      const cell = h("th", null, label);
      cell.scope = "col";
      return cell;
    }));
    return h("section", "d-section", h("h3", null, title), h("div", "t-wrap", h("table", "t-table s-refs", cols, h("thead", null, head), ...body)));
  };
  /** The names on the other side, for the header: services, and tables outside every service */
  const names = (rels: Relation[], side: "parent" | "child"): Child[] => {
    const seen = new Map<string, Child>();
    for (const r of rels) {
      const s = serviceOf(r[side]);
      if (s) seen.set(`s:${s}`, link(s, openService));
      else seen.set(`t:${r[side]}`, h("span", null, link(r[side], open), " ", h("span", "t-lab", "(no service)")));
    }
    return seen.size ? [...seen.values()].flatMap((x, i) => (i ? [", ", x] : [x])) : [h("span", "t-lab", "nothing")];
  };
  const fact = (term: string, ...value: Child[]): Child[] => [h("dt", null, term), h("dd", null, ...value)];

  return h(
    "div",
    "d-table",
    h(
      "header",
      "d-head",
      h("h2", "d-name", name),
      sv.description ? h("p", "d-desc", sv.description) : null,
      h("dl", "d-facts", ...fact("Tables", String(tables.length)), ...fact("Depends on", ...names(out, "parent")), ...fact("Used by", ...names(inc, "child"))),
    ),
    table("Tables", "t-svc", [["Table", null], ["Columns", "t-num"], ["Description", null]], owned),
    out.length ? refs("Depends on", ["Column", "", "References", "Relation"], groups(out, "parent")) : null,
    inc.length ? refs("Used by", ["From", "", "Column", "Relation"], groups(inc, "child")) : null,
  );
}

/** The popover: one column, in a few lines */
export function columnDetails(model: Model, table: string, column: string, open: OpenTable): HTMLElement | null {
  const t = model.tables.find((x) => x.name === table);
  const c = t?.columns.find((x) => x.name === column);
  if (!t || !c) return null;
  const outgoing = model.relations.filter((r) => r.child === table && columnsOf(r, "child").includes(column));
  const incoming = model.relations.filter((r) => r.parent === table && columnsOf(r, "parent").includes(column));
  const facts: [string, Child[]][] = [["Table", [link(t.name, open)]], ["Null", [nullity(c)]]];
  if (c.enumValues) facts.push(["Values", [c.enumValues.join(", ")]]);
  if (c.enc) facts.push(["Stored", ["encrypted"]]);
  if (c.index) facts.push(["Index", [c.index.name ?? "unnamed"]]);
  if (c.uk) facts.push(["Unique", [c.ukName ?? "unnamed"]]);
  for (const r of outgoing) facts.push(["References", [link(r.parent, open), `${columnSuffix(columnsOf(r, "parent"))}, ${kindOf(r)}`]]);
  if (incoming.length)
    facts.push(["Referenced by", incoming.flatMap((r, i) => [i ? ", " : "", link(r.child, open), columnSuffix(columnsOf(r, "child"))])]);
  return h(
    "div",
    "d-pop",
    h("div", "d-pop-head", key(keyOf(c, outgoing, t)), h("span", "d-pop-name", c.name), h("span", "d-type", c.type)),
    c.description ? h("p", "d-desc", c.description) : null,
    h("dl", "d-facts", ...facts.flatMap(([k, v]) => [h("dt", null, k), h("dd", null, ...v)])),
  );
}

const DIALECT_NAMES: Record<SqlDialect, string> = { mysql: "MySQL", postgres: "PostgreSQL", sqlite: "SQLite", sqlserver: "SQL Server", oracle: "Oracle" };
const SQL_WORDS = /^(CREATE|TABLE|SCHEMA|TYPE|AS|ENUM|INDEX|ON|NOT|NULL|PRIMARY|KEY|UNIQUE|CONSTRAINT|FOREIGN|REFERENCES|ALTER|ADD|CHECK|IN|COMMENT|IS|EXEC)$/;

/** SQL with the editor's colors: keywords, strings and comments */
function sqlCode(sql: string): HTMLElement {
  const code = h("code", null);
  for (const part of sql.split(/(--[^\n]*|N?'(?:[^']|'')*'|\b[A-Z]+\b)/)) {
    if (!part) continue;
    if (part.startsWith("--")) code.append(h("span", "sql-cm", part));
    else if (part.endsWith("'")) code.append(h("span", "sql-str", part));
    else if (SQL_WORDS.test(part)) code.append(h("span", "sql-kw", part));
    else code.append(part);
  }
  return h("pre", "sql-code", code);
}

/** The side panel's SQL: which database and which service, the DDL, and its notes. `ddl` is null
 *  when the document has errors */
export function sqlDetails(
  model: Model | null,
  ddl: SqlDdl | null,
  dialect: SqlDialect,
  service: string | null,
  setDialect: (d: SqlDialect) => void,
  setService: (s: string | null) => void,
): HTMLElement {
  const dialects = h(
    "span",
    "seg sql-dialects",
    ...SQL_DIALECTS.map((d) => {
      const b = h("button", null, DIALECT_NAMES[d]);
      b.type = "button";
      b.dataset.dialect = d;
      b.setAttribute("aria-pressed", String(d === dialect));
      b.addEventListener("click", () => setDialect(d));
      return b;
    }),
  );
  dialects.setAttribute("role", "group");
  dialects.setAttribute("aria-label", "Database");
  let picker: HTMLElement | null = null;
  if (model?.services.length) {
    const select = h("select", null, h("option", null, "All services"), ...model.services.map((s) => h("option", null, s.name)));
    select.setAttribute("aria-label", "Service");
    (select.options[0] as HTMLOptionElement).value = "";
    for (const o of [...select.options].slice(1)) o.value = o.textContent!;
    select.value = service ?? "";
    select.addEventListener("change", () => setService(select.value || null));
    picker = h("label", "picker sql-service", select);
    picker.insertAdjacentHTML("beforeend", '<svg class="chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>');
  }
  // What SQL cannot hold, said where it happens rather than in the docs only
  const lossy = model?.tables.some((t) => t.columns.some((c) => c.enc || c.ref?.kind === "logical") || t.foreignKeys?.some((fk) => fk.kind === "logical"));
  const notes = [...(ddl?.notes ?? []), ...(ddl && lossy ? ["Logical references (~>) and enc are written as SQL comments: importing does not bring them back"] : [])];
  return h(
    "div",
    "sql-view",
    h("div", "sql-controls", dialects, picker),
    ddl ? sqlCode(ddl.sql) : h("p", "d-note", "Fix the errors first: SQL is written from a document without errors."),
    notes.length ? h("section", "d-section", h("h3", null, "Notes"), h("ul", "sql-notes", ...notes.map((n) => h("li", "d-note", n)))) : null,
  );
}

