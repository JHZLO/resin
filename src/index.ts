// Public entry point. Takes one source text through parse → check → (when there are no errors)
// model. The package's public API is exported from here only, so callers never depend on internal
// file paths.

import type { Document } from "./ast.ts";
import { check } from "./checker.ts";
import { type Diagnostic, hasErrors, sortDiagnostics } from "./diagnostics.ts";
import { type Model, lower } from "./model.ts";
import { parse } from "./parser.ts";

export type * from "./ast.ts";
export type * from "./model.ts";
export type { Diagnostic, Severity } from "./diagnostics.ts";
export { typeText } from "./ast.ts";
export { formatDiagnostic, hasErrors } from "./diagnostics.ts";
export { parse } from "./parser.ts";
export { check } from "./checker.ts";
export { lower, neighbors } from "./model.ts";
export { toSvg } from "./svg.ts";
export type { ElkLike, SvgLook, SvgOptions, SvgResult } from "./svg.ts";
export { fromSql, looksLikeSql } from "./sql.ts";
export { LINT_RULES, lint } from "./lint.ts";
export type { LintRule } from "./lint.ts";
export type { SqlImport, SqlImportOptions, SqlNote } from "./sql.ts";

export interface CompileResult {
  doc: Document;
  /** null when there is at least one error */
  model: Model | null;
  /** In source order */
  diagnostics: Diagnostic[];
}

export function compile(source: string): CompileResult {
  const parsed = parse(source);
  // With syntax errors the tree is incomplete; checking it would add bogus errors ("no such table")
  const diagnostics = hasErrors(parsed.diagnostics) ? parsed.diagnostics : [...parsed.diagnostics, ...check(parsed.doc)];
  const model = hasErrors(diagnostics) ? null : lower(parsed.doc);
  return { doc: parsed.doc, model, diagnostics: sortDiagnostics(diagnostics) };
}
