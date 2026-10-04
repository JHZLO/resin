import { compile, diff, type Document, type Model, type ModelDiff } from "../src/index.ts";
import { quoteName, tableId, typeText, type Table } from "../src/ast.ts";
import { resolveRef } from "../src/checker.ts";

const q = quoteName;
const text = (s: string | null) => s === null ? "" : ` ${JSON.stringify(s)}`;
const named = (name: { text: string } | null) => name ? ` as ${q(name.text)}` : "";
const list = (items: { text: string }[]) => items.map(x => q(x.text)).join(", ");

/** Canonical source for editing operations. Existing comments remain in a reviewable preamble. */
export function writeDocument(doc: Document, originals: string[] = []): string {
  const table = (t: Table): string => {
    const lines = t.columns.map(c => {
      const ref = c.ref;
      return `  ${q(c.name.text)} ${typeText(c.type)}${c.nullable ? "?" : ""}`
        + (c.pk ? " pk" : "") + (c.uk ? ` uk${named(c.uk.name)}` : "") + (c.enc ? " enc" : "")
        + (c.enumValues ? ` enum(${list(c.enumValues)})` : "") + (c.index ? ` index${named(c.index.name)}` : "")
        + (ref ? ` ${ref.kind === "physical" ? "->" : "~>"} ${ref.service ? `${q(ref.service.text)}.` : ""}${q(ref.table.text)}${ref.column ? `.${q(ref.column.text)}` : ""}` : "") + text(c.description);
    });
    lines.push(...t.constraints.map(k => `  ${k.kind}(${list(k.columns)})${named(k.name)}`));
    lines.push(...t.foreignKeys.map(k => `  foreign(${list(k.columns)}) ${k.kind === "physical" ? "->" : "~>"} ${k.service ? `${q(k.service.text)}.` : ""}${q(k.table.text)}(${list(k.targetColumns)})${named(k.name)}`));
    const audit = t.audit ? ` audit ${q(t.audit.method.text)}${t.audit.columns ? `(${list(t.audit.columns)})` : ""}` : "";
    return `${t.external ? "external " : ""}table ${q(t.name.text)}${text(t.description)} {\n${lines.join("\n")}\n}${audit}`;
  };
  const comments = [...new Set(originals.flatMap(commentLines))];
  const blocks = doc.tables.filter(t => !t.service).map(table);
  for (const service of doc.services) {
    const body = doc.tables.filter(t => t.service?.text === service.name.text).map(table).join("\n\n").split("\n").map(l => l ? `  ${l}` : l).join("\n");
    blocks.push(`service ${q(service.name.text)}${text(service.description)} {\n${body}\n}`);
  }
  return [...(comments.length ? [comments.join("\n")] : []), ...blocks].join("\n\n") + "\n";
}

function commentLines(source: string): string[] {
  const found: string[] = [];
  for (const line of source.split("\n")) {
    let quote = "";
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (quote) { if (c === "\\" && quote === '"') i++; else if (c === quote) quote = ""; }
      else if (c === '"' || c === "`") quote = c;
      else if (line.slice(i, i + 2) === "%%") { found.push(line.slice(i)); break; }
    }
  }
  return found;
}

export interface Candidate { child: string; column: string; parent: string; target: string; reason: string }
const singular = (name: string) => name.toLowerCase().replace(/ies$/, "y").replace(/s$/, "");
const typeKey = (type: string) => type.toLowerCase().replace(/\(.*/, "").replace(/^integer$/, "int");

export function referenceCandidates(model: Model): Candidate[] {
  const result: Candidate[] = [];
  for (const child of model.tables.filter(t => t.origin === "table")) for (const c of child.columns) {
    if (c.ref || !c.name.toLowerCase().endsWith("_id") || model.relations.some(r => r.child === child.name && (r.childColumns ?? [r.childColumn]).includes(c.name))) continue;
    const stem = c.name.toLowerCase().slice(0, -3);
    const targets = model.tables.filter(t => t.origin === "table" && singular(t.label ?? t.name) === singular(stem));
    const local = targets.filter(t => t.service === child.service);
    for (const parent of local.length ? local : targets) {
      const keys = parent.columns.filter(c => c.pk);
      if (keys.length !== 1 || typeKey(keys[0].type) !== typeKey(c.type)) continue;
      result.push({ child: child.name, column: c.name, parent: parent.name, target: keys[0].name,
        reason: targets.length > 1 && !local.length ? "Name and type match; multiple services match" : "Column name and primary-key type match" });
    }
  }
  return result;
}

export function addLogicalReferences(source: string, candidates: Candidate[], replace = false): string {
  const r = compile(source);
  if (!r.model) throw new Error("Fix the source errors before adding a reference.");
  for (const candidate of candidates) {
    const child = r.doc.tables.find(t => tableId(t) === candidate.child);
    const parent = r.doc.tables.find(t => tableId(t) === candidate.parent);
    const c = child?.columns.find(c => c.name.text === candidate.column);
    const target = parent?.columns.find(c => c.name.text === candidate.target);
    if (!child || !parent || !c || !target) throw new Error("A reference endpoint no longer exists.");
    if ((c.ref && !(replace && c.ref.kind === "logical")) || child.foreignKeys.some(k => k.columns.some(x => x.text === c.name.text))) throw new Error(`Column ${candidate.child}.${candidate.column} already has a reference.`);
    c.ref = { kind: "logical", table: parent.name, service: parent.service, column: target.name, span: c.span };
  }
  return checked(writeDocument(r.doc, [source]));
}

export function removeLogicalReference(source: string, table: string, column: string): string {
  const r = compile(source);
  if (!r.model) throw new Error("Fix the source errors before editing a reference.");
  const c = r.doc.tables.find(t => tableId(t) === table)?.columns.find(c => c.name.text === column);
  if (c?.ref?.kind !== "logical") throw new Error("Select a column with a logical reference.");
  c.ref = null;
  return checked(writeDocument(r.doc, [source]));
}

export function assignService(source: string, name: string): string {
  if (!name.trim()) return source;
  if (/[`\r\n]/.test(name)) throw new Error("A service name cannot contain backticks or line breaks.");
  const r = compile(source);
  if (!r.model) throw new Error("The imported source contains errors.");
  if (r.doc.services.length) throw new Error("This import already has SQL schema services. Leave the service field empty to keep them.");
  const nameNode = { text: name.trim(), span: { line: 1, col: 1, len: name.length } };
  r.doc.services.push({ name: nameNode, description: null, span: nameNode.span });
  for (const t of r.doc.tables) if (!t.external) t.service = nameNode;
  return checked(writeDocument(r.doc, [source]));
}

/** Replace the tables in one import, while retaining application annotations by stable identity. */
export function mergeImport(current: string, incoming: string, previousImport: string | null): { source: string; changes: ModelDiff["changes"]; notes: string[] } {
  const before = compile(current);
  const next = compile(incoming);
  if (!before.model || !next.model) throw new Error("Both versions must compile before an import can be merged.");
  const oldImported = previousImport ? compile(previousImport).doc : { tables: [] };
  const notes: string[] = [];
  const targets = new Map(next.doc.tables.flatMap(t => t.columns.filter(c => c.ref).map(c => [c, resolveRef(next.doc, c)] as const)));
  const findCurrent = (t: Table) => before.doc.tables.find(o => tableId(o) === tableId(t))
    ?? (before.doc.tables.filter(o => o.name.text === t.name.text).length === 1 ? before.doc.tables.find(o => o.name.text === t.name.text) : undefined);
  if (previousImport) for (const t of next.doc.tables) {
    const previous = oldImported.tables.find(o => tableId(o) === tableId(t));
    const current = previous ? findCurrent(previous) : undefined;
    if (current && current.service?.text !== previous?.service?.text) t.service = current.service;
  }
  for (const [column, target] of targets) if (target && column.ref) {
    column.ref.service = target.table.service;
    if (target.table.service && !column.ref.column) column.ref.column = target.column.name;
  }
  // A generated external stub must never replace a table the user already owns.
  next.doc.tables = next.doc.tables.filter(t => !t.external || !before.doc.tables.some(o => tableId(o) === tableId(t)));
  const replaced = new Set([...oldImported.tables.filter(t => !t.external).map(t => findCurrent(t) ?? t), ...next.doc.tables].map(t => tableId(t)));
  for (const t of next.doc.tables) {
    const old = before.doc.tables.find(o => tableId(o) === tableId(t));
    if (!old) continue;
    t.description ??= old.description;
    t.audit ??= old.audit;
    for (const c of t.columns) {
      const oldColumn = old.columns.find(o => o.name.text === c.name.text);
      if (!oldColumn) continue;
      c.description ??= oldColumn.description;
      c.enc ||= oldColumn.enc;
      c.enumValues ??= oldColumn.enumValues;
      if (!c.ref && oldColumn.ref?.kind === "logical") {
        const target = resolveRef(before.doc, oldColumn);
        c.ref = { ...oldColumn.ref, ...(target ? { table: target.table.name, service: target.table.service, column: target.column.name } : {}) };
      }
    }
    for (const fk of old.foreignKeys.filter(k => k.kind === "logical")) {
      if (fk.columns.every(c => t.columns.some(tc => tc.name.text === c.text)) && !t.foreignKeys.some(k => k.columns.map(c => c.text).join() === fk.columns.map(c => c.text).join())) t.foreignKeys.push(fk);
      else notes.push(`Review the logical constraint on ${tableId(t)} (${list(fk.columns)}).`);
    }
    if (old.audit?.columns?.some(c => !t.columns.some(tc => tc.name.text === c.text))) notes.push(`The audit list on ${tableId(t)} refers to a removed column. Edit the preview before applying.`);
  }
  const doc: Document = { tables: [...before.doc.tables.filter(t => !replaced.has(tableId(t))), ...next.doc.tables], services: [...before.doc.services] };
  for (const service of next.doc.services) if (!doc.services.some(s => s.name.text === service.name.text)) doc.services.push(service);
  // Do not discard a manual relation whose target was removed. The invalid preview must be reviewed.
  const source = writeDocument(doc, [current, incoming]);
  const after = compile(source);
  if (!after.model) notes.push(...after.diagnostics.filter(d => d.severity === "error").map(d => d.message));
  return { source, changes: after.model ? diff(before.model, after.model).changes : [], notes };
}

function checked(source: string): string {
  const r = compile(source);
  if (!r.model) throw new Error(r.diagnostics.filter(d => d.severity === "error").map(d => d.message).join("\n"));
  return source;
}

export type Direction = "both" | "outgoing" | "incoming";
export function relatedModel(model: Model, table: string, steps: number, direction: Direction): Model {
  const keep = new Set([table]);
  for (let i = 0; i < steps; i++) {
    const from = new Set(keep);
    for (const r of model.relations.filter(r => r.origin === "table")) {
      if (direction !== "incoming" && from.has(r.child)) keep.add(r.parent);
      if (direction !== "outgoing" && from.has(r.parent)) keep.add(r.child);
    }
  }
  return subset(model, keep);
}
export function relationPath(model: Model, from: string, to: string): string[] | null {
  if (![from, to].every(name => model.tables.some(t => t.name === name))) return null;
  const previous = new Map<string, string | null>([[from, null]]);
  const queue = [from];
  const adjacent = new Map<string, Set<string>>();
  for (const r of model.relations.filter(r => r.origin === "table")) {
    for (const [a, b] of [[r.child, r.parent], [r.parent, r.child]]) {
      if (!adjacent.has(a)) adjacent.set(a, new Set());
      adjacent.get(a)!.add(b);
    }
  }
  for (let i = 0; i < queue.length; i++) {
    const here = queue[i];
    if (here === to) {
      const path = [to];
      for (let at = previous.get(to); at != null; at = previous.get(at)) path.unshift(at);
      return path;
    }
    for (const next of adjacent.get(here) ?? []) if (!previous.has(next)) { previous.set(next, here); queue.push(next); }
  }
  return null;
}
export function subset(model: Model, keep: Set<string>): Model {
  return { ...model, tables: model.tables.filter(t => keep.has(t.name)), relations: model.relations.filter(r => keep.has(r.parent) && keep.has(r.child)) };
}
