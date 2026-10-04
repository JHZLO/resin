import { describe, expect, it } from "vitest";
import { Analyzer } from "./analysis.ts";
const source = 'table users {\n id bigint pk\n}\ntable orders {\n id bigint pk\n user_id bigint -> users.id index\n}';
describe("source analysis", () => {
  it("keeps the drawing identity for comments while updating diagnostic positions", () => {
    const analyzer = new Analyzer();
    const code = source.replace("user_id bigint", "user_id int");
    const first = analyzer.analyze(code, null);
    const next = analyzer.analyze(`%% comment\n${code}`, null);
    expect(next.modelKey).toBe(first.modelKey);
    expect(next.model).toEqual(first.model);
    expect(next.diagnostics[0].span.line).toBe(first.diagnostics[0].span.line + 1);
  });
  it("invalidates structural edits and recovers after invalid source", () => {
    const analyzer = new Analyzer();
    const first = analyzer.analyze(source, null);
    const changed = analyzer.analyze(source.replace("user_id bigint", "user_id bigint?"), null);
    expect(changed.modelKey).not.toBe(first.modelKey);
    expect(analyzer.analyze("table", null).model).toBeNull();
    expect(analyzer.analyze(source, null).model).toEqual(first.model);
  });
  it("compares an empty base and drops the comparison when it is removed", () => {
    const analyzer = new Analyzer();
    const compared = analyzer.analyze(source, "");
    expect(compared.changes?.filter(c => c.table && !c.column)).toHaveLength(2);
    const plain = analyzer.analyze(source, null);
    expect(plain.changes).toBeNull();
    expect(plain.model?.tables.every(t => !t.change)).toBe(true);
    expect(plain.modelKey).not.toBe(compared.modelKey);
  });
});
