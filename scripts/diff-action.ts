// Run by action.yml on a pull request: compare every resin file the pull request changes with its
// version on the base branch, and keep one comment on the pull request that lists the changes, shows
// them drawn, and links to both versions in the playground.
//
// The drawings have to live somewhere a comment can show them from, so they are committed to a
// branch of their own (`resin-diff` by default) under pr-<number>/<head commit>/. Without write
// access (a pull request from a fork) the comment keeps the list and the link and leaves the
// drawings out. RESIN_DRY_RUN=<dir> writes the comment and the drawings to <dir> instead of GitHub.

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import ELK from "elkjs";
import { encode } from "../playground/share.ts";
import { type SvgLook, compile, diff, diffMarkdown, toSvg } from "../src/index.ts";

const MARKER = "<!-- resin-diff -->";
const env = process.env;
const input = (name: string, fallback: string): string => env[`INPUT_${name.toUpperCase()}`] || fallback;

const event = JSON.parse(readFileSync(env.GITHUB_EVENT_PATH ?? "", "utf8"));
const pr = event.pull_request;
if (!pr) {
  console.log("resin diff: not a pull request event, nothing to compare");
  process.exit(0);
}
const repo = env.GITHUB_REPOSITORY ?? "";
const token = input("token", "");
const branch = input("branch", "resin-diff");
const playground = input("playground", "https://jhzlo.github.io/resin/playground/");
const look = input("look", "graphite") as SvgLook;
const pathspecs = input("files", "*.erd").split(/\s+/).filter(Boolean);
const dryRun = env.RESIN_DRY_RUN;

const git = (...args: string[]): string => execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
/** A file at a commit, or "" when it does not exist there (added or deleted by the pull request) */
const show = (commit: string, path: string): string => {
  try {
    return git("show", `${commit}:${path}`);
  } catch {
    return "";
  }
};

const base: string = pr.base.sha;
const head: string = pr.head.sha;
if (!dryRun) for (const commit of [base, head]) git("fetch", "--no-tags", "--depth=1", "origin", commit);
const files = git("diff", "--name-only", base, head, "--", ...pathspecs).split("\n").filter(Boolean);
if (files.length === 0) {
  console.log("resin diff: the pull request changes no resin file");
  process.exit(0);
}

interface Result {
  file: string;
  markdown: string;
  svg: string | null;
  link: string;
}
const elk = new ELK();
const results: Result[] = [];
for (const file of files) {
  const before = show(base, file);
  const after = show(head, file);
  const a = compile(before);
  const b = compile(after);
  const link = playground + (await encode({ code: after, base: before, columns: "all", audit: "collapse", edges: "angular", related: null }));
  if (!a.model || !b.model) {
    const which = !b.model ? "the head version" : "the base version";
    results.push({ file, markdown: `Not compared: ${which} has errors. Run \`resin ${file}\` to see them.\n`, svg: null, link });
    continue;
  }
  const changed = diff(a.model, b.model);
  const svg = changed.changes.length ? (await toSvg(changed.model, elk, { look, standalone: true })).svg + "\n" : null;
  results.push({ file, markdown: diffMarkdown(changed.changes), svg, link });
}

/** Commit the drawings to the drawings branch; returns the address of each, or null without write access */
function publish(): Map<string, string> | null {
  const drawings = results.filter((r) => r.svg);
  if (!drawings.length) return new Map();
  const dir = `pr-${pr.number}/${head.slice(0, 7)}`;
  const urls = new Map(drawings.map((r) => [r.file, `https://github.com/${repo}/raw/${branch}/${dir}/${encodeURI(r.file)}.svg`]));
  if (dryRun) {
    for (const r of drawings) {
      const path = join(dryRun, dir, `${r.file}.svg`);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, r.svg!);
    }
    return urls;
  }
  try {
    const work = mkdtempSync(join(tmpdir(), "resin-diff-"));
    const remote = `https://x-access-token:${token}@github.com/${repo}.git`;
    const at = (...args: string[]) => execFileSync("git", args, { cwd: work, stdio: "pipe" });
    at("init", "-q");
    at("remote", "add", "origin", remote);
    try {
      at("fetch", "-q", "--depth=1", "origin", branch);
      at("checkout", "-q", "-b", branch, "FETCH_HEAD");
    } catch {
      at("checkout", "-q", "--orphan", branch);
    }
    for (const r of drawings) {
      const path = join(work, dir, `${r.file}.svg`);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, r.svg!);
    }
    at("add", "-A");
    at("-c", "user.name=github-actions[bot]", "-c", "user.email=41898282+github-actions[bot]@users.noreply.github.com", "commit", "-q", "-m", `Drawings for pull request #${pr.number}`);
    at("push", "-q", "origin", branch);
    return urls;
  } catch (e) {
    console.log(`::warning::resin diff: could not commit the drawings to ${branch} (${(e as Error).message.split("\n")[0]}); the comment leaves them out`);
    return null;
  }
}

const urls = publish();
const sections = results.map((r) => {
  const parts = [`### \`${r.file}\``, "", r.markdown.trim()];
  const url = urls?.get(r.file);
  if (url) parts.push("", `![Schema changes in ${r.file}](${url})`);
  parts.push("", `[Open both versions in the playground](${r.link})`);
  return parts.join("\n");
});
const body = [MARKER, "## Schema changes", "", ...sections.flatMap((s) => [s, ""]), "<sub>Drawn by resin from the base and head versions of each file.</sub>", ""].join("\n");

if (dryRun) {
  mkdirSync(dryRun, { recursive: true });
  writeFileSync(join(dryRun, "comment.md"), body);
  console.log(`resin diff: wrote the comment and ${results.filter((r) => r.svg).length} drawings to ${dryRun}`);
  process.exit(0);
}

// One comment per pull request: find the one with the marker and rewrite it, or start it
const api = async (path: string, init: RequestInit = {}): Promise<Response> =>
  fetch(`https://api.github.com/repos/${repo}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "content-type": "application/json" },
  });
const comments = (await (await api(`/issues/${pr.number}/comments?per_page=100`)).json()) as { id: number; body?: string }[];
const mine = Array.isArray(comments) ? comments.find((c) => c.body?.startsWith(MARKER)) : undefined;
const sent = mine
  ? await api(`/issues/comments/${mine.id}`, { method: "PATCH", body: JSON.stringify({ body }) })
  : await api(`/issues/${pr.number}/comments`, { method: "POST", body: JSON.stringify({ body }) });
if (!sent.ok) console.log(`::warning::resin diff: could not write the comment (${sent.status} ${sent.statusText})`);
else console.log(`resin diff: ${mine ? "updated" : "wrote"} the comment on pull request #${pr.number}`);
