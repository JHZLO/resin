import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cardParts } from "./parts.ts";

/** Just enough of the DOM to read what was built and to press its buttons */
class ElementStub extends EventTarget {
  tag: string;
  className = "";
  type = "";
  title = "";
  dataset: Record<string, string> = {};
  attributes: Record<string, string> = {};
  children: ElementStub[] = [];
  text = "";
  constructor(tag: string) { super(); this.tag = tag; }
  append(...children: ElementStub[]) { this.children.push(...children); }
  setAttribute(name: string, value: string) { this.attributes[name] = value; }
  set textContent(value: string) { this.text = value; }
  get textContent(): string { return this.text + this.children.map((c) => c.textContent).join(""); }
}

beforeEach(() => vi.stubGlobal("document", { createElement: (tag: string) => new ElementStub(tag) }));
afterEach(() => vi.unstubAllGlobals());

describe("cardParts", () => {
  it("lays out a sample row in the card's order, the name not a button", () => {
    const row = cardParts(new Set(), () => {}) as unknown as ElementStub;
    expect(row.className).toBe("rz-parts");
    expect(row.children.map((c) => `${c.tag}:${c.dataset.part ?? "name"}`)).toEqual([
      "button:keys", "span:name", "button:tags", "button:descriptions", "button:types", "button:nulls",
    ]);
    expect(row.children.map((c) => c.textContent)).toEqual(["KeyFK", "Columncustomer_id", "TagsIX", "DescriptionCustomer", "Typebigint", "NullNULL"]);
  });

  it("says which parts are hidden, and hands the part pressed to the page", () => {
    const toggle = vi.fn();
    const row = cardParts(new Set(["types"]), toggle) as unknown as ElementStub;
    const types = row.children.find((c) => c.dataset.part === "types")!;
    const keys = row.children.find((c) => c.dataset.part === "keys")!;
    expect(types.attributes["aria-pressed"]).toBe("false");
    expect(types.title).toBe("Show the types");
    expect(keys.attributes["aria-pressed"]).toBe("true");
    expect(keys.title).toBe("Leave out the key labels");
    types.dispatchEvent(new Event("click"));
    expect(toggle).toHaveBeenCalledWith("types");
  });
});
