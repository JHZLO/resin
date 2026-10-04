import { describe, expect, it } from "vitest";
import { compile, check, lower, lint } from "./index.ts";
describe("analysis indexes", () => {
  it("rebuilds an index after callers mutate a parsed document", () => {
    const result = compile('table parent { id int pk }\ntable child { id int pk\n parent_id int -> parent.id index }');
    const child = result.doc.tables[1].columns[1];
    expect(lower(result.doc).relations).toHaveLength(1);
    child.ref = null;
    expect(check(result.doc)).toEqual([]);
    expect(lower(result.doc).relations).toHaveLength(0);
    expect(lint(result.doc).filter(d => d.rule === "unrelated")).toHaveLength(2);
  });
  it("keeps local, qualified, ambiguous, and literal dotted identities separate", () => {
    const result = compile('table `a.users` { id int pk }\nservice a {\n table users { id int pk }\n table orders { id int pk\n user_id int -> users.id index }\n}\nservice b {\n table users { id int pk }\n table orders { id int pk\n user_id int -> a.users.id index\n literal_id int -> `a.users`.id index }\n}');
    expect(result.model?.relations.map(r => r.parent)).toEqual(['a.users','a.users','`a.users`']);
    const ambiguous = compile('service a {\n table users { id int pk }\n}\nservice b {\n table users { id int pk }\n}\ntable orders { id int pk\n user_id int -> users.id }');
    expect(ambiguous.diagnostics.some(d => d.message.includes("ambiguous"))).toBe(true);
  });
});
