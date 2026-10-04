import { compile, diff, fromSql, looksLikeSql, type Model } from "../src/index.ts";
import { Documents, type ImportRecord, type LocalDocument } from "./documents.ts";
import type { SharedState } from "./share.ts";
import { addLogicalReferences, assignService, mergeImport, referenceCandidates, relationPath, removeLogicalReference, type Candidate } from "./schema-tools.ts";

interface Host {
  documents: Documents;
  state(): SharedState;
  model(): Model | null;
  open(document: LocalDocument): void;
  edit(source: string): void;
  view(state: Partial<SharedState>): void;
  notify(message: string): void;
  shareReading(): void;
}
const el = <K extends keyof HTMLElementTagNameMap>(tag: K, text = "", className = ""): HTMLElementTagNameMap[K] => {
  const node = document.createElement(tag); node.textContent = text; node.className = className; return node;
};
export function saveFile(contents: BlobPart, name: string, type = "text/plain"): void {
  const url = URL.createObjectURL(new Blob([contents], { type }));
  const a = el("a"); a.href = url; a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export const fileName = (title: string) => (title.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^[-.]+/, "") || "schema").replace(/\.erd$/, "");

/** The existing palette surface, with the same controls and table styling as the inspector. */
export function createWorkspace(host: Host): { show(tab?: string): void; refresh(): void } {
  const dialog = el("dialog", "", "palette workspace");
  dialog.id = "workspace";
  dialog.setAttribute("aria-label", "Schema workspace");
  const header = el("div", "", "ins-bar");
  const title = el("strong", "Workspace", "ins-title");
  const close = button("Close", () => dialog.close(), "btn ghost");
  header.append(title, close);
  const nav = el("div", "", "workspace-actions");
  nav.setAttribute("role", "tablist"); nav.setAttribute("aria-label", "Workspace tools");
  const body = el("div", "", "ins-body workspace-body");
  body.id = "workspace-body"; body.setAttribute("role", "tabpanel");
  const status = el("p", "", "workspace-message");
  status.setAttribute("role", "status");
  let tab = "Documents";
  let returned: HTMLElement | null = null;
  let generation = 0;
  const tabs = ["Documents", "Import", "Explore", "Compare"];
  for (const name of tabs) {
    const b = button(name, () => showTab(name));
    b.setAttribute("role", "tab"); b.setAttribute("aria-controls", body.id); b.id = `workspace-tab-${name.toLowerCase()}`;
    b.addEventListener("keydown", e => {
      if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) return;
      e.preventDefault();
      const i = e.key === "Home" ? 0 : e.key === "End" ? tabs.length - 1 : (tabs.indexOf(name) + (e.key === "ArrowRight" ? 1 : tabs.length - 1)) % tabs.length;
      showTab(tabs[i]); (nav.children[i] as HTMLElement).focus();
    });
    nav.append(b);
  }
  dialog.append(header, nav, body, status);
  document.body.append(dialog);
  dialog.addEventListener("keydown", e => { if (e.key === "Escape") e.stopPropagation(); });
  dialog.addEventListener("close", () => { generation++; returned?.focus(); });
  function message(text: string): void { status.textContent = text; }
  function button(label: string, action: () => void | Promise<void>, cls = "btn"): HTMLButtonElement {
    const b = el("button", label, cls); b.type = "button";
    b.addEventListener("click", () => { Promise.resolve().then(action).catch(e => message(e instanceof Error ? e.message : String(e))); });
    return b;
  }
  function field(label: string, input: HTMLElement): HTMLLabelElement {
    input.setAttribute("aria-label", label);
    const wrapper = el("label", "", "workspace-field"); wrapper.append(el("span", label), input); return wrapper;
  }
  function input(value = "", placeholder = ""): HTMLInputElement { const i = el("input"); i.type = "text"; i.value = value; i.placeholder = placeholder; return i; }
  function select(values: [string, string][], value?: string): HTMLSelectElement {
    const s = el("select"); for (const [key, label] of values) { const o = el("option", label); o.value = key; s.append(o); } if (value !== undefined) s.value = value; return s;
  }
  function actions(...items: HTMLElement[]): HTMLDivElement { const row = el("div", "", "workspace-actions"); row.append(...items); return row; }
  function section(label: string): void { body.append(el("h3", label)); }
  function file(accept: string, action: (name: string, source: string) => void): HTMLInputElement {
    const picker = el("input"); picker.type = "file"; picker.accept = accept;
    picker.addEventListener("change", async () => {
      const picked = picker.files?.[0]; if (!picked) return;
      const current = generation;
      if (picked.size > 10 * 1024 * 1024) { message("Choose a file smaller than 10 MB."); return; }
      try { const source = await picked.text(); if (current === generation && dialog.open) action(picked.name, source); }
      catch { message("The file could not be read. Try opening it again."); }
    }); return picker;
  }
  function showTab(name: string): void {
    if (host.state().reading && (name === "Documents" || name === "Import")) name = "Explore";
    tab = name; generation++;
    body.replaceChildren(); message(host.documents.error ?? "");
    for (const b of nav.querySelectorAll<HTMLButtonElement>("button")) { b.hidden = host.state().reading === true && (b.textContent === "Documents" || b.textContent === "Import"); const on = b.textContent === name; b.setAttribute("aria-selected", String(on)); b.tabIndex = on ? 0 : -1; }
    body.setAttribute("aria-labelledby", `workspace-tab-${name.toLowerCase()}`);
    if (name === "Documents") documents();
    else if (name === "Import") imports();
    else if (name === "Explore") explore();
    else compare();
  }
  function open(d: LocalDocument): void { host.open(d); dialog.close(); }
  function documents(): void {
    const docs = host.documents;
    const active = docs.active;
    const name = input(active.title);
    body.append(field("Document name", name), actions(
      button("Rename", () => { docs.rename(name.value); host.view({}); showTab(tab); }),
      button("New document", () => open(docs.create("Untitled", { ...host.state(), code: "", base: null, related: null, view: {}, reading: false }))),
      button("Download .erd", () => saveFile(host.state().code, `${fileName(docs.active.title)}.erd`)),
      button("Copy reading link", host.shareReading),
    ));
    body.append(field("Open .erd or .sql file", file(".erd,.sql,text/plain", (name, source) => {
      if (looksLikeSql(source)) {
        const result = fromSql(source);
        if (!result.tables) { message(result.notes.map(n => n.message).join("\n") || "No tables found in this SQL."); return; }
        const d = docs.create(name.replace(/\.[^.]+$/, ""), { ...host.state(), code: result.source, base: null, related: null, view: {}, reading: false });
        docs.imported({ sql: source, source: result.source, notes: result.notes }); host.open(d); showTab("Import");
      } else open(docs.create(name.replace(/\.erd$/, ""), { ...host.state(), code: source, base: null, related: null, view: {}, reading: false }));
    })));
    body.append(el("p", "Documents are stored in this browser. Download an .erd file for a portable copy. Shared links open as separate documents.", "workspace-hint"));
    section("Recent documents");
    const list = el("div", "", "workspace-list");
    for (const d of docs.list()) {
      const row = actions(el("span", d.title, "workspace-grow"), el("small", new Date(d.updated).toLocaleString()), button(d.id === active.id ? "Current" : "Open", () => { const next = docs.open(d.id); if (next) open(next); }));
      list.append(row);
    }
    body.append(list);
    section("Recovery history");
    if (!active.revisions.length) body.append(el("p", "Snapshots appear as you edit or replace the source.", "workspace-hint"));
    for (const revision of [...active.revisions].reverse()) body.append(actions(
      el("span", `${new Date(revision.at).toLocaleString()} - ${revision.reason}`, "workspace-grow"),
      button("Restore", () => { const d = docs.restore(revision.at); if (d) open(d); }),
    ));
  }

  function imports(): void {
    const previous = host.documents.active.imported;
    const sql = el("textarea"); sql.rows = 9; sql.spellcheck = false; sql.value = previous?.sql ?? "";
    sql.placeholder = "Paste CREATE TABLE SQL from DataGrip or another database tool";
    const previousDoc = previous ? compile(previous.source).doc : null;
    const assigned = previousDoc?.services.length === 1 && !compile(fromSql(previous!.sql).source).doc.services.length ? previousDoc.services[0].name.text : "";
    const service = input(assigned, "Keep SQL schema services");
    const mode = select([["new", "Open as a new document"], ["add", "Add to this document"], ["refresh", "Update the last imported tables"]], previous ? "refresh" : "new");
    const preview = el("textarea"); preview.rows = 10; preview.spellcheck = false;
    const resultArea = el("div");
    const apply = button("Apply import", () => {
      if (!pending) return;
      const checked = compile(preview.value);
      if (!checked.model) throw new Error(checked.diagnostics.filter(d => d.severity === "error").map(d => `${d.span.line}:${d.span.col} ${d.message}`).join("\n"));
      if (pending.mode === "new") {
        host.open(host.documents.create("Imported schema", { ...host.state(), code: preview.value, base: null, related: null, view: {}, reading: false }));
      } else { host.documents.checkpoint("Before SQL import"); host.edit(preview.value); }
      host.documents.imported(pending.record);
      host.notify("SQL imported. Review logical relation candidates in Explore."); dialog.close();
    });
    apply.disabled = true;
    let pending: { record: ImportRecord; mode: string } | null = null;
    for (const control of [sql, service, mode]) control.addEventListener("input", () => { pending = null; apply.disabled = true; message("Preview the changed SQL before applying it."); });
    body.append(field("SQL source", sql), field("Import .sql file", file(".sql,text/plain", (_name, source) => { sql.value = source; pending = null; apply.disabled = true; })), field("Destination", mode), field("Service for this import (optional)", service));
    body.append(actions(button("Preview import", () => {
      if (mode.value === "refresh" && !previous) throw new Error("There is no previous import for this document. Choose a new document or add tables.");
      const result = fromSql(sql.value);
      resultArea.replaceChildren();
      const notes = [...result.notes.map(n => `SQL ${n.line}:${n.col} - ${n.message}`)];
      if (!result.tables) { message(notes.join("\n") || "No CREATE TABLE statements found."); return; }
      const incoming = assignService(result.source, service.value);
      let source = incoming;
      let changes = 0;
      if (mode.value !== "new") {
        if (mode.value === "add") {
          const before = compile(host.state().code).model;
          const after = compile(incoming).model;
          const duplicates = after?.tables.filter(t => t.origin === "table" && before?.tables.some(o => o.origin === "table" && o.name === t.name));
          if (duplicates?.length) throw new Error(`Tables already exist: ${duplicates.map(t => t.name).join(", ")}. Use update or assign a different service.`);
        }
        const merged = mergeImport(host.state().code, incoming, mode.value === "refresh" ? previous!.source : null);
        source = merged.source; changes = merged.changes.length; notes.push(...merged.notes);
      }
      preview.value = source;
      pending = { record: { sql: sql.value, source: incoming, notes: result.notes }, mode: mode.value };
      apply.disabled = false;
      resultArea.append(el("p", `${result.tables} imported tables, ${notes.length} ${notes.length === 1 ? "note" : "notes"}${mode.value === "new" ? "" : `, ${changes} changes`}`));
      for (const note of notes) resultArea.append(el("p", note, "workspace-hint"));
      message("Review the notes and source before applying. Existing comments are kept above merged source.");
    }), apply));
    body.append(resultArea, field("Resin preview (editable)", preview));
    if (previous) {
      section("Last import notes");
      body.append(el("p", `${previous.notes.length} notes. The SQL source above is the original import.`, "workspace-hint"));
      for (const note of previous.notes) body.append(el("p", `SQL ${note.line}:${note.col} - ${note.message}`, "workspace-hint"));
    }
  }

  function explore(): void {
    const state = host.state();
    const model = compile(state.code).model;
    if (!model) { body.append(el("p", "Fix the source errors before exploring relations.")); return; }
    const tables = model.tables.filter(t => t.origin !== "audit").map(t => [t.name, t.name] as [string, string]);
    section("Related tables");
    const start = select(tables, state.related?.table);
    const direction = select([["both", "All directions"], ["outgoing", "Outgoing references"], ["incoming", "Incoming references"]], state.view?.direction ?? "both");
    const steps = select([["1", "1 step"], ["2", "2 steps"]], String(state.related?.steps ?? 1));
    direction.setAttribute("aria-label", "Reference direction"); steps.setAttribute("aria-label", "Reference distance");
    body.append(field("Table", start), actions(direction, steps, button("Show related", () => { host.view({ related: { table: start.value, steps: steps.value === "2" ? 2 : 1 }, view: { ...state.view, direction: direction.value as "both", path: undefined } }); dialog.close(); }), button("Show all", () => { host.view({ related: null, view: {} }); dialog.close(); })));
    section("Find a relationship path");
    const from = select(tables, state.view?.path?.[0]); const to = select(tables, state.view?.path?.[1] ?? tables[1]?.[0]);
    body.append(field("From table", from), field("To table", to), actions(button("Show path", () => {
      const path = relationPath(model, from.value, to.value); if (!path) { message("No relationship path connects these tables."); return; }
      host.view({ related: null, view: { path: [from.value, to.value] } }); dialog.close(); host.notify(path.join(" → "));
    })));
    if (model.services.length) {
      section("Visible services");
      const chosen = new Set(state.view?.services ?? model.services.map(s => s.name));
      for (const service of model.services) {
        const check = el("input"); check.type = "checkbox"; check.checked = chosen.has(service.name);
        check.addEventListener("change", () => check.checked ? chosen.add(service.name) : chosen.delete(service.name));
        const label = el("label", "", "workspace-choice"); label.append(check, service.name); body.append(label);
      }
      body.append(actions(button("Apply service filter", () => { host.view({ view: { ...state.view, services: [...chosen] } }); dialog.close(); })));
    }
    section("Saved views");
    const name = input("", "View name"); name.setAttribute("aria-label", "View name");
    body.append(actions(name, button("Save current view", () => { host.documents.saveView(name.value, state); showTab(tab); })));
    for (const view of host.documents.active.views) body.append(actions(el("span", view.name, "workspace-grow"), button("Load view", () => { host.view({ ...view.state, reading: false }); dialog.close(); })));
    if (state.reading) return;
    section("Logical relation candidates");
    const candidates = referenceCandidates(model);
    const selected = new Map<string, Candidate>();
    body.append(el("p", "These are name and type matches, not database constraints. Select the relations to add as logical references (~>).", "workspace-hint"));
    if (!candidates.length) body.append(el("p", "No unlinked *_id columns have a matching primary key.", "workspace-hint"));
    for (const c of candidates) {
      const check = el("input"); check.type = "checkbox";
      const key = `${c.child}\0${c.column}`;
      check.addEventListener("change", () => {
        if (check.checked && selected.has(key)) { check.checked = false; message("Choose only one target per source column."); return; }
        if (check.checked) selected.set(key, c); else selected.delete(key);
      });
      const label = el("label", "", "workspace-choice"); label.append(check, `${c.child}.${c.column} → ${c.parent}.${c.target}`, el("small", c.reason)); body.append(label);
    }
    body.append(actions(button("Add selected relations", () => { if (!selected.size) { message("Select at least one candidate."); return; } host.documents.checkpoint("Before adding logical references"); host.edit(addLogicalReferences(state.code, [...selected.values()])); showTab(tab); })));
    section("Existing logical relations");
    for (const r of model.relations.filter(r => r.kind === "logical" && !r.childColumns && r.origin !== "audit")) body.append(actions(
      el("span", `${r.child}.${r.childColumn} → ${r.parent}.${r.parentColumn}`, "workspace-grow"),
      button("Remove", () => { host.documents.checkpoint("Before removing a logical reference"); host.edit(removeLogicalReference(state.code, r.child, r.childColumn)); showTab(tab); }),
    ));
    section("Add or edit a logical relation");
    const child = select(tables); const parent = select(tables);
    const childCol = select([]); const parentCol = select([]);
    const columns = (table: HTMLSelectElement, column: HTMLSelectElement) => {
      column.replaceChildren(...(model.tables.find(t => t.name === table.value)?.columns ?? []).map(c => { const o = el("option", c.name); o.value = c.name; return o; }));
    };
    child.addEventListener("change", () => columns(child, childCol)); parent.addEventListener("change", () => columns(parent, parentCol)); columns(child, childCol); columns(parent, parentCol);
    body.append(field("Source table", child), field("Source column", childCol), field("Target table", parent), field("Target column", parentCol), actions(button("Save logical relation", () => {
      host.documents.checkpoint("Before adding a logical reference");
      host.edit(addLogicalReferences(state.code, [{ child: child.value, column: childCol.value, parent: parent.value, target: parentCol.value, reason: "Manual" }], true)); showTab(tab);
    })));
  }

  function compare(): void {
    const base = el("textarea"); base.rows = 10; base.spellcheck = false; base.value = host.state().base ?? "";
    body.append(el("p", "Compare an older .erd or .sql file with the current document. The current source remains editable.", "workspace-hint"));
    body.append(field("Older version", base), field("Open baseline file", file(".erd,.sql,text/plain", (_name, source) => {
      const converted = looksLikeSql(source) ? fromSql(source) : null; base.value = converted?.source ?? source;
      message(converted ? converted.notes.map(n => `SQL ${n.line}:${n.col} - ${n.message}`).join("\n") : "Baseline loaded.");
    })));
    const changed = el("input"); changed.type = "checkbox"; changed.checked = host.state().view?.changesOnly ?? false;
    const label = el("label", "", "workspace-choice"); label.append(changed, "Show changed tables and their neighbors only"); body.append(label);
    const summary = el("div");
    body.append(actions(button("Compare versions", () => {
      const before = compile(base.value); const after = compile(host.state().code);
      if (!before.model || !after.model) throw new Error("Both versions must compile. Check the baseline and current source.");
      const comparison = diff(before.model, after.model);
      summary.replaceChildren(...comparison.changes.map(c => el("p", `${c.kind}: ${c.table}${c.column ? `.${c.column}` : ""}${c.details.length ? ` - ${c.details.join(", ")}` : ""}`, "workspace-hint")));
      host.view({ base: base.value, related: null, view: { changesOnly: changed.checked } });
      message(`${comparison.changes.length} changes. Close this panel to inspect the diagram.`);
    }), button("Stop comparing", () => { host.view({ base: null, view: {} }); dialog.close(); }), button("Copy reading link", host.shareReading)));
    body.append(summary);
  }
  return {
    show(name = tab) { returned = document.activeElement as HTMLElement; showTab(name); if (!dialog.open) dialog.showModal(); close.focus(); },
    refresh() { if (dialog.open) showTab(tab); },
  };
}
