import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Model, ModelColumn } from "../src/model.ts";
import { columnDetails, serviceDetails, tableDetails } from "./details.ts";

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
    const panel = element(tableDetails(m, "children", vi.fn(), vi.fn(), vi.fn()));
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
    const panel = element(tableDetails(model(), "children", vi.fn(), vi.fn(), vi.fn()));
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
    const panel = element(tableDetails(model(), "children", vi.fn(), pick, vi.fn()));
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

describe("service details", () => {
  const ref = (child: string, childColumn: string, parent: string, kind: "physical" | "logical", one = false) =>
    ({ parent, parentColumn: "id", child, childColumn, kind, one, optional: false, origin: "table" as const });
  const services = (): Model => ({
    services: [{ name: "ordering", description: "Order service" }, { name: "accounts", description: "Accounts service" }],
    tables: [
      { name: "ordering.orders", label: "orders", description: "Orders", origin: "table", service: "ordering", audit: { method: "envers", columns: [] },
        columns: [column("id", { pk: true }), column("user_id"), column("owner_id")], constraints: [] },
      { name: "ordering.items", label: "items", description: null, origin: "table", service: "ordering", audit: null,
        columns: [column("id", { pk: true }), column("order_id")], constraints: [] },
      { name: "accounts.users", label: "users", description: null, origin: "external", service: "accounts", audit: null, columns: [column("id", { pk: true })], constraints: [] },
      { name: "shipments", description: null, origin: "table", service: null, audit: null, columns: [column("id", { pk: true }), column("order_id")], constraints: [] },
    ],
    relations: [
      ref("ordering.orders", "user_id", "accounts.users", "logical"),
      ref("ordering.orders", "owner_id", "accounts.users", "physical"),
      ref("ordering.items", "order_id", "ordering.orders", "physical"),
      ref("shipments", "order_id", "ordering.orders", "physical"),
    ],
  });

  it("answers what the service owns, what it depends on and what uses it", () => {
    const panel = element(serviceDetails(services(), "ordering", vi.fn(), vi.fn(), vi.fn()));
    expect(panel.textContent).toContain("Tables2Depends onaccountsUsed byshipments (no service)");
    expect(panel.textContent).toContain("TableColumnsDescriptionordersENVERS3Ordersitems2");
    // The reference inside the service is left to the panels of its tables
    expect(panel.textContent).not.toContain("items.order_id");
    expect(panel.textContent).toContain("accountsAccounts service2 references");
    expect(panel.textContent).toContain("orders.user_id~>users.idmany-to-one");
    expect(panel.textContent).toContain("No service1 reference");
    expect(panel.textContent).toContain("shipments.order_id->orders.idone-to-many");
  });

  it("marks a foreign key across services, which the checker warns about", () => {
    const panel = element(serviceDetails(services(), "ordering", vi.fn(), vi.fn(), vi.fn()));
    const arrows = descendants(panel).filter((el) => el.className.startsWith("t-arrow"));
    expect(arrows.map((el) => [el.textContent, el.className])).toEqual([
      ["~>", "t-arrow"],
      ["->", "t-arrow is-warn"],
      ["->", "t-arrow"],
    ]);
  });

  it("opens a table, a service, or the referencing column from the rows and names", () => {
    const open = vi.fn();
    const openService = vi.fn();
    const pick = vi.fn();
    const panel = element(serviceDetails(services(), "ordering", open, pick, openService));
    const rows = descendants(panel).filter((el) => el.tag === "tr");
    click(rows.find((el) => el.textContent.startsWith("items"))!);
    expect(open).toHaveBeenLastCalledWith("ordering.items", true);
    click(rows.find((el) => el.textContent.startsWith("orders.owner_id"))!, 0);
    expect(pick).toHaveBeenLastCalledWith("ordering.orders", "owner_id", false);
    click(descendants(panel).find((el) => el.tag === "button" && el.textContent === "accounts")!);
    expect(openService).toHaveBeenLastCalledWith("accounts", true);
    expect(serviceDetails(services(), "missing", vi.fn(), vi.fn(), vi.fn())).toBeNull();
  });
});
