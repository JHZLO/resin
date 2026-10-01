// Model → SVG: the ERD resin draws itself.
//
// Steps: size every card → lay out with ELK (a port on every column row, orthogonal routing) → SVG string.
//
// Three looks share one layout and one card anatomy (a panel with modest corners, key labels in a
// gutter, orthogonal or curved connectors with square ends):
//   plain   paints nothing behind the drawing. Ink is currentColor, so it reads on any page; the
//           default for files.
//   dark    solid panels on a quiet dark stage (a base color, one faint glow, a dot grid).
//   light   the same on a light stage.
// The stage is drawn into the SVG for files. A live canvas passes `stage: false`, paints the stage
// itself (`stageOf(look)`) so it can extend past the drawing, and lays the SVG on top.
//
// The drawing is for reading: nothing in it is decoration. One accent color marks nullable columns;
// keys are told apart by weight, not by color.
//
// Output is deterministic. Text is never measured; widths follow fixed rules (monospace = cells ×
// 0.6em, proportional = 0.57em per Latin letter and 1em per CJK character). The same input gives the
// same SVG in a browser and on the command line.
//
// ELK is passed in, so the core does not depend on elkjs (zero runtime dependencies). Callers pass `new ELK()`.

import type { Model, ModelColumn, ModelTable, Relation } from "./model.ts";

export type SvgLook = "plain" | "dark" | "light";

export interface SvgOptions {
  /** all = every column, keys = key and reference columns only (the rest become "+N columns") */
  columns?: "all" | "keys";
  /** collapse = fold audit tables into a note on the audited table, expand = draw revinfo and *_aud */
  audit?: "collapse" | "expand";
  /** plain (default), dark or light */
  look?: SvgLook;
  /** plain only, for files: embed a <style> that picks the ink color for light and dark backgrounds */
  standalone?: boolean;
  /** dark and light: draw the stage behind the tables. Default true. A live canvas passes false and
   *  paints the stage itself from `stageOf(look)` */
  stage?: boolean;
  /** Connectors: angular (right-angled, the default) or curved */
  edges?: "angular" | "curved";
  /** Prefix for every id in the SVG, so several drawings can share a page. Default "rz-" */
  idPrefix?: string;
}

/** Where a table's card sits in the drawing */
export interface SvgBox {
  table: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface SvgResult {
  svg: string;
  width: number;
  height: number;
  /** The stage's base color, or null for plain */
  background: string | null;
  /** Every card, for pages that decorate or navigate the drawing */
  boxes: SvgBox[];
}

// Only the parts of ELK's graph format used here, declared structurally to avoid depending on elkjs types
interface Point {
  x: number;
  y: number;
}
interface ElkPortIn {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  layoutOptions: Record<string, string>;
}
interface ElkNodeIn {
  id: string;
  width: number;
  height: number;
  ports: ElkPortIn[];
  layoutOptions: Record<string, string>;
}
interface ElkGraphIn {
  id: string;
  layoutOptions: Record<string, string>;
  children: ElkNodeIn[];
  edges: { id: string; sources: string[]; targets: string[] }[];
}
interface ElkGraphOut {
  width?: number;
  height?: number;
  children?: { id: string; x?: number; y?: number }[];
  edges?: { id: string; sections?: { startPoint: Point; endPoint: Point; bendPoints?: Point[] }[] }[];
}
export interface ElkLike {
  layout(graph: ElkGraphIn): Promise<ElkGraphOut>;
}

// The platform's own faces: tuned for legibility, already on every reader's machine
const SANS = "system-ui, -apple-system, 'SF Pro Text', 'Segoe UI', 'Apple SD Gothic Neo', 'Noto Sans KR', sans-serif";
const MONO = "ui-monospace, 'SF Mono', Menlo, Consolas, monospace";

// ---- text width ----

/** Hangul Jamo, CJK radicals through Yi, Hangul syllables, CJK compatibility forms, fullwidth forms */
const WIDE: [number, number][] = [
  [0x1100, 0x11ff],
  [0x2e80, 0xa4cf],
  [0xac00, 0xd7af],
  [0xf900, 0xfaff],
  [0xfe30, 0xfe4f],
  [0xff00, 0xff60],
  [0xffe0, 0xffe6],
];
const isWide = (ch: string): boolean => {
  const c = ch.codePointAt(0) ?? 0;
  return WIDE.some(([a, b]) => c >= a && c <= b);
};
const cells = (s: string): number => [...s].reduce((n, ch) => n + (isWide(ch) ? 2 : 1), 0);
const monoW = (s: string, size: number): number => cells(s) * size * 0.6;
const sansW = (s: string, size: number): number => [...s].reduce((w, ch) => w + (isWide(ch) ? size : size * 0.57), 0);

const esc = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const f = (v: number): number => Math.round(v * 10) / 10;
const up8 = (v: number): number => Math.ceil(v / 8) * 8;
const maxOf = (xs: number[], floor = 0): number => xs.reduce((m, x) => Math.max(m, x), floor);

// ---- looks ----

/** A color and its opacity. Color may be "currentColor" */
export type Ink = readonly [string, number];

/** What stands behind the cards: a base color, one faint glow and a dot grid. It does not move */
export interface Stage {
  dark: boolean;
  base: string;
  /** One soft glow: [color, alpha, cx, cy, radius], relative to the drawing (or the view) */
  glow: readonly [string, number, number, number, number];
  /** Dots every GRID_STEP units */
  grid: Ink;
}

/** Three grays and one accent, plus the lines that structure a card */
interface Inks {
  text: Ink;
  muted: Ink;
  faint: Ink;
  sep: Ink;
  line: Ink;
  accent: Ink;
}

/** The card surface: a fill with a faint wash at the top, a semi-transparent edge and a soft shadow */
interface Panel {
  fill: Ink;
  wash: Ink;
  edge: Ink;
  shadow: Ink;
}

interface Look {
  ink: Inks;
  panel: Panel;
  stage: Stage | null;
}

export const GRID_STEP = 24;
/** Corner radius of a card. Modest on purpose: the drawing is a schematic */
export const CARD_RADIUS = 8;

const C = "currentColor";
const WHITE = "#FFFFFF";
const NIGHT = "#EDEDEB";
const DAY = "#17181B";

const LOOKS: Record<SvgLook, Look> = {
  plain: {
    ink: { text: [C, 1], muted: [C, 0.62], faint: [C, 0.42], sep: [C, 0.1], line: [C, 0.55], accent: [C, 1] },
    panel: { fill: [C, 0.05], wash: [C, 0.02], edge: [C, 0.24], shadow: ["#000000", 0.1] },
    stage: null,
  },
  dark: {
    ink: { text: [NIGHT, 1], muted: [NIGHT, 0.62], faint: [NIGHT, 0.42], sep: [NIGHT, 0.09], line: [NIGHT, 0.5], accent: ["#E0A84E", 1] },
    panel: { fill: ["#17181B", 0.96], wash: [WHITE, 0.035], edge: [WHITE, 0.09], shadow: ["#000000", 0.45] },
    stage: { dark: true, base: "#0B0C0E", glow: ["#E0A84E", 0.05, 0.15, 0.0, 0.7], grid: [WHITE, 0.07] },
  },
  light: {
    ink: { text: [DAY, 1], muted: [DAY, 0.62], faint: [DAY, 0.45], sep: [DAY, 0.08], line: [DAY, 0.5], accent: ["#A15C07", 1] },
    panel: { fill: [WHITE, 0.97], wash: [WHITE, 0], edge: [DAY, 0.09], shadow: [DAY, 0.1] },
    stage: { dark: false, base: "#F0F0ED", glow: ["#E0A84E", 0.06, 0.15, 0.0, 0.7], grid: [DAY, 0.1] },
  },
};

/** The stage a look stands on, for a page that paints it itself; null for plain */
export const stageOf = (look: SvgLook): Stage | null => LOOKS[look].stage;

const fill = ([c, a]: Ink): string => (a === 1 ? `fill="${c}"` : `fill="${c}" fill-opacity="${a}"`);
const stroke = ([c, a]: Ink): string => (a === 1 ? `stroke="${c}"` : `stroke="${c}" stroke-opacity="${a}"`);
const stop = (offset: number, [c, a]: Ink): string => `<stop offset="${offset}" stop-color="${c}" stop-opacity="${a}"/>`;

// ---- card metrics (on an 8-unit grid) ----

const PAD = 16;
const HEAD = 44;
const ROW = 28;
const FOOT = 18;
const RX = CARD_RADIUS;
/** Room for the key label (PK, UK, FK) before the column name */
const KEY = 26;

// Type sizes: 11 is the floor for anything a reader is meant to read
const NAME = 12.5;
const DESC = 11.5;
const TYPE = 11.5;
const NOTE = 11;
const KEYSIZE = 10;

interface View {
  table: ModelTable;
  shown: ModelColumn[];
  hidden: number;
  /** Columns of this table on the child side of a relation */
  refCols: Set<string>;
  /** A quiet note in the header: external, or how the table is audited */
  note: string | null;
  foot: string[];
  w: number;
  h: number;
  nameW: number;
}

/** What a column carries besides its key and type, as plain words */
function notes(c: ModelColumn, v: { refCols: Set<string> }): string {
  const out: string[] = [];
  if (c.pk && v.refCols.has(c.name)) out.push("fk");
  if (c.enumValues) out.push("enum");
  if (c.enc) out.push("enc");
  if (c.index) out.push("index");
  return out.join("  ");
}
const typeOf = (c: ModelColumn, t: ModelTable): string => c.type + (c.nullable && t.origin !== "audit" ? "?" : "");

function rowTitle(c: ModelColumn, t: ModelTable): string {
  const parts = [`${c.name} ${typeOf(c, t)}`];
  if (c.description) parts.push(c.description);
  if (c.enumValues) parts.push(c.enumValues.join(" / "));
  if (c.ukName) parts.push(`unique ${c.ukName}`);
  if (c.index) parts.push(`index${c.index.name ? " " + c.index.name : ""}`);
  if (c.ref) parts.push(`${c.ref.kind === "physical" ? "->" : "~>"} ${c.ref.table}.${c.ref.column}`);
  return parts.join("\n");
}

function measure(v: Omit<View, "w" | "h" | "nameW">): Pick<View, "w" | "h" | "nameW"> {
  const t = v.table;
  const nameW = maxOf(v.shown.map((c) => sansW(c.name, NAME) * (c.pk ? 1.04 : 1)), 48);
  const descW = maxOf(v.shown.map((c) => (c.description ? sansW(c.description, DESC) : 0)));
  const typeW = maxOf(v.shown.map((c) => monoW(typeOf(c, t), TYPE)), 40);
  const noteW = maxOf(v.shown.map((c) => (notes(c, v) ? sansW(notes(c, v), NOTE) + 12 : 0)));
  const rowW = PAD * 2 + KEY + nameW + (descW ? 14 + descW : 0) + 18 + noteW + typeW;
  const headW = PAD * 2 + sansW(t.name, 13.5) * 1.04 + 10 + (t.description ? sansW(t.description, 12) : 0) + (v.note ? 16 + sansW(v.note, NOTE) : 0);
  const footW = PAD * 2 + maxOf(v.foot.map((s) => monoW(s, NOTE)));
  return {
    w: up8(Math.max(rowW, headW, footW, 200)),
    h: up8(HEAD + v.shown.length * ROW + (v.foot.length ? v.foot.length * FOOT + 8 : 0) + 8),
    nameW,
  };
}

const rowY = (i: number): number => HEAD + 4 + i * ROW + ROW / 2;
/** The header's hit area: rounded top corners, square bottom */
const capPath = (w: number): string => `M0,${RX} A${RX},${RX} 0 0 1 ${RX},0 H${w - RX} A${RX},${RX} 0 0 1 ${w},${RX} V${HEAD} H0 Z`;

/** The key in the gutter. A primary key reads strongest; the others step back */
function keyLabel(c: ModelColumn, v: View, I: Inks): [string, Ink] | null {
  if (c.pk) return ["PK", I.text];
  if (c.uk) return ["UK", I.muted];
  if (v.refCols.has(c.name)) return ["FK", I.muted];
  return null;
}

/** The panel. A live canvas still gets panels from the SVG; only the stage is left to the page */
function panel(v: View, L: Look, id: (name: string) => string): string {
  const { w, h } = v;
  const dash = v.table.origin === "external" ? ' stroke-dasharray="5 4"' : "";
  return (
    `<rect width="${w}" height="${h}" rx="${RX}" ${fill(L.panel.fill)}/>` +
    (L.panel.wash[1] ? `<rect width="${w}" height="${h}" rx="${RX}" fill="url(#${id("wash")})"/>` : "") +
    `<rect x="0.5" y="0.5" width="${w - 1}" height="${h - 1}" rx="${RX - 0.5}" fill="none" ${stroke(L.panel.edge)}${dash}/>`
  );
}

function card(v: View, L: Look, id: (name: string) => string): string {
  const t = v.table;
  const I = L.ink;
  const { w } = v;
  const s: string[] = [panel(v, L, id)];

  // header: one group with its own hit area, so a click anywhere on it reaches it
  s.push(`<g class="rz-head"><path class="rz-hit" d="${capPath(w)}" fill="currentColor" fill-opacity="0"/>`);
  s.push(
    `<text x="${PAD}" y="27" font-size="13.5" font-weight="600" letter-spacing="-0.01em" ${fill(I.text)}>${esc(t.name)}` +
      (t.description ? `<tspan dx="10" font-size="12" font-weight="400" letter-spacing="0" ${fill(I.muted)}>${esc(t.description)}</tspan>` : "") +
      "</text>",
  );
  if (v.note) s.push(`<text x="${w - PAD}" y="27" text-anchor="end" font-size="${NOTE}" ${fill(I.faint)}>${esc(v.note)}</text>`);
  s.push("</g>");
  s.push(`<rect x="1" y="${HEAD - 0.5}" width="${w - 2}" height="1" ${fill(I.sep)}/>`);

  // rows
  v.shown.forEach((c, i) => {
    const cy = rowY(i);
    const by = cy + 4.2;
    s.push(`<g class="rz-c" data-c="${esc(c.name)}"><title>${esc(rowTitle(c, t))}</title>`);
    s.push(`<rect class="rz-hit" x="1" y="${f(cy - ROW / 2)}" width="${w - 2}" height="${ROW}" fill="currentColor" fill-opacity="0"/>`);
    if (i > 0) s.push(`<rect x="${PAD}" y="${f(cy - ROW / 2)}" width="${w - PAD * 2}" height="1" ${fill(I.sep)} opacity=".7"/>`);
    const key = keyLabel(c, v, I);
    if (key) s.push(`<text x="${PAD}" y="${f(by - 0.8)}" font-size="${KEYSIZE}" font-weight="600" letter-spacing="0.02em" ${fill(key[1])}>${key[0]}</text>`);
    s.push(`<text x="${PAD + KEY}" y="${f(by)}" font-size="${NAME}" ${fill(I.text)}${c.pk ? ' font-weight="600"' : ""}>${esc(c.name)}</text>`);
    if (c.description) s.push(`<text x="${f(PAD + KEY + v.nameW + 14)}" y="${f(by)}" font-size="${DESC}" ${fill(I.muted)}>${esc(c.description)}</text>`);
    const right = w - PAD;
    const nullable = c.nullable && t.origin !== "audit";
    // The one accent in the drawing marks a nullable column
    s.push(
      `<text x="${right}" y="${f(by)}" text-anchor="end" font-family="${MONO}" font-size="${TYPE}" ${fill(I.muted)}>${esc(c.type)}` +
        (nullable ? `<tspan ${fill(I.accent)} font-weight="700">?</tspan>` : "") +
        "</text>",
    );
    const n = notes(c, v);
    if (n) s.push(`<text x="${f(right - monoW(typeOf(c, t), TYPE) - 12)}" y="${f(by)}" text-anchor="end" font-size="${NOTE}" ${fill(I.faint)} xml:space="preserve">${n}</text>`);
    s.push("</g>");
  });

  if (v.foot.length) {
    const fy = HEAD + 4 + v.shown.length * ROW + 4;
    s.push(`<rect x="${PAD}" y="${fy}" width="${w - PAD * 2}" height="1" ${fill(I.sep)}/>`);
    v.foot.forEach((line, k) =>
      s.push(`<text x="${PAD}" y="${f(fy + 15 + k * FOOT)}" font-family="${MONO}" font-size="${NOTE}" ${fill(I.faint)}>${esc(line)}</text>`),
    );
  }
  return s.join("");
}

// ---- connectors ----

/** Round the bends of an orthogonal path with radius r */
function pathD(pts: Point[], r: number): string {
  let d = `M${f(pts[0].x)},${f(pts[0].y)}`;
  for (let i = 1; i < pts.length - 1; i++) {
    const [p0, p1, p2] = [pts[i - 1], pts[i], pts[i + 1]];
    const d1 = Math.hypot(p1.x - p0.x, p1.y - p0.y);
    const d2 = Math.hypot(p2.x - p1.x, p2.y - p1.y);
    const rr = Math.min(r, d1 / 2, d2 / 2);
    const a = { x: p1.x - ((p1.x - p0.x) / d1) * rr, y: p1.y - ((p1.y - p0.y) / d1) * rr };
    const b = { x: p1.x + ((p2.x - p1.x) / d2) * rr, y: p1.y + ((p2.y - p1.y) / d2) * rr };
    d += ` L${f(a.x)},${f(a.y)} Q${f(p1.x)},${f(p1.y)} ${f(b.x)},${f(b.y)}`;
  }
  const last = pts[pts.length - 1];
  return `${d} L${f(last.x)},${f(last.y)}`;
}

/** A curved connector: an S-bend with level ends when no other card is in the way, otherwise ELK's
 *  route (which goes around the cards) with wide, smooth bends */
function curved(route: Point[], others: SvgBox[]): string {
  const s = route[0];
  const e = route[route.length - 1];
  const dx = e.x - s.x;
  if (dx > 24) {
    const k = Math.max(32, Math.min(180, dx * 0.5));
    const c1 = { x: s.x + k, y: s.y };
    const c2 = { x: e.x - k, y: e.y };
    const blocked = others.some((b) => {
      for (let i = 1; i < 24; i++) {
        const t = i / 24;
        const u = 1 - t;
        const x = u * u * u * s.x + 3 * u * u * t * c1.x + 3 * u * t * t * c2.x + t * t * t * e.x;
        const y = u * u * u * s.y + 3 * u * u * t * c1.y + 3 * u * t * t * c2.y + t * t * t * e.y;
        if (x > b.x - 6 && x < b.x + b.w + 6 && y > b.y - 6 && y < b.y + b.h + 6) return true;
      }
      return false;
    });
    if (!blocked) return `M${f(s.x)},${f(s.y)} C${f(c1.x)},${f(c1.y)} ${f(c2.x)},${f(c2.y)} ${f(e.x)},${f(e.y)}`;
  }
  return pathD(route, 40);
}

/** Drop repeated points and points in the middle of a straight run, so no corner is rounded mid-line */
function clean(pts: Point[]): Point[] {
  const same = (a: number, b: number) => Math.abs(a - b) < 0.01;
  const out: Point[] = [];
  for (const p of pts) {
    const q = out[out.length - 1];
    if (!q || !same(q.x, p.x) || !same(q.y, p.y)) out.push(p);
  }
  for (let i = out.length - 2; i > 0; i--) {
    const [a, b, c] = [out[i - 1], out[i], out[i + 1]];
    if ((same(a.x, b.x) && same(b.x, c.x)) || (same(a.y, b.y) && same(b.y, c.y))) out.splice(i, 1);
  }
  return out;
}

// ---- assembly ----

function views(model: Model, opts: { columns: "all" | "keys"; audit: "collapse" | "expand" }): { views: View[]; relations: Relation[] } {
  const expand = opts.audit === "expand";
  const tables = model.tables.filter((t) => expand || t.origin !== "audit");
  const names = new Set(tables.map((t) => t.name));
  const relations = model.relations.filter((r) => names.has(r.parent) && names.has(r.child));
  const referenced = new Set(relations.map((r) => `${r.parent}.${r.parentColumn}`));
  const out = tables.map((table) => {
    const refCols = new Set(relations.filter((r) => r.child === table.name).map((r) => r.childColumn));
    const isKey = (c: ModelColumn) => c.pk || c.uk || refCols.has(c.name) || referenced.has(`${table.name}.${c.name}`);
    const shown = opts.columns === "keys" ? table.columns.filter(isKey) : table.columns;
    const hidden = table.columns.length - shown.length;
    const note =
      table.origin === "external"
        ? "external"
        : table.origin === "audit" || (table.audit && !expand)
          ? `audited, ${table.audit?.method ?? "envers"}`
          : null;
    const foot = table.constraints.map((k) => `${k.name ?? (k.kind === "unique" ? "unique" : "index")} (${k.columns.join(", ")})`);
    if (hidden) foot.push(`+${hidden} ${hidden === 1 ? "column" : "columns"}`);
    const base = { table, shown, hidden, refCols, note, foot };
    return { ...base, ...measure(base) };
  });
  return { views: out, relations };
}

const STANDALONE_STYLE = "<style>.rz{color:#1f2328}@media (prefers-color-scheme:dark){.rz{color:#e6edf3}}</style>";

function cardDefs(L: Look, id: (name: string) => string): string {
  const s: string[] = [];
  if (L.panel.wash[1]) s.push(`<linearGradient id="${id("wash")}" x1="0" y1="0" x2="0" y2="1">${stop(0, L.panel.wash)}${stop(1, [L.panel.wash[0], 0])}</linearGradient>`);
  // A wide, soft shadow and a tight contact one, both semi-transparent
  const [sc, sa] = L.panel.shadow;
  s.push(
    `<filter id="${id("shadow")}" x="-30%" y="-30%" width="160%" height="180%">` +
      `<feGaussianBlur in="SourceAlpha" stdDeviation="14"/><feOffset dy="10" result="a"/>` +
      `<feFlood flood-color="${sc}" flood-opacity="${sa}"/><feComposite in2="a" operator="in" result="ambient"/>` +
      `<feGaussianBlur in="SourceAlpha" stdDeviation="1"/><feOffset dy="1" result="c"/>` +
      `<feFlood flood-color="${sc}" flood-opacity="${Math.round(sa * 600) / 1000}"/><feComposite in2="c" operator="in" result="contact"/>` +
      `<feMerge><feMergeNode in="ambient"/><feMergeNode in="contact"/></feMerge>` +
      `<feComposite in2="SourceAlpha" operator="out"/></filter>`,
  );
  return s.join("");
}

/** The stage for files: base, one faint glow and a dot grid, sized to the drawing */
function stageSvg(S: Stage, id: (name: string) => string, W: number, H: number): { defs: string; body: string } {
  const R = Math.max(W, H);
  const [gc, ga, cx, cy, r] = S.glow;
  const step = GRID_STEP;
  const defs =
    `<radialGradient id="${id("glow")}" gradientUnits="userSpaceOnUse" cx="${f(cx * W)}" cy="${f(cy * H)}" r="${f(r * R)}">` +
    `<stop offset="0" stop-color="${gc}" stop-opacity="${ga}"/><stop offset="1" stop-color="${gc}" stop-opacity="0"/></radialGradient>` +
    `<pattern id="${id("grid")}" width="${step}" height="${step}" x="${-step / 2}" y="${-step / 2}" patternUnits="userSpaceOnUse">` +
    `<rect x="${step / 2 - 0.6}" y="${step / 2 - 0.6}" width="1.2" height="1.2" ${fill(S.grid)}/></pattern>`;
  const body =
    `<g class="rz-stage"><rect width="${W}" height="${H}" fill="${S.base}"/>` +
    `<rect width="${W}" height="${H}" fill="url(#${id("glow")})"/>` +
    `<rect class="rz-grid" width="${W}" height="${H}" fill="url(#${id("grid")})"/></g>`;
  return { defs, body };
}

export async function toSvg(model: Model, elk: ElkLike, options: SvgOptions = {}): Promise<SvgResult> {
  const opts = { columns: options.columns ?? "all", audit: options.audit ?? "collapse" } as const;
  const look = options.look ?? "plain";
  const edges = options.edges ?? "angular";
  const L = LOOKS[look];
  const prefix = options.idPrefix ?? "rz-";
  const id = (name: string) => prefix + name;
  const { views: vs, relations } = views(model, opts);
  const byName = new Map(vs.map((v) => [v.table.name, v]));
  const portId = (table: string, column: string, side: "E" | "W") => `${table}::${column}::${side}`;
  const used = new Set(relations.flatMap((r) => [portId(r.parent, r.parentColumn, "E"), portId(r.child, r.childColumn, "W")]));

  const graph: ElkGraphIn = {
    id: "root",
    layoutOptions: {
      "elk.algorithm": "layered",
      "elk.direction": "RIGHT",
      "elk.edgeRouting": "ORTHOGONAL",
      "elk.layered.spacing.nodeNodeBetweenLayers": "88",
      "elk.layered.spacing.edgeNodeBetweenLayers": "36",
      "elk.spacing.nodeNode": "40",
      "elk.spacing.edgeEdge": "14",
      "elk.spacing.edgeNode": "24",
      "elk.spacing.componentComponent": "56",
      "elk.layered.considerModelOrder.strategy": "NODES_AND_EDGES",
      "elk.layered.nodePlacement.strategy": "BRANDES_KOEPF",
      "elk.padding": "[top=40,left=40,bottom=40,right=40]",
    },
    children: vs.map((v) => ({
      id: v.table.name,
      width: v.w,
      height: v.h,
      layoutOptions: { "elk.portConstraints": "FIXED_POS" },
      ports: v.shown.flatMap((c, i) =>
        (
          [
            ["W", 0, "WEST"],
            ["E", v.w, "EAST"],
          ] as const
        )
          .filter(([side]) => used.has(portId(v.table.name, c.name, side)))
          .map(([side, x, elkSide]) => ({
            id: portId(v.table.name, c.name, side),
            x,
            y: rowY(i),
            width: 0,
            height: 0,
            layoutOptions: { "elk.port.side": elkSide },
          })),
      ),
    })),
    edges: relations.map((r, i) => ({
      id: `e${i}`,
      sources: [portId(r.parent, r.parentColumn, "E")],
      targets: [portId(r.child, r.childColumn, "W")],
    })),
  };

  const g = await elk.layout(graph);
  const pos = new Map((g.children ?? []).map((n) => [n.id, { x: n.x ?? 0, y: n.y ?? 0 }]));
  const W = Math.ceil(g.width ?? 0);
  const H = Math.ceil(g.height ?? 0);
  const boxes: SvgBox[] = vs.map((v) => {
    const p = pos.get(v.table.name)!;
    return { table: v.table.name, x: f(p.x), y: f(p.y), w: v.w, h: v.h };
  });
  const stage = L.stage && options.stage !== false ? stageSvg(L.stage, id, W, H) : null;

  const s: string[] = [];
  const label = `ERD: ${vs.map((v) => v.table.name).join(", ")}`;
  s.push(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" class="rz rz-${look}" role="img" aria-label="${esc(label)}" font-family="${SANS}" font-size="12">`,
  );
  if (options.standalone && !L.stage) s.push(STANDALONE_STYLE);
  s.push(`<title>${esc(label)}</title>`);
  s.push(`<defs>${cardDefs(L, id)}${stage?.defs ?? ""}</defs>`);
  if (stage) s.push(stage.body);
  // Shadows first, under the panels. The filter only uses the shape's alpha, so the fill color is
  // irrelevant. Each carries its table's data-t, so a viewer can fade it with the card
  s.push('<g class="rz-shadows">');
  for (const b of boxes)
    s.push(`<rect class="rz-s" data-t="${esc(b.table)}" x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}" rx="${RX}" fill="currentColor" filter="url(#${id("shadow")})"/>`);
  s.push("</g>");

  s.push('<g class="rz-rels">');
  (g.edges ?? []).forEach((e, i) => {
    const r = relations[i];
    const sec = e.sections?.[0];
    const pv = byName.get(r.parent)!;
    const cv = byName.get(r.child)!;
    const pp = pos.get(r.parent)!;
    const cp = pos.get(r.child)!;
    // Endpoints snap to the row anchors rather than ELK's coordinates: an endpoint is always an anchor
    const start = { x: pp.x + pv.w, y: pp.y + rowY(pv.shown.findIndex((c) => c.name === r.parentColumn)) };
    const end = { x: cp.x, y: cp.y + rowY(cv.shown.findIndex((c) => c.name === r.childColumn)) };
    const route = clean([start, ...(sec?.bendPoints ?? []), end]);
    const d = edges === "curved" ? curved(route, boxes.filter((b) => b.table !== r.parent && b.table !== r.child)) : pathD(route, 3);
    const dash = r.kind === "logical" ? ' stroke-dasharray="4 3"' : "";
    const ink = L.ink.line;
    s.push(`<g class="rz-r" data-a="${esc(r.parent)}" data-ac="${esc(r.parentColumn)}" data-b="${esc(r.child)}" data-bc="${esc(r.childColumn)}">`);
    s.push(`<path d="${d}" fill="none" ${stroke(ink)} stroke-width="1.2"${dash}/>`);
    // Primary key end: a chevron, like resin's `->`. Foreign key end: a square port and N (many) or 1 (one)
    s.push(
      `<path d="M${f(start.x + 6.5)},${f(start.y - 4.5)} L${f(start.x + 1.5)},${f(start.y)} L${f(start.x + 6.5)},${f(start.y + 4.5)}" fill="none" ${stroke(ink)} stroke-width="1.3"/>`,
    );
    s.push(`<rect x="${f(end.x - 2.5)}" y="${f(end.y - 2.5)}" width="5" height="5" ${fill(ink)}/>`);
    s.push(`<text x="${f(end.x - 9)}" y="${f(end.y - 5)}" text-anchor="end" font-family="${MONO}" font-size="10" ${fill(ink)}>${r.one ? "1" : "N"}</text>`);
    s.push("</g>");
  });
  s.push("</g>", '<g class="rz-tables">');
  vs.forEach((v, i) => {
    const b = boxes[i];
    s.push(`<g class="rz-t" data-t="${esc(v.table.name)}" transform="translate(${b.x},${b.y})">${card(v, L, id)}</g>`);
  });
  s.push("</g></svg>");
  return { svg: s.join(""), width: W, height: H, background: L.stage?.base ?? null, boxes };
}
