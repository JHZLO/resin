// Shareable links: the playground state, deflated and base64url-encoded into the URL hash,
// so a link carries the whole document. Uses the browser's built-in compression streams.

const PREFIX = "#erd:";

export interface SharedState {
  code: string;
  columns: "all" | "keys" | "none";
  audit: "collapse" | "expand";
  edges: "angular" | "curved";
  /** Only this table and the tables within `steps` references of it, or null for every table */
  related: { table: string; steps: 1 | 2 } | null;
  /** An older version of the document: the diagram then marks what changed since it. Optional, so
   *  links made before it existed still open */
  base?: string | null;
}

/** Links and local storage are untrusted input. Keep only fields the editor understands. */
export function readState(value: unknown): SharedState | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  if (typeof input.code !== "string") return null;
  const related = input.related as Partial<NonNullable<SharedState["related"]>> | null;
  return {
    code: input.code,
    columns: input.columns === "keys" || input.columns === "none" ? input.columns : "all",
    audit: input.audit === "expand" ? "expand" : "collapse",
    edges: input.edges === "curved" ? "curved" : "angular",
    related: related && typeof related.table === "string" ? { table: related.table, steps: related.steps === 2 ? 2 : 1 } : null,
    base: typeof input.base === "string" ? input.base : null,
  };
}

export async function encode(state: SharedState): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(state));
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream("deflate-raw"));
  const buf = new Uint8Array(await new Response(stream).arrayBuffer());
  let bin = "";
  for (const b of buf) bin += String.fromCharCode(b);
  return PREFIX + btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function decode(hash: string): Promise<SharedState | null> {
  if (!hash.startsWith(PREFIX)) return null;
  try {
    const b64 = hash.slice(PREFIX.length).replace(/-/g, "+").replace(/_/g, "/");
    const bin = atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
    return readState(JSON.parse(await new Response(stream).text()));
  } catch {
    return null;
  }
}
