// Model → SVG: the ERD resin draws itself.
//
// Steps: size every card → lay out with ELK (a port on every column row, orthogonal routing) → SVG string.
//
// Every look shares one layout and one card anatomy: a panel with modest corners, key labels (PK, UK,
// FK) in a gutter, rectangular tags, and orthogonal connectors with square ends.
//   graphite  paints nothing behind the drawing. Ink is currentColor, so it reads on any page; the
//             default for files.
//   glass     frosted liquid glass panels over a stage in one of three themes (aurora, silk,
//             caustic), each in a dark and a light version. Files get a still life: the stage drawn
//             into the SVG, blurred once under every card. A live canvas passes `stage: false` and
//             paints the stage and the glass itself (see the playground), so the SVG then holds only
//             what sits on the glass.
//
// Output is deterministic. Text is never measured; widths follow fixed rules (monospace = cells ×
// 0.6em, proportional = 0.57em per Latin letter and 1em per CJK character). The same input gives the
// same SVG in a browser and on the command line.
//
// ELK is passed in, so the core does not depend on elkjs (zero runtime dependencies). Callers pass `new ELK()`.

import type { ChangeKind } from "./diff.ts";
import type { Model, ModelColumn, ModelService, ModelTable, Relation } from "./model.ts";

export type SvgLook = "graphite" | "aurora-dark" | "aurora-light" | "silk-dark" | "silk-light" | "caustic-dark" | "caustic-light";

export interface SvgOptions {
  /** all = every column, keys = key and reference columns only (the rest become "+N columns"),
   *  none = table names only, with the connectors between the headers */
  columns?: "all" | "keys" | "none";
  /** collapse = fold audit tables into a tag on the audited table, expand = draw revinfo and *_aud */
  audit?: "collapse" | "expand";
  /** graphite (default) or a glass look */
  look?: SvgLook;
  /** graphite only, for files: embed a <style> that picks the ink color for light and dark backgrounds */
  standalone?: boolean;
  /** Glass looks: paint the stage and the glass into the SVG. Default true. A live canvas passes
   *  false, paints both itself from `stageOf(look)` and `glassOf(look)`, and lays the SVG on top */
  stage?: boolean;
  /** Connectors: angular (right-angled, the default) or curved */
  edges?: "angular" | "curved";
  /** Services drawn as one card each, a row per table: references inside a folded service are
   *  counted under its card, references out of it join its rows. Other tables follow `columns` */
  fold?: readonly string[];
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
  /** The stage's base color, or null for graphite */
  background: string | null;
  /** Every card, for pages that paint the glass themselves */
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
  width?: number;
  height?: number;
  ports?: ElkPortIn[];
  layoutOptions: Record<string, string>;
  /** A service: its tables, laid out inside it */
  children?: ElkNodeIn[];
}
interface ElkGraphIn {
  id: string;
  layoutOptions: Record<string, string>;
  children: ElkNodeIn[];
  edges: { id: string; sources: string[]; targets: string[] }[];
}
interface ElkEdgeOut {
  id: string;
  /** The node whose coordinates the sections are in: the root, or the service both ends are inside */
  container?: string;
  sections?: { startPoint: Point; endPoint: Point; bendPoints?: Point[] }[];
}
interface ElkNodeOut {
  id: string;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  children?: ElkNodeOut[];
  edges?: ElkEdgeOut[];
}
interface ElkGraphOut {
  width?: number;
  height?: number;
  children?: ElkNodeOut[];
  edges?: ElkEdgeOut[];
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
const f3 = (v: number): number => Math.round(v * 1000) / 1000;
const up8 = (v: number): number => Math.ceil(v / 8) * 8;
const maxOf = (xs: number[], floor = 0): number => xs.reduce((m, x) => Math.max(m, x), floor);

// ---- looks ----

/** A color and its opacity (or strength). Color may be "currentColor" */
export type Ink = readonly [string, number];

/** The slow color behind the glass. Files draw it still; a live canvas animates it */
export interface Stage {
  /** The theme: ribbons of light under stars, flowing silk, or light through water */
  style: "aurora" | "silk" | "caustic";
  dark: boolean;
  base: string;
  /** Three colors and how strongly each shows */
  colors: readonly [Ink, Ink, Ink];
  /** Where each color sits in a still drawing: [cx, cy, radius], relative to the drawing */
  spots: readonly (readonly [number, number, number])[];
  /** The light that follows the pointer on a live canvas: color, strength, radius in pixels */
  light: readonly [string, number, number];
  /** Dots every GRID_STEP units */
  grid: Ink;
  /** Stars that twinkle (sparkles on a light stage), or null */
  stars: Ink | null;
  grain: number;
  vignette: number;
}

/** The glass panel a table sits on */
export interface Glass {
  /** Blur behind the panel, in pixels */
  frost: number;
  /** Laid over the frosted stage so text stays readable */
  veil: Ink;
  /** A brighter wash that fades down the panel */
  tint: Ink;
  /** The edge: one even line, no highlights */
  rim: Ink;
  /** Live canvas: how far the edge bends what is behind it, in pixels */
  lens: number;
  shadow: Ink;
}

interface Inks {
  text: Ink;
  muted: Ink;
  faint: Ink;
  type: Ink;
  sep: Ink;
  head: Ink;
  pk: Ink;
  uk: Ink;
  fk: Ink;
  nullable: Ink;
  line: Ink;
  tag: Ink;
  tagRim: Ink;
  tagText: Ink;
}

interface Look {
  ink: Inks;
  stage: Stage | null;
  glass: Glass | null;
}

export const GRID_STEP = 24;
/** Corner radius of a card. Modest on purpose: the drawing is a schematic, not a toy */
export const CARD_RADIUS = 8;

const C = "currentColor";
const WHITE = "#FFFFFF";

const INK: Record<"current" | "dark" | "light", Inks> = {
  current: {
    text: [C, 1],
    muted: [C, 0.6],
    faint: [C, 0.42],
    type: [C, 0.6],
    sep: [C, 0.09],
    head: [C, 0.04],
    pk: [C, 1],
    uk: [C, 0.78],
    fk: [C, 0.55],
    nullable: [C, 1],
    line: [C, 0.55],
    tag: [C, 0.04],
    tagRim: [C, 0.18],
    tagText: [C, 0.7],
  },
  dark: {
    text: ["#F6F7FB", 1],
    muted: ["#DDE2F0", 0.62],
    faint: ["#DDE2F0", 0.42],
    type: ["#DDE2F0", 0.66],
    sep: [WHITE, 0.09],
    head: [WHITE, 0.035],
    pk: ["#F6C76B", 1],
    uk: ["#C8BBFF", 1],
    fk: ["#86E1EC", 1],
    nullable: ["#F6C76B", 1],
    line: ["#E9ECF8", 0.62],
    tag: [WHITE, 0.07],
    tagRim: [WHITE, 0.16],
    tagText: ["#E6EAF6", 0.8],
  },
  light: {
    text: ["#0B1020", 1],
    muted: ["#0B1020", 0.56],
    faint: ["#0B1020", 0.4],
    type: ["#0B1020", 0.6],
    sep: ["#0F172A", 0.08],
    head: [WHITE, 0.3],
    pk: ["#B26A00", 1],
    uk: ["#6D4FD8", 1],
    fk: ["#0B7A90", 1],
    nullable: ["#B26A00", 1],
    line: ["#1E293B", 0.52],
    tag: [WHITE, 0.6],
    tagRim: ["#0F172A", 0.12],
    tagText: ["#0B1020", 0.64],
  },
};

// Frosted through: the stage only tints the panel, the rim and the bevel do the glass
const DARK_GLASS: Glass = {
  frost: 22,
  veil: ["#0F121C", 0.74],
  tint: [WHITE, 0.07],
  rim: [WHITE, 0.16],
  lens: 7,
  shadow: ["#000000", 0.55],
};
const LIGHT_GLASS: Glass = {
  frost: 22,
  veil: ["#FAFBFD", 0.8],
  tint: [WHITE, 0.4],
  rim: ["#0F172A", 0.12],
  lens: 7,
  shadow: ["#1B2140", 0.18],
};

const LOOKS: Record<SvgLook, Look> = {
  graphite: { ink: INK.current, stage: null, glass: null },
  "aurora-dark": {
    ink: INK.dark,
    glass: DARK_GLASS,
    stage: {
      style: "aurora",
      dark: true,
      base: "#05060C",
      colors: [
        ["#5A5FF0", 0.55],
        ["#22C7A9", 0.62],
        ["#E8A04A", 0.3],
      ],
      spots: [
        [0.12, 0.12, 0.6],
        [0.92, 0.2, 0.55],
        [0.62, 1.0, 0.6],
      ],
      light: ["#FFFFFF", 0.1, 420],
      grid: [WHITE, 0.1],
      stars: [WHITE, 0.95],
      grain: 0.025,
      vignette: 0.35,
    },
  },
  "aurora-light": {
    ink: INK.light,
    glass: LIGHT_GLASS,
    stage: {
      style: "aurora",
      dark: false,
      base: "#E9EBF1",
      colors: [
        ["#A9B1F7", 0.75],
        ["#8FD8CC", 0.7],
        ["#F7C893", 0.5],
      ],
      spots: [
        [0.08, 0.1, 0.6],
        [0.95, 0.15, 0.55],
        [0.7, 1.0, 0.6],
      ],
      light: ["#FFFFFF", 0.22, 420],
      grid: ["#1E2433", 0.1],
      stars: ["#6E74DA", 0.45],
      grain: 0.02,
      vignette: 0.06,
    },
  },
  "silk-dark": {
    ink: INK.dark,
    glass: DARK_GLASS,
    stage: {
      style: "silk",
      dark: true,
      base: "#0A0708",
      colors: [
        ["#D9893A", 0.5],
        ["#5B2C7A", 0.55],
        ["#F1B6C4", 0.32],
      ],
      spots: [
        [0.85, 0.85, 0.65],
        [0.15, 0.2, 0.6],
        [0.55, 0.45, 0.35],
      ],
      light: ["#FFE3C2", 0.1, 420],
      grid: ["#FFF1E6", 0.09],
      stars: null,
      grain: 0.025,
      vignette: 0.4,
    },
  },
  "silk-light": {
    ink: INK.light,
    glass: LIGHT_GLASS,
    stage: {
      style: "silk",
      dark: false,
      base: "#F2ECE6",
      colors: [
        ["#F2C28E", 0.62],
        ["#C9B8EE", 0.58],
        ["#FFFFFF", 0.55],
      ],
      spots: [
        [0.85, 0.9, 0.65],
        [0.12, 0.15, 0.6],
        [0.5, 0.45, 0.35],
      ],
      light: ["#FFF8F0", 0.22, 420],
      grid: ["#3A2A1C", 0.1],
      stars: null,
      grain: 0.02,
      vignette: 0.06,
    },
  },
  "caustic-dark": {
    ink: INK.dark,
    glass: DARK_GLASS,
    stage: {
      style: "caustic",
      dark: true,
      base: "#031018",
      colors: [
        ["#0E5E70", 0.6],
        ["#9FE7F2", 0.3],
        ["#F3D49A", 0.2],
      ],
      spots: [
        [0.2, 0.25, 0.7],
        [0.75, 0.4, 0.5],
        [0.5, 1.05, 0.5],
      ],
      light: ["#CFF6FF", 0.1, 420],
      grid: ["#DFF7FF", 0.09],
      stars: null,
      grain: 0.025,
      vignette: 0.4,
    },
  },
  "caustic-light": {
    ink: INK.light,
    glass: LIGHT_GLASS,
    stage: {
      style: "caustic",
      dark: false,
      base: "#E4F1F4",
      colors: [
        ["#9FD6E0", 0.6],
        ["#FFFFFF", 0.5],
        ["#F4E2C4", 0.45],
      ],
      spots: [
        [0.2, 0.2, 0.65],
        [0.7, 0.45, 0.5],
        [0.55, 1.05, 0.5],
      ],
      light: ["#FFFFFF", 0.22, 420],
      grid: ["#123A44", 0.1],
      stars: null,
      grain: 0.02,
      vignette: 0.06,
    },
  },
};

/** The stage a look stands on, for a page that paints it itself; null for graphite */
export const stageOf = (look: SvgLook): Stage | null => LOOKS[look].stage;
/** The glass a look's cards are made of, for a page that paints it itself; null for graphite */
export const glassOf = (look: SvgLook): Glass | null => LOOKS[look].glass;

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

interface View {
  table: ModelTable;
  shown: ModelColumn[];
  hidden: number;
  /** Columns of this table on the child side of a relation */
  refCols: Set<string>;
  tag: string | null;
  foot: string[];
  /** A folded service: its name, its place among the services (the hue) and its tables, one per row */
  fold?: { service: string; hue: number; members: ModelTable[]; external: boolean; expand: boolean };
  w: number;
  h: number;
  nameW: number;
}

/** A folded service's card. A table's identity has backticks only around a whole name, never after a
 *  space, so the two never meet */
export const serviceCardId = (service: string): string => `service \`${service}\``;

/** The table a row of a folded service's card stands for */
const memberOf = (c: ModelColumn, v: Pick<View, "shown" | "fold">): ModelTable | null => v.fold?.members[v.shown.indexOf(c)] ?? null;

function chips(c: ModelColumn, v: Pick<View, "refCols" | "shown" | "fold">): string[] {
  const m = memberOf(c, v);
  if (m) {
    // A row is a table: the tags its own card would carry. EXTERNAL is on the card when every row is
    const audit = m.origin === "audit" || (m.audit && !v.fold!.expand) ? (m.audit?.method ?? "envers").toUpperCase() : null;
    return [m.origin === "external" && !v.fold!.external ? "EXTERNAL" : null, audit].filter((x): x is string => x !== null);
  }
  const out: string[] = [];
  if (c.pk && v.refCols.has(c.name)) out.push("FK");
  if (c.enumValues) out.push("ENUM");
  if (c.enc) out.push("ENC");
  if (c.index) out.push("IX");
  return out;
}
const chipW = (text: string): number => monoW(text, 8.5) + 10;
const chipsW = (list: string[]): number => (list.length ? list.reduce((w, x) => w + chipW(x) + 4, 0) + 6 : 0);
/** Nullability is spelled out the way DDL does: `varchar NULL`. Generated audit tables leave it out */
const isNull = (c: ModelColumn, t: ModelTable): boolean => c.nullable && t.origin !== "audit";
const NULL_SIZE = 8.5;
/** The NULL column at a card's right edge, kept only by cards that have a nullable column, so the
 *  types stay aligned */
const NULL_W = monoW("NULL", NULL_SIZE) + 7;

function rowTitle(c: ModelColumn, t: ModelTable, member: ModelTable | null): string {
  if (member) return [member.label ?? member.name, member.description, c.type].filter(Boolean).join("\n");
  const parts = [`${c.name} ${c.type}${t.origin === "audit" ? "" : c.nullable ? " NULL" : " NOT NULL"}`];
  if (c.description) parts.push(c.description);
  if (c.enumValues) parts.push(c.enumValues.join(" / "));
  if (c.ukName) parts.push(`unique ${c.ukName}`);
  if (c.index) parts.push(`index${c.index.name ? " " + c.index.name : ""}`);
  if (c.ref) parts.push(`${c.ref.kind === "physical" ? "->" : "~>"} ${c.ref.table}.${c.ref.column}`);
  if (c.change) parts.push([c.change.kind, ...c.change.details].join(": "));
  return parts.join("\n");
}

/** A card with nothing under its header: the table names only view */
const bare = (v: Pick<View, "shown" | "foot">): boolean => v.shown.length === 0 && v.foot.length === 0;

function measure(v: Omit<View, "w" | "h" | "nameW">): Pick<View, "w" | "h" | "nameW"> {
  const t = v.table;
  const nameW = maxOf(v.shown.map((c) => sansW(c.name, 12.5) * (c.pk ? 1.04 : 1)), 48);
  const descW = maxOf(v.shown.map((c) => (c.description ? sansW(c.description, 11.5) : 0)));
  const typeW = maxOf(v.shown.map((c) => monoW(c.type, 11)), 40);
  const chipW_ = maxOf(v.shown.map((c) => chipsW(chips(c, v))));
  const nullW = v.shown.some((c) => isNull(c, t)) ? NULL_W : 0;
  const rowW = PAD * 2 + KEY + nameW + (descW ? 14 + descW : 0) + 18 + chipW_ + typeW + nullW;
  const headW =
    PAD * 2 +
    sansW(t.label ?? t.name, 13.5) * 1.04 +
    10 +
    (t.description ? sansW(t.description, 12) : 0) +
    (v.tag ? 14 + chipW(v.tag) : 0) +
    (t.change ? 14 + chipW(DIFF_LABEL[t.change.kind]) : 0);
  const footW = PAD * 2 + maxOf(v.foot.map((s) => monoW(s, 9.5)));
  // A header alone is as wide as its name needs: names only is for seeing many tables at once
  if (bare(v)) return { w: up8(Math.max(headW, 120)), h: HEAD, nameW };
  return {
    w: up8(Math.max(rowW, headW, footW, 200)),
    h: up8(HEAD + v.shown.length * ROW + (v.foot.length ? v.foot.length * FOOT + 8 : 0) + 8),
    nameW,
  };
}

const rowY = (i: number): number => HEAD + 4 + i * ROW + ROW / 2;
/** Where a connector meets a card: the column's row, or the middle of a bare header */
const anchorY = (v: View, column: string): number => (bare(v) ? HEAD / 2 : rowY(v.shown.findIndex((c) => c.name === column)));
/** The port a connector leaves or enters by. A bare card has one per side, shared by its connectors */
const portOf = (v: View, column: string): string => (bare(v) ? "" : column);
/** The header band: rounded top corners, square bottom */
const capPath = (w: number): string => `M0,${RX} A${RX},${RX} 0 0 1 ${RX},0 H${w - RX} A${RX},${RX} 0 0 1 ${w},${RX} V${HEAD} H0 Z`;

function chip(text: string, x: number, y: number, I: Inks): string {
  const w = chipW(text);
  return (
    `<g transform="translate(${f(x)},${f(y)})"><rect width="${f(w)}" height="14" rx="3" ${fill(I.tag)} ${stroke(I.tagRim)}/>` +
    `<text x="${f(w / 2)}" y="10" text-anchor="middle" font-family="${MONO}" font-size="8.5" font-weight="500" ${fill(I.tagText)}>${esc(text)}</text></g>`
  );
}

/** A tag in a diff color: what happened to a table */
function diffChip(text: string, x: number, y: number, hue: string): string {
  const w = chipW(text);
  return (
    `<g transform="translate(${f(x)},${f(y)})"><rect width="${f(w)}" height="14" rx="3" fill="${hue}" fill-opacity="0.14" stroke="${hue}" stroke-opacity="0.6"/>` +
    `<text x="${f(w / 2)}" y="10" text-anchor="middle" font-family="${MONO}" font-size="8.5" font-weight="600" fill="${hue}">${esc(text)}</text></g>`
  );
}

function keyLabel(c: ModelColumn, v: View, I: Inks): [string, Ink] | null {
  if (c.pk) return ["PK", I.pk];
  if (c.uk) return ["UK", I.uk];
  if (v.refCols.has(c.name)) return ["FK", I.fk];
  return null;
}

/** The panel itself. Glass in a file: veil, wash and an even edge over the frost. Graphite: ink only.
 *  On a live canvas the page paints the panel, so nothing is drawn here */
function panel(v: View, L: Look, id: (name: string) => string, painted: boolean): string {
  const { w, h } = v;
  const dash = v.table.origin === "external" ? ' stroke-dasharray="5 4"' : "";
  // A folded service keeps the edge of its area, in its hue. On a live canvas the glass is painted
  // below, so the hue is drawn over it here
  const hue = v.fold ? serviceHue(L, v.fold.hue) : null;
  const rim = hue ? `stroke="${hue}" stroke-opacity="${serviceEdge(L)}"` : null;
  if (!painted) return dash || rim ? `<rect x="0.5" y="0.5" width="${w - 1}" height="${h - 1}" rx="${RX - 0.5}" fill="none" ${rim ?? stroke(L.ink.sep)}${dash}/>` : "";
  const s: string[] = [];
  if (L.glass) {
    s.push(`<rect width="${w}" height="${h}" rx="${RX}" ${fill(L.glass.veil)}/>`);
    s.push(`<rect width="${w}" height="${h}" rx="${RX}" fill="url(#${id("wash")})"/>`);
  } else {
    s.push(`<rect width="${w}" height="${h}" rx="${RX}" fill="url(#${id("wash")})"/>`);
  }
  s.push(bare(v) ? `<rect width="${w}" height="${h}" rx="${RX}" ${fill(L.ink.head)}/>` : `<path d="${capPath(w)}" ${fill(L.ink.head)}/>`);
  s.push(`<rect x="0.5" y="0.5" width="${w - 1}" height="${h - 1}" rx="${RX - 0.5}" fill="none" ${rim ?? stroke(L.glass ? L.glass.rim : [C, 0.25])}${dash}/>`);
  return s.join("");
}

function card(v: View, L: Look, id: (name: string) => string, painted: boolean): string {
  const t = v.table;
  const I = L.ink;
  const { w } = v;
  const s: string[] = [panel(v, L, id, painted)];

  // header: one group with its own hit area, so a click anywhere on it (name, description, tag) reaches it
  const hit = bare(v) ? `<rect class="rz-hit" width="${w}" height="${HEAD}" rx="${RX}" fill="currentColor" fill-opacity="0"/>` : `<path class="rz-hit" d="${capPath(w)}" fill="currentColor" fill-opacity="0"/>`;
  s.push(`<g class="rz-head">${hit}`);
  const hue = v.fold ? serviceHue(L, v.fold.hue) : null;
  s.push(
    `<text x="${PAD}" y="27" font-size="13.5" font-weight="600" letter-spacing="-0.01em" ${hue ? `fill="${hue}"` : fill(I.text)}>${esc(t.label ?? t.name)}` +
      (t.description ? `<tspan dx="10" font-size="12" font-weight="400" letter-spacing="0" ${fill(I.muted)}>${esc(t.description)}</tspan>` : "") +
      "</text>",
  );
  if (v.tag) s.push(chip(v.tag, w - PAD - chipW(v.tag), 15, I));
  if (t.change) {
    const label = DIFF_LABEL[t.change.kind];
    s.push(diffChip(label, w - PAD - (v.tag ? chipW(v.tag) + 6 : 0) - chipW(label), 15, diffHue(L, t.change.kind)));
  }
  s.push("</g>");
  if (!bare(v)) s.push(`<rect x="1" y="${HEAD - 0.5}" width="${w - 2}" height="1" ${fill(I.sep)}/>`);

  // rows. Types line up at the right edge, or just left of the NULL column when the card has one
  const nullW = v.shown.some((c) => isNull(c, t)) ? NULL_W : 0;
  v.shown.forEach((c, i) => {
    const cy = rowY(i);
    const by = cy + 4.2;
    // A row of a folded service names the table it stands for, which a viewer can open
    const member = memberOf(c, v);
    s.push(
      `<g class="rz-c" data-c="${esc(c.name)}"${member ? ` data-table="${esc(member.name)}"` : ""}${c.change?.kind === "removed" ? ' opacity="0.55"' : ""}><title>${esc(rowTitle(c, t, member))}</title>`,
    );
    s.push(`<rect class="rz-hit" x="1" y="${f(cy - ROW / 2)}" width="${w - 2}" height="${ROW}" fill="currentColor" fill-opacity="0"/>`);
    if (c.change) {
      const hue = diffHue(L, c.change.kind);
      s.push(`<rect x="1" y="${f(cy - ROW / 2)}" width="${w - 2}" height="${ROW}" fill="${hue}" fill-opacity="0.09"/>`);
      s.push(`<rect x="1" y="${f(cy - ROW / 2 + 3)}" width="3" height="${ROW - 6}" rx="1" fill="${hue}"/>`);
    }
    if (i > 0) s.push(`<rect x="${PAD}" y="${f(cy - ROW / 2)}" width="${w - PAD * 2}" height="1" ${fill(I.sep)} opacity=".7"/>`);
    const key = keyLabel(c, v, I);
    if (key) s.push(`<text x="${PAD}" y="${f(by - 0.6)}" font-family="${MONO}" font-size="8.5" font-weight="600" ${fill(key[1])}>${key[0]}</text>`);
    s.push(
      `<text x="${PAD + KEY}" y="${f(by)}" font-size="12.5" ${fill(I.text)}${c.pk ? ' font-weight="600"' : ""}${c.change?.kind === "removed" ? ' text-decoration="line-through"' : ""}>${esc(c.name)}</text>`,
    );
    if (c.description) s.push(`<text x="${f(PAD + KEY + v.nameW + 14)}" y="${f(by)}" font-size="11.5" ${fill(I.muted)}>${esc(c.description)}</text>`);
    const right = w - PAD - nullW;
    s.push(`<text x="${f(right)}" y="${f(by)}" text-anchor="end" font-family="${MONO}" font-size="11" ${fill(I.type)}>${esc(c.type)}</text>`);
    if (isNull(c, t))
      s.push(
        `<text x="${w - PAD}" y="${f(by - 0.6)}" text-anchor="end" font-family="${MONO}" font-size="${NULL_SIZE}" font-weight="600" letter-spacing="0.02em" ${fill(I.nullable)}>NULL</text>`,
      );
    let cx = right - monoW(c.type, 11) - 8;
    for (const x of chips(c, v).reverse()) {
      cx -= chipW(x);
      s.push(chip(x, cx, cy - 7, I));
      cx -= 4;
    }
    s.push("</g>");
  });

  if (v.foot.length) {
    const fy = HEAD + 4 + v.shown.length * ROW + 4;
    s.push(`<rect x="${PAD}" y="${fy}" width="${w - PAD * 2}" height="1" ${fill(I.sep)}/>`);
    v.foot.forEach((line, k) =>
      s.push(`<text x="${PAD}" y="${f(fy + 15 + k * FOOT)}" font-family="${MONO}" font-size="9.5" ${fill(I.faint)}>${esc(line)}</text>`),
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

/** A relation as drawn. `bundled`: its child end is a row of a folded service, so the connector may
 *  stand for several references and carries no 1 or N */
type Drawn = Relation & { bundled?: boolean };

function views(model: Model, opts: { columns: "all" | "keys" | "none"; audit: "collapse" | "expand"; fold: ReadonlySet<string> }): { views: View[]; relations: Drawn[] } {
  const expand = opts.audit === "expand";
  const tables = model.tables.filter((t) => expand || t.origin !== "audit");
  const names = new Set(tables.map((t) => t.name));
  const kept = model.relations.filter((r) => names.has(r.parent) && names.has(r.child));
  const flat = kept.flatMap(r =>
    r.childColumns ? r.childColumns.map((column, i) => ({ ...r, childColumn: column, parentColumn: r.parentColumns![i] })) : [r]);
  const referenced = new Set(flat.map((r) => `${r.parent}.${r.parentColumn}`));
  const childColumns = new Map<string, string[]>();
  for (const r of flat) { const columns = childColumns.get(r.child) ?? []; columns.push(r.childColumn); childColumns.set(r.child, columns); }

  // A table of a folded service is a row of its service's card. References inside the service are
  // counted; the others are moved to the rows, once per pair of rows
  const rowOf = new Map<string, { card: string; row: string; service: string }>();
  for (const t of tables) if (t.service && opts.fold.has(t.service)) rowOf.set(t.name, { card: serviceCardId(t.service), row: t.label ?? t.name, service: t.service });
  const inside = new Map<string, number>();
  for (const r of kept) {
    const p = rowOf.get(r.parent);
    if (p && p.service === rowOf.get(r.child)?.service) inside.set(p.service, (inside.get(p.service) ?? 0) + 1);
  }
  const relations: Drawn[] = [];
  const seen = new Set<string>();
  for (const r of flat) {
    const p = rowOf.get(r.parent);
    const c = rowOf.get(r.child);
    if (!p && !c) relations.push(r);
    else if (p?.service !== c?.service) {
      const drawn: Drawn = { ...r, parent: p?.card ?? r.parent, parentColumn: p?.row ?? r.parentColumn, child: c?.card ?? r.child, childColumn: c?.row ?? r.childColumn, parentColumns: undefined, childColumns: undefined, bundled: c !== undefined };
      const key = JSON.stringify([drawn.parent, drawn.parentColumn, drawn.child, drawn.childColumn, drawn.kind]);
      if (!seen.has(key)) relations.push(drawn);
      seen.add(key);
    }
  }

  const folded = (name: string, at: number): View => {
    const sv = model.services.find((x) => x.name === name) ?? { name, description: null };
    const members = tables.filter((t) => t.service === name);
    const external = members.every((t) => t.origin === "external");
    const shown: ModelColumn[] = members.map((t) => ({
      name: t.label ?? t.name,
      type: `${t.columns.length} ${t.columns.length === 1 ? "column" : "columns"}`,
      nullable: false, pk: false, uk: false, ukName: null, enc: false, enumValues: null, index: null, description: null, ref: null,
      ...(t.change ? { change: t.change } : {}),
    }));
    const n = inside.get(name) ?? 0;
    const table: ModelTable = { name: serviceCardId(name), label: name, description: sv.description, origin: external ? "external" : "table", columns: shown, constraints: [], audit: null, service: null };
    const base = { table, shown, hidden: 0, refCols: new Set<string>(), tag: external ? "EXTERNAL" : null, foot: n ? [`${n} ${n === 1 ? "reference" : "references"} inside`] : [], fold: { service: name, hue: at, members, external, expand } };
    return { ...base, ...measure(base) };
  };

  const out: View[] = [];
  for (const table of tables) {
    const row = rowOf.get(table.name);
    if (row) {
      // The card takes the place of its service's first table
      if (!out.some((v) => v.table.name === row.card)) out.push(folded(row.service, Math.max(0, model.services.findIndex((x) => x.name === row.service))));
      continue;
    }
    // A column that holds a reference is a foreign key even when its target is not drawn (a part of the
    // model, as the playground's related tables view draws)
    const refCols = new Set([...(childColumns.get(table.name) ?? []), ...table.columns.filter((c) => c.ref).map((c) => c.name), ...(table.foreignKeys ?? []).flatMap(k => k.columns)]);
    const isKey = (c: ModelColumn) => c.pk || c.uk || refCols.has(c.name) || referenced.has(`${table.name}.${c.name}`);
    const shown = opts.columns === "none" ? [] : opts.columns === "keys" ? table.columns.filter(isKey) : table.columns;
    const hidden = table.columns.length - shown.length;
    const tag =
      table.origin === "external"
        ? "EXTERNAL"
        : table.origin === "audit" || (table.audit && !expand)
          ? (table.audit?.method ?? "envers").toUpperCase()
          : null;
    // Names only leaves out everything under the header, the constraints and the count of columns too
    const foot = opts.columns === "none" ? [] : table.constraints.map((k) => `${k.name ?? (k.kind === "unique" ? "unique" : "index")} (${k.columns.join(", ")})`);
    if (opts.columns !== "none") for (const fk of table.foreignKeys ?? []) foot.push(`${fk.name ?? "foreign"} (${fk.columns.join(", ")})`);
    if (hidden && opts.columns !== "none") foot.push(`+${hidden} ${hidden === 1 ? "column" : "columns"}`);
    const base = { table, shown, hidden, refCols, tag, foot };
    out.push({ ...base, ...measure(base) });
  }
  return { views: out, relations };
}

const STANDALONE_STYLE = "<style>.rz{color:#1f2328}@media (prefers-color-scheme:dark){.rz{color:#e6edf3}}</style>";

/** "#RRGGBB" → [r, g, b] in 0..1, for feColorMatrix */
const rgb01 = (hex: string): number[] => [1, 3, 5].map((i) => f3(parseInt(hex.slice(i, i + 2), 16) / 255));

function cardDefs(L: Look, id: (name: string) => string): string {
  const s: string[] = [];
  const g = L.glass;
  if (g) {
    s.push(`<linearGradient id="${id("wash")}" x1="0" y1="0" x2="0" y2="1">${stop(0, g.tint)}${stop(1, [g.tint[0], 0])}</linearGradient>`);
  } else {
    s.push(`<linearGradient id="${id("wash")}" x1="0" y1="0" x2="0" y2="1">${stop(0, [C, 0.07])}${stop(1, [C, 0.025])}</linearGradient>`);
  }
  // Two shadows, a wide ambient one and a tight contact one, then the card's own shape is cut out so
  // translucent glass never shows its shadow through itself
  const [sc, sa] = g ? g.shadow : (["#000000", 0.16] as const);
  s.push(
    `<filter id="${id("shadow")}" x="-30%" y="-30%" width="160%" height="180%">` +
      `<feGaussianBlur in="SourceAlpha" stdDeviation="18"/><feOffset dy="16" result="a"/>` +
      `<feFlood flood-color="${sc}" flood-opacity="${sa}"/><feComposite in2="a" operator="in" result="ambient"/>` +
      `<feGaussianBlur in="SourceAlpha" stdDeviation="1.5"/><feOffset dy="1" result="c"/>` +
      `<feFlood flood-color="${sc}" flood-opacity="${f3(sa * 0.7)}"/><feComposite in2="c" operator="in" result="contact"/>` +
      `<feMerge><feMergeNode in="ambient"/><feMergeNode in="contact"/></feMerge>` +
      `<feComposite in2="SourceAlpha" operator="out"/></filter>`,
  );
  return s.join("");
}

/** A fixed random sequence (mulberry32), so a still sky comes out the same every time */
function random(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), s | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Aurora in a still drawing: two ribbons of light, each a bright wavering edge with light rising
 *  from it, blurred together; then a sky of stars, the brightest with a small cross */
function auroraSvg(S: Stage, id: (name: string) => string, W: number, H: number): { defs: string; body: string } {
  const d: string[] = [];
  const b: string[] = [];
  // The second color hangs high and faint above the first; the third stays a low glow (a field)
  const ribbons = [
    { ink: S.colors[1], y: 0.46, amp: 0.08, freq: 1.2, phase: 0.6, rise: 0.32 },
    { ink: [S.colors[0][0], S.colors[0][1] * 0.8] as const, y: 0.28, amp: 0.07, freq: 0.8, phase: 2.1, rise: 0.24 },
  ];
  d.push(`<filter id="${id("ribbons")}" x="-10%" y="-30%" width="120%" height="160%"><feGaussianBlur stdDeviation="${f(Math.max(W, H) / 110)}"/></filter>`);
  ribbons.forEach((r, i) => {
    const [color, k] = r.ink;
    d.push(
      `<linearGradient id="${id(`ribbon${i}`)}" x1="0" y1="0" x2="0" y2="1">${stop(0, [color, 0])}${stop(0.75, [color, f3(k * 0.3)])}${stop(1, [color, f3(k * 0.55)])}</linearGradient>`,
    );
    const edge: string[] = [];
    const top: string[] = [];
    for (let x = -48; x <= W + 48; x += 24) {
      const u = (x / W) * Math.PI * 2;
      const y = H * (r.y + r.amp * Math.sin(u * r.freq + r.phase));
      const rise = H * r.rise * (0.75 + 0.25 * Math.sin(u * r.freq * 2.3 + r.phase * 1.7));
      edge.push(`${f(x)},${f(y)}`);
      top.push(`${f(x)},${f(y - rise)}`);
    }
    b.push(`<polygon points="${[...top, ...edge.slice().reverse()].join(" ")}" fill="url(#${id(`ribbon${i}`)})"/>`);
    b.push(`<polyline points="${edge.join(" ")}" fill="none" stroke="${color}" stroke-opacity="${k}" stroke-width="${f(H / 90)}"/>`);
  });
  const sky: string[] = [];
  if (S.stars) {
    const [sc, sk] = S.stars;
    const rand = random(7);
    for (let y = 0; y < H; y += 28)
      for (let x = 0; x < W; x += 28) {
        if (rand() > 0.2) continue;
        const sx = x + 6 + rand() * 16;
        const sy = y + 6 + rand() * 16;
        const bright = rand();
        sky.push(`<circle cx="${f(sx)}" cy="${f(sy)}" r="${f(0.45 + bright * 0.8)}" fill="${sc}" fill-opacity="${f3(sk * (0.3 + 0.7 * bright))}"/>`);
        if (bright > 0.9)
          sky.push(`<path d="M${f(sx - 5)},${f(sy)}H${f(sx + 5)}M${f(sx)},${f(sy - 5)}V${f(sy + 5)}" stroke="${sc}" stroke-opacity="${f3(sk * 0.35)}" stroke-width="0.6"/>`);
      }
  }
  return { defs: d.join(""), body: `<g filter="url(#${id("ribbons")})">${b.join("")}</g>${sky.join("")}` };
}

/** The stage for files: base and still light, a dot grid, grain and a vignette, sized to the drawing.
 *  The glass blurs a copy of it (without grid and grain) through every card */
function stageSvg(S: Stage, G: Glass, id: (name: string) => string, W: number, H: number, cards: string): { defs: string; under: string; frost: string } {
  const d: string[] = [];
  const R = Math.max(W, H);
  const light: string[] = [`<rect width="${W}" height="${H}" fill="${S.base}"/>`];
  // Under aurora ribbons the fields of color are only a faint glow
  const field = S.style === "aurora" ? 0.35 : 1;
  S.colors.forEach(([color, strength], i) => {
    const [cx, cy, r] = S.spots[i];
    d.push(
      `<radialGradient id="${id(`spot${i}`)}" gradientUnits="userSpaceOnUse" cx="${f(cx * W)}" cy="${f(cy * H)}" r="${f(r * R)}">` +
        `<stop offset="0" stop-color="${color}" stop-opacity="${f3(strength * field)}"/><stop offset="1" stop-color="${color}" stop-opacity="0"/></radialGradient>`,
    );
    light.push(`<rect width="${W}" height="${H}" fill="url(#${id(`spot${i}`)})"/>`);
  });
  if (S.style === "aurora") {
    const a = auroraSvg(S, id, W, H);
    d.push(a.defs);
    light.push(a.body);
  }
  d.push(`<g id="${id("backdrop")}">${light.join("")}</g>`);
  const step = GRID_STEP;
  d.push(
    `<pattern id="${id("grid")}" width="${step}" height="${step}" x="${-step / 2}" y="${-step / 2}" patternUnits="userSpaceOnUse">` +
      `<rect x="${step / 2 - 0.6}" y="${step / 2 - 0.6}" width="1.2" height="1.2" ${fill(S.grid)}/></pattern>`,
  );
  const [gr, gg, gb] = rgb01(S.dark ? WHITE : "#000000");
  d.push(
    `<filter id="${id("grain")}" x="0" y="0" width="100%" height="100%" color-interpolation-filters="sRGB">` +
      `<feTurbulence type="fractalNoise" baseFrequency="1.1" numOctaves="2" seed="7" stitchTiles="stitch"/>` +
      `<feColorMatrix type="matrix" values="0 0 0 0 ${gr} 0 0 0 0 ${gg} 0 0 0 0 ${gb} ${f3(S.grain * 4)} 0 0 0 ${f3(-S.grain * 1.6)}"/></filter>`,
  );
  d.push(
    `<radialGradient id="${id("vignette")}" cx="0.5" cy="0.45" r="0.75"><stop offset="0.55" stop-color="#000000" stop-opacity="0"/>` +
      `<stop offset="1" stop-color="#000000" stop-opacity="${S.vignette}"/></radialGradient>`,
  );
  d.push(
    `<filter id="${id("frost")}" x="0" y="0" width="100%" height="100%" color-interpolation-filters="sRGB">` +
      `<feGaussianBlur stdDeviation="${G.frost}" edgeMode="duplicate"/><feColorMatrix type="saturate" values="1.35"/></filter>`,
  );
  d.push(`<mask id="${id("cards")}" maskUnits="userSpaceOnUse" x="0" y="0" width="${W}" height="${H}"><rect width="${W}" height="${H}" fill="black"/>${cards}</mask>`);
  const under =
    `<g class="rz-stage"><use href="#${id("backdrop")}"/>` +
    `<rect class="rz-grid" width="${W}" height="${H}" fill="url(#${id("grid")})"/>` +
    `<rect width="${W}" height="${H}" fill="#000000" filter="url(#${id("grain")})"/>` +
    `<rect width="${W}" height="${H}" fill="url(#${id("vignette")})"/></g>`;
  const frost = `<g mask="url(#${id("cards")})"><use href="#${id("backdrop")}" filter="url(#${id("frost")})"/></g>`;
  return { defs: d.join(""), under, frost };
}

// ---- services ----

/** ELK ids of service nodes: a prefix no table name can start with, since names never hold a NUL */
const SERVICE = "\u0000service:";
/** Room inside a service's edge, and above its tables for the label */
const SERVICE_PAD = 24;
const SERVICE_HEAD = 52;
const SERVICE_RX = 12;
/** Service hues, in the order services are declared: the key colors first (teal, violet, amber), then
 *  rose, sky and lime. Graphite draws services in ink alone */
const SERVICE_HUES = {
  dark: ["#5EEAD4", "#C4B5FD", "#FCD34D", "#FDA4AF", "#7DD3FC", "#BEF264"],
  light: ["#0F766E", "#6D28D9", "#B45309", "#BE123C", "#0369A1", "#4D7C0F"],
};
/** The hue of the service at `index` among the model's services, or null in graphite */
function serviceHue(L: Look, index: number): string | null {
  const hues = L.stage ? (L.stage.dark ? SERVICE_HUES.dark : SERVICE_HUES.light) : null;
  return hues ? hues[index % hues.length] : null;
}
/** The opacity of a service's edge in its hue */
const serviceEdge = (L: Look): number => (L.stage?.dark ? 0.42 : 0.38);

/** Diff marks (a model from `diff`): added, removed, changed. Graphite takes middle tones that read on
 *  light and dark pages alike */
const DIFF_HUES: Record<"dark" | "light" | "ink", Record<ChangeKind, string>> = {
  dark: { added: "#3FB950", removed: "#F97066", changed: "#E3B341" },
  light: { added: "#1A7F37", removed: "#B42318", changed: "#9A6700" },
  ink: { added: "#2DA44E", removed: "#E5534B", changed: "#C69026" },
};
const DIFF_LABEL: Record<ChangeKind, string> = { added: "NEW", removed: "REMOVED", changed: "CHANGED" };
const diffHue = (L: Look, kind: ChangeKind): string => DIFF_HUES[L.stage ? (L.stage.dark ? "dark" : "light") : "ink"][kind];

interface Area {
  service: ModelService;
  /** Index into the hues: the service's place among every service of the model, so a part of a model
   *  draws a service in the same color as the whole */
  hue: number;
  x: number;
  y: number;
  w: number;
  h: number;
}

const serviceLabelW = (sv: ModelService): number => sansW(sv.name, 13) * 1.04 + (sv.description ? 10 + sansW(sv.description, 12) : 0);

/** Areas under the cards: a faint tint, an even edge and the name at the top left. The tint is masked
 *  out where the cards are, because on a live canvas the glass is painted below this SVG */
function serviceAreas(areas: Area[], boxes: SvgBox[], L: Look, id: (name: string) => string): string {
  const s: string[] = [];
  const holes = boxes.map((b) => `<rect x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}" rx="${RX}" fill="black"/>`).join("");
  s.push(`<mask id="${id("areas")}" maskUnits="userSpaceOnUse"><rect x="-1e5" y="-1e5" width="2e5" height="2e5" fill="white"/>${holes}</mask>`);
  s.push('<g class="rz-services">');
  for (const a of areas) {
    const hue = serviceHue(L, a.hue);
    const [fillA, lineA] = hue ? [0.07, serviceEdge(L)] : [0.035, 0.22];
    s.push(`<g class="rz-svc" data-svc="${esc(a.service.name)}">`);
    s.push(`<rect x="${a.x}" y="${a.y}" width="${a.w}" height="${a.h}" rx="${SERVICE_RX}" fill="${hue ?? C}" fill-opacity="${fillA}" mask="url(#${id("areas")})"/>`);
    s.push(`<rect x="${f(a.x + 0.5)}" y="${f(a.y + 0.5)}" width="${f(a.w - 1)}" height="${f(a.h - 1)}" rx="${SERVICE_RX - 0.5}" fill="none" stroke="${hue ?? C}" stroke-opacity="${lineA}"/>`);
    // The label has a hit area of its own, as a card's header does, so a viewer can open the service
    s.push(`<g class="rz-svc-head"><rect class="rz-hit" x="${f(a.x + SERVICE_PAD - 8)}" y="${f(a.y + 13)}" width="${f(serviceLabelW(a.service) + 16)}" height="26" rx="4" fill="currentColor" fill-opacity="0"/>`);
    s.push(
      `<text x="${f(a.x + SERVICE_PAD)}" y="${f(a.y + 31)}" font-size="13" font-weight="600" letter-spacing="-0.01em" ${hue ? `fill="${hue}"` : fill(L.ink.text)}>${esc(a.service.name)}` +
        (a.service.description ? `<tspan dx="10" font-size="12" font-weight="400" letter-spacing="0" ${fill(L.ink.muted)}>${esc(a.service.description)}</tspan>` : "") +
        "</text>",
    );
    s.push("</g></g>");
  }
  s.push("</g>");
  return s.join("");
}

export async function toSvg(model: Model, elk: ElkLike, options: SvgOptions = {}): Promise<SvgResult> {
  const opts = { columns: options.columns ?? "all", audit: options.audit ?? "collapse", fold: new Set(options.fold ?? []) } as const;
  const look = options.look ?? "graphite";
  const edges = options.edges ?? "angular";
  const L = LOOKS[look];
  const prefix = options.idPrefix ?? "rz-";
  const id = (name: string) => prefix + name;
  const { views: vs, relations } = views(model, opts);
  const byName = new Map(vs.map((v) => [v.table.name, v]));
  const portId = (table: string, column: string, side: "E" | "W") => `${table}::${column}::${side}`;
  const portFor = (table: string, column: string, side: "E" | "W") => portId(table, portOf(byName.get(table)!, column), side);
  const used = new Set(relations.flatMap((r) => [portFor(r.parent, r.parentColumn, "E"), portFor(r.child, r.childColumn, "W")]));

  const tableNode = (v: View): ElkNodeIn => ({
    id: v.table.name,
    width: v.w,
    height: v.h,
    layoutOptions: { "elk.portConstraints": "FIXED_POS" },
    ports: (bare(v) ? [{ name: "", y: HEAD / 2 }] : v.shown.map((c, i) => ({ name: c.name, y: rowY(i) }))).flatMap((row) =>
      (
        [
          ["W", 0, "WEST"],
          ["E", v.w, "EAST"],
        ] as const
      )
        .filter(([side]) => used.has(portId(v.table.name, row.name, side)))
        .map(([side, x, elkSide]) => ({
          id: portId(v.table.name, row.name, side),
          x,
          y: row.y,
          width: 0,
          height: 0,
          layoutOptions: { "elk.port.side": elkSide },
        })),
    ),
  });
  // A service with a drawn table is a node of its own, holding its tables, placed where its first
  // table comes in the document. Connectors run between services as freely as inside them
  const drawnServices = model.services.filter((sv) => vs.some((v) => v.table.service === sv.name));
  const serviceOf = (v: View): ModelService | null => drawnServices.find((sv) => sv.name === v.table.service) ?? null;
  const children: ElkNodeIn[] = [];
  for (const v of vs) {
    const sv = serviceOf(v);
    if (!sv) children.push(tableNode(v));
    else if (!children.some((n) => n.id === SERVICE + sv.name))
      children.push({
        id: SERVICE + sv.name,
        layoutOptions: {
          "elk.padding": `[top=${SERVICE_HEAD},left=${SERVICE_PAD},bottom=${SERVICE_PAD},right=${SERVICE_PAD}]`,
          "elk.nodeSize.constraints": "MINIMUM_SIZE",
          "elk.nodeSize.minimum": `(${Math.ceil(serviceLabelW(sv) + SERVICE_PAD * 2)}, 0)`,
        },
        children: vs.filter((x) => serviceOf(x) === sv).map(tableNode),
      });
  }

  const degree = new Map<string, number>();
  for (const r of relations) for (const name of [r.parent, r.child]) degree.set(name, (degree.get(name) ?? 0) + 1);
  const hasHub = [...degree.values()].some(n => n >= 32);
  const graph: ElkGraphIn = {
    id: "root",
    layoutOptions: {
      ...(drawnServices.length ? { "elk.hierarchyHandling": "INCLUDE_CHILDREN" } : {}),
      // ELK's hub treatment avoids expensive leaf placement around highly referenced tables.
      ...(hasHub ? { "elk.layered.highDegreeNodes.treatment": "true", "elk.layered.highDegreeNodes.threshold": "32" } : {}),
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
    children,
    edges: relations.map((r, i) => ({
      id: `e${i}`,
      sources: [portFor(r.parent, r.parentColumn, "E")],
      targets: [portFor(r.child, r.childColumn, "W")],
    })),
  };

  const g = await elk.layout(graph);
  // A table inside a service is placed relative to it, and so is a connector that stays inside one
  const pos = new Map<string, Point>();
  const offsets = new Map<string, Point>([["root", { x: 0, y: 0 }]]);
  const areas: Area[] = [];
  for (const n of g.children ?? []) {
    const at = { x: n.x ?? 0, y: n.y ?? 0 };
    if (!n.id.startsWith(SERVICE)) {
      pos.set(n.id, at);
      continue;
    }
    offsets.set(n.id, at);
    const sv = drawnServices.find((x) => SERVICE + x.name === n.id)!;
    areas.push({ service: sv, hue: model.services.indexOf(sv), x: f(at.x), y: f(at.y), w: f(n.width ?? 0), h: f(n.height ?? 0) });
    for (const c of n.children ?? []) pos.set(c.id, { x: at.x + (c.x ?? 0), y: at.y + (c.y ?? 0) });
  }
  const routes = new Map<string, { sections: ElkEdgeOut["sections"]; offset: Point }>();
  for (const e of [...(g.edges ?? []), ...(g.children ?? []).flatMap((n) => n.edges ?? [])])
    routes.set(e.id, { sections: e.sections, offset: offsets.get(e.container ?? "root") ?? { x: 0, y: 0 } });
  const W = Math.ceil(g.width ?? 0);
  const H = Math.ceil(g.height ?? 0);
  const boxes: SvgBox[] = vs.map((v) => {
    const p = pos.get(v.table.name)!;
    return { table: v.table.name, x: f(p.x), y: f(p.y), w: v.w, h: v.h };
  });
  // A live canvas paints the stage and the panels itself; the SVG then carries only what sits on them
  const painted = !(L.stage && options.stage === false);
  const cardRects = boxes.map((b) => `<rect x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}" rx="${RX}" fill="white"/>`).join("");
  const stage = L.stage && L.glass && painted ? stageSvg(L.stage, L.glass, id, W, H, cardRects) : null;

  const s: string[] = [];
  const label = `ERD: ${vs.map((v) => v.table.name).join(", ")}`;
  s.push(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" class="rz rz-${look}" role="img" aria-label="${esc(label)}" font-family="${SANS}" font-size="12">`,
  );
  if (options.standalone && !L.stage) s.push(STANDALONE_STYLE);
  s.push(`<title>${esc(label)}</title>`);
  s.push(`<defs>${cardDefs(L, id)}${stage?.defs ?? ""}</defs>`);
  if (stage) s.push(stage.under);
  if (painted) {
    // Shadows first, under the glass. The shadow filter only uses the shape's alpha, so the fill color
    // is irrelevant. Each carries its table's data-t, so a viewer can fade it with the card
    s.push('<g class="rz-shadows">');
    for (const b of boxes)
      s.push(`<rect class="rz-s" data-t="${esc(b.table)}" x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}" rx="${RX}" fill="currentColor" filter="url(#${id("shadow")})"/>`);
    s.push("</g>");
  }
  if (stage) s.push(stage.frost);
  if (areas.length) s.push(serviceAreas(areas, boxes, L, id));

  s.push('<g class="rz-rels">');
  relations.forEach((r, i) => {
    const route = routes.get(`e${i}`);
    const sec = route?.sections?.[0];
    const bends = (sec?.bendPoints ?? []).map((p) => ({ x: p.x + route!.offset.x, y: p.y + route!.offset.y }));
    const pv = byName.get(r.parent)!;
    const cv = byName.get(r.child)!;
    const pp = pos.get(r.parent)!;
    const cp = pos.get(r.child)!;
    // Endpoints snap to the row anchors rather than ELK's coordinates: an endpoint is always an anchor
    const start = { x: pp.x + pv.w, y: pp.y + anchorY(pv, r.parentColumn) };
    const end = { x: cp.x, y: cp.y + anchorY(cv, r.childColumn) };
    const path = clean([start, ...bends, end]);
    const d = edges === "curved" ? curved(path, boxes.filter((b) => b.table !== r.parent && b.table !== r.child)) : pathD(path, 3);
    const dash = r.kind === "logical" ? ' stroke-dasharray="4 3"' : "";
    const ink: Ink = r.change ? [diffHue(L, r.change.kind), r.change.kind === "removed" ? 0.6 : 1] : L.ink.line;
    const composite = r.childColumns ? ` data-acs="${esc(JSON.stringify(r.parentColumns))}" data-bcs="${esc(JSON.stringify(r.childColumns))}"` : "";
    s.push(`<g class="rz-r" data-a="${esc(r.parent)}" data-ac="${esc(r.parentColumn)}" data-b="${esc(r.child)}" data-bc="${esc(r.childColumn)}"${composite}>`);
    s.push(`<path d="${d}" fill="none" ${stroke(ink)} stroke-width="1.2"${dash}/>`);
    // Primary key end: a chevron, like resin's `->`. Foreign key end: a square port and N (many) or 1 (one)
    s.push(
      `<path d="M${f(start.x + 6.5)},${f(start.y - 4.5)} L${f(start.x + 1.5)},${f(start.y)} L${f(start.x + 6.5)},${f(start.y + 4.5)}" fill="none" ${stroke(ink)} stroke-width="1.3"/>`,
    );
    s.push(`<rect x="${f(end.x - 2.5)}" y="${f(end.y - 2.5)}" width="5" height="5" ${fill(ink)}/>`);
    if (!r.bundled) s.push(`<text x="${f(end.x - 9)}" y="${f(end.y - 5)}" text-anchor="end" font-family="${MONO}" font-size="9" ${fill(ink)}>${r.one ? "1" : "N"}</text>`);
    s.push("</g>");
  });
  s.push("</g>", '<g class="rz-tables">');
  vs.forEach((v, i) => {
    const b = boxes[i];
    const change = v.table.change;
    const fade = change?.kind === "removed" ? ' opacity="0.6"' : "";
    const edge = change ? `<rect x="0.75" y="0.75" width="${f(b.w - 1.5)}" height="${f(b.h - 1.5)}" rx="${RX - 0.75}" fill="none" stroke="${diffHue(L, change.kind)}" stroke-width="1.5"/>` : "";
    const service = v.fold ? ` data-svc="${esc(v.fold.service)}"` : "";
    s.push(`<g class="rz-t" data-t="${esc(v.table.name)}"${service} transform="translate(${b.x},${b.y})"${fade}>${card(v, L, id, painted)}${edge}</g>`);
  });
  s.push("</g></svg>");
  return { svg: s.join(""), width: W, height: H, background: L.stage?.base ?? null, boxes };
}
