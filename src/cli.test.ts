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

  it.each([[], [valid, "--unknown"], [valid, "--look"], [valid, "--look", "wrong"], [valid, "extra.erd"], ["diff", valid], [valid, "--model", "--ast"], [valid, "--keys", "--names"], [valid, "--infer-refs"], [valid, "--markdown"], [valid, "--from-sql", "--curved"], ["diff", valid, valid, "--lint"], [valid, "--look", "graphite", "--look", "silk-dark"]])("rejects invalid arguments: %j", (...args) => {
    const result = run(...args);
    expect(result.status).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("usage: resin");
  });

  it.each([[], ["--model"], ["--ast"], ["--lint"]])("keeps stdout empty on compile errors: %j", (...args) => {
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
});
