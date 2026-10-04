import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Model, ModelColumn } from "../src/model.ts";
import { columnDetails, tableDetails } from "./details.ts";

/** A DOM boundary for checking generated content and input callbacks without a browser dependency */
class ElementStub extends EventTarget {
  tag: string;
  className = "";
  dataset: Record<string, string> = {};
  children: (ElementStub | string)[] = [];
  scope = "";
  constructor(tag: string) { super(); this.tag = tag; }
  append(...children: (ElementStub | string)[]) { this.children.push(...children); }
  get textContent(): string { return this.children.map((c) => typeof c === "string" ? c : c.textContent).join(""); }
}

let selected: ElementStub | null;
beforeEach(() => {
  selected = null;
  vi.stubGlobal("document", { createElement: (tag: string) => new ElementStub(tag) });
  vi.stubGlobal("getSelection", () => ({
    isCollapsed: selected === null,
    containsNode: (node: ElementStub) => node === selected,
    toString: () => selected ? "selected text" : "",
  }));
});
afterEach(() => vi.unstubAllGlobals());

const column = (name: string, extra: Partial<ModelColumn> = {}): ModelColumn => ({
  name, type: "bigint", nullable: false, pk: false, uk: false, ukName: null,
  enc: false, enumValues: null, index: null, description: null, ref: null, ...extra,
});
function model(): Model {
  return {
    services: [],
    tables: [
      { name: "parents", description: null, origin: "table", service: null, audit: null,
        columns: [column("tenant", { pk: true }), column("id", { pk: true })], constraints: [] },
      { name: "children", description: null, origin: "table", service: null, audit: null,
        columns: [column("id", { pk: true }), column("tenant"), column("parent_id"), column("status", {
          type: "varchar", nullable: true, enc: true, enumValues: ["ready", "done"], description: "<b>literal</b>",
        })], constraints: [{ kind: "index", name: "ix_parent", columns: ["tenant", "parent_id"] }],
        foreignKeys: [{ columns: ["tenant", "parent_id"], target: "parents", targetColumns: ["tenant", "id"], kind: "physical", name: "fk_parent" }] },
    ],
    relations: [{ parent: "parents", parentColumn: "tenant", parentColumns: ["tenant", "id"],
      child: "children", childColumn: "tenant", childColumns: ["tenant", "parent_id"], kind: "physical", one: false, optional: false, origin: "table" }],
  };
}

const element = (el: HTMLElement | null) => el as unknown as ElementStub;
const descendants = (el: ElementStub): ElementStub[] => [el, ...el.children.flatMap((c) => typeof c === "string" ? [] : descendants(c))];
const click = (el: ElementStub, detail = 1) => el.dispatchEvent(Object.assign(new Event("click"), { detail }));

describe("table and column details", () => {
  it("lists complete composite references and gives every member an FK key", () => {
    const m = model();
    const panel = element(tableDetails(m, "children", vi.fn(), vi.fn()));
    const rows = descendants(panel).filter((el) => el.tag === "tr" && ["tenant", "parent_id"].includes(el.dataset.c));
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.textContent.startsWith("FK"))).toBe(true);
    expect(panel.textContent).toContain("tenant, parent_idparents (tenant, id)");
    const pop = element(columnDetails(m, "children", "parent_id", vi.fn()));
    expect(pop.textContent).toContain("Referencesparents (tenant, id), foreign key");
    const parent = element(columnDetails(m, "parents", "id", vi.fn()));
    expect(parent.textContent).toContain("Referenced bychildren (tenant, parent_id)");
    m.relations = [];
    expect(element(columnDetails(m, "children", "parent_id", vi.fn())).textContent).toMatch(/^FK/);
  });

  it("keeps enum, nullity, encryption, index columns, and literal descriptions in the panel", () => {
    const panel = element(tableDetails(model(), "children", vi.fn(), vi.fn()));
    const status = descendants(panel).find((el) => el.dataset.c === "status")!;
    expect(status.textContent).toContain("NULL");
    expect(status.textContent).toContain("<b>literal</b>");
    expect(status.textContent).toContain("values ready/done");
    expect(status.textContent).toContain("stored encrypted");
    expect(panel.textContent).toContain("ix_parenttenant, parent_id");
    expect(descendants(panel).filter((el) => el.tag === "th").every((el) => el.scope === "col")).toBe(true);
  });

  it("ignores selected text only in the clicked row and lets keyboard picks proceed", () => {
    const pick = vi.fn();
    const panel = element(tableDetails(model(), "children", vi.fn(), pick));
    const row = descendants(panel).find((el) => el.dataset.c === "parent_id")!;
    selected = descendants(panel).find((el) => el.dataset.c === "status")!;
    click(row);
    expect(pick).toHaveBeenLastCalledWith("children", "parent_id", true);
    selected = row;
    pick.mockClear();
    click(row);
    expect(pick).not.toHaveBeenCalled();
    click(row, 0);
    expect(pick).toHaveBeenLastCalledWith("children", "parent_id", false);
  });

  it("passes immediate motion for keyboard reference links", () => {
    const open = vi.fn();
    const pop = element(columnDetails(model(), "children", "parent_id", open));
    const link = descendants(pop).find((el) => el.tag === "button" && el.textContent === "parents")!;
    click(link, 0);
    expect(open).toHaveBeenLastCalledWith("parents", false);
    click(link);
    expect(open).toHaveBeenLastCalledWith("parents", true);
  });
});
