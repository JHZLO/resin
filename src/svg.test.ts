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

const ORDER = readFileSync(join(EXAMPLES, "order.erd"), "utf8");

describe("toSvg", () => {
  it("테이블마다 카드, 관계마다 선. 감사 테이블은 기본으로 접는다", async () => {
    const { svg, width, height } = await toSvg(modelOf(ORDER), elk);
    expect(count(svg, 'class="rz-t"')).toBe(4);
    expect(count(svg, 'class="rz-r"')).toBe(4);
    expect(count(svg, ">envers</text>")).toBe(2);
    expect(count(svg, ">external</text>")).toBe(1);
    expect(width).toBeGreaterThan(0);
    expect(height).toBeGreaterThan(0);
  });

  it("펼치면 revinfo 와 *_aud 가 따로 그려진다", async () => {
    const { svg } = await toSvg(modelOf(ORDER), elk, { audit: "expand" });
    expect(count(svg, 'class="rz-t"')).toBe(7);
    expect(count(svg, 'class="rz-r"')).toBe(6);
    expect(svg).toContain('data-t="ts_order_payment_aud"');
  });

  it("키만 보면 나머지 컬럼을 +N 으로 줄인다", async () => {
    const { svg } = await toSvg(modelOf(ORDER), elk, { columns: "keys" });
    expect(svg).toContain(">+4 컬럼</text>");
    expect(svg).not.toContain('data-c="buyer_name"');
  });

  it("논리 참조는 점선, 1:1 은 1, 1:N 은 N", async () => {
    const { svg } = await toSvg(modelOf("table a {\n id bigint pk\n}\ntable b {\n id bigint pk\n a_id bigint uk ~> a\n c_id bigint -> a\n}"), elk);
    const rels = svg.split('<g class="rz-r"').slice(1);
    expect(rels.map((r) => [r.includes('stroke-dasharray="4 4"'), />(1|N)<\/text>/.exec(r)?.[1]])).toEqual([
      [true, "1"],
      [false, "N"],
    ]);
  });

  it("바탕을 칠하지 않는다 — 잉크는 currentColor, standalone 만 색을 정한다", async () => {
    const inline = await toSvg(modelOf(ORDER), elk);
    expect(inline.svg).not.toContain("<style>");
    expect(inline.svg).not.toMatch(/fill="#/);
    const file = await toSvg(modelOf(ORDER), elk, { standalone: true });
    expect(file.svg).toContain("prefers-color-scheme:dark");
  });

  it("자기참조도 그린다", async () => {
    const { svg } = await toSvg(modelOf("table c {\n id bigint pk\n parent_id bigint? -> c\n}"), elk);
    expect(count(svg, 'class="rz-r"')).toBe(1);
  });

  it("같은 입력이면 같은 SVG", async () => {
    const a = await toSvg(modelOf(ORDER), elk);
    const b = await toSvg(modelOf(ORDER), new ELK());
    expect(a.svg).toBe(b.svg);
  });
});

// 골든: examples/<name>.erd → examples/<name>.svg (standalone). 모양을 바꾸면 여기가 깨진다 —
// SVG 를 열어 눈으로 확인하고 의도한 변화일 때만 `pnpm test -u` 로 갱신한다.
describe("golden svg", () => {
  for (const file of readdirSync(EXAMPLES).filter((f) => f.endsWith(".erd")).sort()) {
    it(file, async () => {
      const { svg } = await toSvg(modelOf(readFileSync(join(EXAMPLES, file), "utf8")), elk, { standalone: true });
      await expect(svg + "\n").toMatchFileSnapshot(join(EXAMPLES, file.replace(/\.erd$/, ".svg")));
    });
  }
});
