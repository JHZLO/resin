// Command-line entry: `pnpm resin <file.erd> [--look <look>] [--curved] [--keys | --names] [--expand-audit] | --model | --ast | --lint`,
// `pnpm resin diff <before.erd> <after.erd> [--markdown]`, or `pnpm resin <file.sql> --from-sql [--infer-refs]`.
// Diagnostics go to stderr in compiler format; the result (the SVG, model JSON, syntax tree JSON or,
// from SQL, resin source) goes to stdout. Exits with 1 when there are errors.

import { readFileSync } from "node:fs";
import { type Model, type SvgLook, compile, diff, diffMarkdown, formatDiagnostic, fromSql, lint, toSvg } from "./index.ts";

const USAGE = `usage: resin <file.erd> [options]
       resin diff <before.erd> <after.erd> [--markdown] [drawing options]
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
    --infer-refs   also read <table>_id columns as logical references (~>)

  diff             draw <after.erd> with what changed since <before.erd>
                   marked: added, removed, changed. The drawing options apply
    --markdown     print the list of changes as Markdown instead`;

const LOOKS: readonly SvgLook[] = ["graphite", "aurora-dark", "aurora-light", "silk-dark", "silk-light", "caustic-dark", "caustic-light"];

const args = process.argv.slice(2);
const lookAt = args.indexOf("--look");
const look = lookAt >= 0 ? args[lookAt + 1] : "graphite";
const files = args.filter((a, i) => !a.startsWith("--") && (lookAt < 0 || i !== lookAt + 1));
const command = files[0] === "diff" ? "diff" : null;
const file = command ? files[1] : files[0];
if (!file || (command === "diff" && !files[2]) || args.includes("--help")) {
  console.error(USAGE);
  process.exit(args.includes("--help") && file ? 0 : 2);
}
if (!LOOKS.includes(look as SvgLook)) {
  console.error(`resin: --look takes ${LOOKS.join(", ")}\n\n${USAGE}`);
  process.exit(2);
}

const drawing = {
  look: look as SvgLook,
  edges: args.includes("--curved") ? ("curved" as const) : ("angular" as const),
  standalone: true,
  columns: args.includes("--names") ? ("none" as const) : args.includes("--keys") ? ("keys" as const) : ("all" as const),
  audit: args.includes("--expand-audit") ? ("expand" as const) : ("collapse" as const),
};

/** Draw a model as SVG. Layout needs elkjs: the core does not depend on it, only this entry point loads it */
async function draw(model: Model): Promise<string> {
  const { default: ELK } = await import("elkjs");
  return (await toSvg(model, new ELK(), drawing)).svg + "\n";
}

if (command === "diff") {
  // Both versions must compile; an empty file is an empty schema, as for a file a change adds
  const models = files.slice(1, 3).map((path) => {
    const text = readFileSync(path, "utf8");
    const r = compile(text);
    for (const d of r.diagnostics) console.error(formatDiagnostic(d, text, path) + "\n");
    return r.model;
  });
  if (!models[0] || !models[1]) process.exit(1);
  const changed = diff(models[0], models[1]);
  process.stdout.write(args.includes("--markdown") ? diffMarkdown(changed.changes) : await draw(changed.model));
  process.exit(0);
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
else if (result.model) process.stdout.write(await draw(result.model));

process.exit(result.model === null ? 1 : 0);
