// The playground app: an editor on the left, the diagram on the right, both kept in sync.
// Every change recompiles; errors show up as lint marks and in the problems list, and the diagram
// keeps the last valid drawing (dimmed) until the source compiles again.

import ELK from "elkjs/lib/elk.bundled.js";
import orderExample from "../examples/order.erd";
import shopExample from "../examples/shop.erd";
import { type Diagnostic, type Model, type SvgLook, compile, toSvg } from "../src/index.ts";
import { glassOf, stageOf } from "../src/svg.ts";
import { createEditor } from "./editor.ts";
import { LiveGlass } from "./glass.ts";
import { type SharedState, decode, encode } from "./share.ts";
import { type Focus, PanZoom, createFocus } from "./view.ts";

const EXAMPLES: Record<string, string> = {
  order: orderExample,
  shop: shopExample,
  blank: 'table things "Start here" {\n  id    bigint       pk\n  name  varchar(100)\n}\n',
};
const STORE = "resin.playground";
const THEME_STORE = "resin.theme";
const STAGE_STORE = "resin.stage";

/** The canvas's background themes; each has a dark and a light version that follows the page theme */
const STAGES = { aurora: "Aurora", silk: "Silk", caustic: "Caustic" } as const;
type StageName = keyof typeof STAGES;

const byId = <T extends HTMLElement = HTMLElement>(id: string): T => document.getElementById(id) as T;

const state: SharedState & { grid: boolean } = { code: EXAMPLES.order, columns: "all", audit: "collapse", grid: true };
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
  const hash = await encode({ code: state.code, columns: state.columns, audit: state.audit });
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

function showProblems(ds: Diagnostic[]): void {
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
  },
  (target, x, y) => {
    focus?.tap(target);
    glass?.refresh();
    glass?.ripple(x, y);
  },
);

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
    focus = drawn ? createFocus(drawn) : null;
    lastBoxes = empty ? [] : boxes;
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
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  focus?.clear();
  glass?.refresh();
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
  const { svg } = await toSvg(lastModel, elk, { columns: state.columns, audit: state.audit, look, standalone: true });
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
    // The live canvas rests while the Mermaid tab covers it
    glass?.pause(tab.id !== "tab-diagram");
    if (tab.id === "tab-diagram") requestAnimationFrame(() => panzoom.fit());
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

// ---- boot ----

const editor = createEditor(byId("editor"), state.code, (text) => {
  state.code = text;
  save();
  scheduleHash();
  scheduleRender();
});

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
