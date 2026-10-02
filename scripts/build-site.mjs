// Builds the whole site into site/, for GitHub Pages:
//   site/index.html            the landing page
//   site/docs/...              the docs, one page per file in docs/guide/, with every example drawn by resin
//   site/playground/index.html the playground, one self-contained page
//   site/assets/               the landing's and the docs' shared style and script
// An example that does not compile, or compiles with a warning, fails the build: the docs show only
// what resin really accepts.
import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import ELK from "elkjs";
import { build } from "esbuild";
import { Marked } from "marked";
import { encode } from "../playground/share.ts";
import { compile, formatDiagnostic, toSvg } from "../src/index.ts";
import { highlightResin } from "../website/highlight.ts";

const SITE = "https://jhzlo.github.io/resin/";
const REPO = "https://github.com/JHZLO/resin";
const elk = new ELK();

/** The docs' table of contents: groups of [file name in docs/guide, title] */
const NAV = [
  ["Getting started", [["introduction", "Introduction"], ["quick-start", "Quick start"], ["playground", "Playground"], ["sql", "Importing SQL"]]],
  [
    "Language",
    [
      ["tables", "Tables"],
      ["columns", "Columns and types"],
      ["nullability", "Nullability"],
      ["keys", "Keys"],
      ["references", "References"],
      ["indexes", "Indexes"],
      ["enums-and-encryption", "Enums and encryption"],
      ["constraints", "Table constraints"],
      ["external-tables", "External tables"],
      ["audit", "Audit tables"],
      ["names", "Names and comments"],
    ],
  ],
  ["Outputs", [["svg", "SVG"], ["cli", "Command line"], ["library", "Library"]]],
  ["Reference", [["grammar", "Grammar"], ["diagnostics", "Diagnostics"], ["migrating", "Migrating from v0.1"]]],
];
const PAGES = NAV.flatMap(([group, pages]) => pages.map(([slug, title]) => ({ group, slug, title })));
/** Where a page lives, from the site's root */
const pathOf = (slug) => (slug === "introduction" ? "docs/" : `docs/${slug}/`);

const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const slugify = (s) =>
  s
    .toLowerCase()
    .replace(/`/g, "")
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-");

// ---- icons and shared pieces ----

const ICON = {
  play: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2.5"/><path d="M9 4v16"/><path d="m13.5 10 2.5 2-2.5 2"/></svg>',
  book: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H20v15H6.5A2.5 2.5 0 0 0 4 20.5Z"/><path d="M4 20.5A2.5 2.5 0 0 0 6.5 23H20v-5"/><path d="M8 7h8M8 11h6"/></svg>',
  github:
    '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 2a10 10 0 0 0-3.16 19.49c.5.09.68-.22.68-.48v-1.7c-2.78.6-3.37-1.34-3.37-1.34-.46-1.16-1.11-1.47-1.11-1.47-.91-.62.07-.61.07-.61 1 .07 1.53 1.03 1.53 1.03.89 1.53 2.34 1.09 2.91.83.09-.65.35-1.09.63-1.34-2.22-.25-4.55-1.11-4.55-4.94 0-1.09.39-1.98 1.03-2.68-.1-.25-.45-1.27.1-2.65 0 0 .84-.27 2.75 1.02a9.6 9.6 0 0 1 5 0c1.91-1.29 2.75-1.02 2.75-1.02.55 1.38.2 2.4.1 2.65.64.7 1.03 1.59 1.03 2.68 0 3.84-2.34 4.68-4.57 4.93.36.31.68.92.68 1.85v2.74c0 .27.18.58.69.48A10 10 0 0 0 12 2Z"/></svg>',
  search: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="6.5"/><path d="m16 16 4.5 4.5"/></svg>',
  copy: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" aria-hidden="true"><rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/></svg>',
  menu: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M4 7h16M4 12h16M4 17h16"/></svg>',
  note: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7.5v.01"/></svg>',
  tip: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 18h6M10 21h4M12 3a6 6 0 0 0-3.5 10.9c.6.4 1 1.1 1 1.8V16h5v-.3c0-.7.4-1.4 1-1.8A6 6 0 0 0 12 3Z"/></svg>',
  warning: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3 2 20h20Z"/><path d="M12 10v4M12 17v.01"/></svg>',
};
const THEME_BUTTON = `<button type="button" class="nav-link icon" id="theme" data-mode="auto" aria-label="Theme: auto" title="Theme: auto">
<svg class="i i-auto" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><circle cx="12" cy="12" r="8.5"/><path d="M12 3.5v17a8.5 8.5 0 0 0 0-17Z" fill="currentColor" stroke="none"/></svg>
<svg class="i i-light" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2.5v2.5M12 19v2.5M2.5 12H5M19 12h2.5M5.3 5.3l1.8 1.8M16.9 16.9l1.8 1.8M5.3 18.7l1.8-1.8M16.9 7.1l1.8-1.8"/></svg>
<svg class="i i-dark" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" aria-hidden="true"><path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5Z"/></svg>
</button>`;
/** The logo: one SVG file, website/brand/mark.svg. Pages link it as their icon and inline it in the header */
const MARK_FILE = await readFile("website/brand/mark.svg", "utf8");
const MARK = MARK_FILE.replace(/<title>[^<]*<\/title>\s*/, "")
  .replace(/<!--[\s\S]*?-->\s*/g, "")
  .replace(/ width="64" height="64"/, "")
  .replace("<svg ", '<svg aria-hidden="true" focusable="false" ')
  .replace(/>\s+</g, "><")
  .trim();

function head(root, title, description) {
  return `<!doctype html>
<html lang="en" data-root="${root}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
<meta name="color-scheme" content="dark light">
<link rel="icon" type="image/svg+xml" href="${root}assets/mark.svg">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600&family=IBM+Plex+Sans+KR:wght@400;500;600;700&display=swap">
<link rel="stylesheet" href="${root}assets/site.css">
<script>try{var t=localStorage.getItem("resin.theme");if(t==="light"||t==="dark")document.documentElement.dataset.theme=t}catch(e){}</script>`;
}

function siteHead(root, current, docs) {
  const link = (href, label, icon, here) =>
    `<a class="nav-link" href="${href}"${here ? ' aria-current="page"' : ""}>${icon}<span class="label">${label}</span></a>`;
  return `<header class="site-head">
${docs ? `<button type="button" class="nav-link icon menu-btn" aria-label="Menu">${ICON.menu}</button>` : ""}
<a class="logo" href="${root}" aria-label="resin home">${MARK}<span>resin</span>${docs ? "<small>docs</small>" : ""}</a>
<nav class="nav-links">
${link(`${root}docs/`, "Docs", ICON.book, current === "docs")}
${link(`${root}playground/`, "Playground", ICON.play, false)}
${THEME_BUTTON}
<a class="nav-link icon" href="${REPO}" aria-label="GitHub" title="Source on GitHub">${ICON.github}</a>
</nav>
</header>`;
}

// ---- examples: drawn by resin, in both themes ----

let figures = 0;
async function drawExample(code, where) {
  const result = compile(code);
  if (result.diagnostics.length) {
    const report = result.diagnostics.map((d) => formatDiagnostic(d, code, where)).join("\n\n");
    throw new Error(`an example in ${where} does not compile cleanly:\n\n${report}`);
  }
  const hash = createHash("sha1").update(code).digest("hex").slice(0, 10);
  for (const look of ["aurora-dark", "aurora-light"]) {
    const { svg } = await toSvg(result.model, elk, { look, standalone: true });
    await writeFile(`site/docs/figures/${hash}.${look === "aurora-dark" ? "dark" : "light"}.svg`, svg + "\n");
    figures++;
  }
  const share = await encode({ code, columns: "all", audit: "collapse", edges: "angular" });
  return { hash, share };
}

/** `erd example file=orders.erd "A caption"`: the file name and the caption, both optional */
function parseInfo(info) {
  const file = /\bfile=(\S+)/.exec(info)?.[1] ?? "schema.erd";
  const caption = /"([^"]*)"/.exec(info)?.[1] ?? "";
  return { file, caption };
}

// ---- one docs page ----

async function renderPage(page, index) {
  const source = await readFile(`docs/guide/${page.slug}.md`, "utf8");
  const where = `docs/guide/${page.slug}.md`;
  const root = page.slug === "introduction" ? "../" : "../../";
  const examples = {};
  const marked = new Marked({ gfm: true });
  const tokens = marked.lexer(source);

  // Draw every example first (drawing is asynchronous, rendering is not)
  let n = 0;
  const walk = async (list) => {
    for (const t of list) {
      if (t.type === "code" && /^erd\b/.test(t.lang ?? "")) {
        const info = t.lang;
        if (/\bexample\b/.test(info)) {
          const drawn = await drawExample(t.text, where);
          const id = `ex-${++n}`;
          const { file, caption } = parseInfo(info);
          examples[id] = {
            file,
            code: t.text,
            html: highlightResin(t.text),
            dark: `${root}docs/figures/${drawn.hash}.dark.svg`,
            light: `${root}docs/figures/${drawn.hash}.light.svg`,
            href: `${root}playground/${drawn.share}`,
            caption,
          };
          t.example = id;
        } else if (!/\binvalid\b/.test(info)) {
          // A plain snippet may show a warning, but not an error, unless it is marked `invalid`
          const errors = compile(t.text).diagnostics.filter((d) => d.severity === "error");
          if (errors.length) throw new Error(`a snippet in ${where} does not compile (mark it \`erd invalid\` if it should not):\n\n${errors.map((d) => formatDiagnostic(d, t.text, where)).join("\n\n")}`);
        }
      }
      if (t.tokens) await walk(t.tokens);
      if (t.items) await walk(t.items);
    }
  };
  await walk(tokens);

  marked.use({
    renderer: {
      code(token) {
        const info = token.lang ?? "";
        if (token.example) {
          const ex = examples[token.example];
          const alt = esc(ex.caption || `The diagram resin draws for ${ex.file}`);
          return `<div class="block glass ex"><div class="block-bar"><span>${esc(ex.file)}</span><span class="sp"></span><button type="button" class="mini-btn" data-copy="${token.example}">${ICON.copy}<span>Copy</span></button><a class="mini-btn" href="${ex.href}">${ICON.play}Open in playground</a></div><pre class="code">${ex.html}</pre><div class="block-fig"><img class="fig on-dark" src="${ex.dark}" alt="${alt}" loading="lazy"><img class="fig on-light" src="${ex.light}" alt="${alt}" loading="lazy"></div></div>\n`;
        }
        if (/^erd\b/.test(info)) return `<div class="block glass"><pre class="code">${highlightResin(token.text)}</pre></div>\n`;
        return `<div class="block glass"><pre class="code">${esc(token.text)}</pre></div>\n`;
      },
      heading(token) {
        const text = this.parser.parseInline(token.tokens);
        if (token.depth === 1) return "";
        const id = slugify(token.text);
        return `<h${token.depth} id="${id}">${text}<a class="anchor" href="#${id}" aria-hidden="true" tabindex="-1">#</a></h${token.depth}>\n`;
      },
      blockquote(token) {
        const body = this.parser.parse(token.tokens);
        const m = /^<p>\[!(NOTE|TIP|WARNING)\]\s*/.exec(body);
        if (!m) return `<blockquote>${body}</blockquote>\n`;
        const kind = m[1].toLowerCase();
        const label = { note: "Note", tip: "Tip", warning: "Watch out" }[kind];
        return `<div class="callout ${kind}">${ICON[kind]}<div><b>${label}</b>${body.replace(m[0], "<p>")}</div></div>\n`;
      },
      link(token) {
        let href = token.href;
        const text = this.parser.parseInline(token.tokens);
        if (href.startsWith(SITE)) href = root + href.slice(SITE.length);
        const md = /^([a-z0-9-]+)\.md(#.*)?$/.exec(href);
        if (md) {
          if (!PAGES.some((p) => p.slug === md[1])) throw new Error(`${where}: link to a page that does not exist: ${href}`);
          href = root + pathOf(md[1]) + (md[2] ?? "");
        }
        const external = /^https?:/.test(href);
        return `<a href="${esc(href)}"${external ? ' target="_blank" rel="noopener"' : ""}>${text}</a>`;
      },
    },
  });

  // The title, the lead, then one section per h2: the example beside the text follows these sections
  const h1 = tokens.find((t) => t.type === "heading" && t.depth === 1);
  if (!h1 || h1.text !== page.title) throw new Error(`${where}: the page must start with "# ${page.title}"`);
  const rest = tokens.slice(tokens.indexOf(h1) + 1);
  const leadAt = rest.findIndex((t) => t.type !== "space");
  const lead = rest[leadAt]?.type === "paragraph" ? rest.splice(leadAt, 1)[0] : null;
  const chunks = [{ heading: null, tokens: [] }];
  for (const t of rest) {
    if (t.type === "heading" && t.depth === 2) chunks.push({ heading: t, tokens: [t] });
    else chunks.at(-1).tokens.push(t);
  }
  const firstExample = Object.keys(examples)[0] ?? null;
  let current = firstExample;
  const exampleIn = (list) => {
    for (const t of list) {
      if (t.example) return t.example;
      const inner = t.tokens ? exampleIn(t.tokens) : null;
      if (inner) return inner;
    }
    return null;
  };
  const sections = chunks
    .filter((c) => c.tokens.some((t) => t.type !== "space"))
    .map((c) => {
      current = exampleIn(c.tokens) ?? current;
      const id = c.heading ? slugify(c.heading.text) : "overview";
      const list = Object.assign(c.tokens, { links: tokens.links });
      const html = marked.parser(list).replace(/<table>/g, '<div class="table-wrap"><table>').replace(/<\/table>/g, "</table></div>");
      return `<section id="${id}"${current ? ` data-example="${current}"` : ""}>\n${html}</section>`;
    });

  const at = PAGES.indexOf(page);
  const prev = PAGES[at - 1];
  const next = PAGES[at + 1];
  const pager = `<nav class="pager" aria-label="Pages">${prev ? `<a class="glass" href="${root}${pathOf(prev.slug)}"><small>Previous</small><b>${esc(prev.title)}</b></a>` : ""}${next ? `<a class="glass next" href="${root}${pathOf(next.slug)}"><small>Next</small><b>${esc(next.title)}</b></a>` : ""}</nav>`;

  const side = NAV.map(
    ([group, pages]) =>
      `<div class="side-group"><h4>${group}</h4>${pages.map(([slug, title]) => `<a class="side-link" href="${root}${pathOf(slug)}"${slug === page.slug ? ' aria-current="page"' : ""}>${esc(title)}</a>`).join("")}</div>`,
  ).join("");

  const first = firstExample ? examples[firstExample] : null;
  const panel = first
    ? `<aside class="example glass" aria-label="Example" data-id="${firstExample}">
<div class="block-bar"><span class="ex-file">${esc(first.file)}</span><span class="sp"></span>
<button type="button" class="mini-btn ex-copy" data-copy="${firstExample}" aria-label="Copy">${ICON.copy}<span>Copy</span></button><a class="mini-btn ex-open" href="${first.href}">${ICON.play}Open</a></div>
<div class="example-body"><pre class="code ex-code">${first.html}</pre><div class="block-fig ex-diagram"><img class="fig on-dark" src="${first.dark}" alt="The diagram resin draws for this example"><img class="fig on-light" src="${first.light}" alt="The diagram resin draws for this example"></div><p class="example-cap">${esc(first.caption)}</p></div>
</aside>`
    : "";

  const leadHtml = lead ? marked.parser(Object.assign([lead], { links: tokens.links })).replace(/^<p>/, '<p class="page-lead">') : "";
  const description = lead ? lead.text.replace(/[`*_[\]]/g, "").replace(/\([^)]*\)/g, "").slice(0, 160) : page.title;
  const html = `${head(root, `${page.title} - resin docs`, description)}
</head>
<body>
<div id="stage"><div id="stage-content"></div></div>
<div class="page docs">
${siteHead(root, "docs", true)}
<div class="docs-grid">
<nav class="docs-side" aria-label="Docs">
<div class="search" role="search">${ICON.search}<input type="search" placeholder="Search the docs" aria-label="Search the docs" autocomplete="off"><kbd>/</kbd></div>
<ul class="search-results glass" hidden></ul>
${side}
</nav>
<main class="docs-main${first ? "" : " no-examples"}">
<article class="article">
<p class="crumbs"><span>${esc(page.group)}</span><span>${esc(page.title)}</span></p>
<h1>${esc(page.title)}</h1>
${leadHtml}
${sections.join("\n")}
${pager}
<div class="page-meta"><a href="${REPO}/edit/main/docs/guide/${page.slug}.md" target="_blank" rel="noopener">Edit this page on GitHub</a><span>Grammar v0.2</span></div>
</article>
${panel}
</main>
</div>
</div>
<script type="application/json" id="examples">${JSON.stringify(examples).replace(/</g, "\\u003c")}</script>
<script src="${root}assets/site.js" defer></script>
</body>
</html>
`;
  await mkdir(`site/${pathOf(page.slug)}`, { recursive: true });
  await writeFile(`site/${pathOf(page.slug)}index.html`, html);

  index.push({ title: page.title, heading: null, url: pathOf(page.slug) });
  for (const c of chunks) if (c.heading) index.push({ title: page.title, heading: c.heading.text.replace(/`/g, ""), url: `${pathOf(page.slug)}#${slugify(c.heading.text)}` });
}

// ---- the landing page ----

async function renderLanding() {
  const code = await readFile("examples/order.erd", "utf8");
  const drawn = await drawExample(code, "examples/order.erd");
  const shown = code.split("\n").slice(1, 16).join("\n");
  const lead =
    "resin is a small language for entity-relationship diagrams. Nullability, keys, foreign and logical references, indexes and audit tables are syntax: resin checks them as you type and draws every reference from the column that holds it.";
  const html = `${head("", "resin: ERDs, written like DDL", lead)}
<script>if(location.hash.indexOf("#erd:")===0)location.replace("playground/"+location.hash)</script>
</head>
<body class="landing">
<div id="stage"><div id="stage-content"></div></div>
<div class="page landing">
${siteHead("", "home", false)}
<main>
<div class="hero">
<h1>ERDs, written like DDL</h1>
<p class="lead">${lead}</p>
<div class="cta">
<a class="btn-xl primary" href="playground/">${ICON.play}Open the playground</a>
<a class="btn-xl glass" href="docs/">${ICON.book}Read the docs</a>
</div>
<p class="cta-note">Runs in your browser. Nothing to install.</p>
</div>
<div class="showcase glass">
<div class="win-bar"><span class="win-tab on">orders.erd</span><span class="win-tab">Diagram</span></div>
<div class="win-body"><pre class="code">${highlightResin(shown)}</pre><div class="win-fig"><img class="fig on-dark" src="docs/figures/${drawn.hash}.dark.svg" alt="The orders example drawn by resin: orders, order items and payments, with an external users table"><img class="fig on-light" src="docs/figures/${drawn.hash}.light.svg" alt="The orders example drawn by resin: orders, order items and payments, with an external users table"></div></div>
</div>
</main>
<footer class="site-foot">MIT licensed. <a href="${REPO}">Source on GitHub</a>, <a href="docs/">docs</a>, <a href="playground/">playground</a>.</footer>
</div>
<script src="assets/site.js" defer></script>
</body>
</html>
`;
  await writeFile("site/index.html", html);
}

// ---- the playground: one self-contained page ----

async function renderPlayground() {
  const result = await build({
    entryPoints: ["playground/main.ts"],
    bundle: true,
    format: "iife",
    minify: true,
    target: "es2022",
    write: false,
    loader: { ".erd": "text" },
    legalComments: "none",
    banner: { js: "/*! resin playground | MIT | includes CodeMirror (MIT) and elkjs (EPL-2.0) */" },
  });
  const script = result.outputFiles[0].text.replace(/<\/script/gi, "<\\/script");
  const template = await readFile("playground/index.html", "utf8");
  if (!template.includes("<!--APP-->")) throw new Error("playground/index.html has no <!--APP--> placeholder");
  // The playground stays one self-contained page: its icon is the mark as a data URL
  const html = template
    .replace("<!--APP-->", () => `<script>${script}</script>`)
    .replace("%FAVICON%", "data:image/svg+xml," + encodeURIComponent(MARK_FILE))
    .replace("%MARK%", () => MARK);
  await mkdir("site/playground", { recursive: true });
  await writeFile("site/playground/index.html", html);
  return html.length;
}

// ---- assets ----

async function renderAssets() {
  const result = await build({
    entryPoints: ["website/site.ts"],
    bundle: true,
    format: "iife",
    minify: true,
    target: "es2022",
    write: false,
    legalComments: "none",
  });
  await writeFile("site/assets/site.js", result.outputFiles[0].text);
  await writeFile("site/assets/site.css", await readFile("website/site.css", "utf8"));
  await writeFile("site/assets/mark.svg", MARK_FILE);
}

await rm("site/docs", { recursive: true, force: true });
await rm("site/assets", { recursive: true, force: true });
await mkdir("site/docs/figures", { recursive: true });
await mkdir("site/assets", { recursive: true });
const index = [];
for (const page of PAGES) await renderPage(page, index);
await writeFile("site/docs/search.json", JSON.stringify(index));
await renderLanding();
await renderAssets();
const playground = await renderPlayground();
console.log(`site/  landing, ${PAGES.length} docs pages, ${figures} figures, playground ${(playground / 1024).toFixed(0)} KB`);
