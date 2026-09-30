// 개발용 CLI — `pnpm resin <file.erd> [--ast | --model]`
// 진단은 stderr 에 컴파일러 형식으로, 결과(mermaid, 구문 트리 JSON, 모델 JSON)는 stdout 에 쓴다.
// 오류가 있으면 종료 코드 1.

import { readFileSync } from "node:fs";
import { compile, formatDiagnostic } from "./index.ts";

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith("--"));
if (!file) {
  console.error("usage: pnpm resin <file.erd> [--ast | --model]");
  process.exit(2);
}

const source = readFileSync(file, "utf8");
const result = compile(source);
for (const d of result.diagnostics) console.error(formatDiagnostic(d, source, file) + "\n");

if (args.includes("--ast")) console.log(JSON.stringify(result.doc, null, 2));
else if (args.includes("--model")) console.log(JSON.stringify(result.model, null, 2));
else if (result.mermaid) process.stdout.write(result.mermaid);

process.exit(result.mermaid === null ? 1 : 0);
