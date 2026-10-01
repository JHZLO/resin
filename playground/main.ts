// The playground app: an editor on the left, the diagram on the right, both kept in sync.
// Every change recompiles; errors show up as lint marks and in the problems list, and the diagram
// keeps the last valid drawing (dimmed) until the source compiles again.

import ELK from "elkjs/lib/elk.bundled.js";
import orderExample from "../examples/order.erd";
import shopExample from "../examples/shop.erd";
import { type Diagnostic, type Model, type SvgLook, compile, toSvg } from "../src/index.ts";
import { glassOf, stageOf } from "../src/svg.ts";
import { columnDetails, tableDetails } from "./details.ts";
import { createEditor } from "./editor.ts";
import { LiveGlass } from "./glass.ts";
import { type SharedState, decode, encode } from "./share.ts";
import { type Focus, MOVE_MS, PanZoom, createFocus } from "./view.ts";

const EXAMPLES: Record<string, string> = {
  order: orderExample,
  shop: shopExample,
  blank: 'table things "Start here" {\n  id    bigint       pk\n  name  varchar(100)\n}\n',
};
const STORE = "resin.playground";
const THEME_STORE = "resin.theme";
const STAGE_STORE = "resin.stage";
const PANEL_STORE = "resin.panel";

/** The canvas's background themes; each has a dark and a light version that follows the page theme */
const STAGES = { aurora: "Aurora", silk: "Silk", caustic: "Caustic" } as const;
type StageName = keyof typeof STAGES;

const byId = <T extends HTMLElement = HTMLElement>(id: string): T => document.getElementById(id) as T;

const state: SharedState & { grid: boolean } = { code: EXAMPLES.order, columns: "all", audit: "collapse", edges: "angular", grid: true };
const elk = new ELK();

let lastModel: Model | null = null;
let focus: Focus | null = null;
let lastMermaid = "";
let renderSeq = 0;
let fitNext = true;
let lastBoxes: { table: string; x: number; y: number; w: number; h: number }[] = [];
let stageName: StageName = "aurora";
try {
  const saved = localStorage.getItem(STAGE_STORE);
  if (saved && saved in STAGES) stageName = saved as StageName;
} catch {
  /* keep aurora */
}

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
    toast("Copying is blocked in this browser");
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

// ---- rendering ----

const viewport = byId("viewport");
const content = byId("content");
const zoomLevel = byId("zoom-level");

// The glass and its moving stage are painted with WebGL under the SVG. Without WebGL2 the SVG paints a
// still version itself
let glass: LiveGlass | null = null;
if (LiveGlass.available()) {
  try {
    glass = new LiveGlass(viewport, content);
  } catch (e) {
    console.warn("resin: the live canvas is off, showing the still drawing", e);
    viewport.querySelector(".stage-glass")?.remove();
  }
}

const panzoom = new PanZoom(
  viewport,
  content,
  (animate) => {
    zoomLevel.textContent = `${Math.round(panzoom.scale * 100)}%`;
    glass?.setView(panzoom.scale, panzoom.x, panzoom.y, animate);
    // The popover rides along with its row; after an animated move, place it again once settled
    placePop();
    if (animate) window.setTimeout(placePop, MOVE_MS + 20);
  },
  (target, x, y) => {
    const table = target.closest<SVGGElement>(".rz-t")?.dataset.t ?? null;
    const column = target.closest<SVGGElement>(".rz-c")?.dataset.c ?? null;
    if (table && column) pickColumn(table, column);
    else if (table && target.closest(".rz-head")) pickTable(table);
    else if (table) {
      closePop();
      focus?.table(table);
    } else {
      closePop();
      settleFocus();
    }
    glass?.refresh();
    glass?.ripple(x, y);
  },
);

// ---- details: the table panel and the column popover ----

const diagramPanel = byId("panel-diagram");
const inspector = byId("inspector");
const inspectorBody = byId("inspector-body");
const pop = byId("pop");
/** The table in the side panel, and the column in the popover */
let inspected: string | null = null;
let popped: { table: string; column: string } | null = null;

const rowEl = (table: string, column: string): SVGGElement | null =>
  [...content.querySelectorAll<SVGGElement>(".rz-t")]
    .find((t) => t.dataset.t === table)
    ?.querySelector<SVGGElement>(`.rz-c[data-c="${CSS.escape(column)}"]`) ?? null;

/** With nothing picked, the table in the side panel keeps the focus; otherwise the focus clears */
function settleFocus(): void {
  if (inspected && !inspector.hidden) focus?.table(inspected);
  else focus?.clear();
}

/** Bring a table to the middle of what the side panel leaves visible */
function reveal(name: string, onlyIfCovered = false): void {
  const b = lastBoxes.find((x) => x.table === name);
  if (!b) return;
  const covered = inspector.hidden ? 0 : inspector.offsetWidth;
  const right = panzoom.x + (b.x + b.w) * panzoom.scale;
  if (onlyIfCovered && right <= viewport.clientWidth - covered - 16) return;
  panzoom.centerOn(b.x + b.w / 2, b.y + b.h / 2, covered);
}

/** Open a table in the side panel, focus it, and bring it into view */
function openTable(name: string): void {
  closePop();
  showInspector(name);
  focus?.table(name);
  glass?.refresh();
  reveal(name);
}

/** A table name on the diagram: opens its panel, or closes it when it is already open */
function pickTable(name: string): void {
  closePop();
  if (inspected === name && !inspector.hidden) {
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
    settleFocus();
    return;
  }
  focus?.row(table, column);
  showPop(table, column);
}

function showInspector(name: string): void {
  const view = lastModel ? tableDetails(lastModel, name, openTable, (t, c) => {
    pickColumn(t, c);
    // A row picked in the panel may sit under the panel or off the canvas: bring it out
    if (!pop.hidden) revealRow(t, c);
    glass?.refresh();
  }) : null;
  if (!view) return closeInspector();
  inspected = name;
  inspectorBody.replaceChildren(view);
  byId("inspector-title").textContent = name;
  inspector.hidden = false;
  diagramPanel.classList.add("has-inspector");
  markPicked();
  fitFloats();
}

function closeInspector(): void {
  inspected = null;
  inspector.hidden = true;
  diagramPanel.classList.remove("has-inspector");
  fitFloats();
}

function showPop(table: string, column: string): void {
  const view = lastModel ? columnDetails(lastModel, table, column, openTable) : null;
  if (!view || !rowEl(table, column)) return closePop();
  popped = { table, column };
  pop.replaceChildren(view);
  pop.hidden = false;
  placePop();
  markPicked();
}

function closePop(): void {
  popped = null;
  pop.hidden = true;
  markPicked();
}

/** The column in the popover, marked in the panel's table too */
function markPicked(): void {
  for (const row of inspectorBody.querySelectorAll("tr.is-on")) row.classList.remove("is-on");
  if (popped && popped.table === inspected) inspectorBody.querySelector(`tr[data-c="${CSS.escape(popped.column)}"]`)?.classList.add("is-on");
}

/** Center a row in what the side panel leaves visible, unless it is already in plain view */
function revealRow(table: string, column: string): void {
  const row = rowEl(table, column);
  if (!row) return;
  const area = viewport.getBoundingClientRect();
  const r = row.getBoundingClientRect();
  const covered = inspector.hidden ? 0 : inspector.offsetWidth;
  if (r.left >= area.left + 8 && r.right <= area.right - covered - 8 && r.top >= area.top + 8 && r.bottom <= area.bottom - 8) return;
  const cx = (r.left + r.width / 2 - area.left - panzoom.x) / panzoom.scale;
  const cy = (r.top + r.height / 2 - area.top - panzoom.y) / panzoom.scale;
  panzoom.centerOn(cx, cy, covered);
}

// ---- the side panel's width, and the canvas it leaves ----

const zoomFloat = viewport.querySelector<HTMLElement>(".float.zoom")!;
const resizer = byId("inspector-resize");
const PANEL_MIN = 360;
let panelWidth = 560;
try {
  const saved = Number(localStorage.getItem(PANEL_STORE));
  if (saved >= PANEL_MIN) panelWidth = saved;
} catch {
  /* keep the default */
}

const panelMax = (): number => Math.max(PANEL_MIN, diagramPanel.clientWidth - 120);

/** The width goes on the two elements that use it, not on the panel: a variable on the panel would
 *  restyle the whole drawing on every move of a drag. CSS caps it at the canvas's own width */
function applyPanelWidth(): void {
  for (const el of [inspector, zoomFloat]) el.style.setProperty("--ins-w", `${panelWidth}px`);
  resizer.setAttribute("aria-valuenow", String(panelWidth));
  resizer.setAttribute("aria-valuemin", String(PANEL_MIN));
  resizer.setAttribute("aria-valuemax", String(Math.round(panelMax())));
  fitFloats();
  placePop();
}

/** Wide enough for its tables by default; at most what leaves a little canvas beside it */
function setPanelWidth(width: number, keep = false): void {
  panelWidth = Math.round(Math.min(panelMax(), Math.max(PANEL_MIN, width)));
  applyPanelWidth();
  if (!keep) return;
  try {
    localStorage.setItem(PANEL_STORE, String(panelWidth));
  } catch {
    /* the width lasts for this visit */
  }
}

/** With little canvas left beside the panel, the floating controls drop their labels; with very
 *  little, the background picker steps aside so the zoom group does not land on it */
function fitFloats(): void {
  const free = viewport.clientWidth - (inspector.hidden ? 0 : inspector.offsetWidth);
  const room = free < 350 ? "tight" : free < 520 ? "snug" : "";
  if ((diagramPanel.dataset.room ?? "") !== room) diagramPanel.dataset.room = room;
}

// The panel's left edge: drag it, or use the arrow keys when it has focus
resizer.addEventListener("pointerdown", (e) => {
  if (e.button !== 0) return;
  e.preventDefault();
  resizer.setPointerCapture(e.pointerId);
  resizer.classList.add("is-dragging");
  document.body.classList.add("is-resizing");
  const startX = e.clientX;
  const startWidth = inspector.offsetWidth;
  const move = (m: PointerEvent) => setPanelWidth(startWidth + (startX - m.clientX));
  const up = () => {
    resizer.removeEventListener("pointermove", move);
    resizer.removeEventListener("pointerup", up);
    resizer.removeEventListener("pointercancel", up);
    resizer.classList.remove("is-dragging");
    document.body.classList.remove("is-resizing");
    setPanelWidth(panelWidth, true);
  };
  resizer.addEventListener("pointermove", move);
  resizer.addEventListener("pointerup", up);
  resizer.addEventListener("pointercancel", up);
});
resizer.addEventListener("keydown", (e) => {
  if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
  e.preventDefault();
  setPanelWidth(panelWidth + (e.key === "ArrowLeft" ? 24 : -24), true);
});
// A double-click on the edge goes back to the default width
resizer.addEventListener("dblclick", () => setPanelWidth(560, true));
// A resized canvas changes what the panel covers: re-check the floating controls and the popover
new ResizeObserver(() => {
  fitFloats();
  placePop();
}).observe(viewport);
applyPanelWidth();

/** Under its row, or above it when there is no room below; hidden while the row is out of view.
 *  It is placed with `translate`, so its entrance can grow it from the corner nearest the row */
function placePop(): void {
  if (!popped || pop.hidden) return;
  const row = rowEl(popped.table, popped.column);
  if (!row) return closePop();
  const area = diagramPanel.getBoundingClientRect();
  const r = row.getBoundingClientRect();
  const right = area.width - (inspector.hidden ? 0 : inspector.offsetWidth) - 8;
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
  glass?.refresh();
});

const isDark = (): boolean => {
  const set = document.documentElement.dataset.theme;
  return set ? set === "dark" : matchMedia("(prefers-color-scheme: dark)").matches;
};
/** The canvas draws the chosen background theme, dark or light with the page */
const canvasLook = (variant: "dark" | "light" = isDark() ? "dark" : "light"): SvgLook => `${stageName}-${variant}`;

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
    // With the live canvas the SVG carries only what sits on the glass; the canvas paints the rest
    const look = canvasLook();
    const { svg, width, height, background, boxes } = await toSvg(result.model, elk, {
      columns: state.columns,
      audit: state.audit,
      look,
      stage: glass === null,
      edges: state.edges,
      idPrefix: "pg-",
    });
    if (seq !== renderSeq) return; // a newer render has started
    viewport.style.backgroundColor = background ?? "";
    glass?.setLook(stageOf(look), glassOf(look));
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
    glass?.setBoxes(lastBoxes, drawn);
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

// ---- controls ----

function syncControls(): void {
  byId("toggle-keys").setAttribute("aria-pressed", String(state.columns === "keys"));
  byId("toggle-audit").setAttribute("aria-pressed", String(state.audit === "expand"));
  byId("grid-toggle").setAttribute("aria-pressed", String(state.grid));
  for (const b of document.querySelectorAll<HTMLButtonElement>("[data-edges]")) b.setAttribute("aria-pressed", String(b.dataset.edges === state.edges));
  viewport.classList.toggle("grid", state.grid);
  glass?.setGrid(state.grid);
  const select = byId<HTMLSelectElement>("example");
  const match = Object.entries(EXAMPLES).find(([, text]) => text === state.code);
  select.value = match ? match[0] : "";
}

function setView(change: Partial<Pick<typeof state, "columns" | "audit">>): void {
  Object.assign(state, change);
  fitNext = true;
  syncControls();
  save();
  scheduleHash();
  render();
}
byId("toggle-keys").addEventListener("click", () => setView({ columns: state.columns === "keys" ? "all" : "keys" }));
byId("toggle-audit").addEventListener("click", () => setView({ audit: state.audit === "expand" ? "collapse" : "expand" }));
for (const b of document.querySelectorAll<HTMLButtonElement>("[data-edges]"))
  b.addEventListener("click", () => {
    // The layout stays the same, so the view does not move
    state.edges = b.dataset.edges === "curved" ? "curved" : "angular";
    syncControls();
    save();
    scheduleHash();
    render();
  });

byId<HTMLSelectElement>("example").addEventListener("change", (e) => {
  const key = (e.target as HTMLSelectElement).value;
  if (!EXAMPLES[key]) return;
  fitNext = true;
  editor.setText(EXAMPLES[key]);
});

byId("grid-toggle").addEventListener("click", () => {
  state.grid = !state.grid;
  syncControls();
  save();
});

// Background theme
function syncStage(): void {
  for (const b of document.querySelectorAll<HTMLButtonElement>("[data-stage]")) b.setAttribute("aria-pressed", String(b.dataset.stage === stageName));
}
for (const b of document.querySelectorAll<HTMLButtonElement>("[data-stage]"))
  b.addEventListener("click", () => {
    stageName = b.dataset.stage as StageName;
    try {
      localStorage.setItem(STAGE_STORE, stageName);
    } catch {
      /* the choice lasts for this visit */
    }
    syncStage();
    render();
  });
syncStage();
byId("zoom-in").addEventListener("click", () => panzoom.zoomBy(1.25, undefined, undefined, true));
byId("zoom-out").addEventListener("click", () => panzoom.zoomBy(0.8, undefined, undefined, true));
byId("zoom-level").addEventListener("click", () => panzoom.actualSize());
byId("zoom-fit").addEventListener("click", () => panzoom.fit(true));
/** Keyboard actions never animate: the change lands at once, glass included */
function instantly(change: () => void): void {
  diagramPanel.classList.add("is-instant");
  change();
  void diagramPanel.offsetWidth; // apply the change while transitions are off
  diagramPanel.classList.remove("is-instant");
  glass?.refresh(true);
}

// Escape closes the innermost thing that is open: the popover, then the side panel
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  instantly(() => {
    if (!pop.hidden) closePop();
    else if (!inspector.hidden) closeInspector();
    settleFocus();
  });
});

byId("share").addEventListener("click", async () => {
  await writeHash();
  await copy(location.href, "Link copied");
});

byId("copy-mermaid").addEventListener("click", () => copy(lastMermaid, "Mermaid copied"));

/** Files are plain (graphite) by default: no background, so they sit on any page. A glass look carries
 *  its background with it, as a still picture */
async function exportSvg(look: SvgLook): Promise<string | null> {
  if (!lastModel) return null;
  const { svg } = await toSvg(lastModel, elk, { columns: state.columns, audit: state.audit, edges: state.edges, look, standalone: true });
  return svg + "\n";
}

byId("copy-svg").addEventListener("click", async () => {
  const svg = await exportSvg("graphite");
  if (svg) await copy(svg, "SVG copied");
});

async function download(look: SvgLook): Promise<void> {
  const svg = await exportSvg(look);
  if (!svg) return;
  const url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = look === "graphite" ? "schema.svg" : `schema.${look}.svg`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// Download menu: plain, or the current background theme in its dark or light version
const downloadButton = byId("download");
const downloadMenu = byId("download-menu");
const menuItems = [...downloadMenu.querySelectorAll<HTMLButtonElement>("[data-variant]")];
const lookOf = (variant: string): SvgLook => (variant === "plain" ? "graphite" : canvasLook(variant as "dark" | "light"));
function labelMenu(): void {
  for (const item of menuItems) {
    const variant = item.dataset.variant!;
    if (variant === "plain") continue;
    item.querySelector(".menu-title")!.textContent = `${STAGES[stageName]}, ${variant}`;
    item.querySelector(".swatch")!.className = `swatch sw-${stageName}-${variant}`;
  }
}
function setMenu(open: boolean, returnFocus = false): void {
  if (open) labelMenu();
  downloadMenu.hidden = !open;
  downloadButton.setAttribute("aria-expanded", String(open));
  if (open) menuItems[0].focus();
  else if (returnFocus) downloadButton.focus();
}
downloadButton.addEventListener("click", () => setMenu(downloadMenu.hidden));
for (const item of menuItems)
  item.addEventListener("click", () => {
    setMenu(false, true);
    download(lookOf(item.dataset.variant!));
  });
downloadMenu.addEventListener("keydown", (e) => {
  const i = menuItems.indexOf(document.activeElement as HTMLButtonElement);
  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    e.preventDefault();
    const next = e.key === "ArrowDown" ? i + 1 : Math.max(i, 0) - 1;
    menuItems[(next + menuItems.length) % menuItems.length].focus();
  } else if (e.key === "Escape") {
    e.stopPropagation();
    setMenu(false, true);
  } else if (e.key === "Tab") setMenu(false);
});
// A small menu with nothing to lose: a press anywhere else closes it
document.addEventListener("pointerdown", (e) => {
  if (!downloadMenu.hidden && !downloadButton.parentElement!.contains(e.target as Node)) setMenu(false);
});

// Tabs
const tabs = [byId("tab-diagram"), byId("tab-mermaid")];
for (const tab of tabs)
  tab.addEventListener("click", () => {
    for (const t of tabs) {
      const on = t === tab;
      t.setAttribute("aria-selected", String(on));
      byId(t.getAttribute("aria-controls")!).hidden = !on;
    }
    // The live canvas rests while the Mermaid tab covers it. Coming back keeps the view as it was
    glass?.pause(tab.id !== "tab-diagram");
  });

// Theme: auto → light → dark
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
  render(); // the glass follows the theme
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

// Folding the source pane away, for a wide diagram. Remembered between visits
const EDITOR_STORE = "resin.editor";
const folded = () => work.classList.contains("is-folded");
function fold(hide: boolean, animate = true): void {
  if (animate && !matchMedia("(prefers-reduced-motion: reduce)").matches) {
    work.classList.add("is-moving");
    window.setTimeout(() => work.classList.remove("is-moving"), 300);
  }
  // Focus inside the pane would be lost when it goes inert: hand it to the button that brings it back
  const hadFocus = byId("source").contains(document.activeElement);
  work.classList.toggle("is-folded", hide);
  byId("source").toggleAttribute("inert", hide);
  byId("editor-show").hidden = !hide;
  if (hide && hadFocus) byId("editor-show").focus();
  try {
    if (hide) localStorage.setItem(EDITOR_STORE, "hidden");
    else localStorage.removeItem(EDITOR_STORE);
  } catch {
    /* the choice lasts for this visit */
  }
}
byId("editor-hide").addEventListener("click", () => fold(true));
byId("editor-show").addEventListener("click", () => {
  fold(false);
  editor.view.focus();
});
// From the keyboard the fold is instant: it is done often, and keyboard actions never animate
document.addEventListener("keydown", (e) => {
  if (e.key !== "\\" || !(e.metaKey || e.ctrlKey)) return;
  e.preventDefault();
  fold(!folded(), false);
  if (!folded()) editor.view.focus();
});
try {
  if (localStorage.getItem(EDITOR_STORE) === "hidden") fold(true, false);
} catch {
  /* start open */
}

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
