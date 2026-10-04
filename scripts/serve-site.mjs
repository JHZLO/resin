// A loopback-only server for the built site and browser regression tests.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";

const root = resolve("site");
const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".webp": "image/webp", ".mp4": "video/mp4" };
createServer(async (req, res) => {
  try {
    const path = decodeURIComponent(new URL(req.url, "http://localhost").pathname);
    const file = resolve(root, `.${path}${path.endsWith("/") ? "index.html" : ""}`);
    if (!file.startsWith(root + sep)) throw new Error("outside site");
    res.setHeader("Content-Type", types[extname(file)] ?? "application/octet-stream");
    res.end(await readFile(file));
  } catch {
    res.writeHead(404).end("Not found");
  }
}).listen(Number(process.env.RESIN_TEST_PORT ?? 4173), "127.0.0.1");
