// The site's behavior, shared by the landing page and the docs: the live aurora behind the page, the
// theme (the same choice as the playground's), the header that turns to glass on scroll, and in the
// docs the example that follows the reading, search, and the menu on small screens.

import { LiveGlass } from "../playground/glass.ts";
import { showStars } from "../playground/stars.ts";
import { glassOf, stageOf } from "../src/svg.ts";

const $ = <T extends Element = HTMLElement>(s: string, root: ParentNode = document): T | null => root.querySelector<T>(s);
const $$ = <T extends Element = HTMLElement>(s: string, root: ParentNode = document): T[] => [...root.querySelectorAll<T>(s)];
/** The path from this page to the site's root, set by the build: "", "../" or "../../" */
const ROOT = document.documentElement.dataset.root ?? "";

// ---- theme: auto, light, dark, stored where the playground stores it ----

const THEME_STORE = "resin.theme";
const THEMES = ["auto", "light", "dark"] as const;
type Theme = (typeof THEMES)[number];
let theme: Theme = "auto";
try {
  const saved = localStorage.getItem(THEME_STORE);
  if (saved === "light" || saved === "dark") theme = saved;
} catch {
  /* keep auto */
}
const systemDark = matchMedia("(prefers-color-scheme: dark)");
const isDark = () => (theme === "auto" ? systemDark.matches : theme === "dark");

function applyTheme(): void {
  if (theme === "auto") delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = theme;
  const button = $("#theme");
  if (button) {
    button.dataset.mode = theme;
    button.setAttribute("aria-label", `Theme: ${theme}`);
    button.title = `Theme: ${theme}`;
  }
  paintStage();
}

$("#theme")?.addEventListener("click", () => {
  theme = THEMES[(THEMES.indexOf(theme) + 1) % THEMES.length];
  try {
    if (theme === "auto") localStorage.removeItem(THEME_STORE);
    else localStorage.setItem(THEME_STORE, theme);
  } catch {
    /* the choice lasts for this visit */
  }
  applyTheme();
});
systemDark.addEventListener("change", () => {
  if (theme === "auto") paintStage();
});

// ---- the aurora: the playground's own WebGL stage, with no cards on it ----

const stage = $("#stage")!;
let glass: LiveGlass | null = null;
if (LiveGlass.available()) {
  try {
    glass = new LiveGlass(stage, $("#stage-content")!);
    glass.setBoxes([], null);
    glass.setGrid(false);
    glass.setView(1, 0, 0);
  } catch {
    glass = null;
  }
}
if (!glass) stage.classList.add("still");

function paintStage(): void {
  const look = isDark() ? "aurora-dark" : "aurora-light";
  glass?.setLook(stageOf(look), glassOf(look));
}

// The stage sits behind the page, so it never sees the pointer: hand it over
document.addEventListener("pointermove", (e) => stage.dispatchEvent(new PointerEvent("pointermove", { clientX: e.clientX, clientY: e.clientY })), {
  passive: true,
});
document.documentElement.addEventListener("pointerleave", () => stage.dispatchEvent(new PointerEvent("pointerleave")));
// On the landing page, a tap on the open sky sends a ripple through it, as on the playground canvas
if (document.body.classList.contains("landing"))
  document.addEventListener("pointerdown", (e) => {
    if ((e.target as Element).closest("a, button, input, .glass, .site-head")) return;
    glass?.ripple(e.clientX, e.clientY);
  });

// ---- the header: clear over the aurora at the top, glass once the page scrolls ----

const head = $(".site-head");
const onScroll = () => head?.classList.toggle("is-scrolled", scrollY > 8);
addEventListener("scroll", onScroll, { passive: true });
onScroll();

applyTheme();
void showStars();

// ---- docs ----

interface Example {
  file: string;
  code: string;
  html: string;
  dark: string;
  light: string;
  href: string;
  caption: string;
}
const data = $("#examples");
const EXAMPLES = (data ? JSON.parse(data.textContent ?? "{}") : {}) as Record<string, Example>;

async function copy(text: string, button: HTMLElement): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    const label = $("span", button);
    if (label) {
      label.textContent = "Copied";
      setTimeout(() => (label.textContent = "Copy"), 1400);
    }
  } catch {
    /* the clipboard is blocked here */
  }
}

document.addEventListener("click", (e) => {
  const button = (e.target as Element).closest<HTMLElement>("[data-copy]");
  if (button) void copy(EXAMPLES[button.dataset.copy!]?.code ?? "", button);
});

// The example beside the text follows the section being read, and fades from one to the next
const panel = $(".example");
if (panel) {
  const body = $(".example-body", panel)!;
  const show = (id: string) => {
    const ex = EXAMPLES[id];
    if (!ex || panel.dataset.id === id) return;
    const swap = () => {
      panel.dataset.id = id;
      $(".ex-file", panel)!.textContent = ex.file;
      $(".ex-code", panel)!.innerHTML = ex.html;
      $<HTMLImageElement>(".fig.on-dark", panel)!.src = ex.dark;
      $<HTMLImageElement>(".fig.on-light", panel)!.src = ex.light;
      $<HTMLAnchorElement>(".ex-open", panel)!.href = ex.href;
      $(".ex-copy", panel)!.dataset.copy = id;
      $(".example-cap", panel)!.textContent = ex.caption;
      body.classList.remove("is-swapping");
    };
    if (!panel.dataset.id || matchMedia("(prefers-reduced-motion: reduce)").matches) return swap();
    body.classList.add("is-swapping");
    setTimeout(swap, 150);
  };

  // The section being read is the last one whose top has passed a reading line a third of the way
  // down. Near the end of the page the line slides down, so short last sections still get their turn
  const sections = $$<HTMLElement>(".article section[data-example]");
  const pick = () => {
    const end = document.documentElement.scrollHeight - innerHeight;
    const near = Math.min(1, Math.max(0, (scrollY - (end - innerHeight * 0.6)) / (innerHeight * 0.6)));
    const line = innerHeight * (0.33 + 0.57 * near);
    let current = sections[0];
    for (const s of sections) if (s.getBoundingClientRect().top <= line) current = s;
    if (current) show(current.dataset.example!);
  };
  // A handful of measurements per scroll event: cheap enough to run on each one
  addEventListener("scroll", pick, { passive: true });
  addEventListener("resize", pick, { passive: true });
  pick();
}

// Search: page titles and section headings, loaded the first time the box is used
interface Entry {
  title: string;
  heading: string | null;
  url: string;
}
const input = $<HTMLInputElement>(".search input");
const results = $(".search-results");
if (input && results) {
  let index: Entry[] | null = null;
  let hits: Entry[] = [];
  let at = 0;
  const load = async () => {
    if (index) return;
    try {
      index = (await (await fetch(`${ROOT}docs/search.json`)).json()) as Entry[];
    } catch {
      index = [];
    }
  };
  const draw = () => {
    const q = input.value.trim().toLowerCase();
    results.hidden = q.length === 0;
    if (!q) return;
    const words = q.split(/\s+/);
    hits = (index ?? []).filter((e) => words.every((w) => `${e.title} ${e.heading ?? ""}`.toLowerCase().includes(w))).slice(0, 8);
    at = Math.min(at, Math.max(0, hits.length - 1));
    results.replaceChildren(
      ...(hits.length
        ? hits.map((e, i) => {
            const li = document.createElement("li");
            const a = document.createElement("a");
            a.href = ROOT + e.url;
            a.textContent = e.heading ?? e.title;
            if (e.heading) {
              const small = document.createElement("small");
              small.textContent = e.title;
              a.append(small);
            }
            a.classList.toggle("on", i === at);
            li.append(a);
            return li;
          })
        : [Object.assign(document.createElement("li"), { className: "none", textContent: "No matches" })]),
    );
  };
  input.addEventListener("focus", () => void load().then(draw));
  input.addEventListener("input", () => {
    at = 0;
    void load().then(draw);
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      at = (at + (e.key === "ArrowDown" ? 1 : hits.length - 1)) % Math.max(1, hits.length);
      draw();
    } else if (e.key === "Enter" && hits[at]) {
      location.href = ROOT + hits[at].url;
    } else if (e.key === "Escape") {
      input.value = "";
      draw();
      input.blur();
    }
  });
  // Cmd or Ctrl + K, or "/", from anywhere on the page
  document.addEventListener("keydown", (e) => {
    const typing = (e.target as Element).closest("input, textarea");
    if ((e.key === "k" && (e.metaKey || e.ctrlKey)) || (e.key === "/" && !typing)) {
      e.preventDefault();
      document.querySelector(".docs")?.classList.add("menu-open");
      input.focus();
    }
  });
}

// The menu on small screens: the sidebar slides over the page
const docs = $(".docs");
$(".menu-btn")?.addEventListener("click", () => docs?.classList.toggle("menu-open"));
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") docs?.classList.remove("menu-open");
});
document.addEventListener("click", (e) => {
  const t = e.target as Element;
  if (docs?.classList.contains("menu-open") && !t.closest(".docs-side, .menu-btn")) docs.classList.remove("menu-open");
});
