// @vitest-environment jsdom
// Does Mermaid actually read our output? The contract of this backend is not a string shape but
// "Mermaid parses it". The version is pinned to 11.16.0 in package.json; bump it through this test.
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

/** Parse and return the entity names */
async function entities(src: string): Promise<string[]> {
  await mermaid.parse(src);
  const d = await mermaid.mermaidAPI.getDiagramFromText(src);
  return [...(d.db as { getEntities(): Map<string, unknown> }).getEntities().keys()];
}

describe("Mermaid 11.16 reads the output", () => {
  for (const file of readdirSync(EXAMPLES).filter((f) => f.endsWith(".mmd")).sort()) {
    it(file, async () => {
      const src = readFileSync(join(EXAMPLES, file), "utf8");
      expect((await entities(src)).length).toBeGreaterThan(0);
    });
  }

  it("with keyword, hyphenated and Hangul table names and rewritten column names", async () => {
    const r = compile(`
      external table \`order-items\` "Outside" {
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
