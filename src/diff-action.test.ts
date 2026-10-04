import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { MARKER, type Api, type Git, type GitFactory, changedFiles, commentBody, compareFiles, drawingUrl, gitAt, publishDrawings, updateComment } from "../scripts/diff-action.ts";
import { decode } from "../playground/share.ts";

const dirs: string[] = [];
const temporary = () => {
  const dir = mkdtempSync(join(tmpdir(), "resin-action-test-"));
  dirs.push(dir);
  return dir;
};
afterAll(() => dirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })));
const SCHEMA = "table users {\n  id bigint pk\n}\n";
const commit = (git: Git, message: string) => {
  git("add", "-A");
  git("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", message);
  return git("rev-parse", "HEAD").trim();
};
const repo = () => {
  const dir = temporary();
  const git = gitAt(dir);
  git("init", "-q");
  return { dir, git };
};
const remote = () => {
  const dir = temporary();
  gitAt(dir)("init", "--bare", "-q");
  return dir;
};

describe("pull request file comparison", () => {
  it("runs the real action offline with a multiline path selection", () => {
    const { dir, git } = repo();
    writeFileSync(join(dir, "schema with spaces.erd"), SCHEMA);
    const base = commit(git, "before");
    writeFileSync(join(dir, "schema with spaces.erd"), SCHEMA.replace("id bigint pk", "id bigint pk\n  name text"));
    const head = commit(git, "after");
    const output = temporary();
    const event = join(output, "event.json");
    writeFileSync(event, JSON.stringify({ pull_request: { number: 4, base: { sha: base }, head: { sha: head } } }));
    const result = spawnSync(process.execPath, [fileURLToPath(new URL("../scripts/diff-action.ts", import.meta.url))], {
      cwd: dir,
      encoding: "utf8",
      env: { ...process.env, NODE_NO_WARNINGS: "1", GITHUB_EVENT_PATH: event, GITHUB_REPOSITORY: "owner/repo", RESIN_DRY_RUN: output, INPUT_FILES: "schema with spaces.erd\n", RESIN_ELK_MODULE: fileURLToPath(new URL("../node_modules/elkjs/lib/elk.bundled.js", import.meta.url)) },
    });
    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(join(output, "comment.md"), "utf8")).toContain("column `name` added");
    expect(readFileSync(join(output, `pr-4/${head}/schema with spaces.erd.svg`), "utf8")).toContain("<svg");
  });

  it("preserves unusual paths and tracks additions, deletions and renames", async () => {
    const { dir, git } = repo();
    const unusual = "주문 #[]()\nrows.erd";
    writeFileSync(join(dir, "old.erd"), SCHEMA);
    writeFileSync(join(dir, "deleted.erd"), "table deleted {\n  key int pk\n  label text\n  value decimal\n  enabled boolean\n  created_at datetime\n}\n");
    const base = commit(git, "before");
    renameSync(join(dir, "old.erd"), join(dir, unusual));
    rmSync(join(dir, "deleted.erd"));
    writeFileSync(join(dir, "added.erd"), SCHEMA.replace("users", "added"));
    const head = commit(git, "after");
    const files = changedFiles(git, base, head, ["*.erd"]);
    expect(files).toEqual(expect.arrayContaining([
      { before: "old.erd", after: unusual },
      { before: "deleted.erd", after: null },
      { before: null, after: "added.erd" },
    ]));
    const results = await compareFiles(git, base, head, files, "https://example.invalid/playground/", "graphite");
    const renamed = results.find((r) => r.file === unusual)!;
    expect(renamed.markdown).toBe("No changes to the schema.\n");
    expect(renamed.previous).toBe("old.erd");
    expect(renamed.svg).toBeNull();
    expect(results.find((r) => r.file === "deleted.erd")!.markdown).toContain("removed");
    const added = results.find((r) => r.file === "added.erd")!;
    expect(added.markdown).toContain("added");
    expect((await decode(new URL(added.link).hash))?.base).toBe("");
  });

  it("does not reinterpret a failed read as an empty schema", async () => {
    const git: Git = () => { throw new Error("unreadable revision"); };
    await expect(compareFiles(git, "before", "after", [{ before: "file.erd", after: "file.erd" }], "https://example.invalid/", "graphite")).rejects.toThrow("unreadable revision");
  });

  it("reports invalid schemas without drawing a misleading diff", async () => {
    const git: Git = (_show, path) => path.startsWith("before:") ? SCHEMA : "table broken {";
    const [result] = await compareFiles(git, "before", "after", [{ before: "file.erd", after: "file.erd" }], "https://example.invalid/", "graphite");
    expect(result.markdown).toContain("head version has errors");
    expect(result.svg).toBeNull();
  });

  it("escapes file labels and URL path segments", () => {
    const file = "schema #[]()`<x>\n.erd";
    const url = drawingUrl("owner/repo", "drawings/qa", `pr-1/commit/${file}.svg`);
    expect(url).toContain("schema%20%23%5B%5D%28%29%60%3Cx%3E%0A.erd.svg");
    const body = commentBody([{ file, previous: null, markdown: "No changes.\n", svg: "svg", link: "https://example.invalid/#erd:data" }], new Map([[file, url]]));
    expect(body).not.toContain("<x>");
    expect(body).toContain("&#60;x&#62;&#10;");
    expect(body).toContain(`(<${url}>)`);
  });
});

describe("publishing drawings", () => {
  it("keeps the same commit and drawings on an identical rerun", () => {
    const origin = remote();
    const git = gitAt(origin);
    const drawings = [{ path: "pr-1/head/file.svg", svg: "<svg/>" }];
    publishDrawings(origin, "resin-diff", drawings, "first");
    const first = git("rev-parse", "refs/heads/resin-diff");
    publishDrawings(origin, "resin-diff", drawings, "rerun");
    expect(git("rev-parse", "refs/heads/resin-diff")).toBe(first);
    expect(git("show", "resin-diff:pr-1/head/file.svg")).toBe("<svg/>");
  });

  it("retries a concurrent push without losing either pull request's drawing", () => {
    const origin = remote();
    publishDrawings(origin, "resin-diff", [{ path: "existing.svg", svg: "existing" }], "seed");
    let raced = false;
    const racingGit: GitFactory = (cwd, token) => {
      const git = gitAt(cwd, token);
      return (...args) => {
        if (args[0] === "push" && !raced) {
          raced = true;
          publishDrawings(origin, "resin-diff", [{ path: "pr-2/head/b.svg", svg: "second" }], "other PR");
        }
        return git(...args);
      };
    };
    publishDrawings(origin, "resin-diff", [{ path: "pr-1/head/a.svg", svg: "first" }], "our PR", undefined, racingGit);
    const git = gitAt(origin);
    expect(raced).toBe(true);
    expect(git("show", "resin-diff:pr-1/head/a.svg")).toBe("first");
    expect(git("show", "resin-diff:pr-2/head/b.svg")).toBe("second");
    expect(git("show", "resin-diff:existing.svg")).toBe("existing");
  });

  it("does not retry a denied push when the remote has not changed", () => {
    const origin = remote();
    let pushes = 0;
    const deniedGit: GitFactory = (cwd, token) => {
      const git = gitAt(cwd, token);
      return (...args) => {
        if (args[0] === "push") { pushes++; throw new Error("denied"); }
        return git(...args);
      };
    };
    expect(() => publishDrawings(origin, "resin-diff", [{ path: "file.svg", svg: "svg" }], "test", undefined, deniedGit)).toThrow("denied");
    expect(pushes).toBe(1);
  });
});

const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
const bot = { login: "github-actions[bot]" };

describe("maintaining the comparison comment", () => {
  it("paginates and ignores another author's marker", async () => {
    const calls: { path: string; method?: string }[] = [];
    const api: Api = async (path, init) => {
      calls.push({ path, method: init?.method });
      if (path === "/user") return response({}, 403);
      if (init?.method === "PATCH") return response({});
      if (path.endsWith("page=1")) return response(Array.from({ length: 100 }, (_, id) => ({ id, body: MARKER, user: { login: "someone-else" } })));
      return response([{ id: 101, body: MARKER, user: bot }]);
    };
    expect(await updateComment(api, "owner/repo", 1, MARKER + "\nnew", true)).toBe("updated");
    expect(calls.at(-1)).toEqual({ path: "/repos/owner/repo/issues/comments/101", method: "PATCH" });
    expect(calls.some((c) => c.path.endsWith("page=2"))).toBe(true);
  });

  it("recognizes the user of a personal access token", async () => {
    let updated = false;
    const api: Api = async (path, init) => {
      if (path === "/user") return response({ login: "owner" });
      if (init?.method === "PATCH") { updated = true; return response({}); }
      return response([{ id: 1, body: MARKER, user: { login: "owner" } }]);
    };
    await updateComment(api, "owner/repo", 1, "new", true);
    expect(updated).toBe(true);
  });

  it("updates a previous comment after all schema changes are reverted", async () => {
    let sent = "";
    const body = commentBody([], new Map());
    const api: Api = async (path, init) => {
      if (path === "/user") return response({}, 403);
      if (init?.method === "PATCH") { sent = String(init.body); return response({}); }
      return response([{ id: 7, body: MARKER + "old", user: bot }]);
    };
    expect(await updateComment(api, "owner/repo", 1, body, false)).toBe("updated");
    expect(JSON.parse(sent).body).toContain("No changes to the selected schema files");
  });

  it("does not create an empty comment or rewrite an identical comment", async () => {
    for (const existing of [[], [{ id: 1, body: MARKER, user: bot }]]) {
      const api: Api = async (path, init) => {
        expect(init?.method).toBeUndefined();
        return path === "/user" ? response({}, 403) : response(existing);
      };
      expect(await updateComment(api, "owner/repo", 1, MARKER, false)).toBe("skipped");
    }
  });

  it("does not create a duplicate when reading comments fails", async () => {
    const api: Api = async (path, init) => {
      expect(init?.method).toBeUndefined();
      return response({}, path === "/user" ? 403 : 500);
    };
    await expect(updateComment(api, "owner/repo", 1, MARKER, true)).rejects.toThrow("cannot read PR comments (500)");
  });

  it("explains a fork token's missing comment permission", async () => {
    const api: Api = async (path, init) => path === "/user" || init?.method === "POST" ? response({}, 403) : response([]);
    await expect(updateComment(api, "owner/repo", 1, MARKER, true)).rejects.toThrow("Fork workflows may not receive write permissions");
  });
});
