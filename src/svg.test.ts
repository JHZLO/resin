import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import ELK from "elkjs";
import { describe, expect, it } from "vitest";
import { compile } from "./index.ts";
import { toSvg } from "./svg.ts";

const EXAMPLES = join(import.meta.dirname, "../examples");
const elk = new ELK();

const modelOf = (src: string) => {
  const r = compile(src);
  expect(r.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
  return r.model!;
};
const count = (svg: string, needle: string) => svg.split(needle).length - 1;
const widthOf = (svg: string) => Number(/viewBox="0 0 (\d+)/.exec(svg)![1]);

const ORDER = readFileSync(join(EXAMPLES, "order.erd"), "utf8");

describe("toSvg", () => {
  it("draws a card per table and a connector per relation, folding audit tables by default", async () => {
    const { svg, width, height } = await toSvg(modelOf(ORDER), elk);
    expect(count(svg, 'class="rz-t"')).toBe(4);
    expect(count(svg, 'class="rz-r"')).toBe(4);
    expect(count(svg, ">envers</text>")).toBe(2);
    expect(count(svg, ">external</text>")).toBe(1);
    expect(width).toBeGreaterThan(0);
    expect(height).toBeGreaterThan(0);
  });

  it("draws revinfo and *_aud when audit tables are expanded", async () => {
    const { svg } = await toSvg(modelOf(ORDER), elk, { audit: "expand" });
    expect(count(svg, 'class="rz-t"')).toBe(7);
    expect(count(svg, 'class="rz-r"')).toBe(6);
    expect(svg).toContain('data-t="payments_aud"');
  });

  it("collapses non-key columns into +N when showing keys only", async () => {
    const { svg } = await toSvg(modelOf(ORDER), elk, { columns: "keys" });
    expect(svg).toContain(">+4 columns</text>");
    expect(svg).not.toContain('data-c="buyer_name"');
  });

  it("dashes logical references and labels one-to-one 1 and one-to-many N", async () => {
    const { svg } = await toSvg(modelOf("table a {\n id bigint pk\n}\ntable b {\n id bigint pk\n a_id bigint uk ~> a\n c_id bigint -> a\n}"), elk);
    const rels = svg.split('<g class="rz-r"').slice(1);
    expect(rels.map((r) => [r.includes("stroke-dasharray"), />(1|N)<\/text>/.exec(r)?.[1]])).toEqual([
      [true, "1"],
      [false, "N"],
    ]);
  });

  it("paints no background: ink is currentColor, and only standalone output picks colors", async () => {
    const inline = await toSvg(modelOf(ORDER), elk);
    expect(inline.svg).not.toContain("<style>");
    expect(inline.svg).not.toMatch(/fill="#/);
    const file = await toSvg(modelOf(ORDER), elk, { standalone: true });
    expect(file.svg).toContain("prefers-color-scheme:dark");
  });

  it("draws aurora and clear over their own backdrop, frosted inside the cards", async () => {
    for (const look of ["aurora", "clear"] as const) {
      const r = await toSvg(modelOf(ORDER), elk, { look });
      expect(r.background).toMatch(/^#/);
      expect(r.svg).toContain('id="rz-backdrop"');
      expect(r.svg).toContain('filter="url(#rz-frost)"');
      expect(r.svg).toContain('mask="url(#rz-cards)"');
    }
    expect((await toSvg(modelOf(ORDER), elk)).background).toBeNull();
  });

  it("prefixes every id so several drawings can share a page", async () => {
    const { svg } = await toSvg(modelOf(ORDER), elk, { look: "aurora", idPrefix: "a1-" });
    const ids = [...svg.matchAll(/id="([^"]+)"/g)].map((m) => m[1]);
    const refs = [...svg.matchAll(/url\(#([^)]+)\)|href="#([^"]+)"/g)].map((m) => m[1] ?? m[2]);
    expect(ids.every((i) => i.startsWith("a1-"))).toBe(true);
    expect(refs.every((r) => ids.includes(r))).toBe(true);
  });

  it("bleeds the backdrop beyond the drawing for canvases that pan", async () => {
    const { svg } = await toSvg(modelOf(ORDER), elk, { look: "clear", bleed: 2000 });
    expect(svg).toContain('style="overflow:visible"');
    expect(svg).toContain('x="-2000" y="-2000"');
  });

  it("measures Hangul as double width", async () => {
    const latin = await toSvg(modelOf('table t "abcdefghijklmnopqrstuvwxyz abcdefghij" {\n id bigint pk\n}'), elk);
    const hangul = await toSvg(modelOf('table t "주문 주문 주문 주문 주문 주문 주문 주문 주문 주문" {\n id bigint pk\n}'), elk);
    expect(widthOf(hangul.svg)).toBeGreaterThan(widthOf(latin.svg));
  });

  it("draws self references", async () => {
    const { svg } = await toSvg(modelOf("table c {\n id bigint pk\n parent_id bigint? -> c\n}"), elk);
    expect(count(svg, 'class="rz-r"')).toBe(1);
  });

  it("is deterministic", async () => {
    const a = await toSvg(modelOf(ORDER), elk);
    const b = await toSvg(modelOf(ORDER), new ELK());
    expect(a.svg).toBe(b.svg);
  });
});

// Golden files: examples/<name>.erd → examples/<name>.svg (graphite, standalone), plus the glass looks
// of the order example, which the README shows. Changing the drawing breaks these; open the SVG, check
// it by eye and update with `pnpm test -u` only when the change is intended.
describe("golden svg", () => {
  for (const file of readdirSync(EXAMPLES).filter((f) => f.endsWith(".erd")).sort()) {
    it(file, async () => {
      const { svg } = await toSvg(modelOf(readFileSync(join(EXAMPLES, file), "utf8")), elk, { standalone: true });
      await expect(svg + "\n").toMatchFileSnapshot(join(EXAMPLES, file.replace(/\.erd$/, ".svg")));
    });
  }
  for (const look of ["aurora", "clear"] as const) {
    it(`order.erd (${look})`, async () => {
      const { svg } = await toSvg(modelOf(ORDER), elk, { look });
      await expect(svg + "\n").toMatchFileSnapshot(join(EXAMPLES, `order.${look}.svg`));
    });
  }
});
