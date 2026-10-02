// Diagnostics (errors and warnings) and their human-readable form.
//
// The format follows compiler conventions: `file:line:col: error: message`, then the source line
// with a caret underline. Editors and terminals turn that first line into a link.

import type { Span } from "./ast.ts";

export type Severity = "error" | "warning";

export interface Diagnostic {
  severity: Severity;
  message: string;
  span: Span;
  /** One line on how to fix it, when there is one */
  hint?: string;
  /** The lint rule that found it (lint.ts); absent for the compiler's own diagnostics */
  rule?: string;
}

export const error = (message: string, span: Span, hint?: string): Diagnostic =>
  hint === undefined ? { severity: "error", message, span } : { severity: "error", message, span, hint };

export const warning = (message: string, span: Span, hint?: string): Diagnostic =>
  hint === undefined
    ? { severity: "warning", message, span }
    : { severity: "warning", message, span, hint };

export const hasErrors = (ds: readonly Diagnostic[]): boolean =>
  ds.some((d) => d.severity === "error");

/** Sort by source position, so diagnostics merged from the lexer, parser and checker read top to bottom */
export function sortDiagnostics(ds: readonly Diagnostic[]): Diagnostic[] {
  return [...ds].sort((a, b) => a.span.line - b.span.line || a.span.col - b.span.col);
}

export function formatDiagnostic(d: Diagnostic, source: string, file = "<input>"): string {
  const { line, col, len } = d.span;
  const text = source.split("\n")[line - 1] ?? "";
  const gutter = String(line).length;
  const pad = " ".repeat(gutter);
  const out = [
    `${file}:${line}:${col}: ${d.severity}: ${d.message}${d.rule ? ` [${d.rule}]` : ""}`,
    `${pad} |`,
    `${line} | ${text.replace(/\r$/, "")}`,
    `${pad} | ${" ".repeat(Math.max(0, col - 1))}${"^".repeat(Math.max(1, len))}`,
  ];
  if (d.hint) out.push(`${pad} = hint: ${d.hint}`);
  return out.join("\n");
}
