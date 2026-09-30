// Model → Mermaid `erDiagram` source. The mapping is defined in docs/SPEC.md §5.
//
// Output is deterministic: the same input gives byte-identical output. Every order comes from model
// order (which is document order), never from Map/Set iteration or locale-aware sorting. Changing the
// format changes the examples/*.mmd golden files: review the diff, then update with `pnpm test -u`.

import type { Model, ModelColumn, ModelTable } from "./model.ts";

const I1 = "    ";
const I2 = "        ";

/** Mermaid has no `\"` escape; quotes become an entity code */
const quote = (s: string): string => `"${s.replace(/"/g, "#quot;")}"`;

// Table names Mermaid 11.16 cannot read unquoted (measured), plus keywords of the same family. Case-insensitive
const RESERVED = new Set(["class", "classdef", "style", "erdiagram", "direction", "acctitle", "accdescr", "title", "to", "one", "many"]);

/** Table names: plain ASCII identifiers that are not keywords stay as they are, everything else is quoted */
export function entityName(name: string): string {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) && !RESERVED.has(name.toLowerCase()) ? name : quote(name);
}

/** Column names: Mermaid does not accept quoted attribute names, so they are rewritten. `changed` says whether they were */
export function attributeName(name: string): { text: string; changed: boolean } {
  let text = name.replace(/[^\p{L}\p{N}_-]/gu, "_");
  if (/^[\p{N}-]/u.test(text)) text = "_" + text;
  if (/^(pk|fk|uk)$/i.test(text)) text += "_";
  return { text, changed: text !== name };
}

export function toMermaid(model: Model): string {
  const out: string[] = ["erDiagram"];

  const domain = model.relations.filter((r) => r.origin === "table");
  const audit = model.relations.filter((r) => r.origin === "audit");
  if (domain.length > 0) out.push(`${I1}%% solid(--)=physical FK / dotted(..)=logical reference`);
  for (const r of domain) {
    const left = r.optional ? "|o" : "||";
    const line = r.kind === "physical" ? "--" : "..";
    const right = r.one ? "o|" : "o{";
    out.push(`${I1}${entityName(r.parent)} ${left}${line}${right} ${entityName(r.child)} : ${quote(r.childColumn)}`);
  }
  if (domain.length > 0 && audit.length > 0) out.push("");
  for (const r of audit) out.push(`${I1}${entityName(r.parent)} ||..o{ ${entityName(r.child)} : "Envers rev"`);

  for (const t of model.tables) out.push("", ...entity(t));
  if (model.tables.some((t) => t.origin === "external")) out.push("", `${I1}classDef external stroke-dasharray:4 3`);
  return out.join("\n") + "\n";
}

function entity(t: ModelTable): string[] {
  let head = entityName(t.name);
  if (t.description) head += `[${quote(`${t.name} (${t.description})`)}]`;
  if (t.origin === "external") head += ":::external";

  // Mermaid has no place for composite constraints; they go into the comment of their first column
  const notes = new Map<string, string[]>();
  for (const k of t.constraints) {
    const tag = k.name ?? (k.kind === "unique" ? "uk" : "ix");
    const list = notes.get(k.columns[0]) ?? [];
    list.push(`${tag}(${k.columns.join(",")})`);
    notes.set(k.columns[0], list);
  }
  const lines = t.columns.map((c) => I2 + (t.origin === "audit" ? auditAttribute(c) : attribute(c, notes.get(c.name) ?? [])));
  return [`${I1}${head} {`, ...lines, `${I1}}`];
}

function keys(c: ModelColumn): string {
  return [c.pk && "PK", c.ref && "FK", c.uk && "UK"].filter(Boolean).join(",");
}

function attribute(c: ModelColumn, notes: string[]): string {
  const name = attributeName(c.name);
  // "`original name`; description (enc) A/B; -> t.c (uk_name) (ix_name); uk(a,b)"
  const facts = [
    [c.description, c.enc ? "(enc)" : null, c.enumValues ? c.enumValues.join("/") : null].filter((x) => x !== null && x !== "").join(" "),
    c.ref ? `${c.ref.kind === "physical" ? "->" : "~>"} ${c.ref.table}.${c.ref.column}` : "",
  ]
    .filter((x) => x !== "")
    .join("; ");
  const names = [c.ukName ? `(${c.ukName})` : "", c.index ? `(${c.index.name ?? "ix"})` : ""].filter((x) => x !== "").join(" ");
  const comment = [name.changed ? `\`${c.name}\`` : "", [facts, names].filter((x) => x !== "").join(" "), ...notes]
    .filter((x) => x !== "")
    .join("; ");

  let line = `${c.type}${c.nullable ? "?" : ""} ${name.text}`;
  const k = keys(c);
  if (k) line += ` ${k}`;
  if (comment) line += ` ${quote(comment)}`;
  return line;
}

/** Audit tables only list what is versioned; nullability and descriptions live on the original table */
function auditAttribute(c: ModelColumn): string {
  const name = attributeName(c.name);
  const k = [c.pk && "PK", c.ref && "FK"].filter(Boolean).join(",");
  let line = `${c.type} ${name.text}`;
  if (k) line += ` ${k}`;
  if (name.changed) line += ` ${quote(`\`${c.name}\``)}`;
  return line;
}
