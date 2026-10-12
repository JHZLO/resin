import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Canvas, hitOf } from "./canvas.ts";

/** An element of the drawing: its classes and data, inside a parent */
interface Fake {
  classes: string[];
  dataset: Record<string, string>;
  parent: Fake | null;
}
const fake = (classes: string[], dataset: Record<string, string> = {}, parent: Fake | null = null): Fake => ({ classes, dataset, parent });
/** `closest` for single-class selectors, which is all hitOf asks */
function target(el: Fake): Element {
  const closest = (selector: string): unknown => {
    const wanted = selector.slice(1);
    for (let at: Fake | null = el; at; at = at.parent) if (at.classes.includes(wanted)) return wrap(at);
    return null;
  };
  const wrap = (at: Fake): unknown => ({ dataset: at.dataset, closest: (s: string) => target(at).closest(s) });
  return { closest } as unknown as Element;
}

describe("hitOf", () => {
  const card = fake(["rz-t"], { t: "orders" });
  const head = fake(["rz-head"], {}, card);
  const row = fake(["rz-c"], { c: "user_id" }, card);

  it("tells a table's header from its rows and its body", () => {
    expect(hitOf(target(head))).toEqual({ table: "orders", column: null, rowTable: null, service: null, header: true });
    expect(hitOf(target(row))).toEqual({ table: "orders", column: "user_id", rowTable: null, service: null, header: false });
    expect(hitOf(target(card))).toEqual({ table: "orders", column: null, rowTable: null, service: null, header: false });
  });

  it("reads a folded service's card as the service, and its rows as tables", () => {
    const folded = fake(["rz-t"], { t: "service `ordering`", svc: "ordering" });
    const folderRow = fake(["rz-c"], { c: "orders", table: "ordering.orders" }, folded);
    expect(hitOf(target(fake(["rz-head"], {}, folded)))).toMatchObject({ service: "ordering", header: true });
    expect(hitOf(target(folderRow))).toMatchObject({ service: "ordering", rowTable: "ordering.orders", header: false });
  });

  it("reads the label of a service's area as that service", () => {
    const area = fake(["rz-svc"], { svc: "billing" });
    expect(hitOf(target(fake(["rz-svc-head"], {}, area)))).toEqual({ table: null, column: null, rowTable: null, service: "billing", header: true });
    expect(hitOf(target(fake(["rz-grid"])))).toEqual({ table: null, column: null, rowTable: null, service: null, header: false });
  });
});

class Surface extends EventTarget {
  clientWidth = 1000;
  clientHeight = 800;
  style = { transition: "", transform: "", backgroundColor: "" };
  classes = new Set<string>();
  classList = {
    add: (name: string) => this.classes.add(name),
    remove: (name: string) => this.classes.delete(name),
    toggle: (name: string, on: boolean) => (on ? this.classes.add(name) : this.classes.delete(name)),
  };
  content = Object.assign(new EventTarget(), { style: { transition: "", transform: "" }, replaceChildren: () => {}, querySelector: () => null });
  querySelector(selector: string) { return selector === ":scope > .rz-content" ? this.content : null; }
}

beforeEach(() => {
  vi.stubGlobal("matchMedia", () => ({ matches: false }));
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  vi.stubGlobal("CSS", { escape: (s: string) => s });
});
afterEach(() => vi.unstubAllGlobals());

function setup() {
  const viewport = new Surface();
  const canvas = new Canvas(viewport as unknown as HTMLElement, { live: false });
  return { viewport, canvas };
}

describe("Canvas", () => {
  it("takes the viewport over and draws the still look of its background without the live glass", () => {
    const { viewport, canvas } = setup();
    expect(viewport.classes.has("rz-viewer")).toBe(true);
    expect(canvas.glass).toBeNull();
    expect(canvas.drawOptions()).toEqual({ look: "aurora-light", stage: true });
    canvas.setLook("silk", true);
    expect(canvas.look()).toBe("silk-dark");
    expect(canvas.drawOptions()).toEqual({ look: "silk-dark", stage: true });
  });

  it("brings a table clear of a panel over the right edge, and leaves one already clear where it is", () => {
    const { canvas } = setup();
    canvas.view.setSize(2000, 1000);
    canvas.boxes = [{ table: "orders", x: 1500, y: 400, w: 200, h: 100 }];
    const center = vi.spyOn(canvas.view, "centerOn");
    canvas.reveal("orders", 400, true, false);
    expect(center).toHaveBeenCalledWith(1600, 450, 400, false);
    center.mockClear();
    canvas.boxes = [{ table: "orders", x: 10, y: 10, w: 200, h: 100 }];
    canvas.reveal("orders", 400, true, false);
    expect(center).not.toHaveBeenCalled();
  });

  it("shows and hides the dot grid", () => {
    const { viewport, canvas } = setup();
    canvas.setGrid(true);
    expect(viewport.classes.has("is-grid")).toBe(true);
    canvas.setGrid(false);
    expect(viewport.classes.has("is-grid")).toBe(false);
  });
});
