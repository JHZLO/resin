// Compare a pull request's resin files, publish drawings, and maintain its comparison comment.
// RESIN_DRY_RUN=<dir> writes the same output locally without fetching or contacting GitHub.

import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { encode } from "../playground/share.ts";
import { type SvgLook, compile, diff, diffMarkdown, toSvg } from "../src/index.ts";

export const MARKER = "<!-- resin-diff -->";
const LOOKS: readonly string[] = ["graphite", "aurora-dark", "aurora-light", "silk-dark", "silk-light", "caustic-dark", "caustic-light"];
export type Git = (...args: string[]) => string;
export type GitFactory = (cwd: string, token?: string) => Git;
export type Api = (path: string, init?: RequestInit) => Promise<Response>;

/** Use the PR's common ancestor so newer base-branch changes do not appear as removals. */
export async function comparisonBase(git: Git, base: string, head: string, remote?: { api: Api; repo: string }): Promise<string> {
  const sha = /^[a-f0-9]{40}$/i;
  if (!sha.test(base) || !sha.test(head)) throw new Error("the pull request has invalid commit IDs");
  let ancestor: unknown;
  if (remote) {
    // GitHub has the full graph even when checkout only fetched the PR's latest commit.
    const response = await remote.api(`/repos/${remote.repo}/compare/${base}...${head}`);
    if (!response.ok) throw new Error(`cannot resolve the PR merge base (${response.status})`);
    ancestor = (await response.json() as { merge_base_commit?: { sha?: string } }).merge_base_commit?.sha;
  } else ancestor = git("merge-base", base, head).trim();
  if (typeof ancestor !== "string" || !sha.test(ancestor)) throw new Error("the PR merge base is missing or invalid");
  return ancestor;
}

export const gitAt: GitFactory = (cwd, token) => (...args) => {
  // Keep credentials out of remote URLs, git config files and command errors.
  const auth = token ? {
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader",
    GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`,
  } : {};
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, ...auth, GIT_TERMINAL_PROMPT: "0" } });
};

export interface ChangedFile {
  before: string | null;
  after: string | null;
}

/** NUL delimiters preserve every Git path, including spaces, Unicode and newlines. */
export function changedFiles(git: Git, base: string, head: string, pathspecs: string[]): ChangedFile[] {
  const fields = git("diff", "--name-status", "-z", "--find-renames", base, head, "--", ...pathspecs).split("\0");
  const files: ChangedFile[] = [];
  for (let i = 0; i < fields.length - 1;) {
    const status = fields[i++];
    const path = fields[i++];
    if (status.startsWith("R") || status.startsWith("C")) {
      const after = fields[i++];
      files.push({ before: status.startsWith("R") ? path : null, after });
    } else files.push({ before: status === "A" ? null : path, after: status === "D" ? null : path });
  }
  return files;
}

export interface Result {
  file: string;
  previous: string | null;
  markdown: string;
  svg: string | null;
  link: string;
}

export async function compareFiles(git: Git, base: string, head: string, files: ChangedFile[], playground: string, look: SvgLook): Promise<Result[]> {
  // The composite action installs its renderer in runner.temp, without replacing the caller's dependencies.
  const module = process.env.RESIN_ELK_MODULE ? pathToFileURL(process.env.RESIN_ELK_MODULE).href : "elkjs";
  const { default: ELK } = await import(module);
  const elk = new ELK();
  const results: Result[] = [];
  for (const paths of files) {
    // Only an added or deleted path is an empty schema. A failed read must not look like a deletion.
    const before = paths.before === null ? "" : git("show", `${base}:${paths.before}`);
    const after = paths.after === null ? "" : git("show", `${head}:${paths.after}`);
    const file = paths.after ?? paths.before!;
    const a = compile(before);
    const b = compile(after);
    const url = new URL(playground);
    url.hash = await encode({ code: after, base: before, columns: "all", audit: "collapse", edges: "angular", related: null });
    const shared = { file, previous: paths.before !== file ? paths.before : null, link: url.href };
    if (!a.model || !b.model) {
      const which = !b.model ? "the head version" : "the base version";
      results.push({ ...shared, markdown: `Not compared: ${which} has errors. Run resin on this file to see them.\n`, svg: null });
      continue;
    }
    const changed = diff(a.model, b.model);
    const svg = changed.changes.length ? (await toSvg(changed.model, elk, { look, standalone: true })).svg + "\n" : null;
    results.push({ ...shared, markdown: diffMarkdown(changed.changes), svg });
  }
  return results;
}

export interface Drawing {
  path: string;
  svg: string;
}

/** Replay our files on the newest branch after a concurrent writer wins a push. */
export function publishDrawings(remote: string, branch: string, drawings: Drawing[], message: string, token?: string, makeGit: GitFactory = gitAt): void {
  if (!drawings.length) return;
  const work = mkdtempSync(join(tmpdir(), "resin-diff-"));
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      const dir = join(work, String(attempt));
      mkdirSync(dir);
      const git = makeGit(dir, token);
      git("init", "-q");
      git("remote", "add", "origin", remote);
      const ref = `refs/heads/${branch}`;
      const remoteHead = () => git("ls-remote", "--heads", "origin", ref).split(/\s/)[0];
      const start = remoteHead();
      if (start) {
        git("fetch", "-q", "--depth=1", "origin", ref);
        git("checkout", "-q", "-b", "drawings", "FETCH_HEAD");
      } else git("checkout", "-q", "--orphan", "drawings");
      for (const drawing of drawings) {
        const path = join(dir, drawing.path);
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, drawing.svg);
      }
      git("add", "-A");
      // An identical rerun already has usable drawings; do not attempt an empty commit.
      if (!git("diff", "--cached", "--name-only", "-z")) return;
      git("-c", "user.name=github-actions[bot]", "-c", "user.email=41898282+github-actions[bot]@users.noreply.github.com", "commit", "-q", "-m", message);
      try {
        git("push", "-q", "origin", `HEAD:${ref}`);
        return;
      } catch (error) {
        if (attempt === 2 || remoteHead() === start) throw error;
      }
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

const escapeHtml = (value: string): string => value.replace(/[&<>"'\r\n]/g, (c) => `&#${c.charCodeAt(0)};`);
const urlPath = (value: string): string => value.split("/").map((part) => encodeURIComponent(part).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)).join("/");

export function drawingUrl(repo: string, branch: string, path: string): string {
  return `https://github.com/${urlPath(repo)}/raw/refs/heads/${urlPath(branch)}/${urlPath(path)}`;
}

export function commentBody(results: Result[], urls: Map<string, string>): string {
  const sections = results.map((r) => {
    const parts = [`### <code>${escapeHtml(r.file)}</code>`, ""];
    if (r.previous) parts.push(`Renamed from <code>${escapeHtml(r.previous)}</code>.`, "");
    parts.push(r.markdown.trim());
    const url = urls.get(r.file);
    if (url) parts.push("", `![Schema changes](<${url}>)`);
    parts.push("", `[Open both versions in the playground](<${r.link}>)`);
    return parts.join("\n");
  });
  if (!sections.length) sections.push("No changes to the selected schema files.");
  return [MARKER, "## Schema changes", "", ...sections.flatMap((s) => [s, ""]), "<sub>Drawn by resin from the base and head versions of each file.</sub>", ""].join("\n");
}

interface Comment {
  id: number;
  body?: string;
  user?: { login?: string };
}

/** List every page and only edit a comment written by this token's user or the Actions bot. */
export async function updateComment(api: Api, repo: string, number: number, body: string, hasFiles: boolean): Promise<"created" | "updated" | "skipped"> {
  const identity = await api("/user");
  // The workflow's installation token cannot call /user; its comments belong to this bot.
  let author = "github-actions[bot]";
  if (identity.ok) {
    const user = await identity.json() as { login?: string };
    if (!user.login) throw new Error("the token did not identify a comment author");
    author = user.login;
  } else if (identity.status !== 403 && identity.status !== 404) throw new Error(`cannot identify the comment author (${identity.status})`);
  const root = `/repos/${repo}`;
  let mine: Comment | undefined;
  for (let page = 1; ; page++) {
    const response = await api(`${root}/issues/${number}/comments?per_page=100&page=${page}`);
    if (!response.ok) throw new Error(`cannot read PR comments (${response.status}); check pull-requests: read`);
    const comments = await response.json() as Comment[];
    if (!Array.isArray(comments)) throw new Error("the comments response is not a list");
    mine = comments.find((c) => c.user?.login?.toLowerCase() === author.toLowerCase() && c.body?.startsWith(MARKER));
    if (mine || comments.length < 100) break;
  }
  if (!mine && !hasFiles) return "skipped";
  if (mine?.body === body) return "skipped";
  const path = mine ? `${root}/issues/comments/${mine.id}` : `${root}/issues/${number}/comments`;
  const sent = await api(path, { method: mine ? "PATCH" : "POST", body: JSON.stringify({ body }) });
  if (!sent.ok) {
    const hint = sent.status === 401 || sent.status === 403
      ? "grant pull-requests: write. Fork workflows may not receive write permissions"
      : "check the comment size and GitHub API availability";
    throw new Error(`cannot write the PR comment (${sent.status}); ${hint}`);
  }
  return mine ? "updated" : "created";
}

async function main(): Promise<void> {
  const env = process.env;
  const input = (name: string, fallback: string): string => env[`INPUT_${name.toUpperCase()}`] || fallback;
  const event = JSON.parse(readFileSync(env.GITHUB_EVENT_PATH ?? "", "utf8"));
  const pr = event.pull_request;
  if (!pr) {
    console.log("resin diff: not a pull request event, nothing to compare");
    return;
  }
  const repo = env.GITHUB_REPOSITORY ?? "";
  const token = input("token", "");
  const branch = input("branch", "resin-diff");
  const playground = input("playground", "https://jhzlo.github.io/resin/playground/");
  const look = input("look", "graphite");
  if (!LOOKS.includes(look)) throw new Error(`unknown look ${look}`);
  if (!["https:", "http:"].includes(new URL(playground).protocol)) throw new Error("playground must be an HTTP or HTTPS URL");
  const selection = input("files", "*.erd");
  const pathspecs = (selection.includes("\n") ? selection.split(/\r?\n/).map((s) => s.trim()) : selection.split(/\s+/)).filter(Boolean);
  const dryRun = env.RESIN_DRY_RUN;
  const git = gitAt(process.cwd());
  git("check-ref-format", "--branch", branch);
  const head: string = pr.head.sha;
  const api: Api = (path, init = {}) => fetch(`https://api.github.com${path}`, {
    ...init,
    headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "content-type": "application/json" },
  });
  const base = await comparisonBase(git, pr.base.sha, head, dryRun ? undefined : { api, repo });
  if (!dryRun) for (const commit of [base, head]) git("fetch", "--no-tags", "--depth=1", "origin", commit);
  const files = changedFiles(git, base, head, pathspecs);
  const results = await compareFiles(git, base, head, files, playground, look as SvgLook);
  const dir = `pr-${pr.number}/${head}`;
  const drawings = results.filter((r) => r.svg).map((r) => ({ path: `${dir}/${r.file}.svg`, svg: r.svg! }));
  let urls = new Map(results.filter((r) => r.svg).map((r) => [r.file, drawingUrl(repo, branch, `${dir}/${r.file}.svg`)]));
  if (dryRun) {
    for (const drawing of drawings) {
      const path = join(dryRun, drawing.path);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, drawing.svg);
    }
  } else {
    try {
      publishDrawings(`https://github.com/${repo}.git`, branch, drawings, `Drawings for pull request #${pr.number}`, token);
    } catch {
      console.log("::warning::resin diff: could not publish drawings; grant contents: write or check the drawings branch. The comparison keeps the list and playground links");
      urls = new Map();
    }
  }
  const body = commentBody(results, urls);
  if (dryRun) {
    mkdirSync(dryRun, { recursive: true });
    writeFileSync(join(dryRun, "comment.md"), body);
    console.log(`resin diff: wrote the comment and ${drawings.length} drawings to ${dryRun}`);
    return;
  }
  // Fork tokens can lack both permissions. The job summary still provides the complete comparison.
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, body + "\n");
  try {
    const result = await updateComment(api, repo, pr.number, body, files.length > 0);
    console.log(`resin diff: ${result} the comparison comment on pull request #${pr.number}`);
  } catch (error) {
    console.log(`::warning::resin diff: ${(error as Error).message}. Read the comparison in the job summary`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await main();
  } catch (error) {
    console.error(`::error::resin diff: ${(error as Error).message.split("\n")[0]}`);
    process.exitCode = 1;
  }
}
