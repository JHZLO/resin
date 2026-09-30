// 개발용 CLI — `pnpm resin <file.erd> [--ast | --model | --svg [--keys] [--expand-audit]]`
// 진단은 stderr 에 컴파일러 형식으로, 결과(mermaid, 구문 트리 JSON, 모델 JSON, SVG)는 stdout 에 쓴다.
// 오류가 있으면 종료 코드 1.

import { readFileSync } from "node:fs";
import { compile, formatDiagnostic, toSvg } from "./index.ts";

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith("--"));
if (!file) {
  console.error("usage: pnpm resin <file.erd> [--ast | --model | --svg [--keys] [--expand-audit]]");
  process.exit(2);
}

const source = readFileSync(file, "utf8");
const result = compile(source);
for (const d of result.diagnostics) console.error(formatDiagnostic(d, source, file) + "\n");

if (args.includes("--ast")) console.log(JSON.stringify(result.doc, null, 2));
else if (args.includes("--model")) console.log(JSON.stringify(result.model, null, 2));
else if (args.includes("--svg")) {
  if (result.model) {
    // SVG 는 배치에 elkjs 가 필요하다 — 코어는 elkjs 에 묶이지 않고 여기서만 불러온다
    const { default: ELK } = await import("elkjs");
    const { svg } = await toSvg(result.model, new ELK(), {
      standalone: true,
      columns: args.includes("--keys") ? "keys" : "all",
      audit: args.includes("--expand-audit") ? "expand" : "collapse",
    });
    process.stdout.write(svg + "\n");
  }
}
else if (result.mermaid) process.stdout.write(result.mermaid);

process.exit(result.mermaid === null ? 1 : 0);
