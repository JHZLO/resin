import { describe, expect, it } from "vitest";
import { check } from "./checker.ts";
import { parse } from "./parser.ts";

const run = (body: string) => {
  const { doc, diagnostics } = parse(body);
  expect(diagnostics).toEqual([]); // this file tests semantics only; the syntax must be valid
  return check(doc).map((d) => `${d.severity}: ${d.message}`);
};

describe("check", () => {
  it("accepts a valid document", () => {
    expect(run("table a {\n id bigint pk\n}\ntable b {\n id bigint pk\n a_id bigint -> a\n}")).toEqual([]);
  });

  it("rejects references to missing tables and columns", () => {
    expect(run("table b {\n x bigint -> nope.id\n y bigint -> b.nope\n}")).toEqual([
      "error: referenced table `nope` is not in this document",
      "error: table `b` has no column `nope`",
    ]);
  });

  it("lets external tables receive references but not hold them", () => {
    expect(run("external table users {\n id bigint pk\n}\ntable o {\n user_id bigint ~> users\n}")).toEqual([]);
    expect(run("table a {\n id bigint pk\n}\nexternal table u {\n id bigint pk\n a_id bigint -> a\n}")).toEqual([
      "error: columns of an external table cannot hold references",
    ]);
  });

  it("needs a single-column primary key when the target column is omitted", () => {
    expect(run("table a {\n x int pk\n y int pk\n}\ntable b {\n a_x int -> a\n}")).toEqual([
      "error: cannot pick a target column: the primary key of `a` is not a single column",
    ]);
  });

  it("warns when type names differ, not when only the length does", () => {
    expect(run("table a {\n id bigint pk\n}\ntable b {\n a_id int -> a\n}")).toEqual([
      "warning: type mismatch: `a_id` is int but `a.id` is bigint",
    ]);
    expect(run("table a {\n code varchar(32) pk\n}\ntable b {\n a_code varchar(64) -> a\n}")).toEqual([]);
  });

  it("rejects duplicate tables, duplicate columns and nullable primary keys", () => {
    expect(run("table a {\n id bigint? pk\n id int\n}\ntable a {\n}")).toEqual([
      "error: table `a` is declared twice",
      "error: column `id` appears twice in table `a`",
      "error: primary key `id` cannot be nullable",
    ]);
  });

  it("rejects index and unique names used twice in one table", () => {
    expect(run("table a {\n x int uk as k1\n y int index as k1\n unique(x, y) as k1\n}")).toEqual([
      "error: name `k1` is used twice in table `a`",
      "error: name `k1` is used twice in table `a`",
    ]);
  });

  it("checks audit: method, primary key, columns, external tables, generated names", () => {
    expect(run("table a {\n id int pk\n} audit history")).toEqual(["error: unknown audit method `history`"]);
    expect(run("table a {\n x int\n} audit envers(nope)\ntable revinfo {\n rev int pk\n}")).toEqual([
      "error: `revinfo` clashes with a table that `audit` generates",
      "error: `audit` needs a primary key, and table `a` has none",
      "error: table `a` has no column `nope`",
    ]);
    expect(run("external table u {\n id int pk\n} audit envers")).toEqual(["error: `audit` cannot be used on an external table"]);
  });

  it("warns about a composite constraint over a single column", () => {
    expect(run("table a {\n x int\n unique(x) as uk_x\n}")).toEqual(["warning: `unique(...)` over a single column"]);
  });
});
