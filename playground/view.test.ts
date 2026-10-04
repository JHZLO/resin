import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PanZoom, createFocus } from "./view.ts";

class Surface extends EventTarget {
  clientWidth = 1000;
  clientHeight = 800;
  style = { transition: "", transform: "" };
  private classes = new Set<string>();
  classList = {
    add: (name: string) => this.classes.add(name),
    remove: (name: string) => this.classes.delete(name),
    contains: (name: string) => this.classes.has(name),
  };
  closest() { return null; }
  setPointerCapture() {}
  getBoundingClientRect() { return { left: 0, top: 0 }; }
}

const element = (surface: Surface): HTMLElement => surface as unknown as HTMLElement;
function pointer(surface: Surface, type: string, id: number, x: number, y: number): void {
  surface.dispatchEvent(Object.assign(new Event(type), { pointerId: id, button: 0, clientX: x, clientY: y }));
}

let reduced = false;
let resized: () => void;
beforeEach(() => {
  reduced = false;
  vi.stubGlobal("Element", Surface);
  vi.stubGlobal("matchMedia", () => ({ matches: reduced }));
  vi.stubGlobal("ResizeObserver", class {
    constructor(callback: () => void) { resized = callback; }
    observe() {}
  });
});
afterEach(() => vi.unstubAllGlobals());

function setup() {
  const viewport = new Surface();
  const content = new Surface();
  const changed = vi.fn();
  const tapped = vi.fn();
  const view = new PanZoom(element(viewport), element(content), changed, tapped);
  view.setSize(1200, 900);
  return { viewport, content, changed, tapped, view };
}

describe("PanZoom", () => {
  it("fits a large drawing below ten percent and zooms from that scale without a jump", () => {
    const { view, viewport } = setup();
    view.setSize(100_000, 80_000);
    view.fit();
    expect(view.scale).toBeLessThan(0.1);
    expect(100_000 * view.scale).toBeLessThanOrEqual(viewport.clientWidth - 48);
    expect(80_000 * view.scale).toBeLessThanOrEqual(viewport.clientHeight - 48);
    const fitted = view.scale;
    view.zoomBy(1.25);
    expect(view.scale).toBeCloseTo(fitted * 1.25);
    view.zoomBy(0.01);
    expect(view.scale).toBeCloseTo(fitted);
  });

  it("keeps a positive scale in a viewport smaller than the fit margin", () => {
    const { viewport, view } = setup();
    viewport.clientWidth = 30;
    viewport.clientHeight = 20;
    view.fit();
    expect(view.scale).toBeGreaterThan(0);
    expect(1200 * view.scale).toBeLessThanOrEqual(30);
    expect(900 * view.scale).toBeLessThanOrEqual(20);
  });

  it("keeps the point under the wheel stationary", () => {
    const { viewport, view } = setup();
    view.fit();
    const before = { x: (240 - view.x) / view.scale, y: (150 - view.y) / view.scale };
    const event = Object.assign(new Event("wheel", { cancelable: true }), {
      clientX: 240, clientY: 150, deltaY: -100, deltaMode: 0, ctrlKey: false,
    });
    viewport.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect((240 - view.x) / view.scale).toBeCloseTo(before.x);
    expect((150 - view.y) / view.scale).toBeCloseTo(before.y);
  });

  it("distinguishes taps, drags, cancellation, and lost pointer capture", () => {
    const { viewport, view, tapped } = setup();
    pointer(viewport, "pointerdown", 1, 10, 10);
    pointer(viewport, "pointermove", 1, 13, 10);
    pointer(viewport, "pointerup", 1, 13, 10);
    expect(tapped).toHaveBeenCalledTimes(1);
    pointer(viewport, "pointerdown", 2, 10, 10);
    pointer(viewport, "pointermove", 2, 14, 10);
    expect(viewport.classList.contains("is-panning")).toBe(true);
    pointer(viewport, "pointercancel", 2, 14, 10);
    expect(viewport.classList.contains("is-panning")).toBe(false);
    pointer(viewport, "pointerdown", 3, 20, 20);
    pointer(viewport, "lostpointercapture", 3, 20, 20);
    const x = view.x;
    pointer(viewport, "pointermove", 3, 90, 20);
    pointer(viewport, "pointerup", 3, 90, 20);
    expect(view.x).toBe(x);
    expect(tapped).toHaveBeenCalledTimes(1);
  });

  it("pans with a two-finger midpoint and ignores a third finger until the gesture rebases", () => {
    const { viewport, view, tapped } = setup();
    pointer(viewport, "pointerdown", 1, 100, 100);
    pointer(viewport, "pointerdown", 2, 200, 100);
    pointer(viewport, "pointermove", 1, 120, 100);
    pointer(viewport, "pointermove", 2, 220, 100);
    expect(view.scale).toBeCloseTo(1);
    expect(view.x).toBeCloseTo(20);
    expect(view.y).toBeCloseTo(0);
    pointer(viewport, "pointerdown", 3, 300, 100);
    pointer(viewport, "pointermove", 3, 400, 100);
    expect(view.x).toBeCloseTo(20);
    pointer(viewport, "pointerup", 1, 120, 100);
    const scale = view.scale;
    pointer(viewport, "pointermove", 2, 220, 100);
    expect(view.scale).toBeCloseTo(scale);
    expect(view.x).toBeCloseTo(20);
    pointer(viewport, "pointercancel", 2, 220, 100);
    pointer(viewport, "pointerup", 3, 400, 100);
    expect(tapped).not.toHaveBeenCalled();
  });

  it("keeps coincident touch points finite", () => {
    const { viewport, view } = setup();
    pointer(viewport, "pointerdown", 1, 100, 100);
    pointer(viewport, "pointerdown", 2, 100, 100);
    pointer(viewport, "pointermove", 2, 100, 100);
    expect([view.scale, view.x, view.y].every(Number.isFinite)).toBe(true);
  });

  it("makes keyboard moves immediate and respects reduced motion", () => {
    const { view, changed, content } = setup();
    view.centerOn(400, 300, 200, false);
    expect(changed).toHaveBeenLastCalledWith(false);
    expect(content.style.transition).toBe("none");
    view.actualSize(false);
    expect(changed).toHaveBeenLastCalledWith(false);
    view.centerOn(400, 300);
    expect(changed).toHaveBeenLastCalledWith(true);
    reduced = true;
    view.centerOn(500, 300);
    expect(changed).toHaveBeenLastCalledWith(false);
  });

  it("fits when a hidden viewport appears and preserves a manually chosen view on resize", () => {
    const { viewport, view } = setup();
    viewport.clientWidth = 0;
    view.fit();
    viewport.clientWidth = 1000;
    resized();
    expect(view.scale).toBeLessThan(1);
    view.zoomBy(1.5);
    const before = [view.scale, view.x, view.y];
    viewport.clientWidth = 800;
    resized();
    expect([view.scale, view.x, view.y]).toEqual(before);
  });
});

/** The focus code only reads SVG groups and applies classes; rendering belongs to the SVG tests */
function diagram() {
  const node = (data: Record<string, string>, children: Surface[] = []) => Object.assign(new Surface(), {
    dataset: data,
    querySelectorAll: () => children,
  });
  const parentId = node({ c: "id" });
  const parentTenant = node({ c: "tenant" });
  const childId = node({ c: "id" });
  const childRef = node({ c: "parent_id" });
  const childTenant = node({ c: "tenant" });
  const otherRef = node({ c: "parent_id" });
  const parent = node({ t: "parent" }, [parentId, parentTenant]);
  const child = node({ t: "child" }, [childId, childRef, childTenant]);
  const other = node({ t: "other" }, [otherRef]);
  const shadow = node({ t: "parent" });
  const relation = node({ a: "parent", ac: "id", b: "child", bc: "parent_id" });
  const unrelated = node({ a: "parent", ac: "id", b: "other", bc: "parent_id" });
  const all = [parentId, parentTenant, childId, childRef, childTenant, otherRef, parent, child, other, shadow, relation, unrelated];
  const svg = Object.assign(new Surface(), {
    querySelectorAll: (selector: string) => {
      if (selector === ".rz-r") return [relation, unrelated];
      if (selector === ".rz-t") return [parent, child, other];
      if (selector === "[data-t]") return [parent, child, other, shadow];
      return all.filter((el) => el.classList.contains("is-on"));
    },
  });
  return { svg, parentId, parentTenant, childId, childRef, childTenant, parent, child, other, shadow, relation, unrelated, all, focus: createFocus(svg as unknown as SVGSVGElement) };
}

describe("diagram focus", () => {
  it("keeps only a picked column's relations, endpoint rows, and matching glass shadows active", () => {
    const d = diagram();
    d.focus.row("child", "parent_id");
    expect(d.svg.classList.contains("is-focus")).toBe(true);
    for (const el of [d.parent, d.child, d.parentId, d.childRef, d.shadow, d.relation]) expect(el.classList.contains("is-on")).toBe(true);
    for (const el of [d.other, d.childId, d.unrelated]) expect(el.classList.contains("is-on")).toBe(false);
    d.focus.clear();
    expect(d.svg.classList.contains("is-focus")).toBe(false);
    expect(d.all.some((el) => el.classList.contains("is-on"))).toBe(false);
  });

  it("focuses a plain column's table and its neighbors without pulling in another neighbor's edges", () => {
    const d = diagram();
    d.focus.row("child", "id");
    for (const el of [d.child, d.parent, d.childId, d.relation]) expect(el.classList.contains("is-on")).toBe(true);
    for (const el of [d.other, d.unrelated]) expect(el.classList.contains("is-on")).toBe(false);
  });

  it("clears focus instead of fading the entire drawing when a table is absent", () => {
    const d = diagram();
    d.focus.table("child");
    d.focus.table("hidden_audit");
    expect(d.svg.classList.contains("is-focus")).toBe(false);
    d.focus.row("hidden_audit", "rev");
    expect(d.svg.classList.contains("is-focus")).toBe(false);
    expect(d.all.some((el) => el.classList.contains("is-on"))).toBe(false);
  });

});
