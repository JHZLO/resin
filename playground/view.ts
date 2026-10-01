// The diagram viewport: pan and zoom over the rendered SVG, and click-to-focus.
//
// Pan and zoom move a CSS transform on a wrapper, so the SVG stays vector-sharp at any scale.
// The wheel zooms around the pointer, dragging pans, double-click fits. A press that does not move
// is a tap: it is handed to the focus logic, which is why focus does not listen for clicks itself
// (pointer capture during a drag would send those clicks to the viewport anyway).

const MIN = 0.1;
const MAX = 4;
/** Movement in CSS pixels before a press becomes a drag */
const DRAG_THRESHOLD = 4;

export class PanZoom {
  scale = 1;
  x = 0;
  y = 0;
  private readonly viewport: HTMLElement;
  private readonly content: HTMLElement;
  private readonly onChange: (animate: boolean) => void;
  private readonly onTap: (target: Element, x: number, y: number) => void;
  private width = 0;
  private height = 0;
  private readonly pointers = new Map<number, { x: number; y: number }>();
  private pinch: { dist: number; scale: number } | null = null;
  private press: { x: number; y: number; target: Element; dragged: boolean } | null = null;
  /** Still fitted: keep fitting when the viewport resizes, until the user pans or zooms */
  private auto = true;

  constructor(
    viewport: HTMLElement,
    content: HTMLElement,
    onChange: (animate: boolean) => void,
    onTap: (target: Element, x: number, y: number) => void,
  ) {
    this.viewport = viewport;
    this.content = content;
    this.onChange = onChange;
    this.onTap = onTap;
    viewport.addEventListener("wheel", (e) => this.wheel(e), { passive: false });
    viewport.addEventListener("pointerdown", (e) => this.down(e));
    viewport.addEventListener("pointermove", (e) => this.move(e));
    viewport.addEventListener("pointerup", (e) => this.up(e));
    viewport.addEventListener("pointercancel", (e) => this.up(e, true));
    viewport.addEventListener("dblclick", (e) => {
      if (!isControl(e.target)) this.fit(true);
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

  fit(animate = false): void {
    const vw = this.viewport.clientWidth;
    const vh = this.viewport.clientHeight;
    if (!this.width || !this.height || !vw || !vh) return;
    this.scale = clamp(Math.min((vw - 48) / this.width, (vh - 48) / this.height, 1.25));
    this.x = (vw - this.width * this.scale) / 2;
    this.y = (vh - this.height * this.scale) / 2;
    this.apply(animate);
    this.auto = true;
  }

  /** Zoom by a factor around a point in viewport coordinates (the center by default) */
  zoomBy(factor: number, px = this.viewport.clientWidth / 2, py = this.viewport.clientHeight / 2, animate = false): void {
    this.auto = false;
    const next = clamp(this.scale * factor);
    const k = next / this.scale;
    this.x = px - (px - this.x) * k;
    this.y = py - (py - this.y) * k;
    this.scale = next;
    this.apply(animate);
  }

  actualSize(): void {
    this.zoomBy(1 / this.scale, undefined, undefined, true);
  }

  /** Bring a point of the drawing to the middle of what is visible, leaving `right` pixels covered */
  centerOn(cx: number, cy: number, right = 0): void {
    this.auto = false;
    this.x = (this.viewport.clientWidth - right) / 2 - cx * this.scale;
    this.y = this.viewport.clientHeight / 2 - cy * this.scale;
    this.apply(true);
  }

  private apply(animate = false): void {
    const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
    this.content.style.transition = animate && !reduce ? "transform 0.2s cubic-bezier(0.2, 0, 0, 1)" : "none";
    this.content.style.transform = `translate(${this.x}px, ${this.y}px) scale(${this.scale})`;
    this.onChange(animate && !reduce);
  }

  private local(e: { clientX: number; clientY: number }): { x: number; y: number } {
    const r = this.viewport.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  private wheel(e: WheelEvent): void {
    if (isControl(e.target)) return;
    e.preventDefault();
    // Line and page deltas (some mice) become pixels; one event never zooms more than about 20%
    const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? this.viewport.clientHeight : 1;
    const delta = Math.max(-120, Math.min(120, e.deltaY * unit));
    const p = this.local(e);
    // A trackpad pinch arrives as a wheel event with ctrlKey and small deltas
    this.zoomBy(Math.exp(-delta * (e.ctrlKey ? 0.01 : 0.0018)), p.x, p.y);
  }

  private down(e: PointerEvent): void {
    if (e.button !== 0 || isControl(e.target)) return;
    const p = this.local(e);
    this.pointers.set(e.pointerId, p);
    if (this.pointers.size === 1) this.press = { ...p, target: e.target as Element, dragged: false };
    if (this.pointers.size === 2) {
      const [a, b] = [...this.pointers.values()];
      this.pinch = { dist: Math.hypot(a.x - b.x, a.y - b.y), scale: this.scale };
      if (this.press) this.press.dragged = true;
    }
    this.viewport.setPointerCapture(e.pointerId);
  }

  private move(e: PointerEvent): void {
    const prev = this.pointers.get(e.pointerId);
    if (!prev) return;
    const p = this.local(e);
    if (this.pinch && this.pointers.size === 2) {
      this.pointers.set(e.pointerId, p);
      const [a, b] = [...this.pointers.values()];
      const dist = Math.hypot(a.x - b.x, a.y - b.y);
      const target = clamp(this.pinch.scale * (dist / this.pinch.dist));
      this.zoomBy(target / this.scale, (a.x + b.x) / 2, (a.y + b.y) / 2);
      return;
    }
    if (this.press && !this.press.dragged) {
      if (Math.hypot(p.x - this.press.x, p.y - this.press.y) < DRAG_THRESHOLD) return;
      this.press.dragged = true;
      this.viewport.classList.add("is-panning");
    }
    this.pointers.set(e.pointerId, p);
    this.auto = false;
    this.x += p.x - prev.x;
    this.y += p.y - prev.y;
    this.apply();
  }

  private up(e: PointerEvent, cancelled = false): void {
    if (!this.pointers.delete(e.pointerId)) return;
    if (this.pointers.size < 2) this.pinch = null;
    if (this.pointers.size === 0) {
      this.viewport.classList.remove("is-panning");
      const press = this.press;
      this.press = null;
      if (press && !press.dragged && !cancelled) this.onTap(press.target, press.x, press.y);
    }
  }
}

const clamp = (s: number): number => Math.min(MAX, Math.max(MIN, s));
/** Buttons and other controls floating over the canvas handle their own events */
const isControl = (target: EventTarget | null): boolean => target instanceof Element && target.closest("button, a, input, select, label") !== null;

export interface Focus {
  /** Focus a table and the tables it is related to */
  table(name: string): void;
  /** Focus a column: its relations when it has any, otherwise its table. The row itself is marked */
  row(table: string, column: string): void;
  clear(): void;
}

/** Focus keeps the chosen table or relation and fades everything else, so it is shown by dimming
 *  rather than by color */
export function createFocus(svg: SVGSVGElement): Focus {
  const rels = [...svg.querySelectorAll<SVGGElement>(".rz-r")];
  const tables = [...svg.querySelectorAll<SVGGElement>(".rz-t")];
  // A table is its card plus, in a still glass drawing, its shadow
  const parts = [...svg.querySelectorAll<SVGElement>("[data-t]")];

  const clear = () => {
    svg.classList.remove("is-focus");
    svg.querySelectorAll(".is-on").forEach((el) => el.classList.remove("is-on"));
  };
  const tableEl = (name: string) => tables.find((t) => t.dataset.t === name);
  const markTable = (name: string) => {
    for (const p of parts) if (p.dataset.t === name) p.classList.add("is-on");
  };
  const markRow = (table: string, column: string) => {
    const t = tableEl(table);
    if (!t) return;
    markTable(table);
    [...t.querySelectorAll<SVGGElement>(".rz-c")].find((r) => r.dataset.c === column)?.classList.add("is-on");
  };
  const focusTable = (name: string) => {
    svg.classList.add("is-focus");
    const on = new Set([name]);
    for (const r of rels)
      if (r.dataset.a === name || r.dataset.b === name) {
        r.classList.add("is-on");
        on.add(r.dataset.a!);
        on.add(r.dataset.b!);
      }
    on.forEach(markTable);
  };
  const focusRow = (table: string, column: string): boolean => {
    const hits = rels.filter((r) => (r.dataset.b === table && r.dataset.bc === column) || (r.dataset.a === table && r.dataset.ac === column));
    if (!hits.length) return false;
    svg.classList.add("is-focus");
    for (const r of hits) {
      r.classList.add("is-on");
      markRow(r.dataset.a!, r.dataset.ac!);
      markRow(r.dataset.b!, r.dataset.bc!);
    }
    return true;
  };

  return {
    clear,
    table(name) {
      clear();
      focusTable(name);
    },
    row(table, column) {
      clear();
      if (!focusRow(table, column)) focusTable(table);
      markRow(table, column);
    },
  };
}
