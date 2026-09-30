// 공개 진입점. 원문 한 덩어리를 받아 파싱 → 검사 → (오류가 없으면) 모델 → mermaid 로 컴파일한다.
// 패키지의 공개 API 는 여기서만 내보낸다 — 쓰는 쪽이 내부 파일 경로에 기대지 않게.

import type { Document } from "./ast.ts";
import { check } from "./checker.ts";
import { type Diagnostic, hasErrors, sortDiagnostics } from "./diagnostics.ts";
import { toMermaid } from "./mermaid.ts";
import { type Model, lower } from "./model.ts";
import { parse } from "./parser.ts";

export type * from "./ast.ts";
export type * from "./model.ts";
export type { Diagnostic, Severity } from "./diagnostics.ts";
export { typeText } from "./ast.ts";
export { formatDiagnostic, hasErrors } from "./diagnostics.ts";
export { parse } from "./parser.ts";
export { check } from "./checker.ts";
export { lower } from "./model.ts";
export { toMermaid } from "./mermaid.ts";

export interface CompileResult {
  doc: Document;
  /** 오류가 하나라도 있으면 null */
  model: Model | null;
  /** 오류가 하나라도 있으면 null */
  mermaid: string | null;
  /** 원문 위치 순 */
  diagnostics: Diagnostic[];
}

export function compile(source: string): CompileResult {
  const parsed = parse(source);
  // 구문 오류가 있으면 트리가 불완전하다 — 의미 검사를 돌리면 가짜 오류("테이블이 없습니다")가 섞인다
  const diagnostics = hasErrors(parsed.diagnostics) ? parsed.diagnostics : [...parsed.diagnostics, ...check(parsed.doc)];
  const model = hasErrors(diagnostics) ? null : lower(parsed.doc);
  return {
    doc: parsed.doc,
    model,
    mermaid: model ? toMermaid(model) : null,
    diagnostics: sortDiagnostics(diagnostics),
  };
}
