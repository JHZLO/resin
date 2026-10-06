// A loopback-only server for the built site and browser regression tests.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";

const root = resolve("site");
const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".webp": "image/webp", ".jpg": "image/jpeg", ".mp4": "video/mp4" };
createServer(async (req, res) => {
  try {
    const path = decodeURIComponent(new URL(req.url, "http://localhost").pathname);
    const file = resolve(root, `.${path}${path.endsWith("/") ? "index.html" : ""}`);
    if (!file.startsWith(root + sep)) throw new Error("outside site");
    res.setHeader("Content-Type", types[extname(file)] ?? "application/octet-stream");
    const body = await readFile(file);
    // Match the deployed host's byte ranges so browser tests can seek in videos.
    res.setHeader("Accept-Ranges", "bytes");
    if (req.headers.range) {
      const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
      const start = range?.[1] ? Number(range[1]) : Math.max(0, body.length - Number(range?.[2]));
      const end = range?.[1] && range[2] ? Math.min(Number(range[2]), body.length - 1) : body.length - 1;
      if (!range || (!range[1] && !range[2]) || !Number.isSafeInteger(start) || start > end || start >= body.length) {
        res.writeHead(416, { "Content-Range": `bytes */${body.length}` }).end();
        return;
      }
      res.writeHead(206, { "Content-Range": `bytes ${start}-${end}/${body.length}`, "Content-Length": end - start + 1 });
      res.end(req.method === "HEAD" ? undefined : body.subarray(start, end + 1));
      return;
    }
    res.setHeader("Content-Length", body.length);
    res.end(req.method === "HEAD" ? undefined : body);
  } catch {
    res.writeHead(404).end("Not found");
  }
}).listen(Number(process.env.RESIN_TEST_PORT ?? 4173), "127.0.0.1");
