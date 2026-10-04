// The playground app: an editor on the left, the diagram on the right, both kept in sync.
// Every change recompiles; errors show up as lint marks and in the problems list, and the diagram
// keeps the last valid drawing (dimmed) until the source compiles again.

import ELK from "elkjs/lib/elk.bundled.js";
import orderExample from "../examples/order.erd";
import shopExample from "../examples/shop.erd";
import { type Diagnostic, type Model, type SvgLook, compile, diff, fromSql, lint, looksLikeSql, neighbors, parse, toSvg } from "../src/index.ts";
import { glassOf, stageOf } from "../src/svg.ts";
import { columnDetails, tableDetails } from "./details.ts";
import { type PasteConverter, createEditor } from "./editor.ts";
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

const state: SharedState & { grid: boolean } = { code: EXAMPLES.order, columns: "all", audit: "collapse", edges: "angular", related: null, base: null, grid: true };
const elk = new ELK();

/** The whole model, which the side panel and the column card describe */
let lastModel: Model | null = null;
/** What the canvas draws: the whole model, or a table and its neighbors */
let drawnModel: Model | null = null;
let focus: Focus | null = null;
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
  const hash = await encode({ code: state.code, columns: state.columns, audit: state.audit, edges: state.edges, related: state.related, base: state.base ?? null });
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

// Lint findings are advice, so they wait behind a count in the status bar; the compiler's own
// problems open the list by themselves. Whether the findings are listed is remembered
const LINT_STORE = "resin.lint";
let lintFindings: Diagnostic[] = [];
let lintOpen = false;
try {
  lintOpen = localStorage.getItem(LINT_STORE) === "open";
} catch {
  /* start closed */
}

/** `name` in a message, set in code type */
function richText(el: HTMLElement, text: string): void {
  el.replaceChildren(
    ...text.split(/(`[^`]+`)/).map((part) => {
      if (!/^`[^`]+`$/.test(part)) return document.createTextNode(part);
      const c = document.createElement("code");
      c.textContent = part.slice(1, -1);
      return c;
    }),
  );
}

function showProblems(ds: Diagnostic[], findings: Diagnostic[] = []): void {
  problems = ds;
  lintFindings = findings;
  const errors = ds.filter((d) => d.severity === "error").length;
  const warnings = ds.length - errors;
  const count = byId("problem-count");
  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
  count.textContent = ds.length === 0 ? "No problems" : [errors && plural(errors, "error"), warnings && plural(warnings, "warning")].filter(Boolean).join(", ");
  count.dataset.state = errors ? "error" : warnings ? "warning" : "ok";
  const lintCount = byId("lint-count");
  lintCount.textContent = plural(findings.length, "lint finding");
  lintCount.hidden = findings.length === 0;
  lintCount.setAttribute("aria-expanded", String(lintOpen));
  lintCount.classList.toggle("is-open", lintOpen);

  const shown = lintOpen ? [...ds, ...findings].sort((a, b) => a.span.line - b.span.line || a.span.col - b.span.col) : ds;
  const list = byId("problems");
  list.replaceChildren(
    ...shown.map((d) => {
      const li = document.createElement("li");
      const button = document.createElement("button");
      button.type = "button";
      button.className = `problem is-${d.rule ? "lint" : d.severity}`;
      const where = document.createElement("span");
      where.className = "problem-where";
      where.textContent = `${d.span.line}:${d.span.col}`;
      const text = document.createElement("span");
      text.className = "problem-text";
      richText(text, d.message);
      if (d.rule) {
        const rule = document.createElement("span");
        rule.className = "problem-rule";
        rule.textContent = d.rule;
        text.append(rule);
      }
      button.append(where, text);
      if (d.hint) {
        const hint = document.createElement("span");
        hint.className = "problem-hint";
        richText(hint, d.hint);
        button.append(hint);
      }
      button.addEventListener("click", () => editor.focusAt(d.span.line, d.span.col));
      li.append(button);
      return li;
    }),
  );
  list.hidden = shown.length === 0;
}

byId("lint-count").addEventListener("click", () => {
  lintOpen = !lintOpen;
  try {
    if (lintOpen) localStorage.setItem(LINT_STORE, "open");
    else localStorage.removeItem(LINT_STORE);
  } catch {
    /* the choice lasts for this visit */
  }
  showProblems(problems, lintFindings);
});

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
  // A table the related view leaves out: the view moves to it, so following references walks the schema
  if (state.related && drawnModel && !drawnModel.tables.some((t) => t.name === name)) {
    void setRelated({ table: name, steps: state.related.steps }).then(() => openTable(name));
    return;
  }
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
  byId("inspector-related").setAttribute("aria-pressed", String(state.related?.table === name));
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
  // The related pill sits in the middle of the top edge, unless the view options would run into it
  const pill = !inspector.hidden || free < 860 ? "below" : "";
  if ((diagramPanel.dataset.pill ?? "") !== pill) diagramPanel.dataset.pill = pill;
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
  // The lint rules need resolved references, so they run only on a document that compiled
  const findings = result.model ? lint(result.doc) : [];
  editor.showDiagnostics([...result.diagnostics, ...findings]);
  showProblems(result.diagnostics, findings);
  if (!result.model) {
    setStale(true);
    return;
  }
  try {
    // With the live canvas the SVG carries only what sits on the glass; the canvas paints the rest
    const look = canvasLook();
    // Comparing with a base version (from a link): draw what changed since it. A base that does not
    // compile cannot be compared, and the document is drawn alone
    const base = state.base ? compile(state.base).model : null;
    const compared = base ? diff(base, result.model) : null;
    const full = compared ? compared.model : result.model;
    showCompare(compared?.changes ?? null);
    // The related view needs its table; when the table is renamed or removed, every table comes back
    if (state.related && !full.tables.some((t) => t.name === state.related!.table)) {
      state.related = null;
      save();
      scheduleHash();
    }
    const shown = state.related ? neighbors(full, state.related.table, state.related.steps) : full;
    const { svg, width, height, background, boxes } = await toSvg(shown, elk, {
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
    lastModel = full;
    drawnModel = shown;
    const empty = full.tables.length === 0;
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
    const counted = (m: Model) => m.tables.filter((t) => state.audit === "expand" || t.origin !== "audit").length;
    const tables = counted(full);
    const relations = shown.relations.filter((r) => state.audit === "expand" || r.origin !== "audit").length;
    const tablesText = state.related ? `${counted(shown)} of ${tables} tables` : `${tables} ${tables === 1 ? "table" : "tables"}`;
    byId("stats").textContent = empty ? "" : `${tablesText}, ${relations} ${relations === 1 ? "relation" : "relations"}`;
    showRelated(counted(shown) - 1);
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
  for (const b of document.querySelectorAll<HTMLButtonElement>("[data-columns]")) b.setAttribute("aria-pressed", String(b.dataset.columns === state.columns));
  for (const b of document.querySelectorAll<HTMLButtonElement>("[data-steps]")) b.setAttribute("aria-pressed", String(Number(b.dataset.steps) === state.related?.steps));
  byId("inspector-related").setAttribute("aria-pressed", String(state.related !== null && state.related.table === inspected));
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
for (const b of document.querySelectorAll<HTMLButtonElement>("[data-columns]"))
  b.addEventListener("click", () => setView({ columns: b.dataset.columns === "keys" || b.dataset.columns === "none" ? b.dataset.columns : "all" }));

// ---- comparing with a base version ----

/** The line under the editor's header while a link compares this document with an older version */
function showCompare(changes: ReturnType<typeof diff>["changes"] | null): void {
  const bar = byId("compare-bar");
  bar.hidden = changes === null;
  if (!changes) return;
  const tables = changes.filter((c) => c.column === null);
  const count = (kind: string) => tables.filter((c) => c.kind === kind).length;
  const n = (k: number, word: string) => `${k} ${k === 1 ? "table" : "tables"} ${word}`;
  const parts = [n(count("added"), "added"), n(count("removed"), "removed"), n(count("changed"), "changed")];
  byId("compare-text").textContent = tables.length ? `Compared with the base version: ${parts.join(", ")}` : "No changes since the base version";
}

byId("compare-stop").addEventListener("click", () => {
  state.base = null;
  fitNext = true;
  save();
  scheduleHash();
  void render();
});

// ---- related tables only ----

/** Draw only a table and its neighbors, or every table again. The layout changes, so the view fits */
function setRelated(related: SharedState["related"]): Promise<void> {
  state.related = related;
  fitNext = true;
  syncControls();
  save();
  scheduleHash();
  return render();
}

/** The pill at the top of the canvas: what is shown, and the way back */
function showRelated(others: number): void {
  const pill = byId("related-pill");
  pill.hidden = state.related === null;
  if (!state.related) return;
  const name = document.createElement("b");
  name.textContent = state.related.table;
  const long = document.createElement("span");
  long.className = "label-long";
  long.textContent = others === 0 ? " joins no other table" : ` and ${others} related ${others === 1 ? "table" : "tables"}`;
  const short = document.createElement("span");
  short.className = "label-short";
  short.textContent = ` +${others}`;
  byId("related-text").replaceChildren(name, long, short);
  fitFloats();
}

byId("inspector-related").addEventListener("click", () => {
  if (!inspected) return;
  void setRelated(state.related?.table === inspected ? null : { table: inspected, steps: state.related?.steps ?? 1 });
});
for (const b of document.querySelectorAll<HTMLButtonElement>("[data-steps]"))
  b.addEventListener("click", () => {
    if (state.related) void setRelated({ table: state.related.table, steps: b.dataset.steps === "2" ? 2 : 1 });
  });
byId("related-all").addEventListener("click", () => void setRelated(null));

// ---- find a table ----

// The palette searches table names first, then descriptions, then column names, and lists at most
// eight tables. Enter goes to the table as a click on its name does; Shift Enter shows it with its
// neighbors. Opened from the keyboard (Ctrl or Cmd + K) it lands at once; from the button it grows
const palette = byId("palette");
const paletteInput = byId<HTMLInputElement>("palette-input");
const paletteList = byId("palette-list");
const findButton = byId("find");
const MAC = /Mac|iPhone|iPad/.test(navigator.platform);
byId("find-key").textContent = MAC ? "Cmd K" : "Ctrl K";

interface Hit {
  table: string;
  description: string | null;
  /** Where the query matched, for the accent: in the name, or in a column named in `meta` */
  name: [number, number] | null;
  meta: string;
  column: [number, number] | null;
}
let hits: Hit[] = [];
let active = 0;
let paletteReturn: HTMLElement | null = null;

function search(query: string): Hit[] {
  if (!lastModel) return [];
  const q = query.trim().toLowerCase();
  const tables = lastModel.tables.filter((t) => state.audit === "expand" || t.origin !== "audit");
  const scored: { hit: Hit; score: number; order: number }[] = [];
  tables.forEach((t, order) => {
    const columns = `${t.columns.length} ${t.columns.length === 1 ? "column" : "columns"}`;
    if (!q) return scored.push({ hit: { table: t.name, description: t.description, name: null, meta: columns, column: null }, score: 0, order });
    const at = t.name.toLowerCase().indexOf(q);
    if (at >= 0) return scored.push({ hit: { table: t.name, description: t.description, name: [at, q.length], meta: columns, column: null }, score: at === 0 ? 0 : 1, order });
    if (t.description?.toLowerCase().includes(q)) return scored.push({ hit: { table: t.name, description: t.description, name: null, meta: columns, column: null }, score: 2, order });
    const c = t.columns.find((x) => x.name.toLowerCase().includes(q));
    if (c) {
      const meta = `column ${c.name}`;
      scored.push({ hit: { table: t.name, description: t.description, name: null, meta, column: [7 + c.name.toLowerCase().indexOf(q), q.length] }, score: 3, order });
    }
  });
  return scored.sort((a, b) => a.score - b.score || a.order - b.order).slice(0, 8).map((s) => s.hit);
}

/** Text with one stretch set in the accent */
function marked(text: string, at: [number, number] | null): Node[] {
  if (!at) return [document.createTextNode(text)];
  const b = document.createElement("b");
  b.textContent = text.slice(at[0], at[0] + at[1]);
  return [document.createTextNode(text.slice(0, at[0])), b, document.createTextNode(text.slice(at[0] + at[1]))];
}

function showHits(): void {
  hits = search(paletteInput.value);
  active = Math.min(active, Math.max(0, hits.length - 1));
  paletteList.replaceChildren(
    ...hits.map((h, i) => {
      const li = document.createElement("li");
      const row = document.createElement("button");
      row.type = "button";
      row.className = "pal-row";
      row.id = `pal-${i}`;
      row.setAttribute("role", "option");
      row.setAttribute("aria-selected", String(i === active));
      row.tabIndex = -1;
      const name = document.createElement("span");
      name.className = "pal-name";
      name.append(...marked(h.table, h.name));
      const desc = document.createElement("span");
      desc.className = "pal-desc";
      desc.textContent = h.description ?? "";
      const meta = document.createElement("span");
      meta.className = "pal-meta";
      meta.append(...marked(h.meta, h.column));
      row.append(name, desc, meta);
      // A press, not the hover, picks: the hover only lights the row
      row.addEventListener("click", (e) => choose(h.table, e.shiftKey));
      li.append(row);
      return li;
    }),
  );
  byId("palette-empty").hidden = hits.length > 0;
  paletteInput.setAttribute("aria-activedescendant", hits.length ? `pal-${active}` : "");
}

function openPalette(animate: boolean): void {
  if (!palette.hidden) return paletteInput.focus();
  paletteReturn = document.activeElement as HTMLElement | null;
  palette.classList.toggle("is-instant", !animate);
  palette.hidden = false;
  findButton.setAttribute("aria-expanded", "true");
  paletteInput.value = "";
  active = 0;
  showHits();
  paletteInput.focus();
}

function closePalette(returnFocus: boolean): void {
  if (palette.hidden) return;
  palette.hidden = true;
  findButton.setAttribute("aria-expanded", "false");
  if (returnFocus) paletteReturn?.focus();
}

async function choose(table: string, related: boolean): Promise<void> {
  closePalette(false);
  if (related) {
    await setRelated({ table, steps: state.related?.steps ?? 1 });
    showInspector(table);
    focus?.table(table);
    glass?.refresh();
  } else openTable(table);
}

findButton.addEventListener("click", () => (palette.hidden ? openPalette(true) : closePalette(true)));
paletteInput.addEventListener("input", () => {
  active = 0;
  showHits();
});
paletteInput.addEventListener("keydown", (e) => {
  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    e.preventDefault();
    if (!hits.length) return;
    active = (active + (e.key === "ArrowDown" ? 1 : hits.length - 1)) % hits.length;
    for (const row of paletteList.querySelectorAll(".pal-row")) row.setAttribute("aria-selected", String(row.id === `pal-${active}`));
    paletteInput.setAttribute("aria-activedescendant", `pal-${active}`);
    byId(`pal-${active}`).scrollIntoView({ block: "nearest" });
  } else if (e.key === "Enter") {
    e.preventDefault();
    if (hits[active]) void choose(hits[active].table, e.shiftKey);
  } else if (e.key === "Escape") {
    // The palette is the innermost thing open: only it closes
    e.stopPropagation();
    closePalette(true);
  } else if (e.key === "Tab") closePalette(false);
});
// Like the download menu: nothing to lose, so a press anywhere else closes it
document.addEventListener("pointerdown", (e) => {
  if (!palette.hidden && !palette.contains(e.target as Node) && !findButton.contains(e.target as Node)) closePalette(false);
});
document.addEventListener("keydown", (e) => {
  if (e.key.toLowerCase() !== "k" || !(MAC ? e.metaKey : e.ctrlKey) || e.shiftKey || e.altKey) return;
  e.preventDefault();
  openPalette(false);
});
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
    else if (state.related) void setRelated(null);
    settleFocus();
  });
});

byId("share").addEventListener("click", async () => {
  await writeHash();
  await copy(location.href, "Link copied");
});

/** Files are plain (graphite) by default: no background, so they sit on any page. A glass look carries
 *  its background with it, as a still picture */
async function exportSvg(look: SvgLook): Promise<string | null> {
  if (!drawnModel) return null;
  const { svg } = await toSvg(drawnModel, elk, { columns: state.columns, audit: state.audit, edges: state.edges, look, standalone: true });
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

// ---- pasting SQL ----

// The SQL line under the editor's header. Until the first conversion it says that pasting SQL
// converts it; after a paste it says what the paste became: how many tables, how many notes (the
// `%%` comments the conversion left, which it steps through) and Undo. Closing the hint, or using
// it once, keeps it closed on later visits
const SQL_HINT_STORE = "resin.sqlhint";
const sqlBar = byId("sql-bar");
const sqlText = byId("sql-text");
const sqlNotes = byId("sql-notes");
const sqlUndo = byId("sql-undo");
byId("sql-key").textContent = /Mac|iPhone|iPad/.test(navigator.platform) ? "Cmd V" : "Ctrl V";

/** The last conversion: the document a plain paste would have left, the one it became, and its notes */
let conversion: { raw: string; converted: string; notes: string[] } | null = null;
let hintSeen = false;
try {
  hintSeen = localStorage.getItem(SQL_HINT_STORE) === "seen";
} catch {
  /* show the hint */
}
function rememberHint(): void {
  hintSeen = true;
  try {
    localStorage.setItem(SQL_HINT_STORE, "seen");
  } catch {
    /* the hint stays closed for this visit */
  }
}
sqlBar.hidden = hintSeen;

function closeSqlBar(): void {
  conversion = null;
  sqlBar.hidden = true;
}

function showConverted(tables: number, raw: string, converted: string, source: string): void {
  rememberHint();
  const notes = source.split("\n").filter((l) => l.trimStart().startsWith("%%")).map((l) => l.trim());
  conversion = { raw, converted, notes };
  const count = document.createElement("b");
  count.textContent = `${tables} ${tables === 1 ? "table" : "tables"}`;
  sqlText.replaceChildren("Converted ", count, " from SQL");
  sqlNotes.textContent = `${notes.length} ${notes.length === 1 ? "note" : "notes"}`;
  sqlNotes.hidden = notes.length === 0;
  sqlUndo.hidden = false;
  sqlBar.dataset.state = "done";
  sqlBar.hidden = false;
}

/** After the conversion, an undo back to the plain paste closes the line. Any other edit drops Undo,
 *  which would no longer undo the conversion, and the line stays while a note is left to go to */
function followSqlBar(text: string): void {
  if (!conversion || text === conversion.converted) return;
  if (text === conversion.raw || !conversion.notes.some((n) => text.includes(n))) closeSqlBar();
  else sqlUndo.hidden = true;
}

sqlUndo.addEventListener("click", () => {
  editor.undo();
  editor.view.focus();
});
// Each press goes to the next note after the cursor, and around again from the top
sqlNotes.addEventListener("click", () => {
  if (!conversion) return;
  const lines = editor.getText().split("\n");
  const at = lines.flatMap((l, i) => (conversion!.notes.includes(l.trim()) ? [i + 1] : []));
  if (at.length === 0) return;
  const doc = editor.view.state.doc;
  const current = doc.lineAt(editor.view.state.selection.main.head).number;
  const next = at.find((n) => n > current) ?? at[0];
  editor.focusAt(next, lines[next - 1].indexOf("%%") + 1);
});
byId("sql-close").addEventListener("click", () => {
  rememberHint();
  closeSqlBar();
});

/** SQL DDL pasted into the editor comes in as resin. An empty editor or an example nobody has
 *  edited is a starting point, not work, so the SQL takes its place; into a document of one's own it
 *  goes where it was pasted, and references to tables already there point at them. One undo brings
 *  back the SQL as it was pasted */
function convertSql(pasted: string, doc: string, rest: string): ReturnType<PasteConverter> {
  if (!looksLikeSql(pasted)) return null;
  const whole = doc.trim() === "" || Object.values(EXAMPLES).includes(doc);
  const converted = fromSql(pasted, { known: whole ? [] : parse(rest).doc.tables.map((t) => t.name.text) });
  if (converted.tables === 0) return null;
  const applied = (raw: string, after: string) => showConverted(converted.tables, raw, after, converted.source);
  if (whole || rest.trim() === "") {
    fitNext = true;
    return { text: converted.source, whole, applied };
  }
  // Into a document that has tables already: keep a blank line on either side
  return { text: `\n${converted.source}\n`, whole: false, applied };
}

// ---- boot ----

const cursorPos = byId("cursor-pos");
const editor = createEditor(
  byId("editor"),
  state.code,
  (text) => {
    state.code = text;
    // The file name follows the text: an edited example is untitled
    const match = Object.entries(EXAMPLES).find(([, example]) => example === text);
    byId<HTMLSelectElement>("example").value = match ? match[0] : "";
    followSqlBar(text);
    save();
    scheduleHash();
    scheduleRender();
  },
  (line, col) => {
    cursorPos.textContent = `Ln ${line}, Col ${col}`;
  },
  convertSql,
);

/** `service` was `group` for a day: rewrite that keyword in a saved document or an old link, at the
 *  places the parser points at, so a table or column called `group` stays as it is */
function upgrade(code: string): string {
  const spans = parse(code)
    .diagnostics.filter((d) => d.message === "`group` is now `service`")
    .map((d) => d.span);
  if (!spans.length) return code;
  const lines = code.split("\n");
  for (const { line, col, len } of spans) {
    const text = lines[line - 1];
    lines[line - 1] = text.slice(0, col - 1) + "service" + text.slice(col - 1 + len);
  }
  return lines.join("\n");
}

function upgraded(shared: Partial<typeof state> | null): Partial<typeof state> | null {
  if (!shared) return null;
  return { ...shared, ...(shared.code ? { code: upgrade(shared.code) } : {}), ...(shared.base ? { base: upgrade(shared.base) } : {}) };
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
  const shared = upgraded(await decode(location.hash));
  if (shared && shared.code !== state.code) await adopt(shared);
});

(async () => {
  const shared = upgraded((await decode(location.hash)) ?? load());
  if (shared) {
    Object.assign(state, shared);
    if (editor.getText() !== state.code) editor.setText(state.code);
  }
  syncControls();
  await render();
})();
