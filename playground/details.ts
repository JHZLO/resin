// What the playground says about a table (the side panel) and about a column (the small popover).
// Both are built from the model, so they state exactly what the diagram means, and both are plain
// HTML, so their text can be selected and copied.
//
// The panel is a set of tables in one style: columns, indexes, references. Every column has the same
// cells (key, name, type, NULL or NOT NULL, description), so the eye runs straight down them; facts
// that belong to one column only (its enum values, that it is encrypted) sit under its description.

import type { Model, ModelColumn, ModelTable, Relation } from "../src/index.ts";

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
export type OpenTable = (name: string) => void;
/** Picking a column from the panel */
export type PickColumn = (table: string, column: string) => void;

type Key = "PK" | "UK" | "FK" | "IX";
/** A column's strongest role: primary key, unique, reference, or just indexed */
const keyOf = (c: ModelColumn, refs: Relation[]): Key | null => (c.pk ? "PK" : c.uk ? "UK" : refs.length ? "FK" : c.index ? "IX" : null);
const kindOf = (r: Relation): string => (r.kind === "physical" ? "foreign key" : "logical");

function link(name: string, open: OpenTable): HTMLButtonElement {
  const b = h("button", "d-link", name);
  b.type = "button";
  b.title = `Show ${name}`;
  b.addEventListener("click", () => open(name));
  return b;
}

const key = (k: Key | null): Child => h("span", k ? `d-key k-${k.toLowerCase()}` : "d-key", k ?? "");
const code = (text: string): HTMLElement => h("code", null, text);
/** NULL stands out (in the same amber the diagram uses); NOT NULL, the usual case, stays quiet */
const nullity = (c: ModelColumn): HTMLElement => h("span", c.nullable ? "t-null is-null" : "t-null", c.nullable ? "NULL" : "NOT NULL");
const slashed = (values: string[]): Child[] => values.flatMap((v, i) => (i ? [h("i", null, "/"), v] : [v]));

function list(title: string, ...items: Child[]): HTMLElement {
  return h("section", "d-section", h("h3", null, title), h("ul", null, ...items));
}

/** One of the panel's tables. Narrow panels scroll it sideways rather than squeeze it */
function table(title: string, cls: string, heads: [string, string | null][], rows: HTMLTableRowElement[]): HTMLElement {
  const head = h("tr", null, ...heads.map(([label, c]) => h("th", c, label)));
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
export function tableDetails(model: Model, name: string, open: OpenTable, pick: PickColumn): HTMLElement | null {
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
      h("td", "t-key", key(keyOf(c, outgoing.filter((r) => r.childColumn === c.name)))),
      h("td", "t-name", nameButton),
      h("td", "t-type", c.type),
      h("td", null, nullity(c)),
      h("td", "t-desc", c.description ? h("span", "t-desc-text", c.description) : null, ...notes),
    );
    row.dataset.c = c.name;
    // The whole row picks the column (the name is its button, for the keyboard). Selecting text in it does not
    row.addEventListener("click", () => {
      if (String(getSelection() ?? "").length) return;
      pick(t.name, c.name);
    });
    return row;
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
      h("td", "t-name", r.childColumn),
      h("td", "t-name", link(r.parent, open), `.${r.parentColumn}`),
      h("td", "t-rel", `${kindOf(r)}, ${r.one ? "one-to-one" : "many-to-one"}${r.optional ? ", optional" : ""}`),
    ),
  );
  const referencedBy = incoming.map((r) =>
    h(
      "tr",
      null,
      h("td", "t-name", link(r.child, open), `.${r.childColumn}`),
      h("td", "t-name", r.parentColumn),
      h("td", "t-rel", `${kindOf(r)}, ${r.one ? "one-to-one" : "one-to-many"}`),
    ),
  );

  const audit: Child[] = [];
  if (t.audit) {
    audit.push(
      h("li", "d-note", `Audited with ${t.audit.method} on `, ...t.audit.columns.flatMap((c, i) => [i ? ", " : "", code(c)]), "."),
      h("li", "d-note", "Generated tables: ", link("revinfo", open), ", ", link(`${t.name}_aud`, open)),
    );
  } else if (t.origin === "audit") {
    const base = t.name.endsWith("_aud") ? t.name.slice(0, -4) : null;
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
      t.service ? h("p", "d-meta", `In service ${t.service}${serviceDescription(model, t.service)}`) : null,
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

/** The popover: one column, in a few lines */
export function columnDetails(model: Model, table: string, column: string, open: OpenTable): HTMLElement | null {
  const t = model.tables.find((x) => x.name === table);
  const c = t?.columns.find((x) => x.name === column);
  if (!t || !c) return null;
  const outgoing = model.relations.filter((r) => r.child === table && r.childColumn === column);
  const incoming = model.relations.filter((r) => r.parent === table && r.parentColumn === column);
  const facts: [string, Child[]][] = [["Table", [link(t.name, open)]], ["Null", [nullity(c)]]];
  if (c.enumValues) facts.push(["Values", [c.enumValues.join(", ")]]);
  if (c.enc) facts.push(["Stored", ["encrypted"]]);
  if (c.index) facts.push(["Index", [c.index.name ?? "unnamed"]]);
  if (c.uk) facts.push(["Unique", [c.ukName ?? "unnamed"]]);
  for (const r of outgoing) facts.push(["References", [link(r.parent, open), `.${r.parentColumn}, ${kindOf(r)}`]]);
  if (incoming.length)
    facts.push(["Referenced by", incoming.flatMap((r, i) => [i ? ", " : "", link(r.child, open), `.${r.childColumn}`])]);
  return h(
    "div",
    "d-pop",
    h("div", "d-pop-head", key(keyOf(c, outgoing)), h("span", "d-pop-name", c.name), h("span", "d-type", c.type)),
    c.description ? h("p", "d-desc", c.description) : null,
    h("dl", "d-facts", ...facts.flatMap(([k, v]) => [h("dt", null, k), h("dd", null, ...v)])),
  );
}
