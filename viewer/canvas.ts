// The canvas a page puts a resin drawing on: pan and zoom, focus by dimming, and, where the browser
// has WebGL2, the live glass painted under the cards. It is the playground's own canvas, so a page
// that embeds it shows a schema the way the playground does. The page keeps its own controls and
// panels; it learns what was pressed from `onTap` and answers with the methods below.

import { type SvgBox, type SvgLook, type SvgOptions, type SvgResult, glassOf, serviceCardId, stageOf } from "../src/svg.ts";
import { LiveGlass } from "./glass.ts";
import { type Focus, PanZoom, createFocus } from "./view.ts";

/** The canvas's backgrounds. Each has a dark and a light version */
export type CanvasStage = "aurora" | "silk" | "caustic";
export const CANVAS_STAGES: readonly CanvasStage[] = ["aurora", "silk", "caustic"];

/** What a press on the canvas landed on */
export interface CanvasHit {
  /** The card pressed: a table's, or a folded service's (`serviceCardId(service)`) */
  table: string | null;
  /** The row pressed in that card */
  column: string | null;
  /** In a folded service's card, the table of the row pressed */
  rowTable: string | null;
  /** The service pressed: a folded service's card, or the label of a service's area */
  service: string | null;
  /** The press was on a card's header, or on the label of a service's area */
  header: boolean;
}

export interface CanvasOptions {
  /** A press that did not move */
  onTap?: (hit: CanvasHit, x: number, y: number) => void;
  /** After every move of the view; `animate` is true for an animated one */
  onView?: (animate: boolean) => void;
  /** Paint the background and the glass live with WebGL2 where the browser can (the default). Without
   *  it the drawing carries a still picture of both */
  live?: boolean;
}

/** A drawing that was on the canvas, kept so the page can put it back without drawing it again */
export interface MountedDrawing extends Pick<SvgResult, "width" | "height" | "background" | "boxes"> {
  element: SVGSVGElement | null;
  /** How many elements it has, for a page that limits how many it keeps */
  nodes: number;
}

/** What a press on `target` landed on. Exported for tests; pages read it from `onTap` */
export function hitOf(target: Element): CanvasHit {
  const card = target.closest<SVGGElement>(".rz-t");
  const row = target.closest<SVGGElement>(".rz-c");
  const area = target.closest(".rz-svc-head")?.closest<SVGGElement>(".rz-svc") ?? null;
  const service = card ? card.dataset.svc ?? null : area?.dataset.svc ?? null;
  return {
    table: card?.dataset.t ?? null,
    column: row?.dataset.c ?? null,
    rowTable: row?.dataset.table ?? null,
    service,
    header: target.closest(".rz-head") !== null || (!card && service !== null),
  };
}

export class Canvas {
  readonly viewport: HTMLElement;
  readonly content: HTMLElement;
  readonly view: PanZoom;
  readonly glass: LiveGlass | null = null;
  /** Focus on the drawing now shown */
  focus: Focus | null = null;
  /** Where the cards of the drawing now shown are */
  boxes: SvgBox[] = [];
  private tables = new Map<string, SVGGElement>();
  private stage: CanvasStage = "aurora";
  private dark = false;

  /** Takes over `viewport`: an element the page sizes, which gets `.rz-viewer`. The drawing goes in
   *  its `.rz-content` child, made when there is none */
  constructor(viewport: HTMLElement, options: CanvasOptions = {}) {
    this.viewport = viewport;
    viewport.classList.add("rz-viewer");
    let content = viewport.querySelector<HTMLElement>(":scope > .rz-content");
    if (!content) {
      content = document.createElement("div");
      content.className = "rz-content";
      viewport.prepend(content);
    }
    this.content = content;
    if (options.live !== false && LiveGlass.available()) {
      try {
        this.glass = new LiveGlass(viewport, content);
      } catch (e) {
        console.warn("resin: the live canvas is off, showing the still drawing", e);
        viewport.querySelector(":scope > .stage-glass")?.remove();
      }
    }
    this.view = new PanZoom(
      viewport,
      content,
      (animate) => {
        this.glass?.setView(this.view.scale, this.view.x, this.view.y, animate);
        options.onView?.(animate);
      },
      (target, x, y) => {
        options.onTap?.(hitOf(target), x, y);
        this.glass?.refresh();
        this.glass?.ripple(x, y);
      },
    );
  }

  /** The background: a stage, dark or light. Draw with `drawOptions()` after changing it */
  setLook(stage: CanvasStage, dark: boolean): void {
    this.stage = stage;
    this.dark = dark;
    const look = this.look();
    this.glass?.setLook(stageOf(look), glassOf(look));
  }

  /** The look as a still drawing has it, for exporting what the canvas shows */
  look(): SvgLook {
    return `${this.stage}-${this.dark ? "dark" : "light"}`;
  }

  /** What `toSvg` needs to draw for this canvas. Over the live glass the SVG carries only what sits
   *  on it, in the same ink for every background of a given darkness */
  drawOptions(): Pick<SvgOptions, "look" | "stage"> {
    return this.glass ? { look: this.dark ? "aurora-dark" : "aurora-light", stage: false } : { look: this.look(), stage: true };
  }

  /** Put a drawing on the canvas: a `toSvg` result drawn with `drawOptions()`, or one shown before */
  show(drawing: SvgResult | MountedDrawing, fit = false): MountedDrawing {
    const { width, height, background, boxes } = drawing;
    this.viewport.style.backgroundColor = background ?? "";
    this.focus?.clear();
    if ("svg" in drawing) {
      this.content.innerHTML = drawing.svg;
      // A press on a row opens what the page shows for it; native tooltips would only get in its way
      for (const title of this.content.querySelectorAll(".rz-c > title")) title.remove();
    } else this.content.replaceChildren(...(drawing.element ? [drawing.element] : []));
    const element = this.content.querySelector("svg");
    this.tables = new Map([...this.content.querySelectorAll<SVGGElement>(".rz-t")].map((t) => [t.dataset.t!, t]));
    this.view.setSize(width, height);
    if (fit) this.view.fit();
    this.focus = element ? createFocus(element) : null;
    this.boxes = element ? boxes : [];
    this.glass?.setBoxes(this.boxes, element);
    return { element, width, height, background, boxes, nodes: "nodes" in drawing ? drawing.nodes : this.content.querySelectorAll("*").length };
  }

  /** A card on the drawing: a table's, or a folded service's (`serviceCardId`) */
  card(name: string): SVGGElement | null {
    return this.tables.get(name) ?? null;
  }

  /** A column's row on the drawing */
  row(table: string, column: string): SVGGElement | null {
    return this.tables.get(table)?.querySelector<SVGGElement>(`.rz-c[data-c="${CSS.escape(column)}"]`) ?? null;
  }

  /** Where a table is drawn as a row of a folded service: that service's card and the row */
  foldedRow(table: string): { card: string; row: string } | null {
    const row = this.content.querySelector<SVGGElement>(`.rz-c[data-table="${CSS.escape(table)}"]`);
    const card = row?.closest<SVGGElement>(".rz-t")?.dataset.t;
    return row && card ? { card, row: row.dataset.c! } : null;
  }

  /** Where a service is drawn: its folded card, or its area's label */
  serviceElement(name: string): Element | null {
    return this.content.querySelector(`.rz-t[data-svc="${CSS.escape(name)}"]`) ?? this.content.querySelector(`.rz-svc[data-svc="${CSS.escape(name)}"] .rz-svc-head`);
  }

  /** Focus a table and what it is related to, or its row where its service is folded */
  focusTable(name: string): void {
    const folded = this.foldedRow(name);
    if (folded) this.focus?.row(folded.card, folded.row);
    else this.focus?.table(name);
  }

  /** Focus a service where it is one card; drawn as an area, it has no single thing to keep */
  focusService(name: string): void {
    if (this.tables.has(serviceCardId(name))) this.focus?.table(serviceCardId(name));
    else this.focus?.clear();
  }

  /** Bring a table (or the card its service is folded into) to the middle of what is visible. A
   *  panel over the right edge hides `covered` pixels; with `onlyIfCovered`, a table already clear
   *  of it stays where it is */
  reveal(name: string, covered = 0, onlyIfCovered = false, animate = true): void {
    const drawn = this.foldedRow(name)?.card ?? name;
    const b = this.boxes.find((x) => x.table === drawn);
    if (!b) return;
    const right = this.view.x + (b.x + b.w) * this.view.scale;
    if (onlyIfCovered && right <= this.viewport.clientWidth - covered - 16) return;
    this.view.centerOn(b.x + b.w / 2, b.y + b.h / 2, covered, animate);
  }

  /** Center a part of the drawing in what is visible, unless it is already in plain view */
  revealElement(el: Element | null, covered = 0, animate = true): void {
    if (!el) return;
    const area = this.viewport.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    if (r.left >= area.left + 8 && r.right <= area.right - covered - 8 && r.top >= area.top + 8 && r.bottom <= area.bottom - 8) return;
    const cx = (r.left + r.width / 2 - area.left - this.view.x) / this.view.scale;
    const cy = (r.top + r.height / 2 - area.top - this.view.y) / this.view.scale;
    this.view.centerOn(cx, cy, covered, animate);
  }

  /** The dot grid under the drawing */
  setGrid(on: boolean): void {
    this.viewport.classList.toggle("is-grid", on);
    this.glass?.setGrid(on);
  }

  /** Draw the glass again after the focus changed outside a press; `instant` for keyboard changes */
  refresh(instant = false): void {
    this.glass?.refresh(instant);
  }

  /** Stop drawing while the canvas is out of sight */
  pause(paused: boolean): void {
    this.glass?.pause(paused);
  }

  /** Let go of the viewport: its listeners, the GPU context and the drawing */
  destroy(): void {
    this.view.destroy();
    this.glass?.destroy();
    this.content.replaceChildren();
    this.focus = null;
  }
}
