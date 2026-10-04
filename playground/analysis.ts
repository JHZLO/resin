import { compile, diff, lint, type Diagnostic, type Model, type ChangeEntry } from "../src/index.ts";

export interface Analysis { model: Model | null; diagnostics: Diagnostic[]; findings: Diagnostic[]; changes: ChangeEntry[] | null; modelKey: number }

/** Worker-local state keeps source positions current while recognizing comment-only edits. */
export class Analyzer {
  private source: string | null = null;
  private compiled: ReturnType<typeof compile> | null = null;
  private findings: Diagnostic[] = [];
  private baseSource: string | null = null;
  private baseModel: Model | null = null;
  private signature = "";
  private version = 0;
  analyze(code: string, base: string | null): Analysis {
    if (code !== this.source || !this.compiled) {
      this.source = code; this.compiled = compile(code);
      this.findings = this.compiled.model ? lint(this.compiled.doc) : [];
    }
    if (base !== this.baseSource) { this.baseSource = base; this.baseModel = base === null ? null : compile(base).model; }
    const compared = this.baseModel && this.compiled.model ? diff(this.baseModel, this.compiled.model) : null;
    const model = compared?.model ?? this.compiled.model;
    const signature = JSON.stringify(model);
    if (signature !== this.signature) { this.signature = signature; this.version++; }
    return { model, diagnostics: this.compiled.diagnostics, findings: this.findings, changes: compared?.changes ?? null, modelKey: this.version };
  }
}
