// Command-line entry: `pnpm resin <file.erd> [--look <look>] [--curved] [--keys | --names] [--expand-audit] | --model | --ast | --lint`,
// `pnpm resin diff <before.erd> <after.erd> [--markdown]`, `pnpm resin fmt <file.erd>... [--check]`, or
// `pnpm resin <file.sql> --from-sql [--infer-refs]`, or `pnpm resin <file.erd> --to-sql <db> [--service <s>]`.
// Diagnostics go to stderr in compiler format; the result (the SVG, model JSON, syntax tree JSON or,
// from SQL, resin source) goes to stdout. Exits with 1 when there are errors.

import { readFileSync, writeFileSync } from "node:fs";
import { type Model, type SqlDialect, type SvgLook, SQL_DIALECTS, compile, diff, diffMarkdown, format, formatDiagnostic, fromSql, lint, toSql, toSvg } from "./index.ts";

const USAGE = `usage: resin <file.erd> [options]
       resin diff <before.erd> <after.erd> [--markdown] [drawing options]
       resin fmt <file.erd>... [--check]
       resin <file.sql> --from-sql [--infer-refs]
       resin <file.erd> --to-sql <db> [--service <s>]

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
  --to-sql <db>    print the schema as SQL DDL for mysql, postgres, sqlite,
                   sqlserver or oracle; notes go to stderr
    --service <s>  only the tables of service <s>, for its own database

  diff             draw <after.erd> with what changed since <before.erd>
                   marked: added, removed, changed. The drawing options apply
    --markdown     print the list of changes as Markdown instead

  fmt              rewrite each file in resin's one layout, and print the
                   names of the files it changed
    --check        change nothing: print the files that are not formatted,
                   and exit with 1 when there is one

  --help           print this help and exit
  --               treat the remaining arguments as file names`;

const LOOKS: readonly SvgLook[] = ["graphite", "aurora-dark", "aurora-light", "silk-dark", "silk-light", "caustic-dark", "caustic-light"];

const args = process.argv.slice(2);
const flags = new Set<string>();
const files: string[] = [];
let look = "graphite";
let dialect = "";
let service: string | undefined;
let positional = false;
const OPTIONS = new Set(["--look", "--curved", "--keys", "--names", "--expand-audit", "--model", "--ast", "--lint", "--from-sql", "--infer-refs", "--markdown", "--check", "--to-sql", "--service"]);
function usageError(message: string): never {
  console.error(`resin: ${message}\n\n${USAGE}`);
  process.exit(2);
}
for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (positional) files.push(arg);
  else if (arg === "--") positional = true;
  else if (arg === "--help") {
    console.log(USAGE);
    process.exit(0);
  } else if (arg.startsWith("-")) {
    if (!OPTIONS.has(arg)) usageError(`unknown option ${arg}`);
    if (flags.has(arg)) usageError(`option ${arg} was given more than once`);
    flags.add(arg);
    if (arg === "--look") {
      if (!args[i + 1] || args[i + 1].startsWith("-")) usageError("--look needs a look name");
      look = args[++i];
    } else if (arg === "--to-sql") {
      if (!args[i + 1] || args[i + 1].startsWith("-")) usageError("--to-sql needs a database");
      dialect = args[++i];
    } else if (arg === "--service") {
      if (!args[i + 1] || args[i + 1].startsWith("-")) usageError("--service needs a service name");
      service = args[++i];
    }
  } else files.push(arg);
}
const command = files[0] === "diff" || files[0] === "fmt" ? files[0] : null;
const file = command ? files[1] : files[0];
if (command === "fmt") {
  if (!file) usageError("fmt needs at least one file");
  if ([...flags].some((flag) => flag !== "--check")) usageError("fmt accepts --check only");
} else if (!file || files.length !== (command ? 3 : 1)) usageError(command ? "diff needs exactly two files" : "expected exactly one file");
if (command !== "fmt" && flags.has("--check")) usageError("--check needs the fmt command");
if (!LOOKS.includes(look as SvgLook)) usageError(`--look takes ${LOOKS.join(", ")}`);
const modes = ["--model", "--ast", "--lint", "--from-sql", "--to-sql"].filter((flag) => flags.has(flag));
if (modes.length > 1) usageError("choose only one output mode: --model, --ast, --lint, --from-sql or --to-sql");
if (flags.has("--to-sql") && !SQL_DIALECTS.includes(dialect as SqlDialect)) usageError(`--to-sql takes ${SQL_DIALECTS.join(", ")}`);
if (flags.has("--service") && !flags.has("--to-sql")) usageError("--service needs --to-sql");
if (command && modes.length) usageError("diff accepts --markdown and drawing options only");
if (!command && flags.has("--markdown")) usageError("--markdown needs the diff command");
if (flags.has("--infer-refs") && !flags.has("--from-sql")) usageError("--infer-refs needs --from-sql");
if (flags.has("--keys") && flags.has("--names")) usageError("choose either --keys or --names");
const drawingFlags = ["--look", "--curved", "--keys", "--names", "--expand-audit"];
if ((modes.length || flags.has("--markdown")) && drawingFlags.some((flag) => flags.has(flag))) usageError("drawing options need SVG output");

const drawing = {
  look: look as SvgLook,
  edges: flags.has("--curved") ? ("curved" as const) : ("angular" as const),
  standalone: true,
  columns: flags.has("--names") ? ("none" as const) : flags.has("--keys") ? ("keys" as const) : ("all" as const),
  audit: flags.has("--expand-audit") ? ("expand" as const) : ("collapse" as const),
};

/** Draw a model as SVG. Layout needs elkjs: the core does not depend on it, only this entry point loads it */
async function draw(model: Model): Promise<string> {
  const { default: ELK } = await import("elkjs");
  return (await toSvg(model, new ELK(), drawing)).svg + "\n";
}

try {
  if (command === "fmt") {
    // A file with syntax errors is left as it is: there is no telling where its statements end
    let failed = false;
    for (const path of files.slice(1)) {
      const text = readFileSync(path, "utf8");
      const result = format(text);
      if (result.text === null) {
        for (const d of result.diagnostics) console.error(formatDiagnostic(d, text, path) + "\n");
        failed = true;
      } else if (result.text !== text) {
        if (flags.has("--check")) failed = true;
        else writeFileSync(path, result.text);
        console.log(path);
      }
    }
    process.exit(failed ? 1 : 0);
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
    process.stdout.write(flags.has("--markdown") ? diffMarkdown(changed.changes) : await draw(changed.model));
    process.exit(0);
  }

  const source = readFileSync(file, "utf8");

  if (flags.has("--from-sql")) {
    const converted = fromSql(source, { inferReferences: flags.has("--infer-refs") });
    for (const n of converted.notes) console.error(`${file}:${n.line}:${n.col}: note: ${n.message}`);
    if (converted.tables === 0) {
      console.error(`resin: ${file} has no CREATE TABLE to convert`);
      process.exit(1);
    }
    process.stdout.write(converted.source);
    process.exit(0);
  }

  const result = compile(source);

  if (flags.has("--to-sql")) {
    for (const d of result.diagnostics) console.error(formatDiagnostic(d, source, file) + "\n");
    if (!result.model) process.exit(1);
    const ddl = toSql(result.model, { dialect: dialect as SqlDialect, service });
    for (const n of ddl.notes) console.error(`${file}: note: ${n}`);
    process.stdout.write(ddl.sql);
    process.exit(0);
  }

  if (flags.has("--lint")) {
    // Lint needs a document that compiled; with errors there is nothing to lint yet
    const findings = result.model ? lint(result.doc) : [];
    const all = [...result.diagnostics, ...findings].sort((a, b) => a.span.line - b.span.line || a.span.col - b.span.col);
    for (const d of all) console.error(formatDiagnostic(d, source, file) + "\n");
    process.exit(result.model === null || findings.length > 0 ? 1 : 0);
  }

  for (const d of result.diagnostics) console.error(formatDiagnostic(d, source, file) + "\n");

  if (!result.model) process.exit(1);
  if (flags.has("--ast")) console.log(JSON.stringify(result.doc, null, 2));
  else if (flags.has("--model")) console.log(JSON.stringify(result.model, null, 2));
  else process.stdout.write(await draw(result.model));

} catch (error) {
  console.error(`resin: ${(error as Error).message}`);
  process.exit(1);
}
