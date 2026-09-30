// The diagram viewport: pan and zoom over the rendered SVG, and focus on hover.
//
// Pan and zoom move a CSS transform on a wrapper, so the SVG stays vector-sharp at any scale.
// Conventions follow diagram editors: drag or scroll to pan, pinch or Ctrl/Cmd + scroll to zoom,
// double-click to fit.

const MIN = 0.1;
const MAX = 4;

export class PanZoom {
  scale = 1;
  x = 0;
  y = 0;
  private readonly viewport: HTMLElement;
  private readonly content: HTMLElement;
  private readonly onChange: () => void;
  private width = 0;
  private height = 0;
  private readonly pointers = new Map<number, { x: number; y: number }>();
  private pinch: { dist: number; scale: number } | null = null;
  /** Still fitted: keep fitting when the viewport resizes, until the user pans or zooms */
  private auto = true;

  constructor(viewport: HTMLElement, content: HTMLElement, onChange: () => void) {
    this.viewport = viewport;
    this.content = content;
    this.onChange = onChange;
    viewport.addEventListener("wheel", (e) => this.wheel(e), { passive: false });
    viewport.addEventListener("pointerdown", (e) => this.down(e));
    viewport.addEventListener("pointermove", (e) => this.move(e));
    viewport.addEventListener("pointerup", (e) => this.up(e));
    viewport.addEventListener("pointercancel", (e) => this.up(e));
    viewport.addEventListener("dblclick", (e) => {
      if ((e.target as Element).closest("button")) return;
      this.fit();
    });
    new ResizeObserver(() => {
      if (this.auto) this.fit();
    }).observe(viewport);
  }

  /** The natural size of the current drawing */
  setSize(width: number, height: number): void {
    this.width = width;
    this.height = height;
  }

  fit(): void {
    const vw = this.viewport.clientWidth;
    const vh = this.viewport.clientHeight;
    if (!this.width || !this.height || !vw || !vh) return;
    this.scale = clamp(Math.min(vw / this.width, vh / this.height, 1.25) * 0.92);
    this.x = (vw - this.width * this.scale) / 2;
    this.y = (vh - this.height * this.scale) / 2;
    this.apply();
    this.auto = true;
  }

  /** Zoom by a factor around a point in viewport coordinates (the center by default) */
  zoomBy(factor: number, px = this.viewport.clientWidth / 2, py = this.viewport.clientHeight / 2): void {
    this.auto = false;
    const next = clamp(this.scale * factor);
    const k = next / this.scale;
    this.x = px - (px - this.x) * k;
    this.y = py - (py - this.y) * k;
    this.scale = next;
    this.apply();
  }

  actualSize(): void {
    this.zoomBy(1 / this.scale);
  }

  private apply(): void {
    this.content.style.transform = `translate(${this.x}px, ${this.y}px) scale(${this.scale})`;
    this.onChange();
  }

  private local(e: { clientX: number; clientY: number }): { x: number; y: number } {
    const r = this.viewport.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  private wheel(e: WheelEvent): void {
    e.preventDefault();
    if (e.ctrlKey || e.metaKey) {
      const p = this.local(e);
      this.zoomBy(Math.exp(-e.deltaY * 0.01), p.x, p.y);
    } else {
      this.auto = false;
      this.x -= e.deltaX;
      this.y -= e.deltaY;
      this.apply();
    }
  }

  private down(e: PointerEvent): void {
    if (e.button !== 0 || (e.target as Element).closest("button")) return;
    this.viewport.setPointerCapture(e.pointerId);
    this.pointers.set(e.pointerId, this.local(e));
    if (this.pointers.size === 2) {
      const [a, b] = [...this.pointers.values()];
      this.pinch = { dist: Math.hypot(a.x - b.x, a.y - b.y), scale: this.scale };
    }
    this.viewport.classList.add("is-panning");
  }

  private move(e: PointerEvent): void {
    const prev = this.pointers.get(e.pointerId);
    if (!prev) return;
    const p = this.local(e);
    this.pointers.set(e.pointerId, p);
    if (this.pinch && this.pointers.size === 2) {
      const [a, b] = [...this.pointers.values()];
      const dist = Math.hypot(a.x - b.x, a.y - b.y);
      const target = clamp(this.pinch.scale * (dist / this.pinch.dist));
      this.zoomBy(target / this.scale, (a.x + b.x) / 2, (a.y + b.y) / 2);
      return;
    }
    if (p.x === prev.x && p.y === prev.y) return;
    this.auto = false;
    this.x += p.x - prev.x;
    this.y += p.y - prev.y;
    this.apply();
  }

  private up(e: PointerEvent): void {
    this.pointers.delete(e.pointerId);
    if (this.pointers.size < 2) this.pinch = null;
    if (this.pointers.size === 0) this.viewport.classList.remove("is-panning");
  }
}

const clamp = (s: number): number => Math.min(MAX, Math.max(MIN, s));

/** Hovering a table keeps it and its neighbours; hovering a foreign key row keeps that one relation.
 *  Everything else fades, so focus is shown by dimming rather than by color */
export function bindFocus(svg: SVGSVGElement): void {
  const rels = [...svg.querySelectorAll<SVGGElement>(".rz-r")];
  const tables = [...svg.querySelectorAll<SVGGElement>(".rz-t")];
  const clear = () => {
    svg.classList.remove("is-focus");
    svg.querySelectorAll(".is-on").forEach((el) => el.classList.remove("is-on"));
  };
  const tableEl = (name: string) => tables.find((t) => t.dataset.t === name);
  const markRow = (table: string, column: string) => {
    const t = tableEl(table);
    if (!t) return;
    t.classList.add("is-on");
    [...t.querySelectorAll<SVGGElement>(".rz-c")].find((r) => r.dataset.c === column)?.classList.add("is-on");
  };
  const focusTable = (name: string) => {
    clear();
    svg.classList.add("is-focus");
    const on = new Set([name]);
    for (const r of rels)
      if (r.dataset.a === name || r.dataset.b === name) {
        r.classList.add("is-on");
        on.add(r.dataset.a!);
        on.add(r.dataset.b!);
      }
    on.forEach((n) => tableEl(n)?.classList.add("is-on"));
  };
  const focusRow = (table: string, column: string) => {
    const hits = rels.filter((r) => (r.dataset.b === table && r.dataset.bc === column) || (r.dataset.a === table && r.dataset.ac === column));
    if (!hits.length) return focusTable(table);
    clear();
    svg.classList.add("is-focus");
    for (const r of hits) {
      r.classList.add("is-on");
      markRow(r.dataset.a!, r.dataset.ac!);
      markRow(r.dataset.b!, r.dataset.bc!);
    }
  };
  const apply = (target: Element) => {
    const row = target.closest<SVGGElement>(".rz-c");
    const table = target.closest<SVGGElement>(".rz-t");
    if (row && table) focusRow(table.dataset.t!, row.dataset.c!);
    else if (table) focusTable(table.dataset.t!);
    else clear();
  };
  let lastPointer = "mouse";
  svg.addEventListener("pointerdown", (e) => {
    lastPointer = e.pointerType;
  });
  svg.addEventListener("pointerover", (e) => {
    if (e.pointerType === "mouse") apply(e.target as Element);
  });
  svg.addEventListener("pointerleave", (e) => {
    if (e.pointerType === "mouse") clear();
  });
  svg.addEventListener("click", (e) => {
    if (lastPointer !== "mouse") apply(e.target as Element);
  });
}
