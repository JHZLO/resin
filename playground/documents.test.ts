import { describe, expect, it } from "vitest";
import { Documents, WORKSPACE_KEY } from "./documents.ts";
import { readState } from "./share.ts";
const initial = readState({ code: "table a { id int pk }" })!;
function setup() {
  const values = new Map<string, string>();
  const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
  let time = 1000;
  let id = 0;
  return { values, storage, clock: () => ++time, id: () => String(++id) };
}
describe("local documents", () => {
  it("migrates the old document and keeps it when an example opens", () => {
    const s = setup();
    s.values.set("resin.playground", JSON.stringify({ ...initial, code: "table saved { id int pk }" }));
    const docs = new Documents(s.storage, initial, s.clock, s.id);
    const first = docs.active;
    docs.create("Example", initial);
    const restored = new Documents(s.storage, initial);
    expect(restored.list()).toHaveLength(2);
    expect(restored.open(first.id)!.state.code).toContain("saved");
  });
  it("recovers a previous edit and also keeps the replaced version", () => {
    const s = setup();
    const docs = new Documents(s.storage, initial, s.clock, s.id);
    docs.update({ ...initial, code: "new text" });
    const old = docs.active.revisions[0];
    expect(docs.restore(old.at)!.state.code).toBe(initial.code);
    expect(docs.active.revisions.some(r => r.code === "new text")).toBe(true);
  });
  it("retains the last persisted version on a quota error", () => {
    const s = setup();
    const docs = new Documents(s.storage, initial, s.clock, s.id);
    docs.update(initial);
    const persisted = s.values.get(WORKSPACE_KEY);
    s.storage.setItem = () => { throw new Error("QuotaExceededError"); };
    expect(docs.update({ ...initial, code: "unsaved" })).toBe(false);
    expect(docs.active.state.code).toBe("unsaved");
    expect(docs.error).toContain("Download");
    expect(s.values.get(WORKSPACE_KEY)).toBe(persisted);
  });
  it("does not overwrite corrupt storage or another tab's changes", () => {
    const s = setup();
    s.values.set(WORKSPACE_KEY, "invalid json");
    const docs = new Documents(s.storage, initial, s.clock, s.id);
    expect(docs.update(initial)).toBe(false);
    expect(s.values.get(WORKSPACE_KEY)).toBe("invalid json");
    s.values.delete(WORKSPACE_KEY);
    const a = new Documents(s.storage, initial, s.clock, s.id);
    a.update(initial);
    const b = new Documents(s.storage, initial, s.clock, s.id);
    a.rename("Changed in another tab");
    expect(b.update({ ...initial, code: "tab b" })).toBe(false);
    expect(b.error).toContain("Another tab");
  });
  it("saves a view without replacing the document when it is loaded", () => {
    const s = setup();
    const docs = new Documents(s.storage, initial, s.clock, s.id);
    docs.saveView("Keys", { ...initial, columns: "keys" });
    docs.update({ ...initial, code: "updated" });
    expect(docs.active.views[0].state).not.toHaveProperty("code");
    expect(docs.active.state.code).toBe("updated");
  });
});
