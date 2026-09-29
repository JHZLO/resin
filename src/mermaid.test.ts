import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { compile } from "./index.ts";

const EXAMPLES = join(import.meta.dirname, "../examples");

describe("toMermaid", () => {
  it("1:1 은 o|, 논리 참조는 점선", () => {
    const { mermaid } = compile("erd\ntable a {\n id bigint pk\n}\ntable b {\n a_id bigint uk ~> a\n}");
    expect(mermaid).toContain('    a ||..o| b : "a_id"');
    expect(mermaid).toContain('        bigint a_id FK,UK "~> a.id"');
  });

  it("설명의 따옴표는 #quot; 로 바꾼다 — mermaid 는 \\\" 를 모른다", () => {
    const { mermaid } = compile('erd\ntable a {\n x int "say \\"hi\\""\n}');
    expect(mermaid).toContain('int x "say #quot;hi#quot;"');
  });

  it("오류가 있으면 mermaid 를 만들지 않는다", () => {
    const r = compile("erd\ntable a {\n x int -> nope\n}");
    expect(r.mermaid).toBeNull();
    expect(r.diagnostics).toHaveLength(1);
  });

  it("같은 입력이면 같은 출력", () => {
    const src = readFileSync(join(EXAMPLES, "order.erd"), "utf8");
    expect(compile(src).mermaid).toBe(compile(src).mermaid);
  });
});

// 골든: examples/<name>.erd → examples/<name>.mmd. 출력 형식을 바꾸면 여기가 깨진다 —
// diff 를 눈으로 확인하고 의도한 변화일 때만 `pnpm test -u` 로 갱신한다.
describe("golden", () => {
  for (const file of readdirSync(EXAMPLES).filter((f) => f.endsWith(".erd")).sort()) {
    it(file, async () => {
      const r = compile(readFileSync(join(EXAMPLES, file), "utf8"));
      expect(r.diagnostics).toEqual([]);
      await expect(r.mermaid).toMatchFileSnapshot(join(EXAMPLES, file.replace(/\.erd$/, ".mmd")));
    });
  }
});
