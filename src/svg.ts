// Model → SVG: the ERD resin draws itself, in a "glass" design.
//
// Steps: size every card → lay out with ELK (a port on every column row, orthogonal routing) → SVG string.
//
// Three looks share one layout and one card anatomy:
//   graphite  no background of its own. Ink is currentColor, so the drawing reads on any page; the
//             default for files (README, wikis).
//   aurora    dark glass over an aurora backdrop drawn inside the SVG.
//   clear     light glass over a pastel backdrop drawn inside the SVG.
// Glass needs something behind it: aurora and clear show a blurred copy of their backdrop through the
// cards (one blur for the whole drawing, masked by every card).
//
// Output is deterministic. Text is never measured; widths follow fixed rules (monospace = cells ×
// 0.6em, proportional = 0.57em per Latin letter and 1em per CJK character). The same input gives the
// same SVG in a browser and on the command line.
//
// ELK is passed in, so the core does not depend on elkjs (zero runtime dependencies). Callers pass `new ELK()`.

import type { Model, ModelColumn, ModelTable, Relation } from "./model.ts";

export type SvgLook = "graphite" | "aurora" | "clear";

export interface SvgOptions {
  /** all = every column, keys = key and reference columns only (the rest become "+N columns") */
  columns?: "all" | "keys";
  /** collapse = fold audit tables into a tag on the audited table, expand = draw revinfo and *_aud */
  audit?: "collapse" | "expand";
  /** graphite (default), aurora or clear */
  look?: SvgLook;
  /** graphite only, for files: embed a <style> that picks the ink color for light and dark backgrounds */
  standalone?: boolean;
  /** aurora and clear: paint the backdrop this many pixels beyond the drawing (with overflow visible),
   *  for canvases that pan and zoom. 0 keeps the backdrop inside the drawing */
  bleed?: number;
  /** Prefix for every id in the SVG, so several drawings can share a page. Default "rz-" */
  idPrefix?: string;
}

export interface SvgResult {
  svg: string;
  width: number;
  height: number;
  /** The base color the drawing paints behind itself, or null when it paints nothing (graphite) */
  background: string | null;
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

const SANS = "-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Geist', 'Segoe UI', 'Apple SD Gothic Neo', 'Noto Sans KR', system-ui, sans-serif";
const MONO = "'SF Mono', 'Geist Mono', ui-monospace, Menlo, Consolas, monospace";

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
type Ink = readonly [string, number];

interface Look {
  /** The backdrop: base color, color blobs [color, alpha, cx, cy, radius] relative to the drawing, dot grid */
  backdrop: { base: string; blobs: readonly (readonly [string, number, number, number, number])[]; dots: Ink } | null;
  frost: { blur: number; saturate: number } | null;
  veil: Ink | null;
  fillTop: Ink;
  fillBottom: Ink;
  capTop: Ink;
  capBottom: Ink;
  rim: readonly [Ink, Ink, Ink];
  inner: Ink;
  outline: Ink | null;
  highlight: number;
  /** [color, alpha, offset y, blur] */
  shadow: readonly [string, number, number, number];
  text: Ink;
  muted: Ink;
  faint: Ink;
  type: Ink;
  sep: Ink;
  pk: Ink;
  uk: Ink;
  fk: Ink;
  nullable: Ink;
  line: Ink;
  /** A soft halo under connectors and key dots, or null */
  glow: Ink | null;
  chip: Ink;
  chipRim: Ink;
  chipText: Ink;
}

const C = "currentColor";
const WHITE = "#FFFFFF";

const LOOKS: Record<SvgLook, Look> = {
  graphite: {
    backdrop: null,
    frost: null,
    veil: null,
    fillTop: [C, 0.085],
    fillBottom: [C, 0.025],
    capTop: [C, 0.06],
    capBottom: [C, 0],
    rim: [[WHITE, 0.5], [C, 0.1], [C, 0.22]],
    inner: [C, 0.04],
    outline: null,
    highlight: 0.5,
    shadow: ["#000000", 0.22, 12, 14],
    text: [C, 1],
    muted: [C, 0.58],
    faint: [C, 0.4],
    type: [C, 0.62],
    sep: [C, 0.09],
    pk: [C, 1],
    uk: [C, 0.85],
    fk: [C, 0.5],
    nullable: [C, 1],
    line: [C, 0.55],
    glow: null,
    chip: [C, 0.06],
    chipRim: [C, 0.14],
    chipText: [C, 0.7],
  },
  aurora: {
    backdrop: {
      base: "#080C18",
      blobs: [
        ["#6D5BFF", 0.5, 0.1, 0.12, 0.55],
        ["#22D3EE", 0.3, 0.92, 0.18, 0.5],
        ["#F472B6", 0.28, 0.62, 1.0, 0.55],
        ["#34D399", 0.18, 0.08, 0.92, 0.45],
      ],
      dots: [WHITE, 0.09],
    },
    frost: { blur: 20, saturate: 1.15 },
    veil: ["#0A0F1F", 0.42],
    fillTop: [WHITE, 0.13],
    fillBottom: [WHITE, 0.035],
    capTop: [WHITE, 0.09],
    capBottom: [WHITE, 0.02],
    rim: [[WHITE, 0.7], [WHITE, 0.1], [WHITE, 0.32]],
    inner: [WHITE, 0.06],
    outline: null,
    highlight: 0.75,
    shadow: ["#000000", 0.55, 16, 18],
    text: ["#F5F7FF", 1],
    muted: ["#E1E7FF", 0.6],
    faint: ["#E1E7FF", 0.38],
    type: ["#E1E7FF", 0.66],
    sep: [WHITE, 0.08],
    pk: ["#FCD34D", 1],
    uk: ["#C4B5FD", 1],
    fk: ["#67E8F9", 0.75],
    nullable: ["#FCD34D", 1],
    line: ["#E5EAFF", 0.62],
    glow: ["#B9C4FF", 0.22],
    chip: [WHITE, 0.09],
    chipRim: [WHITE, 0.16],
    chipText: ["#E1E7FF", 0.78],
  },
  clear: {
    backdrop: {
      base: "#EDF0F7",
      blobs: [
        ["#A5B4FC", 0.85, 0.08, 0.1, 0.55],
        ["#F9A8D4", 0.7, 0.95, 0.15, 0.5],
        ["#5EEAD4", 0.55, 0.72, 1.0, 0.55],
        ["#FCD34D", 0.45, 0.15, 0.95, 0.45],
      ],
      dots: ["#1E293B", 0.09],
    },
    frost: { blur: 20, saturate: 1.5 },
    veil: null,
    fillTop: [WHITE, 0.66],
    fillBottom: [WHITE, 0.4],
    capTop: [WHITE, 0.5],
    capBottom: [WHITE, 0.1],
    rim: [[WHITE, 1], [WHITE, 0.55], [WHITE, 0.9]],
    inner: [WHITE, 0.35],
    outline: ["#0F172A", 0.1],
    highlight: 1,
    shadow: ["#1E293B", 0.2, 14, 16],
    text: ["#0B1020", 1],
    muted: ["#0B1020", 0.56],
    faint: ["#0B1020", 0.38],
    type: ["#0B1020", 0.62],
    sep: ["#0F172A", 0.07],
    pk: ["#D97706", 1],
    uk: ["#7C3AED", 1],
    fk: ["#0891B2", 0.75],
    nullable: ["#D97706", 1],
    line: ["#1E293B", 0.5],
    glow: null,
    chip: [WHITE, 0.75],
    chipRim: ["#0F172A", 0.08],
    chipText: ["#0B1020", 0.62],
  },
};

const fill = ([c, a]: Ink): string => (a === 1 ? `fill="${c}"` : `fill="${c}" fill-opacity="${a}"`);
const stroke = ([c, a]: Ink): string => (a === 1 ? `stroke="${c}"` : `stroke="${c}" stroke-opacity="${a}"`);
const stop = (offset: number, [c, a]: Ink): string => `<stop offset="${offset}" stop-color="${c}" stop-opacity="${a}"/>`;

// ---- card metrics (on an 8-unit grid) ----

const PAD = 16;
const HEAD = 46;
const ROW = 28;
const FOOT = 18;
const RX = 14;

interface View {
  table: ModelTable;
  shown: ModelColumn[];
  hidden: number;
  /** Columns of this table on the child side of a relation */
  refCols: Set<string>;
  tag: string | null;
  foot: string[];
  w: number;
  h: number;
  nameW: number;
}

function chips(c: ModelColumn, v: { refCols: Set<string> }): string[] {
  const out: string[] = [];
  if (c.pk && v.refCols.has(c.name)) out.push("fk");
  if (c.enumValues) out.push("enum");
  if (c.enc) out.push("enc");
  if (c.index) out.push("ix");
  return out;
}
const chipW = (text: string): number => monoW(text, 9.5) + 12;
const chipsW = (list: string[]): number => (list.length ? list.reduce((w, x) => w + chipW(x) + 4, 0) + 6 : 0);
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
  const nameW = maxOf(v.shown.map((c) => sansW(c.name, 12.5) + (c.pk ? 4 : 0)), 48);
  const descW = maxOf(v.shown.map((c) => (c.description ? sansW(c.description, 11.5) : 0)));
  const typeW = maxOf(v.shown.map((c) => monoW(typeOf(c, t), 11)), 40);
  const chipW_ = maxOf(v.shown.map((c) => chipsW(chips(c, v))));
  const rowW = PAD * 2 + 20 + nameW + (descW ? 14 + descW : 0) + 18 + chipW_ + typeW;
  const headW = PAD * 2 + sansW(t.name, 14) + 10 + (t.description ? sansW(t.description, 12) : 0) + (v.tag ? 14 + chipW(v.tag) : 0);
  const footW = PAD * 2 + maxOf(v.foot.map((s) => sansW(s, 10.5)));
  return {
    w: up8(Math.max(rowW, headW, footW, 200)),
    h: up8(HEAD + v.shown.length * ROW + (v.foot.length ? v.foot.length * FOOT + 8 : 0) + 8),
    nameW,
  };
}

const rowY = (i: number): number => HEAD + 4 + i * ROW + ROW / 2;
/** The header's shape: rounded top corners, square bottom */
const capPath = (w: number): string => `M0,${RX} A${RX},${RX} 0 0 1 ${RX},0 H${w - RX} A${RX},${RX} 0 0 1 ${w},${RX} V${HEAD} H0 Z`;

function chip(text: string, x: number, y: number, L: Look): string {
  const w = chipW(text);
  return (
    `<g transform="translate(${f(x)},${f(y)})"><rect width="${f(w)}" height="15" rx="7.5" ${fill(L.chip)} ${stroke(L.chipRim)}/>` +
    `<text x="${f(w / 2)}" y="10.6" text-anchor="middle" font-family="${MONO}" font-size="9.5" ${fill(L.chipText)}>${esc(text)}</text></g>`
  );
}

function card(v: View, L: Look, id: (name: string) => string): string {
  const t = v.table;
  const { w, h } = v;
  const s: string[] = [];
  if (L.veil) s.push(`<rect width="${w}" height="${h}" rx="${RX}" ${fill(L.veil)}/>`);
  s.push(`<rect width="${w}" height="${h}" rx="${RX}" fill="url(#${id("fill")})"/>`);
  s.push(`<path d="${capPath(w)}" fill="url(#${id("cap")})"/>`);
  if (L.outline) s.push(`<rect x="-0.5" y="-0.5" width="${w + 1}" height="${h + 1}" rx="${RX + 0.5}" fill="none" ${stroke(L.outline)}/>`);
  s.push(
    `<rect x="0.5" y="0.5" width="${w - 1}" height="${h - 1}" rx="${RX - 0.5}" fill="none" stroke="url(#${id("rim")})"${t.origin === "external" ? ' stroke-dasharray="5 4"' : ""}/>`,
  );
  s.push(`<rect x="2" y="2" width="${w - 4}" height="${h - 4}" rx="${RX - 2}" fill="none" ${stroke(L.inner)}/>`);
  s.push(`<rect x="${f(RX * 0.7)}" y="0.6" width="${f(w - RX * 1.4)}" height="1" fill="url(#${id("hi")})"/>`);

  // header
  s.push(
    `<text x="${PAD}" y="28" font-size="14" font-weight="650" letter-spacing="-0.01em" ${fill(L.text)}>${esc(t.name)}` +
      (t.description ? `<tspan dx="10" font-size="12" font-weight="400" letter-spacing="0" ${fill(L.muted)}>${esc(t.description)}</tspan>` : "") +
      "</text>",
  );
  if (v.tag) s.push(chip(v.tag, w - PAD - chipW(v.tag), 15, L));
  s.push(`<rect x="${PAD}" y="${HEAD - 0.5}" width="${w - PAD * 2}" height="1" fill="url(#${id("sep")})"/>`);

  // rows
  v.shown.forEach((c, i) => {
    const cy = rowY(i);
    const by = cy + 4.2;
    s.push(`<g class="rz-c" data-c="${esc(c.name)}"><title>${esc(rowTitle(c, t))}</title>`);
    s.push(`<rect class="rz-hit" x="4" y="${f(cy - ROW / 2)}" width="${w - 8}" height="${ROW}" rx="6" fill="currentColor" fill-opacity="0"/>`);
    if (i > 0) s.push(`<rect x="${PAD + 20}" y="${f(cy - ROW / 2)}" width="${w - PAD * 2 - 20}" height="1" fill="url(#${id("sep")})" opacity=".7"/>`);
    if (c.pk) s.push(keyDot(PAD + 6, cy, L.pk, true, L, id));
    else if (c.uk) s.push(keyDot(PAD + 6, cy, L.uk, false, L, id));
    else if (v.refCols.has(c.name)) s.push(`<circle cx="${PAD + 6}" cy="${f(cy)}" r="2.2" ${fill(L.fk)}/>`);
    s.push(
      `<text x="${PAD + 20}" y="${f(by)}" font-size="12.5" ${fill(c.pk ? L.text : [L.text[0], L.text[1] * 0.92])}${c.pk ? ' font-weight="600"' : ""}>${esc(c.name)}</text>`,
    );
    if (c.description) s.push(`<text x="${f(PAD + 20 + v.nameW + 14)}" y="${f(by)}" font-size="11.5" ${fill(L.muted)}>${esc(c.description)}</text>`);
    const right = w - PAD;
    const nullable = c.nullable && t.origin !== "audit";
    s.push(
      `<text x="${right}" y="${f(by)}" text-anchor="end" font-family="${MONO}" font-size="11" ${fill(L.type)}>${esc(c.type)}` +
        (nullable ? `<tspan ${fill(L.nullable)} font-weight="700">?</tspan>` : "") +
        "</text>",
    );
    let cx = right - monoW(typeOf(c, t), 11) - 8;
    for (const x of chips(c, v).reverse()) {
      cx -= chipW(x);
      s.push(chip(x, cx, cy - 7.5, L));
      cx -= 4;
    }
    s.push("</g>");
  });

  if (v.foot.length) {
    const fy = HEAD + 4 + v.shown.length * ROW + 4;
    s.push(`<rect x="${PAD}" y="${fy}" width="${w - PAD * 2}" height="1" fill="url(#${id("sep")})"/>`);
    v.foot.forEach((line, k) => s.push(`<text x="${PAD}" y="${f(fy + 15 + k * FOOT)}" font-size="10.5" ${fill(L.faint)}>${esc(line)}</text>`));
  }
  return s.join("");
}

function keyDot(x: number, y: number, ink: Ink, filled: boolean, L: Look, id: (name: string) => string): string {
  const halo = L.glow ? `<circle cx="${x}" cy="${f(y)}" r="6" fill="${ink[0]}" fill-opacity=".22" filter="url(#${id("soft")})"/>` : "";
  return (
    halo +
    (filled
      ? `<circle cx="${x}" cy="${f(y)}" r="3.4" ${fill(ink)}/>`
      : `<circle cx="${x}" cy="${f(y)}" r="3" fill="none" ${stroke(ink)} stroke-width="1.4"/>`)
  );
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
    const tag =
      table.origin === "external" ? "external" : table.origin === "audit" || (table.audit && !expand) ? (table.audit?.method ?? "envers") : null;
    const foot = table.constraints.map((k) => `${k.name ?? (k.kind === "unique" ? "unique" : "index")} (${k.columns.join(", ")})`);
    if (hidden) foot.push(`+${hidden} ${hidden === 1 ? "column" : "columns"}`);
    const base = { table, shown, hidden, refCols, tag, foot };
    return { ...base, ...measure(base) };
  });
  return { views: out, relations };
}

const STANDALONE_STYLE = "<style>.rz{color:#1f2328}@media (prefers-color-scheme:dark){.rz{color:#e6edf3}}</style>";

function defs(L: Look, id: (name: string) => string, W: number, H: number, bleed: number, cards: string): string {
  const s: string[] = [];
  s.push(`<linearGradient id="${id("fill")}" x1="0" y1="0" x2="0" y2="1">${stop(0, L.fillTop)}${stop(1, L.fillBottom)}</linearGradient>`);
  s.push(`<linearGradient id="${id("cap")}" x1="0" y1="0" x2="0" y2="1">${stop(0, L.capTop)}${stop(1, L.capBottom)}</linearGradient>`);
  s.push(`<linearGradient id="${id("rim")}" x1="0" y1="0" x2="1" y2="1">${stop(0, L.rim[0])}${stop(0.45, L.rim[1])}${stop(1, L.rim[2])}</linearGradient>`);
  s.push(`<linearGradient id="${id("hi")}" x1="0" y1="0" x2="1" y2="0">${stop(0, [WHITE, 0])}${stop(0.5, [WHITE, L.highlight])}${stop(1, [WHITE, 0])}</linearGradient>`);
  s.push(`<linearGradient id="${id("sep")}" x1="0" y1="0" x2="1" y2="0">${stop(0, [L.sep[0], 0])}${stop(0.15, L.sep)}${stop(0.85, L.sep)}${stop(1, [L.sep[0], 0])}</linearGradient>`);
  s.push(`<filter id="${id("soft")}" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="2.4"/></filter>`);
  // A shadow that stays outside the card: blur the shape, offset it, then cut the shape itself out
  const [sc, sa, sdy, sb] = L.shadow;
  s.push(
    `<filter id="${id("shadow")}" x="-40%" y="-40%" width="180%" height="200%"><feGaussianBlur in="SourceAlpha" stdDeviation="${sb}"/><feOffset dy="${sdy}" result="b"/>` +
      `<feFlood flood-color="${sc}" flood-opacity="${sa}"/><feComposite in2="b" operator="in" result="s"/><feComposite in="s" in2="SourceAlpha" operator="out"/></filter>`,
  );
  if (L.backdrop) {
    const B = L.backdrop;
    const R = Math.max(W, H);
    B.blobs.forEach(([color, alpha, cx, cy, r], i) =>
      s.push(
        `<radialGradient id="${id(`blob${i}`)}" gradientUnits="userSpaceOnUse" cx="${f(cx * W)}" cy="${f(cy * H)}" r="${f(r * R)}">` +
          `<stop offset="0" stop-color="${color}" stop-opacity="${alpha}"/><stop offset="1" stop-color="${color}" stop-opacity="0"/></radialGradient>`,
      ),
    );
    s.push(
      `<pattern id="${id("dots")}" width="22" height="22" patternUnits="userSpaceOnUse"><circle cx="11" cy="11" r="1.05" ${fill(B.dots)}/></pattern>`,
    );
    // The backdrop at the drawing's size (what the glass blurs) and, for canvases, a wider one to look at.
    // The dot grid is drawn on top separately, so a viewer can hide it (a <use> copy cannot be styled)
    const layer = (x: number, y: number, w: number, h: number) =>
      `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${B.base}"/>` +
      B.blobs.map((_, i) => `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="url(#${id(`blob${i}`)})"/>`).join("");
    s.push(`<g id="${id("backdrop")}">${layer(0, 0, W, H)}</g>`);
    if (bleed > 0) s.push(`<g id="${id("backdrop-wide")}">${layer(-bleed, -bleed, W + bleed * 2, H + bleed * 2)}</g>`);
    s.push(
      `<filter id="${id("frost")}" x="0" y="0" width="100%" height="100%" color-interpolation-filters="sRGB">` +
        `<feGaussianBlur stdDeviation="${L.frost!.blur}" edgeMode="duplicate"/><feColorMatrix type="saturate" values="${L.frost!.saturate}"/></filter>`,
    );
    s.push(`<mask id="${id("cards")}" maskUnits="userSpaceOnUse" x="0" y="0" width="${W}" height="${H}"><rect width="${W}" height="${H}" fill="black"/>${cards}</mask>`);
  }
  return s.join("");
}

export async function toSvg(model: Model, elk: ElkLike, options: SvgOptions = {}): Promise<SvgResult> {
  const opts = { columns: options.columns ?? "all", audit: options.audit ?? "collapse" } as const;
  const look = options.look ?? "graphite";
  const L = LOOKS[look];
  const prefix = options.idPrefix ?? "rz-";
  const id = (name: string) => prefix + name;
  const bleed = L.backdrop ? Math.max(0, options.bleed ?? 0) : 0;
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
  const box = (v: View) => {
    const p = pos.get(v.table.name)!;
    return { x: f(p.x), y: f(p.y), w: v.w, h: v.h };
  };
  const cardRects = vs
    .map((v) => {
      const b = box(v);
      return `<rect class="rz-m" data-t="${esc(v.table.name)}" x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}" rx="${RX}" fill="white"/>`;
    })
    .join("");

  const s: string[] = [];
  const label = `ERD: ${vs.map((v) => v.table.name).join(", ")}`;
  s.push(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" class="rz rz-${look}" role="img" aria-label="${esc(label)}" font-family="${SANS}" font-size="12"${bleed ? ' style="overflow:visible"' : ""}>`,
  );
  if (options.standalone && !L.backdrop) s.push(STANDALONE_STYLE);
  s.push(`<title>${esc(label)}</title>`);
  s.push(`<defs>${defs(L, id, W, H, bleed, cardRects)}</defs>`);
  if (L.backdrop) {
    s.push(`<use href="#${id(bleed ? "backdrop-wide" : "backdrop")}"/>`);
    s.push(`<rect class="rz-dots" x="${-bleed}" y="${-bleed}" width="${W + bleed * 2}" height="${H + bleed * 2}" fill="url(#${id("dots")})"/>`);
  }
  // Shadows first, under the glass. The shadow filter only uses the shape's alpha, so the fill color is irrelevant.
  // Each table's shadow (rz-s) and frost cut-out (rz-m) carry its data-t, so a viewer can fade them with the card
  s.push('<g class="rz-shadows">');
  for (const v of vs) {
    const b = box(v);
    s.push(`<rect class="rz-s" data-t="${esc(v.table.name)}" x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}" rx="${RX}" fill="currentColor" filter="url(#${id("shadow")})"/>`);
  }
  s.push("</g>");
  if (L.backdrop) s.push(`<g mask="url(#${id("cards")})"><use href="#${id("backdrop")}" filter="url(#${id("frost")})"/></g>`);

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
    const d = pathD(clean([start, ...(sec?.bendPoints ?? []), end]), 10);
    const dash = r.kind === "logical" ? ' stroke-dasharray="5 5"' : "";
    s.push(`<g class="rz-r" data-a="${esc(r.parent)}" data-ac="${esc(r.parentColumn)}" data-b="${esc(r.child)}" data-bc="${esc(r.childColumn)}">`);
    if (L.glow) s.push(`<path d="${d}" fill="none" ${stroke(L.glow)} stroke-width="5" stroke-linecap="round" filter="url(#${id("soft")})"${dash}/>`);
    s.push(`<path d="${d}" fill="none" ${stroke(L.line)} stroke-width="1.3" stroke-linecap="round"${dash}/>`);
    // Parent (PK) end: an arrowhead, like resin's `->`. Child (FK) end: a dot and N (many) or 1 (one)
    s.push(
      `<path d="M${f(start.x + 7)},${f(start.y - 5.5)} L${f(start.x + 1)},${f(start.y)} L${f(start.x + 7)},${f(start.y + 5.5)}" fill="none" ${stroke(L.line)} stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>`,
    );
    s.push(`<circle cx="${f(end.x)}" cy="${f(end.y)}" r="3" ${fill(L.line)}/>`);
    s.push(
      `<text x="${f(end.x - 9)}" y="${f(end.y - 6)}" text-anchor="end" font-family="${MONO}" font-size="9.5" ${fill(L.line)}>${r.one ? "1" : "N"}</text>`,
    );
    s.push("</g>");
  });
  s.push("</g>", '<g class="rz-tables">');
  for (const v of vs) {
    const b = box(v);
    s.push(`<g class="rz-t" data-t="${esc(v.table.name)}" transform="translate(${b.x},${b.y})">${card(v, L, id)}</g>`);
  }
  s.push("</g></svg>");
  return { svg: s.join(""), width: W, height: H, background: L.backdrop?.base ?? null };
}
