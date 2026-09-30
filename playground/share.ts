// Shareable links: the playground state, deflated and base64url-encoded into the URL hash,
// in the spirit of mermaid.live's `#pako:` links. Uses the browser's built-in compression streams.

const PREFIX = "#erd:";

export interface SharedState {
  code: string;
  columns: "all" | "keys";
  audit: "collapse" | "expand";
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
    const value = JSON.parse(await new Response(stream).text()) as Partial<SharedState>;
    if (typeof value.code !== "string") return null;
    return {
      code: value.code,
      columns: value.columns === "keys" ? "keys" : "all",
      audit: value.audit === "expand" ? "expand" : "collapse",
    };
  } catch {
    return null;
  }
}
