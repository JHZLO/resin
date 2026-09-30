// Bundles the playground into one self-contained page: site/index.html.
// The page inlines its script (resin, CodeMirror and elkjs), so it can be served from anywhere.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { build } from "esbuild";

const result = await build({
  entryPoints: ["playground/main.ts"],
  bundle: true,
  format: "iife",
  minify: true,
  target: "es2022",
  write: false,
  loader: { ".erd": "text" },
  legalComments: "none",
  banner: {
    js: "/*! resin playground | MIT | includes CodeMirror (MIT) and elkjs (EPL-2.0) */",
  },
});

const script = result.outputFiles[0].text.replace(/<\/script/gi, "<\\/script");
const template = await readFile("playground/index.html", "utf8");
if (!template.includes("<!--APP-->")) throw new Error("playground/index.html has no <!--APP--> placeholder");
const html = template.replace("<!--APP-->", () => `<script>${script}</script>`);

await mkdir("site", { recursive: true });
await writeFile("site/index.html", html);
console.log(`site/index.html  ${(html.length / 1024).toFixed(0)} KB`);
