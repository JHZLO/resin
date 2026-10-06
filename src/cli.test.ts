import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

const dir = mkdtempSync(join(tmpdir(), "resin-cli-test-"));
const cli = fileURLToPath(new URL("./cli.ts", import.meta.url));
const valid = join(dir, "schema.erd");
const invalid = join(dir, "broken.erd");
const empty = join(dir, "empty.erd");
const sql = join(dir, "empty.sql");
const lint = join(dir, "lint.erd");
writeFileSync(valid, "table users {\n  id bigint pk\n}\n");
writeFileSync(invalid, "table broken {\n  id bigint pk\n");
writeFileSync(empty, "");
writeFileSync(sql, "SELECT 1;\n");
writeFileSync(lint, "table users {\n  name varchar\n}\n");
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const run = (...args: string[]) => spawnSync(process.execPath, [cli, ...args], { encoding: "utf8", cwd: dir, env: { ...process.env, NODE_NO_WARNINGS: "1" } });

describe("the command line", () => {
  it("prints help successfully without a file, exactly as documented", () => {
    const result = run("--help");
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    const docs = readFileSync(new URL("../docs/guide/cli.md", import.meta.url), "utf8");
    expect(result.stdout.trim()).toBe(/```text\n([\s\S]*?)\n```/.exec(docs)![1]);
  });

  it.each([[], [valid, "--unknown"], [valid, "--look"], [valid, "--look", "wrong"], [valid, "extra.erd"], ["diff", valid], [valid, "--model", "--ast"], [valid, "--keys", "--names"], [valid, "--infer-refs"], [valid, "--markdown"], [valid, "--from-sql", "--curved"], ["diff", valid, valid, "--lint"], [valid, "--look", "graphite", "--look", "silk-dark"], ["fmt"], ["fmt", valid, "--model"], ["fmt", valid, "--curved"], [valid, "--check"], ["diff", valid, valid, "--check"], [valid, "--to-sql"], [valid, "--to-sql", "db2"], [valid, "--service", "a"], [valid, "--to-sql", "mysql", "--curved"], [valid, "--to-sql", "mysql", "--model"], ["fmt", valid, "--to-sql", "mysql"]])("rejects invalid arguments: %j", (...args) => {
    const result = run(...args);
    expect(result.status).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("usage: resin");
  });

  it.each([[], ["--model"], ["--ast"], ["--lint"], ["--to-sql", "postgres"]])("keeps stdout empty on compile errors: %j", (...args) => {
    const result = run(invalid, ...args);
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("error:");
  });

  it("reports a missing file without printing a stack or output", () => {
    const result = run(join(dir, "missing.erd"), "--model");
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("ENOENT");
    expect(result.stderr).not.toContain("at ");
  });

  it("prints valid model and syntax tree JSON", () => {
    for (const flag of ["--model", "--ast"]) {
      const result = run(valid, flag);
      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout).tables).toHaveLength(1);
    }
  });

  it("supports file names that look like options after the separator", () => {
    writeFileSync(join(dir, "--model"), readFileSync(valid));
    const result = run("--model", "--", "--model");
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).tables[0].name).toBe("users");
  });

  it("reports lint findings on stderr and exits with one", () => {
    const result = run(lint, "--lint");
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("[no-pk]");
  });

  it("does not emit a conversion when SQL creates no table", () => {
    const result = run(sql, "--from-sql");
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("no CREATE TABLE");
  });

  it("compares an empty schema and rejects errors in either version", () => {
    const added = run("diff", empty, valid, "--markdown");
    expect(added.status).toBe(0);
    expect(added.stdout).toContain("table `users` added");
    for (const paths of [[invalid, valid], [valid, invalid]]) {
      const result = run("diff", ...paths, "--markdown");
      expect(result.status).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("error:");
    }
  });

  it("rewrites files in the layout, prints the ones it changed, and leaves formatted ones alone", () => {
    const messy = join(dir, "messy.erd");
    const tidy = join(dir, "tidy.erd");
    writeFileSync(messy, "table users {\nid bigint pk\n  name varchar(80)\n}");
    writeFileSync(tidy, "table users {\n  id  bigint  pk\n}\n");
    const first = run("fmt", messy, tidy);
    expect(first.status).toBe(0);
    expect(first.stderr).toBe("");
    expect(first.stdout).toBe(`${messy}\n`);
    expect(readFileSync(messy, "utf8")).toBe("table users {\n  id    bigint       pk\n  name  varchar(80)\n}\n");
    const again = run("fmt", messy);
    expect(again.status).toBe(0);
    expect(again.stdout).toBe("");
  });

  it("checks the layout without writing, and exits with one when a file is not formatted", () => {
    const messy = join(dir, "check.erd");
    const tidy = join(dir, "check-tidy.erd");
    writeFileSync(messy, "table users { id bigint pk }\n");
    writeFileSync(tidy, "table users {\n  id  bigint  pk\n}\n");
    const result = run("fmt", "--check", tidy, messy);
    expect(result.status).toBe(1);
    expect(result.stdout).toBe(`${messy}\n`);
    expect(readFileSync(messy, "utf8")).toBe("table users { id bigint pk }\n");
    expect(run("fmt", tidy, "--check").status).toBe(0);
  });

  it("leaves a file with syntax errors as it is and reports them", () => {
    const before = readFileSync(invalid, "utf8");
    const result = run("fmt", invalid);
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("error: table `broken` is missing its closing `}`");
    expect(readFileSync(invalid, "utf8")).toBe(before);
  });

  it("prints SQL DDL for a database, with notes on stderr", () => {
    const result = run(valid, "--to-sql", "postgres");
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toBe("-- Generated by resin for PostgreSQL\n\nCREATE TABLE users (\n  id  bigint  NOT NULL,\n  PRIMARY KEY (id)\n);\n");
    const indexed = join(dir, "indexed.erd");
    writeFileSync(indexed, "table users {\n  id    bigint   pk\n  name  varchar  index\n}\n");
    const sqlite = run(indexed, "--to-sql", "sqlite");
    expect(sqlite.status).toBe(0);
    expect(sqlite.stderr).toBe(`${indexed}: note: the index on users (name) has no name, which SQLite needs: named ix_users_name\n`);
    expect(sqlite.stdout).toContain("CREATE INDEX ix_users_name ON users (name);");
  });

  it("writes one service, and refuses a service the document does not have", () => {
    const services = join(dir, "services.erd");
    writeFileSync(services, "service a {\n  table t {\n    id  int  pk\n  }\n}\n\nservice b {\n  table u {\n    id  int  pk\n  }\n}\n");
    const one = run(services, "--to-sql", "mysql", "--service", "b");
    expect(one.status).toBe(0);
    expect(one.stdout).toContain("CREATE TABLE u (");
    expect(one.stdout).not.toContain("CREATE TABLE t");
    const missing = run(services, "--to-sql", "mysql", "--service", "c");
    expect(missing.status).toBe(1);
    expect(missing.stdout).toBe("");
    expect(missing.stderr).toContain("there is no service `c`");
  });
});
