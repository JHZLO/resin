// The playground app: an editor on the left, the diagram on the right, both kept in sync.
// Every change recompiles; errors show up as lint marks and in the problems list, and the diagram
// keeps the last valid drawing (dimmed) until the source compiles again.

import orderExample from "../examples/order.erd";
import shopExample from "../examples/shop.erd";
import { type Diagnostic, type Model, type SqlDdl, type SqlDialect, type SvgLook, type SvgOptions, type SvgResult, SQL_DIALECTS, compile, diff, format, fromSql, looksLikeSql, parse, toSql } from "../src/index.ts";
import { Documents, type LocalDocument } from "./documents.ts";
import { AnalysisClient } from "./analysis-client.ts";
import { RenderClient } from "./render-client.ts";
import { createWorkspace, saveFile, fileName } from "./workspace.ts";
import { relatedModel, relationPath, serviceModel, subset } from "./schema-tools.ts";
import { glassOf, serviceCardId, stageOf } from "../src/svg.ts";
import { columnDetails, serviceDetails, sqlDetails, tableDetails } from "./details.ts";
import { type PasteConverter, createEditor } from "./editor.ts";
import { LiveGlass } from "./glass.ts";
import { type SharedState, decode, encode } from "./share.ts";
import { showStars } from "./stars.ts";
import { type Focus, MOVE_MS, PanZoom, createFocus } from "./view.ts";

const EXAMPLES: Record<string, string> = {
  order: orderExample,
  shop: shopExample,
  blank: 'table things "Start here" {\n  id    bigint       pk\n  name  varchar(100)\n}\n',
};
const THEME_STORE = "resin.theme";
const STAGE_STORE = "resin.stage";
const PANEL_STORE = "resin.panel";

/** The canvas's background themes; each has a dark and a light version that follows the page theme */
const STAGES = { aurora: "Aurora", silk: "Silk", caustic: "Caustic" } as const;
type StageName = keyof typeof STAGES;

const byId = <T extends HTMLElement = HTMLElement>(id: string): T => document.getElementById(id) as T;

const state: SharedState & { grid: boolean } = { code: EXAMPLES.order, columns: "all", audit: "collapse", edges: "angular", related: null, service: null, base: null, grid: true };
let storage: Pick<Storage, "getItem" | "setItem">;
try { storage = localStorage; } catch { storage = { getItem: () => null, setItem: () => { throw new Error("Storage unavailable"); } }; }
const documents = new Documents(storage, state);
const analyzer = new AnalysisClient();
const renderer = new RenderClient();
let mountedKey = "";
type MountedDiagram = Pick<SvgResult, "width" | "height" | "background" | "boxes"> & { element: SVGSVGElement | null; nodes: number };
let currentDiagram: MountedDiagram | null = null;
let mountedModelKey = 0;
const mountedViews = new Map<string, MountedDiagram>();
function rememberView(key: string, value: MountedDiagram): void {
  if (value.nodes > 100_000) return;
  mountedViews.delete(key); mountedViews.set(key, value);
  let nodes = [...mountedViews.values()].reduce((sum, entry) => sum + entry.nodes, 0);
  while (nodes > 100_000 || mountedViews.size > 4) {
    const first = mountedViews.keys().next().value!;
    nodes -= mountedViews.get(first)!.nodes; mountedViews.delete(first);
  }
}
const exporter = new RenderClient();

/** The whole model, which the side panel and the column card describe */
let lastModel: Model | null = null;
/** What the canvas draws: the whole model, or a table and its neighbors */
let drawnModel: Model | null = null;
let focus: Focus | null = null;
let tableElements = new Map<string, SVGGElement>();
let popFrame = 0;
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

function save(): void {
  documents.update(state);
  const active = documents.activeInfo;
  // A reload must not reopen an older hash while compression is still debounced.
  if (history.state?.resinDocument !== active.id) history.replaceState({ resinDocument: active.id }, "");
  byId("document-name").textContent = active.title;
  showSaveStatus();
}
function showSaveStatus(): void {
  byId("save-status").textContent = documents.error ? "Not saved" : documents.pending ? "Saving…" : "Saved locally";
  byId("save-error").textContent = documents.error ?? "";
  byId("save-error").hidden = documents.error === null;
}

documents.onChange = showSaveStatus;

let hashTimer = 0;
let hashGeneration = 0;
function scheduleHash(): void {
  hashGeneration++;
  clearTimeout(hashTimer);
  hashTimer = window.setTimeout(() => void writeHash(), 400);
}
async function writeHash(): Promise<boolean> {
  const generation = ++hashGeneration;
  clearTimeout(hashTimer);
  try {
    const hash = await encode({ code: state.code, columns: state.columns, audit: state.audit, edges: state.edges, related: state.related, service: state.service ?? null, base: state.base ?? null, view: state.view, reading: state.reading });
    if (generation !== hashGeneration) return false;
    if (location.hash !== hash) history.replaceState({ resinDocument: documents.activeInfo.id }, "", hash);
    return true;
  } catch {
    return false;
  }
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
    if (!popFrame) popFrame = requestAnimationFrame(() => { popFrame = 0; placePop(); });
    if (animate) window.setTimeout(placePop, MOVE_MS + 20);
  },
  (target, x, y) => {
    const card = target.closest<SVGGElement>(".rz-t");
    const table = card?.dataset.t ?? null;
    const row = target.closest<SVGGElement>(".rz-c");
    const column = row?.dataset.c ?? null;
    // A folded service's card: its header is the service, its rows are tables. An area's label is the service too
    const service = card ? card.dataset.svc ?? null : target.closest(".rz-svc-head")?.closest<SVGGElement>(".rz-svc")?.dataset.svc ?? null;
    if (service && row) pickTable(row.dataset.table!);
    else if (service && (!card || target.closest(".rz-head"))) pickService(service);
    else if (table && column) pickColumn(table, column);
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
/** The table (or the service) in the side panel, and the column in the popover */
let inspected: string | null = null;
let inspectedService: string | null = null;
let popped: { table: string; column: string } | null = null;
let inspectorReturn: HTMLElement | null = null;
let navigationSeq = 0;

const rowEl = (table: string, column: string): SVGGElement | null =>
  tableElements.get(table)?.querySelector<SVGGElement>(`.rz-c[data-c="${CSS.escape(column)}"]`) ?? null;

/** A table the drawing shows as a row of a folded service: that card and row */
function foldedRow(table: string): { card: string; row: string } | null {
  const row = content.querySelector<SVGGElement>(`.rz-c[data-table="${CSS.escape(table)}"]`);
  const card = row?.closest<SVGGElement>(".rz-t")?.dataset.t;
  return row && card ? { card, row: row.dataset.c! } : null;
}

/** Focus a table, or its row when its service is folded */
function focusTable(name: string): void {
  const folded = foldedRow(name);
  if (folded) focus?.row(folded.card, folded.row);
  else focus?.table(name);
}

/** Focus a service where it is one card; drawn as an area, it has no single thing to keep */
function focusService(name: string): void {
  if (tableElements.has(serviceCardId(name))) focus?.table(serviceCardId(name));
  else focus?.clear();
}

/** With nothing picked, the table or service in the side panel keeps the focus; otherwise the focus clears */
function settleFocus(): void {
  if (inspected && !inspector.hidden) focusTable(inspected);
  else if (inspectedService && !inspector.hidden) focusService(inspectedService);
  else focus?.clear();
}

/** Bring a table (or the card its service is folded into) to the middle of what the side panel leaves visible */
function reveal(name: string, onlyIfCovered = false, animate = true): void {
  const drawn = foldedRow(name)?.card ?? name;
  const b = lastBoxes.find((x) => x.table === drawn);
  if (!b) return;
  const covered = inspector.hidden ? 0 : inspector.offsetWidth;
  const right = panzoom.x + (b.x + b.w) * panzoom.scale;
  if (onlyIfCovered && right <= viewport.clientWidth - covered - 16) return;
  panzoom.centerOn(b.x + b.w / 2, b.y + b.h / 2, covered, animate);
}

/** Open a table in the side panel, focus it, and bring it into view */
async function openTable(name: string, animate = true): Promise<void> {
  const seq = ++navigationSeq;
  const table = lastModel?.tables.find((t) => t.name === name);
  if (!table) return;
  if (table.origin === "audit" && state.audit === "collapse") await setView({ audit: "expand" });
  // A table the related view leaves out: the view moves to it, so following references walks the schema
  if (state.related && drawnModel && !drawnModel.tables.some((t) => t.name === name)) {
    await setRelated({ table: name, steps: state.related.steps });
  }
  if (!state.related && drawnModel && !drawnModel.tables.some(t => t.name === name)) {
    state.view = {}; state.service = null; fitNext = true; save(); scheduleHash(); await render();
  }
  if (seq !== navigationSeq) return;
  closePop();
  showInspector(name);
  focusTable(name);
  glass?.refresh();
  reveal(name, false, animate);
  if (!animate) byId("inspector-close").focus();
}

/** Repeated header clicks keep the panel open; only its close button and Escape dismiss it. */
function pickTable(name: string): void {
  closePop();
  showInspector(name);
  focusTable(name);
  // The panel opens over the canvas: keep the table that was clicked in view
  reveal(name, true);
}

/** Where a service is drawn: its folded card, or its area's label */
const serviceEl = (name: string): Element | null =>
  content.querySelector(`.rz-t[data-svc="${CSS.escape(name)}"]`) ?? content.querySelector(`.rz-svc[data-svc="${CSS.escape(name)}"] .rz-svc-head`);

/** A service's card header or area label on the diagram: the service panel */
function pickService(name: string): void {
  closePop();
  showService(name);
  focusService(name);
  revealEl(serviceEl(name));
}

/** Open a service in the side panel from a link, and bring it into view */
function openService(name: string, animate = true): void {
  ++navigationSeq;
  closePop();
  showService(name);
  focusService(name);
  glass?.refresh();
  revealEl(serviceEl(name), animate);
  if (!animate) byId("inspector-close").focus();
}

/** A reference picked in the service panel: its column where the drawing has it, otherwise the row of
 *  the folded service its table is in */
function pickReference(table: string, column: string, animate = true): void {
  const folded = rowEl(table, column) ? null : foldedRow(table);
  if (!folded) return void pickColumn(table, column, animate);
  ++navigationSeq;
  closePop();
  focus?.row(folded.card, folded.row);
  revealEl(rowEl(folded.card, folded.row), animate);
  glass?.refresh();
}

/** A column on the diagram (or in the panel): shows its popover, or closes it when it is already open */
async function pickColumn(table: string, column: string, animate = true): Promise<void> {
  const seq = ++navigationSeq;
  if (popped && popped.table === table && popped.column === column && !pop.hidden) {
    closePop();
    settleFocus();
    return;
  }
  // The panel always lists every column. Selecting a folded row first makes it visible, and a table
  // folded into a service around one service's view leaves that view
  if (!rowEl(table, column) && lastModel?.tables.find((t) => t.name === table)?.columns.some((c) => c.name === column)) {
    if (state.service && foldedRow(table)) state.service = null;
    await setView({ columns: "all" });
    if (seq !== navigationSeq) return;
  }
  focus?.row(table, column);
  showPop(table, column);
  if (!pop.hidden) revealRow(table, column, animate);
  glass?.refresh();
}

/** Where focus goes back to when the panel closes: what opened it */
function rememberReturn(): void {
  if (!inspector.hidden) return;
  const active = document.activeElement as HTMLElement | null;
  inspectorReturn = active?.closest("#palette") ? byId("find") : active;
}

function showInspector(name: string): void {
  const view = lastModel ? tableDetails(lastModel, name, openTable, pickColumn, openService) : null;
  if (!view) return closeInspector();
  rememberReturn();
  const activeColumn = inspectorBody.contains(document.activeElement) ? (document.activeElement as HTMLElement).closest<HTMLElement>("tr[data-c]")?.dataset.c : null;
  inspected = name;
  inspectedService = null;
  sqlOpen = false;
  setInspectorMode("table");
  inspectorBody.replaceChildren(view);
  byId("inspector-title").textContent = name;
  byId("inspector-related").setAttribute("aria-pressed", String(state.related?.table === name));
  inspector.hidden = false;
  diagramPanel.classList.add("has-inspector");
  markPicked();
  fitFloats();
  if (activeColumn) inspectorBody.querySelector<HTMLButtonElement>(`tr[data-c="${CSS.escape(activeColumn)}"] button`)?.focus();
}

function showService(name: string): void {
  const view = lastModel ? serviceDetails(lastModel, name, openTable, pickReference, openService) : null;
  if (!view) return closeInspector();
  rememberReturn();
  inspected = null;
  inspectedService = name;
  sqlOpen = false;
  setInspectorMode("service");
  inspectorBody.replaceChildren(view);
  byId("inspector-title").textContent = name;
  byId("inspector-related").setAttribute("aria-pressed", String(state.service === name));
  inspector.hidden = false;
  diagramPanel.classList.add("has-inspector");
  markPicked();
  fitFloats();
}

function closeInspector(): void {
  const restoreFocus = inspector.contains(document.activeElement);
  inspected = null;
  inspectedService = null;
  sqlOpen = false;
  inspector.hidden = true;
  diagramPanel.classList.remove("has-inspector");
  fitFloats();
  if (restoreFocus) {
    const target = inspectorReturn?.isConnected && inspectorReturn.getClientRects().length ? inspectorReturn : byId("find");
    target.focus();
  }
}

/** The panel shows a table, a service or the SQL: its label, its name and its buttons follow */
function setInspectorMode(mode: "table" | "service" | "sql"): void {
  byId("inspector-label").textContent = { table: "Table", service: "Service", sql: "SQL" }[mode];
  inspector.setAttribute("aria-label", { table: "Table details", service: "Service details", sql: "SQL" }[mode]);
  const related = byId("inspector-related");
  related.hidden = mode === "sql";
  byId("inspector-related-label").textContent = mode === "service" ? "Service only" : "Related only";
  related.title = mode === "service" ? "Show this service's tables, with the services they link to folded" : "Show this table and the tables it is joined to";
  byId("service-sql").hidden = mode !== "service";
  byId("sql-copy").hidden = mode !== "sql";
  byId("sql-download").hidden = mode !== "sql";
}

// ---- SQL in the side panel ----

const SQL_STORE = "resin.sql";
let sqlOpen = false;
let sqlDialect: SqlDialect = "postgres";
try {
  const saved = localStorage.getItem(SQL_STORE);
  if (saved && (SQL_DIALECTS as readonly string[]).includes(saved)) sqlDialect = saved as SqlDialect;
} catch {
  /* PostgreSQL */
}
let sqlService: string | null = null;

/** The DDL of the document as it is now, or null while it has errors */
function currentSql(): { model: Model | null; ddl: SqlDdl | null } {
  const model = compile(state.code).model;
  if (!model) return { model: null, ddl: null };
  if (sqlService && !model.services.some((s) => s.name === sqlService)) sqlService = null;
  return { model, ddl: toSql(model, { dialect: sqlDialect, service: sqlService ?? undefined }) };
}
const sqlFileName = () => `${fileName(documents.activeInfo.title)}${sqlService ? `.${sqlService}` : ""}.${sqlDialect}.sql`;

function showSql(): void {
  const { model, ddl } = currentSql();
  // Rebuilding the view keeps the keyboard where it was: on the database switch or the service
  const active = document.activeElement as HTMLElement | null;
  const refocus = inspectorBody.contains(active) ? (active?.tagName === "SELECT" ? "select" : active?.dataset.dialect ? `[data-dialect="${sqlDialect}"]` : null) : null;
  inspected = null;
  inspectedService = null;
  sqlOpen = true;
  setInspectorMode("sql");
  inspectorBody.replaceChildren(sqlDetails(model, ddl, sqlDialect, sqlService, (d) => {
    sqlDialect = d;
    try {
      localStorage.setItem(SQL_STORE, d);
    } catch {
      /* the choice lasts for this visit */
    }
    showSql();
  }, (s) => {
    sqlService = s;
    showSql();
  }));
  byId("inspector-title").textContent = sqlFileName();
  inspector.hidden = false;
  diagramPanel.classList.add("has-inspector");
  markPicked();
  fitFloats();
  if (refocus) inspectorBody.querySelector<HTMLElement>(refocus)?.focus();
}

byId("sql-copy").addEventListener("click", () => {
  const { ddl } = currentSql();
  if (ddl) copy(ddl.sql, "SQL copied");
  else toast("Fix the errors first: SQL is written from a document without errors");
});
byId("sql-download").addEventListener("click", () => {
  const { ddl } = currentSql();
  if (ddl) saveFile(ddl.sql, sqlFileName(), "application/sql");
  else toast("Fix the errors first: SQL is written from a document without errors");
});

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
function revealRow(table: string, column: string, animate = true): void {
  revealEl(rowEl(table, column), animate);
}

/** Center a part of the drawing in what the side panel leaves visible, unless it is already in plain view */
function revealEl(row: Element | null, animate = true): void {
  if (!row) return;
  const area = viewport.getBoundingClientRect();
  const r = row.getBoundingClientRect();
  const covered = inspector.hidden ? 0 : inspector.offsetWidth;
  if (r.left >= area.left + 8 && r.right <= area.right - covered - 8 && r.top >= area.top + 8 && r.bottom <= area.bottom - 8) return;
  const cx = (r.left + r.width / 2 - area.left - panzoom.x) / panzoom.scale;
  const cy = (r.top + r.height / 2 - area.top - panzoom.y) / panzoom.scale;
  panzoom.centerOn(cx, cy, covered, animate);
}

// ---- the side panel's width, and the canvas it leaves ----

const zoomFloat = viewport.querySelector<HTMLElement>(".float.zoom")!;
const viewFloat = viewport.querySelector<HTMLElement>(".float.view")!;
const relatedFloat = byId("related-pill");
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
  // Names and loaded fonts change control widths even when the canvas stays the same size.
  const centeredLeft = (viewport.clientWidth - relatedFloat.offsetWidth) / 2;
  const viewRight = viewFloat.offsetLeft + viewFloat.offsetWidth;
  const pill = !inspector.hidden || centeredLeft < viewRight + 8 ? "below" : "";
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
const controlResize = new ResizeObserver(fitFloats);
controlResize.observe(viewFloat);
controlResize.observe(relatedFloat);
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
  top = Math.max(8, Math.min(top, area.height - h - 8));
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

function layoutStatus(message: string, busy = false): void {
  byId("layout-status").hidden = !message;
  byId("layout-message").textContent = message;
  byId("layout-cancel").hidden = !busy;
  byId("layout-retry").hidden = busy;
  viewport.setAttribute("aria-busy", String(busy));
}
byId("layout-cancel").addEventListener("click", () => { renderSeq++; analyzer.cancel(); renderer.cancel(); layoutStatus("Layout cancelled. Retry when ready."); setStale(true); });
byId("layout-retry").addEventListener("click", () => void render());
function modelForView(model: Model, current: SharedState): Model {
  let shown = model;
  if (current.related) shown = relatedModel(model, current.related.table, current.related.steps, current.view?.direction ?? "both");
  else if (current.service) shown = serviceModel(model, current.service);
  if (current.view?.path) {
    const path = relationPath(model, ...current.view.path);
    if (path) shown = subset(shown, new Set(path));
  }
  if (current.view?.services) shown = subset(shown, new Set(shown.tables.filter(t => !t.service || current.view!.services!.includes(t.service)).map(t => t.name)));
  if (current.view?.changesOnly && current.base != null) {
    const keep = new Set(model.tables.filter(t => t.change || t.columns.some(c => c.change)).map(t => t.name));
    for (const r of model.relations) if (r.change) { keep.add(r.parent); keep.add(r.child); }
    const changed = new Set(keep);
    for (const r of model.relations) if (changed.has(r.parent) || changed.has(r.child)) { keep.add(r.parent); keep.add(r.child); }
    shown = subset(shown, keep);
  }
  return shown;
}

/** How the canvas draws a state. Services folds every service while the whole schema is shown. A view
 *  of a part (one service, a table's neighbors, a path) is about tables, so it draws them in full there;
 *  one service's view folds the services it links to */
function drawing(model: Model, current: SharedState): Pick<SvgOptions, "columns" | "fold"> {
  const level = current.columns === "services" ? "all" : current.columns;
  if (current.service && !current.related) return { columns: level, fold: model.services.map((s) => s.name).filter((s) => s !== current.service) };
  if (current.columns !== "services" || current.related || current.view?.path) return { columns: level };
  return { columns: "none", fold: model.services.map((s) => s.name) };
}

async function render(): Promise<void> {
  const seq = ++renderSeq;
  renderer.cancel();
  layoutStatus("");
  try {
    layoutStatus("Reading the schema…", true);
    const result = await analyzer.analyze(state.code, state.base ?? null);
    if (seq !== renderSeq) return;
    editor.showDiagnostics([...result.diagnostics, ...result.findings]);
    showProblems(result.diagnostics, result.findings);
    if (!result.model) { layoutStatus(""); setStale(true); return; }
    const look = canvasLook();
    // All live backgrounds use the same SVG ink for a given light/dark mode.
    const svgLook = glass ? `aurora-${look.endsWith("dark") ? "dark" : "light"}` as SvgLook : look;
    const full = result.model;
    showCompare(result.changes);
    // The related view needs its table; when the table is renamed or removed, every table comes back
    if (state.related && !full.tables.some(t => t.name === state.related!.table)) {
      const legacy = full.tables.filter(t => t.label === state.related!.table);
      if (legacy.length === 1) state.related = { ...state.related, table: legacy[0].name };
    }
    if (state.related && !full.tables.some((t) => t.name === state.related!.table && (state.audit === "expand" || t.origin !== "audit"))) {
      state.related = null;
      save();
      scheduleHash();
    }
    // So does one service's view; and the Services level needs a service, or it is the names level
    if (state.service && !full.services.some((s) => s.name === state.service)) {
      state.service = null;
      save();
      scheduleHash();
    }
    byId("columns-services").hidden = full.services.length === 0;
    if (state.columns === "services" && full.services.length === 0) {
      state.columns = "none";
      syncControls();
      save();
      scheduleHash();
    }
    const key = JSON.stringify([result.modelKey, state.columns, state.audit, state.edges, state.related, state.service, state.view, svgLook, glass === null]);
    glass?.setLook(stageOf(look), glassOf(look));
    if (key === mountedKey) {
      layoutStatus(""); setStale(false);
      if (fitNext) { panzoom.fit(); fitNext = false; }
      return;
    }
    layoutStatus("Laying out the diagram…", true);
    const shown = modelForView(full, state);
    if (mountedModelKey !== result.modelKey) mountedViews.clear();
    const restored = mountedViews.get(key);
    const rendered = restored ?? await renderer.render(shown, {
      ...drawing(full, state),
      audit: state.audit,
      look: svgLook,
      stage: glass === null,
      edges: state.edges,
      idPrefix: "pg-",
    });
    if (seq !== renderSeq) return; // a newer render has started
    layoutStatus("");
    const { width, height, background, boxes } = rendered;
    viewport.style.backgroundColor = background ?? "";
    glass?.setLook(stageOf(look), glassOf(look));
    lastModel = full;
    drawnModel = shown;
    const empty = shown.tables.length === 0;
    byId("empty").hidden = !empty;
    byId("empty").textContent = full.tables.length ? "No tables match this view. Use Reset view to see all tables." : "Add a table, or paste SQL, to see it here.";
    focus?.clear();
    mountedViews.delete(key);
    if (currentDiagram && mountedModelKey === result.modelKey) rememberView(mountedKey, currentDiagram);
    if (restored) content.replaceChildren(...(restored.element ? [restored.element] : []));
    else content.innerHTML = empty ? "" : (rendered as SvgResult).svg;
    mountedKey = key;
    mountedModelKey = result.modelKey;
    tableElements = new Map([...content.querySelectorAll<SVGGElement>(".rz-t")].map(table => [table.dataset.t!, table]));
    panzoom.setSize(width, height);
    if (fitNext) {
      panzoom.fit();
      fitNext = false;
    }
    const drawn = content.querySelector("svg");
    // Rows open a popover on click; their native tooltips would only get in its way
    if (!restored) for (const title of content.querySelectorAll(".rz-c > title")) title.remove();
    currentDiagram = restored ?? { width, height, background, boxes, element: drawn, nodes: content.querySelectorAll("*").length };
    focus = drawn ? createFocus(drawn) : null;
    lastBoxes = empty ? [] : boxes;
    // Keep what was open, as long as it still exists
    if (inspected) showInspector(inspected);
    else if (inspectedService) showService(inspectedService);
    else if (sqlOpen) showSql();
    if (popped) showPop(popped.table, popped.column);
    if (popped) focus?.row(popped.table, popped.column);
    else settleFocus();
    glass?.setBoxes(lastBoxes, drawn);
    // One service's view counts the tables it draws in full, not the ones folded around it
    const inFull = (t: Model["tables"][number]) => !state.service || !t.service || t.service === state.service;
    const counted = (m: Model) => m.tables.filter((t) => (state.audit === "expand" || t.origin !== "audit") && (m === full || inFull(t))).length;
    const tables = counted(full);
    const drawnInFull = new Set(shown.tables.filter(inFull).map((t) => t.name));
    const relations = shown.relations.filter((r) => (state.audit === "expand" || r.origin !== "audit") && (drawnInFull.has(r.parent) || drawnInFull.has(r.child))).length;
    const tablesText = counted(shown) !== tables ? `${counted(shown)} of ${tables} tables` : `${tables} ${tables === 1 ? "table" : "tables"}`;
    const services = full.services.length;
    byId("stats").textContent = empty ? "" : drawing(full, state).fold && !state.service ? `${services} ${services === 1 ? "service" : "services"}, ${tablesText}` : `${tablesText}, ${relations} ${relations === 1 ? "relation" : "relations"}`;
    const filters = [state.view?.path && `Path: ${state.view.path.join(" → ")}`, state.view?.services && "Service filter", state.view?.changesOnly && "Changed tables and neighbors", state.related && state.view?.direction && state.view.direction !== "both" && `${state.view.direction} references`].filter(Boolean);
    byId("view-summary").hidden = filters.length === 0;
    byId("view-summary-text").textContent = filters.join(" / ");
    showRelated(Math.max(0, counted(shown) - 1), shown.tables.some((t) => !inFull(t) || (t.service === null && (state.audit === "expand" || t.origin !== "audit"))));
    setStale(false);
  } catch (e) {
    if (seq !== renderSeq) return;
    if (e instanceof DOMException && e.name === "AbortError") return;
    layoutStatus(e instanceof Error ? e.message : "Layout failed. Please retry.");
    setStale(true);
  }
}

let renderTimer = 0;
function scheduleRender(): void {
  renderSeq++; // Invalidate pending work as soon as the document changes.
  analyzer.cancel();
  renderer.cancel();
  clearTimeout(renderTimer);
  renderTimer = window.setTimeout(render, 120);
}

// ---- controls ----

function syncControls(): void {
  for (const b of document.querySelectorAll<HTMLButtonElement>("[data-columns]")) b.setAttribute("aria-pressed", String(b.dataset.columns === state.columns));
  for (const b of document.querySelectorAll<HTMLButtonElement>("[data-steps]")) b.setAttribute("aria-pressed", String(Number(b.dataset.steps) === state.related?.steps));
  byId("inspector-related").setAttribute("aria-pressed", String(inspectedService ? state.service === inspectedService : state.related !== null && state.related.table === inspected));
  byId("toggle-audit").setAttribute("aria-pressed", String(state.audit === "expand"));
  byId("grid-toggle").setAttribute("aria-pressed", String(state.grid));
  for (const b of document.querySelectorAll<HTMLButtonElement>("[data-edges]")) b.setAttribute("aria-pressed", String(b.dataset.edges === state.edges));
  viewport.classList.toggle("grid", state.grid);
  glass?.setGrid(state.grid);
  const select = byId<HTMLSelectElement>("example");
  const match = Object.entries(EXAMPLES).find(([, text]) => text === state.code);
  select.value = match ? match[0] : "";
}

function setView(change: Partial<Pick<typeof state, "columns" | "audit">>): Promise<void> {
  Object.assign(state, change);
  fitNext = true;
  syncControls();
  save();
  scheduleHash();
  return render();
}
for (const b of document.querySelectorAll<HTMLButtonElement>("[data-columns]"))
  b.addEventListener("click", () => {
    // Services is the whole schema by service: it leaves a view of a part
    if (b.dataset.columns === "services") Object.assign(state, { related: null, service: null });
    void setView({ columns: b.dataset.columns === "keys" || b.dataset.columns === "none" || b.dataset.columns === "services" ? b.dataset.columns : "all" });
  });

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
  if (related) state.service = null;
  fitNext = true;
  syncControls();
  save();
  scheduleHash();
  return render();
}

/** Draw only a service, with the services it links to folded, or every table again */
function setServiceOnly(service: string | null): Promise<void> {
  state.service = service;
  if (service) state.related = null;
  fitNext = true;
  syncControls();
  save();
  scheduleHash();
  return render();
}

/** The pill at the top of the canvas: what is shown, and the way back. `linked`: one service's view
 *  draws more than the service */
function showRelated(others: number, linked: boolean): void {
  const pill = byId("related-pill");
  const shown = state.related?.table ?? state.service ?? null;
  pill.hidden = shown === null;
  if (shown === null) return;
  // One service has no steps: it reaches as far as its references cross
  pill.querySelector<HTMLElement>(".seg")!.hidden = state.related === null;
  pill.setAttribute("aria-label", state.related ? "Related tables" : "One service");
  const name = document.createElement("b");
  name.textContent = shown;
  const long = document.createElement("span");
  long.className = "label-long";
  long.textContent = state.related
    ? others === 0 ? " joins no other table" : ` and ${others} related ${others === 1 ? "table" : "tables"}`
    : linked ? " and its neighbors" : " links to no other service";
  const short = document.createElement("span");
  short.className = "label-short";
  short.textContent = state.related ? ` +${others}` : "";
  byId("related-text").replaceChildren(name, long, short);
  fitFloats();
}

byId("inspector-related").addEventListener("click", () => {
  if (inspectedService) return void setServiceOnly(state.service === inspectedService ? null : inspectedService);
  if (!inspected) return;
  void setRelated(state.related?.table === inspected ? null : { table: inspected, steps: state.related?.steps ?? 1 });
});
byId("service-sql").addEventListener("click", () => {
  if (!inspectedService) return;
  sqlService = inspectedService;
  closePop();
  focus?.clear();
  showSql();
  inspectorBody.querySelector<HTMLElement>(`[data-dialect="${sqlDialect}"]`)?.focus();
});
for (const b of document.querySelectorAll<HTMLButtonElement>("[data-steps]"))
  b.addEventListener("click", () => {
    if (state.related) void setRelated({ table: state.related.table, steps: b.dataset.steps === "2" ? 2 : 1 });
  });
byId("related-all").addEventListener("click", () => void (state.service ? setServiceOnly(null) : setRelated(null)));

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
      row.addEventListener("click", (e) => void choose(h.table, e.shiftKey, e.detail !== 0));
      li.append(row);
      return li;
    }),
  );
  byId("palette-empty").hidden = hits.length > 0;
  paletteInput.setAttribute("aria-activedescendant", hits.length ? `pal-${active}` : "");
}

function openPalette(animate: boolean): void {
  if (!palette.hidden) return paletteInput.focus();
  const activeElement = document.activeElement;
  // Safari does not focus buttons on pointer clicks.
  paletteReturn = activeElement instanceof HTMLElement && activeElement !== document.body ? activeElement : findButton;
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

async function choose(table: string, related: boolean, animate = false): Promise<void> {
  const returnTo = paletteReturn;
  closePalette(false);
  if (related) {
    await setRelated({ table, steps: state.related?.steps ?? 1 });
    showInspector(table);
    focusTable(table);
    glass?.refresh();
  } else await openTable(table, animate);
  inspectorReturn = returnTo;
  byId("inspector-close").focus();
}

findButton.addEventListener("click", () => (palette.hidden ? openPalette(true) : closePalette(true)));
paletteInput.addEventListener("input", () => {
  active = 0;
  showHits();
});
paletteInput.addEventListener("keydown", (e) => {
  if (e.isComposing) return;
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
  openDocument(documents.create(`${key}.erd`, { ...state, code: EXAMPLES[key], related: null, service: null, base: null, view: {}, reading: false }));
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
byId("zoom-in").addEventListener("click", (e) => panzoom.zoomBy(1.25, undefined, undefined, e.detail !== 0));
byId("zoom-out").addEventListener("click", (e) => panzoom.zoomBy(0.8, undefined, undefined, e.detail !== 0));
byId("zoom-level").addEventListener("click", (e) => panzoom.actualSize(e.detail !== 0));
byId("zoom-fit").addEventListener("click", (e) => panzoom.fit(e.detail !== 0));
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
    else if (state.service) void setServiceOnly(null);
    settleFocus();
  });
});

byId("share").addEventListener("click", async () => {
  if (!(await writeHash())) return toast("Could not create a link. Please try again");
  await copy(location.href, "Link copied");
});

/** Files are plain (graphite) by default: no background, so they sit on any page. A glass look carries
 *  its background with it, as a still picture */
async function exportSvg(look: SvgLook): Promise<string | null> {
  // Export one snapshot of the current document and options, even while the canvas is laying out.
  const snapshot = { ...state, related: state.related ? { ...state.related } : null };
  const model = compile(snapshot.code).model;
  if (!model) {
    toast("Fix the errors before exporting the diagram");
    return null;
  }
  const base = snapshot.base !== null && snapshot.base !== undefined ? compile(snapshot.base).model : null;
  const full = base ? diff(base, model).model : model;
  const shown = modelForView(full, snapshot);
  try {
    const { svg } = await exporter.render(shown, { ...drawing(full, snapshot), audit: snapshot.audit, edges: snapshot.edges, look, standalone: true });
    return svg + "\n";
  } catch {
    toast("Could not export the diagram. Please try again");
    return null;
  }
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
const variantItems = [...downloadMenu.querySelectorAll<HTMLButtonElement>("[data-variant]")];
/** Every item, for the arrow keys */
const menuItems = [...downloadMenu.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')];
const lookOf = (variant: string): SvgLook => (variant === "plain" ? "graphite" : canvasLook(variant as "dark" | "light"));
function labelMenu(): void {
  for (const item of variantItems) {
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
for (const item of variantItems)
  item.addEventListener("click", () => {
    setMenu(false, true);
    download(lookOf(item.dataset.variant!));
  });
byId("download-sql").addEventListener("click", () => {
  setMenu(false);
  closePop();
  focus?.clear();
  if (inspector.hidden) inspectorReturn = downloadButton;
  showSql();
  inspectorBody.querySelector<HTMLElement>(`[data-dialect="${sqlDialect}"]`)?.focus();
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
  if (state.reading && !hide) return;
  if (animate && !matchMedia("(prefers-reduced-motion: reduce)").matches) {
    work.classList.add("is-moving");
    window.setTimeout(() => work.classList.remove("is-moving"), 300);
  }
  // Focus inside the pane would be lost when it goes inert: hand it to the button that brings it back
  const hadFocus = byId("source").contains(document.activeElement);
  work.classList.toggle("is-folded", hide);
  byId("source").toggleAttribute("inert", hide);
  byId("editor-show").hidden = !hide || state.reading === true;
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

// ---- formatting ----

/** Lay the document out as `resin fmt` does: one step to undo, the cursor where it was */
function formatSource(): void {
  if (state.reading) return;
  let result;
  try {
    result = format(editor.getText());
  } catch {
    toast("Could not format this document");
    return;
  }
  if (result.text === null) toast("Fix the errors first: only a document that parses can be formatted");
  else if (result.text === editor.getText()) toast("Already formatted");
  else editor.reformat(result.text);
}
byId("format-source").addEventListener("click", () => {
  formatSource();
  editor.view.focus();
});
// Shift + Alt + F, as in most editors. `code`, not `key`: on a Mac, Option turns F into another letter
document.addEventListener("keydown", (e) => {
  if (e.code !== "KeyF" || !e.shiftKey || !e.altKey || e.metaKey || e.ctrlKey) return;
  e.preventDefault();
  formatSource();
});
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

function showConverted(tables: number, raw: string, converted: string, sql: string, result: ReturnType<typeof fromSql>): void {
  rememberHint();
  const notes = result.notes.map(n => `SQL ${n.line}:${n.col} - ${n.message}`);
  documents.imported({ sql, source: result.source, notes: result.notes });
  conversion = { raw, converted, notes };
  const count = document.createElement("b");
  count.textContent = `${tables} ${tables === 1 ? "table" : "tables"}`;
  sqlText.replaceChildren("Converted ", count, " from SQL");
  sqlNotes.textContent = `${notes.length} ${notes.length === 1 ? "note" : "notes"}`;
  sqlNotes.hidden = false;
  sqlNotes.textContent = notes.length ? `${notes.length} notes / Review` : "Review import";
  sqlNotes.title = "Review the original SQL and all conversion notes";
  sqlUndo.hidden = false;
  sqlBar.dataset.state = "done";
  sqlBar.hidden = false;
}

/** After the conversion, an undo back to the plain paste closes the line. Any other edit drops Undo,
 *  which would no longer undo the conversion, and the line stays while a note is left to go to */
function followSqlBar(text: string): void {
  if (!conversion || text === conversion.converted) return;
  if (text === conversion.raw) closeSqlBar();
  else sqlUndo.hidden = true;
}

sqlUndo.addEventListener("click", () => {
  editor.undo();
  editor.view.focus();
});
sqlNotes.addEventListener("click", () => workspace.show("Import"));
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
  if (converted.tables === 0) {
    toast(converted.notes[0]?.message ?? "No tables found in this SQL");
    documents.imported({ sql: pasted, source: converted.source, notes: converted.notes });
    return null;
  }
  documents.checkpoint("Before SQL paste");
  const applied = (raw: string, after: string) => showConverted(converted.tables, raw, after, pasted, converted);
  if (whole || rest.trim() === "") {
    fitNext = true;
    return { text: converted.source, whole, applied };
  }
  // Into a document that has tables already: keep a blank line on either side
  return { text: `\n${converted.source}\n`, whole: false, applied };
}

// ---- boot ----

void showStars();

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

const workspace = createWorkspace({
  documents, state: () => state, model: () => lastModel,
  open: openDocument,
  edit: source => { editor.setText(source); fitNext = true; },
  // A view from Explore or Compare replaces one service's view unless it brings its own; a rename keeps it
  view: next => { Object.assign(state, "view" in next || "related" in next ? { service: null } : {}, next); fitNext = true; syncControls(); save(); scheduleHash(); void render(); },
  notify: toast,
  shareReading: async () => { const hash = await encode({ ...state, reading: true }); await copy(`${location.href.split("#")[0]}${hash}`, "Reading link copied"); },
});
byId("workspace-open").addEventListener("click", () => workspace.show("Documents"));
byId("view-reset").addEventListener("click", () => { state.view = {}; state.related = null; state.service = null; fitNext = true; save(); scheduleHash(); syncControls(); void render(); });
byId("explore-open").addEventListener("click", () => workspace.show("Explore"));
byId("edit-copy").addEventListener("click", () => {
  openDocument(documents.create(`${documents.activeInfo.title} copy`, { ...state, reading: false }));
  fold(false, false);
});
byId("download-source").addEventListener("click", () => saveFile(state.code, `${fileName(documents.activeInfo.title)}.erd`));
byId("download-png").addEventListener("click", async () => {
  const svg = await exportSvg(canvasLook());
  if (!svg) return;
  const url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
  try {
    const img = new Image(); img.src = url; await img.decode();
    const scale = Math.min(2, 8192 / Math.max(img.width, img.height), Math.sqrt(32_000_000 / (img.width * img.height)));
    const canvas = document.createElement("canvas"); canvas.width = Math.max(1, Math.round(img.width * scale)); canvas.height = Math.max(1, Math.round(img.height * scale));
    const ctx = canvas.getContext("2d"); if (!ctx) throw new Error("PNG export is unavailable");
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob(b => b ? resolve(b) : reject(new Error("PNG export failed")), "image/png"));
    saveFile(blob, `${fileName(documents.activeInfo.title)}.png`, "image/png");
  } catch { toast("Could not create the PNG. Try SVG instead."); }
  finally { URL.revokeObjectURL(url); }
});
function syncReading(): void {
  byId("edit-copy").hidden = !state.reading;
  byId("workspace-open").hidden = state.reading === true;
  if (state.reading) fold(true, false);
  byId("editor-show").hidden = !folded() || state.reading === true;
}
function openDocument(document: LocalDocument): void {
  Object.assign(state, { base: null, related: null, service: null, view: {}, reading: false }, upgraded(document.state));
  editor.resetText(state.code);
  closeSqlBar(); closeInspector(); closePop(); fitNext = true;
  syncControls(); syncReading(); save(); scheduleHash(); void render();
}
async function adopt(shared: Partial<typeof state> | null): Promise<void> {
  if (typeof shared?.code !== "string") return;
  // A link without one service's view shows the whole schema, whatever was open before
  const next = { ...state, service: null, ...shared };
  const active = documents.active;
  if (active.state.code !== next.code || state.reading !== next.reading) {
    documents.create("Shared schema", next);
  }
  Object.assign(state, next); editor.resetText(state.code); fitNext = true;
  syncControls(); syncReading(); save(); await render();
}
window.addEventListener("hashchange", async () => {
  clearTimeout(hashTimer);
  const generation = ++hashGeneration;
  const shared = upgraded(await decode(location.hash));
  if (generation === hashGeneration && shared) await adopt(shared);
});
(async () => {
  document.body.inert = true;
  try {
  try { await documents.connect(indexedDB); } catch { /* Local storage remains available when IndexedDB is blocked. */ }
  Object.assign(state, upgraded(documents.active.state));
  const localVisit = history.state?.resinDocument === documents.activeInfo.id;
  const shared = localVisit ? null : upgraded(await decode(location.hash));
  document.body.inert = false;
  if (shared) await adopt(shared);
  else { editor.resetText(state.code); syncControls(); syncReading(); save(); await render(); }
  } finally { document.body.inert = false; }
})();
