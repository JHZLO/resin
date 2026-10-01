// Command-line entry: `pnpm resin <file.erd> [--ast | --model | --svg [--look <look>] [--curved] [--keys] [--expand-audit]]`
// Diagnostics go to stderr in compiler format; the result (Mermaid, syntax tree JSON, model JSON
// or SVG) goes to stdout. Exits with 1 when there are errors.

import { readFileSync } from "node:fs";
import { type SvgLook, compile, formatDiagnostic, toSvg } from "./index.ts";

const USAGE = `usage: resin <file.erd> [options]

  (no option)      print Mermaid erDiagram
  --svg            print SVG (needs elkjs)
    --look <look>  plain (default, no background), dark or light
    --curved       curved connectors instead of right-angled ones
    --keys         show key and reference columns only
    --expand-audit draw audit tables instead of folding them
  --model          print the resolved model as JSON
  --ast            print the syntax tree as JSON`;

const LOOKS: readonly SvgLook[] = ["plain", "dark", "light"];

const args = process.argv.slice(2);
const lookAt = args.indexOf("--look");
const look = lookAt >= 0 ? args[lookAt + 1] : "plain";
const file = args.find((a, i) => !a.startsWith("--") && (lookAt < 0 || i !== lookAt + 1));
if (!file || args.includes("--help")) {
  console.error(USAGE);
  process.exit(file ? 0 : 2);
}
if (!LOOKS.includes(look as SvgLook)) {
  console.error(`resin: --look takes ${LOOKS.join(", ")}\n\n${USAGE}`);
  process.exit(2);
}

const source = readFileSync(file, "utf8");
const result = compile(source);
for (const d of result.diagnostics) console.error(formatDiagnostic(d, source, file) + "\n");

if (args.includes("--ast")) console.log(JSON.stringify(result.doc, null, 2));
else if (args.includes("--model")) console.log(JSON.stringify(result.model, null, 2));
else if (args.includes("--svg")) {
  if (result.model) {
    // Layout needs elkjs. The core does not depend on it; only this entry point loads it.
    const { default: ELK } = await import("elkjs");
    const { svg } = await toSvg(result.model, new ELK(), {
      look: look as SvgLook,
      edges: args.includes("--curved") ? "curved" : "angular",
      standalone: true,
      columns: args.includes("--keys") ? "keys" : "all",
      audit: args.includes("--expand-audit") ? "expand" : "collapse",
    });
    process.stdout.write(svg + "\n");
  }
} else if (result.mermaid) process.stdout.write(result.mermaid);

process.exit(result.mermaid === null ? 1 : 0);
