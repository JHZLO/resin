// Command-line entry: `pnpm resin <file.erd> [--look <look>] [--curved] [--keys | --names] [--expand-audit] | --model | --ast | --lint`,
// or `pnpm resin <file.sql> --from-sql [--infer-refs]`.
// Diagnostics go to stderr in compiler format; the result (the SVG, model JSON, syntax tree JSON or,
// from SQL, resin source) goes to stdout. Exits with 1 when there are errors.

import { readFileSync } from "node:fs";
import { type SvgLook, compile, formatDiagnostic, fromSql, lint, toSvg } from "./index.ts";

const USAGE = `usage: resin <file.erd> [options]
       resin <file.sql> --from-sql [--infer-refs]

  (no option)      print the diagram as SVG (needs elkjs)
    --look <look>  graphite (default, no background), or a glass theme:
                   aurora-dark, aurora-light, silk-dark, silk-light,
                   caustic-dark, caustic-light
    --curved       curved connectors instead of right-angled ones
    --keys         show key and reference columns only
    --names        show table names only
    --expand-audit draw audit tables instead of folding them
  --model          print the resolved model as JSON
  --ast            print the syntax tree as JSON
  --lint           check the lint rules too; print only the problems, and
                   exit with 1 when there is an error or a lint finding
  --from-sql       read SQL DDL and print it as resin
    --infer-refs   also read <table>_id columns as logical references (~>)`;

const LOOKS: readonly SvgLook[] = ["graphite", "aurora-dark", "aurora-light", "silk-dark", "silk-light", "caustic-dark", "caustic-light"];

const args = process.argv.slice(2);
const lookAt = args.indexOf("--look");
const look = lookAt >= 0 ? args[lookAt + 1] : "graphite";
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

if (args.includes("--from-sql")) {
  const converted = fromSql(source, { inferReferences: args.includes("--infer-refs") });
  for (const n of converted.notes) console.error(`${file}:${n.line}:${n.col}: note: ${n.message}`);
  if (converted.tables === 0) {
    console.error(`resin: ${file} has no CREATE TABLE to convert`);
    process.exit(1);
  }
  process.stdout.write(converted.source);
  process.exit(0);
}

const result = compile(source);

if (args.includes("--lint")) {
  // Lint needs a document that compiled; with errors there is nothing to lint yet
  const findings = result.model ? lint(result.doc) : [];
  const all = [...result.diagnostics, ...findings].sort((a, b) => a.span.line - b.span.line || a.span.col - b.span.col);
  for (const d of all) console.error(formatDiagnostic(d, source, file) + "\n");
  process.exit(result.model === null || findings.length > 0 ? 1 : 0);
}

for (const d of result.diagnostics) console.error(formatDiagnostic(d, source, file) + "\n");

if (args.includes("--ast")) console.log(JSON.stringify(result.doc, null, 2));
else if (args.includes("--model")) console.log(JSON.stringify(result.model, null, 2));
else if (result.model) {
  // Layout needs elkjs. The core does not depend on it; only this entry point loads it.
  const { default: ELK } = await import("elkjs");
  const { svg } = await toSvg(result.model, new ELK(), {
    look: look as SvgLook,
    edges: args.includes("--curved") ? "curved" : "angular",
    standalone: true,
    columns: args.includes("--names") ? "none" : args.includes("--keys") ? "keys" : "all",
    audit: args.includes("--expand-audit") ? "expand" : "collapse",
  });
  process.stdout.write(svg + "\n");
}

process.exit(result.model === null ? 1 : 0);
