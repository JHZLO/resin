// The playground app: an editor on the left, the diagram on the right, both kept in sync.
// Every change recompiles; errors show up as lint marks and in the problems list, and the diagram
// keeps the last valid drawing (dimmed) until the source compiles again.

import ELK from "elkjs/lib/elk.bundled.js";
import orderExample from "../examples/order.erd";
import shopExample from "../examples/shop.erd";
import { type Diagnostic, type Model, type SvgLook, compile, toSvg } from "../src/index.ts";
import { GRID_STEP, type Ink, type SvgBox, stageOf } from "../src/svg.ts";
import { columnDetails, tableDetails } from "./details.ts";
import { createEditor } from "./editor.ts";
import { type SharedState, decode, encode } from "./share.ts";
import { type Focus, PanZoom, createFocus } from "./view.ts";

const EXAMPLES: Record<string, string> = {
  order: orderExample,
  shop: shopExample,
  blank: 'table things "Start here" {\n  id    bigint       pk\n  name  varchar(100)\n}\n',
};
const STORE = "resin.playground";
const THEME_STORE = "resin.theme";
const EDITOR_STORE = "resin.editor";

const byId = <T extends HTMLElement = HTMLElement>(id: string): T => document.getElementById(id) as T;

const state: SharedState & { grid: boolean } = { code: EXAMPLES.order, columns: "all", audit: "collapse", edges: "angular", grid: true };
const elk = new ELK();

let lastModel: Model | null = null;
let focus: Focus | null = null;
let lastMermaid = "";
let renderSeq = 0;
let fitNext = true;
let lastBoxes: SvgBox[] = [];

// ---- persistence ----

function load(): Partial<typeof state> | null {
  try {
    const raw = localStorage.getItem(STORE);
    return raw ? (JSON.parse(raw) as Partial<typeof state>) : null;
  } catch {
    return null;
  }
}

function save(): void {
  try {
    localStorage.setItem(STORE, JSON.stringify(state));
  } catch {
    /* private mode or storage disabled: the URL still carries the state */
  }
}

let hashTimer = 0;
function scheduleHash(): void {
  clearTimeout(hashTimer);
  hashTimer = window.setTimeout(writeHash, 400);
}
async function writeHash(): Promise<void> {
  const hash = await encode({ code: state.code, columns: state.columns, audit: state.audit, edges: state.edges });
  if (location.hash !== hash) history.replaceState(null, "", hash);
}

// ---- toast ----

let toastTimer = 0;
function toast(message: string): void {
  const el = byId("toast");
  el.textContent = message;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => {
    el.hidden = true;
  }, 1800);
}

async function copy(text: string, done: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    toast(done);
  } catch {
    toast("This browser blocked the clipboard");
  }
}

// ---- problems ----

let problems: Diagnostic[] = [];

function showProblems(ds: Diagnostic[]): void {
  problems = ds;
  const errors = ds.filter((d) => d.severity === "error").length;
  const warnings = ds.length - errors;
  const count = byId("problem-count");
  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
  count.textContent = ds.length === 0 ? "No problems" : [errors && plural(errors, "error"), warnings && plural(warnings, "warning")].filter(Boolean).join(", ");
  count.dataset.state = errors ? "error" : warnings ? "warning" : "ok";

  const list = byId("problems");
  list.replaceChildren(
    ...ds.map((d) => {
      const li = document.createElement("li");
      const button = document.createElement("button");
      button.type = "button";
      button.className = `problem is-${d.severity}`;
      const where = document.createElement("span");
      where.className = "problem-where";
      where.textContent = `${d.span.line}:${d.span.col}`;
      const text = document.createElement("span");
      text.className = "problem-text";
      text.textContent = d.message;
      button.append(where, text);
      if (d.hint) {
        const hint = document.createElement("span");
        hint.className = "problem-hint";
        hint.textContent = d.hint;
        button.append(hint);
      }
      button.addEventListener("click", () => editor.focusAt(d.span.line, d.span.col));
      li.append(button);
      return li;
    }),
  );
  list.hidden = ds.length === 0;
}

// ---- the canvas ----

const viewport = byId("viewport");
const content = byId("content");
const gridLayer = byId("grid-layer");
const zoomLevel = byId("zoom-level");

/** The dot grid lies on the drawing's plane: it pans and zooms with the drawing. Zoomed far out, it
 *  skips every other dot so it never turns into a texture */
function placeGrid(animate: boolean): void {
  let step = GRID_STEP * panzoom.scale;
  while (step < 12) step *= 2;
  gridLayer.classList.toggle("is-moving", animate);
  gridLayer.style.backgroundSize = `${step}px ${step}px`;
  gridLayer.style.backgroundPosition = `${panzoom.x - step / 2}px ${panzoom.y - step / 2}px`;
}

const panzoom = new PanZoom(
  viewport,
  content,
  (animate) => {
    zoomLevel.textContent = `${Math.round(panzoom.scale * 100)}%`;
    placeGrid(animate);
    // The popover rides along with its row; after an animated move, place it again once settled
    placePop();
    if (animate) window.setTimeout(placePop, 220);
  },
  (target) => {
    const table = target.closest<SVGGElement>(".rz-t")?.dataset.t ?? null;
    const column = target.closest<SVGGElement>(".rz-c")?.dataset.c ?? null;
    if (table && column) pickColumn(table, column);
    else if (table && target.closest(".rz-head")) pickTable(table);
    else if (table) {
      closePop();
      focus?.table(table);
    } else {
      closePop();
      if (inspected) focus?.table(inspected);
      else focus?.clear();
    }
  },
);

placeGrid(false);

/** The canvas is painted by the page, from the same stage the files use, so it can reach past the
 *  drawing. It changes together with the cards, once they are drawn in the new look */
const rgba = ([color, alpha]: Ink): string => {
  const n = parseInt(color.slice(1), 16);
  return `rgba(${n >> 16}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
};
function paintStage(look: SvgLook): void {
  const stage = stageOf(look);
  if (!stage) return;
  viewport.style.setProperty("--canvas", stage.base);
  viewport.style.setProperty("--glow", rgba([stage.glow[0], stage.glow[1]]));
  viewport.style.setProperty("--dot", rgba(stage.grid));
}

// ---- details: the table panel and the column popover ----

const diagramPanel = byId("panel-diagram");
const inspector = byId("inspector");
const inspectorBody = byId("inspector-body");
const pop = byId("pop");
/** The table in the side panel, and the column in the popover */
let inspected: string | null = null;
let popped: { table: string; column: string } | null = null;

const inspectorOpen = (): boolean => inspector.hasAttribute("data-open");

const rowEl = (table: string, column: string): SVGGElement | null =>
  [...content.querySelectorAll<SVGGElement>(".rz-t")]
    .find((t) => t.dataset.t === table)
    ?.querySelector<SVGGElement>(`.rz-c[data-c="${CSS.escape(column)}"]`) ?? null;

/** Bring a table to the middle of what the side panel leaves visible */
function reveal(name: string, onlyIfCovered = false): void {
  const b = lastBoxes.find((x) => x.table === name);
  if (!b) return;
  const covered = inspectorOpen() ? inspector.offsetWidth : 0;
  const right = panzoom.x + (b.x + b.w) * panzoom.scale;
  if (onlyIfCovered && right <= viewport.clientWidth - covered - 16) return;
  panzoom.centerOn(b.x + b.w / 2, b.y + b.h / 2, covered);
}

/** Open a table in the side panel, focus it, and bring it into view */
function openTable(name: string): void {
  closePop();
  showInspector(name);
  focus?.table(name);
  reveal(name);
}

/** A table name on the diagram: opens its panel, or closes it when it is already open */
function pickTable(name: string): void {
  closePop();
  if (inspected === name && inspectorOpen()) {
    closeInspector();
    focus?.clear();
    return;
  }
  showInspector(name);
  focus?.table(name);
  // The panel opens over the canvas: keep the table that was clicked in view
  reveal(name, true);
}

/** A column on the diagram (or in the panel): shows its popover, or closes it when it is already open */
function pickColumn(table: string, column: string): void {
  if (popped && popped.table === table && popped.column === column && !pop.hidden) {
    closePop();
    if (inspected) focus?.table(inspected);
    else focus?.clear();
    return;
  }
  focus?.row(table, column);
  showPop(table, column);
}

function showInspector(name: string): void {
  const view = lastModel ? tableDetails(lastModel, name, openTable, pickColumn) : null;
  if (!view) return closeInspector();
  inspected = name;
  inspectorBody.replaceChildren(view);
  byId("inspector-title").textContent = name;
  inspector.setAttribute("data-open", "");
  inspector.inert = false;
  diagramPanel.classList.add("has-inspector");
}

function closeInspector(): void {
  inspected = null;
  inspector.removeAttribute("data-open");
  inspector.inert = true;
  diagramPanel.classList.remove("has-inspector");
}

function showPop(table: string, column: string): void {
  const view = lastModel ? columnDetails(lastModel, table, column, openTable) : null;
  if (!view || !rowEl(table, column)) return closePop();
  popped = { table, column };
  pop.replaceChildren(view);
  pop.hidden = false;
  placePop();
}

function closePop(): void {
  popped = null;
  pop.hidden = true;
}

/** Under its row, or above it when there is no room below; hidden while the row is out of view.
 *  It grows from the corner nearest its row */
function placePop(): void {
  if (!popped || pop.hidden) return;
  const row = rowEl(popped.table, popped.column);
  if (!row) return closePop();
  const area = diagramPanel.getBoundingClientRect();
  const r = row.getBoundingClientRect();
  const right = area.width - (inspectorOpen() ? inspector.offsetWidth : 0) - 8;
  const w = pop.offsetWidth;
  const h = pop.offsetHeight;
  const left = Math.max(8, Math.min(r.left - area.left + 12, right - w));
  let top = r.bottom - area.top + 6;
  const above = top + h > area.height - 8 && r.top - area.top - h - 6 > 8;
  if (above) top = r.top - area.top - h - 6;
  const seen = r.bottom > area.top && r.top < area.bottom && r.right > area.left && r.left - area.left < right;
  pop.style.visibility = seen ? "" : "hidden";
  pop.style.transformOrigin = above ? "bottom left" : "top left";
  pop.style.translate = `${Math.round(left)}px ${Math.round(top)}px`;
}

byId("inspector-close").addEventListener("click", () => {
  closeInspector();
  focus?.clear();
});

const isDark = (): boolean => {
  const set = document.documentElement.dataset.theme;
  return set ? set === "dark" : matchMedia("(prefers-color-scheme: dark)").matches;
};
/** The canvas follows the page: dark or light */
const canvasLook = (): SvgLook => (isDark() ? "dark" : "light");

function setStale(stale: boolean): void {
  byId("stale").hidden = !stale || !lastModel;
  viewport.classList.toggle("is-stale", stale && lastModel !== null);
}

async function render(): Promise<void> {
  const seq = ++renderSeq;
  const result = compile(state.code);
  editor.showDiagnostics(result.diagnostics);
  showProblems(result.diagnostics);
  if (!result.model) {
    setStale(true);
    return;
  }
  try {
    const look = canvasLook();
    const { svg, width, height, boxes } = await toSvg(result.model, elk, {
      columns: state.columns,
      audit: state.audit,
      look,
      stage: false,
      edges: state.edges,
      idPrefix: "pg-",
    });
    if (seq !== renderSeq) return; // a newer render has started
    paintStage(look);
    lastModel = result.model;
    lastMermaid = result.mermaid ?? "";
    byId("mermaid-out").textContent = lastMermaid;
    const empty = result.model.tables.length === 0;
    byId("empty").hidden = !empty;
    content.innerHTML = empty ? "" : svg;
    panzoom.setSize(width, height);
    if (fitNext) {
      panzoom.fit();
      fitNext = false;
    }
    const drawn = content.querySelector("svg");
    // Rows open a popover on click; their native tooltips would only get in its way
    for (const title of content.querySelectorAll(".rz-c > title")) title.remove();
    focus = drawn ? createFocus(drawn) : null;
    lastBoxes = empty ? [] : boxes;
    // Keep what was open, as long as it still exists
    if (inspected) showInspector(inspected);
    if (popped) showPop(popped.table, popped.column);
    if (popped) focus?.row(popped.table, popped.column);
    else if (inspected) focus?.table(inspected);
    const tables = result.model.tables.filter((t) => state.audit === "expand" || t.origin !== "audit").length;
    const relations = result.model.relations.filter((r) => state.audit === "expand" || r.origin !== "audit").length;
    byId("stats").textContent = empty ? "" : `${tables} ${tables === 1 ? "table" : "tables"}, ${relations} ${relations === 1 ? "relation" : "relations"}`;
    setStale(false);
  } catch (e) {
    console.error(e);
    setStale(true);
  }
}

let renderTimer = 0;
function scheduleRender(): void {
  clearTimeout(renderTimer);
  renderTimer = window.setTimeout(render, 120);
}

// ---- menus ----

/** A small menu under its button. A press anywhere else closes it, so does Escape (focus goes back
 *  to the button) and so does tabbing out of it */
function menu(button: HTMLElement, panel: HTMLElement, first: () => HTMLElement | null) {
  const wrap = button.parentElement!;
  const set = (open: boolean, returnFocus = false) => {
    panel.hidden = !open;
    button.setAttribute("aria-expanded", String(open));
    if (open) first()?.focus();
    else if (returnFocus) button.focus();
  };
  button.addEventListener("click", () => set(panel.hidden));
  panel.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    e.stopPropagation();
    set(false, true);
  });
  wrap.addEventListener("focusout", (e) => {
    if (!panel.hidden && !wrap.contains(e.relatedTarget as Node | null) && e.relatedTarget !== null) set(false);
  });
  document.addEventListener("pointerdown", (e) => {
    if (!panel.hidden && !wrap.contains(e.target as Node)) set(false);
  });
  return { close: (returnFocus = false) => set(false, returnFocus), isOpen: () => !panel.hidden };
}

// View: every option that changes the drawing, in one place
const viewMenu = menu(byId("view"), byId("view-menu"), () => byId("view-menu").querySelector<HTMLElement>('[aria-pressed="true"]'));
const setters = [...document.querySelectorAll<HTMLButtonElement>("[data-set]")];

function syncControls(): void {
  const current: Record<string, string> = { columns: state.columns, audit: state.audit, edges: state.edges, grid: state.grid ? "on" : "off" };
  for (const b of setters) {
    const [key, value] = b.dataset.set!.split(":");
    b.setAttribute("aria-pressed", String(current[key] === value));
  }
  viewport.classList.toggle("grid", state.grid);
  const select = byId<HTMLSelectElement>("example");
  const match = Object.entries(EXAMPLES).find(([, text]) => text === state.code);
  select.value = match ? match[0] : "";
}

for (const b of setters)
  b.addEventListener("click", () => {
    const [key, value] = b.dataset.set!.split(":");
    if (key === "grid") state.grid = value === "on";
    else if (key === "edges") state.edges = value === "curved" ? "curved" : "angular";
    else if (key === "columns") state.columns = value === "keys" ? "keys" : "all";
    else if (key === "audit") state.audit = value === "expand" ? "expand" : "collapse";
    syncControls();
    save();
    if (key === "grid") return;
    scheduleHash();
    // Fewer or more tables move the layout, so the drawing is fitted again. Lines keep the layout
    if (key === "columns" || key === "audit") fitNext = true;
    render();
  });

// Download: plain, or on a dark or a light background
const downloadMenu = menu(byId("download"), byId("download-menu"), () => byId("download-menu").querySelector<HTMLElement>(".menu-item"));
const menuItems = [...byId("download-menu").querySelectorAll<HTMLButtonElement>("[data-variant]")];
byId("download-menu").addEventListener("keydown", (e) => {
  if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
  e.preventDefault();
  const i = menuItems.indexOf(document.activeElement as HTMLButtonElement);
  const next = e.key === "ArrowDown" ? i + 1 : Math.max(i, 0) - 1;
  menuItems[(next + menuItems.length) % menuItems.length].focus();
});

/** Files are plain by default: no background, so they sit on any page. Dark and light carry their
 *  background with them */
async function exportSvg(look: SvgLook): Promise<string | null> {
  if (!lastModel) return null;
  const { svg } = await toSvg(lastModel, elk, { columns: state.columns, audit: state.audit, edges: state.edges, look, standalone: true });
  return svg + "\n";
}

async function download(look: SvgLook): Promise<void> {
  const svg = await exportSvg(look);
  if (!svg) return;
  const url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = look === "plain" ? "schema.svg" : `schema.${look}.svg`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

for (const item of menuItems)
  item.addEventListener("click", () => {
    downloadMenu.close(true);
    const variant = item.dataset.variant;
    download(variant === "dark" || variant === "light" ? variant : "plain");
  });

byId("copy-svg").addEventListener("click", async () => {
  const svg = await exportSvg("plain");
  if (svg) await copy(svg, "SVG copied");
});

// ---- other controls ----

byId<HTMLSelectElement>("example").addEventListener("change", (e) => {
  const key = (e.target as HTMLSelectElement).value;
  if (!EXAMPLES[key]) return;
  fitNext = true;
  editor.setText(EXAMPLES[key]);
});

byId("zoom-in").addEventListener("click", () => panzoom.zoomBy(1.25, undefined, undefined, true));
byId("zoom-out").addEventListener("click", () => panzoom.zoomBy(0.8, undefined, undefined, true));
byId("zoom-level").addEventListener("click", () => panzoom.actualSize());
byId("zoom-fit").addEventListener("click", () => panzoom.fit(true));

/** Keyboard actions never animate: the change lands at once */
function instantly(change: () => void): void {
  diagramPanel.classList.add("is-instant");
  change();
  void diagramPanel.offsetWidth; // apply the change while transitions are off
  diagramPanel.classList.remove("is-instant");
}

// Escape closes the innermost thing that is open: a menu, then the popover, then the panel
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  if (viewMenu.isOpen()) return viewMenu.close(true);
  if (downloadMenu.isOpen()) return downloadMenu.close(true);
  instantly(() => {
    if (!pop.hidden) {
      closePop();
      if (inspected) return focus?.table(inspected);
    } else if (inspectorOpen()) closeInspector();
    focus?.clear();
  });
});

byId("share").addEventListener("click", async () => {
  await writeHash();
  await copy(location.href, "Link copied");
});

byId("copy-mermaid").addEventListener("click", () => copy(lastMermaid, "Mermaid copied"));

// Tabs
const tabs = [byId("tab-diagram"), byId("tab-mermaid")];
for (const tab of tabs)
  tab.addEventListener("click", () => {
    for (const t of tabs) {
      const on = t === tab;
      t.setAttribute("aria-selected", String(on));
      byId(t.getAttribute("aria-controls")!).hidden = !on;
    }
  });

// Theme: auto, light, dark
const THEMES = ["auto", "light", "dark"] as const;
function applyTheme(theme: (typeof THEMES)[number]): void {
  if (theme === "auto") delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = theme;
  const button = byId("theme");
  button.dataset.mode = theme;
  button.setAttribute("aria-label", `Theme: ${theme}`);
  button.title = `Theme: ${theme}`;
}
let theme: (typeof THEMES)[number] = "auto";
try {
  const saved = localStorage.getItem(THEME_STORE);
  if (saved === "light" || saved === "dark") theme = saved;
} catch {
  /* keep auto */
}
applyTheme(theme);
byId("theme").addEventListener("click", () => {
  theme = THEMES[(THEMES.indexOf(theme) + 1) % THEMES.length];
  applyTheme(theme);
  try {
    if (theme === "auto") localStorage.removeItem(THEME_STORE);
    else localStorage.setItem(THEME_STORE, theme);
  } catch {
    /* the choice lasts for this visit */
  }
  render(); // the cards follow the theme
});
matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
  if (theme === "auto") render();
});

// Splitter between the panes
const work = byId("work");
const splitter = byId("splitter");
splitter.addEventListener("pointerdown", (e) => {
  splitter.setPointerCapture(e.pointerId);
  const onMove = (m: PointerEvent) => {
    const r = work.getBoundingClientRect();
    const pct = Math.min(75, Math.max(20, ((m.clientX - r.left) / r.width) * 100));
    work.style.setProperty("--split", `${pct}%`);
  };
  const onUp = () => {
    splitter.removeEventListener("pointermove", onMove);
    splitter.removeEventListener("pointerup", onUp);
  };
  splitter.addEventListener("pointermove", onMove);
  splitter.addEventListener("pointerup", onUp);
});
splitter.addEventListener("keydown", (e) => {
  if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
  const current = parseFloat(getComputedStyle(work).getPropertyValue("--split")) || 42;
  const next = Math.min(75, Math.max(20, current + (e.key === "ArrowLeft" ? -2 : 2)));
  work.style.setProperty("--split", `${next}%`);
});

// Folding the source pane away, for a wide diagram. Instant, and remembered between visits
const source = byId("source");
const showEditor = byId("editor-show");
const folded = () => work.classList.contains("is-folded");
function fold(hide: boolean): void {
  const hadFocus = source.contains(document.activeElement);
  work.classList.toggle("is-folded", hide);
  source.inert = hide;
  showEditor.hidden = !hide;
  if (hide && hadFocus) showEditor.focus();
  if (!hide) editor.view.focus();
  try {
    if (hide) localStorage.setItem(EDITOR_STORE, "hidden");
    else localStorage.removeItem(EDITOR_STORE);
  } catch {
    /* the choice lasts for this visit */
  }
}
byId("editor-hide").addEventListener("click", () => fold(true));
showEditor.addEventListener("click", () => fold(false));
document.addEventListener("keydown", (e) => {
  if (e.key !== "\\" || !(e.metaKey || e.ctrlKey)) return;
  e.preventDefault();
  fold(!folded());
});

byId("copy-source").addEventListener("click", () => copy(state.code, "Source copied"));
// The status names the problems; clicking it goes to the first one
byId("problem-count").addEventListener("click", () => {
  if (problems.length) editor.focusAt(problems[0].span.line, problems[0].span.col);
});

// ---- boot ----

const cursorPos = byId("cursor-pos");
const editor = createEditor(
  byId("editor"),
  state.code,
  (text) => {
    state.code = text;
    save();
    scheduleHash();
    scheduleRender();
  },
  (line, col) => {
    cursorPos.textContent = `Ln ${line}, Col ${col}`;
  },
);

try {
  if (localStorage.getItem(EDITOR_STORE) === "hidden") {
    work.classList.add("is-folded");
    source.inert = true;
    showEditor.hidden = false;
  }
} catch {
  /* start open */
}

async function adopt(shared: Partial<typeof state> | null): Promise<void> {
  if (!shared) return;
  Object.assign(state, shared);
  fitNext = true;
  if (editor.getText() !== state.code) editor.setText(state.code);
  syncControls();
  await render();
}

window.addEventListener("hashchange", async () => {
  const shared = await decode(location.hash);
  if (shared && shared.code !== state.code) await adopt(shared);
});

(async () => {
  const shared = (await decode(location.hash)) ?? load();
  if (shared) {
    Object.assign(state, shared);
    if (editor.getText() !== state.code) editor.setText(state.code);
  }
  syncControls();
  await render();
})();
