import { describe, expect, it } from "vitest";
import { compile, formatDiagnostic } from "./index.ts";
import { lint } from "./lint.ts";

/** Lint a document that must compile without errors; return [rule, line:col, message] */
const findings = (src: string) => {
  const r = compile(src);
  expect(r.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
  return lint(r.doc).map((d) => [d.rule, `${d.span.line}:${d.span.col}`, d.message]);
};

describe("ref-index", () => {
  it("reports a reference column that no index starts with, at its name", () => {
    expect(
      findings(`
table a {
  id  bigint  pk
}
table b {
  id    bigint  pk
  a_id  bigint  -> a
  x_id  bigint  ~> a
}`),
    ).toEqual([
      ["ref-index", "7:3", "reference column `a_id` has no index"],
      ["ref-index", "8:3", "reference column `x_id` has no index"],
    ]);
  });

  it("accepts index, uk, the first primary key column and composite indexes that start with the column", () => {
    expect(
      findings(`
table a {
  id  bigint  pk
}
table b {
  a1  bigint  pk -> a
  a2  bigint  pk -> a
  a3  bigint  index -> a
  a4  bigint  uk -> a
  a5  bigint  -> a
  a6  bigint  -> a
  index(a5, a1)
  unique(a6, a1)
}`),
    ).toEqual([["ref-index", "7:3", "reference column `a2` has no index"]]);
  });

  it("leaves external tables alone and gives a hint", () => {
    const r = compile("external table u {\n  id bigint pk\n}\ntable t {\n  id bigint pk\n  u_id bigint ~> u\n}");
    const [d] = lint(r.doc);
    expect(d.hint).toBe("add `index` to the column, or start a composite index with it");
  });
});

describe("no-pk", () => {
  it("reports a table without a primary key, but not an external one", () => {
    expect(findings("external table u {\n  id bigint\n}\ntable log {\n  at datetime\n  u_id bigint ~> u.id index\n}")).toEqual([
      ["no-pk", "4:7", "table `log` has no primary key"],
    ]);
  });
});

describe("unrelated", () => {
  it("reports tables that no reference joins to another table, external ones included", () => {
    expect(
      findings(`
external table users {
  id  bigint  pk
}
table categories {
  id         bigint   pk
  parent_id  bigint?  -> categories  index
}
table settings {
  key  varchar  pk
}`),
    ).toEqual([
      ["unrelated", "2:16", "external table `users` is not referenced"],
      ["unrelated", "5:7", "table `categories` has no references to or from other tables"],
      ["unrelated", "9:7", "table `settings` has no references to or from other tables"],
    ]);
  });

  it("says nothing about a document of one table", () => {
    expect(findings("table t {\n  id bigint pk\n}")).toEqual([]);
  });
});

describe("type-drift", () => {
  it("reports columns of one name whose type differs from the one most tables use", () => {
    expect(
      findings(`
table a {
  id       bigint  pk
  user_id  bigint  index
}
table b {
  id       bigint  pk
  user_id  bigint  index
  a_id     bigint  -> a  index
}
table c {
  id       int     pk
  user_id  int     index
  a_id     bigint  -> a  index
}`),
    ).toEqual([
      ["type-drift", "12:12", "column `id` is int here but bigint in `a`, `b`"],
      ["type-drift", "13:12", "column `user_id` is int here but bigint in `a`, `b`"],
    ]);
  });

  it("compares type names, not lengths, and leaves out columns the checker already warns about", () => {
    const src = `
table a {
  id    bigint       pk
  code  varchar(10)  uk
}
table b {
  id    bigint       pk
  code  varchar(20)  uk
  a_id  int          -> a  index
}
table c {
  id    bigint       pk
  a_id  bigint       -> a  index
}`;
    expect(findings(src)).toEqual([]);
  });

  it("lists at most three tables", () => {
    const tables = ["a", "b", "c", "d", "e"].map((t) => `table ${t} {\n  id bigint pk\n}`).join("\n");
    expect(findings(`${tables}\ntable f {\n  id int pk\n}`).filter((f) => f[0] === "type-drift")).toEqual([
      ["type-drift", "17:6", "column `id` is int here but bigint in `a`, `b`, `c` and 2 more"],
    ]);
  });
});

describe("dup-index", () => {
  it("reports an index that a wider one, or a unique one, already covers", () => {
    expect(
      findings(`
table t {
  id      bigint   pk index
  a       int      index as ix_a
  b       int      uk index
  c       int
  d       int
  index(a, c) as ix_ac
  index(c, d)
  index(c, d) as ix_cd2
}`),
    ).toEqual([
      ["dup-index", "3:23", "the index on (`id`) is covered by the primary key (`id`)"],
      ["dup-index", "4:20", "index `ix_a` on (`a`) is covered by `ix_ac` (`a`, `c`)"],
      ["dup-index", "5:23", "the index on (`b`) is covered by a unique constraint (`b`)"],
      ["dup-index", "10:3", "index `ix_cd2` on (`c`, `d`) is covered by another index (`c`, `d`)"],
    ]);
  });

  it("reports a unique constraint that repeats the primary key", () => {
    expect(findings("table t {\n  a int pk\n  b int pk\n  unique(b, a)\n}")).toEqual([
      ["dup-index", "4:3", "unique on (`b`, `a`) repeats the primary key"],
    ]);
  });

  it("does not count the start of the primary key as covering a wider index", () => {
    expect(findings("table t {\n  a int pk\n  b int pk\n  c int\n  index(a, c)\n}")).toEqual([]);
  });
});

describe("format", () => {
  it("puts the rule after the message", () => {
    const src = "table a {\n  id bigint pk\n}\ntable b {\n  id bigint pk\n  a_id bigint -> a\n}";
    const [d] = lint(compile(src).doc);
    expect(formatDiagnostic(d, src, "s.erd").split("\n")[0]).toBe("s.erd:6:3: warning: reference column `a_id` has no index [ref-index]");
  });
});
