// 진단(오류, 경고) 모델과 사람이 읽는 출력 형식.
//
// 형식은 컴파일러 관례를 따른다: `file:line:col: error: message` 다음 줄에 원문 한 줄과 밑줄.
// 에디터와 터미널이 이 형식을 링크로 인식하고, 에이전트도 위치를 그대로 따라간다.

import type { Span } from "./ast.ts";

export type Severity = "error" | "warning";

export interface Diagnostic {
  severity: Severity;
  message: string;
  span: Span;
  /** 고치는 방법 한 줄. 없으면 생략 */
  hint?: string;
}

export const error = (message: string, span: Span, hint?: string): Diagnostic =>
  hint === undefined ? { severity: "error", message, span } : { severity: "error", message, span, hint };

export const warning = (message: string, span: Span, hint?: string): Diagnostic =>
  hint === undefined
    ? { severity: "warning", message, span }
    : { severity: "warning", message, span, hint };

export const hasErrors = (ds: readonly Diagnostic[]): boolean =>
  ds.some((d) => d.severity === "error");

/** 원문 위치 순으로 정렬 — 여러 단계(렉서, 파서, 검사기)의 진단을 합쳐도 읽는 순서가 원문 순서가 되게 */
export function sortDiagnostics(ds: readonly Diagnostic[]): Diagnostic[] {
  return [...ds].sort((a, b) => a.span.line - b.span.line || a.span.col - b.span.col);
}

export function formatDiagnostic(d: Diagnostic, source: string, file = "<input>"): string {
  const { line, col, len } = d.span;
  const text = source.split("\n")[line - 1] ?? "";
  const gutter = String(line).length;
  const pad = " ".repeat(gutter);
  const out = [
    `${file}:${line}:${col}: ${d.severity}: ${d.message}`,
    `${pad} |`,
    `${line} | ${text.replace(/\r$/, "")}`,
    `${pad} | ${" ".repeat(Math.max(0, col - 1))}${"^".repeat(Math.max(1, len))}`,
  ];
  if (d.hint) out.push(`${pad} = hint: ${d.hint}`);
  return out.join("\n");
}
