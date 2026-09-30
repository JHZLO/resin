// 모델 → SVG. resin 이 직접 그리는 ERD("문서 카드").
//
// 순서: 카드 크기 계산 → ELK 배치(컬럼 행마다 포트, 직교 배선) → SVG 문자열.
//
// 결정적이어야 한다: 글자 폭을 재지 않고 규칙으로 계산한다(고정폭 = 칸 수 × 0.6em, 비례폭 = 영문
// 0.56em, 한글 1em 추정). 그래서 브라우저든 CLI 든 같은 입력이면 같은 SVG 가 나온다.
//
// 잉크는 currentColor 하나에 투명도 단계만 쓴다. 바탕을 칠하지 않아서 어느 페이지에 붙여도 읽힌다.
// standalone 이면 <img> 로 붙여도 읽히게 prefers-color-scheme 에 따라 잉크 색을 정하는 <style> 을 싣는다.
//
// ELK 는 인자로 받는다 — 코어가 elkjs 에 묶이지 않게(런타임 의존성 0). 쓰는 쪽이 `new ELK()` 를 넘긴다.

import type { Model, ModelColumn, ModelTable, Relation } from "./model.ts";

export interface SvgOptions {
  /** all = 모든 컬럼, keys = 키와 참조에 쓰이는 컬럼만(나머지는 "+N 컬럼") */
  columns?: "all" | "keys";
  /** collapse = 감사 테이블을 원래 테이블 머리의 표로 접는다, expand = revinfo 와 *_aud 를 따로 그린다 */
  audit?: "collapse" | "expand";
  /** 파일로 내보낼 때: 밝은/어두운 바탕에 맞춰 잉크 색을 정하는 <style> 을 싣는다 */
  standalone?: boolean;
}

export interface SvgResult {
  svg: string;
  width: number;
  height: number;
}

// ELK 에서 쓰는 모양만 — elkjs 의 타입에 묶이지 않으려고 구조로 적는다
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

const MONO = "'IBM Plex Mono', ui-monospace, 'SF Mono', Menlo, Consolas, monospace";
const SANS = "'IBM Plex Sans KR', 'Apple SD Gothic Neo', 'Noto Sans KR', system-ui, sans-serif";

// ---- 글자 폭 ----

const WIDE = /[ᄀ-ᇿ⺀-꓏가-힯豈-﫿︰-﹏＀-｠￠-￦]/;
const cells = (s: string): number => [...s].reduce((n, ch) => n + (WIDE.test(ch) ? 2 : 1), 0);
const monoW = (s: string, size: number): number => cells(s) * size * 0.6;
const sansW = (s: string, size: number): number => [...s].reduce((w, ch) => w + (WIDE.test(ch) ? size : size * 0.56), 0);

const esc = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const f = (v: number): number => Math.round(v * 10) / 10;
const up8 = (v: number): number => Math.ceil(v / 8) * 8;
const maxOf = (xs: number[], floor = 0): number => xs.reduce((m, x) => Math.max(m, x), floor);

// ---- 카드 치수 (8 단위 격자 위에서) ----

const PAD_X = 14;
const HEAD_H = 36;
const ROW_H = 26;
const FOOT_H = 18;
const TONE = { body: 0.85, muted: 0.62, faint: 0.4, line: 0.28, hair: 0.12 } as const;

interface View {
  table: ModelTable;
  shown: ModelColumn[];
  hidden: number;
  /** 이 테이블 컬럼 중 관계의 자식 쪽으로 쓰이는 것 */
  refCols: Set<string>;
  tag: string | null;
  foot: string[];
  w: number;
  h: number;
  nameW: number;
}

function flags(c: ModelColumn, v: { refCols: Set<string> }): string {
  const out: string[] = [];
  if (c.pk && v.refCols.has(c.name)) out.push("fk");
  if (c.enumValues) out.push("enum");
  if (c.enc) out.push("enc");
  if (c.index) out.push("ix");
  return out.join(" ");
}

function rowTitle(c: ModelColumn, t: ModelTable): string {
  const parts = [`${c.name} ${c.type}${c.nullable && t.origin !== "audit" ? "?" : ""}`];
  if (c.description) parts.push(c.description);
  if (c.enumValues) parts.push(c.enumValues.join(" / "));
  if (c.ukName) parts.push(`unique ${c.ukName}`);
  if (c.index) parts.push(`index${c.index.name ? " " + c.index.name : ""}`);
  if (c.ref) parts.push(`${c.ref.kind === "physical" ? "->" : "~>"} ${c.ref.table}.${c.ref.column}`);
  return parts.join("\n");
}

function measure(v: Omit<View, "w" | "h" | "nameW">): Pick<View, "w" | "h" | "nameW"> {
  const typeOf = (c: ModelColumn) => c.type + (c.nullable && v.table.origin !== "audit" ? "?" : "");
  const nameW = maxOf(v.shown.map((c) => sansW(c.name, 12)), 40);
  const descW = maxOf(v.shown.map((c) => (c.description ? sansW(c.description, 11) : 0)));
  const typeW = maxOf(v.shown.map((c) => monoW(typeOf(c), 11)), 40);
  const flagW = maxOf(v.shown.map((c) => (flags(c, v) ? monoW(flags(c, v), 10) + 10 : 0)));
  const rowW = PAD_X * 2 + 16 + nameW + (descW ? 12 + descW : 0) + 20 + flagW + typeW;
  const t = v.table;
  const headW = PAD_X * 2 + sansW(t.name, 13) + 8 + (t.description ? sansW(t.description, 12) : 0) + (v.tag ? 12 + monoW(v.tag, 10) + 12 : 0);
  const footW = PAD_X * 2 + maxOf(v.foot.map((s) => sansW(s, 10.5)));
  return {
    w: up8(Math.max(rowW, headW, footW, 168)),
    h: up8(HEAD_H + v.shown.length * ROW_H + (v.foot.length ? v.foot.length * FOOT_H + 4 : 0) + 2),
    nameW,
  };
}

const rowY = (i: number): number => HEAD_H + i * ROW_H + ROW_H / 2;

function pill(text: string, right: number, y: number): string {
  const w = monoW(text, 10) + 12;
  return (
    `<g transform="translate(${f(right - w)},${y})">` +
    `<rect width="${f(w)}" height="16" rx="8" fill="currentColor" fill-opacity=".06" stroke="currentColor" stroke-opacity="${TONE.line}"/>` +
    `<text x="${f(w / 2)}" y="11.5" text-anchor="middle" font-family="${MONO}" font-size="10" fill-opacity="${TONE.muted}">${esc(text)}</text></g>`
  );
}

function card(v: View): string {
  const t = v.table;
  const audit = t.origin === "audit";
  const s: string[] = [];
  s.push(
    `<rect width="${v.w}" height="${v.h}" rx="2" fill="none" stroke="currentColor" stroke-opacity="${TONE.line}"${t.origin === "external" ? ' stroke-dasharray="4 3"' : ""}/>`,
  );
  s.push(
    `<text x="${PAD_X}" y="23" font-size="13" font-weight="600"${audit ? ` fill-opacity="${TONE.muted}"` : ""}>${esc(t.name)}` +
      (t.description ? `<tspan dx="8" font-size="12" font-weight="400" fill-opacity="${TONE.muted}">${esc(t.description)}</tspan>` : "") +
      "</text>",
  );
  if (v.tag) s.push(pill(v.tag, v.w - PAD_X, 10));
  s.push(`<line x1="0" y1="${HEAD_H}" x2="${v.w}" y2="${HEAD_H}" stroke="currentColor" stroke-opacity="${TONE.line}"/>`);

  v.shown.forEach((c, i) => {
    const cy = rowY(i);
    const by = cy + 4;
    const fl = flags(c, v);
    s.push(`<g class="rz-c" data-c="${esc(c.name)}"><title>${esc(rowTitle(c, t))}</title>`);
    s.push(`<rect class="rz-hit" x="1" y="${f(cy - 13)}" width="${v.w - 2}" height="${ROW_H}" fill="currentColor" fill-opacity="0"/>`);
    if (i > 0) s.push(`<line x1="${PAD_X}" y1="${f(cy - 13)}" x2="${v.w - PAD_X}" y2="${f(cy - 13)}" stroke="currentColor" stroke-opacity="${TONE.hair}"/>`);
    if (c.pk) s.push(`<circle cx="${PAD_X + 4}" cy="${f(cy)}" r="3" fill="currentColor"/>`);
    else if (c.uk) s.push(`<circle cx="${PAD_X + 4}" cy="${f(cy)}" r="3" fill="none" stroke="currentColor" stroke-opacity="${TONE.body}"/>`);
    s.push(`<text x="${PAD_X + 16}" y="${f(by)}" fill-opacity="${TONE.body}"${c.pk ? ' font-weight="600"' : ""}>${esc(c.name)}</text>`);
    if (c.description)
      s.push(`<text x="${f(PAD_X + 16 + v.nameW + 12)}" y="${f(by)}" font-size="11" fill-opacity="${TONE.muted}">${esc(c.description)}</text>`);
    const nullable = c.nullable && !audit;
    const right = v.w - PAD_X;
    s.push(
      `<text x="${right}" y="${f(by)}" text-anchor="end" font-family="${MONO}" font-size="11" fill-opacity="${TONE.muted}">${esc(c.type)}` +
        (nullable ? '<tspan fill-opacity="1" font-weight="600">?</tspan>' : "") +
        "</text>",
    );
    if (fl) {
      const tw = monoW(c.type + (nullable ? "?" : ""), 11);
      s.push(
        `<text x="${f(right - tw - 10)}" y="${f(by)}" text-anchor="end" font-family="${MONO}" font-size="10" fill-opacity="${TONE.faint}">${esc(fl)}</text>`,
      );
    }
    s.push("</g>");
  });

  if (v.foot.length) {
    const fy = HEAD_H + v.shown.length * ROW_H;
    s.push(`<line x1="0" y1="${fy}" x2="${v.w}" y2="${fy}" stroke="currentColor" stroke-opacity="${TONE.hair}"/>`);
    v.foot.forEach((line, k) =>
      s.push(`<text x="${PAD_X}" y="${f(fy + 13 + k * FOOT_H)}" font-size="10.5" fill-opacity="${TONE.faint}">${esc(line)}</text>`),
    );
  }
  return s.join("");
}

// ---- 관계선 ----

/** 직교 경로의 꺾임을 반지름 r 로 둥글린다 */
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

/** 겹친 점과, 한 직선 위의 가운데 점을 뺀다 — 직선 한가운데 둥근 모서리가 생기지 않게 */
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

/** 부모(PK) 쪽: 화살촉 — 선은 resin 의 `->` 처럼 FK 에서 PK 로 간다 */
const arrowHead = (x: number, y: number): string =>
  `<path d="M${f(x + 7)},${f(y - 6)} L${f(x)},${f(y)} L${f(x + 7)},${f(y + 6)}" stroke-linejoin="round" stroke-linecap="round"/>`;

/** 자식(FK) 쪽: 점과 다중도 — N(여럿) / 1(하나) */
const tail = (x: number, y: number, one: boolean): string =>
  `<circle cx="${f(x)}" cy="${f(y)}" r="2.5" fill="currentColor" fill-opacity="${TONE.muted}" stroke="none"/>` +
  `<text x="${f(x - 8)}" y="${f(y - 5)}" text-anchor="end" font-family="${MONO}" font-size="10" fill="currentColor" fill-opacity="${TONE.muted}" stroke="none">${one ? "1" : "N"}</text>`;

// ---- 조립 ----

function views(model: Model, opts: Required<Omit<SvgOptions, "standalone">>): { views: View[]; relations: Relation[] } {
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
    if (hidden) foot.push(`+${hidden} 컬럼`);
    const base = { table, shown, hidden, refCols, tag, foot };
    return { ...base, ...measure(base) };
  });
  return { views: out, relations };
}

const STANDALONE_STYLE =
  "<style>.rz{color:#1f2328}@media (prefers-color-scheme:dark){.rz{color:#e6edf3}}</style>";

export async function toSvg(model: Model, elk: ElkLike, options: SvgOptions = {}): Promise<SvgResult> {
  const opts = { columns: options.columns ?? "all", audit: options.audit ?? "collapse" } as const;
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
      "elk.layered.spacing.nodeNodeBetweenLayers": "72",
      "elk.layered.spacing.edgeNodeBetweenLayers": "32",
      "elk.spacing.nodeNode": "32",
      "elk.spacing.edgeEdge": "12",
      "elk.spacing.edgeNode": "20",
      "elk.spacing.componentComponent": "48",
      "elk.layered.considerModelOrder.strategy": "NODES_AND_EDGES",
      "elk.layered.nodePlacement.strategy": "BRANDES_KOEPF",
      "elk.padding": "[top=16,left=16,bottom=16,right=16]",
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

  const s: string[] = [];
  const label = `ERD: ${vs.map((v) => v.table.name).join(", ")}`;
  s.push(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" class="rz" role="img" aria-label="${esc(label)}" font-family="${SANS}" font-size="12" fill="currentColor">`,
  );
  if (options.standalone) s.push(STANDALONE_STYLE);
  s.push(`<title>${esc(label)}</title>`);
  s.push('<g class="rz-rels">');
  (g.edges ?? []).forEach((e, i) => {
    const r = relations[i];
    const sec = e.sections?.[0];
    const pv = byName.get(r.parent)!;
    const cv = byName.get(r.child)!;
    const pp = pos.get(r.parent)!;
    const cp = pos.get(r.child)!;
    // 끝점은 ELK 가 준 좌표가 아니라 행의 앵커로 맞춘다 — 끝점은 늘 앵커다
    const start = { x: pp.x + pv.w, y: pp.y + rowY(pv.shown.findIndex((c) => c.name === r.parentColumn)) };
    const end = { x: cp.x, y: cp.y + rowY(cv.shown.findIndex((c) => c.name === r.childColumn)) };
    const pts = clean([start, ...(sec?.bendPoints ?? []), end]);
    s.push(
      `<g class="rz-r" data-a="${esc(r.parent)}" data-ac="${esc(r.parentColumn)}" data-b="${esc(r.child)}" data-bc="${esc(r.childColumn)}" stroke="currentColor" stroke-opacity="${TONE.muted}" stroke-width="1" fill="none">`,
    );
    s.push(`<path d="${pathD(pts, 6)}"${r.kind === "logical" ? ' stroke-dasharray="4 4"' : ""}/>`);
    s.push(arrowHead(start.x, start.y), tail(end.x, end.y, r.one), "</g>");
  });
  s.push("</g>", '<g class="rz-tables">');
  for (const v of vs) {
    const p = pos.get(v.table.name)!;
    s.push(`<g class="rz-t" data-t="${esc(v.table.name)}" transform="translate(${f(p.x)},${f(p.y)})">${card(v)}</g>`);
  }
  s.push("</g></svg>");
  return { svg: s.join(""), width: W, height: H };
}
