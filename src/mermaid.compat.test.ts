// @vitest-environment jsdom
// mermaid 가 우리 출력을 실제로 읽는가 — 출력의 계약은 문자열 모양이 아니라 "mermaid 가 파싱한다" 이다.
// 버전은 package.json 에 11.16.0 으로 고정해 두고, 올릴 때 이 테스트로 확인한다.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { compile } from "./index.ts";

const EXAMPLES = join(import.meta.dirname, "../examples");

type Mermaid = typeof import("mermaid").default;
let mermaid: Mermaid;

beforeAll(async () => {
  mermaid = (await import("mermaid")).default;
  mermaid.initialize({ startOnLoad: false });
});

/** 파싱하고 엔티티 이름 목록을 돌려준다 */
async function entities(src: string): Promise<string[]> {
  await mermaid.parse(src);
  const d = await mermaid.mermaidAPI.getDiagramFromText(src);
  return [...(d.db as { getEntities(): Map<string, unknown> }).getEntities().keys()];
}

describe("mermaid 11.16 이 출력을 읽는다", () => {
  for (const file of readdirSync(EXAMPLES).filter((f) => f.endsWith(".mmd")).sort()) {
    it(file, async () => {
      const src = readFileSync(join(EXAMPLES, file), "utf8");
      expect((await entities(src)).length).toBeGreaterThan(0);
    });
  }

  it("예약어, 하이픈, 한글 테이블 이름과 고친 컬럼 이름", async () => {
    const r = compile(`
      external table \`order-items\` "외부" {
        id bigint pk
      }
      table style {
        pk int pk
        \`order no\` varchar(32)?
        \`2fa\` int
        item_id bigint -> \`order-items\`
      } audit envers
      table \`주문\` {
        id bigint pk
        s_pk int ~> style
      }`);
    expect(r.diagnostics).toEqual([]);
    expect(await entities(r.mermaid!)).toEqual(["order-items", "style", "주문", "revinfo", "style_aud"]);
  });
});
